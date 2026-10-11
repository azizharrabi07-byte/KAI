// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Acceptance criteria have a SETTLEMENT PATH, or they are refused.
 *
 * The defect these pin was found by a live run: the planner produced *"the final
 * report states that all tests passed"* — prose no verifier can settle — and the
 * goal could then never complete even though the worker did its job and KAI
 * verified the bytes it could.
 *
 * Three behaviours are asserted here, at the real boundaries:
 *   1. the ARCHITECT refuses a plan containing an unsettleable criterion, naming
 *      it and the way to rewrite it;
 *   2. a `human review:` criterion is ACCEPTED, parks the goal on a person, and
 *      settles only on a recorded decision — never on an invented one;
 *   3. the classifier the architect refuses with and the gate settles with agree.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";

import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { createWorkBoard } from "../src/orchestration/board.ts";
import { createBenchmark } from "../src/orchestration/bench.ts";
import { createDispatcher } from "../src/orchestration/dispatch.ts";
import { createLearning } from "../src/orchestration/learn.ts";
import { createOrchestrator } from "../src/orchestration/orchestrator.ts";
import { createTrace } from "../src/orchestration/trace.ts";
import { createGoalArchitect } from "../src/goals/architect.ts";
import { createGoalExecutor, type GoalExecutor } from "../src/goals/executor.ts";
import { createGoalStore, type GoalStore } from "../src/goals/store.ts";
import { classifyCriterion, unsupportedCriteria } from "../src/goals/criteria.ts";
import { openSqliteStores, type Stores } from "../src/storage/sqlite.ts";
import { createCoreRuntime } from "../src/runtime.ts";
import type { GoalPlanContent } from "../src/goals/goal.ts";
import type { AutonomyPolicy } from "../src/orchestration/types.ts";

// ── 1. The classifier ────────────────────────────────────────────────────────

test("the classifier names a settlement path for every supported kind and refuses the rest", (t) => {
  const cases: { label: string; kind: string }[] = [
    { label: "file content equals: out.txt = hex:4f4b", kind: "file-content" },
    { label: 'file content equals: out.txt = "OK"', kind: "file-content" },
    { label: "file present: out.txt", kind: "file-present" },
    { label: "npm test", kind: "test-run" },
    { label: "node --test", kind: "test-run" },
    { label: "cargo test", kind: "test-run" },
    { label: "pytest -q", kind: "test-run" },
    { label: "human review: is the report honest and complete?", kind: "human-review" },
    // The exact label the live planner produced.
    { label: "the final report states that all tests passed", kind: "unsupported" },
    { label: "the code is clean and maintainable", kind: "unsupported" },
    // Prefixes that are malformed rather than merely unknown.
    { label: "file content equals: out.txt", kind: "unsupported" },
    { label: "file present:", kind: "unsupported" },
    { label: "human review:", kind: "unsupported" },
    { label: "npm test && rm -rf /", kind: "unsupported" },
    { label: "", kind: "unsupported" },
  ];
  for (const c of cases) {
    const got = classifyCriterion(c.label);
    assert.equal(got.kind, c.kind, `${JSON.stringify(c.label)} -> ${got.kind} (${got.reason})`);
    assert.ok(got.reason.length > 0, `${c.label}: every classification carries a reason`);
  }
  t.diagnostic(`classified ${cases.length} labels`);
});

test("an unsupported criterion's reason says how to rewrite it, not just that it is wrong", (t) => {
  const c = classifyCriterion("the final report states that all tests passed");
  assert.equal(c.kind, "unsupported");
  assert.match(c.reason, /file content equals:/, "the reason names a concrete alternative");
  assert.match(c.reason, /human review:/, "and the escape hatch for a genuine judgement call");
  t.diagnostic(c.reason);
});

// ── 2. The architect refuses what nothing can settle ─────────────────────────

function architectFor(text: string) {
  return createGoalArchitect({ runPlanner: async () => text });
}

