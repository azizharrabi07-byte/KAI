# KAI — Runtime Architecture

**What this document is.** What actually runs KAI independently of any worker: the Core
process, identity/harness loading, memory authority, the workforce, sessions, tools,
policy/approval, recovery, the scheduler, the event bus, and the artifact-identity
invariant — plus an explicit list of what is **still unwired**, because a runtime
document that hides its gaps is a fiction.

**Verification basis.** HEAD `e7697a2` (`e7697a2c575697977369383eb184036463462bde`),
2026-10-04. Every claim cites `file:line` at that HEAD. Live-capture claims name the
build: `b52353fd7400a6c1` (gitCommit `8fea1bf`) and `7028f6cba503e3ef` (gitCommit
`c75fc5f6`). Unverifiable items are marked **NOT VERIFIABLE**.

---

## 0. The shape, in one paragraph

KAI is a Node/TypeScript **Core** (`core/src/`) bound to loopback HTTP (default port
`8788`), with a **one-way control-plane SSE stream** at `/core/events`, and a Tauri 2
desktop shell (`app/`) that renders the character and the workspace from Core events. The
Core is the composition root: one event bus, one tool registry, one policy engine, one
approval service, one workforce, one memory engine, one prompt composer, one recovery
ledger, one scheduler. Workers (Hermes, OpenCode, Codex) sit **behind** the Core as
adapters an employee can borrow — never in front of it. KAI is the speaker; a worker is
provenance.

---

## 1. The Core process

### 1a. The server

- `core/src/server.ts` is the HTTP composition point: `http.createServer` at
  `server.ts:365`; binds `127.0.0.1` ONLY (`server.ts:7`).
- Port: the desktop supervisor defaults to `8788` (`core_process.rs:134`); the app's
  clients agree — `app/src/core/core-events.ts:98` and `app/src/core/kai-core.ts:27`
  (`http://127.0.0.1:8788`), and the Rust shell's direct-Claude path posts to
  `http://127.0.0.1:8788/chat` (`app/src-tauri/src/claude.rs:30`).
- SSE: `GET /core/events` (`server.ts:739–752`) is bridged by `attachEventStream()`
  (`core/src/api/routes.ts:87`), which subscribes to the **control-plane** `KaiEvent`
  stream on the one bus. `GET /events` (`server.ts:643`) is the island's older fan-in.
- Boot self-check: `identitySelfCheck()` (`identity.ts:206–242`) — a `stale` verdict
  refuses to serve (exit code 5, "Rebuild the chain…"), `unverified` is allowed but
  surfaced, `fresh` reports its evidence. `describeIdentity()` (identity.ts:391–399)
  renders the one-line build summary.

### 1b. Process supervision (the desktop shell owns Core's lifetime)

`app/src-tauri/src/core_process.rs`:

- **ADOPT** — if something already answers on `127.0.0.1:8788` with a Core-shaped
  identity, the app adopts it rather than starting a second one (core_process.rs:9,
  384–387: *"adopted the Core already listening … — not starting a second one"*).
- **SPAWN** — otherwise it starts `node server.js` (core_process.rs:311–350).
- **WATCH** — a supervisor loop runs for the life of the app; an adopted Core that
  disappears is treated as a cold start on the next pass (core_process.rs:351–460).
- **JOB OBJECT** — every spawned Core is assigned to a Windows job object with
  `KILL_ON_JOB_CLOSE` (core_process.rs:268–307, assignment 425–430), so the Core dies
  with KAI instead of leaking.

This is the mechanism that makes "the Core is a child process the app supervises" true
rather than aspirational. **Live, 2026-10-04:** the running Core is pid 4572, build
`7028f6cba503e3ef`, freshness `fresh`, answering on 8788.

---

## 2. Identity and harness loading

- The identity provider is `createKaiIdentity()` (`agent/soul.ts:160`) over the KAI_HOME
  tree (`agent/kai-home.ts`; tree layout kai-home.ts:11–17; `resolveKaiHome()`
  kai-home.ts:334–388). Full treatment: `docs/KAI_SOUL.md` §3.
- The **one** system-prompt composer is `createPromptComposer()` (`prompts/compose.ts:250`),
  built with the live identity provider and live memory/skill ports at
  `runtime.ts:1691–1746`. The composer reads `identity.soul` / `identity.user` through
  **getters** (runtime.ts:1700–1707), so a SOUL.md edit or `soul.set` reaches the next
  turn without a rebuild.
- `composeTurnPrompt()` (runtime.ts:2246; declared runtime.ts:291–294) is the turn's
  prompt. The server uses it before relaying: `server.ts:538` (delegated turns) and
  `server.ts:614` (the OpenCode route); on a compose failure the raw text is used.
