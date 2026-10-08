// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The real, KAI-owned OpenAI-compatible model provider.
 *
 * This is a working inference client: it speaks the OpenAI chat-completions wire
 * protocol (`POST {baseUrl}/chat/completions`, `POST {baseUrl}/embeddings`,
 * `GET {baseUrl}/models`) over `fetch`, with no Hermes, no worker and no
 * delegation in the path. KAI Core calls THIS to generate its own normal replies.
 *
 * The external endpoint is a configuration detail; the client, its error typing
 * and its capabilities belong to KAI. The key is never logged, never returned and
 * never embedded in an error — it appears only in the `authorization` header.
 *
 * ── Endpoint-specific ROUTING headers (kept provider-agnostic) ────────────────
 * Some OpenAI-compatible gateways need a client-routing header before they will
 * answer a generation at all. opencode-go is one: without `x-opencode-session` a
 * `POST /chat/completions` is answered `400 MissingSessionID`, while `GET /models`
 * succeeds — so "reachable" can be true while every real turn fails.
 *
 * KAI therefore sends two extra headers when — and ONLY when — the configured base
 * URL is that gateway's host:
 *
 *   x-opencode-session: <KAI's own, STABLE session id>   (routing stays warm)
 *   user-agent:         opencode-ai/1.0
 *
 * Against any other OpenAI-compatible endpoint nothing is added, and a caller can
 * still supply arbitrary headers via `headers`/`sessionId`. The session id is
 * derived deterministically from this install (machine + user + platform), never
 * randomly per request, and is never logged.
 *
 * Streaming is implemented rather than simulated: the SSE frames the endpoint
 * emits are parsed incrementally and yielded as `StreamChunk`s. A stream that
 * ends without a `[DONE]` sentinel still terminates, but the terminal chunk is
 * marked so a caller can tell a clean finish from a truncated one.
 */

import { createHash } from "node:crypto";
import { hostname, userInfo } from "node:os";

import {
  ModelError,
  type ChatRequest,
  type ChatResult,
  type EmbeddingRequest,
  type EmbeddingResult,
  type ModelCapabilities,
  type ModelHealth,
  type ModelProvider,
  type StreamChunk,
  type StructuredRequest,
  type StructuredResult,
  type TokenUsage,
  type ToolCall,
} from "./types.ts";

/** The routing header the opencode-go gateway requires on a routed request. */
export const OPENCODE_SESSION_HEADER = "x-opencode-session";

/** The client identity opencode-go's own build sends. */
export const OPENCODE_USER_AGENT = "opencode-ai/1.0";

/**
 * True when `baseUrl` addresses the opencode-go gateway (`opencode.ai`, or any
 * subdomain of it). Only that host gets the routing headers, so pointing KAI at a
 * different OpenAI-compatible server is byte-for-byte unaffected.
 */
export function isOpencodeGateway(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "opencode.ai" || host.endsWith(".opencode.ai");
  } catch {
    // A base URL that will not parse is not this gateway; the request itself will
    // report the real failure.
    return false;
  }
}

function username(): string {
  try {
    return userInfo().username;
  } catch {
    return "unknown";
  }
}

/**
 * KAI's OWN routing/session id.
 *
 * STABLE for this install: the same value on every request and across restarts,
 * derived from the machine, the user and the platform rather than randomized —
 * which is what keeps the gateway's routing warm. It carries nothing secret and is
 * never written to a log. `seed` exists so a deployment (or a test) can pin it.
 */
export function kaiSessionId(seed?: string): string {
  const material =
    typeof seed === "string" && seed.trim().length > 0
      ? seed.trim()
      : [hostname(), username(), process.platform, process.arch].join("|");
  return `kai-${createHash("sha256").update(material).digest("hex").slice(0, 32)}`;
}

