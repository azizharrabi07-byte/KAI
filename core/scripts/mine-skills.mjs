// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Skill mining: turn an external Claude-skill repository into KAI skills.
 *
 * ## Why a converter is needed at all
 *
 * KAI's library rule is "byte-identical copies that already pass
 * `parseSkillMarkdown`". That rule is right, and it does not work on the ECC
 * corpus: measured over all 311 skills, only **20 pass unchanged**. 242 are
 * refused for one reason — a nested `metadata:` block (`origin: ECC`) that KAI's
 * flat frontmatter parser rejects, plus quoted `version: "1.0.0"`.
 *
 * So this miner does the smallest possible transformation and says so:
 *
 *   - it rewrites ONLY the frontmatter block;
 *   - the BODY is copied byte-for-byte;
 *   - the dropped `metadata` is not lost — it becomes a provenance banner at the
 *     top of the body and a row in `SOURCES.md`;
 *   - every result must still pass KAI's own `parseSkillMarkdown` AND the
 *     default-ON security scan. A skill that fails either is REFUSED, never
 *     shipped.
 *
 * ## The tool-name trap
 *
 * ECC declares `tools: Read, Write, Edit, Bash, Grep, Glob` — Claude's tool
 * names. KAI's tools are dotted ids (`filesystem.read`, `shell.run`). Copying
 * those names verbatim would make every mined skill permanently INELIGIBLE,
 * because a skill that requires a tool KAI does not have is not offered. So the
 * miner MAPS what maps, and records what does not, rather than inventing an
 * equivalence.
 *
 * Usage:
 *   node scripts/mine-skills.mjs <eccRoot> [--dry]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseSkillMarkdown } from "../src/skills/validate.ts";
import { isReferenceOnly, scanSkill } from "../src/skills/scan.ts";

const here = dirname(fileURLToPath(import.meta.url));
const libraryDir = resolve(here, "..", "skills-library");

/** The upstream this miner reads. Pinned in SOURCES.md by commit. */
export const ECC_SOURCE = {
  name: "affaan-m/ECC",
  url: "https://github.com/affaan-m/ECC",
  licence: "MIT",
  commit: "b92f181b3b748d1abbc2afd94af6aa7d8c8fca29",
};

/**
 * Claude tool name → KAI tool id.
 *
 * Only names with a real counterpart are listed. `WebSearch`/`WebFetch` are
 * deliberately ABSENT: KAI has no web tool, and pretending otherwise would make
 * a skill look runnable when it is not.
 */
const TOOL_MAP = {
  read: "filesystem.read",
  write: "filesystem.write",
  edit: "filesystem.write",
  multiedit: "filesystem.write",
  notebookedit: "filesystem.write",
  bash: "shell.run",
  bashoutput: "shell.run",
  grep: "filesystem.search",
  glob: "filesystem.list",
  ls: "filesystem.list",
  task: "agents.run_task",
};

/**
 * The curated selection: only the ECC objects that match KAI's OWN job.
 *
 * KAI is not a code-review tool — it is an agent SUPERVISOR that plans, guards,
 * dispatches, verifies and accounts. So the picks are the ones about being a
 * harness, auditing agents, holding a gate, bounding a loop, and mining skills.
 * The 40-odd language reviewers (`go-reviewer`, `vue-reviewer`, …) are left
 * behind on purpose: they are work KAI DELEGATES, not work KAI does.
 */
const SELECTION = [
  ["gateguard", "the approval gate KAI owns"],
  ["safety-guard", "the boundary KAI must not cross"],
  ["operator-approval-loop", "parking on a human, and resuming exactly once"],
  ["agent-harness-construction", "building the harness KAI IS"],
  ["agent-architecture-audit", "auditing an agent setup"],
  ["agent-introspection-debugging", "debugging an agent that misbehaves"],
  ["agent-self-evaluation", "honest self-assessment"],
  ["agent-eval", "measuring agents instead of guessing"],
  ["agent-security-hardening", "hardening an agent boundary"],
  ["eval-harness", "an evaluation harness"],
  ["verification-loop", "verify, then act"],
  ["production-audit", "what is actually running"],
  ["test-collaboration", "working with tests, not around them"],
  ["autonomous-loops", "running a loop without losing control"],
  ["loop-design-check", "checking a loop before trusting it"],
  ["context-budget", "bounded context"],
  ["token-budget-advisor", "bounded spend"],
  ["cost-tracking", "tracking cost honestly"],
  ["unified-memory", "one memory, not several"],
  ["iterative-retrieval", "retrieval that converges"],
  ["plan-orchestrate", "planning and orchestration"],
  ["team-agent-orchestration", "coordinating several agents"],
  ["prompt-optimizer", "better prompts, measurably"],
  ["skill-stocktake", "taking stock of a skill library"],
  ["skill-scout", "finding skills worth having"],
  ["skill-host-compat", "whether a skill fits this host"],
  ["skill-comply", "whether a skill follows the rules"],
];

