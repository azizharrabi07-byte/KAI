// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The MODEL TOOL PLANE — the bridge between KAI's tool registry and the
 * inference loop.
 *
 * ── Why this module exists ────────────────────────────────────────────────────
 * The mission's P2 defect: "search inside my files" reached the model, the model
 * had NO tool to select, and KAI answered "I don't know what you mean". The
 * registry, the policy gate and the approval service all existed — but nothing
 * translated the registered tools into the `tools` array a chat-completions
 * model understands, and nothing turned the model's `tool_calls` back into a
 * registry invocation whose result the model could read.
 *
 * This module is exactly that translation, and nothing else:
 *
 *   MODEL  → declarations()  → the `tools` the model may choose from
 *   MODEL  → execute()       → registry.invoke() (the ONE boundary)
 *   RESULT → the model context, as a JSON value it can reason over
 *
 * ── Two invariants that must not move ────────────────────────────────────────
 * 1. NOTHING here executes a tool. Every call goes through `registry.invoke`,
 *    so validate -> policy -> (approval) -> execute is applied once, by the
 *    boundary that owns it. A plane that ran a tool body directly would be the
 *    second, unaudited path the registry exists to prevent.
 * 2. The model's `arguments` are TEXT. They are parsed here and a malformed or
 *    unknown-tool request becomes a refusal the MODEL SEES, never a throw that
 *    kills the turn. A refusal is a result, exactly as it is at the registry.
 *
 * ── Which tools the model may see ────────────────────────────────────────────
 * By default, the READ tools that are not `effectful` and carry a declared
 * schema — the safe, sandboxed subset (filesystem.search/list/read/metadata,
 * git read ops, status/list tools). A caller may pass an explicit `ids` set.
 * A WRITE/DESTRUCTIVE tool is never exposed implicitly: exposing it would put a
 * parking approval in front of a model that cannot answer it, and the mission's
 * rule is to not blindly enable destructive tools. A caller that wants one
 * passes its id deliberately.
 */

import type { ModelToolDeclaration } from "../model/types.ts";
import type { ToolRegistry, ToolDefinition } from "./registry.ts";
import { isRecord } from "../shared/contracts.ts";
import type { ToolSchema } from "./types.ts";

/** One executed (or refused) model-requested call, in the shape the brain feeds back. */
export interface ModelToolExecution {
  /** True only when the registry actually executed the tool. */
  ok: boolean;
  /** The registry status: EXECUTED | INVALID | DENIED | APPROVAL_REQUIRED | FAILED | NOT_FOUND. */
  status: string;
  /** What the MODEL reads: the tool's value, or an error VALUE. Always JSON-serializable. */
  value: unknown;
  /** The attempt's identity on the bus, so a caller can trace it. */
  invocationId: string;
  /**
   * The canonical registry tool id (`filesystem.search`) — the dotted identity,
   * not the sanitised wire name (`filesystem_search`) the model echoed. Absent
   * only when the name matched nothing declared.
   */
  toolId?: string;
}

export interface ModelToolPlane {
  /** The `tools` array for a chat request. Stable for the life of the plane. */
  declarations(): ModelToolDeclaration[];
  /** The tool ids this plane exposes, in declaration order. */
  toolIds(): string[];
  /** Run one model-requested call through the registry boundary. Never throws. */
  execute(
    name: string,
    argsJson: string,
    opts?: { sessionId?: string; agentId?: string; source?: string; executionId?: string; signal?: AbortSignal },
  ): Promise<ModelToolExecution>;
}

export interface ModelToolPlaneOptions {
  registry: ToolRegistry;
  /**
   * Explicit tool ids to expose. When omitted, the default safe set is used:
   * every registered tool whose risk is READ, that is not `effectful`, and that
   * declares a schema (so a real function declaration can be built).
   */
  ids?: readonly string[];
  /** Source stamped on every invocation; defaults to "model". */
  source?: string;
}

/**
 * The function name a provider accepts: `^[a-zA-Z0-9_-]+$`, at most 64 chars.
 * A tool id like `filesystem.search` contains a dot, which is NOT in that set,
 * so it is sanitised and the mapping back to the real id is held beside it (a
 * name the model sees must never be mistaken for a different tool id).
 */
export function modelFunctionName(toolId: string): string {
  const sanitised = toolId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return sanitised.length <= 64 ? sanitised : sanitised.slice(0, 64);
}

/** Convert KAI's small declared schema into a JSON-schema object for the wire. */
export function schemaToJsonSchema(schema: ToolSchema): unknown {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [name, field] of Object.entries(schema.properties)) {
    const property: Record<string, unknown> = { type: field.type };
    if (field.description !== undefined) property["description"] = field.description;
    if (field.enum !== undefined) property["enum"] = field.enum;
    if (field.minimum !== undefined) property["minimum"] = field.minimum;
    if (field.maximum !== undefined) property["maximum"] = field.maximum;
    // KAI's schema has no per-field item type; an array field here is a list of
    // strings (extensions, directory names), which is the only array it declares.
    if (field.type === "array") property["items"] = { type: "string" };
    properties[name] = property;
    if (field.required === true) required.push(name);
  }
  const jsonSchema: Record<string, unknown> = {
    type: "object",
    properties,
    additionalProperties: schema.additionalProperties,
  };
  if (required.length > 0) jsonSchema["required"] = required;
  return jsonSchema;
}

