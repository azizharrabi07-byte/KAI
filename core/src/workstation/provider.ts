// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The workstation-provider seam: one provider-agnostic contract for driving a
 * GUI workspace, with the CUA driver as ONE implementation rather than the
 * definition of the interface.
 *
 * WHY this exists next to `capabilities/computer`. That module is the CUA
 * foundation: a transport plus the safety orchestrator (human hold, dedupe,
 * transition protection) and a deliberately narrow four-verb action union
 * (click / type / keypress / scroll). This seam is the layer above it and asks
 * a different question: what does a *provider of a workstation* have to be able
 * to answer, whoever provides it? So the surface is observe (screenshot AND
 * accessibility tree, because the tree lies on some surfaces and the pixels lie
 * on others) and act (click / type / key / hotkey / scroll / drag), and the
 * answers carry an honest verdict about whether the requested change actually
 * landed.
 *
 * THE CENTRAL RULE: a delivered event is not an applied change. On Windows the
 * driver can post WM_LBUTTONDOWN to a UWP window and the window will silently
 * ignore it; it can PostMessage WM_CHAR to a Chromium content area and the
 * renderer will never see it. "We sent it" and "it happened" are different
 * facts, and a contract that cannot say so will eventually report success for
 * an action that did nothing. Hence `effect` and `verified`, with
 * `unverifiable` as a first-class, expected answer — not an error.
 *
 * The `effect` vocabulary is deliberately the same five words the installed
 * driver already uses for its own action results (`confirmed`, `partial`,
 * `unverifiable`, `suspected_noop`, `refused`), so the mapping in `cua.ts` is a
 * translation and not an invention. See `docs/architecture/KAI_WORKSTATION.md`.
 */

import type { KaiError, KaiErrorCode } from "../shared/contracts.ts";
import { nowIso } from "../shared/contracts.ts";

// ── Verdicts ──────────────────────────────────────────────────────────────────

/**
 * What a call actually achieved.
 *
 * - `confirmed`      — the provider has publishable readback (a value it read
 *                      back, or a window change it can point at). The ONLY
 *                      value for which `verified` is true.
 * - `partial`        — only some of the work landed (e.g. N of M characters
 *                      delivered).
 * - `unverifiable`   — the call was delivered but the provider cannot prove the
 *                      effect. This is the honest default and must never be
 *                      upgraded to `confirmed` without evidence.
 * - `suspected_noop` — the available evidence suggests nothing useful changed.
 * - `refused`        — the provider deliberately did not deliver (policy, a
 *                      stale handle, an unusable route).
 */
export type WorkstationEffect = "confirmed" | "unverifiable" | "suspected_noop" | "partial" | "refused";

/** The routes a provider may use. Cross-platform names only: callers must not
 * branch on private OS transport names. Mirrors the driver's own vocabulary. */
export type WorkstationRoute = "accessibility" | "synthetic_events" | "global_input" | "dom" | "trusted_input";

/** A harness instruction to change approach. NEVER an automatic retry. */
export interface WorkstationEscalation {
  target: "pixel" | "foreground" | "page" | "session";
  reason?: string;
}

/**
 * The shared verdict every result value carries.
 *
 * `verified` is DERIVED, never supplied: it is true exactly when `effect` is
 * `confirmed`. Construct outcomes through {@link outcome} so the two can never
 * disagree — a hand-written `{ effect: "unverifiable", verified: true }` is the
 * exact bug this contract exists to prevent.
 */
export interface WorkstationOutcome {
  effect: WorkstationEffect;
  verified: boolean;
  route?: WorkstationRoute;
  detail?: string;
  /** Evidence kinds the provider actually observed, e.g. `"value_readback"`. */
  evidence?: readonly string[];
  escalation?: WorkstationEscalation;
}

export interface OutcomeInput {
  effect: WorkstationEffect;
  route?: WorkstationRoute;
  detail?: string;
  evidence?: readonly string[];
  escalation?: WorkstationEscalation;
}

