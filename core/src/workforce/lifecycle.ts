// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * lifecycle.ts — the employee state machine.
 *
 * Employees move through a fixed set of states, and the point of this file is
 * that a move which is not in the table is *refused as a value*, never applied.
 * An employee reporting "READY" that never installed, or one that goes straight
 * from REMOVED back to live work without being re-discovered, would each be a
 * silent lie about what KAI can actually do — the states exist to make those
 * lies impossible to represent.
 *
 * Why a table plus a tiny lifecycle object rather than a class hierarchy:
 *  - The table is the single place the legal shape of an employee's life is
 *    written down, so a test can assert it directly and a reader can check it
 *    without following control flow.
 *  - `createLifecycle` owns one employee's current state and its trail, which is
 *    what the manager delegates to. It mutates nothing it did not create.
 *
 * KaiError is built locally rather than borrowed from the agent adapters so this
 * module has no edge into `core/src/agents` — the workforce layer sits *above*
 * the adapters, and depending on them for an error type would invert that.
 */

import { nowIso } from "../shared/contracts.ts";
import type { EmployeeState, KaiError, KaiErrorCode } from "../shared/contracts.ts";

/** A contract-shaped KaiError. Never carries anything secret: there is nothing secret here. */
export function employeeError(code: KaiErrorCode, message: string, detail?: string): KaiError {
  const error: KaiError = { code, message, retryable: false, at: nowIso() };
  if (detail !== undefined) error.detail = detail;
  return error;
}

/**
 * The legal transitions, written as a data table.
 *
 * Reading it as a whole:
 *  - DISCOVERED is "we know this trusted employee exists"; from there it can be
 *    installed, found already present (INSTALLED), declared unreachable
 *    (UNAVAILABLE), turned off, or forgotten.
 *  - INSTALLING cannot jump to READY: an installed program that must be
 *    authenticated is AUTHENTICATING first, and an installer that fails lands in
 *    UNAVAILABLE rather than pretending a partial install is fine.
 *  - READY and DEGRADED are the only two working states, and they interconvert as
 *    health changes. Both can go back to INSTALLING for a repair/upgrade.
 *  - UNAVAILABLE is deliberately wide: recovery may discover the employee is now
 *    present, installed, healthy again, or simply gone; every one of those is an
 *    honest target from "not usable right now".
 *  - DISABLED is a *user intent* state, distinct from UNAVAILABLE (a fact about
 *    the world): it can be re-enabled to any non-live state, and its health may be
 *    re-observed, but it must never be silently promoted to READY.
 *  - REMOVED is a tombstone: only re-discovery can bring it back, so a stale
 *    handle can never resurrect an employee behind the user's back.
 */
export const EMPLOYEE_TRANSITIONS: Readonly<Record<EmployeeState, readonly EmployeeState[]>> = {
  DISCOVERED: ["INSTALLING", "INSTALLED", "UNAVAILABLE", "DISABLED", "REMOVED"],
  INSTALLING: ["INSTALLED", "UNAVAILABLE", "DISCOVERED", "DISABLED"],
  INSTALLED: ["AUTHENTICATING", "READY", "DEGRADED", "UNAVAILABLE", "DISABLED", "REMOVED"],
  AUTHENTICATING: ["READY", "DEGRADED", "UNAVAILABLE", "INSTALLED", "DISABLED", "REMOVED"],
  READY: ["DEGRADED", "UNAVAILABLE", "DISABLED", "REMOVED", "INSTALLING"],
  DEGRADED: ["READY", "UNAVAILABLE", "DISABLED", "REMOVED", "INSTALLING"],
  UNAVAILABLE: ["DISCOVERED", "INSTALLING", "INSTALLED", "READY", "DEGRADED", "DISABLED", "REMOVED"],
  DISABLED: ["READY", "DEGRADED", "INSTALLED", "UNAVAILABLE", "DISCOVERED", "REMOVED"],
  REMOVED: ["DISCOVERED", "INSTALLED"],
};

