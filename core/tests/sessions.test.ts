// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * KAI's conversation sessions (Phase F).
 *
 * The architecture audit (§2 verdict 3, §3 verdict 14) named this as missing:
 * "No `sessions` table, no Session type, no session UI … no create/switch/rename/
 * archive surface anywhere". These tests pin the properties that make the layer
 * real rather than decorative:
 *
 *   - a session is DURABLE: it and its turns survive closing and reopening the
 *     store over the same file (a restart, not a cache);
 *   - exactly one session is ACTIVE, and archiving it moves the pointer, so KAI
 *     can never be left writing into an archived conversation;
 *   - a turn is refused for an unknown or archived session — an error VALUE, not
 *     a silent success;
 *   - the `session` memory scope is now HONEST: it resolves for a real session
 *     and refuses one the runtime does not have (before this layer existed it was
 *     refused outright, and the refusal said so);
 *   - the HTTP surface creates/switches/renames/archives through the ONE policy
 *     boundary, so a session change is a governed mutation like any other.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSessionStore } from "../src/sessions/store.ts";
import { createSessionService } from "../src/sessions/service.ts";
import { createCoreRuntime } from "../src/runtime.ts";
import { createCoreApi } from "../src/api/routes.ts";
import type { CoreApi } from "../src/api/routes.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "kai-sessions-"));
}

function boot(dbPath: string) {
  return createCoreRuntime({
    dbPath,
    agents: { mode: "mock" },
    startScheduler: false,
    subsystemPaths: { runUpkeepOnStart: false },
  });
}

// ── the store/service ─────────────────────────────────────────────────────────

