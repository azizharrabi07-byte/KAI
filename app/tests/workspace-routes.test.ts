// Chain proof for the workspace's typed Core routes (`src/workspace/routes.ts`).
//
//   cd app && node --test tests/workspace-routes.test.ts
//
// Every route method is exercised against an injected `fetchImpl`, so the test
// asserts BOTH halves of the chain: the exact HTTP method+path each method
// sends, and the typed value it parses back. Nothing touches a real socket.
//
// The payloads are the shapes the real Core routes return (read from the route
// modules under core/src/): `GET /tools`, `GET /mcp`, `GET /maintenance/status`,
// `POST /prompts/compose`, `GET /actions`, and the parked (`409`) outcomes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorkspaceRoutes } from "../src/workspace/routes.ts";

interface Call {
  method: string;
  url: string;
  body?: unknown;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A fetch that answers by `${method} ${pathname}` and records every call. */
function routeFetch(
  handlers: Record<string, (body: unknown) => Response>,
  calls: Call[] = [],
): { fetchImpl: typeof fetch; calls: Call[] } {
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    const u = new URL(href);
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown;
    if (typeof init?.body === "string") body = JSON.parse(init.body);
    calls.push({ method, url: `${u.pathname}${u.search}`, ...(body !== undefined ? { body } : {}) });
    const key = `${method} ${u.pathname}`;
    const handler = handlers[key];
    if (handler === undefined) return jsonResponse({ error: "not_found", reason: `no stub for ${key}` }, 404);
    return handler(body);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const TOOLS_BODY = {
  service: "tools",
  count: 2,
  tools: [
    {
      id: "system.get_status",
      name: "System status",
      description: "Read host status",
      permission: { risk: "READ", effectful: false, sideEffecting: false },
      schema: { declared: true, schema: { type: "object", properties: {} } },
    },
    {
      id: "agents.run_task",
      name: "Run a task on a worker",
      description: "Hand work to a worker",
      permission: { risk: "EXTERNAL", effectful: true, sideEffecting: true },
      schema: { declared: false, reason: "procedural validator" },
    },
  ],
};

test("GET /tools parses the registry description, missing a required field it drops it", async () => {
  const { fetchImpl, calls } = routeFetch({ "GET /tools": () => jsonResponse(TOOLS_BODY) });
  const routes = createWorkspaceRoutes({ fetchImpl });
  const res = await routes.tools();
  assert.equal(calls[0]?.method, "GET");
  assert.equal(calls[0]?.url, "/tools");
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.value.length, 2);
  assert.equal(res.value[0]?.id, "system.get_status");
  assert.equal(res.value[0]?.permission.risk, "READ");
  assert.equal(res.value[0]?.schema.declared, true);
  assert.equal(res.value[1]?.schema.declared, false);
});

test("GET /tools/:id unwraps { tool } and 404s as a typed refusal", async () => {
  const { fetchImpl, calls } = routeFetch({
    "GET /tools/system.get_status": () => jsonResponse({ tool: TOOLS_BODY.tools[0] }),
    "GET /tools/nope": () => jsonResponse({ error: true, reason: 'no tool is registered with id "nope"' }, 404),
  });
  const routes = createWorkspaceRoutes({ fetchImpl });
  const good = await routes.tool("system.get_status");
  assert.equal(calls[0]?.url, "/tools/system.get_status");
  assert.equal(good.ok, true);
  if (good.ok) assert.equal(good.value.name, "System status");

  const missing = await routes.tool("nope");
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.error.status, 404);
    assert.equal(missing.error.reason, 'no tool is registered with id "nope"');
  }
});

test("a tool that parks answers as a typed APPROVAL_REQUIRED outcome, not a fault", async () => {
  const { fetchImpl, calls } = routeFetch({
    "POST /tools/agents.run_task/invoke": () =>
      jsonResponse({ error: true, reason: "approval required", approvalRequired: true, approvalId: "ap_1" }, 409),
  });
  const routes = createWorkspaceRoutes({ fetchImpl });
  const res = await routes.invokeTool("agents.run_task", { agentId: "hermes" });
  assert.equal(calls[0]?.method, "POST");
  assert.equal(calls[0]?.url, "/tools/agents.run_task/invoke");
  assert.deepEqual(calls[0]?.body, { input: { agentId: "hermes" } });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.value.approvalRequired, true);
  assert.equal(res.value.status, "APPROVAL_REQUIRED");
  assert.equal(res.value.reason, "approval required");
});

