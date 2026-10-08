// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * KAI Core memory — engine (Phase 2 Part B1-B8).
 *
 * One value that owns memory policy and delegates every byte of persistence to
 * `MemoryEntryStore`. It is what the runtime wires; it is deliberately the ONLY
 * place that writes an entry, appends a journal row, or renders the on-disk
 * layout, so the invariants are checkable in one file:
 *
 *   write        bounds → dedup (hash) → persist → journal → publish
 *   capture      extract → validate → classify → dedup → persist  (Part B6)
 *   upkeep       capture → organize → tidy → expire → journal     (Part B7)
 *   journal      append-only, redacted, revertible                (Part B8)
 *   search       scope-isolated, expiry-aware, ranked             (Part B5)
 *
 * The legacy `MemoryService`/`Memory` contract is untouched: `toLegacy` projects
 * a canonical entry into the frozen shape, and the legacy flat rows are read
 * back via `MemoryEntryStore.importLegacy`, so nothing the desktop app already
 * does stops working.
 *
 * Wiring (the lead's job — this module never imports runtime.ts):
 *
 *   import { openMemoryStore } from "./storage/memoryStore.ts";
 *   import { createMemoryEngine } from "./memory/engine.ts";
 *
 *   const memoryStore = openMemoryStore({ path: dbPath });
 *   const memory = createMemoryEngine({ store: memoryStore, publish });
 *   memory.countLegacyRows();  // optional, one-time migration of `memories`
 *
 * Then pass `memory.search` / `memory.captureTurn` / `memory.upkeep` to the API
 * and the mission runner. `createMemoryService({ store: stores.memory })` keeps
 * working unchanged for the existing routes.
 */

import { nowIso } from "../shared/contracts.ts";
import type { Memory, MemorySource } from "../shared/contracts.ts";
import { redactSecrets } from "../redact/index.ts";
import type { Publish } from "../runtime.ts";
import {
  clampConfidence,
  clampImportance,
  GLOBAL_SCOPE_ID,
  MAX_CANDIDATES_PER_TURN,
  MEMORY_SCOPE_BOUNDS,
  memoryRefusal,
  scopeRefId,
  type JournalRecord,
  type MemoryEntry,
  type MemoryProvenance,
  type MemoryRefusal,
  type MemoryScope,
  type MemoryTopic,
  type MemoryType,
  type MemoryWriteInput,
  type MemoryWriteResult,
} from "./model.ts";
import { computeHash, createIdFactory } from "./entry.ts";
import {
  checkWriteBounds,
  consolidationPlan,
  formatBytes,
  measureEntries,
  measureEntry,
  usageSummary,
  type BucketUsage,
} from "./bounds.ts";
import { newJournalId, planRevert, snapshotEntry } from "./journal.ts";
import {
  archiveEntries,
  appendJournalLog,
  discoverTopics,
  ensureLayout,
  memoryLayout,
  slugify,
  writeIndex,
  writeTopicFile,
  type DiscoveredTopic,
  type MemoryLayout,
} from "./topics.ts";
import {
  classifyCandidate,
  extractCandidates,
  resolveTopic,
  validateCandidate,
  type CandidateRejection,
  type ClassifiedCandidate,
  type CompletedTurn,
  type MemoryCandidate,
} from "./capture.ts";
import { createMemoryUpkeep, UpkeepPausedError, type MemoryUpkeep } from "./upkeep.ts";
import type { MemoryEntryStore, MemoryScopeAccess, MemorySearchHit } from "./store.ts";

// ── Public shapes ─────────────────────────────────────────────────────────────

export interface CaptureResult {
  accepted: MemoryEntry[];
  rejected: CandidateRejection[];
  /** How many candidates were considered (after the per-turn cap). */
  considered: number;
  /** How many were dropped by the per-turn cap before validation. */
  dropped: number;
}

export interface EngineSearchOptions {
  text?: string;
  /** Defaults to `[{ scope: "global" }]`. Private scopes must name their ids. */
  scopes?: readonly MemoryScopeAccess[];
  limit?: number;
  now?: string;
  includeExpired?: boolean;
  includeSuperseded?: boolean;
  includeArchived?: boolean;
  types?: readonly MemoryType[];
}

export interface DigestOptions {
  scopes?: readonly MemoryScopeAccess[];
  limit?: number;
  types?: readonly MemoryType[];
  now?: string;
}

export interface ConsolidateResult {
  purged: number;
  reclaimedLines: number;
  reclaimedBytes: number;
  hint: string;
}

/** Fields an edit may change. Identity (id/scope/scopeId) is never editable. */
export interface MemoryUpdatePatch {
  content?: string;
  type?: MemoryType;
  importance?: number;
  confidence?: number;
  /** `null` clears the expiry; a string sets it. */
  until?: string | null;
  /** `null` clears the topic; a string must name an existing topic. */
  topicId?: string | null;
}

export interface MemoryEngine {
  readonly store: MemoryEntryStore;

  /** Write one fact. Bounds are hard; a refusal is a value, never a throw. */
  write(input: MemoryWriteInput & { actor?: string; reason?: string }): MemoryWriteResult;
  /** Edit an existing entry (content/fields). Re-indexes and journals the change. */
  update(id: string, patch: MemoryUpdatePatch, opts?: { actor?: string; reason?: string }): MemoryWriteResult;
  get(id: string): MemoryEntry | null;
  /** Scoped, expiry-aware, ranked search (Part B5). */
  search(opts?: EngineSearchOptions): MemorySearchHit[];
  /** Important-first listing of the (default global) active memory. */
  digest(opts?: DigestOptions): MemoryEntry[];
  forget(id: string, opts?: { actor?: string; reason?: string }): MemoryWriteResult;
  /** Mark `oldId` as replaced by `newId`; `oldId` stops being recalled. */
  supersede(oldId: string, newId: string, opts?: { actor?: string; reason?: string }): MemoryWriteResult;
  /** Reverse one journal record, safely (Part B8). */
  revert(journalId: string, opts?: { actor?: string }): MemoryWriteResult;
  journal(opts?: { limit?: number; entryId?: string }): JournalRecord[];

  // topics / layout (Part B4)
  defineTopic(input: { title: string; description: string; aliases?: string[]; slug?: string }): MemoryTopic;
  listTopics(limit?: number): MemoryTopic[];
  assignTopic(entryId: string, topicId: string | null, opts?: { actor?: string }): MemoryWriteResult;
  discoverTopics(): DiscoveredTopic[];
  renderLayout(): { indexPath: string; topics: number; entries: number };
  layout(): MemoryLayout;

  // capture (Part B6)
  captureTurn(turn: CompletedTurn, opts?: { max?: number; modelCandidates?: (string | MemoryCandidate)[] }): CaptureResult;
  /** Queue a completed turn for the upkeep cycle's capture phase. */
  queueTurn(turn: CompletedTurn): void;

  // upkeep (Part B7)
  readonly upkeep: MemoryUpkeep;

  // maintenance + introspection
  usage(scope: MemoryScope, scopeId: string): BucketUsage & { summary: string };
  consolidate(scope: MemoryScope, scopeId: string, opts?: { actor?: string }): ConsolidateResult;
  countLegacyRows(): number;
  /** Project a canonical entry onto the frozen `Memory` contract. */
  toLegacy(entry: MemoryEntry): Memory;
  ftsAvailable(): boolean;
}

export interface MemoryEngineOptions {
  store: MemoryEntryStore;
  publish?: Publish;
  now?: () => Date;
  idFactory?: () => string;
  /** Scope a write/capture without an explicit scope lands in. Default "global". */
  defaultScope?: MemoryScope;
  /** Layout root override. Defaults to a `memory/` dir beside the database. */
  layoutRoot?: string;
  /** Write the human-readable layout after each mutation. Default false. */
  syncLayout?: boolean;
  /** Actor recorded in the journal for engine-initiated writes. Default "core". */
  actor?: string;
  /** Per-turn capture cap. Default `MAX_CANDIDATES_PER_TURN`. */
  maxCandidatesPerTurn?: number;
  /** Copy existing legacy `memories` rows into the canonical store on create. */
  importLegacyOnCreate?: boolean;
}

const PENDING_TURNS_KEY = "upkeep.pendingTurns";
const MAX_PENDING_TURNS = 50;

// ── Engine ────────────────────────────────────────────────────────────────────

export function createMemoryEngine(opts: MemoryEngineOptions): MemoryEngine {
  const store = opts.store;
  const publish = opts.publish;
  const now = opts.now ?? (() => new Date());
  const defaultScope = opts.defaultScope ?? "global";
  const defaultActor = opts.actor ?? "core";
  const maxCandidates = opts.maxCandidatesPerTurn ?? MAX_CANDIDATES_PER_TURN;
  const idFactory = opts.idFactory ?? createIdFactory(now);

  const storePath = store.path ?? null;
  const root =
    opts.layoutRoot ??
    (storePath !== null && storePath !== ":memory:"
      ? memoryLayout(storePath).root.replace(/[^\\/]+$/, "memory")
      : // No filesystem path (an in-memory store): keep the layout off disk unless
        // a caller names a root, so a test cannot accidentally write into the repo.
        "");
  const layoutRoot = root.length > 0 ? root : null;

  function layout(): MemoryLayout {
    if (layoutRoot === null) {
      throw new Error("memory layout is unavailable: the store has no filesystem path and no layoutRoot was given");
    }
    return memoryLayout(layoutRoot);
  }

  // ── journal helper (Part B8) ───────────────────────────────────────────────
  function writeJournal(partial: {
    op: JournalRecord["op"];
    actor?: string;
    source?: string;
    entryId?: string;
    scope?: MemoryScope;
    scopeId?: string;
    beforeHash?: string;
    afterHash?: string;
    change: Record<string, unknown>;
    reason: string;
    reversible: boolean;
    revertsId?: string;
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
  }): JournalRecord {
    const record: JournalRecord = {
      id: newJournalId(now),
      at: now().toISOString(),
      actor: partial.actor ?? defaultActor,
      source: partial.source ?? "memory",
      op: partial.op,
      // The change object is redacted here, once, so no caller can slip a secret
      // into the journal by putting it in a `change` field.
      change: redactSecrets(partial.change) as Record<string, unknown>,
      reason: partial.reason,
      reversible: partial.reversible,
    };
    if (partial.entryId !== undefined) record.entryId = partial.entryId;
    if (partial.scope !== undefined) record.scope = partial.scope;
    if (partial.scopeId !== undefined) record.scopeId = partial.scopeId;
    if (partial.beforeHash !== undefined) record.beforeHash = partial.beforeHash;
    if (partial.afterHash !== undefined) record.afterHash = partial.afterHash;
    if (partial.revertsId !== undefined) record.revertsId = partial.revertsId;
    if (partial.before !== undefined) record.before = partial.before;
    if (partial.after !== undefined) record.after = partial.after;
    store.appendJournal(record);
    if (layoutRoot !== null) {
      try {
        appendJournalLog(layout(), record);
      } catch {
        // The on-disk log is a projection; failing to write it must not fail the
        // durable change it describes.
      }
    }
    return record;
  }

  // ── persistence core ───────────────────────────────────────────────────────
  function persist(input: {
    content: string;
    scope: MemoryScope;
    scopeId: string;
    source: MemorySource;
    provenance: MemoryProvenance;
    type: MemoryType;
    importance: number;
    confidence: number;
    date?: string;
    until?: string;
    topicId?: string;
    metadata?: Record<string, unknown>;
    supersedes?: string;
    actor?: string;
    sourceLabel?: string;
    reason?: string;
  }): MemoryWriteResult {
    const at = now().toISOString();

    // HARD bounds: computed from the bucket's current usage BEFORE writing.
    const usage = store.bucketUsage(input.scope, input.scopeId);
    const refusal = checkWriteBounds(input.scope, usage, input.content);
    if (refusal !== null) {
      // Enrich the hint with what consolidation would actually reclaim.
      const plan = consolidationPlan(
        store.listBucket(input.scope, input.scopeId, { includeExpired: true, includeSuperseded: true, includeArchived: true }),
        at,
      );
      return { ok: false, refusal: { ...refusal, consolidationHint: `${refusal.consolidationHint ?? ""} ${plan.hint}`.trim() } };
    }

    const hash = computeHash(input.scope, input.scopeId, input.content);
    const entry: MemoryEntry = {
      id: idFactory(),
      scope: input.scope,
      scopeId: input.scopeId,
      content: input.content,
      source: input.source,
      provenance: input.provenance,
      type: input.type,
      importance: clampImportance(input.importance, 3),
      confidence: clampConfidence(input.confidence, 1),
      createdAt: at,
      updatedAt: at,
      date: input.date ?? at,
      hash,
    };
    if (input.until !== undefined) entry.until = input.until;
    if (input.topicId !== undefined) entry.topicId = input.topicId;
    // Metadata is a durable write too: redact it, never store a raw secret.
    if (input.metadata !== undefined) entry.metadata = redactSecrets(input.metadata) as Record<string, unknown>;

    store.insert(entry);
    writeJournal({
      op: "create",
      actor: input.actor,
      source: input.sourceLabel,
      entryId: entry.id,
      scope: entry.scope,
      scopeId: entry.scopeId,
      afterHash: entry.hash,
      change: { content: entry.content, type: entry.type, scope: entry.scope, scopeId: entry.scopeId },
      reason: input.reason ?? "memory write",
      reversible: true,
      after: snapshotEntry(entry),
    });

    let superseded: string | undefined;
    if (input.supersedes !== undefined && input.supersedes !== entry.id) {
      const old = store.get(input.supersedes);
      if (old !== null) {
        const before = snapshotEntry(old);
        old.supersededBy = entry.id;
        old.updatedAt = at;
        store.update(old);
        entry.supersedes = old.id;
        store.update(entry);
        superseded = old.id;
        writeJournal({
          op: "supersede",
          actor: input.actor,
          source: input.sourceLabel,
          entryId: old.id,
          scope: old.scope,
          scopeId: old.scopeId,
          beforeHash: old.hash,
          afterHash: old.hash,
          change: { supersededBy: entry.id },
          reason: `superseded by ${entry.id}`,
          reversible: true,
          before,
          after: snapshotEntry(old),
        });
      }
    }

    publish?.("memory.created", entry, { source: input.sourceLabel ?? "core" });
    if (opts.syncLayout === true && layoutRoot !== null) syncLayoutFiles();
    const result: MemoryWriteResult = { ok: true, entry, deduped: false };
    if (superseded !== undefined) result.superseded = superseded;
    return result;
  }

  function syncLayoutFiles(): void {
    try {
      renderLayout();
    } catch {
      // A projection failure must not fail the durable write.
    }
  }

  // ── write ──────────────────────────────────────────────────────────────────
  function write(input: MemoryWriteInput & { actor?: string; reason?: string }): MemoryWriteResult {
    // Content keeps its newlines: the line budget (Part B2) counts them, and the
    // grammar escapes them so one entry still renders as one line on disk.
    const content = typeof input.content === "string" ? input.content.trim() : "";
    if (content.length === 0) {
      return { ok: false, refusal: memoryRefusal("INVALID", "memory content must not be blank") };
    }

    // Secrets never reach the store. A write containing a credential is refused
    // rather than stored in a redacted (and therefore useless) form.
    if (redactSecrets(content) !== content) {
      return {
        ok: false,
        refusal: memoryRefusal("SECRET_DETECTED", "memory content contains a credential shape; it was not stored", {
          consolidationHint: "Keep secrets in the credential store, never in memory.",
        }),
      };
    }

    const scope = input.scope ?? defaultScope;
    const scopeId = scopeRefId(scope, input.scopeId);
    if (scope !== "global" && scopeId.length === 0) {
      return { ok: false, refusal: memoryRefusal("SCOPE_VIOLATION", `the private "${scope}" scope needs a scopeId`) };
    }

    // Deterministic dedup: identical content in the same bucket collapses.
    const hash = computeHash(scope, scopeId, content);
    if (input.supersedes === undefined) {
      const existing = store.findByHash(scope, scopeId, hash);
      if (existing !== null) return { ok: true, entry: existing, deduped: true };
    }

    return persist({
      content,
      scope,
      scopeId,
      // An OMITTED provenance is the MOST RESTRICTIVE value, never user
      // authority. A caller that does not say where a fact came from has not
      // attested that the user said it, and defaulting to `user_statement` let
      // any external writer manufacture user authority by simply leaving the
      // field out. This matches the learning pipeline's discipline (an omitted
      // source there defaults to `external`, never `user`). `system_state` is the
      // coarse source every non-user provenance already collapses to
      // (`toMemorySource`), so the two fields agree.
      source: input.source ?? "system_state",
      provenance: input.provenance ?? "system_state",
      type: input.type ?? "note",
      importance: input.importance ?? 3,
      confidence: input.confidence ?? 1,
      ...(input.date !== undefined ? { date: input.date } : {}),
      ...(input.until !== undefined ? { until: input.until } : {}),
      ...(input.topicId !== undefined ? { topicId: input.topicId } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      ...(input.supersedes !== undefined ? { supersedes: input.supersedes } : {}),
      ...(input.actor !== undefined ? { actor: input.actor } : {}),
      reason: input.reason ?? "memory write",
    });
  }

  // ── edit ───────────────────────────────────────────────────────────────────
  function update(
    id: string,
    patch: MemoryUpdatePatch,
    updateOpts: { actor?: string; reason?: string } = {},
  ): MemoryWriteResult {
    const entry = store.get(id);
    if (entry === null) return { ok: false, refusal: memoryRefusal("NOT_FOUND", `no memory entry with id "${id}"`) };
    const at = now().toISOString();
    const before = snapshotEntry(entry);
    const next: MemoryEntry = { ...entry, updatedAt: at };

    if (patch.content !== undefined) {
      const content = patch.content.trim();
      if (content.length === 0) {
        return { ok: false, refusal: memoryRefusal("INVALID", "memory content must not be blank") };
      }
      if (redactSecrets(content) !== content) {
        return { ok: false, refusal: memoryRefusal("SECRET_DETECTED", "edited content contains a credential shape") };
      }
      const hash = computeHash(next.scope, next.scopeId, content);
      const other = store.findByHash(next.scope, next.scopeId, hash);
      if (other !== null && other.id !== id) {
        return { ok: false, refusal: memoryRefusal("DUPLICATE", "the edited content already exists in this bucket"), };
      }
      // A budget still applies to an edit: project the bucket usage with the old
      // content removed and the new one added.
      const usage = store.bucketUsage(next.scope, next.scopeId);
      const oldM = measureEntry(entry.content);
      const newM = measureEntry(content);
      const bounds = MEMORY_SCOPE_BOUNDS[next.scope];
      const projectedLines = usage.lines - oldM.lines + newM.lines;
      const projectedBytes = usage.bytes - oldM.bytes + newM.bytes;
      if (projectedLines > bounds.maxLines) {
        return {
          ok: false,
          refusal: memoryRefusal("LIMIT_EXCEEDED", `edit would put ${next.scope} memory at ${projectedLines}/${bounds.maxLines} lines`, {
            limit: { kind: "lines", used: projectedLines, max: bounds.maxLines },
          }),
        };
      }
      if (projectedBytes > bounds.maxBytes) {
        return {
          ok: false,
          refusal: memoryRefusal("LIMIT_EXCEEDED", `edit would put ${next.scope} memory at ${formatBytes(projectedBytes)}/${formatBytes(bounds.maxBytes)}`, {
            limit: { kind: "bytes", used: projectedBytes, max: bounds.maxBytes },
          }),
        };
      }
      next.content = content;
      next.hash = hash;
    }

    if (patch.type !== undefined) next.type = patch.type;
    if (patch.importance !== undefined) next.importance = clampImportance(patch.importance, next.importance);
    if (patch.confidence !== undefined) next.confidence = clampConfidence(patch.confidence, next.confidence);
    if (patch.until !== undefined) {
      if (patch.until === null) delete next.until;
      else next.until = patch.until;
    }
    if (patch.topicId !== undefined) {
      if (patch.topicId === null) delete next.topicId;
      else {
        if (store.getTopic(patch.topicId) === null) {
          return { ok: false, refusal: memoryRefusal("NOT_FOUND", `no topic with id "${patch.topicId}"`) };
        }
        next.topicId = patch.topicId;
      }
    }

    store.update(next);
    writeJournal({
      op: "update",
      actor: updateOpts.actor,
      entryId: next.id,
      scope: next.scope,
      scopeId: next.scopeId,
      beforeHash: entry.hash,
      afterHash: next.hash,
      change: { content: next.content, type: next.type, importance: next.importance },
      reason: updateOpts.reason ?? "memory edit",
      reversible: true,
      before,
      after: snapshotEntry(next),
    });
    if (opts.syncLayout === true) syncLayoutFiles();
    return { ok: true, entry: next, deduped: false };
  }

  // ── reads (Part B5) ────────────────────────────────────────────────────────
  function search(searchOpts: EngineSearchOptions = {}): MemorySearchHit[] {
    const scopes: readonly MemoryScopeAccess[] = searchOpts.scopes ?? [{ scope: "global" }];
    return store.search({
      scopes,
      now: searchOpts.now ?? nowIso(),
      ...(searchOpts.text !== undefined ? { text: searchOpts.text } : {}),
      ...(searchOpts.limit !== undefined ? { limit: searchOpts.limit } : {}),
      ...(searchOpts.includeExpired !== undefined ? { includeExpired: searchOpts.includeExpired } : {}),
      ...(searchOpts.includeSuperseded !== undefined ? { includeSuperseded: searchOpts.includeSuperseded } : {}),
      ...(searchOpts.includeArchived !== undefined ? { includeArchived: searchOpts.includeArchived } : {}),
      ...(searchOpts.types !== undefined ? { types: searchOpts.types } : {}),
    });
  }

  function digest(digestOpts: DigestOptions = {}): MemoryEntry[] {
    const scopes: readonly MemoryScopeAccess[] = digestOpts.scopes ?? [{ scope: "global" }];
    const hits = search({
      scopes,
      now: digestOpts.now ?? nowIso(),
      ...(digestOpts.types !== undefined ? { types: digestOpts.types } : {}),
    });
    const rows = hits.map((hit) => hit.entry);
    rows.sort((a, b) => {
      if (b.importance !== a.importance) return b.importance - a.importance;
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    return digestOpts.limit === undefined ? rows : rows.slice(0, Math.max(0, digestOpts.limit));
  }

  // ── mutations ──────────────────────────────────────────────────────────────
  function forget(id: string, forgetOpts: { actor?: string; reason?: string } = {}): MemoryWriteResult {
    const entry = store.get(id);
    if (entry === null) {
      return { ok: false, refusal: memoryRefusal("NOT_FOUND", `no memory entry with id "${id}"`) };
    }
    const before = snapshotEntry(entry);
    store.remove(id);
    writeJournal({
      op: "delete",
      actor: forgetOpts.actor,
      entryId: entry.id,
      scope: entry.scope,
      scopeId: entry.scopeId,
      beforeHash: entry.hash,
      change: { content: entry.content },
      reason: forgetOpts.reason ?? "memory forget",
      reversible: true,
      before,
    });
    publish?.("memory.deleted", { id }, { source: "core" });
    if (opts.syncLayout === true) syncLayoutFiles();
    return { ok: true, entry, deduped: false };
  }

  function supersede(oldId: string, newId: string, supOpts: { actor?: string; reason?: string } = {}): MemoryWriteResult {
    const old = store.get(oldId);
    if (old === null) return { ok: false, refusal: memoryRefusal("NOT_FOUND", `no memory entry with id "${oldId}"`) };
    const replacement = store.get(newId);
    if (replacement === null) return { ok: false, refusal: memoryRefusal("NOT_FOUND", `no memory entry with id "${newId}"`) };
    const before = snapshotEntry(old);
    old.supersededBy = newId;
    old.updatedAt = now().toISOString();
    store.update(old);
    writeJournal({
      op: "supersede",
      actor: supOpts.actor,
      entryId: old.id,
      scope: old.scope,
      scopeId: old.scopeId,
      beforeHash: old.hash,
      afterHash: old.hash,
      change: { supersededBy: newId },
      reason: supOpts.reason ?? `superseded by ${newId}`,
      reversible: true,
      before,
      after: snapshotEntry(old),
    });
    return { ok: true, entry: old, deduped: false };
  }

  function revert(journalId: string, revertOpts: { actor?: string } = {}): MemoryWriteResult {
    const record = store.getJournal(journalId);
    if (record === null) {
      return { ok: false, refusal: memoryRefusal("NOT_FOUND", `no journal record with id "${journalId}"`) };
    }
    const current = record.entryId !== undefined ? store.get(record.entryId) : null;
    const planned = planRevert(record, current);
    if (!planned.ok) return { ok: false, refusal: planned.refusal };

    const at = now().toISOString();
    let affected: MemoryEntry;

    if (planned.plan.kind === "remove") {
      const existing = store.get(planned.plan.entryId);
      if (existing === null) {
        return { ok: false, refusal: memoryRefusal("NOT_FOUND", `entry ${planned.plan.entryId} no longer exists`) };
      }
      affected = existing;
      store.remove(existing.id);
      writeJournal({
        op: "revert",
        actor: revertOpts.actor,
        entryId: existing.id,
        scope: existing.scope,
        scopeId: existing.scopeId,
        beforeHash: existing.hash,
        change: { reversed: planned.plan.description, revertedRecord: record.id },
        reason: `revert of ${record.id}`,
        reversible: false,
        revertsId: record.id,
        before: snapshotEntry(existing),
      });
      publish?.("memory.deleted", { id: existing.id }, { source: "core" });
    } else {
      // Restore the recorded snapshot. Its hash is recomputed from the restored
      // content so the identity index stays consistent.
      const restored = planned.plan.entry;
      const content = restored.content;
      const hash = computeHash(restored.scope, restored.scopeId, content);
      const before = current === null ? undefined : snapshotEntry(current);
      const next: MemoryEntry = {
        ...restored,
        content,
        hash,
        updatedAt: at,
      };
      delete next.supersededBy;
      const exists = store.get(next.id) !== null;
      // Bounds still apply to a restore: a revert must not be a way to bypass
      // the hard budget.
      const usage = store.bucketUsage(next.scope, next.scopeId);
      const refusal = checkWriteBounds(next.scope, usage, content);
      if (!exists && refusal !== null) return { ok: false, refusal };
      if (exists) store.update(next);
      else store.insert(next);
      affected = next;
      writeJournal({
        op: "revert",
        actor: revertOpts.actor,
        entryId: next.id,
        scope: next.scope,
        scopeId: next.scopeId,
        ...(before === undefined ? {} : { beforeHash: toStrHash(before) }),
        afterHash: next.hash,
        change: { reversed: planned.plan.description, revertedRecord: record.id },
        reason: `revert of ${record.id}`,
        reversible: false,
        revertsId: record.id,
        ...(before === undefined ? {} : { before }),
        after: snapshotEntry(next),
      });
      publish?.("memory.created", next, { source: "core" });
    }

    if (opts.syncLayout === true) syncLayoutFiles();
    return { ok: true, entry: affected, deduped: false };
  }

  // ── topics / layout (Part B4) ──────────────────────────────────────────────
  function defineTopic(input: { title: string; description: string; aliases?: string[]; slug?: string }): MemoryTopic {
    const title = input.title.trim();
    const description = input.description.trim();
    if (title.length === 0 || description.length === 0) {
      throw new Error("a topic needs a non-empty title and description");
    }
    const slug = (input.slug ?? slugify(title)).trim();
    const existing = store.getTopicBySlug(slug);
    const at = now().toISOString();
    const topic: MemoryTopic = {
      id: existing?.id ?? `topic_${slug}`,
      slug,
      title,
      description,
      aliases: (input.aliases ?? []).map((a) => a.trim()).filter((a) => a.length > 0),
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
    };
    store.upsertTopic(topic);
    return topic;
  }

  function assignTopic(entryId: string, topicId: string | null, assignOpts: { actor?: string } = {}): MemoryWriteResult {
    const entry = store.get(entryId);
    if (entry === null) return { ok: false, refusal: memoryRefusal("NOT_FOUND", `no memory entry with id "${entryId}"`) };
    if (topicId !== null && store.getTopic(topicId) === null) {
      return { ok: false, refusal: memoryRefusal("NOT_FOUND", `no topic with id "${topicId}"`) };
    }
    const before = snapshotEntry(entry);
    if (topicId === null) delete entry.topicId;
    else entry.topicId = topicId;
    entry.updatedAt = now().toISOString();
    store.update(entry);
    writeJournal({
      op: "update",
      actor: assignOpts.actor,
      entryId: entry.id,
      scope: entry.scope,
      scopeId: entry.scopeId,
      beforeHash: entry.hash,
      afterHash: entry.hash,
      change: { topicId },
      reason: "topic assignment",
      reversible: true,
      before,
      after: snapshotEntry(entry),
    });
    if (opts.syncLayout === true) syncLayoutFiles();
    return { ok: true, entry, deduped: false };
  }

  function discoverTopicsFromDisk(): DiscoveredTopic[] {
    if (layoutRoot === null) return [];
    return discoverTopics(layout(), { limit: 100 });
  }

  function renderLayout(): { indexPath: string; topics: number; entries: number } {
    const l = layout();
    ensureLayout(l);
    const topics = store.listTopics(500);
    const entries = store.listAll({ now: nowIso(), limit: 5000 });
    for (const topic of topics) {
      const owned = entries.filter((entry) => entry.topicId === topic.id);
      writeTopicFile(l, topic, owned);
    }
    const indexPath = writeIndex(l, topics, entries, nowIso());
    return { indexPath, topics: topics.length, entries: entries.length };
  }

  // ── capture (Part B6) ──────────────────────────────────────────────────────
  function normalizeModelCandidates(raw: (string | MemoryCandidate)[]): MemoryCandidate[] {
    const out: MemoryCandidate[] = [];
    for (const item of raw) {
      if (typeof item === "string") {
        const content = item.trim();
        if (content.length > 0) out.push({ content, provenance: "model_candidate", confidence: 0.5 });
        continue;
      }
      if (item !== null && typeof item === "object" && typeof item.content === "string") {
        out.push({ ...item, content: item.content.trim(), provenance: item.provenance ?? "model_candidate" });
      }
    }
    return out;
  }

  function captureTurn(
    turn: CompletedTurn,
    captureOpts: { max?: number; modelCandidates?: (string | MemoryCandidate)[] } = {},
  ): CaptureResult {
    const at = turn.at ?? nowIso();
    const max = captureOpts.max ?? maxCandidates;

    const extracted = extractCandidates(turn, { limit: max });
    const modelled = normalizeModelCandidates(captureOpts.modelCandidates ?? []);
    const all = [...extracted, ...modelled];
    const candidates = all.slice(0, max);
    const dropped = all.length - candidates.length;

    const topics = store.listTopics(200);
    const accepted: MemoryEntry[] = [];
    const rejected: CandidateRejection[] = [];

    for (const candidate of candidates) {
      const invalid = validateCandidate(candidate, { now: at });
      if (invalid !== null) {
        rejected.push({ candidate, refusal: invalid });
        continue;
      }

      const classified = classifyCandidate(candidate, { turn, defaultScope, topics });
      if ("kaiError" in classified) {
        rejected.push({ candidate, refusal: classified });
        continue;
      }

      // Deterministic dedup: the same fact already in the bucket is refused,
      // not written twice.
      const hash = computeHash(classified.scope, classified.scopeId, candidate.content);
      const existing = store.findByHash(classified.scope, classified.scopeId, hash);
      if (existing !== null) {
        rejected.push({
          candidate,
          refusal: memoryRefusal("DUPLICATE", `the identical fact already exists in ${classified.scope}:${classified.scopeId}`),
          existing,
        });
        continue;
      }

      const written = persist({
        content: candidate.content,
        scope: classified.scope,
        scopeId: classified.scopeId,
        source: toSource(classified.provenance),
        provenance: classified.provenance,
        type: classified.type,
        importance: classified.importance,
        confidence: classified.confidence,
        date: classified.date,
        ...(classified.until !== undefined ? { until: classified.until } : {}),
        ...(classified.topicId !== undefined ? { topicId: classified.topicId } : {}),
        reason: "automatic capture",
        sourceLabel: "capture",
      });
      if (written.ok) accepted.push(written.entry);
      else rejected.push({ candidate, refusal: written.refusal });
    }

    return { accepted, rejected, considered: candidates.length, dropped };
  }

  function queueTurn(turn: CompletedTurn): void {
    const raw = store.getState(PENDING_TURNS_KEY);
    let queue: CompletedTurn[] = [];
    if (raw !== null && raw.length > 0) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) queue = parsed as CompletedTurn[];
      } catch {
        queue = [];
      }
    }
    queue.push(turn);
    if (queue.length > MAX_PENDING_TURNS) queue = queue.slice(queue.length - MAX_PENDING_TURNS);
    store.setState(PENDING_TURNS_KEY, JSON.stringify(queue));
  }

  // ── upkeep phases (Part B7) ────────────────────────────────────────────────
  const upkeep = createMemoryUpkeep({
    store,
    now,
    ...(publish !== undefined ? { publish } : {}),
    phases: [
      {
        name: "capture",
        async run(guard) {
          const raw = store.getState(PENDING_TURNS_KEY);
          if (raw === null || raw.length === 0) return 0;
          let queue: CompletedTurn[] = [];
          try {
            const parsed = JSON.parse(raw) as unknown;
            if (Array.isArray(parsed)) queue = parsed as CompletedTurn[];
          } catch {
            store.setState(PENDING_TURNS_KEY, "[]");
            return 0;
          }
          let changed = 0;
          for (const turn of queue) {
            if (!guard()) throw new UpkeepPausedError("capture");
            const result = captureTurn(turn);
            changed += result.accepted.length;
          }
          store.setState(PENDING_TURNS_KEY, "[]");
          return changed;
        },
      },
      {
        name: "organize",
        async run(guard) {
          const topics = store.listTopics(200);
          if (topics.length === 0) return 0;
          const entries = store.listAll({ now: nowIso(), includeSuperseded: false, includeArchived: false });
          let changed = 0;
          for (const entry of entries) {
            if (entry.topicId !== undefined) continue;
            const topicId = resolveTopic(undefined, entry.content, topics);
            if (topicId === undefined) continue;
            if (!guard()) throw new UpkeepPausedError("organize");
            store.update({ ...entry, topicId, updatedAt: nowIso() });
            changed += 1;
          }
          return changed;
        },
      },
      {
        name: "tidy",
        async run(guard) {
          const topicIds = new Set(store.listTopics(500).map((t) => t.id));
          const entries = store.listAll({ now: nowIso(), includeSuperseded: true, includeArchived: true });
          let changed = 0;
          for (const entry of entries) {
            // A topic that no longer exists must not keep an entry pointing at it.
            if (entry.topicId !== undefined && !topicIds.has(entry.topicId)) {
              if (!guard()) throw new UpkeepPausedError("tidy");
              const next = { ...entry, updatedAt: nowIso() };
              delete next.topicId;
              store.update(next);
              changed += 1;
            }
          }
          return changed;
        },
      },
      {
        name: "expire",
        async run(guard) {
          const at = nowIso();
          const atMs = Date.parse(at);
          const entries = store.listAll({ now: at, includeExpired: true, includeSuperseded: true, includeArchived: false });
          const toArchive: MemoryEntry[] = [];
          let changed = 0;
          for (const entry of entries) {
            if (entry.until === undefined) continue;
            if (!(Date.parse(entry.until) <= atMs)) continue;
            if (!guard()) throw new UpkeepPausedError("expire");
            const next: MemoryEntry = { ...entry, archivedAt: at, updatedAt: at };
            store.update(next);
            writeJournal({
              op: "expire",
              entryId: entry.id,
              scope: entry.scope,
              scopeId: entry.scopeId,
              beforeHash: entry.hash,
              afterHash: entry.hash,
              change: { until: entry.until, archivedAt: at },
              reason: "expired",
              reversible: true,
              before: snapshotEntry(entry),
              after: snapshotEntry(next),
            });
            toArchive.push(next);
            changed += 1;
          }
          if (toArchive.length > 0 && layoutRoot !== null) {
            if (!guard()) throw new UpkeepPausedError("expire");
            try {
              archiveEntries(layout(), toArchive, at);
            } catch {
              // archive export is a projection
            }
          }
          return changed;
        },
      },
      {
        name: "journal",
        async run(guard) {
          if (!guard()) throw new UpkeepPausedError("journal");
          writeJournal({
            op: "cycle",
            change: { cycle: true },
            reason: "upkeep cycle",
            reversible: false,
            source: "upkeep",
          });
          return 1;
        },
      },
    ],
  });

  // ── maintenance ────────────────────────────────────────────────────────────
  function usage(scope: MemoryScope, scopeId: string): BucketUsage & { summary: string } {
    const used = store.bucketUsage(scope, scopeId);
    return { ...used, summary: usageSummary(scope, used) };
  }

  function consolidate(scope: MemoryScope, scopeId: string, consolidateOpts: { actor?: string } = {}): ConsolidateResult {
    const at = nowIso();
    const all = store.listBucket(scope, scopeId, { includeExpired: true, includeSuperseded: true, includeArchived: true });
    const plan = consolidationPlan(all, at);
    let purged = 0;
    for (const entry of plan.purge) {
      const before = snapshotEntry(entry);
      store.remove(entry.id);
      writeJournal({
        op: "delete",
        actor: consolidateOpts.actor,
        entryId: entry.id,
        scope: entry.scope,
        scopeId: entry.scopeId,
        beforeHash: entry.hash,
        change: { consolidation: true, content: entry.content },
        reason: "consolidation: unreachable entry reclaimed",
        reversible: true,
        before,
      });
      purged += 1;
    }
    if (purged > 0) {
      const after = store.bucketUsage(scope, scopeId);
      return {
        purged,
        reclaimedLines: Math.max(0, plan.reclaimableLines),
        reclaimedBytes: Math.max(0, plan.reclaimableBytes),
        hint: `Now ${usageSummary(scope, after)}`,
      };
    }
    return { purged: 0, reclaimedLines: 0, reclaimedBytes: 0, hint: plan.hint };
  }

  function countLegacyRows(): number {
    return store.importLegacy([]);
  }

  function toLegacy(entry: MemoryEntry): Memory {
    const legacy: Memory = {
      id: entry.id,
      type: entry.type,
      content: entry.content,
      source: entry.source,
      importance: entry.importance,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      metadata: {
        ...(entry.metadata ?? {}),
        // Carry the canonical identity so a legacy reader can find the V2 row.
        kai: {
          scope: entry.scope,
          scopeId: entry.scopeId,
          provenance: entry.provenance,
          confidence: entry.confidence,
          hash: entry.hash,
          ...(entry.until !== undefined ? { until: entry.until } : {}),
          ...(entry.supersededBy !== undefined ? { supersededBy: entry.supersededBy } : {}),
        },
      },
    };
    return legacy;
  }

  // ── assemble ───────────────────────────────────────────────────────────────
  let imported = 0;
  if (opts.importLegacyOnCreate === true) {
    try {
      imported = store.importLegacy([]);
    } catch {
      imported = 0;
    }
  }
  void imported;

  return {
    store,
    write,
    update,
    get: (id) => store.get(id),
    search,
    digest,
    forget,
    supersede,
    revert,
    journal: (journalOpts) => store.listJournal(journalOpts),
    defineTopic,
    listTopics: (limit) => store.listTopics(limit),
    assignTopic,
    discoverTopics: discoverTopicsFromDisk,
    renderLayout,
    layout,
    captureTurn,
    queueTurn,
    upkeep,
    usage,
    consolidate,
    countLegacyRows,
    toLegacy,
    ftsAvailable: () => store.ftsAvailable(),
  };
}

// ── helpers ─────────────────────────────────────────────────────────────────

function toStrHash(snapshot: Record<string, unknown>): string | undefined {
  return typeof snapshot.hash === "string" ? snapshot.hash : undefined;
}

/** Map a canonical provenance onto the frozen `MemorySource`. */
function toSource(provenance: MemoryProvenance): MemorySource {
  switch (provenance) {
    case "system_state":
      return "system_state";
    case "mission_result":
      return "mission_result";
    case "agent_output":
      return "agent_output";
    case "user_statement":
      return "user_statement";
    default:
      return "system_state";
  }
}
