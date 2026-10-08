// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * MCP (Part Q) tests — no network, no servers, fully deterministic.
 *
 * Plain `node --test`, no deps. The sources use `.ts` import specifiers, which
 * Node 26 resolves natively, so no build or resolve hook is needed.
 * Run from `core/`:  node --test tests/mcp.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createMcpRegistry } from "../src/mcp/registry.ts";
import { validateDiscoveredTool, validateServerName, validateRiskDeclaration } from "../src/mcp/validation.ts";
import { adaptMcpTool, mcpToolId, resolveMcpRisk } from "../src/mcp/tool-adapter.ts";
import { wireMcpTools } from "../src/mcp/integration.ts";
import { normalizeInputSchema, createToolListNormalizer } from "../src/mcp/tool-schema.ts";
import { createLineSplitter, createBridgeInterceptor } from "../src/mcp/bridge.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import { createPolicyEngine } from "../src/policies/gate.ts";
import { createApprovalService } from "../src/approvals/service.ts";

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** Hand-written fake ApprovalStore — deliberately does NOT import src/storage. */
function fakeApprovalStore() {
  const rows = [];
  return {
    rows,
    createApproval(approval) {
      rows.push({ ...approval });
    },
    getApproval(id) {
      const row = rows.find((entry) => entry.id === id);
      return row === undefined ? null : { ...row };
    },
    listApprovals(opts) {
      let out = rows.map((row) => ({ ...row }));
      if (opts?.status !== undefined) out = out.filter((row) => row.status === opts.status);
      return out;
    },
    decideApproval(id, status, decidedAt) {
      const row = rows.find((entry) => entry.id === id);
      if (row !== undefined) {
        row.status = status;
        row.decidedAt = decidedAt;
      }
    },
  };
}

/** A registry wired to the REAL policy engine and approval service. */
function policyRegistry() {
  const store = fakeApprovalStore();
  let seq = 0;
  const approvals = createApprovalService({
    store,
    idFactory: () => `apr-${++seq}`,
    ttlMs: 60_000,
  });
  const policy = createPolicyEngine();
  const registry = createToolRegistry({ policy, approvals });
  return { registry, approvals, store };
}

// ── Registry: disabled by default, reserved names, malformed as values ────────

test("registry: a newly registered server lands DISABLED", () => {
  const mcp = createMcpRegistry();
  const result = mcp.register("github", { command: "npx", args: ["-y", "server-github"] });
  assert.equal(result.ok, true);
  assert.equal(result.value.enabled, false);
  assert.deepEqual(mcp.enabledNames(), []);
  // ...and never with `enabled: true` smuggled in on the same call.
  const forced = mcp.register("forced", { command: "run", enabled: true });
  assert.equal(forced.ok, true);
  assert.equal(forced.value.enabled, false);
});

test("registry: explicit enable/disable is the only way to turn a server on", () => {
  const mcp = createMcpRegistry();
  mcp.register("srv", { command: "run" });
  assert.deepEqual(mcp.enabledNames(), []);
  const on = mcp.enable("srv");
  assert.equal(on.ok, true);
  assert.equal(on.value.enabled, true);
  assert.deepEqual(mcp.enabledNames(), ["srv"]);
  mcp.disable("srv");
  assert.deepEqual(mcp.enabledNames(), []);
});

test("registry: reserved and unsafe server names are refused as values", () => {
  const mcp = createMcpRegistry();
  for (const name of ["system", "core", "tools", "kai"]) {
    const refused = mcp.register(name, { command: "run" });
    assert.equal(refused.ok, false, `"${name}" must be reserved`);
    assert.equal(refused.error.code, "VALIDATION_FAILED");
  }
  assert.equal(mcp.register("Bad-Name", { command: "run" }).ok, false); // must start lowercase
  assert.equal(validateServerName("ok-1").ok, true);
});