/** Build an outcome. `verified` is computed from `effect`; callers cannot set it. */
export function outcome(input: OutcomeInput): WorkstationOutcome {
  const value: WorkstationOutcome = { effect: input.effect, verified: input.effect === "confirmed" };
  if (input.route !== undefined) value.route = input.route;
  if (input.detail !== undefined) value.detail = input.detail;
  if (input.evidence !== undefined) value.evidence = input.evidence;
  if (input.escalation !== undefined) value.escalation = input.escalation;
  return value;
}

/**
 * The invariant, as a predicate. Exported so both providers and their tests can
 * assert it rather than restate it.
 */
export function isVerifiedOutcome(value: WorkstationOutcome): boolean {
  return value.verified === (value.effect === "confirmed");
}

// ── Failures ──────────────────────────────────────────────────────────────────

/**
 * Why a call produced no verdict.
 *
 * This is deliberately NOT `KaiError`: the Core's error codes are a frozen,
 * closed union tuned for agent runs, and none of them can express "the driver
 * refused because the accessibility handle was stale" without overloading
 * `detail`. A provider-agnostic seam needs its own closed vocabulary, and
 * {@link toKaiError} bridges it back into the Core when a caller needs that.
 */
export type WorkstationFailureKind =
  /** No driver binary, or the daemon is not running. */
  | "unavailable"
  /** A driver was found but its version is below the supported floor. */
  | "unsupported"
  /** The call exceeded its bounded budget. */
  | "timeout"
  /** The driver or the OS denied the call. */
  | "permission"
  /** A snapshot, element token or session was superseded. */
  | "stale_session"
  /** The target could not be resolved (window/pid/element). */
  | "target"
  /** The selected delivery route deliberately did not deliver. */
  | "route"
  /** Output that could not be parsed, or a shape the provider does not know. */
  | "protocol"
  /** A bug in this layer. */
  | "internal";

export interface WorkstationFailure {
  kind: WorkstationFailureKind;
  message: string;
  retryable: boolean;
  detail?: string;
  /** The driver's own machine-readable code, when it supplied one. */
  driverCode?: string;
  /**
   * The driver's delivery verdict, when it stated one. NEVER `confirmed`: a
   * failure is by definition a call that could not establish success, so the
   * type excludes it rather than relying on callers to check.
   */
  effect?: Exclude<WorkstationEffect, "confirmed">;
}

export type WorkstationResult<T> = { ok: true; value: T } | { ok: false; error: WorkstationFailure };

export function ok<T>(value: T): WorkstationResult<T> {
  return { ok: true, value };
}

export function fail<T = never>(error: WorkstationFailure): WorkstationResult<T> {
  return { ok: false, error };
}

export interface FailureInput {
  kind: WorkstationFailureKind;
  message: string;
  retryable?: boolean;
  detail?: string;
  driverCode?: string;
  effect?: Exclude<WorkstationEffect, "confirmed">;
}

export function failure(input: FailureInput): WorkstationFailure {
  const error: WorkstationFailure = {
    kind: input.kind,
    message: input.message,
    retryable: input.retryable ?? false,
  };
  if (input.detail !== undefined) error.detail = input.detail;
  if (input.driverCode !== undefined) error.driverCode = input.driverCode;
  if (input.effect !== undefined) error.effect = input.effect;
  return error;
}

const KAI_CODE_BY_KIND: Record<WorkstationFailureKind, KaiErrorCode> = {
  unavailable: "AGENT_NOT_LISTENING",
  unsupported: "AGENT_CAPABILITY_MISSING",
  timeout: "AGENT_TIMEOUT",
  permission: "POLICY_DENIED",
  stale_session: "AGENT_RUN_ABANDONED",
  target: "VALIDATION_FAILED",
  route: "AGENT_RUN_FAILED",
  protocol: "AGENT_BAD_RESPONSE",
  internal: "INTERNAL",
};

