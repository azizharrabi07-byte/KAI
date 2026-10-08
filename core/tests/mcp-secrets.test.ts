// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Secret REFERENCES and tool-name COLLISION — the two migration invariants.
 *
 * WHAT THIS FILE PROVES
 * ---------------------
 *   1. A stored secret may be a REFERENCE (`env:`/`credman:`) that is INERT at
 *      rest: the persisted catalogue holds the reference, never the value.
 *   2. Resolution is FAIL-CLOSED: an unset environment variable refuses the
 *      launch with `AGENT_AUTH_FAILED` and NO partial credential set — it never
 *      becomes an empty string or a silent unauthenticated start.
 *   3. A malformed reference (`env:` with no name) is refused at registration.
 *   4. The env reference is resolved for real: the value genuinely reaches the
 *      spawned child's environment, proven through the fixture's `read_env`
 *      tool (the stdio form of "authentication arrived").
 *   5. Two servers that expose the SAME tool name do not collide: KAI namespaces
 *      them `mcp.<server>.<tool>` and both stay independently callable.
 *   6. A disconnect leaves a STALE-FREE status and a reconnect restores tools.
 *
 * The MCP peer is KAI's own fixture (src/mcp/servers/echo-mcp-server.mjs),
 * spawned for real over stdio. The tool registry, policy engine and approval
 * service are the REAL ones. No third-party server, no mocks on the MCP side.
 *
 * Run from `core/`:  node --test tests/mcp-secrets.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createMcpManager } from "../src/mcp/manager.ts";
import { createMcpRegistry } from "../src/mcp/registry.ts";
import { validateSecretValue } from "../src/mcp/validation.ts";
import {
  parseSecretReference,
  resolveStoredSecret,
  type SecretResolver,
} from "../src/mcp/secrets.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import { createPolicyEngine } from "../src/policies/gate.ts";
import { createApprovalService } from "../src/approvals/service.ts";

const SERVER = fileURLToPath(new URL("../src/mcp/servers/echo-mcp-server.mjs", import.meta.url));

/** A non-secret sentinel: safe to appear in a test, proves the wiring, leaks nothing. */
const SENTINEL = "sentinel-not-a-real-secret";

/** An injected resolver so nothing here touches the host environment or CredMan. */
function resolver(env: Record<string, string>, credman: Record<string, string> = {}): SecretResolver {
  return {
    env: (name) => env[name],
    credman: (target) => (target in credman ? credman[target] : null),
  };
}

function policyRegistry() {
  const rows: Array<Record<string, unknown>> = [];
  const store = {
    createApproval: (a: Record<string, unknown>) => void rows.push({ ...a }),
    getApproval: (id: string) => rows.find((r) => r.id === id) ?? null,
    listApprovals: () => rows.map((r) => ({ ...r })),
    decideApproval: (id: string, status: string, at: string) => {
      const row = rows.find((r) => r.id === id);
      if (row) {
        row.status = status;
        row.decidedAt = at;
      }
    },
  };
  let seq = 0;
  const approvals = createApprovalService({ store, idFactory: () => `apr-${++seq}`, defaultTtlMs: 60_000 });
  const policy = createPolicyEngine();
  return createToolRegistry({ policy, approvals });
}

