// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * KAI Core memory — deterministic entry grammar and identity (Phase 2 Part B3).
 *
 * Two things must be deterministic, and this file is both:
 *
 *   1. THE GRAMMAR. Every entry can be rendered to exactly one line and parsed
 *      back to the same entry. That line is what the on-disk `MEMORY.md` and
 *      `topics/*.md` files hold (Part B4), so a human reading the file sees the
 *      same fact the store holds. The fields are the ones the directive names:
 *      date, source, content, and the optional `until` / `superseded` trailers.
 *
 *      The line shape is:
 *
 *        - [<id>] <date> | <provenance> | <content>
 *
 *      followed by optional trailers, in a fixed order, only when present:
 *
 *        { until=<iso>}
 *        { superseded=<id>}
 *
 *      Content is single-line by construction: any newline in the raw content is
 *      escaped to a literal `\n` so one entry is always one line and the line
 *      budget in Part B2 counts what a reader actually sees. `|` inside a field
 *      is escaped as `\|`. Both escapes are reversed by the parser, so
 *      `parse(render(e))` is `e` for every entry the store can produce.
 *
 *   2. THE IDENTITY. An entry's content hash is `sha256` over a canonical tuple
 *      of scope, scope id and NORMALISED content. Same input twice → same hash →
 *      the store collapses it to one entry with no fuzzy or AI matching. Scope
 *      is part of the tuple deliberately: the same sentence under `global` and
 *      under one mission are two different facts and must not collide.
 *
 * Normalisation is exact and explainable: trim the ends, collapse internal runs
 * of whitespace to a single space, and case-fold. Case-folding is safe here
 * because a hash only decides "is this the same fact"; it never rewrites the
 * stored content, so the entry keeps the casing the user actually used.
 */

import { createHash } from "node:crypto";

import { GLOBAL_SCOPE_ID, type MemoryEntry, type MemoryProvenance, type MemoryScope } from "./model.ts";

const ESCAPED_PIPE = "\\|";
const ESCAPED_NEWLINE = "\\n";

/** Collapse an entry to the exact string identity is computed over. */
export function normalizeContent(content: string): string {
  return content.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * The deterministic content hash. 16 hex chars is ample for a per-bucket
 * identity while staying short enough to appear in a journal row; the full
 * sha256 would make a grammar line unreadable and buy nothing here.
 */
export function computeHash(scope: MemoryScope, scopeId: string, content: string): string {
  const normalized = normalizeContent(content);
  const tuple = `${scope}\u0000${scopeId}\u0000${normalized}`;
  return createHash("sha256").update(tuple, "utf8").digest("hex").slice(0, 16);
}

/** Per-bucket identity: the store's uniqueness key. */
export function identityKey(entry: {
  scope: MemoryScope;
  scopeId: string;
  content: string;
}): string {
  return `${entry.scope}:${entry.scopeId}:${computeHash(entry.scope, entry.scopeId, entry.content)}`;
}

// ── Escape helpers ────────────────────────────────────────────────────────────

function escapeField(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, ESCAPED_PIPE)
    .replace(/\r?\n/g, ESCAPED_NEWLINE);
}

function unescapeField(value: string): string {
  // Order matters: unescape the doubled backslash last so an escaped `\n` in the
  // source is not turned into a real newline before the `\\` pass runs.
  return value
    .replace(/\\n/g, "\n")
    .replace(/\\\|/g, "|")
    .replace(/\\\\/g, "\\");
}

// ── Grammar: render ───────────────────────────────────────────────────────────

const TRAILER_UNTIL = "{ until=";
const TRAILER_SUPERSEDED = "{ superseded=";
const TRAILER_CLOSE = "}";

/**
 * Render one entry to its canonical single line. This is a total function: it
 * never throws and never emits a newline, which is what lets the file layout
 * treat one line as one entry.
 */
export function renderEntryLine(entry: MemoryEntry): string {
  const head = `- [${entry.id}] ${entry.date} | ${entry.provenance} | ${escapeField(entry.content)}`;
  let out = head;
  // A trailing space before `{` is intentional and stable: the parser splits on
  // the trailer marker, not on the space, so the format is byte-stable.
  if (entry.until !== undefined && entry.until.length > 0) {
    out += ` ${TRAILER_UNTIL}${entry.until}${TRAILER_CLOSE}`;
  }
  if (entry.supersededBy !== undefined && entry.supersededBy.length > 0) {
    out += ` ${TRAILER_SUPERSEDED}${entry.supersededBy}${TRAILER_CLOSE}`;
  }
  return out;
}

