// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * KAI mission executor.
 *
 * Runs a mission's steps in ascending `index` order through an injected runner
 * and keeps the mission's status honest at every transition. Two rules drive
 * the design:
 *
 *   1. No arbitrary execution. The executor NEVER runs a command itself — it
 *      only calls `opts.runner`. It imports no child_process, fs or agent client,
 *      so every side effect a mission has, has been explicitly handed to it.
 *
 *   2. Crash safety (spec §29). `recover()` decides what may continue after the
 *      process died. A step that touches the world (`sideEffecting`) is never
 *      auto-re-run: we cannot know whether it already happened, so the mission
 *      is parked in WAITING and reported as blocked instead of guessed at.
 *
 * The policy types below mirror `policies/gate.ts` structurally so this module
 * can be injected with that gate without importing it (it is being written in
 * parallel). Structural typing makes the two interchangeable.
 */

import type {
  Approval,
  ApprovalStatus,
  KaiError,
  KaiErrorCode,
  KaiEventType,
  Mission,
  MissionStep,
  MissionStore,
  RiskLevel,
} from "../shared/contracts.ts";
import {
  allStepsCompleted,
  remainingSteps,
  sortSteps,
  type Publish,
} from "./mission.ts";
import { verifyMissionCriteria } from "./verify.ts";

/**
 * The mission's EXPLICIT acceptance criteria, read off the record.
 *
 * Deliberately never derived from what a step produced: a criterion that came from the
 * worker's own output would be the worker grading itself.
 */
