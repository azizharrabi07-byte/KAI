// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * MCP end-to-end, within KAI: the exact wiring the integration stream will
 * apply, exercised as a whole.
 *
 * This test builds the full MCP stack the way runtime.ts + api/routes.ts will
 * hold it, using the two documented one-line handovers VERBATIM:
 *
 *   handover #1 (api/routes.ts):
 *     registerMcpRoutes({ register: (m, p, h, c) => routeDefs.push(...) },
 *                       { manager: runtime.mcp, tools: runtime.tools })
 *   handover #2 (runtime.ts):
 *     const mcp = createMcpManager({ tools, publish })
 *     installMcpCapability(capabilityRegistry, mcp)
 *     return dispatchMcpCapability(mcp, chosen, payload)
 *
 * The components are all REAL: tool registry, policy engine, approval service,
 * capability registry, and KAI's own fixture server spawned for real over
 * stdio. What is simulated is only the two integration edits themselves —
 * because `core/src/api/routes.ts` and `core/src/runtime.ts` belong to the
 * integration stream. Until those land, a LIVE `GET /mcp` on a running Core
 * still returns 404; THIS test proves the mechanism those lines mount.
 *
 * Run from `core/`:  node --test tests/mcp-runtime-e2e.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createCapabilityRegistry } from "../src/capabilities/registry.ts";
import { createApprovalService } from "../src/approvals/service.ts";
import { createPolicyEngine } from "../src/policies/gate.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import { createMcpManager } from "../src/mcp/manager.ts";
import { registerMcpRoutes, type McpApiResponse, type McpRouteHandler } from "../src/mcp/routes.ts";
import { dispatchMcpCapability, installMcpCapability } from "../src/mcp/capability.ts";

/** The fixture server, addressed relative to this test file. */
const SERVER = fileURLToPath(new URL("../src/mcp/servers/echo-mcp-server.mjs", import.meta.url));

// ── Fixtures (same pattern as tests/mcp-manager.test.ts) ──────────────────────

function fakeApprovalStore() {
  const rows: Array<Record<string, unknown>> = [];
  return {
    rows,
    createApproval(approval: Record<string, unknown>) {
      rows.push({ ...approval });
    },
    getApproval(id: string) {
      const row = rows.find((entry) => entry.id === id);
      return row === undefined ? null : { ...row };
    },
    listApprovals(opts?: { status?: string }) {
      let out = rows.map((row) => ({ ...row }));
      if (opts?.status !== undefined) out = out.filter((row) => row.status === opts.status);
      return out;
    },
    decideApproval(id: string, status: string, decidedAt: string) {
      const row = rows.find((entry) => entry.id === id);
      if (row !== undefined) {
        row.status = status;
        row.decidedAt = decidedAt;
      }
    },
  };
}

function toolText(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === "object" && item !== null && typeof (item as { text?: unknown }).text === "string") {
      parts.push((item as { text: string }).text);
    }
  }
  return parts.length > 0 ? parts.join("") : undefined;
}

function bodyOf(response: McpApiResponse): Record<string, unknown> {
  return response.body as Record<string, unknown>;
}

// ── The end-to-end run ───────────────────────────────────────────────────────

