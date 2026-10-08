// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The computer-use session: the thin orchestrator that puts the safety
 * mechanisms in front of the transport.
 *
 * Every driver call goes through ONE guarded path, so there is exactly one
 * place that can decide whether the agent may act and whether a result is still
 * trustworthy. The transport itself is untrusted plumbing — it knows nothing
 * about who is driving, and it must never be asked to enforce policy. That is
 * this layer's whole job:
 *
 *   1. HUMAN CONTROL HOLDS. Before any driver call the control state is read.
 *      If the machine is held, the call is refused and the transport is never
 *      invoked. A control source that THROWS is treated as unreachable → HELD
 *      (fail closed), so a broken control read can never become permission.
 *
 *   2. OBSERVATION DEDUPLICATION. Captured frames are hashed; an identical
 *      frame is reported as `suppressed` and its payload withheld, but the hash
 *      is always reported so a caller can correlate.
 *
 *   3. TRANSITION PROTECTION. The control generation is sampled BEFORE and
 *      AFTER every driver call. If it moved — the human grabbed the wheel
 *      mid-observe or mid-click — the result is INVALIDATED, not returned as if
 *      nothing happened. For an action this means "the driver may have moved the
 *      mouse, but we cannot vouch for the outcome"; for an observation it means
 *      "these pixels may already be stale, do not reason on them".
 *
 * `connect()` and `health()` are deliberately NOT guarded. They do not touch the
 * screen — they only ask the driver whether it is alive and what version it is —
 * and the UI must still be able to report "the driver is up but the human is
 * driving". Every screen- or input-touching call is guarded.
 */

import { nowIso, type KaiError } from "../../shared/contracts.ts";
import { heldUnreachable, type ControlSnapshot, type ControlSource } from "./control.ts";
import { kaiError } from "./errors.ts";
import { ObservationDeduper, type ObservationStats } from "./observation.ts";
import {
  isSupportedDriverVersion,
  type ActionOutcome,
  type ClickTarget,
  type ComputerTransport,
  type ConnectInfo,
  type Frame,
  type Inspection,
  type ObserveOptions,
  type ScrollTarget,
  type TransportAction,
  type TransportEndpoint,
  type TransportResult,
  type WindowInfo,
} from "./transport.ts";

/** Why a guarded call did not produce a trustworthy result. */
export type GuardFailureReason = "human_hold" | "control_changed" | "transport";

export interface GuardFailure {
  ok: false;
  reason: GuardFailureReason;
  error: KaiError;
  /** Control state as last read. */
  control: ControlSnapshot;
  /**
   * True when the transport WAS invoked but its result was discarded because
   * control changed mid-sequence. A caller must not assume the action was a
   * no-op — this is the "it may have happened, we will not claim it" signal.
   */
  performedButInvalidated: boolean;
}

export interface GuardSuccess<T> {
  ok: true;
  value: T;
  control: ControlSnapshot;
}

export type Guarded<T> = GuardSuccess<T> | GuardFailure;

export type ActOutcome = Guarded<ActionOutcome>;
export type InspectOutcome = Guarded<Inspection>;
export type WindowsOutcome = Guarded<readonly WindowInfo[]>;

export interface ObserveSuccess {
  ok: true;
  /** The frame, or null when it was suppressed as an identical repeat. */
  value: Frame | null;
  /** True when this frame was byte-identical to the previous one. */
  suppressed: boolean;
  /** The frame's content hash, always reported (null when the driver had none). */
  hash: string | null;
  control: ControlSnapshot;
}

export type ObserveOutcome = ObserveSuccess | GuardFailure;
export type ConnectOutcome = TransportResult<ConnectInfo>;

export interface HealthOutcome {
  ok: boolean;
  version?: string;
  /** Whether the reported version meets MINIMUM_DRIVER_VERSION (0.28.2). */
  supported?: boolean;
  latencyMs?: number;
  endpoint: TransportEndpoint;
  error?: KaiError;
}

export interface ComputerSessionOptions {
  transport: ComputerTransport;
  control: ControlSource;
  deduper?: ObservationDeduper;
  now?: () => number;
}

export interface ComputerSession {
  readonly transport: ComputerTransport;
  connect(): Promise<ConnectOutcome>;
  health(): Promise<HealthOutcome>;
  inspect(): Promise<InspectOutcome>;
  windows(): Promise<WindowsOutcome>;
  click(target: ClickTarget): Promise<ActOutcome>;
  type(text: string): Promise<ActOutcome>;
  keypress(keys: readonly string[]): Promise<ActOutcome>;
  scroll(target: ScrollTarget): Promise<ActOutcome>;
  observe(options?: ObserveOptions): Promise<ObserveOutcome>;
  controlState(): Promise<ControlSnapshot>;
  requestHelp(reason: string): Promise<ControlSnapshot>;
  observationStats(): ObservationStats;
}

