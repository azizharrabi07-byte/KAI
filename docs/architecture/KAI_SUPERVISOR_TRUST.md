# KAI supervisor trust loop

**What this document is:** the contract KAI's supervisor actually implements — how a
piece of delegated work moves from *planned* to *verified*, what may and may not
count as proof, and where the human is required. Every rule below has a test that
would fail if the rule were removed; the tests are named inline and live in
`core/tests/orch-supervisor-trust.test.ts` (the 17-case suite plus focused cases).

**The one invariant everything else serves:**

> A worker's claim is not proof. A reviewer's verdict is not sufficient by itself.
> `COMPLETED` is reachable only through the Outcome Gate passing on evidence KAI
> itself observed and linked to an exact criterion label.

---

## 1. States

The work board (`core/src/orchestration/board.ts`) is the single source of truth.
One enum, extended rather than duplicated (`core/src/orchestration/types.ts`):

```
PLANNED(READY) → CLAIMED → RUNNING → VERIFYING/REVIEW → COMPLETED
```

with the alternative states `WAITING` (parked on an approval or a question),
`CHANGES_REQUESTED` (a corrective round is in flight), `BLOCKED`, `FAILED`,
`CANCELLED`.

`PLANNED` is the honest name for what `POST /work-items` does: it creates a durable
runnable item and emits **`work.planned`**. A worker is not dispatched until
`POST /work-items/:id/run`, which emits **`delegation.routed`** and only then reports
`delegated: true`. The HTTP status is keyed on *creation* (201), never on
delegation. Tests: `orch-supervisor-trust.test.ts` case 17;
`orch-commands.test.ts` "LIVE: work board…".

---

## 2. Claims vs observations vs evidence

Three different things are stored differently, on purpose
(`VerifiedEvidence` in `core/src/orchestration/types.ts`):

