// Regression: sending a prompt must NOT throw the person back to the greeting /
// Home surface, and the conversation must survive a message, a tool call and an
// approval, and be restored on reload.
//
//   cd app && node --test tests/presence-conversation.test.ts
//
// The bug was not a route change (a previous stream proved there is no hash
// router, no location mutation and no reset-on-error on the send path). It was the
// chat SURFACE: `presence.ts` removed the `.talking` class 600ms after every turn,
// and the stylesheet shows the greeting hero and hides the thread without it. So
// the moment the reply arrived the conversation vanished and the greeting came
// back — "sending a prompt sends me back to Home".
//
// `conversationVisible` is the one decision that drives that class. These tests
// pin its invariant at the level the bug actually lived, and read the real
// `presence.ts` to prove the class is now COMPUTED from it rather than added and
// blindly removed by hand.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { conversationVisible } from "../src/shell/presence/conversation.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const presence = readFileSync(join(ROOT, "src", "shell", "presence", "presence.ts"), "utf8");

test("a just-finished turn keeps the conversation on screen (the eject-to-Home regression)", () => {
  // The exact state after `POST /chat` resolves: the reply is in `turns`, the
  // turn is no longer busy. Before the fix this state hid the thread and showed
  // the greeting hero again.
  assert.equal(conversationVisible({ turns: 2, busy: false }), true);
});

test("a live turn is shown even before the first reply lands", () => {
  // `runTurn` adds the user bubble and starts waiting: turns >= 1 and busy.
  assert.equal(conversationVisible({ turns: 1, busy: true }), true);
  // Even the degenerate case — a turn with no turns yet loaded — shows the thread.
  assert.equal(conversationVisible({ turns: 0, busy: true }), true);
});

test("the greeting is shown ONLY with no conversation and no live turn", () => {
  assert.equal(conversationVisible({ turns: 0, busy: false }), false);
});

test("a tool call / approval turn stays in the session through to its result", () => {
  // A turn that parks for approval and then resumes keeps turns > 0 the whole
  // time, so the thread — and the approval card inside it — never disappears.
  const duringToolCall = conversationVisible({ turns: 3, busy: true });
  const awaitingApproval = conversationVisible({ turns: 3, busy: false });
  const afterResult = conversationVisible({ turns: 4, busy: false });
  assert.deepEqual([duringToolCall, awaitingApproval, afterResult], [true, true, true]);
});

test("a reloaded session with history starts on the conversation, not the greeting", () => {
  // On reload `refreshActive()` loads the active session's turns; the surface is
  // computed from them, so the person is returned to the conversation they left.
  assert.equal(conversationVisible({ turns: 324, busy: false }), true);
});

test("presence.ts computes the chat surface from `conversationVisible`", () => {
  assert.match(presence, /conversationVisible\s*\(/, "the surface decision must come from the tested module");
  assert.match(presence, /function refreshChatSurface\s*\(/, "the class must be recomputed, never blindly toggled");
});

test("presence.ts no longer removes `.talking` after a turn (the root cause)", () => {
  assert.doesNotMatch(
    presence,
    /classList\.remove\(\s*["']talking["']\s*\)/,
    "an unconditional removal of `.talking` on turn completion is the bug",
  );
});
