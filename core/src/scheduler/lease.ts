// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Durable run leases for the KAI Core scheduler.
 *
 * Why this exists (spec §36, Part F). A schedule's `nextRun` is persisted, but
 * "the instant is due" and "this process may run it" are not the same claim.
 * Two failure modes follow from treating them as one:
 *
 *   1. TWO PROCESSES, ONE SLOT. A Core restart overlapping its predecessor, or
 *      two Cores pointed at one database, both read `nextRun <= now` and both
 *      fire. No amount of in-memory guarding fixes this; the claim has to be
 *      made durably, once.
 *   2. CRASH MID-RUN. A process claims the slot, starts the job, and dies before
 *      it can advance `nextRun`. On restart the slot is still "due" and a naive
 *      scheduler fires it a second time — a double side effect.
 *
 * So a run is claimed with a *lease*: a row keyed by (taskId, scheduled slot),
 * written inside a `BEGIN IMMEDIATE` transaction so concurrent processes
 * serialize on it. The first claimant owns the slot; a second sees a live lease
 * and backs off. A lease that outlives its TTL without being finished is
 * INTERRUPTED, and the scheduler classifies it before deciding whether the work
 * may be replayed at all (see `recovery/`).
 *
 * This module owns its own SQLite file rather than adding columns to the frozen
 * `scheduled_tasks` table: it is scheduler-private state (what has been *run*,
 * not what is *scheduled*), and it must survive a restart alongside the schedule
 * itself. The path follows the same per-user convention as the main database.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Terminal and in-flight states a single scheduled run can be in. */
export type RunState =
  | "RUNNING" // claimed and executing right now
  | "DONE" // executed to completion
  | "FAILED" // execution threw / reported failure
  | "PAUSED" // blocked on an approval; must not be re-run silently
  | "MISSED" // skipped by the missed-task policy
  | "INTERRUPTED"; // the claiming process died before finishing

/** Run states that mean "this slot is settled and must not fire again". */
export const SETTLED_STATES: readonly RunState[] = ["DONE", "FAILED", "PAUSED", "MISSED"];

export interface LeaseRecord {
  key: string;
  /**
   * The durable execution identity of this occurrence: `scheduleId@<slotIso>`
   * (see `occurrenceId`). It is the ledger's primary key and is carried as its
   * own field so callers reason in occurrence terms rather than key-format
   * terms. One occurrence == one identity == at most one execution.
   */
  occurrenceId: string;
  taskId: string;
  /** The scheduled instant this lease is for (ISO-8601). */
  slot: string;
  ownerId: string;
  state: RunState;
  sideEffecting: boolean;
  createdAt: string;
  heartbeatAt: string;
  expiresAt: string;
  detail?: string;
}

export interface ClaimInput {
  taskId: string;
  slot: string;
  sideEffecting: boolean;
  ownerId: string;
}

export interface ClaimResult {
  /** True only when this caller now owns the slot and may run it. */
  acquired: boolean;
  /** The state of the lease after this call (RUNNING when acquired). */
  state: RunState;
  key: string;
  /** The durable occurrence identity this claim was for (`scheduleId@<slotIso>`). */
  occurrenceId: string;
  /** True when an expired RUNNING lease was taken over rather than a fresh one created. */
  reclaimed: boolean;
  /** The row as it stood before this call, when one existed (for classification). */
  previous?: LeaseRecord;
  reason: string;
}

