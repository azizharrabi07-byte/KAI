// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Campaign: parked-work recovery and the supervisor lifecycle.
 *
 * The property under test, stated once: an approval is a durable, single-use
 * authorization for ONE action; parking an item must preserve the Outcome
 * Contract, the worker handoff and the dispatch ledger across a restart; and a
 * settled mission is supervised exactly once per settlement — never looping,
 * never swallowing an internal failure.
 *
 * Harness shape copied from `tests/orch-supervisor-trust.test.ts`: the REAL
 * board + orchestrator over real (in-memory or temp-file) SQLite stores, with
 * scriptable delegate / reviewer / tools / approvals ports. The orchestrator is
 * never mocked. Run from `core/`:
 *
 *   node --test tests/campaign-approval-lifecycle.test.ts
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
import type { AutonomyPolicy, ReviewVerdict, VerifiedEvidence, WorkItem } from "../src/orchestration/types.ts";
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
  return { id, kind: "check", source: "kai-observed", method: "test-fixture", detail, supports, at: "2026-01-01T00:00:00.000Z" };
}

function reported(id: string, detail = "worker words"): VerifiedEvidence {
  return { id, kind: "worker claim", source: "worker-reported", method: "worker-handoff", detail, supports: [], at: "2026-01-01T00:00:00.000Z" };
}

function must<T>(res: BoardResult<T>): T {
  if (!res.ok) assert.fail(`expected ok, got: ${res.reason}`);
  return res.value;
}

/** Read the persisted `outputs` object of an item (always an object). */
function outputsOf(item: WorkItem | null | undefined): Record<string, unknown> {
  const outputs = item?.outputs as Record<string, unknown> | null | undefined;
  return outputs !== null && typeof outputs === "object" && !Array.isArray(outputs) ? outputs : {};
}

// ── The integration harness (shape copied from orch-supervisor-trust) ────────

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
  skillsRelevant: string[];
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
      load: () => ({ ok: false, reason: "not installed" }),
      inspect: () => null,
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
      state.lessons.push(input);
      return { ok: true };
    },
  });
  return { orch, board, stores, published, state, close: () => stores.close() };
}

function shellHandler(exitCode: number, stdout = "", stderr = ""): ToolStub {
  return () => ({ ok: true, result: { exitCode, stdout, stderr } });
}

function policyDenied(): ToolStub {
  return () => ({ ok: false, error: { code: "POLICY_DENIED", message: "denied by policy" } });
}

/** Park an item on a guarded shell check and return the item id + approval id. */
async function parkOnGuardedCheck(h: Harness, extra: Record<string, unknown> = {}): Promise<{ id: string; approvalId: string }> {
  const started = h.orch.startObjective(
    {
      objective: OBJ,
      deliverable: DELIVERABLE,
      successCriteria: ["tests pass"],
      requiredEvidence: ["npm test"],
      workingDir: "C:/tmp/project",
      ...extra,
    },
    ["worker-1"],
  );
  const parked = await h.orch.runWorkItem(started.workItemId, { workerId: "worker-1" });
  assert.equal(parked.state, "WAITING", `expected a park, got ${parked.state}: ${parked.note}`);
  const approvalId = parked.parkedApprovalId;
  assert.equal(typeof approvalId, "string", "a park must name its approval");
  return { id: started.workItemId, approvalId: approvalId as string };
}

// ══ 1. A pending approval parks with the contract, handoff and ledger intact ══

