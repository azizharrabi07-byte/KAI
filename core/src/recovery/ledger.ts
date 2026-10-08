// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Durable acceptance ledger (Part H).
 *
 * The rule this module exists to enforce:
 *
 *     BEFORE ACCEPT  -> replay may be safe
 *     AFTER ACCEPT   -> do NOT blindly replay
 *     UNKNOWN        -> treat as unsafe
 *
 * A "side effect" is anything that touches the world: sending, writing,
 * publishing, deleting. If KAI crashes mid-operation it must be able to answer,
 * on the next start, one question about each such operation: *had it crossed the
 * acceptance boundary?* Only with a durable answer can a restart choose between
 * "replay is safe" and "that would double-apply".
 *
 * The ordering that makes the answer sound: a side-effecting operation records
 * `begin()` (BEFORE_ACCEPT), then records `accept()` (AFTER_ACCEPT) as the point
 * of no return, and only THEN performs the effect. The consequence is the
 * property the brief demands — a crash can never produce
 * unknown -> retry -> duplicate side effect:
 *
 *   - crash before `accept()` -> BEFORE_ACCEPT -> the effect was never started
 *     (it happens after accept), so replay cannot duplicate anything;
 *   - crash at/after `accept()` -> AFTER_ACCEPT -> the effect may or may not
 *     have happened, so we do NOT replay;
 *   - no record at all, or an unreadable one -> UNKNOWN -> unsafe, no replay.
 *
 * `accept()` is a single guarded SQL statement (`... WHERE phase='BEFORE_ACCEPT'`),
 * so the boundary is crossed exactly once even if two callers race; `accept()`
 * from a second caller reports `accepted: false` rather than incrementing the
 * side-effect count a second time.
 *
 * This ledger owns its own SQLite file, like the scheduler lease store: it is
 * recovery-private state that must survive a crash, and it does not reshape the
 * frozen store interfaces.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** The acceptance phase of an execution. */
export type ExecutionPhase = "BEFORE_ACCEPT" | "AFTER_ACCEPT" | "UNKNOWN";

export type ExecutionStatus = "RUNNING" | "COMPLETED" | "FAILED";

export interface ExecutionRecord {
  executionId: string;
  kind: string;
  refId?: string;
  stepId?: string;
  slot?: string;
  sideEffecting: boolean;
  phase: ExecutionPhase;
  status: ExecutionStatus;
  ownerId: string;
  /** 0 until the boundary is crossed, exactly 1 afterwards. */
  sideEffectCount: number;
  startedAt: string;
  acceptedAt?: string;
  finishedAt?: string;
  detail?: string;
}

export interface Classification {
  executionId: string;
  phase: ExecutionPhase;
  status: ExecutionStatus | "UNKNOWN";
  sideEffecting: boolean;
  sideEffectCount: number;
  /** May this execution be replayed without risking a duplicate side effect? */
  replaySafe: boolean;
  reason: string;
}

export interface BeginInput {
  executionId: string;
  kind: string;
  refId?: string;
  stepId?: string;
  slot?: string;
  sideEffecting?: boolean;
  ownerId?: string;
}

export interface ExecutionLedger {
  readonly path: string;
  /** Record the start. Idempotent: an existing execution is returned unchanged. */
  begin(input: BeginInput): { created: boolean; record: ExecutionRecord };
  /** Cross the acceptance boundary, exactly once. */
  accept(executionId: string, note?: string): { accepted: boolean; record: ExecutionRecord | null };
  /**
   * Undo a crossing while the effect is still known NOT to have happened.
   *
   * Used by the boundary runner when the step parks on approval: `accept()` was
   * recorded defensively before the effect, the action then asked for a human and
   * did nothing, so the boundary is rewound to BEFORE_ACCEPT. Rewinding is sound
   * precisely because "asked for approval" means the effect did not run; it is
   * never used after a real effect.
   */
  rollbackAccept(executionId: string, note?: string): boolean;
  complete(executionId: string, note?: string): boolean;
  fail(executionId: string, reason?: string): boolean;
  get(executionId: string): ExecutionRecord | null;
  /** The recovery answer for one execution. */
  classify(executionId: string): Classification;
  /** Every non-terminal execution (what a restart must decide about). */
  listOpen(): ExecutionRecord[];
  /**
   * EVERY persisted record, settled or not, oldest first.
   *
   * `listOpen()` answers "what still needs a recovery decision?"; this answers
   * "what has this ledger ever recorded?". A caller that only counted
   * `listOpen()` would report a healthy ledger with settled history as an empty
   * one — the defect this method exists to make impossible.
   */
  listAll(): ExecutionRecord[];
  listByRef(refId: string): ExecutionRecord[];
  close(): void;
}