function planJson(criteria: string[], taskCriteria?: string[]): string {
  return JSON.stringify({
    summary: "do the thing",
    deliverables: ["the thing"],
    tasks: [
      {
        id: "t1",
        title: "the task",
        objective: "produce the thing",
        dependsOn: [],
        role: "coding",
        acceptanceCriteria: taskCriteria ?? criteria,
        verification: (taskCriteria ?? criteria).map(() => "as specified"),
      },
    ],
    acceptanceCriteria: criteria,
    requiredEvidence: criteria,
    constraints: [],
    forbiddenOutcomes: [],
    authorizedWorkspace: [],
    assumptions: [],
    uncertainties: [],
    budgets: { maxTasks: 4, maxRetries: 1, maxDepth: 2 },
  });
}

test("a plan whose criterion has no settlement path is REFUSED, naming the criterion", async (t) => {
  const architect = architectFor(planJson(["the final report states that all tests passed"]));
  const result = await architect.planGoal({ goalId: "g1", intent: "write a report" });
  assert.equal(result.ok, false, "the plan must be refused");
  const reason = result.ok ? "" : result.reason;
  assert.match(reason, /no settlement path/, `got: ${reason}`);
  assert.match(reason, /final report states/, "the offending criterion is named verbatim");
  t.diagnostic(reason);
});

test("a plan with a settleable criterion and a human-review criterion is ACCEPTED", async (t) => {
  const architect = architectFor(
    planJson(["file content equals: out.txt = hex:4f4b", "human review: is the report honest?"]),
  );
  const result = await architect.planGoal({ goalId: "g2", intent: "produce out.txt and a report" });
  assert.equal(result.ok, true, result.ok ? "" : `refused: ${result.reason}`);
  if (result.ok) {
    assert.ok(result.content.acceptanceCriteria.length >= 2, "both criteria survive into the plan");
  }
  t.diagnostic("accepted: one machine-checkable, one human");
});

test("unsupportedCriteria finds only the unsettleable ones", () => {
  const found = unsupportedCriteria(["file present: a.txt", "npm test", "make it good", "human review: ok?"]);
  assert.deepEqual(found.map((c) => c.label), ["make it good"]);
});

// ── 3. The executor pauses for a person, and settles on the decision ─────────

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
  executor: GoalExecutor;
  dir: string;
  /** Artifacts the stubbed filesystem claims exist, for the workspace proof. */
  files: Set<string>;
  close(): void;
}

function harness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "kai-criteria-"));
  /** Artifacts the stubbed filesystem claims exist. */
  const files = new Set<string>();
  const stores = openSqliteStores({ path: join(dir, "kai.db") });
  const board = createWorkBoard(stores.workItems);
  const bench = createBenchmark(stores.workerProfiles);
  const orch = createOrchestrator({
    board,
    bench,
    dispatcher: createDispatcher({
      bench,
      availability: () => ["worker-1"],
      capabilities: () => ({ skills: [], tools: ["read"] }),
    }),
    trace: createTrace({ store: stores.activity, prefs: () => ({ activity: "OFF", reasoning: "SUMMARY" }) as const }),
    learning: createLearning({ metrics: stores.skillMetrics, validate: () => ({ ok: true }), stage: () => ({ ok: true }) }),
    patterns: stores.promptPatterns,
    reviewRunner: async () => ({ verdict: "PASS", findings: [] }),
    delegate: async () => ({ ok: true, reply: "STATUS: ok\nRESULT: done\nCHANGED ARTIFACTS: out.txt\nEVIDENCE: e\nTESTS: t\nBLOCKERS: (none)\nRISKS: n\nFOLLOW-UPS: n\nRECOMMENDED NEXT STEP: n\nTOOLS USED: read" }),
    skills: { relevant: () => [], load: () => ({ ok: false, reason: "none" }), inspect: () => null },
    policyCheck: async () => ({ outcome: "allow", reason: "test policy allows" }),
    approvals: { request: () => ({ id: "a1" }), get: () => ({ status: "APPROVED" }) },
    autonomy,
    publish: () => {},
    tools: { invoke: async () => ({ ok: true, result: {} }) },
    rememberLesson: () => ({ ok: true }),
  });
  const goals = createGoalStore({ path: join(dir, "goals.db") });
  const executor = createGoalExecutor({
    goals,
    board,
    runWorkItem: (id) => orch.runWorkItem(id),
    doerEnabled: () => true,
    maxParallel: () => 4,
    // The harness has no real artifacts, so the workspace proof is driven from the
    // same stub the gate uses — no test reads or writes the developer's disk.
    fileExists: (path) => files.has(path),
  });
  return {
    stores,
    goals,
    executor,
    dir,
    files,
    close() {
      goals.close();
      stores.close();
    },
  };
}