test("1 park: a pending approval parks WAITING with the persisted contract, handoff and ledger intact", async () => {
  const h = harness();
  try {
    const started = h.orch.startObjective(
      { objective: OBJ, deliverable: DELIVERABLE, successCriteria: ["tests pass"], requiredEvidence: ["npm test"], workingDir: "C:/tmp/project" },
      ["worker-1"],
    );
    const id = started.workItemId;
    assert.equal(h.board.get(id)?.state, "READY", "before the park the item is READY, never delegated");

    const parked = await h.orch.runWorkItem(id, { workerId: "worker-1" });
    assert.equal(parked.state, "WAITING");
    assert.ok(typeof parked.parkedApprovalId === "string" && parked.parkedApprovalId.length > 0);

    // Read the durable state back (a fresh read, not the in-memory return).
    const item = h.board.get(id);
    assert.equal(item?.state, "WAITING");
    const outputs = outputsOf(item);

    // Outcome Contract persisted, with the caller's criteria + evidence links.
    const contract = outputs["contract"] as { acceptanceCriteria?: string[]; requiredEvidence?: string[]; completionPolicy?: string } | undefined;
    assert.ok(contract !== undefined, "the Outcome Contract is persisted, not dropped by the park");
    assert.deepEqual(contract?.acceptanceCriteria, ["tests pass"]);
    assert.deepEqual(contract?.requiredEvidence, ["npm test"]);

    // Handoff intact (what the worker actually said, persisted before the park).
    assert.ok(item?.handoff !== undefined, "the worker handoff survives the park");
    assert.ok((item?.handoff?.result ?? "").length > 0, "the handoff result is non-empty");

    // Dispatch ledger intact: exactly the one dispatch that ran.
    const dispatches = outputs["dispatches"] as { workerId: string; kind: string }[] | undefined;
    assert.ok(Array.isArray(dispatches) && dispatches.length === 1, `expected one ledger entry, got ${JSON.stringify(dispatches)}`);
    assert.equal(dispatches?.[0]?.workerId, "worker-1");

    // The park linkage is durable and matches the returned id.
    const parkedRec = outputs["parked"] as { approvalId?: string } | undefined;
    assert.equal(parkedRec?.approvalId, parked.parkedApprovalId);
    assert.ok(Array.isArray((outputs["pendingEvidence"] as { labels?: string[] } | undefined)?.labels));
  } finally {
    h.close();
  }
});

// ══ 2. A DENIED approval cancels; the protected action never runs ═════════════

test("2 denial: a rejected approval cancels the item and the protected action never runs", async () => {
  const h = harness();
  try {
    const { id, approvalId } = await parkOnGuardedCheck(h);
    const delegatesBefore = h.state.delegateCalls.length;
    const shellBefore = h.state.toolCalls.filter((c) => c.id === "shell.run").length;
    assert.equal(shellBefore, 0, "a park runs no guarded check before a verdict");

    const rejected = await h.orch.onApprovalDecided(approvalId, false);
    assert.ok(rejected.handled >= 1, "the parked item is found from persisted state");
    assert.equal(h.board.get(id)?.state, "CANCELLED", "a rejection cancels, it never executes");
    assert.equal(h.state.toolCalls.filter((c) => c.id === "shell.run").length, shellBefore, "the protected action never ran on a rejection");
    assert.equal(h.state.delegateCalls.length, delegatesBefore, "a rejection re-delegates nothing");
    assert.equal(h.published.some((p) => p.type === "worker.completed"), false, "a cancelled item is never reported completed");
  } finally {
    h.close();
  }
});

// ══ 3. A spent approval cannot authorize a second action ══════════════════════

