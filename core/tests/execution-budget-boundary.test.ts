// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The execution budget at the REAL boundary.
 *
 * `execution-budget.test.ts` proves the ledger. This proves the WIRING: that
 * `runWorkItem` — the one boundary every dispatch passes through, whether it is
 * reached from the HTTP API, the slash command, the Doer drain, a corrective
 * child or an approval resume — consults the goal-wide allowance, so no caller
 * can bypass it by entering through a new door or by creating a new item.
 *
 * The attack this closes is the sibling multiplier. The per-item retry ledger
 * bounds ONE item, and `maxDepth` bounds how DEEP a corrective tree goes, but ten
 * children of one parent are all depth 1 — so a caller could spend unbounded
 * attempts while every item stayed inside its own limit.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createBenchmark } from "../src/orchestration/bench.ts";
import { createWorkBoard, type WorkBoard } from "../src/orchestration/board.ts";
import { createBudgetLedger } from "../src/orchestration/budget.ts";
import { createDispatcher } from "../src/orchestration/dispatch.ts";
import { createLearning } from "../src/orchestration/learn.ts";
import { evaluatingDeps } from "./learn-eval-fixture.ts";
import { createOrchestrator, type Orchestrator } from "../src/orchestration/orchestrator.ts";
import { createTrace } from "../src/orchestration/trace.ts";
import { createGoalStore, type GoalStore } from "../src/goals/store.ts";
import { openSqliteStores, type Stores } from "../src/storage/sqlite.ts";
import type { GoalPlanContent } from "../src/goals/goal.ts";
import type { AutonomyPolicy } from "../src/orchestration/types.ts";

function autonomy(): AutonomyPolicy {
  return {
    level: 3,
    workerAuto: "AUTO",
    review: "AUTO",
    skillLearning: "PROPOSE",
    budgets: { maxDepth: 2, maxRetries: 1 },
    maxDepth: 2,
    maxParallel: 4,
    taskRetentionDays: 30,
  };
}

interface Harness {
  stores: Stores;
  goals: GoalStore;
  board: WorkBoard;
  orch: Orchestrator;
  dir: string;
  close(): void;
}

/**
 * A harness whose delegate FAILS, so re-entry is legitimate: a FAILED item is
 * exactly the case a caller may retry, and exactly the case that used to be
 * unbounded across siblings.
 */
function harness(opts: { denyPolicy?: () => boolean } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "kai-budget-boundary-"));
  const stores = openSqliteStores({ path: join(dir, "kai.db") });
  const board = createWorkBoard(stores.workItems);
  const bench = createBenchmark(stores.workerProfiles);
  const goals = createGoalStore({ path: join(dir, "goals.db") });
  const budgetLedger = createBudgetLedger({ path: join(dir, "budget-ledger.db") });
  const orch = createOrchestrator({
    board,
    bench,
    dispatcher: createDispatcher({
      bench,
      availability: () => ["worker-1"],
      capabilities: () => ({ skills: [], tools: ["read"] }),
    }),
    trace: createTrace({ store: stores.activity, prefs: () => ({ activity: "OFF", reasoning: "SUMMARY" }) as const }),
    learning: createLearning({ metrics: stores.skillMetrics, validate: () => ({ ok: true }), stage: () => ({ ok: true }), ...evaluatingDeps() }),
    patterns: stores.promptPatterns,
    reviewRunner: async () => ({ verdict: "PASS", findings: [] }),
    delegate: async () => ({ ok: false, reply: "STATUS: failed\nRESULT: no\nBLOCKERS: nope" }),
    skills: { relevant: () => [], load: () => ({ ok: false, reason: "none" }), inspect: () => null },
    policyCheck: async () =>
      opts.denyPolicy?.() === true
        ? { outcome: "deny" as const, reason: "test policy denies delegation" }
        : { outcome: "allow" as const, reason: "test policy allows" },
    approvals: { request: () => ({ id: "a1" }), get: () => ({ status: "APPROVED" }) },
    autonomy,
    publish: () => {},
    tools: { invoke: async () => ({ ok: true, result: {} }) },
    rememberLesson: () => ({ ok: true }),
    budgetLedger,
    goalBudgetFor: (goalId, goalRevisionId) => {
      const approval = goals.isApproved(goalId);
      if (!approval.approved) return undefined;
      const revision = goalRevisionId !== undefined ? goals.getRevision(goalRevisionId) : approval.revision;
      return revision?.content.budgets;
    },
    goalGate: (goalId, goalRevisionId) => {
      const approval = goals.isApproved(goalId);
      if (!approval.approved) return { ok: false, reason: `the plan is not approved: ${approval.reason}` };
      if (goalRevisionId !== undefined && approval.revision !== undefined && approval.revision.id !== goalRevisionId) {
        return { ok: false, reason: "wrong revision" };
      }
      return { ok: true, reason: "approved" };
    },
  });
  return {
    stores,
    goals,
    board,
    orch,
    dir,
    close() {
      budgetLedger.close();
      goals.close();
      stores.close();
    },
  };
}

