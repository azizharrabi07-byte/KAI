// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * KAI Doer — the autonomous switch and its pending-result inbox.
 *
 * These are ACCEPTANCE tests at the real boundaries: the durable preference,
 * the HTTP API, the event bus, the work board and the orchestrator. Nothing here
 * disables a frontend button to prove a backend property, and nothing asserts
 * that a switch is "off" merely because a field reads "OFF" — each test drives
 * the real path and then checks what actually did (or did not) happen.
 *
 * The contract under test:
 *   - a fresh installation starts with the Doer OFF while Guard stays active;
 *   - OFF means no result interpretation, no autonomous dispatch, no retry;
 *   - a result that arrives while OFF is kept, and processed exactly once after
 *     the Doer is turned ON;
 *   - duplicate and replayed deliveries cannot process (or dispatch) twice;
 *   - a saved preference and the pending backlog both survive a restart.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCoreApi } from "../src/api/routes.ts";
import { createWorkBoard } from "../src/orchestration/board.ts";
import { createCoreRuntime } from "../src/runtime.ts";
import { readOrchestrationPrefs } from "../src/orchestration/prefs.ts";
import type { CoreRuntime } from "../src/runtime.ts";
import type { KaiEvent } from "../src/shared/contracts.ts";

/** An isolated Core: temp directory, mock agents, no scheduler ticks. */
function makeRuntime(): { runtime: CoreRuntime; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "kai-doer-"));
  const runtime = createCoreRuntime({
    dbPath: join(dir, "kai.db"),
    agents: { mode: "mock" },
    startScheduler: false,
    subsystemPaths: { runUpkeepOnStart: false },
  });
  return { runtime, dir };
}

