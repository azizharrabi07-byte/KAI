// KAI — the ONE shared character system.
//
// Before this module there were two character *drivers* and they disagreed:
//   • the island drew the real canvas engine (`./engine.ts`) from the runtime
//     machine (`../core/runtime-state.ts`);
//   • the main workspace drew a CSS orb (`../shell/presence/orb.ts`) from a
//     second, thin wrapper of the same machine (`../shell/presence/mood.ts`).
//
// This module is the single source of truth they now share:
//
//   real Core events ──▶ KaiRuntimeMachine (AUTO)
//                              │
//   user pick ────────────────▶▶│  (MANUAL, held)
//                              ▼
//                     resolve() → one KaiRuntimeState
//                              ▼
//                   CharacterStateView(s)  (every mounted canvas)
//
// plus ONE appearance (`KaiVariant` from `./variant.ts`, the same
// `kai.appearance.v1` store the island and the settings window already read),
// broadcast to every mounted canvas.
//
// Honesty rules this file enforces:
//   • AUTO is driven ONLY by real events (the machine is event-driven; the one
//     timer is the machine's own bounded safeguard, never a feeling trigger).
//   • MANUAL holds the user's pick, but a real SAFETY state (offline, error,
//     approval needed, needs-user) OVERRIDES it — KAI must never hide a problem
//     behind a cosmetic smile.
//   • Nothing here invents a state: the feeling list is the runtime machine's
//     own `KaiRuntimeState` union, and a MANUAL pick is validated against it.
//
// The module is deliberately DOM-free (the canvas lives in `./canvas-view.ts`,
// the presence adapter in `../shell/presence/orb.ts`) so the whole resolution
// rule is unit-testable with a hand-built event.
//
// MIT.

import {
  KaiRuntimeMachine,
  RUNTIME_LABELS,
  type KaiRuntimeState,
  type RuntimeConnection,
} from "../core/runtime-state";
import { loadVariant, makeVariant, saveVariant, type KaiVariant } from "./variant";

export type FeelingMode = "AUTO" | "MANUAL";

/** One Core event, as the system needs it (a subset of the workspace row). */
export interface FeelingEventRow {
  id?: string;
  type: string;
  at?: string;
  payload?: unknown;
}

/** The slice of workspace state the system folds in. */
export interface FeelingSlice {
  conn: string;
  events: readonly FeelingEventRow[];
}

/** A canvas that repaints when the resolved feeling changes. */
export interface CharacterStateView {
  setState(state: KaiRuntimeState): void;
}

/** A canvas that repaints when KAI's appearance changes. */
export interface CharacterAppearanceView {
  setAppearance(variant: KaiVariant): void;
  /** When present, a view whose element left the DOM is pruned on the next broadcast. */
  isConnected?(): boolean;
}

export interface FeelingSnapshot {
  mode: FeelingMode;
  /** The user's held pick in MANUAL mode, or null. */
  manual: KaiRuntimeState | null;
  /** The machine's real state (AUTO), regardless of mode. */
  runtime: KaiRuntimeState;
  /** What KAI is actually showing right now. */
  resolved: KaiRuntimeState;
  cause: string | null;
  appearance: KaiVariant;
}

/**
 * Every feeling offered for MANUAL selection. This is the runtime machine's OWN
 * vocabulary, read from its union — not an invented list. A state that the
 * machine cannot enter is not offered.
 */
export const FEELINGS: readonly KaiRuntimeState[] = [
  "IDLE",
  "LISTENING",
  "THINKING",
  "PLANNING",
  "RESEARCHING",
  "BROWSING",
  "CODING",
  "WORKING",
  "USING_TOOL",
  "USING_CLI",
  "USING_BROWSER",
  "USING_CUA",
  "DELEGATING",
  "MULTI_AGENT",
  "WAITING",
  "WAITING_APPROVAL",
  "NEEDS_USER",
  "LEARNING",
  "BUILDING_SKILL",
  "RECOVERING",
  "SUCCESS",
  "ERROR",
  "OFFLINE",
];

const FEELING_SET: ReadonlySet<string> = new Set(FEELINGS);

/** The person-facing label for a feeling (KAI's own sentence). */
export function feelingLabel(state: KaiRuntimeState): string {
  return RUNTIME_LABELS[state];
}

/**
 * A real state that must always win over a cosmetic MANUAL pick. If KAI Core is
 * gone, KAI errored, or KAI is waiting on a human, the honest face is the state,
 * not the feeling the user parked it in.
 */
