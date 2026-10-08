// Reducer tests for the sessions slice (`src/core/core-state.ts`): the Core
// snapshot must fill it, an absent field must not clear it, and a `null` active
// pointer must be honoured. Plus the forward-compatible event mapping.
//
//   cd app && node --test "tests/core-state-sessions.test.ts"
//
// The reducer is pure, so no Core, no socket, no DOM.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyCoreEvent,
  applySnapshot,
  initialCoreSlice,
  summarizeEvent,
  type CoreSessionRow,
  type CoreSlice,
} from "../src/core/core-state.ts";

const row = (id: string, over: Partial<CoreSessionRow> = {}): CoreSessionRow => ({
  id,
  title: id,
  status: "ACTIVE",
  active: false,
  ...over,
});

test("a fresh slice has no sessions and no active pointer", () => {
  const s = initialCoreSlice();
  assert.deepEqual(s.sessions, []);
  assert.equal(s.activeSessionId, null);
});

test("a snapshot fills the sessions list and the active pointer", () => {
  const s = applySnapshot(initialCoreSlice(), {
    sessions: [row("sess_a", { active: true, turnCount: 3 }), row("sess_b")],
    activeSessionId: "sess_a",
    now: 1_700_000_000_000,
  });
  assert.equal(s.sessions.length, 2);
  assert.equal(s.sessions[0]?.id, "sess_a");
  assert.equal(s.sessions[0]?.active, true);
  assert.equal(s.sessions[1]?.id, "sess_b");
  assert.equal(s.activeSessionId, "sess_a");
  assert.equal(s.conn, "ONLINE");
});

test("an absent sessions field leaves the previous list in place", () => {
  const withSessions = applySnapshot(initialCoreSlice(), {
    sessions: [row("sess_a", { active: true })],
    activeSessionId: "sess_a",
  });
  // A snapshot that only carries agents (e.g. sessions call failed) must not blank
  // the list — one failing call must not wipe the others.
  const after = applySnapshot(withSessions, { agents: [{ id: "hermes", state: "idle" }] });
  assert.equal(after.sessions.length, 1);
  assert.equal(after.activeSessionId, "sess_a", "an absent pointer keeps the previous one");
});

test("a null active pointer is a real value and is honoured", () => {
  const withSessions = applySnapshot(initialCoreSlice(), {
    sessions: [row("sess_a", { active: true })],
    activeSessionId: "sess_a",
  });
  // Archived the active session: Core reports null, and the slice must reflect it
  // rather than keeping the stale pointer.
  const after = applySnapshot(withSessions, { sessions: [row("sess_a", { status: "ARCHIVED" })], activeSessionId: null });
  assert.equal(after.activeSessionId, null);
  assert.equal(after.sessions[0]?.status, "ARCHIVED");
});

test("a session.created event upserts a row", () => {
  let s: CoreSlice = initialCoreSlice();
  s = applyCoreEvent(s, {
    id: "ev-1",
    type: "session.created",
    timestamp: "2026-10-03T10:00:00.000Z",
    payload: { id: "sess_a", title: "First", status: "ACTIVE" },
  });
  assert.equal(s.sessions.length, 1);
  assert.equal(s.sessions[0]?.title, "First");
  assert.equal(s.sessions[0]?.status, "ACTIVE");
  assert.equal(s.sessions[0]?.updatedAt, "2026-10-03T10:00:00.000Z");

  // A later update to the same session replaces the row, never duplicates it.
  s = applyCoreEvent(s, { id: "ev-2", type: "session.renamed", payload: { id: "sess_a", title: "Second" } });
  assert.equal(s.sessions.length, 1);
  assert.equal(s.sessions[0]?.title, "Second");
});

test("session.activated moves the pointer and un-marks the others", () => {
  let s = applySnapshot(initialCoreSlice(), {
    sessions: [row("sess_a", { active: true }), row("sess_b")],
    activeSessionId: "sess_a",
  });
  s = applyCoreEvent(s, { id: "ev", type: "session.activated", payload: { id: "sess_b" } });
  assert.equal(s.activeSessionId, "sess_b");
  assert.equal(s.sessions.find((x) => x.id === "sess_b")?.active, true);
  assert.equal(s.sessions.find((x) => x.id === "sess_a")?.active, false);
});

test("archiving the active session clears the pointer", () => {
  let s = applySnapshot(initialCoreSlice(), {
    sessions: [row("sess_a", { active: true })],
    activeSessionId: "sess_a",
  });
  s = applyCoreEvent(s, { id: "ev", type: "session.archived", payload: { id: "sess_a" } });
  assert.equal(s.sessions[0]?.status, "ARCHIVED");
  assert.equal(s.sessions[0]?.active, false);
  assert.equal(s.activeSessionId, null, "the pointer must never aim at an archived conversation");

  s = applyCoreEvent(s, { id: "ev2", type: "session.unarchived", payload: { id: "sess_a" } });
  assert.equal(s.sessions[0]?.status, "ACTIVE");
});

test("hostile session payloads cannot crash the reducer", () => {
  const bad: unknown[] = [undefined, null, 42, "text", [], {}, { id: 7 }];
  const types = ["session.created", "session.activated", "session.archived", "session.unarchived"];
  for (const payload of bad) {
    for (const type of types) {
      const s = applyCoreEvent(initialCoreSlice(), { id: "e", type, payload });
      assert.ok(Array.isArray(s.sessions));
      assert.ok(s.activeSessionId === null || typeof s.activeSessionId === "string");
    }
  }
  assert.equal(summarizeEvent("session.activated"), "Switched session");
  assert.equal(summarizeEvent("session.created", { title: "First" }), "Session created: First");
});
