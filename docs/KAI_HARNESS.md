# KAI — The Harness, Documented Against the Code

**Status:** describes HEAD `98a80ae` (`98a80ae9acfd927804f4c45bab0d37e14a82042f`),
2026-10-04, plus — where named — the parallel streams' in-flight changes in the working
tree (see the revision note). This is not an aspirational architecture diagram. Every
claim below cites `file:line`. Where a component named in the owner's expected diagram
**does not exist**, or exists but is **not wired**, that is stated explicitly, in its own
paragraph, with the evidence.

> The rule this document obeys: **fix the document to match the code, never the code
> to match the document.** Where the code is contradictory or the diagram is a nice
> fiction, the fiction is named.

**Revision note (this edition).** This document was first written against a stale HEAD
(`ea653cc`), updated in place against `e7697a2` (§0–§3), and is now **completed against the
working tree at commit `98a80ae`**: the §4–§24 patch set is applied, and every earlier
citation was re-anchored to the same snapshot. The claims corrected because the code moved
under them:

- **`delegateTo` now HAS a consumer.** The old §1/§4/§23 finding ("`task.delegate` does not
  delegate") is **FIXED**: `server.ts:532–560` performs the delegation through the one
  relay path, honouring `avoid`. Recorded in §4 and §23.
- **Subagent REST routes now exist** (`routes.ts:2548–2560` at this snapshot); the old "no
  HTTP route for subagents" claim is corrected in §5 and §17.
- **Identity is a KAI-owned tree** (KAI_HOME `identity/ user/ memory/ skills/ workforce/
  policy/ upgrades/`), with a KAI-owned capability catalogue and a delegation identity sent
  to workers. §1 was rewritten to match (`8fea1bf`, `acc4b67`).
- **`executionId` is now emitted on action records** by spread (`tools/registry.ts:369,
  393–403` — working tree; not yet in the committed tree), so a bus record can join a
  ledger row on ONE id; `recoveryDecision`/`employeeInstanceId` are still never produced (§16).
- **The runtime state vocabulary widened from twelve states to twenty-two**
  (`app/src/core/runtime-state.ts:39–61`) (§20).
- **The character port list shrank**: only turbulence/air filters remain unported
  (`orb.ts:20–24`) (§20).
- **MCP**: the module is committed at `98a80ae` (the manager, the 15-route `/mcp` surface,
  the capability seam, 28 tests) but the committed tree still has **zero runtime call
  sites** — the two one-line handovers are in-flight and uncommitted; live `GET /mcp` still
  404s (§21, §23).
- **Citation basis for this edition.** Every line number was re-verified on 2026-10-04
  against the working tree: HEAD `98a80ae` plus the in-flight, uncommitted changes of the
  parallel streams in `core/src/api/routes.ts`,
  `core/src/tools/{registry,builtin,workspace}.ts`, `core/src/sessions/store.ts` and
  `core/src/runtime.ts`. Those files were mid-work at verification time; each citation
  names its symbol so a moved line stays recoverable, and anything not re-verifiable is
  marked **NOT VERIFIABLE** rather than guessed. Live-capture claims name the build they
  were captured on (`b52353fd7400a6c1` / `7028f6cba503e3ef`), because two builds appear in
  the evidence.

---

## 0. The two-sentence summary

KAI is a Node/TypeScript **Core** (`core/`) served over loopback HTTP by
`core/src/server.ts` (default port 8788), with a **one-way control-plane SSE stream** at
`/core/events`, and a Tauri 2 + Rust/TS **desktop shell** (`app/`) that renders a Canvas-2D
orb character driven by Core events and Claude Code hooks. KAI is the **speaker**; Hermes,
OpenCode and subagents are *workers* it delegates to, whose output is relayed as KAI's
result with the worker named only as provenance.

---

## 1. Identity

**What exists — the KAI-owned foundation (rewritten at this HEAD).**

- The identity mechanism is `core/src/agent/soul.ts` — `createKaiIdentity()` (soul.ts:160),
  backed by the **KAI_HOME tree** resolved by `core/src/agent/kai-home.ts`
  (kai-home.ts:11–17, `resolveKaiHome` kai-home.ts:334–388): `identity/SOUL.md`,
  `identity/IDENTITY.md`, `identity/CAPABILITIES.md`, `user/USER.md`, `memory/MEMORY.md`,
  `skills/SKILLS.md`, `workforce/WORKFORCE.md` + `DELEGATION.md`, `policy/SAFETY.md`,
  `upgrades/LEARNING.md` + `UPGRADES.md`. It is **bounded** (`MAX_DOC_CHARS = 8000`,
  soul.ts:25), **redacted** (soul.ts:125–127 delegates to the one shared redactor), and
  **honest about gaps** (a missing doc degrades to `BUILT_IN_SOUL`, soul.ts:54–58, and is
  recorded in `problems`).
- A legacy flat KAI_HOME (`SOUL.md`/`USER.md`/`MEMORY.md` at the root) is **migrated**:
  `seedFileFromLegacy()` (kai-home.ts:317–327) copies the existing document into the tree
  rather than reseeding. Verified on disk: `%LOCALAPPDATA%\KAI\identity\SOUL.md` is
  byte-identical to the legacy root `SOUL.md` and differs from `SOUL_SEED`.
- `SOUL.md` reload semantics are explicit: an edit reaches KAI's **next turn** via an
  `(mtime, size)` signature check (`SOUL_RELOAD_SEMANTICS`, soul.ts:49–51; `refresh()`,
  soul.ts:249–256); `replaceSoul()` (soul.ts:268–274) is the ONE owner of the soul write.
  **Honest note:** the semantics string names `POST /soul`, but no such route exists at
  HEAD (grep over `routes.ts`); the live write path is the `soul.set` tool
  (runtime.ts:454, :728–742, handler :2640–2644).
- `selfDescription()` (soul.ts:292–304) returns the first real *sentence* of the soul, not a
  markdown heading (`firstSentence()`, soul.ts:140–150).
- **The worker-relationship invariant** is KAI-owned data:
  `core/src/agent/kai-capabilities.ts:76–82` (`WORKER_RELATIONSHIP`) — KAI is the main
  agent and conversation owner (the speaker); Hermes/OpenCode/Codex are workers; subagents
  are KAI-managed; *"a worker provides information; a worker does not become the speaker."*
  KAI's own capability catalogue (`KAI_DIRECT_CAPABILITIES`, kai-capabilities.ts:40–48),
  limits (`KAI_LIMITS`, :64–69) and renderers (`renderCapabilities` :97–110,
  `renderLimits` :113–115) live there too.
- **The delegation identity** (the L2 fix): `renderDelegationIdentity()`
  (kai-capabilities.ts:134–144) is the system instruction KAI sends a worker for a
  delegated run — "You are executing as {worker} on behalf of KAI… Never identify yourself
  as Hermes, OpenCode, Codex, Nous Research, or any other product or runtime." Wired:
  `hermesAdapter.ts:192, :210, :411`; supplied by the runtime at runtime.ts:1005–1008.
- **Core identity** — which *build* is answering — is a separate concern in
  `core/src/identity.ts`: `loadIdentity()` (identity.ts:370) returns `service`,
  `coreVersion`, a content-hash `buildId`, `gitCommit`, `protocolVersion`, `pid`, and
  `startedAt` captured ONCE at module load (identity.ts:20–23, :325–327), with a separate
  on-disk comparison (`onDiskBuildId`, `identityMatchesDisk`) and a `freshness` verdict
  (identity.ts:62–74); `identitySelfCheck()` (identity.ts:206–242) refuses a stale Core.
- The **self intents** live in `core/src/chat/router.ts`: `identity` is the FIRST rule in
  the rules table (router.ts:405; table at :403), joined by `capability.list`,
  `capability.limits`, `harness`, `independence` (RouterIntent, router.ts:114–131).
  `answerIdentity()` (router.ts:937) answers from the soul and denies the worker confusion
  ("No — Hermes is a worker I can use, not what I am").
- The **relay boundary** is `core/src/chat/relay.ts`: `presentWorkerResult()`
  (relay.ts:195) strips a worker's self-identification and KAI-prompt-internals sentences,
  and `presentWorkerFailure()` (relay.ts:311) composes KAI-voiced worker-failure text. The
  rule is grammatical, not a phrase blocklist (relay.ts:22–25); `relayGuardIsLive()`
  (relay.ts:276) is its proof-of-life.
- The **`task.delegate` intent** exists and — see below — **now actually delegates**:
  `RouterIntent` includes it (router.ts:123), the predicate is `looksLikeDelegation`
  (router.ts:265, rule at :485), and `answerTaskDelegate()` (router.ts:710–724) returns
  `delegateTo: WorkerId` (plus `avoid` when the user excluded a worker).

**What was FIXED since the previous edition of this document:**

- **`delegateTo` now has a consumer.** `server.ts:532` branches on `answer.delegateTo` and
  **performs** the delegation through the same `relayWorkerTurn` path a worker turn always
  uses (`server.ts:532–560`), honouring `avoid` (the router filters the excluded worker out
  of candidate selection: router.ts:1073–1090). The response carries `delegated: true` and
  the worker as provenance. The old finding — *"`task.delegate` produces the sentence and
  hands it to nobody"* — is closed. The unknown-turn fallback (`answerUnknown()`,
  router.ts:1070–1105) also returns `delegateTo` when a worker is connected, and it too is
  consumed by the same branch.
