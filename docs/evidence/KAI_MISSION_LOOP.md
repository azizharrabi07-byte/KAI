# KAI Mission Loop — intent contracts, next-move, recovery, completion

## Intent contract (§7)

Every autonomous objective carries: objective, deliverable, constraints,
forbidden, success criteria, risk, budget (tool calls, runtime, retries,
cost, children, depth), deadline. Workers receive minimum context via the
prompt builder (MISSION/ROLE/OBJECTIVE/CONTEXT≤2000 chars/KNOWN/PREVIOUS/
CONSTRAINTS/SCOPE/OUTPUT/SUCCESS/VERIFICATION/BUDGET/HANDOFF) — never raw
histories. All fields redacted.

## The loop (§1, §11-12)

REQUEST → UNDERSTAND (analyze: type/difficulty/skills/tools/risk) → PLAN
(dispatch decision + rationale) → DECOMPOSE (bounded children) → SELECT
(benchmark-ranked, breaker-aware) → EXECUTE (policy-gated delegate) →
OBSERVE (heartbeats/progress) → VERIFY (structural: deliverable, evidence,
criteria) → REVIEW (independent, bounded) → RETRY/REASSIGN → SYNTHESIZE →
COMPLETE. Next-move evaluation after every report: done/blocked/insufficient/
wrong-direction/needs-verification/needs-review/needs-data → next action.
The user is never asked to say "continue" for ordinary execution.

## Recovery (§23, §56)

Failure classification → bounded retry (budget from autonomy) → breaker
(3 consecutive same-worker+type failures → reassign/change-strategy/ask/
block) → worker switch uses benchmark history. Handoff parse failures,
empty results, and blocked verdicts all terminate honestly (FAILED/BLOCKED
with reasons), never as silent stops.

## Completion contract (§54)

COMPLETE requires: objective satisfied (deliverable present), verification
passed (or independent PASS compensating thin checks, recorded), evidence
recorded, review verdict stored, risk declared. PAUSED/BLOCKED carry
completed-vs-remaining + recourse. Synthesizes with the existing task guard.

## Budgets & hierarchy (§19, §22, §51)

maxDepth (default 2, hard cap 5), maxParallel (3, cap 10), maxRetries,
runtime/token/cost budgets on intent; enforced at create/run/retry;
nested execution proven to 3 levels; 25 concurrent runs collision-free
(`orch-e2e.json` S5/S6).
