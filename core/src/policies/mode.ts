// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * KAI Core policy mode — how much KAI asks before it acts (Phase 1 Part G).
 *
 * ── Why this exists, and what it deliberately is not ────────────────────────
 * KAI's risk taxonomy (READ / WRITE / EXTERNAL / DESTRUCTIVE) and its safe
 * defaults are the stronger model and do not change here. What was missing is
 * that the policy was fixed at construction: `createPolicyEngine` was called
 * with zero rules and nothing could change it at runtime, so a UI permission
 * switch had nothing real to switch.
 *
 * This module supplies the missing runtime authority model, and the modes are
 * KAI's own vocabulary — NOT a provider CLI's approval modes (ask/edits/auto/
 * full/custom), which describe what that CLI asks its *caller*. A worker's mode
 * is a property of the worker; this is a property of KAI's decision.
 *
 * ── What each mode does (the whole table, no cleverness) ────────────────────
 *
 *   ask-all    READ needs approval too. The strictest setting.
 *   normal     READ allowed; WRITE/EXTERNAL/DESTRUCTIVE need approval.
 *              THIS IS TODAY'S BEHAVIOUR and it stays byte-identical.
 *   auto-read  as normal, and additionally an action covered by an exact,
 *              narrow, already-granted scope runs without a NEW card. It does
 *              not lower any risk's requirement — it only recognises that the
 *              human already answered this exact question.
 *   elevated   WRITE allowed without a card. EXTERNAL and DESTRUCTIVE still ask.
 *
 * Two invariants hold for every mode, and they are asserted in tests rather
 * than left as intentions: **no mode ever auto-allows DESTRUCTIVE or EXTERNAL**,
 * and **no mode is reached by inheriting it** — only a confirmed, owner-only
 * transition changes it.
 *
 * ── The fail-closed rule ────────────────────────────────────────────────────
 * Elevation is two-phase: `prepared` then `confirmed`. An elevation that has
 * been *requested* but not *confirmed* has NO effect — `effectiveMode` returns
 * the confirmed mode. That is the direction that matters: if the confirmation
 * never arrives, KAI stays where it was rather than drifting upward.
 */

import { isPolicyMode, type PolicyMode } from "../shared/contracts.ts";

/**
 * Who is asking. Only the human owner may raise authority; an agent or a worker
 * cannot even request it, which is what stops a worker inheriting elevation by
 * asking for it on the user's behalf.
 */
export type PolicyActor = "owner" | "agent" | "worker" | (string & {});

export interface ModeScope {
  kind: "thread" | "mission" | "employee" | "global";
  /** Required when `kind` is not "global". */
  id?: string;
}

export interface PendingElevation {
  requestId: string;
  /** The mode that will take effect on confirmation. */
  to: PolicyMode;
  scope: ModeScope;
  requestedAt: string;
  requestedBy: PolicyActor;
}

export interface PolicyState {
  /** The CONFIRMED, effective mode. */
  mode: PolicyMode;
  scope: ModeScope;
  /** Set while an elevation is prepared but unconfirmed. */
  pending?: PendingElevation;
  /**
   * Durable policy rules. Without this a grant lives only as long as the process,
   * so "Allow always" silently became "allow until restart".
   */
  rules?: unknown[];
  updatedAt: string;
}

/**
 * Ordered authority. Used to tell an elevation from a downgrade — and to make
 * "downgrades are always allowed" expressible as a single comparison.
 */
export const MODE_RANK: Readonly<Record<PolicyMode, number>> = {
  "ask-all": 0,
  normal: 1,
  "auto-read": 2,
  elevated: 3,
};

export function modeRank(mode: PolicyMode): number {
  return MODE_RANK[mode];
}

export function isElevation(from: PolicyMode, to: PolicyMode): boolean {
  return modeRank(to) > modeRank(from);
}

/** The mode KAI starts in. Deliberately today's behaviour, so nothing silently loosens. */
export const BASELINE_MODE: PolicyMode = "normal";

export function initialPolicyState(now: Date = new Date(), mode: PolicyMode = BASELINE_MODE): PolicyState {
  return { mode, scope: { kind: "global" }, updatedAt: now.toISOString() };
}

export type ModeChange =
  | { ok: true; state: PolicyState; reason: string }
  | { ok: false; reason: string };

function validScope(scope: ModeScope): boolean {
  if (scope === null || typeof scope !== "object") return false;
  if (scope.kind !== "thread" && scope.kind !== "mission" && scope.kind !== "employee" && scope.kind !== "global") {
    return false;
  }
  // A narrow scope must name what it is scoped to; "thread" with no id is a
  // scope that silently means every thread.
  if (scope.kind !== "global" && (typeof scope.id !== "string" || scope.id.trim().length === 0)) return false;
  return true;
}

/**
 * The mode that is actually in force. A prepared-but-unconfirmed elevation
 * resolves DOWN to the confirmed mode — fail closed, and the reason says so, so
 * a caller can explain why the setting appears not to have taken effect yet.
 */
