// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Orchestrator loop tests: startObjective routing, the full runWorkItem PASS
 * loop, ASK parking + approval resume/reject, review retry paths, breaker
 * consultation, handoff parsing/verification, nextMove, inspect, proposeSkill,
 * and ownsApproval.
 *
 * Real board/bench/dispatcher/trace/learning over
 * openSqliteStores({ path: ":memory:" }) stores plus the real
 * PromptPatternStore; stub delegate (scriptable ok/parked/fail) and stub
 * reviewRunner (scriptable verdicts), skills, policyCheck, and approvals.
 * No agents runtime is needed — the delegate stub stands in for it.
 * Run from `core/`:  node --test tests/orch-orchestrator.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createWorkBoard, type BoardResult, type WorkBoard } from "../src/orchestration/board.ts";
import { createBenchmark, type Benchmark } from "../src/orchestration/bench.ts";
import { createDispatcher } from "../src/orchestration/dispatch.ts";
import { createTrace } from "../src/orchestration/trace.ts";
import { createLearning } from "../src/orchestration/learn.ts";
import {
  createOrchestrator,
  type DelegateInput,
  type DelegateResult,
  type Orchestrator,
} from "../src/orchestration/orchestrator.ts";
import type { AutonomyPolicy, ReviewVerdict, WorkerHandoff } from "../src/orchestration/types.ts";
import type { Stores } from "../src/shared/contracts.ts";
import { openSqliteStores } from "../src/storage/sqlite.ts";

// ── Shared fixtures ───────────────────────────────────────────────────────────

/** Neutral objective: general domain, READ risk, no required skills/tools. */
const OBJ = "Say hello and confirm you are online";
const DELIVERABLE = "the summary doc";

function baseAutonomy(level: AutonomyPolicy["level"] = 2): AutonomyPolicy {
  return {
    level,
    workerAuto: "AUTO",
    review: "AUTO",
    skillLearning: "PROPOSE",
    budgets: { maxDepth: 2, maxRetries: 2 },
    maxDepth: 2,
    maxParallel: 3,
    taskRetentionDays: 30,
  };
}

/** Full handoff-shaped reply whose RESULT names the deliverable. */
function okReply(deliverable: string): string {
  return [
    "STATUS: ok",
    `RESULT: Delivered ${deliverable} with all requested changes.`,
    "CHANGED ARTIFACTS: src/a.ts",
    "EVIDENCE: tests pass",
    "TESTS: npm test — 18/18 passed",
    "BLOCKERS: (none)",
    "RISKS: none noted",
    "FOLLOW-UPS: none",
    "RECOMMENDED NEXT STEP: ship it",
    "TOOLS USED: read, edit",
  ].join("\n");
}

function okHandoffObj(result = "did the thing"): WorkerHandoff {
  return {
    status: "ok",
    result,
    changedArtifacts: ["src/a.ts"],
    evidence: ["tests pass"],
    blockers: [],
    risks: [],
    followUps: [],
    toolsUsed: ["read"],
  };
}

function must<T>(res: BoardResult<T>): T {
  if (!res.ok) assert.fail(`expected ok, got reason: ${res.reason}`);
  return res.value;
}

interface StubState {
  autonomy: AutonomyPolicy;
  policyDeny: boolean;
  delegateQueue: DelegateResult[];
  delegateCalls: DelegateInput[];
  reviewQueue: { verdict: ReviewVerdict; findings: string[] }[];
  reviewCalls: number;
  approvals: Map<string, string>;
}

interface Harness {
  orch: Orchestrator;
  board: WorkBoard;
  bench: Benchmark;
  stores: Stores;
  published: { type: string; payload: unknown }[];
  state: StubState;
  close(): void;
}

