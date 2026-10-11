// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The goal layer's pure vocabulary — types, the lifecycle transition table and
 * the deterministic plan-content hash. NO SQL, no I/O: `store.ts` persists these
 * shapes, the challenger judges them and the architect produces them.
 *
 * ── Why the plan hash exists ─────────────────────────────────────────────────
 * An approval approves a SPECIFIC plan revision, not "the plan". If a revision's
 * acceptance criteria are edited after approval, the approval must stop counting
 * — otherwise a goal runs work nobody agreed to. The binding is the content
 * hash: `hashPlanContent` is deterministic over canonical JSON (object keys
 * sorted, arrays in order), so re-serialising the same plan — a round-trip
 * through SQLite, a field reordering — yields the SAME hash, while any material
 * edit (a changed criterion, a new task, a raised budget) yields a different one.
 * `store.isApproved` compares this hash against the revision being run.
 *
 * ── Why the transition table is here ─────────────────────────────────────────
 * The lifecycle is the safety property: a goal may not run before its plan is
 * approved, and a terminal goal may not be resurrected. Keeping the table in one
 * exported pure function means the store, the API and the tests all read the
 * same source of truth instead of re-deriving "which states are legal" per
 * caller.
 */

import { createHash } from "node:crypto";
import type { ChallengeReport } from "./challenger.ts";

/**
 * The goal lifecycle. `RUNNING` is the only state from which work is dispatched,
 * and it is reachable only through `APPROVED` — see `canTransition` + the store's
 * `setGoalState`, which additionally requires a matching approval to enter it.
 */
export type GoalState =
  | "DRAFT"
  | "UNDERSTANDING"
  | "CHALLENGING"
  | "REVISION_REQUIRED"
  | "CONDITIONAL"
  | "READY_FOR_PLAN"
  | "PLAN_PROPOSED"
  | "AWAITING_PLAN_APPROVAL"
  | "APPROVED"
  | "RUNNING"
  | "PAUSED_DOER_OFF"
  | "WAITING_USER"
  | "BLOCKED"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export const GOAL_STATES: readonly GoalState[] = [
  "DRAFT",
  "UNDERSTANDING",
  "CHALLENGING",
  "REVISION_REQUIRED",
  "CONDITIONAL",
  "READY_FOR_PLAN",
  "PLAN_PROPOSED",
  "AWAITING_PLAN_APPROVAL",
  "APPROVED",
  "RUNNING",
  "PAUSED_DOER_OFF",
  "WAITING_USER",
  "BLOCKED",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
];

/** States a goal can never leave: COMPLETED and FAILED are done, CANCELLED is withdrawn. */
export const TERMINAL_GOAL_STATES: readonly GoalState[] = ["COMPLETED", "FAILED", "CANCELLED"];

/** True when `value` names a goal state — used at the row/JSON boundary. */
export function isGoalState(value: unknown): value is GoalState {
  return typeof value === "string" && (GOAL_STATES as readonly string[]).includes(value);
}

/**
 * The legal state graph. Every edge is deliberate:
 *
 *   - DRAFT → UNDERSTANDING: entering the pipeline starts with restating the goal.
 *   - UNDERSTANDING → CHALLENGING: understanding feeds the challenge, it does not
 *     skip it — a goal is never read as "fine as stated".
 *   - CHALLENGING → READY_FOR_PLAN (PASS) | CONDITIONAL | REVISION_REQUIRED | BLOCKED.
 *   - REVISION_REQUIRED → CHALLENGING: a revision is re-challenged, never trusted
 *     on the strength of the edit alone. (BLOCKED is the escape when the user
 *     cannot answer.)
 *   - CONDITIONAL → READY_FOR_PLAN (conditions accepted) | REVISION_REQUIRED | BLOCKED.
 *   - READY_FOR_PLAN → PLAN_PROPOSED → AWAITING_PLAN_APPROVAL: planning then
 *     explicitly waiting — there is no edge that runs a plan straight from
 *     READY_FOR_PLAN.
 *   - AWAITING_PLAN_APPROVAL → APPROVED (a specific revision approved) |
 *     REVISION_REQUIRED (rejected: the plan is revised and re-presented) | BLOCKED.
 *   - APPROVED → RUNNING: the only door into execution.
 *   - RUNNING → COMPLETED | FAILED | BLOCKED | WAITING_USER | PAUSED_DOER_OFF | CANCELLED.
 *   - PAUSED_DOER_OFF → RUNNING (resume) | CANCELLED: pausing is reversible, losing
 *     the goal is not.
 *   - WAITING_USER → RUNNING (answered) | BLOCKED | CANCELLED.
 *   - BLOCKED → RUNNING (unblocked) | FAILED | CANCELLED: a block must be resolved
 *     by an explicit move, never silently timed out.
 *   - Every non-terminal state may be cancelled by the user.
 *
 * There are no self-loops: a "transition" to the state a goal is already in is
 * not a transition, so `canTransition(s, s)` is false everywhere (including
 * terminal states).
 */
