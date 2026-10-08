// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The `mcp` capability seam: measured health, the explicit re-registration that
 * replaces runtime.ts's probe-less declaration, and the dispatch the runtime's
 * `capability.mcp` branch will call.
 *
 * Real everything: the capability registry (`capabilities/registry.ts`), the
 * tool registry, the policy engine, the approval service — and KAI's own
 * fixture server, spawned for real over stdio. The ONE injection is a
 * fault-injection wrapper around the capability registry in the restore test,
 * and it is labelled as such: it exists to prove the "put the old definition
 * back" path, which cannot be reached any other way.
 *
 * Run from `core/`:  node --test tests/mcp-capability.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createCapabilityRegistry, type CapabilityRegistry } from "../src/capabilities/registry.ts";
import { createApprovalService } from "../src/approvals/service.ts";
import { createPolicyEngine } from "../src/policies/gate.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import { createMcpManager } from "../src/mcp/manager.ts";
import { dispatchMcpCapability, installMcpCapability, mcpCapabilityHealth } from "../src/mcp/capability.ts";

/** The fixture server, addressed relative to this test file. */
const SERVER = fileURLToPath(new URL("../src/mcp/servers/echo-mcp-server.mjs", import.meta.url));

// ── Fixtures (same pattern as tests/mcp-manager.test.ts) ──────────────────────

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
  risk?: { default?: string; tools?: Record<string, string> };
}

function fixtureEntry(options: FixtureOptions) {
  const entry: Record<string, unknown> = {
    command: process.execPath,
    args: [SERVER, `--note-file=${options.noteFile}`],
    risk: options.risk ?? { default: "WRITE", tools: { echo: "READ" } },
  };
  return entry;
}

