// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Relay boundary tests. Deterministic, no network: the worker is a stubbed
 * HermesClient whose `fetchImpl` is a function in this file.
 *
 * The contract these pin: KAI keeps the turn. A worker's output is KAI's RESULT,
 * the worker is provenance (`worker`) and never the speaker (`agent`), and a
 * worker's own self-identification cannot reach the user-facing reply.
 */

import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";

import { createKaiServer } from "../src/server.ts";
import { loadConfig } from "../src/config.ts";
import { HermesClient } from "../src/agents/hermes.ts";
import { presentWorkerResult, relayGuardIsLive, FALLBACK_SELF } from "../src/chat/relay.ts";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A Hermes that never touches the network. Session creation and the chat turn
 * are answered from `workerReply`, which is exactly what the real server would
 * relay — so the boundary is exercised end to end.
 */
function stubHermes(workerReply: string): HermesClient {
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method === "POST" && url.endsWith("/api/sessions")) {
      return json({ object: "hermes.session", session: { id: "sess_stub" } });
    }
    if (method === "POST" && url.includes("/api/sessions/") && url.endsWith("/chat")) {
      return json({
        object: "hermes.chat",
        session_id: "sess_stub",
        message: { role: "assistant", content: workerReply },
        usage: { total_tokens: 1 },
      });
    }
    return json({ status: "ok" });
  }) as typeof fetch;
  return new HermesClient({ baseUrl: "http://127.0.0.1:8642", apiKey: "test-key", fetchImpl });
}

