// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * P2 — the command runtime executes real behavior.
 *
 * Every required slash command runs against REAL subsystem doubles (a real
 * session service on a temp DB, the real tool registry + workspace tools, the
 * real skill registry): `/help` lists exactly what is registered, `/tools`
 * reads the actual plane, `/new` creates a real session, `/compress` really
 * shrinks a transcript, and unknown commands are refused values, not throws.
 *
 * Run from `core/`:  node --test tests/commands.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AddressInfo } from "node:net";
import { createSessionStore } from "../src/sessions/store.ts";
import { createSessionService } from "../src/sessions/service.ts";
import { createCoreRuntime } from "../src/runtime.ts";
import { createKaiServer } from "../src/server.ts";
import { loadConfig } from "../src/config.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import { createPolicyEngine } from "../src/policies/gate.ts";
import { createWorkspaceTools } from "../src/tools/workspace.ts";
import { createSkillRegistry } from "../src/skills/registry.ts";
import { createSkillStore } from "../src/skills/store.ts";
import {
  getCommand,
  listCommands,
  parseSlash,
  runCommand,
  splitArgs,
  type CommandRuntime,
} from "../src/commands/commands.ts";

const closersByDir = new Map<string, Array<() => void>>();

function tempDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), "kai-commands-"));
  closersByDir.set(dir, []);
  t.after(() => {
    for (const close of closersByDir.get(dir) ?? []) {
      try {
        close();
      } catch {
        // Already closed is fine.
      }
    }
    closersByDir.delete(dir);
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function contextFor(t: { after: (fn: () => void) => void }): { ctx: CommandRuntime; dir: string } {
  const dir = tempDir(t);
  const store = createSessionStore({ path: join(dir, "sessions.db") });
  closersByDir.get(dir)?.push(() => store.close());
  const sessions = createSessionService({ store });
  const tools = createToolRegistry({ policy: createPolicyEngine(), coreBuildId: "commands-test" });
  for (const tool of createWorkspaceTools()) tools.register(tool);
  const skillStore = createSkillStore({ root: join(dir, "skills") });
  const skills = createSkillRegistry({ store: skillStore });
  const memoryEntries: Array<{ type: string; content: string }> = [];
  const ctx: CommandRuntime = {
    sessions,
    tools,
    skills,
    mcp: {
      summary: () => ({ servers: 0, enabled: 0, connected: 0, tools: 0, resources: 0 }),
      listServers: () => [],
    },
    memory: {
      remember: (input) => {
        const entry = { type: "note", content: String((input as Record<string, unknown>).content ?? "") };
        memoryEntries.push(entry);
        return entry as never;
      },
      search: () => [],
      forget: () => false,
      digest: () => memoryEntries.slice(0, 5) as never,
    },
    memoryEngine: { search: () => [] } as never,
    brain: {
      available: () => true,
      describe: () => ({ provider: "test", model: "test-model", configured: true, tools: true, toolIds: ["filesystem.search"] }),
      respond: () => Promise.reject(new Error("unused")),
      stream: () => (async function* () {})(),
      health: () => Promise.resolve({ ok: true, configured: true, provider: "test", baseUrl: "test", model: "test-model", reason: null }),
    } as never,
    model: {
      capabilities: () => ({ chat: true, stream: true, structured: true, embeddings: true, tools: true, models: [], defaultModel: "test-model" }),
      health: () => Promise.resolve({ ok: true, configured: true, provider: "test", baseUrl: "test", model: "test-model", reason: null }),
    } as never,
    subagents: { list: () => [] } as never,
    workers: () => Promise.resolve([]),
    createPlan: () => Promise.resolve({ ok: false, reason: "no planner in this test context" }),
    providers: {
      list: () => Promise.resolve([
        {
          id: "kai-model",
          label: "KAI model",
          kind: "model",
          baseUrl: "https://test/v1",
          reachable: true,
          authConfigured: true,
          authorized: true,
          current: true,
          models: [{ id: "test-model", current: true }],
        },
        {
          id: "hermes",
          label: "Hermes Agent",
          kind: "worker",
          baseUrl: "http://127.0.0.1:8642",
          reachable: false,
          authConfigured: false,
          authorized: false,
          current: false,
          models: [],
          modelsNote: "worker offline — no catalogue",
          reason: "unreachable",
        },
      ]),
    },
  };
  return { ctx, dir };
}

test("parseSlash parses /name plus quoted args; non-slash text is not a command", () => {
  assert.deepEqual(parseSlash("/new"), { name: "new", args: [] });
  assert.deepEqual(parseSlash('/memory "my query here"'), { name: "memory", args: ["my query here"] });
  assert.deepEqual(parseSlash("/compress --keep 5"), { name: "compress", args: ["--keep", "5"] });
  assert.equal(parseSlash("hello /new"), null);
  assert.equal(parseSlash("/"), null);
  assert.equal(parseSlash(""), null);
  assert.deepEqual(splitArgs(`a "b c" 'd e' f`), ["a", "b c", "d e", "f"]);
});

test("/help lists exactly the registered commands", async (t) => {
  const { ctx } = contextFor(t);
  const listed = listCommands().map((c) => c.id);
  for (const id of ["new", "compress", "models", "providers", "tools", "skills", "agents", "mcp", "memory", "session", "plan", "help"]) {
    assert.ok(listed.includes(id), `/help must include /${id}`);
    assert.ok(getCommand(id) !== undefined);
  }
  const ran = await runCommand("help", [], ctx);
  assert.equal(ran.ok, true);
  if (ran.ok) {
    for (const id of listed) assert.ok(ran.result.text.includes(`/${id}`), `/help text names /${id}`);
  }
});

test("/new creates a real session and activates it; unknown commands are refused", async (t) => {
  const { ctx } = contextFor(t);
  const ran = await runCommand("new", ["My", "Project"], ctx);
  assert.equal(ran.ok, true);
  if (ran.ok) {
    const sessionId = (ran.result.data as { sessionId: string }).sessionId;
    assert.equal(ctx.sessions.get(sessionId)?.title, "My Project", "the session really exists");
    assert.equal(ctx.sessions.active()?.id, sessionId, "and it is active");
  }
  const missing = await runCommand("frobnicate", [], ctx);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.reason, /no command/);
});

test("/tools reads the actual registered plane", async (t) => {
  const { ctx } = contextFor(t);
  const ran = await runCommand("tools", [], ctx);
  assert.equal(ran.ok, true);
  if (ran.ok) {
    assert.ok(ran.result.text.includes("filesystem.search"), "the real workspace tool is listed");
    assert.ok(ran.result.text.includes("READ"), "risk is shown");
    const filtered = await runCommand("tools", ["git"], ctx);
    assert.equal(filtered.ok, true);
    if (filtered.ok) {
      assert.ok(!filtered.result.text.includes("filesystem.search"), "the filter applies");
      assert.ok(filtered.result.text.includes("git.status"));
    }
  }
});

test("/compress really shrinks a transcript and keeps the digest", async (t) => {
  const { ctx } = contextFor(t);
  const created = await runCommand("new", [], ctx);
  assert.equal(created.ok, true);
  const sessionId = created.ok ? (created.result.data as { sessionId: string }).sessionId : "";
  for (let i = 0; i < 15; i += 1) {
    ctx.sessions.recordTurn({ sessionId, role: i % 2 === 0 ? "user" : "assistant", text: `message number ${i} about lighthouses` });
  }
  assert.equal(ctx.sessions.turns(sessionId).ok && (ctx.sessions.turns(sessionId) as { ok: true; value: unknown[] }).value.length, 15);
  const ran = await runCommand("compress", [], ctx);
  assert.equal(ran.ok, true);
  if (ran.ok) {
    assert.equal((ran.result.data as { removed: number }).removed, 5, "15 - (2 first + 8 last) = 5 removed");
    const after = ctx.sessions.turns(sessionId);
    assert.ok(after.ok && after.value.length === 10);
    assert.ok(after.ok && after.value[0]?.text.includes("message number 0"), "the head survives");
    assert.ok(after.ok && after.value[9]?.text.includes("message number 14"), "the tail survives");
    const session = ctx.sessions.get(sessionId);
    assert.ok(session?.summary?.objective.includes("lighthouses"), "the digest still describes the dropped middle");
  }
});

test("/models and /providers read the live registry, not prose", async (t) => {
  const { ctx } = contextFor(t);
  const models = await runCommand("models", [], ctx);
  assert.equal(models.ok, true);
  if (models.ok) {
    assert.ok(models.result.text.includes("test-model"));
    assert.ok(models.result.text.includes("(active)"), "the current model is marked");
  }
  const filtered = await runCommand("models", ["hermes"], ctx);
  assert.equal(filtered.ok, true);
  if (filtered.ok) {
    assert.ok(filtered.result.text.includes("Hermes Agent"));
    assert.ok(!filtered.result.text.includes("KAI model"), "the provider filter applies");
  }
  const providers = await runCommand("providers", [], ctx);
  assert.equal(providers.ok, true);
  if (providers.ok) {
    assert.ok(providers.result.text.includes("kai-model"));
    assert.ok(providers.result.text.includes("authentication: configured"));
    assert.ok(providers.result.text.includes("OFFLINE"));
  }
});

test("/memory searches durable memories; /session reports the live session", async (t) => {
  const { ctx } = contextFor(t);
  const digest = await runCommand("memory", [], ctx);
  assert.equal(digest.ok, true);
  const session = await runCommand("session", [], ctx);
  assert.equal(session.ok, true);
  if (session.ok) assert.equal(session.result.title, "No active session");
  await runCommand("new", ["Remember This"], ctx);
  const after = await runCommand("session", [], ctx);
  assert.equal(after.ok, true);
  if (after.ok) assert.ok(after.result.title.includes("Remember This"));
});

test("/skills and /agents report the real (empty) registries honestly", async (t) => {
  const { ctx } = contextFor(t);
  const skills = await runCommand("skills", [], ctx);
  assert.equal(skills.ok, true);
  if (skills.ok) assert.match(skills.result.title, /No skills installed/);
  const agents = await runCommand("agents", [], ctx);
  assert.equal(agents.ok, true);
  if (agents.ok) assert.match(agents.result.title, /No agents yet/);
  const mcp = await runCommand("mcp", [], ctx);
  assert.equal(mcp.ok, true);
  if (mcp.ok) assert.match(mcp.result.title, /No MCP servers/);
});

test("LIVE: GET /commands and POST /commands/:id/run answer over real HTTP", async (t) => {
  // Manual temp dir (not tempDir(t)): teardown MUST close the server and the
  // runtime BEFORE removing the directory — an open SQLite handle locks files
  // on Windows and a separate rm hook would race the close.
  const dir = mkdtempSync(join(tmpdir(), "kai-commands-live-"));
  const rt = createCoreRuntime({
    dbPath: join(dir, "core.db"),
    agents: { mode: "mock" },
    startScheduler: false,
    subsystemPaths: { runUpkeepOnStart: false, ledgerPath: join(dir, "ledger.db") },
  });
  await rt.start();
  const server = createKaiServer(loadConfig(process.env), { core: rt });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rt.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const listed = (await (await fetch(`${base}/commands`)).json()) as { commands: Array<{ id: string }> };
  const ids = listed.commands.map((c) => c.id);
  for (const id of ["new", "compress", "models", "providers", "tools", "skills", "agents", "mcp", "memory", "session", "help"]) {
    assert.ok(ids.includes(id), `live catalogue includes /${id}`);
  }

  const run = async (id: string, args: unknown) =>
    (await (
      await fetch(`${base}/commands/${id}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ args }),
      })
    ).json()) as { ok?: boolean; result?: { title: string; text: string }; reason?: string; error?: boolean };

  const tools = await run("tools", []);
  assert.equal(tools.ok, true);
  assert.ok(String(tools.result?.text).includes("filesystem.search"), "live /tools reads the real plane");

  const created = await run("new", ["Live Command Session"]);
  assert.equal(created.ok, true);
  assert.ok(String(created.result?.title).includes("Live Command Session"), "live /new created + activated");

  const session = await run("session", []);
  assert.equal(session.ok, true);
  assert.ok(String(session.result?.title).includes("Live Command Session"), "live /session sees the new active session");

  const missing = await fetch(`${base}/commands/frobnicate/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(missing.status, 404, "an unknown command is 404, not a 200 with prose");
});

test("compact() keeps tool linkage on the surviving turns", async (t) => {
  const dir = tempDir(t);
  const store = createSessionStore({ path: join(dir, "s.db") });
  closersByDir.get(dir)?.push(() => store.close());
  const svc = createSessionService({ store });
  const s = svc.create({ title: "Keep Tools" });
  for (let i = 0; i < 12; i += 1) {
    svc.recordTurn({ sessionId: s.id, role: i % 2 === 0 ? "user" : "assistant", text: `turn ${i}` });
  }
  const assistant = svc.turns(s.id).ok && (svc.turns(s.id) as { ok: true; value: Array<{ id: string; role: string }> }).value;
  assert.ok(Array.isArray(assistant));
  if (Array.isArray(assistant)) {
    const lastAssistant = [...assistant].reverse().find((turn) => turn.role === "assistant");
    assert.ok(lastAssistant !== undefined);
    if (lastAssistant !== undefined) {
      svc.recordToolCalls(s.id, lastAssistant.id, [
        {
          toolCallId: "call_keep",
          toolName: "filesystem_search",
          toolId: "filesystem.search",
          arguments: "{}",
          status: "EXECUTED",
          result: { ok: true },
          startedAt: "2026-10-06T00:00:00.000Z",
          completedAt: "2026-10-06T00:00:01.000Z",
        },
      ]);
    }
  }
  const compacted = svc.compact(s.id, { keepFirst: 2, keepLast: 8 });
  assert.equal(compacted.ok, true);
  if (compacted.ok) {
    assert.equal(compacted.value.removed, 2);
    const tools = svc.toolCalls(s.id);
    assert.ok(tools.ok && tools.value.length === 1, "the surviving turn keeps its tool call");
    assert.equal(tools.ok && tools.value[0]?.toolId, "filesystem.search");
  }
});