- **The router decides every turn.** `server.ts:496–573`: every turn is classified and
  answered by KAI first; a state answer or KAI's own text is returned when no delegation is
  chosen. There is no raw pipe to a worker bypassing the router.

**What does NOT exist / is not wired:**

- The router's `artifact.run_tests` intent is **deliberately inert** (router.ts:493, :909)
  and says so; do not read it as an implemented capability.
- `POST /soul` does not exist as a route (§1 above).
- The mission-brief identity field set (`agentId`, `displayName`, `…Authority`) is **not
  implemented anywhere** — repo-wide grep finds no such fields (see `docs/KAI_SOUL.md` §4c;
  `docs/evidence/kai-soul-independent.json`).

---

## 2. Sessions

**What exists.**

- KAI owns real conversation sessions in `core/src/sessions/`:
  - `store.ts` — `createSessionStore()` (store.ts:312), its **own SQLite file**
    (default `<dbDir>/kai-sessions.db`, runtime.ts:1708), with `KaiSession`
    (store.ts:43) and `SessionTurn` (store.ts:88).
  - `service.ts` — `createSessionService()` (service.ts:67) owns the rules: exactly one
    ACTIVE session (service.ts:83–101), unknown id is an error **value**, archiving the
    active session moves the pointer (service.ts:113–122).
  - `index.ts` re-exports both.
- The worker's own conversation id is stored **on** the KAI session as `agentSessionId`
  (store.ts:72; rationale store.ts:22–26) so a later turn continues the same worker
  conversation after a Core restart.
- Persona-owned sessions: a subagent's session is created with `agentId: sub.employeeId`
  (`routes.ts:2301`), so a persona's history never merges into KAI's.
- HTTP surface: `/sessions`, `/sessions/active`, `/sessions/:id`, `/sessions/:id/turns`,
  rename/archive/unarchive/activate (routes.ts:2618–2626). Mutating ops go through the
  `session.manage` tool (runtime.ts:2648+) — policy-checked like everything else.
- **Rust side:** `app/src-tauri/src/claude.rs` keeps a *direct-Claude* multi-turn history
  keyed by KAI session id (`conversations: Mutex<HashMap<String, Vec<Value>>>`,
  claude.rs:61). For the Core path it deliberately does NOT cache the worker `session_id`;
  the turn carries `conversation_id` and Core resolves the binding (`core_chat`,
  claude.rs:273).

**What does NOT exist.** No session **search**, no cross-session summary, no session
import/export. Sessions are list/rename/archive/activate only.

---

## 3. Context — how SOUL.md, memory, skills and the current request combine

**What exists.** There is exactly **one** composer: `core/src/prompts/compose.ts` —
`createPromptComposer()` (compose.ts:250), wired once in the runtime (runtime.ts:1723–1771)
and exposed as `CoreRuntime.composeTurnPrompt()` (runtime.ts:2270, declared runtime.ts:296).

The pipeline is a **fixed-order, bounded, fenced** assembly (compose.ts:16–32):

- Order is `SECTION_ORDER`, and the composer is the only assembler, so a body cannot
  reorder anything (compose.ts:19–20).
- **Trust is structural:** `safety`, `identity`, `user-context` and `request` are
  `instruction`; `memory`, `skills` and `mission` are `data` — wrapped in an explicit
  `DATA - NOT INSTRUCTIONS` fence (compose.ts:111–119). A body that forges the fence is
  neutralised (compose.ts:22–24).
- **Bounds are real and reported:** per-section and total budgets in `DEFAULT_LIMITS`
  (compose.ts:84–95, total 18000), bounded recall counts `DEFAULT_RECALL` (compose.ts:98),
  each bound reported in `SectionReport`.
- The composer reads live `identity.soul` / `identity.user` via **getters**
  (runtime.ts:1725–1732) so a `SOUL.md` edit reaches the next turn without a rebuild;
  memory recall is **scope-isolated** through `recallScoped` (runtime.ts:1748) with the
  persona-aware path for `subagent:<id>` (runtime.ts:1743–1747); skill retrieval is
  **metadata-only** via `skills.relevant` (runtime.ts:1762–1770).

**How a turn actually uses it:** `server.ts` calls `core.composeTurnPrompt(text)` before
relaying to the worker (server.ts:538 for delegated turns, server.ts:614 for the OpenCode
route), and the composed prompt **ends with the user's request**; if composition throws,
the raw text is used. So the worker receives KAI's identity + recalled memory + relevant
skills + the request, in that fixed order.

**Honest note.** This is the *documented* combination. The composer is a real module with
real call sites — this is **not** the "zero call sites" defect the audit found historically
(compose.ts:8–13 describes that fix).

---

## 4. Routing — how KAI decides who answers

The decision point is `core/src/chat/router.ts::classify()` (router.ts:556–566): an ordered
set of regex/predicate rules (**not a model**). Order is significant — `RULES` is walked top
to bottom (table at router.ts:403, walked at :559–562). The intents are `RouterIntent`
(router.ts:114–130): `identity · capability.list · capability.limits · harness ·
independence · status.summary · agent.status · agent.list · task.delegate · mission.list ·
approval.list · notification.list · memory.list · memory.remember · artifact.run_tests ·
unknown`.

The decision tree actually executed by `server.ts` (the real dispatcher):

| Input | Path | Where |
|---|---|---|
| any state/self intent | `core.chat.answer(text)` → answer built **from live runtime state**, `agent: "core"` | server.ts:530–574 |
| `memory.remember` + not host-attested | **refused before `answer()`**, nothing written | server.ts:515–527 |
| `unknown` | KAI's fallback answer; with a connected worker, `answerUnknown` returns `delegateTo` and the SAME branch below performs it — never a raw pipe | router.ts:1070–1105 → server.ts:532–560 |
| `/agents/opencode/chat` | OpenCode relay | server.ts:601–640 |

**How KAI decides between answering itself / a worker / a capability / a `task.delegate` —
the blunt truth:**

