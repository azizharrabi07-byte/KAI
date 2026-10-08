# KAI Autonomous Operator — final report

## ARCHITECTURE

One orchestrator (`core/src/orchestration/orchestrator.ts`) composes board,
bench, dispatch, prompts, review, trace, learn over the existing missions,
tasks, workforce, approvals, events, policy, and skills systems. Nothing was
rebuilt: the mission executor, chat task lifecycle, tool boundary, and policy
engine are untouched and all green. Hermes (MIT, mechanisms only, zero code/
identity/prompt copying) informed 14 adaptations; the audit is
`HERMES_KAI_ORCHESTRATION_AUDIT.md`.

## MISSION LOOP

Intent contracts (objective/deliverable/constraints/forbidden/criteria/risk/
budget) → analyze → dispatch → bounded children → policy-gated delegate →
heartbeat → structured handoff → structural verify → independent review →
bounded retry/reassign → bench update → COMPLETE. Next-move evaluation after
every report. Pause/block carry completed-vs-remaining + recourse.

## PROMPT ENGINE

13-section worker prompts from declared fields only (no histories, all
redacted, context capped); pattern library with measured uses/successes;
outcomes recorded per delegation. E2E proves failure context reaches retry
prompts.

## WORKER BENCH

Measured per-domain profiles, config-version isolation, frozen value formula
(quality×verification×completion×review, difficulty-normalized, cost/latency/
rework/failure/safety penalized — value per cost, never token-count).
Confidence by sample count, short-horizon trend, cold-start baselines.
Live: bad=0.10 vs good=0.45 on real outcomes; 60+ stress samples accumulate.

## WORKER ROUTING

Capability match → value → latency → risk; DO_IT_SELF/DELEGATE_ONE/
PARALLELIZE/DELEGATE_AND_REVIEW/ASK_USER/CHANGE_WORKER with structured
rationales. Proven: difficult→DELEGATE_AND_REVIEW, simple→DELEGATE_ONE;
breaker reassigns after 3 consecutive failures.

## SKILL LEARNING

Turn pipeline + orchestrator proposals (success/correction/recovery) →
validate → stage → human approval → install; version lineage; per-skill
metrics updated from verified outcomes (success and failure paths). 8 new
KAI-authored workflow skills ship (see MUSE_SKILLS_KAI_ADAPTATION.md).

## ACTIVITY TRACE

Compact status units from real emissions; OFF/COMPACT/VERBOSE + HIDDEN/
SUMMARY reasoning; bounded `activity_log` (2000 cap); SSE fan-out;
grouped Activity route; per-item inspector. Lag probe: all interactions
15–87ms, zero Core requests while typing.

## REASONING VISIBILITY

HIDDEN drops, SUMMARY stores quiet rows; PROVIDER_EXPOSED retained with no
provider signal wired yet (no fake content — falls back to summary level).

## AUTONOMY LEVELS

0 Advisor / 1 Delegator / 2 Operator / 3 Guardian / 4 Autonomous + per-dimension
AUTO/ASK/OFF + budgets + retention, persisted, live. Managed
`kai-autonomy-delegate` rule (visible in GET /policy) authorizes reversible
delegation at AUTO; irreversible/high-risk always park via the engine.

## COST OPTIMIZATION

Budgets on intent (tools/runtime/retries/cost/children/depth) enforced at
create/run/retry; value-per-cost routing; token accounting where reported,
UNKNOWN otherwise (never fabricated).

## FAILURE RECOVERY

Classification → bounded retry → breaker (reassign/change-strategy/ask/block)
→ worker switch → prompt carries failure context. Approval rejections cancel;
expiry handled by existing sweeps; restarts resume WAITING items by persisted
approval linkage.

## REVIEW SYSTEM

Independent reviewer (contract+artifact+evidence only), bounded rounds,
PASS/CHANGES_REQUESTED/BLOCKED; changes feed one bounded retry with findings
as the next prompt; verdicts persist on items; ASK parks for humans.

## E2E RESULTS (`orch-e2e.json`, 21 checks PASS)

Full loop with children/review/bench/trace; breaker→switch; routing
contrast; prompt improvement; 10 + 25 parallel collision-free; review loop;
bounded log; 50 sequential tasks; 3-level nesting. Browser A–J (44 checks):
orchestrated run in-page, Bench + inspector + Autonomy + Activity +
mission inspector all render live state.

## STRESS RESULTS

25 concurrent runs, 50 sequential, nested 3-level, review loops, failures —
no collisions, no loss, no leakage, no runaway (depth/children/retry caps),
activity bounded. Long-running liveness: heartbeats at milestones (workforce
has no mid-flight preemption channel — documented limit).

## FILES CHANGED

`orchestration/` (13 modules), schema v3 + 5 stores, settings orchestration
keys, runtime wiring, 7 routes, 2 commands, app client + Workers/Missions/
Settings/Activity surfaces, 9 orch test files, 4 scripts, 7 evidence docs.

## COMMITS

Foundation → core → wiring → routes/commands → E2E/fixes → UI → verification
(one concern each; tree clean at every step).

## REMAINING LIMITATIONS

1. Chat turns do not auto-delegate (explicit missions/commands only) — the
   autonomous loop is mission-scoped by default.
2. Verification is structural, not semantic.
3. No mid-flight worker preemption (workforce limit); cancel covers parked runs.
4. Provider reasoning signals unwired (setting retained).
5. Reviewer is KAI's own model (independent context, same provider).
6. Remote MCP transport still unimplemented (unchanged).
7. Cold-start baselines are descriptors until first outcomes land.
