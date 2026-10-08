# KAI — MCP architecture

**What this document is.** The architecture of KAI-owned MCP: what MCP is inside KAI, how a server
is registered, connected and discovered, how its tools enter KAI's one tool registry, how policy and
approvals gate every call, what provenance is recorded, and — with the same weight — **what is not
wired yet**. It is the Stream D deliverable named in `docs/KAI_ULTRA_MISSION_PLAN.md`.

**Verification vocabulary** (from the mission plan, used verbatim): `UNIT PROVEN` · `INTEGRATION
PROVEN` · `END-TO-END PROVEN` · `MOCK ONLY` · `NOT PROVEN` · `BLOCKED_EXTERNAL`. `FILES EXIST` is
never rounded up to `KAI FUNCTIONALLY OWNS THE MECHANISM`. The machine-checked record for every
claim below is `docs/evidence/kai-mcp-final.json`.

**Date.** 2026-10-04. **Method.** Every claim here is backed by a test that ran on this machine
(`core/tests/mcp-manager.test.ts`, `mcp-routes.test.ts`, `mcp-capability.test.ts`,
`mcp-runtime-e2e.test.ts`), driving the REAL tool registry, policy engine, approval service and
capability registry, against KAI's own fixture server — a real child process speaking real
newline-delimited JSON-RPC 2.0 over stdio. **No third-party MCP server is installed on this
machine**, so third-party connectivity is `BLOCKED_EXTERNAL` and nothing here claims otherwise.

---

## 1. What MCP is in KAI

MCP (Model Context Protocol) is the standard by which KAI can hold **third-party tool servers** —
`github`, `filesystem`, a company's internal service — without trusting their code. The single
contract everything else follows from:

> Every discovered MCP tool is adapted into a plain KAI `ToolDefinition` with a **KAI-declared
> risk**, registered into KAI's **one** `ToolRegistry`, and from that moment invoked exactly like a
> built-in: `validate → policy → (approval) → execute`. There is no second policy path, no second
> approval path, and no second registry.

Three facts about a server are tracked separately and never conflated:

| Fact | Meaning | Who sets it |
|---|---|---|
| **REGISTERED** | KAI knows the entry (command/args/env or url/headers, risk declaration) | `mcp.register` (a parked WRITE) |
| **ENABLED** | KAI may start it | `mcp.enable` (a parked WRITE); a new server lands disabled |
| **CONNECTED** | The process is running, the handshake succeeded, tools are discovered | `mcp.connect` (a parked **EXTERNAL**) |

A server that is registered but not enabled is inert. An enabled server is not running until it is
connected. Nothing starts third-party code without a human decision at each step.

## 2. The module map (`core/src/mcp/`)

| File | Role |
|---|---|
| `manager.ts` | The runtime seam. Owns the catalogue + connections; registers discovered tools and the 8 management tools into the ONE registry; records provenance; persists the catalogue. |
| `routes.ts` | The HTTP surface: 15 routes under `/mcp`, `createMcpApi` (pure) + `registerMcpRoutes` (host adapter). |
| `capability.ts` | The `mcp` capability seam: measured health, `installMcpCapability`, `dispatchMcpCapability`. |
| `registry.ts` | The server catalogue: validated entries, write-only secrets, disabled-by-default. |
| `real-client.ts` | The real stdio client: spawn, handshake, `tools/list`, `resources/list`, `tools/call`, deadlines, dispose. |
| `bridge.ts` | The byte-transparent line-splitting seam (StringDecoder-based) shared by the client and the agent↔server bridge. |
| `integration.ts` / `tool-adapter.ts` | Adapt discovered tools → KAI `ToolDefinition`s; the fail-closed risk rule lives here. |
| `validation.ts` | Pure validators: names, risk declarations, discovered tools, env/header/url safety. |
| `result.ts` | `McpResult` / `mcpError` — errors are values at this boundary. |
| `types.ts` / `tool-schema.ts` | MCP-specific shapes (they do not cross an IPC boundary yet). |
| `servers/echo-mcp-server.mjs` | KAI's own fixture server: a REAL MCP stdio server in one dependency-free file, used to exercise the client offline and reproducibly. It deliberately misbehaves the ways real servers do (stderr noise, split frames, slow responses). |

