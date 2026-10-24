// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * state-store.ts — the durable home of KAI's policy MODE.
 *
 * ## Why this exists
 *
 * The mode engine (`mode.ts`) is complete: it knows how to prepare an elevation,
 * confirm it, cancel it and drop authority. What was missing was a caller — the
 * engine was always constructed in `normal` and no route could change it, so
 * "Ask / Auto / Full Access" were unreachable in production. This file is the
 * missing half: the state survives a restart, so a mode a human set stays set.
 *
 * ## Why its own file rather than `Stores`
 *
 * `Stores` is a frozen interface shared with the desktop app's existing schema;
 * reshaping it for one row would be a migration risk for no gain. The codebase
 * already keeps each new durable concern in its own file next to the database
 * (`parked-requests.db`, `doer-pending.db`, `goals.db`) for exactly this reason.
 *
 * ## The failure direction
 *
 * A row that will not parse, or that fails validation, is reported as `undefined`
 * — and the caller then starts from `BASELINE_MODE` (`normal`). Corruption can
 * therefore only ever LOSE an elevation the user granted; it can never invent one.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { isPolicyMode, type PolicyMode } from "../shared/contracts.ts";
import {
  initialPolicyState,
  type ModeScope,
  type PendingElevation,
  type PolicyActor,
  type PolicyState,
} from "./mode.ts";