export interface OpenAICompatibleOptions {
  /** The provider id KAI records for provenance. */
  id: string;
  /** Base URL WITHOUT a trailing slash, e.g. `https://host/v1`. */
  baseUrl: string;
  /** Bearer credential. `undefined` = unconfigured; the provider reports it honestly. */
  apiKey?: string | undefined;
  /** Default model id. */
  model: string;
  /** Per-request timeout in ms (a chat turn takes seconds). */
  timeoutMs?: number;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /**
   * Extra headers sent on EVERY request. Applied last, so a caller can override
   * anything this client would otherwise set.
   */
  headers?: Record<string, string>;
  /**
   * Pin the gateway routing/session id. When omitted, a stable per-install id is
   * derived (see `kaiSessionId`) — never a random per-request value.
   */
  sessionId?: string;
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

/** Pull a token-usage block out of either OpenAI's snake_case or a camelCase body. */
function parseUsage(value: unknown): TokenUsage | undefined {
  const record = asRecord(value);
  const prompt = record["prompt_tokens"] ?? record["promptTokens"];
  const completion = record["completion_tokens"] ?? record["completionTokens"];
  const total = record["total_tokens"] ?? record["totalTokens"];
  if (prompt === undefined && completion === undefined && total === undefined) return undefined;
  const usage: TokenUsage = {};
  if (typeof prompt === "number") usage.promptTokens = prompt;
  if (typeof completion === "number") usage.completionTokens = completion;
  if (typeof total === "number") usage.totalTokens = total;
  return usage;
}

export function createOpenAICompatibleProvider(options: OpenAICompatibleOptions): ModelProvider {
  const id = options.id;
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const apiKey = options.apiKey;
  const defaultModel = options.model;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  const configured = typeof apiKey === "string" && apiKey.length > 0;

  /**
   * The routing headers for THIS endpoint, resolved once (not per request) so the
   * session id is stable for the life of the provider — and, being derived from the
   * install rather than a clock or a random, stable across a restart too.
   */
  const routingHeaders: Record<string, string> = isOpencodeGateway(baseUrl)
    ? {
        [OPENCODE_SESSION_HEADER]: kaiSessionId(options.sessionId),
        "user-agent": OPENCODE_USER_AGENT,
      }
    : {};
  const extraHeaders = options.headers ?? {};

  function headers(): Record<string, string> {
    const h: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
      ...routingHeaders,
    };
    if (configured) h["authorization"] = `Bearer ${apiKey}`;
    // Caller-supplied headers win, so an endpoint that needs something else is
    // never blocked by this client's own defaults.
    for (const [key, value] of Object.entries(extraHeaders)) h[key.toLowerCase()] = value;
    return h;
  }