## 3. The lifecycle

```
mcp.register ──▶ REGISTERED (disabled, inert)
mcp.enable   ──▶ ENABLED
mcp.connect  ──▶ spawn child ──▶ initialize (handshake) ──▶ tools/list ──▶ wireMcpTools
                    │                                                        │
                    │  (KAI-declared risk per tool; no risk → refused)        ▼
                    └──────────────────────────────────  tools live in KAI's ONE registry as
                                                         mcp.<server>.<tool>
mcp.<server>.<tool> invoke ──▶ registry boundary: validate → policy → (approval) → execute
                                    │                                   │
                                    │ READ: runs                        │ WRITE/EXTERNAL/DESTRUCTIVE:
                                    │                                   └─▶ parks → 409 + approvalId
                                    ▼
                              McpInvocationRecord on the provenance ledger
```

**Connect + discovery** (`manager.connectServer`): refuses a disabled server (`POLICY_DENIED`),
refuses a remote (`http`/`sse`) endpoint (`AGENT_NOT_LISTENING`, "this build implements the stdio
transport only"), resolves credentials, spawns the child with `{...process.env, ...env}`, performs
the MCP `initialize` handshake (requesting protocol `2025-06-18`; the server's answered version is
recorded), sends `notifications/initialized`, calls `tools/list`, and registers every discovered
tool whose KAI-declared risk can be established. Connecting again is idempotent and reports the same
live state.

**Fail-closed risk.** `tools/list` yields a name, description and JSON schema — and nothing
trustworthy about risk. MCP `annotations` (`readOnlyHint`, …) are self-reported by the server's own
code, so KAI never reads them as the risk. Risk comes only from the KAI-owned `McpRiskDeclaration`
on the server entry (`{ default, tools: { name: risk } }`). A tool with no derivable risk is
**refused** (`POLICY_DENIED`), reported in the connect report's `refused[]` — never defaulted to
`READ`.

**Resources.** `resources/list` is read from the live connection (`GET
/mcp/servers/:name/resources`, `manager.listResources`); the count lands in the server view and the
summary. Reading a resource's contents (`resources/read`) is implemented (`GET
/mcp/servers/:name/resources/read?uri=…`, through the boundary) and proven live
(see `docs/evidence/mcp-external-live.json`).

**Credentials (stdio auth).** `env` values are the stdio transport's form of authentication. They
are stored write-only: `list()` exposes key NAMES (`envKeys`), and only `credentialsFor(name)` — the
named privileged read, used by the launcher — resolves values. The `KAI_` env namespace is reserved
and refused (a server entry cannot set a variable that would redirect KAI's own runtime), and
`ELECTRON_RUN_AS_NODE` is refused. With a `persistPath`, the catalogue (including secret values,
because the launcher needs them after a restart) is written as JSON `{version: 1, servers: {…}}`
with mode `0600` where the OS honours it; on Windows the mode is best-effort (NTFS ACLs govern) —
the file belongs under the Core's data directory and nowhere else.

**Remote transports.** `http`/`sse` endpoints can be REGISTERED and are stored faithfully, but
`connect` refuses them honestly (`AGENT_NOT_LISTENING`, message says stdio-only). This is a real
limitation, not a fake — see §9.

## 4. The tool surface

An MCP tool's KAI id is `mcp.<server>.<tool>` — namespaced so no provider can shadow a built-in
(`system.get_status`, `agents.list`), and so a server literally named `register` cannot collide with
the management tool `mcp.register` (different segment counts, by construction).

Invocation goes through the ONE boundary: `manager.invokeTool` resolves the id, checks the server is
connected, then calls `registry.invoke(toolId, args, { approvalId?, … })`. The registry validates,
consults the policy gate, parks when the decision is `needs_approval`, and executes only with a
granted approval bound to that exact tool id. Default policy: `READ` runs; `WRITE`, `EXTERNAL` and
`DESTRUCTIVE` all park for a human. A refused call is a typed value — never a throw, never a false
success. A tool the server fails to execute (JSON-RPC error) surfaces as `INTERNAL` from the
registry and `FAILED` on the ledger.

**The 8 management tools** are themselves registered into the same registry, so a management action
cannot bypass the boundary because there is no other way to run one:

| Tool | Risk | Effect |
|---|---|---|
| `mcp.register` | WRITE | add an entry (lands disabled) |
| `mcp.update` | WRITE | edit an entry (enabled state + untouched secrets preserved) |
| `mcp.enable` / `mcp.disable` | WRITE | allow/forbid starting; disable disconnects |
| `mcp.remove` | WRITE | remove from catalogue; disconnects; tools stop resolving |
| `mcp.connect` | **EXTERNAL** | spawn + handshake + discovery (runs third-party code under KAI's authority) |
| `mcp.disconnect` | WRITE | stop the process |
| `mcp.refresh` | WRITE | re-run `tools/list`; only ADDS tools |

## 5. The HTTP surface (`/mcp`)

15 routes; mutations go through `tools.invoke` (management as `mcp.*` tools; calls as the discovered
tool's own id). Parked actions answer `409 { approvalRequired: true, approvalId }`; the caller
retries the same request with `approvalId` once a human decides.

| Method | Path | Class | Method | Path | Class |
|---|---|---|---|---|---|
| GET | `/mcp` | READ | POST | `/mcp/servers/:name/enable` | WRITE |
| GET | `/mcp/servers` | READ | POST | `/mcp/servers/:name/disable` | WRITE |
| POST | `/mcp/servers` | WRITE | POST | `/mcp/servers/:name/remove` | WRITE |
| GET | `/mcp/servers/:name` | READ | POST | `/mcp/servers/:name/connect` | **EXTERNAL** |
| POST | `/mcp/servers/:name` | WRITE | POST | `/mcp/servers/:name/disconnect` | WRITE |
| GET | `/mcp/servers/:name/tools` | READ | POST | `/mcp/servers/:name/refresh` | WRITE |
| GET | `/mcp/servers/:name/resources` | READ | POST | `/mcp/servers/:name/call` | **EXTERNAL** |
| GET | `/mcp/provenance` | READ | | | |

`GET /mcp` serves the measured capability, live counts, the catalogue (secrets never) and the
provenance count — this is the route that kills the 404. A path this module does not own returns 404
so the integrator's mount **falls through** to the routes that already existed. Typed failures map
to HTTP shapes: `APPROVAL_REQUIRED → 409` · `POLICY_DENIED → 403` · `NOT_FOUND → 404` ·
`VALIDATION_FAILED → 400` · `AGENT_* → 502` · else `500`.

`registerMcpRoutes(app, deps)` tolerates the host shapes an integrator plausibly holds: a bare
`(method, pattern, handler, classification)` function, an object with `register`/`route`/`addRoute`/
`add`, or an express-like `{get, post}`. A host that can carry nothing throws at startup — a route
table that silently accepts nothing would leave `/mcp` at 404 while looking wired.

## 6. Provenance — the invocation ledger

Every invocation **attempt** — executed, parked, refused, failed — is recorded exactly once as an
`McpInvocationRecord`: `executionId` (`mcp_<time>_<seq>`), `toolId`, `server`, `tool`, `source`
(`ui` / `capability.mcp` / `workforce` / …), `arguments`, `status`, `startedAt`, `durationMs`,
`result` or typed `error`, and `sessionId`/`agentId`/`approvalId`/`missionId`/`stepId`/`turnId` when
known. Statuses: `EXECUTED` · `DENIED` · `APPROVAL_REQUIRED` · `INVALID` · `NOT_FOUND` · `FAILED`.

The ledger is a bounded ring (default 200, newest first) plus an optional `record` sink that is
called for every attempt and **cannot veto or crash one** (a throwing sink is caught). It is
ADDITIVE to the action record the tool registry already emits for the same call: the registry record
says "an action ran under this authority"; this one says "which MCP server and tool, with which
arguments, for which caller". `GET /mcp/provenance?limit=N` serves it.

## 7. The capability seam (`capability.mcp`)

**Health is measured, not declared.** `mcpCapabilityHealth(manager)` reads live manager state:

| State | Availability | Detail says |
|---|---|---|
| no server registered | UNAVAILABLE | register one to give KAI MCP tools |
| registered, none enabled | UNAVAILABLE | none enabled |
| enabled, none connected | DEGRADED | enabled but not connected |
| ≥1 connected | AVAILABLE | N connected; T tools registered (R resources listed) |

**`installMcpCapability(registry, manager)`** replaces the runtime's probe-less `mcp` registration
with the measured one, by explicit unregister + register (the registry refuses silent overwrites by
design). Identity (id/name/provider/risk/actions/requirements) is preserved; availability starts
under-claimed (`UNAVAILABLE`) and the first `checkHealth("mcp")` records the measured truth. If the
replacement registration fails, the previous definition is restored rather than left absent.

**`dispatchMcpCapability(manager, chosen, payload)`** is the body of the `capability.mcp` execute
branch, replacing runtime.ts's unconditional throw. It runs INSIDE the already-gated
`capability.mcp` execute (EXTERNAL: validated, policy-checked, approval-gated), accepts
`{server, tool, arguments?}` (or nested under `input`), and calls `manager.callToolDirect` — the ONE
deliberate non-registry path, restricted to this caller. A `DESTRUCTIVE` tool is refused there: an
EXTERNAL gate must never be spent on a DESTRUCTIVE action; the caller is told to invoke that tool by
its own id so its own risk gates it.

## 8. Wiring (the integration handovers)

All of this is additive under `core/src/mcp/`; `tools/registry.ts`, `policies/gate.ts` and
`shared/contracts.ts` are untouched. Two one-line integrations remain, and they belong to the
integration stream (`core/src/api/routes.ts`, `core/src/runtime.ts`):

1. **`core/src/api/routes.ts`** — mount the route surface:
   ```ts
   registerMcpRoutes({ register: (m, p, h, c) => routeDefs.push(route(m, p, c ?? "EXTERNAL", h)) },
                     { manager: runtime.mcp, tools: runtime.tools });
   ```
2. **`core/src/runtime.ts`** — create/expose the manager and install the seams:
   ```ts
   const mcp = createMcpManager({ tools, publish });   // expose as runtime.mcp
   installMcpCapability(capabilityRegistry, mcp);
   // in the capability.mcp execute branch, replace the unconditional throw with:
   return dispatchMcpCapability(mcp, chosen, payload);
   ```

Both handovers landed: `GET /mcp` serves the live capability on a running Core
(`docs/evidence/mcp-external-live.json`), and the MCP page in the main window
lists servers, credentials presence, provenance and actions.

## 9. What is NOT wired / not proven — plainly

- **Third-party MCP servers: exercised as external processes, fixture-labelled.** The
  live proof (`docs/evidence/mcp-external-live.json`) registers, enables, connects,
  calls and reads resources from a REAL external process over stdio JSON-RPC —
  KAI's own echo fixture, labelled as such, not dressed up as third-party. A
  third-party npm/npx server follows the identical path (register → enable →
  connect with KAI-declared risk).
- **Remote (`http`/`sse`) transport: NOT implemented.** Registration/storage/validation work;
  `connect` refuses with a message saying exactly that. No claim of remote connectivity.
- **Prompts, sampling, roots, elicitation: NOT implemented.** Server→client requests are refused
  explicitly so a server is never left waiting.
- **Persistence mode `0600`** is honoured on POSIX; on Windows it is best-effort.
- **`tools/registry.ts`** was mid-refactor by another stream while these tests ran; the boundary
  behavior asserted here is the registry's existing contract (`validate → policy → (approval) →
  execute`), and the MCP stream caused no regression in it.

## 10. How to run the proof

```bash
cd core
node --test tests/mcp-manager.test.ts        # the manager: catalogue, connect, discovery, policy,
                                             # approvals, provenance, persistence, refusals
node --test tests/mcp-routes.test.ts         # the 15 routes, host adapter, park→approve→retry
node --test tests/mcp-capability.test.ts     # measured health, install, dispatch, DESTRUCTIVE refusal
node --test tests/mcp-runtime-e2e.test.ts    # the full stack through the exact handover wiring
npm test                                     # everything
```

Every test spawns the real fixture child process; none mock the MCP side. The single labelled fault
injection is in `mcp-capability.test.ts` (a wrapper that fails one capability-registry call), used
to prove the restore-on-failure path — it is named as such in the test.
