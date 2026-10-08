// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Reviewer loop tests.
 * Plain `node --test`, no dependencies, no network.
 * Run from `core/`:  node --test tests/orch-review.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildReviewerPrompt,
  requestReview,
  runReviewLoop,
  type ReviewDeps,
  type ReviewRequestInput,
  type ReviewRunnerResult,
} from "../src/orchestration/review.ts";

function baseInput(): ReviewRequestInput {
  return {
    contract: {
      objective: "Implement the worker prompt engine",
      deliverable: "src/orchestration/prompts.ts",
      criteria: ["tests green", "typecheck clean"],
    },
    artifact: "added buildWorkerPrompt with 13 sections",
    evidence: ["node --test green", "tsc --noEmit clean"],
  };
}

function stubDeps(
  verdicts: ReviewRunnerResult["verdict"][],
  seen: string[],
  findings: string[] = ["ok"],
): ReviewDeps {
  let calls = 0;
  return {
    buildPrompt: (input) => buildReviewerPrompt(input),
    runner: async (prompt: string) => {
      seen.push(prompt);
      const verdict = verdicts[Math.min(calls, verdicts.length - 1)] ?? "PASS";
      calls += 1;
      return { verdict, findings: [...findings] };
    },
  };
}

// ── Verdicts ──────────────────────────────────────────────────────────────────

test("PASS resolves the loop in one round", async () => {
  const seen: string[] = [];
  const deps = stubDeps(["PASS"], seen);
  const out = await runReviewLoop(deps, baseInput(), 2);
  assert.equal(out.verdict, "PASS");
  assert.equal(out.rounds, 1);
  assert.equal(seen.length, 1);
});

test("CHANGES_REQUESTED returns verdict + findings for the caller", async () => {
  const seen: string[] = [];
  const deps = stubDeps(["CHANGES_REQUESTED"], seen, ["missing evidence for criterion 2"]);
  const out = await requestReview(deps, baseInput());
  assert.equal(out.verdict, "CHANGES_REQUESTED");
  assert.deepEqual(out.findings, ["missing evidence for criterion 2"]);
});

test("BLOCKED stops immediately", async () => {
  const seen: string[] = [];
  const deps = stubDeps(["BLOCKED", "PASS"], seen, ["no access to repo"]);
  const out = await runReviewLoop(deps, baseInput(), 2);
  assert.equal(out.verdict, "BLOCKED");
  assert.equal(out.rounds, 1);
  assert.equal(seen.length, 1);
  assert.deepEqual(out.findings, ["no access to repo"]);
});

// ── Reviewer-input independence ───────────────────────────────────────────────

test("the reviewer never sees the implementer transcript (canary assert)", async () => {
  const CANARY = "CANARY-TRANSCRIPT-9f8e7d6c5b4a";
  const seen: string[] = [];
  const deps = stubDeps(["PASS"], seen);
  const input = {
    ...baseInput(),
    transcript: `full chat history ${CANARY} do not forward`,
    history: [CANARY],
  } as unknown as ReviewRequestInput;
  const out = await requestReview(deps, input);
  assert.equal(out.verdict, "PASS");
  assert.equal(seen.length, 1);
  const prompt = seen[0] ?? "";
  assert.ok(!prompt.includes(CANARY), `transcript leaked into reviewer prompt: ${prompt}`);
  // The contract content itself must still arrive.
  assert.ok(prompt.includes("Implement the worker prompt engine"));
  assert.ok(prompt.includes("added buildWorkerPrompt"));
});

test("reviewer prompt carries contract + artifact + evidence + criteria", async () => {
  const seen: string[] = [];
  const deps = stubDeps(["PASS"], seen);
  await requestReview(deps, baseInput());
  const prompt = seen[0] ?? "";
  assert.ok(prompt.includes("tests green"));
  assert.ok(prompt.includes("typecheck clean"));
  assert.ok(prompt.includes("node --test green"));
  assert.ok(prompt.includes("src/orchestration/prompts.ts"));
});

// ── Round bound ───────────────────────────────────────────────────────────────

test("maxRounds is honored when the reviewer keeps asking for changes", async () => {
  const seen: string[] = [];
  const deps = stubDeps(["CHANGES_REQUESTED", "CHANGES_REQUESTED", "PASS"], seen, [
    "still missing",
  ]);
  const out = await runReviewLoop(deps, baseInput(), 2);
  assert.equal(seen.length, 2);
  assert.equal(out.rounds, 2);
  assert.equal(out.verdict, "CHANGES_REQUESTED");
  assert.deepEqual(out.findings, ["still missing"]);
});

test("an early PASS stops before exhausting the budget", async () => {
  const seen: string[] = [];
  const deps = stubDeps(["CHANGES_REQUESTED", "PASS", "PASS"], seen);
  const out = await runReviewLoop(deps, baseInput(), 3);
  assert.equal(seen.length, 2);
  assert.equal(out.rounds, 2);
  assert.equal(out.verdict, "PASS");
});
