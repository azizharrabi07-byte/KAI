/**
 * Front-end event-stream manager for KAI Core's Server-Sent-Events endpoint
 * (`GET /core/events`).
 *
 * Why this is not a bare `EventSource`: the native `EventSource` cannot send
 * custom headers and reconnects on its own with a fixed delay we cannot control
 * or observe. The island needs *bounded, observable* backoff and an honest
 * connection state, so the transport is implemented here over `fetch` with a
 * streaming reader. `EventSource` (or anything else) can be supplied instead via
 * `options.transport`, which is also how the tests run with no network and no
 * real timers.
 *
 * Conventions followed from `bridge.ts`:
 *   - typed, guarded, and it never throws into the UI: every callback is wrapped;
 *   - works identically in a plain browser (`npm run dev`) and the Tauri webview:
 *     no Tauri imports, no side effects or throws at import time.
 *
 * Wire format actually emitted by Core (verified against the running service):
 *
 *     : kai.core event stream connected
 *
 *     data: {"type":"stream.ready"}
 *
 * then one `data: <json>` frame per event, where the JSON is a `KaiEvent`:
 * `{id,type,timestamp,source,payload,missionId?,stepId?}`.
 *
 * ── Documented state semantics ───────────────────────────────────────────────
 *   CONNECTING  an attempt is in flight, OR a failed attempt is waiting to be
 *               retried. There is no state that means "waiting" other than this.
 *   ONLINE      a connection is live and frames are flowing. Set when the
 *               transport signals `onOpen`, and again (idempotently) on any
 *               real frame; `stream.ready` is proof of life only.
 *   OFFLINE     no connection and no retry pending. This manager reaches
 *               OFFLINE only via `disconnect()` (and before the first
 *               `connect()`). A failed attempt that has a retry scheduled stays
 *               CONNECTING — it is never OFFLINE and never ONLINE while merely
 *               waiting.
 *   DEGRADED    reserved for a future "connected but stale" signal; this manager
 *               never emits it. It exists in the type because the parent wires
 *               all four.
 *
 * Backoff: delays follow `backoffMs` (default [1000,2000,5000,10000,15000]);
 * once the end is reached the last value repeats. A *successful* connection
 * resets the schedule to the first delay, so a single blip does not strand the
 * client on the longest delay forever.
 */

/** Connection state of the Core event stream. */
export type CoreConnState = "CONNECTING" | "ONLINE" | "DEGRADED" | "OFFLINE";

/** A Core event as it arrives on the wire. Only `type` is guaranteed. */
export interface CoreEvent {
  id?: string;
  type: string;
  timestamp?: string;
  source?: string;
  payload?: unknown;
  missionId?: string;
  stepId?: string;
}

/**
 * A transport opens a stream and feeds frames back. It must:
 *   - call `onOpen()` once the connection is established (proof of life);
 *   - call `onFrame(block)` with each raw SSE frame block (blank-line separated);
 *   - resolve when the stream ends, reject on failure or abort;
 *   - honour `signal`: aborting it must stop reading (and reject is fine).
 */
export type CoreTransport = (
  signal: AbortSignal,
  onFrame: (frame: string) => void,
  onOpen: () => void,
) => Promise<void>;

export interface CoreEventStreamOptions {
  /** Default "http://127.0.0.1:8788". */
  baseUrl?: string;
  /** Injectable transport so tests need no network. Defaults to the fetch reader. */
  transport?: CoreTransport;
  /** Injectable timers so tests never really wait. Defaults to setTimeout/clearTimeout. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  onEvent?: (event: CoreEvent) => void;
  onState?: (state: CoreConnState) => void;
  /** Backoff schedule in ms. Last value repeats once exhausted. */
  backoffMs?: number[];
}

export interface CoreEventStream {
  connect(): void;
  disconnect(): void;
  reconnect(): void;
  readonly state: CoreConnState;
  /** Count of frames received, for diagnostics — not for decision making. */
  readonly received: number;
}

