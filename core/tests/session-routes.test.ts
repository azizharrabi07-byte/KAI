// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The session route surface, END TO END: a real runtime, a real CoreApi, the
 * real registry + policy + approval services — and the integrator's exact call
 * (`registerSessionRoutes(api, { runtime })`), so what the tests drive is what
 * server.ts will wire.
 *
 * What is pinned here:
 *   - reads answer through the wrapped handle; everything else FALLS THROUGH to
 *     the pre-existing routes (the wrap is in place, not a fork);
 *   - the four mutations go through the ONE boundary and PARK under the default
 *     policy (WRITE / DESTRUCTIVE are never executed silently);
 *   - `decideApproval(id, true)` AUTO-REISSUES the parked call and it executes;
 *     a rejection runs nothing and leaves state unchanged;
 *   - a `duplicate` copy does NOT inherit `agentSessionId` (per-session worker
 *     isolation);
 *   - registration is idempotent (tools are guarded on `get(id) === undefined`);
 *   - a policy that ALLOWS the tools executes them directly, and the service's
 *     own refusals map to their HTTP shapes (404 for an unknown id).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCoreRuntime } from "../src/runtime.ts";
import { createCoreApi } from "../src/api/routes.ts";
import type { CoreApi } from "../src/api/routes.ts";
import { registerSessionRoutes } from "../src/sessions/routes.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "kai-session-routes-"));
}

function boot(dbPath: string, extra: Record<string, unknown> = {}) {
  return createCoreRuntime({
    dbPath,
    agents: { mode: "mock" },
    startScheduler: false,
    subsystemPaths: { runUpkeepOnStart: false },
    ...extra,
  });
}

async function call(
  api: CoreApi,
  method: string,
  path: string,
  opts: { query?: Record<string, string>; body?: unknown } = {},
) {
  return api.handle({
    method,
    path,
    query: new URLSearchParams(opts.query ?? {}),
    ...(opts.body !== undefined ? { body: opts.body } : {}),
  });
}

