// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Deterministic skill-tier precedence.
 *
 * The defect this pins: two skills can share a NAME under different ids, and
 * before this the winner was whichever one a caller read first. Every test below
 * either asserts the documented order or asserts that iteration order cannot
 * change the outcome.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createSkillRegistry } from "../src/skills/registry.ts";
import { createSkillStore } from "../src/skills/store.ts";

import {
  resolveSkillTiers,
  SKILL_TIER_ORDER,
  tierOf,
  tierRank,
  type TierCandidate,
} from "../src/skills/tiers.ts";

function skill(over: Partial<TierCandidate> & { id: string }): TierCandidate {
  return { source: "learned", sha256: `sha_${over.id}`, disabled: false, ...over };
}

test("the documented order is the order the code uses", (t) => {
  assert.deepEqual([...SKILL_TIER_ORDER], ["builtin", "library", "project", "learned", "imported", "unknown"]);
  for (let i = 1; i < SKILL_TIER_ORDER.length; i += 1) {
    assert.ok(
      tierRank(SKILL_TIER_ORDER[i - 1]!) < tierRank(SKILL_TIER_ORDER[i]!),
      `${SKILL_TIER_ORDER[i - 1]} must outrank ${SKILL_TIER_ORDER[i]}`,
    );
  }
  t.diagnostic(SKILL_TIER_ORDER.join(" > "));
});

test("each real source maps to its tier; an unknown source is NOT guessed", (t) => {
  assert.equal(tierOf("builtin"), "builtin");
  assert.equal(tierOf("discovered:kai-library"), "library");
  assert.equal(tierOf("learned"), "learned");
  assert.equal(tierOf("  BUILTIN  "), "builtin", "case and whitespace are normalized");
  // The important one: something KAI does not understand must not outrank a
  // skill KAI reviewed.
  assert.equal(tierOf("vendor:something-new"), "unknown");
  assert.equal(tierOf(""), "unknown");
  assert.ok(tierRank("unknown") > tierRank("learned"));
  t.diagnostic("unknown sources resolve to the lowest tier");
});

test("builtin beats library beats learned, and the reason names the order", (t) => {
  const { resolutions, shadowed } = resolveSkillTiers([
    skill({ id: "learned-copy", name: "plan-review", source: "learned" }),
    skill({ id: "library-copy", name: "plan-review", source: "discovered:kai-library" }),
    skill({ id: "builtin-copy", name: "plan-review", source: "builtin" }),
  ]);
  assert.equal(resolutions.length, 1);
  const resolution = resolutions[0]!;
  assert.equal(resolution.winner.id, "builtin-copy");
  assert.equal(resolution.winner.tier, "builtin");
  assert.deepEqual(resolution.shadowed.map((s) => s.id).sort(), ["learned-copy", "library-copy"]);
  assert.match(resolution.shadowed.find((s) => s.id === "library-copy")!.reason, /lower precedence than "builtin"/);
  assert.equal(shadowed.size, 2);
  assert.match(String(shadowed.get("learned-copy")), /shadowed by "builtin-copy"/);
  t.diagnostic(resolution.reason);
});

test("ITERATION ORDER cannot change the outcome", (t) => {
  const a = skill({ id: "learned-copy", name: "same", source: "learned" });
  const b = skill({ id: "builtin-copy", name: "same", source: "builtin" });
  const c = skill({ id: "library-copy", name: "same", source: "discovered:kai-library" });
  const orders = [
    [a, b, c],
    [c, b, a],
    [b, a, c],
    [b, c, a],
    [a, c, b],
    [c, a, b],
  ];
  const winners = orders.map((o) => resolveSkillTiers(o).resolutions[0]?.winner.id);
  assert.deepEqual(new Set(winners), new Set(["builtin-copy"]), `all six orders agree: ${winners.join(",")}`);
  t.diagnostic(`6 input orders, one winner`);
});

test("the id is the tie-break WITHIN a tier, so same-tier conflicts are also deterministic", (t) => {
  const { resolutions } = resolveSkillTiers([
    skill({ id: "zzz", name: "same", source: "learned" }),
    skill({ id: "aaa", name: "same", source: "learned" }),
  ]);
  assert.equal(resolutions[0]?.winner.id, "aaa", "the lower id wins, not the first read");
  assert.match(resolutions[0]!.shadowed[0]!.reason, /same tier "learned" as "aaa", which wins the id tie-break/);
});