export const DEFAULT_BASE_URL: string =
  typeof window !== "undefined" && typeof (window as { __KAI_CORE_BASE_URL__?: unknown }).__KAI_CORE_BASE_URL__ === "string"
    ? ((window as { __KAI_CORE_BASE_URL__?: string }).__KAI_CORE_BASE_URL__ as string)
    : "http://127.0.0.1:8788";
export const DEFAULT_BACKOFF_MS = [1000, 2000, 5000, 10000, 15000];
const STREAM_PATH = "/core/events";

export interface ParsedFrame {
  comment?: string;
  data?: string;
  event?: string;
  id?: string;
}

/**
 * Parses one SSE frame block (the text between blank lines). Tolerates `\r\n`
 * and lone `\r`; joins multiple `data:` fields with newlines; treats a line
 * starting with `:` as a comment/keep-alive; ignores unknown fields (`retry`,
 * extensions).
 */
export function parseFrame(block: string): ParsedFrame {
  const out: ParsedFrame = {};
  const dataLines: string[] = [];
  const commentLines: string[] = [];

  for (const rawLine of block.split(/\r\n|\r|\n/)) {
    if (rawLine === "") continue;

    if (rawLine.startsWith(":")) {
      let value = rawLine.slice(1);
      if (value.startsWith(" ")) value = value.slice(1); // one optional space
      commentLines.push(value);
      continue;
    }

    const colon = rawLine.indexOf(":");
    let field: string;
    let value: string;
    if (colon === -1) {
      field = rawLine; // bare field name with empty value
      value = "";
    } else {
      field = rawLine.slice(0, colon);
      value = rawLine.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1); // one optional space
    }

    if (field === "data") dataLines.push(value);
    else if (field === "event") out.event = value;
    else if (field === "id") out.id = value;
    // `retry` and unrecognised fields are intentionally ignored.
  }

  if (dataLines.length > 0) out.data = dataLines.join("\n");
  if (commentLines.length > 0) out.comment = commentLines.join("\n");
  return out;
}

/**
 * Parses the JSON payload of a data frame. Returns `null` rather than throwing
 * for malformed JSON, or for JSON that is not a plain object carrying a string
 * `type` (`null`, `42`, `[]`, `{}` are all invalid).
 */
export function parseEvent(data: string): CoreEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.type !== "string" || obj.type === "") return null;

  return {
    id: typeof obj.id === "string" ? obj.id : undefined,
    type: obj.type,
    timestamp: typeof obj.timestamp === "string" ? obj.timestamp : undefined,
    source: typeof obj.source === "string" ? obj.source : undefined,
    payload: obj.payload,
    missionId: typeof obj.missionId === "string" ? obj.missionId : undefined,
    stepId: typeof obj.stepId === "string" ? obj.stepId : undefined,
  };
}

/** Default transport: `fetch` + a streaming `TextDecoder`, framed on blank lines. */
function createFetchTransport(baseUrl: string): CoreTransport {
  return async (signal, onFrame, onOpen) => {
    const response = await fetch(`${baseUrl}${STREAM_PATH}`, {
      method: "GET",
      headers: { Accept: "text/event-stream" },
      cache: "no-store",
      signal,
    });
    if (!response.ok) throw new Error(`core events: HTTP ${response.status}`);
    if (!response.body) throw new Error("core events: no response body");

    onOpen();

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // Split frames on a blank line. The separator may straddle chunks, so we
        // only ever search the accumulated buffer (a partial separator just
        // waits for the next chunk).
        let match = /\r?\n\r?\n/.exec(buffer);
        while (match) {
          const block = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);
          if (block.trim() !== "") onFrame(block);
          match = /\r?\n\r?\n/.exec(buffer);
        }
      }
      buffer += decoder.decode(); // flush any trailing bytes
      if (buffer.trim() !== "") onFrame(buffer);
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* the reader may already be released/errored; never throw into the UI */
      }
    }
  };
}

