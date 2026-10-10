// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Goal Challenger tests.
 * Plain `node --test`, no dependencies, no network, NO live model: every critic
 * is a scripted injected runner.
 * Run from `core/`:  node --test --experimental-strip-types tests/goal-challenger.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  CRITIC_ROLES,
  DEFAULT_MAX_ROUNDS,
  HARD_MAX_ROUNDS,
  createGoalChallenger,
  normalizeFinding,
  revisionIdFor,
  selectCriticRoles,
  synthesizeFindings,
  type ChallengeFinding,
  type ChallengeInput,
  type ChallengeMode,
  type ChallengeObjection,
  type ChallengeVerdict,
  type GoalChallengeContract,
  type RoleInput,
  type RoleRunner,
} from "../src/goals/challenger.ts";

const FIXED = new Date("2026-01-01T00:00:00.000Z");
const QUICK_ROLES = ["feasibility", "failure-analysis", "user-value"];

function contract(): GoalChallengeContract {
  return {
    acceptanceCriteria: ["tests green", "typecheck clean"],
    constraints: ["no network in tests"],
    forbiddenOutcomes: ["touching prod data"],
    requiredEvidence: ["node --test output"],
  };
}

function baseInput(overrides: Partial<ChallengeInput> = {}): ChallengeInput {
  return {
    goalRevisionId: "goal-1",
    goal: "Ship the goal executive slice",
    contract: contract(),
    ...overrides,
  };
}

function passFinding(role: string): ChallengeFinding {
  return { role, verdict: "PASS", objections: [] };
}

function objection(overrides: Partial<ChallengeObjection> = {}): ChallengeObjection {
  return {
    id: "o-1",
    statement: "the goal is under-specified",
    severity: "medium",
    blocking: false,
    evidence: [],
    assumptions: [],
    remediation: "state the exact deliverable",
    verification: "the deliverable is named and testable",
    ...overrides,
  };
}

function findingWith(
  role: string,
  verdict: ChallengeVerdict,
  objections: ChallengeObjection[] = [],
  notes?: string,
): ChallengeFinding {
  return notes === undefined ? { role, verdict, objections } : { role, verdict, objections, notes };
}

/** A runner that answers per role, recording every role input (for independence asserts). */
function perRoleRunner(answers: (role: string, input: RoleInput) => ChallengeFinding, log?: RoleInput[]): RoleRunner {
  return async (input) => {
    log?.push(input);
    return answers(input.role, input);
  };
}

// ── Mode → role selection ─────────────────────────────────────────────────────

test("QUICK runs exactly feasibility + failure-analysis + user-value", () => {
  assert.deepEqual(
    selectCriticRoles("QUICK").map((r) => r.role),
    QUICK_ROLES,
  );
});

test("DEEP and CONTINUOUS run every critic lens", () => {
  assert.equal(selectCriticRoles("DEEP").length, CRITIC_ROLES.length);
  assert.equal(selectCriticRoles("CONTINUOUS").length, CRITIC_ROLES.length);
  assert.equal(CRITIC_ROLES.length, 6);
});

test("OFF selects no critics", () => {
  assert.deepEqual(selectCriticRoles("OFF"), []);
});

// ── Deterministic synthesis ───────────────────────────────────────────────────

test("conflicting findings are retained verbatim in conflicts[], never averaged away", () => {
  const findings = [
    passFinding("feasibility"),
    findingWith("failure-analysis", "REVISE", [objection()]),
    findingWith("user-value", "CONDITIONAL", []),
  ];
  const s = synthesizeFindings(findings, "QUICK");
  assert.equal(s.verdict, "REVISE");
  assert.equal(s.conflicts.length, 3);
  assert.ok(s.conflicts.some((c) => c === "failure-analysis: REVISE"));
  assert.ok(s.conflicts.some((c) => c === "feasibility: PASS"));
  assert.ok(s.conflicts.some((c) => c === "user-value: CONDITIONAL"));
});

