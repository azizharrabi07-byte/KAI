// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The MCP route surface — `registerMcpRoutes(app, deps)`.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `GET /mcp` returning 404 was the specific symptom of MCP not being wired:
 * the capability existed as code, with no route and no caller. This module is
 * the route seam. It is deliberately NOT an edit to `core/src/api/routes.ts`
 * (the integration stream owns that file and wires this with one line):
 *
 *     registerMcpRoutes({ register: (method, pattern, handler, classification) =>
 *       routeDefs.push(route(method, pattern, classification ?? "EXTERNAL", handler)) },
 *       { manager: runtime.mcp });
 *
 * `createMcpApi(deps)` is the same surface in the house pure-function style
 * (`{ handle(request), routes() }`, exactly like `CoreApi`), for an integration
 * that prefers to merge a handler instead of a route table. Both build the SAME
 * route list; `registerMcpRoutes` is `createMcpApi` + a host adapter.
 *
 * WHAT IT SERVES
 * --------------
 *   GET  /mcp                                  the capability, measured live
 *   GET  /mcp/servers                          the catalogue (secrets never)
 *   POST /mcp/servers                          register (parked: WRITE)
 *   GET  /mcp/servers/:name                    one server + live state
 *   POST /mcp/servers/:name                    update (parked: WRITE)
 *   GET  /mcp/servers/:name/tools              KAI-registered tools for it
 *   GET  /mcp/servers/:name/resources          resources/list on the live conn
 *   POST /mcp/servers/:name/enable             (parked: WRITE)
 *   POST /mcp/servers/:name/disable            (parked: WRITE)
 *   POST /mcp/servers/:name/remove             (parked: WRITE)
 *   POST /mcp/servers/:name/connect            (parked: EXTERNAL)
 *   POST /mcp/servers/:name/disconnect         (parked: WRITE)
 *   POST /mcp/servers/:name/refresh            (parked: WRITE)
 *   POST /mcp/servers/:name/call               invoke a tool (its OWN risk gates)
 *   GET  /mcp/provenance                       the invocation ledger
 *
 * EVERY mutation goes through `runtime.tools.invoke(...)` — the management
 * operations as `mcp.register`/`mcp.connect`/… tools, the invocation as the
 * discovered tool's own id (`mcp.<server>.<tool>`). A parked action answers
 * `409 { approvalRequired, approvalId }`, the caller retries with `approvalId`,
 * and only then does anything happen — the same shape `/capabilities/:id/test`
 * and `/memory/share` use. There is no second policy path in this file.
 */

import type { KaiError } from "../shared/contracts.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import { mcpCapabilityHealth } from "./capability.ts";
import {
  createMcpManager,
  MCP_MANAGEMENT_TOOL_IDS,
  type McpManager,
  type McpProvenanceSink,
  type McpSpawn,
} from "./manager.ts";
import { validateServerName } from "./validation.ts";

// ── The request/response shape (mirrors core/src/api/routes.ts) ───────────────

export interface McpApiRequest {
  /** "GET" | "POST". */
  method: string;
  /** "/mcp/servers/foo/connect" — already stripped of any query string. */
  path: string;
  /** Parsed JSON body, or undefined. Untrusted. */
  body?: unknown;
  query?: URLSearchParams;
}

export interface McpApiResponse {
  status: number;
  body: unknown;
}

export type McpRouteClassification = "READ" | "WRITE" | "EXTERNAL";

export type McpRouteHandler = (
  request: McpApiRequest,
  params: Record<string, string>,
) => Promise<McpApiResponse>;

export interface McpRouteDef {
  method: string;
  pattern: string;
  classification: McpRouteClassification;
  segments: string[];
  handler: McpRouteHandler;
}

// ── Deps / results ────────────────────────────────────────────────────────────

export interface McpRouteDeps {
  /**
   * KAI's ONE tool registry. Required unless a `manager` is provided; the
   * manager registers the management tools and every discovered tool here.
   */
  tools?: ToolRegistry;
  /**
   * Reuse an existing manager. Pass THE runtime's manager so KAI has exactly
   * one MCP universe; omitted → one is created over `tools`.
   */
  manager?: McpManager;
  /** Optional provenance sink (called for every MCP tool invocation). */
  record?: McpProvenanceSink;
  /** Transport factory override (tests). */
  spawn?: McpSpawn;
  now?: () => Date;
  /** Persist the server catalogue here (see manager.ts). */
  persistPath?: string;
  requestTimeoutMs?: number;
  handshakeTimeoutMs?: number;
}

