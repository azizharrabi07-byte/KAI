# KAI 0.1.1 — release report (single-owner build)

Built 2026-10-06, commit `35909d2`, core build `70c59f4380fa8865`.
Installer: `app/release/KAI-Windows-0.1.1-setup.exe` (2.96 MB, NSIS,
currentUser — no admin prompt). Portable: `app/target/release/kai.exe`.

## What this release contains

**Baseline (P0–P24, earlier work):** real tool loop with policy gating,
sessions with persistence/isolation, commands + palette, memory/soul,
skills metadata + staging pipeline, plugins, MCP resources/read, agent
runs/events/cancel, plans/missions, streaming UX, perf profile, home
sections + theme control. Visual freeze held throughout; KAI-owned runtime
(Hermes/OpenCode workers only, no second registry/policy/store).

**This session:**
- Bug A (invisible tool-turn answers) + Bug B (stale-snapshot races) fixed,
  browser-proven (`8dc0beb`).
- Live `/` commands from the real registry + live `@` agent/skill invocation
  with Allow-to-collect, browser-proven scenes F/G (`ea84438`).
- Navigation consolidated: real `show→navigate→hash` wiring, truthful
  `getRoute()`, deep links, MCP icon, orphans removed, 12-route clickthrough
  + deep-link proof (`nav-clickthrough.json`).
- Core `/settings` (model.name/baseUrl/timeoutMs, per-key sources, WRITE
  parks, live next turn, survives restart) + shell Model section + settings
  window repairs (direct-model section, anthropic key, opt-in pill counting,
  island_pos typing, Hermes restart hint) (`5262c27`).
- Rendering corpus: 12 tests over every pure renderer (markdown escaping,
  tool cards, titles, session views, tool/MCP/activity views) (`297` app).
- Stress suite green: 30 sequential (p50 11ms/p95 14ms), 40 concurrent
  isolated, 150-turn transcript (write 1.5s/read 4ms), 15 tool turns
  grounded, RSS +30MB (`stress.json`).
- Skill library: **255 curated third-party skills from 7 MIT/Apache-2.0
  sources** + 4 KAI builtins = **259 seeded at boot** (~3s), each passing
  KAI's validator, red-flag scanned, licensed, attributed (`SOURCES.md`).
  Staged-skill Discard path added end to end.
- MCP external-process proof live over HTTP: register→enable→connect→call→
  resources→provenance, all gated (`mcp-external-live.json`); stale docs
  corrected. Remote (http/sse) transport remains honestly unimplemented.

## Verification matrix (all green at release commit)

| Check | Result |
|---|---|
| core suite | 961 pass / 0 fail / 13 skipped |
| app suite | 297 pass / 0 fail |
| core + app typecheck | clean |
| browser repro (A–H, 16 + 12 + 1 checks) | PASS |
| stress budgets | PASS |
| settings tests (validation/precedence/durability/park/live) | 6/6 |
| skills tests (builtin 4/4, library 6/6) | 10/10 |
| MCP external live | 13/13 |
| shipped-bundle smoke (`/skills`=261 incl. user DB rows, `/settings` sources) | PASS |

## Install (your machine only)

Run `app/release/KAI-Windows-0.1.1-setup.exe`, click through SmartScreen
"unknown publisher" (unsigned single-owner build). First boot seeds 259
skills (~3s), adopts or spawns Core on :8788, opens the island + main
window. No keys are baked in: Core resolves the Hermes key at runtime.

## Known honest limitations

- Remote MCP (http/sse) refused with reason; stdio only.
- Theme records but does not render on the orb (admitted in UI).
- `absenceInterval` persists but is never consumed.
- First install carries no user skills; learned skills install only through
  the sha256-bound approval pipeline.
