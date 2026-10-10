// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Server keep-alive window.
 *
 * A client derives its idle timeout from the server's `Keep-Alive: timeout=`
 * header — and the client here is undici, which backs `fetch` in the KAI UI and
 * in every probe. At Node's 5s default BOTH sides expire at the same instant, so
 * a client can pick up a socket the server is closing and get ECONNRESET.
 *
 * Measured, not argued: `scripts/orch-e2e.mjs` failed 3/3 runs at the first
 * request after its S6 burst (18 checks in, `ECONNRESET`), and passed 3/3 after
 * the window was raised. A 70s idle reuse against the raised window also
 * succeeds.
 *
 * Run from `core/`:  node --test tests/server-keepalive.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCoreRuntime } from "../src/runtime.ts";
import { createKaiServer } from "../src/server.ts";
import { loadConfig } from "../src/config.ts";

/** The client's idle expectation must stay well below this (Node default: 5s). */
const MIN_WINDOW_MS = 60_000;

test("the Core advertises a keep-alive window well above a client's idle default", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kai-keepalive-"));
  const rt = createCoreRuntime({
    dbPath: join(dir, "core.db"),
    agents: { mode: "mock" },
    startScheduler: false,
    subsystemPaths: { runUpkeepOnStart: false, ledgerPath: join(dir, "ledger.db") },
  });
  try {
    await rt.start();
    const server = createKaiServer(loadConfig(process.env), { core: rt });
    assert.ok(
      server.keepAliveTimeout >= MIN_WINDOW_MS,
      `keepAliveTimeout must outlast a client's idle window, got ${server.keepAliveTimeout}ms`,
    );
    assert.ok(
      server.headersTimeout >= server.keepAliveTimeout,
      `headersTimeout (${server.headersTimeout}ms) must not be below keepAliveTimeout (${server.keepAliveTimeout}ms)`,
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    try {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      assert.equal(res.status, 200);
      // This header is what the client reads to decide when to drop the socket.
      const header = res.headers.get("keep-alive") ?? "";
      const seconds = Number(/timeout=(\d+)/.exec(header)?.[1] ?? "0");
      assert.ok(seconds >= MIN_WINDOW_MS / 1000, `advertised keep-alive must be >= ${MIN_WINDOW_MS / 1000}s, got "${header}"`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    await rt.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
