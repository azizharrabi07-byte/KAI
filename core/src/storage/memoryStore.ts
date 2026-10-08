// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * KAI Core memory — SQLite implementation of `MemoryEntryStore`.
 *
 * This is the durable half of the Phase 2 memory subsystem. It is the SAME
 * storage architecture the rest of the Core uses: one SQLite database, opened
 * with Node's built-in `node:sqlite`, migrations that are idempotent and
 * additive. It does not invent a second database, a JSON sidecar, or a file
 * format a query cannot reach.
 *
 * Why its own connection rather than a table on `openSqliteStores`:
 *   - `Stores` (shared/contracts.ts) is FROZEN and does not carry a raw database
 *     handle, and the runtime wiring is another writer's file. So the memory
 *     tables are created and owned here, against the same database FILE (the
 *     caller passes the same path the Core already uses), and `close()` releases
 *     the handle. The lead wires this by passing `dbPath`.
 *   - This file may be given an existing `DatabaseSync` instead (`{ db }`), which
 *     is how a future refactor collapses to one connection with no API change.
 *
 * ── FTS5 is DETECTED, never assumed (Part B5) ─────────────────────────────────
 * `detectFts5` tries to create the virtual table AND run a MATCH against it. If
 * either throws — the SQLite build has no FTS5, or the platform forbids the
 * module — the store records `fts = false` and search falls back to a KAI-native
 * token scan with no new dependency. The FTS index is kept in sync by an
 * explicit call on every write/update/delete, so write → index → edit →
 * reindex → delete can never leave a stale hit behind.
 *
 * ── Journal is append-only (Part B8) ─────────────────────────────────────────
 * There is no UPDATE or DELETE path for `memory_journal` anywhere in this file.
 * History cannot be silently rewritten through the API because the API cannot
 * rewrite it at all.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { tokenizeMemoryText } from "../memory/model.ts";
import type {
  JournalRecord,
  MemoryEntry,
  MemoryScope,
  MemoryTopic,
  MemoryType,
} from "../memory/model.ts";
import { computeHash } from "../memory/entry.ts";
import type {
  MemoryEntryStore,
  MemoryListOptions,
  MemorySearchHit,
  MemorySearchQuery,
  MemoryScopeAccess,
} from "../memory/store.ts";

type SqlValue = string | number | bigint | null | Uint8Array;

// ── Schema ────────────────────────────────────────────────────────────────────

