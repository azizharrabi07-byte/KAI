# Agent interfaces — verified against the live installs

Everything here was produced by running real commands against the servers on this
machine. Confidence is stated per row: **VERIFIED** (ran it), **LIKELY** (source
read only), **ABSENT** (checked, not there).

Verification date: 2026-10-01. Host: Windows 11.

---

## 1. Hermes Agent

### 1.1 Gateway `api_server` — `http://127.0.0.1:8642` — THE automation API

Source of the route table: `gateway/platforms/api_server.py`
(`APIServerAdapter._http_route_table`), plus `api_server_runs.py`.

- Auth: `Authorization: Bearer <API_SERVER_KEY>`; the key is the 32-char value in
  the Hermes install's `.env`. **`GET /health` needs no key.**
- Profile multiplexing: a multi-profile gateway also serves every route under
  `/p/<profile>/…` (e.g. `/p/kai/v1/runs`).

| Method | Path | Purpose | Status |
|---|---|---|---|
| GET | `/health` | liveness, no auth | VERIFIED |
| GET | `/health/detailed` | readiness (state db, session store, model, disk, gateway, background queues) | VERIFIED |
| GET | `/v1/models` | model list | VERIFIED |
| GET | `/v1/capabilities` | feature flags (`run_submission`, `run_events_sse`, `run_stop`, `run_steer`, `run_approval_response`, `session_chat`) | VERIFIED |
| GET | `/v1/toolsets` | toolset list | VERIFIED |
| GET | `/api/model/options` | provider/model catalogue | VERIFIED |
| GET | `/api/sessions` | real sessions (`id`, `source`, `model`, `title`, `message_count`, tokens) | VERIFIED |
| POST | `/api/sessions` | create session | source |
| GET/PATCH/DELETE | `/api/sessions/{id}` · `/messages` · `/fork` · `/chat` · `/chat/stream` · `/model` | session surface | source |
| **POST** | **`/v1/runs`** | **submit a task — body `{"input": "<text>" \| [{role,content}], "model"?, "session_id"?, "provider"?}`** | **VERIFIED end-to-end** |
| GET | `/v1/runs/{run_id}` | run status + `output` + `usage` + `runtime` | VERIFIED |
| GET | `/v1/runs/{run_id}/events` | SSE: `message.delta`, `reasoning.available`, `run.completed` | VERIFIED |
| POST | `/v1/runs/{run_id}/stop` | cancel | VERIFIED |
| POST | `/v1/runs/{run_id}/steer` · `/approval` | course-correct / answer an approval | source |
| POST | `/v1/chat/completions` · `/v1/responses` | OpenAI-compatible shapes (GET → 405, verified) | source |
| GET/POST | `/api/jobs`, `/api/jobs/{id}` (+`/pause`, `/resume`, `/run`) | background jobs | source |
| POST | `/v1/artifacts/upload`, GET `/v1/artifacts/download/{id}` | artifacts | source |
| POST | `/v1/browser-control/register`, GET `/v1/browser-control/ws` | browser control, config-gated | source |

**The decisive test — a real LLM turn through this interface:**

```
POST http://127.0.0.1:8642/v1/runs   {"input": "Reply with exactly: KAI-LLM-PATH-OK"}
  -> 202 {"run_id": "run_b6215be3c1c646dc9a90d0f59f06f685", "status": "started"}
GET  /v1/runs/run_b6215be3c1c646dc9a90d0f59f06f685   (after 5 s)
  -> 200 {"status": "completed", "output": "KAI-LLM-PATH-OK", "last_event": "run.completed",
          "usage": {"input_tokens": 17437, "output_tokens": 10},
          "runtime": {"provider": "opencode-go", "model": "deepseek-v4.1-flash"}}
```

That is a real model response, from the provider the user already pays for, with no
Anthropic key and no extra provider account. **This is the working LLM path for KAI.**

### 1.2 Other Hermes surfaces

| Surface | Detail | Status |
|---|---|---|
| ACP server | `hermes acp` — JSON-RPC over **stdio** (`initialize`, `session/new`, `session/prompt`, `session/cancel`, `session/load`, `session/fork`, `session/set_model`, `fs/*`, `terminal/*`). Logs on stderr. | VERIFIED |
| MCP server | `hermes mcp serve` — stdio, 10 conversation tools (`conversations_list`, `messages_read`, `events_poll`, `events_wait`, `messages_send`, `permissions_respond`, …) | VERIFIED |
| One-shot CLI | `hermes -z "PROMPT"` (prints only the final text; `--usage-file`), `hermes chat -q "…"` | VERIFIED |
| Dashboard/desktop backend | `hermes serve` / `hermes dashboard` — FastAPI+uvicorn, default `127.0.0.1:9119`. Public: `/api/health`, `/api/status`, `/api/model/info`, `/api/config/*`. Everything else (e.g. `/api/sessions`, `/api/cron/jobs`) → **401** without a dashboard session. **Not listening on this host at verification time.** | VERIFIED (was up during recon, down now) |
| State store | `~/.hermes/state.db` (30 tables) + `~/.hermes/profiles/<p>/state.db`. For "what is Hermes doing right now?": `sessions.last_activity_description`, `tool_call_count`, `session_turn_leases` (live turn ownership), `gateway_heartbeats` (live backends + pid), `async_delegations`. Read-only access works. | VERIFIED |
| Cron | `<HERMES_HOME>/cron/jobs.json` + `executions.db` + `ticker_heartbeat`; CLI `hermes cron list/create/run/status/runs`; REST `/api/jobs*` | VERIFIED |
| Local control socket | Windows named pipe `\\.\pipe\hermes-gateway-<sha256(home)[:16]>`, one JSON line per connection, verbs `identify` / `status` | VERIFIED (source) |