function cleanup(dir: string, runtime: ReturnType<typeof createCoreRuntime>): Promise<void> {
  return runtime.stop().then(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
}

// ── reads + fallthrough ───────────────────────────────────────────────────────

test("the session read routes answer through the wrapped handle; everything else falls through", async (t) => {
  const dir = tempDir();
  const runtime = boot(join(dir, "kai.db"));
  t.after(() => cleanup(dir, runtime));
  const api = createCoreApi(runtime);
  const registration = registerSessionRoutes(api, { runtime });
  assert.deepEqual(registration.tools.registered, [
    "session.search",
    "session.duplicate",
    "session.close",
    "session.clear",
    "session.delete",
  ]);
  assert.deepEqual(registration.tools.skipped, []);
  assert.equal(registration.patterns.length, 7);

  const sessions = runtime.sessions;
  const kai = sessions.create({ title: "KAI alpha" });
  sessions.recordTurn({ sessionId: kai.id, role: "user", text: "the falcon at 100%" });
  const persona = sessions.create({ title: "scout talk", agentId: "kai:scout" });

  // GET /sessions/search — literal LIKE, through the wrapper.
  const search = await call(api, "GET", "/sessions/search", { query: { query: "falcon" } });
  assert.equal(search.status, 200, JSON.stringify(search.body));
  const hits = (search.body as { hits: Array<{ session: { id: string } }> }).hits;
  assert.ok(hits.some((hit) => hit.session.id === kai.id));
  const pct = await call(api, "GET", "/sessions/search", { query: { query: "%" } });
  assert.equal(pct.status, 200);
  assert.deepEqual(
    (pct.body as { hits: Array<{ session: { id: string } }> }).hits.map((hit) => hit.session.id),
    [kai.id],
    "a search for % matches only the literal percent sign",
  );
  const emptySearch = await call(api, "GET", "/sessions/search", { query: { query: "   " } });
  assert.equal(emptySearch.status, 400);

  // GET /sessions/:id/view — the durable view: history + memory scope.
  const view = await call(api, "GET", `/sessions/${kai.id}/view`);
  assert.equal(view.status, 200);
  const viewBody = view.body as {
    session: { sessionId: string; history: unknown[]; memoryScope: { scope: string; scopeId: string } };
  };
  assert.equal(viewBody.session.sessionId, kai.id);
  assert.equal(viewBody.session.history.length, 1);
  assert.deepEqual(viewBody.session.memoryScope, { scope: "session", scopeId: kai.id });
  const missingView = await call(api, "GET", "/sessions/sess_nope/view");
  assert.equal(missingView.status, 404);

  // GET /sessions/:id/transcript — kind-checked, owner-checked.
  const t1 = await call(api, "GET", `/sessions/${kai.id}/transcript`);
  assert.equal(t1.status, 200);
  assert.equal((t1.body as { transcript: { kind: string } }).transcript.kind, "kai-conversation");
  const cross = await call(api, "GET", `/sessions/${persona.id}/transcript`);
  assert.equal(cross.status, 403, "the default kind must refuse a persona's conversation");
  const sub = await call(api, "GET", `/sessions/${persona.id}/transcript`, {
    query: { kind: "subagent-conversation", owner: "kai:scout" },
  });
  assert.equal(sub.status, 200, JSON.stringify(sub.body));
  assert.equal((sub.body as { transcript: { owner: string } }).transcript.owner, "kai:scout");
  const subWrongOwner = await call(api, "GET", `/sessions/${persona.id}/transcript`, {
    query: { kind: "subagent-conversation", owner: "kai:other" },
  });
  assert.equal(subWrongOwner.status, 403);
  const subNoOwner = await call(api, "GET", `/sessions/${persona.id}/transcript`, {
    query: { kind: "subagent-conversation" },
  });
  assert.equal(subNoOwner.status, 400, "an owner-checked read without an owner is refused");
  const worker = await call(api, "GET", `/sessions/${kai.id}/transcript`, { query: { kind: "worker-execution" } });
  assert.equal(worker.status, 501, "the worker transcript is not wired, and says so");
  assert.equal((worker.body as { notWired: boolean }).notWired, true);
  const badKind = await call(api, "GET", `/sessions/${kai.id}/transcript`, { query: { kind: "bogus" } });
  assert.equal(badKind.status, 400);
  const noSession = await call(api, "GET", "/sessions/sess_nope/transcript");
  assert.equal(noSession.status, 404);

  // FALLTHROUGH: the pre-existing routes still answer through the wrapper.
  const list = await call(api, "GET", "/sessions");
  assert.equal(list.status, 200);
  assert.ok((list.body as { sessions: Array<{ id: string }> }).sessions.some((s) => s.id === kai.id));
  const one = await call(api, "GET", `/sessions/${kai.id}`);
  assert.equal(one.status, 200);
  const active = await call(api, "GET", "/sessions/active");
  assert.equal(active.status, 200, "the literal /sessions/active route still wins over /sessions/:id");
});

// ── parks, decisions, auto-reissue ────────────────────────────────────────────

test("session.duplicate parks (WRITE) and an APPROVED verdict auto-reissues it — the copy keeps no worker conversation id", async (t) => {
  const dir = tempDir();
  const runtime = boot(join(dir, "kai.db"));
  t.after(() => cleanup(dir, runtime));
  const api = createCoreApi(runtime);
  registerSessionRoutes(api, { runtime });

  const sessions = runtime.sessions;
  const a = sessions.create({ title: "APPLE" });
  sessions.recordTurn({ sessionId: a.id, role: "user", text: "hello" });
  sessions.recordTurn({ sessionId: a.id, role: "assistant", text: "hi" });
  assert.equal(sessions.bindWorker(a.id, "hermes", "worker-conv-a").ok, true);

  const parked = await call(api, "POST", `/sessions/${a.id}/duplicate`, { body: {} });
  assert.equal(parked.status, 409, JSON.stringify(parked.body));
  const parkedBody = parked.body as { approvalRequired: boolean; approvalId: string | null };
  assert.equal(parkedBody.approvalRequired, true);
  assert.ok(typeof parkedBody.approvalId === "string" && parkedBody.approvalId.length > 0);
  // Nothing ran while parked.
  assert.equal(
    sessions.list({ limit: 100, includeArchived: true }).filter((s) => s.title === "APPLE (copy)").length,
    0,
  );

  const decided = await runtime.decideApproval(parkedBody.approvalId as string, true);
  assert.equal(decided.reissued, true, JSON.stringify(decided));
  assert.equal((decided.result as { ok?: boolean }).ok, true, "the re-issued call executed");

  const copies = sessions.list({ limit: 100, includeArchived: true }).filter((s) => s.title === "APPLE (copy)");
  assert.equal(copies.length, 1, "the approved duplicate actually ran");
  const copy = copies[0]!;
  assert.equal(sessions.get(copy.id)?.agentSessionId, undefined, "the copy did NOT inherit the worker conversation");
  assert.equal(sessions.get(a.id)?.agentSessionId, "worker-conv-a", "the source keeps its binding");
  const copyTurns = sessions.turns(copy.id);
  assert.equal(copyTurns.ok ? copyTurns.value.length : -1, 2, "the turns were copied");
});

test("session.close parks; REJECT runs nothing; APPROVE closes the conversation and moves the pointer", async (t) => {
  const dir = tempDir();
  const runtime = boot(join(dir, "kai.db"));
  t.after(() => cleanup(dir, runtime));
  const api = createCoreApi(runtime);
  registerSessionRoutes(api, { runtime });

  const sessions = runtime.sessions;
  const a = sessions.create({ title: "close me" });
  assert.equal(sessions.activate(a.id).ok, true);
  assert.equal(sessions.active()?.id, a.id);

  const parked = await call(api, "POST", `/sessions/${a.id}/close`, { body: {} });
  assert.equal(parked.status, 409, JSON.stringify(parked.body));
  const approvalId = (parked.body as { approvalId: string }).approvalId;

  const rejected = await runtime.decideApproval(approvalId, false);
  assert.equal(rejected.reissued, false, "a rejection runs nothing");
  assert.equal(sessions.get(a.id)?.status, "ACTIVE", "state is unchanged after a rejection");
  assert.equal(sessions.active()?.id, a.id, "the pointer did not move");

  const parked2 = await call(api, "POST", `/sessions/${a.id}/close`, { body: {} });
  assert.equal(parked2.status, 409);
  const approvalId2 = (parked2.body as { approvalId: string }).approvalId;
  assert.notEqual(approvalId2, approvalId, "each attempt parks a fresh approval");

  const approved = await runtime.decideApproval(approvalId2, true);
  assert.equal(approved.reissued, true, JSON.stringify(approved));
  assert.equal(sessions.get(a.id)?.status, "ARCHIVED");
  assert.equal(sessions.active(), null, "the active pointer moved off the closed conversation");

  // A fresh attempt (no approval in hand) parks AGAIN with a NEW id — the
  // surface never silently re-uses the spent approval.
  const parked3 = await call(api, "POST", `/sessions/${a.id}/close`, { body: {} });
  assert.equal(parked3.status, 409, JSON.stringify(parked3.body));
  assert.notEqual((parked3.body as { approvalId: string }).approvalId, approvalId2);
});

test("session.clear and session.delete are DESTRUCTIVE: they park, and an approved verdict executes them", async (t) => {
  const dir = tempDir();
  const runtime = boot(join(dir, "kai.db"));
  t.after(() => cleanup(dir, runtime));
  const api = createCoreApi(runtime);
  registerSessionRoutes(api, { runtime });

  const sessions = runtime.sessions;
  const a = sessions.create({ title: "to clear" });
  sessions.recordTurn({ sessionId: a.id, role: "user", text: "one" });
  sessions.recordTurn({ sessionId: a.id, role: "assistant", text: "two" });
  assert.equal(sessions.activate(a.id).ok, true);

  const parkedClear = await call(api, "POST", `/sessions/${a.id}/clear`, { body: {} });
  assert.equal(parkedClear.status, 409, JSON.stringify(parkedClear.body));
  const clearId = (parkedClear.body as { approvalId: string }).approvalId;
  assert.equal(sessions.get(a.id)?.turnCount, 2, "nothing ran while parked");

  const cleared = await runtime.decideApproval(clearId, true);
  assert.equal(cleared.reissued, true);
  assert.equal(sessions.get(a.id)?.turnCount, 0, "the approved clear ran");
  const afterClear = sessions.turns(a.id);
  assert.equal(afterClear.ok ? afterClear.value.length : -1, 0);

  const parkedDelete = await call(api, "POST", `/sessions/${a.id}/delete`, { body: {} });
  assert.equal(parkedDelete.status, 409, JSON.stringify(parkedDelete.body));
  const deleteId = (parkedDelete.body as { approvalId: string }).approvalId;
  assert.ok(sessions.get(a.id), "nothing ran while parked");

  const deleted = await runtime.decideApproval(deleteId, true);
  assert.equal(deleted.reissued, true);
  assert.equal(sessions.get(a.id), null, "the approved delete removed the session");
  assert.equal(sessions.active(), null, "the active pointer was repaired by the delete");
});

// ── idempotency, direct execution under an allow policy, refusal mapping ──────

test("registration is idempotent; an allow policy executes directly; refusals map to their HTTP shapes", async (t) => {
  const dir = tempDir();
  const runtime = boot(join(dir, "kai.db"), {
    policyRules: [
      {
        id: "test-allow-session-write",
        risk: "WRITE",
        outcome: "allow",
        tools: ["session.duplicate", "session.close", "session.clear", "session.delete"],
      },
      {
        id: "test-allow-session-destructive",
        risk: "DESTRUCTIVE",
        outcome: "allow",
        tools: ["session.clear", "session.delete"],
      },
    ],
  });
  t.after(() => cleanup(dir, runtime));
  const api = createCoreApi(runtime);

  const first = registerSessionRoutes(api, { runtime });
  assert.equal(first.tools.registered.length, 5);
  const second = registerSessionRoutes(api, { runtime });
  assert.deepEqual(second.tools.registered, [], "a second wiring registers nothing new");
  assert.equal(second.tools.skipped.length, 5, "it reports what it skipped instead of throwing");

  // Still serving after the second call: the wrapper was not double-wrapped and
  // the original handle is still reachable beneath it.
  const list = await call(api, "GET", "/sessions");
  assert.equal(list.status, 200);

  const sessions = runtime.sessions;
  const a = sessions.create({ title: "direct" });
  sessions.recordTurn({ sessionId: a.id, role: "user", text: "x" });

  // The policy ALLOWS these tools: the route executes directly (no park).
  const closed = await call(api, "POST", `/sessions/${a.id}/close`, { body: {} });
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  assert.equal((closed.body as { session: { status: string } }).session.status, "ARCHIVED");

  const dup = await call(api, "POST", `/sessions/${a.id}/duplicate`, { body: { title: "forked" } });
  assert.equal(dup.status, 201, JSON.stringify(dup.body));
  const dupSessionId = (dup.body as { session: { sessionId: string } }).session.sessionId;
  assert.equal(sessions.get(dupSessionId)?.title, "forked", "the fork carries the requested title");

  // A service refusal (unknown id) is a VALUE from the executed tool, mapped to
  // its HTTP shape — 404, not a fake success.
  const unknown = await call(api, "POST", "/sessions/sess_nope/close", { body: {} });
  assert.equal(unknown.status, 404, JSON.stringify(unknown.body));

  // Request-shape refusals never reach the boundary.
  const badBody = await call(api, "POST", `/sessions/${a.id}/close`, { body: "nope" });
  assert.equal(badBody.status, 400);
  const badTitle = await call(api, "POST", `/sessions/${a.id}/close`, { body: { title: "x" } });
  assert.equal(badTitle.status, 400, "close does not accept a title");
  const badApproval = await call(api, "POST", `/sessions/${a.id}/close`, { body: { approvalId: 123 } });
  assert.equal(badApproval.status, 400, "a present-but-wrong approvalId is refused, not ignored");
});
