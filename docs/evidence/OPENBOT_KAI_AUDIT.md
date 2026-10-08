# OpenBot → KAI mechanism audit

**Repo audited:** `C:\Users\DELL\AppData\Local\Temp\openbot-audit\openbot` (read-only shallow clone of https://github.com/ashhart/OpenBot, described by its README as a from-scratch re-implementation of GrokBot).
**Compared against (KAI):** `C:\Users\DELL\Desktop\kai\core\src` + `C:\Users\DELL\Desktop\kai\app\src`.
**Classification keys:** KEEP / ADAPT / REIMPLEMENT / ALREADY EXISTS IN KAI / NOT APPROPRIATE.

> Classification intent: where KAI already owns a comparable (usually stricter) mechanism, the row is **ALREADY EXISTS IN KAI** and cites the KAI file. Where OpenBot has a genuinely useful shape KAI lacks or has only partially, it is **ADAPT**. Where OpenBot's design conflicts with KAI's architecture, it is **NOT APPROPRIATE**.

---

## Executive summary

### Mechanism count by classification

| Classification | Count | Mechanisms |
|---|---|---|
| ALREADY EXISTS IN KAI | 13 | 1, 2, 6, 7, 9, 12, 13, 15, 16, 17, 18, 20, 23 |
| ADAPT | 9 | 3, 5, 8, 10, 11, 14, 19, 21, 22 |
| NOT APPROPRIATE | 1 | 4 |
| KEEP | 0 | — |
| REIMPLEMENT | 0 | — |
| **Total** | **23** | |

### Repo license

- **MIT** — `LICENSE:1` ("MIT License", Copyright (c) 2026 OpenBOT contributors) and `package.json:16` (`"license": "MIT"`).

### Third-party components (from `THIRD-PARTY-NOTICES.md` + `LICENSE`)

| Component | Version | Kind | License | Where stated |
|---|---|---|---|---|
| highlight.js | 11.12.0 | Bundled (renderer) | **BSD-3-Clause** | THIRD-PARTY-NOTICES.md:15-54 |
| marked | 18.0.9 | Bundled (renderer) | **MIT** (file also reproduces John Gruber's **Markdown** notice, BSD-style) | THIRD-PARTY-NOTICES.md:58-113 |
| react / react-dom | 19.2.8 | Bundled (renderer runtime) | **MIT** | THIRD-PARTY-NOTICES.md:117-148 |
| electron | 43.4.0 | Bundled (app runtime; embeds Chromium + Node.js) | **MIT** (Chromium/Node licenses shipped as `LICENSES.chromium.html`) | THIRD-PARTY-NOTICES.md:152-188 |
| Synara | — | **Adapted** (no upstream code ships; OpenBot source derived from it — agent-CLI backend transport patterns: login-shell env hydration, server-mode discovery via stdout scraping, JSON-RPC session handling, per-CLI detection metadata, canonical provider event model) | **MIT** (Copyright (c) 2026 T3 Tools Inc.; Copyright (c) 2026 Emanuele Di Pietro) | THIRD-PARTY-NOTICES.md:192-227 |

Provenance note: THIRD-PARTY-NOTICES.md:231-237 states OpenBot is an independent clean-room reimplementation with respect to any proprietary application. Dev-only packages (`electron-builder`, `vite`, `typescript`, `esbuild`, `@vitejs/*`) are in `package.json` devDependencies and are not called out as redistributed.

**Attribution implication for KAI:** the backend/CLI-adapter transport layer (mechanism 22) is the one place OpenBot is directly derived from third-party MIT code (Synara). Any reuse of that layer must carry the Synara MIT notice shown at THIRD-PARTY-NOTICES.md:204-227.

---

## Mechanism-by-mechanism

### 1. Outer turn loop vs individual model turn — ALREADY EXISTS IN KAI

- **OpenBot:** `src/main/agent/loop.ts:34` `sendMessage()` owns one *user* turn (record → cancellable run → `iterate` → always emit `done`); `src/main/agent/turnDriver.ts:47` `iterate()` / `:58` `runTurns()` drives *turns* until one finishes (`:98` while loop); `src/main/agent/turn.ts:47` `runTurn()` is exactly one model round-trip and never decides to continue; `src/main/agent/turnTypes.ts:13` `TurnStatus` (`final | tools | handoff | aborted | error`) is the contract between the two. `backendMode.ts:18` splits the loop into `orchestrated` (we own it) vs `supervised` (CLI owns it).
- **What it does:** cleanly separates the outer "keep going until done" driver from one model turn, and represents a turn's outcome as a status enum.
- **KAI:** already separates these — `core/src/chat/turns.ts:57` `beginTurn()` / `:90` `finishTurn()` wrap the turn in a task lifecycle, and `core/src/chat/brain.ts:417` `respond()` owns the model→tool→model loop.
- **Class:** ALREADY EXISTS IN KAI (cite `core/src/chat/turns.ts`, `core/src/chat/brain.ts`). The status enum is a minor implementation nicety, not a missing mechanism.

### 2. Iteration limits — ALREADY EXISTS IN KAI

- **OpenBot:** `src/main/agent/limits.ts:11` `MAX_ITERATIONS = 25`; `:47` `takeIteration()` (false ends the turn); `:80` `iterationCapMessage()`; enforced at `turnDriver.ts:125`. Supervised (CLI) turns are instead bounded by a 20-minute *inactivity* clock (`backendMode.ts:29`, `idleClock.ts:21`).
- **KAI:** `core/src/chat/brain.ts:178` `DEFAULT_MAX_TOOL_ITERATIONS = 6`, `:184` runtime-configurable, `:434` the loop breaks when the budget is hit; `core/src/chat/turns.ts` then records `toolBudgetExhausted` and pauses honestly.
- **Class:** ALREADY EXISTS IN KAI (cite `core/src/chat/brain.ts:178-184,434`). OpenBot's inactivity-timer for CLIs is the one nuance KAI's model-owned loop does not have, but KAI's per-turn cap covers the runaway case.

### 3. Handoff limits — ADAPT

- **OpenBot:** `src/main/agent/limits.ts:19` `MAX_CONSECUTIVE_HANDOFFS = 12`; `:59` `takeHandoff()`; `:72` `handoffsLeft()`; enforced in `handoff.ts:91,142` and `turnDriver.ts:142`; a bot-to-bot pass with no user input is capped so two bots cannot volley forever.
- **KAI analogue:** bounded retry/review budgets exist but are task-shaped, not conversation-shaped — `core/src/orchestration/orchestrator.ts` (bounded `runReviewLoop`, retry-on-CHANGES_REQUESTED), `core/src/orchestration/board.ts` `checkRetry`, `core/src/autonomy/supervisor.ts:144` `maxAttempts`.
- **Class:** ADAPT. Port the explicit "consecutive teammate hand-off counter, reset on user input" as an orchestration bound; KAI has the retry budgets but not a consecutive-handoff ceiling.

### 4. Multi-bot floor / moderation — NOT APPROPRIATE

- **OpenBot:** `src/main/agent/turnDriver.ts:58` `runTurns()` is a moderator (decides who speaks, briefs each turn at `:132`); `exchange.ts:156` `parseAction()` parses a trailing `ACTION: SPEAK|ASK|YIELD|FINAL` line; `exchangeBrief.ts:78` `floorBrief()` restates the goal and ending every turn; `turnAction.ts:49` `applyAction()` moves the floor. Multiple bots share one transcript and take turns.
- **KAI analogue / conflict:** KAI *does* have a moderator-shaped component — `core/src/orchestration/dispatch.ts:223` `createDispatcher` + `core/src/orchestration/orchestrator.ts` `nextMove()` — but KAI's constitution is deliberately single-speaker: "KAI remains the speaker; a worker is provenance" (`core/src/chat/router.ts`, `core/src/orchestration/orchestrator.ts`). A multi-persona floor protocol that lets several identities speak in one transcript would cross KAI's identity boundary (`core/src/agent/soul.ts`, `core/src/agent/identity-model.ts`) and its "KAI answers as itself" rule.
- **Class:** NOT APPROPRIATE. KAI should keep routing work through the orchestrator/dispatcher rather than adopting a shared-transcript floor.

### 5. Background task model — ADAPT

- **OpenBot:** `src/main/tasks.ts:20` `MAX_CONCURRENT_RUNS = 2`; `:30-31` `MAX_ACTIVE_TASKS = 32` / `MAX_ACTIVE_TASKS_PER_BOT = 4`; `:55` `startBackgroundTask()`; `:97` `cancelBackgroundTask()`; `:116` `pump()` worker pool; `:140` `run()` maps completion/failure; `store/tasks.ts:8` statuses `queued|running|completed|failed|cancelled`; per-bot and global admission checks at `:60-65`; `tools/agent/delegate.ts:28` exposes delegation.
- **KAI analogue:** `core/src/scheduler/scheduler.ts` (queued/due/running/quarantined + `MAX_FAILURES`), `core/src/missions/executor.ts` (mission lifecycle), `core/src/autonomy/supervisor.ts` (bounded retries), `core/src/orchestration/board.ts` (`maxDepth`/`maxParallel`).
- **Class:** ADAPT. KAI lacks OpenBot's explicit *bounded concurrency pool + per-owner quota* for independently tracked agent tasks; port the pool/quota admission model.

### 6. Activity / inbox model — ALREADY EXISTS IN KAI

- **OpenBot:** `src/main/store/activity.ts:27` `addActivity()`, `:30` prunes to 500 items; `src/shared/activity.ts:3` `ActivityKind = info|approval|help|completed|failed`; `src/main/ipc/broadcast.ts:89` `postActivity()` records an inbox item and optionally raises a native notification; `src/renderer/src/state/activity.ts` renders it.
- **KAI:** `core/src/notifications/service.ts:86` `notify()` (with dedupe window, bus mirror), persisted in `core/src/storage/sqlite.ts:664` (`notifications`), plus a separate `ActivityStore` at `core/src/storage/sqlite.ts:1089`.
- **Class:** ALREADY EXISTS IN KAI (cite `core/src/notifications/service.ts`, `core/src/storage/sqlite.ts:664,1089`).

### 7. Approval policy — ALREADY EXISTS IN KAI

- **OpenBot:** `src/main/agent/approvalPolicy.ts:134` `evaluate()`; four policies `ask-every-time` (default) / `ask-first-time` / `allowlist` / `auto-run`; `ask-first-time` memory keyed `tool::target` (`:112`, `:169`); `src/main/agent/approval.ts:71` `requestApproval()` parks on a promise (5-minute timeout at `:21`).
- **KAI:** `core/src/policies/gate.ts:227` `createPolicyEngine` with a risk table (`DEFAULT_OUTCOME`, `:99`) and `core/src/policies/mode.ts:79` modes `ask-all|normal|auto-read|elevated`; `core/src/approvals/service.ts:205` `request()` parks a durable approval with TTL and `waitFor()`.
- **Class:** ALREADY EXISTS IN KAI (cite `core/src/policies/gate.ts`, `core/src/policies/mode.ts`, `core/src/approvals/service.ts`). KAI's risk taxonomy + two-phase elevation is strictly more expressive.

### 8. Deny-first policy — ADAPT

- **OpenBot:** `src/main/agent/approvalPolicy.ts:97` `deniedRuleForCall()` matches the denylist against *every* argument (not just the derived target); `:143` `evaluate()` checks the denylist **first** and it beats every policy including `auto-run`; `src/main/agent/execute.ts:109` re-checks the denylist before any handler runs.
- **KAI analogue:** `core/src/policies/gate.ts` is safe-by-default (`needs_approval`) and rules can `deny`, but there is no explicit "hard denylist that outranks every mode and rule and is matched against all arguments".
- **Class:** ADAPT. Add a rule/mode-independent denylist evaluated before everything, matched against the whole call payload (KAI's `tools/registry.ts` validate step is the natural seam).

### 9. Action gating — ALREADY EXISTS IN KAI

- **OpenBot:** `src/main/agent/execute.ts:82` `gate()` enforces, in order: aborted → mode → denylist → computer-use permission, then `:123` `approveAndRun()` (approval → handler); `modes.ts:56` `allowedInMode()`; `toolContext.ts:31` `SELF_APPROVING` set (computer tools carry their own preview approval).
- **KAI:** `core/src/tools/registry.ts:504` `invoke()` is the single boundary: `validate → policy → (approval) → execute`, and nothing else runs a tool body.
- **Class:** ALREADY EXISTS IN KAI (cite `core/src/tools/registry.ts:504`).

### 10. Repetition detection — ADAPT

- **OpenBot:** `src/main/agent/repetition.ts:97` `collapseRepeatedLines()` collapses prose a model repeats *inside one reply* (CLI block concatenation), deliberately conservative (never touches code/lists/tables); `replyHistory.ts:39` `isRepeatReply()` detects a reply the session already heard and ends the exchange (`turnAction.ts:63`).
- **KAI analogue:** only a structural guard — `core/src/chat/brain.ts:365` `synthesize()` runs a final tools-disabled pass when the budget is hit or text is empty. There is no lexical/intra-reply duplicate collapse and no cross-turn "said this already" check.
- **Class:** ADAPT. Port both: intra-reply stutter collapse for streamed turns and a cross-turn repeat signature that ends a stalled loop.

### 11. Context budgeting — ADAPT

- **OpenBot:** `src/main/agent/budget.ts:15` `DEFAULT_CONTEXT_WINDOW = 8192`; `:52` `applyBudget()` keeps head (the request/goal) + tail (current state) and replaces the middle with an extractive, model-free summary (`:154` `summaryMessage()`); `:106` `fitMessages()` then *shrinks message text* until the prompt actually fits; system prompt and newest turns are never dropped.
- **KAI analogue:** `core/src/sessions/service.ts:756` `compact()` is turn-count based (`keepFirst`/`keepLast`), and `:84` `buildSessionSummary()` produces an extractive digest — but there is no token-budget accounting and no fit-to-tokens trimming.
- **Class:** ADAPT. Port token-budgeted head/tail windowing + last-resort `fitToTokens` shrinking on top of KAI's existing digest/compact.

### 12. Structured handoff — ALREADY EXISTS IN KAI

- **OpenBot:** `src/main/agent/handoff.ts:47` `parseHandoffArgs()`, `:115` `performHandoff()` (roster check + cap + reason/note); `handoffBrief.ts:54` `toolBrief()` defangs the note (an injected `ACTION:` line cannot end an exchange from inside a prompt); `exchange.ts:156` parses the text `ACTION:` protocol for CLI backends.
- **KAI:** `core/src/orchestration/orchestrator.ts:130` `HANDOFF_FORMAT`, `:144` `handoffFromText()` (lenient section parser), `:184` `verifyHandoff()` (structural verification of the returned handoff).
- **Class:** ALREADY EXISTS IN KAI (cite `core/src/orchestration/orchestrator.ts:130-199`).

### 13. Human escalation / ask-person — ALREADY EXISTS IN KAI

- **OpenBot:** `src/main/tools/agent/help.ts:15` `requestHelpTool` (`request_help`); `:48` parks the turn on a promise, emitting `human-help-request`/`human-help-resolved` (`shared/events.ts:17,57-58`); `ipc/broadcast.ts:50` raises an inbox item + notification.
- **KAI:** `core/src/approvals/service.ts:282` `waitFor()` (durable, expiry-resolved), `core/src/approvals/parked.ts:89` `createParkedRequestStore()` (durable parked calls re-issued after a verdict, restart-safe), plus ASK autonomy parks in `core/src/orchestration/orchestrator.ts`.
- **Class:** ALREADY EXISTS IN KAI (cite `core/src/approvals/service.ts`, `core/src/approvals/parked.ts`).

### 14. Routine recording / replay — ADAPT

- **OpenBot:** `src/main/agent/recorder.ts:57` `startRecording()`, `:76` `captureToolStep()` records each executed tool call with natural-language intent and, for computer steps, the on-screen screenshot; `:95` `stopRecording()`. `replay.ts:64` `replayRoutine()` replays either `literal` (captured params) or `adaptive` (`:135` `deriveAdaptiveCall()` re-derives the action from intent + a fresh frame via a model side-call); all replay runs through `executeCall` so approval/mode/computer gates still apply (`:94`).
- **KAI analogue:** KAI records *skills* from work (`core/src/learning/pipeline.ts`, `core/src/skills/library.ts`) rather than coordinate/parameter macros, and has computer transport seams (`core/src/capabilities/computer/`) but no record-and-replay engine.
- **Class:** ADAPT. The adaptive replay loop (intent + current screenshot → one tool call, with literal fallback) is worth porting onto KAI's capability transport; keep it behind the policy gate.

### 15. Execution-target abstraction — ALREADY EXISTS IN KAI

- **OpenBot:** `src/shared/computer.ts:12` `ComputerTarget` (`local|browser|vm`), `:113` `ComputerProvider`; `src/main/tools/computer/index.ts:54` `getComputerProvider()` caches one provider per target; `vmProvider.ts` / `browser/*` implement it; the tool layer is target-agnostic (`computer/gate.ts:53`).
- **KAI:** `core/src/capabilities/computer/transport.ts:158` `ComputerTransport` (connect/inspect/act/observe/windows) + `fake-transport.ts`/`real-transport.ts`; `core/src/capabilities/browser/transport.ts:194` `BrowserTransport`; both behind `core/src/capabilities/registry.ts`.
- **Class:** ALREADY EXISTS IN KAI (cite `core/src/capabilities/computer/transport.ts`, `core/src/capabilities/browser/transport.ts`).

### 16. Capability-based tool availability — ALREADY EXISTS IN KAI

- **OpenBot:** `src/main/tools/registry.ts:83` `VM_BOX_TOOLS`, `:128` `schemasFor()` removes box/computer tools when the target has not advertised the capability; `tools/computer/vmProtocol.ts:24` `hasVmBoxCapabilities()` / `hasVmComputerCapability()`; `agent/context.ts:78` `availableTools()` also filters by mode + computer permission.
- **KAI:** `core/src/capabilities/registry.ts:222` `createCapabilityRegistry()` (availability `AVAILABLE/DEGRADED/UNAVAILABLE/DISABLED`, under-claimed), `core/src/capabilities/manager.ts:256` `plan()` (only AVAILABLE is planned onto), `core/src/tools/model-plane.ts:126` `defaultModelToolIds()` (only safe/exposed tools are advertised).
- **Class:** ALREADY EXISTS IN KAI (cite `core/src/capabilities/registry.ts`, `core/src/capabilities/manager.ts:256`, `core/src/tools/model-plane.ts:126`).

### 17. Fail-closed behavior — ALREADY EXISTS IN KAI

- **OpenBot:** `src/main/tools/registry.ts:172-202` `runTool()` refuses VM box/computer tools when the capability is absent rather than falling back to the host; `agent/backendGateway.ts:20,108` returns `null` instead of throwing; `tools/approval.ts:45` treats a thrown gate as refusal; `agent/chatRequest.ts:107` the CLI approval callback rejects anything unclassifiable.
- **KAI:** `core/src/policies/gate.ts:254` an unrecognized risk → `needs_approval` (never silently allowed); `core/src/capabilities/registry.ts:340` a malformed/ crashed health probe → `UNAVAILABLE`; `core/src/tools/registry.ts:578` no policy gate → `POLICY_DENIED`; `core/src/policies/mode.ts:121` an unconfirmed elevation resolves *down*; approvals expire.
- **Class:** ALREADY EXISTS IN KAI (cite `core/src/policies/gate.ts:254`, `core/src/capabilities/registry.ts:340`, `core/src/tools/registry.ts:578`).

### 18. Event model — ALREADY EXISTS IN KAI

- **OpenBot:** `src/shared/events.ts:25` one canonical `AgentEvent` union normalised from every backend; `src/main/agent/events.ts:21` `broadcast()` fans out (listener errors swallowed); `src/main/ipc/broadcast.ts:42` mirrors to all windows.
- **KAI:** `core/src/events/bus.ts:104` `EventBus` (canonical `KaiEvent` + `RuntimeEvent`), `:183` `createEventBus` with **redact-before-persist-and-deliver**, mandatory provider attribution, and per-subscriber isolation.
- **Class:** ALREADY EXISTS IN KAI (cite `core/src/events/bus.ts`).

### 19. Task cancellation — ADAPT

- **OpenBot:** `src/main/agent/cancel.ts:25` `start()` mints one `AbortController` per session; `:58` `register()` lets any resource (child process, watcher, timer) add a disposer; `:74` `abort()` aborts the controller and runs every disposer; `:110` `abortAll()` on quit; `loop.ts:88` `stopSession()` also cancels pending approvals and memory extraction; `tasks.ts:97` cancels background tasks.
- **KAI analogue:** cancellation exists at coarser granularity — `core/src/missions/executor.ts:556` `cancel()` (sets a cancelled flag checked between steps), `core/src/scheduler/scheduler.ts:814` `stop()` — but there is no per-run abort signal with a disposer registry to reach an in-flight tool/stream/child process.
- **Class:** ADAPT. Port the per-run `AbortController` + disposer-registry pattern so an in-flight tool, stream, or spawned process is reachable by "stop".

### 20. Persistence of task / activity state — ALREADY EXISTS IN KAI

- **OpenBot:** `src/main/store/collection.ts:17` `JsonCollection` (per-`<id>.json`, debounced atomic writes, quarantine on parse failure, load-incomplete tracking); `store/tasks.ts:34` `loadTasks()`; `store/activity.ts:24` `loadActivity()`.
- **KAI:** `core/src/storage/sqlite.ts:160` `openSqliteStores()` implements the `Stores` aggregate (`tasks` `:844`, `missions` `:468`, `notifications` `:664`, `activity` `:1089`), with transactions and `core/src/storage/schema.ts` migrations.
- **Class:** ALREADY EXISTS IN KAI (cite `core/src/storage/sqlite.ts`, `core/src/storage/schema.ts`).

### 21. Structured output cards — ADAPT

- **OpenBot:** `src/shared/cards.ts:2` `RichCardSpec` (`email-draft|message-draft|link`); the system prompt teaches an `openbot-card` fenced JSON block (`agent/systemPrompt.ts:104-105`); `src/renderer/src/components/RichCard.tsx:83` renders it with an origin note, per-address listing, mailto RFC-6068 encoding, and link-host validation before any affordance.
- **KAI analogue:** KAI has a validated visual-intent engine (`core/src/visual/spec.ts:577` `validateIntent` — bounded, first-failure-named, nothing repaired) and tool-call cards (`app/src/chat/tool-card.ts:74` `describeToolCall`), but not a safe *actionable* assistant card (draft/link) with provenance marking and destination inspection.
- **Class:** ADAPT. The card-as-validated-intent + provenance/host-display discipline fits KAI's visual spec model; add `email-draft`/`message-draft`/`link` kinds.

### 22. Backend abstraction — ADAPT

- **OpenBot:** `src/shared/backends.ts:8` `BackendKind` (`local-server|agent-cli|cloud-api`); `src/main/backends/types.ts:178` the `Backend` interface (`detect`/`listModels`/`chat`) and `:81` `ChatRequest`; `backends/registry.ts:31` registers CLI + cloud adapters and detects them with a hard 8s budget (`:24`); `cli/spec.ts:13` `AgentCliSpec` is a data row per CLI. THIRD-PARTY-NOTICES.md:194-227 says the CLI transport layer is **adapted from Synara (MIT)**.
- **KAI analogue:** `core/src/model/types.ts` `ModelProvider` + `core/src/model/openai-compatible.ts`, `core/src/providers/registry.ts:77` `createProviderRegistry`, and `core/src/agents/registry.ts:49` `createAgentRegistry` with only `hermes`/`opencode` adapters (`core/src/agents/adapters/`).
- **Class:** ADAPT. KAI already abstracts model providers and agent workers, but OpenBot/Synara's multi-CLI host layer (login-shell PATH hydration, server-ready stdout discovery, per-CLI detection metadata, bounded detection) is broader and is the strongest reusable piece — reuse must carry the Synara MIT notice.

### 23. Recovery behavior — ALREADY EXISTS IN KAI

- **OpenBot:** `src/main/store/tasks.ts:34-44` on boot, any `queued`/`running` task is marked `failed` ("OpenBOT closed before this task finished"); `src/main/tasks.ts:155-164` a run that produced no assistant message counts as failure; `replay.ts:135-142` adaptive replay falls back to literal when a fresh frame/model is unavailable; supervised turns are bounded by an inactivity clock.
- **KAI:** `core/src/recovery/ledger.ts:186` (durable BEFORE_ACCEPT/AFTER_ACCEPT boundary, `classify()` never replays UNKNOWN), `core/src/recovery/boundary.ts:77` `createBoundaryRunner()` (refuses to replay crossed side effects), `core/src/missions/executor.ts:589` `recover()` (resume safe steps, block side-effecting ones, resolve parked approvals), `core/src/scheduler/scheduler.ts:768` `recoverInterrupted()`, `core/src/approvals/parked.ts:180` `prune()`.
- **Class:** ALREADY EXISTS IN KAI (cite `core/src/recovery/ledger.ts`, `core/src/recovery/boundary.ts`, `core/src/missions/executor.ts:589`). KAI's ledger is considerably more rigorous than OpenBot's boot-time status sweep.

---

## Top 8 ADAPT candidates (one-line rationale each)

1. **#8 Deny-first hard denylist** (`agent/approvalPolicy.ts:97,134,143`) — a denylist matched against *every* argument and evaluated before all policies is a security primitive KAI's risk gate lacks.
2. **#11 Token-budgeted context windowing + fit-to-tokens** (`agent/budget.ts:52,106,154`) — KAI's `sessions/service.ts:756` compacts by turn count only; OpenBot fits an actual token budget and never drops the goal or current state.
3. **#10 Repetition detection** (`agent/repetition.ts:97`, `replyHistory.ts:39`) — collapse intra-reply stutter and end a stalled multi-round loop on a repeated reply; KAI has only the structural synthesis guard.
4. **#19 Per-run cancellation with disposer registry** (`agent/cancel.ts:25,58,74`) — makes an in-flight tool/stream/child process reachable by "stop"; KAI cancels only at mission/step granularity.
5. **#3 Consecutive hand-off / runaway loop cap** (`agent/limits.ts:19,59`) — an explicit ping-pong ceiling reset by user input, complementing KAI's retry budgets.
6. **#5 Bounded background-task pool + per-owner quota** (`src/main/tasks.ts:20,30-31,116`) — admission control for independently tracked agent tasks; KAI has scheduling but no per-owner concurrency quota.
7. **#22 Synara-derived multi-CLI backend layer** (`backends/types.ts:178`, `cli/spec.ts:13`; MIT-adapted) — the broadest reusable artifact, but must ship the Synara MIT notice (THIRD-PARTY-NOTICES.md:204-227).
8. **#14 Adaptive routine record/replay** (`agent/recorder.ts:76`, `replay.ts:64,135`) — replay a captured workflow by re-deriving each step from intent + a fresh frame, gated through policy; KAI has skills but no replay engine.

*(9th ADAPT, runner-up: **#21 structured action cards** — `shared/cards.ts:2` / `RichCard.tsx:83`; the validated-intent + provenance discipline would extend KAI's `visual/spec.ts`.)*

## Notable single NOT APPROPRIATE

- **#4 Multi-bot floor / moderation** (`agent/turnDriver.ts:58`, `exchange.ts:156`, `exchangeBrief.ts:78`) — conflicts with KAI's single-speaker constitution (KAI speaks; workers are provenance) and its identity boundary; KAI should keep routing through `orchestration/dispatch.ts` and `orchestrator.ts` rather than adopting a shared-transcript floor protocol.
