// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The autonomous loop (Phase C of the "KAI is the main agent" plan).
 *
 * The architecture audit's headline finding was that NOTHING re-invoked a model
 * or worker after evaluating a result. These tests pin the loop's bounded,
 * human-respecting behaviour, each property by the failure it prevents:
 *
 *   - a TRANSIENT failure with budget left  → KAI retries (a new mission);
 *   - a NON-transient failure               → KAI stops (a retry would ignore
 *     the answer it already has — a policy denial, a parked approval, a bad
 *     request, a missing tool);
 *   - the budget spent                      → KAI escalates to a human and says so;
 *   - the loop disabled                     → nothing happens at all;
 *   - the attempt number lives ON THE MISSION, so a restarted Core cannot reset
 *     the budget and loop forever.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { attemptOf, chainRoot, createMissionSupervisor, TRANSIENT_ERROR_CODES } from "../src/autonomy/supervisor.ts";
import type { KaiErrorCode, Mission } from "../src/shared/contracts.ts";

function mission(over: Partial<Mission> & { code?: KaiErrorCode; errorMessage?: string }): Mission {
  const status = over.status ?? "FAILED";
  // Step status follows the mission status unless a test supplies steps: a
  // COMPLETED mission is one whose steps settled, and the supervisor verifies
  // exactly that (an unsettled step under COMPLETED is an inconsistency it
  // reports). A blanket FAILED step on every fixture hid that distinction.
  const settled = status === "COMPLETED";
  const base: Mission = {
    id: over.id ?? "mission_1",
    title: over.title ?? "a mission",
    status,
    priority: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    steps: over.steps ?? [
      { id: "s0", missionId: over.id ?? "mission_1", index: 0, title: "do it", kind: "tool", status: settled ? "COMPLETED" : "FAILED", sideEffecting: true, target: "net.send" },
    ],
  };
  if (over.metadata !== undefined) base.metadata = over.metadata;
  if (over.description !== undefined) base.description = over.description;
  if (over.code !== undefined || over.errorMessage !== undefined) {
    base.error = {
      code: over.code ?? "INTERNAL",
      message: over.errorMessage ?? "boom",
      retryable: true,
      at: "2026-01-01T00:00:00.000Z",
    };
  }
  return base;
}

function harness(missions: Mission[], opts: { maxAttempts?: number } = {}) {
  const byId = new Map(missions.map((m) => [m.id, m]));
  const started: Array<{ title: string; steps?: unknown[]; metadata: Record<string, unknown> }> = [];
  const notices: Array<{ title: string; missionId: string }> = [];
  let n = 0;
  const supervisor = createMissionSupervisor({
    getMission: (id) => byId.get(id) ?? null,
    startAttempt: async (input) => {
      started.push({ title: input.title, ...(input.steps !== undefined ? { steps: input.steps } : {}), metadata: input.metadata });
      const created = mission({
        id: `mission_retry_${++n}`,
        title: input.title,
        status: "QUEUED",
        metadata: input.metadata,
      });
      byId.set(created.id, created);
      return created;
    },
    notify: (input) => notices.push({ title: input.title, missionId: input.missionId }),
    ...(opts.maxAttempts !== undefined ? { bounds: { maxAttempts: opts.maxAttempts } } : {}),
  });
  return { supervisor, started, notices, byId };
}

test("a transient failure with budget left is retried, as a NEW mission that supersedes the old", async () => {
  const h = harness([mission({ id: "m1", code: "AGENT_TIMEOUT" })]);
  const decision = await h.supervisor.observe("m1");
  assert.equal(decision.action, "retry", JSON.stringify(decision));
  assert.equal(decision.attempt, 2);
  assert.equal(h.started.length, 1);
  assert.equal(h.started[0]?.metadata["supersedes"], "m1", "the retry names the mission it supersedes");
  assert.equal(h.started[0]?.metadata["autonomyAttempt"], 2);
  assert.match(String(h.started[0]?.metadata["autonomyReason"]), /AGENT_TIMEOUT/);
  assert.equal(h.notices.length, 1, "a retry is announced, not silent");
});

