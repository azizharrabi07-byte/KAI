// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Tests for the REAL `cua-driver` transport (real-transport.ts).
 *
 * Two kinds of test live here, and the difference matters:
 *
 *   REAL — spawns the installed `cua-driver` 0.28.2, completes the MCP
 *     handshake, and calls `list_windows` for real. These SKIP (with a reason)
 *     when the driver is not present, and they never silently pass.
 *
 *   HERMETIC — drives the transport against a tiny fake MCP stdio server
 *     spawned from a temp file. That lets the version gate, framing, action
 *     mapping, timeout discipline and cleanup be tested deterministically
 *     without touching a real screen or the real machine's daemon.
 *
 * The no-orphan tests check the OS: after `dispose()`, `process.kill(pid, 0)`
 * must report the process gone.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  JsonLineFramer,
  createRealComputerTransport,
  probeNamedPipe,
  type RealSpawnFn,
} from "../src/capabilities/computer/real-transport.ts";
import { MINIMUM_DRIVER_VERSION, REAL_DRIVER_SEAM } from "../src/capabilities/computer/transport.ts";
import { hashFrame } from "../src/capabilities/computer/observation.ts";

// ── Environment helpers ───────────────────────────────────────────────────────

const DRIVER_PATH = REAL_DRIVER_SEAM.executable;
const DRIVER_AVAILABLE = process.platform === "win32" && existsSync(DRIVER_PATH);
const SKIP_REASON = `cua-driver not installed at ${DRIVER_PATH} on ${process.platform}`;

/** Is an OS process still alive? `kill(pid, 0)` only probes. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Poll until the process is gone, so a test is not racing the OS reaper. */
async function waitUntilGone(pid: number, timeoutMs = 4_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isProcessAlive(pid);
}

// ── The fake MCP stdio server (written to a temp file at test time) ───────────

const FAKE_MCP_SERVER = [
  "// Fake MCP stdio server for KAI real-transport tests. CommonJS on purpose.",
  'const fs = require("node:fs");',
  'let buf = "";',
  'const version = process.env.FAKE_VERSION || "0.28.2";',
  'const tools = (process.env.FAKE_TOOLS || "start_session,list_windows,get_screen_size,get_cursor_position,get_desktop_state,click,type_text,press_key,hotkey,scroll,health_report").split(",").filter(Boolean);',
  'const mode = process.env.FAKE_MODE || "normal";',
  "const log = process.env.FAKE_LOG;",
  'function write(o) { process.stdout.write(JSON.stringify(o) + "\\n"); }',
  'function logged(name, args) { if (log) { try { fs.appendFileSync(log, JSON.stringify({ name: name, arguments: args }) + "\\n"); } catch (e) {} } }',
  'process.stdin.on("data", (d) => {',
  '  buf += d.toString("utf8");',
  "  let i;",
  '  while ((i = buf.indexOf("\\n")) >= 0) {',
  "    const line = buf.slice(0, i);",
  "    buf = buf.slice(i + 1);",
  "    if (!line.trim()) continue;",
  "    let msg;",
  "    try { msg = JSON.parse(line); } catch (e) { continue; }",
  "    if (mode === 'hang') continue;",
  "    if (msg.method === 'initialize') {",
  "      write({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-cua', version: version } } });",
  "    } else if (msg.method === 'notifications/initialized') {",
  "      // notifications take no reply",
  "    } else if (msg.method === 'tools/list') {",
  "      write({ jsonrpc: '2.0', id: msg.id, result: { tools: tools.map(function (n) { return { name: n, description: n, inputSchema: { type: 'object', properties: {} } }; }) } });",
  "    } else if (msg.method === 'tools/call') {",
  "      const name = msg.params && msg.params.name;",
  "      const args = (msg.params && msg.params.arguments) || {};",
  "      logged(name, args);",
  "      if (mode === 'flaky' && name !== 'start_session' && !globalThis.__flaked) { globalThis.__flaked = true; write({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: 'this session has ended; call start_session explicitly to reuse its label' }] } }); continue; }",
  "      if (name === 'list_windows') {",
  "        write({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: '1 window' }], structuredContent: { windows: [{ window_id: 42, pid: 7, title: 'Fake Window', app_name: 'fake.exe', bounds: { x: 1, y: 2, width: 300, height: 200 }, is_on_screen: true, minimized: false, layer: 0, z_index: 5 }] } } });",
  "      } else if (name === 'get_screen_size') {",
  "        write({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: '1920x1080' }], structuredContent: { width: 1920, height: 1080, scale_factor: 1 } } });",
  "      } else if (name === 'get_cursor_position') {",
  "        write({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: '0,0' }], structuredContent: { x: 0, y: 0 } } });",
  "      } else if (name === 'get_desktop_state') {",
  "        write({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'image', mimeType: 'image/png', data: 'ZmFrZQ==' }, { type: 'text', text: 'shot' }], structuredContent: { screenshot_width: 1920, screenshot_height: 1080, screen_width: 1920, screen_height: 1080, screenshot_mime_type: 'image/png' } } });",
  "      } else if (name === 'health_report') {",
  "        write({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'ok' }], structuredContent: { checks: [{ name: 'binary_version', status: 'pass', message: 'fake' }] } } });",
  "      } else {",
  "        write({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'ok' }], structuredContent: {} } });",
  "      }",
  "    }",
  "  }",
  "});",
  "",
].join("\n");

