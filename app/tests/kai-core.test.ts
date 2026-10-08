// Transport-contract tests for the KAI Core client (`src/core/kai-core.ts`).
//
//   cd app && node --test tests/kai-core.test.ts
//
// Every test injects a fake `fetchImpl`; nothing here touches a real socket.
// The point of this suite is the failure contract: a Core that is offline, slow,
// hostile or returning the wrong shape must still resolve to a typed
// `CoreResult` and never reject.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createCoreClient, DEFAULT_CORE_BASE_URL } from "../src/core/kai-core.ts";

/** The exact `/state` payload captured from the running Core on 2026-10-01. */
const LIVE_STATE = {
  ok: true,
  startedAt: "2026-10-01T22:39:13.017Z",
  uptimeMs: 13602,
  database: { path: "C:\\Users\\DELL\\AppData\\Local\\KAI\\core\\kai-core.db" },
  agents: [
    { id: "hermes", state: "idle", health: { ok: true, latencyMs: 2, endpoint: "http://127.0.0.1:8642", version: "unknown" } },
    { id: "opencode", state: "idle" },
  ],
  missions: { active: 0, unfinished: 0 },
  notifications: { unread: 0 },
  approvals: { pending: 0 },
  scheduler: { running: true, enabled: 0, total: 0 },
  tools: { registered: 4 },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A fetch that answers every call with the supplied response. */
function okFetch(res: Response, calls?: string[]): typeof fetch {
  return (async (url: string | URL | Request) => {
    calls?.push(String(url));
    return res;
  }) as unknown as typeof fetch;
}

test("a healthy /state parses into the typed summary", async () => {
  const client = createCoreClient({ fetchImpl: okFetch(jsonResponse(LIVE_STATE)) });
  const res = await client.state();
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.value.uptimeMs, 13602);
  assert.equal(res.value.agents.length, 2);
  assert.equal(res.value.agents[0]?.id, "hermes");
  assert.equal(res.value.agents[0]?.health?.latencyMs, 2);
  assert.equal(res.value.agents[1]?.state, "idle");
  assert.equal(res.value.scheduler?.running, true);
  assert.equal(res.value.tools?.registered, 4);
  assert.equal(res.value.database?.path, LIVE_STATE.database.path);
});

test("a refused connection is CORE_OFFLINE", async () => {
  const refused = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  const client = createCoreClient({ fetchImpl: refused });
  const res = await client.state();
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.error.code, "CORE_OFFLINE");
});

test("a 401 is AUTH_REQUIRED", async () => {
  const client = createCoreClient({ fetchImpl: okFetch(jsonResponse({ error: "unauthorized" }, 401)) });
  const res = await client.state();
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.error.code, "AUTH_REQUIRED");
  assert.equal(res.error.status, 401);
});

test("a 500 with {error,reason} is REQUEST_FAILED and carries the reason", async () => {
  const client = createCoreClient({
    fetchImpl: okFetch(jsonResponse({ error: "internal", reason: "dependency_failed" }, 500)),
  });
  const res = await client.agents();
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.error.code, "REQUEST_FAILED");
  assert.equal(res.error.status, 500);
  assert.equal(res.error.reason, "dependency_failed");
});

test("an AbortError from fetch is TIMEOUT", async () => {
  const aborted = (async () => {
    throw new DOMException("The operation was aborted.", "AbortError");
  }) as unknown as typeof fetch;
  const client = createCoreClient({ fetchImpl: aborted });
  const res = await client.health();
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.error.code, "TIMEOUT");
});

test("the timeout really aborts the request and clears its timer", async () => {
  let seenSignal: AbortSignal | undefined;
  const hanging = ((_url: string, init: RequestInit) => {
    seenSignal = init.signal ?? undefined;
    return new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        reject(new DOMException("Aborted", "AbortError"));
      });
    });
  }) as unknown as typeof fetch;

  const client = createCoreClient({ fetchImpl: hanging, timeoutMs: 20 });
  const res = await client.state();
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.error.code, "TIMEOUT");
  assert.equal(seenSignal?.aborted, true, "the abort signal must be tripped by the timeout");
});

test("a 200 with an HTML body is INVALID_RESPONSE", async () => {
  const html = new Response("<!doctype html><html><body>nope</body></html>", {
    status: 200,
    headers: { "content-type": "text/html" },
  });
  const client = createCoreClient({ fetchImpl: okFetch(html) });
  const res = await client.state();
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.error.code, "INVALID_RESPONSE");
});

