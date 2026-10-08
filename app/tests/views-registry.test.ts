// The island's view registry must stay honest with the type that describes it.
//
//   cd app && node --test tests/views-registry.test.ts
//
// Why this reads source instead of building the views: `buildViews` constructs real
// DOM elements, and this suite deliberately runs with no DOM at all (no jsdom, no
// WebView, no Core). The invariant it protects is structural — every view the type
// system declares is registered exactly once, and no placeholder view is registered —
// so reading the two files that declare and register them is the honest way to assert
// it here, rather than reaching for a DOM the suite does not have.
//
// Each view's *behaviour* is covered live against the packaged app over CDP; see
// docs/evidence/ui-views-live.txt and docs/evidence/ui-view-*.png.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LAYOUT_SRC = readFileSync(join(ROOT, "src", "core", "layout.ts"), "utf8");
const VIEWS_SRC = readFileSync(join(ROOT, "src", "views", "views.ts"), "utf8");
const HOOKS_SRC = readFileSync(join(ROOT, "src", "island", "hooks.ts"), "utf8");

/** Members of `export type IslandViewName = … ;`. */
function declaredViewNames(): string[] {
  const block = /export type IslandViewName =([\s\S]*?);/.exec(LAYOUT_SRC);
  assert.ok(block, "IslandViewName must be declared in src/core/layout.ts");
  return [...block[1].matchAll(/"([a-zA-Z]+)"/g)].map((m) => m[1]);
}

/** `map.set("<name>", …)` calls inside buildViews. */
function registeredViewNames(): string[] {
  return [...VIEWS_SRC.matchAll(/map\.set\(\s*"([a-zA-Z]+)"/g)].map((m) => m[1]);
}

/**
 * Declared views that buildViews must NOT register, each with the reason.
 *
 * `greeting` is drawn by its own canvas (`Island.greetingCanvas`, synced in
 * `syncDom` from `State.view === "greeting"`), so it has a layout and a state but
 * deliberately no card in the view map. Anything added here has to earn it.
 */
const NOT_A_CARD_VIEW = new Set(["greeting"]);

test("every view the type declares is registered, exactly once", () => {
  const declared = declaredViewNames();
  const registered = registeredViewNames();
  const expected = declared.filter((n) => !NOT_A_CARD_VIEW.has(n));

  assert.ok(declared.length >= 14, `expected the full view set, got ${declared.length}`);
  const missing = expected.filter((n) => !registered.includes(n));
  const extra = registered.filter((n) => !declared.includes(n));
  assert.deepEqual(missing, [], `declared but never rendered: ${missing.join(", ")}`);
  assert.deepEqual(extra, [], `registered but not a declared view: ${extra.join(", ")}`);

  const counts = new Map<string, number>();
  for (const n of registered) counts.set(n, (counts.get(n) ?? 0) + 1);
  const duplicated = [...counts.entries()].filter(([, c]) => c > 1).map(([n]) => n);
  assert.deepEqual(duplicated, [], `registered more than once: ${duplicated.join(", ")}`);
});

test("the three macOS-port placeholders are gone, not stubbed", () => {
  // `mail`, `searching` and `result` shipped from the upstream Windows tree as
  // `buildPlaceholder` cards that no code path ever switched to. They were removed
  // with the capability reported as unavailable; this fails if any of them returns
  // as a registered placeholder rather than a real view.
  const declared = declaredViewNames();
  const registered = registeredViewNames();
  for (const gone of ["mail", "searching", "result"]) {
    assert.ok(!declared.includes(gone), `"${gone}" is still a declared view`);
    assert.ok(!registered.includes(gone), `"${gone}" is still registered`);
  }
  assert.ok(!/function buildPlaceholder/.test(VIEWS_SRC), "buildPlaceholder is back");
  assert.ok(!/isn't in this version|not implemented/i.test(VIEWS_SRC), "placeholder copy is back");
});

test("the question view has a producer, not just a renderer", () => {
  // The view existed and was unreachable: the hook moved the task's state to
  // "question" and nothing ever switched the view, so Claude Code's question was
  // never shown. Any of the three ways to surface a view counts as a producer.
  const producers = [
    /surface\(\s*"question"/,
    /island\.alert\(\s*"question"/,
    /island\.setView\(\s*"question"/,
  ];
  assert.ok(
    producers.some((re) => re.test(HOOKS_SRC)),
    "src/island/hooks.ts no longer switches to the question view",
  );
});

test("a failed turn is KAI's own message, kept out of the Core's note slot", () => {
  // The live defect this pins: with the Core stopped, a chat turn's honest
  // "I can't reach my Core right now…" was written to `State.noteMessage` — the
  // slot the Core link OWNS, rewrites on every connection-state change and clears
  // on reconnect. So the message was replaced by a generic connection line and
  // then blanked, and the note view rendered an empty card. The invariant: the
  // failed-turn message lives in KAI's own slot, the note view renders it ahead of
  // the Core note, and the chat view writes it there.
  const STATE_SRC = readFileSync(join(ROOT, "src", "core", "state.ts"), "utf8");
  const CHAT_SRC = readFileSync(join(ROOT, "src", "views", "chat.ts"), "utf8");
  assert.ok(
    /turnError:\s*string \| null/.test(STATE_SRC),
    "State no longer declares a dedicated `turnError` slot",
  );
  assert.ok(
    /State\.turnError\s*=/.test(CHAT_SRC),
    "src/views/chat.ts no longer records a failed turn in State.turnError",
  );
  assert.ok(
    /title\.textContent\s*=\s*State\.turnError \?\? State\.noteMessage/.test(VIEWS_SRC),
    "the note view does not render State.turnError ahead of State.noteMessage",
  );
});