/** An approved goal. `maxTasks: 2, maxRetries: 1` → the revision may spend 4 dispatches. */
function approvedGoal(h: Harness, budgets: GoalPlanContent["budgets"]): { goalId: string; revisionId: string } {
  const content: GoalPlanContent = {
    summary: "produce out.txt",
    deliverables: ["out.txt"],
    tasks: [
      {
        id: "t1",
        title: "produce out.txt",
        objective: "produce out.txt",
        dependsOn: [],
        role: "coding",
        acceptanceCriteria: ["file present: out.txt"],
        verification: ["file present: out.txt"],
      },
    ],
    acceptanceCriteria: ["file present: out.txt"],
    requiredEvidence: ["file present: out.txt"],
    constraints: [],
    forbiddenOutcomes: [],
    authorizedWorkspace: ["."],
    assumptions: [],
    uncertainties: [],
    budgets,
  };
  const goal = h.goals.createGoal({ statement: "produce out.txt", createdBy: "user" });
  for (const state of ["UNDERSTANDING", "CHALLENGING", "READY_FOR_PLAN", "PLAN_PROPOSED", "AWAITING_PLAN_APPROVAL"] as const) {
    h.goals.setGoalState(goal.id, state, "test", "user");
  }
  const revision = h.goals.addRevision(goal.id, content, "kai");
  const recorded = h.goals.recordApproval({
    goalId: goal.id,
    revisionId: revision.id,
    approvedBy: "user",
    status: "APPROVED",
    authorityScope: content.authorizedWorkspace,
    budgets: content.budgets,
  });
  assert.equal(recorded.ok, true, `approval recorded: ${JSON.stringify(recorded)}`);
  h.goals.setGoalState(goal.id, "APPROVED", "approved", "user");
  return { goalId: goal.id, revisionId: revision.id };
}

function itemIn(h: Harness, goalId: string, revisionId: string, taskId: string, itemBudget?: { maxRetries: number }) {
  const made = h.board.create({
    objective: `attempt ${taskId}`,
    deliverable: "out.txt",
    taskId,
    goalId,
    goalRevisionId: revisionId,
    criteria: ["file present: out.txt"],
    requiredEvidence: ["file present: out.txt"],
    evidenceLinks: { "file present: out.txt": ["file present: out.txt"] },
    ...(itemBudget !== undefined ? { budget: itemBudget } : {}),
  });
  assert.equal(made.ok, true, `item created: ${JSON.stringify(made)}`);
  if (!made.ok) throw new Error("unreachable");
  return made.value.id;
}

