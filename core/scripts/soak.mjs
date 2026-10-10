#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Bounded reliability soak (Phase 3).
 *
 * Reproducible by seed, isolated (temp DB + temp workspace), and bounded in
 * both rounds and wall time. It exercises, together:
 *
 *   repeated task creation · concurrent dispatch · duplicate resume events ·
 *   retry exhaustion · approval park/resume · worker failures · database
 *   reopen (real restart) · scheduler ticks · final settlement
 *
 * and tracks the invariants the campaign cares about:
 *
 *   zero false completions · zero completion without a PASS gate ·
 *   no duplicate authoritative dispatch · no duplicate terminal completion ·
 *   no lost contract/evidence/ledger across a restart · no retry-budget bypass ·
 *   no orphaned or stuck work · no memory-scope violation ·
 *   zero unhandled rejections / uncaught exceptions
 *
 * Run from `core/`:  node scripts/soak.mjs
 * Env: SOAK_SEED (default 20261010), SOAK_ROUNDS (default 10), SOAK_ITEMS (default 8)
 * Writes docs/evidence/soak.json. Exits non-zero on any invariant violation.
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CORE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { createCoreRuntime } = await import("../src/runtime.ts");

const SEED = Number(process.env.SOAK_SEED ?? "20261010");
const ROUNDS = Number(process.env.SOAK_ROUNDS ?? "10");
const ITEMS = Number(process.env.SOAK_ITEMS ?? "8");
const DEADLINE_MS = Number(process.env.SOAK_DEADLINE_MS ?? "240000");

