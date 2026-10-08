// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The MCP client against a REAL server process — no mocks, no network.
 *
 * The peer is KAI's own fixture (`src/mcp/servers/echo-mcp-server.mjs`): a real
 * newline-delimited JSON-RPC 2.0 server on stdin/stdout. It is deliberately
 * KAI's, not a published npm MCP server, so the suite is reproducible offline
 * and a failure means the client broke — not that the network did. There is no
 * third-party MCP server anywhere in this file.
 *
 * What these tests pin down, in the order the required coverage lists it:
 *   - a frame split across pipe chunks is reassembled (line granularity);
 *   - handshake + tool discovery;
 *   - `tools/call` returns the server's content, correlated by id even when
 *     replies arrive out of order;
 *   - a bad tool name is a typed failure value, never a throw;
 *   - a server's noisy stderr never corrupts the protocol stream;
 *   - a hung request times out as a value and does not wedge the client;
 *   - a killed server surfaces as a value rather than a crash;
 *   - `dispose()` settles in-flight work and leaves no orphan pid;
 *   - discovered tools become KAI `ToolDefinition`s with KAI-DECLARED risk,
 *     `echo` and `write_note` get DIFFERENT risks, and a tool whose risk cannot
 *     be established is REFUSED — then they run through the real registry
 *     boundary, where the risky one is stopped.
 *
 * Run from `core/`:  npm test   (scripts/test.mjs discovers this file)
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { spawnMcpClient, type SpawnMcpClientOptions } from "../src/mcp/real-client.ts";
import { adaptMcpTool, resolveMcpRisk } from "../src/mcp/tool-adapter.ts";
import { validateDiscoveredTool } from "../src/mcp/validation.ts";
import { wireMcpTools } from "../src/mcp/integration.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import { createPolicyEngine } from "../src/policies/gate.ts";

/** The fixture server, addressed relative to this test file. */
const SERVER = fileURLToPath(new URL("../src/mcp/servers/echo-mcp-server.mjs", import.meta.url));

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Start the fixture through the real client, with a per-test temp directory for
 * `write_note`'s file. `cleanup()` always disposes the process and removes the
 * directory, so no test can leak a child or a stray note file.
 */
function startClient(overrides: Partial<SpawnMcpClientOptions> = {}, extraArgs: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "kai-mcp-real-"));
  const noteFile = join(dir, "notes.txt");
  const client = spawnMcpClient({
    command: process.execPath,
    args: [SERVER, `--note-file=${noteFile}`, ...extraArgs],
    requestTimeoutMs: 5000,
    handshakeTimeoutMs: 5000,
    ...overrides,
  });
  return {
    client,
    noteFile,
    dir,
    async cleanup() {
      await client.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Poll a predicate until it holds, or fail the test rather than hang. */
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor: condition was not met within the timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Find one raw discovered entry by name. Throws only in the test, never in prod. */
function named(tools: readonly unknown[], name: string): unknown {
  for (const tool of tools) {
    if (typeof tool === "object" && tool !== null && (tool as { name?: unknown }).name === name) return tool;
  }
  throw new Error(`tool "${name}" was not in the discovery result`);
}

/** The text of an MCP `{ content: [{type:"text", text}] }` tool result. */
function toolText(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === "object" && item !== null && typeof (item as { text?: unknown }).text === "string") {
      parts.push((item as { text: string }).text);
    }
  }
  return parts.length > 0 ? parts.join("") : undefined;
}

/** `execute()` returns the client's own McpResult, still a value. Unwrap it. */
function unwrapCallResult(value: unknown): { ok: boolean; value: unknown } {
  if (typeof value === "object" && value !== null && "ok" in value) {
    return value as { ok: boolean; value: unknown };
  }
  throw new Error("expected an McpResult value from the MCP tool call");
}

// ── 1. Handshake + discovery ─────────────────────────────────────────────────

