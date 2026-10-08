// KAI — the appearance VARIANT model.
//
// A variant is KAI's visual identity: which SKIN (the body palette), which THEME
// (the named colour treatment) and which ACCESSORY (the outfit) a particular KAI
// wears. A KAI SUBAGENT inherits KAI's visual system and overrides a few of these
// parameters — there is no second avatar implementation (owner section 12). This
// module is a thin configuration layer OVER the existing character module; it
// does NOT re-declare the source tables.
//
// The single source of truth is `./orb.ts` (the ported asset). This module reads:
//   • `SKN`  — the three skins (blue / black / yellow) and their body gradients;
//   • `THM`  — the named colour themes (aqua, wake, sky, mint, sun, rose, plan,
//              help, progress, error, ultra);
// and pins the accessory names against orb's own `AccessoryName` union (the FITS
// table itself is module-private — see NOTE below).
//
// APPLYING a variant: `applyVariant(engine, v)` calls the two setters the engine
// already exposes — `setSkin` and `setAccessory`. The named theme is applied only
// when the renderer exposes a `setTheme` hook; today `KaiOrb` has no theme setter
// (its colour comes from the per-pose tables), so the theme is recorded as part of
// the variant's identity and applied automatically the moment the hook lands. This
// is reported, not faked: a control that silently did nothing would be a lie.
//
// PERSISTENCE: the selection is stored in the webview's own durable store
// (`localStorage`, key `kai.appearance.v1`). Both windows (island and settings)
// share one WebView2 environment and one origin, so one store serves both and it
// survives a real restart. The app's canonical preferences file is
// `%APPDATA%\KAI\settings.json`, but adding fields there means editing
// `app/src/core/state.ts` and `app/src-tauri/src/settings.rs`, which other agents
// own this round — so the durable choice lives here and the wiring is reported.
//
// MIT.

import { SKN, THM, type AccessoryName, type SkinName } from "./orb";
import type { KaiEngine } from "./engine";

export type { AccessoryName, SkinName };

// ── The available values, read from the character module ──────────────────────

/** Skins, read straight from the source table `SKN`. */
export const SKINS = Object.keys(SKN) as SkinName[];

/** Named colour themes, read straight from the source table `THM`. */
export const THEMES = Object.keys(THM);

// NOTE: orb.ts keeps `FITS` (the accessory mesh builders) module-private and does
// not export a runtime list of names, so the accessory names are pinned here
// against orb's OWN `AccessoryName` union via an exhaustive Record: if the module
// ever gains a ninth accessory this stops compiling, and the runtime list is
// derived from that same object rather than hand-maintained.
const ACCESSORY_SET: Record<AccessoryName, true> = {
  none: true, hair: true, cap: true, bat: true, phones: true, cat: true, crown: true, halo: true,
};
export const ACCESSORIES = Object.keys(ACCESSORY_SET) as AccessoryName[];

// ── The variant ───────────────────────────────────────────────────────────────

export interface KaiVariant {
  /** Stable machine id, e.g. "kai", "kai-coder", "custom". */
  id: string;
  /** Human label shown in the settings window. */
  label: string;
  /** Body palette — one of `SKINS`. Applied by the engine today. */
  skin: SkinName;
  /** Named colour treatment — one of `THEMES`. Applied when the renderer exposes setTheme. */
  theme: string;
  /** Outfit — one of `ACCESSORIES`. Applied by the engine today. */
  accessory: AccessoryName;
  /** The skin's principal body colour (hex) — a subagent's identity chip colour. */
  primaryColor: string;
  /** The skin's highlight colour (hex). */
  secondaryColor: string;
}

/** The body gradient stops of a skin, as hex (read from `SKN`). */
function skinStops(skin: SkinName): readonly string[] {
  const s = SKN[skin] ?? SKN[SKINS[0]];
  return s.b;
}

/** Builds a full variant from a partial selection, deriving the palette from the skin. */
export function makeVariant(partial: Partial<KaiVariant> = {}): KaiVariant {
  const skin: SkinName = partial.skin && SKINS.includes(partial.skin) ? partial.skin : SKINS[0];
  const theme = partial.theme && THEMES.includes(partial.theme) ? partial.theme : THEMES[0];
  const accessory: AccessoryName =
    partial.accessory && ACCESSORIES.includes(partial.accessory) ? partial.accessory : "none";
  const stops = skinStops(skin);
  return {
    id: partial.id ?? "custom",
    label: partial.label ?? "Custom",
    skin,
    theme,
    accessory,
    // Stop 1 is the principal body colour, stop 3 the highlight — the two colours
    // a subagent chip / identity dot is drawn with.
    primaryColor: partial.primaryColor ?? stops[1] ?? stops[0],
    secondaryColor: partial.secondaryColor ?? stops[3] ?? stops[stops.length - 1],
  };
}

/** A variant with the palette re-derived from its skin (after a skin change). */
export function withSkin(v: KaiVariant, skin: SkinName): KaiVariant {
  return makeVariant({ ...v, skin, primaryColor: undefined, secondaryColor: undefined });
}

export function withTheme(v: KaiVariant, theme: string): KaiVariant {
  return makeVariant({ ...v, theme });
}

