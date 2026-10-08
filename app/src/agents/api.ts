/**
 * agents/api.ts — the ONE typed transport for KAI's agent surface.
 *
 * Stream C owns this module. It is deliberately standalone: it talks to the real
 * Core routes over HTTP with its own small request primitive, so it never has to
 * edit the shared `core/kai-core.ts` client (which the island also uses). It
 * imports no island code and touches no global at import time, so it runs in the
 * Tauri webview, in a plain browser under `npm run dev`, and under `node --test`
 * with an injected `fetchImpl`.
 *
 * The routes it speaks (all real, all in `core/src/api/routes.ts`):
 *   GET  /subagents                       list KAI's own personas
 *   GET  /subagents/:id                   one persona + the sessions bound to it
 *   POST /subagents                       create / edit a persona (WRITE, direct)
 *   POST /subagents/:id                   edit by re-defining
 *   POST /subagents/:id/duplicate         copy under a new id
 *   POST /subagents/:id/archive|unarchive disable / enable (the lifecycle axis)
 *   POST /subagents/:id/run               run one task AS the persona (EXTERNAL → parks)
 *   POST /subagents/:id/message           one chat turn ON the persona's own session
 *   POST /subagents/:id/sessions          create a fresh session owned by the persona
 *   GET  /subagents/:id/sessions/:sid/turns  the persona's own recorded turns
 *   POST /approvals/:id/decide            approve/deny the parked run
 *   GET  /agents                           the workers KAI drives
 *   GET  /capabilities                     the capability catalogue to grant
 *
 * A 409 on `/run` or `/message` is NOT a failure: the run is EXTERNAL and parks
 * for a human. `*Parked` shapes below carry the approval id so the UI can decide
 * it and re-issue — the ONLY path by which a persona acts.
 */

/** Same default bind address Core uses; kept local so this module has no island import. */
export const AGENT_CORE_BASE_URL = "http://127.0.0.1:8788";

export interface AgentError {
  /** Transport category or Core's own machine code. */
  code: string;
  message: string;
  status?: number;
  /** Core's human `reason` from the error body, when present. */
  reason?: string;
}

export type AgentResult<T> = { ok: true; value: T } | { ok: false; error: AgentError };

// ── Wire types ────────────────────────────────────────────────────────────────

export interface SubagentVisual {
  declared?: Record<string, unknown>;
  resolved?: unknown;
}

/** One of KAI's personas, exactly as Core reports it. */
export interface Subagent {
  id: string;
  name: string;
  role: string;
  /** One-line description, when the persona declares one. */
  description?: string;
  /** Soul / personality text, redacted by Core. */
  soul: string;
  /** WHAT the agent is responsible for — persistent, carried into its runs. */
  objective?: string;
  /** HOW it behaves — user-editable system instructions, prompt material only. */
  instructions?: string;
  /** The worker this persona runs on — infrastructure beneath it. */
  workerId: string;
  model?: string;
  capabilities: string[];
  visual?: SubagentVisual;
  /** The workforce id it registers under (`kai:<id>`) — its memory scope. */
  employeeId: string;
  status: string;
  enabled: boolean;
  instanceId?: string;
  problems: string[];
  /** Real execution state derived by Core from a parked approval. */
  activity: string;
  currentTask: string | null;
  pendingApprovalId: string | null;
  createdAt: string;
}

export interface SubagentSession {
  id: string;
  title: string;
  status: string;
  updatedAt?: string;
  turnCount?: number;
  agentId?: string;
  agentSessionId?: string;
}

export interface SubagentDetail {
  subagent: Subagent;
  sessions: SubagentSession[];
}

export interface SessionTurn {
  id: string;
  role: string;
  text: string;
  at: string;
  agentId?: string;
}

/** The spec fields a create/edit/duplicate body may carry. */
export interface SubagentSpecInput {
  id: string;
  name: string;
  role: string;
  soul: string;
  workerId: string;
  description?: string;
  objective?: string;
  instructions?: string;
  model?: string;
  capabilities?: string[];
  visual?: SubagentVisual["declared"];
}

