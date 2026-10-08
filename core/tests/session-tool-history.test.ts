// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * P1 SESSIONS + P0-H4 tool-call transcript persistence.
 *
 * Every test below runs against the REAL session store (SQLite, temp file) and
 * the REAL service — reopening the store on the same file is what "reload"
 * means here. A second open must see the same ids, titles, summaries,
 * transcripts and tool records.
 *
 * Covered:
 *   1-4.   create / persist / rename / delete+archive (+active reconciliation)
 *   5-7.   search by title / summary / transcript
 *   8-9.   summary persistence / reload-resume
 *   10-12. same session after tool execution / tool error / approval park
 *   13-14. switching / reconciliation after delete
 *   15.    tool-call transcript persistence (reload, duplicate, clear)
 *   16.    agent-session identity isolation groundwork
 *   titles: placeholder → derived once → manual rename authoritative
 *
 * Run from `core/`:  node --test tests/session-tool-history.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createSessionStore } from "../src/sessions/store.ts";
import {
  buildSessionSummary,
  createSessionService,
  deriveTitle,
  isPlaceholderTitle,
} from "../src/sessions/service.ts";

/** Stores opened per temp dir, closed before the dir is removed (one hook). */
const closersByDir = new Map<string, Array<() => void>>();

function tempDb(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), "kai-sessions-"));
  closersByDir.set(dir, []);
  t.after(() => {
    for (const close of closersByDir.get(dir) ?? []) {
      try {
        close();
      } catch {
        // A store that is already closed is fine.
      }
    }
    closersByDir.delete(dir);
    rmSync(dir, { recursive: true, force: true });
  });
  return join(dir, "kai-sessions.db");
}

/**
 * A fresh service on `path`; call twice on one path to simulate a reload.
 * The store is closed by the temp-dir hook BEFORE removal — an open SQLite
 * handle locks the file on Windows.
 */
function serviceOn(t: { after: (fn: () => void) => void }, path: string) {
  const svc = createSessionService({ store: createSessionStore({ path }) });
  closersByDir.get(dirname(path))?.push(() => svc.close());
  return svc;
}

function toolRecord(toolCallId: string, toolName = "filesystem_search", status = "EXECUTED") {
  return {
    toolCallId,
    toolName,
    // The canonical registry id — the transcript keeps both the wire spelling
    // the model echoed and the dotted identity it resolved to.
    toolId: toolName.replace(/_/g, "."),
    arguments: JSON.stringify({ query: "lighthouse" }),
    invocationId: `act_${toolCallId}`,
    status,
    result: { root: "/tmp/x", matches: [{ path: "/tmp/x/notes.txt", kind: "content", line: 2 }] },
    startedAt: "2026-10-05T00:00:00.000Z",
    completedAt: "2026-10-05T00:00:01.000Z",
  };
}

// ── 1-3. create / persist / rename ────────────────────────────────────────────

test("1+2. create persists a stable session that survives a reopen", (t) => {
  const path = tempDb(t);
  const first = serviceOn(t, path);
  const created = first.create({ title: "Restaurant QR SaaS Architecture" });
  assert.ok(created.id.startsWith("sess_"), "KAI-owned id namespace");
  assert.equal(created.title, "Restaurant QR SaaS Architecture");
  assert.equal(created.sessionKind, "kai-conversation");
  assert.equal(first.active()?.id, created.id, "first KAI session becomes active");

  const reloaded = serviceOn(t, path);
  const again = reloaded.get(created.id);
  assert.ok(again !== null);
  assert.equal(again.title, "Restaurant QR SaaS Architecture");
  assert.equal(reloaded.active()?.id, created.id, "the active pointer survives reload");
});

test("3. rename updates persistent state immediately and survives reload", (t) => {
  const path = tempDb(t);
  const svc = serviceOn(t, path);
  const created = svc.create({ title: "Conversation 1" });
  const renamed = svc.rename(created.id, "Fixing KAI Tool Calling");
  assert.equal(renamed.ok, true);
  assert.equal(renamed.ok && renamed.value.title, "Fixing KAI Tool Calling");

  const reloaded = serviceOn(t, path);
  assert.equal(reloaded.get(created.id)?.title, "Fixing KAI Tool Calling");

  const empty = svc.rename(created.id, "   ");
  assert.equal(empty.ok, false, "an empty rename is refused, not stored");
  assert.equal(svc.get(created.id)?.title, "Fixing KAI Tool Calling");
});

