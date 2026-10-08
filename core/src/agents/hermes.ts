// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * HermesClient — typed client for the Hermes Agent api-server.
 *
 * Every route below was read from the INSTALLED source
 * (`gateway/platforms/api_server.py`, method `_http_route_table`) and each one
 * named here was exercised live against http://127.0.0.1:8642 on 2026-10-01.
 *
 *   GET  /health                              (NO auth)  {"status":"ok","platform":"hermes-agent","version":...}
 *   GET  /v1/models                           {"object":"list","data":[{"id":"hermes-agent",...}]}
 *   GET  /v1/capabilities
 *   GET  /api/sessions                        {"object":"list","data":[{id,source,...,message_count,...}]}
 *   GET  /api/sessions/{session_id}
 *   GET  /api/sessions/{session_id}/messages
 *   POST /api/sessions                        body {} or {"title":...,"id":...}
 *   POST /api/sessions/{session_id}/chat      body {"message": <string|parts>}
 *
 * The key comes from env KAI_HERMES_KEY (fallback API_SERVER_KEY) and is never
 * logged, echoed, or written to disk by this client.
 */

import { AgentError } from "../errors.ts";
import type { HermesConfig } from "../config.ts";

export interface HermesHealth {
  status: string;
  platform: string;
  version: string | null;
  raw: unknown;
}

export interface HermesModel {
  id: string;
  [key: string]: unknown;
}

export interface HermesSession {
  id: string;
  [key: string]: unknown;
}

export interface HermesChatResult {
  object: string;
  session_id: string | null;
  message: { role?: string; content?: string } | null;
  usage: unknown;
  raw: unknown;
}

export interface HermesProbe {
  reachable: boolean;
  authorized: boolean;
  version: string | null;
  reason: string | null;
}

export interface HermesClientOptions {
  baseUrl?: string;
  apiKey?: string | undefined;
  timeoutMs?: number;
  /** Timeout for one chat turn; falls back to timeoutMs when not given. */
  chatTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Pulls the session object out of whatever shape Hermes answered with.
 *
 * Verified live: `POST /api/sessions` returns
 * `{"object":"hermes.session","session":{"id":"api_…", …}}` — the row is under
 * `session`, not at the top level and not under `data`. Reading only `data`
 * silently produced an empty id, which then made every chat turn fail upstream.
 */
function sessionFrom(json: unknown, fallbackId: string): HermesSession {
  const record = asRecord(json);
  const inner = asRecord(record["data"] ?? record["session"] ?? record);
  return { ...inner, id: asString(inner["id"]) ?? fallbackId } as HermesSession;
}

export class HermesClient {
  readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly chatTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HermesClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:8642").replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.chatTimeoutMs = options.chatTimeoutMs ?? this.timeoutMs;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  /** True when a bearer key is configured. Never exposes the value. */
  get hasCredentials(): boolean {
    return typeof this.apiKey === "string" && this.apiKey.length > 0;
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  private headers(authenticated: boolean): Record<string, string> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (authenticated && this.hasCredentials) {
      headers["authorization"] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  /** One JSON request. Any transport failure becomes a typed AgentError. */
  private async request(
    path: string,
    init: { method?: string; authenticated?: boolean; body?: unknown; timeoutMs?: number } = {},
  ): Promise<{ status: number; json: unknown; text: string }> {
    const url = this.url(path);
    const authenticated = init.authenticated ?? true;
    const headers = this.headers(authenticated);
    if (init.body !== undefined) headers["content-type"] = "application/json";

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: init.method ?? "GET",
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(init.timeoutMs ?? this.timeoutMs),
      });
    } catch (cause) {
      throw AgentError.unreachable(this.baseUrl, cause);
    }

    const text = await response.text().catch(() => "");
    if (response.status === 401 || response.status === 403) {
      // `sentCredentials` matters: a 401 with no header sent is a MISSING key, not a
      // rejected one, and the two read the same on the wire. Reporting the wrong one
      // sends the next reader after a credential that was never the problem.
      throw AgentError.unauthorized(this.baseUrl, text.slice(0, 500), this.hasCredentials);
    }
    if (!response.ok) {
      throw AgentError.http(this.baseUrl, response.status, text.slice(0, 500));
    }

