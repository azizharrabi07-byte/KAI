// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The critic panel: the six lenses as EXECUTION, not as a table.
 *
 * The defects these pin are the ones the previous phase could not prove:
 *   - six roles must be six INDEPENDENT reviews, never one response relabelled;
 *   - a lens that did not run must never be read as approval;
 *   - a bounded run must actually stop, and a cancelled run must say so;
 *   - one blocking objection must outvote a 5-to-1 majority.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  createCriticPanel,
  criticPromptFor,
  criticRoleRunner,
  findingsOf,
  type CriticReviewer,
  type PanelRunInput,
} from "../src/goals/criticPanel.ts";
import {
  CRITIC_ROLES,
  normalizeFinding,
  selectCriticRoles,
  synthesizeFindings,
  type ChallengeFinding,
  type RoleInput,
} from "../src/goals/challenger.ts";
import { buildCriticPrompt } from "../src/goals/runners.ts";
import { ModelError } from "../src/model/types.ts";

function passing(role: string): ChallengeFinding {
  return normalizeFinding(role, { verdict: "PASS", objections: [], notes: "looks fine" });
}

function blocking(role: string): ChallengeFinding {
  return normalizeFinding(role, {
    verdict: "PASS",
    objections: [
      {
        statement: "the plan writes outside the authorized workspace",
        severity: "critical",
        blocking: true,
        evidence: ["plan content line 3"],
        assumptions: [],
        remediation: "restrict every task to the authorized workspace",
        verification: "the compiled plan's workingDir is inside it",
      },
    ],
  });
}

/** A reviewer that records every prompt it is handed. */
function recordingReviewer(opts: { id?: string; kind?: "sequential" | "subagent"; answer?: (input: RoleInput) => ChallengeFinding } = {}) {
  const seen: { role: string; prompt: string; at: number }[] = [];
  let live = 0;
  let maxLive = 0;
  const reviewer: CriticReviewer = {
    id: opts.id ?? "rec",
    kind: opts.kind ?? "sequential",
    async review(input) {
      live += 1;
      maxLive = Math.max(maxLive, live);
      seen.push({ role: input.role, prompt: criticPromptFor(input), at: live });
      await new Promise((resolve) => setImmediate(resolve));
      live -= 1;
      return { finding: opts.answer?.(input) ?? passing(input.role), source: "model" };
    },
  };
  return { reviewer, seen, concurrency: () => maxLive };
}

function panelInput(roles = selectCriticRoles("DEEP")): PanelRunInput {
  return {
    roles,
    goal: "produce out.txt",
    content: "write out.txt into the workspace",
    contract: { acceptanceCriteria: ["file present: out.txt"], constraints: ["stay in the workspace"], forbiddenOutcomes: [] },
    goalRevisionId: "rev_1",
    round: 1,
    mode: "DEEP",
  };
}

test("six roles are six INDEPENDENT calls with six distinct prompts", async (t) => {
  const { reviewer, seen } = recordingReviewer();
  const panel = createCriticPanel({ reviewers: [reviewer] });
  const outcome = await panel.run(panelInput());

  assert.equal(outcome.results.length, 6, "every lens is reported");
  assert.equal(seen.length, 6, "one call per role — never one response relabelled six times");
  const prompts = new Set(seen.map((s) => s.prompt));
  assert.equal(prompts.size, 6, "each role receives a DIFFERENT prompt");
  assert.deepEqual(seen.map((s) => s.role), CRITIC_ROLES.map((r) => r.role), "in role order");
  assert.equal(outcome.counts.ok, 6);
  assert.equal(outcome.incomplete, false);
  assert.equal(outcome.mechanism, "sequential");
  t.diagnostic(outcome.summary);
});

