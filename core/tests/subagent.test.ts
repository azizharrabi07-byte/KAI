// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * subagent tests — the two defects that made KAI's subagents unusable in the
 * product, pinned so they cannot regress.
 *
 *  B1  A subagent run was refused with AGENT_CAPABILITY_MISSING BEFORE it reached
 *      the policy/approval stage, because its employee INSTANCE carried only the
 *      persona's TOOL GRANTS and never the structural `run_task` delegation
 *      ability. These tests prove the run now reaches the policy-governed
 *      executor and PARKS for approval, while the persona's grants stay intact.
 *
 *  B2  Persisted personas evaporated on a Core restart: the registry reloaded
 *      `kai-subagents.json` but boot never re-registered the employees, so
 *      `/subagents` read UNKNOWN. These tests boot a Core, define a persona,
 *      stop it, boot a SECOND Core on the same files, and prove the persona is
 *      registered and enabled (not UNKNOWN).
 *
 * Deterministic: mock agents, a temp SQLite file, no network.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCoreRuntime } from "../src/runtime.ts";
import { createWorkforceManager } from "../src/workforce/manager.ts";
import { descriptorForSubagent } from "../src/workforce/subagent.ts";
import { createMockHermes, createMockOpenCode } from "../src/agents/mock.ts";
import { createCoreApi } from "../src/api/routes.ts";
import type { AgentTaskResult } from "../src/shared/contracts.ts";

function tempDir(name: string): string {
  return mkdtempSync(join(tmpdir(), `kai-subagent-${name}-`));
}

/** A minimal persona whose declared capabilities are TOOL GRANTS, deliberately
 *  WITHOUT `run_task` — the exact shape that used to be refused. */
const ALICE = {
  id: "alice",
  name: "Alice",
  role: "researcher",
  soul: "Patient, sceptical, cites everything.",
  workerId: "hermes",
  capabilities: ["filesystem"],
} as const;

// ── B1: the delegation ability lives on the instance, not the persona grants ──

test("a subagent whose grants exclude run_task still reaches the policy-governed executor", async () => {
  const calls: Array<{ employeeId: string; capability: string; taskId: string; input: string }> = [];
  const workforce = createWorkforceManager({
    executeTask: async (input): Promise<AgentTaskResult> => {
      calls.push(input);
      // The real executor PARKS an EXTERNAL action; this stands in for the tool
      // registry's APPROVAL_REQUIRED verdict.
      return {
        taskId: input.taskId,
        state: "failed",
        error: { code: "APPROVAL_REQUIRED", message: "parked for approval", retryable: false, at: new Date().toISOString() },
      } as AgentTaskResult;
    },
  });

  const descriptor = descriptorForSubagent(ALICE as never, { adapterFor: () => createMockHermes() });
  const registered = workforce.register(descriptor, { kind: "subagent" });
  assert.equal(registered.ok, true, JSON.stringify(registered));
  workforce.assignRole("kai:alice", "subagent:alice");
  await workforce.healthCheck("kai:alice");

  const delegated = await workforce.delegate({
    capability: "run_task",
    role: "subagent:alice",
    taskId: "subagent:alice",
    input: "do the research",
  });

  assert.equal(calls.length, 1, `the executor must be reached, got: ${JSON.stringify(delegated)}`);
  assert.equal(calls[0]?.capability, "run_task");
  assert.equal(calls[0]?.employeeId, "kai:alice");
  assert.equal(delegated.error?.code, "APPROVAL_REQUIRED", `must park, got: ${JSON.stringify(delegated)}`);

  // The persona's declared capabilities are its TOOL GRANTS and are NOT widened:
  // `run_task` is the instance's delegation ability and must not leak into the
  // capability manager's view of the employee.
  const row = workforce.describe("kai:alice")[0];
  assert.deepEqual(row?.capabilities, ["filesystem"], "the persona's grants must be unchanged");
});

// ── B2: a persisted persona survives a Core restart ───────────────────────────

