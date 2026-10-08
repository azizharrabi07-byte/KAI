#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * KAI's own minimal MCP server — the reproducible fixture for the real client.
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS KAI'S OWN
 * ---------------------------------------------
 * `core/tests/mcp-real.test.ts` has to prove that the stdio client can spawn a
 * server, negotiate, list tools and call them. Pointing that at a published
 * npm MCP server would make the test depend on the network, on a third party's
 * package version, and on someone else's tool surface — none of which KAI
 * controls. A red test would then be ambiguous: "MCP is broken" and "npm is
 * unreachable" would look identical. This fixture is a REAL MCP stdio server in
 * one dependency-free Node file: it speaks the same newline-delimited JSON-RPC
 * 2.0 framing the client implements, so the client is exercised against a
 * genuine peer, offline and reproducibly. No third-party server is involved.
 *
 * IT DELIBERATELY MISBEHAVES IN THE WAYS REAL SERVERS DO
 * ------------------------------------------------------
 *   - It writes noisy, non-JSON text to STDERR on every message. KAI's wire is
 *     stdout only, so a chatty server must not be able to corrupt a frame; the
 *     test asserts the client still parses every frame and captured the noise
 *     out-of-band.
 *   - `echo` can be told to sleep (`delay_ms`), so a hung request is real and
 *     the client's per-request timeout is exercised against a server that
 *     really is not answering.
 *
 * TRANSPORT
 * ---------
 * One JSON-RPC 2.0 frame per line on stdin/stdout. Stdout carries protocol
 * frames and nothing else; every diagnostic goes to stderr. A server that puts
 * a log line on stdout is broken, and this fixture never does.
 */

import { appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

/** What this fixture advertises when the client does not ask for a version. */
const PROTOCOL_VERSION = "2025-06-18";

const SERVER_INFO = { name: "kai-echo-fixture", version: "0.1.0" };

/** When set, responses are written in two byte-chunks (see `write`). */
const SPLIT_FRAMES = process.argv.includes("--split-frames");

/** Read `--name=value` from argv, falling back to `fallback`. */
function argValue(name, fallback) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit === undefined ? fallback : hit.slice(prefix.length);
}

/**
 * Where `write_note` appends. A caller (the test) pins it with
 * `--note-file=<path>` so it can read the file back and prove the tool either
 * ran or did not. The pid-keyed default keeps two stray servers from colliding.
 */
const NOTE_FILE = argValue("note-file", join(tmpdir(), `kai-echo-notes-${process.pid}.txt`));

/**
 * When `--expose-env=NAME` is passed, the server advertises one extra tool,
 * `read_env`, which answers ONLY with the value of that one variable (any other
 * name is refused). This exists so a test can prove that the credentials KAI
 * resolved for a server really reached the spawned child's environment — the
 * stdio transport's form of authentication. It is opt-in precisely so the
 * default tool list stays exactly `echo` + `write_note`.
 */
const EXPOSED_ENV = argValue("expose-env", "");

/**
 * Every diagnostic goes to stderr. The deliberate noise here is the point: a
 * client that lets stderr reach its protocol parser will fail on it.
 */
function log(message) {
  process.stderr.write(`[kai-echo-fixture ${process.pid}] ${message}\n`);
}

/**
 * The two tools. `echo` is genuinely read-only; `write_note` really appends to
 * a file on this machine. KAI's adapter ignores `annotations` when deciding
 * risk (see tool-adapter.ts) — they are present so a test can prove they are
 * NOT what sets the risk.
 */
const TOOLS = [
  {
    name: "echo",
    description: "Echo text back. Read-only: it performs no I/O.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        uppercase: { type: "boolean" },
        delay_ms: {
          type: "number",
          description: "Sleep this long before answering; used to exercise client timeouts.",
        },
      },
      required: ["text"],
    },
    // Self-reported hints by the server. KAI never trusts them as the risk.
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "write_note",
    description: "Append a line to a file on this machine.",
    inputSchema: {
      type: "object",
      properties: { note: { type: "string" } },
      required: ["note"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
];

// The opt-in `read_env` tool (see EXPOSED_ENV). Appended only when asked for, so
// every existing test's tool list is unchanged.
if (EXPOSED_ENV.length > 0) {
  TOOLS.push({
    name: "read_env",
    description: `Read the value of the single environment variable this fixture was told to expose (${EXPOSED_ENV}).`,
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  });
}

/**
 * The fixture's resources. `resources/list` AND `resources/read` are part of
 * the MCP surface KAI models, so the fixture implements both for the same
 * reason it implements tools: the client is exercised against a genuine peer,
 * offline. `note://kai/notes` reads the same file `write_note` appends to;
 * `echo://kai/hello` is a fixed greeting.
 */
const RESOURCES = [
  {
    uri: "note://kai/notes",
    name: "Notes",
    description: "The note file write_note appends to.",
    mimeType: "text/plain",
  },
  {
    uri: "echo://kai/hello",
    name: "Hello",
    description: "A fixed greeting resource.",
    mimeType: "text/plain",
  },
];

/** Write one protocol frame to stdout. The ONLY thing ever written there. */
function write(frame) {
  const line = `${JSON.stringify(frame)}\n`;
  if (SPLIT_FRAMES && line.length > 2) {
    // `--split-frames` exists to prove the client's line granularity across a
    // real pipe: the frame is cut at a BYTE offset and the two halves are
    // written as separate chunks, so the newline frames the write in a
    // different chunk than the text. A client without a StringDecoder would
    // parse a fragment (or mangle a multi-byte character split in half).
    const bytes = Buffer.from(line, "utf8");
    const cut = Math.max(1, Math.floor(bytes.length / 2));
    process.stdout.write(bytes.subarray(0, cut));
    setTimeout(() => process.stdout.write(bytes.subarray(cut)), 20);
  } else {
    process.stdout.write(line);
  }
  log(`sent id=${JSON.stringify(frame.id)} ${frame.error === undefined ? "result" : "error"}`);
}

function reply(id, result) {
  write({ jsonrpc: "2.0", id: id === undefined ? null : id, result });
}

function replyError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  write({ jsonrpc: "2.0", id: id === undefined ? null : id, error });
}

