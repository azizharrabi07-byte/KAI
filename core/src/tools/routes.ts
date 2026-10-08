// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The tool route surface — `registerToolRoutes(app, deps)` / `createToolApi(deps)`.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The tool registry is the boundary, but until now nothing HTTP-facing could
 * LIST it or run one tool by id: a UI/planner had no way to see the registered
 * tool set, its declared risk and its input contract, and there was no generic
 * invoke seam. This module is that route seam, deliberately NOT an edit to
 * `core/src/api/routes.ts` (the integration stream owns that file and wires
 * this with one line):
 *
 *     registerToolRoutes({ route: (m, p, c, h) => routeDefs.push(route(m, p, c, h)) },
 *                        { tools: runtime.tools });
 *
 * `createToolApi(deps)` is the same surface in the house pure-function style
 * (`{ handle(request), routes() }`, exactly like `CoreApi` and `createMcpApi`),
 * for an integration that prefers to merge a handler instead of a route table.
 * Both build the SAME route list; `registerToolRoutes` is `createToolApi` + a
 * host adapter.
 *
 * WHAT IT SERVES
 * --------------
 *   GET  /tools                 every registered tool, described (declared facts only)
 *   GET  /tools/:id             one tool, described; 404 when no such id
 *   POST /tools/:id/invoke      run ONE tool through the ONE boundary
 *
 * CLASSIFICATION
 * --------------
 *   GET  /tools            READ      — reads the registry, executes nothing
 *   GET  /tools/:id        READ      — reads the registry, executes nothing
 *   POST /tools/:id/invoke EXTERNAL  — runs an action; what it CAUSES is whatever
 *                                      the tool is (a shell command, a worker
 *                                      task). The route is classified by what it
 *                                      actually does, per the `/capabilities/:id/test`
 *                                      convention: invoking can cause another
 *                                      process to act, so the route is EXTERNAL
 *                                      and the tool's own risk gates the run
 *                                      INSIDE the registry (validate -> policy ->
 *                                      (approval) -> execute). There is no second
 *                                      policy path in this file.
 *
 * A tool that parks answers `409 { approvalRequired, approvalId }`, the caller
 * retries the SAME request with `approvalId`, and only then does anything
 * happen — the same shape `/capabilities/:id/test` and `/mcp/...` use. The
 * response carries the full `ToolInvocation` on success AND on refusal, so the
 * caller never has to re-ask the bus what happened.
 */

import type { KaiError } from "../shared/contracts.ts";
import type { ToolRegistry, ToolInvokeOptions } from "./registry.ts";
import { describeTool, type ToolInvocation } from "./types.ts";

// ── The request/response shape (mirrors core/src/api/routes.ts) ───────────────

export interface ToolApiRequest {
  /** "GET" | "POST". */
  method: string;
  /** "/tools/system.get_status" — already stripped of any query string. */
  path: string;
  /** Parsed JSON body, or undefined. Untrusted. */
  body?: unknown;
  query?: URLSearchParams;
}

export interface ToolApiResponse {
  status: number;
  body: unknown;
}

export type ToolRouteClassification = "READ" | "WRITE" | "EXTERNAL" | "DESTRUCTIVE";

export type ToolRouteHandler = (
  request: ToolApiRequest,
  params: Record<string, string>,
) => Promise<ToolApiResponse>;

export interface ToolRouteDef {
  method: string;
  pattern: string;
  classification: ToolRouteClassification;
  segments: string[];
  handler: ToolRouteHandler;
}

// ── Deps / results ────────────────────────────────────────────────────────────

export interface ToolRouteDeps {
  /** KAI's ONE tool registry. The routes serve whatever is registered on it. */
  tools: ToolRegistry;
}

export interface ToolApi {
  /** Pure request -> response. No sockets, so it is testable directly. */
  handle(request: ToolApiRequest): Promise<ToolApiResponse>;
  /** Paths this module serves, for the parent to mount and for docs. */
  routes(): string[];
}

