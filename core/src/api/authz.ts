// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The Core HTTP API's AUTHORIZATION POLICY — one table, one match, one decision.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `core/src/api/routes.ts` already carries a per-route `requiresOwner` flag and
 * enforces it on a handful of routes. That flag answers "does this control change
 * what KAI is authorized to do?" — a security question — but it is declared INSIDE
 * the route table, one `{ requiresOwner: true }` at a time, and nothing states the
 * access level of the routes that do NOT carry it. A route added tomorrow without
 * the flag is silently open. There is also no test that can enumerate the surface
 * and ask "is every route classified?".
 *
 * This module is that missing answer, and it is DELIBERATELY SEPARATE from the
 * router: the router owns dispatch, this file owns ACCESS. It is pure data plus two
 * pure functions, imports nothing, and can be read end-to-end to audit the whole
 * surface. `ACCESS_POLICY` maps EVERY route pattern the real router serves to one
 * of three levels, each with the reason it was chosen, and `tests/api-authz.test.ts`
 * fails if the table and the route table ever disagree in EITHER direction — so a
 * new route cannot be served without being classified.
 *
 * WHAT THE THREE LEVELS MEAN
 * --------------------------
 *   public  Nothing about KAI's authority, memory or state is exposed: the
 *           identity handshake a shell reads before it can present anything.
 *   read    A read of KAI's own state or a pure computation. Open without a
 *           credential, exactly as reads are today.
 *   owner   Anything that mutates state, executes a tool, changes
 *           policy/soul/settings/models, decides an approval, manages
 *           skills/plugins/schedules/subagents/memory, or touches MCP. These are
 *           the controls that can widen what KAI is allowed to do, act outside
 *           this machine, or release a parked action — so a local process that
 *           cannot present the owner credential must not reach them.
 *
 * CLASSIFICATION IS CONSERVATIVE AND IS NOT INFERRED FROM THE HTTP METHOD
 * ----------------------------------------------------------------------
 * `POST /visual/compile`, `POST /prompts/compose`, `POST /recovery/classify` and
 * `POST /work-items/:id/review` are READS: they compute and return, and write
 * nothing. Conversely a GET can be `owner` (every `/mcp` entry) because the MCP
 * surface names and reaches external servers. Where the route table's own
 * `RouteClass` says WRITE / EXTERNAL / DESTRUCTIVE, this policy says `owner` —
 * the test asserts that implication directly, so a route can never be declared
 * mutating and still be classified `public`.
 *
 * SCOPE
 * -----
 * The table covers every pattern registered into `routeDefs` by
 * `createCoreApi()`: the static table in `routes.ts` plus the three surfaces it
 * mounts (`core/src/mcp/routes.ts`, `core/src/tools/routes.ts`,
 * `core/src/agent/identity-routes.ts`). `GET /events` (the SSE mount) lives in
 * `core/src/server.ts`, outside the route table, and is out of scope here.
 *
 * `devMode` IS NEVER THE SILENT DEFAULT
 * -------------------------------------
 * `decideAccess` refuses an unattested caller on an `owner` route whenever this
 * Core HAS an owner credential to verify against. It allows the route without one
 * only in two states that are both visible in the returned `reason`: an explicit
 * `devMode: true` (a documented developer switch), or a Core with NO owner
 * credential configured at all — the bare developer Core `routes.ts` already
 * documents, where there is nothing to verify against. Absence of information
 * never produces a silent allow: the reason always names which of the two applied.
 */

/** The three access levels. `owner` is the strictest. */
export type RouteAccess = "public" | "read" | "owner";

export interface AccessPolicyEntry {
  access: RouteAccess;
  /** ONE line: why THIS route has THIS level. */
  reason: string;
}

/**
 * EVERY route the real router serves, keyed `"METHOD /path"`, in ROUTER ORDER.
 *
 * The order is not cosmetic: `routes.ts` registers a literal before the parameter
 * pattern that would swallow it (`/skills/staging` before `/skills/:id`), and its
 * `match()` returns the FIRST hit. `accessFor` walks this table in the same order,
 * so the policy resolves a path exactly as the router does.
 *
 * MCP surface rule: every `/mcp*` route is `owner`, including the GETs. The MCP
 * catalogue NAMES the external servers configured on this machine, and its reads
 * (`/resources`, `/resources/read`) run against a live connection to them; the
 * surface is the machine's external-system boundary, so it is owner-only.
 */
