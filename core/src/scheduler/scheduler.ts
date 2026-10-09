// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The KAI Core scheduler runtime.
 *
 * What this module is for: the Core must keep its promises on a timetable even
 * when nobody is watching — the desktop UI may be closed, the machine may have
 * been asleep, the process may have been restarted. The scheduler is therefore
 * the piece that proves the Core is a *persistent runtime* rather than a request
 * handler that only acts when poked (spec §36).
 *
 * Four design commitments follow from that, and they are the reason this file
 * is written the way it is:
 *
 *   1. State lives in the store, not in memory. The scheduler holds a working
 *      copy only; every fire is written back (lastRun, nextRun, failureCount,
 *      enabled) so a crash mid-flight loses nothing that matters.
 *   2. Time is injected. `now` and `tick` make the timing testable without
 *      sleeping, which is the difference between a schedulable unit test and a
 *      flaky one.
 *   3. A broken task is quarantined, never allowed to take the loop down or
 *      burn CPU for ever. See NO DOUBLE FIRE and MAX_FAILURES below.
 *   4. A fire may be *claimed* with a durable lease (see ./lease.ts) before it
 *      runs, so two processes — or one process restarting over another — cannot
 *      both execute the same slot. Without a lease the scheduler is exactly the
 *      single-process loop it always was; with one, execution is at-most-once
 *      per slot and an interrupted slot is classified, never blindly replayed.
 *
 * Part F1 lives at the seam with ./jobs.ts: `onFire` is where a scheduled
 * execution happens, and the scheduler never decides *whether* an action may
 * run. The shipped `createScheduledJobRunner` routes every fire through the
 * same validate -> policy -> approval -> execute boundary as any other action,
 * so a job configured yesterday is checked against today's permissions.
 */

import type {
  KaiError,
  KaiEventType,
  ScheduledTask,
  ScheduledTaskStore,
} from "../shared/contracts.ts";
import {
  computeNextRun,
  readScheduleExtensions,
  specFor,
  stripScheduleExtensions,
  validateSchedule,
  type ExtendedScheduleKind,
  type MissedPolicy,
} from "./schedule.ts";
import { occurrenceId, type DurableLeaseStore, type LeaseRecord, type RunState } from "./lease.ts";
import type { FireOutcome } from "./jobs.ts";

/**
 * How an event is published. The bus is injected rather than imported (the
 * events module is built in parallel and owns its own file); the scheduler only
 * needs to know how to emit.
 */
export type Publish = (
  type: KaiEventType,
  payload: unknown,
  opts?: { source?: string },
) => void;

/**
 * Context handed to `onFire`. The second argument is additive: a callback that
 * ignores it (the runtime's, and every existing test) behaves exactly as before.
 */
export interface FireContext {
  /** The scheduled instant being fired (ISO-8601). */
  slot: string;
  /**
   * The durable execution identity of this occurrence: `scheduleId@<slotIso>`.
   * Stable across processes and restarts, so the same slot can be recognised as
   * the same work.
   */
  occurrenceId: string;
  /** True when this slot elapsed while the Core was down (missed-task policy applied). */
  missed: boolean;
}

/** The run state machine a task moves through, as reported by `stateOf`. */
export type TaskState =
  | "SCHEDULED" // waiting for its next instant
  | "DUE" // its instant has arrived and it has not been claimed yet
  | "RUNNING" // a claim is held and the action is executing
  | "COMPLETED" // finished (a `once` task after firing, or a disabled task)
  | "FAILED" // its last run failed
  | "MISSED" // a slot elapsed unrun and the policy did not replay it
  | "WAITING_APPROVAL" // the boundary demanded an answer; parked, not retried
  | "INTERRUPTED" // the claiming process died; recovery classifies before any replay
  | "ALREADY_EXECUTED" // the occurrence's durable identity was already settled
  | "QUARANTINED" // disabled after MAX_FAILURES
  | "UNKNOWN"; // not loaded

export interface TickResult {
  fired: string[];
  /** Slots another owner held, or that were already settled. */
  skipped: string[];
  /**
   * Occurrences whose durable execution identity was already claimed/executed
   * when this tick looked at them. They are reported HERE explicitly so a
   * catch-up for a slot that already ran says "already executed" rather than
   * looking like an unexplained skip. A subset of `skipped` (which is kept for
   * backward compatibility).
   */
  alreadyExecuted: string[];
  /** Slots the missed-task policy deliberately did not run (skip). */
  missed: string[];
  /** Slots parked because the action needed an answer (approval). */
  parked: string[];
  /** Slots a dead process left behind, detected on this tick. */
  interrupted: string[];
  /** Tasks whose run threw or reported failure. */
  failed: string[];
}

