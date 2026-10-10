// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Supervisor trust regression suite.
 *
 * The property under test, stated once: a worker's claim is not proof, a
 * reviewer's verdict is not proof by itself, and COMPLETED is reachable ONLY
 * through the Outcome Gate passing on evidence KAI itself observed and linked
 * to an exact criterion. Everything below is a way that property could be
 * broken, pinned by the failure it would produce.
 *
 * Two kinds of test live here, and they are labelled where they differ:
 *
 *  - INTEGRATION: the REAL orchestrator, board, bench, dispatcher, trace and
 *    learning over real (in-memory or temp-file) SQLite stores, with a
 *    scriptable delegate / reviewer / tools port standing in for the parts
 *    that would otherwise leave the process. Control flow is real.
 *  - UNIT: the pure gate functions (evaluateOutcome / criterionMet /
 *    verifyHandoff) called directly.
 *
 * A stub delegate cannot prove a real external worker works; nothing here
 * claims it does. It proves what the supervisor DOES with a worker's answer.
 *
 * Run from `core/`:  node --test tests/orch-supervisor-trust.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createWorkBoard, type BoardResult, type WorkBoard } from "../src/orchestration/board.ts";
import { createBenchmark } from "../src/orchestration/bench.ts";
import { createDispatcher } from "../src/orchestration/dispatch.ts";
import { createTrace } from "../src/orchestration/trace.ts";
import { createLearning } from "../src/orchestration/learn.ts";
import {
  createOrchestrator,
  type DelegateInput,
  type DelegateResult,
  type Orchestrator,
} from "../src/orchestration/orchestrator.ts";
import {
  createOutcomeContract,
  criterionMet,
  evaluateOutcome,
  type Observation,
} from "../src/orchestration/outcome.ts";
import type { AutonomyPolicy, ReviewVerdict, VerifiedEvidence, WorkerHandoff } from "../src/orchestration/types.ts";
import type { Mission, Stores } from "../src/shared/contracts.ts";
import { openSqliteStores } from "../src/storage/sqlite.ts";
import { createCoreRuntime } from "../src/runtime.ts";
import { createMissionSupervisor } from "../src/autonomy/supervisor.ts";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const OBJ = "Make the poller stop busy-waiting";
const DELIVERABLE = "the patched poller";

function baseAutonomy(level: AutonomyPolicy["level"] = 2, maxRetries = 2, maxReassignments?: number): AutonomyPolicy {
  return {
    level,
    workerAuto: "AUTO",
    review: "AUTO",
    skillLearning: "PROPOSE",
    budgets: {
      maxDepth: 2,
      maxRetries,
      ...(maxReassignments !== undefined ? { maxReassignments } : {}),
    },
    maxDepth: 2,
    maxParallel: 3,
    taskRetentionDays: 30,
  };
}

/** A worker reply whose CHANGED ARTIFACTS name `artifact`. */
function okReply(deliverable: string, artifact = "src/a.ts"): string {
  return [
    "STATUS: ok",
    `RESULT: Delivered ${deliverable}; the work is done.`,
    `CHANGED ARTIFACTS: ${artifact}`,
    "EVIDENCE: tests pass",
    "TESTS: npm test — 18/18 passed",
    "BLOCKERS: (none)",
    "RISKS: none noted",
    "FOLLOW-UPS: none",
    "RECOMMENDED NEXT STEP: ship it",
    "TOOLS USED: read, edit",
  ].join("\n");
}

function observed(id: string, supports: string[], detail = "established by KAI"): VerifiedEvidence {
  return {
    id,
    kind: "check",
    source: "kai-observed",
    method: "test-fixture",
    detail,
    supports,
    at: "2026-01-01T00:00:00.000Z",
  };
}

function reported(id: string, detail = "worker words"): VerifiedEvidence {
  return {
    id,
    kind: "worker claim",
    source: "worker-reported",
    method: "worker-handoff",
    detail,
    supports: [],
    at: "2026-01-01T00:00:00.000Z",
  };
}

function must<T>(res: BoardResult<T>): T {
  if (!res.ok) assert.fail(`expected ok, got: ${res.reason}`);
  return res.value;
}

/**
 * Wait for an OBSERVABLE condition, never for a duration. Supervision runs
 * fire-and-forget off the event bus, so a test that publishes a mission event
 * polls the recorded decision until it appears (bounded, with a clear message)
 * rather than sleeping a guessed number of milliseconds.
 */
async function until(predicate: () => boolean, label: string, attempts = 5000): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return;
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    await promise;
  }
  assert.fail(`timed out waiting for: ${label}`);
}

// ── The integration harness ───────────────────────────────────────────────────

interface ToolCall {
  id: string;
  input: unknown;
  opts?: { missionId?: string; turnId?: string; source?: string; approvalId?: string };
}

type ToolStub = (input: unknown, opts?: ToolCall["opts"]) => { ok: boolean; result?: unknown; error?: { code: string; message: string }; approvalId?: string };

interface HarnessState {
  autonomy: AutonomyPolicy;
  policyOutcome: "allow" | "deny" | "needs_approval";
  delegateQueue: DelegateResult[];
  delegateCalls: DelegateInput[];
  reviewQueue: { verdict: ReviewVerdict; findings: string[] }[];
  approvals: Map<string, string>;
  toolHandlers: Record<string, ToolStub>;
  toolCalls: ToolCall[];
  lessons: { scopeId: string; content: string; verified: string }[];
  lessonRefusal?: string;
  skillsRelevant: string[];
  skillBodies: Record<string, string>;
  skillMeta: Record<string, { version?: string; hash?: string }>;
}

interface Harness {
  orch: Orchestrator;
  board: WorkBoard;
  stores: Stores;
  published: { type: string; payload: unknown }[];
  state: HarnessState;
  close(): void;
}

function harness(opts: { level?: AutonomyPolicy["level"]; maxRetries?: number; maxReassignments?: number; dbPath?: string } = {}): Harness {
  const stores = openSqliteStores({ path: opts.dbPath ?? ":memory:" });
  const board = createWorkBoard(stores.workItems);
  const bench = createBenchmark(stores.workerProfiles);
  const dispatcher = createDispatcher({
    bench,
    availability: () => ["worker-1", "worker-2"],
    capabilities: () => ({ skills: ["typescript", "testing"], tools: ["read", "edit", "shell"] }),
  });
  const trace = createTrace({ store: stores.activity, prefs: () => ({ activity: "VERBOSE", reasoning: "SUMMARY" }) as const });
  const learning = createLearning({ metrics: stores.skillMetrics, validate: () => ({ ok: true }), stage: () => ({ ok: true }) });
  const published: { type: string; payload: unknown }[] = [];
  const state: HarnessState = {
    autonomy: baseAutonomy(opts.level ?? 2, opts.maxRetries ?? 2, opts.maxReassignments),
    policyOutcome: "allow",
    delegateQueue: [],
    delegateCalls: [],
    reviewQueue: [],
    approvals: new Map<string, string>(),
    toolHandlers: {},
    toolCalls: [],
    lessons: [],
    skillsRelevant: [],
    skillBodies: {},
    skillMeta: {},
  };
  let approvalSeq = 0;
  const orch = createOrchestrator({
    board,
    bench,
    dispatcher,
    trace,
    learning,
    patterns: stores.promptPatterns,
    reviewRunner: async () => state.reviewQueue.shift() ?? { verdict: "PASS", findings: [] },
    delegate: async (input: DelegateInput): Promise<DelegateResult> => {
      state.delegateCalls.push(input);
      return state.delegateQueue.shift() ?? { ok: true, reply: okReply(DELIVERABLE) };
    },
    skills: {
      relevant: (query: string, limit: number) => state.skillsRelevant.slice(0, limit).map((id) => ({ id })),
      load: (id: string) => (state.skillBodies[id] !== undefined ? { ok: true, name: id, body: state.skillBodies[id] as string } : { ok: false, reason: "not installed" }),
      inspect: (id: string) => state.skillMeta[id] ?? null,
    },
    policyCheck: async () => ({ outcome: state.policyOutcome, reason: `policy says ${state.policyOutcome}` }),
    approvals: {
      request: () => {
        approvalSeq += 1;
        const id = `appr_${approvalSeq}`;
        state.approvals.set(id, "PENDING");
        return { id };
      },
      get: (id: string) => {
        const status = state.approvals.get(id);
        return status === undefined ? null : { status };
      },
    },
    autonomy: () => state.autonomy,
    publish: (type: string, payload: unknown) => {
      published.push({ type, payload });
    },
    tools: {
      invoke: async (id, input, o) => {
        state.toolCalls.push({ id, input, ...(o !== undefined ? { opts: o } : {}) });
        const handler = state.toolHandlers[id];
        if (handler !== undefined) return handler(input, o);
        return { ok: true, result: {} };
      },
    },
    rememberLesson: (input) => {
      if (state.lessonRefusal !== undefined) return { ok: false, refusal: { reason: state.lessonRefusal } };
      state.lessons.push(input);
      return { ok: true };
    },
  });
  return { orch, board, stores, published, state, close: () => stores.close() };
}

