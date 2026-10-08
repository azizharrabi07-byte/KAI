/**
 * The workspace's typed front-end to the Core routes the base client
 * (`core/kai-core.ts`) does not expose: `/tools*`, `/mcp*`, `/maintenance/*`,
 * `/prompts/compose` and `/actions`.
 *
 * WHY A SECOND CLIENT AND NOT MORE METHODS ON `CoreClient`
 * -------------------------------------------------------
 * `kai-core.ts` is the island's client and is shared by every island view; the
 * workspace adds a surface, not a second source of truth. Rather than widening
 * the island's interface (and the island stream's file) with five route
 * families only the workspace reads, this module holds them beside it. It shares
 * the SAME base URL and the SAME defensive transport contract as `kai-core.ts`:
 *
 *   - every method resolves to a `WorkspaceResult`; nothing ever rejects;
 *   - a request that outlives its timeout is genuinely aborted, and the timer is
 *     always cleared;
 *   - a 2xx whose body is not the expected JSON object is `INVALID_RESPONSE`,
 *     never a crash and never a silently-empty list;
 *   - the response body is never logged wholesale.
 *
 * It imports nothing Tauri-related and touches no global at import time, so it
 * runs in the Tauri webview, under `npm run dev`, and under `node --test` with
 * an injected `fetchImpl`.
 */

import { DEFAULT_CORE_BASE_URL, type CoreError, type CoreErrorCode, type CoreResult } from "../core/kai-core";
import type {
  ActionRecord,
  ComposedPromptView,
  MaintenanceCheck,
  MaintenanceIdentity,
  MaintenanceReport,
  MaintenanceRepair,
  McpCapabilityHealth,
  McpProvenanceRecord,
  McpServerSummary,
  McpServerTool,
  McpSummary,
  PromptSectionReport,
  ToolDescription,
  ToolInvokeOutcome,
  ToolPermission,
  ToolSchemaView,
} from "./types";

type JsonObject = Record<string, unknown>;

export interface WorkspaceRoutesOptions {
  baseUrl?: string;
  /** Injected for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout in ms. Default 5000. */
  timeoutMs?: number;
}

/** Retry options for invoking a tool that parked for approval. */
export interface InvokeOptions {
  /** The approval a human granted, so the SAME call proceeds. */
  approvalId?: string;
  /** Correlation ids the registry records on the invocation. */
  missionId?: string;
  stepId?: string;
  sessionId?: string;
  agentId?: string;
  turnId?: string;
  source?: string;
}

export interface McpCallInput {
  tool: string;
  arguments?: unknown;
  approvalId?: string;
  sessionId?: string;
  agentId?: string;
  source?: string;
}

/**
 * One management action on an MCP server. Each maps to a parked Core tool
 * (`mcp.enable`, `mcp.connect`, …): with no `approvalId` it parks and returns a
 * `409` whose `approvalId` the caller retries with.
 */
export type McpServerCommand =
  | "enable"
  | "disable"
  | "remove"
  | "connect"
  | "disconnect"
  | "refresh";

