// Transport-contract tests for the session methods on the KAI Core client
// (`src/core/kai-core.ts`).
//
//   cd app && node --test "tests/kai-core-sessions.test.ts"
//
// Injected `fetchImpl` throughout; nothing touches a socket. The wire shapes are
// what the running Core returns today: GET /sessions -> {sessions, activeSessionId},
// GET /sessions/active -> {session}, and POST /sessions* -> {session}.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createCoreClient } from "../src/core/kai-core.ts";

const ACTIVE_SESSION = {
  id: "sess_abc",
  title: "Conversation 1",
  status: "ACTIVE",
  createdAt: "2026-10-03T10:00:00.000Z",
  updatedAt: "2026-10-03T10:05:00.000Z",
  turnCount: 2,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface Call {
  url: string;
  method: string;
  body: unknown;
}

/** A fetch that records every call and answers with the supplied response. */
function recordingFetch(res: Response): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url: String(url), method: init?.method ?? "GET", body });
    return res;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

test("GET /sessions parses the list and the active pointer", async () => {
  const { fetchImpl, calls } = recordingFetch(
    jsonResponse({
      sessions: [
        ACTIVE_SESSION,
        { id: "sess_old", title: "Older", status: "ARCHIVED", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" },
      ],
      activeSessionId: "sess_abc",
    }),
  );
  const client = createCoreClient({ fetchImpl });
  const res = await client.sessions();
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.value.sessions.length, 2);
  assert.equal(res.value.sessions[0]?.id, "sess_abc");
  assert.equal(res.value.sessions[0]?.turnCount, 2);
  assert.equal(res.value.sessions[1]?.status, "ARCHIVED");
  assert.equal(res.value.sessions[1]?.turnCount, undefined, "an absent turnCount stays absent");
  assert.equal(res.value.activeSessionId, "sess_abc");
  assert.equal(calls[0]?.url, "http://127.0.0.1:8788/sessions");
});

test("GET /sessions with no active session reports null, not an empty string", async () => {
  const { fetchImpl } = recordingFetch(jsonResponse({ sessions: [], activeSessionId: null }));
  const client = createCoreClient({ fetchImpl });
  const res = await client.sessions({ includeArchived: true, limit: 5 });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.deepEqual(res.value.sessions, []);
  assert.equal(res.value.activeSessionId, null);
});

test("GET /sessions assembles its query options", async () => {
  const { fetchImpl, calls } = recordingFetch(jsonResponse({ sessions: [], activeSessionId: null }));
  const client = createCoreClient({ fetchImpl });
  await client.sessions({ status: "ARCHIVED", includeArchived: true, limit: 7 });
  assert.equal(
    calls[0]?.url,
    "http://127.0.0.1:8788/sessions?status=ARCHIVED&limit=7&includeArchived=true",
  );
});

test("a session record missing a required field is dropped, never invented", async () => {
  const { fetchImpl } = recordingFetch(
    jsonResponse({
      sessions: [{ id: "sess_x", title: "No status" }, ACTIVE_SESSION],
      activeSessionId: "sess_abc",
    }),
  );
  const client = createCoreClient({ fetchImpl });
  const res = await client.sessions();
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.value.sessions.length, 1);
  assert.equal(res.value.sessions[0]?.id, "sess_abc");
});

test("a /sessions body with no array at `sessions` is INVALID_RESPONSE", async () => {
  const { fetchImpl } = recordingFetch(jsonResponse({ sessions: "nope" }));
  const client = createCoreClient({ fetchImpl });
  const res = await client.sessions();
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.error.code, "INVALID_RESPONSE");
});

test("GET /sessions/active parses the wrapped session", async () => {
  const { fetchImpl, calls } = recordingFetch(jsonResponse({ session: ACTIVE_SESSION }));
  const client = createCoreClient({ fetchImpl });
  const res = await client.activeSession();
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.value?.id, "sess_abc");
  assert.equal(calls[0]?.url, "http://127.0.0.1:8788/sessions/active");
});

test("GET /sessions/active with a null session is a successful null", async () => {
  const { fetchImpl } = recordingFetch(jsonResponse({ session: null }));
  const client = createCoreClient({ fetchImpl });
  const res = await client.activeSession();
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.value, null);
});

test("createSession POSTs and unwraps the created session", async () => {
  const { fetchImpl, calls } = recordingFetch(jsonResponse({ session: ACTIVE_SESSION }, 201));
  const client = createCoreClient({ fetchImpl });
  const res = await client.createSession({ title: "Named" });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.value.id, "sess_abc");
  assert.equal(calls[0]?.url, "http://127.0.0.1:8788/sessions");
  assert.equal(calls[0]?.method, "POST");
  assert.deepEqual(calls[0]?.body, { title: "Named" });
});

test("createSession with no title sends an empty object (Core picks the default)", async () => {
  const { fetchImpl, calls } = recordingFetch(jsonResponse({ session: ACTIVE_SESSION }, 201));
  const client = createCoreClient({ fetchImpl });
  const res = await client.createSession();
  assert.equal(res.ok, true);
  assert.deepEqual(calls[0]?.body, {});
});

test("renameSession POSTs the new title to /sessions/:id/rename", async () => {
  const renamed = { ...ACTIVE_SESSION, title: "Renamed" };
  const { fetchImpl, calls } = recordingFetch(jsonResponse({ session: renamed }));
  const client = createCoreClient({ fetchImpl });
  const res = await client.renameSession("sess_abc", "Renamed");
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.value.title, "Renamed");
  assert.equal(calls[0]?.url, "http://127.0.0.1:8788/sessions/sess_abc/rename");
  assert.deepEqual(calls[0]?.body, { title: "Renamed" });
});

test("archive / unarchive / activate hit the right lifecycle routes", async () => {
  for (const [method, suffix] of [
    ["archiveSession", "archive"],
    ["unarchiveSession", "unarchive"],
    ["activateSession", "activate"],
  ] as const) {
    const { fetchImpl, calls } = recordingFetch(jsonResponse({ session: ACTIVE_SESSION }));
    const client = createCoreClient({ fetchImpl });
    const res = await client[method]("sess_abc");
    assert.equal(res.ok, true, `${method} should succeed`);
    assert.equal(calls[0]?.url, `http://127.0.0.1:8788/sessions/sess_abc/${suffix}`);
    assert.equal(calls[0]?.method, "POST");
  }
});

test("a non-session body under `session` is INVALID_RESPONSE, not a crash", async () => {
  const { fetchImpl } = recordingFetch(jsonResponse({ session: { id: "sess_abc" } }));
  const client = createCoreClient({ fetchImpl });
  const res = await client.createSession();
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.error.code, "INVALID_RESPONSE");
});

test("no session method ever rejects, even against a synchronously throwing fetch", async () => {
  const hostile = (() => {
    throw new Error("boom");
  }) as unknown as typeof fetch;
  const c = createCoreClient({ fetchImpl: hostile, timeoutMs: 50 });
  await assert.doesNotReject(() => c.sessions());
  await assert.doesNotReject(() => c.activeSession());
  await assert.doesNotReject(() => c.createSession());
  await assert.doesNotReject(() => c.renameSession("sess_abc", "x"));
  await assert.doesNotReject(() => c.archiveSession("sess_abc"));
  await assert.doesNotReject(() => c.unarchiveSession("sess_abc"));
  await assert.doesNotReject(() => c.activateSession("sess_abc"));
});