test("disagreeing roles keep their notes verbatim in conflicts[]", () => {
  const s = synthesizeFindings([
    findingWith("feasibility", "PASS", [], "looks cheap"),
    findingWith("failure-analysis", "REVISE", [objection()], "no rollback"),
  ]);
  assert.ok(s.conflicts.includes("feasibility: PASS (looks cheap)"));
  assert.ok(s.conflicts.includes("failure-analysis: REVISE (no rollback)"));
});

test("a lone blocking objection beats a 5-vs-1 majority", () => {
  const findings: ChallengeFinding[] = [];
  for (let i = 0; i < 5; i += 1) findings.push(findingWith(`passer-${i}`, "PASS", []));
  findings.push(
    findingWith("security", "CONDITIONAL", [
      objection({ id: "sec-1", severity: "critical", blocking: true, statement: "goal exfiltrates keys" }),
    ]),
  );
  const s = synthesizeFindings(findings, "DEEP");
  assert.equal(s.verdict, "BLOCKED");
  // Counts are real, and they are NOT the verdict input.
  assert.equal(s.counts.pass, 5);
  assert.equal(s.counts.conditional, 1);
  assert.equal(s.counts.total, 6);
});

test("a BLOCKED finding is a hard stop even with no blocking objection", () => {
  const s = synthesizeFindings([findingWith("feasibility", "BLOCKED", [objection({ blocking: false })])]);
  assert.equal(s.verdict, "BLOCKED");
});

test("a non-PASS goal is never silently converted to PASS (5 PASS + 1 REVISE)", () => {
  const findings: ChallengeFinding[] = [];
  for (let i = 0; i < 5; i += 1) findings.push(findingWith(`passer-${i}`, "PASS", []));
  findings.push(findingWith("verification", "REVISE", [objection()]));
  const s = synthesizeFindings(findings);
  assert.equal(s.verdict, "REVISE");
  assert.equal(s.counts.pass, 5);
  assert.equal(s.counts.revise, 1);
  assert.notEqual(s.verdict, "PASS");
});

test("findings with no objections and no non-PASS signal pass", () => {
  const s = synthesizeFindings([passFinding("feasibility"), passFinding("user-value")]);
  assert.equal(s.verdict, "PASS");
  assert.deepEqual(s.conflicts, []);
  assert.equal(s.evaluated, true);
});

// ── Uncertainty is explicit, never invented ───────────────────────────────────

test("an objection with no remediation stays unresolved and yields no revision", () => {
  const findings = [
    findingWith("failure-analysis", "REVISE", [
      objection({ id: "u-1", statement: "unknown: does the export API exist?", remediation: "", verification: "" }),
    ]),
  ];
  const s = synthesizeFindings(findings, "QUICK");
  assert.equal(s.verdict, "REVISE");
  assert.equal(s.unresolved.length, 1);
  assert.ok(s.unresolved[0]?.includes("unknown: does the export API exist?"));
  // No fix is invented for an objection that stated none.
  assert.deepEqual(s.revisions, []);
  assert.deepEqual(findings[0]?.objections[0]?.evidence, []);
  assert.deepEqual(findings[0]?.objections[0]?.assumptions, []);
});

test("revisions are derived only from stated remediation; nothing is invented", () => {
  const s = synthesizeFindings([
    findingWith("verification", "REVISE", [
      objection({ id: "v-1", remediation: "add a failing-first test", verification: "test fails first", assumptions: ["suite runs"] }),
    ]),
  ]);
  assert.equal(s.revisions.length, 1);
  assert.equal(s.revisions[0]?.change, "add a failing-first test");
  assert.equal(s.revisions[0]?.falsifiableTest, "test fails first");
  assert.deepEqual(s.revisions[0]?.newAssumptions, ["suite runs"]);
  assert.deepEqual(s.revisions[0]?.tradeoffs, []);
  assert.deepEqual(s.revisions[0]?.newAcceptanceCriteria, []);
});

