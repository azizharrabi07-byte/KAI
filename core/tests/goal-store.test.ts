// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The durable goal layer.
 *
 * These tests run against REAL SQLite files (a temp directory per test), never a
 * mock: the point of the store is that a goal, its plan revisions and the
 * approval that binds one revision survive a restart. `:memory:` is covered too
 * because the runtime uses it for isolated instances.
 *
 * The contract under test:
 *   - a goal round-trips (statement, state, lists, links);
 *   - an illegal lifecycle transition is refused, and RUNNING is unreachable
 *     without an approval for the CURRENT revision;
 *   - the plan hash is stable under re-serialisation and changes on a material
 *     edit;
 *   - revisions version gaplessly and chain through `supersedes`;
 *   - an approval binds to one revision's content hash;
 *   - a material revision makes the prior approval STALE (`isApproved` false);
 *   - a duplicate approval writes nothing new;
 *   - everything survives close/reopen.
 *
 * Run from `core/`:  node --test tests/goal-store.test.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

import { canonicalJson, canTransition, hashPlanContent, type GoalPlanContent } from "../src/goals/goal.ts";
import { createGoalStore, type GoalStore } from "../src/goals/store.ts";

const temporaries: string[] = [];
const openStores: GoalStore[] = [];

after(() => {
  // Close every store before deleting its file: a live SQLite handle locks the
  // directory on Windows, and one failed test must not mask the rest.
  for (const store of openStores) store.close();
  for (const dir of temporaries) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // A temp directory that resists deletion is the OS's business, not a test failure.
    }
  }
});

/** A REAL store on a REAL temp file. `dir` is removed after the file. */
function tempStore(opts?: { now?: () => Date }): { store: GoalStore; dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "kai-goals-"));
  temporaries.push(dir);
  const path = join(dir, "goals.db");
  const store = createGoalStore({ path, ...(opts?.now !== undefined ? { now: opts.now } : {}) });
  openStores.push(store);
  return { store, dir, path };
}

/** Register a store opened directly in a test so the cleanup hook closes it too. */
function remember(store: GoalStore): GoalStore {
  openStores.push(store);
  return store;
}

/** A valid plan; every field is present so a hash difference can only come from the edit made in the test. */
function plan(overrides: Partial<GoalPlanContent> = {}): GoalPlanContent {
  return {
    summary: "Ship the goal layer",
    deliverables: ["goal.ts", "store.ts"],
    tasks: [
      {
        id: "t1",
        title: "Store",
        objective: "persist goals",
        dependsOn: [],
        role: "coding",
        acceptanceCriteria: ["round-trips"],
        verification: ["node --test"],
      },
    ],
    acceptanceCriteria: ["goals survive restart", "no run before approval"],
    requiredEvidence: ["test output"],
    constraints: ["additive only"],
    forbiddenOutcomes: ["dispatch without approval"],
    authorizedWorkspace: ["core/src/goals"],
    assumptions: ["SQLite is available"],
    uncertainties: ["budget sizing"],
    budgets: { maxTasks: 5, maxRetries: 2, maxDepth: 3 },
    ...overrides,
  };
}

/** The same content with every object's keys in reverse insertion order — a cosmetic re-serialisation. */
function withReversedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withReversedKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).reverse()) {
      out[key] = withReversedKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Count rows in a store file directly, so "no duplicate row" is asserted on disk, not on a return value. */
function rowCount(path: string, table: string): number {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as Record<string, unknown>;
    return Number(row.n);
  } finally {
    db.close();
  }
}

/** Walk a goal to AWAITING_PLAN_APPROVAL; asserts every step so a broken edge is visible. */
function advance(store: GoalStore, goalId: string, ...states: Parameters<GoalStore["setGoalState"]>[1][]): void {
  for (const state of states) {
    const moved = store.setGoalState(goalId, state, "test", "tester");
    assert.equal(moved.ok, true, `expected ${state} to be reachable: ${moved.ok ? "" : moved.reason}`);
  }
}

// ── Round trip ────────────────────────────────────────────────────────────────

test("createGoal persists a DRAFT goal and reads it back", () => {
  const { store } = tempStore();
  const created = store.createGoal({ statement: "make KAI goal-driven", createdBy: "user" });
  assert.equal(created.state, "DRAFT");
  assert.equal(created.statement, "make KAI goal-driven");
  assert.equal(created.createdBy, "user");
  assert.deepEqual(created.assumptions, []);
  assert.deepEqual(created.workItemIds, []);

  const read = store.getGoal(created.id);
  assert.deepEqual(read, created);
  assert.equal(store.getGoal("goal_missing"), null);
  assert.equal(store.listGoals().length, 1);
  assert.equal(store.listGoals({ state: "DRAFT" }).length, 1);
  assert.equal(store.listGoals({ state: "RUNNING" }).length, 0);
  store.close();
});