test("a direct (READ) tool returns the executed result", async () => {
  const { fetchImpl } = routeFetch({
    "POST /tools/system.get_status/invoke": () =>
      jsonResponse({ toolId: "system.get_status", status: "EXECUTED", invocationId: "inv_1", result: { pid: 42 } }),
  });
  const routes = createWorkspaceRoutes({ fetchImpl });
  const res = await routes.invokeTool("system.get_status", {});
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.value.approvalRequired, false);
  assert.equal(res.value.status, "EXECUTED");
  assert.deepEqual(res.value.result, { pid: 42 });
});

const MCP_BODY = {
  service: "mcp",
  capability: { id: "mcp", availability: "DEGRADED", detail: "1 enabled but not connected" },
  counts: { servers: 1, enabled: 1, connected: 0, tools: 0, resources: 0 },
  servers: [
    {
      name: "echo", transport: "stdio", command: "node", args: ["echo.mjs"], envKeys: ["TOKEN"],
      enabled: true, hasRisk: true, connected: false, toolCount: 0, resourceCount: null,
    },
  ],
  managementTools: { registered: ["mcp.register", "mcp.connect"], refused: [] },
  persistence: { path: "C:/x/mcp.json", problem: null },
  provenance: { recorded: 3 },
};

test("GET /mcp parses the measured capability, catalogue and provenance count", async () => {
  const { fetchImpl, calls } = routeFetch({ "GET /mcp": () => jsonResponse(MCP_BODY) });
  const routes = createWorkspaceRoutes({ fetchImpl });
  const res = await routes.mcp();
  assert.equal(calls[0]?.url, "/mcp");
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.value.capability.availability, "DEGRADED");
  assert.equal(res.value.counts.servers, 1);
  assert.equal(res.value.servers[0]?.name, "echo");
  assert.deepEqual(res.value.servers[0]?.envKeys, ["TOKEN"]);
  assert.equal(res.value.management.registered.length, 2);
  assert.equal(res.value.provenanceCount, 3);
});

test("POST /mcp/servers/:name/connect that parks is a typed outcome", async () => {
  const { fetchImpl, calls } = routeFetch({
    "POST /mcp/servers/echo/connect": () => jsonResponse({ approvalRequired: true, reason: "external" }, 409),
  });
  const routes = createWorkspaceRoutes({ fetchImpl });
  const res = await routes.mcpServerCommand("echo", "connect");
  assert.equal(calls[0]?.method, "POST");
  assert.equal(calls[0]?.url, "/mcp/servers/echo/connect");
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.value.approvalRequired, true);
});

test("GET /mcp/servers/:name/tools parses the server tool list", async () => {
  const { fetchImpl, calls } = routeFetch({
    "GET /mcp/servers/echo/tools": () =>
      jsonResponse({
        server: "echo",
        connected: true,
        tools: [{ id: "mcp.echo.echo", name: "echo", risk: "READ", description: "Echo back." }],
      }),
  });
  const routes = createWorkspaceRoutes({ fetchImpl });
  const res = await routes.mcpServerTools("echo");
  assert.equal(calls[0]?.url, "/mcp/servers/echo/tools");
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.value.length, 1);
    assert.equal(res.value[0]?.id, "mcp.echo.echo");
    assert.equal(res.value[0]?.risk, "READ");
  }
});

test("GET /mcp/servers/:name/resources/read sends the uri and returns the body", async () => {
  const { fetchImpl, calls } = routeFetch({
    "GET /mcp/servers/echo/resources/read": () =>
      jsonResponse({ server: "echo", uri: "echo://kai/hello", resource: { contents: [{ text: "hello" }] } }),
  });
  const routes = createWorkspaceRoutes({ fetchImpl });
  const res = await routes.mcpReadResource("echo", "echo://kai/hello");
  assert.equal(calls[0]?.url, "/mcp/servers/echo/resources/read?uri=echo%3A%2F%2Fkai%2Fhello");
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(JSON.stringify(res.value).includes("hello"), true);
});

