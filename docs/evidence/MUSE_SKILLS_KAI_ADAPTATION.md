# Muse skills → KAI adaptation report

## 1. Repository identity

- URL: https://github.com/win4r/MuseAI-Skills
- Self-description: unofficial Muse/Hatch runtime snapshot, NOT a complete
  source repository or official release.
- Method: `git clone --filter=blob:none --no-checkout` + sparse checkout of
  `opt/hatch/skills`, `home/hatch/docs`, configs, manifests, evals (~2 MB
  working tree; ~2 GB of binaries never touched).
- Full inventory: `docs/evidence/MUSE_SKILLS_AUDIT.md` (68 distinct SKILL.md
  + 4 symlink aliases, 12 eval dirs, 40 manifest paths).

## 2. Provenance/licensing caveat

One NOTICE.md (logo assets only). Zero per-skill LICENSE files, zero
frontmatter license/author fields, no repository-wide license. Upstream
README: partial, unofficial, unverified. **Every skill = UNCLEAR
provenance.** Consequence, enforced throughout: NOTHING copied verbatim.
All adaptations are independently implemented in KAI's voice for KAI's
runtime. Wording where provenance is unclear: "Adapted workflow inspired by
MuseAI-Skills" — never "official Muse skill".

## 3. 68-skill inventory

See `MUSE_SKILLS_AUDIT.md` for the per-skill table (path, name, purpose,
triggers, inputs/outputs, tools, permissions, dependencies, references,
manifests, evals, license, KAI compatibility, adaptation status).

## 4. Skill categories

Connectors (Google/Outlook/Gmail/calendar/contacts/docs/drive/sheets/slides/
tasks, travel, social, shopping, media, devices), artifact builders
(document/pdf/presentation/spreadsheet/testing/image), research
(wide-research), authoring (skill-creator), memory (goals, forget),
planning (travel-planning, magic-moment), platform (self-awareness,
muse_db, subscription, feedback, device-data).

## 5. Existing KAI overlap

Compared against KAI's 259 library + 4 original builtins:
- NEW (no equivalent): 50 — mostly connectors.
- NONE (not skills in KAI's sense): 7.
- OVERLAP-KEEP-KAI: 3 (artifacts/markdown, granola, self-awareness) —
  KAI's versions or runtime already cover them.
- OVERLAP-UPGRADE-KAI: 8 (wide-research, skill-creator,
  artifacts/{document,pdf,presentation,spreadsheet,testing}, image-search).

## 6. Selected adaptations

1 upgraded + 7 new, all KAI-authored in `core/src/skills/builtin.ts`
(source `builtin`):
- `deep-research` v2.0.0 (UPGRADE): parallel lines, shared schema,
  coverage ledger, retry-once-then-record, synthesis with cited inputs,
  deliverable verification.
- `skill-creator` (NEW): KAI schema authoring, trigger wording, reference
  splitting, validator limits.
- `artifact-verification` (NEW): GENERATE→VALIDATE→RENDER→INSPECT→VERIFY→
  DELIVER gate, 3-attempt cap, complements builders.
- `goal-tracking` (NEW): intake-once vs ongoing support across memory,
  missions, session tasks.
- `memory-forgetting` (NEW): six-store inventory, exact bounds, explicit
  confirmation, fresh-read verification; never promises full erasure.
- `travel-planning` (NEW): planning vs booking split, smallest-useful-brief,
  live-availability recheck, approval-gated transactions.
- `connector-workflow` (NEW): dormant-capability rule (catalogue →
  credentials/scopes → approvals → execution), exact missing-item reports.
- `execution-trace` (NEW): bounded read-only post-mortem over task record,
  turns+tools, approvals, agent runs, errors, final state.

## 7. Rejected skills

- Connector skills (36): no corresponding KAI tool/MCP/credential — installing
  them would make claims KAI cannot execute. Covered dormantly by
  `connector-workflow` instead.
- Platform/meta (8): device-data, muse-early-access, muse-feedback, muse_db,
  plaid, subscription-status, voice-selector, wearables-comms — external
  dependencies or non-transferable product surface. (`muse_db`'s IDEA
  survives as KAI's read-only `execution-trace`.)
- Duplicates of KAI strengths (3): kept KAI's versions.
- places-research, booking-safety, magic-moment pipeline, structured-research,
  deliverable-verification, skill-share mechanics: FOLDED into the shipped
  skills (travel-planning, artifact-verification, deep-research), not shipped
  separately — quality over quantity.

## 8. Licensing decisions

No verbatim copies (unclear provenance). All shipped skills are KAI-authored
(`license: MIT`, `author` implied KAI via `builtin` source). Per-skill
inspiration noted here, not in the skill files (which must stay operational,
not historical).

## 9. KAI implementations

`core/src/skills/builtin.ts`: 12 builtins total (4 original + 1 upgrade +
7 new). Every entry passes `parseSkillMarkdown`; tool ids restricted to
real KAI registry ids; policy chain stated in every file
(declaration→policy→approval→execution).

## 10. Tests

- `skills-builtin.test.ts`: all 12 builtins validate; `@<id>` resolves and
  loads each; bodies carry OUTPUT CONTRACT + VERIFICATION; `relevant()`
  finds artifact-verification and execution-trace by trigger wording.
- Full suites green (below).

## 11. Runtime integrations

Seeded idempotently at boot (present ids win); listed with source `builtin`;
resolvable via `@skill`; loaded via `skills.load`; selected via
`skills.relevant`; enabled/disabled via existing lifecycle; skill tools
pass the unchanged policy boundary.

## 12. Future candidates

If KAI gains connectors: gmail/calendar/drive adapter skills built on the
`connector-workflow` pattern (dormant until live). If artifact rendering
grows: per-format validators (PDF geometry, spreadsheet recalc) as now
described inside `artifact-verification`'s method. No further imports
planned — the pack is complete.
