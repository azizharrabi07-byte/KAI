// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Goal Architect tests.
 * Plain `node --test`, no dependencies, no network, no live model.
 * Run from `core/`:  node --test tests/goal-architect.test.ts
 *
 * The point of this suite is the BAR, not the happy path: a plan that cannot be
 * verified, or whose dependencies do not resolve into an acyclic graph, or that
 * exceeds its budget, must be REFUSED with a reason — never returned as content.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  createGoalArchitect,
  deriveAcceptanceCriteria,
  parsePlanContent,
  planToOutcomeContract,
  validatePlanContent,
  type GoalArchitect,
  type PlanGoalInput,
} from "../src/goals/architect.ts";
import type { GoalPlanContent } from "../src/goals/goal.ts";
import { createOutcomeContract } from "../src/orchestration/outcome.ts";

/** A well-formed plan reply; `overrides` replaces whole top-level fields. */
function planReply(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    summary: "Ship the login flow",
    deliverables: ["a working login page"],
    tasks: [
      {
        id: "t1",
        title: "Implement login",
        objective: "Add the login route",
        dependsOn: [],
        role: "coding",
        acceptanceCriteria: ["login succeeds with valid credentials"],
        verification: ["run the auth test suite"],
      },
      {
        id: "t2",
        title: "Regression QA",
        objective: "Verify the login flow",
        dependsOn: ["t1"],
        role: "qa",
        acceptanceCriteria: ["no regression in auth"],
        verification: ["run `npm test -- auth`"],
      },
    ],
    acceptanceCriteria: ["the user can log in"],
    requiredEvidence: ["auth test output"],
    constraints: ["no new dependencies"],
    forbiddenOutcomes: ["storing plaintext passwords"],
    authorizedWorkspace: ["src/auth"],
    assumptions: ["the user table exists"],
    uncertainties: [],
    // The model's own budget is deliberately generous — it must be IGNORED.
    budgets: { maxTasks: 99, maxRetries: 9, maxDepth: 9 },
    ...overrides,
  });
}

function architectFor(text: string, now?: () => Date): GoalArchitect {
  return createGoalArchitect({ runPlanner: async () => text, ...(now !== undefined ? { now } : {}) });
}

async function planOk(text: string, input: PlanGoalInput): Promise<GoalPlanContent> {
  const result = await architectFor(text).planGoal(input);
  assert.equal(result.ok, true, !result.ok ? result.reason : "");
  return result.content;
}

const BASE_INPUT = { goalId: "g1", intent: "Let a user log in" };

// ── Happy path ───────────────────────────────────────────────────────────────

test("a well-formed plan becomes GoalPlanContent with task-level criteria + methods", async () => {
  const content = await planOk(planReply(), BASE_INPUT);
  assert.equal(content.summary, "Ship the login flow");
  assert.deepEqual(content.deliverables, ["a working login page"]);
  assert.equal(content.tasks.length, 2);
  assert.deepEqual(content.tasks[0]!.dependsOn, []);
  assert.deepEqual(content.tasks[1]!.dependsOn, ["t1"]);
  assert.deepEqual(content.tasks[0]!.acceptanceCriteria, ["login succeeds with valid credentials"]);
  assert.deepEqual(content.tasks[0]!.verification, ["run the auth test suite"]);
  assert.deepEqual(content.acceptanceCriteria, ["the user can log in"]);
  assert.deepEqual(content.requiredEvidence, ["auth test output"]);
});

test("the caller's budget wins; the model can never widen its own budget", async () => {
  const content = await planOk(planReply(), { ...BASE_INPUT, budgets: { maxTasks: 4, maxRetries: 1, maxDepth: 2 } });
  assert.deepEqual(content.budgets, { maxTasks: 4, maxRetries: 1, maxDepth: 2 });
});

test("the caller's constraints and forbidden outcomes survive planning", async () => {
  const content = await planOk(planReply(), {
    ...BASE_INPUT,
    constraints: ["offline first"],
    forbiddenOutcomes: ["telemetry of credentials"],
  });
  assert.ok(content.constraints.includes("offline first"));
  assert.ok(content.constraints.includes("no new dependencies"));
  assert.ok(content.forbiddenOutcomes.includes("telemetry of credentials"));
  assert.ok(content.forbiddenOutcomes.includes("storing plaintext passwords"));
});

test("the model may not widen the authorized workspace; extra paths are recorded", async () => {
  const content = await planOk(planReply({ authorizedWorkspace: ["src/auth", "../etc"] }), {
    ...BASE_INPUT,
    authorizedWorkspace: ["src/auth"],
  });
  assert.deepEqual(content.authorizedWorkspace, ["src/auth"]);
  assert.ok(
    content.uncertainties.some((u) => u.includes("outside the authorized set")),
    "the trimmed paths must be surfaced as an uncertainty",
  );
});

// ── Refusals: the structural bar ─────────────────────────────────────────────

