// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * KAI Core memory — canonical model (Phase 2 Part B1 + B2).
 *
 * This file is the vocabulary the whole memory subsystem agrees on. It adds a
 * layer ABOVE the flat `Memory` contract in `shared/contracts.ts` without
 * reshaping it: the legacy `Memory`/`MemoryStore`/`MemoryService` keep working
 * exactly as before, and a canonical `MemoryEntry` is what the new store, the
 * scoped search, capture and upkeep all speak.
 *
 * Why a scoped canonical entry rather than another flat row:
 *
 *   - The Phase 0 audit found memory was flat/global: every read was the whole
 *     table filtered by `type` at most. A mission's context could be recalled in
 *     an unrelated session and there was nowhere to say WHEN a fact stops being
 *     true. That is the failure this model fixes.
 *   - `scope` names WHO the fact belongs to; `scopeId` names WHICH instance
 *     (a session id, a mission id, an employee id, a project id). `global` has
 *     the fixed id "global" — it is the only scope that is not private.
 *   - `until` is an optional expiry and `supersededBy` marks a fact another has
 *     replaced. Both are EXCLUSIONS applied at read time, so an expired or
 *     superseded fact is never recalled and a stale one never shadows a fresh
 *     one.
 *   - `hash` is a deterministic content identity (Part B3): the same input
 *     written twice collapses to one entry, with no fuzzy/AI matching involved.
 *
 * Design constraints carried here because the rest of the subsystem depends on
 * them:
 *
 *   - Bounds are HARD (Part B2). `MEMORY_SCOPE_BOUNDS` gives every scope a line
 *     budget and a byte budget. A write that would exceed either is REFUSED with
 *     a machine-readable reason; the subsystem never silently writes memory that
 *     can no longer be reached.
 *   - A refusal is a value, not an exception: `MemoryWriteResult` is a union so
 *     a caller must look at `ok` before assuming a write happened.
 *   - A refusal always carries a contract-shaped `KaiError` whose `detail` is the
 *     stable machine code, so the UI and the Core can both branch on it without
 *     parsing prose.
 */

import { nowIso } from "../shared/contracts.ts";
import type {
  KaiError,
  KaiErrorCode,
  MemorySource,
  MemoryType,
} from "../shared/contracts.ts";

// Re-exported so consumers of the canonical model do not also have to reach into
// the frozen contracts file for the two shapes it keeps using.
export type { MemorySource, MemoryType } from "../shared/contracts.ts";

// ── Scopes ────────────────────────────────────────────────────────────────────

/**
 * WHO a memory belongs to.
 *
 *   global    shared, durable facts (a user preference, how KAI is built).
 *   session   what is true for one conversation/thread.
 *   mission   context and results of one mission.
 *   employee  facts about one worker (Hermes, OpenCode, ...).
 *   project   facts about one project/repository.
 *   subagent  facts private to ONE KAI subagent persona. The `scopeId` is the
 *             persona's own id, minted by KAI's subagent registry — so one
 *             persona's working memory is unreachable from another unless an
 *             explicit, governed share names the entry.
 *
 * Only `global` is readable from anywhere. Every other scope is PRIVATE to its
 * `scopeId` and a search must name the ids it is allowed to see (Part B5).
 */
export type MemoryScope = "global" | "session" | "mission" | "employee" | "project" | "subagent";

export const MEMORY_SCOPES: readonly MemoryScope[] = [
  "global",
  "session",
  "mission",
  "employee",
  "project",
  "subagent",
];

export function isMemoryScope(value: unknown): value is MemoryScope {
  return typeof value === "string" && (MEMORY_SCOPES as readonly string[]).includes(value);
}

/** The fixed `scopeId` of the one shared scope. */
export const GLOBAL_SCOPE_ID = "global";

/** A concrete (scope, scopeId) bucket. Global always uses "global". */
export interface MemoryScopeRef {
  scope: MemoryScope;
  scopeId: string;
}

// ── Provenance ────────────────────────────────────────────────────────────────

/**
 * Where an entry came from. Richer than the frozen contract's `MemorySource`
 * (which keeps its four values for the legacy path) because the canonical layer
 * must distinguish a fact a user stated, one the host derived from system state,
 * and one a MODEL proposed that the host then validated (Part B6).
 */
