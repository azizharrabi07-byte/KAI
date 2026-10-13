// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Agent mining: turn an external agent corpus into KAI personas.
 *
 * ## The two shapes do not line up
 *
 * An ECC agent is a markdown file with a frontmatter header and one long prompt
 * body. A KAI persona is a `KaiSubagentSpec`, and it is stricter in one place
 * that matters: `instructions` is capped at **4000 characters**, while the ECC
 * bodies run past 9 000. A naive copy would be refused outright.
 *
 * So the miner truncates at a SECTION BOUNDARY (never mid-sentence), and writes
 * what it dropped into the persona's `description` so a reader can see that the
 * persona is a distilled form rather than the whole upstream prompt. Silent
 * truncation would be the worst of the three options.
 *
 * ## What is NOT copied
 *
 * `model: sonnet` is an Anthropic model name. KAI's workers take their own
 * models, so the field is dropped rather than carried across as a claim KAI
 * cannot honour. `tools:` is recorded in the persona description, not asserted
 * as a capability, because a persona's authority comes from the registry
 * boundary — never from the prompt.
 *
 * Usage:
 *   node scripts/mine-agents.mjs <eccRoot> [--dry]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validateSubagentSpec } from "../src/workforce/subagent.ts";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "..", "agents-library");

const ECC_COMMIT = "b92f181b3b748d1abbc2afd94af6aa7d8c8fca29";
/** KAI's registered worker. A persona with no real worker cannot run. */
const WORKER_ID = "hermes";

/** The instructions ceiling, from `validateSubagentSpec`. */
const INSTRUCTION_LIMIT = 4000;

/**
 * Only the agents that match KAI's OWN job — supervising, verifying, planning
 * and mining. The 40-odd language reviewers are left behind: that is work KAI
 * delegates to a worker, not work KAI does itself.
 */
const SELECTION = [
  ["agent-evaluator", "evaluates agent output against a rubric — KAI's own job"],
  ["silent-failure-hunter", "hunts the failures that leave no trace — KAI's honesty rule"],
  ["harness-optimizer", "optimises an agent harness; KAI is one"],
  ["spec-miner", "mines a specification out of a codebase"],
  ["planner", "turns an intent into a plan"],
  ["architect", "decides structure before code"],
  ["chief-of-staff", "coordinates work across agents"],
  ["code-explorer", "maps a codebase it has never seen"],
  ["tdd-guide", "enforces verify-before-claim"],
  ["security-reviewer", "the Guard perspective"],
  ["loop-operator", "runs a loop without losing control of it"],
  ["pr-test-analyzer", "judges whether tests actually cover a change"],
  ["code-simplifier", "removes weight without changing behaviour"],
  ["type-design-analyzer", "judges whether a contract can be violated"],
  ["opensource-sanitizer", "strips private material before publication"],
  ["performance-optimizer", "measures before it optimises"],
];

function parseFrontmatter(markdown) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(markdown);
  if (match === null) return null;
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (m !== null) fields[m[1]] = m[2].trim();
  }
  return { fields, body: markdown.slice(match[0].length) };
}

/** Strip a leading "Prompt Defense Baseline" block: KAI enforces that OUTSIDE the prompt. */
function stripDefenseBaseline(body) {
  const heading = /^#{1,3}\s*Prompt Defense Baseline\s*$/m.exec(body);
  if (heading === null || heading.index === undefined) return body;
  const after = body.slice(heading.index + heading[0].length);
  const nextHeading = /\n#{1,3}\s+\S/.exec(after);
  if (nextHeading === null || nextHeading.index === undefined) return body;
  return `${body.slice(0, heading.index)}${after.slice(nextHeading.index + 1)}`.trim();
}

/**
 * Cut at a section boundary under the limit. Returns the text and whether it was
 * cut, so the caller can SAY so rather than pretend the persona is complete.
 */
function truncateAtSection(text, limit) {
  if (text.length <= limit) return { text, truncated: false };
  const slice = text.slice(0, limit);
  // Prefer the last heading that still leaves a useful body.
  const lastHeading = slice.lastIndexOf("\n## ");
  if (lastHeading > limit * 0.4) return { text: slice.slice(0, lastHeading).trim(), truncated: true };
  // Otherwise the last paragraph break.
  const lastBreak = slice.lastIndexOf("\n\n");
  if (lastBreak > limit * 0.5) return { text: slice.slice(0, lastBreak).trim(), truncated: true };
  return { text: slice.trim(), truncated: true };
}

