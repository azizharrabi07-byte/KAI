// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The Goal Architect — turn a challenged goal into a STRUCTURED, VERIFIABLE plan.
 *
 * The executive's contract for this phase is "goal → challenge → plan → approve
 * a revision → durably ready". This module owns the middle step: given the
 * goal's intent plus the facts, constraints and authority the goal carries, it
 * asks a planner for a `GoalPlanContent` and REFUSES anything it cannot verify.
 *
 * ── Refuse, never dress up ───────────────────────────────────────────────────
 * A plan is the thing a human approves and execution inherits, so a plan that
 * cannot be verified must never be presented as valid. Concretely:
 *   - every task needs a non-empty objective;
 *   - every acceptance criterion needs a non-empty verification METHOD (the
 *     criterion and its method are index-aligned) — an unverifiable criterion
 *     is refused rather than accepted;
 *   - dependency ids must exist and the graph must be ACYCLIC (Kahn's
 *     algorithm; a cycle is reported, never a hang);
 *   - the task count may not exceed the caller's budget;
 *   - an unparseable model reply is refused, never read as an empty plan.
 * These are the same bars Plan Mode applies to its steps; the difference is
 * that this plan is bound to a goal and inherits the goal's authority.
 *
 * ── Authority is the caller's, never the model's ─────────────────────────────
 * `budgets` and `authorizedWorkspace` come from the goal, not from the model's
 * output: the model is never allowed to widen its own budget or its own
 * workspace. The model's extra workspace is trimmed and recorded as an
 * uncertainty; caller constraints and forbidden outcomes are UNIONED in, so a
 * hard constraint the goal carried cannot be dropped by a forgetful planner.
 *
 * ── Honesty about the unknown ───────────────────────────────────────────────
 * `facts` are the only known facts. Anything else the plan rests on belongs in
 * `assumptions[]`, and anything unknown belongs in `uncertainties[]` — never
 * invented as a fact. When the caller supplied no facts at all, that gap is
 * recorded explicitly rather than silently treated as knowledge.
 *
 * ── Testability ─────────────────────────────────────────────────────────────
 * The planner is injected (`runPlanner`), exactly as the reviewer loop injects
 * its runner, so every rule above is provable without a live model.
 */

import { createOutcomeContract, type OutcomeContract } from "../orchestration/outcome.ts";
import { extractJson } from "../plans/plans.ts";
import { isRecord } from "../shared/contracts.ts";
import type { ChallengeMode } from "./challenger.ts";
// The plan vocabulary is OWNED by the goal layer (`goal.ts`), because the store
// hashes exactly this shape (`hashPlanContent`) when a revision is persisted and
// approved. The architect produces it; it does not redefine it.
import type { GoalBudgets, GoalPlanContent, GoalTaskDraft } from "./goal.ts";

/** Safe defaults. A caller may tighten them; the model may not widen them. */
export const DEFAULT_PLAN_BUDGETS: GoalBudgets = { maxTasks: 12, maxRetries: 2, maxDepth: 3 };


/** JSON schema for the plan content, mirroring Plan Mode's `PLAN_SCHEMA`. */
export const PLAN_CONTENT_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    deliverables: { type: "array", items: { type: "string" } },
    tasks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          objective: { type: "string" },
          dependsOn: { type: "array", items: { type: "string" } },
          role: { type: "string" },
          acceptanceCriteria: { type: "array", items: { type: "string" } },
          verification: { type: "array", items: { type: "string" } },
        },
        required: ["id", "title", "objective", "dependsOn", "role", "acceptanceCriteria", "verification"],
        additionalProperties: false,
      },
    },
    acceptanceCriteria: { type: "array", items: { type: "string" } },
    requiredEvidence: { type: "array", items: { type: "string" } },
    constraints: { type: "array", items: { type: "string" } },
    forbiddenOutcomes: { type: "array", items: { type: "string" } },
    authorizedWorkspace: { type: "array", items: { type: "string" } },
    assumptions: { type: "array", items: { type: "string" } },
    uncertainties: { type: "array", items: { type: "string" } },
    budgets: {
      type: "object",
      properties: {
        maxTasks: { type: "integer" },
        maxRetries: { type: "integer" },
        maxDepth: { type: "integer" },
      },
      required: ["maxTasks", "maxRetries", "maxDepth"],
      additionalProperties: false,
    },
  },
  required: [
    "summary",
    "deliverables",
    "tasks",
    "acceptanceCriteria",
    "requiredEvidence",
    "constraints",
    "forbiddenOutcomes",
    "authorizedWorkspace",
    "assumptions",
    "uncertainties",
    "budgets",
  ],
  additionalProperties: false,
} as const;

