/**
 * The canonical runtime event vocabulary — what a worker *does*, as distinct
 * from what the control plane *is*.
 *
 * ── Why this is a separate union from KaiEventType ──────────────────────────
 * `KaiEventType` (shared/contracts.ts) answers "what is the state of KAI?" —
 * core started, agent connected, mission completed, approval requested. It is
 * about the control plane, it is persisted selectively, and the UI renders it.
 *
 * This union answers a different question: "what is this worker doing right
 * now?" — a session began, a turn started, an item (a tool call, a reasoning
 * step, a chunk of assistant text) started/streamed/finished, the worker opened
 * a request that needs an answer, the turn ended. These are high-frequency and
 * mostly *not* worth persisting.
 *
 * Merging the two would produce a union whose members have nothing in common
 * and whose consumers each filter out most of it — the Phase 0 audit's finding
 * on OpenMausBot's 49-member union was that it is a deliberate subset for
 * exactly this reason. Keep them separate; bridge them deliberately (see
 * `toControlPlaneEvent` below) rather than by concatenation.
 *
 * ── Provenance ──────────────────────────────────────────────────────────────
 * The vocabulary and the four-layer shape (descriptor → instance → turn adapter
 * → canonical events) are adapted from `shared/runtime-events.ts` in
 * milind-soni/OpenMausBot (Apache-2.0, commit caba935) as the Phase 0 matrix
 * recommended. The names follow KAI's Phase 1 brief, not upstream's: upstream
 * calls the streaming member `content.delta`, the brief calls it `item.delta`.
 * Nothing was copied; the types are re-expressed against KAI's own ids and its
 * own control-plane event type.
 */

// ── Identifiers ───────────────────────────────────────────────────────────────

/** Which worker class produced this: "hermes", "opencode", "codex", "kai". */
export type EmployeeKind = string;
/** A concrete running instance of an employee. */
export type EmployeeInstanceId = string;
/** A conversation/session inside a worker. */
export type SessionId = string;
export type TurnId = string;
export type ItemId = string;
export type RequestId = string;

// ── Items ─────────────────────────────────────────────────────────────────────

/**
 * An item is one unit of work inside a turn. Tools and reasoning are *activity*;
 * assistant text and images are *output*. The distinction matters because
 * activity is what a supervisor watches and output is what a user reads.
 */
export type RuntimeItemKind = "tool" | "reasoning" | "assistant_text" | "assistant_image";

export interface RuntimeItemRef {
  itemId: ItemId;
  kind: RuntimeItemKind;
  /** Tool name, when `kind` is "tool". */
  name?: string;
}

// ── Requests (a worker asking a question) ─────────────────────────────────────

/**
 * A worker raising a request is not the same as KAI's own approval flow: this is
 * the worker asking *its* caller. KAI decides whether that becomes an approval
 * card (through its policy boundary) or is answered directly.
 */
export type RuntimeRequestKind = "permission" | "question";

export interface RuntimeRequestOption {
  id: string;
  label: string;
  description?: string;
}

// ── Base ──────────────────────────────────────────────────────────────────────

export interface RuntimeEventBase {
  /** Unique per event; the bus dedupes on it. */
  eventId: string;
  /** Which employee class emitted it. */
  employeeKind: EmployeeKind;
  /**
   * Which *instance* emitted it. Required, not optional: an event that cannot be
   * attributed to an instance cannot be validated against the subscription it
   * arrived on (see the bus's cross-provider check).
   */
  instanceId: EmployeeInstanceId;
  /** ISO-8601. */
  at: string;
  sessionId?: SessionId;
  turnId?: TurnId;
  itemId?: ItemId;
  requestId?: RequestId;
  /**
   * True when KAI synthesised this event rather than a worker reporting it —
   * e.g. a timeout KAI concluded, or a stream KAI closed on shutdown. Consumers
   * that need to distinguish "the worker said" from "KAI inferred" read this.
   */
  synthetic?: boolean;
  /** Unparsed provider payload, when a caller needs the original. Never sent to the UI. */
  raw?: unknown;
}

// ── The union ─────────────────────────────────────────────────────────────────

