// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

// Outcome-driven task completion: a tool execution is never the answer.
// A. search -> inspect -> explain (deliverable present, COMPLETED)
// B. read -> exact quote (verified verbatim, COMPLETED)
// C. research two topics -> structured comparison (both present, COMPLETED)
// D. budget-cut -> synthesis delivers (COMPLETED) / synthesis empty (PAUSED honest)
// E. "continue" resumes the open task from the resume prompt (no restart)
// F. tasks persist across a restart; PAUSED stays resumable
// G. provider registry reports honest states; unknown ids refused
// H. LIVE HTTP: /models use parks -> approve -> applies -> survives restart
//
//   cd core && node --test tests/task-completion.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { createCoreRuntime } from "../src/runtime.ts";
import { createKaiServer } from "../src/server.ts";
import { loadConfig } from "../src/config.ts";
import { createProviderRegistry } from "../src/providers/registry.ts";
import { isContinueText } from "../src/chat/tasks.ts";

function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const stage = join(dir, "workspace");
  mkdirSync(stage, { recursive: true });
  writeFileSync(join(stage, "session-loader.txt"), "the loader reads turns newest-first; the bug: it drops tool records on reload\n", "utf8");
  writeFileSync(join(stage, "tool-loop.txt"), "tool loop runs search then read; keeper line: the lighthouse stands\n", "utf8");
  process.env.KAI_WORKSPACE_ROOT = stage;
  return dir;
}

type ModelFn = (url: unknown, init?: { body?: unknown }) => Promise<Response>;
function completion(text: string, toolCalls?: Array<{ name: string; args: unknown }>) {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            role: "assistant",
            content: text,
            ...(toolCalls !== undefined
              ? {
                tool_calls: toolCalls.map((c, i) => ({
                  id: `call_${i}`,
                  type: "function",
                  function: { name: c.name, arguments: JSON.stringify(c.args) },
                })),
              }
              : {}),
          },
          finish_reason: toolCalls !== undefined ? "tool_calls" : "stop",
        },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function boot(dir: string, modelFn: ModelFn, extra: Record<string, unknown> = {}) {
  return createCoreRuntime({
    dbPath: join(dir, "core.db"),
    agents: { mode: "mock" },
    startScheduler: false,
    model: { fetchImpl: modelFn as typeof fetch },
    subsystemPaths: { runUpkeepOnStart: false, ledgerPath: join(dir, "ledger.db") },
    ...extra,
  });
}

const bodiesOf = (seen: string[]) => seen.map((b) => {
  try {
    return JSON.stringify(JSON.parse(b));
  } catch {
    return b;
  }
});

test("isContinueText: continuations resume, new requests do not", () => {
  for (const t of ["continue", "Continue.", "go on", "keep going", "yes do it", "yes", "proceed", "carry on"]) {
    assert.equal(isContinueText(t), true, JSON.stringify(t));
  }
  for (const t of ["", "hello", "yes do that", "continue the audit of sessions", "what is happening?", "search my files"]) {
    assert.equal(isContinueText(t), false, JSON.stringify(t));
  }
});

