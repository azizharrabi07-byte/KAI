// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The tool plane's eight nouns, proved at the registry boundary — and the
 * declared schemas cross-checked against the real validators.
 *
 * The eight nouns (./src/tools/types.ts) each answer exactly one question, and
 * this file makes each answer observable:
 *
 *   ToolRegistry    invoke() is the one way to run; register/get/list hold
 *   ToolSchema      a declared schema AGREES with the tool's real validator
 *   ToolInvocation  every attempt — executed or refused — carries the full set
 *   ToolResult      ok/error is a VALUE; both branches carry the invocation
 *   ToolError       code/message/retryable/at, never a throw
 *   ToolProvenance  source + executorType + deduped + artifacts, on every call
 *   ToolPermission  risk + effectful + the ONE derived side-effect answer
 *   ToolApproval    a park carries {required, approvalId, PENDING}; a re-issue
 *                   carries the granted state
 *
 * Run from `core/`:  node --test tests/tools-plane.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createToolRegistry } from "../src/tools/registry.ts";
import type { ToolDefinition } from "../src/tools/registry.ts";
import { createPolicyEngine } from "../src/policies/gate.ts";
import { createApprovalService } from "../src/approvals/service.ts";
import { BUILTIN_TOOL_IDS, createBuiltinTools } from "../src/tools/builtin.ts";
import { createWorkspaceTools, WORKSPACE_TOOL_IDS } from "../src/tools/workspace.ts";
import {
  describeTool,
  permissionOf,
  sideEffectingOf,
  type ToolFieldSchema,
  type ToolSchema,
} from "../src/tools/types.ts";
import type {
  Approval,
  ApprovalStatus,
  ApprovalStore,
  KaiEventType,
} from "../src/shared/contracts.ts";

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** Hand-written fake — deliberately does NOT import core/src/storage. */
function fakeApprovalStore(): ApprovalStore {
  const rows: Approval[] = [];
  return {
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

/** The REAL policy engine + approval service + registry, with a bus recorder. */
function policyRegistry() {
  const store = fakeApprovalStore();
  let seq = 0;
  const approvals = createApprovalService({
    store,
    idFactory: () => `apr-${++seq}`,
    defaultTtlMs: 60_000,
  });
  const policy = createPolicyEngine();
  const events: { type: KaiEventType; payload: unknown }[] = [];
  const registry = createToolRegistry({
    policy,
    approvals,
    publish: (type, payload) => {
      events.push({ type, payload });
    },
    coreBuildId: "test-build",
  });
  return { registry, approvals, store, events };
}

const READ_TOOL: ToolDefinition = {
  id: "demo.read",
  name: "Read demo",
  description: "A read-only demo tool.",
  risk: "READ",
  validate: (input) => ({ ok: true, value: input }),
  execute: async () => ({ value: 42 }),
};

const EXTERNAL_TOOL: ToolDefinition = {
  id: "demo.external",
  name: "External demo",
  description: "An external demo tool (the default policy parks it).",
  risk: "EXTERNAL",
  validate: (input) => ({ ok: true, value: input }),
  execute: async () => ({ done: true }),
};

// ── ToolRegistry · ToolInvocation · ToolResult · ToolError · ToolProvenance ───

test("one call, one ToolInvocation: the full set on success AND on refusal", async () => {
  const { registry } = policyRegistry();
  registry.register(READ_TOOL);

  const invoked = await registry.invoke("demo.read", { q: "hi" }, { sessionId: "ses_1", agentId: "agt_1" });
  assert.equal(invoked.ok, true);
  const inv = invoked.invocation;
  assert.equal(typeof inv.invocationId, "string");
  assert.ok(inv.invocationId.length > 0);
  assert.equal(inv.toolId, "demo.read");
  assert.equal(inv.source, "core");
  assert.equal(inv.sessionId, "ses_1");
  assert.equal(inv.agentId, "agt_1");
  assert.deepEqual(inv.arguments, { q: "hi" }, "the validated value is what was acted on");
  assert.equal(inv.status, "EXECUTED");
  assert.ok(!Number.isNaN(Date.parse(inv.startedAt)));
  assert.ok(!Number.isNaN(Date.parse(inv.completedAt)));
  assert.ok(inv.durationMs >= 0);
  assert.equal(inv.policyDecision, "allow");
  assert.equal(inv.decisionSource, "default");
  assert.deepEqual(inv.permission, { risk: "READ", effectful: false, sideEffecting: false });
  assert.deepEqual(inv.provenance, { source: "core", executorType: "kai", deduped: false, artifacts: {} });
  assert.deepEqual(inv.result, { value: 42 });
  assert.equal(inv.error, undefined);

  // The refusal: same shape, an error VALUE instead of a throw.
  const missing = await registry.invoke("nope.missing", {});
  assert.equal(missing.ok, false);
  const refusal = missing.invocation;
  assert.equal(refusal.status, "NOT_FOUND");
  assert.equal(refusal.toolId, "nope.missing");
  assert.equal(refusal.error?.code, "NOT_FOUND");
  assert.equal(refusal.error?.retryable, false);
  assert.ok(!Number.isNaN(Date.parse(refusal.error?.at ?? "")));
  assert.equal(refusal.result, undefined);
  assert.equal(refusal.permission, undefined, "no tool, nothing to describe");
  assert.equal(refusal.decisionSource, "not-reached");
  assert.equal(refusal.policyDecision, "none");
});

test("a refusal of a KNOWN tool still carries the ToolPermission — absence only when there is no such tool", async () => {
  const policy = createPolicyEngine({ rules: [{ id: "deny-writes", risk: "WRITE", outcome: "deny" }] });
  const registry = createToolRegistry({ policy });
  registry.register({
    id: "demo.write",
    name: "Write demo",
    description: "A writing demo tool.",
    risk: "WRITE",
    validate: (input) => ({ ok: true, value: input }),
    execute: async () => null,
  });

  const denied = await registry.invoke("demo.write", {});
  assert.equal(denied.ok, false);
  assert.equal(denied.invocation.status, "DENIED");
  assert.equal(denied.invocation.error?.code, "POLICY_DENIED");
  assert.deepEqual(denied.invocation.permission, { risk: "WRITE", effectful: false, sideEffecting: true });
  assert.equal(denied.invocation.decisionSource, "rule:deny-writes");
});

// ── ToolApproval ──────────────────────────────────────────────────────────────

test("a park carries ToolApproval {required, approvalId, PENDING}; a granted re-issue carries the granted state", async () => {
  const { registry, approvals } = policyRegistry();
  registry.register(EXTERNAL_TOOL);

  const parked = await registry.invoke("demo.external", { x: 1 });
  assert.equal(parked.ok, false);
  const parkedInv = parked.invocation;
  assert.equal(parkedInv.status, "APPROVAL_REQUIRED");
  assert.equal(parkedInv.approval?.required, true);
  assert.equal(typeof parkedInv.approvalId, "string");
  assert.equal(parkedInv.approval?.approvalId, parkedInv.approvalId);
  assert.equal(parkedInv.approval?.status, "PENDING");
  assert.equal(parkedInv.error?.code, "APPROVAL_REQUIRED");
  assert.equal(parkedInv.error?.detail, parkedInv.approvalId, "the approvalId is on the error detail, so a route can answer 409");

  const approvalId = parkedInv.approvalId;
  assert.ok(approvalId !== undefined);
  assert.equal(approvals.decide(approvalId, true).ok, true);

  const granted = await registry.invoke("demo.external", { x: 1 }, { approvalId });
  assert.equal(granted.ok, true);
  assert.equal(granted.invocation.status, "EXECUTED");
  assert.equal(granted.invocation.approvalId, approvalId);
  assert.equal(granted.invocation.approval?.required, true);
  assert.equal(granted.invocation.approval?.status, "APPROVED");
});

// ── ToolPermission · the ONE rule ─────────────────────────────────────────────

test("the ONE side-effect rule — risk !== READ || effectful — is stated once and never re-derived", () => {
  assert.equal(sideEffectingOf({ risk: "READ" }), false);
  assert.equal(sideEffectingOf({ risk: "READ", effectful: false }), false);
  // The falsified-2 case: `missions.create` is READ by risk yet creates real
  // work — deriving from risk alone let it run with no recovery record.
  assert.equal(sideEffectingOf({ risk: "READ", effectful: true }), true);
  assert.equal(sideEffectingOf({ risk: "WRITE" }), true);
  assert.equal(sideEffectingOf({ risk: "EXTERNAL" }), true);
  assert.equal(sideEffectingOf({ risk: "DESTRUCTIVE" }), true);

  assert.deepEqual(permissionOf({ risk: "READ", effectful: true }), {
    risk: "READ",
    effectful: true,
    sideEffecting: true,
  });
  assert.deepEqual(permissionOf({ risk: "EXTERNAL" }), {
    risk: "EXTERNAL",
    effectful: false,
    sideEffecting: true,
  });
});

// ── ToolSchema · describeTool ─────────────────────────────────────────────────

test("describeTool reports declared facts only: an undeclared schema is declared:false WITH the reason", () => {
  const bare = describeTool({
    id: "demo.bare",
    name: "Bare",
    description: "procedural validator only",
    risk: "READ",
  });
  assert.equal(bare.schema.declared, false);
  if (!bare.schema.declared) {
    assert.ok(bare.schema.reason.includes("validate()"), `the reason names the authority: ${bare.schema.reason}`);
  }
  assert.deepEqual(bare.permission, { risk: "READ", effectful: false, sideEffecting: false });

  const declared = describeTool(createBuiltinTools()[0]!);
  assert.equal(declared.schema.declared, true);
});

/** A minimal input the declared schema says the tool accepts. */
function inputFromSchema(schema: ToolSchema): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(schema.properties)) {
    if (field.required === true) input[key] = sampleFor(field);
  }
  return input;
}