function harness(autonomyLevel: AutonomyPolicy["level"] = 2): Harness {
  const stores = openSqliteStores({ path: ":memory:" });
  const board = createWorkBoard(stores.workItems);
  const bench = createBenchmark(stores.workerProfiles);
  const dispatcher = createDispatcher({
    bench,
    availability: () => ["worker-1", "worker-2"],
    capabilities: () => ({
      skills: ["typescript", "python", "react", "rust", "sql", "docker", "testing", "review", "research", "writing"],
      tools: ["read", "edit", "shell", "browser", "git", "test-runner", "mcp"],
    }),
  });
  const trace = createTrace({
    store: stores.activity,
    prefs: () => ({ activity: "VERBOSE", reasoning: "SUMMARY" }) as const,
  });
  const learning = createLearning({
    metrics: stores.skillMetrics,
    validate: () => ({ ok: true }),
    stage: () => ({ ok: true }),
  });
  const published: { type: string; payload: unknown }[] = [];
  const state: StubState = {
    autonomy: baseAutonomy(autonomyLevel),
    policyDeny: false,
    delegateQueue: [],
    delegateCalls: [],
    reviewQueue: [],
    reviewCalls: 0,
    approvals: new Map<string, string>(),
  };
  let approvalSeq = 0;
  const orch = createOrchestrator({
    board,
    bench,
    dispatcher,
    trace,
    learning,
    patterns: stores.promptPatterns,
    reviewRunner: async (): Promise<{ verdict: ReviewVerdict; findings: string[] }> => {
      state.reviewCalls += 1;
      return state.reviewQueue.shift() ?? { verdict: "PASS", findings: [] };
    },
    delegate: async (input: DelegateInput): Promise<DelegateResult> => {
      state.delegateCalls.push(input);
      return state.delegateQueue.shift() ?? { ok: true, reply: okReply(DELIVERABLE) };
    },
    skills: {
      relevant: () => [],
      load: () => ({ ok: false, reason: "missing" }),
    },
    policyCheck: async (): Promise<{ outcome: "allow" | "deny" | "needs_approval"; reason: string }> =>
      state.policyDeny ? { outcome: "deny", reason: "denied by test" } : { outcome: "allow", reason: "allowed by test" },
    approvals: {
      request: (): { id: string } => {
        approvalSeq += 1;
        const id = `appr_local_${approvalSeq}`;
        state.approvals.set(id, "pending");
        return { id };
      },
      get: (id: string): { status: string } | null => {
        const status = state.approvals.get(id);
        return status === undefined ? null : { status };
      },
    },
    autonomy: () => state.autonomy,
    publish: (type: string, payload: unknown): void => {
      published.push({ type, payload });
    },
  });
  return { orch, board, bench, stores, published, state, close: () => stores.close() };
}

// ── startObjective ────────────────────────────────────────────────────────────

test("startObjective plans (not delegates): READY item, children, work.planned", () => {
  const h = harness();
  try {
    const out = h.orch.startObjective({ objective: OBJ, subtasks: ["Book the venue", "Order the food"] });
    // Truthful dispatch: planning alone is planned, never delegated. No worker
    // was dispatched, so `delegated` is false and no delegation.routed fires.
    assert.equal(out.delegated, false);
    assert.equal(out.planned, true);
    assert.ok(out.workItemId.length > 0);
    assert.equal(out.childIds.length, 2);
    assert.equal(h.board.get(out.workItemId)?.state, "READY");
    for (const childId of out.childIds) {
      assert.equal(h.board.get(childId)?.parentId, out.workItemId);
    }
    const planned = h.published.find((p) => p.type === "work.planned");
    assert.ok(planned, "expected a work.planned publish");
    assert.equal((planned.payload as { workItemId: string }).workItemId, out.workItemId);
    assert.equal(h.published.some((p) => p.type === "delegation.routed"), false, "planning must not emit delegation.routed");
    const activity = h.orch.activityList({ workItemId: out.workItemId }, "VERBOSE");
    assert.ok(activity.some((e) => e.kind === "plan"), "expected a plan trace entry");
  } finally {
    h.close();
  }
});

// ── runWorkItem: full PASS loop ───────────────────────────────────────────────