test("an unspecified severity records as the neutral middle, never low or critical", () => {
  const normalized = normalizeFinding("security", {
    verdict: "REVISE",
    objections: [{ statement: "shadowed credential", remediation: "rotate it" }],
  });
  assert.equal(normalized.objections[0]?.severity, "medium");
});

// ── Revision identity ─────────────────────────────────────────────────────────

test("revisionIdFor changes whenever the content changes", () => {
  const a = revisionIdFor("goal-1", "plan A");
  const b = revisionIdFor("goal-1", "plan B");
  const c = revisionIdFor("goal-1", "plan A");
  assert.notEqual(a, b);
  assert.equal(a, c);
});

test("re-critique binds findings to the NEW revision id and content", async () => {
  const log: RoleInput[] = [];
  const runner = perRoleRunner(
    (role, input) => (input.round === 1 ? findingWith(role, "REVISE", [objection()]) : passFinding(role)),
    log,
  );
  const out = await createGoalChallenger({ runRole: runner, mode: "QUICK", now: () => FIXED }).challenge(baseInput());

  assert.equal(out.rounds, 2);
  assert.equal(out.report.verdict, "PASS");
  assert.equal(out.history.length, 2);
  assert.equal(out.history[0]?.goalRevisionId, "goal-1");
  assert.notEqual(out.history[1]?.goalRevisionId, out.history[0]?.goalRevisionId);
  assert.ok(out.history[1]?.goalRevisionId.startsWith("rev-"));
  assert.notEqual(out.history[1]?.content, out.history[0]?.content);
  // Round 2 critics saw exactly the new revision identity.
  const round2 = log.filter((i) => i.round === 2);
  assert.equal(round2.length, QUICK_ROLES.length);
  assert.ok(round2.every((i) => i.goalRevisionId === out.history[1]?.goalRevisionId));
  assert.ok(round2.every((i) => i.content === out.history[1]?.content));
  assert.equal(out.goalRevisionId, out.report.goalRevisionId);
});

// ── Round budget ──────────────────────────────────────────────────────────────

test("the round limit is obeyed and a non-PASS goal is never forced to PASS", async () => {
  const log: RoleInput[] = [];
  const runner = perRoleRunner(
    (role) =>
      findingWith(role, "REVISE", [
        objection({ id: `${role}-fix`, remediation: "tighten the acceptance criterion" }),
        objection({ id: `${role}-unknown`, statement: "unknown: is there a latency budget?", remediation: "" }),
      ]),
    log,
  );
  const out = await createGoalChallenger({ runRole: runner, mode: "QUICK", maxRounds: 2, now: () => FIXED }).challenge(
    baseInput(),
  );

  assert.equal(out.rounds, 2);
  assert.equal(log.length, 2 * QUICK_ROLES.length);
  assert.equal(out.report.verdict, "REVISE");
  assert.notEqual(out.report.verdict, "PASS");
  // At the limit we hand back the unresolved objections AND the best remaining alternatives.
  assert.ok(out.unresolved.length > 0);
  assert.ok(out.bestAlternatives.length > 0);
  assert.ok(out.unresolved.some((u) => u.includes("is there a latency budget?")));
  assert.ok(out.recommendation.includes("do not dispatch"));
});

test("a caller-supplied budget is clamped to the hard cap", async () => {
  const log: RoleInput[] = [];
  const runner = perRoleRunner((role) => findingWith(role, "REVISE", [objection()]), log);
  const challenger = createGoalChallenger({ runRole: runner, mode: "QUICK", maxRounds: 100, now: () => FIXED });
  assert.equal(challenger.maxRounds, HARD_MAX_ROUNDS);

  const out = await challenger.challenge(baseInput());
  assert.equal(out.rounds, HARD_MAX_ROUNDS);
  assert.equal(log.length, HARD_MAX_ROUNDS * QUICK_ROLES.length);
  assert.equal(out.report.verdict, "REVISE");
});

test("default round budget is 3", () => {
  const challenger = createGoalChallenger({ runRole: async (i) => passFinding(i.role), mode: "QUICK" });
  assert.equal(challenger.maxRounds, DEFAULT_MAX_ROUNDS);
  assert.equal(DEFAULT_MAX_ROUNDS, 3);
});