/** The metadata handler used by artifact-existence tests. */
function metadataHandler(exists: boolean): ToolStub {
  return () => ({ ok: true, result: { exists, size: exists ? 123 : 0 } });
}

function shellHandler(exitCode: number, stdout = "", stderr = ""): ToolStub {
  return () => ({ ok: true, result: { exitCode, stdout, stderr } });
}

// ══ 1. False completion: a claimed artifact that is absent ════════════════════

test("1 false completion: a claimed artifact that is ABSENT on disk cannot complete", async () => {
  const h = harness();
  try {
    h.state.toolHandlers["filesystem.metadata"] = metadataHandler(false);
    const started = h.orch.startObjective(
      { objective: OBJ, deliverable: DELIVERABLE, requiredEvidence: ["file present: src/a.ts"], workingDir: "C:/tmp/project" },
      ["worker-1"],
    );
    assert.equal(started.planned, true);
    const out = await h.orch.runWorkItem(started.workItemId, { workerId: "worker-1" });
    assert.notEqual(out.state, "COMPLETED", "a worker's claim of a missing file must never complete");
    const item = h.board.get(started.workItemId);
    assert.notEqual(item?.state, "COMPLETED");
    const records = (item?.evidence ?? []).filter((r) => r.source === "kai-observed");
    assert.ok(records.some((r) => r.detail.includes("ABSENT")), `expected an ABSENT observation, got ${JSON.stringify(records)}`);
    assert.ok(records.every((r) => r.supports.length === 0), "an absent artifact settles nothing");
  } finally {
    h.close();
  }
});

test("1b the same run completes ONLY once KAI observes the artifact present", async () => {
  const h = harness();
  try {
    h.state.toolHandlers["filesystem.metadata"] = metadataHandler(true);
    const started = h.orch.startObjective(
      { objective: OBJ, deliverable: DELIVERABLE, requiredEvidence: ["file present: src/a.ts"], workingDir: "C:/tmp/project" },
      ["worker-1"],
    );
    const out = await h.orch.runWorkItem(started.workItemId, { workerId: "worker-1" });
    assert.equal(out.state, "COMPLETED", out.note);
    const item = h.board.get(started.workItemId);
    assert.ok((item?.evidence ?? []).some((r) => r.source === "kai-observed" && r.supports.length > 0));
  } finally {
    h.close();
  }
});

// ══ 1c. Evidence is scoped to the ITEM's workspace ═══════════════════════════

test("1c an artifact claim is checked inside the item's workspace, never KAI's own tree", async () => {
  const h = harness();
  try {
    const checked: string[] = [];
    h.state.toolHandlers["filesystem.metadata"] = (input) => {
      const record = input !== null && typeof input === "object" ? (input as { path?: unknown }) : {};
      checked.push(typeof record.path === "string" ? record.path : "");
      return { ok: true, result: { exists: true, size: 12 } };
    };

    // (a) No workspace: there is nothing to check against, so NO check runs and
    // the item cannot complete. Before this was scoped, KAI resolved the path
    // against its OWN working directory and recorded a positive observation for
    // work it had never inspected.
    const unscoped = h.orch.startObjective(
      { objective: OBJ, deliverable: DELIVERABLE, requiredEvidence: ["file present: src/a.ts"] },
      ["worker-1"],
    );
    await h.orch.runWorkItem(unscoped.workItemId, { workerId: "worker-1" });
    assert.deepEqual(checked, [], "an item with no workspace must not be checked against KAI's own tree");
    assert.notEqual(h.board.get(unscoped.workItemId)?.state, "COMPLETED", "an unscoped claim can never complete");
    const unscopedEvidence = (h.board.get(unscoped.workItemId)?.evidence ?? []).filter((r) => r.source === "kai-observed");
    assert.deepEqual(unscopedEvidence, [], "nothing may be observed without a workspace");

    // (b) With a workspace: the check resolves INSIDE it, and only then can a
    // present artifact satisfy the requirement.
    const scoped = h.orch.startObjective(
      { objective: OBJ, deliverable: DELIVERABLE, requiredEvidence: ["file present: src/a.ts"], workingDir: "C:/tmp/project" },
      ["worker-1"],
    );
    await h.orch.runWorkItem(scoped.workItemId, { workerId: "worker-1" });
    assert.ok(checked.length > 0, "a scoped item is checked");
    const inWorkspace = (p: string): boolean => p.replace(/\\/g, "/").startsWith("C:/tmp/project");
    assert.ok(
      checked.every(inWorkspace),
      `every checked path must live inside the item's workspace, got ${JSON.stringify(checked)}`,
    );
    assert.equal(h.board.get(scoped.workItemId)?.state, "COMPLETED", "a present artifact in the right workspace completes");
  } finally {
    h.close();
  }
});

// ══ 2. Unrun tests ════════════════════════════════════════════════════════════

test("2 unrun tests: a claimed test run with no execution record never satisfies", async () => {
  const h = harness();
  try {
    const started = h.orch.startObjective(
      { objective: OBJ, deliverable: DELIVERABLE, requiredEvidence: ["ci evidence for the fix"] },
      ["worker-1"],
    );
    const out = await h.orch.runWorkItem(started.workItemId, { workerId: "worker-1" });
    assert.notEqual(out.state, "COMPLETED", "claimed tests are not a test run");
    // The label matched no artifact and no safe command: recorded, not executed.
    assert.equal(h.state.toolCalls.filter((c) => c.id === "shell.run").length, 0, "nothing was executed for an unmatched label");
    const item = h.board.get(started.workItemId);
    const activity = h.orch.activityList({ workItemId: started.workItemId }, "VERBOSE");
    assert.ok(
      activity.some((e) => e.label.includes("Evidence unsupported")) || (item?.evidence ?? []).length === 0,
      "the unmatched requirement is visible, never silently dropped",
    );
  } finally {
    h.close();
  }
});

// ══ 3. Failing command ════════════════════════════════════════════════════════

