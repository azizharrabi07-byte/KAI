// KAI — the complete character action registry.
//
// SOURCE OF TRUTH: app/assets/kai/KAI_matrix_orb_v17.html. The full written
// inventory (with file:line references) is app/assets/kai/KAI_ACTION_INVENTORY.md.
//
// The source character is not one pose per state — it is a set of 34 named poses
// (NM), each a timed step-sequence (SC) over 23 named expressions (EY), plus 11
// colour themes (THM), 3 skins (SKN), 8 accessories (FITS), 4 jump/flip physics
// descriptors (JD), a 30-face pose gallery (PZ), a 3-D eye rig (mode3), a
// shard/shell break-apart, glitch bars, the laptop/backpack/hands props, and the
// idle glance/blink/perk loops.
//
// This module names EVERY one of them and records the runtime KAI state(s) each
// answers to, so the engine can expose the whole set. The relation is
// state → [visual actions] → pose sequence → animation timing: one runtime state
// legitimately maps to several appropriate actions; the engine chooses one
// deliberately (event-driven rotation or an explicit `playAction`), never by a
// random timer.
//
// MIT.

import {
  ORB_POSES,
  SC,
  EY,
  THM,
  TMAP,
  SKN,
  JD,
  type Step,
  type SkinName,
  type AccessoryName,
} from "./orb";

/** Every runtime state the character answers to: the directive set, the legacy
 *  BotStateName values, and the pose-only names the source's own buttons use. */
export type KaiActionState = string;

export type KaiActionKind =
  | "pose"        // an SC step-sequence (NM)
  | "movement"    // an SC sequence with JD physics
  | "expression"  // a bare EY expression
  | "interaction" // hit / drag / dblclick / funny
  | "idle-loop"   // glance / blink / perk / jitter
  | "gallery"     // a pose-z face (PZ)
  | "eye-mode"    // the 3-D eye rig (mode3)
  | "shatter"     // shard/shell break-apart
  | "prop"        // laptop / backpack / hands
  | "theme"       // a THM colour theme
  | "skin"        // a SKN skin
  | "accessory";  // a FITS accessory

export interface KaiAction {
  /** Stable action id (usually the source pose name). */
  name: string;
  kind: KaiActionKind;
  /** What it looks like. */
  meaning: string;
  /** The orb pose (SC key) this action plays; null for non-pose actions. */
  pose: string | null;
  /** The timed step-sequence, verbatim from SC ([] for non-pose actions). */
  steps: readonly Step[];
  /** Nominal duration of one pass, ms; null = persistent / no duration. */
  durationMs: number | null;
  /** True when the SC ends with the source's `>idle` sentinel. */
  returnsToIdle: boolean;
  /** Theme key (THM) or null. */
  theme: string | null;
  /** Runtime states this action is appropriate for (lower-case). */
  states: readonly KaiActionState[];
  /** Skins the action is valid for ("all" = every skin). */
  skins: readonly SkinName[] | "all";
  /** Accessories the action is valid with ("all" = every accessory). */
  accessories: readonly AccessoryName[] | "all";
  /** Source reference, file:line. */
  source: string;
}

const SRC = "KAI_matrix_orb_v17.html";

// ── Poses (NM, L389) ──────────────────────────────────────────────────────────
// meaning + the runtime states each pose answers to. Durations come straight
// from the SC table; nothing is invented.

interface PoseMeta { meaning: string; states: readonly string[]; theme?: string }