function approvedGoalWith(h: Harness, content: GoalPlanContent): string {
  const goal = h.goals.createGoal({ statement: "produce out.txt and a report", createdBy: "user" });
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
  return goal.id;
}

function humanPlan(criteria: string[]): GoalPlanContent {
  return {
    summary: "produce the artifact and judge the report",
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
    acceptanceCriteria: criteria,
    requiredEvidence: criteria,
    constraints: [],
    forbiddenOutcomes: [],
    authorizedWorkspace: ["."],
    assumptions: [],
    uncertainties: [],
    budgets: { maxTasks: 4, maxRetries: 1, maxDepth: 2 },
  };
}

test("a human-review criterion PARKS the goal on a person instead of blocking or inventing a verdict", async (t) => {
  const h = harness();
  t.after(() => {
    h.close();
    rmSync(h.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const criterion = "human review: is the report honest and complete?";
  const goalId = approvedGoalWith(h, humanPlan(["file present: out.txt", criterion]));

  // The machine-checkable criterion runs first (and its work item retries within
  // the budget), so the pause is only reachable once the work is terminal. Drive
  // the loop the way the Doer does.
  let report = await h.executor.advance(goalId);
  for (let i = 0; i < 6; i += 1) {
    if (h.goals.getGoal(goalId)?.state === "WAITING_USER") break;
    report = await h.executor.advance(goalId);
  }
  assert.equal(report.settled, undefined, "it must not settle while a person has not decided");
  assert.equal(h.goals.getGoal(goalId)?.state, "WAITING_USER", `the goal parks on the person (state ${h.goals.getGoal(goalId)?.state})`);
  assert.match(h.goals.getGoal(goalId)?.blocker ?? "", /waiting for a human decision/i);
  assert.equal(h.goals.getGoal(goalId)?.nextAction?.action, "ASK_USER", "and it says what is needed");
  t.diagnostic(`parked: ${h.goals.getGoal(goalId)?.blocker}`);

  // The decision is recorded (the route calls exactly this), then it settles.
  h.goals.setGoalFields(goalId, {
    humanDecisions: [{ criterion, decision: "MET", by: "user", at: new Date().toISOString(), note: "read it, it is fine" }],
  });
  h.goals.setGoalState(goalId, "RUNNING", "the human decision was recorded", "user");
  for (let i = 0; i < 4; i += 1) {
    await h.executor.advance(goalId);
    if (h.goals.getGoal(goalId)?.state === "COMPLETED") break;
  }
  const status = h.executor.status(goalId);
  const decided = status?.criteria.find((c) => c.criterion === criterion);
  assert.equal(decided?.met, true, `the human decision settles it: ${JSON.stringify(decided)}`);
  assert.match(decided?.detail ?? "", /decided by user/, "and the record names the person, never KAI");
});

test("a human decision of FAILED leaves the criterion unmet — it cannot be talked into MET", async (t) => {
  const h = harness();
  t.after(() => {
    h.close();
    rmSync(h.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const criterion = "human review: is the report honest and complete?";
  const goalId = approvedGoalWith(h, humanPlan(["file present: out.txt", criterion]));
  h.goals.setGoalFields(goalId, {
    humanDecisions: [{ criterion, decision: "FAILED", by: "user", at: new Date().toISOString(), note: "it omits the failures" }],
  });

  for (let i = 0; i < 4; i += 1) {
    await h.executor.advance(goalId);
    if (h.goals.getGoal(goalId)?.state === "BLOCKED") break;
  }
  const status = h.executor.status(goalId);
  const decided = status?.criteria.find((c) => c.criterion === criterion);
  assert.equal(decided?.met, false, "a FAILED decision is not a pass");
  assert.match(decided?.detail ?? "", /a human decided this is NOT met/);
  assert.notEqual(h.goals.getGoal(goalId)?.state, "COMPLETED", "the goal cannot complete on a failed criterion");
  t.diagnostic(`goal=${h.goals.getGoal(goalId)?.state} detail=${decided?.detail}`);
});


// ── 4. The workspace proof (a stale artifact must never satisfy a new goal) ──

test("a leftover artifact REFUSES the run instead of satisfying the criterion", async (t) => {
  // The live panel's objection, made concrete: an old journey.txt in a temp dir
  // must not be able to settle a criterion the current run never produced.
  const h = harness();
  t.after(() => {
    h.close();
    rmSync(h.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const content: GoalPlanContent = {
    ...humanPlan(["file present: out.txt"]),
    tasks: [
      { id: "t1", title: "t", objective: "o", dependsOn: [], role: "coding",
        acceptanceCriteria: ["file present: out.txt"], verification: ["file present: out.txt"] },
    ],
    acceptanceCriteria: ["file present: out.txt"],
    requiredEvidence: ["file present: out.txt"],
  };
  const goalId = approvedGoalWith(h, content);
  // The artifact is ALREADY there before dispatch.
  h.files.add(join(resolve("."), "out.txt"));

  const compiled = h.executor.compile(goalId);
  assert.equal(compiled.ok, false, "compilation must refuse");
  assert.match(compiled.ok ? "" : compiled.reason, /ALREADY EXISTS/, `got: ${compiled.ok ? "" : compiled.reason}`);
  t.diagnostic(compiled.ok ? "" : compiled.reason);
});

test("an artifact outside the authorized workspace is REFUSED", async (t) => {
  const h = harness();
  t.after(() => {
    h.close();
    rmSync(h.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const escaping = "file content equals: ../../outside.txt = hex:4f4b";
  const content: GoalPlanContent = {
    ...humanPlan([escaping]),
    tasks: [
      { id: "t1", title: "t", objective: "o", dependsOn: [], role: "coding",
        acceptanceCriteria: [escaping], verification: [escaping] },
    ],
    acceptanceCriteria: [escaping],
    requiredEvidence: [escaping],
  };
  const goalId = approvedGoalWith(h, content);
  const compiled = h.executor.compile(goalId);
  assert.equal(compiled.ok, false, "a traversal must be refused");
  assert.match(compiled.ok ? "" : compiled.reason, /OUTSIDE the authorized workspace/, `got: ${compiled.ok ? "" : compiled.reason}`);
  t.diagnostic(compiled.ok ? "" : compiled.reason);
});

test("a plan with no authorized workspace cannot be compiled at all", async (t) => {
  const h = harness();
  t.after(() => {
    h.close();
    rmSync(h.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const content: GoalPlanContent = { ...humanPlan(["file present: out.txt"]), authorizedWorkspace: [] };
  const goalId = approvedGoalWith(h, content);
  const compiled = h.executor.compile(goalId);
  assert.equal(compiled.ok, false);
  assert.match(compiled.ok ? "" : compiled.reason, /no authorized workspace/, `got: ${compiled.ok ? "" : compiled.reason}`);
});

test("a fresh workspace compiles, and the proof records the canonical paths", async (t) => {
  const h = harness();
  t.after(() => {
    h.close();
    rmSync(h.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const seen: { type: string; payload: unknown }[] = [];
  const executor = createGoalExecutor({
    goals: h.goals,
    board: createWorkBoard(h.stores.workItems),
    runWorkItem: async () => ({ state: "READY" }),
    doerEnabled: () => true,
    fileExists: () => false,
    emit: (type, payload) => seen.push({ type, payload }),
  });

  const content: GoalPlanContent = { ...humanPlan(["file present: out.txt"]), authorizedWorkspace: ["."] };
  const goalId = approvedGoalWith(h, content);
  const compiled = executor.compile(goalId);
  assert.equal(compiled.ok, true, compiled.ok ? "" : compiled.reason);
  const proof = seen.find((e) => e.type === "goal.workspace_verified");
  assert.ok(proof, "the proof is emitted with the run");
  const payload = proof?.payload as { workspace?: string; artifacts?: string[] };
  assert.equal(payload.workspace, resolve("."), "the canonical absolute workspace is recorded");
  assert.deepEqual(payload.artifacts, [join(resolve("."), "out.txt")], "and the resolved artifact path");
  t.diagnostic(`workspace=${payload.workspace} artifacts=${JSON.stringify(payload.artifacts)}`);
});


test("the workspace proof runs ONCE: a later compile does not refuse the artifact the run just created", async (t) => {
  // The bug this pins was introduced by the proof itself: it re-checked on every
  // compile, so as soon as the run created its artifact the proof refused and
  // `advance` never ran again — every retry was blocked and the goal stalled.
  const h = harness();
  t.after(() => {
    h.close();
    rmSync(h.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const content: GoalPlanContent = { ...humanPlan(["file present: out.txt"]), authorizedWorkspace: ["."] };
  const goalId = approvedGoalWith(h, content);

  // First compile: nothing exists yet, the proof passes.
  const first = h.executor.compile(goalId);
  assert.equal(first.ok, true, first.ok ? "" : first.reason);

  // The run then produces the artifact.
  h.files.add(join(resolve("."), "out.txt"));

  // Second compile (a retry): it must NOT refuse its own artifact.
  const second = h.executor.compile(goalId);
  assert.equal(second.ok, true, `a retry must not be refused by its own artifact: ${second.ok ? "" : second.reason}`);
  assert.equal(second.ok ? second.created : -1, 0, "and it creates nothing new");
  t.diagnostic("retry after artifact creation: allowed");
});


test("a plan-level criterion no task claims is ASSIGNED to a task, so it can be settled", async (t) => {
  // A criterion that exists only at plan level is never checked: the gate runs the
  // checks an ITEM requires. Found live — the model added one and the goal blocked
  // on it forever.
  const architect = createGoalArchitect({
    runPlanner: async () =>
      JSON.stringify({
        summary: "s",
        deliverables: ["d"],
        tasks: [
          { id: "t1", title: "t", objective: "o", dependsOn: [], role: "coding",
            acceptanceCriteria: ["file present: a.txt"], verification: ["file present: a.txt"] },
        ],
        acceptanceCriteria: ["file present: a.txt", "file content equals: b.txt = hex:4f4b"],
        requiredEvidence: [],
        constraints: [],
        forbiddenOutcomes: [],
        authorizedWorkspace: ["."],
        assumptions: [],
        uncertainties: [],
        budgets: { maxTasks: 4, maxRetries: 1, maxDepth: 2 },
      }),
  });
  const result = await architect.planGoal({ goalId: "g", intent: "produce a and b" });
  assert.equal(result.ok, true, result.ok ? "" : result.reason);
  if (!result.ok) return;
  const owned = new Set(result.content.tasks.flatMap((task) => task.acceptanceCriteria));
  for (const criterion of result.content.acceptanceCriteria) {
    assert.ok(owned.has(criterion), `plan-level criterion ${JSON.stringify(criterion)} must be owned by a task`);
  }
  const first = result.content.tasks[0];
  assert.ok(
    (first?.verification ?? []).some((v) => v.includes("file content equals: b.txt")),
    "and the assigned criterion gets a verification method",
  );
  t.diagnostic(`t1 now owns: ${JSON.stringify(first?.acceptanceCriteria)}`);
});


// ── 5. Lifecycle: terminal goals, and items a dead process left behind ──────

test("a COMPLETED goal dispatches nothing, even when advance is called again", async (t) => {
  const h = harness();
  t.after(() => {
    h.close();
    rmSync(h.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const content: GoalPlanContent = { ...humanPlan(["file present: out.txt"]), authorizedWorkspace: ["."] };
  const goalId = approvedGoalWith(h, content);
  // NOTE: the artifact is NOT pre-created. Doing so is exactly what the workspace
  // proof refuses — a leftover file must not satisfy a new goal.

  let calls = 0;
  const executor = createGoalExecutor({
    goals: h.goals,
    board: createWorkBoard(h.stores.workItems),
    // A stub worker that really settles the ITEM: the goal settles on the board's
    // state, so a stub that only returns a string would prove nothing.
    runWorkItem: async (id) => {
      calls += 1;
      const item = h.stores.workItems.get(id);
      if (item !== null) {
        h.stores.workItems.upsert({
          ...item,
          state: "COMPLETED",
          evidence: [
            { id: `ev_${id}_x`, kind: "check", source: "kai-observed", method: "test", detail: "observed", supports: ["file present: out.txt"], at: new Date().toISOString() },
          ],
          updatedAt: new Date().toISOString(),
        });
      }
      return { state: "COMPLETED" };
    },
    doerEnabled: () => true,
    fileExists: (path) => h.files.has(path),
  });

  for (let i = 0; i < 4; i += 1) {
    const r = await executor.advance(goalId);
    const st = executor.status(goalId);
    t.diagnostic(`pass ${i}: goal=${h.goals.getGoal(goalId)?.state} dispatched=${r.dispatched.length} reason=${String(r.reason ?? "")} notes=${JSON.stringify(r.notes)} items=${JSON.stringify(st?.items.map((x) => `${x.taskId}:${x.state}`))} criteria=${JSON.stringify(st?.criteria.map((c) => `${c.met ? "+" : "-"}${c.criterion}`))}`);
    if (h.goals.getGoal(goalId)?.state === "COMPLETED") break;
  }
  assert.equal(h.goals.getGoal(goalId)?.state, "COMPLETED", "the goal completed");
  const callsAtCompletion = calls;

  // A terminal goal must not dispatch again.
  const after = await executor.advance(goalId);
  assert.equal(after.dispatched.length, 0, "a completed goal dispatches nothing");
  assert.equal(calls, callsAtCompletion, "and it reaches no worker");
  assert.match(after.reason ?? "", /terminal goal dispatches nothing/);
  t.diagnostic(`goal=COMPLETED calls=${calls} → ${after.reason}`);
});

test("a work item a dead process left RUNNING is reconciled at startup, so its goal can settle", async (t) => {
  // Found by inspecting a real interrupted run: the item was RUNNING, the worker
  // process was gone, and the goal stayed RUNNING with nothing able to move it.
  const dir = mkdtempSync(join(tmpdir(), "kai-interrupt-"));
  const dbPath = join(dir, "kai.db");
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  // First process: leave an item in flight the way a crash would.
  const first = createCoreRuntime({
    dbPath,
    agents: { mode: "mock" },
    startScheduler: false,
    subsystemPaths: { runUpkeepOnStart: false },
  });
  const board = createWorkBoard(first.stores.workItems);
  const created = board.create({ objective: "the interrupted task", deliverable: "d" });
  assert.equal(created.ok, true);
  const id = created.ok ? created.value.id : "";
  assert.equal(board.claim(id, "worker-1").ok, true, "claimed");
  assert.equal(board.heartbeat(id, "step").ok, true, "running");
  assert.equal(board.get(id)?.state, "RUNNING");
  await first.stop();

  // Second process: startup reconciles it, and says so.
  const second = createCoreRuntime({
    dbPath,
    agents: { mode: "mock" },
    startScheduler: false,
    subsystemPaths: { runUpkeepOnStart: false },
  });
  const recovered = second.recoverWorkItems();
  assert.deepEqual(recovered.abandoned, [id], "the interrupted item was reconciled");
  const item = second.stores.workItems.get(id);
  assert.equal(item?.state, "BLOCKED", `an abandoned run must not stay RUNNING, got ${item?.state}`);
  assert.match((item?.failures ?? []).join(" "), /interrupted by a Core restart/, "and the reason is recorded");
  const notices = second.notifications.list().filter((n) => n.type === "work_item.interrupted");
  assert.ok(notices.length >= 1, "the user is told, rather than the item disappearing silently");
  await second.stop();
  t.diagnostic(`blocked ${id}: ${(item?.failures ?? [])[0]?.slice(0, 90)}`);
});
