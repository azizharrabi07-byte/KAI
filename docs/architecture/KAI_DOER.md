# KAI Doer — the autonomous-execution switch

Status: implemented (vertical slice 1) + the goal layer (slice 2) · Branch `feat/goal-executive`

This records the source of truth for each state, the boundary between **KAI Guard**
and **KAI Doer**, and what the first slice does and does not do.

## 1. Two controls, never one

| | KAI Guard | KAI Doer |
|---|---|---|
| What it is | Policy engine, risk classification, approvals, the execution registry, cancellation, security audit | Autonomous goal execution: planning, dispatch, result interpretation, corrective action, improvement analysis |
| Default | **Always ON** | **OFF** for a fresh installation |
| Switchable | No — never through the Doer control | Yes, durably, from the Island |
| Enforcement point | `core/src/tools/registry.ts` `invoke()` — validate → policy → (approval) → execute | Every autonomous trigger listed in §4 |

**Guard is never affected by the Doer switch.** Nothing in `orchestration/doer.ts`
can grant, widen or skip an approval: the Doer decides *whether KAI acts on its
own*, never *whether an action is allowed*. A Doer-ON retry still passes the same
`policyCheck({ toolId: "agents.run_task", risk: "EXTERNAL" })` gate as a
user-triggered run.

**Documented limitation.** KAI cannot control processes the user launches
entirely outside the guarded path (a terminal the user opens, a worker started by
hand). Guard governs what KAI *mediates*; it is not a host-wide sandbox. This is
reduced — not removed — by integration through adapters, restricted workspaces and
the separate guest VM (not yet built).

## 2. Source of truth

| State | Owner | Where it lives |
|---|---|---|
| Doer ON/OFF | `core/src/orchestration/prefs.ts` | `settings` table, key `orchestration.doer` (`ON`/`OFF`) |
| Pending worker/mission results | `core/src/orchestration/doer.ts` | its own SQLite file, `doer-pending.db` (`doer_pending_results`) |
| Work item lifecycle | `core/src/orchestration/board.ts` | `work_items` table |
| Outcome contract + gate | `core/src/orchestration/outcome.ts` | `outputs.contract` on the work item |
| Mission lifecycle | `core/src/missions/executor.ts` | `missions` / `mission_steps` |
| Approvals | `core/src/approvals/service.ts` | `approvals` table |
| Events | `core/src/events/bus.ts` | `events` table (selective) |

The Doer owns **no** lifecycle of its own. It reads the durable preference live on
every decision and delegates every real action to the existing authoritative
paths (the mission supervisor and the orchestrator).

## 3. Why the inbox exists

A worker result that arrives while the Doer is OFF must not be lost **and must not
be interpreted**. So every terminal worker/mission event is recorded first, as a
durable idempotent row, before anything decides what it means:

```
Doer OFF → row stays PENDING. Nothing reads the payload; no model is asked to
           produce work; no dispatch happens.
Doer ON  → row is claimed under a lease and processed exactly once.
```

* **Idempotency key** — `<eventType>:<eventId>`, or a correlation-derived key when
  the event carries no id. `INSERT OR IGNORE` is the guarantee: a duplicate
  delivery, an SSE replay and a restart re-reading a persisted event are one row.
* **At-most-once claim** — a row is `CLAIMED` under a lease; an expired lease
  returns it to `PENDING`, so a crashed drain is retried rather than lost.
* **Bounded retry** — `fail()` enforces the attempt ceiling itself, so a caller
  cannot bypass it. Exhausted rows land `FAILED` and are never retried.
* **Terminal states** — `DONE` rows are never re-processed, so one result cannot
  dispatch the same next task twice.

The inbox owns its own file (like `parked-requests.db` and `scheduler-leases.db`):
it is Doer-private state and must not reshape the frozen `Stores` interfaces.

## 4. What the Doer gates

Every autonomous trigger reads the preference **live** (never a captured value):

| Trigger | File | OFF behaviour |
|---|---|---|
| Result interpretation + drain | `runtime.ts` (Doer subscription) | rows recorded, never claimed |
| Mission supervision (retry / replan / settlement lesson) | `runtime.ts` (via the Doer, was a direct bus subscription) | no `supervisor.observe` |
| Autonomous work-item advancement | `runtime.ts` `processPendingResult` | never called |
| Startup backlog resume | `runtime.ts` `start()` | not drained |
| Doer switch write | `runtime.ts` `updateSettings` | emits the transition event |

## 5. The wake-up path (no user prompt needed)

```
worker/mission terminal event
  → bus (synchronous, in-process)
  → doer.record()                       ← always; durable, idempotent
  → if Doer ON: doer.drain()            ← single-flight, self-draining
      → claim under lease
      → process(result)
          mission-correlated  → supervisor.observe(missionId)
          work-item-correlated → orchestrator.nextMove(id)
                                 → runWorkItem(id, { resumeEventId: <inbox key> })
                                     (policy, approvals, retry ceiling and the
                                      Outcome Gate all still apply)
          uncorrelated        → settled with a recorded reason
      → settle / fail
```

`resumeEventId` is the inbox key, so the orchestrator's own resume guard and the
inbox's claim guard are two independent barriers against double dispatch.

**The event source never authorizes completion.** A worker result is a pointer;
`processPendingResult` reloads authoritative state and the Outcome Gate alone
permits `COMPLETED`.

