// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

// Outcome Contract + Gate + Decision Kernel — the "never falsely complete"
// guarantees. Scenarios mirror OpenBot's anti-loop / deny / escalation ideas
// (github.com/ashhart/OpenBot, MIT), reimplemented for KAI.
//
//   cd core && node --test tests/orch-outcome.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import {
  actionSignature,
  createOutcomeContract,
  decideNext,
  evaluateOutcome,
  type Observation,
} from "../src/orchestration/outcome.ts";

const CONTRACT = createOutcomeContract({
  missionId: "m1",
  intent: "Fix the polling bug and prove it",
  deliverables: ["patched poller", "passing regression test"],
  acceptanceCriteria: ["tests pass", "no unrelated files changed"],
  requiredEvidence: ["test output"],
  forbiddenOutcomes: ["force-push"],
});

function obs(over: Partial<Observation> = {}): Observation {
  return {
    deliverable: "patched poller; tests pass; only poller.ts changed",
    evidence: ["tests: 18/18 passed", "diff: poller.ts only"],
    criteriaMet: { "tests pass": true, "no unrelated files changed": true },
    ...over,
  };
}

test("gate: a met deliverable with evidence PASSES", () => {
  const d = evaluateOutcome(CONTRACT, obs());
  assert.equal(d.result, "PASS", d.reason);
});

test("B: a worker claim is not enough — missing acceptance criterion never PASSES", () => {
  const d = evaluateOutcome(CONTRACT, obs({ criteriaMet: { "tests pass": true } }));
  assert.equal(d.result, "INSUFFICIENT_EVIDENCE");
  assert.ok(d.unmetCriteria.includes("no unrelated files changed"));
});

test("C: tests pass but required evidence is absent → INSUFFICIENT_EVIDENCE", () => {
  const d = evaluateOutcome(CONTRACT, obs({ evidence: [] }));
  assert.equal(d.result, "INSUFFICIENT_EVIDENCE");
  assert.deepEqual(d.missingEvidence, ["test output"]);
});

test("no deliverable → FAIL", () => {
  const d = evaluateOutcome(CONTRACT, obs({ deliverable: "" }));
  assert.equal(d.result, "FAIL");
});

test("K/deny: a forbidden outcome CONTRADICTS completion", () => {
  const d = evaluateOutcome(CONTRACT, obs({ deliverable: "did a force-push to fix it" }));
  assert.equal(d.result, "CONTRADICTED");
  assert.ok(d.violations.length > 0);
  const destructive = evaluateOutcome(CONTRACT, obs({ deliverable: "ran rm -rf / then patched" }));
  assert.equal(destructive.result, "CONTRADICTED");
});

test("unresolved blockers → FAIL (never PASS)", () => {
  const d = evaluateOutcome(CONTRACT, obs({ unresolvedBlockers: ["cannot reach the service"] }));
  assert.equal(d.result, "FAIL");
});

test("unknowable: no acceptance criteria → UNKNOWN (never PASS)", () => {
  const bare = createOutcomeContract({ missionId: "m2", intent: "do something", deliverables: [] });
  const d = evaluateOutcome(bare, obs({ criteriaMet: {} }));
  assert.notEqual(d.result, "PASS");
});

test("kernel: PASS → COMPLETE", () => {
  const k = decideNext(kernel({ gate: "PASS" }));
  assert.equal(k.action, "COMPLETE");
});

test("kernel: same failure ×N → CHANGE_WORKER when an alternative exists, else REPLAN", () => {
  assert.equal(decideNext(kernel({ gate: "INSUFFICIENT_EVIDENCE", sameFailureStreak: 2 })).action, "CHANGE_WORKER");
  assert.equal(decideNext(kernel({ gate: "INSUFFICIENT_EVIDENCE", sameFailureStreak: 2, alternativeWorkerAvailable: false })).action, "REPLAN");
});

test("D: worker fails repeatedly → change worker / replan, never endless retry", () => {
  assert.equal(decideNext(kernel({ gate: "FAIL", sameWorkerFailures: 3 })).action, "CHANGE_WORKER");
});

test("no progress ×N → REPLAN", () => {
  assert.equal(decideNext(kernel({ gate: "FAIL", noProgressStreak: 3 })).action, "REPLAN");
});

test("H: handoff depth ceiling → ASK_USER (hard bounded termination)", () => {
  assert.equal(decideNext(kernel({ gate: "FAIL", depth: 2 })).action, "ASK_USER");
});

test("kernel: evidence gap with test-like criteria → RUN_TESTS", () => {
  const k = decideNext(kernel({ gate: "INSUFFICIENT_EVIDENCE", unmetCriteria: ["tests pass"] }));
  assert.equal(k.action, "RUN_TESTS");
});

test("kernel: UNKNOWN → ASK_USER, CONTRADICTED → REPLAN", () => {
  assert.equal(decideNext(kernel({ gate: "UNKNOWN" })).action, "ASK_USER");
  assert.equal(decideNext(kernel({ gate: "CONTRADICTED" })).action, "REPLAN");
});

test("actionSignature is stable and distinguishes worker/input", () => {
  assert.equal(actionSignature("RETRY", "w1", "fix it"), actionSignature("RETRY", "w1", "Fix It"));
  assert.notEqual(actionSignature("RETRY", "w1", "x"), actionSignature("RETRY", "w2", "x"));
});

function kernel(over: Partial<Parameters<typeof decideNext>[0]> = {}) {
  return {
    gate: "FAIL" as const,
    unmetCriteria: [] as string[],
    noProgressStreak: 0,
    sameFailureStreak: 0,
    sameWorkerFailures: 0,
    limits: { maxNoProgress: 3, maxSameFailure: 2, maxWorkerFailures: 3, maxDepth: 2 },
    alternativeWorkerAvailable: true,
    depth: 0,
    ...over,
  };
}
