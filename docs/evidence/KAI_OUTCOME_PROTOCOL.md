# KAI outcome protocol — evidence

## OpenBot audit (github.com/ashhart/OpenBot)

Cloned (shallow, 364 TS files) and audited per `docs/evidence/OPENBOT_KAI_AUDIT.md`.
23 mechanisms classified: **13 ALREADY EXISTS IN KAI**, **9 ADAPT**, **1 NOT
APPROPRIATE** (multi-bot floor — conflicts with KAI's single-speaker
constitution). Repo license **MIT**; bundled third-party: highlight.js
(BSD-3), marked (MIT), react/react-dom (MIT), electron (MIT), and **Synara**
(MIT, T3 Tools Inc.) which OpenBot adapted for its agent-CLI transport.

Provenance: KAI reused **no OpenBot source**. All adaptations are independent
reimplementations; the Synara-derived backend layer was NOT adopted (KAI's
provider registry already covers it), so no Synara notice is required.

## Implemented (tested)

`core/src/orchestration/outcome.ts` — Outcome Contract, Outcome Gate, Decision
Kernel, anti-loop signatures. `core/tests/orch-outcome.test.ts` **15/15**.
Scenarios proven: worker claim ≠ completion (B), tests pass but evidence absent
→ INSUFFICIENT_EVIDENCE (C), repeated failure → CHANGE_WORKER/REPLAN (D),
forbidden/denylist → CONTRADICTED (K), handoff depth ceiling → ASK_USER (H),
no-criteria → never PASS.

## Command streaming (prior, proven)

`core/scripts/command-stream-probe.mjs` PASS — real child process stdout at
49→974ms, stderr mid-stream, exit at 1301ms; output visible BEFORE exit
(C1–C7). `chatStream` dispatches per frame (live-ux-probe PASS, text at 283ms).

## Package

- COMMIT `f026b61b0790e93f1e91c9aa8a541f72481915f5`
- BUILD ID `e3e49045fdfb9e3b`
- KAI.EXE 5,089,792 bytes; installer 3,206,372 bytes
- `artifactMatchesSource: true`

## Tests

core 1084 pass / 2 fail (both `cua-real.test.ts` named-pipe env tests — the
cua-driver daemon is not running; unrelated to these changes) / 13 skipped;
app 297/0.

## THE OUTCOME GATE IS NOW AUTHORITATIVE (this task)

Completion path BEFORE: `orchestrator.completeFromReply` → `finishComplete` →
`board.complete` (state COMPLETED) gated only on `handoff.status==="ok"` plus
structural verification + review.

Completion path AFTER: same boundary, but `finishComplete` first evaluates
`OutcomeGate.evaluate(contract, observation)` and:
- **PASS** → `board.complete` (the ONLY route to COMPLETED).
- **FAIL / INSUFFICIENT_EVIDENCE / CONTRADICTED / UNKNOWN** → NOT completed;
  the Decision Kernel picks a bounded next action, emitted as safe
  `worker.progress` events (`phase: evaluation`, `phase: next_action`), and the
  mission stays open (CHANGES_REQUESTED for evidence/corrective actions,
  FAILED for a genuinely absent deliverable).

The Outcome Contract is persisted on the work item's `outputs.contract`, so a
resumed mission keeps its acceptance criteria + required evidence.

`board.complete` is called from exactly one place (`finishComplete`), so there
is no alternate completion path in the runtime.

### Proof (`tests/orch-gate-authority.test.ts`, 6/6)

- INVARIANT: worker "done" + tests pass + review PASS + structural verify pass
  but required evidence absent → **not COMPLETED** (INSUFFICIENT_EVIDENCE).
- POSITIVE: same with evidence present → COMPLETED.
- Alternate-path coverage: all other signals green simultaneously → still not
  COMPLETED.
- CONTRADICTED: forbidden outcome (force-push) → not COMPLETED.
- ANTI-LOOP: repeated gate failure → never completes + emits a next-action.
- RESUME: a new orchestrator over the same store keeps the contract; completes
  only once evidence is present.

## Honest limitations

- The Decision Kernel currently drives the gate-fail branch of the live loop
  (verified above); the fuller execution-aware kernel, DecisionProvider/JEV
  interface, execution-target abstraction (LOCAL_WINDOWS/BROWSER/REMOTE_*),
  Verified Routines, and the A/B benchmark are specified in
  `docs/architecture/KAI_EXECUTION_PROTOCOL.md` but not built. JEV is optional
  and not wired — the deterministic gate + kernel already guarantee the core
  invariant without it.
- Context fit-to-tokens and per-run process cancellation (OpenBot ADAPT items)
  not yet adopted.
- The 2 `cua-real.test.ts` failures are the cua-driver named-pipe daemon being
  absent (environment), reproduced and documented — not masked.

## Package (this task)

- COMMIT `4e2a58d5ad885ab3ce558742b39e0bd0854f8b72`
- BUILD ID `d372a760757992cd`
- KAI.EXE 5,089,792 bytes; installer 3,209,116 bytes
- `artifactMatchesSource: true`
- core 1090 pass / 2 fail (CUA env) / 13 skipped; app 297/0;
  command-stream PASS; live-ux PASS.
