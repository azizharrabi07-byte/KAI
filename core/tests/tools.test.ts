// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Tool registry + builtin tool tests. Plain `node --test`, no deps.
 * Run from `core/`:  node --test tests/tools.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createToolRegistry } from "../src/tools/registry.ts";
import type { ToolDefinition } from "../src/tools/registry.ts";
import { createPolicyEngine } from "../src/policies/gate.ts";
import type { PolicyGate } from "../src/policies/gate.ts";
import { createApprovalService } from "../src/approvals/service.ts";
import { BUILTIN_TOOL_IDS, MAX_LIST_LIMIT, createBuiltinTools, registerBuiltinTools } from "../src/tools/builtin.ts";
import type {
  AgentStatus,
  Approval,
  ApprovalStatus,
  ApprovalStore,
  KaiEventType,
  Memory,
  Mission,
  RiskLevel,
} from "../src/shared/contracts.ts";

/** Hand-written fake — deliberately does NOT import core/src/storage. */
function fakeApprovalStore(): ApprovalStore & { rows: Approval[] } {
  const rows: Approval[] = [];
  return {
    rows,
    createApproval(approval: Approval): void {
      rows.push({ ...approval });
    },
    getApproval(id: string): Approval | null {
      const row = rows.find((entry) => entry.id === id);
      return row === undefined ? null : { ...row };
    },
    listApprovals(opts?: { status?: ApprovalStatus; limit?: number }): Approval[] {
      let out = rows.map((row) => ({ ...row }));
      if (opts?.status !== undefined) out = out.filter((row) => row.status === opts.status);
      if (opts?.limit !== undefined) out = out.slice(0, opts.limit);
      return out;
    },
    decideApproval(id: string, status: ApprovalStatus, decidedAt: string): void {
      const row = rows.find((entry) => entry.id === id);
      if (row !== undefined) {
        row.status = status;
        row.decidedAt = decidedAt;
      }
    },
  };
}

const BASE_MS = Date.parse("2026-01-02T03:04:05.000Z");
/** Out-of-range limit used by the builtin validator test. */
const MAX_LIMIT_BAD = MAX_LIST_LIMIT + 1;
function clock(): { now: () => Date; advance: (ms: number) => void } {
  let offset = 0;
  return {
    now: () => new Date(BASE_MS + offset),
    advance: (ms: number) => {
      offset += ms;
    },
  };
}

function recorder(): { events: { type: KaiEventType; payload: unknown }[]; publish: (t: KaiEventType, p: unknown) => void } {
  const events: { type: KaiEventType; payload: unknown }[] = [];
  return {
    events,
    publish: (type, payload) => {
      events.push({ type, payload });
    },
  };
}

/** A tool that records being validated / executed, for order-of-operations proofs. */
function spyTool(opts: {
  id?: string;
  risk?: RiskLevel;
  calls: string[];
  validate?: (input: unknown) => { ok: true; value: unknown } | { ok: false; reason: string };
  execute?: (input: unknown, ctx: { missionId?: string; stepId?: string }) => Promise<unknown>;
}): ToolDefinition {
  return {
    id: opts.id ?? "demo.tool",
    name: "Demo tool",
    description: "a tool used by the tests",
    risk: opts.risk ?? "WRITE",
    validate(input: unknown) {
      opts.calls.push("validate");
      if (opts.validate !== undefined) return opts.validate(input);
      return { ok: true, value: input };
    },
    async execute(input: unknown, ctx: { missionId?: string; stepId?: string }) {
      opts.calls.push("execute");
      if (opts.execute !== undefined) return opts.execute(input, ctx);
      return { done: true };
    },
  };
}

function recordingGate(outcome: "allow" | "deny" | "needs_approval", calls: string[]): PolicyGate {
  return {
    async check() {
      calls.push("policy");
      return { outcome, reason: `test gate says ${outcome} for the fixture tool` };
    },
  };
}

// ── Mandatory ordering ────────────────────────────────────────────────────────

