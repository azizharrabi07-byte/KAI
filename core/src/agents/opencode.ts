// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * OpenCodeClient — typed client for the OpenCode headless server (v1.18.33).
 *
 * Body and query shapes are taken verbatim from the server's own OpenAPI 3.1.0
 * document ("opencode" 1.0.0, 162 paths), saved at
 * `kai/docs/evidence/opencode-openapi.json` and live at GET /doc on the server.
 * Every route used here was confirmed against that document.
 *
 * IMPORTANT (verified live 2026-10-01): there is NO `POST /session/{id}/prompt`
 * route. That path falls through to the web UI's SPA catch-all and returns
 * HTTP 200 with text/html. The real prompt route in the spec is
 * `POST /session/{sessionID}/message` (operationId `session.prompt`), which
 * answers a real `404 {"name":"NotFoundError"}` for an unknown session. This
 * client uses the spec route. `prompt()` below posts there.
 */

import { AgentError } from "../errors.ts";
import type { OpenCodeConfig } from "../config.ts";
import { parseSse } from "../lib/sse.ts";

export interface OpenCodeHealth {
  healthy: boolean;
  version: string | null;
  raw: unknown;
}

export interface OpenCodeSession {
  id: string;
  [key: string]: unknown;
}

export interface OpenCodePermissionRequest {
  id: string;
  [key: string]: unknown;
}

export interface OpenCodeQuestionRequest {
  id: string;
  [key: string]: unknown;
}

/** Accepted values for POST /permission/{requestID}/reply (from the OpenAPI enum). */
export const PERMISSION_REPLIES = ["once", "always", "reject"] as const;
export type PermissionReply = (typeof PERMISSION_REPLIES)[number];

/**
 * POST /question/{requestID}/reply body is `{answers: QuestionAnswer[]}` where
 * QuestionAnswer is `string[]` ("each answer is an array of selected labels").
 * So `answers` is `string[][]`. A flat `string[]` is accepted for convenience
 * and wrapped into a single answer.
 */
export type QuestionAnswer = string[];

/**
 * What each timeout governs, kept deliberately separate:
 *
 *   timeoutMs      CONTROL requests — health, session create/list, permission and
 *                  question reads, aborts. Short, because these are local API calls:
 *                  if one of them is slow the server is unwell, not busy.
 *   turnTimeoutMs  ONE WORKER TURN — POST /session/{id}/message, which does not return
 *                  until the model has finished. It is not a connection timeout and it
 *                  is not an inactivity timeout (the endpoint gives no progress signal);
 *                  it is the whole job. A real coding task legitimately runs for minutes,
 *                  so this is minutes.
 *
 * They used to be the same scalar, which made every real task longer than the control
 * timeout fail as if the server were down.
 */