## 6. API

| Route | Kind | Behaviour |
|---|---|---|
| `GET /doer` | READ | `{ state, paused, guard: "ON", pending, results[] }` |
| `POST /doer` | WRITE | `{ state: "ON"\|"OFF" }` — goes through the policy-gated `settings.update` tool, so a WRITE-policy Core parks it for a human |
| `GET /doer/pending` | READ | the full inbox with counts |
| `GET /goals` · `GET /goals/:id` | READ | goals with approval state + eligibility |
| `POST /goals` | WRITE (owner) | create a goal — always `DRAFT` |
| `POST /goals/:id/state` | WRITE (owner) | user-driven lifecycle move; illegal transitions refused |
| `POST /goals/:id/challenge` | WRITE (owner) | run the panel (`QUICK`/`DEEP`), store the report, set the verdict state |
| `POST /goals/:id/plan` | WRITE (owner) | propose a plan revision (a refused plan is a refusal) |
| `POST /goals/:id/approve` | WRITE (owner) | approve ONE revision; a non-current revision is refused |
| `POST /goals/:id/reject` | WRITE (owner) | reject → `REVISION_REQUIRED` |

"owner" means `requiresOwner`: refused unless the caller proved it holds the
install's host token. When a Core has NO token configured (a developer running
`npm start` directly) the check cannot be made and the route is allowed — that is
residual exposure, reported honestly rather than papered over.

The switch event (`doer.enabled` / `doer.disabled`) is emitted by the **settings
write**, not by the HTTP handler, so a direct tool call, a gated route and the
re-issue that follows an approved park all take exactly one path — and an
approved switch to ON immediately drains the backlog.

## 7. The goal layer (slice 2)

The goal layer sits **above** the orchestrator and does not replace it. One
component owns each state:

| State | Owner | Where |
|---|---|---|
| User intent, goal lifecycle | `core/src/goals/store.ts` | its own file, `goals.db` (`goals`) |
| Plan revisions + the approval bound to one | `core/src/goals/store.ts` | `goal_plan_revisions`, `goal_plan_approvals` |
| Challenge findings | `core/src/goals/challenger.ts` (produced), stored on the goal | `goals.challengeJson` |
| Work-item status + evidence | the existing work board | `work_items` (now with `goalId`/`goalRevisionId`, schema v5) |
| Worker-run status | the existing orchestrator/adapters | unchanged |
| Conversational turn status | the existing chat `TaskRecord` | unchanged |
| Doer state + pending events | `core/src/orchestration/doer.ts` | `doer-pending.db` |

**Lifecycle.** `DRAFT → UNDERSTANDING → CHALLENGING → {READY_FOR_PLAN |
CONDITIONAL | REVISION_REQUIRED | BLOCKED} → PLAN_PROPOSED →
AWAITING_PLAN_APPROVAL → APPROVED → RUNNING`, plus `PAUSED_DOER_OFF`,
`WAITING_USER`, `BLOCKED`, `COMPLETED`, `FAILED`, `CANCELLED`. The graph lives in
one table (`goals/goal.ts` `TRANSITIONS`); `routeTo` walks it, so no caller
hard-codes the edges.

**Approval binding.** An approval records `revisionId` **and** `contentHash`,
taken from the STORED revision (never from the caller). `isApproved` compares both
against the CURRENT revision, so a material edit makes the approval stale even if
nobody called `invalidateApprovals`. Approving a revision that is not current is
refused.

**Premature dispatch is impossible by construction.** `runWorkItem` refuses at the
top — before any state change — when the item carries a `goalId` whose goal has no
matching approval. That is one check at the one boundary every dispatch passes
(HTTP routes, the slash command, the Doer drain, corrective children, approval
resumes), so a new caller cannot forget it. `setGoalState` independently refuses
any transition into `RUNNING` without a current approval.

**Owner authorization.** Goal mutations, `/doer` and `/approvals/:id/decide` are
`requiresOwner`: the Core refuses them unless the caller proved it holds the
per-install host token (the same credential the chat relay already uses). Without
that, any local process could approve any pending approval — including the switch
that enables autonomy — which is the escalation this closes.

**The OFF asymmetry.** `POST /doer {state:"OFF"}` goes through a value-scoped
`doer.set` tool that accepts OFF only and is internal-state, so it applies
immediately. ON still goes through `settings.update` and parks for a human.

## 8. Not implemented yet (honest scope)

* **Goal Architect** — no structured plan/contract object with revision history
  and an approval gate before dispatch. `OutcomeContract` already carries the
  contract fields; the plan-approval gate does not exist.
* **Goal Challenger** — not built. Research is complete (`shark-skill` and
  `business-idea-validator`, both MIT; the reusable algorithms are the
  persona-as-data panel, independent-findings-before-synthesis and a computed
  verdict over a bounded rubric) and the plug-in point is
  `orchestration/review.ts`'s injectable runner shape + `chat/brain.ts` `respond`.
* **Worker Task Compiler** — the packet is still a fixed 13-section string
  (`orchestration/prompts.ts` `buildWorkerPrompt`); no per-worker-kind sections.
* **Improvement proposals** — not built.
* **Island surface** — `GET/POST /doer` exist; the Island does not yet render a
  Doer/Guard indicator or a worker cockpit.
* **Guest VM / CUA** — not built; see the VM decision in the phase report.