| Kind | Where it lives | Can it satisfy a requirement? |
|---|---|---|
| **Worker claim** | `handoff.evidence` / `handoff.tests` (the worker's words) | **Never.** Stored as `source: "worker-reported"` for display. |
| **KAI observation** | `workItem.evidence[]`, `source: "kai-observed"` | **Only** if its `supports[]` names the required-evidence label exactly. |
| **Review verdict** | `workItem.review` | An *input* to the gate; it may compensate a criterion only when no direct observation was possible, and that is recorded. |

There is no token-overlap, substring, or short-prefix path anywhere. The old
`criterionMet` ("first 24 characters of the criterion appear in the result") and
`evidenceSatisfies` (token match) are gone; the replacements are exact-label
membership (`core/src/orchestration/outcome.ts`). Tests: cases 1, 2, 4, 5.

---

## 3. The Outcome Gate

`evaluateOutcome(contract, observation)` is the completion authority
(`core/src/orchestration/outcome.ts`). It returns `PASS` only when:

1. a deliverable exists;
2. **every** acceptance criterion is met (`completionPolicy: "all_criteria"`, the
   default) — each criterion requiring its linked evidence labels to be satisfied
   by KAI-observed records (unlinked criteria default to *all* required evidence,
   which is the strict reading);
3. **no** required-evidence label is missing an observed record;
4. no forbidden outcome occurred;
5. there are no unresolved blockers.

Anything else is `INSUFFICIENT_EVIDENCE` / `CONTRADICTED` / `FAIL` / `UNKNOWN`, and
the item does not become `COMPLETED`. `finishComplete` and the re-gate paths call
this one function — there is no second completion path. Tests: cases 1, 1b, 3, 4,
5, 17, 17b; `orch-gate-authority.test.ts`.

The whole Outcome Contract — criteria, constraints, forbidden outcomes, required
evidence, evidence links, budget, working directory — rides the item from creation
through storage to the gate. It is persisted (schema v4), so a resume cannot
forget it. Tests: case 6, 6b; `docs/evidence/…` migration coverage.

---

## 4. Corrective actions

When the gate does not pass, `finishComplete` routes through the deterministic
Decision Kernel (`decideNext`) and **executes** one bounded corrective round
(`executeCorrective`):

| Action | What actually happens |
|---|---|
| `INSPECT` / `VERIFY` / `RUN_TESTS` | KAI gathers evidence itself (see §5) and re-gates. Bounded to 3 evidence rounds per item. |
| `RETRY` / `REPLAN` / `CHANGE_WORKER` | A **child** work item carries the correction, inheriting the parent's contract, executed through the same policy/approval path. Depth-capped by `autonomy.maxDepth`. |
| `ASK_USER` | Parks visibly with the specific missing decision; `worker.waiting` is emitted and the next action is recorded durably. |

Every round records a durable `nextAction` (`proposed` / `running` / `done` /
`blocked` / `waiting-approval`) plus a trace entry, so a work item never sits in
`CHANGES_REQUESTED` with no explanation. Tests: cases 9, 9b, 13.

### 4.1 Evidence collection is real, and bounded

`gatherEvidence` calls KAI's **own** tool registry (never a worker):

- a required-evidence label naming a claimed artifact → `filesystem.metadata` +
  `git.status` (existence and working-tree state);
- a label naming an explicit, allowlisted command (`npm test`, `npx tsc --noEmit`,
  `node --test`, `cargo test`, `pytest`, `go test`) → `shell.run`, and the **exit
  code decides**. A non-zero exit is recorded with `supports: []` — it informs,
  it never satisfies;
- anything else → recorded as unsupported with a reason, never guessed.

Shell checks are `DESTRUCTIVE` risk, so they park for approval at every autonomy
level; the approval is durable and resumes exactly that check (including after a
restart). Output previews are redacted before they are stored. Tests: cases 3, 9,
redaction case.

---

## 5. Approvals and idempotency

- A **spent** approval cannot authorize a second action: `approvals.decide` refuses
  any approval that is not `PENDING`, so an approved, rejected or **expired**
  approval is final. Tests: cases 12b, 12c.
- A **rejected** approval cancels the parked work and runs nothing. Case 12.
- A review retry is a *new* external execution and therefore needs a **fresh**
  approval; the spent id is never reused. `orch-orchestrator.test.ts`
  "CHANGES_REQUESTED parks the retry for a FRESH approval".
- **Duplicate delivery** is a no-op: a resume key (approval id or completion event
  id) is recorded on the item, and a redelivered trigger returns
  `duplicate delivery … ignored — no double execution`. A settled item
  (`COMPLETED` / `CANCELLED` / `BLOCKED`) is refused re-dispatch by the board.
  Tests: cases 10, 10b, 11.

---

## 6. Retry policy, enforced at the boundary (per ITEM)

`runWorkItem` — the one entry point every caller uses (API, UI run control,
supervisor resume, a corrective child) — enforces the item's attempt ceiling from
a **durable per-item dispatch ledger** (`outputs.dispatches`), before any claim or
delegation. No caller can exceed it, and rotating workers does not reset it.

### What counts as an attempt

Exactly one ledger entry per **worker dispatch**, classified against the previous
entry so a caller cannot relabel a retry as something cheaper:

| Kind | When | Bounded by |
|---|---|---|
| `initial` | the item's first dispatch | always allowed |
| `retry` | the same worker as the previous dispatch | `maxRetries` |
| `reassign` | a **different** worker than the previous dispatch | `maxReassignments` (defaults to `maxRetries`) |

Not counted, deliberately: an evidence resume (no worker dispatch), an approval
park (no dispatch), a refused claim, and a duplicate/redelivered event (the resume
key makes it a no-op before the ledger is touched). The review-retry
re-delegation **is** counted — it is a real dispatch.

Ceiling: `1 + maxRetries + maxReassignments` dispatches. Exhausting it sets the
item `BLOCKED` with a durable `nextAction` and a trace entry — a truthful parked
result, never a false completion — and the board refuses further re-entry.

### Why retries and reassignments are separate allowances

Reassignment is the breaker's sanctioned "never blind retry" recovery after
repeated failure (`core/src/orchestration/bench.ts`, `scripts/orch-e2e.mjs` S2:
three failures by one worker, then a switch that succeeds). Counting a switch as a
retry would refuse the sanctioned path; giving it no bound at all is the loophole
this policy closes. So it has its own allowance **and never resets the retry
count** — both ceilings bind the same item.

### Corrective children

A corrective child (`RETRY`/`REPLAN`/`CHANGE_WORKER`) is a **new work item**: it
inherits the parent's contract and budget, starts with its own empty ledger, and
is bounded by the same policy. The chain is bounded independently of the ceiling
by `maxDepth` (children beyond it park) and `maxChildren` (`maxParallel`) per
parent, so no retry chain is unbounded. Tests: trust-suite "retry policy…"
(9 cases), `orch-orchestrator.test.ts` "spent retry budget fails instead of
retrying forever", `orch-e2e.mjs` S2.

### Durability

The ledger lives in the persisted `outputs` JSON, so a restart, a duplicate
event, a repeated API request and a concurrent dispatch cannot grant extra
attempts. `board.annotate` is **additive by contract** — it merges into `outputs`
instead of replacing them, because replacing silently dropped the ledger, the
resume keys and the persisted Outcome Contract whenever a run parked for an
approval.

**Relationship to the old per-worker counter:** it is gone. `item.retries`
(incremented by a review `changesRequested`) remains only as bench/rework
bookkeeping and no longer governs any ceiling; the ledger is the single authority.


---

## 7. Skills

- **Selection** happens at planning time: with no skills named, the orchestrator
  asks the real registry for the top 3 matches on the objective (`startObjective`).
- **Loading** happens once per delegation, capped at 5 bodies and 1 500 chars each
  in the prompt (`loadSkillReceipts` / `buildPrompt`).
- **Receipts** record `id`, `version`, content `hash` and the byte length of the
  body actually handed over, deduped by `id@hash`. A skill that fails to load
  produces **no** receipt and a trace entry — never a false receipt. Tests:
  cases 14, 14b.
- **Usage metrics** are recorded only on the verified completion path, so
  "skill X succeeded" reflects real verified use.
- **Untrusted framing:** skill bodies, memory, mission notes and worker output all
  reach the model inside `DATA — NOT INSTRUCTIONS` sections under a precedence
  block that outranks them (`core/src/prompts/compose.ts` `DEFAULT_SAFETY`), so
  skill text cannot widen authority or override identity/policy.

---

## 8. External worker reports (`/audit`)

`POST /work-items/audit` and the `/audit` chat command ingest output from a worker
KAI did not dispatch. The report is parsed into **claims**, attached to a durable
audit work item, checked against the **real** workspace, gated, reviewed (when
policy runs reviewers) and answered with a concrete next-worker prompt.

- Without a working directory, **no checks run** and the limitation says so: the
  claimed paths would otherwise resolve against KAI's own sandbox — evidence about
  the wrong tree, which is worse than none. Tests: case 13b.
- Auto-launch happens only when autonomy permits (`level ≥ 2` and `workerAuto:
  AUTO`); otherwise the prompt is returned to run. Tests: case 13.
- An empty report is refused; nothing is fake-audited. Case 13c.
- The command accepts a multiline paste (the `raw` argument is carried verbatim
  from the composer to the command) or `--file <path>`; a truncated file read is
  labelled as truncated, never silently. Tests: `summary-audit-commands.test.ts`,
  `app/tests/supervisor-surface.test.ts`.

---

## 9. Daily work summary (`/summary`)

- The **offer** rides the one scheduler through its `onTick` seam (no second
  timer). It fires at most once per **local calendar day** (IANA zone, DST handled
  by the platform timezone database), only after the configured local time, and
  only when meaningful work happened. Its state lives in the durable settings
  store, so a restart cannot re-offer. Tests: `summary-daily.test.ts`.
- The **report** is compiled from the durable work board and activity log, not
  from UI events. Its per-state counts reconcile with the item list, and a
  `COMPLETED` item with no KAI-observed record is reported as *worker-reported
  (unverified)* — never as verified. It is produced only on request; the offer is
  a short prompt. Tests: `summary-daily.test.ts`,
  `summary-audit-commands.test.ts`.

---

## 10. Memory lessons

A supervision lesson is written **only** on the verified completion path, with the
gate verdict as the `verified` basis, into **mission-scoped** memory
(`rememberForMission`). An unknown mission id refuses structurally
(`MEMORY_SCOPE_SUBJECT_UNKNOWN`) — it is never redirected to global scope. A
refused or throwing write is traced, never reported as saved, and never breaks
completion. Tests: cases 16, 16b.

---

## 11. Failure visibility

`MissionSupervisor.observe` wraps its own evaluation: an internal throw is
recorded as a decision **and** notified to the human, never swallowed
(`core/src/autonomy/supervisor.ts`). The scheduler contains a housekeeping throw
as `scheduler.tick_failed` and keeps ticking. Every failed observation, lesson,
review or next-action attempt lands in the trace with its task/mission id. Tests:
trust-suite "supervisor failure…", "a failed lesson write is surfaced…".

---

## 12. Known limitations

- Shell verification is limited to the allowlisted command shapes; anything else
  is recorded as unsupported rather than executed.
- External audits require a working directory to check file claims; without one
  they report the limitation and verify nothing.
- **Hermes is reachable but does not complete a turn on this machine.** Its
  control plane answers quickly (`GET /health` 200 in 16 ms, `GET /v1/models` 200
  in 35 ms, `POST /api/sessions` 201 in 17 ms) and it *accepts* work
  (`POST /v1/runs` returns a `run_id`), but `POST /api/sessions/:id/chat` never
  answers — measured ≥30 s against KAI's configured 120 s chat timeout, and a run
  never finishes inside the configured 15-minute run timeout. KAI behaves
  correctly and honestly in both cases: the chat turn falls back to
  `presentWorkerFailure` (`core/src/chat/relay.ts`) and the run ends
  `timed_out` / `AGENT_TIMEOUT` after `bestEffortStop`. No KAI-side defect is
  demonstrated, so nothing is mocked, skipped or relabelled; the two affected
  checks stay failing and are reported as externally blocked. Diagnosed
  2026-10-09; see `docs/STATUS.md`.
- The live Hermes relay test (`core/src/server.test.ts`) therefore fails after
  exactly the 120 s chat timeout (observed 120,053–120,152 ms), which is the
  configured `chatTimeoutMs`, not an arbitrary hang.
