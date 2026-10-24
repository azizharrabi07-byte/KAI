// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * evaluate.ts — §4C: revision-specific evaluation before promotion.
 *
 * A skill candidate is compared against the ACTIVE revision on the same recorded
 * task set. The verdict is what decides whether promotion may proceed; a candidate
 * that regresses is refused before it can reach staging.
 *
 * Three rules are structural, not policy, and each exists because its absence would
 * be a silent failure:
 *
 *   1. **The report binds to exact bytes.** `baselineSha256` and `candidateSha256`
 *      are in the report, and the promotion gate recomputes the candidate hash from
 *      the markdown it was handed. Different bytes invalidate the report — an
 *      evaluation can never be reused for a revision it did not test.
 *
 *   2. **A candidate cannot lower its own bar.** Acceptance lives in the TASK SET,
 *      which the evaluator supplies; nothing in the candidate's markdown is read as
 *      a criterion. A stronger aggregate score cannot erase a failed critical task.
 *
 *   3. **Absence of evidence is not a pass.** No baseline, too few tasks, a throw, a
 *      timeout — each produces `INCONCLUSIVE` or `ERROR`, both of which refuse.
 *      Only `PASS` promotes, and `PASS` requires that every task ran and every
 *      critical criterion held.
 */

import { sha256Hex } from "../skills/hash.ts";

/** The four outcomes. Only `PASS` permits promotion. */
export type EvalVerdict = "PASS" | "REGRESSION" | "INCONCLUSIVE" | "ERROR";

export interface RevisionRef {
  skillId: string;
  /** The exact bytes under evaluation. */
  markdown: string;
}

export interface EvalTaskOutcome {
  /** Did the task's own acceptance criteria hold? */
  ok: boolean;
  /** A criterion that must hold; failing it is a regression whatever else improved. */
  critical: boolean;
  /** What proves it. Bounded by the task set, never by the candidate. */
  evidence: string;
}

export interface EvaluationTask {
  id: string;
  /**
   * Run one revision over this task. Must be deterministic given the bytes: the
   * same revision evaluated twice yields the same outcome, which is what lets a
   * repeated evaluation be compared at all.
   */
  run: (markdown: string) => EvalTaskOutcome;
}

export interface EvaluationTaskSet {
  id: string;
  version: string;
  tasks: EvaluationTask[];
}

export interface EvaluationReport {
  verdict: EvalVerdict;
  skillId: string;
  taskSetId: string;
  taskSetVersion: string;
  /** Null when there is no active revision to compare against. */
  baselineSha256: string | null;
  candidateSha256: string;
  perTask: Array<{ id: string; baseline: EvalTaskOutcome | null; candidate: EvalTaskOutcome }>;
  /** Why the verdict is what it is. Never empty for a non-PASS verdict. */
  reasons: string[];
}

/** Enough tasks that a comparison is meaningful. Below this the verdict is INCONCLUSIVE. */
export const MIN_EVAL_TASKS = 2;

export interface EvaluateInput {
  skillId: string;
  candidate: RevisionRef;
  /** The active revision's markdown, or null when nothing is active yet. */
  baseline: RevisionRef | null;
  taskSet: EvaluationTaskSet | null;
  /** Wall-clock ceiling for the whole evaluation, in ms. 0 disables it. */
  timeoutMs?: number;
  now?: () => number;
}

/**
 * Compare the candidate against the active revision on one task set.
 *
 * Never throws: a runner that throws becomes `ERROR` with the message retained,
 * because an evaluation that cannot produce a trustworthy result must not be
 * mistaken for one that did.
 */
