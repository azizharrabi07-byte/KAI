# KAI — integrations

Everything below was verified against the servers actually running on this machine. Nothing here is
copied from a README or guessed from a name.

Verification date: **2026-10-01** (UTC). Verification method: live HTTP requests plus reading the
installed server source / published OpenAPI document, on this host.

---

## 1. Hermes Agent api-server

- Base URL: `http://127.0.0.1:8642`
- Live: yes. `Server: Python/3.14 aiohttp/3.14.3`.
- Auth: `Authorization: Bearer <API_SERVER_KEY>`, **except** `GET /health`.
- Route table read from the installed source,
  `gateway/platforms/api_server.py`, method `APIServerAdapter._http_route_table`.

| Method | Path | Auth | Status |
|---|---|---|---|
| GET | `/health` | none | **verified live** — `{"status":"ok","platform":"hermes-agent","version":"unknown"}` |
| GET | `/health/detailed` | Bearer | present; 401 without a key (verified) |
| GET | `/v1/health` | Bearer | present |
| GET | `/v1/models` | Bearer | **verified live** — `{"object":"list","data":[{"id":"hermes-agent",…}]}` |
| GET | `/api/model/options` | Bearer | present |
| GET | `/v1/capabilities` | Bearer | present; 401 without a key (verified) |
| GET | `/v1/skills` | Bearer | present |
| GET | `/v1/toolsets` | Bearer | present |
| GET | `/api/sessions` | Bearer | **verified live** — real sessions with `id`, `source`, `model`, `title`, `message_count`, `input_tokens`, … |
| POST | `/api/sessions` | Bearer | present |
| GET/PATCH/DELETE | `/api/sessions/{session_id}` | Bearer | present |
| GET | `/api/sessions/{session_id}/messages` | Bearer | present |
| POST | `/api/sessions/{session_id}/fork` | Bearer | present |
| POST | `/api/sessions/{session_id}/chat` | Bearer | present |
| POST | `/api/sessions/{session_id}/chat/stream` | Bearer | present (SSE) |
| POST | `/api/sessions/{session_id}/model` | Bearer | present |
| POST | `/v1/chat/completions` | Bearer | present (`405` on GET, verified) |
| POST | `/v1/responses` | Bearer | present |
| GET/DELETE | `/v1/responses/{response_id}` | Bearer | present |
| GET/POST | `/api/jobs`, `/api/jobs/{job_id}` (+`/pause`, `/resume`, `/run`) | Bearer | present |
| POST | `/v1/runs` (+ sub-routes from `api_server_runs.py`) | Bearer | present |
| POST | `/v1/artifacts/upload`, GET `/v1/artifacts/download/{id}` | Bearer | present |
| POST | `/v1/browser-control/register`, GET `/v1/browser-control/ws` | Bearer | present, gated on config |

**Profile mirrors.** When the gateway multiplexes profiles, *every* route above is also served under
`/p/{profile}<path>` (e.g. `/p/kai/v1/models`). Registered by the same loop in `connect()`.

**What KAI uses today:** `GET /health` (always), and `GET /v1/models` + `GET /api/sessions` only when
the user has stored the key — for the island card. Chat turns go through **KAI Core**, which holds the
bearer key server-side and calls `POST /api/sessions` + `POST /api/sessions/{id}/chat`; that is the one
place KAI drives the agent rather than reporting on it. See §2b.

### Key handling

The key is the `API_SERVER_KEY` value in the Hermes install's `.env`. KAI never reads that file; the
user pastes the key into KAI's settings and it goes to the Windows Credential Manager as
`hermes-api-key` under the target `com.aziz.kai`. Without it, KAI still reports Hermes as reachable
through the unauthenticated `/health` route.

---

## 2. OpenCode headless server

- Base URL: `http://127.0.0.1:4096`
- Version: **1.18.33** (reported by its own `/global/health`).
- Auth: none by default. The server logs
  `Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.` If that env var is set, it
  expects HTTP Basic auth.
- Start: `opencode serve --port 4096 --hostname 127.0.0.1` (default port is `0`/random, so the port
  must be given).
- Its **complete** API is published by the server itself at `GET /doc` as an OpenAPI 3.1.0 document
  (title `opencode`, version `1.0.0`, **162 paths**). A copy is saved at
  `docs/evidence/opencode-openapi.json`. Read it before writing any client code.

Routes KAI uses:

| Method | Path | Status |
|---|---|---|
| GET | `/global/health` | **verified live** — `{"healthy":true,"version":"1.18.33"}` |
| GET | `/api/health` | **verified live** — `{"healthy":true}` |
| GET | `/session` | **verified live** — a real session array (56 KB of sessions on this host) |
| GET | `/permission` | **verified live** — `[]` (valid empty array; no pending requests on this host) |
| GET | `/question` | **verified live** — `[]` |
| POST | `/permission/{requestID}/reply` | in the published spec; **not yet exercised** (see below) |

Other routes present in the spec that a fuller integration would use: `POST /session`,
`DELETE /session/{id}`, `POST /session/{id}/message` (the real prompt route),
`POST /session/{id}/abort`, `GET /session/{id}/message`, `GET /session/{id}/todo|diff|children`,
`GET /event` (SSE), `POST /question/{id}/reply|reject`, `GET /agent|provider|config|skill|mcp`,
`POST /sync/*`, `/pty/*`, `/tui/*`, `/experimental/*`.

