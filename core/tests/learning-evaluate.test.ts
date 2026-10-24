// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * §4C revision-evaluation tests. Run from `core/`:
 *   node --test tests/learning-evaluate.test.ts
 *
 * Two halves, both about the same rule: only a PASS bound to these exact bytes and
 * to the revision that is active NOW may promote.
 *
 *   1. `evaluateRevision` / `reportCovers` directly — every verdict, the reasons
 *      that carry them, and the exact-byte binding.
 *   2. The real `createLearning(...).submitProposal` gate — that each non-PASS
 *      verdict, a stale report, and a throwing evaluator are refused BEFORE the
 *      stage port is touched. These tests deliberately do NOT use the permissive
 *      `learn-eval-fixture.ts`, because their subject is the refusal itself.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  MIN_EVAL_TASKS,
  evaluateRevision,
  reportCovers,
  type EvaluationReport,
  type EvaluationTask,
  type EvaluationTaskSet,
  type EvalTaskOutcome,
} from "../src/learning/evaluate.ts";
import {
  createLearning,
  type SkillCandidate,
  type SkillLearning,
  type StageCheck,
  type StageInput,
} from "../src/orchestration/learn.ts";
import { sha256Hex } from "../src/skills/hash.ts";
import type { SkillMetricsStore } from "../src/shared/contracts.ts";

const BASE_MD = "# Skill\n\nbaseline revision\n";
const CAND_MD = "# Skill\n\ncandidate revision\n";
const BASE_SHA = sha256Hex(BASE_MD);

const holds = (critical = false, evidence = "holds"): EvalTaskOutcome => ({ ok: true, critical, evidence });
const fails = (critical = false, evidence = "failed"): EvalTaskOutcome => ({ ok: false, critical, evidence });

function task(id: string, run: (markdown: string) => EvalTaskOutcome): EvaluationTask {
  return { id, run };
}

function taskSet(tasks: EvaluationTask[], id = "ts-1", version = "1"): EvaluationTaskSet {
  return { id, version, tasks };
}

/** A two-task set that holds for any revision — the smallest valid comparison. */
function alwaysHoldingSet(): EvaluationTaskSet {
  return taskSet([
    task("holds-a", () => holds(true, "a holds")),
    task("holds-b", () => holds(false, "b holds")),
  ]);
}

