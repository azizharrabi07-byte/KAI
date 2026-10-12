// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The authoritative execution budget.
 *
 * ## Why this exists
 *
 * The retry budget that used to guard dispatch was enforced **per work item**,
 * from the item's own dispatch ledger. That is necessary and it is not enough.
 * A corrective child, a replan, or any caller that creates a *new* item for the
 * same goal task arrives with a fresh allowance, so the same goal could spend
 * unbounded attempts while every individual item stayed inside its own limit:
 * `maxDepth` bounds how DEEP a corrective tree goes, not how many siblings it
 * has. Ten children of one parent are all depth 1.
 *
 * This ledger is the missing authority. It is:
 *
 *   - **Durable** — a SQLite table, so a restart cannot restore spent budget.
 *   - **Scoped to the execution chain** — `(goalId, planRevisionId, chainId)`.
 *     Siblings in one chain share ONE allowance; a genuinely new approved plan
 *     revision is the deliberate act that grants a new one.
 *   - **Reserved BEFORE the work is dispatched** — the debit happens before the
 *     side effect, so a crash mid-dispatch cannot replay the work for free.
 *   - **Idempotent by key** — a redelivered event returns the existing
 *     reservation instead of taking a second debit.
 *   - **Never self-restoring** — `release` only rewinds a reservation whose
 *     operation provably never ran (`RESERVED`). A `SETTLED` reservation is
 *     spent forever, and a reservation abandoned by a dead process is marked
 *     `ABANDONED` and stays debited. Restoring consumed budget automatically is
 *     the exact bug this module exists to prevent.
 *
 * The model mirrors `recovery/ledger.ts` on purpose: same store, same
 * single-statement atomicity, same "never blindly replay" stance. There is one
 * reservation idiom in KAI, not two.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** What is being spent. Every kind is separately ceilinged and separately summed. */
export type BudgetKind =
  | "dispatch"
  | "retry"
  | "reassign"
  | "correction"
  | "replan"
  | "modelCall"
  | "toolCall"
  /** Spend in USD. Its own kind, so `maxCostUsd` is reachable by the same path. */
  | "cost"
  /** Wall-clock milliseconds. */
  | "runtime";

export const BUDGET_KINDS: readonly BudgetKind[] = [
  "dispatch",
  "retry",
  "reassign",
  "correction",
  "replan",
  "modelCall",
  "toolCall",
  "cost",
  "runtime",
];

/**
 * The identity of an allowance. Two attempts with the same scope draw on the
 * same budget; that is the whole point.
 *
 *   - `goalId`         — the goal the work serves.
 *   - `planRevisionId` — the approved revision whose budgets are in force. A new
 *                        revision is a new, deliberate allowance.
 *   - `chainId`        — the corrective tree: the ROOT item. Children share the
 *                        root's chain, so a parent cannot multiply its allowance
 *                        by spawning siblings.
 */
export interface BudgetScope {
  goalId?: string;
  planRevisionId?: string;
  chainId: string;
}

export interface BudgetLimits {
  maxDispatches?: number;
  maxRetries?: number;
  maxReassignments?: number;
  maxCorrections?: number;
  maxReplans?: number;
  maxModelCalls?: number;
  maxToolCalls?: number;
  /** Cost in USD; reservations carry fractional amounts. */
  maxCostUsd?: number;
  maxRuntimeMs?: number;
}

export type ReservationState = "RESERVED" | "SETTLED" | "RELEASED" | "ABANDONED";

export interface Reservation {
  id: string;
  scopeKey: string;
  goalId?: string;
  planRevisionId?: string;
  chainId: string;
  kind: BudgetKind;
  amount: number;
  state: ReservationState;
  idempotencyKey: string;
  ownerId: string;
  itemId?: string;
  detail?: string;
  at: string;
  finishedAt?: string;
}

export interface ReserveInput {
  scope: BudgetScope;
  kind: BudgetKind;
  limits: BudgetLimits;
  /**
   * The duplicate-delivery marker. Reusing a key NEVER takes a second debit:
   * the existing reservation is returned with `duplicate: true`.
   */
  idempotencyKey: string;
  /** Defaults to 1. Fractional amounts are allowed (cost). */
  amount?: number;
  itemId?: string;
  detail?: string;
}