test("THE SIBLING MULTIPLIER IS CLOSED: six new items in one revision share ONE allowance", async (t) => {
  const h = harness();
  t.after(() => {
    h.close();
    rmSync(h.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const { goalId, revisionId } = approvedGoal(h, { maxTasks: 2, maxRetries: 1, maxDepth: 2 });

  const outcomes: string[] = [];
  // Six DIFFERENT items, each with its own id and its own chain root — the shape
  // that defeated the per-item ledger.
  for (let i = 0; i < 6; i += 1) {
    const id = itemIn(h, goalId, revisionId, `t${i}`, { maxRetries: 10 });
    const outcome = await h.orch.runWorkItem(id);
    outcomes.push(outcome.state);
  }
  const dispatched = outcomes.filter((s) => s !== "BLOCKED").length;
  const refused = outcomes.filter((s) => s === "BLOCKED").length;
  assert.equal(dispatched, 4, `the revision's allowance was 4, across 6 different items: ${outcomes.join(",")}`);
  assert.equal(refused, 2, "the other two were refused, not silently allowed");
  t.diagnostic(`outcomes: ${outcomes.join(",")}`);
});

test("the refusal names the exact reason and blocks the item — never a silent stall", async (t) => {
  const h = harness();
  t.after(() => {
    h.close();
    rmSync(h.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const { goalId, revisionId } = approvedGoal(h, { maxTasks: 1, maxRetries: 0, maxDepth: 2 });

  const first = itemIn(h, goalId, revisionId, "t1");
  await h.orch.runWorkItem(first);
  const second = itemIn(h, goalId, revisionId, "t2");
  const refused = await h.orch.runWorkItem(second);

  assert.equal(refused.state, "BLOCKED");
  assert.match(refused.note, /budget exhausted: dispatch would reach 2 of 1/, refused.note);
  assert.match(refused.note, /never silently restored/, "the reason explains why the allowance will not come back");
  // The item is durably blocked WITH the reason, so the state is explainable
  // after the process that blocked it is gone.
  const stored = h.board.get(second);
  assert.equal(stored?.state, "BLOCKED");
  assert.ok(
    stored?.failures.some((f) => /budget exhausted/.test(f)),
    `the reason is persisted on the item: ${JSON.stringify(stored?.failures)}`,
  );
  t.diagnostic(refused.note);
});

test("re-entry through runWorkItem is bounded by the GOAL ceiling, not the item's", async (t) => {
  const h = harness();
  t.after(() => {
    h.close();
    rmSync(h.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const { goalId, revisionId } = approvedGoal(h, { maxTasks: 2, maxRetries: 1, maxDepth: 2 });
  // The item is given a GENEROUS retry allowance, so only the goal ceiling can
  // stop the loop. That is the whole point: the per-item counter is not enough.
  const id = itemIn(h, goalId, revisionId, "t1", { maxRetries: 50 });

  const states: string[] = [];
  for (let i = 0; i < 8; i += 1) {
    const outcome = await h.orch.runWorkItem(id);
    states.push(outcome.state);
  }
  const refused = states.filter((s) => s === "BLOCKED");
  assert.ok(refused.length >= 1, `the loop was stopped: ${states.join(",")}`);
  assert.ok(
    states.indexOf("BLOCKED") <= 4,
    `the goal ceiling (4) bound the loop before the item ceiling (50): ${states.join(",")}`,
  );
  t.diagnostic(`states: ${states.join(",")}`);
});

test("a redelivered resume event takes NO second debit", async (t) => {
  const h = harness();
  t.after(() => {
    h.close();
    rmSync(h.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  // TWO dispatches of allowance, so whether the duplicate spent one is visible.
  const { goalId, revisionId } = approvedGoal(h, { maxTasks: 2, maxRetries: 0, maxDepth: 2 });
  const id = itemIn(h, goalId, revisionId, "t1");

  // The same completion event, delivered twice.
  await h.orch.runWorkItem(id, { resumeEventId: "evt_1" });
  const second = await h.orch.runWorkItem(id, { resumeEventId: "evt_1" });
  assert.match(second.note, /duplicate delivery/, `the redelivery is a no-op: ${second.note}`);

  // And the allowance is still spendable, because the duplicate took nothing.
  // If it HAD spent one, this second dispatch would be refused.
  const next = itemIn(h, goalId, revisionId, "t2");
  const outcome = await h.orch.runWorkItem(next);
  assert.notEqual(outcome.state, "BLOCKED", `a duplicate must not burn the allowance: ${outcome.note}`);
});

test("a NEW plan revision is the only way to get a new allowance", async (t) => {
  const h = harness();
  t.after(() => {
    h.close();
    rmSync(h.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const { goalId, revisionId } = approvedGoal(h, { maxTasks: 1, maxRetries: 0, maxDepth: 2 });
  const first = itemIn(h, goalId, revisionId, "t1");
  await h.orch.runWorkItem(first);
  const refused = await h.orch.runWorkItem(itemIn(h, goalId, revisionId, "t2"));
  assert.equal(refused.state, "BLOCKED", "rev_1 is spent");

  // A replan: rev_2, approved by the user. That is a deliberate new allowance.
  const content = h.goals.getRevision(revisionId)?.content;
  assert.ok(content !== undefined);
  const rev2 = h.goals.addRevision(goalId, content, "kai");
  const recorded = h.goals.recordApproval({
    goalId,
    revisionId: rev2.id,
    approvedBy: "user",
    status: "APPROVED",
    authorityScope: content.authorizedWorkspace,
    budgets: content.budgets,
  });
  assert.equal(recorded.ok, true);
  const third = await h.orch.runWorkItem(itemIn(h, goalId, rev2.id, "t1"));
  assert.notEqual(third.state, "BLOCKED", `an approved replan restores the allowance: ${third.note}`);
});

test("an operation that provably never ran does NOT burn the allowance", async (t) => {
  let deny = true;
  const h = harness({ denyPolicy: () => deny });
  t.after(() => {
    h.close();
    rmSync(h.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  // Exactly ONE dispatch of allowance. If the denied attempt had burned it, the
  // second item could not dispatch at all.
  const { goalId, revisionId } = approvedGoal(h, { maxTasks: 1, maxRetries: 0, maxDepth: 2 });

  const denied = await h.orch.runWorkItem(itemIn(h, goalId, revisionId, "t1"));
  assert.equal(denied.state, "BLOCKED");
  assert.match(denied.note, /Policy denied delegation/, denied.note);

  // Policy now allows. The reservation from the denied attempt was REWOUND,
  // because the worker never ran — so the allowance is still there.
  deny = false;
  const allowed = await h.orch.runWorkItem(itemIn(h, goalId, revisionId, "t2"));
  assert.notEqual(
    allowed.state,
    "BLOCKED",
    `a denial before any effect must not consume the allowance: ${allowed.note}`,
  );
  assert.doesNotMatch(allowed.note, /budget exhausted/, "and it must not be refused for budget");
});