const SAFETY_OVERRIDE: ReadonlySet<KaiRuntimeState> = new Set([
  "OFFLINE",
  "ERROR",
  "WAITING_APPROVAL",
  "NEEDS_USER",
]);

export function isSafetyOverride(state: KaiRuntimeState): boolean {
  return SAFETY_OVERRIDE.has(state);
}

// ── Persistence — the same durable webview store the appearance uses ──────────

export const FEELINGS_KEY = "kai.feelings.v1";

/** The slice of the Storage API this module needs (injectable for tests). */
export interface FeelingStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStore(): FeelingStore | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

/** Parses the stored mode + manual pick, rejecting anything the machine can't enter. */
export function parseFeelingPrefs(
  raw: string | null,
): { mode: FeelingMode; manual: KaiRuntimeState | null } | null {
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  const manualRaw = d["manual"];
  const manual =
    typeof manualRaw === "string" && FEELING_SET.has(manualRaw) ? (manualRaw as KaiRuntimeState) : null;
  // A MANUAL mode with no valid pick is not MANUAL — it would show nothing.
  const mode: FeelingMode = d["mode"] === "MANUAL" && manual !== null ? "MANUAL" : "AUTO";
  return { mode, manual };
}

function runtimeConnection(conn: string): RuntimeConnection {
  return conn === "ONLINE" || conn === "DEGRADED" || conn === "OFFLINE" ? conn : "CONNECTING";
}

// ── The system ────────────────────────────────────────────────────────────────

export interface KaiCharacterOptions {
  machine?: KaiRuntimeMachine;
  store?: FeelingStore | null;
  appearance?: KaiVariant;
}

export class KaiCharacterSystem {
  private readonly machine: KaiRuntimeMachine;
  private readonly store: FeelingStore | null;
  private _mode: FeelingMode = "AUTO";
  private _manual: KaiRuntimeState | null = null;
  private _appearance: KaiVariant;
  private cause: string | null = null;

  private readonly stateViews = new Set<CharacterStateView>();
  private readonly appearanceViews = new Set<CharacterAppearanceView>();
  private readonly listeners = new Set<(s: FeelingSnapshot) => void>();

  private lastResolved: KaiRuntimeState;

  constructor(opts: KaiCharacterOptions = {}) {
    this.machine = opts.machine ?? new KaiRuntimeMachine();
    this.store = opts.store === undefined ? defaultStore() : opts.store;
    const prefs = parseFeelingPrefs(this.store?.getItem(FEELINGS_KEY) ?? null);
    if (prefs !== null) {
      this._mode = prefs.mode;
      this._manual = prefs.manual;
    }
    this._appearance = opts.appearance ?? loadVariant(this.store);
    this.machine.onTransition = (t) => {
      this.cause = t.cause;
      this.emit();
    };
    this.lastResolved = this.resolve();
  }

  // ── reads ──────────────────────────────────────────────────────────────────
  get mode(): FeelingMode {
    return this._mode;
  }
  get manual(): KaiRuntimeState | null {
    return this._manual;
  }
  get runtime(): KaiRuntimeState {
    return this.machine.state;
  }
  get appearance(): KaiVariant {
    return this._appearance;
  }
  get transitionCause(): string | null {
    return this.cause;
  }

  /**
   * The ONE resolution rule. MANUAL holds the user's pick *unless* the runtime is
   * in a safety state, in which case the real state wins.
   */
  resolve(): KaiRuntimeState {
    const runtime = this.machine.state;
    if (this._mode === "MANUAL" && this._manual !== null && !isSafetyOverride(runtime)) {
      return this._manual;
    }
    return runtime;
  }

  snapshot(): FeelingSnapshot {
    return {
      mode: this._mode,
      manual: this._manual,
      runtime: this.machine.state,
      resolved: this.resolve(),
      cause: this.cause,
      appearance: this._appearance,
    };
  }

  // ── real-event intake ────────────────────────────────────────────────────────
  /** Fold a whole workspace slice: the real connection state + every real event. */
  applySlice(slice: FeelingSlice): void {
    this.machine.setConnection(runtimeConnection(slice.conn));
    for (const row of slice.events) {
      this.machine.applyEvent({
        ...(row.id !== undefined ? { id: row.id } : {}),
        type: row.type,
        ...(row.at !== undefined ? { timestamp: row.at } : {}),
        ...(row.payload !== undefined ? { payload: row.payload } : {}),
      });
    }
    this.emit();
  }

