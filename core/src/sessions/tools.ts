// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The five session tools — the session subsystem's actions, on the ONE registry.
 *
 * Registering them HERE rather than inside `api/routes.ts` keeps the boundary
 * intact: an action is a `ToolDefinition` with a `validate` and an `execute`,
 * and it reaches the world only through `registry.invoke` (validate -> policy ->
 * (approval) -> execute). This module never runs anything itself.
 *
 *   session.search     READ         find conversations by id/title/turn text
 *   session.duplicate  WRITE        fork a conversation (own worker conversation)
 *   session.close      WRITE        close (archive) a conversation, move the pointer
 *   session.clear      DESTRUCTIVE  remove every recorded turn, reset counters
 *   session.delete     DESTRUCTIVE  hard-delete the session and its turns
 *
 * Policy is NOT decided here. The running policy decides: the default policy
 * parks WRITE and DESTRUCTIVE tools that are not on KAI's internal-state
 * allowlist, so `duplicate`/`close`/`clear`/`delete` park for a human and the
 * caller re-issues with the approval id — the EXISTING path every consequential
 * action already takes (no second policy path exists in this file, deliberately).
 *
 * `registerSessionTools` is idempotent: `register()` throws on a duplicate id by
 * design, so every definition is guarded by `registry.get(id) === undefined`
 * first. A second wiring (or an integrator that re-runs) skips instead of
 * crashing.
 */

import type { ToolDefinition, ToolRegistry } from "../tools/registry.ts";
import type { SessionService } from "./service.ts";

export const SESSION_TOOL_IDS = {
  search: "session.search",
  duplicate: "session.duplicate",
  close: "session.close",
  clear: "session.clear",
  delete: "session.delete",
} as const;

export interface SessionToolDeps {
  /** The ONE session service; every tool reads/writes through it, never the store directly. */
  sessions: SessionService;
}

// ── Validators (the house shape: entity -> id -> optional fields, unknowns refused) ──

