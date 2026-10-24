// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * task-sets.ts — the §4C operational evaluation path.
 *
 * `evaluate.ts` defines the contract and `learn.ts` enforces the gate, but until a
 * task set is wired in the runtime every promotion is INCONCLUSIVE and refused. This
 * is that task set: versioned, recorded, and reproducible.
 *
 * ── What these tasks can and cannot be
 * A task here is a DETERMINISTIC CHECK OVER THE CANDIDATE'S OWN BYTES. That is the
 * honest form of an offline evaluation: the same markdown always yields the same
 * outcome, so a baseline and a candidate can be compared fairly and a re-run proves
 * the same thing. It is NOT a claim that the skill works in the world — that needs a
 * live run, and the report says so.
 *
 * Three properties are load-bearing:
 *
 *   1. **The acceptance criteria live HERE, never in the candidate.** A candidate
 *      cannot supply, weaken or replace a task; it is only ever the input.
 *   2. **At least one task is `critical`.** A candidate that gains elsewhere but
 *      drops a critical property is a REGRESSION, by the rule in `evaluate.ts`.
 *   3. **A task set is versioned and bumped when a criterion changes**, because the
 *      report records `taskSetVersion` — a promoted skill must be traceable to the
 *      exact criteria it was judged against.
 */

import type { EvalTaskOutcome, EvaluationTaskSet } from "./evaluate.ts";

/** A required heading, matched case-insensitively as a markdown heading. */
function hasHeading(markdown: string, word: string): boolean {
  return new RegExp(`^#{1,6}\\s*.*${word}`, "im").test(markdown);
}

/** A skill body must be substantial enough to instruct, not a stub. */
const MIN_BODY_CHARS = 120;

/**
 * Skill-form task set, version 1.
 *
 * Every task judges the markdown a worker proposed as a reusable procedure. They are
 * deliberately structural: they can be checked without a model, which is what makes
 * them reproducible, and they encode the properties a KAI skill must have before it
 * is worth trying in the world.
 */
export const SKILL_FORM_TASK_SET: EvaluationTaskSet = {
  id: "skill-form",
  version: "1",
  tasks: [
    {
      id: "has-trigger",
      // CRITICAL: a skill with no stated trigger cannot be selected correctly.
      run: (markdown): EvalTaskOutcome =>
        hasHeading(markdown, "trigger") || /when to use|use this when/i.test(markdown)
          ? { ok: true, critical: true, evidence: "the body states when the skill applies" }
          : { ok: false, critical: true, evidence: "no trigger/‘when to use’ section" },
    },
    {
      id: "has-method",
      run: (markdown): EvalTaskOutcome =>
        hasHeading(markdown, "method") || hasHeading(markdown, "steps") || /^\s*\d+\.\s/m.test(markdown)
          ? { ok: true, critical: true, evidence: "the body states the method as steps" }
          : { ok: false, critical: true, evidence: "no method/steps section" },
    },
    {
      id: "has-verification",
      // CRITICAL: an unverifiable procedure cannot feed KAI's evidence gate.
      run: (markdown): EvalTaskOutcome =>
        /verif|how to check|evidence/i.test(markdown)
          ? { ok: true, critical: true, evidence: "the body states how to verify the result" }
          : { ok: false, critical: true, evidence: "no verification/evidence step" },
    },
    {
      id: "not-a-stub",
      run: (markdown): EvalTaskOutcome =>
        markdown.trim().length >= MIN_BODY_CHARS
          ? { ok: true, critical: false, evidence: `${markdown.trim().length} chars >= ${MIN_BODY_CHARS}` }
          : { ok: false, critical: false, evidence: `only ${markdown.trim().length} chars` },
    },
    {
      id: "no-placeholder-instructions",
      run: (markdown): EvalTaskOutcome =>
        /\b(TODO|FIXME|TBD|lorem ipsum)\b/i.test(markdown)
          ? { ok: false, critical: false, evidence: "the body still carries placeholder text" }
          : { ok: true, critical: false, evidence: "no placeholder markers" },
    },
  ],
};

/** Every registered task set, by id. A promotion must name one of these. */
export const TASK_SETS: Record<string, EvaluationTaskSet> = {
  [SKILL_FORM_TASK_SET.id]: SKILL_FORM_TASK_SET,
};