test("setGoalFields patches the mutable half and clears with null", () => {
  const { store } = tempStore();
  const goal = store.createGoal({ statement: "g" });
  const updated = store.setGoalFields(goal.id, {
    statement: "g, sharpened",
    assumptions: ["a1"],
    constraints: ["c1"],
    uncertainties: ["u1"],
    nextAction: { action: "challenge", reason: "not yet challenged", at: "2026-10-10T00:00:00.000Z" },
    blocker: "waiting on a decision",
    missionId: "mission_1",
    taskId: "task_1",
    workItemIds: ["wi_1", "wi_2"],
  });
  assert.equal(updated?.statement, "g, sharpened");
  assert.deepEqual(updated?.assumptions, ["a1"]);
  assert.equal(updated?.nextAction?.action, "challenge");
  assert.equal(updated?.blocker, "waiting on a decision");
  assert.deepEqual(updated?.workItemIds, ["wi_1", "wi_2"]);

  const cleared = store.setGoalFields(goal.id, { blocker: null, nextAction: null, missionId: null, taskId: null });
  assert.equal(cleared?.blocker, undefined);
  assert.equal(cleared?.nextAction, undefined);
  assert.equal(cleared?.missionId, undefined);
  assert.equal(cleared?.taskId, undefined);
  assert.equal(store.setGoalFields("goal_missing", { statement: "x" }), null);
  store.close();
});

// ── Lifecycle ─────────────────────────────────────────────────────────────────

test("canTransition encodes the lifecycle, including no self-loops", () => {
  assert.equal(canTransition("DRAFT", "UNDERSTANDING"), true);
  assert.equal(canTransition("UNDERSTANDING", "CHALLENGING"), true);
  assert.equal(canTransition("REVISION_REQUIRED", "CHALLENGING"), true);
  assert.equal(canTransition("READY_FOR_PLAN", "RUNNING"), false);
  assert.equal(canTransition("AWAITING_PLAN_APPROVAL", "APPROVED"), true);
  assert.equal(canTransition("APPROVED", "RUNNING"), true);
  assert.equal(canTransition("COMPLETED", "RUNNING"), false);
  assert.equal(canTransition("CANCELLED", "DRAFT"), false);
  assert.equal(canTransition("RUNNING", "RUNNING"), false);
});

test("an illegal transition is refused and the goal is unchanged", () => {
  const { store } = tempStore();
  const goal = store.createGoal({ statement: "g" });
  const refused = store.setGoalState(goal.id, "RUNNING", "skip the plan", "rogue");
  assert.equal(refused.ok, false);
  assert.match(refused.ok === false ? refused.reason : "", /illegal transition DRAFT -> RUNNING/);
  assert.equal(store.getGoal(goal.id)?.state, "DRAFT");

  const missing = store.setGoalState("goal_missing", "UNDERSTANDING", "c", "a");
  assert.equal(missing.ok, false);

  // A terminal goal is a dead end.
  advance(store, goal.id, "UNDERSTANDING", "CHALLENGING", "READY_FOR_PLAN", "PLAN_PROPOSED", "AWAITING_PLAN_APPROVAL");
  assert.equal(store.setGoalState(goal.id, "CANCELLED", "user withdrew", "user").ok, true);
  const dead = store.setGoalState(goal.id, "RUNNING", "resurrect", "rogue");
  assert.equal(dead.ok, false);
  assert.match(dead.ok === false ? dead.reason : "", /terminal goal/);
  store.close();
});

