# KAI architecture audit — before making KAI the main agent

Phase A of the "KAI is the main agent" work. **Nothing was modified to produce this.**
Every claim carries a `file:line`; where a document and the code disagreed, the code won
and the document is named as wrong.

Three independent read-only audits (Core internals, the app/Rust layer, and Cua) plus a
live baseline were combined here. Tests at audit time: **Core 229 (227 pass, 0 fail, 2
skipped), app 57/57, both typechecks clean, packaged app and Core both running.**

---

## 1. The headline: the acceptance question, answered honestly

> *"If I launch KAI and talk to KAI, is KAI actually the main agent — or am I secretly
> just chatting with Hermes through a KAI UI?"*

**Today: you are chatting with Hermes.** Not metaphorically. `claude.rs` `send()`
(`app/src-tauri/src/claude.rs:98`) tries three providers in order and returns on the
first success:

1. `hermes_chat()` **first** (`claude.rs:108-114`) — `POST 127.0.0.1:8642/v1/runs`.
2. `core_chat()` second (`claude.rs:120-127`) — `POST 127.0.0.1:8788/chat`.
3. Direct Anthropic last (`claude.rs:129-208`).

Hermes is up and authorised on this machine, so paths 2 and 3 are never reached for a
normal turn. The front end's own Core client has a `chat()` method with **zero call
sites** in `app/src` — Core is reached only by Rust, and only after Hermes declines.

So the required answer — *"KAI is the main agent. Hermes and OpenCode are workers."* — is
**not true yet**. This audit is the map from here to there.

## 2. Verdicts

| # | Area | Verdict | Basis |
|---|---|---|---|
| 1 | KAI agent reasoning loop | **NOT IMPLEMENTED** | No loop anywhere re-invokes a model or worker after evaluating a result. The most multi-step flow in the Core is the mission executor (`core/src/missions/executor.ts:189-282`), which runs a **pre-declared** step list once, in fixed index order, with no observe/evaluate/retry: a failing step sets FAILED and returns (`executor.ts:255-265`), and a step's output is stored but never read back to choose the next step. |
| 2 | KAI identity / personality | **NOT IMPLEMENTED** | No system prompt, persona, role or goals anywhere in `core/`. The only "intelligence" is a 9-regex router (`core/src/chat/router.ts:124-199`) whose intents are `status.summary, agent.status, agent.list, mission.list, approval.list, notification.list, memory.list, memory.remember, artifact.run_tests, unknown`. |
| 3 | KAI sessions | **NOT IMPLEMENTED** | No `sessions` table (`core/src/storage/schema.ts:37-204`), no Session type in `contracts.ts`, no session UI. `session_id` exists only inside Rust (`claude.rs:57`) and is passed to Hermes. |
| 4 | Agent manager (worker control) | **PARTIAL** | `AgentRegistry` + two adapters implement the same 8 methods, and `runTask` is real (Hermes: `POST /v1/runs` then poll; OpenCode: session + `POST /session/{id}/message`). But **nothing decides which agent to use** — the agent is always named by the caller (`runtime.ts:256`, `api/routes.ts:568`). The one expressed preference (`router.ts:520-541`) is unreachable in production. |
| 5 | Permissions / policy | **PARTIAL, with a hole** | Risk levels READ/WRITE/EXTERNAL/DESTRUCTIVE with safe defaults (`gate.ts:68-73`) and real enforcement in the tool registry. But the shipped process runs with **zero rules** (`server.ts:575` calls `createCoreRuntime()` with no options), policy is **fixed at construction** and not runtime-configurable, there is **no SENSITIVE class**, and **`POST /agents/:id/action` runs `runTask` with no policy check at all** (`api/routes.ts:568-588`) — agent work escapes the boundary the runtime claims is mandatory. |
| 6 | Approval loop | **BROKEN** | A `needs_approval` step parks the mission (`executor.ts:220-229`), but nothing resumes it: `decide` is only called from `api/routes.ts:458`, which does not touch the mission. No production caller passes `approvalId`, so the registry's approve-and-execute branch (`registry.ts:210-274`) is unreachable. `expireStale` (`approvals/service.ts:164`) is called only by tests, so approvals never expire. |
| 7 | Tool registry | **PARTIAL** | The registry is real (`validate → policy → approval → execute`). Only **four tools** exist, all risk READ: `system.get_status`, `agents.list`, `missions.list`, `memory.list` (`tools/builtin.ts:124-219`). No filesystem, shell, browser, screenshot, process control, git — by design for now (`builtin.ts:9-11`). |
| 8 | Memory | **PARTIAL** | Real and persisted, but **flat/global**: no sessionId/missionId/agentId column (`schema.ts:146-155`); every read is the whole table filtered by `type` at most. `search` and `forget` have no production caller; the declared `agent_runs` "run history" table has no writer at all. |
| 9 | Scheduler | **PARTIAL, effectively dead** | Wired and tested, but nothing can create a task: there is no schedule route and the only `upsertScheduledTask` caller is the scheduler itself (`scheduler.ts:112`). The shipped process always runs an empty scheduler, so the "a due task runs a mission" path (`runtime.ts:309-318`) is unreachable. |
| 10 | Core lifecycle | **PASS** (other session) | `app/src-tauri/src/core_process.rs` adopts a running Core or spawns one, watches it on a 4s loop, restarts one it started, and ties its life to KAI with a kill-on-close job object (`core_process.rs:290-309,419-424`). Committed as `eb13b88`. |
| 11 | Chat ownership | **NOT IMPLEMENTED** (inverted) | See §1. Core is the *fallback*, not the owner. |
| 12 | Computer use (Cua) | **BLOCKED for Hermes-as-channel, READY for KAI direct** | See §4. |
| 13 | Permissions visible in the UI | **NOT IMPLEMENTED** | No permissions view or settings section exists; `views.ts:308` records that "Always" was removed from the approval card "until the remembered-rules list exists to back it". |
| 14 | Sessions visible in the UI | **NOT IMPLEMENTED** | Up to 3 Hermes session titles render as static, non-clickable text inside the Hermes card (`views/integrations.ts:430-437`); no create/switch/rename/archive surface anywhere. |

