// The orb's mood — the presence's adapter onto KAI's ONE character system.
//
// This file used to own its own copy of the runtime machine and read the
// workspace slice itself. It is now a thin adapter: it feeds the real workspace
// stream into the shared `KaiCharacterSystem` (`../character/system.ts`) and
// exposes the piece of it the presence UI needs — the display mood, the
// AUTO/MANUAL feeling mode, the manual pick, and the appearance knobs.
//
// Nothing here invents a mood: a mood is entered only by a real transition of
// the shared machine (a real Core event, the real connection state, or a genuine
// local signal — composing, submitting, a settled turn). The only timer is the
// machine's own bounded safeguard, never a feeling trigger.
//
// The workspace still OWNS the transport; this module only folds its slice into
// the one system. `createOrb`'s canvases and this driver therefore share the
// same appearance and the same feeling — the ONE character KAI.

import {
  kaiCharacter,
  parseFeelingPrefs,
  type FeelingMode,
  type FeelingSnapshot,
} from "../../character/system";
import {
  withAccessory,
  withSkin,
  withTheme,
  type AccessoryName,
  type KaiVariant,
  type SkinName,
} from "../../character/variant";
import type { Workspace, WorkspaceSlice } from "../../workspace";
import type { KaiRuntimeState } from "../../core/runtime-state";
import type { Mood } from "./orb";

export type { FeelingMode } from "../../character/system";
export { FEELINGS, feelingLabel } from "../../character/system";

/**
 * KAI's runtime state → the presence design's mood vocabulary. SUCCESS is
 * "happy"; everything active is "focus"; a blocked runtime is "worry" (never a
 * silent idle).
 */
export function moodForRuntime(state: KaiRuntimeState): Mood {
  switch (state) {
    case "IDLE":
      return "idle";
    case "LISTENING":
      return "listen";
    case "THINKING":
    case "PLANNING":
    case "LEARNING":
    case "RECOVERING":
      return "think";
    case "RESEARCHING":
    case "BROWSING":
    case "USING_BROWSER":
    case "USING_TOOL":
    case "WAITING":
      return "curious";
    case "CODING":
    case "WORKING":
    case "USING_CLI":
    case "USING_CUA":
    case "BUILDING_SKILL":
    case "DELEGATING":
    case "MULTI_AGENT":
      return "focus";
    case "WAITING_APPROVAL":
    case "NEEDS_USER":
      return "worry";
    case "SUCCESS":
      return "happy";
    case "ERROR":
      return "sad";
    case "OFFLINE":
      return "sleepy";
  }
}

export interface MoodState {
  mood: Mood;
  runtime: KaiRuntimeState;
  /** What KAI is actually showing (the manual pick, or the runtime). */
  resolved: KaiRuntimeState;
  cause: string | null;
  mode: FeelingMode;
}

/**
 * The live mood, and the AUTO/MANUAL + appearance controls the Feelings panel
 * drives. Subscribes to repaint; call the local signals from real actions.
 */
export class MoodDriver {
  private readonly system = kaiCharacter;
  private listeners = new Set<(s: MoodState) => void>();
  private last: MoodState;
  private unsubscribe: (() => void) | null = null;
  private timer: number | null = null;

  constructor(private readonly workspace: Workspace) {
    this.last = this.fromSnapshot(this.system.snapshot());
    // The driver is woken by the SYSTEM, not only the workspace, so a manual pick
    // / an appearance change repaints the same way a real event does.
    this.system.subscribe((s) => this.emit(this.fromSnapshot(s)));
  }

  private fromSnapshot(s: FeelingSnapshot): MoodState {
    return {
      mood: moodForRuntime(s.resolved),
      runtime: s.runtime,
      resolved: s.resolved,
      cause: s.cause,
      mode: s.mode,
    };
  }

  get mood(): Mood {
    return moodForRuntime(this.system.resolve());
  }
  get runtime(): KaiRuntimeState {
    return this.system.runtime;
  }
  get resolved(): KaiRuntimeState {
    return this.system.resolve();
  }
  get cause(): string | null {
    return this.system.transitionCause;
  }
  get mode(): FeelingMode {
    return this.system.mode;
  }
  get manual(): KaiRuntimeState | null {
    return this.system.manual;
  }
  get appearance(): KaiVariant {
    return this.system.appearance;
  }

  /** Fold the workspace slice in: real events + the real connection state. */
  private onSlice(slice: WorkspaceSlice): void {
    this.system.applySlice({ conn: slice.conn, events: slice.events });
  }

  start(): void {
    this.onSlice(this.workspace.getState());
    this.unsubscribe = this.workspace.subscribe((s) => this.onSlice(s));
    // The bounded safeguard (return a transient result to idle, an outage to
    // OFFLINE). A safety net, never the mechanism.
    this.timer = window.setInterval(() => this.system.tick(), 1000);
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
  }

  private emit(state: MoodState): void {
    this.last = state;
    for (const fn of this.listeners) {
      try {
        fn(state);
      } catch {
        /* a repaint must not break the driver */
      }
    }
  }

  subscribe(fn: (s: MoodState) => void): () => void {
    this.listeners.add(fn);
    fn(this.last);
    return () => this.listeners.delete(fn);
  }

  // ── mode / manual (the Feelings panel) ─────────────────────────────────────
  setMode(mode: FeelingMode): void {
    this.system.setMode(mode);
  }
  /** Hold a feeling for presentation — enters MANUAL mode. */
  selectFeeling(state: KaiRuntimeState): void {
    this.system.selectFeeling(state);
  }
  /** Return to automatic. */
  clearManual(): void {
    this.system.clearManual();
  }

  // ── appearance (the appearance editor) ─────────────────────────────────────
  setSkin(skin: SkinName): void {
    this.system.setAppearance(withSkin(this.system.appearance, skin));
  }
  setAccessory(accessory: AccessoryName): void {
    this.system.setAppearance(withAccessory(this.system.appearance, accessory));
  }
  setTheme(theme: string): void {
    this.system.setAppearance(withTheme(this.system.appearance, theme));
  }

  // ── genuine local signals ──────────────────────────────────────────────────
  setComposing(active: boolean): void {
    this.system.setComposing(active);
  }
  turnSubmitted(): void {
    this.system.turnSubmitted();
  }
  turnResolved(ok: boolean): void {
    this.system.turnResolved(ok);
  }
}

/** Re-exported so a caller can inspect persisted prefs without importing system. */
export { parseFeelingPrefs };
