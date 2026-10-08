# KAI live operator UX — real-time streaming fix

## The defect (found, not assumed)

Empirical probe (`core/scripts/live-ux-probe.mjs`) proved the UI rendered the
whole turn at once. Isolation showed the Core SSE streamed perfectly
(deltas at 272/707/908ms, tool event 493ms) and the **browser** received
frames incrementally (203→1016ms) — so the buffering was in the app:
`core/kai-core.ts` `chatStream` read the ENTIRE response body into a
`frames[]` array, then dispatched every frame after the stream closed. That is
exactly "collect everything → show everything at the end", at the transport
layer. Tool cards appeared live only because they also arrive on the Core bus
(SSE), masking the chat-stream buffering.

## The fix

- `chatStream` now dispatches each SSE frame the instant it is parsed (delta →
  `onDelta`, `tool_event` → `onToolEvent`, `done` → terminal), breaking on the
  terminal frame. One file, one loop.
- `presence.ts`: `renderTurns` no longer rebuilds the thread while a turn is
  streaming (`streamLive` guard), and `refreshActive` no longer reloads history
  mid-turn — both previously wiped the in-progress live bubble.
- Real Core-URL override added (`window.__KAI_CORE_BASE_URL__`) so the shell can
  point at an isolated Core — enables true-streaming tests without a proxy that
  buffers.

## Event / part model (KAI-native)

The live timeline is typed by kind: text (streamed deltas), tool (created→
running→done via `tool_event`), operator events (worker/review/delegation/
benchmark) surfaced in `#kp-actstrip` as they arrive, and the final
synthesized answer. Order is real arrival order; nothing is sorted or grouped
post-hoc. Core bus events carry `missionId`/`stepId`; tool records carry
`toolCallId`/`invocationId`; the operator emits run/worker ids — dedupe by id.

## Proven result (staggered scripted events)

`live-ux-probe.json` PASS — text first appears at **283ms**, grows at 463ms
(tool cards at 649ms), final at **933ms**. Three distinct text states captured.
Event→UI latency: p50 **283ms**, p95 **649ms** (both include the scripted
model's 150ms/frame spacing, so the UI is effectively immediate).

## Streaming path

- Assistant text: token-by-token (deltas dispatched live).
- Tools: card on `tool_start`, terminal on `tool_done`/`error`/`approval_required`.
- Operator (worker/review/delegation/benchmark): live strip + activity route.
- Commands/skills/MCP: surfaced via their real events (tool/operator kinds);
  the operator's own vocabulary (`worker.*`, `review.*`) is emitted live.

## Copy / edit / stop

Copy on every assistant message; Edit refills the composer without mutating
history; Stop + `Ctrl/Cmd+Shift+S` abort the stream (settle says "Stopped").
Details toggle: activity COMPACT/VERBOSE + `/details` exposure.

## OpenCode mechanisms audited

Interaction model only (no code copied): typed message parts (text/tool/
reasoning/step), live event-stream updates, visible tool lifecycle, streamed
command output, abort, compact-vs-detail inspection. KAI keeps its own
runtime, message model, and character.

## Tests

- `live-ux-probe.mjs` PASS (key test §32).
- app 297/0, core 1071/0 (prior), browser A–K PASS, torture PASS.

## Package

- SOURCE COMMIT: `e56260bcaa46ceacbb74dc132676d62d479cf0a9`
- BUILD ID: `abf81a6c4e9c8eee`
- KAI.EXE: 5,089,792 bytes @ 2026-10-08 08:17:05
- INSTALLER: `app/release/KAI-Windows-0.1.1-setup.exe` — 3,201,285 bytes @ 08:17:05
- ARTIFACT MATCH: `artifactMatchesSource: true`, `freshness: fresh`
- SMOKE: bundle boots (identity fresh), `kai.exe` launches live.

## Screenshots

`docs/evidence/browser-shots/` (operator chrome, bench, inspector, mission,
activity). The live-ux probe also captures `live-ux.png` of the mid-stream state.

## Remaining limitations

- Command output is surfaced through tool/operator events; a dedicated
  per-command ANSI stdout stream would require the runtime to emit
  command-chunk events (not present) — reported, not faked.
- Provider-native reasoning signals still unwired (SUMMARY level only).
- Chat→operator auto-bridging and semantic verification remain the frontier
  (unchanged this turn).
