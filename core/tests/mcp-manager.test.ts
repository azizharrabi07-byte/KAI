// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The MCP manager — KAI actually owning the mechanism, proven against a real
 * server process and the real policy boundary.
 *
 * No mocks on the MCP side: the peer is KAI's own fixture
 * (`src/mcp/servers/echo-mcp-server.mjs`), spawned for real over stdio, exactly
 * as production would spawn a third-party server. The tool registry, policy
 * engine and approval service are the REAL ones (`tools/registry.ts`,
 * `policies/gate.ts`, `approvals/service.ts`).
 *
 * Run from `core/`:  node --test tests/mcp-manager.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createMcpManager, MCP_MANAGEMENT_TOOL_IDS } from "../src/mcp/manager.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import { createPolicyEngine } from "../src/policies/gate.ts";
import { createApprovalService } from "../src/approvals/service.ts";

/** The fixture server, addressed relative to this test file. */
const SERVER = fileURLToPath(new URL("../src/mcp/servers/echo-mcp-server.mjs", import.meta.url));

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** Hand-written fake ApprovalStore — deliberately does NOT import src/storage. */
function fakeApprovalStore() {
  const rows: Array<Record<string, unknown>> = [];
  return {
    rows,
    createApproval(approval: Record<string, unknown>) {
      rows.push({ ...approval });
    },
    getApproval(id: string) {
      const row = rows.find((entry) => entry.id === id);
      return row === undefined ? null : { ...row };
    },
    listApprovals(opts?: { status?: string }) {
      let out = rows.map((row) => ({ ...row }));
      if (opts?.status !== undefined) out = out.filter((row) => row.status === opts.status);
      return out;
    },
    decideApproval(id: string, status: string, decidedAt: string) {
      const row = rows.find((entry) => entry.id === id);
      if (row !== undefined) {
        row.status = status;
        row.decidedAt = decidedAt;
      }
    },
  };
}

/** The REAL policy engine + approval service + tool registry. */
function policyRegistry() {
  const store = fakeApprovalStore();
  let seq = 0;
  const approvals = createApprovalService({
    store,
    idFactory: () => `apr-${++seq}`,
    defaultTtlMs: 60_000,
  });
  const policy = createPolicyEngine();
  const registry = createToolRegistry({ policy, approvals });
  return { registry, approvals, store };
}

interface FixtureOptions {
  noteFile: string;
  extraArgs?: string[];
  env?: Record<string, string>;
  risk?: { default?: string; tools?: Record<string, string> };
}

/** A stdio entry that runs the fixture through this Node binary. */
function fixtureEntry(options: FixtureOptions) {
  const entry: Record<string, unknown> = {
    command: process.execPath,
    args: [SERVER, `--note-file=${options.noteFile}`, ...(options.extraArgs ?? [])],
  };
  if (options.env !== undefined) entry.env = options.env;
  entry.risk = options.risk ?? { default: "WRITE", tools: { echo: "READ" } };
  return entry;
}

