// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The KAI-owned MCP manager — the runtime seam that turns `core/src/mcp/**` from
 * a library into a capability KAI actually holds.
 *
 * WHAT THIS IS
 * ------------
 * `registry.ts` owns the server catalogue (validated entries, write-only
 * secrets, disabled-by-default). `real-client.ts` owns the stdio conversation.
 * `integration.ts` adapts discovered tools into KAI `ToolDefinition`s. None of
 * them has a runtime call site — this file is that call site, and it is the ONE
 * place that decides what a connected server means for KAI:
 *
 *   - a server is REGISTERED (inert), ENABLED (may be started) and CONNECTED
 *     (running, tools discovered) — three separate facts, never conflated;
 *   - every discovered tool is registered into KAI's ONE tool registry via
 *     `wireMcpTools`, with a KAI-declared risk (never the provider's
 *     annotations), so invoking it is `validate -> policy -> (approval) ->
 *     execute` exactly like a built-in;
 *   - every invocation is recorded as an `McpInvocationRecord` (toolId,
 *     executionId, sessionId, agentId, source, arguments, result, status,
 *     duration, approvalId) — the MCP provenance ledger. It is ADDITIVE to the
 *     action record the tool registry already emits for the same call: the
 *     registry record says "an action ran under this authority", this one says
 *     "which MCP server and tool, with which arguments, for which caller".
 *   - the MANAGEMENT operations (register/update/enable/disable/remove/connect/
 *     disconnect/refresh) are themselves tools (`mcp.register`, `mcp.connect`,
 *     …) registered into the same registry. A management action cannot bypass
 *     the policy boundary because there is no other way to run one. Their risks
 *     are honest: adding or connecting a server is at least WRITE, connecting is
 *     EXTERNAL (it starts third-party code with KAI's authority), so the default
 *     policy parks them for a human.
 *
 * WHAT IT IS NOT
 * --------------
 *   - NOT a second tool registry, event model or approval path. It registers
 *     INTO `ToolRegistry` and lets the existing boundary decide.
 *   - NOT a per-worker universe. There is one manager; a worker can only reach
 *     an MCP tool through KAI's registry, and only for a server KAI has
 *     connected. `callToolDirect` is the single deliberate exception and is
 *     reachable only from inside `capability.mcp`'s already-gated execute (see
 *     capability.ts) — the same pattern the workspace capability ops use.
 *
 * Errors are values (McpResult / KaiError), never throws at this boundary.
 * `createMcpManager` itself is startup wiring: it may throw for a programmer
 * error (a missing tool registry), which is a configuration failure, not an
 * untrusted-input one.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { KaiError, RiskLevel } from "../shared/contracts.ts";
import type { ToolDefinition, ToolRegistry } from "../tools/registry.ts";
import { wireMcpTools } from "./integration.ts";
import { spawnMcpClient, type McpServerInfo, type RealMcpClient, type SpawnMcpClientOptions } from "./real-client.ts";
import { createMcpRegistry, type McpRegistry } from "./registry.ts";
import type { SecretResolver, ReferenceStatus } from "./secrets.ts";
import { fail, mcpError, ok, type McpResult } from "./result.ts";
import { mcpToolId } from "./tool-adapter.ts";
import type { McpDiscoveredTool, McpRiskDeclaration, McpServerListing, McpServerRecord } from "./types.ts";

// ── Spawn seam ────────────────────────────────────────────────────────────────

/** How the manager starts a server. Defaults to the real stdio client. */
export type McpSpawn = (options: SpawnMcpClientOptions) => RealMcpClient;

// ── Management tool ids ───────────────────────────────────────────────────────
//
// Namespaced `mcp.<verb>` on purpose: a server can be named `register`, so
// `mcp.register.<tool>` (its tools) and `mcp.register` (this management tool)
// must stay distinct — they are, by segment count, and the id shapes make that
// visible rather than accidental.

export const MCP_MANAGEMENT_TOOL_IDS = {
  register: "mcp.register",
  update: "mcp.update",
  enable: "mcp.enable",
  disable: "mcp.disable",
  remove: "mcp.remove",
  connect: "mcp.connect",
  disconnect: "mcp.disconnect",
  refresh: "mcp.refresh",
} as const;

// ── Provenance ────────────────────────────────────────────────────────────────

/** How one invocation attempt ended. Closed set; every attempt gets exactly one. */
export type McpInvocationStatus =
  | "EXECUTED"
  | "DENIED"
  | "APPROVAL_REQUIRED"
  | "INVALID"
  | "NOT_FOUND"
  | "FAILED";

/**
 * One MCP invocation, recorded at the moment it was attempted.
 *
 * This is the provenance the brief requires, in one value: which KAI tool id,
 * which server-local tool, which execution, who asked (session/agent/source),
 * with what arguments, what came back, how it ended, how long it took, and the
 * approval that authorised it where one did.
 */
