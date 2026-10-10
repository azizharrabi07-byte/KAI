# KAI Doer — the autonomous-execution switch

Status: implemented (vertical slice 1) · Base commit `bd7c2ee` · Branch `feat/goal-executive`

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

The switch event (`doer.enabled` / `doer.disabled`) is emitted by the **settings
write**, not by the HTTP handler, so a direct tool call, a gated route and the
re-issue that follows an approved park all take exactly one path — and an
approved switch to ON immediately drains the backlog.

## 7. Not implemented yet (honest scope)

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
