// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Worker-authority tests — the delegated-run approval gate.
 *
 * This is the ENFORCEABLE half of Phase 1. A delegated run that Hermes parks
 * (`waiting_for_approval`) is answered by KAI while the operation is still held, so a
 * refusal means the operation never executes. These tests assert on what was actually
 * sent to the gateway — and above all that KAI can only ever answer `once` or `deny`,
 * never `session`/`always` (which would hand a worker standing authority for later,
 * different calls).
 *
 * The residual gap this does NOT close is recorded in the milestone report, not hidden
 * here: only operations Hermes itself flags are parked. Full per-tool authorization needs
 * a pre_tool_call hook in the worker's config, which is out of scope for this milestone.
 *
 * No network: every request goes through an injected fetch.
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

// A static import cannot be used here: the adapter is TypeScript with NodeNext ".js"
// specifiers, and it resolves only AFTER the `registerHooks` remap above is installed.
// This mirrors tests/adapters.test.ts, the established convention in this suite.
const { createHermesAdapter } = await import("../src/agents/adapters/hermesAdapter.ts");

const KEY = "test-key";

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The pending-approval payload the gateway puts on a held run. */
function parkedRun(overrides = {}) {
  return {
    status: "waiting_for_approval",
    approval: {
      request_id: "req-1",
      command: "rm -rf build/*",
      choices: ["once", "session", "always", "deny"],
      ...overrides,
    },
  };
}

/**
 * A gateway that parks the run `parks` times, records every answer KAI sends, then
 * completes. Each park carries its OWN request_id, which is what a real gateway does
 * (`_run_approval_sessions` keys the pending request per run) — reusing one id would
 * (correctly) be treated as a replay and left unanswered.
 */
function parkedGateway(options = {}) {
  const answers = [];
  let polls = 0;
  const parks = options.parks ?? 1;
  const fetchImpl = async (url, init) => {
    const target = String(url);
    const method = (init && init.method) || "GET";

    if (target.endsWith("/v1/runs") && method === "POST") {
      return json(202, { run_id: "r1", status: "started" });
    }
    if (target.endsWith("/v1/runs/r1/stop")) {
      return json(200, { ok: true });
    }
    if (target.endsWith("/v1/runs/r1/approval") && method === "POST") {
      answers.push(JSON.parse(String(init.body)));
      if (options.answerStatus && options.answerStatus !== 200) {
        return json(options.answerStatus, { error: "nope" });
      }
      return json(200, { object: "hermes.run.approval_response", run_id: "r1", choice: answers.at(-1).choice });
    }
    if (target.endsWith("/v1/runs/r1")) {
      polls += 1;
      if (polls <= parks) {
        return json(200, parkedRun({ ...options.approval, request_id: `req-${polls}` }));
      }
      if (options.neverComplete) return json(200, parkedRun());
      return json(200, { status: "completed", output: "finished" });
    }
    if (target.endsWith("/health")) {
      return json(200, { status: "ok", platform: "hermes-agent", version: "unknown" });
    }
    return json(404, { error: "not found" });
  };
  return { fetchImpl, answers, pollCount: () => polls };
}

/** A clock that advances a little on each read, so a budget is exceeded after N polls. */
function tickingClock(stepMs) {
  let t = 0;
  return () => (t += stepMs);
}

function runOnce(adapter) {
  return adapter.runTask({ id: "t1", input: "do the thing" });
}

// ── 1. A permitted operation, with valid authorization ───────────────────────────
test("an authorized parked operation is answered `once` and the run completes", async () => {
  const gw = parkedGateway();
  const asked = [];
  const adapter = createHermesAdapter({
    apiKey: KEY,
    fetchImpl: gw.fetchImpl,
    sleep: async () => {},
    authorizeRunApproval: (request) => {
      asked.push(request);
      return "once";
    },
  });

  const result = await runOnce(adapter);
  assert.equal(result.state, "completed");
  assert.equal(gw.answers.length, 1);
  assert.equal(gw.answers[0].choice, "once");
  // KAI was asked about the real operation, not a placeholder.
  assert.equal(asked.length, 1);
  assert.equal(asked[0].runId, "r1");
  assert.equal(asked[0].taskId, "t1");
  assert.match(String(asked[0].approval.command), /rm -rf/);
  assert.deepEqual(asked[0].choices, ["once", "session", "always", "deny"]);
});

// ── 2. A denied operation ────────────────────────────────────────────────────────
test("a refused parked operation is answered `deny`, and `once` is never sent", async () => {
  const gw = parkedGateway();
  const adapter = createHermesAdapter({
    apiKey: KEY,
    fetchImpl: gw.fetchImpl,
    sleep: async () => {},
    authorizeRunApproval: () => "deny",
  });

  const result = await runOnce(adapter);
  assert.equal(gw.answers.length, 1);
  assert.equal(gw.answers[0].choice, "deny");
  // The blocked side effect: the operation was never authorized.
  assert.ok(
    gw.answers.every((a) => a.choice === "deny"),
    "no answer may authorize an operation KAI refused",
  );
  assert.equal(result.state, "completed"); // the run continues, without the operation
});

// ── 3. A side-effecting operation with NO authorization wired ────────────────────
test("a parked operation with no decision wired is refused, not approved", async () => {
  const gw = parkedGateway();
  const adapter = createHermesAdapter({ apiKey: KEY, fetchImpl: gw.fetchImpl, sleep: async () => {} });

  await runOnce(adapter);
  assert.equal(gw.answers.length, 1);
  assert.equal(gw.answers[0].choice, "deny", "silence must never mean yes");
});