/**
 * Bridge a workstation failure into the Core's frozen error contract.
 *
 * The nuance the Core's closed code union cannot carry (which kind of failure,
 * and the driver's own code) is preserved in `detail`, which is exactly how
 * `capabilities/computer/errors.ts` solved the same problem.
 */
export function toKaiError(error: WorkstationFailure): KaiError {
  const parts = [`workstation:${error.kind}`];
  if (error.driverCode !== undefined) parts.push(`driver_code=${error.driverCode}`);
  if (error.detail !== undefined) parts.push(error.detail);
  return {
    code: KAI_CODE_BY_KIND[error.kind],
    message: error.message,
    retryable: error.retryable,
    at: nowIso(),
    detail: parts.join(" | "),
  };
}

// ── Targets ───────────────────────────────────────────────────────────────────

/** A native window: the process that owns it and the window handle itself. */
export interface WindowRef {
  pid: number;
  windowId: number;
}

export interface ElementFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** What to observe. Exactly one of a window or the whole desktop. */
export type ObservationTarget =
  | {
      kind: "window";
      window: WindowRef;
      /** Bound the accessibility walk. Both omitted = the driver's defaults. */
      maxElements?: number;
      maxDepth?: number;
      /** Skip the pixel grab (cheap re-index before an element action). */
      includeScreenshot?: boolean;
    }
  | { kind: "desktop" };

/**
 * Where an action lands. Every action names EXACTLY ONE of these — there is no
 * variant that carries two addressing modes, and no free-form escape hatch.
 *
 * Note what is absent on purpose: there is no URL, no shell command, no argv,
 * and no "run this" target. A provider built on this union cannot be handed a
 * caller-supplied URL or arbitrary argument list, because the union has nowhere
 * to put one. Navigation is a browser-capability concern, not a workstation
 * input concern.
 */
export type ActionTarget =
  /** An accessibility element from a prior observe. Carries the snapshot it came from. */
  | { kind: "element"; window: WindowRef; elementIndex: number; snapshotId: string; token?: string }
  /** Window-local screenshot pixels, for canvas / video / custom-drawn surfaces. */
  | { kind: "point"; window: WindowRef; x: number; y: number }
  /** Screen-absolute pixels, for a desktop-scope action. */
  | { kind: "desktop-point"; x: number; y: number }
  /** The window's focused region, with no specific element (type / key / scroll). */
  | { kind: "window"; window: WindowRef }
  /** The current foreground application (type / key / scroll). */
  | { kind: "desktop" };

export type ActionTargetKind = ActionTarget["kind"];

export type MouseButton = "left" | "right" | "middle";
export type ScrollDirection = "up" | "down" | "left" | "right";
export type ScrollUnit = "line" | "page";

/**
 * How input is delivered.
 *
 * `background` is the mandatory first attempt: it never raises or restacks the
 * target. `foreground` is an explicit escalation that briefly swaps the
 * foreground and restores it — it is never chosen preemptively, because a
 * provider that fronts windows by default steals the user's focus on every call.
 */
export type DeliveryMode = "background" | "foreground";

/**
 * One action. A closed union: a new capability cannot arrive without a
 * deliberate change here, and every member names exactly one target.
 */
export type WorkstationAction =
  | { kind: "click"; target: ActionTarget; button?: MouseButton; count?: number; deliveryMode?: DeliveryMode }
  | { kind: "type"; target: ActionTarget; text: string; delayMs?: number; deliveryMode?: DeliveryMode }
  | { kind: "key"; target: ActionTarget; key: string; modifiers?: readonly string[]; deliveryMode?: DeliveryMode }
  | { kind: "hotkey"; target: ActionTarget; keys: readonly string[]; deliveryMode?: DeliveryMode }
  | {
      kind: "scroll";
      target: ActionTarget;
      direction: ScrollDirection;
      amount?: number;
      by?: ScrollUnit;
      deliveryMode?: DeliveryMode;
    }
  | {
      kind: "drag";
      target: ActionTarget;
      from: Point;
      to: Point;
      button?: MouseButton;
      durationMs?: number;
      steps?: number;
      deliveryMode?: DeliveryMode;
    };

