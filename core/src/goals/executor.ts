// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The goal executor: an APPROVED plan becomes linked work items, dependency-ready
 * work is dispatched through the existing orchestrator, and the goal settles only
 * when its acceptance criteria are backed by KAI-observed evidence.
 *
 * ── It is not a second executor ──────────────────────────────────────────────
 * This module owns no task execution. It translates a plan into the existing work
 * board and then calls the existing `runWorkItem`, which is where policy,
 * approvals, the retry ledger and the Outcome Gate already live. Compilation is
 * pure bookkeeping over durable rows.
 *
 * ── Two safety properties, both structural ───────────────────────────────────
 *  1. Compilation refuses unless the goal's CURRENT revision carries a matching
 *     approval. So an unapproved plan cannot even produce work items — and every
 *     item it does produce is linked to the revision that authorised it, which the
 *     orchestration boundary re-checks at dispatch.
 *  2. Compilation is IDEMPOTENT: a work item is keyed by `(goalId, revisionId,
 *     taskId)`, so retrying compilation after a crash creates nothing new. A
 *     second run of the same revision is a no-op, not a duplicate.
 *
 * ── Settlement is evidence-bound ─────────────────────────────────────────────
 * A goal is COMPLETED only when every acceptance criterion is settled by a
 * `kai-observed` evidence record that supports it. Worker-reported claims never
 * settle a criterion, so a goal cannot complete on a worker's say-so.
 */

import type { WorkBoard } from "../orchestration/board.ts";
import type { VerifiedEvidence, WorkItem } from "../orchestration/types.ts";
import type { Goal, GoalPlanContent, PlanRevision } from "./goal.ts";
import type { GoalStore } from "./store.ts";

/** How a criterion was settled, or why it was not. */
export interface CriterionStatus {
  criterion: string;
  met: boolean;
  /** The evidence record that settled it, when one did. */
  evidenceId?: string;
  detail?: string;
}

export interface GoalExecutionStatus {
  goalId: string;
  state: Goal["state"];
  approved: boolean;
  revisionId: string | null;
  criteria: CriterionStatus[];
  /** Work items compiled from the approved revision. */
  items: { id: string; taskId: string; objective: string; state: string; dependsOn: string[]; workerId?: string; attempts: number }[];
  ready: string[];
  blocked: string[];
  settled: boolean;
}

export interface AdvanceReport {
  /** True when the Doer is OFF: nothing was dispatched or interpreted. */
  skipped: boolean;
  dispatched: string[];
  /** Set when the goal reached a terminal state in this pass. */
  settled?: "COMPLETED" | "BLOCKED" | "FAILED";
  reason?: string;
}

export interface GoalExecutorDeps {
  goals: GoalStore;
  board: WorkBoard;
  /** The EXISTING orchestrator entry point. Policy, approvals and the gate apply. */
  runWorkItem: (id: string) => Promise<{ state: string; note?: string }>;
  /** Read live, never captured: autonomous dispatch happens only while ON. */
  doerEnabled: () => boolean;
  /** Concurrent dispatches allowed in one pass. Default 2. */
  maxParallel?: () => number;
  emit?: (type: string, payload: unknown) => void;
}

export interface GoalExecutor {
  /** Turn the approved revision's tasks into linked work items. Idempotent. */
  compile(goalId: string): { ok: true; workItemIds: string[]; created: number } | { ok: false; reason: string };
  /** Dispatch dependency-ready work, then settle the goal if it is finished. */
  advance(goalId: string): Promise<AdvanceReport>;
  /** Read-only view for the UI and for tests. */
  status(goalId: string): GoalExecutionStatus | null;
}

/** The plan content of the goal's approved revision, or a refusal reason. */
function approvedContent(
  goals: GoalStore,
  goalId: string,
): { ok: true; goal: Goal; revision: PlanRevision } | { ok: false; reason: string } {
  const goal = goals.getGoal(goalId);
  if (goal === null) return { ok: false, reason: `no goal "${goalId}" exists` };
  const approval = goals.isApproved(goalId);
  if (!approval.approved) return { ok: false, reason: `the plan is not approved: ${approval.reason}` };
  const revision = goals.currentRevision(goalId);
  if (revision === null) return { ok: false, reason: "the goal has no plan revision" };
  // Belt and braces: the approval must name THIS revision, even though
  // `isApproved` already compares both id and content hash.
  if (approval.revision !== undefined && approval.revision.id !== revision.id) {
    return { ok: false, reason: `the approval names revision "${approval.revision.id}", not the current "${revision.id}"` };
  }
  return { ok: true, goal, revision };
}

