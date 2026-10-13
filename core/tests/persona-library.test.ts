// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * KAI's curated persona library — the 16 personas mined from `affaan-m/ECC`.
 *
 * It is seeded only when `KAI_PERSONA_LIBRARY=1`. That is deliberate and was
 * MEASURED, not assumed: every persona is a workforce EMPLOYEE, so registering
 * one publishes `workforce.registered` and the boot monitor then publishes an
 * observation. The Doer records those durably, so seeding 16 personas produced
 * **32 extra Doer results on every boot** — real noise for a user who never asked
 * for it, and a change to boot state that every exact-count assertion depends on.
 *
 * These tests therefore drive the seeder DIRECTLY, which is the same code path
 * `KAI_PERSONA_LIBRARY=1` takes, without making the default boot louder.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createSubagentRegistry } from "../src/workforce/subagent.ts";
import { listLibraryPersonas, personasDir, seedLibraryPersonas } from "../src/workforce/personas.ts";

test("the library loads, and every entry passes the SAME validation a hand-written persona passes", (t) => {
  const { specs, skipped } = listLibraryPersonas();
  assert.equal(skipped.length, 0, `nothing was skipped: ${JSON.stringify(skipped)}`);
  assert.ok(specs.length > 0, `the library has personas (dir: ${personasDir()})`);
  for (const spec of specs) {
    assert.ok(spec.id.length > 0, "an id");
    assert.ok(spec.soul.length > 0, `${spec.id}: a soul`);
    assert.ok(spec.role.length > 0, `${spec.id}: a role`);
    assert.equal(spec.workerId, "hermes", `${spec.id}: bound to a real worker`);
    assert.ok((spec.instructions?.length ?? 0) <= 4000, `${spec.id}: instructions respect KAI's 4000-char limit`);
    assert.ok((spec.description?.length ?? 0) <= 500, `${spec.id}: description respects the 500-char limit`);
  }
  t.diagnostic(`${specs.length} personas, all valid`);
});

test("the mined personas carry KAI's own honesty rule, not an imported personality", (t) => {
  const { specs } = listLibraryPersonas();
  for (const spec of specs) {
    assert.match(spec.soul, /say plainly what I could not do/, `${spec.id}: honesty`);
    assert.match(spec.soul, /never claim something worked without checking/, `${spec.id}: verification`);
    assert.match(spec.soul, /do not approve my own work/, `${spec.id}: no self-approval`);
  }
  t.diagnostic("every persona inherits KAI's honesty and no-self-approval rules");
});

test("seeding is IDEMPOTENT: a second seed adds nothing and overwrites nothing", (t) => {
  const registry = createSubagentRegistry({});
  const first = seedLibraryPersonas(registry);
  assert.ok(first.seeded.length > 0, "the first seed registers personas");
  assert.equal(first.existing.length, 0, "nothing existed before");

  const second = seedLibraryPersonas(registry);
  assert.equal(second.seeded.length, 0, "the second seed registers nothing new");
  assert.equal(second.existing.length, first.seeded.length, "every id is reported as already owned");
  assert.equal(registry.list().length, first.seeded.length, "the count did not grow");
  t.diagnostic(`${first.seeded.length} seeded, then ${second.existing.length} recognised`);
});

test("a HUMAN's persona of the same id is never overwritten by a seed", (t) => {
  const registry = createSubagentRegistry({});
  registry.define({
    id: "planner",
    name: "My Planner",
    role: "mine",
    soul: "I am the owner's own planner and I keep my own rules.",
    workerId: "hermes",
  });
  seedLibraryPersonas(registry);
  const kept = registry.get("planner");
  assert.equal(kept?.spec.name, "My Planner", "the human's persona survived");
  assert.match(String(kept?.spec.soul), /I keep my own rules/, "and so did its soul");
  t.diagnostic("a seeded id a human already owns is left alone");
});

test("the library's provenance is recorded, and truncation is declared rather than hidden", (t) => {
  const { specs } = listLibraryPersonas();
  const mined = specs.filter((s) => s.description?.includes("affaan-m/ECC") === true);
  assert.equal(mined.length, specs.length, "every persona names its upstream");
  for (const spec of specs) {
    const text = `${spec.description ?? ""}`;
    assert.match(text, /@ [0-9a-f]{12}/, `${spec.id}: the upstream COMMIT is pinned`);
    assert.match(text, /authority comes from KAI's registry/, `${spec.id}: the prompt is not authority`);
    assert.match(text, /^Mined from affaan-m\/ECC; authority/, `${spec.id}: the disclaimer survives truncation`);
  }
  const truncated = specs.filter((s) => s.description?.includes("cut at a section boundary") === true);
  assert.ok(truncated.length > 0, "at least one persona declares its truncation");
  t.diagnostic(`${specs.length} personas, ${truncated.length} declaring a section-boundary cut`);
});
