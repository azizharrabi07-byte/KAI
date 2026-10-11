# Adoption Decisions

One row per capability KAI has decided about, with the evidence and the test that
proves the decision was implemented. A decision with no test is an intention.

## Decided (evidence-backed, implemented in this branch)

| # | Capability | Source | Decision | Why | Proof |
|---|---|---|---|---|---|
| 1 | **Criterion settlement paths** — a criterion must be settleable or the plan is refused | KAI's own live run (a planner produced "the final report states that all tests passed") | **Reimplement natively** | The defect was found by running KAI, not by reading a donor. No donor was needed. | `core/tests/goal-criteria.test.ts` — the exact prose criterion is refused, naming the way to rewrite it |
| 2 | **Human-review criteria** — a judgement call parks the goal and settles only on a recorded decision | same live run | **Reimplement natively** | A person's decision is a first-class, attributed outcome, distinct from anything KAI observed | `goal-criteria.test.ts` — parks `WAITING_USER` with the question; MET settles, FAILED blocks |
| 3 | **Positive test counts** — a zero exit code is not proof tests ran | KAI's live Goal Challenger (it verified on this host that `node --test` exits 0 with zero tests) | **Reimplement natively** | The challenger's objection was correct and pointed at a real hole in the gate | `core/tests/orch-test-verification.test.ts` — vacuous, `no test files`, unestablished and failing runs all REFUSED |
| 4 | **Workspace proof before dispatch** — the artifact must not pre-exist and must not escape the authorized root | KAI's live challenger (stale `journey.txt` files; `C:/tmp` vs `/tmp` namespace confusion) | **Reimplement natively** | A leftover file must never satisfy a new goal | `goal-criteria.test.ts` — stale artifact refused, traversal refused, missing root refused, and the proof runs ONCE so retries are not blocked |
| 5 | **Direct presence verification** — `file present:` is checked by KAI, not by the worker's claim | KAI's live run (the worker created the file, yet `file present:` stayed unmet because its handoff named something else) | **Reimplement natively** | Presence must not depend on the worker's honesty, exactly like content | `goal-criteria.test.ts` + the live run showing both criteria MET with `kai-observed` records |
| 6 | **Every plan-level criterion is task-owned** | KAI's live run (the model added a plan-level criterion no task carried; it could never be settled) | **Reimplement natively** | The gate runs the checks an ITEM requires, so an unowned criterion is unsettleable | `goal-criteria.test.ts` — an unclaimed plan-level criterion is assigned to a task with a verification method |
| 7 | **Fail-closed authorization** | KAI's own audit (a Core with no credential allowed every owner route) | **Reimplement natively** | A normal autonomous installation must not run with its owner controls open | `core/tests/api-authz.test.ts` — all 141 routes classified; a Core with no credential refuses owner routes |
| 8 | **REA as a development-time instrument** | `morluto/rea` (MIT, 6.4.0) | **Adopt as a tool** (not a runtime dependency) | It answers questions source cannot, for compiled/opaque targets; KAI must not need it to run | `docs/research/REA_DONOR_WORKFLOW.md`; registered with a scoped, backed-up change |
| 9 | **Codex worker** | KAI's own adapter work | **Adopt as an external worker** | It was implemented and contract-tested but never registered — dead code | `core/src/agents/adapters/codex.test.ts` (17 pass, 2 named skips: CLI absent) |

## Decided (no adoption)

| # | Capability | Source | Decision | Why |
|---|---|---|---|---|
| 10 | Coucou event pipeline | `Louis-CFM/coucou` (MIT source, **assets reserved**) | **Study only** for now | KAI's `KaiEventType` union already provides a canonical vocabulary; nothing yet proves Coucou adds a mechanism KAI lacks, and its assets may never be copied |
| 11 | A second agent loop | `openclaw/openclaw` (MIT) | **Reject** | KAI has one orchestrator with a durable retry ledger, a dispatch ledger and an Outcome Gate. A second loop is a second source of truth |
| 12 | GPL-3.0-only scheduling/idempotency code | `LING71671/open-grokbot` | **Study only** | GPL-3.0-only is incompatible with distributing KAI as-is. The *ideas* (nonce/digest idempotency) can be reimplemented natively if a gap is proven |
| 13 | LobeHub runtime | `lobehub/lobehub` (Community Licence) | **Study only** | The licence adds commercial-derivative conditions; architecture study and code reuse are separate decisions |
| 14 | Hermes' Python backend wholesale | `NousResearch/hermes-agent` (MIT) | **Reject** (as a whole) | Different language and process model. The *learning design* is worth studying; the code is not portable into KAI's Core |
| 15 | A VM / hypervisor | — | **Blocked pending host authorization** | No firmware, Hyper-V, startup or service change is made without a separately approved host-change decision |

## Pending (not yet investigated)

The six donor lanes did not run (see the method note in `DONOR_LEDGER.md`). The
following remain **PENDING** and must not be described as reviewed:
Hermes (skills/memory), OpenCode (events/tool contracts), Coucou (event
normalisation), Pi (runtime contract), OpenClaw (agent-loop reliability),
OpenHands SDK + Rakazo (workspace/execution provider), the Grok projects, LobeHub.

## The test for this whole approach

Not "can KAI say it researched Hermes, OpenCode or Coucou". It is whether a
specific mechanism produces a measurable improvement in KAI, passes reproducible
tests, respects licensing, retains evidence, and keeps operating under the same
Goal Executive and Guard. Rows 1–9 above are that test, passed.
