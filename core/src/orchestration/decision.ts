// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * DecisionProvider boundary — JEV (or any stronger evaluator) is an OPTIONAL
 * decision accelerator, never a requirement.
 *
 *   KAI Orchestrator → DecisionProvider → { deterministic | JEV }
 *
 * The DEFAULT is deterministic. KAI's correctness comes from the Outcome
 * Contract, Outcome Gate, Guard/policy, verification and anti-loop rules —
 * none of which consult a provider. A provider may only RANK/RECOMMEND among
 * candidate actions that deterministic rules already deemed legal; its
 * recommendation is then re-validated deterministically before it is used.
 *
 * A provider can NEVER: bypass Guard, bypass the Outcome Gate, exceed
 * authority, exceed budgets, or break a hard loop breaker. If it is disabled,
 * unavailable, times out, returns malformed output, or recommends something
 * illegal, KAI simply continues deterministically.
 */

import { decideNext, type KernelAction, type KernelInput } from "./outcome.ts";

export interface DecisionContext {
  missionId?: string;
  gate: KernelInput["gate"];
  unmetCriteria: string[];
  /** The deterministic candidate set (already legal by construction). */
  candidates: KernelAction[];
  /** The deterministic pick, for comparison/telemetry. */
  deterministicAction: KernelAction;
  noProgressStreak: number;
  sameFailureStreak: number;
  sameWorkerFailures: number;
  depth: number;
  /** Safe, bounded signals only — never a full world state. */
  note?: string;
}

export interface DecisionRecommendation {
  action: KernelAction;
  confidence: number;
  reasonCode: string;
}

export interface DecisionProvider {
  readonly id: string;
  /** Consult the provider. MUST resolve (never throw) — null means "no opinion". */
  choose(context: DecisionContext): Promise<DecisionRecommendation | null>;
}

/** The default authority: the deterministic Decision Kernel. Always present. */
export function createDeterministicDecisionProvider(): DecisionProvider {
  return {
    id: "deterministic",
    async choose(context: DecisionContext): Promise<DecisionRecommendation | null> {
      return { action: context.deterministicAction, confidence: 1, reasonCode: "deterministic_kernel" };
    },
  };
}

/**
 * A JEV-style provider is NOT shipped (no dependency, no network). This stub is
 * the plug-in point: an operator may inject a real one later. It is unavailable
 * by default and returns no opinion — KAI proceeds deterministically.
 */
export function createUnavailableJevProvider(): DecisionProvider {
  return {
    id: "jev",
    async choose(): Promise<DecisionRecommendation | null> {
      return null;
    },
  };
}

export interface JevBudget {
  enabled: boolean;
  maxCallsPerMission: number;
  maxCallsPerTurn: number;
  maxCostPerMission: number;
  cooldownMs: number;
  minDecisionValue: number;
  /** Only consult on genuinely ambiguous decisions. */
  allowOnAmbiguityOnly: boolean;
}

export const DEFAULT_JEV_BUDGET: JevBudget = {
  enabled: false,
  maxCallsPerMission: 5,
  maxCallsPerTurn: 1,
  maxCostPerMission: 0.5,
  cooldownMs: 2000,
  minDecisionValue: 0.5,
  allowOnAmbiguityOnly: true,
};

/**
 * Cost-aware invocation policy. A provider is worth consulting ONLY for
 * genuinely ambiguous strategy choices — never for hard safety decisions,
 * obvious transitions, or a gate that already settled deterministically.
 */
export function shouldConsultProvider(context: DecisionContext, budget: JevBudget): boolean {
  if (!budget.enabled) return false;
  // Hard/obvious cases the deterministic kernel already owns: never escalate.
  if (context.gate === "CONTRADICTED") return false; // forbidden/deny → deterministic
  if (context.gate === "PASS") return false; // completion is the Gate's call
  if (context.candidates.length <= 1) return false; // nothing to choose
  if (context.sameFailureStreak >= 2) return false; // loop breaker is deterministic
  if (context.depth >= 3) return false; // bounded depth → deterministic
  if (budget.allowOnAmbiguityOnly && context.candidates.length < 2) return false;
  return true;
}

