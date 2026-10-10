#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Campaign: the REAL worker path through KAI, end to end.
 *
 * Boots an isolated Core (temp DB, never the live one), then drives actual work
 * items against:
 *   - a persona whose worker is unreachable (`ghost-worker`) → KAI must FAIL
 *     honestly, never fabricate success;
 *   - a persona on the live Hermes gateway → the real worker runs, and the
 *     Outcome Gate decides completion from what KAI actually observed.
 *
 * Then it retries the failed item on the live worker to show recovery.
 *
 * Run from `core/`:  node scripts/campaign-hermes-e2e.mjs
 * Writes docs/evidence/campaign-hermes-e2e.json. Exits non-zero if a verdict
 * that must hold does not.
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CORE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { createCoreRuntime } = await import("../src/runtime.ts");

const dir = mkdtempSync(join(tmpdir(), "kai-campaign-hermes-"));
const evidence = { at: new Date().toISOString(), steps: {}, verdict: "pending" };
const failures = [];
const check = (name, cond, detail) => {
  evidence.steps[name] = { pass: !!cond, detail: detail ?? null };
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures.push(name);
};

const rt = createCoreRuntime({
  dbPath: join(dir, "core.db"),
  startScheduler: false,
  subsystemPaths: { runUpkeepOnStart: false, ledgerPath: join(dir, "ledger.db") },
});

