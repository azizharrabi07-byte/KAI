// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The REAL MCP stdio client (Part Q): spawn a server, negotiate, list tools,
 * call them — and never throw across the seam.
 *
 * WHAT THIS IS
 * ------------
 * `bridge.ts` is a *byte-transparent seam*: it is meant to sit between an agent
 * and a server that are already talking, and it deliberately forwards frames it
 * does not understand. This file is a different thing — an MCP *client*. It
 * owns the conversation: it generates request ids, correlates responses by id,
 * enforces per-request deadlines, and turns every wire-level failure into a
 * `KaiError` value. `integration.ts` then adapts the discovered tools into KAI
 * `ToolDefinition`s with KAI-declared risk, and they enter the registry boundary
 * exactly like a built-in.
 *
 * THE FOUR PROPERTIES THAT MAKE IT REAL (and each has a test)
 * ----------------------------------------------------------
 *   1. LINE GRANULARITY. MCP's stdio transport is one JSON-RPC frame per line.
 *      A chunk off a pipe is arbitrary: it can end mid-frame, or split a UTF-8
 *      character in half. Every byte therefore crosses `createLineSplitter`
 *      (the same StringDecoder-based splitter the bridge uses), so the parser
 *      only ever sees complete lines. A partial chunk can NEVER produce a frame.
 *   2. CORRELATION BY ID. Responses may arrive out of order (a server handling a
 *      slow `tools/call` while answering a fast one). Requests are matched to
 *      responses by their JSON-RPC id, not by arrival order. A response whose id
 *      matches nothing — a late reply to a request that already timed out — is
 *      DROPPED, never mis-delivered to the next caller.
 *   3. DEADLINES ARE VALUES. A server that never answers surfaces as
 *      `AGENT_TIMEOUT`, not as a promise suspended forever and not as a throw. A
 *      server that dies surfaces as `AGENT_NOT_LISTENING`. Nothing in this file
 *      throws across its own boundary; every fallible call resolves to
 *      `McpResult<T>`.
 *   4. STDERR IS NOT THE WIRE. A server's own logging is exactly where it should
 *      be — on stderr, away from the protocol stream — and it is captured here
 *      for diagnostics. A non-JSON line arriving on STDOUT (a genuinely broken
 *      server) is recorded as protocol noise and skipped rather than allowed to
 *      poison the correlation table.
 *
 * LIFETIME. `dispose()` settles every in-flight request as a value, detaches
 * the stream handlers, ends stdin and then hard-kills the child, waiting for
 * `exit` before resolving. It is idempotent, and it leaves no orphan: the test
 * asserts the pid is gone afterwards.
 */

import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { KaiError, KaiErrorCode } from "../shared/contracts.ts";
import { createLineSplitter } from "./bridge.ts";
import { fail, mcpError, ok, type McpResult } from "./result.ts";

/**
 * What KAI tells a server about itself during `initialize`.
 *
 * Kept as constants rather than imported from a build-info file: the MCP
 * `clientInfo` is an identity the server may echo in its logs, and a version
 * string that silently changes with an unrelated build would make those logs
 * harder to compare, not easier.
 */
const CLIENT_NAME = "kai-core";
const CLIENT_VERSION = "0.1.0";

/**
 * The protocol revision KAI asks for. MCP lets the server answer with the
 * version it will actually speak; we record whatever it returns rather than
 * failing the handshake over a minor revision difference — the fixtures (and a
 * real server) may legitimately answer with an older one.
 */
const REQUESTED_PROTOCOL_VERSION = "2025-06-18";

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

/** Bound on captured stderr, so a chatty/trapping server cannot grow memory. */
const DEFAULT_MAX_STDERR_CHARS = 64 * 1024;