export type MemoryProvenance =
  | "user_statement"
  | "system_state"
  | "mission_result"
  | "agent_output"
  | "tool_result"
  | "model_candidate"
  | "upkeep"
  | "imported"
  | "legacy";

export const MEMORY_PROVENANCES: readonly MemoryProvenance[] = [
  "user_statement",
  "system_state",
  "mission_result",
  "agent_output",
  "tool_result",
  "model_candidate",
  "upkeep",
  "imported",
  "legacy",
];

/** The contract's four sources, used when projecting a canonical entry back to `Memory`. */
export function toMemorySource(provenance: MemoryProvenance): MemorySource {
  switch (provenance) {
    case "system_state":
      return "system_state";
    case "mission_result":
      return "mission_result";
    case "agent_output":
      return "agent_output";
    case "user_statement":
      return "user_statement";
    // Facts the host derived (a tool result, an upkeep decision, an import) are
    // honestly reported as system state; none of them is a user statement.
    default:
      return "system_state";
  }
}

// ── The canonical entry ───────────────────────────────────────────────────────

export interface MemoryEntry {
  id: string;
  scope: MemoryScope;
  scopeId: string;
  /** One fact, single-line after grammar normalisation (Part B3). */
  content: string;
  /** Contract-compatible coarse source, kept for the legacy projection. */
  source: MemorySource;
  /** Richer provenance (Part B1). */
  provenance: MemoryProvenance;
  type: MemoryType;
  /** 1 (trivia) .. 5 (must not be forgotten). */
  importance: number;
  /** 0..1 confidence in the fact itself, distinct from importance. */
  confidence: number;
  /** ISO-8601 instant the entry was written. */
  createdAt: string;
  updatedAt: string;
  /** ISO-8601 date/timestamp the fact REFERS to (Part B1 "date"). Defaults to createdAt. */
  date: string;
  /** Optional ISO-8601 expiry. At or after this instant the entry is not recalled. */
  until?: string;
  /** When set, another entry replaced this one and this one is not recalled. */
  supersededBy?: string;
  /** The entry this one replaces, if any (the other half of supersession). */
  supersedes?: string;
  /** Deterministic content identity (Part B3). Unique within a scope bucket. */
  hash: string;
  /** Optional topic membership. Absence is normal: items are not forced into a topic. */
  topicId?: string;
  /** Set by upkeep when an entry is archived (moved out of the active set). */
  archivedAt?: string;
  /** True when the stored content is a redacted form, never the raw secret. */
  redacted?: boolean;
  metadata?: Record<string, unknown>;
}

/**
 * The shape a caller supplies to write. `id`, `hash`, `createdAt`/`updatedAt`
 * and normalisation are the store's job, never the caller's.
 */
export interface MemoryWriteInput {
  content: string;
  scope?: MemoryScope;
  scopeId?: string;
  source?: MemorySource;
  provenance?: MemoryProvenance;
  type?: MemoryType;
  importance?: number;
  confidence?: number;
  /** ISO-8601. Defaults to now. */
  date?: string;
  /** ISO-8601 expiry. */
  until?: string;
  /** Replaces an existing entry: that entry is marked superseded. */
  supersedes?: string;
  topicId?: string;
  metadata?: Record<string, unknown>;
}

// ── Bounds (Part B2) ──────────────────────────────────────────────────────────

export interface MemoryBounds {
  /** Maximum total content lines in the bucket (a multiline entry counts as its lines). */
  maxLines: number;
  /** Maximum total content bytes (UTF-8) in the bucket. */
  maxBytes: number;
}

/**
 * HARD per-bucket budgets. A bucket is one `(scope, scopeId)` pair — e.g. one
 * mission, one employee, one session — so a chatty mission cannot crowd out
 * global preferences and a huge mission cannot grow without limit.
 *
 * `global` is the shared bucket and therefore the largest; the private scopes
 * are tighter because they are meant to hold working context, not a second
 * permanent store.
 */
export const MEMORY_SCOPE_BOUNDS: Record<MemoryScope, MemoryBounds> = {
  global: { maxLines: 250, maxBytes: 64 * 1024 },
  session: { maxLines: 120, maxBytes: 24 * 1024 },
  mission: { maxLines: 160, maxBytes: 32 * 1024 },
  employee: { maxLines: 80, maxBytes: 16 * 1024 },
  project: { maxLines: 200, maxBytes: 40 * 1024 },
  subagent: { maxLines: 100, maxBytes: 20 * 1024 },
};

