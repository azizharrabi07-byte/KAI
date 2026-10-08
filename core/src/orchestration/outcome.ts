// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * KAI's Outcome Contract + Outcome Gate + Decision Kernel.
 *
 * The problem these solve is not "can KAI call tools" but "does KAI keep
 * moving toward the user's ACTUAL outcome instead of producing activity". A
 * worker's CLAIM is not truth; only OBSERVATION + EVIDENCE the runtime can
 * inspect may satisfy the contract, and only the Gate may permit COMPLETED.
 *
 *   CLAIM        what the worker said happened
 *   OBSERVATION  what KAI actually observed (verification checks it ran)
 *   EVIDENCE     what can be inspected / independently cited
 *
 * The Decision Kernel is a BOUNDED, deterministic next-action chooser with
 * anti-loop signatures. It never executes — DECISION → (policy) → execution is
 * owned by the orchestrator. A model (e.g. a JEV-style provider) may be wired
 * as an ADVISORY provider later; its confidence is a signal, never truth.
 *
 * Adapted from OpenBot's deny-first / repetition / handoff-cap mechanisms
 * (github.com/ashhart/OpenBot, MIT). Independently reimplemented for KAI; no
 * OpenBot source copied.
 */

export type OutcomeResult = "PASS" | "FAIL" | "INSUFFICIENT_EVIDENCE" | "CONTRADICTED" | "UNKNOWN";

export interface OutcomeContract {
  missionId: string;
  originalIntent: string;
  normalizedObjective: string;
  deliverables: string[];
  constraints: string[];
  acceptanceCriteria: string[];
  requiredEvidence: string[];
  forbiddenOutcomes: string[];
  authorityScope: string[];
  timeBudgetMs?: number;
  costBudgetUsd?: number;
  maxRetries: number;
  /** "all_criteria" (default) — every acceptance criterion must be met. */
  completionPolicy: "all_criteria" | "any_criterion";
  /** "evidence_required" (default) — required evidence must be present. */
  verificationPolicy: "evidence_required" | "structural_only";
}

const FORBIDDEN_PATTERNS = [
  /\brm\s+-rf\s+\//i,
  /\bdrop\s+(table|database)\b/i,
  /\bforce[- ]push\b/i,
];

export function createOutcomeContract(input: {
  missionId: string;
  intent: string;
  objective?: string;
  deliverables?: string[];
  constraints?: string[];
  acceptanceCriteria?: string[];
  requiredEvidence?: string[];
  forbiddenOutcomes?: string[];
  authorityScope?: string[];
  timeBudgetMs?: number;
  costBudgetUsd?: number;
  maxRetries?: number;
}): OutcomeContract {
  const intent = input.intent.trim();
  return {
    missionId: input.missionId,
    originalIntent: intent,
    normalizedObjective: (input.objective ?? intent).trim(),
    deliverables: [...(input.deliverables ?? [])],
    constraints: [...(input.constraints ?? [])],
    // A consequential mission must know how success will be verified. When the
    // caller gives no criteria, KAI still requires the deliverable it named.
    acceptanceCriteria: input.acceptanceCriteria !== undefined && input.acceptanceCriteria.length > 0
      ? [...input.acceptanceCriteria]
      : (input.deliverables ?? []).length > 0
        ? input.deliverables!.map((d) => `deliverable present: ${d}`)
        : ["a user-facing deliverable exists"],
    requiredEvidence: [...(input.requiredEvidence ?? [])],
    forbiddenOutcomes: [...(input.forbiddenOutcomes ?? [])],
    authorityScope: [...(input.authorityScope ?? [])],
    ...(input.timeBudgetMs !== undefined ? { timeBudgetMs: input.timeBudgetMs } : {}),
    ...(input.costBudgetUsd !== undefined ? { costBudgetUsd: input.costBudgetUsd } : {}),
    maxRetries: input.maxRetries ?? 2,
    completionPolicy: "all_criteria",
    verificationPolicy: "evidence_required",
  };
}