interface FakeDriver {
  scriptPath: string;
  logPath: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
}

function startFakeDriver(config: { version?: string; mode?: "normal" | "hang" | "echo" | "flaky"; tools?: string } = {}): FakeDriver {
  const dir = mkdtempSync(join(tmpdir(), "kai-cua-fake-"));
  const scriptPath = join(dir, "fake-mcp.cjs");
  const logPath = join(dir, "calls.jsonl");
  writeFileSync(scriptPath, FAKE_MCP_SERVER, "utf8");
  const env: NodeJS.ProcessEnv = { FAKE_LOG: logPath };
  if (config.version) env.FAKE_VERSION = config.version;
  if (config.mode) env.FAKE_MODE = config.mode;
  if (config.tools) env.FAKE_TOOLS = config.tools;
  return {
    scriptPath,
    logPath,
    env,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort; a leaked temp dir is not a test failure
      }
    },
  };
}

interface LoggedCall {
  name: string;
  arguments: Record<string, unknown>;
}

function readCallLog(path: string): LoggedCall[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as LoggedCall);
}

/** A spawnFn that records the OS pid, so cleanup can be asserted precisely. */
function capturingSpawn(record: { pid: number | null }): RealSpawnFn {
  return (command: string, args: string[], options: SpawnOptions): ChildProcess => {
    const child = spawn(command, args, options);
    record.pid = child.pid ?? null;
    return child;
  };
}

// ── (a) REAL smoke test ───────────────────────────────────────────────────────