function cleanup(runtime: CoreRuntime, dir: string): () => Promise<void> {
  return async () => {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
}

/** Count `doer.result_processed` events actually published on the live bus. */
function countProcessed(runtime: CoreRuntime): () => number {
  const seen: KaiEvent[] = [];
  runtime.bus.subscribe((event) => seen.push(event), { types: ["doer.result_processed"] });
  return () => seen.length;
}

/**
 * Plan a real work item on the runtime's OWN durable board.
 *
 * `startObjective` is deliberately not used here: with no worker personas
 * registered the router answers the objective itself and creates no item, which
 * is correct behaviour but not what these tests need. The board below is the
 * same one the orchestrator writes through, backed by the same SQLite store, so
 * `nextMove`/`runWorkItem` still see a real item with real persistence.
 */
function planWorkItem(runtime: CoreRuntime, objective: string) {
  const board = createWorkBoard(runtime.stores.workItems);
  const created = board.create({ objective, deliverable: "a verified result", requiredEvidence: ["a real check ran"] });
  assert.equal(created.ok, true, "the work item was planned");
  return created.ok ? created.value : null;
}

/** Drive one API request through the real route table (no sockets). */
async function api(runtime: CoreRuntime, method: string, path: string, body?: unknown) {
  const core = createCoreApi(runtime);
  return core.handle({ method, path, query: new URLSearchParams(), ...(body !== undefined ? { body } : {}) });
}

test("a fresh installation starts with the Doer OFF, and the API says so", async (t) => {
  const { runtime, dir } = makeRuntime();
  t.after(cleanup(runtime, dir));

  // The durable preference itself.
  assert.equal(readOrchestrationPrefs(runtime.stores.settings).doer, "OFF", "a fresh Core starts with the Doer OFF");

  // And the typed surface the Island reads.
  const res = await api(runtime, "GET", "/doer");
  assert.equal(res.status, 200);
  const body = res.body as { state: string; paused: boolean; guard: string; pending: { pending: number } };
  assert.equal(body.state, "OFF");
  assert.equal(body.paused, true, "PAUSED is reported because the Doer is OFF, not because a task failed");
  assert.equal(body.guard, "ON", "Guard is always active and is not switched by the Doer");
  assert.equal(body.pending.pending, 0, "a fresh installation has nothing pending");
});

test("Guard still refuses forbidden actions while the Doer is OFF", async (t) => {
  const { runtime, dir } = makeRuntime();
  t.after(cleanup(runtime, dir));

  assert.equal(readOrchestrationPrefs(runtime.stores.settings).doer, "OFF");

  // A DESTRUCTIVE tool through the real guarded boundary. The Doer being OFF
  // must not make it easier: the policy engine is untouched by the switch.
  const decision = runtime.policy.check({
    toolId: "workspace.write",
    action: "write outside the workspace",
    risk: "DESTRUCTIVE",
  });
  assert.notEqual(decision.outcome, "allow", `a destructive action is never auto-allowed: ${JSON.stringify(decision)}`);

  // And the execution registry refuses rather than executing.
  const invoked = await runtime.tools.invoke("workspace.write", { path: "C:/Windows/System32/drivers/etc/hosts", content: "x" });
  assert.equal(invoked.ok, false, "the guarded boundary refused the write while the Doer was OFF");
});

test("the Doer OFF records a worker result but does not interpret or advance it", async (t) => {
  const { runtime, dir } = makeRuntime();
  t.after(cleanup(runtime, dir));

  const processed = countProcessed(runtime);
  const planned = planWorkItem(runtime, "prove the Doer does not advance work while OFF");
  assert.ok(planned, "the work item exists");
  const itemId = planned.id;
  assert.equal(runtime.stores.workItems.get(itemId)?.state, "READY");

  // A real worker completion for that work item, on the live bus.
  runtime.bus.publish("worker.completed", { workItemId: itemId, output: "done, trust me" }, { source: "worker" });

  // The result is KEPT — nothing is lost while OFF.
  const rows = runtime.pendingResults.list();
  assert.equal(rows.length, 1, "the result was recorded in the inbox");
  assert.equal(rows[0]?.state, "PENDING", "and it stays PENDING while the Doer is OFF");
  assert.equal(rows[0]?.workItemId, itemId, "correlated to the real work item");
  assert.equal(rows[0]?.attempts, 0, "nothing claimed it");

  // Nothing interpreted it: no processing event, and the item did not move.
  assert.equal(processed(), 0, "no result was interpreted while the Doer was OFF");
  assert.equal(
    runtime.stores.workItems.get(itemId)?.state,
    "READY",
    "the work item was not advanced, retried or completed",
  );
});

test("a result received while OFF is processed exactly once after the Doer is ON", async (t) => {
  const { runtime, dir } = makeRuntime();
  t.after(cleanup(runtime, dir));

  const processed = countProcessed(runtime);

  // Three distinct terminal results arrive while the Doer is OFF.
  const first = planWorkItem(runtime, "off-buffer one");
  const second = planWorkItem(runtime, "off-buffer two");
  runtime.bus.publish("worker.completed", { workItemId: first.id }, { source: "worker" });
  runtime.bus.publish("worker.failed", { workItemId: second.id, error: "boom" }, { source: "worker" });
  runtime.bus.publish("mission.completed", { missionId: "mis_nonexistent" }, { source: "core" });

  assert.equal(runtime.pendingResults.counts().pending, 3, "all three were kept while OFF");
  assert.equal(processed(), 0, "none was interpreted");

  // Turn it ON through the real API — the same path the Island uses. The write
  // is policy-gated, so a WRITE-policy Core parks it for a human first.
  const parked = await api(runtime, "POST", "/doer", { state: "ON" });
  assert.equal(parked.status, 409, `the switch is policy-gated: ${JSON.stringify(parked.body)}`);
  const approvalId = (parked.body as { approvalId: string | null }).approvalId;
  assert.ok(approvalId, "the parked switch names its approval");
  await runtime.decideApproval(approvalId, true);
  assert.equal(readOrchestrationPrefs(runtime.stores.settings).doer, "ON", "the approved switch applied");

  // The bus triggers the drain asynchronously; `idle()` is the deterministic
  // signal that no pass is in flight — no guessed sleep, no polling loop.
  await runtime.doer.idle();

  const counts = runtime.pendingResults.counts();
  assert.equal(counts.pending, 0, `the backlog was worked: ${JSON.stringify(counts)}`);
  assert.equal(counts.done, 3, "each result settled exactly once");
  assert.equal(processed(), 3, "exactly one processing event per result");
  assert.equal(readOrchestrationPrefs(runtime.stores.settings).doer, "ON", "the preference persisted");
});

test("duplicate and replayed deliveries never process or dispatch twice", async (t) => {
  const { runtime, dir } = makeRuntime();
  t.after(cleanup(runtime, dir));

  runtime.stores.settings.set("orchestration.doer", "ON", new Date().toISOString());
  const processed = countProcessed(runtime);

  const planned = planWorkItem(runtime, "duplicate delivery");
  const payload = { workItemId: planned.id };

  // The same terminal event delivered three times: the live publish, a replay of
  // the same event id, and a restart re-reading the persisted row. The inbox
  // keys on the event id, so all three are one result.
  const delivered = runtime.bus.publish("worker.completed", payload, { source: "worker" });
  for (let replay = 0; replay < 2; replay += 1) {
    runtime.doer.record({ type: "worker.completed", eventId: delivered.id, payload });
  }

  assert.equal(runtime.pendingResults.list().length, 1, "the duplicate id produced no second row");

  await runtime.doer.idle();
  assert.equal(runtime.pendingResults.counts().done, 1, "the result settled once");
  assert.equal(processed(), 1, "and it was interpreted once, not per delivery");
});

test("a saved Doer preference survives a restart, and a paused backlog stays paused", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kai-doer-restart-"));
  const dbPath = join(dir, "kai.db");

  // ── First process: turn the Doer ON, then record a result while it is OFF ──
  const first = createCoreRuntime({
    dbPath,
    agents: { mode: "mock" },
    startScheduler: false,
    subsystemPaths: { runUpkeepOnStart: false },
  });
  first.stores.settings.set("orchestration.doer", "OFF", new Date().toISOString());
  const planned = planWorkItem(first, "survives a restart");
  first.bus.publish("worker.completed", { workItemId: planned.id }, { source: "worker" });
  assert.equal(first.pendingResults.counts().pending, 1);
  await first.stop();

  // ── Second process, Doer OFF: the backlog is NOT worked ────────────────────
  const paused = createCoreRuntime({
    dbPath,
    agents: { mode: "mock" },
    startScheduler: false,
    subsystemPaths: { runUpkeepOnStart: false },
  });
  const pausedProcessed = countProcessed(paused);
  await paused.start();
  assert.equal(readOrchestrationPrefs(paused.stores.settings).doer, "OFF", "the saved preference was restored");
  assert.equal(paused.pendingResults.counts().pending, 1, "the pending result survived the restart");
  assert.equal(pausedProcessed(), 0, "restarting with the Doer OFF left it paused");
  assert.equal(paused.pendingResults.counts().done, 0);
  await paused.stop();

  // ── Third process, Doer ON: the backlog is resumed, once ──────────────────
  const resumed = createCoreRuntime({
    dbPath,
    agents: { mode: "mock" },
    startScheduler: false,
    subsystemPaths: { runUpkeepOnStart: false },
  });
  const resumedProcessed = countProcessed(resumed);
  resumed.stores.settings.set("orchestration.doer", "ON", new Date().toISOString());
  await resumed.start();
  await resumed.doer.idle();
  assert.equal(resumed.pendingResults.counts().done, 1, "restarting with the Doer ON resumed the eligible work");
  assert.equal(resumedProcessed(), 1, "exactly once");
  await resumed.stop();

  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("the Doer stops interpreting the moment it is switched OFF", async (t) => {
  const { runtime, dir } = makeRuntime();
  t.after(cleanup(runtime, dir));

  runtime.stores.settings.set("orchestration.doer", "ON", new Date().toISOString());
  const processed = countProcessed(runtime);

  // Switch it OFF through the real API. OFF is authority-REDUCING, so it must
  // apply immediately — no approval, no park.
  const stopped = await api(runtime, "POST", "/doer", { state: "OFF" });
  assert.equal(stopped.status, 200, `stopping KAI must never need an approval: ${JSON.stringify(stopped.body)}`);
  assert.equal(readOrchestrationPrefs(runtime.stores.settings).doer, "OFF", "the switch applied immediately");

  // A result arriving now must be parked, not interpreted.
  const planned = planWorkItem(runtime, "after switch off");
  runtime.bus.publish("worker.completed", { workItemId: planned.id }, { source: "worker" });

  assert.equal(runtime.pendingResults.counts().pending, 1, "the result was recorded");
  assert.equal(processed(), 0, "and NOT interpreted after the switch went off");
  assert.equal(runtime.stores.workItems.get(planned.id)?.state, "READY", "no autonomous dispatch happened");
});

test("a parked orchestration-only settings change applies when it is approved", async (t) => {
  // Regression: the parked input is the NORMALISED `{ settings, orchestration }`
  // shape. Validation used to read only `settings`, so an approved park of an
  // orchestration-only change was re-issued, failed as "nothing to update", and
  // the setting silently never applied — the verdict landed and nothing happened.
  const { runtime, dir } = makeRuntime();
  t.after(cleanup(runtime, dir));

  const parked = await runtime.tools.invoke("settings.update", { settings: { "orchestration.doer": "ON" } });
  assert.equal(parked.ok, false);
  assert.equal(parked.ok === false ? parked.error.code : "", "APPROVAL_REQUIRED");
  const approvalId = parked.ok === false ? (parked.error.detail ?? "") : "";
  assert.ok(approvalId.length > 0, "the write parked with an approval id");

  const decided = await runtime.decideApproval(approvalId, true);
  assert.equal(readOrchestrationPrefs(runtime.stores.settings).doer, "ON", `the approved write applied: ${JSON.stringify(decided)}`);
});

test("the owner's OFF is immediate and unapproved, while ON still parks", async (t) => {
  // The asymmetry is the whole point: a user must never need a second approval
  // to make KAI STOP acting on its own, but widening autonomy is not the same
  // kind of act and stays human-gated.
  const { runtime, dir } = makeRuntime();
  t.after(cleanup(runtime, dir));

  runtime.stores.settings.set("orchestration.doer", "ON", new Date().toISOString());

  const stopped = await api(runtime, "POST", "/doer", { state: "OFF" });
  assert.equal(stopped.status, 200, `OFF applies immediately: ${JSON.stringify(stopped.body)}`);
  assert.equal((stopped.body as { doer: { state: string } }).doer.state, "OFF");
  assert.equal(readOrchestrationPrefs(runtime.stores.settings).doer, "OFF");

  // Guard is untouched by the switch in either direction.
  const decided = runtime.policy.check({ toolId: "workspace.write", action: "write", risk: "DESTRUCTIVE" });
  assert.notEqual(decided.outcome, "allow", "Guard stayed active after the Doer was stopped");

  const started = await api(runtime, "POST", "/doer", { state: "ON" });
  assert.equal(started.status, 409, `turning autonomy ON parks for a human: ${JSON.stringify(started.body)}`);
  assert.equal(readOrchestrationPrefs(runtime.stores.settings).doer, "OFF", "and did not apply on its own");

  // The value-scoped tool cannot be used to escalate.
  const escalated = await runtime.tools.invoke("doer.set", { state: "ON" });
  assert.equal(escalated.ok, false, "doer.set refuses ON outright");
  assert.equal(readOrchestrationPrefs(runtime.stores.settings).doer, "OFF");
});