test("a DISABLED skill never wins, even from the highest tier", (t) => {
  const { resolutions, shadowed } = resolveSkillTiers([
    skill({ id: "builtin-disabled", name: "shared", source: "builtin", disabled: true }),
    skill({ id: "learned-live", name: "shared", source: "learned" }),
  ]);
  assert.equal(resolutions[0]?.winner.id, "learned-live", "a disabled builtin does not block a live skill");
  assert.match(String(shadowed.get("builtin-disabled")), /disabled/);
  t.diagnostic(String(shadowed.get("builtin-disabled")));
});

test("a disabled skill still wins when it is the ONLY candidate, and is reported as disabled", (t) => {
  // Shadowing is about conflicts; being the sole holder of a name is not one.
  const { resolutions } = resolveSkillTiers([skill({ id: "only", name: "lonely", disabled: true })]);
  assert.equal(resolutions.length, 1);
  assert.equal(resolutions[0]?.winner.id, "only");
  assert.deepEqual(resolutions[0]?.shadowed, []);
});

test("identical content under two ids is explained, not treated as a real conflict", (t) => {
  const { resolutions } = resolveSkillTiers([
    skill({ id: "one", name: "dup", source: "builtin", sha256: "SAME" }),
    skill({ id: "two", name: "dup", source: "learned", sha256: "SAME" }),
  ]);
  assert.equal(resolutions[0]?.winner.id, "one");
  assert.match(resolutions[0]!.shadowed[0]!.reason, /identical content to "one" \(same sha256\)/);
});

test("MISSING metadata: a skill with no name is identified by its id, and does not collide", (t) => {
  const { resolutions } = resolveSkillTiers([
    skill({ id: "no-name-a", source: "builtin" }),
    skill({ id: "no-name-b", source: "learned" }),
    skill({ id: "named", name: "   ", source: "learned" }),
  ]);
  assert.equal(resolutions.length, 3, "three distinct keys, so no conflict is invented");
  assert.deepEqual(resolutions.map((r) => r.key).sort(), ["named", "no-name-a", "no-name-b"]);
  assert.equal(resolutions.every((r) => r.shadowed.length === 0), true);
});

test("names are compared case-insensitively and trimmed", (t) => {
  const { resolutions } = resolveSkillTiers([
    skill({ id: "a", name: "Plan-Review", source: "learned" }),
    skill({ id: "b", name: "  plan-review ", source: "builtin" }),
  ]);
  assert.equal(resolutions.length, 1, "one conflict, not two names");
  assert.equal(resolutions[0]?.winner.id, "b");
  assert.equal(resolutions[0]?.key, "plan-review");
});

test("UPGRADE: a learned skill that becomes a builtin wins the name", (t) => {
  const before = resolveSkillTiers([
    skill({ id: "plan-review", name: "plan-review", source: "learned", sha256: "old" }),
    skill({ id: "learned-variant", name: "plan-review", source: "learned", sha256: "variant" }),
  ]);
  // Both are `learned`, so the ID tie-break decides: "learned-variant" < "plan-review".
  assert.equal(before.resolutions[0]?.winner.id, "learned-variant", "same tier: the id tie-break decides");

  // The same skill is now shipped as a builtin.
  const after = resolveSkillTiers([
    skill({ id: "plan-review", name: "plan-review", source: "builtin", sha256: "new" }),
    skill({ id: "learned-variant", name: "plan-review", source: "learned", sha256: "variant" }),
  ]);
  assert.equal(after.resolutions[0]?.winner.id, "plan-review");
  assert.equal(after.resolutions[0]?.winner.tier, "builtin");
  assert.equal(after.resolutions[0]!.shadowed[0]!.id, "learned-variant");
  assert.match(after.resolutions[0]!.shadowed[0]!.reason, /lower precedence than "builtin"/);
});

test("DOWNGRADE: losing provenance lowers a skill's tier and it can be shadowed", (t) => {
  const { resolutions } = resolveSkillTiers([
    skill({ id: "was-builtin", name: "tool", source: "vendor:new-thing" }),
    skill({ id: "library-tool", name: "tool", source: "discovered:kai-library" }),
  ]);
  assert.equal(resolutions[0]?.winner.id, "library-tool", "unknown provenance loses to a reviewed tier");
  const loser = resolutions[0]!.shadowed[0]!;
  assert.equal(loser.tier, "unknown");
  assert.match(loser.reason, /tier "unknown" \(source "vendor:new-thing"\) is lower precedence than "library"/);
  t.diagnostic(loser.reason);
});

