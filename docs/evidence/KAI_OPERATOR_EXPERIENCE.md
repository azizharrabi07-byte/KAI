# KAI operator experience — this phase

Evolves the proven operator foundation (loop, prompt engine, bench, routing,
review, trace, learning, autonomy) into the KAI experience: real-time, command-
first, character-led, minimal-surface, with honest metrics.

## Real-time activity (no end-of-task dump)

Two live channels already carried real state and remain: Core bus events fan
out over `/core/events` (SSE) into the workspace slice and render live in the
Activity route + drawer; the streamed turn's `tool_event` frames paint tool
cards as they execute, and assistant text streams token-by-token. This phase
kept that and added the operator event vocabulary (`worker.*`, `review.*`,
`delegation.routed`, `benchmark.updated`) so mission work streams as it
happens. Bounded `activity_log` (2000 cap) backs later inspection.

## Command-first control (§18/§19/§45)

New commands, all live from the real registry (no hardcoded duplicate list):
`/work`, `/status`, `/tasks`, `/runs`, `/bench`, `/workers`, `/activity`,
`/reasoning`, `/abort`, `/self-audit` — joining `/new /compress /models
/providers /tools /skills /agents /mcp /memory /session /plan /refine /review
/help`. `/` and `@` palettes read `GET /commands` and live agents+skills.

## Minimal permanent surface (§21/§54)

The rail is now **KAI · Sessions · Agents · Settings**. Every other surface
(missions, workers, tools, mcp, activity, memory, skills, home) stays a real,
deep-linkable route reached by `/`, the palette (`nav.*`), or a `#/route`
link — never a permanent tab. Proven in browser scene H (rail = exactly four;
all contextual routes reachable by hash and report truthfully).

## Character is the main character (§23/§55)

The workspace uses the REAL KAI character engine (`mountCharacterCanvas` →
`KaiEngine` via `createOrb`): the rail orb, the chat header (`who`), and the
hero are the same engine, state-driven by the shared `kaiCharacter` machine
from real runtime events. No second engine, no generic placeholder.

## Output quality + controls (§26/§29/§30/§31/§33)

- Result-first `guidance` prompt section (unchanged) + synthesis guard.
- **Stop** on the working card + `Ctrl/Cmd+Shift+S`: real stream abort; the
  settle path says "Stopped" honestly (no fake instant halt).
- **Copy** on every assistant message; tool cards remain inspectable.
- **Edit**: a user bubble refills the composer for revise-and-resend without
  mutating completed history.
- Shortcuts: `/`, `@`, `Ctrl/Cmd+K`, `Enter`, `Shift+Enter`, `Ctrl/Cmd+
  Shift+Enter` (plan-only), `Esc` — listed in `/help`.

## Honest metrics (§52)

`core/scripts/torture.mjs` → `torture.json`: completion rate **1.00**,
false-completion **0.00**, needs-continue **0**, orphan in-flight tasks
**0**, memory delta **+17MB**, 100 sequential ~7.8s, 25 concurrent ~1.9s,
3-level nesting, breaker→replacement, review loop, approval resume.

## Self-improvement visibility (§39)

Benchmark updates (`benchmark.updated`), reviews (`review.decided`), and skill
usage counters emit real events surfaced in worker/review activity groups.
`/refine` proposes skills; `/self-audit` reports live state.

## Honest self-evaluation

`KAI_SELF_REVIEW.md`: strengths, weaknesses, failure modes, and a ranked top-10
— each grounded in test evidence or a stated architectural fact. The two
honest frontier items: chat→operator bridging, and semantic (not just
structural) verification.
