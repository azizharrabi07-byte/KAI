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
  /**
   * Record a supervision lesson with provenance (mission-scoped memory).
   * Absent → verified in trace only. Never throws (the supervisor guards).
   */
  recordLesson?: (input: { scopeId: string; content: string; verified: string }) => { ok: boolean; refusal?: { reason?: string } };
  /**
   * Record durably that this settled mission has already been re-attempted, so
   * a duplicate `mission.failed` delivery (the executor can emit one more than
   * once for a mission, e.g. on recovery) or a Core restart cannot start a
   * SECOND re-attempt for the same failure. Absent → the supervisor still
   * bounds duplicates in-process. Must not throw.
   */
  markRetried?: (missionId: string) => void;
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
  /** Mission ids already re-attempted in this process (duplicate-delivery bound). */
  const retriedLocally = new Set<string>();

  function record(decision: AutonomyDecision): AutonomyDecision {
    log.push(decision);
    return decision;
  }

  async function observe(missionId: string): Promise<AutonomyDecision> {
    const at = now().toISOString();
    try {
      return await observeInner(missionId, at);
    } catch (error) {
      // A supervisor failure is itself recorded and notified — never swallowed
      // into silence (Phase 2A: failures visible in decisions + notification).
      const reason = `supervisor evaluation threw: ${error instanceof Error ? error.message : String(error)}`;
      try {
        options.notify({ title: "KAI supervision failed", message: `Mission "${missionId}": ${reason}`.slice(0, 500), missionId });
      } catch {
        // Notifying must never break the record.
      }
      return record({ missionId, action: "stop", attempt: 0, reason, at });
    }
  }

  /** Verify a COMPLETED mission's steps and record a provenanced lesson. */
  function superviseCompleted(mission: Mission, at: string): AutonomyDecision {
    const attempt = attemptOf(mission);
    const steps = mission.steps ?? [];
    const bad = steps.filter((step) => step.status !== "COMPLETED" && step.status !== "SKIPPED");
    if (bad.length > 0) {
      const reason = `mission is COMPLETED but ${bad.length} step(s) are not: ${bad.slice(0, 3).map((s) => `"${s.title}"=${s.status}`).join("; ")} — a human must look`;
      options.notify({ title: "KAI found an inconsistent mission", message: `Mission "${mission.title}": ${reason}`.slice(0, 500), missionId: mission.id });
      return record({ missionId: mission.id, action: "escalate", attempt, reason, at });
    }
    // Every step settled: record what was actually established as a
    // mission-scoped lesson with a verified basis — never a worker assertion.
    if (options.recordLesson !== undefined) {
      try {
        const outcome = options.recordLesson({
          scopeId: mission.id,
          content: [
            `Mission completed and supervised: ${mission.title.slice(0, 200)}`,
            `verified basis: every step settled (${steps.length} step(s) COMPLETED/SKIPPED)`,
            `steps: ${steps.slice(0, 8).map((s) => s.title.slice(0, 80)).join("; ") || "(no steps)"}`,
          ].join("\n"),
          verified: "supervisor:steps-settled",
        });
        if (!outcome.ok) {
          return record({
            missionId: mission.id, action: "stop", attempt,
            reason: `steps settled but the supervision lesson was refused (${outcome.refusal?.reason ?? "unknown"}) — surfaced, not silently dropped`,
            at,
          });
        }
      } catch {
        return record({ missionId: mission.id, action: "stop", attempt, reason: "steps settled but lesson recording threw — surfaced, not silently dropped", at });
      }
    }
    return record({
      missionId: mission.id,
      action: "stop",
      attempt,
      reason: `mission completed with all ${steps.length} step(s) settled; supervision lesson recorded`,
      at,
    });
  }

  async function observeInner(missionId: string, at: string): Promise<AutonomyDecision> {
    const mission = options.getMission(missionId);
    if (mission === null) {
      return record({ missionId, action: "stop", attempt: 0, reason: "no such mission; nothing to supervise", at });
    }
    // Success is supervised too (Phase 2A): verify the settlement and record
    // a provenanced lesson instead of walking away at COMPLETED.
    if (mission.status === "COMPLETED") return superviseCompleted(mission, at);
    if (mission.status === "CANCELLED") {
      return record({
        missionId, action: "stop", attempt: attemptOf(mission),
        reason: "the mission was cancelled; cancellation is deliberate and is never retried",
        at,
      });
    }
    if (mission.status !== "FAILED") {
      return record({
        missionId,
        action: "stop",
        attempt: attemptOf(mission),
        reason: `the mission is ${mission.status}; supervision applies to settled missions (COMPLETED/FAILED/CANCELLED)`,
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

    // DUPLICATE-DELIVERY BOUND. The executor can emit `mission.failed` more than
    // once for the same settled mission (recovery, a replayed frame), and a
    // Core restart re-reads the same FAILED row. The attempt counter lives on
    // the mission, so it does not advance between those deliveries: without this
    // guard each delivery started ANOTHER re-attempt of one failure. A mission
    // that already has a retry (durably marked, or seen this process) is left
    // settled.
    const alreadyRetried =
      (mission.metadata !== undefined && mission.metadata["autonomyRetriedAt"] !== undefined) || retriedLocally.has(mission.id);
    if (alreadyRetried) {
      return record({
        missionId,
        action: "stop",
        attempt,
        reason: `"${error.code}" was already retried once for this mission; a duplicate delivery must not start another attempt`,
        at,
      });
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
    // Mark BEFORE the notify so a delivery arriving during the notification
    // cannot start a second attempt. Neither step may break the retry.
    retriedLocally.add(mission.id);
    try {
      options.markRetried?.(mission.id);
    } catch {
      // The in-process marker still bounds duplicates.
    }

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