test("provenance is preserved on every resolution", (t) => {
  const { resolutions, shadowed } = resolveSkillTiers([
    skill({ id: "winner", name: "n", source: "builtin", sha256: "W" }),
    skill({ id: "loser", name: "n", source: "vendor:x", sha256: "L" }),
  ]);
  const resolution = resolutions[0]!;
  assert.equal(resolution.winner.source, "builtin");
  assert.equal(resolution.winner.sha256, "W");
  assert.equal(resolution.winner.tier, "builtin");
  assert.equal(resolution.shadowed[0]?.source, "vendor:x", "the losing source is kept, not discarded");
  assert.equal(resolution.shadowed[0]?.sha256, "L");
  assert.ok(String(shadowed.get("loser")).includes("vendor:x"), "the reason names the losing SOURCE, not just its tier");
});

test("conflicting INSTRUCTIONS are resolved by tier, never merged", (t) => {
  // Two skills with the same name and DIFFERENT content are a genuine conflict.
  // The loser is shadowed wholesale — KAI never blends two instruction sets.
  const { resolutions } = resolveSkillTiers([
    skill({ id: "strict", name: "review", source: "builtin", sha256: "strict-body" }),
    skill({ id: "loose", name: "review", source: "learned", sha256: "loose-body" }),
  ]);
  assert.equal(resolutions[0]?.winner.sha256, "strict-body");
  assert.equal(resolutions[0]?.shadowed.length, 1);
  assert.equal(resolutions[0]?.shadowed[0]?.sha256, "loose-body");
  assert.notEqual(resolutions[0]?.winner.sha256, resolutions[0]?.shadowed[0]?.sha256);
});

test("an empty set resolves to nothing, without throwing", (t) => {
  const { resolutions, shadowed } = resolveSkillTiers([]);
  assert.deepEqual(resolutions, []);
  assert.equal(shadowed.size, 0);
});

test("resolutions are returned in a stable order", (t) => {
  const skills = [
    skill({ id: "z", name: "zeta" }),
    skill({ id: "a", name: "alpha" }),
    skill({ id: "m", name: "mu" }),
  ];
  const keys = resolveSkillTiers(skills).resolutions.map((r) => r.key);
  assert.deepEqual(keys, ["alpha", "mu", "zeta"]);
});

test("REGRESSION: relevant() and snapshot() AGREE about a shadowed skill", async (t) => {
  // Found by inspection: `snapshot()` marked a shadowed skill ineligible while
  // `relevant()` still offered it, so the loser of a name conflict could be
  // handed to a worker even though the index said it was not selectable.
  const root = mkdtempSync(join(tmpdir(), "kai-tier-agree-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const registry = createSkillRegistry({ store: createSkillStore({ root }) });

  const shared = (name: string) =>
    ["---", `name: ${name}`, "description: shared lookup helper", "---", "", "Use the shared helper."].join("\n");

  // Two ids, one name, different tiers: builtin wins, learned is shadowed.
  const builtin = registry.register({ id: "shared-builtin", markdown: shared("shared-name"), source: "builtin" });
  const learned = registry.register({ id: "shared-learned", markdown: shared("shared-name"), source: "learned" });
  assert.equal(builtin.ok && learned.ok, true);

  const tiers = registry.resolveTiers();
  assert.equal(tiers.shadowed.size, 1, "exactly one is shadowed");
  const shadowedId = [...tiers.shadowed.keys()][0];

  const context = { platform: process.platform, availableTools: [] };
  const snap = registry.snapshot(context);
  const snapEntry = snap.entries.find((e) => e.id === shadowedId);
  assert.equal(snapEntry?.eligible, false, "the snapshot says it is not selectable");

  const offered = registry.relevant("shared helper lookup", 10, context).map((m) => m.id);
  assert.ok(!offered.includes(String(shadowedId)), `relevant() must agree: ${offered.join(",")}`);
  assert.ok(offered.includes("shared-builtin"), "the winner is still offered");
  t.diagnostic(`shadowed ${shadowedId}; offered ${offered.join(",")}`);
});
