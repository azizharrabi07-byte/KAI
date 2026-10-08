// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Who is driving the computer — the human or the agent — and the lease
 * bookkeeping that decides whether an agent action may run.
 *
 * Three rules this module exists to enforce, all of them safety-critical:
 *
 *   1. HUMAN CONTROL HOLDS. While the human owns the machine every agent action
 *      is REFUSED, not queued. A queued click lands after the person has moved
 *      on, on whatever happens to be under it. The agent may only ASK for the
 *      wheel (`requestHelp`); it can never take it and it can never clear a
 *      human's hold.
 *
 *   2. FAIL CLOSED. A control reading that could not be obtained is treated as
 *      HELD. Never interpret a timeout or an unreachable endpoint as permission
 *      to continue — an unreachable control endpoint is not a release. See
 *      `heldUnreachable` / `createControlProbeClient`.
 *
 *   3. STALE LEASES CANNOT RELEASE LIVE ONES. Every transition bumps a
 *      monotonic `generation`. A lease handle carries the generation it was
 *      acquired at, and `releaseLease` refuses unless BOTH the lease id and the
 *      generation still match. An old timer firing after its lease was
 *      superseded must be a no-op; comparing ids alone would be fragile if an
 *      id were ever reused, so the generation is the durable guard.
 *
 * Provenance: the shape is adapted from OpenMausBot's `server/computer-control.ts`
 * and `server/control-client.ts` (Apache-2.0, read-only design evidence). The
 * names are KAI's; the generation counter is this module's, not upstream's.
 */

import { nowIso } from "../../shared/contracts.ts";

/** Keep a shouted help reason card-sized; the transcript has the rest. */
const MAX_HELP_CHARS = 280;

/**
 * Sentinel generation for an unreachable reading. Real generations are >= 0, so
 * a negative value can never collide with one and any comparison against a live
 * reading invalidates — which is what we want when control state is unknown.
 */
export const UNREACHABLE_GENERATION = -1;

export type ControlHolder = "none" | "agent" | "human";

export interface ControlSnapshot {
  /** True while the human (or another holder) owns the machine; agent actions are refused. */
  held: boolean;
  holder: ControlHolder;
  /**
   * Monotonic revision. Any transition — a human taking or releasing, an agent
   * lease acquired or released — bumps it. Two snapshots with different
   * generations mean control changed between them.
   */
  generation: number;
  /** ISO-8601. */
  at: string;
  /** False when this reading could not be confirmed; `held` is then forced true. */
  reachable: boolean;
  /** An outstanding plea from the agent, when one is open. */
  helpReason?: string;
}

/**
 * Where the session reads control state from. Implemented locally by
 * `ControlLedger` (the in-memory truth) and remotely by
 * `createControlProbeClient` (a fail-closed read of a control endpoint).
 */
export interface ControlSource {
  snapshot(): Promise<ControlSnapshot>;
  /**
   * Ask the human to take over. NEVER grants anything by itself — it only
   * surfaces a plea. A remote endpoint that has no help channel in this phase
   * returns the current snapshot unchanged.
   */
  requestHelp(reason: string): Promise<ControlSnapshot>;
}

/**
 * The single fail-closed reading. Used for an unreachable endpoint, a timeout,
 * and for a control source that throws. `held: true` is the point: absence of
 * confirmation is never permission.
 */
export function heldUnreachable(at: string, detail?: string): ControlSnapshot {
  const snapshot: ControlSnapshot = {
    held: true,
    holder: "human",
    generation: UNREACHABLE_GENERATION,
    at,
    reachable: false,
  };
  if (detail !== undefined) snapshot.helpReason = detail;
  return snapshot;
}

// ── The local ledger ──────────────────────────────────────────────────────────

export interface LeaseHandle {
  readonly leaseId: string;
  /** The generation this lease was acquired at. The stale-release guard. */
  readonly generation: number;
}