test("runWorkItem full PASS loop completes with handoff, verification, review, and value", async () => {
  // Review AUTO requires level >= 3 (level 2 parks reviews for a human).
  const h = harness(3);
  try {
    h.state.reviewQueue.push({ verdict: "PASS", findings: [] });
    h.state.delegateQueue.push({ ok: true, reply: okReply(DELIVERABLE) });
    const started = h.orch.startObjective({ objective: OBJ, deliverable: DELIVERABLE });
    assert.equal(started.delegated, false, "planning alone never delegates");
    assert.equal(started.planned, true);

    const out = await h.orch.runWorkItem(started.workItemId, { workerId: "worker-1" });
    assert.equal(out.state, "COMPLETED");
    assert.ok(out.handoff, "expected a handoff");
    assert.equal(out.handoff.status, "ok");
    assert.ok(out.verification, "expected a verification record");
    // Structural verification records criteria as UNVERIFIED (substring
    // matching is gone); the Gate passed via the independent review PASS.
    assert.ok(out.verification.criteria.some((c) => c.name.startsWith("criterion:") && !c.met), "criteria stay honestly unverified in the structural record");
    assert.ok(out.review, "expected a review verdict");
    assert.equal(out.review.verdict, "PASS");
    assert.equal(typeof out.valueScore, "number");
    assert.ok((out.valueScore ?? 0) > 0, "expected a positive value score");

    const profile = h.bench.getProfile("worker-1");
    assert.ok(profile, "expected a bench profile for the worker");
    assert.ok(profile.totalSamples >= 1);
    assert.ok(h.orch.benchList().some((e) => e !== null && e.profile.workerId === "worker-1"));

    const activity = h.orch.activityList({ workItemId: started.workItemId }, "VERBOSE");
    assert.ok(activity.some((e) => e.kind === "done"), "expected a done trace entry");
    assert.ok(h.published.some((p) => p.type === "worker.completed"), "expected a worker.completed publish");
  } finally {
    h.close();
  }
});

// ── ASK parking + approval resume / reject ────────────────────────────────────

test("ASK delegate parks to WAITING and onApprovalDecided(true) resumes to COMPLETED", async () => {
  const h = harness(3);
  try {
    h.state.delegateQueue.push(
      { ok: false, parkedApprovalId: "appr-1" },
      { ok: true, reply: okReply(DELIVERABLE) },
    );
    h.state.reviewQueue.push({ verdict: "PASS", findings: [] });
    const started = h.orch.startObjective({ objective: OBJ, deliverable: DELIVERABLE });

    const parked = await h.orch.runWorkItem(started.workItemId, { workerId: "worker-1" });
    assert.equal(parked.state, "WAITING");
    assert.equal(parked.parkedApprovalId, "appr-1");
    assert.equal(h.board.get(started.workItemId)?.state, "WAITING");
    assert.equal(h.orch.ownsApproval("appr-1"), true);

    const resumed = await h.orch.onApprovalDecided("appr-1", true);
    assert.ok(resumed.handled >= 1);
    assert.equal(h.board.get(started.workItemId)?.state, "COMPLETED");
    assert.equal(h.orch.ownsApproval("appr-1"), false);
  } finally {
    h.close();
  }
});

test("rejected approval cancels the parked work item", async () => {
  const h = harness(3);
  try {
    h.state.delegateQueue.push({ ok: false, parkedApprovalId: "appr-9" });
    const started = h.orch.startObjective({ objective: OBJ });
    const parked = await h.orch.runWorkItem(started.workItemId, { workerId: "worker-1" });
    assert.equal(parked.state, "WAITING");

    const decided = await h.orch.onApprovalDecided("appr-9", false);
    assert.equal(decided.handled, 1);
    assert.equal(h.board.get(started.workItemId)?.state, "CANCELLED");
  } finally {
    h.close();
  }
});

// ── Review retry paths ────────────────────────────────────────────────────────