  applyEvent(event: FeelingEventRow): void {
    this.machine.applyEvent({
      ...(event.id !== undefined ? { id: event.id } : {}),
      type: event.type,
      ...(event.at !== undefined ? { timestamp: event.at } : {}),
      ...(event.payload !== undefined ? { payload: event.payload } : {}),
    });
  }

  setConnection(conn: string): void {
    if (this.machine.setConnection(runtimeConnection(conn))) this.emit();
  }

  // ── genuine local signals ─────────────────────────────────────────────────
  setComposing(active: boolean): void {
    if (this.machine.setComposing(active)) this.emit();
  }
  turnSubmitted(): void {
    if (this.machine.turnSubmitted()) this.emit();
  }
  turnResolved(ok: boolean): void {
    if (this.machine.turnResolved(ok)) this.emit();
  }

  /** The bounded safeguard — never a mechanism, only a safety net. */
  tick(): void {
    this.machine.tick();
    this.emit();
  }

  // ── mode / manual ─────────────────────────────────────────────────────────
  /** AUTO = runtime-driven. MANUAL with no pick yet falls back to AUTO. */
  setMode(mode: FeelingMode): void {
    if (mode === "MANUAL" && this._manual === null) this._manual = this.machine.state;
    if (mode === this._mode) {
      this.persist();
      return;
    }
    this._mode = mode;
    this.persist();
    this.emit();
  }

  /** Select (and hold) a feeling — this enters MANUAL mode. */
  selectFeeling(state: KaiRuntimeState): void {
    if (!FEELING_SET.has(state)) return;
    this._manual = state;
    this._mode = "MANUAL";
    this.persist();
    this.emit();
  }

  /** Return to automatic, keeping the last pick remembered. */
  clearManual(): void {
    this._mode = "AUTO";
    this.persist();
    this.emit();
  }

  private persist(): void {
    try {
      this.store?.setItem(FEELINGS_KEY, JSON.stringify({ mode: this._mode, manual: this._manual }));
    } catch {
      /* a disabled store must not break the UI */
    }
  }

  // ── appearance ────────────────────────────────────────────────────────────
  /** Set KAI's appearance; persists to the shared `kai.appearance.v1` store. */
  setAppearance(variant: KaiVariant): void {
    this._appearance = makeVariant(variant);
    saveVariant(this._appearance, this.store);
    this.broadcastAppearance();
    this.emit();
  }

  // ── views ─────────────────────────────────────────────────────────────────
  /** A canvas that follows the resolved feeling (main KAI faces). */
  attachState(view: CharacterStateView): void {
    this.stateViews.add(view);
    try {
      view.setState(this.lastResolved);
    } catch {
      /* a view must not break the system */
    }
  }

  /** A canvas that follows KAI's appearance (every orb, including samples). */
  attachAppearance(view: CharacterAppearanceView): void {
    this.appearanceViews.add(view);
    try {
      view.setAppearance(this._appearance);
    } catch {
      /* a view must not break the system */
    }
  }

  detach(view: CharacterStateView | CharacterAppearanceView): void {
    this.stateViews.delete(view as CharacterStateView);
    this.appearanceViews.delete(view as CharacterAppearanceView);
  }

  subscribe(fn: (s: FeelingSnapshot) => void): () => void {
    this.listeners.add(fn);
    fn(this.snapshot());
    return () => this.listeners.delete(fn);
  }

  // ── emit ──────────────────────────────────────────────────────────────────
  private broadcastAppearance(): void {
    for (const view of [...this.appearanceViews]) {
      if (view.isConnected !== undefined && !view.isConnected()) {
        this.appearanceViews.delete(view);
        continue;
      }
      try {
        view.setAppearance(this._appearance);
      } catch {
        /* keep broadcasting to the rest */
      }
    }
  }

  private emit(): void {
    const resolved = this.resolve();
    this.lastResolved = resolved;
    for (const view of this.stateViews) {
      try {
        view.setState(resolved);
      } catch {
        /* a repaint must not break the system */
      }
    }
    const snap = this.snapshot();
    for (const fn of this.listeners) {
      try {
        fn(snap);
      } catch {
        /* a listener must not break the system */
      }
    }
  }

  /** Test/teardown helper. */
  reset(): void {
    this.machine.reset();
    this._mode = "AUTO";
    this._manual = null;
    this.cause = null;
    this.lastResolved = this.resolve();
  }
}

/**
 * The app-wide instance. One per webview — the island window and the main
 * window each fold the SAME Core event stream independently, but within a window
 * every surface (main workspace, agent appearance previews, the feelings lab)
 * shares this one instance and therefore one feeling and one appearance.
 */
export const kaiCharacter = new KaiCharacterSystem();
