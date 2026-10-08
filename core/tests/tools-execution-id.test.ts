// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The `executionId` verdict, proved twice.
 *
 * ONE formula (`executionIdFor`, recovery/ledger.ts) mints the acceptance
 * ledger's execution id. The registry derives the SAME id from (missionId,
 * stepId) — never a lookalike — so the bus record and the ledger row join on
 * ONE id:
 *
 *   UNIT        — invoke with {missionId, stepId}: the invocation AND the
 *                 published action record carry executionIdFor(...); an
 *                 explicit id wins; absent ids stay absent (honest absence);
 *                 the record() escape hatch derives it the same way; every
 *                 refusal branch carries it too.
 *
 *   INTEGRATION — a real Core runs a real mission whose side-effecting step
 *                 passes the real boundary runner, and the action record the
 *                 bus persisted asserts
 *
 *                     record.executionId === rt.recovery.get(executionIdFor(mission.id, step.id)).executionId
 *
 * Run from `core/`:  node --test tests/tools-execution-id.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createToolRegistry } from "../src/tools/registry.ts";
import type { ToolDefinition } from "../src/tools/registry.ts";
import { createPolicyEngine } from "../src/policies/gate.ts";
import { executionIdFor } from "../src/recovery/ledger.ts";
import { createCoreRuntime } from "../src/runtime.ts";
import type { KaiEvent, KaiEventType } from "../src/shared/contracts.ts";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function recorder(): {
  events: { type: KaiEventType; payload: unknown }[];
  publish: (t: KaiEventType, p: unknown) => void;
} {
  const events: { type: KaiEventType; payload: unknown }[] = [];
  return {
    events,
    publish: (type, payload) => {
      events.push({ type, payload });
    },
  };
}

const READ_TOOL: ToolDefinition = {
  id: "demo.read",
  name: "Read demo",
  description: "A read-only demo tool.",
  risk: "READ",
  validate: (input) =>
    typeof input === "object" && input !== null
      ? { ok: true, value: input }
      : { ok: false, reason: "input must be an object" },
  execute: async () => ({ ok: true }),
};

function recordOf(events: { type: KaiEventType; payload: unknown }[]): Record<string, unknown> | undefined {
  const hit = events.find((event) => event.type === "action.executed");
  return hit === undefined ? undefined : (hit.payload as Record<string, unknown>);
}

// ── Unit: the derivation ──────────────────────────────────────────────────────

test("unit: invoke derives executionId with the ledger's ONE formula — on the invocation AND the record", async () => {
  const { events, publish } = recorder();
  const registry = createToolRegistry({ policy: createPolicyEngine(), publish, coreBuildId: "test-build" });
  registry.register(READ_TOOL);

  const invoked = await registry.invoke("demo.read", {}, { missionId: "mis_1", stepId: "stp_1" });
  assert.equal(invoked.ok, true);
  const expected = executionIdFor("mis_1", "stp_1");
  assert.equal(invoked.invocation.executionId, expected);

  const record = recordOf(events);
  assert.ok(record !== undefined);
  assert.equal(record.executionId, expected, "the bus record joins the ledger on ONE id");
  assert.equal(record.actionId, invoked.invocation.invocationId, "one attempt, one identity");
});

test("unit: an explicit executionId wins over the derivation", async () => {
  const { events, publish } = recorder();
  const registry = createToolRegistry({ policy: createPolicyEngine(), publish });
  registry.register(READ_TOOL);

  const invoked = await registry.invoke("demo.read", {}, { missionId: "mis_1", stepId: "stp_1", executionId: "exec_explicit" });
  assert.equal(invoked.invocation.executionId, "exec_explicit");
  assert.equal(recordOf(events)?.executionId, "exec_explicit");
});

test("unit: without a mission step the id is ABSENT — an invented one is the mislink this plane refuses", async () => {
  const { events, publish } = recorder();
  const registry = createToolRegistry({ policy: createPolicyEngine(), publish });
  registry.register(READ_TOOL);

  const invoked = await registry.invoke("demo.read", {}, { sessionId: "ses_1" });
  assert.equal(invoked.invocation.executionId, undefined);
  const record = recordOf(events);
  assert.ok(record !== undefined);
  assert.equal("executionId" in record, false, "absent means absent, not a placeholder");

  // Half a pair is still absent: a mission without its step cannot name an execution.
  const half = await registry.invoke("demo.read", {}, { missionId: "mis_1" });
  assert.equal(half.invocation.executionId, undefined);
});

test("unit: the record() escape hatch derives the same id (and an explicit one still wins)", async () => {
  const { events, publish } = recorder();
  const registry = createToolRegistry({ policy: createPolicyEngine(), publish });

  registry.record({
    toolId: "missions.create",
    input: {},
    resultState: "EXECUTED",
    startedAt: new Date().toISOString(),
    invokeOpts: { missionId: "mis_2", stepId: "stp_2" },
  });
  assert.equal(recordOf(events)?.executionId, executionIdFor("mis_2", "stp_2"));

  registry.record({
    toolId: "missions.create",
    input: {},
    resultState: "EXECUTED",
    startedAt: new Date().toISOString(),
    executionId: "exec_from_caller",
  });
  const records = events.filter((event) => event.type === "action.executed");
  assert.equal((records[1]?.payload as Record<string, unknown>).executionId, "exec_from_caller");
});