export interface WorkspaceRoutes {
  readonly baseUrl: string;
  /** `GET /tools` — every registered tool, described. */
  tools(): Promise<CoreResult<ToolDescription[]>>;
  /** `GET /tools/:id` — one tool, described. */
  tool(id: string): Promise<CoreResult<ToolDescription>>;
  /** `POST /tools/:id/invoke` — run one tool through the ONE boundary. */
  invokeTool(id: string, input: unknown, opts?: InvokeOptions): Promise<CoreResult<ToolInvokeOutcome>>;
  /** `GET /mcp` — the measured capability, live counts and the catalogue. */
  mcp(): Promise<CoreResult<McpSummary>>;
  /** `GET /mcp/servers` — the catalogue, secrets never. */
  mcpServers(): Promise<CoreResult<McpServerSummary[]>>;
  /** `GET /mcp/servers/:name` — one server plus its live state. */
  mcpServer(name: string): Promise<CoreResult<McpServerSummary>>;
  /** `POST /mcp/servers/:name/:command` — a parked management action. */
  mcpServerCommand(name: string, command: McpServerCommand, approvalId?: string): Promise<CoreResult<ToolInvokeOutcome>>;
  /** `POST /mcp/servers/:name/call` — invoke a discovered tool. */
  mcpCall(name: string, input: McpCallInput): Promise<CoreResult<ToolInvokeOutcome>>;
  /** `GET /mcp/servers/:name/tools` — the tools one server exposed. */
  mcpServerTools(name: string): Promise<CoreResult<McpServerTool[]>>;
  /** `GET /mcp/servers/:name/resources` — the resources one server lists. */
  mcpServerResources(name: string): Promise<CoreResult<unknown[]>>;
  /** `GET /mcp/servers/:name/resources` — the resources one server lists. */
  mcpServerResources(name: string): Promise<CoreResult<unknown[]>>;
  /** `GET /mcp/servers/:name/resources/read?uri=` — read one resource. */
  mcpReadResource(name: string, uri: string): Promise<CoreResult<unknown>>;
  /** `GET /mcp/provenance` — the invocation ledger, newest first. */
  mcpProvenance(limit?: number): Promise<CoreResult<McpProvenanceRecord[]>>;
  /** `GET /maintenance/status` — inspect only, never changes anything. */
  maintenance(): Promise<CoreResult<MaintenanceReport>>;
  /** `POST /maintenance/run` — the four repairs, behind the ONE boundary. */
  runMaintenance(approvalId?: string): Promise<CoreResult<MaintenanceReport>>;
  /** `POST /prompts/compose` — the exact system prompt a turn would send. Read-only. */
  composePrompt(request: string, scope?: string): Promise<CoreResult<ComposedPromptView>>;
  /** `GET /actions` — the persisted `action.executed` records. Read-only. */
  actions(limit?: number): Promise<CoreResult<ActionRecord[]>>;
}

// ── Defensive readers (same rules as kai-core.ts) ────────────────────────────

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function ok<T>(value: T): CoreResult<T> {
  return { ok: true, value };
}

function fail<T>(
  code: CoreErrorCode,
  message: string,
  status?: number,
  reason?: string,
  errorCode?: string,
): CoreResult<T> {
  const error: CoreError = { code, message };
  if (status !== undefined) error.status = status;
  if (reason !== undefined) error.reason = reason;
  if (errorCode !== undefined) error.errorCode = errorCode;
  return { ok: false, error };
}

function describeThrown(err: unknown): string {
  if (err instanceof Error && typeof err.message === "string" && err.message !== "") {
    return err.message.slice(0, 200);
  }
  return "unknown error";
}

function isAbortError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  return (err as { name?: unknown }).name === "AbortError";
}

function extractReason(bodyText: string): string | undefined {
  if (bodyText === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return undefined;
  }
  if (!isObject(parsed)) return undefined;
  return asString(parsed.reason) ?? asString(parsed.error);
}

function extractErrorCode(bodyText: string): string | undefined {
  if (bodyText === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return undefined;
  }
  return isObject(parsed) ? asString(parsed.code) : undefined;
}

async function readBodyText(res: Response): Promise<string> {
  try {
    if (typeof res.text !== "function") return "";
    return await res.text();
  } catch {
    return "";
  }
}

function parseJsonObject(bodyText: string): CoreResult<JsonObject> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return fail("INVALID_RESPONSE", "response body was not JSON");
  }
  if (!isObject(parsed)) return fail("INVALID_RESPONSE", "response body was not a JSON object");
  return ok(parsed);
}

// ── Entity parsers ──────────────────────────────────────────────────────────
// A record missing a REQUIRED field is dropped, never filled with a guess.

function parsePermission(raw: unknown): ToolPermission | null {
  if (!isObject(raw)) return null;
  const risk = asString(raw.risk);
  const effectful = asBoolean(raw.effectful);
  const sideEffecting = asBoolean(raw.sideEffecting);
  if (risk === undefined || effectful === undefined || sideEffecting === undefined) return null;
  return { risk, effectful, sideEffecting };
}

