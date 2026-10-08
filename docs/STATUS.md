# KAI Status

Current, honest status of the KAI source tree. Everything here was produced by running the
commands shown; nothing is claimed from reading code.

- **Commit:** `cbdb0a8de35d1a9c9bcb451d3c2c7fd961999e74`
- **Date:** 2026-10-08
- **State:** experimental, single-machine, actively developed. Not a released product.

## Test status

### KAI Core (`core/`)

```
cd core && npm test
```

Result at the commit above:

| | |
|---|---|
| tests | 1115 |
| pass | 1100 |
| fail | 2 |
| skipped | 13 |

The **2 failures are environmental, not regressions.** Both are in `core/src/agents/cua-real.test.ts`
(the `cua-real` named-pipe tests): they require the external `cua-driver` daemon, whose named pipe
`\\.\pipe\cua-driver` is not running on this machine. They fail because the dependency is absent,
not because KAI is broken. They are left visible here on purpose rather than skipped or hidden.

### Desktop app (`app/`)

```
cd app && npm test
```

Last recorded: **297 passed / 0 failed.** (See `docs/evidence/` for the raw output of the run.)

### Orchestration end-to-end

```
cd core && node scripts/orch-e2e.mjs
```

Last recorded: **119 passed / 0 failed** across the orchestration modules (board, bench, dispatch,
prompts, review, trace, learn, commands, outcome, gate authority, decision provider).

### Live probes

```
cd core && node scripts/live-ux-probe.mjs
cd core && node scripts/command-stream-probe.mjs
cd core && node scripts/torture.mjs
```

Last recorded: chat streaming first-token ≈283 ms; command streaming first-stdout ≈49 ms, exit
≈1.3 s; torture suite completion 1.00, false-completion 0, needs-continue 0, orphaned work 0.

## Architectural guarantees (tested)

- **Outcome Gate is authoritative.** `COMPLETED` is impossible without `OutcomeGate = PASS`.
  `tests/orch-gate-authority.test.ts` (6/6) covers the invariant, alternate paths, a CONTRADICTED
  result, anti-loop, and resume.
- **JEV is optional.** Deterministic is the default; the JEV provider is unavailable by default.
  `tests/orch-decision-provider.test.ts` (10/10) proves KAI works with JEV off, unavailable,
  throwing, malformed, low-confidence, or recommending something illegal — and that a provider can
  never bypass the Gate.
- **No second control plane.** KAI owns its registry, policy, stores and completion path. Hermes
  and OpenCode are optional external workers.

## Known limitations

- **Windows only.** The desktop shell is Tauri 2 + WebView2; verified on Windows 11.
- **A model provider is required** for chat/intelligence. KAI speaks to any OpenAI-compatible
  endpoint via the `ModelProvider` registry; there is no bundled model.
- **No real JEV is shipped.** The decision-provider boundary exists and is tested, but the JEV
  implementation is a plug-in point only (no dependency, no network). Deterministic is the
  supported path.
- **Two environmental test failures** (`cua-real` named-pipe) require the external `cua-driver`
  daemon. See above.
- **Single-machine verification.** All evidence was produced on one machine; cross-machine
  behavior is not yet characterized.
- **Experimental.** Interfaces, storage schema, and the UI are still changing.

## Ports

- KAI Core default: `127.0.0.1:8788`.
- A reproduction/test Core may run on `127.0.0.1:8789` with the app on `:1421`, so the live Core is
  never disturbed.

## Reproducing this status

```bash
cd core && npm install && npm test
cd ../app && npm install && npm test
```

The raw logs for every claim above are under `docs/evidence/`.
