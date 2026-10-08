// KAI character — shared vocabulary.
//
// This file defines the *character replacement interface*: the contract the rest
// of the app programs against. Everything in `src/character/` implements these
// types; nothing outside it needs to know how KAI is drawn.
//
// KAI is an original character (a "kernel" — a squircle core with a single
// horizontal iris band and orbiting ticks). It is not derived from any upstream
// artwork: the geometry, palette, shapes and animation curves here were written
// for KAI.
//
// MIT.

import type { BotEmoteName, BotStateName } from "../core/layout";
import type { EaseFn } from "../core/anim";


/** Shapes the iris band can take. Drives both the island and the mini bots. */
export type EyeShape =
  | "pill"
  | "wide"
  | "dot"
  | "line"
  | "flat"
  | "happy"
  | "closed"
  | "spiral"
  | "heart"
  | "star"
  | "tired"
  | "wink"
  | "cup";

export type BadgeKind = "dots" | "bang" | "question" | "dot";

export interface Badge {
  kind: BadgeKind;
  color: RGB;
}

/** Linear RGB, components 0…1. */
export type RGB = readonly [number, number, number];

// ── Character state vocabulary ────────────────────────────────────────────────
//
// The directive's runtime state set, mapped to the CLOSEST EXISTING orb pose from
// the supplied asset's NM list. Kept here (not in core/layout.ts) because the
// character module owns its own state union; the legacy `BotStateName` values are
// a subset of `KaiStateName`, so old call sites still typecheck.
//
// STATE            → ORB POSE        (why)
// IDLE             → idle            the persistent idle glance/blink loop
// LISTENING        → listening       calm → attentive → soft
// THINKING         → thinking        asym → intense → calm (the thinking theme)
// PLANNING         → planning        = thinking (source alias SC.planning)
// RESEARCHING      → scan            sideL/sideglance sweep (source's "searching")
// BROWSING         → toolcall        determined → sideglance (a tool runs)
// CODING           → working         determined/sideglance + "Working" chip (+ laptop)
// WORKING          → working         the generic focused-work face
// USING_TOOL       → toolcall        a tool call, tool not further specified
// USING_CLI        → executing       = working (source alias SC.executing)
// USING_BROWSER    → scan            a page sweep is the same gaze as scanning
// USING_CUA        → toolcall        a tool call driving the machine
// DELEGATING       → multiagent      proc1 → proc2 (one subagent)
// MULTI_AGENT      → multiagent      proc1 → proc2 (≥2 subagents at once)
// WAITING          → waiting         calm → sideglance (persistent)
// WAITING_APPROVAL → needsuser       attentive "asks for help" (persistent)
// NEEDS_USER       → needsuser       the same "asks for help" face; the specific
//                                    reason (approval/mission/worker/auth) is
//                                    carried by the island's attention surface
// LEARNING         → idea            intense → surprised → happy (eureka)
// BUILDING_SKILL   → executing       focused construction (= working)
// RECOVERING       → verifying       skeptical → sideglance → skeptical (re-check)
// SUCCESS          → success         happy → calm → >idle (short, returns to idle)
// ERROR            → error           small → sad (short; max-duration safeguard)
// OFFLINE          → sleeping        sleepy, persistent
//
// Source-pose sharing is deliberate: the source has six faces for the ten
// tool/activity states (scan, toolcall, working/executing, verifying, multiagent,
// idea), so two states may show the same source pose rather than inventing one.
// Legacy BotStateName extras: searching→scan, approval→needsuser,
// question→confirmation, finished→success, ratelimit→warning, sleeping→sleeping,
// dizzy→rolling.

export const KaiStates = {
  IDLE: "idle",
  LISTENING: "listening",
  THINKING: "thinking",
  PLANNING: "planning",
  RESEARCHING: "researching",
  BROWSING: "browsing",
  CODING: "coding",
  WORKING: "working",
  USING_TOOL: "using_tool",
  USING_CLI: "using_cli",
  USING_BROWSER: "using_browser",
  USING_CUA: "using_cua",
  DELEGATING: "delegating",
  MULTI_AGENT: "multi_agent",
  WAITING: "waiting",
  WAITING_APPROVAL: "waiting_approval",
  LEARNING: "learning",
  BUILDING_SKILL: "building_skill",
  RECOVERING: "recovering",
  NEEDS_USER: "needs_user",
  SUCCESS: "success",
  ERROR: "error",
  OFFLINE: "offline",
} as const;

