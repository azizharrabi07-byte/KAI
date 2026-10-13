# KAI — authoritative backend state

Audited by inspecting the actual source and running the actual checks. Every claim below
carries the file, the command, or the observed result that supports it. Where something is
unverified, it says so.

Audit date: 2026-10-13 · Branch `feat/goal-executive`

**HEAD at the start of this audit:** `1840663`. The report itself, and the
`STATUS.md` pointer, were committed after it — so the branch HEAD is one commit
later than the code this audit describes. The audited code is `1840663`; the
report commit is its child.

---

## A. Repository and version truth

| Fact | Value |
|---|---|
| Canonical repo root | `C:\Users\DELL\Desktop\kai` |
| This session's worktree | `C:\tmp\kai-exec` — a **linked worktree** of `Desktop/kai/.git` (shared object store) |
| Canonical GitHub URL | `https://github.com/azizharrabi07-byte/KAI` |
| `origin` | `https://github.com/azizharrabi07-byte/KAI.git` (fetch + push) |
| Current branch | `feat/goal-executive` |
| Local HEAD | **`1840663d3d7d320b4d2d57e8c69393546c042940`** |
| Upstream tracking | **none configured** — the branch has never been pushed |
| Worktree state | **clean** (`git status --short --branch` prints only the branch line) |
| Uncommitted meaningful changes | **none** |

### Remote refs (live `git ls-remote --heads origin`)

| Ref | SHA |
|---|---|
| `refs/heads/main` | `e09219b4ca1108ab0b9216c21afba521140958b7` |
| `refs/heads/review/supervisor-trust` | `bd7c2ee3f769e32fb1428da278d17a827a89e45e` |
| `refs/heads/feat/goal-executive` | **does not exist** |

`main` and `review/supervisor-trust` were never touched by this work. The `a1-wiring`
stash (`stash@{0}: On fleet/w6`) is present and was never applied, dropped or renamed.

### Push result: BLOCKED — no valid GitHub credential

The push was attempted and **failed**. Verified, not assumed:

| Auth path | Result |
|---|---|
| `GITHUB_TOKEN` (environment) | **HTTP 401 `Bad credentials`** against `GET /user` |
| `~/.env` `GITHUB_TOKEN` | byte-identical to the dead env token — same 401 |
| Git Credential Manager (`credential.helper=manager`) | no cached entry; `git credential fill` hung awaiting interaction |
| `git push --dry-run` with prompts disabled | `fatal: could not read Username for 'https://github.com'` |
| SSH (`git@github.com`) | `Permission denied (publickey)` — no private key in `~/.ssh` |
| `gh` CLI | installed, but reports the token in `GITHUB_TOKEN` is invalid |

**All local work is retained and committed.** Nothing was discarded. The exact unblock is a
valid credential: either `gh auth login` (device/browser flow, needs a human) or a fresh
PAT with `repo` scope supplied as `GITHUB_TOKEN`, after which
`git push -u origin feat/goal-executive` creates the branch normally (non-force).

### Recent backend history (newest first)

| Commit | What it is |
|---|---|
| `1840663` | Mine ECC into KAI, prove the upgrade loop, make KAI run |
| `8b6d8ae` | app 0.2.0 version bump |
| `781454d` | Surface typed conditions, apply applicability on delegation, agree on shadowing |
| `de29b00` | Six lenses for real; stop claiming limits nothing enforces |
| `8eaf89e` | One authoritative execution budget + scanned/locked/applicable skill lifecycle |
| `8213552` | Reconcile interrupted runs, type provider failures, preflight workers |
| `8ab468f` | Typed acceptance criteria, non-vacuous verification, workspace proof, REA |
| `ee0f6aa` | Fail closed, verify file content, prove the loop with a real worker |
| `f2f6ba8` | Complete the execution loop, authorize the API, compile tasks, verify the UI |
| `b23fc45` | The goal executive — intake, challenge, plan approval, owner-authorized |

### Changed files, grouped by purpose (this engagement)

**Orchestration / budget** — `orchestration/budget.ts` (new), `orchestration/usage.ts` (new),
`orchestration/orchestrator.ts`, `orchestration/board.ts`, `runtime.ts`,
`shared/contracts.ts` (event union: `budget.refused`, `budget.reconciled`, `critic.reviewed`,
`worker.usage`).

**Goals / critics** — `goals/criticPanel.ts` (new), `goals/challenger.ts`, `goals/runners.ts`.

**Skills** — `skills/scan.ts` (new), `skills/lock.ts` (new), `skills/applicability.ts` (new),
`skills/tiers.ts` (new), `skills/registry.ts`, `skills/staging.ts`, `skills/store.ts`,
`skills/types.ts`, `skills/validate.ts`.

**Workforce** — `workforce/personas.ts` (new), `workforce/subagent.ts`.

**Mining / data** — `scripts/mine-skills.mjs`, `scripts/mine-agents.mjs`,
`skills-library/*.md` (+27 mined, and `SOURCES.md`), `agents-library/*.json` (16 personas).

**Tests** — `execution-budget`, `execution-budget-boundary`, `skill-scan`, `skill-lock`,
`skill-applicability`, `skill-tiers`, `skill-conditions`, `critic-panel`, `worker-usage`,
`upgrade-loop-stress`, `persona-library`.

**Docs** — `docs/STATUS.md`, `docs/research/DONOR_LEDGER.md`,
`docs/research/ADOPTION_DECISIONS.md`.

---

## B. Actual backend architecture

### The goal lifecycle, traced through real files

