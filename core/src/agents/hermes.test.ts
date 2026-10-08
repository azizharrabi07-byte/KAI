// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Live integration tests against the running Hermes Agent api-server on 127.0.0.1:8642.
 * The key is read from the environment only and is never written, printed, or asserted on.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { HermesClient } from "./hermes.ts";
import { AgentError } from "../errors.ts";

const BASE_URL = process.env.KAI_HERMES_URL ?? "http://127.0.0.1:8642";
const KEY = process.env.KAI_HERMES_KEY ?? process.env.API_SERVER_KEY;

test("hermes: GET /health answers ok with no auth", async () => {
  const client = new HermesClient({ baseUrl: BASE_URL, apiKey: undefined, timeoutMs: 8_000 });
  const health = await client.health();
  assert.equal(health.status, "ok");
  assert.equal(health.platform, "hermes-agent");
});

test("hermes: authenticated GET /v1/models lists the hermes-agent model", async () => {
  assert.ok(typeof KEY === "string" && KEY.length > 0, "KAI_HERMES_KEY/API_SERVER_KEY must be set");
  const client = new HermesClient({ baseUrl: BASE_URL, apiKey: KEY, timeoutMs: 8_000 });
  const models = await client.models();
  assert.ok(Array.isArray(models), "models() must return an array");
  assert.ok(models.length > 0, "models() must not be empty");
  assert.ok(models.some((model) => model.id === "hermes-agent"), "must expose hermes-agent");
  // The key must never survive into a returned payload.
  assert.ok(!JSON.stringify(models).includes(KEY), "the API key must never appear in output");
});

test("hermes: authenticated GET /v1/capabilities is an object", async () => {
  const client = new HermesClient({ baseUrl: BASE_URL, apiKey: KEY, timeoutMs: 8_000 });
  const capabilities = await client.capabilities();
  assert.equal(typeof capabilities, "object");
  assert.equal(capabilities["platform"], "hermes-agent");
});

test("hermes: listSessions() returns sessions carrying an id", async () => {
  const client = new HermesClient({ baseUrl: BASE_URL, apiKey: KEY, timeoutMs: 15_000 });
  const sessions = await client.listSessions();
  assert.ok(Array.isArray(sessions));
  assert.ok(sessions.length > 0, "there must be at least one existing session to assert on");
  for (const session of sessions.slice(0, 5)) {
    assert.equal(typeof session.id, "string");
    assert.ok(session.id.length > 0);
  }
});

test("hermes: sessionMessages() on a real session returns an array", async () => {
  const client = new HermesClient({ baseUrl: BASE_URL, apiKey: KEY, timeoutMs: 20_000 });
  const sessions = await client.listSessions();
  const session = sessions.find((s) => typeof s["message_count"] === "number") ?? sessions[0];
  assert.ok(session !== undefined);
  const messages = await client.sessionMessages(session.id);
  assert.ok(Array.isArray(messages), "sessionMessages() must return an array");
});

test("hermes: a wrong key produces the typed unauthorized error, never a crash", async () => {
  const wrong = "0".repeat(32);
  const client = new HermesClient({ baseUrl: BASE_URL, apiKey: wrong, timeoutMs: 8_000 });
  await assert.rejects(
    () => client.models(),
    (error: unknown) => {
      assert.ok(error instanceof AgentError, "must be an AgentError");
      assert.equal((error as AgentError).kind, "unauthorized");
      assert.equal((error as AgentError).status, 401);
      return true;
    },
  );
});

test("hermes: a closed port produces the typed unreachable error", async () => {
  const client = new HermesClient({ baseUrl: "http://127.0.0.1:9", apiKey: KEY, timeoutMs: 3_000 });
  await assert.rejects(
    () => client.health(),
    (error: unknown) => {
      assert.ok(error instanceof AgentError);
      assert.equal((error as AgentError).kind, "unreachable");
      return true;
    },
  );
});

test("hermes: POST /api/sessions rejects an invalid id with a 400 (route verified, nothing created)", async () => {
  const client = new HermesClient({ baseUrl: BASE_URL, apiKey: KEY, timeoutMs: 10_000 });
  await assert.rejects(
    () => client.createSession({ id: "kai-core/../invalid" }),
    (error: unknown) => {
      assert.ok(error instanceof AgentError);
      assert.equal((error as AgentError).kind, "http");
      assert.equal((error as AgentError).status, 400);
      return true;
    },
  );
});

test("hermes: POST /api/sessions/{id}/chat on an unknown session answers 404 (route verified, no turn run)", async () => {
  const client = new HermesClient({ baseUrl: BASE_URL, apiKey: KEY, timeoutMs: 10_000 });
  await assert.rejects(
    () => client.sendChat("kai_core_nonexistent_session", "ping"),
    (error: unknown) => {
      assert.ok(error instanceof AgentError);
      assert.equal((error as AgentError).kind, "http");
      assert.equal((error as AgentError).status, 404);
      return true;
    },
  );
});
