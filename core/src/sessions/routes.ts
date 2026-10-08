// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The session route surface — `registerSessionRoutes(app, { runtime })`.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The session subsystem's HTTP reads (search / view / transcript) and its four
 * consequential mutations (duplicate / close / clear / delete) need a route
 * seam. It is deliberately NOT an edit to `core/src/api/routes.ts` (the
 * integration stream owns that file and wires this with one line):
 *
 *     if (coreApi !== null && core !== undefined) registerSessionRoutes(coreApi, { runtime: core });
 *
 * `registerSessionRoutes` does two things, both idempotently:
 *
 *   1. Registers the five session tools on `runtime.tools` via
 *      `registerSessionTools` — guarded on `registry.get(id) === undefined`,
 *      because `register()` throws on duplicates by design.
 *   2. WRAPS `app.handle` IN PLACE: a request that matches one of this module's
 *      routes is answered here; everything else falls through to the original
 *      handle, so the existing `/sessions*` surface is untouched. Wrapping in
 *      place is safe because `core/src/server.ts` calls `coreApi.handle(...)`
 *      by property access (server.ts:799) — the object is the seam, and the
 *      wrapper is marked so a second registration cannot double-wrap it.
 *
 * ROUTES
 * ------
 *   GET  /sessions/search              READ        find conversations (literal LIKE)
 *   GET  /sessions/:id/view            READ        the durable view: history + memory scope
 *   GET  /sessions/:id/transcript      READ        owner-checked, kind-checked transcript
 *   POST /sessions/:id/duplicate       WRITE       fork (copy gets its OWN worker conversation)
 *   POST /sessions/:id/close           WRITE       close (archive) + move the active pointer
 *   POST /sessions/:id/clear           DESTRUCTIVE remove every turn, reset counters
 *   POST /sessions/:id/delete          DESTRUCTIVE hard-delete the session and its turns
 *
 * POLICY
 * ------
 * There is no second policy path here: every mutation goes through
 * `runtime.tools.invoke`, so the registry's chain (validate -> policy ->
 * (approval) -> execute) decides. A park is answered `409
 * { approvalRequired, approvalId }`; the caller decides the approval (the
 * runtime re-issues the exact parked call on APPROVED — auto-reissue) or
 * retries the SAME request with `approvalId`. Refusals map like every other
 * boundary: POLICY_DENIED -> 403, NOT_FOUND -> 404, VALIDATION_FAILED -> 400.
 */

import type { ApiRequest, ApiResponse, CoreApi } from "../api/routes.ts";
import type { KaiError } from "../shared/contracts.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { ToolInvocation } from "../tools/types.ts";
import type { SessionService } from "./service.ts";
import { createSessionTranscriptRouter, type TranscriptInput, type TranscriptKind } from "./router.ts";
import { registerSessionTools, SESSION_TOOL_IDS } from "./tools.ts";

export interface SessionRouteDeps {
  /** Only the two faces this surface uses; `CoreRuntime` satisfies it structurally. */
  runtime: {
    sessions: SessionService;
    tools: ToolRegistry;
  };
}

export interface SessionRouteRegistration {
  /** The routes this module serves, for docs and for the integrator's log line. */
  patterns: string[];
  /** What the tool registration did — `skipped` on a second wiring. */
  tools: { registered: string[]; skipped: string[] };
}

type SessionRouteClassification = "READ" | "WRITE" | "DESTRUCTIVE";

interface SessionRouteDef {
  method: string;
  pattern: string;
  classification: SessionRouteClassification;
  segments: string[];
  handler: (req: ApiRequest, params: Record<string, string>) => Promise<ApiResponse>;
}

// ── Small helpers (the shapes the rest of the API uses) ───────────────────────

function ok(body: unknown, status = 200): ApiResponse {
  return { status, body };
}

function bad(reason: string): ApiResponse {
  return { status: 400, body: { error: true, reason } };
}

function notFound(reason: string): ApiResponse {
  return { status: 404, body: { error: true, reason } };
}

function forbidden(reason: string): ApiResponse {
  return { status: 403, body: { error: true, reason } };
}

function query(req: ApiRequest): URLSearchParams {
  return req.query instanceof URLSearchParams ? req.query : new URLSearchParams();
}

function parseLimit(raw: string | null): { ok: true; value: number | undefined } | { ok: false; reason: string } {
  if (raw === null || raw.length === 0) return { ok: true, value: undefined };
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    return { ok: false, reason: '"limit" must be a positive integer' };
  }
  return { ok: true, value };
}

/** The parsed body when it is an object; `{}` when absent; null when malformed. */
function asBodyObject(body: unknown): Record<string, unknown> | null {
  if (body === undefined) return {};
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  return body as Record<string, unknown>;
}