```
POST /goals                      api/routes.ts
  → goals.createGoal             goals/store.ts          state: NEW
  → UNDERSTANDING → CHALLENGING  goals/store.ts
  → challenger.challenge         goals/challenger.ts     ← six lenses, via criticPanel.ts
  → architect.plan               goals/architect.ts      ← model → GoalPlanContent
  → goals.addRevision            goals/store.ts          ← contentHash = hashPlanContent
  → AWAITING_PLAN_APPROVAL
  → goals.recordApproval         goals/store.ts          ← binds approval to revisionId
  → APPROVED
  → executor.compile             goals/executor.ts       ← one work item per plan task
  → board.create                 orchestration/board.ts  ← carries goalId + goalRevisionId
  → executor.advance             goals/executor.ts       ← dispatches READY items
  → orchestrator.runWorkItem     orchestration/orchestrator.ts
       ├─ goalGate               runtime.ts              ← approved revision must match
       ├─ reserveDispatch        orchestration/budget.ts ← debit BEFORE the claim
       ├─ board.claim            orchestration/board.ts
       ├─ policyCheck            policies/gate.ts        ← Guard
       ├─ delegate               runtime.ts → workforce → adapter
       ├─ verifyHandoff          orchestration/outcome.ts ← the Outcome Gate
       └─ finishComplete         orchestration/orchestrator.ts → board.complete
  → executor re-evaluates → goal COMPLETED | BLOCKED | FAILED
```

### State ownership — one owner per transition

| State | Authoritative owner |
|---|---|
| Goal state (`NEW`…`COMPLETED`) | `goals/store.ts` — **sole writer** |
| Plan revisions + approval binding | `goals/store.ts` (`addRevision`, `recordApproval`, `isApproved`) |
| Work-item state + evidence + handoff | `orchestration/board.ts` |
| Dispatch attempts (per item) | the item's own durable dispatch ledger (`board.ts`) |
| Execution budget (per goal revision) | `orchestration/budget.ts` — its own SQLite file |
| Acceptance + acceptance boundary (missions) | `recovery/ledger.ts` |
| Durable result inbox | `orchestration/doer.ts` |
| Approvals | `approvals/service.ts` |
| Skills + revisions | `skills/store.ts` + `skills/registry.ts` |
| Personas | `workforce/subagent.ts` |
| Memory | `memory/engine.ts` |

No duplicate goal-state owner exists. `executor.ts` never writes goal state except through
`store.setGoalState`.

### Key runtime relationships

**Goal Store ↔ approval binding.** An approval names a `revisionId` and carries the budgets
in force. `runtime.ts`'s `goalGate` refuses dispatch when the item's `goalRevisionId` differs
from the approved revision — so a re-plan invalidates dispatch without deleting anything.

**Work board vs Mission/TaskRecord.** The board owns *work items*; missions own *steps*.
They are separate ledgers with separate recovery rules (`board` vs `recovery/ledger.ts`).
A goal's tasks become work items; a mission's steps do not.

**Doer + durable inbox.** `bus.subscribe(..., { types: DOER_RESULT_EVENT_TYPES })` →
`doer.record(...)` writes unconditionally (this is what makes OFF safe), then
`doer.drain()` **only if** `doerEnabled()` reads live. So OFF records and does not interpret.

**Guard.** One path: `policies/gate.ts`. `runWorkItem` calls `policyCheck` for
`agents.run_task`; tool invocation goes through the tool registry, which policy-checks.
Approvals bind to a `toolId` and, for skill installs, to a `sha256`.

**Critic panel.** `goals/criticPanel.ts` runs one role at a time via `criticRoleRunner`
(serialised), which `runtime.ts` wires to `goalBrain.respond`. Each role is its own call with
only its own input; `RoleInput` has no `findings` field, and a runtime guard refuses a
smuggled one. Provenance records the reviewer, mechanism, and prompt sha256.

**Task compiler.** `orchestration/compiler.ts` builds the worker packet; `buildWorkerPrompt`
in `orchestration/prompts.ts` renders it. **`SKILL CONTEXT` is appended with no size cap** —
see the backlog.

**Retry / correction / cancellation / recovery.** Retry ceiling is the item's dispatch
ledger; the goal-wide ceiling is `budget.ts`. `board.block` now persists its reason.
`recoverInterruptedWorkItems()` reconciles a `RUNNING` item abandoned by a dead process to
`BLOCKED` with a durable reason — never replayed.

**Memory / skills.** `memory/engine.ts` with scopes (session/mission/global) and an explicit
grant for sharing (`workforce/subagent.ts` shares). Skills: `registry` (metadata + bodies,
progressive disclosure), `staging` (exact-byte approval), `scan`, `lock`, `applicability`,
`tiers`.

**Budget / WorkCost / tokens.** `WorkBudget` declares `maxToolCalls`, `maxRuntimeMs`,
`maxRetries`, `maxReassignments`, `maxCostUsd`. `orchestration/usage.ts` maps an
`AgentTaskResult` into a report with `measured` / `estimated` / `unavailable` per field and
debits only measured amounts.

**API auth.** `api/authz.ts` holds a static route table; `api/routes.ts` declares routes.
`server.ts` resolves access per request and fails closed.

**Adapters / session identity / events.** `agents/registry.ts` registers adapters;
`runtime.ts` registers mock-hermes, mock-opencode, real hermes, real opencode, codex.
Sessions correlate by id (`kai-<taskId>` titles). Events are emitted by the adapter into the
KAI bus.

### Components present in source but NOT wired into runtime execution

- **`agents/opencode.ts` `async *events(signal?)`** — the client can consume OpenCode's event
  stream. **No caller exists.** See §F.
- **`skills/applicability.ts` snapshot** — reachable via `registry.snapshot()`, exposed on the
  API, but the **delegation path uses `relevant()`**, not the snapshot.