test("real client: handshake succeeds and the server's declared tools are discovered", async () => {
  const { client, cleanup } = startClient();
  try {
    const init = await client.initialize();
    assert.equal(init.ok, true, "initialize must succeed against the fixture");
    if (!init.ok) return;

    // The fixture echoes the requested protocol revision, so negotiation is
    // observable rather than assumed.
    assert.equal(init.value.protocolVersion, "2025-06-18");
    assert.equal(init.value.name, "kai-echo-fixture");
    assert.equal(init.value.version, "0.1.0");
    assert.equal(client.alive(), true);
    assert.deepEqual(client.serverInfo(), init.value, "the initialize result must be cached");

    const listed = await client.listTools();
    assert.equal(listed.ok, true);
    if (!listed.ok) return;
    const names = listed.value.map((tool) => (tool as { name?: unknown }).name).sort();
    assert.deepEqual(names, ["echo", "write_note"]);

    // The entries are raw/untrusted, and the EXISTING validator accepts them —
    // discovery hands off to the adapter, which is the trust boundary.
    for (const tool of listed.value) {
      assert.equal(validateDiscoveredTool(tool).ok, true, "fixture tools must pass validateDiscoveredTool");
    }
  } finally {
    await cleanup();
  }
});

// ── 2. tools/call, correlated by id ──────────────────────────────────────────

test("real client: tools/call returns the server's content, correlated by id out of order", async () => {
  const { client, cleanup } = startClient();
  try {
    const init = await client.initialize();
    assert.equal(init.ok, true);

    const first = await client.callTool("echo", { text: "hello kai" });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(toolText(first.value), "hello kai");

    const upper = await client.callTool("echo", { text: "shout", uppercase: true });
    assert.equal(upper.ok, true);
    if (!upper.ok) return;
    assert.equal(toolText(upper.value), "SHOUT");

    // Fire a slow call and a fast call together. The fast one answers first; a
    // client that correlated by arrival order would hand its payload to the
    // wrong caller. Id correlation must keep them straight.
    const slow = client.callTool("echo", { text: "slow", delay_ms: 120 });
    const fast = client.callTool("echo", { text: "fast" });
    const [slowResult, fastResult] = await Promise.all([slow, fast]);
    assert.equal(fastResult.ok, true);
    assert.equal(slowResult.ok, true);
    if (!fastResult.ok || !slowResult.ok) return;
    assert.equal(toolText(fastResult.value), "fast", "the fast reply must reach the fast caller");
    assert.equal(toolText(slowResult.value), "slow", "the slow reply must reach the slow caller");
  } finally {
    await cleanup();
  }
});

// ── 3. A bad tool name is a value ────────────────────────────────────────────

test("real client: a call with a bad tool name is a typed failure, not a throw", async () => {
  const { client, cleanup } = startClient();
  try {
    assert.equal((await client.initialize()).ok, true);

    // Explicitly: awaiting it must not reject.
    let bad: Awaited<ReturnType<typeof client.callTool>> | undefined;
    await assert.doesNotReject(async () => {
      bad = await client.callTool("does_not_exist", {});
    });

    assert.notEqual(bad, undefined);
    assert.equal(bad?.ok, false);
    if (bad === undefined || bad.ok) return;
    assert.equal(bad.error.code, "VALIDATION_FAILED");
    assert.match(bad.error.message, /Unknown tool/);
    assert.equal(bad.error.retryable, false);
  } finally {
    await cleanup();
  }
});

// ── 4. stderr noise never corrupts the wire ──────────────────────────────────

