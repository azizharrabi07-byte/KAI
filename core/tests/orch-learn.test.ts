// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Skill learning-loop tests. Run from `core/`:  node --test tests/orch-learn.test.ts
 *
 * Pins the proposal triggers (success / correction / recovery patterns and the
 * no-proposal cases), the validate-then-stage submit path, the metrics math,
 * and the no-throw guarantee for unknown skill ids.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createLearning } from "../src/orchestration/learn.ts";
import { evaluatingDeps } from "./learn-eval-fixture.ts";
import type { ProposeInput, StageInput } from "../src/orchestration/learn.ts";
import type { SkillMetricsRecord, SkillMetricsStore } from "../src/shared/contracts.ts";

function metricsStore(): SkillMetricsStore & { rows: Map<string, SkillMetricsRecord> } {
  const rows = new Map<string, SkillMetricsRecord>();
  return {
    rows,
    upsert: (m) => { rows.set(m.skillId, { ...m }); },
    get: (id) => rows.get(id) ?? null,
    list: () => [...rows.values()],
  };
}

function harness(opts: { valid?: boolean; staged?: boolean } = {}) {
  const metrics = metricsStore();
  const validated: string[] = [];
  const staged: StageInput[] = [];
  const learning = createLearning({
    metrics,
    validate: (markdown) => {
      validated.push(markdown);
      return opts.valid === false ? { ok: false, reason: "bad markdown" } : { ok: true };
    },
    stage: (input) => {
      staged.push(input);
      return opts.staged === false ? { ok: false, reason: "storage denied" } : { ok: true };
    },
    ...evaluatingDeps(),
  });
  return { metrics, validated, staged, learning };
}

function base(over: Partial<ProposeInput> = {}): ProposeInput {
  return {
    taskId: "task_1",
    objective: "Migrate the settings screen to the new form components",
    steps: [
      { label: "Survey the settings screen", status: "completed" },
      { label: "Swap in new form components", status: "completed" },
      { label: "Run the settings test suite", status: "completed" },
    ],
    outcome: { success: true, verified: true, corrections: [] },
    existingSkillIds: [],
    ...over,
  };
}

test("success pattern: multi-step verified success with no corrections proposes", () => {
  const { learning } = harness();
  const candidate = learning.proposeFromTask(base());
  assert.ok(candidate);
  assert.equal(candidate.pattern, "success");
  assert.ok(candidate.title.length > 0);
  assert.ok(candidate.method.includes("Swap in new form components"));
  assert.equal(candidate.sourceTaskId, "task_1");
});

test("correction pattern: a clear before/after correction proposes", () => {
  const { learning } = harness();
  const candidate = learning.proposeFromTask(
    base({
      steps: [
        { label: "Draft the migration", status: "completed" },
        { label: "Fix imports per review", status: "completed" },
      ],
      outcome: {
        success: true,
        verified: false,
        corrections: [{ before: "default import", after: "named import" }],
      },
    }),
  );
  assert.ok(candidate);
  assert.equal(candidate.pattern, "correction");
  assert.ok(candidate.constraints.some((c) => c.includes("default import")));
});

test("recovery pattern: failure then success proposes", () => {
  const { learning } = harness();
  const candidate = learning.proposeFromTask(
    base({
      steps: [
        { label: "Try direct migration", status: "failed" },
        { label: "Migrate file by file", status: "completed" },
      ],
      outcome: { success: true, verified: false, corrections: [], recovered: true },
    }),
  );
  assert.ok(candidate);
  assert.equal(candidate.pattern, "recovery");
});

test("recovery is also detected from step statuses without the flag", () => {
  const { learning } = harness();
  const candidate = learning.proposeFromTask(
    base({
      steps: [
        { label: "Try direct migration", status: "failed" },
        { label: "Migrate file by file", status: "completed" },
      ],
      outcome: { success: true, verified: false, corrections: [] },
    }),
  );
  assert.ok(candidate);
  assert.equal(candidate.pattern, "recovery");
});

