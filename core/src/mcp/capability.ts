// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The `mcp` capability seam: the probe, the re-registration, and the dispatch.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `runtime.ts` registers the `mcp` capability with `availability: "UNAVAILABLE"`
 * and NO probe, so `checkHealth("mcp")` can only ever echo the declared value —
 * the capability reads UNAVAILABLE forever, however healthy MCP actually is.
 * The registry refuses to overwrite a registered capability (by design), so the
 * honest fix is an explicit, named re-registration: same id, same risk, same
 * action, but with a health probe that MEASURES the live manager. That is
 * `installMcpCapability`.
 *
 * The three seams here are handed to the integration stream as one-line calls
 * (see `docs/KAI_MCP_ARCHITECTURE.md` §Wiring):
 *
 *   1. `installMcpCapability(capabilityRegistry, mcp)` — replace the probe-less
 *      registration with the measured one.
 *   2. `dispatchMcpCapability(mcp, chosen, payload)` — the body of the
 *      `capability.mcp` tool branch in `runtime.ts`, replacing the current
 *      unconditional throw. It runs INSIDE the already-gated `capability.mcp`
 *      execute (validated, policy-checked, approval-gated as EXTERNAL), exactly
 *      like the workspace capability ops — which is why it calls the server
 *      directly instead of re-entering the registry and double-parking.
 *
 * AVAILABILITY IS MEASURED, NOT DECLARED
 * --------------------------------------
 *   - no server registered          → UNAVAILABLE ("register one to …")
 *   - registered, none enabled      → UNAVAILABLE ("none enabled")
 *   - enabled, none connected       → DEGRADED    ("enabled but not connected")
 *   - at least one connected        → AVAILABLE   ("N connected; T tools")
 * The detail always says which state it measured, so the answer to "why?" is in
 * the same value as the answer to "can KAI do it?".
 */

import type { Capability, CapabilityAvailability, CapabilityId } from "../shared/contracts.ts";
import {
  type CapabilityRegistration,
  type CapabilityRegistry,
  type CapabilityResult,
} from "../capabilities/registry.ts";
import type { McpManager, McpSummary } from "./manager.ts";

/** The manager slice the probe needs; kept structural so this file stays a leaf. */
export type McpSummarySource = { summary(): McpSummary };

export interface McpCapabilityHealth {
  availability: CapabilityAvailability;
  detail: string;
}

/**
 * Measure the MCP capability from live manager state. Pure: no side effects, no
 * probing of servers (connecting is an approved action, not a health check).
 */
export function mcpCapabilityHealth(manager: McpSummarySource): McpCapabilityHealth {
  const summary = manager.summary();
  if (summary.servers === 0) {
    return {
      availability: "UNAVAILABLE",
      detail: "no MCP server is registered; register one (POST /mcp/servers) to give KAI MCP tools",
    };
  }
  if (summary.connected > 0) {
    return {
      availability: "AVAILABLE",
      detail: `${summary.connected} MCP server(s) connected; ${summary.tools} tool(s) registered in KAI's tool registry (${summary.resources} resource(s) listed)`,
    };
  }
  if (summary.enabled > 0) {
    return {
      availability: "DEGRADED",
      detail: `${summary.enabled} MCP server(s) enabled but not connected yet; connecting one (POST /mcp/servers/<name>/connect) makes its tools usable`,
    };
  }
  return {
    availability: "UNAVAILABLE",
    detail: `${summary.servers} MCP server(s) registered, none enabled; enable one (POST /mcp/servers/<name>/enable) before connecting it`,
  };
}

/**
 * Replace the runtime's probe-less `mcp` capability with the measured one.
 *
 * The registry refuses a same-id register (never a silent overwrite), so this
 * performs the one explicit, named replacement: unregister + register. The
 * capability keeps its identity (id, name, provider, risk, actions,
 * requirements) and gains a probe. If the replacement registration somehow
 * fails, the previous definition is restored rather than left absent.
 *
 * Availability starts UNAVAILABLE (under-claim, never over-claim); the first
 * `checkHealth("mcp")` records what is actually true.
 */
export function installMcpCapability(
  registry: CapabilityRegistry,
  manager: McpSummarySource,
): CapabilityResult<Capability> {
  const existing = registry.get("mcp");
  const registration: CapabilityRegistration = {
    id: "mcp" as CapabilityId,
    name: existing?.name ?? "MCP servers and tools",
    risk: "EXTERNAL",
    provider: existing?.provider ?? "kai",
    availability: "UNAVAILABLE",
    requirements: existing?.requirements ?? ["an MCP server registered, enabled and connected; every tool runs under KAI policy"],
    actions: [{ id: "call", risk: "EXTERNAL" }],
    health: async () => mcpCapabilityHealth(manager),
  };

  if (existing === undefined) return registry.register(registration);

  const removed = registry.unregister("mcp");
  if (!removed.ok) return removed;

  const installed = registry.register(registration);
  if (!installed.ok) {
    // Put the old definition back: a failed replacement must not leave KAI with
    // no `mcp` capability at all.
    registry.register({
      id: existing.id,
      name: existing.name,
      risk: existing.risk,
      provider: existing.provider,
      availability: existing.availability,
      ...(existing.requirements !== undefined ? { requirements: existing.requirements } : {}),
      actions: existing.supportedActions.map((id) => ({ id, risk: existing.risk })),
      health: existing.health,
    });
    return installed;
  }
  return installed;
}

/**
 * The body of the `capability.mcp` execute branch.
 *
 * Called from INSIDE the `capability.mcp` tool, after the registry has already
 * validated, policy-checked and (when required) parked-and-approved the action.
 * It dispatches one discovered MCP tool on a live connection and returns the
 * server's result. A refusal is a throw, because the capability execute
 * contract converts throws into typed failures.
 *
 * Safety rule: a tool whose KAI-declared risk is DESTRUCTIVE is refused here.
 * `capability.mcp` is EXTERNAL; an EXTERNAL gate must never be spent on a
 * DESTRUCTIVE action. The caller is told to invoke that tool by its own id.
 */
export async function dispatchMcpCapability(
  manager: McpManager,
  action: string | undefined,
  payload: unknown,
): Promise<unknown> {
  const chosen = action ?? "call";
  if (chosen !== "call") {
    throw new Error(`capability "mcp" has no handler for action "${chosen}" (it accepts: call)`);
  }

  // Accept `{server, tool, arguments}` directly, or nested under `input` the way
  // the other capability branches read their driver-shaped detail.
  const outer = typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
  const inner = typeof outer.input === "object" && outer.input !== null && !Array.isArray(outer.input)
    ? (outer.input as Record<string, unknown>)
    : outer;

  const server = inner.server;
  const tool = inner.tool;
  if (typeof server !== "string" || server.length === 0 || typeof tool !== "string" || tool.length === 0) {
    throw new Error('capability "mcp" action "call" needs {server, tool, arguments?} naming a discovered MCP tool');
  }
  const args = inner.arguments;
  return manager.callToolDirect({
    server,
    tool,
    ...(args !== undefined ? { arguments: args } : {}),
    source: "capability.mcp",
  });
}