- Core identity (which build answers) is `identity.ts` — see §11.

---

## 3. Memory authority

- **The engine.** `createMemoryEngine()` (`memory/engine.ts`) owns memory policy: bounds →
  dedup(hash) → persist → journal → publish (engine.ts:12). It is the only place that
  writes an entry, appends a journal row, or renders on-disk layout (engine.ts:8–10).
  Provenance is explicit and an OMITTED provenance is the most restrictive value,
  `system_state` (engine.ts:437–446). Search takes `MemoryScopeAccess[]`, defaulting to
  global only (engine.ts:106–116).
- **The store.** `openMemoryStore()` (`storage/memoryStore.ts`) owns its own connection to
  the same database file (memoryStore.ts:13–20); FTS5 is **detected, never assumed**
  (memoryStore.ts:22–28); the journal is append-only (memoryStore.ts:30–33). Legacy flat
  `memories` rows are imported once (`importLegacyOnCreate: true`, runtime.ts:987).
- **Scopes.** `global · session · mission · employee · project · subagent`
  (live-verified: an unknown scope is refused with the full list —
  `docs/evidence/kai-twelve-hermes-down.json`). `parseMemoryScopeRef()` runtime.ts:193;
  `rememberScoped`/`recallScoped` runtime.ts:2332/2349; mission/employee/session/subagent
  wrappers runtime.ts:2371–2428.
- **Subagent isolation + governed sharing (KAI-owned mechanism).**
  `memory/shares.ts` (`createSubagentMemoryShares()` shares.ts:86; `SubagentMemoryShare`
  shares.ts:28) stores **pointers** (entry ids), not facts, so the canonical store remains
  the single source of truth (runtime.ts:2518–2525). A `subagent:<id>` recall reads the
  persona's OWN bucket plus ONLY entries explicitly shared TO it
  (`recallForSubagent`, runtime.ts:2432; composer path runtime.ts:1719–1728);
  `shareSubagentMemory` runtime.ts:2471 is the governed grant. Isolation was pinned by
  test evidence: `docs/evidence/subagent-memory-final.json` (A–F + 14 negatives).
- HTTP: `/memory`, `/memory/search`, `/memory/write`, `/memory/share`, `/memory/journal`,
  `/memory/:id` (`routes.ts:2570–2578`).

---

## 4. Workforce — employees, subagents, and the one delegation path

- `createWorkforceManager()` (`workforce/manager.ts:248`) is the layer ABOVE the adapter
  registry: employees (lifecycle state, enabled, role, capability grants). Lifecycle
  states and legal transitions: `EMPLOYEE_TRANSITIONS` (`workforce/lifecycle.ts:57`).
- Registered at runtime construction: Hermes and OpenCode as employees owning the SAME
  adapter objects the registry owns (runtime.ts:1087–1088); **Codex registered
  UNAVAILABLE** with the reason "the codex CLI is not installed on this machine"
  (runtime.ts:1094–1097).
- **Delegation is policy-governed.** `executeTask` routes through the worker tool:
  `tools.invoke("agents.run_task", …)` (runtime.ts:1048) — so a delegation is validate →
  policy → approval → execute like any other action.
- **Subagents are KAI-managed personas.** `createSubagentRegistry()`
  (`workforce/subagent.ts:227`), persisted to `<dbDir>/kai-subagents.json`
  (runtime.ts:971); created through `workforce.subagent` (tool id runtime.ts:449, tool
  definition runtime.ts:707–726), which validates + persists + registers the persona in
  the ONE workforce via `registerSubagentEmployee()` (runtime.ts:2564–2577), borrowing the
  preferred worker's adapter (`descriptorForSubagent`, subagent.ts:371).
- **Runs go through the one path.** `runSubagent()` (runtime.ts:2537–2550) resolves the
  persona's employee, brings it READY (state observed, never assumed), and delegates with
  role `subagent:<id>`; the unique role is what targets it deterministically. A re-issue
  with an `approvalId` consumes the granted approval instead of minting another
  (`6710b7f`; proven in `docs/evidence/kai-subagent-fixed.json`).
- **Boot re-registration.** The persona registry loads `kai-subagents.json` at
  construction, but the workforce starts empty; `start()` re-registers every persona
  (runtime.ts:2773) so `/subagents` does not fall back to UNKNOWN after a restart
  (runtime.ts:2556–2562).
- **Safety is structural** (subagent.ts:17–29): a subagent has no handle to the tool
  registry, policy engine or approval service; a persona whose worker is down registers
  **UNAVAILABLE** rather than inventing a way to run (subagent.ts:415).
