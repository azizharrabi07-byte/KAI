# KAI task completion + model control — report (§27)

## 1. Root cause of the premature-stop behavior

Reconstructed from the live transcript (`sess_musv974c_7dhj`, read-only) plus
the turn-path audit. The user asked *"check ur files and tell me what is done
well and what is not"*. KAI streamed progress narration across **24 tool
calls**, then the turn ended with more narration (*"Identity layer is
thorough. Now the runtime surface…"*) — no verdict. After *"yes do it"* the
same shape repeated (24 calls, ends mid-audit). Two structural defects:

1. **No synthesis enforcement.** `brain.respond/stream` stopped at the tool
   budget (or an empty final round) and returned the last preamble verbatim;
   the router and both server handlers persisted and sent it as the answer.
   A tool execution was indistinguishable from completion everywhere.
2. **No objective retention.** Nothing persisted the original request, the
   plan, or progress. The second attempt re-did state+tree instead of
   continuing to the verdict — "continue" restarted generic searching.

## 2. Task lifecycle implementation

`core/src/chat/tasks.ts` (tracker) + `core/src/chat/turns.ts` (shared turn
orchestrator used by the router AND the stream handler) + `tasks` table
(schema v2). States: RECEIVED → UNDERSTANDING → PLANNING → EXECUTING →
VERIFYING → SYNTHESIZING → COMPLETED; failure path EXECUTING → BLOCKED /
PAUSED (+ explanation). Every turn opens (a new objective supersedes, never
silently drops) or resumes a task; steps, pending tools, verification and
synthesis records persist in SQLite and survive restarts.

## 3. Completion verification implementation

`finishTurn`: COMPLETED requires the deliverable — the synthesis guard's
closing text, or non-empty text with nothing pending. Progress narration cut
off mid-work (budget hit, calls pending, no synthesis) is NOT a deliverable:
the task pauses and the reply is the pause message. Verification records
(deliverable present? pending empty? synthesized? budget hit?) persist on the
task. Brain failure marks BLOCKED with the existing honest failure reply.

## 4. Continuation behavior

`isContinueText` ("continue", "go on", "yes do it", … — short messages only;
"yes do that" and long texts are NOT continuations). With an open task,
`beginTurn` resumes: the brain receives the resume prompt (objective +
completed steps not to repeat + pending calls + missing deliverable) with the
objective passed explicitly. Without one, the turn is normal. PAUSED and
BLOCKED tasks stay resumable across restarts (only COMPLETED/SUPERSEDED are
terminal).

## 5. Progress-vs-final-response behavior

Streaming still narrates concisely via the live status line
(`describeToolActivity`) and real tool events. On settle, successful tool
cards collapse into one `⚙ Executed N tools · …` block; waiting (`…`) and
failed (`✕`) cards stay open; approval cards are never collapsed. The final
message carries the deliverable (or the pause message) — progress preambles
are working-turn content, never the answer.

## 6. /models implementation

Reads `runtime.providers` live: per provider the catalogue with the active
model marked, or the honest note when no catalogue exists. `/models use
<model>` rides the policy-gated `settings.update` tool — it parks, and
approving the parked request switches the model. Worker selection is refused
(400), not faked.

## 7. /providers implementation

Live rows: READY / REACHABLE-not-authorized / OFFLINE + reason, base URL,
auth configured/not (never values), current model (KAI) or catalogue/note
(workers), version, latency. `test <id>` points at Settings → Test (same
probe) or `GET /providers/:id/test`.

## 8. Settings provider/model controls

Settings page Providers area: one row per provider (state, endpoint, auth,
version, latency), Test button with CONNECTED/FAILED toasts, KAI model
`<select>` from the live catalogue (change → park-or-apply with toasts),
worker models listed-not-selectable with the reason stated, and a credentials
note (KAI key: env/file; Hermes key: OS store via the settings window).

## 9. Credential handling

No secret value enters the provider registry, routes, commands, UI text, or
the database settings table. KAI key: env → KAI_HOME file (presence only).
Hermes key: app-injected env → `~/.hermes/.env` (presence only). OpenCode
password: env only (same as the adapter uses). UI shows
configured/not-configured/authorized states from live probes.

## 10. Live provider/model switching proof

`task-completion.test.ts` H over live HTTP: `/models/use` → 409 +
approvalId → decide → re-issue → 200 → `/models` shows the model current →
restart on the same DB → still active with source `settings`. No restart
anywhere in the sequence.

## 11. OpenGhost rendering/writing audit

New `guidance` prompt section (instruction, stable, never trimmed):
result-first, evidence-after, progress-narration-never-the-answer, structure
for long answers (natural, not forced), raw dumps forbidden, unfinished work
stated plainly. No branding/personality/UI changes. Rendering corpus
(12 tests) re-verified unchanged.

## 12. Example before/after

Before (live transcript): *"Identity layer is thorough. Now the runtime
surface, chat/relay, and session layer…"* + 24 tool cards + silence.
After (same budget cut, test D1): *"## Result — Searched the workspace:
session-loader.txt holds the loader. Verdict: it drops tool records — that
is the bug."* + collapsed `⚙ Executed N tools` + named remainder. When
nothing could be produced: *"Task paused because the execution budget was
reached. Completed: …. Remaining: …. Say continue and I'll pick up…"*.

## 13. Tests

`task-completion.test.ts` (10): continue-text classification; A
search→inspect→explain; B exact quote; C structured comparison; D1
synthesis-delivers; D2 honest pause; E resume-from-prompt; F restart
persistence; G registry honesty; H live switch proof. Contract updates:
prompt section pins, storage table list, `/models`+`/providers` command
assertions.

## 14. E2E results

Browser scenes A–I, 33/33 PASS (fresh `browser-repro.json`): `/models`
lists the live registry, `/providers` lists live state incl. Hermes,
Settings shows Model + Providers areas (`shot-settings-providers.png`),
"continue" with no open task is an uncorrupted normal turn. A `replaceWith`
hierarchy bug in the new tool-collapse (caught by scene C, fixed, re-proven)
is the only regression the harness caught. Full suites: core 971/0, app
297/0, typechecks clean.

## 15. Remaining limitations

- OpenCode model catalogue not exposed by KAI's client (spec-drift risk) —
  reported, not faked.
- No per-request worker model override exists in KAI (spec allows, code
  absent) — worker selection refused honestly.
- Verification is structural (deliverable present, nothing pending,
  synthesis ran), not semantic: a fluent non-answer still passes.
- Synthesis adds one model call per tool-using turn that ends empty or
  budget-cut (bounded, no recursion).
- Remote MCP transport still unimplemented (unchanged).