function parseSchemaView(raw: unknown): ToolSchemaView {
  if (isObject(raw) && raw.declared === true) return { declared: true, schema: raw.schema };
  if (isObject(raw) && raw.declared === false) {
    return { declared: false, reason: asString(raw.reason) ?? "no schema declared" };
  }
  return { declared: false, reason: "no schema declared" };
}

function parseTool(raw: unknown): ToolDescription | null {
  if (!isObject(raw)) return null;
  const id = asString(raw.id);
  const name = asString(raw.name);
  const description = asString(raw.description);
  const permission = parsePermission(raw.permission);
  if (id === undefined || name === undefined || description === undefined || permission === null) return null;
  return { id, name, description, permission, schema: parseSchemaView(raw.schema) };
}

function parseServer(raw: unknown): McpServerSummary | null {
  if (!isObject(raw)) return null;
  const name = asString(raw.name);
  const transport = asString(raw.transport);
  const enabled = asBoolean(raw.enabled);
  const hasRisk = asBoolean(raw.hasRisk);
  const connected = asBoolean(raw.connected);
  const toolCount = asNumber(raw.toolCount);
  if (
    name === undefined || transport === undefined || enabled === undefined ||
    hasRisk === undefined || connected === undefined || toolCount === undefined
  ) {
    return null;
  }
  const out: McpServerSummary = {
    name, transport, enabled, hasRisk, connected, toolCount,
    resourceCount: asNumber(raw.resourceCount) ?? null,
  };
  const command = asString(raw.command);
  if (command !== undefined) out.command = command;
  if (Array.isArray(raw.args)) {
    out.args = raw.args.filter((a): a is string => typeof a === "string");
  }
  if (Array.isArray(raw.envKeys)) {
    out.envKeys = raw.envKeys.filter((a): a is string => typeof a === "string");
  }
  const url = asString(raw.url);
  if (url !== undefined) out.url = url;
  if (Array.isArray(raw.headerKeys)) {
    out.headerKeys = raw.headerKeys.filter((a): a is string => typeof a === "string");
  }
  if (isObject(raw.serverInfo)) {
    const info: NonNullable<McpServerSummary["serverInfo"]> = {};
    const n = asString(raw.serverInfo.name);
    const v = asString(raw.serverInfo.version);
    const p = asString(raw.serverInfo.protocolVersion);
    if (n !== undefined) info.name = n;
    if (v !== undefined) info.version = v;
    if (p !== undefined) info.protocolVersion = p;
    out.serverInfo = info;
  }
  return out;
}

function parseCapability(raw: unknown): McpCapabilityHealth | null {
  if (!isObject(raw)) return null;
  const availability = asString(raw.availability);
  if (availability === undefined) return null;
  return { availability, detail: asString(raw.detail) ?? "" };
}

function parseProvenance(raw: unknown): McpProvenanceRecord | null {
  if (!isObject(raw)) return null;
  const executionId = asString(raw.executionId);
  const toolId = asString(raw.toolId);
  const server = asString(raw.server);
  const tool = asString(raw.tool);
  const source = asString(raw.source);
  const status = asString(raw.status);
  const startedAt = asString(raw.startedAt);
  if (
    executionId === undefined || toolId === undefined || server === undefined ||
    tool === undefined || source === undefined || status === undefined || startedAt === undefined
  ) {
    return null;
  }
  const out: McpProvenanceRecord = {
    executionId, toolId, server, tool, source, status, startedAt,
    durationMs: asNumber(raw.durationMs) ?? 0,
  };
  if (isObject(raw.error)) {
    const code = asString(raw.error.code);
    const message = asString(raw.error.message);
    if (code !== undefined && message !== undefined) out.error = { code, message };
  }
  return out;
}

function parseCheck(raw: unknown): MaintenanceCheck | null {
  if (!isObject(raw)) return null;
  const name = asString(raw.name);
  const status = asString(raw.status);
  const detail = asString(raw.detail);
  if (name === undefined || status === undefined || detail === undefined) return null;
  return { name, status, detail };
}

