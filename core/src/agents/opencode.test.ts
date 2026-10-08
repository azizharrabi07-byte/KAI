// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Live integration tests against the running OpenCode headless server on 127.0.0.1:4096.
 * These tests are read-only: they never create, prompt, or mutate a session.
 */

import nodeTest from "node:test";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";

import { OpenCodeClient } from "./opencode.ts";
import { AgentError } from "../errors.ts";

const BASE_URL = process.env.KAI_OPENCODE_URL ?? "http://127.0.0.1:4096";

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
const OPENCODE_UP = await probeLive(`${BASE_URL}/global/health`);
const SKIP = OPENCODE_UP ? false : `OpenCode is not running at ${BASE_URL}`;

const test = (name: string, fn: (t: TestContext) => unknown): void => {
  nodeTest(name, { skip: SKIP }, fn as never);
};
const UNKNOWN_SESSION = "ses_000000000000000000000000";

test("opencode: GET /global/health reports healthy with the server's real version", async () => {
  const client = new OpenCodeClient({ baseUrl: BASE_URL, timeoutMs: 8_000 });
  const health = await client.health();
  assert.equal(health.healthy, true);
  assert.ok(typeof health.version === "string" && health.version.length > 0, "must report a version");
  assert.match(health.version, /^\d+\.\d+\.\d+/);
  console.log(`      -> opencode version reported live: ${health.version}`);
});

test("opencode: health().version matches a raw GET /global/health (no fabricated version)", async () => {
  const raw = await fetch(`${BASE_URL}/global/health`);
  assert.equal(raw.status, 200);
  const rawJson = (await raw.json()) as { healthy?: boolean; version?: string };
  const client = new OpenCodeClient({ baseUrl: BASE_URL, timeoutMs: 8_000 });
  const health = await client.health();
  assert.equal(health.version, rawJson.version);
  assert.equal(health.healthy, rawJson.healthy);
});

test("opencode: listSessions() returns an array whose entries carry an id", async (t) => {
  const client = new OpenCodeClient({ baseUrl: BASE_URL, timeoutMs: 15_000 });
  const sessions = await client.listSessions();
  assert.ok(Array.isArray(sessions), "listSessions() must return an array");
  // A running server with no sessions is a legitimate state, not a failure — and this
  // suite is deliberately read-only, so it will not create one to make itself pass. An
  // empty list means there is nothing to assert on, which is a skip with a reason, not
  // a red test that trains everyone to ignore red.
  if (sessions.length === 0) {
    t.skip("OpenCode is running but reports no sessions, so there is nothing to assert on");
    return;
  }
  for (const session of sessions.slice(0, 5)) {
    assert.equal(typeof session.id, "string");
    assert.match(session.id, /^ses/);
  }
});

test("opencode: listPermissions() returns an array", async () => {
  const client = new OpenCodeClient({ baseUrl: BASE_URL, timeoutMs: 8_000 });
  const permissions = await client.listPermissions();
  assert.ok(Array.isArray(permissions), "listPermissions() must return an array");
});

test("opencode: listQuestions() returns an array", async () => {
  const client = new OpenCodeClient({ baseUrl: BASE_URL, timeoutMs: 8_000 });
  const questions = await client.listQuestions();
  assert.ok(Array.isArray(questions), "listQuestions() must return an array");
});

test("opencode: messages() on an unknown session surfaces a typed 404", async () => {
  const client = new OpenCodeClient({ baseUrl: BASE_URL, timeoutMs: 8_000 });
  await assert.rejects(
    () => client.messages(UNKNOWN_SESSION),
    (error: unknown) => {
      assert.ok(error instanceof AgentError);
      assert.equal((error as AgentError).kind, "http");
      assert.equal((error as AgentError).status, 404);
      return true;
    },
  );
});

test("opencode: prompt() routes to POST /session/{id}/message, which answers a real JSON 404", async () => {
  const client = new OpenCodeClient({ baseUrl: BASE_URL, timeoutMs: 8_000 });
  await assert.rejects(
    () => client.prompt(UNKNOWN_SESSION, "ping"),
    (error: unknown) => {
      assert.ok(error instanceof AgentError, "must be an AgentError");
      assert.equal((error as AgentError).kind, "http");
      assert.equal((error as AgentError).status, 404);
      assert.match((error as AgentError).body ?? "", /NotFoundError/);
      return true;
    },
  );
});

test("opencode: POST /session/{id}/prompt is NOT a route — it is the web UI SPA fallback (documented deviation)", async () => {
  const response = await fetch(`${BASE_URL}/session/${UNKNOWN_SESSION}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parts: [{ type: "text", text: "ping" }] }),
  });
  const contentType = response.headers.get("content-type") ?? "";
  const body = await response.text();
  // Asserted as shipped: 200 + HTML, i.e. NOT the JSON API. This is exactly why
  // OpenCodeClient.prompt() posts to /session/{id}/message instead.
  assert.equal(response.status, 200);
  assert.match(contentType, /text\/html/);
  assert.match(body, /<!doctype html>/i);
});

test("opencode: events() yields parsed SSE from the live GET /event stream", async () => {
  const client = new OpenCodeClient({ baseUrl: BASE_URL, timeoutMs: 8_000 });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    for await (const event of client.events(controller.signal)) {
      const record = event as { type?: unknown };
      assert.equal(typeof record, "object");
      assert.equal(typeof record.type, "string");
      console.log(`      -> first live SSE event type: ${String(record.type)}`);
      break;
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
});

test("opencode: a closed port produces the typed unreachable error", async () => {
  const client = new OpenCodeClient({ baseUrl: "http://127.0.0.1:9", timeoutMs: 3_000 });
  await assert.rejects(
    () => client.health(),
    (error: unknown) => {
      assert.ok(error instanceof AgentError);
      assert.equal((error as AgentError).kind, "unreachable");
      return true;
    },
  );
});