test("BLOCKED stops immediately without spending another round", async () => {
  const log: RoleInput[] = [];
  const runner = perRoleRunner(
    (role) =>
      role === "failure-analysis"
        ? findingWith(role, "BLOCKED", [objection({ blocking: true })])
        : passFinding(role),
    log,
  );
  const out = await createGoalChallenger({ runRole: runner, mode: "QUICK", maxRounds: 3, now: () => FIXED }).challenge(
    baseInput(),
  );
  assert.equal(out.rounds, 1);
  assert.equal(log.length, QUICK_ROLES.length);
  assert.equal(out.report.verdict, "BLOCKED");
});

// ── OFF mode: no evaluation is never a PASS ───────────────────────────────────

test("mode OFF runs no critic and never claims PASS", async () => {
  let calls = 0;
  const out = await createGoalChallenger({
    runRole: async (i) => {
      calls += 1;
      return passFinding(i.role);
    },
    mode: "OFF",
    now: () => FIXED,
  }).challenge(baseInput());

  assert.equal(calls, 0);
  assert.equal(out.rounds, 1);
  assert.equal(out.evaluated, false);
  assert.equal(out.report.verdict, "BLOCKED");
  assert.equal(out.report.synthesis.counts.total, 0);
  assert.ok(out.recommendation.includes("NOT approved"));
});

// ── Independence ──────────────────────────────────────────────────────────────

test("no critic ever receives another critic's finding (canary assert)", async () => {
  const CANARY = "CANARY-FINDING-7d3e9c1b";
  const log: RoleInput[] = [];
  const runner = perRoleRunner(
    (role) => (role === "feasibility" ? findingWith(role, "PASS", [], CANARY) : passFinding(role)),
    log,
  );
  const out = await createGoalChallenger({ runRole: runner, mode: "QUICK", now: () => FIXED }).challenge(baseInput());

  assert.equal(log.length, QUICK_ROLES.length);
  assert.ok(log.every((i) => !JSON.stringify(i).includes(CANARY)), "a finding leaked into another critic's input");
  assert.ok(log.every((i) => !("findings" in i)), "RoleInput must never carry a findings field");
  assert.ok(log.every((i) => i.goal === "Ship the goal executive slice"));
  assert.ok(log.every((i) => i.contract.acceptanceCriteria.length === 2));
  // The canary is preserved in the report's own findings (it is synthesis output, not critic input).
  assert.ok(out.report.findings.some((f) => f.notes === CANARY));
});

test("critics receive their own distinct rubric and the correct role order", async () => {
  const log: RoleInput[] = [];
  const runners = perRoleRunner((role) => passFinding(role), log);
  const out = await createGoalChallenger({ runRole: runners, mode: "DEEP", now: () => FIXED }).challenge(baseInput());

  assert.deepEqual(out.report.findings.map((f) => f.role), CRITIC_ROLES.map((r) => r.role));
  assert.deepEqual(log.map((i) => i.role), CRITIC_ROLES.map((r) => r.role));
  const rubrics = new Set(log.map((i) => i.rubric));
  assert.equal(rubrics.size, CRITIC_ROLES.length);
  assert.ok(log.every((i) => i.rubric.length > 0));
  assert.ok(log.every((i) => i.goalRevisionId === "goal-1"));
});

// ── Honest failure: malformed output and thrown runners ───────────────────────

test("malformed runner output fails honestly as BLOCKED, never PASS", () => {
  const bad = normalizeFinding("feasibility", { verdict: "BANANA" });
  assert.equal(bad.verdict, "BLOCKED");
  assert.equal(bad.objections[0]?.blocking, true);
  assert.ok((bad.objections[0]?.evidence[0] ?? "").includes("BANANA"));
  assert.equal(synthesizeFindings([bad]).verdict, "BLOCKED");

  const notObject = normalizeFinding("user-value", null);
  assert.equal(notObject.verdict, "BLOCKED");
  assert.equal(notObject.role, "user-value");
});