function parseRepair(raw: unknown): MaintenanceRepair | null {
  if (!isObject(raw)) return null;
  const name = asString(raw.name);
  const performed = asBoolean(raw.performed);
  const detail = asString(raw.detail);
  if (name === undefined || performed === undefined || detail === undefined) return null;
  return { name, performed, detail };
}

function parseIdentity(raw: unknown): MaintenanceIdentity | null {
  if (!isObject(raw)) return null;
  const buildId = asString(raw.buildId);
  const gitCommit = asString(raw.gitCommit);
  const protocolVersion = asNumber(raw.protocolVersion);
  const pid = asNumber(raw.pid);
  const current = asBoolean(raw.current);
  if (
    buildId === undefined || gitCommit === undefined || protocolVersion === undefined ||
    pid === undefined || current === undefined
  ) {
    return null;
  }
  const out: MaintenanceIdentity = {
    buildId, gitCommit, protocolVersion, pid, current,
    detail: asString(raw.detail) ?? "",
  };
  const onDisk = asString(raw.onDiskBuildId);
  if (onDisk !== undefined) out.onDiskBuildId = onDisk;
  return out;
}

function parseMaintenance(raw: unknown): MaintenanceReport | null {
  if (!isObject(raw)) return null;
  const okFlag = asBoolean(raw.ok);
  const checkedAt = asString(raw.checkedAt);
  const identity = parseIdentity(raw.identity);
  if (okFlag === undefined || checkedAt === undefined || identity === null) return null;
  const checks = Array.isArray(raw.checks)
    ? raw.checks.map(parseCheck).filter((c): c is MaintenanceCheck => c !== null)
    : [];
  const repairs = Array.isArray(raw.repairs)
    ? raw.repairs.map(parseRepair).filter((r): r is MaintenanceRepair => r !== null)
    : [];
  return { ok: okFlag, checkedAt, identity, checks, repairs };
}

function parseSection(raw: unknown): PromptSectionReport | null {
  if (!isObject(raw)) return null;
  const name = asString(raw.name);
  const band = asString(raw.band);
  const trust = asString(raw.trust);
  if (name === undefined || band === undefined || trust === undefined) return null;
  return {
    name, band, trust,
    chars: asNumber(raw.chars) ?? 0,
    bodyChars: asNumber(raw.bodyChars) ?? 0,
    budget: asNumber(raw.budget) ?? 0,
    truncated: asBoolean(raw.truncated) ?? false,
  };
}

function parseComposedPrompt(raw: unknown): ComposedPromptView | null {
  if (!isObject(raw)) return null;
  const text = asString(raw.text);
  const totalChars = asNumber(raw.totalChars);
  if (text === undefined || totalChars === undefined) return null;
  const sections = Array.isArray(raw.sections)
    ? raw.sections.map(parseSection).filter((s): s is PromptSectionReport => s !== null)
    : [];
  const problems = Array.isArray(raw.problems)
    ? raw.problems.filter((p): p is string => typeof p === "string")
    : [];
  const order = Array.isArray(raw.order)
    ? raw.order.filter((p): p is string => typeof p === "string")
    : [];
  return { text, sections, totalChars, problems, order };
}

