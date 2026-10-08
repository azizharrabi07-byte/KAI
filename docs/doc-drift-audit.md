# KAI — documentation drift audit

Read-only audit of `docs/*.md` and `README.md` against the current source, tests and
build stamps. No file other than this one was modified.

**Measured baseline (this session, not re-derived here):** `core` `npm test` = **624
tests, 624 pass, 0 fail, 0 skipped**; core `typecheck` exit 0; `app` `npm test` = **59
tests, 59 pass, 0 fail**; app `typecheck` exit 0; Core buildId `a972a27b590bf756`,
gitCommit `535acb82f48ce9f7c0a433db5ad04ef1dde84a60`; `git rev-parse HEAD` =
`535acb82f48ce9f7c0a433db5ad04ef1dde84a60`.

Where a suite claim is broken out per file, the count is the number of `test(`/`it(`
declarations in that file (`grep -cE '(^|[^a-zA-Z])(test|it)\('`), which matches the
runner's reported totals.

## Findings

| File | Line / section | Claim | Reality (evidence) | Suggested fix |
|---|---|---|---|---|
| `docs/testing.md` | L9, "Run everything" | `cd core && npm test  # 160 tests, 160 pass, 0 fail` | Current run: **624 tests, 624 pass, 0 fail** (session baseline). `docs/evidence/core-npm-test.txt` records an older **31** — neither matches. | Update to 624/624/0. |
| `docs/testing.md` | L10 | `cd app && npm test  # desktop unit tests (timeAgo, 10 cases)` | `app/tests/` holds **4 suites, 59 tests** (session baseline): `kai-core` (17), `core-events` (18), `core-state` (12), `timeAgo` (12); `grep -cE '(^|[^a-zA-Z])(test\|it)\(' app/tests/timeAgo.test.ts` = 12. | Update to "59 tests across 4 suites". |
| `docs/testing.md` | L46, suite table | `core/tests/runtime.test.ts` — 6 tests | File has **15** test declarations. | Update to 15. |
| `docs/testing.md` | L47 | `core/tests/missions.test.ts` — 11 tests | File has **17**. | Update to 17. |
| `docs/testing.md` | L49 | `core/tests/policy.test.ts` — "17 + 21" | `policy.test.ts` = **21**; `tools.test.ts` = 21. | Update policy to 21. |
| `docs/testing.md` | L54 | `app/tests/timeAgo.test.ts` — 10 | File has **12**. | Update to 12. |
| `docs/development.md` | L27 | `npm test  # the app's own suites (57), scoped to app/tests` | **59** (session baseline). | Update to 59. |
| `docs/development.md` | L59 | `npm test  # 229 tests, straight from TypeScript` | **624** (session baseline). | Update to 624. |
| `docs/development.md` | L150, "Verifying a change" | "There is no unit-test suite for the front end; verification is by building and running for real." | `app/tests/` contains 59 unit tests (`timeAgo`, `kai-core`, `core-events`, `core-state`) and `app npm test` runs them. | Reword: there is no *rendering* unit suite; the app has unit suites under `app/tests`. |
| `README.md` | L40, "Verified working" table | `KAI Core service | npm test → 31 passed / 0 failed` | **624/0** now; the cited `core/evidence/npm-test.txt` is the old 31. | Update the count (and note the evidence file is historical). |
| `docs/api.md` | L96–100, "Still to do" | "The **UI↔Core client** is PLANNED … the status surface and the event stream are not yet consumed by the UI." | Implemented: `app/src/core/kai-core.ts`, `core-events.ts`, `core-state.ts`, `core-boot.ts`, `app/src/island/core-bridge.ts` all exist; `docs/phase-2.5-report.md` reports the integration as PASS. | Delete/rewrite as IMPLEMENTED (phase 2.5). |
| `docs/api.md` | Endpoints table (L16–34) | Table presents the Core's HTTP surface; `/integrations` and `/identity` are absent. | `core/src/server.ts:251,578` (`/integrations`), `core/src/api/routes.ts:1809` (`/identity`); plus `/policy`, `/employees*`, `/capabilities*`, `/schedules*`, `/recovery/*`, `/checkpoints*`, `/learning/*`, `/memory/search`. | Add the missing routes or state explicitly that the table is a subset. |
| `docs/core.md` | L94, module map | "UI↔Core client … **PLANNED** — `POST /chat` already reaches the Core router" | Same implemented files as above; phase 2.5 shipped it. | Mark IMPLEMENTED. |
| `docs/core.md` | L101 | `cd core && npm test  # 229 tests, 229 pass, 0 fail, 0 skipped` | **624** (session baseline). | Update to 624. |
| `docs/core.md` | L28–31, boundaries table | Rows marked **MOVE**: "Agent polling … `integrations.rs` polls"; "Mission orchestration, scheduling, policy, approvals, memory, notifications … **do not exist yet**"; agent protocol in Rust/UI | Core now owns missions/scheduler/policy/tools/approvals/memory; `app/src/island/core-bridge.ts` and `core-boot.ts` consume Core state/events. | Update the status column to the post-phase-2.5/3 reality. |
| `docs/core.md` | L78–92, module map counts | `api/routes.ts` "36 tests"; `missions` "6 end-to-end tests"; several per-module counts | `core/tests/api.test.ts` = 39; `core/tests/runtime.test.ts` = 15. | Refresh the per-module counts. |
| `docs/core.md` | L180–183, "See also" | Points to `docs/agents.md`, `docs/hermes.md`, `docs/opencode.md` "adapters"; `docs/missions.md` "planned/being built" | **None of these four files exist** (`docs/` has no `agents.md`, `hermes.md`, `opencode.md`, `missions.md`). | Remove the dead links or create the files. |
| `docs/security.md` | L49–50, "The local webview" | "`connect-src` is limited to `ipc:` and `http://ipc.localhost`. The page cannot make arbitrary network requests." | `app/src-tauri/tauri.conf.json:15–16` now also allows `http://127.0.0.1:8788` and `http://localhost:8788` (dev adds `ws://localhost:1420`). `docs/architecture-audit.md:65` already flags this exact stale claim. | Add the Core loopback origins to the stated CSP. |
| `docs/integrations.md` | L176–177, §4 "Not integrated" | "The same goes for KAI Core: the app uses it when it is there and falls back when it is not, but **it will not start it**." | The app **does** start/adopt Core: `app/src-tauri/src/core_process.rs` (`lib.rs:491–493`, `core_process::start`), documented as FIXED in `docs/phase-3-report.md` §A. | Correct to "the app adopts an existing Core or starts one and ties its life to KAI". |
| `docs/phase-2.5-report.md` | L112–114, "Known limitations" | "**The island does not start the Core yet.** The spec's 'ensure Core' step is not implemented." | Implemented in `core_process.rs`; `docs/phase-3-report.md` §A marks the gap FIXED. | Mark superseded by phase 3. |
| `docs/phase-2.5-report.md` | L83–84, tests table | app **57**; core **229** ("216 pass, 0 fail, 13 skipped") | app **59**; core **624/624/0 skipped** (session baseline — the 13 "skips" no longer hold). | Update counts. |
| `docs/phase-3-report.md` | L218–219, "E" chain | "`app`: `npm test` — 57/57"; "`core`: `npm test` — 229 tests, 227 pass, 2 fail" | app **59**; core **624 pass, 0 fail** (session baseline). | Update counts (or label the section as a dated snapshot). |
| `docs/architecture-audit.md` | L8–9, intro | "Tests at audit time: Core **229** (227 pass, 0 fail, 2 skipped), app **57/57**" | core **624**, app **59** (session baseline). | Update, or date-stamp the snapshot. |
| `docs/migration.md` | L183, §6 | "`core/` — the KAI Core control-plane service, with **31** passing tests." | **624** (session baseline). | Update to 624. |
| `docs/phase2-state.md` | L7–8, "Repository" | "HEAD at handoff: `ec3bbd8`"; "Core tests: **605 / 605**" | `git rev-parse HEAD` = `535acb82…`; core = **624**. | Whole file is a superseded handoff snapshot. |
| `docs/phase2-state.md` | L14–35, acceptance matrix | C4/R4/I1–I4/prompt-precedence **NOT RUN**, L2 **PARTIAL** | Superseded by later phases (phase 3 closed the "ensure Core" gap; checkpoints/recovery/skills now have coverage). | Retire the file or mark it historical. |
| `docs/ui-core-dataflow.md` | L40–41 | "today the UI's picture of 'what is happening' comes from **Rust pollers**, and the Core is used for exactly one thing: chat, by Rust." | Now `app/src/core/core-boot.ts` + `core-events.ts` + `island/core-bridge.ts` read `/state` and subscribe to `/core/events`. | Note the doc is a pre-change design record; add a "current state" pointer to `phase-2.5-report.md`. |
| `docs/architecture.md` | L69–84, Rust module table | Lists the Rust modules; `core_process.rs` (the Core supervisor) is absent. | `app/src-tauri/src/core_process.rs` exists and is wired in `lib.rs`; documented in `development.md` L40–46 and `phase-3-report.md` §A. | Add `core_process.rs` to the module table. |
| `README.md` | L77–83, "Documentation" section | Lists only architecture / integrations / migration / security / development. | Docs also include `core.md`, `api.md`, `testing.md`, `ui-core-dataflow.md`, the phase reports and the audit docs. | Add the missing entries (at least `core.md`, `api.md`, `testing.md`). |

## Entirely stale documents

- **`docs/phase2-state.md`** — a point-in-time handoff snapshot: wrong HEAD (`ec3bbd8`
  vs current `535acb82…`), wrong Core test count (605 vs 624), and an acceptance matrix
  whose NOT RUN/PARTIAL rows are superseded by later phases and evidence. Retire or
  archive.
- **`docs/core.md`** — the module map's statuses (MOVE/PLANNED), the per-module test
  counts, the 229-test verification line, and four "See also" links to files that do not
  exist. Substantially stale; needs a rewrite against the current Core.

## Stale-by-snapshot (historical reports whose numbers no longer hold)

`docs/phase-2.5-report.md`, `docs/phase-3-report.md` and `docs/architecture-audit.md` are
dated reports, but each still asserts test counts (57 / 229) as current fact; update the
counts or add an explicit "as of <revision>" marker. `docs/ui-core-dataflow.md` is a
pre-change design record and should carry the same marker.
