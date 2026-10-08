// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The REAL computer-use transport: MCP over stdio to the installed
 * `cua-driver`, satisfying the same `ComputerTransport` seam as the fake, so
 * nothing above it (session, control, observation, API) changes.
 *
 * ── What was DISCOVERED on this machine (2026-10-02), and how ────────────────
 * Driver: `cua-driver` 0.28.2 at
 *   C:\Users\DELL\AppData\Local\Programs\Cua\cua-driver\bin\cua-driver.exe
 *
 * Evidence, command by command — none of this is guessed:
 *
 *   1. `cua-driver --help`
 *      → subcommands include `mcp`, `list-tools`, `manifest`, `status`.
 *   2. `cua-driver manifest --pretty`
 *      → `mcp_invocation: { command: <exe>, args: ["mcp"] }` — the canonical way
 *        a host is told how to launch the MCP server, instead of hardcoding argv.
 *        We use exactly that.
 *   3. `cua-driver status`
 *      → "Cua Driver daemon is running / socket: \\.\pipe\cua-driver / pid: ...".
 *        THAT is how the named pipe is determined. On Windows the daemon's local
 *        endpoint is a NAMED PIPE — `\\.\pipe\cua-driver` — not a unix socket.
 *        We re-probe that pipe with `node:net` (see `probeNamedPipe`).
 *   4. A raw stdio probe (spawn `cua-driver mcp`, send `initialize` →
 *      `notifications/initialized` → `tools/list`) showed:
 *        - initialize result.serverInfo = { name: "cua-driver", version: "0.28.2" }
 *          and result.protocolVersion = "2025-06-18".
 *        - tools/list returned 57 tools. Note the driver answers MCP `ping` with
 *          -32601 in old versions; `transport.ts` already documents that, so we
 *          NEVER forward ping — health is a real TOOL call instead.
 *   5. `tools/call list_windows {}` returns BOTH a human text blob AND
 *      `structuredContent.windows[]` with fields
 *      `{ window_id, pid, title, app_name, bounds:{x,y,width,height},
 *         is_on_screen, minimized, layer, z_index }`.
 *      (`structuredContent._legacy_windows[]` is a flatter fallback.)
 *   6. `tools/call get_screen_size {}` → `{ width, height, scale_factor }`.
 *   7. `tools/call get_desktop_state {}` → content[0] is `image/png` base64 plus
 *      `structuredContent.screenshot_width/screenshot_height`.
 *   8. `tools/call get_cursor_position {}` → `{ x, y }`.
 *   9. `tools/call health_report {}` → `structuredContent.checks[]` of
 *      `{ name, status, message }` — a genuine end-to-end diagnostic.
 *
 * ── Control / lease state: deliberately NOT here ─────────────────────────────
 * The driver exposes no "who is driving / lease" tool. Who drives the machine is
 * KAI policy, owned by `control.ts` (ControlLedger) and enforced by `session.ts`.
 * The transport stays policy-free exactly as SEAM.md requires; mapping a driver
 * tool onto a lease would be inventing a protocol the driver does not have.
 *
 * ── Error discipline ─────────────────────────────────────────────────────────
 * Every method returns `TransportResult<T>` — errors are KaiError VALUES, never
 * thrown. Timeouts resolve to `AGENT_TIMEOUT`; a dead/absent driver to
 * `AGENT_NOT_LISTENING`; a malformed MCP reply to `AGENT_BAD_RESPONSE`; a
 * refused version/tool surface to `AGENT_CAPABILITY_MISSING`; a tool that ran
 * and failed to `AGENT_RUN_FAILED`.
 */

import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { StringDecoder } from "node:string_decoder";

import { kaiError } from "./errors.ts";
import { hashFrame } from "./observation.ts";
import {
  MINIMUM_DRIVER_VERSION,
  REAL_DRIVER_SEAM,
  compareDriverVersions,
  isSupportedDriverVersion,
  parseDriverVersion,
  type ActionOutcome,
  type ClickTarget,
  type ComputerTransport,
  type ConnectInfo,
  type Frame,
  type Inspection,
  type ObserveOptions,
  type ScrollTarget,
  type TransportAction,
  type TransportEndpoint,
  type TransportResult,
  type WindowInfo,
} from "./transport.ts";
import type { KaiError } from "../../shared/contracts.ts";

// ── Line-granular framing ─────────────────────────────────────────────────────