test("CHANGES_REQUESTED parks the retry for a FRESH approval, then completes", async () => {
  const h = harness(3);
  try {
    h.state.reviewQueue.push(
      { verdict: "CHANGES_REQUESTED", findings: ["add evidence"] },
      { verdict: "CHANGES_REQUESTED", findings: ["add evidence"] },
      { verdict: "PASS", findings: [] },
    );
    h.state.delegateQueue.push(
      { ok: true, reply: okReply(DELIVERABLE) },
      { ok: true, reply: okReply(DELIVERABLE) },
    );
    const started = h.orch.startObjective({ objective: OBJ, deliverable: DELIVERABLE });

    // The review asks for changes; the retry is a NEW external execution, so
    // it parks for a fresh approval instead of spending the old one twice.
    const parked = await h.orch.runWorkItem(started.workItemId, { workerId: "worker-1" });
    assert.equal(parked.state, "WAITING");
    assert.ok(parked.parkedApprovalId !== undefined && parked.parkedApprovalId.length > 0, "a fresh approval linkage is recorded");

    const decided = await h.orch.onApprovalDecided(parked.parkedApprovalId as string, true);
    assert.ok(decided.handled >= 1);
    assert.equal(h.board.get(started.workItemId)?.state, "COMPLETED");
    assert.equal(h.state.delegateCalls.length, 2, "expected exactly one retry delegation");
    assert.equal(h.board.get(started.workItemId)?.retries, 1);
  } finally {
    h.close();
  }
});

test("spent retry budget fails instead of retrying forever", async () => {
  const h = harness(3);
  try {
    h.state.reviewQueue.push(
      { verdict: "CHANGES_REQUESTED", findings: ["still thin"] },
      { verdict: "CHANGES_REQUESTED", findings: ["still thin"] },
    );
    h.state.delegateQueue.push({ ok: true, reply: okReply(DELIVERABLE) });
    const started = h.orch.startObjective({ objective: OBJ, deliverable: DELIVERABLE });

    // Spend the maxRetries=2 budget up front: two review/changes cycles.
    must(h.board.review(started.workItemId, "r-1"));
    must(h.board.changesRequested(started.workItemId, ["fix it"]));
    must(h.board.review(started.workItemId, "r-1"));
    must(h.board.changesRequested(started.workItemId, ["again"]));
    assert.equal(h.board.get(started.workItemId)?.retries, 2);

    const out = await h.orch.runWorkItem(started.workItemId, { workerId: "worker-1" });
    assert.equal(out.state, "FAILED");
    assert.match(out.note, /retry budget spent/);
  } finally {
    h.close();
  }
});

test("BLOCKED review verdict blocks the work item", async () => {
  const h = harness(3);
  try {
    h.state.reviewQueue.push({ verdict: "BLOCKED", findings: ["no access to the repo"] });
    h.state.delegateQueue.push({ ok: true, reply: okReply(DELIVERABLE) });
    const started = h.orch.startObjective({ objective: OBJ, deliverable: DELIVERABLE });

    const out = await h.orch.runWorkItem(started.workItemId, { workerId: "worker-1" });
    assert.equal(out.state, "BLOCKED");
    assert.equal(out.review?.verdict, "BLOCKED");
    assert.deepEqual(out.review?.findings, ["no access to the repo"]);
    assert.equal(h.board.get(started.workItemId)?.state, "BLOCKED");
  } finally {
    h.close();
  }
});

// ── Breaker ───────────────────────────────────────────────────────────────────

test("a failed delegate consults the circuit breaker", async () => {
  const h = harness();
  try {
    for (let i = 0; i < 3; i++) h.state.delegateQueue.push({ ok: false, error: "boom" });
    const ids = [0, 1, 2].map(() => h.orch.startObjective({ objective: OBJ }).workItemId);
    let last = "";
    let note = "";
    for (const id of ids) {
      const out = await h.orch.runWorkItem(id, { workerId: "worker-1" });
      assert.equal(out.state, "FAILED");
      last = out.state;
      note = out.note;
    }
    assert.equal(last, "FAILED");
    assert.match(note, /recommended:/, "the third consecutive failure should trip the breaker");
  } finally {
    h.close();
  }
});

// ── handoffFromText / verifyHandoff ───────────────────────────────────────────

