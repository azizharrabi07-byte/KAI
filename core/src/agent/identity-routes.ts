// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The canonical identity route surface — `registerIdentityRoutes(app, deps)` /
 * `createIdentityApi(deps)`.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `agent/identity-model.ts` resolves KAI's ONE canonical identity model — the
 * twelve owner fields, the five authorities typed as their factories' own
 * `ReturnType`. It was wired into `runtime.ts` at the composition root, which
 * makes it INTEGRATION PROVEN, but nothing HTTP-facing could read it, so it was
 * not END-TO-END. This is the route seam that exposes it, deliberately NOT an
 * edit to `core/src/api/routes.ts` (the integration stream owns that file and
 * wires this with one additive line):
 *
 *     registerIdentityRoutes(
 *       { route: (m, p, c, h) => routeDefs.push(route(m, p, c, h)) },
 *       { model: runtime.identityModel });
 *
 * `createIdentityApi(deps)` is the same surface in the house pure-function style
 * (`{ handle(request), routes() }`, exactly like `CoreApi`, `createToolApi` and
 * `createMcpApi`), for an integration that prefers to merge a handler instead of
 * a route table. Both build the SAME route list.
 *
 * WHAT IT SERVES
 * --------------
 *   GET /identity/model    the ONE canonical identity model, JSON-safe
 *
 * The response is the model's OWN `describe()` projection (never a second
 * projection invented here) plus its `harnessStatement()` and the per-field
 * `binding[]`, so an unbacked field is visible rather than implied. It names the
 * REAL subsystems and a sample of the REAL methods present on each live authority
 * object — proof the field is the running subsystem, not a string about one. A
 * READ: it composes a view of live objects and mutates nothing.
 *
 * The build identity (`GET /identity`, `loadIdentity()`) stays exactly as it was:
 * this is an ADDITION beside it, not a replacement, so no existing route shape
 * changes.
 */

import type { KaiIdentityModel } from "./identity-model.ts";

// ── The request/response shape (mirrors core/src/api/routes.ts) ───────────────

export interface IdentityApiRequest {
  /** "GET" | "POST". */
  method: string;
  /** "/identity/model" — already stripped of any query string. */
  path: string;
  /** Parsed JSON body, or undefined. Untrusted. */
  body?: unknown;
  query?: URLSearchParams;
}

export interface IdentityApiResponse {
  status: number;
  body: unknown;
}

export type IdentityRouteClassification = "READ" | "WRITE" | "EXTERNAL" | "DESTRUCTIVE";

export type IdentityRouteHandler = (
  request: IdentityApiRequest,
  params: Record<string, string>,
) => Promise<IdentityApiResponse>;

export interface IdentityRouteDef {
  method: string;
  pattern: string;
  classification: IdentityRouteClassification;
  segments: string[];
  handler: IdentityRouteHandler;
}

// ── Deps / results ────────────────────────────────────────────────────────────

export interface IdentityRouteDeps {
  /** The ONE canonical identity model built at the composition root. */
  model: KaiIdentityModel;
}

export interface IdentityApi {
  /** Pure request -> response. No sockets, so it is testable directly. */
  handle(request: IdentityApiRequest): Promise<IdentityApiResponse>;
  /** Paths this module serves, for the parent to mount and for docs. */
  routes(): string[];
}

export interface IdentityRouteRegistration {
  patterns: string[];
  api: IdentityApi;
}

// ── The route ─────────────────────────────────────────────────────────────────

interface BuiltRoutes {
  defs: IdentityRouteDef[];
  handle(request: IdentityApiRequest): Promise<IdentityApiResponse>;
}