## 3. What the app and Rust layers own (so nothing working gets destroyed)

Genuinely Rust/OS-only and staying there: window placement incl. DPI×text-scale
(`island.rs:262-287`), the cursor poll and click-through (`island.rs:343-463`), the wake
monitor, non-activating window styles, file-drop ingest (`files.rs:26-68`), the Claude
Code hook relay and approval pipe (`pipe.rs`), tray, settings persistence, **secrets**,
autostart, single instance, logging.

**Secrets are handled well and must not be widened.** Keys live in the Windows
Credential Manager behind an allow-list (`secrets.rs:6-31`); the front end can only ask
*whether* a key exists (`secret_present` returns bool) or write one — there is no
read-back command. Rust hands the Core its Hermes key through the **child process
environment** (`core_process.rs:321-325`), never a file or log line. The widened CSP
changes only which host the page may fetch. One stale doc to fix: `docs/security.md:49-50`
still claims `connect-src` is `ipc:` only.

**Duplicates to reconcile later** (two producers writing the same UI field — the
fragmented state the master spec warns about): agent pills are written by both the Rust
pollers (`integrations.rs:842-1093`) and the Core mirror (`core-bridge.ts:90-98`);
sessions, approvals and the note bubble each have two producers; OpenCode permissions are
handled end-to-end in Rust (`integrations.rs:1127-1145`) in parallel with Core approvals.

**Navigation to reuse** (do not replace): 17 `IslandViewName`s (`layout.ts:7-24`), a
`buildViews()` map (`views.ts:501-523`), header tabs + gear (`views.ts:81-86`), tray menu
(`tray.rs:10-17`). `greeting` is canvas-backed and three views (`mail`, `searching`,
`result`) are unreachable placeholders — do not reuse those names.