export interface OpenCodeClientOptions {
  baseUrl?: string;
  password?: string | undefined;
  timeoutMs?: number;
  turnTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Control-plane requests. Unchanged from the original single scalar. */
export const DEFAULT_CONTROL_TIMEOUT_MS = 10_000;
/** One worker turn. Long enough for a real task, still bounded so a hung turn ends. */
export const DEFAULT_TURN_TIMEOUT_MS = 900_000;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export class OpenCodeClient {
  readonly baseUrl: string;
  private readonly password: string | undefined;
  private readonly timeoutMs: number;
  private readonly turnTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  /**
   * One controller for the client's lifetime, composed into every request alongside the
   * per-request timeout. Without it a hung turn would keep a request open after the Core
   * decided to shut down, because a timeout only fires when it expires — it cannot be
   * hurried. `abort()` makes shutdown immediate instead of up-to-15-minutes.
   */
  private readonly lifecycle = new AbortController();

  constructor(options: OpenCodeClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:4096").replace(/\/+$/, "");
    this.password = options.password;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS;
    this.turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  /** Aborts every in-flight request. Idempotent. Turns a shutdown into an error value. */
  abort(reason?: string): void {
    if (!this.lifecycle.signal.aborted) this.lifecycle.abort(reason ?? "client disposed");
  }

  get aborted(): boolean {
    return this.lifecycle.signal.aborted;
  }

  /** True when HTTP Basic auth will be sent. Never exposes the value. */
  get hasCredentials(): boolean {
    return typeof this.password === "string" && this.password.length > 0;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = { accept: "application/json", ...extra };
    if (this.hasCredentials) {
      const token = Buffer.from(`opencode:${this.password}`, "utf8").toString("base64");
      headers["authorization"] = `Basic ${token}`;
    }
    return headers;
  }

  /** Raw response fetch with typed transport errors. Caller owns the body. */
  async fetchRaw(
    path: string,
    init: {
      method?: string;
      body?: unknown;
      signal?: AbortSignal;
      accept?: string;
      /** Overrides the control timeout for THIS request only (see the timeout table). */
      timeoutMs?: number;
    } = {},
  ): Promise<Response> {
    const headers = this.headers(
      init.accept !== undefined ? { accept: init.accept } : {},
    );
    if (init.body !== undefined) headers["content-type"] = "application/json";

    const signals: AbortSignal[] = [
      AbortSignal.timeout(init.timeoutMs ?? this.timeoutMs),
      this.lifecycle.signal,
    ];
    if (init.signal) signals.push(init.signal);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: init.method ?? "GET",
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.any(signals),
      });
    } catch (cause) {
      throw AgentError.unreachable(this.baseUrl, cause);
    }
    if (response.status === 401 || response.status === 403) {
      const detail = await response.text().catch(() => "");
      throw AgentError.unauthorized(this.baseUrl, detail.slice(0, 500), this.hasCredentials);
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw AgentError.http(this.baseUrl, response.status, detail.slice(0, 500));
    }
    return response;
  }

  private async requestJson(
    path: string,
    init: { method?: string; body?: unknown; timeoutMs?: number } = {},
  ): Promise<unknown> {
    const response = await this.fetchRaw(path, init);
    const text = await response.text();
    if (text.length === 0) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw AgentError.http(this.baseUrl, response.status, "response was not valid JSON");
    }
  }

  /** GET /global/health -> {"healthy":true,"version":"1.18.33"} */
  async health(): Promise<OpenCodeHealth> {
    const json = await this.requestJson("/global/health");
    const record = asRecord(json);
    return {
      healthy: record["healthy"] === true,
      version: asString(record["version"]),
      raw: json,
    };
  }

  /** GET /session -> array of session objects, each with an `id`. */
  async listSessions(): Promise<OpenCodeSession[]> {
    const json = await this.requestJson("/session");
    return asArray(json).map((entry) => {
      const session = asRecord(entry);
      return { ...session, id: asString(session["id"]) ?? "" } as OpenCodeSession;
    });
  }

  /** POST /session — body per spec: {parentID?, title?, agent?, model?, metadata?, permission?, workspaceID?} */
  async createSession(
    body: { title?: string; agent?: string; parentID?: string } = {},
  ): Promise<OpenCodeSession> {
    const json = await this.requestJson("/session", { method: "POST", body });
    const session = asRecord(json);
    return { ...session, id: asString(session["id"]) ?? "" } as OpenCodeSession;
  }

  /**
   * POST /session/{sessionID}/message — send a prompt (spec operationId `session.prompt`).
   * Body per spec: {"parts":[{"type":"text","text":...}], "agent"?, "model"?, "noReply"?}.
   */
  async prompt(sessionId: string, text: string): Promise<unknown> {
    return this.requestJson(`/session/${encodeURIComponent(sessionId)}/message`, {
      method: "POST",
      body: { parts: [{ type: "text", text }] },
      // A turn, not a control call: this waits for the model to finish the whole job.
      timeoutMs: this.turnTimeoutMs,
    });
  }

  /** GET /session/{sessionID}/message — transcript array of {info, parts}. */
  async messages(sessionId: string): Promise<unknown[]> {
    const json = await this.requestJson(`/session/${encodeURIComponent(sessionId)}/message`);
    return asArray(json);
  }

  /** GET /permission -> array of pending PermissionRequest. */
  async listPermissions(): Promise<OpenCodePermissionRequest[]> {
    const json = await this.requestJson("/permission");
    return asArray(json).map((entry) => {
      const request = asRecord(entry);
      return { ...request, id: asString(request["id"]) ?? "" } as OpenCodePermissionRequest;
    });
  }

  /** POST /permission/{requestID}/reply — body {"reply":"once"|"always"|"reject", "message"?} */
  async replyPermission(
    requestId: string,
    reply: PermissionReply,
    message?: string,
  ): Promise<boolean> {
    if (!PERMISSION_REPLIES.includes(reply)) {
      throw new TypeError(`invalid permission reply: ${String(reply)}`);
    }
    const body: Record<string, unknown> = { reply };
    if (message !== undefined) body["message"] = message;
    const json = await this.requestJson(
      `/permission/${encodeURIComponent(requestId)}/reply`,
      { method: "POST", body },
    );
    return json === true;
  }

  /** GET /question -> array of pending QuestionRequest. */
  async listQuestions(): Promise<OpenCodeQuestionRequest[]> {
    const json = await this.requestJson("/question");
    return asArray(json).map((entry) => {
      const request = asRecord(entry);
      return { ...request, id: asString(request["id"]) ?? "" } as OpenCodeQuestionRequest;
    });
  }

  /**
   * POST /question/{requestID}/reply — body {"answers": string[][]}.
   * Accepts a flat string[] and wraps it, since a single question is the norm.
   */
  async replyQuestion(requestId: string, reply: string[] | string[][]): Promise<boolean> {
    const answers: QuestionAnswer[] = Array.isArray(reply) && reply.length > 0 && Array.isArray(reply[0])
      ? (reply as string[][])
      : ([reply as string[]]);
    const json = await this.requestJson(`/question/${encodeURIComponent(requestId)}/reply`, {
      method: "POST",
      body: { answers },
    });
    return json === true;
  }

  /**
   * Async iterable over the live SSE stream at GET /event.
   * Each yielded value is the parsed JSON payload of one `data:` line
   * (falling back to the raw string if it is not JSON).
   */
  async *events(signal?: AbortSignal): AsyncGenerator<unknown> {
    const response = await this.fetchRaw("/event", {
      accept: "text/event-stream",
      ...(signal ? { signal } : {}),
    });
    if (!response.body) {
      throw AgentError.http(this.baseUrl, response.status, "event stream had no body");
    }
    for await (const event of parseSse(response.body, signal)) {
      if (event.data.length === 0) continue;
      try {
        yield JSON.parse(event.data) as unknown;
      } catch {
        yield event.data;
      }
    }
  }
}
