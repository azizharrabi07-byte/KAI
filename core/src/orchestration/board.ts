// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * KAI work board — the mutable workflow layer over the FROZEN orchestration
 * contracts (`orchestration/types.ts`) and the `WorkItemStore` interface
 * (`shared/contracts.ts`, implemented by `storage/sqlite.ts`).
 *
 * This module creates nothing but workflow: it never edits a shared contract,
 * never touches SQL, and never throws for domain conditions. Every mutator
 * returns `{ ok: true, value }` on success and `{ ok: false, reason }` on
 * unknown ids or budget refusals — callers switch on `ok`, never try/catch.
 *
 * Lifecycle (states are the frozen `WorkItemState` union):
 *   READY → CLAIMED → RUNNING → REVIEW → COMPLETED
 *              ↘ WAITING / BLOCKED (parked, re-claimable)
 *              ↘ CHANGES_REQUESTED (retries+1, re-claimable)
 *              ↘ FAILED / CANCELLED (terminal)
 *
 * `claim` moves an item to CLAIMED; the first `heartbeat` promotes CLAIMED to
 * RUNNING (a claimed worker that never heartbeats was never observed running).
 * `complete` lands COMPLETED only when `handoff.status === "ok"` — anything
 * else ("blocked" / "failed") lands FAILED, because a non-ok handoff is by
 * definition not a completion.
 *
 * Hierarchy: `createChild` enforces `budgets.maxDepth` (via `depthOf`) and
 * `budgets.maxChildren` (via stored child count) and refuses with
 * `{ ok: false, reason }` instead of throwing.
 *
 * Circuit breaker: `recordFailure` counts consecutive failures per
 * `workerId + taskType` in memory (never persisted — it is a live routing
 * signal, not work state). The 3rd consecutive failure trips the breaker and
 * returns a reassignment recommendation; `recordSuccess` resets the count.
 */

import type { WorkItemRecord, WorkItemStore } from "../shared/contracts.ts";
import type {
  ReviewRecord,
  VerificationRecord,
  WorkBudget,
  WorkCost,
  WorkItem,
  WorkItemState,
  WorkerHandoff,
} from "./types.ts";

// ── Result shape ─────────────────────────────────────────────────────────────

export type BoardOk<T> = { ok: true; value: T };
export type BoardErr = { ok: false; reason: string };
export type BoardResult<T> = BoardOk<T> | BoardErr;

// ── Inputs / options ─────────────────────────────────────────────────────────

export interface WorkItemInput {
  objective: string;
  deliverable?: string;
  missionId?: string;
  taskId?: string;
  parentId?: string;
  skills?: string[];
  tools?: string[];
}

export interface WorkBoardOptions {
  /** Defaults to `() => new Date().toISOString()`. Injected in tests. */
  now?: () => string;
  /** Live-only lifecycle tap: `(type, payload) => void`. Never persisted here. */
  onEvent?: (type: string, payload: unknown) => void;
}

export type BreakerAction = "reassign" | "change-strategy" | "ask" | "block";

export interface BreakerRecommendation {
  action: BreakerAction;
  reason: string;
  consecutiveFailures: number;
  workerId: string;
  taskType: string;
}

export interface FailureOutcome {
  item: WorkItem;
  consecutiveFailures: number;
  /** Present once the breaker trips (3+ consecutive failures). */
  recommendation: BreakerRecommendation | null;
}

export interface RetryStatus {
  retries: number;
  remaining: number;
  maxRetries: number;
}

// ── Board surface ────────────────────────────────────────────────────────────