export type ActionKind = WorkstationAction["kind"];

/** Targets that address a point. Used to reject actions that cannot carry one. */
const POINT_TARGETS: readonly ActionTargetKind[] = ["point", "desktop-point"];
/** Targets that address a window (with or without an element). */
const WINDOW_TARGETS: readonly ActionTargetKind[] = ["element", "point", "window"];

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Validate an action's target BEFORE any provider sees it.
 *
 * This is the provider-independent half of input safety: a malformed target is
 * refused here, so a provider can never be asked to translate nonsense into a
 * driver call. It returns a typed failure rather than throwing, so a caller
 * handles it like every other refusal.
 */
export function validateActionTarget(action: WorkstationAction): WorkstationFailure | null {
  const target = action.target;

  switch (target.kind) {
    case "element": {
      if (!isPositiveInt(target.window?.pid) || !isPositiveInt(target.window?.windowId)) {
        return failure({
          kind: "target",
          message: "element target requires a positive pid and windowId",
        });
      }
      if (!Number.isInteger(target.elementIndex) || target.elementIndex < 0) {
        return failure({ kind: "target", message: "element target requires a non-negative elementIndex" });
      }
      if (typeof target.snapshotId !== "string" || target.snapshotId.length === 0) {
        return failure({
          kind: "target",
          message: "element target requires the snapshotId the element was observed in",
          detail: "a provider cannot act on an element it was never shown; observe first",
        });
      }
      break;
    }
    case "point":
    case "desktop-point": {
      if (!isFiniteNumber(target.x) || !isFiniteNumber(target.y)) {
        return failure({ kind: "target", message: "point target requires finite x and y" });
      }
      if (target.kind === "point" && (!isPositiveInt(target.window?.pid) || !isPositiveInt(target.window?.windowId))) {
        return failure({ kind: "target", message: "point target requires a positive pid and windowId" });
      }
      break;
    }
    case "window": {
      if (!isPositiveInt(target.window?.pid) || !isPositiveInt(target.window?.windowId)) {
        return failure({ kind: "target", message: "window target requires a positive pid and windowId" });
      }
      break;
    }
    case "desktop":
      break;
  }

  // An action that carries no text or key has nothing to deliver to a point,
  // and one that carries text cannot address a bare pixel: the driver would
  // have to guess the focused element, which is how text lands in the wrong
  // application.
  if ((action.kind === "type" || action.kind === "key" || action.kind === "hotkey") && POINT_TARGETS.includes(target.kind)) {
    return failure({
      kind: "target",
      message: `a ${action.kind} action cannot target a bare pixel`,
      detail: "use an element target, a window target, or the desktop target",
    });
  }

  if (action.kind === "drag" && target.kind === "element") {
    return failure({
      kind: "target",
      message: "a drag action cannot target an element",
      detail: "drags are pixel gestures; address the window or the desktop",
    });
  }

  if (action.kind === "type" && typeof action.text !== "string") {
    return failure({ kind: "target", message: "a type action requires text" });
  }

  if (action.kind === "hotkey" && (!Array.isArray(action.keys) || action.keys.length < 2)) {
    return failure({
      kind: "target",
      message: "a hotkey action requires at least a modifier and one key",
    });
  }

  if (action.kind === "key" && (typeof action.key !== "string" || action.key.length === 0)) {
    return failure({ kind: "target", message: "a key action requires a key name" });
  }

  if (action.kind === "drag") {
    const { from, to } = action;
    if (!isFiniteNumber(from?.x) || !isFiniteNumber(from?.y) || !isFiniteNumber(to?.x) || !isFiniteNumber(to?.y)) {
      return failure({ kind: "target", message: "a drag action requires finite from/to points" });
    }
  }

  if (action.kind === "drag" && !WINDOW_TARGETS.includes(target.kind) && target.kind !== "desktop-point") {
    return failure({ kind: "target", message: "a drag action requires a window or desktop target" });
  }

  return null;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

// ── Observations ──────────────────────────────────────────────────────────────

/** One accessibility row. `index` is what an element target refers to. */
export interface AccessibilityElement {
  index: number;
  role: string;
  label?: string;
  value?: string;
  enabled?: boolean;
  selected?: boolean;
  /** UIA pattern names the provider can invoke on this element. */
  actions?: readonly string[];
  frame?: ElementFrame;
  depth?: number;
  /** Opaque handle from the provider, when it issues one. */
  token?: string;
}

export interface Screenshot {
  mimeType: string;
  width: number;
  height: number;
  /**
   * Base64 PNG. NULL means the provider withheld the pixels; it does not mean
   * the capture failed — `effect` says whether it did.
   */
  dataBase64: string | null;
}

export interface WindowSummary {
  pid: number;
  windowId: number;
  title: string;
  app?: string;
  bounds?: ElementFrame;
  minimized?: boolean;
  onScreen?: boolean;
}

export interface WorkstationObservation extends WorkstationOutcome {
  target: ObservationTarget;
  capturedAt: string;
  screenshot: Screenshot | null;
  elements: readonly AccessibilityElement[];
  treeMarkdown?: string;
  /** The handle an element target must quote back. */
  snapshotId?: string;
  /**
   * False when the accessibility walk was truncated (element budget or depth
   * cap) or could not be proven exhaustive. A caller must not read a missing
   * element as proof of absence when this is false.
   */
  complete: boolean;
  /** Populated for desktop observations. */
  windows?: readonly WindowSummary[];
}

export interface ActionReport extends WorkstationOutcome {
  action: ActionKind;
  target: ActionTargetKind;
  at: string;
  driverCode?: string;
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

/**
 * What a provider can honestly say about itself before anything is attempted.
 * An absent driver is a normal, reportable state — not an error and not an
 * exception. Reporting it plainly is what lets a caller degrade instead of
 * hanging.
 */
export interface ProviderAvailability {
  available: boolean;
  /** Reported version, or null when there is nothing to ask. */
  version: string | null;
  /** True when `version` is at or above the supported floor. */
  supported: boolean;
  /** True when the binary exists but its daemon is not reachable. */
  daemonRunning: boolean;
  detail?: string;
}

export interface ConnectInfo {
  version: string;
  platform: string;
  daemon: boolean;
  /** Tools the provider confirmed it can call. */
  capabilities: readonly string[];
}

export interface WorkstationStatus {
  connected: boolean;
  version: string | null;
  daemonRunning: boolean;
  /** The driver's authorization mode, e.g. `"standard"` or `"bounded"`. */
  permissionMode: string | null;
  /** Whether desktop-scope capture/input has been authorized this session. */
  desktopAuthorized: boolean;
  screen: { width: number; height: number } | null;
  session: string | null;
}

/**
 * The seam. Every method resolves; none throws. A provider that throws forces
 * every caller to wrap it, and a thrown error crossing this boundary is exactly
 * what the seam exists to remove.
 */
export interface WorkstationProvider {
  readonly id: string;
  readonly kind: "mock" | "cua";
  availability(): Promise<WorkstationResult<ProviderAvailability>>;
  connect(): Promise<WorkstationResult<ConnectInfo>>;
  disconnect(): Promise<WorkstationResult<void>>;
  status(): Promise<WorkstationResult<WorkstationStatus>>;
  observe(target: ObservationTarget): Promise<WorkstationResult<WorkstationObservation>>;
  act(action: WorkstationAction): Promise<WorkstationResult<ActionReport>>;
  /** Release every local resource. Idempotent; never throws. */
  close(): Promise<void>;
}

// ── Driver floor ──────────────────────────────────────────────────────────────

/**
 * The driver floor for this seam. Re-exported from the CUA foundation rather
 * than restated, so there is one number to change when the floor moves.
 */
export { MINIMUM_DRIVER_VERSION as WORKSTATION_MINIMUM_DRIVER_VERSION } from "../capabilities/computer/transport.ts";
