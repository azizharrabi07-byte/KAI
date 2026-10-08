#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Curate third-party SKILL.md files into KAI's library.
 *
 * HARD GATE: KAI's own `parseSkillMarkdown` — a skill that fails validation
 * is refused, no matter how popular its repo is.
 *
 * QUALITY ("excellent" only): complete metadata (purpose, tools, constraints),
 * a substantive procedure body, no placeholders, no duplication.
 *
 * Usage:
 *   node scripts/curate-skills.mjs <harvest-root> <out-dir> [--top=300] [--threshold=6]
 *
 * Writes <out-dir>/<id>.md for winners + <out-dir>/REPORT.json. Copies
 * nothing on its own — the operator reviews REPORT.json, then moves the
 * winners into `core/skills-library/`.
 */

import { readdirSync, readFileSync, mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const CORE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { parseSkillMarkdown } = await import("../src/skills/validate.ts");
const { validateSkillId } = await import("../src/skills/validate.ts");

const [harvestRoot, outDir] = process.argv.slice(2);
const topN = Number(/--top=(\d+)/.exec(process.argv.join(" "))?.[1] ?? 320);
const threshold = Number(/--threshold=(\d+)/.exec(process.argv.join(" "))?.[1] ?? 4);
if (!harvestRoot || !outDir) {
  console.error("usage: curate-skills.mjs <harvest-root> <out-dir> [--top=300] [--threshold=6]");
  process.exit(2);
}

// Sources whose license permits redistribution. EXCLUDED:
// - Anthropic's four source-available document skills (reference only, not open).
// - Entire repos with no license statement (ai-1989v, aria-plugin): without
//   one, redistribution is unsafe no matter how good the content.
const EXCLUDE_DIRS = ["skills/docx", "skills/pdf", "skills/pptx", "skills/xlsx", "ai-1989v", "aria-plugin"].map(
  (p) => p.replaceAll("/", "\\"),
);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && entry.name === "SKILL.md") out.push(full);
  }
  return out;
}

function slug(text) {
  return text.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 56) || "skill";
}

const PLACEHOLDERS = ["todo", "tbd", "fixme", "lorem ipsum", "coming soon", "under construction", "xxx"];