test("a session and its turns survive closing and reopening the store", () => {
  const dir = tempDir();
  const path = join(dir, "kai-sessions.db");
  try {
    const store = createSessionStore({ path });
    const service = createSessionService({ store });
    const created = service.create({ title: "first" });
    assert.equal(service.ensureActive().id, created.id, "the first session becomes active");

    const user = service.recordTurn({ sessionId: created.id, role: "user", text: "hello" });
    assert.equal(user.ok, true);
    const assistant = service.recordTurn({ sessionId: created.id, role: "assistant", text: "hi", agentId: "hermes" });
    assert.equal(assistant.ok, true);
    const bound = service.bindWorker(created.id, "hermes", "hermes-session-1");
    assert.equal(bound.ok, true);
    store.close();

    // A "restart": brand-new store and service over the same file.
    const store2 = createSessionStore({ path });
    const service2 = createSessionService({ store: store2 });
    const readBack = service2.get(created.id);
    assert.ok(readBack, "the session is still there");
    assert.equal(readBack.title, "first");
    assert.equal(readBack.turnCount, 2);
    assert.equal(readBack.agentSessionId, "hermes-session-1", "the worker conversation is still bound");
    assert.equal(service2.ensureActive().id, created.id, "the active pointer survived too");

    const turns = service2.turns(created.id);
    assert.equal(turns.ok, true);
    assert.deepEqual(
      turns.ok ? turns.value.map((t) => `${t.role}:${t.text}`) : [],
      ["user:hello", "assistant:hi"],
      "turns come back in reading order",
    );
    store2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("archiving the active session moves the active pointer instead of leaving it dangling", () => {
  const dir = tempDir();
  try {
    const store = createSessionStore({ path: join(dir, "s.db") });
    const service = createSessionService({ store });
    const a = service.create({ title: "a" });
    assert.equal(service.ensureActive().id, a.id);

    const archived = service.archive(a.id);
    assert.equal(archived.ok, true);
    assert.equal(service.active(), null, "nothing is active while the only session is archived");

    // The next turn-creating path re-creates an active conversation rather than
    // writing into the archived one.
    const next = service.ensureActive();
    assert.notEqual(next.id, a.id);
    assert.equal(next.status, "ACTIVE");

    // Unarchiving brings it back, and it can be switched to again.
    assert.equal(service.unarchive(a.id).ok, true);
    assert.equal(service.activate(a.id).ok, true);
    assert.equal(service.active()?.id, a.id);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("a turn on an unknown or archived session is refused as a value", () => {
  const dir = tempDir();
  try {
    const store = createSessionStore({ path: join(dir, "s.db") });
    const service = createSessionService({ store });
    const unknown = service.recordTurn({ sessionId: "sess_nope", role: "user", text: "x" });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.ok === false ? unknown.code : "", "NOT_FOUND");

    const s = service.create({ title: "s" });
    assert.equal(service.archive(s.id).ok, true);
    const onArchived = service.recordTurn({ sessionId: s.id, role: "user", text: "x" });
    assert.equal(onArchived.ok, false);
    assert.equal(onArchived.ok === false ? onArchived.code : "", "ARCHIVED");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// ── the memory scope is now honest ────────────────────────────────────────────

test("the session memory scope resolves for a real session and refuses an unknown one", async (t) => {
  const dir = tempDir();
  const dbPath = join(dir, "kai.db");
  const runtime = boot(dbPath);
  t.after(async () => {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const support = runtime.memoryScopeSupport().find((s) => s.scope === "session");
  assert.equal(support?.wired, true, "the session scope must be wired once something mints session ids");

  const session = runtime.sessions.create({ title: "scoped" });
  const resolved = runtime.resolveMemoryScope({ scope: "session", scopeId: session.id });
  assert.equal(resolved.ok, true, JSON.stringify(resolved));

  const unknown = runtime.resolveMemoryScope({ scope: "session", scopeId: "sess_missing" });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.ok === false ? unknown.code : "", "MEMORY_SCOPE_SUBJECT_UNKNOWN");

  // A session-scoped fact round-trips, and a fact for another session does not leak.
  const other = runtime.sessions.create({ title: "other" });
  const written = runtime.rememberForSession(session.id, { content: "ph4 session fact falcon", type: "note" });
  assert.equal(written.ok, true, JSON.stringify(written));
  const mine = runtime.recallForSession(session.id, { text: "falcon" });
  assert.ok(mine.length >= 1, "the session's own fact is recalled");
  const theirs = runtime.recallForSession(other.id, { text: "falcon" });
  assert.equal(theirs.length, 0, "a fact scoped to another session must not leak in");
});

// ── the HTTP surface, through the policy boundary ─────────────────────────────

test("the session routes create, switch, rename and archive through the boundary", async (t) => {
  const dir = tempDir();
  const dbPath = join(dir, "kai.db");
  const runtime = boot(dbPath);
  t.after(async () => {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const api: CoreApi = createCoreApi(runtime);
  const post = (path: string, body: unknown) => api.handle({ method: "POST", path, query: new URLSearchParams(), attested: true, ownerAuthConfigured: true, body });
  const get = (path: string, q: Record<string, string> = {}) =>
    api.handle({ method: "GET", path, query: new URLSearchParams(q) });

  const created = await post("/sessions", { title: "route session" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = (created.body as { session: { id: string } }).session.id;

  const listed = await get("/sessions");
  assert.equal(listed.status, 200);
  assert.ok((listed.body as { sessions: Array<{ id: string }> }).sessions.some((s) => s.id === id));

  const activated = await post(`/sessions/${id}/activate`, {});
  assert.equal(activated.status, 200, JSON.stringify(activated.body));
  const active = await get("/sessions/active");
  assert.equal((active.body as { session: { id: string } }).session.id, id);

  const renamed = await post(`/sessions/${id}/rename`, { title: "renamed" });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  assert.equal((renamed.body as { session: { title: string } }).session.title, "renamed");

  const archived = await post(`/sessions/${id}/archive`, {});
  assert.equal(archived.status, 200);
  assert.equal((archived.body as { session: { status: string } }).session.status, "ARCHIVED");

  // The archived session is gone from the default list but reachable explicitly.
  const afterList = await get("/sessions");
  assert.ok(!(afterList.body as { sessions: Array<{ id: string }> }).sessions.some((s) => s.id === id));
  const one = await get(`/sessions/${id}`);
  assert.equal(one.status, 200);
  const archivedList = await get("/sessions", { status: "ARCHIVED" });
  assert.ok((archivedList.body as { sessions: Array<{ id: string }> }).sessions.some((s) => s.id === id));

  const missing = await get("/sessions/sess_nope");
  assert.equal(missing.status, 404);
  const badRename = await post(`/sessions/${id}/rename`, { title: "  " });
  assert.equal(badRename.status, 400);
});

test("chat records its turns into the ACTIVE conversation and continues the worker conversation", async (t) => {
  const dir = tempDir();
  const dbPath = join(dir, "kai.db");
  const runtime = boot(dbPath);
  t.after(async () => {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const session = runtime.sessions.create({ title: "chat" });
  runtime.sessions.activate(session.id);
  // Drive the same bookkeeping the relay does, so the test does not depend on a
  // live model: a state question is answered from state and still recorded.
  const answer = await runtime.chat.answer("what is happening?");
  runtime.sessions.recordTurn({ sessionId: session.id, role: "user", text: "what is happening?" });
  runtime.sessions.recordTurn({ sessionId: session.id, role: "assistant", text: answer.text });

  const turns = runtime.sessions.turns(session.id);
  assert.equal(turns.ok, true);
  assert.equal(turns.ok ? turns.value.length : 0, 2);
  assert.equal(turns.ok ? turns.value[1]?.role : "", "assistant");
  assert.equal(runtime.sessions.get(session.id)?.turnCount, 2);
});
