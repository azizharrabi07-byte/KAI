# UI ↔ Core data flow

Phase 2.5 deliverable §2: what the UI reads today, from where, and what changes when
the Core becomes authoritative. Written by reading `app/src/**` and
`app/src-tauri/src/**` **before** editing anything.

## The two paths that exist today

```
                    ┌──────────────────────────────────────────┐
   Tauri events ────│ integrations.rs pollers (Hermes, OpenCode,│
   "integration"    │ n8n apps, Claude Code hooks, tray, cursor)│
                    └────────────────┬─────────────────────────┘
                                     │ Bridge.onEvent / onDragDrop
                                     ▼
   Tauri commands ──►  app/src/core/bridge.ts  ──►  app/src/core/state.ts (State)
   Bridge.chatSend    (the ONLY place the UI    │    tasks[], integrations{},
   Bridge.boot        calls into Rust; a no-op  │    settings, chat, approvals
   Bridge.secretPresent   in a plain browser)   │
                                                ▼
                                       app/src/views/*  +  island/island.ts
                                       (render on the animation frame)
```

Every read the UI does goes through one of three routes, and none of them is the Core:

| Data | Source | Consumer | Displayed in |
|---|---|---|---|
| Agent/session status | Rust `integrations.rs` poll → Tauri event `integration` | `island/integrations.ts` → `State.integrations[id]`, `State.updateTask` | `views/integrations.ts`, pills in `views.ts` |
| Hermes sessions | same poller (`integration_hermes` → `data.sessions`) | same | "Ask Claude"/session rows in the overview |
| OpenCode sessions/permissions | same poller | same | `views/integrations.ts` |
| Overview rows | `State.tasks` + `State.integrations` | `views/views.ts` | the overview card |
| Chat replies | `Bridge.chatSend` → Rust `claude.rs` (Hermes `/v1/runs`, then **Core `/chat`**, then Anthropic) | `views/chat.ts` | chat view |
| Notifications / badges | Claude Code hook relay → Tauri event `hook` | `State.pillBadge`, `State.noteMessage` | pills, note bubble |
| Approvals (Claude Code) | hook relay → event | `State.pendingApproval` → `Bridge.approvalDecision` | approval card |
| Settings | `Bridge.boot` (Rust) | `State.settings` | settings view |
| Connection state | `IntegrationInfo.error` / `.loaded` | `views/integrations.ts` | per-integration dot |
| Window/cursor/tray | Rust pollers + commands | `island/island.ts` | the island itself |

So today the UI's picture of "what is happening" comes from **Rust pollers**, and the
Core is used for exactly one thing: chat, by Rust.

## The seam nobody documented

`app/src-tauri/tauri.conf.json` sets a CSP with

```
connect-src 'self' ipc: http://ipc.localhost
```

`127.0.0.1:8788` is **not** in it, in either `csp` or `devCsp`. That is *why* chat goes
through Rust: a `fetch()` or `EventSource` from the island to the Core would be blocked
by the webview before it left. Any plan to let the UI read the Core directly is dead
until that entry is added — so it was added (both CSPs, plus the Core's own
`ALLOWED_ORIGINS` now lists `tauri.localhost`, which is the origin a *packaged* window
loads from; the Core previously allowed only the dev origins, so the API would have
worked in `tauri dev` and failed only in the installed app).

## The target

```
KAI UI ──┬── local UI actions (Tauri: window, tray, cursor, files, secrets)
         └── Core reads/writes ──► kai-core.ts (typed client) ──► 127.0.0.1:8788
                                          ▲
              /core/events (SSE) ─────────┘ core-events.ts → core-boot.ts → State
                                                                          │
                                                                          ▼
                                                                       views
```

One client, one event stream, one state slice. Views must not each subscribe to the
Core, and no view may call `fetch` itself.

## Authoritative-source decisions (spec §13, §23)

| Question | Authority | Why |
|---|---|---|
| Is an agent up, busy, idle? | **Core** | It owns the adapters and reports typed errors; Rust polling the same endpoints twice is the fragmented state §23 warns about |
| What is running? (missions, approvals, notifications) | **Core** | Rust has no concept of these |
| Which Hermes sessions exist? | **Core** (once its `/agents` and missions cover the overview) — until then Rust keeps providing session rows | The existing rows carry fields the Core does not expose yet; removing them before parity would be a regression |
| Which model answers chat? | **Core** | Already true: `claude.rs` tries the Core's `/chat` |
| Window geometry, tray, cursor, file drop, secrets | **Rust** | Not Core business, and secrets must never reach the front-end |

The rule for this phase: **add the Core path, keep the existing one until the Core
provably shows the same thing.** No read path is deleted in this phase.
