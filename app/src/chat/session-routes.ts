// The governed session routes the base Core client (`core/kai-core.ts`) does
// not expose: search, and the DESTRUCTIVE delete/clear. They are registered by
// `core/src/sessions/routes.ts` (`registerSessionRoutes`, wired in server.ts)
// and every mutation goes through the ONE policy boundary — a destructive call
// may PARK for approval and answer `409 { approvalRequired, approvalId }`.
//
// This module deliberately lives beside `kai-core.ts` rather than widening it
// (the same reasoning as `workspace/routes.ts`): it shares the base URL and the
// same defensive transport contract, resolves to a typed result, and never
// rejects. Nothing here decides anything: a park is surfaced as a park, never
// faked into a success.

import { DEFAULT_CORE_BASE_URL, type CoreError, type CoreErrorCode, type CoreResult } from "../core/kai-core";

type JsonObject = Record<string, unknown>;

export interface SessionRoutesOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** A session search hit: where the query matched. */
export interface SessionSearchHit {
  id: string;
  title: string;
  status: string;
  /** "id" | "title" | "turn" — as Core reported. */
  match: string;
}

/** The outcome of a destructive session mutation. */
export type SessionMutation =
  | { kind: "done"; removed?: number }
  | { kind: "parked"; approvalRequired: true; approvalId?: string; reason?: string };

/** The outcome of a durable (WRITE) fork: the new session, or a park. */
export type SessionFork =
  | { kind: "done"; session: SessionViewLike }
  | { kind: "parked"; approvalRequired: true; approvalId?: string; reason?: string };

/** The subset of a Core session view the UI reads. */
export interface SessionViewLike {
  id?: string;
  title?: string;
  status?: string;
}

export interface SessionRoutes {
  readonly baseUrl: string;
  /** `GET /sessions/search?q=` — literal LIKE over ids, titles and turn text. */
  search(query: string, limit?: number): Promise<CoreResult<SessionSearchHit[]>>;
  /** `POST /sessions/:id/duplicate` — WRITE fork; may park for approval. */
  duplicate(id: string, opts?: { title?: string; approvalId?: string }): Promise<CoreResult<SessionFork>>;
  /** `POST /sessions/:id/delete` — DESTRUCTIVE, policy-gated; may park. */
  remove(id: string, approvalId?: string): Promise<CoreResult<SessionMutation>>;
  /** `POST /sessions/:id/clear` — DESTRUCTIVE (turns only); may park. */
  clear(id: string, approvalId?: string): Promise<CoreResult<SessionMutation>>;
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

function extractReason(bodyText: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (!isObject(parsed)) return undefined;
    return asString(parsed.reason) ?? asString(parsed.error);
  } catch {
    return undefined;
  }
}

async function readBodyText(res: Response): Promise<string> {
  try {
    return typeof res.text === "function" ? await res.text() : "";
  } catch {
    return "";
  }
}