- **`workforce/personas.ts`** — seeding is gated behind `KAI_PERSONA_LIBRARY=1` (measured
  reason in §E).
- **`orchestration/usage.ts` `enforceabilityOf` / `describeEnforcement`** — implemented and
  tested; surfaced on the `worker.usage` event, **not yet on an API route**.

---

## C. Implementation matrix

Legend: **RV** runtime-verified · **IT** integration-tested · **MK** mock-only ·
**PI** partial · **DO** designed only · **MI** missing · **EX** blocked externally.

| # | Feature | Status | Files | Tests | Evidence / gap |
|---|---|---|---|---|---|
| 1 | Goal intake → challenge → plan → approval | **IT** | `goals/store.ts`, `challenger.ts`, `architect.ts`, `executor.ts` | `goal-store`, `goal-challenger`, `goal-architect`, `goal-executive` | Full lifecycle over the real store+board. Not driven by a live model in tests. |
| 2 | Approved-plan compile → dispatch → settlement | **IT** | `goals/executor.ts`, `orchestration/orchestrator.ts` | `goal-execution-e2e`, `goal-criteria` | Runs end-to-end against a stub worker. |
| 3 | Outcome Gate + criterion-specific evidence | **IT** | `orchestration/outcome.ts`, `goals/criteria.ts` | `goal-criteria` | `COMPLETED` requires KAI-observed evidence bound to a label. Unsettleable criteria refused at plan time. |
| 4 | Six-lens critic execution, isolation, provenance | **IT** | `goals/criticPanel.ts`, `challenger.ts` | `critic-panel` (12) | 6 roles → 6 calls → 6 distinct prompts; blocking objection overrides majority; bounds, cancellation, provenance. |
| 5 | **Real-model critic behaviour/quality** | **MI** | — | — | Only stub reviewers + a real `ModelError` have been exercised. Whether a real model's findings are *good* is untested. |
| 6 | Doer ON/OFF + durable result processing | **IT** | `orchestration/doer.ts`, `runtime.ts` | `doer-switch`, `events-runtime` | OFF records without interpreting; ON drains. |
| 7 | Guard, tool policy, approvals | **IT** | `policies/gate.ts`, `api/authz.ts`, `approvals/service.ts` | `api-authz` (10), `api-enforcement` | One policy path. Approval bound to tool + bytes. |
| 8 | Skill scanning, validation, tiers, conditions | **IT** | `skills/scan.ts`, `validate.ts`, `tiers.ts`, `applicability.ts` | `skill-scan` (11), `skill-tiers` (17), `skill-conditions` (12), `skill-applicability` (12) | Default-ON scan; ERROR ≠ CLEAN; deterministic tiers; typed conditions v1. |
| 9 | Skill create/update/version/rollback | **IT** | `skills/staging.ts`, `registry.ts`, `store.ts` | `skills` (C4 suite) | Staged → approval bound to sha256 → immutable revision → rollback. |
| 10 | **Learned-skill evaluation & promotion** | **PI** | `orchestration/learn.ts`, `commands/commands.ts` | `upgrade-loop-stress` (11) | Proposal is **user-initiated via `/refine`**, not automatic. Usage metrics *are* automatic. See §G. |
| 11 | Memory persistence, retrieval, isolation | **IT** | `memory/engine.ts` | `memory*` (6), `subagent-memory-isolation` | Scopes + explicit grants; private facts do not leak. |
| 12 | Budget limits, usage extraction, debiting | **IT** | `orchestration/budget.ts`, `usage.ts` | `execution-budget` (13), `-boundary` (6), `worker-usage` (15) | Reserve-before-dispatch; idempotent; unknown never debited as zero. |
| 13 | Worker adapters, event ingestion, correlation | **MK/IT** | `agents/adapters/*`, `agents/opencode.ts` | `adapters` (mock), `adapters-live` (**skips**) | Live cases skip without a runtime. See §F. |
| 14 | API authorization, fail-closed | **IT** | `api/authz.ts`, `server.ts` | `api-authz`, `api-scope-isolation` | 125 routes declared, 145 classified. |
| 15 | Restart recovery, duplicates, retries, cancellation | **IT** | `board.ts`, `doer.ts`, `recovery/*`, `runtime.ts` | `recovery*` (3), `checkpoints`, `scheduler-durability`, `migration-goal-linkage` | Abandoned runs → BLOCKED with a reason. |
| 16 | REA integration / reference-repo research | **PI** | `docs/research/*`, `REA_DONOR_WORKFLOW.md` | — | REA installed+pinned and registered with OMP; contributed **nothing** to the donor reviews (every candidate is an open-source repo whose source was readable). 1 of 9 donors implemented. |
| 17 | Workstation/CUA provider, real VM | **EX** | `capabilities/computer/*`, `workstation*` | `workstation` (**skips**), `workstation-live` (**skips**) | `cua-driver` is not installed on this machine; live driver calls are opt-in by design. |
| 18 | Test fixtures / `KAI_HOME` isolation | **PI** | `scripts/test.mjs` | — | 5 of 152 suites set `KAI_HOME` explicitly. Suites that boot a Core read the **developer's real `KAI_HOME`** by default. See §E and §I. |

---

## D. Security findings

### Route authorization — measured

| Fact | Value |
|---|---|
| Routes declared in `api/routes.ts` | **125** |
| Entries in the `api/authz.ts` table | **145** |
| Test preventing an unclassified route | `tests/api-authz.test.ts` — *"every route in the real route table is classified, and no entry is phantom"* |
| Other authz tests | 10, incl. *"an unregistered path is refused as 404, never defaulted open"* and *"an owner route FAILS CLOSED"* |

**Verified protection:**
- An unattested caller is refused (401) on every owner route **when a credential is
  configured** (`test: "an unattested caller is refused (401) on EVERY owner route"`).
