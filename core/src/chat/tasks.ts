// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The task lifecycle: KAI must not mistake "a tool ran" for "the task is done".
 *
 * Every user turn opens (or resumes) a TASK that carries the ORIGINAL
 * OBJECTIVE through planning, execution, verification and synthesis to a
 * terminal state. The lifecycle:
 *
 *   RECEIVED -> UNDERSTANDING -> PLANNING -> EXECUTING -> VERIFYING
 *     -> SYNTHESIZING -> COMPLETED
 *
 * Failure path:
 *
 *   EXECUTING -> BLOCKED|PAUSED (+ EXPLAIN) -> RECOVER / ASK USER / STOP
 *
 * Completion requires the requested user-facing deliverable — never merely a
 * tool execution, a search result, a found file, a spawned agent or a created
 * plan. "continue" resumes the active non-terminal task from its first
 * unfinished step instead of restarting generic work.
 */

import type { TaskRecord, TaskStore } from "../shared/contracts.ts";

/**
 * States a turn can be in while work is in flight. Resumability is wider:
 * PAUSED and BLOCKED tasks are also resumed by "continue" (only COMPLETED
 * and SUPERSEDED are terminal) — see the `activeTask` query.
 */
export const TASK_OPEN_STATES = ["RECEIVED", "UNDERSTANDING", "PLANNING", "EXECUTING", "VERIFYING", "SYNTHESIZING"] as const;

/** Short messages that mean "resume the open task", not "start over". */
const CONTINUE_RE = /^(continue|go on|keep going|carry on|proceed|go ahead|yes( do it| continue| go on| please continue)?|please continue|keep it coming)\.?$/i;

/** True when the text is a continuation of open work rather than a new request. */
export function isContinueText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && trimmed.length <= 24 && CONTINUE_RE.test(trimmed);
}

export interface TaskTracker {
  /** Open a task for this turn's objective (superseding any open one). */
  begin(sessionId: string, objective: string): TaskRecord;
  /** The session's resumable task, if any. */
  active(sessionId: string): TaskRecord | null;
  /** Read one task by id (null when gone). */
  read(id: string): TaskRecord | null;
  /** Move a task to a new state (no-op when the task is gone). */
  move(id: string, state: TaskRecord["state"]): void;
  /** Replace plan/steps/pendingTools (no-op when the task is gone). */
  track(id: string, patch: Partial<Pick<TaskRecord, "plan" | "steps" | "pendingTools" | "verification" | "synthesis">>): void;
  /** Build the resume prompt for "continue": objective + progress + missing deliverable. */
  resumePrompt(task: TaskRecord): string;
  /** Honest pause message from task state: completed X, remaining Y. */
  pauseMessage(task: TaskRecord): string;
}

let taskSeq = 0;

export function createTaskTracker(store: TaskStore): TaskTracker {
  const now = (): string => new Date().toISOString();

  function begin(sessionId: string, objective: string): TaskRecord {
    const open = store.activeTask(sessionId);
    const at = now();
    if (open !== null) {
      // A new objective supersedes open work — recorded, never silently dropped.
      store.updateTask(open.id, { state: "SUPERSEDED" }, at);
    }
    taskSeq += 1;
    const task: TaskRecord = {
      id: `task_${Date.now().toString(36)}_${taskSeq.toString(36)}`,
      sessionId,
      objective,
      plan: [],
      steps: [],
      state: "RECEIVED",
      pendingTools: [],
      verification: null,
      synthesis: null,
      createdAt: at,
      updatedAt: at,
    };
    store.createTask(task);
    return task;
  }

  function active(sessionId: string): TaskRecord | null {
    return store.activeTask(sessionId);
  }

  function move(id: string, state: TaskRecord["state"]): void {
    store.updateTask(id, { state }, now());
  }

  function track(
    id: string,
    patch: Partial<Pick<TaskRecord, "plan" | "steps" | "pendingTools" | "verification" | "synthesis">>,
  ): void {
    store.updateTask(id, patch, now());
  }

  function resumePrompt(task: TaskRecord): string {
    const done = task.steps.filter((s) => s.status === "done").map((s) => s.label);
    const lines = [
      `Original objective (do not lose this): ${task.objective}`,
      done.length > 0 ? `Already completed — do NOT repeat: ${done.join("; ")}.` : "Nothing completed yet.",
      task.pendingTools.length > 0
        ? `Planned calls that never ran: ${task.pendingTools.join(", ")}.`
        : "No pending tool calls recorded.",
      "Continue from the first unfinished step. End with the deliverable the objective asked for, not more progress narration.",
    ];
    return lines.join("\n");
  }

  function pauseMessage(task: TaskRecord): string {
    const done = task.steps.filter((s) => s.status === "done").map((s) => s.label);
    const completed = done.length > 0 ? done.slice(0, 6).join(", ") + (done.length > 6 ? ` (+${done.length - 6} more)` : "") : "the searches above";
    const remaining = task.pendingTools.length > 0
      ? `these planned calls never ran: ${task.pendingTools.slice(0, 6).join(", ")}`
      : `the deliverable for "${task.objective.slice(0, 120)}"`;
    return (
      `Task paused because the execution budget was reached. Completed: ${completed}. ` +
      `Remaining: ${remaining}. Say continue and I'll pick up from the first unfinished step.`
    );
  }

  function read(id: string): TaskRecord | null {
    return store.getTask(id);
  }

  return { begin, active, read, move, track, resumePrompt, pauseMessage };
}