test("invoke runs validate -> policy -> execute, in that order", async () => {
  const calls: string[] = [];
  const registry = createToolRegistry({ policy: recordingGate("allow", calls) });
  registry.register(spyTool({ id: "demo.echo", risk: "READ", calls }));

  const result = await registry.invoke("demo.echo", { a: 1 });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["validate", "policy", "execute"]);
});

test("a bad input is rejected before policy or execute ever see it", async () => {
  const calls: string[] = [];
  const registry = createToolRegistry({ policy: recordingGate("allow", calls) });
  registry.register(
    spyTool({
      id: "demo.echo",
      risk: "READ",
      calls,
      validate: (input) =>
        typeof input === "object" && input !== null
          ? { ok: true, value: input }
          : { ok: false, reason: "input must be an object" },
    }),
  );

  const result = await registry.invoke("demo.echo", "not-an-object");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "VALIDATION_FAILED");
    assert.match(result.error.message, /input must be an object/);
    assert.equal(result.error.retryable, false);
  }
  assert.deepEqual(calls, ["validate"], "policy and execute must not run for invalid input");
});

test("a denied request never reaches execute", async () => {
  const calls: string[] = [];
  const registry = createToolRegistry({ policy: recordingGate("deny", calls) });
  registry.register(spyTool({ id: "demo.write", risk: "WRITE", calls }));

  const result = await registry.invoke("demo.write", {});
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "POLICY_DENIED");
    assert.match(result.error.message, /test gate says deny/);
  }
  assert.deepEqual(calls, ["validate", "policy"], "execute must not be called on deny");
});

test("a validator that throws is a validation failure, not an exception", async () => {
  const calls: string[] = [];
  const registry = createToolRegistry({ policy: recordingGate("allow", calls) });
  registry.register(
    spyTool({
      id: "demo.bad",
      calls,
      validate: () => {
        throw new Error("validator blew up");
      },
    }),
  );

  const result = await registry.invoke("demo.bad", {});
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "VALIDATION_FAILED");
    assert.match(result.error.message, /validator blew up/);
  }
  assert.deepEqual(calls, ["validate"]);
});

test("a validator returning a malformed result is refused", async () => {
  const calls: string[] = [];
  const registry = createToolRegistry({ policy: recordingGate("allow", calls) });
  registry.register(spyTool({ id: "demo.bad", calls, validate: () => (null as never) }));

  const result = await registry.invoke("demo.bad", {});
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "VALIDATION_FAILED");
    assert.match(result.error.message, /malformed result/);
  }
});

// ── Failure modes are values ──────────────────────────────────────────────────

test("an unknown tool id returns NOT_FOUND", async () => {
  const calls: string[] = [];
  const registry = createToolRegistry({ policy: recordingGate("allow", calls) });
  const result = await registry.invoke("nope.missing", {});
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "NOT_FOUND");
  assert.deepEqual(calls, []);
});

test("execute throwing becomes an INTERNAL KaiError and is not propagated", async () => {
  const calls: string[] = [];
  const registry = createToolRegistry({ policy: recordingGate("allow", calls) });
  registry.register(
    spyTool({
      id: "demo.boom",
      risk: "READ",
      calls,
      execute: async () => {
        throw new Error("disk on fire");
      },
    }),
  );

  let result: Awaited<ReturnType<typeof registry.invoke>> | undefined;
  await assert.doesNotReject(async () => {
    result = await registry.invoke("demo.boom", {});
  });

  assert.equal(result!.ok, false);
  if (result !== undefined && !result.ok) {
    assert.equal(result.error.code, "INTERNAL");
    assert.match(result.error.message, /disk on fire/);
    assert.equal(result.error.retryable, false);
  }
});

test("a registry with no policy gate refuses to run anything", async () => {
  const calls: string[] = [];
  const registry = createToolRegistry({});
  registry.register(spyTool({ id: "demo.read", risk: "READ", calls }));

  const result = await registry.invoke("demo.read", {});
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "POLICY_DENIED");
  assert.deepEqual(calls, ["validate"], "validation happens, execution does not");
});

