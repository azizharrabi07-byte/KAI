// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Skill learning loop — propose candidates from task outcomes, stage them
 * through validation, and feed measured usage back into SkillMetrics.
 *
 * Vocabulary is FROZEN in `types.ts` (SkillMetrics); storage is FROZEN in
 * `shared/contracts.ts` (SkillMetricsStore). The staging/validation port is
 * injected: the runtime wires the real skillStaging module; tests inject fakes.
 *
 * Proposal triggers (at least one must hold, otherwise null):
 * - success pattern: >=3 steps, verified, no corrections;
 * - correction pattern: >=1 correction with a clear before/after;
 * - recovery pattern: a failure step followed by success (flag or step evidence).
 * Never proposes when the outcome failed outright or when steps < 2.
 */

import type { SkillMetricsStore } from "../shared/contracts.ts";

export interface LearningStep {
  label: string;
  status?: string;
}

export interface TaskCorrection {
  before: string;
  after: string;
}

export interface TaskOutcome {
  success: boolean;
  verified: boolean;
  corrections: TaskCorrection[];
  /** Explicit failure-then-success signal; step statuses are checked too. */
  recovered?: boolean;
}

export interface ProposeInput {
  taskId: string;
  objective: string;
  steps: LearningStep[];
  outcome: TaskOutcome;
  existingSkillIds: string[];
}

export type SkillPattern = "success" | "correction" | "recovery";

export interface SkillCandidate {
  title: string;
  trigger: string;
  method: string;
  tools: string[];
  constraints: string[];
  sourceTaskId: string;
  consideredSkillIds: string[];
  pattern: SkillPattern;
}

export interface StageInput {
  id: string;
  markdown: string;
}

export type StageCheck = { ok: boolean; reason?: string };

export interface LearningDeps {
  metrics: SkillMetricsStore;
  /** Injected staging port (runtime wires real skillStaging). */
  stage: (input: StageInput) => StageCheck;
  validate: (markdown: string) => StageCheck;
}

export type SubmitResult = { ok: true; stagedId: string } | { ok: false; refused: true; reason: string };

export interface SkillUsage {
  success?: boolean;
  verified?: boolean;
  failed?: boolean;
  corrected?: boolean;
  tokens?: number;
}

const FAILURE_TOKENS = ["failed", "error", "blocked", "failure"];
const SUCCESS_TOKENS = ["completed", "ok", "success", "done", "passed"];

function statusOf(step: LearningStep): string {
  return (step.status ?? "").trim().toLowerCase();
}

/** True when a failure-status step precedes a success-status step. */
export function failedThenSucceeded(steps: LearningStep[]): boolean {
  let seenFailure = false;
  for (const step of steps) {
    const status = statusOf(step);
    if (!seenFailure && FAILURE_TOKENS.some((t) => status.includes(t))) seenFailure = true;
    else if (seenFailure && SUCCESS_TOKENS.some((t) => status.includes(t))) return true;
  }
  return false;
}

export function clearCorrections(corrections: TaskCorrection[]): TaskCorrection[] {
  return corrections.filter(
    (c) => c.before.trim().length > 0 && c.after.trim().length > 0 && c.before !== c.after,
  );
}

function clip(text: string, max: number): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "skill";
}

function buildCandidate(input: ProposeInput, pattern: SkillPattern): SkillCandidate {
  const title = `Skill: ${clip(input.objective, 64)}`;
  const method = input.steps.map((s) => `- ${s.label}`).join("\n");
  const constraints: string[] =
    pattern === "correction"
      ? clearCorrections(input.outcome.corrections).map((c) => `Avoid "${c.before}" — prefer "${c.after}"`)
      : pattern === "recovery"
        ? ["Recover from the failed step before retrying — do not repeat the failing action unchanged"]
        : ["Verified pattern — keep the verification step when reusing"];
  return {
    title,
    trigger: `Tasks like: ${clip(input.objective, 120)}`,
    method,
    tools: [],
    constraints,
    sourceTaskId: input.taskId,
    consideredSkillIds: [...input.existingSkillIds],
    pattern,
  };
}

export interface SkillLearning {
  proposeFromTask(input: ProposeInput): SkillCandidate | null;
  submitProposal(candidate: SkillCandidate, markdown: string): SubmitResult;
  recordSkillUsage(skillId: string, usage: SkillUsage): void;
  versionNote(skillId: string, change: string): string;
}

export function createLearning(deps: LearningDeps): SkillLearning {
  function proposeFromTask(input: ProposeInput): SkillCandidate | null {
    if (input.steps.length < 2) return null;
    if (!input.outcome.success) return null;
    const clear = clearCorrections(input.outcome.corrections);
    if (clear.length > 0) return buildCandidate(input, "correction");
    if (input.outcome.recovered === true || failedThenSucceeded(input.steps)) {
      return buildCandidate(input, "recovery");
    }
    if (input.steps.length >= 3 && input.outcome.verified) return buildCandidate(input, "success");
    return null;
  }

  function submitProposal(candidate: SkillCandidate, markdown: string): SubmitResult {
    const checked = deps.validate(markdown);
    if (!checked.ok) return { ok: false, refused: true, reason: checked.reason ?? "validation failed" };
    const id = slugify(candidate.title);
    const staged = deps.stage({ id, markdown });
    if (!staged.ok) return { ok: false, refused: true, reason: staged.reason ?? "staging refused" };
    return { ok: true, stagedId: id };
  }

  function recordSkillUsage(skillId: string, usage: SkillUsage): void {
    const now = new Date().toISOString();
    const current = deps.metrics.get(skillId);
    deps.metrics.upsert({
      skillId,
      triggers: (current?.triggers ?? 0) + 1,
      successes: (current?.successes ?? 0) + (usage.success === true ? 1 : 0),
      verifications: (current?.verifications ?? 0) + (usage.verified === true ? 1 : 0),
      failures: (current?.failures ?? 0) + (usage.failed === true ? 1 : 0),
      corrections: (current?.corrections ?? 0) + (usage.corrected === true ? 1 : 0),
      tokensUsed: (current?.tokensUsed ?? 0) + (usage.tokens ?? 0),
      updatedAt: now,
    });
  }

  /**
   * Draft markdown for updating an existing skill. The baseSkillId line keeps
   * lineage so staging/review can link the update to the skill it supersedes.
   */
  function versionNote(skillId: string, change: string): string {
    return `# Skill update\n\nbaseSkillId: ${skillId}\n\n## Change\n\n${change.trim()}\n`;
  }

  return { proposeFromTask, submitProposal, recordSkillUsage, versionNote };
}
