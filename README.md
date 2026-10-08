# KAI

A persistent personal AI desktop companion and **self-contained control layer** for Windows.

KAI lives as a small floating presence at the top of the screen, runs its own agent runtime, and
can optionally drive external agents already installed on the machine (Hermes, OpenCode). The
desktop UI is the face; the intelligence is KAI Core.

> **Independence.** KAI is not a wrapper around another agent and does not depend on one to
> function. Its runtime is self-contained:
>
> ```
> KAI UI → KAI Core → KAI ModelProvider → model → KAI
> ```
>
> Hermes and OpenCode are **optional external workers** — KAI can delegate to them, but every
> KAI-owned path (missions, tools, policy, verification, completion) works without them. There is
> no second registry, no second policy engine, no second store, and no shared control plane.

KAI's character, icon and sounds are original — no upstream brand or artwork is reused. See
`NOTICE.md`.

## Architecture

```
KAI desktop app   (Tauri 2 · Rust · TypeScript · WebView2)
      │  loopback HTTP/SSE to KAI Core
      ▼
KAI Core          (Node service · 127.0.0.1:8788)
      │
      ├─ ModelProvider registry → the model you configure (any OpenAI-compatible endpoint)
      │
      ├─ Missions / work board   → work items, workers, plans, outcomes
      ├─ Tool loop + policy      → DECLARATION → POLICY → APPROVAL → EXECUTION
      ├─ Outcome Contract/Gate   → the authority over COMPLETED
      ├─ Decision Kernel         → bounded next action (never executes)
      └─ Optional workers        → Hermes, OpenCode (external, replaceable)
```

The core runtime is KAI's own. External agents are reached over loopback and are treated as
replaceable workers, never as a required dependency:

```
├─ Hermes Agent    (optional)   /health, /v1/models, /api/sessions
└─ OpenCode        (optional)   /global/health, /session, /permission, /question
```

## Mission system

A mission is a persisted work item on a board. KAI dispatches it to a worker, records every
attempt, verifies the result against an explicit **Outcome Contract**, and only then completes it.
Work items, workers, verification records and outcomes survive restart (SQLite, schema v3).

## Outcome Gate

`COMPLETED` is impossible without `OutcomeGate = PASS`. The Gate evaluates an Outcome Contract
against observed evidence, not against a worker's claim:

- a claim is not evidence; a passing test is;
- missing required evidence → `INSUFFICIENT_EVIDENCE` (never a silent pass);
- a contradicted result → `FAIL`;
- the Gate is wired into exactly one completion path (`orchestrator.finishComplete`).

## Live events

KAI Core streams events over SSE. The app dispatches **each frame as it arrives** (no whole-body
buffering), so the UI reflects real progress: text deltas, tool calls, verification, completion.
The operator workspace shows a live activity strip fed by these events.

## Command streaming

Shell commands run through `spawn`, not buffered `exec`. KAI emits
`command.started / stdout / stderr / exit` events, and the UI renders a live command card that
fills in as output arrives. (Measured: first stdout chunk ~49 ms, exit ~1.3 s on the reference
machine.)

## Anti-loop and bounded autonomy

The Decision Kernel bounds every next action. Repeated identical failures, no-progress streaks,
worker-failure streaks and depth are all capped; exceeding a limit changes the strategy
(change worker / replan) or escalates to a human — it never spins. Loop-breaker decisions are
deterministic and cannot be overridden.

## JEV is optional

KAI's decision boundary is `DecisionProvider`. Deterministic is the default; a JEV-style
accelerator is an optional plug-in that is **off and unavailable by default** (no dependency, no
network). A provider may only rank among actions the deterministic layer already deemed legal, and
its recommendation is re-validated. **KAI is not dependent on JEV for correctness, execution,
verification, or completion.** See `docs/architecture/KAI_EXECUTION_PROTOCOL.md`.

## Status: experimental

KAI is early, actively developed, and verified on a **single Windows machine**. It is not a
released product. See `docs/STATUS.md` for the current build/test status, known limitations, and
the exact commands used to produce them.

## Verified working (historical — 2026-10-01)

Everything in this table was produced by running the command, not by reading the code.

| Item | Evidence |
|---|---|
| KAI app type-checks | `npx tsc --noEmit` → exit 0 |
| KAI app builds | `npm run tauri build` → `kai.exe` + `KAI_0.1.1_x64-setup.exe`, exit 0 |
| KAI app runs | process alive, `MainWindowTitle: KAI`, `Responding: True` |
| KAI renders | screenshot of the live island shows the core + wordmark |
| Claude Code relay works | piped hook payload through `kai-hook.exe` → `hook PreToolUse`, exit 0 |
| Permission round trip works | `hook PermissionRequest` → island card → Allow → decision JSON |
| Control layer reaches Hermes (optional) | `control layer: Hermes api-server reachable …` |
| Control layer reaches OpenCode (optional) | `control layer: OpenCode reachable …` |
| Branding fully stripped | `bash scripts/rebrand-audit.sh` → **AUDIT CLEAN** |

Raw logs and screenshots are in `docs/evidence/`. Current results are in `docs/STATUS.md`.

## Repository

```
app/     the Windows desktop application (Tauri 2 + Rust + TypeScript)
core/    KAI Core — the self-contained runtime the app talks to
docs/    architecture, integrations, migration/rebrand audit, security, development
docs/evidence/   the raw logs, build output and screenshots cited above
```

## Quick start

```bash
# KAI Core (the runtime)
cd core
npm install
npm test          # the verification suite
npm start         # 127.0.0.1:8788

# The desktop app
cd ../app
npm install
npm run tauri build       # or: npm run tauri dev
./target/release/kai.exe
```

Prerequisites: Rust stable (MSVC), Node 20+, Visual Studio Build Tools 2022 with C++. WebView2
ships with Windows 11.

## Documentation

- `docs/STATUS.md` — current build/test status, limitations, and how to reproduce it
- `docs/architecture/KAI_EXECUTION_PROTOCOL.md` — missions, Outcome Gate, decision kernel, JEV
- `docs/architecture.md` — how the pieces fit, module by module
- `docs/integrations.md` — every endpoint KAI uses, and how it was verified
- `docs/security.md` — secrets, policy, the permission relay's guarantees
- `docs/development.md` — build, run, verify, package

## Licensing

KAI source is MIT (`LICENSE`). It contains source code derived from the MIT-licensed **Coucou**
project by Louis Raillé; the upstream branding, character and audio are **not** reused. The two
optional worker integrations (Hermes, OpenCode) are reached over their own public HTTP APIs and
their licenses/provenance are recorded in `NOTICE.md`.