export function createSessionRoutes(options: SessionRoutesOptions = {}): SessionRoutes {
  const baseUrl = (options.baseUrl ?? DEFAULT_CORE_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? 5000;
  const injectedFetch = options.fetchImpl;

  function resolveFetch(): typeof fetch | undefined {
    if (typeof injectedFetch === "function") return injectedFetch;
    if (typeof fetch === "function") return fetch;
    return undefined;
  }

  async function request(
    path: string,
    init: { method?: string; body?: unknown; query?: Record<string, string | number | undefined> } = {},
  ): Promise<CoreResult<JsonObject>> {
    const doFetch = resolveFetch();
    if (doFetch === undefined) return fail("CORE_OFFLINE", "no fetch implementation available");

    let url = `${baseUrl}${path}`;
    if (init.query !== undefined) {
      const parts: string[] = [];
      for (const [key, value] of Object.entries(init.query)) {
        if (value === undefined) continue;
        parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
      }
      if (parts.length > 0) url += `?${parts.join("&")}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const requestInit: RequestInit = { method: init.method ?? "GET", signal: controller.signal };
      if (init.body !== undefined) {
        requestInit.body = JSON.stringify(init.body);
        requestInit.headers = { "content-type": "application/json" };
      }
      const res = await doFetch(url, requestInit);
      const bodyText = await readBodyText(res);
      if (!res.ok) {
        const status = typeof res.status === "number" ? res.status : undefined;
        if (status === 401 || status === 403) return fail("AUTH_REQUIRED", "Core requires authentication", status);
        const reason = extractReason(bodyText);
        return fail(
          "REQUEST_FAILED",
          reason !== undefined ? `Core request failed: ${reason}` : "Core request failed",
          status,
          reason,
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        return fail("INVALID_RESPONSE", "response body was not JSON");
      }
      if (!isObject(parsed)) return fail("INVALID_RESPONSE", "response body was not a JSON object");
      return ok(parsed);
    } catch (err) {
      if (controller.signal.aborted || (err as { name?: unknown } | null)?.name === "AbortError") {
        return fail("TIMEOUT", `Core request timed out after ${timeoutMs}ms`);
      }
      if (err instanceof TypeError) return fail("CORE_OFFLINE", "Core is not reachable");
      return fail("UNKNOWN", err instanceof Error ? err.message.slice(0, 200) : "unknown error");
    } finally {
      clearTimeout(timer);
    }
  }

  /** A destructive call that Core answered with a park becomes a typed outcome. */
  function mutation(res: CoreResult<JsonObject>): CoreResult<SessionMutation> {
    if (res.ok) {
      const removed = asNumber(res.value.removed);
      return ok(removed !== undefined ? { kind: "done", removed } : { kind: "done" });
    }
    if (res.error.status === 409) {
      return ok({
        kind: "parked",
        approvalRequired: true,
        ...(res.error.reason !== undefined ? { reason: res.error.reason } : {}),
      });
    }
    return res;
  }

  /** A WRITE fork that Core answered with a park becomes a typed outcome. */
  function fork(res: CoreResult<JsonObject>): CoreResult<SessionFork> {
    if (res.ok) {
      const session = isObject(res.value.session) ? (res.value.session as SessionViewLike) : {};
      return ok({ kind: "done", session });
    }
    if (res.error.status === 409) {
      return ok({
        kind: "parked",
        approvalRequired: true,
        ...(res.error.reason !== undefined ? { reason: res.error.reason } : {}),
      });
    }
    return res;
  }

  return {
    baseUrl,

    async search(query, limit) {
      const res = await request("/sessions/search", { query: { query, limit } });
      if (!res.ok) return res;
      const raw = res.value.hits ?? res.value.results ?? res.value.sessions;
      if (!Array.isArray(raw)) return fail("INVALID_RESPONSE", "expected an array of search hits");
      const out: SessionSearchHit[] = [];
      for (const item of raw) {
        if (!isObject(item)) continue;
        // Core wraps each hit as `{ session, matched, turn? }`.
        const session = isObject(item.session) ? item.session : item;
        const id = asString(session.id);
        const title = asString(session.title);
        if (id === undefined || title === undefined) continue;
        out.push({
          id,
          title,
          status: asString(session.status) ?? "ACTIVE",
          match: asString(item.matched) ?? asString(item.match) ?? "title",
        });
      }
      return ok(out);
    },

    async duplicate(id, opts) {
      const body: JsonObject = {};
      if (opts?.title !== undefined) body.title = opts.title;
      if (opts?.approvalId !== undefined) body.approvalId = opts.approvalId;
      return fork(await request(`/sessions/${encodeURIComponent(id)}/duplicate`, { method: "POST", body }));
    },

    async remove(id, approvalId) {
      const body: JsonObject = {};
      if (approvalId !== undefined) body.approvalId = approvalId;
      return mutation(await request(`/sessions/${encodeURIComponent(id)}/delete`, { method: "POST", body }));
    },

    async clear(id, approvalId) {
      const body: JsonObject = {};
      if (approvalId !== undefined) body.approvalId = approvalId;
      return mutation(await request(`/sessions/${encodeURIComponent(id)}/clear`, { method: "POST", body }));
    },
  };
}