/** Body `approvalId`, when present and a non-empty string. */
function approvalIdOf(body: Record<string, unknown> | null): string | undefined {
  if (body === null) return undefined;
  const value = body.approvalId;
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/**
 * Map a registry refusal to the API's shapes — the same mapping every other
 * tool-backed surface uses. APPROVAL_REQUIRED keeps the EXACT documented body
 * (`approvalRequired` + `approvalId`); the full `ToolInvocation` rides along so
 * a refused caller can still join the attempt to its bus record.
 */
function failureResponse(failed: { error: KaiError; invocation: ToolInvocation }): ApiResponse {
  const { error } = failed;
  const invocation = failed.invocation;
  switch (error.code) {
    case "APPROVAL_REQUIRED":
      return {
        status: 409,
        body: {
          error: true,
          reason: error.message,
          approvalRequired: true,
          approvalId: invocation.approvalId ?? error.detail ?? null,
          invocation,
        },
      };
    case "POLICY_DENIED":
      return { status: 403, body: { error: true, reason: error.message, invocation } };
    case "NOT_FOUND":
      return { status: 404, body: { error: true, reason: error.message, invocation } };
    case "VALIDATION_FAILED":
      return { status: 400, body: { error: true, reason: error.message, invocation } };
    default:
      return {
        status: 500,
        body: { error: true, reason: error.message, code: error.code, invocation },
      };
  }
}

/** Map a service refusal (a value, not an exception) to its HTTP shape. */
function sessionFailure(out: { code: string; reason: string }): ApiResponse {
  if (out.code === "NOT_FOUND") return notFound(out.reason);
  if (out.code === "INVALID") return bad(out.reason);
  // ARCHIVED and anything else: the request conflicts with the session's state.
  return { status: 409, body: { error: true, reason: out.reason, code: out.code } };
}

/** The service refusal riding inside a tool's result, when there is one. */
function serviceRefusal(result: unknown): ApiResponse | null {
  if (typeof result !== "object" || result === null) return null;
  const out = result as { ok?: unknown; code?: unknown; reason?: unknown };
  if (out.ok !== false) return null;
  return sessionFailure({
    code: typeof out.code === "string" ? out.code : "INVALID",
    reason: typeof out.reason === "string" ? out.reason : "the session operation was refused",
  });
}

// ── The routes ────────────────────────────────────────────────────────────────

function buildRoutes(runtime: SessionRouteDeps["runtime"]): {
  defs: SessionRouteDef[];
  handle(request: ApiRequest): Promise<ApiResponse>;
} {
  const sessions = runtime.sessions;
  const tools = runtime.tools;
  const transcripts = createSessionTranscriptRouter({ sessions });

  // ── GET /sessions/search ────────────────────────────────────────────────────
  async function searchSessions(req: ApiRequest): Promise<ApiResponse> {
    const text = query(req).get("query") ?? "";
    if (text.trim().length === 0) return bad('"query" must be a non-empty string');
    const limit = parseLimit(query(req).get("limit"));
    if (!limit.ok) return bad(limit.reason);
    const out = sessions.search(text, limit.value !== undefined ? { limit: limit.value } : undefined);
    if (!out.ok) {
      return out.code === "INVALID" ? bad(out.reason) : notFound(out.reason);
    }
    return ok({ query: text, count: out.value.length, hits: out.value });
  }

  // ── GET /sessions/:id/view ──────────────────────────────────────────────────
  async function viewSession(req: ApiRequest, params: Record<string, string>): Promise<ApiResponse> {
    const id = params.id ?? "";
    if (id.length === 0) return bad('"id" must be a non-empty string');
    const limit = parseLimit(query(req).get("limit"));
    if (!limit.ok) return bad(limit.reason);
    const out = sessions.record(id, limit.value !== undefined ? { limit: limit.value } : undefined);
    if (!out.ok) return sessionFailure(out);
    return ok({ session: out.value });
  }

  // ── GET /sessions/:id/transcript ────────────────────────────────────────────
  async function transcriptOf(req: ApiRequest, params: Record<string, string>): Promise<ApiResponse> {
    const q = query(req);
    const limit = parseLimit(q.get("limit"));
    if (!limit.ok) return bad(limit.reason);
    const input: TranscriptInput = { sessionId: params.id ?? "" };
    const kind = q.get("kind");
    if (kind !== null && kind.length > 0) input.kind = kind as TranscriptKind;
    const owner = q.get("owner");
    if (owner !== null && owner.length > 0) input.owner = owner;
    if (limit.value !== undefined) input.limit = limit.value;
    const out = transcripts.read(input);
    if (out.ok) return ok({ transcript: out.transcript });
    switch (out.code) {
      case "NOT_FOUND":
        return notFound(out.reason);
      case "CROSS_KIND":
        return forbidden(out.reason);
      case "VALIDATION_FAILED":
        return bad(out.reason);
      case "NOT_WIRED":
        return { status: 501, body: { error: true, reason: out.reason, notWired: true } };
    }
  }

  // ── The mutations ───────────────────────────────────────────────────────────
  // Every one of them goes through `tools.invoke`, so the registry's chain —
  // validate -> policy -> (approval) -> execute — is the only authority. The
  // tool's execute returns the SERVICE result (a value); a refusal inside it
  // (unknown id, archived state) maps to its HTTP shape without pretending the
  // boundary failed.

  async function invokeSessionTool(
    toolId: string,
    input: Record<string, unknown>,
    body: Record<string, unknown> | null,
  ): Promise<{ ok: true; result: unknown; invocationId: string } | { ok: false; response: ApiResponse }> {
    const approvalId = approvalIdOf(body);
    const invoked = await tools.invoke(toolId, input, approvalId !== undefined ? { approvalId } : undefined);
    if (!invoked.ok) return { ok: false, response: failureResponse(invoked) };
    return { ok: true, result: invoked.result, invocationId: invoked.invocation.invocationId };
  }

  /** Parse a mutation body: object-or-absent; `title` (when allowed) optional string. */
  function mutationBody(
    req: ApiRequest,
    allowTitle: boolean,
  ): { ok: true; body: Record<string, unknown> } | { ok: false; response: ApiResponse } {
    const body = asBodyObject(req.body);
    if (body === null) return { ok: false, response: bad('"body" must be a JSON object when present') };
    // A present-but-wrong `approvalId` is refused, not silently ignored: a caller
    // that meant to spend an approval must not get a fresh park instead.
    if (body.approvalId !== undefined && (typeof body.approvalId !== "string" || body.approvalId.trim().length === 0)) {
      return { ok: false, response: bad('"approvalId" must be a non-empty string when present') };
    }
    if (body.title !== undefined) {
      if (!allowTitle) return { ok: false, response: bad('"title" is not accepted on this route') };
      if (typeof body.title !== "string" || body.title.trim().length === 0) {
        return { ok: false, response: bad('"title" must be a non-empty string when present') };
      }
    }
    return { ok: true, body };
  }

  async function duplicateSession(req: ApiRequest, params: Record<string, string>): Promise<ApiResponse> {
    const parsed = mutationBody(req, true);
    if (!parsed.ok) return parsed.response;
    const id = params.id ?? "";
    if (id.length === 0) return bad('"id" must be a non-empty string');
    const input: Record<string, unknown> = { id };
    if (typeof parsed.body.title === "string") input.title = parsed.body.title.trim();
    const gated = await invokeSessionTool(SESSION_TOOL_IDS.duplicate, input, parsed.body);
    if (!gated.ok) return gated.response;
    const refusal = serviceRefusal(gated.result);
    if (refusal !== null) return refusal;
    const value = (gated.result as { value?: unknown }).value;
    return ok({ session: value, invocationId: gated.invocationId }, 201);
  }

  async function closeSession(req: ApiRequest, params: Record<string, string>): Promise<ApiResponse> {
    const parsed = mutationBody(req, false);
    if (!parsed.ok) return parsed.response;
    const id = params.id ?? "";
    if (id.length === 0) return bad('"id" must be a non-empty string');
    const gated = await invokeSessionTool(SESSION_TOOL_IDS.close, { id }, parsed.body);
    if (!gated.ok) return gated.response;
    const refusal = serviceRefusal(gated.result);
    if (refusal !== null) return refusal;
    const value = (gated.result as { value?: unknown }).value;
    return ok({ session: value, invocationId: gated.invocationId });
  }

  async function clearSession(req: ApiRequest, params: Record<string, string>): Promise<ApiResponse> {
    const parsed = mutationBody(req, false);
    if (!parsed.ok) return parsed.response;
    const id = params.id ?? "";
    if (id.length === 0) return bad('"id" must be a non-empty string');
    const gated = await invokeSessionTool(SESSION_TOOL_IDS.clear, { id }, parsed.body);
    if (!gated.ok) return gated.response;
    const refusal = serviceRefusal(gated.result);
    if (refusal !== null) return refusal;
    const value = (gated.result as { value?: { removed?: unknown; session?: unknown } }).value ?? {};
    return ok({ removed: value.removed ?? 0, session: value.session, invocationId: gated.invocationId });
  }

  async function deleteSession(req: ApiRequest, params: Record<string, string>): Promise<ApiResponse> {
    const parsed = mutationBody(req, false);
    if (!parsed.ok) return parsed.response;
    const id = params.id ?? "";
    if (id.length === 0) return bad('"id" must be a non-empty string');
    const gated = await invokeSessionTool(SESSION_TOOL_IDS.delete, { id }, parsed.body);
    if (!gated.ok) return gated.response;
    const refusal = serviceRefusal(gated.result);
    if (refusal !== null) return refusal;
    const value = (gated.result as { value?: { sessionId?: unknown } }).value ?? {};
    return ok({ sessionId: value.sessionId ?? id, invocationId: gated.invocationId });
  }

  // ── The table ───────────────────────────────────────────────────────────────
  function route(
    method: string,
    pattern: string,
    classification: SessionRouteClassification,
    handler: SessionRouteDef["handler"],
  ): SessionRouteDef {
    return { method, pattern, classification, segments: pattern.split("/").filter((s) => s.length > 0), handler };
  }

  const defs: SessionRouteDef[] = [
    // The literal `/sessions/search` is registered before any `:id` route, and
    // the wrapper matches ITS OWN table before the original handle runs, so the
    // original `GET /sessions/:id` can never swallow it.
    route("GET", "/sessions/search", "READ", (req) => searchSessions(req)),
    route("GET", "/sessions/:id/view", "READ", (req, p) => viewSession(req, p)),
    route("GET", "/sessions/:id/transcript", "READ", (req, p) => transcriptOf(req, p)),
    route("POST", "/sessions/:id/duplicate", "WRITE", (req, p) => duplicateSession(req, p)),
    route("POST", "/sessions/:id/close", "WRITE", (req, p) => closeSession(req, p)),
    route("POST", "/sessions/:id/clear", "DESTRUCTIVE", (req, p) => clearSession(req, p)),
    route("POST", "/sessions/:id/delete", "DESTRUCTIVE", (req, p) => deleteSession(req, p)),
  ];

  function match(
    method: string,
    path: string,
  ): { def: SessionRouteDef; params: Record<string, string> } | null {
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

  async function handle(request: ApiRequest): Promise<ApiResponse> {
    const method = typeof request.method === "string" ? request.method.toUpperCase() : "";
    const rawPath = typeof request.path === "string" ? request.path : "/";
    const path = rawPath.split("?")[0] ?? "/";
    const hit = match(method, path);
    if (hit === null) return notFound(`no session route for ${method || "(no method)"} ${path}`);
    try {
      return await hit.def.handler(request, hit.params);
    } catch {
      return { status: 500, body: { error: true, reason: `internal error while handling ${method} ${path}` } };
    }
  }

  return { defs, handle };
}

// ── The registration seam ─────────────────────────────────────────────────────

/** Marks a wrapper so a second `registerSessionRoutes` cannot double-wrap it. */
const WRAPPED_KEY = "__kaiSessionRoutesWrapped";

/**
 * Register the session surface into the live Core API, in place:
 *
 *   - the five session tools land on `runtime.tools` (idempotently);
 *   - `app.handle` is replaced with a wrapper that answers this module's routes
 *     and delegates everything else to the ORIGINAL handle (captured before the
 *     swap, so there is no recursion). Marked, so re-registration is a no-op.
 *
 * The exact integrator line (server.ts, after `createCoreApi`):
 *
 *     if (coreApi !== null && core !== undefined) registerSessionRoutes(coreApi, { runtime: core });
 */
export function registerSessionRoutes(app: CoreApi, deps: SessionRouteDeps): SessionRouteRegistration {
  const tools = registerSessionTools(deps.runtime.tools, { sessions: deps.runtime.sessions });
  const built = buildRoutes(deps.runtime);
  const patterns = built.defs.map((def) => `${def.method} ${def.pattern}`);

  const marker = app.handle as unknown as Record<string, unknown>;
  if (marker[WRAPPED_KEY] !== true) {
    const original = app.handle;
    const wrapper = async (request: ApiRequest): Promise<ApiResponse> => {
      const method = typeof request.method === "string" ? request.method.toUpperCase() : "";
      const rawPath = typeof request.path === "string" ? request.path : "/";
      const path = rawPath.split("?")[0] ?? "/";
      const segs = path.split("/").filter((s) => s.length > 0);
      // Same matcher as the pure handle, but WITHOUT the 404 fallthrough: a
      // non-match must reach the original handle untouched.
      for (const def of built.defs) {
        if (def.method !== method || def.segments.length !== segs.length) continue;
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
        if (matched) {
          try {
            return await def.handler(request, params);
          } catch {
            return { status: 500, body: { error: true, reason: `internal error while handling ${method} ${path}` } };
          }
        }
      }
      return original.call(app, request);
    };
    (wrapper as unknown as Record<string, unknown>)[WRAPPED_KEY] = true;
    app.handle = wrapper;
  }

  return { patterns, tools };
}
