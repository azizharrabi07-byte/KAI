# HERMES → KAI — Migration Source Audit (Phase B)

**Status:** READ-ONLY audit. This document was produced without copying, transplanting or
modifying any code. Phase D (the transplant) does not start here.

**Rule this document obeys:** *read the real source; never infer internals from a README, a
doc page or memory.* Every factual claim carries a `file:line` or an exact path. Where a
thing could not be found or read, it is marked **NOT FOUND** or **NOT VERIFIABLE** — never
described from a plausible guess. Where a Hermes mechanism has no KAI equivalent and KAI
genuinely lacks the capability, that is stated plainly: naming the gap honestly is the
whole point of this phase.

This is a *different source* from the OpenGhost audit (`docs/OPEN_GHOST_AUDIT.md`) and does
not rewrite it.

---

## 1. What Hermes is, and where it actually lives on this machine

### 1.1 The product

Hermes Agent is an open-source AI-agent framework by **Nous Research** (its own skill metadata:
`C:\Users\DELL\.hermes\profiles\kai\skills\autonomous-ai-agents\hermes-agent\SKILL.md`, frontmatter
`homepage: https://github.com/NousResearch/hermes-agent`). It is a Python application that runs a
CLI, an Ink TUI, an Electron desktop app, a web dashboard, a messaging gateway and an IDE (ACP)
server over one agent core (`agent/`), with the harness surface in `hermes_cli/`.

### 1.2 The running install (exact paths)

| What | Exact path |
|---|---|
| Launcher on PATH | `C:\Users\DELL\.hermes\installs\d0183de7017f8aaf\environments\c79ab10f30d840cd922597c60d457fff\venv\Scripts\hermes` |
| Installed package (the code that runs) | `C:\Users\DELL\.hermes\installs\d0183de7017f8aaf\environments\c79ab10f30d840cd922597c60d457fff\workspace\` |
| Active profile data | `C:\Users\DELL\.hermes\profiles\kai\` (profile `kai`) |
| Default profile data | `C:\Users\DELL\.hermes\` |
| Git source checkout (readable, full tree) | `C:\Users\DELL\.hermes\hermes-agent\` |

How these were found: `which hermes` returned the venv launcher; `hermes --version` printed the
version and the install directory; the package is a Python editable install
(`venv\Lib\site-packages\__editable__.hermes_agent-0.0.0.pth` →
`__editable___hermes_agent_0_0_0_finder.py`), i.e. the workspace directory is the source that
Python imports. The workspace has **no `.git`** (checked: `.git` not present) and **no `skills/`
directory** at its root (`ls` returns not-found) — skills are resolved from the profile home, not
the package.

### 1.3 Version

`hermes --version` reports:

```
Hermes Agent vunknown (2026.9.24)
Install directory: C:\Users\DELL\.hermes\installs\d0183de7017f8aaf\environments\c79ab10f30d840cd922597c60d457fff\workspace
Install method: unknown
Python: 3.14.7
OpenAI SDK: 2.24.0
```

The **version string is literally `vunknown`** with a build date `2026.9.24` — Hermes does not stamp
a semantic version here. `pyproject.toml` declares `version = "0.0.0"` and the egg-info
(`hermes_agent.egg-info/PKG-INFO`) declares `Version: 0.0.0`, `License-Expression: MIT`. So no
semantic version exists to pin; the honest identifier is the source checkout commit.

The **git source checkout** `C:\Users\DELL\.hermes\hermes-agent\` is at:

```
HEAD  1ad2eb1ecf00b9989dd981e496667501a69fc493  2026-10-01 00:27:11 +0530
      fix(desktop): arc layer at 240% so it overhangs the ring at cycle end
git describe: fatal: No names found, cannot describe anything  (no tags)
```

**NOT VERIFIABLE:** whether the workspace install tree is byte-identical to this git checkout at
that commit. The workspace has no `.git`, so equality cannot be recomputed beside it. The two
share module names and structure (both carry `hermes_cli/`, `agent/`, `cron/`, `gateway/`,
`hermes_state*.py`), which is consistent with a checkout of the same tree — but that is
consistency, **not proof of equality**, and it is not claimed here.

### 1.4 Package scale (as read, not estimated)

- `agent/` — the agent core: **200+** `*.py` modules (HTTP greeting agent dir listing).
- `tools/` — **275** entries, of which **267** are `*.py` tool modules.
- Top-level package dirs (67 entries in the workspace) include `agent`, `hermes_cli`, `cron`,
  `gateway`, `providers`, `plugins`, `optional-mcps`, `optional-skills`, `acp_adapter`,
  `hermes_platform`, `web`, `website`, `apps` (desktop/electron), `ui-tui`, `tui_gateway`,
  `native`, `evals`, `tests`, `tests-js`.
- Bundled skills: `hermes-agent/skills/` ships category dirs `apple, autonomous-ai-agents,
  creative, devops, email, media, note-taking, productivity, research, social-media,
  software-development, web`.

### 1.5 Licence at the source root

`C:\Users\DELL\.hermes\hermes-agent\LICENSE` reads, verbatim, first lines:

```
MIT License