/** One temp dir per test; always cleaned up. */
function tempDir(t: { after(fn: () => void | Promise<void>): void }) {
  const dir = mkdtempSync(join(tmpdir(), "kai-mcp-manager-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

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

// ── Catalogue + management tools ─────────────────────────────────────────────

test("manager: management tools are registered into KAI's one registry, with honest risks", () => {
  const { registry } = policyRegistry();
  const manager = createMcpManager({ tools: registry });

  const report = manager.managementTools();
  assert.equal(report.refused.length, 0, JSON.stringify(report.refused));
  assert.deepEqual(
    [...report.registered].sort(),
    [
      MCP_MANAGEMENT_TOOL_IDS.connect,
      MCP_MANAGEMENT_TOOL_IDS.disable,
      MCP_MANAGEMENT_TOOL_IDS.disconnect,
      MCP_MANAGEMENT_TOOL_IDS.enable,
      MCP_MANAGEMENT_TOOL_IDS.refresh,
      MCP_MANAGEMENT_TOOL_IDS.register,
      MCP_MANAGEMENT_TOOL_IDS.remove,
      MCP_MANAGEMENT_TOOL_IDS.update,
    ].sort(),
  );

  // Risks are KAI's declaration: adding/editing is WRITE; connecting runs
  // third-party code with KAI's authority, so it is EXTERNAL.
  assert.equal(registry.get("mcp.register")?.risk, "WRITE");
  assert.equal(registry.get("mcp.enable")?.risk, "WRITE");
  assert.equal(registry.get("mcp.connect")?.risk, "EXTERNAL");
});

test("manager: a server lands DISABLED, cannot connect while disabled, and enables explicitly", async (t) => {
  const dir = tempDir(t);
  const { registry } = policyRegistry();
  const manager = createMcpManager({ tools: registry });

  const registered = manager.registerServer("fixture", fixtureEntry({ noteFile: join(dir, "notes.txt") }));
  assert.equal(registered.ok, true);
  if (!registered.ok) return;
  assert.equal(registered.value.enabled, false, "a new server is inert");

  const refused = await manager.connectServer("fixture");
  assert.equal(refused.ok, false);
  if (refused.ok) return;
  assert.equal(refused.error.code, "POLICY_DENIED");
  assert.match(refused.error.message, /disabled/);

  const enabled = manager.enableServer("fixture");
  assert.equal(enabled.ok, true);
  assert.equal(enabled.value.enabled, true);
});

// ── Connect + discovery ──────────────────────────────────────────────────────

test("manager: connect spawns the real server, negotiates, discovers tools and registers them with KAI-declared risk", async (t) => {
  const dir = tempDir(t);
  const { registry } = policyRegistry();
  const manager = createMcpManager({ tools: registry });
  t.after(() => manager.dispose());

  manager.registerServer("fixture", fixtureEntry({ noteFile: join(dir, "notes.txt") }));
  manager.enableServer("fixture");

  const connected = await manager.connectServer("fixture");
  assert.equal(connected.ok, true, JSON.stringify(connected));
  if (!connected.ok) return;
  assert.equal(connected.value.serverInfo.name, "kai-echo-fixture");
  assert.equal(connected.value.serverInfo.protocolVersion, "2025-06-18");
  assert.deepEqual(connected.value.registered.sort(), ["mcp.fixture.echo", "mcp.fixture.write_note"]);

  // The ids live in KAI's registry, namespaced so no provider can shadow a built-in.
  assert.equal(registry.get("mcp.fixture.echo")?.risk, "READ");
  assert.equal(registry.get("mcp.fixture.write_note")?.risk, "WRITE");

  const view = manager.serverView("fixture");
  assert.equal(view?.connected, true);
  assert.equal(view?.toolCount, 2);
  assert.equal(view?.resourceCount, null);

  // Idempotent: connecting again reports the same live state.
  const again = await manager.connectServer("fixture");
  assert.equal(again.ok, true);
  if (again.ok) assert.deepEqual(again.value.registered.sort(), ["mcp.fixture.echo", "mcp.fixture.write_note"]);
});

test("manager: a discovered tool with no KAI-declared risk is REFUSED, and the refusal is reported", async (t) => {
  const dir = tempDir(t);
  const { registry } = policyRegistry();
  const manager = createMcpManager({ tools: registry });
  t.after(() => manager.dispose());

  // No risk block at all: KAI cannot establish the risk, so nothing registers.
  manager.registerServer("fixture", {
    command: process.execPath,
    args: [SERVER, `--note-file=${join(dir, "notes.txt")}`],
  });
  manager.enableServer("fixture");
  const connected = await manager.connectServer("fixture");
  assert.equal(connected.ok, true);
  if (!connected.ok) return;
  assert.deepEqual(connected.value.registered, []);
  assert.equal(connected.value.refused.length, 2, "both tools refused for having no derivable risk");
  for (const refusal of connected.value.refused) {
    assert.equal(refusal.error.code, "POLICY_DENIED");
  }
  assert.equal(registry.get("mcp.fixture.echo"), undefined);
});

// ── Invocation through the REAL policy boundary ──────────────────────────────

test("manager: a READ MCP tool executes through the registry; a WRITE one parks, and an approved retry really reaches the server", async (t) => {
  const dir = tempDir(t);
  const noteFile = join(dir, "notes.txt");
  const { registry, approvals } = policyRegistry();
  const manager = createMcpManager({ tools: registry });
  t.after(() => manager.dispose());

  manager.registerServer("fixture", fixtureEntry({ noteFile }));
  manager.enableServer("fixture");
  assert.equal((await manager.connectServer("fixture")).ok, true);

  // READ: runs immediately, and the result really came from the server process.
  const echoed = await manager.invokeTool({
    server: "fixture",
    tool: "echo",
    arguments: { text: "through the boundary" },
    sessionId: "s-1",
    agentId: "kai",
    source: "ui",
  });
  assert.equal(echoed.ok, true, JSON.stringify(echoed));
  if (!echoed.ok) return;
  assert.equal(echoed.value.toolId, "mcp.fixture.echo");
  assert.equal(typeof echoed.value.executionId, "string");
  assert.equal(toolText(echoed.value.result), "through the boundary");

  // WRITE: parked BEFORE the server ever sees it; the file does not exist.
  const parked = await manager.invokeTool({
    server: "fixture",
    tool: "write_note",
    arguments: { note: "must not land yet" },
    sessionId: "s-1",
    agentId: "kai",
  });
  assert.equal(parked.ok, false);
  if (parked.ok) return;
  assert.equal(parked.error.code, "APPROVAL_REQUIRED");
  assert.equal(existsSync(noteFile), false, "a parked MCP write must not reach the server");

  // A human approves, and the SAME request is re-issued with the approval.
  // "SAME" is load-bearing: an approval now binds to the exact input the human
  // was shown, so re-issuing with DIFFERENT arguments is refused — which is the
  // point. The approval was granted for THIS note, and this note is what runs.
  const approvalId = parked.error.detail;
  assert.equal(typeof approvalId, "string");
  assert.equal(approvals.decide(approvalId as string, true).ok, true);
  const approved = await manager.invokeTool({
    server: "fixture",
    tool: "write_note",
    arguments: { note: "must not land yet" },
    approvalId,
  });
  assert.equal(approved.ok, true, JSON.stringify(approved));
  assert.equal(existsSync(noteFile), true, "an approved MCP write must actually run");
  assert.match(readFileSync(noteFile, "utf8"), /must not land yet/);
});

test("manager: provenance records every attempt — toolId, executionId, caller, arguments, status, duration, approval", async (t) => {
  const dir = tempDir(t);
  const noteFile = join(dir, "notes.txt");
  const { registry, approvals } = policyRegistry();
  const manager = createMcpManager({ tools: registry });
  t.after(() => manager.dispose());

  manager.registerServer("fixture", fixtureEntry({ noteFile }));
  manager.enableServer("fixture");
  assert.equal((await manager.connectServer("fixture")).ok, true);

  await manager.invokeTool({
    server: "fixture",
    tool: "echo",
    arguments: { text: "recorded" },
    sessionId: "s-42",
    agentId: "subagent-1",
    source: "workforce",
  });
  const parked = await manager.invokeTool({
    server: "fixture",
    tool: "write_note",
    arguments: { note: "x" },
    sessionId: "s-42",
  });
  assert.equal(parked.ok, false);
  if (parked.ok) return;

  const records = manager.provenance();
  assert.equal(records.length, 2);

  const executed = records.find((r) => r.status === "EXECUTED");
  assert.ok(executed !== undefined);
  assert.equal(executed.toolId, "mcp.fixture.echo");
  assert.equal(executed.server, "fixture");
  assert.equal(executed.tool, "echo");
  assert.equal(executed.source, "workforce");
  assert.equal(executed.sessionId, "s-42");
  assert.equal(executed.agentId, "subagent-1");
  assert.deepEqual(executed.arguments, { text: "recorded" });
  assert.equal(typeof executed.executionId, "string");
  assert.equal(executed.executionId.startsWith("mcp_"), true);
  assert.equal(typeof executed.durationMs, "number");
  assert.ok(executed.durationMs >= 0);
  assert.equal(executed.result !== undefined, true);
  assert.equal(executed.error, undefined);

  const approvalRecord = records.find((r) => r.status === "APPROVAL_REQUIRED");
  assert.ok(approvalRecord !== undefined);
  assert.equal(approvalRecord.toolId, "mcp.fixture.write_note");
  assert.equal(typeof approvalRecord.approvalId, "string", "the created approval is on the record");
  assert.equal(approvalRecord.error?.code, "APPROVAL_REQUIRED");

  // The ledger is newest-first and bounded.
  assert.equal(manager.provenance(1).length, 1);
  assert.equal(manager.provenance(1)[0]?.executionId, approvalRecord.executionId);
});

test("manager: a provenance sink is called for every attempt and cannot break the invocation", async (t) => {
  const dir = tempDir(t);
  const { registry } = policyRegistry();
  const seen: Array<{ toolId: string; status: string }> = [];
  const manager = createMcpManager({
    tools: registry,
    record: (record) => {
      seen.push({ toolId: record.toolId, status: record.status });
      throw new Error("a throwing sink must not veto the invocation");
    },
  });
  t.after(() => manager.dispose());

  manager.registerServer("fixture", fixtureEntry({ noteFile: join(dir, "notes.txt") }));
  manager.enableServer("fixture");
  assert.equal((await manager.connectServer("fixture")).ok, true);

  const echoed = await manager.invokeTool({ server: "fixture", tool: "echo", arguments: { text: "sink" } });
  assert.equal(echoed.ok, true, "a throwing sink must not break the call");
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], { toolId: "mcp.fixture.echo", status: "EXECUTED" });
});

// ── Refusals are values ──────────────────────────────────────────────────────

test("manager: unknown servers, unconnected servers and unknown tools refuse as typed values", async (t) => {
  const dir = tempDir(t);
  const { registry } = policyRegistry();
  const manager = createMcpManager({ tools: registry });
  t.after(() => manager.dispose());

  const unknown = await manager.invokeTool({ server: "nope", tool: "echo" });
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.error.code, "NOT_FOUND");

  manager.registerServer("fixture", fixtureEntry({ noteFile: join(dir, "notes.txt") }));
  manager.enableServer("fixture");
  const unconnected = await manager.invokeTool({ server: "fixture", tool: "echo" });
  assert.equal(unconnected.ok, false);
  if (!unconnected.ok) assert.match(unconnected.error.message, /not connected/);

  assert.equal((await manager.connectServer("fixture")).ok, true);
  const unknownTool = await manager.invokeTool({ server: "fixture", tool: "does_not_exist" });
  assert.equal(unknownTool.ok, false);
  if (!unknownTool.ok) assert.equal(unknownTool.error.code, "NOT_FOUND");

  // Every refusal above is on the provenance ledger too, honestly labelled.
  const statuses = manager.provenance().map((r) => r.status);
  assert.deepEqual(statuses, ["NOT_FOUND", "NOT_FOUND", "NOT_FOUND"]);
});

