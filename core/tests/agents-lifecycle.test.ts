// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * P7-P9 — subagent lifecycle with real run tracking and real events.
 *
 * Against a REAL runtime (mock workers, temp dir):
 *   spawn (define, approval-gated) -> agent.spawned
 *   -> assign (run parks) -> agent.run_started + tracked with approval
 *   -> cancel the parked run -> approval rejected, agent.run_cancelled
 *   -> run again, approve, re-issue -> agent.run_completed with mock output
 *   -> active runs drain; unknown run ids are refused values.
 *
 * Run from `core/`:  node --test tests/agents-lifecycle.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCoreRuntime } from "../src/runtime.ts";
import { createKaiServer } from "../src/server.ts";
import { loadConfig } from "../src/config.ts";
import type { KaiEventType } from "../src/shared/contracts.ts";

async function boot(t: { after: (fn: () => void | Promise<void>) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "kai-agents-life-"));
  const rt = createCoreRuntime({
    dbPath: join(dir, "core.db"),
    agents: { mode: "mock" },
    startScheduler: false,
    subsystemPaths: { runUpkeepOnStart: false, ledgerPath: join(dir, "ledger.db") },
  });
  await rt.start();
  const seen: Array<{ type: KaiEventType; payload: unknown }> = [];
  const off = rt.bus.subscribe((event) => {
    seen.push({ type: event.type as KaiEventType, payload: event.payload });
  });
  t.after(async () => {
    off();
    await rt.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  return { rt, seen };
}

const SPEC = {
  id: "researcher",
  name: "Researcher",
  role: "research",
  soul: "I am methodical, analytical and citation-focused.",
  workerId: "opencode",
};

function approvalIdOf(outcome: unknown): string {
  const record = outcome as { error?: { code?: string; detail?: string }; result?: { error?: { code?: string; detail?: string } } };
  const error = record?.result?.error ?? record?.error;
  assert.equal(error?.code, "APPROVAL_REQUIRED");
  const id = error?.detail;
  assert.ok(typeof id === "string" && id.length > 0, "the park names its approval");
  return id;
}

test("spawn -> run (park) -> cancel -> run again (approve) -> completed, all with events", async (t) => {
  const { rt, seen } = await boot(t);

  // Spawn: defining a persona is reversible internal orchestration, so the
  // default policy authorizes it (like skill staging's definition half) — the
  // RUNS are what park. The spawn still publishes its event from real state.
  const spawned = await rt.tools.invoke("workforce.subagent", SPEC);
  assert.equal(spawned.ok, true, JSON.stringify(spawned.ok ? {} : spawned.error).slice(0, 300));
  const persona = rt.subagents.get("researcher");
  assert.ok(persona !== undefined, "the define landed");
  assert.ok(seen.some((event) => event.type === "agent.spawned"), "agent.spawned was published from real state");

  // Assign: the run parks on the worker-tool approval.
  const runOutcome = (await rt.runSubagent("researcher", "survey the repo")) as Record<string, unknown>;
  assert.ok(typeof runOutcome["runId"] === "string", "every run carries its runId");
  const runId = runOutcome["runId"] as string;
  assert.ok(seen.some((event) => event.type === "agent.run_started"), "agent.run_started was published");
  const tracked = rt.activeSubagentRuns();
  assert.equal(tracked.length, 1, "the parked run stays tracked");
  assert.equal(tracked[0]?.runId, runId);
  const parkedApproval = tracked[0]?.approvalId;
  assert.ok(typeof parkedApproval === "string", "the tracked run names its approval");

  // Cancel the parked run: its approval is rejected, so the work never runs.
  const cancelled = await rt.cancelSubagentRun(runId);
  assert.deepEqual(cancelled, { ok: true, runId });
  assert.ok(seen.some((event) => event.type === "agent.run_cancelled"), "agent.run_cancelled was published");
  assert.equal(rt.activeSubagentRuns().length, 0, "cancelled runs leave the map");

  // Run again, approve, re-issue with the decided approval: the mock worker runs.
  const second = (await rt.runSubagent("researcher", "survey the repo")) as Record<string, unknown>;
  const runId2 = second["runId"] as string;
  assert.ok(typeof runId2 === "string" && runId2 !== runId, "run ids are unique per run");
  const active2 = rt.activeSubagentRuns();
  assert.equal(active2.length, 1);
  const approval2 = active2[0]?.approvalId;
  assert.ok(typeof approval2 === "string");
  assert.equal((await rt.decideApproval(approval2, true)).approved, true);
  const completed = (await rt.runSubagent("researcher", "survey the repo", approval2)) as Record<string, unknown>;
  assert.equal(completed["runId"] === undefined || typeof completed["runId"] === "string", true);
  assert.ok(seen.some((event) => event.type === "agent.run_completed"), "agent.run_completed was published");
  assert.equal(rt.activeSubagentRuns().length, 0, "completed runs leave the map");

  // Cancelling an unknown or finished run is a refused value, never a throw.
  const missing = await rt.cancelSubagentRun("run_nope");
  assert.equal(missing.ok, false);
  const finished = await rt.cancelSubagentRun(runId2);
  assert.equal(finished.ok, false, "a finished run cannot be cancelled");
});

test("a persona's direct session is isolated and kinded; KAI history is untouched", async (t) => {
  const { rt } = await boot(t);
  const spawned = await rt.tools.invoke("workforce.subagent", SPEC);
  assert.equal(spawned.ok, true);
  const persona = rt.subagents.get("researcher");
  assert.ok(persona !== undefined);

  const kai = rt.sessions.create({ title: "KAI Chat" });
  rt.sessions.recordTurn({ sessionId: kai.id, role: "user", text: "hello kai" });
  const own = rt.sessions.create({ title: "Researcher — own session", agentId: persona.employeeId });
  assert.equal(own.sessionKind, "agent-conversation");
  rt.sessions.recordTurn({ sessionId: own.id, role: "user", text: "persona note" });
  rt.sessions.recordTurn({ sessionId: own.id, role: "assistant", text: "persona reply" });

  const kaiHistory = rt.sessions.history(kai.id);
  assert.ok(kaiHistory.ok && kaiHistory.value.length === 1, "persona turns never land in KAI history");
  const personaHistory = rt.sessions.history(own.id);
  assert.ok(personaHistory.ok && personaHistory.value.length === 2, "the persona keeps its own transcript");
  assert.equal(rt.sessions.active()?.id, kai.id, "creating a persona session never steals the pointer");
});

test("LIVE HTTP: runs list and cancel ride the /subagents routes", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kai-agents-http-"));
  const rt = createCoreRuntime({
    dbPath: join(dir, "core.db"),
    agents: { mode: "mock" },
    startScheduler: false,
    subsystemPaths: { runUpkeepOnStart: false, ledgerPath: join(dir, "ledger.db") },
  });
  await rt.start();
  const server = createKaiServer(loadConfig(process.env), { core: rt });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rt.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const spawned = await rt.tools.invoke("workforce.subagent", SPEC);
  assert.equal(spawned.ok, true);
  const run = (await rt.runSubagent("researcher", "http probe")) as { runId: string };
  assert.ok(typeof run.runId === "string");

  const listed = (await (await fetch(`${base}/subagents/runs`)).json()) as { runs: Array<{ runId: string }> };
  assert.ok(listed.runs.some((entry) => entry.runId === run.runId), "the parked run is listed live");

  const cancelled = await (
    await fetch(`${base}/subagents/runs/${run.runId}/cancel`, { method: "POST" })
  ).json();
  assert.deepEqual(cancelled, { runId: run.runId, cancelled: true });

  const missing = await fetch(`${base}/subagents/runs/run_nope/cancel`, { method: "POST" });
  assert.equal(missing.status, 400, "an unknown run is refused, not cancelled");
});
