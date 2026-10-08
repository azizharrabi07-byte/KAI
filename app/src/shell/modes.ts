// KAI's working modes — Ask / Plan / Work — real state, not a visual toggle.
//
// The design shipped a three-segment control that only moved a highlight. This
// module is the reason the control now changes BEHAVIOUR:
//
//   * the mode is a persisted choice (`kai.mode`), shared across KAI windows;
//   * `Plan` turns a task into a structured plan the person approves before any
//     work runs; `Work` carries the task through as a real Core mission that
//     executes with live progress; `Ask` is an ordinary chat turn;
//   * the plan and the live progress are derived from REAL Core mission records
//     (`CoreMissionSummary`, `CoreMissionStep`), never invented.
//
// The pure helpers below (plan building, progress derivation, status mapping)
// are DOM-free and tested with no browser and no Core.

import type { CoreMissionStep, CoreMissionSummary } from "../core/kai-core";

export type ModeId = "ask" | "plan" | "work";

export const MODE_ORDER: readonly ModeId[] = ["ask", "plan", "work"];

export const MODE_LABELS: Record<ModeId, string> = {
  ask: "Ask",
  plan: "Plan",
  work: "Work",
};

/** What each mode means, shown as a hint in the palette/composer. */
export const MODE_BLURBS: Record<ModeId, string> = {
  ask: "Talk with KAI. One turn at a time.",
  plan: "KAI proposes a plan you approve before it runs.",
  work: "KAI carries the task out as a mission, with live progress.",
};

export const MODE_STORAGE_KEY = "kai.mode";

export function isModeId(value: unknown): value is ModeId {
  return value === "ask" || value === "plan" || value === "work";
}

export function parseMode(value: string | null | undefined): ModeId {
  return isModeId(value) ? value : "ask";
}

export function readMode(): ModeId {
  try {
    if (typeof localStorage === "undefined") return "ask";
    return parseMode(localStorage.getItem(MODE_STORAGE_KEY));
  } catch {
    return "ask";
  }
}

export function writeMode(mode: ModeId): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(MODE_STORAGE_KEY, mode);
  } catch {
    /* storage may be blocked; the in-memory mode still applies */
  }
}

// ── The plan ──────────────────────────────────────────────────────────────────

/** One step of a proposed plan. Shaped as Core's `MissionStepInput` accepts. */
export interface PlanStep {
  title: string;
  kind: "tool" | "agent" | "manual";
  /** For a `tool`/`agent` step: the tool id or the worker/agent id. */
  target?: string;
  /** Free text handed to an agent step. */
  input?: Record<string, unknown>;
}

/** A plan: the goal plus the ordered steps the person approves. */
export interface Plan {
  goal: string;
  steps: PlanStep[];
  /** The worker every agent step runs on. */
  workerId: string;
}

/**
 * Turn a task into a structured plan.
 *
 * The decomposition is fixed and honest: research, implement, verify, report.
 * It is a PROPOSAL the person edits/approves — it is not presented as Core state
 * until the mission is actually created. The first two steps run on the chosen
 * worker (real execution, gated by Core's own approval policy); the last two are
 * reported rather than automated, which is exactly how Core treats a `manual`
 * step. No timer, no animation, nothing invented.
 */
export function buildPlan(goal: string, workerId = "hermes"): Plan {
  const g = goal.trim();
  return {
    goal: g,
    workerId,
    steps: [
      { title: `Research — ${g}`, kind: "agent", target: workerId, input: { input: `Research: ${g}` } },
      { title: `Implement — ${g}`, kind: "agent", target: workerId, input: { input: `Implement: ${g}` } },
      { title: `Verify — ${g}`, kind: "manual" },
      { title: "Report results", kind: "manual" },
    ],
  };
}

/**
 * A single-step mission for Work mode: the task itself, run by the worker, with a
 * manual report step. Fewer approval gates than the research-style plan because
 * Work means "do it", not "study it".
 */
export function buildWorkSteps(goal: string, workerId = "hermes"): PlanStep[] {
  const g = goal.trim();
  return [
    { title: g, kind: "agent", target: workerId, input: { input: g } },
    { title: "Report results", kind: "manual" },
  ];
}

// ── Live progress, derived from real Core mission state ────────────────────────

/** The four states the mission UI shows, mapped from Core's own statuses. */
export type StepViewStatus = "PENDING" | "RUNNING" | "COMPLETE" | "FAILED" | "BLOCKED";

/** Core's step/mission status → the UI's step vocabulary. Never guesses. */
export function stepViewStatus(coreStatus: string): StepViewStatus {
  switch (coreStatus) {
    case "COMPLETED":
    case "SKIPPED":
      return "COMPLETE";
    case "RUNNING":
      return "RUNNING";
    case "FAILED":
      return "FAILED";
    case "WAITING_APPROVAL":
      return "BLOCKED";
    default:
      return "PENDING";
  }
}

export interface MissionProgress {
  /** Steps reported complete (COMPLETED or SKIPPED). */
  done: number;
  total: number;
  /** The step being worked on now, if any. */
  current: CoreMissionStep | null;
  /** True when the mission is blocked on a human decision. */
  needsApproval: boolean;
  /** Core's mission status, verbatim. */
  status: string;
  /** Steps that failed, if any. */
  failed: CoreMissionStep[];
}

export function missionProgress(mission: CoreMissionSummary): MissionProgress {
  const steps = mission.steps ?? [];
  const done = steps.filter((s) => s.status === "COMPLETED" || s.status === "SKIPPED").length;
  const current = steps.find((s) => s.status === "RUNNING" || s.status === "WAITING_APPROVAL") ?? null;
  return {
    done,
    total: steps.length,
    current,
    needsApproval: mission.status === "WAITING_APPROVAL" || steps.some((s) => s.status === "WAITING_APPROVAL"),
    status: mission.status,
    failed: steps.filter((s) => s.status === "FAILED"),
  };
}

/** A mission is "live" while it can still make progress. */
export function isLiveMission(mission: CoreMissionSummary): boolean {
  return mission.status !== "COMPLETED" && mission.status !== "FAILED" && mission.status !== "CANCELLED";
}

/** Pick the mission the Work view should show: the latest live one, else latest. */
export function pickActiveMission(missions: readonly CoreMissionSummary[]): CoreMissionSummary | null {
  if (missions.length === 0) return null;
  const live = missions.filter(isLiveMission);
  const pool = live.length > 0 ? live : missions;
  // missions arrive newest-first from Core; fall back to updatedAt ordering.
  return [...pool].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0] ?? null;
}
