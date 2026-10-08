// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The integration adapter the Core lead wires into the existing tool registry.
 *
 * This is the ONLY file in `core/src/mcp/` that touches `ToolRegistry`, and it
 * does so through the registry's public `register()`. Nothing in `tools/**` was
 * modified: an MCP tool is just another `ToolDefinition`, handed to the same
 * boundary every built-in uses. See WIRING.md for the exact call sequence.
 *
 * WHY `register()` NEEDS A TRY/CATCH HERE: the registry's contract is that
 * `register` THROWS on a malformed definition or a duplicate id (it must, so a
 * caller cannot half-insert), but this module's contract is errors-as-values.
 * The two meet here: this adapter is the one place that converts the registry's
 * throw into a `KaiError` value, so an MCP catalogue with one bad tool still
 * registers the rest and reports the bad one honestly.
 *
 * Registration is per tool and atomic: the registry inserts a tool only after
 * `assertWellFormed` and the duplicate check pass, so a refused tool leaves the
 * registry exactly as it was — never half-registered.
 */

import type { KaiError } from "../shared/contracts.ts";
import type { ToolDefinition, ToolRegistry } from "../tools/registry.ts";
import { mcpError } from "./result.ts";
import { adaptMcpTool, type McpToolCall } from "./tool-adapter.ts";
import type { McpRiskDeclaration } from "./types.ts";

export interface McpToolCatalogEntry {
  /** A raw `tools/list` entry from the server. */
  tool: unknown;
  /** How to call it (in production, through the bridge). */
  call: McpToolCall;
}

export interface McpToolWiring {
  /** The registered server name. */
  server: string;
  /** KAI's risk declaration for this server; absent → every tool is refused. */
  risk?: McpRiskDeclaration;
  tools: McpToolCatalogEntry[];
  now?: () => Date;
}

export interface McpWiringReport {
  /** Registry ids that were registered. */
  registered: string[];
  /** Tools refused, with the reason. A refusal is a value, never an exception. */
  refused: { name: string; error: KaiError }[];
}

/**
 * Adapt and register a server's discovered tools.
 *
 * The sequence per tool is: adapt (validate + establish declared risk) → if it
 * fails, record the refusal and move on → otherwise register through the
 * registry boundary. A tool with no derivable risk never reaches `register`.
 */
export function wireMcpTools(registry: ToolRegistry, wiring: McpToolWiring): McpWiringReport {
  const registered: string[] = [];
  const refused: { name: string; error: KaiError }[] = [];
  const now = wiring.now ?? (() => new Date());

  for (const entry of wiring.tools) {
    // The adapter's own name extraction is best-effort: if the entry is so
    // malformed it has no name, report it under a placeholder and let the
    // adapter's error carry the detail.
    const name =
      typeof entry.tool === "object" &&
      entry.tool !== null &&
      typeof (entry.tool as { name?: unknown }).name === "string"
        ? (entry.tool as { name: string }).name
        : "<unnamed>";

    const adapted = adaptMcpTool({
      server: wiring.server,
      tool: entry.tool,
      ...(wiring.risk !== undefined ? { risk: wiring.risk } : {}),
      call: entry.call,
      now,
    });
    if (!adapted.ok) {
      refused.push({ name, error: adapted.error });
      continue;
    }

    try {
      registry.register(adapted.value);
      registered.push(adapted.value.id);
    } catch (error) {
      // The registry refused (duplicate id, or a shape its own guard rejected).
      // Convert the throw to a value; the tool was not registered.
      const detail = error instanceof Error ? error.message : String(error);
      refused.push({ name, error: mcpError("VALIDATION_FAILED", `could not register MCP tool "${name}": ${detail}`, now, detail) });
    }
  }

  return { registered, refused };
}

/** Adapt a single tool without registering it. Convenience re-export. */
export { adaptMcpTool };
export type { McpToolCall };
export type { ToolDefinition };