function evaluate(over: Partial<Parameters<typeof evaluateRevision>[0]> = {}): EvaluationReport {
  return evaluateRevision({
    skillId: "skill-x",
    candidate: { skillId: "skill-x", markdown: CAND_MD },
    baseline: { skillId: "skill-x", markdown: BASE_MD },
    taskSet: alwaysHoldingSet(),
    ...over,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// evaluateRevision — verdicts
// ─────────────────────────────────────────────────────────────────────────────

test("PASS when every task holds and no required criterion regresses", () => {
  const report = evaluate();
  assert.equal(report.verdict, "PASS");
  assert.equal(report.skillId, "skill-x");
  assert.equal(report.taskSetId, "ts-1");
  assert.equal(report.taskSetVersion, "1");
  assert.equal(report.candidateSha256, sha256Hex(CAND_MD));
  assert.equal(report.baselineSha256, BASE_SHA);
  assert.equal(report.perTask.length, 2);
  assert.ok(report.reasons.length > 0, "a PASS still states what held");
});

test("REGRESSION when a critical task fails even though the aggregate improves", () => {
  // "critical" regresses on the candidate while "improved" goes the other way, so
  // the candidate is strictly better on the aggregate and still must not promote.
  const set = taskSet([
    task("critical", (md) => (md === BASE_MD ? holds(true, "baseline held it") : fails(true, "candidate broke it"))),
    task("improved", (md) => (md === BASE_MD ? fails(false, "baseline failed it") : holds(false, "candidate fixed it"))),
  ]);
  const report = evaluate({ taskSet: set });

  assert.equal(report.verdict, "REGRESSION");
  assert.ok(
    report.reasons.some((r) => r.includes('critical task "critical"')),
    `a reason names the critical task, got: ${JSON.stringify(report.reasons)}`,
  );
  assert.equal(report.perTask.length, 2, "the whole task set is still recorded");
});

test("REGRESSION when a task the active revision passed fails on the candidate", () => {
  const set = taskSet([
    task("regressed", (md) => (md === BASE_MD ? holds(false, "baseline held it") : fails(false, "candidate broke it"))),
    task("stable", () => holds(false, "unaffected")),
  ]);
  const report = evaluate({ taskSet: set });

  assert.equal(report.verdict, "REGRESSION");
  assert.ok(
    report.reasons.some((r) => r.includes('"regressed" passed on the active revision and fails on the candidate')),
    `got: ${JSON.stringify(report.reasons)}`,
  );
});

test("INCONCLUSIVE when no task set is supplied", () => {
  const report = evaluate({ taskSet: null });
  assert.equal(report.verdict, "INCONCLUSIVE");
  assert.equal(report.taskSetId, "(none)");
  assert.equal(report.perTask.length, 0);
  assert.ok(report.reasons.some((r) => r.includes("no task set")));
});

test("INCONCLUSIVE when the task set has fewer than MIN_EVAL_TASKS tasks", () => {
  const short = taskSet([task("only-one", () => holds(true))]);
  assert.ok(short.tasks.length < MIN_EVAL_TASKS);

  const report = evaluate({ taskSet: short });
  assert.equal(report.verdict, "INCONCLUSIVE");
  assert.equal(report.perTask.length, 0);
  assert.ok(report.reasons.some((r) => r.includes(`${MIN_EVAL_TASKS} are required`)));
});

test("INCONCLUSIVE when there is no active revision to compare against", () => {
  const report = evaluate({ baseline: null });
  assert.equal(report.verdict, "INCONCLUSIVE");
  assert.equal(report.baselineSha256, null);
  assert.equal(report.perTask.length, 0);
  assert.ok(report.reasons.some((r) => r.includes("no active revision")));
});

test("INCONCLUSIVE when the candidate bytes are identical to the active revision", () => {
  const report = evaluate({
    candidate: { skillId: "skill-x", markdown: BASE_MD },
    baseline: { skillId: "skill-x", markdown: BASE_MD },
  });
  assert.equal(report.verdict, "INCONCLUSIVE");
  assert.equal(report.candidateSha256, report.baselineSha256);
  assert.ok(report.reasons.some((r) => r.includes("identical to the active revision")));
});

test("ERROR when a task runner throws, and the thrown message is retained in reasons", () => {
  const set = taskSet([
    task("explodes", () => {
      throw new Error("runner could not reach its fixture");
    }),
    task("never-reached", () => holds()),
  ]);
  const report = evaluate({ taskSet: set });

  assert.equal(report.verdict, "ERROR");
  assert.equal(report.verdict === "REGRESSION", false);
  assert.equal(report.verdict === "PASS", false);
  assert.ok(
    report.reasons.some((r) => r.includes('task "explodes" threw: runner could not reach its fixture')),
    `got: ${JSON.stringify(report.reasons)}`,
  );
  assert.equal(report.perTask.length, 0, "the throwing task produced no outcome");
});

test("ERROR when the evaluation exceeds timeoutMs", () => {
  let ticks = 0;
  const report = evaluate({
    timeoutMs: 10,
    // Each call advances 100ms: the first call sets the deadline, the next one
    // already exceeds it, so the very first task trips the ceiling.
    now: () => (ticks += 100),
  });

  assert.equal(report.verdict, "ERROR");
  assert.ok(
    report.reasons.some((r) => r.includes("timed out after 10ms")),
    `got: ${JSON.stringify(report.reasons)}`,
  );
  assert.equal(report.perTask.length, 0, "no task was allowed to run");
});

test("perTask records both the baseline and candidate outcome for every task", () => {
  const set = taskSet([
    task("mixed", (md) => (md === BASE_MD ? holds(false, "baseline evidence") : fails(false, "candidate evidence"))),
    task("stable", () => holds(true, "stable evidence")),
  ]);
  const report = evaluate({ taskSet: set });

  assert.equal(report.perTask.length, set.tasks.length);
  assert.deepEqual(report.perTask, [
    {
      id: "mixed",
      baseline: holds(false, "baseline evidence"),
      candidate: fails(false, "candidate evidence"),
    },
    {
      id: "stable",
      baseline: holds(true, "stable evidence"),
      candidate: holds(true, "stable evidence"),
    },
  ]);
});

test("re-evaluating the same input yields the same verdict and the same sha256 values", () => {
  const set = taskSet([
    task("mixed", (md) => (md === BASE_MD ? holds(true) : fails(false, "candidate broke it"))),
    task("stable", () => holds(false)),
  ]);
  const first = evaluate({ taskSet: set });
  const second = evaluate({ taskSet: set });

  assert.equal(first.verdict, "REGRESSION");
  assert.equal(second.verdict, first.verdict);
  assert.equal(second.candidateSha256, first.candidateSha256);
  assert.equal(second.baselineSha256, first.baselineSha256);
  assert.deepEqual(second.perTask, first.perTask);
  assert.deepEqual(second.reasons, first.reasons);
});

// ─────────────────────────────────────────────────────────────────────────────
// reportCovers — the exact-byte / active-baseline binding
// ─────────────────────────────────────────────────────────────────────────────

test("reportCovers is false when the markdown differs from the evaluated candidate bytes", () => {
  const report = evaluate();
  assert.equal(report.verdict, "PASS");

  assert.equal(reportCovers(report, CAND_MD, BASE_SHA), true, "sanity: the evaluated bytes do match");
  assert.equal(reportCovers(report, `${CAND_MD} `), false);
  assert.equal(reportCovers(report, BASE_MD, BASE_SHA), false);
});

test("reportCovers is false when the active baseline moved after the report", () => {
  const report = evaluate();
  const movedSha = sha256Hex("# Skill\n\nsomeone else promoted\n");

  assert.equal(reportCovers(report, CAND_MD, movedSha), false);
  assert.equal(reportCovers(report, CAND_MD, null), false);
});

test("reportCovers is true only for the exact bytes and the matching baseline", () => {
  const report = evaluate();
  assert.equal(reportCovers(report, CAND_MD, report.baselineSha256), true);
});

// ─────────────────────────────────────────────────────────────────────────────
// createLearning().submitProposal — the real promotion gate
// ─────────────────────────────────────────────────────────────────────────────

function metricsStore(): SkillMetricsStore {
  return { upsert() {}, get: () => null, list: () => [] };
}

function gate(options: {
  taskSet: EvaluationTaskSet | null;
  /** When set, the report is built for THESE bytes instead of the submitted markdown. */
  reportFor?: string;
  evaluatorThrows?: boolean;
  stageCheck?: (input: StageInput) => StageCheck;
}): { learning: SkillLearning; stageCalls: StageInput[] } {
  const stageCalls: StageInput[] = [];
  const learning = createLearning({
    metrics: metricsStore(),
    validate: () => ({ ok: true }),
    stage: (input) => {
      stageCalls.push(input);
      return options.stageCheck ? options.stageCheck(input) : { ok: true };
    },
    evaluate: ({ skillId, markdown }) => {
      if (options.evaluatorThrows) throw new Error("evaluator exploded");
      return evaluateRevision({
        skillId,
        candidate: { skillId, markdown: options.reportFor ?? markdown },
        baseline: { skillId, markdown: BASE_MD },
        taskSet: options.taskSet,
      });
    },
    activeSha256: () => BASE_SHA,
  });
  return { learning, stageCalls };
}

function candidate(title = "Skill: gate test"): SkillCandidate {
  return {
    title,
    trigger: "Tasks like: exercise the gate",
    method: "- do the thing",
    tools: [],
    constraints: [],
    sourceTaskId: "task_1",
    consideredSkillIds: [],
    pattern: "success",
  };
}

test("a REGRESSION verdict cannot pass submitProposal and never reaches stage", () => {
  const set = taskSet([
    task("critical", (md) => (md === BASE_MD ? holds(true) : fails(true, "candidate broke a required rule"))),
    task("stable", () => holds(false)),
  ]);
  const { learning, stageCalls } = gate({ taskSet: set });

  const result = learning.submitProposal(candidate(), CAND_MD);
  if (result.ok) assert.fail("a REGRESSION must be refused");
  assert.equal(result.ok, false);
  assert.equal(result.refused, true);
  assert.match(result.reason, /^evaluation REGRESSION:/);
  assert.ok(result.reason.includes("candidate broke a required rule"), result.reason);
  assert.equal(stageCalls.length, 0);
});

test("an INCONCLUSIVE evaluation cannot enter staging", () => {
  const { learning, stageCalls } = gate({ taskSet: null });

  const result = learning.submitProposal(candidate(), CAND_MD);
  if (result.ok) assert.fail("an INCONCLUSIVE evaluation must be refused");
  assert.equal(result.ok, false);
  assert.match(result.reason, /^evaluation INCONCLUSIVE:/);
  assert.equal(stageCalls.length, 0);
});

test("an ERROR evaluation cannot enter staging", () => {
  const set = taskSet([
    task("explodes", () => {
      throw new Error("runner unavailable");
    }),
    task("stable", () => holds(false)),
  ]);
  const { learning, stageCalls } = gate({ taskSet: set });

  const result = learning.submitProposal(candidate(), CAND_MD);
  if (result.ok) assert.fail("an ERROR evaluation must be refused");
  assert.equal(result.ok, false);
  assert.match(result.reason, /^evaluation ERROR:/);
  assert.ok(result.reason.includes("runner unavailable"), result.reason);
  assert.equal(stageCalls.length, 0);
});

test("a PASS candidate reaches the existing stage port exactly once", () => {
  const { learning, stageCalls } = gate({ taskSet: alwaysHoldingSet() });

  const result = learning.submitProposal(candidate(), CAND_MD);
  if (!result.ok) assert.fail(`a PASS candidate must stage, refused with: ${result.reason}`);
  assert.equal(result.ok, true);
  assert.equal(result.stagedId, "skill-gate-test");
  assert.equal(stageCalls.length, 1);
  assert.deepEqual(stageCalls[0], { id: "skill-gate-test", markdown: CAND_MD });
});

test("a candidate whose bytes changed after evaluation is refused and not staged", () => {
  const bytesA = "# Skill\n\nevaluated revision\n";
  const bytesB = "# Skill\n\ndifferent bytes entirely\n";
  assert.notEqual(bytesA, bytesB);
  const { learning, stageCalls } = gate({ taskSet: alwaysHoldingSet(), reportFor: bytesA });

  const result = learning.submitProposal(candidate(), bytesB);
  if (result.ok) assert.fail("a report for other bytes must be refused");
  assert.equal(result.ok, false);
  assert.match(result.reason, /does not cover these candidate bytes/);
  assert.equal(stageCalls.length, 0);
});

test("an evaluator that throws is refused and no stage call occurs", () => {
  const { learning, stageCalls } = gate({ taskSet: alwaysHoldingSet(), evaluatorThrows: true });

  const result = learning.submitProposal(candidate(), CAND_MD);
  if (result.ok) assert.fail("a throwing evaluator must be refused");
  assert.equal(result.ok, false);
  assert.match(result.reason, /^evaluation error: evaluator exploded$/);
  assert.equal(stageCalls.length, 0);
});

test("a stage port that refuses still refuses, even on a PASS verdict", () => {
  const { learning, stageCalls } = gate({
    taskSet: alwaysHoldingSet(),
    stageCheck: () => ({ ok: false, reason: "storage denied" }),
  });

  const result = learning.submitProposal(candidate(), CAND_MD);
  if (result.ok) assert.fail("a refusing stage port must not report success");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "storage denied");
  assert.equal(stageCalls.length, 1, "the port was consulted exactly once");
});