export interface McpInvocationRecord {
  /** Unique per attempt; the correlation id for this invocation. */
  executionId: string;
  /** The KAI registry id, e.g. `mcp.github.search_repositories`. */
  toolId: string;
  /** The registered server name. */
  server: string;
  /** The server-local tool name from `tools/list`. */
  tool: string;
  /** Who caused it: "mcp" (default), "capability.mcp", "ui", "core", … */
  source: string;
  /** The validated arguments the registry saw. */
  arguments: unknown;
  status: McpInvocationStatus;
  startedAt: string;
  durationMs: number;
  /** The tool result, on success. Never a secret by construction (it is the server's answer). */
  result?: unknown;
  /** The typed failure, on any non-EXECUTED status. */
  error?: { code: string; message: string };
  sessionId?: string;
  agentId?: string;
  approvalId?: string;
  missionId?: string;
  stepId?: string;
  turnId?: string;
}

/** Where a provenance record goes besides the manager's own ring. Optional. */
export type McpProvenanceSink = (record: McpInvocationRecord) => void;

// ── Connection state ──────────────────────────────────────────────────────────

export interface McpConnection {
  readonly client: RealMcpClient;
  readonly serverInfo: McpServerInfo | undefined;
  /** The raw, validated `tools/list` entries as discovered. */
  readonly tools: McpDiscoveredTool[];
  /** The registry ids `wireMcpTools` registered for this connection. */
  readonly registeredIds: string[];
  /** Tools that were discovered but refused (no KAI risk, malformed, duplicate). */
  readonly refused: { name: string; error: KaiError }[];
  connectedAt: string;
  /** Last successful `resources/list` count, or null until one succeeds. */
  resourceCount: number | null;
}

/** What a connect/refresh attempt produced, as a value. */
export interface McpConnectReport {
  server: string;
  serverInfo: { name?: string; version?: string; protocolVersion?: string };
  registered: string[];
  refused: { name: string; error: KaiError }[];
  toolCount: number;
}

/** A listing plus the live facts a caller needs, in one view. */
export type McpServerView = McpServerListing & {
  connected: boolean;
  toolCount: number;
  resourceCount: number | null;
  serverInfo?: { name?: string; version?: string; protocolVersion?: string };
  /**
   * Redacted credential requirement: the key NAMES, whether each is a literal
   * or a reference, the reference target (a variable/target NAME, never a
   * value), and PRESENT/MISSING/UNREADABLE. Carries no value by construction, so
   * it is safe on every read surface and safe to archive as evidence.
   */
  credentials?: {
    keys: { key: string; kind: "literal" | "env" | "credman"; target: string | null; status: ReferenceStatus }[];
    required: boolean;
  };
};

export interface McpSummary {
  servers: number;
  enabled: number;
  connected: number;
  tools: number;
  resources: number;
  persistence: { path: string | null; problem: string | null };
  management: { registered: string[]; refused: { name: string; reason: string }[] };
}

// ── Invocation ────────────────────────────────────────────────────────────────

export interface McpInvocationInput {
  server: string;
  tool: string;
  arguments?: unknown;
  approvalId?: string;
  sessionId?: string;
  agentId?: string;
  source?: string;
  missionId?: string;
  stepId?: string;
  turnId?: string;
}

export interface McpInvocationOutcome {
  toolId: string;
  executionId: string;
  result: unknown;
  approvalId?: string;
}

// ── Manager ───────────────────────────────────────────────────────────────────

export interface McpManagerDeps {
  /** KAI's ONE tool registry. MCP tools and the management tools register here. */
  tools: ToolRegistry;
  /** Reuse an existing server catalogue (tests); default: a fresh one. */
  registry?: McpRegistry;
  /** Transport factory override (tests); default: the real stdio client. */
  spawn?: McpSpawn;
  /**
   * How a stored secret REFERENCE (`env:`/`credman:`) is resolved. Default: the
   * real process environment and the real Windows Credential Manager. Injected
   * by tests so a resolution can be proven without touching the host.
   */
  secretResolver?: SecretResolver;
  /** Optional provenance sink, called for every invocation attempt. */
  record?: McpProvenanceSink;
  now?: () => Date;
  /**
   * Where the server catalogue persists (JSON, written 0600 where the OS
   * honours it). Absent → in-memory for this process only. The file holds
   * credential VALUES (the launcher needs them), which is why it belongs under
   * the Core's data directory and nowhere else.
   */
  persistPath?: string;
  requestTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  /** Provenance ring size. Default 200, newest first. */
  maxProvenance?: number;
}

export interface McpManager {
  /** The server catalogue. Exposed for reads; mutations go through the tools. */
  readonly servers: McpRegistry;
  /** The tool registry MCP registered into. */
  readonly tools: ToolRegistry;

  // ── Catalogue operations (called by the management tools) ──────────────────
  registerServer(name: unknown, entry: unknown): McpResult<McpServerListing>;
  updateServer(name: string, entry: unknown): McpResult<McpServerListing>;
  removeServer(name: string): McpResult<{ name: string }>;
  enableServer(name: string): McpResult<McpServerListing>;
  disableServer(name: string): McpResult<McpServerListing>;