export interface McpApi {
  /** Pure request -> response. No sockets, so it is testable directly. */
  handle(request: McpApiRequest): Promise<McpApiResponse>;
  /** Paths this module serves, for the parent to mount and for docs. */
  routes(): string[];
}

export interface McpApiWithManager extends McpApi {
  /** The manager behind the routes, so the caller can wire the capability seam. */
  manager: McpManager;
}

export interface McpRouteRegistration {
  patterns: string[];
  manager: McpManager;
  api: McpApiWithManager;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function ok(body: unknown, status = 200): McpApiResponse {
  return { status, body };
}

function bad(reason: string): McpApiResponse {
  return { status: 400, body: { error: true, reason } };
}

function notFound(reason: string): McpApiResponse {
  return { status: 404, body: { error: true, reason } };
}

function forbidden(reason: string): McpApiResponse {
  return { status: 403, body: { error: true, reason } };
}

/** Map a typed refusal to the same HTTP shapes the rest of the API uses. */
function failureResponse(error: Pick<KaiError, "code" | "message"> & { detail?: string }): McpApiResponse {
  switch (error.code) {
    case "APPROVAL_REQUIRED":
      return {
        status: 409,
        body: {
          error: true,
          reason: error.message,
          approvalRequired: true,
          approvalId: error.detail ?? null,
        },
      };
    case "POLICY_DENIED":
      return forbidden(error.message);
    case "NOT_FOUND":
      return notFound(error.message);
    case "VALIDATION_FAILED":
      return bad(error.message);
    case "AGENT_NOT_LISTENING":
    case "AGENT_TIMEOUT":
    case "AGENT_BAD_RESPONSE":
    case "AGENT_RUN_FAILED":
    case "AGENT_AUTH_FAILED":
      return { status: 502, body: { error: true, reason: error.message, code: error.code } };
    default:
      return { status: 500, body: { error: true, reason: error.message, code: error.code } };
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Read an optional string field, refusing a present-but-wrong type. */
function optionalString(
  body: Record<string, unknown>,
  key: string,
): { ok: true; value: string | undefined } | { ok: false; reason: string } {
  const raw = body[key];
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: false, reason: `"${key}" must be a non-empty string when present` };
  }
  return { ok: true, value: raw };
}

// ── The routes ────────────────────────────────────────────────────────────────

interface BuiltRoutes {
  defs: McpRouteDef[];
  manager: McpManager;
  handle(request: McpApiRequest): Promise<McpApiResponse>;
}

function buildRoutes(deps: McpRouteDeps): BuiltRoutes {
  const manager =
    deps.manager ??
    createMcpManager({
      tools: requireTools(deps),
      ...(deps.record !== undefined ? { record: deps.record } : {}),
      ...(deps.spawn !== undefined ? { spawn: deps.spawn } : {}),
      ...(deps.now !== undefined ? { now: deps.now } : {}),
      ...(deps.persistPath !== undefined ? { persistPath: deps.persistPath } : {}),
      ...(deps.requestTimeoutMs !== undefined ? { requestTimeoutMs: deps.requestTimeoutMs } : {}),
      ...(deps.handshakeTimeoutMs !== undefined ? { handshakeTimeoutMs: deps.handshakeTimeoutMs } : {}),
    });
  const tools = deps.tools ?? manager.tools;

  // ── GET /mcp ────────────────────────────────────────────────────────────────
  async function summary(): Promise<McpApiResponse> {
    const measured = manager.summary();
    return ok({
      service: "mcp",
      capability: { id: "mcp", ...mcpCapabilityHealth(manager) },
      counts: {
        servers: measured.servers,
        enabled: measured.enabled,
        connected: measured.connected,
        tools: measured.tools,
        resources: measured.resources,
      },
      servers: manager.listServers(),
      managementTools: measured.management,
      persistence: measured.persistence,
      provenance: { recorded: manager.provenance().length },
      note:
        "MCP servers are KAI-owned capabilities. Every MCP tool is registered into KAI's one tool registry " +
        "(validate -> policy -> (approval) -> execute); every invocation is recorded in the MCP provenance ledger. " +
        "A management call that parks answers 409 with an approvalId; retry the same request with it once a human decides.",
    });
  }

  // ── Management calls, through the ONE boundary ──────────────────────────────
  async function invokeManagement(
    toolId: string,
    input: Record<string, unknown>,
    approvalId: string | undefined,
  ): Promise<McpApiResponse> {
    const invoked = await tools.invoke(toolId, input, approvalId !== undefined ? { approvalId } : undefined);
    if (!invoked.ok) return failureResponse(invoked.error);
    // The management tools return the catalogue's McpResult as their VALUE, so a
    // refusal inside the operation (duplicate name, malformed entry) is read
    // here and mapped by code, exactly like /memory/share reads its share result.
    const value = asRecord(invoked.result);
    if (value !== null && value.ok === false && asRecord(value.error) !== null) {
      return failureResponse(value.error as unknown as Pick<KaiError, "code" | "message"> & { detail?: string });
    }
    if (value !== null && value.ok === true) return ok({ result: value.value });
    return ok({ result: invoked.result });
  }

  function approvalIdOf(body: Record<string, unknown>): { ok: true; value: string | undefined } | { ok: false; reason: string } {
    return optionalString(body, "approvalId");
  }

  // ── POST /mcp/servers ───────────────────────────────────────────────────────
  async function registerServerHandler(request: McpApiRequest): Promise<McpApiResponse> {
    const body = asRecord(request.body);
    if (body === null) return bad('"body" must be a JSON object carrying the server entry (with a "name")');
    const nameCheck = validateServerName(body.name);
    if (!nameCheck.ok) return bad(nameCheck.error.message);
    const approval = approvalIdOf(body);
    if (!approval.ok) return bad(approval.reason);
    const { approvalId: _approvalId, ...entry } = body;
    return invokeManagement(MCP_MANAGEMENT_TOOL_IDS.register, entry, approval.value);
  }

  async function updateServerHandler(request: McpApiRequest, params: Record<string, string>): Promise<McpApiResponse> {
    const name = params.name ?? "";
    const body = asRecord(request.body);
    if (body === null) return bad('"body" must be a JSON object carrying the updated entry fields');
    const approval = approvalIdOf(body);
    if (!approval.ok) return bad(approval.reason);
    const { approvalId: _approvalId, ...entry } = body;
    return invokeManagement(MCP_MANAGEMENT_TOOL_IDS.update, { name, ...entry }, approval.value);
  }

  async function namedAction(
    request: McpApiRequest,
    params: Record<string, string>,
    toolId: string,
  ): Promise<McpApiResponse> {
    const name = params.name ?? "";
    if (name.length === 0) return bad('"name" must be a non-empty server name');
    const body = asRecord(request.body) ?? {};
    const approval = approvalIdOf(body);
    if (!approval.ok) return bad(approval.reason);
    return invokeManagement(toolId, { name }, approval.value);
  }

  // ── POST /mcp/servers/:name/call ────────────────────────────────────────────
  async function callToolHandler(request: McpApiRequest, params: Record<string, string>): Promise<McpApiResponse> {
    const server = params.name ?? "";
    const body = asRecord(request.body);
    if (body === null) return bad('"body" must be a JSON object with a "tool" name');
    if (typeof body.tool !== "string" || body.tool.trim().length === 0) {
      return bad('"tool" must be a non-empty string (the server-local tool name)');
    }
    if (body.arguments !== undefined && asRecord(body.arguments) === null) {
      return bad('"arguments" must be a JSON object when present');
    }
    const approval = approvalIdOf(body);
    if (!approval.ok) return bad(approval.reason);
    const session = optionalString(body, "sessionId");
    if (!session.ok) return bad(session.reason);
    const agent = optionalString(body, "agentId");
    if (!agent.ok) return bad(agent.reason);
    const source = optionalString(body, "source");
    if (!source.ok) return bad(source.reason);

    const invoked = await manager.invokeTool({
      server,
      tool: body.tool,
      ...(body.arguments !== undefined ? { arguments: body.arguments } : {}),
      ...(approval.value !== undefined ? { approvalId: approval.value } : {}),
      ...(session.value !== undefined ? { sessionId: session.value } : {}),
      ...(agent.value !== undefined ? { agentId: agent.value } : {}),
      ...(source.value !== undefined ? { source: source.value } : {}),
    });
    if (!invoked.ok) return failureResponse(invoked.error);
    return ok({
      server,
      tool: body.tool,
      toolId: invoked.value.toolId,
      executionId: invoked.value.executionId,
      result: invoked.value.result,
    });
  }

  // ── The table ───────────────────────────────────────────────────────────────
  const defs: McpRouteDef[] = [
    route("GET", "/mcp", "READ", () => summary()),
    route("GET", "/mcp/servers", "READ", async () => ok({ servers: manager.listServers() })),
    route("POST", "/mcp/servers", "WRITE", (request) => registerServerHandler(request)),
    route("GET", "/mcp/servers/:name", "READ", (_request, params) => {
      const view = manager.serverView(params.name ?? "");
      if (view === undefined) return Promise.resolve(notFound(`no MCP server named "${params.name ?? ""}" is registered`));
      return Promise.resolve(ok({ server: view }));
    }),
    route("POST", "/mcp/servers/:name", "WRITE", (request, params) => updateServerHandler(request, params)),
    route("GET", "/mcp/servers/:name/tools", "READ", (_request, params) => {
      const name = params.name ?? "";
      const view = manager.serverView(name);
      if (view === undefined) return Promise.resolve(notFound(`no MCP server named "${name}" is registered`));
      return Promise.resolve(ok({ server: name, connected: view.connected, tools: manager.toolsFor(name) }));
    }),
    route("GET", "/mcp/servers/:name/resources", "READ", async (_request, params) => {
      const name = params.name ?? "";
      const listed = await manager.listResources(name);
      if (!listed.ok) return failureResponse(listed.error);
      return ok({ server: name, resources: listed.value });
    }),
    route("GET", "/mcp/servers/:name/resources/read", "READ", async (request, params) => {
      const name = params.name ?? "";
      const uri = request.query?.get("uri") ?? "";
      if (uri.length === 0 || uri.length > 2048) {
        return bad('"uri" query must be a non-empty resource URI');
      }
      const read = await manager.readResource(name, uri);
      if (!read.ok) return failureResponse(read.error);
      return ok({ server: name, uri, resource: read.value });
    }),
    route("POST", "/mcp/servers/:name/enable", "WRITE", (request, params) =>
      namedAction(request, params, MCP_MANAGEMENT_TOOL_IDS.enable),
    ),
    route("POST", "/mcp/servers/:name/disable", "WRITE", (request, params) =>
      namedAction(request, params, MCP_MANAGEMENT_TOOL_IDS.disable),
    ),
    route("POST", "/mcp/servers/:name/remove", "WRITE", (request, params) =>
      namedAction(request, params, MCP_MANAGEMENT_TOOL_IDS.remove),
    ),
    route("POST", "/mcp/servers/:name/connect", "EXTERNAL", (request, params) =>
      namedAction(request, params, MCP_MANAGEMENT_TOOL_IDS.connect),
    ),
    route("POST", "/mcp/servers/:name/disconnect", "WRITE", (request, params) =>
      namedAction(request, params, MCP_MANAGEMENT_TOOL_IDS.disconnect),
    ),
    route("POST", "/mcp/servers/:name/refresh", "WRITE", (request, params) =>
      namedAction(request, params, MCP_MANAGEMENT_TOOL_IDS.refresh),
    ),
    route("POST", "/mcp/servers/:name/call", "EXTERNAL", (request, params) => callToolHandler(request, params)),
    route("GET", "/mcp/provenance", "READ", (request) => {
      const raw = request.query?.get("limit") ?? null;
      let limit: number | undefined;
      if (raw !== null) {
        const parsed = Number(raw);
        if (!Number.isInteger(parsed) || parsed < 0) return Promise.resolve(bad('"limit" must be a non-negative integer'));
        limit = parsed;
      }
      return Promise.resolve(ok({ records: manager.provenance(limit) }));
    }),
  ];

  function match(method: string, path: string): { def: McpRouteDef; params: Record<string, string> } | null {
    const segs = path.split("/").filter((s) => s.length > 0);
    for (const def of defs) {
      if (def.method !== method) continue;
      if (def.segments.length !== segs.length) continue;
      const params: Record<string, string> = {};
      let matched = true;
      for (let i = 0; i < segs.length; i += 1) {
        const pattern = def.segments[i];
        const actual = segs[i];
        if (pattern === undefined || actual === undefined) {
          matched = false;
          break;
        }
        if (pattern.startsWith(":")) params[pattern.slice(1)] = decodeURIComponent(actual);
        else if (pattern !== actual) {
          matched = false;
          break;
        }
      }
      if (matched) return { def, params };
    }
    return null;
  }

  async function handle(request: McpApiRequest): Promise<McpApiResponse> {
    const method = typeof request.method === "string" ? request.method.toUpperCase() : "";
    const rawPath = typeof request.path === "string" ? request.path : "/";
    const path = rawPath.split("?")[0] ?? "/";
    const hit = match(method, path);
    if (hit === null) {
      // "not one of mine": the integrator mounts this BEHIND the existing API, so
      // a 404 must fall through to the routes that already existed.
      return notFound(`no route for ${method || "(no method)"} ${path}`);
    }
    try {
      return await hit.def.handler(request, hit.params);
    } catch {
      return { status: 500, body: { error: true, reason: `internal error while handling ${method} ${path}` } };
    }
  }

  return { defs, manager, handle };
}

function route(
  method: string,
  pattern: string,
  classification: McpRouteClassification,
  handler: McpRouteHandler,
): McpRouteDef {
  return { method, pattern, classification, segments: pattern.split("/").filter((s) => s.length > 0), handler };
}

function requireTools(deps: McpRouteDeps): ToolRegistry {
  if (deps.tools === undefined) {
    throw new Error("createMcpApi/registerMcpRoutes requires { manager } or { tools }: there is no tool registry to register MCP tools into");
  }
  return deps.tools;
}

// ── The two exported seams ────────────────────────────────────────────────────

/**
 * The house-style pure-function API: `{ handle(request), routes() }`, exactly
 * the shape `core/src/api/routes.ts` exposes as `CoreApi`. A caller that owns
 * the route table can merge this handler directly.
 */
export function createMcpApi(deps: McpRouteDeps): McpApiWithManager {
  const built = buildRoutes(deps);
  return {
    handle: built.handle,
    routes: () => built.defs.map((def) => `${def.method} ${def.pattern}`),
    manager: built.manager,
  };
}

/** What a host must accept for `registerMcpRoutes` to register into it. */
type RouteSink = (
  method: string,
  pattern: string,
  handler: McpRouteHandler,
  classification: McpRouteClassification,
) => void;

/**
 * Find the route-registration capability of `app`, tolerating the shapes an
 * integrator plausibly holds:
 *
 *   - a bare function `(method, pattern, handler, classification) => void`;
 *   - an object with `register` / `route` / `addRoute` / `add`;
 *   - an express-like object with `get` and `post`.
 *
 * Everything else is a wiring error and throws at startup — a route table that
 * silently accepts nothing would leave `/mcp` at 404 while looking wired.
 */
function routeSink(app: unknown): RouteSink {
  if (typeof app === "function") {
    const fn = app as (method: string, pattern: string, handler: McpRouteHandler, classification: string) => void;
    return (method, pattern, handler, classification) => fn(method, pattern, handler, classification);
  }
  if (typeof app === "object" && app !== null) {
    const record = app as Record<string, unknown>;
    for (const key of ["register", "route", "addRoute", "add"] as const) {
      const candidate = record[key];
      if (typeof candidate === "function") {
        const fn = candidate as (m: string, p: string, h: McpRouteHandler, c: string) => void;
        return (method, pattern, handler, classification) =>
          fn.call(app, method, pattern, handler, classification);
      }
    }
    const get = record.get;
    const post = record.post;
    if (typeof get === "function" && typeof post === "function") {
      return (method, pattern, handler) => {
        if (method === "GET") (get as (p: string, h: McpRouteHandler) => void).call(app, pattern, handler);
        else if (method === "POST") (post as (p: string, h: McpRouteHandler) => void).call(app, pattern, handler);
        else throw new Error(`registerMcpRoutes: the host has no way to register a ${method} route`);
      };
    }
  }
  throw new Error(
    "registerMcpRoutes: `app` must be a function (method, pattern, handler, classification) or an object with " +
      "register/route/addRoute/add, or get+post",
  );
}

/**
 * Register the MCP route surface into a host, and return the pieces the caller
 * needs (`patterns`, the ONE `manager`, and the pure `api`).
 *
 * The exact one-line call for `core/src/api/routes.ts` (integration stream):
 *
 *     registerMcpRoutes({ register: (m, p, h, c) => routeDefs.push(route(m, p, c ?? "EXTERNAL", h)) },
 *                       { manager: runtime.mcp, tools: runtime.tools });
 */
export function registerMcpRoutes(app: unknown, deps: McpRouteDeps = {}): McpRouteRegistration {
  const built = buildRoutes(deps);
  const sink = routeSink(app);
  for (const def of built.defs) sink(def.method, def.pattern, def.handler, def.classification);
  const api: McpApiWithManager = {
    handle: built.handle,
    routes: () => built.defs.map((def) => `${def.method} ${def.pattern}`),
    manager: built.manager,
  };
  return { patterns: api.routes(), manager: built.manager, api };
}
