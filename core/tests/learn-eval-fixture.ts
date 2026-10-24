// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * learn-eval-fixture.ts — the evaluation dependency for tests that are NOT about
 * the §4C gate.
 *
 * The promotion gate is required, so every `createLearning` call must supply one.
 * Tests whose subject is staging, campaigns or orchestration need a gate that
 * passes so they can reach the behaviour they actually assert. This fixture is
 * deliberately explicit and named so it cannot be mistaken for production wiring:
 *
 *   • It runs the REAL `evaluateRevision` with a real two-task set, so the report
 *     carries genuine sha256 values and passes the `reportCovers` freshness check.
 *   • It is honest about being permissive — that is its entire purpose.
 *
 * Tests that assert the gate itself must NOT use this; they construct their own
 * task sets. See `learning-evaluate.test.ts`.
 */

import { evaluateRevision, type EvaluationReport } from "../src/learning/evaluate.ts";
import { sha256Hex } from "../src/skills/hash.ts";

/** Two tasks that always hold, for harnesses that need the gate to pass. */
export const PASSING_TASK_SET = {
  id: "fixture-task-set",
  version: "1",
  tasks: [
    { id: "holds-a", run: () => ({ ok: true, critical: true, evidence: "fixture: always holds" }) },
    { id: "holds-b", run: () => ({ ok: true, critical: false, evidence: "fixture: always holds" }) },
  ],
};

/**
 * Build the `evaluate` + `activeSha256` pair for a harness.
 *
 * `baselineMarkdown` is the revision the harness pretends is active; it must be
 * DIFFERENT from the candidate markdown or the evaluator correctly reports
 * INCONCLUSIVE (identical bytes prove nothing).
 */
export function evaluatingDeps(baselineMarkdown = "# Skill\n\nbaseline revision\n"): {
  evaluate: (input: { skillId: string; markdown: string }) => EvaluationReport;
  activeSha256: (skillId: string) => string | null;
} {
  return {
    evaluate: ({ skillId, markdown }) =>
      evaluateRevision({
        skillId,
        candidate: { skillId, markdown },
        baseline: { skillId, markdown: baselineMarkdown },
        taskSet: PASSING_TASK_SET,
      }),
    // The fixture's "active" revision is always the baseline it compares against, so
    // the freshness check sees a stable, matching hash.
    activeSha256: () => sha256Hex(baselineMarkdown),
  };
}