const POSE_META: Record<string, PoseMeta> = {
  idle: { meaning: "resting; persistent calm→relaxed→soft→attentive→curious loop with glance/blink/perk", states: ["idle", "listening"] },
  awake: { meaning: "bright wake-up: relaxed→attentive with a head-back kick, auto-returns to idle", states: ["listening", "idle"] },
  listening: { meaning: "attentive receiving: calm→attentive→soft, persistent", states: ["listening"] },
  thinking: { meaning: "asym→intense→calm with the energy core lit (thinking theme)", states: ["thinking", "planning", "waiting"] },
  working: { meaning: "determined/sideglance + the 'Working' chip (awake theme, laptop)", states: ["working", "delegating", "executing"] },
  waiting: { meaning: "calm→sideglance, glasses + backpack (persistent wait)", states: ["waiting"] },
  success: { meaning: "happy leap + green success rings, returns to idle", states: ["success", "finished", "done"] },
  warning: { meaning: "skeptical→asym→skeptical, amber theme, shake", states: ["ratelimit", "warning"] },
  error: { meaning: "small→sad with red glitch + tilt", states: ["error"] },
  sleeping: { meaning: "sleepy, dim, slow bob (persistent)", states: ["offline", "sleeping"] },
  planning: { meaning: "alias of thinking (SC.planning)", states: ["planning"] },
  executing: { meaning: "alias of working (SC.executing)", states: ["executing", "working"] },
  toolcall: { meaning: "determined→sideglance (a tool runs)", states: ["using_tool", "toolcall", "searching"] },
  verifying: { meaning: "skeptical→sideglance→skeptical (verifying work)", states: ["verifying", "using_tool"] },
  blocked: { meaning: "blocked eyes, chin down (persistent, stuck)", states: ["blocked"] },
  needsuser: { meaning: "attentive double-prompt 'asks for help'", states: ["waiting_approval", "approval", "needsuser"] },
  multiagent: { meaning: "proc1→proc2 (delegating through workers)", states: ["delegating", "multiagent"] },
  confirmation: { meaning: "attentive nod (ty −5/+4), returns to idle", states: ["question", "confirmation"] },
  done: { meaning: "alias of success (SC.done)", states: ["done", "success"] },
  boot: { meaning: "startup: sleepy→line→sleepy→line→calm→surprised→calm→idle", states: ["boot"] },
  funny: { meaning: "the source's random BN picker; reachable but never auto-fired", states: ["funny"] },
  jump: { meaning: "crouch→ballistic leap→land (JD [1.6,0,0])", states: ["jump"] },
  backflip: { meaning: "back somersault (JD [2,1,0])", states: ["backflip"] },
  frontflip: { meaning: "forward somersault (JD [2,-1,0])", states: ["frontflip"] },
  spin: { meaning: "720° spin (JD [2.8,0,1])", states: ["spin"] },
  fight: { meaning: "bobbing combat with left/right hooks (orange theme)", states: ["fight"] },
  cross: { meaning: "attentive eye-cross", states: ["cross"] },
  derp: { meaning: "derpA→derpB wobble", states: ["derp"] },
  rolling: { meaning: "360° roll (dizzy)", states: ["dizzy", "rolling"] },
  doze: { meaning: "doze→startle awake", states: ["doze", "waiting"] },
  doubletake: { meaning: "side-glance double-take", states: ["doubletake"] },
  idea: { meaning: "intense→surprised→happy 'eureka' (core lit)", states: ["idea", "thinking"] },
  scan: { meaning: "sideL/sideglance sweep", states: ["searching", "scan", "using_tool"] },
  cool: { meaning: "skeptical→determined, chin up (ty −4)", states: ["cool", "waiting"] },
};

function seqDuration(steps: readonly Step[]): { durationMs: number | null; returnsToIdle: boolean } {
  let total = 0;
  let returnsToIdle = false;
  for (const s of steps) {
    if (s[0] === ">idle") { returnsToIdle = true; break; }
    total += s[1];
  }
  // A single 0-ms step (sleeping, blocked) is a persistent hold.
  const persistent = steps.length === 1 && steps[0][1] === 0;
  return { durationMs: persistent ? null : (total || null), returnsToIdle };
}

const KAI_ACTIONS: Record<string, KaiAction> = {};

// Poses / movements.
for (const name of ORB_POSES) {
  const meta = POSE_META[name];
  const steps = SC[name] ?? [];
  const { durationMs, returnsToIdle } = seqDuration(steps);
  const movement = name in JD;
  KAI_ACTIONS[name] = {
    name,
    kind: movement ? "movement" : "pose",
    meaning: meta?.meaning ?? name,
    pose: name,
    steps,
    durationMs,
    returnsToIdle,
    theme: meta?.theme ?? null,
    states: meta?.states ?? [name],
    skins: "all",
    accessories: "all",
    source: `${SRC} NM L389 / SC L124-155`,
  };
}

// Bare expressions (EY, L119).
for (const name of Object.keys(EY)) {
  KAI_ACTIONS[`expr:${name}`] = {
    name: `expr:${name}`,
    kind: "expression",
    meaning: `eye expression "${name}"`,
    pose: null,
    steps: [],
    durationMs: null,
    returnsToIdle: false,
    theme: null,
    states: ["idle"],
    skins: "all",
    accessories: "all",
    source: `${SRC} EY L119`,
  };
}

