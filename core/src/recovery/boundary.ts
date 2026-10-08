// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The acceptance boundary, applied to the mission executor's step semantics.
 *
 * The executor already refuses to auto-re-run a `sideEffecting` step after a
 * crash (spec §29). That rule is necessary but coarse: it says "never replay a
 * side-effecting step", when the honest question is "had THIS execution crossed
 * its acceptance boundary?". This module supplies the finer, durable answer by
 * wrapping the executor's `StepRunner` — the one seam every mission step passes
 * through (the executor never runs anything itself).
 *
 * Ordering (see `recovery/ledger.ts` for why it is this way):
 *
 *     begin()   -> BEFORE_ACCEPT, durable
 *     accept()  -> AFTER_ACCEPT, durable; the point of no return
 *     inner()   -> the real effect
 *     complete()/fail()
 *
 * A side-effecting step whose execution is already AFTER_ACCEPT (or UNKNOWN) is
 * REFUSED here rather than replayed, so even a caller that ignored the
 * executor's rule cannot double-apply an effect. Non-side-effecting steps are
 * replayable by definition and take the fast path, untouched.
 */

import type { KaiError, KaiErrorCode, Mission, MissionStep } from "../shared/contracts.ts";
import type { StepRunner } from "../missions/executor.ts";
import { executionIdFor, type ExecutionLedger } from "./ledger.ts";

export interface BoundaryRunnerOptions {
  ledger: ExecutionLedger;
  ownerId?: string;
  /** Override the deterministic execution id for (mission, step). */
  executionId?: (missionId: string, stepId: string) => string;
}

/**
 * The failure codes that mean the effect was NEVER ATTEMPTED.
 *
 * The registry's boundary is `validate -> policy -> approval -> execute`, and it
 * reports these codes only from BEFORE `execute()` ran: the input was rejected,
 * policy refused, no approval was in hand, or the tool/agent does not exist. In
 * every case the world was not touched, so an execution that ends here has
 * provably not crossed the point of no return and may be rewound to
 * BEFORE_ACCEPT and replayed.
 *
 * Codes that mean the effect DID start are deliberately absent: `INTERNAL` is a
 * tool that threw mid-execute and `AGENT_RUN_FAILED`/`AGENT_RUN_ABANDONED` are a
 * worker turn that ran — those may have partially applied and must NOT be
 * rewound.
 */
const EFFECT_NOT_ATTEMPTED: ReadonlySet<KaiErrorCode> = new Set<KaiErrorCode>([
  "VALIDATION_FAILED",
  "POLICY_DENIED",
  "NOT_FOUND",
  "APPROVAL_REQUIRED",
  "AGENT_CAPABILITY_MISSING",
]);

function refuse(step: MissionStep, executionId: string, phase: string, reason: string): KaiError {
  return {
    code: "AGENT_RUN_ABANDONED",
    message:
      `refusing to replay side-effecting step "${step.title}" (${executionId}): ` +
      `recovery classifies it ${phase} — ${reason}`,
    retryable: false,
    at: new Date().toISOString(),
    detail: `recovery:${phase}`,
  };
}

/**
 * Wrap a `StepRunner` so every side-effecting step carries a durable acceptance
 * boundary. Drop-in: the returned runner has the same signature.
 */