// ── 4. delete / archive ───────────────────────────────────────────────────────

test("4. archive hides from the active list; delete hard-removes turns and tools", (t) => {
  const path = tempDb(t);
  const svc = serviceOn(t, path);
  const a = svc.create({ title: "A" });
  const b = svc.create({ title: "B" });
  void b;
  assert.equal(svc.archive(a.id).ok, true);
  assert.ok(!svc.list().some((s) => s.id === a.id), "archived is out of the default list");
  assert.ok(svc.list({ includeArchived: true }).some((s) => s.id === a.id), "…but still listed opt-in");

  const turn = svc.recordTurn({ sessionId: a.id, role: "user", text: "hi" });
  assert.equal(turn.ok, false, "an archived session refuses new turns");

  const c = svc.create({ title: "C" });
  svc.recordTurn({ sessionId: c.id, role: "user", text: "hello" });
  const asst = svc.recordTurn({ sessionId: c.id, role: "assistant", text: "hi" });
  assert.ok(asst.ok);
  if (asst.ok) {
    assert.ok(svc.recordToolCalls(c.id, asst.value.id, [toolRecord("call_1")]).ok);
  }
  assert.equal(svc.delete(c.id).ok, true);
  assert.equal(svc.get(c.id), null, "gone from the active list");
  assert.equal(svc.turns(c.id).ok, false, "turns are gone with it");
  assert.equal(svc.toolCalls(c.id).ok, false, "tool history is gone with it");
});

// ── 5-7. search ───────────────────────────────────────────────────────────────

test("5+6+7. search finds by title, by summary digest, and by transcript text", (t) => {
  const path = tempDb(t);
  const svc = serviceOn(t, path);
  const s = svc.create({ title: "Physics — Forces Exercise" });
  svc.recordTurn({ sessionId: s.id, role: "user", text: "a block slides down a frictionless incline" });
  svc.recordTurn({ sessionId: s.id, role: "assistant", text: "use F = ma along the slope" });
  svc.recordTurn({ sessionId: s.id, role: "assistant", text: "shall we try another one?" });

  const byTitle = svc.search("Forces Exercise");
  assert.equal(byTitle.ok && byTitle.value.length, 1);
  assert.equal(byTitle.ok && byTitle.value[0]?.matched, "title");

  // The objective (first user line) lives in the persisted summary digest.
  const bySummary = svc.search("frictionless incline");
  assert.ok(bySummary.ok && bySummary.value.length >= 1, "summary/turn text is searchable");

  // "F = ma" sits in a MIDDLE turn only — neither title, summary objective nor
  // the last assistant line — so the hit must surface as a turn match.
  const byTranscript = svc.search("F = ma");
  assert.ok(byTranscript.ok && byTranscript.value.some((hit) => hit.session.id === s.id));
  assert.equal(byTranscript.ok && byTranscript.value.find((hit) => hit.session.id === s.id)?.matched, "turn");

  const missing = svc.search("zyxwv-no-such-text");
  assert.ok(missing.ok && missing.value.length === 0);
});

// ── 8-9. summary + reload/resume ─────────────────────────────────────────────

test("8. the summary is extractive, persisted, and survives reload", (t) => {
  const path = tempDb(t);
  const svc = serviceOn(t, path);
  const s = svc.create({ title: "Conversation 1" });
  svc.recordTurn({ sessionId: s.id, role: "user", text: "Search my files for lighthouse" });
  const asst = svc.recordTurn({ sessionId: s.id, role: "assistant", text: "Found it in notes.txt." });
  assert.ok(asst.ok);
  if (asst.ok) svc.recordToolCalls(s.id, asst.value.id, [toolRecord("call_1")]);

  const summarized = svc.summarize(s.id);
  assert.ok(summarized.ok);
  if (summarized.ok) {
    assert.ok(summarized.value.objective.includes("lighthouse"), `objective: ${summarized.value.objective}`);
    assert.deepEqual(summarized.value.toolsUsed, ["filesystem.search"], "the digest names the canonical id, not the wire spelling");
    assert.deepEqual(summarized.value.toolStats, { total: 1, executed: 1 });
    assert.ok(summarized.value.lastAssistantLine.includes("notes.txt"));
    assert.ok(summarized.value.builtAt.length > 0);
    assert.equal(summarized.value.narrative, undefined, "no narrative is invented");
  }

  const reloaded = serviceOn(t, path);
  const view = reloaded.record(s.id);
  assert.ok(view.ok);
  assert.ok(view.ok && view.value.summary !== undefined, "the digest is on the reloaded record");
  assert.ok(view.ok && view.value.summary?.objective.includes("lighthouse"));
});

