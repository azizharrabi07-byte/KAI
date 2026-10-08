// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The autonomous loop — KAI evaluating a result and deciding what happens next.
 *
 * The architecture audit's headline finding (`docs/architecture-audit.md` §2
 * verdict 1, §5 gap 1) was that no loop anywhere re-invoked a model or worker
 * after evaluating a result: the mission executor runs a PRE-DECLARED step list
 * once, in fixed order, and a failure simply ends the mission. "KAI is the main
 * agent" cannot be true of a control plane that only ever executes what it was
 * handed.
 *
 * This module is that loop, deliberately small and bounded:
 *
 *     a mission settles FAILED
 *       → KAI evaluates the failure
 *       → the failure is TRANSIENT  and attempts remain  → KAI re-plans: it
 *         starts a NEW mission that supersedes the old one
 *       → otherwise                                      → KAI stops and tells
 *         the human, because a human is what is actually needed
 *
 * Three properties make it safe rather than clever:
 *
 *   1. **Bounded.** `maxAttempts` (default 1) caps the automatic re-attempts for
 *      a mission CHAIN. The attempt number lives in the mission's own metadata,
 *      so a crash cannot reset the budget — a restarted Core reads it back.
 *
 *   2. **It never overrides a human.** POLICY_DENIED, APPROVAL_REQUIRED,
 *      VALIDATION_FAILED, NOT_FOUND and a missing capability are NOT retryable:
 *      retrying those is a way of ignoring an answer KAI was already given. Only
 *      transient failures (a timeout, an unreachable agent, an upstream that
 *      broke) are retried.
 *
 *   3. **It is auditable.** Every decision is recorded and every decision is
 *      published: a retry is visible as a new mission carrying `supersedes`, and
 *      a stop is visible as a notification. Nothing happens silently.
 *
 * It is a SUBSCRIBER on the existing bus, not a rewrite of the executor: the
 * mission lifecycle stays exactly as it was, and a Core with no supervisor
 * behaves identically.
 */

import type { KaiError, KaiErrorCode, Mission } from "../shared/contracts.ts";
import type { MissionStepInput } from "../missions/mission.ts";

/**
 * Failures that mean "try again could plausibly help".
 *
 * Deliberately ABSENT, each for a reason:
 *   - POLICY_DENIED        — a human or a rule said no; retrying is ignoring it
 *   - APPROVAL_REQUIRED    — the answer is a person, not another attempt
 *   - VALIDATION_FAILED    — the request itself is wrong; a retry sends it again
 *   - NOT_FOUND            — the tool/agent is not there; retrying finds nothing
 *   - AGENT_CAPABILITY_MISSING — the worker cannot do this, ever
 *   - AGENT_AUTH_FAILED    — a credential problem needs a person
 *   - AGENT_RUN_ABANDONED  — KAI itself stopped it (recovery refused a replay)
 */
export const TRANSIENT_ERROR_CODES: ReadonlySet<KaiErrorCode> = new Set<KaiErrorCode>([
  "AGENT_TIMEOUT",
  "AGENT_NOT_LISTENING",
  "AGENT_BAD_RESPONSE",
  "AGENT_RUN_FAILED",
  "INTERNAL",
  "STORAGE_FAILED",
]);

export interface AutonomyDecision {
  missionId: string;
  /** What KAI decided to do about the settled mission. */
  action: "retry" | "escalate" | "stop";
  /** 1-based attempt number the DECISION applies to. */
  attempt: number;
  reason: string;
  /** The mission KAI started as a result, when it retried. */
  retryMissionId?: string;
  at: string;
}

export interface AutonomyBounds {
  /**
   * Automatic RE-attempts allowed for one mission chain (so the default of 1
   * permits the original attempt plus ONE retry). 0 disables the loop entirely.
   */
  maxAttempts: number;
}

export interface MissionSupervisorOptions {
  getMission(id: string): Mission | null;
  /** Start the next attempt. The supervisor decides WHETHER; this does it. */
  startAttempt(input: {
    title: string;
    description?: string;
    steps?: MissionStepInput[];
    metadata: Record<string, unknown>;
  }): Promise<Mission>;
  /** Tell the human, when a human is what is needed. */
  notify(input: { title: string; message: string; missionId: string }): void;
  bounds?: AutonomyBounds;
  now?: () => Date;
  idFactory?: () => string;
}

export interface MissionSupervisor {
  /** The decision made about one settled mission (the loop's entry point). */
  observe(missionId: string): Promise<AutonomyDecision>;
  /** A copy of every decision made so far, newest last. */
  decisions(): AutonomyDecision[];
  bounds(): AutonomyBounds;
}

