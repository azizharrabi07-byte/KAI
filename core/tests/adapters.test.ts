// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Adapter tests — no network, no live servers.
 *
 * The real Hermes/OpenCode adapters are exercised through an injected fetch, and
 * the mocks provide the slow/failing/hanging scenarios. Nothing here opens a
 * socket: the suite passes on a machine where nothing is listening.
 *
 * WHY THE HOOK BELOW: the repo's sources use NodeNext-style ".js" specifiers,
 * which Node's built-in type-stripping does not remap to ".ts". The synchronous
 * resolve hook makes `node --test tests/adapters.test.ts` build-free.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL) {
      const candidate = new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL);
      if (existsSync(fileURLToPath(candidate))) {
        return { url: candidate.href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});

const { createHermesAdapter } = await import("../src/agents/adapters/hermesAdapter.ts");
const { createOpenCodeAdapter } = await import("../src/agents/adapters/opencodeAdapter.ts");
const { createMockHermes, createMockOpenCode } = await import("../src/agents/mock.ts");

// ── helpers ───────────────────────────────────────────────────────────────────

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function noContent(status) {
  return new Response(null, { status });
}

/** A clock whose sleep must be released explicitly, so "working" is observable. */
function controlledClock() {
  let t = 0;
  let release = null;
  return {
    now: () => t,
    sleep: (ms) =>
      new Promise((resolve) => {
        release = () => {
          t += Math.max(1, ms);
          resolve();
        };
      }),
    release: () => {
      if (release) release();
    },
  };
}

/** A clock that advances instantly by the requested interval. */
function instantClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += Math.max(1, ms);
    },
  };
}

// ── capabilities ──────────────────────────────────────────────────────────────

test("capabilities: real adapters and their simulators declare the same set", () => {
  const hermes = [...createHermesAdapter().capabilities()].sort();
  const mockHermes = [...createMockHermes().capabilities()].sort();
  const opencode = [...createOpenCodeAdapter().capabilities()].sort();
  const mockOpenCode = [...createMockOpenCode().capabilities()].sort();

  assert.deepEqual(mockHermes, hermes);
  assert.deepEqual(mockOpenCode, opencode);
  assert.deepEqual(hermes, ["cancel_task", "health", "message", "run_task", "sessions", "status"]);
  assert.deepEqual(opencode, hermes);
});

test("capabilities: an adapter that cannot cancel omits cancel_task and leaves cancelTask undefined", () => {
  const noCancel = {
    id: "no-cancel",
    name: "No Cancel",
    capabilities: () => ["health", "status"],
    connect: async () => {},
    disconnect: async () => {},
    health: async () => ({ ok: true }),
    getStatus: async () => ({ id: "no-cancel", state: "idle" }),
    sendMessage: async () => ({ text: "" }),
    runTask: async (task) => ({ taskId: task.id, state: "completed" }),
    // cancelTask deliberately absent
  };

  assert.equal("cancelTask" in noCancel, false);
  assert.equal(noCancel.capabilities().includes("cancel_task"), false);

  // …whereas the real adapters do support it
  assert.equal(typeof createHermesAdapter().cancelTask, "function");
  assert.equal(typeof createOpenCodeAdapter().cancelTask, "function");
});

// ── mock failure modes ────────────────────────────────────────────────────────

test("mock: a connect failure yields AGENT_NOT_LISTENING", async () => {
  const adapter = createMockHermes({ failAt: "connect" });
  await assert.rejects(
    () => adapter.connect(),
    (error) => {
      assert.equal(error.kaiError.code, "AGENT_NOT_LISTENING");
      return true;
    },
  );
});

test("mock: a health failure reports ok:false", async () => {
  const adapter = createMockOpenCode({ failAt: "health" });
  const health = await adapter.health();
  assert.equal(health.ok, false);
  assert.equal(typeof health.detail, "string");
});

test("mock: a run failure yields AGENT_RUN_FAILED", async () => {
  const adapter = createMockHermes({ failAt: "run" });
  await adapter.connect();
  const result = await adapter.runTask({ id: "t1", input: "hello" });
  assert.equal(result.state, "failed");
  assert.equal(result.error.code, "AGENT_RUN_FAILED");
});

test("mock: connected -> working -> completed, observed deterministically", async () => {
  const clock = controlledClock();
  const adapter = createMockHermes({ workMs: 1, pollIntervalMs: 1, now: clock.now, sleep: clock.sleep });

  await adapter.connect();
  assert.equal((await adapter.health()).ok, true);

  const pending = adapter.runTask({ id: "t2", input: "do the thing" });
  const midRun = await adapter.getStatus();
  assert.equal(midRun.state, "working");

  clock.release();
  const result = await pending;
  assert.equal(result.state, "completed");
  assert.match(result.output, /mock output: do the thing/);
  assert.equal((await adapter.getStatus()).state, "idle");
});