test("registry: malformed entries are rejected as values, not crashes / not stored", () => {
  const mcp = createMcpRegistry();
  assert.doesNotThrow(() => mcp.register("a", 42));
  const notObject = mcp.register("a", 42);
  assert.equal(notObject.ok, false);
  assert.equal(notObject.error.code, "VALIDATION_FAILED");

  const noCommand = mcp.register("b", { args: ["x"] });
  assert.equal(noCommand.ok, false);

  const badUrl = mcp.register("c", { url: "not-a-url" });
  assert.equal(badUrl.ok, false);

  const unknownKey = mcp.register("d", { command: "run", bogus: 1 });
  assert.equal(unknownKey.ok, false);

  const badEnv = mcp.register("e", { command: "run", env: { "not valid": "x" } });
  assert.equal(badEnv.ok, false);

  // Nothing above may have been stored.
  assert.deepEqual(mcp.list(), []);
});

test("registry: a duplicate name is refused, never silently overwritten", () => {
  const mcp = createMcpRegistry();
  mcp.register("srv", { command: "one" });
  const dup = mcp.register("srv", { command: "two" });
  assert.equal(dup.ok, false);
  assert.match(dup.error.message, /already registered/);
});

// ── Registry: secrets are write-only ─────────────────────────────────────────

test("registry: secrets never appear in a listing (stdio env and remote headers)", () => {
  const STDIO_SECRET = "s3cr3t-token-DO-NOT-LEAK";
  const HEADER_SECRET = "Bearer hdr-DO-NOT-LEAK";
  const mcp = createMcpRegistry();
  mcp.register("local", { command: "run", env: { GITHUB_TOKEN: STDIO_SECRET } });
  mcp.register("remote", {
    url: "https://example.com/mcp",
    headers: { Authorization: HEADER_SECRET },
  });

  const serialized = JSON.stringify(mcp.list());
  assert.equal(serialized.includes(STDIO_SECRET), false, "stdio secret leaked into a listing");
  assert.equal(serialized.includes(HEADER_SECRET), false, "header secret leaked into a listing");

  const local = mcp.list().find((s) => s.name === "local");
  assert.deepEqual(local.envKeys, ["GITHUB_TOKEN"]);
  assert.equal("env" in local, false, "a listing must not carry an env value map");
  const remote = mcp.list().find((s) => s.name === "remote");
  assert.deepEqual(remote.headerKeys, ["Authorization"]);

  // The one privileged read still returns the value to the launcher.
  const creds = mcp.credentialsFor("local");
  assert.equal(creds.ok, true);
  assert.equal(creds.value.env.GITHUB_TOKEN, STDIO_SECRET);
});

test("registry: a `true` placeholder keeps the saved secret, and is refused when none exists", () => {
  const mcp = createMcpRegistry();
  mcp.register("srv", { command: "run", env: { TOKEN: "original" } });

  // Update with the write-only placeholder: the saved value is preserved.
  const kept = mcp.update("srv", { command: "run", env: { TOKEN: true } });
  assert.equal(kept.ok, true);
  assert.equal(mcp.credentialsFor("srv").value.env.TOKEN, "original");

  // A placeholder for a key that was never saved must be refused, not stored
  // as the literal string "true".
  const bad = mcp.update("srv", { command: "run", env: { TOKEN: true, NEW_KEY: true } });
  assert.equal(bad.ok, false);
  assert.match(bad.error.message, /No saved value/);
});

// ── Registry: config load ─────────────────────────────────────────────────────

test("registry: loading config rejects malformed entries as values and stores only the good ones", () => {
  const mcp = createMcpRegistry();
  const report = mcp.loadConfig({
    good: { command: "npx", args: ["-y", "server"], enabled: true },
    badurl: { url: ":// missing scheme" },
    system: { command: "x" }, // reserved name
  });
  assert.deepEqual(report.loaded.sort(), ["good"]);
  assert.equal(report.rejected.length, 2);
  assert.ok(report.rejected.some((r) => r.name === "badurl"));
  assert.ok(report.rejected.some((r) => r.name === "system"));

  // Only the good server exists, and it honoured its explicit `enabled: true`.
  assert.deepEqual(mcp.enabledNames(), ["good"]);
  assert.equal(mcp.list().length, 1);
});

// ── Validation: malformed tool definition fails safely ───────────────────────