test("ISOLATION: a role's input never carries another role's findings", async (t) => {
  const smuggled: string[] = [];
  const reviewer: CriticReviewer = {
    id: "probe",
    kind: "sequential",
    async review(input) {
      const keys = Object.keys(input as unknown as Record<string, unknown>);
      for (const key of ["findings", "peers", "otherFindings", "previousFindings"]) {
        if (keys.includes(key)) smuggled.push(`${input.role}:${key}`);
      }
      return { finding: passing(input.role), source: "model" };
    },
  };
  const panel = createCriticPanel({ reviewers: [reviewer] });
  await panel.run(panelInput());
  assert.deepEqual(smuggled, [], "no reviewer ever sees a peer's finding");

  // And a caller that TRIES to smuggle one is refused rather than trusted.
  const outcome = await panel.runRole({
    role: "security",
    rubric: "x",
    mode: "DEEP",
    round: 1,
    goalRevisionId: "rev_1",
    goal: "g",
    content: "c",
    contract: { acceptanceCriteria: [], constraints: [], forbiddenOutcomes: [] },
    ...({ findings: [passing("feasibility")] } as unknown as Record<string, never>),
  });
  assert.equal(outcome.status, "FAILED");
  assert.match(outcome.reason, /would break reviewer isolation/);
  assert.equal(outcome.finding, undefined, "a refused review produces no finding");
  t.diagnostic(outcome.reason);
});

test("ONE BLOCKING OBJECTION outvotes a 5-to-1 majority", async (t) => {
  const { reviewer } = recordingReviewer({
    answer: (input) => (input.role === "security" ? blocking(input.role) : passing(input.role)),
  });
  const panel = createCriticPanel({ reviewers: [reviewer] });
  const outcome = await panel.run(panelInput());
  const findings = findingsOf(outcome);
  assert.equal(findings.length, 6);

  const synthesis = synthesizeFindings(findings, "DEEP");
  assert.equal(synthesis.counts.pass, 6, "every lens said PASS on its own verdict field");
  assert.equal(synthesis.verdict, "BLOCKED", "the blocking objection decides, not the count");
  assert.ok(synthesis.criticalRisks.some((r) => /security/.test(r)));
  t.diagnostic(synthesis.summary);
});

test("UNAVAILABLE: no reviewer means no challenge, and NEVER a PASS", async (t) => {
  const panel = createCriticPanel({ reviewers: [] });
  const availability = panel.availability();
  assert.equal(availability.ok, false);
  assert.equal(availability.kind, "unavailable");
  assert.match(availability.reason, /no critic reviewer is configured/);

  const outcome = await panel.run(panelInput());
  assert.equal(outcome.counts.unavailable, 6, "every lens is reported unavailable");
  assert.equal(outcome.counts.ok, 0);
  assert.equal(outcome.mechanism, "unavailable");
  assert.equal(outcome.incomplete, true);
  assert.deepEqual(findingsOf(outcome), [], "no findings were produced");
  // And the challenger's own rule makes that BLOCKED, not PASS.
  assert.equal(synthesizeFindings([], "DEEP").verdict, "BLOCKED");
  assert.match(outcome.summary, /INCOMPLETE/);
  t.diagnostic(outcome.summary);
});

test("a provider FAILURE is classified, and produces no finding", async (t) => {
  const failing: CriticReviewer = {
    id: "flaky",
    kind: "sequential",
    async review(input) {
      if (input.role === "cost-alternatives") {
        // The REAL typed provider error, carrying the REAL 429 body observed in
        // a live run — a lookalike object would test the classifier's shape
        // matching rather than its behaviour.
        throw new ModelError("http", "provider returned 429", {
          provider: "openai-compatible",
          status: 429,
          detail: '{"error":{"type":"GoUsageLimitError","limitName":"monthly"}}',
        });
      }
      return { finding: passing(input.role), source: "model" };
    },
  };
  const panel = createCriticPanel({ reviewers: [failing] });
  const outcome = await panel.run(panelInput());

  assert.equal(outcome.counts.ok, 5);
  assert.equal(outcome.counts.failed, 1);
  assert.equal(outcome.incomplete, true);
  const failed = outcome.results.find((r) => r.role === "cost-alternatives");
  assert.equal(failed?.status, "FAILED");
  assert.equal(failed?.finding, undefined, "a failed lens never carries a finding");
  assert.match(String(failed?.reason), /quota-exhausted/, "the reason distinguishes a spent allowance");
  t.diagnostic(String(failed?.reason));
});

