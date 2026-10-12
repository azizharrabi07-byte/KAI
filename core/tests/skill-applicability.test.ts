// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Skill applicability and the index snapshot.
 *
 * The behaviour these pin: a skill that cannot apply here is not a CANDIDATE, so
 * it must not take a slot from one the run can use — and a turn must be able to
 * hold one index so a mid-turn edit cannot change which skills it is using.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSkillIndex,
  checkApplicability,
  conditionsFromTags,
  eligibleSkills,
  type ApplicabilityContext,
  type IndexableSkill,
} from "../src/skills/applicability.ts";

const context = (over: Partial<ApplicabilityContext> = {}): ApplicabilityContext => ({
  platform: "linux",
  environment: "ci",
  domain: "coding",
  availableTools: ["filesystem.search", "git.diff"],
  ...over,
});

function skill(over: Partial<IndexableSkill> & { id: string }): IndexableSkill {
  return {
    name: over.id,
    description: "a skill",
    tags: [],
    source: "builtin",
    sha256: `sha_${over.id}`,
    disabled: false,
    ...over,
  };
}

test("a skill with no conditions is eligible everywhere — existing skills are never narrowed", (t) => {
  const conditions = conditionsFromTags(["testing", "writing", "no-colon"]);
  assert.deepEqual(conditions, {}, "ordinary tags are not conditions");
  for (const platform of ["linux", "win32", "darwin", "freebsd"]) {
    const verdict = checkApplicability(conditions, context({ platform, environment: undefined, domain: undefined }));
    assert.equal(verdict.eligible, true, `${platform} should be eligible`);
    assert.equal(verdict.reason, "applicable");
  }
  t.diagnostic("an unconditioned skill applies everywhere");
});

test("a platform, environment or domain mismatch is ineligible, and says why", (t) => {
  const cases: { tags: string[]; over: Partial<ApplicabilityContext>; expect: RegExp }[] = [
    { tags: ["platform:linux"], over: { platform: "win32" }, expect: /applies to linux but this is win32/ },
    { tags: ["platform:linux", "platform:darwin"], over: { platform: "win32" }, expect: /applies to linux\/darwin/ },
    { tags: ["env:local"], over: { environment: "ci" }, expect: /applies to the local environment but this is "ci"/ },
    { tags: ["domain:research"], over: { domain: "coding" }, expect: /applies to the research domain but this task is "coding"/ },
  ];
  for (const c of cases) {
    const verdict = checkApplicability(conditionsFromTags(c.tags), context(c.over));
    assert.equal(verdict.eligible, false, `${c.tags.join(",")} should be ineligible`);
    assert.match(verdict.reason, c.expect);
  }
  t.diagnostic(`checked ${cases.length} mismatches`);
});

test("an UNKNOWN environment fails open, a known mismatch fails closed", (t) => {
  const conditions = conditionsFromTags(["env:ci"]);
  // KAI usually does not know its environment. Failing closed here would make
  // every `env:ci` skill invisible in the ordinary case.
  assert.equal(
    checkApplicability(conditions, context({ environment: undefined })).eligible,
    true,
    "an unknown environment cannot rule a skill out",
  );
  // But a KNOWN, different environment is a real mismatch.
  const mismatch = checkApplicability(conditions, context({ environment: "local" }));
  assert.equal(mismatch.eligible, false);
  assert.match(mismatch.reason, /applies to the ci environment but this is "local"/);
  assert.equal(checkApplicability(conditions, context({ environment: "CI" })).eligible, true, "case-insensitive");
  t.diagnostic("unknown fails open, known mismatch fails closed");
});

test("a skill whose declared tool is missing is ineligible", (t) => {
  const conditions = conditionsFromTags(["platform:linux"]);
  const withTools = { ...conditions, tools: ["filesystem.search", "browser.navigate"] };
  const verdict = checkApplicability(withTools, context());
  assert.equal(verdict.eligible, false);
  assert.match(verdict.reason, /needs browser\.navigate, which this run does not have/);
  // And it is eligible when the tool IS available.
  assert.equal(checkApplicability(withTools, context({ availableTools: ["filesystem.search", "browser.navigate"] })).eligible, true);
  t.diagnostic(verdict.reason);
});