test("register refuses malformed and duplicate definitions", () => {
  const registry = createToolRegistry({});
  assert.throws(() => registry.register({ id: "", name: "x", description: "y", risk: "READ", validate: () => ({ ok: true, value: undefined }), execute: async () => null }), /non-empty id/);
  assert.throws(() => registry.register({ id: "a", name: "", description: "y", risk: "READ", validate: () => ({ ok: true, value: undefined }), execute: async () => null }), /non-empty name/);

  const tool = spyTool({ id: "demo.dup", calls: [] });
  registry.register(tool);
  assert.throws(() => registry.register(spyTool({ id: "demo.dup", calls: [] })), /already registered/);
  assert.equal(registry.get("demo.dup"), tool);
});

// ── Approval path, end to end ─────────────────────────────────────────────────

function makeApprovalRig() {
  const store = fakeApprovalStore();
  const rec = recorder();
  const c = clock();
  let n = 0;
  const approvals = createApprovalService({
    store,
    publish: rec.publish,
    now: c.now,
    idFactory: () => `ap${++n}`,
  });
  const policy = createPolicyEngine(); // WRITE -> needs_approval by default
  const registry = createToolRegistry({ policy, approvals, now: c.now });
  const calls: string[] = [];
  registry.register(spyTool({ id: "demo.write", risk: "WRITE", calls }));
  return { store, rec, c, approvals, registry, calls };
}

test("approval path end to end: needs_approval -> request -> approve -> invoke succeeds", async () => {
  const rig = makeApprovalRig();

  const attempt = await rig.registry.invoke("demo.write", { value: 1 });
  assert.equal(attempt.ok, false);
  if (!attempt.ok) {
    assert.equal(attempt.error.code, "APPROVAL_REQUIRED");
    assert.equal(attempt.error.detail, "ap1", "the pending approval id is handed back");
  }
  assert.deepEqual(rig.calls, ["validate"], "execute must not run without approval");

  const pending = rig.approvals.list({ status: "PENDING" });
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.toolId, "demo.write");
  assert.ok(pending[0]!.reason.length > 0, "the approval carries the policy reason");
  assert.equal(rig.rec.events[0]!.type, "approval.requested");

  const decided = rig.approvals.decide(pending[0]!.id, true);
  assert.equal(decided.ok, true);

  const granted = await rig.registry.invoke("demo.write", { value: 1 }, { approvalId: pending[0]!.id });
  assert.equal(granted.ok, true);
  assert.deepEqual(rig.calls, ["validate", "validate", "execute"]);
  assert.equal(rig.rec.events.at(-1)!.type, "approval.approved");
});

test("a missing approvalId fails and requests one; the request is only made once per invoke", async () => {
  const rig = makeApprovalRig();
  const result = await rig.registry.invoke("demo.write", {});
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "APPROVAL_REQUIRED");
  assert.equal(rig.store.rows.length, 1, "exactly one approval was requested");
});

test("a stale/unknown approvalId fails without executing", async () => {
  const rig = makeApprovalRig();
  const result = await rig.registry.invoke("demo.write", {}, { approvalId: "does-not-exist" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "APPROVAL_REQUIRED");
  assert.deepEqual(rig.calls, ["validate"]);
});

test("a PENDING approvalId is not enough, and a rejected one is denied", async () => {
  const rig = makeApprovalRig();

  await rig.registry.invoke("demo.write", {}); // creates ap1 (PENDING)
  const pendingResult = await rig.registry.invoke("demo.write", {}, { approvalId: "ap1" });
  assert.equal(pendingResult.ok, false);
  if (!pendingResult.ok) assert.equal(pendingResult.error.code, "APPROVAL_REQUIRED");

  rig.approvals.decide("ap1", false);
  const rejected = await rig.registry.invoke("demo.write", {}, { approvalId: "ap1" });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.error.code, "POLICY_DENIED");
  assert.deepEqual(rig.calls, ["validate", "validate", "validate"], "execute never ran");
});

