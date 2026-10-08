// End-to-end chain proof for the workspace composition
// (`src/workspace/workspace.ts` + `routes.ts` + `store.ts` + `core-events.ts`).
//
//   cd app && node --test tests/workspace-chain.test.ts
//
// This drives the REAL wiring: a real `createCoreEventStream` fed by an injected
// transport (no socket), a real `createWorkspaceRoutes` over an injected
// `fetch` (no socket), and a real `createCoreClient` for the SHARED routes. It
// asserts the two paths converge into one slice — the snapshot path and the
// event path — and that approvals come from the SAME client the island uses.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorkspace } from "../src/workspace/workspace.ts";
import { createCoreClient } from "../src/core/kai-core.ts";
import type { CoreTransport } from "../src/core/core-events.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function apiFetch(): typeof fetch {
  return (async (url: string | URL | Request) => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    const path = new URL(href).pathname;
    switch (path) {
      case "/tools":
        return jsonResponse({
          tools: [
            { id: "system.get_status", name: "Status", description: "Read status", permission: { risk: "READ", effectful: false, sideEffecting: false }, schema: { declared: true, schema: {} } },
          ],
        });
      case "/mcp":
        return jsonResponse({
          capability: { availability: "UNAVAILABLE", detail: "no server" },
          counts: { servers: 0, enabled: 0, connected: 0, tools: 0, resources: 0 },
          servers: [],
          managementTools: { registered: [], refused: [] },
          persistence: { path: null, problem: null },
          provenance: { recorded: 0 },
        });
      case "/maintenance/status":
        return jsonResponse({
          maintenance: {
            ok: true, checkedAt: "2026-10-05T00:00:00.000Z",
            identity: { buildId: "b1", gitCommit: "c", protocolVersion: 1, pid: 7, current: true, detail: "" },
            checks: [{ name: "identity", status: "pass", detail: "" }],
            repairs: [],
          },
        });
      case "/actions":
        return jsonResponse({ actions: [] });
      case "/approvals":
        return jsonResponse({
          approvals: [
            { id: "ap1", toolId: "agents.run_task", action: "run", reason: "external", risk: "EXTERNAL", status: "PENDING", createdAt: "2026-10-05T00:00:00.000Z" },
          ],
        });
      default:
        return jsonResponse({ error: true, reason: `no stub for ${path}` }, 404);
    }
  }) as unknown as typeof fetch;
}

/** A transport that opens, feeds one frame, and ends. */
function oneFrameTransport(event: unknown): CoreTransport {
  return async (_signal, onFrame, onOpen) => {
    onOpen();
    onFrame(`data: ${JSON.stringify(event)}`);
  };
}

test("the snapshot path fills the slice from the real routes", async () => {
  const workspace = createWorkspace({
    routesOptions: { fetchImpl: apiFetch() },
    client: createCoreClient({ fetchImpl: apiFetch() }),
    refreshMs: 0,
  });
  await workspace.refresh();
  const slice = workspace.getState();
  assert.equal(slice.conn, "ONLINE");
  assert.equal(slice.tools.length, 1);
  assert.equal(slice.tools[0]?.id, "system.get_status");
  assert.equal(slice.mcp?.capability.availability, "UNAVAILABLE");
  assert.equal(slice.maintenance?.identity.pid, 7);
  assert.deepEqual(slice.actions, []);
  workspace.stop();
});

test("the real event stream folds a Core event into the same slice, KAI-first", async () => {
  const workspace = createWorkspace({
    routesOptions: { fetchImpl: apiFetch() },
    client: createCoreClient({ fetchImpl: apiFetch() }),
    refreshMs: 0,
    streamOptions: {
      transport: oneFrameTransport({ id: "e1", type: "mission.progress", payload: { id: "m1", title: "step 1" } }),
      // No real timers: a transport that ends normally only reschedules on a retry.
      setTimer: () => 0,
      clearTimer: () => {},
    },
  });

  const seen: string[] = [];
  const unsub = workspace.subscribe((slice) => {
    const top = slice.events[0];
    if (top) seen.push(top.line);
  });

  workspace.start();
  // Let the transport's microtasks run.
  await new Promise((r) => setTimeout(r, 20));

  const slice = workspace.getState();
  assert.equal(slice.conn, "ONLINE", "an open stream that delivered a frame is ONLINE");
  assert.equal(slice.events.length, 1);
  assert.equal(slice.events[0]?.line, "KAI is working…");
  assert.equal(slice.events[0]?.text, "Working: step 1");
  assert.ok(seen.includes("KAI is working…"), "subscribers were notified of the event");

  unsub();
  workspace.stop();
});

test("approvals come from the shared Core client, not a second transport", async () => {
  const client = createCoreClient({ fetchImpl: apiFetch() });
  const workspace = createWorkspace({ routesOptions: { fetchImpl: apiFetch() }, client, refreshMs: 0 });
  // The exact client the island holds is the one the workspace exposes; its
  // `approvals()` is the same route the island's approval card reads.
  assert.equal(workspace.client, client);
  const res = await workspace.client.approvals();
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.value.length, 1);
    assert.equal(res.value[0]?.toolId, "agents.run_task");
    assert.equal(res.value[0]?.status, "PENDING");
  }
  workspace.stop();
});

test("a fully-failed refresh degrades honestly rather than blanking the slice", async () => {
  const deadFetch = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  const workspace = createWorkspace({ routesOptions: { fetchImpl: deadFetch }, client: createCoreClient({ fetchImpl: deadFetch }), refreshMs: 0 });
  await workspace.refresh();
  const slice = workspace.getState();
  assert.notEqual(slice.conn, "ONLINE");
  assert.ok(slice.lastError !== null);
  workspace.stop();
});