- **REST surface (exists at HEAD):** `/subagents` (GET/POST), `/subagents/:id`,
  `/subagents/:id/duplicate`, `/archive|/unarchive`, `/run`, `/sessions`,
  `/sessions/:sessionId/turns`, `/message` (`routes.ts:2543–2555`).
- **The persona `/message` path** (`subagentMessageHandler`, routes.ts:2276–2400): the
  first call parks (409 + `approvalId` + `parked: true`) unless policy already authorizes
  it; a re-issue with the id goes through the SAME `approval.decide` gate (re-issuing the
  exact parked call once), composes the persona's own reply (`personaReply`,
  subagent.ts:352), records the turn on the persona's own session, and attaches a measured
  `execution` block (monotonic start/end; `executionId` = the approval id when a human
  decision executed the run).
- **Subagent visual variant resolver: NOT wired** (runtime.ts:2514–2516 passes only
  `{ path }`; `resolveVisual()` subagent.ts:291–300 returns the declared reference and
  never a resolved asset). See §12.

---

## 5. Sessions

- KAI owns real conversation sessions: `createSessionStore()` (`sessions/store.ts:191`,
  its own SQLite file `<dbDir>/kai-sessions.db`, runtime.ts:1684) and
  `createSessionService()` (`sessions/service.ts:67`): exactly one ACTIVE session; unknown
  id is an error value; archive/activate move the pointer (service.ts:83–148).
- The worker's own conversation id is stored ON the KAI session as `agentSessionId`
  (store.ts:22–26, 72) so a later turn continues the same worker conversation after a
  Core restart.
- HTTP: `/sessions`, `/sessions/active`, `/sessions/:id`, `/sessions/:id/turns`,
  `rename/archive/unarchive/activate` (`routes.ts:2613–2621`). Mutations go through the
  `session.manage` tool (runtime.ts:2624+) — policy-checked like everything else.
- Persona-owned sessions: a subagent's session is created with `agentId: sub.employeeId`
  (routes.ts:2296), so a persona's history never merges into KAI's.
- Rust side: the direct-Claude path keeps its own multi-turn history keyed by KAI session
  id (`claude.rs:61`), and the Core path resolves the binding server-side (`core_chat`,
  claude.rs:273).
- **Does not exist:** no session search, no cross-session summary, no import/export.

---

## 6. Tools — the one boundary

- Nothing reaches the machine except through request → validate → policy → (approval) →
  execute (`tools/registry.ts:10`, `:135`). A tool never decides whether it may run.
- Every executable action emits exactly one `action.executed` record on the ONE bus, from
  `recordAction` (tools/registry.ts:321–390, publish at :374). The record carries
  `coreBuildId` (the anti-stale-Core field), `toolId`, `policyDecision`, `decisionSource`,
  `resultState`, bounded redacted `detail`, `actionId` — and now **`executionId`**,
  attached by spread from the recovery ledger's own formula (tools/registry.ts:342,
  366–372) so a bus record and a ledger row join on ONE id. (This was a named gap in the
  earlier audit; it is fixed. `recoveryDecision` and `employeeInstanceId` are still not
  produced — see §12.)
- Capability actions are tools named `capability.<id>` (`registerCapabilityTool`,
  runtime.ts:1330–1337), so they pass the same boundary; the record names the capability
  automatically (tools/registry.ts:327–329).