test("a plan with an unverifiable criterion is REFUSED", async () => {
  const text = planReply({
    tasks: [
      {
        id: "t1",
        title: "Implement login",
        objective: "Add the login route",
        dependsOn: [],
        role: "coding",
        acceptanceCriteria: ["login succeeds with valid credentials"],
        verification: [],
      },
    ],
  });
  const result = await architectFor(text).planGoal(BASE_INPUT);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /no verification method/);
});

test("a criterion whose method is blank is REFUSED", async () => {
  const text = planReply({
    tasks: [
      {
        id: "t1",
        title: "Implement login",
        objective: "Add the login route",
        dependsOn: [],
        role: "coding",
        acceptanceCriteria: ["login succeeds", "no crashes"],
        verification: ["run the suite", "   "],
      },
    ],
  });
  const result = await architectFor(text).planGoal(BASE_INPUT);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /criterion "no crashes" has no verification method/);
});

test("a dependency cycle is refused, named, and never hangs", async () => {
  const text = planReply({
    tasks: [
      { id: "a", title: "A", objective: "do A", dependsOn: ["b"], role: "coding", acceptanceCriteria: ["a done"], verification: ["check a"] },
      { id: "b", title: "B", objective: "do B", dependsOn: ["a"], role: "coding", acceptanceCriteria: ["b done"], verification: ["check b"] },
    ],
  });
  const result = await architectFor(text).planGoal(BASE_INPUT);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /dependency cycle among: a, b/);
});

test("a self-dependency is refused", async () => {
  const text = planReply({
    tasks: [
      { id: "a", title: "A", objective: "do A", dependsOn: ["a"], role: "coding", acceptanceCriteria: ["a done"], verification: ["check a"] },
    ],
  });
  const result = await architectFor(text).planGoal(BASE_INPUT);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /depends on itself/);
});

test("an unknown dependency id is refused", async () => {
  const text = planReply({
    tasks: [
      { id: "a", title: "A", objective: "do A", dependsOn: ["ghost"], role: "coding", acceptanceCriteria: ["a done"], verification: ["check a"] },
    ],
  });
  const result = await architectFor(text).planGoal(BASE_INPUT);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /depends on unknown task "ghost"/);
});

test("the task budget is enforced against the caller's maxTasks", async () => {
  const text = planReply({
    tasks: [
      { id: "a", title: "A", objective: "do A", dependsOn: [], role: "coding", acceptanceCriteria: ["a done"], verification: ["check a"] },
      { id: "b", title: "B", objective: "do B", dependsOn: ["a"], role: "coding", acceptanceCriteria: ["b done"], verification: ["check b"] },
    ],
  });
  const result = await architectFor(text).planGoal({ ...BASE_INPUT, budgets: { maxTasks: 1 } });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /above the budget of 1/);
});

test("a task with an empty objective is refused", async () => {
  const text = planReply({
    tasks: [
      { id: "a", title: "A", objective: "   ", dependsOn: [], role: "coding", acceptanceCriteria: ["a done"], verification: ["check a"] },
    ],
  });
  const result = await architectFor(text).planGoal(BASE_INPUT);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /needs a non-empty objective/);
});

test("a task with no role cannot be dispatched and is refused", async () => {
  const text = planReply({
    tasks: [
      { id: "a", title: "A", objective: "do A", dependsOn: [], role: "", acceptanceCriteria: ["a done"], verification: ["check a"] },
    ],
  });
  const result = await architectFor(text).planGoal(BASE_INPUT);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /needs a non-empty role/);
});

// ── Derivation + honesty ─────────────────────────────────────────────────────

test("missing plan criteria are derived from deliverables", async () => {
  const content = await planOk(planReply({ acceptanceCriteria: [] }), BASE_INPUT);
  assert.deepEqual(content.acceptanceCriteria, ["deliverable present: a working login page"]);
});

test("with no deliverables either, the generic criterion is used", async () => {
  const content = await planOk(planReply({ acceptanceCriteria: [], deliverables: [] }), BASE_INPUT);
  assert.deepEqual(content.acceptanceCriteria, ["a user-facing deliverable exists"]);
});

test("deriveAcceptanceCriteria mirrors createOutcomeContract exactly", () => {
  const forced = createOutcomeContract({ missionId: "m", intent: "i", deliverables: ["one", "two"] }).acceptanceCriteria;
  assert.deepEqual(deriveAcceptanceCriteria(["one", "two"]), forced);
  const generic = createOutcomeContract({ missionId: "m", intent: "i" }).acceptanceCriteria;
  assert.deepEqual(deriveAcceptanceCriteria([]), generic);
});

test("an unknown gap surfaces as an uncertainty, never as an invented fact", async () => {
  const content = await planOk(planReply({ uncertainties: [] }), BASE_INPUT); // no facts supplied
  assert.ok(content.uncertainties.some((u) => u.includes("no facts were supplied")));
});