export interface DurableLeaseStore {
  readonly path: string;
  readonly ownerId: string;
  /**
   * Atomically take the lease for (taskId, slot).
   *
   * `replayInterrupted` is the recovery decision made by the caller: only when
   * it is true (the work is known safe to repeat) may an INTERRUPTED slot be
   * re-claimed. The default is false, which is the whole point — an interrupted
   * side-effecting run is never silently repeated.
   */
  claim(input: ClaimInput, opts?: { replayInterrupted?: boolean }): ClaimResult;
  heartbeat(key: string, ownerId: string): boolean;
  finish(key: string, ownerId: string, state: Exclude<RunState, "RUNNING">, detail?: string): boolean;
  /**
   * Set the state of a lease regardless of which owner holds it.
   *
   * Used for recovery decisions made by a NEW process about a lease a DEAD one
   * left behind (there is nobody to match `ownerId` against): an interrupted
   * side-effecting slot is settled as MISSED so it can never be claimed again.
   * Refuses to touch a lease that is currently held and unexpired, so a live
   * owner cannot have its run tombstoned by a peer.
   */
  settle(key: string, state: Exclude<RunState, "RUNNING">, detail?: string): boolean;
  peek(key: string): LeaseRecord | null;
  listByTask(taskId: string): LeaseRecord[];
  /**
   * Mark every expired RUNNING lease INTERRUPTED and return them, so startup can
   * classify what a dead process left behind. Safe to call repeatedly.
   */
  sweepExpired(now?: Date): LeaseRecord[];
  /** Delete settled leases older than `beforeIso`. Returns the count removed. */
  purgeBefore(beforeIso: string): number;
  close(): void;
}

/**
 * The durable execution identity of ONE scheduled occurrence.
 *
 * Derived from the schedule id and the occurrence's due slot instant, so the
 * same slot always yields the same id across processes, restarts and clock
 * reads: `scheduleId@<slotIso>`. This string is the lease ledger's primary key,
 * which is what makes "one occurrence, at most one execution" a property of the
 * durable store rather than an in-memory promise.
 */
export function occurrenceId(scheduleId: string, slot: string): string {
  return `${scheduleId}@${slot}`;
}

/**
 * Stable key for a run slot. Retained as the historical name; it is exactly
 * `occurrenceId` and every caller that reasons about identity should prefer the
 * latter.
 */
export function leaseKey(taskId: string, slot: string): string {
  return occurrenceId(taskId, slot);
}

/** True when a run state means the slot is settled and must not fire again. */
export function isSettledState(state: RunState): boolean {
  return (SETTLED_STATES as readonly RunState[]).includes(state);
}

/**
 * Default lease TTL: 15 minutes.
 *
 * Long enough that an ordinary job (a mission, a worker task) finishes well
 * inside it, short enough that a crashed process does not leave a slot frozen
 * for a day. A longer-running job should heartbeat; a job that exceeds the TTL
 * without heartbeating is treated as interrupted, which is the safe direction.
 */
export const DEFAULT_LEASE_TTL_MS = 15 * 60_000;

export function defaultLeasePath(): string {
  const override = process.env.KAI_CORE_LEASE_DB?.trim();
  if (override !== undefined && override.length > 0) return override;
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, "KAI", "core", "kai-scheduler-leases.db");
  }
  const xdg = process.env.XDG_DATA_HOME?.trim();
  if (xdg !== undefined && xdg.length > 0) return join(xdg, "KAI", "core", "kai-scheduler-leases.db");
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "KAI", "core", "kai-scheduler-leases.db");
  }
  return join(homedir(), ".local", "share", "KAI", "core", "kai-scheduler-leases.db");
}

