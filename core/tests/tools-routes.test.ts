// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The tool route surface — `createToolApi` (pure) and `registerToolRoutes`
 * (host adapter), driven through the REAL tool registry, policy engine and
 * approval service.
 *
 * These are the assertions that make `GET /tools` returning 200 (instead of
 * 404) a proven property of THIS module, mountable by the integration stream
 * with the one-line call in the file header. Note: until the integrator mounts
 * `registerToolRoutes` in `core/src/api/routes.ts`, the LIVE `/tools` endpoint
 * of a running Core still 404s — that is a wiring fact, not a route fact, and
 * the evidence file says so.
 *
 * Run from `core/`:  node --test tests/tools-routes.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createToolRegistry } from "../src/tools/registry.ts";
import type { ToolDefinition } from "../src/tools/registry.ts";
import { createPolicyEngine } from "../src/policies/gate.ts";
import { createApprovalService } from "../src/approvals/service.ts";
import { createBuiltinTools } from "../src/tools/builtin.ts";
import { createToolApi, registerToolRoutes } from "../src/tools/routes.ts";
import type { ToolApiRequest, ToolApiResponse, ToolRouteHost } from "../src/tools/routes.ts";
import { executionIdFor } from "../src/recovery/ledger.ts";
import type { Approval, ApprovalStatus, ApprovalStore } from "../src/shared/contracts.ts";

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

/** The REAL policy engine + approval service + tool registry. */
function policyRegistry() {
  const store = fakeApprovalStore();
  let seq = 0;
  const approvals = createApprovalService({
    store,
    idFactory: () => `apr-${++seq}`,
    defaultTtlMs: 60_000,
  });
  const policy = createPolicyEngine();
  const registry = createToolRegistry({ policy, approvals });
  return { registry, approvals, store };
}

const EXTERNAL_TOOL: ToolDefinition = {
  id: "demo.external",
  name: "External demo",
  description: "An external demo tool (the default policy parks it).",
  risk: "EXTERNAL",
  validate: (input) => ({ ok: true, value: input }),
  execute: async () => ({ done: true }),
};

function bodyOf(response: ToolApiResponse): Record<string, unknown> {
  return response.body as Record<string, unknown>;
}

// ── The table and the fall-through ────────────────────────────────────────────

test("routes: the table serves the three tool paths and falls through for paths it does not own", async () => {
  const { registry } = policyRegistry();
  const api = createToolApi({ tools: registry });

  assert.deepEqual(api.routes(), ["GET /tools", "GET /tools/:id", "POST /tools/:id/invoke"]);

  // "not one of mine": the integrator mounts this BEHIND the existing API, so a
  // 404 must fall through to the routes that already existed.
  const missed = await api.handle({ method: "GET", path: "/not-mine" });
  assert.equal(missed.status, 404);

  // A query string never changes which route matches.
  const stripped = await api.handle({ method: "GET", path: "/tools?limit=5" });
  assert.equal(stripped.status, 200);
});

// ── GET /tools ────────────────────────────────────────────────────────────────

test("GET /tools lists every registered tool with declared facts only", async () => {
  const { registry } = policyRegistry();
  for (const tool of createBuiltinTools()) registry.register(tool);
  registry.register({
    id: "demo.bare",
    name: "Bare",
    description: "procedural validator only",
    risk: "READ",
    validate: (input) => ({ ok: true, value: input }),
    execute: async () => null,
  });
  const api = createToolApi({ tools: registry });

  const response = await api.handle({ method: "GET", path: "/tools" });
  assert.equal(response.status, 200);
  const body = bodyOf(response);
  assert.equal(body.service, "tools");
  assert.equal(body.count, registry.list().length);

  const tools = body.tools as {
    id: string;
    permission: { risk: string; effectful: boolean; sideEffecting: boolean };
    schema: { declared: boolean; reason?: string };
  }[];
  const worker = tools.find((tool) => tool.id === "agents.run_task");
  assert.ok(worker !== undefined);
  assert.deepEqual(worker.permission, { risk: "EXTERNAL", effectful: false, sideEffecting: true });
  assert.equal(worker.schema.declared, true, "the builtin worker tool declares its input contract");

  const bare = tools.find((tool) => tool.id === "demo.bare");
  assert.ok(bare !== undefined);
  assert.equal(bare.schema.declared, false, "an undeclared schema is reported honestly, never invented");
  assert.ok((bare.schema.reason ?? "").includes("validate()"));
});

