// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Session SWITCHING, end to end through the real server relay (Section 14/15).
 *
 * The unit tests in `sessions.test.ts` pin the store, the service and the
 * `/sessions*` routes. They do NOT exercise the path a real UI turn takes:
 * the app names the KAI session (`conversation_id`), Core resolves it, records
 * the turn against it and binds the worker conversation to it. This file drives
 * that exact path with a stateful fake Hermes, so the hierarchy
 *
 *     KAI session -> conversation -> turn -> worker execution
 *
 * is checked as one thing: switch the active session, send a codeword, and prove
 * the turn landed in the right KAI session AND reached the right worker
 * conversation (and only that one).
 */

import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { createKaiServer } from "../src/server.ts";
import { loadConfig } from "../src/config.ts";
import { HermesClient } from "../src/agents/hermes.ts";
import { createCoreRuntime } from "../src/runtime.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "kai-switch-"));
}

/**
 * A Hermes whose worker sessions are REAL to the test: each `createSession`
 * mints a fresh id, and every chat turn is recorded against the worker session
 * id it was sent to. That is what lets the test tell "the turn reached session
 * A's worker conversation" from "it reached B's".
 */
interface StubWorker {
  client: HermesClient;
  /** worker session id -> the texts that reached it, in order. */
  turns: Map<string, string[]>;
  /** createSession call count (== distinct worker conversations minted). */
  created: number;
}