test("an expired approval cannot be spent", async () => {
  const rig = makeApprovalRig();
  await rig.registry.invoke("demo.write", {});

  rig.c.advance(20 * 60_000); // past the 10-minute default TTL
  assert.deepEqual(rig.approvals.expireStale(), ["ap1"]);

  const result = await rig.registry.invoke("demo.write", {}, { approvalId: "ap1" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "POLICY_DENIED");
  assert.deepEqual(rig.calls, ["validate", "validate"], "execute never ran");
});

test("an approval granted for one tool cannot authorise another", async () => {
  const rig = makeApprovalRig();
  rig.registry.register(spyTool({ id: "demo.other", risk: "WRITE", calls: [] }));

  // A real, approved approval — but for a different tool.
  const forOther = rig.approvals.request({ toolId: "demo.other", action: "write", reason: "r", risk: "WRITE" });
  rig.approvals.decide(forOther.id, true);

  const result = await rig.registry.invoke("demo.write", {}, { approvalId: forOther.id });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "POLICY_DENIED");
    assert.match(result.error.message, /does not authorise/);
  }
  assert.deepEqual(rig.calls, ["validate"]);
});

test("missionId and stepId reach both the approval and the tool context", async () => {
  const rig = makeApprovalRig();
  let seen: { missionId?: string; stepId?: string } | undefined;
  rig.registry.register(
    spyTool({
      id: "demo.ctx",
      risk: "WRITE",
      calls: [],
      execute: async (_input, ctx) => {
        seen = ctx;
        return null;
      },
    }),
  );

  await rig.registry.invoke("demo.ctx", {}, { missionId: "m-1", stepId: "s-1" });
  const pending = rig.approvals.list({ status: "PENDING" }).find((a) => a.toolId === "demo.ctx")!;
  assert.equal(pending.missionId, "m-1");
  assert.equal(pending.stepId, "s-1");

  rig.approvals.decide(pending.id, true);
  const granted = await rig.registry.invoke("demo.ctx", {}, { missionId: "m-1", stepId: "s-1", approvalId: pending.id });
  assert.equal(granted.ok, true);
  assert.deepEqual(seen, { missionId: "m-1", stepId: "s-1" });
});

test("a READ tool runs without approval but validates first", async () => {
  const rig = makeApprovalRig();
  rig.registry.register(spyTool({ id: "demo.read", risk: "READ", calls: [] }));
  const result = await rig.registry.invoke("demo.read", undefined);
  assert.equal(result.ok, true);
  assert.equal(rig.store.rows.length, 0, "no approval is requested for a READ");
});

// ── Builtin tools ─────────────────────────────────────────────────────────────

test("the builtin set is the four READ tools plus the one action that is not trusted", () => {
  const tools = createBuiltinTools();
  assert.deepEqual(
    tools.map((tool) => tool.id),
    [...BUILTIN_TOOL_IDS],
  );

  // Every builtin tool that only answers a question about KAI itself is
  // READ-only, and that stays true...
  const readOnly = tools.filter((tool) => tool.id !== "agents.run_task");
  assert.equal(readOnly.length, 4, "the informational tools are still the original four");
  for (const tool of readOnly) {
    assert.equal(tool.risk, "READ", `${tool.id} must be READ-only`);
    assert.ok(tool.description.length > 0);
  }

  // ...and the one that causes another process to act is NOT, deliberately.
  // Phase 1 Part F routes `POST /agents/:id/action` through this registry, and
  // that only makes "every executable action passes the same boundary" true if
  // the tool carries an honest risk instead of being slipped in as READ. This
  // assertion is the guard against someone quietly re-labelling it.
  const runner = tools.find((tool) => tool.id === "agents.run_task");
  assert.ok(runner, "agents.run_task must be registered");
  assert.equal(runner.risk, "EXTERNAL", "handing work to a worker is EXTERNAL, not READ");
  assert.ok(runner.description.length > 0);
});

