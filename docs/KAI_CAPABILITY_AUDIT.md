# KAI — Capability Audit (evidence-based, against the running product)

**Auditor:** read-only capability-audit pass. Only writes: `docs/KAI_CAPABILITY_AUDIT.md` and
`docs/kai-capabilities.json`. No source was edited.

**Audit time:** 2026-10-03T20:18Z. **Repo:** `C:/Users/DELL/Desktop/kai`, branch `master`,
committed **HEAD `9ffa57b`** ("verify(appearance): live product evidence — skin+outfit apply,
persist across restart").

> ### READ THIS FIRST — the tree is NOT frozen
> Five other agents were editing this repository *while this audit ran*. `git status` was
> re-checked immediately before writing, and it changed between checks. Every finding below is
> labelled **against-committed-HEAD** or **in-flight (uncommitted)**. **Do not read an in-flight
> claim as landed.** At the moment of writing, the working tree modified:
> `app/src-tauri/src/{island,lib,settings,tray}.rs`, `app/src/character/{engine,orb}.ts`,
> `app/src/island/island.ts`, `core/src/chat/relay.ts`, `core/src/server.ts`,
> `core/tests/session-switch.test.ts`; untracked: `core/tests/routing-relay.test.ts`,
> `app/assets/kai/KAI_ACTION_INVENTORY.md`, `core/scripts/_probe-subagent*.ts`,
> `docs/evidence/phase6-head-core-live.txt`, `docs/evidence/verify-pass/character/`.

> ### Status vocabulary (exactly one per row)
> `READY` · `PARTIAL` · `BROKEN` · `MISSING` · `BLOCKED BY EXTERNAL DEPENDENCY` · `NOT VERIFIED`
>
> **This audit obeys the owner's rule:** no percentage scores, no invented counts. Every number
> is quoted from a live endpoint, a file on disk, or a source table. Where a number could not be
> obtained it says `UNKNOWN` and why. **Code existing is not evidence a capability works; a unit
> test is not evidence of a product capability.** Anything not exercised in the live product is
> marked `NOT VERIFIED`, not `READY`. A prior commit in this repo passed 683+107 tests and both
> typecheckers while **four of its live claims were false** — so tests are treated as zero-weight
> here against the product surface.

---

## 0. Method

- **Live product:** KAI Core was already running at `http://127.0.0.1:8788` (pid 24140, build
  `f9ec04f5a7576be7`, gitCommit `9ffa57be3ff90ca3373a431bb722ac15a875e5e1`, started
  2026-10-03T19:58:45Z). I queried it with `curl`/`urllib` in the foreground.
- **Health probes:** `GET /capabilities/:id` runs the capability's real probe;
  `POST /capabilities/:id/test` runs a real action through the full policy/approval boundary.
- **Filesystem/SQLite:** `%LOCALAPPDATA%\KAI` measured directly.
- **Source:** `file:line` read/grepped at HEAD; in-flight diffs read from `git diff`.
- **Live chat intents** exercised over `POST /chat` (state intents answer from Core, no model turn).

---

## 1. Measured numbers — every one with its source

All from the live Core at HEAD unless noted. **Nothing here is estimated.**

| # | Metric | Value | Source (raw) |
|---|---|---|---|
| 1 | Capabilities | **7** | `GET /capabilities` → `system, browser, computer, mcp, filesystem, git, shell` |
| 2 | Tools registered | **42** | `GET /state` → `{"tools":{"registered":42}}` |
| 3 | Employees | **3** | `GET /employees` → hermes `READY`, opencode `READY`, codex `UNAVAILABLE` |
| 4 | Available workers | **2** | `GET /agents` → `hermes idle`, `opencode idle` (codex unavailable) |
| 5 | Skills installed | **2** | `GET /skills` + `%LOCALAPPDATA%\KAI\core\skills\installed\` (2 dirs) |
| 6 | Candidate (staged) skills | **4** | `GET /skills/staging` → 4 staged entries |
| 7 | Memory records | **7** | `GET /memory` → 7 memories (legacy store) |
| 8 | Sessions | **33** | `GET /sessions` |
| 9 | Subagents | **2** | `%LOCALAPPDATA%\KAI\core\kai-subagents.json` → `alice`, `bob` |
| 10 | Schedules | **11** (`enabled 0`) | `GET /schedules`, `GET /state` → `{"running":true,"enabled":0,"total":11}` |
| 11 | Checkpoints | **12** | `GET /checkpoints` |
| 12 | Approvals (total) | **116** | `GET /approvals` |
| 13 | Missions (total) | **107** (`active 0`, `unfinished 0`) | `GET /missions`, `GET /state` |
| 14 | Notifications | **49** (`unread 17`) | `GET /notifications`, `GET /state` |
| 15 | Recovery-ledger records | **42** (`open 0`) | `GET /recovery/status` → `{"open":[],"total":42}` |
| 16 | **MCP servers configured in product** | **0** | `GET /capabilities/mcp` → `"no MCP server is configured or connected"` |
| 17 | **Plugins** | **0 / none** | grep over `core/src`,`app/src` → no plugin registry/loader/route/UI |
| 18 | Character skins | **3** | `orb.ts` `SKN` via `variant.ts` `SKINS` → blue, black, yellow |
| 19 | Character accessories (outfits) | **8** | `variant.ts` `ACCESSORY_SET` → none, hair, cap, bat, phones, cat, crown, halo |
| 20 | Character colour themes | **11** | `orb.ts` `THM` → aqua, wake, sky, mint, sun, rose, plan, help, progress, error, ultra |
| 21 | Character named poses | **34** | `app/assets/kai/KAI_ACTION_INVENTORY.md` (NM table) |
| 22 | Character eye expressions | **23** | `KAI_ACTION_INVENTORY.md` (EY table) |
| 23 | Character pose-z gallery faces | **30** | `KAI_ACTION_INVENTORY.md` (PZ/KEEP) |
| 24 | Runtime character states | **12** | `app/src/core/runtime-state.ts` `KaiRuntimeState` |

**Numbers I could NOT obtain (stated honestly):**

- **MCP tools discoverable in the product: 0 / UNKNOWN as a product number** — no MCP server is
  registered, so there is no product tool list. (The `cua-driver` MCP server, used *internally* by
  the computer transport, exposes **57 tools** per `real-transport.ts` header and is invoked over
  MCP stdio — see §3.1.)
- **Installed-skill count is 2, but note the id mangling**: `nightly-verification-routine-1f865f`
  and `ph4-nightly-deploy-912d29` were auto-generated by the learning pipeline; their `description`
  field is literally `"1"` (a probe artifact), not a real description.
- **Tool *ids*: UNKNOWN as a list** — `/state` gives only the count (42). There is no `/tools`
  route (`GET /tools` → `{"error":"not_found","reason":"unknown_route"}`).

**Capability health, probed live at HEAD** (`GET /capabilities/:id`, which runs the real probe):

| Capability | Probe availability | Detail (raw) |
|---|---|---|
| system | **AVAILABLE** | `no transport connected` (trivially in-process) |
| browser | **AVAILABLE** | probe healthy; **declared snapshot is UNAVAILABLE until probed** |
| computer | **AVAILABLE** | `cua-driver connected` |
| mcp | **UNAVAILABLE** | `no MCP server is configured or connected` |
| filesystem | **AVAILABLE** | `node fs is available; filesystem.read/list are READ, filesystem.write is WRITE` |
| git | **AVAILABLE** | `git version 2.53.0.windows.3` |
| shell | **AVAILABLE** | `program execution works via …node.exe` |

**Live chat intents I exercised this audit** (`POST /chat`, all answered by Core from state,
`from_state:true`, no worker turn):

| Asked | Intent | Reply (quoted) |
|---|---|---|
| "who are you?" | `identity` | "I am KAI. Hermes and OpenCode are workers I can use; I'm still KAI when they are unavailable." |
| "are you hermes?" | `identity` | "No — Hermes is a worker I can use, not what I am. I am KAI." |
| "status" | `status.summary` | "KAI status: 2 agent(s) — hermes (idle), opencode (idle); 0 active mission(s); 0 approval(s) pending." |
| "what missions are running?" | `mission.list` | "No missions are running right now." |

**Live capability actions I exercised at HEAD:**

- `POST /capabilities/system/test` → HTTP 200, real process/CPU/memory status.
- `POST /capabilities/git/test` → HTTP 200, **real `git status` of the working tree** (branch
  `master`, dirty, listing the same files `git status` shows).
- `POST /capabilities/{browser,computer,mcp,filesystem,shell}/test` → HTTP **409**, each parked on a
  real approval (`approvalRequired:true`), i.e. **governed, not absent**.
- `GET /capabilities/{system,browser,computer,mcp,filesystem,git,shell}` → probed health table above.

---

## 2. Full status table

Columns: **Status · Evidence (raw, quoted) · Location (file:line) · Works · Missing/Blocker ·
Verification method**. Grouped by domain. `[HEAD]` = committed; `[IN-FLIGHT]` = uncommitted.

### 2.1 Identity

| Capability | Status | Evidence | Location | Works | Missing / Blocker | Verify |
|---|---|---|---|---|---|---|
| **KAI build identity** | `READY` | `GET /identity` → `{"service":"kai-core","buildId":"f9ec04f5…","gitCommit":"9ffa57b…","pid":24140,"startedAt":"…"}` | `core/src/identity.ts` `loadIdentity()` | real build/pid/commit, checksummed | — | `curl /identity` |
| **KAI persona ("who am I")** | `READY` | live: `"who are you?"→identity→"I am KAI…"`; `"are you hermes?"→"No — Hermes is a worker…"` | `core/src/agent/soul.ts` `createKaiIdentity` (soul.ts:148); router identity intent `core/src/chat/router.ts` | answers from SOUL.md, refuses worker confusion, no model turn | no UI editor (see §3.5) | exercised live |
| **SOUL.md** | `PARTIAL` | file `%LOCALAPPDATA%\KAI\SOUL.md` 2790 bytes; seeded + reloaded on `(mtime,size)` | `core/src/agent/kai-home.ts` (seed :40–142); `core/src/agent/soul.ts` | loaded into every composed turn (`compose.ts:276-283`); redacted; bounded 8000 chars | **no UI/route editor**; editable only via `soul.set` tool or the file | read file; grep routes |
| **USER.md / user profile** | `PARTIAL` | file 328 bytes, still the seed text ("nothing recorded yet"); composed as `user-context` | `kai-home.ts:101-142`; `compose.ts:281` | read into the turn as *instruction* | **no setter found** (no `replaceUser`/route/tool); no UI | grep `replaceUser` → none |
| **Long-term memory** | `READY` | `GET /memory` → 7 records; `POST /memory/write` → 201 (`provenance` defaults to most-restrictive `system_state`); `GET /memory/journal` | `core/src/memory/*`, `core/src/storage/memoryStore.ts` | bounded, provenance-tagged, scope-isolated, append-only journal, dedup by hash | no vector/semantic search (FTS5 or token scan only); **no memory UI** (see §3.5) | live endpoints + phase6 evidence |
| **Session system** | `READY` | `GET /sessions` → 33; exactly-one-ACTIVE invariant; turns recorded | `core/src/sessions/{store,service,index}.ts`; own SQLite `kai-sessions.db` | durable, per-turn, worker `agentSessionId` bound to KAI session | no session search/export | live |
| **Session switching** | `READY` | `e9e223d fix(app): switching a KAI session now changes the conversation shown`; `POST /sessions/:id/activate` | `sessions/service.ts`; app `claude.rs` per-session history | switching changes the shown conversation (fix landed) | — | commit + route |

### 2.2 Subagents

| Capability | Status | Evidence | Location | Works | Missing / Blocker | Verify |
|---|---|---|---|---|---|---|
| **Subagent sessions / roster** | `READY` | `kai-subagents.json` → `alice` (worker hermes), `bob` (worker opencode), each with soul/role/capabilities/model/visual | `core/src/workforce/subagent.ts`; `runtime.ts:2265-2313` | personas persist; registered into the ONE workforce; policy-governed | no HTTP route (created via `workforce.subagent` tool) | read file |
| **Subagent identity** | `READY` | each persona has its own `soul` string (`"I am Alice…"`) | `subagent.ts` `KaiSubagentSpec`; persisted | distinct persona per subagent | — | file |
| **Subagent personality** | `READY` | `role` + `soul` per spec | same | distinct per persona | — | file |
| **Subagent visual identity** | `PARTIAL` | `visual:{variant,colour,outfit,accessories}` persisted; **but** `createSubagentRegistry` is called with `{path}` only | `runtime.ts:2272-2274`; `subagent.ts` `resolveVisual` | a *declared* reference is stored (`alice → kai-variant-teal / lab coat / glasses`) | **no `KaiVariantResolver` wired** → the declared variant never resolves to a real asset; app `variant.ts` not connected to Core registry | grep runtime wiring; harness doc §5 |
| **Multi-agent parallel execution** | `PARTIAL` | workforce + `agents.run_task` exist and run (phase6: real Hermes task returned `PARTU-WORKER-OK`) | `core/src/workforce/*`, `runtime.ts:927-936` | delegation runs through the one boundary | no evidence of *parallel* multi-subagent fan-out; no scheduler-of-subagents | phase6 evidence; no parallel runner found |

### 2.3 Character system

| Capability | Status | Evidence | Location | Works | Missing / Blocker | Verify |
|---|---|---|---|---|---|---|
| **Character system** | `READY` | Canvas-2D port; 3 skins / 8 accessories / 11 themes / 34 poses / 23 eye expr / 30 gallery faces | `app/src/character/{orb,engine,variant,actions,types}.ts`; asset `app/assets/kai/KAI_matrix_orb_v17.html` | renders, skins+outfits apply and **persist across restart** (commit `9ffa57b` evidence) | some source features explicitly **not ported** (turbulence, shard 3-D, 3-D eye mode, glitch bars, pose-z gallery props) — `orb.ts:20-26` | commit + inventory doc |
| **Character actions** | `READY` | `ACTION_NAMES = Object.keys(KAI_ACTIONS)`; 34 poses + standalone (`eye-mode`,`shatter`) + props + interactions + idle loops | `app/src/character/actions.ts` | machine-readable registry, `pickAction` deterministic | several actions are **reference-only** (pose `null`, `steps:[]`) — declared but with no runtime steps | read actions.ts |
| **Character animation** | `READY` | `SC` step-sequences, 30 spring integrators | `orb.ts` (`SC`, `ST`, `JD`) | spring-interpolated poses | not all source animation ported | `KAI_ACTION_INVENTORY.md` |
| **Character event mapping** | `READY` | `stateForEvent()` maps real Core events → 12 runtime states; `characterStateFor()` → pose | `app/src/core/runtime-state.ts` `stateForEvent:156`, `characterStateFor:101` | 12 states driven by real events; SUCCESS/ERROR hold 4s; OFFLINE after 1.5s grace | `turn.*`/`item.*` branch is **dead on the wire** (harness §19) | read source; harness doc |

### 2.4 Island

| Capability | Status | Evidence | Location | Works | Missing / Blocker | Verify |
|---|---|---|---|---|---|---|
| **Island movement** | `MISSING` `[HEAD]` / `PARTIAL` `[IN-FLIGHT]` | At HEAD: no drag/position code (`git show HEAD:…lib.rs` has no `start_island_drag`). **In-flight** adds `start_island_drag`, `Moved` event capture, `island_pos` persistence | `app/src-tauri/src/island.rs`, `lib.rs`, `settings.rs` `[IN-FLIGHT]` | HEAD: island is **placed** at top-centre of chosen display; not user-movable | free move is uncommitted → `NOT VERIFIED` | `git diff` |
| **Island resizing** | `PARTIAL` | two fixed logical sizes: `PANEL_W=720, PANEL_H=320` ↔ `STRIP_W=240, STRIP_H=6` | `island.rs:27-31`; `apply_geometry` | auto-resizes between full panel and wake strip; click-through recomputed from `set_island_rect` | **not free/user-resizable** | read source |
| **Island minimize / hide** | `READY` `[HEAD]` | `set_collapsed(true)` → wake strip + parked poll; `spawn_wake_monitor` restores on hover | `island.rs`; `lib.rs:93-102` `set_collapsed` | collapse to invisible 240×6 strip; hover wakes | — | read source |
| **Island restore** | `READY` `[HEAD]` | `spawn_wake_monitor` (24 Hz) wakes on cursor; `set_collapsed(false)` | `island.rs`; `lib.rs` `reposition` | restore works | — | read source |
| **Island close** | `PARTIAL` | At HEAD: tray "Quit" (`quit_app`) quits the **whole app**. **In-flight** `close_island` hides only the window | `lib.rs:186` `quit_app` `[HEAD]`; `lib.rs` `close_island` `[IN-FLIGHT]`; `tray.rs` | HEAD: quit = app exit; in-flight adds window-only close + tray reopen | window-only close is uncommitted → `NOT VERIFIED` | `git diff` |
| **Island placement persistence** | `PARTIAL` `[HEAD]` / `READY` `[IN-FLIGHT]` | HEAD persists `screen:"primary"|"cursor"` in `%APPDATA%\KAI\settings.json`; **in-flight** adds `island_pos:{x,y}` physical pixels | `settings.rs` | HEAD: display preference persists, **not exact position**; in-flight: exact drag position persists + clamped on-screen | exact position is uncommitted | read source |

**Blunt summary — island:** at committed HEAD the island can be **collapsed/hidden and restored** and
**placed on a chosen display**; it **cannot be freely moved or resized**, and "close" means quitting
the app. Free drag-move, exact-position persistence and window-only close are **in-flight and
unverified**.

### 2.5 Browser & computer use (CUA)

| Capability | Status | Evidence | Location | Works | Missing / Blocker | Verify |
|---|---|---|---|---|---|---|
| **Browser / web surfing** | `READY (head not re-exercised)` | probe `AVAILABLE` at HEAD; full round-trip at `9c1d4f8` (phase6): `open → targetId`, `observe → [{role:heading,name:KAI-PARTU},{role:button,name:go}]` | `core/src/capabilities/browser/cdp-transport.ts`; wired `runtime.ts:1013` `ensureBrowser`, dispatch `1322-1356` | real CDP over installed Edge/Chrome; **semantic-first** (AX tree), screenshots fallback | EXTERNAL → parks on approval by default | probe + phase6 evidence |
| **Semantic browser** | `READY (head not re-exercised)` | `observe` returns AX elements (`ax:7 heading KAI-PARTU`, `ax:9 button go`) | `browser/interaction.ts` | DOM/accessibility observe, not pixels | — | phase6 T9 |
| **Computer use (CUA)** | `READY (head not re-exercised)` | probe `AVAILABLE` "cua-driver connected"; phase6 T7: approved `windows` → 33 windows, `first:{title:"KAI",app:"kai.exe"}` | `core/src/capabilities/computer/real-transport.ts`; wired `runtime.ts:1286-1320` | real MCP-stdio transport to `cua-driver` 0.28.2 + named pipe `\\.\pipe\cua-driver` | DESTRUCTIVE → parks on approval | probe + phase6 T7 |
| **Screen sharing / observation** | `PARTIAL` | CUA transport exposes `observe`/`inspect`/`windows`; `tools/call get_desktop_state` → `image/png` base64 (real-transport header) | `computer/observation.ts`, `control.ts` | screen *can* be observed via CUA (desktop state / windows) | no continuous screen-share stream to a remote; no worker events on the wire (harness §19) | read source |
| **CUA driver presence** | `READY` | `C:\Users\DELL\AppData\Local\Programs\Cua\cua-driver\bin\cua-driver.exe` (30,922,064 bytes, v0.28.2) | external | installed & connected | — | filesystem + probe |

### 2.6 CLI / Shell / Filesystem / Git

> **Owner's question, answered:** *is there a real governed shell capability, or only the
> `requirements: ['no <id> tool is implemented in KAI yet']` stubs?* — **Both statements were true
> at different times.** Those requirement strings are **gone**; `core/src/tools/workspace.ts` is a
> real implementation, wired at `runtime.ts:1467` (`for (const tool of createWorkspaceTools()) tools.register(tool)`)
> and dispatched from the capability tool at `runtime.ts:1281`. **A later commit's claim of "real
> shell/git/filesystem" is TRUE at HEAD — verified live below.**

| Capability | Status | Evidence | Location | Works | Missing / Blocker | Verify |
|---|---|---|---|---|---|---|
| **CLI** (worker CLIs) | `PARTIAL` | Hermes `127.0.0.1:8642`, OpenCode `127.0.0.1:4096` reachable; `codex` UNAVAILABLE | `core/src/agents/{hermes,opencode}.ts` | two workers reachable + authenticated | no Codex (see §2.7) | `/health`,`/agents` |
| **Shell** | `READY` | probe `AVAILABLE` "program execution works via …node.exe"; `shell.run` registered | `core/src/tools/workspace.ts` `shellRun:270`, `createWorkspaceTools:362`; `runtime.ts:1467` | governed execution via `execFile(shell:false)`, arg list, bounded timeout/output | DESTRUCTIVE → parks for human (governance, not absence) | probe + `POST /capabilities/shell/test` (409) |
| **Filesystem access** | `READY` | probe `AVAILABLE`; `filesystem.read/list` READ, `filesystem.write` WRITE | `workspace.ts` `filesystemRead:111`, `filesystemList:127`, `filesystemWrite:155` | real read/list/write, absolute paths, bounded | write parks for approval | probe + test (409) |
| **Git** | `READY` | **exercised live**: `POST /capabilities/git/test` → real `git status` (branch `master`, dirty) | `workspace.ts` `gitStatus:222`, `gitLog:234`, `gitDiff:255` | real read-only git (status/log/diff) | read-only by design | exercised live |

### 2.7 Integrations / workers / agents

| Capability | Status | Evidence | Location | Works | Missing / Blocker | Verify |
|---|---|---|---|---|---|---|
| **Hermes** | `READY` | `/health` hermes `reachable:true, authorized:true`; employee `READY` | `core/src/agents/hermes.ts` (`baseUrl http://127.0.0.1:8642`); `agents/adapters/hermesAdapter.ts` | real worker; phase6 task returned `PARTU-WORKER-OK` | worker self-id stripped at relay; no model streaming | live + phase6 |
| **OpenCode** | `READY` | `/health` opencode `reachable:true, version 1.18.33` | `core/src/agents/opencode.ts` (`127.0.0.1:4096`); `adapters/opencodeAdapter.ts` | real worker; explicit route `/agents/opencode/chat` | router never *chooses* OpenCode (only explicit route) at HEAD | live |
| **Codex** | `BLOCKED BY EXTERNAL DEPENDENCY` | `GET /employees` codex `state:UNAVAILABLE`; runtime reason `"the codex CLI is not installed on this machine"` | `runtime.ts:968-974` | registered as a known-unavailable employee | **no codex adapter file, no CLI on PATH** | `GET /employees` |
| **n8n** | `PARTIAL` | app poller `poll_n8n` reads execution history via `n8n-url`+`n8n-api-key` (Credential Manager); "Open n8n" button | `app/src-tauri/src/integrations.rs:648`, `lib.rs:352` | app-side status integration + open instance | **not a Core worker**, not a routing target, no delegation | read source + settings |
| **Workers** | `READY` | 2 READY, codex unavailable; `/employees` | `core/src/workforce/*` | lifecycle state machine, enable/disable, snapshots | — | live |
| **KAI subagents** | see §2.2 | | | | | |

### 2.8 MCP

| Capability | Status | Evidence | Location | Works | Missing / Blocker | Verify |
|---|---|---|---|---|---|---|
| **MCP registry (server catalogue)** | `MISSING (from product)` | `createMcpRegistry` defined but **zero call sites in `core/src` outside `core/src/mcp/`** | `core/src/mcp/registry.ts:245` | unit-tested library | **not constructed by the runtime** | grep |
| **MCP client / transport** | `MISSING (from product)` | `real-client.ts` (602 lines) spawns stdio servers, correlates by id, deadlines as values | `core/src/mcp/real-client.ts` | proven by `core/tests/mcp-real.test.ts` (12 tests) | **not invoked by the runtime**; no route | grep + tests |
| **MCP discovery** | `PARTIAL` | `wireMcpTools` adapts discovered tools | `core/src/mcp/integration.ts:60`; `tool-adapter.ts` | library implements discovery→ToolDefinition with KAI-declared risk | **no runtime wiring** (`wireMcpTools` grep = only tests) | grep |
| **MCP configuration / UI** | `MISSING` | no `/mcp` route (`GET /mcp` → `unknown_route`); no MCP UI in `app/src` | — | — | none | live 404 |
| **MCP execution** | `MISSING (as a product capability)` | `capability.mcp` `UNAVAILABLE`; `runtime.ts:1358` throws `"no MCP server is configured or connected"` | `runtime.ts:1136-1144,1358` | refused honestly | nothing registered | live |
| **MCP protocol in production** | `READY (internal only)` | the **CUA transport speaks MCP stdio to `cua-driver`** (`initialize`→`tools/list`→`tools/call`; 57 tools) | `core/src/capabilities/computer/real-transport.ts` | MCP *protocol* is exercised in production for CUA | not exposed as a general MCP capability | read source |

### 2.9 Plugins

| Capability | Status | Evidence | Location | Works | Missing / Blocker | Verify |
|---|---|---|---|---|---|---|
| **Plugins (discover/configure/enable/execute/disable)** | `MISSING` | grep `plugin` over `core/src`,`app/src` → **0 KAI plugin hits**; only Tauri's own `tauri_plugin_*` and a Claude-Code `enabledPlugins` test string | none | nothing | **no registry, no loader, no config, no route, no UI** | grep |
| **Plugin management** | `MISSING` | `GET /plugins` → `{"error":"not_found","reason":"unknown_route"}` | none | nothing | — | live 404 |

### 2.10 Governance / runtime

| Capability | Status | Evidence | Location | Works | Missing / Blocker | Verify |
|---|---|---|---|---|---|---|
| **Approval system** | `READY` | `GET /approvals` → 116 records; live tests `409 approvalRequired:true` then approve→execute (phase6 T6 `PARTU-WORKER-OK`) | `core/src/approvals/service.ts`; binding `tools/registry.ts:586-639` | request/expire/decide; approval bound to exactly ONE tool | `approval.expired` is **never published** (no event type) | live + phase6 |
| **Policy** | `READY` | `GET /policy` → mode `normal`, rule `kai-internal-state` allows 14 internal tools; READ→allow, WRITE/EXTERNAL/DESTRUCTIVE→needs_approval | `core/src/policies/{gate,mode}.ts` | single table, source-named decisions, fail-closed | **no persistence across restart**, no per-user/time policy | live + source |
| **Missions** | `READY` | `GET /missions` → 107; side-effect derivation, mission gate, boundary runner; live nested `missions.create` classified `sideEffecting:true` | `core/src/missions/{executor,mission}.ts`; `runtime.ts:1626-1742` | create/execute/cancel; policy-governed steps | **no mission planner** (no NL→steps); router has no "start mission" intent | live + phase6 |
| **Scheduler** | `READY` | `/state` scheduler `running:true, total:11, enabled:0`; a one-time schedule fired exactly once (phase2 R1) | `core/src/scheduler/*`; `runtime.ts:1896` | persistent, lease-claimed, quarantine on failure, recovery | no cron GUI; single-machine | live + phase2 |
| **Recovery / checkpoints** | `PARTIAL` | `GET /recovery/status` `{open:[],total:42}`; checkpoints 12; classify returns phase/status/replaySafe | `core/src/recovery/{ledger,boundary}.ts`, `core/src/checkpoints/checkpoint.ts` | durable ledger; BEFORE/AFTER_ACCEPT boundary refuses unsafe replay; checkpoint verify-on-restore | **no replay executor wired** (`replayIfSafe` has no call site) | live + source |
| **Observability** | `PARTIAL` | `GET /actions`; every action emits one `action.executed` | `core/src/observability/{action-record,correlation}.ts` | correlation by coreBuildId/mission/turn/schedule/… | `recoveryDecision` & `employeeInstanceId` **always undefined**; no `executionId` field | harness §16 |
| **Self-improvement** | `PARTIAL` | `maintenance/index.ts` explicitly disclaims downloads/binary replacement | `core/src/maintenance/index.ts:18-23` | status + 4 safe repairs (memory-upkeep, scheduler-recovery, mission-recovery, view-sync) | **no code-modifying self-improvement, no LLM that rewrites KAI** | source + `/maintenance/status` ok:true |
| **Self-testing** | `PARTIAL` | `GET /capabilities/:id/...`, `/maintenance/status`, `:test` endpoints | runtime + maintenance | health probes are real measurements | no autonomous test-generation/run loop | live |
| **Self-recovery** | `PARTIAL` | `missions.recover()`, `scheduler.recoverInterrupted()`, maintenance repairs | `maintenance/index.ts:158` | recovers missions/leases | **no ledger replay**; unknown execution is refused (safe) | source + live |
| **Learning** | `PARTIAL` | phase2 live: L1 correction→MEMORY, L1b single→none, L1c repeat×3→skill staged | `core/src/learning/{classify,pipeline}.ts`; `runtime.ts:1534-1544` | classifies MEMORY/SKILL/NONE; memory written live; skill only staged | **no autonomous promotion** — every skill ends at human approval; **behaviour-change-after-restart (L2) NOT run live** | phase2 evidence |
| **User corrections** | `PARTIAL` | user correction recognized+classified (phase2 L1); host-attested only | `learning/*`; `server.ts` host token | a correction becomes a memory (durable) | single correction does not become a skill (by design) | phase2 |
| **Skill creation** | `PARTIAL` | staged→SHA-256→approved→exact-byte install; live 403 on tamper (`HASH_MISMATCH`) | `core/src/skills/staging.ts`; `runtime.ts:1525-1528` | staging, exact-byte install, tamper-refused, revisions, rollback | no autonomous install; no disk auto-discovery | phase2 S1-S4 |
| **Skill installation** | `READY` | `GET /skills` → 2 installed; both dirs on disk | `skills/staging.ts`, `skills/registry.ts` | install proven live, byte-for-byte | — | live + phase2 |

### 2.11 Package / build

| Capability | Status | Evidence | Location | Works | Missing / Blocker | Verify |
|---|---|---|---|---|---|---|
| **Package / build** | `NOT VERIFIED` | `app/target/release/kai.exe` present (independent-verification.md: 4,917,760 bytes, sha256 recorded); build logs in `docs/evidence/kai-app-build*.log` | `app/` Tauri 2; `app/target/release/` | packaged exe + NSIS installer exist and embed the built front-end | I did **not** run a fresh build or the installers this pass; the 683/107 test counts were not re-run | evidence docs only |

---

## 3. Direct answers to the owner's questions

### 3.1 "Where are the MCPs?"

**They are a library and its tests — not a product capability.**

- **Code exists:** `core/src/mcp/` — `real-client.ts` (602 lines, a real MCP stdio client with
  id-correlation, deadlines-as-values, no-throw boundary), `registry.ts`
  (`createMcpRegistry`, 375 lines), `integration.ts` (`wireMcpTools`), `tool-adapter.ts`,
  `bridge.ts`, `validation.ts`, plus a fixture server `servers/echo-mcp-server.mjs`.
- **It is unit-tested:** `core/tests/mcp-real.test.ts` (12 tests: handshake, out-of-order
  correlation, bad-tool as a value, stderr not poisoning the stream, split frames, timeouts, kill,
  dispose-leaves-no-orphan, risk refusal).
- **It is NOT wired into the runtime:** `grep -rn "createMcpRegistry|wireMcpTools|real-client" core/src`
  excluding `core/src/mcp/` returns **nothing**. `core/src/mcp/WIRING.md` says outright: *"This is
  the note the Core lead needs"* — i.e. the wiring is a **requested future step**.
- **No route, no UI:** `GET /mcp` → `unknown_route`. No MCP configuration UI in `app/src`.
- **The capability is honestly UNAVAILABLE:** `runtime.ts:1358` throws `"no MCP server is configured
  or connected"`; `GET /capabilities/mcp` confirms `status:UNAVAILABLE`.
- **The one place MCP *runs* in production is CUA:** `capabilities/computer/real-transport.ts`
  speaks MCP stdio to `cua-driver` (`initialize → tools/list` = 57 tools → `tools/call`). So the MCP
  *protocol* is exercised in the product — **but only as a private transport inside the CUA driver,
  not as a general MCP capability.** No MCP server can be added, configured, seen or approved by the
  owner today.

### 3.2 Plugins

**MISSING. There is no plugin infrastructure of any kind.** A repo-wide grep for `plugin` in
`core/src` and `app/src` returns only Tauri's own `tauri_plugin_autostart` /
`tauri_plugin_single_instance` registrations and a Claude-Code `enabledPlugins` string inside a
`hooks.rs` test. There is **no** plugin registry, discovery, loader, config, enable/disable,
route, or UI. `GET /plugins` → `unknown_route`. **You cannot discover, configure, enable, execute
or disable a plugin, because nothing in KAI knows what a plugin is.**

### 3.3 CLI / Shell / Git — real, or stubs?

**Real and governed at HEAD. The old "no `<id>` tool is implemented in KAI yet" stubs are gone.**
`core/src/tools/workspace.ts` implements `filesystem.read/list/write`, `git.status/log/diff`,
`shell.run`, registered at `runtime.ts:1467` and dispatched from the capability tool at
`runtime.ts:1281`. Verified live:

- `POST /capabilities/git/test` → **real `git status`** of the working tree.
- `GET /capabilities/shell` → probe `AVAILABLE` ("program execution works via …node.exe").
- `GET /capabilities/filesystem` → probe `AVAILABLE`.
- `shell.run` is DESTRUCTIVE and `filesystem.write` is WRITE → both **park for a human** by the
  default policy (the `409` I observed is governance, not a missing implementation).
- Shell uses `execFile(command, args, {shell:false})` — **no shell interpolation**; a caller that
  wants a shell must request it explicitly, and that request is DESTRUCTIVE.

**Caveat:** the individual `shell.run` / `git.*` tools are registered but I did not drive a real
`shell.run` end-to-end through an approval this pass; I exercised the `git` capability and the
`shell`/`filesystem` *probes*, and the probes are real measurements. Treat the shell *execution*
path as `READY-by-design + probe-verified`, not turn-by-turn exercised at HEAD.

### 3.4 Island controls

At **committed HEAD**: the island **can be collapsed/hidden to a 240×6 wake strip and restored by
hover** (`set_collapsed` + `spawn_wake_monitor`), and **placed on a chosen display** ("Main display"
/ "Display under the cursor", persisted in `%APPDATA%\KAI\settings.json`). It **cannot be freely
moved or resized**, and **"close" means quitting the whole app** (tray "Quit").

**In-flight (uncommitted, `NOT VERIFIED`):** a routing/appearance agent has added
`start_island_drag` + a `Moved`-event handler + `island_pos{x,y}` persistence (`settings.rs`) and a
window-only `close_island` with a tray "Open KAI" reopen. **This is real code in the working tree but
it is NOT committed and I did not run the GUI to confirm it.** If it lands, island movement and
exact-position persistence become `READY`.

### 3.5 SOUL.md / USER.md / memory exposure in the UI

**Files on disk — `%LOCALAPPDATA%\KAI` (`KAI_HOME`):**

- `SOUL.md` — 2790 bytes, modified today (real persona text, "I am KAI…").
- `USER.md` — 328 bytes, **still the seed** ("nothing recorded yet").
- `MEMORY.md` — 212 bytes, **still the seed** ("nothing recorded yet").
- Seeded by `core/src/agent/kai-home.ts:40-142`.

**In the product UI:** **none of the three can be opened, read, edited, saved or reloaded from the
UI.** A grep for `soul`/`SOUL`/`USER.md`/profile editing across `app/src` returns **nothing**; the
settings window's controls are hooks, model, API keys, integrations, sound, screen and autostart
(`app/src/settings/main.ts`). The Core client even exposes `memory()` and `remember()`
(`app/src/core/kai-core.ts:796-811`) — but **no view calls them** (grep for callers → none).

**Programmatic exposure:** `SOUL.md` is loaded into every composed turn
(`compose.ts:276-283`) and a `soul.set` mutation tool exists (`runtime.ts:407,636,2318`). `USER.md`
is composed as `user-context` but has **no setter**. Memory has real HTTP routes
(`/memory`, `/memory/write`, `/memory/journal`). **So the identity files are live inputs to KAI's
turns, but the owner cannot see or edit them from the product today** — only by editing the files
directly (or, for SOUL, via the internal `soul.set` tool).

---

## 4. What is ACTUALLY stopping KAI from being the autonomous personal AI — ranked

1. **MCP is not wired — the owner asked "where are the MCPs?" and the honest answer is "in a
   library and its tests."** *Blocker:* `createMcpRegistry`/`wireMcpTools` have **zero runtime call
   sites** and there is no route/UI. *Required work:* construct the registry in `runtime.ts`, add a
   discovery + config + enable surface, route discovered tools through the registry, add an approval
   binding. *This is the single largest gap between the design vocabulary and the product.*

2. **Plugins do not exist at all.** *Blocker:* no plugin concept anywhere in `core/src`/`app/src`.
   *Required work:* define a plugin manifest, a loader with policy classification, discovery from
   disk, enable/disable, and a UI — i.e. build the whole chain from zero.

3. **`task.delegate` does not delegate at committed HEAD.** *Verified:* `git show HEAD:core/src/server.ts`
   contains **no** `delegateTo`; the router computes a worker and the handler ignores it (harness
   §1/§4). **In-flight** `server.ts:505-535` now performs the delegation through the real relay,
   honouring `avoid`. *Blocker:* uncommitted. *Required work:* land + live-verify the routing fix,
   and give the router a model-based (not regex) classifier.

4. **No worker routing choice / no parallel multi-agent fan-out.** At HEAD OpenCode is reachable only
   via its explicit route; Codex never runs (CLI absent). There is no evidence of parallel
   subagent execution. *Blocker:* the router is regex and hard-codes Hermes for unknown turns.

5. **Subagent visual identity is a dangling reference.** *Blocker:* `createSubagentRegistry` is
   called with `{path}` only (`runtime.ts:2272-2274`), so no `KaiVariantResolver` — a persona's
   `variant`/`outfit` never resolves to a real asset. *Required work:* wire the resolver to
   `app/src/character/variant.ts`.

6. **No autonomous self-improvement; learning is human-gated and partly unverified.** *Blocker:*
   every skill path ends at human approval; `maintenance/index.ts:18-23` explicitly disclaims
   downloads/binary replacement/code rewriting; **L2 (behaviour change after restart) was never run
   live** (phase2 doc: "STILL NOT RUN LIVE: L2"). *Required work:* a promotion policy the owner can
   trust, and a live L2 test proving a correction changes behaviour durably.

7. **Identity is invisible and USER.md is inert.** *Blocker:* no SOUL/USER/memory UI;
   `USER.md`/`MEMORY.md` are still seeds; no setter for USER. *Required work:* an identity editor
   (open/edit/save/reload) bound to `soul.set` + a user-profile writer.

8. **Observability has permanently-null fields.** *Blocker:* `recoveryDecision` and
   `employeeInstanceId` are declared but never emitted; there is no `executionId` on the action
   record (harness §16). *Effect:* a recovery row cannot be correlated from the bus.

9. **Recovery is report-only.** *Blocker:* `replayIfSafe()` has no production call site; recovery
   classifies and refuses, it does not replay. *Required work:* a supervised replay executor.

10. **The worker-turn event vocabulary is dead on the wire.** *Blocker:* `attachProvider`,
    `ingestRuntime`, `subscribeRuntime`, `toControlPlaneEvent` have zero production call sites
    (harness §19). *Effect:* the island cannot visualise live worker turns; the `turn.*`/`item.*`
    branch of `stateForEvent` never fires.

11. **Island free-move / exact-position persistence / window-only close are uncommitted.**
    *Blocker:* in-flight only. *Required work:* land + GUI-verify.

12. **No first-class configuration surface for capabilities.** Providers' risk must be declared by
    hand (`mcp/WIRING.md`); there is no UI to register a capability, an MCP server, or a plugin.

**Not-blockers worth stating plainly (working, verified):** identity routing, sessions +
switching, real governed git/filesystem/shell, CUA, the CDP browser (semantic-first), approvals,
policy, missions, scheduler, checkpoints, skill staging with exact-byte install and
tamper-refusal.

---

## 5. Evidence appendix

**Commands used (all foreground, live):**

```
curl -s http://127.0.0.1:8788/identity | /health | /state | /capabilities | /capabilities/{id} \
     | /employees | /agents | /skills | /skills/staging | /memory | /sessions | /schedules \
     | /checkpoints | /policy | /approvals | /missions | /notifications \
     | /maintenance/status | /recovery/status
curl -s -X POST http://127.0.0.1:8788/capabilities/{system,git}/test
curl -s -X POST http://127.0.0.1:8788/capabilities/{browser,computer,mcp,filesystem,shell}/test   # 409 governed
curl -s -X POST http://127.0.0.1:8788/chat -d '{"text":"who are you?"}'
grep -rn "createMcpRegistry|wireMcpTools" core/src --include=*.ts        # → only core/src/mcp/*
grep -rin "plugin" core/src app/src                                       # → 0 KAI plugin hits
git show HEAD:core/src/server.ts | grep delegateTo                        # → empty (HEAD does not delegate)
git diff app/src-tauri/src/{island,lib,settings}.rs                       # in-flight drag/close/pos
```

**Source poles:** `core/src/runtime.ts` (composition root, `createCoreRuntime`), `core/src/server.ts`
(HTTP+SSE), `core/src/api/routes.ts`, `core/src/tools/workspace.ts` (real fs/git/shell),
`core/src/mcp/*`, `core/src/skills/*`, `core/src/learning/*`, `core/src/capabilities/{browser,computer}/*`,
`app/src/character/*`, `app/src/core/runtime-state.ts`, `app/src/island/*`,
`app/src-tauri/src/{island,lib,settings,tray,integrations}.rs`.

**Prior evidence consulted (not re-run here):** `docs/KAI_HARNESS.md` (HEAD `ea653cc`),
`docs/evidence/phase2-skills-learning-live.txt`, `docs/evidence/phase6-head-core-live.txt`,
`docs/evidence/independent-verification.md`, `app/assets/kai/KAI_ACTION_INVENTORY.md`.

**Machine-readable companion:** `docs/kai-capabilities.json`.