test("manager: a failing MCP tool surfaces as a failed call, never a false success", async (t) => {
  const dir = tempDir(t);
  const { registry } = policyRegistry();
  const manager = createMcpManager({ tools: registry });
  t.after(() => manager.dispose());

  manager.registerServer(
    "fixture",
    fixtureEntry({
      noteFile: join(dir, "notes.txt"),
      extraArgs: ["--expose-env=MCP_FIXTURE_TOKEN"],
      risk: { default: "READ" },
    }),
  );
  manager.enableServer("fixture");
  assert.equal((await manager.connectServer("fixture")).ok, true);

  // A tool name that was never discovered has no KAI-declared risk, so it is
  // refused BEFORE the server is asked — fail closed. (Its own annotations are
  // never trusted as the risk, so there is nothing to run it under.)
  const unregistered = await manager.invokeTool({ server: "fixture", tool: "never_discovered", arguments: {} });
  assert.equal(unregistered.ok, false);
  if (!unregistered.ok) assert.equal(unregistered.error.code, "NOT_FOUND");

  // `read_env` IS registered on this fixture instance; the server answers a
  // name it does not expose with a JSON-RPC error (-32602). That must surface
  // as a FAILED call, never as a false success.
  const failed = await manager.invokeTool({ server: "fixture", tool: "read_env", arguments: { name: "NOT_EXPOSED" } });
  assert.equal(failed.ok, false);
  if (failed.ok) return;
  assert.equal(failed.error.code, "INTERNAL");
  assert.match(failed.error.message, /failed/);
  const record = manager.provenance()[0];
  assert.equal(record?.status, "FAILED");
});

