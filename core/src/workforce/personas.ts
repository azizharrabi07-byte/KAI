// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * KAI's curated persona library — seeded idempotently on every boot.
 *
 * `core/agents-library/` holds one JSON `KaiSubagentSpec` per file, produced by
 * `core/scripts/mine-agents.mjs` and reviewed before it landed. The contract
 * mirrors the skill library exactly, for the same reason:
 *
 *   - an id a HUMAN already owns is never overwritten, so a user who edits or
 *     replaces a library persona keeps their version;
 *   - every entry passes the SAME `validateSubagentSpec` a hand-registered
 *     persona passes. Library personas are trusted by curation, not by a bypass;
 *   - a file that fails validation is REPORTED in `skipped`, never thrown. A bad
 *     library file must not break the boot.
 *
 * A persona is prompt material. Its authority comes from the registry boundary
 * and the Guard, never from the text it carries — which is why a mined persona
 * cannot widen its own scope no matter what its `instructions` say.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { validateSubagentSpec, type KaiSubagentSpec, type SubagentRegistry } from "./subagent.ts";

/**
 * Resolve `<core>/agents-library` relative to this module file, so it works from
 * `src/`, `dist/` and `bundle/` layouts alike — the same trick the skill library
 * uses.
 */
export function personasDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "agents-library");
}

export interface LibraryPersonaSkipped {
  file: string;
  reason: string;
}

export interface LibraryPersonaLoad {
  specs: KaiSubagentSpec[];
  skipped: LibraryPersonaSkipped[];
}

export function listLibraryPersonas(): LibraryPersonaLoad {
  let files: string[];
  try {
    files = readdirSync(personasDir()).filter((file) => file.endsWith(".json")).sort();
  } catch {
    // No library directory is a valid state: KAI simply has no seeded personas.
    return { specs: [], skipped: [] };
  }

  const specs: KaiSubagentSpec[] = [];
  const skipped: LibraryPersonaSkipped[] = [];
  for (const file of files) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(personasDir(), file), "utf8"));
    } catch (error) {
      skipped.push({ file, reason: `not readable as JSON: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
    const validated = validateSubagentSpec(raw);
    if (!validated.ok) {
      skipped.push({ file, reason: validated.reason });
      continue;
    }
    specs.push(validated.value);
  }
  return { specs, skipped };
}

export interface PersonaSeedReport {
  seeded: string[];
  /** Ids a human already owns — left exactly as they are. */
  existing: string[];
  failed: { file: string; reason: string }[];
}

/**
 * Seed the library into a registry. Idempotent by id: an id that already exists
 * is SKIPPED, so a user's own persona is never overwritten by a boot.
 */
export function seedLibraryPersonas(registry: SubagentRegistry): PersonaSeedReport {
  const { specs, skipped } = listLibraryPersonas();
  const report: PersonaSeedReport = { seeded: [], existing: [], failed: [...skipped] };
  for (const spec of specs) {
    if (registry.get(spec.id) !== undefined) {
      report.existing.push(spec.id);
      continue;
    }
    const defined = registry.define(spec);
    if (defined.ok) report.seeded.push(spec.id);
    else report.failed.push({ file: `${spec.id}.json`, reason: defined.error?.message ?? "refused" });
  }
  return report;
}
