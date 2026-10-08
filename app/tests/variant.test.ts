// The appearance variant model — the configuration layer over the character module.
//
//   cd app && node --test tests/variant.test.ts
//
// What this pins:
//   (a) the model READS the source tables (skins/themes/accessories) rather than
//       re-declaring them — the available values are the character module's own;
//   (b) a variant is APPLIED through the engine's public setters only, and the
//       named theme is honestly reported as not-yet-applied when no setTheme hook
//       exists (a control that silently did nothing would be a lie);
//   (c) the persistence round-trip: a saved variant loads back identical, and a
//       stale / hand-edited / malformed value falls back to KAI's default rather
//       than rendering something the renderer cannot draw.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ACCESSORIES,
  DEFAULT_VARIANT,
  KAI_VARIANTS,
  SKINS,
  THEMES,
  applyVariant,
  describeVariant,
  loadVariant,
  makeVariant,
  parseVariant,
  sameAppearance,
  saveVariant,
  withAccessory,
  withSkin,
  withTheme,
} from "../src/character/variant.ts";

// ── A fake renderer that records what the model asked it to do ────────────────

function fakeEngine(withTheme = false) {
  const calls: string[] = [];
  const engine: Record<string, unknown> = {
    setSkin(s: string) { calls.push("skin:" + s); },
    setAccessory(a: string) { calls.push("accessory:" + a); },
  };
  if (withTheme) engine.setTheme = (t: string) => { calls.push("theme:" + t); };
  return { engine, calls };
}

function memoryStore(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    getItem: (k: string) => (k in data ? data[k] : null),
    setItem: (k: string, v: string) => { data[k] = v; },
    _data: data,
  };
}

// ── (a) the values come from the character module ─────────────────────────────

test("skins are exactly the source table's three skins", () => {
  assert.deepEqual(SKINS, ["blue", "black", "yellow"]);
});

test("themes are read from the source THM table (not re-declared)", () => {
  for (const t of ["aqua", "wake", "sky", "mint", "sun", "rose", "plan", "help", "progress", "error", "ultra"]) {
    assert.ok(THEMES.includes(t), `theme ${t} missing from THEMES`);
  }
});

test("every accessory in the module's union is offered, and only those", () => {
  assert.deepEqual([...ACCESSORIES].sort(), ["bat", "cap", "cat", "crown", "hair", "halo", "none", "phones"]);
});

test("a variant's colours are derived from its skin's body gradient", () => {
  const blue = makeVariant({ skin: "blue" });
  assert.equal(blue.primaryColor, "#2E84F6");
  assert.equal(blue.secondaryColor, "#A4E4FF");
  const yellow = withSkin(blue, "yellow");
  assert.equal(yellow.primaryColor, "#FFC21A");
  assert.notEqual(yellow.primaryColor, blue.primaryColor);
});

test("an unknown skin/theme/accessory falls back rather than producing a bad variant", () => {
  const v = makeVariant({ skin: "chartreuse" as never, theme: "nope", accessory: "sombrero" as never });
  assert.ok(SKINS.includes(v.skin));
  assert.ok(THEMES.includes(v.theme));
  assert.ok(ACCESSORIES.includes(v.accessory));
});

// ── the presets: KAI and the subagents it spawns ──────────────────────────────

test("the four presets are valid and distinct, each inheriting KAI's visual system", () => {
  assert.equal(KAI_VARIANTS.length, 4);
  const ids = new Set(KAI_VARIANTS.map((v) => v.id));
  assert.equal(ids.size, 4);
  for (const v of KAI_VARIANTS) {
    assert.ok(SKINS.includes(v.skin), v.id);
    assert.ok(THEMES.includes(v.theme), v.id);
    assert.ok(ACCESSORIES.includes(v.accessory), v.id);
    assert.match(v.primaryColor, /^#[0-9A-Fa-f]{6}$/);
  }
  assert.equal(KAI_VARIANTS[0].id, "kai");
  assert.equal(DEFAULT_VARIANT.id, "kai");
});

test("KAI-Coder / Research / Browser differ from KAI by skin or outfit", () => {
  const kai = KAI_VARIANTS.find((v) => v.id === "kai")!;
  for (const id of ["kai-coder", "kai-research", "kai-browser"]) {
    const sub = KAI_VARIANTS.find((v) => v.id === id)!;
    assert.ok(!sameAppearance(sub, kai), `${id} must not render identically to KAI`);
  }
});

// ── (b) applying uses only the engine's public API ────────────────────────────

test("applyVariant drives setSkin + setAccessory through the public API", () => {
  const { engine, calls } = fakeEngine();
  const result = applyVariant(engine as never, makeVariant({ skin: "yellow", accessory: "cap", theme: "sun" }));
  assert.deepEqual(calls, ["skin:yellow", "accessory:cap"]);
  assert.equal(result.skinApplied, true);
  assert.equal(result.accessoryApplied, true);
  assert.equal(result.themeApplied, false, "no setTheme hook exists on today's renderer");
});

test("applyVariant applies the theme the moment the renderer exposes setTheme", () => {
  const { engine, calls } = fakeEngine(true);
  const result = applyVariant(engine as never, makeVariant({ skin: "black", accessory: "halo", theme: "ultra" }));
  assert.deepEqual(calls, ["skin:black", "accessory:halo", "theme:ultra"]);
  assert.equal(result.themeApplied, true);
});

// ── (c) persistence round-trip ────────────────────────────────────────────────

test("a saved variant loads back identical", () => {
  const store = memoryStore();
  const chosen = makeVariant({ id: "kai-browser", label: "KAI-Browser", skin: "blue", theme: "mint", accessory: "phones" });
  saveVariant(chosen, store);
  const back = loadVariant(store);
  assert.deepEqual(back, chosen);
});

test("an empty store yields KAI's default", () => {
  assert.deepEqual(loadVariant(memoryStore()), DEFAULT_VARIANT);
});

test("a stale or hand-edited stored value falls back to the default", () => {
  const cases = [
    "{ not json",
    "null",
    JSON.stringify({ skin: "chartreuse", theme: "aqua", accessory: "none" }),
    JSON.stringify({ skin: "blue", theme: "not-a-theme", accessory: "none" }),
    JSON.stringify({ skin: "blue", theme: "aqua", accessory: "sombrero" }),
  ];
  for (const raw of cases) {
    assert.equal(parseVariant(raw), null, `should reject ${raw}`);
    assert.deepEqual(loadVariant(memoryStore({ "kai.appearance.v1": raw })), DEFAULT_VARIANT);
  }
});

test("withTheme / withAccessory keep the skin and its palette", () => {
  const base = makeVariant({ skin: "black", theme: "aqua", accessory: "none" });
  const themed = withTheme(base, "rose");
  assert.equal(themed.theme, "rose");
  assert.equal(themed.skin, "black");
  assert.equal(themed.primaryColor, base.primaryColor);
  const outfitted = withAccessory(base, "crown");
  assert.equal(outfitted.accessory, "crown");
  assert.equal(outfitted.skin, "black");
});

test("describeVariant names the skin, theme and outfit", () => {
  const s = describeVariant(makeVariant({ label: "KAI-Coder", skin: "yellow", theme: "sun", accessory: "cap" }));
  assert.match(s, /KAI-Coder/);
  assert.match(s, /yellow skin/);
  assert.match(s, /sun theme/);
  assert.match(s, /cap outfit/);
});