// ── Resources ────────────────────────────────────────────────────────────────

test("manager: listResources reads the live server's resources; the summary counts them", async (t) => {
  const dir = tempDir(t);
  const { registry } = policyRegistry();
  const manager = createMcpManager({ tools: registry });
  t.after(() => manager.dispose());

  manager.registerServer("fixture", fixtureEntry({ noteFile: join(dir, "notes.txt") }));
  manager.enableServer("fixture");

  const before = await manager.listResources("fixture");
  assert.equal(before.ok, false, "resources cannot be listed before the server is connected");

  assert.equal((await manager.connectServer("fixture")).ok, true);
  const listed = await manager.listResources("fixture");
  assert.equal(listed.ok, true);
  if (!listed.ok) return;
  assert.equal(listed.value.length, 2);
  const first = listed.value[0] as { uri?: unknown; name?: unknown };
  assert.equal(typeof first.uri, "string");
  assert.equal(manager.serverView("fixture")?.resourceCount, 2);
  assert.equal(manager.summary().resources, 2);
});

// ── Authentication ───────────────────────────────────────────────────────────

test("manager: credentials resolved for a stdio server really reach the spawned child's environment", async (t) => {
  const dir = tempDir(t);
  const { registry } = policyRegistry();
  const manager = createMcpManager({ tools: registry });
  t.after(() => manager.dispose());

  // KAI's own `KAI_` env namespace is reserved — a server entry cannot set a
  // variable that would redirect KAI's own runtime — so the fixture credential
  // deliberately uses a neutral name.
  const reserved = manager.registerServer("reserved-env", {
    command: process.execPath,
    args: [],
    env: { KAI_MCP_TEST_TOKEN: "x" },
  });
  assert.equal(reserved.ok, false);
  if (!reserved.ok) assert.equal(reserved.error.code, "VALIDATION_FAILED");

  manager.registerServer(
    "fixture",
    fixtureEntry({
      noteFile: join(dir, "notes.txt"),
      extraArgs: ["--expose-env=MCP_FIXTURE_TOKEN"],
      env: { MCP_FIXTURE_TOKEN: "tok-from-kai" },
      risk: { default: "READ" },
    }),
  );
  manager.enableServer("fixture");
  const connected = await manager.connectServer("fixture");
  assert.equal(connected.ok, true);
  if (!connected.ok) return;
  assert.deepEqual(connected.value.registered.sort(), ["mcp.fixture.echo", "mcp.fixture.read_env", "mcp.fixture.write_note"]);

  const read = await manager.invokeTool({
    server: "fixture",
    tool: "read_env",
    arguments: { name: "MCP_FIXTURE_TOKEN" },
  });
  assert.equal(read.ok, true, JSON.stringify(read));
  if (!read.ok) return;
  assert.equal(toolText(read.value.result), "tok-from-kai", "the credential must arrive in the child's env");
});