test("a persisted subagent is re-registered into the workforce on the next boot", async () => {
  const dir = tempDir("restart");
  const dbPath = join(dir, "kai-core.db");
  const subagentsPath = join(dir, "kai-subagents.json");
  const boot = () =>
    createCoreRuntime({
      dbPath,
      agents: { mode: "mock" },
      startScheduler: false,
      subsystemPaths: { subagentsPath, runUpkeepOnStart: false },
    });

  const first = boot();
  try {
    await first.start();
    const defined = await first.tools.invoke("workforce.subagent", ALICE);
    assert.equal(defined.ok, true, JSON.stringify(defined));
    const row = first.workforce.describe("kai:alice")[0];
    assert.ok(row !== undefined, "registration creates the employee immediately");
    assert.equal(row?.enabled, true);
    assert.notEqual(row?.state, "UNKNOWN", "an in-process registration is a known employee");

    // The run reaches the policy boundary and parks — the no-bypass proof.
    const run = (await first.runSubagent("alice", "do the research")) as {
      error?: { code?: string };
      result?: { error?: { code?: string } };
    };
    const code = run.error?.code ?? run.result?.error?.code;
    assert.equal(code, "APPROVAL_REQUIRED", `a run must park, got: ${JSON.stringify(run)}`);
  } finally {
    await first.stop();
  }

  const second = boot();
  try {
    await second.start();
    assert.equal(second.subagents.list().length, 1, "the persona itself is still persisted");
    const row = second.workforce.describe("kai:alice")[0];
    assert.ok(row !== undefined, "the persona's employee must be re-registered at boot");
    assert.notEqual(row?.state, "UNKNOWN", "status must not fall back to UNKNOWN after restart");
    assert.equal(row?.enabled, true, "a restored persona is enabled, not vanished");
    assert.equal(row?.state, "READY", "with its worker up it is READY again");
  } finally {
    await second.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Execution observability + concurrent persona runs (route level) ───────────
//
// These drive the REAL product route (createCoreApi POST /subagents and
// /subagents/:id/message) against a real runtime with MOCK adapters, so the
// route logic, the approval park/re-issue flow and the new `execution` record are
// exercised deterministically. They prove the ROUTE can report two DISTINCT,
// wall-clock-OVERLAPPING executions; they are NOT the real-worker concurrency
// proof (that comes from the live harness against the running product).

const NODE_SMITH = {
  id: "node-smith",
  name: "Node Smith",
  role: "implementation engineer",
  soul: "Blunt, ships small diffs, tests first.",
  workerId: "hermes",
  capabilities: ["filesystem"],
  visual: { colour: "#FBBF24", outfit: "cap", accessories: ["laptop"] },
} as const;

const DEEP_WORKER = {
  id: "deep-worker",
  name: "Deep Worker",
  role: "deep researcher",
  soul: "Patient, sceptical, cites everything.",
  workerId: "opencode",
  capabilities: ["filesystem"],
  visual: { colour: "#8B5CF6", outfit: "halo" },
} as const;

interface ApiResult {
  status: number;
  body: Record<string, unknown>;
}

function jsonResult(result: { status: number; body: unknown }): ApiResult {
  return { status: result.status, body: result.body as Record<string, unknown> };
}

test("POST /subagents creates a persona and POST /subagents/:id/message parks then executes as the persona, with an execution record", async () => {
  const dir = tempDir("exec");
  const runtime = createCoreRuntime({
    dbPath: join(dir, "kai.db"),
    agents: { mode: "mock" },
    startScheduler: false,
    subsystemPaths: { runUpkeepOnStart: false },
  });
  try {
    await runtime.start();
    // A longer mock turn so two concurrent runs genuinely overlap in wall-clock.
    runtime.registry.register(createMockHermes({ workMs: 500 }));
    await runtime.registry.connectAll();

    const api = createCoreApi(runtime);

    // CREATE through the real route (WRITE + internal-state policy => no park).
    const created = jsonResult(
      await api.handle({ method: "POST", path: "/subagents", query: new URLSearchParams(), attested: true, ownerAuthConfigured: true, body: { ...NODE_SMITH } }),
    );
    assert.equal(created.status, 201, JSON.stringify(created));
    assert.equal((created.body.subagent as Record<string, unknown>).name, "Node Smith");

    // 1st message: parks (agents.run_task is EXTERNAL), returns an approvalId + sessionId.
    const parked = jsonResult(
      await api.handle({
        method: "POST",
        path: "/subagents/node-smith/message",
        query: new URLSearchParams(), attested: true, ownerAuthConfigured: true,
        body: { input: "Write a failing test for the two-run invariant." },
      }),
    );
    assert.equal(parked.status, 409, JSON.stringify(parked));
    assert.equal(parked.body.approvalRequired, true);
    const approvalId = parked.body.approvalId as string;
    const sessionId = parked.body.sessionId as string;
    assert.ok(typeof approvalId === "string" && approvalId.length > 0, "a real approval id is minted");
    assert.ok(typeof sessionId === "string" && sessionId.length > 0);

    // 2nd message with the human's approvalId: decides + executes + records the reply.
    const executed = jsonResult(
      await api.handle({
        method: "POST",
        path: "/subagents/node-smith/message",
        query: new URLSearchParams(), attested: true, ownerAuthConfigured: true,
        body: { input: "Write a failing test for the two-run invariant.", sessionId, approvalId },
      }),
    );
    assert.equal(executed.status, 200, JSON.stringify(executed));
    const reply = executed.body.reply as string;
    assert.ok(reply.startsWith("I'm Node Smith, KAI's implementation engineer."), `persona leads the reply: ${reply}`);
    assert.ok(!/Hermes Agent/i.test(reply), "the worker's own name must not leak into the persona's reply");

    const execution = executed.body.execution as Record<string, unknown>;
    assert.ok(execution !== undefined, "the run must carry a real execution record");
    assert.equal(execution.executionId, approvalId, "the execution id is the approval that ran it");
    assert.equal(execution.subagentId, "node-smith");
    assert.equal(execution.sessionId, sessionId);
    assert.equal(execution.worker, "hermes");
    assert.equal(execution.status, "completed");
    assert.ok(typeof execution.startMonotonicMs === "number" && typeof execution.endMonotonicMs === "number");
    assert.ok((execution.endMonotonicMs as number) >= (execution.startMonotonicMs as number));
    assert.ok(typeof execution.durationMs === "number" && (execution.durationMs as number) >= 0);

    // The persona's turn landed on its OWN session, and the user+assistant turns are there.
    const turns = jsonResult(
      await api.handle({
        method: "GET",
        path: `/subagents/node-smith/sessions/${sessionId}/turns`,
        query: new URLSearchParams(), attested: true, ownerAuthConfigured: true,
        body: null,
      }),
    );
    assert.equal(turns.status, 200, JSON.stringify(turns));
    const recorded = turns.body.turns as Array<{ role: string; text: string }>;
    assert.ok(recorded.some((t) => t.role === "assistant" && t.text.startsWith("I'm Node Smith")), JSON.stringify(recorded));
  } finally {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two concurrent persona runs report DISTINCT execution ids with overlapping monotonic windows", async () => {
  const dir = tempDir("overlap");
  const runtime = createCoreRuntime({
    dbPath: join(dir, "kai.db"),
    agents: { mode: "mock" },
    startScheduler: false,
    subsystemPaths: { runUpkeepOnStart: false },
  });
  try {
    await runtime.start();
    runtime.registry.register(createMockHermes({ workMs: 600 }));
    runtime.registry.register(createMockOpenCode({ workMs: 600 }));
    await runtime.registry.connectAll();
    const api = createCoreApi(runtime);

    for (const spec of [NODE_SMITH, DEEP_WORKER]) {
      const r = jsonResult(
        await api.handle({ method: "POST", path: "/subagents", query: new URLSearchParams(), attested: true, ownerAuthConfigured: true, body: { ...spec } }),
      );
      assert.equal(r.status, 201, JSON.stringify(r));
    }

    const defineRun = async (id: string, input: string) => {
      const parked = jsonResult(
        await api.handle({ method: "POST", path: `/subagents/${id}/message`, query: new URLSearchParams(), attested: true, ownerAuthConfigured: true, body: { input } }),
      );
      assert.equal(parked.status, 409, JSON.stringify(parked));
      return { id, input, approvalId: parked.body.approvalId as string, sessionId: parked.body.sessionId as string };
    };

    const a = await defineRun("node-smith", "Task A: build the two-run invariant.");
    const b = await defineRun("deep-worker", "Task B: summarise the concurrency spec.");
    assert.notEqual(a.approvalId, b.approvalId, "the two parks must be distinct");
    assert.notEqual(a.sessionId, b.sessionId, "each persona has its OWN session");

    // Fire BOTH executions at the same instant.
    const [ra, rb] = await Promise.all([
      api.handle({
        method: "POST",
        path: "/subagents/node-smith/message",
        query: new URLSearchParams(), attested: true, ownerAuthConfigured: true,
        body: { input: a.input, sessionId: a.sessionId, approvalId: a.approvalId },
      }),
      api.handle({
        method: "POST",
        path: "/subagents/deep-worker/message",
        query: new URLSearchParams(), attested: true, ownerAuthConfigured: true,
        body: { input: b.input, sessionId: b.sessionId, approvalId: b.approvalId },
      }),
    ]);
    const ea = (jsonResult(ra).body.execution as Record<string, number & string>);
    const eb = (jsonResult(rb).body.execution as Record<string, number & string>);

    assert.notEqual(ea.executionId, eb.executionId, "separate execution ids");
    assert.equal(ea.worker, "hermes");
    assert.equal(eb.worker, "opencode");
    assert.equal(ea.status, "completed");
    assert.equal(eb.status, "completed");

    // overlap = max(startA,startB) < min(endA,endB) — computed, never by eye.
    const startMax = Math.max(ea.startMonotonicMs as number, eb.startMonotonicMs as number);
    const endMin = Math.min(ea.endMonotonicMs as number, eb.endMonotonicMs as number);
    assert.ok(startMax < endMin, `windows must genuinely overlap: A=[${ea.startMonotonicMs},${ea.endMonotonicMs}] B=[${eb.startMonotonicMs},${eb.endMonotonicMs}]`);

    // The two replies carry their OWN persona voice, not the other's and not the worker's.
    const replyA = jsonResult(ra).body.reply as string;
    const replyB = jsonResult(rb).body.reply as string;
    assert.ok(replyA.startsWith("I'm Node Smith"), replyA);
    assert.ok(replyB.startsWith("I'm Deep Worker"), replyB);
    assert.ok(!replyA.includes("Deep Worker") && !replyB.includes("Node Smith"), "no persona cross-contamination");
  } finally {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a persona's turns never merge into KAI's own session (session isolation)", async () => {
  const dir = tempDir("isolation");
  const runtime = createCoreRuntime({
    dbPath: join(dir, "kai.db"),
    agents: { mode: "mock" },
    startScheduler: false,
    subsystemPaths: { runUpkeepOnStart: false },
  });
  try {
    await runtime.start();
    const api = createCoreApi(runtime);

    const kaiSession = jsonResult(
      await api.handle({ method: "POST", path: "/sessions", query: new URLSearchParams(), attested: true, ownerAuthConfigured: true, body: { title: "KAI main" } }),
    );
    assert.equal(kaiSession.status, 201, JSON.stringify(kaiSession));
    const kaiId = (kaiSession.body.session as Record<string, unknown>).id as string;

    const created = jsonResult(
      await api.handle({ method: "POST", path: "/subagents", query: new URLSearchParams(), attested: true, ownerAuthConfigured: true, body: { ...NODE_SMITH } }),
    );
    assert.equal(created.status, 201);

    const parked = jsonResult(
      await api.handle({ method: "POST", path: "/subagents/node-smith/message", query: new URLSearchParams(), attested: true, ownerAuthConfigured: true, body: { input: "hi" } }),
    );
    const approvalId = parked.body.approvalId as string;
    const subSessionId = parked.body.sessionId as string;
    await api.handle({
      method: "POST",
      path: "/subagents/node-smith/message",
      query: new URLSearchParams(), attested: true, ownerAuthConfigured: true,
      body: { input: "hi", sessionId: subSessionId, approvalId },
    });

    // KAI's own session is untouched; the persona's session holds the turns.
    const kaiTurns = jsonResult(
      await api.handle({ method: "GET", path: `/sessions/${kaiId}/turns`, query: new URLSearchParams(), attested: true, ownerAuthConfigured: true, body: null }),
    );
    assert.equal((kaiTurns.body.turns as unknown[]).length, 0, "KAI's history must be unchanged");
    const subTurns = jsonResult(
      await api.handle({
        method: "GET",
        path: `/subagents/node-smith/sessions/${subSessionId}/turns`,
        query: new URLSearchParams(), attested: true, ownerAuthConfigured: true,
        body: null,
      }),
    );
    assert.ok((subTurns.body.turns as unknown[]).length > 0, "the persona's own history is preserved");
    assert.notEqual(kaiId, subSessionId, "the persona session is a different id from KAI's");
  } finally {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── /subagents/:id/run forwards the body's approvalId (the 6710b7f fix) ────────
// `runSubagentHandler` used to call `runtime.runSubagent(id, input)` with two
// arguments, DROPPING the body's approvalId. A caller doing exactly what the
// route's own docstring instructs — re-issue the run with the granted id — re-ran
// the EXTERNAL policy check from scratch and minted a SECOND approval instead of
// consuming the one already granted, so the documented contract was unsatisfiable.
// This pins the fixed behaviour: the granted id is carried through, so the
// re-issue consumes the grant and mints nothing.
test("POST /subagents/:id/run forwards the body's approvalId, so a re-issue consumes the granted approval instead of minting a second one", async () => {
  const dir = tempDir("run-approval");
  const runtime = createCoreRuntime({
    dbPath: join(dir, "kai.db"),
    agents: { mode: "mock" },
    startScheduler: false,
    subsystemPaths: { runUpkeepOnStart: false },
  });
  try {
    await runtime.start();
    runtime.registry.register(createMockHermes({ workMs: 10 }));
    await runtime.registry.connectAll();
    const api = createCoreApi(runtime);

    const created = jsonResult(
      await api.handle({ method: "POST", path: "/subagents", query: new URLSearchParams(), attested: true, ownerAuthConfigured: true, body: { ...NODE_SMITH } }),
    );
    assert.equal(created.status, 201, JSON.stringify(created));

    const listApprovals = async (): Promise<Array<{ id: string; status: string; toolId: string }>> => {
      const r = jsonResult(
        await api.handle({ method: "GET", path: "/approvals", query: new URLSearchParams(), attested: true, ownerAuthConfigured: true, body: null }),
      );
      assert.equal(r.status, 200, JSON.stringify(r));
      return r.body.approvals as Array<{ id: string; status: string; toolId: string }>;
    };

    // 1st run: EXTERNAL `agents.run_task` parks — a real approval is minted.
    const parked = jsonResult(
      await api.handle({
        method: "POST",
        path: "/subagents/node-smith/run",
        query: new URLSearchParams(), attested: true, ownerAuthConfigured: true,
        body: { input: "Run the probe." },
      }),
    );
    assert.equal(parked.status, 409, JSON.stringify(parked));
    assert.equal(parked.body.approvalRequired, true);
    const granted = parked.body.approvalId as string;
    assert.ok(typeof granted === "string" && granted.length > 0, "a real approval id is minted");

    // The human's answer, through the ONE approval gate (consumes the parked record
    // and re-issues the exact run once).
    const decided = jsonResult(
      await api.handle({
        method: "POST",
        path: `/approvals/${granted}/decide`,
        query: new URLSearchParams(), attested: true, ownerAuthConfigured: true,
        body: { approved: true },
      }),
    );
    assert.ok(decided.status < 400, JSON.stringify(decided));

    const before = await listApprovals();

    // Re-issue the run carrying the GRANTED id. Pre-fix this dropped the id, re-ran
    // the EXTERNAL check and minted a SECOND approval; now it consumes the grant: the
    // run executes under the id it was given and no new approval appears.
    const reissued = jsonResult(
      await api.handle({
        method: "POST",
        path: "/subagents/node-smith/run",
        query: new URLSearchParams(), attested: true, ownerAuthConfigured: true,
        body: { input: "Run the probe.", approvalId: granted },
      }),
    );
    assert.equal(
      reissued.status,
      200,
      `the re-issue must execute under the granted approval, not park again: ${JSON.stringify(reissued)}`,
    );
    assert.equal(reissued.body.approvalRequired, undefined, "the re-issue does not park");
    assert.equal(reissued.body.approvalId, undefined, "the re-issue mints no second approval");

    const after = await listApprovals();
    assert.equal(
      after.length,
      before.length,
      `the re-issue must not mint an approval; count ${before.length} -> ${after.length}`,
    );
    assert.ok(
      after.every((a) => a.status !== "PENDING"),
      `nothing new is left pending: ${JSON.stringify(after)}`,
    );

    // CONTROL: the SAME body with NO approvalId — the pre-fix call shape — mints a
    // fresh approval, proving the id is exactly what makes the re-issue consume.
    const control = jsonResult(
      await api.handle({
        method: "POST",
        path: "/subagents/node-smith/run",
        query: new URLSearchParams(), attested: true, ownerAuthConfigured: true,
        body: { input: "Run the probe." },
      }),
    );
    assert.equal(control.status, 409, JSON.stringify(control));
    const second = control.body.approvalId as string;
    assert.ok(
      typeof second === "string" && second.length > 0 && second !== granted,
      `without the id a NEW approval is minted (was ${granted}, got ${second})`,
    );
  } finally {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
