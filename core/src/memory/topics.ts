// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * KAI Core memory — on-disk layout and topics (Phase 2 Part B4).
 *
 * SQLite is the source of truth for memory; this module is the human-readable,
 * KAI-OWNED mirror of it. The layout is:
 *
 *   <root>/MEMORY.md          an index: topics, then unfiled entries
 *   <root>/topics/<slug>.md   one topic per file, with frontmatter metadata
 *   <root>/archive/           entries that expired or were archived
 *   <root>/log/               an append-only, redacted journal export
 *
 * `root` defaults to a `memory/` directory beside the Core database, so it lives
 * in the user's KAI data directory — outside the repository and outside anything
 * an agent's file tools treat as its own scratch space.
 *
 * Two rules the directive insists on and this module honours:
 *
 *   - TOPIC METADATA IS REAL. A topic file carries a title, a description and
 *     aliases in frontmatter, and discovery reads them back. A topic with no
 *     description is not a topic; it is a filename.
 *
 *   - ITEMS ARE NOT FORCED INTO A TOPIC. An entry with no `topicId` is normal,
 *     not an error. The index lists unfiled entries under a separate heading so
 *     nothing is misplaced just to keep the tree tidy. Filesystem discovery is
 *     therefore never the only way to find a fact — the store always is.
 *
 * Discovery is BOUNDED: `discoverTopics` reads at most `limit` topic files, in a
 * stable order. A layout that somehow grew thousands of files cannot turn a
 * recall into an unbounded directory walk.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

import { parseEntryLine, renderEntryLine, type ParsedEntryLine } from "./entry.ts";
import type { JournalRecord, MemoryEntry, MemoryTopic } from "./model.ts";

export interface MemoryLayout {
  root: string;
  indexPath: string;
  topicsDir: string;
  archiveDir: string;
  logDir: string;
}

export function memoryLayout(root: string): MemoryLayout {
  return {
    root,
    indexPath: join(root, "MEMORY.md"),
    topicsDir: join(root, "topics"),
    archiveDir: join(root, "archive"),
    logDir: join(root, "log"),
  };
}

/** Create every directory the layout needs. Idempotent. */
export function ensureLayout(layout: MemoryLayout): void {
  for (const dir of [layout.root, layout.topicsDir, layout.archiveDir, layout.logDir]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "topic";
}

// ── Topic files ───────────────────────────────────────────────────────────────

function frontmatterValue(value: string): string {
  // Frontmatter is line-based `key: value`; strip anything that would break the
  // frame so a title with a newline cannot forge a second field.
  return value.replace(/\r?\n/g, " ").trim();
}

export function renderTopicFile(topic: MemoryTopic, entries: readonly MemoryEntry[]): string {
  const lines: string[] = [
    "---",
    `id: ${frontmatterValue(topic.id)}`,
    `slug: ${frontmatterValue(topic.slug)}`,
    `title: ${frontmatterValue(topic.title)}`,
    `description: ${frontmatterValue(topic.description)}`,
    `aliases: ${topic.aliases.map(frontmatterValue).join(", ")}`,
    `updated: ${topic.updatedAt}`,
    "---",
    "",
    `# ${topic.title}`,
    "",
    topic.description,
    "",
    "## Entries",
    "",
  ];
  for (const entry of entries) lines.push(renderEntryLine(entry));
  lines.push("");
  return lines.join("\n");
}

export interface ParsedTopicFile {
  id?: string;
  slug?: string;
  title?: string;
  description?: string;
  aliases: string[];
  updated?: string;
  entries: ParsedEntryLine[];
}

export function parseTopicFile(text: string): ParsedTopicFile | null {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  const out: ParsedTopicFile = { aliases: [], entries: [] };
  let i = 1;
  for (; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.trim() === "---") {
      i += 1;
      break;
    }
    const match = /^([a-z_]+):\s?(.*)$/i.exec(line);
    if (match === null) continue;
    const key = match[1];
    const value = (match[2] ?? "").trim();
    if (key === "id") out.id = value;
    else if (key === "slug") out.slug = value;
    else if (key === "title") out.title = value;
    else if (key === "description") out.description = value;
    else if (key === "updated") out.updated = value;
    else if (key === "aliases") {
      out.aliases = value.length === 0 ? [] : value.split(",").map((a) => a.trim()).filter((a) => a.length > 0);
    }
  }
  for (; i < lines.length; i += 1) {
    const parsed = parseEntryLine(lines[i] ?? "");
    if (parsed !== null) out.entries.push(parsed);
  }
  return out;
}

// ── Index ─────────────────────────────────────────────────────────────────────

