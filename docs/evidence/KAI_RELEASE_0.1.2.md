# KAI 0.1.2-RC — release-candidate validation

Validates source commit `d5d5acc` (task completion + model control pass).
No code was added or changed for this validation: HEAD before and after is
`d5d5acc`, tree clean. Version strings inside the artifacts read `0.1.1`
(no version bump was cut); this report names the candidate `0.1.2-RC`.

## HEAD

- commit: `d5d5acc2152936ba1765324c76fc171c26c50dc9`
- tree: clean before packaging, clean after

## PACKAGE

- command: `cd app && npm run pack` (kai-hook + core bundle + vite + tauri nsis + pack)
- core build: `b73e4a38413b202a`, gitCommit `d5d5acc2`, protocol 1
- `core/bundle/skills-library`: 256 .md (255 skills + SOURCES.md)

## KAI.EXE

- path: `app/target/release/kai.exe`
- timestamp: 2026-10-07 12:22:54 local
- size: 5,081,600 bytes
- live check: launched, 3 on-screen windows (main + island + proxy), killed cleanly

## INSTALLER

- `app/target/release/bundle/nsis/KAI_0.1.1_x64-setup.exe` — 3,117,658 bytes, 12:22:54
- `app/release/KAI-Windows-0.1.1-setup.exe` + `app/release/KAI-Windows-setup.exe` — same bytes
- fresh (built 12:19:58→12:22:54 this run, not the 0.1.1 artifact)

## BUILD TIME

~3 min (hook 4s, core bundle, vite 1s, tauri release 2m19s, nsis + pack)

## CORE TESTS — 971 pass / 0 fail / 13 skipped

## APP TESTS — 297 pass / 0 fail

## BROWSER TESTS — 33/33 PASS (fresh browser-repro.json + 8 screenshots)

## TASK COMPLETION E2E — PASS (rc-validation scenario 1)

Multi-tool task (search→read→verdict): reply names the files AND the
verdict marker, task COMPLETED, tool history persisted. Not progress text.

## CONTINUE E2E — PASS (scenario 2)

Budget-cut → PAUSED with Completed/Remaining/continue → "continue" ran the
resume prompt (observed `Original objective…` in model bodies) and completed.
No restart of the investigation.

## BUDGET-CUT E2E — PASS (scenario 3)

Empty synthesis → structured PAUSED, never the bare progress sentence.

## PROVIDER SWITCH E2E — PASS (scenario 4, providers leg)

3 live entries with kinds; worker model override refused 400.

## MODEL SWITCH E2E — PASS (scenario 4, models leg + H)

`/models/use` → 409 + approvalId → decide → re-issue → 200 → catalogue
shows the model current → same-DB restart keeps it (source `settings`).
No restart, no exposed credentials.

## COMMAND E2E — PASS (scenario 5 + browser /m/mo/pro/tools/skills/agents/mcp)

`/models /providers /tools /skills /agents /mcp` all 200 with live content
(259 seeded skills listed). Browser autocomplete filtering proven earlier
(scene F) on this exact tree.

## @AGENT E2E — PASS (scenario 6 + browser G)

`@rcc` parked with `agentRun.approvalId`; Allow-collect returned the
persona-authored reply. Policy applied throughout.

## @SKILL E2E — PASS (scenario 6)

`@deep-research` recorded in `invocation.skills`; its body reached the model
system prompt as guidance (DATA, not instructions).

## SESSION E2E — PASS (scenario 7 + browser B/E/H)

3 sessions × interleaved turns isolated and intact; active pointer switches;
reload restores; 12-route clickthrough + deep link green.

## AGENT E2E — PASS (scenario 8)

Create (201) → direct message park→collect → edit objective → reload keeps
edit → run yields persona-authored final (mock worker), not progress narration.

## PERFORMANCE

- stress (earlier, same tree): turn p50 11ms / p95 14ms; 150-turn write 1.5s,
  read 4ms; RSS +30MB.
- lag probe (this pass, `lag-probe.json`): input 15.6ms (<50), palette 16ms
  (<200), `/` filter 16.8ms (<100), `@` filter 16.8ms (<100), first-delta
  734ms (<3000), session roundtrip 87ms (<1000), route switch 39ms (<1000).
- Zero Core requests during typing: task tracking is in-turn server-side,
  provider discovery on demand. No regression from task-state updates.

## OPEN GHOST RENDERING CHECK

Structured markdown, streaming, code/highlight, tables, tool cards
(collapsed `⚙ Executed N tools`, waiting/failed stay open), approval cards,
TeX/diagrams paths unchanged — pinned by the 12-test rendering corpus
(unchanged, green) and 8 browser screenshots. KAI personality and look
unchanged.

## KNOWN LIMITATIONS

- Version strings read 0.1.1 (no bump cut); report names the candidate 0.1.2-RC.
- Remote MCP (http/sse) refused with reason; stdio only.
- OpenCode model catalogue not exposed by KAI's client (spec-drift risk).
- No per-request worker model override (spec allows, code absent).
- Verification is structural, not semantic: a fluent non-answer still passes.
- Synthesis adds one bounded model call per cut-off/empty tool turn.
- Installer unsigned → one SmartScreen click-through.
