// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The durable goal store — the goal, its plan revisions and the approvals that
 * bind one revision to one authority.
 *
 * ── Why it owns its own file ─────────────────────────────────────────────────
 * Same rationale as the parked-approval store, the Doer inbox and the scheduler
 * lease store: a goal outlives the process that created it, and its lifecycle is
 * private state that must not reshape the frozen `Stores` interfaces. So it is
 * its own SQLite file (same `DatabaseSync` / WAL / `mkdirSync` / `:memory:`
 * pattern as `orchestration/doer.ts`), with one row per goal, one row per plan
 * revision and one row per approval decision.
 *
 * ── The invariant this module enforces ───────────────────────────────────────
 * No work may run on a goal before an approval exists FOR THE PLAN REVISION BEING
 * RUN. That is enforced twice, on purpose:
 *
 *   1. `setGoalState(..., "RUNNING", ...)` refuses when `isApproved(goalId)` is
 *      false — a goal cannot enter the state execution dispatches from.
 *   2. `isApproved` compares the approval's `revisionId` AND `contentHash` to the
 *      CURRENT revision, so a material edit after approval makes the approval
 *      stale even if nobody remembered to call `invalidateApprovals`.
 *
 * `invalidateApprovals` is the explicit, audited invalidation (it stamps the
 * rows); the staleness check is the backstop that does not depend on it.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import {
  canTransition,
  hashPlanContent,
  isGoalState,
  TERMINAL_GOAL_STATES,
  type Goal,
  type GoalBudgets,
  type GoalFieldPatch,
  type GoalPlanContent,
  type GoalState,
  type PlanApproval,
  type PlanRevision,
} from "./goal.ts";

/** How a goal is created. A new goal is always DRAFT — the lifecycle, not the caller, advances it. */
export interface CreateGoalInput {
  statement: string;
  createdBy?: string;
}

export interface GoalListFilter {
  state?: GoalState;
  states?: readonly GoalState[];
  limit?: number;
}

/** The outcome of moving a goal: the new goal, or why the move was refused. */
export type GoalStateChange = { ok: true; goal: Goal } | { ok: false; reason: string };

export interface RecordApprovalInput {
  goalId: string;
  revisionId: string;
  approvedBy: string;
  status: "APPROVED" | "REJECTED";
  /**
   * What the approver authorised (e.g. `["write:repo", "run:tests"]`). Defaults
   * to `[]` — an empty scope authorises nothing, which is the safe default, not
   * an inferred one.
   */
  authorityScope?: string[];
  /** Defaults to the budgets the approved revision itself proposed. */
  budgets?: GoalBudgets;
  note?: string;
  approvedAt?: string;
}

export type ApprovalRecord = { ok: true; approval: PlanApproval; created: boolean } | { ok: false; reason: string };

/** The answer to "may this goal run its current plan?" — always with the reason. */
export interface GoalApprovalStatus {
  approved: boolean;
  revision?: PlanRevision;
  approval?: PlanApproval;
  reason: string;
}