/** The exact shape the planner must return, shown in the prompt. */
const PLAN_SHAPE_EXAMPLE = `{
  "summary": "one paragraph",
  "deliverables": ["what the user receives"],
  "tasks": [
    {
      "id": "t1",
      "title": "short label",
      "objective": "what this task accomplishes",
      "dependsOn": [],
      "role": "coding",
      "acceptanceCriteria": ["the test suite passes"],
      "verification": ["run node --test tests/x.test.ts and read the summary"]
    }
  ],
  "acceptanceCriteria": ["plan-level criteria"],
  "requiredEvidence": ["labels the outcome gate must observe"],
  "constraints": [],
  "forbiddenOutcomes": [],
  "authorizedWorkspace": ["paths the plan may touch"],
  "assumptions": [],
  "uncertainties": [],
  "budgets": { "maxTasks": 12, "maxRetries": 2, "maxDepth": 3 }
}`;

// ── Budgets ──────────────────────────────────────────────────────────────────

/** Keep only positive integers; anything else falls back to the safe default. */
export function normalizeBudgets(input?: Partial<GoalBudgets>): GoalBudgets {
  const pick = (value: number | undefined, fallback: number): number =>
    typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
  return {
    maxTasks: pick(input?.maxTasks, DEFAULT_PLAN_BUDGETS.maxTasks),
    maxRetries: pick(input?.maxRetries, DEFAULT_PLAN_BUDGETS.maxRetries),
    maxDepth: pick(input?.maxDepth, DEFAULT_PLAN_BUDGETS.maxDepth),
  };
}

// ── Criteria derivation (mirrors createOutcomeContract exactly) ──────────────

/**
 * Derive acceptance criteria from deliverables, EXACTLY as
 * `createOutcomeContract` does: one criterion per deliverable, or a single
 * generic criterion when none were named. Kept as a named function so the
 * mirror can be asserted in tests rather than trusted.
 */
export function deriveAcceptanceCriteria(deliverables: string[]): string[] {
  return deliverables.length > 0
    ? deliverables.map((deliverable) => `deliverable present: ${deliverable}`)
    : ["a user-facing deliverable exists"];
}

// ── Prompt ───────────────────────────────────────────────────────────────────

export interface PlanPromptInput {
  goalId: string;
  intent: string;
  facts: string[];
  constraints: string[];
  forbiddenOutcomes: string[];
  authorizedWorkspace: string[];
  budgets: GoalBudgets;
  mode: ChallengeMode;
}

const MODE_RULE: Record<ChallengeMode, string> = {
  OFF: "Challenge mode is OFF: do not rehearse objections; produce the plan.",
  QUICK: "Challenge mode QUICK: name the few highest-risk uncertainties.",
  DEEP: "Challenge mode DEEP: be exhaustive about assumptions, uncertainties and forbidden outcomes; this plan faces adversarial review.",
  CONTINUOUS: "Challenge mode CONTINUOUS: every criterion must stay independently verifiable, because this goal is reviewed repeatedly.",
};

function renderList(label: string, values: string[]): string {
  return values.length === 0 ? `${label}: (none)` : `${label}:\n${values.map((v) => `- ${v}`).join("\n")}`;
}

