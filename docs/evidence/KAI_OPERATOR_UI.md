# KAI operator workspace UI — implementation

The supplied operator-console design is implemented into the REAL KAI app
(presence shell), not a prototype. Reference stored at
`docs/design/KAI_OPERATOR_UI_REFERENCE.html`.

## What changed (UI files)

- `app/src/shell/presence/presence.ts`:
  - Operator identity header (`.top.op`): the REAL KAI character engine
    (`orbs.who`, same `KaiEngine`) + `KAI // AUTONOMOUS OPERATOR` + live mood.
  - Live activity strip (`#kp-actstrip`): compact operator rows appended as
    real events arrive (worker/review/delegation/benchmark + per-tool during a
    turn), bounded to 30, colour-coded. Never a post-hoc dump.
  - Operator state pills (`#kp-opstate`): `RUNTIME ACTIVE/OFFLINE` (workspace
    connection), the latest operator event, and pending approvals — all real.
  - Console chips (`#kp-opchips`): live `@ /work /status /bench /abort` that
    insert into the composer; shortcut hint row.
  - Stop/Copy/Edit controls (prior phase) retained.
- `app/src/shell/presence/presence.css`: operator chrome styles using existing
  tokens (no framework, no palette change).

## Routes consolidated

Rail is now **KAI · Sessions · Agents · Settings** (was 12). The eight other
surfaces (home, missions, workers, tools, mcp, activity, memory, skills) stay
real, deep-linkable routes reached by `/`, palette, or `#/route` — no
permanent tabs. Browser scene H asserts rail = exactly those four + all
contextual routes reachable.

## Command surfaces

Added in the prior phase (live in this build): `/work /status /tasks /runs
/bench /workers /activity /reasoning /abort /self-audit`, plus the existing
set. `/` and `@` remain the primary control/delegation interfaces, reading the
live command registry and agents+skills.

## Character integration

The workspace uses the real `KaiEngine` (rail orb, header `who`, hero) driven
by `kaiCharacter` from real runtime events — no placeholder, no second engine.

## Renderer

Unchanged OpenGhost-inspired renderer (markdown/streaming/code/tables/TeX/tool
cards/approval cards); result-first `guidance` section + synthesis guard drive
structure.

## Fake telemetry removed

The reference's decorative values (DAG Solver, Concurrency Cap, Token Budget,
Entropy Risk Ceiling, Egress Policy, LOCALHOST:7443, BREACHES, branch) are NOT
rendered. Only real KAI state appears.

## Screenshots / proof

`docs/evidence/browser-shots/` (12 shots incl. `shot-bench.png`,
`shot-inspector.png`, `shot-mission.png`, `shot-activity.png`).
Browser scenes A–K PASS (`browser-repro.json`), including scene K: operator
identity header, live strip, state pills, console chips.

## Tests

core 1071/0 · app 297/0 · browser A–K PASS · torture PASS (unchanged).

## Package

- SOURCE COMMIT: `1a73c1f655f8cf5de01201deeb9ab17c87ee9bad`
- BUILD ID: `abf81a6c4e9c8eee`
- KAI.EXE: `app/target/release/kai.exe` — 5,089,792 bytes @ 2026-10-08 02:00:52
- INSTALLER: `app/release/KAI-Windows-0.1.1-setup.exe` — 3,201,484 bytes @ 02:00:52
- ARTIFACT MATCH: `artifactMatchesSource: true`, `freshness: fresh`
- PACKAGED SMOKE: bundle boots (266 skills, providers, autonomy, work-items),
  `kai.exe` launches live.

## Remaining limitations (honest)

This phase delivered the UI. Two items from the same brief are NOT yet done
and remain the frontier: **(1) chat→operator auto-bridging** (ordinary chat is
still answer-mode; the operator runs via `/work`, missions, `@`) and **(2)
semantic verification** (verification is structural: deliverable + evidence +
review). Also unchanged: no mid-flight worker preemption, remote MCP
unimplemented, provider reasoning signals unwired.