export interface PolicyStateStore {
  /** The persisted state, or `undefined` when nothing valid has ever been saved. */
  load(): PolicyState | undefined;
  /** Persist the whole state, replacing whatever was there. */
  save(state: PolicyState): void;
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS policy_state (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  mode       TEXT    NOT NULL,
  scopeJson  TEXT    NOT NULL,
  pendingJson TEXT,
  rulesJson  TEXT,
  updatedAt  TEXT    NOT NULL
);
`;

const VALID_ACTORS: readonly PolicyActor[] = ["owner", "agent", "worker"];

function validActor(value: unknown): value is PolicyActor {
  return typeof value === "string" && (VALID_ACTORS as readonly string[]).includes(value);
}

function validScope(value: unknown): value is ModeScope {
  if (value === null || typeof value !== "object") return false;
  const scope = value as Record<string, unknown>;
  if (scope.kind !== "thread" && scope.kind !== "mission" && scope.kind !== "employee" && scope.kind !== "global") {
    return false;
  }
  if (scope.kind === "global") return true;
  return typeof scope.id === "string" && scope.id.trim().length > 0;
}

function validPending(value: unknown): value is PendingElevation {
  if (value === null || typeof value !== "object") return false;
  const pending = value as Record<string, unknown>;
  return (
    typeof pending.requestId === "string" &&
    pending.requestId.length > 0 &&
    isPolicyMode(pending.to) &&
    validScope(pending.scope) &&
    typeof pending.requestedAt === "string" &&
    validActor(pending.requestedBy)
  );
}

/**
 * A whole-state JSON round trip. Deliberately all-or-nothing: a half-valid state
 * is not a state, and a mode read from a partially-parsed row is exactly the
 * "authority invented by corruption" failure this store must not allow.
 */
function parseState(raw: {
  mode: unknown;
  scopeJson: unknown;
  pendingJson: unknown;
  rulesJson?: unknown;
  updatedAt: unknown;
}): PolicyState | undefined {
  if (!isPolicyMode(raw.mode)) return undefined;
  if (typeof raw.updatedAt !== "string" || raw.updatedAt.length === 0) return undefined;

  let scope: unknown;
  try {
    scope = JSON.parse(String(raw.scopeJson));
  } catch {
    return undefined;
  }
  if (!validScope(scope)) return undefined;

  let pending: unknown;
  if (raw.pendingJson === null || raw.pendingJson === undefined || raw.pendingJson === "") {
    pending = undefined;
  } else {
    try {
      pending = JSON.parse(String(raw.pendingJson));
    } catch {
      return undefined;
    }
    // A pending elevation that will not validate is DROPPED, not the whole row:
    // the confirmed mode below it is still good, and an unconfirmable request is
    // simply one that never happened. Fail closed means the mode stays as it is.
    if (!validPending(pending)) pending = undefined;
  }

  // Rules are re-validated by the engine's own normalizeRules on load, so a
  // malformed persisted rule is dropped there and its subject falls back to the
  // safe default. Parsing failure here drops the list, never the mode.
  let rules: unknown[] | undefined;
  if (typeof raw.rulesJson === "string" && raw.rulesJson.length > 0) {
    try {
      const parsed = JSON.parse(raw.rulesJson);
      if (Array.isArray(parsed)) rules = parsed;
    } catch {
      rules = undefined;
    }
  }

  return {
    mode: raw.mode,
    scope: scope as ModeScope,
    ...(pending !== undefined ? { pending: pending as PendingElevation } : {}),
    ...(rules !== undefined ? { rules } : {}),
    updatedAt: raw.updatedAt,
  };
}

export function openPolicyStateStore(opts: { path: string }): PolicyStateStore {
  const path = opts.path;
  if (path !== ":memory:" && !path.startsWith("file:")) {
    const dir = dirname(path);
    if (dir.length > 0 && dir !== ".") mkdirSync(dir, { recursive: true });
  }

  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    try {
      db.exec("PRAGMA journal_mode = WAL");
    } catch {
      // Some filesystems reject WAL; a single-row write is atomic regardless.
    }
    db.exec(SCHEMA);
    // MIGRATION, not schema: an existing policy_state table was created before
    // `rulesJson` existed, and CREATE TABLE IF NOT EXISTS will not add a column.
    // Without this the SELECT below fails on every start and Core never opens the
    // policy store — which is exactly what happened once.
    try {
      const columns = db.prepare("PRAGMA table_info(policy_state)").all() as { name?: unknown }[];
      const hasRules = columns.some((c) => c.name === "rulesJson");
      if (!hasRules) db.exec("ALTER TABLE policy_state ADD COLUMN rulesJson TEXT");
    } catch {
      // If the column cannot be added the SELECT degrades to no persisted rules,
      // which is safe: grants simply do not survive a restart.
    }
  } catch (cause) {
    // A store that cannot be prepared must not leak its handle: a half-opened
    // database holds a lock on the file, which would leave the caller unable to
    // remove or replace it (and on Windows, unable to clean up at all).
    try {
      db.close();
    } catch {
      // Nothing further to do; the original failure is the one that matters.
    }
    throw cause;
  }

  const get = db.prepare(`SELECT mode, scopeJson, pendingJson, rulesJson, updatedAt FROM policy_state WHERE id = 1`);
  const upsert = db.prepare(
    `INSERT INTO policy_state (id, mode, scopeJson, pendingJson, rulesJson, updatedAt)
       VALUES (1, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       mode = excluded.mode,
       scopeJson = excluded.scopeJson,
       pendingJson = excluded.pendingJson,
       rulesJson = excluded.rulesJson,
       updatedAt = excluded.updatedAt`,
  );

  return {
    load(): PolicyState | undefined {
      let row: unknown;
      try {
        row = get.get();
      } catch {
        return undefined;
      }
      if (row === null || row === undefined || typeof row !== "object") return undefined;
      return parseState(row as { mode: unknown; scopeJson: unknown; pendingJson: unknown; rulesJson?: unknown; updatedAt: unknown });
    },

    save(state: PolicyState): void {
      upsert.run(
        state.mode,
        JSON.stringify(state.scope),
        state.pending !== undefined ? JSON.stringify(state.pending) : null,
        state.rules !== undefined ? JSON.stringify(state.rules) : null,
        state.updatedAt,
      );
    },

    close(): void {
      try {
        db.close();
      } catch {
        // Closing a handle that is already closed is not a failure worth raising.
      }
    },
  };
}

/**
 * The state to start from: what was persisted, or the baseline.
 *
 * Exported so the runtime and the tests agree on ONE resolution rule rather than
 * each re-deriving it.
 */
export function resolvedInitialState(
  store: PolicyStateStore | undefined,
  now: Date = new Date(),
): PolicyState {
  const persisted = store?.load();
  if (persisted === undefined) return initialPolicyState(now);
  // A persisted mode with no pending elevation is the normal case.
  return persisted;
}