/** Render the planner prompt. The planner is injected, so this is pure text. */
export function buildPlanPrompt(input: PlanPromptInput): string {
  return [
    "You are KAI's architect. Produce a PLAN as one JSON object — not prose, and not actions.",
    "Rules:",
    "- Every task needs: id (unique in this plan), title, objective, dependsOn, role, acceptanceCriteria, verification.",
    "- objective must be a non-empty description of what the task accomplishes.",
    "- For EVERY acceptance criterion, give its verification METHOD at the SAME index in `verification` (a command, an inspection, or an independent check). A criterion without a method is refused.",
    "- dependsOn names task ids from THIS plan only; the dependency graph must be acyclic.",
    `- At most ${input.budgets.maxTasks} tasks.`,
    "- Plan-level acceptanceCriteria are derived from deliverables when you omit them.",
    "- Honesty: ONLY the KNOWN FACTS below are facts. Anything you are unsure about goes in `uncertainties`; anything you are assuming goes in `assumptions`. Never state an unknown as a fact.",
    `- ${MODE_RULE[input.mode]}`,
    `- Return ONLY the JSON object; the shape is:\n${PLAN_SHAPE_EXAMPLE}`,
    "## KNOWN FACTS",
    input.facts.length === 0 ? "(none were supplied — record that gap as an uncertainty)" : input.facts.map((f) => `- ${f}`).join("\n"),
    renderList("## CONSTRAINTS (hard, must survive)", input.constraints),
    renderList("## FORBIDDEN OUTCOMES (hard, must survive)", input.forbiddenOutcomes),
    renderList("## AUTHORIZED WORKSPACE (the plan may not widen this)", input.authorizedWorkspace),
    `## GOAL (id ${input.goalId})`,
    input.intent,
  ].join("\n");
}

// ── Parse (lenient transport, safe bar) ──────────────────────────────────────

/** A missing field reads as `[]`; a wrong-typed field reads as an error. */
function stringArray(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    out.push(item);
  }
  return out;
}

function listField(
  parsed: Record<string, unknown>,
  key: string,
): { ok: true; value: string[] } | { ok: false; reason: string } {
  const value = stringArray(parsed[key]);
  return value === null ? { ok: false, reason: `${key} must be an array of strings` } : { ok: true, value };
}

export interface ParsePlanOptions {
  /** Caller-authoritative budgets. The model's own budgets are ignored. */
  budgets?: Partial<GoalBudgets>;
  /** Labels the plan when the model returns no summary (the intent). */
  fallbackSummary?: string;
}

/**
 * Parse a model reply into `GoalPlanContent`. Transport tolerance only — code
 * fences and surrounding prose are stripped, bookkeeping fields get deterministic
 * fallbacks (an id, a title) — but no rule is relaxed: shape errors are refusals.
 * Structural rules (objectives, verification pairing, dependency graph, budget)
 * are enforced by `validatePlanContent`, which the caller runs next.
 */
