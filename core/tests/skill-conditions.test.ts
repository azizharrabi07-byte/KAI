// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The typed applicability contract, and the legacy path it must not break.
 *
 * Conditions used to travel only in tags (`platform:linux`). They are now
 * explicit, validated, versioned frontmatter fields, with the tag convention
 * still read so no existing skill changes behaviour. The tests below assert both
 * halves of that: the new carrier works, and the old one still does.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createSkillRegistry } from "../src/skills/registry.ts";
import { createSkillStore } from "../src/skills/store.ts";

import { checkApplicability, conditionsForSkill } from "../src/skills/applicability.ts";
import { parseSkillMarkdown } from "../src/skills/validate.ts";
import { SKILL_CONDITIONS_VERSION } from "../src/skills/types.ts";

function skillMd(frontmatter: string[], body = "Do the work carefully."): string {
  return ["---", ...frontmatter, "---", "", body].join("\n");
}

const context = (over: Partial<Parameters<typeof checkApplicability>[1]> = {}) => ({
  platform: "linux",
  environment: "ci",
  domain: "coding",
  availableTools: [],
  ...over,
});

test("the explicit fields are parsed into typed conditions, and versioned", (t) => {
  const parsed = parseSkillMarkdown(
    skillMd([
      "name: linux-only",
      "description: a linux skill",
      "platforms: linux, darwin",
      "environments: ci",
      "domains: research",
    ]),
  );
  assert.equal(parsed.ok, true, parsed.ok ? "" : JSON.stringify(parsed.issues));
  if (!parsed.ok) return;
  assert.deepEqual(parsed.value.conditions, {
    platforms: ["linux", "darwin"],
    environments: ["ci"],
    domains: ["research"],
  });
  assert.equal(parsed.value.conditionsVersion, SKILL_CONDITIONS_VERSION);
  t.diagnostic(`contract v${parsed.value.conditionsVersion}`);
});

test("ABSENT fields are not a constraint: a skill with none applies everywhere", (t) => {
  const parsed = parseSkillMarkdown(skillMd(["name: plain", "description: no conditions"]));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.conditions, undefined, "nothing is declared, so nothing is invented");
  const resolved = conditionsForSkill(parsed.value);
  assert.equal(resolved.carrier, "none");
  assert.deepEqual(resolved.conditions, {});
  for (const platform of ["linux", "win32", "darwin"]) {
    assert.equal(checkApplicability(resolved.conditions, context({ platform })).eligible, true);
  }
});

test("MALFORMED metadata is REFUSED, never silently discarded", (t) => {
  const cases: { fm: string[]; why: string }[] = [
    { fm: ["name: x", "description: x", "platforms: linux, " + "a".repeat(40)], why: "an over-long condition value" },
    { fm: ["name: x", "description: x", "platforms: li nux"], why: "a value with a space" },
    {
      fm: ["name: x", "description: x", `platforms: ${Array.from({ length: 12 }, (_, i) => `p${i}`).join(", ")}`],
      why: "too many entries",
    },
  ];
  for (const c of cases) {
    const parsed = parseSkillMarkdown(skillMd(c.fm));
    assert.equal(parsed.ok, false, `${c.why} must be refused`);
    if (parsed.ok) continue;
    assert.equal(parsed.error.code, "VALIDATION_FAILED");
    assert.ok(parsed.issues.length > 0, `${c.why}: the issue is reported, not dropped`);
  }
  t.diagnostic(`refused ${cases.length} malformed shapes`);
});

test("an UNKNOWN frontmatter key is still refused — unknown metadata is not discarded", (t) => {
  const parsed = parseSkillMarkdown(skillMd(["name: x", "description: x", "platfomrs: linux"]));
  assert.equal(parsed.ok, false, "a typo'd key is a refusal, so it can never be silently ignored");
  if (parsed.ok) return;
  assert.ok(parsed.issues.some((i) => /platfomrs/.test(i.message)), JSON.stringify(parsed.issues));
});

test("BACKWARD COMPATIBILITY: a legacy tag-only skill behaves exactly as before", (t) => {
  const parsed = parseSkillMarkdown(skillMd(["name: legacy", "description: x", "tags: platform:linux, env:ci"]));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.conditions, undefined, "the skill declares no typed conditions");
  const resolved = conditionsForSkill(parsed.value);
  assert.equal(resolved.carrier, "tags", "the legacy carrier is still read");
  assert.deepEqual(resolved.conditions, { platforms: ["linux"], environments: ["ci"] });
  assert.equal(checkApplicability(resolved.conditions, context()).eligible, true);
  assert.equal(checkApplicability(resolved.conditions, context({ platform: "win32" })).eligible, false);
  t.diagnostic("legacy tags still decide");
});

