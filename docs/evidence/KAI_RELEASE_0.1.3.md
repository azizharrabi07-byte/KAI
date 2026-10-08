# KAI 0.1.3 — autonomous operator release

## HEAD

- commit: `2719c0569042e89ceea5ed492d93f89eeb3a73cd`
- tree: clean; packaged from this commit
- version strings inside artifacts: `0.1.1` (no bump cut); candidate `0.1.3`

## PACKAGE

- `npm run pack` (kai-hook + core bundle + vite + tauri nsis + pack)
- core build: `08d1e850c1d0925a`, gitCommit `2719c056…`, protocol 1
- `core/bundle/skills-library`: 256 .md (255 curated + SOURCES.md)

## KAI.EXE

- `app/target/release/kai.exe` — 5,085,696 bytes @ 2026-10-07 22:03:37
- launched live: process up, main window present, killed cleanly

## INSTALLER

- `app/release/KAI-Windows-0.1.1-setup.exe` — 3,185,339 bytes @ 22:03:36
- `app/release/KAI-Windows-setup.exe` — same bytes (rolling copy)
- `target/release/bundle/nsis/KAI_0.1.1_x64-setup.exe` — fresh (3.04 MiB)

## BUILD TIME

~3 min (hook, core bundle, vite ~1.3s, tauri release, nsis, pack)

## SHIPPED-BUNDLE SMOKE (isolated DB, fresh bundle)

identity FRESH · `artifactMatchesSource: true` · skills **266** (255 library +
11 builtins: 4 original with deep-research upgraded, + 7 new) · providers
`kai-model,hermes,opencode` · bench 0 (clean) · work-items 0 (clean) ·
autonomy default level 2, activity COMPACT, reasoning SUMMARY. All orchestration
routes present and serving.

## TEST RESULTS

- core: **1071 pass / 0 fail / 13 skipped** (orchestration +9 files)
- app: **297 pass / 0 fail**
- browser: **44/44 PASS** (scenes A–J), 12 screenshots
- orchestrator E2E: **21/21 PASS** (`orch-e2e.json`), incl. 25 concurrent +
  50 sequential + 3-level nesting

## TASK COMPLETION / OPERATOR E2E

Mission loop decomposes→delegates→reviews→verifies→delivers; "continue"
resumes; budget-cut pauses honestly (0.1.2) — all still green.

## PROVIDER / MODEL SWITCH E2E

`/providers` live, `/models` live + select parks→applies→persists (0.1.2),
still green on this tree.

## PERFORMANCE

Lag probe: input 15.6ms, palette 16ms, `/`+`@` ~17ms, first-delta ~734ms,
session switch 87ms, route 39ms — zero Core requests while typing.
Stress: 25 concurrent collision-free, 50 sequential, activity bounded.

## OPEN GHOST RENDERING CHECK

Structured markdown/streaming/code/tables/tool cards/approval cards/TeX
unchanged; rendering corpus green; new surfaces (Bench, inspector, Autonomy,
Activity, mission inspector) use the existing IA + CSS classes only. Look and
character unchanged.

## KNOWN LIMITATIONS

1. Chat turns do not auto-delegate (missions/commands only).
2. Structural (not semantic) verification.
3. No mid-flight worker preemption.
4. Provider reasoning signals unwired (setting retained).
5. Reviewer is KAI's own model in an independent context.
6. Remote MCP transport unimplemented.
7. Version strings read 0.1.1 (no bump cut).
