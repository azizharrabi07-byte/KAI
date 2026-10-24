// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * End-to-end journeys: goal → approval → compile → dispatch → verify → settle.
 *
 * ── What is REAL here, and what is scripted ──────────────────────────────────
 * Real: the durable goal store, the plan/revision/approval records, the goal
 * executor (compilation, dependency ordering, settlement), the work board, the
 * orchestrator's whole dispatch path, the Outcome Gate, the evidence split and
 * the durable stores.
 *
 * Scripted: the EXTERNAL worker. `delegate` is the seam an adapter sits behind,
 * and the tool port stands in for the filesystem so a test does not depend on
 * the machine's disk. The gate still runs its real logic against those ports —
 * a criterion is met only when a `kai-observed` record supports it.
 *
 * So these are not "a mock proved a mock". They are the real executive loop with
 * a deterministic worker at the boundary, which is the only honest way to test
 * settlement without a live coding agent.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createWorkBoard, type WorkBoard } from "../src/orchestration/board.ts";
import { createBenchmark } from "../src/orchestration/bench.ts";
import { createDispatcher } from "../src/orchestration/dispatch.ts";
import { createLearning } from "../src/orchestration/learn.ts";
import { evaluatingDeps } from "./learn-eval-fixture.ts";
import { createOrchestrator, type DelegateInput, type DelegateResult, type Orchestrator } from "../src/orchestration/orchestrator.ts";
import { createTrace } from "../src/orchestration/trace.ts";
import { createGoalStore, type GoalStore } from "../src/goals/store.ts";
import { createGoalExecutor, type GoalExecutor } from "../src/goals/executor.ts";
import { openSqliteStores, type Stores } from "../src/storage/sqlite.ts";
import type { GoalPlanContent } from "../src/goals/goal.ts";
import type { AutonomyPolicy } from "../src/orchestration/types.ts";

// ── Fixtures ─────────────────────────────────────────────────────────────────

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

/** A worker reply naming the artifact it claims to have changed. */
function reply(deliverable: string, artifact: string): string {
  return [
    "STATUS: ok",
    `RESULT: Delivered ${deliverable}.`,
    `CHANGED ARTIFACTS: ${artifact}`,
    "EVIDENCE: the artifact is on disk",
    "TESTS: npm test — 12/12 passed",
    "BLOCKERS: (none)",
    "RISKS: none noted",
    "FOLLOW-UPS: none",
    "RECOMMENDED NEXT STEP: continue",
    "TOOLS USED: edit",
  ].join("\n");
}

function plan(tasks: GoalPlanContent["tasks"], criteria: string[]): GoalPlanContent {
  return {
    summary: "do the thing",
    deliverables: ["the thing"],
    tasks,
    acceptanceCriteria: criteria,
    requiredEvidence: criteria,
    constraints: ["stay inside the workspace"],
    forbiddenOutcomes: ["force-push"],
    authorizedWorkspace: ["."],
    assumptions: [],
    uncertainties: [],
    budgets: { maxTasks: 8, maxRetries: 1, maxDepth: 2 },
  };
}

interface Harness {
  stores: Stores;
  board: WorkBoard;
  orch: Orchestrator;
  goals: GoalStore;
  executor: GoalExecutor;
  dir: string;
  dbPath: string;
  /** Scripted worker results, consumed in order. */
  delegateQueue: DelegateResult[];
  delegateCalls: DelegateInput[];
  /** Artifacts that exist on disk, per the stubbed filesystem port. */
  present: Set<string>;
  /** Real file contents, so the CONTENT check can be exercised. */
  files: Map<string, string>;
  toolsCalled: string[];
  doerOn: boolean;
  close(): void;
}