- **Answering itself:** the router's state intents (`status`, `agent.*`, `mission.list`,
  `approval.list`, `notification.list`, `memory.*`, `identity`). These read numbers, names
  and lists out of the injected runtime/memory service and **never invent one**
  (router.ts:9–19; e.g. `answerStatusSummary`, router.ts:608+). The answer is returned as
  KAI's own voice at server.ts:563–574.
- **A worker (Hermes or OpenCode):** for an unrecognised task turn KAI delegates to the
  first CONNECTED worker it is allowed to use (router.ts:1081–1090, honouring `avoid` —
  `avoidWorker`, router.ts:287), and `server.ts:532–560` performs it. The hard-coded Hermes
  relay survives only as the no-Core fallback for the server's own tests (server.ts:576–592).
- **OpenCode:** reachable through its explicit `/agents/opencode/chat` route (server.ts:601),
  and also choosable by the router for a delegation — named explicitly ("hand this to
  OpenCode", router.ts:711–717) or as the connected candidate (router.ts:1081–1090). `WorkerId`
  is `"hermes" | "opencode"` (router.ts:132).
- **Codex:** never a delegation target — not in `KNOWN_AGENT_IDS` (router.ts:177). It is
  registered as a *known-unavailable* employee (runtime.ts:1098–1101) and nothing routes to it.
- **A capability:** the router never selects a capability. Capabilities are reached through
  the **tool registry** (`capability.*` tools), not the chat router (registerCapabilityTool,
  runtime.ts:1334).
- **`task.delegate`:** classifies, produces the sentence, **and delegates for real**:
  `server.ts:532` branches on `answer.delegateTo` and performs the handoff through the same
  `relayWorkerTurn` path a worker turn always uses (server.ts:532–560), honouring `avoid`
  (the router filters the excluded worker out of candidate selection, router.ts:1081). The
  response carries `delegated: true` and the worker as provenance. The old finding — *"the
  intent produces the sentence and hands it to nobody"* — is closed (see §23).

**Provenance at the relay.** The delegated branch and both relays call `presentWorkerResult`
and return `agent: "core"`, `worker: "hermes"|"opencode"`, `worker_identity_guarded: bool`
(server.ts:549–559 delegated, :630–640 OpenCode, :585–592 the no-Core fallback). KAI keeps
the turn; the worker is provenance.

---

## 5. Workforce

**What exists.**

- `core/src/workforce/manager.ts` — `createWorkforceManager()` (manager.ts:248). It is the
  layer **above** the adapter registry: it owns *employees* (lifecycle state, enabled,
  role, capability grants). Three invariants, written out at manager.ts:16–31: errors and
  missing employees are **values** (manager.ts:18–22), duplicate registration loses nothing
  (manager.ts:23–27), illegal lifecycle moves are **refused** (manager.ts:29–31).
- `discovery.ts` (trusted-source discovery placeholders), `lifecycle.ts` (the state
  machine table `EMPLOYEE_TRANSITIONS`, lifecycle.ts:57 → DISCOVERED / INSTALLING /
  INSTALLED / AUTHENTICATING / READY / DEGRADED / UNAVAILABLE / DISABLED / REMOVED),
  `employee.ts` (descriptor/instance/snapshot helpers).
- Runtime wiring: `workforce` created at runtime.ts:1032; **Hermes** and **OpenCode**
  registered as employees owning the SAME adapter objects the registry owns
  (runtime.ts:1091–1092); **Codex** registered UNAVAILABLE with the reason
  (runtime.ts:1098–1101).
- Delegation goes through the worker tool: `executeTask` calls
  `tools.invoke("agents.run_task", …)` (runtime.ts:1052), so a delegation is
  validate → policy → approval → execute like any action.

**The subagent registry — verified, and wired.**

- `core/src/workforce/subagent.ts` is real. `createSubagentRegistry()` (subagent.ts:227)
  defines persona specs (`KaiSubagentSpec`: id/name/role/soul/workerId/model/capabilities/visual,
  subagent.ts:85), persisted to `<dbDir>/kai-subagents.json` (runtime.ts:975).
- **It IS wired.** The runtime creates the registry (runtime.ts:2538–2540), and
  `registerSubagentEmployee()` (runtime.ts:2588–2599):
  1. builds an `EmployeeDescriptor` borrowing the preferred worker's adapter
     (`descriptorForSubagent`, runtime.ts:2589; descriptor at subagent.ts:371),
  2. registers it in the **one** workforce (`workforce.register(descriptor, {kind:"subagent"})`,
     runtime.ts:2592),
  3. remembers the persona's worker + (redacted) preamble and assigns its unique role
     `subagent:<id>` (runtime.ts:2595–2599).
  The path is shared by `createSubagent` (the HTTP/tool path) and by `start()` — the boot
  path that re-registers every persona so `/subagents` does not fall back to UNKNOWN after
  a restart (runtime.ts:2580–2587, :2627–2636, :2797–2799).
- **The `subagentCreate` tool** exists: `MUTATION_TOOLS.subagentCreate = "workforce.subagent"`
  (runtime.ts:453), the tool definition at runtime.ts:711–724, dispatched to
  `deps.createSubagent` (runtime.ts:724).
- **Safety is structural, not a promise** (subagent.ts:17–29): a subagent has no handle to
  the tool registry, policy engine or approval service; it runs only through the
  workforce's policy-governed `executeTask`; a persona whose worker is unavailable
  registers **UNAVAILABLE** (subagent.ts:415–419) and the manager refuses to delegate to it.

**What does NOT exist / partial.**

- A subagent's **visual** half is only a *reference*: `SubagentVisual.variant` names a
  bundle, but the runtime wires **no** `KaiVariantResolver` — `createSubagentRegistry` is
  called with `{ path }` only (runtime.ts:2538–2540), so `resolveVisual()` returns the
  declared reference and never a resolved asset (subagent.ts:291–300). The `variant`
  bundle model in `app/src/character/variant.ts` is **not connected** to the Core's
  subagent registry.
- **The REST surface EXISTS** — the earlier "no HTTP route for subagents" claim is
  corrected: `/subagents` (GET/POST), `/subagents/:id`, `/subagents/:id/duplicate`,
  `/archive|/unarchive`, `/run`, `/subagents/:id/sessions`, `/subagents/:id/message`
  (routes.ts:2548–2560). See §17.
- No subagent **delegation-by-id from chat**: the chat router does not know subagents exist
  (its worker vocabulary is hermes/opencode only).

---

## 6. Capabilities

**What exists.** `core/src/capabilities/`:

- `registry.ts` — `createCapabilityRegistry()` (registry.ts:222). Two invariants
  (registry.ts:15–33): a capability's declared `risk` may never be **lower** than its most
  dangerous action (refused as POLICY_DENIED), and availability is **under-claimed**, never
  over-claimed (a disabled capability cannot be probed back to life).
- `manager.ts` — `createCapabilityManager()` (runtime.ts:1154), one live manager.
- `matrix.ts` — the grant matrix (matrix.ts:5).
- **Real transports**, connected **lazily** on first use: the CUA computer transport
  (`capabilities/computer/`, `ensureComputer`, runtime.ts:1128, called at :1240/:1416) and a
  headless CDP browser (`capabilities/browser/`, `ensureBrowser`, runtime.ts:1141, called at
  :1209/:1452). A failure is remembered and reported as the *reason* a capability is
  unavailable.
- Capability actions are exposed as tools named `capability.<id>` (registerCapabilityTool,
  runtime.ts:1334; called for every registered spec at :1606), so they pass the same
  policy/approval boundary, and their action records name the capability automatically
  (tools/registry.ts:354–356, :383).
- HTTP: `/capabilities`, `/capabilities/:id`, `/capabilities/:id/test` (routes.ts:2561–2563).

**What does NOT exist.** Voice / phone capabilities are named in the design vocabulary
(registry.ts:8) but there is no transport wired for them; only **browser** and **computer**
have real transports in the committed tree. Everything else is registered metadata — with
one in-flight exception: the MCP capability is being replaced by a *measured* one in the
working tree (§21).

---

## 7. Policy — READ / WRITE / EXTERNAL / DESTRUCTIVE

**What exists.** `core/src/policies/gate.ts` — `createPolicyEngine()` (gate.ts:227). The
security posture is a literal, single table (`DEFAULT_OUTCOME`, gate.ts:99–104):

```
READ        -> allow
WRITE       -> needs_approval
EXTERNAL    -> needs_approval
DESTRUCTIVE -> needs_approval
```

- Nothing denies by default; an unrecognised risk string is treated as `needs_approval`
  (`unknown-risk`, gate.ts:254–263).
- Explicit rules beat the mode (gate.ts:266–277). Malformed rules are **dropped toward the
  safe default** (normalizeRules, gate.ts:120–136), not trusted.
- Every decision carries a `source` naming the authority: `default` / `rule:<id>` /
  `mode:<mode>` / `unknown-risk` / `no-gate` (PolicySource, gate.ts:72–77).
- **Modes** (`core/src/policies/mode.ts`): `ask-all · normal · auto-read · elevated`
  (mode.ts:79–84). `normal` IS the historical behaviour. Two invariants asserted in tests:
  **no mode ever auto-allows DESTRUCTIVE or EXTERNAL**, and **no mode is reached by
  inheritance** — only a confirmed, owner-only, two-phase transition changes it
  (mode.ts:30–39, :139–213). `elevated` may not be scoped globally (mode.ts:150–152).
- Runtime wiring: `policy` at runtime.ts:1520–1531, with caller rules first and KAI's own
  internal-state authorization (`kai-internal-state`) appended **last** so it is a
  default that can be narrowed (runtime.ts:1524–1527).

**What does NOT exist.** No per-user policy, no policy persistence across restart (rules
live in memory and are replaced by `policy.set`), no time-of-day policy.

---

## 8. Approval

**What exists.** `core/src/approvals/service.ts` — `createApprovalService()`. It records
the request, **expires it**, and reports the verdict; it never decides and never calls a
tool (service.ts:5–10). Default TTL 10 minutes (`DEFAULT_APPROVAL_TTL_MS`, service.ts:63).

- The registry is what **enforces** the approval↔tool binding at invoke time
  (tools/registry.ts:685–720): an approval for tool A cannot authorise tool B
  (registry.ts:685–699); a REJECTED approval is refused (:701–709); an EXPIRED one is
  refused (:711–720); one that is still PENDING is not a yes (:721–732).
- `waitFor(id)` is freed by all three settling paths (human `decide`, `expireStale`, the
  per-request timer) so a mission parked on an answer cannot outlive its deadline
  (service.ts:23–28, 82–90).
- A worker's permission/question requests are a **separate** stream (see §19): OpenCode
  permissions/questions are relayed via `/agents/opencode/permissions/:id/reply` and
  `/agents/opencode/questions/:id/reply` (server.ts:678–731).
- HTTP: `/approvals`, `/approvals/:id/decide` (routes.ts:2573–2574).

**What does NOT exist.** `approval.expired` is deliberately **not** an event — the frozen
`KaiEventType` has no such member, so `expireStale()` publishes nothing (service.ts:30–34).
Do not expect an SSE frame on expiry. (Boot-time expiry of stale approvals is surfaced as a
`notification.created` — runtime.ts:2820–2826 — not as an `approval.expired` event.)

---

## 9. Missions

**What exists.** `core/src/missions/{executor,mission}.ts`.

- `mission.ts` — the `MissionStep` shape (`sideEffecting`, mission.ts:29; defaulted false,
  mission.ts:81).
- `executor.ts` — `createMissionExecutor()` (executor.ts:201). It is deliberately
  **tool-ignorant**: any `kind: "tool"` step is treated as EXTERNAL because the executor
  knows no safe tools (`KNOWN_SAFE_TOOLS` is empty, executor.ts:170; `riskForStep`,
  executor.ts:172–180). The runtime supplies the narrower judgement.
- **Side-effect derivation** lives in the runtime: `tool.risk !== "READ" || tool.effectful === true`
  (runtime.ts:2095; the `effectful` flag is registry.ts:75). **A mission template may only
  RAISE `sideEffecting`, never lower it** (runtime.ts:2099).
- The **mission gate** re-derives risk from the tool registry so a template cannot lower a
  tool's risk (missionGate, runtime.ts:1784–1793).
- Step execution: `rawRunner` (runtime.ts:1801) routes `tool` steps through the registry,
  `agent` steps through the agent registry (via `agents.run_task`, runtime.ts:1860), and
  reports `manual` steps as satisfied-with-a-note rather than pretending.
- The **autonomy supervisor** (`core/src/autonomy/supervisor.ts`; wired at runtime.ts:1917–1932)
  subscribes to the bus and evaluates FAILED missions; `maxAttempts` defaults to **1** and
  `0` disables the loop (supervisor.ts:25, :144, :183–192).

**What does NOT exist.** No mission *planner* that turns a natural-language request into
steps. Missions are created explicitly (`POST /missions` / `missions.create`); the router
has no "start a mission" intent. There is no mission DSL beyond the step array.

---

## 10. Recovery

**What exists.** `core/src/recovery/{ledger,boundary}.ts`.

- `ledger.ts` — `createExecutionLedger()` (ledger.ts:186): a **durable SQLite ledger**
  (schema ledger.ts:145–164) with phases `BEFORE_ACCEPT` / `AFTER_ACCEPT` (ledger.ts:166)
  and statuses RUNNING / COMPLETED / FAILED (ledger.ts:167). `executionIdFor()` gives a
  deterministic id per (mission, step) (ledger.ts:141–143).
- The runtime passes `ledgerPath = <dbDir>/recovery-ledger.db` (runtime.ts:973, created at
  :1702), so the effective default for the real Core is
  `%LOCALAPPDATA%\KAI\core\recovery-ledger.db`. (A module-level `defaultLedgerPath()`
  returning `kai-recovery-ledger.db` exists at ledger.ts:130–137, but the runtime always
  supplies its own path first.)
- `boundary.ts` — `createBoundaryRunner()` (boundary.ts:77) wraps the executor's
  `StepRunner` seam so a **side-effecting** step records `begin()` (BEFORE_ACCEPT) then
  `accept()` (AFTER_ACCEPT) **before the effect** (boundary.ts:14–24, 84–111). A step whose
  execution classifies AFTER_ACCEPT or UNKNOWN is **REFUSED rather than replayed**
  (boundary.ts:94–98). Non-side-effecting steps take the fast path untouched (boundary.ts:82).
- Failures that provably **never attempted the effect** (`EFFECT_NOT_ATTEMPTED` set:
  VALIDATION_FAILED / POLICY_DENIED / NOT_FOUND / APPROVAL_REQUIRED / AGENT_CAPABILITY_MISSING,
  boundary.ts:53–59) are rewound to BEFORE_ACCEPT so a later recovery may replay
  (boundary.ts:121–134). A failure *during* the effect stays AFTER_ACCEPT.
- The runtime wraps the runner once:
  `runner = createBoundaryRunner(rawRunner, { ledger: recovery })` (runtime.ts:1900).
- HTTP: `/recovery/status`, `/recovery/classify` (routes.ts:2603–2604).

**What does NOT exist.** No automated *replay executor* is wired into the runtime lifecycle
— `replayIfSafe()` (boundary.ts:258) exists as a library function but has no production
call site; recovery surfaces a status and a classification, and the maintenance repair
resumes missions (`missions.recover()`, runtime.ts:1993 / boot :2827) rather than replaying
ledger rows.

---

## 11. Memory

**What exists.** `core/src/memory/*` + `core/src/storage/memoryStore.ts`.

- `engine.ts` — `createMemoryEngine()` (wired at runtime.ts:991). One value owns memory
  policy; `write` = bounds → dedup(hash) → persist → journal → publish (engine.ts:12). It
  is the only place that writes an entry, appends a journal row, or renders on-disk layout
  (engine.ts:8–10).
- **Bounded:** `checkWriteBounds` / `MEMORY_SCOPE_BOUNDS`; **provenance-tagged:**
  `MemoryProvenance` (model.ts:102+), and an OMITTED provenance is the **most restrictive**
  value, `system_state` (engine.ts:437–446). **Scope-isolated:** search takes
  `MemoryScopeAccess[]`, defaulting to global only (engine.ts:106–116).
- `storage/memoryStore.ts` — `openMemoryStore()`: its **own connection to the same
  database file** (memoryStore.ts:13–20), `memory_entries` / `memory_topics` /
  `memory_journal` tables. **FTS5 is DETECTED, never assumed** (memoryStore.ts:22–28); the
  journal is append-only with no UPDATE/DELETE path (memoryStore.ts:30–33).
- Legacy compatibility: the flat `memories` rows are imported once (`importLegacy`,
  engine.ts:30–34; `importLegacyOnCreate: true` at runtime.ts:991), and the legacy
  `MemoryService` keeps serving `/memory` unchanged.
- Scopes resolved in the runtime: `parseMemoryScopeRef` (runtime.ts:195),
  `rememberScoped`/`recallScoped` (runtime.ts:2356, :2373), and mission/employee/session
  convenience wrappers (runtime.ts:2395–2460).
- HTTP: `/memory`, `/memory/search`, `/memory/write`, `/memory/journal`, `/memory/:id`
  (routes.ts:2575–2583).

**What does NOT exist.** No vector/semantic embeddings — retrieval is FTS5 or a
KAI-native token scan. No cross-scope promotion path. No memory *UI* beyond the routes.

---

## 12. Learning

**What exists.** `core/src/learning/` (`classify.ts`, `pipeline.ts`, `types.ts`, barreled
by `index.ts`).

- `createLearningPipeline()` (runtime.ts:1682–1691) classifies a completed turn as
  MEMORY | SKILL | NONE (learning/index.ts:6–10) and:
  - a **memory** candidate is written to the LIVE engine with `provenance: "model_candidate"`
    (runtime.ts:1684–1691),
  - a **skill** candidate is only ever **STAGED** — `submit` has no code path that installs
    anything (runtime.ts:1680–1681).
- Host-attested **user** authority: the Hermes relay fires `learning.propose` with
  `source: "user"` ONLY when the request carries the shared host token (server.ts:484–496);
  the HTTP `/learning/propose` route denies `source: "user"` by default. Fail closed: with
  no token, nothing is learned (server.ts:483).
- HTTP: `/learning/propose`, `/learning/staged`, `/learning/staged/:stagedId/approve`
  (routes.ts:2610–2612).

**What does NOT exist.** No autonomous skill promotion — every skill path ends at a human
approval. No model training or weight updates of any kind (maintenance/index.ts:18–23
explicitly disclaims "self-replacing binaries").

---

## 13. Skills

**What exists.** `core/src/skills/*`.

- `registry.ts` — `createSkillRegistry()` (registry.ts:74). Lifecycle: register / list /
  inspect / load / disable / enable / delete. `register()` is **CREATE-ONLY** and refuses
  a duplicate id (registry.ts:21–25).
- **Progressive disclosure is real:** `list()`/`relevant()` return **metadata only** and
  never open a `SKILL.md` body; `load(id)` is the ONLY method that reads a body
  (registry.ts:13–19).
- `staging.ts` — the staged→human-approved→**exact-byte** install pipeline
  (staging.ts:8–34). The bytes the human approved must be the exact bytes installed:
  `stage()` returns the SHA-256, `requestInstallApproval(stagedId, sha256)` binds it, and
  `installApproved()` **re-hashes** and refuses a mismatch (staging.ts:16–29). Every
  install is an immutable, content-addressed revision; rollback moves the pointer, never
  rewrites bytes (staging.ts:26–29).
- **Tamper-refused / fail-closed:** with no approval service wired, an install is refused
  (`NO_APPROVER`, staging.ts:107–110).
- Runtime wiring: `skills` + `skillStaging` (using the SAME approval service,
  runtime.ts:1674–1675); READ-only skill tools registered (runtime.ts:1676).
- HTTP: `/skills`, `/skills/relevant`, `/skills/staging`, `/skills/staging/:id/approve`,
  `/skills/staging/:id/install`, `/skills/:id/load|enable|disable|delete` (routes.ts:2585–2596).

**What does NOT exist.** No automatic skill discovery from disk on startup (skills are
registered/staged explicitly). `SKILL_INSTALL_TOOL_ID = "skill.install"` (staging.ts:51)
is an approval binding id, not a registered executable tool.

---

## 14. Scheduler

**What exists.** `core/src/scheduler/{scheduler,jobs,schedule,lease}.ts`.

- `createScheduler()` (runtime.ts:2054) is a **persistent runtime**, not a request handler
  (scheduler.ts:4–11). State lives in the store; every fire is written back
  (lastRun/nextRun/failureCount/enabled, scheduler.ts:16–18). Time is injected
  (scheduler.ts:19–21). A broken task is **quarantined** with a max-failure cap
  (scheduler.ts:23). A fire may be **claimed with a durable lease** so two processes cannot
  run the same slot (scheduler.ts:24–28).
- `jobs.ts` — the shipped `createScheduledJobRunner` (jobs.ts:109) routes every fire
  through the **same** validate → policy → approval → execute boundary, so a job
  configured yesterday is checked against today's permissions (scheduler.ts:30–34,
  jobs.ts:5–16).
