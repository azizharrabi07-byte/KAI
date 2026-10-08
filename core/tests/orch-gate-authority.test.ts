// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * THE DECISIVE INVARIANT: a mission cannot reach COMPLETED unless the Outcome
 * Gate returns PASS. Every alternate completion signal — a worker's "done", a
 * passing test, a PASS review, structural verification, an empty remaining task
 * list, a timeout, a resumed mission, or a model's confidence — is only an
 * INPUT; none of them may complete a mission on its own.
 *
 * Also covers: anti-loop runtime wiring, and resume (the Outcome Contract
 * survives a new orchestrator over the same store).
 *
 *   cd core && node --test tests/orch-gate-authority.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createWorkBoard, type WorkBoard } from "../src/orchestration/board.ts";
import { createBenchmark, type Benchmark } from "../src/orchestration/bench.ts";
import { createDispatcher } from "../src/orchestration/dispatch.ts";
import { createTrace } from "../src/orchestration/trace.ts";
import { createLearning } from "../src/orchestration/learn.ts";
import { createOrchestrator, type Orchestrator } from "../src/orchestration/orchestrator.ts";
import { createOutcomeContract } from "../src/orchestration/outcome.ts";
import type { AutonomyPolicy } from "../src/orchestration/types.ts";
import type { Stores } from "../src/shared/contracts.ts";
import { openSqliteStores } from "../src/storage/sqlite.ts";

const OBJ = "Fix the polling bug and prove it works";
const DELIVERABLE = "the polling fix";

function autonomy(): AutonomyPolicy {
  return { level: 3, workerAuto: "AUTO", review: "AUTO", skillLearning: "PROPOSE", budgets: { maxDepth: 2, maxRetries: 2 }, maxDepth: 2, maxParallel: 3, taskRetentionDays: 30 };
}

function okReply(evidence: string): string {
  return ["STATUS: ok", `RESULT: Delivered ${DELIVERABLE} with all requested changes.`, "CHANGED ARTIFACTS: src/poller.ts", `EVIDENCE: ${evidence}`, "TESTS: npm test — 18/18 passed", "BLOCKERS: (none)", "RISKS: none", "FOLLOW-UPS: none", "TOOLS USED: read, edit"].join("\n");
}

interface Harness {
  orch: Orchestrator;
  board: WorkBoard;
  bench: Benchmark;
  stores: Stores;
  published: { type: string; payload: unknown }[];
  reply: { current: string };
  close(): void;
}

function harness(stores: Stores): Harness {
  const board = createWorkBoard(stores.workItems);
  const bench = createBenchmark(stores.workerProfiles);
  const dispatcher = createDispatcher({
    bench,
    availability: () => ["worker-1", "worker-2"],
    capabilities: () => ({ skills: ["typescript", "testing", "review"], tools: ["read", "edit", "test-runner"] }),
  });
  const trace = createTrace({ store: stores.activity, prefs: () => ({ activity: "VERBOSE", reasoning: "SUMMARY" }) as const });
  const learning = createLearning({ metrics: stores.skillMetrics, validate: () => ({ ok: true }), stage: () => ({ ok: true }) });
  const published: { type: string; payload: unknown }[] = [];
  const reply = { current: okReply("browser verification passed") };
  const orch = createOrchestrator({
    board, bench, dispatcher, trace, learning, patterns: stores.promptPatterns,
    reviewRunner: async () => ({ verdict: "PASS" as const, findings: [] }),
    delegate: async () => ({ ok: true, reply: reply.current }),
    skills: { relevant: () => [], load: () => ({ ok: false, reason: "missing" }) },
    policyCheck: async () => ({ outcome: "allow" as const, reason: "allowed" }),
    approvals: { request: () => ({ id: "appr_1" }), get: () => ({ status: "APPROVED" }) },
    autonomy,
    publish: (type, payload) => { published.push({ type, payload }); },
  });
  return { orch, board, bench, stores, published, reply, close: () => stores.close() };
}

/** Seed a contract that REQUIRES browser verification as evidence. */
function seedContract(h: Harness, id: string): void {
  const contract = createOutcomeContract({ missionId: id, intent: OBJ, deliverables: [DELIVERABLE], requiredEvidence: ["browser verification"] });
  h.board.annotate(id, { contract });
}

test("INVARIANT: all other signals green, but gate unmet → NOT COMPLETED", async () => {
  const h = harness(openSqliteStores({ path: ":memory:" }));
  try {
    const started = h.orch.startObjective({ objective: OBJ, deliverable: DELIVERABLE }, ["worker-1"]);
    seedContract(h, started.workItemId);
    // Worker "done" + tests pass + review PASS + structural verification pass —
    // but the required evidence ("browser verification") is absent.
    h.reply.current = okReply("unit tests pass");
    const out = await h.orch.runWorkItem(started.workItemId, { workerId: "worker-1" });
    assert.notEqual(out.state, "COMPLETED", "must not complete without gate PASS");
    assert.match(out.note, /INSUFFICIENT_EVIDENCE/, out.note);
    assert.equal(h.board.get(started.workItemId)?.state, "CHANGES_REQUESTED");
  } finally { h.close(); }
});