export function createBoundaryRunner(inner: StepRunner, opts: BoundaryRunnerOptions): StepRunner {
  const idFor = opts.executionId ?? executionIdFor;

  const runner: StepRunner = async (step, mission, runOpts) => {
    // A step that does not touch the world is safe to repeat: no boundary needed.
    if (!step.sideEffecting) return inner(step, mission, runOpts);

    const executionId = idFor(mission.id, step.id);
    const begun = opts.ledger.begin({
      executionId,
      kind: "mission_step",
      refId: mission.id,
      stepId: step.id,
      sideEffecting: true,
      ...(opts.ownerId !== undefined ? { ownerId: opts.ownerId } : {}),
    });

    if (!begun.created) {
      const prior = opts.ledger.classify(executionId);
      if (!prior.replaySafe) {
        return { ok: false, error: refuse(step, executionId, prior.phase, prior.reason) };
      }
    }

    // Cross the boundary BEFORE the effect. From here on this execution is
    // AFTER_ACCEPT, so it can never be replayed.
    const crossed = opts.ledger.accept(executionId);
    if (!crossed.accepted && crossed.record?.phase !== "AFTER_ACCEPT") {
      return {
        ok: false,
        error: refuse(step, executionId, crossed.record?.phase ?? "UNKNOWN", "the acceptance boundary could not be crossed exactly once"),
      };
    }

    const result = await inner(step, mission, runOpts);

    if ("pending" in result) {
      // The action asked for a human and did nothing. Rewind the boundary so a
      // later, approved resume may run it — the effect has demonstrably not
      // happened, so this is not a replay of anything.
      opts.ledger.rollbackAccept(executionId, "parked on approval before running");
      return result;
    }

    if (result.ok) {
      opts.ledger.complete(executionId);
    } else {
      // A refusal from the registry/agent boundary (validate / policy / approval
      // / missing tool) happens BEFORE the effect, so the execution has provably
      // not crossed the point of no return: rewind it to BEFORE_ACCEPT exactly as
      // for an approval park, so a later recovery may replay it. A failure that
      // happened DURING the effect (a tool that threw, a worker turn that failed)
      // is left AFTER_ACCEPT — replaying it could duplicate a partial effect.
      if (EFFECT_NOT_ATTEMPTED.has(result.error.code)) {
        opts.ledger.rollbackAccept(executionId, `effect not attempted: ${result.error.code}`);
      }
      opts.ledger.fail(executionId, result.error.message);
    }
    return result;
  };

  /**
   * Record, durably, that a side-effecting step is being PARKED before its effect
   * has been attempted.
   *
   * The executor calls this when ITS OWN policy gate demands approval — the one
   * park site the runner never sees, because the executor deliberately does not
   * call the runner for a step a human must clear. Without it the parked step
   * leaves NO durable record at all, so a crash while it waits is classified
   * UNKNOWN (unsafe) and a crash before a side effect becomes indistinguishable
   * from one after it. The step has provably not run, so BEFORE_ACCEPT — the
   * replay-safe phase — is the honest record.
   */
  runner.recordParkedBeforeEffect = (step, mission) => {
    if (!step.sideEffecting) return;
    opts.ledger.begin({
      executionId: idFor(mission.id, step.id),
      kind: "mission_step",
      refId: mission.id,
      stepId: step.id,
      sideEffecting: true,
      ...(opts.ownerId !== undefined ? { ownerId: opts.ownerId } : {}),
    });
  };

  /**
   * The counterpart for a park the human (or the deadline) REFUSED: the step will
   * never run. Settle its BEFORE_ACCEPT record as FAILED so it does not linger as
   * an open execution forever; the phase stays BEFORE_ACCEPT because the effect
   * still never happened.
   */
  runner.recordRefusedBeforeEffect = (step, mission, reason) => {
    if (!step.sideEffecting) return;
    const executionId = idFor(mission.id, step.id);
    opts.ledger.begin({
      executionId,
      kind: "mission_step",
      refId: mission.id,
      stepId: step.id,
      sideEffecting: true,
      ...(opts.ownerId !== undefined ? { ownerId: opts.ownerId } : {}),
    });
    opts.ledger.fail(executionId, reason);
  };

  /**
   * The durable recovery verdict for a step the process died on. The executor's
   * `recover()` uses it to tell a crash BEFORE the effect (BEFORE_ACCEPT →
   * replay-safe → resume) from one after it (AFTER_ACCEPT/UNKNOWN → block), which
   * is the whole point of the ledger.
   */
  runner.replaySafety = (step, mission) => {
    const classified = opts.ledger.classify(idFor(mission.id, step.id));
    return { replaySafe: classified.replaySafe, phase: classified.phase, reason: classified.reason };
  };

  return runner;
}

export type BoundaryRunResult<T> =
  | { ok: true; value: T }
  | { ok: false; refused: true; phase: string; reason: string }
  | { ok: false; refused: false; error: string };

/**
 * The same boundary for a non-mission operation (a scheduled job, a risky
 * filesystem change). `perform` runs only if recovery says replaying is safe.
 */
export async function withAcceptanceBoundary<T>(
  ledger: ExecutionLedger,
  meta: {
    executionId: string;
    kind: string;
    refId?: string;
    stepId?: string;
    slot?: string;
    sideEffecting?: boolean;
  },
  perform: () => Promise<T>,
): Promise<BoundaryRunResult<T>> {
  const begun = ledger.begin({
    executionId: meta.executionId,
    kind: meta.kind,
    ...(meta.refId !== undefined ? { refId: meta.refId } : {}),
    ...(meta.stepId !== undefined ? { stepId: meta.stepId } : {}),
    ...(meta.slot !== undefined ? { slot: meta.slot } : {}),
    ...(meta.sideEffecting !== undefined ? { sideEffecting: meta.sideEffecting } : {}),
  });
  if (!begun.created) {
    const prior = ledger.classify(meta.executionId);
    if (!prior.replaySafe) {
      return { ok: false, refused: true, phase: prior.phase, reason: prior.reason };
    }
  }
  ledger.accept(meta.executionId);
  try {
    const value = await perform();
    ledger.complete(meta.executionId);
    return { ok: true, value };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ledger.fail(meta.executionId, message);
    return { ok: false, refused: false, error: message };
  }
}

/** Convenience: the boundary a mission step would use, for callers/planners. */
export function missionStepExecutionId(mission: Mission, step: MissionStep): string {
  return executionIdFor(mission.id, step.id);
}

/**
 * The RECOVERY-side driver: replay an operation ONLY when the ledger's
 * classification says it is safe.
 *
 * This is deliberately different from `withAcceptanceBoundary`, which is a
 * first *attempt* and may therefore start fresh work. A replay must never start
 * from "we have no idea": an operation with no durable record is UNKNOWN, and
 * UNKNOWN is unsafe — that is the whole point of the classification. So a
 * missing record is refused here, exactly like an AFTER_ACCEPT one.
 */
export async function replayIfSafe<T>(
  ledger: ExecutionLedger,
  executionId: string,
  perform: () => Promise<T>,
  meta?: { kind?: string; refId?: string; stepId?: string; slot?: string },
): Promise<BoundaryRunResult<T>> {
  const prior = ledger.classify(executionId);
  if (!prior.replaySafe) {
    return { ok: false, refused: true, phase: prior.phase, reason: prior.reason };
  }
  return withAcceptanceBoundary(
    ledger,
    {
      executionId,
      kind: meta?.kind ?? "recovery_replay",
      ...(meta?.refId !== undefined ? { refId: meta.refId } : {}),
      ...(meta?.stepId !== undefined ? { stepId: meta.stepId } : {}),
      ...(meta?.slot !== undefined ? { slot: meta.slot } : {}),
    },
    perform,
  );
}