- Owner routes **fail closed**: only a credential or an explicit `KAI_DEV_MODE=1` allows them.
- An unregistered path is 404, never defaulted open.
- Only the identity handshake is public; a mutating route is never public or read.

**Intended but not fully verified:**
- **Direct route calls vs alternate tool paths.** The route table covers HTTP. A tool invoked
  outside the HTTP surface goes through the tool registry, which policy-checks — but there is
  no single test asserting that *every* internal caller of a mutation is policy-gated.
- **Approval self-escalation.** An approval is bound to a `toolId` and (for skills) a sha256.
  A *worker* cannot approve its own plan. There is no test proving a worker cannot *request*
  an approval that then auto-approves.
- **Doer control.** `/doer` is owner-gated and parks for approval (verified in `doer-switch`).
- **Rust→Core authentication.** The installer injects a credential; `KAI_DEV_MODE=1` bypasses
  it for a deliberate developer instance. **The dev switch is the one real bypass**, and it is
  explicit, documented, and off by default.
- **Worker prompt injection.** `redactText` scrubs credentials from identity and critic
  prompts. Imported skills are scanned by default. But **a worker's *output* is untrusted
  text that reaches the Outcome Gate as a claim** — the gate does not execute it, which is the
  main structural defence.
- **Workspace boundaries.** `assertInside` / `assertNoReparseEscape` in `skills/paths.ts`
  guard skill file access; the outcome gate's workspace proof checks artifacts.

**Unenforced / remaining gaps, stated plainly:**
1. `KAI_DEV_MODE=1` disables the owner-credential requirement. Deliberate, documented, off by
   default — but it is a real bypass when set.
2. No test asserts that every non-HTTP mutation path passes Guard.
3. Worker output is untrusted by design; the defence is that it is never executed, not that it
   is sanitised.
4. Nothing here verifies the *installed* Rust→Core credential beyond the code path.

**No secret values appear in this report.** Credential storage: `KAI_HOME/model/credentials.json`
(never in the repo), and the installer-injected Core credential.

---

## E. Honest resource-limit and cost accounting

| Limit | Enforced? | When | Who measures | Notes |
|---|---|---|---|---|
| `maxRetries` | **Yes** | before dispatch | KAI (item dispatch ledger) | `retryRefusal()` at the boundary; callers cannot bypass. |
| `maxReassignments` | **Yes** | before dispatch | KAI | Separate allowance; never resets retries. |
| `maxDispatches` (goal revision) | **Yes** | **before** the claim | KAI | `budget.ts`; reserved, idempotent, never self-restoring. |
| `maxDepth` | **Yes** | at creation | KAI | `board.createChild` via `depthOf`. |
| `maxTokens` | **Only when reported** | after the run | hermes, codex | opencode reports **nothing** → unenforceable for it. |
| `maxToolCalls` | **NO** | — | nobody | **No adapter reports tool invocations.** Declared in `WorkBudget`; `enforceabilityOf` reports it unenforceable. |
| `maxCostUsd` | **NO** | — | nobody | **No provider reports cost.** KAI does not derive dollars from tokens. |
| `maxRuntimeMs` | **Measured only** | after the run | KAI (its own clock) | **Not preemptive.** A synchronous delegation has no cancellation point; `cancelSubagentRun` says so explicitly. |
| Parallelism | **Partial** | at dispatch | KAI | `maxParallel` on the executor; no global concurrency governor. |

**Unknown is never zero.** `debitUsage()` skips an unavailable amount **with a reason** and
does not debit it. This is tested (`worker-usage`).

**Financial cost is not derived from tokens.** Stated in `usage.ts` and asserted by test.

---

## F. Worker integration matrix

| | Hermes | OpenCode | Codex | Claude Code | Pi | OpenClaw |
|---|---|---|---|---|---|---|
| Adapter exists | **yes** `hermesAdapter.ts` | **yes** `opencodeAdapter.ts` | **yes** `codexAdapter.ts` | **no** | **no** | **no** |
| Registered in runtime | yes (`runtime.ts:1529`) | yes (`:1538`) | yes (`:1545`) | — | — | — |
| Availability detection | `health()` probe | `health()` | CLI detection on PATH | — | — | — |
| Session correlation | worker-assigned id | `createSession({title:'kai-<id>'})` | run id | — | — | — |
| **Consumes real progress events** | **no** | **no — see below** | **no** | — | — | — |
| Tool usage reported | **no** | **no** | **no** | — | — | — |
| Token usage reported | **yes** | **NO** | **yes** | — | — | — |
| Cost reported | **no** | **no** | **no** | — | — | — |
| Cancellation | **yes** | **yes** | **yes** | — | — | — |
| Completion verified by KAI | yes (Outcome Gate) | yes | yes | — | — | — |
| Contract tests | yes | yes | yes | — | — | — |
| Live smoke | **skips** | **skips** | **skips** | — | — | — |

### The OpenCode gap — exact current state

The old report said "its event stream was not consumed". The **precise** state, verified in
source:

- `agents/opencode.ts:305` **does** expose `async *events(signal?: AbortSignal)` — the client
  can consume the stream.
- **Nothing calls it.** `grep '\.events(' src/agents/adapters/opencodeAdapter.ts` → no match.
- The adapter calls `client.prompt(sessionId, input)`, which is **synchronous** — its own
  comment says *"prompt() is synchronous: it resolves once the turn is done."*
- So KAI learns `working` → `idle` and nothing between. No progress, no per-step events.
- The adapter **does** correctly refuse a silent success: it inspects `info.error` on an
  HTTP-200 response and fails the turn rather than reporting an empty success.