export type ReserveResult =
  | {
      ok: true;
      reservation: Reservation;
      /** Consumed BEFORE this reservation, after it, and the ceiling. */
      consumedBefore: number;
      consumedAfter: number;
      limit: number;
      duplicate: boolean;
    }
  | {
      ok: false;
      reason: string;
      consumed: number;
      limit: number;
      kind: BudgetKind;
    };

export interface BudgetLedger {
  /**
   * Atomically check-and-debit. Refuses when the ceiling would be exceeded.
   * This is the ONLY way to spend budget.
   */
  reserve(input: ReserveInput): ReserveResult;
  /** Mark a reservation as actually spent, optionally correcting the amount. */
  settle(id: string, actual?: number, detail?: string): boolean;
  /** Rewind a reservation whose operation PROVABLY never ran. Never rewinds a settle. */
  release(id: string, reason?: string): boolean;
  get(id: string): Reservation | null;
  consumed(scope: BudgetScope, kind: BudgetKind): number;
  consumedAll(scope: BudgetScope): Record<BudgetKind, number>;
  /** Reservations still `RESERVED` — in flight, or abandoned by a dead process. */
  listOpen(): Reservation[];
  listByScope(scope: BudgetScope): Reservation[];
  /**
   * Mark every `RESERVED` row owned by a process that is no longer live as
   * `ABANDONED`. The amount STAYS debited: the operation may have had side
   * effects, and restoring its budget would authorise a second one.
   */
  reconcileOpen(liveOwnerIds: readonly string[]): Reservation[];
  close(): void;
}

/**
 * The ENFORCEMENT key for a scope.
 *
 * When the work belongs to a goal, the allowance is the PLAN REVISION's, so every
 * item of that revision draws on one budget. That rollup is the point: the chain
 * id is stored on every row for audit, but it does NOT widen the allowance. If the
 * chain were the enforcement key, a caller could mint a fresh budget by creating a
 * brand-new item (a new item starts a new chain) — the exact bypass this module
 * exists to close.
 *
 * Work with no goal falls back to its own chain, which for a lone item is the item.
 */
