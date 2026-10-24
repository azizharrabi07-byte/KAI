// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Tests for the Core API authorization policy (src/api/authz.ts).
 *
 * The point of these tests is COVERAGE, not spot checks. The policy's risk is
 * not "does it refuse the approval route?" (it would be caught in review) but
 * "can a route be ADDED to the surface without anyone classifying it?" — so the
 * first test re-derives the real route table from the source that declares it and
 * fails if the table and the policy disagree in EITHER direction. A new route,
 * a renamed one or a deleted one breaks it loudly.
 *
 * The surface is declared in four files: the static table plus the three surfaces
 * `createCoreApi()` mounts (MCP, generic tools, canonical identity model). Every
 * one of them registers routes through a literal `route("METHOD", "/path", CLASS, …)`
 * call, which is what the parser reads — no guesswork and no mirrored list here.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  ACCESS_POLICY,
  WORKER_TOKEN_ROUTES,
  accessEntryFor,
  accessFor,
  decideAccess,
  workerTokenMayAccess,
  type RouteAccess,
} from "../src/api/authz.ts";

/** The files that register into the ONE route table `createCoreApi()` serves. */
const ROUTE_SOURCES = [
  "../src/api/routes.ts",
  "../src/mcp/routes.ts",
  "../src/tools/routes.ts",
  "../src/agent/identity-routes.ts",
] as const;

/** `route("GET", "/goals/:id", "READ", …)` — the only registration shape used. */
const ROUTE_CALL =
  /route\(\s*"(GET|POST|PUT|DELETE|PATCH)"\s*,\s*"(\/[^"]*)"\s*,\s*"(READ|WRITE|EXTERNAL|DESTRUCTIVE)"/g;

interface DeclaredRoute {
  method: string;
  pattern: string;
  /** What the route table itself says the handler does. */
  declared: string;
  source: string;
}

/**
 * Re-derive the served route table from the source that declares it. Throws if a
 * source yields nothing, so a renamed registration helper fails HERE with a clear
 * reason instead of silently shrinking the expected set.
 */
function declaredRoutes(): DeclaredRoute[] {
  const found: DeclaredRoute[] = [];
  for (const relative of ROUTE_SOURCES) {
    const file = fileURLToPath(new URL(relative, import.meta.url));
    const text = readFileSync(file, "utf8");
    const matches = [...text.matchAll(ROUTE_CALL)];
    assert.ok(matches.length > 0, `${relative} declares no route(…) call — the parser or the file changed`);
    for (const match of matches) {
      const [, method, pattern, declared] = match;
      assert.ok(
        method !== undefined && pattern !== undefined && declared !== undefined,
        `${relative}: unreadable route declaration ${match[0]}`,
      );
      found.push({ method, pattern, declared, source: relative });
    }
  }
  return found;
}

/** `"POST /goals/:id/approve"` → the (method, pattern) pair the policy is keyed by. */
function splitKey(key: string): { method: string; pattern: string } {
  const space = key.indexOf(" ");
  assert.ok(space > 0, `policy key "${key}" is not "METHOD /path"`);
  return { method: key.slice(0, space), pattern: key.slice(space + 1) };
}

/** A request path the router would actually dispatch for a pattern. */
function concretePath(pattern: string): string {
  return pattern
    .split("/")
    .map((segment) => (segment.startsWith(":") ? `sample-${segment.slice(1)}` : segment))
    .join("/");
}

const VALID_ACCESS: readonly RouteAccess[] = ["public", "read", "owner"];

// ── Coverage: no route without a classification ────────────────────────────────

test("every route in the real route table is classified, and no entry is phantom", () => {
  const registered = declaredRoutes();
  const declared = new Set(registered.map((r) => `${r.method} ${r.pattern}`));
  const classified = new Set(Object.keys(ACCESS_POLICY));

  const unclassified = [...declared].filter((key) => !classified.has(key)).sort();
  const phantom = [...classified].filter((key) => !declared.has(key)).sort();

  assert.deepEqual(
    unclassified,
    [],
    `these routes are served but have NO access level — classify them in ACCESS_POLICY: ${unclassified.join(", ")}`,
  );
  assert.deepEqual(
    phantom,
    [],
    `these ACCESS_POLICY entries match no route in the table — remove or fix them: ${phantom.join(", ")}`,
  );
  assert.equal(classified.size, declared.size, "policy and route table must cover the same set");
  // routes.ts alone declares 121 routes; the three mounted surfaces add more. A
  // parser regression shows up as a shrunken set, so guard the floor explicitly.
  assert.ok(
    declared.size >= 121,
    `the route parser found only ${declared.size} routes — routes.ts alone declares 121`,
  );
});