test("A: search -> inspect -> explain delivers the explanation (COMPLETED)", async (t) => {
  const dir = freshDir("kai-task-a-");
  const seen: string[] = [];
  const rt = boot(dir, (async (_url, init = {}) => {
    const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
    seen.push(typeof init.body === "string" ? init.body : "");
    const messages = body.messages ?? [];
    const toolsUsed = messages.some((m: { role?: string }) => m.role === "tool");
    const reads = messages.filter((m: { role?: string }) => m.role === "tool").length;
    if (!toolsUsed) return completion("I'll find the session-loading files.", [{ name: "filesystem_search", args: { query: "session loading", path: process.env.KAI_WORKSPACE_ROOT } }]);
    if (reads < 2) return completion("Found candidates, reading them.", [{ name: "filesystem_read", args: { path: join(process.env.KAI_WORKSPACE_ROOT ?? "", "session-loader.txt") } }]);
    return completion("## Result\nThe bug is in session-loader.txt: it reads turns newest-first but drops tool records on reload. Fix the loader to keep tool records.");
  }) as ModelFn);
  await rt.start();
  t.after(async () => {
    await rt.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const session = rt.sessions.create({ title: "audit" });
  const answer = await rt.chat.answer("Find the files responsible for session loading and explain the bug.", { sessionId: session.id });
  assert.match(answer.text, /session-loader\.txt/, "the deliverable names the file");
  assert.match(answer.text, /drops tool records/, "the deliverable explains the bug");
  assert.ok(!/^I'll /i.test(answer.text.trim()), "the reply is not a progress preamble");
  assert.equal(answer.taskState, "COMPLETED");
  assert.ok((answer.toolCalls ?? []).length >= 2, "tool history rides along");
  const task = rt.tasks.active(session.id);
  assert.equal(task, null, "a completed task leaves nothing open");
});

test("B: read -> exact quote is verified verbatim (COMPLETED)", async (t) => {
  const dir = freshDir("kai-task-b-");
  const rt = boot(dir, (async (_url, init = {}) => {
    const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
    const toolsUsed = (body.messages ?? []).some((m: { role?: string }) => m.role === "tool");
    if (!toolsUsed) return completion("Reading it now.", [{ name: "filesystem_read", args: { path: join(process.env.KAI_WORKSPACE_ROOT ?? "", "tool-loop.txt") } }]);
    return completion("The keeper line is: the lighthouse stands");
  }) as ModelFn);
  await rt.start();
  t.after(async () => {
    await rt.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const session = rt.sessions.create({ title: "quote" });
  const answer = await rt.chat.answer("Read tool-loop.txt and tell me exactly what the keeper line is.", { sessionId: session.id });
  assert.ok(answer.text.includes("the lighthouse stands"), "the exact line is quoted");
  assert.equal(answer.taskState, "COMPLETED");
});

test("C: research two topics -> structured comparison (COMPLETED)", async (t) => {
  const dir = freshDir("kai-task-c-");
  let calls = 0;
  const rt = boot(dir, (async (_url, init = {}) => {
    const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
    const toolsUsed = (body.messages ?? []).some((m: { role?: string }) => m.role === "tool");
    if (!toolsUsed && calls === 0) {
      calls++;
      return completion("Researching the loader.", [{ name: "filesystem_search", args: { query: "loader", path: process.env.KAI_WORKSPACE_ROOT } }]);
    }
    if (toolsUsed && calls === 1) {
      calls++;
      return completion("Researching the tool loop.", [{ name: "filesystem_search", args: { query: "tool loop", path: process.env.KAI_WORKSPACE_ROOT } }]);
    }
    if (toolsUsed) return completion("## Loader vs tool loop\n| | loader | tool loop |\n|---|---|---|\n| reads | turns newest-first | search then read |\n| drops | tool records | nothing |");
    return completion("done");
  }) as ModelFn);
  await rt.start();
  t.after(async () => {
    await rt.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const session = rt.sessions.create({ title: "compare" });
  const answer = await rt.chat.answer("Research the loader and the tool loop and give me a structured comparison.", { sessionId: session.id });
  assert.ok(answer.text.includes("loader") && answer.text.includes("tool loop"), "both topics present");
  assert.ok(answer.text.length > 100, "a comparison, not a stub");
  assert.equal(answer.taskState, "COMPLETED");
});

test("D1: budget-cut with synthesis delivers (COMPLETED, synthesized)", async (t) => {
  const dir = freshDir("kai-task-d1-");
  const rt = boot(
    dir,
    (async (_url, init = {}) => {
      const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
      const messages = body.messages ?? [];
      const lastUser = [...messages].reverse().find((m: { role?: string }) => m.role === "user");
      if (String(lastUser?.content ?? "").includes("FINAL answer")) {
        return completion("## Result\nSearched the workspace: session-loader.txt holds the loader. Verdict: it drops tool records — that is the bug.");
      }
      return completion("Still searching.", [{ name: "filesystem_search", args: { query: "x", path: process.env.KAI_WORKSPACE_ROOT } }]);
    }) as ModelFn,
    { brainMaxToolIterations: 2 },
  );
  await rt.start();
  t.after(async () => {
    await rt.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const session = rt.sessions.create({ title: "budget" });
  const answer = await rt.chat.answer("Audit the workspace and report the verdict.", { sessionId: session.id });
  assert.equal(answer.toolBudgetExhausted, true);
  assert.equal(answer.synthesized, true, "the guard authored the closing text");
  assert.match(answer.text, /Verdict/, "the deliverable arrived despite the cut");
  assert.equal(answer.taskState, "COMPLETED");
  assert.ok((answer.pendingTools ?? []).length > 0, "the remainder is named");
});

test("D2: budget-cut with empty synthesis pauses honestly (PAUSED)", async (t) => {
  const dir = freshDir("kai-task-d2-");
  const seen: string[] = [];
  const rt = boot(
    dir,
    (async (_url, init = {}) => {
      const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
      seen.push(typeof init.body === "string" ? init.body : "");
      return completion("", [{ name: "filesystem_search", args: { query: "x", path: process.env.KAI_WORKSPACE_ROOT } }]);
    }) as ModelFn,
    { brainMaxToolIterations: 2 },
  );
  await rt.start();
  t.after(async () => {
    await rt.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const session = rt.sessions.create({ title: "paused" });
  const answer = await rt.chat.answer("Audit the workspace and report the verdict.", { sessionId: session.id });
  assert.equal(answer.taskState, "PAUSED");
  assert.match(answer.text, /Task paused because the execution budget was reached/, "honest pause, not progress");
  assert.match(answer.text, /Completed:/, "completed work is named");
  assert.match(answer.text, /Remaining:/, "remaining work is named");
  assert.match(answer.text, /continue/, "the recourse is named");
  void bodiesOf(seen);
});

test("E: 'continue' resumes the open task from the resume prompt", async (t) => {
  const dir = freshDir("kai-task-e-");
  const seen: string[] = [];
  let phase: "search" | "resume" = "search";
  const rt = boot(
    dir,
    (async (_url, init = {}) => {
      const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
      seen.push(typeof init.body === "string" ? init.body : "");
      const messages = body.messages ?? [];
      const lastUser = [...messages].reverse().find((m: { role?: string }) => m.role === "user");
      if (String(lastUser?.content ?? "").includes("Original objective")) {
        phase = "resume";
        return completion("## Result\nResumed and finished: the loader drops tool records. Done.");
      }
      if (String(lastUser?.content ?? "").includes("FINAL answer")) return completion("");
      return completion("Searching.", [{ name: "filesystem_search", args: { query: "x", path: process.env.KAI_WORKSPACE_ROOT } }]);
    }) as ModelFn,
    { brainMaxToolIterations: 1 },
  );
  await rt.start();
  t.after(async () => {
    await rt.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const session = rt.sessions.create({ title: "resume me" });
  const first = await rt.chat.answer("Audit the workspace and report the verdict.", { sessionId: session.id });
  assert.equal(first.taskState, "PAUSED");
  const second = await rt.chat.answer("continue", { sessionId: session.id });
  assert.equal(phase, "resume", "the second turn ran the resume prompt, not a fresh search");
  assert.equal(second.taskState, "COMPLETED");
  assert.match(second.text, /Resumed and finished/);
  const tasks = rt.tasks.read !== undefined ? rt.tasks : null;
  assert.ok(tasks !== null);
});

test("F: tasks persist across a restart; PAUSED stays resumable", async (t) => {
  const dir = freshDir("kai-task-f-");
  const mk = () =>
    boot(dir, (async () => {
      return completion("", [{ name: "filesystem_search", args: { query: "x", path: process.env.KAI_WORKSPACE_ROOT } }]);
    }) as ModelFn, { brainMaxToolIterations: 1 });
  const rt = mk();
  await rt.start();
  const session = rt.sessions.create({ title: "persist me" });
  const first = await rt.chat.answer("Audit the workspace and report the verdict.", { sessionId: session.id });
  assert.equal(first.taskState, "PAUSED");
  await rt.stop();

  const rt2 = mk();
  await rt2.start();
  t.after(async () => {
    await rt2.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const open = rt2.tasks.active(session.id);
  assert.ok(open !== null, "the paused task survives the restart");
  assert.equal(open.state, "PAUSED");
  assert.ok(open.objective.includes("Audit the workspace"), "the objective survives");
  assert.ok(open.steps.length > 0, "completed steps survive");
});

test("G: provider registry reports honest states; unknown ids refused", async () => {
  const { createProviderRegistry: make } = await import("../src/providers/registry.ts");
  const registry = make({
    kaiBaseUrl: "http://127.0.0.1:9",
    kaiEffective: () => ({
      values: { name: "probe-model", baseUrl: "http://127.0.0.1:9", timeoutMs: 1000, apiKeyConfigured: false },
      sources: { name: "defaults", baseUrl: "defaults", timeoutMs: "defaults" },
    }),
    kaiHealth: () => Promise.resolve({ ok: false, configured: false, provider: "kai-model", baseUrl: "http://127.0.0.1:9", model: "probe-model", reason: "no API key configured" }),
    kaiModels: () => Promise.resolve([]),
    hermesBaseUrl: "http://127.0.0.1:9",
    opencodeBaseUrl: "http://127.0.0.1:9",
    fetchImpl: (async () => {
      throw new Error("connection refused");
    }) as typeof fetch,
  });
  const listed = await registry.list();
  assert.equal(listed.length, 3, "all three providers reported");
  assert.ok(listed.every((p) => p.reachable === false), "nothing reachable is claimed");
  assert.ok(listed.every((p) => p.modelsNote !== undefined || p.models.length > 0), "every empty catalogue says why");
  const kai = listed.find((p) => p.id === "kai-model")!;
  assert.equal(kai.current, true);
  assert.equal(kai.authConfigured, false);
  const unknown = await registry.test("nope");
  assert.equal(unknown.ok, false);
  assert.match(unknown.reason, /unknown provider/);
  const models = await registry.models();
  assert.equal(models.providers.length, 3);
});

test("H: LIVE HTTP /models use parks -> approve -> applies -> survives restart", async (t) => {
  const dir = freshDir("kai-task-h-");
  const mk = () => boot(dir, (async () => completion("hi")) as ModelFn);
  const rt = mk();
  await rt.start();
  // Give this Core a REAL owner credential and present it, so the test exercises
  // the ENFORCED production posture rather than the no-credential one (which now
  // refuses every owner route, by design).
  const previousToken = process.env.KAI_HOST_TOKEN;
  process.env.KAI_HOST_TOKEN = "test-owner-token-0123456789abcdef";
  t.after(() => {
    if (previousToken === undefined) delete process.env.KAI_HOST_TOKEN;
    else process.env.KAI_HOST_TOKEN = previousToken;
  });
  const config = loadConfig(process.env);
  const server = createKaiServer(config, { core: rt });
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
  // The installed app holds the per-install owner credential and presents it on
  // every mutation. The Core now FAILS CLOSED, so a test that drove a mutation
  // without it would be testing the authorization gate, not the approval flow.
  const hostToken = config.server.hostToken;
  const headers = (): Record<string, string> => ({
    "content-type": "application/json",
    ...(typeof hostToken === "string" && hostToken.length > 0 ? { "x-kai-host-token": hostToken } : {}),
  });
  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${base}${path}`, { method: "POST", headers: headers(), body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  const providers = (await (await fetch(`${base}/providers`)).json()) as { providers: { id: string; kind: string }[] };
  assert.deepEqual(providers.providers.map((p) => p.id).sort(), ["hermes", "kai-model", "opencode"]);
  const catalogue = (await (await fetch(`${base}/models`)).json()) as { providers: unknown[] };
  assert.equal(catalogue.providers.length, 3);

  const parked = await post("/models/use", { model: "switched-live-model" });
  assert.equal(parked.status, 409, "selecting the model parks for a human");
  const approvalId = parked.body.approvalId as string;
  assert.ok(typeof approvalId === "string");
  const decided = await post(`/approvals/${approvalId}/decide`, { approved: true });
  assert.equal(decided.status, 200);
  const applied = await post("/models/use", { model: "switched-live-model", approvalId });
  assert.equal(applied.status, 200);
  const after = (await (await fetch(`${base}/models`)).json()) as {
    providers: { id: string; models: { id: string; current: boolean }[] }[];
  };
  const kai = after.providers.find((p) => p.id === "kai-model")!;
  assert.ok(kai.models.some((m) => m.id === "switched-live-model" && m.current), "the selected model is current");

  const worker = await post("/models/use", { model: "x", provider: "hermes" });
  assert.equal(worker.status, 400, "worker model selection is refused, not faked");

  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rt.stop();
  const rt2 = mk();
  await rt2.start();
  const eff = rt2.settings.effective();
  assert.equal(eff.values.name, "switched-live-model", "the selection persists");
  assert.equal(eff.sources.name, "settings");
  await rt2.stop();
});
