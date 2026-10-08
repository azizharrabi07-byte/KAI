// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Plan Mode's structured artifact — a mission that does not run.
 *
 * A plan is a DRAFT mission: ordered steps with kinds (`tool` / `agent` /
 * `manual`), created by the MODEL from a goal (structured output, validated
 * here) or by hand, persisted in the mission store, viewable, and started only
 * by an explicit approval (`POST /missions/:id/start`). Creating a plan
 * executes nothing — the executor only runs started missions — which is what
 * makes "plan, then approve, then work" a real mode boundary rather than a
 * label on the composer.
 *
 * Validation at plan time: step kinds must be known, titles non-empty, tool
 * targets must name a REGISTERED tool, agent steps must name a known subagent
 * or worker. A plan that fails validation is refused, never stored half-built.
 * Execution-time policy still applies per step when the mission runs.
 */

import { createMission, type MissionStepInput } from "../missions/mission.ts";
import type { Mission } from "../shared/contracts.ts";
import type { ModelProvider } from "../model/types.ts";
import type { ToolRegistry } from "../tools/registry.ts";

export interface PlanStepDraft {
  title: string;
  kind: "tool" | "agent" | "manual";
  target?: string;
  detail?: string;
  /** Arguments the tool step runs with (e.g. a search step's `{query}`). */
  input?: Record<string, unknown>;
}

export interface PlanDraft {
  title: string;
  steps: PlanStepDraft[];
}

const STEP_KINDS: readonly string[] = ["tool", "agent", "manual"];

/** How many steps one plan may hold: enough for real work, bounded for review. */
export const MAX_PLAN_STEPS = 12;

export const PLAN_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "Short plan title." },
    steps: {
      type: "array",
      description: "Ordered steps. tool steps name a KAI tool id; agent steps name a subagent or worker.",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          kind: { type: "string", enum: ["tool", "agent", "manual"] },
          target: { type: "string" },
          detail: { type: "string" },
          input: { type: "object", description: "Arguments the tool step runs with." },
        },
        required: ["title", "kind"],
        additionalProperties: false,
      },
    },
  },
  required: ["title", "steps"],
  additionalProperties: false,
} as const;

export function buildPlanPrompt(goal: string, toolIds: string[], agentIds: string[]): string {
  return [
    "You are KAI's planner. Produce a plan, not prose and not actions.",
    "Rules:",
    "- Investigate with READ tools only in your reasoning; the plan itself executes nothing.",
    "- 1-12 ordered steps. Each step: title, kind (tool|agent|manual), and a target.",
    "- kind=tool: target MUST be one of the tool ids below.",
    "- kind=tool: include `input` with the arguments the tool needs to run unattended (a search step needs its `query`; a step without usable input cannot run).",
    "- kind=agent: target MUST be one of the agent ids below (a subagent or worker).",
    "- kind=manual: no target; the human does it.",
    "- Prefer few precise steps over many vague ones.",
    `Tools: ${toolIds.length > 0 ? toolIds.join(", ") : "(none)"}`,
    `Agents: ${agentIds.length > 0 ? agentIds.join(", ") : "(none — use kind=manual instead of inventing one)"}`,
    `Goal: ${goal}`,
  ].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Transport tolerance for model output: strip code fences and prose around
 * the JSON object. Validation AFTER extraction stays strict — this only
 * finds the object, it never repairs one.
 */
export function extractJson(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return text;
  return candidate.slice(start, end + 1);
}

/**
 * Parse + validate a model-produced plan draft. A refusal names the defect.
 * `fallbackTitle` (the goal) titles the plan when the model returns steps
 * without one — the steps are the plan, the title is a label.
 */
export function parsePlanDraft(
  text: string,
  fallbackTitle?: string,
): { ok: true; value: PlanDraft } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(text)) as unknown;
  } catch {
    return { ok: false, reason: "the plan was not valid JSON" };
  }
  if (!isRecord(parsed)) return { ok: false, reason: "the plan must be a JSON object" };
  const fallback = typeof fallbackTitle === "string" && fallbackTitle.trim().length > 0 ? fallbackTitle.trim() : "Untitled plan";
  const title =
    typeof parsed["title"] === "string" && parsed["title"].trim().length > 0 ? parsed["title"].trim() : fallback;
  if (!Array.isArray(parsed["steps"]) || parsed["steps"].length === 0) {
    return { ok: false, reason: "the plan needs at least one step" };
  }
  if (parsed["steps"].length > MAX_PLAN_STEPS) {
    return { ok: false, reason: `the plan holds at most ${MAX_PLAN_STEPS} steps` };
  }
  const steps: PlanStepDraft[] = [];
  for (let i = 0; i < parsed["steps"].length; i += 1) {
    const raw = parsed["steps"][i];
    if (!isRecord(raw)) return { ok: false, reason: `step ${i} must be an object` };
    if (typeof raw["title"] !== "string" || raw["title"].trim().length === 0) {
      return { ok: false, reason: `step ${i} needs a non-empty title` };
    }
    if (typeof raw["kind"] !== "string" || !STEP_KINDS.includes(raw["kind"])) {
      return { ok: false, reason: `step ${i} kind must be one of ${STEP_KINDS.join(", ")}` };
    }
    const step: PlanStepDraft = { title: raw["title"].trim(), kind: raw["kind"] as PlanStepDraft["kind"] };
    if (raw["target"] !== undefined) {
      if (typeof raw["target"] !== "string" || raw["target"].trim().length === 0) {
        return { ok: false, reason: `step ${i} target must be a non-empty string when present` };
      }
      step.target = raw["target"].trim();
    }
    if (raw["detail"] !== undefined) {
      if (typeof raw["detail"] !== "string") return { ok: false, reason: `step ${i} detail must be a string when present` };
      step.detail = raw["detail"];
    }
    if (raw["input"] !== undefined) {
      if (!isRecord(raw["input"])) return { ok: false, reason: `step ${i} input must be an object when present` };
      if (JSON.stringify(raw["input"]).length > 4096) {
        return { ok: false, reason: `step ${i} input is too large (4k cap)` };
      }
      step.input = raw["input"];
    }
    if ((step.kind === "tool" || step.kind === "agent") && step.target === undefined) {
      return { ok: false, reason: `step ${i} (${step.kind}) must name its target` };
    }
    steps.push(step);
  }
  return { ok: true, value: { title, steps } };
}