test("unit: every refusal branch carries the id too — a refusal is as traceable as a success", async () => {
  const { events, publish } = recorder();
  const policy = createPolicyEngine({
    rules: [{ id: "deny-demo", risk: "READ", outcome: "deny", tools: ["demo.denied"] }],
  });
  const registry = createToolRegistry({ policy, publish });
  registry.register({ ...READ_TOOL, id: "demo.denied", name: "Denied demo" });
  registry.register(READ_TOOL);

  const opts = { missionId: "mis_3", stepId: "stp_3" };
  const expected = executionIdFor("mis_3", "stp_3");

  const denied = await registry.invoke("demo.denied", {}, opts);
  assert.equal(denied.ok, false);
  assert.equal(denied.invocation.executionId, expected);

  const invalid = await registry.invoke("demo.read", "not-an-object", opts);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.invocation.executionId, expected);

  const missing = await registry.invoke("nope.missing", {}, opts);
  assert.equal(missing.ok, false);
  assert.equal(missing.invocation.executionId, expected);

  const records = events.filter((event) => event.type === "action.executed");
  assert.equal(records.length, 3);
  for (const event of records) {
    assert.equal((event.payload as Record<string, unknown>).executionId, expected);
  }
});

// ── INTEGRATION: the real Core, a real mission, a real ledger row ─────────────

test("INTEGRATION: a mission step's action record joins the acceptance ledger on ONE executionId", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kai-tools-execid-"));
  const dbPath = join(dir, "kai-core.db");
  const rt = createCoreRuntime({ dbPath, agents: { mode: "mock" }, startScheduler: false });
  const seen: KaiEvent[] = [];
  try {
    await rt.start();

    let ran = 0;
    rt.tools.register({
      id: "test.effectful_echo",
      name: "Effectful echo",
      description: "Test double: a READ-risk tool that still creates work (the missions.create shape).",
      risk: "READ",
      effectful: true,
      validate: (input) => ({ ok: true, value: input }),
      execute: async () => {
        ran += 1;
        return { echoed: true };
      },
    });

    const unsubscribe = rt.bus.subscribe((event) => seen.push(event));
    try {
      // Mission A — a SIDE-EFFECTING step: the acceptance boundary records it
      // durably, and the action record must join that exact ledger row.
      const mission = await rt.createAndStartMission({
        title: "prove the executionId join",
        steps: [{ title: "effectful echo", kind: "tool", target: "test.effectful_echo" }],
      });
      assert.equal(mission.status, "COMPLETED");
      assert.equal(ran, 1);
      const step = mission.steps[0];
      assert.ok(step !== undefined);

      const expectedId = executionIdFor(mission.id, step.id);
      const ledgerRow = rt.recovery.get(expectedId);
      assert.ok(ledgerRow !== null, "the acceptance boundary recorded the side-effecting step");

      const records = seen.filter(
        (event) =>
          event.type === "action.executed" &&
          (event.payload as { toolId?: string }).toolId === "test.effectful_echo",
      );
      assert.equal(records.length, 1, `one action record for the step (got ${records.length})`);
      const payload = records[0]!.payload as {
        executionId?: string;
        actionId?: string;
        missionId?: string;
        turnId?: string;
        resultState?: string;
      };

      // THE join, asserted exactly as the verdict states it:
      //   record.executionId === rt.recovery.get(executionIdFor(mission.id, step.id)).executionId
      assert.equal(payload.executionId, ledgerRow.executionId);
      assert.equal(payload.executionId, expectedId);
      assert.equal(payload.missionId, mission.id);
      assert.equal(payload.turnId, step.id, "one step execution == one turn of work");
      assert.equal(payload.resultState, "EXECUTED");

      // Mission B — a READ step. The id is still DERIVED (the caller knew the
      // mission step), while the acceptance boundary — which records only
      // side-effecting steps — writes no row. Derivation and the ledger write
      // are independent, and the record stays honest about which is which.
      const readMission = await rt.createAndStartMission({
        title: "read step",
        steps: [{ title: "read status", kind: "tool", target: "system.get_status" }],
      });
      assert.equal(readMission.status, "COMPLETED");
      const readStep = readMission.steps[0];
      assert.ok(readStep !== undefined);
      const readExpected = executionIdFor(readMission.id, readStep.id);
      const readRecords = seen.filter(
        (event) =>
          event.type === "action.executed" &&
          (event.payload as { toolId?: string }).toolId === "system.get_status" &&
          (event.payload as { missionId?: string }).missionId === readMission.id,
      );
      assert.equal(readRecords.length, 1);
      assert.equal((readRecords[0]!.payload as { executionId?: string }).executionId, readExpected);
      assert.equal(
        rt.recovery.get(readExpected),
        null,
        "no acceptance row for a non-side-effecting step (the boundary records what it must recover)",
      );
    } finally {
      unsubscribe();
    }
  } finally {
    await rt.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
