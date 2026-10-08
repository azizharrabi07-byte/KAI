# KAI Session Architecture

KAI's conversation sessions — the durable thing a person means by "the chat". This
document describes the layer as built: what each module owns, the rules that must
not move, how a real user's old database migrates onto it, and which properties are
proven by which kind of control.

Source of truth is the code; this file explains WHY it is shaped the way it is.

---

## 1. The layer map

| Module | Owns | Notes |
| --- | --- | --- |
| `core/src/sessions/store.ts` | the SQLite file (`kai-sessions.db`), schema + migration, turn rows, escaped LIKE search, the active pointer | owns its own file rather than reshaping the frozen `Stores` aggregate |
| `core/src/sessions/service.ts` | the RULES: one ACTIVE session, errors as values, worker binding, mission binding, duplicate/close/clear/delete, resume, record view | every caller enforces the same rules because they all go through here |
| `core/src/sessions/router.ts` | WHICH transcript a read may see: `kai-conversation` vs `subagent-conversation` vs `worker-execution` | the anti-collapse guard — reads refuse cross-kind access |
| `core/src/sessions/tools.ts` | 5 tool definitions (`session.search/duplicate/close/clear/delete`) + idempotent `registerSessionTools` | never executes anything itself; the ONE registry is the boundary |
| `core/src/sessions/routes.ts` | `registerSessionRoutes(app, { runtime })`: wraps `coreApi.handle` in place + registers the tools | routes go through `runtime.tools.invoke`; there is no second policy path |
| `core/src/sessions/index.ts` | the public exports of all of the above | one import site for the runtime and tests |

## 2. The durable model

`sessions` rows carry: `id`, `title`, `status` (`ACTIVE` / `ARCHIVED`),
`createdAt`/`updatedAt`/`lastTurnAt`, `turnCount`, and the ownership/binding facts:

- **`agentId`** — LEGACY and overloaded: the worker id (`hermes`/`opencode`) for
  KAI's own conversations, OR the persona id (`kai:<id>`) for a persona's own
  session. Kept as a mirror because existing readers depend on it
  (`api/routes.ts` `personaSessionFor`, the chat relay).
- **`agentOwner`** — the persona that OWNS a session (`kai:<id>`), when one does.
- **`worker`** — the worker a session is bound to, once a turn ran.
- **`missionId`** — the mission a session is bound to.
- **`agentSessionId`** — the worker's OWN conversation id, so a later turn
  continues the same worker conversation after a restart.

The split of the overloaded `agentId` is computed in exactly ONE place —
`deriveOwnership()` in `store.ts` — and both writers (`create`/`update`) and the
migration backfill use it, so they cannot disagree about what `kai:x` means.

Exactly one session is ACTIVE; `service.active()` repairs a dangling pointer
rather than reporting it (a pointer at a missing/archived session is KAI's own
bug, not something a caller can act on).

### 2.1 The old-schema migration (the real user's first open)

Open order is `SCHEMA` (tables only) → `migrate(db)` → `SCHEMA_INDEXES`:

1. `SCHEMA` creates any missing tables.
2. `migrate()` adds the post-ship columns (`agentOwner`, `worker`, `missionId`)
   by `PRAGMA table_info` (no version counter — these files predate stamping),
   then backfills legacy `agentId` rows that have not been split yet.
3. `SCHEMA_INDEXES` creates the indexes — **after** the migration, because
   `idx_sessions_mission` references `missionId`, a column an old database only
   gains in step 2. Creating it first made every open of an old-schema database
   throw `no such column: missionId`.

Every step is idempotent; re-opening changes nothing a second time. This path is
pinned by a fixture in `core/tests/session-lifecycle.test.ts` (an old-schema file
is built by hand, opened, checked for the split backfill, re-opened).

### 2.2 `close` — one name, two overloads

`SessionService.close` is deliberately overloaded:

- `close()` — **store shutdown** (called by `runtime.ts` `stop()`).
- `close(id)` — **conversation close**: archive the session and move the active
  pointer off it (implemented internally as `closeSession`).

## 3. The transcript router (anti-collapse)

Three transcript kinds exist and must never collapse into one another:

| kind | subject | read rule |
| --- | --- | --- |
| `kai-conversation` | a session with NO `agentOwner` | default kind; refused (CROSS_KIND) for a persona-owned session |
| `subagent-conversation` | a session with `agentOwner = kai:<id>` | OWNER-CHECKED: the caller must name `owner` and it must match; mismatch → CROSS_KIND; omitted → VALIDATION_FAILED |
| `worker-execution` | the worker's own execution log | **NOT_WIRED** — no reader exists in this Core; refused for every subject rather than serving a borrowed or empty transcript |

Check order (documented, pinned by tests): shape validation → worker NOT_WIRED →
session NOT_FOUND → cross-kind/owner CROSS_KIND. Claiming an `owner` on a KAI
conversation is itself a CROSS_KIND. A closed conversation is still a record: its
transcript stays readable (status ARCHIVED).

`classifySession()` is the ONE classification; nothing re-derives it from
`agentId`.

## 4. The tools and the policy path

| tool | risk | effect |
| --- | --- | --- |
| `session.search` | READ | literal LIKE search over ids/titles/turn text |
| `session.duplicate` | WRITE | fork; the copy gets its OWN worker conversation |
| `session.close` | WRITE | close (archive) + move the active pointer |
| `session.clear` | DESTRUCTIVE | remove every recorded turn, reset counters |
| `session.delete` | DESTRUCTIVE | hard-delete the session and its turns |

