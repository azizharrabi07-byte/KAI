// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Campaign: does ONE settlement produce exactly ONE authoritative completion?
 *
 * A completion has two observable effects: `board.complete(...)` (which emits a
 * board-level `worker.completed`) and the orchestrator's own `worker.completed`
 * carrying the gate verdict. Two board-level completions for one item would mean
 * the item was settled twice. This wraps the real board in a counting proxy so
 * the count is measured, not inferred.
 *
 * Run from `core/`:  node --test tests/campaign-completion-once.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createWorkBoard, type WorkBoard } from "../src/orchestration/board.ts";
import { createBenchmark } from "../src/orchestration/bench.ts";
import { createDispatcher } from "../src/orchestration/dispatch.ts";
import { createTrace } from "../src/orchestration/trace.ts";
import { createLearning } from "../src/orchestration/learn.ts";
import { createOrchestrator } from "../src/orchestration/orchestrator.ts";
import type { AutonomyPolicy } from "../src/orchestration/types.ts";
import { openSqliteStores } from "../src/storage/sqlite.ts";

const OBJ = "Make the poller stop busy-waiting";
const DELIVERABLE = "the patched poller";
const WORKDIR = "C:/tmp/project";

function autonomy(review: "AUTO" | "ASK" = "ASK"): AutonomyPolicy {
  return {
    level: 2,
    workerAuto: "AUTO",
    review,
    skillLearning: "PROPOSE",
    budgets: { maxDepth: 2, maxRetries: 2 },
    maxDepth: 2,
    maxParallel: 3,
    taskRetentionDays: 30,
  };
}

function okReply(): string {
  return [
    "STATUS: ok",
    `RESULT: Delivered ${DELIVERABLE}.`,
    "CHANGED ARTIFACTS: src/a.ts",
    "EVIDENCE: tests pass",
    "TESTS: npm test — 18/18 passed",
    "BLOCKERS: (none)",
    "RISKS: none",
    "FOLLOW-UPS: none",
    "RECOMMENDED NEXT STEP: ship",
    "TOOLS USED: read",
  ].join("\n");
}

test("a failed item re-attempted to success still completes exactly once", async () => {
  const stores = openSqliteStores({ path: ":memory:" });
  try {
    const realBoard = createWorkBoard(stores.workItems);
    const completes: string[] = [];
    const board: WorkBoard = {
      ...realBoard,
      complete: (id, handoff, extra) => {
        completes.push(id);
        return realBoard.complete(id, handoff, extra);
      },
    };
    const bench = createBenchmark(stores.workerProfiles);
    const dispatcher = createDispatcher({
      bench,
      availability: () => ["worker-1"],
      capabilities: () => ({ skills: ["typescript"], tools: ["read"] }),
    });
    const trace = createTrace({ store: stores.activity, prefs: () => ({ activity: "VERBOSE", reasoning: "SUMMARY" }) as const });
    const learning = createLearning({ metrics: stores.skillMetrics, validate: () => ({ ok: true }), stage: () => ({ ok: true }) });
    const published: { type: string; payload: unknown }[] = [];
    let failNext = true;
    const orch = createOrchestrator({
      board,
      bench,
      dispatcher,
      trace,
      learning,
      patterns: stores.promptPatterns,
      reviewRunner: async () => ({ verdict: "PASS" as const, findings: [] }),
      delegate: async () => {
        if (failNext) {
          failNext = false;
          return { ok: false as const, error: "worker unreachable" };
        }
        return { ok: true as const, reply: okReply() };
      },
      skills: { relevant: () => [], load: () => ({ ok: false, reason: "missing" }) },
      policyCheck: async () => ({ outcome: "allow" as const, reason: "allowed" }),
      approvals: { request: () => ({ id: `ap_${Math.random().toString(36).slice(2, 8)}` }), get: () => ({ status: "PENDING" }) },
      autonomy: () => autonomy("AUTO"),
      publish: (type, payload) => published.push({ type, payload }),
      tools: { invoke: async () => ({ ok: true, result: { exists: true, size: 10 } }) },
    });

    const started = orch.startObjective(
      { objective: OBJ, deliverable: DELIVERABLE, requiredEvidence: ["file present: src/a.ts"], workingDir: WORKDIR },
      ["worker-1"],
    );
    const id = started.workItemId;
    const first = await orch.runWorkItem(id, { workerId: "worker-1" });
    assert.equal(first.state, "FAILED", `the first attempt fails honestly: ${first.note}`);
    assert.deepEqual(completes, [], "a failure must never call board.complete");
    const second = await orch.runWorkItem(id, { workerId: "worker-1" });
    assert.equal(second.state, "COMPLETED", second.note);
    // The parent may legitimately settle a corrective CHILD as well (the gate
    // demanded evidence the first evaluation did not have, so a bounded
    // correction ran). The invariant is that NO item is settled twice, and that
    // the parent itself is settled exactly once with a PASS gate.
    assert.equal(
      completes.filter((c) => c === id).length,
      1,
      `the item must be settled exactly once, got ${JSON.stringify(completes)}`,
    );
    assert.equal(new Set(completes).size, completes.length, `no item may be settled twice: ${JSON.stringify(completes)}`);
    const parentGate = published
      .filter((p) => p.type === "worker.completed" && (p.payload as { workItemId?: string }).workItemId === id)
      .map((p) => (p.payload as { gate?: string }).gate);
    assert.deepEqual(parentGate, ["PASS"], `the parent must have exactly one PASS-gated completion, got ${JSON.stringify(parentGate)}`);
  } finally {
    stores.close();
  }
});