test("mock: a hanging run yields timed_out rather than hanging the test", async () => {
  const clock = instantClock();
  const adapter = createMockHermes({ hangMs: 3, pollIntervalMs: 3, now: clock.now, sleep: clock.sleep });
  await adapter.connect();

  const result = await adapter.runTask({ id: "t3", input: "never finishes" });

  assert.ok(result.state === "timed_out" || result.state === "abandoned");
  assert.equal(result.state, "timed_out");
  assert.equal(result.error.code, "AGENT_TIMEOUT");
  // The loop is bounded by the injected clock; it cannot spin forever.
  assert.ok(clock.now() <= 60, `clock advanced too far: ${clock.now()}`);
});

test("mock: disconnect reports offline", async () => {
  const adapter = createMockOpenCode();
  await adapter.connect();
  await adapter.disconnect();
  assert.equal((await adapter.health()).ok, false);
  assert.equal((await adapter.getStatus()).state, "offline");
});

// ── real Hermes adapter, via injected fetch ───────────────────────────────────

test("hermes: distinguishes 'not listening' from a real timeout", async () => {
  const refused = createHermesAdapter({
    timeoutMs: 1000,
    fetchImpl: async () => {
      const error = new Error("fetch failed");
      error.code = "ECONNREFUSED";
      throw error;
    },
  });
  const refusedHealth = await refused.health();
  assert.equal(refusedHealth.ok, false);
  assert.match(String(refusedHealth.detail), /AGENT_NOT_LISTENING/);

  const slow = createHermesAdapter({
    timeoutMs: 1000,
    fetchImpl: async () => {
      const error = new Error("The operation was aborted due to timeout");
      error.name = "TimeoutError";
      throw error;
    },
  });
  const slowHealth = await slow.health();
  assert.equal(slowHealth.ok, false);
  assert.match(String(slowHealth.detail), /AGENT_TIMEOUT/);

  assert.notEqual(refusedHealth.detail, slowHealth.detail);
  assert.equal((await refused.getStatus()).state, "offline");
});

test("hermes: 401 is AGENT_AUTH_FAILED and the api key never leaves the header", async () => {
  const KEY = "sk-test-DO-NOT-LEAK-1234567890";
  let lastAuth = null;

  const fetchImpl = async (url, init) => {
    const target = String(url);
    const headers = (init && init.headers) || {};
    lastAuth = headers["authorization"];
    if (target.endsWith("/api/sessions")) return json(200, { object: "list", data: [{ id: "s1" }] });
    if (target.endsWith("/v1/runs")) return json(401, { error: "unauthorized" });
    if (target.endsWith("/health")) return json(200, { status: "ok", platform: "hermes-agent", version: "9.9.9" });
    return json(404, { error: "not found" });
  };

  const adapter = createHermesAdapter({ apiKey: KEY, fetchImpl, timeoutMs: 1000 });

  const health = await adapter.health();
  assert.equal(health.ok, true);
  assert.equal(health.version, "9.9.9");

  const status = await adapter.getStatus();
  assert.equal(status.state, "idle");

  const run = await adapter.runTask({ id: "t4", input: "hello" });
  assert.equal(run.state, "failed");
  assert.equal(run.error.code, "AGENT_AUTH_FAILED");

  // The key was used, but ONLY in the Authorization header.
  assert.equal(lastAuth, `Bearer ${KEY}`);

  const serialized = JSON.stringify({ health, status, run, capabilities: adapter.capabilities() });
  assert.ok(!serialized.includes(KEY), "the api key must never appear in returned data");
  assert.ok(!JSON.stringify(run.error).includes(KEY));
});

test("hermes: runTask submits, polls from running to completed, and never stops it", async () => {
  const clock = instantClock();
  const stops = [];
  let polls = 0;

  const fetchImpl = async (url, init) => {
    const target = String(url);
    if (target.endsWith("/v1/runs") && init && init.method === "POST") {
      return json(202, { run_id: "r1", status: "started" });
    }
    if (target.endsWith("/v1/runs/r1/stop")) {
      stops.push(target);
      return noContent(204);
    }
    if (target.endsWith("/v1/runs/r1")) {
      polls += 1;
      if (polls < 2) return json(200, { status: "running" });
      return json(200, { status: "completed", output: "done!", usage: { input_tokens: 3, output_tokens: 4 } });
    }
    return json(404, { error: "not found" });
  };

  const adapter = createHermesAdapter({
    fetchImpl,
    apiKey: "k",
    pollIntervalMs: 1,
    runTimeoutMs: 100,
    now: clock.now,
    sleep: clock.sleep,
  });

  const result = await adapter.runTask({ id: "t5", input: "go" });
  assert.equal(result.state, "completed");
  assert.equal(result.output, "done!");
  assert.deepEqual(result.usage, { inputTokens: 3, outputTokens: 4 });
  assert.equal(polls, 2);
  assert.equal(stops.length, 0, "a completed run must not be stopped");
});