- Interrupted leases are recovered (`scheduler.recoverInterrupted()`, runtime.ts:1990,
  boot :2842; `/scheduler/recover`, routes.ts:2601).
- HTTP: `/schedules`, `/schedules/:id/cancel`, `/scheduler/recover` (routes.ts:2598–2601).

**What does NOT exist.** No cron-expression GUI beyond the stored schedule spec; no
distributed scheduler beyond the per-slot lease (single machine assumed).

---

## 15. Checkpoints

**What exists.** `core/src/checkpoints/checkpoint.ts` — `createCheckpointManager()`
(runtime.ts:1695).

- KAI-owned **shadow git** snapshots before a risky operation. Two hard rules
  (checkpoint.ts:9–27): (1) it **never touches the user's git metadata** — a separate
  `<root>/<id>.git` with `GIT_DIR`/`GIT_WORK_TREE` pointed correctly, `.git/` excluded;
  (2) it **never reports a rollback that did not happen** — `restore()` re-hashes the whole
  tree and only reports `{ok:true, verified:true}` on an exact manifest match.
- The manifest is KAI's own (path → sha256) computed in Node, independent of git
  (checkpoint.ts:25–27).
- HTTP: `/checkpoints` (GET/POST), `/checkpoints/:id/restore` (routes.ts:2606–2608);
  `checkpoint.restore` is DESTRUCTIVE.

