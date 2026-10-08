// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * MCP → KAI tool adapter: the policy boundary that no provider may bypass.
 *
 * THE CENTRAL RULE OF PART Q: an MCP tool is NOT special. Once it is adapted, it
 * is a `ToolDefinition` exactly like a built-in one, and it enters the same
 * registry boundary — validate → policy → (approval) → execute. A third-party
 * server declaring a tool does not make that tool trusted; the provider's word
 * about its own tool is not evidence of anything.
 *
 * The one thing KAI must supply that a provider cannot is the RISK. An MCP
 * server gives a name, a description and a JSON schema and stops there; a
 * provider *may* attach MCP `annotations` (`readOnlyHint`, `destructiveHint`),
 * which are self-reported hints by the very code that would benefit from being
 * believed, so KAI never reads them as the risk. Risk comes only from a KAI-owned
 * `McpRiskDeclaration` (see types.ts), made by the user or an admin when the
 * server was registered.
 *
 * FAIL CLOSED: a tool whose risk cannot be established is REFUSED, not defaulted
 * to READ. Defaulting an unknown third-party action to the one level that runs
 * without approval would be the exact inversion of the product's safety posture,
 * so this adapter returns `{ok:false}` and registers nothing.
 */

import { isRecord, type RiskLevel } from "../shared/contracts.ts";
import type { ToolDefinition } from "../tools/registry.ts";
import { fail, ok, mcpError, type McpResult } from "./result.ts";
import { validateDiscoveredTool, validateRiskDeclaration } from "./validation.ts";
import type { McpDiscoveredTool, McpRiskDeclaration } from "./types.ts";

/** Calls the far end. In production this routes through the stdio/http bridge. */
export type McpToolCall = (args: unknown) => Promise<unknown>;

export interface McpToolAdapterInput {
  /** The registered server name; used to namespace the tool id. */
  server: string;
  /** A raw `tools/list` entry; validated here so the adapter is safe on untrusted input. */
  tool: unknown;
  /** KAI-owned risk declaration. Absent → the tool cannot be trusted and is refused. */
  risk?: McpRiskDeclaration;
  /** How to actually call the tool. */
  call: McpToolCall;
  now?: () => Date;
}

/**
 * The id an MCP tool gets in KAI's registry.
 *
 * Namespaced under `mcp.<server>.` so a third-party tool can never shadow a
 * built-in id (`system.get_status`, `agents.list`). Even if a server declared a
 * tool literally named `system.get_status`, its KAI id is
 * `mcp.<server>.system.get_status`, which collides with nothing KAI owns.
 */
export function mcpToolId(server: string, toolName: string): string {
  return `mcp.${server}.${toolName}`;
}

/**
 * Resolve the KAI-declared risk for one tool: a per-tool entry wins, then the
 * server default. Anything else — including the tool's own annotations — is not
 * consulted. Returns `undefined` when no declaration covers the tool.
 */
export function resolveMcpRisk(
  declaration: McpRiskDeclaration | undefined,
  toolName: string,
): RiskLevel | undefined {
  if (declaration === undefined) return undefined;
  const perTool = declaration.tools?.[toolName];
  if (perTool !== undefined) return perTool;
  return declaration.default;
}

/** A description KAI can show even when the server sent none. Never empty. */
function describe(tool: McpDiscoveredTool, server: string): string {
  const description = tool.description?.trim();
  if (description !== undefined && description.length > 0) return description;
  return `MCP tool "${tool.name}" provided by server "${server}"`;
}

export function adaptMcpTool(input: McpToolAdapterInput): McpResult<ToolDefinition> {
  const now = input.now ?? (() => new Date());

  // 1. Validate the discovered tool. A malformed entry fails here, as a value,
  //    before any state exists — nothing is half-registered.
  const tool = validateDiscoveredTool(input.tool);
  if (!tool.ok) return tool;

  // 2. Validate the declaration (if any) before trusting one field of it.
  const declaration = validateRiskDeclaration(input.risk);
  if (!declaration.ok) return declaration;

  // 3. Establish the risk — the gate. No declaration, no registration.
  const risk = resolveMcpRisk(declaration.value, tool.value.name);
  if (risk === undefined) {
    return fail(
      mcpError(
        "POLICY_DENIED",
        `MCP tool "${tool.value.name}" from server "${input.server}" has no risk KAI can establish; ` +
          `refusing to register it. Declare its risk (READ/WRITE/EXTERNAL/DESTRUCTIVE) when registering the server — ` +
          `an MCP tool is never defaulted to READ, and its own annotations are never trusted as the risk.`,
        now,
      ),
    );
  }

  const id = mcpToolId(input.server, tool.value.name);

  const definition: ToolDefinition = {
    id,
    name: tool.value.name,
    description: describe(tool.value, input.server),
    // The DECLARED risk, from KAI's own declaration. This is the value the
    // policy gate sees; there is no path by which a provider sets it.
    risk,
    validate(rawInput: unknown) {
      // MCP tools take a JSON object of arguments. Accept an omitted argument
      // set as `{}`; reject arrays and primitives — a caller that sent an array
      // sent the wrong thing, and coercing it here would hide that.
      if (rawInput === undefined || rawInput === null) return { ok: true, value: {} };
      if (!isRecord(rawInput)) {
        return {
          ok: false,
          reason: `MCP tool "${tool.value.name}" expects an object of arguments, received ${
            Array.isArray(rawInput) ? "an array" : typeof rawInput
          }`,
        };
      }
      return { ok: true, value: rawInput };
    },
    async execute(rawInput: unknown) {
      // Throws are converted to INTERNAL by the registry boundary; this never
      // gets to decide whether it may run.
      return input.call(rawInput);
    },
  };

  return ok(definition);
}