test("a runner that returns non-array objections or a wrong role fails honestly", () => {
  const badObjections = normalizeFinding("security", { verdict: "PASS", objections: "nope" });
  assert.equal(badObjections.verdict, "BLOCKED");

  const wrongRole = normalizeFinding("security", { role: "feasibility", verdict: "PASS", objections: [] });
  assert.equal(wrongRole.verdict, "BLOCKED");
  assert.equal(wrongRole.role, "security");
});

test("unusable runner output inside the loop yields a BLOCKED report, not a fabricated PASS", async () => {
  const out = await createGoalChallenger({
    runRole: async () => ({ verdict: "MAYBE" }) as unknown as ChallengeFinding,
    mode: "QUICK",
    now: () => FIXED,
  }).challenge(baseInput());

  assert.equal(out.rounds, 1);
  assert.equal(out.report.verdict, "BLOCKED");
  assert.equal(out.evaluated, true);
  assert.ok(out.report.findings.every((f) => f.verdict === "BLOCKED"));
  assert.ok(out.recommendation.includes("BLOCKED"));
});

test("a runner that throws fails honestly as BLOCKED with the real error", async () => {
  const runner = perRoleRunner((role) => {
    if (role === "failure-analysis") throw new Error("model offline: 503");
    return passFinding(role);
  });
  const out = await createGoalChallenger({ runRole: runner, mode: "QUICK", now: () => FIXED }).challenge(baseInput());

  assert.equal(out.report.verdict, "BLOCKED");
  const failed = out.report.findings.find((f) => f.role === "failure-analysis");
  assert.equal(failed?.verdict, "BLOCKED");
  assert.ok((failed?.objections[0]?.evidence[0] ?? "").includes("model offline: 503"));
  assert.notEqual(out.report.verdict, "PASS");
});

// ── Output hygiene ────────────────────────────────────────────────────────────

test("unknown runner fields are ignored and never surface in the report", async () => {
  const CANARY = "CANARY-TRANSCRIPT-aa11bb22";
  const out = await createGoalChallenger({
    runRole: async (i) => ({ ...passFinding(i.role), transcript: CANARY }) as unknown as ChallengeFinding,
    mode: "QUICK",
    now: () => FIXED,
  }).challenge(baseInput());

  assert.equal(out.report.verdict, "PASS");
  assert.ok(!JSON.stringify(out.report).includes(CANARY));
  assert.ok(!("transcript" in (out.report.findings[0] as object)));
});

test("content defaults to the goal text when omitted", async () => {
  const log: RoleInput[] = [];
  const out = await createGoalChallenger({
    runRole: perRoleRunner((role) => passFinding(role), log),
    mode: "QUICK",
    now: () => FIXED,
  }).challenge(baseInput());
  assert.ok(log.every((i) => i.content === "Ship the goal executive slice"));
  assert.equal(out.history[0]?.content, "Ship the goal executive slice");
});

test("injected now stamps the round records", async () => {
  const out = await createGoalChallenger({
    runRole: async (i) => passFinding(i.role),
    mode: "QUICK",
    now: () => FIXED,
  }).challenge(baseInput());
  assert.equal(out.history[0]?.at, FIXED.toISOString());
});

test("mode and roles are exposed on the challenger", () => {
  const challenger = createGoalChallenger({ runRole: async (i) => passFinding(i.role), mode: "DEEP" });
  assert.equal(challenger.mode, "DEEP");
  assert.deepEqual(challenger.roles.map((r) => r.role), CRITIC_ROLES.map((r) => r.role));
});

// ── Typo guard for the mode union ─────────────────────────────────────────────

test("every ChallengeMode is handled by selectCriticRoles", () => {
  const modes: ChallengeMode[] = ["OFF", "QUICK", "DEEP", "CONTINUOUS"];
  for (const mode of modes) {
    const roles = selectCriticRoles(mode);
    assert.ok(Array.isArray(roles));
  }
});
