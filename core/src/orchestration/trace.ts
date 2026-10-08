// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Activity trace — the bounded, level-filtered operator log.
 *
 * Vocabulary is FROZEN in `types.ts` (ActivityEvent, ActivityKind, TraceLevel,
 * ReasoningMode); storage is FROZEN in `shared/contracts.ts` (ActivityStore).
 * This module owns only the filtering/formatting policy between them:
 *
 * - OFF drops everything (record returns null, emit never fires).
 * - COMPACT records the operator-visible spine
 *   (plan/tool/worker/review/approval/verify/done, plus error) and strips
 *   detail payloads — except errors, whose details are always visible.
 * - VERBOSE records every kind with full details.
 * - Reasoning summaries are stored only when reasoning is not HIDDEN.
 * - Boundedness lives in the store (it prunes on write); this module just
 *   calls append and never caches events itself.
 *
 * Emit mapping uses ONLY orchestration-owned event names (worker.*,
 * review.*, delegation.routed, benchmark.updated). It never fabricates core
 * event types such as approval.requested or memory.created.
 */

import type { ActivityStore } from "../shared/contracts.ts";
import type { ActivityEvent, ActivityKind, ReasoningMode, TraceLevel } from "./types.ts";

export interface TraceRef {
  taskId?: string;
  workItemId?: string;
  workerId?: string;
}

export interface TracePrefs {
  activity: TraceLevel;
  reasoning: ReasoningMode;
}

export interface TraceDeps {
  store: ActivityStore;
  /** Live prefs reader (usually readOrchestrationPrefs over SettingsStore). Read per call. */
  prefs: () => TracePrefs;
  /** Optional live bus fan-out. Receives orchestration-owned names only. */
  emit?: (type: string, payload: unknown) => void;
}

/** Kinds visible at COMPACT: the operator spine plus errors (always visible). */
export const COMPACT_KINDS: readonly ActivityKind[] = [
  "plan",
  "tool",
  "worker",
  "review",
  "approval",
  "verify",
  "done",
  "error",
];

/**
 * Kind -> orchestration-owned event name. Every value is a member of the
 * orchestration lifecycle vocabulary (worker.*, review.*, delegation.routed,
 * benchmark.updated) — never a core type like approval.requested.
 */
export const KIND_TO_EVENT: Record<ActivityKind, string> = {
  plan: "delegation.routed",
  tool: "worker.progress",
  worker: "worker.progress",
  review: "worker.review",
  approval: "review.requested",
  verify: "review.decided",
  memory: "worker.progress",
  skill: "benchmark.updated",
  error: "worker.failed",
  done: "worker.completed",
};

export function isCompactKind(kind: string): kind is ActivityKind {
  return (COMPACT_KINDS as readonly string[]).includes(kind);
}

export interface ActivityTrace {
  record(ref: TraceRef, kind: ActivityKind, label: string, detail?: string): ActivityEvent | null;
  reasoningSummary(ref: TraceRef, label: string, text: string): ActivityEvent | null;
  list(ref: TraceRef, level?: TraceLevel): ActivityEvent[];
}

export function createTrace(deps: TraceDeps): ActivityTrace {
  function record(ref: TraceRef, kind: ActivityKind, label: string, detail?: string): ActivityEvent | null {
    const prefs = deps.prefs();
    if (prefs.activity === "OFF") return null;
    if (prefs.activity === "COMPACT" && !isCompactKind(kind)) return null;
    const at = new Date().toISOString();
    const seq = deps.store.append({
      ...(ref.taskId !== undefined ? { taskId: ref.taskId } : {}),
      ...(ref.workItemId !== undefined ? { workItemId: ref.workItemId } : {}),
      ...(ref.workerId !== undefined ? { workerId: ref.workerId } : {}),
      kind,
      label,
      ...(detail !== undefined ? { detail } : {}),
      at,
    });
    const event: ActivityEvent = {
      seq,
      ...(ref.taskId !== undefined ? { taskId: ref.taskId } : {}),
      ...(ref.workItemId !== undefined ? { workItemId: ref.workItemId } : {}),
      ...(ref.workerId !== undefined ? { workerId: ref.workerId } : {}),
      kind,
      label,
      ...(detail !== undefined ? { detail } : {}),
      at,
    };
    const name = KIND_TO_EVENT[kind];
    if (name !== undefined) deps.emit?.(name, event);
    return event;
  }

  /**
   * Stored as kind "done" with label `Reasoning: ${label}` and the summary as
   * detail — a compact status unit, never chain-of-thought. Dropped entirely
   * when reasoning is HIDDEN (or when the activity level drops "done").
   */
  function reasoningSummary(ref: TraceRef, label: string, text: string): ActivityEvent | null {
    if (deps.prefs().reasoning === "HIDDEN") return null;
    if (text.trim().length === 0) return null;
    return record(ref, "done", `Reasoning: ${label}`, text);
  }

  function list(ref: TraceRef, level?: TraceLevel): ActivityEvent[] {
    const effective = level ?? deps.prefs().activity;
    if (effective === "OFF") return [];
    const records = deps.store.list({
      ...(ref.taskId !== undefined ? { taskId: ref.taskId } : {}),
      ...(ref.workItemId !== undefined ? { workItemId: ref.workItemId } : {}),
    });
    const out: ActivityEvent[] = [];
    for (const r of records) {
      if (effective === "COMPACT") {
        if (!isCompactKind(r.kind)) continue;
        out.push({
          seq: r.seq,
          ...(r.taskId !== undefined ? { taskId: r.taskId } : {}),
          ...(r.workItemId !== undefined ? { workItemId: r.workItemId } : {}),
          ...(r.workerId !== undefined ? { workerId: r.workerId } : {}),
          kind: r.kind as ActivityKind,
          label: r.label,
          // Errors always keep their details; everything else hides payloads.
          ...(r.kind === "error" && r.detail !== undefined ? { detail: r.detail } : {}),
          at: r.at,
        });
      } else {
        out.push({
          seq: r.seq,
          ...(r.taskId !== undefined ? { taskId: r.taskId } : {}),
          ...(r.workItemId !== undefined ? { workItemId: r.workItemId } : {}),
          ...(r.workerId !== undefined ? { workerId: r.workerId } : {}),
          kind: r.kind as ActivityKind,
          label: r.label,
          ...(r.detail !== undefined ? { detail: r.detail } : {}),
          at: r.at,
        });
      }
    }
    return out;
  }

  return { record, reasoningSummary, list };
}
