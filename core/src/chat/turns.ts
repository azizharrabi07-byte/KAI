// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * One turn, end to end, the same way for `/chat` (router) and `/chat/stream`
 * (server): the task lifecycle around the brain call.
 *
 * The lifecycle exists because a tool execution is not a completion. Every
 * turn opens (or resumes) a TASK carrying the ORIGINAL OBJECTIVE, and the
 * turn only COMPLETES when the user-facing deliverable exists:
 *
 *   RECEIVED -> UNDERSTANDING -> PLANNING -> EXECUTING -> VERIFYING
 *     -> SYNTHESIZING -> COMPLETED
 *
 * Failure path: EXECUTING -> BLOCKED|PAUSED (+ explanation) -> the user says
 * "continue" and `beginTurn` resumes from the first unfinished step instead
 * of restarting generic work.
 */

import { isContinueText, type TaskTracker } from "./tasks.ts";

/** The tool-call facts verification needs: names, outcomes, approvals. */
export interface TurnToolCall {
  id: string;
  name: string;
  toolId?: string;
  ok: boolean;
  status: string;
  arguments: string;
  approvalId?: string;
}

export interface TurnBrainResult {
  text: string;
  toolCalls?: TurnToolCall[];
  toolIterations: number;
  toolBudgetExhausted: boolean;
  synthesized: boolean;
  pendingTools?: string[];
}

export interface TurnBegin {
  /** The task this turn works (new or resumed). Null when no session scope. */
  taskId: string | null;
  /** What the brain should answer: original text, or the resume prompt. */
  effectiveText: string;
  /** The original objective (== text for a fresh turn). */
  objective: string;
  resumed: boolean;
}

/**
 * Open or resume the session's task. A "continue" with an open task resumes
 * it (the brain gets the resume prompt + the objective); anything else starts
 * a new task and supersedes the old one.
 */
export function beginTurn(tracker: TaskTracker | undefined, sessionId: string | undefined, text: string): TurnBegin {
  const fallback: TurnBegin = { taskId: null, effectiveText: text, objective: text, resumed: false };
  if (tracker === undefined || sessionId === undefined) return fallback;
  if (isContinueText(text)) {
    const open = tracker.active(sessionId);
    if (open !== null) {
      tracker.move(open.id, "EXECUTING");
      return { taskId: open.id, effectiveText: tracker.resumePrompt(open), objective: open.objective, resumed: true };
    }
    return fallback;
  }
  const task = tracker.begin(sessionId, text);
  tracker.move(task.id, "UNDERSTANDING");
  return { taskId: task.id, effectiveText: text, objective: text, resumed: false };
}

export interface TurnFinish {
  /** The text to deliver (brain text, or the honest pause message). */
  replyText: string;
  /** Terminal or open lifecycle state after this turn. */
  state: string;
  resumed: boolean;
}

/**
 * Verify the brain's result against the task and close (or honestly pause)
 * the lifecycle. Verification is structural, never prose judgment:
 *
 * - non-empty text + nothing pending  -> COMPLETED
 * - budget exhausted / empty after synthesis -> PAUSED with completed-vs-
 *   remaining spelled out (the reply says so; it never pretends completion)
 * - brain failure is recorded BLOCKED by the caller (it owns the catch)
 */
export function finishTurn(
  tracker: TaskTracker | undefined,
  begin: TurnBegin,
  result: TurnBrainResult,
): TurnFinish {
  if (tracker === undefined || begin.taskId === null) {
    return { replyText: result.text, state: "COMPLETED", resumed: begin.resumed };
  }
  const taskId = begin.taskId;
  tracker.move(taskId, "VERIFYING");
  const steps = (result.toolCalls ?? []).map((call) => ({
    label: call.toolId ?? call.name,
    status: call.status === "APPROVAL_REQUIRED" ? "waiting" : call.ok ? "done" : "failed",
    ...(call.approvalId !== undefined ? { detail: call.approvalId } : {}),
  }));
  tracker.track(taskId, {
    steps,
    pendingTools: result.pendingTools ?? [],
    verification: JSON.stringify({
      at: new Date().toISOString(),
      deliverable: result.text.trim().length > 0,
      pending: (result.pendingTools ?? []).length === 0,
      synthesized: result.synthesized,
      budgetExhausted: result.toolBudgetExhausted,
    }),
    ...(result.synthesized ? { synthesis: "tools-disabled final pass" } : {}),
  });
  const hasDeliverable = result.text.trim().length > 0;
  const nothingPending = (result.pendingTools ?? []).length === 0;
  if (result.synthesized || (hasDeliverable && nothingPending)) {
    // The guard authored the closing text, or the turn finished cleanly:
    // COMPLETED. A pending remainder alongside a synthesis is recorded in
    // verification + pendingTools, never a reason to void a readable answer.
    // But progress text with the budget cut and no synthesis is NOT a
    // deliverable — that pauses honestly below.
    tracker.move(taskId, "COMPLETED");
    return { replyText: result.text, state: "COMPLETED", resumed: begin.resumed };
  }
  // No deliverable, or cut off mid-work with only progress narration to show:
  // PAUSED with the truth, never a progress preamble dressed as an answer.
  tracker.move(taskId, "PAUSED");
  const current = tracker.read(taskId);
  const replyText = current !== null ? tracker.pauseMessage(current) : result.text;
  return { replyText, state: "PAUSED", resumed: begin.resumed };
}