/** Every work item compiled from one goal revision. */
function itemsFor(board: WorkBoard, goalId: string, revisionId: string): WorkItem[] {
  return board.list({}).filter((item) => item.goalId === goalId && item.goalRevisionId === revisionId);
}

/**
 * The criterion labels the goal itself must satisfy, unioned with the per-task
 * criteria. A plan-level criterion that no task claims still has to be settled,
 * or the goal can never complete — better to know that up front.
 */
function requiredCriteria(content: GoalPlanContent): string[] {
  const labels = [...content.acceptanceCriteria];
  for (const task of content.tasks) {
    for (const criterion of task.acceptanceCriteria) {
      if (!labels.includes(criterion)) labels.push(criterion);
    }
  }
  return labels;
}

/** Is this criterion settled by a KAI-OBSERVED record that supports it? */
function criterionStatuses(criteria: readonly string[], items: readonly WorkItem[]): CriterionStatus[] {
  return criteria.map((criterion) => {
    for (const item of items) {
      const record = item.evidence.find(
        (e: VerifiedEvidence) => e.source === "kai-observed" && e.supports.includes(criterion),
      );
      if (record !== undefined) return { criterion, met: true, evidenceId: record.id, detail: record.detail };
    }
    // A worker-reported record that supports it is NOT proof — say so rather
    // than leaving the reader to guess why it did not count.
    const claimed = items.some((item) =>
      item.evidence.some((e: VerifiedEvidence) => e.source === "worker-reported" && e.supports.includes(criterion)),
    );
    return {
      criterion,
      met: false,
      ...(claimed ? { detail: "claimed by a worker but never observed by KAI" } : { detail: "no evidence recorded" }),
    };
  });
}

