// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Deterministic pins for the routing defects a live run falsified.
 *
 * No network: every worker is a stub whose `fetchImpl` is a function in this
 * file. Each test below corresponds to one of the five defects, and pins the
 * BEHAVIOUR the product must have, not that the code "looks right":
 *
 *   F1  every worker-failure mode yields a KAI-voiced reply, never a reply-less 502
 *   F2  a delegate promise is HONOURED — the worker turn actually runs
 *   F3  an explicit "don't use X" is honoured and KAI still answers
 *   F4  a worker's self-identification cannot reach the user on ANY path
 *   F5  `answerUnknown` is reachable — an unknown turn is decided by KAI
 *
 * The runtime in the F2/F3/F5 tests is a REAL CoreRuntime in mock-agent mode and
 * is deliberately NOT started, so its workers report `offline` — that is the
 * "no worker can take this" case, without a network.
 */

import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createKaiServer } from "../src/server.ts";
import { loadConfig } from "../src/config.ts";
import { HermesClient } from "../src/agents/hermes.ts";
import { OpenCodeClient } from "../src/agents/opencode.ts";
import { createCoreRuntime } from "../src/runtime.ts";
import { FALLBACK_SELF, presentWorkerResult } from "../src/chat/relay.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ── Hermes stub ───────────────────────────────────────────────────────────────

interface HermesStub {
  client: HermesClient;
  turns: Array<{ session: string; text: string }>;
  /** true once a session was requested. */
  sessionsRequested: number;
}

function hermesStub(opts: {
  reply?: string;
  /** Throw from the chat fetch — the "unreachable" failure mode. */
  failTurn?: boolean;
  /** Answer the chat call with HTTP 500 — the "upstream error" failure mode. */
  httpFailTurn?: boolean;
  /** Answer session creation with an empty id — the "refused session" mode. */
  failSession?: boolean;
  /** Answer the chat call with empty content — the "empty result" mode. */
  emptyReply?: boolean;
} = {}): HermesStub {
  const turns: Array<{ session: string; text: string }> = [];
  const state = { sessions: 0 };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method === "POST" && url.endsWith("/api/sessions")) {
      state.sessions += 1;
      if (opts.failSession) return json({ object: "hermes.session", session: { id: "" } });
      return json({ object: "hermes.session", session: { id: `w_sess_${state.sessions}` } });
    }
    if (method === "POST" && url.includes("/api/sessions/") && url.endsWith("/chat")) {
      if (opts.failTurn) throw new Error("simulated transport failure");
      if (opts.httpFailTurn === true) return json({ error: "boom" }, 500);
      const session = decodeURIComponent(url.split("/api/sessions/")[1]!.replace(/\/chat$/, ""));
      const body = JSON.parse(String(init?.body ?? "{}")) as { message?: string };
      turns.push({ session, text: body.message ?? "" });
      return json({
        object: "hermes.chat",
        session_id: session,
        message: { role: "assistant", content: opts.emptyReply === true ? "" : (opts.reply ?? "OK") },
        usage: { total_tokens: 1 },
      });
    }
    return json({ status: "ok" });
  }) as typeof fetch;
  return {
    client: new HermesClient({ baseUrl: "http://127.0.0.1:8642", apiKey: "stub-key", fetchImpl }),
    turns,
    get sessionsRequested(): number {
      return state.sessions;
    },
  };
}

// ── OpenCode stub ─────────────────────────────────────────────────────────────

function opencodeStub(opts: { failTurn?: boolean } = {}): { client: OpenCodeClient; turns: string[] } {
  const turns: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method === "POST" && url.endsWith("/session")) {
      return json({ id: "oc_sess_1" });
    }
    if (method === "POST" && url.includes("/session/") && url.endsWith("/message")) {
      if (opts.failTurn) throw new Error("simulated opencode transport failure");
      turns.push(url);
      return json({ info: { role: "assistant" }, parts: [{ type: "text", text: "oc-ok" }] });
    }
    return json({});
  }) as typeof fetch;
  return { client: new OpenCodeClient({ baseUrl: "http://127.0.0.1:4096", password: "", fetchImpl }), turns };
}

