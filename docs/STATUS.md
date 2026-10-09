# KAI Status

Current, honest status of the KAI source tree. Everything here was produced by running the
commands shown; nothing is claimed from reading code.

- **Commit:** `2d2f4b9` ("per-item retry ceiling from a durable dispatch ledger")
  — the newest **code** commit. A docs-only follow-up (this file, the supervisor
  contract, the refreshed probe evidence) changes no source, so `2d2f4b9` is the
  exact tree the suites, probes and counts below were run against.
- **Date:** 2026-10-09
- **State:** experimental, single-machine, actively developed. Not a released product.

## What changed since the last status

The supervisor trust repair (started in a previous session) was finished and verified:

- **Claims are not proof.** The Outcome Gate is the single completion authority, and a
  requirement is satisfied only by a KAI-observed evidence record whose `supports[]`
  names the required label **exactly**. The substring/token matching is gone. A
  reviewer PASS may compensate a criterion only where nothing could be observed, and
  that compensation is recorded.
- **Corrective actions execute.** A failed gate now runs a bounded evidence round
  (`INSPECT`/`VERIFY`/`RUN_TESTS` through KAI's own tool registry), a depth-capped
  corrective child (`RETRY`/`REPLAN`/`CHANGE_WORKER`), or parks visibly
  (`ASK_USER`) — never a silent `CHANGES_REQUESTED` stall.
- **Truthful dispatch.** `POST /work-items` plans (`work.planned`; 201 means a durable
  item was created); `delegated` flips only when a worker is really dispatched.
- **Retry ceiling is now per ITEM, from a durable dispatch ledger.** One attempt per
  worker dispatch, classified `initial` / `retry` (same worker, ≤ `maxRetries`) /
  `reassign` (different worker, ≤ `maxReassignments`). A caller can no longer buy
  extra attempts by rotating workers, while the breaker's sanctioned worker switch
  still works. Exhaustion parks the item `BLOCKED` with a durable next action.
- **Approvals are final** (approved / rejected / expired cannot be re-spent) and
  duplicate deliveries are no-ops.
- **`/audit` and `/summary`** are real commands in the production command path, plus a
  durable once-per-local-day summary offer on the one scheduler.
- **Handoff persistence fix:** the parsed worker handoff is stored before review, so a
  run that parks (review or a guarded evidence check) is resumable.
- **`board.annotate` now merges** (it documents itself as additive but used to replace
  `outputs`), so parking a run no longer drops the persisted Outcome Contract, the
  resume keys or the dispatch ledger.
- See `docs/architecture/KAI_SUPERVISOR_TRUST.md` for the full contract.

## Test status

### KAI Core (`core/`)

```
cd core && npm test
```

| | |
|---|---|
| tests | 1194 |
| pass | 1181 |
| fail | 0 |
| skipped | 13 |

**0 failures.** The one long-standing failure (`core/src/server.test.ts:249`, "POST /chat
runs a real turn through Hermes") was an external Hermes misconfiguration, not a KAI
defect, and it is **fixed and verified** — see the diagnosis below. It is now passing
against the live worker, not skipped and not relabelled.

New suites added by this work (all passing): `orch-supervisor-trust` (**39 tests** — the
17-case suite, 9 retry-policy cases, offline-worker, supervisor-failure and redaction
cases), `summary-daily` (11), `summary-audit-commands` (7), plus a LIVE HTTP-boundary
retry-ceiling case in `orch-commands` and the rewritten `orch-orchestrator` budget case.
The 13 skips are live-integration checks that need both agents or OpenCode (which is
offline on this machine); each names its reason.

## Hermes diagnosis and fix (2026-10-09) — resolved

Two checks were failing for one cause: `worker-honesty` H3 (`AGENT_TIMEOUT`) and the
Hermes relay test (120 s chat timeout). Direct, bounded probes against
`http://127.0.0.1:8642` established that **Hermes' control plane was healthy but every
model turn failed**:

| Probe (before the fix) | Result |
|---|---|
| `GET /health` | 200 in 16 ms — `{"status":"ok","platform":"hermes-agent"}` |
| `GET /v1/models` (test-runner key) | 200 in 35 ms — authorized |
| `POST /api/sessions` | 201 in 17 ms — a session is created |
| `POST /api/sessions/:id/chat` | **never answered** — client timeout at 30,010 ms (KAI's configured budget is 120 s, which is exactly what the relay test hit) |
| `POST /v1/runs` | **accepted** (a `run_id` came back) but never finished inside KAI's 15-minute run deadline; H3 recorded `17:33:10.061Z → 17:48:10.468Z` = 900.4 s |

**Root cause, isolated to the model credentials Hermes used:**

1. The `opencode-go` key configured in `~/.hermes` (len 51) was **stale**: the endpoint
   answered `429 GoUsageLimitError: Go usage limit exceeded` (workspace `wrk_01M298…`,
   `limitName: monthly`).
2. The session's fresh `OPENCODE_GO_API_KEY` is rejected too — `403 "An active OpenCode
   Go subscription is required to use Go models"`.
3. The session's `OPENCODE_API_KEY` **works** — but only with the routing header the
   endpoint now requires: without `x-opencode-session` it answers
   `400 MissingSessionID` (3/3), and with it `200 content="PONG"` (962 ms).

**Fix applied — to Hermes only, nothing in KAI:** the working key was written into
`~/.hermes/config.yaml` (`providers.opencode-go.api_key` and `model.api_key`), into
`~/.hermes/.env` (`OPENCODE_GO_API_KEY`), and `x-opencode-session` was added to the
provider's `extra_headers` (the existing `User-Agent` was preserved). One further
environment fix was needed to bring the gateway up at all: the `automate-man` **profile**
had `platforms.discord.enabled: true`, and its Discord adapter (privileged intents not
enabled in the developer portal) raised an unhandled `PrivilegedIntentsRequired` that
killed the whole gateway process; it was set to `false`. Both edits have timestamped
backups next to the originals, and the gateway was restarted as a detached process
(WMI-created, so it outlives the session). The live KAI Core on `127.0.0.1:8788` was not
touched.

**Verified after the fix:**

| Check | Result |
|---|---|
| `POST /api/sessions/:id/chat` (direct) | **200 `content="PONG"` in 6.3 s** |
| `core/src/server.test.ts` test 3 (`GET /agents/hermes/sessions`) | **pass** |
| `core/src/server.test.ts` test 12 (`POST /chat` → real Hermes turn) | **pass** |
| `worker-honesty` H3 | **PASS** — `state: completed`, `output: "PONG"`, ~3 s |

KAI's own behaviour during the outage was already correct and honest — the chat turn
fell back to `presentWorkerFailure` (`core/src/chat/relay.ts`) and the run ended
`timed_out` / `AGENT_TIMEOUT` after `bestEffortStop`
(`core/src/agents/adapters/hermesAdapter.ts:205`). Nothing in KAI was mocked, skipped,
given a longer timeout or relabelled; the fix is a configuration correction on the
external worker.

### Desktop app (`app/`)

```
cd app && npm test
```

**307 passed / 0 failed** (was 300; +7 in the new `supervisor-surface` suite, which
proves the client puts the multiline `raw` argument on the wire and that the island
summarizer renders the real supervision event shapes).

## Live probes (all executed 2026-10-09 against the `2d2f4b9` tree)

| Probe | Result |
|---|---|
| `core && node scripts/orch-e2e.mjs` | **21/21 PASS** (S1–S6, incl. S2 failure → breaker → switch → success) |
| `core && node scripts/command-stream-probe.mjs` | **PASS** C1–C7 (real child stdout streamed before exit) |
| `core && node scripts/torture.mjs` | **PASS** — completionRate 1, falseCompletionRate 0, orphanTasks 0, activeRuns 0 |
| `core && node scripts/live-ux-probe.mjs` | **PASS** L1–L3 against a **rebuilt** UI (`npx vite build`) — first text 677 ms vs final 1351 ms, tool card 677 ms |
| `core && node scripts/worker-honesty.mjs` | **H1–H4 all PASS**, including H3 (a real Hermes run returns its real output) after the Hermes fix |

`live-ux-probe` was run after rebuilding `app/dist` (`npx vite build`). No app source
changed in this session (the UI changes landed in `160d94e`), but rebuilding keeps the
tested bundle provably current rather than assumed.

**worker-honesty: all four checks pass.** H1 (opencode parks for approval), H2 (offline
opencode fails with a named transport error, never a fabricated completion), H4 ×2
(denial executes nothing) and **H3** — a real Hermes run — all pass. H3's recorded result
is `state: completed`, `output: "PONG"`, in ~3 s (`docs/evidence/worker-honesty.json`).
Before the Hermes fix the same check ended `timed_out` / `AGENT_TIMEOUT` after 900.4 s;
that history and its root cause are in the diagnosis above.

Raw evidence: `docs/evidence/orch-e2e.json`, `command-stream-probe.json`, `torture.json`,
`live-ux-probe.json`, `worker-honesty.json`.

## Build

```
cd core && npm run build && npm run bundle
```

- `dist/build-info.json`: buildId `c39f55de6f9765e7`, gitCommit `2d2f4b9e526f23275457967d10ca866c4fa5e223`
  — the identity matches the tested source (the build id is content-derived, so it
  changed with the orchestration modules; it is re-stamped after every commit).
- `core/bundle/server.js` is ready to run with `node`.

**No Windows installer was built this session.** `app && npm run pack` runs `tauri build`,
which (as the previous status recorded) requires stopping the running `kai.exe` — and the
live app fronts the live Core on `127.0.0.1:8788`, which this task was explicitly told not
to touch. Packaging was therefore skipped rather than risk disturbing the live process.
The existing installer under `release/` is from the earlier build and does **not** contain
these changes.

## Live Core (`127.0.0.1:8788`) — untouched

Read-only health check, not a restart or a deploy:

```
GET http://127.0.0.1:8788/health
{"status":"degraded","service":"kai-core","version":"0.1.0",
 "hermes":{"reachable":true,"authorized":true},
 "opencode":{"reachable":false,"reason":"upstream_unreachable"}}
```

The live Core was **not** stopped, restarted, redeployed or reconfigured. It is still
serving the previous repaired build; **these changes have been tested and bundle-built
only — they are not deployed.**

## Architectural guarantees (tested)

- **Outcome Gate is authoritative.** One `board.complete` call site, gate-guarded; worker
  prose and permissive text matching can never satisfy a requirement.
- **Truthful lifecycle.** `work.planned` ≠ `delegation.routed`; a durable item is never
  reported as a started worker.
- **Retry ceiling at the orchestration boundary, per ITEM**, from a durable dispatch
  ledger (`initial` / `retry` / `reassign`); rotating workers cannot exceed it, duplicate
  deliveries and settled items are refused re-execution.
- **Approvals are final and idempotent**; an expired or spent approval authorizes nothing.
- **Evidence is split.** `kai-observed` satisfies; `worker-reported` is displayed and
  never trusted.
- **No second control plane.** Hermes/OpenCode are optional external workers.
- **Memory scope contract.** A supervision lesson is written only on the verified path,
  to mission scope; an unknown mission id refuses structurally, never globally.

## Known limitations

- **Windows only** (Tauri 2 + WebView2; verified on Windows 11).
- **A model provider is required** for intelligence (any OpenAI-compatible endpoint).
- **No real JEV shipped** (plug-in point only; deterministic is the supported path).
- **OpenCode offline on this machine** (`:4096` unreachable); KAI reports it honestly and
  never fabricates a worker result.
- **Retry ceiling is per item**, `1 + maxRetries + maxReassignments` dispatches
  (`maxReassignments` defaults to `maxRetries`). Reassignments have their own allowance
  because a worker switch is the breaker's sanctioned recovery; they never reset the
  retry count. Raise the autonomy budget or create a new item to go further.
- **External audits need a working directory** to check file claims; without one they
  report the limitation and verify nothing.
- **One environmental test failure** (`server.test.ts` live Hermes relay) — see above.
- **Skill discovery** reads KAI's own bundled library plus the staged install store; it
  does **not** yet scan `~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills` or
  project-level skill folders (documented as a follow-up in
  `docs/evidence/OPENBOT_KAI_AUDIT.md`).
- **Single-machine verification.** Cross-machine behavior not characterized.

## Ports

- KAI Core default `127.0.0.1:8788`; test/repro Cores use `:8789` (+ app `:1421/:1422`).

## Reproducing this status

```bash
cd core && npm install && npm test
cd ../app && npm install && npm test
cd ../core && node scripts/orch-e2e.mjs
cd ../core && node scripts/command-stream-probe.mjs
cd ../core && node scripts/torture.mjs
cd ../app && npx vite build && cd ../core && node scripts/live-ux-probe.mjs
cd ../core && node scripts/worker-honesty.mjs    # live Hermes/OpenCode verdicts
cd ../core && npm run build && npm run bundle
```

Raw logs for every claim are under `docs/evidence/`.
