// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * KAI Core memory service.
 *
 * The durable half of the "KAI answers from real state and remembers across
 * restarts" promise. It owns memory policy — what counts as blank, what counts
 * as a duplicate, and how the digest a chat answer is built from is ordered —
 * and delegates every byte of persistence to `MemoryStore`. Like every other
 * Core module it never touches the database directly and only sees the event
 * bus through the injected `Publish` seam.
 *
 * Two decisions worth stating because callers depend on them:
 *
 *   - Blank content is REFUSED, not stored. `remember` throws a
 *     `MemoryValidationError` carrying a contract-shaped `KaiError`
 *     (`code: "VALIDATION_FAILED"`). A silent empty row would be worse than an
 *     error: the digest would show a blank line forever and nobody would know
 *     where it came from. Callers that do not want to handle a throw (the chat
 *     router) check for a blank fact first.
 *
 *   - Deduplication is ON BY DEFAULT. Re-stating the same fact ("User is
 *     working on KAI") happens constantly in conversation, and a memory store
 *     that grows a row per mention is noise, not memory. Passing
 *     `dedupe: false` forces a new row for callers that genuinely want one.
 */

import { nowIso } from "../shared/contracts.ts";
import type {
  KaiError,
  Memory,
  MemorySource,
  MemoryStore,
  MemoryType,
} from "../shared/contracts.ts";
import type { Publish } from "../runtime.ts";

/**
 * A repeat of the same (type, content) returns the EXISTING memory instead of
 * creating another row. Content is compared after trimming, case-sensitively:
 * "KAI is a control plane" and "kai is a control plane" are treated as the same
 * fact only if the caller asks (dedupe:false) — silently collapsing text that
 * differs would make recall lossy in a way the user cannot see.
 */

/** Thrown by `remember` when the content is blank. Carries a KaiError value. */
export class MemoryValidationError extends Error {
  readonly kaiError: KaiError;

  constructor(message: string) {
    super(message);
    this.name = "MemoryValidationError";
    this.kaiError = {
      code: "VALIDATION_FAILED",
      message,
      retryable: false,
      at: nowIso(),
    };
  }
}

export interface RememberInput {
  type: MemoryType;
  content: string;
  source?: MemorySource;
  importance?: number;
  metadata?: Record<string, unknown>;
  /** Defaults to true. Set false to force a new row even if (type, content) exists. */
  dedupe?: boolean;
}

export interface SearchOptions {
  type?: MemoryType;
  /** Case-insensitive substring match against `content`. */
  text?: string;
  limit?: number;
}

export interface DigestOptions {
  limit?: number;
  types?: MemoryType[];
}

export interface MemoryService {
  remember(input: RememberInput): Memory;
  search(opts?: SearchOptions): Memory[];
  forget(id: string): boolean;
  /** Most important first, then most recent. This is the digest a chat answer is built from. */
  digest(opts?: DigestOptions): Memory[];
}

const MIN_IMPORTANCE = 1;
const MAX_IMPORTANCE = 5;

/** Importance is user/IPC supplied: keep it a whole number inside 1..5. */
function coerceImportance(value: unknown, fallback: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(MAX_IMPORTANCE, Math.max(MIN_IMPORTANCE, n));
}

/** Recency tiebreak, and total order when two rows share an instant. */
function compareForDigest(a: Memory, b: Memory): number {
  if (b.importance !== a.importance) return b.importance - a.importance;
  const at = Date.parse(a.createdAt);
  const bt = Date.parse(b.createdAt);
  if (bt !== at) return bt - at;
  // Stable, deterministic fallback so equal rows never swap between calls.
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function createMemoryService(opts: {
  store: MemoryStore;
  publish?: Publish;
  now?: () => Date;
  idFactory?: () => string;
  defaultImportance?: number;
}): MemoryService {
  const { store, publish } = opts;
  const now = opts.now ?? (() => new Date());
  const defaultImportance = coerceImportance(opts.defaultImportance, 3);

  let seq = 0;
  const idFactory =
    opts.idFactory ?? (() => `mem_${now().getTime().toString(36)}_${(seq++).toString(36)}`);

  function remember(input: RememberInput): Memory {
    const content = typeof input.content === "string" ? input.content.trim() : "";
    if (content.length === 0) {
      throw new MemoryValidationError("memory content must not be blank");
    }

    const type = input.type;
    const dedupe = input.dedupe ?? true;
    if (dedupe) {
      const existing = store
        .listMemories({ type })
        .find((memory) => memory.content.trim() === content);
      if (existing !== undefined) return existing;
    }

    const at = now().toISOString();
    const memory: Memory = {
      id: idFactory(),
      type,
      content,
      source: input.source ?? "user_statement",
      importance: coerceImportance(input.importance, defaultImportance),
      createdAt: at,
      updatedAt: at,
    };
    if (input.metadata !== undefined) memory.metadata = input.metadata;

    store.createMemory(memory);
    publish?.("memory.created", memory, { source: "core" });
    return memory;
  }

  function search(opts2?: SearchOptions): Memory[] {
    let rows =
      opts2?.type !== undefined
        ? store.listMemories({ type: opts2.type })
        : store.listMemories();
    if (opts2?.text !== undefined) {
      const needle = opts2.text.toLowerCase();
      rows = rows.filter((memory) => memory.content.toLowerCase().includes(needle));
    }
    if (opts2?.limit !== undefined) {
      rows = rows.slice(0, Math.max(0, opts2.limit));
    }
    return rows;
  }

  function forget(id: string): boolean {
    const existing = store.getMemory(id);
    if (existing === null) return false;
    store.deleteMemory(id);
    publish?.("memory.deleted", { id }, { source: "core" });
    return true;
  }

  function digest(opts2?: DigestOptions): Memory[] {
    const types = opts2?.types;
    let rows = store.listMemories();
    if (types !== undefined) {
      const wanted = new Set(types);
      rows = rows.filter((memory) => wanted.has(memory.type));
    }
    rows = rows.slice().sort(compareForDigest);
    if (opts2?.limit !== undefined) {
      rows = rows.slice(0, Math.max(0, opts2.limit));
    }
    return rows;
  }

  return { remember, search, forget, digest };
}
