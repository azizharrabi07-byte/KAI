# KAI — Tool plane architecture

**What this document is.** The architecture of KAI's tool plane: the one registry every action passes,
the vocabulary that describes one call, the schema declarations and the strengthened validators, the
invocation/result/error shapes, provenance and the dedupe rule, the permission derivation, the approval
integration, the HTTP surface — and, with the same weight, **what is not implemented**. It is the
Stream C deliverable named in `docs/KAI_ULTRA_MISSION_PLAN.md`.

**Verification vocabulary** (from the mission plan, used verbatim): `UNIT PROVEN` · `INTEGRATION
PROVEN` · `END-TO-END PROVEN` · `MOCK ONLY` · `NOT PROVEN` · `BLOCKED_EXTERNAL`. `FILES EXIST` is
never rounded up to `KAI FUNCTIONALLY OWNS THE MECHANISM`. The machine-checked record for every claim
below is `docs/evidence/kai-tools-final.json`.

**Date.** 2026-10-04. **Method.** Every claim here is backed by a test that ran on this machine
(Node v26.7.0, `node --test` type-stripping): `core/tests/tools-plane.test.ts` (6),
`tools-execution-id.test.ts` (6), `tools-provenance.test.ts` (11), `tools-routes.test.ts` (8) — 31
tests, all passing — driving the REAL tool registry, policy engine and approval service, and (for
`executionId`) a REAL `createCoreRuntime` mission with the real acceptance ledger. Full suite: 823
tests / 810 pass / 0 fail / 13 skipped (+31 over the 792/779/0/13 baseline, zero regressions).
`tsc --noEmit`: exit 0.

---

## 1. The one boundary

Every action in the Core goes:

```
request → validate → policy → (approval) → execute
```

and `core/src/tools/registry.ts` is where that chain is enforced, in that order, once. A tool is a
plain data object with a `validate` and an `execute`; it never gets to decide whether it is allowed to
run. Nothing an LLM, an agent, a route or a mission step produces reaches this machine except through
`registry.invoke()`.

Failure modes are all VALUES, never exceptions:

| Condition | Status | Error code |
|---|---|---|
| unknown tool id | `NOT_FOUND` | `NOT_FOUND` |
| input does not parse (validator returns no / throws / malformed) | `INVALID` | `VALIDATION_FAILED` |
| no policy gate attached | `DENIED` | `POLICY_DENIED` |
| rule/mode says deny | `DENIED` | `POLICY_DENIED` |
| needs approval, none presented | `APPROVAL_REQUIRED` | `APPROVAL_REQUIRED` |
| approval unknown / wrong tool / rejected / expired | `DENIED` | `POLICY_DENIED` |
| approval still pending | `APPROVAL_REQUIRED` | `APPROVAL_REQUIRED` |
| `execute()` throws | `FAILED` | `INTERNAL` |

**One attempt, one identity.** `invocationId` is minted once per attempt and IS the `actionId` the
published `action.executed` record carries (the event type is always `action.executed`; the record's
`resultState` says what actually happened) — so a caller can join the invocation it received to the
record the bus persisted without a lookup table. The registry emits exactly ONE record per attempt —
executed, refused or failed — through the same emitter for every path, including the `record()` escape
hatch below. Recording never vetoes: a bus failure is swallowed (and warned, through the redactor),
because an audit log that can veto an action has become a second policy gate.

