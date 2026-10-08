# KAI Core

KAI Core is the **control plane**: it owns state, agents, missions, memory,
notifications, scheduling, policy and tool routing. The desktop app is the
**presentation and control surface**. The UI is not the brain — if the island is
hidden, retracted or restarted, the Core keeps running and the UI reconnects.

Status vocabulary used throughout this document, and in every doc in `docs/`:
**IMPLEMENTED** (works, verified) · **PARTIAL** (exists, incomplete) · **PLANNED**
(designed only — never described as if it worked).

---

## 1. Boundaries — what belongs where

Determined by reading `app/src/`, `app/src-tauri/src/` and `core/` before writing
any Core code (Phase 2 spec §3). The point of the table is that each row is a
*current* fact, not an aspiration: what already sits on the wrong side of the line
is marked **MOVE**.

| Concern | Belongs to | Where it is today |
|---|---|---|
| Island window geometry, top-of-screen placement, click-through, multi-monitor/DPI | Rust (`app/src-tauri/src/island.rs`) | there — correct |
| Tray, autostart, single instance, NSIS packaging | Rust | there — correct |
| Window/UI state: FSM, views, animation, character rendering | UI (`app/src/island`, `app/src/views`, `app/src/character`) | there — correct |
| Credential storage (Windows Credential Manager) | Rust (`secrets.rs`) | there — correct |
| Claude Code hook relay + named pipe | Rust (`hook/`, `pipe.rs`) | there — correct |
| **Agent polling** (Hermes/OpenCode status, sessions) | Core | **MOVE** — `app/src-tauri/src/integrations.rs` (~1145 lines) polls and the UI renders the result |
| **Chat routing** (which agent answers, when no LLM is needed) | Core | **MOVE** — `app/src-tauri/src/claude.rs` currently tries Hermes → KAI Core → Anthropic |
| **Mission orchestration, scheduling, policy, approvals, memory, notifications** | Core | **MOVE** — do not exist yet; `core/` is the home |
| Agent protocol details (ports, routes, polling, stop semantics) | Core adapters only | **MOVE** — 8642, `/v1/runs`, 4096 and `/session/{id}/message` currently appear in Rust and in the UI's display strings |

The dependency direction is one-way and enforced by the contracts:

```
UI  →  Core API (HTTP/WS)  →  agents / tools / storage
```

never the reverse. Concretely: the UI may display, request, subscribe and notify;
it must not decide which agent runs, schedule anything, or talk to an agent's HTTP
API itself.

## 2. Frozen contracts

`core/src/shared/contracts.ts` is the single source of truth for every shape that
crosses a boundary: `AgentAdapter`, `AgentStatus`, `AgentHealth`, `AgentTask`,
`AgentTaskResult`, `RunState`, `KaiError`/`KaiErrorCode`, `KaiEvent` +
`KaiEventType`, `Mission`, `MissionStep`, `KaiNotification`, `Approval`,
`Memory`, `ScheduledTask`, `CoreHealth`, `Diagnostics`.

Two rules make the parallel work safe:

1. **Extend, do not reshape.** Modules are written against this file
   concurrently; changing a shape breaks work in flight elsewhere.
2. **Types are not validation.** TypeScript types are erased at runtime and data
   crossing IPC is untrusted, so the file also carries runtime guards
   (`isKaiEvent`, `isAgentStatus`, `isIsoTimestamp`, …) and those are what
   actually protect the Core.

It also defines the **persistence boundary** — `EventStore`, `MissionStore`,
`MemoryStore`, `NotificationStore`, `ApprovalStore`, `ScheduledTaskStore` and the
`Stores` aggregate. The SQLite module implements those interfaces; everything
else depends only on the interfaces, which keeps the database out of the business
logic and lets tests use in-memory doubles.

### The rule that keeps secrets safe

An API key is read from the Credential Manager, passed into an adapter, and
appears **only** in an `Authorization` header. It is never logged, never returned
in a response body, never embedded in an error message, and never placed in
frontend JavaScript. `KaiError` carries a code and a message, not a request dump.

## 3. Module map