test("a role that overruns its BUDGET is failed, not waited on forever", async (t) => {
  const hanging: CriticReviewer = {
    id: "hang",
    kind: "sequential",
    review(input) {
      if (input.role === "security") {
        // Deliberately never settles: the panel's own bound must end it.
        const { promise } = Promise.withResolvers<{ finding: ChallengeFinding; source: "model" }>();
        return promise;
      }
      return Promise.resolve({ finding: passing(input.role), source: "model" as const });
    },
  };
  const panel = createCriticPanel({ reviewers: [hanging] });
  const started = Date.now();
  const outcome = await panel.run({ ...panelInput(), timeoutMsPerRole: 60 });
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 3000, `the bound actually stopped it (${elapsed}ms)`);
  const timedOut = outcome.results.find((r) => r.role === "security");
  assert.equal(timedOut?.status, "FAILED");
  assert.match(String(timedOut?.reason), /exceeded its 60ms budget/);
  assert.equal(outcome.counts.ok, 5, "the other lenses still ran");
  t.diagnostic(`bounded in ${elapsed}ms`);
});

test("CANCELLATION reports every remaining role, and never drops one silently", async (t) => {
  const controller = new AbortController();
  const reviewer: CriticReviewer = {
    id: "cancel-probe",
    kind: "sequential",
    async review(input) {
      if (input.role === "failure-analysis") controller.abort();
      return { finding: passing(input.role), source: "model" };
    },
  };
  const panel = createCriticPanel({ reviewers: [reviewer] });
  const outcome = await panel.run({ ...panelInput(), signal: controller.signal });

  assert.equal(outcome.cancelled, true);
  assert.equal(outcome.results.length, 6, "every role is still reported");
  assert.ok(outcome.counts.cancelled >= 1, `some roles were cancelled: ${outcome.summary}`);
  assert.equal(outcome.counts.ok + outcome.counts.cancelled + outcome.counts.failed + outcome.counts.unavailable, 6);
  for (const result of outcome.results.filter((r) => r.status === "CANCELLED")) {
    assert.equal(result.finding, undefined, "a cancelled lens produces no finding");
    assert.match(result.reason, /cancel/i);
  }
  t.diagnostic(outcome.summary);
});

test("an already-cancelled panel runs nothing and says so", async (t) => {
  const controller = new AbortController();
  controller.abort();
  const { reviewer, seen } = recordingReviewer();
  const panel = createCriticPanel({ reviewers: [reviewer] });
  const outcome = await panel.run({ ...panelInput(), signal: controller.signal });
  assert.equal(seen.length, 0, "no reviewer was called");
  assert.equal(outcome.counts.cancelled, 6);
  assert.equal(outcome.mechanism, "sequential", "the mechanism is still reported honestly");
});

test("provenance records the reviewer, the mechanism and the EXACT prompt hash", async (t) => {
  const { reviewer } = recordingReviewer({ id: "kai:model-critic", kind: "subagent" });
  const panel = createCriticPanel({ reviewers: [reviewer] });
  const outcome = await panel.run(panelInput());
  const first = outcome.results[0];
  assert.equal(first?.provenance.reviewer, "kai:model-critic");
  assert.equal(first?.provenance.kind, "subagent");
  assert.equal(first?.provenance.isolated, true);
  assert.equal(first?.provenance.round, 1);
  assert.equal(first?.provenance.goalRevisionId, "rev_1");
  assert.equal(first?.provenance.source, "model");
  assert.ok((first?.provenance.durationMs ?? -1) >= 0);
  assert.match(String(first?.provenance.promptSha256), /^[0-9a-f]{64}$/);
  assert.equal(outcome.mechanism, "subagent", "a subagent reviewer is reported as such");

  // The hash is of the prompt the reviewer ACTUALLY saw, so it can be recomputed
  // from the same inputs and must match.
  const roles = selectCriticRoles("DEEP");
  const recomputed = criticPromptFor({
    role: roles[0]!.role,
    rubric: roles[0]!.rubric,
    mode: "DEEP",
    round: 1,
    goalRevisionId: "rev_1",
    goal: "produce out.txt",
    content: "write out.txt into the workspace",
    contract: { acceptanceCriteria: ["file present: out.txt"], constraints: ["stay in the workspace"], forbiddenOutcomes: [] },
  });
  assert.equal(recomputed, buildCriticPrompt({
    role: roles[0]!.role,
    rubric: roles[0]!.rubric,
    mode: "DEEP",
    round: 1,
    goalRevisionId: "rev_1",
    goal: "produce out.txt",
    content: "write out.txt into the workspace",
    contract: { acceptanceCriteria: ["file present: out.txt"], constraints: ["stay in the workspace"], forbiddenOutcomes: [] },
  }), "there is ONE prompt builder");
  const digest = createHash("sha256").update(recomputed, "utf8").digest("hex");
  assert.equal(first?.provenance.promptSha256, digest, "the provenance hash matches the prompt that ran");
  t.diagnostic(`prompt ${String(first?.provenance.promptSha256).slice(0, 12)}…`);
});