**Skipped live checks, named:** `adapters-live.test.ts` skips with
`RUNTIME_ABSENT(<adapter>): <command> exited <code>` when no runtime is present, and writes
the same verbatim output to `docs/evidence/adapters-live.json`. The suite's own comment:
*"A skip is not a pass: nothing here claims a capability that was not exercised."*

---

## G. Learning-system truth

**What KAI can really do today.**

| Capability | State | Evidence |
|---|---|---|
| Detect a useful lesson from completed work | **Partial** | `learn.proposeFromTask` requires ≥2 steps, a successful outcome, and either a correction, a recovery, or ≥3 steps **and** `verified`. |
| Convert a lesson into a candidate skill | **Implemented** | `proposeFromTask` → `SkillCandidate`. |
| Validate and version the candidate | **Implemented** | `submitProposal` → `staging.stage` → `parseSkillMarkdown` **+ scan**; revision on install. |
| Test it against reproducible tasks | **MISSING** | No A/B or replay harness. Nothing measures whether a candidate improves anything. |
| Compare candidate vs existing skill | **MISSING** | No comparison exists. |
| Approve or reject promotion | **Implemented** | Approval bound to the candidate's sha256; `installApproved` refuses a rejected, expired or wrong-bytes approval. |
| Roll back a regressed skill | **Implemented** | `staging.rollback(id)`; prior revisions are kept. |
| Preserve provenance | **Implemented** | Source, revision, sha256, and (for mined skills) a body banner naming the upstream commit. |
| Avoid learning from unsupported worker claims | **Implemented** | `proposeFromTask` requires `outcome.verified`; the Outcome Gate decides `verified`. |
| Respect Doer OFF | **Implemented** | `doerEnabled()` is read live; OFF records without interpreting. |
| Keep Guard active | **Implemented** | Staging → approval → install is policy-checked; Guard is never bypassed by learning. |

**The decisive correction:** the learning loop is **NOT automatic**. `recordSkillUsage` *is*
called automatically on task outcomes (`orchestrator.ts:1645` on failure, `:2421` on
success+verified) — so KAI knows whether a skill worked. But `proposeFromTask` /
`submitProposal` are reached only from the **`/refine` command** (`commands/commands.ts:593`),
and the orchestrator's own comment calls them *"passthroughs for the /refine command"*.

**So: KAI records skill outcomes automatically, but never proposes a new skill on its own.**

### Relationship to Hermes