| Path | Responsibility | Status |
|---|---|---|
| `core/src/shared/contracts.ts` | All cross-boundary shapes + guards + store interfaces | IMPLEMENTED (authored by the parent, frozen) |
| `core/src/storage/sqlite.ts`, `schema.ts` | SQLite (`node:sqlite`), migrations, the `Stores` implementation | IMPLEMENTED — 15 tests, run by the parent |
| `core/src/events/bus.ts` | Publish/subscribe bus, selective persistence | IMPLEMENTED — 16 tests, run by the parent |
| `core/src/notifications/service.ts` | Notification creation, dedupe, read state | IMPLEMENTED — 11 tests, run by the parent |
| `core/src/agents/registry.ts` | Register/connect/health/status across agents | IMPLEMENTED — 7 tests, run by the parent |
| `core/src/agents/adapters/hermesAdapter.ts` | Hermes gateway api-server behind `AgentAdapter` | IMPLEMENTED — 13 tests, run by the parent |
| `core/src/agents/adapters/opencodeAdapter.ts` | OpenCode headless server behind `AgentAdapter` | IMPLEMENTED — tests above cover both adapters |
| `core/src/agents/mock.ts` | Deterministic mock agents for tests | IMPLEMENTED — exercised by the adapter tests |
| `core/src/missions/{mission,executor}.ts` | Mission lifecycle + step executor + crash recovery | IMPLEMENTED — wired into the runtime, 6 end-to-end tests |
| `core/src/scheduler/*` | Persistent once/interval/daily tasks | IMPLEMENTED — wired; a due task really creates and runs a mission |
| `core/src/policies/gate.ts`, `tools/registry.ts`, `tools/builtin.ts`, `approvals/service.ts` | Policy engine, tool registry, approvals | IMPLEMENTED — wired; approval and denial paths exercised end to end |
| `core/src/runtime.ts` | Composition root: the one module that knows the others exist | IMPLEMENTED — verified by `tests/runtime.test.ts` (boot, mission, approval, denial, timer, restart) |
| `core/src/agents/hermes.ts`, `opencode.ts` | Pre-existing clients: `/health`, `/v1/models`, `/v1/capabilities`, `/api/sessions(/{id}/chat)` | IMPLEMENTED for what they cover — and note they contain **no `/v1/runs` calls at all**, so the adapter had to add that transport itself rather than wrap it |
| `core/src/api/routes.ts` | The Core's HTTP surface (state, agents, missions, approvals, memory) | IMPLEMENTED — mounted in `server.ts`, 36 tests, and driven live with curl |
| `core/src/memory/service.ts` | Durable memory: remember / search / forget / digest | IMPLEMENTED — 12 tests, wired into the runtime |
| `core/src/chat/router.ts` | Rule-based intent routing so state questions are answered from state | IMPLEMENTED — 21 tests; live: "what is hermes doing?" → real answer |
| `core/src/server.ts` | HTTP/SSE server on `127.0.0.1:8788`; owns the Core's lifecycle in `main()` | IMPLEMENTED — pre-existing routes unchanged, Core surface mounted after them |
| UI↔Core client (island consuming `/state` and `/core/events`) | app + Core | PLANNED — `POST /chat` already reaches the Core router |

**How the status column is decided.** A module is IMPLEMENTED only after the parent
has run its tests and seen them pass — never on the strength of the workstream's own
summary. Verification for this revision, run from `core/`:

```
cd core && npm test          # 229 tests, 229 pass, 0 fail, 0 skipped
```

`npm test` runs every `*.test.ts` in `core/tests` and `core/src` straight from
TypeScript — no build step — and loads `API_SERVER_KEY` from the Hermes install for
the live-auth suites. `docs/testing.md` explains why the runner is a script rather
than a glob in `package.json`.

The Core now runs as a real process (`npm start`) and serves the API documented in
`docs/api.md`; it was driven end to end with curl on this machine, including a
mission that really executed a tool, a memory that survived a restart, and a state
question answered without any model turn.

Modules are wired into one runtime in `core/src/runtime.ts`; the end-to-end suite
(`core/tests/runtime.test.ts`) boots the whole Core against a real SQLite file and
asserts observed behaviour: a mission that completes through a tool step and an
agent step, an external tool that parks for approval *without executing*, a deny
rule that fails a step before the tool runs, a scheduled task that fires and runs a
real mission, and state — including an interrupted mission — that is still correct
after the process that owned it has stopped.

