// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * KAI's OWN model-provider abstraction.
 *
 * ── Why this module exists ────────────────────────────────────────────────────
 * Before this, KAI had no brain of its own. The only way KAI reached a model was
 * to hand a turn to a WORKER (Hermes/OpenCode) and relay the worker's reply. That
 * made Hermes KAI's conversation backend — KAI UI -> KAI Core -> Hermes -> model ->
 * Hermes -> KAI — which this module removes.
 *
 * The contract here is deliberately provider-agnostic: `ModelProvider` names WHAT
 * KAI needs from an inference backend (a chat turn, a stream, a structured value,
 * an embedding, a health reading, its capabilities) and nothing about WHO serves
 * it. The external provider is an implementation detail behind this interface; the
 * interface itself, and every call to it, belongs to KAI.
 *
 * `ModelProvider` is the ONLY thing the reasoning loop talks to for inference. A
 * worker is an optional execution engine ABOVE this, never a path THROUGH it.
 */

export type ChatRole = "system" | "user" | "assistant" | "tool";

/**
 * One function call the MODEL asked KAI to make, exactly as it came off the wire.
 *
 * `arguments` stays the raw JSON STRING the provider emitted (not a parsed
 * object): truncation, an empty string or malformed JSON must be observable at
 * the execution boundary and refused there, never silently coerced into `{}`.
 * The tool plane parses it, so a bad request is a refusal the model can see.
 */
export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON-encoded arguments, verbatim from the model. */
  arguments: string;
}

/**
 * One tool offered to the model, in the OpenAI function-tool shape. KAI derives
 * these from its OWN tool registry (see `tools/model-plane.ts`), so what the
 * model may choose is exactly what KAI can execute at its boundary.
 */
export interface ModelToolDeclaration {
  type: "function";
  function: {
    name: string;
    description: string;
    /** A JSON schema object. */
    parameters: unknown;
  };
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Optional tool-call id, when a message answers a tool call (`role: "tool"`). */
  toolCallId?: string;
  /** The calls this assistant message requested (informational for the caller). */
  toolCalls?: ToolCall[];
}

export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

/**
 * One inference request. `model`/`temperature`/`maxTokens` are PER-CALL overrides
 * of the provider's configured defaults, so a caller (a persona, a subagent) can
 * pick a different model without a second provider object.
 */
export interface ChatRequest {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /**
   * OpenAI-style function tools the model may choose from. Absent means the
   * provider sends none (a pure text turn), so existing callers are unaffected.
   */
  tools?: ModelToolDeclaration[];
  /** "auto" (default when tools are present) or "none". */
  toolChoice?: "auto" | "none";
  /**
   * KAI-owned provenance metadata. It is recorded in the result's `raw` for the
   * audit trail and is NEVER sent on the wire.
   */
  purpose?: string;
}

export interface ChatResult {
  text: string;
  /** The function calls the model requested this turn (empty when none). */
  toolCalls?: ToolCall[];
  /** The model that actually answered (the provider's, when not overridden). */
  model: string;
  /** The provider id behind this result, so a caller can name its origin. */
  provider: string;
  usage?: TokenUsage;
  finishReason?: string | null;
  raw?: unknown;
}

/** One incremental chunk of a streamed turn. `done` marks the terminal chunk. */
export interface StreamChunk {
  delta: string;
  done: boolean;
  /** Present only on the terminal chunk. */
  usage?: TokenUsage;
  finishReason?: string | null;
  /**
   * Present on the terminal chunk when the stream was a TOOL-CALL turn: the
   * fully-accumulated calls, in the order the provider emitted them. A pure
   * text stream carries none, so a caller can tell the two apart.
   */
  toolCalls?: ToolCall[];
  /**
   * A tool-lifecycle event for a tool-using turn (`tool_start`, `tool_done`,
   * `tool_error`, `tool_approval_required`), emitted by the brain as the
   * execution actually happens — never synthesised by the UI. A chunk carries
   * either text (`delta`) or one event, never both.
   */
  toolEvent?: ToolStreamEvent;
  /**
   * Present on the terminal chunk of a tool-using stream: the rounds taken,
   * the budget that applied, and whether the model still wanted tools when the
   * budget ran out.
   */
  toolIterations?: number;
  maxToolIterations?: number;
  toolBudgetExhausted?: boolean;
  /**
   * Present and true on the terminal chunk when the run's AbortSignal stopped
   * the turn: the text/tool record so far is what settled, and the caller must
   * report ABORTED — never completion — for this turn.
   */
  cancelled?: boolean;
  /**
   * Present on the terminal chunk when the brain's final-synthesis guard ran:
   * the closing text was produced by the tools-disabled final pass over the
   * turn's evidence, not by the last tool round.
   */
  synthesized?: boolean;
}

