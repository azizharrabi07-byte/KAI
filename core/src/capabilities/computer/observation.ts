// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Observation deduplication.
 *
 * The failure this prevents: a computer-use loop that screenshots the same
 * unchanged screen every iteration, paying for an identical image each time and
 * drowning the model in near-duplicate frames. The mechanism is content
 * hashing — an identical frame (same hash, same view) is suppressed — but it
 * FAILS OPEN: a frame the driver could not hash is never suppressed, because
 * hiding a frame that might show something new is worse than one redundant
 * image.
 *
 * The hash is always reported back, even when the frame is suppressed, so a
 * caller can log or correlate frames without re-hashing the payload.
 *
 * Adapted from OpenMausBot's `server/computer-observation.ts` `ObservationCoordinator`
 * (Apache-2.0, design evidence only); the API here is KAI's.
 */

import { createHash } from "node:crypto";

/** Content hash of a frame payload. SHA-256, hex — matches how a driver's own full-frame hash is compared. */
export function hashFrame(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export type DedupeReason = "identical" | "changed" | "unhashed";

export interface DedupeDecision {
  /** True when this frame is byte-identical (and same view) to the last sent one. */
  suppressed: boolean;
  /** The frame's content hash, or null when none was available. Always reported. */
  hash: string | null;
  reason: DedupeReason;
}

export interface ObservationStats {
  captured: number;
  sent: number;
}

/**
 * Tracks the last observation signature. One instance per observe loop; not
 * shared across machines, because two machines showing the same pixels are
 * still two distinct observations.
 */
export class ObservationDeduper {
  private lastSignature: string | null = null;
  private captured = 0;
  private sent = 0;

  /**
   * Record a captured frame and decide whether it should reach the model.
   *
   * - hash present, same hash AND same view as last time → suppressed.
   * - hash present, different                            → changed, sent.
   * - hash absent                                         → unhashed, SENT
   *   (fail open; also clears the last signature so the next hashed frame is
   *   never wrongly suppressed against a frame we could not compare).
   */
  note(hash: string | null, view = "full"): DedupeDecision {
    this.captured += 1;

    if (hash === null) {
      this.lastSignature = null;
      this.sent += 1;
      return { suppressed: false, hash: null, reason: "unhashed" };
    }

    const signature = `${hash}:${view}`;
    const suppressed = signature === this.lastSignature;
    if (!suppressed) {
      this.lastSignature = signature;
      this.sent += 1;
    }
    return { suppressed, hash, reason: suppressed ? "identical" : "changed" };
  }

  stats(): ObservationStats {
    return { captured: this.captured, sent: this.sent };
  }
}
