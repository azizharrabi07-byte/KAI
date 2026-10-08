// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Worker prompt engine + prompt-pattern library.
 *
 * A worker prompt is built ONLY from the declared {@link WorkerPromptInput}
 * fields — raw conversation history is never accepted and therefore never
 * forwarded. Every user-supplied string passes through the canonical
 * redaction boundary (`redactText`) before it reaches the prompt.
 *
 * The pattern library rides the frozen `PromptPatternStore` (shared
 * contracts): measured prompt strategies with uses/successes counters.
 * `selectPattern` picks the best successes/uses ratio (min 1 use);
 * `recordPatternOutcome` advances the counters from verified outcomes only.
 */

import { redactText } from "../redact/index.ts";
import type { PromptPatternRecord, PromptPatternStore } from "../shared/contracts.ts";

/** Max characters of joined CONTEXT content embedded in a worker prompt. */
export const CONTEXT_CHAR_CAP = 2000;

const TRUNCATION_NOTE = "…[context truncated to 2000 chars]";

/**
 * The ONLY fields a worker prompt may be built from. There is deliberately no
 * `history` / `transcript` / `messages` field: callers cannot forward raw
 * conversation history because there is nowhere to put it.
 */
export interface WorkerPromptInput {
  mission: string;
  role: string;
  whySelected: string;
  objective: string;
  context: string[];
  knownState: string[];
  previousAttempts: string[];
  constraints: string[];
  scope: string;
  requiredOutput: string;
  successCriteria: string[];
  verification: string[];
  budget?: string;
  handoffFormat: string;
  skillContext?: string;
}

/** Section headings in render order. Exported so tests pin the contract. */
export const WORKER_PROMPT_SECTIONS = [
  "MISSION",
  "YOUR ROLE",
  "CURRENT OBJECTIVE",
  "CONTEXT",
  "KNOWN STATE",
  "PREVIOUS ATTEMPTS",
  "CONSTRAINTS",
  "ALLOWED SCOPE",
  "REQUIRED OUTPUT",
  "SUCCESS CRITERIA",
  "VERIFICATION",
  "BUDGET",
  "HANDOFF FORMAT",
] as const;

function clean(value: string): string {
  return redactText(value);
}

function renderList(items: string[]): string {
  if (items.length === 0) return "(none)";
  return items.map((item) => `- ${clean(item)}`).join("\n");
}

function renderContext(items: string[]): string {
  if (items.length === 0) return "(none)";
  const joined = items.map((item) => clean(item)).join("\n");
  const capped =
    joined.length > CONTEXT_CHAR_CAP
      ? `${joined.slice(0, CONTEXT_CHAR_CAP)}\n${TRUNCATION_NOTE}`
      : joined;
  return capped
    .split("\n")
    .map((line) => `- ${line}`)
    .join("\n");
}

/**
 * Build the worker prompt. Sections appear in {@link WORKER_PROMPT_SECTIONS}
 * order; CONTEXT content is capped at {@link CONTEXT_CHAR_CAP} characters;
 * every field is redacted via `redactText`.
 */
export function buildWorkerPrompt(input: WorkerPromptInput): string {
  const bodies: Record<(typeof WORKER_PROMPT_SECTIONS)[number], string> = {
    MISSION: clean(input.mission),
    "YOUR ROLE": `Role: ${clean(input.role)}\nSelected because: ${clean(input.whySelected)}`,
    "CURRENT OBJECTIVE": clean(input.objective),
    CONTEXT: renderContext(input.context),
    "KNOWN STATE": renderList(input.knownState),
    "PREVIOUS ATTEMPTS": renderList(input.previousAttempts),
    CONSTRAINTS: renderList(input.constraints),
    "ALLOWED SCOPE": clean(input.scope),
    "REQUIRED OUTPUT": clean(input.requiredOutput),
    "SUCCESS CRITERIA": renderList(input.successCriteria),
    VERIFICATION: renderList(input.verification),
    BUDGET: input.budget !== undefined ? clean(input.budget) : "(none)",
    "HANDOFF FORMAT": clean(input.handoffFormat),
  };

  const parts = WORKER_PROMPT_SECTIONS.map(
    (title) => `## ${title}\n${bodies[title]}`,
  );

  if (input.skillContext !== undefined && input.skillContext.trim().length > 0) {
    parts.push(`## SKILL CONTEXT\n${clean(input.skillContext)}`);
  }

  return parts.join("\n\n");
}

// ── Pattern library ─────────────────────────────────────────────────────────

export interface CreatePatternInput {
  taskType: string;
  template: string;
  requiredFields?: string[];
  failureModes?: string[];
  verification?: string[];
  id?: string;
}

function newPatternId(): string {
  return `pat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Create a pattern (uses=0, successes=0) and persist it via the store. */
export function createPattern(
  store: PromptPatternStore,
  input: CreatePatternInput,
): PromptPatternRecord {
  const record: PromptPatternRecord = {
    id: input.id ?? newPatternId(),
    taskType: input.taskType,
    template: input.template,
    requiredFields: [...(input.requiredFields ?? [])],
    failureModes: [...(input.failureModes ?? [])],
    verification: [...(input.verification ?? [])],
    version: 1,
    uses: 0,
    successes: 0,
    updatedAt: new Date().toISOString(),
  };
  store.upsert(record);
  return record;
}

/**
 * Select the best pattern for a task type: highest successes/uses ratio,
 * considering only patterns with at least 1 use. Ties break toward more
 * successes, then more uses, then lexicographically smallest id.
 * Returns null when nothing qualifies.
 */
export function selectPattern(
  store: PromptPatternStore,
  taskType: string,
): PromptPatternRecord | null {
  const candidates = store.list(taskType).filter((p) => p.uses >= 1);
  if (candidates.length === 0) return null;
  const ratio = (p: PromptPatternRecord): number =>
    p.uses > 0 ? p.successes / p.uses : Number.NEGATIVE_INFINITY;
  const sorted = [...candidates].sort((a, b) => {
    const dr = ratio(b) - ratio(a);
    if (dr !== 0) return dr;
    if (b.successes !== a.successes) return b.successes - a.successes;
    if (b.uses !== a.uses) return b.uses - a.uses;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const best = sorted[0];
  if (best === undefined) return null;
  return best;
}

/**
 * Record a verified outcome: uses+1 always, successes+1 on success.
 * Throws when the id is unknown — counters must come from real patterns.
 */
export function recordPatternOutcome(
  store: PromptPatternStore,
  id: string,
  success: boolean,
): PromptPatternRecord {
  const existing = store.get(id);
  if (existing === null) {
    throw new Error(`unknown prompt pattern: ${id}`);
  }
  const updated: PromptPatternRecord = {
    ...existing,
    uses: existing.uses + 1,
    successes: existing.successes + (success ? 1 : 0),
    updatedAt: new Date().toISOString(),
  };
  store.upsert(updated);
  return updated;
}
