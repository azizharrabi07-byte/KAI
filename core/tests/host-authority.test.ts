// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The chat relay's host authority (FALSIFIED 1b).
 *
 * `POST /chat` is loopback-only but otherwise unauthenticated, and the island's
 * chat genuinely comes from the user — so the host-attested learning call is
 * legitimate IN PRINCIPLE and must keep working for the app. What must not
 * happen is an arbitrary local process borrowing that authority by POSTing to
 * the same route.
 *
 * The fix: the Core reads a shared token (`KAI_HOST_TOKEN`) exactly as it reads
 * the Hermes key, and the relay claims user authority ONLY for a request that
 * carries the matching `x-kai-host-token` header. This file pins both halves:
 *
 *   - unauthenticated → NO user-authority learning, and the legacy
 *     `memory.remember` write is not reached either;
 *   - the host-attested path → the turn IS learned.
 *
 * Plain `node --test`; the server is bound to an ephemeral loopback port.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { createCoreRuntime } from "../src/runtime.ts";
import { createKaiServer } from "../src/server.ts";
import { loadConfig } from "../src/config.ts";

const HOST_TOKEN = "test-host-token-0123456789";

function bootRuntime(dir: string): ReturnType<typeof createCoreRuntime> {
  return createCoreRuntime({
    dbPath: join(dir, "kai.db"),
    agents: { mode: "mock" },
    startScheduler: false,
    subsystemPaths: { runUpkeepOnStart: false },
  });
}

/** Poll a predicate until it holds or the budget runs out. */
async function waitFor(fn: () => boolean, ms = 2000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return fn();
}

test("an unauthenticated caller cannot obtain user-authority learning; the host path can", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kai-host-authority-"));
  const runtime = bootRuntime(dir);
  const config = loadConfig({ KAI_HOST_TOKEN: HOST_TOKEN } as NodeJS.ProcessEnv);
  const server = createKaiServer(config, { core: runtime });
  await runtime.start();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const post = (text: string, headers: Record<string, string> = {}) =>
    fetch(`${base}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ text }),
    });

  // ── 1. Unauthenticated: the exact falsification shape ─────────────────────
  const unauthText = `remember that host-probe-unauth-${Date.now()} is my favourite colour`;
  const unauth = await post(unauthText);
  assert.equal(unauth.status, 200, "the relay still answers the turn");
  const unauthBody = (await unauth.json()) as { intent: string; reply: string };
  assert.equal(unauthBody.intent, "memory.remember");
  assert.match(unauthBody.reply, /comes from KAI itself/i, "it says plainly it did not record it as the user's");

  // Give any (incorrectly) fire-and-forget learning a chance to land first.
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(
    runtime.memoryEngine.search({ text: "host-probe-unauth" }).length,
    0,
    "no canonical entry may be created for an unauthenticated caller",
  );
  assert.equal(
    runtime.memory.search({ text: "host-probe-unauth" }).length,
    0,
    "the legacy memory.remember write must not be reached either",
  );

  // ── 2. Host-attested: the app's own path still learns ─────────────────────
  const authText = `remember that host-probe-auth-${Date.now()} is my favourite colour`;
  const auth = await post(authText, { "x-kai-host-token": HOST_TOKEN });
  assert.equal(auth.status, 200);
  const landed = await waitFor(() => runtime.memoryEngine.search({ text: "host-probe-auth" }).length > 0);
  assert.equal(landed, true, "a host-attested turn is learned through the live engine");

  // The learned entry carries no user authority in the memory store: the learning
  // pipeline records a model candidate, and the engine never invents provenance.
  const hit = runtime.memoryEngine.search({ text: "host-probe-auth" })[0];
  assert.ok(hit, "the host-attested entry exists");
  assert.notEqual(hit?.entry.provenance, "user_statement");
});

test("with no token configured the relay fails closed (nothing is learned)", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kai-host-authority-none-"));
  const runtime = bootRuntime(dir);
  const config = loadConfig({} as NodeJS.ProcessEnv);
  const server = createKaiServer(config, { core: runtime });
  await runtime.start();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  // Even a caller that guesses the header name cannot authenticate.
  const res = await fetch(`http://127.0.0.1:${port}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-kai-host-token": HOST_TOKEN },
    body: JSON.stringify({ text: `remember that host-probe-none-${Date.now()} is my favourite colour` }),
  });
  assert.equal(res.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(runtime.memoryEngine.search({ text: "host-probe-none" }).length, 0);
});