test("RUNNING is unreachable until the current revision is approved", () => {
  const { store } = tempStore();
  const goal = store.createGoal({ statement: "g" });
  advance(store, goal.id, "UNDERSTANDING", "CHALLENGING", "READY_FOR_PLAN", "PLAN_PROPOSED", "AWAITING_PLAN_APPROVAL");
  const revision = store.addRevision(goal.id, plan(), "architect");

  const blocked = store.setGoalState(goal.id, "APPROVED", "user approved", "user");
  assert.equal(blocked.ok, true, "APPROVED is a lifecycle move; the approval row is what is missing");

  const refused = store.setGoalState(goal.id, "RUNNING", "start", "orchestrator");
  assert.equal(refused.ok, false);
  assert.match(refused.ok === false ? refused.reason : "", /RUNNING requires a current approval/);
  assert.equal(store.getGoal(goal.id)?.state, "APPROVED");

  const approval = store.recordApproval({
    goalId: goal.id,
    revisionId: revision.id,
    approvedBy: "user",
    status: "APPROVED",
    authorityScope: ["write:core/src/goals"],
  });
  assert.equal(approval.ok, true);
  const started = store.setGoalState(goal.id, "RUNNING", "dispatch", "orchestrator");
  assert.equal(started.ok, true, started.ok ? "" : started.reason);
  assert.equal(store.getGoal(goal.id)?.state, "RUNNING");
  store.close();
});

// ── Hashing ──────────────────────────────────────────────────────────────────

test("hashPlanContent is stable under re-serialisation", () => {
  const content = plan();
  const first = hashPlanContent(content);
  assert.equal(hashPlanContent(content), first);
  // A deep clone with every object's keys reversed is the same plan.
  const clone = JSON.parse(JSON.stringify(content)) as GoalPlanContent;
  assert.equal(hashPlanContent(clone), first);
  assert.equal(hashPlanContent(withReversedKeys(content) as GoalPlanContent), first);
  assert.match(first, /^sha256:[0-9a-f]{64}$/);
  assert.equal(canonicalJson({ b: 1, a: [2, 3] }), '{"a":[2,3],"b":1}');
});

test("one materially changed criterion changes the hash", () => {
  const base = plan();
  const hash = hashPlanContent(base);
  const editedCriteria = hashPlanContent({ ...base, acceptanceCriteria: ["goals survive restart", "no run before approval!"] });
  assert.notEqual(editedCriteria, hash);

  const editedTask = hashPlanContent({
    ...base,
    tasks: [{ ...base.tasks[0]!, acceptanceCriteria: ["round-trips too"] }],
  });
  assert.notEqual(editedTask, hash);

  const editedBudget = hashPlanContent({ ...base, budgets: { ...base.budgets, maxTasks: 6 } });
  assert.notEqual(editedBudget, hash);

  const addedTask = hashPlanContent({
    ...base,
    tasks: [
      ...base.tasks,
      {
        id: "t2",
        title: "Second",
        objective: "more",
        dependsOn: ["t1"],
        role: "coding",
        acceptanceCriteria: [],
        verification: [],
      },
    ],
  });
  assert.notEqual(addedTask, hash);
});

// ── Revisions ────────────────────────────────────────────────────────────────

test("addRevision versions gaplessly and chains supersedes", () => {
  const { store } = tempStore();
  const goal = store.createGoal({ statement: "g" });
  assert.equal(store.currentRevision(goal.id), null);

  const v1 = store.addRevision(goal.id, plan(), "architect");
  const v2 = store.addRevision(goal.id, plan({ summary: "v2" }), "architect");
  const v3 = store.addRevision(goal.id, plan({ summary: "v3" }), "architect");
  assert.deepEqual([v1.version, v2.version, v3.version], [1, 2, 3]);
  assert.equal(v1.supersedes, undefined);
  assert.equal(v2.supersedes, v1.id);
  assert.equal(v3.supersedes, v2.id);
  assert.equal(v1.contentHash, hashPlanContent(plan()));
  assert.notEqual(v2.contentHash, v1.contentHash);

  assert.deepEqual(store.listRevisions(goal.id).map((revision) => revision.version), [1, 2, 3]);
  assert.equal(store.currentRevision(goal.id)?.id, v3.id);
  assert.deepEqual(store.getRevision(v2.id), v2);
  assert.equal(store.getRevision("rev_missing"), null);
  assert.throws(() => store.addRevision("goal_missing", plan(), "architect"), /no goal/);
  store.close();
});

// ── Approvals ────────────────────────────────────────────────────────────────