test("3a spent approval: the real approvals store refuses a second verdict", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kai-approval-store-"));
  const runtime = createCoreRuntime({
    dbPath: join(dir, "core.db"),
    agents: { mode: "mock" },
    startScheduler: false,
    subsystemPaths: { runUpkeepOnStart: false, ledgerPath: join(dir, "ledger.db") },
  });
  try {
    await runtime.start();
    const approval = runtime.approvals.request({ toolId: "shell.run", action: "run a guarded command", reason: "test", risk: "DESTRUCTIVE" });
    const first = runtime.approvals.decide(approval.id, true);
    assert.equal(first.ok, true, "the first verdict is accepted");
    const second = runtime.approvals.decide(approval.id, false);
    assert.equal(second.ok, false, "a spent approval cannot be re-decided (a second verdict is refused)");
    const third = runtime.approvals.decide(approval.id, true);
    assert.equal(third.ok, false, "nor can it be re-decided to authorize the action again");
  } finally {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("3b spent approval: the same approval id cannot authorize a second orchestrator execution", async () => {
  const h = harness();
  try {
    h.state.toolHandlers["shell.run"] = shellHandler(0, "ok", "");
    const { id, approvalId } = await parkOnGuardedCheck(h);

    const first = await h.orch.onApprovalDecided(approvalId, true);
    assert.ok(first.handled >= 1, "the approval resumes the parked item");
    assert.equal(h.board.get(id)?.state, "COMPLETED", "real evidence flowing in completes it through the Gate");
    const shellAfter = h.state.toolCalls.filter((c) => c.id === "shell.run").length;
    const delegatesAfter = h.state.delegateCalls.length;
    assert.equal(shellAfter, 1, "the approval authorized exactly one guarded execution");

    // Re-present the SAME approval id: a duplicate delivery, never a second run.
    const again = await h.orch.runWorkItem(id, { workerId: "worker-1", approvalId });
    assert.match(again.note, /duplicate delivery/i, again.note);
    assert.equal(h.state.toolCalls.filter((c) => c.id === "shell.run").length, shellAfter, "a spent approval authorizes no second guarded execution");
    assert.equal(h.state.delegateCalls.length, delegatesAfter, "and no second delegation");

    // And it cannot be used to resume the item a second time.
    const redelivered = await h.orch.onApprovalDecided(approvalId, true);
    assert.equal(redelivered.handled, 0, "a settled item is not resumed again by a replayed approval");
    assert.equal(h.board.get(id)?.state, "COMPLETED");
  } finally {
    h.close();
  }
});

// ══ 4. A review retry needs a FRESH approval ══════════════════════════════════

test("4 review retry: a fresh approval is required; the spent approval id cannot authorize it", async () => {
  const h = harness();
  try {
    // First execution parks at the worker boundary (the tool returns APPROVAL_REQUIRED).
    h.state.delegateQueue = [{ ok: false, parkedApprovalId: "appr_deleg" }];
    h.state.reviewQueue = [
      { verdict: "CHANGES_REQUESTED", findings: ["the poller still busy-waits"] },
      { verdict: "CHANGES_REQUESTED", findings: ["the poller still busy-waits"] },
    ];
    const started = h.orch.startObjective({ objective: OBJ, deliverable: DELIVERABLE }, ["worker-1"]);
    const id = started.workItemId;
    const parkedFirst = await h.orch.runWorkItem(id, { workerId: "worker-1" });
    assert.equal(parkedFirst.state, "WAITING");
    assert.equal(parkedFirst.parkedApprovalId, "appr_deleg");

    // Approve the first action: it runs, the reviewer requests changes, and the
    // retry must park on a NEW approval (never reusing the spent one).
    const resumed = await h.orch.onApprovalDecided("appr_deleg", true);
    assert.ok(resumed.handled >= 1);
    const item = h.board.get(id);
    assert.equal(item?.state, "WAITING", `expected the review retry to park, got ${item?.state}`);
    const retryApproval = outputsOf(item)["parked"] as { approvalId?: string; kind?: string } | undefined;
    assert.equal(retryApproval?.kind, "review-retry", "the park is attributable to the review retry");
    assert.notEqual(retryApproval?.approvalId, "appr_deleg", "the retry gets a FRESH approval, never the spent id");

    const delegatesAfterPark = h.state.delegateCalls.length;
    // The old approval id cannot authorize the retry.
    const stale = await h.orch.onApprovalDecided("appr_deleg", true);
    assert.equal(stale.handled, 0, "the spent approval owns no parked item any more");
    assert.equal(h.board.get(id)?.state, "WAITING", "the stale verdict changes nothing");
    assert.equal(h.state.delegateCalls.length, delegatesAfterPark, "the stale verdict re-delegates nothing");

    // The fresh approval resumes and completes.
    const fresh = await h.orch.onApprovalDecided(retryApproval?.approvalId as string, true);
    assert.ok(fresh.handled >= 1, "the fresh approval resumes the retry");
    assert.equal(h.board.get(id)?.state, "COMPLETED", "the fresh approval carries the retry through the Gate");
  } finally {
    h.close();
  }
});

// ══ 5. Duplicate onApprovalDecided deliveries are idempotent ══════════════════

test("5 idempotency: duplicate onApprovalDecided deliveries resume exactly once", async () => {
  const h = harness();
  try {
    h.state.toolHandlers["shell.run"] = shellHandler(0, "18/18 passed", "");
    const { id, approvalId } = await parkOnGuardedCheck(h);
    const delegatesBefore = h.state.delegateCalls.length;

    // Two SIMULTANEOUS deliveries of the same verdict: at most one execution.
    const [a, b] = await Promise.all([
      h.orch.onApprovalDecided(approvalId, true),
      h.orch.onApprovalDecided(approvalId, true),
    ]);
    assert.equal(a.handled + b.handled, 1, `exactly one delivery handled the item, got ${a.handled}+${b.handled}`);
    assert.equal(h.state.toolCalls.filter((c) => c.id === "shell.run").length, 1, "the guarded check ran exactly once");
    assert.equal(h.state.delegateCalls.length, delegatesBefore, "resuming evidence is not a re-delegation");
    assert.equal(h.board.get(id)?.state, "COMPLETED");

    // A later duplicate is a no-op too.
    const later = await h.orch.onApprovalDecided(approvalId, true);
    assert.equal(later.handled, 0, "a replayed approval cannot resume a settled item");
    assert.equal(h.state.toolCalls.filter((c) => c.id === "shell.run").length, 1, "still exactly one execution");
  } finally {
    h.close();
  }
});

// ══ 6. Restart between park and resume ════════════════════════════════════════

test("6 restart: reopening the DB keeps the park resumable and the gate is still evaluated", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kai-approval-restart-"));
  const dbPath = join(dir, "core.db");
  let failId = "";
  let passId = "";
  let failApproval = "";
  let passApproval = "";
  try {
    const h1 = harness({ dbPath });
    try {
      const a = await parkOnGuardedCheck(h1);
      failId = a.id;
      failApproval = a.approvalId;
      const b = await parkOnGuardedCheck(h1);
      passId = b.id;
      passApproval = b.approvalId;
      assert.notEqual(failApproval, passApproval);
    } finally {
      h1.close();
    }

    // A NEW orchestrator over the same database = a Core restart.
    const h2 = harness({ dbPath });
    try {
      for (const id of [failId, passId]) {
        const item = h2.board.get(id);
        assert.equal(item?.state, "WAITING", "the park survived the restart");
        const outputs = outputsOf(item);
        assert.ok(outputs["contract"] !== undefined, "the Outcome Contract survived the restart");
        assert.ok((item?.handoff?.result ?? "").length > 0, "the handoff survived the restart");
        assert.ok(Array.isArray((outputs["pendingEvidence"] as { labels?: string[] } | undefined)?.labels), "the pending checks survived the restart");
      }
      assert.equal((outputsOf(h2.board.get(failId))["parked"] as { approvalId?: string } | undefined)?.approvalId, failApproval);
      assert.equal((outputsOf(h2.board.get(passId))["parked"] as { approvalId?: string } | undefined)?.approvalId, passApproval);

      // Resume with a FAILING check: the gate is re-evaluated, nothing completes.
      h2.state.toolHandlers["shell.run"] = shellHandler(1, "", "still failing");
      const failed = await h2.orch.onApprovalDecided(failApproval, true);
      assert.ok(failed.handled >= 1);
      assert.notEqual(h2.board.get(failId)?.state, "COMPLETED", "a failing check must not complete after a restart");
      const failEvidence = h2.board.get(failId)?.evidence ?? [];
      assert.ok(failEvidence.some((r) => r.source === "kai-observed"), "the gate was evaluated on real observation, not a guess");

      // Resume with a PASSING check: only now may it complete.
      h2.state.toolHandlers["shell.run"] = shellHandler(0, "18/18 passed", "");
      const passed = await h2.orch.onApprovalDecided(passApproval, true);
      assert.ok(passed.handled >= 1);
      assert.equal(h2.board.get(passId)?.state, "COMPLETED", "a passing check completes through the Gate after the restart");
    } finally {
      h2.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// ══ 7. ASK_USER parks with a durable, specific question ═══════════════════════

test("7 ASK_USER: parks WAITING with a durable, specific question (never FAILED/COMPLETED)", async () => {
  const h = harness();
  try {
    // A depth-3 item forces the kernel's ASK_USER branch (delegation depth ceiling).
    const root = must(h.board.create({ objective: OBJ, deliverable: DELIVERABLE, requiredEvidence: ["npm test"] }));
    const c1 = must(h.board.createChild(root.id, { objective: OBJ, deliverable: DELIVERABLE, requiredEvidence: ["npm test"] }, { maxDepth: 5, maxChildren: 3 }));
    const c2 = must(h.board.createChild(c1.id, { objective: OBJ, deliverable: DELIVERABLE, requiredEvidence: ["npm test"] }, { maxDepth: 5, maxChildren: 3 }));
    const c3 = must(h.board.createChild(c2.id, { objective: OBJ, deliverable: DELIVERABLE, requiredEvidence: ["npm test"] }, { maxDepth: 5, maxChildren: 3 }));
    assert.equal(h.board.depthOf(c3.id), 3, "the item sits at the delegation ceiling");

    const out = await h.orch.runWorkItem(c3.id, { workerId: "worker-1" });
    assert.equal(out.state, "WAITING", `expected ASK_USER to park, got ${out.state}`);
    assert.notEqual(out.state, "FAILED");
    assert.notEqual(out.state, "COMPLETED");

    const item = h.board.get(c3.id);
    assert.equal(item?.state, "WAITING", "the parked state is visible, not a dead DRAFT");
    const nextAction = outputsOf(item)["nextAction"] as { action?: string; reason?: string; state?: string } | undefined;
    assert.equal(nextAction?.action, "ASK_USER", "the recorded next action is ASK_USER");
    assert.ok((nextAction?.reason ?? "").length > 0, "the persisted question/reason is non-empty");
    assert.match(nextAction?.reason ?? "", /depth|ceiling|Decision needed/i, "the question names the specific blocker");
    assert.match(out.note, /Decision needed/i, out.note);
    assert.ok(h.published.some((p) => p.type === "worker.waiting"), "parking is published, not silent");
  } finally {
    h.close();
  }
});

// ══ 8. Blocked / unsupported checks are never reported as executed ═══════════

test("8a unsupported check: recorded as blocked, never reported as executed", async () => {
  const h = harness();
  try {
    const started = h.orch.startObjective(
      { objective: OBJ, deliverable: DELIVERABLE, successCriteria: ["the UX is signed off"], requiredEvidence: ["a human signed off on the UX"] },
      ["worker-1"],
    );
    const out = await h.orch.runWorkItem(started.workItemId, { workerId: "worker-1" });
    assert.notEqual(out.state, "COMPLETED", "an unsupported check cannot complete the item");

    // No tool was executed at all: nothing was invented to stand in for the check.
    assert.equal(h.state.toolCalls.length, 0, "no tool was invoked for an unsupported check");
    const activity = h.orch.activityList({ workItemId: started.workItemId });
    assert.ok(activity.some((e) => /no safe check available/i.test(e.label)), "the unsupported check is recorded as blocked in the trace");
    assert.equal(
      (h.board.get(started.workItemId)?.evidence ?? []).some((r) => r.source === "kai-observed"),
      false,
      "nothing was recorded as observed for a check that never ran",
    );
    assert.equal(h.published.some((p) => p.type === "worker.completed"), false, "a failed gate emits no completion event");
  } finally {
    h.close();
  }
});

test("8b policy-blocked check: recorded as blocked, never reported as executed", async () => {
  const h = harness();
  try {
    const { id, approvalId } = await parkOnGuardedCheck(h);
    // On resume the guarded check runs, but the boundary refuses it.
    h.state.toolHandlers["shell.run"] = policyDenied();
    const resumed = await h.orch.onApprovalDecided(approvalId, true);
    assert.ok(resumed.handled >= 1);
    assert.notEqual(h.board.get(id)?.state, "COMPLETED", "a policy-blocked check cannot complete the item");

    const evidence = h.board.get(id)?.evidence ?? [];
    assert.equal(
      evidence.some((r) => r.source === "kai-observed" && r.method.includes("shell.run")),
      false,
      "a refused check is never stored as a kai-observed execution",
    );
    const activity = h.orch.activityList({ workItemId: id });
    assert.ok(activity.some((e) => /POLICY_DENIED|refused/i.test(e.label)), "the refusal is recorded as blocked in the trace");
    assert.equal(h.published.some((p) => p.type === "worker.completed"), false, "a failed gate emits no completion event");
  } finally {
    h.close();
  }
});

// ══ 9. Lifecycle events ═══════════════════════════════════════════════════════

test("9a lifecycle: planning is work.planned, never delegation.routed", async () => {
  const h = harness();
  try {
    const started = h.orch.startObjective({ objective: OBJ, deliverable: DELIVERABLE }, ["worker-1"]);
    assert.ok(h.published.some((p) => p.type === "work.planned"), "planning is published as work.planned");
    assert.equal(h.published.some((p) => p.type === "delegation.routed"), false, "planning is NOT reported as delegation");

    await h.orch.runWorkItem(started.workItemId, { workerId: "worker-1" });
    assert.ok(h.published.some((p) => p.type === "delegation.routed"), "an actual dispatch is published as delegation.routed");
  } finally {
    h.close();
  }
});

test("9b lifecycle: no contradictory terminal state from duplicate/out-of-order events", async () => {
  const h = harness();
  try {
    const { id, approvalId } = await parkOnGuardedCheck(h);
    await h.orch.onApprovalDecided(approvalId, false);
    assert.equal(h.board.get(id)?.state, "CANCELLED");

    // Out-of-order / unknown approval ids are honest no-ops.
    const unknown = await h.orch.onApprovalDecided("appr_never_existed", true);
    assert.equal(unknown.handled, 0, "an unknown approval handles nothing");
    assert.equal(h.board.get(id)?.state, "CANCELLED", "an out-of-order event cannot resurrect a cancelled item");

    // A duplicate delivery of the (already spent) verdict changes nothing.
    const replay = await h.orch.onApprovalDecided(approvalId, true);
    assert.equal(replay.handled, 0);
    assert.equal(h.board.get(id)?.state, "CANCELLED", "the terminal state is stable under replay");

    // Re-running a settled item is a refused no-op, never a contradictory flip.
    const delegates = h.state.delegateCalls.length;
    const rerun = await h.orch.runWorkItem(id, { workerId: "worker-1" });
    assert.equal(rerun.state, "CANCELLED", "a settled item keeps its terminal state");
    assert.equal(h.state.delegateCalls.length, delegates, "a cancelled item is never re-dispatched");
  } finally {
    h.close();
  }
});

// ══ 10. Supervisor ════════════════════════════════════════════════════════════

function failedMission(id: string, attempt: number, code: "AGENT_TIMEOUT" | "POLICY_DENIED" = "AGENT_TIMEOUT"): Mission {
  const ts = "2026-01-01T00:00:00.000Z";
  return {
    id,
    title: "a supervised mission",
    status: "FAILED",
    priority: 0,
    createdAt: ts,
    updatedAt: ts,
    metadata: { autonomyAttempt: attempt },
    steps: [{ id: "s0", missionId: id, index: 0, title: "do it", kind: "tool", status: "FAILED", sideEffecting: false, target: "filesystem.read" }],
    error: { code, message: "timed out", retryable: true, at: ts },
  };
}

test("10a supervisor: an internal throw is recorded AND notified, never swallowed", async () => {
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
  assert.equal(decision.action, "stop", "a thrown supervision stops, never pretends success");
  assert.match(decision.reason, /supervisor evaluation threw/i, "the throw is recorded in the decision");
  assert.equal(notices.length, 1, "the failure is told to the human, not swallowed");
  assert.match(notices[0]?.title ?? "", /supervision failed/i);
  assert.equal(supervisor.decisions().length, 1, "the decision is durably recorded");
});

test("10b supervisor: a repeated identical failure is bounded by the chain budget", async () => {
  const missions = new Map<string, Mission>();
  let attempts = 0;
  const supervisor = createMissionSupervisor({
    getMission: (id) => missions.get(id) ?? null,
    startAttempt: async (input) => {
      attempts += 1;
      const next = { ...failedMission(`retry_${attempts}`, 2), metadata: input.metadata } as Mission;
      missions.set(next.id, next);
      return next;
    },
    notify: () => {},
    bounds: { maxAttempts: 1 },
  });
  missions.set("m_root", failedMission("m_root", 1, "AGENT_TIMEOUT"));

  const first = await supervisor.observe("m_root");
  assert.equal(first.action, "retry", "a transient failure with budget available is retried once");
  assert.equal(attempts, 1);

  // The retry itself fails with the SAME transient error: no further attempt.
  const second = await supervisor.observe(first.retryMissionId as string);
  assert.notEqual(second.action, "retry", "the same failure must not loop forever");
  assert.equal(attempts, 1, "exactly one re-attempt for the chain");
});

test("10c supervisor: repeated delivery of the SAME settled failure is bounded", async () => {
  let attempts = 0;
  const supervisor = createMissionSupervisor({
    getMission: (id) => (id === "m_same" ? failedMission("m_same", 1, "AGENT_TIMEOUT") : null),
    startAttempt: async () => {
      attempts += 1;
      return failedMission(`retry_${attempts}`, 2);
    },
    notify: () => {},
    bounds: { maxAttempts: 1 },
  });

  // Three deliveries of the identical settled failure (the executor can emit
  // mission.failed more than once for one mission, e.g. on recovery).
  await supervisor.observe("m_same");
  await supervisor.observe("m_same");
  await supervisor.observe("m_same");

  assert.equal(attempts, 1, `one settled failure must start at most one re-attempt, but started ${attempts}`);
});