export function createComputerSession(options: ComputerSessionOptions): ComputerSession {
  const deduper = options.deduper ?? new ObservationDeduper();
  const now = options.now ?? (() => Date.now());

  /**
   * Read control state, failing CLOSED. The source is contractually supposed to
   * return a value rather than throw, but a contract is not a guarantee — and a
   * safety layer that assumes its input behaves would be no safety layer at all.
   */
  async function readControl(): Promise<ControlSnapshot> {
    try {
      return await options.control.snapshot();
    } catch (cause) {
      return heldUnreachable(nowIso(), cause instanceof Error ? cause.message : String(cause));
    }
  }

  /** The refusal for a machine the agent may not touch. Distinguishes the two
   * held cases so a caller can tell "a person is here" from "we cannot tell". */
  function holdError(snapshot: ControlSnapshot): KaiError {
    if (!snapshot.reachable) {
      return kaiError(
        "POLICY_DENIED",
        "computer control could not be confirmed; treating the machine as human-held (fail closed)",
        { detail: snapshot.helpReason ?? "control endpoint unreachable" },
      );
    }
    return kaiError(
      "POLICY_DENIED",
      "a person has taken control of this computer; the action was not performed",
      snapshot.helpReason !== undefined ? { detail: snapshot.helpReason } : {},
    );
  }

  function changedError(before: ControlSnapshot, after: ControlSnapshot): KaiError {
    return kaiError(
      "AGENT_RUN_FAILED",
      "control of the computer changed during the operation; the result was discarded",
      { detail: `generation ${before.generation} -> ${after.generation}; held=${after.held}` },
    );
  }

  /**
   * The one guarded path. Reads control, refuses if held, runs the transport,
   * re-reads control, and invalidates the result if control moved. Everything
   * that touches the screen or the input devices goes through here.
   */
  async function guarded<T>(call: () => Promise<TransportResult<T>>): Promise<Guarded<T>> {
    const before = await readControl();
    if (before.held) {
      return { ok: false, reason: "human_hold", error: holdError(before), control: before, performedButInvalidated: false };
    }

    const result = await call();
    const after = await readControl();

    // A change in either the generation OR the held flag invalidates. Checking
    // both is deliberate: generation catches a take-then-release inside the
    // window, held catches an unreachable re-read (which forces held true).
    if (after.held || after.generation !== before.generation) {
      return {
        ok: false,
        reason: "control_changed",
        error: changedError(before, after),
        control: after,
        performedButInvalidated: result.ok,
      };
    }

    if (!result.ok) {
      return { ok: false, reason: "transport", error: result.error, control: after, performedButInvalidated: false };
    }
    return { ok: true, value: result.value, control: after };
  }

  function act(action: TransportAction): Promise<ActOutcome> {
    return guarded(() => options.transport.act(action));
  }

  return {
    transport: options.transport,

    async connect(): Promise<ConnectOutcome> {
      return options.transport.connect();
    },

    async health(): Promise<HealthOutcome> {
      const started = now();
      const connected = await options.transport.connect();
      if (!connected.ok) {
        return { ok: false, endpoint: options.transport.endpoint, error: connected.error };
      }
      const version = connected.value.version;
      return {
        ok: true,
        version,
        supported: isSupportedDriverVersion(version),
        latencyMs: now() - started,
        endpoint: options.transport.endpoint,
      };
    },

    async inspect(): Promise<InspectOutcome> {
      // Read-only, but still gated: an inspection is a driver call, and the
      // human-hold rule is "the agent does not drive while a person is driving",
      // not "the agent may read while a person is driving".
      return guarded(() => options.transport.inspect());
    },

    async windows(): Promise<WindowsOutcome> {
      return guarded(() => options.transport.windows());
    },

    async click(target: ClickTarget): Promise<ActOutcome> {
      return act({ kind: "click", target });
    },

    async type(text: string): Promise<ActOutcome> {
      return act({ kind: "type", text });
    },

    async keypress(keys: readonly string[]): Promise<ActOutcome> {
      return act({ kind: "keypress", keys });
    },

    async scroll(target: ScrollTarget): Promise<ActOutcome> {
      return act({ kind: "scroll", target });
    },

    async observe(observeOptions?: ObserveOptions): Promise<ObserveOutcome> {
      const result = await guarded(() => options.transport.observe(observeOptions));
      if (!result.ok) return result;

      // Deduplicate AFTER the transition check: a frame captured across a
      // control change must be invalidated, not quietly suppressed and forgotten.
      const region = observeOptions?.region;
      const view = region ? `${region.x},${region.y},${region.width},${region.height}` : "full";
      const decision = deduper.note(result.value.hash, view);
      return {
        ok: true,
        value: decision.suppressed ? null : result.value,
        suppressed: decision.suppressed,
        hash: decision.hash,
        control: result.control,
      };
    },

    async controlState(): Promise<ControlSnapshot> {
      return readControl();
    },

    async requestHelp(reason: string): Promise<ControlSnapshot> {
      return options.control.requestHelp(reason);
    },

    observationStats(): ObservationStats {
      return deduper.stats();
    },
  };
}