test("GET /tools/:id describes one tool; an unknown id is a 404", async () => {
  const { registry } = policyRegistry();
  for (const tool of createBuiltinTools()) registry.register(tool);
  const api = createToolApi({ tools: registry });

  const response = await api.handle({ method: "GET", path: "/tools/system.get_status" });
  assert.equal(response.status, 200);
  const tool = bodyOf(response).tool as { id: string; permission: { sideEffecting: boolean } };
  assert.equal(tool.id, "system.get_status");
  assert.equal(tool.permission.sideEffecting, false);

  const missing = await api.handle({ method: "GET", path: "/tools/nope.missing" });
  assert.equal(missing.status, 404);
  assert.equal(bodyOf(missing).error, true);
});

// ── POST /tools/:id/invoke ────────────────────────────────────────────────────

test("POST invoke runs a READ tool through the ONE boundary and returns the full invocation", async () => {
  const { registry } = policyRegistry();
  for (const tool of createBuiltinTools()) registry.register(tool);
  const api = createToolApi({ tools: registry });

  const response = await api.handle({
    method: "POST",
    path: "/tools/system.get_status/invoke",
    body: { input: {}, sessionId: "ses_r1" },
  });
  assert.equal(response.status, 200);
  const body = bodyOf(response);
  assert.equal(body.toolId, "system.get_status");
  assert.equal(body.status, "EXECUTED");
  assert.equal(typeof body.invocationId, "string");
  const invocation = body.invocation as { sessionId?: string; status: string };
  assert.equal(invocation.status, "EXECUTED");
  assert.equal(invocation.sessionId, "ses_r1");
  assert.equal(typeof (body.result as { status?: string }).status, "string");

  // A bad input is a 400 VALIDATION_FAILED, not a 500.
  const invalid = await api.handle({
    method: "POST",
    path: "/tools/system.get_status/invoke",
    body: { input: "not-an-object" },
  });
  assert.equal(invalid.status, 400);
  assert.equal((bodyOf(invalid).invocation as { status: string }).status, "INVALID");

  // An unknown tool id is a 404 — and still carries the (NOT_FOUND) invocation.
  const missing = await api.handle({ method: "POST", path: "/tools/nope.missing/invoke", body: { input: {} } });
  assert.equal(missing.status, 404);
  assert.equal((bodyOf(missing).invocation as { status: string }).status, "NOT_FOUND");

  // Malformed request shapes are refused before anything runs.
  const badBody = await api.handle({ method: "POST", path: "/tools/system.get_status/invoke", body: "nope" });
  assert.equal(badBody.status, 400);
  const badApproval = await api.handle({
    method: "POST",
    path: "/tools/system.get_status/invoke",
    body: { input: {}, approvalId: 42 },
  });
  assert.equal(badApproval.status, 400);
});

test("POST invoke on an EXTERNAL tool parks (409), then the approvalId retry runs it exactly once", async () => {
  const { registry, approvals } = policyRegistry();
  registry.register(EXTERNAL_TOOL);
  let executed = 0;
  registry.register({
    ...EXTERNAL_TOOL,
    id: "demo.counted",
    name: "Counted external demo",
    execute: async () => {
      executed += 1;
      return { counted: executed };
    },
  });
  const api = createToolApi({ tools: registry });

  const parked = await api.handle({ method: "POST", path: "/tools/demo.counted/invoke", body: { input: { x: 1 } } });
  assert.equal(parked.status, 409, `expected a park: ${JSON.stringify(parked.body)}`);
  const parkedBody = bodyOf(parked);
  assert.equal(parkedBody.approvalRequired, true);
  assert.equal(typeof parkedBody.approvalId, "string");
  assert.equal((parkedBody.invocation as { status: string }).status, "APPROVAL_REQUIRED");
  assert.equal(executed, 0, "a parked call executes nothing");

  const approvalId = parkedBody.approvalId as string;
  assert.equal(approvals.decide(approvalId, true).ok, true);

  const ran = await api.handle({
    method: "POST",
    path: "/tools/demo.counted/invoke",
    body: { input: { x: 1 }, approvalId },
  });
  assert.equal(ran.status, 200, `expected a run: ${JSON.stringify(ran.body)}`);
  assert.equal(executed, 1);
  const ranInvocation = bodyOf(ran).invocation as { approval?: { status?: string }; approvalId?: string };
  assert.equal(ranInvocation.approvalId, approvalId);
  assert.equal(ranInvocation.approval?.status, "APPROVED");
});