**Registration is guarded.** `register` refuses a malformed definition and refuses to shadow an
existing id ("silently replacing a reviewed tool with a same-named one is exactly the kind of
confusion this boundary exists to prevent").

## 2. The eight nouns and the module map

The vocabulary is declared once in `core/src/tools/types.ts`; `registry.ts` re-exports it so a
consumer that already depends on the registry reaches all eight nouns and their helpers from one
import site, and the names cannot drift.

| Noun | Question it answers |
|---|---|
| `ToolRegistry` | where a tool is registered, and the ONLY way to run one |
| `ToolSchema` | what input a tool accepts — machine-readable, when declared |
| `ToolInvocation` | what happened on ONE attempt: ids, status, timing, decision |
| `ToolResult` | what the caller gets back: the value, or an error VALUE |
| `ToolError` | why it refused or failed (the frozen `KaiError`, never a throw) |
| `ToolProvenance` | what it produced, where the call came from, whether a dedupe means it produced nothing |
| `ToolPermission` | the declared risk, the effect flag, and the ONE derived side-effect answer |
| `ToolApproval` | whether a human was asked, which approval, and its state |

| File | Role |
|---|---|
| `types.ts` | the eight nouns + `sideEffectingOf` / `permissionOf` / `toolError` / `describeTool` — the vocabulary |
| `registry.ts` | the boundary: `createToolRegistry` → `register` / `get` / `list` / `invoke` / `record`; attempt bookkeeping; the ONE emitter |
| `provenance.ts` | `deriveToolProvenance` + `dedupeSignalOf` + `deriveArtifactIds` — creation-only artifact naming |
| `routes.ts` | the HTTP surface: `createToolApi` (pure) + `registerToolRoutes` (host adapter) |
| `builtin.ts` | 5 built-in tools (system / agents / missions / memory) — the deliberately small safe set |
| `workspace.ts` | 7 real workspace tools (filesystem ×3, git ×3, shell ×1) + the ops the capability layer dispatches to |

Everything is additive over the FROZEN shared contracts: `RiskLevel`, `KaiError`, `KaiErrorCode` and
`ApprovalStatus` come from `shared/contracts.ts`; `ActionResultState` / `ExecutorType` from
`observability/action-record.ts`; `executionIdFor` from `recovery/ledger.ts`. Nothing is re-invented,
so the plane cannot drift from the record vocabulary the bus already speaks.

## 3. The ONE risk/effect rule

> `sideEffecting = risk !== "READ" || effectful === true`

stated once in `types.ts` (`sideEffectingOf` / `permissionOf`) and never re-derived from `risk` alone.
The distinction is the falsified-2 defect (`tests/side-effect-derivation.test.ts`): `missions.create`
is `READ` by risk (it touches nothing itself; its own steps are policy-checked) yet creating a mission
twice creates TWO missions — and keying the derivation off risk alone let such a step run with NO
recovery record, so a crash replayed it. `effectful: true` is that second fact, stated where the tool
is defined:

| Tool | risk | effectful | sideEffecting |
|---|---|---|---|
| `system.get_status`, `agents.list`, `missions.list`, `memory.list` | READ | – | false |
| `agents.run_task` | EXTERNAL | – | true |
| `filesystem.read`, `filesystem.list`, `git.status`, `git.log`, `git.diff` | READ | – | false |
| `filesystem.write` | WRITE | true | true |
| `shell.run` | DESTRUCTIVE | true | true |

Every consumer — mission creation, the acceptance boundary, a UI badge, the `/tools` description —
must ask `permissionOf` / `sideEffectingOf`, never `risk` alone.

## 4. Schemas and the strengthened validators

`ToolSchema` is a deliberately small declarative contract (`kind: "object"`, `properties` with
type / required / enum / minimum / maximum, `additionalProperties: false`) that a planner or UI can
read WITHOUT running the tool. It never replaces `validate()`: the validator remains the authority at
the boundary.

- **12 tools declare schemas**: the 5 builtins (`builtin.ts`) and the 7 workspace tools
  (`workspace.ts`). Limits are real: list limits 1–500, `git.log` limit 1–200, read bytes 1–1 000 000,
  shell timeout 1–120 000 ms, enums for mission status / memory type, required flags on the fields the
  tools genuinely require.
- **Every declared schema is cross-checked against the real validator** (`tools-plane.test.ts`): for
  each of the 12 tools the test feeds the schema's own sample (must pass), an unknown key (must be
  refused — the declaration says `additionalProperties: false`), each required field omitted (must be
  refused), each field with the wrong JSON type (must be refused), every enum member (accepted) and a
  non-member (refused), and every bound ±1 (edge accepted, beyond refused). A declaration that drifted
  from its validator fails the suite.
- **The workspace validators were strengthened to enforce exactly what the schemas claim.** Previously
  a bad `cwd` / `maxBytes` / `timeoutMs` could reach `execute()` and surface as an `INTERNAL` throw
  (500). All 7 workspace `validate()`s now parse the full input contract, so those are
  `VALIDATION_FAILED` — refused BEFORE policy and execute are touched (and the route maps that code to
  400).