/** What the runtime OBSERVED (not what the worker claimed). */
export interface Observation {
  /** The user-facing deliverable text (from the worker, but VERIFIED below). */
  deliverable: string;
  /** Evidence items the runtime or reviewer actually produced. */
  evidence: string[];
  /** criteria label -> met? (from verification, never the worker's claim). */
  criteriaMet: Record<string, boolean>;
  /** Free-text claims the worker made (never trusted as truth). */
  claims?: string[];
  changedArtifacts?: string[];
  unresolvedBlockers?: string[];
}

export interface OutcomeGateDecision {
  result: OutcomeResult;
  /** Which acceptance criteria are unmet, by label. */
  unmetCriteria: string[];
  missingEvidence: string[];
  /** A forbidden outcome was detected (e.g. a destructive command). */
  violations: string[];
  reason: string;
}

/** Does the evidence text satisfy a required-evidence phrase (token match)? */
function evidenceSatisfies(evidenceText: string, required: string): boolean {
  const needle = required.trim().toLowerCase();
  if (needle.length === 0) return true;
  if (evidenceText.includes(needle)) return true;
  const tokens = needle.match(/[a-z0-9]+/g)?.filter((t) => t.length >= 4) ?? [];
  if (tokens.length === 0) return evidenceText.includes(needle.slice(0, 24));
  return tokens.some((t) => evidenceText.includes(t));
}

/**
 * THE gate. PASS is the ONLY result that permits COMPLETED. Deterministic
 * wherever possible; the model is never consulted here.
 */
export function evaluateOutcome(contract: OutcomeContract, obs: Observation): OutcomeGateDecision {
  const violations = FORBIDDEN_PATTERNS.filter((re) => re.test(obs.deliverable)).map((re) => re.source);
  for (const forbidden of contract.forbiddenOutcomes) {
    if (forbidden.trim().length > 0 && obs.deliverable.toLowerCase().includes(forbidden.toLowerCase())) {
      violations.push(forbidden);
    }
  }
  if (violations.length > 0) {
    return { result: "CONTRADICTED", unmetCriteria: [], missingEvidence: [], violations, reason: `forbidden outcome detected: ${violations[0]}` };
  }

  if (obs.unresolvedBlockers !== undefined && obs.unresolvedBlockers.length > 0) {
    return {
      result: "FAIL",
      unmetCriteria: [...contract.acceptanceCriteria],
      missingEvidence: [],
      violations: [],
      reason: `unresolved blockers: ${obs.unresolvedBlockers.slice(0, 3).join("; ")}`,
    };
  }

  const deliverablePresent = obs.deliverable.trim().length > 0;
  const unmet = contract.acceptanceCriteria.filter((c) => obs.criteriaMet[c] !== true);
  const evidenceText = obs.evidence.join(" ").toLowerCase();
  const missingEvidence = contract.requiredEvidence.filter((e) => !evidenceSatisfies(evidenceText, e));

  const criteriaOk = contract.completionPolicy === "all_criteria"
    ? unmet.length === 0
    : unmet.length < contract.acceptanceCriteria.length || contract.acceptanceCriteria.length === 0;
  const evidenceOk = contract.verificationPolicy === "structural_only" || missingEvidence.length === 0;

  if (!deliverablePresent) {
    return { result: "FAIL", unmetCriteria: unmet, missingEvidence, violations: [], reason: "no deliverable produced" };
  }
  if (!criteriaOk) {
    return { result: "INSUFFICIENT_EVIDENCE", unmetCriteria: unmet, missingEvidence, violations: [], reason: `unmet acceptance criteria: ${unmet.slice(0, 3).join("; ")}` };
  }
  if (!evidenceOk) {
    return { result: "INSUFFICIENT_EVIDENCE", unmetCriteria: unmet, missingEvidence, violations: [], reason: `required evidence absent: ${missingEvidence.slice(0, 3).join("; ")}` };
  }
  // No criteria at all and a deliverable — nothing to judge against: UNKNOWN,
  // which never permits COMPLETED (the caller must add criteria).
  if (contract.acceptanceCriteria.length === 0) {
    return { result: "UNKNOWN", unmetCriteria: [], missingEvidence, violations: [], reason: "no acceptance criteria to gate on" };
  }
  return { result: "PASS", unmetCriteria: [], missingEvidence: [], violations: [], reason: "deliverable present and acceptance criteria met with evidence" };
}