/** Parse a flat YAML frontmatter block. Only the shapes ECC actually uses. */
function parseFrontmatter(markdown) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(markdown);
  if (match === null) return null;
  const raw = match[1];
  const body = markdown.slice(match[0].length);
  const fields = {};
  const nested = {};
  let current = null;
  for (const line of raw.split(/\r?\n/)) {
    const indented = /^\s+\S/.test(line);
    if (indented && current !== null) {
      const m = /^\s+([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
      if (m !== null) nested[`${current}.${m[1]}`] = m[2].trim();
      continue;
    }
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (m === null) continue;
    current = m[1];
    fields[m[1]] = m[2].trim();
  }
  return { fields, nested, body };
}

/** Strip one layer of quotes from a scalar. */
function unquote(value) {
  if (value === undefined) return undefined;
  const v = value.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

function mineOne(id, why, eccRoot) {
  const file = join(eccRoot, "skills", id, "SKILL.md");
  if (!existsSync(file)) return { id, ok: false, reason: "no SKILL.md upstream" };
  const source = readFileSync(file, "utf8");
  const parsed = parseFrontmatter(source);
  if (parsed === null) return { id, ok: false, reason: "no frontmatter" };

  const name = unquote(parsed.fields.name) ?? id;
  const description = unquote(parsed.fields.description) ?? "";
  const licence = unquote(parsed.fields.license);
  const version = unquote(parsed.fields.version);
  const origin = unquote(parsed.nested["metadata.origin"]) ?? "ECC";

  // Tools: map what has a KAI counterpart, RECORD what does not.
  const declared = (unquote(parsed.fields.tools) ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  const mapped = [];
  const unmapped = [];
  for (const tool of declared) {
    const kai = TOOL_MAP[tool.toLowerCase()];
    if (kai !== undefined) mapped.push(kai);
    else unmapped.push(tool);
  }
  const tools = [...new Set(mapped)];

  // The banner is how provenance survives the dropped `metadata` block.
  const banner = [
    "<!-- MINED SKILL — provenance, kept in the body because KAI's frontmatter",
    "     contract has no `metadata` key. The body below this banner is byte-",
    "     identical to upstream; only the frontmatter was normalised. -->",
    `Source: ${ECC_SOURCE.name} (${ECC_SOURCE.url}) @ ${ECC_SOURCE.commit.slice(0, 12)}`,
    `Upstream path: skills/${id}/SKILL.md`,
    `Upstream licence: ${licence ?? ECC_SOURCE.licence} · origin: ${origin}`,
    `Selected because: ${why}`,
    unmapped.length > 0
      ? `Tools with NO KAI equivalent (recorded, not silently dropped): ${unmapped.join(", ")}`
      : "Tools: all declared tools map to a KAI tool id.",
    "",
  ].join("\n");

  const front = [
    "---",
    `name: ${name}`,
    `description: ${description.replace(/\s+/g, " ").trim()}`,
    ...(licence !== undefined ? [`license: ${licence}`] : []),
    ...(version !== undefined ? [`version: ${version}`] : []),
    `author: ${origin}`,
    `homepage: ${ECC_SOURCE.url}`,
    ...(tools.length > 0 ? [`tools: ${tools.join(", ")}`] : []),
    "tags: mined, ecc",
    "---",
    "",
  ].join("\n");

  const markdown = `${front}${banner}${parsed.body}`;

  // The two gates that matter: KAI's own validator, then KAI's own scanner.
  const validated = parseSkillMarkdown(markdown, { id });
  if (!validated.ok) {
    const first = validated.issues[0];
    return { id, ok: false, reason: `validation: ${first ? `${first.code} ${first.message}` : "unknown"}` };
  }
  const verdict = scanSkill({ id, markdown });
  // CLEAN is accepted. A WARNING is accepted ONLY when every finding is a
  // named pattern — a security skill must list what it detects — and the fact
  // that curation made that call is written into the banner, never hidden.
  const referenceOnly = verdict.outcome === "WARNING" && isReferenceOnly(verdict);
  if (verdict.outcome !== "CLEAN" && !referenceOnly) {
    return { id, ok: false, reason: `scan ${verdict.outcome}: ${verdict.reason}` };
  }
  const scanNote = referenceOnly
    ? `Scan: WARNING, reference-only (${verdict.findings.map((f) => f.code).join(", ")}) — curation accepted it because every match names a pattern to detect.`
    : "Scan: CLEAN.";
  const withScan = markdown.replace("Tools:", `${scanNote}\nTools:`);
  return { id, ok: true, markdown: withScan, tools, unmapped, origin, licence, scanNote };
}

function main() {
  const eccRoot = process.argv[2];
  const dry = process.argv.includes("--dry");
  if (eccRoot === undefined) {
    console.error("usage: node scripts/mine-skills.mjs <eccRoot> [--dry]");
    process.exit(2);
  }
  if (!dry) mkdirSync(libraryDir, { recursive: true });

  const written = [];
  const refused = [];
  for (const [id, why] of SELECTION) {
    const result = mineOne(id, why, eccRoot);
    if (!result.ok) {
      refused.push(result);
      continue;
    }
    if (!dry) writeFileSync(join(libraryDir, `${id}.md`), result.markdown, "utf8");
    written.push(result);
  }

  console.log(`mined ${written.length} of ${SELECTION.length} selected skills${dry ? " (dry run)" : ""}`);
  for (const w of written) {
    const notes = [];
    if (w.unmapped.length > 0) notes.push(`unmapped tools: ${w.unmapped.join(", ")}`);
    if (w.scanNote !== "Scan: CLEAN.") notes.push("reference-only warning");
    console.log(`  + ${w.id}${notes.length > 0 ? `  [${notes.join("; ")}]` : ""}`);
  }
  if (refused.length > 0) {
    console.log(`\nREFUSED ${refused.length} — a mined skill that fails a gate is never shipped:`);
    for (const r of refused) console.log(`  - ${r.id}: ${r.reason}`);
  }
  if (written.length > 0) {
    const withUnmapped = written.filter((w) => w.unmapped.length > 0).length;
    console.log(`\n${withUnmapped} of ${written.length} carry tools with no KAI equivalent (recorded in the body banner).`);
  }
}

if (process.argv[1] !== undefined && process.argv[1].endsWith("mine-skills.mjs")) main();