export interface PlanDeps {
  model: ModelProvider;
  tools: ToolRegistry;
  /** Subagent spec ids + worker ids a plan may target. */
  agentIds: string[];
  upsertMission(mission: Mission): void;
  publish?(type: "mission.created", payload: { title: string; steps: number; plan: true }, opts?: { missionId?: string }): void;
}

/**
 * Generate a plan from a goal with the REAL model (structured output), validate
 * every step against the live registries, and persist it as a DRAFT mission
 * that runs nothing. Returns the stored mission.
 */
export async function createPlan(
  goal: string,
  deps: PlanDeps,
): Promise<{ ok: true; mission: Mission } | { ok: false; reason: string }> {
  const trimmed = goal.trim();
  if (trimmed.length === 0) return { ok: false, reason: "a plan needs a non-empty goal" };
  if (trimmed.length > 2000) return { ok: false, reason: "the goal is too long (2000 chars)" };
  const toolIds = deps.tools.list().map((tool) => tool.id);

  /**
   * One draft from the model. Structured output first; when the endpoint
   * answers it with nothing usable (measured: this gateway 200s an EMPTY
   * content for `json_schema`), the SAME prompt goes back as a plain chat
   * turn demanding only the object. Either way the text faces the strict
   * validator — the fallback changes transport, never the bar.
   */
  async function draftText(prompt: string): Promise<string> {
    try {
      const structured = await deps.model.structured({
        messages: [{ role: "user", content: prompt }],
        schemaName: "kai_plan",
        schema: PLAN_SCHEMA,
        parse: (raw) => raw,
        // 8000, not 2000: measured live, a reasoning model fills a small
        // budget with chain-of-thought and stops with `finish: length` before
        // any content — the plan then parses as empty. The budget buys the
        // reasoning AND the object.
        maxTokens: 8000,
        purpose: "plan_mode",
      });
      if (typeof structured.value === "string" && extractJson(structured.value).length > 2) {
        return structured.value;
      }
    } catch {
      // Fall through to the plain turn below.
    }
    const chat = await deps.model.chat({
      messages: [{ role: "user", content: `${prompt}\n\nReturn ONLY the JSON object — no prose, no fences.` }],
      maxTokens: 8000,
      purpose: "plan_mode",
    });
    return chat.text;
  }

  // Ask, then (at most once more) show the model its EXACT refusal and ask
  // for the corrected object. Validation after each attempt stays strict; a
  // second refusal fails the plan.
  let prompt = buildPlanPrompt(trimmed, toolIds, deps.agentIds);
  let lastRefusal = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let text: string;
    try {
      text = await draftText(prompt);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: `the planner is unavailable: ${detail}` };
    }
    const draft = parsePlanDraft(text, trimmed);
    if (draft.ok) {
      return finishDraft(draft.value, trimmed, deps);
    }
    lastRefusal = draft.reason;
    prompt =
      `${buildPlanPrompt(trimmed, toolIds, deps.agentIds)}\n\n` +
      `Your previous draft was REFUSED (${draft.reason}). Return ONLY the corrected JSON object — ` +
      `kind is exactly one of: tool, agent, manual.`;
  }
  return { ok: false, reason: lastRefusal };
}

/** Validate targets against the live registries and persist the DRAFT. */
function finishDraft(
  draft: PlanDraft,
  trimmed: string,
  deps: PlanDeps,
): { ok: true; mission: Mission } | { ok: false; reason: string } {
  // Targets must exist NOW: a plan naming an unknown tool or agent is refused,
  // not stored as a surprise for execution day.
  for (let i = 0; i < draft.steps.length; i += 1) {
    const step = draft.steps[i]!;
    if (step.kind === "tool" && deps.tools.get(step.target ?? "") === undefined) {
      return { ok: false, reason: `step ${i} names unknown tool "${step.target}"` };
    }
    if (step.kind === "agent" && !deps.agentIds.includes(step.target ?? "")) {
      return { ok: false, reason: `step ${i} names unknown agent "${step.target}"` };
    }
  }
  const inputs: MissionStepInput[] = draft.steps.map((step) => ({
    title: step.detail !== undefined ? `${step.title} — ${step.detail}` : step.title,
    kind: step.kind,
    ...(step.target !== undefined ? { target: step.target } : {}),
    ...(step.input !== undefined ? { input: step.input } : {}),
  }));
  const mission = createMission({
    title: draft.title,
    description: `Plan for: ${trimmed}`,
    steps: inputs,
    metadata: { plan: true, goal: trimmed },
  });
  deps.upsertMission(mission);
  deps.publish?.("mission.created", { title: mission.title, steps: mission.steps.length, plan: true }, { missionId: mission.id });
  return { ok: true, mission };
}