export interface AcquireResult {
  snapshot: ControlSnapshot;
  /** True only when this call changed a free machine into an agent-held one. */
  acquired: boolean;
  /** True only when this lease currently owns the machine. */
  owned: boolean;
  lease?: LeaseHandle;
}

export interface ReleaseResult {
  snapshot: ControlSnapshot;
  /** True only when this call removed a hold owned by the supplied lease. */
  released: boolean;
  /** True when the handle was stale (superseded, or no longer active). */
  stale: boolean;
}

export interface ControlLedgerOptions {
  now?: () => Date;
  /** Seeds the generation counter; tests can start at a known value. */
  initialGeneration?: number;
}

/**
 * In-memory truth of who holds the machine for one computer. Deliberately not
 * persisted: a hold is a live fact about who is at the screen right now, and a
 * stale hold surviving a restart would silently brick the computer.
 */
export class ControlLedger implements ControlSource {
  private currentGeneration: number;
  private holder: ControlHolder = "none";
  private activeLeaseId: string | null = null;
  private helpReason: string | null = null;
  private leaseSequence = 0;
  private readonly now: () => Date;

  constructor(options: ControlLedgerOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.currentGeneration = options.initialGeneration ?? 0;
  }

  /** Async only to match `ControlSource`; nothing here waits. */
  async snapshot(): Promise<ControlSnapshot> {
    return this.read();
  }

  /** Synchronous read, for callers that already hold a ledger. */
  read(): ControlSnapshot {
    const snapshot: ControlSnapshot = {
      held: this.holder !== "none",
      holder: this.holder,
      generation: this.currentGeneration,
      at: this.now().toISOString(),
      reachable: true,
    };
    if (this.helpReason !== null) snapshot.helpReason = this.helpReason;
    return snapshot;
  }

  /**
   * The agent asks the person to take over. Never grants control and never
   * bumps the generation: a plea is not a transition. An existing plea is not
   * clobbered, so a second plea cannot overwrite a card the person is reading.
   */
  async requestHelp(reason: unknown): Promise<ControlSnapshot> {
    const text = typeof reason === "string" ? reason.trim().slice(0, MAX_HELP_CHARS) : "";
    if (this.helpReason === null) {
      this.helpReason = text || "the agent asked you to take over";
    }
    return this.read();
  }

  /**
   * Atomically acquire an agent lease. If the machine is already held — by a
   * human OR by another lease — this is a no-op that reports `owned: false`.
   * It never steals.
   */
  acquireLease(_ownerId: string): AcquireResult {
    if (this.holder !== "none") {
      return { snapshot: this.read(), acquired: false, owned: false };
    }
    this.leaseSequence += 1;
    const leaseId = `lease-${this.leaseSequence}`;
    this.holder = "agent";
    this.activeLeaseId = leaseId;
    this.currentGeneration += 1;
    const lease: LeaseHandle = { leaseId, generation: this.currentGeneration };
    return { snapshot: this.read(), acquired: true, owned: true, lease };
  }

  /** Whether this exact lease — id AND generation — currently holds the wheel. */
  ownsLease(handle: LeaseHandle): boolean {
    return (
      this.holder === "agent" &&
      this.activeLeaseId === handle.leaseId &&
      this.currentGeneration === handle.generation
    );
  }

  /**
   * Release ONLY the lease this handle created.
   *
   * THE STALE-TIMER GUARD. A lease's expiry timer fires with the handle it was
   * created with. If, while it was pending, the lease was superseded (the human
   * took over, or a new lease was acquired), the generation has moved on and
   * this release must be a no-op — otherwise an old timer silently drops a
   * LIVE lease and the agent loses the machine it is mid-action on.
   *
   * The generation is checked FIRST and is the durable guard; the lease id is
   * a secondary check that also covers a handle from a different machine.
   */
  releaseLease(handle: LeaseHandle): ReleaseResult {
    if (this.holder !== "agent" || this.activeLeaseId === null) {
      // Nothing of ours is active — the handle is stale by definition.
      return { snapshot: this.read(), released: false, stale: true };
    }
    if (this.currentGeneration !== handle.generation || this.activeLeaseId !== handle.leaseId) {
      return { snapshot: this.read(), released: false, stale: true };
    }
    this.holder = "none";
    this.activeLeaseId = null;
    this.currentGeneration += 1;
    return { snapshot: this.read(), released: true, stale: false };
  }