- **A tool that declares no schema is reported as undeclared WITH the reason** — `describeTool`
  returns `{ declared: false, reason: "…validates procedurally…" }`, never an invented shape. The
  other registered tools (`memory.write`, `skill.*`, `learning.propose`, `checkpoint.*`,
  `schedule.manage`, `missions.*`, `approval.decide`, `capability.*`, `mcp.*`) validate procedurally;
  only the 12 above declare machine-readable schemas today.

## 5. Invocation, result, error — the correlation set

Every attempt — executed, denied, parked, failed, invalid, not-found — produces a full
`ToolInvocation` carrying the complete correlation set the mission requires:

```
toolId · executionId · sessionId · agentId · source · arguments · result · status · duration
```

plus `approvalId` where applicable — and, additive: `invocationId`, `startedAt` / `completedAt` /
`durationMs`, `policyDecision`, `decisionSource`, `permission`, `provenance`, `approval`, `error`.

Honesty rules baked into the shape:

- `executionId` / `sessionId` / `agentId` are present when they EXIST. A call outside any mission has
  no acceptance-ledger execution, and inventing one would be the exact mislink class this plane
  refuses — absence is honest, and asserted (`"executionId" in record === false`).
- `arguments` is the VALIDATED value once validation passes (what was actually acted on); the raw
  input only when validation did not pass.
- `status` is the record vocabulary (`ActionResultState`): `EXECUTED` · `DENIED` ·
  `APPROVAL_REQUIRED` · `INVALID` · `NOT_FOUND` · `FAILED` — not a second one.
- `ToolResult` is `{ ok: true, result, invocation } | { ok: false, error, invocation }` — BOTH branches
  carry the invocation, so a caller never has to re-ask the bus what happened. `ToolError` is the
  frozen `KaiError`; `retryable` is false by default (the registry never retries for you).

## 6. `executionId` — the join to the acceptance ledger (VERDICT: PROVEN)

`resolveExecutionId`: an explicit caller `executionId` wins; otherwise it is derived from
`(missionId, stepId)` with the acceptance ledger's ONE formula (`executionIdFor`, imported — never
re-invented); absent when the caller named no mission step.

**Proven at two levels** (`tools-execution-id.test.ts`):

- **UNIT** — `invoke` with `{missionId, stepId}` puts `executionIdFor(...)` on BOTH the returned
  invocation and the published action record; an explicit id wins; absent ids stay absent (including
  the half-pair: mission without step); the `record()` escape hatch derives the same id; every refusal
  branch (denied / invalid / not-found) carries it too.
- **INTEGRATION** — a real `createCoreRuntime` runs a real mission whose side-effecting step passes the
  real boundary runner, and the action record the bus persisted is asserted EXACTLY as the verdict
  states it:

  ```
  record.executionId === rt.recovery.get(executionIdFor(mission.id, step.id)).executionId
                      === executionIdFor(mission.id, step.id)
  ```

  plus `record.actionId === invocationId` is the same attempt, `record.missionId === mission.id`,
  `record.turnId === step.id`, `resultState === "EXECUTED"`. A companion READ step shows the honest
  asymmetry: the id is still derived on the record while the acceptance boundary (which records only
  side-effecting steps) writes no ledger row — derivation and the ledger write are independent, and
  the record stays honest about which is which.

This closes the gap an earlier audit found: `executionId` was not a field at all, so recovery rows
could not be correlated from the action bus.

## 7. Provenance and the dedupe rule (VERDICT: PROVEN)

`deriveToolProvenance` is called at the ONE place every executed action passes (`settle`, inside
`invoke`) and is the only place artifact ids are read off a result. Two rules govern it:

1. **Creation-only naming, generically.** The pinned defect (`tests/adversarial-observability.test.ts`):
   a deduped `memory.write` returns the EXISTING entry id, so a second action record named a memory it
   did not create and a trace resolved to the wrong action. The fix is ONE GENERIC guard, not a
   per-tool patch — a tool that learns to dedupe later would otherwise reintroduce the mislink
   silently: a result that reports `deduped: true` — at its top level, or one level down under `value`
   (a SkillResult-shaped envelope) — names NO artifact. Any tool whose operation can find an existing
   artifact must propagate that signal, and the plane then refuses to name anything.
