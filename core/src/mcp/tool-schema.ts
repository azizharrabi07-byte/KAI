// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Provider-safe MCP tool input schemas.
 *
 * An MCP server hands KAI a tool's `inputSchema`, and KAI passes it to a model
 * provider as the function's parameters. The strict providers (OpenAI, xAI,
 * Bedrock, Kimi…) require that the root be a plain `{type:"object"}`, and an
 * MCP tool whose root is `anyOf`/`oneOf`/`allOf`/`not` makes the provider reject
 * the *whole turn* — not just that one tool, and not just for that turn's tool
 * calls: every tool disappears and the request fails. Flattening the root is
 * therefore not cosmetic.
 *
 * The rewrite only relaxes what the model is TOLD. The MCP server still
 * validates the call against its own schema; a nested schema is left exactly as
 * written. Everything else on the wire — tool results, notifications, errors,
 * non-JSON lines — passes through byte-for-byte. See `createToolListNormalizer`.
 */

type JsonObject = Record<string, unknown>;

const ROOT_COMBINATORS = ["anyOf", "oneOf", "allOf", "not"] as const;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function branches(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

/**
 * The object shape a schema implies, gathered through its combinators.
 *
 * Its own `properties` win over a branch's narrower copy; a property only a
 * branch declares is kept, so the model still learns it exists. A name is
 * required when the schema or an `allOf` branch requires it, or when every
 * `anyOf`/`oneOf` choice does — a requirement of only one choice is not a
 * requirement of the union.
 */
function objectShape(schema: JsonObject): { properties: JsonObject; required: string[] } {
  const properties: JsonObject = isObject(schema.properties) ? { ...schema.properties } : {};
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === "string") : [],
  );

  const adopt = (shape: { properties: JsonObject }) => {
    for (const [key, value] of Object.entries(shape.properties)) {
      if (!(key in properties)) properties[key] = value;
    }
  };

  for (const branch of branches(schema.allOf)) {
    const shape = objectShape(branch);
    adopt(shape);
    for (const key of shape.required) required.add(key);
  }
  for (const keyword of ["anyOf", "oneOf"] as const) {
    const choices = branches(schema[keyword]).map(objectShape);
    if (choices.length === 0) continue;
    for (const choice of choices) adopt(choice);
    // `choices[0]` is safe: choices.length > 0 was checked above.
    for (const key of choices[0]!.required) {
      if (choices.every((choice) => choice.required.includes(key))) required.add(key);
    }
  }
  return { properties, required: [...required] };
}

function describesObject(type: unknown): boolean {
  return type === undefined || type === "object" || (Array.isArray(type) && type.includes("object"));
}

export interface SchemaNormalization {
  /** The provider-safe schema. */
  schema: JsonObject;
  /** True when the input was replaced or rewritten; false when it was already safe. */
  changed: boolean;
}

/**
 * A strict-provider-safe version of an MCP tool's `inputSchema`.
 *
 * Returns `changed: false` and the SAME object when the schema is already a
 * plain object root with no combinator — so a caller can tell, by identity,
 * whether anything needs to be written back. The input is never mutated.
 */
export function normalizeInputSchema(schema: unknown): SchemaNormalization {
  if (!isObject(schema) || !describesObject(schema.type)) {
    // A non-object root (or a primitive type) is replaced outright: there is no
    // object shape to preserve, and leaving it would fail the whole turn.
    return { schema: { type: "object", properties: {} }, changed: true };
  }
  if (schema.type === "object" && ROOT_COMBINATORS.every((keyword) => !(keyword in schema))) {
    return { schema, changed: false };
  }

  const { properties, required } = objectShape(schema);
  const safe: JsonObject = { ...schema, type: "object", properties };
  for (const keyword of ROOT_COMBINATORS) delete safe[keyword];
  if (required.length > 0) safe.required = required;
  else delete safe.required;
  return { schema: safe, changed: true };
}

/**
 * Rewrites `tools/list` responses on an MCP stdio stream.
 *
 * A response is touched only when it answers a `tools/list` the agent actually
 * sent — matched by JSON-RPC id, which may be a number or a string (`7` is not
 * `"7"`). Every other line is returned unchanged, so the normalizer is safe to
 * place on the outbound path of a byte-transparent bridge.
 */
export interface ToolListNormalizer {
  /** Record an agent → server line, to learn which id is a tools/list. */
  observeRequest(line: string): void;
  /** Map a server → agent line to what the agent should receive. */
  rewriteResponse(line: string): string;
}

export function createToolListNormalizer(): ToolListNormalizer {
  const pending = new Set<string>();
  const idKey = (id: unknown) => `${typeof id}:${String(id)}`;

  return {
    observeRequest(line) {
      let frame: unknown;
      try {
        frame = JSON.parse(line);
      } catch {
        return; // not JSON: not a request we could have sent
      }
      if (
        isObject(frame) &&
        frame.method === "tools/list" &&
        (typeof frame.id === "number" || typeof frame.id === "string")
      ) {
        pending.add(idKey(frame.id));
      }
    },

    rewriteResponse(line) {
      if (pending.size === 0) return line;
      let frame: unknown;
      try {
        frame = JSON.parse(line);
      } catch {
        return line;
      }
      if (!isObject(frame) || "method" in frame || !pending.delete(idKey(frame.id))) return line;
      if (!isObject(frame.result) || !Array.isArray(frame.result.tools)) return line;

      let changed = false;
      const tools = frame.result.tools.map((tool: unknown) => {
        if (!isObject(tool)) return tool;
        const normalized = normalizeInputSchema(tool.inputSchema);
        if (!normalized.changed) return tool;
        changed = true;
        return { ...tool, inputSchema: normalized.schema };
      });
      // Re-serialising is itself a deliberate exception; when nothing changed we
      // hand back the ORIGINAL line so its bytes are untouched.
      return changed ? JSON.stringify({ ...frame, result: { ...frame.result, tools } }) : line;
    },
  };
}
