// The chat + sessions surfaces: their pure models, and the page factories the
// shell registers.
//
//   cd app && node --test tests/chat-sessions-surface.test.ts
//
// The models (`chat/title.ts`, `chat/sessions-model.ts`) are pure and DOM-free,
// so their behaviour is asserted directly. The two view modules import the
// surface stylesheet, which Node's type-stripping cannot load — so their shape
// (the factories the integrator registers, and the retained island `buildPrompt`)
// is asserted structurally, the same way `views-registry.test.ts` asserts the
// island's view map without a DOM.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  deriveSessionTitle,
  isGenericSessionTitle,
  sessionDisplayTitle,
} from "../src/chat/title.ts";
import { buildSessionViews, summariseSessions, SESSION_SORTS } from "../src/chat/sessions-model.ts";
import type { CoreSessionRow } from "../src/core/core-state.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function row(over: Partial<CoreSessionRow> & { id: string }): CoreSessionRow {
  return { title: "Conversation 1", status: "ACTIVE", active: false, ...over };
}

test("a derived title comes from the first user turn, only for a placeholder", () => {
  assert.equal(isGenericSessionTitle("Conversation 7"), true);
  assert.equal(isGenericSessionTitle("Plan my trip to Kyoto"), false);

  const derived = sessionDisplayTitle("Conversation 7", "hey KAI, can you plan my trip to Kyoto?");
  assert.equal(derived.derived, true);
  assert.equal(derived.title, "KAI, can you plan my trip to Kyoto");

  // A name a person chose is NEVER overwritten by a derivation.
  const kept = sessionDisplayTitle("Kyoto budget", "hey KAI, plan my trip");
  assert.equal(kept.derived, false);
  assert.equal(kept.title, "Kyoto budget");

  // Nothing meaningful to derive: the placeholder is replaced by an honest label.
  assert.equal(sessionDisplayTitle("Conversation 7", "").title, "Conversation 7");
  assert.equal(sessionDisplayTitle("", null).title, "New conversation");
});

test("deriveSessionTitle strips pleasantries and markdown, and caps at a word", () => {
  assert.equal(deriveSessionTitle("- hello, please review this patch"), "Please review this patch");
  const long = deriveSessionTitle("Explain " + "word ".repeat(40));
  assert.ok(long !== null && long.length <= 68, `title too long: ${long}`);
});

test("buildSessionViews hides archived, searches, and keeps the active session first", () => {
  const rows: CoreSessionRow[] = [
    row({ id: "s1", title: "Conversation 1", active: false, updatedAt: "2026-01-01T00:00:00Z", turnCount: 2 }),
    row({ id: "s2", title: "Kyoto budget", active: true, updatedAt: "2026-01-03T00:00:00Z", turnCount: 10 }),
    row({ id: "s3", title: "Old stuff", status: "ARCHIVED", active: false, updatedAt: "2025-12-01T00:00:00Z" }),
  ];
  const firstUser = (id: string): string | undefined => (id === "s1" ? "plan my taxes" : undefined);

  const visible = buildSessionViews(rows, { query: "", sort: "recent", includeArchived: false, firstUserText: firstUser });
  assert.deepEqual(visible.map((v) => v.id), ["s2", "s1"], "archived hidden, active leads");
  assert.equal(visible.find((v) => v.id === "s1")?.title, "Plan my taxes");
  assert.equal(visible.find((v) => v.id === "s1")?.derived, true);

  const withArchived = buildSessionViews(rows, { query: "", sort: "recent", includeArchived: true, firstUserText: firstUser });
  assert.equal(withArchived.length, 3);

  const searched = buildSessionViews(rows, { query: "kyoto", sort: "recent", includeArchived: true });
  assert.deepEqual(searched.map((v) => v.id), ["s2"]);

  const byTurns = buildSessionViews(rows, { query: "", sort: "turns", includeArchived: true });
  // Active still leads; the rest sort by turn count desc.
  assert.equal(byTurns[0]?.id, "s2");
});

test("the sort vocabulary is the four the UI offers", () => {
  assert.deepEqual(SESSION_SORTS.map((s) => s.key), ["recent", "created", "title", "turns"]);
});

test("summariseSessions is honest about the count and the active session", () => {
  const views = buildSessionViews(
    [row({ id: "s1", title: "Kyoto budget", active: true })],
    { query: "", sort: "recent", includeArchived: false },
  );
  assert.equal(summariseSessions(views, 1), "1 session · active: Kyoto budget");
  assert.equal(summariseSessions([], 0), "No sessions yet");
});

test("the two surfaces export the factories the shell registers, and buildPrompt survives", () => {
  const chatSrc = readFileSync(join(ROOT, "src", "views", "chat.ts"), "utf8");
  const sessionsSrc = readFileSync(join(ROOT, "src", "views", "sessions.ts"), "utf8");

  // The island's `buildPrompt` must still exist — `views.ts` imports it.
  assert.ok(/export function buildPrompt\(/.test(chatSrc), "buildPrompt was removed from views/chat.ts");
  // Each surface exports a PageFactory the integrator binds to its route.
  assert.ok(/export const mountChat: PageFactory/.test(chatSrc), "mountChat is not exported");
  assert.ok(/export const mountSessions: PageFactory/.test(sessionsSrc), "mountSessions is not exported");

  // The governed routes are used, not a faked success: sessions goes through
  // session-routes for the destructive delete.
  assert.ok(/createSessionRoutes\(/.test(sessionsSrc), "sessions no longer uses the governed session routes");
  // The chat keeps KAI the speaker by rendering Core's own activity line.
  assert.ok(/chatActivity\(/.test(chatSrc), "chat no longer folds real activity rows");
});