test("9. reload resumes the same session: id, title, transcript, tools, pointer", (t) => {
  const path = tempDb(t);
  const svc = serviceOn(t, path);
  const s = svc.create({ title: "Resume Me" });
  svc.recordTurn({ sessionId: s.id, role: "user", text: "remember the lighthouse" });
  const asst = svc.recordTurn({ sessionId: s.id, role: "assistant", text: "noted" });
  if (asst.ok) svc.recordToolCalls(s.id, asst.value.id, [toolRecord("call_9")]);

  const reloaded = serviceOn(t, path);
  const resumed = reloaded.resume();
  assert.ok(resumed.ok);
  if (resumed.ok) {
    assert.equal(resumed.value.sessionId, s.id, "same session id");
    assert.equal(resumed.value.history.length, 2, "transcript restored");
    assert.equal(resumed.value.history[1]?.tools?.length, 1, "tool record restored");
    assert.equal(resumed.value.history[1]?.tools?.[0]?.toolName, "filesystem_search");
    assert.equal(resumed.value.history[1]?.tools?.[0]?.toolId, "filesystem.search", "canonical id survives reload");
    assert.equal(reloaded.active()?.id, s.id, "still the active conversation");
  }
});

// ── 10-12. session stability across tool outcomes ─────────────────────────────

test("10. the same session survives a tool execution (no redirect, no new session)", (t) => {
  const path = tempDb(t);
  const svc = serviceOn(t, path);
  const s = svc.create({ title: "Tool Session" });
  const before = svc.active()?.id;
  const asst = svc.recordTurn({ sessionId: s.id, role: "assistant", text: "searched" });
  assert.ok(asst.ok);
  if (asst.ok) {
    const recorded = svc.recordToolCalls(s.id, asst.value.id, [toolRecord("call_e")]);
    assert.ok(recorded.ok);
    assert.equal(recorded.value[0]?.status, "EXECUTED");
  }
  assert.equal(svc.active()?.id, before, "active session unchanged by a tool execution");
  assert.equal(svc.get(s.id)?.turnCount, 1);
});

test("11. the same session survives a tool ERROR", (t) => {
  const path = tempDb(t);
  const svc = serviceOn(t, path);
  const s = svc.create({ title: "Error Session" });
  const asst = svc.recordTurn({ sessionId: s.id, role: "assistant", text: "that path is outside my sandbox" });
  assert.ok(asst.ok);
  if (asst.ok) {
    const recorded = svc.recordToolCalls(s.id, asst.value.id, [
      { ...toolRecord("call_f"), status: "FAILED", result: { error: "INTERNAL", message: "boom" } },
    ]);
    assert.ok(recorded.ok, "a failed call is a persisted VALUE, not a lost turn");
  }
  assert.equal(svc.active()?.id, s.id);
  const history = svc.history(s.id);
  assert.ok(history.ok && history.value[0]?.tools?.[0]?.status === "FAILED");
});

test("12. the same session survives an approval park, with the approval id kept", (t) => {
  const path = tempDb(t);
  const svc = serviceOn(t, path);
  const s = svc.create({ title: "Approval Session" });
  const asst = svc.recordTurn({ sessionId: s.id, role: "assistant", text: "that needs your approval" });
  assert.ok(asst.ok);
  if (asst.ok) {
    const parked = svc.recordToolCalls(s.id, asst.value.id, [
      {
        ...toolRecord("call_p", "filesystem_write", "APPROVAL_REQUIRED"),
        approvalId: "apr-1",
        result: { error: "APPROVAL_REQUIRED", message: "parked", approvalRequired: "apr-1" },
      },
    ]);
    assert.ok(parked.ok);
    assert.equal(parked.value[0]?.approvalId, "apr-1", "the park keeps its approval id");
  }
  assert.equal(svc.active()?.id, s.id, "a park never moves the conversation");
});