/** How many entries a freshly-extracted turn may contribute (Part B6 cap). */
export const MAX_CANDIDATES_PER_TURN = 5;

// ── Refusals (Part B2) ────────────────────────────────────────────────────────

export type MemoryRefusalReason =
  /** The write would exceed the bucket's line or byte budget. */
  | "LIMIT_EXCEEDED"
  /** A write is refused and consolidation is what would make room. */
  | "CONSOLIDATION_REQUIRED"
  /** The content carries a credential shape and must never be persisted raw. */
  | "SECRET_DETECTED"
  /** The "fact" is really an instruction aimed at the assistant. */
  | "INSTRUCTION_AS_FACT"
  /** Greeting/acknowledgement/filler — not durable. */
  | "TRANSIENT"
  /** No durable-fact signal at all. */
  | "IRRELEVANT"
  /** The fact is already past its `until`. */
  | "EXPIRED"
  /** The identical content already exists in the bucket. */
  | "DUPLICATE"
  /** Blank, malformed, or otherwise unusable. */
  | "INVALID"
  /** A caller tried to touch a scope/bucket it may not. */
  | "SCOPE_VIOLATION"
  /** A referenced record does not exist. */
  | "NOT_FOUND"
  /** A revert is not safe: the record is irreversible or the entry moved on. */
  | "REVERT_UNSAFE";

export const MEMORY_REFUSAL_CODES: Record<MemoryRefusalReason, string> = {
  LIMIT_EXCEEDED: "MEMORY_LIMIT_EXCEEDED",
  CONSOLIDATION_REQUIRED: "MEMORY_CONSOLIDATION_REQUIRED",
  SECRET_DETECTED: "MEMORY_SECRET_DETECTED",
  INSTRUCTION_AS_FACT: "MEMORY_INSTRUCTION_AS_FACT",
  TRANSIENT: "MEMORY_TRANSIENT",
  IRRELEVANT: "MEMORY_IRRELEVANT",
  EXPIRED: "MEMORY_EXPIRED",
  DUPLICATE: "MEMORY_DUPLICATE",
  INVALID: "MEMORY_INVALID",
  SCOPE_VIOLATION: "MEMORY_SCOPE_VIOLATION",
  NOT_FOUND: "MEMORY_NOT_FOUND",
  REVERT_UNSAFE: "MEMORY_REVERT_UNSAFE",
};

/** Which contract-level KaiErrorCode each refusal maps onto. */
function errorCodeFor(reason: MemoryRefusalReason): KaiErrorCode {
  switch (reason) {
    case "LIMIT_EXCEEDED":
    case "CONSOLIDATION_REQUIRED":
    case "SECRET_DETECTED":
    case "INSTRUCTION_AS_FACT":
    case "SCOPE_VIOLATION":
      return "POLICY_DENIED";
    case "NOT_FOUND":
      return "NOT_FOUND";
    default:
      return "VALIDATION_FAILED";
  }
}

export interface MemoryRefusal {
  reason: MemoryRefusalReason;
  /** Human-readable explanation. */
  detail: string;
  /** Contract-shaped error; `detail` is the stable machine code. */
  kaiError: KaiError;
  /** When present, what the caller can do to make room / resolve it. */
  consolidationHint?: string;
  /** When the refusal is a budget one, the exact limit that was hit. */
  limit?: { kind: "lines" | "bytes"; used: number; max: number };
}

/**
 * Build a refusal. `detail` is free text for a human; the machine code travels
 * in `kaiError.detail` so a caller never has to parse prose.
 */
export function memoryRefusal(
  reason: MemoryRefusalReason,
  detail: string,
  extra?: { consolidationHint?: string; limit?: MemoryRefusal["limit"] },
): MemoryRefusal {
  const code = MEMORY_REFUSAL_CODES[reason];
  const kaiError: KaiError = {
    code: errorCodeFor(reason),
    message: detail,
    retryable: false,
    at: nowIso(),
    detail: code,
  };
  const refusal: MemoryRefusal = { reason, detail, kaiError };
  if (extra?.consolidationHint !== undefined) refusal.consolidationHint = extra.consolidationHint;
  if (extra?.limit !== undefined) refusal.limit = extra.limit;
  return refusal;
}