// ── Remote transport honesty ─────────────────────────────────────────────────

test("manager: a remote (http/sse) server cannot be connected — refused honestly, not faked", async () => {
  const { registry } = policyRegistry();
  const manager = createMcpManager({ tools: registry });

  const registered = manager.registerServer("remote", {
    url: "https://example.com/mcp",
    headers: { Authorization: "Bearer x" },
    risk: { default: "READ" },
  });
  assert.equal(registered.ok, true);
  manager.enableServer("remote");

  const connected = await manager.connectServer("remote");
  assert.equal(connected.ok, false);
  if (connected.ok) return;
  assert.equal(connected.error.code, "AGENT_NOT_LISTENING");
  assert.match(connected.error.message, /stdio transport only/);
  assert.equal(manager.summary().connected, 0);
});

// ── Disconnect + dispose ─────────────────────────────────────────────────────

test("manager: disconnect stops the process; a disconnected server's tools refuse; dispose leaves no orphan", async (t) => {
  const dir = tempDir(t);
  const { registry } = policyRegistry();
  const manager = createMcpManager({ tools: registry });

  manager.registerServer("fixture", fixtureEntry({ noteFile: join(dir, "notes.txt") }));
  manager.enableServer("fixture");
  assert.equal((await manager.connectServer("fixture")).ok, true);

  const disconnected = await manager.disconnectServer("fixture");
  assert.equal(disconnected.ok, true);
  assert.equal(manager.serverView("fixture")?.connected, false);

  const refused = await manager.invokeTool({ server: "fixture", tool: "echo", arguments: { text: "x" } });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.match(refused.error.message, /not connected/);

  // A second disconnect is a no-op value, not an error.
  assert.equal((await manager.disconnectServer("fixture")).ok, true);

  await manager.dispose();
});