test("the static table in routes.ts, the MCP surface, tools and identity are all represented", () => {
  const registered = declaredRoutes();

  for (const { source } of registered) {
    assert.ok(ROUTE_SOURCES.includes(source as (typeof ROUTE_SOURCES)[number]), `route from an unexpected source: ${source}`);
  }
  const bySource = (source: string): number => registered.filter((r) => r.source === source).length;
  // Sanity on the four surfaces actually being parsed (not a subset of one file).
  for (const source of ROUTE_SOURCES) {
    assert.ok(bySource(source) > 0, `${source} contributed no routes to the parsed surface`);
  }
  // Every /mcp route is owner: the MCP surface names and reaches external servers.
  for (const { method, pattern } of registered) {
    if (!pattern.startsWith("/mcp")) continue;
    assert.equal(
      accessFor(method, concretePath(pattern)),
      "owner",
      `${method} ${pattern} touches MCP and must be owner`,
    );
  }
});

test("every entry carries a valid level and a one-line reason", () => {
  const entries = Object.entries(ACCESS_POLICY);
  assert.ok(entries.length > 0);
  for (const [key, entry] of entries) {
    const { method, pattern } = splitKey(key);
    assert.equal(method, method.toUpperCase(), `${key}: the method must be uppercase`);
    assert.ok(pattern.startsWith("/"), `${key}: the pattern must start with "/"`);
    assert.ok(VALID_ACCESS.includes(entry.access), `${key}: unknown access "${entry.access}"`);
    assert.equal(typeof entry.reason, "string", `${key}: a reason is required`);
    assert.ok(entry.reason.trim().length > 0, `${key}: the reason must not be empty`);
    assert.ok(entry.reason.length < 200, `${key}: the reason must stay one line`);
  }
});

test("only the identity handshake is public — and a mutating route is never public or read", () => {
  const publics = Object.entries(ACCESS_POLICY)
    .filter(([, entry]) => entry.access === "public")
    .map(([key]) => key);
  assert.deepEqual(publics, ["GET /identity"], "the public surface is exactly the build/identity handshake");

  // Cross-check against the route table's OWN classification: whatever routes.ts
  // calls mutating must be owner in the policy. This is what stops a route being
  // declared WRITE and still classified public — the exact drift Part I prevents.
  for (const route of declaredRoutes()) {
    if (route.declared === "READ") continue;
    const key = `${route.method} ${route.pattern}`;
    assert.equal(
      ACCESS_POLICY[key]?.access,
      "owner",
      `${key} is declared ${route.declared} by the route table, so it can never be public or read`,
    );
  }
});

// ── The escalation surface ─────────────────────────────────────────────────────

test("the routes that change KAI's authority are owner", () => {
  const escalations = [
    "POST /approvals/:id/decide",
    "POST /doer",
    "POST /settings",
    "POST /policy/rules",
    "POST /soul",
    "POST /tools/:id/invoke",
    "POST /models/use",
  ];
  for (const key of escalations) {
    assert.equal(ACCESS_POLICY[key]?.access, "owner", `${key} must be owner`);
    const { method, pattern } = splitKey(key);
    assert.equal(accessFor(method, concretePath(pattern)), "owner", `${key} must resolve to owner`);
  }
});

// ── The decision ───────────────────────────────────────────────────────────────