test("real smoke: spawns cua-driver, completes the MCP handshake, and list_windows returns real windows", async (t) => {
  if (!DRIVER_AVAILABLE) return t.skip(SKIP_REASON);
  const transport = createRealComputerTransport();
  const pidBeforeDispose: { pid: number | null } = { pid: null };
  try {
    const connected = await transport.connect();
    assert.equal(connected.ok, true, connected.ok ? "" : `connect failed: ${connected.error.code} ${connected.error.message}`);
    if (!connected.ok) return;

    assert.equal(connected.value.version, MINIMUM_DRIVER_VERSION, "the installed driver reports the re-derived floor");
    assert.equal(connected.value.endpoint.kind, "mcp-stdio");
    assert.ok(connected.value.capabilities.includes("list_windows"), "list_windows is advertised");
    assert.ok(connected.value.capabilities.length >= 50, `expected the real ~57-tool surface, saw ${connected.value.capabilities.length}`);
    pidBeforeDispose.pid = transport.pid;
    assert.ok(typeof pidBeforeDispose.pid === "number" && pidBeforeDispose.pid > 0, "a real driver process was spawned");

    const listed = await transport.windows();
    assert.equal(listed.ok, true, listed.ok ? "" : `windows failed: ${listed.error.code} ${listed.error.message}`);
    if (!listed.ok) return;
    assert.ok(listed.value.length > 0, "the real machine has at least one top-level window");
    const first = listed.value[0];
    assert.ok(first);
    assert.equal(typeof first.id, "string");
    assert.equal(typeof first.title, "string");
    assert.equal(typeof first.bounds.width, "number");
    assert.ok(listed.value.some((window) => window.title.length > 0), "at least one window has a non-empty title");
  } finally {
    const pid = pidBeforeDispose.pid;
    await transport.dispose();
    if (pid !== null) assert.equal(await waitUntilGone(pid), true, `driver pid ${pid} survived dispose`);
  }
});

test("real smoke: health() reports AVAILABLE from a real probe and finds the named pipe", async (t) => {
  if (!DRIVER_AVAILABLE) return t.skip(SKIP_REASON);
  const transport = createRealComputerTransport();
  try {
    const outcome = await transport.health();
    assert.equal(outcome.state, "available", outcome.error ? `${outcome.error.code}: ${outcome.error.message}` : "expected available");
    assert.equal(outcome.ok, true);
    assert.equal(outcome.version, MINIMUM_DRIVER_VERSION);
    assert.equal(outcome.supported, true);
    assert.equal(transport.endpoint.daemonPipe, REAL_DRIVER_SEAM.windowsPipe, "the Windows transport knows the daemon named pipe");
    assert.ok(outcome.daemonPipe);
    assert.equal(outcome.daemonPipe?.reachable, true, "the daemon pipe probe connects with node:net");
    assert.ok(Array.isArray(outcome.checks) && outcome.checks.length > 0, "health_report returned structured checks");
  } finally {
    await transport.dispose();
  }
});

test("real smoke: probeNamedPipe connects to the daemon named pipe", async (t) => {
  if (!DRIVER_AVAILABLE) return t.skip(SKIP_REASON);
  // The daemon serves ONE pipe (`\\.\pipe\cua-driver`) and `node --test` runs the
  // suites in parallel, so the other driver-spawning tests in this file can hold
  // it when this probe starts. That is contention for a shared resource, not an
  // unreachable transport: measured here, the same probe connects in 1.5ms alone
  // and times out at 2s under load. Retried a bounded number of times so the
  // assertion still means "the pipe is reachable", which is what it claims.
  let probed = await probeNamedPipe(REAL_DRIVER_SEAM.windowsPipe, 2_000);
  for (let attempt = 0; attempt < 2 && !probed.reachable; attempt += 1) {
    probed = await probeNamedPipe(REAL_DRIVER_SEAM.windowsPipe, 2_000);
  }
  assert.equal(probed.reachable, true, `named pipe ${REAL_DRIVER_SEAM.windowsPipe} should be reachable: ${probed.detail ?? ""}`);
});

// ── (b) Version-mismatch refusal (injected fake version) ──────────────────────