**What does NOT exist.** No automatic checkpoint on every write — checkpoints are explicit.
No cloud/remote checkpoint store.

---

## 16. Observability

**What exists.** `core/src/observability/{action-record,correlation}.ts`.

- `action-record.ts` — `buildActionRecord()` (action-record.ts:83). Every executable action
  emits exactly one `action.executed` record on the ONE bus (tools/registry.ts:317, publish
  at :405). It carries `coreBuildId` (the anti-stale-Core field, action-record.ts:18–20),
  `toolId`, `policyDecision`, `decisionSource`, `resultState`, bounded redacted `detail`
  (MAX_DETAIL 400, action-record.ts:76), and an `actionId`.
- **`executionId` is now attached by SPREAD** (working tree; see the note below).
  `recordAction` resolves it from the causal mission step using the acceptance ledger's own
  formula (`executionIdFor`, imported at tools/registry.ts:42; resolved at :369) and
  attaches it to an *enriched* record shape `ActionRecord & { executionId?: string }`
  (tools/registry.ts:393–403). So a bus record and a ledger row can now join on ONE id.
- `correlation.ts` — the READ side: `traceArtifact(events, ref)` (correlation.ts:131) and
  `scheduleOriginOf()` (correlation.ts:167) answer "which schedule/mission/turn caused this
  memory/skill/learning write?" by matching an artifact id to the action record that names it.