test("a skill's own declared tools are a condition, without any tag", (t) => {
  const snapshot = buildSkillIndex([skill({ id: "needs-browser", tools: ["browser.navigate"] })], context());
  assert.equal(snapshot.entries[0]?.eligible, false);
  assert.match(String(snapshot.entries[0]?.reason), /needs browser\.navigate/);
});

test("the snapshot is DETERMINISTIC: order of input does not change its identity", (t) => {
  const a = skill({ id: "alpha", tags: ["platform:linux"] });
  const b = skill({ id: "beta", tags: ["platform:win32"] });
  const c = skill({ id: "gamma" });
  const first = buildSkillIndex([a, b, c], context());
  const second = buildSkillIndex([c, b, a], context());
  const third = buildSkillIndex([b, a, c], context());
  assert.equal(first.snapshotId, second.snapshotId, "the same skills in a different order are the same index");
  assert.equal(first.snapshotId, third.snapshotId);
  assert.deepEqual(first.entries.map((e) => e.id), ["alpha", "beta", "gamma"], "entries are ordered by id");
  t.diagnostic(`snapshotId ${first.snapshotId.slice(0, 16)}`);
});

test("a HELD snapshot does not change when a skill is added mid-turn", (t) => {
  const held = buildSkillIndex([skill({ id: "alpha" })], context());
  // The turn holds `held`. A skill appears afterwards.
  const later = buildSkillIndex([skill({ id: "alpha" }), skill({ id: "beta" })], context());
  assert.equal(held.entries.length, 1, "the held snapshot is unchanged");
  assert.equal(later.entries.length, 2);
  assert.notEqual(held.snapshotId, later.snapshotId, "the identity changes, so a caller CAN detect the drift");
});

test("an EDIT changes the snapshot identity even when the ids do not change", (t) => {
  const before = buildSkillIndex([skill({ id: "alpha", sha256: "v1" })], context());
  const after = buildSkillIndex([skill({ id: "alpha", sha256: "v2" })], context());
  assert.notEqual(before.snapshotId, after.snapshotId, "a new revision is a new index");
});

test("disabled and ineligible are separate axes, and both are excluded from the eligible list", (t) => {
  const snapshot = buildSkillIndex(
    [
      skill({ id: "ok" }),
      skill({ id: "disabled", disabled: true }),
      skill({ id: "wrong-platform", tags: ["platform:win32"] }),
    ],
    context(),
  );
  assert.equal(snapshot.eligible, 1);
  assert.equal(snapshot.ineligible, 2);
  const disabled = snapshot.entries.find((e) => e.id === "disabled");
  assert.equal(disabled?.disabled, true);
  assert.equal(disabled?.reason, "disabled by an operator");
  const wrong = snapshot.entries.find((e) => e.id === "wrong-platform");
  assert.equal(wrong?.disabled, false, "it is not disabled, it simply does not apply here");
  assert.match(String(wrong?.reason), /applies to win32/);
  assert.deepEqual(eligibleSkills(snapshot).map((e) => e.id), ["ok"]);
});

test("the index is BOUNDED, and says when it truncated", (t) => {
  const many = Array.from({ length: 25 }, (_, i) => skill({ id: `s${String(i).padStart(2, "0")}` }));
  const bounded = buildSkillIndex(many, context(), { maxEntries: 10 });
  assert.equal(bounded.entries.length, 10);
  assert.equal(bounded.truncated, true);
  const all = buildSkillIndex(many, context(), { maxEntries: 100 });
  assert.equal(all.entries.length, 25);
  assert.equal(all.truncated, false);
  t.diagnostic(`bounded to ${bounded.entries.length} of ${many.length}`);
});

test("the DEFAULT cap does not truncate a realistically sized library", (t) => {
  // A fresh Core already had 266 skills, and a default cap of 200 silently
  // dropped 66 of them. The default must be a safety bound, not a working limit.
  const many = Array.from({ length: 300 }, (_, i) => skill({ id: `s${String(i).padStart(3, "0")}` }));
  const snapshot = buildSkillIndex(many, context());
  assert.equal(snapshot.entries.length, 300, "the default cap must not hide real skills");
  assert.equal(snapshot.truncated, false);
  t.diagnostic(`default cap holds ${snapshot.entries.length}`);
});

test("a condition tag is case-insensitive and trimmed", (t) => {
  const conditions = conditionsFromTags(["Platform: Linux ", "ENV:CI"]);
  assert.deepEqual(conditions, { platforms: ["linux"], environments: ["ci"] });
});
