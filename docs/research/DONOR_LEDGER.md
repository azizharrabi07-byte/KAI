# Donor Ledger

Every candidate investigated, with the evidence behind each row.

**Method note (honest).** The plan called for six independent lanes. **The subagent
mechanism is unavailable** — every spawned lane dies on the retired child model, and
the session-only override needs the user's approval, which was not granted. So this is
ONE reviewer's sequential source review, labelled as such. It is not six opinions, and
no independent critic's verdict is invented.

**REA's contribution: nothing, correctly.** REA is installed, pinned (6.4.0, MIT),
registered with OMP and verified working. It was not used for these reviews because
every candidate is an open-source repository whose source is available, and the REA
skill itself says to read the source first. REA's native providers are deliberately
NOT installed. See `REA_DONOR_WORKFLOW.md`.

**Licences were fetched from each repository, not taken from its README.**

---

## Priority A — Hermes Agent (`NousResearch/hermes-agent`) — IMPLEMENTED

- **Inspected commit:** `main` @ **`1fd182772671`** (2026-10-11T20:31:55Z).
- **Licence:** MIT, "Copyright (c) 2025 Nous Research".
- **Files read:** `agent/prompt_builder.py` (1883 lines), `agent/skill_utils.py` (866),
  `tools/skill_manager_tool.py` (925), `tools/skills_tool.py` (726).
  (`website/docs/.../skills.md` was rate-limited by GitHub and is NOT relied on.)

### Mechanisms, from the source

| Mechanism | Exact evidence |
|---|---|
| **Platform normalization** | `skill_utils.py:21` `PLATFORM_MAP = {"macos": "darwin", "linux": "linux", "windows": "win32"}`; `skill_matches_platform_list()` maps then prefix-matches `sys.platform`. Absent = all |
| **Environment gate is OFFER-ONLY** | `skill_matches_environment()` — its own comment: "a *relevance* gate for offer surfaces (index, autocomplete, slash commands), not a compatibility gate: an explicit load (`skill_view`, `--skills`) always succeeds". Detection cached per process (`_ENV_DETECT_CACHE`) |
| **App requirements fail CLOSED** | `skill_matches_apps()` — `requires_apps:` resolves through `declaration.lookup` + `availability(decl).offerable`; "An unknown name hides the skill (fail closed)" |
| **Tier precedence + shadowing** | `TIER_PROJECT, TIER_LOCAL, TIER_CREATE_DIR, TIER_EXTERNAL = range(4)`; "Cross-directory precedence, lowest tier wins: trusted project > local profile > skills.create_dir > external". `get_skill_search_roots()` returns `(tier, dir)` in "the ONE ordering". A name owned by a higher tier is marked `shadowed`, `load_name=None`, warned once |
| **Support dirs excluded** | `EXCLUDED_SKILL_DIRS`; `SKILL_SUPPORT_DIRS = ("references", "templates", "assets", "scripts")`; `is_excluded_skill_path()` / `is_skill_support_path()` |
| **Config cache invalidation** | `_RAW_CONFIG_CACHE` keyed by a `(path, mtime, size, ino, …)` tuple from `_config_cache_key()` |
| **Compact index** | `prompt_builder.py:1265` `_build_snapshot_entry()` → `{name, description, platforms[], conditions}`; the body is loaded on demand |
| **Per-skill lock OUTSIDE the dir** | `skill_manager_tool.py:84` `_skill_lock_path()` → `.usage.json.lock`, "never inside the skill dir so delete/recreate cannot unlink it under a lock" |
| **Validate before write** | `_validate_name`, `_validate_category`, `_validate_frontmatter(content, *, new_skill)`, `_validate_content_size` |
| **Scan of agent-created skills** | `_security_scan_skill()` → `scan_skill(dir, source="agent-created")`; gated by `skills.guard_agent_created`, **default False (opt-in)** |
| **Destructive-op guards** | `_pinned_guard`, `_is_path_redirect`, `_validate_delete_target`, `_background_review_read_before_write_guard` |

### What KAI implemented, and where it deliberately differs

**Implemented natively** (KAI's skills are a different subsystem; the implementation is
TypeScript, not a port):