    let json: unknown = null;
    if (text.length > 0) {
      try {
        json = JSON.parse(text) as unknown;
      } catch {
        throw AgentError.http(this.baseUrl, response.status, "response was not valid JSON");
      }
    }
    return { status: response.status, json, text };
  }

  /** GET /health — the only unauthenticated Hermes route. */
  async health(): Promise<HermesHealth> {
    const { json } = await this.request("/health", { authenticated: false });
    const record = asRecord(json);
    return {
      status: asString(record["status"]) ?? "unknown",
      platform: asString(record["platform"]) ?? "unknown",
      version: asString(record["version"]),
      raw: json,
    };
  }

  /** GET /v1/models */
  async models(): Promise<HermesModel[]> {
    const { json } = await this.request("/v1/models");
    return asArray(asRecord(json)["data"]).map((entry) => {
      const model = asRecord(entry);
      return { ...model, id: asString(model["id"]) ?? "" } as HermesModel;
    });
  }

  /** GET /v1/capabilities */
  async capabilities(): Promise<Record<string, unknown>> {
    const { json } = await this.request("/v1/capabilities");
    return asRecord(json);
  }

  /** GET /api/sessions */
  async listSessions(): Promise<HermesSession[]> {
    const { json } = await this.request("/api/sessions");
    return asArray(asRecord(json)["data"]).map((entry) => {
      const session = asRecord(entry);
      return { ...session, id: asString(session["id"]) ?? "" } as HermesSession;
    });
  }

  /** GET /api/sessions/{session_id} */
  async getSession(id: string): Promise<HermesSession> {
    const { json } = await this.request(`/api/sessions/${encodeURIComponent(id)}`);
    return sessionFrom(json, id);
  }

  /** GET /api/sessions/{session_id}/messages */
  async sessionMessages(id: string): Promise<unknown[]> {
    const { json } = await this.request(`/api/sessions/${encodeURIComponent(id)}/messages`);
    const record = asRecord(json);
    const data = record["data"];
    return Array.isArray(data) ? data : asArray(json);
  }

  /**
   * POST /api/sessions — create an empty session row.
   *
   * `title` must be unique across the install: Hermes answers
   * `400 invalid_title` ("Title already in use by session …") for a duplicate, so
   * a fixed title works exactly once and then fails forever.
   */
  async createSession(options: { title?: string; id?: string } = {}): Promise<HermesSession> {
    const body: Record<string, unknown> = {};
    if (options.title !== undefined) body["title"] = options.title;
    if (options.id !== undefined) body["id"] = options.id;
    const { json } = await this.request("/api/sessions", { method: "POST", body });
    return sessionFrom(json, "");
  }

  /**
   * POST /api/sessions/{session_id}/chat — one synchronous agent turn.
   * Body field is `message` (string); the upstream also accepts `input` or a
   * multimodal parts array. `text` keeps it to the verified simple form.
   */
  async sendChat(sessionId: string, text: string): Promise<HermesChatResult> {
    const { json } = await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/chat`, {
      method: "POST",
      body: { message: text },
      timeoutMs: this.chatTimeoutMs,
    });
    const record = asRecord(json);
    return {
      object: asString(record["object"]) ?? "",
      session_id: asString(record["session_id"]),
      message: (asRecord(record["message"]) as { role?: string; content?: string } | null) ?? null,
      usage: record["usage"] ?? null,
      raw: json,
    };
  }

  /**
   * Probe for the /health aggregate: reachability from GET /health,
   * then authorization from GET /v1/models. Never throws, never leaks the key.
   */
  async probe(): Promise<HermesProbe> {
    let version: string | null = null;
    try {
      const health = await this.health();
      version = health.version;
    } catch (error) {
      return {
        reachable: false,
        authorized: false,
        version: null,
        reason: error instanceof AgentError ? `upstream_${error.kind}` : "internal_error",
      };
    }
    try {
      await this.models();
      return { reachable: true, authorized: true, version, reason: null };
    } catch (error) {
      const reason = error instanceof AgentError ? `upstream_${error.kind}` : "internal_error";
      return { reachable: true, authorized: false, version, reason };
    }
  }
}
