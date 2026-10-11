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

| 16 | **Interrupted-run reconciliation** — a work item a dead process left in flight is BLOCKED with a durable reason, so its goal settles instead of hanging | KAI's own interrupted run (inspected: item `RUNNING`, worker process gone, goal stuck) | **Reimplement natively** | Found by inspecting the real persisted state, not by reading a donor | `core/tests/goal-criteria.test.ts` — and demonstrated on the REAL run: `RUNNING` → `BLOCKED` + reason, goal settled `BLOCKED` with an honest blocker |
| 17 | **`board.block` records its reason** | same investigation (`block` took a reason and discarded it into an event) | **Reimplement natively** | A blocked item must be able to say why after the process that blocked it is gone | `goal-criteria.test.ts` asserts the reason is persisted |
| 18 | **Terminal goals never dispatch** | Part A step 6 | **Reimplement natively** | An already-COMPLETED goal would compile and run its tasks again | `goal-criteria.test.ts` — a completed goal dispatches nothing and reaches no worker |
| 19 | **Typed provider diagnostics** | the real `GoUsageLimitError`/`limitName: monthly` 429 | **Reimplement natively** | A spent allowance and transient throttling need opposite responses, and must never leak a credential | `core/tests/model-diagnostics.test.ts` — the real 429 body classifies as `quota-exhausted`, not retryable; a credential in the body is redacted |
| 20 | **Worker preflight** | the live run (a fresh Core compiles, then refuses to dispatch) | **Reimplement natively** | Installed ≠ registered ≠ reachable; the user must be told which before a plan runs | `core/tests/worker-preflight.test.ts` — the two real gaps are named as different blockers |
| 21 | **Hermes skill mechanisms** — compact index, applicability conditions, per-skill mutation lock outside the dir, validate-before-write, scan agent-created skills, pinned/redirect guards | `NousResearch/hermes-agent` @ `1fd182772671` (MIT) | **Implement pattern natively** | Python, and KAI owns the same responsibility in its skill registry; porting would couple languages. **KAI must turn the scan ON by default, unlike Hermes' opt-in `guard_agent_created=False`** | not yet implemented — see the ranked plan (highest-value native work) |
| 22 | Grok Build Desktop | `Franzferdinan51/Grok-Build-Desktop-App` | **Reject** | **No root LICENSE/COPYING/NOTICE; GitHub's licence API 404.** No reuse is permitted until the owner clarifies, and an `upstream/` directory would need separate checks | n/a |
| 23 | OpenHands SDK / Rakazo | MIT / Apache-2.0 | **Pending** | Licences are permissive, but the workspace/execution-provider contract was not read | missing: the provider interface source |
| 24 | open·grok | `OnlyTerp/opengrok` (MIT) | **Pending** | A routing sidecar, not an executor; the provider-mapping/health ideas may or may not be relevant | missing: the provider mapping source |

## Ranked adoption plan (Part D)

Ranked by the criteria the brief sets, highest first:

| Rank | Capability | Why it ranks here |
|---|---|---|
| 1 | **Hermes' skill mechanisms, reimplemented natively** | Directly improves verified completion *and* learning: a bounded index, applicability conditions, and validation/scan before a skill is activated are what stop a bad skill reaching a future prompt. No new dependency |
| 2 | **OpenCode event consumption** (once the event schema is verified and `:4096` is up) | Improves reliability and observability of a worker KAI already supports; needs the missing evidence first |
| 3 | **OpenHands/Rakazo workspace-provider separation** | Improves workspace isolation and recoverability, but KAI's current containment + proof already covers the security property; this is a structural improvement, not a gap |
| 4 | **Pi as an external worker** | Adds a runtime behind the existing adapter contract; value depends on the RPC contract, which is unverified |
| 5 | **OpenClaw loop patterns** | Lowest: KAI has a durable retry ledger, a dispatch ledger and an Outcome Gate, and will not import a second loop |
| — | **Coucou, LobeHub, LING71671/open-grokbot** | **Study only** — no implementation path is cleared |

**The boundary is unchanged:** KAI owns intent, plans, approvals, Guard, dispatch policy
and settlement; worker runtimes own their own execution; the work board is authoritative
for item state and evidence; donor mechanics sit behind an adapter or provider boundary;
and no new runtime may authorize an operation or mark its own work verified.

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