test("POST invoke maps POLICY_DENIED to 403", async () => {
  const store = fakeApprovalStore();
  let seq = 0;
  const approvals = createApprovalService({ store, idFactory: () => `apr-${++seq}` });
  const policy = createPolicyEngine({
    rules: [{ id: "deny-demo", risk: "READ", outcome: "deny", tools: ["demo.denied"] }],
  });
  const registry = createToolRegistry({ policy, approvals });
  registry.register({
    id: "demo.denied",
    name: "Denied demo",
    description: "A tool the policy denies.",
    risk: "READ",
    validate: (input) => ({ ok: true, value: input }),
    execute: async () => null,
  });
  const api = createToolApi({ tools: registry });

  const denied = await api.handle({ method: "POST", path: "/tools/demo.denied/invoke", body: { input: {} } });
  assert.equal(denied.status, 403);
  assert.equal((bodyOf(denied).invocation as { status: string }).status, "DENIED");
});

test("POST invoke passes the correlation set through — the executionId joins the ledger formula", async () => {
  const { registry } = policyRegistry();
  for (const tool of createBuiltinTools()) registry.register(tool);
  const api = createToolApi({ tools: registry });

  const joined = await api.handle({
    method: "POST",
    path: "/tools/system.get_status/invoke",
    body: { input: {}, missionId: "mis_r1", stepId: "stp_r1", sessionId: "ses_r1", agentId: "agt_r1", source: "route" },
  });
  assert.equal(joined.status, 200);
  const body = bodyOf(joined);
  assert.equal(body.executionId, executionIdFor("mis_r1", "stp_r1"));
  const invocation = body.invocation as { executionId?: string; sessionId?: string; agentId?: string; source: string };
  assert.equal(invocation.executionId, executionIdFor("mis_r1", "stp_r1"));
  assert.equal(invocation.sessionId, "ses_r1");
  assert.equal(invocation.agentId, "agt_r1");
  assert.equal(invocation.source, "route");

  const pinned = await api.handle({
    method: "POST",
    path: "/tools/system.get_status/invoke",
    body: { input: {}, executionId: "exec_pinned" },
  });
  assert.equal(bodyOf(pinned).executionId, "exec_pinned");
});

// ── registerToolRoutes: the integrator's seam ─────────────────────────────────

test("registerToolRoutes pushes the table into a host and the invoke route is classified EXTERNAL", async () => {
  const { registry } = policyRegistry();
  for (const tool of createBuiltinTools()) registry.register(tool);

  interface CapturedDef {
    method: string;
    pattern: string;
    classification: string;
    handler: (request: ToolApiRequest, params: Record<string, string>) => Promise<ToolApiResponse>;
  }
  const defs: CapturedDef[] = [];
  const registered = registerToolRoutes(
    {
      route: (method, pattern, classification, handler) => {
        defs.push({ method, pattern, classification, handler });
      },
    },
    { tools: registry },
  );

  assert.deepEqual(registered.patterns, ["GET /tools", "GET /tools/:id", "POST /tools/:id/invoke"]);
  assert.equal(defs.length, 3);
  const invokeDef = defs.find((def) => def.method === "POST");
  assert.ok(invokeDef !== undefined);
  assert.equal(invokeDef.pattern, "/tools/:id/invoke");
  // EXTERNAL, per the /capabilities/:id/test convention: invoking a tool can
  // cause another process to act; the tool's own risk gates the run inside.
  assert.equal(invokeDef.classification, "EXTERNAL");

  // The pushed handler IS the live one: dispatch it directly, exactly as the
  // host's own dispatcher would.
  const response = await invokeDef.handler(
    { method: "POST", path: "/tools/system.get_status/invoke", body: { input: {} } },
    { id: "system.get_status" },
  );
  assert.equal(response.status, 200);
  assert.equal(bodyOf(response).status, "EXECUTED");

  // The bare-function host is accepted too.
  const captured: string[] = [];
  registerToolRoutes(
    (method, pattern, classification) => {
      captured.push(`${method} ${pattern} ${classification}`);
    },
    { tools: registry },
  );
  assert.deepEqual(captured, ["GET /tools READ", "GET /tools/:id READ", "POST /tools/:id/invoke EXTERNAL"]);

  // A host that cannot register anything is a wiring error, not a silent 404.
  assert.throws(() => registerToolRoutes({} as unknown as ToolRouteHost, { tools: registry }), /route/);
});
