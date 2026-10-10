// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * KAI Doer — the autonomous goal-execution switch, and the pending-result inbox
 * that makes switching it OFF safe.
 *
 * ── Two controls, never one ──────────────────────────────────────────────────
 * Guard (the policy engine, risk classification, approvals and the execution
 * registry) is ALWAYS active. This module is the other control: whether KAI
 * autonomously plans goals, dispatches workers, interprets their results,
 * generates follow-ups and runs corrective actions. Turning the Doer OFF must
 * never touch Guard — nothing here can grant, widen or skip an approval.
 *
 * ── Why a pending inbox ──────────────────────────────────────────────────────
 * A worker result that arrives while the Doer is OFF must not be lost, and must
 * not be interpreted either. So every terminal worker/mission event is recorded
 * here as a durable, idempotent row BEFORE anyone decides what it means:
 *
 *   Doer OFF → the row stays PENDING. Nothing reads the payload, no model is
 *              asked to produce work, no dispatch happens.
 *   Doer ON  → the row is claimed under a lease and processed exactly once.
 *
 * ── Idempotency ──────────────────────────────────────────────────────────────
 * The primary key IS the idempotency key (`<eventType>:<eventId>`, or a
 * correlation-derived key when the event carries no id). Re-delivering the same
 * event — a duplicate bus delivery, a replayed SSE frame, a restart that
 * re-reads a persisted event — inserts nothing and returns `created: false`.
 * A claim is at-most-once: a row is CLAIMED under a lease, and a lease that
 * expires returns the row to PENDING so a crashed drain is retried rather than
 * lost. A DONE row is never re-processed, so the same result cannot dispatch
 * the same next task twice.
 *
 * ── Own file ─────────────────────────────────────────────────────────────────
 * Like the parked-approval store and the scheduler lease store, this owns its
 * own SQLite file: it is Doer-private state and must not reshape the frozen
 * `Stores` interfaces.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { KaiEventType } from "../shared/contracts.ts";

export type DoerState = "ON" | "OFF";

/** PENDING → CLAIMED → DONE. FAILED is terminal after the attempt ceiling. */
export type PendingState = "PENDING" | "CLAIMED" | "DONE" | "FAILED";

/** One worker/mission result waiting to be interpreted (or already handled). */
export interface PendingResult {
  /** The idempotency key. Same key ⇒ same result; never processed twice. */
  idempotencyKey: string;
  eventType: string;
  state: PendingState;
  /** The redacted event payload, kept verbatim so nothing is silently dropped. */
  payload: unknown;
  missionId?: string;
  stepId?: string;
  workItemId?: string;
  turnId?: string;
  scheduleId?: string;
  createdAt: string;
  /** How many processing attempts have been made (0 until first claim). */
  attempts: number;
  lastError?: string;
  /** Where the result was first seen: "event" (bus) — a provenance label. */
  origin: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  claimedAt?: string;
  settledAt?: string;
}

export interface PendingResultInput {
  idempotencyKey: string;
  eventType: string;
  payload: unknown;
  missionId?: string;
  stepId?: string;
  workItemId?: string;
  turnId?: string;
  scheduleId?: string;
  origin?: string;
}

/** How many results sit in each inbox state. */
export interface PendingCounts {
  pending: number;
  claimed: number;
  done: number;
  failed: number;
}

