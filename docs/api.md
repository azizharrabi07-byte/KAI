# KAI Core API

Status: **IMPLEMENTED** — every endpoint below was exercised against the running
Core on this machine (`node dist/server.js`), not read off the source.

Binds `127.0.0.1` only. Everything is JSON except the event stream. The desktop app
is a **client** of this API: it does not own state, so closing or restarting the
island loses nothing.

```
UI (Tauri island)  →  KAI Core (127.0.0.1:8788)  →  agents / tools / storage
```

## Endpoints

| Method | Path | What it does |
|---|---|---|
| GET | `/health` | Aggregate of the two upstream agents (pre-existing route, unchanged) |
| GET | `/state` | The UI's status surface: uptime, database path, per-agent state **and health**, active missions, unread notifications, pending approvals, scheduled tasks, scheduler running, tool count |
| GET | `/agents` | Every agent with its status; an unreachable agent reports a typed detail instead of a crash |
| GET | `/agents/:id` | One agent's status, or 404 |
| POST | `/agents/:id/action` | Ask an agent to do something. 404 for an unknown agent; **409 if the agent does not declare `run_task`** — and it is not called anyway |
| GET | `/missions?status=&limit=` | List missions; an unknown `status` or a non-positive `limit` is a 400 naming the field |
| POST | `/missions` | Create and start a mission (`{title, description?, steps?}`) → 201 with the mission |
| GET | `/missions/:id` | One mission with its steps, or 404 |
| POST | `/missions/:id/cancel` | Cancel; 404 if unknown |
| GET | `/notifications?unreadOnly=&limit=` | List notifications |
| POST | `/notifications/:id/read` | Mark one read; 404 if unknown |
| GET | `/approvals?status=` | List approvals |
| POST | `/approvals/:id/decide` | `{approved: boolean}`; a missing or non-boolean value is a 400, an already-decided approval is a 409. Deciding also SETTLES the parked work: a mission step resumes, and a non-mission request is RE-ISSUED from the durable parked-request store — the response carries `reissued` and the re-issued action's `result` |
| GET | `/memory?type=&limit=` | List memories |
| POST | `/memory` | Store a memory (`{type, content, source?, importance?, metadata?}`) and publish `memory.created` |
| GET | `/sessions?status=&limit=&includeArchived=` | The live conversations, plus which one is active |
| POST | `/sessions` | Create a conversation (`{title?}`) → 201 |
| GET | `/sessions/active` | The conversation chat currently goes to, or null |
| GET | `/sessions/:id` | One conversation, or 404 |
| GET | `/sessions/:id/turns?limit=` | Its turns, oldest first |
| POST | `/sessions/:id/rename` | `{title}` |
| POST | `/sessions/:id/archive` \| `/unarchive` \| `/activate` | Archive, restore, or switch to it |
| GET | `/maintenance/status` | KAI's own health: build identity (the anti-stale check), database, sessions, acceptance ledger, workers, scheduler |
| POST | `/maintenance/run` | The same inspection, plus the four repairs KAI may perform on itself |
| GET | `/actions?limit=` | The persisted `action.executed` records: who acted, under which authority, in which build, and which artifact it produced (memoryId/skillId/…). Read-only |
| POST | `/prompts/compose` `{request, scope?}` | The EXACT system prompt a turn would send a worker (text, per-section report, total chars, problems). Read-only: composes, writes nothing, sends nothing |
| GET | `/core/events` | Server-sent events: one `data: <json>` frame per Core event, plus an opening comment frame |
| POST | `/chat` | **Pre-existing route**, now state-aware — see below |

A request for an unknown path is always JSON (`{"error":"not_found",...}`), never
HTML. A handler whose dependency throws becomes a 500 with a generic reason: the
thrown message is deliberately *not* echoed, because an `Error` string can carry
file paths or secrets.

## Chat: answered from state before any model is involved

`POST /chat` classifies the text first. If the intent is about KAI's own state, the
Core answers from live state and no model turn is spent:

```bash
curl -s -X POST 127.0.0.1:8788/chat -H 'content-type: application/json' \
  -d '{"text":"what is hermes doing?"}'
```
```json
{ "agent": "core", "from_state": true, "intent": "agent.status",
  "reply": "hermes is idle — no task right now.",
  "data": { "id": "hermes", "state": "idle", "lastActivity": "..." } }
```

Recognised intents: `status.summary`, `agent.status`, `agent.list`, `mission.list`,
`approval.list`, `notification.list`, `memory.list`, `memory.remember`,
`artifact.run_tests`. Anything unrecognised falls through to the pre-existing agent
path (Hermes, then OpenCode), so nothing that worked before stopped working.

Two honesty rules are enforced in that path:

- **No invented numbers.** Every figure in an answer is read from the injected
  runtime; the tests plant an unusual value in a stub and assert it is the one that
  appears.
- **`run the tests` does not run anything.** It says a test run needs the tool/policy
  path and that KAI has not executed it — the router is not a shell.

## Example: a mission that really runs

```bash
curl -s -X POST 127.0.0.1:8788/missions -H 'content-type: application/json' \
  -d '{"title":"read core status","steps":[{"title":"read","kind":"tool","target":"system.get_status"}]}'
```

Returns `status: "COMPLETED"` with the step's **real** output (`pid`, `node`,
`platform`, `cpus`, `uptimeMs`), because the step went through the tool registry —
validated, policy-checked, then executed. A step whose tool is `EXTERNAL` or
`DESTRUCTIVE` parks the mission in `WAITING_APPROVAL` and is **not** executed until a
human approves it.

## Configuration and secrets

| Setting | Source |
|---|---|
| Host/port | `KAI_CORE_HOST`, `KAI_CORE_PORT` (default `127.0.0.1:8788`) |
| Allowed origins | `KAI_CORE_ALLOWED_ORIGINS` (the Tauri dev origin is allowed by default) |
| Database | `KAI_CORE_DB`, else `%LOCALAPPDATA%\KAI\core\kai-core.db` |
| Hermes key | the caller (the app passes the key it holds in the Windows Credential Manager), else `KAI_HERMES_KEY` / `API_SERVER_KEY`, else the Hermes install's `~/.hermes/.env` |

The key is never written into this repository, never logged, and never returned in a
response body — it appears only in an `Authorization` header. If no key can be
found, the adapter reports `AGENT_AUTH_FAILED` and `/state` shows the agent as
errored rather than pretending it is reachable.

## Conversations (sessions)

`POST /chat` takes an optional `conversation_id` naming a KAI session; with none it
uses the ACTIVE session, creating one when there is none. Each turn (user and
assistant) is recorded against that conversation, and the worker's own conversation
id is bound to it — so a later turn continues the same worker conversation, and the
conversation survives a Core restart as ONE conversation. `session_id` keeps its
original meaning (the worker's conversation id) and is never repurposed.

## Autonomy and self-maintenance

A mission that settles `FAILED` is evaluated by the autonomous loop: a TRANSIENT
failure with budget left starts a new mission that supersedes the old one, and
anything else stops and tells the human. The bounds are visible, not hidden: the
attempt number and the reason live in the new mission's `metadata`
(`autonomyAttempt`, `supersedes`, `autonomyReason`). `POST /maintenance/run` is the
in-process repair surface; `GET /maintenance/status` only inspects.

## Still to do

- **Tool invocations publish no events** (no `tool.*` event types in the contract
  yet), so tool activity is visible through `mission.progress` and approvals.
- **Shell, Git and filesystem capabilities are registered but UNAVAILABLE**: the
  seam exists and honestly reports that no transport is implemented for them yet.