// ── server harness ────────────────────────────────────────────────────────────

interface Harness {
  base: string;
  close: () => Promise<void>;
}

async function startServer(deps: {
  hermes?: HermesClient;
  opencode?: OpenCodeClient;
  core?: ReturnType<typeof createCoreRuntime>;
}): Promise<Harness> {
  const server = createKaiServer(
    loadConfig({
      ...process.env,
      KAI_HERMES_URL: "http://127.0.0.1:8642",
      KAI_OPENCODE_URL: "http://127.0.0.1:4096",
    }),
    deps,
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (deps.core !== undefined) await deps.core.stop();
    },
  };
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "kai-routing-"));
}

function bootOfflineRuntime(dir: string): ReturnType<typeof createCoreRuntime> {
  // Deliberately NOT started: its mock workers report `offline`, so no worker can
  // take a turn — the honest "no worker connected" case, with no network.
  return createCoreRuntime({
    dbPath: join(dir, "kai.db"),
    agents: { mode: "mock" },
    startScheduler: false,
    // `identityRoot` IS this runtime's KAI_HOME, and the model credential is read
    // from `<KAI_HOME>/model/credentials.json`. Pinning it to this test's own temp
    // directory keeps the suite hermetic: without it, a machine that HAS a real
    // credential (the normal, wanted state now) would give this runtime a live
    // brain, and these tests are about the NO-brain relay path.
    subsystemPaths: { runUpkeepOnStart: false, identityRoot: dir },
  });
}

