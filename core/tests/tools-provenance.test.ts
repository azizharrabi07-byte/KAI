// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The provenance/dedupe verdict, proved at every level it exists.
 *
 * THE PINNED DEFECT (tests/adversarial-observability.test.ts): a deduped
 * `memory.write` returns the EXISTING entry id, so a second action record named
 * a memory it did not create and a trace resolved to the wrong action. The fix
 * is ONE generic guard in ./src/tools/provenance.ts — a result that reports
 * `deduped: true` (top level, or one level down under `value`) names NO
 * artifact — applied at the ONE place every executed action passes (the
 * registry's `invoke`, via `deriveToolProvenance`). There is no per-tool patch
 * in the registry for it.
 *
 * What this file proves:
 *   1. the three helpers directly: dedupeSignalOf / deriveArtifactIds /
 *      deriveToolProvenance;
 *   2. through the REAL registry: a created artifact is named, a DEDUPED one is
 *      not, a refusal names nothing, and the causal mission wins over the
 *      artifact mission;
 *   3. the KNOWN RESIDUAL is signal-shaped, not plane-shaped: a producer that
 *      drops `deduped` before the tool result exists still gets its entry
 *      named (`learning.propose` is exactly that producer today — the fix
 *      belongs in learning/pipeline.ts, outside this plane; see
 *      docs/evidence/kai-tools-final.json).
 *
 * Run from `core/`:  node --test tests/tools-provenance.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createToolRegistry } from "../src/tools/registry.ts";
import type { ToolDefinition, ToolInvokeOptions } from "../src/tools/registry.ts";
import { createPolicyEngine } from "../src/policies/gate.ts";
import type { PolicyGate } from "../src/policies/gate.ts";
import { executionIdFor } from "../src/recovery/ledger.ts";
import {
  dedupeSignalOf,
  deriveArtifactIds,
  deriveToolProvenance,
} from "../src/tools/provenance.ts";
import type { KaiEventType } from "../src/shared/contracts.ts";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function toolReturning(id: string, result: unknown): ToolDefinition {
  return {
    id,
    name: `Test ${id}`,
    description: `Test double for ${id}.`,
    risk: "READ",
    validate: (input) => ({ ok: true, value: input }),
    execute: async () => result,
  };
}

/** Run one tool through a REAL registry and read back the bus record + provenance. */
async function invokeWithResult(
  tool: ToolDefinition,
  input: unknown,
  options: { policy?: PolicyGate; invokeOpts?: ToolInvokeOptions } = {},
): Promise<{
  invoked: Awaited<ReturnType<ReturnType<typeof createToolRegistry>["invoke"]>>;
  record: Record<string, unknown> | undefined;
  provenance: ReturnType<typeof deriveToolProvenance>;
}> {
  const events: { type: KaiEventType; payload: unknown }[] = [];
  const registry = createToolRegistry({
    policy: options.policy ?? createPolicyEngine(),
    publish: (type, payload) => {
      events.push({ type, payload });
    },
    coreBuildId: "test-build",
  });
  registry.register(tool);
  const invoked = await registry.invoke(tool.id, input, options.invokeOpts);
  const hit = events.find((event) => event.type === "action.executed");
  return {
    invoked,
    record: hit === undefined ? undefined : (hit.payload as Record<string, unknown>),
    provenance: invoked.invocation.provenance,
  };
}

// ── 1. The helpers ────────────────────────────────────────────────────────────

test("dedupeSignalOf reads the top level AND the SkillResult envelope — and only `true`", () => {
  assert.equal(dedupeSignalOf({ deduped: true }), true);
  assert.equal(dedupeSignalOf({ ok: true, value: { deduped: true, id: "x" } }), true);
  assert.equal(dedupeSignalOf({ deduped: false }), false);
  assert.equal(dedupeSignalOf({ value: { deduped: "yes" } }), false);
  assert.equal(dedupeSignalOf("deduped"), false);
  assert.equal(dedupeSignalOf(null), false);
});

test("deriveArtifactIds reads each tool's own result shape — ids only when really present", () => {
  assert.deepEqual(deriveArtifactIds("memory.write", {}, { ok: true, entry: { id: "m1" } }), { memoryId: "m1" });
  assert.deepEqual(deriveArtifactIds("memory.create", { id: "m2" }, { ok: true }), { memoryId: "m2" });
  assert.deepEqual(deriveArtifactIds("skill.toggle", {}, { ok: true, value: { id: "sk1" } }), { skillId: "sk1" });
  assert.deepEqual(deriveArtifactIds("skill.delete", { id: "sk2" }, true), { skillId: "sk2" });
  assert.deepEqual(deriveArtifactIds("checkpoint.create", {}, { checkpoint: { id: "c1" } }), { checkpointId: "c1" });
  assert.deepEqual(deriveArtifactIds("schedule.manage", {}, { schedule: { id: "s1" } }), { scheduleId: "s1" });
  assert.deepEqual(deriveArtifactIds("missions.create", {}, { id: "mi1" }), { missionId: "mi1" });
  assert.deepEqual(deriveArtifactIds("mission.cancel", { id: "mi2" }, { ok: true }), { missionId: "mi2" });
  assert.deepEqual(deriveArtifactIds("approval.decide", { id: "a1" }, { missionId: "mi3" }), {
    approvalId: "a1",
    missionId: "mi3",
  });
  // A tool whose result names no artifact yields none — nothing is guessed.
  assert.deepEqual(deriveArtifactIds("some.other.tool", { id: "x" }, { id: "y" }), {});
});

