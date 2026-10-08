# OpenGhost ↔ KAI integration audit

**Date:** 2026-10-04 · **Auditor:** delegated audit subagent · **Scope:** read-only on `core/**` and `app/**` except this document; test suites run.
**Repo:** `C:/Users/DELL/Desktop/kai` · **HEAD:** `d833a84` (`fix(core): a KAI subagent can actually be handed a task, and survives a restart`)

---

## 0. Headline — was OpenGhost actually available to audit?

**No. OpenGhost is NOT present on this machine.** A full, bounded search returned zero hits for the name, the archive, a git remote, or a package/Cargo name:

| Where searched | Result |
|---|---|
| `C:/Users/DELL/Desktop/`, `~/`, `~/Downloads/`, `~/Documents/` | no `*openghost*` entry |
| Whole `C:/` (depth ≤ 6) and whole `D:/` (depth ≤ 6) by name | none |
| Every `package.json` / `Cargo.toml` under Desktop + Documents naming `ghost` | none |
| Every `.git` repo under `~/` and `D:/` (17 repos) — `git remote -v` | none points at OpenGhost |
| Archive scan in `Downloads` (`.zip/.tar/.7z/.rar`) | only unrelated projects (restaurant-ai, Lively theme, XOutput) |

The only "ghost" match on disk is `/d/programs/ghost.riv` — an unrelated binary. `git grep -i openghost` across the KAI repo returns **0 hits**.

**Consequence, stated plainly:** no OpenGhost architecture was read, and **nothing below describes, recalls, or infers OpenGhost internals.** Any such description would be fabrication and is deliberately absent. The half of the audit that is real — the CURRENT KAI side, fully traced from source — is below, together with the per-subsystem disposition that is *decidable now* from KAI's own architecture and the owner's stated hard boundary. Classifications that genuinely depend on OpenGhost source are marked **[PENDING SOURCE]** with exactly what must be inspected to resolve them.

**To complete this audit we need one of:** a clone URL, a local path, or the archive of OpenGhost.

---

## 1. Recorded KAI test baseline (before anything changes)

Run in the foreground on the working tree at HEAD `d833a84`. NOTE: the working tree was **dirty** at audit time — three parallel agents had uncommitted edits under `app/src-tauri/src`, `core/src`, and `core/tests` (see `git status`). The numbers below are therefore the live tree, not a clean checkout.

| Suite | Command | tests | pass | fail | duration |
|---|---|---|---|---|---|
| **core** | `cd core && npm test` | **728** | **728** | **0** | ~39.7 s |
| **app** | `cd app && npm test` | **109** | **109** | **0** | ~0.56 s |

**These differ from the figure quoted in the task brief (core 719/710/9 fail).** The 9 previously-failing live-Hermes-auth suites are **not failing now**: `core/scripts/test.mjs` resolves `API_SERVER_KEY` from the Hermes install for the live-auth suites, and in this environment they resolved and passed. No test was weakened, skipped, or modified to produce this result. **This is the true baseline; the brief's 719/710/9 should be treated as stale.** Re-confirm on a clean checkout before any integration branch is cut.

---

## 2. KAI as actually traced from source (the facts this audit rests on)

All of the following were read directly, not assumed. Where a repo doc claims something, the claim was checked against code.