  // ── Connection operations ──────────────────────────────────────────────────
  connectServer(name: string): Promise<McpResult<McpConnectReport>>;
  refreshServer(name: string): Promise<McpResult<McpConnectReport>>;
  disconnectServer(name: string): Promise<McpResult<{ name: string }>>;

  // ── Reads ──────────────────────────────────────────────────────────────────
  listServers(): McpServerView[];
  serverView(name: string): McpServerView | undefined;
  /** KAI's registered tool ids for one server (from the ONE registry). */
  registeredToolIds(name: string): string[];
  /** Lightweight definitions of those tools, for a UI. */
  toolsFor(name: string): { id: string; name: string; risk: RiskLevel; description: string }[];
  listResources(name: string): Promise<McpResult<unknown[]>>;
  /**
   * Read one resource (`resources/read`). A READ like a tool call: guarded on
   * registration + connection, recorded in provenance, returned raw.
   */
  readResource(name: string, uri: string): Promise<McpResult<unknown>>;
  provenance(limit?: number): McpInvocationRecord[];
  summary(): McpSummary;
  managementTools(): { registered: string[]; refused: { name: string; reason: string }[] };

  // ── Invocation ─────────────────────────────────────────────────────────────
  /** Invoke a discovered tool through KAI's policy/approval boundary. */
  invokeTool(input: McpInvocationInput): Promise<McpResult<McpInvocationOutcome>>;
  /**
   * Invoke a tool DIRECTLY on a live connection, without re-entering the
   * registry. Reachable only from `capability.mcp`'s execute, which is already
   * inside the boundary (validated, policy-checked, approval-gated) — the same
   * rule the workspace capability ops follow. A DESTRUCTIVE tool is refused
   * here: `capability.mcp` is EXTERNAL, and an EXTERNAL gate must never be
   * spent on a DESTRUCTIVE action.
   */
  callToolDirect(input: McpInvocationInput): Promise<unknown>;

  /** Dispose every connection. Idempotent; no orphan processes. */
  dispose(): Promise<void>;
}

// ── Persistence ───────────────────────────────────────────────────────────────

interface PersistedState {
  version: 1;
  servers: Record<string, Record<string, unknown>>;
}

/**
 * The persistable form of a stored server: the raw shape `McpRegistry` parses
 * on the way back in, plus the enabled flag. Secrets ride along (the launcher
 * needs them after a restart); the file is written 0600 and lives under the
 * Core data dir.
 */
function persistable(record: McpServerRecord): Record<string, unknown> {
  const entry: Record<string, unknown> = { enabled: record.enabled };
  if (record.server.transport === "stdio") {
    entry.command = record.server.command;
    entry.args = [...record.server.args];
    entry.env = { ...record.server.env };
  } else {
    entry.transport = record.server.transport;
    entry.url = record.server.url;
    entry.headers = { ...record.server.headers };
  }
  if (record.server.risk !== undefined) entry.risk = record.server.risk;
  return entry;
}

function readPersisted(path: string): { state: PersistedState | null; problem: string | null } {
  if (!existsSync(path)) return { state: null, problem: null };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return { state: null, problem: "persisted MCP catalogue is not an object" };
    }
    const servers = (parsed as { servers?: unknown }).servers;
    if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
      return { state: null, problem: "persisted MCP catalogue has no servers map" };
    }
    return { state: { version: 1, servers: servers as Record<string, Record<string, unknown>> }, problem: null };
  } catch (error) {
    return { state: null, problem: `persisted MCP catalogue could not be read: ${error instanceof Error ? error.message : String(error)}` };
  }
}

// ── Small guards ──────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nameInput(raw: unknown): { ok: true; name: string } | { ok: false; reason: string } {
  if (!isRecord(raw) || typeof raw.name !== "string" || raw.name.trim().length === 0) {
    return { ok: false, reason: 'input must be an object with a non-empty "name"' };
  }
  return { ok: true, name: raw.name };
}

/** `{name, ...entry}` — the management tools' register/update input. */
function entryInput(raw: unknown): { ok: true; name: string; entry: Record<string, unknown> } | { ok: false; reason: string } {
  if (!isRecord(raw)) return { ok: false, reason: "input must be an object with a server name and entry fields" };
  if (typeof raw.name !== "string" || raw.name.trim().length === 0) {
    return { ok: false, reason: 'input must carry a non-empty "name"' };
  }
  const { name: _name, ...entry } = raw;
  if (Object.keys(entry).length === 0) {
    return { ok: false, reason: "input must carry the server entry fields (command/args/env or url/headers)" };
  }
  return { ok: true, name: raw.name, entry };
}

function toolNameOf(raw: unknown): string {
  if (isRecord(raw) && typeof raw.name === "string" && raw.name.length > 0) return raw.name;
  return "<unnamed>";
}

// ── The manager ───────────────────────────────────────────────────────────────

