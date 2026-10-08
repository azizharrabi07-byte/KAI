# KAI Core

`@kai/core` — the KAI control-plane service. It sits between the KAI desktop app (Tauri,
dev origin `http://localhost:1420`) and the AI agents already installed on this machine.
It is a small Node/TypeScript ESM service with **zero runtime dependencies** (Node built-ins,
global `fetch`, `node:http` only) that speaks to exactly two upstreams:

| Upstream | Default base URL | Status transport |
| --- | --- | --- |
| Hermes Agent `api-server` | `http://127.0.0.1:8642` | Bearer (`Authorization: Bearer <API_SERVER_KEY>`) |
| OpenCode headless server (CLI v1.18.33) | `http://127.0.0.1:4096` | none by default; HTTP Basic when `OPENCODE_SERVER_PASSWORD` is set |

Nothing in this service talks to anything else. Every upstream route it calls was read from
the installed source / live OpenAPI document and exercised against the running servers; see
`evidence/` for the raw output.

## Run it

```bash
cd core
npm install          # 3 packages, 0 vulnerabilities
npm run build        # tsc, strict, ESM -> dist/
npm test             # builds, then runs the live integration tests
npm start            # binds 127.0.0.1:8788 ONLY
```

`npm start` needs the Hermes key in the environment. It is read, never logged:

```bash
export KAI_HERMES_KEY=$(grep -m1 '^API_SERVER_KEY=' ~/.hermes/.env | cut -d= -f2-)
npm start
curl -s http://127.0.0.1:8788/health
```

`npm test` runs 31 tests against the **live** Hermes and OpenCode servers on this machine, so
both must be running (they are started independently of KAI Core). Two of them are real model
turns through `POST /chat` — that is deliberate: they are the only thing that would have caught
the two Hermes-client bugs they did catch (the session row lives under `session`, and a fixed
session title is refused as a duplicate).
On this host `node --test dist` treats `dist` as a file, so the script uses the glob form
`node --test "dist/**/*.test.js"`.

### Configuration (all optional; see `src/config.ts`)

| Env var | Default | Meaning |
| --- | --- | --- |
| `KAI_HERMES_URL` | `http://127.0.0.1:8642` | Hermes api-server base URL |
| `KAI_HERMES_KEY` (fallback `API_SERVER_KEY`) | — | Bearer key. **Never logged, never written to disk.** |
| `KAI_HERMES_TIMEOUT_MS` | `10000` | Per-request timeout |
| `KAI_OPENCODE_URL` | `http://127.0.0.1:4096` | OpenCode server base URL |
| `OPENCODE_SERVER_PASSWORD` | — | Optional HTTP Basic password |
| `KAI_OPENCODE_TIMEOUT_MS` | `10000` | Per-request timeout |
| `KAI_CORE_HOST` / `KAI_CORE_PORT` | `127.0.0.1` / `8788` | KAI Core listen address |
| `KAI_CORE_ALLOWED_ORIGINS` | `http://localhost:1420,http://127.0.0.1:1420` | Exact CORS allow-list |

## KAI Core's own surface (what the desktop app calls)

| Method | Path |
| --- | --- |
| GET | `/health` — aggregate: kai core ok, hermes `{reachable, authorized, version}`, opencode `{reachable, version}` |
| GET | `/integrations` — identical aggregate |
| GET | `/agents/hermes/sessions` |
| GET | `/agents/hermes/sessions/:id/messages` |
| GET | `/agents/opencode/sessions` |
| GET | `/agents/opencode/sessions/:id/messages` |
| GET | `/agents/opencode/permissions` |
| POST | `/agents/opencode/permissions/:id/reply` — body `{"reply":"once"\|"always"\|"reject","message"?}` |
| GET | `/agents/opencode/questions` |
| POST | `/agents/opencode/questions/:id/reply` — body `{"answers": string[] \| string[][]}` |
| POST | `/chat` (alias `/agents/hermes/chat`) — **the chat relay the app uses**: body `{"text": "…", "session_id"?}` → `{"agent":"hermes","session_id":"…","reply":"…","usage":{…}}`. Creates a Hermes session on the first turn and reuses it afterwards. |
| POST | `/agents/opencode/chat` — the same shape over OpenCode's `POST /session/{id}/message`; relays the server's own error when no provider answers. |
| GET | `/events` — SSE (`opencode.*` relayed events + periodic `hermes.status`) |