export function renderIndex(
  topics: readonly MemoryTopic[],
  entries: readonly MemoryEntry[],
  generatedAt: string,
): string {
  const byTopic = new Map<string, MemoryEntry[]>();
  const unfiled: MemoryEntry[] = [];
  for (const entry of entries) {
    if (entry.topicId === undefined) {
      unfiled.push(entry);
      continue;
    }
    const list = byTopic.get(entry.topicId) ?? [];
    list.push(entry);
    byTopic.set(entry.topicId, list);
  }

  const lines: string[] = [
    "# KAI Memory",
    "",
    `_Generated ${generatedAt}. SQLite is the source of truth; this file is a readable projection._`,
    "",
    `- entries: ${entries.length}`,
    `- topics: ${topics.length}`,
    `- unfiled entries: ${unfiled.length}`,
    "",
    "## Topics",
    "",
  ];

  if (topics.length === 0) {
    lines.push("_No topics yet._", "");
  } else {
    for (const topic of topics) {
      const count = byTopic.get(topic.id)?.length ?? 0;
      lines.push(`### ${topic.title} (${count})`, "");
      lines.push(topic.description);
      if (topic.aliases.length > 0) lines.push(`_Aliases: ${topic.aliases.join(", ")}_`);
      lines.push("", `→ topics/${topic.slug}.md`, "");
    }
  }

  lines.push("## Unfiled", "");
  if (unfiled.length === 0) {
    lines.push("_Every entry is filed under a topic._", "");
  } else {
    lines.push("_Entries are not forced into a topic. These have no topic yet._", "");
    for (const entry of unfiled) lines.push(renderEntryLine(entry));
    lines.push("");
  }
  return lines.join("\n");
}

// ── Writes ────────────────────────────────────────────────────────────────────

export function writeTopicFile(layout: MemoryLayout, topic: MemoryTopic, entries: readonly MemoryEntry[]): string {
  ensureLayout(layout);
  const file = join(layout.topicsDir, `${topic.slug}.md`);
  writeFileSync(file, renderTopicFile(topic, entries), "utf8");
  return file;
}

export function writeIndex(
  layout: MemoryLayout,
  topics: readonly MemoryTopic[],
  entries: readonly MemoryEntry[],
  generatedAt: string,
): string {
  ensureLayout(layout);
  writeFileSync(layout.indexPath, renderIndex(topics, entries, generatedAt), "utf8");
  return layout.indexPath;
}

/** Append one redacted journal line to `log/`. The export is never read as truth. */
export function appendJournalLog(layout: MemoryLayout, record: JournalRecord): string {
  ensureLayout(layout);
  const day = record.at.slice(0, 10);
  const file = join(layout.logDir, `${day}.md`);
  const summary =
    `${record.at} · ${record.actor} · ${record.op}` +
    (record.entryId !== undefined ? ` · ${record.entryId}` : "") +
    (record.beforeHash !== undefined ? ` · ${record.beforeHash}` : "") +
    (record.afterHash !== undefined ? `→${record.afterHash}` : "") +
    ` · ${record.reason}`;
  // `change` is already redacted by the caller before it reaches the journal.
  appendFileSync(file, `- ${summary}\n`, "utf8");
  return file;
}

export function archiveEntries(layout: MemoryLayout, entries: readonly MemoryEntry[], at: string): string | null {
  if (entries.length === 0) return null;
  ensureLayout(layout);
  const file = join(layout.archiveDir, `${at.slice(0, 7)}.md`);
  const body = entries.map((entry) => renderEntryLine(entry)).join("\n");
  appendFileSync(file, `${body}\n`, "utf8");
  return file;
}

// ── Bounded discovery ─────────────────────────────────────────────────────────

export interface DiscoveredTopic {
  topic: MemoryTopic;
  entryCount: number;
  file: string;
}

/**
 * Read topic metadata back from disk, up to `limit` files (default 100). A file
 * without a title is skipped rather than guessed at: discovery must not invent a
 * topic the store does not know about.
 */
export function discoverTopics(
  layout: MemoryLayout,
  opts: { limit?: number } = {},
): DiscoveredTopic[] {
  if (!existsSync(layout.topicsDir)) return [];
  const limit = opts.limit === undefined ? 100 : Math.max(0, opts.limit);
  const names = readdirSync(layout.topicsDir)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .slice(0, limit);

  const found: DiscoveredTopic[] = [];
  for (const name of names) {
    const file = join(layout.topicsDir, name);
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const parsed = parseTopicFile(text);
    if (parsed === null || parsed.title === undefined || parsed.description === undefined) continue;
    const slug = parsed.slug ?? name.replace(/\.md$/, "");
    found.push({
      file,
      entryCount: parsed.entries.length,
      topic: {
        id: parsed.id ?? `topic_${slug}`,
        slug,
        title: parsed.title,
        description: parsed.description,
        aliases: parsed.aliases,
        createdAt: parsed.updated ?? new Date(0).toISOString(),
        updatedAt: parsed.updated ?? new Date(0).toISOString(),
      },
    });
  }
  return found;
}