export const ACCESS_POLICY: Readonly<Record<string, AccessPolicyEntry>> = Object.freeze({
  // ── Identity / soul / settings / models ──────────────────────────────────────
  "GET /identity": {
    access: "public",
    reason:
      "the identity handshake: build id, git commit, protocol version and pid — which build is running, and nothing about KAI's authority, memory or state",
  },
  "GET /soul": { access: "read", reason: "serves the current soul text + version; replacing it is POST /soul" },
  "POST /soul": {
    access: "owner",
    reason: "REPLACES KAI's identity (soul.set): the archetypal escalation — what KAI is, not what it is doing",
  },
  "GET /settings": { access: "read", reason: "stored settings rows with effective values and where each came from" },
  "POST /settings": {
    access: "owner",
    reason: "patches KAI's settings through settings.update — autonomy, orchestration and model live here",
  },
  "POST /settings/reset": { access: "owner", reason: "resets settings rows to their defaults; the inverse of POST /settings" },
  "GET /providers": { access: "read", reason: "the provider catalogue" },
  "GET /providers/:id/test": {
    access: "read",
    reason: "a live MEASUREMENT of one provider (latency/capability probe); it writes no state, the same READ stance the route table takes",
  },
  "GET /models": { access: "read", reason: "the model catalogue for the configured provider" },
  "POST /models/use": {
    access: "owner",
    reason: "changes which model KAI runs on (settings.update 'model.name') — a change of KAI's own capability",
  },

  // ── Orchestration: work board ────────────────────────────────────────────────
  "GET /work-items": { access: "read", reason: "the work board" },
  "POST /work-items": { access: "owner", reason: "creates a durable work item and may start its run" },
  "GET /work-items/:id": { access: "read", reason: "one work item" },
  "POST /work-items/:id/run": {
    access: "owner",
    reason: "starts the orchestrator loop for an item — it executes work, not merely records it",
  },
  "POST /work-items/:id/review": {
    access: "read",
    reason: "reviews an existing item against criteria and returns the verdict; declares no record and writes no row",
  },
  "POST /work-items/audit": { access: "owner", reason: "ingests an external worker report as a durable work item and may launch it" },
  "GET /bench": { access: "read", reason: "the bench" },
  "GET /activity": { access: "read", reason: "the activity feed over persisted events" },

  // ── Goals: a goal is what authorises KAI to act ──────────────────────────────
  "GET /goals": { access: "read", reason: "the goal list" },
  "POST /goals": { access: "owner", reason: "an unrelated local process must not be able to create the goal that authorises KAI" },
  "GET /goals/:id": { access: "read", reason: "one goal" },
  "POST /goals/:id/state": { access: "owner", reason: "changes a goal's lifecycle state" },
  "POST /goals/:id/challenge": { access: "owner", reason: "records the challenger's verdict on a goal" },
  "POST /goals/:id/plan": { access: "owner", reason: "has the architect author a plan under the goal" },
  "POST /goals/:id/approve": { access: "owner", reason: "approves a plan — the decision that releases the goal's work" },
  "POST /goals/:id/reject": { access: "owner", reason: "rejects a plan — the same authority as approval, in the negative" },
  "POST /goals/:id/start": { access: "owner", reason: "compiles an approved plan into work items and dispatches them — the owner's decision to execute" },
  "GET /goals/:id/execution": { access: "read", reason: "reads a goal's execution status" },

  // ── KAI Doer: the autonomy switch ────────────────────────────────────────────
  "GET /doer": { access: "read", reason: "the Doer switch's current state" },
  "POST /doer": { access: "owner", reason: "turns KAI's autonomous execution ON or OFF — the autonomy switch itself" },
  "GET /doer/pending": { access: "read", reason: "the durable pending-result inbox" },

  // ── Pure computations (POST, but they write nothing) ─────────────────────────
  "POST /visual/compile": { access: "read", reason: "compiles structured visual intent; validates and returns, mutating nothing" },
  "POST /visual/validate": { access: "read", reason: "validates a visual intent and returns diagnostics; mutates nothing" },
  "GET /actions": { access: "read", reason: "the persisted action trace" },
  "POST /prompts/compose": { access: "read", reason: "composes the prompt a real turn would send; a pure artifact, nothing executed" },

  // ── Policy ───────────────────────────────────────────────────────────────────
  "GET /policy": { access: "read", reason: "the current policy rules; rewriting them is POST /policy/rules" },
  "POST /policy/rules": {
    access: "owner",
    reason: "REWRITES what KAI is allowed to do (policy.set): changing KAI's own authority is an owner decision",
  },
  "GET /state": { access: "read", reason: "aggregate runtime state" },

  // ── Workforce: employees ─────────────────────────────────────────────────────
  "GET /employees": { access: "read", reason: "the employee registry" },
  "GET /employees/:id": { access: "read", reason: "one employee" },
  "GET /employees/:id/capabilities": { access: "read", reason: "one employee's declared capabilities" },
  "POST /employees/register": { access: "owner", reason: "adds an external worker to KAI's workforce" },
  "POST /employees/:id/enable": { access: "owner", reason: "lifecycle change: makes an employee usable" },
  "POST /employees/:id/disable": { access: "owner", reason: "lifecycle change: removes an employee from service" },
  "POST /employees/:id/recover": { access: "owner", reason: "lifecycle change: restores an employee" },

  // ── Subagents: KAI's own personas and their sessions ─────────────────────────
  "GET /subagents": { access: "read", reason: "the persona catalogue" },
  "GET /subagents/runs": { access: "read", reason: "the tracked runs that are in flight right now" },
  "POST /subagents/runs/:runId/cancel": { access: "owner", reason: "cancels a live run — an act on executing work" },
  "POST /subagents": { access: "owner", reason: "creates a persona (EXTERNAL registrant parks); defining a persona grants it authority" },
  "GET /subagents/:id": { access: "read", reason: "one persona" },
  "POST /subagents/:id": { access: "owner", reason: "edits or creates a persona under an id — a grant" },
  "POST /subagents/:id/duplicate": { access: "owner", reason: "copies a persona, duplicating its authority under a new id" },
  "POST /subagents/:id/archive": { access: "owner", reason: "lifecycle change: retires a persona" },
  "POST /subagents/:id/unarchive": { access: "owner", reason: "lifecycle change: restores a persona" },
  "POST /subagents/:id/run": { access: "owner", reason: "runs a prompt as that persona — it executes work outside this machine" },
  "POST /subagents/:id/sessions": { access: "owner", reason: "creates a persona-owned session (session.manage)" },
  "GET /subagents/:id/sessions/:sessionId/turns": { access: "read", reason: "the turns of one persona's own session" },
  "POST /subagents/:id/message": { access: "owner", reason: "sends a prompt to a persona and executes its reply" },

  // ── Capabilities / agents: the action surfaces ───────────────────────────────
  "GET /capabilities": { access: "read", reason: "the capability registry" },
  "GET /capabilities/:id": { access: "read", reason: "one capability plus a live health MEASUREMENT; it writes no state" },
  "POST /capabilities/:id/test": { access: "owner", reason: "EXECUTES the capability's tool through the registry (EXTERNAL): a real invocation" },
  "GET /agents": { access: "read", reason: "the agent list" },
  "GET /agents/:id": { access: "read", reason: "one agent" },
  "POST /agents/:id/action": { access: "owner", reason: "EXECUTES a registered agent action (EXTERNAL) through the tool boundary" },

  // ── Missions / plans ─────────────────────────────────────────────────────────
  "GET /missions": { access: "read", reason: "the mission list" },
  "POST /missions": { access: "owner", reason: "creates and starts a mission (mission.start)" },
  "GET /missions/:id": { access: "read", reason: "one mission" },
  "POST /missions/:id/cancel": { access: "owner", reason: "cancels a running mission (mission.cancel)" },
  "POST /missions/:id/start": { access: "owner", reason: "starts a mission — it puts work in flight" },
  "POST /plans": { access: "owner", reason: "creates a plan whose steps KAI will execute" },

  // ── Notifications / approvals (a human decision) ─────────────────────────────
  "GET /notifications": { access: "read", reason: "the notification list" },
  "POST /notifications/:id/read": { access: "owner", reason: "writes KAI's own read-flag: a state mutation, so it is owner" },
  "GET /approvals": { access: "read", reason: "the approval queue; deciding one is POST /approvals/:id/decide" },
  "POST /approvals/:id/decide": {
    access: "owner",
    reason:
      "a HUMAN decision: unattested, any local process could approve anything pending and release the parked action behind it, including the switch that enables autonomy",
  },

  // ── Memory ───────────────────────────────────────────────────────────────────
  "GET /memory": { access: "read", reason: "the memory list" },
  "POST /memory": { access: "owner", reason: "creates a durable memory entry (memory.create)" },
  "GET /memory/search": { access: "read", reason: "searches memory" },
  "POST /memory/write": { access: "owner", reason: "appends to canonical memory (memory.write)" },
  "POST /memory/share": { access: "owner", reason: "governed cross-subagent memory share — it widens what another persona can see" },
  "GET /memory/journal": { access: "read", reason: "the memory journal" },
  "GET /memory/:id": { access: "read", reason: "one memory entry" },
  "POST /memory/:id/correct": { access: "owner", reason: "corrects a memory entry (memory.correct)" },
  "POST /memory/:id/delete": { access: "owner", reason: "DESTRUCTIVE: forgets a memory entry (memory.forget)" },

  // ── Skills / staging ─────────────────────────────────────────────────────────
  "GET /skills": { access: "read", reason: "the skill catalogue" },
  "GET /skills/relevant": { access: "read", reason: "skill relevance for a query" },
  "GET /skills/staging": { access: "read", reason: "what is staged for review; installing it is POST .../install" },
  "GET /skills/staging/:stagedId": { access: "read", reason: "one staged skill's contents, for inspection before approving it" },
  "POST /skills/staging/:stagedId/approve": { access: "owner", reason: "approves staged skill content — the human gate on what KAI will load and act on" },
  "POST /skills/staging/:stagedId/install": { access: "owner", reason: "installs a staged skill onto disk (skill.install)" },
  "POST /skills/staging/:stagedId/discard": { access: "owner", reason: "discards staged skill content" },
  "POST /skills/:id/delete": { access: "owner", reason: "DESTRUCTIVE: removes the skill's files from disk (skill.delete)" },
  "POST /skills/:id/disable": { access: "owner", reason: "changes which skills KAI may load (skill.toggle)" },
  "POST /skills/:id/enable": { access: "owner", reason: "grants a skill to KAI (skill.toggle)" },
  "GET /skills/:id/load": { access: "read", reason: "returns one skill's body for loading; it executes nothing itself" },
  "GET /skills/:id": { access: "read", reason: "one skill's metadata" },

  // ── Plugins ──────────────────────────────────────────────────────────────────
  "GET /plugins": { access: "read", reason: "the plugin catalogue" },
  "GET /plugins/:id": { access: "read", reason: "one plugin's record" },
  "POST /plugins/:id/enable": { access: "owner", reason: "lifecycle change: a plugin's code becomes active in KAI (plugin.lifecycle)" },
  "POST /plugins/:id/disable": { access: "owner", reason: "lifecycle change: deactivates a plugin" },
  "POST /plugins/:id/config": { access: "owner", reason: "writes a plugin's configuration (plugin.lifecycle)" },

  // ── Scheduler ────────────────────────────────────────────────────────────────
  "GET /schedules": { access: "read", reason: "the schedule list" },
  "POST /schedules": { access: "owner", reason: "creates a schedule that will run KAI's work unattended (schedule.manage)" },
  "POST /schedules/:id/cancel": { access: "owner", reason: "cancels a schedule (schedule.manage)" },
  "POST /scheduler/recover": { access: "owner", reason: "reconciles scheduler leases — a mutation of live scheduling state" },

  // ── Recovery / checkpoints / learning / maintenance ──────────────────────────
  "GET /recovery/status": { access: "read", reason: "the acceptance ledger's status" },
  "POST /recovery/classify": { access: "read", reason: "reports how the ledger classifies one execution; it writes nothing" },
  "GET /checkpoints": { access: "read", reason: "the checkpoint list" },
  "POST /checkpoints": { access: "owner", reason: "creates a shadow checkpoint (checkpoint.create)" },
  "POST /checkpoints/:id/restore": { access: "owner", reason: "DESTRUCTIVE: OVERWRITES files from a checkpoint (checkpoint.restore)" },
  "POST /learning/propose": { access: "owner", reason: "proposes a behaviour change for KAI to adopt (learning.propose)" },
  "GET /learning/staged": { access: "read", reason: "the staged learning proposals" },
  "POST /learning/staged/:stagedId/approve": { access: "owner", reason: "approves a staged proposal — it changes how KAI will behave" },
  "GET /maintenance/status": { access: "read", reason: "self-maintenance status" },
  "POST /maintenance/run": { access: "owner", reason: "runs a maintenance pass that repairs KAI's own state (maintenance.run)" },

  // ── Conversation sessions ────────────────────────────────────────────────────
  "GET /sessions": { access: "read", reason: "the session list" },
  "GET /sessions/active": { access: "read", reason: "the active session" },
  "POST /sessions": { access: "owner", reason: "creates a session (session.manage)" },
  "GET /sessions/:id/turns": { access: "read", reason: "one session's turns" },
  "GET /sessions/:id": { access: "read", reason: "one session" },
  "POST /sessions/:id/rename": { access: "owner", reason: "mutates a session record" },
  "POST /sessions/:id/archive": { access: "owner", reason: "session lifecycle change (session.manage)" },
  "POST /sessions/:id/unarchive": { access: "owner", reason: "session lifecycle change (session.manage)" },
  "POST /sessions/:id/activate": { access: "owner", reason: "makes a session KAI's active conversation (session.manage)" },

  // ── MCP: the external-system boundary (mcp/routes.ts) ────────────────────────
  "GET /mcp": { access: "owner", reason: "touches MCP: the subsystem surface, whose every entry names or reaches an external server" },
  "GET /mcp/servers": { access: "owner", reason: "touches MCP: the catalogue NAMES the external servers configured on this machine" },
  "POST /mcp/servers": { access: "owner", reason: "touches MCP: registers a new external server (mcp.register; parks by default)" },
  "GET /mcp/servers/:name": { access: "owner", reason: "touches MCP: one external server plus its live connection state" },
  "POST /mcp/servers/:name": { access: "owner", reason: "touches MCP: updates a server's configuration (mcp.update)" },
  "GET /mcp/servers/:name/tools": { access: "owner", reason: "touches MCP: the tools an external server registered into KAI's registry" },
  "GET /mcp/servers/:name/resources": { access: "owner", reason: "touches MCP: lists resources over the LIVE connection to that server" },
  "GET /mcp/servers/:name/resources/read": { access: "owner", reason: "touches MCP: performs resources/read — a remote read from the live connection" },
  "POST /mcp/servers/:name/enable": { access: "owner", reason: "touches MCP: grants an external server's capabilities to KAI (mcp.enable)" },
  "POST /mcp/servers/:name/disable": { access: "owner", reason: "touches MCP: revokes an external server's capabilities (mcp.disable)" },
  "POST /mcp/servers/:name/remove": { access: "owner", reason: "touches MCP: removes an external server registration (mcp.remove)" },
  "POST /mcp/servers/:name/connect": { access: "owner", reason: "touches MCP: opens a connection to an external server process (EXTERNAL; mcp.connect)" },
  "POST /mcp/servers/:name/disconnect": { access: "owner", reason: "touches MCP: closes the connection to an external server (mcp.disconnect)" },
  "POST /mcp/servers/:name/refresh": { access: "owner", reason: "touches MCP: re-discovers an external server's tools into KAI's registry (mcp.refresh)" },
  "POST /mcp/servers/:name/call": { access: "owner", reason: "touches MCP and EXECUTES a tool: invokes the discovered tool under its own risk gate" },
  "GET /mcp/provenance": { access: "owner", reason: "touches MCP: the invocation ledger names every tool KAI called on an external server" },

  // ── Generic tool surface (tools/routes.ts) ───────────────────────────────────
  "GET /tools": { access: "read", reason: "the ONE tool registry's catalogue" },
  "GET /tools/:id": { access: "read", reason: "one registered tool's description" },
  "POST /tools/:id/invoke": {
    access: "owner",
    reason: "EXECUTES a tool by id through the registry (validate -> risk -> policy -> approval -> execute): the generic action boundary",
  },

  // ── Canonical identity model (agent/identity-routes.ts) ──────────────────────
  "GET /identity/model": {
    access: "read",
    reason: "the twelve owner fields over the LIVE subsystems — internal detail, not the public build handshake of GET /identity",
  },
});