export function evaluateRevision(input: EvaluateInput): EvaluationReport {
  const candidateSha256 = sha256Hex(input.candidate.markdown);
  const baselineSha256 = input.baseline === null ? null : sha256Hex(input.baseline.markdown);
  const base: Omit<EvaluationReport, "verdict" | "reasons" | "perTask"> = {
    skillId: input.skillId,
    taskSetId: input.taskSet?.id ?? "(none)",
    taskSetVersion: input.taskSet?.version ?? "(none)",
    baselineSha256,
    candidateSha256,
  };

  if (input.taskSet === null) {
    return { ...base, verdict: "INCONCLUSIVE", reasons: ["no task set supplied — nothing to evaluate against"], perTask: [] };
  }
  const taskSet = input.taskSet;
  if (taskSet.tasks.length < MIN_EVAL_TASKS) {
    return {
      ...base,
      verdict: "INCONCLUSIVE",
      reasons: [`task set "${taskSet.id}" has ${taskSet.tasks.length} task(s); ${MIN_EVAL_TASKS} are required for a comparison`],
      perTask: [],
    };
  }
  if (baselineSha256 === null) {
    return {
      ...base,
      verdict: "INCONCLUSIVE",
      reasons: ["no active revision to compare against — a candidate cannot be promoted on its own results"],
      perTask: [],
    };
  }
  // A candidate identical to the active revision proves nothing; it is neither a
  // regression nor an improvement, and promoting it would be a no-op dressed as work.
  if (baselineSha256 === candidateSha256) {
    return {
      ...base,
      verdict: "INCONCLUSIVE",
      reasons: ["candidate bytes are identical to the active revision — there is nothing to evaluate"],
      perTask: [],
    };
  }

  const timeoutMs = input.timeoutMs ?? 0;
  const now = input.now ?? (() => Date.now());
  const deadline = timeoutMs > 0 ? now() + timeoutMs : Number.POSITIVE_INFINITY;

  const perTask: EvaluationReport["perTask"] = [];
  const reasons: string[] = [];

  for (const task of taskSet.tasks) {
    if (now() > deadline) {
      return { ...base, verdict: "ERROR", reasons: [`evaluation timed out after ${timeoutMs}ms at task "${task.id}"`], perTask };
    }
    let baselineOutcome: EvalTaskOutcome | null;
    let candidateOutcome: EvalTaskOutcome;
    try {
      candidateOutcome = task.run(input.candidate.markdown);
      baselineOutcome = input.baseline === null ? null : task.run(input.baseline.markdown);
    } catch (err) {
      // An environmental failure is not evidence that the skill regressed, and it is
      // certainly not a pass. It is ERROR, which refuses.
      return {
        ...base,
        verdict: "ERROR",
        reasons: [`task "${task.id}" threw: ${err instanceof Error ? err.message : String(err)}`],
        perTask,
      };
    }
    perTask.push({ id: task.id, baseline: baselineOutcome, candidate: candidateOutcome });
  }

  // 1. A required criterion that fails is a regression, whatever the aggregate says.
  for (const row of perTask) {
    if (row.candidate.critical && !row.candidate.ok) {
      reasons.push(`critical task "${row.id}" failed: ${row.candidate.evidence}`);
    }
  }
  // 2. A task the active revision passed and the candidate fails is a regression.
  for (const row of perTask) {
    if (row.baseline !== null && row.baseline.ok && !row.candidate.ok) {
      reasons.push(`"${row.id}" passed on the active revision and fails on the candidate: ${row.candidate.evidence}`);
    }
  }
  if (reasons.length > 0) return { ...base, verdict: "REGRESSION", reasons, perTask };

  // 3. PASS requires that something actually ran and held.
  const ran = perTask.length;
  if (ran < MIN_EVAL_TASKS) {
    return { ...base, verdict: "INCONCLUSIVE", reasons: [`only ${ran} task(s) produced a result`], perTask };
  }
  return { ...base, verdict: "PASS", reasons: [`${ran} task(s) held; no required criterion regressed`], perTask };
}

/**
 * Is this report still a valid statement about these exact bytes?
 *
 * The promotion gate calls this with the markdown it is about to stage, so a report
 * produced for a different revision — or for a baseline that has since moved — can
 * never authorise promotion.
 */
export function reportCovers(report: EvaluationReport, markdown: string, activeSha256: string | null): boolean {
  if (report.candidateSha256 !== sha256Hex(markdown)) return false;
  return report.baselineSha256 === activeSha256;
}