export type RuntimeEvent =
  | (RuntimeEventBase & {
      type: "session.started";
      /** The worker's own id for the session, when it has one. */
      sessionId: SessionId;
      model?: string;
      /** True when the worker resumed an existing session rather than creating one. */
      rebuilt?: boolean;
    })
  | (RuntimeEventBase & {
      type: "session.exited";
      sessionId: SessionId;
      code?: number;
      reason?: string;
    })
  | (RuntimeEventBase & {
      type: "session.error";
      sessionId?: SessionId;
      error: RuntimeErrorInfo;
    })
  | (RuntimeEventBase & {
      type: "turn.started";
      turnId: TurnId;
      model?: string;
    })
  | (RuntimeEventBase & {
      type: "item.started";
      turnId: TurnId;
      itemId: ItemId;
      itemKind: RuntimeItemKind;
      name?: string;
      /** Free-form input summary for a tool call. Redacted before it leaves the Core. */
      inputSummary?: string;
    })
  | (RuntimeEventBase & {
      type: "item.delta";
      turnId: TurnId;
      itemId: ItemId;
      itemKind: RuntimeItemKind;
      /** The incremental text. Never persisted. */
      text: string;
    })
  | (RuntimeEventBase & {
      type: "item.completed";
      turnId: TurnId;
      itemId: ItemId;
      itemKind: RuntimeItemKind;
      name?: string;
      ok: boolean;
      /** Bounded summary of the result, never the whole payload. */
      outputSummary?: string;
      /** Milliseconds the item took, when the worker reports it. */
      durationMs?: number;
    })
  | (RuntimeEventBase & {
      type: "request.opened";
      requestId: RequestId;
      requestKind: RuntimeRequestKind;
      /** What is being asked about: the tool name for a permission request. */
      subject?: string;
      summary: string;
      /** A command or path the request concerns, when there is one. */
      detail?: string;
      options?: RuntimeRequestOption[];
      /** True when the worker says this could be allowed for the rest of the session. */
      allowForSession?: boolean;
    })
  | (RuntimeEventBase & {
      type: "request.resolved";
      requestId: RequestId;
      /** Who answered: KAI's policy, a human, or the worker's own default. */
      resolvedBy: "policy" | "human" | "worker" | "timeout";
      optionId?: string;
      allowed: boolean;
      reason?: string;
    })
  | (RuntimeEventBase & {
      type: "turn.completed";
      turnId: TurnId;
      ok: boolean;
      /** Why it stopped, in the worker's own words ("end_turn", "max_tokens", …). */
      stopReason?: string;
      /** The turn's final text, when there is any. */
      text?: string;
      usage?: RuntimeUsage;
    })
  | (RuntimeEventBase & {
      type: "turn.failed";
      turnId?: TurnId;
      error: RuntimeErrorInfo;
    });

export type RuntimeEventType = RuntimeEvent["type"];

export interface RuntimeUsage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

/**
 * Failures are values, like KaiError — but this one describes a *worker's*
 * failure, which is not the same vocabulary as KAI's own error codes. A caller
 * maps it into a KaiError at the boundary.
 */
export interface RuntimeErrorInfo {
  /** A stable code when the worker gives one, else "UNKNOWN". */
  code: string;
  message: string;
  retryable: boolean;
}

export type RuntimeEventListener = (event: RuntimeEvent) => void;

// ── The turn protocol ─────────────────────────────────────────────────────────

/**
 * What a worker adapter must implement to stream a turn.
 *
 * This is deliberately NOT a replacement for `AgentAdapter` (contracts.ts): the
 * existing Hermes and OpenCode adapters keep working untouched, and one adapter
 * may implement both. `AgentAdapter` is the request/response shape KAI already
 * uses (runTask → poll → result); this is the streaming shape. A bridge adapter
 * implements this and forwards into the other.
 */
export interface TurnAdapter {
  readonly employeeKind: EmployeeKind;
  readonly instanceId: EmployeeInstanceId;

