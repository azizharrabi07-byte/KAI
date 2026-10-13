// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Louis Raillé — MIT (see repository LICENSE).

/**
 * The DEMO state machine.
 *
 * This is not decoration. A prototype whose commands print canned strings proves
 * nothing about the interaction model, so every command here mutates real
 * prototype state and the UI re-renders from it.
 *
 * What it deliberately models:
 *   - Doer and Guard are SEPARATE controls. Turning Doer off never turns Guard
 *     off, and the UI must not let them look like the same switch.
 *   - A goal's work is bound to ONE approved revision; re-planning invalidates the
 *     approval rather than silently reusing it.
 *   - Evidence carries its SOURCE, and a worker's claim is a weaker source than
 *     KAI's own observation.
 */

import {
  DEMO_APPROVALS,
  DEMO_EVENTS,
  DEMO_EVIDENCE,
  DEMO_GOALS,
  DEMO_MEMORY,
  DEMO_SKILLS,
  DEMO_TASKS,
  DEMO_WORKERS,
} from "./fixtures.js";

/** A deep clone, so two prototype sessions cannot share fixture objects. */
const clone = (value) => JSON.parse(JSON.stringify(value));

export function createDemoState() {
  const state = {
    /** Core connection is a demo toggle: `/doctor` and the header read it. */
    coreConnected: true,
    /** Doer is the autonomous-execution switch. */
    doer: "ON",
    /** Guard is NEVER switched off by a command in this prototype. */
    guard: "ON",
    /** The provider rate-limit demo, so the "rate-limited" state is reachable. */
    providerRateLimited: false,
    workspace: "C:/tmp/kai-demo-workspace",
    selectedGoalId: "g-1041",
    selectedWorkerId: "hermes",
    goals: clone(DEMO_GOALS),
    tasks: clone(DEMO_TASKS),
    workers: clone(DEMO_WORKERS),
    events: clone(DEMO_EVENTS),
    evidence: clone(DEMO_EVIDENCE),
    skills: clone(DEMO_SKILLS),
    memory: clone(DEMO_MEMORY),
    approvals: clone(DEMO_APPROVALS),
    /** Counters the tool/dispatch budget readouts use. */
    budget: { dispatch: { used: 2, max: 4 }, tool: { used: 6, max: 20 } },
    /** Every command the user typed, newest last. */
    history: [],
    /** The single demo clock all dynamically emitted events are stamped from. */
    clockMs: DEMO_CLOCK_START,
  };
  return state;
}

/**
 * The demo clock.
 *
 * A prototype must not stamp its fictional timeline with the machine's real UTC
 * clock: a feed whose newest event sits nine hours ahead of its own history reads
 * as a bug, and it makes two runs of the demo disagree. Every event is stamped
 * from this one monotonic clock instead, continuing the fixture timeline.
 */
const DEMO_CLOCK_START = Date.parse("2026-10-13T09:46:00Z");

function formatClock(ms) {
  const d = new Date(ms);
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}`;
}

/** Append an event, stamped from the demo clock. */
export function pushEvent(state, kind, text, source = "KAI-OBSERVED", ref = null) {
  state.clockMs += 1370; // a plausible gap between observations
  state.events.push({ at: formatClock(state.clockMs), kind, text, source, ref });
  if (state.events.length > 400) state.events.splice(0, state.events.length - 400);
}

export function goalById(state, id) {
  return state.goals.find((g) => g.id === id) ?? null;
}

export function taskById(state, id) {
  return state.tasks.find((t) => t.id === id) ?? null;
}

export function workerById(state, id) {
  return state.workers.find((w) => w.id === id) ?? null;
}

export function tasksForGoal(state, goalId) {
  return state.tasks.filter((t) => t.goalId === goalId);
}

/**
 * The counts the header and the graph read. Derived, never stored, so the UI
 * cannot show a total that disagrees with the board.
 */
export function taskCounts(state) {
  const counts = { total: state.tasks.length, COMPLETED: 0, RUNNING: 0, READY: 0, BLOCKED: 0, CHANGES_REQUESTED: 0 };
  for (const task of state.tasks) counts[task.state] = (counts[task.state] ?? 0) + 1;
  return counts;
}

/** A task is dispatchable when it is eligible AND the plan revision is approved. */
/**
 * States in which a worker already holds the claim.
 *
 * QUEUED is deliberately NOT here: it is the ready state a dispatch consumes
 * (`QUEUED -> DISPATCHING -> RUNNING`). Everything from DISPATCHING onwards has
 * been claimed, and a second dispatch of those would run the work twice.
 */
export const IN_FLIGHT = new Set(["DISPATCHING", "RUNNING", "VERIFYING", "REVIEWING"]);

export function isDispatchable(state, task) {
  const goal = goalById(state, task.goalId);
  if (goal === null) return { ok: false, reason: "the task has no goal" };
  if (goal.approvedRevision !== task.revisionId) {
    return { ok: false, reason: `bound to ${task.revisionId}, but ${goal.approvedRevision} is the approved revision` };
  }
  if (state.doer !== "ON") return { ok: false, reason: "Doer is OFF — autonomous dispatch is suspended" };
  if (task.state === "COMPLETED") return { ok: false, reason: "already complete" };
  // Never dispatch a task that is already in flight. Without this, a replayed
  // dispatch event — or an impatient second `/run` — would start the same work
  // twice, which is exactly the idempotency failure this state machine exists to
  // prevent.
  if (IN_FLIGHT.has(task.state)) return { ok: false, reason: `already in flight (${task.state}) — a dispatch is a single-use claim` };
  // BLOCKED before dependencies: a block is a decision the user has to make, and
  // reporting "waiting on t3" for a task that can never proceed would send them to
  // the wrong place.
  if (task.state === "BLOCKED") return { ok: false, reason: `blocked — ${task.blockReason ?? "it needs a decision, not another attempt"}` };
  const unmet = task.dependsOn.filter((dep) => taskById(state, dep)?.state !== "COMPLETED");
  if (unmet.length > 0) return { ok: false, reason: `waiting on ${unmet.join(", ")}` };
  return { ok: true, reason: "ready" };
}