function harness(opts: { dbPath?: string; dir?: string; goalsPath?: string } = {}): Harness {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "kai-goal-e2e-"));
  const dbPath = opts.dbPath ?? join(dir, "kai.db");
  const stores = openSqliteStores({ path: dbPath });
  const board = createWorkBoard(stores.workItems);
  const bench = createBenchmark(stores.workerProfiles);
  const dispatcher = createDispatcher({
    bench,
    availability: () => ["worker-1", "worker-2"],
    capabilities: () => ({ skills: ["typescript"], tools: ["read", "edit", "shell"] }),
  });
  const state = {
    delegateQueue: [] as DelegateResult[],
    delegateCalls: [] as DelegateInput[],
    present: new Set<string>(),
    files: new Map<string, string>(),
    toolsCalled: [] as string[],
    doerOn: true,
  };
  const orch = createOrchestrator({
    board,
    bench,
    dispatcher,
    trace: createTrace({ store: stores.activity, prefs: () => ({ activity: "VERBOSE", reasoning: "SUMMARY" }) as const }),
    learning: createLearning({ metrics: stores.skillMetrics, validate: () => ({ ok: true }), stage: () => ({ ok: true }), ...evaluatingDeps() }),
    patterns: stores.promptPatterns,
    reviewRunner: async () => ({ verdict: "PASS", findings: [] }),
    delegate: async (input: DelegateInput): Promise<DelegateResult> => {
      state.delegateCalls.push(input);
      return state.delegateQueue.shift() ?? { ok: true, reply: reply("the thing", "out.txt") };
    },
    skills: { relevant: () => [], load: () => ({ ok: false, reason: "none" }), inspect: () => null },
    policyCheck: async () => ({ outcome: "allow", reason: "test policy allows" }),
    approvals: { request: () => ({ id: "appr_1" }), get: () => ({ status: "PENDING" }) },
    autonomy: () => autonomy(),
    publish: () => {},
    tools: {
      invoke: async (id: string, input: unknown) => {
        state.toolsCalled.push(id);
        if (id === "filesystem.metadata") {
          const path = String((input as { path?: unknown }).path ?? "");
          const exists = state.present.has(path);
          return { ok: true, result: { exists, size: exists ? 42 : 0 } };
        }
        if (id === "filesystem.read") {
          const path = String((input as { path?: unknown }).path ?? "");
          if (!state.files.has(path)) return { ok: false, error: { code: "NOT_FOUND", message: `no file at ${path}` } };
          const text = state.files.get(path) as string;
          return { ok: true, result: { path, bytes: Buffer.from(text, "utf8").length, truncated: false, content: text } };
        }
        return { ok: true, result: {} };
      },
    },
    rememberLesson: () => ({ ok: true }),
  });

  const goals = createGoalStore({ path: opts.goalsPath ?? join(dir, "goals.db") });
  const executor = createGoalExecutor({
    goals,
    board,
    runWorkItem: (id) => orch.runWorkItem(id),
    doerEnabled: () => state.doerOn,
    maxParallel: () => 4,
    // Driven from the same stubbed filesystem the gate uses, so the workspace
    // proof and the evidence checks agree — and no test touches the real disk.
    fileExists: (path) => state.present.has(path) || state.files.has(path),
  });

  return {
    stores,
    board,
    orch,
    goals,
    executor,
    dir,
    dbPath,
    get delegateQueue() {
      return state.delegateQueue;
    },
    set delegateQueue(value: DelegateResult[]) {
      state.delegateQueue = value;
    },
    get delegateCalls() {
      return state.delegateCalls;
    },
    get present() {
      return state.present;
    },
    get files() {
      return state.files;
    },
    get toolsCalled() {
      return state.toolsCalled;
    },
    get doerOn() {
      return state.doerOn;
    },
    set doerOn(value: boolean) {
      state.doerOn = value;
    },
    close() {
      goals.close();
      stores.close();
    },
  };
}