test("GET /mcp/provenance sends the limit and parses records", async () => {
  const { fetchImpl, calls } = routeFetch({
    "GET /mcp/provenance": () =>
      jsonResponse({
        records: [
          { executionId: "mcp_1", toolId: "mcp.echo.ping", server: "echo", tool: "ping", source: "ui", status: "EXECUTED", startedAt: "2026-10-05T00:00:00Z", durationMs: 4 },
        ],
      }),
  });
  const routes = createWorkspaceRoutes({ fetchImpl });
  const res = await routes.mcpProvenance(5);
  assert.equal(calls[0]?.url, "/mcp/provenance?limit=5");
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.value[0]?.toolId, "mcp.echo.ping");
});

const MAINT_BODY = {
  maintenance: {
    ok: true,
    checkedAt: "2026-10-05T00:00:00.000Z",
    identity: { buildId: "build-abc", gitCommit: "deadbeef", protocolVersion: 1, pid: 1234, onDiskBuildId: "build-abc", current: true, detail: "running build IS on disk" },
    checks: [
      { name: "identity", status: "pass", detail: "current" },
      { name: "agents", status: "warn", detail: "hermes offline" },
    ],
    repairs: [],
  },
};

test("GET /maintenance/status parses identity, checks and repairs", async () => {
  const { fetchImpl, calls } = routeFetch({ "GET /maintenance/status": () => jsonResponse(MAINT_BODY) });
  const routes = createWorkspaceRoutes({ fetchImpl });
  const res = await routes.maintenance();
  assert.equal(calls[0]?.url, "/maintenance/status");
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.value.identity.current, true);
  assert.equal(res.value.identity.buildId, "build-abc");
  assert.equal(res.value.checks.length, 2);
  assert.equal(res.value.checks[1]?.status, "warn");
});

test("POST /maintenance/run returns the report with repairs", async () => {
  const { fetchImpl, calls } = routeFetch({
    "POST /maintenance/run": () =>
      jsonResponse({
        maintenance: { ...MAINT_BODY.maintenance, repairs: [{ name: "memory-upkeep", performed: true, detail: "ran one cycle" }] },
      }),
  });
  const routes = createWorkspaceRoutes({ fetchImpl });
  const res = await routes.runMaintenance();
  assert.equal(calls[0]?.method, "POST");
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.value.repairs[0]?.name, "memory-upkeep");
});

test("POST /prompts/compose parses the sections report and the text", async () => {
  const { fetchImpl, calls } = routeFetch({
    "POST /prompts/compose": () =>
      jsonResponse({
        prompt: {
          text: "…prompt…",
          sections: [{ name: "safety", band: "stable", trust: "instruction", chars: 1400, bodyChars: 1380, budget: 1400, truncated: false }],
          totalChars: 1400,
          problems: [],
          order: ["safety", "identity"],
        },
      }),
  });
  const routes = createWorkspaceRoutes({ fetchImpl });
  const res = await routes.composePrompt("what is hermes doing?", "session");
  assert.equal(calls[0]?.method, "POST");
  assert.deepEqual(calls[0]?.body, { request: "what is hermes doing?", scope: "session" });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.value.totalChars, 1400);
    assert.equal(res.value.sections[0]?.name, "safety");
    assert.deepEqual(res.value.order, ["safety", "identity"]);
  }
});

test("GET /actions sends the limit and keeps the loose payloads", async () => {
  const { fetchImpl, calls } = routeFetch({
    "GET /actions": () => jsonResponse({ actions: [{ type: "action.executed", toolId: "memory.write", employeeId: "hermes" }] }),
  });
  const routes = createWorkspaceRoutes({ fetchImpl });
  const res = await routes.actions(20);
  assert.equal(calls[0]?.url, "/actions?limit=20");
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.value[0]?.toolId, "memory.write");
});

test("a 2xx with a non-object body is INVALID_RESPONSE, never a crash", async () => {
  const { fetchImpl } = routeFetch({
    "GET /tools": () => new Response("<html>not json</html>", { status: 200 }),
  });
  const routes = createWorkspaceRoutes({ fetchImpl });
  const res = await routes.tools();
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.code, "INVALID_RESPONSE");
});

test("a refused connection is CORE_OFFLINE", async () => {
  const fetchImpl = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  const routes = createWorkspaceRoutes({ fetchImpl });
  const res = await routes.mcp();
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.code, "CORE_OFFLINE");
});

test("a slow Core times out as TIMEOUT", async () => {
  const fetchImpl = ((_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    })) as unknown as typeof fetch;
  const routes = createWorkspaceRoutes({ fetchImpl, timeoutMs: 10 });
  const res = await routes.maintenance();
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.code, "TIMEOUT");
});