test("an unattested caller is refused (401) on EVERY owner route when a credential is configured", () => {
  let owners = 0;
  for (const [key, entry] of Object.entries(ACCESS_POLICY)) {
    if (entry.access !== "owner") continue;
    owners += 1;
    const { method, pattern } = splitKey(key);
    const path = concretePath(pattern);

    const refused = decideAccess({ method, path, attested: false, ownerAuthConfigured: true });
    assert.equal(refused.allowed, false, `${key} must refuse an unattested caller`);
    assert.equal(refused.status, 401, `${key} must answer 401`);
    assert.ok(refused.reason.length > 0, `${key} must record why`);

    const attested = decideAccess({ method, path, attested: true, ownerAuthConfigured: true });
    assert.equal(attested.allowed, true, `${key} must allow an attested caller`);
    assert.equal(attested.status, 200);
    assert.match(attested.reason, /owner credential/, `${key}: the allow must name the credential`);
  }
  assert.ok(owners > 0, "the policy must contain owner routes");
});

test("an owner route FAILS CLOSED: only a credential or an explicit developer switch allows it", () => {
  for (const [key, entry] of Object.entries(ACCESS_POLICY)) {
    if (entry.access !== "owner") continue;
    const { method, pattern } = splitKey(key);
    const path = concretePath(pattern);

    // 1. No credential configured at all. This MUST be refused: a normal
    //    autonomous installation must never run with its owner controls open
    //    merely because a credential was missing. (This assertion is the inverse
    //    of what it used to be — the old allow was the unsafe default.)
    const bare = decideAccess({ method, path, attested: false, ownerAuthConfigured: false });
    assert.equal(bare.allowed, false, `${key} must be REFUSED on a Core with no credential`);
    assert.equal(bare.status, 403, `${key}: a missing credential is a refusal, not a 200`);
    assert.match(bare.reason, /NO owner credential/, `${key}: the refusal must name the real cause`);
    assert.match(bare.reason, /KAI_DEV_MODE=1/, `${key}: the refusal must name the way forward`);

    // 2. An EXPLICIT developer switch: allowed, and the reason says it was asked
    //    for rather than inferred.
    const dev = decideAccess({ method, path, attested: false, ownerAuthConfigured: true, devMode: true });
    assert.equal(dev.allowed, true, `${key} is allowed under explicit devMode`);
    assert.match(dev.reason, /developer mode/, `${key}: devMode must be named in the reason`);

    // 3. Omitted devMode is NOT developer mode: with a credential configured the
    //    same call is refused, so devMode can never be the silent default.
    const omitted = decideAccess({ method, path, attested: false, ownerAuthConfigured: true });
    assert.equal(omitted.allowed, false, `${key}: devMode must never be assumed`);
    assert.ok(!/developer mode/.test(omitted.reason));

    // 4. A valid credential always allows it.
    const ok = decideAccess({ method, path, attested: true, ownerAuthConfigured: true });
    assert.equal(ok.allowed, true, `${key} is allowed with the owner credential`);
  }
});

test("the WORKER credential unlocks exactly POST /worker/authorize and nothing else", () => {
  const key = "POST /worker/authorize";
  assert.ok(WORKER_TOKEN_ROUTES.has(key), "the worker route set must contain the authorize route");

  // Allowed even when no OWNER credential is configured: the two credentials are
  // independent, and the worker one is deliberately weaker.
  const allowed = decideAccess({
    method: "POST",
    path: "/worker/authorize",
    attested: false,
    workerAttested: true,
    ownerAuthConfigured: false,
  });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.status, 200);
  assert.match(allowed.reason, /WORKER credential/);
  assert.match(allowed.reason, /cannot change what KAI is authorized to do/);

  // Every OTHER owner route refuses the same credential, whether or not an owner
  // credential exists — a leaked hook token must never become the owner.
  let checked = 0;
  for (const [other, entry] of Object.entries(ACCESS_POLICY)) {
    if (entry.access !== "owner" || other === key) continue;
    checked += 1;
    const { method, pattern } = splitKey(other);
    for (const configured of [true, false]) {
      const decision = decideAccess({
        method,
        path: concretePath(pattern),
        attested: false,
        workerAttested: true,
        ownerAuthConfigured: configured,
      });
      assert.equal(decision.allowed, false, `${other} must NOT accept the worker credential`);
      assert.notEqual(decision.status, 200, `${other} must not answer 200 to a worker credential`);
    }
  }
  assert.ok(checked > 0, "the policy must contain owner routes besides the worker route");
});