/** The states an employee can be moved to from `from`, in table order. */
export function legalTransitions(from: EmployeeState): readonly EmployeeState[] {
  return EMPLOYEE_TRANSITIONS[from];
}

/**
 * Is `from -> to` allowed? A transition to the *same* state is allowed and is a
 * no-op: re-affirming "still READY" must not require a detour through another
 * state, and rejecting it would make idempotent health checks awkward.
 */
export function isLegalTransition(from: EmployeeState, to: EmployeeState): boolean {
  if (from === to) return true;
  return EMPLOYEE_TRANSITIONS[from].includes(to);
}

export interface TransitionResult {
  ok: boolean;
  from: EmployeeState;
  to: EmployeeState;
  /** False when the move was a no-op (same state). */
  changed: boolean;
  error?: KaiError;
}

/**
 * Decide a transition without applying it. This is the pure core the lifecycle
 * object below is built on, and it is what makes "refused as a value" true: an
 * illegal move returns `ok:false` with a KaiError and touches nothing.
 */
export function transition(from: EmployeeState, to: EmployeeState): TransitionResult {
  if (from === to) {
    return { ok: true, from, to, changed: false };
  }
  if (!EMPLOYEE_TRANSITIONS[from].includes(to)) {
    return {
      ok: false,
      from,
      to,
      changed: false,
      error: employeeError(
        "VALIDATION_FAILED",
        `illegal employee transition ${from} -> ${to}`,
        `from ${from} the legal targets are: ${EMPLOYEE_TRANSITIONS[from].join(", ")}`,
      ),
    };
  }
  return { ok: true, from, to, changed: true };
}

/**
 * The shortest legal route from `from` to `to`, or null when none exists.
 *
 * WHY THIS EXISTS: health observation and discovery learn the world's current
 * truth, which does not always sit one hop away — a DISCOVERED employee that a
 * probe finds healthy has to pass through INSTALLED to become READY. Rather than
 * sprinkling multi-step special cases through the manager, the manager asks for
 * the route and applies it; the table stays the only source of legality.
 *
 * A path is returned as the states to *enter* (excluding `from`). Same state
 * yields an empty path.
 */
export function transitionPath(from: EmployeeState, to: EmployeeState): EmployeeState[] | null {
  if (from === to) return [];
  const queue: EmployeeState[][] = [[from]];
  const visited = new Set<EmployeeState>([from]);

  while (queue.length > 0) {
    const path = queue.shift();
    if (path === undefined) break;
    const last = path[path.length - 1];
    if (last === undefined) continue;
    for (const next of EMPLOYEE_TRANSITIONS[last]) {
      if (visited.has(next)) continue;
      const grown = [...path, next];
      if (next === to) return grown.slice(1); // drop the starting state
      visited.add(next);
      queue.push(grown);
    }
  }
  return null;
}

/**
 * One employee's state, plus the trail of states it has been through.
 *
 * The trail is kept because "how did it get here" is the first question asked
 * about a DEGRADED employee, and reconstructing it from events after the fact is
 * exactly the kind of archaeology a control plane should not require.
 */
export interface EmployeeLifecycle {
  state(): EmployeeState;
  history(): readonly EmployeeState[];
  can(to: EmployeeState): boolean;
  /** Applies a transition if legal; refuses as a value if not. */
  apply(to: EmployeeState): TransitionResult;
}

export function createLifecycle(initial: EmployeeState): EmployeeLifecycle {
  let current: EmployeeState = initial;
  const trail: EmployeeState[] = [initial];

  return {
    state(): EmployeeState {
      return current;
    },
    history(): readonly EmployeeState[] {
      return [...trail];
    },
    can(to: EmployeeState): boolean {
      return isLegalTransition(current, to);
    },
    apply(to: EmployeeState): TransitionResult {
      const result = transition(current, to);
      if (result.ok) {
        if (result.changed) trail.push(to);
        current = to;
      }
      return result;
    },
  };
}