There is NO policy logic in `sessions/tools.ts` or `sessions/routes.ts`. Every
mutation goes through `runtime.tools.invoke` — validate → policy → (approval) →
execute — the same boundary as every other action. Under the default policy the
four mutations are **parked for a human** (WRITE/DESTRUCTIVE tools not on KAI's
internal-state allowlist), and the caller:

- receives `409 { approvalRequired: true, approvalId }`;
- either decides the approval — the runtime's `decideApproval(id, true)`
  **auto-reissues** the exact parked call and it executes — or re-issues the
  SAME request with `approvalId` in the body.

A rejected verdict runs nothing and leaves state unchanged. A project can add a
policy rule to allow these tools directly (covered by a test with an allow-rule
runtime), in which case the route executes immediately and a service refusal
(e.g. unknown id) maps to its HTTP shape (`404`).

`registerSessionTools` is idempotent: `register()` throws on duplicate ids by
design, so each definition is guarded on `registry.get(id) === undefined` first.

### 4.1 Worker isolation

`duplicate` copies title/ownership/worker/mission and the recorded turns (fresh
turn ids) but **deliberately NOT `agentSessionId`**: copying it would make two
KAI sessions claim ONE worker conversation. The copy starts its own worker
conversation on its first turn. This is pinned by unit and route tests, and the
existing `app/tests/session-switch-link.test.ts` / `core/tests/session-switch.test.ts`
pin the sibling property (switch redraw; per-session worker codewords).

## 5. The route surface

| route | class | success | refusals |
| --- | --- | --- | --- |
| `GET /sessions/search?query=&limit=` | READ | `{ query, count, hits }` | 400 empty query |
| `GET /sessions/:id/view?limit=` | READ | `{ session: SessionView }` | 404 unknown |
| `GET /sessions/:id/transcript?kind=&owner=&limit=` | READ | `{ transcript }` | 404 / 403 CROSS_KIND / 400 / 501 NOT_WIRED |
| `POST /sessions/:id/duplicate` | WRITE | `201 { session, invocationId }` | 409 park / 403 / 404 / 400 |
| `POST /sessions/:id/close` | WRITE | `200 { session, invocationId }` | same |
| `POST /sessions/:id/clear` | DESTRUCTIVE | `200 { removed, session, invocationId }` | same |
| `POST /sessions/:id/delete` | DESTRUCTIVE | `200 { sessionId, invocationId }` | same |

Park/refusal mapping is the house mapping: `APPROVAL_REQUIRED → 409
{approvalRequired, approvalId}` (plus the full `ToolInvocation`), `POLICY_DENIED
→ 403`, `NOT_FOUND → 404`, `VALIDATION_FAILED → 400`. A present-but-wrong
`approvalId` is refused (400), never silently ignored.

`registerSessionRoutes` WRAPS `coreApi.handle` **in place**: its own routes are
answered by the wrapper, everything else falls through to the original handle
(captured before the swap — no recursion). This is safe because `server.ts`
calls `coreApi.handle(...)` by property access (`server.ts:799`); the wrapper is
marked so a second registration cannot double-wrap. It also registers the five
tools on `runtime.tools`, idempotently.

### 5.1 The integrator wiring line

Hand-over, applied by the integration stream (not by this stream):

```ts
if (coreApi !== null && core !== undefined) registerSessionRoutes(coreApi, { runtime: core });
```

after `server.ts:153` (`const coreApi = core === undefined ? null : createCoreApi(core);`).

## 6. What is proven, and how

| control | kind | pinned by |
| --- | --- | --- |
| old-schema open + backfill split + idempotent re-open + escaped LIKE on the migrated file | UNIT (real SQLite, real old file) | `session-lifecycle.test.ts` |
| `close(id)` vs `close()` overload dispatch | UNIT | `session-lifecycle.test.ts` |
| duplicate does not copy `agentSessionId` | UNIT + INTEGRATION (route) | `session-lifecycle.test.ts`, `session-routes.test.ts` |
| transcript kinds: cross-kind refusal, owner check, NOT_WIRED, NOT_FOUND | UNIT (router) + INTEGRATION (route statuses) | `session-router.test.ts`, `session-routes.test.ts` |
| reads through the wrapped handle; fallthrough to pre-existing routes | INTEGRATION (real runtime + real CoreApi) | `session-routes.test.ts` |
| park → `decideApproval(true)` auto-reissue executes; reject runs nothing | INTEGRATION (real registry + policy + approvals + parked store) | `session-routes.test.ts` |
| destructive clear/delete park under the default policy | INTEGRATION | `session-routes.test.ts` |
| idempotent registration (tools + wrap) | INTEGRATION | `session-routes.test.ts` |
| session-switch redraw (`paint()` + `State.subscribe`) | END-TO-END (app) | `app/tests/session-switch-link.test.ts` (existing, untouched) |
| per-session worker isolation over the real relay (codeword in B never in A) | END-TO-END (server relay + stub worker) | `core/tests/session-switch.test.ts` (existing, untouched) |

## 7. Not proven (honest list)

- **The wiring line itself is not applied in this stream.** `server.ts` is owned
  by the integration stream; until the one-line registration lands, the live
  `GET /sessions/search|view|transcript` and the four mutations answer 404 from
  a running Core. Everything above is proven against the same call the
  integrator will place.
- **`worker-execution` transcripts have no reader.** The router refuses
  (NOT_WIRED) by design; no test can prove content that does not exist.
- **No UI consumes the new routes yet** (`app/**` untouched): the app still uses
  the pre-existing `/sessions*` surface.
- **`SessionView` carries no `title`** (ids/bindings/status/history/memory
  scope); a caller wanting the title reads `GET /sessions/:id` (the raw record).
