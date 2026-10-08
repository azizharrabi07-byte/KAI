// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Exact browser target/session ownership.
 *
 * A browser target (a tab/window) is a single mutable surface. Two agents driving
 * it at once is not a race KAI can tolerate: agent A navigates while agent B types
 * into what it believes is the same page, and both act on stale assumptions. So
 * ownership here is *exclusive and explicit* — a target has at most one owner at a
 * time, and an agent that does not hold the lease cannot drive it.
 *
 * Design choices worth stating:
 *
 *   - A lease is keyed by `targetId`, not by agent or session. Ownership is a
 *     property of the thing being driven, which is where the conflict actually
 *     lives.
 *   - Re-acquiring a lease you already hold is idempotent (same leaseId returned),
 *     so a retry or a re-entrant call does not have to special-case itself.
 *   - Acquiring a lease someone else holds is refused with POLICY_DENIED and a
 *     message naming both owners — the caller should be able to see who has it.
 *   - This layer is transport-agnostic: it knows nothing about pages, only about
 *     who may drive which id.
 */

import { isNonEmptyString, type KaiError } from "../../shared/contracts.ts";
import type { Result } from "./transport.ts";

/** A granted right to drive one target. */
export interface TargetLease {
  targetId: string;
  ownerId: string;
  /** Stable for the life of the lease; a re-acquire by the same owner keeps it. */
  leaseId: string;
  /** ISO-8601. */
  acquiredAt: string;
}

export interface OwnershipRegistry {
  /** Grants the lease, or refuses if another owner holds it. Idempotent for the
   * current owner. */
  acquire(targetId: string, ownerId: string): Result<TargetLease>;
  /** Releases the lease if `ownerId` holds it. Not holding it is not an error. */
  release(targetId: string, ownerId: string): Result<{ released: boolean }>;
  ownerOf(targetId: string): TargetLease | null;
  isOwner(targetId: string, ownerId: string): boolean;
  /** A snapshot, so a caller cannot mutate the live table through the return. */
  leases(): readonly TargetLease[];
  /** Drops every lease held by an owner (disconnect/cleanup). Returns the count. */
  releaseOwner(ownerId: string): number;
}

function deny(message: string, now: () => Date): KaiError {
  return { code: "POLICY_DENIED", message, retryable: false, at: now().toISOString() };
}

function invalid(message: string, now: () => Date): KaiError {
  return { code: "VALIDATION_FAILED", message, retryable: false, at: now().toISOString() };
}

export function createOwnershipRegistry(opts: {
  now?: () => Date;
  idFactory?: () => string;
} = {}): OwnershipRegistry {
  const now = opts.now ?? (() => new Date());
  let seq = 0;
  const idFactory = opts.idFactory ?? (() => `lease-${++seq}`);

  const byTarget = new Map<string, TargetLease>();

  function acquire(targetId: string, ownerId: string): Result<TargetLease> {
    if (!isNonEmptyString(targetId)) {
      return { ok: false, error: invalid("acquire() requires a non-empty targetId", now) };
    }
    if (!isNonEmptyString(ownerId)) {
      return { ok: false, error: invalid("acquire() requires a non-empty ownerId", now) };
    }

    const existing = byTarget.get(targetId);
    if (existing !== undefined) {
      if (existing.ownerId === ownerId) {
        // Idempotent: the same owner re-acquiring keeps the original lease, so a
        // paused-then-resumed caller does not have to track whether it already
        // held the target.
        return { ok: true, value: { ...existing } };
      }
      return {
        ok: false,
        error: deny(
          `target "${targetId}" is owned by agent "${existing.ownerId}" (lease ${existing.leaseId}); ` +
            `agent "${ownerId}" cannot drive it concurrently — the owner must release it first`,
          now,
        ),
      };
    }

    const lease: TargetLease = {
      targetId,
      ownerId,
      leaseId: idFactory(),
      acquiredAt: now().toISOString(),
    };
    byTarget.set(targetId, lease);
    return { ok: true, value: { ...lease } };
  }

  function release(targetId: string, ownerId: string): Result<{ released: boolean }> {
    if (!isNonEmptyString(targetId)) {
      return { ok: false, error: invalid("release() requires a non-empty targetId", now) };
    }
    if (!isNonEmptyString(ownerId)) {
      return { ok: false, error: invalid("release() requires a non-empty ownerId", now) };
    }
    const existing = byTarget.get(targetId);
    // Releasing something you do not hold is a no-op, not a failure: cleanup code
    // must be safe to run whether or not it actually owned anything.
    if (existing === undefined) return { ok: true, value: { released: false } };
    if (existing.ownerId !== ownerId) {
      return {
        ok: false,
        error: deny(
          `agent "${ownerId}" cannot release target "${targetId}"; it is owned by "${existing.ownerId}"`,
          now,
        ),
      };
    }
    byTarget.delete(targetId);
    return { ok: true, value: { released: true } };
  }

  function ownerOf(targetId: string): TargetLease | null {
    const lease = byTarget.get(targetId);
    return lease === undefined ? null : { ...lease };
  }

  function isOwner(targetId: string, ownerId: string): boolean {
    const lease = byTarget.get(targetId);
    return lease !== undefined && lease.ownerId === ownerId;
  }

  function leases(): readonly TargetLease[] {
    return [...byTarget.values()].map((lease) => ({ ...lease }));
  }

  function releaseOwner(ownerId: string): number {
    let removed = 0;
    for (const [targetId, lease] of byTarget) {
      if (lease.ownerId === ownerId) {
        byTarget.delete(targetId);
        removed += 1;
      }
    }
    return removed;
  }

  return { acquire, release, ownerOf, isOwner, leases, releaseOwner };
}
