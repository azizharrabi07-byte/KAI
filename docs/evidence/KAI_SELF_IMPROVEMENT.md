# KAI Self-Improvement — skill learning, benchmarks, review loop, gates

## Skill learning

Two complementary paths, both gated:
1. Turn pipeline (`learning/`): classifies turns (correction, success,
   repeated workflow, recovery, explicit instruction) → memory writes or
   skill drafts → STAGED only, install needs human approval on exact bytes.
2. Orchestrator proposals (`orchestration/learn.ts`): success (≥3 verified
   steps), correction (before/after), recovery (failed-then-succeeded)
   patterns → candidate (title/trigger/method/tools/constraints) → staged
   via the same approval-bound pipeline. `/refine [session]` drafts a
   SKILL.md from a candidate through the model, validates, stages.
3. Updates: `versionNote` links lineage (`baseSkillId`); user-edited skills
   are never silently overwritten (registry is create-only; installs are
   revisions).

Autonomy gate: level ≥3 proposes; AUTO_SAFE at level 4 still stages (install
always needs approval). Metrics per skill (triggers/successes/verifications/
failures/corrections/tokens) feed the quality loop.

## Memory learning

Memory candidates pass redaction + bounds + the engine writer; provenance
preserved. Forgetting is bounded and explicit (see skill library).

## Worker benchmark updates

Every verified completion/failure records an outcome (quality derived from
verification + review verdict, difficulty-normalized, cost/latency/rework
penalized). Config changes reset profiles. Routing consumes the history;
rationales cite samples.

## Review loop

Independent reviewer (contract + artifact + evidence only), bounded rounds,
PASS/CHANGES_REQUESTED/BLOCKED; changes feed bounded retries with findings
as the next prompt; budgets terminate stubborn loops; breaker reassigns.

## Approval gates

Skill installs (sha-bound), delegation under ASK, reviews under ASK,
destructive/model/traffic changes — all park for humans. The managed
`kai-autonomy-delegate` rule (visible in GET /policy) is the single
user-configured exception, scoped to exactly `agents.run_task`, reversible
by changing autonomy.