async function post(base: string, path: string, text: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

// ── F1: worker failure never leaves the turn unanswered ───────────────────────

for (const [name, stub] of [
  ["unreachable", hermesStub({ failTurn: true })],
  ["http error", hermesStub({ httpFailTurn: true })],
  ["refused session", hermesStub({ failSession: true })],
  ["empty result", hermesStub({ emptyReply: true })],
] as const) {
  test(`F1: a Hermes ${name} answers as KAI, never a reply-less 502`, async (t) => {
    const s = await startServer({ hermes: stub.client });
    t.after(() => s.close());

    const res = await post(s.base, "/chat", "do the thing");
    assert.equal(res.status, 200, "a worker failure must not surface as a 502");
    assert.equal(typeof res.body["reply"], "string");
    const reply = res.body["reply"] as string;
    assert.ok(reply.length > 0, "the reply must not be empty — empty IS silence");
    assert.ok(reply.includes("KAI"), `KAI's own voice must be present: ${reply}`);
    assert.ok(reply.includes("Hermes"), `the failed worker must be named: ${reply}`);
    assert.equal(res.body["error"], undefined, "no bare error shape on the wire");
  });
}

test("F1: an OpenCode failure on its own route answers as KAI too", async (t) => {
  const oc = opencodeStub({ failTurn: true });
  const s = await startServer({ hermes: hermesStub().client, opencode: oc.client });
  t.after(() => s.close());

  const res = await post(s.base, "/agents/opencode/chat", "hello opencode");
  assert.equal(res.status, 200, "the OpenCode relay must not answer with a bare 502");
  const reply = res.body["reply"] as string;
  assert.ok(typeof reply === "string" && reply.length > 0, "a KAI-voiced reply is required");
  assert.ok(reply.includes("KAI"), reply);
  assert.ok(reply.includes("OpenCode"), reply);
});

// ── F2: the delegate promise is honoured ─────────────────────────────────────

test("F2: 'Use Hermes to do this.' ACTUALLY runs a Hermes turn", async (t) => {
  const dir = tempDir();
  const hermes = hermesStub({ reply: "the result of the task" });
  const core = bootOfflineRuntime(dir);
  const s = await startServer({ hermes: hermes.client, core });
  t.after(async () => {
    await s.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const res = await post(s.base, "/chat", "Use Hermes to do this.");
  assert.equal(res.status, 200);
  assert.equal(res.body["intent"], "task.delegate");
  assert.equal(res.body["delegated"], true, "the response says the turn was delegated");
  assert.equal(hermes.turns.length, 1, "the worker turn ran — the promise is not empty");
  assert.equal(res.body["reply"], "the result of the task", "KAI speaks the worker's result");
});

test("F2: 'Hermes, do X.' also runs a real Hermes turn", async (t) => {
  const dir = tempDir();
  const hermes = hermesStub({ reply: "done" });
  const core = bootOfflineRuntime(dir);
  const s = await startServer({ hermes: hermes.client, core });
  t.after(async () => {
    await s.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const res = await post(s.base, "/chat", "Hermes, do X.");
  assert.equal(res.body["intent"], "task.delegate");
  assert.equal(hermes.turns.length, 1, "the addressed worker actually received the turn");
});

// ── F3: an explicit "don't use X" is honoured ───────────────────────────────

test("F3: \"I don't want Hermes, do it yourself.\" runs no Hermes turn and still answers", async (t) => {
  const dir = tempDir();
  const hermes = hermesStub({ reply: "should never run" });
  const core = bootOfflineRuntime(dir);
  const s = await startServer({ hermes: hermes.client, core });
  t.after(async () => {
    await s.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const res = await post(s.base, "/chat", "I don't want Hermes, do it yourself.");
  assert.equal(res.status, 200, "KAI still answers — never silence");
  assert.equal(hermes.turns.length, 0, "the ruled-out worker is not used");
  const reply = res.body["reply"] as string;
  assert.ok(reply.length > 0, "a reply is required");
  assert.match(reply, /not to use Hermes/i, `KAI acknowledges the constraint: ${reply}`);
  assert.notEqual(res.body["worker"], "hermes");
});

// ── F4: a worker's self-identification cannot reach the user ─────────────────

test("F4: the observed reverse-order self-identification is guarded (unit)", () => {
  const presented = presentWorkerResult({
    worker: "hermes",
    raw: "Hermes Agent is what I actually am — the runtime answering this api_server turn.",
    kaiSelf: "I am KAI.",
  });
  assert.equal(presented.guarded, true, "the reverse-order identity claim must be detected");
  assert.ok(!/what I actually am/i.test(presented.reply), presented.reply);
  assert.ok(!/Hermes Agent/i.test(presented.reply), presented.reply);
});

test("F4: a worker's self-identification is guarded on the unknown fall-through path", async (t) => {
  const hermes = hermesStub({
    reply: "Hermes Agent is what I actually am — the runtime answering this api_server turn.",
  });
  const s = await startServer({ hermes: hermes.client });
  t.after(() => s.close());

  const res = await post(s.base, "/chat", "tell me something interesting");
  assert.equal(res.status, 200);
  assert.equal(res.body["worker_identity_guarded"], true, "the guard must fire on this path");
  const reply = res.body["reply"] as string;
  assert.ok(!/Hermes Agent/i.test(reply), reply);
  assert.ok(!/what I actually am/i.test(reply), reply);
  assert.equal(reply, FALLBACK_SELF, "KAI answers as itself when the worker only said who it is");
});

// ── F5: answerUnknown is reachable ───────────────────────────────────────────

test("F5: an unknown turn with no worker connected is answered by KAI, not piped to Hermes", async (t) => {
  const dir = tempDir();
  const hermes = hermesStub({ reply: "should never run" });
  const core = bootOfflineRuntime(dir);
  const s = await startServer({ hermes: hermes.client, core });
  t.after(async () => {
    await s.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const res = await post(s.base, "/chat", "what is the airspeed velocity of an unladen swallow");
  assert.equal(res.status, 200);
  assert.equal(res.body["intent"], "unknown", "the router classified it, it did not bypass the router");
  assert.equal(hermes.turns.length, 0, "no worker turn ran when none is connected");
  const reply = res.body["reply"] as string;
  assert.match(reply, /no agent is connected/i, `answerUnknown's honest fallback: ${reply}`);
  console.log(`      -> F5 reply: ${JSON.stringify(reply)}`);
});