/**
 * Splits a request path the way the router does: the query string is dropped first,
 * then empty segments, so "/tools/" resolves exactly as "/tools" and
 * "/goals/g-1?verbose=1" as "/goals/g-1". Both the request path and each policy key
 * are normalized here, so the two can never disagree about segment count.
 */
function segmentsOf(path: string): string[] {
  const withoutQuery = (typeof path === "string" ? path : "/").split("?")[0] ?? "/";
  const out: string[] = [];
  for (const segment of withoutQuery.split("/")) {
    if (segment.length > 0) out.push(segment);
  }
  return out;
}

/**
 * The policy entry for a request, or null when nothing is registered.
 *
 * Matching is the router's (`routes.ts` `match()`): same UPPERCASED method, same
 * segment COUNT, literal segments compared raw, `:name` segments matching anything.
 * Table order decides ties (literals precede the parameter pattern that would
 * swallow them), so a path resolves to the same route the router would dispatch.
 */
export function accessEntryFor(method: string, path: string): AccessPolicyEntry | null {
  const wanted = typeof method === "string" ? method.toUpperCase() : "";
  const actual = segmentsOf(typeof path === "string" ? path : "/");
  for (const key of Object.keys(ACCESS_POLICY)) {
    const space = key.indexOf(" ");
    const entry = ACCESS_POLICY[key];
    if (entry === undefined) continue;
    if (key.slice(0, space) !== wanted) continue;
    const pattern = segmentsOf(key.slice(space + 1));
    if (pattern.length !== actual.length) continue;
    let matched = true;
    for (let i = 0; i < actual.length; i += 1) {
      const p = pattern[i];
      const a = actual[i];
      if (p === undefined || a === undefined) {
        matched = false;
        break;
      }
      if (p.startsWith(":")) continue;
      if (p !== a) {
        matched = false;
        break;
      }
    }
    if (matched) return entry;
  }
  return null;
}