test("the explicit field WINS over a tag, and the disagreement is reported", (t) => {
  const parsed = parseSkillMarkdown(
    skillMd(["name: both", "description: x", "platforms: linux", "tags: platform:win32"]),
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const resolved = conditionsForSkill(parsed.value);
  assert.equal(resolved.carrier, "mixed");
  assert.deepEqual(resolved.conditions.platforms, ["linux"], "the frontmatter is authoritative");
  assert.ok(resolved.conflict !== undefined, "the contradiction is surfaced, not hidden");
  assert.match(String(resolved.conflict), /platforms: frontmatter \[linux\] vs tag \[win32\]/);
  assert.match(String(resolved.conflict), /the frontmatter wins/);
  t.diagnostic(String(resolved.conflict));
});

test("agreement between the two carriers is NOT reported as a conflict", (t) => {
  const parsed = parseSkillMarkdown(
    skillMd(["name: agree", "description: x", "platforms: linux", "tags: platform:linux"]),
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const resolved = conditionsForSkill(parsed.value);
  assert.equal(resolved.carrier, "mixed");
  assert.equal(resolved.conflict, undefined);
  assert.deepEqual(resolved.conditions.platforms, ["linux"]);
});

test("a PARTIALLY migrated skill is not narrowed: undeclared dimensions fall back to tags", (t) => {
  // Frontmatter declares platforms; the environment still lives in a tag.
  const parsed = parseSkillMarkdown(
    skillMd(["name: partial", "description: x", "platforms: linux", "tags: env:ci"]),
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const resolved = conditionsForSkill(parsed.value);
  assert.deepEqual(resolved.conditions.platforms, ["linux"], "from the frontmatter");
  assert.deepEqual(resolved.conditions.environments, ["ci"], "from the legacy tag");
});

test("a skill's declared TOOLS are a condition regardless of carrier", (t) => {
  const parsed = parseSkillMarkdown(
    skillMd(["name: tooler", "description: x", "tools: browser.navigate", "platforms: linux"]),
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const resolved = conditionsForSkill(parsed.value);
  assert.deepEqual(resolved.conditions.tools, ["browser.navigate"]);
  assert.equal(checkApplicability(resolved.conditions, context()).eligible, false, "the tool is missing");
  assert.equal(
    checkApplicability(resolved.conditions, context({ availableTools: ["browser.navigate"] })).eligible,
    true,
  );
});

test("APPLICABILITY DECISIONS use the typed fields, with the same semantics as before", (t) => {
  const parsed = parseSkillMarkdown(
    skillMd([
      "name: scoped",
      "description: x",
      "platforms: linux",
      "environments: ci",
      "domains: research",
    ]),
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const { conditions } = conditionsForSkill(parsed.value);
  assert.equal(checkApplicability(conditions, context({ domain: "research" })).eligible, true);
  assert.match(
    checkApplicability(conditions, context({ domain: "coding" })).reason,
    /applies to the research domain but this task is "coding"/,
  );
  // An UNKNOWN environment still fails open, as before.
  assert.equal(checkApplicability(conditions, context({ environment: undefined, domain: "research" })).eligible, true);
  // A KNOWN, different one still fails closed.
  assert.equal(checkApplicability(conditions, context({ environment: "local", domain: "research" })).eligible, false);
});

test("REGRESSION: the conditions reach the METADATA surface, not just the store", (t) => {
  // Found by inspection: `toMetadata` copied tags/tools/constraints but NOT the
  // new conditions, so applicability worked internally while the API and UI could
  // not show a user WHY a skill was not being offered.
  const root = mkdtempSync(join(tmpdir(), "kai-cond-meta-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const store = createSkillStore({ root });
  const registry = createSkillRegistry({ store });
  const registered = registry.register({
    id: "meta-conditions",
    markdown: skillMd(["name: meta-conditions", "description: x", "platforms: linux", "environments: ci"]),
    source: "builtin",
  });
  assert.equal(registered.ok, true, registered.ok ? "" : registered.error.message);
  const listed = registry.list().find((m) => m.id === "meta-conditions");
  assert.deepEqual(listed?.conditions, { platforms: ["linux"], environments: ["ci"] }, "the metadata carries them");
  assert.equal(listed?.conditionsVersion, SKILL_CONDITIONS_VERSION);
  // And they survive a reopen (the JSON index persists them).
  const reopened = createSkillRegistry({ store: createSkillStore({ root }) });
  const again = reopened.list().find((m) => m.id === "meta-conditions");
  assert.deepEqual(again?.conditions, { platforms: ["linux"], environments: ["ci"] }, "durable across a reload");
  t.diagnostic(JSON.stringify(again?.conditions));
});

test("condition values are deduplicated and case is preserved for comparison", (t) => {
  const parsed = parseSkillMarkdown(
    skillMd(["name: dupes", "description: x", "platforms: linux, linux, linux"]),
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.value.conditions?.platforms, ["linux"], "a repeated value collapses");
});