/** Every accepted state: the directive set (either case) plus the legacy names. */
export type KaiStateName =
  | keyof typeof KaiStates
  | (typeof KaiStates)[keyof typeof KaiStates]
  | BotStateName;

const KAI_STATE_POSE_BASE: Record<string, string> = {
  idle: "idle",
  listening: "listening",
  thinking: "thinking",
  planning: "planning",
  // The widened runtime vocabulary → the CLOSEST EXISTING source pose (never a
  // new pose). Several states share a source pose where the source has no
  // finer-grained face; the sharing is deliberate and listed in the table above.
  researching: "scan",          // NM 33 — sideL/sideglance sweep (searching)
  browsing: "toolcall",         // NM 13 — determined→sideglance, a tool runs
  coding: "working",            // NM 5  — determined/sideglance + Working chip (+ laptop)
  using_cli: "executing",       // NM 12 — alias of working (running a command)
  using_browser: "scan",        // NM 33 — a page sweep is the same gaze as scanning
  using_cua: "toolcall",        // NM 13 — a tool call drives the machine
  multi_agent: "multiagent",    // NM 17 — proc1→proc2, delegating through workers
  learning: "idea",             // NM 32 — intense→surprised→happy (eureka)
  building_skill: "executing",  // NM 12 — focused construction
  recovering: "verifying",      // NM 14 — skeptical→sideglance→skeptical (re-checking)
  working: "working",
  using_tool: "toolcall",
  delegating: "multiagent",
  waiting: "waiting",
  waiting_approval: "needsuser",
  // "KAI needs you" shares the attentive "asks for help" face; the structured
  // reason is named by the island's attention surface, not by the orb.
  needs_user: "needsuser",
  success: "success",
  error: "error",
  offline: "sleeping",
  // Legacy BotStateName values.
  searching: "scan",
  approval: "needsuser",
  question: "confirmation",
  finished: "success",
  ratelimit: "warning",
  sleeping: "sleeping",
  dizzy: "rolling",
};

/** The auditable state → pose table, including the upper-case directive names. */
export const KAI_STATE_POSE: Record<string, string> = {
  ...KAI_STATE_POSE_BASE,
  ...Object.fromEntries(Object.entries(KAI_STATE_POSE_BASE).map(([k, v]) => [k.toUpperCase(), v])),
};

/** Resolves any accepted state name to the orb pose it drives. */
export function poseForState(state: string): string {
  return KAI_STATE_POSE[state] ?? KAI_STATE_POSE[state.toLowerCase()] ?? "idle";
}

export type TweenKey = readonly [target: number, durationMs: number, ease: EaseFn];

/** Every animated scalar. `anim()` writes straight onto the engine, so the keys
 *  must name number-valued fields of `KaiEngine`. */
export type PropKey =
  | "yaw"
  | "pitch"
  | "roll"
  | "tilt"
  | "open"
  | "sx"
  | "sy"
  | "oy"
  | "ox"
  | "tint"
  | "morph"
  | "orbit"
  | "blush"
  | "es"
  | "badgeS";

/** Everything that makes one state look different from another. */
export interface BotStateCfg {
  color: RGB;
  tint: number;
  eye: EyeShape;
  badge: Badge | null;
  bounces: boolean;
  scans: boolean;
  breathes: boolean;
  zz: boolean;
  sweat: boolean;
  look: readonly [number, number] | null;
  tilt: number;
  /** Orbiting ticks per second — the "how hard is KAI working" dial. */
  orbitSpeed: number;
}

export type ParticleType = "shard" | "spark" | "pulse" | "heart" | "star" | "sweat" | "z";

// ── Palette ───────────────────────────────────────────────────────────────────

// The core reads dark on light desktops and light on dark ones: a deep
// indigo-graphite body with a cyan rim, so the island's edge is legible either way.
export const CORE_TOP: RGB = [0.137, 0.161, 0.259]; // #232A44
export const CORE_BOTTOM: RGB = [0.055, 0.067, 0.125]; // #0E1120
export const RIM: RGB = [0.706, 0.898, 1.0]; // #B4E5FF
export const BAND: RGB = [0.851, 0.961, 1.0]; // #D9F5FF
export const INK_DARK = "rgb(8,10,18)";

