// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The MCP route surface — `createMcpApi` (pure) and `registerMcpRoutes` (host
 * adapter), driven end to end through the REAL tool registry, policy engine and
 * approval service, against KAI's own fixture server spawned for real.
 *
 * These are the assertions that make `GET /mcp` returning 200 (instead of 404)
 * a proven property of THIS module, mountable by the integration stream with
 * the one-line call in WIRING.md. Note: until the integrator mounts
 * `registerMcpRoutes` in `core/src/api/routes.ts`, the LIVE `/mcp` endpoint of
 * a running Core still 404s — that is a wiring fact, not a route fact, and the
 * evidence file says so.
 *
 * Run from `core/`:  node --test tests/mcp-routes.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createMcpManager } from "../src/mcp/manager.ts";
import { createMcpApi, registerMcpRoutes, type McpApiResponse } from "../src/mcp/routes.ts";
import { createApprovalService } from "../src/approvals/service.ts";
import { createPolicyEngine } from "../src/policies/gate.ts";
import { createToolRegistry } from "../src/tools/registry.ts";

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

function tempDir(t: { after(fn: () => void | Promise<void>): void }) {
  const dir = mkdtempSync(join(tmpdir(), "kai-mcp-routes-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
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

/** Park, decide, retry — the exact HTTP dance every mutation requires. */
async function approved(
  api: { handle(request: { method: string; path: string; body?: unknown }): Promise<McpApiResponse> },
  approvals: { decide(id: string, approved: boolean): { ok: boolean } },
  request: { method: string; path: string; body?: unknown },
): Promise<McpApiResponse> {
  const parked = await api.handle(request);
  assert.equal(parked.status, 409, `expected a park, got ${parked.status}: ${JSON.stringify(parked.body)}`);
  const approvalId = bodyOf(parked).approvalId;
  assert.equal(typeof approvalId, "string");
  assert.equal(approvals.decide(approvalId as string, true).ok, true);
  const body = typeof request.body === "object" && request.body !== null ? { ...(request.body as object) } : {};
  return api.handle({ ...request, body: { ...body, approvalId } });
}

// ── The table and the 404 ────────────────────────────────────────────────────

test("routes: the table serves GET /mcp (the 404 is gone) and falls through for paths it does not own", async (t) => {
  const { registry } = policyRegistry();
  const api = createMcpApi({ tools: registry });
  t.after(() => api.manager.dispose());

  const routes = api.routes();
  // 16: the 15 handover routes plus GET /mcp/servers/:name/resources/read.
  assert.equal(routes.length, 16, JSON.stringify(routes));
  assert.ok(routes.includes("GET /mcp"));
  assert.ok(routes.includes("POST /mcp/servers/:name/call"));
  assert.ok(routes.includes("GET /mcp/servers/:name/resources/read"));
  assert.ok(routes.includes("GET /mcp/provenance"));

  const home = await api.handle({ method: "GET", path: "/mcp" });
  assert.equal(home.status, 200, JSON.stringify(home.body));
  const body = bodyOf(home);
  assert.equal(body.service, "mcp");
  assert.equal((body.capability as Record<string, unknown>).id, "mcp");
  assert.equal((body.capability as Record<string, unknown>).availability, "UNAVAILABLE");
  assert.deepEqual(body.counts, { servers: 0, enabled: 0, connected: 0, tools: 0, resources: 0 });
  assert.deepEqual(body.servers, []);
  assert.equal((body.provenance as Record<string, unknown>).recorded, 0);

  // A path this module does not own 404s so the integrator's mount falls
  // through to the routes that already existed.
  const foreign = await api.handle({ method: "GET", path: "/sessions" });
  assert.equal(foreign.status, 404);
  assert.match(String(bodyOf(foreign).reason), /no route for GET \/sessions/);

  // A query string never changes which route matches.
  const withQuery = await api.handle({ method: "GET", path: "/mcp?verbose=1" });
  assert.equal(withQuery.status, 200);
});

// ── The host adapter ─────────────────────────────────────────────────────────

test("routes: registerMcpRoutes mounts into every host shape the integrator may hold", async () => {
  const { registry } = policyRegistry();
  const manager = createMcpManager({ tools: registry });

  // 1. A bare function sink — the exact shape the api/routes.ts handover uses.
  const mounted: Array<[string, string, string]> = [];
  const registration = registerMcpRoutes(
    (method: string, pattern: string, _handler: unknown, classification: string) => {
      mounted.push([method, pattern, classification]);
    },
    { manager },
  );
  // 16 with the P6 resource-read route.
  assert.equal(mounted.length, 16);
  const find = (key: string) => mounted.find(([m, p]) => `${m} ${p}` === key);
  assert.deepEqual(find("GET /mcp")?.[2], "READ");
  assert.deepEqual(find("POST /mcp/servers")?.[2], "WRITE");
  assert.deepEqual(find("POST /mcp/servers/:name/connect")?.[2], "EXTERNAL");
  assert.deepEqual(find("POST /mcp/servers/:name/call")?.[2], "EXTERNAL");
  assert.deepEqual(find("POST /mcp/servers/:name/enable")?.[2], "WRITE");

  // The registration returns THE manager (one MCP universe) and a working api.
  assert.equal(registration.manager, manager);
  assert.equal(registration.api.manager, manager);
  assert.equal((await registration.api.handle({ method: "GET", path: "/mcp" })).status, 200);

  // 2. An object sink with `register`.
  const viaRegister: string[] = [];
  registerMcpRoutes(
    {
      register(method: string, pattern: string) {
        viaRegister.push(`${method} ${pattern}`);
      },
    },
    { manager },
  );
  assert.equal(viaRegister.length, 16);

  // 3. An express-like sink with get+post (classification has nowhere to go,
  //    which is fine: the classification is a doc string, not an enforcement).
  const viaExpress: string[] = [];
  registerMcpRoutes(
    {
      get(pattern: string) {
        viaExpress.push(`GET ${pattern}`);
      },
      post(pattern: string) {
        viaExpress.push(`POST ${pattern}`);
      },
    },
    { manager },
  );
  assert.equal(viaExpress.length, 16);
  assert.ok(viaExpress.includes("GET /mcp"));

  // 4. A host that can carry nothing is a wiring error, loudly.
  assert.throws(() => registerMcpRoutes({}, { manager }), /must be a function/);

  await manager.dispose();
});

// ── The full lifecycle through the handlers ─────────────────────────────────

test("routes: a full lifecycle — park, approve, retry — ends in a real MCP tool result", async (t) => {
  const dir = tempDir(t);
  const noteFile = join(dir, "notes.txt");
  const { registry, approvals } = policyRegistry();
  const api = createMcpApi({ tools: registry });
  t.after(() => api.manager.dispose());

  // 1. Register: parks (WRITE), nothing happens while parked.
  const entry = {
    name: "fixture",
    command: process.execPath,
    args: [SERVER, `--note-file=${noteFile}`],
    risk: { default: "WRITE", tools: { echo: "READ" } },
  };
  const parked = await api.handle({ method: "POST", path: "/mcp/servers", body: entry });
  assert.equal(parked.status, 409);
  assert.equal(bodyOf(parked).approvalRequired, true);
  assert.equal(api.manager.servers.list().length, 0, "nothing is registered while the park is pending");

  const registered = await approved(api, approvals, { method: "POST", path: "/mcp/servers", body: entry });
  assert.equal(registered.status, 200, JSON.stringify(registered.body));
  const registeredResult = bodyOf(registered).result as Record<string, unknown>;
  assert.equal(registeredResult.name, "fixture");
  assert.equal(registeredResult.enabled, false, "a server lands inert");

  // 2. Enable (parks), then connect (parks as EXTERNAL).
  const enabled = await approved(api, approvals, { method: "POST", path: "/mcp/servers/fixture/enable", body: {} });
  assert.equal(enabled.status, 200);
  assert.equal((bodyOf(enabled).result as Record<string, unknown>).enabled, true);

  const connected = await approved(api, approvals, { method: "POST", path: "/mcp/servers/fixture/connect", body: {} });
  assert.equal(connected.status, 200, JSON.stringify(connected.body));
  const connectResult = bodyOf(connected).result as Record<string, unknown>;
  assert.deepEqual([...(connectResult.registered as string[])].sort(), ["mcp.fixture.echo", "mcp.fixture.write_note"]);

  // 3. GET /mcp now measures a connected server.
  const home = await api.handle({ method: "GET", path: "/mcp" });
  const homeBody = bodyOf(home);
  assert.equal((homeBody.counts as Record<string, unknown>).connected, 1);
  assert.equal((homeBody.counts as Record<string, unknown>).tools, 2);
  assert.equal((homeBody.capability as Record<string, unknown>).availability, "AVAILABLE");

  // 4. The catalogue lists names, never secret values.
  const servers = await api.handle({ method: "GET", path: "/mcp/servers" });
  const listed = (bodyOf(servers).servers as Array<Record<string, unknown>>)[0];
  assert.equal(listed?.connected, true);
  assert.deepEqual(listed?.envKeys, []);
  assert.equal(Object.hasOwn(listed ?? {}, "env"), false, "a listing never carries secret values");

  // 5. Tools are KAI-registered, with KAI-declared risk.
  const tools = await api.handle({ method: "GET", path: "/mcp/servers/fixture/tools" });
  const toolList = (bodyOf(tools).tools as Array<Record<string, unknown>>).slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
  assert.deepEqual(
    toolList.map((tool) => [tool.id, tool.risk]),
    [
      ["mcp.fixture.echo", "READ"],
      ["mcp.fixture.write_note", "WRITE"],
    ],
  );

  // 6. A READ call runs immediately, through the real registry boundary.
  const echoed = await api.handle({
    method: "POST",
    path: "/mcp/servers/fixture/call",
    body: { tool: "echo", arguments: { text: "hello via route" }, sessionId: "s-route", agentId: "kai", source: "ui" },
  });
  assert.equal(echoed.status, 200, JSON.stringify(echoed.body));
  const echoBody = bodyOf(echoed);
  assert.equal(echoBody.toolId, "mcp.fixture.echo");
  assert.equal(typeof echoBody.executionId, "string");
  assert.equal(toolText(echoBody.result), "hello via route");

  // 7. A WRITE call parks BEFORE the server ever sees it; an approved retry runs.
  const writeRequest = { tool: "write_note", arguments: { note: "route write" } };
  const writeParked = await api.handle({ method: "POST", path: "/mcp/servers/fixture/call", body: writeRequest });
  assert.equal(writeParked.status, 409);
  const writeApprovalId = bodyOf(writeParked).approvalId as string;
  assert.equal(typeof writeApprovalId, "string");
  assert.equal(existsSync(noteFile), false, "a parked MCP write must not reach the server");
  assert.equal(approvals.decide(writeApprovalId, true).ok, true);
  const writeDone = await api.handle({
    method: "POST",
    path: "/mcp/servers/fixture/call",
    body: { ...writeRequest, approvalId: writeApprovalId },
  });
  assert.equal(writeDone.status, 200, JSON.stringify(writeDone.body));
  assert.match(readFileSync(noteFile, "utf8"), /route write/);

  // 8. Resources come off the live connection and the summary counts them.
  const resources = await api.handle({ method: "GET", path: "/mcp/servers/fixture/resources" });
  assert.equal(resources.status, 200);
  assert.equal((bodyOf(resources).resources as unknown[]).length, 2);
  const afterResources = await api.handle({ method: "GET", path: "/mcp" });
  assert.equal((bodyOf(afterResources).counts as Record<string, unknown>).resources, 2);

  // 9. The provenance ledger: newest first, every attempt, honest fields.
  const ledger = await api.handle({ method: "GET", path: "/mcp/provenance" });
  const records = bodyOf(ledger).records as Array<Record<string, unknown>>;
  assert.equal(records.length, 3, JSON.stringify(records));
  assert.equal(records[0]?.status, "EXECUTED");
  assert.equal(records[0]?.toolId, "mcp.fixture.write_note");
  assert.equal(records[0]?.approvalId, writeApprovalId);
  assert.equal(records[1]?.status, "APPROVAL_REQUIRED");
  assert.equal(records[1]?.approvalId, writeApprovalId);
  assert.equal(records[2]?.status, "EXECUTED");
  assert.equal(records[2]?.toolId, "mcp.fixture.echo");
  assert.equal(records[2]?.source, "ui");
  assert.equal(records[2]?.sessionId, "s-route");
  assert.equal(records[2]?.agentId, "kai");
  assert.equal(typeof records[2]?.durationMs, "number");

  const limited = await api.handle({ method: "GET", path: "/mcp/provenance", query: new URLSearchParams("limit=1") });
  assert.equal((bodyOf(limited).records as unknown[]).length, 1);
  assert.equal((bodyOf(limited).records as Array<Record<string, unknown>>)[0]?.executionId, records[0]?.executionId);

  const badLimit = await api.handle({ method: "GET", path: "/mcp/provenance", query: new URLSearchParams("limit=-1") });
  assert.equal(badLimit.status, 400);
});

// ── Refusals are typed HTTP shapes ──────────────────────────────────────────

test("routes: refusals map to honest HTTP shapes and nothing runs without approval", async (t) => {
  const dir = tempDir(t);
  const { registry, approvals } = policyRegistry();
  const api = createMcpApi({ tools: registry });
  t.after(() => api.manager.dispose());

  // Unknown server → 404.
  const unknown = await api.handle({ method: "POST", path: "/mcp/servers/nope/call", body: { tool: "echo" } });
  assert.equal(unknown.status, 404);

  // A registered-but-unconnected server → 502 (nothing to talk to).
  api.manager.registerServer("idle", { command: process.execPath, args: [] });
  api.manager.enableServer("idle");
  const unconnected = await api.handle({ method: "POST", path: "/mcp/servers/idle/call", body: { tool: "echo" } });
  assert.equal(unconnected.status, 502);
  assert.equal(bodyOf(unconnected).code, "AGENT_NOT_LISTENING");

  // Reserved name → 400 before any policy runs.
  const reserved = await api.handle({ method: "POST", path: "/mcp/servers", body: { name: "system", command: "run" } });
  assert.equal(reserved.status, 400);
  assert.match(String(bodyOf(reserved).reason), /reserved/);

  // Malformed bodies → 400.
  assert.equal((await api.handle({ method: "POST", path: "/mcp/servers", body: null })).status, 400);
  assert.equal((await api.handle({ method: "POST", path: "/mcp/servers/idle/call", body: { tool: "" } })).status, 400);
  assert.equal(
    (await api.handle({ method: "POST", path: "/mcp/servers/idle/call", body: { tool: "echo", arguments: "nope" } })).status,
    400,
  );

  // Duplicate registration: parks first, and the approved retry surfaces the
  // catalogue's own refusal (a value) as a 400.
  const dupEntry = { name: "idle", command: process.execPath, args: [] };
  const dupParked = await api.handle({ method: "POST", path: "/mcp/servers", body: dupEntry });
  assert.equal(dupParked.status, 409);
  const dupApprovalId = bodyOf(dupParked).approvalId as string;
  assert.equal(approvals.decide(dupApprovalId, true).ok, true);
  const dupDone = await api.handle({ method: "POST", path: "/mcp/servers", body: { ...dupEntry, approvalId: dupApprovalId } });
  assert.equal(dupDone.status, 400, JSON.stringify(dupDone.body));
  assert.match(String(bodyOf(dupDone).reason), /already registered/);

  // A REJECTED approval authorises nothing: retry → 403, and the state is inert.
  const rejectedEntry = { name: "rejected-one", command: process.execPath, args: [] };
  const rejectedParked = await api.handle({ method: "POST", path: "/mcp/servers", body: rejectedEntry });
  assert.equal(rejectedParked.status, 409);
  const rejectedApprovalId = bodyOf(rejectedParked).approvalId as string;
  assert.equal(approvals.decide(rejectedApprovalId, false).ok, true);
  const rejectedDone = await api.handle({
    method: "POST",
    path: "/mcp/servers",
    body: { ...rejectedEntry, approvalId: rejectedApprovalId },
  });
  assert.equal(rejectedDone.status, 403);
  assert.equal(api.manager.servers.list().some((server) => server.name === "rejected-one"), false);

  // Update of a server that does not exist: approved retry → 404 (a value).
  const ghostParked = await api.handle({ method: "POST", path: "/mcp/servers/ghost", body: { command: process.execPath } });
  assert.equal(ghostParked.status, 409);
  const ghostApprovalId = bodyOf(ghostParked).approvalId as string;
  assert.equal(approvals.decide(ghostApprovalId, true).ok, true);
  const ghostDone = await api.handle({
    method: "POST",
    path: "/mcp/servers/ghost",
    body: { command: process.execPath, approvalId: ghostApprovalId },
  });
  assert.equal(ghostDone.status, 404);

  // Unknown-name reads are plain 404s.
  assert.equal((await api.handle({ method: "GET", path: "/mcp/servers/nope" })).status, 404);
  assert.equal((await api.handle({ method: "GET", path: "/mcp/servers/nope/tools" })).status, 404);

  // The idle server never got called: nothing on its ledger beyond refusals.
  assert.equal(api.manager.provenance().length, 2, "both idle-server call attempts are on the ledger");
});