/**
 * Collects bytes into complete newline-terminated lines.
 *
 * WHY a decoder AND a buffer: MCP's stdio transport is one JSON-RPC frame per
 * line, so a line boundary is the only safe place to parse. A `data` event is an
 * arbitrary chunk — a frame may arrive split across two reads, several frames
 * may arrive in one read, and a multi-byte UTF-8 character may straddle a chunk
 * boundary. `StringDecoder` holds a partial code point; the tail buffer holds a
 * partial line. Parsing anything but a complete line would corrupt a frame, so
 * the framer is the one place that decides where a frame ends.
 *
 * This mirrors the near-side line splitter in upstream's mcp-bridge.ts
 * (read-only design evidence); the implementation here is KAI's and is unit
 * tested by splitting a frame at every byte boundary.
 */
export class JsonLineFramer {
  private pending = "";
  private readonly decoder = new StringDecoder("utf8");

  /** Feed one chunk; return every COMPLETE line it completed (0..n). */
  push(chunk: Buffer | string): string[] {
    this.pending += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    const lines: string[] = [];
    let newline: number;
    while ((newline = this.pending.indexOf("\n")) !== -1) {
      const raw = this.pending.slice(0, newline);
      this.pending = this.pending.slice(newline + 1);
      // Tolerate CRLF; a bare trailing CR is not a frame.
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (line.trim().length > 0) lines.push(line);
    }
    return lines;
  }

  /** Flush the decoder at end-of-stream and emit any unterminated trailing line. */
  flush(): string[] {
    this.pending += this.decoder.end();
    const rest = this.pending;
    this.pending = "";
    const trimmed = rest.endsWith("\r") ? rest.slice(0, -1) : rest;
    return trimmed.trim().length > 0 ? [trimmed] : [];
  }
}

// ── Named-pipe probe (node:net) ───────────────────────────────────────────────

export interface PipeProbeResult {
  reachable: boolean;
  detail?: string;
}

/**
 * Probe the Windows daemon NAMED PIPE with node:net. A resolved `connect` means
 * the pipe exists and something is listening; any error (ENOENT = no such pipe,
 * ECONNREFUSED, timeout) means it does not. We destroy the socket immediately —
 * this is a liveness read, not a session.
 *
 * The default pipe (`\\.\pipe\cua-driver`) was read from `cua-driver status`
 * (see the file header). Separate from the stdio transport: the `mcp` process
 * we spawn owns the direct runtime on Windows, while the daemon pipe is the
 * endpoint `status` reports — health checks both and reports each honestly.
 */
export function probeNamedPipe(pipe: string, timeoutMs = 1_500): Promise<PipeProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = connect(pipe);
    const finish = (result: PipeProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ reachable: false, detail: `probe timed out after ${timeoutMs}ms` }), timeoutMs);
    timer.unref?.();
    socket.once("connect", () => finish({ reachable: true }));
    socket.once("error", (error: NodeJS.ErrnoException) =>
      finish({ reachable: false, detail: error.code ? `${error.code}: ${error.message}` : error.message }),
    );
  });
}

// ── Options and extra surface ─────────────────────────────────────────────────

export type RealSpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface RealTransportOptions {
  /** Absolute path to the driver. Default: the discovered install path. */
  command?: string;
  /** Launch argv. Default: `["mcp"]`, as printed by `cua-driver manifest`. */
  args?: readonly string[];
  /**
   * Windows daemon named pipe, e.g. `\\.\pipe\cua-driver`. Defaults to the
   * discovered pipe ONLY when `command` is also left at its default (a test
   * pointing at a fake server must not inherit a real-machine pipe probe).
   * Pass `undefined` AND a custom command to opt out entirely.
   */
  daemonPipe?: string;
  /** Treat an unreachable daemon pipe as UNAVAILABLE (default true when a pipe is set). */
  requireDaemonPipe?: boolean;
  /** Per-request timeout for normal tool calls. */
  requestTimeoutMs?: number;
  /** Timeout for the initialize / tools-list handshake. */
  connectTimeoutMs?: number;
  /** Timeout for a single daemon-pipe liveness probe. */
  pipeTimeoutMs?: number;
  /** Longer timeout for a full-screen capture, which is the slow call. */
  observeTimeoutMs?: number;
  /** Extra environment merged over process.env (used by tests to fake a driver). */
  env?: NodeJS.ProcessEnv;
  /** Test seam: replace `spawn` entirely. */
  spawnFn?: RealSpawnFn;
  now?: () => number;
}

export interface DriverHealthCheck {
  name: string;
  status: string;
  message: string;
}

export interface DaemonPipeHealth {
  path: string;
  reachable: boolean;
  detail?: string;
}

/** Honest health: a REAL probe, and an explicit state, never a bare ok flag. */
export interface RealHealthOutcome {
  ok: boolean;
  state: "available" | "unavailable";
  endpoint: TransportEndpoint;
  version?: string;
  supported?: boolean;
  latencyMs?: number;
  daemonPipe?: DaemonPipeHealth;
  checks?: readonly DriverHealthCheck[];
  /** The reason when `state === "unavailable"`. */
  error?: KaiError;
}