  /** Starts a turn and returns its id. Events arrive via `onEvent`. */
  sendTurn(input: SendTurnInput): Promise<{ turnId: TurnId; sessionId?: SessionId }>;
  /** Ask a running turn to stop. Resolves once the request is accepted, not once it stops. */
  interruptTurn(turnId: TurnId): Promise<void>;
  /** Answer a `request.opened`. */
  respondToRequest(requestId: RequestId, answer: RequestAnswer): Promise<void>;
  /** Does this adapter currently hold a session? */
  hasSession(): boolean;
  /** Stop everything this instance is running. Called on disable/shutdown. */
  stopAll(): Promise<void>;
  /** Subscribe to the canonical stream. Returns an unsubscribe function. */
  onEvent(listener: RuntimeEventListener): () => void;
}

export interface SendTurnInput {
  /** The user/system prompt for this turn. */
  prompt: string;
  /** Working directory for a worker that has one. */
  cwd?: string;
  /** Continue an existing session instead of starting one. */
  resumeSessionId?: SessionId;
  model?: string;
  /** Images, as data URLs or paths — the adapter decides what it can accept. */
  images?: readonly string[];
}

export interface RequestAnswer {
  allowed: boolean;
  optionId?: string;
  reason?: string;
  /** True when the answer should also cover later identical requests this session. */
  forSession?: boolean;
}

// ── Guards and helpers ────────────────────────────────────────────────────────

const RUNTIME_EVENT_TYPES: readonly string[] = [
  "session.started",
  "session.exited",
  "session.error",
  "turn.started",
  "item.started",
  "item.delta",
  "item.completed",
  "request.opened",
  "request.resolved",
  "turn.completed",
  "turn.failed",
];

export function isRuntimeEventType(value: unknown): value is RuntimeEventType {
  return typeof value === "string" && RUNTIME_EVENT_TYPES.includes(value);
}

/**
 * Shape guard for the IPC boundary: an event crossing a process boundary is
 * untrusted input, so this checks the fields the bus and the UI actually read.
 */
export function isRuntimeEvent(value: unknown): value is RuntimeEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.eventId === "string" &&
    e.eventId.length > 0 &&
    typeof e.employeeKind === "string" &&
    e.employeeKind.length > 0 &&
    typeof e.instanceId === "string" &&
    e.instanceId.length > 0 &&
    typeof e.at === "string" &&
    isRuntimeEventType(e.type)
  );
}

/**
 * Serialisation for the SSE wire and for tests. Deliberately explicit rather
 * than a bare JSON.stringify: `raw` can hold a provider object that is not
 * JSON-safe (a stream handle, a circular structure), and a serialiser that
 * throws at the edge is a worse failure than dropping the raw payload.
 */
export function serializeRuntimeEvent(event: RuntimeEvent): string {
  const { raw: _raw, ...rest } = event as RuntimeEvent & { raw?: unknown };
  return JSON.stringify(rest);
}

export function deserializeRuntimeEvent(json: string): RuntimeEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  return isRuntimeEvent(parsed) ? parsed : null;
}

/**
 * The deliberate bridge to the control plane.
 *
 * Only some runtime events are worth telling the UI about, and only as
 * control-plane events. Everything else stays in the runtime stream. This is the
 * one place the two vocabularies meet — so it is a function with a switch, not a
 * type union.
 */
export function toControlPlaneEvent(
  event: RuntimeEvent,
  source: string,
): { type: string; payload: Record<string, unknown>; source: string } | null {
  switch (event.type) {
    case "session.started":
      return { type: "agent.connected", payload: { sessionId: event.sessionId, model: event.model }, source };
    case "session.exited":
      return { type: "agent.disconnected", payload: { sessionId: event.sessionId, reason: event.reason }, source };
    case "session.error":
      return { type: "agent.error", payload: { code: event.error.code, message: event.error.message }, source };
    case "turn.failed":
      return { type: "agent.error", payload: { code: event.error.code, message: event.error.message }, source };
    case "request.opened":
      // A worker's permission request is only an approval card once KAI's own
      // policy has classified it — this says "a worker is asking", nothing more.
      return { type: "agent.output", payload: { requestId: event.requestId, summary: event.summary }, source };
    case "turn.completed":
      return { type: "agent.output", payload: { turnId: event.turnId, ok: event.ok }, source };
    default:
      // item.* and turn.started are streaming detail: the UI reads them from the
      // runtime stream, not from the persisted control-plane log.
      return null;
  }
}
