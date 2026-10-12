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
  SkillReceipt,
  VerificationRecord,
  VerifiedEvidence,
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
  /** The goal and the exact plan revision that authorise this item. */
  goalId?: string;
  goalRevisionId?: string;
  parentId?: string;
  skills?: string[];
  tools?: string[];
  /** Acceptance criteria (default: derived from the deliverable at gate time). */
  criteria?: string[];
  constraints?: string[];
  forbiddenOutcomes?: string[];
  requiredEvidence?: string[];
  evidenceLinks?: Record<string, string[]>;
  budget?: WorkBudget;
  workingDir?: string;
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
  /**
   * The ROOT of this item's corrective tree — the chain identity.
   *
   * Budget is scoped to the chain, not the item: `createChild` gives every child
   * a fresh per-item allowance, so without a shared chain identity a parent could
   * multiply its allowance by spawning siblings (they are all depth 1, so
   * `maxDepth` never trips). Returns the item's own id when it has no parent, and
   * "" for an unknown id.
   */
  chainRootOf(id: string): string;
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
  /**
   * Append KAI-observed (or worker-reported, labeled) evidence records,
   * deduped by record id. The trust split lives on each record's `source` —
   * the board stores, never adjudicates.
   */
  recordEvidence(id: string, records: VerifiedEvidence[]): BoardResult<WorkItem>;
  /**
   * Persist the parsed worker handoff IMMEDIATELY, before review or evidence
   * gathering. A run that parks (review ASK, guarded evidence check) must not
   * lose what the worker actually said: the resume path re-gates on this
   * handoff, and an absent one would make a resumable item unresolvable.
   */
  recordHandoff(id: string, handoff: WorkerHandoff): BoardResult<WorkItem>;
  /**
   * Append skill usage receipts (id + version/hash + bytes), deduped by
   * id@hash. What was handed to the worker, checkably.
   */
  recordSkillReceipts(id: string, receipts: SkillReceipt[]): BoardResult<WorkItem>;
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
  const item = {
    ...record,
    state: record.state as WorkItemState,
    handoff: record.handoff as WorkerHandoff | undefined,
    verification: record.verification as VerificationRecord | undefined,
    review: record.review as ReviewRecord | undefined,
    cost: record.cost as WorkCost | undefined,
  } as WorkItem;
  // Additive contract fields (Phase 5): rows written before they existed
  // read back as undefined — normalize so every reader sees arrays.
  if (!Array.isArray(item.criteria)) item.criteria = [];
  if (!Array.isArray(item.constraints)) item.constraints = [];
  if (!Array.isArray(item.forbiddenOutcomes)) item.forbiddenOutcomes = [];
  if (!Array.isArray(item.requiredEvidence)) item.requiredEvidence = [];
  if (!Array.isArray(item.skills)) item.skills = [];
  if (!Array.isArray(item.skillReceipts)) item.skillReceipts = [];
  if (!Array.isArray(item.tools)) item.tools = [];
  if (!Array.isArray(item.evidence)) item.evidence = [];
  if (!Array.isArray(item.failures)) item.failures = [];
  if (!Array.isArray(item.heartbeats)) item.heartbeats = [];
  return item;
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
        ...(input.goalId !== undefined ? { goalId: input.goalId } : {}),
        ...(input.goalRevisionId !== undefined ? { goalRevisionId: input.goalRevisionId } : {}),
        objective: input.objective,
        ...(input.deliverable !== undefined ? { deliverable: input.deliverable } : {}),
        // Contract fields ride the item from creation to the Gate (Phase 5):
        // anything the API accepted is persisted here, never dropped.
        criteria: [...(input.criteria ?? [])],
        constraints: [...(input.constraints ?? [])],
        forbiddenOutcomes: [...(input.forbiddenOutcomes ?? [])],
        requiredEvidence: [...(input.requiredEvidence ?? [])],
        ...(input.evidenceLinks !== undefined ? { evidenceLinks: { ...input.evidenceLinks } } : {}),
        ...(input.budget !== undefined ? { budget: { ...input.budget } } : {}),
        ...(input.workingDir !== undefined ? { workingDir: input.workingDir } : {}),
        skills: input.skills ?? [],
        skillReceipts: [],
        tools: input.tools ?? [],
        evidence: [],
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

    chainRootOf(id: string): string {
      const seen = new Set<string>();
      let current = load(id);
      if (current === null) return "";
      while (current.parentId !== undefined) {
        if (seen.has(current.id)) return current.id;
        seen.add(current.id);
        if (seen.size > 1000) return current.id;
        const parent = load(current.parentId);
        if (parent === null) return current.id;
        current = parent;
      }
      return current.id;
    },

    claim(id: string, workerId: string, workerVersion?: string): BoardResult<WorkItem> {
      const item = load(id);
      if (item === null) return unknownId(id);
      // Idempotent dispatch guard (Phase 2C/12-10): a duplicate run/completion
      // event must never double-execute. CLAIMED/RUNNING means a worker holds
      // it right now. COMPLETED/CANCELLED are settled; BLOCKED is parked by a
      // deny that re-running would bypass. Re-claim is allowed from READY
      // (first run), FAILED (bounded retry re-entry — budgets bind it), and
      // CHANGES_REQUESTED/WAITING/REVIEW (resume paths re-enter deliberately).
      if (item.state === "CLAIMED" || item.state === "RUNNING") {
        return {
          ok: false,
          reason: `work item ${id} is already ${item.state}${item.workerId !== undefined ? ` by ${item.workerId}` : ""} — duplicate dispatch refused`,
        };
      }
      if (item.state === "COMPLETED" || item.state === "CANCELLED" || item.state === "BLOCKED") {
        return { ok: false, reason: `work item ${id} is ${item.state} — create a new item instead of re-running it` };
      }
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

    recordEvidence(id: string, records: VerifiedEvidence[]): BoardResult<WorkItem> {
      const item = load(id);
      if (item === null) return unknownId(id);
      const have = new Set((item.evidence ?? []).map((record) => record.id));
      for (const record of records) {
        if (have.has(record.id)) continue;
        have.add(record.id);
        item.evidence.push(clone(record));
      }
      const saved = save(item);
      emit("worker.progress", { id, phase: "evidence", count: saved.evidence.length });
      return { ok: true, value: saved };
    },

    recordHandoff(id: string, handoff: WorkerHandoff): BoardResult<WorkItem> {
      const item = load(id);
      if (item === null) return unknownId(id);
      item.handoff = clone(handoff);
      const saved = save(item);
      return { ok: true, value: saved };
    },

    recordSkillReceipts(id: string, receipts: SkillReceipt[]): BoardResult<WorkItem> {
      const item = load(id);
      if (item === null) return unknownId(id);
      const have = new Set((item.skillReceipts ?? []).map((receipt) => `${receipt.id}@${receipt.hash ?? receipt.version ?? "?"}`));
      for (const receipt of receipts) {
        const key = `${receipt.id}@${receipt.hash ?? receipt.version ?? "?"}`;
        if (have.has(key)) continue;
        have.add(key);
        item.skillReceipts.push(clone(receipt));
      }
      const saved = save(item);
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
      // The reason is RECORDED, not merely emitted. `block` takes a reason and used
      // to discard it into an event, so a blocked item could not say why it was
      // blocked after the process that blocked it was gone — the exact information
      // a human needs to decide what to do next.
      item.failures.push(reason);
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
      // ADDITIVE BY CONTRACT ("attach auxiliary outputs … additive only"), and
      // now actually implemented that way. It used to REPLACE the whole outputs
      // object, so parking a run for an approval silently dropped the persisted
      // Outcome Contract, the resume keys and the dispatch ledger — which is
      // exactly the durable state a resume, a duplicate event or the retry
      // ceiling depends on.
      const previous = item.outputs;
      const base: Record<string, unknown> =
        previous !== null && typeof previous === "object" && !Array.isArray(previous)
          ? { ...(previous as Record<string, unknown>) }
          : {};
      if (outputs !== null && typeof outputs === "object" && !Array.isArray(outputs)) {
        for (const [key, value] of Object.entries(outputs as Record<string, unknown>)) {
          if (value === undefined) delete base[key];
          else base[key] = value;
        }
      }
      item.outputs = base;
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