export interface RealComputerTransport extends ComputerTransport {
  /** Real end-to-end probe: daemon pipe + MCP handshake + `health_report`. */
  health(): Promise<RealHealthOutcome>;
  /** Kill the driver process tree and release everything. Idempotent. */
  dispose(): Promise<void>;
  /** Alias of dispose(), for callers that spell cleanup `close`. */
  close(): Promise<void>;
  /** OS pid of the spawned MCP process, or null before connect / after dispose. */
  readonly pid: number | null;
  /** True once the handshake has completed and the child is still alive. */
  readonly connected: boolean;
  /** Bounded tail of the child's stderr, for diagnostics. */
  stderrTail(): string;
}

/** Tools our mapping depends on; `connect` refuses a driver that lacks them. */
const REQUIRED_TOOLS = [
  "list_windows",
  "get_screen_size",
  "get_cursor_position",
  "get_desktop_state",
  "click",
  "type_text",
  "press_key",
  "hotkey",
  "scroll",
] as const;

/** The MCP protocol revision this server answers with (seen in `initialize`). */
const MCP_PROTOCOL_VERSION = "2025-06-18";

// ── Small helpers (typed access to untyped JSON) ──────────────────────────────

interface McpContent {
  type?: string;
  text?: string;
  data?: string;
  mimeType?: string;
}
interface McpToolResult {
  content?: McpContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}
interface McpResponse {
  id?: number | string | null;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function firstText(content: readonly McpContent[] | undefined): string | undefined {
  if (!content) return undefined;
  for (const part of content) if (part.type === "text" && typeof part.text === "string") return part.text;
  return undefined;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

// ── The transport ─────────────────────────────────────────────────────────────

export function createRealComputerTransport(options: RealTransportOptions = {}): RealComputerTransport {
  const usingDefaultCommand = options.command === undefined;
  const command = options.command ?? REAL_DRIVER_SEAM.executable;
  const args = [...(options.args ?? ["mcp"])];
  // Only inherit the discovered pipe for the discovered driver; a test that
  // names its own command must not probe the real machine's daemon.
  const configuredPipe = options.daemonPipe ?? (usingDefaultCommand && process.platform === "win32" ? REAL_DRIVER_SEAM.windowsPipe : undefined);
  const daemonPipe: string | undefined = configuredPipe && configuredPipe.length > 0 ? configuredPipe : undefined;
  const requireDaemonPipe = options.requireDaemonPipe ?? true;
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  const connectTimeoutMs = options.connectTimeoutMs ?? 20_000;
  const pipeTimeoutMs = options.pipeTimeoutMs ?? 1_500;
  const observeTimeoutMs = options.observeTimeoutMs ?? 45_000;
  const now = options.now ?? (() => Date.now());
  // Spawn through a seam so a test can substitute a process; the telemetry /
  // update-check flags keep the driver from making network calls behind our back.
  const spawnFn: RealSpawnFn = options.spawnFn ?? ((cmd, argv, opts) => spawn(cmd, argv, opts));
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    CUA_DRIVER_RS_UPDATE_CHECK: "false",
    CUA_DRIVER_RS_TELEMETRY_ENABLED: "false",
    ...options.env,
  };

  const endpoint: TransportEndpoint = { kind: "mcp-stdio", command, args, daemonPipe };

  let child: ChildProcess | null = null;
  let framer: JsonLineFramer | null = null;
  let connectedInfo: ConnectInfo | null = null;
  let connecting: Promise<TransportResult<ConnectInfo>> | null = null;
  let dead: KaiError | null = null;
  let disposed = false;
  let exited = false;
  /**
   * Whether the driver's implicit lifecycle session has been started on THIS
   * connection. The driver refuses a tool call whose session has ended with
   * "this session has ended; call start_session explicitly to reuse its label",
   * so a transport that never calls `start_session` works once and then fails
   * for the rest of the process's life. Reset on every (re)spawn and on any
   * session-ended error, so a revived driver is re-armed.
   */
  let sessionReady = false;
  let stderrBuffer = "";
  let nextId = 1;
  const pending = new Map<number, { resolve: (value: TransportResult<McpResponse>) => void; timer: NodeJS.Timeout }>();

  function rememberStderr(chunk: Buffer | string): void {
    stderrBuffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    // Bound it; a chatty driver must not grow memory without limit.
    if (stderrBuffer.length > 4_000) stderrBuffer = stderrBuffer.slice(-4_000);
  }

  /** Resolve every in-flight request with the same failure. Never leaves a hang. */
  function failAllPending(error: KaiError): void {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.resolve({ ok: false, error });
      pending.delete(id);
    }
  }