function toNum(value: unknown, fallback = 0): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toBool(value: unknown): boolean {
  return value === 1 || value === true || value === "1";
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS run_leases (
  key           TEXT PRIMARY KEY,
  occurrenceId  TEXT NOT NULL DEFAULT '',
  taskId        TEXT NOT NULL,
  slot          TEXT NOT NULL,
  ownerId       TEXT NOT NULL,
  state         TEXT NOT NULL,
  sideEffecting INTEGER NOT NULL DEFAULT 0,
  createdAt     TEXT NOT NULL,
  heartbeatAt   TEXT NOT NULL,
  expiresAt     TEXT NOT NULL,
  detail        TEXT
);
CREATE INDEX IF NOT EXISTS idx_run_leases_task  ON run_leases (taskId, slot);
CREATE INDEX IF NOT EXISTS idx_run_leases_state ON run_leases (state, expiresAt);
`;

/**
 * Bring an existing ledger file up to the current schema.
 *
 * `CREATE TABLE IF NOT EXISTS` never adds a column to a table that already
 * exists, so a ledger written by an earlier build has no `occurrenceId`. The
 * identity is derivable in full from (taskId, slot) — that is the whole point of
 * it — so the backfill cannot be wrong, and it runs before any read. This is an
 * extend, not a second mechanism.
 */
function ensureOccurrenceColumn(db: DatabaseSync): void {
  const columns = db.prepare(`PRAGMA table_info(run_leases)`).all() as unknown as Array<{
    name?: unknown;
  }>;
  if (!columns.some((column) => column.name === "occurrenceId")) {
    db.exec(`ALTER TABLE run_leases ADD COLUMN occurrenceId TEXT NOT NULL DEFAULT ''`);
  }
  db.exec(
    `UPDATE run_leases
        SET occurrenceId = taskId || '@' || slot
      WHERE occurrenceId IS NULL OR occurrenceId = ''`,
  );
  // The canonical key IS the occurrence identity. A ledger written before the
  // identity existed used a different key shape; rename it so a settled slot is
  // still recognised (and never fired a second time) after an upgrade. A row
  // whose canonical key is already taken is a duplicate for the same occurrence
  // and is dropped.
  db.exec(`UPDATE OR IGNORE run_leases SET key = occurrenceId WHERE key <> occurrenceId`);
  db.exec(`DELETE FROM run_leases WHERE key <> occurrenceId`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_run_leases_occ ON run_leases (occurrenceId)`);
}