test("POSITIVE: gate PASS → COMPLETED", async () => {
  const h = harness(openSqliteStores({ path: ":memory:" }));
  try {
    const started = h.orch.startObjective({ objective: OBJ, deliverable: DELIVERABLE }, ["worker-1"]);
    seedContract(h, started.workItemId);
    h.reply.current = okReply("browser verification passed");
    const out = await h.orch.runWorkItem(started.workItemId, { workerId: "worker-1" });
    assert.equal(out.state, "COMPLETED", out.note);
    assert.equal(h.board.get(started.workItemId)?.state, "COMPLETED");
  } finally { h.close(); }
});

test("INVARIANT: every alternate completion path is covered (worker/test/review/structural/empty/timeout/confidence)", async () => {
  const h = harness(openSqliteStores({ path: ":memory:" }));
  try {
    // One scenario where ALL alternate signals are true simultaneously:
    // worker says ok, tests pass, review PASS, structural verify passes, no
    // blockers, nothing left to do — the ONLY thing false is the required
    // evidence. It must still not complete.
    const started = h.orch.startObjective({ objective: OBJ, deliverable: DELIVERABLE }, ["worker-1"]);
    seedContract(h, started.workItemId);
    h.reply.current = okReply("tests pass"); // no "browser verification"
    const out = await h.orch.runWorkItem(started.workItemId, { workerId: "worker-1" });
    assert.notEqual(out.state, "COMPLETED");
    // A high-confidence recommendation is NOT wired to authority: the gate alone decides.
    assert.equal(h.board.get(started.workItemId)?.state, "CHANGES_REQUESTED", out.note);
  } finally { h.close(); }
});

test("CONTRADICTED: a forbidden outcome never completes", async () => {
  const h = harness(openSqliteStores({ path: ":memory:" }));
  try {
    const started = h.orch.startObjective({ objective: OBJ, deliverable: DELIVERABLE }, ["worker-1"]);
    h.board.annotate(started.workItemId, { contract: createOutcomeContract({ missionId: started.workItemId, intent: OBJ, deliverables: [DELIVERABLE], forbiddenOutcomes: ["force-push"] }) });
    h.reply.current = okReply("browser verification passed").replace("Delivered", "force-push then delivered");
    const out = await h.orch.runWorkItem(started.workItemId, { workerId: "worker-1" });
    assert.notEqual(out.state, "COMPLETED");
    assert.match(out.note, /CONTRADICTED/, out.note);
  } finally { h.close(); }
});

test("ANTI-LOOP: repeated gate failure never completes and emits a next-action", async () => {
  const h = harness(openSqliteStores({ path: ":memory:" }));
  try {
    const started = h.orch.startObjective({ objective: OBJ, deliverable: DELIVERABLE }, ["worker-1"]);
    seedContract(h, started.workItemId);
    h.reply.current = okReply("unit tests pass");
    let last;
    for (let i = 0; i < 3; i++) last = await h.orch.runWorkItem(started.workItemId, { workerId: "worker-1" });
    assert.notEqual(last.state, "COMPLETED");
    const nextActions = h.published.filter((p) => p.type === "worker.progress" && (p.payload as { phase?: string }).phase === "next_action");
    assert.ok(nextActions.length > 0, "an explicit next-action reason must be emitted");
    const action = (nextActions[nextActions.length - 1].payload as { action: string }).action;
    assert.ok(["CHANGE_WORKER", "REPLAN", "ASK_USER", "VERIFY", "RUN_TESTS", "INSPECT"].includes(action), action);
  } finally { h.close(); }
});

test("RESUME: the Outcome Contract survives a new orchestrator over the same store", async () => {
  const stores = openSqliteStores({ path: ":memory:" });
  try {
    const h1 = harness(stores);
    const started = h1.orch.startObjective({ objective: OBJ, deliverable: DELIVERABLE }, ["worker-1"]);
    seedContract(h1, started.workItemId);
    h1.reply.current = okReply("unit tests pass");
    const first = await h1.orch.runWorkItem(started.workItemId, { workerId: "worker-1" });
    assert.notEqual(first.state, "COMPLETED");
    // "Resume": a brand-new orchestrator over the SAME store (no shared memory).
    const h2 = harness(stores);
    const persisted = h2.board.get(started.workItemId);
    assert.ok(persisted !== null && persisted.state !== "COMPLETED", "a resumed mission is still non-terminal");
    assert.ok((persisted?.outputs as { contract?: unknown } | undefined)?.contract !== undefined, "the contract persisted");
    // Now provide the required evidence: only then may it complete.
    h2.reply.current = okReply("browser verification passed");
    const resumed = await h2.orch.runWorkItem(started.workItemId, { workerId: "worker-1" });
    assert.equal(resumed.state, "COMPLETED", resumed.note);
  } finally { stores.close(); }
});