test("a distinct reviewer is preferred for each role when the panel has several", async (t) => {
  const a = recordingReviewer({ id: "rev-a" });
  const b = recordingReviewer({ id: "rev-b" });
  const c = recordingReviewer({ id: "rev-c" });
  const panel = createCriticPanel({ reviewers: [a.reviewer, b.reviewer, c.reviewer] });
  const outcome = await panel.run(panelInput());
  const used = new Set(outcome.results.map((r) => r.provenance.reviewer));
  assert.equal(used.size, 3, "all three reviewers were used before any was reused");
  assert.equal(outcome.counts.ok, 6, "and every lens still ran exactly once");
  assert.equal(a.seen.length + b.seen.length + c.seen.length, 6);
  t.diagnostic(`reviewers used: ${[...used].join(", ")}`);
});

test("the challenger's RoleRunner is SERIALISED, and one failure does not cancel the rest", async (t) => {
  let live = 0;
  let maxLive = 0;
  const seen: string[] = [];
  const serial: CriticReviewer = {
    id: "serial",
    kind: "sequential",
    async review(input) {
      live += 1;
      maxLive = Math.max(maxLive, live);
      try {
        seen.push(input.role);
        await new Promise((resolve) => setImmediate(resolve));
        if (input.role === "user-value") throw new Error("provider exploded");
        return { finding: passing(input.role), source: "model" as const };
      } finally {
        live -= 1;
      }
    },
  };
  const panel = createCriticPanel({ reviewers: [serial] });
  const results: string[] = [];
  const runRole = criticRoleRunner(panel, { onResult: (r) => results.push(`${r.role}:${r.status}`) });

  // The challenger fires all six CONCURRENTLY; the adapter must serialise them.
  const settled = await Promise.allSettled(
    selectCriticRoles("DEEP").map((role) =>
      runRole({ role: role.role, rubric: role.rubric, mode: "DEEP", round: 1, goalRevisionId: "rev_1", goal: "g", content: "c", contract: { acceptanceCriteria: [], constraints: [], forbiddenOutcomes: [] } }),
    ),
  );
  const fulfilled = settled.filter((s) => s.status === "fulfilled").length;
  const rejected = settled.filter((s) => s.status === "rejected").length;
  assert.equal(fulfilled, 5, "five lenses returned findings");
  assert.equal(rejected, 1, "the failing lens rejected, so the challenger blocks on it");
  assert.equal(maxLive, 1, "the fallback ran ONE role at a time");
  assert.equal(seen.length, 6, "every role was attempted");
  assert.equal(results.length, 6, "provenance was recorded for the failure too");
  assert.ok(results.includes("user-value:FAILED"));
  t.diagnostic(results.join(", "));
});

test("QUICK runs a bounded subset, DEEP runs all six", async (t) => {
  const quick = recordingReviewer({ id: "q" });
  const quickPanel = createCriticPanel({ reviewers: [quick.reviewer] });
  await quickPanel.run(panelInput(selectCriticRoles("QUICK")));
  assert.equal(quick.seen.length, 3, "QUICK pays for three lenses");
  assert.deepEqual(quick.seen.map((s) => s.role), ["feasibility", "failure-analysis", "user-value"]);
  t.diagnostic("QUICK = 3 lenses, DEEP = 6");
});
