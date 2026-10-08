// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The session transcript router — the anti-collapse rules.
 *
 * Three kinds of transcript exist (KAI's own conversation, a persona's own
 * conversation, the worker's execution transcript) and the router is the guard
 * that they never merge: a read naming a kind the session does not have is
 * refused (CROSS_KIND), a subagent read is owner-checked, and the worker
 * transcript says NOT_WIRED because no reader exists yet.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSessionStore } from "../src/sessions/store.ts";
import { createSessionService } from "../src/sessions/service.ts";
import {
  TRANSCRIPT_KINDS,
  classifySession,
  createSessionTranscriptRouter,
} from "../src/sessions/router.ts";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "kai-session-router-"));
  const store = createSessionStore({ path: join(dir, "s.db") });
  const sessions = createSessionService({ store });
  const router = createSessionTranscriptRouter({ sessions });
  const kai = sessions.create({ title: "KAI talk" });
  sessions.recordTurn({ sessionId: kai.id, role: "user", text: "hello kai" });
  sessions.recordTurn({ sessionId: kai.id, role: "assistant", text: "hello person" });
  const persona = sessions.create({ title: "scout talk", agentId: "kai:scout" });
  sessions.recordTurn({ sessionId: persona.id, role: "user", text: "scout, look" });
  sessions.recordTurn({ sessionId: persona.id, role: "assistant", text: "scouting" });
  return { dir, store, sessions, router, kai, persona };
}