test("no proposal: failed outright, too few steps, or thin unverified success", () => {
  const { learning } = harness();
  assert.equal(
    learning.proposeFromTask(base({ outcome: { success: false, verified: false, corrections: [] } })),
    null,
    "failed outright must never propose",
  );
  assert.equal(
    learning.proposeFromTask(
      base({ steps: [{ label: "Only step", status: "completed" }] }),
    ),
    null,
    "steps < 2 must never propose",
  );
  assert.equal(
    learning.proposeFromTask(
      base({
        steps: [
          { label: "One", status: "completed" },
          { label: "Two", status: "completed" },
        ],
        outcome: { success: true, verified: false, corrections: [] },
      }),
    ),
    null,
    "unverified 2-step success with no corrections and no recovery proposes nothing",
  );
  assert.equal(
    learning.proposeFromTask(
      base({
        outcome: {
          success: true,
          verified: false,
          corrections: [{ before: "", after: "something" }],
        },
      }),
    ),
    null,
    "a correction without a clear before/after is not correction-driven",
  );
});

test("submitProposal validates then stages the draft", () => {
  const { validated, staged, learning } = harness();
  const candidate = learning.proposeFromTask(base());
  assert.ok(candidate);
  const markdown = "# Skill\n\nDo the migration this way.";
  const result = learning.submitProposal(candidate, markdown);
  assert.equal(result.ok, true);
  assert.deepEqual(validated, [markdown], "validate receives the draft markdown");
  assert.equal(staged.length, 1);
  assert.equal(staged[0]?.markdown, markdown, "stage receives the draft markdown");
  assert.ok((staged[0]?.id ?? "").length > 0);
  if (result.ok) assert.equal(result.stagedId, staged[0]?.id);
});

test("submitProposal refuses when validation or staging fails, without staging on bad drafts", () => {
  const bad = harness({ valid: false });
  const candidate = bad.learning.proposeFromTask(base());
  assert.ok(candidate);
  const refused = bad.learning.submitProposal(candidate, "not a skill");
  assert.equal(refused.ok, false);
  assert.equal(bad.staged.length, 0, "a refused draft must never reach staging");

  const denied = harness({ staged: false });
  const candidate2 = denied.learning.proposeFromTask(base());
  assert.ok(candidate2);
  const refused2 = denied.learning.submitProposal(candidate2, "# Skill\n\nok");
  assert.equal(refused2.ok, false);
  if (!refused2.ok) assert.ok(refused2.reason.length > 0);
});

test("recordSkillUsage accumulates metrics math across calls", () => {
  const { metrics, learning } = harness();
  learning.recordSkillUsage("forms-migration", { success: true, verified: true, tokens: 120 });
  learning.recordSkillUsage("forms-migration", { success: false, failed: true, corrected: true, tokens: 80 });
  const row = metrics.get("forms-migration");
  assert.ok(row);
  assert.equal(row.triggers, 2);
  assert.equal(row.successes, 1);
  assert.equal(row.verifications, 1);
  assert.equal(row.failures, 1);
  assert.equal(row.corrections, 1);
  assert.equal(row.tokensUsed, 200);
});

test("recordSkillUsage does not throw on an unknown skill id", () => {
  const { metrics, learning } = harness();
  assert.doesNotThrow(() => learning.recordSkillUsage("never-seen", { success: true, tokens: 10 }));
  const row = metrics.get("never-seen");
  assert.ok(row);
  assert.equal(row.triggers, 1);
  assert.equal(row.successes, 1);
});

test("versionNote references the base skill id", () => {
  const { learning } = harness();
  const note = learning.versionNote("forms-migration", "Prefer named imports in the method.");
  assert.ok(note.includes("forms-migration"));
  assert.ok(note.includes("baseSkillId"));
  assert.ok(note.includes("Prefer named imports"));
});