**Dead code found** (unreachable from any production path, verified by call-site grep):
`EventStore.listEvents` never read; `Bridge.coreStatus`/`core_status` never called, so
the Core's pid/origin/restarts never reach a user; `Backend.quit`; `kai-core.ts`'s
`chat/health/agents/...` have no app call sites; `TOGGLEABLE_INTEGRATION_IDS`;
`memory.search/forget`; `EventBus.recent`; `approvals.expireStale`;
`isBuiltinToolId`; `contracts.ts`'s `CoreHealth/CoreLifecycle/Diagnostics`; the `settings`,
`agents` and `agent_runs` tables; write-only `promptContext`/`searchResult`. Off-contract
event types leak to the bus: `registry.ts:65,69` emits `agent.registered`/`agent.unregistered`,
which are not in `KaiEventType`, cast through at `runtime.ts:179`.

## 4. Computer use: where it should come from

**Verified on this machine** (not documentation):

- `cua-driver` **0.28.2** is installed at
  `C:\Users\DELL\AppData\Local\Programs\Cua\cua-driver\bin\cua-driver.exe` and **a daemon
  is already running** on the named pipe `\\.\pipe\cua-driver`.
- `cua-driver call list_windows` returned **real live windows** (title/pid/window_id/bounds);
  `get_cursor_position` → `{"x":834,"y":615}`; `get_screen_size` → `1920×1080`. No VM, no
  Docker, no install step, and it did not steal focus.
- The binary Hermes bundles (`~/.hermes/tools/cua-driver-0.21.0`) **fails** against that
  daemon: `contract version 0.8.0 does not match SDK 0.7.0`. The version you invoke is a
  real hazard.
- Hermes' api-server **cannot** be KAI's computer-control channel: `GET /v1/toolsets`
  reports `computer_use` with `enabled=false`, the api-server profile drops it, and there
  is **no endpoint that names and invokes a tool** — only natural-language runs
  (`/v1/runs`, `/v1/chat/completions`, `/v1/responses`), whose tool calls execute
  server-side inside Hermes' own loop.
- Licence: Cua is MIT. The optional `cua-perception`/OmniParser pieces are AGPL-3.0-only —
  do not install them.

**Decision:** KAI owns its own cua-driver client; Hermes keeps `computer_use` for
Hermes-only turns. Two independent callers, one driver. The trade-off accepted: KAI now
owns the driver-version pin and its own approval surface for desktop actions, and loses
Hermes' unified approval UX for them.

## 5. The five largest gaps between the documented architecture and the code

1. **No orchestration loop exists at all.** Docs describe a control layer whose
   intelligence lives in the agents; the code agrees, and nothing implements "KAI decides,
   plans, delegates, supervises". Every path is single-shot.
2. **The "mandatory boundary" claim is only partly true.** Agent work bypasses policy
   (`api/routes.ts:568-588`), the chat relay reaches Hermes directly (`server.ts:285`),
   parked missions never resume, and approvals never expire — while the docs state that
   nothing reaches the machine except through the tool/policy layer.
3. **The scheduler cannot be given a task**, yet is documented as the proof that the Core
   is a persistent runtime.
4. **Memory is flat**, so "remembers across restarts" holds for one global list only, and
   run history is never recorded despite a table existing for it.
5. **KAI has no identity and no native session layer.** Its voice is 9 regex templates and
   its memory of a conversation is whichever Hermes session id the caller happens to hold.

## 6. What this means for phases B–L

The audit reorders the plan in two places, and those are the honest deviations from the
brief's phase list:

- **The chat order must be inverted first (before Phase B).** Adding a personality to a
  Core the user's messages never reach would be building a brain nothing talks to. The
  smallest honest step is: Core becomes the path for chat, and Hermes becomes something
  Core calls. That single change is what makes every later phase observable.
- **Permissions must become runtime-configurable before they can be shown (Phase G).**
  Policy is constructed once with no rules; a UI that displays or edits permissions
  requires the gate to accept and expose rules at runtime, and the spec's requirement that
  "changing a permission in the UI must change the actual policy used by KAI" cannot be
  met otherwise. The `SENSITIVE` class and the `POST /agents/:id/action` bypass are part
  of the same work.

Everything else proceeds as the brief lists it: B identity, C loop, D tool registry,
E agent manager, F sessions, G permissions, H Cua, I supervision/recovery, J UI,
K lifecycle (mostly done), L end-to-end verification.