test("handoffFromText parses full, partial, and garbage replies", () => {
  const h = harness();
  try {
    const full = h.orch.handoffFromText(okReply(DELIVERABLE));
    assert.equal(full.status, "ok");
    assert.ok(full.result.includes(DELIVERABLE));
    assert.deepEqual(full.changedArtifacts, ["src/a.ts"]);
    assert.deepEqual(full.evidence, ["tests pass"]);
    assert.ok(full.tests !== undefined && full.tests.includes("18/18"));
    assert.deepEqual(full.blockers, []);
    assert.deepEqual(full.toolsUsed, ["read", "edit"]);
    assert.equal(full.recommendedNext, "ship it");

    const partial = h.orch.handoffFromText("did the thing");
    assert.equal(partial.status, "ok");
    assert.equal(partial.result, "did the thing");
    assert.deepEqual(partial.evidence, []);
    assert.deepEqual(partial.blockers, []);

    const garbage = h.orch.handoffFromText("??? !!!");
    assert.equal(garbage.status, "ok");
    assert.equal(garbage.result, "??? !!!");

    const blocked = h.orch.handoffFromText("STATUS: blocked\nBLOCKERS: waiting on API");
    assert.equal(blocked.status, "blocked");
    assert.deepEqual(blocked.blockers, ["waiting on API"]);

    const failed = h.orch.handoffFromText("STATUS: failed\nRESULT: broke");
    assert.equal(failed.status, "failed");
  } finally {
    h.close();
  }
});

test("verifyHandoff is structural: criteria stay unverified, never substring-matched", () => {
  const h = harness();
  try {
    const good = h.orch.handoffFromText(okReply(DELIVERABLE));
    const structural = h.orch.verifyHandoff(good, [DELIVERABLE]);
    // Structural checks pass; the criterion is recorded UNVERIFIED — the old
    // substring hit ("deliverable" appearing in the result) is gone.
    assert.ok(structural.criteria.some((c) => c.name === "deliverable present" && c.met));
    assert.ok(structural.criteria.some((c) => c.name === "evidence cited" && c.met));
    const crit = structural.criteria.find((c) => c.name.startsWith("criterion:"));
    assert.ok(crit !== undefined && !crit.met, "criteria are never substring-matched");
    assert.match(crit?.detail ?? "", /unverified/);

    const noEvidence = h.orch.verifyHandoff({ ...good, evidence: [] }, [DELIVERABLE]);
    assert.equal(noEvidence.passed, false);
    assert.ok(noEvidence.criteria.some((c) => c.name === "evidence cited" && !c.met));

    const blocked = h.orch.verifyHandoff({ ...good, blockers: ["waiting on API"] }, [DELIVERABLE]);
    assert.equal(blocked.passed, false);
    assert.ok(blocked.criteria.some((c) => c.name === "no unresolved blockers" && !c.met));
  } finally {
    h.close();
  }
});

// ── nextMove ──────────────────────────────────────────────────────────────────