/** Hard rules a provider recommendation may never override. */
const FORBIDDEN_FOR_PROVIDER: ReadonlySet<KernelAction> = new Set<KernelAction>([
  // The provider may recommend these, but they are ALWAYS re-validated by the
  // deterministic layer and Guard; listing them documents intent.
  "COMPLETE", // completion is only legal via OutcomeGate = PASS
]);

export interface DecideOutcome {
  action: KernelAction;
  reason: string;
  providerId: string;
  usedProvider: boolean;
  confidence: number;
  /** Present when a provider's recommendation was rejected by validation. */
  rejectedProvider?: { action: KernelAction; reason: string };
}

/**
 * The ONE decision entry point the orchestrator calls. Deterministic by
 * default; consults an optional provider only when the policy says it is worth
 * it AND the budget allows; ALWAYS re-validates the recommendation against the
 * deterministic candidates + hard rules. Never throws.
 */
export async function decideAction(
  kernelInput: KernelInput,
  opts: {
    provider?: DecisionProvider;
    budget?: JevBudget;
    candidates?: KernelAction[];
    missionId?: string;
    /** Per-mission call counter (caller-owned, persisted with the mission). */
    callsUsed?: number;
    costUsedUsd?: number;
    lastCallAtMs?: number;
    nowMs?: number;
    onProviderUsed?: (event: {
      provider: string;
      reason: string;
      decision: KernelAction;
      confidence: number;
      estimatedCost: number;
      missionId?: string;
    }) => void;
  } = {},
): Promise<DecideOutcome> {
  const deterministic = decideNext(kernelInput);
  const provider = opts.provider;
  const budget = opts.budget ?? DEFAULT_JEV_BUDGET;
  const base: DecideOutcome = {
    action: deterministic.action,
    reason: deterministic.reason,
    providerId: provider?.id ?? "deterministic",
    usedProvider: false,
    confidence: 1,
  };
  if (provider === undefined || provider.id === "deterministic") return base;

  const candidates = opts.candidates ?? [deterministic.action];
  const context: DecisionContext = {
    ...(opts.missionId !== undefined ? { missionId: opts.missionId } : {}),
    gate: kernelInput.gate,
    unmetCriteria: kernelInput.unmetCriteria,
    candidates,
    deterministicAction: deterministic.action,
    noProgressStreak: kernelInput.noProgressStreak,
    sameFailureStreak: kernelInput.sameFailureStreak,
    sameWorkerFailures: kernelInput.sameWorkerFailures,
    depth: kernelInput.depth,
  };
  // Budget + policy gate.
  if (!shouldConsultProvider(context, budget)) return base;
  if ((opts.callsUsed ?? 0) >= budget.maxCallsPerMission) return base;
  if ((opts.costUsedUsd ?? 0) >= budget.maxCostPerMission) return base;
  const now = opts.nowMs ?? Date.now();
  if (opts.lastCallAtMs !== undefined && now - opts.lastCallAtMs < budget.cooldownMs) return base;

  let recommendation: DecisionRecommendation | null = null;
  try {
    recommendation = await provider.choose(context);
  } catch {
    // A provider that throws is boring: fall back deterministically.
    return base;
  }
  if (recommendation === null) return base;

  // Deterministic re-validation: the recommendation must be a LEGAL candidate
  // and must not attempt to override a hard rule.
  const legal = candidates.includes(recommendation.action);
  if (!legal) {
    return { ...base, rejectedProvider: { action: recommendation.action, reason: "not a legal candidate" } };
  }
  if (FORBIDDEN_FOR_PROVIDER.has(recommendation.action) && kernelInput.gate !== "PASS") {
    return { ...base, rejectedProvider: { action: recommendation.action, reason: "completion is OutcomeGate-authoritative" } };
  }
  if (recommendation.confidence < budget.minDecisionValue) {
    return { ...base, rejectedProvider: { action: recommendation.action, reason: "below minDecisionValue" } };
  }

  opts.onProviderUsed?.({
    provider: provider.id,
    reason: recommendation.reasonCode,
    decision: recommendation.action,
    confidence: recommendation.confidence,
    estimatedCost: 0,
    ...(opts.missionId !== undefined ? { missionId: opts.missionId } : {}),
  });
  return {
    action: recommendation.action,
    reason: `${recommendation.reasonCode} (${provider.id})`,
    providerId: provider.id,
    usedProvider: true,
    confidence: recommendation.confidence,
  };
}