export interface GoalStore {
  readonly path: string;
  createGoal(input: CreateGoalInput): Goal;
  getGoal(id: string): Goal | null;
  listGoals(filter?: GoalListFilter): Goal[];
  /** Refuses a transition the lifecycle forbids, and one into RUNNING without a current approval. */
  setGoalState(id: string, state: GoalState, cause: string, actor: string): GoalStateChange;
  /** Patches the mutable half; returns the updated goal, or null when no such goal exists. */
  setGoalFields(id: string, patch: GoalFieldPatch): Goal | null;
  /** Append a new revision (version = max + 1, hash computed). Throws for an unknown goal. */
  addRevision(goalId: string, content: GoalPlanContent, createdBy: string): PlanRevision;
  getRevision(id: string): PlanRevision | null;
  listRevisions(goalId: string): PlanRevision[];
  currentRevision(goalId: string): PlanRevision | null;
  /** Record a decision, bound to the revision's OWN content hash. Duplicate decisions collapse. */
  recordApproval(input: RecordApprovalInput): ApprovalRecord;
  getApproval(id: string): PlanApproval | null;
  /** The most recent decision for (goal, revision), whatever its status. */
  approvalFor(goalId: string, revisionId: string): PlanApproval | null;
  /** Stamp every not-yet-invalidated approval of the goal; returns how many changed. */
  invalidateApprovals(goalId: string, reason: string): number;
  /** True only when the CURRENT revision has a matching, live, APPROVED decision. */
  isApproved(goalId: string): GoalApprovalStatus;
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS goals (
  id                 TEXT PRIMARY KEY,
  statement          TEXT NOT NULL,
  state              TEXT NOT NULL,
  createdAt          TEXT NOT NULL,
  updatedAt          TEXT NOT NULL,
  createdBy          TEXT,
  assumptionsJson    TEXT NOT NULL,
  constraintsJson    TEXT NOT NULL,
  uncertaintiesJson  TEXT NOT NULL,
  blocker            TEXT,
  nextActionJson     TEXT,
  missionId          TEXT,
  taskId             TEXT,
  workItemIdsJson    TEXT NOT NULL,
  lastCause          TEXT,
  lastActor          TEXT,
  challengeJson      TEXT
);
CREATE INDEX IF NOT EXISTS idx_goals_state ON goals(state);

CREATE TABLE IF NOT EXISTS goal_plan_revisions (
  id          TEXT PRIMARY KEY,
  goalId      TEXT NOT NULL,
  version     INTEGER NOT NULL,
  contentHash TEXT NOT NULL,
  contentJson TEXT NOT NULL,
  createdAt   TEXT NOT NULL,
  createdBy   TEXT NOT NULL,
  supersedes  TEXT,
  UNIQUE(goalId, version)
);
CREATE INDEX IF NOT EXISTS idx_goal_revisions_goal ON goal_plan_revisions(goalId, version);

CREATE TABLE IF NOT EXISTS goal_plan_approvals (
  id                TEXT PRIMARY KEY,
  goalId            TEXT NOT NULL,
  revisionId        TEXT NOT NULL,
  contentHash       TEXT NOT NULL,
  approvedBy        TEXT NOT NULL,
  approvedAt        TEXT NOT NULL,
  authorityScopeJson TEXT NOT NULL,
  budgetsJson       TEXT NOT NULL,
  status            TEXT NOT NULL,
  note              TEXT,
  invalidatedAt     TEXT,
  invalidatedReason TEXT
);
CREATE INDEX IF NOT EXISTS idx_goal_approvals_goal ON goal_plan_approvals(goalId, revisionId);
`;

function optional<T extends object>(target: T, key: keyof T, value: unknown): void {
  if (value !== null && value !== undefined) (target as Record<string, unknown>)[key as string] = value;
}

/**
 * Rows affected by a `node:sqlite` statement run. The driver reports `changes`
 * as a number or a bigint; anything else means "unknown", never a silent 0
 * presented as a successful write.
 */
function changedRows(result: unknown): number {
  if (result === null || typeof result !== "object" || !("changes" in result)) return 0;
  const raw = result.changes;
  if (typeof raw === "number") return raw;
  if (typeof raw === "bigint") return Number(raw);
  return 0;
}

/** A row read back from SQLite: string-keyed, values of unknown shape. */
function isRow(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

/** A `TEXT[]` column read back. A malformed column reads as empty, never as a crash. */
function stringArray(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

/** A JSON object column read back, or undefined when absent/unreadable. */
function jsonObject(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRow(parsed) && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function randomId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid !== undefined
    ? `${prefix}_${uuid}`
    : `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function createGoalStore(opts: { path: string; now?: () => Date }): GoalStore {
  const path = opts.path;
  const now = opts.now ?? (() => new Date());

  if (path !== ":memory:" && !path.startsWith("file:")) {
    const dir = dirname(path);
    if (dir.length > 0 && dir !== ".") mkdirSync(dir, { recursive: true });
  }

  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 5000");
  try {
    db.exec("PRAGMA journal_mode = WAL");
  } catch {
    // Some filesystems reject WAL; single-statement updates stay atomic anyway.
  }
  db.exec(SCHEMA);

  const stmts = {
    goalGet: db.prepare(`SELECT * FROM goals WHERE id = ?`),
    goalList: db.prepare(`SELECT * FROM goals ORDER BY createdAt ASC, rowid ASC`),
    goalInsert: db.prepare(
      `INSERT INTO goals
         (id, statement, state, createdAt, updatedAt, createdBy, assumptionsJson, constraintsJson,
          uncertaintiesJson, blocker, nextActionJson, missionId, taskId, workItemIdsJson, lastCause, lastActor,
          challengeJson)
       VALUES (?, ?, 'DRAFT', ?, ?, ?, '[]', '[]', '[]', NULL, NULL, NULL, NULL, '[]', NULL, NULL, NULL)`,
    ),
    // The full-row write is deliberate: `setGoalFields` merges a patch in memory
    // and rewrites one row, so there is no per-column statement zoo and no
    // dynamic SQL.
    goalUpdate: db.prepare(
      `UPDATE goals
          SET statement = ?, state = ?, updatedAt = ?, createdBy = ?, assumptionsJson = ?, constraintsJson = ?,
              uncertaintiesJson = ?, blocker = ?, nextActionJson = ?, missionId = ?, taskId = ?,
              workItemIdsJson = ?, lastCause = ?, lastActor = ?, challengeJson = ?
        WHERE id = ?`,
    ),
    revisionGet: db.prepare(`SELECT * FROM goal_plan_revisions WHERE id = ?`),
    revisionList: db.prepare(`SELECT * FROM goal_plan_revisions WHERE goalId = ? ORDER BY version ASC`),
    revisionMax: db.prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM goal_plan_revisions WHERE goalId = ?`),
    revisionInsert: db.prepare(
      `INSERT INTO goal_plan_revisions (id, goalId, version, contentHash, contentJson, createdAt, createdBy, supersedes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    approvalGet: db.prepare(`SELECT * FROM goal_plan_approvals WHERE id = ?`),
    // `rowid DESC` breaks ties between two decisions stamped in the same
    // millisecond: the later INSERT wins.
    approvalFor: db.prepare(
      `SELECT * FROM goal_plan_approvals WHERE goalId = ? AND revisionId = ? ORDER BY approvedAt DESC, rowid DESC LIMIT 1`,
    ),
    approvalInsert: db.prepare(
      `INSERT OR IGNORE INTO goal_plan_approvals
         (id, goalId, revisionId, contentHash, approvedBy, approvedAt, authorityScopeJson, budgetsJson, status, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    approvalInvalidate: db.prepare(
      `UPDATE goal_plan_approvals SET invalidatedAt = ?, invalidatedReason = ? WHERE goalId = ? AND invalidatedAt IS NULL`,
    ),
    // Re-recording a decision that was invalidated is a NEW decision: the row is
    // re-affirmed (new timestamp, authority and budgets) rather than left stale,
    // which would strand the goal with an approval that can never count again.
    approvalReaffirm: db.prepare(
      `UPDATE goal_plan_approvals
          SET approvedAt = ?, authorityScopeJson = ?, budgetsJson = ?, note = ?, invalidatedAt = NULL, invalidatedReason = NULL
        WHERE id = ?`,
    ),
  };

  function rowToGoal(row: Record<string, unknown>): Goal {
    const goal: Goal = {
      id: String(row.id),
      statement: String(row.statement),
      // Never repaired to a guess: a state this build does not know is surfaced
      // as written, so a downgrade cannot masquerade as DRAFT.
      state: String(row.state) as GoalState,
      createdAt: String(row.createdAt),
      updatedAt: String(row.updatedAt),
      assumptions: stringArray(row.assumptionsJson),
      constraints: stringArray(row.constraintsJson),
      uncertainties: stringArray(row.uncertaintiesJson),
      workItemIds: stringArray(row.workItemIdsJson),
    };
    optional(goal, "createdBy", row.createdBy);
    optional(goal, "blocker", row.blocker);
    optional(goal, "missionId", row.missionId);
    optional(goal, "taskId", row.taskId);
    optional(goal, "lastCause", row.lastCause);
    optional(goal, "lastActor", row.lastActor);
    // The challenge report is stored verbatim; a row whose JSON will not parse
    // simply has no report rather than breaking the whole goal read.
    const challenge = jsonObject(row.challengeJson);
    if (challenge !== undefined) goal.challenge = challenge as unknown as NonNullable<Goal["challenge"]>;
    const next = jsonObject(row.nextActionJson);
    if (
      next !== undefined &&
      typeof next.action === "string" &&
      typeof next.reason === "string" &&
      typeof next.at === "string"
    ) {
      goal.nextAction = { action: next.action, reason: next.reason, at: next.at };
    }
    return goal;
  }

  function rowToRevision(row: Record<string, unknown>): PlanRevision {
    const revision: PlanRevision = {
      id: String(row.id),
      goalId: String(row.goalId),
      version: Number(row.version),
      contentHash: String(row.contentHash),
      content: JSON.parse(String(row.contentJson)) as GoalPlanContent,
      createdAt: String(row.createdAt),
      createdBy: String(row.createdBy),
    };
    optional(revision, "supersedes", row.supersedes);
    return revision;
  }

  function rowToApproval(row: Record<string, unknown>): PlanApproval {
    const parsedBudgets = jsonObject(row.budgetsJson);
    const approval: PlanApproval = {
      id: String(row.id),
      goalId: String(row.goalId),
      revisionId: String(row.revisionId),
      contentHash: String(row.contentHash),
      approvedBy: String(row.approvedBy),
      approvedAt: String(row.approvedAt),
      authorityScope: stringArray(row.authorityScopeJson),
      budgets: {
        maxTasks: Number(parsedBudgets?.maxTasks ?? 0),
        maxRetries: Number(parsedBudgets?.maxRetries ?? 0),
        maxDepth: Number(parsedBudgets?.maxDepth ?? 0),
      },
      status: String(row.status) === "REJECTED" ? "REJECTED" : "APPROVED",
    };
    optional(approval, "note", row.note);
    optional(approval, "invalidatedAt", row.invalidatedAt);
    optional(approval, "invalidatedReason", row.invalidatedReason);
    return approval;
  }

  function getGoal(id: string): Goal | null {
    const row = stmts.goalGet.get(id) as Record<string, unknown> | undefined;
    return row === undefined ? null : rowToGoal(row);
  }

  function getRevision(id: string): PlanRevision | null {
    const row = stmts.revisionGet.get(id) as Record<string, unknown> | undefined;
    return row === undefined ? null : rowToRevision(row);
  }

  function currentRevision(goalId: string): PlanRevision | null {
    const rows = stmts.revisionList.all(goalId).filter(isRow).map(rowToRevision);
    return rows.length === 0 ? null : rows[rows.length - 1]!;
  }

  function getApproval(id: string): PlanApproval | null {
    const row = stmts.approvalGet.get(id) as Record<string, unknown> | undefined;
    return row === undefined ? null : rowToApproval(row);
  }

  function approvalFor(goalId: string, revisionId: string): PlanApproval | null {
    const row = stmts.approvalFor.get(goalId, revisionId) as Record<string, unknown> | undefined;
    return row === undefined ? null : rowToApproval(row);
  }

  function createGoal(input: CreateGoalInput): Goal {
    const at = now().toISOString();
    const id = randomId("goal");
    stmts.goalInsert.run(id, input.statement, at, at, input.createdBy ?? null);
    return getGoal(id)!;
  }

  function listGoals(filter?: GoalListFilter): Goal[] {
    let goals = stmts.goalList.all().filter(isRow).map(rowToGoal);
    if (filter?.state !== undefined) goals = goals.filter((goal) => goal.state === filter.state);
    if (filter?.states !== undefined) {
      const wanted = filter.states;
      goals = goals.filter((goal) => wanted.includes(goal.state));
    }
    return filter?.limit !== undefined ? goals.slice(0, filter.limit) : goals;
  }

  function writeGoal(goal: Goal): Goal {
    stmts.goalUpdate.run(
      goal.statement,
      goal.state,
      goal.updatedAt,
      goal.createdBy ?? null,
      JSON.stringify(goal.assumptions),
      JSON.stringify(goal.constraints),
      JSON.stringify(goal.uncertainties),
      goal.blocker ?? null,
      goal.nextAction === undefined ? null : JSON.stringify(goal.nextAction),
      goal.missionId ?? null,
      goal.taskId ?? null,
      JSON.stringify(goal.workItemIds),
      goal.lastCause ?? null,
      goal.lastActor ?? null,
      goal.challenge === undefined ? null : JSON.stringify(goal.challenge),
      goal.id,
    );
    return goal;
  }

  function setGoalState(id: string, state: GoalState, cause: string, actor: string): GoalStateChange {
    const goal = getGoal(id);
    if (goal === null) return { ok: false, reason: `no goal "${id}" exists` };
    if (!isGoalState(state)) return { ok: false, reason: `"${String(state)}" is not a goal state` };
    if (TERMINAL_GOAL_STATES.includes(goal.state)) {
      return { ok: false, reason: `goal is ${goal.state}; a terminal goal does not transition` };
    }
    if (!canTransition(goal.state, state)) {
      return { ok: false, reason: `illegal transition ${goal.state} -> ${state}` };
    }
    if (state === "RUNNING") {
      // The safety property, enforced where the state is written: no run without
      // an approval that matches the CURRENT revision's content hash.
      const approval = isApproved(id);
      if (!approval.approved) return { ok: false, reason: `RUNNING requires a current approval: ${approval.reason}` };
    }
    goal.state = state;
    goal.lastCause = cause;
    goal.lastActor = actor;
    goal.updatedAt = now().toISOString();
    return { ok: true, goal: writeGoal(goal) };
  }

  function setGoalFields(id: string, patch: GoalFieldPatch): Goal | null {
    const goal = getGoal(id);
    if (goal === null) return null;
    if (patch.statement !== undefined) goal.statement = patch.statement;
    if (patch.assumptions !== undefined) goal.assumptions = patch.assumptions;
    if (patch.constraints !== undefined) goal.constraints = patch.constraints;
    if (patch.uncertainties !== undefined) goal.uncertainties = patch.uncertainties;
    if (patch.workItemIds !== undefined) goal.workItemIds = patch.workItemIds;
    if (patch.challenge !== undefined) {
      if (patch.challenge === null) delete goal.challenge;
      else goal.challenge = patch.challenge;
    }
    if (patch.nextAction !== undefined) {
      if (patch.nextAction === null) delete goal.nextAction;
      else goal.nextAction = patch.nextAction;
    }
    if (patch.blocker !== undefined) {
      if (patch.blocker === null) delete goal.blocker;
      else goal.blocker = patch.blocker;
    }
    if (patch.missionId !== undefined) {
      if (patch.missionId === null) delete goal.missionId;
      else goal.missionId = patch.missionId;
    }
    if (patch.taskId !== undefined) {
      if (patch.taskId === null) delete goal.taskId;
      else goal.taskId = patch.taskId;
    }
    goal.updatedAt = now().toISOString();
    return writeGoal(goal);
  }

  function addRevision(goalId: string, content: GoalPlanContent, createdBy: string): PlanRevision {
    const goal = getGoal(goalId);
    if (goal === null) throw new Error(`addRevision: no goal "${goalId}" exists`);
    const previous = currentRevision(goalId);
    const version = Number((stmts.revisionMax.get(goalId) as Record<string, unknown> | undefined)?.v ?? 0) + 1;
    const at = now().toISOString();
    const revision: PlanRevision = {
      id: randomId("rev"),
      goalId,
      version,
      contentHash: hashPlanContent(content),
      content,
      createdAt: at,
      createdBy,
    };
    if (previous !== null) revision.supersedes = previous.id;
    stmts.revisionInsert.run(
      revision.id,
      goalId,
      version,
      revision.contentHash,
      JSON.stringify(content),
      at,
      createdBy,
      revision.supersedes ?? null,
    );
    goal.updatedAt = at;
    writeGoal(goal);
    return revision;
  }

  function recordApproval(input: RecordApprovalInput): ApprovalRecord {
    const goal = getGoal(input.goalId);
    if (goal === null) return { ok: false, reason: `no goal "${input.goalId}" exists` };
    const revision = getRevision(input.revisionId);
    if (revision === null) return { ok: false, reason: `no revision "${input.revisionId}" exists` };
    if (revision.goalId !== input.goalId) {
      return { ok: false, reason: `revision "${revision.id}" belongs to goal "${revision.goalId}"` };
    }
    if (input.status === "APPROVED") {
      const current = currentRevision(input.goalId);
      if (current === null || current.id !== revision.id) {
        return {
          ok: false,
          reason: `approval must name the current revision (v${String(current?.version ?? 0)}); refusing to approve superseded "${revision.id}"`,
        };
      }
    }
    // The hash comes from the stored revision, never from the caller: an
    // approval cannot claim to have approved content it did not see.
    const contentHash = revision.contentHash;
    const id = `appr_${createHash("sha256")
      .update(`${input.goalId}\u0000${input.revisionId}\u0000${input.approvedBy}\u0000${input.status}`, "utf8")
      .digest("hex")
      .slice(0, 32)}`;
    const existing = getApproval(id);
    if (existing !== null) {
      if (existing.invalidatedAt === undefined) return { ok: true, approval: existing, created: false };
      // The same decision, made again after an invalidation: re-affirm the row.
      const reaffirmed: PlanApproval = {
        ...existing,
        approvedAt: input.approvedAt ?? now().toISOString(),
        authorityScope: input.authorityScope ?? existing.authorityScope,
        budgets: input.budgets ?? existing.budgets,
      };
      delete reaffirmed.invalidatedAt;
      delete reaffirmed.invalidatedReason;
      optional(reaffirmed, "note", input.note ?? existing.note);
      const changes = stmts.approvalReaffirm.run(
        reaffirmed.approvedAt,
        JSON.stringify(reaffirmed.authorityScope),
        JSON.stringify(reaffirmed.budgets),
        reaffirmed.note ?? null,
        reaffirmed.id,
      );
      if (changedRows(changes) === 0) return { ok: false, reason: `approval "${id}" could not be re-affirmed` };
      return { ok: true, approval: reaffirmed, created: false };
    }
    const approval: PlanApproval = {
      id,
      goalId: input.goalId,
      revisionId: input.revisionId,
      contentHash,
      approvedBy: input.approvedBy,
      approvedAt: input.approvedAt ?? now().toISOString(),
      authorityScope: input.authorityScope ?? [],
      budgets: input.budgets ?? revision.content.budgets,
      status: input.status,
    };
    optional(approval, "note", input.note);
    const result = stmts.approvalInsert.run(
      approval.id,
      approval.goalId,
      approval.revisionId,
      approval.contentHash,
      approval.approvedBy,
      approval.approvedAt,
      JSON.stringify(approval.authorityScope),
      JSON.stringify(approval.budgets),
      approval.status,
      approval.note ?? null,
    );
    if (changedRows(result) === 0) {
      // Lost a write race with an identical decision; the durable row is the
      // truth, so report it as the (already existing) approval.
      const stored = getApproval(id);
      if (stored !== null) return { ok: true, approval: stored, created: false };
      return { ok: false, reason: `approval "${id}" could not be recorded` };
    }
    return { ok: true, approval, created: true };
  }

  function invalidateApprovals(goalId: string, reason: string): number {
    return changedRows(stmts.approvalInvalidate.run(now().toISOString(), reason, goalId));
  }

  function isApproved(goalId: string): GoalApprovalStatus {
    const goal = getGoal(goalId);
    if (goal === null) return { approved: false, reason: `no goal "${goalId}" exists` };
    const revision = currentRevision(goalId);
    if (revision === null) return { approved: false, reason: "no plan revision has been proposed" };
    const approval = approvalFor(goalId, revision.id);
    if (approval === null) {
      return { approved: false, revision, reason: `no decision recorded for revision v${revision.version}` };
    }
    if (approval.status !== "APPROVED") {
      return { approved: false, revision, approval, reason: `revision v${revision.version} was REJECTED` };
    }
    if (approval.invalidatedAt !== undefined) {
      return {
        approved: false,
        revision,
        approval,
        reason: `approval was invalidated: ${approval.invalidatedReason ?? "no reason recorded"}`,
      };
    }
    if (approval.revisionId !== revision.id) {
      return {
        approved: false,
        revision,
        approval,
        reason: `approval is bound to revision "${approval.revisionId}"; current is "${revision.id}"`,
      };
    }
    if (approval.contentHash !== revision.contentHash) {
      return { approved: false, revision, approval, reason: "plan content changed after the approval was given" };
    }
    return { approved: true, revision, approval, reason: `revision v${revision.version} approved by ${approval.approvedBy}` };
  }

  let closed = false;
  function close(): void {
    if (closed) return;
    closed = true;
    db.close();
  }

  return {
    path,
    createGoal,
    getGoal,
    listGoals,
    setGoalState,
    setGoalFields,
    addRevision,
    getRevision,
    listRevisions: (goalId) => stmts.revisionList.all(goalId).filter(isRow).map(rowToRevision),
    currentRevision,
    recordApproval,
    getApproval,
    approvalFor,
    invalidateApprovals,
    isApproved,
    close,
  };
}
