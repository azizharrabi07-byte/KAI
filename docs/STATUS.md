# KAI Status

Current, honest status of the KAI source tree. Everything here was produced by running the
commands shown; nothing is claimed from reading code.

- **Commit:** `d729dda` ("production repair — real renderer, timeline, cancellation, memory, workers")
  — the newest code commit; the docs-only follow-up changes no source, so this
  is the exact tree the suites, harnesses, and package below were run against.
- **Date:** 2026-10-09
- **State:** experimental, single-machine, actively developed. Not a released product.

## Test status

### KAI Core (`core/`)

```
cd core && npm test
```

| | |
|---|---|
| tests | 1132 |
| pass | 1117 |
| fail | 2 |
| skipped | 13 |

The **2 failures are environmental, not regressions** (`core/src/agents/cua-real.test.ts`):
they require the external `cua-driver` daemon (`\\.\pipe\cua-driver` unreachable on this machine).
Left visible on purpose, not skipped or hidden.

### Desktop app (`app/`)

```
cd app && npm test
```

**300 passed / 0 failed**, including the extended rendering corpus (adversarial
HTML/script/link/fence/math cases) and the production-renderer module tests.

### Live production proofs (all executed 2026-10-09, isolated Core + real built app)

- `core/scripts/browser-production.mjs` — **A–G all pass** against the real main
  window: rich markdown in place, tool cards with real result bodies, ordered
  sequential tools, live command card with exit stamped last, no-yank scroll +
  Jump-to-latest, 1200-chunk flood bounded (≤200 KB, rAF ~13–19 ms), Stop →
  task CANCELLED with real process-tree kill. Evidence:
  `docs/evidence/browser-production.json`, `docs/evidence/browser-shots/prod-a-format.png`,
  `docs/evidence/browser-shots/prod-d-command.png`.
- `core/scripts/worker-honesty.mjs` — **H1–H4 pass live**: delegation parks for
  approval, denial blocks, offline OpenCode fails `AGENT_NOT_LISTENING` honestly
  (never fabricated), Hermes returns its real output (`PONG`).
- `core/scripts/orch-e2e.mjs` — **S1–S6 pass** (autonomous routing works with no
  OpenCode). `core/scripts/command-stream-probe.mjs` — **PASS**.
- New unit suites: `chat-result-preview` 6/6, `tools-cancel` 4/4 (incl. real
  Windows tree-kill proof), `memory-scope` 7/7, `orch-decision-provider` 10/10,
  `orch-gate-authority` 6/6.

## Package

```
cd app && npm run pack
```

- `release/KAI-Windows-0.1.1-setup.exe` — 3,221,585 bytes, built 2026-10-09.
- Bundled Core build ID `2cfbd04feaba24da`, gitCommit `d729dda` — the package
  matches the tested source (`artifactMatchesSource: true`; an earlier build
  briefly shipped a stale Core and was rebuilt before release).
- Smoke test: fresh `kai.exe` alive, `MainWindowTitle: KAI`, `Responding: True`;
  live Core `/health` reports `hermes reachable+authorized`, `opencode unreachable`.
- Note: packaging required stopping the running dev-build `kai.exe` (it locks
  the binary); the live app was relaunched on the fresh build afterwards.

## Architectural guarantees (tested)

- **Outcome Gate is authoritative.** `COMPLETED` impossible without `OutcomeGate = PASS`.
- **JEV is optional.** Deterministic default; unavailable provider; cannot bypass the Gate.
- **Stop really stops.** AbortSignal runs through brain → registry → spawned
  process tree (`taskkill /T /F`); cancelled exits recorded; tasks settle CANCELLED.
- **Memory scope contract.** `memory.write` validates scope strictly; mission steps
  inherit their mission's scope; refusal-valued steps fail honestly.
- **No second control plane.** Hermes/OpenCode are optional external workers.

## Known limitations

- **Windows only** (Tauri 2 + WebView2; verified on Windows 11).
- **A model provider is required** for intelligence (any OpenAI-compatible endpoint).
- **No real JEV shipped** (plug-in point only; deterministic is the supported path).
- **OpenCode offline on this machine** (connection refused on `:4096`); KAI reports
  `OPENCODE OFFLINE · unreachable` and routes autonomous work through its own
  orchestrator/personas and Hermes instead of fabricating.
- **Two environmental test failures** (`cua-real` named-pipe) — see above.
- **Single-machine verification.** Cross-machine behavior not characterized.

## Ports

- KAI Core default `127.0.0.1:8788`; test/repro Cores use `:8789` (+ app `:1421/:1422`).

## Reproducing this status

```bash
cd core && npm install && npm test
cd ../app && npm install && npm test
cd ../core && node scripts/browser-production.mjs   # needs Playwright chromium + vite-built app
cd ../core && node scripts/worker-honesty.mjs       # live Hermes/OpenCode verdicts
```

Raw logs for every claim are under `docs/evidence/`.