/** The default safe set: READ, not effectful, with a declared schema. */
export function defaultModelToolIds(registry: ToolRegistry): string[] {
  return registry
    .list()
    .filter((tool) => tool.risk === "READ" && tool.effectful !== true && tool.schema !== undefined)
    .map((tool) => tool.id);
}

export function createModelToolPlane(options: ModelToolPlaneOptions): ModelToolPlane {
  const registry = options.registry;
  const source = options.source ?? "model";
  const ids = options.ids !== undefined ? [...options.ids] : defaultModelToolIds(registry);

  // functionName -> real tool id, and the declarations, built ONCE. A tool named
  // in `ids` that is not registered is skipped rather than invented.
  const byFunctionName = new Map<string, string>();
  const declarations: ModelToolDeclaration[] = [];
  const exposed: string[] = [];
  for (const id of ids) {
    const tool: ToolDefinition | undefined = registry.get(id);
    if (tool === undefined) continue;
    const functionName = modelFunctionName(id);
    if (byFunctionName.has(functionName)) {
      // Two ids sanitising to one name would make the model's choice ambiguous;
      // refusing loudly is better than mapping a call to the wrong tool.
      throw new Error(`model tool name collision: "${id}" and "${byFunctionName.get(functionName)}" both map to "${functionName}"`);
    }
    byFunctionName.set(functionName, id);
    exposed.push(id);
    declarations.push({
      type: "function",
      function: {
        name: functionName,
        description: tool.description,
        parameters:
          tool.schema !== undefined
            ? schemaToJsonSchema(tool.schema)
            : { type: "object", properties: {}, additionalProperties: true },
      },
    });
  }

  /** A refusal the MODEL reads — never a throw. */
  function refusal(invocationId: string, status: string, value: unknown, toolId?: string): ModelToolExecution {
    return { ok: false, status, value, invocationId, ...(toolId !== undefined ? { toolId } : {}) };
  }

  return {
    declarations(): ModelToolDeclaration[] {
      return declarations.map((declaration) => ({
        type: "function",
        function: { ...declaration.function },
      }));
    },

    toolIds(): string[] {
      return [...exposed];
    },

    async execute(name, argsJson, opts): Promise<ModelToolExecution> {
      // DECLARATION CHECK — the first gate, before policy. A model may execute
      // ONLY what this turn exposed to it: the sanitised function name of an
      // exposed tool, or the raw id of an exposed tool (some models echo the
      // dotted id verbatim). A raw id that is registered but NOT exposed is
      // refused here — policy remains the second layer, never the only one.
      const resolved = byFunctionName.get(name);
      const toolId = resolved ?? (exposed.includes(name) ? name : undefined);
      if (toolId === undefined) {
        return refusal("", "NOT_FOUND", {
          error: "unknown_tool",
          message:
            registry.get(name) !== undefined || registry.get(byFunctionName.get(name) ?? "") !== undefined
              ? `tool "${name}" exists but was not offered to the model this turn; choose one of: ${[...byFunctionName.keys()].join(", ")}`
              : `no tool named "${name}" is available; choose one of: ${[...byFunctionName.keys()].join(", ")}`,
        });
      }

      // The model's arguments are text. An empty string is a legitimate "no
      // arguments"; anything else must be a JSON object, or the call is refused
      // BEFORE the boundary (a refusal the model can correct).
      let input: unknown = {};
      const trimmed = argsJson.trim();
      if (trimmed.length > 0) {
        try {
          input = JSON.parse(trimmed) as unknown;
        } catch {
          return refusal(
            "",
            "INVALID",
            {
              error: "invalid_arguments",
              message: `arguments were not valid JSON: ${trimmed.slice(0, 200)}`,
            },
            toolId,
          );
        }
        if (!isRecord(input)) {
          return refusal(
            "",
            "INVALID",
            {
              error: "invalid_arguments",
              message: "arguments must be a JSON object",
            },
            toolId,
          );
        }
      }

      const invoked = await registry.invoke(toolId, input, {
        source,
        ...(opts?.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
        ...(opts?.agentId !== undefined ? { agentId: opts.agentId } : {}),
        ...(opts?.executionId !== undefined ? { executionId: opts.executionId } : {}),
        ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
      });
      if (invoked.ok) {
        return {
          ok: true,
          status: invoked.invocation.status,
          value: invoked.result,
          invocationId: invoked.invocation.invocationId,
          toolId,
        };
      }
      // A parked/failed call is reported to the model with its status and reason,
      // so the model can tell the user what is blocked and why — not silently.
      return refusal(
        invoked.invocation.invocationId,
        invoked.invocation.status,
        {
          error: invoked.error.code,
          message: invoked.error.message,
          ...(invoked.invocation.approvalId !== undefined
            ? { approvalRequired: invoked.invocation.approvalId }
            : {}),
        },
        toolId,
      );
    },
  };
}