test("deriveToolProvenance: a refusal yields the honest empty set; a dedupe suppresses naming", () => {
  const refused = deriveToolProvenance({
    toolId: "memory.write",
    input: {},
    result: { ok: true, entry: { id: "m1" } },
    source: "core",
    executed: false,
  });
  assert.deepEqual(refused.artifacts, {}, "a refusal did not produce anything");
  assert.equal(refused.deduped, false);

  const deduped = deriveToolProvenance({
    toolId: "memory.write",
    input: {},
    result: { ok: true, entry: { id: "m1" }, deduped: true },
    source: "route",
    executed: true,
  });
  assert.deepEqual(deduped.artifacts, {});
  assert.equal(deduped.deduped, true);
  assert.equal(deduped.source, "route");
});

test("deriveToolProvenance derives the executor from the tool input — an employee action names its employee", () => {
  const employee = deriveToolProvenance({
    toolId: "agents.run_task",
    input: { agentId: "hermes" },
    result: {},
    source: "core",
    executed: true,
  });
  assert.equal(employee.executorType, "employee");
  assert.equal(employee.employeeId, "hermes");

  const capability = deriveToolProvenance({
    toolId: "capability.shell",
    input: {},
    result: {},
    source: "core",
    executed: true,
  });
  assert.equal(capability.executorType, "kai");
  assert.equal(capability.capabilityId, "shell");
});

// ── 2. Through the REAL registry ──────────────────────────────────────────────

test("a created artifact is named: memory.write's new entry lands on the record AND the provenance", async () => {
  const { record, provenance } = await invokeWithResult(
    toolReturning("memory.write", { ok: true, entry: { id: "mem_new" }, deduped: false }),
    { type: "note", content: "x" },
  );
  assert.equal(record?.memoryId, "mem_new");
  assert.equal(provenance.artifacts.memoryId, "mem_new");
  assert.equal(provenance.deduped, false);
});

test("THE dedupe guard: a deduped write names NOTHING — even though its result carries the existing id", async () => {
  const { record, provenance } = await invokeWithResult(
    toolReturning("memory.write", { ok: true, entry: { id: "mem_existing" }, deduped: true }),
    { type: "note", content: "x" },
  );
  assert.equal("memoryId" in (record ?? {}), false, "a deduped write did not create the memory, so it must not name it");
  assert.deepEqual(provenance.artifacts, {});
  assert.equal(provenance.deduped, true);
});

test("the guard reads a SkillResult envelope one level down too", async () => {
  const created = await invokeWithResult(
    toolReturning("skill.toggle", { ok: true, value: { id: "skl_1" } }),
    { id: "skl_1" },
  );
  assert.equal(created.record?.skillId, "skl_1");
  assert.equal(created.provenance.deduped, false);

  const deduped = await invokeWithResult(
    toolReturning("skill.toggle", { ok: true, value: { id: "skl_1", deduped: true } }),
    { id: "skl_1" },
  );
  assert.equal("skillId" in (deduped.record ?? {}), false);
  assert.equal(deduped.provenance.deduped, true);
});

test("a refusal names nothing — even when its INPUT carries id-shaped fields", async () => {
  const policy = createPolicyEngine({
    rules: [{ id: "deny-cancel", risk: "READ", outcome: "deny", tools: ["mission.cancel"] }],
  });
  const { invoked, record, provenance } = await invokeWithResult(
    toolReturning("mission.cancel", { ok: true }),
    { id: "mis_x" },
    { policy },
  );
  assert.equal(invoked.ok, false);
  assert.equal(invoked.invocation.status, "DENIED");
  assert.equal("missionId" in (record ?? {}), false, "a refused cancel did not cancel the mission");
  assert.deepEqual(provenance.artifacts, {});
  assert.equal(provenance.deduped, false);
});

test("the CAUSAL mission wins over the artifact mission — a record names its execution, not its product", async () => {
  // mission.cancel ACTED ON "mis_target" but runs INSIDE "mis_causal".
  const { record } = await invokeWithResult(
    toolReturning("mission.cancel", { ok: true }),
    { id: "mis_target" },
    { invokeOpts: { missionId: "mis_causal", stepId: "stp_1" } },
  );
  assert.equal(record?.missionId, "mis_causal");
  assert.equal(record?.executionId, executionIdFor("mis_causal", "stp_1"));
});

test("learning.propose's result shapes are read without guessing (the L2 behaviour-change link)", async () => {
  const { record } = await invokeWithResult(
    toolReturning("learning.propose", {
      decision: "memory",
      proposal: { id: "les_1" },
      skill: { skillId: "skl_2" },
      memory: { entryId: "mem_2" },
    }),
    {},
  );
  assert.equal(record?.learningEventId, "les_1");
  assert.equal(record?.skillId, "skl_2");
  assert.equal(record?.memoryId, "mem_2");
});

// ── 3. The known residual, stated as a mechanism ──────────────────────────────

test("the guard is SIGNAL-driven: a producer that drops `deduped` still gets its entry named — the residual shape", async () => {
  // learning/pipeline.ts (outside this plane) reads the memory engine's write
  // result but drops its `deduped` flag before the tool result exists, so the
  // plane cannot see the signal and names a memory the write may not have
  // created. This pins the MECHANISM (no signal -> naming proceeds); the fix
  // belongs in the producer, not here. Reported in docs/evidence/kai-tools-final.json.
  const { record, provenance } = await invokeWithResult(
    toolReturning("memory.write", { ok: true, entry: { id: "mem_existing" } }), // no `deduped` field
    { type: "note", content: "x" },
  );
  assert.equal(record?.memoryId, "mem_existing");
  assert.equal(provenance.deduped, false);
});