Two corrections worth recording, both found by self-reporting workstreams and then
confirmed by the parent:

- The pre-existing `core/src/agents/hermes.ts` is **not** a `/v1/runs` client. The
  verified run path (`POST /v1/runs` → poll `GET /v1/runs/{id}`) exists in the
  adapter added in this phase, not in the older client.
- Node 26 does not resolve a `./x.js` specifier to `./x.ts`, so the build needed
  `rewriteRelativeImportExtensions` (`core/tsconfig.json`) to keep compiling once
  source files carried `.ts` specifiers. Testing goes through
  `core/scripts/test.mjs`; see `docs/testing.md`.

## 3b. Known limitations and deliberate sentinels

Recorded from the workstream reports and then checked against the code, because a
caveat that is not written down becomes a bug report later.

- **`nextRun: null` for a spent or invalid task.** The frozen type says
  `nextRun?: string`, but a task that has fired (`once`) or failed validation has no
  next run, and `null` is what SQLite stores. The scheduler honours the runtime
  value through a narrow setter rather than reshaping the contract. Nothing that
  reads `nextRun` may assume it is a string when present.
- **Tool invocations publish no events.** The contract's `KaiEventType` has no
  `tool.*` members, so the tool registry accepts a `publish` option and does not
  use it yet — tool activity is observable through `mission.progress` and through
  approvals instead. Adding `tool.invoked`/`tool.completed` is an extension for when
  the UI needs to show tool activity directly.
- **`expireStale` publishes nothing**, for the same reason: there is no
  `approval.expired` event type, and inventing an off-contract event would be worse
  than the gap.
- **An approval is bound to the tool it was requested for.** An approval granted for
  tool A cannot authorise tool B, even with a valid id; the approval must also still
  be APPROVED and unexpired when it is redeemed.
- **A mission with zero steps settles COMPLETED immediately.** Checked by running it
  rather than by reading the code, because a mission left `RUNNING` forever would be
  re-examined at every startup as unfinished work.

## 4. Runtime facts (verified on this machine)

These are measured, not assumed. Re-verification commands are in the linked docs.

| Fact | Evidence |
|---|---|
| Hermes gateway api-server: `http://127.0.0.1:8642`; `GET /health` unauthenticated; `POST /v1/runs` → 202 `run_id`; `GET /v1/runs/{id}`; `/events` SSE; `POST /v1/runs/{id}/stop` | `docs/evidence/agent-interfaces-verified.md`; live run returning `KAI-CHAT-OK` |
| OpenCode 1.18.33: `http://127.0.0.1:4096`, no auth by default, OpenAPI at `/doc`; prompt route is `POST /session/{id}/message` (**not** `/prompt` — that answers `200 text/html` from the web UI and looks like success) | `docs/evidence/opencode-openapi.json`, `docs/evidence/agent-interfaces-verified.md` |
| `node:sqlite` is available in Node 26, so the Core needs **no** database dependency | probe recorded in this phase's work |
| The stored `hermes-api-key` is accepted by the gateway | `%LOCALAPPDATA%\KAI\kai.log`: `Hermes key accepted — 1 model(s), 3 session(s)` |
| Windows accessibility **Text size** multiplies WebView2's device scale factor (110% display + 130% text → `devicePixelRatio` 1.4354), which is what clipped the island | `docs/parity-audit.md` §5, `docs/evidence/dpi-check.ps1` |

## 5. Non-goals at this stage

Explicitly out of scope, per the phase plan, so nobody builds them by accident:
distributed components, microservices, a message broker, a cloud database, a
vector database, a plugin framework, and any autonomous-agent framework that would
hide task state, routing, policy or failures from KAI. Storage is SQLite, IPC is
loopback HTTP + WebSocket, and the orchestration is ours.

## See also

- `docs/architecture.md` — the desktop shell and how it is put together
- `docs/agents.md`, `docs/hermes.md`, `docs/opencode.md` — adapters
- `docs/missions.md`, `docs/testing.md` — planned/being built; kept honest
- `docs/parity-audit.md`, `docs/parity-fixes.md` — the verified shell baseline
- `docs/security.md` — secrets, policy and the tool-execution boundary