- HTTP: `GET /actions` returns persisted `action.executed` events (routes.ts:2535,
  `listActions` :1772).

**VERIFIED — the correlation-id audit finding is now only partially true.** The
`ActionRecord` **declares** `recoveryDecision` (action-record.ts:54) and
`employeeInstanceId` (action-record.ts:60), and `buildActionRecord` accepts both
(action-record.ts:95, 103, 123, 131). **But the registry's `recordAction` never passes
either one.** Grep confirms `recordAction` (tools/registry.ts:348–405) sets only:
`employeeId`, `capabilityId`, `approvalId`, `memoryId`, `skillId`, `learningEventId`,
`scheduleId`, `checkpointId`, `missionId`, `turnId`, `executionId`, `detail`. Consequences:

- **`recoveryDecision` is always `undefined`** on every emitted record — the only
  assignments to it are the type declaration and `buildActionRecord`'s copy
  (action-record.ts:54, 131); nothing reads the ledger to fill it.
- **`employeeInstanceId` is always `undefined`** — the registry sets `employeeId`
  (from `employeeOfToolInput`, action-record.ts:143–148) but never the *instance* id.
- **`executionId` — the third gap — is closed in the working tree.** It is not *declared*
  on `ActionRecord` (action-record.ts:37–74), but the registry attaches it by spread
  (tools/registry.ts:369, 393–403) from the ledger's one `executionIdFor` formula — so the
  recovery ledger's own `executionId` (ledger.ts:52) and the bus record now share an id.

**Net:** a recovery row **can now be correlated from the bus** via `executionId`; an action
still cannot name a specific employee *instance* or a recovery *decision*. The type
advertises two fields the emitter never produces.

**The real correlation ids that ARE populated:** `coreBuildId`, `missionId`, `turnId`,
`scheduleId`, `employeeId`, `capabilityId`, `approvalId`, `memoryId`, `skillId`,
`learningEventId`, `checkpointId`, `executionId`, `actionId` (tools/registry.ts:348–405).

---

## 17. Subagents

See §5. In short: `core/src/workforce/subagent.ts` + the `workforce.subagent` tool ARE
wired (runtime.ts:2538–2599). They are personas on top of the ONE workforce and the ONE
policy path. The **REST surface exists** — `/subagents` (GET/POST), `/subagents/:id`,
`/duplicate`, `/archive|/unarchive`, `/run`, `/sessions`, `/message` (routes.ts:2548–2560).
The persona `/message` path (`subagentMessageHandler`, routes.ts:2281+) parks the first
call (409 + `approvalId`), re-issues the exact parked call through the SAME approval gate,
composes the persona's own reply (`personaReply`, subagent.ts:352) and records it on the
persona's own session. The **visual variant resolver is NOT wired** (runtime.ts:2538–2540
passes no `variants`), so persona appearance resolves to a declared reference only.

---

## 18. Self-improvement / self-maintenance

**What exists.** `core/src/maintenance/index.ts` — `createMaintenanceService()`
(maintenance/index.ts:102; wired at runtime.ts:1937); routes `/maintenance/status` and
`/maintenance/run` (routes.ts:2614–2615).

- `status()` (maintenance/index.ts:147) inspects: **identity** (the anti-stale check —
  running `buildId` vs the `build-info.json` on disk, maintenance/index.ts:105–120),
  **database**, **sessions**, **recovery-ledger**, **agents** (WARN not FAIL if offline,
  maintenance/index.ts:136–139), **scheduler**.
- `run()` (maintenance/index.ts:158) performs four repairs KAI may touch: **memory-upkeep**
  (one idempotent cycle), **scheduler-recovery** (settle dead leases), **mission-recovery**
  (resume/refuse crash-interrupted missions), **view-sync** (re-derive employee↔capability
  views).

**What does NOT exist — stated plainly in the module itself (maintenance/index.ts:18–23):**
no network, **no downloads**, **no self-replacing binaries**, nothing outside KAI's own
directories. "Upgrading" here means only *"report precisely which build is running and
whether it is the one on disk."* There is **no** code-modifying self-improvement and **no**
LLM that rewrites KAI.

---

## 19. Scheduler vs. runtime events — the wire vocabulary (critical verification)

**The claim to settle:** *the worker-runtime vocabulary in `core/src/shared/runtime-events.ts`
is NEVER on the wire because `bus.attachProvider` has zero call sites.*

**VERDICT: the claim is TRUE (re-verified at this revision).**

Evidence:

1. `attachProvider` is **defined** in `core/src/events/bus.ts:356` and appears in the
   `EventBus` interface (bus.ts:121). A repo-wide grep for `attachProvider` returns
   **only** its definition, its interface entry, tests, and compiled `dist/`/`bundle/`/
   `target/` copies. **Zero production call sites.**
2. Consequently `ingestRuntime` (bus.ts:285), `subscribeRuntime` (bus.ts:383) and
   `recentRuntime` (bus.ts:401) are never called in production either.
3. The two bridge helpers in `runtime-events.ts` — `toControlPlaneEvent`
   (runtime-events.ts:337) and `serializeRuntimeEvent` (runtime-events.ts:314) — have **no
   production call sites**.
4. The SSE endpoint that DOES exist, `/core/events` (server.ts:739–752), is bridged by
   `attachEventStream()` (routes.ts:92), which subscribes **only** to
   `runtime.bus.subscribe(...)` (routes.ts:113) — i.e. the **control-plane** `KaiEvent`
   stream. It never touches `subscribeRuntime`.
5. The desktop UI's own FSM comment states it outright: *"no `TurnAdapter` provider is
   currently attached to the Core's bus, so the Core does not emit them on the wire today"*
   (`app/src/core/runtime-state.ts:240`).

**Therefore:**

- The **wire vocabulary** is **control-plane only**: `mission.*`, `approval.*`, `agent.*`,
  `action.executed`, `core.*`, `scheduled_task.triggered`, `session.*` — carried as
  `KaiEvent` objects over `/core/events`.
- The `RuntimeEvent` union (`turn.started`, `item.started/completed/delta`,
  `request.opened/resolved`, `turn.completed/failed`, `session.started/exited/error`) is
  **implemented, type-checked, redaction-guarded, unit-tested — and dead on the wire.** It
  is a complete, unused subsystem.
- The `TurnAdapter` protocol (runtime-events.ts:231) and the `ProviderBinding` ingress
  (bus.ts:73) are likewise **built but unattached**.