> **Route-name correction.** OpenCode 1.18.33 has **no** `POST /session/{sessionID}/prompt`. That
> path falls through to the web-UI SPA catch-all and answers `200 text/html`, which is easy to
> mistake for success. The real prompt route is `POST /session/{sessionID}/message`
> (`operationId: session.prompt`). This was found by testing, not by reading.

### Honest status of the reply path

`POST /permission/{requestID}/reply` exists in the server's own published spec and KAI implements it
(in `integrations::reply_permission`, surfaced as the `opencode_reply_permission` Tauri command and
the Allow/Reject buttons on the OpenCode card).

**It has still not been exercised against a live request, and here is exactly why.** `GET /permission`
has never returned anything but `[]` on this machine, for two independent reasons, both measured on
2026-10-01:

1. **Nothing can ask.** A permission request is raised by a tool call, and a tool call needs a model.
   Of the 38 providers configured in this OpenCode install, 20 named provider/model pairs were tried
   through OpenCode's own API and **none answered** — the failures are the providers' own words
   (`Insufficient balance`, `Plan expired`, `Payment Required: No active plan`, `unauthorized`,
   `token expired or incorrect`, …) and are recorded in full in
   `docs/evidence/provider-probe.txt`. No provider, no tool call, no request.
2. **The server's own ask route auto-resolves.** `POST /api/session/{sessionID}/permission`
   ("Create permission request") was called with `{"action":"bash","resources":[…]}` and answered
   `{"data":{"id":"per_…","effect":"allow"}}` — the request is resolved the moment it is created,
   because this configuration has no `ask` rule for `bash` and the default is allow. Making it ask
   means `PATCH /config`, which rewrites the user's own OpenCode configuration and cannot be
   restored byte-for-byte; that was not done.

What **is** proven, end to end and with the real binaries, is KAI's own approval loop — Claude Code
hook → pipe → island card → Allow → decision returned to the hook:

```
hook PermissionRequest id=10520-1
ui  decide allow req=10520-1
decision id=10520-1 allow
hook id=10520-1 answered allow
```

with kai-hook's stdout being the exact JSON Claude Code expects
(`{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}`).
That is `docs/evidence/kai-approval-roundtrip.txt` and `docs/evidence/approval-response.txt`.

The OpenCode reply route is reachable through the whole stack, including KAI Core: answering an
unknown id through `POST /agents/opencode/permissions/per_unknown/reply` returns the server's own
`404 upstream_http_404`, which is the route doing its job with nothing pending.

---

## 2b. KAI Core — the chat relay

`core/` is a small Node/TypeScript service on `127.0.0.1:8788`. The app's chat calls it, and it calls
Hermes:

| Method | Path | Verified |
|---|---|---|
| GET | `/health`, `/integrations` | **verified live** — aggregated status of both agent servers |
| POST | `/chat`, `/agents/hermes/chat` | **verified live** — a real model turn; body `{text, session_id?}` → `{agent, session_id, reply, usage}` |
| POST | `/agents/opencode/chat` | route implemented against `POST /session/{id}/message`; answers `{"reply":""}` plus the server's own error object while no provider works |
| GET | `/agents/hermes/sessions`, `/agents/opencode/sessions`, `/agents/opencode/permissions`, `/agents/opencode/questions` | **verified live** |
| POST | `/agents/opencode/permissions/{id}/reply`, `/agents/opencode/questions/{id}/reply` | route validated; not exercised against a live request (see above) |
| GET | `/events` | **verified live** — SSE fan-in: OpenCode's `/event` relayed verbatim, plus a periodic `hermes.status` snapshot |

`POST /chat` was verified with a real turn (`reply: "KAI-CORE-LIVE-OK"`, provider `opencode-go`,
model `deepseek-v4.1-flash`) and with a second turn on the same `session_id` that correctly repeated
the first turn's token — see `docs/evidence/core-live-routes.txt`.

Two things only a live request could have found, both now fixed and covered by the test suite:

* Hermes answers `POST /api/sessions` with the row under **`session`**, not `data` and not at the top
  level. The client read the wrong key, so the session id came back empty.
* Hermes refuses a duplicate session title (`400 invalid_title`), so a fixed title works exactly once.

---

## 3. Third-party integrations (inherited, not KAI's control layer)

The app also carries the original generic HTTP pollers — Stripe, GitHub, Vercel, n8n, Resend, Notion,
Cal.com — plus the VS Code / Claude Code hook status. They are unchanged in behaviour: each one stays
idle until its key exists in the Credential Manager, and none of them talks to anything the user has
not configured. They are unrelated to the control layer and can be switched off in settings.

## 4. Not integrated

- **Hermes dashboard (port 9119)** — not listening on this host. KAI does not link to it.
- **Starting/stopping the agent servers.** KAI probes them; it never launches them. The same goes for
  KAI Core: the app uses it when it is there and falls back when it is not, but it will not start it.
- **OpenCode `GET /event` streaming.** Verified to work (first event `server.connected`), but the
  island polls instead of streaming. Polling was chosen because it degrades gracefully when the
  server is absent. (KAI Core *does* stream it, for its own `/events` route.)
- **`PATCH /config` on the OpenCode server.** Deliberately not used: it rewrites the user's own
  OpenCode configuration, and there is no way to restore it byte-for-byte.
