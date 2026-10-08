// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * KAI Core memory — upkeep cycle (Phase 2 Part B7).
 *
 * The cycle is a fixed, ordered pass:
 *
 *   capture → organize → tidy → expire → journal
 *
 * Each phase is an async function supplied by the engine; this module owns only
 * the SCHEDULING and the two guarantees the directive calls out:
 *
 *   SURVIVES A RESTART. The enabled flag, the last run time and the last summary
 *   live in the store, not in a closure. A new `MemoryUpkeep` over the same store
 *   — which is what a Core restart produces — reads them back and resumes where
 *   the previous process left off.
 *
 *   NEVER WRITES AFTER DISABLE. Two mechanisms, belt and braces:
 *     - after EVERY `await` (including the test/telemetry seam that runs before
 *       a phase), `runCycle` re-reads `store.getUpkeepEnabled()` and stops if it
 *       has gone false; and
 *     - every phase is handed a `guard()` that re-reads the same flag from the
 *       store, so a phase checks immediately before its own write and throws
 *       `UpkeepPausedError` rather than writing stale truth.
 *
 * The flag is read from the STORE on every check on purpose. Caching it in a
 * variable is exactly the bug the directive warns about: a pause that arrives
 * during an await would be invisible to a cached value.
 */

import type { Publish } from "../runtime.ts";
import type { MemoryEntryStore } from "./store.ts";

export type UpkeepPhaseName = "capture" | "organize" | "tidy" | "expire" | "journal";

export interface UpkeepPhase {
  name: UpkeepPhaseName;
  /**
   * Do the phase's work and return how many entries it changed. `guard()` reads
   * the live enabled flag from the store; a phase MUST call it immediately
   * before writing and throw `UpkeepPausedError` when it is false.
   */
  run(guard: () => boolean): Promise<number>;
}

/** Thrown by a phase that discovers upkeep was disabled mid-flight. */
export class UpkeepPausedError extends Error {
  constructor(phase: string) {
    super(`upkeep was disabled during phase "${phase}"`);
    this.name = "UpkeepPausedError";
  }
}

export interface UpkeepPhaseResult {
  name: UpkeepPhaseName;
  ok: boolean;
  changed: number;
}

export interface UpkeepReport {
  /** True when at least one phase ran. */
  ran: boolean;
  /** True when the cycle stopped early (paused or a phase failed). */
  stopped: boolean;
  reason: string;
  at: string;
  phases: UpkeepPhaseResult[];
  enabled: boolean;
}

export interface UpkeepStatus {
  enabled: boolean;
  lastRunAt: string | null;
  lastSummary: string | null;
}

export interface MemoryUpkeep {
  isEnabled(): boolean;
  pause(actor?: string): void;
  resume(actor?: string): void;
  status(): UpkeepStatus;
  runCycle(opts?: { reason?: string }): Promise<UpkeepReport>;
}

export interface MemoryUpkeepOptions {
  store: MemoryEntryStore;
  phases: readonly UpkeepPhase[];
  now?: () => Date;
  publish?: Publish;
  /**
   * Awaited before each phase's guard re-read. This is the seam a test uses to
   * disable upkeep mid-cycle, and the place telemetry would hook in.
   */
  onBeforePhase?: (name: UpkeepPhaseName, index: number) => void | Promise<void>;
}

const KEY_ENABLED = "upkeep.enabled";
const KEY_LAST_RUN = "upkeep.lastRunAt";
const KEY_LAST_SUMMARY = "upkeep.lastSummary";