export function defaultLedgerPath(): string {
  const override = process.env.KAI_CORE_LEDGER_DB?.trim();
  if (override !== undefined && override.length > 0) return override;
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, "KAI", "core", "kai-recovery-ledger.db");
  }
  const xdg = process.env.XDG_DATA_HOME?.trim();
  if (xdg !== undefined && xdg.length > 0) return join(xdg, "KAI", "core", "kai-recovery-ledger.db");
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "KAI", "core", "kai-recovery-ledger.db");
  }
  return join(homedir(), ".local", "share", "KAI", "core", "kai-recovery-ledger.db");
}

/** Deterministic id for a mission step execution. */
export function executionIdFor(refId: string, stepId: string, attempt = 0): string {
  return `exec_${refId}_${stepId}${attempt > 0 ? `_${attempt}` : ""}`;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS executions (
  executionId     TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,
  refId           TEXT,
  stepId          TEXT,
  slot            TEXT,
  sideEffecting   INTEGER NOT NULL DEFAULT 1,
  phase           TEXT NOT NULL,
  status          TEXT NOT NULL,
  ownerId         TEXT NOT NULL,
  sideEffectCount INTEGER NOT NULL DEFAULT 0,
  startedAt       TEXT NOT NULL,
  acceptedAt      TEXT,
  finishedAt      TEXT,
  detail          TEXT
);
CREATE INDEX IF NOT EXISTS idx_executions_status ON executions (status, startedAt);
CREATE INDEX IF NOT EXISTS idx_executions_ref    ON executions (refId, stepId);
`;

const PHASES: readonly ExecutionPhase[] = ["BEFORE_ACCEPT", "AFTER_ACCEPT"];
const STATUSES: readonly ExecutionStatus[] = ["RUNNING", "COMPLETED", "FAILED"];

function toNum(value: unknown, fallback = 0): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toBool(value: unknown): boolean {
  return value === 1 || value === true || value === "1";
}

function optional<T extends object>(target: T, key: keyof T, value: unknown): void {
  if (value !== null && value !== undefined) {
    (target as Record<string, unknown>)[key as string] = value;
  }
}

export function createExecutionLedger(opts: {
  path?: string;
  now?: () => Date;
  ownerId?: string;
} = {}): ExecutionLedger {
  const path = opts.path ?? defaultLedgerPath();
  const now = opts.now ?? (() => new Date());
  const defaultOwner =
    opts.ownerId ?? `owner_${process.pid}_${now().getTime().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

  if (path !== ":memory:" && !path.startsWith("file:")) {
    const dir = dirname(path);
    if (dir.length > 0 && dir !== ".") mkdirSync(dir, { recursive: true });
  }

  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 5000");
  try {
    db.exec("PRAGMA journal_mode = WAL");
  } catch {
    // Some filesystems / :memory: reject WAL; the default journal still gives us
    // atomic single-statement updates, which is all the accept boundary needs.
  }
  db.exec(SCHEMA);

  const stmts = {
    get: db.prepare(`SELECT * FROM executions WHERE executionId = ?`),
    insert: db.prepare(
      `INSERT OR IGNORE INTO executions
         (executionId, kind, refId, stepId, slot, sideEffecting, phase, status, ownerId,
          sideEffectCount, startedAt, acceptedAt, finishedAt, detail)
       VALUES (?, ?, ?, ?, ?, ?, 'BEFORE_ACCEPT', 'RUNNING', ?, 0, ?, NULL, NULL, NULL)`,
    ),
    accept: db.prepare(
      `UPDATE executions
         SET phase = 'AFTER_ACCEPT', sideEffectCount = 1, acceptedAt = ?, detail = COALESCE(?, detail)
       WHERE executionId = ? AND phase = 'BEFORE_ACCEPT'`,
    ),
    rollbackAccept: db.prepare(
      `UPDATE executions
         SET phase = 'BEFORE_ACCEPT', sideEffectCount = 0, acceptedAt = NULL, detail = COALESCE(?, detail)
       WHERE executionId = ? AND phase = 'AFTER_ACCEPT' AND status = 'RUNNING'`,
    ),
    complete: db.prepare(
      `UPDATE executions SET status = 'COMPLETED', finishedAt = ?, detail = COALESCE(?, detail) WHERE executionId = ?`,
    ),
    fail: db.prepare(
      `UPDATE executions SET status = 'FAILED', finishedAt = ?, detail = COALESCE(?, detail) WHERE executionId = ?`,
    ),
    listOpen: db.prepare(`SELECT * FROM executions WHERE status = 'RUNNING' ORDER BY startedAt ASC, rowid ASC`),
    listAll: db.prepare(`SELECT * FROM executions ORDER BY startedAt ASC, rowid ASC`),
    listByRef: db.prepare(`SELECT * FROM executions WHERE refId = ? ORDER BY startedAt ASC, rowid ASC`),
  };

  function rowToRecord(row: Record<string, unknown>): ExecutionRecord {
    const phase = String(row.phase) as ExecutionPhase;
    const status = String(row.status) as ExecutionStatus;
    const record: ExecutionRecord = {
      executionId: String(row.executionId),
      kind: String(row.kind),
      sideEffecting: toBool(row.sideEffecting),
      phase: (PHASES as readonly string[]).includes(phase) ? phase : "UNKNOWN",
      status: (STATUSES as readonly string[]).includes(status) ? status : "RUNNING",
      ownerId: String(row.ownerId),
      sideEffectCount: toNum(row.sideEffectCount),
      startedAt: String(row.startedAt),
    };
    optional(record, "refId", row.refId);
    optional(record, "stepId", row.stepId);
    optional(record, "slot", row.slot);
    optional(record, "acceptedAt", row.acceptedAt);
    optional(record, "finishedAt", row.finishedAt);
    optional(record, "detail", row.detail);
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
        // preserve original
      }
      throw error;
    }
  }

  function begin(input: BeginInput): { created: boolean; record: ExecutionRecord } {
    const at = now().toISOString();
    return inImmediate(() => {
      const existing = stmts.get.get(input.executionId) as Record<string, unknown> | undefined;
      if (existing !== undefined) {
        return { created: false, record: rowToRecord(existing) };
      }
      const ownerId = input.ownerId ?? defaultOwner;
      stmts.insert.run(
        input.executionId,
        input.kind,
        input.refId ?? null,
        input.stepId ?? null,
        input.slot ?? null,
        input.sideEffecting === false ? 0 : 1,
        ownerId,
        at,
      );
      const row = stmts.get.get(input.executionId) as Record<string, unknown> | undefined;
      return { created: true, record: rowToRecord(row as Record<string, unknown>) };
    });
  }

  function accept(executionId: string, note?: string): { accepted: boolean; record: ExecutionRecord | null } {
    const at = now().toISOString();
    return inImmediate(() => {
      const result = stmts.accept.run(at, note ?? null, executionId);
      const accepted = toNum(result.changes, 0) === 1;
      const row = stmts.get.get(executionId) as Record<string, unknown> | undefined;
      return { accepted, record: row === undefined ? null : rowToRecord(row) };
    });
  }

  function complete(executionId: string, note?: string): boolean {
    return toNum(stmts.complete.run(now().toISOString(), note ?? null, executionId).changes, 0) === 1;
  }

  function rollbackAccept(executionId: string, note?: string): boolean {
    return toNum(stmts.rollbackAccept.run(note ?? null, executionId).changes, 0) === 1;
  }

  function fail(executionId: string, reason?: string): boolean {
    return toNum(stmts.fail.run(now().toISOString(), reason ?? null, executionId).changes, 0) === 1;
  }

  function get(executionId: string): ExecutionRecord | null {
    const row = stmts.get.get(executionId) as Record<string, unknown> | undefined;
    return row === undefined ? null : rowToRecord(row);
  }

  function classify(executionId: string): Classification {
    const record = get(executionId);
    if (record === null) {
      return {
        executionId,
        phase: "UNKNOWN",
        status: "UNKNOWN",
        sideEffecting: true,
        sideEffectCount: 0,
        replaySafe: false,
        reason: "no durable record of this execution; an unknown effect is treated as unsafe",
      };
    }
    if (record.phase === "UNKNOWN") {
      return {
        executionId,
        phase: "UNKNOWN",
        status: record.status,
        sideEffecting: record.sideEffecting,
        sideEffectCount: record.sideEffectCount,
        replaySafe: false,
        reason: "the execution record is unreadable; an unknown effect is treated as unsafe",
      };
    }
    if (record.status === "COMPLETED") {
      return {
        executionId,
        phase: record.phase,
        status: "COMPLETED",
        sideEffecting: record.sideEffecting,
        sideEffectCount: record.sideEffectCount,
        replaySafe: false,
        reason: "already completed; nothing to replay",
      };
    }
    if (record.phase === "AFTER_ACCEPT") {
      return {
        executionId,
        phase: "AFTER_ACCEPT",
        status: record.status,
        sideEffecting: record.sideEffecting,
        sideEffectCount: record.sideEffectCount,
        replaySafe: false,
        reason: "the acceptance boundary was crossed; do not blindly replay",
      };
    }
    // BEFORE_ACCEPT and not completed: the effect had not been committed.
    return {
      executionId,
      phase: "BEFORE_ACCEPT",
      status: record.status,
      sideEffecting: record.sideEffecting,
      sideEffectCount: record.sideEffectCount,
      replaySafe: true,
      reason: "before the acceptance boundary; replay may be safe",
    };
  }

  function listOpen(): ExecutionRecord[] {
    return (stmts.listOpen.all() as unknown as Record<string, unknown>[]).map(rowToRecord);
  }

  function listAll(): ExecutionRecord[] {
    return (stmts.listAll.all() as unknown as Record<string, unknown>[]).map(rowToRecord);
  }

  function listByRef(refId: string): ExecutionRecord[] {
    return (stmts.listByRef.all(refId) as unknown as Record<string, unknown>[]).map(rowToRecord);
  }

  let closed = false;
  function close(): void {
    if (closed) return;
    closed = true;
    db.close();
  }

  return { path, begin, accept, rollbackAccept, complete, fail, get, classify, listOpen, listAll, listByRef, close };
}