const MEMORY_MIGRATIONS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS memory_entries (
     id           TEXT PRIMARY KEY,
     scope        TEXT NOT NULL,
     scopeId      TEXT NOT NULL,
     content      TEXT NOT NULL,
     source       TEXT NOT NULL,
     provenance   TEXT NOT NULL,
     type         TEXT NOT NULL,
     importance   INTEGER NOT NULL DEFAULT 3,
     confidence   REAL NOT NULL DEFAULT 1,
     createdAt    TEXT NOT NULL,
     updatedAt    TEXT NOT NULL,
     date         TEXT NOT NULL,
     untilAt      TEXT,
     supersededBy TEXT,
     supersedes   TEXT,
     hash         TEXT NOT NULL,
     topicId      TEXT,
     archivedAt   TEXT,
     redacted     INTEGER NOT NULL DEFAULT 0,
     metadata     TEXT
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_memory_identity ON memory_entries (scope, scopeId, hash)`,
  `CREATE INDEX IF NOT EXISTS ix_memory_bucket ON memory_entries (scope, scopeId)`,
  `CREATE INDEX IF NOT EXISTS ix_memory_topic ON memory_entries (topicId)`,
  `CREATE INDEX IF NOT EXISTS ix_memory_superseded ON memory_entries (supersededBy)`,
  `CREATE TABLE IF NOT EXISTS memory_topics (
     id          TEXT PRIMARY KEY,
     slug        TEXT NOT NULL UNIQUE,
     title       TEXT NOT NULL,
     description TEXT NOT NULL,
     aliases     TEXT,
     createdAt   TEXT NOT NULL,
     updatedAt   TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS memory_journal (
     id         TEXT PRIMARY KEY,
     at         TEXT NOT NULL,
     actor      TEXT NOT NULL,
     source     TEXT NOT NULL,
     op         TEXT NOT NULL,
     entryId    TEXT,
     scope      TEXT,
     scopeId    TEXT,
     beforeHash TEXT,
     afterHash  TEXT,
     change     TEXT NOT NULL,
     reason     TEXT NOT NULL,
     reversible INTEGER NOT NULL DEFAULT 0,
     revertsId  TEXT,
     before     TEXT,
     after      TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS ix_memory_journal_entry ON memory_journal (entryId)`,
  `CREATE INDEX IF NOT EXISTS ix_memory_journal_at ON memory_journal (at)`,
  `CREATE TABLE IF NOT EXISTS memory_state (
     key       TEXT PRIMARY KEY,
     value     TEXT NOT NULL,
     updatedAt TEXT NOT NULL
   )`,
];

// ── Value helpers ─────────────────────────────────────────────────────────────

function toJson(value: unknown): string | null {
  if (value === undefined) return null;
  const encoded = JSON.stringify(value);
  return encoded === undefined ? null : encoded;
}

function fromJson<T>(value: unknown): T | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function toStr(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function toNum(value: unknown, fallback = 0): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toBool(value: unknown): boolean {
  return value === 1 || value === true || value === "1";
}

function optional<T>(target: T, key: keyof T, value: unknown): void {
  if (value !== null && value !== undefined && value !== "") {
    (target as Record<string, unknown>)[key as string] = value;
  }
}

// ── Open ──────────────────────────────────────────────────────────────────────

export interface OpenMemoryStoreOptions {
  /** Database file. Omit when `db` is supplied. */
  path?: string;
  /** Reuse an already-open handle. Caller keeps ownership of closing it. */
  db?: DatabaseSync;
  /**
   * Force the FTS5 detection outcome. Tests use this to exercise the fallback
   * without shipping a SQLite build that lacks FTS5. Production never sets it.
   */
  forceFts?: boolean;
}

export interface MemoryStoreHandle extends MemoryEntryStore {
  /** The path the store was opened at, when it opened its own connection. */
  readonly path: string | null;
}

export function openMemoryStore(opts: OpenMemoryStoreOptions = {}): MemoryStoreHandle {
  const ownsDb = opts.db === undefined;
  const resolvedPath = opts.db === undefined ? (opts.path ?? ":memory:") : null;
  const path = resolvedPath;

  if (resolvedPath !== null && resolvedPath !== ":memory:" && !resolvedPath.startsWith("file:")) {
    const dir = dirname(resolvedPath);
    if (dir.length > 0 && dir !== ".") mkdirSync(dir, { recursive: true });
  }

  const db = opts.db ?? new DatabaseSync(resolvedPath ?? ":memory:");
  db.exec("PRAGMA busy_timeout = 5000");

  for (const statement of MEMORY_MIGRATIONS) db.exec(statement);

  // Detect, do not assume.
  let fts = false;
  if (opts.forceFts === false) {
    fts = false;
  } else {
    fts = detectFts5(db);
  }

  // ── prepared statements ────────────────────────────────────────────────────
  const stmts = {
    insert: db.prepare(
      `INSERT INTO memory_entries
        (id, scope, scopeId, content, source, provenance, type, importance, confidence,
         createdAt, updatedAt, date, untilAt, supersededBy, supersedes, hash, topicId, archivedAt, redacted, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    get: db.prepare(`SELECT * FROM memory_entries WHERE id = ?`),
    update: db.prepare(
      `UPDATE memory_entries SET
         scope = ?, scopeId = ?, content = ?, source = ?, provenance = ?, type = ?,
         importance = ?, confidence = ?, createdAt = ?, updatedAt = ?, date = ?,
         untilAt = ?, supersededBy = ?, supersedes = ?, hash = ?, topicId = ?,
         archivedAt = ?, redacted = ?, metadata = ?
       WHERE id = ?`,
    ),
    remove: db.prepare(`DELETE FROM memory_entries WHERE id = ?`),
    listBucket: db.prepare(
      `SELECT * FROM memory_entries WHERE scope = ? AND scopeId = ?
       ORDER BY createdAt DESC, rowid DESC`,
    ),
    byHash: db.prepare(`SELECT * FROM memory_entries WHERE scope = ? AND scopeId = ? AND hash = ?`),
    listAll: db.prepare(`SELECT * FROM memory_entries ORDER BY createdAt DESC, rowid DESC LIMIT ?`),
    countBucket: db.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(content) - LENGTH(REPLACE(content, char(10), '')) + 1), 0) AS lines
       FROM memory_entries WHERE scope = ? AND scopeId = ?`,
    ),
    sumBytes: db.prepare(`SELECT content FROM memory_entries WHERE scope = ? AND scopeId = ?`),

    upsertTopic: db.prepare(
      `INSERT INTO memory_topics (id, slug, title, description, aliases, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         slug = excluded.slug, title = excluded.title, description = excluded.description,
         aliases = excluded.aliases, updatedAt = excluded.updatedAt`,
    ),
    getTopic: db.prepare(`SELECT * FROM memory_topics WHERE id = ?`),
    getTopicBySlug: db.prepare(`SELECT * FROM memory_topics WHERE slug = ?`),
    listTopics: db.prepare(`SELECT * FROM memory_topics ORDER BY slug ASC LIMIT ?`),
    deleteTopic: db.prepare(`DELETE FROM memory_topics WHERE id = ?`),

    insertJournal: db.prepare(
      `INSERT INTO memory_journal
        (id, at, actor, source, op, entryId, scope, scopeId, beforeHash, afterHash, change, reason, reversible, revertsId, before, after)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    getJournal: db.prepare(`SELECT * FROM memory_journal WHERE id = ?`),
    listJournal: db.prepare(`SELECT * FROM memory_journal ORDER BY at DESC, rowid DESC LIMIT ?`),
    listJournalForEntry: db.prepare(
      `SELECT * FROM memory_journal WHERE entryId = ? ORDER BY at DESC, rowid DESC LIMIT ?`,
    ),

    getState: db.prepare(`SELECT value FROM memory_state WHERE key = ?`),
    setState: db.prepare(
      `INSERT INTO memory_state (key, value, updatedAt) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt`,
    ),
  };

  const ftsStmts = fts
    ? {
        upsert: db.prepare(`INSERT INTO memory_fts (entryId, content) VALUES (?, ?)`),
        delete: db.prepare(`DELETE FROM memory_fts WHERE entryId = ?`),
        match: db.prepare(`SELECT entryId FROM memory_fts WHERE memory_fts MATCH ? LIMIT 500`),
      }
    : null;

  // ── row mapping ────────────────────────────────────────────────────────────
  function entryFromRow(row: Record<string, unknown>): MemoryEntry {
    const entry: MemoryEntry = {
      id: toStr(row.id),
      scope: toStr(row.scope) as MemoryScope,
      scopeId: toStr(row.scopeId),
      content: toStr(row.content),
      source: toStr(row.source) as MemoryEntry["source"],
      provenance: toStr(row.provenance) as MemoryEntry["provenance"],
      type: toStr(row.type) as MemoryType,
      importance: toNum(row.importance, 3),
      confidence: toNum(row.confidence, 1),
      createdAt: toStr(row.createdAt),
      updatedAt: toStr(row.updatedAt),
      date: toStr(row.date),
      hash: toStr(row.hash),
    };
    optional(entry, "until", row.untilAt);
    optional(entry, "supersededBy", row.supersededBy);
    optional(entry, "supersedes", row.supersedes);
    optional(entry, "topicId", row.topicId);
    optional(entry, "archivedAt", row.archivedAt);
    if (toBool(row.redacted)) entry.redacted = true;
    const meta = fromJson<Record<string, unknown>>(row.metadata);
    if (meta !== undefined) entry.metadata = meta;
    return entry;
  }

  function topicFromRow(row: Record<string, unknown>): MemoryTopic {
    const aliases = fromJson<string[]>(row.aliases) ?? [];
    return {
      id: toStr(row.id),
      slug: toStr(row.slug),
      title: toStr(row.title),
      description: toStr(row.description),
      aliases,
      createdAt: toStr(row.createdAt),
      updatedAt: toStr(row.updatedAt),
    };
  }

  function journalFromRow(row: Record<string, unknown>): JournalRecord {
    const record: JournalRecord = {
      id: toStr(row.id),
      at: toStr(row.at),
      actor: toStr(row.actor),
      source: toStr(row.source),
      op: toStr(row.op) as JournalRecord["op"],
      change: fromJson<Record<string, unknown>>(row.change) ?? {},
      reason: toStr(row.reason),
      reversible: toBool(row.reversible),
    };
    optional(record, "entryId", row.entryId);
    optional(record, "scope", (row.scope === null || row.scope === undefined ? undefined : toStr(row.scope)) as MemoryScope | undefined);
    optional(record, "scopeId", row.scopeId);
    optional(record, "beforeHash", row.beforeHash);
    optional(record, "afterHash", row.afterHash);
    optional(record, "revertsId", row.revertsId);
    const before = fromJson<Record<string, unknown>>(row.before);
    if (before !== undefined) record.before = before;
    const after = fromJson<Record<string, unknown>>(row.after);
    if (after !== undefined) record.after = after;
    return record;
  }

  // ── FTS index sync ─────────────────────────────────────────────────────────
  function indexEntry(entry: MemoryEntry): void {
    if (ftsStmts === null) return;
    ftsStmts.delete.run(entry.id);
    ftsStmts.upsert.run(entry.id, entry.content);
  }
  function unindexEntry(id: string): void {
    if (ftsStmts === null) return;
    ftsStmts.delete.run(id);
  }

  // ── scope filter (Part B5) ─────────────────────────────────────────────────
  function scopeFilter(access: readonly MemoryScopeAccess[]): { sql: string; params: SqlValue[] } | null {
    const clauses: string[] = [];
    const params: SqlValue[] = [];
    for (const a of access) {
      if (a.scope === "global") {
        clauses.push(`scope = 'global'`);
        continue;
      }
      const ids = (a.ids ?? []).filter((id) => typeof id === "string" && id.length > 0);
      if (ids.length === 0) continue; // A private scope with no named id grants nothing.
      clauses.push(`(scope = ? AND scopeId IN (${ids.map(() => "?").join(", ")}))`);
      params.push(a.scope, ...ids);
    }
    if (clauses.length === 0) return null;
    return { sql: `(${clauses.join(" OR ")})`, params };
  }

  function activeFilter(
    now: string,
    includeExpired: boolean,
    includeSuperseded: boolean,
    includeArchived: boolean,
    params: SqlValue[],
  ): string {
    const parts: string[] = [];
    // Redacted/unsafe rows are never surfaced by search (Part B5): a fact that
    // was masked on the way in is not a fact worth recalling.
    parts.push(`(redacted IS NULL OR redacted = 0)`);
    if (!includeExpired) {
      parts.push(`(untilAt IS NULL OR untilAt = '' OR untilAt > ?)`);
      params.push(now);
    }
    if (!includeSuperseded) parts.push(`(supersededBy IS NULL OR supersededBy = '')`);
    if (!includeArchived) parts.push(`(archivedAt IS NULL OR archivedAt = '')`);
    return parts.length === 0 ? "1" : parts.join(" AND ");
  }

  // ── ranking ────────────────────────────────────────────────────────────────
  function tokenize(text: string): string[] {
    // ONE matching semantics for the whole subsystem (see model.ts): the
    // runtime's shared-entry filter delegates to the same function, so a fact
    // recallable here is never invisible when reached through a share pointer.
    return tokenizeMemoryText(text);
  }

  const DAY_MS = 24 * 60 * 60 * 1000;
  function recencyBoost(entry: MemoryEntry, nowMs: number): number {
    const at = Date.parse(entry.createdAt);
    if (!Number.isFinite(at)) return 0;
    const ageDays = Math.max(0, (nowMs - at) / DAY_MS);
    return 1 / (1 + ageDays);
  }

  /**
   * Deterministic combined score: query-term coverage dominates, then
   * importance, then recency. Ties break on id so two identical stores always
   * return the same order.
   */
  function score(entry: MemoryEntry, tokens: string[], nowMs: number): number {
    const haystack = entry.content.toLowerCase();
    let terms = 0;
    for (const token of tokens) if (haystack.includes(token)) terms += 1;
    const termScore = tokens.length === 0 ? 0 : terms / tokens.length;
    return termScore * 10 + entry.importance * 0.5 + entry.confidence * 0.25 + recencyBoost(entry, nowMs) * 0.1;
  }

  function compareHits(a: MemorySearchHit, b: MemorySearchHit): number {
    if (b.score !== a.score) return b.score - a.score;
    if (a.entry.createdAt !== b.entry.createdAt) return a.entry.createdAt < b.entry.createdAt ? 1 : -1;
    return a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0;
  }

  // ── the store ──────────────────────────────────────────────────────────────
  const store: MemoryStoreHandle = {
    path,

    insert(entry: MemoryEntry): void {
      stmts.insert.run(
        entry.id,
        entry.scope,
        entry.scopeId,
        entry.content,
        entry.source,
        entry.provenance,
        entry.type,
        entry.importance,
        entry.confidence,
        entry.createdAt,
        entry.updatedAt,
        entry.date,
        entry.until ?? null,
        entry.supersededBy ?? null,
        entry.supersedes ?? null,
        entry.hash,
        entry.topicId ?? null,
        entry.archivedAt ?? null,
        entry.redacted ? 1 : 0,
        toJson(entry.metadata),
      );
      indexEntry(entry);
    },

    get(id: string): MemoryEntry | null {
      const row = stmts.get.get(id) as Record<string, unknown> | undefined;
      return row === undefined ? null : entryFromRow(row);
    },

    update(entry: MemoryEntry): void {
      stmts.update.run(
        entry.scope,
        entry.scopeId,
        entry.content,
        entry.source,
        entry.provenance,
        entry.type,
        entry.importance,
        entry.confidence,
        entry.createdAt,
        entry.updatedAt,
        entry.date,
        entry.until ?? null,
        entry.supersededBy ?? null,
        entry.supersedes ?? null,
        entry.hash,
        entry.topicId ?? null,
        entry.archivedAt ?? null,
        entry.redacted ? 1 : 0,
        toJson(entry.metadata),
        entry.id,
      );
      // Re-index on edit: the old text must stop matching immediately.
      indexEntry(entry);
    },

    remove(id: string): void {
      stmts.remove.run(id);
      unindexEntry(id);
    },

    listBucket(scope: MemoryScope, scopeId: string, opts: MemoryListOptions = {}): MemoryEntry[] {
      const now = opts.now ?? new Date().toISOString();
      let rows = (stmts.listBucket.all(scope, scopeId) as unknown as Record<string, unknown>[]).map(entryFromRow);
      rows = rows.filter((entry) => {
        if (!opts.includeExpired && (entry.until !== undefined && Date.parse(entry.until) <= Date.parse(now))) return false;
        if (!opts.includeSuperseded && entry.supersededBy !== undefined && entry.supersededBy.length > 0) return false;
        if (!opts.includeArchived && entry.archivedAt !== undefined && entry.archivedAt.length > 0) return false;
        return true;
      });
      if (opts.limit !== undefined) rows = rows.slice(0, Math.max(0, opts.limit));
      return rows;
    },

    listAll(opts: MemoryListOptions = {}): MemoryEntry[] {
      const now = opts.now ?? new Date().toISOString();
      const cap = opts.limit === undefined ? 5000 : Math.max(0, opts.limit);
      let rows = (stmts.listAll.all(cap) as unknown as Record<string, unknown>[]).map(entryFromRow);
      rows = rows.filter((entry) => {
        if (!opts.includeExpired && (entry.until !== undefined && Date.parse(entry.until) <= Date.parse(now))) return false;
        if (!opts.includeSuperseded && entry.supersededBy !== undefined && entry.supersededBy.length > 0) return false;
        if (!opts.includeArchived && entry.archivedAt !== undefined && entry.archivedAt.length > 0) return false;
        return true;
      });
      return rows;
    },

    bucketUsage(scope: MemoryScope, scopeId: string) {
      const count = stmts.countBucket.get(scope, scopeId) as { n?: unknown; lines?: unknown } | undefined;
      const entryCount = toNum(count?.n, 0);
      const rawLines = toNum(count?.lines, 0);
      const byteRows = stmts.sumBytes.all(scope, scopeId) as unknown as { content?: unknown }[];
      let bytes = 0;
      for (const row of byteRows) bytes += Buffer.byteLength(toStr(row.content), "utf8");
      // `lines` from SQL counts every row as at least one line; an empty-content
      // row would overcount by one, but the store never writes empty content.
      return { entries: entryCount, lines: rawLines, bytes };
    },

    findByHash(scope: MemoryScope, scopeId: string, hash: string): MemoryEntry | null {
      const row = stmts.byHash.get(scope, scopeId, hash) as Record<string, unknown> | undefined;
      return row === undefined ? null : entryFromRow(row);
    },

    importLegacy(rows): number {
      const hasLegacy = db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memories'`)
        .get() as { name?: unknown } | undefined;
      if (hasLegacy === undefined) return 0;

      const legacy = db.prepare(`SELECT * FROM memories`).all() as unknown as Record<string, unknown>[];
      let imported = 0;
      const at = new Date().toISOString();
      for (const row of legacy) {
        const content = toStr(row.content);
        if (content.trim().length === 0) continue;
        const id = `legacy_${toStr(row.id)}`;
        const existing = stmts.get.get(id) as Record<string, unknown> | undefined;
        if (existing !== undefined) continue;
        const hash = computeHash("global", "global", content);
        try {
          stmts.insert.run(
            id,
            "global",
            "global",
            content,
            toStr(row.source) || "system_state",
            "legacy",
            toStr(row.type) || "note",
            toNum(row.importance, 3),
            1,
            toStr(row.createdAt) || at,
            toStr(row.updatedAt) || at,
            toStr(row.createdAt) || at,
            null,
            null,
            null,
            hash,
            null,
            null,
            0,
            typeof row.metadata === "string" ? row.metadata : toJson(fromJson(row.metadata)),
          );
          indexEntry(entryFromRow(stmts.get.get(id) as Record<string, unknown>));
          imported += 1;
        } catch {
          // A legacy row whose hash collides with an existing canonical entry
          // is simply skipped: the fact is already represented.
        }
      }
      return imported;
    },

    ftsAvailable(): boolean {
      return fts;
    },

    search(query: MemorySearchQuery): MemorySearchHit[] {
      const scope = scopeFilter(query.scopes);
      if (scope === null) return [];

      const types = query.types;
      const params: SqlValue[] = [];
      const where: string[] = [scope.sql];
      params.push(...scope.params);
      where.push(activeFilter(
        query.now,
        query.includeExpired === true,
        query.includeSuperseded === true,
        query.includeArchived === true,
        params,
      ));
      if (types !== undefined && types.length > 0) {
        where.push(`type IN (${types.map(() => "?").join(", ")})`);
        params.push(...types);
      }

      const tokens = query.text === undefined ? [] : tokenize(query.text);
      const cap = query.limit === undefined ? 50 : Math.max(1, Math.min(query.limit, 200));

      let rows: MemoryEntry[];
      if (tokens.length > 0 && fts && ftsStmts !== null) {
        // Candidate selection through FTS5, then KAI's deterministic ranking.
        const match = sanitizeFtsQuery(tokens);
        if (match.length === 0) return [];
        let ids: string[];
        try {
          ids = (ftsStmts.match.all(match) as unknown as { entryId?: unknown }[]).map((r) => toStr(r.entryId));
        } catch {
          ids = [];
        }
        if (ids.length === 0) return [];
        const idWhere = `id IN (${ids.map(() => "?").join(", ")})`;
        const rawRows = db
          .prepare(`SELECT * FROM memory_entries WHERE ${idWhere} AND ${where.join(" AND ")}`)
          .all(...ids, ...params) as unknown as Record<string, unknown>[];
        rows = rawRows.map(entryFromRow);
      } else {
        // Fallback (or browse): load the allowed, active rows and score in the
        // engine's terms. Bounded so a huge store cannot stall a read.
        const rawRows = db
          .prepare(`SELECT * FROM memory_entries WHERE ${where.join(" AND ")} ORDER BY createdAt DESC LIMIT 2000`)
          .all(...params) as unknown as Record<string, unknown>[];
        rows = rawRows.map(entryFromRow);
        if (tokens.length > 0) {
          rows = rows.filter((entry) => tokens.some((token) => entry.content.toLowerCase().includes(token)));
        }
      }

      const nowMs = Date.parse(query.now);
      const hits = rows.map((entry) => ({ entry, score: score(entry, tokens, Number.isFinite(nowMs) ? nowMs : Date.now()) }));
      hits.sort(compareHits);
      return hits.slice(0, cap);
    },

    upsertTopic(topic: MemoryTopic): void {
      stmts.upsertTopic.run(
        topic.id,
        topic.slug,
        topic.title,
        topic.description,
        toJson(topic.aliases.length > 0 ? topic.aliases : []),
        topic.createdAt,
        topic.updatedAt,
      );
    },
    getTopic(id: string): MemoryTopic | null {
      const row = stmts.getTopic.get(id) as Record<string, unknown> | undefined;
      return row === undefined ? null : topicFromRow(row);
    },
    getTopicBySlug(slug: string): MemoryTopic | null {
      const row = stmts.getTopicBySlug.get(slug) as Record<string, unknown> | undefined;
      return row === undefined ? null : topicFromRow(row);
    },
    listTopics(limit?: number): MemoryTopic[] {
      const cap = limit === undefined ? 200 : Math.max(0, limit);
      return (stmts.listTopics.all(cap) as unknown as Record<string, unknown>[]).map(topicFromRow);
    },
    deleteTopic(id: string): void {
      stmts.deleteTopic.run(id);
    },

    appendJournal(record: JournalRecord): void {
      stmts.insertJournal.run(
        record.id,
        record.at,
        record.actor,
        record.source,
        record.op,
        record.entryId ?? null,
        record.scope ?? null,
        record.scopeId ?? null,
        record.beforeHash ?? null,
        record.afterHash ?? null,
        toJson(record.change) ?? "{}",
        record.reason,
        record.reversible ? 1 : 0,
        record.revertsId ?? null,
        toJson(record.before),
        toJson(record.after),
      );
    },
    getJournal(id: string): JournalRecord | null {
      const row = stmts.getJournal.get(id) as Record<string, unknown> | undefined;
      return row === undefined ? null : journalFromRow(row);
    },
    listJournal(opts: { limit?: number; entryId?: string } = {}): JournalRecord[] {
      const cap = opts.limit === undefined ? 100 : Math.max(0, opts.limit);
      const rows =
        opts.entryId === undefined
          ? (stmts.listJournal.all(cap) as unknown as Record<string, unknown>[])
          : (stmts.listJournalForEntry.all(opts.entryId, cap) as unknown as Record<string, unknown>[]);
      return rows.map(journalFromRow);
    },

    getState(key: string): string | null {
      const row = stmts.getState.get(key) as { value?: unknown } | undefined;
      return row === undefined ? null : toStr(row.value);
    },
    setState(key: string, value: string): void {
      stmts.setState.run(key, value, new Date().toISOString());
    },
    getUpkeepEnabled(): boolean {
      const value = store.getState("upkeep.enabled");
      return value === null ? true : value === "true";
    },
    setUpkeepEnabled(enabled: boolean): void {
      store.setState("upkeep.enabled", enabled ? "true" : "false");
    },

    close(): void {
      if (ownsDb) db.close();
    },
  };

  return store;
}

// ── FTS query sanitising ──────────────────────────────────────────────────────

/**
 * Turn KAI tokens into a safe FTS5 MATCH expression. Tokens are already
 * alphanumeric (see `tokenize`), so this only has to join them; quoting and a
 * prefix `*` make a partial word match without letting FTS5 syntax through.
 */
function sanitizeFtsQuery(tokens: readonly string[]): string {
  const safe = tokens.filter((t) => /^[a-z0-9_]+$/.test(t)).slice(0, 12);
  if (safe.length === 0) return "";
  return safe.map((t) => `"${t}"*`).join(" OR ");
}

// ── FTS5 detection ────────────────────────────────────────────────────────────

/**
 * True only when this SQLite build can create an FTS5 table AND match against
 * it. The probe is a real create + match, not a version check, because a build
 * can be compiled without the module or with a limited tokenizer.
 */
function detectFts5(db: DatabaseSync): boolean {
  try {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(entryId UNINDEXED, content)`);
    db.prepare(`SELECT entryId FROM memory_fts WHERE memory_fts MATCH 'probe' LIMIT 1`).all();
    return true;
  } catch {
    return false;
  }
}
