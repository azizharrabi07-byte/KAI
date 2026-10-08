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