/** Create a goal and take it all the way to an APPROVED revision. */
function approvedGoal(h: Harness, content: GoalPlanContent): string {
  const goal = h.goals.createGoal({ statement: "make the app faster", createdBy: "user" });
  h.goals.setGoalState(goal.id, "UNDERSTANDING", "intake", "user");
  h.goals.setGoalState(goal.id, "CHALLENGING", "challenge", "kai");
  h.goals.setGoalState(goal.id, "READY_FOR_PLAN", "challenge PASS", "kai");
  const revision = h.goals.addRevision(goal.id, content, "kai");
  h.goals.setGoalState(goal.id, "PLAN_PROPOSED", "plan proposed", "kai");
  h.goals.setGoalState(goal.id, "AWAITING_PLAN_APPROVAL", "awaiting approval", "user");
  const recorded = h.goals.recordApproval({
    goalId: goal.id,
    revisionId: revision.id,
    approvedBy: "user",
    status: "APPROVED",
    authorityScope: content.authorizedWorkspace,
    budgets: content.budgets,
  });
  assert.equal(recorded.ok, true, `approval recorded: ${JSON.stringify(recorded)}`);
  const moved = h.goals.setGoalState(goal.id, "APPROVED", "approved", "user");
  assert.equal(moved.ok, true, `approved: ${JSON.stringify(moved)}`);
  return goal.id;
}

/** Drive the executive until the goal settles or the bound is reached. */
async function runToSettle(h: Harness, goalId: string, passes = 8): Promise<string> {
  for (let pass = 0; pass < passes; pass += 1) {
    await h.executor.advance(goalId);
    const goal = h.goals.getGoal(goalId);
    if (goal !== null && ["COMPLETED", "BLOCKED", "FAILED", "CANCELLED"].includes(goal.state)) return goal.state;
  }
  return h.goals.getGoal(goalId)?.state ?? "UNKNOWN";
}

// ══ C. Successful autonomous execution ═══════════════════════════════════════

