// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * learning-task-set.test.ts — §4C is OPERATIONAL, not merely fail-closed.
 *
 * The gate was correct but untestable end-to-end because no task set existed, so
 * every promotion was INCONCLUSIVE. These tests drive the REAL task set
 * (`SKILL_FORM_TASK_SET`) and the REAL gate (`createLearning.submitProposal`) and
 * demonstrate both outcomes a promotion path must be able to produce:
 *
 *   a legitimate PASS that reaches staging, and a genuine REGRESSION that cannot.
 *
 *   cd core && node --test tests/learning-task-set.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";

import { evaluateRevision } from "../src/learning/evaluate.ts";
import { SKILL_FORM_TASK_SET, TASK_SETS } from "../src/learning/task-sets.ts";
import { createLearning, type SkillCandidate } from "../src/orchestration/learn.ts";
import { sha256Hex } from "../src/skills/hash.ts";

const CANDIDATE: SkillCandidate = {
  title: "Skill: upgrade a dependency safely",
  trigger: "when a dependency must be upgraded",
  method: "1. pin, 2. upgrade, 3. run tests",
  tools: [],
  constraints: [],
  sourceTaskId: "t1",
  consideredSkillIds: [],
  pattern: "success",
};

/** A body that satisfies every criterion in the task set. */
const GOOD = `# Upgrade a dependency safely

## Trigger
Use this when a dependency must be upgraded.

## Method
1. Pin the current version and run the tests to get a green baseline.
2. Upgrade one dependency at a time.
3. Re-run the suite after each upgrade.

## Verification
Run the full suite and diff the lockfile; a passing suite with an unchanged
behaviour surface is the evidence the upgrade is safe.
`;

/** A body that DROPS the verification step — a critical criterion. */
const REGRESSING = `# Upgrade a dependency safely

## Trigger
Use this when a dependency must be upgraded.

## Method
1. Upgrade every dependency at once.
2. Re-run the suite once at the end.
`;

/** A weak body: no verification, and short. */
const WEAK = "# Upgrade\n\nJust upgrade it.\n";

test("the task set is registered and versioned", () => {
  assert.equal(TASK_SETS[SKILL_FORM_TASK_SET.id]?.version, SKILL_FORM_TASK_SET.version);
  assert.ok(SKILL_FORM_TASK_SET.tasks.length >= 2, "at least MIN_EVAL_TASKS tasks");
  assert.ok(
    SKILL_FORM_TASK_SET.tasks.some((t) => t.id === "has-verification"),
    "the verification criterion is part of the set",
  );
});

test("a complete body PASSES against a weak baseline", () => {
  const report = evaluateRevision({
    skillId: "upgrade",
    candidate: { skillId: "upgrade", markdown: GOOD },
    baseline: { skillId: "upgrade", markdown: WEAK },
    taskSet: SKILL_FORM_TASK_SET,
  });
  assert.equal(report.verdict, "PASS", JSON.stringify(report.reasons));
  assert.equal(report.taskSetVersion, SKILL_FORM_TASK_SET.version);
  assert.equal(report.candidateSha256, sha256Hex(GOOD), "the report binds the candidate bytes");
  assert.equal(report.baselineSha256, sha256Hex(WEAK), "and the baseline it compared against");
});

test("dropping the verification step is a REGRESSION even with a longer method", () => {
  const report = evaluateRevision({
    skillId: "upgrade",
    candidate: { skillId: "upgrade", markdown: REGRESSING },
    // The baseline PASSES the verification criterion, so losing it is a regression.
    baseline: { skillId: "upgrade", markdown: GOOD },
    taskSet: SKILL_FORM_TASK_SET,
  });
  assert.equal(report.verdict, "REGRESSION", JSON.stringify(report.reasons));
  assert.ok(
    report.reasons.some((r) => /has-verification/.test(r)),
    `a reason must name the critical task: ${report.reasons.join("; ")}`,
  );
});

test("a candidate identical to its baseline is INCONCLUSIVE, not a PASS", () => {
  const report = evaluateRevision({
    skillId: "upgrade",
    candidate: { skillId: "upgrade", markdown: GOOD },
    baseline: { skillId: "upgrade", markdown: GOOD },
    taskSet: SKILL_FORM_TASK_SET,
  });
  assert.equal(report.verdict, "INCONCLUSIVE");
});

// ── Through the real gate ─────────────────────────────────────────────────────

function harness(activeMarkdown: string | null) {
  const staged: { id: string; markdown: string }[] = [];
  const learning = createLearning({
    metrics: { upsert() {}, get: () => null, list: () => [] },
    validate: () => ({ ok: true }),
    stage: (input) => {
      staged.push(input);
      return { ok: true };
    },
    evaluate: ({ skillId, markdown }) =>
      evaluateRevision({
        skillId,
        candidate: { skillId, markdown },
        baseline: activeMarkdown === null ? null : { skillId, markdown: activeMarkdown },
        taskSet: SKILL_FORM_TASK_SET,
      }),
    activeSha256: () => (activeMarkdown === null ? null : sha256Hex(activeMarkdown)),
  });
  return { learning, staged };
}

test("a legitimate PASS reaches the existing staging port", () => {
  const { learning, staged } = harness(WEAK);
  const result = learning.submitProposal(CANDIDATE, GOOD);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(staged.length, 1, "the candidate was staged exactly once");
  assert.equal(staged[0]?.markdown, GOOD, "the staged bytes are the evaluated bytes");
});

test("a REGRESSION is refused and never reaches staging", () => {
  const { learning, staged } = harness(GOOD);
  const result = learning.submitProposal(CANDIDATE, REGRESSING);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /^evaluation REGRESSION:/);
  assert.equal(staged.length, 0, "nothing was staged");
});

test("a skill with no active revision is INCONCLUSIVE and refused", () => {
  const { learning, staged } = harness(null);
  const result = learning.submitProposal(CANDIDATE, GOOD);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /^evaluation INCONCLUSIVE:/);
  assert.equal(staged.length, 0);
});

test("changing the candidate after evaluation invalidates it", () => {
  // Evaluate GOOD, then submit different bytes through a gate that still reports the
  // earlier report — the freshness check must catch it.
  const report = evaluateRevision({
    skillId: "upgrade",
    candidate: { skillId: "upgrade", markdown: GOOD },
    baseline: { skillId: "upgrade", markdown: WEAK },
    taskSet: SKILL_FORM_TASK_SET,
  });
  assert.equal(report.verdict, "PASS");

  const staged: unknown[] = [];
  const learning = createLearning({
    metrics: { upsert() {}, get: () => null, list: () => [] },
    validate: () => ({ ok: true }),
    stage: (input) => {
      staged.push(input);
      return { ok: true };
    },
    // Returns the stale report for ANY bytes.
    evaluate: () => report,
    activeSha256: () => sha256Hex(WEAK),
  });
  const result = learning.submitProposal(CANDIDATE, `${GOOD}\n\nsmuggled extra instruction`);
  assert.equal(result.ok, false, "stale evidence must not authorise different bytes");
  assert.equal(staged.length, 0);
});
