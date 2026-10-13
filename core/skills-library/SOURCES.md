# KAI skill library — sources & curation

Curated 2026-10-06 by `core/scripts/curate-skills.mjs`. Every file here is a
byte-identical copy of its upstream SKILL.md (no edits, no rewrites), kept only
if it passed KAI's own `parseSkillMarkdown` validation AND the quality bar
below. Attribution lives in each file's frontmatter (`author`/`homepage`/
`license`/`version` where upstream provided it).

## Sources (all licenses permit redistribution)

| Source | URL | License | Used |
|---|---|---|---|
| wshobson/agents | https://github.com/wshobson/agents | MIT | 173 |
| 10xequity/claude-skill-library | https://github.com/10xequity/claude-skill-library | MIT | 27 |
| composio-awesome (ComposioHQ/awesome-claude-skills) | https://github.com/ComposioHQ/awesome-claude-skills | Apache-2.0 | 15 |
| anthropics/skills | https://github.com/anthropics/skills | Apache-2.0 (most skills) | 13 |
| 64x-lunicorn/skills | https://github.com/64x-lunicorn/skills | MIT | 16 |
| superpowers (obra/superpowers) | https://github.com/obra/superpowers | MIT | 9 |
| thrunt-god (3dcom2711/thrunt-god) | https://github.com/3dcom2711/thrunt-god | MIT | 2 |

Total: **255 skills** from **7 sources** (jobs covered: research, review,
planning, git, testing, debugging, writing, docs, data, security, DevOps,
design, mobile, web, AI/ML, business, plus KAI's own 4 builtins seeded
separately with source `builtin`).

Excluded for licensing (no license statement found — content quality was
high, but redistribution without one is unsafe): all 13 `1989v/ai` and all 4
`10CG/aria-plugin` winners.

## Excluded, deliberately

- **Anthropic's 4 source-available document skills** (`docx`/`pdf`/`pptx`/`xlsx`):
  reference-only, not open-licensed — not redistributed.
- **Composio `requires: mcp: [rube]` automation skills** (~375): KAI's validator
  rightly refuses nested frontmatter, and the procedure needs Composio's Rube
  MCP, which KAI does not have. Form AND substance say no.
- **dm-claude-mods (117 files)**: `allowed-tools` + nested `metadata:` keys are
  refused by KAI's validator. Refusing is correct — a foreign tool grant must
  never be silently honored or silently ignored.
- **4 mechanism-dependent winners** dropped on review (`connect`,
  `connect-apps`, `developer-growth-analysis`, `skill-share`): well-written but
  their procedure IS a third-party service (Composio/Rube). Useless in KAI.
- **Validator refusals**: download-and-execute shapes (4), encoded payloads (2),
  missing name/description, oversized, invisible-unicode — all dropped unseen.
- **Duplicates**: identical bytes (19) and identical names (4) collapsed.

## The quality bar ("excellent" only)

Hard gate: KAI validation passes. Then scored: full description (+), purpose /
tools / constraints metadata (+), substantive body 800–30000 chars (+),
headers + numbered steps (+), code fences / tables / checklists (+),
authorship metadata (+). Penalties: placeholders (TODO/TBD/lorem/coming soon),
example-stuffing, stub bodies. Cut at score ≥ 4. Red-flag scan over all
winners (prompt-injection, exfiltration, destructive commands): 3 hits, all
benign in context (scoped git config, ticket clarity, honoring declared
preferences). Skill bodies are served to the model as DATA, never
instructions (see `prompts/compose.ts`).

## Mined pack — ECC (affaan-m/ECC)

Curated 2026-10-12 by `core/scripts/mine-skills.mjs`. **These files are NOT
byte-identical to upstream**, and that is deliberate: the byte-identical rule
requires the upstream to pass KAI's own `parseSkillMarkdown` unchanged, and over
all 311 ECC skills only **20 do**. 242 are refused for one reason — a nested
`metadata:` block (`origin: ECC`) that KAI's flat frontmatter parser rejects.

So the miner normalises the FRONTMATTER ONLY and copies the BODY byte-for-byte.
What it changes, and why, is stated here rather than left implicit:

- `metadata: { origin }` is dropped, because KAI's frontmatter contract has no
  such key. The value is **not lost**: it becomes a provenance banner at the top
  of each body, an `author:` field, and the row below.
- Quoted scalars are unquoted (`version: "1.0.0"` → `version: 1.0.0`).
- Claude tool names are MAPPED to KAI ids (`Read` → `filesystem.read`,
  `Bash` → `shell.run`, `Grep` → `filesystem.search`, `Glob` → `filesystem.list`,
  `Task` → `agents.run_task`). A name with no KAI counterpart is **recorded in the
  banner**, never silently dropped — copying `WebSearch` verbatim would have made
  the skill permanently ineligible, because KAI has no web tool.
- Every result must still pass KAI's `parseSkillMarkdown` AND the default-ON
  security scan. A skill that fails either is REFUSED, not shipped.

Three of the 27 carry a **reference-only WARNING** (`gateguard`, `safety-guard`,
`verification-loop`): their findings are patterns NAMED for detection — a
security skill must list what it blocks — so the scanner downgrades them from
refusal to a visible warning, and curation accepted them on that basis.

| Source | URL | Licence | Commit | Used |
|---|---|---|---|---|
| affaan-m/ECC | https://github.com/affaan-m/ECC | MIT | `b92f181b` | 27 |

**Selection rule:** only the objects matching KAI's OWN job — being an agent
harness, auditing agents, holding an approval gate, bounding a loop, and mining
skills. The 40-odd language reviewers (`go-reviewer`, `vue-reviewer`, …) are
deliberately excluded: that is work KAI DELEGATES, not work KAI does.

| Skill | Why it is here |
|---|---|
| gateguard | the approval gate KAI owns |
| safety-guard | the boundary KAI must not cross |
| operator-approval-loop | parking on a human, and resuming exactly once |
| agent-harness-construction | building the harness KAI IS |
| agent-architecture-audit | auditing an agent setup |
| agent-introspection-debugging | debugging an agent that misbehaves |
| agent-self-evaluation | honest self-assessment |
| agent-eval | measuring agents instead of guessing |
| agent-security-hardening | hardening an agent boundary |
| eval-harness | an evaluation harness |
| verification-loop | verify, then act |
| production-audit | what is actually running |
| test-collaboration | working with tests, not around them |
| autonomous-loops | running a loop without losing control |
| loop-design-check | checking a loop before trusting it |
| context-budget | bounded context |
| token-budget-advisor | bounded spend |
| cost-tracking | tracking cost honestly |
| unified-memory | one memory, not several |
| iterative-retrieval | retrieval that converges |
| plan-orchestrate | planning and orchestration |
| team-agent-orchestration | coordinating several agents |
| prompt-optimizer | better prompts, measurably |
| skill-stocktake | taking stock of a skill library |
| skill-scout | finding skills worth having |
| skill-host-compat | whether a skill fits this host |
| skill-comply | whether a skill follows the rules |