export interface WorkerRow {
  id: string;
  state: string;
  detail?: string;
}

export interface CapabilityRow {
  id: string;
  name: string;
  availability: string;
  risk: string;
  provider?: string;
  supportedActions: string[];
}

/** Outcome of a create/edit/duplicate — a park is possible but not the norm. */
export type CreateOutcome =
  | { kind: "created"; subagent: Subagent | null; action: string; duplicatedFrom?: string }
  | { kind: "parked"; approvalId: string; reason: string };

export type LifecycleOutcome =
  | { kind: "done"; subagent: Subagent | null; action: string }
  | { kind: "parked"; approvalId: string; reason: string };

/** Outcome of one chat turn on the persona's own session. */
export type MessageOutcome =
  | {
      kind: "reply";
      sessionId: string;
      reply: string;
      guarded: boolean;
      state: string;
      execution?: Record<string, unknown>;
    }
  | { kind: "parked"; sessionId: string; approvalId: string; reason: string };

// ── Defensive readers ─────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function bool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}
function strArr(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    const s = str(item);
    if (s !== undefined) out.push(s);
  }
  return out;
}

function parseVisual(raw: unknown): SubagentVisual | undefined {
  if (!isObj(raw)) return undefined;
  const out: SubagentVisual = {};
  if (isObj(raw.declared)) out.declared = raw.declared;
  if (raw.resolved !== undefined) out.resolved = raw.resolved;
  return out;
}

export function parseSubagent(raw: unknown): Subagent | null {
  if (!isObj(raw)) return null;
  const id = str(raw.id);
  const name = str(raw.name);
  const role = str(raw.role);
  const soul = str(raw.soul);
  const workerId = str(raw.workerId);
  const employeeId = str(raw.employeeId);
  const status = str(raw.status);
  const enabled = bool(raw.enabled);
  if (
    id === undefined || name === undefined || role === undefined || soul === undefined ||
    workerId === undefined || employeeId === undefined || status === undefined || enabled === undefined
  ) {
    return null;
  }
  const out: Subagent = {
    id, name, role, soul, workerId, employeeId, status, enabled,
    capabilities: strArr(raw.capabilities),
    problems: strArr(raw.problems),
    activity: str(raw.activity) ?? "idle",
    currentTask: str(raw.currentTask) ?? null,
    pendingApprovalId: str(raw.pendingApprovalId) ?? null,
    createdAt: str(raw.createdAt) ?? "",
  };
  const description = str(raw.description);
  if (description !== undefined) out.description = description;
  const objective = str(raw.objective);
  if (objective !== undefined) out.objective = objective;
  const instructions = str(raw.instructions);
  if (instructions !== undefined) out.instructions = instructions;
  const model = str(raw.model);
  if (model !== undefined) out.model = model;
  const instanceId = str(raw.instanceId);
  if (instanceId !== undefined) out.instanceId = instanceId;
  const visual = parseVisual(raw.visual);
  if (visual !== undefined) out.visual = visual;
  return out;
}

function parseSession(raw: unknown): SubagentSession | null {
  if (!isObj(raw)) return null;
  const id = str(raw.id);
  const title = str(raw.title);
  const status = str(raw.status);
  if (id === undefined || title === undefined || status === undefined) return null;
  const out: SubagentSession = { id, title, status };
  const updatedAt = str(raw.updatedAt);
  if (updatedAt !== undefined) out.updatedAt = updatedAt;
  const turnCount = num(raw.turnCount);
  if (turnCount !== undefined) out.turnCount = turnCount;
  const agentId = str(raw.agentId);
  if (agentId !== undefined) out.agentId = agentId;
  const agentSessionId = str(raw.agentSessionId);
  if (agentSessionId !== undefined) out.agentSessionId = agentSessionId;
  return out;
}

function parseTurn(raw: unknown): SessionTurn | null {
  if (!isObj(raw)) return null;
  const id = str(raw.id);
  const role = str(raw.role);
  const text = str(raw.text);
  const at = str(raw.at);
  if (id === undefined || role === undefined || text === undefined || at === undefined) return null;
  const out: SessionTurn = { id, role, text, at };
  const agentId = str(raw.agentId);
  if (agentId !== undefined) out.agentId = agentId;
  return out;
}

