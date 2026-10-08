// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Session lifecycle — the store/service rules, INCLUDING the old-schema
 * migration a real user's database takes on its first open.
 *
 * The migration fixture is the point of this file: a database written BEFORE
 * the session architecture work has no `agentOwner` / `worker` / `missionId`
 * columns. `createSessionStore` must open it (the index DDL once ran before
 * `migrate()` added `missionId`, so every open of an old file threw "no such
 * column: missionId"), split the overloaded legacy `agentId` into
 * agentOwner/worker, and leave the file usable — idempotently, so a restart
 * changes nothing a second time. That path is exercised HERE, not only in a
 * throwaway probe.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSessionStore } from "../src/sessions/store.ts";
import { createSessionService } from "../src/sessions/service.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "kai-session-lifecycle-"));
}

/**
 * Build the OLD schema by hand: exactly what a database written before the
 * session architecture work looks like — no agentOwner / worker / missionId
 * columns, the overloaded `agentId` carrying both meanings.
 */
function seedOldSchema(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL,
      createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, lastTurnAt TEXT,
      turnCount INTEGER NOT NULL DEFAULT 0, agentId TEXT, agentSessionId TEXT, metadata TEXT
    );
    CREATE TABLE session_turns (
      id TEXT PRIMARY KEY, sessionId TEXT NOT NULL, role TEXT NOT NULL,
      text TEXT NOT NULL, at TEXT NOT NULL, agentId TEXT, rowid_seq INTEGER
    );
    CREATE TABLE session_state ("key" TEXT PRIMARY KEY, value TEXT, updatedAt TEXT NOT NULL);
  `);
  db.prepare(
    `INSERT INTO sessions (id, title, status, createdAt, updatedAt, lastTurnAt, turnCount, agentId, agentSessionId, metadata)
     VALUES (?, ?, 'ACTIVE', ?, ?, NULL, 0, ?, NULL, NULL)`,
  ).run("sess_old_kai", "old kai", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "kai:scout");
  db.prepare(
    `INSERT INTO sessions (id, title, status, createdAt, updatedAt, lastTurnAt, turnCount, agentId, agentSessionId, metadata)
     VALUES (?, ?, 'ACTIVE', ?, ?, NULL, 0, ?, ?, NULL)`,
  ).run(
    "sess_old_worker",
    "old worker",
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:00:00.000Z",
    "hermes",
    "worker-conv-1",
  );
  db.prepare(
    `INSERT INTO session_turns (id, sessionId, role, text, at, agentId, rowid_seq)
     VALUES ('turn_old_1', 'sess_old_worker', 'user', 'the falcon flies at 100%', '2026-01-01T00:01:00.000Z', NULL, NULL)`,
  ).run();
  db.close();
}

test("an old-schema database opens, migrates and backfills — the exact path a user's real file takes", () => {
  const dir = tempDir();
  const path = join(dir, "kai-sessions.db");
  try {
    seedOldSchema(path);

    // Opening the OLD file must not throw. It did once: `idx_sessions_mission`
    // was created before `migrate()` added the `missionId` column, so the whole
    // open failed with "no such column: missionId".
    const store = createSessionStore({ path });
    const kai = store.get("sess_old_kai");
    const worker = store.get("sess_old_worker");
    assert.ok(kai, "the legacy KAI row survives the migration");
    assert.ok(worker, "the legacy worker row survives the migration");

    // The overloaded agentId is SPLIT: persona -> agentOwner, worker -> worker.
    assert.equal(kai.agentOwner, "kai:scout");
    assert.equal(kai.worker, undefined);
    assert.equal(worker.worker, "hermes");
    assert.equal(worker.agentOwner, undefined);
    assert.equal(worker.agentSessionId, "worker-conv-1", "the worker conversation binding survives");

    // The new surface works on the migrated file, which is what proves the
    // columns (and the indexes over them) exist.
    assert.equal(store.findByWorkerSessionId("worker-conv-1")?.id, "sess_old_worker");
    assert.equal(store.countTurns("sess_old_worker"), 1);
    const bound = store.update("sess_old_worker", { missionId: "mission_old_1" });
    assert.equal(bound?.missionId, "mission_old_1");
    assert.equal(store.findByMissionId("mission_old_1")?.id, "sess_old_worker");

    // Escaped LIKE: "%" finds the literal percent sign in the old turn text,
    // not every row.
    assert.deepEqual(
      store.search("%").map((hit) => hit.session.id),
      ["sess_old_worker"],
      "a search for % matches only the literal percent sign",
    );

    // Re-open: the migration is idempotent — a restart changes nothing again.
    store.close();
    const store2 = createSessionStore({ path });
    assert.equal(store2.get("sess_old_kai")?.agentOwner, "kai:scout");
    assert.equal(store2.get("sess_old_worker")?.worker, "hermes");
    assert.equal(store2.get("sess_old_worker")?.missionId, "mission_old_1");
    store2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("clear resets counters, delete repairs the active pointer, and a failed transaction rolls back", () => {
  const dir = tempDir();
  try {
    const store = createSessionStore({ path: join(dir, "s.db") });
    const session = store.create({ id: "sess_a", title: "a" });
    store.appendTurn({ id: "t1", sessionId: session.id, role: "user", text: "one", at: "2026-01-01T00:00:00.000Z" });
    store.appendTurn({
      id: "t2",
      sessionId: session.id,
      role: "assistant",
      text: "two",
      at: "2026-01-01T00:01:00.000Z",
    });
    assert.equal(store.countTurns(session.id), 2);

    assert.equal(store.clearTurns(session.id), 2);
    assert.equal(store.countTurns(session.id), 0);
    const after = store.get(session.id);
    assert.equal(after?.turnCount, 0, "the cached counter is reset in the same transaction as the delete");
    assert.equal(after?.lastTurnAt, undefined, "the last-turn stamp is cleared too");

    store.setActiveSessionId(session.id);
    assert.equal(store.delete(session.id), true);
    assert.equal(store.get(session.id), null, "the session row is gone");
    assert.equal(store.activeSessionId(), null, "the active pointer is repaired, not left dangling");

    // A transaction that throws rolls back every write it made.
    assert.throws(() => {
      store.transaction(() => {
        store.create({ id: "sess_tx", title: "tx" });
        throw new Error("boom");
      });
    }, /boom/);
    assert.equal(store.get("sess_tx"), null, "the rolled-back row is not there");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("close(id) closes a conversation; close() shuts the store — one name, both overloads", () => {
  const dir = tempDir();
  try {
    const store = createSessionStore({ path: join(dir, "s.db") });
    const service = createSessionService({ store });
    const a = service.create({ title: "a" });
    assert.equal(service.activate(a.id).ok, true);
    assert.equal(service.active()?.id, a.id);

    // close(id): the conversation lifecycle operation.
    const closed = service.close(a.id);
    assert.equal(closed.ok, true, JSON.stringify(closed));
    assert.equal(closed.ok ? closed.value.status : "", "ARCHIVED");
    assert.equal(service.active(), null, "the active pointer moved off the closed conversation");

    const missing = service.close("sess_nope");
    assert.equal(missing.ok, false);
    assert.equal(missing.ok === false ? missing.code : "", "NOT_FOUND");

    // close(): the STORE shutdown (runtime.ts `stop`), not a conversation close.
    service.close();
    let threw = false;
    try {
      service.get(a.id);
    } catch {
      threw = true;
    }
    assert.equal(threw, true, "close() shut the store down");
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("duplicate forks the conversation but NOT the worker binding (per-session worker isolation)", () => {
  const dir = tempDir();
  try {
    const store = createSessionStore({ path: join(dir, "s.db") });
    const service = createSessionService({ store });
    const a = service.create({ title: "APPLE" });
    service.recordTurn({ sessionId: a.id, role: "user", text: "hello" });
    service.recordTurn({ sessionId: a.id, role: "assistant", text: "hi" });
    assert.equal(service.bindWorker(a.id, "hermes", "worker-conv-a").ok, true);
    assert.equal(service.bindMission(a.id, "mission_1").ok, true);

    const dup = service.duplicate(a.id);
    assert.equal(dup.ok, true, JSON.stringify(dup));
    assert.ok(dup.ok);
    const copy = dup.value;
    assert.notEqual(copy.sessionId, a.id, "the copy is a new session");
    assert.equal(copy.status, "ACTIVE");
    assert.equal(copy.worker, "hermes", "the worker identity carries over");
    assert.equal(copy.missionId, "mission_1", "the mission binding carries over");
    assert.equal(copy.agentOwner, undefined, "KAI's own conversation stays KAI's own");

    // THE point: the copy gets its OWN worker conversation on its first turn.
    // Copying agentSessionId would make two KAI sessions claim ONE worker
    // conversation — the exact collapse per-session worker isolation forbids.
    assert.equal(
      service.get(copy.sessionId)?.agentSessionId,
      undefined,
      "agentSessionId is deliberately NOT copied",
    );
    assert.equal(service.get(a.id)?.agentSessionId, "worker-conv-a", "the source keeps its binding");

    // The recorded turns are copied with FRESH ids: a fork reads like the same
    // conversation, but the rows are new.
    const copyTurns = service.turns(copy.sessionId);
    assert.deepEqual(
      copyTurns.ok ? copyTurns.value.map((t) => `${t.role}:${t.text}`) : [],
      ["user:hello", "assistant:hi"],
    );
    const sourceTurns = service.turns(a.id);
    const sourceIds = new Set(sourceTurns.ok ? sourceTurns.value.map((t) => t.id) : []);
    for (const turn of copyTurns.ok ? copyTurns.value : []) {
      assert.ok(!sourceIds.has(turn.id), "copied turns get fresh ids");
    }
    assert.equal(service.get(copy.sessionId)?.title, "APPLE (copy)", "the default title marks the fork");

    // A persona's own conversation duplicates too — owner rides along, worker
    // conversation id still deliberately not copied.
    const persona = service.create({ title: "scout talk", agentId: "kai:scout" });
    store.update(persona.id, { agentSessionId: "worker-conv-scout" });
    const dupPersona = service.duplicate(persona.id);
    assert.equal(dupPersona.ok, true, JSON.stringify(dupPersona));
    assert.equal(dupPersona.ok ? dupPersona.value.agentOwner : "", "kai:scout");
    assert.equal(
      service.get(dupPersona.ok ? dupPersona.value.sessionId : "")?.agentSessionId,
      undefined,
      "a persona copy also starts without a worker conversation id",
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