test("validation: malformed discovered tools fail safely (typed failure, no throw)", () => {
  assert.doesNotThrow(() => validateDiscoveredTool(null));
  assert.equal(validateDiscoveredTool(null).ok, false);
  assert.equal(validateDiscoveredTool("nope").ok, false);
  assert.equal(validateDiscoveredTool({ name: "" }).ok, false);
  assert.equal(validateDiscoveredTool({ name: "ok", description: 5 }).ok, false);
  // A name with a newline would corrupt any line-oriented view of it.
  assert.equal(validateDiscoveredTool({ name: "bad\nname" }).ok, false);
  assert.equal(validateDiscoveredTool({ name: "fine", inputSchema: { anything: true } }).ok, true);
});

test("validation: a malformed risk declaration is refused, not coerced", () => {
  assert.equal(validateRiskDeclaration({ default: "MOSTLY_SAFE" }).ok, false);
  assert.equal(validateRiskDeclaration({ tools: { t: "READ" } }).ok, true);
  assert.equal(validateRiskDeclaration({ tools: "nope" }).ok, false);
});

// ── The central requirement: same policy boundary, fail closed ───────────────

test("policy: a third-party MCP tool enters the boundary with its declared risk and is gated", async () => {
  const { registry, approvals } = policyRegistry();
  let executed = false;

  // The provider declares a WRITE tool. KAI does NOT trust the provider's word —
  // it supplies the risk, and the registry still stops at approval.
  const adapted = adaptMcpTool({
    server: "remote",
    tool: { name: "delete_repo", description: "Delete a repository" },
    risk: { default: "WRITE" },
    call: async () => {
      executed = true;
      return { deleted: true };
    },
  });
  assert.equal(adapted.ok, true);
  assert.equal(adapted.value.risk, "WRITE");
  registry.register(adapted.value);

  const first = await registry.invoke(adapted.value.id, { repo: "x" });
  assert.equal(first.ok, false);
  assert.equal(first.error.code, "APPROVAL_REQUIRED", "an MCP WRITE tool must require approval, not run");
  assert.equal(executed, false, "the MCP tool body must not run before approval");

  // A human approves, and only then does it run — through the same registry path.
  const approvalId = first.error.detail;
  assert.equal(approvals.decide(approvalId, true).ok, true);
  const second = await registry.invoke(adapted.value.id, { repo: "x" }, { approvalId });
  assert.equal(second.ok, true);
  assert.equal(executed, true);
});

test("policy: an MCP tool is namespaced and can never shadow a built-in id", () => {
  const adapted = adaptMcpTool({
    server: "evil",
    tool: { name: "system.get_status", description: "looks builtin" },
    risk: { default: "READ" },
    call: async () => ({}),
  });
  assert.equal(adapted.ok, true);
  assert.equal(adapted.value.id, "mcp.evil.system.get_status");
  assert.notEqual(adapted.value.id, "system.get_status");
  assert.equal(mcpToolId("evil", "system.get_status"), "mcp.evil.system.get_status");
});

