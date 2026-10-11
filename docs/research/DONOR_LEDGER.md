# Donor Ledger

Every candidate KAI has investigated, with the evidence behind each row.

**Method note (honest, unchanged):** the plan called for six independent lanes. **The
subagent mechanism is unavailable** — every spawned lane dies on the retired
`nvidia/z-ai/glm-5.2` child model (HTTP 410), and the session-only override that fixes
it needs the user's approval, which was not granted. So the six lenses below are ONE
reviewer's findings, labelled as such, not six independent opinions. Where a lens
needed evidence I could not obtain, it says so.

**REA's contribution:** REA was installed, pinned (6.4.0, MIT), registered with OMP and
verified working. It contributed **nothing to these reviews**, and that is the correct
outcome: every candidate here is an open-source repository whose complete source is
available, and the REA skill itself says to read the source first. REA's providers for
native/managed/APK work (Ghidra, IDA) are deliberately NOT installed. See
`REA_DONOR_WORKFLOW.md`.

---

## Priority A — Hermes Agent (`NousResearch/hermes-agent`)

- **Identity:** `main` @ **`1fd182772671`** (2026-10-11T20:31:55Z), verified via the
  GitHub commits API.
- **Licence:** **MIT**, "Copyright (c) 2025 Nous Research" (fetched from `LICENSE`).
- **Files inspected:** `agent/prompt_builder.py` (1883 lines),
  `tools/skill_manager_tool.py` (925), `tools/skills_tool.py` (726). All three exist
  on `main` (HTTP 200) — the brief's paths are current.

### The mechanisms, from the source

1. **A compact skills INDEX, not bodies.** `prompt_builder.py:1265`
   `_build_snapshot_entry(skill_file, skills_dir, frontmatter, description)` returns
   `{name, description, platforms[], conditions}`. The prompt carries this index; a body
   is loaded on demand. That is progressive disclosure as a data structure.
2. **Applicability conditions.** `agent/skill_utils.py` provides
   `extract_skill_conditions`, `skill_matches_platform`, `skill_matches_apps`,
   `skill_matches_environment`, and `session_platforms` handling
   (`prompt_builder.py:1297-1302`). A skill is indexed only when it matches the current
   platform/app/environment and the available tools/toolsets — so an inapplicable skill
   is never even offered.
3. **Per-skill mutation locks.** `skill_manager_tool.py:84`
   `_skill_lock_path(name)` puts the lock at `.usage.json.lock` **outside** the skill
   directory, documented as "never inside the skill dir so delete/recreate cannot unlink
   it under a lock". `_skill_mutation_lock` / `_skill_mutation_locks` serialise
   mutations per skill.
4. **Validation on write.** `_validate_name`, `_validate_category`,
   `_validate_frontmatter(content, *, new_skill)` (name + description + non-empty body;
   `new_skill` enforces index-truncation limits while edit/patch skip it so an
   existing over-limit skill stays maintainable), `_validate_content_size`.
5. **Security scanning of agent-created skills.** `_security_scan_skill(skill_dir)` runs
   `scan_skill(skill_dir, source="agent-created")` and blocks a skill with dangerous
   findings. Gated by `skills.guard_agent_created` (default **False** — opt-in).
6. **Guards around destructive operations:** `_pinned_guard` (a pinned skill cannot be
   deleted or overwritten), `_is_path_redirect` (symlink/redirect protection),
   `_validate_delete_target`, `_background_review_read_before_write_guard` (read before
   write), and curator/background-review delete guards.
7. **Memory vs skill, kept distinct.** `build_memory_guidance(memory_enabled,
   profile_enabled, skill_manage_available)` — the source comment states the intent:
   "Keep the every-session memory scope even when task knowledge cannot be saved as a
   skill."

### Six lenses (one reviewer)

| Lens | Finding |
|---|---|
| Technical fit | Closes KAI gap #6. KAI has a skills registry (`core/src/skills/registry.ts`) with metadata/body split and relevance scoring, but **no applicability conditions, no index snapshot, no per-skill lock, no scan of agent-created skills, and no pinned/redirect guards** |
| Backend architecture | KAI's existing owner is the skill registry + `orchestration/learn.ts`. Hermes' mechanisms are *policy around* a registry, not a competing registry — they map onto KAI's existing boundary |
| Reliability | Locks are the strongest evidence here: the lock file is deliberately OUTSIDE the skill dir so delete/recreate cannot unlink it. Validation happens before write |
| Security | `scan_skill(source="agent-created")` + pinned/redirect guards. **Caveat: `skills.guard_agent_created` defaults to False**, so the scan is opt-in upstream — KAI must NOT copy that default |
| Cost/operations | No new dependency: the mechanisms are pure TypeScript-sized ideas (a lock file, a frontmatter validator, an index entry) |
| Licensing/maintainability | MIT; notices required if code is copied. The implementation is Python, so KAI **reimplements natively** rather than porting |