export function parsePlanContent(
  text: string,
  opts: ParsePlanOptions = {},
): { ok: true; value: GoalPlanContent } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(text)) as unknown;
  } catch {
    return { ok: false, reason: "the plan was not valid JSON" };
  }
  if (!isRecord(parsed)) return { ok: false, reason: "the plan must be a JSON object" };

  const rawTasks = parsed["tasks"];
  if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
    return { ok: false, reason: "the plan needs at least one task" };
  }

  const tasks: GoalTaskDraft[] = [];
  for (let i = 0; i < rawTasks.length; i += 1) {
    const raw = rawTasks[i];
    if (!isRecord(raw)) return { ok: false, reason: `task ${i} must be an object` };
    const objective = typeof raw["objective"] === "string" ? raw["objective"] : "";
    const rawTitle = typeof raw["title"] === "string" ? raw["title"] : "";
    const rawId = typeof raw["id"] === "string" ? raw["id"] : "";
    const dependsOn = stringArray(raw["dependsOn"]);
    if (dependsOn === null) return { ok: false, reason: `task ${i} dependsOn must be an array of ids` };
    const criteria = stringArray(raw["acceptanceCriteria"]);
    if (criteria === null) return { ok: false, reason: `task ${i} acceptanceCriteria must be an array of strings` };
    const verification = stringArray(raw["verification"]);
    if (verification === null) return { ok: false, reason: `task ${i} verification must be an array of strings` };
    tasks.push({
      // id and title are bookkeeping: a deterministic fallback keeps dependency
      // resolution honest without inventing content. The objective is the plan.
      id: rawId.trim().length > 0 ? rawId : `task-${i + 1}`,
      title: rawTitle.trim().length > 0 ? rawTitle : objective,
      objective,
      dependsOn,
      role: typeof raw["role"] === "string" ? raw["role"] : "",
      acceptanceCriteria: criteria,
      verification,
    });
  }

  const deliverables = listField(parsed, "deliverables");
  if (!deliverables.ok) return deliverables;
  const criteria = listField(parsed, "acceptanceCriteria");
  if (!criteria.ok) return criteria;
  const requiredEvidence = listField(parsed, "requiredEvidence");
  if (!requiredEvidence.ok) return requiredEvidence;
  const constraints = listField(parsed, "constraints");
  if (!constraints.ok) return constraints;
  const forbiddenOutcomes = listField(parsed, "forbiddenOutcomes");
  if (!forbiddenOutcomes.ok) return forbiddenOutcomes;
  const authorizedWorkspace = listField(parsed, "authorizedWorkspace");
  if (!authorizedWorkspace.ok) return authorizedWorkspace;
  const assumptions = listField(parsed, "assumptions");
  if (!assumptions.ok) return assumptions;
  const uncertainties = listField(parsed, "uncertainties");
  if (!uncertainties.ok) return uncertainties;

  const summary =
    typeof parsed["summary"] === "string" && parsed["summary"].trim().length > 0
      ? parsed["summary"].trim()
      : (opts.fallbackSummary ?? "").trim();

  return {
    ok: true,
    value: {
      summary,
      deliverables: deliverables.value,
      tasks,
      // Same derivation as createOutcomeContract: an empty list is filled from
      // the deliverables; it is never left as "no way to verify success".
      acceptanceCriteria: criteria.value.length > 0 ? criteria.value : deriveAcceptanceCriteria(deliverables.value),
      requiredEvidence: requiredEvidence.value,
      constraints: constraints.value,
      forbiddenOutcomes: forbiddenOutcomes.value,
      authorizedWorkspace: authorizedWorkspace.value,
      assumptions: assumptions.value,
      uncertainties: uncertainties.value,
      budgets: normalizeBudgets(opts.budgets),
    },
  };
}

// ── Validation (the bar) ─────────────────────────────────────────────────────

export interface PlanValidationOptions {
  /** Overrides `content.budgets.maxTasks` when given. */
  maxTasks?: number;
}

/**
 * Kahn's algorithm: report the tasks left unresolved by a topological sort —
 * i.e. exactly the nodes that sit on (or downstream of) a cycle. Iterative, so
 * a pathological graph is answered, not hung on.
 */
function findDependencyCycle(tasks: GoalTaskDraft[]): string[] | null {
  const index = new Map<string, number>();
  tasks.forEach((task, i) => index.set(task.id.trim(), i));
  const indegree = new Array<number>(tasks.length).fill(0);
  const dependents: number[][] = tasks.map(() => []);
  tasks.forEach((task, i) => {
    for (const dep of task.dependsOn) {
      const depIndex = index.get(dep.trim());
      if (depIndex === undefined) continue; // existence is checked before this
      indegree[i] = (indegree[i] ?? 0) + 1;
      dependents[depIndex]!.push(i);
    }
  });
  const queue: number[] = [];
  for (let i = 0; i < tasks.length; i += 1) if (indegree[i] === 0) queue.push(i);
  let processed = 0;
  for (let head = 0; head < queue.length; head += 1) {
    const i = queue[head]!;
    processed += 1;
    for (const next of dependents[i]!) {
      indegree[next] = (indegree[next] ?? 0) - 1;
      if (indegree[next] === 0) queue.push(next);
    }
  }
  if (processed === tasks.length) return null;
  return tasks.filter((_, i) => (indegree[i] ?? 0) > 0).map((task) => task.id.trim());
}