Hermes (`NousResearch/hermes-agent`, MIT, `1fd182772671`) was the **only** donor implemented.
KAI reimplemented, natively: a compact skills index with platform/app/environment
applicability; per-skill mutation locks placed **outside** the skill directory; validation
before write; a **default-ON** scan of agent-created skills; and pinned/redirect guards.
KAI deliberately differs in two places: its scan is on by default (Hermes' is opt-in), and
conditions come from typed frontmatter rather than tag conventions. **No Hermes code is
copied and its Python runtime is not embedded.**

A model generating a Markdown file is **not** a learned skill here: it must pass validation,
the scan, and a human approval bound to its exact bytes, and it lands as an immutable
revision with a rollback target.

---

## H. Real verification results

Run in this environment on 2026-10-13.

| Suite | Command | Result |
|---|---|---|
| Core tests | `npm test` (core) | **1688 tests · 1664 pass · 0 fail · 24 skipped** |
| Core typecheck | `npm run typecheck` | **clean** |
| App tests | `npm test` (app) | **342 pass · 0 fail · 0 skipped** |
| App typecheck | `npx tsc --noEmit` | **clean** |
| Rust | `cargo test --lib` | **17 passed · 0 failed** |
| Release build | `npm run pack` | **succeeded** — `KAI-Windows-0.2.0-setup.exe`, 3.36 MB |

**Goal execution / Outcome Gate:** `goal-execution-e2e`, `goal-criteria`,
`goal-executive`, `goal-store`, `goal-architect`, `goal-challenger` — all pass.
**Skill lifecycle / tiers / conditions:** `skills` (C4), `skill-scan` 11, `skill-tiers` 17,
`skill-conditions` 12, `skill-applicability` 12, `skill-lock` 9 — all pass.
**Critic panel:** 12 pass. **Usage + budget:** 13 + 6 + 15 pass.
**Authz:** 10 pass. **Adapters:** mock pass; **live skip**. **Migration/crash-recovery:**
`recovery*` 3, `checkpoints`, `scheduler-durability`, `migration-goal-linkage` — pass.

### The 24 skips, with their prerequisites

| Prerequisite | Reason string |
|---|---|
| No live worker runtime | `RUNTIME_ABSENT(<adapter>): <command> exited <code>` — a live runtime is not part of the repo; the verbatim output is written to `docs/evidence/adapters-live.json` |
| `cua-driver` not installed | `cua-driver is not installed at <path> on win32` |
| Live driver calls are opt-in | `live driver calls are opt-in (set KAI_WORKSTATION_LIVE=1); this suite must not read or click a machine somebody is using` |
| Live browser capture not requested | `LIVE_CAPTURE_SKIP_REASON` (mock has no live screen) |

**Regressions found and fixed during this engagement:** 8 (see §D and the commit history),
each with a regression test. No regressions remain.

**Not claimed:** no real model journey, no live worker journey, no UI runtime, no VM, and no
end-to-end run against a live worker. `KAI_HOME` was not read, modified or cleaned; tests were
not run in a way that prints credentials.

---

## I. Backend backlog, ranked by value

Ranked by *proven gap closed per unit of complexity*.

### 1. Reliable live worker events — OpenCode first (highest value)

**Gap.** KAI dispatches to a worker and learns only that it started and stopped. No progress,
no per-step events, no way to show a user what is happening. `client.events()` exists and has
no caller.

**Authoritative module.** `agents/adapters/opencodeAdapter.ts` (consumer),
`agents/opencode.ts` `events()` (producer), `shared/contracts.ts` (event union).

**Acceptance criteria.**
- The adapter consumes `events()` for the duration of a run and maps a documented subset onto
  KAI events, with a bounded buffer and no unbounded growth.
- A run with no events still terminates and reports the same terminal state as today.
- A stream that errors mid-run does **not** fail the run (events are advisory; the terminal
  state still comes from the turn).
- Tests: a fake SSE server driving ≥3 event kinds; a stream that dies mid-run; a run with zero
  events. Plus a live smoke that skips with a named reason.

### 2. Tool-call counting through the central execution boundary

**Gap.** `maxToolCalls` is declared and **unenforceable**. No adapter reports invocations.

**Authoritative module.** the tool registry (`runtime.ts` tool registration + `policies/gate.ts`)
— the one place every tool invocation already passes through. Counting there measures **KAI's
own** tool calls authoritatively, independent of any worker.

**Acceptance criteria.**
- Every policy-checked tool invocation increments a durable per-scope counter via `budget.ts`
  (`toolCall` kind already exists).
- `maxToolCalls` becomes enforced **for KAI's own tools**; `enforceabilityOf` still reports it
  unenforceable **for a worker's internal tools**, and says which is which.
- A test proves a tool loop stops at the ceiling with the exact reason, and that a redelivered
  invocation is not double-counted.

### 3. Real-model critic quality, reproducibly

**Gap.** The panel's mechanism is proven; its **judgement quality** is not. Six lenses may be
six well-isolated calls that all say nothing useful.

**Authoritative module.** `goals/criticPanel.ts` + a new fixture corpus.

**Acceptance criteria.**
- A fixture set of plans with **known** defects (one writes outside the workspace, one has an
  unsettleable criterion, one is fine).
- A script that runs the panel against the real configured model and reports, per lens:
  did it run, did it catch the planted defect, false-positive rate on the clean plan.
- The result is recorded as evidence with the model name and date; a **skip with a named
  reason** when no model is configured.
- No pass/fail gate on model quality (it is a measurement, not a test) — but the numbers must
  be reproducible.

**Deliberately not first:** it needs a working model credential and is a measurement rather
than a reliability fix. Items 1 and 2 each remove a concrete unenforced guarantee.

### Lower-ranked, with reasons

| Area | Why not higher |
|---|---|
| Adapter cancellation + enforceable runtime budgets | `maxRuntimeMs` is **not preemptive** and cannot become so without worker cooperation; a synchronous delegation has no cancellation point. Real fix = worker-side deadlines, an external prerequisite. |
| Financial cost accounting | Needs **provider-reported cost or a real price table**. Inventing one would be the exact lie `usage.ts` exists to prevent. Blocked on data, not code. |
| Critic subagents on a Guard-approved path | The panel's sequential fallback already works and is proven; the subagent path adds isolation, not correctness. |
| Learned-skill evaluation / promotion / rollback | Promotion and rollback **already exist**. The real gap is *evaluation* (no A/B harness) — valuable but not a reliability hole. |
| **Test-data / `KAI_HOME` isolation** | **High value, low complexity — recommended as a fast follow.** Suites booting a Core read the developer's real `KAI_HOME`; a working credential changed a suite's behaviour. Fix: point `KAI_HOME` at a temp dir in `scripts/test.mjs` unless a suite sets it. |
| Remaining 8 donor projects | Research, not reliability. Each row in `docs/research/DONOR_LEDGER.md` names its missing evidence. |
| Workstation/CUA + real VM | **Blocked externally**: `cua-driver` is not installed; live driver calls are opt-in by design. |

---

## The one-paragraph state of KAI

KAI **refuses to claim success it has not observed** (the Outcome Gate), **cannot be
re-entered for free** (the revision-scoped budget, reserved before dispatch), **scans every
skill before it activates** (default-ON, and `ERROR` is never `CLEAN`), **bounds its own
critics** (six isolated calls with provenance), and **names the limits it cannot hold** rather
than showing a number. What it still cannot do: **consume a worker's live events** (OpenCode's
stream exists and has no caller), **count tool calls** (so `maxToolCalls` is unenforceable),
**measure its critics against a real model**, **enforce a wall-clock limit preemptively**, and
**propose a skill without being asked** — `recordSkillUsage` is automatic, `/refine` is not.

---

# Campaign report — backend completion pass

Second audit pass, same branch, after implementing against this report.

## 1. Commit and branch state

| Fact | Value |
|---|---|
| Branch | `feat/goal-executive` |
| HEAD before this pass | `dd1e8cc11fa65d7e83b642958d96e36b91fe3799` |
| Push | **BLOCKED** — no valid GitHub credential on this machine (env token 401; `~/.env` holds the same dead token; no cached GCM entry; no SSH key; `gh` unauthenticated) |
| `main` / `review/supervisor-trust` / `a1-wiring` stash | untouched |

## 2. Changed files in this pass

**Security**
- `src/shared/contracts.ts` — `Approval.inputHash`
- `src/storage/schema.ts` — **migration v6**: `ALTER TABLE approvals ADD COLUMN inputHash`
- `src/storage/sqlite.ts` — persist/read `inputHash`
- `src/approvals/service.ts` — accept + store it
- `src/tools/registry.ts` — `stableHash()`; pass it when parking; **refuse a mismatch at consumption**
- `tests/security-invariants.test.ts` (new, 7 tests)