/** How a missed occurrence is settled. The one table every kind resolves through. */
export type MissedResolution =
  | "run" // run the overdue occurrence now (at most once)
  | "skip" // decline to run it; not recorded as missed by policy name
  | "mark-missed" // decline to run it and record that decision durably
  | "park"; // a side-effecting occurrence: park for approval, never replay

/**
 * The explicit missed-slot decision, independent of schedule kind.
 *
 * A missed occurrence is never replayed slot-by-slot: the kind decides only how
 * `nextRun` advances (see `MISSED_SLOT_CATCHUP`). This function decides whether
 * the ONE overdue occurrence may run at all:
 *
 *   skip / mark-missed        -> never runs.
 *   run-now + side-effecting  -> PARKS (approval), because re-running a
 *                                side-effecting occurrence that may already
 *                                have executed is a duplicate effect.
 *   run-now + not side-effecting -> runs once.
 */
export function missedSlotOutcome(input: {
  policy: MissedPolicy;
  sideEffecting: boolean;
  allowDangerousMissedRun?: boolean;
}): MissedResolution {
  if (input.policy === "skip") return "skip";
  if (input.policy === "mark-missed") return "mark-missed";
  if (input.sideEffecting && input.allowDangerousMissedRun !== true) return "park";
  return "run";
}

/**
 * Per-kind catch-up contract, stated so it is a documented decision rather than
 * an emergent one. In every kind, a missed occurrence fires AT MOST ONCE and
 * `nextRun` then moves forward from `now` — no kind replays its missed slots.
 */
export const MISSED_SLOT_CATCHUP: Readonly<Record<ExtendedScheduleKind, string>> = {
  once: "the single instant is spent: fires at most once, then the task is disabled",
  interval: "no per-slot catch-up: fires at most once for the overdue instant, then now + intervalMs",
  daily: "no missed-day replay: fires at most once, then the next local occurrence after now",
  weekly: "no missed-week replay: fires at most once, then the next local occurrence after now",
  cron: "no per-minute replay: fires at most once, then the next matching occurrence after now",
};

export interface Scheduler {
  start(): void;
  stop(): void;
  /** Loads persisted tasks, validates them, recomputes nextRun. Safe to call more than once. */
  reload(): Promise<{ loaded: number; invalid: string[] }>;
  /** Runs one evaluation pass. Exposed so tests can drive time instead of waiting for a timer. */
  tick(now?: Date): Promise<TickResult>;
  /**
   * Mark leases a previous process left RUNNING as INTERRUPTED and report them.
   * Call once at startup, after `reload()`; `tick()` also classifies any it sees.
   */
  recoverInterrupted(now?: Date): { interrupted: LeaseRecord[] };
  /** The current run state of a task, derived from the store and the lease ledger. */
  stateOf(taskId: string): TaskState;
  isRunning(): boolean;
}

/**
 * Default real-timer interval. 30 seconds is deliberately conservative: this is
 * NOT a busy loop, and for the schedules the Core actually runs (minutes,
 * hours, daily) a sub-second wake-up would burn battery to gain nothing.
 * Tests pass a huge value or drive `tick()` directly.
 */
export const DEFAULT_TICK_MS = 30_000;

/**
 * Consecutive-failure ceiling before a task is quarantined.
 *
 * Three is a small, bounded number: it tolerates a transient upstream blip
 * (network hiccup, agent still starting) while guaranteeing that a permanent
 * failure — a task whose action no longer exists, say — stops being retried
 * rather than looping for ever. On reaching this count the task is disabled
 * (enabled=false, nextRun=null) but *kept* in the store for inspection; a user
 * re-enables it deliberately.
 */
export const MAX_FAILURES = 3;

/**
 * What a slot that elapsed while the Core was down does by default.
 *
 * `run-now` preserves the Core's long-standing behaviour (a due task fires once
 * and is then scheduled forward), and it is safe because the *danger* guard is
 * separate: a missed run of a side-effecting action is parked for approval, not
 * replayed (see `jobs.ts` `run(..., { missed: true })` and the `dangerous`
 * branch below). A task can override this per-schedule via its payload.
 */
