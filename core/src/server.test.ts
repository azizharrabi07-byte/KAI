// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Live tests for the KAI Core HTTP server. Each test starts the real server on an
 * ephemeral 127.0.0.1 port and drives it over real HTTP.
 */

import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createKaiServer } from "./server.ts";
import { createCoreRuntime } from "./runtime.ts";
import { loadConfig, type KaiConfig } from "./config.ts";

const DEAD = { KAI_HERMES_URL: "http://127.0.0.1:9", KAI_OPENCODE_URL: "http://127.0.0.1:9" };

/**
 * These are LIVE tests: they need the server actually running. When it is not, they
 * SKIP with a reason instead of failing, so a stopped server is not reported as a
 * broken KAI. Nothing is hidden by this: a skipped test is not a green test, and the
 * reason names exactly what was not verified.
 */
async function probeLive(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return res.status < 500;
  } catch {
    return false;
  }
}
const LIVE = {
  hermes: await probeLive("http://127.0.0.1:8642/health"),
  opencode: await probeLive("http://127.0.0.1:4096/global/health"),
};

async function start(config: KaiConfig): Promise<{ base: string; close: () => Promise<void> }> {
  const server = createKaiServer(config);
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

test("kai core: binds and GET /health aggregates both agents", { skip: LIVE.hermes && LIVE.opencode ? false : "needs both live agents" }, async (t) => {
  const s = await start(loadConfig(process.env));
  t.after(() => s.close());

  const response = await fetch(`${s.base}/health`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  const body = (await response.json()) as {
    service: string;
    status: string;
    hermes: { reachable: boolean; authorized: boolean; version: string | null };
    opencode: { reachable: boolean; version: string | null };
  };
  assert.equal(body.service, "kai-core");
  assert.equal(body.hermes.reachable, true, "hermes must be reachable");
  assert.equal(body.hermes.authorized, true, "hermes must accept the configured bearer key");
  assert.equal(body.opencode.reachable, true, "opencode must be reachable");
  assert.ok(typeof body.opencode.version === "string");
  console.log(`      -> /health: hermes=${JSON.stringify(body.hermes)} opencode=${JSON.stringify(body.opencode)}`);
});

test("kai core: GET /integrations mirrors the aggregate", async (t) => {
  const s = await start(loadConfig(process.env));
  t.after(() => s.close());

  const response = await fetch(`${s.base}/integrations`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { service: string; hermes: { reachable: boolean } };
  assert.equal(body.service, "kai-core");
  // The contract here is "mirrors the aggregate", NOT "hermes is up". Assert the mirror
  // unconditionally, and require reachability only when Hermes is actually running.
  //
  // Without the guard this test failed for an ENVIRONMENT reason (Hermes down) and read as a
  // code regression -- it violated the convention every other live-agent test in this file
  // follows (see the skip guard on the test immediately below). It was briefly misdiagnosed as
  // a failure of the /core/events replay test; it was not, and the replay test passes.
  const health = (await (await fetch(`${s.base}/health`)).json()) as { hermes: { reachable: boolean } };
  assert.equal(body.hermes.reachable, health.hermes.reachable, "integrations must mirror /health");
  if (LIVE.hermes) {
    assert.equal(body.hermes.reachable, true, "hermes must be reachable when it is running");
  }
});

test("kai core: GET /agents/hermes/sessions returns sessions with ids", { skip: LIVE.hermes ? false : "Hermes is not running" }, async (t) => {
  const s = await start(loadConfig(process.env));
  t.after(() => s.close());

  const response = await fetch(`${s.base}/agents/hermes/sessions`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { agent: string; data: Array<{ id: string }> };
  assert.equal(body.agent, "hermes");
  assert.ok(Array.isArray(body.data));
  assert.ok(body.data.length > 0);
  assert.equal(typeof body.data[0]?.id, "string");
});

test("kai core: GET /agents/opencode/sessions proxies the live session list", { skip: LIVE.opencode ? false : "OpenCode is not running" }, async (t) => {
  const s = await start(loadConfig(process.env));
  t.after(() => s.close());

  const response = await fetch(`${s.base}/agents/opencode/sessions`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { agent: string; data: Array<{ id: string }> };
  assert.equal(body.agent, "opencode");
  assert.ok(Array.isArray(body.data));
  // Same reasoning as the client suite: the proxy is proven by the array passing
  // through; a server that happens to have no sessions cannot evidence an id.
  if (body.data.length === 0) {
    t.skip("OpenCode reports no sessions, so the proxied list cannot be checked for ids");
    return;
  }
  assert.match(body.data[0]?.id ?? "", /^ses/);
});

test("kai core: GET /agents/opencode/permissions passes the array through", { skip: LIVE.opencode ? false : "OpenCode is not running" }, async (t) => {
  const s = await start(loadConfig(process.env));
  t.after(() => s.close());

  const response = await fetch(`${s.base}/agents/opencode/permissions`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { data: unknown[] };
  assert.ok(Array.isArray(body.data));
});

test("kai core: POST /agents/opencode/permissions/:id/reply validates the reply enum", async (t) => {
  const s = await start(loadConfig(process.env));
  t.after(() => s.close());

  const response = await fetch(`${s.base}/agents/opencode/permissions/per_000000000000000000000000/reply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reply: "definitely-not-a-reply" }),
  });
  assert.equal(response.status, 400);
  const body = (await response.json()) as { reason: string; allowed: string[] };
  assert.equal(body.reason, "invalid_reply");
  assert.deepEqual(body.allowed, ["once", "always", "reject"]);
});

test("kai core: CORS allows the Tauri dev origin and rejects every other origin", async (t) => {
  const s = await start(loadConfig(process.env));
  t.after(() => s.close());

  const allowed = await fetch(`${s.base}/health`, { headers: { origin: "http://localhost:1420" } });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get("access-control-allow-origin"), "http://localhost:1420");

  const allowed127 = await fetch(`${s.base}/health`, { headers: { origin: "http://127.0.0.1:1420" } });
  assert.equal(allowed127.headers.get("access-control-allow-origin"), "http://127.0.0.1:1420");

  const denied = await fetch(`${s.base}/health`, { headers: { origin: "http://evil.example.com" } });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get("access-control-allow-origin"), null);
  const deniedBody = (await denied.json()) as { reason: string };
  assert.equal(deniedBody.reason, "origin_not_allowed");
});

test("kai core: an unknown route answers 404 JSON, never HTML", async (t) => {
  const s = await start(loadConfig(process.env));
  t.after(() => s.close());

  const response = await fetch(`${s.base}/nope/does/not/exist`);
  assert.equal(response.status, 404);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  const body = (await response.json()) as { error: string; path: string };
  assert.equal(body.error, "not_found");
  assert.equal(body.path, "/nope/does/not/exist");
});

test("kai core: an unreachable upstream answers 502 JSON with a reason and no stack trace", async (t) => {
  const s = await start(loadConfig({ ...process.env, ...DEAD, KAI_OPENCODE_TIMEOUT_MS: "2500" }));
  t.after(() => s.close());

  const response = await fetch(`${s.base}/agents/opencode/sessions`);
  assert.equal(response.status, 502);
  const body = (await response.json()) as { error: string; target: string; reason: string; message: string };
  assert.equal(body.error, "bad_gateway");
  assert.equal(body.reason, "upstream_unreachable");
  assert.equal(body.target, "http://127.0.0.1:9");
  assert.ok(!/at .*\(.*:\d+:\d+\)/.test(body.message), "no stack trace may be leaked");

  const health = (await (await fetch(`${s.base}/health`)).json()) as {
    status: string;
    hermes: { reachable: boolean; reason: string };
    opencode: { reachable: boolean; reason: string };
  };
  assert.equal(health.status, "degraded");
  assert.equal(health.hermes.reachable, false);
  assert.equal(health.hermes.reason, "upstream_unreachable");
  assert.equal(health.opencode.reachable, false);
});

test("kai core: GET /events opens an SSE stream and emits kai.ready", async (t) => {
  const s = await start(loadConfig(process.env));
  t.after(() => s.close());

  const controller = new AbortController();
  const response = await fetch(`${s.base}/events`, { signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline && !text.includes("event: kai.ready")) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  controller.abort();
  assert.match(text, /event: kai\.ready/);
  assert.match(text, /kai-core/);
});

test("kai core: POST /chat rejects a body with no text", async (t) => {
  const s = await start(loadConfig(process.env));
  t.after(() => s.close());

  for (const body of [{}, { text: "" }, { text: "   " }, { text: 42 }, { text: "hi", session_id: 7 }]) {
    const response = await fetch(`${s.base}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 400, `body ${JSON.stringify(body)} must be refused`);
    const refusal = (await response.json()) as { error: string };
    assert.equal(refusal.error, "invalid_request");
  }

  // Known path, wrong method.
  const wrongMethod = await fetch(`${s.base}/chat`);
  assert.equal(wrongMethod.status, 405);
});

test("kai core: POST /chat runs a real turn through Hermes and returns the reply", { skip: LIVE.hermes ? false : "Hermes is not running" }, async (t) => {
  const s = await start(loadConfig(process.env));
  t.after(() => s.close());

  const token = "KAI-CORE-RELAY-OK";
  const response = await fetch(`${s.base}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: `Reply with exactly this token and nothing else: ${token}` }),
  });

  assert.equal(response.status, 200, "the control layer must answer");
  const body = (await response.json()) as {
    agent: string;
    worker: string;
    session_id: string;
    reply: string;
    usage: unknown;
  };
  // THE RELAY CONTRACT: KAI keeps the turn. A worker's output is KAI's RESULT,
  // so `agent` names the speaker (KAI Core) and the worker is provenance in
  // `worker`. The previous assertion `agent === "hermes"` encoded the defect
  // itself — it made the worker the speaker, which is exactly how "Who are you?"
  // came back as "Hermes Agent by Nous Research" speaking as the product.
  assert.equal(body.agent, "core", "KAI speaks; the worker is provenance, not the speaker");
  assert.equal(body.worker, "hermes");
  assert.ok(body.session_id.length > 0, "a session id must come back for the next turn");
  assert.equal(body.reply, token, `expected exactly ${token}, got ${JSON.stringify(body.reply)}`);
  console.log(`      -> /chat: session=${body.session_id} reply=${JSON.stringify(body.reply)}`);

  // A second turn on the same session proves the session id is reusable.
  const followUp = await fetch(`${s.base}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "What token did I just ask you to reply with?", session_id: body.session_id }),
  });
  assert.equal(followUp.status, 200);
  const second = (await followUp.json()) as { session_id: string; reply: string };
  assert.equal(second.session_id, body.session_id, "the same session must be reused");
  assert.ok(second.reply.includes(token), `the agent must remember the turn, got ${JSON.stringify(second.reply)}`);
  console.log(`      -> /chat (2nd turn, same session): ${JSON.stringify(second.reply)}`);
});

// ── the fourth link: a late client still receives startup events ───────────────

/**
 * The defect this pins: `runtime.start()` publishes the recovery notification
 * (`mission.recovery_blocked`, wire type `notification.created`) BEFORE the HTTP
 * listener exists, so a client that connects afterwards — which is every real
 * client, since it must first observe the Core is up — never saw it. The reducer,
 * the bridge and the event table can all be correct and RECOVERING is still
 * unreachable. `GET /core/events` therefore replays the bus's recent ring on
 * connect, in the SAME envelope, with no re-derivation and no second event model.
 */
test("kai core: GET /core/events replays events published before the client connected", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kai-sse-replay-"));
  const rt = createCoreRuntime({
    dbPath: join(dir, "core.db"),
    agents: { mode: "mock" },
    startScheduler: false,
    subsystemPaths: { runUpkeepOnStart: false, ledgerPath: join(dir, "recovery-ledger.db") },
  });
  // Model the startup publication exactly: publish BEFORE any client can connect.
  const published = rt.bus.publish(
    "notification.created",
    { type: "mission.recovery_blocked", title: "1 mission(s) need a decision", priority: "HIGH" },
    { source: "core" },
  );

  const server = createKaiServer(loadConfig(process.env), { core: rt });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  const controller = new AbortController();
  t.after(async () => {
    controller.abort();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rt.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  const response = await fetch(`http://127.0.0.1:${address.port}/core/events`, { signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && !text.includes("mission.recovery_blocked")) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }

  // The pre-connect event reached the post-connect client, in the SAME wire envelope.
  assert.match(text, /"type":"notification\.created"/, "the generic notification envelope is preserved");
  assert.match(text, /"mission\.recovery_blocked"/, "the semantic type survives inside payload.type");
  assert.match(text, new RegExp(published.id), "the exact published event id is replayed");

  // A NEW event still flows live on the same connection: replay did not replace it.
  const live = rt.bus.publish("mission.completed", { missionId: "mission_live" }, { source: "core" });
  let liveText = "";
  const liveDeadline = Date.now() + 5_000;
  while (Date.now() < liveDeadline && !liveText.includes(live.id)) {
    const { done, value } = await reader.read();
    if (done) break;
    liveText += decoder.decode(value, { stream: true });
  }
  assert.match(liveText, new RegExp(live.id), "live delivery is unaffected by the replay");
  await reader.cancel().catch(() => undefined);
});
