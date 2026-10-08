// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * KAI Core memory — hard bounds (Phase 2 Part B2).
 *
 * The rule this file enforces, in one sentence: a write that would put a bucket
 * over its line or byte budget is REFUSED, never silently stored where nothing
 * can reach it.
 *
 * The failure mode being prevented is subtle but real. A memory store with no
 * ceiling eventually exceeds whatever the reader (a prompt, a UI digest, a file
 * view) is willing to load; at that point rows still exist but are unreachable —
 * memory that "remembers" in the database and forgets in practice. Refusing at
 * write time keeps every stored entry reachable, and the refusal names exactly
 * which budget was hit and what would make room.
 *
 * Both counters are computed from the same content the grammar renders:
 *   lines = sum over entries of the content's newline-delimited line count
 *   bytes = UTF-8 byte length of every entry's content
 *
 * Only CONTENT is counted, not ids/timestamps/trailers. Those are fixed-shape
 * metadata the store owns; counting them would make the budget depend on id
 * formatting rather than on how much memory the user actually has.
 */

import {
  MEMORY_SCOPE_BOUNDS,
  memoryRefusal,
  type MemoryBounds,
  type MemoryEntry,
  type MemoryRefusal,
} from "./model.ts";

export interface BucketUsage {
  entries: number;
  lines: number;
  bytes: number;
}

/** Measure one entry's contribution in lines and bytes. */
export function measureEntry(content: string): { lines: number; bytes: number } {
  const lines = content.length === 0 ? 0 : content.split("\n").length;
  const bytes = Buffer.byteLength(content, "utf8");
  return { lines, bytes };
}

export function measureEntries(entries: readonly { content: string }[]): BucketUsage {
  let lines = 0;
  let bytes = 0;
  for (const entry of entries) {
    const measured = measureEntry(entry.content);
    lines += measured.lines;
    bytes += measured.bytes;
  }
  return { entries: entries.length, lines, bytes };
}

export function boundsFor(scope: MemoryEntry["scope"]): MemoryBounds {
  return MEMORY_SCOPE_BOUNDS[scope];
}

const nf = new Intl.NumberFormat("en-US");
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Would adding `candidateContent` to a bucket that currently measures `usage`
 * exceed the scope's budget? Returns a refusal (with a machine-readable reason
 * and a consolidation hint) when it would, otherwise null.
 *
 * The candidate is always counted, never assumed to fit: an entry larger than an
 * entire budget is refused too, because storing it would leave nothing else in
 * the bucket reachable.
 */
export function checkWriteBounds(
  scope: MemoryEntry["scope"],
  usage: BucketUsage,
  candidateContent: string,
): MemoryRefusal | null {
  const bounds = boundsFor(scope);
  const candidate = measureEntry(candidateContent);
  const nextLines = usage.lines + candidate.lines;
  const nextBytes = usage.bytes + candidate.bytes;

  // Lines first: it is the budget a reader hits first, and reporting the
  // smaller, more concrete number is more useful when both are exceeded.
  if (nextLines > bounds.maxLines) {
    return memoryRefusal(
      "LIMIT_EXCEEDED",
      `writing this ${candidate.lines}-line fact would put the ${scope} memory at ${nextLines}/${bounds.maxLines} lines`,
      {
        limit: { kind: "lines", used: nextLines, max: bounds.maxLines },
        consolidationHint:
          `The ${scope} memory holds ${usage.lines}/${bounds.maxLines} lines across ${usage.entries} entries. ` +
          "Consolidate (purge expired/superseded entries or merge duplicates) before writing again.",
      },
    );
  }

  if (nextBytes > bounds.maxBytes) {
    return memoryRefusal(
      "LIMIT_EXCEEDED",
      `writing this ${formatBytes(candidate.bytes)} fact would put the ${scope} memory at ${formatBytes(nextBytes)}/${formatBytes(bounds.maxBytes)}`,
      {
        limit: { kind: "bytes", used: nextBytes, max: bounds.maxBytes },
        consolidationHint:
          `The ${scope} memory holds ${formatBytes(usage.bytes)}/${formatBytes(bounds.maxBytes)} across ${usage.entries} entries. ` +
          "Consolidate (purge expired/superseded entries or merge duplicates) before writing again.",
      },
    );
  }

  return null;
}

/** A one-line, machine-checkable summary of how full a bucket is. */
export function usageSummary(scope: MemoryEntry["scope"], usage: BucketUsage): string {
  const bounds = boundsFor(scope);
  return `${usage.entries} entries · ${usage.lines}/${bounds.maxLines} lines · ${formatBytes(usage.bytes)}/${formatBytes(bounds.maxBytes)}`;
}

/**
 * Candidates that consolidation could free, cheapest-reversible first. The
 * upkeep cycle uses this to decide what to purge, and the refusal hint quotes
 * it so a caller is told what to do rather than only that it failed.
 */
export function consolidationPlan(
  entries: readonly MemoryEntry[],
  nowIsoString: string,
): { purge: MemoryEntry[]; reclaimableLines: number; reclaimableBytes: number; hint: string } {
  const now = Date.parse(nowIsoString);
  const purge: MemoryEntry[] = [];
  for (const entry of entries) {
    const expired = entry.until !== undefined && Date.parse(entry.until) <= now;
    const superseded = entry.supersededBy !== undefined && entry.supersededBy.length > 0;
    const archived = entry.archivedAt !== undefined && entry.archivedAt.length > 0;
    // Safe to drop: nothing will recall it again. Never drops a live fact
    // automatically — consolidation frees only what is already unreachable.
    if (expired || superseded || archived) purge.push(entry);
  }
  const reclaimed = measureEntries(purge);
  const hint =
    purge.length === 0
      ? "No expired, superseded or archived entries can be reclaimed; this bucket is genuinely full."
      : `Purge ${purge.length} expired/superseded/archived entr${purge.length === 1 ? "y" : "ies"} to reclaim ${reclaimed.lines} line(s) and ${formatBytes(reclaimed.bytes)}.`;
  return {
    purge,
    reclaimableLines: reclaimed.lines,
    reclaimableBytes: reclaimed.bytes,
    hint,
  };
}