function missionCriteria(mission: Mission): string[] {
  const raw = mission.metadata?.["criteria"];
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

export type PolicyOutcome = "allow" | "deny" | "needs_approval";

export interface PolicyRequest {
  toolId: string;
  action: string;
  risk: RiskLevel;
  missionId?: string;
  stepId?: string;
  input?: unknown;
}

export interface PolicyDecision {
  outcome: PolicyOutcome;
  reason: string;
  approvalId?: string;
}

export interface PolicyGate {
  check(request: PolicyRequest): Promise<PolicyDecision>;
}

export type { Publish };

/** The two switches an autonomous mission must respect, read live from settings. */
export interface AutonomySwitches {
  doer: "ON" | "OFF";
  monster: "ON" | "OFF";
  /** How many steps Monster Mode will carry before it stops with a blocker. */
  steps: number;
  /** Wall-clock ceiling for the whole run. */
  minutes: number;
}

/**
 * Did KAI start this mission on its own?
 *
 * Only missions marked `autonomous` are subject to DOER. A plan the owner
 * approved by hand is theirs, and DOER OFF must not silently freeze it — that
 * would turn a safety switch into a way to strand the owner's own work.
 */
export function isAutonomous(mission: Mission): boolean {
  return mission.metadata?.["autonomous"] === true;
}

export interface StepRunner {
  (
    step: MissionStep,
    mission: Mission,
    /**
     * Set when the step is running because a human already cleared it.
     *
     * This exists because of a real defect: resuming an APPROVED step used to
     * call the runner with no approval, the runner asked the policy boundary
     * again, the boundary — whose answer had not changed — demanded approval a
     * second time, and the step the human had just cleared FAILED. An approval
     * is the answer to the question the boundary asks; the runner has to be
     * able to present it.
     */
    opts?: { approvalId?: string },
  ): Promise<
    | { ok: true; output?: Record<string, unknown> }
    | { ok: false; error: KaiError }
    /**
     * The boundary asked for a human. This is NOT a failure: the step is parked
     * and the mission waits, exactly as when the step's own policy check wants
     * approval. Reporting it as an error failed missions that merely needed an
     * answer — and an action that needs approval is not an action that failed.
     */
    | { pending: true; reason: string }
  >;

  /**
   * Record, durably, that a side-effecting step is being PARKED before its effect
   * has been attempted. The executor's own policy gate parks a step WITHOUT
   * calling the runner ("a step needing approval must not run"), so this is the
   * one park the runner never sees. A runner that owns an acceptance boundary
   * implements it (writing BEFORE_ACCEPT); a plain runner may omit it, and the
   * executor then simply parks as before.
   *
   * Why it matters: a parked side-effecting step that leaves no durable record is
   * classified UNKNOWN on the next start — unsafe — and a crash before a side
   * effect becomes indistinguishable from one after it. The step has provably not
   * run, so BEFORE_ACCEPT (replay-safe) is the honest record.
   */
  recordParkedBeforeEffect?(step: MissionStep, mission: Mission): void;

  /**
   * The counterpart for a park the human (or the deadline) REFUSED: the step will
   * never run, so its BEFORE_ACCEPT record must be settled rather than left open
   * forever. Optional for the same reason as `recordParkedBeforeEffect`.
   */
  recordRefusedBeforeEffect?(step: MissionStep, mission: Mission, reason: string): void;

  /**
   * The durable recovery verdict for a step the process died on, read from
   * persisted state. `null`/absent when the runner has no durable opinion (a
   * plain runner): recovery then keeps its conservative "block every remaining
   * side-effecting step" behaviour.
   */
  replaySafety?(
    step: MissionStep,
    mission: Mission,
  ): { replaySafe: boolean; phase: string; reason: string } | null;
}

/**
 * The slice of the approval service the executor needs. Kept structural so the
 * service satisfies it without the executor importing it.
 */
export interface ApprovalGateway {
  request(input: {
    toolId: string;
    action: string;
    reason: string;
    risk: RiskLevel;
    missionId?: string;
    stepId?: string;
  }): Approval;
  list(opts?: { status: ApprovalStatus }): Approval[];
}

export interface MissionExecutor {
  start(missionId: string): Promise<Mission>;
  cancel(missionId: string): Promise<Mission>;
  /**
   * Continue a mission parked in WAITING_APPROVAL by re-reading the recorded
   * approval verdict. An APPROVED step runs, a REJECTED/EXPIRED one fails the
   * mission without running, and a still-PENDING one leaves the mission parked.
   * A no-op for any mission that is not currently waiting on an approval.
   */
  resume(missionId: string): Promise<Mission>;
  /** Called once at Core startup. Decides, per persisted mission, what may safely continue (spec §29). */
  recover(): Promise<{ resumed: string[]; blocked: string[] }>;
}

// ── Risk derivation ───────────────────────────────────────────────────────────

const RISK_ORDER: readonly RiskLevel[] = ["READ", "WRITE", "EXTERNAL", "DESTRUCTIVE"];

function atLeast(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_ORDER.indexOf(a) >= RISK_ORDER.indexOf(b) ? a : b;
}

/**
 * Tools this module can vouch for. It knows none — the executor is deliberately
 * ignorant of what tools exist — so any `kind: "tool"` target is treated as
 * EXTERNAL. A caller that wants a narrower judgement supplies its own gate.
 */
const KNOWN_SAFE_TOOLS: ReadonlySet<string> = new Set<string>();

export function riskForStep(step: MissionStep): RiskLevel {
  let risk: RiskLevel = "READ";
  if (step.kind === "tool") {
    const known = step.target !== undefined && KNOWN_SAFE_TOOLS.has(step.target);
    if (!known) risk = "EXTERNAL";
  }
  if (step.sideEffecting) risk = atLeast(risk, "WRITE");
  return risk;
}

/**
 * The tool id a step's policy is actually about.
 *
 * A `tool` step names its tool in `target`. An `agent` step does not: what runs
 * is the worker tool (`agents.run_task`), so the step is governed by THAT tool's
 * policy — the agent's own name matches no policy rule — and a parked approval
 * must be bound to the tool that will run, so a resume can present it. Before
 * this, an agent step's request named the agent and fell through to the default
 * outcome, which is why an allow rule for the worker tool could not authorise it.
 */
const WORKER_TOOL_ID = "agents.run_task";
function toolIdForStep(step: MissionStep): string {
  return step.kind === "agent" ? WORKER_TOOL_ID : (step.target ?? step.id);
}

function errorOf(code: KaiErrorCode, message: string, at: string): KaiError {
  return { code, message, retryable: false, at };
}

export function createMissionExecutor(opts: {
  store: MissionStore;
  /**
   * Creates and reads approvals.
   *
   * The runtime passes the approval SERVICE, not the raw store, because the
   * service is what attaches `expiresAt`, arms the expiry timer and publishes
   * the request. This module used to hand-build the row and write it to the
   * store instead, which produced an approval with NO deadline — and the expiry
   * sweep skips rows without one. The consequence was exactly what the brief
   * complained about: expiry never ran, and a mission parked on an approval
   * stayed parked forever.
   */
  approvals?: ApprovalGateway;
  policy?: PolicyGate;
  publish?: Publish;
  runner: StepRunner;
  /**
   * The autonomy switches, read LIVE from Core settings.
   *
   * This is the boundary that makes DOER real: a mission that KAI started by
   * itself must not run while the owner has said KAI may not act on its own,
   * whatever the renderer shows or a client posts. Read per start, never cached,
   * so flipping the switch takes effect on the next mission rather than the next
   * process. Absent (a bare executor in tests) means "no autonomy policy", which
   * is the previous behaviour.
   */
  autonomy?: () => AutonomySwitches;
  now?: () => Date;
  idFactory?: () => string;
}): MissionExecutor {
  const store = opts.store;
  const approvals = opts.approvals;
  const policy = opts.policy;
  const publish = opts.publish;
  const runner = opts.runner;
  const now = opts.now ?? (() => new Date());

  let seq = 0;
  const idFactory =
    opts.idFactory ??
    (() => `approval_${now().getTime().toString(36)}_${(seq++).toString(36)}`);

  /** Ids cancelled while a run was in flight (the store copy may lag). */
  const cancelled = new Set<string>();
  const inFlight = new Set<string>();

  const iso = (): string => now().toISOString();
  const sourceOf = (m: Mission): string => `mission:${m.id}`;

  function emit(type: KaiEventType, payload: unknown, m: Mission, stepId?: string): void {
    if (publish === undefined) return;
    const o: { source: string; missionId: string; stepId?: string } = {
      source: sourceOf(m),
      missionId: m.id,
    };
    if (stepId !== undefined) o.stepId = stepId;
    publish(type, payload, o);
  }

  function persist(m: Mission): void {
    m.updatedAt = iso();
    store.upsertMission(m);
  }

  function requestFor(step: MissionStep, mission: Mission): PolicyRequest {
    const req: PolicyRequest = {
      toolId: toolIdForStep(step),
      action: step.target ?? step.kind,
      risk: riskForStep(step),
      missionId: mission.id,
      stepId: step.id,
    };
    if (step.input !== undefined) req.input = step.input;
    return req;
  }

  function approvalFor(
    step: MissionStep,
    mission: Mission,
    decision: PolicyDecision,
  ): Approval {
    const approval: Approval = {
      id: decision.approvalId ?? idFactory(),
      toolId: toolIdForStep(step),
      action: step.target ?? step.kind,
      reason: decision.reason,
      risk: riskForStep(step),
      createdAt: iso(),
      status: "PENDING",
      missionId: mission.id,
      stepId: step.id,
    };
    return approval;
  }

  /**
   * The verdict a parked step's approval currently carries.
   *
   * A step waits in WAITING_APPROVAL because the gate said a human must answer.
   * That answer is an `Approval` row keyed by (missionId, stepId); reading it
   * back is how a parked mission makes progress WITHOUT re-asking the gate —
   * re-checking policy would only park it a second time, because the gate's
   * answer has not changed. `"unknown"` means we cannot judge (no store, or no
   * row): the step stays parked, since absence of an answer is not consent.
   */
  function approvalVerdict(
    step: MissionStep,
    mission: Mission,
  ): "approved" | "rejected" | "pending" | "unknown" {
    if (approvals === undefined) return "unknown";
    const mine = approvals
      .list()
      .filter((a) => a.missionId === mission.id && a.stepId === step.id);
    if (mine.length === 0) return "unknown";
    // Latest by creation wins: an approval may have expired and a fresh one
    // been requested for the same step; only the newest speaks for the step.
    mine.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    const latest = mine[mine.length - 1] as Approval;
    if (latest.status === "APPROVED") return "approved";
    if (latest.status === "REJECTED" || latest.status === "EXPIRED") return "rejected";
    // A PENDING approval whose deadline has PASSED is not a live question. The
    // sweep normally marks it EXPIRED, but a row written before a restart has no
    // timer, and the sweep only runs when something asks it to — so the reader
    // honours the deadline itself. Otherwise a mission parked across a restart
    // stays parked forever, which is the exact failure the brief forbids.
    if (latest.expiresAt !== undefined) {
      const expiresMs = Date.parse(latest.expiresAt);
      if (Number.isFinite(expiresMs) && expiresMs <= Date.now()) return "rejected";
    }
    return "pending";
  }

  /**
   * The approval that cleared this step, if one did.
   *
   * Uses the same correlation as `approvalVerdict` (latest by creation wins for
   * this mission+step) so the id handed to the runner is the id that decided.
   */
  function approvedApprovalFor(step: MissionStep, mission: Mission): Approval | undefined {
    if (approvals === undefined) return undefined;
    const mine = approvals
      .list()
      .filter((a) => a.missionId === mission.id && a.stepId === step.id && a.status === "APPROVED");
    if (mine.length === 0) return undefined;
    mine.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    return mine[mine.length - 1];
  }

  /**
   * The run loop. Assumes the mission is already RUNNING and persisted. Runs
   * every step that still needs work, in ascending index order, and stops on
   * the first hard outcome (failure, policy denial, parked approval, cancel).
   * COMPLETED/SKIPPED steps are never touched again.
   */
  /**
   * THE EVIDENCE GATE — the ONE place a mission may become COMPLETED.
   *
   * Both completion paths (the normal settle and crash recovery) go through this, because
   * a second place that decided completion is exactly how a worker's word got through the
   * first time. A mission completes only when it declared criteria AND every one of them
   * was settled by something KAI observed. Otherwise it is left non-completed with a
   * reason naming what is missing.
   */
  function settleCompleted(mission: Mission): boolean {
    const criteria = missionCriteria(mission);
    const verification = verifyMissionCriteria(criteria);
    mission.metadata = { ...(mission.metadata ?? {}), verification };

    if (criteria.length > 0 && verification.unverified.length === 0) {
      mission.status = "COMPLETED";
      mission.completedAt = iso();
      persist(mission);
      emit("mission.completed", { missionId: mission.id, verification }, mission);
      return true;
    }

    if (verification.needsHuman && verification.unverified.every((entry) => /needs a person/i.test(entry.reason))) {
      // Every outstanding criterion needs a PERSON, not a file check: that is a wait,
      // not a failure, and it stays nonterminal so a decision can still land.
      mission.status = "WAITING";
      persist(mission);
      return false;
    }

    const missing =
      criteria.length === 0
        ? "no acceptance criteria were declared, so there is nothing KAI could verify — a worker's word is not evidence"
        : verification.unverified.map((entry) => entry.reason).join("; ");
    mission.status = "FAILED";
    mission.error = {
      code: "VALIDATION_FAILED",
      message: `the worker finished, but completion is UNVERIFIED: ${missing}`,
      retryable: false,
      at: iso(),
    };
    persist(mission);
    emit("mission.failed", { missionId: mission.id, error: mission.error, verification }, mission);
    return false;
  }

  async function runSteps(mission: Mission): Promise<Mission> {
    // Monster's limits are enforced, not advertised. Both are read once per run
    // so a long mission cannot be extended by changing settings mid-flight — the
    // mission runs under the limits that were in force when it began.
    const switches = opts.autonomy?.();
    const autonomous = isAutonomous(mission);
    const stepLimit = switches !== undefined && autonomous ? switches.steps : Number.POSITIVE_INFINITY;
    const deadline = switches !== undefined && autonomous
      ? now().getTime() + switches.minutes * 60_000
      : Number.POSITIVE_INFINITY;
    let executed = 0;

    for (const step of sortSteps(mission)) {
      if (cancelled.has(mission.id)) return store.getMission(mission.id) ?? mission;
      if (step.status === "COMPLETED" || step.status === "SKIPPED") continue;

      // Out of budget: stop with a truthful blocker rather than running on. The
      // remaining steps keep their status, so resuming later continues from here
      // instead of repeating what already ran.
      const exhausted = executed >= stepLimit ? "steps" : now().getTime() > deadline ? "time" : null;
      if (exhausted !== null) {
        mission.metadata = {
          ...(mission.metadata ?? {}),
          blockedBy: "MONSTER_BUDGET",
          blockedAt: iso(),
          budget: exhausted,
          stepsExecuted: executed,
        };
        mission.status = "WAITING";
        persist(mission);
        emit("mission.blocked", { missionId: mission.id, reason: `monster_${exhausted}`, stepsExecuted: executed }, mission);
        return mission;
      }
      executed += 1;

      // Reset per step: an approval that cleared step 1 must never be presented
      // on behalf of step 2.
      let clearedBy: string | undefined;

      if (step.status === "FAILED") {
        mission.status = "FAILED";
        if (mission.error === undefined) mission.error = step.error;
        persist(mission);
        emit("mission.failed", { missionId: mission.id, stepId: step.id, error: mission.error }, mission, step.id);
        return mission;
      }

      // A step already parked on approval is resolved from the RECORDED verdict,
      // never by asking the gate again: the gate already said a human must
      // answer, and re-checking would just park it a second time. This branch
      // runs whether or not a gate was supplied — the answer lives in the store.
      if (step.status === "WAITING_APPROVAL") {
        const verdict = approvalVerdict(step, mission);

        if (verdict === "rejected") {
          // The human (or the deadline) refused. An approval that was not
          // granted is a policy denial, and the step must not run.
          const err = errorOf(
            "POLICY_DENIED",
            `approval for step "${step.title}" was not granted`,
            iso(),
          );
          step.status = "FAILED";
          step.error = err;
          step.completedAt = iso();
          mission.status = "FAILED";
          mission.error = err;
          // The step will never run: settle its pre-effect boundary record.
          runner.recordRefusedBeforeEffect?.(step, mission, err.message);
          persist(mission);
          emit("mission.progress", step, mission, step.id);
          emit("mission.failed", { missionId: mission.id, stepId: step.id, error: err }, mission, step.id);
          return mission;
        }

        if (verdict !== "approved") {
          // Still PENDING, or nothing to consult: leave it parked rather than
          // run a step a human has not cleared. Silence is not consent.
          mission.status = "WAITING_APPROVAL";
          persist(mission);
          return mission;
        }
        // verdict === "approved" → fall through and run the cleared step,
        // telling the runner WHICH approval cleared it so the boundary it meets
        // next recognises the answer instead of asking again.
        clearedBy = approvedApprovalFor(step, mission)?.id;
      } else if (policy !== undefined) {
        // Policy is checked for EVERY step, before the runner sees it.
        const decision = await policy.check(requestFor(step, mission));
        if (cancelled.has(mission.id)) return store.getMission(mission.id) ?? mission;

        if (decision.outcome === "deny") {
          const err = errorOf("POLICY_DENIED", decision.reason, iso());
          step.status = "FAILED";
          step.error = err;
          step.completedAt = iso();
          mission.status = "FAILED";
          mission.error = err;
          persist(mission);
          emit("mission.progress", step, mission, step.id);
          emit("mission.failed", { missionId: mission.id, stepId: step.id, error: err }, mission, step.id);
          return mission;
        }

        if (decision.outcome === "needs_approval") {
          step.status = "WAITING_APPROVAL";
          mission.status = "WAITING_APPROVAL";
          // The runner is NOT called for this step, so it is the executor that
          // must record the durable pre-effect boundary: the step has provably
          // not run, and a crash while it waits must not look like a crash after
          // the effect.
          runner.recordParkedBeforeEffect?.(step, mission);
          persist(mission);
          if (approvals !== undefined) {
            // Created by the SERVICE: this is what stamps the deadline, arms the
            // expiry timer and publishes approval.requested. Publishing it here
            // as well would emit the event twice.
            approvals.request({
              toolId: toolIdForStep(step),
              action: step.target ?? step.kind,
              reason: decision.reason,
              risk: riskForStep(step),
              missionId: mission.id,
              stepId: step.id,
            });
          }
          emit("mission.progress", step, mission, step.id);
          // The runner is NOT called: a step needing approval must not run.
          return mission;
        }
      }

      step.status = "RUNNING";
      step.startedAt = iso();
      persist(mission);

      const result = await runner(step, mission, clearedBy !== undefined ? { approvalId: clearedBy } : undefined);

      // A cancel raised during the step wins: the step's outcome is unknown,
      // and cancel() has already persisted CANCELLED + published.
      if (cancelled.has(mission.id)) return store.getMission(mission.id) ?? mission;

      if ("pending" in result) {
        // Parked, not failed. The approval already exists — the boundary that
        // asked created it — and it carries this mission and step, so the
        // verdict reader can find it when a human answers.
        step.status = "WAITING_APPROVAL";
        mission.status = "WAITING_APPROVAL";
        persist(mission);
        emit("mission.progress", step, mission, step.id);
        return mission;
      }

      if (result.ok) {
        step.status = "COMPLETED";
        step.completedAt = iso();
        if (result.output !== undefined) step.output = result.output;
        persist(mission);
        emit("mission.progress", step, mission, step.id);
      } else {
        step.status = "FAILED";
        step.error = result.error;
        step.completedAt = iso();
        mission.status = "FAILED";
        mission.error = result.error;
        persist(mission);
        emit("mission.progress", step, mission, step.id);
        emit("mission.failed", { missionId: mission.id, stepId: step.id, error: result.error }, mission, step.id);
        return mission; // later steps are not run
      }
    }

    if (cancelled.has(mission.id)) return store.getMission(mission.id) ?? mission;

    if (allStepsCompleted(mission)) {
      settleCompleted(mission);
    } else {
      // Nothing failed but not everything completed (e.g. a SKIPPED step):
      // honest WAITING beats a false COMPLETED.
      mission.status = "WAITING";
      persist(mission);
    }
    return mission;
  }

  async function start(missionId: string): Promise<Mission> {
    const mission = store.getMission(missionId);
    if (mission === null) throw new Error(`mission not found: ${missionId}`);
    if (mission.status === "COMPLETED" || mission.status === "FAILED" || mission.status === "CANCELLED") {
      return mission;
    }
    if (inFlight.has(missionId)) return mission;

    // ── DOER OFF BLOCKS AUTONOMOUS STARTS ────────────────────────────────────
    // A mission KAI created on its own is not allowed to begin while the owner
    // has turned autonomous execution off. It stays exactly as it was — DRAFT,
    // with every step intact — so switching DOER back on can start it later.
    // An explicitly owner-started mission (not autonomous) is unaffected: DOER
    // governs KAI acting alone, not the owner acting.
    const switches = opts.autonomy?.();
    if (switches !== undefined && isAutonomous(mission) && switches.doer !== "ON") {
      mission.metadata = { ...(mission.metadata ?? {}), blockedBy: "DOER_OFF", blockedAt: iso() };
      persist(mission);
      emit("mission.blocked", { missionId, reason: "doer_off" }, mission);
      return mission;
    }

    // A previous cancel is only relevant while its status is CANCELLED; we have
    // already returned above in that case, so clear any stale flag.
    cancelled.delete(missionId);
    inFlight.add(missionId);
    try {
      if (mission.status === "DRAFT") {
        mission.status = "QUEUED";
        persist(mission);
      }
      mission.status = "RUNNING";
      if (mission.startedAt === undefined) mission.startedAt = iso();
      persist(mission);
      emit("mission.started", { missionId }, mission);
      return await runSteps(mission);
    } finally {
      inFlight.delete(missionId);
    }
  }

  /**
   * Wake a mission parked on approval and let it carry on. This is the human
   * answering a card after `start()` already returned: `start()` cannot be used
   * because it would re-emit `mission.started` as if the work had just begun.
   *
   * The decision itself is not made here — `runSteps` re-reads the recorded
   * verdict for each parked step, so APPROVED runs and REJECTED/EXPIRED fails
   * with the same rule as before. A mission that is not waiting is a no-op.
   */
  async function resume(missionId: string): Promise<Mission> {
    const mission = store.getMission(missionId);
    if (mission === null) throw new Error(`mission not found: ${missionId}`);
    if (mission.status !== "WAITING_APPROVAL") return mission;
    if (inFlight.has(missionId)) return mission;

    cancelled.delete(missionId);
    inFlight.add(missionId);
    try {
      mission.status = "RUNNING";
      persist(mission);
      return await runSteps(mission);
    } finally {
      inFlight.delete(missionId);
    }
  }

  async function cancel(missionId: string): Promise<Mission> {
    const mission = store.getMission(missionId);
    if (mission === null) throw new Error(`mission not found: ${missionId}`);
    // Idempotent: a terminal mission is left as-is (and never re-published).
    if (mission.status === "CANCELLED" || mission.status === "COMPLETED" || mission.status === "FAILED") {
      return mission;
    }
    cancelled.add(missionId);
    mission.status = "CANCELLED";
    mission.completedAt = iso();
    persist(mission);
    emit("mission.cancelled", { missionId }, mission);
    return mission;
  }

  /**
   * Crash recovery (spec §29).
   *
   * For each unfinished mission we choose the safest possible outcome:
   *   - every step already COMPLETED → settle to COMPLETED (run nothing);
   *   - a step FAILED → settle to FAILED;
   *   - a step parked on an approval → resolve it from the recorded verdict: an
   *     APPROVED one resumes, a REJECTED/EXPIRED one settles the mission FAILED,
   *     and a still-PENDING one is reported `blocked` because its in-memory
   *     waiter died with the process and nothing can answer it now;
   *   - ANY remaining step is side-effecting → park in WAITING and report the
   *     mission in `blocked`. We cannot tell whether it already ran, so we do
   *     not guess: the runner is not called for it at all;
   *   - otherwise the remaining steps are all safe to repeat → resume.
   *
   * Settled missions are neither `resumed` nor `blocked`: nothing ran and
   * nothing was refused, they were simply closed out.
   */
  async function recover(): Promise<{ resumed: string[]; blocked: string[] }> {
    const resumed: string[] = [];
    const blocked: string[] = [];

    for (const mission of store.listUnfinishedMissions()) {
      const remaining = remainingSteps(mission);

      if (remaining.length === 0) {
        // Recovery must pass the SAME evidence gate as a normal settle: a mission that
        // crashed just before its last step is not evidence that its criteria were met.
        settleCompleted(mission);
        continue;
      }

      const failed = remaining.find((s) => s.status === "FAILED");
      if (failed !== undefined) {
        mission.status = "FAILED";
        if (mission.error === undefined) mission.error = failed.error;
        persist(mission);
        emit("mission.failed", { missionId: mission.id, stepId: failed.id, recovered: true }, mission, failed.id);
        continue;
      }

      // The approval-answer boundary outranks the side-effect rule: a step
      // parked on approval never ran, so replaying it after a granted approval
      // is safe, and a refused one must not run at all.
      const parked = remaining.find((s) => s.status === "WAITING_APPROVAL");
      if (parked !== undefined) {
        const verdict = approvalVerdict(parked, mission);
        if (verdict === "approved") {
          resumed.push(mission.id);
          await resume(mission.id);
          continue;
        }
        if (verdict === "rejected") {
          mission.status = "FAILED";
          mission.error = errorOf(
            "POLICY_DENIED",
            `crash recovery: approval for step "${parked.title}" was not granted (spec §29)`,
            iso(),
          );
          // The step will never run: settle its pre-effect boundary record.
          runner.recordRefusedBeforeEffect?.(parked, mission, mission.error.message);
          persist(mission);
          emit("mission.failed", { missionId: mission.id, stepId: parked.id, recovered: true }, mission, parked.id);
          continue;
        }
        // Still PENDING (or unresolvable). The waiter lived in memory and died
        // with the process, so nothing local can answer the card now; report it
        // blocked rather than guess a verdict.
        const reason = `crash recovery: step ${parked.id} is still waiting on approval`;
        mission.status = "WAITING_APPROVAL";
        mission.metadata = {
          ...(mission.metadata ?? {}),
          recoveryBlocked: true,
          recoveryReason: reason,
        };
        persist(mission);
        blocked.push(mission.id);
        continue;
      }

      const offender = remaining.find((s) => s.sideEffecting);
      if (offender !== undefined) {
        // The durable ledger outranks the coarse "never re-run a side-effecting
        // step" rule. If the step's execution never crossed its acceptance
        // boundary, replaying it cannot duplicate anything, so this is exactly
        // the before-accept recovery the ledger exists to make possible: resume.
        // A runner with no durable opinion returns null and we keep the
        // conservative block.
        const boundary = runner.replaySafety?.(offender, mission) ?? null;
        if (boundary !== null && boundary.replaySafe) {
          resumed.push(mission.id);
          await start(mission.id);
          continue;
        }
        const reason =
          `crash recovery: remaining step ${offender.id} ("${offender.title}") is ` +
          `side-effecting; refusing to re-run it automatically (spec §29)`;
        mission.status = "WAITING";
        mission.error = errorOf("AGENT_RUN_ABANDONED", reason, iso());
        mission.metadata = {
          ...(mission.metadata ?? {}),
          recoveryBlocked: true,
          recoveryReason: reason,
        };
        persist(mission);
        blocked.push(mission.id);
        continue;
      }

      resumed.push(mission.id);
      await start(mission.id);
    }

    return { resumed, blocked };
  }

  return { start, cancel, resume, recover };
}