test("nextMove maps every work-item state to its move", () => {
  const h = harness();
  try {
    const mk = (objective: string): string => must(h.board.create({ objective })).id;

    const ready = mk("ready work");
    assert.deepEqual(h.orch.nextMove(ready), { action: "assign", reason: "work item is ready for a worker" });

    const claimed = mk("claimed work");
    must(h.board.claim(claimed, "worker-1"));
    assert.equal(h.orch.nextMove(claimed).action, "observe");

    const running = mk("running work");
    must(h.board.claim(running, "worker-1"));
    must(h.board.heartbeat(running, "step-1"));
    assert.equal(h.orch.nextMove(running).action, "observe");

    const waiting = mk("waiting work");
    must(h.board.claim(waiting, "worker-1"));
    must(h.board.wait(waiting, "need input"));
    assert.equal(h.orch.nextMove(waiting).action, "wait");

    const review = mk("review work");
    must(h.board.claim(review, "worker-1"));
    must(h.board.review(review, "r-1"));
    assert.equal(h.orch.nextMove(review).action, "review");

    const changes = mk("changes work");
    must(h.board.claim(changes, "worker-1"));
    must(h.board.review(changes, "r-1"));
    must(h.board.changesRequested(changes, ["fix it"]));
    assert.equal(h.orch.nextMove(changes).action, "retry");

    const completed = mk("completed work");
    must(h.board.claim(completed, "worker-1"));
    must(h.board.complete(completed, okHandoffObj()));
    assert.equal(h.orch.nextMove(completed).action, "stop");

    const blocked = mk("blocked work");
    must(h.board.claim(blocked, "worker-1"));
    must(h.board.block(blocked, "dependency down"));
    assert.equal(h.orch.nextMove(blocked).action, "ask");

    const failed = mk("failed work");
    must(h.board.claim(failed, "worker-1"));
    must(h.board.fail(failed, "boom"));
    assert.equal(h.orch.nextMove(failed).action, "recover");

    const cancelled = mk("cancelled work");
    must(h.board.cancel(cancelled));
    assert.equal(h.orch.nextMove(cancelled).action, "stop");

    assert.equal(h.orch.nextMove("work_missing_0").action, "stop");
  } finally {
    h.close();
  }
});

// ── inspect / proposeSkill / ownsApproval ─────────────────────────────────────

test("inspect returns the item with children, activity, and benchmark", async () => {
  const h = harness(3);
  try {
    h.state.reviewQueue.push({ verdict: "PASS", findings: [] });
    h.state.delegateQueue.push({ ok: true, reply: okReply(DELIVERABLE) });
    const started = h.orch.startObjective({
      objective: OBJ,
      deliverable: DELIVERABLE,
      subtasks: ["Book the venue", "Order the food"],
    });
    await h.orch.runWorkItem(started.workItemId, { workerId: "worker-1" });

    const insp = h.orch.inspect(started.workItemId);
    assert.ok(insp.item, "expected the item");
    assert.equal(insp.item?.state, "COMPLETED");
    assert.equal(insp.children.length, 2);
    assert.ok(insp.activity.length > 0);
    assert.ok(insp.benchmark, "expected benchmark evidence after completion");
    assert.equal(insp.benchmark?.profile.workerId, "worker-1");

    const missing = h.orch.inspect("work_missing_0");
    assert.equal(missing.item, null);
    assert.deepEqual(missing.children, []);
  } finally {
    h.close();
  }
});

test("proposeSkill returns a candidate for completed-with-failures work", () => {
  const h = harness();
  try {
    const id = must(h.board.create({ objective: "Migrate the settings screen" })).id;
    must(h.board.claim(id, "worker-1"));
    must(h.board.fail(id, "boom"));
    must(h.board.claim(id, "worker-1"));
    must(h.board.complete(id, okHandoffObj("migrated the screen")));

    const candidate = h.orch.proposeSkill(id);
    assert.ok(candidate, "expected a skill candidate");
    assert.equal(candidate?.pattern, "recovery");

    const fresh = must(h.board.create({ objective: "Untouched work" })).id;
    assert.equal(h.orch.proposeSkill(fresh), null);
    assert.equal(h.orch.proposeSkill("work_missing_0"), null);
  } finally {
    h.close();
  }
});

test("ownsApproval tracks parked approvals and releases them", async () => {
  const h = harness(3);
  try {
    h.state.delegateQueue.push({ ok: false, parkedApprovalId: "appr-7" });
    const started = h.orch.startObjective({ objective: OBJ });
    const parked = await h.orch.runWorkItem(started.workItemId, { workerId: "worker-1" });
    assert.equal(parked.state, "WAITING");

    assert.equal(h.orch.ownsApproval("appr-7"), true);
    assert.equal(h.orch.ownsApproval("appr-nope"), false);

    await h.orch.onApprovalDecided("appr-7", false);
    assert.equal(h.orch.ownsApproval("appr-7"), false);
    assert.equal(h.board.get(started.workItemId)?.state, "CANCELLED");
  } finally {
    h.close();
  }
});