// ── 13-14. switching + reconciliation ─────────────────────────────────────────

test("13. switching moves the pointer; transcripts stay isolated", (t) => {
  const path = tempDb(t);
  const svc = serviceOn(t, path);
  const a = svc.create({ title: "Alpha" });
  const b = svc.create({ title: "Beta" });
  svc.recordTurn({ sessionId: a.id, role: "user", text: "alpha says hi" });
  svc.recordTurn({ sessionId: b.id, role: "user", text: "beta says ho" });

  assert.equal(svc.switchTo(b.id).ok, true);
  assert.equal(svc.active()?.id, b.id);
  assert.equal(svc.switchTo(a.id).ok, true);
  assert.equal(svc.active()?.id, a.id);

  const ha = svc.history(a.id);
  const hb = svc.history(b.id);
  assert.ok(ha.ok && ha.value.length === 1 && ha.value[0]?.text.includes("alpha"));
  assert.ok(hb.ok && hb.value.length === 1 && hb.value[0]?.text.includes("beta"));

  const persona = svc.create({ title: "Persona Own", agentOwner: "kai:worker-1" });
  assert.equal(svc.switchTo(persona.id).ok, false, "a persona session can never become active");
  assert.equal(svc.active()?.id, a.id);
});

test("14. deleting the active session reconciles onto the newest remaining one", (t) => {
  const path = tempDb(t);
  const svc = serviceOn(t, path);
  const a = svc.create({ title: "First" });
  const b = svc.create({ title: "Second" });
  assert.equal(svc.switchTo(b.id).ok, true);
  assert.equal(svc.delete(b.id).ok, true);
  assert.equal(svc.active()?.id, a.id, "the newest remaining session takes the pointer");
  assert.equal(svc.delete(a.id).ok, true);
  assert.equal(svc.active(), null, "nothing left means no pointer — never a dangling one");
});

// ── 15. tool-call transcript persistence ──────────────────────────────────────

test("15. turns carry their tools; reload keeps them; duplicate copies them; clear drops them", (t) => {
  const path = tempDb(t);
  const svc = serviceOn(t, path);
  const s = svc.create({ title: "Tools Persist" });
  svc.recordTurn({ sessionId: s.id, role: "user", text: "search please" });
  const asst = svc.recordTurn({ sessionId: s.id, role: "assistant", text: "done" });
  assert.ok(asst.ok);
  if (asst.ok) {
    const rec = svc.recordToolCalls(s.id, asst.value.id, [toolRecord("call_1"), toolRecord("call_2")]);
    assert.ok(rec.ok);
  }

  const turns = svc.turns(s.id);
  assert.ok(turns.ok);
  const assistant = turns.ok && turns.value.find((turn) => turn.role === "assistant");
  assert.ok(assistant && assistant.tools?.length === 2, "turns carry their tool calls");
  assert.equal(assistant && assistant.tools?.[0]?.arguments, JSON.stringify({ query: "lighthouse" }), "arguments verbatim");
  assert.ok(
    assistant && Array.isArray((assistant.tools?.[0]?.result as { matches: unknown[] }).matches),
    "result persisted as the model saw it",
  );

  const reloaded = serviceOn(t, path);
  const history = reloaded.history(s.id);
  assert.ok(history.ok && history.value.find((turn) => turn.role === "assistant")?.tools?.length === 2, "reload keeps tool records");

  const copy = reloaded.duplicate(s.id, { title: "Tools Persist (copy)" });
  assert.ok(copy.ok);
  if (copy.ok) {
    const copiedAssistant = copy.value.history.find((turn) => turn.role === "assistant");
    assert.equal(copiedAssistant?.tools?.length, 2, "a fork keeps the tool history");
    assert.notEqual(copiedAssistant?.id, asst.ok && asst.value.id, "…on fresh turn ids");
  }

  const cleared = reloaded.clear(s.id);
  assert.ok(cleared.ok && cleared.value.removed === 2);
  assert.equal(reloaded.toolCalls(s.id).ok && reloaded.toolCalls(s.id).ok && (reloaded.toolCalls(s.id) as { ok: true; value: unknown[] }).value.length, 0, "clear drops tool history with the turns");
});