test("an approval binds to the revision's own content hash", () => {
  const { store } = tempStore();
  const goal = store.createGoal({ statement: "g" });
  const revision = store.addRevision(goal.id, plan(), "architect");

  const recorded = store.recordApproval({
    goalId: goal.id,
    revisionId: revision.id,
    approvedBy: "user",
    status: "APPROVED",
    authorityScope: ["write:repo"],
    budgets: { maxTasks: 3, maxRetries: 1, maxDepth: 2 },
    note: "go ahead",
  });
  assert.equal(recorded.ok, true);
  if (!recorded.ok) return;
  assert.equal(recorded.created, true);
  assert.equal(recorded.approval.revisionId, revision.id);
  assert.equal(recorded.approval.contentHash, revision.contentHash);
  assert.deepEqual(recorded.approval.budgets, { maxTasks: 3, maxRetries: 1, maxDepth: 2 });
  assert.equal(recorded.approval.note, "go ahead");

  assert.deepEqual(store.getApproval(recorded.approval.id), recorded.approval);
  assert.equal(store.approvalFor(goal.id, revision.id)?.id, recorded.approval.id);
  assert.equal(store.approvalFor(goal.id, "rev_missing"), null);

  const status = store.isApproved(goal.id);
  assert.equal(status.approved, true);
  assert.equal(status.revision?.id, revision.id);
  assert.equal(status.approval?.id, recorded.approval.id);

  const unknownGoal = store.recordApproval({ goalId: "goal_missing", revisionId: revision.id, approvedBy: "u", status: "APPROVED" });
  assert.equal(unknownGoal.ok, false);
  const unknownRevision = store.recordApproval({ goalId: goal.id, revisionId: "rev_missing", approvedBy: "u", status: "APPROVED" });
  assert.equal(unknownRevision.ok, false);
  store.close();
});

test("a duplicate approval writes nothing new", () => {
  const { store, path } = tempStore();
  const goal = store.createGoal({ statement: "g" });
  const revision = store.addRevision(goal.id, plan(), "architect");

  const first = store.recordApproval({ goalId: goal.id, revisionId: revision.id, approvedBy: "user", status: "APPROVED" });
  const second = store.recordApproval({ goalId: goal.id, revisionId: revision.id, approvedBy: "user", status: "APPROVED" });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.approval.id, first.approval.id);
  assert.equal(second.approval.approvedAt, first.approval.approvedAt);

  // A different approver is a different decision, and a rejection is its own row.
  const other = store.recordApproval({ goalId: goal.id, revisionId: revision.id, approvedBy: "auditor", status: "APPROVED" });
  const rejected = store.recordApproval({ goalId: goal.id, revisionId: revision.id, approvedBy: "user", status: "REJECTED" });
  assert.equal(other.ok && other.created, true);
  assert.equal(rejected.ok && rejected.created, true);

  // ...but the file holds exactly one row per distinct decision.
  store.close();
  assert.equal(rowCount(path, "goal_plan_approvals"), 3);
});

test("a material revision makes the prior approval stale", () => {
  const { store } = tempStore();
  const goal = store.createGoal({ statement: "g" });
  const v1 = store.addRevision(goal.id, plan(), "architect");
  store.recordApproval({ goalId: goal.id, revisionId: v1.id, approvedBy: "user", status: "APPROVED" });
  assert.equal(store.isApproved(goal.id).approved, true);

  const v2 = store.addRevision(goal.id, plan({ acceptanceCriteria: ["goals survive restart", "no run before approval", "and a third"] }), "architect");
  const status = store.isApproved(goal.id);
  assert.equal(status.approved, false);
  assert.equal(status.revision?.id, v2.id);
  assert.match(status.reason, /no decision recorded for revision v2/);

  // A fresh approval of the CURRENT revision restores it.
  store.recordApproval({ goalId: goal.id, revisionId: v2.id, approvedBy: "user", status: "APPROVED" });
  assert.equal(store.isApproved(goal.id).approved, true);

  // An explicit invalidation is audited and also yields false. Two decisions
  // exist for this goal (the stale v1 approval and the v2 one), so both stamp.
  assert.equal(store.invalidateApprovals(goal.id, "user reopened the goal"), 2);
  const invalidated = store.isApproved(goal.id);
  assert.equal(invalidated.approved, false);
  assert.match(invalidated.reason, /invalidated: user reopened the goal/);
  assert.equal(invalidated.approval?.invalidatedReason, "user reopened the goal");
  store.close();
});