/** JSON-RPC error codes → KAI error codes. A closed mapping; unknown → bad response. */
const JSONRPC_CODE_MAP: Readonly<Record<number, KaiErrorCode>> = {
  [-32700]: "AGENT_BAD_RESPONSE", // parse error
  [-32600]: "AGENT_BAD_RESPONSE", // invalid request
  [-32601]: "NOT_FOUND", // method not found
  [-32602]: "VALIDATION_FAILED", // invalid params (a bad tool name lands here)
  [-32603]: "AGENT_RUN_FAILED", // internal error
};

// ── Options and shapes ───────────────────────────────────────────────────────

export interface SpawnMcpClientOptions {
  /** The executable to run. For a Node server this is usually `process.execPath`. */
  command: string;
  args?: string[];
  /** Extra environment for the child, merged over the parent's. */
  env?: Record<string, string>;
  cwd?: string;
  /** Deadline for a single request/response. Default 10s. */
  requestTimeoutMs?: number;
  /** Deadline for the `initialize` exchange specifically. Default 10s. */
  handshakeTimeoutMs?: number;
  /** Cap on captured stderr characters. Default 64 KiB. */
  maxStderrChars?: number;
  /** Clock injection, so error timestamps are deterministic under test. */
  now?: () => Date;
}

/** What the server declared about itself in its `initialize` result. */
export interface McpServerInfo {
  /** The revision the server will speak (may differ from what KAI asked for). */
  protocolVersion?: string;
  name?: string;
  version?: string;
  /** Server-declared capabilities, kept opaque — KAI does not rely on them. */
  capabilities?: unknown;
  /** Optional usage instructions. Display-only. */
  instructions?: string;
  /** The raw initialize result, for a field KAI does not model. */
  raw: unknown;
}

export interface CallToolOptions {
  /** Override the per-request deadline for this call only. */
  timeoutMs?: number;
}

/**
 * The live client. All four required operations are here, plus the small amount
 * of state a test needs to observe a real process (pid, liveness, stderr).
 */
export interface RealMcpClient {
  /** The child's pid, or undefined if it never spawned. Read-only observation. */
  readonly pid: number | undefined;
  /** True while the child is believed to be running. */
  alive(): boolean;
  /** The cached `initialize` result, once the handshake succeeded. */
  serverInfo(): McpServerInfo | undefined;
  /** Perform the MCP handshake. Idempotent; a failure may be retried. */
  initialize(): Promise<McpResult<McpServerInfo>>;
  /** `tools/list`. Returns the RAW entries: untrusted, to be validated by the adapter. */
  listTools(opts?: CallToolOptions): Promise<McpResult<unknown[]>>;
  /** `resources/list`. Returns the RAW entries, same trust rule as `listTools`. */
  listResources(opts?: CallToolOptions): Promise<McpResult<unknown[]>>;
  /** `resources/read`. Returns the RAW result object, same trust rule. */
  readResource(uri: string, opts?: CallToolOptions): Promise<McpResult<unknown>>;
  /** `tools/call`. Resolves to the JSON-RPC result, or a typed failure value. */
  callTool(name: string, args?: unknown, opts?: CallToolOptions): Promise<McpResult<unknown>>;
  /** Everything the server wrote to stderr, captured. Never part of the wire. */
  stderr(): string;
  /** Non-JSON lines seen on stdout (a broken server). Expected empty. */
  protocolNoise(): readonly string[];
  /** Hard-kill the child and settle everything pending. Idempotent; no orphan. */
  dispose(): Promise<void>;
}

// ── Small runtime guards ─────────────────────────────────────────────────────

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** JSON.stringify that cannot throw on a cyclic/hostile value. */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

// ── Windows command resolution ────────────────────────────────────────────────

