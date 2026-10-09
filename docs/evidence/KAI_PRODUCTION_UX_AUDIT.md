# KAI Production UX Audit (baseline, 2026-10-08)

Repo: local `C:\Users\DELL\Desktop\kai`, branch `master`, commit `2eed852`, tree clean.
Public: `https://github.com/azizharrabi07-byte/KAI`, branch `main`, 1 snapshot commit (`9c6ec3f`).
Do not reset local `master`; public `main` grows by new commits only, never force-push.

## Traced production paths

- Tauri entry → `app/src/shell/shell.ts:mountShell` → `mountPresence` (`app/src/shell/presence/presence.ts:144`).
- Turn: `runTurn` (presence.ts:976) → `client.chatStream` (kai-core.ts:2210) → Core `/chat/stream` (server.ts) → brain `respond` → model + tool plane → SSE `delta` / `tool_event` / `done` frames → `onDelta`/`onToolEvent` handlers.
- `views/chat.ts` (imports StreamView + Markdown) is **not mounted anywhere** — dead production path; only presence renders.
- Mission step: `missions/executor.ts:runSteps` → runtime `rawRunner` (runtime.ts:2198) → `tools.invoke(step.target, …)`.

## Verified findings

**A. Main window uses plain-text rendering.** `bubbleTurn` (presence.ts:675) renders assistant text into `p.textContent`; live deltas set `liveBubble.textContent` (1053). `StreamView` (`app/src/chat/vendor/stream-view.ts`: `new StreamView(root)`, `.push(fullSource)`, `.finish()`) and `Markdown.blocks` exist but are only referenced by the unmounted `views/chat.ts:343` — and even there with the final text, not incrementally.

**B. Tool results stripped from live frames.** server.ts:901-906 destructures `result` out of `tool_event` before SSE. Results only arrive in the terminal `done.toolCalls` frame (server.ts:855-871). `toolCard` (presence.ts:640) renders summary only, no body; successful cards collapse by default.

**C. Scroll churn + wrong target.** `threadEl.scrollTo({smooth})` on nearly every delta/event (presence.ts:601, 699, 743, 786, 892, 924, 1010, 1054, 1076, 3293, 3629). Command follow-tail scrolls `card.el` while the scrollable output is `card.out` (3644-3645).

**D. Workers: Hermes reachable, OpenCode refused.** Live (2026-10-08): Hermes `:8642/health` → ok; OpenCode `:4096/global/health` → connection refused; Core `/health` → `degraded` (`opencode.upstream_unreachable`). No launch/recovery code in `opencode.ts` / `adapters/opencodeAdapter.ts`. Model default tool set is READ-only (`model-plane.ts:126-129`); `agents.run_task` (EXTERNAL) is correctly not in it.

**E. No cancellation in exec.** `workspace.ts:exec` (518) has timeout-only `child.kill()` (single process, not a tree) and no AbortSignal. Server-side SSE disconnect does not reach the child.

**F. memory.write scope (Phase 10).** Mission step `{target:"memory.write", input:{content,type}}` (no scope) fails in `resolveMemoryScope` (runtime.ts:2937-2940) with `SCOPE_VIOLATION: memory scope must be one of …`. Root causes: (1) the `memory.write` tool `validate` (runtime.ts:725) accepts any object and never mentions scope; (2) the mission runner never injects the mission's own scope even though it knows `mission.id`. Evidence: `docs/evidence/live/missions.json:1889-1919` (step marked COMPLETED with `output.ok:false` — also a settle-honesty defect to verify against current executor).

## Plan (no second UI, no isolated-test theatre)

1. Core: bounded redacted `resultPreview` in live `tool_event` frames (new contract, correlated by invocationId).
2. Core: AbortSignal through run → brain → `tools.invoke` → `exec`/`shellRun`, Windows process-tree kill, `command.exit{cancelled}` + no further events; explicit stop route.
3. Core: strict `memory.write` scope validation + runner injects `mission` scope for mission steps; tests for valid/missing/malformed/mission scopes.
4. App: wire StreamView incrementally into presence live + settled rendering; timeline cards with real bodies (tool preview, command stdout/stderr, worker/verify/next-action); single canonical reducer keyed by real ids; scroll manager (near-bottom follow, rAF batch, Jump-to-latest, correct targets, caps); operator layout per reference skeleton in the SAME shell.
5. Routing: chat intent → orchestrator via existing mission/delegation protocols; honest worker status in header; OpenCode blocker event with alternatives, never fabricated completion.
6. Proof: production-path harness scenarios, full suites, Windows package + smoke test, publish to public `main` (append, no force), STATUS.md updated to the shipped commit.

## What the live runs found and fixed (2026-10-09)

Three production bugs surfaced ONLY under the real main window + isolated Core —
none were visible to unit tests:

1. **Fold blindness past 20 events (critical).** The timeline cursor was
   `slice(0, len - cursor)` over a newest-first ring capped at
   `CORE_EVENT_LIMIT = 20`. Once full, length pins and the cursor goes
   permanently blind: every later live update (command output, exits, turns)
   silently never folds. Fixed with ID-based tracking (seen-ids + WeakSet),
   oldest-first rendering, per-row guards, and an always-advancing cursor.
   Proven by scenario D (exit stamped) after failing without it.
2. **Stale history wipes the just-settled turn.** `loadHistory` blindly replaced
   local turns with server snapshots; a snapshot predating a settle wiped the
   visible answer (and its failure card) with no trace. Fixed: session-switch
   replaces; same-session refresh adopts only snapshots that caught up, else
   keeps local truth. `refreshActive` got a generation guard + no-wipe under
   in-flight turns.
3. **Abort watched the wrong socket end.** Server cancellation listened only to
   `req` close, which misses aborts whose request body was already consumed —
   runs finished into the void (task COMPLETED after Stop). Fixed by watching
   `res` close too; the brain loop now checks the run flag between rounds AND
   mid-text. Stop → task CANCELLED proven in-process, with a real
   `taskkill /T /F` tree-kill proof (`tools-cancel.test.ts`).

Also fixed along the way: `fresh.reverse()` in-place ordering, command
follow-tail targeting `card.out` (not `card.el`), O(n²) output-cap scan,
Stop-then-plain-fallback re-send, client TIMEOUT-vs-user-abort lie, and the
scripted-harness round counter that once claimed "both tools ran" after one
(the timeline showed the truth: one card).