test("e2e: register → enable → connect → call → provenance → capability, through the exact handover wiring", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kai-mcp-e2e-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const noteFile = join(dir, "notes.txt");

  // ── The runtime's real components ──────────────────────────────────────────
  const store = fakeApprovalStore();
  let seq = 0;
  const approvals = createApprovalService({ store, idFactory: () => `apr-${++seq}`, defaultTtlMs: 60_000 });
  const policy = createPolicyEngine();
  const tools = createToolRegistry({ policy, approvals });
  const capabilities = createCapabilityRegistry();

  // ── handover #2, first half: the ONE manager, exposed as runtime.mcp ───────
  const mcp = createMcpManager({ tools });
  t.after(() => mcp.dispose());

  // ── handover #1, verbatim shape: mount the route surface ───────────────────
  interface MountedRoute {
    method: string;
    pattern: string;
    classification: string;
    handler: McpRouteHandler;
  }
  const routeDefs: MountedRoute[] = [];
  const registration = registerMcpRoutes(
    {
      register: (method: string, pattern: string, handler: McpRouteHandler, classification: string) => {
        routeDefs.push({ method, pattern, classification, handler });
      },
    },
    { manager: mcp, tools },
  );
  // 16: the 15 handover routes plus GET /mcp/servers/:name/resources/read
  // (P6 resource reads). A count change here must be deliberate, like this one.
  assert.equal(routeDefs.length, 16);
  assert.equal(registration.manager, mcp, "the mount reuses THE runtime manager (one MCP universe)");
  const api = registration.api;

  // ── handover #2, second half: the measured capability ──────────────────────
  const installed = installMcpCapability(capabilities, mcp);
  assert.equal(installed.ok, true);

  // ── 1. GET /mcp is served, and the mounted handler is the one that serves it.
  const mountedGetMcp = routeDefs.find((def) => def.method === "GET" && def.pattern === "/mcp");
  assert.ok(mountedGetMcp !== undefined);
  assert.equal(mountedGetMcp.classification, "READ");
  const viaMount = await mountedGetMcp.handler({ method: "GET", path: "/mcp" }, {});
  assert.equal(viaMount.status, 200, JSON.stringify(viaMount.body));

  const home0 = await api.handle({ method: "GET", path: "/mcp" });
  assert.equal(home0.status, 200);
  assert.deepEqual(bodyOf(home0).counts, { servers: 0, enabled: 0, connected: 0, tools: 0, resources: 0 });
  assert.equal((await capabilities.checkHealth("mcp"))?.availability, "UNAVAILABLE");

  // ── 2. Register: parked, nothing happens until a human approves.
  const entry = {
    name: "fixture",
    command: process.execPath,
    args: [SERVER, `--note-file=${noteFile}`],
    risk: { default: "WRITE", tools: { echo: "READ" } },
  };
  const parked = await api.handle({ method: "POST", path: "/mcp/servers", body: entry });
  assert.equal(parked.status, 409);
  const registerApproval = bodyOf(parked).approvalId as string;
  assert.equal(mcp.servers.list().length, 0, "a parked registration stores nothing");

  assert.equal(approvals.decide(registerApproval, true).ok, true);
  const registered = await api.handle({ method: "POST", path: "/mcp/servers", body: { ...entry, approvalId: registerApproval } });
  assert.equal(registered.status, 200, JSON.stringify(registered.body));
  assert.equal((bodyOf(registered).result as Record<string, unknown>).enabled, false);
  assert.equal((await capabilities.checkHealth("mcp"))?.availability, "UNAVAILABLE", "registered but not enabled");

  // ── 3. Enable: parked (WRITE), approved → DEGRADED (enabled, not connected).
  const enableParked = await api.handle({ method: "POST", path: "/mcp/servers/fixture/enable", body: {} });
  assert.equal(enableParked.status, 409);
  const enableApproval = bodyOf(enableParked).approvalId as string;
  assert.equal(approvals.decide(enableApproval, true).ok, true);
  const enabled = await api.handle({ method: "POST", path: "/mcp/servers/fixture/enable", body: { approvalId: enableApproval } });
  assert.equal(enabled.status, 200);
  const degraded = await capabilities.checkHealth("mcp");
  assert.equal(degraded?.availability, "DEGRADED");
  assert.match(degraded?.detail ?? "", /enabled but not connected/);

  // ── 4. Connect: parked (EXTERNAL — third-party code under KAI's authority),
  //      approved → the server really runs and its tools land in KAI's registry.
  const connectParked = await api.handle({ method: "POST", path: "/mcp/servers/fixture/connect", body: {} });
  assert.equal(connectParked.status, 409);
  const connectApproval = bodyOf(connectParked).approvalId as string;
  assert.equal(approvals.decide(connectApproval, true).ok, true);
  const connected = await api.handle({ method: "POST", path: "/mcp/servers/fixture/connect", body: { approvalId: connectApproval } });
  assert.equal(connected.status, 200, JSON.stringify(connected.body));
  const connectResult = bodyOf(connected).result as Record<string, unknown>;
  assert.deepEqual([...(connectResult.registered as string[])].sort(), ["mcp.fixture.echo", "mcp.fixture.write_note"]);

  const available = await capabilities.checkHealth("mcp");
  assert.equal(available?.availability, "AVAILABLE");
  assert.match(available?.detail ?? "", /1 MCP server\(s\) connected/);

  const home1 = await api.handle({ method: "GET", path: "/mcp" });
  assert.equal((bodyOf(home1).counts as Record<string, unknown>).connected, 1);
  assert.equal((bodyOf(home1).counts as Record<string, unknown>).tools, 2);

  // ── 5. A READ call runs; a WRITE call parks, and only the approved retry
  //      reaches the real server process (proven by the file it appends to).
  const echoed = await api.handle({
    method: "POST",
    path: "/mcp/servers/fixture/call",
    body: { tool: "echo", arguments: { text: "e2e echo" }, source: "ui" },
  });
  assert.equal(echoed.status, 200);
  assert.equal(toolText(bodyOf(echoed).result), "e2e echo");

  const writeParked = await api.handle({
    method: "POST",
    path: "/mcp/servers/fixture/call",
    body: { tool: "write_note", arguments: { note: "e2e write" } },
  });
  assert.equal(writeParked.status, 409);
  const writeApproval = bodyOf(writeParked).approvalId as string;
  assert.equal(existsSync(noteFile), false, "a parked write must not reach the server");
  assert.equal(approvals.decide(writeApproval, true).ok, true);
  const writeDone = await api.handle({
    method: "POST",
    path: "/mcp/servers/fixture/call",
    body: { tool: "write_note", arguments: { note: "e2e write" }, approvalId: writeApproval },
  });
  assert.equal(writeDone.status, 200, JSON.stringify(writeDone.body));
  assert.match(readFileSync(noteFile, "utf8"), /e2e write/);

  // ── 6. handover #2, the dispatch body: the exact call runtime.ts will make.
  const dispatched = await dispatchMcpCapability(mcp, "call", {
    server: "fixture",
    tool: "echo",
    arguments: { text: "via the runtime branch" },
  });
  assert.equal(toolText(dispatched), "via the runtime branch");

  // ── 7. Provenance: every attempt, newest first, with the caller and approval.
  const ledger = await api.handle({ method: "GET", path: "/mcp/provenance" });
  const records = bodyOf(ledger).records as Array<Record<string, unknown>>;
  assert.equal(records.length, 4, JSON.stringify(records));
  assert.equal(records[0]?.source, "capability.mcp", "the runtime dispatch is labelled as the capability");
  assert.equal(records[0]?.toolId, "mcp.fixture.echo");
  assert.equal(records[1]?.toolId, "mcp.fixture.write_note");
  assert.equal(records[1]?.approvalId, writeApproval);
  assert.equal(records[2]?.status, "APPROVAL_REQUIRED");
  assert.equal(records[2]?.approvalId, writeApproval);
  assert.equal(records[3]?.source, "ui");

  // ── 8. Resources from the live connection; the summary counts them.
  const resources = await api.handle({ method: "GET", path: "/mcp/servers/fixture/resources" });
  assert.equal(resources.status, 200);
  assert.equal((bodyOf(resources).resources as unknown[]).length, 2);

  // ── 9. Dispose ends the world cleanly: the tool refuses, no orphan process.
  await mcp.dispose();
  await mcp.dispose();
  const afterDispose = await api.handle({ method: "POST", path: "/mcp/servers/fixture/call", body: { tool: "echo", arguments: { text: "x" } } });
  assert.equal(afterDispose.status, 502, "after dispose the server is not listening");
});