/** The access level of a request's route, or null when no route is registered. */
export function accessFor(method: string, path: string): RouteAccess | null {
  return accessEntryFor(method, path)?.access ?? null;
}

export interface AccessInput {
  method: string;
  path: string;
  /** The caller proved it holds the per-install owner credential. */
  attested?: boolean;
  /** This Core HAS an owner credential to verify against. */
  ownerAuthConfigured?: boolean;
  /** An EXPLICIT developer switch. Never assumed; absence means "absent". */
  devMode?: boolean;
}

export interface AccessDecision {
  allowed: boolean;
  /** 200 allowed, 401 refused for an unattested owner call, 404 unknown route. */
  status: number;
  /** Always states WHICH rule applied — including which of the two allowance paths. */
  reason: string;
}

/** The refusal body `routes.ts` sends for an unattested owner call. */
export const OWNER_AUTH_REQUIRED = "OWNER_AUTH_REQUIRED";

/**
 * Decide one request. Reads and public surfaces are always allowed; an `owner`
 * route requires the owner credential once a credential exists — and the two
 * states that bypass that rule are BOTH named in `reason`, never silent.
 */
export function decideAccess(input: AccessInput): AccessDecision {
  const method = typeof input.method === "string" ? input.method.toUpperCase() : "";
  const path = typeof input.path === "string" ? input.path : "/";
  const entry = accessEntryFor(method, path);
  if (entry === null) {
    return { allowed: false, status: 404, reason: `no route is registered for ${method || "(no method)"} ${path}` };
  }
  if (entry.access === "public") {
    return {
      allowed: true,
      status: 200,
      reason: `public surface: ${entry.reason} — served without any credential`,
    };
  }
  if (entry.access === "read") {
    return { allowed: true, status: 200, reason: `read: ${entry.reason} — reading KAI's state needs no credential` };
  }
  if (input.attested === true) {
    return { allowed: true, status: 200, reason: `owner route allowed: the caller presented the owner credential (${entry.reason})` };
  }
  if (input.devMode === true) {
    return {
      allowed: true,
      status: 200,
      reason: `owner route allowed by EXPLICIT developer mode (devMode=true) — the owner gate is off because a developer asked for it, never by default (${entry.reason})`,
    };
  }
  if (input.ownerAuthConfigured === true) {
    return {
      allowed: false,
      status: 401,
      reason: `this control changes what KAI is authorized to do (${entry.reason}), so it requires the owner credential from the installed desktop app`,
    };
  }
  return {
    allowed: true,
    status: 200,
    reason: `owner route allowed on an UNCONFIGURED Core: no owner credential exists to verify against, so the bare developer Core behaves as it does today (${entry.reason}) — reported here, never silent`,
  };
}
