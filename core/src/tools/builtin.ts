// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * KAI Core builtin tools — the deliberately small safe set.
 *
 * Every tool here is READ-only and answers a question *about KAI itself*, not
 * about the world: whether the process is healthy, which agents/missions/
 * memories exist. There is intentionally no filesystem, shell, git or GitHub
 * tool at this stage — those are the actions that would need a real approval
 * story, and they are out of scope until that story is proven.
 *
 * The list tools do not reach into storage directly. Storage, agents and
 * missions are owned by other modules and are consumed only through injected
 * *providers* (plain functions), which keeps this module free of any import
 * from those paths. When a provider is not wired the tool returns an empty
 * list rather than inventing data.
 *
 * `validate` for each tool is real. It rejects non-objects, arrays, unknown
 * keys and out-of-range values — the point is that the registry's "validate
 * first" step has something genuinely to reject, not a rubber stamp.
 */

import {
  isRecord,
  isNonEmptyString,
  type AgentStatus,
  type Memory,
  type MemoryType,
  type Mission,
  type MissionStatus,
} from "../shared/contracts.ts";
import { cpus, freemem, platform, release, totalmem } from "node:os";
import type { ToolDefinition, ToolRegistry } from "./registry.ts";

type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };

/** Largest page size any list tool will return. A guard rail, not a preference. */
export const MAX_LIST_LIMIT = 500;

/**
 * Wire the real backing data here. Anything omitted leaves the corresponding
 * list tool returning an empty result (honest: "nothing is wired", not a
 * fabricated row).
 */
export interface BuiltinToolDeps {
  listAgents?: () => AgentStatus[] | Promise<AgentStatus[]>;
  listMissions?: (opts: { limit?: number; status?: MissionStatus }) => Mission[] | Promise<Mission[]>;
  listMemories?: (opts: { limit?: number; type?: MemoryType }) => Memory[] | Promise<Memory[]>;
  /**
   * Hands work to a worker agent. Supplied by the runtime, which owns the agent
   * registry — this module deliberately holds no reference to it. When it is
   * absent the tool fails honestly rather than pretending to have run something.
   */
  runAgentTask?: (input: { agentId: string; action: string; input?: string }) => Promise<unknown>;
}

const MISSION_STATUSES: readonly MissionStatus[] = [
  "DRAFT",
  "QUEUED",
  "RUNNING",
  "WAITING",
  "WAITING_APPROVAL",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
];

const MEMORY_TYPES: readonly MemoryType[] = [
  "user_preference",
  "project_fact",
  "agent_fact",
  "mission_context",
  "note",
];

/**
 * Accept `undefined`/`null` or a plain object whose keys are all in `allowed`.
 * Arrays and primitives are rejected: an array is a classic "caller sent the
 * wrong thing" shape that a loose validator would silently coerce.
 */
function parseOptions(input: unknown, allowed: readonly string[]): Parsed<Record<string, unknown>> {
  if (input === undefined || input === null) return { ok: true, value: {} };
  if (Array.isArray(input)) return { ok: false, reason: "input must be an object, not an array" };
  if (!isRecord(input)) {
    return { ok: false, reason: `input must be an object or omitted; received ${typeof input}` };
  }
  const record = input;
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      return {
        ok: false,
        reason: `unknown option "${key}"; allowed options: ${allowed.length > 0 ? allowed.join(", ") : "none"}`,
      };
    }
  }
  return { ok: true, value: record };
}

function parseLimit(value: unknown): Parsed<number | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return { ok: false, reason: "limit must be an integer" };
  }
  if (value < 1) return { ok: false, reason: "limit must be at least 1" };
  if (value > MAX_LIST_LIMIT) return { ok: false, reason: `limit must be at most ${MAX_LIST_LIMIT}` };
  return { ok: true, value };
}

function parseEnum<T extends string>(value: unknown, allowed: readonly T[], label: string): Parsed<T | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    return { ok: false, reason: `${label} must be one of: ${allowed.join(", ")}` };
  }
  return { ok: true, value: value as T };
}