function tempDir(t: { after(fn: () => void | Promise<void>): void }) {
  const dir = mkdtempSync(join(tmpdir(), "kai-mcp-capability-"));
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

/** A manager with the fixture registered+enabled+connected (real spawn). */
async function connectedFixture(t: { after(fn: () => void | Promise<void>): void }) {
  const dir = tempDir(t);
  const noteFile = join(dir, "notes.txt");
  const { registry } = policyRegistry();
  const manager = createMcpManager({ tools: registry });
  t.after(() => manager.dispose());

  manager.registerServer("fixture", fixtureEntry({ noteFile }));
  manager.enableServer("fixture");
  const connected = await manager.connectServer("fixture");
  assert.equal(connected.ok, true, JSON.stringify(connected));
  return { manager, noteFile };
}

// ── Health is measured, not declared ─────────────────────────────────────────

test("capability: health is measured from live manager state — every state has an honest detail", async (t) => {
  const dir = tempDir(t);
  const { registry } = policyRegistry();
  const manager = createMcpManager({ tools: registry });
  t.after(() => manager.dispose());

  // Nothing registered at all.
  const none = mcpCapabilityHealth(manager);
  assert.equal(none.availability, "UNAVAILABLE");
  assert.match(none.detail, /no MCP server is registered/);

  // Registered, not enabled.
  manager.registerServer("fixture", fixtureEntry({ noteFile: join(dir, "notes.txt") }));
  const inert = mcpCapabilityHealth(manager);
  assert.equal(inert.availability, "UNAVAILABLE");
  assert.match(inert.detail, /none enabled/);

  // Enabled, not connected.
  manager.enableServer("fixture");
  const degraded = mcpCapabilityHealth(manager);
  assert.equal(degraded.availability, "DEGRADED");
  assert.match(degraded.detail, /enabled but not connected/);

  // Connected: AVAILABLE, with the measured counts in the detail.
  assert.equal((await manager.connectServer("fixture")).ok, true);
  const available = mcpCapabilityHealth(manager);
  assert.equal(available.availability, "AVAILABLE");
  assert.match(available.detail, /1 MCP server\(s\) connected/);
  assert.match(available.detail, /2 tool\(s\) registered/);
});

// ── installMcpCapability: the explicit replacement ───────────────────────────

test("capability: install replaces the probe-less registration and checkHealth then measures the live manager", async (t) => {
  const { manager } = await connectedFixture(t);
  const capabilities = createCapabilityRegistry();

  // The shape runtime.ts leaves behind: a declaration that can only echo
  // UNAVAILABLE, whatever MCP is actually doing. (Probe deliberately blind.)
  const stub = capabilities.register({
    id: "mcp",
    name: "MCP servers and tools",
    risk: "EXTERNAL",
    provider: "kai",
    availability: "UNAVAILABLE",
    actions: [{ id: "call", risk: "EXTERNAL" }],
    health: async () => ({ availability: "UNAVAILABLE", detail: "declared, not measured" }),
  });
  assert.equal(stub.ok, true);

  // Even with a live connection, the old probe says UNAVAILABLE: that is the bug.
  const before = await capabilities.checkHealth("mcp");
  assert.equal(before?.availability, "UNAVAILABLE");

  const installed = installMcpCapability(capabilities, manager);
  assert.equal(installed.ok, true, JSON.stringify(installed));
  if (!installed.ok) return;

  // Identity is preserved; availability starts under-claimed (UNAVAILABLE).
  assert.equal(installed.value.id, "mcp");
  assert.equal(installed.value.name, "MCP servers and tools");
  assert.equal(installed.value.risk, "EXTERNAL");
  assert.deepEqual(installed.value.supportedActions, ["call"]);
  assert.equal(installed.value.availability, "UNAVAILABLE");

  // The first probe records what is actually true: AVAILABLE with counts.
  const probed = await capabilities.checkHealth("mcp");
  assert.equal(probed?.availability, "AVAILABLE");
  assert.equal(probed?.healthy, true);
  assert.match(probed?.detail ?? "", /1 MCP server\(s\) connected/);

  // The probe follows the manager down as it changes state.
  assert.equal((await manager.disconnectServer("fixture")).ok, true);
  const degraded = await capabilities.checkHealth("mcp");
  assert.equal(degraded?.availability, "DEGRADED");
  assert.equal(degraded?.healthy, false);

  assert.equal(manager.disableServer("fixture").ok, true);
  const inert = await capabilities.checkHealth("mcp");
  assert.equal(inert?.availability, "UNAVAILABLE");
  assert.match(inert?.detail ?? "", /none enabled/);
});

test("capability: install into a registry that never had `mcp` is a plain register", async (t) => {
  const dir = tempDir(t);
  const { registry } = policyRegistry();
  const manager = createMcpManager({ tools: registry });
  t.after(() => manager.dispose());

  const capabilities = createCapabilityRegistry();
  const installed = installMcpCapability(capabilities, manager);
  assert.equal(installed.ok, true);
  if (!installed.ok) return;
  assert.equal(installed.value.id, "mcp");
  assert.equal(installed.value.risk, "EXTERNAL");
  assert.deepEqual(installed.value.supportedActions, ["call"]);

  // Under-claimed until probed; the probe then reports the measured truth.
  assert.equal(installed.value.availability, "UNAVAILABLE");
  const probed = await capabilities.checkHealth("mcp");
  assert.equal(probed?.availability, "UNAVAILABLE");
  assert.match(probed?.detail ?? "", /no MCP server is registered/);
});

test("capability: a failed replacement restores the previous definition instead of leaving KAI with none (fault injection)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kai-mcp-capability-"));
  try {
    const { registry } = policyRegistry();
    const manager = createMcpManager({ tools: registry });

    const real = createCapabilityRegistry();
    let registerCalls = 0;
    // FAULT INJECTION, labelled: the real registry refuses nothing here, so the
    // second register call (the replacement) is made to fail deliberately —
    // that is the only way to reach the restore branch, which must leave the
    // original definition in place.
    const faulting: CapabilityRegistry = {
      ...real,
      register: (registration) => {
        registerCalls += 1;
        if (registerCalls === 2) {
          return {
            ok: false,
            error: {
              code: "VALIDATION_FAILED",
              message: "injected register failure (fault injection)",
              retryable: false,
              at: new Date().toISOString(),
            },
          };
        }
        return real.register(registration);
      },
    };

    const original = faulting.register({
      id: "mcp",
      name: "MCP servers and tools",
      risk: "EXTERNAL",
      provider: "kai",
      availability: "UNAVAILABLE",
      actions: [{ id: "call", risk: "EXTERNAL" }],
      health: async () => ({ availability: "UNAVAILABLE", detail: "declared, not measured" }),
    });
    assert.equal(original.ok, true);

    const installed = installMcpCapability(faulting, manager);
    assert.equal(installed.ok, false, "the replacement failed, and that is reported");
    if (installed.ok) return;

    // The restore ran: the capability is still there, with its identity intact.
    const restored = faulting.get("mcp");
    assert.ok(restored !== undefined, "a failed replacement must not leave KAI with no mcp capability");
    assert.equal(restored.name, "MCP servers and tools");
    assert.equal(restored.risk, "EXTERNAL");
    assert.deepEqual(restored.supportedActions, ["call"]);

    await manager.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// ── dispatchMcpCapability: the runtime branch body ───────────────────────────

test("capability: dispatch runs a discovered tool on a live connection and records source capability.mcp", async (t) => {
  const { manager } = await connectedFixture(t);

  // The plain shape the runtime branch receives.
  const direct = await dispatchMcpCapability(manager, "call", {
    server: "fixture",
    tool: "echo",
    arguments: { text: "dispatched" },
  });
  assert.equal(toolText(direct), "dispatched");

  // The nested `{ input: {...} }` shape the other capability branches use.
  const nested = await dispatchMcpCapability(manager, "call", {
    input: { server: "fixture", tool: "echo", arguments: { text: "nested" } },
  });
  assert.equal(toolText(nested), "nested");

  // No action means "call" (the capability's only action).
  const defaulted = await dispatchMcpCapability(manager, undefined, {
    server: "fixture",
    tool: "echo",
    arguments: { text: "defaulted" },
  });
  assert.equal(toolText(defaulted), "defaulted");

  // Every dispatch is on the provenance ledger, labelled as the capability.
  const records = manager.provenance();
  assert.equal(records.length, 3);
  for (const record of records) {
    assert.equal(record.source, "capability.mcp");
    assert.equal(record.toolId, "mcp.fixture.echo");
    assert.equal(record.status, "EXECUTED");
  }
});

test("capability: dispatch refuses a DESTRUCTIVE tool — an EXTERNAL gate is never spent on it — and refuses bad requests", async (t) => {
  const dir = tempDir(t);
  const noteFile = join(dir, "notes.txt");
  const { registry } = policyRegistry();
  const manager = createMcpManager({ tools: registry });
  t.after(() => manager.dispose());

  manager.registerServer("fixture", fixtureEntry({ noteFile, risk: { default: "READ", tools: { write_note: "DESTRUCTIVE" } } }));
  manager.enableServer("fixture");
  assert.equal((await manager.connectServer("fixture")).ok, true);

  await assert.rejects(
    dispatchMcpCapability(manager, "call", { server: "fixture", tool: "write_note", arguments: { note: "x" } }),
    /DESTRUCTIVE/,
  );
  assert.equal(existsSync(noteFile), false, "a refused DESTRUCTIVE dispatch must not reach the server");
  assert.equal(manager.provenance()[0]?.status, "DENIED");

  await assert.rejects(dispatchMcpCapability(manager, "frobnicate", {}), /no handler for action/);
  await assert.rejects(dispatchMcpCapability(manager, "call", { server: "", tool: "echo" }), /needs \{server, tool/);
  await assert.rejects(dispatchMcpCapability(manager, "call", {}), /needs \{server, tool/);
});