test("real client: the server's noisy stderr never corrupts the protocol stream", async () => {
  const { client, cleanup } = startClient();
  try {
    assert.equal((await client.initialize()).ok, true);
    const called = await client.callTool("echo", { text: "clean payload" });
    assert.equal(called.ok, true);
    if (!called.ok) return;
    // The payload is exactly what was sent: no stderr text bled into it.
    assert.equal(toolText(called.value), "clean payload");

    const noise = client.stderr();
    assert.match(noise, /kai-echo-fixture/, "the fixture's stderr must be captured");
    assert.match(noise, /looks like a frame/, "even a JSON-looking stderr line must be captured, not parsed");
    // Every line the server put on stdout parsed as a frame; the JSON-looking
    // stderr line was NOT mistaken for one.
    assert.deepEqual(client.protocolNoise(), []);
    // A stderr line that LOOKS like a frame is present in stderr and was never
    // mistaken for a wire frame (protocolNoise, asserted empty above).
    assert.equal(
      noise.split("\n").some((line) => line.includes('{"this"')),
      true,
      "the JSON-looking stderr line must be captured on stderr",
    );
  } finally {
    await cleanup();
  }
});

// ── 4b. A frame split across chunks is reassembled ───────────────────────────

test("real client: a frame split across pipe chunks is reassembled, not lost", async () => {
  // `--split-frames` makes the fixture cut every response at a byte offset and
  // write the two halves as separate chunks, so the framing newline arrives in
  // a different chunk than the text. The StringDecoder in the line splitter is
  // what keeps the parser from ever seeing a fragment.
  const { client, cleanup } = startClient({}, ["--split-frames"]);
  try {
    const init = await client.initialize();
    assert.equal(init.ok, true, "a split initialize response must still parse");
    const listed = await client.listTools();
    assert.equal(listed.ok, true, "a split tools/list response must still parse");
    // A multi-byte payload: if a split lands mid-character the decoder must
    // stitch the bytes back rather than emit a replacement character.
    const called = await client.callTool("echo", { text: "café-🚀" });
    assert.equal(called.ok, true);
    if (!called.ok) return;
    assert.equal(toolText(called.value), "café-🚀");
    assert.deepEqual(client.protocolNoise(), []);
  } finally {
    await cleanup();
  }
});

// ── 5. Timeout is a value ────────────────────────────────────────────────────

test("real client: a hung request times out as a value and the client stays usable", async () => {
  // A tight per-request deadline; the handshake gets its own, longer, one.
  const { client, cleanup } = startClient({ requestTimeoutMs: 150 });
  try {
    assert.equal((await client.initialize()).ok, true);

    const hung = await client.callTool("echo", { text: "too slow", delay_ms: 2500 });
    assert.equal(hung.ok, false);
    if (hung.ok) return;
    assert.equal(hung.error.code, "AGENT_TIMEOUT");
    assert.match(hung.error.message, /did not answer within/);

    // The timeout must not wedge the client: a later fast call still works, and
    // when the abandoned reply finally arrives it is dropped, not mis-delivered.
    const after = await client.callTool("echo", { text: "still alive" }, { timeoutMs: 3000 });
    assert.equal(after.ok, true);
    if (!after.ok) return;
    assert.equal(toolText(after.value), "still alive");
  } finally {
    await cleanup();
  }
});

// ── 6. A killed server is a value, not a crash ───────────────────────────────

test("real client: a killed server surfaces as a value rather than a crash", async () => {
  const { client, cleanup } = startClient({ requestTimeoutMs: 2000 });
  try {
    assert.equal((await client.initialize()).ok, true);
    const pid = client.pid;
    assert.equal(typeof pid, "number", "a running client must expose its child pid");

    // Kill the child out from under the client, exactly as a crashing server would.
    process.kill(pid as number, "SIGKILL");
    await waitFor(() => client.alive() === false, 3000);

    let after: Awaited<ReturnType<typeof client.callTool>> | undefined;
    await assert.doesNotReject(async () => {
      after = await client.callTool("echo", { text: "x" });
    });
    assert.notEqual(after, undefined);
    assert.equal(after?.ok, false, "a request to a dead server must be a value");
    if (after === undefined || after.ok) return;
    assert.equal(after.error.code, "AGENT_NOT_LISTENING");
  } finally {
    await cleanup();
  }
});

// ── 6b. A server that cannot be spawned is a value ──────────────────────────

