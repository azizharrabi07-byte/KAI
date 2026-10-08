# KAI self-review — honest evaluation (§53)

Assessment of the autonomous-operator release (`1d190bb`), grounded in the
test evidence in this directory, not in praise. Every criticism cites a test
or a known architectural fact.

## STRENGTHS

- **Outcome-driven completion.** A mission completes only when the
  deliverable exists and verification passes; a tool call, a search, or a
  worker's "done" is not completion. Torture: false-completion rate **0.00**,
  completion rate **1.00** over 131 attempted missions (`torture.json`).
- **No babysitting for autonomous work.** Needs-continue rate **0** — no
  mission landed PAUSED awaiting a manual "continue" (`torture.json` §M).
- **Real isolation & scale.** 25 concurrent missions and 3-level nesting
  complete with no collisions; 100 sequential missions in ~7.8s; activity log
  stays bounded; RSS delta +17MB (`torture.json`).
- **Independent review loop.** Reviewer sees contract + artifact + evidence
  only (canary test proves no transcript leak); bounded CHANGES→PASS retry.
- **Value-per-cost routing.** An 80k-token success outscores a 20k-token
  failure; routing contrasts prove (difficult→DELEGATE_AND_REVIEW,
  simple→DELEGATE_ONE).
- **Honesty by construction.** No fabricated reasoning, metrics, or events;
  `/self-audit` reports only live state.

## WEAKNESSES

- **Chat turns do not auto-delegate.** The operator loop runs through
  missions, `/work`, and `@`; an ordinary chat message stays a single turn.
  A user who types a task into chat without `/work` gets answer-mode, not
  operator-mode. (Architectural fact; not yet bridged.)
- **Verification is structural, not semantic.** It checks deliverable +
  evidence + criteria + review verdict — a fluent wrong answer can pass. The
  false-completion metric measures the *structural* contract only.
- **No mid-flight preemption.** A worker running synchronously has no
  preemption point; `/abort` stops parked runs and reports honestly otherwise.
- **Reviewer is KAI's own model** in an independent context — independent
  input, same provider; not a second model.
- **Provider reasoning signals unwired** (setting exists; no provider field
  consumed), so PROVIDER_EXPOSED falls back to SUMMARY.

## FAILURE MODES

- A model that ignores HANDOFF FORMAT yields a thin handoff → routed to
  review; with review OFF it fails rather than completing (safe, but a good
  result could be rejected if the model won't emit evidence lines).
- Circuit breaker state is in-memory per process; a restart forgets
  consecutive-failure counters (the durable FAILED record survives).
- Bench sample counts start at zero; early routing leans on capability match
  and defaults until outcomes accumulate.

## USER FRICTION

- The minimal rail hides surfaces the user may expect to click; discovery
  depends on `/` and the palette. Deliberate (operator §21) but a first-run
  risk.
- Stop during a tool round settles what streamed but cannot un-run the tool.

## PERFORMANCE ISSUES

- None found in the measured paths: input 15.6ms, autocomplete ~17ms,
  session switch 87ms, route switch 39ms, zero Core requests while typing
  (`lag-probe.json`).
- Sequential mission throughput ~13/s under scripted instant model; a real
  model is the bottleneck, not the loop.

## ORCHESTRATION GAPS

- No cron/scheduled autonomous missions (the scheduler exists but is not
  wired to the operator loop).
- No resume of a RUNNING mission after a hard crash mid-worker (only parked
  approvals resume).

## DELEGATION GAPS

- Worker availability is presence-only; no capacity/queue model.
- PARALLELIZE requires the caller to pass independent subtasks; it does not
  infer them.

## PROMPT ENGINE GAPS

- Patterns are seeded by task type conceptually but the library ships empty;
  selection falls back to the built-in 13-section template until outcomes
  create patterns.
- No prompt A/B beyond use/success counts.

## MEMORY GAPS

- Worker memory isolation is by persona session; there is no per-worker
  long-term memory namespace beyond that.
- Forgetting bounds are honest but manual (skills cover the workflow).

## UX GAPS

- No diff view for review findings; findings are text.
- Activity VERBOSE shows details but there is no per-tool argument inspector
  beyond the event card payload.

## SAFETY GAPS

- The managed `kai-autonomy-delegate` rule authorizes `agents.run_task`
  broadly under AUTO; it is visible and reversible but not per-worker-scoped.
- Worker self-scoring is prevented, but a worker can still emit a misleading
  RESULT string that passes structural checks (see semantic verification).

## MISSING CAPABILITIES

- Scheduled missions; semantic verification; mid-flight cancel; remote MCP
  transport; provider-native reasoning display; multi-reviewer quorum.

## TOP 10 PRIORITIES

1. Bridge chat→operator: an ordinary task message can open a mission.
2. Semantic verification pass (second-model or rule-based deliverable checks).
3. Wire the scheduler to the operator loop for autonomous timed missions.
4. Crash-resume for RUNNING missions.
5. Per-worker scoping of the delegation allow rule.
6. Seed the prompt-pattern library; record A/B outcomes.
7. Provider reasoning signal ingestion.
8. Capacity-aware worker availability.
9. Review diff/artifact viewer in the inspector.
10. Extend the activity hot/warm/cold storage split explicitly.

## VERDICT

KAI today reliably drives **explicit** objectives to **structurally
verified** results without babysitting, and shows its work in real time. It
is not yet a fully autonomous chat-driven operator (priority 1) and its
verification is not yet semantic (priority 2). Those two are the honest
frontier.
