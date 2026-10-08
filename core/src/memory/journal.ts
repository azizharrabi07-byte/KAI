// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * KAI Core memory — journal and safe revert (Phase 2 Part B8).
 *
 * Every durable memory modification is recorded here. The record carries the
 * actor, the source, the timestamp, the before/after content hashes, a redacted
 * description of the change, the reason, and whether it is reversible — the
 * exact fields the directive names.
 *
 * Three rules are load-bearing:
 *
 *   1. NO RAW SECRETS. A snapshot is `redactSecrets`-ed before it is stored, so
 *      a journal row can be read, exported or shown without leaking a credential
 *      the memory layer refused to hold in the first place.
 *
 *   2. HISTORY IS APPEND-ONLY. This module only builds records; the store only
 *      inserts them (`appendJournal`); there is no update or delete path for a
 *      journal row on `MemoryEntryStore` at all. A revert APPENDS a new record
 *      that points at the one it reverses — it never rewrites the old one.
 *
 *   3. NOT AGENT-WRITABLE. The journal lives in the Core database (outside the
 *      git working tree, under the user's KAI data directory), not in the
 *      workspace an agent edits. The human-readable `memory/log/` export is a
 *      projection of it and is never read back as truth.
 *
 * Revert is deliberately conservative: a plan is produced only when reversing
 * the record cannot destroy a change made later. If the entry has moved on
 * since (its hash no longer matches the record's `afterHash`), the revert is
 * refused rather than clobbering newer truth.
 */

import { redactSecrets } from "../redact/index.ts";
import {
  memoryRefusal,
  type JournalRecord,
  type MemoryEntry,
  type MemoryRefusal,
  type MemoryScope,
} from "./model.ts";

let journalSeq = 0;
export function newJournalId(now: () => Date): string {
  return `jrn_${now().getTime().toString(36)}_${(journalSeq++).toString(36)}`;
}

/**
 * Snapshot an entry for a journal row. Value-level redaction runs over the whole
 * object, so a credential that somehow reached a metadata field is masked too.
 */
export function snapshotEntry(entry: MemoryEntry | null): Record<string, unknown> | undefined {
  if (entry === null) return undefined;
  const redacted = redactSecrets(entry) as Record<string, unknown>;
  return redacted;
}

// ── Snapshot ↔ entry ──────────────────────────────────────────────────────────

const SNAPSHOT_KEYS: readonly (keyof MemoryEntry)[] = [
  "id",
  "scope",
  "scopeId",
  "content",
  "source",
  "provenance",
  "type",
  "importance",
  "confidence",
  "createdAt",
  "updatedAt",
  "date",
  "until",
  "supersededBy",
  "supersedes",
  "hash",
  "topicId",
  "archivedAt",
  "redacted",
  "metadata",
];

/** Rebuild an entry from a snapshot. Only the known keys are read, so a snapshot
 * that gained an unexpected field cannot smuggle it into the store. */
export function entryFromSnapshot(snapshot: Record<string, unknown>): MemoryEntry | null {
  const raw = snapshot as Partial<MemoryEntry>;
  if (typeof raw.id !== "string" || typeof raw.content !== "string") return null;
  const entry: MemoryEntry = {
    id: raw.id,
    scope: (raw.scope ?? "global") as MemoryScope,
    scopeId: typeof raw.scopeId === "string" ? raw.scopeId : "global",
    content: raw.content,
    source: (raw.source ?? "system_state") as MemoryEntry["source"],
    provenance: (raw.provenance ?? "imported") as MemoryEntry["provenance"],
    type: (raw.type ?? "note") as MemoryEntry["type"],
    importance: typeof raw.importance === "number" ? raw.importance : 3,
    confidence: typeof raw.confidence === "number" ? raw.confidence : 1,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
    date: typeof raw.date === "string" ? raw.date : new Date().toISOString(),
    hash: typeof raw.hash === "string" ? raw.hash : "",
  };
  for (const key of SNAPSHOT_KEYS) {
    if (key === "redacted") {
      if (raw.redacted === true) entry.redacted = true;
      continue;
    }
    const value = (raw as Record<string, unknown>)[key as string];
    if (value !== undefined && value !== null && value !== "") {
      (entry as unknown as Record<string, unknown>)[key as string] = value;
    }
  }
  return entry;
}

// ── Revert planning ───────────────────────────────────────────────────────────

export type RevertPlan =
  | { kind: "remove"; entryId: string; description: string }
  | { kind: "restore"; entry: MemoryEntry; description: string };

/**
 * Decide whether `record` can be safely reversed given the entry's CURRENT
 * state, and what the inverse operation is.
 *
 *   create          → remove the entry (safe only if it is unchanged since)
 *   update          → restore the recorded `before` entry
 *   supersede       → restore the recorded `before` entry (un-supersede)
 *   expire/archive  → restore the recorded `before` entry
 *   delete          → re-insert the recorded `before` entry (safe only if still gone)
 *   revert          → never (a revert is not itself reverted)
 */
export function planRevert(
  record: JournalRecord,
  current: MemoryEntry | null,
): { ok: true; plan: RevertPlan } | { ok: false; refusal: MemoryRefusal } {
  if (!record.reversible) {
    return {
      ok: false,
      refusal: memoryRefusal("REVERT_UNSAFE", `journal record ${record.id} is not reversible (op=${record.op})`),
    };
  }

  const before = record.before === undefined ? null : entryFromSnapshot(record.before);

  if (record.op === "create") {
    if (current === null) {
      return {
        ok: false,
        refusal: memoryRefusal("REVERT_UNSAFE", `entry ${record.entryId ?? "?"} no longer exists; nothing to undo`),
      };
    }
    if (record.afterHash !== undefined && current.hash !== record.afterHash) {
      return {
        ok: false,
        refusal: memoryRefusal(
          "REVERT_UNSAFE",
          `entry ${current.id} changed after it was created; reverting the create would destroy a newer fact`,
        ),
      };
    }
    return { ok: true, plan: { kind: "remove", entryId: current.id, description: `undo create of ${current.id}` } };
  }

  if (record.op === "delete") {
    if (current !== null) {
      return {
        ok: false,
        refusal: memoryRefusal("REVERT_UNSAFE", `entry ${record.entryId ?? "?"} was re-created; reverting the delete is not safe`),
      };
    }
    if (before === null) {
      return { ok: false, refusal: memoryRefusal("REVERT_UNSAFE", `journal record ${record.id} has no snapshot to restore`) };
    }
    return { ok: true, plan: { kind: "restore", entry: before, description: `undo delete of ${before.id}` } };
  }

  // update / supersede / expire / archive: restore the previous state.
  if (before === null) {
    return { ok: false, refusal: memoryRefusal("REVERT_UNSAFE", `journal record ${record.id} has no snapshot to restore`) };
  }
  if (current !== null && record.afterHash !== undefined && current.hash !== record.afterHash) {
    return {
      ok: false,
      refusal: memoryRefusal(
        "REVERT_UNSAFE",
        `entry ${current.id} changed after journal record ${record.id}; reverting would clobber a newer change`,
      ),
    };
  }
  return { ok: true, plan: { kind: "restore", entry: before, description: `restore ${before.id} to its previous state` } };
}
