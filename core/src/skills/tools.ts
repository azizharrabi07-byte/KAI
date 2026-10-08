// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Optional READ-only tool definitions the Core lead can register on the existing
 * `ToolRegistry`. They expose the progressive-disclosure surface to an agent:
 *
 *   skills.list      metadata for every skill (no bodies)
 *   skills.relevant  metadata for the skills worth loading for a query (no bodies)
 *   skills.load      the body of ONE skill, by id
 *
 * There is deliberately NO `skills.install` tool. Installation must be bound to
 * the exact approved bytes, and the tool registry's approval record does not
 * carry the bytes it was granted for — so an install exposed as a generic tool
 * would authorise "some skill install", not "this skill revision". Install goes
 * through `staging.requestInstallApproval` / `staging.installApproved`, where
 * the approval is bound to the SHA-256. (The WIRING note explains this.)
 *
 * All three are READ: reading a catalogue and reading a document are not actions
 * that change the world, so they must not demand a card.
 */

import { isNonEmptyString, isRecord } from "../shared/contracts.ts";
import type { ToolDefinition } from "../tools/registry.ts";
import type { SkillRegistry } from "./registry.ts";
import { isSafeSkillId } from "./validate.ts";

type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };

function parseOptions(input: unknown, allowed: readonly string[]): Parsed<Record<string, unknown>> {
  if (input === undefined || input === null) return { ok: true, value: {} };
  if (Array.isArray(input) || !isRecord(input)) {
    return { ok: false, reason: "input must be an object or omitted" };
  }
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      return { ok: false, reason: `unknown option "${key}"; allowed: ${allowed.join(", ")}` };
    }
  }
  return { ok: true, value: input };
}

function parseLimit(value: unknown): Parsed<number | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 100) {
    return { ok: false, reason: "limit must be an integer between 1 and 100" };
  }
  return { ok: true, value };
}

export function createSkillToolDefinitions(skills: SkillRegistry): ToolDefinition[] {
  const list: ToolDefinition = {
    id: "skills.list",
    name: "List skills",
    description:
      "List installed skills as metadata only (id, name, description, source, hash, status). Bodies are never returned here.",
    risk: "READ",
    validate(input: unknown) {
      const options = parseOptions(input, ["limit"]);
      if (!options.ok) return options;
      const limit = parseLimit(options.value.limit);
      if (!limit.ok) return limit;
      return { ok: true, value: { limit: limit.value } };
    },
    async execute(input: unknown) {
      const { limit } = input as { limit?: number };
      const items = skills.list();
      return { items: limit === undefined ? items : items.slice(0, limit), count: items.length };
    },
  };

  const relevant: ToolDefinition = {
    id: "skills.relevant",
    name: "Find relevant skills",
    description:
      "Return metadata for at most `limit` skills relevant to a query. Load one with skills.load only when it is actually needed.",
    risk: "READ",
    validate(input: unknown) {
      const options = parseOptions(input, ["query", "limit"]);
      if (!options.ok) return options;
      if (!isNonEmptyString(options.value.query)) {
        return { ok: false, reason: "query must be a non-empty string" };
      }
      const limit = parseLimit(options.value.limit);
      if (!limit.ok) return limit;
      return { ok: true, value: { query: options.value.query, limit: limit.value } };
    },
    async execute(input: unknown) {
      const { query, limit } = input as { query: string; limit?: number };
      return { items: skills.relevant(query, limit), count: undefined };
    },
  };

  const load: ToolDefinition = {
    id: "skills.load",
    name: "Load a skill",
    description: "Read the body of one installed skill by id. Refuses a disabled skill or an id that is not usable.",
    risk: "READ",
    validate(input: unknown) {
      const options = parseOptions(input, ["id"]);
      if (!options.ok) return options;
      if (!isNonEmptyString(options.value.id)) {
        return { ok: false, reason: "id must be a non-empty string" };
      }
      if (!isSafeSkillId(options.value.id)) {
        return { ok: false, reason: "id is not a usable skill id" };
      }
      return { ok: true, value: { id: options.value.id } };
    },
    async execute(input: unknown) {
      const { id } = input as { id: string };
      const loaded = skills.load(id);
      return loaded.ok
        ? { skill: loaded.value.metadata, body: loaded.value.body }
        : { error: loaded.error };
    },
  };

  return [list, relevant, load];
}
