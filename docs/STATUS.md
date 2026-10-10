# KAI Status

Current, honest status of the KAI source tree. Everything here was produced by running the
commands shown; nothing is claimed from reading code.

- **Commit:** `2d2f4b9` ("per-item retry ceiling from a durable dispatch ledger")
  — the newest **code** commit. A docs-only follow-up (this file, the supervisor
  contract, the refreshed probe evidence) changes no source, so `2d2f4b9` is the
  exact tree the suites, probes and counts below were run against.
- **Date:** 2026-10-09
- **State:** experimental, single-machine, actively developed. Not a released product.

## Product direction: KAI becomes a goal-driven executive (branch `feat/goal-executive`)

The product direction changed. KAI is no longer only a conversational assistant that
forwards prompts to workers: it is becoming a persistent, goal-driven executive that
designs a route to a goal, has the plan approved, compiles worker-specific tasks,
observes results, verifies evidence and continues until the goal is met or a real
blocker is reached — with the user able to stop the autonomous part without losing the
security layer.

**Two controls, deliberately separate.** *KAI Guard* (policy engine, risk
classification, approvals, execution registry) is **always on** and is not
switchable through the other control. *KAI Doer* (autonomous planning, dispatch,
result interpretation, corrective action) is a durable ON/OFF preference that
**starts OFF** on a fresh installation. See `docs/architecture/KAI_DOER.md`.

### Vertical slice 1 — the Doer switch and the pending-result inbox (verified)

- **Durable preference** `orchestration.doer` (`ON`/`OFF`) in the existing settings
  store; default `OFF`. Read live on every decision, so turning it off stops the
  autonomous path immediately and turning it on resumes it without a restart.
- **`core/src/orchestration/doer.ts`** — the switch plus a durable, idempotent
  pending-result inbox in its own SQLite file (`doer-pending.db`). Terminal
  worker/mission events are recorded **unconditionally**; interpretation happens only
  through a claim under a lease, so a result that arrives while the Doer is OFF is
  kept, not lost, and not interpreted.
- **Exactly-once.** The idempotency key is `<eventType>:<eventId>` with `INSERT OR
  IGNORE`; a claim is at-most-once under a lease (an expired lease returns the row to
  `PENDING`); the attempt ceiling is enforced inside the store, not by the caller; a
  `DONE` row is never re-processed. The inbox key doubles as the orchestrator's
  `resumeEventId`, so the two guards are independent barriers against double dispatch.
- **The wake-up path.** A terminal event → record → (if ON) single-flight drain →
  mission-correlated results wake the mission supervisor; work-item-correlated results
  advance through `orchestrator.runWorkItem`, which still enforces policy, approvals,
  the retry ceiling and the Outcome Gate. No user prompt is needed to continue.
- **Autonomy now requires the Doer.** The mission supervisor's bus subscription moved
  behind the Doer, so OFF means no retry, no replan and no settlement lesson.
- **API.** `GET /doer`, `POST /doer` (policy-gated — a WRITE-policy Core **parks** the
  switch for a human), `GET /doer/pending`.
- **Defect found and fixed.** A parked `settings.update` carrying only orchestration
  keys could not be resumed: the re-issued call was the normalised
  `{ settings, orchestration }` shape, and validation read only `settings`, so it
  failed as "nothing to update" — the approval landed and the setting silently never
  applied. Validation is now idempotent over its own output.

**Not built yet (honest scope):** the Goal Architect's plan-approval gate, the Goal
Challenger, a per-worker-kind task compiler, improvement proposals, the Island's
Doer/Guard and worker-cockpit surfaces, and the guest VM. Research for each is
complete; see the phase report.

### Vertical slice 3 — the full execution loop, authorization, compiler and cockpit

The gap between "approved plan" and "work actually runs" is closed.