export function effectiveMode(state: PolicyState): { mode: PolicyMode; reason: string } {
  if (state.pending !== undefined) {
    return {
      mode: state.mode,
      reason: `mode "${state.mode}" is in force; a request to change to "${state.pending.to}" is prepared but unconfirmed`,
    };
  }
  return { mode: state.mode, reason: `mode "${state.mode}" is in force` };
}

/**
 * Step 1 of two-phase elevation. Only the owner may ask, the target must be an
 * actual elevation, and the scope must be explicit.
 *
 * `elevated` may not be global: an unrestricted elevation is exactly the
 * "worker inherits elevated permission accidentally" failure the brief names,
 * so it is refused by *shape* rather than by review.
 */
export function requestElevation(
  state: PolicyState,
  input: { to: PolicyMode; scope: ModeScope; requestedBy: PolicyActor; now?: Date; requestId: string },
): ModeChange {
  const now = input.now ?? new Date();
  if (!isPolicyMode(input.to)) {
    return { ok: false, reason: `"${String(input.to)}" is not a KAI policy mode` };
  }
  if (!validScope(input.scope)) {
    return { ok: false, reason: "elevation requires an explicit scope (thread/mission/employee with an id)" };
  }
  if (input.to === "elevated" && input.scope.kind === "global") {
    return { ok: false, reason: "elevated may not be scoped globally; scope it to a thread, mission or employee" };
  }
  if (input.requestedBy !== "owner") {
    return {
      ok: false,
      reason: `only the owner may change policy; "${String(input.requestedBy)}" is not permitted to request an elevation`,
    };
  }
  if (!isElevation(state.mode, input.to)) {
    return {
      ok: false,
      reason: `"${input.to}" is not an elevation from "${state.mode}"; downgrades are applied directly`,
    };
  }
  return {
    ok: true,
    reason: `elevation to "${input.to}" for ${input.scope.kind}${input.scope.id !== undefined ? ` "${input.scope.id}"` : ""} is prepared and awaits confirmation`,
    state: {
      ...state,
      pending: {
        requestId: input.requestId,
        to: input.to,
        scope: input.scope,
        requestedAt: now.toISOString(),
        requestedBy: input.requestedBy,
      },
      updatedAt: now.toISOString(),
    },
  };
}

/**
 * Step 2 of two-phase elevation. The confirmation must name the prepared
 * request, so a stale or replayed confirmation cannot commit a different one.
 */
export function confirmElevation(
  state: PolicyState,
  input: { requestId: string; confirmedBy: PolicyActor; now?: Date },
): ModeChange {
  const now = input.now ?? new Date();
  const pending = state.pending;
  if (pending === undefined) {
    return { ok: false, reason: "there is no prepared elevation to confirm" };
  }
  if (input.requestId !== pending.requestId) {
    return {
      ok: false,
      reason: `confirmation names request "${input.requestId}" but the prepared elevation is "${pending.requestId}"`,
    };
  }
  if (input.confirmedBy !== "owner") {
    return {
      ok: false,
      reason: `only the owner may confirm an elevation; "${String(input.confirmedBy)}" is not permitted`,
    };
  }
  const next: PolicyState = {
    mode: pending.to,
    scope: pending.scope,
    updatedAt: now.toISOString(),
  };
  return { ok: true, reason: `mode "${pending.to}" is now in force`, state: next };
}

/** Abandon a prepared elevation. Always allowed; leaves the confirmed mode in place. */
export function cancelElevation(state: PolicyState, now: Date = new Date()): ModeChange {
  if (state.pending === undefined) {
    return { ok: false, reason: "there is no prepared elevation to cancel" };
  }
  const { pending: _dropped, ...rest } = state;
  return {
    ok: true,
    reason: `prepared elevation to "${state.pending.to}" was cancelled; "${state.mode}" remains in force`,
    state: { ...rest, updatedAt: now.toISOString() },
  };
}

/**
 * Drop to a lower mode — or to the baseline from anywhere. This is the one
 * authority change that needs no confirmation and cannot be blocked, including
 * mid-turn: reducing power must never be the slow path.
 */
export function downgrade(
  state: PolicyState,
  input: { to?: PolicyMode; now?: Date; reason?: string },
): ModeChange {
  const now = input.now ?? new Date();
  const to = input.to ?? BASELINE_MODE;
  if (!isPolicyMode(to)) {
    return { ok: false, reason: `"${String(input.to)}" is not a KAI policy mode` };
  }
  if (isElevation(state.mode, to)) {
    // Refusing this would be refusing to reduce authority, which is never right.
    return { ok: false, reason: `"${to}" would be an elevation from "${state.mode}", not a downgrade` };
  }
  const next: PolicyState = { mode: to, scope: { kind: "global" }, updatedAt: now.toISOString() };
  return {
    ok: true,
    reason: `${input.reason ?? "downgrade"}: mode "${state.mode}" -> "${to}"`,
    state: next,
  };
}