test("version gate: a driver below MINIMUM_DRIVER_VERSION is refused as a value, naming both versions", async () => {
  const fake = startFakeDriver({ version: "0.19.3" });
  const recorded: { pid: number | null } = { pid: null };
  const transport = createRealComputerTransport({
    command: process.execPath,
    args: [fake.scriptPath],
    env: fake.env,
    spawnFn: capturingSpawn(recorded),
    connectTimeoutMs: 5_000,
  });
  try {
    const connected = await transport.connect();
    assert.equal(connected.ok, false, "an old driver must be refused");
    if (connected.ok) return;
    assert.equal(connected.error.code, "AGENT_CAPABILITY_MISSING");
    assert.match(connected.error.message, /0\.19\.3/, "the found version is named");
    assert.match(connected.error.message, new RegExp(MINIMUM_DRIVER_VERSION.replace(/\./g, "\\.")), "the required version is named");
    assert.equal(transport.connected, false);
    assert.equal(transport.pid, null, "the refused driver is not left attached");
    // A refused handshake must not orphan the process it briefly spawned.
    assert.ok(recorded.pid !== null);
    assert.equal(await waitUntilGone(recorded.pid as number), true, "the refused driver process was cleaned up");
  } finally {
    await transport.dispose();
    fake.cleanup();
  }
});

// ── (c) Line-granular framing ─────────────────────────────────────────────────

test("framing: a JSON-RPC frame split at every boundary reassembles exactly (with a multi-byte character)", () => {
  const frame = JSON.stringify({ jsonrpc: "2.0", id: 7, result: { text: "héllo — 世界", pad: "x".repeat(256) } });
  const wire = `${frame}\n`;
  const expected = [frame];

  // One UTF-8 byte at a time exercises StringDecoder across a multi-byte split.
  const bytes = Buffer.from(wire, "utf8");
  const byteFramer = new JsonLineFramer();
  const byteLines: string[] = [];
  for (let i = 0; i < bytes.length; i += 1) byteLines.push(...byteFramer.push(bytes.subarray(i, i + 1)));
  assert.deepEqual(byteLines, expected, "byte-by-byte reassembly");

  // Every single split point of the whole wire.
  for (let split = 0; split <= wire.length; split += 1) {
    const framer = new JsonLineFramer();
    const lines = [...framer.push(wire.slice(0, split)), ...framer.push(wire.slice(split)), ...framer.flush()];
    assert.deepEqual(lines, expected, `split at ${split}`);
  }
});

test("framing: multiple frames per chunk, CRLF, and an unterminated trailing frame", () => {
  const a = JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} });
  const b = JSON.stringify({ jsonrpc: "2.0", id: 2, result: {} });
  const c = JSON.stringify({ jsonrpc: "2.0", id: 3, result: {} });

  const framer = new JsonLineFramer();
  assert.deepEqual(framer.push(`${a}\r\n${b}\n`), [a, b], "two frames in one chunk, one CRLF");
  // Split c mid-frame: nothing is emitted until the final newline arrives.
  assert.deepEqual(framer.push(c.slice(0, c.length - 1)), [], "a partial frame yields nothing");
  assert.deepEqual(framer.push(`${c.slice(-1)}\n`), [c], "the frame completes on the newline");
  // A trailing frame with no newline is delivered by flush() at end-of-stream.
  assert.deepEqual(framer.push(a.slice(0, 10)), []);
  assert.deepEqual(framer.flush(), [a.slice(0, 10)]);
});

// ── Mapping: driver tools ← seam surface (hermetic) ───────────────────────────