test("C: an approved plan compiles, dispatches in dependency order, verifies and settles COMPLETED", async (t) => {
  const h = harness();
  t.after(() => {
    h.close();
    rmSync(h.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const content = plan(
    [
      { id: "t1", title: "first", objective: "produce the first artifact", dependsOn: [], role: "coding", acceptanceCriteria: ["file present: out.txt"], verification: ["filesystem.metadata"] },
      { id: "t2", title: "second", objective: "produce the second artifact", dependsOn: ["t1"], role: "coding", acceptanceCriteria: ["file present: out2.txt"], verification: ["filesystem.metadata"] },
    ],
    ["file present: out.txt", "file present: out2.txt"],
  );
  const goalId = approvedGoal(h, content);

  // Both artifacts really exist in the workspace, so the gate can OBSERVE them.
  h.present.add(join(".", "out.txt"));
  h.present.add(join(".", "out2.txt"));
  h.delegateQueue = [
    { ok: true, reply: reply("first artifact", "out.txt") },
    { ok: true, reply: reply("second artifact", "out2.txt") },
  ];

  // Compilation is real and idempotent: the second call creates nothing.
  const first = h.executor.compile(goalId);
  assert.equal(first.ok, true);
  assert.equal(first.ok ? first.created : -1, 2, "both tasks became work items");
  const again = h.executor.compile(goalId);
  assert.equal(again.ok ? again.created : -1, 0, "recompiling the same revision creates nothing new");

  const settled = await runToSettle(h, goalId);
  assert.equal(settled, "COMPLETED", `the goal settled on verified criteria: ${JSON.stringify(h.executor.status(goalId))}`);

  const status = h.executor.status(goalId);
  assert.ok(status);
  assert.equal(status?.items.length, 2);
  assert.ok(status?.criteria.every((c) => c.met), "every criterion is backed by a KAI-observed record");
  assert.equal(status?.criteria.find((c) => c.criterion === "file present: out.txt")?.met, true);
  // Dependency order: t2 only ran after t1 completed.
  assert.equal(h.delegateCalls.length, 2, "exactly one worker dispatch per task");
  const order = status?.items.map((i) => i.taskId) ?? [];
  assert.deepEqual(order, ["t1", "t2"]);
  assert.equal(status?.items.find((i) => i.taskId === "t2")?.dependsOn.length, 1, "t2 records its dependency");
});

// ══ D. Failure and correction ════════════════════════════════════════════════

test("D: a failing worker produces a truthful blocker, never a completion", async (t) => {
  const h = harness();
  t.after(() => {
    h.close();
    rmSync(h.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const content = plan(
    [{ id: "t1", title: "only", objective: "produce the artifact", dependsOn: [], role: "coding", acceptanceCriteria: ["file present: out.txt"], verification: ["filesystem.metadata"] }],
    ["file present: out.txt"],
  );
  const goalId = approvedGoal(h, content);
  // The artifact does NOT exist, and the worker fails every attempt.
  h.delegateQueue = [
    { ok: false, error: "ECONNREFUSED 127.0.0.1:4096" },
    { ok: false, error: "ECONNREFUSED 127.0.0.1:4096" },
    { ok: false, error: "ECONNREFUSED 127.0.0.1:4096" },
  ];

  const settled = await runToSettle(h, goalId);
  assert.equal(settled, "BLOCKED", `an unverified goal is blocked, not completed: ${JSON.stringify(h.executor.status(goalId))}`);

  const goal = h.goals.getGoal(goalId);
  assert.match(goal?.blocker ?? "", /unverified/i, "the blocker names the unmet criteria");
  const status = h.executor.status(goalId);
  assert.ok(status?.criteria.every((c) => !c.met), "nothing was verified");
  assert.equal(status?.criteria[0]?.detail, "no evidence recorded");

  // Retries were bounded: the item consumed its attempts and stopped.
  const item = status?.items[0];
  assert.ok(item);
  assert.ok((item?.attempts ?? 0) <= 3, `retries are bounded, got ${item?.attempts}`);
  assert.notEqual(item?.state, "COMPLETED", "a failed worker never lands COMPLETED");
});

test("D2: a worker that CLAIMS success without the artifact is not verified", async (t) => {
  const h = harness();
  t.after(() => {
    h.close();
    rmSync(h.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const content = plan(
    [{ id: "t1", title: "only", objective: "produce the artifact", dependsOn: [], role: "coding", acceptanceCriteria: ["file present: out.txt"], verification: ["filesystem.metadata"] }],
    ["file present: out.txt"],
  );
  const goalId = approvedGoal(h, content);
  // The worker returns a confident handoff naming an artifact that is NOT there.
  h.delegateQueue = [{ ok: true, reply: reply("the artifact", "out.txt") }];

  const settled = await runToSettle(h, goalId);
  assert.equal(settled, "BLOCKED", "a claim is not proof");
  const status = h.executor.status(goalId);
  assert.equal(status?.criteria[0]?.met, false);
  // The gate really looked — and recorded what it found.
  assert.ok(h.toolsCalled.includes("filesystem.metadata"), "KAI actually checked the workspace");
});

// ══ E. Doer OFF ══════════════════════════════════════════════════════════════

test("E: with the Doer OFF nothing dispatches, and the durable rows simply wait", async (t) => {
  const h = harness();
  t.after(() => {
    h.close();
    rmSync(h.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const content = plan(
    [{ id: "t1", title: "only", objective: "produce the artifact", dependsOn: [], role: "coding", acceptanceCriteria: ["file present: out.txt"], verification: ["filesystem.metadata"] }],
    ["file present: out.txt"],
  );
  const goalId = approvedGoal(h, content);
  h.present.add(join(".", "out.txt"));
  h.delegateQueue = [{ ok: true, reply: reply("the artifact", "out.txt") }];

  h.doerOn = false;
  const report = await h.executor.advance(goalId);
  assert.equal(report.skipped, true, "OFF means the executive does not run");
  assert.equal(report.dispatched.length, 0);
  assert.equal(h.delegateCalls.length, 0, "no worker was dispatched");
  assert.equal(h.goals.getGoal(goalId)?.state, "APPROVED", "the goal is approved and paused, not running");

  // The approval and the plan are still there — nothing was discarded.
  assert.equal(h.goals.isApproved(goalId).approved, true);
  assert.ok(h.goals.currentRevision(goalId));
});

// ══ F. Doer ON resumes without duplicating ═══════════════════════════════════

test("F: turning the Doer ON resumes the approved plan without duplicating work", async (t) => {
  const h = harness();
  t.after(() => {
    h.close();
    rmSync(h.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const content = plan(
    [
      { id: "t1", title: "first", objective: "one", dependsOn: [], role: "coding", acceptanceCriteria: ["file present: out.txt"], verification: ["filesystem.metadata"] },
      { id: "t2", title: "second", objective: "two", dependsOn: [], role: "coding", acceptanceCriteria: ["file present: out2.txt"], verification: ["filesystem.metadata"] },
    ],
    ["file present: out.txt", "file present: out2.txt"],
  );
  const goalId = approvedGoal(h, content);
  h.present.add(join(".", "out.txt"));
  h.present.add(join(".", "out2.txt"));

  // Compile while OFF: work items exist, nothing has run.
  h.doerOn = false;
  assert.equal(h.executor.compile(goalId).ok, true);
  assert.equal(h.delegateCalls.length, 0);

  h.doerOn = true;
  h.delegateQueue = [
    { ok: true, reply: reply("one", "out.txt") },
    { ok: true, reply: reply("two", "out2.txt") },
  ];
  const settled = await runToSettle(h, goalId);
  assert.equal(settled, "COMPLETED");
  assert.equal(h.delegateCalls.length, 2, "each task was dispatched exactly once, not once per pass");

  // A further advance after settlement dispatches nothing and does not re-settle.
  const extra = await h.executor.advance(goalId);
  assert.equal(extra.dispatched.length, 0, "a settled goal dispatches nothing");
  assert.equal(h.delegateCalls.length, 2);
});

// ══ G. Restart recovery ══════════════════════════════════════════════════════

test("G: goals, revisions, approvals and work items survive a real close/reopen", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kai-goal-restart-"));
  const dbPath = join(dir, "kai.db");
  const goalsPath = join(dir, "goals.db");
  // ONE teardown, ordered: every store must be CLOSED before the directory is
  // removed, or Windows refuses the unlink of an open file.
  const open: { close(): void }[] = [];
  t.after(() => {
    for (const h of open.reverse()) {
      try {
        h.close();
      } catch {
        // A close that fails must not stop the cleanup.
      }
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  // ── First process: approve, compile, then stop before any dispatch ────────
  const first = harness({ dbPath, goalsPath, dir });
  open.push(first);
  const content = plan(
    [{ id: "t1", title: "only", objective: "produce the artifact", dependsOn: [], role: "coding", acceptanceCriteria: ["file present: out.txt"], verification: ["filesystem.metadata"] }],
    ["file present: out.txt"],
  );
  const goalId = approvedGoal(first, content);
  const compiled = first.executor.compile(goalId);
  assert.equal(compiled.ok, true);
  const itemId = compiled.ok ? compiled.workItemIds[0] : "";
  assert.ok(itemId);
  first.close();

  // ── Second process: the approval is still valid and the item is still READY
  const second = harness({ dbPath, goalsPath, dir });
  open.push(second);
  assert.equal(second.goals.isApproved(goalId).approved, true, "the approval survived the restart");
  assert.ok(second.goals.currentRevision(goalId), "the revision survived");
  assert.equal(second.board.get(itemId ?? "")?.state, "READY", "the work item survived and is still dispatchable");
  assert.equal(
    second.board.get(itemId ?? "")?.goalId,
    goalId,
    "and it is still linked to its goal (the linkage persisted)",
  );

  // Recompiling after the restart creates nothing — idempotent across processes.
  const recompiled = second.executor.compile(goalId);
  assert.equal(recompiled.ok ? recompiled.created : -1, 0, "compilation is idempotent across a restart");

  // And it can now run to completion.
  second.present.add(join(".", "out.txt"));
  second.delegateQueue = [{ ok: true, reply: reply("the artifact", "out.txt") }];
  assert.equal(await runToSettle(second, goalId), "COMPLETED");
});

test("G2: a material plan edit after approval makes the goal undispatchable again", async (t) => {
  const h = harness();
  t.after(() => {
    h.close();
    rmSync(h.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const content = plan(
    [{ id: "t1", title: "only", objective: "one", dependsOn: [], role: "coding", acceptanceCriteria: ["file present: out.txt"], verification: ["filesystem.metadata"] }],
    ["file present: out.txt"],
  );
  const goalId = approvedGoal(h, content);
  assert.equal(h.goals.isApproved(goalId).approved, true);

  // A MATERIAL change: a different criterion.
  const changed = plan(
    [{ id: "t1", title: "only", objective: "one", dependsOn: [], role: "coding", acceptanceCriteria: ["file present: DIFFERENT.txt"], verification: ["filesystem.metadata"] }],
    ["file present: DIFFERENT.txt"],
  );
  h.goals.addRevision(goalId, changed, "kai");
  assert.equal(h.goals.isApproved(goalId).approved, false, "the old approval no longer matches the current revision");

  h.present.add(join(".", "DIFFERENT.txt"));
  h.delegateQueue = [{ ok: true, reply: reply("the artifact", "DIFFERENT.txt") }];
  const report = await h.executor.advance(goalId);
  assert.equal(report.dispatched.length, 0, "a stale approval cannot dispatch");
  assert.equal(h.delegateCalls.length, 0, "no worker was reached");
  assert.match(report.reason ?? "", /not approved/i);
});


// ══ Content verification (the gap the live goal panel exposed) ═══════════════

test("a byte-exact content criterion is VERIFIED by KAI, and a trailing newline is caught", async (t) => {
  // The live challenge panel refused a presence-only criterion because it cannot
  // detect the single most likely defect: a file that is "OK\n" instead of "OK".
  // These two runs are that pair.
  const mk = (content: string) => {
    const h = harness();
    const planContent = plan(
      [{ id: "t1", title: "only", objective: "produce the artifact", dependsOn: [], role: "coding",
         acceptanceCriteria: ["file content equals: out.txt = hex:4f4b"], verification: ["filesystem.read"] }],
      ["file content equals: out.txt = hex:4f4b"],
    );
    h.present.add(join(".", "out.txt"));
    h.files.set(join(".", "out.txt"), content);
    h.delegateQueue = [{ ok: true, reply: reply("the artifact", "out.txt") }];
    return h;
  };

  // 1. Exactly the two bytes 4F 4B -> MET.
  const good = mk("OK");
  t.after(() => {
    good.close();
    rmSync(good.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const goodGoal = approvedGoal(good, plan(
    [{ id: "t1", title: "only", objective: "produce the artifact", dependsOn: [], role: "coding",
       acceptanceCriteria: ["file content equals: out.txt = hex:4f4b"], verification: ["filesystem.read"] }],
    ["file content equals: out.txt = hex:4f4b"],
  ));
  assert.equal(await runToSettle(good, goodGoal), "COMPLETED", "the exact bytes settle the criterion");
  assert.ok(good.toolsCalled.includes("filesystem.read"), "KAI read the file itself");

  // 2. A TRAILING NEWLINE (the exact defect the panel named) -> NOT met.
  const bad = mk("OK\n");
  t.after(() => {
    bad.close();
    rmSync(bad.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const badGoal = approvedGoal(bad, plan(
    [{ id: "t1", title: "only", objective: "produce the artifact", dependsOn: [], role: "coding",
       acceptanceCriteria: ["file content equals: out.txt = hex:4f4b"], verification: ["filesystem.read"] }],
    ["file content equals: out.txt = hex:4f4b"],
  ));
  assert.equal(await runToSettle(bad, badGoal), "BLOCKED", "3 bytes is not 2: the criterion is NOT met");
  const status = bad.executor.status(badGoal);
  assert.equal(status?.criteria[0]?.met, false);
  assert.match(status?.criteria[0]?.detail ?? "", /no evidence recorded|does NOT match/);
});

test("a content check on a missing file is not a pass, and a refused read is not a fact", async (t) => {
  const h = harness();
  t.after(() => {
    h.close();
    rmSync(h.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const content = plan(
    [{ id: "t1", title: "only", objective: "produce the artifact", dependsOn: [], role: "coding",
       acceptanceCriteria: ["file content equals: missing.txt = hex:4f4b"], verification: ["filesystem.read"] }],
    ["file content equals: missing.txt = hex:4f4b"],
  );
  const goalId = approvedGoal(h, content);
  h.delegateQueue = [{ ok: true, reply: reply("the artifact", "missing.txt") }];
  assert.equal(await runToSettle(h, goalId), "BLOCKED", "a file that is not there cannot satisfy a content criterion");
  assert.equal(h.executor.status(goalId)?.criteria[0]?.met, false);
});


test("a content check is byte-exact: CRLF, a BOM and a longer file all fail the hex:4f4b criterion", async (t) => {
  // The live panel objected that "the criterion fixes no measurement mode, so a
  // newline-normalising reader accepts the 3-byte file OK\n". These cases pin the
  // measurement mode: KAI compares the file's BYTES, so every near-miss fails.
  const cases: { label: string; content: string }[] = [
    { label: "trailing LF", content: "OK\n" },
    { label: "trailing CRLF", content: "OK\r\n" },
    { label: "leading BOM", content: "\ufeffOK" },
    { label: "extra byte", content: "OK!" },
    { label: "lowercase is different bytes", content: "ok" },
  ];
  for (const { label, content } of cases) {
    const h = harness();
    const criteria = ["file content equals: out.txt = hex:4f4b"];
    const planContent = plan(
      [{ id: "t1", title: "only", objective: "produce the artifact", dependsOn: [], role: "coding",
         acceptanceCriteria: criteria, verification: ["filesystem.read"] }],
      criteria,
    );
    const goalId = approvedGoal(h, planContent);
    h.present.add(join(".", "out.txt"));
    h.files.set(join(".", "out.txt"), content);
    h.delegateQueue = [{ ok: true, reply: reply("the artifact", "out.txt") }];
    const settled = await runToSettle(h, goalId);
    assert.equal(settled, "BLOCKED", `${label} must NOT satisfy the byte-exact criterion`);
    assert.equal(h.executor.status(goalId)?.criteria[0]?.met, false, `${label}: criterion must stay unmet`);
    h.close();
    rmSync(h.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});


test("a blocked prerequisite settles the goal BLOCKED instead of stranding its dependents", async (t) => {
  // Found in a LIVE run: one item blocked, three dependents sat READY forever and
  // the goal stayed RUNNING with nothing able to make progress.
  const h = harness();
  t.after(() => {
    h.close();
    rmSync(h.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const content = plan(
    [
      { id: "t1", title: "first", objective: "the prerequisite", dependsOn: [], role: "coding",
        acceptanceCriteria: ["file present: out.txt"], verification: ["filesystem.metadata"] },
      { id: "t2", title: "second", objective: "the dependent", dependsOn: ["t1"], role: "coding",
        acceptanceCriteria: ["file present: out2.txt"], verification: ["filesystem.metadata"] },
    ],
    ["file present: out.txt"],
  );
  const goalId = approvedGoal(h, content);
  // The artifact never appears and the worker keeps failing: t1 exhausts its budget.
  h.delegateQueue = [
    { ok: false, error: "worker unavailable" },
    { ok: false, error: "worker unavailable" },
    { ok: false, error: "worker unavailable" },
    { ok: false, error: "worker unavailable" },
  ];

  const settled = await runToSettle(h, goalId);
  assert.equal(settled, "BLOCKED", `a stranded chain must settle: ${JSON.stringify(h.executor.status(goalId)?.items)}`);
  const status = h.executor.status(goalId);
  // A worker that cannot be reached FAILS the item (vs BLOCKED when the retry
  // budget is spent). Both are terminal for settlement, which is the point here.
  assert.ok(
    ["BLOCKED", "FAILED"].includes(status?.items.find((i) => i.taskId === "t1")?.state ?? ""),
    `the prerequisite ended terminal, got ${status?.items.find((i) => i.taskId === "t1")?.state}`,
  );
  assert.equal(status?.items.find((i) => i.taskId === "t2")?.state, "READY", "the dependent never ran");
  assert.match(h.goals.getGoal(goalId)?.blocker ?? "", /prerequisite ended BLOCKED\/FAILED/);
  assert.ok(
    h.goals.getGoal(goalId)?.nextAction?.action === "ASK_USER",
    "and the blocker carries a next action for the user, so the stall is visible rather than silent",
  );
});