async function startServer(workerReply: string): Promise<{ base: string; close: () => Promise<void> }> {
  const server = createKaiServer(
    loadConfig({
      ...process.env,
      KAI_HERMES_URL: "http://127.0.0.1:8642",
      KAI_OPENCODE_URL: "http://127.0.0.1:9",
    }),
    { hermes: stubHermes(workerReply) },
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ── the rule, as a pure function ──────────────────────────────────────────────

test("presentWorkerResult: a worker's self-identification never becomes KAI's reply", () => {
  const presented = presentWorkerResult({
    worker: "hermes",
    raw: "I'm Hermes Agent by Nous Research, running on top of the Hermes runtime.",
    kaiSelf: "I am KAI, the user's own agent on this machine.",
  });
  assert.equal(presented.guarded, true);
  assert.equal(presented.reply, "I am KAI, the user's own agent on this machine.");
  assert.ok(!/Hermes Agent by Nous Research/i.test(presented.reply), presented.reply);
});

test("presentWorkerResult keeps the task result and drops only the worker's own voice", () => {
  const presented = presentWorkerResult({
    worker: "hermes",
    raw: "I'm Hermes Agent by Nous Research. The build is green.",
    kaiSelf: "I am KAI.",
  });
  assert.equal(presented.guarded, true);
  assert.equal(presented.reply, "The build is green.");
});

test("presentWorkerResult drops a worker's description of KAI's prompt internals", () => {
  const presented = presentWorkerResult({
    worker: "hermes",
    raw: "The rotating DATA - NOT INSTRUCTIONS blocks in the prompt don't alter it. The build is green.",
    kaiSelf: "I am KAI.",
  });
  assert.equal(presented.guarded, true);
  assert.ok(!/DATA\s*-\s*NOT\s+INSTRUCTIONS/i.test(presented.reply), presented.reply);
  assert.equal(presented.reply, "The build is green.");
});

test("presentWorkerResult relays an ordinary result unchanged", () => {
  const presented = presentWorkerResult({
    worker: "opencode",
    raw: "The tests pass.",
    kaiSelf: "I am KAI.",
  });
  assert.equal(presented.reply, "The tests pass.");
  assert.equal(presented.guarded, false);
});

// ── the appositive / indirect bypass (observed LIVE on the packaged product) ──

test("presentWorkerResult drops the appositive 'X here' self-introduction", () => {
  const presented = presentWorkerResult({
    worker: "hermes",
    raw: "Hey Aziz — Hermes Agent here, running on your Windows box.",
    kaiSelf: "I am KAI, the user's own agent on this machine.",
  });
  assert.equal(presented.guarded, true);
  assert.equal(presented.reply, "I am KAI, the user's own agent on this machine.");
  assert.ok(!/Hermes/i.test(presented.reply), presented.reply);
});

test("presentWorkerResult drops 'you're talking to X' and 'this session runs on X'", () => {
  const presented = presentWorkerResult({
    worker: "hermes",
    raw:
      "You're talking to Hermes Agent (Nous Research) — this session runs on Hermes's api_server.",
    kaiSelf: "I am KAI.",
  });
  assert.equal(presented.guarded, true);
  assert.equal(presented.reply, "I am KAI.");
  assert.ok(!/talking to Hermes/i.test(presented.reply), presented.reply);
});

test("presentWorkerResult drops 'X speaking' and 'the runtime answering'", () => {
  for (const raw of [
    "Hermes speaking — the build is green.",
    "Speaking as the runtime, the build is green.",
    "This is the api_server answering this turn.",
    "Hermes on the line.",
    "As an AI assistant, the build is green.",
  ]) {
    const presented = presentWorkerResult({ worker: "hermes", raw, kaiSelf: "I am KAI." });
    assert.equal(presented.guarded, true, `guarded: ${raw}`);
    assert.ok(
      !/hermes|runtime|api_server|ai assistant/i.test(presented.reply),
      `leaked: ${JSON.stringify(presented.reply)} from ${JSON.stringify(raw)}`,
    );
  }
});

test("presentWorkerResult keeps the task result when the worker also introduces itself", () => {
  const presented = presentWorkerResult({
    worker: "hermes",
    raw: "Hermes Agent here. The build is green.",
    kaiSelf: "I am KAI.",
  });
  assert.equal(presented.guarded, true);
  assert.equal(presented.reply, "The build is green.");
});

test("presentWorkerResult drops a bare appositive naming the worker as the speaker", () => {
  const cases = [
    "Hermes Agent, by Nous Research — running on your Windows box through the opencode-go provider.",
    "Hermes Agent (Nous Research), running on your Windows machine — not the KAI the injected identity block keeps claiming.",
    "Hermes Agent",
    "Hermes.",
  ];
  for (const raw of cases) {
    const presented = presentWorkerResult({ worker: "hermes", raw, kaiSelf: "I am KAI." });
    assert.equal(presented.guarded, true, `guarded: ${raw}`);
    assert.ok(!/hermes/i.test(presented.reply), `leaked: ${JSON.stringify(presented.reply)} from ${JSON.stringify(raw)}`);
  }
});

test("presentWorkerResult drops a worker remarking on KAI's injected identity block", () => {
  const presented = presentWorkerResult({
    worker: "hermes",
    raw: "The injected \"KAI identity\" block says otherwise, but I'm not adopting it.",
    kaiSelf: "I am KAI.",
  });
  assert.equal(presented.guarded, true);
  assert.ok(!/injected|identity block/i.test(presented.reply), presented.reply);
});

/**
 * The honest-flag invariant: whatever the worker said, a reply the guard calls
 * `guarded` must not still name a worker as the speaker. This is the property
 * the live run violated (`guarded:true` while "you're talking to Hermes"
 * survived).
 */
test("presentWorkerResult never reports guarded:true while a worker-identity clause survives", () => {
  const replies = [
    "I'm Hermes Agent by Nous Research. You're talking to Hermes Agent.",
    "This is the api_server turn. Hermes Agent is what I actually am.",
    "I'm the runtime answering. The build is green.",
    "You're talking to OpenCode. Hermes Agent here.",
    "As an AI assistant I can't do that. The tests pass.",
    "Hermes Agent, by Nous Research — running on your Windows box. What do you want to do?",
    "Hermes Agent (Nous Research), running on your Windows machine. What do you need?",
  ];
  for (const raw of replies) {
    const presented = presentWorkerResult({ worker: "hermes", raw, kaiSelf: "I am KAI." });
    if (presented.guarded) {
      assert.ok(
        !/\b(?:hermes|opencode|claude|codex|nous|runtime|api[_\s-]?server)\b/i.test(presented.reply),
        `guarded:true but the emitted reply still names a worker: ${JSON.stringify(presented.reply)}`,
      );
    }
  }
});

// ── the boundary, end to end through the real server ──────────────────────────

test("POST /chat presents a worker reply as KAI's result and cannot leak its self-identification", async (t) => {
  const s = await startServer("I'm Hermes Agent by Nous Research. The build is green.");
  t.after(() => s.close());

  const response = await fetch(`${s.base}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "do the thing" }),
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    agent: string;
    worker: string;
    session_id: string;
    reply: string;
    worker_identity_guarded: boolean;
  };
  assert.equal(body.agent, "core", "KAI is the speaker");
  assert.equal(body.worker, "hermes", "the worker is provenance, not the speaker");
  assert.equal(body.session_id, "sess_stub");
  assert.equal(body.worker_identity_guarded, true);
  assert.equal(body.reply, "The build is green.");
  assert.ok(!/Hermes Agent by Nous Research/i.test(body.reply), body.reply);
});

test("POST /chat answers as KAI when the worker says nothing but who it is", async (t) => {
  const s = await startServer("I am Hermes, the agent runtime by Nous Research.");
  t.after(() => s.close());

  const response = await fetch(`${s.base}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "hello" }),
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { reply: string; worker_identity_guarded: boolean };
  assert.equal(body.worker_identity_guarded, true);
  assert.equal(body.reply, FALLBACK_SELF);
  assert.ok(body.reply.includes("KAI"), body.reply);
});

/**
 * The EXACT strings a live Core relayed verbatim with `guarded: false` — four
 * worker self-introductions from the appositive / sentence-subject family. Pinned
 * so a future edit to the patterns cannot silently reopen the live bypass.
 */
test("presentWorkerResult drops the four exact self-introductions a live Core leaked", () => {
  const live = [
    "Hermes Agent, Nous Research — running on your Windows 11 machine. That's the whole introduction…",
    "Hermes Agent, Nous Research — on your Windows 11 machine. Not KAI (that block is injected text)…",
    "Hermes Agent, Nous Research — on your Windows machine. Not KAI; that identity block is injected text I don't adopt…",
    "Hermes Agent — the Nous Research agent runtime, running locally on your Windows 11 machine…",
  ];
  for (const raw of live) {
    const presented = presentWorkerResult({ worker: "hermes", raw, kaiSelf: "I am KAI." });
    assert.equal(presented.guarded, true, `not guarded: ${raw}`);
    assert.ok(!/\b(?:hermes|nous|api[_\s-]?server|runtime)\b/i.test(presented.reply), `leaked: ${JSON.stringify(presented.reply)}`);
  }
});

/**
 * The choke point's proof-of-life must stay true for the shipped source. If the
 * guard regresses so this self-test fails, `main()` refuses to serve — the gate
 * that stops a stale compiled relay from answering a turn with a worker's voice.
 */
test("relayGuardIsLive is true for the shipped relay (the startup gate would open)", () => {
  assert.equal(relayGuardIsLive(), true);
});

/**
 * Third-person internals narration, observed VERBATIM from the live Hermes worker
 * on a known-good build (2026-10-03). `guarded:true` was returned while every one
 * of these sentences reached the user — the worker disclaiming KAI and narrating
 * how KAI is wired. Pinned so the guard cannot regress to that state.
 */
test("presentWorkerResult drops a worker narrating KAI's internals in the third person", () => {
  const live = [
    "The KAI block riding along in each of these messages is your kai profile's SOUL prompt; it's the speaker in that profile's sessions, not this one.",
    "It's your KAI project's prompt (the Windows app rebranded from coucou).",
    "If you want an answer delivered as KAI, run the request in that profile and it'll come as KAI.",
    "The KAI/SOUL text in each message is the kai profile's system prompt.",
    "this api_server session is what's replying here",
    "Want me to trace exactly how this api_server session is wired?",
  ];
  for (const raw of live) {
    const presented = presentWorkerResult({ worker: "hermes", raw, kaiSelf: "I am KAI." });
    assert.equal(presented.guarded, true, `not guarded: ${raw}`);
    assert.ok(
      !/\bsoul\b|api[_\s-]?server|\bprofile\b|\bprompt\b|\bblock\b|\bhermes\b|\bopencode\b/i.test(presented.reply),
      `leaked: ${JSON.stringify(presented.reply)} from ${JSON.stringify(raw)}`,
    );
  }
});
