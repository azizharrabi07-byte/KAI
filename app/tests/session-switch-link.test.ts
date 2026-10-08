// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The link's session switch, in isolation and deterministically.
 *
 * The live bug: in the real UI, clicking a session's "Use" left the rendered
 * conversation on the OLD session (two sessions with EQUAL turn counts were the
 * defeating case). This drives `createCoreLink().refresh()` with a fake Core whose
 * active pointer is moved exactly the way `POST /sessions/:id/activate` moves it,
 * and asserts the ACTIVE session's OWN turns become the chat history. If this
 * passes, the load path is sound and the defect is in what triggers it; if it
 * fails, the defect is here.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createCoreLink } from "../src/core/core-boot.ts";
import { State } from "../src/core/state.ts";
import type { CoreClient, CoreResult, CoreSessionTurn } from "../src/core/kai-core.ts";
import type { CoreEventStream } from "../src/core/core-events.ts";

const TURNS: Record<string, CoreSessionTurn[]> = {
  a: [
    { id: "a1", role: "user", text: "APPLE", at: "2026-01-01T00:00:00Z" },
    { id: "a2", role: "assistant", text: "A-OK", at: "2026-01-01T00:00:01Z" },
  ],
  b: [
    { id: "b1", role: "user", text: "BANANA", at: "2026-01-01T00:00:00Z" },
    { id: "b2", role: "assistant", text: "B-OK", at: "2026-01-01T00:00:01Z" },
  ],
  c: [
    { id: "c1", role: "user", text: "ORANGE", at: "2026-01-01T00:00:00Z" },
    { id: "c2", role: "assistant", text: "C-OK", at: "2026-01-01T00:00:01Z" },
  ],
};

/** A Core whose active pointer can be moved, as the activate route moves it. */
function fakeCore(): { client: CoreClient; activate: (id: string) => void; turnReads: string[] } {
  let active = "a";
  const rows = ["a", "b", "c"].map((id) => ({ id, title: id.toUpperCase(), status: "ACTIVE", active: false }));
  const turnReads: string[] = [];
  const ok = <T,>(value: T): CoreResult<T> => ({ ok: true, value });
  const client = {
    baseUrl: "http://127.0.0.1:8788",
    async state() {
      return ok({ agents: [] });
    },
    async missions() {
      return ok([]);
    },
    async notifications() {
      return ok([]);
    },
    async approvals() {
      return ok([]);
    },
    async sessions() {
      return ok({
        sessions: rows.map((r) => ({ ...r, active: r.id === active })),
        activeSessionId: active,
      });
    },
    async sessionTurns(id: string) {
      turnReads.push(id);
      return ok(TURNS[id] ?? []);
    },
    async subagents() {
      // boot also reads KAI's personas; none here, and this suite is about the
      // session switch, so the list is empty rather than absent.
      return ok([]);
    },
  } as unknown as CoreClient;
  return { client, activate: (id: string) => (active = id), turnReads };
}

const onlineStream = { state: "ONLINE", connect() {}, disconnect() {} } as unknown as CoreEventStream;

test("switching to a session with EQUAL turn count loads THAT session's turns", async () => {
  const core = fakeCore();
  const link = createCoreLink({ client: core.client, stream: onlineStream, reconcileMs: 0 });

  // First snapshot: session A is active, so A's turns become the history.
  await link.refresh();
  assert.deepEqual(
    State.chatHistory.map((m) => m.content),
    ["APPLE", "A-OK"],
    "the first snapshot loads the active session's own turns",
  );

  // The user clicks "Use" on B — same shape as the activate route moving the pointer.
  core.activate("b");
  await link.refresh();
  assert.deepEqual(
    State.chatHistory.map((m) => m.content),
    ["BANANA", "B-OK"],
    "switching to B (equal turn count) loads B's turns, not A's",
  );

  // And back — the A/B/A toggle that the live test used.
  core.activate("a");
  await link.refresh();
  assert.deepEqual(
    State.chatHistory.map((m) => m.content),
    ["APPLE", "A-OK"],
    "switching back to A restores A's turns",
  );

  // The link must have asked Core for each session's turns, keyed by the id.
  assert.deepEqual(core.turnReads, ["a", "b", "a"], "turns were read per switched session");
});

test("a re-render is triggered when the history array is replaced", async () => {
  const core = fakeCore();
  const link = createCoreLink({ client: core.client, stream: onlineStream, reconcileMs: 0 });
  await link.refresh();
  const before = State.chatHistory;
  core.activate("c");
  await link.refresh();
  const after = State.chatHistory;
  assert.notEqual(before, after, "a switch yields a NEW array, not the same one mutated");
  assert.deepEqual(after.map((m) => m.content), ["ORANGE", "C-OK"]);
});