export interface WorkBoard {
  create(input: WorkItemInput): BoardResult<WorkItem>;
  get(id: string): WorkItem | null;
  list(filter?: { state?: string; missionId?: string; taskId?: string; workerId?: string; limit?: number }): WorkItem[];
  children(parentId: string): WorkItem[];
  /** Depth of an item: roots are 0. Unknown ids (or cycles) yield -1. */
  depthOf(id: string): number;
  claim(id: string, workerId: string, workerVersion?: string): BoardResult<WorkItem>;
  heartbeat(id: string, step?: string, note?: string): BoardResult<WorkItem>;
  progress(id: string, label: string): BoardResult<WorkItem>;
  wait(id: string, reason: string): BoardResult<WorkItem>;
  block(id: string, reason: string): BoardResult<WorkItem>;
  complete(
    id: string,
    handoff: WorkerHandoff,
    extra?: { verification?: VerificationRecord; review?: ReviewRecord },
  ): BoardResult<WorkItem>;
  fail(id: string, reason: string): BoardResult<WorkItem>;
  cancel(id: string, reason?: string): BoardResult<WorkItem>;
  review(id: string, reviewerId: string): BoardResult<WorkItem>;
  changesRequested(id: string, findings: readonly string[]): BoardResult<WorkItem>;
  createChild(parentId: string, input: WorkItemInput, budgets?: WorkBudget): BoardResult<WorkItem>;
  /** Attach auxiliary outputs (e.g. parked approval linkage). Additive only. */
  annotate(id: string, outputs: unknown): BoardResult<WorkItem>;
  checkRetry(id: string, maxRetries: number): BoardResult<RetryStatus>;
  recordFailure(id: string, reason: string, workerId?: string, taskType?: string): BoardResult<FailureOutcome>;
  recordSuccess(workerId: string, taskType?: string): BoardResult<{ consecutiveFailures: number }>;
}

// ── Record conversion ────────────────────────────────────────────────────────
// `WorkItem` (typed orchestration view) and `WorkItemRecord` (stringly store
// view) are structurally identical; the store keeps `state` as a string and
// structured fields as `unknown`, so conversion is a cast, never a reshape.

function toRecord(item: WorkItem): WorkItemRecord {
  return {
    ...item,
    state: item.state as string,
  };
}

