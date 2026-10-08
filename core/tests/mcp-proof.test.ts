// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * P6 — MCP over the real echo server, on KAI's ONE tool plane.
 *
 * register -> enable -> connect -> list -> invoke `echo` THROUGH
 * registry.invoke (validate -> policy -> execute, the same boundary every
 * builtin passes) -> read a resource -> provenance records both -> disconnect.
 * Plus catalogue persistence across manager reopens. No fixtures beyond KAI's
 * own echo server, which is a real MCP peer over real stdio.
 *
 * Run from `core/`:  node --test tests/mcp-proof.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createToolRegistry } from "../src/tools/registry.ts";
import { createPolicyEngine } from "../src/policies/gate.ts";
import { createApprovalService } from "../src/approvals/service.ts";
import { createMcpManager } from "../src/mcp/manager.ts";
import type { Approval, ApprovalStatus, ApprovalStore } from "../src/shared/contracts.ts";

const SERVER = fileURLToPath(new URL("../src/mcp/servers/echo-mcp-server.mjs", import.meta.url));

function tempDir(t: { after: (fn: () => void | Promise<void>) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), "kai-mcp-proof-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

function fakeApprovalStore(): ApprovalStore {
  const rows: Approval[] = [];
  return {
    createApproval: (approval: Approval): void => {
      rows.push({ ...approval });
    },
    getApproval: (id: string): Approval | null => rows.find((entry) => entry.id === id) ?? null,
    listApprovals: (opts?: { status?: ApprovalStatus; limit?: number }): Approval[] => {
      let out = [...rows];
      if (opts?.status !== undefined) out = out.filter((row) => row.status === opts.status);
      if (opts?.limit !== undefined) out = out.slice(0, opts.limit);
      return out;
    },
    decideApproval: (id: string, status: ApprovalStatus, decidedAt: string): void => {
      const row = rows.find((entry) => entry.id === id);
      if (row !== undefined) {
        row.status = status;
        row.decidedAt = decidedAt;
      }
    },
  };
}

function registryWithPolicy() {
  let seq = 0;
  const approvals = createApprovalService({
    store: fakeApprovalStore(),
    idFactory: () => `apr-${++seq}`,
    defaultTtlMs: 60_000,
  });
  const registry = createToolRegistry({ policy: createPolicyEngine(), approvals, coreBuildId: "mcp-proof" });
  return { registry, approvals };
}

function echoEntry(noteFile: string): Record<string, unknown> {
  return {
    command: process.execPath,
    args: [SERVER, `--note-file=${noteFile}`],
    risk: { default: "WRITE", tools: { echo: "READ" } },
  };
}

test("echo server: register -> enable -> connect -> invoke echo through the ONE boundary -> resource read -> provenance", async (t) => {
  const dir = tempDir(t);
  const { registry } = registryWithPolicy();
  const manager = createMcpManager({ tools: registry });
  t.after(() => manager.dispose());

  assert.equal(manager.registerServer("echo", echoEntry(join(dir, "notes.txt"))).ok, true);
  assert.equal(manager.enableServer("echo").ok, true);
  const connected = await manager.connectServer("echo");
  assert.equal(connected.ok, true, JSON.stringify(connected.ok ? {} : connected.error).slice(0, 300));

  const ids = manager.registeredToolIds("echo");
  assert.ok(ids.includes("mcp.echo.echo"), `echo tool adapted: ${ids.join(",")}`);
  const def = registry.get("mcp.echo.echo");
  assert.equal(def?.risk, "READ", "KAI-declared risk, not the server's annotation");

  // Through registry.invoke — validate -> policy -> execute — not a side door.
  const invoked = await registry.invoke("mcp.echo.echo", { text: "hello kai" });
  assert.equal(invoked.ok, true, JSON.stringify(invoked.ok ? {} : invoked.error).slice(0, 300));
  assert.equal(invoked.invocation.status, "EXECUTED");
  assert.ok(JSON.stringify(invoked.result).includes("hello kai"), "the real server answered");

  // Through the manager: same execution, plus the MCP provenance record (the
  // registry's own action.executed covers every path; the ring adds the
  // manager-mediated attempt with its execution id).
  const managed = await manager.invokeTool({ server: "echo", tool: "echo", arguments: { text: "via manager" } });
  assert.equal(managed.ok, true, JSON.stringify(managed.ok ? {} : managed.error).slice(0, 300));

  const resources = await manager.listResources("echo");
  assert.equal(resources.ok, true);
  assert.ok((resources.ok && resources.value.length) > 0, "the fixture advertises resources");
  const uri = (resources.ok && (resources.value[0] as { uri?: string }).uri) ?? "echo://kai/hello";
  const read = await manager.readResource("echo", String(uri));
  assert.equal(read.ok, true, JSON.stringify(read.ok ? {} : read.error).slice(0, 300));
  assert.ok(JSON.stringify(read.value).includes("contents"), "the resource body came back");

  const records = manager.provenance(10);
  const invocation = records.find((record) => record.toolId === "mcp.echo.echo");
  assert.ok(invocation !== undefined && invocation.status === "EXECUTED", "invocation provenance recorded");
  const resourceRecord = records.find((record) => record.tool === "resources/read");
  assert.ok(resourceRecord !== undefined && resourceRecord.status === "EXECUTED", "resource-read provenance recorded");

  assert.equal((await manager.disconnectServer("echo")).ok, true);
});

test("a WRITE-risk MCP tool parks under the default policy", async (t) => {
  const dir = tempDir(t);
  const { registry } = registryWithPolicy();
  const manager = createMcpManager({ tools: registry });
  t.after(() => manager.dispose());

  assert.equal(manager.registerServer("echo", echoEntry(join(dir, "notes.txt"))).ok, true);
  assert.equal(manager.enableServer("echo").ok, true);
  assert.equal((await manager.connectServer("echo")).ok, true);

  // write_note defaults to WRITE: invoking it without an approval parks.
  const parked = await registry.invoke("mcp.echo.write_note", { text: "x" });
  assert.equal(parked.ok, false);
  assert.equal(parked.invocation.status, "APPROVAL_REQUIRED", "MCP WRITE tools park like any other");
});

test("the server catalogue persists across manager reopens", async (t) => {
  const dir = tempDir(t);
  const persistPath = join(dir, "kai-mcp.json");
  const firstTools = registryWithPolicy().registry;
  const first = createMcpManager({ tools: firstTools, persistPath });
  assert.equal(first.registerServer("echo", echoEntry(join(dir, "n.txt"))).ok, true);
  assert.equal(first.enableServer("echo").ok, true);
  await first.dispose();

  const secondTools = registryWithPolicy().registry;
  const second = createMcpManager({ tools: secondTools, persistPath });
  t.after(() => second.dispose());
  const view = second.serverView("echo");
  assert.ok(view !== undefined, "the catalogue rehydrated from disk");
  assert.equal(view.enabled, true);
  assert.equal(view.connected, false, "connections never rehydrate — only the catalogue");
});