test("a NON-transient failure is never retried", async () => {
  for (const code of ["POLICY_DENIED", "APPROVAL_REQUIRED", "VALIDATION_FAILED", "NOT_FOUND", "AGENT_CAPABILITY_MISSING", "AGENT_AUTH_FAILED", "AGENT_RUN_ABANDONED"] as KaiErrorCode[]) {
    const h = harness([mission({ id: `m-${code}`, code })]);
    const decision = await h.supervisor.observe(`m-${code}`);
    assert.equal(decision.action, "stop", `${code} must not be retried: ${JSON.stringify(decision)}`);
    assert.equal(h.started.length, 0, `${code} must start nothing`);
  }
});

test("every code the loop treats as transient is actually in the transient set", () => {
  for (const code of ["AGENT_TIMEOUT", "AGENT_NOT_LISTENING", "AGENT_BAD_RESPONSE", "AGENT_RUN_FAILED", "INTERNAL", "STORAGE_FAILED"] as KaiErrorCode[]) {
    assert.equal(TRANSIENT_ERROR_CODES.has(code), true, `${code} should be transient`);
  }
});

test("the budget is respected and a spent budget escalates to a human", async () => {
  // A mission already on attempt 2 with maxAttempts 1: the one re-attempt is spent.
  const h = harness([mission({ id: "m1", code: "AGENT_TIMEOUT", metadata: { autonomyAttempt: 2 } })]);
  const decision = await h.supervisor.observe("m1");
  assert.equal(decision.action, "escalate", JSON.stringify(decision));
  assert.equal(h.started.length, 0);
  assert.equal(h.notices.length, 1, "escalation tells the human");

  // With budget for one more, the same mission retries — and the RETRY, when it
  // fails too, escalates instead of retrying again.
  const h2 = harness([mission({ id: "m1", code: "INTERNAL" })], { maxAttempts: 1 });
  const first = await h2.supervisor.observe("m1");
  assert.equal(first.action, "retry");
  const retry = h2.byId.get(first.retryMissionId as string);
  assert.ok(retry);
  // The retry failed as well.
  h2.byId.set(retry.id, mission({ id: retry.id, code: "INTERNAL", metadata: retry.metadata }));
  const second = await h2.supervisor.observe(retry.id);
  assert.equal(second.action, "escalate", JSON.stringify(second));
  assert.equal(h2.started.length, 1, "exactly one automatic retry, no loop");
});

test("maxAttempts 0 disables the loop entirely", async () => {
  const h = harness([mission({ id: "m1", code: "INTERNAL" })], { maxAttempts: 0 });
  const decision = await h.supervisor.observe("m1");
  assert.equal(decision.action, "stop");
  assert.equal(h.started.length, 0);
});

test("only a settled mission is supervised; a running or unknown one is a no-op", async () => {
  const h = harness([mission({ id: "ok", status: "COMPLETED" }), mission({ id: "running", status: "RUNNING" })]);
  // A COMPLETED mission with settled steps is verified and left settled — not
  // retried, and it starts nothing.
  assert.equal((await h.supervisor.observe("ok")).action, "stop");
  assert.equal((await h.supervisor.observe("running")).action, "stop");
  assert.equal((await h.supervisor.observe("nope")).action, "stop");
  assert.equal(h.started.length, 0);
});

test("a COMPLETED mission with an unsettled step escalates to a human, never silently passes", async () => {
  const h = harness([
    mission({
      id: "bad",
      status: "COMPLETED",
      steps: [
        { id: "s0", missionId: "bad", index: 0, title: "did not finish", kind: "tool", status: "FAILED", sideEffecting: true, target: "net.send" },
      ],
    }),
  ]);
  const decision = await h.supervisor.observe("bad");
  assert.equal(decision.action, "escalate", JSON.stringify(decision));
  assert.equal(h.notices.length, 1, "the inconsistency is told to the human");
  assert.equal(h.started.length, 0, "an inconsistent completion is never re-run automatically");
});

