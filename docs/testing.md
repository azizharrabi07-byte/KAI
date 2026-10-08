# Testing KAI

Status vocabulary: **IMPLEMENTED** (works, verified) · **PARTIAL** · **PLANNED**.
Counts current at HEAD `81479bc`; the phase-by-phase matrix is in `docs/phase4-report.md`.
Everything on this page was run on this machine; the numbers are real.

## Run everything

```bash
cd core && npm test        # 664 tests, 664 pass, 0 fail, 0 skipped (no build needed)
cd app  && npm test        # 80 tests, 80 pass, 0 fail, 0 skipped
```

`npm test` in `core/` runs every `*.test.ts` under `core/tests` and `core/src`
directly from TypeScript. Build and typecheck are separate on purpose:

```bash
cd core && npm run typecheck   # tsc --noEmit, zero errors
cd core && npm run build       # emits dist/ for `npm start`
```

## Why a runner script instead of a glob

`core/scripts/test.mjs` exists because two things about `node --test` are awkward
here, and both were discovered by hitting them (see the commit that added it):

1. **Globs are expanded by the shell, not by npm.** `"test": "node --test
   tests/*.test.ts"` works in bash and silently breaks when npm runs the script
   through `cmd.exe` on Windows. `node --test tests/` is rejected outright by
   Node 26 — it treats the directory as a module specifier. The script therefore
   discovers the files itself, which behaves the same everywhere.
2. **Some suites need the live agents.** The pre-existing suites talk to the real
   local Hermes (`127.0.0.1:8642`) and OpenCode (`127.0.0.1:4096`) servers and read
   the key from `API_SERVER_KEY` / `KAI_HERMES_KEY`. Without it they fail with an
   authorization error, which looks exactly like a regression. The runner loads the
   key from the Hermes install's `.env` when it is present, never prints it, and
   still runs (and honestly fails) if the file is missing.

If a suite needs a *live* agent that is not running, it fails rather than skipping —
that is deliberate: a green run must mean the thing was verified, not that it was
quietly not attempted.

## What the suites cover

| Suite | Tests | What it proves |
|---|---|---|
| `core/tests/runtime.test.ts` | 6 | The Core as a whole: boots, connects agents, health from live calls; a mission completing through a tool step and an agent step; an external tool parking for approval **without executing**; a deny rule failing a step before the tool runs; a scheduled task firing and running a real mission; **state surviving a restart** including recovery that refuses to re-run a side-effecting step |
| `core/tests/missions.test.ts` | 11 | Mission lifecycle, step ordering, failure handling, policy parking, crash recovery rules |
| `core/tests/scheduler.test.ts` | 12 | `computeNextRun` for once/interval/daily, no catch-up double-fire, bounded failure handling |
| `core/tests/policy.test.ts`, `tools.test.ts` | 17 + 21 | Risk defaults, rule overrides, `validate → policy → approval → execute` order, approvals and expiry |
| `core/tests/storage.test.ts` | 15 | SQLite CRUD, mission+steps round-trip, migrations, restart persistence on a temp file |
| `core/tests/events.test.ts`, `notifications.test.ts` | 27 | Bus filtering, subscriber isolation, selective persistence, dedupe window |
| `core/tests/registry.test.ts`, `adapters.test.ts` | 20 | Adapter capabilities, typed errors, mocks that can fail or hang, and that an API key never appears in any returned value |
| `core/src/**/*.test.ts` | 31 | The pre-existing clients against the **live** local servers (routes verified, never asserted from assumption) |
| `core/tests/workspace.test.ts` | 12 | The REAL shell/git/filesystem ops: bounded reads, directory listing, honest truncation, a real `execFile` spawn (exit code, output), git status/log, and the risk/`effectful` classification each tool carries |
| `core/tests/workspace-approval.test.ts` | 6 | A WRITE/DESTRUCTIVE capability action PARKS, the parked call is recorded durably, an APPROVED verdict RE-ISSUES it (the effect happens), a REJECTED one runs nothing, and a parked request survives a Core restart |
| `core/tests/learning-trace.test.ts` | 1 | L2: a user lesson → a `learning.propose` action record naming the memory it wrote → a later composed prompt containing that lesson (and not before) |
| `app/tests/kai-core-sessions.test.ts`, `core-state-sessions.test.ts` | 21 | The session client methods (defensive parsing, never throw) and the session slice of the Core snapshot reducer |
| `app/tests/timeAgo.test.ts` | 10 | The session-age unit bug (`1790888537.0502937` seconds must not render as `20707d`) |

## Rules these tests follow

- **A test asserts observed behaviour, not that code exists.** The end-to-end suite
  checks a mission actually reached `COMPLETED` with real step output, that a tool
  the policy refused was *never executed*, and that a fire handler really produced a
  mission rather than logging a line.
- **Deterministic by injection.** Clock and id factories are injected everywhere; no
  test sleeps for real time or depends on wall-clock ordering.
- **No network in Core tests.** Agents are mocked; only the pre-existing client
  suites are allowed to touch the live servers, and they are labelled as such.
- **Temp databases only.** Tests never touch the real user database
  (`%LOCALAPPDATA%\KAI\core\kai-core.db`); they use `:memory:` or a temp file, and
  the restart test reopens the same temp file to prove persistence for real.