export function budgetScopeKey(scope: BudgetScope): string {
  return scope.goalId !== undefined
    ? `goal:${scope.goalId}|rev:${scope.planRevisionId ?? "-"}`
    : `chain:${scope.chainId}`;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS budget_reservations (
  id             TEXT PRIMARY KEY,
  scopeKey       TEXT NOT NULL,
  goalId         TEXT,
  planRevisionId TEXT,
  chainId        TEXT NOT NULL,
  kind           TEXT NOT NULL,
  amount         REAL NOT NULL,
  state          TEXT NOT NULL,
  idempotencyKey TEXT NOT NULL UNIQUE,
  ownerId        TEXT NOT NULL,
  itemId         TEXT,
  detail         TEXT,
  at             TEXT NOT NULL,
  finishedAt     TEXT
);
CREATE INDEX IF NOT EXISTS idx_budget_scope ON budget_reservations (scopeKey, kind, state);
CREATE INDEX IF NOT EXISTS idx_budget_open  ON budget_reservations (state, at);
`;

function toNum(value: unknown, fallback = 0): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function rowToReservation(row: Record<string, unknown>): Reservation {
  const out: Reservation = {
    id: String(row["id"]),
    scopeKey: String(row["scopeKey"]),
    chainId: String(row["chainId"]),
    kind: String(row["kind"]) as BudgetKind,
    amount: toNum(row["amount"]),
    state: String(row["state"]) as ReservationState,
    idempotencyKey: String(row["idempotencyKey"]),
    ownerId: String(row["ownerId"]),
    at: String(row["at"]),
  };
  if (row["goalId"] !== null && row["goalId"] !== undefined) out.goalId = String(row["goalId"]);
  if (row["planRevisionId"] !== null && row["planRevisionId"] !== undefined) {
    out.planRevisionId = String(row["planRevisionId"]);
  }
  if (row["itemId"] !== null && row["itemId"] !== undefined) out.itemId = String(row["itemId"]);
  if (row["detail"] !== null && row["detail"] !== undefined) out.detail = String(row["detail"]);
  if (row["finishedAt"] !== null && row["finishedAt"] !== undefined) out.finishedAt = String(row["finishedAt"]);
  return out;
}

/** The ceiling for a kind, or `undefined` when the kind is not bounded. */
function limitFor(limits: BudgetLimits, kind: BudgetKind): number | undefined {
  switch (kind) {
    case "dispatch":
      return limits.maxDispatches;
    case "retry":
      return limits.maxRetries;
    case "reassign":
      return limits.maxReassignments;
    case "correction":
      return limits.maxCorrections;
    case "replan":
      return limits.maxReplans;
    case "modelCall":
      return limits.maxModelCalls;
    case "toolCall":
      return limits.maxToolCalls;
    case "cost":
      return limits.maxCostUsd;
    case "runtime":
      return limits.maxRuntimeMs;
  }
}

export function createBudgetLedger(opts: { path?: string; now?: () => Date; ownerId?: string } = {}): BudgetLedger {
  const path = opts.path ?? ":memory:";
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
    // Some filesystems reject WAL; the default journal still gives atomic
    // single-statement updates, which is all a reservation needs.
  }
  db.exec(SCHEMA);

  const stmts = {
    byKey: db.prepare(`SELECT * FROM budget_reservations WHERE idempotencyKey = ?`),
    byId: db.prepare(`SELECT * FROM budget_reservations WHERE id = ?`),
    sum: db.prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM budget_reservations
        WHERE scopeKey = ? AND kind = ? AND state IN ('RESERVED', 'SETTLED', 'ABANDONED')`,
    ),
    sumAll: db.prepare(
      `SELECT kind, COALESCE(SUM(amount), 0) AS total FROM budget_reservations
        WHERE scopeKey = ? AND state IN ('RESERVED', 'SETTLED', 'ABANDONED') GROUP BY kind`,
    ),
    insert: db.prepare(
      `INSERT INTO budget_reservations
         (id, scopeKey, goalId, planRevisionId, chainId, kind, amount, state, idempotencyKey, ownerId, itemId, detail, at, finishedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'RESERVED', ?, ?, ?, ?, ?, NULL)`,
    ),
    settle: db.prepare(
      `UPDATE budget_reservations
          SET state = 'SETTLED', amount = COALESCE(?, amount), detail = COALESCE(?, detail), finishedAt = ?
        WHERE id = ? AND state = 'RESERVED'`,
    ),
    release: db.prepare(
      `UPDATE budget_reservations
          SET state = 'RELEASED', detail = COALESCE(?, detail), finishedAt = ?
        WHERE id = ? AND state = 'RESERVED'`,
    ),
    abandon: db.prepare(
      `UPDATE budget_reservations
          SET state = 'ABANDONED', detail = COALESCE(?, detail), finishedAt = ?
        WHERE id = ? AND state = 'RESERVED'`,
    ),
    open: db.prepare(`SELECT * FROM budget_reservations WHERE state = 'RESERVED' ORDER BY at ASC, rowid ASC`),
    byScope: db.prepare(`SELECT * FROM budget_reservations WHERE scopeKey = ? ORDER BY at ASC, rowid ASC`),
    openByOwner: db.prepare(
      `SELECT * FROM budget_reservations WHERE state = 'RESERVED' AND ownerId = ? ORDER BY at ASC, rowid ASC`,
    ),
    allOpen: db.prepare(`SELECT * FROM budget_reservations WHERE state = 'RESERVED' ORDER BY at ASC, rowid ASC`),
  };

  let counter = 0;
  const nextId = (): string => {
    counter += 1;
    return `rsv_${now().getTime().toString(36)}_${counter.toString(36)}`;
  };

  function reserve(input: ReserveInput): ReserveResult {
    const amount = input.amount ?? 1;
    const limit = limitFor(input.limits, input.kind);
    const scopeKey = budgetScopeKey(input.scope);

    // `BEGIN IMMEDIATE` takes the write lock before the read, so two concurrent
    // reservations cannot both observe headroom and both commit.
    db.exec("BEGIN IMMEDIATE");
    try {
      // Duplicate delivery: the key already exists. Return it unchanged — a
      // redelivered event must never take a second debit.
      const existing = stmts.byKey.get(input.idempotencyKey) as Record<string, unknown> | undefined;
      if (existing !== undefined) {
        const reservation = rowToReservation(existing);
        db.exec("COMMIT");
        const consumed = reservation.state === "RELEASED" ? 0 : reservation.amount;
        return {
          ok: true,
          reservation,
          consumedBefore: consumed,
          consumedAfter: consumed,
          limit: limit ?? Number.POSITIVE_INFINITY,
          duplicate: true,
        };
      }

      const row = stmts.sum.get(scopeKey, input.kind) as Record<string, unknown> | undefined;
      const consumedBefore = toNum(row?.["total"]);

      if (limit !== undefined && consumedBefore + amount > limit) {
        db.exec("ROLLBACK");
        return {
          ok: false,
          reason:
            `budget exhausted: ${input.kind} would reach ${consumedBefore + amount} of ${limit} ` +
            `for ${scopeKey} — the allowance is spent and is never silently restored`,
          consumed: consumedBefore,
          limit,
          kind: input.kind,
        };
      }

      const id = nextId();
      const at = now().toISOString();
      stmts.insert.run(
        id,
        scopeKey,
        input.scope.goalId ?? null,
        input.scope.planRevisionId ?? null,
        input.scope.chainId,
        input.kind,
        amount,
        input.idempotencyKey,
        defaultOwner,
        input.itemId ?? null,
        input.detail ?? null,
        at,
      );
      db.exec("COMMIT");
      const reservation: Reservation = {
        id,
        scopeKey,
        chainId: input.scope.chainId,
        kind: input.kind,
        amount,
        state: "RESERVED",
        idempotencyKey: input.idempotencyKey,
        ownerId: defaultOwner,
        at,
      };
      if (input.scope.goalId !== undefined) reservation.goalId = input.scope.goalId;
      if (input.scope.planRevisionId !== undefined) reservation.planRevisionId = input.scope.planRevisionId;
      if (input.itemId !== undefined) reservation.itemId = input.itemId;
      if (input.detail !== undefined) reservation.detail = input.detail;
      return {
        ok: true,
        reservation,
        consumedBefore,
        consumedAfter: consumedBefore + amount,
        limit: limit ?? Number.POSITIVE_INFINITY,
        duplicate: false,
      };
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // The transaction was already closed; nothing to rewind.
      }
      throw error;
    }
  }

  function consumedAll(scope: BudgetScope): Record<BudgetKind, number> {
    const out = Object.fromEntries(BUDGET_KINDS.map((k) => [k, 0])) as Record<BudgetKind, number>;
    const rows = stmts.sumAll.all(budgetScopeKey(scope)) as Record<string, unknown>[];
    for (const row of rows) {
      const kind = String(row["kind"]) as BudgetKind;
      if (BUDGET_KINDS.includes(kind)) out[kind] = toNum(row["total"]);
    }
    return out;
  }

  return {
    reserve,
    settle(id, actual, detail) {
      const at = now().toISOString();
      const res = stmts.settle.run(actual ?? null, detail ?? null, at, id);
      return Number(res.changes) > 0;
    },
    release(id, reason) {
      const at = now().toISOString();
      const res = stmts.release.run(reason ?? null, at, id);
      return Number(res.changes) > 0;
    },
    get(id) {
      const row = stmts.byId.get(id) as Record<string, unknown> | undefined;
      return row === undefined ? null : rowToReservation(row);
    },
    consumed(scope, kind) {
      const row = stmts.sum.get(budgetScopeKey(scope), kind) as Record<string, unknown> | undefined;
      return toNum(row?.["total"]);
    },
    consumedAll,
    listOpen() {
      return (stmts.open.all() as Record<string, unknown>[]).map(rowToReservation);
    },
    listByScope(scope) {
      return (stmts.byScope.all(budgetScopeKey(scope)) as Record<string, unknown>[]).map(rowToReservation);
    },
    reconcileOpen(liveOwnerIds) {
      const live = new Set(liveOwnerIds);
      const abandoned: Reservation[] = [];
      const rows = stmts.allOpen.all() as Record<string, unknown>[];
      for (const row of rows) {
        const reservation = rowToReservation(row);
        if (live.has(reservation.ownerId)) continue;
        stmts.abandon.run(
          `abandoned: the process that reserved this (${reservation.ownerId}) is no longer running — ` +
            "the amount stays debited because the operation may have had side effects",
          now().toISOString(),
          reservation.id,
        );
        const updated = stmts.byId.get(reservation.id) as Record<string, unknown> | undefined;
        if (updated !== undefined) abandoned.push(rowToReservation(updated));
      }
      return abandoned;
    },
    close() {
      try {
        db.close();
      } catch {
        // Already closed.
      }
    },
  };
}