test("hermes: a terminal run publishes the worker RESULT event the Doer supervises", async () => {
  // The Doer's intake is DOER_RESULT_EVENT_TYPES (orchestration/doer.ts). A run
  // that finishes without publishing one of those is a completion nothing acts
  // on: the supervisor never wakes and the user has to ask what happened.
  const emitFor = async (terminal) => {
    const clock = instantClock();
    const seen = [];
    const fetchImpl = async (url, init) => {
      const target = String(url);
      if (target.endsWith("/v1/runs") && init && init.method === "POST") {
        return json(202, { run_id: "r1" });
      }
      if (target.endsWith("/v1/runs/r1/stop")) return noContent(204);
      if (target.endsWith("/v1/runs/r1")) return json(200, { status: terminal });
      return json(404, {});
    };
    const adapter = createHermesAdapter({
      fetchImpl,
      apiKey: "k",
      pollIntervalMs: 1,
      runTimeoutMs: 100,
      now: clock.now,
      sleep: clock.sleep,
      onEvent: (type, payload) => seen.push({ type, payload }),
    });
    const result = await adapter.runTask({ id: "t-res", input: "go" });
    return { result, seen };
  };

  const done = await emitFor("completed");
  assert.equal(done.result.state, "completed");
  const completed = done.seen.find((e) => e.type === "agent.run_completed");
  assert.ok(completed, "a completed run must publish agent.run_completed");
  // The shape must match the two existing publishers (runtime.ts `runSubagent`
  // and `settleParkedRunsOnVerdict`): `subagentId`, not `id`.
  assert.equal(completed.payload.subagentId, "hermes");
  assert.equal(completed.payload.runId, "r1");
  assert.equal(completed.payload.state, "completed");

  const bad = await emitFor("failed");
  assert.equal(bad.result.state, "failed");
  assert.ok(
    bad.seen.some((e) => e.type === "agent.run_failed"),
    "a failed run must publish agent.run_failed",
  );
  assert.equal(
    bad.seen.some((e) => e.type === "agent.run_completed"),
    false,
    "a failed run must never publish agent.run_completed",
  );
});

test("hermes: the event sink is optional, and its absence is not an error", async () => {
  // Every emit is gated on `onEvent`. A caller that omits it must still get the
  // run's real result: the sink is telemetry, never the return value.
  const clock = instantClock();
  const fetchImpl = async (url, init) => {
    const target = String(url);
    if (target.endsWith("/v1/runs") && init && init.method === "POST") {
      return json(202, { run_id: "r1" });
    }
    if (target.endsWith("/v1/runs/r1")) return json(200, { status: "completed", output: "ok" });
    return json(404, {});
  };
  const adapter = createHermesAdapter({
    fetchImpl,
    apiKey: "k",
    pollIntervalMs: 1,
    runTimeoutMs: 100,
    now: clock.now,
    sleep: clock.sleep,
  });
  const result = await adapter.runTask({ id: "t-nosink", input: "go" });
  assert.equal(result.state, "completed");
  assert.equal(result.output, "ok");
});

test("hermes: a failed poll abandons the run and asks it to stop", async () => {
  const clock = instantClock();
  const stops = [];

  const fetchImpl = async (url, init) => {
    const target = String(url);
    if (target.endsWith("/v1/runs") && init && init.method === "POST") {
      return json(202, { run_id: "r1", status: "started" });
    }
    if (target.endsWith("/v1/runs/r1/stop")) {
      stops.push(target);
      return noContent(204);
    }
    if (target.endsWith("/v1/runs/r1")) return json(500, { error: "server exploded" });
    return json(404, { error: "not found" });
  };

  const adapter = createHermesAdapter({
    fetchImpl,
    apiKey: "k",
    pollIntervalMs: 1,
    runTimeoutMs: 100,
    now: clock.now,
    sleep: clock.sleep,
  });

  const result = await adapter.runTask({ id: "t6", input: "go" });
  assert.equal(result.state, "abandoned");
  assert.equal(result.error.code, "AGENT_RUN_ABANDONED");
  assert.ok(stops.length >= 1, "an abandoned run must be stopped best-effort");
});

test("hermes: a run that never reaches a terminal state times out and is stopped", async () => {
  const clock = instantClock();
  const stops = [];

  const fetchImpl = async (url, init) => {
    const target = String(url);
    if (target.endsWith("/v1/runs") && init && init.method === "POST") {
      return json(202, { run_id: "r1", status: "started" });
    }
    if (target.endsWith("/v1/runs/r1/stop")) {
      stops.push(target);
      return noContent(204);
    }
    if (target.endsWith("/v1/runs/r1")) return json(200, { status: "running" });
    return json(404, { error: "not found" });
  };

  const adapter = createHermesAdapter({
    fetchImpl,
    apiKey: "k",
    pollIntervalMs: 1,
    runTimeoutMs: 5,
    now: clock.now,
    sleep: clock.sleep,
  });

  const result = await adapter.runTask({ id: "t7", input: "go" });
  assert.equal(result.state, "timed_out");
  assert.equal(result.error.code, "AGENT_TIMEOUT");
  assert.ok(stops.length >= 1);
  assert.ok(clock.now() <= 60, `clock advanced too far: ${clock.now()}`);
});