  /**
   * The human takes the wheel. Idempotent — a second click must not look like
   * a new transition, or every agent lease check would see a phantom change.
   * Taking over SUPERSEDES any agent lease: clearing `activeLeaseId` and
   * bumping the generation is exactly what invalidates the agent's handle.
   */
  takeByHuman(): ControlSnapshot {
    if (this.holder === "human") return this.read();
    this.holder = "human";
    this.activeLeaseId = null;
    // Taking over settles the plea that asked for it.
    this.helpReason = null;
    this.currentGeneration += 1;
    return this.read();
  }

  /** The human hands the wheel back. Idempotent; only a human hold can be released here. */
  releaseByHuman(): ControlSnapshot {
    if (this.holder !== "human") return this.read();
    this.holder = "none";
    this.currentGeneration += 1;
    return this.read();
  }
}

// ── The remote, fail-closed probe ─────────────────────────────────────────────

export interface ControlEndpointReading {
  held: boolean;
  helpReason?: string;
  /** Optional server-supplied revision; authoritative when present. */
  generation?: number;
}

/**
 * A control endpoint. Resolving is the ONLY path that can report "not held";
 * throwing is treated as unreachable and fails closed.
 */
export interface ControlEndpoint {
  readonly label: string;
  read(signal: AbortSignal): Promise<ControlEndpointReading>;
}

export interface ControlProbeClientOptions {
  endpoint: ControlEndpoint;
  timeoutMs?: number;
  now?: () => Date;
}

/**
 * Read control state from a remote endpoint and fail CLOSED on any failure:
 * a non-OK answer, a timeout, a thrown error, or a malformed body all become
 * `heldUnreachable`. There is deliberately NO cache here — a cached "not held"
 * reading is stale permission, and this phase values correctness over the
 * handful of round trips a cache would save.
 *
 * When the endpoint does not supply a `generation`, one is synthesised locally
 * from observed changes so transition protection still has something to compare.
 */
export function createControlProbeClient(options: ControlProbeClientOptions): ControlSource {
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? 2_000;
  let localGeneration = 0;
  let lastHeld = true; // fail closed until the first successful read

  async function snapshot(): Promise<ControlSnapshot> {
    let reading: ControlEndpointReading;
    try {
      const signal = AbortSignal.timeout(timeoutMs);
      reading = await options.endpoint.read(signal);
      if (typeof reading?.held !== "boolean") {
        throw new Error("control endpoint returned a malformed body");
      }
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      return heldUnreachable(now().toISOString(), `control endpoint unreachable (${options.endpoint.label}): ${detail}`);
    }

    if (typeof reading.generation === "number") {
      localGeneration = reading.generation;
    } else if (reading.held !== lastHeld) {
      localGeneration += 1;
    }
    lastHeld = reading.held;

    const snapshot: ControlSnapshot = {
      held: reading.held,
      holder: reading.held ? "human" : "none",
      generation: localGeneration,
      at: now().toISOString(),
      reachable: true,
    };
    if (typeof reading.helpReason === "string" && reading.helpReason) snapshot.helpReason = reading.helpReason;
    return snapshot;
  }

  return {
    snapshot,
    // No help channel is assumed on a remote endpoint in this phase: asking is a
    // no-op that reports the current state rather than pretending it was sent.
    async requestHelp(): Promise<ControlSnapshot> {
      return snapshot();
    },
  };
}

/** Re-exported so a caller does not need to import nowIso separately. */
export const controlNowIso = nowIso;