function applyLimit<T>(items: T[], limit: number | undefined): T[] {
  return limit === undefined ? items : items.slice(0, limit);
}

function countResult(items: unknown[]): { items: unknown[]; count: number } {
  return { items, count: items.length };
}

/**
 * The four tools, as definitions. Returned (not registered) so callers can
 * inspect them; `registerBuiltinTools` does the registration.
 */
export function createBuiltinTools(deps: BuiltinToolDeps = {}): ToolDefinition[] {
  const systemStatus: ToolDefinition = {
    id: "system.get_status",
    name: "Get system status",
    description: "Read KAI Core's own process health: uptime, memory, platform and host facts.",
    risk: "READ",
    // Declarative input contract (./types.ts). The validator below stays the
    // authority; a test cross-checks this declaration against it, so the two
    // cannot drift.
    schema: {
      kind: "object",
      properties: {},
      additionalProperties: false,
    },
    validate(input: unknown) {
      const options = parseOptions(input, []);
      if (!options.ok) return options;
      return { ok: true, value: options.value };
    },
    async execute() {
      const mem = process.memoryUsage();
      return {
        status: "ok",
        pid: process.pid,
        node: process.version,
        platform: platform(),
        release: release(),
        arch: process.arch,
        cpus: cpus().length,
        uptimeMs: Math.round(process.uptime() * 1000),
        checkedAt: new Date().toISOString(),
        memory: {
          rssBytes: mem.rss,
          heapUsedBytes: mem.heapUsed,
          heapTotalBytes: mem.heapTotal,
          systemTotalBytes: totalmem(),
          systemFreeBytes: freemem(),
        },
      };
    },
  };

  const agentsList: ToolDefinition = {
    id: "agents.list",
    name: "List agents",
    description: "List the agents KAI knows about and their last reported state.",
    risk: "READ",
    schema: {
      kind: "object",
      properties: {
        limit: {
          type: "integer",
          description: "Maximum entries to return.",
          minimum: 1,
          maximum: MAX_LIST_LIMIT,
        },
      },
      additionalProperties: false,
    },
    validate(input: unknown) {
      const options = parseOptions(input, ["limit"]);
      if (!options.ok) return options;
      const limit = parseLimit(options.value.limit);
      if (!limit.ok) return limit;
      return { ok: true, value: { limit: limit.value } };
    },
    async execute(input: unknown) {
      const { limit } = input as { limit?: number };
      const agents = (await deps.listAgents?.()) ?? [];
      return countResult(applyLimit(agents, limit));
    },
  };

  const missionsList: ToolDefinition = {
    id: "missions.list",
    name: "List missions",
    description: "List missions, optionally filtered by status and capped by limit.",
    risk: "READ",
    schema: {
      kind: "object",
      properties: {
        limit: {
          type: "integer",
          description: "Maximum entries to return.",
          minimum: 1,
          maximum: MAX_LIST_LIMIT,
        },
        status: {
          type: "string",
          description: "Only return missions in this state.",
          enum: MISSION_STATUSES,
        },
      },
      additionalProperties: false,
    },
    validate(input: unknown) {
      const options = parseOptions(input, ["limit", "status"]);
      if (!options.ok) return options;
      const limit = parseLimit(options.value.limit);
      if (!limit.ok) return limit;
      const status = parseEnum(options.value.status, MISSION_STATUSES, "status");
      if (!status.ok) return status;
      return { ok: true, value: { limit: limit.value, status: status.value } };
    },
    async execute(input: unknown) {
      const { limit, status } = input as { limit?: number; status?: MissionStatus };
      const missions = (await deps.listMissions?.({ limit, status })) ?? [];
      return countResult(applyLimit(missions, limit));
    },
  };

  const memoryList: ToolDefinition = {
    id: "memory.list",
    name: "List memories",
    description: "List stored memories, optionally filtered by type and capped by limit.",
    risk: "READ",
    schema: {
      kind: "object",
      properties: {
        limit: {
          type: "integer",
          description: "Maximum entries to return.",
          minimum: 1,
          maximum: MAX_LIST_LIMIT,
        },
        type: {
          type: "string",
          description: "Only return memories of this kind.",
          enum: MEMORY_TYPES,
        },
      },
      additionalProperties: false,
    },
    validate(input: unknown) {
      const options = parseOptions(input, ["limit", "type"]);
      if (!options.ok) return options;
      const limit = parseLimit(options.value.limit);
      if (!limit.ok) return limit;
      const type = parseEnum(options.value.type, MEMORY_TYPES, "type");
      if (!type.ok) return type;
      return { ok: true, value: { limit: limit.value, type: type.value } };
    },
    async execute(input: unknown) {
      const { limit, type } = input as { limit?: number; type?: MemoryType };
      const memories = (await deps.listMemories?.({ limit, type })) ?? [];
      return countResult(applyLimit(memories, limit));
    },
  };

  /**
   * Handing work to a worker is a DANGEROUS-shaped action, and it is classified
   * that way: EXTERNAL. Before this tool existed, `POST /agents/:id/action`
   * called the adapter directly, so an agent action was the one executable thing
   * in the Core that no policy rule, no risk classification and no approval ever
   * saw (KAI's own audit flagged it). Routing it through the registry is what
   * makes the invariant true: every executable action passes the same boundary.
   *
   * EXTERNAL rather than READ because the worker acts on this machine on KAI's
   * behalf: the fact that KAI cannot see inside the worker is exactly why it
   * must ask first.
   */
  const agentRunTask: ToolDefinition = {
    id: "agents.run_task",
    name: "Run a task on a worker agent",
    description:
      "Hand work to a registered worker agent and return its result. Categorised EXTERNAL because it causes another process to act.",
    risk: "EXTERNAL",
    schema: {
      kind: "object",
      properties: {
        agentId: {
          type: "string",
          description: "The registered agent to hand the work to.",
          required: true,
        },
        action: {
          type: "string",
          description: "What the agent should do (the task title).",
          required: true,
        },
        input: {
          type: "string",
          description: "Optional prompt/payload handed to the agent.",
        },
      },
      additionalProperties: false,
    },
    validate(input: unknown) {
      const options = parseOptions(input, ["agentId", "action", "input"]);
      if (!options.ok) return options;
      const { agentId, action, input: prompt } = options.value;
      if (!isNonEmptyString(agentId)) {
        return { ok: false, reason: "agentId must be a non-empty string" };
      }
      if (!isNonEmptyString(action)) {
        return { ok: false, reason: "action must be a non-empty string" };
      }
      if (prompt !== undefined && typeof prompt !== "string") {
        return { ok: false, reason: "input must be a string when present" };
      }
      return {
        ok: true,
        value: { agentId, action, ...(prompt !== undefined ? { input: prompt } : {}) },
      };
    },
    async execute(input: unknown) {
      const { agentId, action, input: prompt } = input as {
        agentId: string;
        action: string;
        input?: string;
      };
      const run = deps.runAgentTask;
      if (run === undefined) {
        throw new Error("no agent-task runner is wired into this Core");
      }
      return run({ agentId, action, ...(prompt !== undefined ? { input: prompt } : {}) });
    },
  };

  // Grouped: the two agent tools together, then the informational lists. The
  // order here and in BUILTIN_TOOL_IDS must agree — a test asserts it.
  return [systemStatus, agentsList, agentRunTask, missionsList, memoryList];
}

/** The ids `createBuiltinTools` registers, for callers that need to reference them. */
export const BUILTIN_TOOL_IDS: readonly string[] = [
  "system.get_status",
  "agents.list",
  "agents.run_task",
  "missions.list",
  "memory.list",
];

export function registerBuiltinTools(registry: ToolRegistry, deps: BuiltinToolDeps = {}): void {
  for (const tool of createBuiltinTools(deps)) {
    registry.register(tool);
  }
}

/** Re-exported so a caller can narrow a builtin id without a cast. */
export function isBuiltinToolId(value: unknown): value is string {
  return isNonEmptyString(value) && BUILTIN_TOOL_IDS.includes(value);
}