function buildRoutes(deps: IdentityRouteDeps): BuiltRoutes {
  const model = deps.model;

  /**
   * The JSON-safe projection of the canonical model, read from the model's OWN
   * `describe()` — this module never re-derives a field, so the route and the
   * runtime cannot disagree. `harness` is the model's own composed statement, so
   * the document (KAI_HARNESS) and the code agree by construction.
   */
  function getIdentityModel(): IdentityApiResponse {
    const description = model.describe();
    return {
      status: 200,
      body: {
        service: "identity",
        model: description,
        harness: model.harnessStatement(),
        // The twelve canonical fields, in the brief's order, each naming its real
        // backing and its honesty status. Derived from the SAME binding[] the
        // model carries, so a gap here is the model's own statement, not ours.
        note:
          "The canonical identity model: the twelve owner fields resolved over the " +
          "running Core's REAL subsystems. Each non-document authority names the live " +
          "method set read off the object, so a field is the running subsystem, not a " +
          "description of one. `binding[]` tags every field.",
      },
    };
  }

  const defs: IdentityRouteDef[] = [
    route("GET", "/identity/model", "READ", async () => getIdentityModel()),
  ];

  function match(method: string, path: string): { def: IdentityRouteDef; params: Record<string, string> } | null {
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

  async function handle(request: IdentityApiRequest): Promise<IdentityApiResponse> {
    const method = typeof request.method === "string" ? request.method.toUpperCase() : "";
    const rawPath = typeof request.path === "string" ? request.path : "/";
    const path = rawPath.split("?")[0] ?? "/";
    const hit = match(method, path);
    if (hit === null) {
      // "not one of mine": the integrator mounts this BESIDE the existing API, so a
      // 404 must fall through to the routes that already existed.
      return { status: 404, body: { error: true, reason: `no route for ${method || "(no method)"} ${path}` } };
    }
    try {
      return await hit.def.handler(request, hit.params);
    } catch {
      return {
        status: 500,
        body: { error: true, reason: `internal error while handling ${method} ${path}` },
      };
    }
  }

  return { defs, handle };
}

function route(
  method: string,
  pattern: string,
  classification: IdentityRouteClassification,
  handler: IdentityRouteHandler,
): IdentityRouteDef {
  return { method, pattern, classification, segments: pattern.split("/").filter((s) => s.length > 0), handler };
}

// ── The two exported seams ────────────────────────────────────────────────────

/** The house-style pure-function API: `{ handle(request), routes() }`. */
export function createIdentityApi(deps: IdentityRouteDeps): IdentityApi {
  const built = buildRoutes(deps);
  return {
    handle: built.handle,
    routes: () => built.defs.map((def) => `${def.method} ${def.pattern}`),
  };
}

/**
 * What a host must accept for `registerIdentityRoutes` to register into it:
 * the `route(...)` helper shape from `core/src/api/routes.ts`, or a bare
 * function with the same signature. Anything else throws at startup, so a route
 * table that silently accepts nothing cannot leave `/identity/model` at 404
 * while looking wired.
 */
export type IdentityRouteHost =
  | {
      route(
        method: string,
        pattern: string,
        classification: IdentityRouteClassification,
        handler: IdentityRouteHandler,
      ): void;
    }
  | ((
      method: string,
      pattern: string,
      classification: IdentityRouteClassification,
      handler: IdentityRouteHandler,
    ) => void);

type RouteSink = (
  method: string,
  pattern: string,
  classification: IdentityRouteClassification,
  handler: IdentityRouteHandler,
) => void;

function routeSink(app: IdentityRouteHost): RouteSink {
  if (typeof app === "function") return app;
  if (typeof app === "object" && app !== null && typeof (app as { route?: unknown }).route === "function") {
    const host = app as { route: RouteSink };
    return (method, pattern, classification, handler) => host.route(method, pattern, classification, handler);
  }
  throw new Error(
    "registerIdentityRoutes: `app` must be a function (method, pattern, classification, handler) or an object " +
      "with a `route` method of that shape",
  );
}

/**
 * Register the identity route surface into a host, and return the pieces the
 * caller needs (`patterns` and the pure `api`).
 *
 * The exact one-line call for `core/src/api/routes.ts` (integration stream):
 *
 *     registerIdentityRoutes({ route: (m, p, c, h) => routeDefs.push(route(m, p, c, h)) },
 *                            { model: runtime.identityModel });
 */
export function registerIdentityRoutes(app: IdentityRouteHost, deps: IdentityRouteDeps): IdentityRouteRegistration {
  const built = buildRoutes(deps);
  const sink = routeSink(app);
  for (const def of built.defs) sink(def.method, def.pattern, def.classification, def.handler);
  const api: IdentityApi = {
    handle: built.handle,
    routes: () => built.defs.map((def) => `${def.method} ${def.pattern}`),
  };
  return { patterns: api.routes(), api };
}