function entity(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function entityOf(value: unknown, label: string): { ok: true; value: Record<string, unknown> } | { ok: false; reason: string } {
  const record = entity(value);
  return record === null ? { ok: false, reason: `${label} must be an object` } : { ok: true, value: record };
}

/** A non-empty string, returned as-is (ids are matched literally). */
function idOf(value: unknown, label: string): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** The first key that is not allowed, so an unknown option is refused rather than ignored. */
function unknownKey(record: Record<string, unknown>, allowed: readonly string[]): string | undefined {
  return Object.keys(record).find((key) => !allowed.includes(key));
}

type ParsedId = { ok: true; value: { id: string } } | { ok: false; reason: string };

function parseId(input: unknown, label: string): ParsedId {
  const record = entityOf(input, label);
  if (!record.ok) return record;
  const extra = unknownKey(record.value, ["id"]);
  if (extra !== undefined) return { ok: false, reason: `unknown option "${extra}"` };
  const id = idOf(record.value.id, "id");
  if (id === null) return { ok: false, reason: "id must be a non-empty string" };
  return { ok: true, value: { id } };
}

// ── The definitions ───────────────────────────────────────────────────────────

export function createSessionTools(deps: SessionToolDeps): ToolDefinition[] {
  const sessions = deps.sessions;

  return [
    {
      id: SESSION_TOOL_IDS.search,
      name: "Search KAI's conversations",
      description:
        "Search KAI's own conversation sessions by id, title and recorded turn text. The query is matched literally (LIKE wildcards are escaped), so searching for \"100%\" finds the literal percent sign instead of every session.",
      risk: "READ",
      schema: {
        kind: "object",
        additionalProperties: false,
        properties: {
          query: {
            type: "string",
            description: "The text to find; matched literally in session ids, titles and turn text.",
            required: true,
          },
          limit: {
            type: "integer",
            description: "The most hits to return.",
            minimum: 1,
            maximum: 1000,
          },
        },
      },
      validate(input) {
        const record = entityOf(input, "session search input");
        if (!record.ok) return record;
        const extra = unknownKey(record.value, ["query", "limit"]);
        if (extra !== undefined) return { ok: false, reason: `unknown option "${extra}"` };
        const query = idOf(record.value.query, "query");
        if (query === null) return { ok: false, reason: "query must be a non-empty string" };
        const value: { query: string; limit?: number } = { query };
        if (record.value.limit !== undefined) {
          const limit = record.value.limit;
          if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
            return { ok: false, reason: "limit must be an integer between 1 and 1000" };
          }
          value.limit = limit;
        }
        return { ok: true, value };
      },
      async execute(input) {
        const value = input as { query: string; limit?: number };
        return sessions.search(value.query, value.limit !== undefined ? { limit: value.limit } : undefined);
      },
    },
    {
      id: SESSION_TOOL_IDS.duplicate,
      name: "Duplicate a conversation session",
      description:
        "Fork one of KAI's conversation sessions: same title/ownership/binding and the same recorded turns, but deliberately NO worker conversation id — the copy starts its OWN worker conversation on its first turn, which is what keeps per-session worker isolation.",
      risk: "WRITE",
      schema: {
        kind: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", description: "The session to fork.", required: true },
          title: { type: "string", description: "The copy's title; defaults to \"<title> (copy)\"." },
        },
      },
      validate(input) {
        const record = entityOf(input, "session duplicate input");
        if (!record.ok) return record;
        const extra = unknownKey(record.value, ["id", "title"]);
        if (extra !== undefined) return { ok: false, reason: `unknown option "${extra}"` };
        const id = idOf(record.value.id, "id");
        if (id === null) return { ok: false, reason: "id must be a non-empty string" };
        const value: { id: string; title?: string } = { id };
        if (record.value.title !== undefined) {
          if (typeof record.value.title !== "string" || record.value.title.trim().length === 0) {
            return { ok: false, reason: "title must be a non-empty string when present" };
          }
          value.title = record.value.title.trim();
        }
        return { ok: true, value };
      },
      async execute(input) {
        const value = input as { id: string; title?: string };
        return sessions.duplicate(value.id, value.title !== undefined ? { title: value.title } : undefined);
      },
    },
    {
      id: SESSION_TOOL_IDS.close,
      name: "Close a conversation session",
      description:
        "Close (archive) one of KAI's conversation sessions and move the active pointer off it, so KAI is never left writing into a closed conversation. The turns remain recorded; restore re-opens it.",
      risk: "WRITE",
      schema: {
        kind: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", description: "The session to close.", required: true },
        },
      },
      validate(input) {
        return parseId(input, "session close input");
      },
      async execute(input) {
        const value = input as { id: string };
        return sessions.close(value.id);
      },
    },
    {
      id: SESSION_TOOL_IDS.clear,
      name: "Clear a conversation's recorded turns",
      description:
        "Remove every recorded turn of a session and reset its counters. The session itself survives; the removal cannot be undone.",
      risk: "DESTRUCTIVE",
      schema: {
        kind: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", description: "The session whose turns are removed.", required: true },
        },
      },
      validate(input) {
        return parseId(input, "session clear input");
      },
      async execute(input) {
        const value = input as { id: string };
        return sessions.clear(value.id);
      },
    },
    {
      id: SESSION_TOOL_IDS.delete,
      name: "Delete a conversation session",
      description: "Hard-delete a session and every turn recorded in it. The deletion cannot be undone.",
      risk: "DESTRUCTIVE",
      schema: {
        kind: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", description: "The session to delete.", required: true },
        },
      },
      validate(input) {
        return parseId(input, "session delete input");
      },
      async execute(input) {
        const value = input as { id: string };
        return sessions.delete(value.id);
      },
    },
  ];
}

/**
 * Register the five session tools on a registry, idempotently.
 *
 * `register()` throws on a duplicate id (by design — silently replacing a
 * reviewed tool is the confusion the boundary exists to prevent), so this
 * checks `registry.get(id) === undefined` FIRST and reports what it skipped.
 * A second wiring is a no-op, not a crash.
 */
export function registerSessionTools(
  registry: ToolRegistry,
  deps: SessionToolDeps,
): { registered: string[]; skipped: string[] } {
  const registered: string[] = [];
  const skipped: string[] = [];
  for (const tool of createSessionTools(deps)) {
    if (registry.get(tool.id) !== undefined) {
      skipped.push(tool.id);
      continue;
    }
    registry.register(tool);
    registered.push(tool.id);
  }
  return { registered, skipped };
}
