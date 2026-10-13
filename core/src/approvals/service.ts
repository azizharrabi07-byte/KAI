// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * KAI Core approval lifecycle (spec §38).
 *
 * A `needs_approval` policy decision does not authorise anything by itself; it
 * only says a human must be asked. This service owns that question: it records
 * the request, expires it if nobody answers, and reports the verdict. It never
 * decides by itself and never calls a tool.
 *
 * The approval is bound to a single `toolId`; the registry is the component
 * that enforces that binding at invoke time (an approval for tool A must never
 * authorise tool B).
 *
 * Expiry is not decoration. An approval that can be replayed an hour later is
 * an approval that was never really given for the action at hand, so every
 * request carries an `expiresAt` and `expireStale()` is the sweep that retires
 * forgotten ones. When `expiresAt` is reached or passed the approval is stale;
 * an approval with no `expiresAt` is treated as never going stale (both fields
 * exist because the frozen `Approval` contract makes expiry optional).
 *
 * Expiry also RESOLVES the waiter. A caller blocked in `waitFor(id)` is freed
 * by the same three paths that settle an approval — a human `decide`, the
 * `expireStale()` sweep, or the per-request timer armed at `request()` — so a
 * mission parked on an answer can never outlive its own deadline. The timer is
 * what makes the resolution self-driving rather than contingent on someone
 * remembering to sweep.
 *
 * Events: `approval.requested` on creation, `approval.approved` /
 * `approval.rejected` on decision. The frozen `KaiEventType` union has no
 * `approval.expired`, so `expireStale()` deliberately publishes nothing —
 * inventing an off-contract event type would break type-checking for every
 * consumer.
 */

import type {
  Approval,
  ApprovalStatus,
  ApprovalStore,
  KaiEventType,
  RiskLevel,
} from "../shared/contracts.ts";

/**
 * Event publisher, injected rather than imported: this module must not depend
 * on the event bus. Structurally compatible with `EventBus.publish`, so a live
 * bus can be passed straight in.
 */
export type Publish = (
  type: KaiEventType,
  payload: unknown,
  opts?: { source?: string; missionId?: string; stepId?: string },
) => void;

/**
 * Default approval lifetime: 10 minutes.
 *
 * Long enough that a user who stepped away can still find and answer the
 * request, short enough that a stale approval cannot be replayed much later
 * against a materially different situation. Callers may override per request.
 */
export const DEFAULT_APPROVAL_TTL_MS = 10 * 60_000;

export interface ApprovalRequestInput {
  toolId: string;
  action: string;
  reason: string;
  risk: RiskLevel;
  missionId?: string;
  stepId?: string;
  ttlMs?: number;
  /** A stable hash of the exact input the human is being asked about. */
  inputHash?: string;
}

export interface ApprovalService {
  request(input: ApprovalRequestInput): Approval;
  decide(id: string, approved: boolean): { ok: true; approval: Approval } | { ok: false; reason: string };
  /** Marks PENDING approvals past expiresAt as EXPIRED. */
  expireStale(now?: Date): string[];
  /** Disarms expiry timers and releases waiters. Call before closing the store. */
  dispose(): void;
  /**
   * Resolves when `id` stops being PENDING — whoever ends it wins: a human via
   * `decide`, the sweep via `expireStale`, or the per-request timer. Resolves
   * immediately with the recorded row if the approval is already settled, and
   * with `null` if the id is unknown.
   *
   * A caller blocked on an answer must not hang past the deadline: "expired" is
   * a verdict, not a state only a database sweep may observe. Without this the
   * waiting mission would only learn the answer was "no" on some later pass.
   */
  waitFor(id: string): Promise<Approval | null>;
  get(id: string): Approval | null;
  list(opts?: { status?: ApprovalStatus }): Approval[];
}

function normalizeTtl(ttlMs: unknown): number {
  if (typeof ttlMs !== "number" || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    return DEFAULT_APPROVAL_TTL_MS;
  }
  return ttlMs;
}