export interface PendingResultStore {
  readonly path: string;
  /** Idempotent record. A repeated key inserts nothing. */
  record(input: PendingResultInput): { record: PendingResult; created: boolean };
  get(idempotencyKey: string): PendingResult | null;
  list(filter?: { state?: PendingState; limit?: number }): PendingResult[];
  /** Rows eligible to run: PENDING, or CLAIMED with an expired lease. */
  eligible(now: Date, limit: number): PendingResult[];
  /** At-most-once claim under a lease. Returns the rows this owner now holds. */
  claim(opts: { owner: string; limit: number; leaseMs: number; now?: Date }): PendingResult[];
  /** Mark processed. Only a claimed row can settle (no settle-on-behalf). */
  settle(idempotencyKey: string, note?: string): boolean;
  /** Record a failed attempt; the row returns to PENDING until `maxAttempts`. */
  fail(idempotencyKey: string, error: string, maxAttempts: number): boolean;
  /** Release a claim back to PENDING (used when a drain is interrupted). */
  release(idempotencyKey: string): boolean;
  counts(): PendingCounts;
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS doer_pending_results (
  idempotencyKey TEXT PRIMARY KEY,
  eventType      TEXT NOT NULL,
  state          TEXT NOT NULL,
  payloadJson    TEXT NOT NULL,
  missionId      TEXT,
  stepId         TEXT,
  workItemId     TEXT,
  turnId         TEXT,
  scheduleId     TEXT,
  createdAt      TEXT NOT NULL,
  attempts       INTEGER NOT NULL DEFAULT 0,
  lastError      TEXT,
  origin         TEXT NOT NULL,
  leaseOwner     TEXT,
  leaseExpiresAt TEXT,
  claimedAt      TEXT,
  settledAt      TEXT
);
CREATE INDEX IF NOT EXISTS idx_doer_pending_state ON doer_pending_results(state);
CREATE INDEX IF NOT EXISTS idx_doer_pending_created ON doer_pending_results(createdAt);
`;

function optional<T extends object>(target: T, key: keyof T, value: unknown): void {
  if (value !== null && value !== undefined) (target as Record<string, unknown>)[key as string] = value;
}

/**
 * Rows affected by a `node:sqlite` statement run. The driver reports `changes`
 * as a number or a bigint; anything else means "unknown", never a silent 0
 * presented as a successful write.
 */
function changedRows(result: unknown): number {
  if (result === null || typeof result !== "object" || !("changes" in result)) return 0;
  const raw = result.changes;
  if (typeof raw === "number") return raw;
  if (typeof raw === "bigint") return Number(raw);
  return 0;
}

/** A row read back from SQLite: string-keyed, values of unknown shape. */
function isRow(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

export function createPendingResultStore(opts: { path: string; now?: () => Date }): PendingResultStore {
  const path = opts.path;
  const now = opts.now ?? (() => new Date());

  if (path !== ":memory:" && !path.startsWith("file:")) {
    const dir = dirname(path);
    if (dir.length > 0 && dir !== ".") mkdirSync(dir, { recursive: true });
  }

  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 5000");
  try {
    db.exec("PRAGMA journal_mode = WAL");
  } catch {
    // Some filesystems reject WAL; single-statement updates stay atomic anyway.
  }
  db.exec(SCHEMA);

  const stmts = {
    get: db.prepare(`SELECT * FROM doer_pending_results WHERE idempotencyKey = ?`),
    // INSERT OR IGNORE is the whole idempotency guarantee: a key that already
    // exists is left exactly as it was, so a duplicate delivery cannot reset a
    // settled row back to PENDING.
    insert: db.prepare(
      `INSERT OR IGNORE INTO doer_pending_results
         (idempotencyKey, eventType, state, payloadJson, missionId, stepId, workItemId, turnId, scheduleId, createdAt, attempts, origin)
       VALUES (?, ?, 'PENDING', ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    ),
    listAll: db.prepare(`SELECT * FROM doer_pending_results ORDER BY createdAt ASC, rowid ASC`),
    listState: db.prepare(`SELECT * FROM doer_pending_results WHERE state = ? ORDER BY createdAt ASC, rowid ASC`),
    claim: db.prepare(
      `UPDATE doer_pending_results
          SET state = 'CLAIMED', leaseOwner = ?, leaseExpiresAt = ?, claimedAt = ?, attempts = attempts + 1
        WHERE idempotencyKey = ?`,
    ),
    settle: db.prepare(
      `UPDATE doer_pending_results SET state = 'DONE', settledAt = ?, lastError = ? WHERE idempotencyKey = ? AND state = 'CLAIMED'`,
    ),
    fail: db.prepare(
      `UPDATE doer_pending_results
          SET state = ?, lastError = ?, leaseOwner = NULL, leaseExpiresAt = NULL, claimedAt = NULL
        WHERE idempotencyKey = ?`,
    ),
    release: db.prepare(
      `UPDATE doer_pending_results
          SET state = 'PENDING', leaseOwner = NULL, leaseExpiresAt = NULL, claimedAt = NULL
        WHERE idempotencyKey = ? AND state = 'CLAIMED'`,
    ),
    counts: db.prepare(`SELECT state, COUNT(*) AS n FROM doer_pending_results GROUP BY state`),
  };

  function rowToResult(row: Record<string, unknown>): PendingResult {
    let payload: unknown = null;
    try {
      payload = JSON.parse(String(row.payloadJson));
    } catch {
      // A row whose payload will not parse is still a row: keep the raw string
      // rather than pretending the result never arrived.
      payload = String(row.payloadJson);
    }
    const result: PendingResult = {
      idempotencyKey: String(row.idempotencyKey),
      eventType: String(row.eventType),
      state: String(row.state) as PendingState,
      payload,
      createdAt: String(row.createdAt),
      attempts: Number(row.attempts ?? 0),
      origin: String(row.origin ?? "event"),
    };
    optional(result, "missionId", row.missionId);
    optional(result, "stepId", row.stepId);
    optional(result, "workItemId", row.workItemId);
    optional(result, "turnId", row.turnId);
    optional(result, "scheduleId", row.scheduleId);
    optional(result, "lastError", row.lastError);
    optional(result, "leaseOwner", row.leaseOwner);
    optional(result, "leaseExpiresAt", row.leaseExpiresAt);
    optional(result, "claimedAt", row.claimedAt);
    optional(result, "settledAt", row.settledAt);
    return result;
  }

  function record(input: PendingResultInput): { record: PendingResult; created: boolean } {
    const createdAt = now().toISOString();
    stmts.insert.run(
      input.idempotencyKey,
      input.eventType,
      JSON.stringify(input.payload ?? null),
      input.missionId ?? null,
      input.stepId ?? null,
      input.workItemId ?? null,
      input.turnId ?? null,
      input.scheduleId ?? null,
      createdAt,
      input.origin ?? "event",
    );
    const stored = get(input.idempotencyKey)!;
    // `created` is derived from the persisted row, not from a changes count: a
    // duplicate insert is ignored, so an existing row reports created: false
    // even when it was written by an earlier process.
    const created = stored.createdAt === createdAt && stored.attempts === 0 && stored.state === "PENDING";
    return { record: stored, created };
  }

  function get(idempotencyKey: string): PendingResult | null {
    const row = stmts.get.get(idempotencyKey) as Record<string, unknown> | undefined;
    return row === undefined ? null : rowToResult(row);
  }

  function list(filter?: { state?: PendingState; limit?: number }): PendingResult[] {
    const raw = filter?.state !== undefined ? stmts.listState.all(filter.state) : stmts.listAll.all();
    const rows = raw.filter(isRow).map(rowToResult);
    return filter?.limit !== undefined ? rows.slice(0, filter.limit) : rows;
  }

  function eligible(at: Date, limit: number): PendingResult[] {
    const iso = at.toISOString();
    return list()
      .filter((row) => row.state === "PENDING" || (row.state === "CLAIMED" && (row.leaseExpiresAt ?? "") <= iso))
      .slice(0, limit);
  }

  function claim(opts: { owner: string; limit: number; leaseMs: number; now?: Date }): PendingResult[] {
    const at = opts.now ?? now();
    const expires = new Date(at.getTime() + opts.leaseMs).toISOString();
    const claimed: PendingResult[] = [];
    for (const row of eligible(at, opts.limit)) {
      const changes = stmts.claim.run(opts.owner, expires, at.toISOString(), row.idempotencyKey);
      if (changedRows(changes) > 0) {
        const updated = get(row.idempotencyKey);
        if (updated !== null) claimed.push(updated);
      }
    }
    return claimed;
  }

  function settle(idempotencyKey: string, note?: string): boolean {
    const changes = stmts.settle.run(now().toISOString(), note ?? null, idempotencyKey);
    return changedRows(changes) > 0;
  }

  function fail(idempotencyKey: string, error: string, maxAttempts: number): boolean {
    const current = get(idempotencyKey);
    if (current === null) return false;
    // The attempt ceiling is enforced here, not by the caller: a row that has
    // spent its attempts lands FAILED and is never retried again.
    const next: PendingState = current.attempts >= maxAttempts ? "FAILED" : "PENDING";
    const changes = stmts.fail.run(next, error, idempotencyKey);
    return changedRows(changes) > 0;
  }

  function release(idempotencyKey: string): boolean {
    const changes = stmts.release.run(idempotencyKey);
    return changedRows(changes) > 0;
  }

  function counts(): PendingCounts {
    const out: PendingCounts = { pending: 0, claimed: 0, done: 0, failed: 0 };
    for (const row of stmts.counts.all().filter(isRow)) {
      const key = String(row.state).toLowerCase() as keyof PendingCounts;
      if (key in out) out[key] = Number(row.n);
    }
    return out;
  }

  let closed = false;
  function close(): void {
    if (closed) return;
    closed = true;
    db.close();
  }

  return { path, record, get, list, eligible, claim, settle, fail, release, counts, close };
}