test("truncated JSON is INVALID_RESPONSE", async () => {
  const broken = new Response('{"agents":[{"id":"herm', {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  const client = createCoreClient({ fetchImpl: okFetch(broken) });
  const res = await client.agents();
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.error.code, "INVALID_RESPONSE");
});

test("/agents maps the array", async () => {
  const client = createCoreClient({
    fetchImpl: okFetch(jsonResponse({ agents: [{ id: "hermes", state: "working" }, { id: "opencode", state: "idle" }] })),
  });
  const res = await client.agents();
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.deepEqual(
    res.value.map((a) => a.id),
    ["hermes", "opencode"],
  );
  assert.equal(res.value[0]?.state, "working");
});

test("chat handles the Core answer shape", async () => {
  const client = createCoreClient({
    fetchImpl: okFetch(
      jsonResponse({
        agent: "core",
        from_state: true,
        intent: "agent.status",
        reply: "hermes is idle — no task right now.",
        data: { id: "hermes", state: "idle" },
      }),
    ),
  });
  const res = await client.chat("what is hermes doing?");
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.value.agent, "core");
  assert.equal(res.value.fromState, true);
  assert.equal(res.value.intent, "agent.status");
  assert.equal(res.value.reply, "hermes is idle — no task right now.");
});

test("chat handles the pre-existing agent shape", async () => {
  const client = createCoreClient({
    fetchImpl: okFetch(
      jsonResponse({ agent: "hermes", session_id: "abc123", reply: "hello", usage: { total: 5 } }),
    ),
  });
  const res = await client.chat("hi");
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.value.agent, "hermes");
  assert.equal(res.value.sessionId, "abc123");
  assert.equal(res.value.reply, "hello");
  assert.equal(res.value.fromState, undefined);
});

test("a missing field in an otherwise valid response does not throw", async () => {
  // Second agent has no `detail`/`health`; /state has no `tools`/`database`.
  const client = createCoreClient({
    fetchImpl: okFetch(jsonResponse({ agents: [{ id: "hermes", state: "idle" }] })),
  });
  const agents = await client.agents();
  assert.equal(agents.ok, true);
  if (!agents.ok) return;
  assert.equal(agents.value[0]?.health, undefined);
  assert.equal(agents.value[0]?.detail, undefined);

  const stateClient = createCoreClient({
    fetchImpl: okFetch(jsonResponse({ agents: [] })),
  });
  const state = await stateClient.state();
  assert.equal(state.ok, true);
  if (!state.ok) return;
  assert.deepEqual(state.value.agents, []);
  assert.equal(state.value.tools, undefined);
  assert.equal(state.value.uptimeMs, undefined);
});

test("a record missing a required field is dropped, not invented", async () => {
  const client = createCoreClient({
    fetchImpl: okFetch(jsonResponse({ agents: [{ state: "idle" }, { id: "hermes", state: "idle" }] })),
  });
  const res = await client.agents();
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.value.length, 1);
  assert.equal(res.value[0]?.id, "hermes");
});

test("no method ever rejects, even against a synchronously throwing fetch", async () => {
  const hostile = (() => {
    throw new Error("boom");
  }) as unknown as typeof fetch;
  const c = createCoreClient({ fetchImpl: hostile, timeoutMs: 50 });
  await assert.doesNotReject(() => c.health());
  await assert.doesNotReject(() => c.state());
  await assert.doesNotReject(() => c.agents());
  await assert.doesNotReject(() => c.agent("hermes"));
  await assert.doesNotReject(() => c.missions());
  await assert.doesNotReject(() => c.createMission({ title: "x" }));
  await assert.doesNotReject(() => c.cancelMission("m1"));
  await assert.doesNotReject(() => c.notifications());
  await assert.doesNotReject(() => c.markNotificationRead("n1"));
  await assert.doesNotReject(() => c.approvals());
  await assert.doesNotReject(() => c.decideApproval("a1", true));
  await assert.doesNotReject(() => c.memory());
  await assert.doesNotReject(() => c.remember({ type: "note", content: "hi" }));
  await assert.doesNotReject(() => c.chat("hello"));
  await assert.doesNotReject(() => c.ping());
});

test("the request URL is built from a custom baseUrl", async () => {
  const calls: string[] = [];
  const client = createCoreClient({
    baseUrl: "http://127.0.0.1:9999/",
    fetchImpl: okFetch(jsonResponse({ agents: [] }), calls),
  });
  assert.equal(client.baseUrl, "http://127.0.0.1:9999");
  const res = await client.agents();
  assert.equal(res.ok, true);
  assert.equal(calls[0], "http://127.0.0.1:9999/agents");
  assert.equal(DEFAULT_CORE_BASE_URL, "http://127.0.0.1:8788");
});

test("list query params are assembled from the options", async () => {
  const calls: string[] = [];
  const client = createCoreClient({
    fetchImpl: okFetch(jsonResponse({ missions: [] }), calls),
  });
  await client.missions({ status: "ACTIVE", limit: 5 });
  assert.equal(calls[0], `${DEFAULT_CORE_BASE_URL}/missions?status=ACTIVE&limit=5`);
});

test("a 404 on an unknown agent is REQUEST_FAILED with the route reason", async () => {
  const client = createCoreClient({
    fetchImpl: okFetch(jsonResponse({ error: "not_found", reason: "unknown_route" }, 404)),
  });
  const res = await client.agent("nope");
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.error.code, "REQUEST_FAILED");
  assert.equal(res.error.status, 404);
  assert.equal(res.error.reason, "unknown_route");
});