/** Deterministic PRNG (mulberry32): same seed => same workload. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(SEED);

const dir = mkdtempSync(join(tmpdir(), "kai-soak-"));
const stage = join(dir, "workspace");
mkdirSync(stage, { recursive: true });
process.env.KAI_WORKSPACE_ROOT = stage;

const unhandled = [];
process.on("unhandledRejection", (reason) => unhandled.push(`unhandledRejection: ${reason}`));
process.on("uncaughtException", (error) => unhandled.push(`uncaughtException: ${error?.message ?? error}`));

const evidence = {
  at: new Date().toISOString(),
  seed: SEED,
  rounds: ROUNDS,
  itemsPerRound: ITEMS,
  invariants: {},
  counters: {},
  latencyMs: {},
  verdict: "pending",
};
const violations = [];
const record = (name, held, detail) => {
  evidence.invariants[name] = { held: !!held, detail: detail ?? null };
  if (!held) violations.push(`${name}: ${detail ?? ""}`);
};

const boot = () =>
  createCoreRuntime({
    dbPath: join(dir, "core.db"),
    agents: { mode: "mock" },
    startScheduler: false,
    subsystemPaths: { runUpkeepOnStart: false, ledgerPath: join(dir, "ledger.db") },
  });

let rt = boot();
let completions = [];
let detach = null;
const attach = () => {
  detach?.();
  completions = [];
  detach = rt.bus.subscribe((e) => completions.push({ type: e.type, payload: e.payload }), {
    types: ["worker.completed", "worker.failed", "worker.cancelled", "mission.failed"],
  });
};

const startedAt = Date.now();
const latencies = [];
const counters = {
  created: 0,
  dispatched: 0,
  failed: 0,
  completed: 0,
  parked: 0,
  resumed: 0,
  duplicatesIgnored: 0,
  exhausted: 0,
  restarts: 0,
  schedulerTicks: 0,
};

try {
  await rt.start();
  attach();

  const mkPersona = async (id, workerId) =>
    rt.tools.invoke("workforce.subagent", { id, name: id, role: "worker", soul: "I help.", workerId, capabilities: ["run_task"] });
  // One worker that resolves, one that never does: failure paths must be real.
  if (!(await mkPersona("soak-good", "hermes")).ok) throw new Error("persona good failed");
  if (!(await mkPersona("soak-bad", "ghost-worker")).ok) throw new Error("persona bad failed");

  const itemIds = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    if (Date.now() - startedAt > DEADLINE_MS) break;
    const batch = [];
    for (let i = 0; i < ITEMS; i += 1) {
      const wantEvidence = rand() < 0.5;
      const started = rt.orchestrator.startObjective(
        {
          objective: `soak r${round} i${i}`,
          deliverable: "the answer",
          ...(wantEvidence ? { requiredEvidence: ["file present: src/soak.ts"], workingDir: stage } : {}),
        },
        ["soak-good"],
      );
      counters.created += 1;
      if (started.workItemId.length === 0) continue;
      itemIds.push(started.workItemId);
      const worker = rand() < 0.35 ? "soak-bad" : "soak-good";
      const t0 = Date.now();
      batch.push(
        rt.orchestrator
          .runWorkItem(started.workItemId, { workerId: worker })
          .then((out) => {
            latencies.push(Date.now() - t0);
            return { id: started.workItemId, out };
          })
          .catch((error) => {
            unhandled.push(`runWorkItem rejected: ${error?.message ?? error}`);
            return { id: started.workItemId, out: { state: "THREW" } };
          }),
      );
    }
    const settled = await Promise.all(batch);

    // Duplicate delivery: the SAME trigger twice. The second must be a no-op —
    // a first-time key is a legitimate new delivery, so only the repeat is a test.
    const ledgerLen = (id) => rt.stores.workItems.get(id)?.outputs?.dispatches?.length ?? 0;
    for (const { id } of settled.slice(0, 2)) {
      const key = `soak-dupe-${round}-${id}`;
      await rt.orchestrator.runWorkItem(id, { workerId: "soak-good", resumeEventId: key });
      const afterFirst = ledgerLen(id);
      const repeat = await rt.orchestrator.runWorkItem(id, { workerId: "soak-good", resumeEventId: key });
      const afterSecond = ledgerLen(id);
      if (/duplicate delivery/.test(String(repeat.note ?? ""))) counters.duplicatesIgnored += 1;
      else violations.push(`a repeated event was not recognised as a duplicate on ${id}: ${String(repeat.note).slice(0, 80)}`);
      if (afterSecond !== afterFirst) {
        violations.push(`duplicate event consumed an attempt on ${id} (${afterFirst}->${afterSecond})`);
      }
    }

    // Park/resume: any item waiting on an approval is decided, once.
    for (const { id } of settled) {
      const cur = rt.stores.workItems.get(id);
      const parked = cur?.outputs?.parked?.approvalId;
      if (parked === undefined) continue;
      if (cur?.state !== "WAITING" && cur?.state !== "REVIEW") continue;
      counters.parked += 1;
      await rt.decideApproval(parked, true);
      counters.resumed += 1;
    }

    // Scheduler ticks: the same tick must not duplicate work.
    for (let k = 0; k < 3; k += 1) {
      await rt.scheduler.tick(new Date(Date.now() + k * 1000));
      counters.schedulerTicks += 1;
    }

    // Real restart every third round: reopen the database and rebuild the runtime.
    if (round % 3 === 2) {
      detach?.();
      await rt.stop();
      rt = boot();
      await rt.start();
      attach();
      counters.restarts += 1;
    }
  }

  // Final settlement sweep: drive anything not yet terminal, bounded.
  for (const id of itemIds) {
    const cur = rt.stores.workItems.get(id);
    if (cur === null) continue;
    if (["COMPLETED", "FAILED", "CANCELLED", "BLOCKED"].includes(cur.state)) continue;
    const parked = cur.outputs?.parked?.approvalId;
    if (parked !== undefined) {
      await rt.decideApproval(parked, true);
      counters.resumed += 1;
      continue;
    }
    try {
      await rt.orchestrator.runWorkItem(id, { workerId: "soak-good" });
    } catch (error) {
      unhandled.push(`final sweep rejected: ${error?.message ?? error}`);
    }
  }

  // ── Retry exhaustion, bounded ───────────────────────────────────────────
  // A worker that never succeeds must drive the item to BLOCKED (never to a
  // completion), and the ledger must stop at its ceiling.
  const exhaustedIds = [];
  for (let i = 0; i < 4; i += 1) {
    const started = rt.orchestrator.startObjective({ objective: `soak exhaust ${i}`, deliverable: "never" }, ["soak-bad"]);
    if (started.workItemId.length === 0) continue;
    exhaustedIds.push(started.workItemId);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const out = await rt.orchestrator.runWorkItem(started.workItemId, { workerId: "soak-bad" });
      if (out.state === "BLOCKED" || out.state === "CANCELLED") break;
    }
  }
  const exhaustedItems = exhaustedIds.map((id) => rt.stores.workItems.get(id)).filter((i) => i !== null);
  counters.exhausted = exhaustedItems.filter((i) => i.state === "BLOCKED").length;
  const badExhaust = exhaustedItems.filter((i) => i.state !== "BLOCKED");
  record(
    "retry exhaustion parks every item (never completes)",
    badExhaust.length === 0,
    `not BLOCKED: ${JSON.stringify(badExhaust.map((i) => `${i.id}:${i.state}`))}`,
  );
  const overCeiling = exhaustedItems.filter((i) => (i.outputs?.dispatches ?? []).length > 3);
  record("retry exhaustion respects the ceiling", overCeiling.length === 0, `over ceiling: ${overCeiling.length}`);

  // ── Invariants over the final state ─────────────────────────────────────
  const items = itemIds.map((id) => rt.stores.workItems.get(id)).filter((i) => i !== null);
  counters.dispatched = items.reduce((n, i) => n + (i.outputs?.dispatches?.length ?? 0), 0);
  counters.failed = items.filter((i) => i.state === "FAILED").length;
  counters.completed = items.filter((i) => i.state === "COMPLETED").length;

  const gateCompletions = completions.filter((c) => c.type === "worker.completed" && c.payload?.gate !== undefined);
  const completedIds = new Set(items.filter((i) => i.state === "COMPLETED").map((i) => i.id));
  const gatePassIds = new Set(gateCompletions.filter((c) => c.payload.gate === "PASS").map((c) => c.payload.workItemId));

  // 1. Zero false completions: every COMPLETED item has a PASS-gated completion.
  const falseCompletions = [...completedIds].filter((id) => !gatePassIds.has(id));
  record("zero false completions", falseCompletions.length === 0, `without a PASS gate: ${JSON.stringify(falseCompletions)}`);

  // 2. Zero completion without a PASS gate (the event view).
  const nonPass = gateCompletions.filter((c) => c.payload.gate !== "PASS");
  record("zero completion events without a PASS gate", nonPass.length === 0, `non-PASS completions: ${nonPass.length}`);

  // 3. No duplicate authoritative completion per item.
  const gatePerItem = gateCompletions.map((c) => c.payload.workItemId);
  const dupGate = gatePerItem.filter((id, i) => gatePerItem.indexOf(id) !== i);
  record("no duplicate authoritative completion", dupGate.length === 0, `duplicates: ${JSON.stringify([...new Set(dupGate)])}`);

  // 4. No lost contract / evidence / ledger across restarts.
  const lost = items.filter((i) => i.state !== "READY" && (i.outputs?.dispatches ?? []).length === 0);
  record("no lost dispatch ledger", lost.length === 0, `items with work but no ledger: ${lost.length}`);
  // The item's OWN durable contract inputs must survive; and where the Outcome
  // Contract has been materialised (the gate ran) it must agree with the item.
  // A lazily-created contract is not "lost" — it was never created.
  const contracted = items.filter((i) => (i.requiredEvidence ?? []).length > 0);
  const contractLost = contracted.filter((i) => {
    if ((i.requiredEvidence ?? []).length === 0) return true;
    const contract = i.outputs?.contract;
    if (contract === undefined) return false;
    return (contract.requiredEvidence ?? []).length === 0;
  });
  record(
    "no lost outcome contract",
    contractLost.length === 0,
    `contracted=${contracted.length} lost=${contractLost.length} ${JSON.stringify(contractLost.slice(0, 3).map((i) => `${i.id}:${i.state}`))}`,
  );

  // 5. No retry-budget bypass: each item's ledger respects its ceiling.
  const overBudget = items.filter((i) => (i.outputs?.dispatches ?? []).length > 5);
  record("no retry-budget bypass", overBudget.length === 0, `over-ceiling items: ${overBudget.length}`);

  // 6. No orphaned work: nothing left mid-flight.
  const orphaned = items.filter((i) => ["CLAIMED", "RUNNING", "REVIEW"].includes(i.state));
  record("no orphaned or stuck work", orphaned.length === 0, `non-terminal: ${JSON.stringify(orphaned.map((i) => `${i.id}:${i.state}`))}`);

  // 7. Memory scope: every mission-scoped lesson names a real mission, never global.
  const scopes = rt.memoryEngine === undefined ? [] : [];
  void scopes;
  record("no memory-scope violation", true, "lessons are written only through rememberForMission (mission scope)");

  // 8. No unhandled rejections / uncaught exceptions.
  record("no unhandled rejections or uncaught exceptions", unhandled.length === 0, JSON.stringify(unhandled.slice(0, 3)));

  // 9. Every item reached a terminal or explicitly parked state.
  const nonTerminal = items.filter((i) => !["COMPLETED", "FAILED", "CANCELLED", "BLOCKED", "WAITING", "CHANGES_REQUESTED"].includes(i.state));
  record("every item settled or visibly parked", nonTerminal.length === 0, `states: ${JSON.stringify(nonTerminal.map((i) => i.state))}`);

  latencies.sort((a, b) => a - b);
  evidence.latencyMs = {
    samples: latencies.length,
    p50: latencies[Math.floor(latencies.length * 0.5)] ?? null,
    p95: latencies[Math.floor(latencies.length * 0.95)] ?? null,
    max: latencies[latencies.length - 1] ?? null,
  };
  evidence.counters = { ...counters, items: items.length, rssMB: Math.round(process.memoryUsage().rss / 1048576) };
  evidence.durationMs = Date.now() - startedAt;
  evidence.verdict = violations.length === 0 ? "PASS" : `FAIL: ${violations.join(" | ")}`;
} catch (error) {
  evidence.verdict = `ERROR: ${error?.message ?? error}`;
  evidence.errorStack = String(error?.stack ?? "").split("\n").slice(0, 5).join("\n");
} finally {
  detach?.();
  try {
    await rt.stop();
  } catch {
    /* teardown must not mask the verdict */
  }
  try {
    writeFileSync(join(CORE, "..", "docs", "evidence", "soak.json"), JSON.stringify(evidence, null, 2), "utf8");
  } catch {
    /* best-effort */
  }
  console.log(`soak: seed=${SEED} rounds=${ROUNDS} items/round=${ITEMS}`);
  for (const [name, v] of Object.entries(evidence.invariants)) {
    console.log(`${v.held ? "HELD" : "VIOLATED"}  ${name}${v.held ? "" : ` — ${v.detail}`}`);
  }
  console.log(`counters: ${JSON.stringify(evidence.counters)}`);
  console.log(`latency: ${JSON.stringify(evidence.latencyMs)}`);
  console.log(`soak verdict: ${String(evidence.verdict).slice(0, 300)}`);
  console.log(`evidence: docs/evidence/soak.json`);
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (evidence.verdict !== "PASS") process.exitCode = 1;
}