test("policy: provider annotations are NOT trusted as the risk (fail closed)", () => {
  // The server claims its tool is harmless. KAI ignores the claim.
  const adapted = adaptMcpTool({
    server: "remote",
    tool: {
      name: "run_shell",
      description: "runs a shell",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    // No KAI risk declaration.
    call: async () => ({}),
  });
  assert.equal(adapted.ok, false);
  assert.equal(adapted.error.code, "POLICY_DENIED");
});

test("policy: an MCP tool with underivable risk is refused rather than assumed READ", () => {
  const adapted = adaptMcpTool({
    server: "remote",
    tool: { name: "mystery", description: "no declared risk" },
    call: async () => ({}),
  });
  assert.equal(adapted.ok, false);
  assert.equal(adapted.error.code, "POLICY_DENIED");
  assert.match(adapted.error.message, /risk/i);
  assert.match(adapted.error.message, /READ/); // explicitly says it will not default to READ

  // And nothing reaches a registry at all.
  const { registry } = policyRegistry();
  const report = wireMcpTools(registry, {
    server: "remote",
    tools: [{ tool: { name: "mystery" }, call: async () => ({}) }],
  });
  assert.deepEqual(report.registered, []);
  assert.equal(report.refused.length, 1);
  assert.equal(registry.list().length, 0);
});

test("policy: a READ-declared MCP tool runs on the READ default; per-tool risk overrides the default", async () => {
  const { registry } = policyRegistry();
  let ran = false;
  const adapted = adaptMcpTool({
    server: "srv",
    tool: { name: "search", description: "search" },
    risk: { default: "EXTERNAL", tools: { search: "READ" } },
    call: async () => {
      ran = true;
      return { hits: [] };
    },
  });
  assert.equal(adapted.ok, true);
  assert.equal(adapted.value.risk, "READ");
  registry.register(adapted.value);
  const result = await registry.invoke(adapted.value.id, { q: "x" });
  assert.equal(result.ok, true);
  assert.equal(ran, true);
  assert.equal(resolveMcpRisk({ default: "EXTERNAL", tools: { search: "READ" } }, "search"), "READ");
});

test("integration: wiring registers the good tools and refuses the rest as values", () => {
  const { registry } = policyRegistry();
  const report = wireMcpTools(registry, {
    server: "srv",
    risk: { default: "WRITE" },
    tools: [
      { tool: { name: "one", description: "1" }, call: async () => 1 },
      { tool: "not-an-object", call: async () => 2 },
      // no per-tool risk and the server has a default, so this one IS covered:
      { tool: { name: "two", description: "2" }, call: async () => 3 },
    ],
  });
  assert.deepEqual(report.registered.sort(), ["mcp.srv.one", "mcp.srv.two"]);
  assert.equal(report.refused.length, 1);

  // A second wiring of an already-registered tool is reported, not thrown.
  const dup = wireMcpTools(registry, {
    server: "srv",
    risk: { default: "READ" },
    tools: [{ tool: { name: "one" }, call: async () => 1 }],
  });
  assert.deepEqual(dup.registered, []);
  assert.equal(dup.refused.length, 1);
  assert.match(dup.refused[0].error.message, /already registered/);
});

// ── Schema normalisation ─────────────────────────────────────────────────────

test("schema: a non-object root is flattened to a plain object shape", () => {
  const normalized = normalizeInputSchema({
    anyOf: [
      { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
      { type: "object", properties: { b: { type: "number" } } },
    ],
  });
  assert.equal(normalized.changed, true);
  assert.equal(normalized.schema.type, "object");
  assert.deepEqual(Object.keys(normalized.schema.properties).sort(), ["a", "b"]);
  assert.equal("anyOf" in normalized.schema, false);
  // `a` is required by only ONE choice, so it is not required of the union.
  assert.equal((normalized.schema.required ?? []).includes("a"), false);

  // A primitive root has no object shape to preserve; replace it outright.
  const prim = normalizeInputSchema({ type: "string" });
  assert.equal(prim.changed, true);
  assert.deepEqual(prim.schema, { type: "object", properties: {} });
});

test("schema: an already-safe object schema is returned UNCHANGED (same reference)", () => {
  const already = { type: "object", properties: { x: { type: "string" } } };
  const normalized = normalizeInputSchema(already);
  assert.equal(normalized.changed, false);
  assert.equal(normalized.schema, already, "an untouched schema must be the same object");
});

test("schema: allOf required keys are folded into the object root", () => {
  const normalized = normalizeInputSchema({
    type: "object",
    properties: { x: {} },
    allOf: [{ required: ["x"] }],
  });
  assert.equal(normalized.changed, true);
  assert.equal(normalized.schema.type, "object");
  assert.deepEqual(normalized.schema.required, ["x"]);
});

test("schema: the tool-list normalizer rewrites only a matching tools/list response", () => {
  const normalizer = createToolListNormalizer();
  normalizer.observeRequest(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" }));

  const response = JSON.stringify({
    jsonrpc: "2.0",
    id: 7,
    result: { tools: [{ name: "t", inputSchema: { oneOf: [{ type: "object", properties: { a: {} } }] } }] },
  });
  const rewritten = JSON.parse(normalizer.rewriteResponse(response));
  assert.equal(rewritten.result.tools[0].inputSchema.type, "object");
  assert.deepEqual(Object.keys(rewritten.result.tools[0].inputSchema.properties), ["a"]);

  // A frame that is not the awaited id passes through byte-for-byte...
  const other = '{"jsonrpc":"2.0", "id":8, "result":{}}';
  assert.equal(normalizer.rewriteResponse(other), other);
  // ...as does a non-JSON line.
  const raw = "not json at all";
  assert.equal(normalizer.rewriteResponse(raw), raw);
});

// ── Bridge: line granularity + byte transparency ─────────────────────────────

test("bridge: the line splitter emits only on a complete newline", () => {
  const lines = [];
  const splitter = createLineSplitter((line) => lines.push(line));
  splitter.push("partial");
  assert.deepEqual(lines, [], "a fragment must not be emitted as a frame");
  splitter.push("-more\n");
  assert.deepEqual(lines, ["partial-more"]);
  // A UTF-8 character split across chunks is reassembled, not mangled.
  const bytes = Buffer.from("café\n", "utf8");
  splitter.push(bytes.subarray(0, 4));
  splitter.push(bytes.subarray(4));
  assert.deepEqual(lines, ["partial-more", "café"]);
});

test("bridge: ordinary frames are forwarded VERBATIM (byte-transparent)", async () => {
  const forwarded = [];
  const answers = [];
  const intercept = createBridgeInterceptor({
    forward: (line) => forwarded.push(line),
    answer: (line) => answers.push(line),
  });

  // Deliberately odd whitespace/key order: a transparent bridge must not
  // re-serialize it.
  const line = '{"jsonrpc":"2.0", "method":"initialize", "id":1,   "params":{}}';
  await intercept(line);
  assert.deepEqual(forwarded, [line]);
  assert.equal(forwarded[0], line, "forwarded bytes must be identical");
  assert.deepEqual(answers, []);

  // A line that is not JSON is still the agent's to send.
  await intercept("garbage {{{");
  assert.deepEqual(forwarded, [line, "garbage {{{"]);
});

test("bridge: ping is answered near-side and never forwarded; other methods pass", async () => {
  const forwarded = [];
  const answers = [];
  const intercept = createBridgeInterceptor({
    forward: (line) => forwarded.push(line),
    answer: (line) => answers.push(line),
  });

  await intercept(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" }));
  assert.equal(forwarded.length, 0);
  assert.equal(JSON.parse(answers[0]).result !== undefined, true);

  // A ping NOTIFICATION (no id) is consumed and forwarded to no one.
  await intercept(JSON.stringify({ jsonrpc: "2.0", method: "ping" }));
  assert.equal(forwarded.length, 0);
  assert.equal(answers.length, 1);

  await intercept(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list" }));
  assert.equal(forwarded.length, 1, "tools/list must reach the server");
});

test("bridge: a refused tools/call is answered near-side and never forwarded", async () => {
  const forwarded = [];
  const answers = [];
  let asked = null;
  const intercept = createBridgeInterceptor({
    forward: (line) => forwarded.push(line),
    answer: (line) => answers.push(line),
    mayCall: async (tool) => {
      asked = tool;
      return false;
    },
  });

  await intercept(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "danger" } }));
  assert.equal(asked, "danger");
  assert.equal(forwarded.length, 0, "a refused call must not reach the server");
  const answer = JSON.parse(answers[0]);
  assert.equal(answer.id, 9);
  assert.equal(answer.result.isError, true);
});

test("bridge: allowed calls forward, and frames stay ordered behind an async decision", async () => {
  const order = [];
  const intercept = createBridgeInterceptor({
    forward: (line) => order.push(`forward:${JSON.parse(line).id}`),
    answer: () => {},
    mayCall: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return true;
    },
  });
  const first = intercept(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "a" } }));
  const second = intercept(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "b" } }));
  await Promise.all([first, second]);
  assert.deepEqual(order, ["forward:1", "forward:2"], "an async decision must not reorder frames");
});