test("worker route matching is exact: method case-insensitive, path not", () => {
  assert.equal(workerTokenMayAccess("post", "/worker/authorize"), true);
  assert.equal(workerTokenMayAccess("POST", "/worker/authorize"), true);
  assert.equal(workerTokenMayAccess("POST", "/worker/authorize/"), false);
  assert.equal(workerTokenMayAccess("GET", "/worker/authorize"), false);
  assert.equal(workerTokenMayAccess("POST", "/soul"), false);
  assert.deepEqual([...WORKER_TOKEN_ROUTES], ["POST /worker/authorize"]);
});

test("reads and public surfaces stay open to an unattested caller", () => {
  let open = 0;
  for (const [key, entry] of Object.entries(ACCESS_POLICY)) {
    if (entry.access === "owner") continue;
    open += 1;
    const { method, pattern } = splitKey(key);
    for (const configured of [true, false]) {
      const decision = decideAccess({
        method,
        path: concretePath(pattern),
        attested: false,
        ownerAuthConfigured: configured,
      });
      assert.equal(decision.allowed, true, `${key} must stay readable (ownerAuthConfigured=${configured})`);
      assert.equal(decision.status, 200);
      assert.ok(decision.reason.length > 0);
    }
  }
  assert.ok(open > 40, `expected a substantial read surface, saw ${open}`);
});

test("an unregistered path is refused as 404, never defaulted open", () => {
  const decision = decideAccess({ method: "POST", path: "/nope/nothing", attested: true, ownerAuthConfigured: true });
  assert.equal(decision.allowed, false);
  assert.equal(decision.status, 404);
  assert.match(decision.reason, /no route is registered/);
});

// ── Routing parity with the router's own matcher ───────────────────────────────

test("accessFor matches parameter segments, ignores query strings and trailing slashes, and is case-insensitive on the method", () => {
  // A literal pattern and a parameter pattern of the SAME length both match, so
  // this also proves the table's order preserves the router's literal-first rule.
  assert.equal(accessFor("GET", "/skills/staging"), "read");
  assert.equal(accessFor("GET", "/skills/staging/staged-1"), "read");
  assert.equal(accessFor("GET", "/skills/data-pipeline"), "read");
  assert.equal(accessFor("GET", "/skills/data-pipeline/load"), "read");

  assert.equal(accessFor("POST", "/goals/g-1/approve"), "owner");
  assert.equal(accessFor("POST", "/goals/g-1/reject"), "owner");
  assert.equal(accessFor("GET", "/goals/g-1"), "read");
  assert.equal(accessFor("POST", "/missions/m-1/cancel"), "owner");
  assert.equal(accessFor("GET", "/work-items/w-1"), "read");
  assert.equal(accessFor("GET", "/subagents/p-1/sessions/s-1/turns"), "read");
  assert.equal(accessFor("POST", "/tools/system.get_status/invoke"), "owner");
  assert.equal(accessFor("GET", "/tools/system.get_status"), "read");
  assert.equal(accessFor("POST", "/mcp/servers/echo/connect"), "owner");
  assert.equal(accessFor("GET", "/identity/model"), "read");

  // Same path, different method: the method is part of the identity.
  assert.equal(accessFor("GET", "/soul"), "read");
  assert.equal(accessFor("POST", "/soul"), "owner");
  assert.equal(accessFor("GET", "/settings"), "read");
  assert.equal(accessFor("POST", "/settings"), "owner");

  // Query string, trailing slash and method case do not change the route.
  assert.equal(accessFor("get", "/goals/g-1?limit=5"), "read");
  assert.equal(accessFor("POST", "/doer/"), "owner");
  assert.equal(accessFor("POST", "/goals/?verbose=1"), "owner");

  // Nothing registered: null, never a default access level.
  assert.equal(accessFor("GET", "/nope"), null);
  assert.equal(accessFor("POST", "/goals/g-1/celebration"), null);
  assert.equal(accessFor("DELETE", "/tools"), null);
  const entry = accessEntryFor("POST", "/doer");
  assert.equal(entry?.access, "owner");
  assert.equal(typeof entry?.reason, "string");
});