export function createApprovalService(opts: {
  store: ApprovalStore;
  publish?: Publish;
  now?: () => Date;
  idFactory?: () => string;
  defaultTtlMs?: number;
}): ApprovalService {
  const { store, publish } = opts;
  const now = opts.now ?? (() => new Date());

  let seq = 0;
  const idFactory =
    opts.idFactory ?? (() => `apr_${now().getTime().toString(36)}_${(seq++).toString(36)}`);
  const defaultTtlMs = normalizeTtl(opts.defaultTtlMs);

  /**
   * Approvals some caller is blocked on, keyed by id. Each entry is the set of
   * `resolve` callbacks waiting for that id to leave PENDING. The map is the
   * only in-memory state here — the record of truth is the store — and it is
   * emptied as soon as the id settles, so a decided approval never leaks a
   * waiter.
   */
  const waiters = new Map<string, Array<(approval: Approval | null) => void>>();

  /**
   * Live expiry timers, keyed by approval id.
   *
   * Tracked so shutdown can disarm them. An untracked timer that fires after the
   * store has closed throws inside a callback nobody can catch, turning an
   * expiry into a crash.
   */
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Resolve every waiter on `id` with the store's current row. Called exactly
   * once per settle path (decide, expireStale, timer); a second settle is a
   * no-op because the entry is deleted here. Re-reading the store rather than
   * passing the value in means the waiter always sees what was persisted, not
   * what some caller hoped had been.
   */
  function settle(id: string): void {
    const pending = waiters.get(id);
    if (pending === undefined) return;
    waiters.delete(id);
    const row = store.getApproval(id);
    for (const resolve of pending) resolve(row);
  }

  /**
   * Arm the per-request expiry timer. A pending approval is a promise to a
   * blocked caller, and the deadline has to fire that promise without help:
   * relying on a periodic sweep alone would leave a waiter hanging whenever the
   * sweep is slow or the process idles. The timer only ever marks an approval
   * that is STILL pending — a human who answered first wins the race and the
   * timer then finds nothing to do.
   */
  function armExpiry(id: string, ttlMs: number): void {
    const previous = timers.get(id);
    if (previous !== undefined) clearTimeout(previous);
    const handle = setTimeout(() => {
      timers.delete(id);
      const row = store.getApproval(id);
      if (row === null || row.status !== "PENDING") return;
      store.decideApproval(id, "EXPIRED", now().toISOString());
      settle(id);
    }, ttlMs);
    // A pending approval must never hold the process open on its own.
    (handle as { unref?: () => void }).unref?.();
    timers.set(id, handle);
  }

  /**
   * Disarm every expiry timer and release every waiter.
   *
   * MUST run before the store closes. Two reasons, both observed: a timer firing
   * after the database is gone throws where nothing can catch it, and a caller
   * still parked in `waitFor` would otherwise wait for a promise nothing can
   * ever resolve.
   */
  function dispose(): void {
    for (const handle of timers.values()) clearTimeout(handle);
    timers.clear();
    for (const id of [...waiters.keys()]) settle(id);
  }

  function emit(type: KaiEventType, approval: Approval): void {
    if (publish === undefined) return;
    try {
      publish(type, approval, {
        source: "core",
        ...(approval.missionId !== undefined ? { missionId: approval.missionId } : {}),
        ...(approval.stepId !== undefined ? { stepId: approval.stepId } : {}),
      });
    } catch (error) {
      // The approval decision is already durable; a bus hiccup must not turn a
      // recorded verdict into a thrown one.
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`[kai-core] failed to publish ${type} for ${approval.id}: ${detail}`);
    }
  }

  function request(input: ApprovalRequestInput): Approval {
    const at = now();
    const ttl = normalizeTtl(input.ttlMs ?? defaultTtlMs);

    const approval: Approval = {
      id: idFactory(),
      toolId: input.toolId,
      action: input.action,
      reason: input.reason,
      risk: input.risk,
      createdAt: at.toISOString(),
      status: "PENDING",
      expiresAt: new Date(at.getTime() + ttl).toISOString(),
    };
    if (input.missionId !== undefined) approval.missionId = input.missionId;
    if (input.stepId !== undefined) approval.stepId = input.stepId;
    if (input.inputHash !== undefined) approval.inputHash = input.inputHash;

    store.createApproval(approval);
    emit("approval.requested", approval);
    // The deadline is armed here, at creation, not by the caller: expiry is part
    // of what "requested an approval" means, and a caller that forgets to arm it
    // would hand back an approval that can never expire.
    armExpiry(approval.id, ttl);
    return approval;
  }

  function decide(
    id: string,
    approved: boolean,
  ): { ok: true; approval: Approval } | { ok: false; reason: string } {
    const existing = store.getApproval(id);
    if (existing === null) {
      return { ok: false, reason: `approval "${id}" does not exist` };
    }
    // Idempotent-safe: a decided approval is final. Deciding twice must report
    // the second attempt as a failure WITHOUT flipping the recorded verdict —
    // otherwise a delayed double-click could reverse a rejection.
    if (existing.status !== "PENDING") {
      return {
        ok: false,
        reason: `approval "${id}" is already ${existing.status}; a decided approval cannot be changed`,
      };
    }

    const decidedAt = now().toISOString();
    const status: ApprovalStatus = approved ? "APPROVED" : "REJECTED";
    const updated: Approval = { ...existing, status, decidedAt };

    store.decideApproval(id, status, decidedAt);
    emit(approved ? "approval.approved" : "approval.rejected", updated);
    // Wake anyone blocked on this id — the human answered.
    settle(id);
    return { ok: true, approval: updated };
  }

  function expireStale(at?: Date): string[] {
    const cutoffMs = (at ?? now()).getTime();
    const expired: string[] = [];

    for (const approval of store.listApprovals({ status: "PENDING" })) {
      if (approval.expiresAt === undefined) continue;
      const expiresMs = Date.parse(approval.expiresAt);
      if (!Number.isFinite(expiresMs)) continue;
      // At-or-past the expiry instant the approval is stale: the window was
      // "valid until expiresAt", not "valid through expiresAt".
      if (expiresMs <= cutoffMs) {
        store.decideApproval(approval.id, "EXPIRED", new Date(cutoffMs).toISOString());
        expired.push(approval.id);
        // The sweep is a settle path too: a waiter must learn the answer was
        // "expired" here just as it would from the timer.
        settle(approval.id);
      }
    }

    return expired;
  }

  function waitFor(id: string): Promise<Approval | null> {
    const existing = store.getApproval(id);
    // Already settled (or unknown): answer immediately rather than park a
    // callback that will never be reached.
    if (existing === null || existing.status !== "PENDING") return Promise.resolve(existing);
    return new Promise<Approval | null>((resolve) => {
      const list = waiters.get(id) ?? [];
      list.push(resolve);
      waiters.set(id, list);
    });
  }

  function get(id: string): Approval | null {
    return store.getApproval(id);
  }

  function list(listOpts?: { status?: ApprovalStatus }): Approval[] {
    return store.listApprovals(listOpts);
  }

  return { request, decide, expireStale, waitFor, get, list, dispose };
}