function fromRecord(record: WorkItemRecord): WorkItem {
  return {
    ...record,
    state: record.state as WorkItemState,
    handoff: record.handoff as WorkerHandoff | undefined,
    verification: record.verification as VerificationRecord | undefined,
    review: record.review as ReviewRecord | undefined,
    cost: record.cost as WorkCost | undefined,
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

// ── Factory ──────────────────────────────────────────────────────────────────

const HEARTBEAT_CAP = 50;
const BREAKER_TRIP_AT = 3;

export function createWorkBoard(store: WorkItemStore, opts: WorkBoardOptions = {}): WorkBoard {
  const now = opts.now ?? (() => new Date().toISOString());
  const emit = (type: string, payload: unknown): void => {
    opts.onEvent?.(type, payload);
  };

  let seq = 0;
  const consecutiveFailures = new Map<string, number>();
  const breakerKey = (workerId: string, taskType: string): string => `${workerId}::${taskType}`;

  function load(id: string): WorkItem | null {
    const row = store.get(id);
    return row === null ? null : fromRecord(row);
  }

  function save(item: WorkItem): WorkItem {
    item.updatedAt = now();
    store.upsert(toRecord(clone(item)));
    return clone(item);
  }

  function unknownId(id: string): BoardErr {
    return { ok: false, reason: `unknown work item: ${id}` };
  }

  function recommendFor(key: string, workerId: string, taskType: string, count: number): BreakerRecommendation {
    void key;
    const action: BreakerAction =
      count >= 6 ? "block" : count === 5 ? "ask" : count === 4 ? "change-strategy" : "reassign";
    return {
      action,
      reason: `${count} consecutive failures for worker "${workerId}" on "${taskType}"`,
      consecutiveFailures: count,
      workerId,
      taskType,
    };
  }

  const board: WorkBoard = {
    create(input: WorkItemInput): BoardResult<WorkItem> {
      const at = now();
      seq += 1;
      const item: WorkItem = {
        id: `work_${Date.now().toString(36)}_${seq}`,
        ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
        ...(input.missionId !== undefined ? { missionId: input.missionId } : {}),
        ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
        objective: input.objective,
        ...(input.deliverable !== undefined ? { deliverable: input.deliverable } : {}),
        skills: input.skills ?? [],
        tools: input.tools ?? [],
        state: "READY",
        attempts: 0,
        heartbeats: [],
        failures: [],
        retries: 0,
        createdAt: at,
        updatedAt: at,
      };
      store.upsert(toRecord(clone(item)));
      return { ok: true, value: clone(item) };
    },

    get(id: string): WorkItem | null {
      const item = load(id);
      return item === null ? null : clone(item);
    },

    list(filter?: { state?: string; missionId?: string; taskId?: string; workerId?: string; limit?: number }): WorkItem[] {
      return store.list(filter).map((row) => clone(fromRecord(row)));
    },

    children(parentId: string): WorkItem[] {
      return store.children(parentId).map((row) => clone(fromRecord(row)));
    },

    depthOf(id: string): number {
      const seen = new Set<string>();
      let depth = 0;
      let current = load(id);
      if (current === null) return -1;
      while (current.parentId !== undefined) {
        if (seen.has(current.id)) return -1;
        seen.add(current.id);
        if (seen.size > 1000) return -1;
        const parent = load(current.parentId);
        if (parent === null) return -1;
        depth += 1;
        current = parent;
      }
      return depth;
    },

    claim(id: string, workerId: string, workerVersion?: string): BoardResult<WorkItem> {
      const item = load(id);
      if (item === null) return unknownId(id);
      item.workerId = workerId;
      if (workerVersion !== undefined) item.workerVersion = workerVersion;
      item.state = "CLAIMED";
      item.attempts += 1;
      const saved = save(item);
      emit("worker.started", { id, workerId, ...(workerVersion !== undefined ? { workerVersion } : {}), attempts: saved.attempts });
      return { ok: true, value: saved };
    },

    heartbeat(id: string, step?: string, note?: string): BoardResult<WorkItem> {
      const item = load(id);
      if (item === null) return unknownId(id);
      const at = now();
      item.heartbeats.push({
        at,
        ...(step !== undefined ? { step } : {}),
        ...(note !== undefined ? { note } : {}),
      });
      if (item.heartbeats.length > HEARTBEAT_CAP) {
        item.heartbeats.splice(0, item.heartbeats.length - HEARTBEAT_CAP);
      }
      const createdMs = Date.parse(item.createdAt);
      const atMs = Date.parse(at);
      if (Number.isFinite(createdMs) && Number.isFinite(atMs)) {
        item.latencyMs = Math.max(0, atMs - createdMs);
      }
      if (item.state === "CLAIMED") item.state = "RUNNING";
      const saved = save(item);
      emit("worker.heartbeat", { id, ...(step !== undefined ? { step } : {}), ...(note !== undefined ? { note } : {}), at });
      return { ok: true, value: saved };
    },

    progress(id: string, label: string): BoardResult<WorkItem> {
      const item = load(id);
      if (item === null) return unknownId(id);
      const saved = save(item);
      emit("worker.progress", { id, label, workerId: item.workerId });
      return { ok: true, value: saved };
    },

    wait(id: string, reason: string): BoardResult<WorkItem> {
      const item = load(id);
      if (item === null) return unknownId(id);
      item.state = "WAITING";
      const saved = save(item);
      emit("worker.waiting", { id, reason, workerId: item.workerId });
      return { ok: true, value: saved };
    },

    block(id: string, reason: string): BoardResult<WorkItem> {
      const item = load(id);
      if (item === null) return unknownId(id);
      item.state = "BLOCKED";
      const saved = save(item);
      emit("worker.waiting", { id, reason, blocked: true, workerId: item.workerId });
      return { ok: true, value: saved };
    },

    complete(
      id: string,
      handoff: WorkerHandoff,
      extra?: { verification?: VerificationRecord; review?: ReviewRecord },
    ): BoardResult<WorkItem> {
      const item = load(id);
      if (item === null) return unknownId(id);
      const at = now();
      const passed = handoff.status === "ok";
      item.handoff = clone(handoff);
      // The orchestrator's verification (criteria + evidence) wins when
      // provided; the bare handoff check is the fallback, never a downgrade
      // of a reviewed pass.
      item.verification = extra?.verification ?? { passed, criteria: [], at };
      if (extra?.review !== undefined) item.review = clone(extra.review);
      item.state = passed ? "COMPLETED" : "FAILED";
      const saved = save(item);
      emit(passed ? "worker.completed" : "worker.failed", {
        id,
        workerId: item.workerId,
        status: handoff.status,
        passed,
      });
      return { ok: true, value: saved };
    },

    fail(id: string, reason: string): BoardResult<WorkItem> {
      const item = load(id);
      if (item === null) return unknownId(id);
      item.failures.push(reason);
      item.state = "FAILED";
      const saved = save(item);
      emit("worker.failed", { id, reason, workerId: item.workerId });
      return { ok: true, value: saved };
    },

    cancel(id: string, reason?: string): BoardResult<WorkItem> {
      const item = load(id);
      if (item === null) return unknownId(id);
      item.state = "CANCELLED";
      const saved = save(item);
      emit("worker.cancelled", { id, workerId: item.workerId, ...(reason !== undefined ? { reason } : {}) });
      return { ok: true, value: saved };
    },

    review(id: string, reviewerId: string): BoardResult<WorkItem> {
      const item = load(id);
      if (item === null) return unknownId(id);
      item.state = "REVIEW";
      const saved = save(item);
      emit("worker.review", { id, reviewerId, workerId: item.workerId });
      return { ok: true, value: saved };
    },

    changesRequested(id: string, findings: readonly string[]): BoardResult<WorkItem> {
      const item = load(id);
      if (item === null) return unknownId(id);
      const at = now();
      item.state = "CHANGES_REQUESTED";
      item.retries += 1;
      item.review = {
        reviewerId: item.review?.reviewerId ?? "unknown",
        criteria: item.review?.criteria ?? [],
        verdict: "CHANGES_REQUESTED",
        findings: [...findings],
        at,
      };
      const saved = save(item);
      emit("review.decided", { id, verdict: "CHANGES_REQUESTED", findings: [...findings], retries: saved.retries });
      return { ok: true, value: saved };
    },

    annotate(id: string, outputs: unknown): BoardResult<WorkItem> {
      const item = load(id);
      if (item === null) return unknownId(id);
      item.outputs = outputs;
      const saved = save(item);
      return { ok: true, value: saved };
    },

    createChild(parentId: string, input: WorkItemInput, budgets?: WorkBudget): BoardResult<WorkItem> {
      const parent = load(parentId);
      if (parent === null) return { ok: false, reason: `unknown parent: ${parentId}` };
      const depth = board.depthOf(parentId) + 1;
      if (budgets?.maxDepth !== undefined && depth > budgets.maxDepth) {
        return { ok: false, reason: `maxDepth exceeded: depth ${depth} > maxDepth ${budgets.maxDepth}` };
      }
      if (budgets?.maxChildren !== undefined) {
        const count = store.children(parentId).length;
        if (count >= budgets.maxChildren) {
          return { ok: false, reason: `maxChildren exceeded: ${count} >= maxChildren ${budgets.maxChildren}` };
        }
      }
      return board.create({ ...input, parentId });
    },

    checkRetry(id: string, maxRetries: number): BoardResult<RetryStatus> {
      const item = load(id);
      if (item === null) return unknownId(id);
      if (item.retries >= maxRetries) {
        return { ok: false, reason: `retry budget exhausted: retries ${item.retries} >= maxRetries ${maxRetries}` };
      }
      return { ok: true, value: { retries: item.retries, remaining: maxRetries - item.retries, maxRetries } };
    },

    recordFailure(id: string, reason: string, workerId?: string, taskType?: string): BoardResult<FailureOutcome> {
      const item = load(id);
      if (item === null) return unknownId(id);
      const worker = workerId ?? item.workerId ?? "unknown";
      const task = taskType ?? "general";
      item.failures.push(reason);
      item.state = "FAILED";
      const saved = save(item);
      const key = breakerKey(worker, task);
      const count = (consecutiveFailures.get(key) ?? 0) + 1;
      consecutiveFailures.set(key, count);
      const recommendation = count >= BREAKER_TRIP_AT ? recommendFor(key, worker, task, count) : null;
      emit("worker.failed", {
        id,
        reason,
        workerId: worker,
        taskType: task,
        consecutiveFailures: count,
        ...(recommendation !== null ? { recommendation } : {}),
      });
      return { ok: true, value: { item: saved, consecutiveFailures: count, recommendation } };
    },

    recordSuccess(workerId: string, taskType = "general"): BoardResult<{ consecutiveFailures: number }> {
      consecutiveFailures.set(breakerKey(workerId, taskType), 0);
      return { ok: true, value: { consecutiveFailures: 0 } };
    },
  };

  return board;
}
