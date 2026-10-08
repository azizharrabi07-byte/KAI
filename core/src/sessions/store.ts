// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * KAI's own conversation sessions — the durable layer the architecture audit
 * named as missing (`docs/architecture-audit.md` §2 verdict 3: "No `sessions`
 * table, no Session type, no session UI"; §6 phase "F sessions").
 *
 * Why this exists. Before it, KAI's memory of a conversation was whichever
 * worker session id the caller happened to be holding, and nothing about that
 * conversation outlived the caller. A "session" is the durable thing a person
 * expects from a companion: a named conversation that survives a restart, can be
 * switched back to, and carries its own turns.
 *
 * Design rules, each matching an existing precedent in this tree:
 *
 *   - It owns its OWN SQLite file rather than adding tables to the frozen
 *     `Stores` aggregate. The recovery ledger and the scheduler lease store do
 *     the same, and for the same reason: a new subsystem must not reshape an
 *     interface other code already depends on.
 *
 *   - The worker's own session id (`agentSessionId`) is stored ON the KAI
 *     session. That is what makes a turn continue the same worker conversation
 *     after a Core restart instead of starting a new one — and it is what makes
 *     the `session` memory scope honest, because now something in the runtime
 *     really mints a session id.
 *
 *   - Timestamps are ISO-8601 TEXT, booleans are INTEGER 0/1, structured fields
 *     are JSON TEXT. Same conventions as `storage/sqlite.ts`.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// The persona namespace ("kai:<id>") — imported, not re-spelled, so the store's
// ownership split can never drift from the workforce's id namespace.
import { SUBAGENT_ID_PREFIX } from "../workforce/subagent.ts";

export type SessionStatus = "ACTIVE" | "ARCHIVED";

export interface KaiSession {
  id: string;
  title: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  /** When the last turn was recorded. Absent until the first turn. */
  lastTurnAt?: string;
  turnCount: number;
  /**
   * The compact extractive digest (objective, files, tools, last line) as
   * JSON. Rebuilt deterministically on every recorded turn, so it survives a
   * reload and never changes randomly. Absent until the first turn.
   */
  summary?: SessionSummaryBlob;
  /**
   * The transcript kind: "kai-conversation" (default), "agent-conversation"
   * (persona-owned), or "worker-execution" (reserved). Explicit, so a KAI
   * conversation can never silently become an agent session or vice versa.
   */
  sessionKind?: string;
  /**
   * LEGACY, overloaded: the worker this conversation is bound to
   * (hermes/opencode) OR — for a persona's own session — the subagent that owns
   * it (`kai:<id>`). Kept because existing readers depend on it
   * (api/routes.ts `personaSessionFor`, the chat relay). NEW code must read
   * `agentOwner` / `worker` below instead: those two split the overload, and
   * `deriveOwnership()` is the single place the split is computed.
   */
  agentId?: string;
  /**
   * The persona/subagent that OWNS this session (`kai:<id>`), when one does.
   * A subagent's own conversation carries this; KAI's own conversations never
   * do — which is exactly what keeps the two transcript kinds apart.
   */
  agentOwner?: string;
  /** The worker this conversation is bound to (hermes/opencode), once a turn ran. */
  worker?: string;
  /** The mission this session is bound to, when one is (see service.bindMission). */
  missionId?: string;
  /** That worker's own conversation id, so a later turn continues the same one. */
  agentSessionId?: string;
  metadata?: Record<string, unknown>;
}

/** Where a search hit matched: the session id, its title, or one of its turns. */
export type SessionSearchMatch = "id" | "title" | "turn";

/**
 * The persisted shape of the session digest (see `SessionSummary` in
 * service.ts, which owns the field contract — this is its JSON blob).
 * `narrative` is model-written when a summarizer runs, else absent; every
 * other field is extractive and always present once a summary exists.
 */
export interface SessionSummaryBlob {
  objective: string;
  files: string[];
  toolsUsed: string[];
  toolStats: { total: number; executed: number };
  lastAssistantLine: string;
  builtAt: string;
  narrative?: string;
}

export interface SessionSearchHit {
  session: KaiSession;
  /** "title" also covers a match inside the persisted summary digest. */
  matched: SessionSearchMatch;
  /** The first matching turn (reading order), when `matched` is "turn". */
  turn?: SessionTurn;
}

export type SessionTurnRole = "user" | "assistant";

export interface SessionTurn {
  id: string;
  sessionId: string;
  role: SessionTurnRole;
  text: string;
  at: string;
  agentId?: string;
  /**
   * The tool calls that produced this turn, oldest first. Attached on READ,
   * never stored on the turn row: the durable facts live in
   * `session_tool_calls` (one row per call) and are joined by `turnId`, so a
   * transcript reload restores that a tool was used — name, arguments, result,
   * status and approval state — without dumping internals into the turn text.
   */
  tools?: SessionToolCall[];
}

/**
 * One persisted model-requested tool call: what the model asked for, what the
 * registry did, and what the model read back. `result` is the JSON the model
 * saw (a refusal value on a non-EXECUTED status). `turnId` is the assistant
 * turn the call belongs to; `toolCallId` is the model-side `call_…` id that
 * binds the request to its outcome.
 */
export interface SessionToolCall {
  id: string;
  sessionId: string;
  turnId: string;
  toolCallId: string;
  /** The wire name the model selected (`filesystem_search`). */
  toolName: string;
  /**
   * The canonical registry id (`filesystem.search`). Digests and UI read THIS.
   * Absent on rows written before the column existed, and when the name never
   * resolved to a real tool.
   */
  toolId?: string;
  /** Raw JSON argument string, verbatim from the model. */
  arguments: string;
  /** The registry attempt identity, when the call reached the boundary. */
  invocationId?: string;
  /** EXECUTED | INVALID | DENIED | APPROVAL_REQUIRED | FAILED | NOT_FOUND. */
  status: string;
  /** The tool's value, or the refusal value. JSON-serializable. */
  result?: unknown;
  /** The approval that parked or authorised the call, when one exists. */
  approvalId?: string;
  startedAt: string;
  completedAt: string;
}

export interface SessionStore {
  readonly path: string;
  create(input: {
    id: string;
    title: string;
    status?: SessionStatus;
    createdAt?: string;
    /**
     * The persona/worker this conversation belongs to, when it is born already
     * bound. A subagent session is created OWNED by its persona
     * (`agentId === "kai:<id>"`), so it never merges into KAI's own conversation
     * (see `core/src/workforce/subagent.ts` SUBAGENT_ID_PREFIX).
     *
     * `agentOwner` / `worker` are the UN-overloaded fields: pass them explicitly
     * when you know which half you mean; when only `agentId` is given it is split
     * through `deriveOwnership()` so every writer agrees.
     */
    agentId?: string;
    agentOwner?: string;
    worker?: string;
    missionId?: string;
  }): KaiSession;
  get(id: string): KaiSession | null;
  list(opts?: { status?: SessionStatus; limit?: number; includeArchived?: boolean }): KaiSession[];
  update(
    id: string,
    patch: {
      title?: string;
      status?: SessionStatus;
      agentId?: string;
      agentOwner?: string;
      worker?: string;
      missionId?: string | null;
      agentSessionId?: string;
      turnCount?: number;
      /** `null` clears it (used when a session's turns are cleared). */
      lastTurnAt?: string | null;
      metadata?: Record<string, unknown>;
      /** Replace the digest; `null` clears it (used when turns are cleared). */
      summary?: SessionSummaryBlob | null;
      sessionKind?: string;
    },
  ): KaiSession | null;
  appendTurn(turn: SessionTurn): SessionTurn;
  turns(sessionId: string, limit?: number): SessionTurn[];
  /**
   * Persist one model-requested tool call against its assistant turn. The call
   * must name an existing turn; the service enforces liveness, the store binds.
   */
  appendToolCall(call: SessionToolCall): SessionToolCall;
  /** Every tool call of a session, oldest first. */
  toolCalls(sessionId: string, limit?: number): SessionToolCall[];
  /** How many turns the session has, counted from the turns table (never the cached column). */
  countTurns(sessionId: string): number;
  /** Remove every turn of a session and reset its counters. Returns turns removed. */
  clearTurns(sessionId: string): number;
  /**
   * Replace a session's transcript wholesale: delete every turn and tool call,
   * then insert the replacements (with their ORIGINAL ids) in the SAME
   * transaction. The compaction path uses this so a crash can never leave a
   * half-rebuilt session. Counters are recomputed from what was written.
   */
  replaceTurns(sessionId: string, turns: SessionTurn[], calls: SessionToolCall[]): void;
  /** Hard-delete a session and its turns. Returns false when it did not exist. */
  delete(id: string): boolean;
  /** The session whose worker conversation is `agentSessionId`, newest first. */
  findByWorkerSessionId(agentSessionId: string): KaiSession | null;
  /** The session bound to a mission, when one is (see service.bindMission). */
  findByMissionId(missionId: string): KaiSession | null;
  /**
   * Search id, title and turn text with a case-insensitive LIKE. The query is
   * ESCAPED, so `%` and `_` are literal characters rather than wildcards.
   */
  search(query: string, opts?: { limit?: number }): SessionSearchHit[];
  /**
   * Run `fn` inside one SQLite transaction (BEGIN/COMMIT, ROLLBACK on throw).
   * Not nestable — SQLite has no nested transactions — so a caller must not
   * wrap another `transaction` call.
   */
  transaction<T>(fn: () => T): T;
  /** The session chat currently goes to, or null when none has been chosen. */
  activeSessionId(): string | null;
  setActiveSessionId(id: string | null): void;
  close(): void;
}

export function defaultSessionsPath(): string {
  const override = process.env.KAI_CORE_SESSIONS_DB?.trim();
  if (override !== undefined && override.length > 0) return override;
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, "KAI", "core", "kai-sessions.db");
  }
  const xdg = process.env.XDG_DATA_HOME?.trim();
  if (xdg !== undefined && xdg.length > 0) return join(xdg, "KAI", "core", "kai-sessions.db");
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "KAI", "core", "kai-sessions.db");
  }
  return join(homedir(), ".local", "share", "KAI", "core", "kai-sessions.db");
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id             TEXT PRIMARY KEY,
  title          TEXT NOT NULL,
  status         TEXT NOT NULL,
  createdAt      TEXT NOT NULL,
  updatedAt      TEXT NOT NULL,
  lastTurnAt     TEXT,
  turnCount      INTEGER NOT NULL DEFAULT 0,
  agentId        TEXT,
  agentOwner     TEXT,
  worker         TEXT,
  missionId      TEXT,
  agentSessionId TEXT,
  metadata       TEXT
);
CREATE TABLE IF NOT EXISTS session_turns (
  id         TEXT PRIMARY KEY,
  sessionId  TEXT NOT NULL,
  role       TEXT NOT NULL,
  text       TEXT NOT NULL,
  at         TEXT NOT NULL,
  agentId    TEXT,
  rowid_seq  INTEGER
);
CREATE TABLE IF NOT EXISTS session_state (
  "key"      TEXT PRIMARY KEY,
  value      TEXT,
  updatedAt  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS session_tool_calls (
  id           TEXT PRIMARY KEY,
  sessionId    TEXT NOT NULL,
  turnId       TEXT NOT NULL,
  toolCallId   TEXT NOT NULL,
  toolName     TEXT NOT NULL,
  toolId       TEXT,
  arguments    TEXT NOT NULL,
  invocationId TEXT,
  status       TEXT NOT NULL,
  result       TEXT,
  approvalId   TEXT,
  startedAt    TEXT NOT NULL,
  completedAt  TEXT NOT NULL
);
`;

/**
 * Indexes are created AFTER `migrate()` runs, not as part of `SCHEMA`.
 * `idx_sessions_mission` references a column (`missionId`) that an old
 * database does not have until the migration adds it — creating the index
 * first fails the whole open with "no such column: missionId". Every index
 * here is `IF NOT EXISTS`, so running this on every open (old and new
 * database alike) is idempotent.
 */
const SCHEMA_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_session_turns_session ON session_turns (sessionId, at);
CREATE INDEX IF NOT EXISTS idx_session_tool_calls_session ON session_tool_calls (sessionId, completedAt);
CREATE INDEX IF NOT EXISTS idx_session_tool_calls_turn ON session_tool_calls (turnId);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions (status, updatedAt DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_agent_session ON sessions (agentSessionId);
CREATE INDEX IF NOT EXISTS idx_sessions_mission ON sessions (missionId);
`;

/**
 * The columns this layer added AFTER the first shipped schema. The migration is
 * idempotent (`PRAGMA table_info` decides, not a version counter) so opening an
 * old database and a new one run the same code path, and the backfill only
 * fills rows it has not already split — a re-open never overwrites a value a
 * caller set deliberately.
 */
const ADDED_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["agentOwner", "TEXT"],
  ["worker", "TEXT"],
  ["missionId", "TEXT"],
  ["summary", "TEXT"],
  ["sessionKind", "TEXT"],
];