Every response is JSON except `/events`; unknown route → `404` JSON; a path that exists with the
wrong method → `405` JSON; an upstream failure → `502` JSON carrying a `reason` code
(`upstream_unreachable`, `upstream_unauthorized`, `upstream_http_<status>`) and never a stack
trace. CORS allows **only** the two Tauri dev origins; any other `Origin` gets `403
{"error":"forbidden","reason":"origin_not_allowed"}`.

## Verified upstream interfaces

Both lists below were verified **live on 2026-10-01** from this machine. Where the OpenCode
OpenAPI document is quoted, the saved copy is `kai/docs/evidence/opencode-openapi.json`
(OpenAPI 3.1.0, title `opencode`, version `1.0.0`, 162 paths), also served live at `GET /doc`.

### Hermes Agent api-server — `http://127.0.0.1:8642`

Route table read from the installed source
(`…/gateway/platforms/api_server.py`, `_http_route_table`). Routes KAI Core actually calls:

| Method | Path | Auth | Verified response |
| --- | --- | --- | --- |
| GET | `/health` | none | `{"status":"ok","platform":"hermes-agent","version":"unknown"}` |
| GET | `/v1/models` | Bearer | `{"object":"list","data":[{"id":"hermes-agent",…}]}` |
| GET | `/v1/models` (wrong/no key) | — | HTTP 401 `{"error":{"type":"gateway_auth_error","code":"gateway_auth_failed",…}}` |
| GET | `/v1/capabilities` | Bearer | object with `platform:"hermes-agent"` |
| GET | `/api/sessions` | Bearer | `{"object":"list","data":[{id,source,user_id,model,title,message_count,…}]}` |
| GET | `/api/sessions/{session_id}` | Bearer | session object |
| GET | `/api/sessions/{session_id}/messages` | Bearer | message list |
| POST | `/api/sessions` | Bearer | body `{}`, or `{"title":…,"id":…}`; an id with `/` → HTTP 400 `invalid_session_id` |
| POST | `/api/sessions/{session_id}/chat` | Bearer | body `{"message":"…"}`; unknown session → HTTP 404 |

Also present in the same verified table but **not used by KAI Core**: `/health/detailed`,
`/v1/health`, `/api/model/options`, `/v1/skills`, `/v1/toolsets`, `PATCH|DELETE /api/sessions/{id}`,
`POST /api/sessions/{id}/fork`, `/chat/stream`, `/model`, `/v1/chat/completions`, `/v1/responses`
(+get/delete), the `/api/jobs` family, `/v1/runs` and its sub-routes,
`/v1/browser-control/{ws,register}`, `/v1/artifacts/{upload,download}`. Each is also mirrored
under `/p/{profile}<path>` when the gateway multiplexes profiles.

### OpenCode headless server — `http://127.0.0.1:4096` (v1.18.33)

