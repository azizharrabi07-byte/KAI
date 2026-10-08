# Repo scan — defects found, prioritised

**Scope:** a scan of `C:/Users/DELL/Desktop/kai` (Node Core in `core/`) for real defects,
distinguished from deliberate design. Each entry gives **file:line**, **severity**,
**reachable-from-product** (can a user hit it through the shipped product, not just in a test),
and whether it is a genuine defect or intended behaviour.

**Headline:** the dominant failure class is **not a wrong line of code — it is the right code
being run from the wrong artifact.** Three separate instances surfaced in a single session: a
function imported-but-never-called, a field set-but-never-consumed, and a guard that was correct
in `src/` but a no-op in the `dist/` the process actually loaded. One fix (the identity guard)
was invisible until the artifact was compared to its source.

---

## D1 — Stale `dist` artifact: correct source, wrong process  ·  SEVERITY: HIGH  ·  reachable: YES

**Class, not a line.** `npm start` runs `node dist/server.js`, so the running process is
whatever `core/dist/` was last built to be. When `dist/` predates a source fix, the fix is
present in the tree and absent from the product, and nothing fails loudly.

**Three instances observed this session:**

1. **Identity guard (relay).** `presentWorkerResult` (`core/src/chat/relay.ts`) strips the
   worker's self-introduction. `/chat` → `relayWorkerTurn` (`core/src/server.ts:235-297`,
   called at `:542`, `:579`, `:624`) was wired correctly, yet the live Core relayed the worker's
   self-ID verbatim. Running the same strings through each artifact:
   `src/chat/relay.ts` → `guarded=true`; `core/bundle/chat/relay.js` → `guarded=true`;
   **`core/dist/chat/relay.js` → `guarded=false`, verbatim** — exactly the live behaviour.
   Fixed by rebuilding `dist`+`bundle` (buildId `8944b66d85f4e6b7`).
2. **`presentWorkerFailure` "imported and never called"** (earlier). The failure-composer existed
   in KAI's voice module but no path invoked it, so upstream failures could go unanswered.
3. **`delegateTo` "set and consumed nowhere"** (earlier). A routing field was assigned and never
   read, so the value had no effect.

**Mitigation shipped:** the relay guard now has a startup **proof-of-life** (`relayGuardIsLive()`,
`core/src/chat/relay.ts`, called from `server.ts`) — at boot the Core runs the guard over a
known worker self-introduction and refuses to answer a turn if the compiled guard is a no-op.
A build that cannot guard cannot stay silent about it. There is no equivalent boot check for the
other two instances; the general defence remains "rebuild `dist`, don't import `src`".

**Not deliberate.** The comments in `relay.ts` treat this as the recurring failure shape and were
written to make it impossible to serve silently.

---

## D2 — `/identity` `buildId` is re-read from `build-info.json` on every call  ·  SEVERITY: HIGH  ·  reachable: YES

**`core/src/identity.ts:60-79` (`readBuildInfo`), `:93-106` (`loadIdentity`).**
`loadIdentity()` is called per request by `GET /identity` (`core/src/api/routes.ts:2077`) and it
calls `readBuildInfo()` — which reads `build-info.json` from disk — every time.

**Observed live:** a hand-started Core on port 8791 reported a **new** `buildId`
(`aafb8985a1a76cf1`) although that process had **started BEFORE the rebuild** — i.e. it reported
a build it had never loaded.

**Consequence:** the `buildId` returned by `/identity` is a fact about the **disk**, not about
the **running process**, so it cannot be trusted as a freshness gate. Any "is this process the
reviewed build?" check can be answered *yes* by a process that predates the build. Related:
`PROCESS_STARTED_AT` (`:91`) was already changed to be captured once at module load precisely
because the per-request analogue reported the caller's time; `buildId` has the same defect class.