async function callTool(id, params) {
  const name = params === null || typeof params !== "object" ? undefined : params.name;
  const args =
    params !== null && typeof params === "object" && typeof params.arguments === "object" && params.arguments !== null
      ? params.arguments
      : {};

  if (name === "echo") {
    const delay = typeof args.delay_ms === "number" && args.delay_ms > 0 ? args.delay_ms : 0;
    // A real (async) sleep, so a hung request is a hung request and not a
    // synchronous shortcut the client could never be tested against.
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    let text = args.text === undefined ? "" : String(args.text);
    if (args.uppercase === true) text = text.toUpperCase();
    return reply(id, { content: [{ type: "text", text }] });
  }

  if (name === "write_note") {
    const note = args.note === undefined ? "" : String(args.note);
    const line = note.endsWith("\n") ? note : `${note}\n`;
    appendFileSync(NOTE_FILE, line, "utf8");
    const bytes = Buffer.byteLength(line);
    log(`write_note appended ${bytes} bytes to ${NOTE_FILE}`);
    return reply(id, { content: [{ type: "text", text: `appended ${bytes} bytes to ${NOTE_FILE}` }] });
  }

  if (name === "read_env") {
    // Only the one variable this fixture was told to expose, and only that one:
    // an MCP tool must never become an arbitrary environment reader.
    if (EXPOSED_ENV.length === 0 || args.name !== EXPOSED_ENV) {
      return replyError(id, -32602, `read_env only exposes ${EXPOSED_ENV.length > 0 ? EXPOSED_ENV : "nothing"}`);
    }
    const value = process.env[EXPOSED_ENV] === undefined ? "" : String(process.env[EXPOSED_ENV]);
    return reply(id, { content: [{ type: "text", text: value }] });
  }

  // Unknown tool: a JSON-RPC error (code -32602), which the client surfaces as
  // a typed policy-free failure rather than a thrown exception.
  return replyError(id, -32602, `Unknown tool: ${String(name)}`);
}

function readResource(id, params) {
  const uri = params !== null && typeof params === "object" ? params.uri : undefined;
  if (typeof uri !== "string" || uri.length === 0) {
    return replyError(id, -32602, "resources/read needs a string uri");
  }
  if (uri === "note://kai/notes") {
    let text = "";
    try {
      text = readFileSync(NOTE_FILE, "utf8");
    } catch {
      text = "";
    }
    return reply(id, { contents: [{ uri, mimeType: "text/plain", text }] });
  }
  if (uri === "echo://kai/hello") {
    return reply(id, { contents: [{ uri, mimeType: "text/plain", text: "hello from the echo fixture" }] });
  }
  return replyError(id, -32002, `Unknown resource: ${uri}`);
}

async function handle(frame) {
  if (frame === null || typeof frame !== "object" || Array.isArray(frame)) {
    log("ignoring non-object frame");
    return;
  }
  const method = frame.method;
  const id = frame.id;
  log(`recv method=${String(method)} id=${JSON.stringify(id)}`);

  if (method === undefined) {
    log("frame has no method; ignoring");
    return;
  }

  // A notification has no id and is never answered, per JSON-RPC 2.0.
  const isNotification = id === undefined || id === null;

  if (method === "initialize") {
    const requested =
      frame.params !== null &&
      typeof frame.params === "object" &&
      typeof frame.params.protocolVersion === "string"
        ? frame.params.protocolVersion
        : PROTOCOL_VERSION;
    // Echo the client's requested version: the fixture supports what it is
    // asked for, which is the one negotiation outcome a test can assert on.
    return reply(id, {
      protocolVersion: requested,
      capabilities: { tools: {}, resources: {} },
      serverInfo: SERVER_INFO,
      instructions: "KAI's MCP fixture. echo is read-only; write_note appends to a temp file.",
    });
  }
  if (method === "notifications/initialized") {
    log("client reported initialized");
    return;
  }
  if (method === "ping") return reply(id, {});
  if (method === "tools/list") return reply(id, { tools: TOOLS });
  if (method === "resources/list") return reply(id, { resources: RESOURCES });
  if (method === "resources/read") return readResource(id, frame.params);
  if (method === "tools/call") return callTool(id, frame.params);

  if (isNotification) return;
  return replyError(id, -32601, `Method not found: ${String(method)}`);
}

// Startup noise, written before any frame. Two shapes on purpose: free text,
// and something that LOOKS like JSON — neither may reach the protocol parser.
log(`starting; note file ${NOTE_FILE}`);
log('{"this":"looks like a frame but is stderr, and must never be read as one"}');

process.stdin.on("error", (error) => log(`stdin error: ${String(error)}`));

const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
reader.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  let frame;
  try {
    frame = JSON.parse(trimmed);
  } catch {
    log(`ignoring non-JSON stdin line: ${trimmed.slice(0, 80)}`);
    return;
  }
  // Deliberately not awaited: an async handler must be able to answer out of
  // order (id correlation is the client's job), and a hung handler must not
  // wedge the reader for every later request.
  void handle(frame).catch((error) => {
    log(`handler threw: ${error && error.stack ? error.stack : String(error)}`);
  });
});

// stdin closed → the client is done with us. Exit rather than linger.
reader.on("close", () => process.exit(0));
