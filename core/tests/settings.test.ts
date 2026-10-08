// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

// KAI's own persisted settings: allowlist validation, precedence with sources,
// SQLite durability across a restart, the parking policy boundary over live
// HTTP, and the live effect on inference (the next turn uses the new model).
//
//   cd core && node --test tests/settings.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { createCoreRuntime } from "../src/runtime.ts";
import { createKaiServer } from "../src/server.ts";
import { loadConfig } from "../src/config.ts";
import { MODEL_DEFAULTS } from "../src/model/config.ts";

function freshDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function boot(dir: string, model?: { fetchImpl?: typeof fetch; name?: string }) {
  return createCoreRuntime({
    dbPath: join(dir, "core.db"),
    agents: { mode: "mock" },
    startScheduler: false,
    ...(model !== undefined ? { model } : {}),
    subsystemPaths: { runUpkeepOnStart: false, ledgerPath: join(dir, "ledger.db") },
  });
}

test("validation: unknown keys and bad values are refused, nothing is written", async (t) => {
  const dir = freshDir("kai-settings-val-");
  const rt = boot(dir);
  await rt.start();
  t.after(async () => {
    await rt.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  assert.equal(rt.settings.set({ "nope.key": "x" }).ok, false);
  assert.equal(rt.settings.set({ "model.name": "" }).ok, false);
  assert.equal(rt.settings.set({ "model.baseUrl": "ftp://evil/x" }).ok, false);
  assert.equal(rt.settings.set({ "model.baseUrl": "not a url" }).ok, false);
  assert.equal(rt.settings.set({ "model.timeoutMs": 5 }).ok, false);
  assert.equal(rt.settings.set({ "model.timeoutMs": 999999999 }).ok, false);
  assert.equal(rt.settings.set({}).ok, false);
  assert.deepEqual(rt.settings.stored(), [], "refusals write nothing");
});

test("precedence: settings row beats env/file/defaults, and sources are reported", async (t) => {
  const dir = freshDir("kai-settings-prec-");
  const rt = boot(dir);
  await rt.start();
  t.after(async () => {
    await rt.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  const bare = rt.settings.effective({}, dir);
  assert.equal(bare.values.name, MODEL_DEFAULTS.NAME);
  assert.equal(bare.sources.name, "defaults");

  const fromEnv = rt.settings.effective({ KAI_MODEL_NAME: "env-model" }, dir);
  assert.equal(fromEnv.values.name, "env-model");
  assert.equal(fromEnv.sources.name, "environment");

  const set = rt.settings.set({ "model.name": "db-model" });
  assert.equal(set.ok, true);
  const over = rt.settings.effective({ KAI_MODEL_NAME: "env-model" }, dir);
  assert.equal(over.values.name, "db-model");
  assert.equal(over.sources.name, "settings");

  const overrides = rt.settings.modelOverrides();
  assert.equal(overrides.name, "db-model");
  assert.equal(overrides.baseUrl, undefined);
});

test("durability: a stored patch survives a full runtime restart on the same database", async (t) => {
  const dir = freshDir("kai-settings-restart-");
  const rt = boot(dir);
  await rt.start();
  const set = rt.settings.set({ "model.name": "survivor", "model.timeoutMs": 45000 });
  assert.equal(set.ok, true);
  await rt.stop();

  const rt2 = boot(dir);
  await rt2.start();
  t.after(async () => {
    await rt2.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const eff = rt2.settings.effective({}, dir);
  assert.equal(eff.values.name, "survivor");
  assert.equal(eff.values.timeoutMs, 45000);
  assert.equal(eff.sources.name, "settings");
});

test("reset: clearing reveals the layer below", async (t) => {
  const dir = freshDir("kai-settings-reset-");
  const rt = boot(dir);
  await rt.start();
  t.after(async () => {
    await rt.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  rt.settings.set({ "model.name": "temp", "model.timeoutMs": 45000 });
  const one = rt.settings.reset(["model.name"]);
  assert.equal(one.ok, true);
  assert.deepEqual(one.value.cleared, ["model.name"]);
  assert.equal(one.value.effective.values.name, MODEL_DEFAULTS.NAME);
  assert.equal(one.value.effective.values.timeoutMs, 45000);
  const all = rt.settings.reset([]);
  assert.deepEqual(all.value.cleared, ["model.timeoutMs"]);
  assert.equal(all.value.effective.values.timeoutMs, MODEL_DEFAULTS.TIMEOUT_MS);
});

test("LIVE HTTP: POST parks without approval, executes with one, GET reports sources", async (t) => {
  const dir = freshDir("kai-settings-http-");
  const rt = boot(dir);
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
  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  const parked = await post("/settings", { "model.name": "parked-model" });
  assert.equal(parked.status, 409, "a settings change parks for a human");
  assert.equal(parked.body.approvalRequired, true);
  assert.equal(typeof parked.body.approvalId, "string");
  assert.equal(rt.settings.stored().length, 0, "a parked change writes nothing");

  const bad = await post("/settings", { "nope.key": "x" });
  assert.equal(bad.status, 400, "an unknown key is a 400, not a park");

  const decided = await post(`/approvals/${parked.body.approvalId}/decide`, { approved: true });
  assert.equal(decided.status, 200);
  const applied = await post("/settings", { "model.name": "approved-model", approvalId: parked.body.approvalId });
  assert.equal(applied.status, 200);

  const got = (await (await fetch(`${base}/settings`)).json()) as {
    stored: Array<{ key: string; value: string }>;
    effective: { values: { name: string }; sources: { name: string } };
  };
  assert.ok(got.stored.some((row) => row.key === "model.name" && row.value === "approved-model"));
  assert.equal(got.effective.values.name, "approved-model");
  assert.equal(got.effective.sources.name, "settings");
});

test("live effect: the next inference call carries the persisted model name", async (t) => {
  const dir = freshDir("kai-settings-live-");
  const seen: string[] = [];
  const rt = boot(dir, {
    fetchImpl: (async (url: unknown, init?: { body?: unknown }) => {
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { model?: string }) : {};
      if (typeof body.model === "string") seen.push(body.model);
      return new Response(
        JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch,
  });
  await rt.start();
  t.after(async () => {
    await rt.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  await rt.model.chat({ messages: [{ role: "user", content: "hi" }] });
  assert.ok(seen.length > 0 && !seen[seen.length - 1]!.includes("overridden"), "baseline uses the default name");

  const set = rt.settings.set({ "model.name": "overridden-live-model" });
  assert.equal(set.ok, true);
  await rt.model.chat({ messages: [{ role: "user", content: "hi again" }] });
  assert.equal(seen[seen.length - 1], "overridden-live-model", "the persisted name reaches the next call with no restart");
});