function sampleFor(field: ToolFieldSchema): unknown {
  if (field.enum !== undefined && field.enum.length > 0) return field.enum[0];
  switch (field.type) {
    case "string":
      return "probe";
    case "integer":
    case "number":
      return field.minimum ?? 1;
    case "boolean":
      return false;
    case "array":
      return [];
    default:
      return {};
  }
}

/** A value of the wrong JSON type for the field, for the type-mismatch probe. */
const WRONG_TYPE: Readonly<Record<ToolFieldSchema["type"], unknown>> = {
  string: 42,
  integer: "42",
  number: "42",
  boolean: "yes",
  array: "not-an-array",
  object: "not-an-object",
};

test("every declared schema AGREES with the tool's real validator (no drift possible)", () => {
  const tools = [...createBuiltinTools(), ...createWorkspaceTools()];
  assert.equal(
    tools.length,
    BUILTIN_TOOL_IDS.length + Object.keys(WORKSPACE_TOOL_IDS).length,
    "every builtin and workspace tool is covered by this cross-check",
  );

  for (const tool of tools) {
    const schema = tool.schema;
    assert.ok(schema !== undefined, `${tool.id} declares a schema`);
    assert.equal(schema.kind, "object", `${tool.id}: kind is object`);
    assert.equal(
      schema.additionalProperties,
      false,
      `${tool.id}: additionalProperties must be false — the validators refuse unknown keys`,
    );

    const valid = inputFromSchema(schema);
    assert.equal(
      tool.validate(valid).ok,
      true,
      `${tool.id}: the schema's own sample must validate: ${JSON.stringify(valid)}`,
    );

    // The declaration says unknown options are refused; the validator must agree.
    assert.equal(
      tool.validate({ ...valid, definitely_not_an_option: 1 }).ok,
      false,
      `${tool.id}: an unknown key must be refused`,
    );

    for (const [key, field] of Object.entries(schema.properties)) {
      // Required means required: omitting it must be refused.
      if (field.required === true) {
        const omitted: Record<string, unknown> = { ...valid };
        delete omitted[key];
        assert.equal(tool.validate(omitted).ok, false, `${tool.id}: omitting required "${key}" must be refused`);
      }
      // A wrong JSON type is refused.
      assert.equal(
        tool.validate({ ...valid, [key]: WRONG_TYPE[field.type] }).ok,
        false,
        `${tool.id}: "${key}" with the wrong type must be refused`,
      );
      // The enum is exactly the accepted set.
      if (field.enum !== undefined) {
        assert.equal(
          tool.validate({ ...valid, [key]: "definitely-not-a-member" }).ok,
          false,
          `${tool.id}: "${key}" outside the enum must be refused`,
        );
        for (const member of field.enum) {
          assert.equal(
            tool.validate({ ...valid, [key]: member }).ok,
            true,
            `${tool.id}: "${key}" enum member "${member}" must be accepted`,
          );
        }
      }
      // Bounds are bounds: below/above refused, at the edge accepted.
      if (field.minimum !== undefined) {
        assert.equal(
          tool.validate({ ...valid, [key]: field.minimum - 1 }).ok,
          false,
          `${tool.id}: "${key}" below minimum must be refused`,
        );
        assert.equal(
          tool.validate({ ...valid, [key]: field.minimum }).ok,
          true,
          `${tool.id}: "${key}" at minimum must be accepted`,
        );
      }
      if (field.maximum !== undefined) {
        assert.equal(
          tool.validate({ ...valid, [key]: field.maximum + 1 }).ok,
          false,
          `${tool.id}: "${key}" above maximum must be refused`,
        );
        assert.equal(
          tool.validate({ ...valid, [key]: field.maximum }).ok,
          true,
          `${tool.id}: "${key}" at maximum must be accepted`,
        );
      }
    }

    // And the description surface reports the declaration honestly.
    const described = describeTool(tool);
    assert.equal(described.schema.declared, true, `${tool.id}: the /tools surface sees the declaration`);
  }
});