/** How many attempts this mission-chain has already used (1-based). */
export function attemptOf(mission: Mission): number {
  const raw = mission.metadata?.["autonomyAttempt"];
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1;
}

/** The root of the chain this mission belongs to. */
export function chainRoot(mission: Mission): string {
  const root = mission.metadata?.["supersedes"];
  return typeof root === "string" && root.length > 0 ? root : mission.id;
}

/**
 * A step list copied for a retry.
 *
 * The retry re-runs the SAME declared steps — KAI's plan is not silently
 * rewritten — but each step's terminal state is cleared, because "it failed
 * last time" is history, not an instruction.
 */
function stepsForRetry(mission: Mission): MissionStepInput[] | undefined {
  if (mission.steps === undefined || mission.steps.length === 0) return undefined;
  return mission.steps.map((step) => ({
    title: step.title,
    kind: step.kind,
    ...(step.target !== undefined ? { target: step.target } : {}),
    ...(step.input !== undefined ? { input: step.input } : {}),
    ...(step.sideEffecting !== undefined ? { sideEffecting: step.sideEffecting } : {}),
  }));
}

export function createMissionSupervisor(options: MissionSupervisorOptions): MissionSupervisor {
  const now = options.now ?? (() => new Date());
  const bounds: AutonomyBounds = { maxAttempts: options.bounds?.maxAttempts ?? 1 };
  const log: AutonomyDecision[] = [];

  function record(decision: AutonomyDecision): AutonomyDecision {
    log.push(decision);
    return decision;
  }

  async function observe(missionId: string): Promise<AutonomyDecision> {
    const at = now().toISOString();
    const mission = options.getMission(missionId);
    if (mission === null) {
      return record({ missionId, action: "stop", attempt: 0, reason: "no such mission; nothing to supervise", at });
    }
    if (mission.status !== "FAILED") {
      return record({
        missionId,
        action: "stop",
        attempt: attemptOf(mission),
        reason: `the mission is ${mission.status}, not FAILED; there is no failure to evaluate`,
        at,
      });
    }

    const error: KaiError | undefined = mission.error;
    const attempt = attemptOf(mission);

    if (error === undefined) {
      return record({ missionId, action: "escalate", attempt, reason: "the mission failed with no recorded error; a human must look", at });
    }
    if (!TRANSIENT_ERROR_CODES.has(error.code)) {
      return record({
        missionId,
        action: "stop",
        attempt,
        reason: `"${error.code}" is not transient, so retrying would ignore an answer KAI was already given: ${error.message}`,
        at,
      });
    }
    if (bounds.maxAttempts <= 0) {
      return record({ missionId, action: "stop", attempt, reason: "the autonomous loop is disabled (maxAttempts = 0)", at });
    }
    // `maxAttempts` counts RE-attempts, so attempt 1 has not spent any of them.
    const retriesUsed = attempt - 1;
    if (retriesUsed >= bounds.maxAttempts) {
      const reason =
        retriesUsed === 0
          ? `"${error.code}" is transient but the autonomous loop is at its bound of ${bounds.maxAttempts} re-attempt(s)`
          : `"${error.code}" is transient but the budget of ${bounds.maxAttempts} re-attempt(s) is spent after ${retriesUsed}`;
      options.notify({
        title: "KAI stopped retrying",
        message: `Mission "${mission.title}" failed ${attempt} time(s) with ${error.code}: ${error.message}. KAI is not retrying again — this needs you.`,
        missionId,
      });
      return record({ missionId, action: "escalate", attempt, reason, at });
    }

    const next = attempt + 1;
    const root = chainRoot(mission);
    const retry = await options.startAttempt({
      title: mission.title,
      ...(mission.description !== undefined ? { description: mission.description } : {}),
      ...(stepsForRetry(mission) !== undefined ? { steps: stepsForRetry(mission)! } : {}),
      metadata: {
        ...(mission.metadata ?? {}),
        autonomyAttempt: next,
        supersedes: root,
        autonomyRetryOf: mission.id,
        autonomyReason: `${error.code}: ${error.message}`,
      },
    });

    options.notify({
      title: "KAI is trying again",
      message: `Mission "${mission.title}" failed with ${error.code}; KAI started attempt ${next} of ${bounds.maxAttempts} (${retry.id}).`,
      missionId: retry.id,
    });

    return record({
      missionId,
      action: "retry",
      attempt: next,
      reason: `"${error.code}" is transient and attempt ${next} of ${bounds.maxAttempts} is available`,
      retryMissionId: retry.id,
      at,
    });
  }

  return {
    observe,
    decisions: () => log.map((d) => ({ ...d })),
    bounds: () => ({ ...bounds }),
  };
}
