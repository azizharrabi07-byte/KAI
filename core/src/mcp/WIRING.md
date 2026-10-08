# Wiring KAI-owned MCP into the tool registry

> **Status: FULFILLED.** This was written as "the note the Core lead needs" when `core/src/mcp/**`
> was a library with no runtime call site. The call site now exists: `core/src/mcp/manager.ts`
> (`createMcpManager`) is the ONE runtime seam — it owns the catalogue and connections, registers
> discovered tools and the 8 management tools into KAI's one `ToolRegistry`, records provenance, and
> persists the catalogue. `core/src/mcp/routes.ts` (`registerMcpRoutes`) mounts the 16-route `/mcp`
> surface (15 handover routes + `GET /mcp/servers/:name/resources/read`),
> and `core/src/mcp/capability.ts` (`installMcpCapability` / `dispatchMcpCapability`) is
> the capability seam. The architecture is documented in `docs/KAI_MCP_ARCHITECTURE.md`; the
> machine-checked claim record is `docs/evidence/kai-mcp-final.json`. The two remaining one-line
> integrations in `core/src/api/routes.ts` and `core/src/runtime.ts` are listed under **"The
> integration handovers"** below — they belong to the integration stream, not to `src/mcp/**`.

Nothing here modifies `tools/registry.ts`, `policies/gate.ts`, or `shared/contracts.ts` — all of it
is additive under `core/src/mcp/`.

## The one-sentence contract

Every discovered MCP tool is turned into a plain KAI `ToolDefinition` by
`adaptMcpTool` (with a **KAI-declared** risk) and registered through the existing
`ToolRegistry.register`. From that moment it is invoked with
`registry.invoke(...)` exactly like a built-in, so it passes through
`validate → policy → (approval) → execute` unchanged.

## Sequence at connect time (as the manager implements it)

```ts
import { createMcpManager } from "./mcp/manager.ts";

// 1. Servers are stored disabled. The user enables one explicitly (both steps
//    are themselves tools — mcp.register / mcp.enable — so they park by default).
const mcp = createMcpManager({ tools });           // registers the 8 management tools
mcp.registerServer("github", { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"],
                         env: { GITHUB_TOKEN: "<secret>" },
                         risk: { default: "EXTERNAL", tools: { search_repositories: "READ" } } });
mcp.enableServer("github");

// 2. For each ENABLED server only: connect spawns it, does the MCP handshake,
//    then asks tools/list. Route every frame through the bridge (never bypass
//    it): the agent's stdout is `forward`'s sink; the server's stdout is split
//    into lines and fed to the interceptor / normalizer (see runMcpBridge).

// 3. Adapt + register the catalogue. `risk` comes from the SERVER RECORD,
//    never from the provider's tool annotations. wireMcpTools does this
//    underneath; manager.connectServer is the runtime call site.
const connected = await mcp.connectServer("github");
// connected.value.registered – ids now live in the registry (e.g. mcp.github.search_repositories)
// connected.value.refused    – { name, error } for every tool refused, as values
```

`manager.ts` is also the place every invocation is recorded (the `McpInvocationRecord` ledger) and
every management operation is routed back through the registry.

## Why the risk must be declared (fail closed)

`tools/list` gives a name, a description and a JSON schema. It gives **no**
trustworthy risk: MCP `annotations` are self-reported hints by the server's own
code. So KAI requires an `McpRiskDeclaration` on the server record.

`adaptMcpTool` refuses a tool with no derivable risk (`POLICY_DENIED`) rather
than defaulting it to `READ`. Consequence for callers: a server registered
without a `risk` block registers **zero** tools, and `report.refused` explains
why for each. That is intended.

## The transport invariant

`tools/call` frames are refused to the model by the policy boundary **before**
execution; the bridge's `mayCall` hook is the transport-level belt-and-braces
(optional). Both exist because a refusal written directly to the server's stdin
could otherwise land inside a half-written frame — hence every byte crosses
`createLineSplitter` and frames are handled on a serialized queue.

## The integration handovers (exact; they live in files owned by the integration stream)

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

Both handovers landed (runtime constructs the manager + registers the routes):
a live `GET /mcp` serves the measured capability, proven end to end in
`docs/evidence/mcp-external-live.json`.

## What is frozen

`shared/contracts.ts` is untouched: `RiskLevel`, `KaiError` and the rest are
re-used as-is. MCP-specific shapes (server entries, listings, discovered tools)
live in `core/src/mcp/types.ts` on purpose — they do not cross an IPC boundary
yet.