test("real client: a server that cannot be spawned surfaces as a value, not a throw", async () => {
  // A command that does not exist: `spawn` emits ENOENT asynchronously (and can
  // throw synchronously for a malformed invocation — handled the same way). The
  // handshake must answer with a KaiError, and no pid must be reported.
  const client = spawnMcpClient({
    command: join(tmpdir(), `kai-no-such-server-${process.pid}.exe`),
    requestTimeoutMs: 300,
    handshakeTimeoutMs: 300,
  });
  try {
    let init: Awaited<ReturnType<typeof client.initialize>> | undefined;
    await assert.doesNotReject(async () => {
      init = await client.initialize();
    });
    assert.notEqual(init, undefined);
    assert.equal(init?.ok, false);
    if (init === undefined || init.ok) return;
    assert.equal(init.error.code, "AGENT_NOT_LISTENING");
    assert.equal(client.alive(), false);
    assert.equal(client.pid, undefined);
  } finally {
    await client.dispose();
  }
});

// ── 7. dispose() leaves no orphan ────────────────────────────────────────────

test("real client: dispose() settles in-flight work and leaves no orphan process", async () => {
  const { client, cleanup } = startClient({ requestTimeoutMs: 60000 });
  try {
    assert.equal((await client.initialize()).ok, true);
    const pid = client.pid;
    assert.equal(typeof pid, "number");

    // In-flight on a server that will not answer for a minute.
    const pending = client.callTool("echo", { text: "never", delay_ms: 60000 });
    await client.dispose();

    // dispose() answered the caller rather than leaving it suspended...
    const settled = await pending;
    assert.equal(settled.ok, false);
    if (settled.ok) return;
    assert.equal(settled.error.code, "AGENT_NOT_LISTENING");

    assert.equal(client.alive(), false);
    // ...and the process is actually gone. Signal 0 is the existence probe:
    // ESRCH means there is nothing at that pid to signal.
    assert.throws(
      () => process.kill(pid as number, 0),
      (error: NodeJS.ErrnoException) => error.code === "ESRCH",
      "the child pid must not exist after dispose()",
    );

    // Idempotent: a second dispose resolves without throwing.
    await assert.doesNotReject(async () => {
      await client.dispose();
    });
  } finally {
    await cleanup();
  }
});

// ── 8. Discovered tools → KAI tools with KAI-declared risk ───────────────────

test("adapter: discovered tools become KAI ToolDefinitions with DIFFERENT KAI-declared risks", async () => {
  const { client, cleanup } = startClient();
  try {
    assert.equal((await client.initialize()).ok, true);
    const listed = await client.listTools();
    assert.equal(listed.ok, true);
    if (!listed.ok) return;
    const echo = named(listed.value, "echo");
    const writeNote = named(listed.value, "write_note");

    // The KAI declaration, not the server: echo is READ, everything else WRITE.
    const declaration = { default: "WRITE", tools: { echo: "READ" } };
    const echoDef = adaptMcpTool({
      server: "fixture",
      tool: echo,
      risk: declaration,
      call: async () => ({}),
    });
    const noteDef = adaptMcpTool({
      server: "fixture",
      tool: writeNote,
      risk: declaration,
      call: async () => ({}),
    });

    assert.equal(echoDef.ok, true);
    assert.equal(noteDef.ok, true);
    if (!echoDef.ok || !noteDef.ok) return;

    // Namespaced ids: a third-party tool cannot shadow a built-in.
    assert.equal(echoDef.value.id, "mcp.fixture.echo");
    assert.equal(noteDef.value.id, "mcp.fixture.write_note");

    // The central requirement: the two discovered tools get DIFFERENT risks,
    // and each equals KAI's declaration rather than the server's annotation.
    assert.equal(echoDef.value.risk, "READ");
    assert.equal(noteDef.value.risk, "WRITE");
    assert.notEqual(echoDef.value.risk, noteDef.value.risk);
    assert.equal(echoDef.value.risk, resolveMcpRisk(declaration, "echo"));
    // write_note's provider annotation says `destructiveHint: true`, which would
    // map to DESTRUCTIVE. KAI ignores it and keeps its own WRITE — proof the
    // provider's word is not the risk.
    assert.equal(noteDef.value.risk, "WRITE");
    assert.notEqual(noteDef.value.risk, "DESTRUCTIVE");

    // A real ToolDefinition: validators behave, description is non-empty.
    assert.equal(echoDef.value.validate({}).ok, true);
    assert.equal(echoDef.value.validate("not an object").ok, false);
    assert.equal(echoDef.value.description.length > 0, true);
  } finally {
    await cleanup();
  }
});

