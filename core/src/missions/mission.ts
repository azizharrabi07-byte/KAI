// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * KAI mission model and pure helpers.
 *
 * A mission is an ordered list of steps plus an explicit, persisted status.
 * Nothing here executes anything: this module only builds the shape and answers
 * "what is the next step that still needs work?" so the executor stays small.
 *
 * Shapes come from `shared/contracts.ts` (frozen). We add ids and timestamps
 * through injectable `now`/`idFactory` so tests can be deterministic.
 */

import type { KaiEventType, Mission, MissionStep } from "../shared/contracts.ts";

/** Publisher shape the executor and mission factory accept by injection. */
export type Publish = (
  type: KaiEventType,
  payload: unknown,
  opts?: { source?: string; missionId?: string; stepId?: string },
) => void;

export interface MissionStepInput {
  title: string;
  kind: "tool" | "agent" | "manual";
  target?: string;
  input?: Record<string, unknown>;
  sideEffecting?: boolean;
}

export interface CreateMissionInput {
  title: string;
  description?: string;
  steps?: MissionStepInput[];
  priority?: number;
  metadata?: Record<string, unknown>;
}

/** Optional production/test seams. The required call signature stays `(input)`. */
export interface MissionDeps {
  now?: () => Date;
  idFactory?: () => string;
  publish?: Publish;
}

const TERMINAL_MISSION: readonly string[] = ["COMPLETED", "FAILED", "CANCELLED"];
/** Step statuses that mean "no work remains on this step". */
const DONE_STEP: readonly string[] = ["COMPLETED", "SKIPPED"];

let missionSeq = 0;
function defaultIdFactory(): string {
  return `mission_${Date.now().toString(36)}_${(missionSeq++).toString(36)}`;
}

/** Step ids are derived from the mission id + index: deterministic, no collision. */
function stepIdFor(missionId: string, index: number): string {
  return `step_${missionId}_${index}`;
}

export function isTerminalMissionStatus(status: Mission["status"]): boolean {
  return TERMINAL_MISSION.includes(status);
}

export function sortSteps(mission: Mission): MissionStep[] {
  return [...mission.steps].sort((a, b) => a.index - b.index);
}

function buildStep(
  mission: Mission,
  input: MissionStepInput,
  index: number,
): MissionStep {
  const step: MissionStep = {
    id: stepIdFor(mission.id, index),
    missionId: mission.id,
    index,
    title: input.title,
    kind: input.kind,
    status: "PENDING",
    sideEffecting: input.sideEffecting === true,
  };
  if (input.target !== undefined) step.target = input.target;
  if (input.input !== undefined) step.input = { ...input.input };
  return step;
}

/**
 * Create a DRAFT mission. Creating it does NOT queue or run it — `start()` does
 * that, so every lifecycle transition is explicit and persists on its own.
 * Passing `publish` emits `mission.created`; without one, creation is silent.
 */
export function createMission(input: CreateMissionInput, deps?: MissionDeps): Mission {
  const now = deps?.now ?? (() => new Date());
  const idFactory = deps?.idFactory ?? defaultIdFactory;
  const ts = now().toISOString();

  const mission: Mission = {
    id: idFactory(),
    title: input.title,
    status: "DRAFT",
    priority: input.priority ?? 0,
    createdAt: ts,
    updatedAt: ts,
    steps: [],
  };
  if (input.description !== undefined) mission.description = input.description;
  if (input.metadata !== undefined) mission.metadata = { ...input.metadata };

  for (const stepInput of input.steps ?? []) {
    mission.steps.push(buildStep(mission, stepInput, mission.steps.length));
  }

  deps?.publish?.("mission.created", snapshot(mission), {
    source: `mission:${mission.id}`,
    missionId: mission.id,
  });
  return mission;
}

/** Append a step (next index). Mutates and returns the same mission. */
export function addStep(mission: Mission, input: MissionStepInput): Mission {
  const nextIndex =
    mission.steps.length === 0
      ? 0
      : Math.max(...mission.steps.map((s) => s.index)) + 1;
  mission.steps.push(buildStep(mission, input, nextIndex));
  return mission;
}

/**
 * The next step the executor should look at: the lowest-index step that is not
 * already done or permanently failed. `null` means nothing is left to consider
 * (which is NOT the same as "the mission is complete" — a SKIPPED step also
 * returns null). WAITING_APPROVAL is excluded: that step is with a human.
 */
export function nextRunnableStep(mission: Mission): MissionStep | null {
  for (const step of sortSteps(mission)) {
    if (DONE_STEP.includes(step.status)) continue;
    if (step.status === "FAILED" || step.status === "WAITING_APPROVAL") continue;
    return step;
  }
  return null;
}

/** Remaining work: steps that are neither COMPLETED nor SKIPPED. */
export function remainingSteps(mission: Mission): MissionStep[] {
  return sortSteps(mission).filter((s) => !DONE_STEP.includes(s.status));
}

export function allStepsCompleted(mission: Mission): boolean {
  return mission.steps.every((s) => s.status === "COMPLETED");
}

/** Plain-object copy, so a published event cannot be mutated by later steps. */
export function snapshot(mission: Mission): Mission {
  return {
    ...mission,
    steps: mission.steps.map((s) => ({ ...s })),
  };
}
