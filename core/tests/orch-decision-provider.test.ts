// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * JEV is OPTIONAL. KAI is fully functional with it disabled, unavailable,
 * throwing, malformed, or recommending something illegal — and a provider can
 * never bypass Guard, the Outcome Gate, authority or budgets.
 *
 *   cd core && node --test tests/orch-decision-provider.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  createDeterministicDecisionProvider,
  createUnavailableJevProvider,
  decideAction,
  DEFAULT_JEV_BUDGET,
  shouldConsultProvider,
  type DecisionContext,
  type DecisionProvider,
} from "../src/orchestration/decision.ts";
import type { KernelInput } from "../src/orchestration/outcome.ts";

function kernelInput(over: Partial<KernelInput> = {}): KernelInput {
  return {
    gate: "INSUFFICIENT_EVIDENCE",
    unmetCriteria: ["tests pass"],
    noProgressStreak: 0,
    sameFailureStreak: 0,
    sameWorkerFailures: 0,
    limits: { maxNoProgress: 3, maxSameFailure: 2, maxWorkerFailures: 3, maxDepth: 3 },
    alternativeWorkerAvailable: true,
    depth: 0,
    ...over,
  };
}

const ON = { ...DEFAULT_JEV_BUDGET, enabled: true };

test("1+2: default is deterministic — no provider needed to decide", async () => {
  const out = await decideAction(kernelInput());
  assert.equal(out.providerId, "deterministic");
  assert.equal(out.usedProvider, false);
  assert.equal(out.action, "RUN_TESTS");
});

test("3: an unavailable JEV provider yields the deterministic action", async () => {
  const out = await decideAction(kernelInput(), { provider: createUnavailableJevProvider(), budget: ON, candidates: ["RUN_TESTS", "VERIFY"] });
  assert.equal(out.usedProvider, false);
  assert.equal(out.action, "RUN_TESTS");
});

test("4: a provider that throws is boring — deterministic fallback, no crash", async () => {
  const throwing: DecisionProvider = { id: "jev", async choose() { throw new Error("jev down"); } };
  const out = await decideAction(kernelInput(), { provider: throwing, budget: ON, candidates: ["RUN_TESTS", "VERIFY"] });
  assert.equal(out.usedProvider, false);
  assert.equal(out.action, "RUN_TESTS");
});

test("5: a provider may only rank among LEGAL candidates; illegal is rejected", async () => {
  const rogue: DecisionProvider = { id: "jev", async choose() { return { action: "COMPLETE", confidence: 0.99, reasonCode: "looks_done" }; } };
  const out = await decideAction(kernelInput(), { provider: rogue, budget: ON, candidates: ["RUN_TESTS", "VERIFY"] });
  assert.equal(out.usedProvider, false, "an illegal recommendation is not used");
  assert.ok(out.rejectedProvider !== undefined);
  assert.equal(out.action, "RUN_TESTS");
});

test("6: a provider can NEVER recommend COMPLETE to bypass the Outcome Gate", async () => {
  const rogue: DecisionProvider = { id: "jev", async choose() { return { action: "COMPLETE", confidence: 1, reasonCode: "trust_me" }; } };
  // COMPLETE is not in the corrective candidates, and the hard-rule filter also rejects it.
  const out = await decideAction(kernelInput({ gate: "FAIL" }), { provider: rogue, budget: ON, candidates: ["RETRY", "REPLAN"] });
  assert.notEqual(out.action, "COMPLETE");
});

test("7: a legal, confident recommendation is used and recorded", async () => {
  const helper: DecisionProvider = { id: "jev", async choose() { return { action: "VERIFY", confidence: 0.8, reasonCode: "evidence_more_valuable" }; } };
  const used: string[] = [];
  const out = await decideAction(kernelInput(), {
    provider: helper,
    budget: ON,
    candidates: ["RUN_TESTS", "VERIFY"],
    onProviderUsed: (e) => used.push(e.decision),
  });
  assert.equal(out.usedProvider, true);
  assert.equal(out.action, "VERIFY");
  assert.deepEqual(used, ["VERIFY"]);
});

test("8: low confidence is rejected → deterministic", async () => {
  const timid: DecisionProvider = { id: "jev", async choose() { return { action: "VERIFY", confidence: 0.1, reasonCode: "unsure" }; } };
  const out = await decideAction(kernelInput(), { provider: timid, budget: ON, candidates: ["RUN_TESTS", "VERIFY"] });
  assert.equal(out.usedProvider, false);
  assert.equal(out.action, "RUN_TESTS");
});

test("9: budget exhausted → deterministic, mission not failed", async () => {
  const helper: DecisionProvider = { id: "jev", async choose() { return { action: "VERIFY", confidence: 0.9, reasonCode: "x" }; } };
  const out = await decideAction(kernelInput(), { provider: helper, budget: { ...ON, maxCallsPerMission: 2 }, candidates: ["RUN_TESTS", "VERIFY"], callsUsed: 2 });
  assert.equal(out.usedProvider, false);
  assert.equal(out.action, "RUN_TESTS");
});

test("10: hard/obvious decisions never escalate (deny, pass, loop breaker, depth, single candidate)", () => {
  const ctx = (over: Partial<DecisionContext>): DecisionContext => ({
    gate: "INSUFFICIENT_EVIDENCE", unmetCriteria: [], candidates: ["RUN_TESTS", "VERIFY"], deterministicAction: "RUN_TESTS",
    noProgressStreak: 0, sameFailureStreak: 0, sameWorkerFailures: 0, depth: 0, ...over,
  });
  assert.equal(shouldConsultProvider(ctx({ gate: "CONTRADICTED" }), ON), false, "deny/forbidden is deterministic");
  assert.equal(shouldConsultProvider(ctx({ gate: "PASS" }), ON), false, "completion is the Gate's call");
  assert.equal(shouldConsultProvider(ctx({ candidates: ["RETRY"] }), ON), false, "nothing to choose");
  assert.equal(shouldConsultProvider(ctx({ sameFailureStreak: 2 }), ON), false, "loop breaker is deterministic");
  assert.equal(shouldConsultProvider(ctx({ depth: 3 }), ON), false, "bounded depth");
  assert.equal(shouldConsultProvider(ctx({}), { ...ON, enabled: false }), false, "disabled");
  assert.equal(shouldConsultProvider(ctx({}), ON), true, "genuinely ambiguous → worth consulting");
});

test("deterministic provider mirrors the kernel exactly", async () => {
  const p = createDeterministicDecisionProvider();
  const rec = await p.choose({
    gate: "FAIL", unmetCriteria: [], candidates: ["RETRY"], deterministicAction: "RETRY",
    noProgressStreak: 0, sameFailureStreak: 0, sameWorkerFailures: 0, depth: 0,
  });
  assert.equal(rec?.action, "RETRY");
  assert.equal(rec?.confidence, 1);
});