- **MCP at HEAD: not wired into the runtime.** `core/src/mcp/` at HEAD is a library
  (registry, integration, tool-adapter, …; `createMcpRegistry` defined at
  `mcp/registry.ts:245`) with **no committed production call site** — the audit's finding
  stands for the committed tree: 0 servers, 0 plugins, `GET /mcp` absent, the capability
  reads UNAVAILABLE; the MCP protocol is used in production only as the private transport
  to `cua-driver`. **Working-tree note:** `core/src/mcp/manager.ts`, `capability.ts`,
  `routes.ts` exist as **uncommitted, in-flight** files (another stream's work); they are
  not part of HEAD and are therefore not part of this record. Re-verify after they land.

---

## 7. Policy and approval

- **Policy.** `createPolicyEngine()` (`policies/gate.ts:227`). The posture is one literal
  table (`DEFAULT_OUTCOME`, gate.ts:99–104): READ → allow; WRITE / EXTERNAL / DESTRUCTIVE
  → needs_approval. Unrecognised risk is treated as `needs_approval` (gate.ts:254–263);
  malformed rules are dropped toward the safe default (gate.ts:120–136); every decision
  names its source (gate.ts:72–77). Modes: `ask-all · normal · auto-read · elevated`
  (mode.ts:79–84); no mode auto-allows DESTRUCTIVE/EXTERNAL and no mode is reached by
  inheritance (mode.ts:30–39, 139–213).
- **Runtime wiring.** Caller rules first, KAI's own `kai-internal-state` authorization
  appended **last** so it is a default a project can narrow (runtime.ts:1511–1520); the
  same baseline is re-appended on `setRules` (runtime.ts:2667+).
- **Approvals.** `createApprovalService()` (`approvals/service.ts:104`); default TTL 10
  minutes (service.ts:63); expiry resolves the waiter by all three settling paths
  (service.ts:23–28). `approval.expired` is deliberately NOT an event — the frozen
  `KaiEventType` has no such member (service.ts:30–34).
- **The binding.** An approval authorises exactly ONE tool: a mismatched `toolId` is
  refused (tools/registry.ts:677–693); REJECTED and EXPIRED approvals are refused
  (tools/registry.ts:696–713). Fail-closed: no gate ⇒ POLICY_DENIED (tools/registry.ts:495);
  no approval service ⇒ APPROVAL_REQUIRED (tools/registry.ts:600–620).
- **Parked non-mission requests** are durable (`createParkedRequestStore`, runtime.ts:1532)
  so "approve and it actually runs" holds across restarts; the subagent `/message` path
  re-issues the exact parked call once through the same gate (routes.ts:2313–2323;
  `6710b7f`; live proof `docs/evidence/kai-subagent-fixed.json`).
- HTTP: `/approvals`, `/approvals/:id/decide` (`routes.ts:2568–2569`).

---

## 8. Recovery

- `createExecutionLedger()` (`recovery/ledger.ts:186`): a durable SQLite ledger
  (`<dbDir>/recovery-ledger.db`, runtime.ts:969, created runtime.ts:1678) with phases
  BEFORE_ACCEPT / AFTER_ACCEPT (ledger.ts:166) and statuses RUNNING / COMPLETED / FAILED
  (ledger.ts:167). `executionIdFor()` gives a deterministic id per (mission, step)
  (ledger.ts:141–143) — the same formula the tool registry now imports
  (tools/registry.ts:42, 207).
- `createBoundaryRunner()` (`recovery/boundary.ts:77`) wraps the executor's `StepRunner`
  seam so a side-effecting step records BEFORE_ACCEPT then AFTER_ACCEPT **before the
  effect** (boundary.ts:14–24, 84–111); a step classified AFTER_ACCEPT or UNKNOWN is
  REFUSED rather than replayed (boundary.ts:94–98); failures that provably never attempted
  the effect are rewound (boundary.ts:53–59, 121–134). Wired once at runtime.ts:1876.
- Boot: `missions.recover()` (runtime.ts:2802) resumes crash-interrupted missions and
  reports blocked ones as a decision-required notification (runtime.ts:2803–2813).
- HTTP: `/recovery/status`, `/recovery/classify` (`routes.ts:2598–2599`).
- **Not wired:** `replayIfSafe()` (boundary.ts:258) has **no production call site** —
  recovery reports and classifies; it does not auto-replay (§12).

---

## 9. Scheduler

- `createScheduler()` (runtime.ts:2030) is a persistent runtime, not a request handler:
  state lives in the store and every fire is written back (scheduler.ts:16–18); time is
  injected (scheduler.ts:19–21); a broken task is quarantined with a max-failure cap
  (scheduler.ts:23); a fire may be claimed with a durable lease so two processes cannot
  run the same slot (scheduler.ts:24–28).
- Every fire routes through the same validate → policy → approval → execute boundary
  (jobs.ts, scheduler.ts:30–34).
- Boot: interrupted leases are settled before the loop can fire them again
  (runtime.ts:2817, "an INTERRUPTED lease is a recovery decision, never a blind replay").
- HTTP: `/schedules`, `/schedules/:id/cancel`, `/scheduler/recover` (`routes.ts:2593–2596`).

---

## 10. The event bus

- One bus (`core/src/events/bus.ts`) carries the control-plane vocabulary — `mission.*`,
  `approval.*`, `agent.*`, `action.executed`, `core.*`, `scheduled_task.triggered`,
  `session.*` — over `/core/events` as `KaiEvent` objects.
- **Redaction is at the bus, before persistence AND delivery** — one redaction, one value
  (bus.ts:16–20), so a secret cannot be persisted and then replayed.
- **The worker-runtime vocabulary is dead on the wire.** `attachProvider` is defined
  (bus.ts:356) and declared (bus.ts:121) but has **zero production call sites**; so are
  `ingestRuntime` (bus.ts:285), `subscribeRuntime` (bus.ts:383), `recentRuntime`
  (bus.ts:401) and the bridge helpers `toControlPlaneEvent`/`serializeRuntimeEvent`
  (`shared/runtime-events.ts:337/314`). Re-verified at HEAD e7697a2. The UI's own FSM
  comment says so: *"no `TurnAdapter` provider is currently attached to the Core's bus"*
  (`app/src/core/runtime-state.ts:240`). Do not draw a diagram in which worker turns
  stream to the UI — they do not.

---

## 11. The artifact-identity invariant

The rule: **the process reports the build it actually loaded, cross-checked against disk
and source, and refuses rather than pretending.**

- `buildId` is a content hash of the source, computed at build time (identity.ts:35–39).
- The loaded identity is frozen at module load; the disk comparison is a separate named
  pair (`onDiskBuildId`, `identityMatchesDisk`) so a stamp rewritten after launch shows as
  a mismatch (identity.ts:20–33).
- `freshness` is derived by ONE pure function (`deriveIdentity`, identity.ts:141–188):
  `stale` if the artifact was built from different source or the stamp changed;
  `unverified` when there is nothing to compare; else `fresh`.
- The boot self-check refuses a stale Core with exit code 5 (identity.ts:206–221).
- Maintenance re-checks identity: running `buildId` vs the `build-info.json` on disk
  (`maintenance/index.ts:105–120`).
- Why it exists: a live acceptance run queried a port and got answers from an OLDER Core,
  reporting them as the build under review (identity.ts:8–16). The invariant is the fix.
- Live at capture: build `7028f6cba503e3ef`, `identityMatchesDisk: true`,
  `artifactMatchesSource: null` with the honest reason *"no core/src beside the running
  artifact (a shipped bundle carries compiled output only); source equality cannot be
  recomputed here"*, freshness `fresh` (`docs/evidence/kai-subagent-fixed.json`).

---

## 12. What is still unwired (honest list, HEAD `e7697a2`)

1. **`attachProvider` / the worker-runtime event vocabulary** — built, type-checked,
   unit-tested, zero production call sites (§10). Worker turns do not stream to the UI.
2. **Subagent visual variant resolver** — not wired; a persona's `variant` is a dangling
   reference (§4).
3. **`recoveryDecision` and `employeeInstanceId` on action records** — declared and
   copied by `buildActionRecord` (action-record.ts:54, 60, 95, 103, 123, 131) but never
   passed by `recordAction`; still always `undefined`. (`executionId` IS now emitted — §6.)
4. **Recovery replay executor** — `replayIfSafe()` has no production call site (§8).
5. **MCP runtime wiring** — not in the committed tree; in-flight uncommitted work exists
   in the working tree (§6). Re-verify after it lands.
6. **Codex** — registered UNAVAILABLE (not installed); nothing routes to it.
7. **Mission planner** — missions are authored explicitly; no natural-language planner.
8. **`approval.expired`** — never published; the frozen event union has no such type.
9. **`POST /soul`** — named in `SOUL_RELOAD_SEMANTICS` but absent as a route; the write
   path is the `soul.set` tool (see `docs/KAI_SOUL.md` §3).
10. **OpenCode server** — was unreachable during both captures (environment fact, not a
    code gap; probed again 2026-10-04 21:22Z: still down).

---

## 13. Evidence and builds

| Evidence | Build | What it shows |
|---|---|---|
| `docs/evidence/kai-twelve-hermes-down.json` | `b52353fd7400a6c1` | 12 KAI-identified answers with Hermes genuinely killed |
| `docs/evidence/kai-direct-hermes-down.json` | `b52353fd7400a6c1` | READ surfaces + approval cycle with Hermes down |
| `docs/evidence/kai-subagent-fixed.json` | `7028f6cba503e3ef` | L2 fix + approval-loop contract, raw |
| `docs/evidence/recovering-final.json` | (RECOVERING chain) | The recovery event path to the renderer (`5839f96`, `ef044e2`) |
| `docs/evidence/subagent-memory-final.json` | — | Per-subagent memory isolation A–F + negatives |
| `docs/evidence/character-runtime-final.json` | — | Character runtime states |
| `docs/evidence/visual-engine-slice.json` | — | The validated Core→renderer visual slice (`e43b1d3`) |

Commits: `8fea1bf` (identity foundation), `acc4b67` (L2 identity fix), `6710b7f`
(approval-loop fix), `8c75806` (integrations test), `5839f96`/`ef044e2` (RECOVERING
wiring + live proof), `e7697a2` (L2 evidence).
