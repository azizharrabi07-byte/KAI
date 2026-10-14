// Regression: the `/` palette must never overwrite an argument the person typed.
//
//   cd app && node --test tests/slash-args.test.ts
//
// The defect: accepting a palette row writes the row's template over the composer.
// While the person types `/work Fix the broken login test`, the palette matches the
// command exactly, `argSuggestions` has no list for a FREE-form argument, and it
// falls back to a row whose apply text is the bare `/work `. Pressing Enter clicked
// that row and submitted it, so KAI received `/work` with an empty payload and the
// task was gone. The mouse path did the same on click.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { hasTypedArgs, splitComposer } from "../src/shell/presence/slash-args.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const presence = readFileSync(join(ROOT, "src", "shell", "presence", "presence.ts"), "utf8");

test("the command name is split from the argument exactly as typed", () => {
  assert.deepEqual(splitComposer("/work"), { name: "work", args: "" });
  assert.deepEqual(splitComposer("/work Fix the broken login test"), {
    name: "work",
    args: "Fix the broken login test",
  });
});

test("a free-form argument is recognised as TYPED, so the palette must not overwrite it", () => {
  // The reported case. Before the fix this was treated as "completing the command
  // name", which is what replaced the payload with the template.
  assert.equal(hasTypedArgs("/work Fix the broken login test"), true);
  assert.equal(hasTypedArgs("/audit pasted report text"), true);
});

test("a bare command, or one with only a trailing space, is NOT treated as having arguments", () => {
  // These are the only states in which completing to `/work ` is safe.
  assert.equal(hasTypedArgs("/work"), false);
  assert.equal(hasTypedArgs("/work "), false);
  assert.equal(hasTypedArgs("/work\t"), false);
});

test("the argument keeps its punctuation, paths and spacing", () => {
  const split = splitComposer("/work fix src/api/routes.ts:671, then run `npm test`");
  assert.equal(split?.name, "work");
  assert.equal(split?.args, "fix src/api/routes.ts:671, then run `npm test`");
  // Multi-line pastes survive: only the boundary between name and argument is trimmed.
  assert.equal(hasTypedArgs("/work line one\nline two"), true);
});

test("a non-command line has no command to complete", () => {
  assert.equal(splitComposer("just talking about /work"), null);
  assert.equal(hasTypedArgs("just talking about /work"), false);
});

test("presence.ts delegates the decision instead of re-deriving it inline", () => {
  // The bug lived in presence.ts's inline regex. It now calls the tested rule, so
  // the two cannot drift apart.
  assert.match(presence, /const hasArgs = hasTypedArgs\(chatInput\.value\);/);
  assert.doesNotMatch(
    presence,
    /const typed = \/\^\\\/\(\[\\w-\]\*\)\(\.\*\)\$\//,
    "the inline argument regex must not come back",
  );
});