// Themes (THM, L362-372).
for (const name of Object.keys(THM)) {
  KAI_ACTIONS[`theme:${name}`] = {
    name: `theme:${name}`,
    kind: "theme",
    meaning: `colour theme "${name}"`,
    pose: null,
    steps: [],
    durationMs: null,
    returnsToIdle: false,
    theme: name,
    states: ["idle"],
    skins: "all",
    accessories: "all",
    source: `${SRC} THM L362-372`,
  };
}

// Skins (SKN, L391).
for (const name of Object.keys(SKN) as SkinName[]) {
  KAI_ACTIONS[`skin:${name}`] = {
    name: `skin:${name}`,
    kind: "skin",
    meaning: `body skin "${name}"`,
    pose: null,
    steps: [],
    durationMs: null,
    returnsToIdle: false,
    theme: null,
    states: ["idle"],
    skins: [name],
    accessories: "all",
    source: `${SRC} SKN L391`,
  };
}

// Accessories (FITS, L285-317).
const ACCESSORY_NAMES: AccessoryName[] = ["none", "hair", "cap", "bat", "phones", "cat", "crown", "halo"];
for (const name of ACCESSORY_NAMES) {
  KAI_ACTIONS[`acc:${name}`] = {
    name: `acc:${name}`,
    kind: "accessory",
    meaning: `accessory "${name}"`,
    pose: null,
    steps: [],
    durationMs: null,
    returnsToIdle: false,
    theme: null,
    states: ["idle"],
    skins: "all",
    accessories: [name],
    source: `${SRC} FITS L285-317`,
  };
}

// Pose-z gallery (PZ / KEEP / NMZ, L358-360).
const PZ_KEEP = [
  "S1", "S2", "S4", "S6", "S7", "S8", "S9", "S10", "S11", "S12", "S13", "S17",
  "V2", "V3", "V7", "V8", "V9", "V13", "V15", "V16", "V17", "V18", "V20", "V23",
  "V24", "V26", "V29", "V30", "V31", "V32",
] as const;
const PZ_LABELS: Record<string, string> = {
  S1: "Planning", S9: "Need your help", V3: "Making progress", V9: "Something went wrong",
  V18: "Ultrawork", V20: "Ultrawork", V15: "Eureka", V16: "Sent", V23: "Wink",
};
export { PZ_KEEP, PZ_LABELS };
for (const key of PZ_KEEP) {
  KAI_ACTIONS[`gallery:${key}`] = {
    name: `gallery:${key}`,
    kind: "gallery",
    meaning: `pose-z face ${key}${PZ_LABELS[key] ? ` · ${PZ_LABELS[key]}` : ""}`,
    pose: null,
    steps: [],
    durationMs: null,
    returnsToIdle: false,
    theme: TMAP[key] ?? "aqua",
    states: ["idle"],
    skins: "all",
    accessories: "all",
    source: `${SRC} PZ L358-360 / TMAP L361`,
  };
}

// Standalone actions.
KAI_ACTIONS["eye-mode"] = {
  name: "eye-mode", kind: "eye-mode", meaning: "3-D eye rig (mode3): eyes projected onto the sphere",
  pose: null, steps: [], durationMs: null, returnsToIdle: false, theme: null,
  states: ["idle"], skins: "all", accessories: "all", source: `${SRC} #e3 L66 / L226-228`,
};
KAI_ACTIONS["shatter"] = {
  name: "shatter", kind: "shatter", meaning: "shard/shell break-apart: 7 wedges fly apart",
  pose: null, steps: [], durationMs: null, returnsToIdle: false, theme: null,
  states: ["error"], skins: "all", accessories: "all", source: `${SRC} #shards/#shell L64-65 / L266-273`,
};
for (const p of ["laptop", "backpack", "hands"] as const) {
  KAI_ACTIONS[`prop:${p}`] = {
    name: `prop:${p}`, kind: "prop", meaning: `work prop "${p}"`,
    pose: null, steps: [], durationMs: null, returnsToIdle: false, theme: null,
    states: ["working", "waiting", "success"], skins: "all", accessories: "all",
    source: `${SRC} #lap/#bk/#hnd L74-85 / L211,229-230`,
  };
}
for (const i of ["hit", "drag", "jump-dblclick", "funny-auto"] as const) {
  KAI_ACTIONS[`interaction:${i}`] = {
    name: `interaction:${i}`, kind: "interaction", meaning: `interaction "${i}"`,
    pose: i === "jump-dblclick" ? "jump" : null, steps: [], durationMs: null, returnsToIdle: false, theme: null,
    states: ["idle"], skins: "all", accessories: "all", source: `${SRC} L246-265, L390`,
  };
}
for (const l of ["blink", "glance", "perk", "jitter"] as const) {
  KAI_ACTIONS[`idle:${l}`] = {
    name: `idle:${l}`, kind: "idle-loop", meaning: `idle loop "${l}"`,
    pose: null, steps: [], durationMs: null, returnsToIdle: false, theme: null,
    states: ["idle"], skins: "all", accessories: "all", source: `${SRC} L98,170-176`,
  };
}