/**
 * The structural bar a plan must clear before it may be approved. Refusals name
 * the defect. First failure wins, so the reason a human sees is the first one
 * they must fix.
 */
export function validatePlanContent(
  content: GoalPlanContent,
  opts: PlanValidationOptions = {},
): { ok: true } | { ok: false; reason: string } {
  const tasks = content.tasks;
  if (tasks.length === 0) return { ok: false, reason: "the plan needs at least one task" };
  const maxTasks = typeof opts.maxTasks === "number" ? opts.maxTasks : content.budgets.maxTasks;
  if (tasks.length > maxTasks) {
    return { ok: false, reason: `the plan holds ${tasks.length} tasks, above the budget of ${maxTasks}` };
  }

  const ids = new Set<string>();
  for (const task of tasks) {
    const id = task.id.trim();
    if (id.length === 0) return { ok: false, reason: "a task needs a non-empty id" };
    if (ids.has(id)) return { ok: false, reason: `duplicate task id "${id}"` };
    ids.add(id);
    if (task.title.trim().length === 0) return { ok: false, reason: `task "${id}" needs a non-empty title` };
    if (task.objective.trim().length === 0) return { ok: false, reason: `task "${id}" needs a non-empty objective` };
    if (task.role.trim().length === 0) return { ok: false, reason: `task "${id}" needs a non-empty role` };
    for (let j = 0; j < task.acceptanceCriteria.length; j += 1) {
      const criterion = task.acceptanceCriteria[j] ?? "";
      if (criterion.trim().length === 0) return { ok: false, reason: `task "${id}" criterion ${j} is empty` };
      const method = (task.verification[j] ?? "").trim();
      if (method.length === 0) {
        return { ok: false, reason: `task "${id}" criterion "${criterion}" has no verification method` };
      }
    }
  }

  for (const task of tasks) {
    const id = task.id.trim();
    for (const dep of task.dependsOn) {
      const target = dep.trim();
      if (target.length === 0) return { ok: false, reason: `task "${id}" has an empty dependency id` };
      if (target === id) return { ok: false, reason: `task "${id}" depends on itself` };
      if (!ids.has(target)) return { ok: false, reason: `task "${id}" depends on unknown task "${target}"` };
    }
  }

  const cycle = findDependencyCycle(tasks);
  if (cycle !== null) {
    return { ok: false, reason: `the task graph has a dependency cycle among: ${cycle.join(", ")}` };
  }
  return { ok: true };
}

// ── Architect ────────────────────────────────────────────────────────────────

export interface PlanGoalInput {
  goalId: string;
  intent: string;
  /** The only KNOWN facts. Anything not here is an assumption/uncertainty. */
  facts?: string[];
  constraints?: string[];
  forbiddenOutcomes?: string[];
  authorizedWorkspace?: string[];
  budgets?: Partial<GoalBudgets>;
  mode?: ChallengeMode;
}

export type PlanGoalResult =
  | { ok: true; content: GoalPlanContent; prompt: string; plannedAt: string }
  | { ok: false; reason: string };

export interface GoalArchitectDeps {
  /** Injected planner: prompt in, raw model text out. No live model in tests. */
  runPlanner: (prompt: string) => Promise<string>;
  now?: () => Date;
}

export interface GoalArchitect {
  planGoal(input: PlanGoalInput): Promise<PlanGoalResult>;
}

function clean(values: string[] | undefined): string[] {
  return (values ?? []).map((v) => v.trim()).filter((v) => v.length > 0);
}

/**
 * Enforce the goal's authority over the plan the model produced:
 *   - the goal's constraints and forbidden outcomes are UNIONED in (a hard
 *     constraint cannot be dropped by a forgetful planner);
 *   - when the goal pinned a workspace, the plan is restricted to it, and any
 *     workspace the model tried to ADD is recorded as an uncertainty;
 *   - when the goal supplied no facts, that gap is recorded as an uncertainty
 *     rather than silently treated as knowledge.
 */