export function createDurableLeaseStore(opts: {
  path?: string;
  now?: () => Date;
  ttlMs?: number;
  ownerId?: string;
} = {}): DurableLeaseStore {
  const path = opts.path ?? defaultLeasePath();
  const now = opts.now ?? (() => new Date());
  const ttlMs = opts.ttlMs === undefined || opts.ttlMs <= 0 ? DEFAULT_LEASE_TTL_MS : opts.ttlMs;
  const ownerId =
    opts.ownerId ??
    `pid${process.pid}_${now().getTime().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  if (path !== ":memory:" && !path.startsWith("file:")) {
    const dir = dirname(path);
    if (dir.length > 0 && dir !== ".") mkdirSync(dir, { recursive: true });
  }

  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 5000");
  try {
    db.exec("PRAGMA journal_mode = WAL");
  } catch {
    // WAL is unavailable for :memory: and some filesystems; the default journal
    // still gives us the BEGIN IMMEDIATE serialization the claim relies on.
  }
  db.exec(SCHEMA);
  ensureOccurrenceColumn(db);

  const stmts = {
    get: db.prepare(`SELECT * FROM run_leases WHERE key = ?`),
    listByTask: db.prepare(`SELECT * FROM run_leases WHERE taskId = ? ORDER BY slot ASC, rowid ASC`),
    insert: db.prepare(
      `INSERT INTO run_leases
         (key, occurrenceId, taskId, slot, ownerId, state, sideEffecting, createdAt, heartbeatAt, expiresAt, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    reclaim: db.prepare(
      `UPDATE run_leases
         SET ownerId = ?, heartbeatAt = ?, expiresAt = ?, detail = NULL
       WHERE key = ? AND state = 'RUNNING' AND expiresAt = ?`,
    ),
    /**
     * Classify an expired, unfinished side-effecting run as INTERRUPTED rather
     * than reclaiming it. Compare-and-set on the exact expiry we read, so two
     * processes racing here cannot both decide.
     */
    interruptExpired: db.prepare(
      `UPDATE run_leases
         SET state = 'INTERRUPTED', heartbeatAt = ?, detail = ?
       WHERE key = ? AND state = 'RUNNING' AND expiresAt = ?`,
    ),
    replayInterrupted: db.prepare(
      `UPDATE run_leases
         SET ownerId = ?, heartbeatAt = ?, expiresAt = ?, detail = ?
       WHERE key = ? AND state = 'INTERRUPTED'`,
    ),
    heartbeat: db.prepare(
      `UPDATE run_leases SET heartbeatAt = ?, expiresAt = ? WHERE key = ? AND ownerId = ?`,
    ),
    finish: db.prepare(
      `UPDATE run_leases SET state = ?, heartbeatAt = ?, detail = ? WHERE key = ? AND ownerId = ?`,
    ),
    settle: db.prepare(
      `UPDATE run_leases SET state = ?, heartbeatAt = ?, detail = ?
       WHERE key = ? AND (state <> 'RUNNING' OR expiresAt <= ?)`,
    ),
    sweep: db.prepare(
      `UPDATE run_leases SET state = 'INTERRUPTED', detail = 'process died before finishing'
       WHERE state = 'RUNNING' AND expiresAt <= ?`,
    ),
    listExpiredRunning: db.prepare(
      `SELECT * FROM run_leases WHERE state = 'RUNNING' AND expiresAt <= ?`,
    ),
    listInterrupted: db.prepare(`SELECT * FROM run_leases WHERE state = 'INTERRUPTED'`),
    purge: db.prepare(
      `DELETE FROM run_leases WHERE state IN ('DONE','FAILED','MISSED') AND heartbeatAt < ?`,
    ),
  };

  function rowToRecord(row: Record<string, unknown>): LeaseRecord {
    const record: LeaseRecord = {
      key: String(row.key),
      occurrenceId:
        typeof row.occurrenceId === "string" && row.occurrenceId.length > 0
          ? row.occurrenceId
          : String(row.key),
      taskId: String(row.taskId),
      slot: String(row.slot),
      ownerId: String(row.ownerId),
      state: String(row.state) as RunState,
      sideEffecting: toBool(row.sideEffecting),
      createdAt: String(row.createdAt),
      heartbeatAt: String(row.heartbeatAt),
      expiresAt: String(row.expiresAt),
    };
    if (typeof row.detail === "string") record.detail = row.detail;
    return record;
  }

  function inImmediate<T>(fn: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Preserve the original failure.
      }
      throw error;
    }
  }

  function claim(input: ClaimInput, claimOpts?: { replayInterrupted?: boolean }): ClaimResult {
    const at = now();
    const atIso = at.toISOString();
    const expiresAt = new Date(at.getTime() + ttlMs).toISOString();
    const key = occurrenceId(input.taskId, input.slot);

    return inImmediate(() => {
      const existingRow = stmts.get.get(key) as Record<string, unknown> | undefined;
      const existing = existingRow === undefined ? null : rowToRecord(existingRow);

      if (existing === null) {
        stmts.insert.run(
          key,
          key,
          input.taskId,
          input.slot,
          input.ownerId,
          "RUNNING",
          input.sideEffecting ? 1 : 0,
          atIso,
          atIso,
          expiresAt,
          null,
        );
        return {
          acquired: true,
          state: "RUNNING" as RunState,
          key,
          occurrenceId: key,
          reclaimed: false,
          reason: "claimed a fresh slot",
        };
      }

      if (existing.state === "RUNNING") {
        const expiresMs = Date.parse(existing.expiresAt);
        if (Number.isFinite(expiresMs) && expiresMs > at.getTime()) {
          return {
            acquired: false,
            state: "RUNNING" as RunState,
            key,
            occurrenceId: key,
            reclaimed: false,
            previous: existing,
            reason: `held by ${existing.ownerId} until ${existing.expiresAt}`,
          };
        }

        // Expired, and the owner never finished. For a SIDE-EFFECTING run this
        // is the dangerous case: the dead process may have completed the effect
        // (created the mission) before it died, so re-running would be a SECOND
        // execution. Unless the caller explicitly grants a replay, classify it
        // INTERRUPTED — a recovery decision — rather than reclaiming and firing.
        if (input.sideEffecting && claimOpts?.replayInterrupted !== true) {
          const result = stmts.interruptExpired.run(
            atIso,
            "expired before finishing; classified INTERRUPTED (not replayed)",
            key,
            existing.expiresAt,
          );
          const won = toNum(result.changes, 0) === 1;
          const after = won ? ("INTERRUPTED" as RunState) : (peekState(key) ?? existing.state);
          return {
            acquired: false,
            state: after,
            key,
            occurrenceId: key,
            reclaimed: false,
            previous: existing,
            reason: won
              ? "expired side-effecting lease classified INTERRUPTED; not replayed"
              : `another process changed the expired lease (now ${after})`,
          };
        }

        // Expired and safe to repeat (non-side-effecting, or an explicit replay
        // grant): take it over, compare-and-set on the exact expiry we read so
        // two reclaimers cannot both win.
        const result = stmts.reclaim.run(
          input.ownerId,
          atIso,
          expiresAt,
          key,
          existing.expiresAt,
        );
        const won = toNum(result.changes, 0) === 1;
        return {
          acquired: won,
          state: "RUNNING" as RunState,
          key,
          occurrenceId: key,
          reclaimed: won,
          previous: existing,
          reason: won
            ? `reclaimed an expired lease from ${existing.ownerId}`
            : "another process reclaimed the expired lease first",
        };
      }

      if (existing.state === "INTERRUPTED" && claimOpts?.replayInterrupted === true) {
        const result = stmts.replayInterrupted.run(
          input.ownerId,
          atIso,
          expiresAt,
          "replayed after recovery classified it safe",
          key,
        );
        const won = toNum(result.changes, 0) === 1;
        return {
          acquired: won,
          state: "RUNNING" as RunState,
          key,
          occurrenceId: key,
          reclaimed: won,
          previous: existing,
          reason: won ? "replayed an interrupted slot (recovery: safe)" : "interrupted slot vanished",
        };
      }

      // DONE / FAILED / PAUSED / MISSED / (INTERRUPTED without permission): the
      // slot is settled or unsafe to repeat. Do not fire.
      return {
        acquired: false,
        state: existing.state,
        key,
        occurrenceId: key,
        reclaimed: false,
        previous: existing,
        reason:
          existing.state === "INTERRUPTED"
            ? "interrupted run is not safe to replay"
            : `slot already settled as ${existing.state}`,
      };
    });
  }

  /** Current state of a key, narrowed to RunState, or null. */
  function peekState(key: string): RunState | null {
    const row = stmts.get.get(key) as Record<string, unknown> | undefined;
    return row === undefined ? null : (String(row.state) as RunState);
  }

  function heartbeat(key: string, owner: string): boolean {
    const at = now();
    const result = stmts.heartbeat.run(
      at.toISOString(),
      new Date(at.getTime() + ttlMs).toISOString(),
      key,
      owner,
    );
    return toNum(result.changes, 0) === 1;
  }

  function finish(
    key: string,
    owner: string,
    state: Exclude<RunState, "RUNNING">,
    detail?: string,
  ): boolean {
    const at = now();
    const result = stmts.finish.run(state, at.toISOString(), detail ?? null, key, owner);
    return toNum(result.changes, 0) === 1;
  }

  function settle(key: string, state: Exclude<RunState, "RUNNING">, detail?: string): boolean {
    const at = now();
    const result = stmts.settle.run(
      state,
      at.toISOString(),
      detail ?? null,
      key,
      at.toISOString(),
    );
    return toNum(result.changes, 0) === 1;
  }

  function peek(key: string): LeaseRecord | null {
    const row = stmts.get.get(key) as Record<string, unknown> | undefined;
    return row === undefined ? null : rowToRecord(row);
  }

  function listByTask(taskId: string): LeaseRecord[] {
    return (stmts.listByTask.all(taskId) as unknown as Record<string, unknown>[]).map(rowToRecord);
  }

  function sweepExpired(at?: Date): LeaseRecord[] {
    const cutoff = (at ?? now()).toISOString();
    return inImmediate(() => {
      const expired = (
        stmts.listExpiredRunning.all(cutoff) as unknown as Record<string, unknown>[]
      ).map(rowToRecord);
      if (expired.length > 0) stmts.sweep.run(cutoff);
      return expired;
    });
  }

  function purgeBefore(beforeIso: string): number {
    const result = stmts.purge.run(beforeIso);
    return toNum(result.changes, 0);
  }

  let closed = false;
  function close(): void {
    if (closed) return;
    closed = true;
    db.close();
  }

  return { path, ownerId, claim, heartbeat, finish, settle, peek, listByTask, sweepExpired, purgeBefore, close };
}
