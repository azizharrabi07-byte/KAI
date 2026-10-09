// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Autonomy matrix — what KAI may do WITHOUT asking, decided structurally.
 *
 * Levels (operator §34):
 *   0 Advisor      answers only; never delegates, reviews, or learns
 *   1 Delegator    may delegate READ-scoped work automatically
 *   2 Operator     delegates automatically; reviews per policy
 *   3 Guardian     delegates + reviews automatically; proposes skills
 *   4 Autonomous   full auto including AUTO_SAFE learning
 *
 * Per-dimension prefs (workerAuto/review/skillLearning) override within the
 * level: ASK routes through approvals, OFF disables. Irreversible and
 * high-risk operations ALWAYS require approval regardless of level — enforced
 * by the policy engine, never by this matrix. This matrix only selects AMONG
 * policy-allowed actions.
 */

import type { AutonomyLevel, AutonomyPolicy } from "./types.ts";

export type AutoAction = "delegate" | "review" | "learn" | "retry" | "reassign" | "verify";

export type AutoVerdict = "AUTO" | "ASK" | "OFF";

/** Resolve one action to AUTO/ASK/OFF from level + dimension pref. */
export function autoVerdict(policy: AutonomyPolicy, action: AutoAction, risk?: string): AutoVerdict {
  const highRisk = risk === "EXTERNAL" || risk === "DESTRUCTIVE";
  const dim: Record<AutoAction, "AUTO" | "ASK" | "OFF" | "PROPOSE" | "AUTO_SAFE"> = {
    delegate: policy.workerAuto,
    review: policy.review,
    learn: policy.skillLearning,
    retry: policy.workerAuto,
    reassign: policy.workerAuto,
    // Verification rides the review dimension: read-only checks run, guarded
    // effects ask — same posture as review, never a new bypass.
    verify: policy.review,
  };
  const pref = dim[action];
  if (pref === "OFF") return "OFF";
  if (action === "learn") {
    if (policy.level < 3) return "OFF";
    return pref === "AUTO_SAFE" && policy.level >= 4 ? "AUTO" : "ASK";
  }
  if (highRisk) return "ASK";
  if (policy.level === 0) return "OFF";
  if (pref === "ASK") return "ASK";
  if (action === "delegate" || action === "retry" || action === "reassign") {
    if (policy.level >= 2) return "AUTO";
    // Level 1 delegates READ-scoped work only; everything else asks.
    return risk === "READ" || risk === undefined ? "AUTO" : "ASK";
  }
  if (action === "review" || action === "verify") {
    return policy.level >= 2 ? "AUTO" : "ASK";
  }
  return "ASK";
}

export const AUTONOMY_LABELS: Record<AutonomyLevel, string> = {
  0: "Advisor",
  1: "Delegator",
  2: "Operator",
  3: "Guardian",
  4: "Autonomous",
};
