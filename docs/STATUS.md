# KAI Status

Current, honest status of the KAI source tree. Everything here was produced by running the
commands shown; nothing is claimed from reading code.

- **Commit:** `160d94e` ("supervisor trust loop — claims are not proof, evidence is")
  — the newest **code** commit. A docs-only follow-up (this file, the supervisor
  contract, the OpenBot re-verification) changes no source, so `160d94e` is the
  exact tree the suites, probes and build below were run against.
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
- **Retry budget at the boundary**, per (item, worker), so callers cannot bypass it
  while a legitimate worker switch still works.
- **Approvals are final** (approved / rejected / expired cannot be re-spent) and
  duplicate deliveries are no-ops.
- **`/audit` and `/summary`** are real commands in the production command path, plus a
  durable once-per-local-day summary offer on the one scheduler.
- **Handoff persistence fix:** the parsed worker handoff is stored before review, so a
  run that parks (review or a guarded evidence check) is resumable.
- See `docs/architecture/KAI_SUPERVISOR_TRUST.md` for the full contract.

## Test status

### KAI Core (`core/`)

```
cd core && npm test
```

| | |
|---|---|
| tests | 1186 |
| pass | 1172 |
| fail | 1 |
| skipped | 13 |

The **1 failure is environmental, not a regression** (`core/src/server.test.ts:249`,
"POST /chat runs a real turn through Hermes"): the test's own runtime reports the Hermes
capability as unavailable. It failed identically on the pre-change baseline, so it is
pre-existing. Note the **live** Core's own health probe (below) reports Hermes
`reachable+authorized`, so this is specific to the test runtime's wiring, not to Hermes
being down. Left visible on purpose — not skipped, not hidden.

New suites added by this work (all passing): `orch-supervisor-trust` (32 tests — the
17-case suite plus retry-budget, offline-worker, supervisor-failure and redaction
cases), `summary-daily` (11), `summary-audit-commands` (7).

### Desktop app (`app/`)

```
cd app && npm test
```

**307 passed / 0 failed** (was 300; +7 in the new `supervisor-surface` suite, which
proves the client puts the multiline `raw` argument on the wire and that the island
summarizer renders the real supervision event shapes).

## Live probes (all executed 2026-10-09 against the `160d94e` tree)

| Probe | Result |
|---|---|
| `core && node scripts/orch-e2e.mjs` | **21/21 PASS** (S1–S6, incl. S2 failure → breaker → switch → success) |
| `core && node scripts/command-stream-probe.mjs` | **PASS** C1–C7 (real child stdout streamed before exit) |
| `core && node scripts/torture.mjs` | **PASS** — completionRate 1, falseCompletionRate 0, orphanTasks 0, activeRuns 0 |
| `core && node scripts/live-ux-probe.mjs` | **PASS** L1–L3 against a **rebuilt** UI (`npx vite build`) — first text 758 ms vs final 1357 ms, tool card 663 ms |
| `core && node scripts/worker-honesty.mjs` | **H1, H2, H4 ×2 PASS; H3 FAIL** — see below |

`live-ux-probe` was run only after rebuilding `app/dist` (`npx vite build`), because this
work changed UI source (`presence.ts` `runSlash`, `core-state.ts` summariser,
`kai-core.ts` client); testing a stale bundle would have proven nothing.

**worker-honesty H3 FAILED, honestly.** H1 (opencode parks for approval), H2 (offline
opencode fails with a named transport error, never a fabricated completion) and H4 ×2
(denial executes nothing) all passed. **H3 did not:** a real Hermes task run ended
`timed_out` / `AGENT_TIMEOUT` after ~15 minutes (`docs/evidence/worker-honesty.json`).
This is consistent with the one core-suite failure above — Hermes answers the health
probe (`reachable+authorized` on the live Core) but does not complete a turn on this
machine. It is an external-worker limitation, reported rather than worked around. **Do
not read this as "Hermes verified".**

Raw evidence: `docs/evidence/orch-e2e.json`, `command-stream-probe.json`, `torture.json`,
`live-ux-probe.json`, `worker-honesty.json`.

## Build

```
cd core && npm run build && npm run bundle
```

- `dist/build-info.json`: buildId `220087d9e43f77a3`, gitCommit `160d94ec` — the identity
  matches the tested source.
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
- **Retry budget at the orchestration boundary**, per (item, worker); duplicate
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
- **Retry budget is per (item, worker), not per item** — a caller rotating through many
  distinct worker ids gets `1 + maxRetries` attempts each (bounded, but not a per-item cap).
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