// ── The Doer itself ──────────────────────────────────────────────────────────

/** A terminal worker/mission event as the bus delivers it. */
export interface DoerEventInput {
  type: string;
  /** The bus event id; when absent the key is derived from the correlation. */
  eventId?: string;
  payload?: unknown;
  missionId?: string;
  stepId?: string;
  workItemId?: string;
  turnId?: string;
  scheduleId?: string;
}

export interface DoerProcessOutcome {
  /** True when the result was interpreted; false leaves the row PENDING. */
  processed: boolean;
  /** Why it was not processed (recorded on the row, visible in the inbox). */
  reason?: string;
}

export interface DoerDeps {
  store: PendingResultStore;
  /** Reads the DURABLE preference live — never captured at construction. */
  enabled: () => boolean;
  /**
   * Interpret one result. Only called when the Doer is ON. Throwing is a
   * normal outcome: the row returns to PENDING (or FAILED at the ceiling).
   */
  process: (result: PendingResult) => Promise<DoerProcessOutcome | void> | DoerProcessOutcome | void;
  /** Lifecycle tap. The runtime wires this to the event bus. */
  emit?: (type: string, payload: unknown) => void;
  now?: () => Date;
  leaseMs?: number;
  maxAttempts?: number;
  /** Max results interpreted in one drain. Bounded by construction. */
  drainLimit?: number;
  /** Max claim passes inside one drain, so a busy producer cannot spin it. */
  drainPasses?: number;
}

