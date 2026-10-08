# KAI Phase 4 — derived roadmap and completion matrix

**Status of this document:** authoritative, *derived*. There is no spec file in this
repository or in its git history; every requirement below is drawn from the repo's own
documentation, plans and evidence, and every row cites the source it came from. Where the
directive names an area for which the repo holds no requirement, that is stated as
**NOT FOUND** rather than invented.

**Phase 4 update (this pass).** Three rows below are now IMPLEMENTED where they
were missing: persistent sessions (3), the Core/API half of session switching (4),
the autonomous loop (15) and self-maintenance (16). The remaining gaps are named in
`docs/phase4-report.md`. The measurements below are the ORIGINAL derivation; the
Phase 4 numbers are in that report.

**Revision under audit:** `HEAD = 535acb82f48ce9f7c0a433db5ad04ef1dde84a60` (`535acb8`),
tree clean, 2026-10-03. Product artifacts: `app/target/release/kai.exe`, installer
`KAI_0.1.1_x64-setup.exe`. Core test counts reported across this cycle: **605/605 pass**
(`docs/phase2-state.md:8`), rising through 597/597 (`docs/evidence/phase2-provenance-and-partu.txt:45`)
and 440/438 with 2 skipped (`docs/evidence/partu-10-live.txt:54`). App tests: 57–59/59.