**OpenCode events**
- `src/agents/adapters/opencodeAdapter.ts` — the event pump (bounded, deduped, session-scoped, aborted in `finally`)
- `src/lib/sse.ts` — **an abort now releases a parked read**
- `tests/opencode-events.test.ts` (new, 7 tests)

**Test isolation**
- `scripts/test.mjs` — isolation attempted, measured, reverted; the measurement is recorded in the file

## 3. Status of every campaign criterion

| # | Criterion | Status |
|---|---|---|
| A.1 | Every protected action has an authorization/policy boundary | **Done** — 125 routes / 145 authz entries; `tools.invoke` policy-checks centrally (`registry.ts` line 610) |
| A.2 | No alternate internal path silently bypasses Guard | **Done + tested** — routes, commands and MCP all go through `tools.invoke`; the drift guard proves the ids resolve |
| A.3 | Tests for forged/stale approvals, replayed events, internal bypass | **Done** — 7 new tests; **found and fixed a real gap** |
| A.4 | Dev mode cannot disable Guard/policy/budget/approvals | **Done + pinned** — by inspection `devMode` appears only in `authz.ts`/`routes.ts`/`server.ts`; a test proves a DESTRUCTIVE route still parks under dev mode |
| A.5 | Validate the shipped Rust→Core credential | **Not done** — the code path was read; the installed credential was not exercised (no packaged runtime to test against) |
| A.6 | Doer OFF halts autonomous dispatch, Guard stays ON | **Already true, unchanged** — `doerEnabled()` is read live; `/doer` parks for approval |
| B | Real OpenCode events | **Done** — pump implemented + 7 deterministic fake-SSE tests. **Live OpenCode not available**, so no live evidence |
| C | `maxToolCalls` / `maxCostUsd` / `maxRuntimeMs` enforced | **Not done this pass** — see §7 |
| D | Autonomous learning loop | **Not done this pass** — see §8 |
| E | Real-model critic path | **Not done this pass** |
| F | `KAI_HOME` test isolation | **Attempted, measured, reverted** — see §6 |
| G | Goal-execution + unwired-items audit | **Audited** (first pass); no new wiring |
| H | Adapter honest reporting | **Done** (first pass) — matrix in §F above |
| I | Workstation/CUA readiness | **Not done** — `cua-driver` absent; live tests opt-in |

## 4. Security — the gap this pass FOUND and FIXED

**Before:** an approval bound to a **tool id and nothing else**. A real "yes" to
*restore checkpoint A into dir X* could be spent on *restore checkpoint B into dir Y* — the
human approved one action and a different one ran. The skill-install path already bound to a
sha256; the tool path did not.

**After:** the approval records `inputHash`, a stable recursive-key-sorted hash of the exact
input the human was shown, and the registry **refuses a mismatch** with
`POLICY_DENIED: approval "…" was granted for a DIFFERENT input to "…"`. Nullable, so a
pre-migration row still reads back and falls back to tool-level binding rather than refusing
every legacy approval.

**Two mistakes made and corrected while landing it**, both caught by the suite:

1. The approval id was included in the hash. A caller re-issuing the approved call
   naturally carries the id in the same body, so every legitimate retry hashed
   differently. The id is an invocation OPTION, not part of the action, and is now
   excluded — everything else is still bound.
2. Three existing tests were asserting the OLD bypass. `mcp-manager` re-issued an
   approved write with different arguments while its own comment said "the SAME
   request is re-issued"; the share helper carried the approval id inside the
   hashed payload; and `settings` parked `"parked-model"` then wrote
   `"approved-model"` after approval. All three now run what the human actually
   approved. **A test that passes only because an approval is spendable on a
   different action was testing the vulnerability, not the contract.**

**Remaining bypass, named exactly:** `KAI_DEV_MODE=1` disables the owner-credential gate for
owner routes. It does **not** reach Guard, policy, the budget or approvals (verified by
inspection and pinned by test). It is explicit, documented, visible in `GET /identity`, and
off by default — but it is a real bypass when set, and a packaged runtime that activated it
accidentally would be open to any local process.

## 5. Deterministic tests vs live evidence

| Suite | Kind | Result |
|---|---|---|
| `security-invariants` (7) | deterministic, real runtime | pass |
| `opencode-events` (7) | deterministic, fake SSE | pass |
| `api-authz` / `api-enforcement` / `mutation-drift-guard` / `policy*` | deterministic | pass |
| `adapters-live` | **live** | **skips** — `RUNTIME_ABSENT` |
| `workstation*` | **live** | **skips** — `cua-driver` not installed |

**No live worker, live model or VM evidence was obtained in this pass.**

## 6. Test isolation — measured, not assumed

Isolating `KAI_HOME` to a throwaway directory was **implemented and measured**. It is the
correct end state and it cannot land yet: **16 suites silently depend on the developer's real
home** because it holds a working model credential. With an isolated home they fail with

```
ModelError: the "kai-model" model provider has no API key configured
```

instead of skipping. The affected suites are those that boot a real Core and then make a
model call: `settings` (live effect), `mcp/manager` (approved retry), `skills-builtin` (a real
turn), `subagent-memory-isolation` (5), and the chat/campaign task suites (7).

The fix is a shared *"no model configured → skip with a named reason"* helper applied to those
suites. Until it lands, isolating would trade a real coupling for sixteen red tests. The
measurement is recorded in `scripts/test.mjs` so the finding is not lost.

## 7. Budgets — enforced, estimated, unenforceable

| Limit | State | When |
|---|---|---|
| `maxRetries`, `maxReassignments`, `maxDispatches`, `maxDepth` | **Enforced** | before dispatch |
| `maxTokens` | **Enforced when reported** (hermes, codex) | after the run |
| `maxToolCalls` | **Unenforceable** — no adapter reports tool invocations | — |
| `maxCostUsd` | **Unenforceable** — no provider reports cost; KAI will not derive dollars from tokens | — |
| `maxRuntimeMs` | **Measured, not preemptive** — a synchronous delegation has no cancellation point | after the run |