function tempDir(t: { after(fn: () => void | Promise<void>): void }) {
  const dir = mkdtempSync(join(tmpdir(), "kai-mcp-secrets-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

/** The fixture as a stdio entry, optionally exposing one env var to `read_env`. */
function fixtureEntry(noteFile: string, env?: Record<string, string>, exposeEnv?: string) {
  const args = [SERVER, `--note-file=${noteFile}`];
  if (exposeEnv !== undefined) args.push(`--expose-env=${exposeEnv}`);
  const entry: Record<string, unknown> = {
    command: process.execPath,
    args,
    risk: { default: "WRITE", tools: { echo: "READ", read_env: "READ", write_note: "WRITE" } },
  };
  if (env !== undefined) entry.env = env;
  return entry;
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

// ── 1. Reference parsing / resolution (pure) ─────────────────────────────────

test("secrets: a bare string is a literal; prefixes name a location", () => {
  assert.deepEqual(parseSecretReference("sk-live-abc"), { kind: "literal" });
  assert.deepEqual(parseSecretReference("env:DISCORD_TOKEN"), { kind: "env", name: "DISCORD_TOKEN" });
  assert.deepEqual(parseSecretReference("credman:kai-host-token.com.aziz.kai"), {
    kind: "credman",
    name: "kai-host-token.com.aziz.kai",
  });
});

test("secrets: resolution fails closed — missing env/CredMan is MISSING, never empty", () => {
  const r = resolver({ PRESENT_VAR: "value-ok" });
  assert.deepEqual(resolveStoredSecret("lit", r), { ok: true, status: "PRESENT", value: "lit" });
  assert.deepEqual(resolveStoredSecret("env:PRESENT_VAR", r), { ok: true, status: "PRESENT", value: "value-ok" });
  const missingEnv = resolveStoredSecret("env:ABSENT_VAR", r);
  assert.equal(missingEnv.ok, false);
  assert.equal(missingEnv.ok === false ? missingEnv.status : "", "MISSING");
  // The reason names the KEY, never a value.
  assert.match(missingEnv.ok === false ? missingEnv.reason : "", /ABSENT_VAR/);
  const missingCred = resolveStoredSecret("credman:nope", r);
  assert.equal(missingCred.ok, false);
  assert.equal(missingCred.ok === false ? missingCred.status : "", "MISSING");
});

test("secrets: a malformed reference is refused at registration", () => {
  // `env:` with no name would silently never resolve; it must not be stored.
  const bad = validateSecretValue("DISCORD_TOKEN", "env:");
  assert.equal(bad.ok, false);
  // A literal that merely resembles nothing reserved is accepted unchanged.
  assert.equal(validateSecretValue("DISCORD_TOKEN", "plain-token").ok, true);
  assert.equal(validateSecretValue("DISCORD_TOKEN", "env:REAL_NAME").ok, true);
});

// ── 2. registry: credentialsFor resolves, fails closed, reports redacted ─────

test("registry: credentialsFor resolves an env reference and refuses when unset", () => {
  const reg = createMcpRegistry({ secretResolver: resolver({ GOOD: "secret-here" }) });
  assert.equal(reg.register("alpha", { command: "node", args: [], env: { TOKEN: "env:GOOD" } }).ok, true);
  const ok = reg.credentialsFor("alpha");
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.ok ? ok.value : {}, { env: { TOKEN: "secret-here" } });

  assert.equal(reg.register("beta", { command: "node", args: [], env: { TOKEN: "env:UNSET" } }).ok, true);
  const denied = reg.credentialsFor("beta");
  assert.equal(denied.ok, false);
  assert.equal(denied.ok === false ? denied.error.code : "", "AGENT_AUTH_FAILED");
  // No value anywhere in the refusal.
  const text = JSON.stringify(denied);
  assert.equal(text.includes("secret-here"), false);
});

test("registry: credentialReport is redacted (names + status only, no values)", () => {
  const reg = createMcpRegistry({ secretResolver: resolver({ P: "value-x" }) });
  reg.register("alpha", { command: "node", args: [], env: { TOKEN: "env:P", OTHER: "env:U" } });
  const report = reg.credentialReport("alpha");
  assert.equal(report.ok, true);
  const value = report.ok ? report.value : { keys: [], required: false };
  assert.equal(value.required, true);
  const byKey = Object.fromEntries(value.keys.map((k) => [k.key, k]));
  assert.deepEqual(byKey.TOKEN, { key: "TOKEN", kind: "env", target: "P", status: "PRESENT" });
  assert.deepEqual(byKey.OTHER, { key: "OTHER", kind: "env", target: "U", status: "MISSING" });
  // The route/view that carries this is safe to archive: no value appears.
  assert.equal(JSON.stringify(report).includes("value-x"), false);
});

// ── 3. persistence holds the REFERENCE, never the value ──────────────────────

test("manager: the persisted catalogue stores the env reference, not the secret", (t) => {
  const dir = tempDir(t);
  const path = join(dir, "servers.json");
  const manager = createMcpManager({
    tools: policyRegistry(),
    persistPath: path,
    secretResolver: resolver({ DISCORD_TOKEN: SENTINEL }),
  });
  assert.equal(
    manager.registerServer("discord", { command: "node", args: [], env: { DISCORD_TOKEN: "env:DISCORD_TOKEN" }, risk: { default: "WRITE" } }).ok,
    true,
  );
  const persisted = readFileSync(path, "utf8");
  assert.match(persisted, /env:DISCORD_TOKEN/);
  assert.equal(persisted.includes(SENTINEL), false, "the secret value must not be on disk");
});

// ── 4. env reference resolved for real through a spawned child ───────────────

test("manager: an env reference reaches the spawned server's environment", async (t) => {
  const dir = tempDir(t);
  const noteFile = join(dir, "notes.txt");
  const manager = createMcpManager({
    tools: policyRegistry(),
    secretResolver: resolver({ KAITEST_SENTINEL: SENTINEL }),
  });
  manager.registerServer(
    "fixture",
    fixtureEntry(noteFile, { KAITEST_SENTINEL: "env:KAITEST_SENTINEL" }, "KAITEST_SENTINEL"),
  );
  manager.enableServer("fixture");
  const connected = await manager.connectServer("fixture");
  t.after(async () => manager.dispose());
  assert.equal(connected.ok, true, JSON.stringify(connected));

  const invoked = await manager.invokeTool({
    server: "fixture",
    tool: "read_env",
    arguments: { name: "KAITEST_SENTINEL" },
  });
  assert.equal(invoked.ok, true, JSON.stringify(invoked));
  // The child read the value KAI resolved from the reference — proof the
  // credential actually arrived (stdio's form of authentication).
  assert.equal(toolText(invoked.ok ? invoked.value.result : undefined), SENTINEL);
});

test("manager: a missing env reference refuses the connection (AUTH_FAILED), not an empty env", async (t) => {
  const dir = tempDir(t);
  const manager = createMcpManager({
    tools: policyRegistry(),
    secretResolver: resolver({}), // NOTHING set
  });
  manager.registerServer("fixture", fixtureEntry(join(dir, "notes.txt"), { TOKEN: "env:ABSENT" }, "ABSENT"));
  manager.enableServer("fixture");
  const connected = await manager.connectServer("fixture");
  t.after(async () => manager.dispose());
  assert.equal(connected.ok, false);
  assert.equal(connected.ok === false ? connected.error.code : "", "AGENT_AUTH_FAILED");
  assert.equal(manager.serverView("fixture")?.connected, false);
});

// ── 5. collision: same tool name on two servers stays namespaced ─────────────

test("manager: two servers exposing the same tool name do not collide", async (t) => {
  const dir = tempDir(t);
  const manager = createMcpManager({ tools: policyRegistry(), secretResolver: resolver({}) });
  manager.registerServer("alpha", fixtureEntry(join(dir, "a.txt")));
  manager.registerServer("beta", fixtureEntry(join(dir, "b.txt")));
  manager.enableServer("alpha");
  manager.enableServer("beta");
  const a = await manager.connectServer("alpha");
  const b = await manager.connectServer("beta");
  t.after(async () => manager.dispose());
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(b.ok, true, JSON.stringify(b));

  // Both `echo` tools registered, under distinct namespaced ids — neither clobbered.
  assert.ok(manager.registeredToolIds("alpha").includes("mcp.alpha.echo"));
  assert.ok(manager.registeredToolIds("beta").includes("mcp.beta.echo"));

  const callA = await manager.invokeTool({ server: "alpha", tool: "echo", arguments: { text: "A" } });
  const callB = await manager.invokeTool({ server: "beta", tool: "echo", arguments: { text: "B" } });
  assert.equal(toolText(callA.ok ? callA.value.result : undefined), "A");
  assert.equal(toolText(callB.ok ? callB.value.result : undefined), "B");
});

// ── 6. disconnect/reconnect without a stale status ───────────────────────────

test("manager: disconnect clears CONNECTED and reconnect restores tools", async (t) => {
  const dir = tempDir(t);
  const manager = createMcpManager({ tools: policyRegistry(), secretResolver: resolver({}) });
  manager.registerServer("fixture", fixtureEntry(join(dir, "notes.txt")));
  manager.enableServer("fixture");
  t.after(async () => manager.dispose());

  assert.equal((await manager.connectServer("fixture")).ok, true);
  assert.equal(manager.serverView("fixture")?.connected, true);

  assert.equal((await manager.disconnectServer("fixture")).ok, true);
  // No stale CONNECTED: the view reflects the disconnect immediately.
  assert.equal(manager.serverView("fixture")?.connected, false);

  const again = await manager.connectServer("fixture");
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(manager.serverView("fixture")?.connected, true);
  assert.ok(manager.registeredToolIds("fixture").includes("mcp.fixture.echo"));
});