export interface ToolRouteRegistration {
  patterns: string[];
  api: ToolApi;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function ok(body: unknown, status = 200): ToolApiResponse {
  return { status, body };
}

function bad(reason: string): ToolApiResponse {
  return { status: 400, body: { error: true, reason } };
}

function forbidden(reason: string): ToolApiResponse {
  return { status: 403, body: { error: true, reason } };
}

function notFound(reason: string): ToolApiResponse {
  return { status: 404, body: { error: true, reason } };
}

/**
 * Map a typed refusal to the same HTTP shapes the rest of the API uses. The
 * refusal's full `ToolInvocation` rides along so a caller that was refused can
 * still join the attempt to its bus record — a refusal is as traceable as a
 * success.
 */
function failureResponse(failed: { error: KaiError; invocation: ToolInvocation }): ToolApiResponse {
  const { error } = failed;
  switch (error.code) {
    case "APPROVAL_REQUIRED":
      return {
        status: 409,
        body: {
          error: true,
          reason: error.message,
          approvalRequired: true,
          approvalId: error.detail ?? null,
          invocation: failed.invocation,
        },
      };
    case "POLICY_DENIED":
      return { status: 403, body: { error: true, reason: error.message, invocation: failed.invocation } };
    case "NOT_FOUND":
      return { status: 404, body: { error: true, reason: error.message, invocation: failed.invocation } };
    case "VALIDATION_FAILED":
      return { status: 400, body: { error: true, reason: error.message, invocation: failed.invocation } };
    default:
      return {
        status: 500,
        body: { error: true, reason: error.message, code: error.code, invocation: failed.invocation },
      };
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Read an optional non-empty string field, refusing a present-but-wrong type. */
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
  defs: ToolRouteDef[];
  handle(request: ToolApiRequest): Promise<ToolApiResponse>;
}

function buildRoutes(deps: ToolRouteDeps): BuiltRoutes {
  const tools = deps.tools;

  // ── GET /tools ──────────────────────────────────────────────────────────────
  function listTools(): ToolApiResponse {
    const descriptions = tools.list().map((tool) => describeTool(tool));
    return ok({
      service: "tools",
      count: descriptions.length,
      tools: descriptions,
      note:
        "Declared facts only: `permission.sideEffecting` is derived from the tool's EFFECT " +
        "(risk !== READ || effectful), and a tool that declares no schema reports `declared: false` " +
        "with the reason rather than an invented shape. Running a tool is POST /tools/:id/invoke, " +
        "which goes through the ONE boundary (validate -> policy -> (approval) -> execute).",
    });
  }

  // ── POST /tools/:id/invoke ──────────────────────────────────────────────────
  async function invokeTool(request: ToolApiRequest, params: Record<string, string>): Promise<ToolApiResponse> {
    const id = params.id ?? "";
    const raw = request.body;
    if (raw !== undefined && asRecord(raw) === null) {
      return bad('"body" must be a JSON object when present');
    }
    const body = asRecord(raw) ?? {};

    const approvalId = optionalString(body, "approvalId");
    if (!approvalId.ok) return bad(approvalId.reason);
    const missionId = optionalString(body, "missionId");
    if (!missionId.ok) return bad(missionId.reason);
    const stepId = optionalString(body, "stepId");
    if (!stepId.ok) return bad(stepId.reason);
    const scheduleId = optionalString(body, "scheduleId");
    if (!scheduleId.ok) return bad(scheduleId.reason);
    const turnId = optionalString(body, "turnId");
    if (!turnId.ok) return bad(turnId.reason);
    const sessionId = optionalString(body, "sessionId");
    if (!sessionId.ok) return bad(sessionId.reason);
    const agentId = optionalString(body, "agentId");
    if (!agentId.ok) return bad(agentId.reason);
    const source = optionalString(body, "source");
    if (!source.ok) return bad(source.reason);
    const executionId = optionalString(body, "executionId");
    if (!executionId.ok) return bad(executionId.reason);

    const input = body.input !== undefined ? body.input : {};
    const opts: ToolInvokeOptions = {
      ...(missionId.value !== undefined ? { missionId: missionId.value } : {}),
      ...(stepId.value !== undefined ? { stepId: stepId.value } : {}),
      ...(scheduleId.value !== undefined ? { scheduleId: scheduleId.value } : {}),
      ...(turnId.value !== undefined ? { turnId: turnId.value } : {}),
      ...(approvalId.value !== undefined ? { approvalId: approvalId.value } : {}),
      ...(sessionId.value !== undefined ? { sessionId: sessionId.value } : {}),
      ...(agentId.value !== undefined ? { agentId: agentId.value } : {}),
      ...(source.value !== undefined ? { source: source.value } : {}),
      ...(executionId.value !== undefined ? { executionId: executionId.value } : {}),
    };

    const invoked = await tools.invoke(
      id,
      input,
      Object.keys(opts).length > 0 ? opts : undefined,
    );
    if (!invoked.ok) return failureResponse(invoked);
    return ok({
      toolId: id,
      status: invoked.invocation.status,
      invocationId: invoked.invocation.invocationId,
      ...(invoked.invocation.executionId !== undefined ? { executionId: invoked.invocation.executionId } : {}),
      result: invoked.result,
      invocation: invoked.invocation,
    });
  }

  // ── The table ───────────────────────────────────────────────────────────────
  const defs: ToolRouteDef[] = [
    route("GET", "/tools", "READ", async () => listTools()),
    route("GET", "/tools/:id", "READ", async (_request, params) => {
      const id = params.id ?? "";
      const tool = tools.get(id);
      if (tool === undefined) return notFound(`no tool is registered with id "${id}"`);
      return ok({ tool: describeTool(tool) });
    }),
    // EXTERNAL, per the /capabilities/:id/test convention: invoking a tool can
    // cause another process to act. The tool's own declared risk gates the run
    // inside the registry; this classification describes the ROUTE.
    route("POST", "/tools/:id/invoke", "EXTERNAL", (request, params) => invokeTool(request, params)),
  ];

  function match(method: string, path: string): { def: ToolRouteDef; params: Record<string, string> } | null {
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

  async function handle(request: ToolApiRequest): Promise<ToolApiResponse> {
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

  return { defs, handle };
}

function route(
  method: string,
  pattern: string,
  classification: ToolRouteClassification,
  handler: ToolRouteHandler,
): ToolRouteDef {
  return { method, pattern, classification, segments: pattern.split("/").filter((s) => s.length > 0), handler };
}

// ── The two exported seams ────────────────────────────────────────────────────

/**
 * The house-style pure-function API: `{ handle(request), routes() }`, exactly
 * the shape `core/src/api/routes.ts` exposes as `CoreApi` and `createMcpApi`
 * exposes for MCP. A caller that owns the route table can merge this handler
 * directly.
 */
export function createToolApi(deps: ToolRouteDeps): ToolApi {
  const built = buildRoutes(deps);
  return {
    handle: built.handle,
    routes: () => built.defs.map((def) => `${def.method} ${def.pattern}`),
  };
}

/**
 * What a host must accept for `registerToolRoutes` to register into it:
 *
 *   - an object with `route(method, pattern, classification, handler)` — the
 *     exact shape of the `route(...)` helper in `core/src/api/routes.ts`; or
 *   - a bare function with the same signature.
 *
 * Anything else is a wiring error and throws at startup — a route table that
 * silently accepts nothing would leave `/tools` at 404 while looking wired.
 */
export type ToolRouteHost =
  | {
      route(
        method: string,
        pattern: string,
        classification: ToolRouteClassification,
        handler: ToolRouteHandler,
      ): void;
    }
  | ((
      method: string,
      pattern: string,
      classification: ToolRouteClassification,
      handler: ToolRouteHandler,
    ) => void);

type RouteSink = (
  method: string,
  pattern: string,
  classification: ToolRouteClassification,
  handler: ToolRouteHandler,
) => void;

function routeSink(app: ToolRouteHost): RouteSink {
  if (typeof app === "function") return app;
  if (typeof app === "object" && app !== null && typeof (app as { route?: unknown }).route === "function") {
    const host = app as { route: RouteSink };
    return (method, pattern, classification, handler) => host.route(method, pattern, classification, handler);
  }
  throw new Error(
    "registerToolRoutes: `app` must be a function (method, pattern, classification, handler) or an object " +
      "with a `route` method of that shape",
  );
}

/**
 * Register the tool route surface into a host, and return the pieces the caller
 * needs (`patterns` and the pure `api`).
 *
 * The exact one-line call for `core/src/api/routes.ts` (integration stream):
 *
 *     registerToolRoutes({ route: (m, p, c, h) => routeDefs.push(route(m, p, c, h)) },
 *                        { tools: runtime.tools });
 */
export function registerToolRoutes(app: ToolRouteHost, deps: ToolRouteDeps): ToolRouteRegistration {
  const built = buildRoutes(deps);
  const sink = routeSink(app);
  for (const def of built.defs) sink(def.method, def.pattern, def.classification, def.handler);
  const api: ToolApi = {
    handle: built.handle,
    routes: () => built.defs.map((def) => `${def.method} ${def.pattern}`),
  };
  return { patterns: api.routes(), api };
}