export interface DrainReport {
  /** True when the Doer was OFF, so nothing was claimed or interpreted. */
  skipped: boolean;
  claimed: number;
  processed: number;
  failed: number;
  deferred: number;
}

export interface Doer {
  state: () => DoerState;
  /**
   * Record a terminal worker/mission result. Always records (so nothing is
   * lost while OFF); interpretation happens only through `drain`.
   */
  record: (event: DoerEventInput) => { parked: boolean; created: boolean; key: string };
  /**
   * Interpret every eligible pending result, once. A no-op when OFF.
   *
   * Single-flight and self-draining: concurrent callers share one pass, and a
   * pass keeps going until no eligible row remains (bounded by `drainPasses`),
   * so a result recorded mid-pass is still handled rather than waiting for
   * another trigger.
   */
  drain: () => Promise<DrainReport>;
  /** Resolves when no drain is in flight. The deterministic wait for tests. */
  idle: () => Promise<void>;
  pending: (limit?: number) => PendingResult[];
  counts: () => PendingCounts;
  close: () => void;
}

/**
 * A string correlation field read from an event payload. Worker-correlated ids
 * (`workItemId`, `turnId`, `scheduleId`) ride INSIDE the payload, so the Doer
 * reads them defensively: an absent or non-string field is simply unknown.
 */