export function createGoalExecutor(deps: GoalExecutorDeps): GoalExecutor {
  function compile(goalId: string): { ok: true; workItemIds: string[]; created: number } | { ok: false; reason: string } {
    const approved = approvedContent(deps.goals, goalId);
    if (!approved.ok) return approved;
    const { revision } = approved;
    const content = revision.content;

    const existing = itemsFor(deps.board, goalId, revision.id);
    const byTask = new Map(existing.map((item) => [item.taskId ?? "", item]));
    const ids: string[] = [];
    let created = 0;

    for (const task of content.tasks) {
      // Idempotency by construction: a task is identified by its plan task id
      // within this goal revision, so a retried compile finds it and skips.
      const found = byTask.get(task.id);
      if (found !== undefined) {
        ids.push(found.id);
        continue;
      }
      const made = deps.board.create({
        objective: task.objective,
        deliverable: task.title,
        taskId: task.id,
        goalId,
        goalRevisionId: revision.id,
        criteria: task.acceptanceCriteria,
        // Each criterion must be settled by its own observed record: the label
        // IS the required evidence, and it links to itself.
        requiredEvidence: task.acceptanceCriteria,
        evidenceLinks: Object.fromEntries(task.acceptanceCriteria.map((c) => [c, [c]])),
        constraints: content.constraints,
        forbiddenOutcomes: content.forbiddenOutcomes,
        ...(content.budgets.maxRetries !== undefined
          ? { budget: { maxRetries: content.budgets.maxRetries, maxDepth: content.budgets.maxDepth } }
          : {}),
        ...(content.authorizedWorkspace.length > 0 ? { workingDir: content.authorizedWorkspace[0] } : {}),
      });
      if (!made.ok) {
        // A refused item is a real refusal: report it rather than compiling a
        // partial plan that looks complete.
        return { ok: false, reason: `task "${task.id}" could not become a work item: ${made.reason}` };
      }
      ids.push(made.value.id);
      created += 1;
    }

    if (created > 0) {
      deps.emit?.("goal.compiled", { goalId, revisionId: revision.id, created, total: ids.length });
    }
    return { ok: true, workItemIds: ids, created };
  }

  /**
   * The work items this pass should hand to the orchestrator, in PLAN order.
   *
   * Three kinds qualify:
   *   - READY whose dependencies have all COMPLETED (new work);
   *   - CHANGES_REQUESTED (the gate asked for a correction — a retry, not a
   *     stall). Without this, a goal whose task failed verification would sit in
   *     RUNNING forever while nothing re-attempted it;
   *   - FAILED (a bounded recovery attempt).
   *
   * Whether an attempt is actually PERMITTED is not decided here: `runWorkItem`
   * owns the retry ledger and the Outcome Gate, and it refuses (and blocks) when
   * the budget is spent. This function only says what is worth asking.
   */
  function dispatchableItems(content: GoalPlanContent, items: readonly WorkItem[]): WorkItem[] {
    const byTask = new Map(items.map((item) => [item.taskId ?? "", item]));
    const out: WorkItem[] = [];
    for (const task of content.tasks) {
      const item = byTask.get(task.id);
      if (item === undefined) continue;
      if (item.state === "CHANGES_REQUESTED" || item.state === "FAILED") {
        out.push(item);
        continue;
      }
      if (item.state !== "READY") continue;
      const depsDone = task.dependsOn.every((dep) => {
        const parent = byTask.get(dep);
        // An unknown dependency is NOT "done": it is a plan defect, and treating
        // it as satisfied would dispatch work whose prerequisite never ran.
        return parent !== undefined && parent.state === "COMPLETED";
      });
      if (depsDone) out.push(item);
    }
    return out;
  }

  function status(goalId: string): GoalExecutionStatus | null {
    const goal = deps.goals.getGoal(goalId);
    if (goal === null) return null;
    const revision = deps.goals.currentRevision(goalId);
    const approval = deps.goals.isApproved(goalId);
    const items = revision === null ? [] : itemsFor(deps.board, goalId, revision.id);
    const content = revision?.content;
    const criteria = content === undefined ? [] : requiredCriteria(content);
    const byTask = new Map(items.map((item) => [item.taskId ?? "", item]));
    return {
      goalId,
      state: goal.state,
      approved: approval.approved,
      revisionId: revision?.id ?? null,
      criteria: criterionStatuses(criteria, items),
      items: [...items]
        .sort((a, b) => {
          const order = (item: WorkItem): number => content?.tasks.findIndex((t) => t.id === item.taskId) ?? -1;
          return order(a) - order(b);
        })
        .map((item) => ({
        id: item.id,
        taskId: item.taskId ?? "",
        objective: item.objective,
        state: item.state,
        dependsOn: (content?.tasks.find((t) => t.id === item.taskId)?.dependsOn ?? []).map(
          (dep) => byTask.get(dep)?.id ?? dep,
        ),
        ...(item.workerId !== undefined ? { workerId: item.workerId } : {}),
        attempts: item.attempts,
      })),
      ready: content === undefined ? [] : dispatchableItems(content, items).map((item) => item.id),
      blocked: items.filter((item) => item.state === "BLOCKED").map((item) => item.id),
      settled: ["COMPLETED", "FAILED", "CANCELLED"].includes(goal.state),
    };
  }

  async function advance(goalId: string): Promise<AdvanceReport> {
    const goal = deps.goals.getGoal(goalId);
    if (goal === null) return { skipped: false, dispatched: [], reason: `no goal "${goalId}" exists` };

    // Autonomous dispatch is the Doer's capability. OFF means: no claim, no
    // dispatch, no settlement — the durable rows simply wait.
    if (!deps.doerEnabled()) {
      return { skipped: true, dispatched: [], reason: "the KAI Doer is OFF" };
    }

    const approved = approvedContent(deps.goals, goalId);
    if (!approved.ok) {
      // Not approved (or a stale approval). Nothing may dispatch, and the goal
      // is reported as waiting rather than silently stuck.
      return { skipped: false, dispatched: [], reason: approved.reason };
    }
    const { revision } = approved;
    const content = revision.content;

    // A goal that is APPROVED becomes RUNNING only here, and only because an
    // approved revision exists — `setGoalState` re-checks that itself.
    if (deps.goals.getGoal(goalId)?.state === "APPROVED") {
      const moved = deps.goals.setGoalState(goalId, "RUNNING", "execution started on an approved plan", "kai");
      if (!moved.ok) return { skipped: false, dispatched: [], reason: moved.reason };
    }

    const compiled = compile(goalId);
    if (!compiled.ok) return { skipped: false, dispatched: [], reason: compiled.reason };

    const items = itemsFor(deps.board, goalId, revision.id);
    const limit = deps.maxParallel?.() ?? 2;
    const ready = dispatchableItems(content, items).slice(0, Math.max(1, limit));
    const dispatched: string[] = [];
    for (const item of ready) {
      const outcome = await deps.runWorkItem(item.id);
      dispatched.push(item.id);
      deps.emit?.("goal.task_dispatched", { goalId, workItemId: item.id, state: outcome.state });
    }

    // ── Settlement ────────────────────────────────────────────────────────────
    const after = itemsFor(deps.board, goalId, revision.id);
    // BLOCKED is terminal FOR SETTLEMENT: it means the item spent its budget or
    // has no path forward. Leaving it out was a real defect — a goal whose task
    // blocked sat in RUNNING forever with nothing ever re-attempting it, which is
    // exactly the silent stall the trust work exists to prevent.
    const SETTLED_ITEM_STATES = ["COMPLETED", "FAILED", "CANCELLED", "BLOCKED"];
    const allTerminal = after.length > 0 && after.every((item) => SETTLED_ITEM_STATES.includes(item.state));
    if (!allTerminal) {
      // ── A stalled dependency chain is a SETTLEMENT, not a wait ──────────────
      // If nothing is dispatchable and nothing is in flight, no further progress
      // is possible: a BLOCKED/FAILED prerequisite strands its dependents in
      // READY forever. Observed in a live run — the goal sat in RUNNING with one
      // item BLOCKED and three dependents READY, and would have stayed there.
      const byTask = new Map(after.map((item) => [item.taskId ?? "", item]));
      const stranded = after.filter(
        (item) =>
          item.state === "READY" &&
          content.tasks.some(
            (task) =>
              task.id === item.taskId &&
              task.dependsOn.some((dep) => {
                const parent = byTask.get(dep);
                return parent !== undefined && ["BLOCKED", "FAILED", "CANCELLED"].includes(parent.state);
              }),
          ),
      );
      const inFlight = after.some((item) => ["RUNNING", "CLAIMED", "REVIEW", "CHANGES_REQUESTED", "WAITING"].includes(item.state));
      if (stranded.length > 0 && !inFlight) {
        const reason = `${stranded.length} task(s) can never run because a prerequisite ended BLOCKED/FAILED: ${stranded
          .map((i) => i.objective.slice(0, 80))
          .join(" | ")}`;
        deps.goals.setGoalFields(goalId, {
          blocker: reason,
          nextAction: { action: "ASK_USER", reason, at: new Date().toISOString() },
        });
        const settled = deps.goals.setGoalState(goalId, "BLOCKED", "a prerequisite ended without satisfying its criteria", "kai");
        deps.emit?.("goal.settled", { goalId, state: "BLOCKED", stranded: stranded.length });
        return settled.ok
          ? { skipped: false, dispatched, settled: "BLOCKED", reason }
          : { skipped: false, dispatched, reason: settled.reason };
      }
      return { skipped: false, dispatched, reason: dispatched.length > 0 ? undefined : "no dependency-ready work" };
    }

    const criteria = criterionStatuses(requiredCriteria(content), after);
    const unmet = criteria.filter((c) => !c.met);
    if (unmet.length === 0) {
      const settled = deps.goals.setGoalState(goalId, "COMPLETED", "every acceptance criterion was verified", "kai");
      deps.emit?.("goal.settled", { goalId, state: "COMPLETED", criteria: criteria.length });
      return settled.ok
        ? { skipped: false, dispatched, settled: "COMPLETED" }
        : { skipped: false, dispatched, reason: settled.reason };
    }

    // Terminal but unverified. A goal whose criteria were never observed is
    // BLOCKED — not completed, and not left silently RUNNING.
    const failed = after.some((item) => item.state === "FAILED");
    const blockedItems = after.filter((item) => item.state === "BLOCKED");
    const blockedNote =
      blockedItems.length > 0
        ? `; ${blockedItems.length} task(s) blocked: ${blockedItems.map((i) => i.objective.slice(0, 80)).join(" | ")}`
        : "";
    const reason = `${unmet.length} criterion(s) unverified: ${unmet.map((c) => `${c.criterion} (${c.detail})`).join("; ")}${blockedNote}`;
    deps.goals.setGoalFields(goalId, { blocker: reason, nextAction: { action: "ASK_USER", reason, at: new Date().toISOString() } });
    const settled = deps.goals.setGoalState(goalId, "BLOCKED", "acceptance criteria were not verified", "kai");
    deps.emit?.("goal.settled", { goalId, state: "BLOCKED", failed, unmet: unmet.map((c) => c.criterion) });
    return settled.ok
      ? { skipped: false, dispatched, settled: "BLOCKED", reason }
      : { skipped: false, dispatched, reason: settled.reason };
  }

  return { compile, advance, status };
}