function parseRun(raw: unknown): SubagentRunRow | null {
  if (!isObj(raw)) return null;
  const runId = str(raw.runId);
  const subagentId = str(raw.subagentId);
  const employeeId = str(raw.employeeId);
  const startedAt = str(raw.startedAt);
  const status = str(raw.status);
  if (
    runId === undefined || subagentId === undefined || employeeId === undefined ||
    startedAt === undefined || (status !== "running" && status !== "parked")
  ) {
    return null;
  }
  const out: SubagentRunRow = { runId, subagentId, employeeId, startedAt, status };
  const approvalId = str(raw.approvalId);
  if (approvalId !== undefined) out.approvalId = approvalId;
  return out;
}

function parseWorker(raw: unknown): WorkerRow | null {
  if (!isObj(raw)) return null;
  const id = str(raw.id);
  const state = str(raw.state);
  if (id === undefined || state === undefined) return null;
  const out: WorkerRow = { id, state };
  const detail = str(raw.detail);
  if (detail !== undefined) out.detail = detail;
  return out;
}

function parseCapability(raw: unknown): CapabilityRow | null {
  if (!isObj(raw)) return null;
  const id = str(raw.id);
  const name = str(raw.name);
  if (id === undefined || name === undefined) return null;
  const out: CapabilityRow = {
    id, name,
    availability: str(raw.availability) ?? "UNKNOWN",
    risk: str(raw.risk) ?? "UNKNOWN",
    supportedActions: strArr(raw.supportedActions),
  };
  const provider = str(raw.provider);
  if (provider !== undefined) out.provider = provider;
  return out;
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

// ── The transport ─────────────────────────────────────────────────────────────

export interface AgentApiOptions {
  baseUrl?: string;
  /** Injected for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Default per-request timeout (ms). Worker chat/run override this. */
  timeoutMs?: number;
}

/** A raw response with the status and parsed body retained. */
interface RawResponse {
  ok: boolean;
  status: number;
  body: Obj | null;
  error?: AgentError;
}

export interface AgentApi {
  readonly baseUrl: string;
  listSubagents(): Promise<AgentResult<Subagent[]>>;
  getSubagent(id: string): Promise<AgentResult<SubagentDetail>>;
  createSubagent(spec: SubagentSpecInput): Promise<AgentResult<CreateOutcome>>;
  updateSubagent(id: string, spec: SubagentSpecInput): Promise<AgentResult<CreateOutcome>>;
  duplicateSubagent(id: string, next: { id: string; name?: string }): Promise<AgentResult<CreateOutcome>>;
  archiveSubagent(id: string): Promise<AgentResult<LifecycleOutcome>>;
  unarchiveSubagent(id: string): Promise<AgentResult<LifecycleOutcome>>;
  runSubagent(id: string, input: string, approvalId?: string): Promise<AgentResult<MessageOutcome>>;
  messageSubagent(
    id: string,
    input: { input: string; sessionId?: string; approvalId?: string },
  ): Promise<AgentResult<MessageOutcome>>;
  createSubagentSession(id: string, title?: string): Promise<AgentResult<SubagentSession>>;
  subagentSessionTurns(id: string, sessionId: string): Promise<AgentResult<SessionTurn[]>>;
  listWorkers(): Promise<AgentResult<WorkerRow[]>>;
  listCapabilities(): Promise<AgentResult<CapabilityRow[]>>;
  decideApproval(id: string, approved: boolean): Promise<AgentResult<void>>;
  /** `GET /subagents/runs` — the runs currently in flight (parked runs stay listed). */
  listSubagentRuns(): Promise<AgentResult<SubagentRunRow[]>>;
  /**
   * `POST /subagents/runs/:runId/cancel` — genuinely cancels a run parked on
   * an approval (its approval is rejected). An executing run has no
   * preemption point and is refused with the reason.
   */
  cancelSubagentRun(runId: string): Promise<AgentResult<{ runId: string }>>;
}

/** One tracked run, from `GET /subagents/runs`. */
export interface SubagentRunRow {
  runId: string;
  subagentId: string;
  employeeId: string;
  startedAt: string;
  status: "running" | "parked";
  approvalId?: string;
}

export function createAgentApi(options: AgentApiOptions = {}): AgentApi {
  const baseUrl = (options.baseUrl ?? AGENT_CORE_BASE_URL).replace(/\/+$/, "");
  const defaultTimeout = options.timeoutMs ?? 15_000;
  const injectedFetch = options.fetchImpl;

  function resolveFetch(): typeof fetch | undefined {
    if (typeof injectedFetch === "function") return injectedFetch;
    if (typeof fetch === "function") return fetch;
    return undefined;
  }

  function url(path: string, query?: Record<string, string | undefined>): string {
    let out = `${baseUrl}${path}`;
    if (query !== undefined) {
      const parts: string[] = [];
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
      }
      if (parts.length > 0) out += `?${parts.join("&")}`;
    }
    return out;
  }

  async function raw(
    path: string,
    init: { method?: string; body?: unknown; query?: Record<string, string | undefined>; timeoutMs?: number } = {},
  ): Promise<RawResponse> {
    const doFetch = resolveFetch();
    if (doFetch === undefined) {
      return { ok: false, status: 0, body: null, error: { code: "CORE_OFFLINE", message: "no fetch implementation available" } };
    }
    const controller = new AbortController();
    const timeout = init.timeoutMs ?? defaultTimeout;
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const requestInit: RequestInit = { method: init.method ?? "GET", signal: controller.signal };
      if (init.body !== undefined) {
        requestInit.body = JSON.stringify(init.body);
        requestInit.headers = { "content-type": "application/json" };
      }
      const res = await doFetch(url(path, init.query), requestInit);
      const text = await res.text().catch(() => "");
      let parsed: unknown;
      try {
        parsed = text === "" ? null : JSON.parse(text);
      } catch {
        parsed = null;
      }
      const body = isObj(parsed) ? parsed : null;
      if (!res.ok) {
        const status = typeof res.status === "number" ? res.status : 0;
        const reason = body !== null ? str(body.reason) : undefined;
        const code = body !== null ? str(body.code) : undefined;
        const message =
          status === 401 || status === 403
            ? "Core requires authentication"
            : reason !== undefined
              ? `Core request failed: ${reason}`
              : "Core request failed";
        return {
          ok: false,
          status,
          body,
          error: {
            code: code ?? (status === 401 || status === 403 ? "AUTH_REQUIRED" : "REQUEST_FAILED"),
            message,
            status,
            ...(reason !== undefined ? { reason } : {}),
          },
        };
      }
      return { ok: true, status: res.status, body };
    } catch (err) {
      const aborted = controller.signal.aborted || (isObj(err) && str((err as { name?: unknown }).name) === "AbortError");
      if (aborted) {
        return { ok: false, status: 0, body: null, error: { code: "TIMEOUT", message: `Core request timed out after ${timeout}ms` } };
      }
      if (err instanceof TypeError) {
        return { ok: false, status: 0, body: null, error: { code: "CORE_OFFLINE", message: "KAI Core is not reachable" } };
      }
      return { ok: false, status: 0, body: null, error: { code: "UNKNOWN", message: "KAI Core request failed" } };
    } finally {
      clearTimeout(timer);
    }
  }

  /** A 2xx whose body must be a JSON object; `null` body is an invalid response. */
  async function json<T>(
    path: string,
    init: Parameters<typeof raw>[1],
    parse: (body: Obj) => T | null,
    invalid: string,
  ): Promise<AgentResult<T>> {
    const res = await raw(path, init);
    if (!res.ok) return { ok: false, error: res.error ?? { code: "REQUEST_FAILED", message: "request failed" } };
    if (res.body === null) return { ok: false, error: { code: "INVALID_RESPONSE", message: invalid, status: res.status } };
    const parsed = parse(res.body);
    if (parsed === null) return { ok: false, error: { code: "INVALID_RESPONSE", message: invalid, status: res.status } };
    return { ok: true, value: parsed };
  }

  /** Turn a create/lifecycle response into `created` or a `parked` outcome. */
  function createOutcome(res: RawResponse): AgentResult<CreateOutcome> {
    if (res.ok) {
      const sub = res.body !== null ? parseSubagent(res.body.subagent) : null;
      const action = res.body !== null ? str(res.body.action) ?? "create" : "create";
      const dup = res.body !== null ? str(res.body.duplicatedFrom) : undefined;
      return { ok: true, value: { kind: "created", subagent: sub, action, ...(dup !== undefined ? { duplicatedFrom: dup } : {}) } };
    }
    // 409 is the EXTERNAL/park case: Core minted an approval and defined nothing.
    if (res.status === 409) {
      const approvalId = res.body !== null ? str(res.body.approvalId) : undefined;
      const reason = res.error?.reason ?? res.error?.message ?? "the change is waiting for your approval";
      if (approvalId !== undefined) return { ok: true, value: { kind: "parked", approvalId, reason } };
    }
    return { ok: false, error: res.error ?? { code: "REQUEST_FAILED", message: "request failed" } };
  }

  function lifecycleOutcome(res: RawResponse): AgentResult<LifecycleOutcome> {
    if (res.ok) {
      const sub = res.body !== null ? parseSubagent(res.body.subagent) : null;
      const action = res.body !== null ? str(res.body.action) ?? "done" : "done";
      return { ok: true, value: { kind: "done", subagent: sub, action } };
    }
    if (res.status === 409) {
      const approvalId = res.body !== null ? str(res.body.approvalId) : undefined;
      const reason = res.error?.reason ?? res.error?.message ?? "the change is waiting for your approval";
      if (approvalId !== undefined) return { ok: true, value: { kind: "parked", approvalId, reason } };
    }
    return { ok: false, error: res.error ?? { code: "REQUEST_FAILED", message: "request failed" } };
  }

  /** Turn a /run or /message response into a reply or a parked outcome. */
  function messageOutcome(res: RawResponse): AgentResult<MessageOutcome> {
    if (res.ok && res.body !== null) {
      const sessionId = str(res.body.sessionId);
      const reply = str(res.body.reply);
      if (sessionId !== undefined && reply !== undefined) {
        const out: MessageOutcome = {
          kind: "reply",
          sessionId,
          reply,
          guarded: res.body.guarded === true,
          state: str(res.body.state) ?? "unknown",
        };
        if (isObj(res.body.execution)) out.execution = res.body.execution;
        return { ok: true, value: out };
      }
      // A /run (task) returns the persona-authored `reply` alongside the raw
      // `result` (no persona session is involved).
      const subagentId = str(res.body.subagentId);
      if (subagentId !== undefined) {
        return {
          ok: true,
          value: {
            kind: "reply",
            sessionId: "",
            reply: reply ?? "",
            guarded: res.body.guarded === true,
            state: str(res.body.state) ?? "settled",
          },
        };
      }
      return { ok: false, error: { code: "INVALID_RESPONSE", message: "message response had no reply", status: res.status } };
    }
    if (res.status === 409) {
      const approvalId = res.body !== null ? str(res.body.approvalId) : undefined;
      const sessionId = res.body !== null ? str(res.body.sessionId) : undefined;
      const reason = res.error?.reason ?? res.error?.message ?? "this run is waiting for your approval";
      if (approvalId !== undefined && sessionId !== undefined) {
        return { ok: true, value: { kind: "parked", approvalId, sessionId, reason } };
      }
      // A non-park 409 (a real refusal) keeps Core's own reason.
      return { ok: false, error: res.error ?? { code: "REFUSED", message: reason, status: 409 } };
    }
    return { ok: false, error: res.error ?? { code: "REQUEST_FAILED", message: "request failed" } };
  }

  const api: AgentApi = {
    baseUrl,

    async listSubagents() {
      return json("/subagents", {}, (b) => parseArray(b.subagents, parseSubagent), "expected subagents");
    },

    async getSubagent(id) {
      return json(
        `/subagents/${encodeURIComponent(id)}`,
        {},
        (b) => {
          const sub = parseSubagent(b.subagent);
          if (sub === null) return null;
          return { subagent: sub, sessions: parseArray(b.sessions, parseSession) };
        },
        "subagent response was not a subagent",
      );
    },

    async createSubagent(spec) {
      const res = await raw("/subagents", { method: "POST", body: spec });
      return createOutcome(res);
    },

    async updateSubagent(id, spec) {
      const res = await raw(`/subagents/${encodeURIComponent(id)}`, { method: "POST", body: spec });
      return createOutcome(res);
    },

    async duplicateSubagent(id, next) {
      const body: Obj = { id: next.id };
      if (next.name !== undefined) body.name = next.name;
      const res = await raw(`/subagents/${encodeURIComponent(id)}/duplicate`, { method: "POST", body });
      return createOutcome(res);
    },

    async archiveSubagent(id) {
      const res = await raw(`/subagents/${encodeURIComponent(id)}/archive`, { method: "POST", body: {} });
      return lifecycleOutcome(res);
    },

    async unarchiveSubagent(id) {
      const res = await raw(`/subagents/${encodeURIComponent(id)}/unarchive`, { method: "POST", body: {} });
      return lifecycleOutcome(res);
    },

    // A persona run reaches a real worker: give it room, not the 15s default.
    async runSubagent(id, input, approvalId) {
      const body: Obj = { input };
      if (approvalId !== undefined) body.approvalId = approvalId;
      const res = await raw(`/subagents/${encodeURIComponent(id)}/run`, { method: "POST", body, timeoutMs: 180_000 });
      return messageOutcome(res);
    },

    async messageSubagent(id, input) {
      const body: Obj = { input: input.input };
      if (input.sessionId !== undefined) body.sessionId = input.sessionId;
      if (input.approvalId !== undefined) body.approvalId = input.approvalId;
      const res = await raw(`/subagents/${encodeURIComponent(id)}/message`, { method: "POST", body, timeoutMs: 180_000 });
      return messageOutcome(res);
    },

    async createSubagentSession(id, title) {
      const body: Obj = {};
      if (title !== undefined) body.title = title;
      return json(
        `/subagents/${encodeURIComponent(id)}/sessions`,
        { method: "POST", body },
        (b) => parseSession(b.session),
        "create-session response was not a session",
      );
    },

    async subagentSessionTurns(id, sessionId) {
      return json(
        `/subagents/${encodeURIComponent(id)}/sessions/${encodeURIComponent(sessionId)}/turns`,
        { query: { limit: "200" } },
        (b) => parseArray(b.turns, parseTurn),
        "expected turns",
      );
    },

    async listWorkers() {
      return json("/agents", {}, (b) => parseArray(b.agents, parseWorker), "expected agents");
    },

    async listCapabilities() {
      return json("/capabilities", {}, (b) => parseArray(b.capabilities, parseCapability), "expected capabilities");
    },

    async decideApproval(id, approved) {
      const res = await raw(`/approvals/${encodeURIComponent(id)}/decide`, { method: "POST", body: { approved } });
      if (!res.ok) return { ok: false, error: res.error ?? { code: "REQUEST_FAILED", message: "approval decide failed" } };
      return { ok: true, value: undefined };
    },

    async listSubagentRuns() {
      return json("/subagents/runs", {}, (b) => parseArray(b.runs, parseRun), "expected runs");
    },

    async cancelSubagentRun(runId) {
      const res = await raw(`/subagents/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST", body: {} });
      if (!res.ok) {
        const reason =
          typeof res.body?.reason === "string" && res.body.reason.length > 0
            ? res.body.reason
            : (res.error?.message ?? "cancel refused");
        return { ok: false, error: res.error ?? { code: "REFUSED", message: reason } };
      }
      const id = typeof res.body?.runId === "string" ? res.body.runId : runId;
      return { ok: true, value: { runId: id } };
    },
  };

  return api;
}