| KAI file | Mechanism |
|---|---|
| `core/src/skills/scan.ts` | The security scan, **default ON with no off switch**. `CLEAN`/`WARNING`/`BLOCKED`/`ERROR`; the verdict is bound to the candidate's sha256. **`ERROR` is never `CLEAN`** — Hermes' `guard_agent_created=False` default and its fail-open exception path are both deliberately NOT copied |
| `core/src/skills/lock.ts` | Per-skill lock in a sibling `.locks/` dir, named by a hash of the **canonical id** so `writing/summary` and `research/summary` cannot collide; stale/dead-pid locks are stolen and reported; a stolen lock is never deleted by its former owner |
| `core/src/skills/applicability.ts` | Platform / environment / domain / tool conditions + a **deterministic index snapshot** (`snapshotId` = hash of `[id, sha256, eligible]`), bounded by `maxEntries` |

**Deliberate differences, stated:**
- **Conditions come from TAGS** (`platform:linux`, `env:ci`, `domain:research`), not new
  frontmatter keys. First-class `platforms:` would need the parser allow-list,
  `SkillMetadata`, the store schema and a migration to change together; the tag
  convention delivers the behaviour today without touching stored data. **This is the
  one place a Hermes mechanism is reproduced with a different carrier.**
- **An unknown environment FAILS OPEN** (a known mismatch fails closed). Hermes reaches
  the same conclusion from the other side. Failing closed on an unknown environment
  would make every `env:ci` skill invisible in the ordinary case — a real bug caught
  while writing this.
- **The scan runs at BOTH stage and activation**, and activation re-verifies that the
  recorded verdict is for the exact bytes being installed.

**Not implemented (ranked, honest):** tier precedence and cross-tier shadowing. KAI's
store has a single root, so tiers are a structural change rather than a mechanism to
copy; recorded as the next adoption item.

**Verdict: Native implementation inspired by the behaviour.** No Hermes code is copied;
no notice obligation arises. Its Python runtime is not embedded.

---

## Priority B — OpenCode (`anomalyco/opencode`) — PENDING (partial evidence)

- **Inspected:** `dev`, licence **MIT**, TypeScript, 212913 stars, pushed 2026-10-12.
- **Verified from source:** the protocol is a real per-domain contract —
  `packages/protocol/src/groups/` contains **30 group files**, including `event.ts`,
  `session.ts`, `permission.ts`, `message.ts`, `skill.ts`, `rpc.ts`, `mcp.ts`, `agent.ts`,
  `worktree.ts`, `shell.ts`, `fs.ts`. `packages/protocol/openapi.json` is generated
  (118 paths, 282 schemas) and exposes **`/api/event`**.
- **Why it is still PENDING:** `Event.SeqEncoded` and `V2EventEncoded` are declared as
  `{"type": "string"}` — the event payloads are SSE-encoded strings, so the OpenAPI
  document does **not** enumerate the event names or their fields. The event union lives
  in `groups/event.ts`, which was not read in this pass.
- **KAI's gap it could close:** `core/src/agents/opencode.ts` implements
  health/status/message/run_task/cancel_task and does **not** consume `/api/event`, so
  progress and terminal status are polled rather than streamed.
- **Verdict: Pending.** Missing evidence: `packages/protocol/src/groups/event.ts` (the
  event union and payload shapes), plus a live `:4096` service for a reconciliation test.

---

## Priority C — Coucou (`Louis-CFM/coucou`) — CORRECTED

- **Inspected:** `main`, licence **MIT** ("Copyright (c) 2026 Louis Raillé"), Swift, 4953
  stars, pushed 2026-10-12. `LICENSE-ASSETS.md` reserves the name, character and artwork.
- **The brief's premise is wrong, and this is the finding.** The brief asks to study
  "hook relay, named-pipe/socket protocol, event normalization and session lifecycle".
  `relay/` is **not a hook relay**: `relay/src/index.ts` is a single-file **Cloudflare
  Worker** that signs Apple Push Notification requests, because the APNs key cannot ship
  inside the Mac app. Its README states it forwards only the push token, the agent's
  name/state/`"working · 3/7"` counts, and — while a command waits for approval — a
  **SHA-256 fingerprint of that command**. "Never a project name, a command, a path or a
  message. It stores nothing and logs nothing."