test("a cancelled mission is deliberate: supervised, never retried", async () => {
  const h = harness([mission({ id: "c1", status: "CANCELLED" })]);
  const decision = await h.supervisor.observe("c1");
  assert.equal(decision.action, "stop", JSON.stringify(decision));
  assert.equal(h.started.length, 0);
});

test("the attempt number and chain root come from the mission, so a restart cannot reset the budget", () => {
  assert.equal(attemptOf(mission({ metadata: {} })), 1);
  assert.equal(attemptOf(mission({ metadata: { autonomyAttempt: 3 } })), 3);
  assert.equal(attemptOf(mission({ metadata: { autonomyAttempt: "x" } })), 1, "a malformed attempt is 1, never NaN");
  assert.equal(chainRoot(mission({ id: "a" })), "a");
  assert.equal(chainRoot(mission({ id: "b", metadata: { supersedes: "a" } })), "a");
});

test("the runtime wires the loop: a settled failure is evaluated through the live bus", async (t) => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createCoreRuntime } = await import("../src/runtime.ts");

  const dir = mkdtempSync(join(tmpdir(), "kai-autonomy-"));
  const runtime = createCoreRuntime({
    dbPath: join(dir, "kai.db"),
    agents: { mode: "mock" },
    startScheduler: false,
    subsystemPaths: { runUpkeepOnStart: false },
  });
  t.after(async () => {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  assert.equal(runtime.autonomyDecisions().length, 0, "nothing has been decided yet");

  // A step targeting the MCP capability throws inside execute, which the registry
  // reports as INTERNAL — a TRANSIENT failure. So the loop must evaluate it, START
  // A RETRY, evaluate the retry in turn, and stop there: exactly one re-attempt.
  const failed = await runtime.createAndStartMission({
    title: "autonomy probe",
    steps: [{ title: "call a broken capability action", kind: "tool", target: "capability.system", input: { action: "no.such.action" } }],
  });
  const settled = await (async () => {
    const deadline = Date.now() + 6000;
    let current = failed;
    while (Date.now() < deadline) {
      current = runtime.stores.missions.getMission(failed.id) ?? current;
      if (current.status === "FAILED" || current.status === "COMPLETED") break;
      await new Promise((r) => setTimeout(r, 25));
    }
    return current;
  })();
  assert.equal(settled.status, "FAILED", JSON.stringify(settled));

  const decided = await (async () => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const d = runtime.autonomyDecisions();
      if (d.some((x) => x.action === "escalate")) return d;
      await new Promise((r) => setTimeout(r, 25));
    }
    return runtime.autonomyDecisions();
  })();

  const forThis = decided.filter((d) => d.missionId === failed.id);
  assert.equal(forThis.length, 1, `the live bus reached the supervisor exactly once for the original: ${JSON.stringify(decided)}`);
  assert.equal(forThis[0]?.action, "retry", `INTERNAL is transient, so it retries: ${JSON.stringify(forThis[0])}`);

  const retryId = forThis[0]?.retryMissionId as string;
  const retry = runtime.stores.missions.getMission(retryId);
  assert.ok(retry, "the retry mission exists");
  assert.equal(retry.metadata?.["supersedes"], failed.id, "the retry names what it supersedes");
  assert.equal(retry.metadata?.["autonomyAttempt"], 2);

  // The retry failed the same way, and the loop STOPPED at the bound instead of
  // looping: one retry, then escalate.
  const escalate = decided.find((d) => d.missionId === retryId);
  assert.ok(escalate, `the retry was evaluated too: ${JSON.stringify(decided)}`);
  assert.equal(escalate.action, "escalate", JSON.stringify(escalate));
  assert.equal(decided.filter((d) => d.action === "retry").length, 1, "exactly one automatic retry");
});