**Verdict: Implement pattern natively** (index + applicability + per-skill lock +
validation-before-write + scan-before-activate + pinned/redirect guards), with the
scan ON by default rather than Hermes' opt-in default.

---

## Priority B — OpenCode (`anomalyco/opencode`)

- **Identity:** branch `dev`; `LICENSE` fetched → **MIT**, "Copyright (c) 2025 opencode".
- **KAI's actual adapter:** `core/src/agents/adapters/opencodeAdapter.ts` + client
  `core/src/agents/opencode.ts`. It implements health/status/message/run_task/cancel_task
  and **does not consume the SSE `GET /event` stream**.
- **Source evidence:** **PENDING.** The event-payload shapes were not verified against
  the source in this pass.
- **Runtime evidence:** the CLI is installed (v1.18.35) but the service is **not
  listening on `:4096`**; live tests skip with that named reason. Per the brief, the
  integration is **not** marked verified while the service is unavailable.
- **Six lenses:** technical fit is real (event-driven progress and result reconciliation);
  the other five are **PENDING** on the same missing source/event evidence.
- **Verdict: Pending** — missing evidence: the `GET /event` payload schema on the
  current `dev` branch, and a running `:4096` service for a live reconciliation test.

---

## Priority C — Coucou (`Louis-CFM/coucou`)

- **Licence:** `LICENSE` → **MIT**, "Copyright (c) 2026 Louis Raillé".
  `LICENSE-ASSETS.md` → "**All rights reserved**, except as stated below" for the name,
  character and artwork.
- **Source evidence:** **PENDING** — the relay/pipe implementation was not read in this
  pass.
- **Binding constraint regardless of findings:** **no asset, name, character, sound or
  icon may be copied.** Mechanisms only.
- **Verdict: Study only** for now. KAI's `KaiEventType` union and
  `shared/runtime-events.ts` already define a canonical vocabulary, so the burden is on
  Coucou to show a mechanism KAI lacks.

---

## Priority D — Pi (`badlogic/pi-mono`)
- **Licence:** **MIT**, "Copyright (c) 2025 Mario Zechner".
- **Verdict: Pending** — the runtime/RPC contract was not verified; do not assume Pi
  supplies subagents, plan approval or a permission architecture because it is extensible.

## Priority E — OpenClaw (`openclaw/openclaw`)
- **Licence:** **MIT**, "Copyright (c) 2026 OpenClaw Foundation".
- **Verdict: Pending** on the loop's specific failure-handling patterns. KAI will not
  import a second agent loop.

## Priority F — OpenHands SDK + Rakazo
- **OpenHands SDK:** **MIT**, "Copyright (c) 2026 OpenHands contributors" (fetched).
- **Rakazo (`vnavani/Grokbot`):** **Apache-2.0** (fetched) — permissive, with NOTICE
  obligations if code is copied.
- **Verdict: Pending** — the workspace/execution-provider separation and the
  computer-runtime contract were not read. The reported warning that shared team folders
  are not a security boundary matches KAI's own conclusion and must be quoted from source
  before it is relied on.

## Priority G — Grok-related projects
| Repo | Licence (fetched) | Note |
|---|---|---|
| `Franzferdinan51/Grok-Build-Desktop-App` | **NONE — no LICENSE/COPYING/NOTICE at the root**; GitHub's licence API returns **404** | There is an `upstream/` directory, so vendored components would need separate checks. **No reuse permitted** until the owner clarifies |
| `OnlyTerp/opengrok` | **MIT**, "Copyright (c) 2026 OnlyTerp" | A model-routing sidecar, not a coding-agent executor |
| `LING71671/open-grokbot` | **GPL-3.0** (confirmed in the file) | Code reuse incompatible with distributing KAI as-is |
| `ishandutta2007/open-grokbot` | not fetched | previously flagged for secrets/CORS/Docker defaults — unresolved |

- **Verdict:** Grok Build Desktop **Reject** (no licence). open·grok **Pending**.
  `LING71671/open-grokbot` **Study only**. `ishandutta2007/open-grokbot` **Pending** and
  must not be a production donor without a separate security audit.

## Priority H — LobeHub (`lobehub/lobehub`)
- **Licence:** `canary/LICENSE` → "**LobeHub Community License** ... All rights reserved."
  (fetched).
- **Verdict: Study only.** Architecture study and code reuse are separate decisions, and
  this licence has not been resolved for distribution.

---

## What would close the PENDING rows

Each row names its missing evidence above. The cheapest next step is a **new OMP session**
(the registered REA tools load there) plus a working `smol` role, which would let the six
lanes run as designed — but the source reading is what produces the findings, and it needs
no subagents.
