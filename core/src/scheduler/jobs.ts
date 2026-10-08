// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Scheduled job runner — Part F1: a scheduler must not be a policy bypass.
 *
 * A schedule only says *when* to ask for something to happen. It must never say
 * *whether* the thing is allowed. That distinction is why this module exists: a
 * scheduled job is resolved to a tool id and handed to the SAME boundary every
 * other action goes through (`validate -> policy -> approval -> execute`, the
 * tool registry). Nothing here runs a command, spawns a worker or touches the
 * filesystem.
 *
 * The consequence the brief asks for falls out directly: a job configured
 * yesterday is checked against TODAY's policy, because the check happens at fire
 * time, inside `boundary.invoke`, not when the job was created. If the policy has
 * tightened, the boundary answers `APPROVAL_REQUIRED` (or `POLICY_DENIED`) and
 * the job does not run — it parks.
 *
 * The catalog maps an `action` string (what the `ScheduledTask` carries) to a
 * tool id, its risk and whether it changes the world. An action with no entry is
 * treated as UNKNOWN and therefore dangerous: an unrecognised schedule must not
 * be able to become an unattended side effect.
 */

import type { KaiError, RiskLevel, ScheduledTask } from "../shared/contracts.ts";
import { stripScheduleExtensions } from "./schedule.ts";

/**
 * What a scheduled fire reported back. `void` from a callback means "completed",
 * so this union extends the previous contract rather than replacing it.
 */
export type FireOutcome =
  | { status: "completed"; output?: unknown }
  | { status: "failed"; error: KaiError }
  /**
   * The boundary asked for a human. This is NOT a failure: the job did not run,
   * and it must not be silently retried — it parks.
   */
  | { status: "approval_required"; approvalId?: string; reason: string };

/** The slice of `ToolRegistry` this module needs. Structural, so there is no import knot. */
export interface ActionBoundary {
  invoke(
    id: string,
    input: unknown,
    opts?: {
      missionId?: string;
      stepId?: string;
      /** The schedule whose fire caused this action — recorded on the action record. */
      scheduleId?: string;
      turnId?: string;
      approvalId?: string;
    },
  ): Promise<{ ok: true; result: unknown } | { ok: false; error: KaiError }>;
}

/** One entry in the job catalog. */
export interface ScheduledJob {
  /** The `ScheduledTask.action` this job answers to. */
  action: string;
  /** The registered tool the boundary must invoke. */
  toolId: string;
  risk: RiskLevel;
  /**
   * True when running this job changes something outside KAI, OR when running
   * it twice would produce a duplicate effect even though its own steps are
   * policy-checked.
   *
   * This is deliberately broader than "touches the world directly". Creating
   * and starting a mission is KAI-internal orchestration and each mission step
   * passes the boundary in its own right — but starting the SAME schedule
   * occurrence twice would start TWO missions, and that is a duplicate effect.
   * So a mission-creating job is `sideEffecting: true`: a missed occurrence
   * PARKS for approval rather than being silently replayed, and an interrupted
   * occurrence is never re-run. Getting this wrong is exactly the duplicate
   * the durable occurrence identity in ./lease.ts is built to prevent.
   *
   * Drives the missed-task rule: a missed side-effecting job is never re-run
   * silently, and its ledger row is recorded side-effecting so recovery refuses
   * to replay it.
   */
  sideEffecting: boolean;
  /** Build the tool input. Defaults to the task payload, minus scheduler metadata. */
  buildInput?: (task: ScheduledTask) => unknown;
}

export interface JobDescription {
  known: boolean;
  toolId?: string;
  risk: RiskLevel;
  sideEffecting: boolean;
}

export interface JobRunner {
  run(
    task: ScheduledTask,
    ctx?: { approvalId?: string; missed?: boolean; scheduleId?: string },
  ): Promise<FireOutcome>;
  /** Whether a task is dangerous, for the missed-task decision. */
  describe(task: ScheduledTask): JobDescription;
  list(): ScheduledJob[];
}

function kaiError(code: KaiError["code"], message: string): KaiError {
  return { code, message, retryable: false, at: new Date().toISOString() };
}

export function createScheduledJobRunner(opts: {
  boundary: ActionBoundary;
  jobs: readonly ScheduledJob[];
}): JobRunner {
  const byAction = new Map<string, ScheduledJob>();
  for (const job of opts.jobs) byAction.set(job.action, job);

  function describe(task: ScheduledTask): JobDescription {
    const job = byAction.get(task.action);
    if (job === undefined) {
      // Unknown action: assume the worst. A schedule whose meaning we cannot
      // resolve must not be able to run unattended.
      return { known: false, risk: "DESTRUCTIVE", sideEffecting: true };
    }
    return { known: true, toolId: job.toolId, risk: job.risk, sideEffecting: job.sideEffecting };
  }

  async function run(
    task: ScheduledTask,
    ctx?: { approvalId?: string; missed?: boolean; scheduleId?: string },
  ): Promise<FireOutcome> {
    const job = byAction.get(task.action);
    if (job === undefined) {
      return {
        status: "failed",
        error: kaiError("NOT_FOUND", `scheduled task ${task.id}: unknown action "${task.action}"`),
      };
    }

    // The missed-task rule, in one place: a dangerous job whose scheduled slot
    // elapsed while KAI was down is not replayed silently. It parks as needing
    // an answer — exactly like any other blocked action.
    if (ctx?.missed === true && job.sideEffecting) {
      return {
        status: "approval_required",
        reason:
          `scheduled task ${task.id}: a missed run of side-effecting action ` +
          `"${job.action}" requires approval before it may be replayed`,
      };
    }

    const input =
      job.buildInput !== undefined
        ? job.buildInput(task)
        : stripScheduleExtensions(task.payload);

    // The schedule whose fire caused this action is threaded onto the boundary
    // call so the action record names it, which is what lets a later reader
    // resolve an artifact (a memory, a mission) back to the schedule that fired
    // it. `task.id` IS the schedule id; a caller-supplied one overrides it.
    const result = await opts.boundary.invoke(job.toolId, input, {
      scheduleId: ctx?.scheduleId ?? task.id,
      ...(ctx?.approvalId !== undefined ? { approvalId: ctx.approvalId } : {}),
    });

    if (result.ok) {
      return { status: "completed", output: result.result };
    }

    const error = result.error;
    if (error.code === "APPROVAL_REQUIRED") {
      // The boundary created (or found) a pending approval. Park, do not retry.
      const approvalId =
        error.detail !== undefined && error.detail.startsWith("apr_") ? error.detail : undefined;
      return {
        status: "approval_required",
        reason: error.message,
        ...(approvalId !== undefined ? { approvalId } : {}),
      };
    }

    return { status: "failed", error };
  }

  return { run, describe, list: () => [...opts.jobs] };
}
