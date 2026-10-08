// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * P4 — skill runtime metadata: purpose / tools / constraints.
 *
 * A skill declares WHY it exists, which tools it may use and what limits it
 * accepts. Those declarations validate, persist through register AND the
 * approved install pipeline, surface on inspect/relevant, round-trip through
 * render, and score in discovery. Malformed declarations are refused with
 * exact issue classes.
 *
 * Run from `core/`:  node --test tests/skills-runtime.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseSkillMarkdown } from "../src/skills/validate.ts";
import { renderSkillMarkdown } from "../src/skills/render.ts";
import { createSkillRegistry } from "../src/skills/registry.ts";
import { createSkillStore } from "../src/skills/store.ts";

function tempRoot(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), "kai-skills-rt-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const FULL = `---
name: Nightly Verifier
description: Verifies the nightly build and reports breakage.
purpose: Keep the nightly build green without human babysitting.
tools: filesystem.search, filesystem.read, missions.list
constraints: Read-only, never modify files, never approve anything itself
version: 1.2.0
tags: [nightly, build]
---
# Nightly Verifier

1. Search the build logs.
2. Report what broke.
`;

test("purpose/tools/constraints parse, validate and persist through register", (t) => {
  const parsed = parseSkillMarkdown(FULL, { id: "nightly" });
  assert.equal(parsed.ok, true, JSON.stringify(parsed.ok ? {} : parsed.issues).slice(0, 400));
  if (!parsed.ok) return;
  assert.equal(parsed.value.purpose, "Keep the nightly build green without human babysitting.");
  assert.deepEqual(parsed.value.tools, ["filesystem.search", "filesystem.read", "missions.list"]);
  assert.deepEqual(parsed.value.constraints, ["Read-only", "never modify files", "never approve anything itself"]);

  const registry = createSkillRegistry({ store: createSkillStore({ root: join(tempRoot(t), "skills") }) });
  const registered = registry.register({ id: "nightly", markdown: FULL, source: "user" });
  assert.equal(registered.ok, true);
  const inspected = registry.inspect("nightly");
  assert.equal(inspected.ok, true);
  if (!inspected.ok) return;
  assert.equal(inspected.value.purpose, "Keep the nightly build green without human babysitting.");
  assert.deepEqual(inspected.value.tools, ["filesystem.search", "filesystem.read", "missions.list"]);
  assert.deepEqual(inspected.value.constraints, ["Read-only", "never modify files", "never approve anything itself"]);
  assert.equal(inspected.value.version, "1.2.0");
});

test("purpose participates in discovery scoring", (t) => {
  const registry = createSkillRegistry({ store: createSkillStore({ root: join(tempRoot(t), "skills") }) });
  assert.equal(
    registry.register({
      id: "deploy",
      markdown: `---\nname: Deployer\ndescription: Ships things.\npurpose: Deploy the application to staging on every green build.\n---\n\nBody.`,
      source: "user",
    }).ok,
    true,
  );
  assert.equal(
    registry.register({
      id: "grocery",
      markdown: `---\nname: Groceries\ndescription: Manages the shopping list.\n---\n\nBody.`,
      source: "user",
    }).ok,
    true,
  );
  const hits = registry.relevant("staging deploy");
  assert.ok(hits.length >= 1);
  assert.equal(hits[0]?.id, "deploy", "the purpose text scores like the description");
});

test("malformed tool declarations are refused with exact classes", () => {
  const badTool = parseSkillMarkdown(
    `---\nname: X\ndescription: Y\ntools: "good.tool, bad tool!!"\n---\n\nBody.`,
    { id: "x" },
  );
  assert.equal(badTool.ok, false);
  if (badTool.ok) return;
  assert.ok(badTool.issues.some((issue) => issue.code === "INVALID_KEY"), JSON.stringify(badTool.issues));

  const tooMany = parseSkillMarkdown(
    `---\nname: X\ndescription: Y\ntools: ${Array.from({ length: 20 }, (_, i) => `tool.${i}`).join(", ")}\n---\n\nBody.`,
    { id: "x" },
  );
  assert.equal(tooMany.ok, false);

  const longPurpose = parseSkillMarkdown(
    `---\nname: X\ndescription: Y\npurpose: "${"p".repeat(600)}"\n---\n\nBody.`,
    { id: "x" },
  );
  assert.equal(longPurpose.ok, false);

  // Old skills without the new keys still validate — the fields are optional.
  const legacy = parseSkillMarkdown(`---\nname: Old\ndescription: Plain.\n---\n\nBody.`, { id: "old" });
  assert.equal(legacy.ok, true);
  if (legacy.ok) {
    assert.equal(legacy.value.purpose, undefined);
    assert.equal(legacy.value.tools, undefined);
    assert.equal(legacy.value.constraints, undefined);
  }
});

test("render round-trips the new frontmatter through parse", () => {
  const markdown = renderSkillMarkdown({
    name: "R",
    description: "D.",
    purpose: "Do R well.",
    tools: ["filesystem.search"],
    constraints: ["Read-only."],
    tags: ["t"],
    body: "Body text.",
  });
  const parsed = parseSkillMarkdown(markdown, { id: "r" });
  assert.equal(parsed.ok, true, JSON.stringify(parsed.ok ? {} : parsed.issues));
  if (!parsed.ok) return;
  assert.equal(parsed.value.purpose, "Do R well.");
  assert.deepEqual(parsed.value.tools, ["filesystem.search"]);
  assert.deepEqual(parsed.value.constraints, ["Read-only."]);
});