export interface ParsedEntryLine {
  id: string;
  date: string;
  provenance: MemoryProvenance;
  content: string;
  until?: string;
  supersededBy?: string;
}

/**
 * Parse a grammar line back to its fields, or return `null` when the line is
 * not an entry (a heading, a blank line, free prose). Returning null rather than
 * throwing is deliberate: the file layout discovers entries by scanning, and a
 * file that gains a comment must not break discovery.
 */
export function parseEntryLine(line: string): ParsedEntryLine | null {
  const trimmed = line.trimEnd();
  if (!trimmed.startsWith("- [")) return null;

  // 1. Split trailers off the end (fixed order, both optional).
  let body = trimmed;
  let supersededBy: string | undefined;
  let until: string | undefined;
  const supIdx = body.lastIndexOf(TRAILER_SUPERSEDED);
  if (supIdx >= 0 && body.endsWith(TRAILER_CLOSE)) {
    const value = body.slice(supIdx + TRAILER_SUPERSEDED.length, -1);
    supersededBy = value.length > 0 ? value : undefined;
    body = body.slice(0, supIdx).trimEnd();
  }
  const untilIdx = body.lastIndexOf(TRAILER_UNTIL);
  if (untilIdx >= 0 && body.endsWith(TRAILER_CLOSE)) {
    const value = body.slice(untilIdx + TRAILER_UNTIL.length, -1);
    until = value.length > 0 ? value : undefined;
    body = body.slice(0, untilIdx).trimEnd();
  }

  // 2. `- [id] date | provenance | content`.
  const rest = body.slice(2); // drop "- "
  const idEnd = rest.indexOf("]");
  if (!rest.startsWith("[") || idEnd < 0) return null;
  const id = rest.slice(1, idEnd);
  const afterId = rest.slice(idEnd + 1).trimStart();

  const firstPipe = afterId.indexOf("|");
  const secondPipe = firstPipe < 0 ? -1 : afterId.indexOf("|", firstPipe + 1);
  if (id.length === 0 || firstPipe < 0 || secondPipe < 0) return null;

  const date = afterId.slice(0, firstPipe).trim();
  const provenance = afterId.slice(firstPipe + 1, secondPipe).trim();
  const rawContent = afterId.slice(secondPipe + 1);
  // Exactly one leading space between the second `|` and the content.
  const content = unescapeField(rawContent.startsWith(" ") ? rawContent.slice(1) : rawContent);

  const parsed: ParsedEntryLine = {
    id,
    date,
    provenance: provenance as MemoryProvenance,
    content,
  };
  if (until !== undefined) parsed.until = until;
  if (supersededBy !== undefined) parsed.supersededBy = supersededBy;
  return parsed;
}

/** True when a rendered line round-trips, used by tests and the layout writer. */
export function grammarRoundTrips(line: string): boolean {
  const parsed = parseEntryLine(line);
  if (parsed === null) return false;
  return parseEntryLine(
    renderEntryLine({
      ...parsed,
      scope: "global",
      scopeId: GLOBAL_SCOPE_ID,
      source: "user_statement",
      type: "note",
      importance: 1,
      confidence: 1,
      createdAt: parsed.date,
      updatedAt: parsed.date,
      hash: "",
    }),
  )?.content === parsed.content;
}

// ── Id factory ────────────────────────────────────────────────────────────────

/**
 * Deterministic ids: `mem_<millis base36>_<counter base36>`. Two entries created
 * in the same millisecond still differ, and given an injected clock a test can
 * predict the id. Never derived from the content, so supersession can point at
 * an entry whose content later changes.
 */
export function createIdFactory(now: () => Date): () => string {
  let seq = 0;
  return () => `mem_${now().getTime().toString(36)}_${(seq++).toString(36)}`;
}

/** Build the `MemoryEntry`'s on-disk grammar date: the fact's date, else createdAt. */
export function entryDate(entry: { date?: string; createdAt: string }): string {
  return entry.date !== undefined && entry.date.length > 0 ? entry.date : entry.createdAt;
}