const C = {
  idle: [0.639, 0.714, 0.835] as RGB,
  working: [0.231, 0.62, 1] as RGB,
  thinking: [0.545, 0.361, 0.965] as RGB,
  searching: [0.388, 0.396, 0.949] as RGB,
  approval: [0.961, 0.647, 0.141] as RGB,
  question: [0.133, 0.827, 0.933] as RGB,
  error: [0.957, 0.314, 0.369] as RGB,
  finished: [0.204, 0.831, 0.6] as RGB,
  ratelimit: [0.984, 0.573, 0.235] as RGB,
  sleeping: [0.475, 0.522, 0.612] as RGB,
  dizzy: [0.957, 0.447, 0.714] as RGB,
};

const base = {
  bounces: false,
  scans: false,
  breathes: false,
  zz: false,
  sweat: false,
  look: null,
  tilt: 0,
  orbitSpeed: 0.06,
};

export const BOT_STATES: Record<BotStateName, BotStateCfg> & { needs_user: BotStateCfg } = {
  idle: { ...base, color: C.idle, tint: 0.1, eye: "pill", badge: null },
  working: {
    ...base, color: C.working, tint: 0.72, eye: "pill",
    badge: { kind: "dots", color: C.working }, orbitSpeed: 1.5,
  },
  thinking: {
    ...base, color: C.thinking, tint: 0.72, eye: "pill",
    badge: { kind: "dots", color: C.thinking }, look: [0.55, 0.55], orbitSpeed: 0.9,
  },
  searching: {
    ...base, color: C.searching, tint: 0.72, eye: "pill",
    badge: { kind: "dots", color: C.searching }, scans: true, orbitSpeed: 2.2,
  },
  approval: {
    ...base, color: C.approval, tint: 0.78, eye: "wide",
    badge: { kind: "bang", color: C.approval }, bounces: true, orbitSpeed: 0.4,
  },
  question: {
    ...base, color: C.question, tint: 0.75, eye: "pill",
    badge: { kind: "question", color: C.question }, tilt: 0.17, orbitSpeed: 0.25,
  },
  error: {
    ...base, color: C.error, tint: 0.78, eye: "flat",
    badge: { kind: "dot", color: C.error }, orbitSpeed: 0,
  },
  finished: {
    ...base, color: C.finished, tint: 0.35, eye: "happy",
    badge: { kind: "dot", color: C.finished }, orbitSpeed: 0.9,
  },
  ratelimit: {
    ...base, color: C.ratelimit, tint: 0.72, eye: "tired",
    badge: { kind: "dot", color: C.ratelimit }, sweat: true, orbitSpeed: 0.15,
  },
  sleeping: {
    ...base, color: C.sleeping, tint: 0.3, eye: "closed", badge: null,
    breathes: true, zz: true, orbitSpeed: 0.02,
  },
  dizzy: {
    ...base, color: C.dizzy, tint: 0.7, eye: "spiral", badge: null, orbitSpeed: 5,
  },
  // "KAI needs you": the same amber, wide-eyed, bouncing "asks for help" posture
  // as an approval — a human must look. The orb pose is `needsuser` (see the
  // state→pose table above); this entry gives the engine the matching colour,
  // badge and orbit speed so the face is not a colourless fallback.
  needs_user: {
    ...base, color: C.approval, tint: 0.78, eye: "wide",
    badge: { kind: "bang", color: C.approval }, bounces: true, orbitSpeed: 0.4,
  },
};

/** State → sound. The island plays the sound when a state becomes the focus. */
export const STATE_SOUND: Partial<Record<BotStateName, string>> = {
  working: "work",
  thinking: "think",
  searching: "search",
  approval: "approval",
  question: "question",
  error: "error",
  finished: "finish",
  ratelimit: "rate",
  sleeping: "sleep",
  dizzy: "dizzy",
};

export const EMOTE_EYE: Record<BotEmoteName, EyeShape> = {
  love: "heart",
  surprised: "dot",
  proud: "star",
  wink: "wink",
  yawn: "tired",
  happy: "happy",
  annoyed: "line",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

export function hexToRGB(hex: string): RGB {
  const h = hex.replace("#", "");
  const v = parseInt(h, 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

export function rgba(c: RGB, a = 1): string {
  return `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;
}

export function mix3(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export const FONT = `system-ui, "Segoe UI Variable Text", "Segoe UI", sans-serif`;