- **The genuinely transferable mechanism** is that fingerprint: the Lock Screen's Allow
  and Deny "answer that exact command", bound by hash. That is the same shape as KAI's
  approval bound to a staged skill's sha256 — independent corroboration, not a new idea.
- The hook / IPC mechanism, if any, is in the platform app directories
  (`windows/`, `linux/`, `NotchBuddy/`, `android/`), which were not read.
- **Verdict: Study only.** No asset, name, character, sound or icon may be copied.

---

## Priority D — Pi (`badlogic/pi-mono`) — MOVED

- **Finding:** the repository has **moved** — `badlogic/pi-mono` returns HTTP 301 to
  **`earendil-works/pi`** (MIT, TypeScript, 114572 stars, `main`). Any prior note that
  cited the old path is stale.
- **Verdict: Pending** at the new location. The RPC/SDK contract and event hooks were not
  read; nothing about Pi may be assumed from its extensibility.

---

## Priority E — OpenClaw (`openclaw/openclaw`) — PENDING

- **Inspected:** `main`, licence **MIT**, TypeScript, 391777 stars, pushed 2026-10-12.
- **Verified:** the repository carries `THIRD_PARTY_NOTICES.md` and `SECURITY.md`
  alongside `LICENSE` — licence hygiene worth copying as a practice. The tree includes
  `.openclaw/`, `CHANGELOG` (no extension) and `Dockerfile`.
- **Not read:** the tool-loop recovery, steering, batch admission and failure semantics
  the brief names. **Verdict: Pending** on the loop's specific patterns. KAI will not
  import a second agent loop regardless.

---

## Priority F — OpenHands SDK (`OpenHands/software-agent-sdk`) + Rakazo

- **OpenHands SDK:** `main`, licence **MIT**, Python, 1244 stars, pushed 2026-10-12.
  **Verified from source:** the repository is split into real packages —
  `openhands-sdk/`, `openhands-tools/`, `openhands-workspace/`,
  `openhands-agent-server/`, plus `clients/`, `examples/`, `tests/`. That separation is
  the structure the brief asks about, and it is confirmed to exist rather than assumed.
  The interfaces themselves were not read.
- **Rakazo (`vnavani/Grokbot`):** `main`, licence **Apache-2.0** (permissive, with NOTICE
  obligations). **Verified:** it is a real pnpm monorepo (`apps/`, `packages/`, `docs/`,
  `infra/`, `AGENTS.md`, `SECURITY.md`) but has **0 stars and no detected language**, and
  its last push was 2026-08-16. Treat it as an unvetted source, not an established one.
- **Verdict: Pending** for both. Missing evidence: the workspace/provider interfaces.

---

## Priority G — Grok-related projects

| Repo | Branch | Licence (fetched) | Verdict |
|---|---|---|---|
| `Franzferdinan51/Grok-Build-Desktop-App` | — | **NONE** — no LICENSE/COPYING/NOTICE at the root; GitHub's licence API 404; an `upstream/` dir exists | **Reject** — no reuse permitted until the owner clarifies |
| `OnlyTerp/opengrok` | main | **MIT**, JS, 477 stars, pushed 2026-09-22 | **Pending** — a model-routing sidecar, not an executor |
| `LING71671/open-grokbot` | main | **GPL-3.0**, TS, 18 stars | **Study only** — GPL code cannot enter KAI without an explicit licensing decision |
| `ishandutta2007/open-grokbot` | main | **MIT**, Python, 8 stars, pushed 2026-08-13 | **Pending** — permissive licence, but previously flagged for secrets/CORS/Docker defaults and not security-audited |

The three are **distinct projects** and are not conflated.

---

## Priority H — LobeHub (`lobehub/lobehub`)

- **Licence:** "**LobeHub Community License** … All rights reserved." — **not** MIT.
- **Verdict: Study only.** Architecture study and code reuse are separate decisions, and
  this licence is unresolved for distribution.

---

## What remains, and what would close it

Every PENDING row names its missing evidence above. The cheapest next step is to read the
specific files named (`groups/event.ts`, Coucou's platform dirs, OpenClaw's loop,
OpenHands' interfaces) — none of which needs a subagent. A new OMP session with a working
child model would additionally let the six lanes run as designed.
