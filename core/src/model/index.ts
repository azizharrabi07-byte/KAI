// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * KAI's model/inference layer.
 *
 * Import the factory here. `createKaiModelProvider(settings)` returns the live,
 * KAI-owned provider the runtime talks to for every normal turn. Nothing in this
 * module knows about Hermes or any worker: it is the interface (types.ts), one
 * real OpenAI-compatible implementation (openai-compatible.ts), and the KAI-owned
 * credential resolver (config.ts).
 */

import { resolveModelSettings, type ModelSettings } from "./config.ts";
import { createOpenAICompatibleProvider } from "./openai-compatible.ts";
import type { ModelProvider } from "./types.ts";

export { resolveModelSettings, defaultKaiHome, MODEL_DEFAULTS, type ModelSettings } from "./config.ts";
export {
  createOpenAICompatibleProvider,
  isOpencodeGateway,
  kaiSessionId,
  OPENCODE_SESSION_HEADER,
  OPENCODE_USER_AGENT,
  type OpenAICompatibleOptions,
} from "./openai-compatible.ts";
export {
  ModelError,
  type ChatMessage,
  type ChatRequest,
  type ChatResult,
  type ChatRole,
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
  type ModelToolDeclaration,
} from "./types.ts";

/**
 * Build the KAI-owned provider from resolved settings. When `settings` is omitted
 * the KAI-owned resolver runs (env -> KAI_HOME file -> defaults), so a caller with
 * no explicit configuration still gets a real provider object that reports itself
 * unconfigured honestly rather than throwing.
 */
/**
 * Wrap a provider so KAI's persisted settings take effect LIVE, on every call,
 * with no restart. Each method re-resolves the provider from the current
 * settings row over the construction-time base (env/file/defaults fill the
 * rest, exactly as before), so a `POST /settings` that changes `model.name`
 * reaches KAI's very next turn. Construction stays cheap (one config resolve,
 * no I/O beyond the small credential file), and an empty settings row resolves
 * byte-identically to the unwrapped provider.
 */
export function createSettingsAwareProvider(deps: {
  base: Partial<ModelSettings>;
  overrides: () => Partial<ModelSettings>;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  kaiHome?: string;
  sessionId?: string;
  headers?: Record<string, string>;
}): ModelProvider {
  function current(): ModelProvider {
    return createKaiModelProvider(
      { ...deps.base, ...deps.overrides() },
      {
        ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
        ...(deps.env !== undefined ? { env: deps.env } : {}),
        ...(deps.kaiHome !== undefined ? { kaiHome: deps.kaiHome } : {}),
        ...(deps.sessionId !== undefined ? { sessionId: deps.sessionId } : {}),
        ...(deps.headers !== undefined ? { headers: deps.headers } : {}),
      },
    );
  }
  return {
    get id() {
      return current().id;
    },
    get model() {
      return current().model;
    },
    chat: (request) => current().chat(request),
    stream: (request) => current().stream(request),
    structured: (request) => current().structured(request),
    embeddings: (request) => current().embeddings(request),
    health: () => current().health(),
    capabilities: () => current().capabilities(),
    listModels: () => current().listModels?.() ?? Promise.resolve([]),
  };
}

export function createKaiModelProvider(
  settings?: Partial<ModelSettings>,
  options: {
    fetchImpl?: typeof fetch;
    env?: NodeJS.ProcessEnv;
    kaiHome?: string;
    /** Pin the gateway routing id; derived stably per install when omitted. */
    sessionId?: string;
    /** Extra headers for a non-opencode endpoint that needs its own. */
    headers?: Record<string, string>;
  } = {},
): ModelProvider {
  const resolved = resolveModelSettings(settings ?? {}, options.env ?? process.env, options.kaiHome);
  return createOpenAICompatibleProvider({
    id: resolved.id,
    baseUrl: resolved.baseUrl,
    apiKey: resolved.apiKey,
    model: resolved.name,
    timeoutMs: resolved.timeoutMs,
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
    ...(options.headers !== undefined ? { headers: options.headers } : {}),
  });
}