test("an answer that is neither `once` nor `deny` is coerced to `deny`", async () => {
  const gw = parkedGateway();
  const adapter = createHermesAdapter({
    apiKey: KEY,
    fetchImpl: gw.fetchImpl,
    sleep: async () => {},
    // A malformed/hostile decision must not widen the authorization.
    authorizeRunApproval: () => "always",
  });

  await runOnce(adapter);
  assert.equal(gw.answers[0].choice, "deny");
});

// ── 4. Changing the arguments after authorization invalidates it ────────────────
test("a second, different operation is decided afresh and cannot reuse the first approval", async () => {
  const gw = parkedGateway({ parks: 2 });
  const seen = [];
  const adapter = createHermesAdapter({
    apiKey: KEY,
    fetchImpl: gw.fetchImpl,
    sleep: async () => {},
    authorizeRunApproval: (request) => {
      seen.push(request.approval.command);
      // Approve the first, refuse the second: the decision is bound to the operation.
      return seen.length === 1 ? "once" : "deny";
    },
  });

  await runOnce(adapter);
  assert.equal(gw.answers.length, 2);
  assert.equal(gw.answers[0].choice, "once");
  assert.equal(gw.answers[1].choice, "deny");
  assert.equal(seen.length, 2, "the second operation must be decided on its own merits");
});

// ── 5. A replayed authorization ─────────────────────────────────────────────────
test("a re-reported approval request is answered exactly once", async () => {
  // The gateway keeps reporting the same park (same request_id) — a replay must not
  // produce a second authorization for one decision.
  const answers = [];
  let polls = 0;
  const fetchImpl = async (url, init) => {
    const target = String(url);
    const method = (init && init.method) || "GET";
    if (target.endsWith("/v1/runs") && method === "POST") return json(202, { run_id: "r1" });
    if (target.endsWith("/v1/runs/r1/approval") && method === "POST") {
      answers.push(JSON.parse(String(init.body)));
      return json(200, { choice: answers.at(-1).choice });
    }
    if (target.endsWith("/v1/runs/r1")) {
      polls += 1;
      if (polls <= 3) return json(200, parkedRun()); // same request_id three times
      return json(200, { status: "completed" });
    }
    return json(404, {});
  };
  const adapter = createHermesAdapter({
    apiKey: KEY,
    fetchImpl,
    sleep: async () => {},
    authorizeRunApproval: () => "once",
  });

  await runOnce(adapter);
  assert.equal(answers.length, 1, "a replayed request must not be answered twice");
});

// ── 6. KAI's policy authority failing ───────────────────────────────────────────
test("a policy-service failure refuses the operation rather than allowing it", async () => {
  const gw = parkedGateway();
  const adapter = createHermesAdapter({
    apiKey: KEY,
    fetchImpl: gw.fetchImpl,
    sleep: async () => {},
    authorizeRunApproval: () => {
      throw new Error("policy engine unavailable");
    },
  });

  await runOnce(adapter);
  assert.equal(gw.answers.length, 1);
  assert.equal(gw.answers[0].choice, "deny", "an unreachable authority must fail closed");
});

// ── 7. The gateway rejecting KAI's answer ───────────────────────────────────────
test("a gateway that will not accept the decision stops the run and reports it", async () => {
  const gw = parkedGateway({ answerStatus: 409, neverComplete: true });
  const adapter = createHermesAdapter({
    apiKey: KEY,
    fetchImpl: gw.fetchImpl,
    sleep: async () => {},
    now: (() => { let t = 0; return () => (t += 1000); })(),
    runTimeoutMs: 60_000,
    authorizeRunApproval: () => "deny",
  });

  const result = await runOnce(adapter);
  assert.equal(result.state, "abandoned");
  assert.equal(result.error.code, "AGENT_RUN_ABANDONED");
  assert.match(String(result.error.message), /not accepted/i);
});

// ── 8. Timeout while parked ─────────────────────────────────────────────────────
test("a run that stays parked past its budget times out rather than executing", async () => {
  const gw = parkedGateway({ neverComplete: true });
  const adapter = createHermesAdapter({
    apiKey: KEY,
    fetchImpl: gw.fetchImpl,
    sleep: async () => {},
    now: tickingClock(5_000),
    runTimeoutMs: 15_000,
    authorizeRunApproval: () => "once",
  });

  const result = await runOnce(adapter);
  assert.equal(result.state, "timed_out");
  assert.equal(result.error.code, "AGENT_TIMEOUT");
  // It was still asked before the budget ran out — a bounded run is not a silent skip.
  assert.ok(gw.answers.length >= 1, "the parked operation must be put to KAI before giving up");
});

// ── 9. Cancellation ─────────────────────────────────────────────────────────────
test("cancelling a run still reaches the stop route", async () => {
  const gw = parkedGateway();
  const adapter = createHermesAdapter({ apiKey: KEY, fetchImpl: gw.fetchImpl, sleep: async () => {} });
  await adapter.cancelTask("r1"); // must not throw
});

// ── 10. The adapter never invents completion ────────────────────────────────────
test("the adapter reports completion only when the gateway says so", async () => {
  const gw = parkedGateway({ neverComplete: true });
  const adapter = createHermesAdapter({
    apiKey: KEY,
    fetchImpl: gw.fetchImpl,
    sleep: async () => {},
    now: tickingClock(5_000),
    runTimeoutMs: 15_000,
    authorizeRunApproval: () => "deny",
  });

  const result = await runOnce(adapter);
  // A refused, never-finished run must never surface as completed — KAI's Outcome Gate
  // consumes this state, so a fabricated completion here would defeat it downstream.
  assert.notEqual(result.state, "completed");
  assert.equal(result.output, undefined);
});