export function createMemoryUpkeep(opts: MemoryUpkeepOptions): MemoryUpkeep {
  const { store, phases } = opts;
  const now = opts.now ?? (() => new Date());

  function isEnabled(): boolean {
    // Always the store: a cached flag would miss a pause that arrived during an
    // await, which is the exact failure this guards against.
    return store.getUpkeepEnabled();
  }

  function pause(actor = "core"): void {
    if (!store.getUpkeepEnabled()) return;
    store.setUpkeepEnabled(false);
    // Clearing KEY_ENABLED's meaning is enough; the store default is "enabled".
    store.setState("upkeep.pausedBy", actor);
    store.setState("upkeep.pausedAt", now().toISOString());
    opts.publish?.("core.status_changed", { upkeep: "paused", actor }, { source: "memory" });
  }

  function resume(actor = "core"): void {
    if (store.getUpkeepEnabled()) return;
    store.setUpkeepEnabled(true);
    store.setState("upkeep.resumedBy", actor);
    store.setState("upkeep.resumedAt", now().toISOString());
    opts.publish?.("core.status_changed", { upkeep: "resumed", actor }, { source: "memory" });
  }

  function status(): UpkeepStatus {
    return {
      enabled: isEnabled(),
      lastRunAt: store.getState(KEY_LAST_RUN),
      lastSummary: store.getState(KEY_LAST_SUMMARY),
    };
  }

  async function runCycle(cycleOpts: { reason?: string } = {}): Promise<UpkeepReport> {
    const at = now().toISOString();
    const reason = cycleOpts.reason ?? "scheduled";
    const results: UpkeepPhaseResult[] = [];

    // First check: the very act of starting must not run while disabled.
    if (!isEnabled()) {
      return { ran: false, stopped: true, reason: "upkeep is paused", at, phases: [], enabled: false };
    }

    for (let index = 0; index < phases.length; index += 1) {
      const phase = phases[index];
      if (phase === undefined) continue;

      if (opts.onBeforePhase !== undefined) {
        // An AWAIT: the flag may change while this is pending.
        await opts.onBeforePhase(phase.name, index);
      }

      // RE-READ AFTER THE AWAIT, from the store. This is the guarantee.
      if (!isEnabled()) {
        return {
          ran: results.length > 0,
          stopped: true,
          reason: `upkeep paused before phase "${phase.name}"`,
          at,
          phases: results,
          enabled: false,
        };
      }

      let changed = 0;
      try {
        changed = await phase.run(() => store.getUpkeepEnabled());
      } catch (error) {
        if (error instanceof UpkeepPausedError) {
          return {
            ran: results.length > 0,
            stopped: true,
            reason: `upkeep paused during phase "${phase.name}"`,
            at,
            phases: results,
            enabled: false,
          };
        }
        // A phase failure is reported, not swallowed; the cycle stops so a
        // half-done pass cannot look complete.
        results.push({ name: phase.name, ok: false, changed: 0 });
        const detail = error instanceof Error ? error.message : String(error);
        store.setState(KEY_LAST_RUN, at);
        store.setState(KEY_LAST_SUMMARY, `failed in ${phase.name}: ${detail}`);
        opts.publish?.("core.status_changed", { upkeep: "failed", phase: phase.name, detail }, { source: "memory" });
        return {
          ran: true,
          stopped: true,
          reason: `phase "${phase.name}" failed: ${detail}`,
          at,
          phases: results,
          enabled: isEnabled(),
        };
      }

      // A PHASE MAY HAVE AWAITED INTERNALLY. Re-read before recording anything.
      if (!isEnabled()) {
        return {
          ran: true,
          stopped: true,
          reason: `upkeep paused after phase "${phase.name}"`,
          at,
          phases: results,
          enabled: false,
        };
      }

      results.push({ name: phase.name, ok: true, changed });
    }

    // Final guard: the closing summary is itself a write.
    if (!isEnabled()) {
      return {
        ran: true,
        stopped: true,
        reason: "upkeep paused before the cycle summary was recorded",
        at,
        phases: results,
        enabled: false,
      };
    }

    const summary = `cycle(${reason}): ${results.map((r) => `${r.name}=${r.changed}`).join(", ")}`;
    store.setState(KEY_LAST_RUN, at);
    store.setState(KEY_LAST_SUMMARY, summary);
    opts.publish?.("core.status_changed", { upkeep: "cycle", reason, summary }, { source: "memory" });

    return { ran: true, stopped: false, reason: "upkeep cycle complete", at, phases: results, enabled: true };
  }

  return { isEnabled, pause, resume, status, runCycle };
}