function prettify(id) {
  return id
    .split("-")
    .map((part) => (part.length === 0 ? part : part[0].toUpperCase() + part.slice(1)))
    .join(" ");
}

function firstSentence(text) {
  const cut = /^(.{20,160}?[.!?])\s/.exec(text);
  return cut !== null ? cut[1] : text.slice(0, 160);
}

function mineOne(id, why, eccRoot) {
  const file = join(eccRoot, "agents", `${id}.md`);
  if (!existsSync(file)) return { id, ok: false, reason: "no agent file upstream" };
  const parsed = parseFrontmatter(readFileSync(file, "utf8"));
  if (parsed === null) return { id, ok: false, reason: "no frontmatter" };

  const description = (parsed.fields.description ?? "").replace(/\s+/g, " ").trim();
  const tools = (parsed.fields.tools ?? "").replace(/\s+/g, " ").trim();
  const body = stripDefenseBaseline(parsed.body);
  const { text: instructions, truncated } = truncateAtSection(body, INSTRUCTION_LIMIT);

  // KAI's own voice, not the upstream persona's. The persona is KAI's, and it
  // inherits KAI's honesty rule rather than inventing a personality of its own.
  const soul = [
    `I am ${prettify(id)}, one of KAI's own specialists.`,
    "I do my one job and I say plainly what I could not do.",
    "I never claim something worked without checking it.",
    "I am a worker inside KAI: I do not approve my own work, and I do not widen my own authority.",
  ].join(" ");

  const spec = {
    id,
    name: prettify(id),
    role: firstSentence(description),
    soul,
    workerId: WORKER_ID,
    // ORDER MATTERS: the description is capped at 500 characters, so the clauses
    // that must SURVIVE truncation go first. The authority disclaimer is not
    // decoration — it is the statement that this text cannot widen the persona's
    // scope — and putting it last let a long upstream description cut it away.
    description: [
      "Mined from affaan-m/ECC; authority comes from KAI's registry and Guard, never from this text.",
      truncated ? `Upstream instructions cut at a section boundary to KAI's ${INSTRUCTION_LIMIT}-char limit.` : "Instructions complete.",
      `@ ${ECC_COMMIT.slice(0, 12)} — ${why}.`,
      tools.length > 0 ? `Upstream tools (advisory): ${tools}.` : "",
      description,
    ]
      .filter((line) => line.length > 0)
      .join(" ")
      .slice(0, 500),
    objective: `Do ${prettify(id)}'s job when KAI asks for it: ${firstSentence(description)}`.slice(0, 2000),
    instructions,
  };

  const validated = validateSubagentSpec(spec);
  if (!validated.ok) return { id, ok: false, reason: `validation: ${validated.reason}` };
  return { id, ok: true, spec: validated.value, truncated };
}

function main() {
  const eccRoot = process.argv[2];
  const dry = process.argv.includes("--dry");
  if (eccRoot === undefined) {
    console.error("usage: node scripts/mine-agents.mjs <eccRoot> [--dry]");
    process.exit(2);
  }
  if (!dry) mkdirSync(outDir, { recursive: true });

  const written = [];
  const refused = [];
  for (const [id, why] of SELECTION) {
    const result = mineOne(id, why, eccRoot);
    if (!result.ok) {
      refused.push(result);
      continue;
    }
    if (!dry) writeFileSync(join(outDir, `${id}.json`), `${JSON.stringify(result.spec, null, 2)}\n`, "utf8");
    written.push(result);
  }

  console.log(`mined ${written.length} of ${SELECTION.length} agents${dry ? " (dry run)" : ""}`);
  for (const w of written) console.log(`  + ${w.id}${w.truncated ? "  [instructions truncated at a section boundary]" : ""}`);
  if (refused.length > 0) {
    console.log(`\nREFUSED ${refused.length} — a persona that fails validation is never shipped:`);
    for (const r of refused) console.log(`  - ${r.id}: ${r.reason}`);
  }
}

if (process.argv[1] !== undefined && process.argv[1].endsWith("mine-agents.mjs")) main();