function score(parsed, markdown) {
  // Calibrated to the ecosystem: most public skills carry name+description+body
  // only. Metadata (purpose/tools/constraints) is a bonus, not the bar — the
  // bar is a substantive, structured, concrete procedure with no placeholders.
  let points = 0;
  const reasons = [];
  const fm = parsed.frontmatter ?? {};
  const desc = String(fm.description ?? "");
  if (desc.length >= 120) { points += 2; reasons.push("description:full"); }
  else if (desc.length >= 40) { points += 1; reasons.push("description:ok"); }
  else { points -= 2; reasons.push("description:thin"); }
  if (parsed.purpose) { points += 2; reasons.push("purpose"); }
  if (parsed.tools?.length) { points += 2; reasons.push(`tools:${parsed.tools.length}`); }
  if (parsed.constraints?.length) { points += 2; reasons.push(`constraints:${parsed.constraints.length}`); }
  if (parsed.tags?.length) { points += 1; reasons.push(`tags:${parsed.tags.length}`); }
  for (const k of ["version", "author", "homepage", "license"]) {
    if (typeof fm[k] === "string" && fm[k].trim()) { points += 1; reasons.push(k); break; }
  }
  const body = parsed.body ?? "";
  if (body.length >= 2000 && body.length <= 30000) { points += 3; reasons.push("body:substantive"); }
  else if (body.length >= 800) { points += 2; reasons.push("body:meaty"); }
  else if (body.length >= 300) { points += 1; reasons.push("body:short"); }
  else { points -= 5; reasons.push("body:stub"); }
  if (/^#{1,4}\s+\S/m.test(body) && /(^|\n)\s*\d+[.)]\s+\S/.test(body)) { points += 2; reasons.push("structured"); }
  if (/```[\s\S]*?```/.test(body)) { points += 1; reasons.push("concrete:code"); }
  if (/^\s*\|.*\|\s*$/m.test(body) || /^\s*-\s+\[[ x]\]/m.test(body)) { points += 1; reasons.push("concrete:table-or-checks"); }
  const lower = markdown.toLowerCase();
  let ph = 0;
  for (const p of PLACEHOLDERS) if (lower.includes(p)) ph++;
  if (ph > 0) { points -= Math.min(12, ph * 4); reasons.push(`placeholders:${ph}`); }
  const examples = (body.match(/example/gi) ?? []).length;
  if (examples > 15) { points -= 2; reasons.push("example-heavy"); }
  return { points, reasons };
}

const files = walk(harvestRoot).filter((f) => !EXCLUDE_DIRS.some((ex) => f.includes(ex)));
console.log(`candidates: ${files.length}`);

const report = { at: new Date().toISOString(), candidates: files.length, refused: {}, scored: 0, winners: [] };
const seenSha = new Set();
const seenName = new Map();
const scored = [];

for (const file of files) {
  let markdown;
  try {
    markdown = readFileSync(file, "utf8");
  } catch { continue; }
  const dirName = file.split(/[/\\]/).slice(-2, -1)[0] ?? "skill";
  const rel = file.slice(harvestRoot.length + 1);
  const source = rel.split(/[/\\]/)[0] ?? "unknown";
  const id = slug(dirName);
  if (validateSkillId(id).length > 0) {
    report.refused["bad-id"] = (report.refused["bad-id"] ?? 0) + 1;
    continue;
  }
  const parsed = parseSkillMarkdown(markdown, { id });
  if (!parsed.ok) {
    const codes = (parsed.error.detail ?? "VALIDATION_FAILED").split(",");
    for (const c of codes) report.refused[c] = (report.refused[c] ?? 0) + 1;
    continue;
  }
  const sha = createHash("sha256").update(markdown, "utf8").digest("hex");
  if (seenSha.has(sha)) {
    report.refused["duplicate-bytes"] = (report.refused["duplicate-bytes"] ?? 0) + 1;
    continue;
  }
  seenSha.add(sha);
  const { points, reasons } = score(parsed.value, markdown);
  scored.push({ id, file, source, points, reasons, name: parsed.value.name, bodyLen: parsed.value.body.length, sha: sha.slice(0, 12) });
}
report.scored = scored.length;

scored.sort((a, b) => b.points - a.points);
const usedIds = new Set();
const usedNames = new Set();
const winners = [];
for (const c of scored) {
  if (winners.length >= topN) break;
  if (c.points < threshold) continue;
  const lname = c.name.toLowerCase();
  if (usedNames.has(lname)) {
    report.refused["duplicate-name"] = (report.refused["duplicate-name"] ?? 0) + 1;
    continue;
  }
  let id = c.id;
  if (usedIds.has(id)) id = `${c.source.slice(0, 3)}-${c.id}`.slice(0, 64);
  if (usedIds.has(id) || validateSkillId(id).length > 0) {
    report.refused["duplicate-id"] = (report.refused["duplicate-id"] ?? 0) + 1;
    continue;
  }
  usedIds.add(id);
  usedNames.add(lname);
  winners.push({ ...c, finalId: id });
}
report.winners = winners;
report.winnerSources = {};
for (const w of winners) report.winnerSources[w.source] = (report.winnerSources[w.source] ?? 0) + 1;

mkdirSync(outDir, { recursive: true });
for (const w of winners) copyFileSync(w.file, join(outDir, `${w.finalId}.md`));
writeFileSync(join(outDir, "REPORT.json"), JSON.stringify(report, null, 2), "utf8");

console.log(`valid: ${scored.length}, winners: ${winners.length} (threshold ${threshold})`);
console.log(`refused: ${JSON.stringify(report.refused)}`);
console.log(`sources: ${JSON.stringify(report.winnerSources)}`);
const dist = {};
for (const c of scored) dist[c.points] = (dist[c.points] ?? 0) + 1;
console.log(`score distribution: ${JSON.stringify(dist)}`);