/** Creates one managed stream. Nothing runs until `connect()` is called. */
export function createCoreEventStream(
  options: CoreEventStreamOptions = {},
): CoreEventStream {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const schedule =
    options.backoffMs && options.backoffMs.length > 0
      ? options.backoffMs.slice()
      : DEFAULT_BACKOFF_MS.slice();
  const transport = options.transport ?? createFetchTransport(baseUrl);
  const setTimer =
    options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer =
    options.clearTimer ??
    ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let state: CoreConnState = "OFFLINE";
  let received = 0;
  let running = false;
  let retryIndex = 0;
  let retryTimer: unknown = null;
  let activeController: AbortController | null = null;

  function setState(next: CoreConnState): void {
    if (next === state) return; // transitions only, never the same value twice
    state = next;
    try {
      options.onState?.(next);
    } catch {
      /* a UI callback throwing must not tear down the stream */
    }
  }

  function emit(event: CoreEvent): void {
    try {
      options.onEvent?.(event);
    } catch {
      /* same: never let the consumer break the transport */
    }
  }

  function scheduleRetry(): void {
    if (!running || retryTimer !== null) return;
    const idx = Math.min(retryIndex, schedule.length - 1);
    const delay = schedule[idx];
    retryIndex += 1;
    // A retry is pending: this is CONNECTING, not OFFLINE, and never ONLINE.
    setState("CONNECTING");
    retryTimer = setTimer(() => {
      retryTimer = null;
      startAttempt();
    }, delay);
  }

  function startAttempt(): void {
    if (!running) return;
    if (activeController !== null) return; // never two live connections at once

    const controller = new AbortController();
    activeController = controller;
    // `isLive` ties a callback to *this* attempt: once the attempt is aborted,
    // superseded, or the manager stopped, late frames are ignored so they can
    // never flip state back to ONLINE.
    const isLive = (): boolean =>
      running && activeController === controller && !controller.signal.aborted;

    setState("CONNECTING");

    const onOpen = (): void => {
      if (!isLive()) return;
      retryIndex = 0; // a good connection resets the backoff schedule
      setState("ONLINE");
    };

    const onFrame = (block: string): void => {
      if (!isLive()) return;
      received += 1;

      const frame = parseFrame(block);
      if (frame.data === undefined) return; // comment / keep-alive: no event

      const event = parseEvent(frame.data);
      if (event === null) {
        // Counted as dropped and reported without the raw body.
        try {
          console.warn("[core-events] dropped malformed frame");
        } catch {
          /* console may be absent; irrelevant */
        }
        return;
      }

      setState("ONLINE"); // a real frame is proof of life
      if (event.type === "stream.ready") return; // control frame, not business
      emit(event);
    };

    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (activeController === controller) activeController = null;
      // Aborted (disconnect / superseded) or stopped: do NOT reschedule.
      if (!running || controller.signal.aborted) return;
      scheduleRetry();
    };

    Promise.resolve()
      .then(() => transport(controller.signal, onFrame, onOpen))
      .then(finish, finish);
  }

  function connect(): void {
    if (running) return; // already connecting/connected
    running = true;
    retryIndex = 0;
    startAttempt();
  }

  function disconnect(): void {
    running = false;
    if (retryTimer !== null) {
      clearTimer(retryTimer);
      retryTimer = null;
    }
    const controller = activeController;
    activeController = null;
    if (controller) controller.abort(); // abort the in-flight request
    setState("OFFLINE");
  }

  function reconnect(): void {
    // Abort/clear first so the old attempt can never coexist with the new one.
    disconnect();
    connect();
  }

  return {
    connect,
    disconnect,
    reconnect,
    get state(): CoreConnState {
      return state;
    },
    get received(): number {
      return received;
    },
  };
}