export const DEFAULT_MISSED_POLICY: MissedPolicy = "run-now";

/** Internal lifecycle phase. `stopped` is sticky until `start()` is called. */
type Phase = "idle" | "running" | "stopped";

function internalError(message: string, at: Date): KaiError {
  return { code: "INTERNAL", message, retryable: true, at: at.toISOString() };
}

export function createScheduler(opts: {
  store: ScheduledTaskStore;
  publish?: Publish;
  onFire: (task: ScheduledTask, ctx: FireContext) => Promise<void | FireOutcome>;
  now?: () => Date;
  /** Real timer interval; tests drive tick() instead. */
  tickMs?: number;
  /**
   * Optional durable lease ledger. When present, every fire is claimed before it
   * runs, which is what makes execution at-most-once across processes/restarts.
   */
  lease?: DurableLeaseStore;
  /** Identity for lease ownership. Defaults to a per-scheduler unique id. */
  ownerId?: string;
  /** Whether a task changes the world, for the missed-task danger guard. */
  describe?: (task: ScheduledTask) => { sideEffecting: boolean };
  /** Escape hatch: allow a missed dangerous job to run anyway. Default false. */
  allowDangerousMissedRun?: boolean;
  /**
   * How late a slot must be before it counts as "missed" rather than "just due".
   * Defaults to `tickMs`, so ordinary jitter is not mistaken for downtime.
   */
  missedGraceMs?: number;
  /**
   * Called once at the end of every tick with the tick's own timestamp. This is
   * the single seam for Core-internal, self-rescheduling work that is NOT a
   * user-configured scheduled task (the daily work-summary offer). It is called
   * after the due tasks have run, and a throw from it is contained here so a
   * misbehaving housekeeping callback can never take the scheduler loop down or
   * stop the remaining ticks. Exactly one scheduler exists; this adds no second
   * one.
   */
  onTick?: (at: Date) => void;
}): Scheduler {
  const { store, onFire } = opts;
  const publish: Publish = opts.publish ?? (() => {});
  const clock: () => Date = opts.now ?? (() => new Date());
  const tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
  const lease = opts.lease;
  const ownerId =
    opts.ownerId ??
    `sched_${process.pid}_${clock().getTime().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

  /** Working copy of the schedules the store knows about. */
  const tasks = new Map<string, ScheduledTask>();
  /** Last failure per task, for diagnostics ("record the failure"). */
  const failures = new Map<string, { at: string; count: number; message: string }>();
  /** Last observed run state per task, so `stateOf` reports what actually happened. */
  const lastRunState = new Map<string, RunState>();
  /** Tasks whose last evaluated occurrence was found already executed. */
  const alreadyExecutedFlag = new Set<string>();

  let timer: ReturnType<typeof setInterval> | null = null;
  let phase: Phase = "idle";
  /** Re-entrancy guard: a slow tick must not overlap the timer's next tick. */
  let ticking = false;
  /** Tasks currently executing in this process. */
  const inFlight = new Set<string>();

  function emit(type: KaiEventType, payload: unknown): void {
    try {
      publish(type, payload, { source: "scheduler" });
    } catch {
      // Observability must never be the thing that kills the loop.
    }
  }

  /** Persist a task; a store error must not abort the whole tick. */
  function persist(task: ScheduledTask): void {
    try {
      store.upsertScheduledTask(task);
    } catch {
      // Deliberately swallowed: the store is the other module's problem, and
      // one bad write must not stop the remaining tasks from firing.
    }
  }

  function toIso(at: Date): string {
    return at.toISOString();
  }

  /**
   * Set the cleared `nextRun` sentinel.
   *
   * CONTRACT FRICTION: ScheduledTask types nextRun as `nextRun?: string`, so
   * TypeScript only permits `string | undefined` — but the scheduler's defined
   * behaviour is that a finished/invalid task has `nextRun === null` (the value
   * SQLite stores for "no next run"). `Object.assign` performs the runtime
   * write without typing the target property, so the behaviour the spec
   * requires and the shape the frozen contract declares both hold.
   */
  function setNextRun(task: ScheduledTask, at: Date | null): void {
    Object.assign(task, { nextRun: at === null ? null : toIso(at) });
  }

  function missedPolicyOf(task: ScheduledTask): MissedPolicy {
    return readScheduleExtensions(task.payload).missed ?? DEFAULT_MISSED_POLICY;
  }

  function isDangerous(task: ScheduledTask): boolean {
    return opts.describe?.(task).sideEffecting === true;
  }

  /**
   * Move a task's nextRun forward after a fire (successful or not).
   *
   * NO DOUBLE FIRE (spec §36). This is the classic symptom of a process that
   * was down: a task's nextRun is far in the past, and a naive scheduler fires
   * it once for every missed slot to "catch up". KAI must never do that — a
   * task that was overdue fires AT MOST ONCE, and is then scheduled forward
   * from the current instant. The rule is enforced on every kind:
   *   - interval: next = previous + intervalMs, but floored to now + intervalMs
   *     so an overdue task resumes on a clean cadence from now;
   *   - daily/weekly/cron: the next local occurrence after `at` (missed days are
   *     not replayed);
   *   - once:     disabled — its single instant is spent.
   */
  function advance(task: ScheduledTask, at: Date): void {
    const kind = specFor(task).kind;
    switch (kind) {
      case "once": {
        task.enabled = false;
        setNextRun(task, null);
        return;
      }
      case "interval": {
        const step = task.intervalMs ?? 0;
        const prev = typeof task.nextRun === "string" ? Date.parse(task.nextRun) : Number.NaN;
        const base = Number.isFinite(prev) ? prev + step : at.getTime() + step;
        const next = base > at.getTime() ? base : at.getTime() + step;
        setNextRun(task, new Date(next));
        return;
      }
      case "daily":
      case "weekly":
      case "cron": {
        // computeNextRun never replays a missed day: it returns the next local
        // occurrence strictly after `at`.
        const next = computeNextRun(specFor(task), at);
        setNextRun(task, next);
        if (next === null) task.enabled = false;
        return;
      }
      default: {
        // An unknown kind cannot be scheduled honestly: quarantine it.
        task.enabled = false;
        setNextRun(task, null);
      }
    }
  }

  function recordFailure(task: ScheduledTask, at: Date, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    failures.set(task.id, { at: toIso(at), count: task.failureCount, message });
    const error: KaiError = {
      code: "INTERNAL",
      message: `scheduled task "${task.title}" failed: ${message}`,
      retryable: true,
      at: toIso(at),
    };
    emit("scheduled_task.triggered", {
      taskId: task.id,
      title: task.title,
      action: task.action,
      firedAt: toIso(at),
      ok: false,
      error,
    });
  }

  /** Settle a missed slot per policy, without running it. Returns its `TickResult` bucket. */
  function applyMissedPolicy(
    task: ScheduledTask,
    slot: string,
    policy: MissedPolicy,
    at: Date,
  ): "skipped" | "missed" | "run" | "parked" {
    const key = occurrenceId(task.id, slot);
    const resolution = missedSlotOutcome({
      policy,
      sideEffecting: isDangerous(task),
      ...(opts.allowDangerousMissedRun !== undefined
        ? { allowDangerousMissedRun: opts.allowDangerousMissedRun }
        : {}),
    });

    if (resolution === "run") return "run";

    if (resolution === "park") {
      // A side-effecting occurrence must NOT be silently re-run after downtime:
      // its effect may already have happened. Park it for a human instead.
      lease?.finish(key, ownerId, "PAUSED", "missed side-effecting run parked for approval");
      lastRunState.set(task.id, "PAUSED");
      task.updatedAt = toIso(at);
      advance(task, at);
      persist(task);
      emit("scheduled_task.triggered", {
        taskId: task.id,
        title: task.title,
        action: task.action,
        occurrenceId: key,
        slot,
        firedAt: toIso(at),
        ok: false,
        parked: true,
        missed: true,
        reason: "missed run of a side-effecting action needs approval; not replayed silently",
      });
      return "parked";
    }

    // skip and mark-missed both decline to run; mark-missed additionally records
    // the decision durably and says so, which is what makes the two observable.
    const detail =
      resolution === "skip" ? "missed run skipped by policy" : "missed run recorded by policy";
    lease?.finish(key, ownerId, "MISSED", detail);
    lastRunState.set(task.id, "MISSED");
    task.updatedAt = toIso(at);
    advance(task, at);
    persist(task);
    emit("scheduled_task.triggered", {
      taskId: task.id,
      title: task.title,
      action: task.action,
      occurrenceId: key,
      slot,
      firedAt: toIso(at),
      ok: false,
      missed: true,
      policy,
      reason: detail,
    });
    return resolution === "skip" ? "skipped" : "missed";
  }

  /** Fire one due task, applying the lease and the missed-task policy. */
  async function runOne(
    task: ScheduledTask,
    slotDate: Date,
    at: Date,
    atMs: number,
    graceMs: number,
    result: TickResult,
  ): Promise<void> {
    const slot = toIso(slotDate);
    const key = occurrenceId(task.id, slot);
    const missedBy = atMs - slotDate.getTime();
    const isMissed = missedBy > graceMs;
    // Each evaluation of a task decides its reported outcome afresh.
    alreadyExecutedFlag.delete(task.id);

    if (lease !== undefined) {
      const previous = lease.peek(key);

      // A slot a dead process left behind is a recovery decision, not a normal
      // fire. Classify before doing anything else.
      if (previous !== null && previous.state === "INTERRUPTED") {
        result.interrupted.push(task.id);
        lastRunState.set(task.id, "INTERRUPTED");
        emit("scheduled_task.triggered", {
          taskId: task.id,
          title: task.title,
          action: task.action,
          occurrenceId: key,
          slot,
          firedAt: toIso(at),
          ok: false,
          interrupted: true,
          sideEffecting: previous.sideEffecting,
          reason: "a previous process died while this slot was running",
        });
        if (previous.sideEffecting) {
          // AFTER-ACCEPT-or-unknown: never replay. Move past the slot honestly.
          lease.settle(key, "MISSED", "interrupted side-effecting run not replayed");
          task.updatedAt = toIso(at);
          advance(task, at);
          persist(task);
          result.missed.push(task.id);
          return;
        }
        // Not side-effecting: replay is safe, so fall through and re-claim.
      }

      const replayInterrupted =
        previous !== null && previous.state === "INTERRUPTED" && !previous.sideEffecting;
      const claim = lease.claim(
        { taskId: task.id, slot, sideEffecting: isDangerous(task), ownerId },
        { replayInterrupted },
      );

      if (!claim.acquired) {
        // The occurrence's durable identity is not ours to run.
        if (claim.state === "RUNNING") {
          // Another LIVE owner holds this slot. Do not touch it.
          lastRunState.set(task.id, "RUNNING");
          result.skipped.push(task.id);
          return;
        }
        if (claim.state === "INTERRUPTED") {
          // The ledger classified an expired, unfinished side-effecting run as
          // INTERRUPTED (recovery, not a fire). Settle it and move on — exactly
          // the same decision the pre-claim INTERRUPTED branch makes.
          lastRunState.set(task.id, "INTERRUPTED");
          result.interrupted.push(task.id);
          lease.settle(key, "MISSED", "interrupted side-effecting run not replayed");
          task.updatedAt = toIso(at);
          advance(task, at);
          persist(task);
          result.missed.push(task.id);
          emit("scheduled_task.triggered", {
            taskId: task.id,
            title: task.title,
            action: task.action,
            occurrenceId: key,
            slot,
            firedAt: toIso(at),
            ok: false,
            interrupted: true,
            reason: "expired side-effecting run classified INTERRUPTED; not replayed",
          });
          return;
        }
        // DONE / FAILED / PAUSED / MISSED: the occurrence already ran (or was
        // already settled) under its durable identity. Report it as such rather
        // than silently skipping, and move past the slot so we do not re-try it
        // every tick.
        lastRunState.set(task.id, claim.state);
        task.updatedAt = toIso(at);
        advance(task, at);
        persist(task);
        result.alreadyExecuted.push(task.id);
        result.skipped.push(task.id); // kept for backward compatibility
        alreadyExecutedFlag.add(task.id);
        emit("scheduled_task.triggered", {
          taskId: task.id,
          title: task.title,
          action: task.action,
          occurrenceId: key,
          slot,
          firedAt: toIso(at),
          ok: false,
          alreadyExecuted: true,
          state: claim.state,
          reason: `occurrence already executed (${claim.state}); not run again`,
        });
        return;
      }
    }

    // ── Missed-task policy (slot elapsed while the Core was down) ─────────────
    if (isMissed) {
      const outcome = applyMissedPolicy(task, slot, missedPolicyOf(task), at);
      if (outcome === "skipped") result.skipped.push(task.id);
      else if (outcome === "missed") result.missed.push(task.id);
      else if (outcome === "parked") result.parked.push(task.id);
      if (outcome !== "run") return;
    }

    // ── Run it ────────────────────────────────────────────────────────────────
    inFlight.add(task.id);
    lastRunState.set(task.id, "RUNNING");
    emit("scheduled_task.triggered", {
      taskId: task.id,
      title: task.title,
      action: task.action,
      occurrenceId: key,
      slot,
      firedAt: toIso(at),
      phase: "running",
    });

    // Hand the action its data, minus KAI's own scheduler metadata.
    const delivered: ScheduledTask =
      task.payload !== undefined ? { ...task, payload: stripScheduleExtensions(task.payload) } : task;

    let outcome: void | FireOutcome;
    try {
      outcome = await onFire(delivered, { slot, occurrenceId: key, missed: isMissed });
    } catch (err) {
      outcome = {
        status: "failed",
        error: internalError(err instanceof Error ? err.message : String(err), at),
      };
    } finally {
      inFlight.delete(task.id);
    }

    const status =
      outcome === undefined || outcome === null ? "completed" : (outcome as FireOutcome).status;

    if (status === "completed") {
      task.lastRun = toIso(at);
      task.failureCount = 0; // failureCount is CONSECUTIVE failures.
      failures.delete(task.id);
      advance(task, at);
      task.updatedAt = toIso(at);
      persist(task);
      lease?.finish(key, ownerId, "DONE");
      lastRunState.set(task.id, "DONE");
      result.fired.push(task.id);
      emit("scheduled_task.triggered", {
        taskId: task.id,
        title: task.title,
        action: task.action,
        occurrenceId: key,
        slot,
        firedAt: toIso(at),
        ok: true,
      });
      return;
    }

    if (status === "approval_required") {
      // Not a failure: the boundary asked for a human. Park, do not retry this
      // slot, and do not silently re-run it.
      const reason = (outcome as Extract<FireOutcome, { status: "approval_required" }>).reason;
      lease?.finish(key, ownerId, "PAUSED", reason);
      lastRunState.set(task.id, "PAUSED");
      task.updatedAt = toIso(at);
      advance(task, at);
      persist(task);
      result.parked.push(task.id);
      emit("scheduled_task.triggered", {
        taskId: task.id,
        title: task.title,
        action: task.action,
        firedAt: toIso(at),
        ok: false,
        parked: true,
        reason,
      });
      return;
    }

    // status === "failed"
    const error =
      (outcome as Extract<FireOutcome, { status: "failed" }>).error ??
      internalError("scheduled run failed", at);
    task.failureCount += 1;
    recordFailure(task, at, error.message);
    lease?.finish(key, ownerId, "FAILED", error.message);
    lastRunState.set(task.id, "FAILED");
    if (task.failureCount >= MAX_FAILURES) {
      // Bounded: stop retrying a permanently broken task.
      task.enabled = false;
      setNextRun(task, null);
    } else {
      // Still retryable — advance anyway so we do not hot-loop on the slot.
      advance(task, at);
    }
    task.updatedAt = toIso(at);
    persist(task);
    result.failed.push(task.id);
  }

  async function tick(now?: Date): Promise<TickResult> {
    const result: TickResult = {
      fired: [],
      skipped: [],
      alreadyExecuted: [],
      missed: [],
      parked: [],
      interrupted: [],
      failed: [],
    };
    // After stop() the scheduler is inert: the timer is gone and tick() is a
    // no-op until start() is called again.
    if (phase === "stopped") return result;
    if (ticking) return result;
    ticking = true;
    try {
      const at = now ?? clock();
      const atMs = at.getTime();
      const graceMs = opts.missedGraceMs ?? tickMs;

      const dueList = [...tasks.values()]
        .filter((task) => task.enabled && typeof task.nextRun === "string")
        .map((task) => {
          const at = Date.parse(task.nextRun as string);
          return { task, dueAt: at };
        })
        .filter((x) => Number.isFinite(x.dueAt) && x.dueAt <= atMs)
        // Ascending nextRun order: the scheduler runs the oldest promise first.
        .sort((a, b) => a.dueAt - b.dueAt);

      for (const { task, dueAt } of dueList) {
        await runOne(task, new Date(dueAt), at, atMs, graceMs, result);
      }

      // Housekeeping seam (daily work-summary offer). Contained: a throw here
      // must never stop the loop or lose the tick's own results.
      if (opts.onTick !== undefined) {
        try {
          opts.onTick(at);
        } catch (error) {
          emit("scheduler.tick_failed", {
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      ticking = false;
    }
    return result;
  }

  async function reload(): Promise<{ loaded: number; invalid: string[] }> {
    const at = clock();
    const invalid: string[] = [];
    let loaded = 0;

    tasks.clear();
    const persisted = store.listScheduledTasks();

    for (const task of persisted) {
      const check = validateSchedule(specFor(task));
      if (!check.ok) {
        // Malformed rows are reported and set aside, never deleted: the user's
        // data stays put and a fixed row is picked up on the next reload.
        task.enabled = false;
        setNextRun(task, null);
        task.updatedAt = toIso(at);
        persist(task);
        invalid.push(task.id);
        continue;
      }

      if (task.enabled) {
        // Preserve a persisted nextRun; it is the schedule the user (or the
        // last run) chose, and overwriting a healthy future slot with
        // "now + interval" on every restart would silently delay work. A
        // persisted nextRun that is *past* is kept too, on purpose: `tick`
        // then applies the NO DOUBLE FIRE rule and fires it at most once.
        //
        // Only when there is nothing usable to preserve do we compute a fresh
        // nextRun from `at`. `once` is always recomputed because its instant is
        // fixed in the row: a missed once-task has genuinely expired.
        const stored = typeof task.nextRun === "string" ? Date.parse(task.nextRun) : Number.NaN;
        const next =
          task.kind !== "once" && Number.isFinite(stored)
            ? new Date(stored)
            : computeNextRun(specFor(task), at);
        setNextRun(task, next);
        // A `once` task whose instant has passed can never run again.
        if (next === null && task.kind === "once") task.enabled = false;
        task.updatedAt = toIso(at);
        persist(task);
      }

      tasks.set(task.id, task);
      loaded += 1;
    }

    // Any lease a dead process left RUNNING is now INTERRUPTED, so a tick can
    // classify it rather than firing the slot a second time.
    if (lease !== undefined) {
      const swept = lease.sweepExpired(at);
      for (const record of swept) {
        lastRunState.set(record.taskId, "INTERRUPTED");
        emit("scheduled_task.triggered", {
          taskId: record.taskId,
          firedAt: toIso(at),
          ok: false,
          interrupted: true,
          reason: "lease expired without finishing; classified for recovery",
        });
      }
    }

    return { loaded, invalid };
  }

  function recoverInterrupted(now?: Date): { interrupted: LeaseRecord[] } {
    const at = now ?? clock();
    if (lease === undefined) return { interrupted: [] };
    const interrupted = lease.sweepExpired(at);
    for (const record of interrupted) lastRunState.set(record.taskId, "INTERRUPTED");
    return { interrupted };
  }

  function stateOf(taskId: string): TaskState {
    const task = tasks.get(taskId);
    if (task === undefined) return "UNKNOWN";
    if (inFlight.has(taskId)) return "RUNNING";

    const seen = lastRunState.get(taskId);
    if (seen === "PAUSED") return "WAITING_APPROVAL";
    if (seen === "INTERRUPTED") return "INTERRUPTED";
    if (alreadyExecutedFlag.has(taskId)) return "ALREADY_EXECUTED";

    if (!task.enabled) {
      if (task.failureCount >= MAX_FAILURES) return "QUARANTINED";
      if (seen === "MISSED") return "MISSED";
      return "COMPLETED";
    }
    if (seen === "FAILED") return "FAILED";
    if (seen === "MISSED") return "MISSED";

    const nextMs = typeof task.nextRun === "string" ? Date.parse(task.nextRun) : Number.NaN;
    if (!Number.isFinite(nextMs)) return "COMPLETED";
    return nextMs <= clock().getTime() ? "DUE" : "SCHEDULED";
  }

  function start(): void {
    if (phase === "running") return; // idempotent
    phase = "running";
    const handle = setInterval(() => {
      void tick();
    }, tickMs);
    // Never keep the host process alive on the scheduler's account; the Core
    // owns its own lifetime.
    if (typeof (handle as { unref?: () => void }).unref === "function") {
      (handle as { unref: () => void }).unref();
    }
    timer = handle;
    emit("scheduler.started", { tickMs });
  }

  function stop(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    if (phase === "stopped") return; // idempotent
    phase = "stopped";
    emit("scheduler.stopped", {});
  }

  function isRunning(): boolean {
    return phase === "running";
  }

  return { start, stop, reload, tick, recoverInterrupted, stateOf, isRunning };
}
