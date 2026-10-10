// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * KAI Core HTTP API surface.
 *
 * This module is a PURE request -> response function. It owns no socket and no
 * server: `core/src/server.ts` (owned elsewhere) mounts `handle()` behind a real
 * HTTP listener and bridges `attachEventStream()` onto its SSE response. Keeping
 * the routing here means the whole API is testable by calling a function, which
 * is what lets the test suite run with no network and no process.
 *
 * The runtime is taken by INJECTION (typed from `../runtime.ts`, never imported
 * as a value). This module imports no storage, agent or bus module directly —
 * everything it needs it asks the runtime for:
 *
 *   runtime.health()                aggregate status (reused, not re-derived)
 *   runtime.registry.*              agent list + per-agent health
 *   runtime.stores.*                missions / notifications / memory / approvals
 *   runtime.bus.publish/subscribe   events out, SSE frames in
 *   runtime.*.cancel/decide/...     lifecycle actions, so policy stays applied
 *
 * Two rules this file exists to enforce:
 *   - Input errors are RICH. Every 400 names the offending field and why; a
 *     bare "invalid input" is not a reason, and a bad value is never silently
 *     replaced by a default.
 *   - A throwing dependency is a 500 JSON value, never an escaping rejection.
 *     The reason is generic on purpose: an error message can carry a file path,
 *     a token or a stack, and none of that belongs in an HTTP body.
 */

import type { CoreRuntime } from "../runtime.ts";
import { isGoalState, routeTo, type Goal, type GoalState } from "../goals/goal.ts";
import { revisionIdFor } from "../goals/challenger.ts";
import { loadIdentity } from "../identity.ts";
import { createUnavailableEmployee } from "../workforce/employee.ts";
import type { KaiSubagent } from "../workforce/subagent.ts";
import { personaReply } from "../workforce/subagent.ts";
// The canonical scope vocabulary lives in the memory subsystem; importing it (rather
// than keeping a second copy here) is what stops this file from silently disagreeing
// with the authority — a drifting mirror already caused a TS2367 here once.
import { MEMORY_SCOPES, type MemoryScope } from "../memory/model.ts";
import { SKILL_INSTALL_TOOL_ID } from "../skills/staging.ts";
import {
  registerMcpRoutes,
  type McpRouteClassification,
  type McpRouteHandler,
} from "../mcp/routes.ts";
import { registerToolRoutes } from "../tools/routes.ts";
import { registerIdentityRoutes } from "../agent/identity-routes.ts";
import { compileVisual, validateIntent, VISUAL_KINDS, VISUAL_LIMITS } from "../visual/spec.ts";
import { createPlan } from "../plans/plans.ts";
import type { ActionResultState } from "../observability/action-record.ts";
import {
  computeNextRun,
  validateSchedule,
  withScheduleExtensions,
  type ExtendedScheduleKind,
  type ScheduleSpec,
} from "../scheduler/schedule.ts";
import type { TurnEvent } from "../learning/index.ts";
import { readOrchestrationPrefs } from "../orchestration/prefs.ts";
import type {
  AgentStatus,
  ApprovalStatus,
  MemoryType,
  Mission,
  MissionStatus,
  MissionStep,
  ScheduledTask,
} from "../shared/contracts.ts";

// ── Public surface ─────────────────────────────────────────────────────────────

export interface ApiRequest {
  /** "GET", "POST". */
  method: string;
  /** "/missions/abc/cancel" — already stripped of any query string. */
  path: string;
  query: URLSearchParams;
  /** Parsed JSON, or undefined. Untrusted: the caller's types are erased. */
  body?: unknown;
  /**
   * Whether the caller proved it holds the per-install owner credential. The
   * server computes this from the `x-kai-host-token` header; a direct
   * in-process call must pass it explicitly. CORS is NOT authentication and
   * loopback is NOT trust — 127.0.0.1 is reachable by every local process and
   * every local user account on this machine.
   */
  attested?: boolean;
  /**
   * Whether this Core has an owner credential at all. When false, owner-only
   * routes cannot be enforced and are allowed (a bare developer Core); when
   * true, an unattested owner-only request is REFUSED.
   */
  ownerAuthConfigured?: boolean;
}

export interface ApiResponse {
  status: number;
  body: unknown;
}

export interface CoreApi {
  /** Pure request -> response. No sockets, so it is testable directly. */
  handle(request: ApiRequest): Promise<ApiResponse>;
  /** Paths this module serves, for the parent to mount and for docs. */
  routes(): string[];
}

/** Writes SSE frames for bus events and returns an unsubscribe that stops it. */
export function attachEventStream(
  runtime: CoreRuntime,
  res: { write(chunk: string): void; end?: () => void },
): () => void {
  let closed = false;

  const write = (chunk: string): void => {
    if (closed) return;
    try {
      res.write(chunk);
    } catch {
      // A dead subscriber socket is not an error worth surfacing; stop trying.
      closed = true;
    }
  };

  // An initial frame makes the connection observable to the client (and to a
  // browser EventSource, which otherwise stays silent until the first event).
  write(": kai.core event stream connected\n\n");
  write(`data: ${JSON.stringify({ type: "stream.ready" })}\n\n`);

  const off = runtime.bus.subscribe((event) => {
    write(`data: ${JSON.stringify(event)}\n\n`);
  });

  return () => {
    if (closed) return;
    closed = true;
    try {
      off();
    } catch {
      /* the bus already dropped it */
    }
    try {
      res.end?.();
    } catch {
      /* the socket is already gone */
    }
  };
}

// ── The real, frozen enum values (mirrors of shared/contracts.ts) ──────────────
// Declared locally so this file never imports a module it does not own, while
// still validating against exactly the contract's members.

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

const MEMORY_SOURCES = [
  "user_statement",
  "system_state",
  "mission_result",
  "agent_output",
] as const;

const APPROVAL_STATUSES: readonly ApprovalStatus[] = [
  "PENDING",
  "APPROVED",
  "REJECTED",
  "EXPIRED",
];

const STEP_KINDS = ["tool", "agent", "manual"] as const;

/** Defaults for fields the frozen Memory contract requires but the API body may omit. */
const DEFAULT_MEMORY_SOURCE = "user_statement";
const DEFAULT_MEMORY_IMPORTANCE = 3;

// ── Phase 2 enums (mirrors of the subsystem contracts, declared locally) ───────
// Kept here for the same reason as MEMORY_TYPES above: this file validates against
// the exact members without importing a subsystem it does not own.
//
// NOTE: MEMORY_SCOPES is deliberately NOT mirrored here — it is imported from
// ../memory/model.ts above. A local copy drifted (it omitted "subagent") and broke
// the build; the canonical list is the single source of truth.

const MEMORY_PROVENANCES = [
  "user_statement",
  "system_state",
  "mission_result",
  "agent_output",
  "tool_result",
  "model_candidate",
  "upkeep",
  "imported",
  "legacy",
] as const;

/** `weekly` and `cron` are KAI's runtime extensions over the frozen three. */
const EXTENDED_SCHEDULE_KINDS = ["once", "interval", "daily", "weekly", "cron"] as const;

const TURN_KINDS = [
  "user_correction",
  "successful_execution",
  "repeated_workflow",
  "failure_recovery",
  "explicit_instruction",
] as const;

const SHA256_RE = /^[0-9a-f]{64}$/i;

// ── Small helpers ──────────────────────────────────────────────────────────────

type Handler = (req: ApiRequest, params: Record<string, string>) => Promise<ApiResponse>;

interface RouteDef {
  method: string;
  pattern: string;
  /** pattern split on "/", with `:name` segments kept verbatim for matching. */
  segments: string[];
  /** What this route actually does (Part I). Drives its enforcement note. */
  classification: RouteClass;
  /**
   * Owner-only. The route mutates what KAI is AUTHORIZED to do (autonomy, a
   * goal, a plan approval) or releases a parked action, so it is refused unless
   * the caller proved it is the installed desktop app / the owner.
   *
   * Enforced only when the Core actually has an owner credential configured: a
   * Core started without one (a developer running `npm start` directly) cannot
   * check anything, and pretending to refuse would make it unusable. That case
   * is reported honestly in `GET /identity` and in the docs.
   */
  requiresOwner?: boolean;
  handler: Handler;
}

/** Builds a route and its segment list together, so the two cannot drift. */
function route(
  method: string,
  pattern: string,
  classification: RouteClass,
  handler: Handler,
  opts?: { requiresOwner?: boolean },
): RouteDef {
  return {
    method,
    pattern,
    classification,
    segments: pattern.split("/").filter((s) => s.length > 0),
    ...(opts?.requiresOwner === true ? { requiresOwner: true } : {}),
    handler,
  };
}

function bad(reason: string): ApiResponse {
  return { status: 400, body: { error: true, reason } };
}

function notFound(reason: string): ApiResponse {
  return { status: 404, body: { error: true, reason } };
}

function conflict(reason: string): ApiResponse {
  return { status: 409, body: { error: true, reason } };
}

/** Policy said no. Distinct from 409: nothing is pending, the answer was "no". */
function forbidden(reason: string): ApiResponse {
  return { status: 403, body: { error: true, reason } };
}

function ok(body: unknown, status = 200): ApiResponse {
  return { status, body };
}

function query(req: ApiRequest): URLSearchParams {
  // `query` is untrusted at runtime (types are erased): a caller that hands us a
  // string instead of a URLSearchParams must degrade to "no query", not crash.
  return req.query instanceof URLSearchParams ? req.query : new URLSearchParams();
}

