// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * KAI Core memory — durable store interface.
 *
 * The engine (Part B1-B8) is written against THIS interface, not against SQL.
 * `core/src/storage/memoryStore.ts` implements it on `node:sqlite`, and tests
 * can implement it in memory. That split is the same discipline the rest of the
 * Core uses for `Stores`: the database never leaks into the policy above it.
 *
 * The interface is deliberately wide rather than chatty: a caller asks for a
 * bucket, a search, a journal page or a state flag in one call, so the engine
 * never has to reconstruct the store's indexing rules.
 */

import type {
  JournalRecord,
  MemoryEntry,
  MemoryScope,
  MemoryTopic,
  MemoryType,
} from "./model.ts";

/**
 * Who a search may read. `global` is shared and always readable. Every other
 * scope is PRIVATE: listing `{scope: "mission"}` without ids grants nothing, so
 * a caller must name the mission (or missions) it is allowed to see. This is the
 * shape Part B5's "never leak another scope's private memory" reduces to.
 */
export interface MemoryScopeAccess {
  scope: MemoryScope;
  /** Allowed scope ids. Ignored for `global`. Empty/omitted ⇒ no access. */
  ids?: readonly string[];
}

export interface MemorySearchQuery {
  /** Search text. Empty/omitted = browse the allowed scopes, most recent first. */
  text?: string;
  /** Exactly which scopes/ids the caller may read. */
  scopes: readonly MemoryScopeAccess[];
  /** ISO-8601 instant used for expiry. */
  now: string;
  limit?: number;
  /** Include expired entries (default false). */
  includeExpired?: boolean;
  /** Include superseded entries (default false). */
  includeSuperseded?: boolean;
  /** Include archived entries (default false). */
  includeArchived?: boolean;
  /** Restrict to these legacy memory types. */
  types?: readonly MemoryType[];
}

export interface MemorySearchHit {
  entry: MemoryEntry;
  /** Higher is better. Deterministic for identical stores and queries. */
  score: number;
}

export interface MemoryListOptions {
  includeExpired?: boolean;
  includeSuperseded?: boolean;
  includeArchived?: boolean;
  now?: string;
  limit?: number;
}

export interface MemoryEntryStore {
  /** Filesystem path this store is bound to, when it opened its own connection. */
  readonly path?: string | null;
  // ── entries ────────────────────────────────────────────────────────────────
  insert(entry: MemoryEntry): void;
  get(id: string): MemoryEntry | null;
  update(entry: MemoryEntry): void;
  /** Hard delete. Only used for a revert of a create, or an explicit forget. */
  remove(id: string): void;
  /** All entries in one bucket, newest first unless a bound filter is set. */
  listBucket(scope: MemoryScope, scopeId: string, opts?: MemoryListOptions): MemoryEntry[];
  /** Every entry across every bucket (bounded), for upkeep and the layout projection. */
  listAll(opts?: MemoryListOptions): MemoryEntry[];
  /** Current line/byte/entry usage of one bucket. */
  bucketUsage(scope: MemoryScope, scopeId: string): { entries: number; lines: number; bytes: number };
  /** Deterministic identity lookup within a bucket. */
  findByHash(scope: MemoryScope, scopeId: string, hash: string): MemoryEntry | null;
  /** Kept for legacy import; counts rows copied. */
  importLegacy(rows: readonly { id: string; type: string; content: string; source: string; importance: number; createdAt: string; updatedAt: string; metadata?: Record<string, unknown> }[]): number;

  // ── search ─────────────────────────────────────────────────────────────────
  /** True when this store is backed by SQLite FTS5 (detected, never assumed). */
  ftsAvailable(): boolean;
  search(query: MemorySearchQuery): MemorySearchHit[];

  // ── topics (Part B4) ───────────────────────────────────────────────────────
  upsertTopic(topic: MemoryTopic): void;
  getTopic(id: string): MemoryTopic | null;
  getTopicBySlug(slug: string): MemoryTopic | null;
  listTopics(limit?: number): MemoryTopic[];
  deleteTopic(id: string): void;

  // ── journal (Part B8) ──────────────────────────────────────────────────────
  /** Append-only. There is no update/delete of a journal row anywhere in the API. */
  appendJournal(record: JournalRecord): void;
  getJournal(id: string): JournalRecord | null;
  listJournal(opts?: { limit?: number; entryId?: string }): JournalRecord[];

  // ── upkeep state (Part B7) ─────────────────────────────────────────────────
  getState(key: string): string | null;
  setState(key: string, value: string): void;
  getUpkeepEnabled(): boolean;
  setUpkeepEnabled(enabled: boolean): void;

  close(): void;
}
