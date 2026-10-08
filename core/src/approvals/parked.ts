// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Parked (non-mission) approval requests — the durable half of "approve and it
 * actually runs".
 *
 * A `needs_approval` policy decision parks an action and hands back an approval
 * id. For a MISSION step, the mission executor knows which step is waiting, so
 * `decideApproval` can resume it. For every other action — a capability test, an
 * `agents.run_task`, any direct tool call — nothing owns the parked request: the
 * verdict was recorded and the work simply never ran. That was the reported
 * usability defect ("verdict recorded, nothing happens").
 *
 * This store closes it. When the registry creates an approval for a request with
 * no mission, the runtime records the EXACT parked call here, keyed by approval
 * id: which tool, with which input, under which correlation. After the verdict,
 * `decideApproval` re-issues that same call with the approval id in hand.
 *
 * ── Why it is durable, and its own file ───────────────────────────────────────
 * The whole point of a parked request is that it outlives the process that
 * created it: an approval can be answered after a crash and a restart. So the
 * record lives in SQLite (same pattern as the recovery ledger / scheduler lease
 * store), not in a closure. It owns its own file because it is approval-private
 * state and must not reshape the frozen `Stores` interfaces.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** The exact call an approval parked, so it can be re-issued after the verdict. */
export interface ParkedRequest {
  approvalId: string;
  toolId: string;
  /** The validated input the tool would have received. JSON-serialised at rest. */
  input: unknown;
  missionId?: string;
  stepId?: string;
  scheduleId?: string;
  turnId?: string;
  createdAt: string;
}

export interface ParkedRequestInput {
  approvalId: string;
  toolId: string;
  input: unknown;
  missionId?: string;
  stepId?: string;
  scheduleId?: string;
  turnId?: string;
}

export interface ParkedRequestStore {
  readonly path: string;
  /** Record a parked call. Re-parking the same approval id updates it. */
  record(request: ParkedRequestInput): ParkedRequest;
  get(approvalId: string): ParkedRequest | null;
  /** Remove one record; true when something was removed. */
  remove(approvalId: string): boolean;
  list(): ParkedRequest[];
  /**
   * Drop records whose approval no longer exists or is no longer PENDING.
   * Called on startup so a restart cannot leave an unrunnable request behind
   * (an expired approval is a verdict, not a question).
   */
  prune(approvalStatus: (approvalId: string) => string | null): number;
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS parked_requests (
  approvalId  TEXT PRIMARY KEY,
  toolId      TEXT NOT NULL,
  inputJson   TEXT NOT NULL,
  missionId   TEXT,
  stepId      TEXT,
  scheduleId  TEXT,
  turnId      TEXT,
  createdAt   TEXT NOT NULL
);
`;

function optional<T extends object>(target: T, key: keyof T, value: unknown): void {
  if (value !== null && value !== undefined) (target as Record<string, unknown>)[key as string] = value;
}

export function createParkedRequestStore(opts: { path: string; now?: () => Date }): ParkedRequestStore {
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
    get: db.prepare(`SELECT * FROM parked_requests WHERE approvalId = ?`),
    upsert: db.prepare(
      `INSERT INTO parked_requests (approvalId, toolId, inputJson, missionId, stepId, scheduleId, turnId, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(approvalId) DO UPDATE SET
         toolId = excluded.toolId, inputJson = excluded.inputJson, missionId = excluded.missionId,
         stepId = excluded.stepId, scheduleId = excluded.scheduleId, turnId = excluded.turnId`,
    ),
    delete: db.prepare(`DELETE FROM parked_requests WHERE approvalId = ?`),
    list: db.prepare(`SELECT * FROM parked_requests ORDER BY createdAt ASC, rowid ASC`),
  };

  function rowToRequest(row: Record<string, unknown>): ParkedRequest {
    let input: unknown = null;
    try {
      input = JSON.parse(String(row.inputJson));
    } catch {
      // A record whose payload will not parse is still a record: report the raw
      // string rather than pretending there is no parked request.
      input = String(row.inputJson);
    }
    const request: ParkedRequest = {
      approvalId: String(row.approvalId),
      toolId: String(row.toolId),
      input,
      createdAt: String(row.createdAt),
    };
    optional(request, "missionId", row.missionId);
    optional(request, "stepId", row.stepId);
    optional(request, "scheduleId", row.scheduleId);
    optional(request, "turnId", row.turnId);
    return request;
  }

  function record(input: ParkedRequestInput): ParkedRequest {
    const request: ParkedRequest = {
      approvalId: input.approvalId,
      toolId: input.toolId,
      input: input.input,
      createdAt: now().toISOString(),
    };
    if (input.missionId !== undefined) request.missionId = input.missionId;
    if (input.stepId !== undefined) request.stepId = input.stepId;
    if (input.scheduleId !== undefined) request.scheduleId = input.scheduleId;
    if (input.turnId !== undefined) request.turnId = input.turnId;
    stmts.upsert.run(
      request.approvalId,
      request.toolId,
      JSON.stringify(input.input ?? null),
      input.missionId ?? null,
      input.stepId ?? null,
      input.scheduleId ?? null,
      input.turnId ?? null,
      request.createdAt,
    );
    return request;
  }

  function get(approvalId: string): ParkedRequest | null {
    const row = stmts.get.get(approvalId) as Record<string, unknown> | undefined;
    return row === undefined ? null : rowToRequest(row);
  }

  function remove(approvalId: string): boolean {
    const result = stmts.delete.run(approvalId);
    return Number((result as { changes?: number | bigint }).changes ?? 0) > 0;
  }

  function list(): ParkedRequest[] {
    return (stmts.list.all() as unknown as Record<string, unknown>[]).map(rowToRequest);
  }

  function prune(approvalStatus: (approvalId: string) => string | null): number {
    let removed = 0;
    for (const request of list()) {
      const status = approvalStatus(request.approvalId);
      if (status === null || status !== "PENDING") {
        if (remove(request.approvalId)) removed += 1;
      }
    }
    return removed;
  }

  let closed = false;
  function close(): void {
    if (closed) return;
    closed = true;
    db.close();
  }

  return { path, record, get, remove, list, prune, close };
}