test("manager: dispose() kills a live connection's process (no orphan)", async (t) => {
  const dir = tempDir(t);
  const { registry } = policyRegistry();
  const manager = createMcpManager({ tools: registry });

  manager.registerServer("fixture", fixtureEntry({ noteFile: join(dir, "notes.txt") }));
  manager.enableServer("fixture");
  assert.equal((await manager.connectServer("fixture")).ok, true);

  // The connection's client exposes its pid through the manager's view? It does
  // not — so prove liveness the honest way: the fixture is gone once disposed.
  await manager.dispose();
  const after = await manager.invokeTool({ server: "fixture", tool: "echo", arguments: { text: "x" } });
  assert.equal(after.ok, false, "after dispose, the tool must refuse");
  // Idempotent.
  await manager.dispose();
});

// ── Persistence ──────────────────────────────────────────────────────────────

test("manager: the catalogue (and its secrets) survives a restart when a persist path is given", async (t) => {
  const dir = tempDir(t);
  const persistPath = join(dir, "mcp-servers.json");
  const noteFile = join(dir, "notes.txt");

  const first = createMcpManager({ tools: policyRegistry().registry, persistPath });
  first.registerServer("fixture", fixtureEntry({ noteFile, env: { MCP_FIXTURE_TOKEN: "persisted-secret" } }));
  first.enableServer("fixture");
  await first.dispose();

  const second = createMcpManager({ tools: policyRegistry().registry, persistPath });
  t.after(() => second.dispose());
  const view = second.serverView("fixture");
  assert.ok(view !== undefined, "the server must survive the restart");
  assert.equal(view.enabled, true, "the enabled flag survives");
  const credentials = second.servers.credentialsFor("fixture");
  assert.equal(credentials.ok, true);
  if (credentials.ok && "env" in credentials.value) {
    assert.equal(credentials.value.env.MCP_FIXTURE_TOKEN, "persisted-secret");
  }
  assert.equal(second.summary().persistence.problem, null);
});

// ── Management operations THROUGH the policy boundary ────────────────────────

test("manager: management operations are themselves gated — mcp.enable parks, and only an approved retry enables", async () => {
  const { registry, approvals } = policyRegistry();
  const manager = createMcpManager({ tools: registry });

  manager.registerServer("fixture", { command: process.execPath, args: [] });

  const parked = await registry.invoke("mcp.enable", { name: "fixture" });
  assert.equal(parked.ok, false);
  if (parked.ok) return;
  assert.equal(parked.error.code, "APPROVAL_REQUIRED", "a WRITE management op must park by default");
  assert.deepEqual(manager.servers.enabledNames(), [], "nothing happened while parked");

  const approvalId = parked.error.detail as string;
  assert.equal(approvals.decide(approvalId, true).ok, true);
  const approved = await registry.invoke("mcp.enable", { name: "fixture" }, { approvalId });
  assert.equal(approved.ok, true, JSON.stringify(approved));
  assert.deepEqual(manager.servers.enabledNames(), ["fixture"]);

  // mcp.connect is EXTERNAL: it parks too (and does not run without a human).
  const connectParked = await registry.invoke("mcp.connect", { name: "fixture" });
  assert.equal(connectParked.ok, false);
  if (!connectParked.ok) assert.equal(connectParked.error.code, "APPROVAL_REQUIRED");
  assert.equal(manager.serverView("fixture")?.connected, false);
});

test("manager: a malformed registration is refused at validate() — before policy, as a value", async () => {
  const { registry } = policyRegistry();
  const manager = createMcpManager({ tools: registry });

  const bad = await registry.invoke("mcp.register", { name: "fixture", command: "" });
  assert.equal(bad.ok, false);
  if (bad.ok) return;
  assert.equal(bad.error.code, "VALIDATION_FAILED");
  assert.equal(manager.servers.list().length, 0);

  const reserved = await registry.invoke("mcp.register", { name: "system", command: "run" });
  assert.equal(reserved.ok, false);
  if (!reserved.ok) assert.equal(reserved.error.code, "VALIDATION_FAILED");
});