**Missing companion:** a **source-hash-of-loaded-module vs build-stamp** comparison. The
maintenance service (`core/src/maintenance/index.ts:92-120`) compares the *running* `buildId`
against an *on-disk* `build-info.json` — but since the running `buildId` is itself read from
disk per call, that comparison can be vacuous (it compares disk to disk).

**Partly deliberate, still a defect.** Reading the stamp per request is a deliberate choice (the
comments discuss it), but the *effect* — identity that does not describe the process — is a
defect and undermines every "is the running build the reviewed build?" claim.

---

## D3 — Subagent `run_task` capability mismatch refuses a run before policy  ·  SEVERITY: HIGH  ·  reachable: YES

**`core/src/workforce/subagent.ts:334` (HEAD: `descriptorForSubagent`) vs
`core/src/workforce/manager.ts:988` (`delegateImpl`).**

At HEAD, `descriptorForSubagent` builds the employee **instance** carrying only
`spec.capabilities` (the persona's **tool grants** — filesystem, shell, browser…). But
`delegateImpl` requires the instance to declare the capability it is being handed — default
`"run_task"` — and refuses with `AGENT_CAPABILITY_MISSING` (`manager.ts:988-997`) **before** the
run reaches `executeTask`, i.e. before validate → policy → approval.

**Consequence:** the persona could not *be handed a task* at all, so the run could not park for
approval and **the no-bypass proof could not exist** — a persona was refused one stage earlier
than the property it was supposed to demonstrate.

**Confusing two ideas:** "this employee can reach this tool" (a persona's declared grants, fed to
the capability manager via `workforce.describe()`) vs "this employee can receive work" (a
structural ability of the instance). Conflating them is the root cause.

**Status:** an **uncommitted, in-flight fix** exists in the working tree (not part of this
commit) that adds `run_task` to the **instance** capabilities while leaving
`spec.capabilities` unchanged (`const instanceCapabilities = normalizeCapabilities([...capabilities,
"run_task"])`). Recorded here because it was a real HEAD-state defect. **Not deliberate.**

---

## D4 — Persisted subagents not re-registered at boot (HEAD)  ·  SEVERITY: MEDIUM  ·  reachable: YES

**`core/src/runtime.ts` (`start()`), `core/src/workforce/subagent.ts:226-249` (`createSubagentRegistry`).**

At HEAD, `createSubagentRegistry` loads persisted specs from `kai-subagents.json` at
construction, but `start()` never walks `subagentRegistry.list()` to re-register them as
employees. Boot is a different object graph: the persona registry is populated, the **workforce
is empty**, so after a restart `/subagents` falls back to `UNKNOWN` — a first-class entity KAI
owns evaporates on restart.

**Status:** an **uncommitted, in-flight fix** exists (a boot loop that calls
`registerSubagentEmployee(rec.spec, rec.employeeId)` — `core/src/runtime.ts:2534`). Recorded
because it was a real HEAD-state defect. **Not deliberate** — the surrounding comment explicitly
says a persona "must not evaporate on restart".

---

## D5 — `recoveryDecision` / `employeeInstanceId` declared but never populated; no `executionId`  ·  SEVERITY: MEDIUM  ·  reachable: via audit/correlation

**`core/src/observability/action-record.ts:54` (`recoveryDecision?`), `:60`
(`employeeInstanceId?`), `:123`, `:131` (the conditional copies); consumed by
`core/src/observability/correlation.ts:43,72,94,157`.

`buildActionRecord` will copy `employeeInstanceId` and `recoveryDecision` into a record **if
passed**, and `correlation.ts` will thread them into traces **if present** — but **no call site in
`core/src` passes either**. Every `recordAction(...)` /
`buildActionRecord(...)` call
(`core/src/tools/registry.ts:348,423,436,451,466,476,497,511,560,577,591,606,616,626,654`)
omits both. So the fields are dead schema: the audit/correlation layer has slots for
"which instance did this" and "what did recovery decide" that are always empty.

**Also missing:** there is **no `executionId` field on `ActionRecord`**, even though the recovery
boundary runs keyed by `executionIdFor(...)` (`core/src/recovery/boundary.ts:29,78-153`,
`core/src/recovery/ledger.ts`). An action record therefore cannot be joined to the recovery
ledger entry for the same execution.

**Severity MEDIUM** (the observability contract is silently incomplete, not wrong); **partly
deliberate** (the field is optional and guarded), but "declared, consumed, never populated" is a
defect in the same family as D1's set-but-never-consumed.

---

## D6 — MCP is defined but unwired  ·  SEVERITY: MEDIUM  ·  reachable: NO

**`core/src/mcp/registry.ts:245` (`createMcpRegistry`), `core/src/mcp/integration.ts:60`
(`wireMcpTools`).**

Both are exported and implemented, and `core/src/mcp/WIRING.md` exists — but a search of
`core/src` finds **zero call sites** for either outside their own module. Nothing constructs an
MCP registry and nothing wires MCP tools into the `ToolRegistry`. The capability is present as
code and absent as behaviour.

**Feature gap, not a bug** in the sense that nothing is broken — but it must not be reported as
"working" in any capability claim. Not reachable from the product because it is not connected.

---

## D7 — Plugins absent  ·  SEVERITY: LOW  ·  reachable: NO

A case-insensitive search for `plugin` across `core/src` returns **nothing**. There is no plugin
loader, no plugin registry, no plugin surface. Recorded so no capability matrix claims a plugin
system that does not exist.

---

## D8 — Relayed worker results can reference 'Hermes' / 'KAI desktop chat'  ·  SEVERITY: LOW  ·  reachable: YES

When a delegated task's **subject matter** is Hermes (e.g. "I was reading about Hermes…",
a quoted sentence about the messenger god), the worker's result returned to the user can contain
the token *"Hermes"* or *"KAI desktop chat"* as ordinary prose. This is **reference, not
self-identification** — the worker is not claiming to *be* Hermes, and the guard does not fire
because no self-ID pattern is present. **Partly deliberate** (you cannot strip the user's own
subject) but recorded as the remaining way the word can appear in KAI's chat.