function stubHermes(): StubWorker {
  const turns = new Map<string, string[]>();
  const state = { created: 0 };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method === "POST" && url.endsWith("/api/sessions")) {
      state.created += 1;
      const id = `worker_sess_${state.created}`;
      turns.set(id, []);
      return new Response(JSON.stringify({ object: "hermes.session", session: { id } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (method === "POST" && url.includes("/api/sessions/") && url.endsWith("/chat")) {
      const workerId = decodeURIComponent(url.split("/api/sessions/")[1]!.replace(/\/chat$/, ""));
      const body = JSON.parse(String(init?.body ?? "{}")) as { message?: string };
      const text = body.message ?? "";
      const list = turns.get(workerId) ?? [];
      list.push(text);
      turns.set(workerId, list);
      // The relay composes KAI's full prompt and it ENDS with the user's request,
      // so the last line is the request the worker actually saw. Replying with a
      // constant keeps the assertion about WHERE the turn went, not what it said.
      return new Response(
        JSON.stringify({
          object: "hermes.chat",
          session_id: workerId,
          message: { role: "assistant", content: "OK" },
          usage: { total_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ status: "ok" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return {
    client: new HermesClient({ baseUrl: "http://127.0.0.1:8642", apiKey: "stub", fetchImpl }),
    turns,
    get created() {
      return state.created;
    },
  };
}

async function startServer(
  sessionsPath: string,
  dbPath: string,
  worker: StubWorker,
): Promise<{ base: string; runtime: ReturnType<typeof createCoreRuntime>; close: () => Promise<void> }> {
  const runtime = createCoreRuntime({
    dbPath,
    agents: { mode: "mock" },
    startScheduler: false,
    // This runtime's KAI_HOME is its own temp directory, so the model credential it
    // looks for is `<temp>/model/credentials.json` — which does not exist. That is
    // what keeps this file testing the WORKER-RELAY path: on a machine with a real
    // credential (the wanted state now) an unpinned home would give the Core a live
    // brain and every "unknown" turn would be answered by the model instead.
    subsystemPaths: { runUpkeepOnStart: false, sessionsPath, identityRoot: dirname(dbPath) },
  });
  // The PRODUCTION server always starts its runtime before serving (see
  // server.ts `main`), so worker-registry state is live for every `/chat` turn.
  // The relay now asks the router which worker may take an unknown turn, so this
  // test must run the runtime the same way production does or it is testing a
  // configuration that never serves a request.
  await runtime.start();
  const server = createKaiServer(
    loadConfig({
      ...process.env,
      KAI_HERMES_URL: "http://127.0.0.1:8642",
      KAI_OPENCODE_URL: "http://127.0.0.1:9",
    }),
    { hermes: worker.client, core: runtime },
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${address.port}`,
    runtime,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await runtime.stop();
    },
  };
}

async function chat(base: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(`${base}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200, `chat ${JSON.stringify(body)} -> ${response.status}`);
  return (await response.json()) as Record<string, unknown>;
}

test("Section 14: three KAI sessions keep their own turns and their own worker conversations", async (t) => {
  const dir = tempDir();
  const sessionsPath = join(dir, "kai-sessions.db");
  const dbPath = join(dir, "kai.db");
  const worker = stubHermes();
  const s = await startServer(sessionsPath, dbPath, worker);
  t.after(async () => {
    await s.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const sessions = s.runtime.sessions;
  const a = sessions.create({ title: "APPLE" });
  const b = sessions.create({ title: "BANANA" });
  const c = sessions.create({ title: "ORANGE" });

  // A → APPLE
  sessions.activate(a.id);
  const ra = await chat(s.base, { text: "APPLE", conversation_id: a.id });
  assert.equal(ra.reply, "OK");
  assert.equal(ra.conversation_id, a.id, "the reply names the KAI session that produced it");

  // B → BANANA
  sessions.activate(b.id);
  const rb = await chat(s.base, { text: "BANANA", conversation_id: b.id });
  assert.equal(rb.reply, "OK");
  assert.equal(rb.conversation_id, b.id);

  // C → ORANGE
  sessions.activate(c.id);
  const rc = await chat(s.base, { text: "ORANGE", conversation_id: c.id });
  assert.equal(rc.reply, "OK");
  assert.equal(rc.conversation_id, c.id);

  // Each KAI session holds exactly its own two turns, and no other session's.
  for (const [session, word] of [
    [a, "APPLE"],
    [b, "BANANA"],
    [c, "ORANGE"],
  ] as const) {
    const turns = sessions.turns(session.id);
    assert.equal(turns.ok, true);
    const texts = turns.ok ? turns.value.map((x) => `${x.role}:${x.text}`) : [];
    assert.deepEqual(texts, [`user:${word}`, "assistant:OK"], `${word} turns are isolated`);
  }

  // Worker runtime isolation: three distinct worker conversations, one per KAI session.
  const bound = [a, b, c].map((x) => sessions.get(x.id)?.agentSessionId);
  assert.equal(new Set(bound).size, 3, `worker sessions must differ: ${bound.join(", ")}`);
  assert.equal(worker.created, 3, "one worker conversation minted per KAI session");
  for (const id of bound) {
    assert.ok(id !== undefined && worker.turns.has(id), "the bound worker session is one this run created");
  }
  // The prompt a worker received ENDS with the user's request, so the last line
  // proves which codeword reached which worker conversation.
  const lastLine = (id: string): string => (worker.turns.get(id) ?? []).at(-1)?.trim().split("\n").at(-1) ?? "";
  assert.equal(lastLine(bound[0] as string), "APPLE");
  assert.equal(lastLine(bound[1] as string), "BANANA");
  assert.equal(lastLine(bound[2] as string), "ORANGE");

  // Switch back to A and send again: the turn must reach A's ORIGINAL worker
  // conversation (the binding persisted), not B's or C's.
  sessions.activate(a.id);
  const ra2 = await chat(s.base, { text: "APRICOT", conversation_id: a.id });
  assert.equal(ra2.reply, "OK");
  const aWorker = sessions.get(a.id)?.agentSessionId as string;
  assert.equal(aWorker, bound[0], "the worker binding did not drift");
  assert.equal((worker.turns.get(aWorker) ?? []).length, 2, "A's worker conversation got both turns");
  assert.equal(lastLine(aWorker), "APRICOT", "the second turn continued A's worker conversation");
  // And nothing leaked into B's or C's worker conversation.
  assert.equal((worker.turns.get(bound[1] as string) ?? []).length, 1, "B's worker saw only BANANA");
  assert.equal((worker.turns.get(bound[2] as string) ?? []).length, 1, "C's worker saw only ORANGE");
});

test("Section 15: a turn with no conversation_id follows the ACTIVE session", async (t) => {
  const dir = tempDir();
  const sessionsPath = join(dir, "kai-sessions.db");
  const dbPath = join(dir, "kai.db");
  const worker = stubHermes();
  const s = await startServer(sessionsPath, dbPath, worker);
  t.after(async () => {
    await s.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const sessions = s.runtime.sessions;
  const a = sessions.create({ title: "A" });
  const b = sessions.create({ title: "B" });

  sessions.activate(b.id);
  await chat(s.base, { text: "to-active-B" });

  const turnsB = sessions.turns(b.id);
  assert.deepEqual(
    turnsB.ok ? turnsB.value.map((x) => x.text) : [],
    ["to-active-B", "OK"],
    "the turn went to the ACTIVE session, not the last-created one",
  );
  assert.equal(sessions.turns(a.id).ok ? (sessions.turns(a.id) as { value: unknown[] }).value.length : -1, 0);
});

test("Section 14: switching is durable across a Core restart (turns + worker binding survive)", async (t) => {
  const dir = tempDir();
  const sessionsPath = join(dir, "kai-sessions.db");
  const dbPath = join(dir, "kai.db");
  const worker = stubHermes();
  const first = await startServer(sessionsPath, dbPath, worker);
  const a = first.runtime.sessions.create({ title: "APPLE" });
  first.runtime.sessions.activate(a.id);
  await chat(first.base, { text: "APPLE", conversation_id: a.id });
  const boundBefore = first.runtime.sessions.get(a.id)?.agentSessionId;
  await first.close();

  // "Restart": a brand-new runtime over the SAME sessions file.
  const second = await startServer(sessionsPath, dbPath, worker);
  t.after(async () => {
    await second.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const active = second.runtime.sessions.active();
  assert.equal(active?.id, a.id, "the active pointer survived the restart");
  const turns = second.runtime.sessions.turns(a.id);
  assert.deepEqual(
    turns.ok ? turns.value.map((x) => x.text) : [],
    ["APPLE", "OK"],
    "the turns survived the restart",
  );
  assert.equal(second.runtime.sessions.get(a.id)?.agentSessionId, boundBefore, "the worker binding survived");

  // A turn after the restart continues the SAME worker conversation.
  const after = await chat(second.base, { text: "AFTER", conversation_id: a.id });
  assert.equal(after.reply, "OK");
  const prompts = worker.turns.get(boundBefore as string) ?? [];
  assert.equal(prompts.length, 2, "the restarted Core reused A's bound worker conversation");
  assert.equal(prompts.at(-1)?.trim().split("\n").at(-1), "AFTER");
});