function parseArray<T>(raw: unknown, parse: (item: unknown) => T | null): T[] {
  const out: T[] = [];
  if (!Array.isArray(raw)) return out;
  for (const item of raw) {
    const parsed = parse(item);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}

// ── The client ──────────────────────────────────────────────────────────────

export function createWorkspaceRoutes(options: WorkspaceRoutesOptions = {}): WorkspaceRoutes {
  const baseUrl = (options.baseUrl ?? DEFAULT_CORE_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? 5000;
  const injectedFetch = options.fetchImpl;

  function resolveFetch(): typeof fetch | undefined {
    if (typeof injectedFetch === "function") return injectedFetch;
    if (typeof fetch === "function") return fetch;
    return undefined;
  }

  function buildUrl(path: string, query?: Record<string, string | number | undefined>): string {
    let url = `${baseUrl}${path}`;
    if (query !== undefined) {
      const parts: string[] = [];
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined) continue;
        parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
      }
      if (parts.length > 0) url += `?${parts.join("&")}`;
    }
    return url;
  }

  /**
   * The single transport primitive, identical in contract to `kai-core.ts`'s.
   * A 409 is returned to the caller as a `REQUEST_FAILED` carrying `status`, so
   * `invokeTool` can detect the park and turn it into a typed outcome.
   */
  async function request(
    path: string,
    init: { method?: string; body?: unknown; query?: Record<string, string | number | undefined> } = {},
  ): Promise<CoreResult<JsonObject>> {
    const doFetch = resolveFetch();
    if (doFetch === undefined) return fail("CORE_OFFLINE", "no fetch implementation available");

    const url = buildUrl(path, init.query);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const requestInit: RequestInit = { method: init.method ?? "GET", signal: controller.signal };
      if (init.body !== undefined) {
        requestInit.body = JSON.stringify(init.body);
        requestInit.headers = { "content-type": "application/json" };
      }
      const res = await doFetch(url, requestInit);
      if (!res.ok) {
        const status = typeof res.status === "number" ? res.status : undefined;
        if (status === 401 || status === 403) {
          const bodyText = await readBodyText(res);
          return fail("AUTH_REQUIRED", "Core requires authentication", status, extractReason(bodyText), extractErrorCode(bodyText));
        }
        const bodyText = await readBodyText(res);
        const reason = extractReason(bodyText);
        const errorCode = extractErrorCode(bodyText);
        return fail(
          "REQUEST_FAILED",
          reason !== undefined ? `Core request failed: ${reason}` : "Core request failed",
          status,
          reason,
          errorCode,
        );
      }
      return parseJsonObject(await readBodyText(res));
    } catch (err) {
      if (controller.signal.aborted || isAbortError(err)) {
        return fail("TIMEOUT", `Core request timed out after ${timeoutMs}ms`);
      }
      if (err instanceof TypeError) return fail("CORE_OFFLINE", "Core is not reachable");
      return fail("UNKNOWN", describeThrown(err));
    } finally {
      clearTimeout(timer);
    }
  }

  /** Unwrap `{tool: …}` / `{server: …}` or accept the object directly. */
  function unwrap(value: JsonObject, key: string): JsonObject | null {
    const inner = value[key];
    if (isObject(inner)) return inner;
    return value;
  }

  /** Turn a request Core answered with "the action parked" into a typed outcome. */
  function parkOrFail(
    res: CoreResult<JsonObject>,
    toolId: string,
  ): CoreResult<ToolInvokeOutcome> {
    if (res.ok) {
      const v = res.value;
      const out: ToolInvokeOutcome = {
        toolId: asString(v.toolId) ?? toolId,
        status: asString(v.status) ?? "EXECUTED",
        approvalRequired: false,
      };
      const invocationId = asString(v.invocationId);
      if (invocationId !== undefined) out.invocationId = invocationId;
      const executionId = asString(v.executionId);
      if (executionId !== undefined) out.executionId = executionId;
      if (v.result !== undefined) out.result = v.result;
      return ok(out);
    }
    // A 409 is the parked outcome, not a fault: the tool is EXTERNAL or
    // DESTRUCTIVE and a human decision is required. Core's body already carries
    // `approvalRequired` and the `approvalId` to retry with.
    if (res.error.status === 409) {
      return ok({
        toolId,
        status: "APPROVAL_REQUIRED",
        approvalRequired: true,
        ...(res.error.reason !== undefined ? { reason: res.error.reason } : {}),
      });
    }
    return res;
  }

  return {
    baseUrl,

    async tools() {
      const res = await request("/tools");
      if (!res.ok) return res;
      const raw = res.value.tools;
      if (!Array.isArray(raw)) return fail("INVALID_RESPONSE", 'expected an array at "tools"');
      return ok(parseArray(raw, parseTool));
    },

    async tool(id) {
      const res = await request(`/tools/${encodeURIComponent(id)}`);
      if (!res.ok) return res;
      const parsed = parseTool(unwrap(res.value, "tool"));
      if (parsed === null) return fail("INVALID_RESPONSE", "tool response was not a tool");
      return ok(parsed);
    },

    async invokeTool(id, input, opts) {
      const body: JsonObject = { input: input ?? {} };
      if (opts?.approvalId !== undefined) body.approvalId = opts.approvalId;
      if (opts?.missionId !== undefined) body.missionId = opts.missionId;
      if (opts?.stepId !== undefined) body.stepId = opts.stepId;
      if (opts?.sessionId !== undefined) body.sessionId = opts.sessionId;
      if (opts?.agentId !== undefined) body.agentId = opts.agentId;
      if (opts?.turnId !== undefined) body.turnId = opts.turnId;
      if (opts?.source !== undefined) body.source = opts.source;
      const res = await request(`/tools/${encodeURIComponent(id)}/invoke`, { method: "POST", body });
      return parkOrFail(res, id);
    },

    async mcp() {
      const res = await request("/mcp");
      if (!res.ok) return res;
      const v = res.value;
      const capability = parseCapability(v.capability);
      if (capability === null) return fail("INVALID_RESPONSE", "mcp response had no capability");
      if (!isObject(v.counts)) return fail("INVALID_RESPONSE", 'mcp response had no "counts"');
      const counts = {
        servers: asNumber(v.counts.servers) ?? 0,
        enabled: asNumber(v.counts.enabled) ?? 0,
        connected: asNumber(v.counts.connected) ?? 0,
        tools: asNumber(v.counts.tools) ?? 0,
        resources: asNumber(v.counts.resources) ?? 0,
      };
      const servers = Array.isArray(v.servers)
        ? v.servers.map(parseServer).filter((s): s is McpServerSummary => s !== null)
        : [];
      const management = isObject(v.managementTools)
        ? {
            registered: Array.isArray(v.managementTools.registered)
              ? v.managementTools.registered.filter((r): r is string => typeof r === "string")
              : [],
            refused: Array.isArray(v.managementTools.refused)
              ? v.managementTools.refused
                  .map((r) => {
                    if (!isObject(r)) return null;
                    const name = asString(r.name);
                    const reason = asString(r.reason);
                    return name !== undefined && reason !== undefined ? { name, reason } : null;
                  })
                  .filter((r): r is { name: string; reason: string } => r !== null)
              : [],
          }
        : { registered: [], refused: [] };
      const persistence = isObject(v.persistence)
        ? { path: asString(v.persistence.path) ?? null, problem: asString(v.persistence.problem) ?? null }
        : { path: null, problem: null };
      const provenanceCount = isObject(v.provenance) ? (asNumber(v.provenance.recorded) ?? 0) : 0;
      return ok<McpSummary>({ capability, counts, servers, management, persistence, provenanceCount });
    },

    async mcpServers() {
      const res = await request("/mcp/servers");
      if (!res.ok) return res;
      const raw = res.value.servers;
      if (!Array.isArray(raw)) return fail("INVALID_RESPONSE", 'expected an array at "servers"');
      return ok(parseArray(raw, parseServer));
    },

    async mcpServer(name) {
      const res = await request(`/mcp/servers/${encodeURIComponent(name)}`);
      if (!res.ok) return res;
      const parsed = parseServer(res.value.server);
      if (parsed === null) return fail("INVALID_RESPONSE", "server response was not a server");
      return ok(parsed);
    },

    async mcpServerCommand(name, command, approvalId) {
      const body: JsonObject = {};
      if (approvalId !== undefined) body.approvalId = approvalId;
      const res = await request(`/mcp/servers/${encodeURIComponent(name)}/${command}`, { method: "POST", body });
      return parkOrFail(res, `mcp.${command}`);
    },

    async mcpCall(name, input) {
      const body: JsonObject = { tool: input.tool };
      if (input.arguments !== undefined) body.arguments = input.arguments;
      if (input.approvalId !== undefined) body.approvalId = input.approvalId;
      if (input.sessionId !== undefined) body.sessionId = input.sessionId;
      if (input.agentId !== undefined) body.agentId = input.agentId;
      if (input.source !== undefined) body.source = input.source;
      const res = await request(`/mcp/servers/${encodeURIComponent(name)}/call`, { method: "POST", body });
      if (res.ok) {
        const out: ToolInvokeOutcome = {
          toolId: asString(res.value.toolId) ?? `mcp.${name}.${input.tool}`,
          status: "EXECUTED",
          approvalRequired: false,
        };
        const executionId = asString(res.value.executionId);
        if (executionId !== undefined) out.executionId = executionId;
        if (res.value.result !== undefined) out.result = res.value.result;
        return ok(out);
      }
      return parkOrFail(res, `mcp.${name}.${input.tool}`);
    },

    async mcpServerTools(name) {
      const res = await request(`/mcp/servers/${encodeURIComponent(name)}/tools`);
      if (!res.ok) return res;
      const raw = res.value["tools"];
      if (!Array.isArray(raw)) return fail("INVALID_RESPONSE", 'expected an array at "tools"');
      const out: McpServerTool[] = [];
      for (const item of raw) {
        if (!isObject(item)) continue;
        const id = asString(item.id);
        const toolName = asString(item.name);
        const risk = asString(item.risk);
        const description = asString(item.description);
        if (id === undefined || toolName === undefined || risk === undefined || description === undefined) continue;
        out.push({ id, name: toolName, risk, description });
      }
      return ok(out);
    },

    async mcpServerResources(name) {
      const res = await request(`/mcp/servers/${encodeURIComponent(name)}/resources`);
      if (!res.ok) return res;
      const raw = res.value["resources"];
      if (!Array.isArray(raw)) return fail("INVALID_RESPONSE", 'expected an array at "resources"');
      return ok(raw);
    },

    async mcpReadResource(name, uri) {
      const res = await request(`/mcp/servers/${encodeURIComponent(name)}/resources/read`, {
        query: { uri },
      });
      if (!res.ok) return res;
      return ok(res.value["resource"]);
    },

    async mcpProvenance(limit) {
      const res = await request("/mcp/provenance", { query: { limit } });
      if (!res.ok) return res;
      const raw = res.value.records;
      if (!Array.isArray(raw)) return fail("INVALID_RESPONSE", 'expected an array at "records"');
      return ok(parseArray(raw, parseProvenance));
    },

    async maintenance() {
      const res = await request("/maintenance/status");
      if (!res.ok) return res;
      const parsed = parseMaintenance(res.value.maintenance);
      if (parsed === null) return fail("INVALID_RESPONSE", "maintenance response was not a report");
      return ok(parsed);
    },

    async runMaintenance(approvalId) {
      const body: JsonObject = {};
      if (approvalId !== undefined) body.approvalId = approvalId;
      const res = await request("/maintenance/run", { method: "POST", body });
      if (!res.ok) return res;
      const parsed = parseMaintenance(res.value.maintenance);
      if (parsed === null) return fail("INVALID_RESPONSE", "maintenance response was not a report");
      return ok(parsed);
    },

    async composePrompt(requestText, scope) {
      const body: JsonObject = { request: requestText };
      if (scope !== undefined) body.scope = scope;
      const res = await request("/prompts/compose", { method: "POST", body });
      if (!res.ok) return res;
      const parsed = parseComposedPrompt(res.value.prompt);
      if (parsed === null) return fail("INVALID_RESPONSE", "compose response was not a prompt");
      return ok(parsed);
    },

    async actions(limit) {
      const res = await request("/actions", { query: { limit } });
      if (!res.ok) return res;
      const raw = res.value.actions;
      if (!Array.isArray(raw)) return fail("INVALID_RESPONSE", 'expected an array at "actions"');
      return ok(raw.filter(isObject) as ActionRecord[]);
    },
  };
}