export function withAccessory(v: KaiVariant, accessory: AccessoryName): KaiVariant {
  return makeVariant({ ...v, accessory });
}

// ── The presets — KAI and the subagents it spawns ─────────────────────────────
//
// The owner asked (section 8) that different KAI subagents carry their own outfit
// / colour / identity. The source provides THREE body colours (blue, black,
// yellow) and EIGHT outfits, plus eleven named colour treatments. The illustrative
// "green / purple / orange" of the brief do not exist as skins; they exist as the
// named THEMES `mint` / `ultra` / `sun`, which the renderer will apply as soon as
// it exposes a theme hook. So each subagent is given a real, distinct
// skin + outfit today and a distinct colour treatment for when themes render.

export const KAI_VARIANTS: KaiVariant[] = [
  makeVariant({ id: "kai", label: "KAI", skin: "blue", theme: "aqua", accessory: "none" }),
  makeVariant({ id: "kai-coder", label: "KAI-Coder", skin: "yellow", theme: "sun", accessory: "cap" }),
  makeVariant({ id: "kai-research", label: "KAI-Research", skin: "black", theme: "ultra", accessory: "halo" }),
  makeVariant({ id: "kai-browser", label: "KAI-Browser", skin: "blue", theme: "mint", accessory: "phones" }),
];

/** KAI itself — the default. */
export const DEFAULT_VARIANT: KaiVariant = KAI_VARIANTS[0];

export function findPreset(id: string): KaiVariant | undefined {
  return KAI_VARIANTS.find((v) => v.id === id);
}

// ── Applying a variant to a live renderer ─────────────────────────────────────

/** What a call to `applyVariant` actually managed to do. */
export interface ApplyResult {
  skinApplied: boolean;
  accessoryApplied: boolean;
  /** False today: `KaiOrb` has no theme setter (reported, not faked). */
  themeApplied: boolean;
}

/**
 * Applies a variant to a `KaiEngine`. Only the engine's PUBLIC API is used —
 * `setSkin` / `setAccessory` — plus an optional `setTheme` that is called when the
 * character module gains one. Never reaches past the public surface.
 */
export function applyVariant(engine: KaiEngine, variant: KaiVariant): ApplyResult {
  const e = engine as KaiEngine & { setTheme?: (theme: string) => void };
  let themeApplied = false;
  try {
    e.setSkin(variant.skin);
  } catch {
    return { skinApplied: false, accessoryApplied: false, themeApplied: false };
  }
  try {
    e.setAccessory(variant.accessory);
  } catch {
    return { skinApplied: true, accessoryApplied: false, themeApplied: false };
  }
  if (typeof e.setTheme === "function") {
    e.setTheme(variant.theme);
    themeApplied = true;
  }
  return { skinApplied: true, accessoryApplied: true, themeApplied };
}

// ── Persistence — the webview's durable store, shared by both windows ─────────

export const APPEARANCE_KEY = "kai.appearance.v1";

/** The slice of the Storage API this module needs (injectable for tests). */
export interface VariantStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStore(): VariantStore | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

/**
 * Validates a stored value back into a variant. Anything unknown (a skin, theme or
 * accessory that no longer exists, a hand-edited file) falls back to the default
 * rather than rendering something the character module cannot draw.
 */
export function parseVariant(raw: string | null): KaiVariant | null {
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  if (typeof d.skin !== "string" || !SKINS.includes(d.skin as SkinName)) return null;
  if (typeof d.accessory !== "string" || !ACCESSORIES.includes(d.accessory as AccessoryName)) return null;
  if (typeof d.theme !== "string" || !THEMES.includes(d.theme)) return null;
  return makeVariant({
    id: typeof d.id === "string" ? d.id : "custom",
    label: typeof d.label === "string" ? d.label : "Custom",
    skin: d.skin as SkinName,
    theme: d.theme,
    accessory: d.accessory as AccessoryName,
  });
}

/** Reads the saved variant, or KAI's default when nothing valid is stored. */
export function loadVariant(store: VariantStore | null = defaultStore()): KaiVariant {
  if (!store) return DEFAULT_VARIANT;
  try {
    return parseVariant(store.getItem(APPEARANCE_KEY)) ?? DEFAULT_VARIANT;
  } catch {
    return DEFAULT_VARIANT;
  }
}

/** Persists a variant. Returns the serialized string (useful for evidence). */
export function saveVariant(variant: KaiVariant, store: VariantStore | null = defaultStore()): string {
  const json = JSON.stringify(variant);
  try {
    store?.setItem(APPEARANCE_KEY, json);
  } catch {
    /* a disabled store must not break the UI */
  }
  return json;
}

/** A short human description, e.g. "KAI-Coder — yellow skin · sun theme · cap outfit". */
export function describeVariant(v: KaiVariant): string {
  return `${v.label} — ${v.skin} skin · ${v.theme} theme · ${v.accessory} outfit`;
}

/** True when two variants would render identically (skin + accessory are the rendered knobs). */
export function sameAppearance(a: KaiVariant, b: KaiVariant): boolean {
  return a.skin === b.skin && a.accessory === b.accessory && a.theme === b.theme;
}