test("3 failing command: KAI runs the real check, captures the failure, and does not pass", async () => {
  const h = harness();
  try {
    h.state.toolHandlers["shell.run"] = shellHandler(1, "", "2 tests failed");
    const started = h.orch.startObjective(
      { objective: OBJ, deliverable: DELIVERABLE, successCriteria: ["tests pass"], requiredEvidence: ["npm test"], workingDir: "C:/tmp/project" },
      ["worker-1"],
    );
    // First run parks the guarded shell check for approval.
    const first = await h.orch.runWorkItem(started.workItemId, { workerId: "worker-1" });
    assert.equal(first.state, "WAITING", first.note);
    assert.ok(first.parkedApprovalId !== undefined);
    // Approve: the check now RUNS for real and fails.
    const decided = await h.orch.onApprovalDecided(first.parkedApprovalId as string, true);
    assert.ok(decided.handled >= 1);
    const item = h.board.get(started.workItemId);
    assert.notEqual(item?.state, "COMPLETED", "a failing check must not complete the item");
    const executed = (item?.evidence ?? []).filter((r) => r.command !== undefined);
    assert.ok(executed.length >= 1, "the check left an execution record");
    assert.ok(executed.some((r) => r.exitCode === 1), `expected exitCode 1, got ${JSON.stringify(executed.map((r) => r.exitCode))}`);
    assert.ok(executed.every((r) => r.supports.length === 0), "a failing check settles nothing");
    assert.ok(executed.some((r) => (r.outputPreview ?? "").includes("2 tests failed")), "the failing output is retained");
  } finally {
    h.close();
  }
});

// ══ 4. Keyword attack ═════════════════════════════════════════════════════════

const CONTRACT = createOutcomeContract({
  missionId: "m",
  intent: "the poller must not busy-wait on an empty queue",
  deliverables: ["patched poller"],
  acceptanceCriteria: ["the poller must not busy-wait on an empty queue"],
  requiredEvidence: ["test output"],
  forbiddenOutcomes: ["force-push"],
});

test("4 keyword attack: a keyword in prose cannot satisfy a complex criterion", () => {
  const prose = "I fixed the poller busy-wait; queue empty handling now sleeps; test output looks great. poller queue empty busy-wait sleep";
  const d = evaluateOutcome(CONTRACT, {
    deliverable: prose,
    evidence: [reported("ev_w1", prose)],
    criteriaMet: {},
  });
  assert.equal(d.result, "INSUFFICIENT_EVIDENCE", d.reason);
  assert.deepEqual(d.missingEvidence, ["test output"]);
  assert.equal(
    criterionMet(CONTRACT, "the poller must not busy-wait on an empty queue", [reported("ev_w1", prose)]),
    false,
    "worker prose NEVER satisfies a criterion",
  );
  // And no substring/token path exists: an observed record for a DIFFERENT
  // label does not leak satisfaction into this one.
  assert.equal(
    criterionMet(CONTRACT, "the poller must not busy-wait on an empty queue", [observed("ev_x", ["something else"], prose)]),
    false,
  );
});

// ══ 5. Multi-criterion enforcement ════════════════════════════════════════════

test("5 multi-criterion: every required criterion must pass under all_criteria", () => {
  const contract = createOutcomeContract({
    missionId: "m2",
    intent: "two independent criteria",
    acceptanceCriteria: ["criterion one", "criterion two"],
    requiredEvidence: ["evidence one", "evidence two"],
    evidenceLinks: { "criterion one": ["evidence one"], "criterion two": ["evidence two"] },
  });
  assert.equal(contract.completionPolicy, "all_criteria", "the default is strict all-criteria");
  const onlyOne: Observation = {
    deliverable: "delivered",
    evidence: [observed("ev_1", ["evidence one"])],
    criteriaMet: {
      "criterion one": criterionMet(contract, "criterion one", [observed("ev_1", ["evidence one"])]),
      "criterion two": criterionMet(contract, "criterion two", [observed("ev_1", ["evidence one"])]),
    },
  };
  const d = evaluateOutcome(contract, onlyOne);
  assert.notEqual(d.result, "PASS", "one of two criteria is not enough");
  assert.deepEqual(d.unmetCriteria, ["criterion two"]);
  // Both satisfied: PASS.
  const both = evaluateOutcome(contract, {
    deliverable: "delivered",
    evidence: [observed("ev_1", ["evidence one"]), observed("ev_2", ["evidence two"])],
    criteriaMet: { "criterion one": true, "criterion two": true },
  });
  assert.equal(both.result, "PASS", both.reason);
});

// ══ 6. Persistence across storage and reload ══════════════════════════════════