/**
 * One tool-lifecycle event, emitted from the actual runtime execution.
 * `result` is present on the server-side listener payload and OMITTED from the
 * streamed chunk (rendering reads status, not values, off the wire).
 */
export interface ToolStreamEvent {
  type: "tool_start" | "tool_done" | "tool_error" | "tool_approval_required";
  /** The model-side call id (`call_…`), so the UI can match request to outcome. */
  toolCallId: string;
  /** The sanitised function name the model selected. */
  toolName: string;
  /** The canonical registry id, once the name resolved (terminal events). */
  toolId?: string;
  /** The attempt identity the registry minted (empty while the call is refused pre-boundary). */
  invocationId: string;
  /** The raw JSON argument string the model sent (present from `tool_start` on). */
  arguments?: string;
  /** The registry status (EXECUTED | INVALID | DENIED | APPROVAL_REQUIRED | FAILED | NOT_FOUND). */
  status?: string;
  startedAt: string;
  /** Present once the attempt settled. */
  completedAt?: string;
  /** Why it refused or failed, on `tool_error` / `tool_approval_required`. */
  error?: { code: string; message: string };
  /** The approval that parked the call, on `tool_approval_required`. */
  approvalId?: string;
  /** The tool's value (or refusal value), server-side listener only. */
  result?: unknown;
  /**
   * Bounded, secret-redacted preview of `result`, safe to stream to the UI
   * (see `chat/result-preview.ts`). Present on terminal events when there is
   * something to show; the full value never leaves the Core on this frame.
   */
  resultPreview?: string;
  /** True when the real value continued past the preview budget. */
  resultTruncated?: boolean;
}

export interface StructuredRequest<T> extends ChatRequest {
  /** JSON-schema name, so a provider that supports structured output can use it. */
  schemaName: string;
  /** The JSON schema the value must satisfy. */
  schema: unknown;
  /** Parses + validates the model's text into `T`; throws on a malformed value. */
  parse: (text: string) => T;
}

export interface StructuredResult<T> {
  value: T;
  result: ChatResult;
}

export interface EmbeddingRequest {
  input: string[];
  model?: string;
  signal?: AbortSignal;
}

export interface EmbeddingResult {
  /** One vector per input, in input order. */
  vectors: number[][];
  model: string;
  provider: string;
  usage?: TokenUsage;
}

/** What this provider can actually do. Honest, not aspirational. */
export interface ModelCapabilities {
  chat: boolean;
  stream: boolean;
  structured: boolean;
  embeddings: boolean;
  /** Whether the provider accepts an OpenAI-style `tools` array. */
  tools: boolean;
  /** The model ids this provider advertises (may be empty when unconfigured). */
  models: string[];
  /** The provider's configured default model. */
  defaultModel: string;
}

/**
 * A live health reading. `configured` is about KAI's OWN configuration (is a
 * credential present?) and `ok` is about reachability — kept apart so a missing
 * key and a dead endpoint never read the same.
 */
export interface ModelHealth {
  ok: boolean;
  configured: boolean;
  provider: string;
  baseUrl: string;
  model: string;
  reason: string | null;
  latencyMs?: number;
}

export type ModelErrorKind =
  | "unconfigured"
  | "unreachable"
  | "http"
  | "bad_response"
  | "timeout";

/**
 * A typed provider failure. It carries the provider id, the kind and (for an HTTP
 * failure) the status — never the API key, which is never embedded anywhere.
 */
export class ModelError extends Error {
  readonly kind: ModelErrorKind;
  readonly provider: string;
  readonly status?: number;
  readonly detail?: string;

  constructor(
    kind: ModelErrorKind,
    message: string,
    options: { provider: string; status?: number; detail?: string; cause?: unknown } ,
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "ModelError";
    this.kind = kind;
    this.provider = options.provider;
    if (options.status !== undefined) this.status = options.status;
    if (options.detail !== undefined) this.detail = options.detail;
  }
}

/**
 * THE KAI-OWNED INTERFACE. Implementations live behind it (an OpenAI-compatible
 * endpoint today); the reasoning loop depends only on this shape.
 */
export interface ModelProvider {
  readonly id: string;
  /** The configured default model for this provider. */
  readonly model: string;
  chat(request: ChatRequest): Promise<ChatResult>;
  stream(request: ChatRequest): AsyncIterable<StreamChunk>;
  structured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>>;
  embeddings(request: EmbeddingRequest): Promise<EmbeddingResult>;
  health(): Promise<ModelHealth>;
  capabilities(): ModelCapabilities;
  /**
   * The endpoint's real model catalogue, when the implementation can ask for
   * one. Optional so test doubles keep compiling; absent means "unknown".
   */
  listModels?(): Promise<string[]>;
}