Do not draw a diagram in which worker turns stream to the UI. They do not.

---

## 20. UI — how runtime events become visual KAI states

**What exists.**

- `app/src/core/runtime-state.ts` defines the **twenty-two** runtime states
  (`KaiRuntimeState`, runtime-state.ts:39–61): `IDLE · LISTENING · THINKING · PLANNING ·
  RESEARCHING · BROWSING · CODING · WORKING · USING_TOOL · USING_CLI · USING_BROWSER ·
  USING_CUA · DELEGATING · MULTI_AGENT · WAITING · WAITING_APPROVAL · LEARNING ·
  BUILDING_SKILL · RECOVERING · SUCCESS · ERROR · OFFLINE`.
- `stateForEvent()` (runtime-state.ts:243–359) maps **real** Core events → state. The
  mapping names the control-plane events that actually reach the stream (missions,
  approvals, `action.executed`, `agent.*`, `core.*`, `scheduled_task.triggered`) and
  **also pre-maps** `turn.*`/`item.*`/`request.*` "IF they ever reach the stream" — which,
  per §19, they do not.
- `characterStateFor()` (runtime-state.ts:132) maps each runtime state → the character's
  `BotStateName` pose (e.g. USING_TOOL→`searching`, WAITING_APPROVAL→`approval`).
- `KaiRuntimeMachine` (runtime-state.ts:383) is **event-driven and honest**: every non-IDLE
  state is entered/left by a real event; the only timers are a **bounded safeguard** —
  SUCCESS/ERROR hold 4 s then return to IDLE (`resultHoldMs`, runtime-state.ts:390), any
  active state times out at 10 min (`maxActiveMs`, :397), and an outage that outlives a
  1.5 s grace becomes OFFLINE (`offlineGraceMs`, :409; `tick()`, :573). `WAITING_APPROVAL`
  is **sticky** — only a decision or terminal event leaves it (`APPROVAL_LEAVING`,
  runtime-state.ts:365–374; sticky check :502). Live subagent counting is real
  (`subagent.started`/`subagent.stopped`, runtime-state.ts:415–487).
- Place ↔ machine separation: `app/src/island/fsm.ts` — `IslandStateMachine` is **placement**
  only (hidden/petit/home/greet, fsm.ts:32+), and re-exports `KaiRuntimeMachine` as the
  runtime half (fsm.ts:21–30). They are independent: the window can be hidden while KAI works.
- **Claude Code hooks** are a second event source: `app/src/island/hooks.ts` maps hook
  payloads (UserPromptSubmit, tool events, permission requests) to island steps/approval
  cards (hooks.ts:1–60+), with a Windows-specific "no terminal filter" note (hooks.ts:3–4).
- The **character** is `app/src/character/` — a **Canvas-2D port** of the supplied asset
  `app/assets/kai/KAI_matrix_orb_v17.html` (`orb.ts` header, orb.ts:1), with skins,
  accessories, poses and a spring integrator. `variant.ts` holds KAI + subagent visual
  presets (variant.ts:115–122) — but note this is **not** connected to the Core's subagent
  registry (§5).

**What does NOT exist.**

- No live worker-turn visualization (because `turn.*`/`item.*` never reach the wire, §19).
- The character port is now **complete except one effect**: the header states turbulence/air
  filters are the ONLY source effect still omitted — the meridian cage, glitch bars,
  pose-z shard gallery, laptop/backpack/hands props, the 3-D eye rig and the shard/shell
  break-apart are all rendered (orb.ts:20–24).

---

## 21. Security boundaries

- **Loopback only.** `core/src/server.ts` binds 127.0.0.1 ONLY (server.ts:7). Every response
  is JSON except `GET /events` (SSE) and `GET /core/events` (SSE).
- **Host token.** `POST /chat` is loopback-only but otherwise unauthenticated; the shared
  secret `KAI_HOST_TOKEN` (`x-kai-host-token`, server.ts:162–177) is what lets a request
  claim **user authority** for learning. Missing token ⇒ **fail closed**, nothing learned
  (server.ts:483–496).
- **One tool boundary.** Nothing reaches the machine except through
  request → validate → policy → (approval) → execute (`tools/registry.ts:10, :135`).
  A tool never decides whether it may run.
- **Approval binding.** An approval authorises exactly ONE tool: a mismatched `toolId` is
  refused (tools/registry.ts:685–699), and REJECTED/EXPIRED/PENDING approvals are refused
  (:701–732).
- **Redaction is at the bus, before persistence AND delivery** — one redaction, one value
  (bus.ts:16–20, :219–222), so a secret cannot be persisted and then replayed.
- **Fail-closed defaults** everywhere: no policy gate ⇒ POLICY_DENIED
  (tools/registry.ts:578–590); no approval service ⇒ APPROVAL_REQUIRED (:610–619); no
  skill approver ⇒ refused (staging.ts:107–110); policy elevation needs owner-only
  two-phase confirmation (mode.ts:139–213).
- **MCP — stated precisely, because an earlier edition mis-described this.** At HEAD
  `98a80ae` the MCP *module* is committed and real: `createMcpManager` (manager.ts) owns
  the catalogue + real stdio connections; `registerMcpRoutes`/`createMcpApi` mount the
  15-route `/mcp` surface; `installMcpCapability`/`dispatchMcpCapability` are the
  capability seam; 28 tests run against the real registry/policy/approvals (commit
  `98a80ae`). Every discovered tool is adapted into a plain KAI `ToolDefinition` with a
  **KAI-declared** risk and invoked through the ONE registry — a tool with no derivable
  risk is refused (POLICY_DENIED), never defaulted to READ (`mcp/WIRING.md`). **But the
  committed tree still has zero runtime call sites**: the two one-line handovers are
  in-flight/uncommitted in the working tree (`createMcpManager` + `installMcpCapability`,
  runtime.ts:1619–1622; `registerMcpRoutes`, routes.ts:2635), and live `GET /mcp` still
  404s at HEAD. Not implemented at all: http/sse transport, `resources/read`,
  prompts/sampling/roots. Third-party server connectivity: **BLOCKED_EXTERNAL** (no
  third-party server is installed; the honest substitute is KAI's own fixture server,
  labelled as such).

**What does NOT exist.** No multi-user auth, no remote API authentication, no TLS on the
Core HTTP surface (it is loopback plain HTTP by design), no sandbox for `shell.run` beyond
policy/approval.

---

## 22. OpenCode model inventory (owner-requested, inspected — not guessed)

**Live server:** **NOT running** at either probe time (`127.0.0.1:4096` did not answer
`/config`, `/doc` or `/provider`; no process listening). **Therefore no live model list
could be queried.** Everything below is read from on-disk configuration, re-verified
2026-10-04.