function cleanup(dir: string, store: ReturnType<typeof createSessionStore>): void {
  store.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

test("classification: a session with an owner is a subagent conversation, without one it is KAI's own", () => {
  const { dir, store, router, kai, persona } = setup();
  try {
    assert.deepEqual([...TRANSCRIPT_KINDS], ["kai-conversation", "subagent-conversation", "worker-execution"]);
    assert.equal(classifySession(kai), "kai-conversation");
    assert.equal(classifySession(persona), "subagent-conversation");
    assert.equal(router.classify(kai), "kai-conversation");
    assert.equal(router.classify(persona), "subagent-conversation");
  } finally {
    cleanup(dir, store);
  }
});

test("KAI's own conversation reads as kai-conversation: turns, memory scope, no owner", () => {
  const { dir, store, router, kai } = setup();
  try {
    const out = router.read({ sessionId: kai.id });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.ok(out.ok);
    assert.equal(out.transcript.kind, "kai-conversation");
    assert.equal(out.transcript.owner, undefined, "a KAI conversation has no persona owner");
    assert.equal(out.transcript.status, "ACTIVE");
    assert.deepEqual(
      out.transcript.turns.map((t) => `${t.role}:${t.text}`),
      ["user:hello kai", "assistant:hello person"],
      "turns come back in reading order",
    );
    assert.deepEqual(out.transcript.memoryScope, { scope: "session", scopeId: kai.id });
    // The explicit kind is accepted too.
    const explicit = router.read({ sessionId: kai.id, kind: "kai-conversation" });
    assert.equal(explicit.ok, true);
    // A limit bounds the read.
    const limited = router.read({ sessionId: kai.id, limit: 1 });
    assert.equal(limited.ok, true);
    assert.equal(limited.ok ? limited.transcript.turns.length : -1, 1);
  } finally {
    cleanup(dir, store);
  }
});

test("cross-kind reads are REFUSED, both directions — a persona's conversation never merges into KAI's", () => {
  const { dir, store, router, kai, persona } = setup();
  try {
    // A persona's own conversation read as KAI's own: refused.
    const personaAsKai = router.read({ sessionId: persona.id, kind: "kai-conversation" });
    assert.equal(personaAsKai.ok, false);
    assert.equal(personaAsKai.ok === false ? personaAsKai.code : "", "CROSS_KIND");
    // And by DEFAULT (no kind stated) — the safe default refuses, never serves.
    const personaDefault = router.read({ sessionId: persona.id });
    assert.equal(personaDefault.ok, false);
    assert.equal(personaDefault.ok === false ? personaDefault.code : "", "CROSS_KIND");

    // KAI's own conversation read as a subagent's: refused.
    const kaiAsSubagent = router.read({
      sessionId: kai.id,
      kind: "subagent-conversation",
      owner: "kai:scout",
    });
    assert.equal(kaiAsSubagent.ok, false);
    assert.equal(kaiAsSubagent.ok === false ? kaiAsSubagent.code : "", "CROSS_KIND");
  } finally {
    cleanup(dir, store);
  }
});

test("a subagent read is OWNER-CHECKED: matching owner serves, mismatch refuses, no owner is refused", () => {
  const { dir, store, router, persona } = setup();
  try {
    const good = router.read({ sessionId: persona.id, kind: "subagent-conversation", owner: "kai:scout" });
    assert.equal(good.ok, true, JSON.stringify(good));
    assert.ok(good.ok);
    assert.equal(good.transcript.kind, "subagent-conversation");
    assert.equal(good.transcript.owner, "kai:scout");
    assert.deepEqual(
      good.transcript.turns.map((t) => `${t.role}:${t.text}`),
      ["user:scout, look", "assistant:scouting"],
    );

    const wrongOwner = router.read({ sessionId: persona.id, kind: "subagent-conversation", owner: "kai:other" });
    assert.equal(wrongOwner.ok, false);
    assert.equal(wrongOwner.ok === false ? wrongOwner.code : "", "CROSS_KIND");

    // Omitting the owner must NOT open the conversation: the read is checked by
    // construction, so an unchecked request is refused, not served.
    const noOwner = router.read({ sessionId: persona.id, kind: "subagent-conversation" });
    assert.equal(noOwner.ok, false);
    assert.equal(noOwner.ok === false ? noOwner.code : "", "VALIDATION_FAILED");

    // A KAI conversation read WITH a claimed owner is an owner mismatch too.
    const claimed = router.read({ sessionId: persona.id, kind: "kai-conversation", owner: "kai:scout" });
    assert.equal(claimed.ok, false);
    assert.equal(claimed.ok === false ? claimed.code : "", "CROSS_KIND");
  } finally {
    cleanup(dir, store);
  }
});

test("the worker's execution transcript is NOT_WIRED — a refusal, never a borrowed or empty transcript", () => {
  const { dir, store, router, kai } = setup();
  try {
    const out = router.read({ sessionId: kai.id, kind: "worker-execution" });
    assert.equal(out.ok, false);
    assert.equal(out.ok === false ? out.code : "", "NOT_WIRED");
    assert.ok(out.ok === false && out.reason.includes("not wired"), out.ok === false ? out.reason : "");
    // Subject-independent: the reader does not exist for ANY subject, so even an
    // unknown id gets NOT_WIRED rather than NOT_FOUND (nothing was looked up).
    const unknown = router.read({ sessionId: "sess_missing", kind: "worker-execution" });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.ok === false ? unknown.code : "", "NOT_WIRED");
  } finally {
    cleanup(dir, store);
  }
});

test("unknown sessions are NOT_FOUND; a malformed request is VALIDATION_FAILED; an archived read still works", () => {
  const { dir, store, router, sessions, kai } = setup();
  try {
    const missing = router.read({ sessionId: "sess_missing" });
    assert.equal(missing.ok, false);
    assert.equal(missing.ok === false ? missing.code : "", "NOT_FOUND");

    const emptyId = router.read({ sessionId: "" });
    assert.equal(emptyId.ok, false);
    assert.equal(emptyId.ok === false ? emptyId.code : "", "VALIDATION_FAILED");

    const badKind = router.read({ sessionId: kai.id, kind: "bogus" as never });
    assert.equal(badKind.ok, false);
    assert.equal(badKind.ok === false ? badKind.code : "", "VALIDATION_FAILED");

    const badLimit = router.read({ sessionId: kai.id, limit: 0 });
    assert.equal(badLimit.ok, false);
    assert.equal(badLimit.ok === false ? badLimit.code : "", "VALIDATION_FAILED");

    // A closed conversation is still a RECORD: its transcript stays readable.
    assert.equal(sessions.close(kai.id).ok, true);
    const archived = router.read({ sessionId: kai.id });
    assert.equal(archived.ok, true);
    assert.equal(archived.ok ? archived.transcript.status : "", "ARCHIVED");
  } finally {
    cleanup(dir, store);
  }
});