## 2. OpenCode

`opencode --version` → **1.18.33**.

| Capability | Mechanism | Status |
|---|---|---|
| Server | `opencode serve --hostname 127.0.0.1 --port 4096` — **default port is `0`/random**, so it must be pinned | VERIFIED |
| Auth | **None by default** (`Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.`); optional HTTP basic via `OPENCODE_SERVER_PASSWORD` + `OPENCODE_SERVER_USERNAME` | VERIFIED |
| API spec | `GET /doc` → OpenAPI 3.1, title `opencode`, **162 paths** (copy saved at `docs/evidence/opencode-openapi.json`) | VERIFIED |
| Health | `GET /global/health` → `{"healthy":true,"version":"1.18.33"}`, `GET /api/health`, `GET /session/status` | VERIFIED |
| Sessions | `GET/POST /session`, `GET/PATCH/DELETE /session/{id}` | VERIFIED |
| Send a prompt | `POST /session/{id}/message` (sync) or `POST /session/{id}/prompt_async` (async) | VERIFIED (spec + live) |
| Read output | `GET /event` and `/global/event` SSE; `GET /session/{id}/message` transcript | VERIFIED |
| Cancel | `POST /session/{id}/abort`; `POST /session/{id}/interrupt` | source |
| Permissions | `POST /session/{id}/permissions/{permissionID}` body `{"response":"once"\|"always"\|"reject"}` | source |
| Headless one-shot | `opencode run "msg" --format json`, `-m provider/model`, `--agent`, `--session`, `--attach <url>` | VERIFIED |
| ACP | `opencode acp` — same Agent Client Protocol as Hermes ACP | VERIFIED |

> **Route trap.** `POST /session/{id}/prompt` does **not** exist in 1.18.33: it falls
> through to the web-UI SPA catch-all and answers `200 text/html`, which looks like
> success. The real routes are `/message` and `/prompt_async`.

### 2.1 `opencode-gateway` — `C:\Users\DELL\opencode-gateway`

A Node/Fastify service (`@opencode-ai/sdk ^1.18.30`, `fastify ^5`) on
`127.0.0.1:8000`: `GET /health`, `GET /v1/models`, `POST /v1/chat/completions`
(OpenAI-shaped, `stream: true|false`), auth `Authorization: Bearer <GATEWAY_API_KEY>`.
It spawns `opencode serve` through the SDK and creates a fresh session per request.
**Not listening on this host at verification time**; usable as a second LLM path if
started.

## 3. Capability matrix — what KAI can actually do

| Need | Hermes | OpenCode |
|---|---|---|
| health/status | YES — `GET :8642/health` (no key); `/v1/capabilities`; SQLite + `gateway_state.json` for detail | YES — `GET /global/health`, `/session/status` |
| submit a task | YES — `POST :8642/v1/runs` → `run_id` | YES — `POST /session/{id}/message` |
| receive output/events | YES — `GET /v1/runs/{id}` poll, or `/events` SSE | YES — `GET /event` SSE, or read the transcript |
| cancel | YES — `POST /v1/runs/{id}/stop` | YES — `POST /session/{id}/abort` |
| one shared protocol | ACP (stdio) — **OpenCode speaks the same ACP**, so one client can drive both | ACP (stdio) |

## 4. Consequences for KAI

1. **Chat/LLM**: route through `POST :8642/v1/runs` with the `hermes-api-key` secret
   KAI already has a slot for. Verified working; needs no Anthropic account. Stream
   with `/v1/runs/{id}/events` for live output.
2. **"What is Hermes doing?"**: prefer `GET /v1/runs/{id}` + `GET /api/sessions`
   (Bearer), or read `last_activity_description` / `session_turn_leases` read-only
   from `state.db`. Do not invent a status field.
3. **Do not add extra servers to make integrations look complete.** KAI already
   probes 8642 and 4096 correctly; 9119 and 8000 are optional and currently down —
   the UI must keep saying so honestly.