- **Composition root (single):** `core/src/runtime.ts` (2666 lines). Header states it "is the only module that knows all the others exist"; everything else takes collaborators by injection. Wiring order is explicit: `stores → bus → notifications → agents → policy → approvals → tools → missions → scheduler`. Two invariant comments stand out and are load-bearing: *"Nothing an agent or an LLM produces reaches the machine directly… A mission step is executed through the tool registry, which validates and applies policy"* and *"No port number or route appears below."*
- **HTTP surface:** `core/src/api/routes.ts` (2530 lines) exports `createCoreApi(runtime)` with `handle()` / `routes()`. `core/src/server.ts` mounts it and also owns raw agent-proxy routes (`/chat`, `/agents/hermes/chat`, `/agents/opencode/chat|sessions|permissions|questions`) and the SSE endpoints.
- **SSE stream:** `core/src/server.ts:739` serves `GET /core/events` (`text/event-stream`, keep-alive, `attachEventStream(core, res)`); the legacy `GET /events` is at `server.ts:643`. Front-end client is `app/src/core/core-events.ts` (a `fetch`-streaming reader, deliberately not native `EventSource`, with bounded observable backoff). Wire frames are `{id,type,timestamp,source,payload,missionId?,stepId?}`.
- **Identity / soul:** `core/src/identity.ts` (process-frozen build identity, on-disk comparison, source-hash vs stamp via `core/src/source-hash.ts` — "the ONE implementation"); `core/src/agent/soul.ts` (`createKaiIdentity`, loads `SOUL.md`/`USER.md`/`MEMORY.md` from KAI_HOME, bounded at `MAX_DOC_CHARS=8000`, redacted, honest about gaps, **works with every worker offline**).
- **Chat relay + worker-identity guard:** `core/src/chat/relay.ts` (321 lines) enforces *"the WORKER IS NEVER THE SPEAKER"* — the HTTP response names KAI (`agent:"core"`), the worker appears only as provenance (`worker:"hermes"`); explicitly NOT a phrase blocklist. `core/src/chat/router.ts` (909 lines) intents include `identity` (FIRST), `agent.status`, `task.delegate`; `classify()` is an ordered regex set, not a model; unrecognised → honest `unknown`.
- **Sessions:** `core/src/sessions/{index,service,store}.ts` (`createSessionService`, `createSessionStore`, `KaiSession`, `SessionTurn`).
- **Subagents:** `core/src/workforce/subagent.ts` (425 lines) — a subagent is a persona KAI owns, **not** a second registry/policy engine/approval service; registered as an `EmployeeDescriptor` in the one `WorkforceManager`, capabilities pushed into the one `CapabilityManager`, execution via the runtime's `executeTask` (validate → policy → approval → execute). Manager refuses to delegate with no policy-governed executor.
- **Character (visual engine):** `app/src/character/{engine,orb,types,actions,minibots,greeting,variant,demo}.ts`. `orb.ts` is a **faithful Canvas-2D port** of `app/assets/kai/KAI_matrix_orb_v17.html` (the owner's own asset, origin `Downloads/KAI_matrix_orb_v17.html`), which the repo declares the SOURCE OF TRUTH; `types.ts` states KAI is an original character (squircle core, single iris band, orbiting ticks) not derived from upstream artwork.
- **Island:** `app/src/island/{core-bridge,fsm,hooks,integrations,island}.ts` + Rust host `app/src-tauri/src/{island,core_process,files,hooks,integrations,lib,pipe,secrets,settings,tray,claude,win_user,log,main}.rs`.
- **Policy / approvals:** `core/src/policies/gate.ts` (single answer to "may this run, and does a human say yes first?"; safe defaults READ=allow, WRITE/EXTERNAL/DESTRUCTIVE=needs_approval; unknown risk → needs_approval), `core/src/policies/mode.ts` (runtime mode authority, KAI's own vocabulary), `core/src/approvals/service.ts` (records/expires/verdicts; bound to one `toolId`; **never decides and never calls a tool**).
- **Recovery:** `core/src/recovery/ledger.ts` (durable BEFORE_ACCEPT / AFTER_ACCEPT / UNKNOWN acceptance ledger) + `core/src/recovery/boundary.ts` (wraps the executor's one `StepRunner` seam; refuses replay of an already-AFTER_ACCEPT side effect).
- **MCP:** `core/src/mcp/*` exists (`registry.ts`, `integration.ts`, `bridge.ts`, `tool-adapter.ts`, `real-client.ts`, `WIRING.md`, `servers/`). **Verified wired to ZERO runtime call sites**: `runtime.ts` mentions `mcp` only as a capability-id string; the only file importing `./mcp/` is its own `WIRING.md`. `WIRING.md` is an additive plan, unimplemented.
- **Observability:** `core/src/observability/{action-record,correlation}.ts` — one record per executable action on the EXISTING event bus ("who did this, through which capability, under which policy decision, which approval, which Core build"), plus the correlation read-side.
- **Capabilities (browser / CUA):** `core/src/capabilities/{browser,computer}/*` — browser via `cdp-transport.ts` (CDP), computer via `real-transport.ts` (cua-driver over MCP stdio, lazily connected); both behind a transport seam with fake transports for tests.
- **Tools / filesystem / shell / Git:** `core/src/tools/{registry,builtin,workspace}.ts` — workspace ops carry honest risk + effectful flags; shell probe measures a real spawn.
- **Plugins:** **do not exist** (no `*plugin*` dir outside `node_modules`).
- **Model providers:** worker adapters in `core/src/agents/adapters/{hermesAdapter,opencodeAdapter}.ts` behind `core/src/agents/registry.ts`; KAI itself is the control plane, not a model.
- **Persistence:** `core/src/storage/{sqlite,memoryStore}.ts` (SQLite default) + event bus.

---

## 3. Licensing boundary (what was actually found)

**OpenGhost licence files: none found — because no OpenGhost tree exists locally, no `LICENSE`, `LICENSE-ASSETS.md`, or `NOTICE` from OpenGhost could be read.** No claim is made about which OpenGhost code is MIT vs which assets are protected. **This is unresolved until the source is present.** Whether a specific OpenGhost asset/mechanism is safe to reuse **cannot be answered now** and, per the owner's rule, must be **flagged, not guessed**.

What KAI's own tree does establish (relevant precedent for how the boundary is handled):

- `LICENSE` = **MIT**, "Copyright (c) 2026 Louis Raillé (upstream Coucou source code); Copyright (c) 2026 Aziz (KAI — modifications, original character, icon and audio)".
- `NOTICE.md` records KAI's own prior discipline on exactly this problem: the upstream **Coucou** `LICENSE-ASSETS.md` separated MIT source from rights-reserved names/character/sounds/images; KAI reused the MIT *code* only, deleted the upstream character (`src/mochi/`), regenerated icons, and ships no upstream audio/art. This is the same discipline the owner now applies to OpenGhost.
- KAI's own assets (character, icons, launch sequence, synthesised sounds) are declared MIT under the same licence.

**Hard boundary for the OpenGhost work (owner's rule, to be applied once source lands):**
- MAY study/adapt **MIT-licensed source mechanisms** where the licence permits (attribution preserved).
- MUST NOT copy OpenGhost's **name, logo, branding, proprietary visual identity, animations, exact product artwork, exact interface identity, or protected assets.**
- **STOP and flag** any asset or code section whose status is uncertain rather than guessing.

---

## 4. Per-subsystem audit

Legend — classification tokens: `KEEP KAI` · `REUSE FROM OPENGHOST` · `ADAPT` · `REIMPLEMENT` · `IGNORE` · `CONFLICT`.
**Decidability:** *decided* = resolvable from KAI's traced architecture + the owner's hard boundary; **[PENDING SOURCE]** = cannot be finalised without OpenGhost source.

Because OpenGhost is absent, every OpenGhost-touching subsystem carries **[PENDING SOURCE]**. Where the owner's boundary already fixes the outcome (the authority subsystems), the classification is **decided** regardless of OpenGhost — KAI stays authoritative by decree.

| # | Subsystem | KAI evidence (traced) | Classification | Decidability |
|---|---|---|---|---|
| 1 | **Application architecture** | Two halves: Rune Rune control plane in `core/` (Node), desktop shell in `app/` (Tauri 2 + Rust + TS). Owner wants three layers — KAI control plane / execution engines / KAI visual engine. | **ADAPT** (keep the KAI topology; adopt OpenGhost's *agent-oriented desktop* framing only as a UI shell over KAI Core) | [PENDING SOURCE] for what OpenGhost's shell actually is |
| 2 | **Desktop runtime** | `app/src-tauri/src/*` (island, core_process, pipe, secrets, tray, windows…); `app/src-tauri` is a fork of Coucou `windows/` (MIT), already rebranded. | **ADAPT** — KAI keeps its Tauri host; if OpenGhost ships a desktop-runtime mechanism (window/island/IPC) it may be adapted, but the host stays KAI's | [PENDING SOURCE] |
| 3 | **Frontend** | `app/src/{views,island,settings,upload,core}`, `app/src/views/*` (chat, dom, icons, integrations, overview-key, subagent, ticker, upload, views). | **ADAPT** — KAI's frontend becomes the full desktop workspace with the island as compact companion; OpenGhost *visual/streaming presentation* may inform it | [PENDING SOURCE] |
| 4 | **Backend / Core** | Single composition root `core/src/runtime.ts`; HTTP `core/src/api/routes.ts`; server `core/src/server.ts`. | **KEEP KAI** — one authority, no duplicate control plane | decided |
| 5 | **Agent loop** | `core/src/missions/*` executor + `core/src/autonomy/supervisor.ts`; every step through the tool registry / agent registry. | **KEEP KAI** | decided |
| 6 | **Sessions** | `core/src/sessions/{index,service,store}.ts`. | **KEEP KAI** | decided |
| 7 | **Context construction** | `core/src/prompts/*` (`createPromptComposer`) + `soul.ts` + memory service. | **KEEP KAI** | decided |
| 8 | **Memory** | `core/src/memory/*` (service, engine, capture, journal, upkeep, store, model, topics, bounds). | **KEEP KAI** | decided |
| 9 | **User context** | `USER.md`/`SOUL.md`/`MEMORY.md` via `core/src/agent/{soul,kai-home}.ts`; redacted, bounded, offline-safe. | **KEEP KAI** | decided |
| 10 | **Tools** | `core/src/tools/{registry,builtin,workspace}.ts` — the ONE ToolRegistry, invoked `validate → policy → approval → execute`. | **KEEP KAI** — no second ToolRegistry under any circumstance | decided |
| 11 | **Approvals** | `core/src/approvals/{service,parked}.ts` — bound to one `toolId`, expiry, never executes. | **KEEP KAI** | decided |
| 12 | **Browser** | `core/src/capabilities/browser/*` via CDP (`cdp-transport.ts`), behind a transport seam; browser capability tests exist (`browser-real.test.ts`). | **ADAPT** — KAI's browser *interaction model* may adopt OpenGhost's agent-oriented interaction/observation presentation, but the capability stays KAI's, policy-gated | [PENDING SOURCE] |
| 13 | **CUA (computer-use)** | `core/src/capabilities/computer/*` via `real-transport.ts` (cua-driver over MCP stdio, lazy connect); `SEAM.md`. | **KEEP KAI** (mechanism) possibly **ADAPT** (presentation) | [PENDING SOURCE] for presentation |
| 14 | **Filesystem** | `tools/workspace.ts` filesystem ops (READ/WRITE, effectful flags), tests round-trip real bytes. | **KEEP KAI** | decided |
| 15 | **Shell** | `tools/workspace.ts` `shell.run` (DESTRUCTIVE, parks then runs on approval); real-spawn probe. | **KEEP KAI** | decided |
| 16 | **Git** | `tools/workspace.ts` git ops (READ `git.status` runs without a human; probed honestly). | **KEEP KAI** | decided |
| 17 | **MCP** | `core/src/mcp/*` present but **zero runtime call sites**; `WIRING.md` is an additive, unimplemented plan. | **KEEP KAI** — MCP integration is KAI's own pending work, not an OpenGhost import; **do not let an OpenGhost MCP/tool layer become a second registry** | decided (KAI's); [PENDING SOURCE] if OpenGhost assumes a tool protocol |
| 18 | **Model providers** | Worker adapters `core/src/agents/adapters/*` behind `agents/registry.ts`. | **KEEP KAI** | decided |
| 19 | **Streaming** | SSE `GET /core/events` (`server.ts:739`) + `app/src/core/core-events.ts` client (bounded backoff, observable state). | **ADAPT** — OpenGhost's streaming interaction may reshape the *presentation*; the KAI event bus + SSE contract stay authoritative | [PENDING SOURCE] |
| 20 | **Compaction** | Prompt/session bounds: `soul.ts MAX_DOC_CHARS`, `sessions/*`, memory `bounds.ts`. | **KEEP KAI** | decided |
| 21 | **Persistence** | `core/src/storage/{sqlite,memoryStore}.ts` + event bus. | **KEEP KAI** | decided |
| 22 | **Visualization** | `app/src/character/*` (Canvas-2D port of `KAI_matrix_orb_v17.html`); owner wants a "KAI visual engine" with a **structured visual spec → validator → renderer**, LLM never touching the DOM. | **ADAPT / REIMPLEMENT** — adopt the *renderer architecture* idea (spec → validator → renderer) as KAI's; the KAI visual engine is KAI's own — OpenGhost's visual engine may be studied for mechanism only | [PENDING SOURCE] |
| 23 | **Diagrams** | No dedicated diagram subsystem found in KAI today; would be a new KAI render target. | **REIMPLEMENT** (KAI) informed by **ADAPT** (OpenGhost mechanism, MIT only) | [PENDING SOURCE] |
| 24 | **Media** | No media subsystem in KAI beyond character canvas; KAI ships no audio files (synthesised sounds). | **IGNORE** OpenGhost media assets (protected); **ADAPT** mechanism only if MIT and clearly separable | [PENDING SOURCE] |
| 25 | **Subagents** | `core/src/workforce/subagent.ts` + manager — persona layer over ONE workforce/tool/policy stack; KAI remains authority. | **KEEP KAI** | decided |
| 26 | **Security** | Safe-by-default policy, redaction (`core/src/redact/*`), secret handling in Rust (`secrets.rs`), no LLM→machine direct path. | **KEEP KAI** | decided |
| 27 | **Permissions** | `policies/gate.ts` + `policies/mode.ts` (KAI's own mode vocabulary, distinct from any provider CLI's modes). | **KEEP KAI** | decided |
| 28 | **Recovery** | `recovery/{ledger,boundary}.ts` — durable acceptance boundary; refuses double-apply after crash. | **KEEP KAI** | decided |
| 29 | **Observability** | `observability/{action-record,correlation}.ts` on the existing event bus; identity freshness (`identity.ts` + `source-hash.ts`). | **KEEP KAI** | decided |

### CONFLICT register (structural, decidable now)
- Any OpenGhost **Core / control plane** → **CONFLICT**. Owner rule: **no duplicate control planes**; KAI Core is the one authority.
- Any second **ToolRegistry / policy engine / approval service / workforce manager** → **CONFLICT** (`subagent.ts` and `routes.ts` both explicitly forbid a second manager, "a second manager in the routes would be a second answer").
- Any path where an **LLM gains direct DOM/machine control** → **CONFLICT**; the required shape is a **structured visual spec → validator → renderer**.
- OpenGhost **branding / visual identity / protected assets** → **CONFLICT / DO NOT IMPORT**.

---

## 5. Migration sequence (proposed)

Three layers, one authority: **KAI control plane (unchanged brain) / execution engines (workers, tools, capabilities) / KAI visual engine (new presentation)**. The island becomes a compact companion to a full desktop workspace.

1. **Acquire OpenGhost source + licence audit (GATE — do first).** Clone/inspect, read `LICENSE*`/`NOTICE*`, and produce a file-by-file allow/deny list: MIT code vs protected assets. **Nothing is adapted until this list exists.** Any uncertainty → flag, do not proceed.
2. **Freeze the baseline.** Record core 728/728 and app 109/109 on a **clean checkout** (dirty-tree caveat above), and add these as the pre-integration gate.
3. **Complete the current audit** with the allow/deny list: resolve every **[PENDING SOURCE]** row to a final token.
4. **Define the visual-spec contract (KAI-owned).** A structured spec type + a validator + a renderer interface, mirroring how the character module already isolates drawing behind `types.ts`. The LLM emits a spec; the validator rejects malformed specs; the renderer draws. No DOM from the model.
5. **Reshape the shell, not the brain.** Promote `app/src/views/*` into the desktop workspace; keep `app/src/island/*` as the compact companion. All data continues to arrive via `/core/events` and `createCoreApi`.
6. **Adapt only what passes the licence gate**, one mechanism per PR, each behind its existing seam (transport seam for browser/CUA, renderer interface for visuals), each covered by a KAI test.

**First implementation step (explicit):** *obtain the OpenGhost source and produce the licence allow/deny file-by-file manifest.* This is the only correct first step; it is the gate that makes every later "ADAPT/REUSE" decision legal and non-fabricated.

---

## 6. Risks

- **Availability risk (active):** OpenGhost is absent; the integration cannot start. Every OpenGhost-dependent classification here is provisional.
- **Fabrication risk:** describing OpenGhost internals from memory would corrupt the plan — explicitly avoided.
- **Authority-drift risk:** the strongest failure mode is an imported OpenGhost "Core"/tool layer quietly becoming a second control plane or a second registry. Structural guards already exist in KAI (single `runtime.ts`, "no second manager", worker-never-the-speaker) and must be asserted in tests on any import.
- **Asset-contamination risk:** OpenGhost's protected visual identity/branding could leak into KAI's UI/character. Mitigation: the licence manifest gate (step 1) + the Coucou precedent (delete/replace, verify 0 hits).
- **Stale-artifact risk (observed precedent):** a prior audit found a stale `core/dist/chat/relay.js` answering in the worker's voice while `src` was correct. Integration must be validated against the **shipped artifact**, not `src` alone; `identity.ts`/`source-hash.ts` is the freshness gate to use.
- **Three-way collision risk:** three parallel agents are editing this repo (artifact identity, subagent ecosystem, island/character). Any migration PR must rebase and re-run both suites.

---

## 7. What is needed to complete this audit

1. **OpenGhost source**: a clone URL, a local path, or the archive.
2. Its **licence files** (`LICENSE`, any `LICENSE-ASSETS.md`, `NOTICE`) so the MIT/protected split can be read rather than assumed.
3. A **clean-checkout test baseline** to replace the dirty-tree numbers in §1.

Until (1) and (2) arrive, the OpenGhost column of §4 stays **[PENDING SOURCE]** and no code should be adapted.

---

## 8. Verification notes

- All KAI claims above cite files actually read. The MCP "zero runtime call sites" claim was verified by import search, not by the presence of `core/src/mcp/`. The `/core/events` claim was verified at `server.ts:739` plus the client in `app/src/core/core-events.ts`.
- Test numbers were produced by `npm test` in each of `core/` and `app/` on this machine at the date above; no test was altered to obtain them.
- No production file was modified by this audit; the only file created is this document.