function asBodyObject(body: unknown): Record<string, unknown> | null {
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

function parseLimit(
  raw: string | null,
  field: string,
): { ok: true; value: number | undefined } | { ok: false; reason: string } {
  if (raw === null) return { ok: true, value: undefined };
  // Explicit positive-integer check: "abc" and "0" and "-1" are all rejected
  // rather than coerced, so the caller learns what was wrong.
  if (!/^[0-9]+$/.test(raw) || raw === "0") {
    return { ok: false, reason: `"${field}" must be a positive integer; got "${raw}"` };
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    return { ok: false, reason: `"${field}" is out of range; got "${raw}"` };
  }
  return { ok: true, value };
}

function parseUnreadOnly(
  raw: string | null,
): { ok: true; value: boolean | undefined } | { ok: false; reason: string } {
  if (raw === null) return { ok: true, value: undefined };
  if (raw === "true" || raw === "1") return { ok: true, value: true };
  if (raw === "false" || raw === "0") return { ok: true, value: false };
  return { ok: false, reason: `"unreadOnly" must be "true" or "false"; got "${raw}"` };
}

function newId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid !== undefined ? `${prefix}_${uuid}` : `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

// ── Route classification (Phase 2 Part I) ─────────────────────────────────────
//
// Every route is classified by what it ACTUALLY does, and a state-mutating route
// is enforced through the SAME boundary as every other action — the tool
// registry (validate -> risk classification -> policy -> (approval) -> execute).
// There is deliberately no second policy path here: `invokeGate` calls
// `runtime.tools.invoke`, and the registry consults the existing policy engine
// and approval service. The classification drives which routes are gated and how.
//
//   READ         reads state. Executes directly.
//   WRITE        mutates KAI's own reversible state (memory, missions, schedules,
//                employees, approvals, checkpoints, learning). Policy decides:
//                KAI's own internal-state rule authorizes the low-consequence
//                ones; the more consequential ones park for a human.
//   EXTERNAL     causes another process to act. Policy decides; default park.
//   DESTRUCTIVE  overwrites or removes files / installed artifacts. Default park.
//
// The tool ids below MIRROR `MUTATION_TOOLS` in runtime.ts rather than importing
// it: this module is a pure function of an INJECTED runtime and must not import
// runtime.ts as a value. A test asserts every id here is registered by the real
// runtime, so the two cannot drift.

type RouteClass = "READ" | "WRITE" | "EXTERNAL" | "DESTRUCTIVE";

/** The canonical memory engine's write result, read structurally off the runtime. */
type EngineWriteResult = ReturnType<CoreRuntime["memoryEngine"]["write"]>;

/** A skills registry result, read structurally off the runtime. */
type SkillResultLike = ReturnType<CoreRuntime["skills"]["enable"]>;

export const MUTATION_TOOL_IDS = {
  memoryWrite: "memory.write",
  memoryCreate: "memory.create",
  /** Governed cross-subagent memory share — the SAME id runtime.ts registers. */
  memoryShare: "memory.share",
  /** Start an approved plan — the SAME id runtime.ts registers. */
  missionStart: "mission.start",
  /** Correct a memory entry — the SAME id runtime.ts registers. */
  memoryCorrect: "memory.correct",
  /** Forget a memory entry (DESTRUCTIVE, parks) — the SAME id runtime.ts registers. */
  memoryForget: "memory.forget",
  /** Replace KAI's soul (parks by default) — the SAME id runtime.ts registers. */
  soulSet: "soul.set",
  /** Change KAI's own settings (parks by default) — the SAME id runtime.ts registers. */
  settingsUpdate: "settings.update",
  /** Stop KAI's autonomous execution (authority-reducing: applies immediately). */
  doerSet: "doer.set",
  notificationRead: "notification.read",
  approvalDecide: "approval.decide",
  workforceRegister: "workforce.register",
  workforceLifecycle: "workforce.lifecycle",
  /** Define/replace a KAI subagent persona — the SAME id runtime.ts registers. */
  subagentCreate: "workforce.subagent",
  missionCancel: "mission.cancel",
  scheduleManage: "schedule.manage",
  schedulerRecover: "scheduler.recover",
  learningPropose: "learning.propose",
  checkpointCreate: "checkpoint.create",
  checkpointRestore: "checkpoint.restore",
  skillDelete: "skill.delete",
  skillToggle: "skill.toggle",
  /** Plugin lifecycle — the SAME id runtime.ts registers. */
  pluginLifecycle: "plugin.lifecycle",
  policySet: "policy.set",
  sessionManage: "session.manage",
  maintenanceRun: "maintenance.run",
} as const;

/** Body `approvalId`, when present and a non-empty string. */
function approvalIdOf(body: Record<string, unknown> | null): string | undefined {
  if (body === null) return undefined;
  const value = body.approvalId;
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/**
 * Run one state-mutating action through the one tool registry. A refusal is a
 * value: APPROVAL_REQUIRED becomes 409 `{approvalRequired, approvalId}` and does
 * NOT act; POLICY_DENIED becomes 403; NOT_FOUND 404; VALIDATION_FAILED 400. The
 * caller performs nothing until this returns `ok: true`.
 */
async function invokeGate(
  runtime: CoreRuntime,
  toolId: string,
  input: unknown,
  approvalId?: string,
): Promise<{ ok: true; result: unknown } | { ok: false; response: ApiResponse }> {
  const invoked = await runtime.tools.invoke(
    toolId,
    input,
    approvalId !== undefined ? { approvalId } : undefined,
  );
  if (invoked.ok) return { ok: true, result: invoked.result };
  const error = invoked.error;
  switch (error.code) {
    case "APPROVAL_REQUIRED":
      return {
        ok: false,
        response: {
          status: 409,
          body: {
            error: true,
            reason: error.message,
            approvalRequired: true,
            approvalId: error.detail ?? null,
          },
        },
      };
    case "POLICY_DENIED":
      return { ok: false, response: forbidden(error.message) };
    case "NOT_FOUND":
      return { ok: false, response: notFound(error.message) };
    case "VALIDATION_FAILED":
      return { ok: false, response: bad(error.message) };
    default:
      return {
        ok: false,
        response: {
          status: 500,
          body: { error: true, reason: "internal error while handling a state-mutating route" },
        },
      };
  }
}

// ── The API ────────────────────────────────────────────────────────────────────

export function createCoreApi(runtime: CoreRuntime): CoreApi {
  // ── GET /state ───────────────────────────────────────────────────────────────
  async function getState(): Promise<ApiResponse> {
    // Reuse the runtime's aggregate rather than re-deriving it, and add only the
    // two things it lacks: per-agent HEALTH (health() carries status only) and
    // the total scheduled-task count (health() reports enabled only).
    const health = await runtime.health();
    const agentHealth = await runtime.registry.healthAll();

    const agents = health.agents.map((a: AgentStatus) => {
      const probe = agentHealth[a.id];
      return probe === undefined
        ? { id: a.id, state: a.state }
        : { id: a.id, state: a.state, health: probe };
    });

    const scheduledTotal = runtime.stores.scheduledTasks.listScheduledTasks().length;

    return ok({
      ...health,
      agents,
      scheduler: { ...health.scheduler, total: scheduledTotal },
    });
  }

  // ── GET /agents ──────────────────────────────────────────────────────────────
  async function listAgents(): Promise<ApiResponse> {
    return ok({ agents: await runtime.registry.statusAll() });
  }

  // ── GET /agents/:id ──────────────────────────────────────────────────────────
  async function getAgent(params: Record<string, string>): Promise<ApiResponse> {
    const id = params.id ?? "";
    const agents = await runtime.registry.statusAll();
    const found = agents.find((a) => a.id === id);
    if (found === undefined) return notFound(`no agent registered as "${id}"`);
    return ok({ agent: found });
  }

  // ── POST /visual/compile ─────────────────────────────────────────────────────
  // The KAI-owned visual-intent seam. Raw dialect text (model output) goes in; a
  // VALIDATED, bounded, typed intent comes out — or a rich 400 that names why it
  // was refused. Model text never reaches a renderer unvalidated: this route is
  // the boundary, and every renderer sits downstream of it.
  async function compileVisualHandler(req: ApiRequest): Promise<ApiResponse> {
    const body = asBodyObject(req.body);
    if (body === null) return bad('"body" must be a JSON object with a "source"');
    if (typeof body.source !== "string" || body.source.trim().length === 0) {
      return bad('"source" must be a non-empty string');
    }
    if (body.source.length > VISUAL_LIMITS.maxSourceChars) {
      return bad(`"source" must be at most ${VISUAL_LIMITS.maxSourceChars} characters; got ${body.source.length}`);
    }
    // Dispatch on the declared kind rather than hard-coding "flow": the engine now
    // renders a closed union (`flow` | `sequence`), and this route is the boundary
    // that has to keep up with it. `VISUAL_KINDS` is the ONE list — importing it
    // instead of repeating the value here is what stops the two drifting apart.
    if (body.kind !== undefined && !(VISUAL_KINDS as readonly string[]).includes(body.kind as string)) {
      return bad(`"kind" must be one of ${VISUAL_KINDS.join(", ")} when present; got ${JSON.stringify(body.kind)}`);
    }
    const result = compileVisual(body.source);
    if (!result.ok) {
      return { status: 400, body: { error: true, reason: result.reason, code: result.code, rejected: true } };
    }
    return ok({ intent: result.intent });
  }

  // ── POST /visual/validate ────────────────────────────────────────────────────
  // The validator as a standalone boundary: a caller that already holds a
  // structured intent can have it checked before anything draws it. A malformed
  // structure is refused with the offending field named — never repaired.
  async function validateVisualHandler(req: ApiRequest): Promise<ApiResponse> {
    const body = asBodyObject(req.body);
    if (body === null) return bad('"body" must be a JSON object with an "intent"');
    const raw = body.intent !== undefined ? body.intent : body;
    const result = validateIntent(raw);
    if (!result.ok) {
      return { status: 400, body: { error: true, reason: result.reason, code: result.code, rejected: true } };
    }
    return ok({ intent: result.intent });
  }

  // ── GET /missions ────────────────────────────────────────────────────────────
  async function listMissions(req: ApiRequest): Promise<ApiResponse> {
    const q = query(req);
    const statusRaw = q.get("status");
    let status: MissionStatus | undefined;
    if (statusRaw !== null) {
      if (!(MISSION_STATUSES as readonly string[]).includes(statusRaw)) {
        return bad(
          `"status" must be one of ${MISSION_STATUSES.join(", ")}; got "${statusRaw}"`,
        );
      }
      status = statusRaw as MissionStatus;
    }
    const limit = parseLimit(q.get("limit"), "limit");
    if (!limit.ok) return bad(limit.reason);

    const opts: { status?: MissionStatus; limit?: number } = {};
    if (status !== undefined) opts.status = status;
    if (limit.value !== undefined) opts.limit = limit.value;

    return ok({ missions: runtime.stores.missions.listMissions(opts) });
  }

  // ── GET /missions/:id ────────────────────────────────────────────────────────
  async function getMission(params: Record<string, string>): Promise<ApiResponse> {
    const id = params.id ?? "";
    const mission = runtime.stores.missions.getMission(id);
    if (mission === null) return notFound(`mission "${id}" does not exist`);
    return ok({ mission });
  }

  // ── POST /missions ───────────────────────────────────────────────────────────
  async function createMissionHandler(req: ApiRequest): Promise<ApiResponse> {
    // Captured before any awaits: the record's start is when the CALL arrived,
    // not when the insert finished.
    const startedAt = new Date().toISOString();
    const body = asBodyObject(req.body);
    if (body === null) {
      return bad('"body" must be a JSON object with a "title"');
    }

    if (typeof body.title !== "string" || body.title.trim().length === 0) {
      return bad('"title" must be a non-empty string');
    }
    const title = body.title;

    let description: string | undefined;
    if (body.description !== undefined) {
      if (typeof body.description !== "string") {
        return bad('"description" must be a string when present');
      }
      description = body.description;
    }

    const steps: Array<{
      title: string;
      kind: "tool" | "agent" | "manual";
      target?: string;
      input?: Record<string, unknown>;
      sideEffecting?: boolean;
    }> = [];

    if (body.steps !== undefined) {
      if (!Array.isArray(body.steps)) {
        return bad('"steps" must be an array when present');
      }
      for (let i = 0; i < body.steps.length; i += 1) {
        const raw = body.steps[i];
        const step = asBodyObject(raw);
        if (step === null) {
          return bad(`"steps[${i}]" must be an object`);
        }
        if (typeof step.kind !== "string" || !(STEP_KINDS as readonly string[]).includes(step.kind)) {
          return bad(
            `"steps[${i}].kind" must be one of ${STEP_KINDS.join(", ")}; got ${JSON.stringify(step.kind)}`,
          );
        }
        if (typeof step.title !== "string" || step.title.trim().length === 0) {
          return bad(`"steps[${i}].title" must be a non-empty string`);
        }
        const built: (typeof steps)[number] = {
          title: step.title,
          kind: step.kind as "tool" | "agent" | "manual",
        };
        if (step.target !== undefined) {
          if (typeof step.target !== "string") {
            return bad(`"steps[${i}].target" must be a string when present`);
          }
          built.target = step.target;
        }
        if (step.input !== undefined) {
          const inputObj = asBodyObject(step.input);
          if (inputObj === null) {
            return bad(`"steps[${i}].input" must be an object when present`);
          }
          built.input = inputObj;
        }
        if (step.sideEffecting !== undefined) {
          if (typeof step.sideEffecting !== "boolean") {
            return bad(`"steps[${i}].sideEffecting" must be a boolean when present`);
          }
          built.sideEffecting = step.sideEffecting;
        }
        steps.push(built);
      }
    }

    const input: {
      title: string;
      description?: string;
      steps: typeof steps;
    } = { title, steps };
    if (description !== undefined) input.description = description;

    const mission: Mission = await runtime.createAndStartMission(input);
    return ok({ mission }, 201);
  }

  // ── POST /missions/:id/start — the approve-to-work transition ─────────────
  //
  // Starts an approved plan (DRAFT -> QUEUED -> RUNNING) through the boundary.
  // Starting is orchestration; every step still meets policy individually when
  // it runs, parking where a human must answer. A terminal mission is left
  // as-is by the executor's own idempotence.
  async function startMission(req: ApiRequest, params: Record<string, string>): Promise<ApiResponse> {
    const id = params.id ?? "";
    const existing = runtime.stores.missions.getMission(id);
    if (existing === null) return notFound(`mission "${id}" does not exist`);
    const gated = await invokeGate(
      runtime,
      MUTATION_TOOL_IDS.missionStart,
      { id },
      approvalIdOf(asBodyObject(req.body)),
    );
    if (!gated.ok) return gated.response;
    return ok({ mission: gated.result });
  }

  // ── POST /plans — generate a structured plan from a goal (Plan Mode) ──────
  //
  // The model plans (structured output, validated against the live tool and
  // agent registries) and the result persists as a DRAFT mission that runs
  // nothing. Planning executes no tools and mutates no world state — the
  // brain's READ-only plane is all the model sees during planning.
  async function createPlanHandler(req: ApiRequest): Promise<ApiResponse> {
    const body = asBodyObject(req.body);
    if (body === null || typeof body.goal !== "string" || body.goal.trim().length === 0) {
      return bad('"body" must be a JSON object with a non-empty string "goal"');
    }
    const subagents = runtime.subagents.list().map((persona) => persona.spec.id);
    const workers = (await runtime.registry.statusAll().catch(() => [] as Array<{ id: string }>)).map((w) => w.id);
    const outcome = await createPlan(body.goal, {
      model: runtime.model,
      tools: runtime.tools,
      agentIds: [...subagents, ...workers],
      upsertMission: (mission) => runtime.stores.missions.upsertMission(mission),
      publish: (type, payload, opts) => runtime.bus.publish(type, payload, { source: "core", ...(opts?.missionId !== undefined ? { missionId: opts.missionId } : {}) }),
    });
    if (!outcome.ok) {
      const unavailable = /unavailable|unconfigured|not configured/i.test(outcome.reason);
      return { status: unavailable ? 503 : 422, body: { error: true, reason: outcome.reason } };
    }
    return ok({ mission: outcome.mission }, 201);
  }

  // ── POST /missions/:id/cancel ────────────────────────────────────────────────
  async function cancelMission(req: ApiRequest, params: Record<string, string>): Promise<ApiResponse> {
    const id = params.id ?? "";
    const existing = runtime.stores.missions.getMission(id);
    if (existing === null) return notFound(`mission "${id}" does not exist`);
    // WRITE (KAI's own mission state): through the boundary. The TOOL calls the
    // executor, which owns the transition (and its idempotence + event), so the
    // two can never disagree and the route never writes CANCELLED itself.
    const gated = await invokeGate(
      runtime,
      MUTATION_TOOL_IDS.missionCancel,
      { id },
      approvalIdOf(asBodyObject(req.body)),
    );
    if (!gated.ok) return gated.response;
    return ok({ mission: gated.result });
  }

  // ── GET /notifications ───────────────────────────────────────────────────────
  async function listNotifications(req: ApiRequest): Promise<ApiResponse> {
    const q = query(req);
    const unreadOnly = parseUnreadOnly(q.get("unreadOnly"));
    if (!unreadOnly.ok) return bad(unreadOnly.reason);
    const limit = parseLimit(q.get("limit"), "limit");
    if (!limit.ok) return bad(limit.reason);

    const opts: { unreadOnly?: boolean; limit?: number } = {};
    if (unreadOnly.value !== undefined) opts.unreadOnly = unreadOnly.value;
    if (limit.value !== undefined) opts.limit = limit.value;

    return ok({ notifications: runtime.notifications.list(opts) });
  }

  // ── POST /notifications/:id/read ─────────────────────────────────────────────
  async function markNotificationRead(req: ApiRequest, params: Record<string, string>): Promise<ApiResponse> {
    const id = params.id ?? "";
    const existing = runtime.stores.notifications.getNotification(id);
    if (existing === null) return notFound(`notification "${id}" does not exist`);
    // WRITE (KAI's own read-flag): through the boundary, authorized by default.
    const gated = await invokeGate(
      runtime,
      MUTATION_TOOL_IDS.notificationRead,
      { id },
      approvalIdOf(asBodyObject(req.body)),
    );
    if (!gated.ok) return gated.response;
    const updated = runtime.stores.notifications.getNotification(id) ?? { ...existing, read: true };
    return ok({ notification: updated });
  }

  // ── GET /approvals ───────────────────────────────────────────────────────────
  async function listApprovals(req: ApiRequest): Promise<ApiResponse> {
    const q = query(req);
    const statusRaw = q.get("status");
    let status: ApprovalStatus | undefined;
    if (statusRaw !== null) {
      if (!(APPROVAL_STATUSES as readonly string[]).includes(statusRaw)) {
        return bad(
          `"status" must be one of ${APPROVAL_STATUSES.join(", ")}; got "${statusRaw}"`,
        );
      }
      status = statusRaw as ApprovalStatus;
    }
    const opts: { status?: ApprovalStatus } = {};
    if (status !== undefined) opts.status = status;
    return ok({ approvals: runtime.approvals.list(opts) });
  }

  // ── POST /approvals/:id/decide ───────────────────────────────────────────────
  async function decideApproval(req: ApiRequest, params: Record<string, string>): Promise<ApiResponse> {
    const id = params.id ?? "";
    const body = asBodyObject(req.body);
    if (body === null) {
      return bad('"body" must be a JSON object with a boolean "approved"');
    }
    if (typeof body.approved !== "boolean") {
      return bad(
        `"approved" must be a boolean (true or false); got ${JSON.stringify(body.approved)}`,
      );
    }

    const existing = runtime.approvals.get(id);
    if (existing === null) return notFound(`approval "${id}" does not exist`);
    if (existing.status !== "PENDING") {
      return conflict(
        `approval "${id}" is already ${existing.status}; a decided approval cannot be changed`,
      );
    }

    // Deciding and settling are one call on the runtime (Phase 1 Part H): a
    // mission parked on this approval must receive a terminal outcome rather
    // than the approval merely being marked. The decision itself is KAI's own
    // bookkeeping (WRITE), so it goes through the boundary and is authorized by
    // the internal-state rule — it is the human's answer, not an action KAI took.
    const gated = await invokeGate(
      runtime,
      MUTATION_TOOL_IDS.approvalDecide,
      { id, approved: body.approved },
      approvalIdOf(body),
    );
    if (!gated.ok) return gated.response;
    const settled = gated.result as { approved: boolean; missionId?: string; resumed: boolean; reissued?: boolean; result?: unknown };
    const decided = runtime.approvals.get(id);
    if (decided === null || decided.status === "PENDING") {
      return conflict(`approval "${id}" could not be decided`);
    }
    return ok({
      approval: decided,
      ...(settled.missionId !== undefined
        ? { missionId: settled.missionId, missionResumed: settled.resumed }
        : {}),
      // The non-mission path: a parked request was re-issued (or not) after the
      // verdict. `reissued: true` is the proof that "Allow" ran the work rather
      // than merely recording a verdict.
      ...(settled.reissued !== undefined ? { reissued: settled.reissued, result: settled.result ?? null } : {}),
    });
  }

  // ── GET /memory ──────────────────────────────────────────────────────────────
  async function listMemory(req: ApiRequest): Promise<ApiResponse> {
    const q = query(req);
    const typeRaw = q.get("type");
    let type: MemoryType | undefined;
    if (typeRaw !== null) {
      if (!(MEMORY_TYPES as readonly string[]).includes(typeRaw)) {
        return bad(`"type" must be one of ${MEMORY_TYPES.join(", ")}; got "${typeRaw}"`);
      }
      type = typeRaw as MemoryType;
    }
    const limit = parseLimit(q.get("limit"), "limit");
    if (!limit.ok) return bad(limit.reason);

    const opts: { type?: MemoryType; limit?: number } = {};
    if (type !== undefined) opts.type = type;
    if (limit.value !== undefined) opts.limit = limit.value;

    return ok({ memories: runtime.stores.memory.listMemories(opts) });
  }

  // ── POST /memory ─────────────────────────────────────────────────────────────
  async function createMemoryHandler(req: ApiRequest): Promise<ApiResponse> {
    const body = asBodyObject(req.body);
    if (body === null) {
      return bad('"body" must be a JSON object with a "type" and "content"');
    }

    if (typeof body.type !== "string" || !(MEMORY_TYPES as readonly string[]).includes(body.type)) {
      return bad(
        `"type" must be one of ${MEMORY_TYPES.join(", ")}; got ${JSON.stringify(body.type)}`,
      );
    }
    if (typeof body.content !== "string" || body.content.trim().length === 0) {
      return bad('"content" must be a non-empty string');
    }

    let importance = DEFAULT_MEMORY_IMPORTANCE;
    if (body.importance !== undefined) {
      if (
        typeof body.importance !== "number" ||
        !Number.isInteger(body.importance) ||
        body.importance < 1 ||
        body.importance > 5
      ) {
        return bad(
          `"importance" must be an integer between 1 and 5; got ${JSON.stringify(body.importance)}`,
        );
      }
      importance = body.importance;
    }

    let source: (typeof MEMORY_SOURCES)[number] = DEFAULT_MEMORY_SOURCE;
    if (body.source !== undefined) {
      if (
        typeof body.source !== "string" ||
        !(MEMORY_SOURCES as readonly string[]).includes(body.source)
      ) {
        return bad(
          `"source" must be one of ${MEMORY_SOURCES.join(", ")}; got ${JSON.stringify(body.source)}`,
        );
      }
      source = body.source as (typeof MEMORY_SOURCES)[number];
    }

    let metadata: Record<string, unknown> | undefined;
    if (body.metadata !== undefined) {
      const metaObj = asBodyObject(body.metadata);
      if (metaObj === null) {
        return bad('"metadata" must be an object when present');
      }
      metadata = metaObj;
    }

    const at = new Date().toISOString();
    const memory = {
      id: newId("mem"),
      type: body.type as MemoryType,
      content: body.content,
      source,
      importance,
      createdAt: at,
      updatedAt: at,
      ...(metadata !== undefined ? { metadata } : {}),
    };

    // WRITE: appending to KAI's own memory store goes through the boundary. The
    // low-consequence, reversible append is authorized by KAI's internal-state
    // rule by default, so it still completes without a human.
    const gated = await invokeGate(runtime, MUTATION_TOOL_IDS.memoryCreate, memory, approvalIdOf(body));
    if (!gated.ok) return gated.response;
    return ok({ memory }, 201);
  }

  // ── Memory engine (Phase 2 Part B): read / write / search / journal ─────────
  //
  // The legacy GET/POST /memory above keep serving the flat `memories` table
  // unchanged — those clients are not broken. These routes reach the LIVE memory
  // engine instead: the canonical store the composed prompt recalls from and the
  // one that survives a restart. A refusal is a value (bounds, secret shape,
  // duplicate, scope) and maps to the same rich 4xx shape the rest of this file
  // uses; a caller cannot widen a scope or skip redaction, because the engine owns
  // both and this module never touches the store directly.

  async function searchMemory(req: ApiRequest): Promise<ApiResponse> {
    const q = query(req);
    const rawText = q.get("q") ?? q.get("text");
    const limit = parseLimit(q.get("limit"), "limit");
    if (!limit.ok) return bad(limit.reason);

    const typeRaw = q.get("type");
    let types: MemoryType[] | undefined;
    if (typeRaw !== null) {
      if (!(MEMORY_TYPES as readonly string[]).includes(typeRaw)) {
        return bad(`"type" must be one of ${MEMORY_TYPES.join(", ")}; got "${typeRaw}"`);
      }
      types = [typeRaw as MemoryType];
    }

    // An optional scope narrows recall to the shared global bucket PLUS one
    // private scope the runtime can genuinely honour. A scope with no producer is
    // refused rather than silently ignored.
    let scope: MemoryScope | undefined;
    const scopeRaw = q.get("scope");
    if (scopeRaw !== null) {
      if (!(MEMORY_SCOPES as readonly string[]).includes(scopeRaw)) {
        return bad(`"scope" must be one of ${MEMORY_SCOPES.join(", ")}; got "${scopeRaw}"`);
      }
      scope = scopeRaw as MemoryScope;
    }
    const scopeIdRaw = q.get("scopeId") ?? undefined;
    if (scope !== undefined) {
      const resolved = runtime.resolveMemoryScope({
        scope,
        ...(scopeIdRaw !== undefined ? { scopeId: scopeIdRaw } : {}),
      });
      if (!resolved.ok) {
        return { status: 400, body: { error: true, reason: resolved.reason, code: resolved.code } };
      }
    }

    // A `subagent:<id>` search uses the PERSONA-AWARE recall: the subagent's own
    // bucket plus ONLY the entries explicitly shared TO it — never another
    // subagent's private bucket. Every other scope uses global+one-bucket recall.
    const hits =
      scope === "subagent"
        ? runtime.recallForSubagent(scopeIdRaw ?? "", {
            ...(rawText !== null && rawText.length > 0 ? { text: rawText } : {}),
            ...(limit.value !== undefined ? { limit: limit.value } : {}),
            ...(types !== undefined ? { types } : {}),
          })
        : runtime.recallScoped({
            ...(scope !== undefined ? { scope } : {}),
            ...(scopeIdRaw !== undefined ? { scopeId: scopeIdRaw } : {}),
            ...(rawText !== null && rawText.length > 0 ? { text: rawText } : {}),
            ...(limit.value !== undefined ? { limit: limit.value } : {}),
            ...(types !== undefined ? { types } : {}),
          });

    return ok({ hits });
  }

  async function writeMemoryHandler(req: ApiRequest): Promise<ApiResponse> {
    const body = asBodyObject(req.body);
    if (body === null) {
      return bad('"body" must be a JSON object with a "content"');
    }
    if (typeof body.content !== "string" || body.content.trim().length === 0) {
      return bad('"content" must be a non-empty string');
    }

    let type: MemoryType | undefined;
    if (body.type !== undefined) {
      if (typeof body.type !== "string" || !(MEMORY_TYPES as readonly string[]).includes(body.type)) {
        return bad(`"type" must be one of ${MEMORY_TYPES.join(", ")}; got ${JSON.stringify(body.type)}`);
      }
      type = body.type as MemoryType;
    }

    let importance: number | undefined;
    if (body.importance !== undefined) {
      if (
        typeof body.importance !== "number" ||
        !Number.isInteger(body.importance) ||
        body.importance < 1 ||
        body.importance > 5
      ) {
        return bad(`"importance" must be an integer between 1 and 5; got ${JSON.stringify(body.importance)}`);
      }
      importance = body.importance;
    }

    let scope: MemoryScope | undefined;
    if (body.scope !== undefined) {
      if (typeof body.scope !== "string" || !(MEMORY_SCOPES as readonly string[]).includes(body.scope)) {
        return bad(`"scope" must be one of ${MEMORY_SCOPES.join(", ")}; got ${JSON.stringify(body.scope)}`);
      }
      scope = body.scope as MemoryScope;
    }

    let scopeId: string | undefined;
    if (body.scopeId !== undefined) {
      if (typeof body.scopeId !== "string" || body.scopeId.trim().length === 0) {
        return bad('"scopeId" must be a non-empty string when present');
      }
      scopeId = body.scopeId;
    }

    let provenance: (typeof MEMORY_PROVENANCES)[number] | undefined;
    if (body.provenance !== undefined) {
      if (
        typeof body.provenance !== "string" ||
        !(MEMORY_PROVENANCES as readonly string[]).includes(body.provenance)
      ) {
        return bad(
          `"provenance" must be one of ${MEMORY_PROVENANCES.join(", ")}; got ${JSON.stringify(body.provenance)}`,
        );
      }
      provenance = body.provenance as (typeof MEMORY_PROVENANCES)[number];
    }

    let source: (typeof MEMORY_SOURCES)[number] | undefined;
    if (body.source !== undefined) {
      if (typeof body.source !== "string" || !(MEMORY_SOURCES as readonly string[]).includes(body.source)) {
        return bad(`"source" must be one of ${MEMORY_SOURCES.join(", ")}; got ${JSON.stringify(body.source)}`);
      }
      source = body.source as (typeof MEMORY_SOURCES)[number];
    }

    // ── Provenance is host-attested, never caller-claimed ────────────────────
    // This route is an EXTERNAL boundary: a caller over HTTP is not the user, so
    // `user_statement` — user authority — cannot be bought here any more than
    // `source: "user"` can on /learning/propose. It is REFUSED rather than
    // silently downgraded, so a caller is never left believing its fact was
    // recorded as the user's own. (An omitted provenance defaults to the
    // restrictive value in the engine, not to user authority.)
    if (provenance === "user_statement" || source === "user_statement") {
      return bad(
        '"provenance"/"source": "user_statement" is host-attested and cannot be claimed over HTTP; an external write is recorded without user authority',
      );
    }

    let until: string | undefined;
    if (body.until !== undefined) {
      if (typeof body.until !== "string" || Number.isNaN(Date.parse(body.until))) {
        return bad('"until" must be a parseable ISO-8601 timestamp when present');
      }
      until = body.until;
    }

    let metadata: Record<string, unknown> | undefined;
    if (body.metadata !== undefined) {
      const metaObj = asBodyObject(body.metadata);
      if (metaObj === null) return bad('"metadata" must be an object when present');
      metadata = metaObj;
    }

    // Part H: a scope is only honoured when the runtime really has a producer for
    // it. `session`/`project` have none, so they are refused with the reason
    // rather than silently accepted into a bucket nothing will ever recall.
    const resolved = runtime.resolveMemoryScope({
      scope: scope ?? "global",
      ...(scopeId !== undefined ? { scopeId } : {}),
    });
    if (!resolved.ok) {
      return { status: 400, body: { error: true, reason: resolved.reason, code: resolved.code } };
    }

    // WRITE: the canonical append runs through the boundary. `rememberScoped`
    // (behind the memory.write tool) binds the fact to a real mission/employee,
    // and KAI's internal-state rule authorizes the reversible append.
    const gated = await invokeGate(
      runtime,
      MUTATION_TOOL_IDS.memoryWrite,
      {
        content: body.content,
        ...(type !== undefined ? { type } : {}),
        ...(importance !== undefined ? { importance } : {}),
        scope: resolved.scope,
        ...(resolved.scope !== "global" ? { scopeId: resolved.scopeId } : {}),
        ...(provenance !== undefined ? { provenance } : {}),
        ...(source !== undefined ? { source } : {}),
        ...(until !== undefined ? { until } : {}),
        ...(metadata !== undefined ? { metadata } : {}),
      },
      approvalIdOf(body),
    );
    if (!gated.ok) return gated.response;

    const result = gated.result as EngineWriteResult;
    if (!result.ok) {
      const code = result.refusal.kaiError.code;
      const status = code === "POLICY_DENIED" ? 403 : code === "NOT_FOUND" ? 404 : 400;
      return {
        status,
        body: {
          error: true,
          reason: result.refusal.detail,
          code: result.refusal.kaiError.detail ?? result.refusal.reason,
        },
      };
    }

    return ok({ memory: result.entry, deduped: result.deduped }, 201);
  }

  /**
   * POST /memory/share — the governed cross-subagent grant.
   *
   * The ONLY way one persona's private fact reaches another: ONE named entry from
   * ONE persona to ONE persona, backed by a real KAI approval. It is WRITE and
   * deliberately NOT in KAI_INTERNAL_STATE_TOOLS, so the default policy PARKS it
   * for a human: the first call returns 409 + an approvalId, and the caller
   * re-issues with that id once it has been decided. There is no broad "grant
   * everything" shape — a request names exactly the entry to move, and the runtime
   * refuses one that is not private to the named source.
   */
  async function shareMemoryHandler(req: ApiRequest): Promise<ApiResponse> {
    const body = asBodyObject(req.body);
    if (body === null) return bad('"body" must be a JSON object');
    const fromSubagent = typeof body.fromSubagent === "string" ? body.fromSubagent.trim() : "";
    const toSubagent = typeof body.toSubagent === "string" ? body.toSubagent.trim() : "";
    const entryId = typeof body.entryId === "string" ? body.entryId.trim() : "";
    if (fromSubagent.length === 0) return bad('"fromSubagent" must be a non-empty subagent id');
    if (toSubagent.length === 0) return bad('"toSubagent" must be a non-empty subagent id');
    if (entryId.length === 0) return bad('"entryId" must be a non-empty memory entry id');
    if (body.reason !== undefined && typeof body.reason !== "string") {
      return bad('"reason" must be a string when present');
    }

    const approvalId = approvalIdOf(body);
    const gated = await invokeGate(
      runtime,
      MUTATION_TOOL_IDS.memoryShare,
      {
        fromSubagent,
        toSubagent,
        entryId,
        // The decided approval travels INTO the input so the share record itself
        // carries the KAI approval that authorised it (a tool body only ever sees
        // the validated input, never the invoke options).
        ...(approvalId !== undefined ? { approvalId } : {}),
        ...(typeof body.reason === "string" && body.reason.length > 0 ? { reason: body.reason } : {}),
      },
      approvalId,
    );
    if (!gated.ok) return gated.response;

    const result = gated.result as { ok: true; share: unknown } | { ok: false; reason: string };
    if (result.ok === false) return conflict(result.reason);
    return ok({ share: result.share }, 201);
  }

  async function getMemoryEngineEntry(params: Record<string, string>): Promise<ApiResponse> {
    const id = params.id ?? "";
    const entry = runtime.memoryEngine.get(id);
    if (entry === null) return notFound(`memory "${id}" does not exist`);
    return ok({ memory: entry });
  }

  async function memoryJournal(req: ApiRequest): Promise<ApiResponse> {
    const q = query(req);
    const limit = parseLimit(q.get("limit"), "limit");
    if (!limit.ok) return bad(limit.reason);
    const entryId = q.get("entryId");
    const opts: NonNullable<Parameters<typeof runtime.memoryEngine.journal>[0]> = {};
    if (limit.value !== undefined) opts.limit = limit.value;
    if (entryId !== null && entryId.length > 0) opts.entryId = entryId;
    return ok({ journal: runtime.memoryEngine.journal(opts) });
  }

  // ── POST /memory/:id/correct — edit content/type/importance/confidence ─────
  //
  // WRITE through the boundary (`memory.correct` is internal-state, so a plain
  // correction completes; the engine journals it). Identity (id/scope) is never
  // editable — the tool validator refuses anything else.
  async function correctMemoryHandler(req: ApiRequest, params: Record<string, string>): Promise<ApiResponse> {
    const id = params.id ?? "";
    if (id.length === 0) return bad('"id" must be a non-empty memory entry id');
    const body = asBodyObject(req.body);
    if (body === null) return bad('"body" must be a JSON object with at least one of content/type/importance/confidence');
    const patch: Record<string, unknown> = {};
    if (body.content !== undefined) {
      if (typeof body.content !== "string" || body.content.trim().length === 0) {
        return bad('"content" must be a non-empty string when present');
      }
      patch.content = body.content;
    }
    if (body.type !== undefined) {
      if (typeof body.type !== "string" || !(MEMORY_TYPES as readonly string[]).includes(body.type)) {
        return bad(`"type" must be one of ${MEMORY_TYPES.join(", ")}; got ${JSON.stringify(body.type)}`);
      }
      patch.type = body.type;
    }
    if (body.importance !== undefined) {
      if (typeof body.importance !== "number" || !Number.isInteger(body.importance) || body.importance < 1 || body.importance > 5) {
        return bad('"importance" must be an integer between 1 and 5 when present');
      }
      patch.importance = body.importance;
    }
    if (body.confidence !== undefined) {
      if (typeof body.confidence !== "number" || body.confidence < 0 || body.confidence > 1) {
        return bad('"confidence" must be a number between 0 and 1 when present');
      }
      patch.confidence = body.confidence;
    }
    if (Object.keys(patch).length === 0) {
      return bad('"body" must carry at least one of content/type/importance/confidence');
    }
    const gated = await invokeGate(runtime, MUTATION_TOOL_IDS.memoryCorrect, { id, ...patch }, approvalIdOf(body));
    if (!gated.ok) return gated.response;
    const result = gated.result as { ok: boolean; entry?: unknown; refusal?: { detail?: string } };
    if (!result.ok) return notFound(result.refusal?.detail ?? `memory "${id}" does not exist`);
    return ok({ memory: result.entry });
  }

  // ── POST /memory/:id/delete — forget one entry, parked by default ──────────
  //
  // DESTRUCTIVE through the boundary: the first call parks (409 + approvalId)
  // and the caller re-issues with the decided id — the same shape as the
  // session delete the E2E already proved.
  async function forgetMemoryHandler(req: ApiRequest, params: Record<string, string>): Promise<ApiResponse> {
    const id = params.id ?? "";
    if (id.length === 0) return bad('"id" must be a non-empty memory entry id');
    const body = asBodyObject(req.body) ?? {};
    const gated = await invokeGate(runtime, MUTATION_TOOL_IDS.memoryForget, { id }, approvalIdOf(body));
    if (!gated.ok) return gated.response;
    const result = gated.result as { ok: boolean; refusal?: { detail?: string } };
    if (!result.ok) return notFound(result.refusal?.detail ?? `memory "${id}" does not exist`);
    return ok({ deleted: id });
  }

  // ── GET /soul + POST /soul — KAI's live identity text ──────────────────────
  //
  // READ serves the provider's current soul + content version (a hand-edited
  // SOUL.md is visible here with no restart). WRITE goes through `soul.set`,
  // which parks by default: replacing what KAI is requires a human, exactly
  // like a policy change. Agent output can never reach this path silently —
  // only an explicit user-authorized call passes the boundary.
  async function getSoul(): Promise<ApiResponse> {
    return ok({ soul: runtime.readSoul() });
  }

  async function setSoulHandler(req: ApiRequest): Promise<ApiResponse> {
    const body = asBodyObject(req.body);
    if (body === null || typeof body.soul !== "string" || body.soul.trim().length === 0) {
      return bad('"body" must be a JSON object with a non-empty string "soul"');
    }
    const gated = await invokeGate(runtime, MUTATION_TOOL_IDS.soulSet, { text: body.soul }, approvalIdOf(body));
    if (!gated.ok) return gated.response;
    return ok({ soul: gated.result });
  }

  // ── Settings (KAI's own persisted knobs) ───────────────────────────────────
  //
  // GET serves the stored rows plus the EFFECTIVE values with their winning
  // source per key (settings > environment > credential-file > defaults), so a
  // human sees why a value is what it is. POST/POST-reset go through the
  // ── Goals: intake → challenge → plan → approval ──────────────────────────
  //
  // A goal is the durable contract ABOVE the orchestrator. Nothing here
  // dispatches: creating a goal, challenging it and proposing a plan are all
  // non-executing. The only way a goal becomes executable is an owner approval
  // bound to ONE exact revision, and even then only while the Doer is ON.
  //
  // Every mutation on this surface is `requiresOwner`: a goal is what authorises
  // KAI to act, so an unrelated local process must not be able to create one,
  // challenge one, or approve a plan.
  function goalView(goal: Goal) {
    const approval = runtime.goals.isApproved(goal.id);
    const doerOn = readOrchestrationPrefs(runtime.stores.settings).doer === "ON";
    return {
      ...goal,
      currentRevision: runtime.goals.currentRevision(goal.id),
      approval: {
        approved: approval.approved,
        reason: approval.reason,
        revisionId: approval.revision?.id ?? null,
        revisionVersion: approval.revision?.version ?? null,
        approvedBy: approval.approval?.approvedBy ?? null,
        approvedAt: approval.approval?.approvedAt ?? null,
      },
      doer: doerOn ? "ON" : "OFF",
      // Eligible means: an approval that still matches the current revision, and
      // the Doer is ON. Approved-but-paused is a real, distinct state.
      eligibility: approval.approved
        ? (doerOn ? "ELIGIBLE" : "PAUSED_DOER_OFF")
        : "NOT_APPROVED",
    };
  }

  /** Advance a goal to `target` through the lifecycle's legal intermediates. */
  function advanceGoal(goalId: string, target: GoalState, cause: string): { ok: boolean; reason?: string } {
    const goal = runtime.goals.getGoal(goalId);
    if (goal === null) return { ok: false, reason: `no goal "${goalId}" exists` };
    if (goal.state === target) return { ok: true };
    const path = routeTo(goal.state, target);
    if (path === null) return { ok: false, reason: `the lifecycle does not reach ${target} from ${goal.state}` };
    for (const step of path) {
      const moved = runtime.goals.setGoalState(goalId, step, cause, "user");
      if (!moved.ok) return { ok: false, reason: moved.reason };
    }
    return { ok: true };
  }

  async function createGoalHandler(req: ApiRequest): Promise<ApiResponse> {
    const body = asBodyObject(req.body);
    if (body === null) return bad('"body" must be a JSON object, e.g. {"intent": "…"}');
    const intent = typeof body.intent === "string" ? body.intent.trim() : "";
    if (intent.length === 0) return bad('"intent" must be a non-empty string');
    // Oversized input is refused rather than silently truncated: a truncated goal
    // would be a different goal.
    if (intent.length > 8000) return bad('"intent" must be 8000 characters or fewer');
    const strings = (value: unknown, field: string): string[] | ApiResponse => {
      if (value === undefined) return [];
      if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
        return bad(`"${field}" must be an array of strings when present`);
      }
      return value.map((v) => v.trim()).filter((v) => v.length > 0);
    };
    const constraints = strings(body.constraints, "constraints");
    if (!Array.isArray(constraints)) return constraints;
    const forbidden = strings(body.forbiddenOutcomes, "forbiddenOutcomes");
    if (!Array.isArray(forbidden)) return forbidden;

    const goal = runtime.goals.createGoal({ statement: intent, createdBy: "user" });
    runtime.goals.setGoalFields(goal.id, { constraints, ...(forbidden.length > 0 ? {} : {}) });
    // Forbidden outcomes ride the plan/contract, not the goal row; keep them on
    // the goal's constraints so nothing is dropped before a plan exists.
    if (forbidden.length > 0) {
      runtime.goals.setGoalFields(goal.id, { constraints: [...constraints, ...forbidden.map((f) => `forbidden: ${f}`)] });
    }
    runtime.bus.publish("goal.created", { goalId: goal.id }, { source: "ui" });
    const stored = runtime.goals.getGoal(goal.id);
    return { status: 201, body: goalView(stored ?? goal) };
  }

  function listGoalsHandler(): ApiResponse {
    return ok({ goals: runtime.goals.listGoals().map(goalView) });
  }

  function getGoalHandler(_req: ApiRequest, params: Record<string, string>): ApiResponse {
    const goal = runtime.goals.getGoal(params.id ?? "");
    if (goal === null) return notFound(`no goal "${params.id ?? ""}" exists`);
    return ok(goalView(goal));
  }

  async function goalStateHandler(req: ApiRequest, params: Record<string, string>): Promise<ApiResponse> {
    const body = asBodyObject(req.body);
    if (body === null) return bad('"body" must be a JSON object, e.g. {"state": "CANCELLED"}');
    const state = body.state;
    if (!isGoalState(state)) return bad('"state" must be a valid goal state');
    const moved = runtime.goals.setGoalState(params.id ?? "", state, "user request", "user");
    if (!moved.ok) return conflict(moved.reason);
    return ok(goalView(moved.goal));
  }

  async function challengeGoalHandler(req: ApiRequest, params: Record<string, string>): Promise<ApiResponse> {
    const body = asBodyObject(req.body) ?? {};
    const mode = body.mode === undefined ? "QUICK" : body.mode;
    if (mode !== "QUICK" && mode !== "DEEP") {
      return bad('"mode" must be "QUICK" or "DEEP" (OFF skips the panel entirely)');
    }
    const goal = runtime.goals.getGoal(params.id ?? "");
    if (goal === null) return notFound(`no goal "${params.id ?? ""}" exists`);

    // The revision identity is derived from the goal text, so a challenge is
    // always bound to the exact text that was critiqued.
    const goalRevisionId = revisionIdFor(goal.id, goal.statement);
    const prepared = advanceGoal(goal.id, "CHALLENGING", "challenge requested");
    if (!prepared.ok) return conflict(prepared.reason ?? "the goal cannot be challenged from its current state");

    let outcome;
    try {
      outcome = await runtime.challengerFor(mode).challenge({
        goalRevisionId,
        goal: goal.statement,
        contract: {
          acceptanceCriteria: [],
          constraints: goal.constraints,
          forbiddenOutcomes: [],
          requiredEvidence: [],
        },
      });
    } catch (error) {
      // A reviewer failure is reported as a blocker, never as a pass.
      runtime.goals.setGoalFields(goal.id, { blocker: `challenge failed: ${error instanceof Error ? error.message : String(error)}` });
      runtime.goals.setGoalState(goal.id, "BLOCKED", "challenge runner failed", "system");
      const failed = runtime.goals.getGoal(goal.id);
      return { status: 502, body: { error: true, reason: "the challenge panel failed", goal: failed === null ? null : goalView(failed) } };
    }

    const report = outcome.report;
    runtime.goals.setGoalFields(goal.id, { challenge: report });
    const target: GoalState =
      report.verdict === "BLOCKED" ? "BLOCKED"
        : report.verdict === "REVISE" ? "REVISION_REQUIRED"
          : report.verdict === "CONDITIONAL" ? "CONDITIONAL"
            : "READY_FOR_PLAN";
    const moved = runtime.goals.setGoalState(goal.id, target, `challenge verdict ${report.verdict}`, "kai");
    if (!moved.ok) return conflict(moved.reason);
    runtime.bus.publish("goal.challenged", { goalId: goal.id, verdict: report.verdict, mode }, { source: "core" });
    return ok(goalView(moved.goal));
  }

  async function planGoalHandler(req: ApiRequest, params: Record<string, string>): Promise<ApiResponse> {
    const goal = runtime.goals.getGoal(params.id ?? "");
    if (goal === null) return notFound(`no goal "${params.id ?? ""}" exists`);
    if (goal.state !== "READY_FOR_PLAN" && goal.state !== "CONDITIONAL") {
      return conflict(`a plan is proposed from READY_FOR_PLAN (or CONDITIONAL), not from ${goal.state}`);
    }
    const planned = await runtime.architect.planGoal({
      goalId: goal.id,
      intent: goal.statement,
      constraints: goal.constraints,
      ...(goal.assumptions.length > 0 ? { facts: goal.assumptions } : {}),
      mode: "QUICK",
    });
    if (!planned.ok) {
      // A refused plan is a refusal, not an empty plan presented as valid.
      return conflict(planned.reason);
    }
    const revision = runtime.goals.addRevision(goal.id, planned.content, "kai");
    runtime.goals.setGoalFields(goal.id, {
      uncertainties: [...new Set([...goal.uncertainties, ...planned.content.uncertainties])],
      assumptions: [...new Set([...goal.assumptions, ...planned.content.assumptions])],
    });
    const proposed = advanceGoal(goal.id, "AWAITING_PLAN_APPROVAL", "plan proposed");
    if (!proposed.ok) return conflict(proposed.reason ?? "the plan could not be presented for approval");
    runtime.bus.publish("goal.plan_proposed", { goalId: goal.id, revisionId: revision.id, version: revision.version }, { source: "core" });
    const stored = runtime.goals.getGoal(goal.id);
    return ok({ ...(stored === null ? {} : goalView(stored)), revision });
  }

  async function approvePlanHandler(req: ApiRequest, params: Record<string, string>): Promise<ApiResponse> {
    const body = asBodyObject(req.body);
    if (body === null) return bad('"body" must be a JSON object, e.g. {"revisionId": "…"}');
    const goalId = params.id ?? "";
    const goal = runtime.goals.getGoal(goalId);
    if (goal === null) return notFound(`no goal "${goalId}" exists`);
    const current = runtime.goals.currentRevision(goalId);
    if (current === null) return conflict("this goal has no plan revision to approve");
    // The caller may name the revision it believes it is approving. If it names
    // an older one, refuse: approving revision N while revision N+1 is current
    // would authorise a plan the human never read.
    const claimed = typeof body.revisionId === "string" ? body.revisionId : current.id;
    if (claimed !== current.id) {
      return conflict(`revision "${claimed}" is not current (current is "${current.id}"); re-read the plan and approve again`);
    }
    const recorded = runtime.goals.recordApproval({
      goalId,
      revisionId: current.id,
      approvedBy: "user",
      status: "APPROVED",
      authorityScope: current.content.authorizedWorkspace,
      budgets: current.content.budgets,
    });
    if (!recorded.ok) return conflict(recorded.reason);
    const moved = advanceGoal(goalId, "APPROVED", "plan approved by the user");
    if (!moved.ok) return conflict(moved.reason ?? "the approval was recorded but the goal could not advance");
    runtime.bus.publish("goal.plan_approved", { goalId, revisionId: current.id, created: recorded.created }, { source: "ui" });
    const stored = runtime.goals.getGoal(goalId);
    return ok(stored === null ? null : goalView(stored));
  }

  async function rejectPlanHandler(req: ApiRequest, params: Record<string, string>): Promise<ApiResponse> {
    const body = asBodyObject(req.body) ?? {};
    const goalId = params.id ?? "";
    const goal = runtime.goals.getGoal(goalId);
    if (goal === null) return notFound(`no goal "${goalId}" exists`);
    const current = runtime.goals.currentRevision(goalId);
    if (current === null) return conflict("this goal has no plan revision to reject");
    const recorded = runtime.goals.recordApproval({
      goalId,
      revisionId: current.id,
      approvedBy: "user",
      status: "REJECTED",
      note: typeof body.note === "string" ? body.note : "rejected by the user",
    });
    if (!recorded.ok) return conflict(recorded.reason);
    const moved = runtime.goals.setGoalState(goalId, "REVISION_REQUIRED", "plan rejected by the user", "user");
    if (!moved.ok) return conflict(moved.reason);
    runtime.bus.publish("goal.plan_rejected", { goalId, revisionId: current.id }, { source: "ui" });
    return ok(goalView(moved.goal));
  }

  // ── KAI Doer (the autonomous switch) ─────────────────────────────────────
  //
  // GET is a typed read of the DURABLE preference plus the pending-result
  // inbox summary. POST flips it through the same policy-gated
  // `settings.update` tool as every other preference — Guard is authoritative,
  // so a WRITE-policy Core parks the switch for a human instead of applying it
  // silently. Guard itself is reported, never toggled: it is always active.
  function getDoer(): ApiResponse {
    const prefs = readOrchestrationPrefs(runtime.stores.settings);
    const counts = runtime.pendingResults.counts();
    return ok({
      state: prefs.doer,
      paused: prefs.doer === "OFF",
      guard: "ON",
      pending: counts,
      // Enough for the Island's list without paginating the whole inbox.
      results: runtime.pendingResults.list({ limit: 25 }),
    });
  }

  async function setDoerHandler(req: ApiRequest): Promise<ApiResponse> {
    const body = asBodyObject(req.body);
    if (body === null) return bad('"body" must be a JSON object, e.g. {"state": "ON"}');
    const state = body.state;
    if (state !== "ON" && state !== "OFF") {
      return bad('"state" must be "ON" or "OFF"');
    }
    // OFF is authority-REDUCING, so it goes through `doer.set` and applies
    // immediately — a user must never need an approval to make KAI stop acting
    // on its own. ON goes through `settings.update`, which the default policy
    // parks for a human: widening autonomy is not the same kind of act.
    const gated =
      state === "OFF"
        ? await invokeGate(runtime, MUTATION_TOOL_IDS.doerSet, { state: "OFF" }, approvalIdOf(body))
        : await invokeGate(runtime, MUTATION_TOOL_IDS.settingsUpdate, { settings: { "orchestration.doer": "ON" } }, approvalIdOf(body));
    if (!gated.ok) return gated.response;
    // The switch event and the resulting drain belong to the write itself
    // (runtime `updateSettings` / `setDoerOff`), so an approved park and a direct
    // write take exactly the same path. Nothing is deferred to a later tick.
    // `getDoer()` returns a full ApiResponse; embed its PAYLOAD, not the envelope.
    return ok({ settings: gated.result, doer: getDoer().body });
  }

  function listDoerPending(): ApiResponse {
    const counts = runtime.pendingResults.counts();
    return ok({
      counts,
      results: runtime.pendingResults.list(),
    });
  }

  // policy-gated `settings.update` tool, which parks by default: redirecting
  // inference traffic requires a human. The key itself is never stored here —
  // GET reports only whether one is configured.
  function getSettings(): ApiResponse {
    return ok({
      stored: runtime.settings.stored(),
      effective: runtime.settings.effective(),
      orchestration: readOrchestrationPrefs(runtime.stores.settings),
    });
  }

  async function setSettingsHandler(req: ApiRequest): Promise<ApiResponse> {
    const body = asBodyObject(req.body);
    if (body === null) return bad('"body" must be a JSON object patch, e.g. {"model.name": "…"}');
    // `approvalId` rides the envelope, not the patch — otherwise it would be
    // refused as an unknown setting key.
    const patch: Record<string, unknown> = { ...body };
    delete patch.approvalId;
    const gated = await invokeGate(runtime, MUTATION_TOOL_IDS.settingsUpdate, { settings: patch }, approvalIdOf(body));
    if (!gated.ok) return gated.response;
    return ok({ settings: gated.result });
  }

  async function resetSettingsHandler(req: ApiRequest): Promise<ApiResponse> {
    const body = asBodyObject(req.body) ?? {};
    const keys = body.keys;
    if (keys !== undefined && (!Array.isArray(keys) || !keys.every((k) => typeof k === "string"))) {
      return bad('"keys" must be an array of setting keys when present');
    }
    const gated = await invokeGate(
      runtime,
      MUTATION_TOOL_IDS.settingsUpdate,
      keys === undefined ? { reset: [] } : { reset: keys },
      approvalIdOf(body),
    );
    if (!gated.ok) return gated.response;
    return ok({ settings: gated.result });
  }

  // ── Providers + models (the ONE registry) ────────────────────────────────
  //
  // GET serves live probes (real HTTP to each backend), never a static list.
  // POST /models/use selects KAI's OWN inference model through the
  // policy-gated `settings.update` tool (WRITE parks by default): model
  // selection persists and applies on the next turn with no restart. Worker
  // models are not selectable — KAI has no per-request worker override, so
  // the route refuses that shape instead of faking it.
  async function listProviders(): Promise<ApiResponse> {
    return ok({ providers: await runtime.providers.list() });
  }

  async function testProvider(params: Record<string, string>): Promise<ApiResponse> {
    const id = params.id ?? "";
    const result = await runtime.providers.test(id);
    return result.ok ? ok({ test: result }) : bad(result.reason);
  }

  async function listModels(): Promise<ApiResponse> {
    return ok(await runtime.providers.models());
  }

  async function useModelHandler(req: ApiRequest): Promise<ApiResponse> {
    const body = asBodyObject(req.body);
    if (body === null || typeof body.model !== "string" || body.model.trim().length === 0) {
      return bad('"body" must be a JSON object with a non-empty string "model"');
    }
    if (body.provider !== undefined && body.provider !== "kai-model") {
      return bad('only KAI\'s own provider ("kai-model") is selectable — workers route by worker id, not by model');
    }
    const patch: Record<string, unknown> = { "model.name": body.model.trim() };
    const gated = await invokeGate(runtime, MUTATION_TOOL_IDS.settingsUpdate, { settings: patch }, approvalIdOf(body));
    if (!gated.ok) return gated.response;
    return ok({ model: gated.result });
  }

  // ── Orchestration: work board, bench, activity ─────────────────────────────
  //
  // The work board and bench are READ surfaces over persisted runtime state;
  // creating/running/reviewing work items are WRITE (orchestration rows only).
  // Every delegation the loop performs still passes the policy-governed
  // `agents.run_task` tool individually — these routes never bypass it.
  function listWorkItems(req: ApiRequest): ApiResponse {
    const q = query(req);
    const limitRaw = q.get("limit");
    const limit = limitRaw !== null ? Math.max(1, Math.min(200, Number(limitRaw) || 50)) : 50;
    const str = (name: string): string | undefined => {
      const v = q.get(name);
      return v !== null && v.length > 0 ? v : undefined;
    };
    return ok({
      items: runtime.stores.workItems.list({
        ...(str("state") !== undefined ? { state: str("state") as string } : {}),
        ...(str("mission") !== undefined ? { missionId: str("mission") as string } : {}),
        ...(str("task") !== undefined ? { taskId: str("task") as string } : {}),
        ...(str("worker") !== undefined ? { workerId: str("worker") as string } : {}),
        limit,
      }),
    });
  }

  function getWorkItem(params: Record<string, string>): ApiResponse {
    const inspected = runtime.orchestrator.inspect(params.id ?? "");
    if (inspected.item === null) return notFound(`no work item "${params.id ?? ""}"`);
    return ok(inspected);
  }

  async function createWorkItem(req: ApiRequest): Promise<ApiResponse> {
    const body = asBodyObject(req.body);
    if (body === null || typeof body.objective !== "string" || body.objective.trim().length === 0) {
      return bad('"body" must be a JSON object with a non-empty string "objective"');
    }
    const strList = (value: unknown): string[] | undefined =>
      Array.isArray(value) && value.every((v) => typeof v === "string") ? (value as string[]) : undefined;
    const strVal = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
    const candidates = runtime.subagents.list().map((persona) => persona.spec.id);
    const asRecord = (value: unknown): Record<string, string[]> | undefined =>
      typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, string[]>) : undefined;
    const started = runtime.orchestrator.startObjective(
      {
        objective: (body.objective as string).trim(),
        ...(strVal(body.deliverable) !== undefined ? { deliverable: strVal(body.deliverable) as string } : {}),
        ...(strList(body.constraints) !== undefined ? { constraints: strList(body.constraints) as string[] } : {}),
        ...(strList(body.forbiddenOutcomes) !== undefined ? { forbiddenOutcomes: strList(body.forbiddenOutcomes) as string[] } : {}),
        ...(strList(body.successCriteria) !== undefined ? { successCriteria: strList(body.successCriteria) as string[] } : {}),
        ...(strList(body.requiredEvidence) !== undefined ? { requiredEvidence: strList(body.requiredEvidence) as string[] } : {}),
        ...(asRecord(body.evidenceLinks) !== undefined ? { evidenceLinks: asRecord(body.evidenceLinks) as Record<string, string[]> } : {}),
        ...(strVal(body.risk) !== undefined ? { risk: strVal(body.risk) as string } : {}),
        ...(strVal(body.taskId) !== undefined ? { taskId: strVal(body.taskId) as string } : {}),
        ...(strVal(body.missionId) !== undefined ? { missionId: strVal(body.missionId) as string } : {}),
        ...(strVal(body.workingDir) !== undefined ? { workingDir: strVal(body.workingDir) as string } : {}),
        ...(strList(body.subtasks) !== undefined ? { subtasks: strList(body.subtasks) as string[] } : {}),
        ...(strList(body.skills) !== undefined ? { skills: strList(body.skills) as string[] } : {}),
      },
      candidates,
    );
    // 201 means a durable work item now exists (planned); it does NOT mean a
    // worker was dispatched. `delegated` stays false until dispatch happens,
    // so status is keyed on creation, never on the old delegation lie.
    return ok(started, started.planned ? 201 : 200);
  }

  async function runWorkItem(req: ApiRequest, params: Record<string, string>): Promise<ApiResponse> {
    const body = asBodyObject(req.body) ?? {};
    const workerId = typeof body.workerId === "string" && body.workerId.length > 0 ? body.workerId : undefined;
    const approvalId = typeof body.approvalId === "string" && body.approvalId.length > 0 ? body.approvalId : undefined;
    const outcome = await runtime.orchestrator.runWorkItem(params.id ?? "", {
      ...(workerId !== undefined ? { workerId } : {}),
      ...(approvalId !== undefined ? { approvalId } : {}),
    });
    return ok(outcome);
  }

  async function reviewWorkItem(req: ApiRequest, params: Record<string, string>): Promise<ApiResponse> {
    const body = asBodyObject(req.body) ?? {};
    const criteria = Array.isArray(body.criteria) && body.criteria.every((c) => typeof c === "string")
      ? (body.criteria as string[])
      : undefined;
    const outcome = await runtime.orchestrator.reviewItem(params.id ?? "", criteria);
    if ("error" in outcome) return bad(outcome.error);
    return ok(outcome);
  }

  /**
   * POST /work-items/audit — ingest an EXTERNAL worker report (Case B). The
   * report is parsed into labeled claims, audited against the real workspace,
   * gated, and answered with a correction prompt. Auto-launch happens only
   * through startObjective when autonomy permits; otherwise the prompt returns
   * waiting. WRITE because it creates a durable work item (and may launch).
   */
  async function auditWorkItem(req: ApiRequest): Promise<ApiResponse> {
    const body = asBodyObject(req.body);
    if (body === null || typeof body.reportText !== "string" || (body.reportText as string).trim().length === 0) {
      return bad('"body" must be a JSON object with a non-empty string "reportText"');
    }
    const strVal = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);
    const audit = await runtime.orchestrator.auditExternalReport({
      reportText: body.reportText as string,
      ...(strVal(body.objective) !== undefined ? { objective: strVal(body.objective) as string } : {}),
      ...(strVal(body.workingDir) !== undefined ? { workingDir: strVal(body.workingDir) as string } : {}),
      ...(strVal(body.missionId) !== undefined ? { missionId: strVal(body.missionId) as string } : {}),
      ...(strVal(body.taskId) !== undefined ? { taskId: strVal(body.taskId) as string } : {}),
      ...(strVal(body.workerId) !== undefined ? { workerId: strVal(body.workerId) as string } : {}),
    });
    return ok(audit, audit.launched.started ? 201 : 200);
  }

  function listBench(): ApiResponse {
    return ok({ workers: runtime.orchestrator.benchList() });
  }

  function listActivity(req: ApiRequest): ApiResponse {
    const q = query(req);
    const str = (name: string): string | undefined => {
      const v = q.get(name);
      return v !== null && v.length > 0 ? v : undefined;
    };
    const levelRaw = str("level");
    const level = levelRaw === "VERBOSE" || levelRaw === "COMPACT" || levelRaw === "OFF" ? levelRaw : undefined;
    const limitRaw = q.get("limit");
    void limitRaw;
    return ok({
      events: runtime.orchestrator.activityList(
        {
          ...(str("task") !== undefined ? { taskId: str("task") as string } : {}),
          ...(str("work") !== undefined ? { workItemId: str("work") as string } : {}),
        },
        level,
      ),
    });
  }

  // ── Skills (Phase 2 Part C) ──────────────────────────────────────────────────
  //
  // Read-only routes ask the registry; a body is returned ONLY by `load`. The
  // staged flow is the install path, and it is deliberately NOT a direct write:
  // `approve` records a human approval bound to the exact staged sha256, and
  // `install` refuses unless those bytes still hash to it AND the approval is
  // APPROVED. A subsystem refusal is a value; it is mapped to the matching HTTP
  // status here, with the same 409 + {approvalRequired, approvalId} shape the tool
  // boundary uses.

  function skillFailure(
    result: { ok: false; error: { code: string; message: string; detail?: string }; issues?: unknown },
    approvalId?: string,
  ): ApiResponse {
    const error = result.error;
    const body: Record<string, unknown> = { error: true, reason: error.message };
    if (typeof error.detail === "string") body.code = error.detail;
    if (Array.isArray(result.issues) && result.issues.length > 0) body.issues = result.issues;
    switch (error.code) {
      case "VALIDATION_FAILED":
        return { status: 400, body };
      case "NOT_FOUND":
        return { status: 404, body };
      case "POLICY_DENIED":
        return { status: 403, body };
      case "APPROVAL_REQUIRED":
        return { status: 409, body: { ...body, approvalRequired: true, approvalId: approvalId ?? null } };
      case "INTERNAL":
        return { status: 500, body };
      default:
        return { status: 409, body };
    }
  }

  async function listSkills(): Promise<ApiResponse> {
    return ok({ skills: runtime.skills.list() });
  }

  async function relevantSkills(req: ApiRequest): Promise<ApiResponse> {
    const q = query(req);
    const limit = parseLimit(q.get("limit"), "limit");
    if (!limit.ok) return bad(limit.reason);
    return ok({ skills: runtime.skills.relevant(q.get("q") ?? "", limit.value) });
  }

  async function inspectSkill(params: Record<string, string>): Promise<ApiResponse> {
    const result = runtime.skills.inspect(params.id ?? "");
    if (!result.ok) return skillFailure(result);
    return ok({ skill: result.value });
  }

  async function loadSkill(params: Record<string, string>): Promise<ApiResponse> {
    const result = runtime.skills.load(params.id ?? "");
    if (!result.ok) return skillFailure(result);
    return ok({ skill: result.value });
  }

  async function setSkillEnabled(
    req: ApiRequest,
    params: Record<string, string>,
    enabled: boolean,
  ): Promise<ApiResponse> {
    const id = params.id ?? "";
    // The pre-check is a read: a precise 404 beats parking an action for a skill
    // that does not exist.
    const view = runtime.skills.inspect(id);
    if (!view.ok) return skillFailure(view);
    // WRITE, but more consequential than a memory append: this changes which
    // skills KAI will load and act on, so the default policy parks it for a human.
    const gated = await invokeGate(
      runtime,
      MUTATION_TOOL_IDS.skillToggle,
      { id, enabled },
      approvalIdOf(asBodyObject(req.body)),
    );
    if (!gated.ok) return gated.response;
    const result = gated.result as SkillResultLike;
    if (!result.ok) return skillFailure(result);
    return ok({ skill: result.value });
  }

  async function deleteSkill(req: ApiRequest, params: Record<string, string>): Promise<ApiResponse> {
    const id = params.id ?? "";
    const view = runtime.skills.inspect(id);
    if (!view.ok) return skillFailure(view);
    // DESTRUCTIVE: removes the skill's files from disk. Never runs without a human.
    const gated = await invokeGate(
      runtime,
      MUTATION_TOOL_IDS.skillDelete,
      { id },
      approvalIdOf(asBodyObject(req.body)),
    );
    if (!gated.ok) return gated.response;
    const result = gated.result as SkillResultLike;
    if (!result.ok) return skillFailure(result);
    return ok({ deleted: true, id });
  }

  async function pluginLifecycle(
    req: ApiRequest,
    params: Record<string, string>,
    op: "enable" | "disable" | "config",
  ): Promise<ApiResponse> {
    const id = params.id ?? "";
    if (runtime.plugins.get(id) === null) return notFound(`no plugin "${id}" is defined`);
    const body = asBodyObject(req.body) ?? {};
    const input: Record<string, unknown> =
      op === "config" ? { op, id, key: body.key, value: body.value } : { op, id };
    const gated = await invokeGate(runtime, MUTATION_TOOL_IDS.pluginLifecycle, input, approvalIdOf(body));
    if (!gated.ok) return gated.response;
    const result = gated.result as { ok: boolean; value?: unknown; error?: { message?: string } };
    if (result.ok === false) return bad(result.error?.message ?? `plugin "${id}" refused the ${op}`);
    return ok({ plugin: result.value });
  }

  async function listStagedSkills(): Promise<ApiResponse> {
    return ok({ staged: runtime.skillStaging.listStaged() });
  }

  async function inspectStagedSkill(params: Record<string, string>): Promise<ApiResponse> {
    const result = runtime.skillStaging.inspectStaged(params.stagedId ?? "");
    if (!result.ok) return skillFailure(result);
    return ok({ staged: result.value });
  }

  async function approveStagedSkill(req: ApiRequest, params: Record<string, string>): Promise<ApiResponse> {
    const stagedId = params.stagedId ?? "";
    const body = asBodyObject(req.body) ?? {};

    let sha256: string;
    if (body.sha256 !== undefined) {
      if (typeof body.sha256 !== "string" || !SHA256_RE.test(body.sha256)) {
        return bad('"sha256" must be a 64-character hex string when present');
      }
      sha256 = body.sha256;
    } else {
      const view = runtime.skillStaging.inspectStaged(stagedId);
      if (!view.ok) return skillFailure(view);
      sha256 = view.value.sha256;
    }

    const result = runtime.skillStaging.requestInstallApproval(stagedId, sha256);
    if (!result.ok) return skillFailure(result);
    return ok({ ...result.value }, 201);
  }

  async function discardStagedSkill(params: Record<string, string>): Promise<ApiResponse> {
    // Discarding removes ephemeral staged bytes that were never installed. It
    // executes directly (like cancelling a parked run): refusing to throw away
    // would park a decision about nothing.
    const result = runtime.skillStaging.discardStaged(params.stagedId ?? "");
    if (!result.ok) return skillFailure(result);
    return ok({ discarded: params.stagedId ?? "" });
  }

  async function installStagedSkill(req: ApiRequest, params: Record<string, string>): Promise<ApiResponse> {
    const stagedId = params.stagedId ?? "";
    const body = asBodyObject(req.body);
    if (body === null) {
      return bad('"body" must be a JSON object with a non-empty "approvalId"');
    }
    if (typeof body.approvalId !== "string" || body.approvalId.trim().length === 0) {
      return bad('"approvalId" must be a non-empty string');
    }
    const approvalId = body.approvalId;

    let sha256: string;
    if (body.sha256 !== undefined) {
      if (typeof body.sha256 !== "string" || !SHA256_RE.test(body.sha256)) {
        return bad('"sha256" must be a 64-character hex string when present');
      }
      sha256 = body.sha256;
    } else {
      const view = runtime.skillStaging.inspectStaged(stagedId);
      if (!view.ok) return skillFailure(view);
      sha256 = view.value.sha256;
    }

    const result = runtime.skillStaging.installApproved({ stagedId, sha256, approvalId });
    if (!result.ok) return skillFailure(result, approvalId);
    return ok({ install: result.value }, 201);
  }

  // ── Scheduler (Phase 2 Part F): create / list / cancel / recover ─────────────
  //
  // Tasks are persisted through the SAME ScheduledTaskStore the scheduler reloads
  // from, and `reload()` is asked to pick the new one up, so a schedule created
  // over HTTP is one the running Core will actually fire. `recoverInterrupted` is
  // exposed so an operator can drive the startup lease reconciliation on demand.

  async function listSchedules(): Promise<ApiResponse> {
    return ok({ schedules: runtime.stores.scheduledTasks.listScheduledTasks() });
  }

  async function createScheduleHandler(req: ApiRequest): Promise<ApiResponse> {
    const body = asBodyObject(req.body);
    if (body === null) {
      return bad('"body" must be a JSON object with "title", "kind" and "action"');
    }
    if (typeof body.title !== "string" || body.title.trim().length === 0) {
      return bad('"title" must be a non-empty string');
    }
    if (typeof body.kind !== "string" || !(EXTENDED_SCHEDULE_KINDS as readonly string[]).includes(body.kind)) {
      return bad(`"kind" must be one of ${EXTENDED_SCHEDULE_KINDS.join(", ")}; got ${JSON.stringify(body.kind)}`);
    }
    if (typeof body.action !== "string" || body.action.trim().length === 0) {
      return bad('"action" must be a non-empty string');
    }
    const kind = body.kind as ExtendedScheduleKind;

    let intervalMs: number | undefined;
    if (body.intervalMs !== undefined) {
      if (typeof body.intervalMs !== "number" || !Number.isFinite(body.intervalMs) || body.intervalMs <= 0) {
        return bad('"intervalMs" must be a positive number when present');
      }
      intervalMs = body.intervalMs;
    }

    let atTime: string | undefined;
    if (body.atTime !== undefined) {
      if (typeof body.atTime !== "string") return bad('"atTime" must be a string when present');
      atTime = body.atTime;
    }

    let runAt: string | undefined;
    if (body.runAt !== undefined) {
      if (typeof body.runAt !== "string") return bad('"runAt" must be a string when present');
      runAt = body.runAt;
    }

    let dayOfWeek: number | undefined;
    if (body.dayOfWeek !== undefined) {
      if (
        typeof body.dayOfWeek !== "number" ||
        !Number.isInteger(body.dayOfWeek) ||
        body.dayOfWeek < 0 ||
        body.dayOfWeek > 6
      ) {
        return bad('"dayOfWeek" must be an integer 0..6 (Sunday=0) when present');
      }
      dayOfWeek = body.dayOfWeek;
    }

    let cron: string | undefined;
    if (body.cron !== undefined) {
      if (typeof body.cron !== "string") return bad('"cron" must be a string when present');
      cron = body.cron;
    }

    let payload: Record<string, unknown> | undefined;
    if (body.payload !== undefined) {
      const payloadObj = asBodyObject(body.payload);
      if (payloadObj === null) return bad('"payload" must be an object when present');
      payload = payloadObj;
    }

    let enabled = true;
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== "boolean") return bad('"enabled" must be a boolean when present');
      enabled = body.enabled;
    }

    const spec: ScheduleSpec = { kind };
    if (intervalMs !== undefined) spec.intervalMs = intervalMs;
    if (atTime !== undefined) spec.atTime = atTime;
    if (runAt !== undefined) spec.runAt = runAt;
    if (dayOfWeek !== undefined) spec.dayOfWeek = dayOfWeek;
    if (cron !== undefined) spec.cron = cron;

    const check = validateSchedule(spec);
    if (!check.ok) return bad(check.reason);

    const at = new Date();
    const atIso = at.toISOString();
    let task: ScheduledTask = {
      id: newId("sched"),
      title: body.title,
      // `weekly`/`cron` are KAI extensions carried on the same field and read back
      // by `specFor`; the frozen contract only names the first three.
      kind: kind as ScheduledTask["kind"],
      action: body.action,
      enabled,
      failureCount: 0,
      createdAt: atIso,
      updatedAt: atIso,
    };
    if (intervalMs !== undefined) task.intervalMs = intervalMs;
    if (atTime !== undefined) task.atTime = atTime;
    if (runAt !== undefined) task.runAt = runAt;
    if (payload !== undefined) task.payload = payload;
    if (dayOfWeek !== undefined || cron !== undefined) {
      task = withScheduleExtensions(task, {
        ...(dayOfWeek !== undefined ? { dayOfWeek } : {}),
        ...(cron !== undefined ? { cron } : {}),
      });
    }
    const next = computeNextRun(spec, at);
    if (next !== null) task.nextRun = next.toISOString();

    // WRITE (KAI's own schedule store): through the boundary; authorized by default.
    const gated = await invokeGate(
      runtime,
      MUTATION_TOOL_IDS.scheduleManage,
      { op: "create", task },
      approvalIdOf(body),
    );
    if (!gated.ok) return gated.response;
    return ok({ schedule: runtime.stores.scheduledTasks.getScheduledTask(task.id) ?? task }, 201);
  }

  async function cancelSchedule(req: ApiRequest, params: Record<string, string>): Promise<ApiResponse> {
    const id = params.id ?? "";
    const existing = runtime.stores.scheduledTasks.getScheduledTask(id);
    if (existing === null) return notFound(`no scheduled task "${id}" exists`);
    // WRITE: removing a schedule is KAI's own state, through the boundary.
    const gated = await invokeGate(
      runtime,
      MUTATION_TOOL_IDS.scheduleManage,
      { op: "cancel", id },
      approvalIdOf(asBodyObject(req.body)),
    );
    if (!gated.ok) return gated.response;
    return ok({ cancelled: true, id });
  }

  async function recoverScheduler(req: ApiRequest): Promise<ApiResponse> {
    // WRITE: lease reconciliation mutates KAI's own scheduler state.
    const gated = await invokeGate(
      runtime,
      MUTATION_TOOL_IDS.schedulerRecover,
      {},
      approvalIdOf(asBodyObject(req.body)),
    );
    if (!gated.ok) return gated.response;
    const result = gated.result as { interrupted: string[] };
    return ok({ interrupted: result.interrupted });
  }

  // ── Recovery (Phase 2 Part H): status / classify ─────────────────────────────
  //
  // The acceptance ledger answers, for each execution a restart found, whether it
  // completed, never happened, or is UNKNOWN. `status` reports what a restart must
  // decide about; `classify` gives the answer for one execution. Both are reads.
  //
  // `status` deliberately reports TWO different populations, and the field names
  // say which is which:
  //   open  — the records that still need a recovery decision (non-terminal:
  //           RUNNING, i.e. a step that began and has not settled).
  //   total — EVERY record the ledger has persisted, settled or open. Counting
  //           only `open` made a healthy ledger with completed history report
  //           `total: 0`, which read as "the ledger is empty/broken" and sent
  //           two investigations after the wrong thing. `total` is the whole
  //           ledger; it is never just `open.length`.

  async function recoveryStatus(): Promise<ApiResponse> {
    const open = runtime.recovery.listOpen();
    const total = runtime.recovery.listAll().length;
    return ok({ ledger: runtime.recovery.path, open, total });
  }

  async function recoveryClassify(req: ApiRequest): Promise<ApiResponse> {
    const body = asBodyObject(req.body);
    if (body === null || typeof body.executionId !== "string" || body.executionId.trim().length === 0) {
      return bad('"executionId" must be a non-empty string');
    }
    return ok({ classification: runtime.recovery.classify(body.executionId) });
  }

  // ── Checkpoints (Phase 2 Part G): create / list / restore ────────────────────

  async function listCheckpoints(): Promise<ApiResponse> {
    return ok({ checkpoints: runtime.checkpoints.list() });
  }

  async function createCheckpointHandler(req: ApiRequest): Promise<ApiResponse> {
    const body = asBodyObject(req.body);
    if (body === null || typeof body.target !== "string" || body.target.trim().length === 0) {
      return bad('"target" must be a non-empty string');
    }
    let label: string | undefined;
    if (body.label !== undefined) {
      if (typeof body.label !== "string") return bad('"label" must be a string when present');
      label = body.label;
    }
    let exclude: string[] | undefined;
    if (body.exclude !== undefined) {
      if (!Array.isArray(body.exclude) || body.exclude.some((e) => typeof e !== "string")) {
        return bad('"exclude" must be an array of strings when present');
      }
      exclude = body.exclude as string[];
    }
    // WRITE (KAI's own shadow checkpoint): through the boundary; authorized by default.
    const gated = await invokeGate(
      runtime,
      MUTATION_TOOL_IDS.checkpointCreate,
      {
        target: body.target,
        ...(label !== undefined ? { label } : {}),
        ...(exclude !== undefined ? { exclude } : {}),
      },
      approvalIdOf(body),
    );
    if (!gated.ok) return gated.response;
    const result = gated.result as { ok: boolean; reason?: string; checkpoint?: unknown };
    if (!result.ok) return conflict(result.reason ?? "checkpoint creation was refused");
    return ok({ checkpoint: result.checkpoint }, 201);
  }

  async function restoreCheckpointHandler(req: ApiRequest, params: Record<string, string>): Promise<ApiResponse> {
    const id = params.id ?? "";
    const body = asBodyObject(req.body) ?? {};
    let target: string | undefined;
    if (body.target !== undefined) {
      if (typeof body.target !== "string") return bad('"target" must be a string when present');
      target = body.target;
    }
    // DESTRUCTIVE: a restore OVERWRITES files at the target, so the default
    // policy parks it for a human and it performs nothing until approved.
    const gated = await invokeGate(
      runtime,
      MUTATION_TOOL_IDS.checkpointRestore,
      { id, ...(target !== undefined ? { target } : {}) },
      approvalIdOf(body),
    );
    if (!gated.ok) return gated.response;
    const result = gated.result as { ok: boolean; reason?: string };
    if (!result.ok) return conflict(result.reason ?? "restore was refused");
    return ok({ restore: result });
  }

  // ── Learning (Phase 2 Parts C5/D): propose / list / approve ──────────────────
  //
  // `propose` runs the loop on a COMPLETED turn. It never installs a skill: a
  // skill candidate is STAGED and still needs the human approval above, and a
  // memory candidate is written through the live engine, which redacts and
  // enforces its own bounds. `list`/`approve` are the same staged artifacts seen
  // from the learning side; a learned skill installs only through the
  // SHA-256-bound POST /skills/staging/:stagedId/install.

  async function proposeLearning(req: ApiRequest): Promise<ApiResponse> {
    const body = asBodyObject(req.body);
    if (body === null) return bad('"body" must be a JSON object with a "kind"');
    if (typeof body.kind !== "string" || !(TURN_KINDS as readonly string[]).includes(body.kind)) {
      return bad(`"kind" must be one of ${TURN_KINDS.join(", ")}; got ${JSON.stringify(body.kind)}`);
    }

    // ── Provenance is assigned HERE, by the host, never taken from the caller ──
    // This route is the EXTERNAL boundary: a turn that arrives over HTTP is
    // `external` no matter what it claims. A request that asks for
    // `source: "user"` is refused outright (400) — user authority is
    // host-attested (the host's own turn handler calls the pipeline directly
    // with `source: "user"`), and it cannot be bought over HTTP. We refuse
    // rather than silently downgrade so a caller is never left believing its
    // correction was learned when it was not.
    if (body.source === "user") {
      return bad(
        '"source": "user" is host-attested provenance and cannot be claimed over HTTP; an external turn is recorded as "external"',
      );
    }

    const event: Record<string, unknown> = { kind: body.kind, source: "external" };
    for (const key of ["userText", "assistantText", "at", "summary", "failure", "recovery", "text", "scope"]) {
      if (typeof body[key] === "string") event[key] = body[key];
    }
    if (typeof body.repeatCount === "number" && Number.isFinite(body.repeatCount)) event.repeatCount = body.repeatCount;
    if (Array.isArray(body.steps)) {
      event.steps = body.steps.filter((s): s is string => typeof s === "string");
    }
    const correction = asBodyObject(body.correction);
    if (correction !== null && typeof correction.before === "string" && typeof correction.after === "string") {
      event.correction = { before: correction.before, after: correction.after };
    }

    // WRITE: the loop may write a memory candidate (through the live engine) and
    // stage a skill candidate; both are KAI's own state, so it goes through the
    // boundary. A skill is still only STAGED — this route cannot install one.
    const gated = await invokeGate(
      runtime,
      MUTATION_TOOL_IDS.learningPropose,
      event,
      approvalIdOf(body),
    );
    if (!gated.ok) return gated.response;
    return ok({ outcome: gated.result });
  }

  // ── POST /agents/:id/action ──────────────────────────────────────────────────
  //
  // This route used to call the adapter directly, which made it the one
  // executable thing in the Core that no policy rule, no risk classification and
  // no approval ever saw. It now goes through the SAME boundary as every other
  // action — the tool registry — so the invariant holds:
  //
  //     validate -> risk classification -> policy -> (approval) -> execute
  //
  // "agents.run_task" is registered as EXTERNAL, so by default this route parks
  // for approval and returns the approval id instead of running anything. The
  // capability and existence checks below stay where they were: they are
  // read-only pre-checks, and keeping them means an agent that cannot run tasks
  // is still answered with a precise 409 rather than a policy card.
  async function agentAction(req: ApiRequest, params: Record<string, string>): Promise<ApiResponse> {
    const id = params.id ?? "";
    const body = asBodyObject(req.body);
    if (body === null) {
      return bad('"body" must be a JSON object with a string "action"');
    }
    if (typeof body.action !== "string" || body.action.trim().length === 0) {
      return bad('"action" must be a non-empty string');
    }
    if (body.input !== undefined && typeof body.input !== "string") {
      return bad('"input" must be a string when present');
    }
    // An approval the caller already holds. Without one the registry creates it.
    if (body.approvalId !== undefined && typeof body.approvalId !== "string") {
      return bad('"approvalId" must be a string when present');
    }

    const adapter = runtime.registry.get(id);
    if (adapter === undefined) {
      return notFound(`no agent registered as "${id}"`);
    }

    const capabilities = await adapter.capabilities();
    if (!capabilities.includes("run_task")) {
      // Declared, never assumed: an agent that cannot run a task must not be
      // asked to anyway.
      return conflict(
        `agent "${id}" does not support "run_task" (capabilities: ${capabilities.join(", ") || "none"})`,
      );
    }

    const input = typeof body.input === "string" ? body.input : body.action;
    const invocation = await runtime.tools.invoke(
      "agents.run_task",
      { agentId: id, action: body.action, input },
      typeof body.approvalId === "string" ? { approvalId: body.approvalId } : undefined,
    );

    if (invocation.ok) {
      return ok(invocation.result);
    }

    // Failure modes map to the same statuses the rest of the API uses, so a
    // caller can tell "you asked badly" from "policy said no" from "a human has
    // not answered yet".
    switch (invocation.error.code) {
      case "VALIDATION_FAILED":
        return bad(invocation.error.message);
      case "NOT_FOUND":
        return notFound(invocation.error.message);
      case "POLICY_DENIED":
        return forbidden(invocation.error.message);
      case "APPROVAL_REQUIRED":
        // 409 with the id: the action is parked, not performed, and the caller
        // re-issues the same request with `approvalId` once a human decides.
        return {
          status: 409,
          body: {
            error: true,
            reason: invocation.error.message,
            approvalRequired: true,
            approvalId: invocation.error.detail ?? null,
          },
        };
      default:
        return { status: 500, body: { error: true, reason: invocation.error.message } };
    }
  }

  // ── Self-maintenance ─────────────────────────────────────────────────────────
  //
  // GET is the inspection (a READ); POST performs the repairs, so it is a WRITE
  // that goes through the ONE boundary as `maintenance.run`. The identity block
  // is the anti-stale check: it compares the running build id with the build id
  // stamped on disk next to the running code.
  async function maintenanceStatus(): Promise<ApiResponse> {
    return ok({ maintenance: runtime.maintenance.status() });
  }

  async function maintenanceRun(req: ApiRequest): Promise<ApiResponse> {
    const body = asBodyObject(req.body);
    const gated = await invokeGate(runtime, MUTATION_TOOL_IDS.maintenanceRun, body ?? {}, approvalIdOf(body));
    if (!gated.ok) return gated.response;
    return ok({ maintenance: gated.result });
  }

  // ── Conversation sessions (Phase F) ──────────────────────────────────────────
  //
  // KAI's own durable conversations. A session is what a person means by "the
  // chat": it survives a restart, it can be switched back to, and it is the
  // subject the `session` memory scope binds to. Reads execute directly; every
  // mutation goes through the ONE boundary as `session.manage` (a WRITE that
  // changes what KAI knows, never the world).

  /** Map a service result to an ApiResponse, so every session route agrees. */
  function sessionFailure(out: { code: string; reason: string }): ApiResponse {
    return out.code === "NOT_FOUND" ? notFound(out.reason) : conflict(out.reason);
  }

  async function sessionMutation(
    req: ApiRequest,
    params: Record<string, string>,
    op: "create" | "rename" | "archive" | "unarchive" | "activate",
    body: Record<string, unknown> | null,
  ): Promise<ApiResponse> {
    const id = params.id ?? "";
    if (op !== "create" && id.length === 0) return bad('"id" must be a non-empty string');
    const toolInput: Record<string, unknown> = { op };
    if (op !== "create") toolInput.id = id;
    if (op === "rename") {
      const title = body?.title;
      if (typeof title !== "string" || title.trim().length === 0) {
        return bad('"title" must be a non-empty string');
      }
      toolInput.title = title.trim();
    }
    const gated = await invokeGate(runtime, MUTATION_TOOL_IDS.sessionManage, toolInput, approvalIdOf(body));
    if (!gated.ok) return gated.response;
    const result = gated.result as { session?: unknown; ok?: boolean; reason?: string };
    if (result.ok === false) return conflict(result.reason ?? "the session operation was refused");
    return op === "create" ? ok({ session: result.session }, 201) : ok({ session: result.session });
  }

  async function listSessions(req: ApiRequest): Promise<ApiResponse> {
    const q = query(req);
    const statusRaw = q.get("status");
    let status: "ACTIVE" | "ARCHIVED" | undefined;
    if (statusRaw !== null) {
      if (statusRaw !== "ACTIVE" && statusRaw !== "ARCHIVED") {
        return bad('"status" must be ACTIVE or ARCHIVED');
      }
      status = statusRaw;
    }
    const limit = parseLimit(q.get("limit"), "limit");
    if (!limit.ok) return bad(limit.reason);
    const includeArchived = q.get("includeArchived") === "true";
    const opts: { status?: "ACTIVE" | "ARCHIVED"; limit?: number; includeArchived?: boolean } = { includeArchived };
    if (status !== undefined) opts.status = status;
    if (limit.value !== undefined) opts.limit = limit.value;
    const active = runtime.sessions.active();
    return ok({ sessions: runtime.sessions.list(opts), activeSessionId: active?.id ?? null });
  }

  async function getActiveSession(): Promise<ApiResponse> {
    return ok({ session: runtime.sessions.active() });
  }

  async function getSession(params: Record<string, string>): Promise<ApiResponse> {
    const session = runtime.sessions.get(params.id ?? "");
    if (session === null) return notFound(`no session "${params.id ?? ""}" exists`);
    return ok({ session });
  }

  async function getSessionTurns(req: ApiRequest, params: Record<string, string>): Promise<ApiResponse> {
    const q = query(req);
    const limit = parseLimit(q.get("limit"), "limit");
    if (!limit.ok) return bad(limit.reason);
    const out = runtime.sessions.turns(params.id ?? "", limit.value);
    if (!out.ok) return sessionFailure(out);
    return ok({ turns: out.value });
  }

  async function createSessionHandler(req: ApiRequest): Promise<ApiResponse> {
    const body = asBodyObject(req.body) ?? {};
    if (body.title !== undefined && typeof body.title !== "string") {
      return bad('"title" must be a string when present');
    }
    return sessionMutation(req, {}, "create", body);
  }

  async function renameSessionHandler(req: ApiRequest, params: Record<string, string>): Promise<ApiResponse> {
    const body = asBodyObject(req.body);
    if (body === null) return bad('"body" must be a JSON object with a string "title"');
    return sessionMutation(req, params, "rename", body);
  }

  async function sessionLifecycleHandler(
    req: ApiRequest,
    params: Record<string, string>,
    op: "archive" | "unarchive" | "activate",
  ): Promise<ApiResponse> {
    const body = asBodyObject(req.body);
    return sessionMutation(req, params, op, body);
  }

  // ── Runtime identity ─────────────────────────────────────────────────────────
  //
  // The route that makes "which Core am I talking to?" answerable. A client that
  // cannot tell a stale Core from the current one will believe whichever answers
  // first — which is exactly how a build under review was once queried while an
  // older Core served the port.
  async function getIdentity(): Promise<ApiResponse> {
    return ok(loadIdentity());
  }

  // ── Action trace (Phase 1 observability, readable) ───────────────────────────
  //
  // Every executable action already emits an `action.executed` record on the one
  // bus and the bus persists it. This READ exposes the persisted records so the
  // question "who did this, under which authority, and what artifact did it
  // produce?" is answerable over HTTP — including the L2 behaviour-change chain
  // (a `learning.propose` record whose `memoryId` names the learned entry).
  async function listActions(req: ApiRequest): Promise<ApiResponse> {
    const q = query(req);
    const limit = parseLimit(q.get("limit"), "limit");
    if (!limit.ok) return bad(limit.reason);
    const events = runtime.stores.events.listEvents({
      types: ["action.executed"],
      ...(limit.value !== undefined ? { limit: limit.value } : {}),
    });
    return ok({ actions: events.map((event) => event.payload) });
  }

  // ── Composed prompt (the artifact a real turn sends) ─────────────────────────
  //
  // READ: composes the exact system prompt a turn would hand to a worker, using
  // the live memory/skill ports. This is what makes a behaviour change observable
  // rather than asserted: the recalled-memory section shows, byte for byte, that
  // a learned lesson reached a later prompt. It composes; it does not spend a
  // worker turn and it writes nothing.
  async function composePrompt(req: ApiRequest): Promise<ApiResponse> {
    const body = asBodyObject(req.body);
    if (body === null || typeof body.request !== "string" || body.request.trim().length === 0) {
      return bad('"request" must be a non-empty string');
    }
    if (body.scope !== undefined && typeof body.scope !== "string") {
      return bad('"scope" must be a string when present');
    }
    const composed = await runtime.composeTurnPrompt(
      body.request,
      typeof body.scope === "string" ? { scope: body.scope } : {},
    );
    return ok({
      prompt: {
        text: composed.text,
        sections: composed.sections,
        totalChars: composed.totalChars,
        problems: composed.problems,
        order: composed.order,
      },
    });
  }

  // ── Policy (Part I): read the live authority / change the live rules ────────
  //
  // GET /policy is a READ: it reports the authority currently in force — the mode,
  // the full policy state, and the active rule set — so a decision can be explained
  // against the policy that was live when it was made.
  //
  // POST /policy/rules is a SECURITY-RELEVANT WRITE. It replaces the rule set that
  // decides what KAI is authorized to do, so it earns its way through the SAME
  // boundary as every other action (validate -> policy -> approval -> execute) —
  // there is deliberately no second policy path. It is NOT in
  // KAI_INTERNAL_STATE_TOOLS, so the default policy PARKS it for a human: a change
  // that could authorize itself silently would let an HTTP caller loosen its own
  // constraints without a person ever seeing it. (skill.toggle, which only changes
  // what KAI loads, parks for the same reason.) This is what makes R4 exercisable:
  // policy can be changed and the decision observed, but never quietly.
  async function getPolicy(): Promise<ApiResponse> {
    return ok({
      policy: {
        mode: runtime.policy.mode(),
        state: runtime.policy.policyState(),
        rules: runtime.policy.rules(),
      },
    });
  }

  async function setPolicyRulesHandler(req: ApiRequest): Promise<ApiResponse> {
    const body = asBodyObject(req.body);
    if (body === null) {
      return bad('"body" must be a JSON object with a "rules" array');
    }
    if (!Array.isArray(body.rules)) {
      return bad(
        '"rules" must be an array of policy rules (each {id, risk, outcome, tools?})',
      );
    }
    const gated = await invokeGate(
      runtime,
      MUTATION_TOOL_IDS.policySet,
      { rules: body.rules },
      approvalIdOf(body),
    );
    if (!gated.ok) return gated.response;
    const result = gated.result as {
      applied: number;
      dropped: number;
      reason: string;
      mode: string;
      state: unknown;
      rules: unknown;
    };
    return ok({
      policy: { mode: result.mode, state: result.state, rules: result.rules },
      applied: result.applied,
      dropped: result.dropped,
      reason: result.reason,
    });
  }

  // ── Workforce: employees ─────────────────────────────────────────────────────
  //
  // Every handler below reaches the SAME runtime-owned manager. No handler
  // constructs its own: a second manager in the routes would be a second answer to
  // "which employees exist?".

  async function listEmployees(): Promise<ApiResponse> {
    return ok({ employees: runtime.workforce.describe() });
  }

  async function getEmployee(params: Record<string, string>): Promise<ApiResponse> {
    const id = params.id ?? "";
    const found = runtime.workforce.describe(id);
    if (found.length === 0) return notFound(`no employee registered as "${id}"`);
    return ok({ employee: found[0], permissions: runtime.workforce.permissions(id) });
  }

  async function getEmployeeCapabilities(params: Record<string, string>): Promise<ApiResponse> {
    const id = params.id ?? "";
    const found = runtime.workforce.describe(id);
    if (found.length === 0) return notFound(`no employee registered as "${id}"`);
    return ok({ employeeId: id, capabilities: found[0]?.capabilities ?? [] });
  }

  async function employeeLifecycle(
    req: ApiRequest,
    params: Record<string, string>,
    action: "enable" | "disable" | "recover",
  ): Promise<ApiResponse> {
    const id = params.id ?? "";
    if (runtime.workforce.get(id) === undefined) {
      return notFound(`no employee registered as "${id}"`);
    }
    // WRITE (KAI's own workforce state): through the boundary; authorized by default.
    const gated = await invokeGate(
      runtime,
      MUTATION_TOOL_IDS.workforceLifecycle,
      { id, action },
      approvalIdOf(asBodyObject(req.body)),
    );
    if (!gated.ok) return gated.response;
    const result = gated.result as { ok: boolean; error?: { message?: string } };
    // The managers return values, and a refusal is a value too — so the status
    // code reflects what actually happened rather than what was attempted.
    if (!result.ok) return conflict(result.error?.message ?? `${action} was refused`);
    runtime.syncEmployeeViews();
    const after = runtime.workforce.describe(id)[0];
    return ok({ employee: after, action });
  }

  async function registerEmployee(req: ApiRequest): Promise<ApiResponse> {
    const body = asBodyObject(req.body);
    if (body === null) return bad('"body" must be a JSON object with a string "id"');
    if (typeof body.id !== "string" || body.id.trim().length === 0) {
      return bad('"id" must be a non-empty string');
    }
    if (typeof body.name !== "string" || body.name.trim().length === 0) {
      return bad('"name" must be a non-empty string');
    }
    const declared = Array.isArray(body.capabilities)
      ? body.capabilities.filter((c): c is string => typeof c === "string")
      : [];
    if (body.capabilities !== undefined && !Array.isArray(body.capabilities)) {
      return bad('"capabilities" must be an array of strings when present');
    }

    if (runtime.workforce.get(body.id) !== undefined) {
      return conflict(`an employee is already registered as "${body.id}"`);
    }

    // Registered as a KNOWN employee with no transport. The brief forbids
    // installing arbitrary software and forbids claiming availability that is not
    // there, so registration is honest: it exists, it declares its capabilities,
    // and it reports that KAI cannot start it yet.
    const descriptor = createUnavailableEmployee(
      {
        id: body.id,
        name: body.name,
        origin: "registered:api",
        capabilities: declared,
      },
      "registered through the API; no transport is configured for it",
    );
    // WRITE (KAI's own workforce registry): through the boundary; authorized by default.
    const gated = await invokeGate(
      runtime,
      MUTATION_TOOL_IDS.workforceRegister,
      { descriptor, kind: body.id },
      approvalIdOf(body),
    );
    if (!gated.ok) return gated.response;
    const registered = gated.result as { ok: boolean; error?: { message?: string } };
    if (!registered.ok) return conflict(registered.error?.message ?? "registration was refused");
    runtime.syncEmployeeViews();
    const after = runtime.workforce.describe(body.id)[0];
    return ok({ employee: after }, 201);
  }

  // ── KAI's subagents (their own personas, ABOVE the workers) ─────────────────
  //
  // A subagent is not a peer of KAI: it is a persona KAI owns, registered in the
  // SAME workforce. These routes read the persona registry (name, role, soul,
  // visual variant, preferred worker, live status) and can run one task AS a
  // persona — through the ONE policy-governed path, so a run parks for approval
  // exactly like any other EXTERNAL action. There is no second control plane here.

  /** One renderable subagent row: the persona plus its live workforce status. */
  function subagentRow(sub: KaiSubagent): Record<string, unknown> {
    const employee = runtime.workforce.describe(sub.employeeId)[0];
    // The panel's ACTIVE signal is a REAL parked run: the policy-governed
    // `agents.run_task` is EXTERNAL, so a persona run records a PENDING approval
    // whose `action` is the run's task id, `subagent:<id>` (see runtime.runSubagent).
    // This is what lights a persona as working — never a client-side busy flag.
    const pending = runtime.approvals
      .list({ status: "PENDING" })
      .find((a) => a.action === `subagent:${sub.spec.id}`);
    return {
      id: sub.spec.id,
      name: sub.spec.name,
      role: sub.spec.role,
      ...(sub.spec.description !== undefined ? { description: sub.spec.description } : {}),
      soul: runtime.subagents.soul(sub.spec.id),
      ...(sub.spec.objective !== undefined ? { objective: sub.spec.objective } : {}),
      ...(sub.spec.instructions !== undefined ? { instructions: sub.spec.instructions } : {}),
      workerId: sub.spec.workerId,
      ...(sub.spec.model !== undefined ? { model: sub.spec.model } : {}),
      capabilities: [...sub.spec.capabilities],
      visual: runtime.subagents.resolveVisual(sub.spec.id),
      employeeId: sub.employeeId,
      status: employee?.state ?? "UNKNOWN",
      enabled: employee?.enabled ?? false,
      ...(employee?.instanceId !== undefined ? { instanceId: employee.instanceId } : {}),
      problems: employee?.problems ?? [],
      // Real execution state, derived from the parked approval.
      activity: pending !== undefined ? "awaiting approval" : "idle",
      currentTask: pending?.reason ?? null,
      pendingApprovalId: pending?.id ?? null,
      createdAt: sub.createdAt,
    };
  }

  async function listSubagents(): Promise<ApiResponse> {
    return ok({ subagents: runtime.subagents.list().map(subagentRow) });
  }

  async function getSubagent(params: Record<string, string>): Promise<ApiResponse> {
    const id = params.id ?? "";
    const sub = runtime.subagents.get(id);
    if (sub === undefined) return notFound(`no subagent "${id}" is defined`);
    // The persona's OWN sessions: durable KAI sessions bound to this persona
    // (agentId === "kai:<id>"), so a subagent's history never merges into KAI's.
    const sessions = runtime.sessions
      .list()
      .filter((s) => s.agentId === sub.employeeId)
      .slice(0, 20)
      .map((s) => ({
        id: s.id, title: s.title, status: s.status, updatedAt: s.updatedAt,
        turnCount: s.turnCount, agentId: s.agentId, agentSessionId: s.agentSessionId,
      }));
    return ok({ subagent: subagentRow(sub), sessions });
  }

  /**
   * Run one task AS a subagent. The delegation itself is the policy-governed
   * workforce path, so an EXTERNAL run parks: this returns 409 with the approval
   * id rather than performing anything, and the caller re-issues with `approvalId`.
   */
  async function runSubagentHandler(
    req: ApiRequest,
    params: Record<string, string>,
  ): Promise<ApiResponse> {
    const id = params.id ?? "";
    const sub = runtime.subagents.get(id);
    if (sub === undefined) return notFound(`no subagent "${id}" is defined`);
    const body = asBodyObject(req.body);
    const input =
      body !== null && typeof body.input === "string" && body.input.length > 0
        ? body.input
        : `Run ${sub.spec.name}'s next task.`;
    // `runtime.runSubagent` accepts the granted approval id and forwards it to the
    // workforce as `options.approvalId`. Without it the re-issue re-ran the same
    // EXTERNAL policy check and minted a SECOND approval, so a grant was never
    // consumed and the documented "re-issue with `approvalId`" contract could not
    // be satisfied by the caller.
    const result = (await runtime.runSubagent(id, input, approvalIdOf(body))) as {
      ok?: boolean;
      state?: string;
      result?: { state?: string; error?: { code?: string; message?: string; detail?: string } };
      error?: { code?: string; message?: string; detail?: string };
    };
    const err = result.result?.error ?? result.error;
    if (err?.code === "APPROVAL_REQUIRED") {
      return {
        status: 409,
        body: {
          error: true,
          reason: err.message,
          approvalRequired: true,
          approvalId: err.detail ?? null,
          subagentId: id,
        },
      };
    }
    if (err !== undefined) {
      return { status: 409, body: { error: true, reason: err.message ?? "run refused", code: err.code, subagentId: id } };
    }
    // Author the result AS the persona (same composer as the direct-chat
    // path), so a collected run result reads as the agent — never as raw
    // worker output. Additive: existing `result` consumers are untouched.
    const outcome = runOutcome(result);
    const authored = personaReply(sub.spec, outcome.output);
    return ok({ subagentId: id, result, reply: authored.reply, guarded: authored.guarded, state: outcome.state });
  }

  /**
   * Extract the persona-authored reply inputs out of whatever shape the ONE run
   * path returned (a delegation result, a settled approval, or a tool result).
   */
  function runOutcome(value: unknown): { state: string; output: string; taskId?: string } {
    const v = value as {
      result?: { state?: string; output?: string; taskId?: string; result?: { state?: string; output?: string; taskId?: string } };
      state?: string;
      output?: string;
      taskId?: string;
    };
    const inner = v?.result?.result ?? v?.result ?? v;
    return {
      state: typeof inner?.state === "string" ? inner.state : "unknown",
      output: typeof inner?.output === "string" ? inner.output : "",
      ...(typeof inner?.taskId === "string" ? { taskId: inner.taskId } : {}),
    };
  }

  /** Round a millisecond duration to 3dp so the evidence is stable, not noisy. */
  function ms(value: number): number {
    return Math.round(value * 1000) / 1000;
  }

  /** The spec fields a create/edit body may carry (control fields are ignored). */
  function subagentSpecFromBody(
    body: Record<string, unknown>,
    defaults: Record<string, unknown> = {},
  ): Record<string, unknown> {
    const spec: Record<string, unknown> = { ...defaults };
    for (const key of [
      "id",
      "name",
      "role",
      "description",
      "soul",
      "objective",
      "instructions",
      "workerId",
      "model",
      "capabilities",
      "visual",
    ] as const) {
      if (body[key] !== undefined) spec[key] = body[key];
    }
    return spec;
  }

  /**
   * CREATE (or EDIT, by re-defining an existing id) a subagent persona.
   *
   * This is the missing user-facing grant: the only other way to define a persona
   * was a mission `kind:"tool"` step. It goes through the EXISTING workforce path
   * (`MUTATION_TOOL_IDS.subagentCreate === "workforce.subagent"`), so an EXTERNAL
   * registrant PARKS: the first call returns 409 with an `approvalId` and does NOT
   * define anything, and the caller re-issues with that id once a human decides.
   * There is deliberately NO second registry.
   */
  async function createSubagentHandler(req: ApiRequest): Promise<ApiResponse> {
    const body = asBodyObject(req.body);
    if (body === null) return bad('"body" must be a JSON object with at least an "id", "name", "role", "soul" and "workerId"');
    const spec = subagentSpecFromBody(body);
    if (typeof spec.id !== "string" || spec.id.length === 0) return bad('"id" must be a non-empty string');
    const gated = await invokeGate(runtime, MUTATION_TOOL_IDS.subagentCreate, spec, approvalIdOf(body));
    if (!gated.ok) return gated.response;
    const result = gated.result as {
      ok?: boolean;
      error?: { message?: string };
      subagent?: KaiSubagent;
    };
    if (result.ok === false) return conflict(result.error?.message ?? "the subagent was refused");
    const id = result.subagent?.spec.id ?? (spec.id as string);
    const defined = runtime.subagents.get(id);
    return ok(
      { subagent: defined !== undefined ? subagentRow(defined) : null, created: true, action: "create" },
      201,
    );
  }

  /**
   * DUPLICATE an existing persona under a new id, through the SAME gate. The body
   * supplies the new `id` (and optionally a new `name`); everything else is copied
   * from the source unless overridden.
   */
  async function duplicateSubagentHandler(
    req: ApiRequest,
    params: Record<string, string>,
  ): Promise<ApiResponse> {
    const id = params.id ?? "";
    const src = runtime.subagents.get(id);
    if (src === undefined) return notFound(`no subagent "${id}" is defined`);
    const body = asBodyObject(req.body);
    if (body === null) return bad('"body" must be a JSON object with the new "id"');
    const spec = subagentSpecFromBody(body, {
      ...src.spec,
      capabilities: [...src.spec.capabilities],
      ...(src.spec.visual !== undefined ? { visual: src.spec.visual } : {}),
    });
    if (typeof spec.id !== "string" || spec.id.length === 0) return bad('"id" (the duplicate\'s) must be a non-empty string');
    if (spec.id === src.spec.id) return bad('the duplicate needs a NEW "id"');
    const gated = await invokeGate(runtime, MUTATION_TOOL_IDS.subagentCreate, spec, approvalIdOf(body));
    if (!gated.ok) return gated.response;
    const result = gated.result as { ok?: boolean; error?: { message?: string }; subagent?: KaiSubagent };
    if (result.ok === false) return conflict(result.error?.message ?? "the duplicate was refused");
    const newId = result.subagent?.spec.id ?? (spec.id as string);
    const defined = runtime.subagents.get(newId);
    return ok(
      { subagent: defined !== undefined ? subagentRow(defined) : null, created: true, duplicatedFrom: src.spec.id },
      201,
    );
  }

  /**
   * Archive / unarchive a persona. Archive PARKS the persona (its employee is
   * disabled, so it is not delegate-able) without destroying its definition; the
   * operation goes through the EXISTING `workforce.lifecycle` gate, so it too can
   * park for a human. There is no separate subagent registry to delete from.
   */
  async function subagentLifecycleHandler(
    req: ApiRequest,
    params: Record<string, string>,
    action: "enable" | "disable",
  ): Promise<ApiResponse> {
    const id = params.id ?? "";
    const sub = runtime.subagents.get(id);
    if (sub === undefined) return notFound(`no subagent "${id}" is defined`);
    const body = asBodyObject(req.body);
    const gated = await invokeGate(
      runtime,
      MUTATION_TOOL_IDS.workforceLifecycle,
      { id: sub.employeeId, action },
      approvalIdOf(body),
    );
    if (!gated.ok) return gated.response;
    return ok({ subagent: subagentRow(sub), action: action === "disable" ? "archive" : "unarchive" });
  }

  /** The persona's OWN session, from an explicit id (validated to belong to it) or
   *  its newest one, creating a fresh session when it has none. */
  function personaSessionFor(sub: KaiSubagent, requestedId?: string): { id: string } | null {
    if (requestedId !== undefined && requestedId.length > 0) {
      const session = runtime.sessions.get(requestedId);
      if (session === null || session.agentId !== sub.employeeId) return null;
      return { id: session.id };
    }
    const owned = runtime.sessions
      .list({ includeArchived: false })
      .filter((s) => s.agentId === sub.employeeId);
    const newest = owned[0];
    if (newest !== undefined) return { id: newest.id };
    return null;
  }

  /**
   * Create a NEW session owned by a persona. It is gated through the ONE
   * `session.manage` path (WRITE) with `agentId: "kai:<id>"`, so the session is
   * born SEPARATE: it is never KAI's active conversation, and its turns never
   * merge into KAI's history.
   */
  async function createSubagentSessionHandler(
    req: ApiRequest,
    params: Record<string, string>,
  ): Promise<ApiResponse> {
    const id = params.id ?? "";
    const sub = runtime.subagents.get(id);
    if (sub === undefined) return notFound(`no subagent "${id}" is defined`);
    const body = asBodyObject(req.body) ?? {};
    const title =
      typeof body.title === "string" && body.title.trim().length > 0
        ? body.title.trim()
        : `${sub.spec.name} — own session`;
    const gated = await invokeGate(
      runtime,
      MUTATION_TOOL_IDS.sessionManage,
      { op: "create", title, agentId: sub.employeeId },
      approvalIdOf(body),
    );
    if (!gated.ok) return gated.response;
    const result = gated.result as { session?: unknown; ok?: boolean; reason?: string };
    if (result.ok === false) return conflict(result.reason ?? "the session could not be created");
    return ok({ session: result.session, subagentId: sub.spec.id }, 201);
  }

  /** The turns of a persona's OWN session (validated to belong to it). */
  async function getSubagentSessionTurns(
    req: ApiRequest,
    params: Record<string, string>,
  ): Promise<ApiResponse> {
    const id = params.id ?? "";
    const sub = runtime.subagents.get(id);
    if (sub === undefined) return notFound(`no subagent "${id}" is defined`);
    const sessionId = params.sessionId ?? "";
    const session = runtime.sessions.get(sessionId);
    if (session === null || session.agentId !== sub.employeeId) {
      return notFound(`no session "${sessionId}" belongs to subagent "${id}"`);
    }
    const q = query(req);
    const limit = parseLimit(q.get("limit"), "limit");
    if (!limit.ok) return bad(limit.reason);
    const out = runtime.sessions.turns(sessionId, limit.value);
    if (!out.ok) return sessionFailure(out);
    return ok({ turns: out.value, subagentId: id, sessionId });
  }

  /**
   * SEND A PROMPT to one persona, on ITS OWN session, and get a reply AUTHORED BY
   * THAT PERSONA.
   *
   * The work itself is the ONE policy-governed run (`runtime.runSubagent`): the
   * first call PARKS (409 + `approvalId`) unless policy already authorizes it. The
   * caller re-issues with `approvalId`; this handler then records the human's
   * decision through the SAME `approval.decide` gate (`runtime.decideApproval`
   * re-issues the EXACT parked call once), composes the persona's OWN reply from
   * its name/role/soul, and records it as an assistant turn on the persona's own
   * session. The reply is never KAI's and never the worker's own identity.
   */
  async function subagentMessageHandler(
    req: ApiRequest,
    params: Record<string, string>,
  ): Promise<ApiResponse> {
    const id = params.id ?? "";
    const sub = runtime.subagents.get(id);
    if (sub === undefined) return notFound(`no subagent "${id}" is defined`);
    const body = asBodyObject(req.body);
    if (body === null) return bad('"body" must be a JSON object with a non-empty "input"');
    const input = typeof body.input === "string" ? body.input.trim() : "";
    if (input.length === 0) return bad('"input" must be a non-empty string');

    // The persona's own session: an explicit sessionId (must belong to it) or a
    // fresh one, created through the ONE gated `session.manage` path.
    const requested = typeof body.sessionId === "string" ? body.sessionId : undefined;
    let session = personaSessionFor(sub, requested);
    if (requested !== undefined && requested.length > 0 && session === null) {
      return notFound(`no session "${requested}" belongs to subagent "${id}"`);
    }
    if (session === null) {
      const created = runtime.sessions.create({ title: `${sub.spec.name} — own session`, agentId: sub.employeeId });
      session = { id: created.id };
    }

    // The user's own message is part of the persona's history, recorded first.
    runtime.sessions.recordTurn({ sessionId: session.id, role: "user", text: input });

    const approvalId = approvalIdOf(body);
    // ── Minimal execution observability ───────────────────────────────────────
    // The run's ACTUAL wall-clock window, measured on the process's MONOTONIC
    // clock (performance.now) so two concurrent runs can be compared without
    // clock-skew noise. `executionId` is the approval id when the human's decision
    // is what executed the parked run (a real, service-minted identity), and a
    // generated id otherwise. Nothing here invents timing: it wraps the real run.
    const execStartMono = performance.now();
    const execStartWall = new Date().toISOString();
    let outcome: { state: string; output: string; taskId?: string };
    if (approvalId !== undefined) {
      // The human's decision: through the SAME approval gate, which re-issues the
      // parked run exactly once and returns its settled result.
      const decided = await invokeGate(
        runtime,
        MUTATION_TOOL_IDS.approvalDecide,
        { id: approvalId, approved: true },
        approvalId,
      );
      if (!decided.ok) return decided.response;
      outcome = runOutcome(decided.result);
    } else {
      // NO approvalId in the body: this is the FRESH attempt, so the two-arg call
      // is the correct shape — the policy-governed workforce path either authorizes
      // the run or PARKS it (409 + a freshly minted id) for the caller to decide and
      // re-issue. The id-present case never reaches here: it is handled above
      // through the `approval.decide` gate, so forwarding `approvalIdOf(body)` here
      // would always pass `undefined` — dead code, unlike the pre-6710b7f /run
      // handler where the id was dropped on every path.
      const result = (await runtime.runSubagent(sub.spec.id, input)) as {
        ok?: boolean;
        result?: { state?: string; error?: { code?: string; message?: string; detail?: string } };
        error?: { code?: string; message?: string; detail?: string };
      };
      const err = result.result?.error ?? result.error;
      if (err?.code === "APPROVAL_REQUIRED") {
        return {
          status: 409,
          body: {
            error: true,
            reason: err.message,
            approvalRequired: true,
            approvalId: err.detail ?? null,
            subagentId: id,
            sessionId: session.id,
            parked: true,
          },
        };
      }
      if (err !== undefined) {
        return {
          status: 409,
          body: { error: true, reason: err.message ?? "run refused", code: err.code, subagentId: id, sessionId: session.id },
        };
      }
      outcome = runOutcome(result);
    }
    const execEndMono = performance.now();
    const execEndWall = new Date().toISOString();
    const execution = {
      executionId:
        approvalId !== undefined
          ? approvalId
          : `exec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      subagentId: id,
      sessionId: session.id,
      worker: sub.spec.workerId,
      startTime: execStartWall,
      endTime: execEndWall,
      startMonotonicMs: ms(execStartMono),
      endMonotonicMs: ms(execEndMono),
      durationMs: ms(execEndMono - execStartMono),
      status: outcome.state,
      ...(outcome.taskId !== undefined ? { workerTaskId: outcome.taskId } : {}),
    };

    const authored = personaReply(sub.spec, outcome.output);
    runtime.sessions.recordTurn({
      sessionId: session.id,
      role: "assistant",
      text: authored.reply,
      agentId: sub.employeeId,
    });
    return ok({
      subagentId: id,
      sessionId: session.id,
      reply: authored.reply,
      guarded: authored.guarded,
      state: outcome.state,
      execution,
    });
  }

  // ── Capabilities ─────────────────────────────────────────────────────────────

  async function listCapabilities(): Promise<ApiResponse> {
    return ok({ capabilities: runtime.capabilities.registry.list() });
  }

  /**
   * Reads a capability AND probes it.
   *
   * Probing here rather than at Core startup is deliberate: connecting the CUA
   * driver and launching a headless browser on every boot would make KAI's start
   * depend on two external processes it may never use — and turned the test suite
   * into a browser-launcher. Asking about a capability is the moment to measure it.
   */
  async function getCapability(params: Record<string, string>): Promise<ApiResponse> {
    const id = params.id ?? "";
    const capability = runtime.capabilities.registry.get(id);
    if (capability === undefined) return notFound(`no capability registered as "${id}"`);
    const measured = await runtime.capabilities.registry.checkHealth(id).catch(() => undefined);
    return ok({ capability, status: measured ?? runtime.capabilities.registry.status(id) ?? null });
  }

  /**
   * Exercise a capability through the SAME boundary as everything else.
   *
   * Not a bypass with a test-shaped name: this invokes the capability's tool, so
   * the action is validated, risk-classified and policy-checked, and an approval is
   * required when the capability's risk demands one. That is what makes "KAI used
   * its own capability, under policy, without delegating" demonstrable rather than
   * asserted.
   */
  async function testCapability(req: ApiRequest, params: Record<string, string>): Promise<ApiResponse> {
    const id = params.id ?? "";
    if (runtime.capabilities.registry.get(id) === undefined) {
      return notFound(`no capability registered as "${id}"`);
    }
    const body = asBodyObject(req.body) ?? {};
    if (body.action !== undefined && typeof body.action !== "string") {
      return bad('"action" must be a string when present');
    }
    const action = typeof body.action === "string" ? body.action : undefined;
    // An approval ALREADY GRANTED travels back in on the retry. Without this the gate
    // would ask again forever and a DESTRUCTIVE capability could never be exercised
    // even once it had been approved — the gate would be a wall, not a gate.
    const approvalId = typeof body.approvalId === "string" ? body.approvalId : undefined;
    // The driver-shaped detail (which key, which text, which window) rides in "input".
    const input =
      typeof body.input === "object" && body.input !== null
        ? (body.input as Record<string, unknown>)
        : undefined;

    const invoked = await runtime.tools.invoke(
      `capability.${id}`,
      {
        ...(action !== undefined ? { action } : {}),
        ...(input !== undefined ? { input } : {}),
      },
      approvalId !== undefined ? { approvalId } : undefined,
    );
    if (invoked.ok) {
      return ok({ capabilityId: id, action: action ?? null, result: invoked.result });
    }
    switch (invoked.error.code) {
      case "APPROVAL_REQUIRED":
        return {
          status: 409,
          body: {
            error: true,
            reason: invoked.error.message,
            approvalRequired: true,
            approvalId: invoked.error.detail ?? null,
          },
        };
      case "POLICY_DENIED":
        return forbidden(invoked.error.message);
      case "NOT_FOUND":
        return notFound(invoked.error.message);
      default:
        return conflict(invoked.error.message);
    }
  }

  // ── Route table ──────────────────────────────────────────────────────────────
  //
  // CLASSIFICATION (Phase 2 Part I). Every route states what it ACTUALLY does;
  // the classification is not inferred from the HTTP method. A route that mutates
  // KAI's own state (WRITE), acts outside this machine (EXTERNAL) or overwrites
  // or removes files (DESTRUCTIVE) is enforced through the ONE tool registry via
  // `invokeGate` above; a READ executes directly. This table is the honesty
  // contract: silently labelling a mutating route READ is exactly what Part I
  // exists to prevent, so each entry below is chosen from what its handler does.
  //
  //   READ         GET /identity, GET /state, GET /employees,
  //                GET /employees/:id, GET /employees/:id/capabilities,
  //                GET /capabilities, GET /capabilities/:id,
  //                GET /agents, GET /agents/:id,
  //                GET /missions, GET /missions/:id, GET /notifications,
  //                GET /approvals, GET /memory, GET /memory/search,
  //                GET /memory/journal, GET /memory/:id,
  //                GET /skills, GET /skills/relevant, GET /skills/staging,
  //                GET /skills/staging/:stagedId, GET /skills/:id/load,
  //                GET /skills/:id, GET /schedules, GET /recovery/status,
  //                POST /recovery/classify, GET /checkpoints,
  //                GET /learning/staged, GET /policy
  //   WRITE        POST /employees/register,
  //                POST /employees/:id/enable|disable|recover,
  //                POST /missions, POST /missions/:id/cancel,
  //                POST /notifications/:id/read, POST /approvals/:id/decide,
  //                POST /memory, POST /memory/write,
  //                POST /skills/staging/:stagedId/approve,
  //                POST /skills/staging/:stagedId/install,
  //                POST /skills/:id/enable|disable,
  //                POST /schedules, POST /schedules/:id/cancel,
  //                POST /scheduler/recover, POST /checkpoints,
  //                POST /learning/propose,
  //                POST /learning/staged/:stagedId/approve,
  //                POST /policy/rules
  //   EXTERNAL     POST /capabilities/:id/test, POST /agents/:id/action
  //   DESTRUCTIVE  POST /skills/:id/delete, POST /checkpoints/:id/restore
  //
  // Two entries deserve a note. POST /recovery/classify is a READ: it reports
  // how the acceptance ledger classifies one execution and writes nothing. GET
  // /capabilities/:id is a READ that MEASURES the capability's health — the probe
  // may transiently connect a transport, but it changes no KAI state and takes no
  // action of its own. POST /policy/rules is a WRITE that the default policy PARKS
  // (it is not in KAI_INTERNAL_STATE_TOOLS): changing what KAI is authorized to do
  // is security-relevant, so it requires a human by default.
  const routeDefs: RouteDef[] = [
    route("GET", "/identity", "READ", () => getIdentity()),
    // KAI's live soul: READ serves the current text + version; WRITE replaces
    // it through the policy-gated soul.set tool (parks by default).
    route("GET", "/soul", "READ", () => getSoul()),
    // Replaces KAI's identity: owner-only.
    route("POST", "/soul", "WRITE", (req) => setSoulHandler(req), { requiresOwner: true }),
    // KAI's own settings: READ serves stored rows + effective values with
    // sources; WRITE patches (or resets) through the parking `settings.update`.
    route("GET", "/settings", "READ", () => Promise.resolve(getSettings())),
    route("POST", "/settings", "WRITE", (req) => setSettingsHandler(req)),
    route("POST", "/settings/reset", "WRITE", (req) => resetSettingsHandler(req)),
    // Providers + models: live probes (READ; test MEASURES like capabilities).
    route("GET", "/providers", "READ", () => listProviders()),
    route("GET", "/providers/:id/test", "READ", (_req, p) => testProvider(p)),
    route("GET", "/models", "READ", () => listModels()),
    route("POST", "/models/use", "WRITE", (req) => useModelHandler(req)),
    // Orchestration: board + bench + activity reads; work-item lifecycle writes.
    // Delegation itself stays policy-governed inside the loop (agents.run_task).
    route("GET", "/work-items", "READ", (req) => Promise.resolve(listWorkItems(req))),
    route("POST", "/work-items", "WRITE", (req) => createWorkItem(req)),
    route("GET", "/work-items/:id", "READ", (_req, p) => Promise.resolve(getWorkItem(p))),
    route("POST", "/work-items/:id/run", "WRITE", (req, p) => runWorkItem(req, p)),
    route("POST", "/work-items/:id/review", "READ", (req, p) => reviewWorkItem(req, p)),
    route("POST", "/work-items/audit", "WRITE", (req) => auditWorkItem(req)),
    route("GET", "/bench", "READ", () => Promise.resolve(listBench())),
    route("GET", "/activity", "READ", (req) => Promise.resolve(listActivity(req))),
    // Goals: intake, challenge, plan, approval. Reads are open; every mutation
    // is owner-only, because a goal is what authorises KAI to act.
    route("GET", "/goals", "READ", () => Promise.resolve(listGoalsHandler())),
    route("POST", "/goals", "WRITE", (req) => createGoalHandler(req), { requiresOwner: true }),
    route("GET", "/goals/:id", "READ", (req, p) => Promise.resolve(getGoalHandler(req, p))),
    route("POST", "/goals/:id/state", "WRITE", (req, p) => goalStateHandler(req, p), { requiresOwner: true }),
    route("POST", "/goals/:id/challenge", "WRITE", (req, p) => challengeGoalHandler(req, p), { requiresOwner: true }),
    route("POST", "/goals/:id/plan", "WRITE", (req, p) => planGoalHandler(req, p), { requiresOwner: true }),
    route("POST", "/goals/:id/approve", "WRITE", (req, p) => approvePlanHandler(req, p), { requiresOwner: true }),
    route("POST", "/goals/:id/reject", "WRITE", (req, p) => rejectPlanHandler(req, p), { requiresOwner: true }),
    // KAI Doer: the autonomous switch (Guard stays on and is never toggled here).
    route("GET", "/doer", "READ", () => Promise.resolve(getDoer())),
    // Changes KAI's autonomy: owner-only.
    route("POST", "/doer", "WRITE", (req) => setDoerHandler(req), { requiresOwner: true }),
    route("GET", "/doer/pending", "READ", () => Promise.resolve(listDoerPending())),
    // The KAI Visual Engine's seam: structured visual intent, validated HERE.
    // READ: these routes compute and validate; they mutate nothing.
    route("POST", "/visual/compile", "READ", (req) => compileVisualHandler(req)),
    route("POST", "/visual/validate", "READ", (req) => validateVisualHandler(req)),
    // Action trace + the composed-prompt artifact (Phase 4 gap 4). Both READ.
    route("GET", "/actions", "READ", (req) => listActions(req)),
    route("POST", "/prompts/compose", "READ", (req) => composePrompt(req)),
    route("GET", "/policy", "READ", () => getPolicy()),
    // Rewrites what KAI is allowed to do: owner-only.
    route("POST", "/policy/rules", "WRITE", (req) => setPolicyRulesHandler(req), { requiresOwner: true }),
    route("GET", "/state", "READ", () => getState()),
    route("GET", "/employees", "READ", () => listEmployees()),
    route("GET", "/employees/:id", "READ", (_req, p) => getEmployee(p)),
    route("GET", "/employees/:id/capabilities", "READ", (_req, p) => getEmployeeCapabilities(p)),
    route("POST", "/employees/register", "WRITE", (req) => registerEmployee(req)),
    route("POST", "/employees/:id/enable", "WRITE", (req, p) => employeeLifecycle(req, p, "enable")),
    route("POST", "/employees/:id/disable", "WRITE", (req, p) => employeeLifecycle(req, p, "disable")),
    route("POST", "/employees/:id/recover", "WRITE", (req, p) => employeeLifecycle(req, p, "recover")),
    // KAI's subagents — its own personas. Literal "/subagents" and
    // "/subagents/runs" before "/subagents/:id": first match wins, so a
    // literal must never sit behind the parameter it would match.
    route("GET", "/subagents", "READ", () => listSubagents()),
    // Tracked runs: what is in flight right now, and cancelling a parked one.
    route("GET", "/subagents/runs", "READ", () => Promise.resolve(ok({ runs: runtime.activeSubagentRuns() }))),
    route("POST", "/subagents/runs/:runId/cancel", "WRITE", async (_req, p) => {
      const outcome = await runtime.cancelSubagentRun(p.runId ?? "");
      return outcome.ok ? ok({ runId: outcome.runId, cancelled: true }) : bad(outcome.reason);
    }),
    // Create/edit a persona (the missing user-facing grant), gated to park.
    route("POST", "/subagents", "EXTERNAL", (req) => createSubagentHandler(req)),
    route("GET", "/subagents/:id", "READ", (_req, p) => getSubagent(p)),
    route("POST", "/subagents/:id", "EXTERNAL", (req) => createSubagentHandler(req)),
    route("POST", "/subagents/:id/duplicate", "EXTERNAL", (req, p) => duplicateSubagentHandler(req, p)),
    route("POST", "/subagents/:id/archive", "WRITE", (req, p) => subagentLifecycleHandler(req, p, "disable")),
    route("POST", "/subagents/:id/unarchive", "WRITE", (req, p) => subagentLifecycleHandler(req, p, "enable")),
    route("POST", "/subagents/:id/run", "EXTERNAL", (req, p) => runSubagentHandler(req, p)),
    // Per-subagent SESSIONS: its own history, never merged into KAI's.
    route("POST", "/subagents/:id/sessions", "WRITE", (req, p) => createSubagentSessionHandler(req, p)),
    route("GET", "/subagents/:id/sessions/:sessionId/turns", "READ", (req, p) => getSubagentSessionTurns(req, p)),
    route("POST", "/subagents/:id/message", "EXTERNAL", (req, p) => subagentMessageHandler(req, p)),
    route("GET", "/capabilities", "READ", () => listCapabilities()),
    route("GET", "/capabilities/:id", "READ", (_req, p) => getCapability(p)),
    route("POST", "/capabilities/:id/test", "EXTERNAL", (req, p) => testCapability(req, p)),
    route("GET", "/agents", "READ", () => listAgents()),
    route("GET", "/agents/:id", "READ", (_req, p) => getAgent(p)),
    route("POST", "/agents/:id/action", "EXTERNAL", (req, p) => agentAction(req, p)),
    route("GET", "/missions", "READ", (req) => listMissions(req)),
    route("POST", "/missions", "WRITE", (req) => createMissionHandler(req)),
    route("GET", "/missions/:id", "READ", (_req, p) => getMission(p)),
    route("POST", "/missions/:id/cancel", "WRITE", (req, p) => cancelMission(req, p)),
    route("POST", "/missions/:id/start", "WRITE", (req, p) => startMission(req, p)),
    route("POST", "/plans", "WRITE", (req) => createPlanHandler(req)),
    route("GET", "/notifications", "READ", (req) => listNotifications(req)),
    route("POST", "/notifications/:id/read", "WRITE", (req, p) => markNotificationRead(req, p)),
    route("GET", "/approvals", "READ", (req) => listApprovals(req)),
    // A human decision. Unattested, ANY local process could approve any
    // pending approval and release the parked action behind it — including the
    // switch that enables autonomy. Owner-only.
    route("POST", "/approvals/:id/decide", "WRITE", (req, p) => decideApproval(req, p), { requiresOwner: true }),
    route("GET", "/memory", "READ", (req) => listMemory(req)),
    route("POST", "/memory", "WRITE", (req) => createMemoryHandler(req)),
    // Memory engine (literal segments registered before "/memory/:id").
    route("GET", "/memory/search", "READ", (req) => searchMemory(req)),
    route("POST", "/memory/write", "WRITE", (req) => writeMemoryHandler(req)),
    // Governed cross-subagent share (WRITE, deliberately NOT internal-state: parks).
    route("POST", "/memory/share", "WRITE", (req) => shareMemoryHandler(req)),
    route("GET", "/memory/journal", "READ", (req) => memoryJournal(req)),
    route("GET", "/memory/:id", "READ", (_req, p) => getMemoryEngineEntry(p)),
    route("POST", "/memory/:id/correct", "WRITE", (req, p) => correctMemoryHandler(req, p)),
    route("POST", "/memory/:id/delete", "DESTRUCTIVE", (req, p) => forgetMemoryHandler(req, p)),
    // Skills catalogue.
    route("GET", "/skills", "READ", () => listSkills()),
    route("GET", "/skills/relevant", "READ", (req) => relevantSkills(req)),
    // Skills staging (literal segments before "/skills/:id").
    route("GET", "/skills/staging", "READ", () => listStagedSkills()),
    route("GET", "/skills/staging/:stagedId", "READ", (_req, p) => inspectStagedSkill(p)),
    route("POST", "/skills/staging/:stagedId/approve", "WRITE", (req, p) => approveStagedSkill(req, p)),
    route("POST", "/skills/staging/:stagedId/install", "WRITE", (req, p) => installStagedSkill(req, p)),
    route("POST", "/skills/staging/:stagedId/discard", "WRITE", (_req, p) => Promise.resolve(discardStagedSkill(p))),
    route("POST", "/skills/:id/delete", "DESTRUCTIVE", (req, p) => deleteSkill(req, p)),
    route("POST", "/skills/:id/disable", "WRITE", (req, p) => setSkillEnabled(req, p, false)),
    route("POST", "/skills/:id/enable", "WRITE", (req, p) => setSkillEnabled(req, p, true)),
    route("GET", "/skills/:id/load", "READ", (_req, p) => loadSkill(p)),
    route("GET", "/skills/:id", "READ", (_req, p) => inspectSkill(p)),
    // Plugins (foundation): catalogue reads are free; lifecycle mutations go
    // through the policy-gated plugin.lifecycle tool (parks by default).
    route("GET", "/plugins", "READ", () => Promise.resolve(ok({ plugins: runtime.plugins.list() }))),
    route("GET", "/plugins/:id", "READ", (_req, p) => {
      const record = runtime.plugins.get(p.id ?? "");
      return Promise.resolve(record === null ? notFound(`no plugin "${p.id ?? ""}" is defined`) : ok({ plugin: record }));
    }),
    route("POST", "/plugins/:id/enable", "WRITE", (req, p) => pluginLifecycle(req, p, "enable")),
    route("POST", "/plugins/:id/disable", "WRITE", (req, p) => pluginLifecycle(req, p, "disable")),
    route("POST", "/plugins/:id/config", "WRITE", (req, p) => pluginLifecycle(req, p, "config")),
    // Scheduler.
    route("GET", "/schedules", "READ", () => listSchedules()),
    route("POST", "/schedules", "WRITE", (req) => createScheduleHandler(req)),
    route("POST", "/schedules/:id/cancel", "WRITE", (req, p) => cancelSchedule(req, p)),
    route("POST", "/scheduler/recover", "WRITE", (req) => recoverScheduler(req)),
    // Recovery (acceptance ledger).
    route("GET", "/recovery/status", "READ", () => recoveryStatus()),
    route("POST", "/recovery/classify", "READ", (req) => recoveryClassify(req)),
    // Checkpoints.
    route("GET", "/checkpoints", "READ", () => listCheckpoints()),
    route("POST", "/checkpoints", "WRITE", (req) => createCheckpointHandler(req)),
    route("POST", "/checkpoints/:id/restore", "DESTRUCTIVE", (req, p) => restoreCheckpointHandler(req, p)),
    // Learning.
    route("POST", "/learning/propose", "WRITE", (req) => proposeLearning(req)),
    route("GET", "/learning/staged", "READ", () => listStagedSkills()),
    route("POST", "/learning/staged/:stagedId/approve", "WRITE", (req, p) => approveStagedSkill(req, p)),
    // Self-maintenance: inspect (READ) then repair (WRITE, through the boundary).
    route("GET", "/maintenance/status", "READ", () => maintenanceStatus()),
    route("POST", "/maintenance/run", "WRITE", (req) => maintenanceRun(req)),
    // Conversation sessions (Phase F). Literal segments ("/sessions/active")
    // are registered before "/sessions/:id", which would otherwise swallow them.
    route("GET", "/sessions", "READ", (req) => listSessions(req)),
    route("GET", "/sessions/active", "READ", () => getActiveSession()),
    route("POST", "/sessions", "WRITE", (req) => createSessionHandler(req)),
    route("GET", "/sessions/:id/turns", "READ", (req, p) => getSessionTurns(req, p)),
    route("GET", "/sessions/:id", "READ", (_req, p) => getSession(p)),
    route("POST", "/sessions/:id/rename", "WRITE", (req, p) => renameSessionHandler(req, p)),
    route("POST", "/sessions/:id/archive", "WRITE", (req, p) => sessionLifecycleHandler(req, p, "archive")),
    route("POST", "/sessions/:id/unarchive", "WRITE", (req, p) => sessionLifecycleHandler(req, p, "unarchive")),
    route("POST", "/sessions/:id/activate", "WRITE", (req, p) => sessionLifecycleHandler(req, p, "activate")),
  ];

  // ── MCP route surface (integration handover #1) ─────────────────────────────
  // The 15-route /mcp surface, mounted into THIS table so a live `GET /mcp`
  // answers instead of 404. The handlers are the MCP module's own; every
  // mutation goes through `runtime.tools.invoke`, so the MCP surface cannot
  // bypass the policy boundary. Classification comes from the MCP route table
  // (READ / WRITE / EXTERNAL — never DESTRUCTIVE by construction).
  registerMcpRoutes(
    {
      register: (
        method: string,
        pattern: string,
        handler: McpRouteHandler,
        classification: McpRouteClassification,
      ) => {
        routeDefs.push(route(method, pattern, classification, handler));
      },
    },
    { manager: runtime.mcp, tools: runtime.tools },
  );

  // ── Tool route surface (integration handover #2) ────────────────────────────
  // The generic /tools surface — LIST the ONE registry, describe one tool, and
  // invoke one tool by id — mounted into THIS table so a live `GET /tools`
  // answers instead of 404. `POST /tools/:id/invoke` is EXTERNAL: the handler
  // calls `runtime.tools.invoke`, so the registry's own chain (validate ->
  // risk -> policy -> (approval) -> execute) gates every run; a tool that parks
  // answers 409 `{approvalRequired, approvalId}` and nothing executes until the
  // caller re-issues with that id. There is no second policy path in the tools
  // module, and none here.
  registerToolRoutes(
    { route: (m, p, c, h) => routeDefs.push(route(m, p, c, h)) },
    { tools: runtime.tools },
  );

  // ── Canonical identity route surface (integration handover) ─────────────────
  // GET /identity/model — the ONE canonical identity model (the twelve owner
  // fields over the REAL running subsystems), exposed so it is observable over
  // HTTP rather than merely composed. READ: it projects live objects and writes
  // nothing. This is an ADDITION beside GET /identity (build identity); no
  // existing route shape changes.
  registerIdentityRoutes(
    { route: (m, p, c, h) => routeDefs.push(route(m, p, c, h)) },
    { model: runtime.identityModel },
  );

  function match(
    method: string,
    path: string,
  ): { def: RouteDef; params: Record<string, string> } | null {
    const segs = path.split("/").filter((s) => s.length > 0);
    for (const def of routeDefs) {
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
        if (pattern.startsWith(":")) {
          params[pattern.slice(1)] = decodeURIComponent(actual);
        } else if (pattern !== actual) {
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
    if (hit === null) {
      return notFound(`no route for ${method || "(no method)"} ${path}`);
    }

    // Owner-only routes: a local process that cannot present the owner
    // credential must not be able to widen KAI's autonomy, approve a plan or
    // release a parked action. Enforced only when a credential exists.
    if (hit.def.requiresOwner === true && request.ownerAuthConfigured === true && request.attested !== true) {
      return {
        status: 401,
        body: {
          error: true,
          code: "OWNER_AUTH_REQUIRED",
          reason:
            "this control changes what KAI is authorized to do, so it requires the owner credential from the installed desktop app",
        },
      };
    }

    try {
      return await hit.def.handler(request, hit.params);
    } catch {
      // A throwing dependency must not escape as an unhandled rejection. The
      // reason is deliberately generic: a thrown Error message can carry a file
      // path or a secret, and neither belongs in an HTTP response.
      return {
        status: 500,
        body: {
          error: true,
          code: "INTERNAL",
          reason: `internal error while handling ${method} ${path}`,
        },
      };
    }
  }

  return {
    handle,
    routes(): string[] {
      return routeDefs.map((d) => `${d.method} ${d.pattern}`);
    },
  };
}