/** A write is either an entry (possibly a dedup of an existing one) or a refusal. */
export type MemoryWriteResult =
  | { ok: true; entry: MemoryEntry; deduped: boolean; superseded?: string }
  | { ok: false; refusal: MemoryRefusal };

// ── Read-time exclusion rules ─────────────────────────────────────────────────

/** True when the entry has an `until` that is at or before `nowIsoString`. */
export function isExpired(entry: MemoryEntry, nowIsoString: string): boolean {
  if (entry.until === undefined) return false;
  const until = Date.parse(entry.until);
  const now = Date.parse(nowIsoString);
  if (!Number.isFinite(until) || !Number.isFinite(now)) return false;
  return until <= now;
}

/** True when another entry has replaced this one. */
export function isSuperseded(entry: MemoryEntry): boolean {
  return entry.supersededBy !== undefined && entry.supersededBy.length > 0;
}

/** True when the entry should be recalled: not superseded, not expired, not archived. */
export function isActive(entry: MemoryEntry, nowIsoString: string): boolean {
  return (
    !isSuperseded(entry) &&
    !isExpired(entry, nowIsoString) &&
    (entry.archivedAt === undefined || entry.archivedAt.length === 0)
  );
}

// ── Topic metadata (Part B4) ──────────────────────────────────────────────────

export interface MemoryTopic {
  id: string;
  /** Filesystem-safe name, also the topic file's basename. */
  slug: string;
  title: string;
  description: string;
  /** Alternative names that resolve to this topic during discovery/classification. */
  aliases: string[];
  createdAt: string;
  updatedAt: string;
}

// ── Journal (Part B8) ─────────────────────────────────────────────────────────

export type JournalOp =
  | "create"
  | "update"
  | "delete"
  | "supersede"
  | "expire"
  | "archive"
  | "cycle"
  | "revert";

export interface JournalRecord {
  id: string;
  /** ISO-8601. */
  at: string;
  /** Who caused it: "core", "ui", "upkeep", "capture", a caller id. */
  actor: string;
  /** The subsystem/route the change arrived through. */
  source: string;
  op: JournalOp;
  /** The entry affected, when one is. */
  entryId?: string;
  scope?: MemoryScope;
  scopeId?: string;
  /** Deterministic hashes so a change is verifiable without the raw content. */
  beforeHash?: string;
  afterHash?: string;
  /** Redacted, structured summary of the change. Never contains a raw secret. */
  change: Record<string, unknown>;
  reason: string;
  /** True only when a safe inverse exists (a snapshot is present). */
  reversible: boolean;
  /** When this record IS a revert, the record it reverses. */
  revertsId?: string;
  /** Redacted snapshot of the entry before/after, for a safe revert. */
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}

// ── Small helpers shared across the subsystem ─────────────────────────────────

export function scopeRefId(scope: MemoryScope, scopeId: string | undefined): string {
  if (scope === "global") return GLOBAL_SCOPE_ID;
  const id = typeof scopeId === "string" ? scopeId.trim() : "";
  return id;
}

/** Coerce importance into a whole number 1..5. */
export function clampImportance(value: unknown, fallback: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(5, Math.max(1, n));
}

/** Coerce confidence into 0..1. */
export function clampConfidence(value: unknown, fallback: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(1, Math.max(0, n));
}

/**
 * Tokenize free text for recall matching: lowercase, split on any run of
 * non-`[a-z0-9_]` characters, keep tokens of length >= 2, de-duplicate.
 *
 * This is the ONE definition of memory query-matching semantics. The SQLite
 * store's candidate selection and the runtime's shared-entry filter MUST agree:
 * a fact recallable through the store's own search but invisible when reached
 * through a share pointer would make a grant silently useless (and, worse, make
 * the share look broken in a way that tempts a broad "grant everything" fix).
 */
export function tokenizeMemoryText(text: string): string[] {
  const seen = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (raw.length >= 2 && !seen.has(raw)) seen.add(raw);
  }
  return [...seen];
}

export { isIsoTimestamp } from "../shared/contracts.ts";