/**
 * Turn a DECLARED stdio command into something this OS can actually spawn.
 *
 * WHY THIS EXISTS: an MCP config copied from Hermes declares `command: "npx"`,
 * which is exactly right on a POSIX host — but on Windows `npx` is a `.cmd`
 * shim, and Node's `spawn` cannot execute it without a shell (bare `npx` is
 * ENOENT; `npx.cmd` is EINVAL). A migration that did not account for this would
 * register a working server and then fail every launch with a spawn error.
 *
 * The resolution is DELIBERATELY SHELL-FREE for the package runners KAI knows:
 * `npx`/`npm` become `node <npx-cli.js|npm-cli.js> <args>`, so no argument ever
 * passes through a shell command line. Only an UNRECOGNISED `.cmd`/`.bat` falls
 * back to `cmd.exe /c` (MCP server configs are the operator's own, trusted
 * input), and that path is only taken when nothing safer matches.
 *
 * A non-Windows host, or a command already naming an executable, is returned
 * unchanged — this is a no-op everywhere it is not needed.
 */
export function resolveSpawnCommand(
  command: string,
  args: string[],
  platform: string = process.platform,
  nodeExecPath: string = process.execPath,
): { command: string; args: string[] } {
  if (platform !== "win32") return { command, args };
  const lower = command.toLowerCase();
  const nodeDir = dirname(nodeExecPath);
  const runner = (name: "npx" | "npm"): { command: string; args: string[] } | null => {
    const cli = join(nodeDir, "node_modules", "npm", "bin", `${name}-cli.js`);
    return existsSync(cli) ? { command: nodeExecPath, args: [cli, ...args] } : null;
  };
  if (lower === "npx" || lower === "npx.cmd" || lower === "npx.exe") {
    const resolved = runner("npx");
    if (resolved !== null) return resolved;
  }
  if (lower === "npm" || lower === "npm.cmd") {
    const resolved = runner("npm");
    if (resolved !== null) return resolved;
  }
  if (lower.endsWith(".cmd") || lower.endsWith(".bat")) {
    const quote = (token: string): string => (/[\s"&|<>^]/.test(token) ? `"${token.replace(/"/g, '""')}"` : token);
    return { command: "cmd.exe", args: ["/d", "/s", "/c", [command, ...args].map(quote).join(" ")] };
  }
  return { command, args };
}

// ── The client ───────────────────────────────────────────────────────────────

interface PendingRequest {
  method: string;
  resolve(result: McpResult<unknown>): void;
  timer: NodeJS.Timeout;
}

export function spawnMcpClient(options: SpawnMcpClientOptions): RealMcpClient {
  const now = options.now ?? (() => new Date());
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  const maxStderrChars = options.maxStderrChars ?? DEFAULT_MAX_STDERR_CHARS;

  // ── State ──────────────────────────────────────────────────────────────────
  /** Requests awaiting a response, keyed by the string form of their id. */
  const pending = new Map<string, PendingRequest>();
  /** ids are monotonically increasing and never reused, so a late reply cannot collide. */
  let nextId = 1;
  let dead = false;
  let disposed = false;
  let handshake: Promise<McpResult<McpServerInfo>> | undefined;
  let cachedServerInfo: McpServerInfo | undefined;

  let stderrText = "";
  const noise: string[] = [];
  const stderrDecoder = new StringDecoder("utf8");

  // ── Spawn ──────────────────────────────────────────────────────────────────
  // `stdio: ["pipe","pipe","pipe"]` is what makes this an MCP stdio client:
  // stdin and stdout are the protocol, stderr is the server's own logging.
  // `windowsHide` keeps a console from flashing on Windows.
  let child: ChildProcessWithoutNullStreams;
  try {
    const resolved = resolveSpawnCommand(options.command, options.args ?? []);
    child = spawn(resolved.command, resolved.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(options.env ?? {}) },
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      windowsHide: true,
    });
  } catch (error) {
    // `spawn` throws synchronously only for a malformed invocation (a bad
    // command argument). A factory that throws would break this module's
    // errors-as-values contract, so it returns an inert, already-failed client
    // whose every operation answers with a KaiError value.
    const detail = error instanceof Error ? error.message : String(error);
    const spawnError = mcpError(
      "AGENT_NOT_LISTENING",
      `the MCP server could not be spawned: ${detail}`,
      now,
      detail,
    );
    return {
      pid: undefined,
      alive: () => false,
      serverInfo: () => undefined,
      initialize: async () => fail(spawnError),
      listTools: async () => fail(spawnError),
      listResources: async () => fail(spawnError),
      readResource: async () => fail(spawnError),
      callTool: async () => fail(spawnError),
      stderr: () => "",
      protocolNoise: () => [],
      dispose: async () => {},
    };
  }

  // ── Error factories (all values, never throws) ─────────────────────────────
  const notListening = (detail?: string): KaiError =>
    mcpError(
      "AGENT_NOT_LISTENING",
      "the MCP server process is not running",
      now,
      detail,
    );

  const disposedError = (): KaiError =>
    mcpError("AGENT_NOT_LISTENING", "the MCP client was disposed before this request completed", now);

  const badResponse = (method: string, detail?: string): KaiError =>
    mcpError("AGENT_BAD_RESPONSE", `MCP server returned a malformed response to "${method}"`, now, detail);

  /**
   * Settle one pending request exactly once. Deleting BEFORE resolving means a
   * timeout that races a late response cannot double-settle, and a late response
   * finds no entry to settle (it is dropped).
   */
  function settle(idKey: string, result: McpResult<unknown>): void {
    const entry = pending.get(idKey);
    if (entry === undefined) return;
    pending.delete(idKey);
    clearTimeout(entry.timer);
    entry.resolve(result);
  }

  function settleAll(result: McpResult<unknown>): void {
    for (const idKey of [...pending.keys()]) settle(idKey, result);
  }

  /**
   * Turn a JSON-RPC error object into a typed KAI error. The message is the
   * server's own, prefixed with the method so an operator can tell which call
   * it answered; `data` rides along as detail.
   */
  function jsonRpcErrorToKai(error: unknown, method: string): KaiError {
    const record = isObject(error) ? error : {};
    const code = typeof record.code === "number" ? record.code : undefined;
    const serverMessage =
      typeof record.message === "string" && record.message.length > 0
        ? record.message
        : "no message";
    const kaiCode = (code === undefined ? undefined : JSONRPC_CODE_MAP[code]) ?? "AGENT_BAD_RESPONSE";
    const detail = record.data === undefined ? undefined : safeStringify(record.data);
    return mcpError(kaiCode, `MCP ${method} failed: ${serverMessage}`, now, detail);
  }

  /** True when a tool result carries MCP's `isError`. */
  function isErrorResult(value: unknown): boolean {
    return isObject(value) && value.isError === true;
  }

  /** Best-effort text from an MCP `{ content: [{type:"text", text}] }` result. */
  function resultText(value: unknown): string | undefined {
    if (!isObject(value) || !Array.isArray(value.content)) return undefined;
    const parts: string[] = [];
    for (const item of value.content) {
      if (isObject(item) && typeof item.text === "string") parts.push(item.text);
    }
    return parts.length > 0 ? parts.join("") : undefined;
  }

  // ── Outbound ───────────────────────────────────────────────────────────────

  /**
   * Send one request and correlate the eventual response by id.
   *
   * The returned promise ALWAYS resolves (as a value) — there is no reject path.
   * The deadline is armed before the write, so a synchronous write failure and a
   * silent server are both covered.
   */
  function request(method: string, params: unknown, timeoutMs: number): Promise<McpResult<unknown>> {
    if (disposed) return Promise.resolve(fail(disposedError()));
    if (dead) return Promise.resolve(fail(notListening()));

    const id = nextId++;
    const idKey = String(id);

    return new Promise<McpResult<unknown>>((resolve) => {
      const timer = setTimeout(() => {
        settle(
          idKey,
          fail(
            mcpError(
              "AGENT_TIMEOUT",
              `MCP request "${method}" (id ${id}) did not answer within ${timeoutMs}ms`,
              now,
            ),
          ),
        );
      }, timeoutMs);

      pending.set(idKey, { method, resolve, timer });

      const line = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
      try {
        child.stdin.write(line, (error) => {
          // A write that fails after the fact (EPIPE once the server died) must
          // settle the request rather than leave it waiting on a dead pipe.
          if (error) settle(idKey, fail(notListening(error.message)));
        });
      } catch (error) {
        settle(idKey, fail(notListening(error instanceof Error ? error.message : String(error))));
      }
    });
  }

  /** A notification (no id) is fire-and-forget; a failed send is a no-op value. */
  function notify(method: string, params: unknown): void {
    if (disposed || dead) return;
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    } catch {
      // Dropping a notification is correct: there is no one to answer it, and
      // inventing an error value with nowhere to return it would be noise.
    }
  }

  /** Answer a server→client request we do not implement. Never leave it hanging. */
  function refuseServerRequest(id: unknown, method: unknown): void {
    if (disposed || dead) return;
    try {
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: id === undefined ? null : id,
          error: { code: -32601, message: `KAI does not implement server method "${String(method)}"` },
        })}\n`,
      );
    } catch {
      // Same reasoning as notify(): a refusal that cannot be delivered is dropped.
    }
  }

  // ── Inbound ────────────────────────────────────────────────────────────────

  /**
   * One complete line from the server's stdout. Line granularity is already
   * guaranteed by the splitter; this decides what the frame IS.
   */
  function onLine(line: string): void {
    if (line.length === 0) return; // blank keep-alive line

    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      // A broken server put a non-JSON line on the WIRE. Record it and move on:
      // one malformed line must not poison the correlation table.
      noise.push(line.length > 500 ? `${line.slice(0, 500)}…` : line);
      return;
    }
    if (!isObject(frame)) return;

    const hasMethod = frame.method !== undefined;
    const hasId = frame.id !== undefined && frame.id !== null;

    // Server → client notification (e.g. a progress update): record nothing,
    // answer nothing. There is no inverse of `notify` to tick.
    if (hasMethod && !hasId) return;

    // Server → client REQUEST (sampling/roots). KAI implements none of them;
    // refuse explicitly so the server is never left waiting on us.
    if (hasMethod && hasId) {
      refuseServerRequest(frame.id, frame.method);
      return;
    }

    if (frame.id === undefined) return; // a result with no id is meaningless
    const idKey = String(frame.id);
    const entry = pending.get(idKey);
    if (entry === undefined) return; // late/unknown reply after a timeout: drop it

    if (frame.error !== undefined) {
      settle(idKey, fail(jsonRpcErrorToKai(frame.error, entry.method)));
      return;
    }
    settle(idKey, ok(frame.result));
  }

  const splitter = createLineSplitter(onLine);

  const onStdoutData = (chunk: Buffer): void => {
    // createLineSplitter owns the StringDecoder, so a UTF-8 character split
    // across two chunks is buffered, not mangled.
    splitter.push(chunk);
  };
  child.stdout.on("data", onStdoutData);
  // Stream-level errors from the child's pipes must never reach the event loop as
  // uncaught exceptions. A write to a pipe whose reader was just killed surfaces
  // asynchronously as `EPIPE` on stdin (the callback at request() may or may not
  // fire first) — dispose() kills the process, so this is expected and benign.
  child.stdin.on("error", () => {});
  child.stdout.on("error", () => {});

  const onStderrData = (chunk: Buffer): void => {
    stderrText += stderrDecoder.write(chunk);
    if (stderrText.length > maxStderrChars) {
      stderrText = stderrText.slice(stderrText.length - maxStderrChars);
    }
  };
  child.stderr.on("data", onStderrData);
  // A chatty server's stderr must never be able to crash the client.
  child.stderr.on("error", () => {});

  /**
   * The child exited (on its own or because we killed it). Mark dead and settle
   * every pending request as a value — a caller waiting on a dead server gets a
   * typed failure, never a promise that hangs.
   */
  const onExit = (): void => {
    dead = true;
    settleAll(fail(notListening()));
    splitter.flush();
  };
  child.on("exit", onExit);

  /** Spawn failed (ENOENT, EACCES). Same contract: values, not throws. */
  const onError = (error: Error): void => {
    dead = true;
    settleAll(fail(notListening(error.message)));
  };
  child.on("error", onError);

  // ── Operations ─────────────────────────────────────────────────────────────

  async function doHandshake(): Promise<McpResult<McpServerInfo>> {
    const params = {
      protocolVersion: REQUESTED_PROTOCOL_VERSION,
      // KAI advertises no client capabilities yet: it does not implement
      // sampling, roots or elicitation, and claiming them would invite a server
      // to send a request KAI would have to refuse.
      capabilities: {},
      clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
    };

    const response = await request("initialize", params, handshakeTimeoutMs);
    if (!response.ok) return response;

    const result = response.value;
    if (!isObject(result)) return fail(badResponse("initialize", "result was not an object"));

    const serverInfo: McpServerInfo = { raw: result };
    if (typeof result.protocolVersion === "string") serverInfo.protocolVersion = result.protocolVersion;
    if (isObject(result.serverInfo)) {
      if (typeof result.serverInfo.name === "string") serverInfo.name = result.serverInfo.name;
      if (typeof result.serverInfo.version === "string") serverInfo.version = result.serverInfo.version;
    }
    if (result.capabilities !== undefined) serverInfo.capabilities = result.capabilities;
    if (typeof result.instructions === "string") serverInfo.instructions = result.instructions;

    // The handshake is only complete once the initialized notification has been
    // sent — that is the MCP contract, and a server may withhold `tools/list`
    // until it sees it.
    notify("notifications/initialized", {});
    cachedServerInfo = serverInfo;
    return ok(serverInfo);
  }

  async function initialize(): Promise<McpResult<McpServerInfo>> {
    if (handshake !== undefined) return handshake;
    // Cache the in-flight promise so two concurrent callers negotiate once.
    const inFlight = doHandshake();
    handshake = inFlight;
    const result = await inFlight;
    // A failed handshake may be retried; a successful one is fixed.
    if (!result.ok) handshake = undefined;
    return result;
  }

  async function listTools(opts?: CallToolOptions): Promise<McpResult<unknown[]>> {
    const response = await request("tools/list", {}, opts?.timeoutMs ?? requestTimeoutMs);
    if (!response.ok) return response;
    const result = response.value;
    if (!isObject(result) || !Array.isArray(result.tools)) {
      return fail(badResponse("tools/list", "result.tools was not an array"));
    }
    return ok(result.tools);
  }

  /**
   * `resources/list`. Same contract as `listTools`: raw, untrusted entries in a
   * value; a malformed result is a typed failure, never a throw. A server that
   * does not implement resources answers with a JSON-RPC error (-32601), which
   * surfaces as the same kind of value.
   */
  async function listResources(opts?: CallToolOptions): Promise<McpResult<unknown[]>> {
    const response = await request("resources/list", {}, opts?.timeoutMs ?? requestTimeoutMs);
    if (!response.ok) return response;
    const result = response.value;
    if (!isObject(result) || !Array.isArray(result.resources)) {
      return fail(badResponse("resources/list", "result.resources was not an array"));
    }
    return ok(result.resources);
  }

  /**
   * `resources/read`. Same contract as `listResources`: raw entries in a
   * value, a malformed result or a server-side refusal as a typed failure.
   */
  async function readResource(
    uri: string,
    opts?: CallToolOptions,
  ): Promise<McpResult<unknown>> {
    if (typeof uri !== "string" || uri.length === 0 || uri.length > 2048) {
      return fail(mcpError("VALIDATION_FAILED", "resource uri must be a non-empty string", now));
    }
    const response = await request("resources/read", { uri }, opts?.timeoutMs ?? requestTimeoutMs);
    if (!response.ok) return response;
    const result = response.value;
    if (!isObject(result)) {
      return fail(badResponse("resources/read", "result was not an object"));
    }
    return ok(result);
  }

  async function callTool(
    name: string,
    args?: unknown,
    opts?: CallToolOptions,
  ): Promise<McpResult<unknown>> {
    const response = await request(
      "tools/call",
      { name, arguments: args ?? {} },
      opts?.timeoutMs ?? requestTimeoutMs,
    );
    if (!response.ok) return response;

    // MCP reports a tool-level failure as a successful JSON-RPC result that
    // carries `isError: true`. KAI's contract is that a failure is a failure
    // value, so it is converted here — a caller that got `{ok:true}` must be
    // able to assume the tool actually worked.
    if (isErrorResult(response.value)) {
      const text = resultText(response.value) ?? `MCP tool "${name}" reported an error`;
      return fail(mcpError("AGENT_RUN_FAILED", text, now));
    }
    return response;
  }

  // ── Dispose ────────────────────────────────────────────────────────────────

  let disposing: Promise<void> | undefined;

  async function doDispose(): Promise<void> {
    disposed = true;

    // 1. Every caller gets an answer. A pending request settled as a value is
    //    strictly better than a promise nobody will ever resolve.
    settleAll(fail(disposedError()));

    // 2. Stop consuming the streams so late frames cannot run handlers after
    //    we have torn the process down.
    child.stdout.off("data", onStdoutData);
    child.stderr.off("data", onStderrData);
    child.off("exit", onExit);
    child.off("error", onError);

    const hasExited = (): boolean => child.exitCode !== null || child.signalCode !== null;

    // 3. End stdin politely, then kill hard. SIGKILL on Windows is
    //    TerminateProcess, so a server that ignores signals still dies.
    try {
      child.stdin.end();
    } catch {
      // Already destroyed — nothing to end.
    }

    const exited = new Promise<void>((resolve) => {
      if (hasExited()) {
        resolve();
        return;
      }
      child.once("exit", () => resolve());
    });

    try {
      child.kill("SIGKILL");
    } catch {
      // Kill can fail if the process is already gone; the exit wait below settles it.
    }
    // On Windows a package runner spawns its own child (npx → node → server), and
    // killing only the runner leaves the real server alive holding the pipe — an
    // orphan, and a disposed client whose process never goes quiet. Kill the TREE.
    if (process.platform === "win32" && child.pid !== undefined) {
      try {
        execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } catch {
        // Already gone, or taskkill unavailable: the exit wait below still settles it.
      }
    }

    // A bounded wait: a child that somehow survives SIGKILL must not hang
    // dispose forever. The belt-and-braces second kill covers a raced spawn pid.
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 2000))]);
    if (!hasExited() && child.pid !== undefined) {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // Gone between the check and the kill: exactly the outcome we wanted.
      }
      await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 500))]);
    }

    dead = true;
    // Release the pipe handles explicitly. The OS side is gone (killed above),
    // but a still-referenced stream can keep this process's event loop alive
    // after dispose — a clean shutdown must not depend on the GC noticing.
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      try {
        stream.destroy();
      } catch {
        // Already destroyed.
      }
    }
    splitter.flush();
  }

  return {
    pid: child.pid,
    alive: () => !dead && !disposed && child.exitCode === null && child.signalCode === null && child.pid !== undefined,
    serverInfo: () => cachedServerInfo,
    initialize,
    listTools,
    listResources,
    readResource,
    callTool,
    stderr: () => stderrText,
    protocolNoise: () => [...noise],
    dispose: () => {
      if (disposing === undefined) disposing = doDispose();
      return disposing;
    },
  };
}
