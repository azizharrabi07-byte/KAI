// The KAI orb — the owner's design's place/shape, now drawn by the REAL engine.
//
// This file used to build a CSS orb (`kai-presence-v2.html` ORB markup: nine-and-
// one divs styled by presence.css). The owner's mission (§3, §4) is explicit:
// the main workspace must NOT keep a second, decorative KAI — it must use the
// real character engine the island draws with. So `createOrb` now returns a
// `<span class="orb orb-c">` wrapping a `<canvas>` painted by `KaiEngine`
// (`../character/canvas-view.ts` → `../character/engine.ts` → `../character/orb.ts`).
//
// The PUBLIC API is unchanged on purpose — `Mood`, `MOOD_LABELS`, `MOOD_ORDER`,
// `createOrb`, `setOrbMood`, `boop`, `mountOrbParallax` — so every existing call
// site in `presence.ts` keeps working, and the *look* is now KAI's real face.
//
// The design's ten `Mood` names are kept as the presence's own display
// vocabulary and mapped onto the runtime machine's REAL states; nothing here
// invents a state the machine cannot enter.
//
// Appearance: every orb that does not carry its own explicit identity colour is
// attached to the ONE shared system (`kaiCharacter`), so a skin / outfit change
// in the appearance editor repaints every KAI face in the workspace at once.
//
// MIT.

import { mountCharacterCanvas, type CharacterCanvasHandle } from "../../character/canvas-view";
import { kaiCharacter, type CharacterAppearanceView } from "../../character/system";
import type { KaiRuntimeState } from "../../core/runtime-state";

export type Mood =
  | "idle"
  | "listen"
  | "curious"
  | "think"
  | "focus"
  | "worry"
  | "happy"
  | "excited"
  | "sad"
  | "sleepy";

/** The design's own label table (MOODS). */
export const MOOD_LABELS: Record<Mood, string> = {
  idle: "Ready",
  listen: "Listening",
  curious: "Curious",
  think: "Thinking",
  focus: "Focused",
  worry: "Needs your call",
  happy: "Done, happy",
  excited: "All green!",
  sad: "Something broke",
  sleepy: "Sleeping",
};

export const MOOD_ORDER: Mood[] = [
  "idle", "listen", "curious", "think", "focus", "worry", "happy", "excited", "sad", "sleepy",
];

/**
 * The design's ten display moods → the runtime machine's REAL states. Each target
 * is a state `KaiRuntimeState` actually has and the engine actually renders (see
 * `character/types.ts` `KAI_STATE_POSE`). `excited` uses the "idea/eureka" pose
 * so it is genuinely distinct from `happy` (the short success burst).
 */
export const MOOD_TO_STATE: Record<Mood, KaiRuntimeState> = {
  idle: "IDLE",
  listen: "LISTENING",
  curious: "RESEARCHING",
  think: "THINKING",
  focus: "WORKING",
  worry: "NEEDS_USER",
  happy: "SUCCESS",
  excited: "LEARNING",
  sad: "ERROR",
  sleepy: "OFFLINE",
};

export interface OrbOptions {
  /** Starting mood. */
  mood?: Mood;
  /** Big-orbit effects (zz/tears/sparkles): on for the hero orb (kept for the API). */
  fx?: boolean;
  /** Hue rotation in degrees (the agent cards use it). */
  hue?: number;
  /** Size of the *body*, in CSS px (the layout box matches it). */
  size?: number;
  /** Title tooltip. */
  title?: string;
  /** Explicit flat body colour (hex) — an agent's own identity chip. */
  color?: string;
}

/** The live renderer behind each wrapper element. */
const registry = new WeakMap<HTMLElement, CharacterCanvasHandle>();

/** Build one real-engine orb. */
export function createOrb(options: OrbOptions = {}): HTMLElement {
  const view = mountCharacterCanvas({
    size: options.size ?? 40,
    overhang: options.fx === true ? 26 : 0,
    ...(options.hue !== undefined ? { hue: options.hue } : {}),
    ...(options.color !== undefined ? { color: options.color, mini: true } : {}),
    ...(options.title !== undefined ? { title: options.title } : {}),
  });
  const el = view.wrapper;
  el.classList.add("orb", "orb-c");
  el.dataset.s = options.mood ?? "idle";
  el.dataset.fx = options.fx === true ? "on" : "off";
  registry.set(el, view);

  // An orb with its own explicit identity colour is an agent chip and keeps it;
  // every other orb follows KAI's ONE shared appearance (skin + outfit).
  if (options.hue === undefined && options.color === undefined) {
    const appearanceView: CharacterAppearanceView = {
      setAppearance: (v) => {
        view.engine.setSkin(v.skin);
        view.engine.setAccessory(v.accessory);
      },
      isConnected: () => el.isConnected,
    };
    kaiCharacter.attachAppearance(appearanceView);
  }

  view.engine.setState(MOOD_TO_STATE[options.mood ?? "idle"], true);
  return el;
}

/** Set an orb's mood (mapped to a real runtime state). */
export function setOrbMood(el: HTMLElement, mood: Mood): void {
  el.dataset.s = mood;
  registry.get(el)?.engine.setState(MOOD_TO_STATE[mood]);
}

/** The design's `boop()` squash animation, now on the real engine. */
export function boop(el: HTMLElement): void {
  registry.get(el)?.boop();
  el.classList.remove("boop");
  void el.offsetWidth;
  el.classList.add("boop");
}

/**
 * The design's pointer-parallax: the orb's gaze follows the cursor. Routed into
 * the engine's `lookX` / `lookY` instead of CSS custom properties.
 */
export function mountOrbParallax(root: HTMLElement): () => void {
  const onMove = (e: PointerEvent): void => {
    for (const o of Array.from(root.querySelectorAll<HTMLElement>(".orb"))) {
      const view = registry.get(o);
      if (view === undefined) continue;
      const r = o.getBoundingClientRect();
      const size = r.width || 40;
      const dx = e.clientX - (r.left + size / 2);
      const dy = e.clientY - (r.top + size / 2);
      const reach = Math.max(120, size * 3);
      view.setLook(dx / reach, dy / reach);
    }
  };
  window.addEventListener("pointermove", onMove);
  return () => window.removeEventListener("pointermove", onMove);
}

/** The live renderer behind an orb element, for verification harnesses (read-only). */
export function orbRenderer(el: HTMLElement): CharacterCanvasHandle | undefined {
  return registry.get(el);
}