export { KAI_ACTIONS };

/** The full action list, in a stable order (poses first, in NM order). */
export const ACTION_NAMES: readonly string[] = Object.keys(KAI_ACTIONS);

export function actionInfo(name: string): KaiAction | null {
  return KAI_ACTIONS[name] ?? KAI_ACTIONS[`expr:${name}`] ?? null;
}

// ── runtime state → visual actions ────────────────────────────────────────────
//
// One state maps to SEVERAL appropriate actions. The first entry is the default
// (what `setState` shows); the rest are deliberate alternates the engine can
// rotate to on a real event (`cycleAction`) or a caller can name (`playAction`).

export const STATE_ACTIONS: Record<string, readonly string[]> = {
  // directive runtime states
  idle: ["idle", "scan", "doubletake", "idea", "cool", "cross", "derp"],
  listening: ["listening", "awake", "idle"],
  thinking: ["thinking", "planning", "idea", "scan", "verifying"],
  planning: ["planning", "thinking", "idea"],
  working: ["working", "executing", "toolcall", "scan", "verifying"],
  using_tool: ["toolcall", "working", "verifying", "scan"],
  delegating: ["multiagent", "working", "executing"],
  waiting: ["waiting", "doze", "cool"],
  waiting_approval: ["needsuser", "confirmation", "blocked"],
  needs_user: ["needsuser", "confirmation", "blocked"],
  success: ["success", "done", "idea", "jump"],
  error: ["error", "warning", "blocked", "derp"],
  offline: ["sleeping", "doze"],

  // legacy BotStateName values
  searching: ["scan", "toolcall", "working"],
  approval: ["needsuser", "confirmation"],
  question: ["confirmation", "needsuser"],
  finished: ["success", "done", "jump", "idea"],
  ratelimit: ["warning", "error", "blocked"],
  sleeping: ["sleeping", "doze"],
  dizzy: ["rolling", "derp", "fight"],

  // pose-only states (source buttons)
  awake: ["awake", "listening"],
  boot: ["boot"],
  funny: ["funny", "derp", "cross", "cool", "doubletake"],
  jump: ["jump"], backflip: ["backflip"], frontflip: ["frontflip"], spin: ["spin"], fight: ["fight"],
  cross: ["cross"], derp: ["derp"], rolling: ["rolling"], doze: ["doze"],
  doubletake: ["doubletake"], idea: ["idea"], scan: ["scan"], cool: ["cool"],
  warning: ["warning"], blocked: ["blocked"], needsuser: ["needsuser"],
  confirmation: ["confirmation"], multiagent: ["multiagent"], verifying: ["verifying"],
  toolcall: ["toolcall"], done: ["done", "success"], executing: ["executing", "working"],
};

/** Every action appropriate for a runtime state (lower-cased lookup). */
export function stateActions(state: string): readonly string[] {
  const key = String(state).toLowerCase();
  return STATE_ACTIONS[key] ?? ["idle"];
}

/**
 * Deterministic rotation through a state's actions. `step` is supplied by the
 * caller (an event counter, not a clock), so the same event always yields the
 * same action and nothing is chosen by a random timer.
 */
export function pickAction(state: string, step: number): string {
  const list = stateActions(state);
  const i = ((step % list.length) + list.length) % list.length;
  return list[i];
}