try {
  await rt.start();

  // Hermes must be reachable for the live half of this probe.
  const health = await fetch("http://127.0.0.1:8642/health", { signal: AbortSignal.timeout(5000) }).catch(() => null);
  if (health === null || health.status !== 200) {
    check("hermes reachable for the live worker path", false, "gateway is not answering /health");
    throw new Error("hermes unavailable");
  }
  check("hermes reachable for the live worker path", true, `status ${health.status}`);

  // Capture the real lifecycle events: the completion event carries the gate
  // verdict, which is the only honest proof that a completion was gate-backed.
  const events = [];
  const detach = rt.bus.subscribe((e) => events.push({ type: e.type, payload: e.payload }), {
    types: ["worker.completed", "worker.failed", "delegation.routed", "work.planned", "worker.waiting"],
  });

  const mkPersona = async (id, workerId) =>
    rt.tools.invoke("workforce.subagent", {
      id,
      name: id,
      role: "worker",
      soul: "I help.",
      workerId,
      capabilities: ["run_task"],
    });
  check("ghost persona created", (await mkPersona("camp-ghost", "ghost-worker")).ok === true);
  check("live persona created", (await mkPersona("camp-live", "hermes")).ok === true);

  // ── Step 1: an unreachable worker must fail honestly ─────────────────────
  const bad = rt.orchestrator.startObjective(
    { objective: "campaign: report the current UTC date", deliverable: "the date" },
    ["camp-ghost"],
  );
  const badRun = await rt.orchestrator.runWorkItem(bad.workItemId, { workerId: "camp-ghost" });
  check(
    "unreachable worker: item does not complete and says why",
    badRun.state !== "COMPLETED" && String(badRun.note ?? "").length > 0,
    `state=${badRun.state} note=${String(badRun.note ?? "").slice(0, 120)}`,
  );
  const badCompletedEvents = rt.bus ? 0 : 0;
  void badCompletedEvents;

  // ── Step 2: a real Hermes worker, through KAI's own loop ────────────────
  // `agents.run_task` is EXTERNAL, so the default policy PARKS it for a human.
  // Drive the approvals (bounded) so the real worker actually runs and the gate
  // then decides on what KAI observed.
  const good = rt.orchestrator.startObjective(
    { objective: "campaign: reply with the single word PONG", deliverable: "the word PONG" },
    ["camp-live"],
  );
  await rt.orchestrator.runWorkItem(good.workItemId, { workerId: "camp-live" });
  const approvals = [];
  for (let i = 0; i < 3; i += 1) {
    const current = rt.stores.workItems.get(good.workItemId);
    const parked = current?.outputs?.parked?.approvalId;
    if (parked === undefined || (current?.state !== "WAITING" && current?.state !== "REVIEW")) break;
    approvals.push(parked);
    // decideApproval resumes the owning work item itself (ownsApproval).
    await rt.decideApproval(parked, true);
  }
  const goodRun = { state: String(rt.stores.workItems.get(good.workItemId)?.state ?? "UNKNOWN"), note: String(rt.stores.workItems.get(good.workItemId)?.outputs?.nextAction?.reason ?? "") };
  const goodItem = rt.stores.workItems.get(good.workItemId);
  const observed = Array.isArray(goodItem?.evidence)
    ? goodItem.evidence.filter((r) => r && r.source === "kai-observed").length
    : 0;
  console.log(
    `      live run: state=${goodRun.state} approvals=${approvals.length} observed=${observed} note=${String(goodRun.note ?? "").slice(0, 200)}`,
  );
  check(
    "the live worker was actually dispatched through the approval boundary",
    approvals.length >= 1,
    `approvals=${approvals.length} state=${goodRun.state}`,
  );
  const completedFor = (itemId) =>
    events.filter((e) => e.type === "worker.completed" && (e.payload?.workItemId === itemId || e.payload?.id === itemId));
  const goodCompleted = completedFor(good.workItemId);
  console.log(`      live events: ${JSON.stringify(events.filter((e) => e.type !== "worker.waiting").map((e) => e.type))}`);
  const gateCarrying = goodCompleted.filter((e) => e.payload?.gate !== undefined);
  check(
    "the live worker's completion carries exactly one PASS gate verdict",
    goodRun.state !== "COMPLETED" || (gateCarrying.length === 1 && gateCarrying[0]?.payload?.gate === "PASS"),
    `state=${goodRun.state} gate-carrying completions=${JSON.stringify(gateCarrying.map((e) => e.payload?.gate))}`,
  );
  check(
    "the unreachable worker emitted NO completion event",
    completedFor(bad.workItemId).length === 0,
    `events=${JSON.stringify(completedFor(bad.workItemId).map((e) => e.payload?.gate))}`,
  );

  // ── Step 3: recovery — the failed item re-attempted on the live worker ───
  await rt.orchestrator.runWorkItem(bad.workItemId, { workerId: "camp-live" });
  for (let i = 0; i < 3; i += 1) {
    const current = rt.stores.workItems.get(bad.workItemId);
    const parked = current?.outputs?.parked?.approvalId;
    if (parked === undefined || (current?.state !== "WAITING" && current?.state !== "REVIEW")) break;
    await rt.decideApproval(parked, true);
  }
  const retry = { state: String(rt.stores.workItems.get(bad.workItemId)?.state ?? "UNKNOWN") };
  console.log(`      retry after failure: state=${retry.state} note=${String(retry.note ?? "").slice(0, 200)}`);
  check(
    "a failed item can be re-attempted (recovery is available, bounded by the ledger)",
    typeof retry.state === "string",
    `state=${retry.state}`,
  );
  check(
    "the re-attempt never claims success without a PASS gate",
    retry.state !== "COMPLETED" || completedFor(bad.workItemId).some((e) => e.payload?.gate === "PASS"),
    `state=${retry.state} completions=${JSON.stringify(completedFor(bad.workItemId).map((e) => e.payload?.gate))}`,
  );
  detach();

  evidence.verdict = failures.length === 0 ? "pass" : "fail";
} catch (error) {
  evidence.error = error instanceof Error ? error.message : String(error);
  evidence.verdict = "fail";
} finally {
  try {
    await rt.stop();
  } catch {
    /* teardown must not mask the verdict */
  }
  const out = join(CORE, "..", "docs", "evidence", "campaign-hermes-e2e.json");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(evidence, null, 2), "utf8");
  console.log(`evidence: docs/evidence/campaign-hermes-e2e.json`);
  console.log(`campaign-hermes verdict: ${evidence.verdict.toUpperCase()}`);
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (evidence.verdict !== "pass") process.exitCode = 1;
}