// ── Decision Kernel ──────────────────────────────────────────────────────────

export type KernelAction =
  | "DO_IT_SELF"
  | "DELEGATE_ONE"
  | "PARALLELIZE"
  | "RUN_TESTS"
  | "INSPECT"
  | "VERIFY"
  | "RETRY"
  | "CHANGE_WORKER"
  | "REPLAN"
  | "ASK_USER"
  | "STOP"
  | "COMPLETE";

export interface ProgressSignals {
  /** Stable signature of the last action (strategy + worker + normalized input). */
  strategySignature: string;
  /** Stable signature of the last failure (code + message head). */
  failureSignature?: string;
  /** Did observable state change since the last action? */
  stateChanged: boolean;
}

export interface KernelInput {
  gate: OutcomeResult;
  /** Gate details, when not PASS. */
  unmetCriteria: string[];
  /** Consecutive no-progress actions. */
  noProgressStreak: number;
  /** Consecutive identical failure signatures. */
  sameFailureStreak: number;
  /** Consecutive failures by the current worker on this mission. */
  sameWorkerFailures: number;
  /** Configurable ceilings. */
  limits: { maxNoProgress: number; maxSameFailure: number; maxWorkerFailures: number; maxDepth: number };
  /** Whether another worker is available to switch to. */
  alternativeWorkerAvailable: boolean;
  /** Current delegation depth. */
  depth: number;
}

/**
 * Bounded, deterministic next action. Returns ONE action; never executes it.
 * Order matters: terminal → human → anti-loop → gate-driven → verify.
 */
export function decideNext(input: KernelInput): { action: KernelAction; reason: string } {
  const { gate, limits } = input;

  if (gate === "PASS") return { action: "COMPLETE", reason: "outcome gate passed" };
  if (input.depth >= limits.maxDepth) {
    return { action: "ASK_USER", reason: `delegation depth ${input.depth} reached the ceiling (${limits.maxDepth})` };
  }
  // Anti-loop: identical failure repeatedly → change strategy or worker.
  if (input.sameFailureStreak >= limits.maxSameFailure) {
    return input.alternativeWorkerAvailable
      ? { action: "CHANGE_WORKER", reason: `same failure ${input.sameFailureStreak}× — switching worker` }
      : { action: "REPLAN", reason: `same failure ${input.sameFailureStreak}× — changing strategy` };
  }
  if (input.sameWorkerFailures >= limits.maxWorkerFailures) {
    return input.alternativeWorkerAvailable
      ? { action: "CHANGE_WORKER", reason: `worker failed ${input.sameWorkerFailures}× on this mission` }
      : { action: "ASK_USER", reason: `worker failed ${input.sameWorkerFailures}× and no alternative is available` };
  }
  if (input.noProgressStreak >= limits.maxNoProgress) {
    return { action: "REPLAN", reason: `no meaningful progress for ${input.noProgressStreak} actions` };
  }
  if (gate === "CONTRADICTED") return { action: "REPLAN", reason: "evidence contradicts the claim" };
  if (gate === "UNKNOWN") return { action: "ASK_USER", reason: "cannot judge success without criteria" };
  if (gate === "INSUFFICIENT_EVIDENCE") {
    const needsTests = input.unmetCriteria.some((c) => /test|pass|fail|behavio/i.test(c));
    return needsTests
      ? { action: "RUN_TESTS", reason: `unmet criteria need behavioural evidence: ${input.unmetCriteria.slice(0, 2).join("; ")}` }
      : { action: "VERIFY", reason: `gathering evidence for: ${input.unmetCriteria.slice(0, 2).join("; ") || "required evidence"}` };
  }
  // FAIL with a deliverable missing / blocked.
  return { action: "RETRY", reason: gate === "FAIL" ? "deliverable incomplete" : "retrying" };
}

/** Stable signature of an action, for repetition detection. */
export function actionSignature(action: string, workerId: string | undefined, input: string): string {
  return `${action}|${workerId ?? "-"}|${input.trim().toLowerCase().slice(0, 120)}`;
}