  /** One JSON POST/GET. Transport failure -> typed ModelError; never leaks the key. */
  async function jsonRequest(
    path: string,
    init: { method?: string; body?: unknown; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<{ status: number; json: unknown; text: string }> {
    if (!configured) {
      throw new ModelError("unconfigured", `the "${id}" model provider has no API key configured`, {
        provider: id,
      });
    }
    const timeout = init.timeoutMs ?? timeoutMs;
    // Compose the caller's abort signal with our timeout so either can cancel.
    const signals: AbortSignal[] = [AbortSignal.timeout(timeout)];
    if (init.signal !== undefined) signals.push(init.signal);
    const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);

    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method: init.method ?? "GET",
        headers: headers(),
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal,
      });
    } catch (cause) {
      if (cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError")) {
        throw new ModelError("timeout", `the "${id}" model provider did not answer within ${timeout} ms`, {
          provider: id,
          cause,
        });
      }
      throw new ModelError("unreachable", `the "${id}" model provider is unreachable`, {
        provider: id,
        cause,
      });
    }

    const text = await response.text().catch(() => "");
    if (!response.ok) {
      throw new ModelError("http", `the "${id}" model provider answered HTTP ${response.status}`, {
        provider: id,
        status: response.status,
        detail: text.slice(0, 500),
      });
    }
    let json: unknown = null;
    if (text.length > 0) {
      try {
        json = JSON.parse(text) as unknown;
      } catch (cause) {
        throw new ModelError("bad_response", `the "${id}" model provider returned invalid JSON`, {
          provider: id,
          detail: text.slice(0, 200),
          cause,
        });
      }
    }
    return { status: response.status, json, text };
  }

  /**
   * Map KAI's chat messages onto the OpenAI wire shape. An assistant message
   * that requested tools carries `tool_calls`; a `tool` message carries the
   * `tool_call_id` of the call it answers. A message with neither is the plain
   * `{role, content}` every earlier caller already sent.
   */
  function bodyMessages(request: ChatRequest): Array<Record<string, unknown>> {
    return request.messages.map((m) => {
      const wire: Record<string, unknown> = { role: m.role, content: m.content };
      if (m.role === "assistant" && m.toolCalls !== undefined && m.toolCalls.length > 0) {
        wire["content"] = m.content.length > 0 ? m.content : null;
        wire["tool_calls"] = m.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        }));
      }
      if (m.role === "tool" && m.toolCallId !== undefined) wire["tool_call_id"] = m.toolCallId;
      return wire;
    });
  }

  /**
   * Read the `tool_calls` array off an assistant message. `arguments` is kept as
   * the raw string the endpoint sent (a provider may stream it in pieces, so the
   * joined value is what the model meant); a call with no id is dropped rather
   * than given a fabricated one, because the id is what binds a later result to
   * its request.
   */
  function parseToolCalls(message: Record<string, unknown>): ToolCall[] {
    const out: ToolCall[] = [];
    for (const entry of asArray(message["tool_calls"])) {
      const call = asRecord(entry);
      const fn = asRecord(call["function"]);
      const name = asString(fn["name"]);
      const id = asString(call["id"]);
      if (name === null || id === null) continue;
      out.push({ id, name, arguments: asString(fn["arguments"]) ?? "" });
    }
    return out;
  }

  /** The `tools`/`tool_choice` wire fields, present only when tools were offered. */
  function toolFields(request: ChatRequest): Record<string, unknown> {
    if (request.tools === undefined || request.tools.length === 0) return {};
    return {
      tools: request.tools,
      tool_choice: request.toolChoice ?? "auto",
    };
  }

  async function chat(request: ChatRequest): Promise<ChatResult> {
    const model = request.model ?? defaultModel;
    const body: Record<string, unknown> = {
      model,
      messages: bodyMessages(request),
      stream: false,
      ...toolFields(request),
    };
    if (request.temperature !== undefined) body["temperature"] = request.temperature;
    if (request.maxTokens !== undefined) body["max_tokens"] = request.maxTokens;

    const { json } = await jsonRequest("/chat/completions", {
      method: "POST",
      body,
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
      ...(request.maxTokens !== undefined ? { timeoutMs: timeoutMs } : {}),
    });
    const record = asRecord(json);
    const choice = asRecord(asArray(record["choices"])[0]);
    const message = asRecord(choice["message"]);
    let content = message["content"];
    // Some endpoints answer with a content PARTS array. Join the text parts.
    if (Array.isArray(content)) {
      content = content
        .map((part) => asString(asRecord(part)["text"]) ?? "")
        .join("");
    }
    const text = typeof content === "string" ? content : "";
    const toolCalls = parseToolCalls(message);
    if (
      text.length === 0 &&
      toolCalls.length === 0 &&
      asString(choice["finish_reason"]) === null &&
      record["error"] !== undefined
    ) {
      throw new ModelError("bad_response", `the "${id}" model provider returned an error`, {
        provider: id,
        detail: JSON.stringify(record["error"]).slice(0, 300),
      });
    }
    return {
      text,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      model: asString(record["model"]) ?? model,
      provider: id,
      finishReason: asString(choice["finish_reason"]),
      ...(parseUsage(record["usage"]) !== undefined ? { usage: parseUsage(record["usage"]) } : {}),
      raw: { purpose: request.purpose ?? null, id: record["id"] ?? null },
    };
  }

  async function* stream(request: ChatRequest): AsyncIterable<StreamChunk> {
    const model = request.model ?? defaultModel;
    const body: Record<string, unknown> = {
      model,
      messages: bodyMessages(request),
      stream: true,
      ...toolFields(request),
    };
    if (request.temperature !== undefined) body["temperature"] = request.temperature;
    if (request.maxTokens !== undefined) body["max_tokens"] = request.maxTokens;

    if (!configured) {
      throw new ModelError("unconfigured", `the "${id}" model provider has no API key configured`, {
        provider: id,
      });
    }
    const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
    if (request.signal !== undefined) signals.push(request.signal);
    const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);

    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(body),
        signal,
      });
    } catch (cause) {
      if (cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError")) {
        throw new ModelError("timeout", `the "${id}" model provider stream did not start in ${timeoutMs} ms`, {
          provider: id,
          cause,
        });
      }
      throw new ModelError("unreachable", `the "${id}" model provider is unreachable`, { provider: id, cause });
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new ModelError("http", `the "${id}" model provider answered HTTP ${response.status}`, {
        provider: id,
        status: response.status,
        detail: detail.slice(0, 300),
      });
    }
    if (response.body === null) {
      throw new ModelError("bad_response", `the "${id}" model provider returned no stream body`, { provider: id });
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sawDone = false;
    let usage: TokenUsage | undefined;
    let finishReason: string | null = null;
    // Tool calls arrive spread across frames, keyed by `index`; accumulate the
    // fragments so the terminal chunk carries whole calls, not pieces. Insertion
    // order is the first-seen order, which is how the provider numbered them.
    const toolAcc = new Map<number, { id: string; name: string; args: string }>();
    const ingestToolDeltas = (deltaRecord: Record<string, unknown>): void => {
      for (const entry of asArray(deltaRecord["tool_calls"])) {
        const call = asRecord(entry);
        const idx = typeof call["index"] === "number" ? (call["index"] as number) : 0;
        const current = toolAcc.get(idx) ?? { id: "", name: "", args: "" };
        const callId = asString(call["id"]);
        if (callId !== null && callId.length > 0) current.id = callId;
        const fn = asRecord(call["function"]);
        const name = asString(fn["name"]);
        if (name !== null && name.length > 0) current.name = name;
        const args = asString(fn["arguments"]);
        if (args !== null) current.args += args;
        toolAcc.set(idx, current);
      }
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE frames are separated by a blank line. Handle both \n\n and \r\n\r\n.
        for (;;) {
          const sep = /\r?\n\r?\n/.exec(buffer);
          if (sep === null) break;
          const frame = buffer.slice(0, sep.index);
          buffer = buffer.slice(sep.index + sep[0].length);
          for (const line of frame.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const payload = trimmed.slice(5).trim();
            if (payload === "[DONE]") {
              sawDone = true;
              continue;
            }
            let parsed: unknown;
            try {
              parsed = JSON.parse(payload) as unknown;
            } catch {
              continue;
            }
            const record = asRecord(parsed);
            const choice = asRecord(asArray(record["choices"])[0]);
            const deltaRecord = asRecord(choice["delta"]);
            const delta = asString(deltaRecord["content"]) ?? "";
            ingestToolDeltas(deltaRecord);
            const fr = asString(choice["finish_reason"]);
            if (fr !== null) finishReason = fr;
            const parsedUsage = parseUsage(record["usage"]);
            if (parsedUsage !== undefined) usage = parsedUsage;
            if (delta.length > 0) yield { delta, done: false };
          }
        }
      }
      // A terminal frame: some servers send the usage/finish_reason in a final
      // data line without a blank-line boundary.
      for (const line of buffer.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") {
          sawDone = true;
          continue;
        }
        try {
          const record = asRecord(JSON.parse(payload) as unknown);
          const choice = asRecord(asArray(record["choices"])[0]);
          const deltaRecord = asRecord(choice["delta"]);
          const delta = asString(deltaRecord["content"]) ?? "";
          ingestToolDeltas(deltaRecord);
          const fr = asString(choice["finish_reason"]);
          if (fr !== null) finishReason = fr;
          const parsedUsage = parseUsage(record["usage"]);
          if (parsedUsage !== undefined) usage = parsedUsage;
          if (delta.length > 0) yield { delta, done: false };
        } catch {
          /* an unparseable tail is dropped, not fatal */
        }
      }
    } finally {
      reader.releaseLock?.();
    }

    const toolCalls: ToolCall[] = [...toolAcc.values()]
      .filter((call) => call.name.length > 0)
      .map((call) => ({ id: call.id, name: call.name, arguments: call.args }));
    yield {
      delta: "",
      done: true,
      finishReason: finishReason ?? (sawDone ? "stop" : null),
      ...(usage !== undefined ? { usage } : {}),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
  }

  async function structured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const model = request.model ?? defaultModel;
    const body: Record<string, unknown> = {
      model,
      messages: bodyMessages(request),
      stream: false,
      response_format: {
        type: "json_schema",
        json_schema: { name: request.schemaName, schema: request.schema, strict: false },
      },
    };
    if (request.temperature !== undefined) body["temperature"] = request.temperature;
    if (request.maxTokens !== undefined) body["max_tokens"] = request.maxTokens;

    let result: ChatResult;
    try {
      const { json } = await jsonRequest("/chat/completions", {
        method: "POST",
        body,
        ...(request.signal !== undefined ? { signal: request.signal } : {}),
      });
      const record = asRecord(json);
      const choice = asRecord(asArray(record["choices"])[0]);
      const message = asRecord(choice["message"]);
      const text = asString(message["content"]) ?? "";
      result = {
        text,
        model: asString(record["model"]) ?? model,
        provider: id,
        finishReason: asString(choice["finish_reason"]),
        raw: { purpose: request.purpose ?? null },
      };
    } catch (error) {
      // A provider that does not implement `response_format` answers 400. Fall
      // back to a plain chat call, so structured output works against a plain
      // endpoint too — and parse strictly either way.
      if (!(error instanceof ModelError) || error.kind !== "http") throw error;
      result = await chat({ ...request, model });
    }
    return { value: request.parse(result.text), result };
  }

  async function embeddings(request: EmbeddingRequest): Promise<EmbeddingResult> {
    const model = request.model ?? defaultModel;
    const { json } = await jsonRequest("/embeddings", {
      method: "POST",
      body: { model, input: request.input },
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
    });
    const record = asRecord(json);
    const data = asArray(record["data"]).map((entry, index) => {
      const row = asRecord(entry);
      const vector = asArray(row["embedding"]).filter((n): n is number => typeof n === "number");
      return { index: typeof row["index"] === "number" ? (row["index"] as number) : index, vector };
    });
    data.sort((a, b) => a.index - b.index);
    return {
      vectors: data.map((d) => d.vector),
      model: asString(record["model"]) ?? model,
      provider: id,
      ...(parseUsage(record["usage"]) !== undefined ? { usage: parseUsage(record["usage"]) } : {}),
    };
  }

  /**
   * The endpoint's real model catalogue (`GET /models`), ids only. Empty when
   * unconfigured or unreachable — a missing list is reported, never invented.
   */
  async function listModels(): Promise<string[]> {
    if (!configured) return [];
    try {
      const { json } = await jsonRequest("/models", { timeoutMs: Math.min(timeoutMs, 10_000) });
      return asArray(asRecord(json)["data"])
        .map((entry) => asString(asRecord(entry)["id"]) ?? "")
        .filter((s) => s.length > 0);
    } catch {
      return [];
    }
  }

  async function health(): Promise<ModelHealth> {
    const base: ModelHealth = {
      ok: false,
      configured,
      provider: id,
      baseUrl,
      model: defaultModel,
      reason: null,
    };
    if (!configured) {
      return { ...base, reason: "no API key configured" };
    }
    const startedAt = Date.now();
    try {
      const { json } = await jsonRequest("/models", { timeoutMs: Math.min(timeoutMs, 10_000) });
      const models = asArray(asRecord(json)["data"])
        .map((entry) => asString(asRecord(entry)["id"]) ?? "")
        .filter((s) => s.length > 0);
      return { ...base, ok: true, latencyMs: Date.now() - startedAt, reason: null, ...(models.length > 0 ? {} : {}) };
    } catch (error) {
      const reason = error instanceof ModelError ? `${error.kind}` : "unknown";
      return { ...base, ok: false, reason, latencyMs: Date.now() - startedAt };
    }
  }

  return {
    id,
    model: defaultModel,
    chat,
    stream,
    structured,
    embeddings,
    health,
    listModels,
    capabilities(): ModelCapabilities {
      return {
        chat: configured,
        stream: configured,
        structured: configured,
        embeddings: configured,
        tools: configured,
        models: [],
        defaultModel,
      };
    },
  };
}
