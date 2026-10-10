// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Model runners for the goal layer.
 *
 * The Goal Challenger and the Goal Architect are deliberately model-agnostic:
 * both take an injected runner, so a test drives them with scripted replies and
 * needs no provider. This module is the PRODUCTION side of that seam — the only
 * place the goal layer talks to a model.
 *
 * Two rules it exists to enforce:
 *   - A critic reply is never trusted as a value. It is parsed, then passed
 *     through `normalizeFinding`, which converts anything malformed into a
 *     BLOCKED finding quoting the raw output. A model cannot produce a PASS by
 *     returning garbage.
 *   - A reviewer is given ONLY the goal, the contract and its own rubric. There
 *     is no field in `RoleInput` through which another critic's conclusion could
 *     reach it, so independence is structural rather than a convention.
 */

import { extractJson } from "../plans/plans.ts";
import { normalizeFinding, type ChallengeFinding, type RoleInput } from "./challenger.ts";

/** The critic identity: an adversarial reviewer, never an implementer. */
export const CRITIC_SYSTEM = [
  "You are an independent critic on KAI's goal review panel.",
  "You judge a proposed goal. You never implement, plan or approve it.",
  "Answer ONLY with a single JSON object matching the schema you are given.",
  "Your job is to find what is wrong, unproven or missing — not to be agreeable.",
  "Every objection must cite concrete evidence or a source reference, and must",
  "say how it could be resolved. Do not invent facts; if something is unknown,",
  "record it as an assumption or leave the field empty.",
].join(" ");

/** The planner identity: it plans within authority, never expands it. */
export const PLANNER_SYSTEM = [
  "You are KAI's goal planner. You turn a goal into an executable, verifiable plan.",
  "You may only plan work inside the authorized workspace and the stated constraints.",
  "Every acceptance criterion must have a concrete verification method — a command,",
  "an inspection, a diff review or a live result. Never state a criterion you cannot say",
  "how to check. Do not invent facts about the environment; list unknowns as uncertainties.",
  "Answer ONLY with the single JSON object the schema describes.",
].join(" ");

const FINDING_SCHEMA = `{
  "verdict": "PASS" | "CONDITIONAL" | "REVISE" | "BLOCKED",
  "objections": [
    {
      "statement": "what is wrong",
      "severity": "low" | "medium" | "high" | "critical",
      "blocking": true | false,
      "evidence": ["a file, command output or source you actually rely on"],
      "assumptions": ["something you are assuming"],
      "remediation": "the specific change that would resolve it",
      "verification": "how the fix would be demonstrated"
    }
  ],
  "notes": "optional, one short paragraph"
}`;

/** The prompt one critic sees: the goal, the contract, its rubric — nothing else. */
export function buildCriticPrompt(input: RoleInput): string {
  const contract = input.contract;
  return [
    `## Your role: ${input.role}`,
    `## Your rubric\n${input.rubric}`,
    `## Mode\n${input.mode} (round ${input.round})`,
    `## The goal under review (revision ${input.goalRevisionId})\n${input.goal}`,
    `## The artifact you are judging\n${input.content}`,
    `## Stated acceptance criteria\n${contract.acceptanceCriteria.map((c) => `- ${c}`).join("\n") || "- (none stated)"}`,
    `## Stated constraints\n${contract.constraints.map((c) => `- ${c}`).join("\n") || "- (none stated)"}`,
    `## Forbidden outcomes\n${contract.forbiddenOutcomes.map((c) => `- ${c}`).join("\n") || "- (none stated)"}`,
    `## Required evidence\n${(contract.requiredEvidence ?? []).map((c) => `- ${c}`).join("\n") || "- (none stated)"}`,
    `## Reply schema\n${FINDING_SCHEMA}`,
  ].join("\n\n");
}

/**
 * Parse one critic's reply. Unparseable text is NOT an error the caller can
 * ignore: it becomes a BLOCKED finding quoting the raw output, so a malformed
 * reply can never be read as approval.
 */
export function parseFinding(text: string, role: string): ChallengeFinding {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(text));
  } catch {
    return normalizeFinding(role, { verdict: "BLOCKED", unparsed: text.slice(0, 500) });
  }
  return normalizeFinding(role, parsed);
}
