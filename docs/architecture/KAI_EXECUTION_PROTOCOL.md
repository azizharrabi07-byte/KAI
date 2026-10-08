# KAI Execution Protocol

The runtime contract that keeps KAI moving toward the user's ACTUAL outcome
instead of producing activity. Extends the existing operator loop; it does not
replace it. Mechanisms informed by an OpenBot audit
(`docs/evidence/OPENBOT_KAI_AUDIT.md`) — independently reimplemented for KAI.

## Flow

```
USER
 → OUTCOME CONTRACT      (the stable truth of the mission)
 → KAI DOER              (orchestrator: understand/plan/prompt/delegate)
 → DECISION KERNEL       (bounded next action; never executes)
 → KAI GUARD             (policy → permission → approval)
 → WORKERS               (execute only through policy-governed paths)
 → OBSERVATION           (what the runtime measured)
 → EVIDENCE              (inspectable/independently citable)
 → VERIFICATION          (structural + review; worker claims never trusted)
 → OUTCOME GATE          (PASS | FAIL | INSUFFICIENT_EVIDENCE | CONTRADICTED | UNKNOWN)
 → NEXT ACTION           (kernel) or COMPLETE
```

## Outcome Contract

`createOutcomeContract` (`core/src/orchestration/outcome.ts`) records
missionId, originalIntent, normalizedObjective, deliverables, constraints,
acceptanceCriteria, requiredEvidence, forbiddenOutcomes, authorityScope,
budgets, retryPolicy, completionPolicy, verificationPolicy. It is the stable
truth: a worker cannot rewrite it, and KAI cannot silently weaken it because a
worker failed.

## Claim vs Observation vs Evidence

- CLAIM — what the worker said (`WorkerHandoff.result/evidence`, advisory).
- OBSERVATION — what the runtime measured (verification checks, review).
- EVIDENCE — what can be inspected/cited.

Only OBSERVATION + EVIDENCE feed `evaluateOutcome`. A worker claim is never
promoted to mission truth.

## Outcome Gate

`evaluateOutcome(contract, observation)`. PASS is the ONLY result that permits
COMPLETED. Deterministic: forbidden-outcome/denylist → CONTRADICTED; unresolved
blockers or no deliverable → FAIL; unmet criteria or missing required evidence →
INSUFFICIENT_EVIDENCE; no criteria → UNKNOWN. The model may recommend; the
runtime decides.

## Decision Kernel

`decideNext(input)` returns ONE bounded action — DO_IT_SELF, DELEGATE_ONE,
PARALLELIZE, RUN_TESTS, INSPECT, VERIFY, RETRY, CHANGE_WORKER, REPLAN,
ASK_USER, STOP, COMPLETE — with a reason. It never executes; the orchestrator
sends the action through Guard first.

## Loop prevention

Signatures: `actionSignature(action, workerId, input)`, `failureSignature`,
and progress streaks. Rules: NO_PROGRESS×N → REPLAN; SAME_FAILURE×N →
CHANGE_WORKER (or REPLAN without an alternative); SAME_WORKER_FAILURES×N →
CHANGE_WORKER; DEPTH ceiling → ASK_USER. KAI never loops indefinitely.

## Human escalation

ASK_USER is a first-class action, used only after autonomous options are
exhausted: ambiguity, conflicting outcomes, unobtainable evidence, authority
exceeded, irreversible judgment, repeated strategy failure, unclear scope.

## Task lifecycle

QUEUED → RUNNING → WAITING → COMPLETED / FAILED / CANCELLED / BLOCKED, persisted
on the work board (`work_items`) with missionId/workerId/objective/criteria/
status/timestamps/result/evidence/failure/parentTaskId.

## Delegation rules

Explicit parent/child links (`parentId`), depth/parent/parallel/retry ceilings,
reason recorded per handoff (rationale on `delegation.routed`).

## Evidence lifecycle

Verification records criteria + met flags; review verdicts persist on the work
item; the OutcomeGate consumes both. Evidence is cited by locator, never pasted
wholesale.

## Authority boundaries

Outcome Contract `authorityScope` + `forbiddenOutcomes` + the policy engine's
deny-first evaluation. A worker doing work outside authority is refused by Guard
(unchanged). Missing capability fails closed — no silent downgrade of execution
target.

## JEV / decision providers

**JEV is optional. KAI is not dependent on JEV for correctness, execution,
verification, or completion.**

The `DecisionProvider` boundary (`core/src/orchestration/decision.ts`) is
shipped. Deterministic is the DEFAULT: `createDeterministicDecisionProvider()`
simply echoes the Decision Kernel. A JEV-style provider is a plug-in point that
is OFF and unavailable by default (`createUnavailableJevProvider()` returns no
opinion) — no dependency, no network, nothing to install.

A provider may only RANK/RECOMMEND among candidate actions the deterministic
layer already deemed legal. Every recommendation is re-validated before use:

- it must be one of the legal corrective candidates;
- it can never recommend `COMPLETE` to bypass the Outcome Gate;
- low confidence (`< minDecisionValue`) is rejected;
- a provider that throws, times out, or returns malformed output is ignored.

Escalation hierarchy: LEVEL 0 deterministic → LEVEL 1 Decision Kernel →
LEVEL 2 optional JEV → LEVEL 3 optional frontier model → LEVEL 4 ASK_USER.
Hard decisions never escalate (deny/forbidden, gate PASS, a single candidate,
the loop breaker, bounded depth). A cost-aware policy
(`shouldConsultProvider`) plus a budget (`maxCallsPerMission`, `maxCallsPerTurn`,
`maxCostPerMission`, `cooldownMs`) bounds invocation; budget exhaustion falls
back to deterministic — the mission is never failed for lacking JEV. When a
provider is actually used, a live `decision.provider_used` event is emitted.

Settings: `orchestration.decision` = `deterministic` (default) or
`deterministic+jev`; `orchestration.jevMaxCalls`.

## What is shipped vs planned

Shipped and tested: the Outcome Contract, Outcome Gate, Decision Kernel,
anti-loop signatures/limits, deny/forbidden checks (`tests/orch-outcome.test.ts`,
15/15); the Outcome Gate wired into the live completion path so `COMPLETED` is
impossible without `OutcomeGate = PASS` (`tests/orch-gate-authority.test.ts`,
6/6); and the optional `DecisionProvider` boundary with a deterministic default
that cannot be bypassed (`tests/orch-decision-provider.test.ts`, 10/10).
**Planned:** a real JEV implementation, the execution-target abstraction, and
the A/B benchmark. They are specified here so the wiring is a bounded follow-up;
until then the deterministic kernel, Outcome Gate, Guard and the orchestrator's
circuit breaker remain authoritative.