**Status vocabulary** (the repo's own, `docs/core.md:8-10`):
**IMPLEMENTED** (works, verified) · **PARTIAL** (exists, incomplete) · **PLANNED**
(designed only) · **NOT FOUND** (no implementation and no derived requirement in the repo).

---

## Table 1 — the 17 directive product areas

The directive lists 16 comma-separated areas; the phrase "persistent sessions + session
switching" names two distinct capabilities, so it is split into two rows, giving 17.

| # | Area | Derived requirement(s) (exact source) | Implementation location | Test coverage | Current state (evidence actually seen) |
|---|------|----------------------------------------|--------------------------|----------------|----------------------------------------|
| 1 | **Identity / personality** | KAI must have a system prompt, persona, role and goals, and know who it is with every worker offline. Source: `docs/architecture-audit.md` §2 verdict 2 ("NOT IMPLEMENTED — No system prompt, persona, role or goals anywhere in `core/`") + §6 "B identity"; `docs/phase-2.5-report.md` §Known limitations; prompt precedence is a tracked acceptance item (`docs/phase2-state.md:30`). | `core/src/agent/soul.ts` (`BUILT_IN_SOUL` :27-31; `systemPrompt()` :143), `core/src/agent/kai-home.ts` (`SOUL_SEED` :40-99), `core/src/identity.ts`, `core/src/prompts/compose.ts` (identity section :277; `SECTION_ORDER`, fences, bounds), `core/src/prompts/index.ts` | `core/tests/soul.test.ts`, `core/tests/prompts.test.ts`, `core/tests/prompts-precedence.test.ts` (24 unit tests per `docs/phase2-state.md:30`) | **IMPLEMENTED** (unit-verified; live behaviour-change proof still open — see open items). Audit's NOT IMPLEMENTED verdict superseded by later commits `5c199ce`, `fd6c4a9`. |
| 2 | **Chat / conversations** | Chat must route a turn through the Core, answer state questions from state before any model, and keep a real conversation on one worker session. Source: `docs/core.md` §3 (`chat/router.ts`), `docs/api.md` "Chat" section (:41-67), `docs/phase-2.5-report.md` "Chat" (:59-63). | `core/src/chat/router.ts`, `core/src/server.ts` (POST `/chat`), `app/src-tauri/src/claude.rs` (Hermes→Core→Anthropic chain), `app/src/views/chat.ts` | `core/tests/chat.test.ts`; `app/tests/kai-core.test.ts` | **IMPLEMENTED** for chat. Evidence: `docs/evidence/core-live-routes.txt` (real turn + second turn repeating the token), `docs/evidence/island-chat-turn.txt`, `docs/evidence/kai-ui-04-chat.png`. **PARTIAL** for durable conversations (no KAI conversation store; the session id is passed through to the worker only). |
| 3 | **Persistent sessions** | KAI needs its own session layer that survives restarts. Source: `docs/architecture-audit.md` §2 verdict 3 + §6 "F sessions". | `core/src/sessions/{store,service,index}.ts` (its own SQLite file, the pattern the recovery ledger and lease store already use); routes `core/src/api/routes.ts` `/sessions*`; chat binding `core/src/server.ts` | `core/tests/sessions.test.ts` (6) | **IMPLEMENTED** (Phase 4). Durable across a store reopen; the worker conversation is bound to the session; live evidence `docs/evidence/phase4-live.txt`. |
| 4 | **Session switching** | Create / switch / rename / archive a session. Source: `docs/architecture-audit.md` §3 verdict 14. | Routes `/sessions` (create), `/:id/activate` (switch), `/:id/rename`, `/:id/archive`; `GET /sessions/active` | `core/tests/sessions.test.ts` | **IMPLEMENTED in the Core + API** (Phase 4); the ISLAND UI has no sessions view yet — see remaining gaps. |
| 5 | **Memory** | Durable, bounded, provenance-tagged memory: write, persist across restart, dedup, expiry, over-budget refusal, and recall into a composed turn. Source: `docs/core.md` §3 (`memory/service.ts`), `docs/api.md` endpoints `/memory*` (:31-33,88); acceptance M1–M5 `docs/phase2-state.md:33`. | `core/src/memory/*.ts` (engine, service, bounds, capture, upkeep, journal, topics), `core/src/storage/memoryStore.ts`, routes `core/src/api/routes.ts:1834-1840` | `core/tests/memory.test.ts`, `core/tests/memory-engine.test.ts`, `core/tests/memory-provenance-default.test.ts` | **IMPLEMENTED**. Evidence: `docs/evidence/phase2-live.txt:7-25` (M1–M5, incl. composed-turn recall); provenance default hardened by commit `535acb8` (falsification 1). |
| 6 | **Skills + learning** | Skills staged → human-approved exact-byte install → discovered → progressively disclosed, tamper-refused; learning classifies a completed turn to memory/skill/none with host-attributed provenance. Source: `docs/phase2-state.md:34` (S1–S4), :27 (L1), `docs/phase2-falsifications.md` "Skill byte-integrity (claim 5)". | `core/src/skills/*.ts`, `core/src/learning/*.ts`, routes `core/src/api/routes.ts:1842-1869` | `core/tests/skills.test.ts`, `core/tests/learning.test.ts`, `core/tests/learning-provenance.test.ts` | **IMPLEMENTED** for S1–S4 + L1 (live). Evidence: `docs/evidence/phase2-skills-learning-live.txt` (S1–S4, hash-mismatch 403), `docs/evidence/phase2-provenance-and-partu.txt` (P1–P3, L1). L2 behaviour change remains **PARTIAL**. |
| 7 | **Missions / planning** | Missions run a declared step list with policy parking and crash recovery; *planning* (decide, decompose, observe/evaluate/retry) is a separate, named gap. Source: `docs/core.md` §3 (missions), `docs/api.md` mission example (:69-81); `docs/architecture-audit.md` §2 verdict 1 ("NOT IMPLEMENTED … runs a pre-declared step list once … no observe/evaluate/retry") + §6 "C loop". | Missions: `core/src/missions/executor.ts`, `core/src/missions/mission.ts`, routes `:1826-1829`. Planning: none. | Missions: `core/tests/missions.test.ts`, `core/tests/side-effect-derivation.test.ts`, `core/tests/side-effect-classification.test.ts` | **IMPLEMENTED** for mission execution; **PARTIAL** for planning (no decomposition/observe/retry loop exists). |
| 8 | **Approvals / policy** | Risk-gated approvals: validate → policy → approval → execute; every mutating route classified and enforced; policy runtime-configurable. Source: `docs/core.md` §3, `docs/security.md` "The permission relay", `docs/api.md` `/approvals`, `/policy`; `docs/architecture-audit.md` §2 verdict 5 + §6 note. | `core/src/approvals/service.ts`, `core/src/policies/gate.ts`, `core/src/policies/mode.ts`, routes `:1810-1811,1832-1833`; enforcement table `core/src/api/routes.ts:1764-1806` | `core/tests/policy.test.ts`, `core/tests/policy-mode.test.ts`, `core/tests/policy-mutation.test.ts`, `core/tests/api-enforcement.test.ts` | **IMPLEMENTED**. Audit's `POST /agents/:id/action` bypass is closed: it is classified `EXTERNAL` (`core/src/api/routes.ts:1825`) and goes through `invokeGate`. Evidence: `docs/evidence/phase2-closeout-1.txt:12` (destructive restore parked 409 → approved → executed). |
| 9 | **Workforce / employees** | A workforce layer above the agent registry: register, discover, install, authenticate, health-check, enable/disable/recover, grant/revoke, select and delegate — with errors as values. Source: `docs/phase2-state.md:31` (T1–T10), `docs/evidence/partu-10-live.txt` T1/T4/T5/T6; `docs/architecture-audit.md` §2 verdict 4 ("PARTIAL — nothing decides which agent to use") + §6 "E agent manager". | `core/src/workforce/manager.ts` (1081 lines), `core/src/workforce/{discovery,lifecycle,employee}.ts`, `core/src/capabilities/manager.ts`, routes `:1813-1819`; wiring `core/src/runtime.ts:855-862` | `core/tests/workforce.test.ts`, `core/tests/capabilities.test.ts` | **IMPLEMENTED** (selection/delegation real: `select`/`available`/`delegate`). Evidence: `docs/evidence/partu-10-live.txt:19-25` (T4 register mock employee, T5 parked, T6 approve + real execution). |
| 10 | **Browser / CUA / MCP / Shell / Git** | Real capability transports behind policy: semantic-first browser (CDP), CUA desktop control via cua-driver, MCP servers/tools, and filesystem/shell/git. Source: `docs/evidence/partu-10-live.txt` T7–T10; `docs/architecture-audit.md` §4; `docs/core.md` §3 note ("No filesystem, shell, browser, screenshot, process control, git — by design for now"). | Browser: `core/src/capabilities/browser/*`; CUA: `core/src/capabilities/computer/*`; MCP: `core/src/mcp/*`; dispatch `core/src/runtime.ts:1086-1161`. Shell/Git/Filesystem: **stubs only** — `core/src/runtime.ts:1013-1023` registers them `UNAVAILABLE` with `requirements: ["no <id> tool is implemented in KAI yet"]`. | `core/tests/browser-capability.test.ts`, `browser-real.test.ts`, `cua-foundation.test.ts`, `cua-real.test.ts`, `mcp.test.ts`, `mcp-real.test.ts` | **PARTIAL**. Browser **IMPLEMENTED** (T8/T9 live), CUA **IMPLEMENTED** (T7 live), MCP **IMPLEMENTED** in code/tests but no live server (`runtime.ts:1157-1161`), **Shell/Git NOT IMPLEMENTED** (capability stubs, no tool). |
| 11 | **Scheduler** | Persistent once/interval/daily (and extended) tasks that create and run a real mission, deduped by occurrence across restarts, with a durable lease. Source: `docs/core.md` §3; `docs/evidence/phase2-live-round2.txt` R1; acceptance R1–R4 `docs/phase2-state.md:23-26`. | `core/src/scheduler/{scheduler,schedule,jobs,lease}.ts`, routes `:1855-1858` | `core/tests/scheduler.test.ts`, `scheduler-durability.test.ts`, `scheduler-mission-dedup.test.ts`, `scheduler-security.test.ts` | **IMPLEMENTED**. Evidence: `docs/evidence/phase2-live-round2.txt:6-12` (R1 fired once, mission carries `metadata.scheduleId`), `docs/evidence/phase2-closeout-1.txt:23-30` (R2/R3 survive restart, exactly 1 mission). R4 current-policy-at-fire not run. |
| 12 | **Checkpoints** | KAI-owned shadow checkpoints: create; restore that re-hashes and reports `{ok,verified}`; honest failure on a missing target; never touches the user's git. Source: `core/src/checkpoints/checkpoint.ts` header ("Part G"), acceptance C1–C3 `docs/phase2-state.md:19-21`. | `core/src/checkpoints/checkpoint.ts`, routes `:1863-1865` | `core/tests/checkpoints.test.ts` | **IMPLEMENTED**. Evidence: `docs/evidence/phase2-live-round2.txt:14-16` (C1), `docs/evidence/phase2-closeout-1.txt:10-21` (C2 verified restore, user git untouched; C3 honest 409). |
| 13 | **Recovery** | A durable acceptance ledger classifying before-accept vs after-accept vs unknown; unknown ⇒ unsafe ⇒ no replay. Source: `core/src/recovery/boundary.ts`, `core/src/recovery/ledger.ts` headers (spec §29), acceptance C4–C6 `docs/phase2-state.md:21-22`. | `core/src/recovery/{boundary,ledger}.ts`, routes `:1860-1861` | `core/tests/recovery.test.ts`, `core/tests/recovery-before-accept.test.ts`, `core/tests/recovery-status.test.ts` | **PARTIAL**. C5 (after-accept) and C6 (unknown unsafe) PASS live (`docs/evidence/phase2-recovery-investigation.txt:28-48`, `phase2-live-round2.txt:18-24`); **C4 (a BEFORE_ACCEPT row in practice) is still not produced** — an open item. The `recovery-status` reporting defect is fixed (commit `ec3bbd8`). |
| 14 | **Observability** | Every action produces a durable ActionRecord and correlatable artifact refs, so an action traces back to missions/steps and forward to the artifacts it produced. Source: `core/src/observability/action-record.ts` + `correlation.ts` headers. | `core/src/observability/action-record.ts`, `core/src/observability/correlation.ts`; wired into the tool path at `core/src/tools/registry.ts:39,124` | `core/tests/observability-linkage.test.ts`, `core/tests/runtime-events.test.ts` | **IMPLEMENTED** at the action-record/correlation layer. Note: no dedicated HTTP route or UI view exposes it (`docs/api.md` route list has none); it is observable through events/tests. |
| 15 | **Autonomous loop** | An orchestration loop that re-invokes a worker after evaluating a result. Source: `docs/architecture-audit.md` §2 verdict 1, §5 gap 1, §6 "C loop". | `core/src/autonomy/supervisor.ts`; wired as a `mission.failed` subscriber in `core/src/runtime.ts` | `core/tests/autonomy.test.ts` (8) | **IMPLEMENTED** (Phase 4), BOUNDED: one automatic re-attempt by default, transient failures only, the attempt number on the mission so a restart cannot reset the budget. Live: `docs/evidence/phase4-live.txt` (exactly one retry, then escalation). |
| 16 | **Self-maintenance / upgrading** | *(Directive area; the repo had no requirement for it.)* KAI inspects its own subsystems and repairs what it owns; "upgrading" = report precisely which build is running. Source: the directive, plus this project's own stale-Core incident. | `core/src/maintenance/index.ts`; routes `/maintenance/status` (READ) and `/maintenance/run` (WRITE, gated) | `core/tests/maintenance.test.ts` (5) | **IMPLEMENTED** (Phase 4), scoped: no network, no self-replacing binaries. The identity check reports STALE when the running build id differs from the stamp on disk. |
| 17 | **UI** | The island consumes the Core's `/state` and `/core/events`; views render agents, missions, notifications and approvals from the Core; no view calls `fetch` itself. Source: `docs/ui-core-dataflow.md` ("The target"), `docs/phase-2.5-report.md`; gaps `docs/architecture-audit.md` §2 verdicts 13–14 (permissions/sessions UI NOT IMPLEMENTED) + §3. | `app/src/**` (island, views, character, settings), Core client `app/src/core/{kai-core,core-events,core-state,core-boot}.ts`, `app/src/island/core-bridge.ts`; view set `app/src/views/views.ts:506-522` | `app/tests/core-events.test.ts`, `app/tests/core-state.test.ts`, `app/tests/kai-core.test.ts`, `app/tests/timeAgo.test.ts` | **PARTIAL**. The Core link is live and survives Core restarts (`docs/phase-2.5-report.md` "Offline / reconnect"), and the packaged-app chain runs (`docs/evidence/push3-e-chain.txt`). Still open: the old Rust pollers run in parallel, and there is no sessions / permissions / employees view. |

---

## Table 2 — Phase 1 (T1–T10) and Phase 2 acceptance matrix

Drawn from `docs/evidence/partu-10-live.txt`, `docs/phase2-state.md`,
`docs/evidence/phase2-live-round2.txt`, `docs/evidence/phase2-closeout-1.txt`,
`docs/evidence/phase2-skills-learning-live.txt`, `docs/evidence/phase2-provenance-and-partu.txt`,
`docs/evidence/phase2-recovery-investigation.txt` and `docs/phase2-falsifications.md`.

### Phase 1 — Part U, T1–T10 (live, product-spawned Core)

| Item | Requirement | State | Evidence |
|------|-------------|-------|----------|
| T1 | Workers available | PASS | `partu-10-live.txt:16` hermes=READY opencode=READY codex=UNAVAILABLE |
| T2 | Disable Hermes | PASS | `partu-10-live.txt:17` hermes=DISABLED, Core health 200 |
| T3 | Restore Hermes | PASS | `partu-10-live.txt:18` hermes=READY |
| T4 | Register mock employee | PASS | `partu-10-live.txt:19` DISCOVERED, HTTP 201 |
| T5 | Unauthorized action gated | PASS | `partu-10-live.txt:20-21` 409, executed=false, parked |
| T6 | Approve + real worker execution | PASS | `partu-10-live.txt:22-25` state=completed, output=PARTU-WORKER-OK, real tokens |
| T7 | Real CUA interaction | PASS | `partu-10-live.txt:26-30` real cua-driver windows |
| T8 | Real browser transport | PASS | `partu-10-live.txt:31-33` real CDP target on Edge |
| T9 | Semantic browser observe | PASS | `partu-10-live.txt:34-37` dom strategy, ax refs, no coordinates |
| T10 | KAI direct capability | PASS | `partu-10-live.txt:39-41` `system.get_status` runs READ, executor=kai |
| — | Regression re-run after later changes | PASS (at `ed070d8`) | `phase2-provenance-and-partu.txt:34-43` TALLY {"PASS":10}; **needs a fresh re-run at HEAD** (open item) |

### Phase 2 acceptance matrix (`docs/phase2-state.md:14-35`, amended by later evidence)

| Item | Requirement | State | Evidence / note |
|------|-------------|-------|-----------------|
| C1 | Checkpoint create | PASS | `phase2-live-round2.txt:14-16`, `phase2-skills-learning-live.txt:44` |
| C2 | Checkpoint restore | PASS | `phase2-closeout-1.txt:10-18` verified sha256 restore, user git untouched |
| C3 | Checkpoint failure honesty | PASS | `phase2-closeout-1.txt:20-21` 409 "target does not exist" |
| C4 | Before-accept recovery | **NOT RUN** | `phase2-state.md:21`; only AFTER_ACCEPT rows produced (`phase2-recovery-investigation.txt:35`) |
| C5 | After-accept recovery | PASS | `phase2-recovery-investigation.txt:28-34` AFTER_ACCEPT, replaySafe:false, count 1 |
| C6 | Unknown execution unsafe | PASS | `phase2-live-round2.txt:18-24` UNKNOWN → replaySafe:false |
| R1 | One-time schedule fires once | PASS | `phase2-live-round2.txt:6-12` |
| R2 | Restart survival | PASS | `phase2-closeout-1.txt:23-26` |
| R3 | No double fire | PASS | `phase2-closeout-1.txt:28-30` exactly 1 mission across restart |
| R4 | Current policy at fire | **NOT RUN** | `phase2-state.md:26`; needs a live policy-mutation route (now present: `POST /policy/rules`) |
| L1 | Correction → artifact | PASS | `phase2-skills-learning-live.txt:30-37`, `phase2-provenance-and-partu.txt:17-22` |
| L2 | Behaviour change | **PARTIAL** | `phase2-provenance-and-partu.txt:24-32`: persistence proven; behaviour change lacks an action trace |
| I1–I4 | Worker → learning integration | **NOT RUN** | `phase2-state.md:29` |
| — | Live prompt precedence | **NOT RUN** live | `phase2-state.md:30`: 24 unit tests pass; no action-trace proof |
| — | Provenance security | PASS after fix (was FALSIFIED) | Falsified in `phase2-falsifications.md` §FALSIFIED 1; closed in commit `535acb8`; re-verified `phase2-provenance-and-partu.txt:7-13` (HTTP 400 on claimed `source:user`) |
| — | Acceptance-boundary side effects | PASS after fix (was FALSIFIED) | Falsified in `phase2-falsifications.md` §FALSIFIED 2; classified by effect in commit `535acb8`; derived from risk in `phase2-recovery-investigation.txt:5-15` |
| M1–M5 | Memory (persist/restart/dedup/expiry/bounded refusal) | PASS | `phase2-live.txt:7-25` |
| S1–S4 | Skills (discover/disclosure/staged install/tamper refusal) | PASS | `phase2-skills-learning-live.txt:6-28` |
| A1 | OpenCode real task | EXTERNALLY BLOCKED | `phase2-live-round2.txt:45-47`, `phase2-opencode-verdict.txt:13-26` (providers' own errors) |

---

## Open items (report only — do not fix)

1. **C4 — before-accept recovery.** No row with `phase = BEFORE_ACCEPT` has been produced in
   practice; `replaySafe:true` is unreachable live. `docs/phase2-state.md:37-51`,
   `docs/evidence/phase2-recovery-investigation.txt:35`.
2. **R4 — current policy at fire.** Not run; requires a live policy-mutation route (now
   present at `POST /policy/rules`). `docs/phase2-state.md:26`.
3. **L2 — behaviour change.** Persistence is proven; a changed-behaviour action trace is not.
   `docs/phase2-state.md:28`, `docs/evidence/phase2-provenance-and-partu.txt:24-32`.
4. **I1–I4 — worker → learning integration chain.** Not run. `docs/phase2-state.md:29`.
5. **Live prompt precedence.** 24 unit tests pass; no live action-trace proof.
   `docs/phase2-state.md:30`.
6. **Phase-1 T1–T10 re-run.** Last full 10/10 was at `ed070d8`; HEAD is `535acb8`.
   `docs/phase2-state.md:31`, `docs/evidence/phase2-provenance-and-partu.txt:34-43`.
7. **Phase-3 package gate.** Sign-off on the packaged build as the acceptance artifact
   (unsigned installer; SmartScreen warning). `docs/phase-3-report.md:249-251`.

Additional honest findings recorded in evidence but not among the seven above:
OpenCode `POST /permission/{id}/reply` still unexercised
(`docs/integrations.md:97-118`, `docs/phase-3-report.md:252-255`); two OpenCode live tests
require a non-empty live session store (`docs/phase-3-report.md:224-232`); the OpenCode
`:`4096` server was found wedged (`docs/evidence/phase2-opencode-verdict.txt:23-26`).

---

## Method and limits of this derivation

- **Sources.** Requirements were read from `README.md`, `docs/*.md`, `docs/evidence/**` and
  the code tree. No spec file exists in the repo or git history, so nothing here claims a
  directive-authored requirement the repo does not itself state.
- **Code was inspected, not assumed.** States marked IMPLEMENTED were confirmed by reading
  the module, the route table (`core/src/api/routes.ts:1809-1869`) and the matching test
  files; `NOT IMPLEMENTED`/`NOT FOUND` were confirmed by the absence of a module, schema
  table, route, or test.
- **Precedence.** Where a document and the code disagreed, the code was taken as current and
  the document cited as the requirement source. Earlier audit verdicts (e.g. identity/chat/
  scheduler "NOT IMPLEMENTED/PARTIAL") are superseded by later commits, which are named.
- **No file other than this one was modified.**