const TRANSITIONS: Readonly<Record<GoalState, readonly GoalState[]>> = {
  DRAFT: ["UNDERSTANDING", "CANCELLED"],
  UNDERSTANDING: ["CHALLENGING", "BLOCKED", "CANCELLED"],
  CHALLENGING: ["READY_FOR_PLAN", "CONDITIONAL", "REVISION_REQUIRED", "BLOCKED", "CANCELLED"],
  REVISION_REQUIRED: ["CHALLENGING", "BLOCKED", "CANCELLED"],
  CONDITIONAL: ["READY_FOR_PLAN", "REVISION_REQUIRED", "BLOCKED", "CANCELLED"],
  READY_FOR_PLAN: ["PLAN_PROPOSED", "REVISION_REQUIRED", "BLOCKED", "CANCELLED"],
  PLAN_PROPOSED: ["AWAITING_PLAN_APPROVAL", "REVISION_REQUIRED", "BLOCKED", "CANCELLED"],
  AWAITING_PLAN_APPROVAL: ["APPROVED", "REVISION_REQUIRED", "BLOCKED", "CANCELLED"],
  APPROVED: ["RUNNING", "BLOCKED", "CANCELLED"],
  RUNNING: ["COMPLETED", "FAILED", "BLOCKED", "WAITING_USER", "PAUSED_DOER_OFF", "CANCELLED"],
  PAUSED_DOER_OFF: ["RUNNING", "CANCELLED"],
  WAITING_USER: ["RUNNING", "BLOCKED", "CANCELLED"],
  BLOCKED: ["RUNNING", "FAILED", "CANCELLED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

/** True when the lifecycle table allows a direct move from `from` to `to`. */
export function canTransition(from: GoalState, to: GoalState): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

/**
 * The shortest legal path from `from` to `to`, EXCLUDING `from`, or null when
 * `to` is unreachable. Callers use it to advance through the pipeline's
 * intermediates (a goal reaches `CHALLENGING` through `UNDERSTANDING`) without
 * hard-coding the graph a second time.
 */
export function routeTo(from: GoalState, to: GoalState): GoalState[] | null {
  if (from === to) return null;
  const queue: GoalState[] = [from];
  const seen = new Set<GoalState>([from]);
  const cameFrom = new Map<GoalState, GoalState>();
  while (queue.length > 0) {
    const current = queue.shift() as GoalState;
    for (const next of TRANSITIONS[current] ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      cameFrom.set(next, current);
      if (next === to) {
        const path: GoalState[] = [to];
        let step = to;
        while (step !== from) {
          step = cameFrom.get(step) as GoalState;
          if (step !== from) path.unshift(step);
        }
        return path;
      }
      queue.push(next);
    }
  }
  return null;
}

// ── Plan content — produced by the architect, persisted verbatim ──────────────

/** One unit of planned work. Depends only on tasks, never on a running worker. */
export interface GoalTaskDraft {
  id: string;
  title: string;
  objective: string;
  /** Ids of tasks in the same plan that must finish first (may be empty). */
  dependsOn: string[];
  /** Candidate worker role/capability, e.g. "coding". A candidate, not a dispatch. */
  role: string;
  acceptanceCriteria: string[];
  /** The intended verification method for the matching criterion, in order. */
  verification: string[];
}

/** Bounds on a plan's execution. Nullable-free: an unbounded plan is not a plan. */
export interface GoalBudgets {
  maxTasks: number;
  maxRetries: number;
  maxDepth: number;
}

/** The content a plan revision carries. `store.addRevision` hashes exactly this. */
export interface GoalPlanContent {
  summary: string;
  deliverables: string[];
  tasks: GoalTaskDraft[];
  acceptanceCriteria: string[];
  requiredEvidence: string[];
  constraints: string[];
  forbiddenOutcomes: string[];
  authorizedWorkspace: string[];
  assumptions: string[];
  uncertainties: string[];
  budgets: GoalBudgets;
}

/**
 * One immutable plan version. `contentHash` is derived from `content` by
 * `hashPlanContent`; it is stored alongside so an approval can name the exact
 * bytes it approved without recomputing (and so a mismatch is visible).
 */
export interface PlanRevision {
  id: string;
  goalId: string;
  /** 1-based, gapless per goal: the first revision is 1. */
  version: number;
  contentHash: string;
  content: GoalPlanContent;
  createdAt: string;
  createdBy: string;
  /** The revision this one replaces, when it is a revision of a revision. */
  supersedes?: string;
}

/** An approval (or rejection) of one plan revision by one authority. */
export interface PlanApproval {
  id: string;
  goalId: string;
  /** The revision this decision binds to. */
  revisionId: string;
  /** The revision's content hash at decision time. */
  contentHash: string;
  approvedBy: string;
  approvedAt: string;
  /** What the approver authorised, e.g. ["write:repo", "run:tests"]. */
  authorityScope: string[];
  /** The budgets in force when the approval was given. */
  budgets: GoalBudgets;
  status: "APPROVED" | "REJECTED";
  note?: string;
  /** Set when a later material revision invalidated this decision (audit trail). */
  invalidatedAt?: string;
  invalidatedReason?: string;
}

/** What the goal expects to happen next, and why — a durable "where was I". */
export interface GoalNextAction {
  action: string;
  reason: string;
  at: string;
}

/** A goal as persisted: identity + lifecycle + the links to missions/work. */
export interface Goal {
  id: string;
  /** The goal as the user stated it, updated as understanding improves it. */
  statement: string;
  state: GoalState;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  assumptions: string[];
  constraints: string[];
  uncertainties: string[];
  /**
   * The user's OWN success criteria, captured at intake. They are what the
   * challenge panel is judged against and what the plan must satisfy — without
   * them a goal is only prose, and a reviewer can say nothing useful about it.
   */
  acceptanceCriteria: string[];
  /** Why the goal is blocked, when it is. */
  blocker?: string;
  nextAction?: GoalNextAction;
  missionId?: string;
  taskId?: string;
  workItemIds: string[];
  /** Cause/actor of the LAST transition — the audit line, not a log. */
  lastCause?: string;
  lastActor?: string;
  /**
   * The most recent challenge panel's report. It records the exact revision it
   * evaluated, so a reviewer's findings can never be read against a different
   * version of the goal than the one that was actually critiqued.
   */
  challenge?: ChallengeReport;
}

/** The mutable, non-lifecycle half of a goal. `undefined` means "leave as is". */
export interface GoalFieldPatch {
  statement?: string;
  assumptions?: string[];
  constraints?: string[];
  uncertainties?: string[];
  acceptanceCriteria?: string[];
  /** `null` clears the stored next action. */
  nextAction?: GoalNextAction | null;
  /** `null` clears a blocker. */
  blocker?: string | null;
  /** `null` unlinks a mission. */
  missionId?: string | null;
  /** `null` unlinks a task. */
  taskId?: string | null;
  workItemIds?: string[];
  /** `null` clears the stored challenge report. */
  challenge?: ChallengeReport | null;
}

// ── Deterministic hashing ────────────────────────────────────────────────────

/**
 * Canonical JSON: object keys sorted, `undefined` object members dropped (as
 * `JSON.stringify` would), array order preserved (order is meaning: a task list
 * and a criterion list are sequences). Every JSON-representable value is
 * accepted; anything else (a function, a symbol, a circular reference) throws
 * rather than hashing to a lie.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  const type = typeof value;
  if (type === "number") {
    if (!Number.isFinite(value as number)) throw new Error("canonicalJson: non-finite number");
    return JSON.stringify(value);
  }
  if (type === "string" || type === "boolean") return JSON.stringify(value);
  if (type !== "object") throw new Error(`canonicalJson: unsupported value of type ${type}`);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

/**
 * The hash an approval binds to: `sha256:<hex>` over the canonical JSON of the
 * plan content. Same content ⇒ same hash; one changed criterion ⇒ a different
 * hash.
 */
export function hashPlanContent(content: GoalPlanContent): string {
  return `sha256:${createHash("sha256").update(canonicalJson(content), "utf8").digest("hex")}`;
}