## 8. Learning behaviour — the exact boundary

| Stage | Automatic? | Where |
|---|---|---|
| Skill **scoring** (`recordSkillUsage`) | **YES** — on every outcome | `orchestrator.ts:1645` (failure), `:2421` (success + verified) |
| **Candidate generation** (`proposeFromTask`) | **NO** — `/refine` only | `commands/commands.ts:593` |
| Evaluation against reproducible tasks | **MISSING** | — |
| Approval | yes, bound to the candidate's sha256 | `skills/staging.ts` |
| Promotion (install) | via the approval gate | `installApproved` |
| Rollback | implemented | `staging.rollback` |

**KAI scores skills automatically and proposes them only when asked.**

## 9. Workers tested live vs fake

| Worker | Adapter | Contract tests | Live |
|---|---|---|---|
| Hermes | yes | yes | **skips** |
| OpenCode | yes | yes | **skips** |
| Codex | yes | yes | **skips** |

## 10. External blockers

| Blocker | Prevents | Unblock |
|---|---|---|
| **No GitHub credential** | the push | `gh auth login`, or a `repo`-scoped PAT in `GITHUB_TOKEN` |
| **No live worker runtime** | live adapter evidence, a real OpenCode event stream | run Hermes on `:8642` / OpenCode on `:4096` |
| **`cua-driver` not installed** | workstation/CUA verification | install the driver; live tests stay opt-in by design |
| **No model credential under an isolated home** | the 16 coupled suites, hence F | add the skip helper described in §6 |

## 11. Push

**Not pushed.** No valid credential exists on this machine. The branch is intact and every
commit is retained locally.

---

# Third pass — Priority 1 and Priority 2 completed

## Priority 2 — test isolation. DONE.

**Implemented, and this time it lands.** The first attempt was reverted because
**nine** suites (down from sixteen — the approval work fixed seven) silently relied on the
developer's real `KAI_HOME` holding a model credential, and failed with
`ModelError: no API key configured` instead of skipping.

The unblocking change is `core/tests/live-model.ts`:

```ts
export function liveModelSkipReason(): string | undefined   // inspects CONFIGURATION ONLY
```

It does not attempt a call and catches nothing, so **a real failure — a bad response, an
auth rejection, a bug — can never be misreported as a missing credential.** Applied to the
nine suites: `settings` (live effect), `skills-builtin` (a real turn), and the seven
`task-completion` A–F cases.

`scripts/test.mjs` now creates a unique throwaway `KAI_HOME` per run (`mkdtempSync`), so
concurrent runs cannot collide over a directory, a database or a port, with cleanup on
`exit` **and** `SIGINT`. A suite that sets `KAI_HOME` itself still wins — the five real-path
suites are unaffected.

**Evidence:** `[kai-test] KAI_HOME isolated to …\Temp\kai-test-home-…` and
**1702 tests · 1669 pass · 0 fail · 33 skipped**, where each of the nine new skips prints:

```
# no model credential is configured for this KAI_HOME (…kai-test-home-…):
  set KAI_MODEL_API_KEY, or write KAI_HOME/model/credentials.json.
  This suite needs a live model and is skipped rather than failed.
```

## Priority 1 — tool-call budgets. DONE.

`maxToolCalls` was declared in `WorkBudget` and enforced nowhere. It is now charged at the
**one boundary every policy-checked call passes** — the tool registry — before the tool
runs, into the **same ledger** the dispatch allowance uses (no second budget store).

- `registry.ts` gains `ToolBudgetPort` and charges `kind: "toolCall"` immediately before
  `execute`. A refusal returns `POLICY_DENIED` naming the kind, the ceiling and the scope,
  and the tool never runs.
- Scope is the **plan revision**, so a goal cannot multiply its tool budget by adding work
  items — the same rule the dispatch allowance already follows.
- The ceiling is the item's **existing** `WorkBudget.maxToolCalls`, threaded through
  `ToolInvokeOptions`; no number is invented.
- Idempotency: a resume carries its `approvalId`, so a **redelivered resume is charged
  once**; an ordinary call has no such identity and each call is its own invocation.
- A **parked** call is not charged: the budget is for calls that RUN, and Guard still comes
  first — pinned by a test using a `DESTRUCTIVE` policy.
- `enforceabilityOf(limits, capability, { kaiOwnedToolCalls: true })` now reports
  `maxToolCalls: "enforced"` for **KAI's own** calls and `"unenforceable"` for a **worker's
  internal** ones, naming which — it never claims to bound what it cannot observe.

**Evidence:** `tests/tool-budget.test.ts` (8) — ceiling, the exact refusal text, redelivered
resume charged once, five concurrent calls charged exactly five, an unscoped call charged
nothing, a parked tool still parking, an unbounded scope still counted, and the
KAI-owned/worker-internal distinction.

## Still open after this pass

| Priority | State |
|---|---|
| 3 — real-model critic evaluation | **Not started.** Needs a fixture corpus + an eval script; a model IS configured for the real home |
| 4 — autonomous learning | **Not started.** `recordSkillUsage` is automatic; `proposeFromTask` is still `/refine`-only |
| 5 — cost + runtime limits | **Not started.** `maxCostUsd` needs provider-reported cost or an explicit price table; `maxRuntimeMs` needs adapter cancellation |
| 6 — `KAI_DEV_MODE` boundary | **Not started.** The bypass is scoped and documented; making a packaged runtime refuse it is the remaining work |
| adapter / G-wiring / H-live / I | **Not started this pass** |
