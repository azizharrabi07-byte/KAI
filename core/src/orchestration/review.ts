// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Reviewer loop.
 *
 * The reviewer receives ONLY the work contract (objective + deliverable +
 * criteria), the artifact, and the evidence. `requestReview` builds the
 * reviewer prompt from exactly those fields — any extra property on the
 * caller's input object (a transcript, a canary, anything) is ignored by
 * construction because it is never read.
 *
 * `runReviewLoop` bounds the rounds (default 2): PASS resolves done,
 * BLOCKED stops immediately, CHANGES_REQUESTED exhausts the budget and then
 * returns the last verdict + findings so the CALLER can retry the work.
 */

import { redactText } from "../redact/index.ts";
import type { ReviewVerdict } from "./types.ts";

/** The work contract under review. */
export interface ReviewContractInput {
  objective: string;
  deliverable?: string;
  criteria: string[];
}

/** Everything the review step may accept. No transcript field exists. */
export interface ReviewRequestInput {
  contract: ReviewContractInput;
  artifact: string;
  evidence: string[];
}

/** Exactly what the reviewer is allowed to see. */
export interface ReviewerPromptInput {
  objective: string;
  deliverable?: string;
  criteria: string[];
  artifact: string;
  evidence: string[];
}

export interface ReviewRunnerResult {
  verdict: ReviewVerdict;
  findings: string[];
}

export interface ReviewDeps {
  runner: (prompt: string) => Promise<ReviewRunnerResult>;
  buildPrompt: (input: ReviewerPromptInput) => string;
}

export interface ReviewOutcome {
  verdict: ReviewVerdict;
  findings: string[];
  /** The exact reviewer prompt that was sent (for tests/audit). */
  prompt: string;
}

export interface ReviewLoopOutcome {
  verdict: ReviewVerdict;
  findings: string[];
  /** How many reviewer rounds actually ran. Always 1..maxRounds. */
  rounds: number;
}

/**
 * Default reviewer-prompt renderer: contract + artifact + evidence + criteria
 * only, redacted. Custom renderers may be injected via `ReviewDeps.buildPrompt`
 * as long as they keep the same input shape.
 */
export function buildReviewerPrompt(input: ReviewerPromptInput): string {
  const criteria =
    input.criteria.length === 0
      ? "(none)"
      : input.criteria.map((c) => `- ${redactText(c)}`).join("\n");
  const evidence =
    input.evidence.length === 0
      ? "(none)"
      : input.evidence.map((e) => `- ${redactText(e)}`).join("\n");
  const lines = [
    "## REVIEW CONTRACT",
    `Objective: ${redactText(input.objective)}`,
    `Deliverable: ${input.deliverable !== undefined ? redactText(input.deliverable) : "(none)"}`,
    "## ACCEPTANCE CRITERIA",
    criteria,
    "## ARTIFACT UNDER REVIEW",
    redactText(input.artifact),
    "## EVIDENCE",
    evidence,
  ];
  return lines.join("\n");
}

/** The reviewer identity: judges, never implements. Shared by runtime and commands. */
export const REVIEWER_SYSTEM = [
  "You review a worker's handoff against its contract. You did not do the work.",
  "Reply with exactly one verdict word first (PASS, CHANGES_REQUESTED, or BLOCKED),",
  "then one finding per line. Judge only the contract, artifact and evidence given.",
].join(" ");

/**
 * Lenient verdict parse. Unparseable replies are BLOCKED (a reviewer that
 * could not decide blocks the deliverable) — never upgraded to PASS.
 */
export function parseReviewVerdict(text: string): { verdict: ReviewVerdict; findings: string[] } {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const first = (lines[0] ?? "").toUpperCase().replace(/[\s_-]+/g, "_");
  const verdict: ReviewVerdict = first.startsWith("PASS")
    ? "PASS"
    : first.startsWith("CHANGES_REQUESTED") || first.startsWith("CHANGES REQUESTED")
      ? "CHANGES_REQUESTED"
      : "BLOCKED";
  const findings = lines.slice(1).map((l) => l.replace(/^[-*]\s*/, "").trim()).filter((l) => l.length > 0).slice(0, 10);
  return { verdict, findings };
}

/**
 * Run one review round. Only contract+artifact+evidence+criteria reach the
 * reviewer prompt — extra fields on `input` are never read.
 */
export async function requestReview(
  deps: ReviewDeps,
  input: ReviewRequestInput,
): Promise<ReviewOutcome> {
  const { contract, artifact, evidence } = input;
  const reviewerInput: ReviewerPromptInput = {
    objective: contract.objective,
    ...(contract.deliverable !== undefined ? { deliverable: contract.deliverable } : {}),
    criteria: [...contract.criteria],
    artifact,
    evidence: [...evidence],
  };
  const prompt = deps.buildPrompt(reviewerInput);
  const result = await deps.runner(prompt);
  return { verdict: result.verdict, findings: [...result.findings], prompt };
}

/**
 * Bounded review rounds. PASS and BLOCKED stop immediately; CHANGES_REQUESTED
 * consumes another round until `maxRounds` is exhausted, then the last
 * verdict + findings are returned for the caller to act on.
 */
export async function runReviewLoop(
  deps: ReviewDeps,
  input: ReviewRequestInput,
  maxRounds = 2,
): Promise<ReviewLoopOutcome> {
  const budget = Number.isInteger(maxRounds) && maxRounds >= 1 ? maxRounds : 1;
  let rounds = 0;
  let last: ReviewOutcome = { verdict: "BLOCKED", findings: [], prompt: "" };
  for (let round = 1; round <= budget; round += 1) {
    const outcome = await requestReview(deps, input);
    rounds = round;
    last = outcome;
    if (outcome.verdict === "PASS") {
      return { verdict: outcome.verdict, findings: outcome.findings, rounds };
    }
    if (outcome.verdict === "BLOCKED") {
      return { verdict: outcome.verdict, findings: outcome.findings, rounds };
    }
    // CHANGES_REQUESTED: another round while budget remains, else hand back
    // the verdict + findings so the caller retries the work.
  }
  return { verdict: last.verdict, findings: last.findings, rounds };
}