test("one settlement produces exactly one board.complete and one gate-carrying completion event", async () => {
  const stores = openSqliteStores({ path: ":memory:" });
  try {
    const realBoard = createWorkBoard(stores.workItems);
    const completes: string[] = [];
    // Counting proxy over the REAL board: every other call passes straight through.
    const board: WorkBoard = {
      ...realBoard,
      complete: (id, handoff, extra) => {
        completes.push(id);
        return realBoard.complete(id, handoff, extra);
      },
    };

    const bench = createBenchmark(stores.workerProfiles);
    const dispatcher = createDispatcher({
      bench,
      availability: () => ["worker-1"],
      capabilities: () => ({ skills: ["typescript"], tools: ["read"] }),
    });
    const trace = createTrace({ store: stores.activity, prefs: () => ({ activity: "VERBOSE", reasoning: "SUMMARY" }) as const });
    const learning = createLearning({ metrics: stores.skillMetrics, validate: () => ({ ok: true }), stage: () => ({ ok: true }) });
    const published: { type: string; payload: unknown }[] = [];
    let policy = autonomy("ASK");

    const orch = createOrchestrator({
      board,
      bench,
      dispatcher,
      trace,
      learning,
      patterns: stores.promptPatterns,
      reviewRunner: async () => ({ verdict: "PASS" as const, findings: [] }),
      delegate: async () => ({ ok: true as const, reply: okReply() }),
      skills: { relevant: () => [], load: () => ({ ok: false, reason: "missing" }) },
      policyCheck: async () => ({ outcome: "allow" as const, reason: "allowed" }),
      approvals: {
        request: () => ({ id: `ap_${completes.length}_${Math.random().toString(36).slice(2, 6)}` }),
        get: () => ({ status: "PENDING" }),
      },
      autonomy: () => policy,
      publish: (type, payload) => published.push({ type, payload }),
      tools: { invoke: async () => ({ ok: true, result: { exists: true, size: 10 } }) },
    });

    const started = orch.startObjective(
      { objective: OBJ, deliverable: DELIVERABLE, requiredEvidence: ["file present: src/a.ts"], workingDir: WORKDIR },
      ["worker-1"],
    );
    const id = started.workItemId;

    // Drive the parks to settlement: delegation park, then review park.
    for (let i = 0; i < 4; i += 1) {
      const cur = board.get(id);
      if (cur === null) break;
      if (["COMPLETED", "FAILED", "CANCELLED", "BLOCKED"].includes(cur.state)) break;
      const parked = (cur.outputs as { parked?: { approvalId?: string } } | undefined)?.parked?.approvalId;
      if (parked !== undefined) {
        await orch.onApprovalDecided(parked, true);
        continue;
      }
      await orch.runWorkItem(id, { workerId: "worker-1" });
    }

    const item = board.get(id);
    assert.equal(item?.state, "COMPLETED", `the item should settle: ${item?.state}`);
    assert.deepEqual(completes, [id], `exactly one authoritative completion, got ${JSON.stringify(completes)}`);
    const gateEvents = published.filter((p) => p.type === "worker.completed");
    const gateVerdicts = gateEvents.map((p) => (p.payload as { gate?: string }).gate).filter((g) => g !== undefined);
    assert.deepEqual(gateVerdicts, ["PASS"], `exactly one gate-carrying completion, got ${JSON.stringify(gateVerdicts)}`);
    // Review is ASK in this scenario, so a human verdict is what cleared it.
    assert.ok(gateEvents.length >= 1, "a completion event was emitted");
  } finally {
    stores.close();
  }
});