export function createMcpManager(deps: McpManagerDeps): McpManager {
  const now = deps.now ?? (() => new Date());
  const spawn: McpSpawn = deps.spawn ?? spawnMcpClient;
  const registry = deps.registry ?? createMcpRegistry({
    now,
    ...(deps.secretResolver !== undefined ? { secretResolver: deps.secretResolver } : {}),
  });
  const tools = deps.tools;
  const maxProvenance = deps.maxProvenance ?? 200;

  const connections = new Map<string, McpConnection>();
  const provenanceRecords: McpInvocationRecord[] = [];
  const management = { registered: [] as string[], refused: [] as { name: string; reason: string }[] };
  let executionSeq = 0;
  let persistenceProblem: string | null = null;

  // ── Persistence ─────────────────────────────────────────────────────────────

  function saveState(): void {
    const path = deps.persistPath;
    if (path === undefined) return;
    const state: PersistedState = { version: 1, servers: {} };
    for (const listing of registry.list()) {
      const record = registry.get(listing.name);
      if (record !== undefined) state.servers[listing.name] = persistable(record);
    }
    try {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
      renameSync(tmp, path);
    } catch (error) {
      persistenceProblem = `MCP catalogue could not be saved: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  if (deps.persistPath !== undefined) {
    const { state, problem } = readPersisted(deps.persistPath);
    persistenceProblem = problem;
    if (state !== null) {
      // loadConfig parses each entry as a CREATE and honours an explicit
      // `enabled: true`; a malformed entry is rejected as a value and skipped,
      // never a crash and never a partial install.
      const report = registry.loadConfig(state.servers);
      if (report.rejected.length > 0) {
        persistenceProblem = `persisted MCP catalogue had ${report.rejected.length} rejected entr(ies): ${report.rejected
          .map((r) => `${r.name}: ${r.error}`)
          .join("; ")}`;
      }
    }
  }

  // ── Provenance ──────────────────────────────────────────────────────────────

  function recordProvenance(record: McpInvocationRecord): void {
    provenanceRecords.unshift(record);
    if (provenanceRecords.length > maxProvenance) provenanceRecords.length = maxProvenance;
    if (deps.record !== undefined) {
      try {
        deps.record(record);
      } catch {
        // A provenance sink must never be able to veto or crash an invocation;
        // the ring above already holds the record.
      }
    }
  }

  function baseRecord(input: McpInvocationInput, executionId: string): McpInvocationRecord {
    const startedAt = now().toISOString();
    const record: McpInvocationRecord = {
      executionId,
      toolId: mcpToolId(input.server, input.tool),
      server: input.server,
      tool: input.tool,
      source: input.source ?? "mcp",
      arguments: input.arguments ?? {},
      status: "FAILED",
      startedAt,
      durationMs: 0,
    };
    if (input.sessionId !== undefined) record.sessionId = input.sessionId;
    if (input.agentId !== undefined) record.agentId = input.agentId;
    if (input.approvalId !== undefined) record.approvalId = input.approvalId;
    if (input.missionId !== undefined) record.missionId = input.missionId;
    if (input.stepId !== undefined) record.stepId = input.stepId;
    if (input.turnId !== undefined) record.turnId = input.turnId;
    return record;
  }

  function finishRecord(
    record: McpInvocationRecord,
    status: McpInvocationStatus,
    startedMs: number,
    outcome: { result?: unknown; error?: KaiError } = {},
  ): void {
    record.status = status;
    record.durationMs = Math.max(0, now().getTime() - startedMs);
    if (outcome.result !== undefined) record.result = outcome.result;
    if (outcome.error !== undefined) record.error = { code: outcome.error.code, message: outcome.error.message };
    // Finishing a record IS recording it. Every attempt path ends by calling
    // this exactly once, so putting the push here (rather than at each return
    // site) makes "every attempt gets exactly one provenance record" structural
    // rather than a convention five call sites have to remember.
    recordProvenance(record);
  }

  function statusOfError(error: KaiError): McpInvocationStatus {
    switch (error.code) {
      case "APPROVAL_REQUIRED":
        return "APPROVAL_REQUIRED";
      case "POLICY_DENIED":
        return "DENIED";
      case "VALIDATION_FAILED":
        return "INVALID";
      case "NOT_FOUND":
        return "NOT_FOUND";
      default:
        return "FAILED";
    }
  }

  // ── Catalogue operations ────────────────────────────────────────────────────

  function registerServer(name: unknown, entry: unknown): McpResult<McpServerListing> {
    const result = registry.register(name, entry);
    if (result.ok) saveState();
    return result;
  }

  function updateServer(name: string, entry: unknown): McpResult<McpServerListing> {
    const result = registry.update(name, entry);
    if (result.ok) saveState();
    return result;
  }

  function removeServer(name: string): McpResult<{ name: string }> {
    const result = registry.remove(name);
    if (!result.ok) return result;
    // Drop any live connection: a removed server must stop running immediately,
    // not linger as an orphan the catalogue no longer knows about.
    const connection = connections.get(name);
    if (connection !== undefined) {
      connections.delete(name);
      void connection.client.dispose();
    }
    saveState();
    return result;
  }

  function enableServer(name: string): McpResult<McpServerListing> {
    const result = registry.enable(name);
    if (result.ok) saveState();
    return result;
  }

  function disableServer(name: string): McpResult<McpServerListing> {
    const result = registry.disable(name);
    if (!result.ok) return result;
    // A disabled server must not keep running.
    const connection = connections.get(name);
    if (connection !== undefined) {
      connections.delete(name);
      void connection.client.dispose();
    }
    saveState();
    return result;
  }

  // ── Connection ──────────────────────────────────────────────────────────────

  function serverInfoView(info: McpServerInfo | undefined): { name?: string; version?: string; protocolVersion?: string } {
    if (info === undefined) return {};
    const view: { name?: string; version?: string; protocolVersion?: string } = {};
    if (info.name !== undefined) view.name = info.name;
    if (info.version !== undefined) view.version = info.version;
    if (info.protocolVersion !== undefined) view.protocolVersion = info.protocolVersion;
    return view;
  }

  /** Register discovered tools into the ONE registry with a KAI-declared risk. */
  function wireDiscovered(
    server: string,
    client: RealMcpClient,
    discovered: unknown[],
    risk: McpRiskDeclaration | undefined,
  ): { registered: string[]; refused: { name: string; error: KaiError }[]; tools: McpDiscoveredTool[] } {
    const entries = discovered.map((raw) => ({
      tool: raw,
      call: async (args: unknown) => {
        // Unwrap the client's McpResult: a failure must THROW so the registry
        // records FAILED, not EXECUTED-with-a-failure-value. The MCP error code
        // rides in the message so provenance and logs keep it.
        const result = await client.callTool(toolNameOf(raw), args);
        if (!result.ok) {
          throw new Error(`MCP tool "${toolNameOf(raw)}" failed (${result.error.code}): ${result.error.message}`);
        }
        return result.value;
      },
    }));
    const report = wireMcpTools(tools, {
      server,
      ...(risk !== undefined ? { risk } : {}),
      tools: entries,
      now,
    });
    const toolsList: McpDiscoveredTool[] = [];
    for (const raw of discovered) {
      if (isRecord(raw) && typeof raw.name === "string") toolsList.push({ name: raw.name });
    }
    return { registered: report.registered, refused: report.refused, tools: toolsList };
  }

  async function connectServer(name: string): Promise<McpResult<McpConnectReport>> {
    const record = registry.get(name);
    if (record === undefined) {
      return fail(mcpError("NOT_FOUND", `no MCP server named "${name}" is registered`, now));
    }
    if (!record.enabled) {
      return fail(
        mcpError(
          "POLICY_DENIED",
          `MCP server "${name}" is disabled; enable it before connecting (a server is inert until a human enables it)`,
          now,
        ),
      );
    }
    const existing = connections.get(name);
    if (existing !== undefined) {
      // Idempotent: connecting an already-connected server reports the live state.
      return ok({
        server: name,
        serverInfo: serverInfoView(existing.serverInfo),
        registered: [...existing.registeredIds],
        refused: existing.refused,
        toolCount: existing.registeredIds.length,
      });
    }
    if (record.server.transport !== "stdio") {
      return fail(
        mcpError(
          "AGENT_NOT_LISTENING",
          `MCP server "${name}" is a ${record.server.transport} endpoint; this build implements the stdio transport only, so a remote server cannot be connected yet`,
          now,
        ),
      );
    }

    const credentials = registry.credentialsFor(name);
    if (!credentials.ok) return credentials;
    const env = "env" in credentials.value ? credentials.value.env : {};

    const client = spawn({
      command: record.server.command,
      args: [...record.server.args],
      env,
      requestTimeoutMs: deps.requestTimeoutMs ?? 10_000,
      handshakeTimeoutMs: deps.handshakeTimeoutMs ?? 10_000,
      now,
    });

    const initialized = await client.initialize();
    if (!initialized.ok) {
      await client.dispose();
      return initialized;
    }
    const listed = await client.listTools();
    if (!listed.ok) {
      await client.dispose();
      return listed;
    }

    const wired = wireDiscovered(name, client, listed.value, record.server.risk);
    const connection: McpConnection = {
      client,
      serverInfo: initialized.value,
      tools: wired.tools,
      registeredIds: wired.registered,
      refused: wired.refused,
      connectedAt: now().toISOString(),
      resourceCount: null,
    };
    connections.set(name, connection);
    return ok({
      server: name,
      serverInfo: serverInfoView(initialized.value),
      registered: [...wired.registered],
      refused: wired.refused,
      toolCount: wired.registered.length,
    });
  }

  async function refreshServer(name: string): Promise<McpResult<McpConnectReport>> {
    const connection = connections.get(name);
    if (connection === undefined) {
      return fail(
        mcpError("NOT_FOUND", `MCP server "${name}" is not connected; connect it before refreshing its tools`, now),
      );
    }
    const record = registry.get(name);
    if (record === undefined) {
      return fail(mcpError("NOT_FOUND", `no MCP server named "${name}" is registered`, now));
    }
    const listed = await connection.client.listTools();
    if (!listed.ok) return listed;
    const wired = wireDiscovered(name, connection.client, listed.value, record.server.risk);
    // Refresh only ever ADDS tools: an id already registered is reported refused
    // ("already registered"), which is the registry's own duplicate guard, not an
    // error to paper over.
    const merged = [...new Set([...connection.registeredIds, ...wired.registered])];
    const refreshed: McpConnection = {
      ...connection,
      tools: wired.tools,
      registeredIds: merged,
      refused: wired.refused,
    };
    connections.set(name, refreshed);
    return ok({
      server: name,
      serverInfo: serverInfoView(connection.serverInfo),
      registered: [...wired.registered],
      refused: wired.refused,
      toolCount: merged.length,
    });
  }

  async function disconnectServer(name: string): Promise<McpResult<{ name: string }>> {
    if (registry.get(name) === undefined) {
      return fail(mcpError("NOT_FOUND", `no MCP server named "${name}" is registered`, now));
    }
    const connection = connections.get(name);
    if (connection === undefined) return ok({ name });
    connections.delete(name);
    await connection.client.dispose();
    return ok({ name });
  }

  // ── Reads ───────────────────────────────────────────────────────────────────

  function registeredToolIds(name: string): string[] {
    const prefix = `mcp.${name}.`;
    return tools
      .list()
      .map((tool) => tool.id)
      .filter((id) => id.startsWith(prefix));
  }

  function toolsFor(name: string): { id: string; name: string; risk: RiskLevel; description: string }[] {
    const prefix = `mcp.${name}.`;
    return tools
      .list()
      .filter((tool) => tool.id.startsWith(prefix))
      .map((tool) => ({ id: tool.id, name: tool.name, risk: tool.risk, description: tool.description }));
  }

  function listServers(): McpServerView[] {
    return registry.list().map((listing) => {
      const connection = connections.get(listing.name);
      const ids = registeredToolIds(listing.name);
      const view: McpServerView = {
        ...listing,
        connected: connection !== undefined,
        toolCount: ids.length,
        resourceCount: connection?.resourceCount ?? null,
      };
      const credentials = registry.credentialReport(listing.name);
      if (credentials.ok) view.credentials = credentials.value;
      if (connection !== undefined) view.serverInfo = serverInfoView(connection.serverInfo);
      return view;
    });
  }

  function serverView(name: string): McpServerView | undefined {
    return listServers().find((view) => view.name === name);
  }

  async function listResources(name: string): Promise<McpResult<unknown[]>> {
    const connection = connections.get(name);
    if (connection === undefined) {
      return fail(
        mcpError("NOT_FOUND", `MCP server "${name}" is not connected; connect it before listing resources`, now),
      );
    }
    const listed = await connection.client.listResources();
    if (!listed.ok) return listed;
    connections.set(name, { ...connection, resourceCount: listed.value.length });
    return listed;
  }

  function provenance(limit?: number): McpInvocationRecord[] {
    const capped = limit !== undefined && Number.isFinite(limit) && limit >= 0 ? Math.floor(limit) : provenanceRecords.length;
    return provenanceRecords.slice(0, capped);
  }

  function summary(): McpSummary {
    const servers = registry.list();
    const ids = new Set<string>();
    let resources = 0;
    for (const listing of servers) {
      for (const id of registeredToolIds(listing.name)) ids.add(id);
      const connection = connections.get(listing.name);
      if (connection?.resourceCount != null) resources += connection.resourceCount;
    }
    return {
      servers: servers.length,
      enabled: registry.enabledNames().length,
      connected: connections.size,
      tools: ids.size,
      resources,
      persistence: { path: deps.persistPath ?? null, problem: persistenceProblem },
      management: { registered: [...management.registered], refused: [...management.refused] },
    };
  }

  // ── Invocation ──────────────────────────────────────────────────────────────

  function nextExecutionId(): string {
    return `mcp_${now().getTime().toString(36)}_${(executionSeq++).toString(36)}`;
  }

  async function readResource(name: string, uri: string): Promise<McpResult<unknown>> {
    const startedMs = now().getTime();
    const executionId = nextExecutionId();
    const record = baseRecord({ server: name, tool: "resources/read", arguments: { uri } }, executionId);
    if (registry.get(name) === undefined) {
      const error = mcpError("NOT_FOUND", `no MCP server named "${name}" is registered`, now);
      finishRecord(record, "NOT_FOUND", startedMs, { error });
      return fail(error);
    }
    const connection = connections.get(name);
    if (connection === undefined) {
      const error = mcpError(
        "AGENT_NOT_LISTENING",
        `MCP server "${name}" is not connected; connect it before reading its resources`,
        now,
      );
      finishRecord(record, "NOT_FOUND", startedMs, { error });
      return fail(error);
    }
    const read = await connection.client.readResource(uri);
    if (!read.ok) {
      finishRecord(record, statusOfError(read.error), startedMs, { error: read.error });
      return fail(read.error);
    }
    finishRecord(record, "EXECUTED", startedMs, { result: read.value });
    return ok(read.value);
  }

  async function invokeTool(input: McpInvocationInput): Promise<McpResult<McpInvocationOutcome>> {
    const startedMs = now().getTime();
    const executionId = nextExecutionId();
    const record = baseRecord(input, executionId);
    const toolId = record.toolId;

    if (registry.get(input.server) === undefined) {
      const error = mcpError("NOT_FOUND", `no MCP server named "${input.server}" is registered`, now);
      finishRecord(record, "NOT_FOUND", startedMs, { error });
      return fail(error);
    }
    if (connections.get(input.server) === undefined) {
      const error = mcpError(
        "AGENT_NOT_LISTENING",
        `MCP server "${input.server}" is not connected; connect it before invoking its tools`,
        now,
      );
      finishRecord(record, "NOT_FOUND", startedMs, { error });
      return fail(error);
    }
    if (tools.get(toolId) === undefined) {
      const error = mcpError(
        "NOT_FOUND",
        `MCP tool "${toolId}" is not registered (it was never discovered, or it was refused for having no KAI-declared risk)`,
        now,
      );
      finishRecord(record, "NOT_FOUND", startedMs, { error });
      return fail(error);
    }

    const invoked = await tools.invoke(toolId, input.arguments ?? {}, {
      ...(input.approvalId !== undefined ? { approvalId: input.approvalId } : {}),
      ...(input.missionId !== undefined ? { missionId: input.missionId } : {}),
      ...(input.stepId !== undefined ? { stepId: input.stepId } : {}),
      ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
    });

    if (invoked.ok) {
      finishRecord(record, "EXECUTED", startedMs, { result: invoked.result });
      const outcome: McpInvocationOutcome = { toolId, executionId, result: invoked.result };
      if (input.approvalId !== undefined) outcome.approvalId = input.approvalId;
      return ok(outcome);
    }

    const error = invoked.error;
    // The registry hands back the approval id in `detail` when it just created
    // one; record it so the ledger answers "which approval was this parked on?".
    if (error.code === "APPROVAL_REQUIRED" && input.approvalId === undefined && typeof error.detail === "string") {
      record.approvalId = error.detail;
    }
    finishRecord(record, statusOfError(error), startedMs, { error });
    return fail(error);
  }

  async function callToolDirect(input: McpInvocationInput): Promise<unknown> {
    const startedMs = now().getTime();
    const executionId = nextExecutionId();
    const record = baseRecord({ ...input, source: input.source ?? "capability.mcp" }, executionId);
    const toolId = record.toolId;

    const definition = tools.get(toolId);
    if (definition === undefined) {
      const error = mcpError("NOT_FOUND", `MCP tool "${toolId}" is not registered`, now);
      finishRecord(record, "NOT_FOUND", startedMs, { error });
      throw new Error(error.message);
    }
    if (definition.risk === "DESTRUCTIVE") {
      const error = mcpError(
        "POLICY_DENIED",
        `MCP tool "${toolId}" is DESTRUCTIVE and cannot run through capability.mcp (an EXTERNAL gate must never be spent on a DESTRUCTIVE action); invoke it by its own tool id so its own risk gates it`,
        now,
      );
      finishRecord(record, "DENIED", startedMs, { error });
      throw new Error(error.message);
    }
    const connection = connections.get(input.server);
    if (connection === undefined) {
      const error = mcpError("AGENT_NOT_LISTENING", `MCP server "${input.server}" is not connected`, now);
      finishRecord(record, "NOT_FOUND", startedMs, { error });
      throw new Error(error.message);
    }

    const result = await connection.client.callTool(input.tool, input.arguments ?? {});
    if (!result.ok) {
      finishRecord(record, statusOfError(result.error), startedMs, { error: result.error });
      throw new Error(result.error.message);
    }
    finishRecord(record, "EXECUTED", startedMs, { result: result.value });
    return result.value;
  }

  // ── Management tools ────────────────────────────────────────────────────────

  function managementToolDefinitions(): ToolDefinition[] {
    const objectInput = (raw: unknown) => {
      if (raw === undefined || raw === null) return { ok: true as const, value: {} as Record<string, unknown> };
      if (!isRecord(raw)) return { ok: false as const, reason: "input must be an object" };
      return { ok: true as const, value: raw };
    };

    const definitions: ToolDefinition[] = [
      {
        id: MCP_MANAGEMENT_TOOL_IDS.register,
        name: "Register an MCP server",
        description:
          "Add an MCP server to KAI's catalogue. The server lands DISABLED and inert; a human must enable and connect it before any of its tools can run. Risk is KAI's declaration: an MCP server's own annotations are never trusted.",
        risk: "WRITE",
        validate(raw) {
          const parsed = entryInput(raw);
          if (!parsed.ok) return { ok: false, reason: parsed.reason };
          // Dry-run the parse against a throwaway catalogue: a malformed entry is
          // refused HERE, before policy, exactly like any other bad input. The
          // live duplicate check still happens in execute (that needs real state).
          const probe = createMcpRegistry({ now });
          const probed = probe.register(parsed.name, parsed.entry);
          if (!probed.ok) return { ok: false, reason: probed.error.message };
          return { ok: true, value: { name: parsed.name, entry: parsed.entry } };
        },
        async execute(input) {
          const { name, entry } = input as { name: string; entry: Record<string, unknown> };
          return registerServer(name, entry);
        },
      },
      {
        id: MCP_MANAGEMENT_TOOL_IDS.update,
        name: "Update an MCP server",
        description:
          "Edit an MCP server's entry. Enabled state and untouched secrets are preserved; a secret may be re-sent as `true` to keep the saved value.",
        risk: "WRITE",
        validate(raw) {
          const parsed = entryInput(raw);
          if (!parsed.ok) return { ok: false, reason: parsed.reason };
          return { ok: true, value: { name: parsed.name, entry: parsed.entry } };
        },
        async execute(input) {
          const { name, entry } = input as { name: string; entry: Record<string, unknown> };
          return updateServer(name, entry);
        },
      },
      {
        id: MCP_MANAGEMENT_TOOL_IDS.enable,
        name: "Enable an MCP server",
        description: "Allow KAI to start this MCP server. Enabling does not connect it; connecting is a separate, separately-approved step.",
        risk: "WRITE",
        validate(raw) {
          const parsed = nameInput(raw);
          if (!parsed.ok) return { ok: false, reason: parsed.reason };
          return { ok: true, value: { name: parsed.name } };
        },
        async execute(input) {
          return enableServer((input as { name: string }).name);
        },
      },
      {
        id: MCP_MANAGEMENT_TOOL_IDS.disable,
        name: "Disable an MCP server",
        description: "Stop KAI from starting this MCP server and disconnect it if it is running.",
        risk: "WRITE",
        validate(raw) {
          const parsed = nameInput(raw);
          if (!parsed.ok) return { ok: false, reason: parsed.reason };
          return { ok: true, value: { name: parsed.name } };
        },
        async execute(input) {
          return disableServer((input as { name: string }).name);
        },
      },
      {
        id: MCP_MANAGEMENT_TOOL_IDS.remove,
        name: "Remove an MCP server",
        description: "Remove an MCP server from KAI's catalogue and disconnect it. Its tools stop being resolvable.",
        risk: "WRITE",
        validate(raw) {
          const parsed = nameInput(raw);
          if (!parsed.ok) return { ok: false, reason: parsed.reason };
          return { ok: true, value: { name: parsed.name } };
        },
        async execute(input) {
          return removeServer((input as { name: string }).name);
        },
      },
      {
        id: MCP_MANAGEMENT_TOOL_IDS.connect,
        name: "Connect an MCP server",
        description:
          "Start the MCP server process, perform the MCP handshake, discover its tools and register them into KAI's tool registry with KAI-declared risk. EXTERNAL: it runs third-party code with KAI's authority, so the default policy parks it for a human.",
        risk: "EXTERNAL",
        validate(raw) {
          const parsed = nameInput(raw);
          if (!parsed.ok) return { ok: false, reason: parsed.reason };
          return { ok: true, value: { name: parsed.name } };
        },
        async execute(input) {
          return connectServer((input as { name: string }).name);
        },
      },
      {
        id: MCP_MANAGEMENT_TOOL_IDS.disconnect,
        name: "Disconnect an MCP server",
        description: "Stop a connected MCP server process. Its registered tools remain but refuse until it is connected again.",
        risk: "WRITE",
        validate(raw) {
          const parsed = nameInput(raw);
          if (!parsed.ok) return { ok: false, reason: parsed.reason };
          return { ok: true, value: { name: parsed.name } };
        },
        async execute(input) {
          return disconnectServer((input as { name: string }).name);
        },
      },
      {
        id: MCP_MANAGEMENT_TOOL_IDS.refresh,
        name: "Refresh an MCP server's tools",
        description: "Ask a connected MCP server for its current tool list and register any tools KAI did not already know.",
        risk: "WRITE",
        validate(raw) {
          const parsed = nameInput(raw);
          if (!parsed.ok) return { ok: false, reason: parsed.reason };
          return { ok: true, value: { name: parsed.name } };
        },
        async execute(input) {
          return refreshServer((input as { name: string }).name);
        },
      },
    ];
    return definitions;
  }

  function installManagementTools(): void {
    for (const definition of managementToolDefinitions()) {
      try {
        tools.register(definition);
        management.registered.push(definition.id);
      } catch (error) {
        // The registry refuses duplicates by throwing (it must). Here a duplicate
        // means the tool is already installed — reported, not fatal.
        management.refused.push({
          name: definition.id,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  installManagementTools();

  async function dispose(): Promise<void> {
    const open = [...connections.values()];
    connections.clear();
    await Promise.all(open.map((connection) => connection.client.dispose().catch(() => undefined)));
  }

  return {
    servers: registry,
    tools,
    registerServer,
    updateServer,
    removeServer,
    enableServer,
    disableServer,
    connectServer,
    refreshServer,
    disconnectServer,
    listServers,
    serverView,
    registeredToolIds,
    toolsFor,
    listResources,
    readResource,
    provenance,
    summary,
    managementTools: () => ({ registered: [...management.registered], refused: [...management.refused] }),
    invokeTool,
    callToolDirect,
    dispose,
  };
}