test("builtin tools invoke through the registry with default policy (READ allows)", async () => {
  const registry = createToolRegistry({ policy: createPolicyEngine() });
  registerBuiltinTools(registry, {
    listAgents: () => [
      { id: "hermes", state: "idle" },
      { id: "opencode", state: "working" },
      { id: "grok", state: "offline" },
    ] as AgentStatus[],
    listMissions: (opts) =>
      ([
        { id: "m1", status: "RUNNING" },
        { id: "m2", status: "COMPLETED" },
      ] as Mission[]).filter((mission) => opts.status === undefined || mission.status === opts.status),
    listMemories: (opts) =>
      ([
        { id: "mem1", type: "note" },
        { id: "mem2", type: "project_fact" },
      ] as Memory[]).filter((memory) => opts.type === undefined || memory.type === opts.type),
  });

  const status = await registry.invoke("system.get_status", undefined);
  assert.equal(status.ok, true);
  if (status.ok) {
    const value = status.result as { status: string; pid: number; memory: { rssBytes: number } };
    assert.equal(value.status, "ok");
    assert.equal(typeof value.pid, "number");
    assert.ok(value.memory.rssBytes > 0, "real process memory, not a stub");
  }

  const agents = await registry.invoke("agents.list", {});
  assert.equal(agents.ok, true);
  if (agents.ok) assert.deepEqual((agents.result as { count: number }).count, 3);

  const limited = await registry.invoke("agents.list", { limit: 2 });
  assert.equal(limited.ok, true);
  if (limited.ok) assert.equal((limited.result as { count: number }).count, 2);

  const missions = await registry.invoke("missions.list", { status: "RUNNING" });
  assert.equal(missions.ok, true);
  if (missions.ok) {
    const result = missions.result as { items: Mission[]; count: number };
    assert.equal(result.count, 1);
    assert.equal(result.items[0]!.id, "m1");
  }

  const memories = await registry.invoke("memory.list", { type: "note" });
  assert.equal(memories.ok, true);
  if (memories.ok) assert.equal((memories.result as { count: number }).count, 1);
});

test("builtin validators reject malformed input and accept good input", async () => {
  const registry = createToolRegistry({ policy: createPolicyEngine() });
  registerBuiltinTools(registry);

  // Wrong input shape for every tool.
  for (const id of BUILTIN_TOOL_IDS) {
    const bad = await registry.invoke(id, "a string, not an object");
    assert.equal(bad.ok, false, `${id} must reject a bare string`);
    if (!bad.ok) assert.equal(bad.error.code, "VALIDATION_FAILED");

    const array = await registry.invoke(id, [1, 2, 3]);
    assert.equal(array.ok, false, `${id} must reject an array`);
    if (!array.ok) assert.equal(array.error.code, "VALIDATION_FAILED");
  }

  // system.get_status takes no options at all.
  assert.equal((await registry.invoke("system.get_status", {})).ok, true);
  const unknownOption = await registry.invoke("system.get_status", { verbose: true });
  assert.equal(unknownOption.ok, false);
  if (!unknownOption.ok) assert.match(unknownOption.error.message, /unknown option/);

  // limits are validated, not coerced.
  for (const limit of [0, -1, 1.5, "5", MAX_LIMIT_BAD]) {
    const bad = await registry.invoke("agents.list", { limit });
    assert.equal(bad.ok, false, `agents.list must reject limit=${String(limit)}`);
    if (!bad.ok) assert.match(bad.error.message, /limit/);
  }
  assert.equal((await registry.invoke("agents.list", { limit: 1 })).ok, true);
  assert.equal((await registry.invoke("agents.list", {})).ok, true);
  assert.equal((await registry.invoke("agents.list", undefined)).ok, true);

  // enums are validated.
  const badStatus = await registry.invoke("missions.list", { status: "ALMOST_DONE" });
  assert.equal(badStatus.ok, false);
  if (!badStatus.ok) assert.match(badStatus.error.message, /status must be one of/);

  const badType = await registry.invoke("memory.list", { type: "secret" });
  assert.equal(badType.ok, false);
  if (!badType.ok) assert.match(badType.error.message, /type must be one of/);
});

test("a user-registered tool shadows nothing: builtin ids are stable and get() finds them", () => {
  const registry = createToolRegistry({});
  registerBuiltinTools(registry);
  for (const id of BUILTIN_TOOL_IDS) {
    assert.ok(registry.get(id), `${id} should be registered`);
  }
  assert.equal(registry.list().length, BUILTIN_TOOL_IDS.length);
  assert.throws(() => registerBuiltinTools(registry), /already registered/);
});