| Method | Path | Verified |
| --- | --- | --- |
| GET | `/global/health` | `{"healthy":true,"version":"1.18.33"}` |
| GET | `/session` | array; each entry `{id:"ses_…",slug,projectID,directory,title,agent,model,version,time,cost,tokens}` |
| POST | `/session` | spec body `{parentID?,title?,agent?,model?,metadata?,permission?,workspaceID?}` |
| GET | `/session/{sessionID}/message` | transcript; unknown id → HTTP 404 `{"name":"NotFoundError"}` |
| POST | `/session/{sessionID}/message` | **the prompt route** (spec `operationId: session.prompt`), body `{"parts":[{"type":"text","text":"…"}]}` |
| GET | `/permission` | `[]` (live) |
| POST | `/permission/{requestID}/reply` | body `{"reply": "once"\|"always"\|"reject"}` (enum taken verbatim from the spec) |
| GET | `/question` | `[]` (live) |
| POST | `/question/{requestID}/reply` | body `{"answers": string[][]}` (`QuestionAnswer` = `string[]`) |
| GET | `/event` | `text/event-stream`; first frame `data: {"id":"evt_…","type":"server.connected","properties":{}}` |

### One documented deviation from the brief

The task brief listed `POST /session/{sessionID}/prompt` as the OpenCode prompt route. **That
route does not exist in OpenCode 1.18.33.** Posting to it returns HTTP **200 with `text/html`** —
it is the web UI's SPA catch-all, not the API. The real prompt route, per the server's own
OpenAPI document and confirmed live, is `POST /session/{sessionID}/message`
(`operationId: session.prompt`), which answers a genuine
`404 {"name":"NotFoundError","data":{"message":"Session not found: …"}}` for an unknown session.
`OpenCodeClient.prompt()` therefore posts to `/session/{sessionID}/message`. The behaviour of
both paths is asserted in `src/agents/opencode.test.ts` so the discrepancy stays visible.

## What is NOT integrated

- **No Hermes global event stream.** The verified Hermes route table has no `/events` feed — only
  the per-turn `POST /api/sessions/{id}/chat/stream` SSE endpoint. KAI Core's `GET /events`
  therefore relays OpenCode's real `/event` stream and emits a periodic `hermes.status` snapshot
  (from the verified `GET /health` + `GET /v1/models` probe) rather than pretending a Hermes feed
  exists. `hermes.status` is a KAI Core construct, not a Hermes event.
- **No chat turn is ever executed by KAI Core.** `HermesClient.sendChat()` and
  `OpenCodeClient.prompt()` are implemented but the tests exercise them only against unknown
  session ids, to prove the routes exist without mutating live agent state. There is no KAI Core
  route that starts an agent turn — a chat/inference passthrough is not part of this service.
- **No streaming of a chat turn** (`/chat/stream`, `/session/{id}/event`) — deliberately left out.
- **`replyPermission` / `replyQuestion` are wired but never fired in tests.** There were no pending
  requests on this machine (`GET /permission` and `GET /question` both returned `[]`), so the
  *reply* paths are verified only up to request-shape/validation, not against a live request id.
- **No process supervision.** KAI Core does not start, stop, or health-check-restart the Hermes or
  OpenCode servers; both must already be running `opencode serve --port 4096 --hostname 127.0.0.1`.
  It reports reachability; it does not achieve it.
- **No persistence, auth, or multi-user layer** of its own: no database, no API key on KAI Core's
  own surface (it is bound to 127.0.0.1), no session store.
- **No Tauri app changes.** `kai/app/` is owned by another worker; KAI Core only reads the dev
  origin from `app/vite.config.ts` to build its CORS allow-list.
- **Hermes reports `"version":"unknown"`**, which KAI Core passes through verbatim — the upstream
  value is not known on this machine, so no version string is invented for it.

## Layout

```
core/
  package.json  tsconfig.json  .gitignore  README.md
  src/config.ts          env vars + defaults, redactedConfig() for safe logging
  src/errors.ts          AgentError {unreachable | unauthorized | http} + reasonOf()
  src/lib/sse.ts         SSE frame parser
  src/agents/hermes.ts   HermesClient   (+ hermes.test.ts)
  src/agents/opencode.ts OpenCodeClient (+ opencode.test.ts)
  src/server.ts          node:http server, CORS, SSE fan-in (+ server.test.ts)
  evidence/              real command output: install, tsc, tests, live curl, inventory
```

MIT licensed.