  function onLine(line: string): void {
    let message: McpResponse;
    try {
      message = JSON.parse(line) as McpResponse;
    } catch {
      // Not a frame we can use; keep a sample for diagnostics and move on. A
      // malformed line must never wedge the stream — the next line still parses.
      rememberStderr(`[unparseable frame] ${line.slice(0, 200)}`);
      return;
    }
    const id = typeof message.id === "number" ? message.id : typeof message.id === "string" && /^\d+$/.test(message.id) ? Number(message.id) : null;
    if (id === null) return; // server notification / response to nothing we sent
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    if (message.error) {
      entry.resolve({
        ok: false,
        error: kaiError("AGENT_BAD_RESPONSE", `cua-driver returned a JSON-RPC error (${message.error.code ?? "?"}): ${message.error.message ?? "unknown"}`, {
          detail: JSON.stringify(message.error).slice(0, 500),
        }),
      });
      return;
    }
    entry.resolve({ ok: true, value: message });
  }

  function spawnDriver(): TransportResult<void> {
    let spawned: ChildProcess;
    try {
      spawned = spawnFn(command, args, { stdio: ["pipe", "pipe", "pipe"], env: childEnv, windowsHide: true });
    } catch (cause) {
      return { ok: false, error: kaiError("AGENT_NOT_LISTENING", `could not spawn cua-driver (${command}): ${errorMessage(cause)}`) };
    }
    child = spawned;
    exited = false;
    dead = null;
    sessionReady = false;
    framer = new JsonLineFramer();

    spawned.stdout?.on("data", (chunk: Buffer) => {
      // Line granularity: a chunk boundary is never a frame boundary.
      for (const line of framer?.push(chunk) ?? []) onLine(line);
    });
    spawned.stdout?.on("end", () => {
      for (const line of framer?.flush() ?? []) onLine(line);
    });
    spawned.stderr?.on("data", (chunk: Buffer) => rememberStderr(chunk));
    // A child that dies before reading our write must not raise an unhandled
    // EPIPE; the exit handler below reports the failure through the pending map.
    spawned.stdin?.on("error", () => {});

    spawned.on("error", (cause) => {
      exited = true;
      connectedInfo = null;
      sessionReady = false;
      dead = kaiError("AGENT_NOT_LISTENING", `could not start cua-driver (${command}): ${errorMessage(cause)}`);
      failAllPending(dead);
    });
    spawned.on("exit", (code, signal) => {
      exited = true;
      connectedInfo = null;
      sessionReady = false;
      if (!disposed) {
        dead = kaiError("AGENT_NOT_LISTENING", `cua-driver exited (${code === null ? `signal ${signal ?? "unknown"}` : `code ${code}`})`, {
          detail: stderrBuffer.slice(-500),
        });
        failAllPending(dead);
      }
    });
    return { ok: true, value: undefined };
  }

  /** Send a JSON-RPC notification (no id, no reply expected). */
  function sendNotification(method: string, params?: unknown): void {
    const stdin = child?.stdin;
    if (!stdin || stdin.destroyed) return;
    try {
      stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    } catch {
      // Best-effort: a failed notification surfaces through the next request.
    }
  }