**A. Hermes agent config — `~/.hermes/config.yaml` (the model KAI's own turn currently runs on):**

- Active provider block (lines 1–5): `provider: opencode-go`,
  `base_url: https://opencode.ai/zen/go/v1`, **`default: deepseek-v4.1-flash`**.
- `providers.opencode-go` (lines 16–20): `api: https://opencode.ai/zen/go/v1`,
  `extra_headers.User-Agent: opencode-ai/1.0`.
- `custom_providers` (lines 124–142): **blaze** (`https://api.blazeapi.org/paid/v1`,
  model `deepseek-v4-flash`), **gonka** (`https://api.gonkarouter.io/v1`,
  models `deepseek-ai/DeepSeek-V4-Flash-0731`, `MiniMaxAI/MiniMax-M2.7`,
  `zai-org/GLM-5.3-Flash`). (Re-read at this revision; the keys themselves are not
  reproduced here.)

**B. OpenCode global config — `~/.config/opencode/opencode.json` (~385 KB):**

- Top-level default model: **`nvidia/zhipu/glm-5`**.
- Per-agent overrides: `agent.build.model = crof/mimo-v2.5-pro-precision`,
  `agent.plan.model = crof/kimi-k2.6`.
- **35 providers, 1063 model entries total (re-verified at this revision).** Providers:
  `agentrouter(0) · aihubmix(22) · airforce(116) · anthropic(9) · aqua(59) · atessa(36) ·
  blaze(32) · crof(25) · dialagram(4) · ecomagent(3) · evolvex(157) · ezif(1) ·
  freemodel(4) · freetheai(47) · github-copilot(19) · google(5) · llmzone(4) · logfare(11) ·
  modal(3) · nvidia(114) · omniroute(87) · opencode(2) · opencode-go(14) · openference(3) ·
  paxsenix(81) · proxy(2) · seraphyn(13) · supxh(5) · swiftrouter(62) · vip(39) · voidai(7) ·
  xiaomimimo(10) · z(8) · zenllm(1) · zyloo(58)`.
- **`opencode-go` (14 models, the same endpoint Hermes uses):**
  `deepseek-v4-flash · deepseek-v4-pro · glm-5 · glm-5.1 · kimi-k2.5 · kimi-k2.6 ·
  mimo-v2-omni · mimo-v2-pro · mimo-v2.5 · mimo-v2.5-pro · minimax-m2.5 · minimax-m2.7 ·
  qwen3.5-plus · qwen3.6-plus`.
- **`opencode` / "OpenCode Zen" (2 models):** `minimax-m2.5 · minimax-m2.5-free`.

**C. What KAI's own OpenCode adapter uses.** `core/src/agents/opencode.ts` defaults
`baseUrl` to **`http://127.0.0.1:4096`** (opencode.ts:112). It does **not** pin a model:
`POST /session` and the prompt body accept an optional `model`, but the adapter sends none
(opencode.ts:221), so **the model is chosen by the OpenCode server's own config**
(top-level `nvidia/zhipu/glm-5`, unless overridden). KAI's config surface exposes only the
OpenCode base URL, an optional password, and a timeout (`core/src/config.ts:105–109`) —
there is **no model field** in KAI's OpenCode config.

**Honest caveats.** Provider *names with 0 models* (`agentrouter`) mean the provider is
declared but enumerates nothing. Many of these are aggregator endpoints with possibly
invalid/expired keys; **the count is what the config declares, not what would authenticate
right now**, and with the server down this could not be tested. The OpenCode server was
down at both probe times — this section is config-derived only, never live-verified.

---

## 23. Known limitations (brutally honest)

1. **The worker-runtime event vocabulary is dead on the wire.** `attachProvider`,
   `ingestRuntime`, `subscribeRuntime`, `recentRuntime`, `toControlPlaneEvent`,
   `serializeRuntimeEvent` and the whole `TurnAdapter` protocol have **zero production call
   sites** (§19). Worker turns do not stream to the UI.
2. **~~`task.delegate` does not delegate~~ — FIXED.** `server.ts:532–560` consumes
   `delegateTo` and performs the delegation through the one relay path, honouring `avoid`
   (§4). The router also selects among connected workers for unknown turns (router.ts:1081–1090).
   The old finding was the previous edition's single largest gap; it is closed.
3. **Two action-record fields are permanently null.** `recoveryDecision` and
   `employeeInstanceId` are declared and copied by `buildActionRecord` but never produced by
   the emitter (§16). **`executionId` — the third gap — is now emitted by spread in the
   working tree** (tools/registry.ts:369, 393–403); not yet in the committed tree.
4. **Worker routing is narrow.** Delegation targets are `hermes|opencode` only
   (router.ts:132, :177); Codex never runs (registered UNAVAILABLE, runtime.ts:1098–1101).
5. **Subagent visual variants are not resolved.** The Core wires no `KaiVariantResolver`
   (§5); persona `variant` is a dangling reference.
6. **No mission planner.** Missions are authored explicitly; the router cannot start one (§9).
7. **No recovery *replay* executor is wired.** `replayIfSafe()` is a library function with no
   call site; recovery reports and classifies, it does not auto-replay (§10).
8. **No semantic memory.** Retrieval is FTS5 (if available) or a token scan (§11).
9. **`approval.expired` is never published as an event** — the frozen event union has no
   such type (§8).
10. **Self-improvement is observation-only.** No downloads, no binary replacement, no code
    rewriting (§18).
11. **MCP is committed as a library but not wired into the committed runtime** — the two
    one-line handovers are in-flight/uncommitted; live `GET /mcp` 404s at HEAD; http/sse,
    `resources/read`, prompts/sampling are not implemented; third-party connectivity is
    BLOCKED_EXTERNAL (§21).
12. **The OpenCode server was down during this audit**, so the model inventory is
    config-derived, not live-verified (§22).
13. **Character is a complete port except turbulence/air filters** (orb.ts:20–24) (§20).
14. **Chat routing is regex, not a model** (router.ts:15–19). It is intentionally narrow;
    an unrecognised utterance falls to `unknown`, whose `delegateTo` IS now consumed (item 2).

---

## 24. Where to look — file map

| Concern | File(s) |
|---|---|
| Composition root | `core/src/runtime.ts` (`createCoreRuntime`, :941) |
| HTTP + SSE | `core/src/server.ts` (`/core/events`, :739; relays :469, :532, :576, :601; `streamEvents` :854) |
| Pure API surface | `core/src/api/routes.ts` (`attachEventStream`, :92; routes :2535–2627; `registerMcpRoutes` :2635) |
| Event bus | `core/src/events/bus.ts` (`attachProvider`, :356) |
| Runtime event vocab | `core/src/shared/runtime-events.ts` (unused on wire) |
| Identity (soul) | `core/src/agent/soul.ts`; `core/src/agent/kai-home.ts`; `core/src/agent/kai-capabilities.ts` |
| Core identity (build) | `core/src/identity.ts` |
| Chat router | `core/src/chat/router.ts` |
| Relay boundary | `core/src/chat/relay.ts` |
| Sessions | `core/src/sessions/{store,service,index}.ts` |
| Memory | `core/src/memory/*`, `core/src/storage/memoryStore.ts` |
| Skills | `core/src/skills/*` |
| Learning | `core/src/learning/*` |
| Missions | `core/src/missions/{executor,mission}.ts` |
| Recovery | `core/src/recovery/{ledger,boundary}.ts` |
| Policy | `core/src/policies/{gate,mode}.ts` |
| Approvals | `core/src/approvals/service.ts` |
| Tools (the boundary) | `core/src/tools/registry.ts` |
| Observability | `core/src/observability/{action-record,correlation}.ts` |
| Workforce | `core/src/workforce/*`; subagents `core/src/workforce/subagent.ts` |
| Capabilities | `core/src/capabilities/*` |
| Scheduler | `core/src/scheduler/*` |
| Checkpoints | `core/src/checkpoints/checkpoint.ts` |
| Maintenance | `core/src/maintenance/index.ts` |
| Autonomy loop | `core/src/autonomy/supervisor.ts` |
| MCP | `core/src/mcp/*` (`manager.ts`, `routes.ts`, `capability.ts`; `WIRING.md`) |
| Prompt composer | `core/src/prompts/compose.ts` |
| UI runtime states | `app/src/core/runtime-state.ts` |
| Island FSM / hooks | `app/src/island/{fsm,hooks,island}.ts` |
| Character (orb) | `app/src/character/{orb,variant,engine}.ts`; asset `app/assets/kai/KAI_matrix_orb_v17.html` |
| Rust shell (sessions) | `app/src-tauri/src/claude.rs` |