function withGoalAuthority(
  content: GoalPlanContent,
  ctx: { facts: string[]; constraints: string[]; forbiddenOutcomes: string[]; authorizedWorkspace: string[] },
): GoalPlanContent {
  const uncertainties = [...content.uncertainties];
  let authorizedWorkspace = content.authorizedWorkspace;
  if (ctx.authorizedWorkspace.length > 0) {
    const allowed = new Set(ctx.authorizedWorkspace);
    const extra = content.authorizedWorkspace.filter((w) => !allowed.has(w));
    if (extra.length > 0) {
      uncertainties.push(
        `the architect proposed workspace outside the authorized set (${extra.join(", ")}); the plan is restricted to the authorized workspace`,
      );
    }
    authorizedWorkspace = [...ctx.authorizedWorkspace];
  }
  if (ctx.facts.length === 0 && uncertainties.length === 0) {
    uncertainties.push("no facts were supplied for this goal: the plan rests on assumptions, not verified context");
  }
  return {
    ...content,
    constraints: [...new Set([...ctx.constraints, ...content.constraints])],
    forbiddenOutcomes: [...new Set([...ctx.forbiddenOutcomes, ...content.forbiddenOutcomes])],
    authorizedWorkspace,
    uncertainties,
  };
}

export function createGoalArchitect(deps: GoalArchitectDeps): GoalArchitect {
  return {
    async planGoal(input: PlanGoalInput): Promise<PlanGoalResult> {
      const goalId = input.goalId.trim();
      const intent = input.intent.trim();
      if (goalId.length === 0) return { ok: false, reason: "a plan needs a non-empty goalId" };
      if (intent.length === 0) return { ok: false, reason: "a plan needs a non-empty intent" };

      const budgets = normalizeBudgets(input.budgets);
      const facts = clean(input.facts);
      const constraints = clean(input.constraints);
      const forbiddenOutcomes = clean(input.forbiddenOutcomes);
      const authorizedWorkspace = clean(input.authorizedWorkspace);
      const mode = input.mode ?? "QUICK";

      const prompt = buildPlanPrompt({ goalId, intent, facts, constraints, forbiddenOutcomes, authorizedWorkspace, budgets, mode });

      let text: string;
      try {
        text = await deps.runPlanner(prompt);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return { ok: false, reason: `the architect is unavailable: ${detail}` };
      }

      const parsed = parsePlanContent(text, { budgets, fallbackSummary: intent });
      if (!parsed.ok) return { ok: false, reason: parsed.reason };

      const content = withGoalAuthority(parsed.value, { facts, constraints, forbiddenOutcomes, authorizedWorkspace });
      const valid = validatePlanContent(content, { maxTasks: budgets.maxTasks });
      if (!valid.ok) return { ok: false, reason: valid.reason };

      return { ok: true, content, prompt, plannedAt: (deps.now?.() ?? new Date()).toISOString() };
    },
  };
}

// ── Hand-off to the existing outcome contract ────────────────────────────────

/**
 * Map an approved plan onto the EXISTING `OutcomeContract` so every lower-level
 * work item inherits the goal's criteria, evidence, forbidden outcomes and
 * authority without re-deriving them. Field names are the contract's own —
 * `authorizedWorkspace → authorityScope`, `budgets.maxRetries → maxRetries` —
 * so nothing parallel is invented.
 */
export function planToOutcomeContract(content: GoalPlanContent, goalId: string): OutcomeContract {
  return createOutcomeContract({
    missionId: goalId,
    intent: content.summary.length > 0 ? content.summary : "goal plan",
    objective: content.summary,
    deliverables: content.deliverables,
    constraints: content.constraints,
    acceptanceCriteria: content.acceptanceCriteria,
    requiredEvidence: content.requiredEvidence,
    forbiddenOutcomes: content.forbiddenOutcomes,
    authorityScope: content.authorizedWorkspace,
    maxRetries: content.budgets.maxRetries,
  });
}