test("adapter: a discovered tool whose risk cannot be established is REFUSED (fail closed)", async () => {
  const { client, cleanup } = startClient();
  try {
    assert.equal((await client.initialize()).ok, true);
    const listed = await client.listTools();
    assert.equal(listed.ok, true);
    if (!listed.ok) return;
    const echo = named(listed.value, "echo");

    // No declaration at all: refused, and specifically NOT defaulted to READ.
    const noRisk = adaptMcpTool({ server: "fixture", tool: echo, call: async () => ({}) });
    assert.equal(noRisk.ok, false);
    if (noRisk.ok) return;
    assert.equal(noRisk.error.code, "POLICY_DENIED");
    assert.match(noRisk.error.message, /risk/i);

    // A declaration that simply does not cover this tool is equally refused.
    const uncovered = adaptMcpTool({
      server: "fixture",
      tool: echo,
      risk: { tools: { write_note: "WRITE" } },
      call: async () => ({}),
    });
    assert.equal(uncovered.ok, false);
    if (uncovered.ok) return;
    assert.equal(uncovered.error.code, "POLICY_DENIED");

    // The server's own readOnlyHint is never accepted as the missing risk.
    const advertisedReadOnly = named(listed.value, "echo") as { annotations?: unknown };
    assert.notEqual(advertisedReadOnly.annotations, undefined);
    assert.equal(adaptMcpTool({ server: "fixture", tool: advertisedReadOnly, call: async () => ({}) }).ok, false);
  } finally {
    await cleanup();
  }
});

// ── 9. Through the REAL registry boundary ────────────────────────────────────

test("integration: discovered MCP tools enter the real registry boundary, where the risky one is gated", async () => {
  const { client, noteFile, cleanup } = startClient();
  try {
    assert.equal((await client.initialize()).ok, true);
    const listed = await client.listTools();
    assert.equal(listed.ok, true);
    if (!listed.ok) return;
    const echo = named(listed.value, "echo");
    const writeNote = named(listed.value, "write_note");

    // The REAL policy engine and the REAL tool registry — nothing mocked.
    const registry = createToolRegistry({ policy: createPolicyEngine() });
    const report = wireMcpTools(registry, {
      server: "fixture",
      risk: { default: "WRITE", tools: { echo: "READ" } },
      tools: [
        { tool: echo, call: (args) => client.callTool("echo", args) },
        { tool: writeNote, call: (args) => client.callTool("write_note", args) },
      ],
    });
    assert.deepEqual(report.registered.sort(), ["mcp.fixture.echo", "mcp.fixture.write_note"]);
    assert.equal(report.refused.length, 0);

    // A READ-declared MCP tool runs, and its execution really reaches the server.
    const invoked = await registry.invoke("mcp.fixture.echo", { text: "via registry" });
    assert.equal(invoked.ok, true);
    if (!invoked.ok) return;
    const inner = unwrapCallResult(invoked.result);
    assert.equal(inner.ok, true);
    assert.equal(toolText(inner.value), "via registry");

    // The WRITE-declared MCP tool is stopped by the policy boundary before the
    // server ever sees it: no approval, no execution, no file written.
    const blocked = await registry.invoke("mcp.fixture.write_note", { note: "must not land" });
    assert.equal(blocked.ok, false);
    if (blocked.ok) return;
    assert.equal(blocked.error.code, "APPROVAL_REQUIRED");
    assert.equal(existsSync(noteFile), false, "a gated MCP write must never reach the server");
  } finally {
    await cleanup();
  }
});