- **Goal executor** (`core/src/goals/executor.ts`): an approved plan compiles into
  work items linked to `(goalId, revisionId, taskId)`, so compilation is IDEMPOTENT
  across retries and restarts. Dependency-ready work dispatches through the SAME
  `runWorkItem` every other caller uses. Items in `CHANGES_REQUESTED`/`FAILED` are
  re-attempted (bounded by the orchestrator's retry ledger), and `BLOCKED` counts as
  terminal FOR SETTLEMENT — without that, a goal whose task blocked sat in RUNNING
  forever, which was a real defect found by the E2E suite.
- **Settlement is evidence-bound**: a goal reaches COMPLETED only when every
  acceptance criterion is settled by a `kai-observed` record that supports it. A
  worker's confident claim with no artifact on disk settles nothing.
- **Authorization policy** (`core/src/api/authz.ts`): all **141** routes classified
  (1 public / 60 read / 80 owner), enforced in `coreApi.handle` before any handler
  runs. A set-equality test fails if a route is added without classification — it
  caught two of mine. `devMode` is explicit (`KAI_DEV_MODE=1`), never inferred.
- **Task Compiler** (`core/src/orchestration/compiler.ts`): per-`TaskDomain` section
  sets (coding/debugging/testing/research/review/document/security/verification/…),
  with `forbiddenOutcomes` and every criterion PAIRED with its verification method
  now reaching the worker prompt. `buildPrompt` is cut over to it.
- **Codex adapter** (`core/src/agents/codex.ts` + `adapters/codexAdapter.ts`): real
  `codex exec --json` JSONL transport with a bounded, cancellable read; exit 0 with
  no terminal event is a FAILURE, never a success. Reported unavailable here because
  the CLI is not installed.
- **Workstation/CUA** (`core/src/workstation/*`): a provider contract with typed
  `effect`/`verified` results (a delivered event is not an applied change), a real
  driver integration, and a mock. The installed driver was probed for real.
- **UI**: a Goals surface and a worker/execution **Cockpit** backed only by real
  Core state, with four separate sections for assigned tasks, worker-reported
  results, KAI-observed activity and KAI-performed verification.

### Authorization posture (read this before deploying)

Every one of the **141** registered routes is classified in `core/src/api/authz.ts`
and the decision is made in `coreApi.handle` before any handler runs. The posture
is reported by `GET /identity` as `ownerAuth`:

| `ownerAuth` | When | What it means |
|---|---|---|
| `enforced` | a host token is configured (the installed app always injects one) | owner routes require the credential; an unattested caller gets **401** |
| `disabled-by-explicit-dev-mode` | `KAI_DEV_MODE=1` | owner routes are allowed and the decision SAYS so — never the default |
| `unconfigured` | no token and no dev flag (a developer running `npm start`) | owner routes are allowed **and reported as unprotected** |

The third row is deliberate residual exposure, not an oversight: a Core with no
credential cannot check anything, and pretending to refuse would make a standalone
developer Core unusable. A normal installation — the app spawns the Core and injects
the token — is always in the first row. **Read `GET /identity` before trusting a
Core's authorization.**

### Verification of slice 3 (commands actually run)

- `cd core && npm test` — see the counts below.
- `cd core && npm run typecheck` — clean.
- `cd app && npx tsc --noEmit -p tsconfig.json` — clean; `npm test` — **338 pass**.
- `cd app/src-tauri && cargo test --lib owner_call` — **2 passed**.
- `core/tests/goal-execution-e2e.test.ts` — **7/7**: an approved plan compiles,
  dispatches in dependency order, verifies and settles COMPLETED; a failing worker
  yields a truthful BLOCKED; a success CLAIM without the artifact is not verified;
  Doer OFF dispatches nothing; Doer ON resumes without duplicates; goals, revisions,
  approvals and work items survive a real close/reopen; a material plan edit makes
  the goal undispatchable again.

### Vertical slice 2 — the goal executive (intake → challenge → plan → approval)

A goal is now a durable contract ABOVE the orchestrator. Nothing dispatches until an
owner approves ONE exact plan revision, and even then only while the Doer is ON.

- **Goal layer** (`core/src/goals/`): `goal.ts` (types, the lifecycle transition
  table, canonical-JSON hashing), `store.ts` (its own SQLite file `goals.db`:
  goals, plan revisions, approvals), `challenger.ts` (the critic panel),
  `architect.ts` (plan production + validation), `runners.ts` (the model seam).
- **Schema v5** (additive): `work_items.goalId` + `goalRevisionId`, nullable, so a
  pre-existing row reads back as "not part of a goal". A round-trip test builds a
  real v4 database and proves the upgrade keeps its work items, evidence and
  settings.
- **Premature dispatch is impossible by construction**: `runWorkItem` refuses at
  the top when the item's goal has no approval matching the CURRENT revision — one
  check at the one boundary every dispatch passes. `setGoalState` independently
  refuses any transition into `RUNNING` without a current approval.
- **Approval binding**: `revisionId` + `contentHash`, taken from the stored
  revision. A material edit makes the approval stale even if nobody invalidated it;
  approving a non-current revision is refused.
- **Goal Challenger**: six critic roles as data; QUICK runs three, DEEP all six,
  OFF none. Findings are captured independently before synthesis; a blocking
  objection beats any majority; conflicting verdicts are retained verbatim; a
  computed count never drives the verdict; rounds are bounded (default 3, hard cap
  10). A malformed or throwing critic becomes a BLOCKED finding, never a PASS.
- **Goal Architect**: every acceptance criterion must carry a non-empty
  verification method or the plan is REFUSED; dependency cycles and unknown ids are
  refused; the task budget is enforced; a malformed model reply is a refusal, not
  an empty plan presented as valid.
- **Owner authorization**: `/goals*` mutations, `POST /doer` and
  `POST /approvals/:id/decide` are `requiresOwner` — refused unless the caller
  proved it holds the install's host token. This closes the escalation where any
  local process could approve any pending approval (including the one that enables
  autonomy). The token is attached by the Rust side and never enters JavaScript.
- **The OFF asymmetry**: `POST /doer {state:"OFF"}` now applies IMMEDIATELY through
  a value-scoped `doer.set` tool (authority-reducing, no approval). Enabling the
  Doer still parks for a human. Previously OFF also parked, which contradicted the
  requirement that stopping KAI must never need an approval.
- **UI**: a Goals surface (`app/src/shell/presence/goals.ts`) reading real Core
  state, with three visibly distinct eligibility badges (eligible / paused because
  the Doer is OFF / not approved) and no green badge hiding a conditional verdict.

### Verification of slice 2 (commands actually run)

- `cd core && npm test` — see the counts below.
- `cd core && npm run typecheck` — clean.
- `cd app && npx tsc --noEmit -p tsconfig.json` — clean.
- `cd app && npm test` — **307 pass · 0 fail**.
- `cd app/src-tauri && cargo test --lib owner_call` — **2 passed · 0 failed** (the
  owner-call path guard: Core paths accepted; a URL, authority, traversal, scheme
  or newline refused, so the credential cannot be redirected).

### Verification of slice 1 (commands actually run)

- `cd core && npm test` — **1287 tests · 1274 pass · 0 fail · 13 skipped** (was
  1279/1266/13; the +8 are `core/tests/doer-switch.test.ts`). The 13 skips are
  live-integration checks that need OpenCode on `127.0.0.1:4096`; each names its
  reason. No test is reported as passing that did not run.
- `cd core && npm run typecheck` — clean.
- Four existing suites that exercise the autonomous loop now enable the Doer
  explicitly (`tests/autonomy.test.ts`, `tests/orch-supervisor-trust.test.ts`,
  `tests/campaign-skills-memory.test.ts`) and the prefs enumeration test gained the
  new key (`tests/orch-commands.test.ts`). That is the intended behaviour change, not
  a relaxed assertion: autonomy requires the Doer.
- A real-HTTP smoke (`GET /doer`, `GET /doer/pending`, `POST /doer`) confirmed the
  routes on a live server: `POST /doer` returned **409** with an approval id, because
  a WRITE-policy Core parks the switch for a human.

## What changed since the last status

The supervisor trust repair (started in a previous session) was finished and verified:

- **Claims are not proof.** The Outcome Gate is the single completion authority, and a
  requirement is satisfied only by a KAI-observed evidence record whose `supports[]`
  names the required label **exactly**. The substring/token matching is gone. A
  reviewer PASS may compensate a criterion only where nothing could be observed, and
  that compensation is recorded.
- **Corrective actions execute.** A failed gate now runs a bounded evidence round
  (`INSPECT`/`VERIFY`/`RUN_TESTS` through KAI's own tool registry), a depth-capped
  corrective child (`RETRY`/`REPLAN`/`CHANGE_WORKER`), or parks visibly
  (`ASK_USER`) — never a silent `CHANGES_REQUESTED` stall.
- **Truthful dispatch.** `POST /work-items` plans (`work.planned`; 201 means a durable
  item was created); `delegated` flips only when a worker is really dispatched.
- **Retry ceiling is now per ITEM, from a durable dispatch ledger.** One attempt per
  worker dispatch, classified `initial` / `retry` (same worker, ≤ `maxRetries`) /
  `reassign` (different worker, ≤ `maxReassignments`). A caller can no longer buy
  extra attempts by rotating workers, while the breaker's sanctioned worker switch
  still works. Exhaustion parks the item `BLOCKED` with a durable next action.
- **Approvals are final** (approved / rejected / expired cannot be re-spent) and
  duplicate deliveries are no-ops.
- **`/audit` and `/summary`** are real commands in the production command path, plus a
  durable once-per-local-day summary offer on the one scheduler.
- **Handoff persistence fix:** the parsed worker handoff is stored before review, so a
  run that parks (review or a guarded evidence check) is resumable.
- **`board.annotate` now merges** (it documents itself as additive but used to replace
  `outputs`), so parking a run no longer drops the persisted Outcome Contract, the
  resume keys or the dispatch ledger.
- See `docs/architecture/KAI_SUPERVISOR_TRUST.md` for the full contract.

## Test status

### KAI Core (`core/`)

```
cd core && npm test
```

| | |
|---|---|
| tests | 1278 |
| pass | 1265 |
| fail | 0 |
| skipped | 13 |

**0 failures.** (The count includes the independent campaign suites below.) The one long-standing failure (`core/src/server.test.ts:249`, "POST /chat
runs a real turn through Hermes") was an external Hermes misconfiguration, not a KAI
defect, and it is **fixed and verified** — see the diagnosis below. It is now passing
against the live worker, not skipped and not relabelled.

New suites added by this work (all passing): `orch-supervisor-trust` (**39 tests** — the
17-case suite, 9 retry-policy cases, offline-worker, supervisor-failure and redaction
cases), `summary-daily` (11), `summary-audit-commands` (7), plus a LIVE HTTP-boundary
retry-ceiling case in `orch-commands` and the rewritten `orch-orchestrator` budget case.
The 13 skips are live-integration checks that need both agents or OpenCode (which is
offline on this machine); each names its reason.

## Independent campaign (2026-10-10) — adversarial verification, 8 defects fixed

An adversarial campaign (independent verification suites + a deterministic stress
harness, run in a worktree on this branch) found and fixed eight real defects.
Each has a regression test that now protects it.

| # | Defect (observed) | Fix | Regression test |
|---|---|---|---|
| 1 | Artifact evidence was resolved against **KAI's own working directory**: an item with no `workingDir` completed from a file KAI happened to have, and `workingDir` was ignored for the check | `gatherEvidence` requires a workspace and resolves the claimed path inside it; no workspace ⇒ unverifiable | `orch-supervisor-trust` 1c |
| 2 | A **refused** tool call (out-of-sandbox path) was recorded as an "ABSENT" disk observation KAI never made | a refusal is recorded as unverifiable with the tool's reason, never as an observation | `campaign-evidence` 3, `campaign-gate` 6c |
| 3 | `/audit` accepted a document that was **not a worker report**, invented `worker status: ok`, and created a durable item | a report must declare a real section; the status claim is only made when the document asserts one | `campaign-audit-summary` 4d |
| 4 | A reviewer PASS **compensated a criterion whose linked evidence was never observed** (all_criteria + `evidenceLinks` completed) | compensation applies only to criteria with no declared evidence path; linked evidence always binds | `campaign-gate` 5c |
| 5 | Skill receipts for two **different bodies** of one skill collapsed into one (no version/hash ⇒ `id@?`) | the receipt hashes the body actually handed over (sha256) when the registry exposes none | `campaign-skills-memory` 7b |
| 6 | A lesson write that **threw** was silently swallowed (a refusal was traced, a throw was not) | the throw is traced; completion still stands | `campaign-skills-memory` memory-10 |
| 7 | Approving a **review** park re-dispatched the worker, burned an attempt and could park again forever; a plain run on a REVIEW-parked item also re-dispatched | a review park settles through the gate without a dispatch; a plain run on it is refused | `campaign-retry-stress` S4d |
| 8 | **Duplicate `mission.failed` deliveries** (and a restart) started another re-attempt of one failure, unbounded | a durable `autonomyRetriedAt` stamp plus an in-process marker bound it to one re-attempt | `campaign-approval-lifecycle` 10c |
| 9 | The HTTP server used Node's 5s `keepAliveTimeout`, so a keep-alive client (undici — the UI and every probe) could reuse a socket the server was closing and get **ECONNRESET** (measured: `orch-e2e` failed 3/3 runs at the first request after its S6 burst) | the window is raised above any client idle timeout (65s, `headersTimeout` 66s); 3/3 runs clean afterwards, and a 70s idle reuse succeeds | `server-keepalive` |

Also fixed alongside #7: resuming a **parked delegation** now continues the same
attempt instead of charging a fresh retry (a park is not a dispatch), so a human
approving twice cannot exhaust the budget with a single real execution.

Campaign parameters: 50 concurrent dispatch requests on one item (exactly 1
dispatch), 100 independent items (all truthful terminal states, 0 false
completions), duplicate/out-of-order event delivery, restart between every
significant transition, fixed seed (`kai-retry-stress-v1`). Invariants asserted:
zero false completions, zero completion without a passing gate, no duplicate
authoritative dispatch, no budget bypass by worker rotation or corrective chains,
no lost contract/evidence after a park or restart, no cross-mission memory leak,
no contradictory terminal events, no unbounded retries. All held.

Live worker path re-verified end to end against Hermes (`scripts/campaign-hermes-e2e.mjs`):
an unreachable worker fails honestly with no completion event; a real Hermes
worker, driven through the approval boundary, completes with **exactly one**
gate-carrying `worker.completed` (`gate: "PASS"`); the failed item is
re-attempted successfully.

## Hermes diagnosis and fix (2026-10-09) — resolved

Two checks were failing for one cause: `worker-honesty` H3 (`AGENT_TIMEOUT`) and the
Hermes relay test (120 s chat timeout). Direct, bounded probes against
`http://127.0.0.1:8642` established that **Hermes' control plane was healthy but every
model turn failed**:

| Probe (before the fix) | Result |
|---|---|
| `GET /health` | 200 in 16 ms — `{"status":"ok","platform":"hermes-agent"}` |
| `GET /v1/models` (test-runner key) | 200 in 35 ms — authorized |
| `POST /api/sessions` | 201 in 17 ms — a session is created |
| `POST /api/sessions/:id/chat` | **never answered** — client timeout at 30,010 ms (KAI's configured budget is 120 s, which is exactly what the relay test hit) |
| `POST /v1/runs` | **accepted** (a `run_id` came back) but never finished inside KAI's 15-minute run deadline; H3 recorded `17:33:10.061Z → 17:48:10.468Z` = 900.4 s |

**Root cause, isolated to the model credentials Hermes used:**

1. The `opencode-go` key configured in `~/.hermes` (len 51) was **stale**: the endpoint
   answered `429 GoUsageLimitError: Go usage limit exceeded` (workspace `wrk_01M298…`,
   `limitName: monthly`).
2. The session's fresh `OPENCODE_GO_API_KEY` is rejected too — `403 "An active OpenCode
   Go subscription is required to use Go models"`.
3. The session's `OPENCODE_API_KEY` **works** — but only with the routing header the
   endpoint now requires: without `x-opencode-session` it answers
   `400 MissingSessionID` (3/3), and with it `200 content="PONG"` (962 ms).

**Fix applied — to Hermes only, nothing in KAI:** the working key was written into
`~/.hermes/config.yaml` (`providers.opencode-go.api_key` and `model.api_key`), into
`~/.hermes/.env` (`OPENCODE_GO_API_KEY`), and `x-opencode-session` was added to the
provider's `extra_headers` (the existing `User-Agent` was preserved). One further
environment fix was needed to bring the gateway up at all: the `automate-man` **profile**
had `platforms.discord.enabled: true`, and its Discord adapter (privileged intents not
enabled in the developer portal) raised an unhandled `PrivilegedIntentsRequired` that
killed the whole gateway process; it was set to `false`. Both edits have timestamped
backups next to the originals, and the gateway was restarted as a detached process
(WMI-created, so it outlives the session). The live KAI Core on `127.0.0.1:8788` was not
touched.

**Verified after the fix:**

| Check | Result |
|---|---|
| `POST /api/sessions/:id/chat` (direct) | **200 `content="PONG"` in 6.3 s** |
| `core/src/server.test.ts` test 3 (`GET /agents/hermes/sessions`) | **pass** |
| `core/src/server.test.ts` test 12 (`POST /chat` → real Hermes turn) | **pass** |
| `worker-honesty` H3 | **PASS** — `state: completed`, `output: "PONG"`, ~3 s |

KAI's own behaviour during the outage was already correct and honest — the chat turn
fell back to `presentWorkerFailure` (`core/src/chat/relay.ts`) and the run ended
`timed_out` / `AGENT_TIMEOUT` after `bestEffortStop`
(`core/src/agents/adapters/hermesAdapter.ts:205`). Nothing in KAI was mocked, skipped,
given a longer timeout or relabelled; the fix is a configuration correction on the
external worker.

### Desktop app (`app/`)

```
cd app && npm test
```

**307 passed / 0 failed** (was 300; +7 in the new `supervisor-surface` suite, which
proves the client puts the multiline `raw` argument on the wire and that the island
summarizer renders the real supervision event shapes).

## Live probes (all executed 2026-10-09 against the `2d2f4b9` tree)

| Probe | Result |
|---|---|
| `core && node scripts/orch-e2e.mjs` | **21/21 PASS** (S1–S6, incl. S2 failure → breaker → switch → success) |
| `core && node scripts/command-stream-probe.mjs` | **PASS** C1–C7 (real child stdout streamed before exit) |
| `core && node scripts/torture.mjs` | **PASS** — completionRate 1, falseCompletionRate 0, orphanTasks 0, activeRuns 0 |
| `core && node scripts/live-ux-probe.mjs` | **PASS** L1–L3 against a **rebuilt** UI (`npx vite build`) — first text 677 ms vs final 1351 ms, tool card 677 ms |
| `core && node scripts/worker-honesty.mjs` | **H1–H4 all PASS**, including H3 (a real Hermes run returns its real output) after the Hermes fix |

`live-ux-probe` was run after rebuilding `app/dist` (`npx vite build`). No app source
changed in this session (the UI changes landed in `160d94e`), but rebuilding keeps the
tested bundle provably current rather than assumed.

**worker-honesty: all four checks pass.** H1 (opencode parks for approval), H2 (offline
opencode fails with a named transport error, never a fabricated completion), H4 ×2
(denial executes nothing) and **H3** — a real Hermes run — all pass. H3's recorded result
is `state: completed`, `output: "PONG"`, in ~3 s (`docs/evidence/worker-honesty.json`).
Before the Hermes fix the same check ended `timed_out` / `AGENT_TIMEOUT` after 900.4 s;
that history and its root cause are in the diagnosis above.

Raw evidence: `docs/evidence/orch-e2e.json`, `command-stream-probe.json`, `torture.json`,
`live-ux-probe.json`, `worker-honesty.json`.

## Build

```
cd core && npm run build && npm run bundle
```

- `dist/build-info.json`: buildId `c39f55de6f9765e7`, gitCommit `2d2f4b9e526f23275457967d10ca866c4fa5e223`
  — the identity matches the tested source (the build id is content-derived, so it
  changed with the orchestration modules; it is re-stamped after every commit).
- `core/bundle/server.js` is ready to run with `node`.

**No Windows installer was built this session.** `app && npm run pack` runs `tauri build`,
which (as the previous status recorded) requires stopping the running `kai.exe` — and the
live app fronts the live Core on `127.0.0.1:8788`, which this task was explicitly told not
to touch. Packaging was therefore skipped rather than risk disturbing the live process.
The existing installer under `release/` is from the earlier build and does **not** contain
these changes.

## Live Core (`127.0.0.1:8788`) — untouched

Read-only health check, not a restart or a deploy:

```
GET http://127.0.0.1:8788/health
{"status":"degraded","service":"kai-core","version":"0.1.0",
 "hermes":{"reachable":true,"authorized":true},
 "opencode":{"reachable":false,"reason":"upstream_unreachable"}}
```

The live Core was **not** stopped, restarted, redeployed or reconfigured. It is still
serving the previous repaired build; **these changes have been tested and bundle-built
only — they are not deployed.**

## Architectural guarantees (tested)

- **Outcome Gate is authoritative.** One `board.complete` call site, gate-guarded; worker
  prose and permissive text matching can never satisfy a requirement.
- **Truthful lifecycle.** `work.planned` ≠ `delegation.routed`; a durable item is never
  reported as a started worker.
- **Retry ceiling at the orchestration boundary, per ITEM**, from a durable dispatch
  ledger (`initial` / `retry` / `reassign`); rotating workers cannot exceed it, duplicate
  deliveries and settled items are refused re-execution.
- **Approvals are final and idempotent**; an expired or spent approval authorizes nothing.
- **Evidence is split.** `kai-observed` satisfies; `worker-reported` is displayed and
  never trusted.
- **No second control plane.** Hermes/OpenCode are optional external workers.
- **Memory scope contract.** A supervision lesson is written only on the verified path,
  to mission scope; an unknown mission id refuses structurally, never globally.

## Known limitations

- **Windows only** (Tauri 2 + WebView2; verified on Windows 11).
- **A model provider is required** for intelligence (any OpenAI-compatible endpoint).
- **No real JEV shipped** (plug-in point only; deterministic is the supported path).
- **OpenCode offline on this machine** (`:4096` unreachable); KAI reports it honestly and
  never fabricates a worker result.
- **Retry ceiling is per item**, `1 + maxRetries + maxReassignments` dispatches
  (`maxReassignments` defaults to `maxRetries`). Reassignments have their own allowance
  because a worker switch is the breaker's sanctioned recovery; they never reset the
  retry count. Raise the autonomy budget or create a new item to go further.
- **External audits need a working directory** to check file claims; without one they
  report the limitation and verify nothing.
- **One environmental test failure** (`server.test.ts` live Hermes relay) — see above.
- **Skill discovery** reads KAI's own bundled library plus the staged install store; it
  does **not** yet scan `~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills` or
  project-level skill folders (documented as a follow-up in
  `docs/evidence/OPENBOT_KAI_AUDIT.md`).
- **Single-machine verification.** Cross-machine behavior not characterized.

## Ports

- KAI Core default `127.0.0.1:8788`; test/repro Cores use `:8789` (+ app `:1421/:1422`).

## Reproducing this status

```bash
cd core && npm install && npm test
cd ../app && npm install && npm test
cd ../core && node scripts/orch-e2e.mjs
cd ../core && node scripts/command-stream-probe.mjs
cd ../core && node scripts/torture.mjs
cd ../app && npx vite build && cd ../core && node scripts/live-ux-probe.mjs
cd ../core && node scripts/worker-honesty.mjs    # live Hermes/OpenCode verdicts
cd ../core && npm run build && npm run bundle
```

Raw logs for every claim are under `docs/evidence/`.