---

## Not defects (deliberate design / fixtures — checked, then cleared)

- **`createMockHermes()` / `createMockOpenCode()`** registered at `core/src/workforce/…`
  registry (`core/src/runtime.ts:910-911`, and the mock registration at `:913`) are **test /
  sandbox fixtures**, not a production identity leak. A `mock` in a fixture is not a defect.
- **The per-request `loadIdentity()` read** is deliberate (comments discuss it) — its
  *consequence* is D2, but the read itself is intended.
- **The recovery/observability optional fields** are part of a guarded schema — declaring them is
  intentional; the defect (D5) is that nothing populates them.
- **The subagent's "no transport of its own" design** (`subagent.ts:326-331`) is deliberate and
  correct: an instance must reach a worker only through the policy-governed `executeTask`, never
  via a direct adapter call. D3 is about the *capability gate* passing before that path, not
  about the single-path design.

---

## Recommended order of attack

1. **D2** — make `buildId` a fact about the process (read once at module load, like
   `PROCESS_STARTED_AT`), and add a source-hash-vs-stamp comparison; until then no freshness
   claim about a build is sound. *(High, product-reachable, cheap.)*
2. **D3 / D4** — land the in-flight workforce fixes and add a regression test that a persona can
   be handed a task AND still be refused by policy before the effect.
3. **D1 general defence** — extend the boot proof-of-life idea beyond the relay guard (or make
   `dist` staleness a startup warning via the maintenance service, which already knows how to
   detect it).
4. **D5** — populate `employeeInstanceId`/`recoveryDecision` and add `executionId` so the audit
   record joins to the recovery ledger.
5. **D6 / D7** — either wire MCP/plugins or stop implying they work.
6. **D8** — accept as reference; optionally note in the guard's contract that a *reference* is
   not an identity match.