Copyright (c) 2025 Nous Research
```

Full standard MIT text follows. **No `NOTICE` file exists** at the repo root (`ls LICENSE*`
returns only `LICENSE`; `head NOTICE*` → "No such file or directory"), so there is no additional
brand-asset carve-out document of the kind Coucou ships (`docs/NOTICE.md` in KAI records that
precedent). The brand is nevertheless present as **assets** in the same MIT tree: `assets/`
contains `banner.png`, `icon-master.svg`, `icon-master-dark.svg`, **`nous-girl-black.svg`**,
**`nous-girl-white.svg`**. Their *presence* is a fact; their *reusability* is treated as a separate
question in §5.

---

## 2. Architecture as read from source

Hermes is a layered Python app. The load-bearing composition root is `agent_init.py` /
`run_agent.py` (`init_agent()` described at `agent/agent_init.py:1` as "a thin, ordered
orchestrator over `_init_*` / `_build_*` phase helpers (routing → callbacks → client → tools →
session → config sections → compression → context engine)"), with **phase ORDER load-bearing**
(`agent/agent_init.py:1`).

**The three-tier system prompt.** `agent/system_prompt.py:734` `build_system_prompt_parts()`
assembles one prompt from three ordered cache tiers (`agent/system_prompt.py:1-9`): **stable**
(identity, guidance, env hints, coding brief, platform hints), **context** (workspace snapshot,
caller `system_message`, project context files) and **volatile** (skills index, memory, USER.md,
external memory provider, timestamp line). The prompt is built once per session and reused across
turns; only context compression rebuilds it (`agent/system_prompt.py:800-809`,
`invalidate_system_prompt` at `:812`). This is the mechanism that keeps the upstream prefix cache
warm.

**The identity slot.** In the stable tier, `_identity_parts()` (`agent/system_prompt.py:544-550`)
loads `SOUL.md` via `prompt_builder.load_soul_md` when `agent.load_soul_identity or not
agent.skip_context_files`, else falls back to `DEFAULT_AGENT_IDENTITY`. Full function:
`load_soul_md()` at `agent/prompt_builder.py:1601`, `DEFAULT_AGENT_IDENTITY` at
`agent/prompt_builder.py:160-169`.

**Memory.** Built-in memory + USER.md blocks via `_memory_parts()` (`agent/system_prompt.py:516`),
fanned out by `MemoryManager` (`agent/memory_manager.py:336`) to registered providers; exactly
**one** external plugin provider may be registered at a time (`agent/memory_manager.py:1`,
`agent/memory_provider.py:1`). Durable session state lives in SQLite (`state.db`) through the
`hermes_state*.py` family.

**Context/compression.** `ContextEngine` is a pluggable base (`agent/context_engine.py:1`);
`ContextCompressor` (`agent/context_compressor.py:1974`, docstring `:1`: "a cheap auxiliary model
summarizes middle turns while head and tail are protected"). `conversation_compression.py` owns the
feasibility probe + compress pass, run on a pooled daemon thread when a timeout is configured
(`agent/conversation_compression.py:1`).

**Tools.** `model_tools.py:1`: "Thin orchestration layer over the tool registry. Importing runs tool
discovery (each `tools/*.py` self-registers via `tools.registry.register()`); exposes
`get_tool_definitions()` (toolset-filtered schemas sent to the model) and `handle_function_call()`".
Discovery: `tools/registry.py:96` `discover_builtin_tools()`.

**Skills.** Loaded into the volatile tier via `_skills_prompt()` (`agent/system_prompt.py:301`)
→ `prompt_builder.build_skills_system_prompt` (`agent/prompt_builder.py:1334`). Metadata utilities
in `agent/skill_utils.py` (import-light, `:1`), bundles in `agent/skill_bundles.py`, slash helpers
in `agent/skill_commands.py`.

**Scheduling.** `cron/scheduler.py` — `tick()` runs due jobs; the gateway calls it every 60 s from a
background thread; a file lock `~/.hermes/cron/.tick.lock` serialises processes
(`cron/scheduler.py:1`). Job storage: `~/.hermes/cron/jobs.json`, output under
`~/.hermes/cron/output/{job_id}/{timestamp}.md` (`cron/jobs.py:1`). Live profile state exists:
`profiles/kai/cron/` contains `executions.db`, `output/`, `ticker_heartbeat`, `ticker_last_success`.

**Self-improvement.** `agent/curator.py:1198` `maybe_run_curator()` — inactivity-triggered
background skill maintenance: "auto-transitions lifecycle states from activity timestamps,
optionally forks an AIAgent that may pin/archive/consolidate/patch skills via `skill_manage`, and
persists scheduler state in `.curator_state`" (`agent/curator.py:1`). No cron daemon; it is
idle-gated.

**Learning.** `agent/learning_graph.py:1` assembles the "learning made visible" graph (learned
skills + MEMORY.md/USER.md chunks as nodes); `agent/learning_mutations.py:1` is user-initiated
edit/delete for those nodes; `agent/learn_prompt.py:1` builds the ONE `/learn` prompt that turns
what the user described into a reusable skill authored via `skill_manage`.

**Gateway / API surface.** `gateway/run.py:5818` `start_gateway()` — "entry point for messaging
platform integrations… `GatewayRunner` (lifecycle)" (`gateway/run.py:1`). The Hermes api-server the
KAI Core talks to is a separate loopback surface (port 8642, see §8).

**Recovery / long-running.** `agent/fallback_cooldown.py:1` (rate-limit cooldown + per-session
model-rejection markers), `agent/estop.py:1` (global resumable emergency-stop sentinel at
`$HERMES_HOME/ESTOP`), `agent/iteration_budget.py:1` (per-agent consume/refund counter; parent
default 500, subagent default 50), `agent/deadline.py:1` (unified wall-clock deadline + timeout
resolver + `run_bounded_async/sync`), `agent/periodic_scheduler.py:1` (one process-wide timer
thread for periodic maintenance callbacks).

**Safety.** `agent/file_safety.py:1` (defense-in-depth file guards, explicitly **not** a security
boundary), `agent/secret_scope.py:1` (context-local, fail-closed secret scope for profile
multiplexing), `agent/redact.py:1` (regex secret redaction for logs/tool output).

**Diagnostics.** `agent/insights.py:85` `InsightsEngine(db).generate(days=30)` aggregates the state
DB into usage insights (tokens, cost estimates, tool/skill usage, activity, model/platform
breakdowns) (`agent/insights.py:1`). `hermes_logging.py`, `status_output.py`, and `hermes doctor`
(CLI) are additional surfaces.

**Delegation / subagents.** `agent/delegation_context.py:1` (context-local state for `delegate_task`
children), `agent/subagent_lifecycle.py:1` ("Public, plugin-safe lifecycle API for delegated Hermes
subagents: immutable contracts, not `AIAgent` objects"). Children are constructed at
`tools/delegate_tool.py:241` with **`skip_context_files=True, skip_memory=True`**.

---

## 3. Component-by-component inventory

The user's list of 18 components. Each entry uses the required schema. "Licence" is read from the
real source root licence (§1.5) unless stated otherwise.

### C1 — Harness loading

- **Source file(s):** `agent/agent_init.py` (`init_agent`, `:1`; kwargs incl. `skip_context_files`,
  `load_soul_identity`, `skip_memory` at `:2346-2403`); `run_agent.py:294`; `hermes_loader`/
  `process_bootstrap.py`; entry points `cli.py`, `hermes_cli/`.
- **Purpose:** the ordered composition root that wires routing, client, tools, session, config,
  compression and context engine into a runnable agent (phase order is load-bearing).
- **Current Hermes behaviour:** `init_agent(agent, …)` runs `_init_*`/`_build_*` phases in a fixed
  order; identity loading is one phase (`skip_context_files`/`load_soul_identity` decide whether
  SOUL.md is the identity or the default).
- **Desired KAI behaviour:** KAI's Core boot (`core/src/runtime.ts` `createCoreRuntime`) already
  composes its own subsystems; the transplant target is *not* a Hermes-style loader but a KAI-native
  one that loads KAI's own documents without a Hermes identity slot.
- **Changes required:** none to KAI's loader; the only relevant change is removing Hermes-identity
  fallbacks from whatever boots KAI inside a Hermes profile (§8).
- **Dependencies:** Hermes `hermes_constants.get_hermes_home`, profile resolution.
- **Licence:** MIT (Nous Research).
- **Final KAI location:** `core/src/runtime.ts` (KAI's own; unchanged).
- **Hermes remains involved:** yes, as the worker process KAI spawns.
- **Classification:** **WORKER-ONLY**.

### C2 — Identity persistence

- **Source file(s):** `agent/prompt_builder.py:1601` `load_soul_md()`; `agent/system_prompt.py:544`
  `_identity_parts()`; `agent/backend_identity.py` (note: this is *backend/provider* identity, not
  persona — `:1`; distinct concern); Hermes profile memory docs `memories/MEMORY.md`,
  `memories/USER.md` under the profile home.
- **Purpose:** persist a persona document (`SOUL.md`) in `HERMES_HOME` and inject it as the top
  identity slot of every session prompt.
- **Current Hermes behaviour:** `SOUL.md` from `HERMES_HOME` is slot #1; if absent/unreadable/empty
  the `DEFAULT_AGENT_IDENTITY` is used; content is threat-scanned and truncated
  (`prompt_builder.py:1621-1642`).
- **Desired KAI behaviour:** KAI already owns this — bounded, redacted, gap-honest identity from
  `KAI_HOME` (`core/src/agent/soul.ts`; `MAX_DOC_CHARS` soul.ts:25; `refresh()` soul.ts:209;
  `replaceSoul()` soul.ts:228; `BUILT_IN_SOUL` soul.ts:54). Proven.
- **Changes required:** none. Do **not** replace with Hermes's loader.
- **Dependencies:** none on Hermes.
- **Licence:** N/A (KAI-owned).
- **Final KAI location:** `core/src/agent/soul.ts`, `core/src/agent/kai-home.ts`,
  `%LOCALAPPDATA%\KAI\{SOUL,USER,MEMORY}.md`.
- **Hermes remains involved:** no.
- **Classification:** **KEEP KAI VERSION**.

### C3 — Self-improvement / upgrade loop

- **Source file(s):** `agent/curator.py` (`maybe_run_curator` `:1198`); `agent/learning_graph.py`,
  `agent/learning_mutations.py`, `agent/learn_prompt.py`; `hermes profile install/update`
  (`hermes_cli/profile_distribution.py`, referenced at `prompt_builder.py:1629-1637`).
- **Purpose:** maintenance of the agent's own knowledge: idle-triggered curation that may
  pin/archive/consolidate/patch skills via `skill_manage`; `/learn` authors a new skill from
  described material; the *upgrade loop* is the Hermes installer/updater (binary/tree replacement),
  distinct from curation.
- **Current Hermes behaviour:** curator is inactivity-gated (no cron daemon), forked agent authors
  skill changes; `/learn` builds a skill-authoring prompt; distribution profiles can plant a
  third-party `SOUL.md`.
- **Desired KAI behaviour:** KAI's learning is human-gated: a memory candidate is written with
  `provenance: "model_candidate"`, a skill candidate is **only staged** and needs human approval;
  autonomy supervisor defaults to `maxAttempts 1` (KAI_HARNESS §12, §9). Self-maintenance is
  observation-only (`maintenance/index.ts:18-23` explicitly disclaims self-replacing binaries).
- **Changes required:** KAI **lacks** an autonomous curation loop (see §6 G2/G6). If taken, it must
  remain advisory/staged, never auto-promoting. The Hermes *binary-replacement* upgrade loop must
  not enter KAI.
- **Dependencies:** skill store + approval service (KAI already has both).
- **Licence:** MIT.
- **Final KAI location:** a new `core/src/cognition/curator.ts` consuming KAI's existing
  `skills/registry.ts` + `approvals/service.ts`.
- **Hermes remains involved:** no (KAI-side mechanism; Hermes may be the *worker that runs it*).
- **Classification:** **ADAPT** (curation idea), **DO NOT IMPORT** (binary self-replacement).

### C4 — Skills

- **Source file(s):** `agent/skill_utils.py:1`; `agent/skill_bundles.py:1`; `agent/skill_commands.py`;
  `agent/prompt_builder.py:1334` `build_skills_system_prompt`; `skills/` tree shipped in the repo;
  profile `skills/` resolved from `HERMES_HOME` (`system_prompt.py:255-314`).
- **Purpose:** install, index and progressively disclose reusable procedures; bundles alias several
  skills under one slash command.
- **Current Hermes behaviour:** skills live on disk under `<home>/skills`, discovered and indexed
  into the volatile prompt tier; `skill_view`/`skill_manage`/`skills_list` tools; bundles under
  `<HERMES_HOME>/skill-bundles/*.yaml`; `/learn` authors them; curator prunes/consolidates.
- **Desired KAI behaviour:** KAI already has a skill registry with content-addressed, exactly-byte
  approved installs and rollback (`core/src/skills/registry.ts`, `staging.ts`; KAI_HARNESS §13).
  **Gap:** KAI has **no automatic skill discovery from disk on startup** (KAI_HARNESS §13).
- **Changes required:** adopt Hermes's **on-disk discovery + metadata-only indexing** idea, but keep
  KAI's install/approval invariants (staging SHA binding).
- **Dependencies:** KAI skill registry; filesystem layout (KAI_HOME/skills — note the dir already
  exists: `%LOCALAPPDATA%\KAI\skills`).
- **Licence:** MIT.
- **Final KAI location:** extend `core/src/skills/registry.ts` + a new discovery module; skills dir
  `%LOCALAPPDATA%\KAI\skills`.
- **Hermes remains involved:** no for storage; Hermes may author skill candidates as a worker.
- **Classification:** **ADAPT** (discovery/indexing) — **KEEP KAI VERSION** (install/approval).

### C5 — Tool management

- **Source file(s):** `model_tools.py:1`, `:214` `get_tool_definitions()`; `tools/registry.py:96`
  `discover_builtin_tools()`; 267 `tools/*.py` self-registering modules; toolset gating
  (`hermes_cli/config.py` toolsets; `platform_toolsets` in config.yaml:153).
- **Purpose:** discover tools, expose a toolset-filtered schema list to the model, dispatch calls
  with hooks/middleware.
- **Current Hermes behaviour:** import triggers discovery; each tool module calls
  `tools.registry.register()`; disabled toolsets are filtered out of the schema.
- **Desired KAI behaviour:** KAI already has ONE tool boundary — every action goes
  request → validate → policy → (approval) → execute through `core/src/tools/registry.ts`
  (KAI_HARNESS §21). This must not be replaced.
- **Changes required:** **none to the boundary**. Optionally adopt Hermes's *toolset grouping /
  schema-filtering by platform* as a metadata layer on top of KAI's registry.
- **Dependencies:** KAI registry.
- **Licence:** MIT.
- **Final KAI location:** `core/src/tools/registry.ts` (unchanged) + optional toolset metadata.
- **Hermes remains involved:** no.
- **Classification:** **KEEP KAI VERSION** (the boundary); **ADAPT** (toolset metadata).

### C6 — Memory

- **Source file(s):** `agent/memory_manager.py:336`; `agent/memory_provider.py:1`;
  `agent/system_prompt.py:516` `_memory_parts()`; config `memory:` block
  (`profiles/kai/config.yaml:91-97`); profile files `profiles/kai/memories/{MEMORY,USER}.md`.
- **Purpose:** persistent, cross-session memory + user profile, pluggable to one external provider.
- **Current Hermes behaviour:** built-in store + USER.md rendered into the volatile tier; one
  external provider may be registered; memory tool writes durable facts.
- **Desired KAI behaviour:** KAI already owns a **memory authority** — scoped, subagent-isolated,
  governed-sharing, persisted (SQLite `memory_entries`/`memory_journal` with FTS5-detected,
  append-only journal) with adversarial tests (KAI_HARNESS §11; freeze §6).
- **Changes required:** none. **Replacing KAI's memory with Hermes's would be a regression.**
  Hermes's *idea* of a single pluggable external provider is optional and not required.
- **Dependencies:** none on Hermes.
- **Licence:** N/A (KAI-owned).
- **Final KAI location:** `core/src/memory/*`, `core/src/storage/memoryStore.ts` (unchanged).
- **Hermes remains involved:** no.
- **Classification:** **KEEP KAI VERSION**.

### C7 — Scheduling

- **Source file(s):** `cron/scheduler.py:1` (`tick()`, gateway calls every 60 s, `.tick.lock`);
  `cron/jobs.py:1` (`~/.hermes/cron/jobs.json`); `agent/periodic_scheduler.py:1` (one process-wide
  timer thread); `cron/` package (33 modules incl. `scheduler_delivery`, `scheduler_ownership`).
- **Purpose:** persistent cron-style scheduling with delivery to messaging channels.
- **Current Hermes behaviour:** a background thread ticks due jobs every 60 s; a file lock keeps one
  tick at a time; output persisted per job/timestamp; delivery routed to platform channels from a
  polling loop.
- **Desired KAI behaviour:** KAI already has a persistent scheduler with durable leases, quarantine
  on repeated failure, and every fire re-checked against policy/approval
  (`core/src/scheduler/*`; KAI_HARNESS §14). **Gap:** no cron-expression GUI beyond the stored spec.
- **Changes required:** none to KAI's scheduler; do **not** adopt Hermes's daemon-thread model.
- **Dependencies:** none on Hermes.
- **Licence:** MIT (if any idea is taken).
- **Final KAI location:** `core/src/scheduler/*` (unchanged).
- **Hermes remains involved:** no.
- **Classification:** **KEEP KAI VERSION**.

### C8 — Recovery

- **Source file(s):** `agent/fallback_cooldown.py:1`; `agent/estop.py:1`; `agent/deadline.py:1`
  (`run_bounded_async/sync`, `resolve_timeout`, `clamp_timeout`); `agent/retry_utils.py`;
  `agent/error_classifier.py`, `agent/errors.py`; `agent/auxiliary_fallback_recovery.py`.
- **Purpose:** bounded execution + failover: one timeout resolver, global pause (ESTOP), rate-limit
  cooldown arming, provider/model failover walk.
- **Current Hermes behaviour:** every timeout is capped (`clamp_timeout`) because huge values
  overflow `time_t` on macOS (#83220 per docstring); ESTOP is a resumable sentinel that gates NEW
  work only (in-flight work never killed); cooldowns shared between the fallback walk and primary
  restore.
- **Desired KAI behaviour:** KAI has a durable recovery **ledger + boundary runner** with
  BEFORE_ACCEPT/AFTER_ACCEPT phases and refuse-not-replay semantics (KAI_HARNESS §10). **Gap:** no
  wired replay executor.
- **Changes required:** KAI already has the stronger audit-grade mechanism; Hermes's *bounded
  deadline* and *resumable estop* are useful, small, self-contained ideas worth adapting.
- **Dependencies:** none on Hermes for the ideas.
- **Licence:** MIT.
- **Final KAI location:** `core/src/recovery/*` (keep) + optional `core/src/execution/deadline.ts`
  and a `core/src/control/estop.ts` mirroring the sentinel semantics.
- **Hermes remains involved:** no.
- **Classification:** **KEEP KAI VERSION** (ledger/boundary); **ADAPT** (deadline + estop).

### C9 — Context handling

- **Source file(s):** `agent/context_engine.py:1`; `agent/context_compressor.py:1974`;
  `agent/conversation_compression.py:1`; `agent/prompt_cache_boundary.py`,
  `prompt_cache_scope.py`, `prompt_caching.py`; `agent/system_prompt.py` tiering (`:734`).
- **Purpose:** keep a long conversation inside the model window without breaking the prefix cache:
  a cheap auxiliary model summarises middle turns while head/tail are protected; iterative
  summaries; tool-output pruning first.
- **Current Hermes behaviour:** three-tier prompt (stable/context/volatile) for cache stability
  (`system_prompt.py:1-9`); compression runs on a pooled daemon thread when a timeout is set; the
  prompt is rebuilt only at compression boundaries.
- **Desired KAI behaviour:** KAI composes turns through ONE bounded, fenced composer
  (`core/src/prompts/compose.ts`; KAI_HARNESS §3) but has **no auxiliary-model compression of long
  histories**. This is a real gap for long-running sessions.
- **Changes required:** adapt the *summarise-middle-under-budget* idea into a KAI context engine
  that respects KAI's section budget/fence model; do **not** import Hermes's cache-tier scheme
  wholesale (KAI has no shared-prefix caching contract).
- **Dependencies:** a summariser model/provider (KAI's cheap-model config).
- **Licence:** MIT.
- **Final KAI location:** `core/src/context/compressor.ts` (new), integrated with
  `core/src/prompts/compose.ts`.
- **Hermes remains involved:** no.
- **Classification:** **ADAPT**.

### C10 — Worker / tool abstractions

- **Source file(s):** `agent/delegation_context.py:1`; `agent/subagent_lifecycle.py:1`;
  `tools/delegate_tool.py:241`; `tools/delegate_tool_*.py`; `agent/agent_cache_pressure.py`.
- **Purpose:** delegate a bounded subtask to an isolated child agent (own tools/session/iteration
  budget) and return a result; plugin-safe lifecycle contracts for those children.
- **Current Hermes behaviour:** `delegate_task` builds children with `skip_context_files=True,
  skip_memory=True` (`tools/delegate_tool.py:241`); each child holds its own `IterationBudget`
  (`agent/iteration_budget.py:1`).
- **Desired KAI behaviour:** KAI already owns a **workforce abstraction** with employees, lifecycle
  state machine, and subagents as personas on ONE workforce/ONE policy path (`core/src/workforce/*`;
  KAI_HARNESS §5, §17). Freeze §6 marks *workforce* as must-keep.
- **Changes required:** none. **Do not** replace KAI's workforce with Hermes's delegate model; the
  delegation *idea* is already present. Note the leak consequence of `skip_context_files=True`
  (children run with the default identity) in §8/L2 — KAI's subagents already run under KAI's own
  soul, not a default.
- **Dependencies:** none on Hermes.
- **Licence:** MIT (idea only).
- **Final KAI location:** `core/src/workforce/*` (unchanged).
- **Hermes remains involved:** yes — Hermes is one worker KAI delegates to, via
  `core/src/agents/adapters/hermesAdapter.ts`.
- **Classification:** **KEEP KAI VERSION** (workforce/subagents); **WORKER-ONLY** (Hermes-as-worker).

### C11 — Learning mechanisms

- **Source file(s):** `agent/learning_graph.py:1`; `agent/learning_mutations.py:1`;
  `agent/learn_prompt.py:1`; `agent/curator.py` (see C3).
- **Purpose:** turn experience into durable knowledge — detect a reusable procedure/pitfall, author
  it as a skill, and make "what was learned" visible and editable.
- **Current Hermes behaviour:** `/learn` builds one skill-authoring prompt; a learning graph renders
  learned skills + memory chunks as nodes; the user can edit/delete nodes.
- **Desired KAI behaviour:** KAI classifies a completed turn as MEMORY | SKILL | NONE; a memory
  candidate is written live with `provenance: "model_candidate"`, a skill candidate is **only
  staged**; host-attested user authority fails closed without the host token (KAI_HARNESS §12).
- **Changes required:** KAI has the pipeline but **no autonomous skill authoring/consolidation**
  and no "learning made visible" surface. Adapt the visibility graph + curator as *advisory*.
- **Dependencies:** KAI memory engine, skill staging, approval service.
- **Licence:** MIT.
- **Final KAI location:** extend `core/src/learning/*`; optional `core/src/learning/graph.ts`.
- **Hermes remains involved:** no.
- **Classification:** **ADAPT**.

### C12 — Diagnostics

- **Source file(s):** `agent/insights.py:85` (`InsightsEngine`, `:173` `generate()`);
  `hermes_logging.py`; `agent/status_output.py`; `hermes doctor` (CLI); `hermes_logging.py`.
- **Purpose:** aggregate the state DB into usage insights (tokens, cost, tool/skill usage,
  activity, model/platform breakdowns) and surface health/diagnostics.
- **Current Hermes behaviour:** `InsightsEngine(db).generate(days=30)` → `format_terminal(report)`
  (`agent/insights.py:1`); `hermes doctor` is a health check.
- **Desired KAI behaviour:** KAI has observability (`action.executed` records, correlation reads;
  KAI_HARNESS §16) and a maintenance status/repair surface (§18), but **no aggregated usage/insight
  report**. Useful addition.
- **Changes required:** adapt the aggregation queries over KAI's action-record/observability store.
- **Dependencies:** KAI observability store.
- **Licence:** MIT.
- **Final KAI location:** `core/src/observability/insights.ts` (new).
- **Hermes remains involved:** no.
- **Classification:** **ADAPT**.

### C13 — Capability discovery

- **Source file(s):** `tools/registry.py:96` (tool discovery); `hermes_cli/plugins.py:1951`
  (`render_system_prompt_sections` — plugin discovery into the prompt);
  `optional-mcps/`, native MCP client (`hermes mcp`); skills discovery (C4).
- **Purpose:** discover what the runtime can do — tools, plugins, MCP servers, skills — and expose
  the discovered surface to the model.
- **Current Hermes behaviour:** importing tools self-registers them; plugins render their own
  system-prompt sections; MCP servers are configured in `config.yaml` and discovered.
- **Desired KAI behaviour:** KAI has a capability registry with under-claim invariants (a disabled
  capability cannot be probed back to life) and lazy real transports (KAI_HARNESS §6). **Gap:** no
  plugin marketplace / dynamic third-party extension discovery.
- **Changes required:** KAI's registry must stay authoritative; only adopt the *discovery+render*
  pattern for a KAI-native extension surface if one is built.
- **Dependencies:** KAI capability registry; MCP (KAI already wires MCP behind the tool boundary —
  KAI_HARNESS §21).
- **Licence:** MIT.
- **Final KAI location:** `core/src/capabilities/*` (keep) + optional extension discovery.
- **Hermes remains involved:** no.
- **Classification:** **KEEP KAI VERSION** (registry/under-claim); **ADAPT** (discovery+render).

### C14 — Long-running execution

- **Source file(s):** `agent/iteration_budget.py:1` (parent 500 / subagent 50);
  `agent/deadline.py:1`; `agent/periodic_scheduler.py:1`; `agent/estop.py:1`; `batch_runner.py`;
  Bot Mode (forever-chat) referenced in `system_prompt.py:499-510`.
- **Purpose:** survive and pace long/forever runs: iteration budgets, wall-clock deadlines, one
  maintenance timer thread, a resumable stop, and Bot Mode sessions that span days and compactions.
- **Current Hermes behaviour:** budgets consumed/refunded thread-safely; ESTOP pauses new work only;
  the timestamp line gains an "as of rebuild" line when a session spans days (`system_prompt.py:507`).
- **Desired KAI behaviour:** KAI has missions + an autonomy supervisor (default `maxAttempts 1`) and
  a persistent scheduler, but no explicit iteration budget or long-run day-stamp semantics.
- **Changes required:** adapt iteration-budget + deadline as KAI execution primitives; keep KAI's
  mission/supervisor model.
- **Dependencies:** none on Hermes for the ideas.
- **Licence:** MIT.
- **Final KAI location:** `core/src/execution/*` (new), used by the mission executor.
- **Hermes remains involved:** no.
- **Classification:** **ADAPT**.

### C15 — State persistence

- **Source file(s):** `hermes_state.py` + `hermes_state_*.py` family (30+ modules:
  `hermes_state_schema`, `_sessions`, `_messages`, `_identity`, `_search`, `_compression`,
  `_maintenance`, `_repair`, `_rewind`, `_portability`, …); live DB at
  `profiles/kai/state.db` (read: **24 tables**, incl. `messages`, `messages_fts` (+trigram),
  `sessions`, `system_prompts`, `async_delegations`, `session_turn_leases`, `gateway_routing`).
- **Purpose:** the canonical durable session/message store — schema-versioned SQLite with FTS5
  search, message-identity columns, repair/rewind, leases and maintenance.
- **Current Hermes behaviour:** one `state.db` per home; FTS5 full-text search over messages
  (`messages_fts*`); `hermes_state_identity.py:1` is the codec for durable message-identity columns
  (schema v31).
- **Desired KAI behaviour:** KAI already owns its SQLite stores: `kai-sessions.db`, `memoryStore`,
  `recovery-ledger.db` (KAI_HARNESS §2, §10, §11). **Gap:** KAI has no session **search** or
  cross-session summary (KAI_HARNESS §2).
- **Changes required:** adopt FTS5-based **session search** over KAI's own session DB; keep KAI's
  separate, purpose-scoped DBs (do not collapse to one Hermes-style `state.db`).
- **Dependencies:** KAI session store.
- **Licence:** MIT.
- **Final KAI location:** extend `core/src/sessions/store.ts` with an FTS index.
- **Hermes remains involved:** no.
- **Classification:** **KEEP KAI VERSION** (store layout); **ADAPT** (FTS search).

### C16 — Safety mechanisms

- **Source file(s):** `agent/file_safety.py:1`; `agent/secret_scope.py:1`; `agent/redact.py:1`;
  `agent/estop.py:1`; terminal approval batch (`agent/terminal_approval_batch.py`);
  `agent/runtime_self_protection.py`.
- **Purpose:** reduce blast radius: file guards, profile-scoped secret isolation, regex redaction of
  logs/tool output, emergency stop, approval batching.
- **Current Hermes behaviour:** `file_safety.py` is explicitly **not** a security boundary
  (`:1`) — a clear denial + audit trail; `secret_scope.py` fails closed and is context-local so
  profile A's keys cannot leak into profile B's turns/subprocesses; `redact.py` masks short tokens
  fully, keeps first-6/last-4 of longer ones.
- **Desired KAI behaviour:** KAI already owns the **policy engine** (one security boundary, one
  policy table), the **approval authority** (single approval path; approval binds exactly one tool),
  and **redaction at the bus** before persistence and delivery (KAI_HARNESS §7, §8, §21). Freeze §6
  marks policy + approval as must-keep.
- **Changes required:** none. The one idea worth borrowing is **profile-scoped secret isolation**
  (context-local, fail-closed) if KAI ever multiplexes contexts — it is small and self-contained.
- **Dependencies:** none on Hermes.
- **Licence:** MIT.
- **Final KAI location:** `core/src/policies/*`, `core/src/approvals/*`, `core/src/redact/index.ts`
  (unchanged) + optional secret-scope module.
- **Hermes remains involved:** no.
- **Classification:** **KEEP KAI VERSION** (policy/approval/redaction); **ADAPT** (secret scope).

### C17 — Backend / API surface

- **Source file(s):** `cli.py`; `gateway/run.py:5818` `start_gateway()`; `acp_adapter/`;
  `hermes_platform/`; the Hermes api-server on loopback port 8642 (consumed by KAI —
  `core/src/config.ts:56`).
- **Purpose:** expose the agent over many surfaces (CLI, TUI, desktop, dashboard, messaging
  gateway, ACP/IDE, OpenAI-compatible proxy) and a local HTTP api-server.
- **Current Hermes behaviour:** one core, many adapters; the gateway multiplexes many profiles over
  one process (`gateway/run.py:1`; `agent/system_prompt.py:232-239` describes per-turn profile
  binding).
- **Desired KAI behaviour:** KAI's Core is a loopback HTTP server (`core/src/server.ts`, binds
  127.0.0.1 only) with a one-way SSE control plane; KAI is the **speaker** and Hermes/OpenCode are
  workers. This inversion is the whole design and must not change.
- **Changes required:** none. Hermes's api-server stays a *worker endpoint*, reached through KAI's
  adapter — never a supervisor surface.
- **Dependencies:** Hermes install (worker) at 127.0.0.1:8642.
- **Licence:** MIT (Hermes side).
- **Final KAI location:** `core/src/server.ts`, `core/src/agents/hermes.ts` (KAI-owned clients).
- **Hermes remains involved:** yes — as a backend KAI calls.
- **Classification:** **WORKER-ONLY**.

### C18 — Prompt / identity composition

- **Source file(s):** `agent/system_prompt.py:734` (`build_system_prompt_parts`),
  `:800` (`build_system_prompt`); `agent/prompt_builder.py` (`DEFAULT_AGENT_IDENTITY:160`,
  `HERMES_AGENT_HELP_GUIDANCE:171`, `build_memory_guidance:193`,
  `build_skills_system_prompt:1334`, `build_context_files_prompt:1805`,
  `RUNTIME_ENVIRONMENT_HEADING:1134`); plugin sections `hermes_cli/plugins.py:1951`.
- **Purpose:** assemble the one system prompt that defines who the agent is and what it can do,
  cache-stably, from identity + guidance + tools + memory + skills + environment.
- **Current Hermes behaviour:** three cache tiers; identity slot is SOUL.md or
  `DEFAULT_AGENT_IDENTITY`; guidance blocks injected conditionally; plugin sections frozen per
  session; a timestamp trailer names Session ID / Model / Provider / Platform.
- **Desired KAI behaviour:** KAI already owns ONE composer — fixed-order, bounded, fenced, with
  structural instruction/data trust separation (`core/src/prompts/compose.ts`; KAI_HARNESS §3). This
  must not be replaced by a Hermes-style assembler.
- **Changes required:** none. If any Hermes prompt *concept* is taken, it is only the idea of
  tool-gated guidance blocks — and only inside KAI's composer.
- **Dependencies:** none on Hermes.
- **Licence:** MIT (Hermes), N/A (KAI).
- **Final KAI location:** `core/src/prompts/compose.ts` (unchanged).
- **Hermes remains involved:** no.
- **Classification:** **KEEP KAI VERSION**.

---

## 4. Classification table

| # | Component | Classification |
|---|---|---|
| C1 | Harness loading | WORKER-ONLY |
| C2 | Identity persistence | **KEEP KAI VERSION** |
| C3 | Self-improvement / upgrade loop | ADAPT (curation) + DO NOT IMPORT (binary self-replacement) |
| C4 | Skills | ADAPT (discovery/index) + **KEEP KAI VERSION** (install/approval) |
| C5 | Tool management | **KEEP KAI VERSION** (boundary) + ADAPT (toolset metadata) |
| C6 | Memory | **KEEP KAI VERSION** |
| C7 | Scheduling | **KEEP KAI VERSION** |
| C8 | Recovery | **KEEP KAI VERSION** (ledger/boundary) + ADAPT (deadline/estop) |
| C9 | Context handling | ADAPT |
| C10 | Worker / tool abstractions | **KEEP KAI VERSION** (workforce/subagents) + WORKER-ONLY (Hermes-as-worker) |
| C11 | Learning mechanisms | ADAPT |
| C12 | Diagnostics | ADAPT |
| C13 | Capability discovery | **KEEP KAI VERSION** (registry) + ADAPT (discovery/render) |
| C14 | Long-running execution | ADAPT |
| C15 | State persistence | **KEEP KAI VERSION** (stores) + ADAPT (FTS session search) |
| C16 | Safety mechanisms | **KEEP KAI VERSION** (policy/approval/redaction) + ADAPT (secret scope) |
| C17 | Backend / API surface | WORKER-ONLY |
| C18 | Prompt / identity composition | **KEEP KAI VERSION** |

**Counts (primary classification per component, 18 total):**
- **KEEP KAI VERSION** (as the primary verdict): **8** — C2, C6, C7, C10, C13, C15, C16, C18.
  (C4, C5, C8 carry KEEP KAI VERSION as their *load-bearing half* on top of a KAI-owned system.)
- **ADAPT** (primary): **5** — C9, C11, C12, C14, and C3 (whole mechanism adapted, not copied).
- **WORKER-ONLY** (primary): **3** — C1, C17 and C10's Hermes-as-worker half.
- **DO NOT IMPORT**: **1** — the Hermes binary-replacement upgrade loop (part of C3).
- **REUSE**: **0** as a standalone primary verdict. Nothing is copied line-for-line: Hermes is
  Python, KAI is Node/TypeScript, and every shared mechanism is a design idea to be re-implemented
  against KAI's own boundaries. Calling any component "reuse" would overstate what is possible.

No component was classified **REWRITE**: KAI already owns a version of every load-bearing
subsystem, so the work is adaptation at the edges, not a rewrite of a KAI system.

---

## 5. Licence analysis

### 5.1 The Hermes source

- **Licence:** MIT. `C:\Users\DELL\.hermes\hermes-agent\LICENSE` → "MIT License / Copyright (c)
  2025 Nous Research"; egg-info `License-Expression: MIT`, `License-File: LICENSE`. KAI's own
  `LICENSE` is also MIT (Copyright (c) 2026 Louis Raillé for upstream Coucou; Copyright (c) 2026
  Aziz for KAI modifications). MIT code may be reused with the upstream copyright notice preserved.
- **No NOTICE file** at the Hermes root — there is no explicit brand-asset carve-out document. That
  is a *fact about the licence files*, not a statement that the brand is reusable (§5.3).

### 5.2 Components whose licence is clear

Every component in §3 is read from the MIT-licensed Hermes source root, so each is **MIT**.
There is no component in this audit whose licence is unknown or missing.

### 5.3 The identity / brand question — separate from the code question

The lesson from Coucou (`docs/NOTICE.md`): *"the code is open"* and *"the identity is reusable"*
are **separate questions**. Coucou's MIT covered source only; the names "Coucou"/"Mochi", the Mochi
character, the icon, the sounds and the media were rights-reserved. The same separation must be
applied to Hermes:

- **Code** — MIT, reusable with attribution.
- **Name and identity** — "Hermes", "Hermes Agent", "Nous Research", "nous" are Nous Research's
  product identity. The repo carries them as first-class strings (`DEFAULT_AGENT_IDENTITY`,
  `HERMES_AGENT_HELP_GUIDANCE`) and as assets (`assets/nous-girl-black.svg`,
  `assets/nous-girl-white.svg`, `assets/banner.png`, `assets/icon-master*.svg`). **No licence file
  grants reuse of the name or the artwork.** Treat all of it as **DO NOT IMPORT** pending explicit
  written clarification — exactly as Coucou's brand was treated.
- **The "Nous girl" artwork and any Hermes/Nous logo or character** — **DO NOT IMPORT**.

### 5.4 Licence of third-party dependencies

The Hermes tree vendors `node_modules/` and a Python `venv/`. **NOT VERIFIABLE at this depth:**
the licences of every transitive npm/PyPI dependency were not enumerated. **Rule for Phase D:** any
dependency pulled in by a transplant must have its own licence read from its own files before use;
an unread licence is **DO NOT IMPORT** pending clarification, never assumed permissive.

### 5.5 KAI's identity (unchanged by this audit)

KAI keeps its own name, icon, character, artwork, palette and sounds (`docs/KAI_STAGE1_FREEZE.md`
§9; `docs/NOTICE.md`). Nothing in this audit changes that.

---

## 6. Specific gaps in KAI that Hermes could fill

Each gap is sourced to the KAI code as documented in `docs/KAI_HARNESS.md` (which is itself
source-cited) or to KAI's own source read in this audit. These are the mechanisms KAI genuinely
does not have today.

1. **No automatic skill discovery from disk on startup.** KAI skills are registered/staged
   explicitly (KAI_HARNESS §13). Hermes discovers and indexes `skills/` at boot (C4). *Fill:
   discovery + metadata-only index, keeping KAI's approval gate.*
2. **No autonomous skill curation/consolidation loop.** KAI skill installs are always
   human-approved (KAI_HARNESS §12, §13). Hermes's curator (§2, C3) offers the model. *Fill:
   advisory curator that proposes staged changes only.*
3. **No auxiliary-model context compression for long histories.** KAI's composer is bounded but
   history is not summarised (C9). *Fill: summarise-middle-under-budget engine.*
4. **No session search / cross-session summary.** KAI sessions are list/rename/archive/activate
   only (KAI_HARNESS §2). Hermes has FTS5 message search (`messages_fts`; `hermes_state_search.py`).
   *Fill: FTS index over KAI's session DB.*
5. **No wired recovery replay executor.** `replayIfSafe()` has no production call site (KAI_HARNESS
   §10). Recovery classifies but does not replay. *Fill: bounded, refuse-not-replay executor.*
6. **No mission planner.** Missions are authored explicitly; the router cannot start one (KAI_HARNESS
   §9). Hermes has no NL mission planner either (see §10), so this is not a Hermes transplant — it
   is a KAI gap to name, not necessarily to fill from Hermes.
7. **No long-run iteration budget / day-awareness.** KAI has `maxAttempts` on the autonomy
   supervisor but no per-agent iteration budget or multi-day session stamping (C14). *Fill:
   iteration-budget + deadline primitives.*
8. **No aggregated usage/insight report.** KAI has observability records but no insights aggregation
   (C12). *Fill: insights engine over the action-record store.*
9. **No plugin/extension discovery + prompt rendering.** KAI capabilities are first-party; there is
   no third-party extension surface (C13). *Fill (optional): discovery + render pattern.*
10. **No subagent visual variant resolver** (KAI_HARNESS §5, §17) — a KAI-internal gap, not a Hermes
    mechanism. Named for completeness; **NOT a Hermes transplant candidate**.
11. **No cron-expression GUI** beyond the stored schedule spec (KAI_HARNESS §14) — a KAI-internal
    gap; not a Hermes mechanism.
12. **No per-user policy / policy persistence across restart** (KAI_HARNESS §7) — KAI-internal gap;
    Hermes does not supply this either.

Gaps 6, 10, 11 and 12 are stated as **KAI gaps with no Hermes counterpart** — naming them honestly
rather than pretending Hermes fills them.

---

## 7. What KAI already owns and must keep

From `docs/KAI_STAGE1_FREEZE.md` §6 (the invariants that must survive the reset) and the KAI
source read in this audit. Where Hermes has an equivalent, the correct answer is **KEEP KAI VERSION**
and here is why replacing it would be a regression:

| KAI system | Source | Why Hermes must not replace it |
|---|---|---|
| **Memory authority** | `core/src/memory/*`, `core/src/storage/memoryStore.ts` | Scoped, subagent-isolated, governed sharing, append-only journal, FTS5-detected, adversarial-tested (freeze §6). Hermes's memory is a flatter store + one pluggable provider — swapping would lose the scoping/isolation guarantees and their tests. |
| **Approval authority** | `core/src/approvals/service.ts` | ONE approval path; an approval binds exactly one tool (KAI_HARNESS §8). Hermes has no equivalent single-binding approval authority to substitute. |
| **Policy engine** | `core/src/policies/{gate,mode}.ts` | One policy engine, one security boundary, explicit `source` per decision, no mode auto-allows DESTRUCTIVE/EXTERNAL (KAI_HARNESS §7). Replacing it would split the security boundary. |
| **Browser / CDP** | `core/src/capabilities/browser/*` | Real headless CDP browser wired lazily with failure-as-reason (KAI_HARNESS §6). Hermes's browser stack is a different architecture; KAI's is proven. |
| **CUA** | `core/src/capabilities/computer/*` | Real transport, never simulated (freeze §6). |
| **Workforce abstraction** | `core/src/workforce/*` | Employees + lifecycle state machine + subagents as personas on ONE workforce/ONE policy path (KAI_HARNESS §5). Hermes's `delegate_task` is a different, weaker model. |
| **Artifact identity** | `core/src/identity.ts`, maintenance anti-stale check | The build/source identity invariant; on refusal **rebuild, never bypass** (freeze §6). Hermes has no equivalent invariant. |
| **Prompt composer** | `core/src/prompts/compose.ts` | ONE bounded, fenced, fixed-order composer with structural trust separation (KAI_HARNESS §3). Replacing it would lose the fence/trust model. |
| **Skill install integrity** | `core/src/skills/staging.ts` | Exactly-byte approved installs (SHA-256 re-hashed at install) with rollback (KAI_HARNESS §13). Hermes's `skill_manage` has no such invariant. |
| **Recovery ledger + boundary** | `core/src/recovery/*` | Durable ledger, BEFORE/AFTER_ACCEPT, refuse-not-replay (KAI_HARNESS §10). Hermes's recovery is cooldown/failover, not an audit-grade ledger. |

Replacing any of these to make KAI "look like Hermes" would destroy working, adversarially-tested
architecture. The transplant fills gaps at the edges (C9, C11, C12, C14, C3, plus the ADAPT halves
of C4/C5/C8/C13/C15/C16); it does not touch the load-bearing KAI systems above.

---

## 8. Identity-boundary findings

**This is the section that matters most for KAI becoming itself.** Every place found where a
Hermes-specific concept currently leaks into what KAI loads at boot, or into a session that speaks
as KAI.

### 8.A Leaks in the Hermes runtime's own prompt (the KAI profile runs on this)

The KAI profile is a Hermes profile (`C:\Users\DELL\.hermes\profiles\kai\`). When a Hermes session
speaks "as KAI" by running this profile, the assembled system prompt is produced by
`agent/system_prompt.py`. The following Hermes-specific strings are injected at boot:

- **L1 — Default identity names the product as Hermes.**
  `DEFAULT_AGENT_IDENTITY` (`agent/prompt_builder.py:160-169`) is literally
  `"You are Hermes Agent, built by Nous Research. …"`. It is injected as identity slot #1 whenever
  `SOUL.md` is absent, empty or skipped (`agent/system_prompt.py:544-550`).
- **L2 — Delegated subagents run as Hermes, not KAI (demonstrated).**
  `tools/delegate_tool.py:241` builds delegate children with **`skip_context_files=True`**;
  `agent/system_prompt.py:548` then computes `wants_soul = False`, so a child ends up on
  `DEFAULT_AGENT_IDENTITY`. **Evidence:** the system prompt of this very audit session — which is a
  delegated subagent — opens with the exact string `"You are Hermes Agent, built by Nous Research."`
  and never loads the `kai` profile's `SOUL.md` (`C:\Users\DELL\.hermes\profiles\kai\SOUL.md`,
  whose own content begins `# KAI` / `You are KAI…`). Every subagent KAI's Hermes worker spawns is
  therefore a Hermes-identity agent, not a KAI agent.
- **L3 — The runtime banner names Hermes.**
  `RUNTIME_ENVIRONMENT_HEADING = "# Hermes runtime environment"` and
  `RUNTIME_ENVIRONMENT_END = "<!-- End Hermes runtime environment -->"`
  (`agent/prompt_builder.py:1134-1135`), appended to the volatile tier
  (`agent/system_prompt.py:796`). This heading appears verbatim at the top of this session.
- **L4 — The profile line names Hermes.** `_active_profile_line()`
  (`agent/system_prompt.py:373-410`) emits `"Active Hermes profile: kai. This session reads and
  writes …/. The default profile's data lives at …/skills/ …"` — a Hermes-specific boot string.
- **L5 — Help guidance declares the agent runs on Hermes.**
  `HERMES_AGENT_HELP_GUIDANCE` (`agent/prompt_builder.py:171-180`) says *"You run on Hermes Agent
  (by Nous Research) … the documentation at https://hermes-agent.nousresearch.com/docs …"*, injected
  into the stable tier when the `hermes-agent` skill is present (`agent/system_prompt.py:751-757`).
  The `hermes-agent` skill **is** installed in the `kai` profile
  (`profiles/kai/skills/autonomous-ai-agents/hermes-agent/`).
- **L6 — The default profile's SOUL.md is a Hermes identity document.**
  `C:\Users\DELL\.hermes\SOUL.md` contains, verbatim and on one line:
  `"You are Hermes Agent, built by Nous Research. Be direct: …"`. Any session that resolves to the
  default home loads a Hermes identity, not a KAI one.
- **L7 — Memory/skills guidance is Hermes-contract wording.** `build_memory_guidance`
  (`agent/prompt_builder.py:193-224`) frames memory around the Hermes memory tool and its schema.
- **L8 — Platform toolsets are Hermes-named.** `profiles/kai/config.yaml:153-168` maps platforms to
  `hermes-cli`, `hermes-discord`, `hermes-telegram`, … — Hermes-internal toolset ids.
- **L9 — Hermes branding assets ship in the same tree.** `assets/nous-girl-black.svg`,
  `nous-girl-white.svg`, `banner.png`, `icon-master*.svg` (see §5.3 — DO NOT IMPORT).

### 8.B Leaks in KAI's own boot path (KAI depends on a Hermes install)

KAI's Core is KAI-owned and does **not** load Hermes identity documents — its composer uses
`core/src/agent/soul.ts` (KAI_HOME). But KAI's boot still reaches into a Hermes install and names
Hermes in a few places:

- **L10 — KAI reads the Hermes install's own `.env` at boot.**
  `core/src/agents/hermes-key.ts:51-59` reads `join(home, ".hermes", ".env")` for `API_SERVER_KEY`;
  `withResolvedHermesKey()` (`:78`) is applied **at boot** for both the adapter and the chat client
  (`core/src/server.ts:952`, `core/src/server.ts:947` comment). So KAI's credential resolution
  depends on a Hermes filesystem path. *Final-KAI fix: prefer `KAI_HERMES_KEY` / KAI-owned config;
  keep the Hermes path only as an explicitly-labelled legacy fallback, or drop it.*
- **L11 — The KAI adapter self-names "Hermes Agent".** `core/src/agents/adapters/hermesAdapter.ts:279`
  returns `name: "Hermes Agent"`; `core/src/agents/mock.ts:232` mirrors it. This name is provenance
  for a *worker*, not KAI's identity — acceptable, but it is the string that a naive relay would
  surface.
- **L12 — KAI hard-codes a Hermes endpoint and a Hermes fallback.**
  `core/src/config.ts:56` `HERMES_URL: "http://127.0.0.1:8642"`;
  `core/src/workforce/discovery.ts:564` `HERMES_DEFAULT_BASE_URL`.
  More importantly, `core/src/server.ts:438` **hard-codes Hermes** as the worker for an unrecognised
  turn (the `unknown` fall-through calls `hermes.sendChat(...)`). *Final-KAI fix: choose the worker
  from the router's decision / configuration, not a literal default.*
- **L13 — KAI's soul names Hermes as a worker (acceptable, not a leak of identity).**
  `core/src/agent/soul.ts:4-5,58` and `core/src/agent/kai-home.ts:84` name Hermes and OpenCode as
  tools KAI may delegate to, explicitly *"not my identity and not my supervisors."* This is correct
  provenance language and should stay.

### 8.C KAI already defends against worker-identity leakage

KAI has a real, adversarially-developed relay boundary: `core/src/chat/relay.ts` strips a worker's
self-identification and KAI-prompt-internals sentences by **grammatical form** (not a phrase
blocklist — `relay.ts:22-25`), and `relayGuardIsLive()` (`relay.ts:276`) is a boot-time self-test
that refuses to serve if the compiled guard is a no-op (`relay.ts:252-283`). This is a KAI asset to
keep; the leaks above (L1–L5, L10–L12) are the remaining places a Hermes identity can still enter,
bypassing or preceding that guard.

### 8.D What "KAI becomes itself" must eliminate

For KAI to boot, identify itself and operate with **Hermes entirely unavailable**
(`docs/KAI_STAGE1_FREEZE.md` §9), Phase C/D must ensure:

1. No KAI-loaded document or prompt contains a Hermes identity string (L1–L9) — the Hermes-hosted
   `kai` profile must not be part of KAI's boot path, and delegated sessions must not fall back to
   `DEFAULT_AGENT_IDENTITY`.
2. KAI's Core boot must not require a Hermes install path (L10) — credential resolution must be
   KAI-owned.
3. Worker selection must not default to a literal Hermes (L12) — a router/config decision must pick
   the worker, and "no worker available" must be a first-class state, not a hard-coded fallback.
4. The name "Hermes Agent" stays a **worker provenance label** only (L11, L13), never surfaced as
   the speaker — which `relay.ts` already enforces.

---

## 9. Recommended transplant order for Phase D

Ordered so that KAI's identity is secured **before** any Hermes mechanism is internalised, and so
that every step is independently verifiable. Each step keeps KAI's own boundaries.

1. **Identity boundary first (no code copied).** Close L1–L12 in §8 — remove Hermes identity from
   KAI's boot path and any prompt KAI loads; make KAI's credential resolution KAI-owned; replace the
   hard-coded Hermes fallback (server.ts:438) with a router/config decision. *Acceptance: KAI boots
   and identifies as KAI with the Hermes install made unavailable. This is the hard test from
   freeze §9.*
2. **Low-risk, self-contained KAI gaps** (pure additions, no KAI system touched):
   - C15 ADAPT — FTS5 session search over KAI's own session DB.
   - C12 ADAPT — insights aggregation over the action-record store.
   - C8/C14 ADAPT — bounded deadline primitive + resumable ESTOP sentinel; iteration budget.
   - C16 ADAPT — context-local, fail-closed secret scope (only if KAI multiplexes contexts).
3. **Skills and memory-adjacent additions** (extend, never replace):
   - C4 ADAPT — on-disk skill discovery + metadata-only index, keeping KAI's staging/approval gate.
   - C3 ADAPT — advisory curator that proposes **staged** skill changes only; **never** the binary
     self-replacement loop.
4. **Learning and context** (larger, touches the composer's neighbourhood):
   - C11 ADAPT — advisory learning graph + user-editable learned nodes.
   - C9 ADAPT — auxiliary-model context compression that respects KAI's section budget/fence model.
5. **Worker boundary (nothing from Hermes's internals):** keep Hermes as a worker behind
   `core/src/agents/adapters/hermesAdapter.ts`; never import Hermes's `agent/` prompt or identity
   code. This step is a **non-transplant** — record it as such.
6. **Re-verify the freeze.** Re-run `docs/KAI_STAGE1_FREEZE.md`'s proven capabilities and adversarial
   suites (memory isolation, approval binding, policy, artifact identity, relay guard) against the
   artifact under test. A green suite only counts when run against the artifact being shipped
   (freeze §7).

**Explicit non-goals for Phase D:** do not copy any Hermes code line-for-line (Python → TS);
do not import the Hermes `DEFAULT_AGENT_IDENTITY`, `HERMES_AGENT_HELP_GUIDANCE`,
`RUNTIME_ENVIRONMENT_HEADING`, or any `HERMES_*` string; do not import the Hermes brand assets
(`nous-girl-*.svg`, `banner.png`, `icon-master*.svg`); do not adopt the Hermes binary-replacement
upgrade loop.

---

## 10. NOT FOUND / NOT VERIFIABLE register

Stated plainly, as required by this project's honesty rules.

- **NOT VERIFIABLE — install tree == git checkout.** The workspace install has no `.git`; equality
  with `C:\Users\DELL\.hermes\hermes-agent\` at commit
  `1ad2eb1ecf00b9989dd981e496667501a69fc493` cannot be recomputed beside it. Consistency in
  structure is observed; equality is not claimed.
- **NOT VERIFIABLE — semantic version.** `hermes --version` prints `vunknown`; `pyproject.toml`
  and egg-info both say `0.0.0`. No semantic version exists to pin.
- **NOT VERIFIABLE — third-party dependency licences.** The licences of the transitive npm and
  PyPI packages vendored under `node_modules/` and the `venv/` were not enumerated. Each must be
  read from its own files before any use; unknown ⇒ DO NOT IMPORT pending clarification.
- **NOT FOUND — a Hermes NOTICE / brand carve-out file.** None exists at the source root. This is
  a fact, not a grant (§5.3): absence of a carve-out is **not** permission to reuse the name or art.
- **NOT FOUND — a Hermes NL mission planner.** Missions are authored explicitly in KAI
  (KAI_HARNESS §9); no Hermes counterpart was read that fills this, so it is not listed as a
  transplant source.
- **NOT FOUND — `agent/bot_mode.py`, `tools/delegate_task.py`.** These exact paths do not exist;
  Bot Mode lives elsewhere (`tools/bot_mode_probe`, referenced at `agent/system_prompt.py:350`) and
  the delegation tool is the `tools/delegate_tool*.py` family. Named so no wrong path is carried
  into Phase D.
- **NOT VERIFIABLE — `mcp/WIRING.md` depth and the full MCP catalog.** KAI wires MCP behind its tool
  boundary (KAI_HARNESS §21); the breadth of Hermes's `optional-mcps/` catalog was not enumerated,
  and no per-server licence was read.
- **NOT VERIFIABLE — the exact live system prompt of the `kai` profile in a normal (non-delegated)
  session.** This audit reproduced the *delegated subagent* prompt (L2) directly and read the
  *code* that produces the boot prompt (L1, L3–L5); it did not dump the persisted `system_prompts`
  row of a live non-delegated `kai` session to prove the exact emitted bytes.

---

*End of audit. Read-only. One document written: `docs/HERMES_TO_KAI_MIGRATION.md`.*