2. **Executed actions only.** A refusal (denied / parked / invalid / not found) names nothing, even
   when its INPUT carries id-shaped fields — a `mission.cancel` that policy refused did not cancel the
   mission.

The per-tool result shapes remain (`deriveArtifactIds`: `memory.write`, `memory.create`,
`skill.toggle` / `skill.delete`, `learning.propose`, `checkpoint.create` / `checkpoint.restore`,
`schedule.manage`, `missions.create`, `mission.cancel`, `approval.decide`) because reading WHICH
artifact a result names is inherently per-tool — boundary knowledge kept in one place, ids returned
only when really present, nothing guessed. Provenance also derives `executorType` (`employee` when the
input names an agent, else `kai`), `employeeId`, `capabilityId` (from the `capability.` id prefix) and
`source` — kept in the same place so the invocation and the record cannot disagree about who did it.

**Proven through the REAL registry** (`tools-provenance.test.ts`): a created artifact is named; a
DEDUPED write names NOTHING (top-level AND `value`-envelope); a refusal names nothing; the causal
mission beats the artifact mission (`mission.cancel` acting on `mis_target` inside `mis_causal` names
`mis_causal` and joins its `executionId`). Scope note: tool result shapes are test doubles; the
registry, policy engine and emitter are real.

**RESIDUAL — reported, not papered over.** `learning.propose` still names a memory it may not have
created when the write dedupes, because `learning/pipeline.ts` drops `deduped` before the tool result
exists (its `entryIdOf` reads only `entry.id`). The guard is signal-driven, so a producer that drops
the signal still gets its entry named — the residual is producer-shaped, not plane-shaped. The fix
belongs in `learning/pipeline.ts`, which is outside Stream C. A test pins the mechanism; the
`provenance.ts` header names it.

## 8. Permission, policy, approval integration

**Policy** (`policies/gate.ts`, existing): `check({toolId, action, risk, missionId?, stepId?, input})`
→ `{ outcome: "allow" | "deny" | "needs_approval", source, reason }` with `source` ∈ `"default"` ·
`"rule:<id>"` · `"mode:<mode>"` · `"unknown-risk"` · `"no-gate"`. The invocation and the record carry
`policyDecision` and `decisionSource` (the registry labels `"not-reached"` when no decision was made).