test("re-approving the same revision after invalidation re-affirms it", () => {
  const { store, path } = tempStore();
  const goal = store.createGoal({ statement: "g" });
  const revision = store.addRevision(goal.id, plan(), "architect");
  const first = store.recordApproval({ goalId: goal.id, revisionId: revision.id, approvedBy: "user", status: "APPROVED" });
  assert.equal(first.ok, true);
  assert.equal(store.invalidateApprovals(goal.id, "user reopened the goal"), 1);
  assert.equal(store.isApproved(goal.id).approved, false);

  const again = store.recordApproval({
    goalId: goal.id,
    revisionId: revision.id,
    approvedBy: "user",
    status: "APPROVED",
    authorityScope: ["write:repo"],
    note: "reviewed again",
  });
  assert.equal(again.ok, true);
  if (!first.ok || !again.ok) return;
  assert.equal(again.created, false, "the same decision reuses its row");
  assert.equal(again.approval.id, first.approval.id);
  assert.equal(again.approval.invalidatedAt, undefined);
  assert.deepEqual(again.approval.authorityScope, ["write:repo"]);
  assert.notEqual(again.approval.approvedAt, first.approval.approvedAt);
  assert.equal(store.isApproved(goal.id).approved, true);
  store.close();
  assert.equal(rowCount(path, "goal_plan_approvals"), 1);
});

test("approving a superseded revision is refused; rejecting the current one is recorded", () => {
  const { store } = tempStore();
  const goal = store.createGoal({ statement: "g" });
  const v1 = store.addRevision(goal.id, plan(), "architect");
  const v2 = store.addRevision(goal.id, plan({ summary: "v2" }), "architect");

  const stale = store.recordApproval({ goalId: goal.id, revisionId: v1.id, approvedBy: "user", status: "APPROVED" });
  assert.equal(stale.ok, false);
  assert.match(stale.ok === false ? stale.reason : "", /current revision/);

  const rejection = store.recordApproval({ goalId: goal.id, revisionId: v2.id, approvedBy: "user", status: "REJECTED", note: "too vague" });
  assert.equal(rejection.ok, true);
  const status = store.isApproved(goal.id);
  assert.equal(status.approved, false);
  assert.match(status.reason, /REJECTED/);
  store.close();
});

// ── Durability ───────────────────────────────────────────────────────────────

test("goals, revisions and approvals survive close/reopen", () => {
  const { store, path } = tempStore();
  const goal = store.createGoal({ statement: "durable goal", createdBy: "user" });
  advance(store, goal.id, "UNDERSTANDING", "CHALLENGING", "READY_FOR_PLAN", "PLAN_PROPOSED", "AWAITING_PLAN_APPROVAL", "APPROVED");
  const revision = store.addRevision(goal.id, plan(), "architect");
  store.setGoalFields(goal.id, { assumptions: ["A"], workItemIds: ["wi_9"] });
  const approval = store.recordApproval({ goalId: goal.id, revisionId: revision.id, approvedBy: "user", status: "APPROVED" });
  assert.equal(approval.ok, true);
  store.close();

  const reopened = remember(createGoalStore({ path }));
  const read = reopened.getGoal(goal.id);
  assert.equal(read?.state, "APPROVED");
  assert.deepEqual(read?.assumptions, ["A"]);
  assert.deepEqual(read?.workItemIds, ["wi_9"]);
  assert.equal(read?.lastCause, "test");
  assert.deepEqual(reopened.currentRevision(goal.id), revision);
  assert.equal(reopened.isApproved(goal.id).approved, true);
  const restarted = reopened.setGoalState(goal.id, "RUNNING", "resume", "orchestrator");
  assert.equal(restarted.ok, true, restarted.ok ? "" : restarted.reason);
  reopened.close();
});

test(":memory: works without touching the filesystem", () => {
  const store = createGoalStore({ path: ":memory:" });
  const goal = store.createGoal({ statement: "in-memory goal" });
  const revision = store.addRevision(goal.id, plan(), "architect");
  const approval = store.recordApproval({ goalId: goal.id, revisionId: revision.id, approvedBy: "user", status: "APPROVED" });
  assert.equal(approval.ok, true);
  assert.equal(store.isApproved(goal.id).approved, true);
  assert.equal(store.listGoals().length, 1);
  store.close();
});

test("an injected clock stamps every write", () => {
  const clock = new Date("2026-10-10T12:00:00.000Z");
  const { store } = tempStore({ now: () => clock });
  const goal = store.createGoal({ statement: "g" });
  assert.equal(goal.createdAt, "2026-10-10T12:00:00.000Z");
  const revision = store.addRevision(goal.id, plan(), "architect");
  assert.equal(revision.createdAt, "2026-10-10T12:00:00.000Z");
  const approval = store.recordApproval({ goalId: goal.id, revisionId: revision.id, approvedBy: "user", status: "APPROVED" });
  assert.equal(approval.ok && approval.approval.approvedAt, "2026-10-10T12:00:00.000Z");
  store.close();
});