test("mapping: windows(), inspect() and observe() parse the driver's structured output", async () => {
  const fake = startFakeDriver({});
  const transport = createRealComputerTransport({ command: process.execPath, args: [fake.scriptPath], env: fake.env });
  try {
    const listed = await transport.windows();
    assert.equal(listed.ok, true);
    if (!listed.ok) return;
    assert.equal(listed.value.length, 1);
    const window = listed.value[0];
    assert.ok(window);
    assert.equal(window.id, "42");
    assert.equal(window.title, "Fake Window");
    assert.equal(window.app, "fake.exe");
    assert.equal(window.focused, true, "the only on-screen normal-layer window is derived focused");
    assert.deepEqual(window.bounds, { x: 1, y: 2, width: 300, height: 200 });

    const inspection = await transport.inspect();
    assert.equal(inspection.ok, true);
    if (!inspection.ok) return;
    assert.deepEqual(inspection.value.screen, { width: 1920, height: 1080 });
    assert.deepEqual(inspection.value.cursor, { x: 0, y: 0 });
    assert.equal(inspection.value.windows.length, 1);

    const frame = await transport.observe();
    assert.equal(frame.ok, true);
    if (!frame.ok) return;
    assert.equal(frame.value.data, "ZmFrZQ==");
    assert.equal(frame.value.width, 1920);
    assert.equal(frame.value.height, 1080);
    assert.equal(frame.value.hash, hashFrame("ZmFrZQ=="), "the frame hash is a real content hash of the payload");

    // A region request is refused rather than silently substituted with full pixels.
    const region = await transport.observe({ region: { x: 0, y: 0, width: 10, height: 10 } });
    assert.equal(region.ok, false);
    if (!region.ok) assert.equal(region.error.code, "AGENT_CAPABILITY_MISSING");
  } finally {
    await transport.dispose();
    fake.cleanup();
  }
});

test("mapping: click/type/keypress/scroll reach the driver's real tools with desktop scope", async () => {
  const fake = startFakeDriver({ mode: "echo" });
  const transport = createRealComputerTransport({ command: process.execPath, args: [fake.scriptPath], env: fake.env });
  try {
    const connected = await transport.connect();
    assert.equal(connected.ok, true, connected.ok ? "" : connected.error.message);

    assert.equal((await transport.act({ kind: "click", target: { x: 10, y: 20 } })).ok, true);
    assert.equal((await transport.act({ kind: "type", text: "hi" })).ok, true);
    assert.equal((await transport.act({ kind: "keypress", keys: ["return"] })).ok, true);
    assert.equal((await transport.act({ kind: "keypress", keys: ["ctrl", "c"] })).ok, true);
    assert.equal((await transport.act({ kind: "scroll", target: { x: 1, y: 2, deltaY: -240 } })).ok, true);

    // An empty keypress is a validation refusal, not a driver call.
    const empty = await transport.act({ kind: "keypress", keys: [] });
    assert.equal(empty.ok, false);
    if (!empty.ok) assert.equal(empty.error.code, "VALIDATION_FAILED");

    const calls = readCallLog(fake.logPath);
    assert.deepEqual(
      calls.map((call) => call.name),
      ["start_session", "click", "type_text", "press_key", "hotkey", "scroll"],
      "the lifecycle session is started first, then the seam's actions map onto the driver's real tool names",
    );
    // The driver's screen/input tools refuse to run without a live lifecycle
    // session, so its start is part of the contract, not an extra.
    assert.deepEqual(calls[0]?.arguments, {});
    assert.deepEqual(calls[1]?.arguments, { scope: "desktop", x: 10, y: 20, button: "left", count: 1 });
    assert.deepEqual(calls[2]?.arguments, { scope: "desktop", text: "hi" });
    assert.deepEqual(calls[3]?.arguments, { scope: "desktop", key: "return" });
    assert.deepEqual(calls[4]?.arguments, { scope: "desktop", keys: ["ctrl", "c"] });
    assert.deepEqual(calls[5]?.arguments, { scope: "desktop", direction: "up", amount: 2, x: 1, y: 2 });
  } finally {
    await transport.dispose();
    fake.cleanup();
  }
});

// ── session lifecycle (the defect T7 found live) ──────────────────────────────
//
// The real driver refuses a tool call whose lifecycle session has ended ("this
// session has ended; call start_session explicitly to reuse its label"). A
// transport that never started one therefore worked exactly once and then
// reported the whole capability UNAVAILABLE. The call must be revived and
// replayed exactly once — a retry loop would be a different bug.