  /** Send one JSON-RPC request and await its reply, with a hard timeout. */
  function request(method: string, params: unknown, timeoutMs: number): Promise<TransportResult<McpResponse>> {
    if (disposed) return Promise.resolve({ ok: false, error: kaiError("AGENT_NOT_LISTENING", "cua-driver transport was disposed") });
    if (dead) return Promise.resolve({ ok: false, error: dead });
    const stdin = child?.stdin;
    if (!child || !stdin || stdin.destroyed) {
      return Promise.resolve({ ok: false, error: kaiError("AGENT_NOT_LISTENING", "cua-driver is not running") });
    }
    const id = nextId++;
    return new Promise<TransportResult<McpResponse>>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({
          ok: false,
          error: kaiError("AGENT_TIMEOUT", `cua-driver did not answer ${method} within ${timeoutMs}ms`, {
            retryable: true,
            detail: `jsonrpc id ${id}`,
          }),
        });
      }, timeoutMs);
      // Do not let a pending timer keep the Node process alive after the caller
      // has moved on; the request itself still resolves when the timer fires.
      timer.unref?.();
      pending.set(id, { resolve, timer });
      try {
        stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      } catch (cause) {
        clearTimeout(timer);
        pending.delete(id);
        resolve({ ok: false, error: kaiError("AGENT_NOT_LISTENING", `failed to write ${method} to cua-driver: ${errorMessage(cause)}`) });
      }
    });
  }

  /**
   * The version gate. Refuses (as a VALUE) a driver older than
   * MINIMUM_DRIVER_VERSION, naming both versions. Reuses the shared comparator
   * so the floor lives in exactly one place. AGENT_CAPABILITY_MISSING is the
   * closest existing code: a driver below the floor is a driver whose tool
   * surface we cannot vouch for. (`AGENT_NOT_LISTENING` would lie — it answered.)
   */
  function checkVersion(raw: string): TransportResult<string> {
    const found = parseDriverVersion(raw);
    const minimum = parseDriverVersion(MINIMUM_DRIVER_VERSION);
    if (!found || !minimum) {
      return {
        ok: false,
        error: kaiError("AGENT_CAPABILITY_MISSING", `cua-driver reported an unreadable version "${raw}"; required at least ${MINIMUM_DRIVER_VERSION}`, {
          detail: "driver_version_unreadable",
        }),
      };
    }
    if (compareDriverVersions(found, minimum) < 0) {
      return {
        ok: false,
        error: kaiError("AGENT_CAPABILITY_MISSING", `cua-driver ${raw} is below the required minimum ${MINIMUM_DRIVER_VERSION}`, {
          detail: `driver_version_mismatch: found=${raw} minimum=${MINIMUM_DRIVER_VERSION}`,
        }),
      };
    }
    return { ok: true, value: raw };
  }

  function extractToolNames(result: unknown): string[] {
    if (!isRecord(result) || !Array.isArray(result.tools)) return [];
    const names: string[] = [];
    for (const tool of result.tools) if (isRecord(tool) && typeof tool.name === "string") names.push(tool.name);
    return names;
  }

  /** Spawn + initialize + initialized + tools/list + version/tool gates. */
  async function performConnect(): Promise<TransportResult<ConnectInfo>> {
    // Fail fast with a readable reason when the binary is plainly absent; do not
    // wait for an asynchronous spawn error to round-trip.
    if (options.spawnFn === undefined && !existsSync(command)) {
      return { ok: false, error: kaiError("AGENT_NOT_LISTENING", `cua-driver executable not found at ${command}`, { detail: "driver_absent" }) };
    }
    const spawned = spawnDriver();
    if (!spawned.ok) return spawned;

    const init = await request(
      "initialize",
      { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "kai-core", version: "0.1.0" } },
      connectTimeoutMs,
    );
    if (!init.ok) {
      await hardKill();
      return init;
    }
    const initResult = isRecord(init.value.result) ? init.value.result : undefined;
    const serverInfo = initResult && isRecord(initResult.serverInfo) ? initResult.serverInfo : undefined;
    const version = serverInfo && typeof serverInfo.version === "string" ? serverInfo.version : undefined;
    if (!version) {
      await hardKill();
      return { ok: false, error: kaiError("AGENT_BAD_RESPONSE", "cua-driver initialize response did not carry serverInfo.version") };
    }

    const gate = checkVersion(version);
    if (!gate.ok) {
      await hardKill();
      return gate;
    }

    sendNotification("notifications/initialized");

    const tools = await request("tools/list", {}, connectTimeoutMs);
    if (!tools.ok) {
      await hardKill();
      return tools;
    }
    const names = extractToolNames(tools.value.result);
    const missing = REQUIRED_TOOLS.filter((tool) => !names.includes(tool));
    if (missing.length > 0) {
      await hardKill();
      return {
        ok: false,
        error: kaiError("AGENT_CAPABILITY_MISSING", `cua-driver ${version} does not advertise the required tool(s): ${missing.join(", ")}`, {
          detail: `advertised=${names.join(",")}`,
        }),
      };
    }

    endpoint.version = version;
    const info: ConnectInfo = { version, endpoint, capabilities: names };
    connectedInfo = info;
    return { ok: true, value: info };
  }

  function ensureConnected(): Promise<TransportResult<ConnectInfo>> {
    if (disposed) return Promise.resolve({ ok: false, error: kaiError("AGENT_NOT_LISTENING", "cua-driver transport was disposed") });
    if (connectedInfo && child && !exited) return Promise.resolve({ ok: true, value: connectedInfo });
    // Coalesce concurrent connects so a burst of lazily-triggered calls spawns
    // exactly one driver.
    if (!connecting) {
      connecting = performConnect().finally(() => {
        connecting = null;
      });
    }
    return connecting;
  }

  /**
   * Call one MCP tool; translate JSON-RPC and tool-level errors to values.
   */
  async function callTool(name: string, toolArgs: Record<string, unknown>, timeoutMs = requestTimeoutMs): Promise<TransportResult<McpToolResult>> {
    const ready = await ensureConnected();
    if (!ready.ok) return ready;
    return callToolConnected(name, toolArgs, timeoutMs, true);
  }

  /**
   * Start the driver's implicit lifecycle session, once per connection.
   *
   * The driver requires a live session for its screen/input tools and refuses
   * with `isError` ("this session has ended; call start_session explicitly to
   * reuse its label") once it has ended — which it does on its own schedule.
   * A transport that never starts one therefore works exactly once. This is
   * best-effort and idempotent: the driver may already have an implicit session,
   * and a driver that does not answer has its failure reported by the call that
   * follows rather than here.
   */
  async function ensureSession(): Promise<void> {
    if (sessionReady) return;
    const started = await request("tools/call", { name: "start_session", arguments: {} }, connectTimeoutMs);
    if (started.ok) sessionReady = true;
  }

  /** True when a driver tool error means the session the call needed has ended. */
  function isSessionEnded(message: string): boolean {
    return /session has ended|start_session|no active session|session .* not (found|active)/i.test(message);
  }

  async function callToolConnected(
    name: string,
    toolArgs: Record<string, unknown>,
    timeoutMs: number,
    allowSessionRetry: boolean,
  ): Promise<TransportResult<McpToolResult>> {
    await ensureSession();
    const response = await request("tools/call", { name, arguments: toolArgs }, timeoutMs);
    if (!response.ok) return response;
    const result = response.value.result;
    if (!isRecord(result)) {
      return { ok: false, error: kaiError("AGENT_BAD_RESPONSE", `cua-driver returned no result object for tool ${name}`) };
    }
    const typed = result as McpToolResult;
    if (typed.isError) {
      const text = firstText(typed.content) ?? "no message";
      // A session that ended mid-life is recoverable, and only once: re-arm the
      // session and replay the SAME call. Anything else is the driver's verdict
      // and is reported as-is.
      if (allowSessionRetry && isSessionEnded(text)) {
        sessionReady = false;
        await ensureSession();
        if (sessionReady) return callToolConnected(name, toolArgs, timeoutMs, false);
      }
      return { ok: false, error: kaiError("AGENT_RUN_FAILED", `cua-driver tool ${name} failed: ${text}`, { detail: text }) };
    }
    return { ok: true, value: typed };
  }

  // ── Window parsing ──────────────────────────────────────────────────────────

  function parseWindows(result: McpToolResult): WindowInfo[] {
    const structured = result.structuredContent ?? {};
    const rich = Array.isArray(structured.windows) ? structured.windows.filter(isRecord) : [];
    const legacy = Array.isArray(structured._legacy_windows) ? structured._legacy_windows.filter(isRecord) : [];
    const entries = rich.length > 0 ? rich : legacy;

    // The driver does not report a `focused` flag. Derive it honestly: among
    // on-screen, non-minimized windows on the normal layer (layer 0), the one
    // with the highest z-index is the frontmost. Documented as a heuristic, not
    // a driver fact.
    const frontmost = entries
      .filter((entry) => entry.is_on_screen !== false && entry.minimized !== true && (entry.layer === undefined || entry.layer === 0))
      .reduce<Record<string, unknown> | null>((best, entry) => {
        const z = asNumber(entry.z_index, Number.NEGATIVE_INFINITY);
        const bestZ = best ? asNumber(best.z_index, Number.NEGATIVE_INFINITY) : Number.NEGATIVE_INFINITY;
        return z > bestZ ? entry : best;
      }, null);
    const frontmostId = frontmost?.window_id;

    const windows: WindowInfo[] = [];
    for (const entry of entries) {
      const bounds = isRecord(entry.bounds) ? entry.bounds : entry;
      const info: WindowInfo = {
        id: String(entry.window_id ?? entry.pid ?? windows.length),
        title: typeof entry.title === "string" ? entry.title : "",
        bounds: {
          x: asNumber(bounds.x, 0),
          y: asNumber(bounds.y, 0),
          width: asNumber(bounds.width, 0),
          height: asNumber(bounds.height, 0),
        },
        focused: frontmostId !== undefined && entry.window_id === frontmostId,
      };
      if (typeof entry.app_name === "string") info.app = entry.app_name;
      windows.push(info);
    }
    return windows;
  }

  // ── Action mapping ──────────────────────────────────────────────────────────

  /**
   * Map a click. The seam's ClickTarget carries only x/y/button/count — no
   * window — so this is a DESKTOP-scope click in screen pixels, matching the
   * space `get_desktop_state` returns.
   */
  function clickArgs(target: ClickTarget): Record<string, unknown> {
    return { scope: "desktop", x: target.x, y: target.y, button: target.button ?? "left", count: target.clickCount ?? 1 };
  }

  /**
   * Map a scroll. The driver takes a direction + tick count, while the seam
   * carries pixel deltas. Dominant axis wins; positive deltaY is "down" and
   * positive deltaX is "right" (wheel convention). Ticks are delta/120 (one wheel
   * notch), clamped to the driver's 1..50.
   */
  function scrollArgs(target: ScrollTarget): Record<string, unknown> {
    const deltaX = target.deltaX ?? 0;
    const deltaY = target.deltaY ?? 0;
    let direction: "up" | "down" | "left" | "right" = "down";
    if (Math.abs(deltaX) > Math.abs(deltaY)) direction = deltaX > 0 ? "right" : "left";
    else if (deltaY !== 0) direction = deltaY > 0 ? "down" : "up";
    const magnitude = Math.max(Math.abs(deltaX), Math.abs(deltaY));
    const amount = Math.min(50, Math.max(1, Math.round(magnitude / 120) || 1));
    return { scope: "desktop", direction, amount, x: target.x, y: target.y };
  }

  async function performAction(action: TransportAction): Promise<TransportResult<ActionOutcome>> {
    switch (action.kind) {
      case "click": {
        const result = await callTool("click", clickArgs(action.target));
        return result.ok ? { ok: true, value: { performed: true, detail: "click" } } : result;
      }
      case "type": {
        const result = await callTool("type_text", { scope: "desktop", text: action.text });
        return result.ok ? { ok: true, value: { performed: true, detail: "type" } } : result;
      }
      case "keypress": {
        const keys = action.keys.filter((key) => typeof key === "string" && key.length > 0);
        if (keys.length === 0) {
          return { ok: false, error: kaiError("VALIDATION_FAILED", "keypress requires at least one key") };
        }
        // One key → press_key; a combination → hotkey (modifiers + one key).
        const first = keys[0] as string;
        const result =
          keys.length === 1
            ? await callTool("press_key", { scope: "desktop", key: first })
            : await callTool("hotkey", { scope: "desktop", keys });
        return result.ok ? { ok: true, value: { performed: true, detail: keys.length === 1 ? `press_key:${first}` : `hotkey:${keys.join("+")}` } } : result;
      }
      case "scroll": {
        const result = await callTool("scroll", scrollArgs(action.target));
        return result.ok ? { ok: true, value: { performed: true, detail: "scroll" } } : result;
      }
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  /**
   * Terminate the whole tree, not just the direct child.
   *
   * WHY taskkill /T on Windows: Windows has no process groups, so
   * `child.kill()` (TerminateProcess) leaves any grandchildren — the driver's
   * own helper/overlay processes — running. `/T` walks the tree and `/F` forces
   * it, so dispose() genuinely leaves no orphan. Elsewhere SIGKILL suffices.
   */
  function killTree(target: ChildProcess): Promise<void> {
    if (target.exitCode !== null || target.signalCode !== null) return Promise.resolve();
    const pid = target.pid;
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(failsafe);
        resolve();
      };
      target.once("exit", finish);
      // Cleanup must itself be bounded; never hang on a driver that ignores us.
      const failsafe = setTimeout(finish, 3_000);
      failsafe.unref?.();
      try {
        if (process.platform === "win32" && pid !== undefined) {
          spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
        }
        target.kill("SIGKILL");
      } catch {
        finish();
      }
    });
  }

  function stderrTail(): string {
    return stderrBuffer;
  }

  /** Abort a half-open handshake so a refused/garbled driver is never orphaned. */
  async function hardKill(): Promise<void> {
    const current = child;
    if (!current) return;
    await killTree(current);
    child = null;
    framer = null;
    exited = true;
    sessionReady = false;
  }

  // ── The ComputerTransport surface ───────────────────────────────────────────

  async function connect(): Promise<TransportResult<ConnectInfo>> {
    return ensureConnected();
  }

  async function windows(): Promise<TransportResult<readonly WindowInfo[]>> {
    const result = await callTool("list_windows", {});
    if (!result.ok) return result;
    return { ok: true, value: parseWindows(result.value) };
  }

  async function inspect(): Promise<TransportResult<Inspection>> {
    const size = await callTool("get_screen_size", {});
    if (!size.ok) return size;
    const sizeData = size.value.structuredContent ?? {};
    const list = await windows();
    if (!list.ok) return list;
    const inspection: Inspection = {
      screen: { width: asNumber(sizeData.width, 0), height: asNumber(sizeData.height, 0) },
      windows: list.value,
    };
    // Cursor is optional in the seam; a failure here must not fail the inspection.
    const cursor = await callTool("get_cursor_position", {});
    if (cursor.ok) {
      const cursorData = cursor.value.structuredContent ?? {};
      inspection.cursor = { x: asNumber(cursorData.x, 0), y: asNumber(cursorData.y, 0) };
    }
    return { ok: true, value: inspection };
  }

  async function observe(observeOptions?: ObserveOptions): Promise<TransportResult<Frame>> {
    // The driver cannot crop the desktop: `get_desktop_state` captures the full
    // display, and `zoom` crops a *window* screenshot. Returning a full frame for
    // a region request would be a lie the deduper keys by region — so refuse, as
    // a value, rather than substitute different pixels.
    if (observeOptions?.region) {
      return {
        ok: false,
        error: kaiError("AGENT_CAPABILITY_MISSING", "cua-driver 0.28.2 has no desktop-region capture; observe({region}) is unsupported", {
          detail: "region_capture_unsupported",
        }),
      };
    }
    const result = await callTool("get_desktop_state", {}, observeTimeoutMs);
    if (!result.ok) return result;
    const image = (result.value.content ?? []).find((part) => part.type === "image" && typeof part.data === "string");
    if (!image || typeof image.data !== "string") {
      return { ok: false, error: kaiError("AGENT_BAD_RESPONSE", "get_desktop_state returned no image content") };
    }
    const structured = result.value.structuredContent ?? {};
    const width = asNumber(structured.screenshot_width, asNumber(structured.screen_width, 0));
    const height = asNumber(structured.screenshot_height, asNumber(structured.screen_height, 0));
    // The driver supplies no separate frame hash, so hash the payload itself with
    // the shared hashFrame — a real content hash, so deduplication still works.
    return { ok: true, value: { data: image.data, width, height, hash: hashFrame(image.data) } };
  }

  async function act(action: TransportAction): Promise<TransportResult<ActionOutcome>> {
    return performAction(action);
  }

  async function health(): Promise<RealHealthOutcome> {
    const started = now();
    let pipe: DaemonPipeHealth | undefined;
    if (daemonPipe) {
      const probed = await probeNamedPipe(daemonPipe, pipeTimeoutMs);
      pipe = { path: daemonPipe, reachable: probed.reachable };
      if (probed.detail) pipe.detail = probed.detail;
      if (!probed.reachable && requireDaemonPipe) {
        return {
          ok: false,
          state: "unavailable",
          endpoint,
          daemonPipe: pipe,
          latencyMs: now() - started,
          error: kaiError("AGENT_NOT_LISTENING", `cua-driver daemon named pipe ${daemonPipe} is not reachable: ${probed.detail ?? "no detail"}`, {
            detail: "daemon_pipe_missing",
          }),
        };
      }
    }

    // A real MCP handshake — not a cached flag.
    const connected = await connect();
    if (!connected.ok) {
      return { ok: false, state: "unavailable", endpoint, daemonPipe: pipe, latencyMs: now() - started, error: connected.error };
    }
    const version = connected.value.version;

    // A real TOOL call as the liveness probe. We deliberately do NOT forward MCP
    // `ping`: older drivers answer -32601 (documented in transport.ts).
    const probe = await callTool("health_report", {}, Math.min(requestTimeoutMs, connectTimeoutMs));
    if (!probe.ok) {
      return { ok: false, state: "unavailable", endpoint, version, daemonPipe: pipe, latencyMs: now() - started, error: probe.error };
    }
    const structured = probe.value.structuredContent ?? {};
    const checks: DriverHealthCheck[] = Array.isArray(structured.checks)
      ? structured.checks.filter(isRecord).map((check) => ({
          name: typeof check.name === "string" ? check.name : "unknown",
          status: typeof check.status === "string" ? check.status : "unknown",
          message: typeof check.message === "string" ? check.message : "",
        }))
      : [];
    const failed = checks.filter((check) => check.status === "fail");
    if (failed.length > 0) {
      return {
        ok: false,
        state: "unavailable",
        endpoint,
        version,
        daemonPipe: pipe,
        latencyMs: now() - started,
        checks,
        error: kaiError("AGENT_RUN_FAILED", `cua-driver health_report reported ${failed.length} failing check(s): ${failed.map((c) => c.name).join(", ")}`),
      };
    }
    return {
      ok: true,
      state: "available",
      endpoint,
      version,
      supported: isSupportedDriverVersion(version),
      latencyMs: now() - started,
      daemonPipe: pipe,
      checks,
    };
  }

  async function dispose(): Promise<void> {
    if (disposed) return;
    disposed = true;
    failAllPending(kaiError("AGENT_NOT_LISTENING", "cua-driver transport was disposed"));
    connectedInfo = null;
    sessionReady = false;
    const current = child;
    child = null;
    framer = null;
    if (current) await killTree(current);
  }

  return {
    endpoint,
    get pid() {
      return child?.pid ?? null;
    },
    get connected() {
      return connectedInfo !== null && child !== null && !exited;
    },
    stderrTail() {
      return stderrTail();
    },
    connect,
    windows,
    inspect,
    act,
    observe,
    health,
    dispose,
    close: dispose,
  };
}