/**
 * Split the OVERLOADED `agentId` into the two facts it carries.
 *
 * A subagent's own session is created with `agentId === "kai:<id>"` (the
 * persona's employee id — see `workforce/subagent.ts`); every other `agentId`
 * is a worker id. This is the ONE place the split is computed, so the store's
 * writes and the migration's backfill cannot disagree.
 */
export function deriveOwnership(agentId: string | undefined): {
  agentOwner?: string;
  worker?: string;
} {
  if (agentId === undefined || agentId.length === 0) return {};
  return agentId.startsWith(SUBAGENT_ID_PREFIX) ? { agentOwner: agentId } : { worker: agentId };
}

/**
 * Bring an existing database up to the current schema, idempotently.
 *
 * `PRAGMA table_info` is the source of truth for "does this column exist" —
 * a version counter would need every historical database to have been stamped,
 * and these files predate any stamping. The backfill then splits legacy
 * `agentId` values into `agentOwner`/`worker` for rows that have not been split
 * yet, so re-opening the store (a Core restart) changes nothing a second time.
 */
function migrate(db: DatabaseSync): void {
  const present = new Set(
    (db.prepare("PRAGMA table_info(sessions)").all() as unknown as Array<Record<string, unknown>>).map((row) =>
      String(row.name),
    ),
  );
  for (const [name, type] of ADDED_COLUMNS) {
    if (!present.has(name)) db.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${type}`);
  }
  db.prepare(
    `UPDATE sessions SET agentOwner = agentId
      WHERE agentId IS NOT NULL AND agentId LIKE ? AND agentOwner IS NULL`,
  ).run(`${SUBAGENT_ID_PREFIX}%`);
  db.prepare(
    `UPDATE sessions SET worker = agentId
      WHERE agentId IS NOT NULL AND agentId NOT LIKE ? AND worker IS NULL`,
  ).run(`${SUBAGENT_ID_PREFIX}%`);
  // `session_tool_calls` is young (P0 hardening): a database created between
  // its arrival and the `toolId` column must gain the column on open, exactly
  // like the sessions-table migration above.
  ensureToolCallColumns(db);
}

/** Idempotent column migration for `session_tool_calls` (see `migrate`). */
function ensureToolCallColumns(db: DatabaseSync): void {
  const present = new Set(
    (db.prepare("PRAGMA table_info(session_tool_calls)").all() as unknown as Array<Record<string, unknown>>).map(
      (row) => String(row.name),
    ),
  );
  if (!present.has("toolId")) db.exec("ALTER TABLE session_tool_calls ADD COLUMN toolId TEXT");
}

const STATUSES: readonly SessionStatus[] = ["ACTIVE", "ARCHIVED"];
const ROLES: readonly SessionTurnRole[] = ["user", "assistant"];

function toNum(value: unknown, fallback = 0): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Escape a user-supplied search string for a LIKE pattern.
 *
 * Without this, searching for "100%" would match every session and a bare "_"
 * would match any single character — the query would silently mean something
 * other than what the person typed. The escape character is `\`, declared in
 * every LIKE with `ESCAPE '\'`.
 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function optional<T extends object>(target: T, key: keyof T, value: unknown): void {
  if (value !== null && value !== undefined) {
    (target as Record<string, unknown>)[key as string] = value;
  }
}

export function createSessionStore(opts: { path?: string; now?: () => Date } = {}): SessionStore {
  const path =
    opts.path ??
    (process.env.KAI_CORE_SESSIONS_DB?.trim() || defaultSessionsPath());
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
    // Some filesystems reject WAL; the default journal is fine here.
  }
  db.exec(SCHEMA);
  migrate(db);
  db.exec(SCHEMA_INDEXES);

  const stmts = {
    get: db.prepare(`SELECT * FROM sessions WHERE id = ?`),
    listAll: db.prepare(
      `SELECT * FROM sessions ORDER BY updatedAt DESC, rowid DESC LIMIT ?`,
    ),
    listActive: db.prepare(
      `SELECT * FROM sessions WHERE status = 'ACTIVE' ORDER BY updatedAt DESC, rowid DESC LIMIT ?`,
    ),
    insert: db.prepare(
      `INSERT INTO sessions
         (id, title, status, createdAt, updatedAt, lastTurnAt, turnCount, agentId, agentOwner, worker, missionId, agentSessionId, metadata, summary, sessionKind)
       VALUES (?, ?, ?, ?, ?, NULL, 0, ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
    ),
    touch: db.prepare(`UPDATE sessions SET updatedAt = ? WHERE id = ?`),
    insertTurn: db.prepare(
      `INSERT INTO session_turns (id, sessionId, role, text, at, agentId)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ),
    insertToolCall: db.prepare(
      `INSERT INTO session_tool_calls
         (id, sessionId, turnId, toolCallId, toolName, toolId, arguments, invocationId, status, result, approvalId, startedAt, completedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    toolCallsBySession: db.prepare(
      `SELECT * FROM session_tool_calls WHERE sessionId = ? ORDER BY rowid ASC, completedAt ASC LIMIT ?`,
    ),
    deleteToolCalls: db.prepare(`DELETE FROM session_tool_calls WHERE sessionId = ?`),
    turns: db.prepare(
      `SELECT * FROM session_turns WHERE sessionId = ? ORDER BY rowid DESC, at DESC LIMIT ?`,
    ),
    countTurns: db.prepare(`SELECT COUNT(*) AS n FROM session_turns WHERE sessionId = ?`),
    deleteTurns: db.prepare(`DELETE FROM session_turns WHERE sessionId = ?`),
    deleteSession: db.prepare(`DELETE FROM sessions WHERE id = ?`),
    byWorkerSession: db.prepare(
      `SELECT * FROM sessions WHERE agentSessionId = ? ORDER BY updatedAt DESC, rowid DESC LIMIT 1`,
    ),
    byMission: db.prepare(
      `SELECT * FROM sessions WHERE missionId = ? ORDER BY updatedAt DESC, rowid DESC LIMIT 1`,
    ),
    // ESCAPE '\' makes the caller's escaped pattern literal: a query of "%"
    // must search for a percent sign, not match every row.
    searchSessions: db.prepare(
      `SELECT * FROM sessions
        WHERE id LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\'
        ORDER BY updatedAt DESC, rowid DESC LIMIT ?`,
    ),
    searchTurns: db.prepare(
      `SELECT * FROM session_turns WHERE text LIKE ? ESCAPE '\\' ORDER BY rowid ASC, at ASC LIMIT ?`,
    ),
    stateGet: db.prepare(`SELECT value FROM session_state WHERE "key" = ?`),
    stateSet: db.prepare(
      `INSERT INTO session_state ("key", value, updatedAt) VALUES (?, ?, ?)
       ON CONFLICT("key") DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt`,
    ),
    metadata: db.prepare(`SELECT metadata FROM sessions WHERE id = ?`),
  };

  function rowToSession(row: Record<string, unknown>): KaiSession {
    const status = String(row.status) as SessionStatus;
    const session: KaiSession = {
      id: String(row.id),
      title: String(row.title),
      status: (STATUSES as readonly string[]).includes(status) ? status : "ACTIVE",
      createdAt: String(row.createdAt),
      updatedAt: String(row.updatedAt),
      turnCount: toNum(row.turnCount),
    };
    optional(session, "lastTurnAt", row.lastTurnAt);
    optional(session, "agentId", row.agentId);
    optional(session, "agentOwner", row.agentOwner);
    optional(session, "worker", row.worker);
    optional(session, "missionId", row.missionId);
    optional(session, "agentSessionId", row.agentSessionId);
    if (typeof row.summary === "string") {
      try {
        session.summary = JSON.parse(row.summary) as SessionSummaryBlob;
      } catch {
        // An unreadable digest is dropped rather than failing the read.
      }
    }
    // Explicit kind wins; otherwise ownership decides, so a persona's own
    // session reads as an agent conversation without anyone writing it twice.
    if (typeof row.sessionKind === "string" && row.sessionKind.length > 0) {
      session.sessionKind = String(row.sessionKind);
    } else {
      session.sessionKind = session.agentOwner !== undefined ? "agent-conversation" : "kai-conversation";
    }
    if (typeof row.metadata === "string") {
      try {
        session.metadata = JSON.parse(row.metadata) as Record<string, unknown>;
      } catch {
        // An unreadable metadata blob is dropped rather than failing the read.
      }
    }
    return session;
  }

  function rowToTurn(row: Record<string, unknown>): SessionTurn {
    const role = String(row.role) as SessionTurnRole;
    const turn: SessionTurn = {
      id: String(row.id),
      sessionId: String(row.sessionId),
      role: (ROLES as readonly string[]).includes(role) ? role : "user",
      text: String(row.text),
      at: String(row.at),
    };
    optional(turn, "agentId", row.agentId);
    return turn;
  }

  function create(input: {
    id: string;
    title: string;
    status?: SessionStatus;
    createdAt?: string;
    agentId?: string;
    agentOwner?: string;
    worker?: string;
    missionId?: string;
    sessionKind?: string;
  }): KaiSession {
    const at = input.createdAt ?? now().toISOString();
    const existing = stmts.get.get(input.id) as Record<string, unknown> | undefined;
    if (existing !== undefined) {
      // Re-creating an existing id returns it — but an explicit kind still
      // lands, so a caller can fix a mislabelled session by re-creating it.
      if (input.sessionKind !== undefined) update(input.id, { sessionKind: input.sessionKind });
      return rowToSession((stmts.get.get(input.id) ?? existing) as Record<string, unknown>);
    }
    // Explicit agentOwner/worker win; otherwise the overloaded agentId is split
    // through the ONE derivation, so every writer agrees on what "kai:x" means.
    const split = deriveOwnership(input.agentId);
    const agentOwner = input.agentOwner ?? split.agentOwner ?? null;
    const worker = input.worker ?? split.worker ?? null;
    stmts.insert.run(
      input.id,
      input.title,
      input.status ?? "ACTIVE",
      at,
      at,
      input.agentId ?? null,
      agentOwner,
      worker,
      input.missionId ?? null,
      input.sessionKind ?? null,
    );
    const row = stmts.get.get(input.id) as Record<string, unknown> | undefined;
    return rowToSession(row as Record<string, unknown>);
  }

  function get(id: string): KaiSession | null {
    const row = stmts.get.get(id) as Record<string, unknown> | undefined;
    return row === undefined ? null : rowToSession(row);
  }

  function list(opts2: { status?: SessionStatus; limit?: number; includeArchived?: boolean } = {}): KaiSession[] {
    const limit = opts2.limit ?? 50;
    if (opts2.status === "ARCHIVED") {
      return (stmts.listAll.all(limit) as unknown as Record<string, unknown>[])
        .map(rowToSession)
        .filter((s) => s.status === "ARCHIVED");
    }
    if (opts2.status === undefined && opts2.includeArchived === true) {
      return (stmts.listAll.all(limit) as unknown as Record<string, unknown>[]).map(rowToSession);
    }
    // Default: the live conversations. Archived ones are opt-in, because a list
    // that mixes them is a list nobody can use.
    return (stmts.listActive.all(limit) as unknown as Record<string, unknown>[]).map(rowToSession);
  }

  function update(
    id: string,
    patch: {
      title?: string;
      status?: SessionStatus;
      agentId?: string;
      agentOwner?: string;
      worker?: string;
      missionId?: string | null;
      agentSessionId?: string;
      turnCount?: number;
      lastTurnAt?: string | null;
      metadata?: Record<string, unknown>;
      summary?: SessionSummaryBlob | null;
      sessionKind?: string;
    },
  ): KaiSession | null {
    const current = get(id);
    if (current === null) return null;
    const next: KaiSession = { ...current, updatedAt: now().toISOString() };
    if (patch.title !== undefined) next.title = patch.title;
    if (patch.status !== undefined) next.status = patch.status;
    if (patch.agentId !== undefined) next.agentId = patch.agentId;
    // A legacy `agentId`-only patch still splits through the ONE derivation;
    // explicit agentOwner/worker win over it.
    const split = patch.agentId !== undefined ? deriveOwnership(patch.agentId) : {};
    const agentOwner = patch.agentOwner ?? split.agentOwner;
    if (agentOwner !== undefined) next.agentOwner = agentOwner;
    const worker = patch.worker ?? split.worker;
    if (worker !== undefined) next.worker = worker;
    if (patch.missionId !== undefined) {
      if (patch.missionId === null) delete next.missionId;
      else next.missionId = patch.missionId;
    }
    if (patch.agentSessionId !== undefined) next.agentSessionId = patch.agentSessionId;
    if (patch.turnCount !== undefined) next.turnCount = patch.turnCount;
    if (patch.lastTurnAt !== undefined) {
      // `null` CLEARS the stamp; a string sets it.
      if (patch.lastTurnAt === null) delete next.lastTurnAt;
      else next.lastTurnAt = patch.lastTurnAt;
    }
    if (patch.metadata !== undefined) next.metadata = patch.metadata;
    if (patch.summary !== undefined) {
      if (patch.summary === null) delete next.summary;
      else next.summary = patch.summary;
    }
    if (patch.sessionKind !== undefined) next.sessionKind = patch.sessionKind;
    db.prepare(
      `UPDATE sessions
         SET title = ?, status = ?, updatedAt = ?, lastTurnAt = ?, turnCount = ?,
             agentId = ?, agentOwner = ?, worker = ?, missionId = ?, agentSessionId = ?, metadata = ?,
             summary = ?, sessionKind = ?
       WHERE id = ?`,
    ).run(
      next.title,
      next.status,
      next.updatedAt,
      next.lastTurnAt ?? null,
      next.turnCount,
      next.agentId ?? null,
      next.agentOwner ?? null,
      next.worker ?? null,
      next.missionId ?? null,
      next.agentSessionId ?? null,
      next.metadata !== undefined ? JSON.stringify(next.metadata) : null,
      next.summary !== undefined ? JSON.stringify(next.summary) : null,
      next.sessionKind ?? null,
      id,
    );
    return get(id);
  }

  function appendTurn(turn: SessionTurn): SessionTurn {
    stmts.insertTurn.run(
      turn.id,
      turn.sessionId,
      turn.role,
      turn.text,
      turn.at,
      turn.agentId ?? null,
    );
    const current = get(turn.sessionId);
    if (current !== null) {
      update(turn.sessionId, { turnCount: current.turnCount + 1, lastTurnAt: turn.at });
    }
    return turn;
  }

  function turns(sessionId: string, limit = 100): SessionTurn[] {
    const rows = stmts.turns.all(sessionId, limit) as unknown as Record<string, unknown>[];
    // Stored newest-first for the LIMIT; returned oldest-first, which is the
    // order a conversation reads in.
    return rows.map(rowToTurn).reverse();
  }

  function rowToToolCall(row: Record<string, unknown>): SessionToolCall {
    const call: SessionToolCall = {
      id: String(row.id),
      sessionId: String(row.sessionId),
      turnId: String(row.turnId),
      toolCallId: String(row.toolCallId),
      toolName: String(row.toolName),
      arguments: String(row.arguments),
      status: String(row.status),
      startedAt: String(row.startedAt),
      completedAt: String(row.completedAt),
    };
    optional(call, "toolId", row.toolId);
    optional(call, "invocationId", row.invocationId);
    if (typeof row.result === "string") {
      try {
        call.result = JSON.parse(row.result) as unknown;
      } catch {
        // An unreadable result blob is dropped rather than failing the read.
      }
    }
    optional(call, "approvalId", row.approvalId);
    return call;
  }

  function appendToolCall(call: SessionToolCall): SessionToolCall {
    stmts.insertToolCall.run(
      call.id,
      call.sessionId,
      call.turnId,
      call.toolCallId,
      call.toolName,
      call.toolId ?? null,
      call.arguments,
      call.invocationId ?? null,
      call.status,
      call.result !== undefined ? JSON.stringify(call.result) : null,
      call.approvalId ?? null,
      call.startedAt,
      call.completedAt,
    );
    return call;
  }

  function toolCalls(sessionId: string, limit = 500): SessionToolCall[] {
    const rows = stmts.toolCallsBySession.all(sessionId, limit) as unknown as Record<string, unknown>[];
    return rows.map(rowToToolCall);
  }

  function countTurns(sessionId: string): number {
    const row = stmts.countTurns.get(sessionId) as Record<string, unknown> | undefined;
    return toNum(row?.n);
  }

  function clearTurns(sessionId: string): number {
    let removed = 0;
    transaction(() => {
      const info = stmts.deleteTurns.run(sessionId);
      removed = toNum(info.changes);
      // A cleared conversation forgets its tool history with its turns: a
      // tool call without its turn is an outcome without its question.
      stmts.deleteToolCalls.run(sessionId);
      // The cached counters are reset in the SAME transaction as the delete, so
      // a session can never claim turns that no longer exist — and the digest
      // goes with the turns it described.
      update(sessionId, { turnCount: 0, lastTurnAt: null, summary: null });
    });
    return removed;
  }

  function replaceTurns(sessionId: string, turns: SessionTurn[], calls: SessionToolCall[]): void {
    transaction(() => {
      stmts.deleteTurns.run(sessionId);
      stmts.deleteToolCalls.run(sessionId);
      for (const turn of turns) {
        stmts.insertTurn.run(turn.id, sessionId, turn.role, turn.text, turn.at, turn.agentId ?? null);
      }
      for (const call of calls) {
        stmts.insertToolCall.run(
          call.id,
          sessionId,
          call.turnId,
          call.toolCallId,
          call.toolName,
          call.toolId ?? null,
          call.arguments,
          call.invocationId ?? null,
          call.status,
          call.result !== undefined ? JSON.stringify(call.result) : null,
          call.approvalId ?? null,
          call.startedAt,
          call.completedAt,
        );
      }
      // Counters from what was written — same rule as appendTurn, once.
      const last = turns.length > 0 ? turns[turns.length - 1] : undefined;
      update(sessionId, {
        turnCount: turns.length,
        lastTurnAt: last !== undefined ? last.at : null,
        summary: null,
      });
    });
  }

  function deleteSession(id: string): boolean {
    if (get(id) === null) return false;
    transaction(() => {
      stmts.deleteTurns.run(id);
      stmts.deleteToolCalls.run(id);
      stmts.deleteSession.run(id);
    });
    // Never leave the active pointer aimed at a session that no longer exists.
    if (activeSessionId() === id) setActiveSessionId(null);
    return true;
  }

  function findByWorkerSessionId(agentSessionId: string): KaiSession | null {
    if (agentSessionId.length === 0) return null;
    const row = stmts.byWorkerSession.get(agentSessionId) as Record<string, unknown> | undefined;
    return row === undefined ? null : rowToSession(row);
  }

  function findByMissionId(missionId: string): KaiSession | null {
    if (missionId.length === 0) return null;
    const row = stmts.byMission.get(missionId) as Record<string, unknown> | undefined;
    return row === undefined ? null : rowToSession(row);
  }

  function search(query: string, opts2: { limit?: number } = {}): SessionSearchHit[] {
    const limit = opts2.limit ?? 50;
    const pattern = `%${escapeLike(query)}%`;
    const hits: SessionSearchHit[] = [];
    const seen = new Set<string>();

    for (const row of stmts.searchSessions.all(pattern, pattern, pattern, limit) as unknown as Record<string, unknown>[]) {
      const session = rowToSession(row);
      seen.add(session.id);
      // The id is the stronger claim when both matched: it is the identity the
      // caller typed.
      const matched: SessionSearchMatch = String(row.id) === query ? "id" : "title";
      hits.push({ session, matched });
    }

    // Turn-text matches, newest-first per session but only the FIRST matching
    // turn per session is kept, so one chatty session cannot crowd the results.
    for (const row of stmts.searchTurns.all(pattern, Math.max(limit, 50)) as unknown as Record<string, unknown>[]) {
      const turn = rowToTurn(row);
      if (seen.has(turn.sessionId)) continue;
      const session = get(turn.sessionId);
      if (session === null) continue;
      seen.add(turn.sessionId);
      hits.push({ session, matched: "turn", turn });
    }

    // One ordering for the merged list: most recently updated first, like every
    // other list this layer returns.
    hits.sort((a, b) => (a.session.updatedAt < b.session.updatedAt ? 1 : a.session.updatedAt > b.session.updatedAt ? -1 : 0));
    return hits.slice(0, limit);
  }

  function transaction<T>(fn: () => T): T {
    db.exec("BEGIN");
    try {
      const out = fn();
      db.exec("COMMIT");
      return out;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // A rollback that itself failed (connection already unwound) must not
        // replace the original error — the caller needs the real cause.
      }
      throw error;
    }
  }

  function activeSessionId(): string | null {
    const row = stmts.stateGet.get("activeSessionId") as Record<string, unknown> | undefined;
    const value = row?.value;
    return typeof value === "string" && value.length > 0 ? value : null;
  }

  function setActiveSessionId(id: string | null): void {
    stmts.stateSet.run("activeSessionId", id, now().toISOString());
  }

  let closed = false;
  function close(): void {
    if (closed) return;
    closed = true;
    db.close();
  }

  return {
    path,
    create,
    get,
    list,
    update,
    appendTurn,
    turns,
    appendToolCall,
    toolCalls,
    countTurns,
    clearTurns,
    replaceTurns,
    delete: deleteSession,
    findByWorkerSessionId,
    findByMissionId,
    search,
    transaction,
    activeSessionId,
    setActiveSessionId,
    close,
  };
}