**Approval** (the registry's part of it):

- `needs_approval` with no `approvalId` in hand → the registry creates the approval via the approval
  service, answers `APPROVAL_REQUIRED` with `ToolApproval { required: true, approvalId, status:
  "PENDING" }` and the approvalId on the error detail (so a route can answer 409), and calls the
  `onApprovalRequest` hook so the runtime can re-issue the exact validated input once a human answers.
  A throwing hook never breaks the park (warned, swallowed).
- Retry with `approvalId`: unknown → `APPROVAL_REQUIRED`; **bound to a different tool → `DENIED`** (an
  approval authorises one tool and no other — without this check a real "yes" to a benign action could
  be spent on a dangerous one); `REJECTED` → `DENIED`; `EXPIRED` → `DENIED`; still `PENDING` →
  `APPROVAL_REQUIRED`; `APPROVED` and bound → falls through to execute, with the authorising approval
  on the invocation and the record.
- Proven at registry level (park → decide → retry executes, carrying `approval.status: "APPROVED"`)
  and at route level (`tools-routes.test.ts`: the parked call executes NOTHING; the 409's `approvalId`
  retry runs it EXACTLY once).

## 9. The HTTP surface (`/tools`)

`routes.ts` exports `createToolApi({tools})` — the pure house style `{ handle(request), routes() }`,
exactly like `CoreApi` and `createMcpApi` — and `registerToolRoutes(app, {tools})`, a host adapter that
accepts an object with `route(method, pattern, classification, handler)` (the exact shape of
`core/src/api/routes.ts`) or a bare function with the same signature. A host that can carry nothing
throws at startup — a route table that silently accepts nothing would leave `/tools` at 404 while
looking wired.

| Method | Path | Classification | Behaviour |
|---|---|---|---|
| GET | `/tools` | READ | every registered tool, described — declared facts only |
| GET | `/tools/:id` | READ | one tool, described; 404 when no such id |
| POST | `/tools/:id/invoke` | **EXTERNAL** | run ONE tool through the ONE boundary |

`POST /tools/:id/invoke` classifies the ROUTE as EXTERNAL, per the `/capabilities/:id/test`
convention: invoking can cause another process to act, so the route is EXTERNAL while the tool's own
declared risk gates the run INSIDE the registry. There is no second policy path in this file. The body
carries `{ input?, approvalId?, missionId?, stepId?, scheduleId?, turnId?, sessionId?, agentId?,
source?, executionId? }` — each optional string validated as a non-empty string when present; a
non-object body is refused before anything runs; a query string never changes which route matches.

HTTP mapping of refusals — each carrying the full `ToolInvocation`, so a refusal is as traceable as a
success:

| Outcome | HTTP |
|---|---|
| success | 200 `{ toolId, status, invocationId, executionId?, result, invocation }` |
| park (`APPROVAL_REQUIRED`) | 409 `{ approvalRequired: true, approvalId, invocation }` |
| `POLICY_DENIED` | 403 |
| `NOT_FOUND` | 404 |
| `VALIDATION_FAILED` | 400 |
| anything else | 500 (with `code`) |
| a path this module does not own | 404 — falls through to the routes that already existed |

**Wiring (the integration handover — NOT applied by this stream).** `core/src/api/routes.ts` belongs
to the integration stream; the exact one-line call is:

```ts
registerToolRoutes({ route: (m, p, c, h) => routeDefs.push(route(m, p, c, h)) },
                   { tools: runtime.tools });
```

**Until that line lands, a live `GET /tools` on a running Core still returns 404.** That is a wiring
fact, not a route fact: `tools-routes.test.ts` proves the surface and the host adapter both work,
including the exact handover call shape (the pushed handler is dispatched directly, as the host's own
dispatcher would, and the invoke route is classified EXTERNAL).

## 10. What is NOT implemented / not proven — plainly

- **The live mount: NOT PROVEN.** `/tools` 404s on a running Core until the integrator applies the
  wiring line in §9. The module-level surface is INTEGRATION PROVEN (8 tests); the live endpoint is
  not.
- **`learning.propose` dedupe residual: NOT fixed, reported.** See §7 — `learning/pipeline.ts` drops
  the `deduped` signal, so a deduped learned memory can still be named by its learning action. Outside
  Stream C's ownership.
- **Schema declarations cover 12 of the registered tools.** Everything else reports `declared: false`
  with the reason; no schema was invented for tools that validate procedurally.
- **The `record()` escape hatch deliberately bypasses policy.** Two known callers — the staged-skill
  approve/install routes (byte-bound to an approval, deliberately not an `invoke()` call) and
  `POST /missions` (which creates its mission directly) — emit a record through the same emitter so a
  state change without a trace is impossible, but they are NOT policy-gated by this plane. It is the
  escape hatch it is documented to be, not a second gate.
- **No retries.** `ToolError.retryable` is false by default; retry policy belongs to the caller, not
  the registry.
- **No UI surface** for the tool plane exists in this stream; the HTTP API is the interface.
- **`BLOCKED_EXTERNAL`: none.** Every seam this plane needs (registry, policy, approvals, filesystem,
  git, process spawn) is local and exercised; nothing was blocked on an external dependency.

## 11. How to run the proof

```bash
cd core
node --test tests/tools-plane.test.ts        # the eight nouns; schema/validator cross-check
node --test tests/tools-execution-id.test.ts # the unit derivation + the real mission/ledger join
node --test tests/tools-provenance.test.ts   # dedupe guard, refusals, causal-mission rule, residual
node --test tests/tools-routes.test.ts       # the 3 routes, park→approve→retry, host adapter
npm test                                     # everything (823 / 810 pass / 0 fail / 13 skipped)
```