test("session: a session-ended error is revived and the call replayed exactly once", async () => {
  const fake = startFakeDriver({ mode: "flaky" });
  const transport = createRealComputerTransport({ command: process.execPath, args: [fake.scriptPath], env: fake.env });
  try {
    const connected = await transport.connect();
    assert.equal(connected.ok, true, connected.ok ? "" : connected.error.message);

    const clicked = await transport.act({ kind: "click", target: { x: 3, y: 4 } });
    assert.equal(clicked.ok, true, clicked.ok ? "" : clicked.error.message);

    const names = readCallLog(fake.logPath).map((call) => call.name);
    assert.deepEqual(
      names,
      ["start_session", "click", "start_session", "click"],
      "the first click failed on a dead session, so the session was re-started and the SAME call replayed once",
    );
    assert.equal(names.filter((n) => n === "click").length, 2, "exactly two click attempts, no retry loop");
    assert.equal(transport.connected, true, "the transport is still usable afterwards");
  } finally {
    await transport.dispose();
    fake.cleanup();
  }
});

// ── (d) No-orphan cleanup ─────────────────────────────────────────────────────

test("cleanup: dispose() kills the spawned driver so no orphan survives", async () => {
  const fake = startFakeDriver({});
  const recorded: { pid: number | null } = { pid: null };
  const transport = createRealComputerTransport({
    command: process.execPath,
    args: [fake.scriptPath],
    env: fake.env,
    spawnFn: capturingSpawn(recorded),
  });
  try {
    const connected = await transport.connect();
    assert.equal(connected.ok, true, connected.ok ? "" : connected.error.message);
    assert.ok(recorded.pid !== null && recorded.pid > 0, "a driver process was spawned");
    assert.equal(isProcessAlive(recorded.pid as number), true, "the driver is alive while connected");
    assert.equal(transport.connected, true);
  } finally {
    await transport.dispose();
    fake.cleanup();
  }
  assert.equal(await waitUntilGone(recorded.pid as number), true, `pid ${recorded.pid} survived dispose`);
  assert.equal(transport.pid, null);
  assert.equal(transport.connected, false);
});

test("cleanup: dispose() is idempotent and safe after a refused connect", async () => {
  const fake = startFakeDriver({ version: "0.19.3" });
  const transport = createRealComputerTransport({ command: process.execPath, args: [fake.scriptPath], env: fake.env });
  try {
    await transport.connect();
    await transport.dispose();
    await transport.dispose(); // must not throw
    await transport.close(); // alias
    assert.equal(transport.pid, null);
  } finally {
    fake.cleanup();
  }
});

// ── Timeout discipline ────────────────────────────────────────────────────────

test("timeout discipline: a hung driver surfaces AGENT_TIMEOUT as a value, not a hang", async () => {
  const fake = startFakeDriver({ mode: "hang" });
  const transport = createRealComputerTransport({
    command: process.execPath,
    args: [fake.scriptPath],
    env: fake.env,
    connectTimeoutMs: 800,
  });
  try {
    const started = Date.now();
    const connected = await transport.connect();
    const elapsed = Date.now() - started;
    assert.equal(connected.ok, false, "a driver that never answers must not be reported connected");
    if (!connected.ok) assert.equal(connected.error.code, "AGENT_TIMEOUT");
    assert.ok(elapsed < 8_000, `connect should surface within the timeout, took ${elapsed}ms`);
  } finally {
    await transport.dispose();
    fake.cleanup();
  }
});

// ── Honest health ─────────────────────────────────────────────────────────────

test("honest health: a missing driver reports UNAVAILABLE with the reason, never AVAILABLE", async () => {
  const missing = join(tmpdir(), `kai-cua-missing-${process.pid}.exe`);
  const transport = createRealComputerTransport({ command: missing });
  const outcome = await transport.health();
  assert.equal(outcome.ok, false);
  assert.equal(outcome.state, "unavailable");
  assert.ok(outcome.error, "an unavailable health result must carry the reason");
  assert.equal(outcome.error?.code, "AGENT_NOT_LISTENING");
  assert.match(outcome.error?.message ?? "", /not found|not reachable/i);
});