test("15b. recording tools against a foreign turn or dead session is refused", (t) => {
  const path = tempDb(t);
  const svc = serviceOn(t, path);
  const s = svc.create({ title: "Strict" });
  assert.deepEqual(svc.recordToolCalls("sess_nope", "turn_nope", [toolRecord("c")]).ok, false);
  assert.deepEqual(svc.recordToolCalls(s.id, "turn_nope", [toolRecord("c")]).code, "NOT_FOUND");
  const empty = svc.recordToolCalls(s.id, "turn_nope", []);
  assert.equal(empty.ok, false, "even an empty batch needs a real turn");
});

// ── 16. agent-session isolation ───────────────────────────────────────────────

test("16. agent sessions are kinded, never active, and never merge into KAI history", (t) => {
  const path = tempDb(t);
  const svc = serviceOn(t, path);
  const kai = svc.create({ title: "KAI Chat" });
  const agent = svc.create({ title: "Worker Own", agentId: "kai:researcher", agentOwner: "kai:researcher" });
  assert.equal(agent.sessionKind, "agent-conversation");
  assert.equal(kai.sessionKind, "kai-conversation");
  assert.equal(svc.active()?.id, kai.id, "creating a persona session never steals the pointer");

  svc.recordTurn({ sessionId: agent.id, role: "user", text: "persona note" });
  const kaiHistory = svc.history(kai.id);
  assert.ok(kaiHistory.ok && kaiHistory.value.length === 0, "persona turns never land in KAI history");

  const explicit = svc.create({ title: "Exec", sessionKind: "worker-execution" });
  assert.equal(explicit.sessionKind, "worker-execution", "the kind is settable for future worker transcripts");
});

// ── titles ────────────────────────────────────────────────────────────────────

test("titles: placeholder derives once from the first user message; rename is authoritative", (t) => {
  assert.equal(isPlaceholderTitle("Conversation 12"), true);
  assert.equal(isPlaceholderTitle("Fixing KAI Tool Calling"), false);
  assert.equal(deriveTitle("Search my files for lighthouse keeper notes"), "Search my files for lighthouse keeper notes");
  assert.ok(deriveTitle("please fix the tool calling loop because it is broken and nobody knows why it fails").length <= 68);

  const path = tempDb(t);
  const svc = serviceOn(t, path);
  const s = svc.create({});
  assert.equal(s.title, "Conversation 1");
  svc.recordTurn({ sessionId: s.id, role: "user", text: "design the restaurant QR ordering flow" });
  assert.equal(svc.get(s.id)?.title, "Design the restaurant QR ordering flow", "auto-titled once");

  svc.recordTurn({ sessionId: s.id, role: "user", text: "actually talk about sailing instead" });
  assert.equal(svc.get(s.id)?.title, "Design the restaurant QR ordering flow", "later messages never re-title");

  svc.rename(s.id, "My Boats");
  svc.recordTurn({ sessionId: s.id, role: "user", text: "talk about cooking" });
  assert.equal(svc.get(s.id)?.title, "My Boats", "a human rename is final");

  assert.equal(deriveTitle("Search my files for lighthouse"), deriveTitle("Search my files for lighthouse"), "deterministic");
});

test("buildSessionSummary is extractive: files from tool args/results, no invented narrative", () => {
  const digest = buildSessionSummary(
    [
      { id: "t1", sessionId: "s", role: "user", text: "Find where the lighthouse string lives", at: "2026-10-05T00:00:00.000Z" },
      { id: "t2", sessionId: "s", role: "assistant", text: "It lives in notes.txt.", at: "2026-10-05T00:00:01.000Z" },
    ],
    [
      {
        id: "c1", sessionId: "s", turnId: "t2", toolCallId: "call_1", toolName: "filesystem.search",
        arguments: JSON.stringify({ query: "lighthouse", path: "C:\\work\\notes" }),
        status: "EXECUTED",
        result: { matches: [{ path: "C:\\work\\notes\\a.txt", kind: "content" }] },
        startedAt: "2026-10-05T00:00:00.000Z", completedAt: "2026-10-05T00:00:01.000Z",
      },
    ],
    "2026-10-05T00:00:02.000Z",
  );
  assert.equal(digest.objective, "Find where the lighthouse string lives");
  assert.ok(digest.files.some((f) => f.includes("notes")), `files: ${digest.files.join(",")}`);
  assert.deepEqual(digest.toolsUsed, ["filesystem.search"]);
  assert.equal(digest.narrative, undefined);
});