test("supplied facts do not manufacture a gap uncertainty", async () => {
  const content = await planOk(planReply({ uncertainties: [] }), { ...BASE_INPUT, facts: ["the user table exists"] });
  assert.deepEqual(content.uncertainties, []);
});

test("the planner's own uncertainties are preserved verbatim", async () => {
  const content = await planOk(planReply({ uncertainties: ["unclear whether SSO is required"] }), BASE_INPUT);
  assert.ok(content.uncertainties.includes("unclear whether SSO is required"));
});

// ── Malformed transport ──────────────────────────────────────────────────────

test("a malformed model reply is refused honestly (not JSON)", async () => {
  const result = await architectFor("I could not produce a plan, sorry.").planGoal(BASE_INPUT);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /not valid JSON/);
});

test("a reply with no tasks is refused, never presented as an empty plan", async () => {
  const result = await architectFor(planReply({ tasks: [] })).planGoal(BASE_INPUT);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /needs at least one task/);
});

test("a wrong-typed plan field is refused", async () => {
  const result = await architectFor(planReply({ constraints: "no new deps" })).planGoal(BASE_INPUT);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /constraints must be an array of strings/);
});

test("code fences and prose around the object are tolerated", async () => {
  const text = "Here is the plan:\n```json\n" + planReply() + "\n```\nLet me know!";
  const content = await planOk(text, BASE_INPUT);
  assert.equal(content.tasks.length, 2);
});

test("an empty intent is refused before the model is consulted", async () => {
  const result = await architectFor(planReply()).planGoal({ goalId: "g1", intent: "   " });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /non-empty intent/);
});

test("a planner failure is reported as an unreachable architect", async () => {
  const architect = createGoalArchitect({
    runPlanner: async () => {
      throw new Error("gateway 503");
    },
  });
  const result = await architect.planGoal(BASE_INPUT);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /architect is unavailable: gateway 503/);
});

// ── Prompt + hand-off ────────────────────────────────────────────────────────

test("the prompt carries the facts, hard constraints, forbidden outcomes and the budget", async () => {
  const architect = createGoalArchitect({ runPlanner: async () => planReply() });
  const result = await architect.planGoal({
    goalId: "g7",
    intent: "Let a user log in",
    facts: ["the user table exists"],
    constraints: ["offline first"],
    forbiddenOutcomes: ["telemetry of credentials"],
    authorizedWorkspace: ["src/auth"],
    budgets: { maxTasks: 3 },
    mode: "DEEP",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.match(result.prompt, /the user table exists/);
  assert.match(result.prompt, /offline first/);
  assert.match(result.prompt, /telemetry of credentials/);
  assert.match(result.prompt, /At most 3 tasks\./);
  assert.match(result.prompt, /Challenge mode DEEP/);
});

test("planToOutcomeContract round-trips criteria, evidence and forbidden outcomes", async () => {
  const content = await planOk(planReply(), {
    ...BASE_INPUT,
    authorizedWorkspace: ["src/auth"],
    budgets: { maxRetries: 4 },
  });
  const contract = planToOutcomeContract(content, "g1");
  assert.equal(contract.missionId, "g1");
  assert.deepEqual(contract.acceptanceCriteria, content.acceptanceCriteria);
  assert.deepEqual(contract.requiredEvidence, content.requiredEvidence);
  assert.deepEqual(contract.forbiddenOutcomes, content.forbiddenOutcomes);
  assert.deepEqual(contract.authorityScope, content.authorizedWorkspace);
  assert.deepEqual(contract.deliverables, content.deliverables);
  assert.deepEqual(contract.constraints, content.constraints);
  assert.equal(contract.maxRetries, 4);
});

// ── Direct unit surface ──────────────────────────────────────────────────────

test("parsePlanContent fills a deterministic id/title but never a rule", () => {
  const parsed = parsePlanContent(
    JSON.stringify({ tasks: [{ objective: "do the thing", acceptanceCriteria: [], verification: [] }] }),
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.tasks[0]!.id, "task-1");
  assert.equal(parsed.value.tasks[0]!.title, "do the thing");
  // parse is lenient; the missing role is still a refusal at validation time.
  const validated = validatePlanContent(parsed.value);
  assert.equal(validated.ok, false);
  if (validated.ok) return;
  assert.match(validated.reason, /needs a non-empty role/);
});

test("validatePlanContent defaults its cap to content.budgets.maxTasks", async () => {
  const content = await planOk(planReply(), BASE_INPUT);
  assert.deepEqual(validatePlanContent(content), { ok: true });
  const crowded: GoalPlanContent = { ...content, budgets: { ...content.budgets, maxTasks: 1 } };
  const validated = validatePlanContent(crowded);
  assert.equal(validated.ok, false);
  if (validated.ok) return;
  assert.match(validated.reason, /above the budget of 1/);
});
