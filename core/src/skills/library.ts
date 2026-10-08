// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * KAI's curated third-party skill library — seeded idempotently on every boot
 * (an id already present is left untouched, so a human's replacement of a
 * library skill is never overwritten).
 *
 * `core/skills-library/` holds the curated `*.md` files plus `SOURCES.md`
 * (provenance, not a skill). Every entry passes the SAME `parseSkillMarkdown`
 * validation as a staged skill: library skills are trusted by curation, not
 * by a bypass. A file that fails validation is REPORTED in `skipped`, never
 * thrown — a bad library file must never break the boot.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SkillSeeder } from "./builtin.ts";
import { parseSkillMarkdown, validateSkillId } from "./validate.ts";

export const KAI_LIBRARY_SOURCE = "discovered:kai-library";

/**
 * Resolve `<core>/skills-library` relative to this module file, so it works
 * from `src/`, `dist/`, and `bundle/` layouts alike.
 */
export function libraryDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills-library");
}

export interface LibrarySkill {
  id: string;
  markdown: string;
}

export interface LibrarySkipped {
  file: string;
  reason: string;
}

/**
 * Read every `*.md` in the library directory (sorted), except `SOURCES.md`.
 * Each file's id is its filename minus `.md`; invalid files are reported in
 * `skipped` and never thrown.
 */
export function listLibrarySkills(): { skills: LibrarySkill[]; skipped: LibrarySkipped[] } {
  const skills: LibrarySkill[] = [];
  const skipped: LibrarySkipped[] = [];
  let files: string[];
  try {
    files = readdirSync(libraryDir()).filter((file) => file.endsWith(".md")).sort();
  } catch (error) {
    skipped.push({ file: ".", reason: `cannot read library directory: ${(error as Error).message}` });
    return { skills, skipped };
  }
  for (const file of files) {
    if (file === "SOURCES.md") continue;
    const id = file.slice(0, -".md".length);
    if (id.length === 0 || validateSkillId(id).length > 0) {
      skipped.push({ file, reason: `invalid skill id "${id}"` });
      continue;
    }
    let markdown: string;
    try {
      markdown = readFileSync(join(libraryDir(), file), "utf8");
    } catch (error) {
      skipped.push({ file, reason: `cannot read file: ${(error as Error).message}` });
      continue;
    }
    const parsed = parseSkillMarkdown(markdown, { id });
    if (!parsed.ok) {
      skipped.push({ file, reason: parsed.error.message });
      continue;
    }
    skills.push({ id, markdown });
  }
  return { skills, skipped };
}

/**
 * Register every library skill whose id is absent. Present ids are skipped (a
 * human replacement wins), files that failed validation are reported in
 * `skipped` as `file:<name>`, and a skill that fails registration is
 * REPORTED in `failed`, not thrown — a bad library skill must never break
 * the boot.
 */
export function seedLibrarySkills(registry: SkillSeeder): { seeded: string[]; skipped: string[]; failed: { id: string }[] } {
  const seeded: string[] = [];
  const skipped: string[] = [];
  const failed: { id: string }[] = [];
  const { skills, skipped: invalid } = listLibrarySkills();
  for (const entry of invalid) {
    skipped.push(`file:${entry.file}`);
  }
  for (const skill of skills) {
    if (registry.has(skill.id)) {
      skipped.push(skill.id);
      continue;
    }
    const result = registry.register({ id: skill.id, markdown: skill.markdown, source: KAI_LIBRARY_SOURCE });
    if (result.ok) seeded.push(skill.id);
    else failed.push({ id: skill.id });
  }
  return { seeded, skipped, failed };
}