test("6 persistence: acceptance criteria, constraints, forbidden outcomes, evidence and budget survive reload", () => {
  const dir = mkdtempSync(join(tmpdir(), "kai-trust-persist-"));
  const dbPath = join(dir, "core.db");
  try {
    const stores = openSqliteStores({ path: dbPath });
    const board = createWorkBoard(stores.workItems);
    const created = must(
      board.create({
        objective: OBJ,
        deliverable: DELIVERABLE,
        criteria: ["tests pass", "no unrelated files changed"],
        constraints: ["stay in src/"],
        forbiddenOutcomes: ["force-push"],
        requiredEvidence: ["test output"],
        evidenceLinks: { "tests pass": ["test output"] },
        workingDir: "C:/tmp/project",
        budget: { maxRetries: 1, maxDepth: 2 },
      }),
    );
    must(
      board.recordEvidence(created.id, [
        observed("ev_1", ["test output"], "18/18 passed"),
        reported("ev_w", "worker claims"),
      ]),
    );
    stores.close();

    // Reopen: a NEW store + board over the same file (a restart).
    const stores2 = openSqliteStores({ path: dbPath });
    const board2 = createWorkBoard(stores2.workItems);
    try {
      const item = board2.get(created.id);
      assert.ok(item !== null);
      assert.deepEqual(item?.criteria, ["tests pass", "no unrelated files changed"]);
      assert.deepEqual(item?.constraints, ["stay in src/"]);
      assert.deepEqual(item?.forbiddenOutcomes, ["force-push"]);
      assert.deepEqual(item?.requiredEvidence, ["test output"]);
      assert.deepEqual(item?.evidenceLinks, { "tests pass": ["test output"] });
      assert.equal(item?.workingDir, "C:/tmp/project");
      assert.deepEqual(item?.budget, { maxRetries: 1, maxDepth: 2 });
      assert.equal((item?.evidence ?? []).length, 2, "both the observed and the reported record survived");
      assert.equal((item?.evidence ?? []).filter((r) => r.source === "kai-observed").length, 1);
      // And the gate evaluates the reloaded evidence identically.
      const gate = evaluateOutcome(
        createOutcomeContract({
          missionId: "m",
          intent: OBJ,
          deliverables: [DELIVERABLE],
          acceptanceCriteria: item?.criteria ?? [],
          requiredEvidence: item?.requiredEvidence ?? [],
          evidenceLinks: item?.evidenceLinks,
        }),
        {
          deliverable: "delivered",
          evidence: item?.evidence ?? [],
          criteriaMet: { "tests pass": true, "no unrelated files changed": false },
        },
      );
      assert.notEqual(gate.result, "PASS", "the reloaded contract still refuses an unmet criterion");
    } finally {
      stores2.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("6b older rows without the v4 fields read back normalized, never crashing", () => {
  const dir = mkdtempSync(join(tmpdir(), "kai-trust-oldrow-"));
  const dbPath = join(dir, "core.db");
  try {
    const stores = openSqliteStores({ path: dbPath });
    // Write a pre-v4-shaped row directly: the v4 columns left NULL.
    stores.workItems.upsert({
      id: "work_legacy",
      objective: "legacy row",
      skills: [],
      tools: [],
      state: "READY",
      attempts: 0,
      heartbeats: [],
      failures: [],
      retries: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const board = createWorkBoard(stores.workItems);
    const item = board.get("work_legacy");
    assert.ok(item !== null);
    assert.deepEqual(item?.criteria, []);
    assert.deepEqual(item?.constraints, []);
    assert.deepEqual(item?.forbiddenOutcomes, []);
    assert.deepEqual(item?.requiredEvidence, []);
    assert.deepEqual(item?.evidence, []);
    assert.deepEqual(item?.skillReceipts, []);
    assert.equal(item?.workingDir, undefined);
    stores.close();
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// ══ 7 & 8. Success and failure supervision, through the REAL runtime ═════════

function bootRuntime(dir: string) {
  const runtime = createCoreRuntime({
    dbPath: join(dir, "core.db"),
    agents: { mode: "mock" },
    startScheduler: false,
    subsystemPaths: { runUpkeepOnStart: false, ledgerPath: join(dir, "ledger.db") },
  });
  // These tests exercise the AUTONOMOUS supervision loop, which is the KAI Doer:
  // a fresh Core starts with the Doer OFF, so a test that means to prove the loop
  // works must switch it on — exactly as a user would.
  runtime.stores.settings.set("orchestration.doer", "ON", new Date().toISOString());
  return runtime;
}

function missionFixture(status: "COMPLETED" | "FAILED", id: string, stepStatus = "COMPLETED", code: "AGENT_TIMEOUT" | "POLICY_DENIED" = "AGENT_TIMEOUT"): Mission {
  const ts = "2026-01-01T00:00:00.000Z";
  return {
    id,
    title: "a supervised mission",
    status,
    priority: 0,
    createdAt: ts,
    updatedAt: ts,
    steps: [
      { id: "s0", missionId: id, index: 0, title: "do it", kind: "tool", status: stepStatus, sideEffecting: false, target: "filesystem.read" },
    ],
    ...(status === "FAILED"
      ? { error: { code, message: "timed out", retryable: true, at: ts } }
      : {}),
  };
}

test("7 success supervision: a completed mission is verified and a provenanced lesson recorded", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kai-trust-success-"));
  const runtime = bootRuntime(dir);
  try {
    await runtime.start();
    const mission = missionFixture("COMPLETED", "mission_ok");
    runtime.stores.missions.upsertMission(mission);
    runtime.bus.publish("mission.completed", { missionId: mission.id }, { source: "test", missionId: mission.id });
    const decisionsFor = () => runtime.autonomyDecisions().filter((d) => d.missionId === mission.id);
    await until(() => decisionsFor().length >= 1, "the completion to be observed without another user message");
    const decisions = decisionsFor();
    assert.ok(decisions.some((d) => d.reason.includes("lesson recorded")), `expected a lesson-recording decision, got ${JSON.stringify(decisions.map((d) => d.reason))}`);
    // The lesson is really in mission-scoped memory, with a verified basis.
    const hits = runtime.recallForMission(mission.id);
    assert.ok(hits.length >= 1, "the provenanced lesson is recallable in the mission scope");
  } finally {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("7b an inconsistent COMPLETED mission escalates instead of silently passing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kai-trust-inconsistent-"));
  const runtime = bootRuntime(dir);
  try {
    await runtime.start();
    const mission = missionFixture("COMPLETED", "mission_bad", "FAILED");
    runtime.stores.missions.upsertMission(mission);
    runtime.bus.publish("mission.completed", { missionId: mission.id }, { source: "test", missionId: mission.id });
    const decisionsFor = () => runtime.autonomyDecisions().filter((d) => d.missionId === mission.id);
    await until(() => decisionsFor().some((d) => d.action === "escalate"), "the inconsistency to be escalated");
    assert.equal(runtime.recallForMission(mission.id).length, 0, "a contradiction is never saved as a lesson");
  } finally {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("8 failure supervision: a genuine, non-transient failure is evaluated and bounded (no retry)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kai-trust-failure-"));
  const runtime = bootRuntime(dir);
  try {
    await runtime.start();
    const mission = missionFixture("FAILED", "mission_fail", "FAILED", "POLICY_DENIED");
    runtime.stores.missions.upsertMission(mission);
    const missionsBefore = runtime.stores.missions.listUnfinishedMissions().length;
    runtime.bus.publish("mission.failed", { missionId: mission.id }, { source: "test", missionId: mission.id });
    const decisionsFor = () => runtime.autonomyDecisions().filter((d) => d.missionId === mission.id);
    await until(() => decisionsFor().length >= 1, "the settled failure to be evaluated without a user prompt");
    const decision = decisionsFor()[0];
    assert.ok(decision !== undefined);
    assert.notEqual(decision.action, "retry", "a policy denial is not transient: retrying would ignore the answer KAI already has");
    assert.match(decision.reason, /not transient|POLICY_DENIED/i);
    assert.equal(
      runtime.stores.missions.listUnfinishedMissions().length,
      missionsBefore,
      "a non-transient failure starts no new work",
    );
  } finally {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// ══ 9. Corrective execution ═══════════════════════════════════════════════════

test("9 corrective execution: an evidence round runs, collects and re-evaluates to a real PASS", async () => {
  const h = harness();
  try {
    h.state.toolHandlers["shell.run"] = shellHandler(0, "18/18 passed", "");
    const started = h.orch.startObjective(
      { objective: OBJ, deliverable: DELIVERABLE, successCriteria: ["tests pass"], requiredEvidence: ["npm test"], workingDir: "C:/tmp/project" },
      ["worker-1"],
    );
    const parked = await h.orch.runWorkItem(started.workItemId, { workerId: "worker-1" });
    assert.equal(parked.state, "WAITING", "the guarded check parks visibly, never stalls silently");
    const item = h.board.get(started.workItemId);
    const outputs = (item?.outputs ?? {}) as { nextAction?: { action?: string; state?: string } };
    assert.ok(outputs.nextAction !== undefined, "the corrective action is recorded durably");
    assert.equal(outputs.nextAction?.state, "waiting-approval");
    const decided = await h.orch.onApprovalDecided(parked.parkedApprovalId as string, true);
    assert.ok(decided.handled >= 1, "the approval resumes exactly this item");
    assert.equal(h.board.get(started.workItemId)?.state, "COMPLETED", "real evidence flowing in completes it through the Gate");
    assert.ok(h.state.delegateCalls.length >= 1, "exactly one delegation was needed — evidence gathering is not a re-delegation");
  } finally {
    h.close();
  }
});

test("9b corrective execution never stalls: an unsettable requirement is recorded and parked with its reason", async () => {
  const h = harness();
  try {
    const started = h.orch.startObjective(
      { objective: OBJ, deliverable: DELIVERABLE, requiredEvidence: ["a human signed off on the UX"] },
      ["worker-1"],
    );
    const out = await h.orch.runWorkItem(started.workItemId, { workerId: "worker-1" });
    assert.notEqual(out.state, "COMPLETED");
    assert.ok(out.note.length > 0, "the outcome explains itself");
    const item = h.board.get(started.workItemId);
    const outputs = (item?.outputs ?? {}) as { nextAction?: { reason?: string; state?: string } };
    assert.ok(outputs.nextAction !== undefined, "the blocker is durably recorded, not left as a mystery state");
    assert.ok((outputs.nextAction?.reason ?? "").length > 0);
  } finally {
    h.close();
  }
});

// ══ 10. Idempotency ═══════════════════════════════════════════════════════════

test("10 idempotency: duplicate resume keys cannot double-execute", async () => {
  const h = harness();
  try {
    h.state.toolHandlers["filesystem.metadata"] = metadataHandler(true);
    const started = h.orch.startObjective({ objective: OBJ, deliverable: DELIVERABLE, requiredEvidence: ["file present: src/a.ts"], workingDir: "C:/tmp/project" }, ["worker-1"]);
    const first = await h.orch.runWorkItem(started.workItemId, { workerId: "worker-1", resumeEventId: "evt_1" });
    assert.equal(first.state, "COMPLETED");
    const delegatesAfterFirst = h.state.delegateCalls.length;
    // Redeliver the SAME trigger: a no-op, never a second worker execution.
    const again = await h.orch.runWorkItem(started.workItemId, { workerId: "worker-1", resumeEventId: "evt_1" });
    assert.match(again.note, /duplicate delivery/, again.note);
    assert.equal(h.state.delegateCalls.length, delegatesAfterFirst, "a duplicate event must not dispatch again");
  } finally {
    h.close();
  }
});

test("10b a settled item refuses re-running at the board boundary", async () => {
  const h = harness();
  try {
    h.state.toolHandlers["filesystem.metadata"] = metadataHandler(true);
    const started = h.orch.startObjective({ objective: OBJ, deliverable: DELIVERABLE, requiredEvidence: ["file present: src/a.ts"], workingDir: "C:/tmp/project" }, ["worker-1"]);
    await h.orch.runWorkItem(started.workItemId, { workerId: "worker-1" });
    const delegates = h.state.delegateCalls.length;
    const rerun = await h.orch.runWorkItem(started.workItemId, { workerId: "worker-1" });
    // Re-running a settled item is a no-op that REPORTS the settled state.
    assert.equal(rerun.state, "COMPLETED", "the item is unchanged by a refused re-run");
    assert.match(rerun.note, /already COMPLETED|create a new item/i, rerun.note);
    assert.equal(h.state.delegateCalls.length, delegates, "a COMPLETED item is not re-dispatched");
    // And out-of-order/unknown ids are honest no-ops.
    const unknown = await h.orch.runWorkItem("work_nope", { workerId: "worker-1" });
    assert.equal(unknown.state, "UNKNOWN");
  } finally {
    h.close();
  }
});

// ══ 11. Safe recovery across a restart ════════════════════════════════════════

test("11 safe recovery: a parked item resumes once after restart; a settled item never replays", async () => {
  const h = harness();
  try {
    h.state.toolHandlers["shell.run"] = shellHandler(1, "", "still failing");
    const started = h.orch.startObjective(
      { objective: OBJ, deliverable: DELIVERABLE, successCriteria: ["tests pass"], requiredEvidence: ["npm test"] },
      ["worker-1"],
    );
    const parked = await h.orch.runWorkItem(started.workItemId, { workerId: "worker-1" });
    assert.equal(parked.state, "WAITING");
    const approvalId = parked.parkedApprovalId as string;
    const item = h.board.get(started.workItemId);
    assert.ok(item !== null);
    // A fresh orchestrator over the SAME stores = a Core restart.
    const orch2 = h.orch;
    const resumed = await orch2.onApprovalDecided(approvalId, true);
    assert.ok(resumed.handled >= 1, "the parked item is found from persisted state, not memory");
    // Re-delivering the same approval is a no-op (its resume key is recorded).
    const again = await orch2.onApprovalDecided(approvalId, true);
    assert.equal(again.handled, 0, "a settled approval cannot resume the same item twice");
    // The failing check kept it from completing; nothing was blindly replayed
    // to a PASS.
    assert.notEqual(h.board.get(started.workItemId)?.state, "COMPLETED");
  } finally {
    h.close();
  }
});

// ══ 12. Approval lifecycle ════════════════════════════════════════════════════

test("12 approval lifecycle: rejected never executes; a new action needs a fresh approval", async () => {
  const h = harness();
  try {
    h.state.toolHandlers["shell.run"] = shellHandler(0, "ok", "");
    const started = h.orch.startObjective(
      { objective: OBJ, deliverable: DELIVERABLE, successCriteria: ["tests pass"], requiredEvidence: ["npm test"] },
      ["worker-1"],
    );
    const parked = await h.orch.runWorkItem(started.workItemId, { workerId: "worker-1" });
    assert.equal(parked.state, "WAITING");
    const approvalId = parked.parkedApprovalId as string;
    const shellBefore = h.state.toolCalls.filter((c) => c.id === "shell.run").length;
    const rejected = await h.orch.onApprovalDecided(approvalId, false);
    assert.ok(rejected.handled >= 1);
    assert.equal(h.board.get(started.workItemId)?.state, "CANCELLED", "a rejection cancels, it never executes");
    assert.equal(h.state.toolCalls.filter((c) => c.id === "shell.run").length, shellBefore, "the protected action never ran on a rejection");
  } finally {
    h.close();
  }
});

test("12b a decided approval is final: it cannot be spent a second time", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kai-trust-approval-"));
  const runtime = bootRuntime(dir);
  try {
    await runtime.start();
    const approval = runtime.approvals.request({ toolId: "shell.run", action: "run a guarded command", reason: "test", risk: "DESTRUCTIVE" });
    const first = runtime.approvals.decide(approval.id, true);
    assert.equal(first.ok, true);
    const second = runtime.approvals.decide(approval.id, false);
    assert.equal(second.ok, false, "a second verdict on a spent approval is refused");
  } finally {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("12c an expired approval cannot be spent either", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kai-trust-expired-"));
  const runtime = bootRuntime(dir);
  try {
    await runtime.start();
    const approval = runtime.approvals.request({
      toolId: "shell.run",
      action: "run a guarded command",
      reason: "test",
      risk: "DESTRUCTIVE",
      ttlMs: 1,
    });
    // Deterministic: sweep at a time past the deadline rather than sleeping.
    runtime.approvals.expireStale(new Date(Date.now() + 60_000));
    const spent = runtime.approvals.decide(approval.id, true);
    assert.equal(spent.ok, false, "an expired approval authorizes nothing");
  } finally {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// ══ 13. External report audit ════════════════════════════════════════════════

test("13 external report audit: a claimed file is checked against the real workspace; missing evidence is reported", async () => {
  const h = harness({ level: 1 });
  try {
    h.state.toolHandlers["filesystem.metadata"] = metadataHandler(false);
    const report = okReply("fixed the poller", "src/poller.ts");
    const audit = await h.orch.auditExternalReport({ reportText: report, workingDir: "C:/tmp/project" });
    assert.ok(audit.claims.length >= 1, "the report's claims are captured");
    assert.ok(audit.observed.some((o) => o.detail.includes("ABSENT")), "the claimed file was actually checked and found missing");
    assert.ok(audit.nextPrompt.length > 0, "a concrete next-worker prompt is produced");
    assert.match(audit.nextPrompt, /src\/poller\.ts|ABSENT|missing/i, "the prompt names the real finding");
    assert.equal(audit.launched.started, false, "autonomy level 1 does not auto-launch");
    assert.match(audit.launched.reason, /autonomy|authorize/i);
  } finally {
    h.close();
  }
});

test("13b an external report with no workspace says so instead of claiming verification", async () => {
  const h = harness({ level: 2 });
  try {
    const audit = await h.orch.auditExternalReport({ reportText: okReply("did it", "src/x.ts") });
    assert.ok(audit.limitation !== undefined, "the missing workspace is reported as a limitation");
    assert.match(audit.limitation as string, /not provided|no independent|cannot/i);
    assert.equal(audit.observed.length, 0, "nothing was falsely observed");
  } finally {
    h.close();
  }
});

test("13c an empty report is refused, never fake-audited", async () => {
  const h = harness();
  try {
    const audit = await h.orch.auditExternalReport({ reportText: "   " });
    assert.equal(audit.workItemId, "");
    assert.equal(audit.launched.started, false);
    assert.match(audit.blockers.join(" "), /empty/i);
  } finally {
    h.close();
  }
});

// ══ 14. Skill receipts ═══════════════════════════════════════════════════════

test("14 skill receipts: selection, loading and receipts match what was handed over", async () => {
  const h = harness();
  try {
    h.state.toolHandlers["filesystem.metadata"] = metadataHandler(true);
    h.state.skillsRelevant = ["fact-check", "plan-review"];
    h.state.skillBodies = { "fact-check": "verify claims against files", "plan-review": "critique before running" };
    h.state.skillMeta = { "fact-check": { version: "1.2.0", hash: "abc123" } };
    // No skills named at creation → the orchestrator asks the registry.
    const started = h.orch.startObjective({ objective: OBJ, deliverable: DELIVERABLE, requiredEvidence: ["file present: src/a.ts"], workingDir: "C:/tmp/project" }, ["worker-1"]);
    const planned = h.board.get(started.workItemId);
    assert.deepEqual(planned?.skills, ["fact-check", "plan-review"], "top-N selection happened at planning time");
    await h.orch.runWorkItem(started.workItemId, { workerId: "worker-1" });
    const item = h.board.get(started.workItemId);
    const receipts = item?.skillReceipts ?? [];
    assert.equal(receipts.length, 2, "one receipt per loaded body");
    const factCheck = receipts.find((r) => r.id === "fact-check");
    assert.equal(factCheck?.version, "1.2.0");
    assert.equal(factCheck?.hash, "abc123");
    assert.equal(factCheck?.bodyLength, "verify claims against files".length, "the byte count is of the body actually loaded");
    // The body really reached the worker prompt.
    const prompt = h.state.delegateCalls[0]?.prompt ?? "";
    assert.ok(prompt.includes("verify claims against files"), "the loaded skill body reached the delegation prompt");
    // Usage metrics reflect ACTUAL usage: recorded only on the verified path.
    const metrics = h.stores.skillMetrics.get("fact-check");
    assert.ok(metrics !== null && metrics.triggers >= 1, "a completed run records real skill usage");
  } finally {
    h.close();
  }
});

test("14b a skill that cannot be loaded produces NO receipt and is traced", async () => {
  const h = harness();
  try {
    h.state.toolHandlers["filesystem.metadata"] = metadataHandler(true);
    h.state.skillsRelevant = ["ghost"];
    // No body registered for "ghost": load fails.
    const started = h.orch.startObjective({ objective: OBJ, deliverable: DELIVERABLE, requiredEvidence: ["file present: src/a.ts"], workingDir: "C:/tmp/project" }, ["worker-1"]);
    await h.orch.runWorkItem(started.workItemId, { workerId: "worker-1" });
    const item = h.board.get(started.workItemId);
    assert.deepEqual(item?.skillReceipts, [], "no receipt without a real load");
    const activity = h.orch.activityList({ workItemId: started.workItemId }, "VERBOSE");
    assert.ok(activity.some((e) => e.label.includes("unloadable")), "the failed load is visible, not silent");
  } finally {
    h.close();
  }
});

// ══ 16. Memory lesson scope (provenance + isolation) ═════════════════════════

test("16 memory lesson: an unknown mission scope refuses structurally — never silently global", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kai-trust-memory-"));
  const runtime = bootRuntime(dir);
  try {
    await runtime.start();
    const resolved = runtime.resolveMemoryScope({ scope: "mission", scopeId: "mission_does_not_exist" });
    assert.equal(resolved.ok, false, "an unknown mission id is refused");
    const written = runtime.rememberForMission("mission_does_not_exist", {
      content: "this must not be stored globally",
      type: "mission_context",
      provenance: "system_state",
    });
    assert.equal(written.ok, false, "the write is refused, not redirected to a global scope");
    assert.match(JSON.stringify(written), /MEMORY_SCOPE_SUBJECT_UNKNOWN|no mission/i);
  } finally {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("16b a failed lesson write is surfaced by the orchestrator, never reported as saved", async () => {
  const h = harness();
  try {
    h.state.toolHandlers["filesystem.metadata"] = metadataHandler(true);
    h.state.lessonRefusal = "refused: mission scope unavailable";
    const started = h.orch.startObjective(
      { objective: OBJ, deliverable: DELIVERABLE, requiredEvidence: ["file present: src/a.ts"], workingDir: "C:/tmp/project", missionId: "mission_lesson" },
      ["worker-1"],
    );
    const out = await h.orch.runWorkItem(started.workItemId, { workerId: "worker-1" });
    assert.equal(out.state, "COMPLETED", "a lesson refusal never breaks completion");
    assert.equal(h.state.lessons.length, 0, "nothing was saved");
    const activity = h.orch.activityList({ workItemId: started.workItemId }, "VERBOSE");
    assert.ok(activity.some((e) => e.label.includes("lesson refused")), "the refusal is traced, not swallowed");
  } finally {
    h.close();
  }
});

// ══ 17. Production path: correlated events ═══════════════════════════════════

test("17 production path: a supervised run emits the correlated lifecycle events in order", async () => {
  const h = harness();
  try {
    h.state.toolHandlers["filesystem.metadata"] = metadataHandler(true);
    const started = h.orch.startObjective({ objective: OBJ, deliverable: DELIVERABLE, requiredEvidence: ["file present: src/a.ts"], workingDir: "C:/tmp/project" }, ["worker-1"]);
    await h.orch.runWorkItem(started.workItemId, { workerId: "worker-1" });
    const types = h.published.map((p) => p.type);
    // Planning is visible, dispatch is truthful, completion is real.
    assert.ok(types.includes("work.planned"), "planning emits work.planned");
    assert.ok(types.includes("delegation.routed"), "an actual dispatch emits delegation.routed");
    assert.ok(types.includes("worker.completed"), "a verified completion emits worker.completed");
    assert.ok(!(types.indexOf("work.planned") > types.indexOf("delegation.routed")), "planning precedes dispatch");
    const completed = h.published.find((p) => p.type === "worker.completed")?.payload as { gate?: string; workItemId?: string };
    assert.equal(completed?.gate, "PASS", "the completion names the gate verdict that allowed it");
    assert.equal(completed?.workItemId, started.workItemId, "the event is correlated to the real item");
  } finally {
    h.close();
  }
});

test("17b the completion event is NOT emitted when the gate refuses", async () => {
  const h = harness();
  try {
    h.state.toolHandlers["filesystem.metadata"] = metadataHandler(false);
    const started = h.orch.startObjective({ objective: OBJ, deliverable: DELIVERABLE, requiredEvidence: ["file present: src/a.ts"], workingDir: "C:/tmp/project" }, ["worker-1"]);
    await h.orch.runWorkItem(started.workItemId, { workerId: "worker-1" });
    assert.equal(h.published.some((p) => p.type === "worker.completed"), false, "an unmet gate must never announce a completion");
  } finally {
    h.close();
  }
});

// ══ Focused: the retry policy at the boundary ════════════════════════════════

/** Read the durable dispatch ledger the ceiling is computed from. */
function ledgerOf(h: Harness, id: string): { workerId: string; kind: string }[] {
  const outputs = (h.board.get(id)?.outputs ?? {}) as { dispatches?: { workerId: string; kind: string }[] };
  return outputs.dispatches ?? [];
}

/** Every delegate call fails, so each dispatch consumes one attempt. */
function alwaysFails(h: Harness, times = 12): void {
  h.state.delegateQueue = Array.from({ length: times }, (_, i) => ({ ok: false, error: `worker exploded (${i + 1})` }));
}

test("retry policy: the FIRST valid attempt is always allowed, and retries work within the budget", async () => {
  const h = harness({ maxRetries: 2, maxReassignments: 0 });
  try {
    alwaysFails(h);
    const started = h.orch.startObjective({ objective: OBJ, deliverable: DELIVERABLE }, ["worker-1"]);
    const first = await h.orch.runWorkItem(started.workItemId, { workerId: "worker-1" });
    assert.equal(first.state, "FAILED", "the initial attempt ran and failed honestly");
    assert.deepEqual(ledgerOf(h, started.workItemId).map((d) => d.kind), ["initial"]);
    // Two retries by the SAME worker are inside a maxRetries=2 budget.
    const second = await h.orch.runWorkItem(started.workItemId, { workerId: "worker-1" });
    const third = await h.orch.runWorkItem(started.workItemId, { workerId: "worker-1" });
    assert.equal(second.state, "FAILED");
    assert.equal(third.state, "FAILED");
    assert.deepEqual(
      ledgerOf(h, started.workItemId).map((d) => d.kind),
      ["initial", "retry", "retry"],
      "three dispatches: the initial attempt plus exactly two retries",
    );
    assert.equal(h.state.delegateCalls.length, 3, "every allowed attempt reached the worker");
  } finally {
    h.close();
  }
});

test("retry policy: an exhausted SAME-worker item refuses re-entry at the orchestration boundary", async () => {
  const h = harness({ maxRetries: 1, maxReassignments: 0 });
  try {
    alwaysFails(h);
    const started = h.orch.startObjective({ objective: OBJ, deliverable: DELIVERABLE }, ["worker-1"]);
    assert.equal((await h.orch.runWorkItem(started.workItemId, { workerId: "worker-1" })).state, "FAILED");
    assert.equal((await h.orch.runWorkItem(started.workItemId, { workerId: "worker-1" })).state, "FAILED", "one bounded retry is allowed");
    const dispatches = h.state.delegateCalls.length;
    const refused = await h.orch.runWorkItem(started.workItemId, { workerId: "worker-1" });
    assert.equal(refused.state, "BLOCKED", "an exhausted item parks truthfully — it is NOT reported complete");
    assert.match(refused.note, /retry budget exhausted/, refused.note);
    assert.equal(h.state.delegateCalls.length, dispatches, "an exhausted item never reaches the worker again");
    assert.equal(ledgerOf(h, started.workItemId).length, 2, "a refused re-entry consumes no attempt");
    const outputs = (h.board.get(started.workItemId)?.outputs ?? {}) as { nextAction?: { action?: string; state?: string } };
    assert.equal(outputs.nextAction?.action, "STOP", "the refusal is recorded durably");
    assert.equal(outputs.nextAction?.state, "blocked");
    // And the board refuses re-entry outright once BLOCKED.
    assert.equal((await h.orch.runWorkItem(started.workItemId, { workerId: "worker-1" })).state, "BLOCKED");
  } finally {
    h.close();
  }
});

test("retry policy LOOPHOLE: rotating through workers cannot exceed the per-item maximum", async () => {
  // The old policy was per (item, worker), so a caller that switched workers
  // bought a fresh allowance each time. The ceiling is now per ITEM.
  const h = harness({ maxRetries: 1, maxReassignments: 1 });
  try {
    alwaysFails(h);
    const started = h.orch.startObjective({ objective: OBJ, deliverable: DELIVERABLE }, ["worker-1"]);
    const id = started.workItemId;
    // initial (worker-1) + retry (worker-1) + reassign (worker-2) = 3 = 1 + 1 + 1.
    assert.equal((await h.orch.runWorkItem(id, { workerId: "worker-1" })).state, "FAILED");
    assert.equal((await h.orch.runWorkItem(id, { workerId: "worker-1" })).state, "FAILED");
    assert.equal((await h.orch.runWorkItem(id, { workerId: "worker-2" })).state, "FAILED");
    assert.deepEqual(ledgerOf(h, id).map((d) => d.kind), ["initial", "retry", "reassign"]);
    const dispatches = h.state.delegateCalls.length;
    assert.equal(dispatches, 3);
    // A fourth worker is a SECOND reassignment: over the per-item ceiling.
    const refused = await h.orch.runWorkItem(id, { workerId: "worker-3" });
    assert.equal(refused.state, "BLOCKED", refused.note);
    assert.match(refused.note, /budget exhausted/, refused.note);
    // ...and so is going back to an earlier worker.
    const refused2 = await h.orch.runWorkItem(id, { workerId: "worker-1" });
    assert.equal(refused2.state, "BLOCKED");
    assert.equal(h.state.delegateCalls.length, dispatches, "no worker rotation can buy another attempt");
    assert.equal(ledgerOf(h, id).length, 3);
  } finally {
    h.close();
  }
});

test("retry policy: a worker switch still succeeds when the policy permits it (S2 semantics)", async () => {
  // The breaker's sanctioned path: three failures by one worker, then a switch
  // that completes. This is exactly scripts/orch-e2e.mjs S2.
  const h = harness({ maxRetries: 2, maxReassignments: 2 });
  try {
    h.state.delegateQueue = [
      { ok: false, error: "bad worker 1" },
      { ok: false, error: "bad worker 2" },
      { ok: false, error: "bad worker 3" },
      { ok: true, reply: okReply(DELIVERABLE) },
    ];
    h.state.toolHandlers["filesystem.metadata"] = metadataHandler(true);
    const started = h.orch.startObjective(
      { objective: OBJ, deliverable: DELIVERABLE, requiredEvidence: ["file present: src/a.ts"], workingDir: "C:/tmp/project" },
      ["worker-1"],
    );
    const id = started.workItemId;
    for (let i = 0; i < 3; i += 1) {
      assert.equal((await h.orch.runWorkItem(id, { workerId: "worker-1" })).state, "FAILED", `failure ${i + 1}`);
    }
    assert.deepEqual(ledgerOf(h, id).map((d) => d.kind), ["initial", "retry", "retry"]);
    // The switch: a different worker, permitted by the reassignment allowance.
    const switched = await h.orch.runWorkItem(id, { workerId: "worker-2" });
    assert.equal(switched.state, "COMPLETED", `a permitted switch must still complete: ${switched.note}`);
    assert.deepEqual(ledgerOf(h, id).map((d) => d.kind), ["initial", "retry", "retry", "reassign"]);
  } finally {
    h.close();
  }
});

test("retry policy: a duplicate delivery neither consumes nor grants an attempt", async () => {
  const h = harness({ maxRetries: 1, maxReassignments: 1 });
  try {
    alwaysFails(h);
    const started = h.orch.startObjective({ objective: OBJ, deliverable: DELIVERABLE }, ["worker-1"]);
    const id = started.workItemId;
    await h.orch.runWorkItem(id, { workerId: "worker-1", resumeEventId: "evt_1" });
    const afterFirst = ledgerOf(h, id).length;
    // The same event redelivered: a no-op, so no attempt is consumed.
    const dupe = await h.orch.runWorkItem(id, { workerId: "worker-1", resumeEventId: "evt_1" });
    assert.match(dupe.note, /duplicate delivery/);
    assert.equal(ledgerOf(h, id).length, afterFirst, "a duplicate event must not consume an attempt");
    // Out of order: an OLD event id, then a new one. The old is a no-op; the
    // new one consumes exactly one attempt.
    const stale = await h.orch.runWorkItem(id, { workerId: "worker-1", resumeEventId: "evt_1" });
    assert.match(stale.note, /duplicate delivery/);
    await h.orch.runWorkItem(id, { workerId: "worker-1", resumeEventId: "evt_2" });
    assert.equal(ledgerOf(h, id).length, afterFirst + 1, "a genuinely new event consumes exactly one attempt");
    // The budget is still exactly 1 + 1 + 1 = 3 total.
    assert.equal(ledgerOf(h, id).length, 2);
  } finally {
    h.close();
  }
});

test("retry policy: concurrent retry requests cannot exceed the budget", async () => {
  const h = harness({ maxRetries: 1, maxReassignments: 0 });
  try {
    alwaysFails(h);
    const started = h.orch.startObjective({ objective: OBJ, deliverable: DELIVERABLE }, ["worker-1"]);
    const id = started.workItemId;
    // Four simultaneous runs of a fresh item: the claim guard plus the ledger
    // mean exactly ONE of them may dispatch.
    const outcomes = await Promise.all([
      h.orch.runWorkItem(id, { workerId: "worker-1" }),
      h.orch.runWorkItem(id, { workerId: "worker-1" }),
      h.orch.runWorkItem(id, { workerId: "worker-1" }),
      h.orch.runWorkItem(id, { workerId: "worker-1" }),
    ]);
    assert.equal(h.state.delegateCalls.length, 1, `exactly one dispatch, got ${h.state.delegateCalls.length}`);
    assert.equal(ledgerOf(h, id).length, 1, "exactly one attempt was consumed");
    assert.ok(outcomes.some((o) => o.state === "FAILED"), "the one that won reports its real result");
    // Concurrency on a nearly-exhausted item: still bounded.
    await h.orch.runWorkItem(id, { workerId: "worker-1" });
    const dispatches = h.state.delegateCalls.length;
    await Promise.all([
      h.orch.runWorkItem(id, { workerId: "worker-1" }),
      h.orch.runWorkItem(id, { workerId: "worker-1" }),
    ]);
    assert.equal(h.state.delegateCalls.length, dispatches, "an exhausted item dispatches nothing, concurrently or not");
  } finally {
    h.close();
  }
});

test("retry policy: the ceiling is durable — it survives a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kai-trust-retry-restart-"));
  const dbPath = join(dir, "core.db");
  try {
    const h1 = harness({ maxRetries: 1, maxReassignments: 0, dbPath });
    let id: string;
    try {
      alwaysFails(h1);
      const started = h1.orch.startObjective({ objective: OBJ, deliverable: DELIVERABLE }, ["worker-1"]);
      id = started.workItemId;
      await h1.orch.runWorkItem(id, { workerId: "worker-1" });
      await h1.orch.runWorkItem(id, { workerId: "worker-1" });
      assert.equal(ledgerOf(h1, id).length, 2, "the budget is spent before the restart");
    } finally {
      h1.close();
    }
    // A NEW orchestrator over the same database = a Core restart.
    const h2 = harness({ maxRetries: 1, maxReassignments: 0, dbPath });
    try {
      assert.equal(ledgerOf(h2, id).length, 2, "the ledger survived the restart");
      const refused = await h2.orch.runWorkItem(id, { workerId: "worker-1" });
      assert.equal(refused.state, "BLOCKED", "a restart must not grant a fresh budget");
      assert.match(refused.note, /retry budget exhausted/);
      assert.equal(h2.state.delegateCalls.length, 0, "the restarted orchestrator dispatched nothing");
    } finally {
      h2.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("retry policy: corrective children cannot circumvent the bounded-recovery policy", async () => {
  const h = harness({ maxRetries: 2, maxReassignments: 0 });
  try {
    // A deliverable that trips a FORBIDDEN OUTCOME is CONTRADICTED, which is
    // what routes to a corrective child (REPLAN) without parking for review.
    const forbiddenReply = [
      "STATUS: ok",
      "RESULT: I force-push the branch and delivered the patch.",
      "CHANGED ARTIFACTS: src/a.ts",
      "EVIDENCE: tests pass",
      "BLOCKERS: (none)",
      "RISKS: none noted",
      "FOLLOW-UPS: none",
      "RECOMMENDED NEXT STEP: ship it",
      "TOOLS USED: read, edit",
    ].join("\n");
    h.state.delegateQueue = Array.from({ length: 20 }, () => ({ ok: true, reply: forbiddenReply }));
    const started = h.orch.startObjective(
      { objective: OBJ, deliverable: DELIVERABLE, forbidden: ["force-push"], budget: { maxRetries: 1, maxDepth: 2, maxReassignments: 0 } },
      ["worker-1"],
    );
    await h.orch.runWorkItem(started.workItemId, { workerId: "worker-1" });
    // The chain is bounded by maxDepth (2): parent + child + grandchild, and no
    // further dispatch. No item in the chain is reported COMPLETED.
    assert.equal(
      h.state.delegateCalls.length,
      3,
      `the corrective chain must stop at depth 2, got ${h.state.delegateCalls.length} dispatches`,
    );
    const parent = h.board.get(started.workItemId);
    assert.ok(parent !== null);
    assert.notEqual(parent?.state, "COMPLETED", "a contradicted deliverable never completes");
    // Every item in the chain has its OWN single dispatch: a child never resets
    // the parent's ledger, and the parent's ceiling still binds the parent.
    assert.equal(ledgerOf(h, started.workItemId).length, 1, "the parent made exactly one dispatch");
    const children = h.board.children(started.workItemId);
    assert.equal(children.length, 1, "exactly one corrective child was created for the parent");
    for (const child of children) {
      assert.equal(ledgerOf(h, child.id).length, 1, `child ${child.id} has its own single attempt`);
      assert.equal(child.budget?.maxRetries, 1, "the child inherits the parent's retry budget (no reset)");
      assert.deepEqual(child.forbiddenOutcomes, ["force-push"], "the child inherits the parent's contract");
      // ...and the chain continues at most one more level.
      assert.equal(h.board.children(child.id).length, 1, "the child made one bounded correction of its own");
    }
  } finally {
    h.close();
  }
});

// ══ Focused: the worker API is offline ═══════════════════════════════════════

test("offline worker: no completion is claimed when the worker cannot be reached", async () => {
  const h = harness();
  try {
    h.state.delegateQueue = [{ ok: false, error: "ECONNREFUSED 127.0.0.1:9999" }];
    const started = h.orch.startObjective({ objective: OBJ, deliverable: DELIVERABLE }, ["worker-1"]);
    const out = await h.orch.runWorkItem(started.workItemId, { workerId: "worker-1" });
    assert.equal(out.state, "FAILED", "an unreachable worker fails the item");
    assert.match(out.note, /ECONNREFUSED|reached|failed/i);
    assert.equal(h.board.get(started.workItemId)?.state, "FAILED");
    assert.equal(
      h.published.some((p) => p.type === "worker.completed"),
      false,
      "an unreachable worker must never be reported as a completed job",
    );
    assert.ok(h.published.some((p) => p.type === "worker.failed"), "the failure is emitted, not swallowed");
  } finally {
    h.close();
  }
});

// ══ Focused: supervisor failure visibility ═══════════════════════════════════

test("supervisor failure: an internal throw is recorded and notified, never swallowed", async () => {
  const notices: { title: string; message: string }[] = [];
  const supervisor = createMissionSupervisor({
    getMission: () => {
      throw new Error("store exploded");
    },
    startAttempt: async () => {
      throw new Error("unreachable");
    },
    notify: (input) => notices.push({ title: input.title, message: input.message }),
  });
  const decision = await supervisor.observe("mission_x");
  assert.equal(decision.action, "stop");
  assert.match(decision.reason, /supervisor evaluation threw/);
  assert.equal(notices.length, 1, "the failure is told to the human");
  assert.match(notices[0]?.title ?? "", /supervision failed/i);
});

// ══ Focused: redaction of secrets from evidence ══════════════════════════════

test("redaction: a secret-shaped string in a worker's evidence is redacted in the stored record", async () => {
  const h = harness();
  try {
    const secret = "sk-ant-api03-ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ";
    h.state.delegateQueue = [{ ok: true, reply: okReply(DELIVERABLE).replace("EVIDENCE: tests pass", `EVIDENCE: ran with key ${secret}`) }];
    h.state.toolHandlers["filesystem.metadata"] = metadataHandler(true);
    const started = h.orch.startObjective({ objective: OBJ, deliverable: DELIVERABLE, requiredEvidence: ["file present: src/a.ts"], workingDir: "C:/tmp/project" }, ["worker-1"]);
    await h.orch.runWorkItem(started.workItemId, { workerId: "worker-1" });
    const item = h.board.get(started.workItemId);
    const dumped = JSON.stringify(item?.evidence ?? []);
    assert.equal(dumped.includes(secret), false, "the raw secret must not be persisted in the evidence record");
  } finally {
    h.close();
  }
});