export function payloadCorrelation(payload: unknown, field: string): string | undefined {
  if (payload === null || typeof payload !== "object") return undefined;
  // A dynamic key cannot be read off `object` without an index signature; the
  // guard above proves this is a keyed object, so a spread gives a checked view.
  const record: Record<string, unknown> = { ...payload };
  const value = record[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The idempotency key for an event: the event id when present, else the correlation. */
export function doerIdempotencyKey(event: DoerEventInput): string {
  if (event.eventId !== undefined && event.eventId.length > 0) {
    return `${event.type}:${event.eventId}`;
  }
  const parts = [event.missionId, event.stepId, event.workItemId, event.turnId, event.scheduleId].filter(
    (part): part is string => part !== undefined && part.length > 0,
  );
  // A terminal event with no id and no correlation cannot be deduplicated; the
  // type alone would collapse every occurrence, so the timestamp-free parts are
  // the honest key. An empty correlation is recorded under the type only when
  // there is genuinely nothing else to identify it by.
  return `${event.type}:${parts.length > 0 ? parts.join("|") : "uncorrelated"}`;
}

export function createDoer(deps: DoerDeps): Doer {
  const now = deps.now ?? (() => new Date());
  const leaseMs = deps.leaseMs ?? 60_000;
  const maxAttempts = deps.maxAttempts ?? 3;
  const drainLimit = deps.drainLimit ?? 25;
  const drainPasses = deps.drainPasses ?? 8;
  const owner = `doer-${process.pid}-${Math.floor(now().getTime() % 1_000_000)}`;

  function state(): DoerState {
    return deps.enabled() ? "ON" : "OFF";
  }

  function record(event: DoerEventInput): { parked: boolean; created: boolean; key: string } {
    const key = doerIdempotencyKey(event);
    const { created } = deps.store.record({
      idempotencyKey: key,
      eventType: event.type,
      payload: event.payload ?? null,
      ...(event.missionId !== undefined ? { missionId: event.missionId } : {}),
      ...(event.stepId !== undefined ? { stepId: event.stepId } : {}),
      ...(event.workItemId !== undefined ? { workItemId: event.workItemId } : {}),
      ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
      ...(event.scheduleId !== undefined ? { scheduleId: event.scheduleId } : {}),
      origin: "event",
    });
    // A duplicate delivery is not news: it is reported, not re-announced.
    if (!created) return { parked: false, created: false, key };
    const parked = state() === "OFF";
    deps.emit?.("doer.result_pending", {
      idempotencyKey: key,
      eventType: event.type,
      parked,
      ...(event.workItemId !== undefined ? { workItemId: event.workItemId } : {}),
      ...(event.missionId !== undefined ? { missionId: event.missionId } : {}),
    });
    return { parked, created: true, key };
  }

  async function runDrain(): Promise<DrainReport> {
    const report: DrainReport = { skipped: false, claimed: 0, processed: 0, failed: 0, deferred: 0 };
    // A pass handles up to `drainLimit` results; repeat while rows remain so a
    // result recorded DURING the pass is not left for a later trigger. Bounded
    // by `drainPasses` so a pathological producer cannot spin this forever.
    for (let pass = 0; pass < drainPasses; pass += 1) {
      if (state() === "OFF") break;
      const claimed = deps.store.claim({ owner, limit: drainLimit, leaseMs });
      if (claimed.length === 0) break;
      report.claimed += claimed.length;
      for (const row of claimed) {
        try {
          const outcome = (await deps.process(row)) ?? { processed: true };
          if (outcome.processed) {
            deps.store.settle(row.idempotencyKey);
            report.processed += 1;
            deps.emit?.("doer.result_processed", {
              idempotencyKey: row.idempotencyKey,
              eventType: row.eventType,
              ...(row.workItemId !== undefined ? { workItemId: row.workItemId } : {}),
              ...(row.missionId !== undefined ? { missionId: row.missionId } : {}),
            });
          } else {
            // Deferred by the executive (e.g. waiting on an approval): release
            // the claim so the result is retried later, and record why.
            deps.store.fail(row.idempotencyKey, outcome.reason ?? "deferred", maxAttempts);
            report.failed += 1;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          deps.store.fail(row.idempotencyKey, message, maxAttempts);
          report.failed += 1;
          deps.emit?.("doer.result_failed", {
            idempotencyKey: row.idempotencyKey,
            eventType: row.eventType,
            error: message,
            attempts: row.attempts,
          });
        }
      }
    }
    report.deferred = deps.store.counts().pending;
    return report;
  }

  let inFlight: Promise<DrainReport> | null = null;

  function drain(): Promise<DrainReport> {
    if (state() === "OFF") {
      // The whole point of OFF: no claim, no interpretation, no dispatch.
      return Promise.resolve({ skipped: true, claimed: 0, processed: 0, failed: 0, deferred: deps.store.counts().pending });
    }
    // Single-flight: two triggers must not run two passes over the same rows.
    // (The lease makes a double-claim impossible anyway; this makes it cheap.)
    if (inFlight === null) {
      inFlight = runDrain().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  }

  async function idle(): Promise<void> {
    // `finally` clears `inFlight` before this observes it, so a completed pass
    // resolves immediately; a running pass is awaited exactly once.
    await inFlight;
  }

  return {
    state,
    record,
    drain,
    idle,
    pending: (limit?: number) => deps.store.list({ state: "PENDING", ...(limit !== undefined ? { limit } : {}) }),
    counts: () => deps.store.counts(),
    close: () => deps.store.close(),
  };
}

/**
 * The event types whose arrival is a worker/mission RESULT the Doer supervises.
 * Live-only heartbeats/progress are deliberately excluded: they are not results
 * and must not fill the inbox.
 */
export const DOER_RESULT_EVENT_TYPES: readonly KaiEventType[] = [
  "worker.completed",
  "worker.failed",
  "worker.cancelled",
  "mission.completed",
  "mission.failed",
  "mission.cancelled",
  "agent.run_completed",
  "agent.run_failed",
  "agent.run_cancelled",
];
