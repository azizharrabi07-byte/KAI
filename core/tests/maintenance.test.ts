// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Self-maintenance.
 *
 * Two things are worth pinning, and one of them is a lesson this project already
 * paid for: a STALE Core once answered on the port while a newer build was
 * believed to serve it, and produced a wrong answer. The only durable defence is
 * to compare the build id the running process loaded against the build id
 * stamped on disk. That comparison is tested here in both directions.
 *
 * The rest is scope discipline: KAI reports what it can see, repairs only the
 * four things it owns in-process, and never claims more.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMaintenanceService } from "../src/maintenance/index.ts";
import { createCoreRuntime } from "../src/runtime.ts";
import { createCoreApi } from "../src/api/routes.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "kai-maintenance-"));
}

function service(over: { moduleDir: string; buildId: string }) {
  const calls = { upkeep: 0, scheduler: 0, missions: 0, views: 0 };
  const svc = createMaintenanceService({
    identity: () => ({ buildId: over.buildId, gitCommit: "deadbeef".repeat(5), protocolVersion: 1, pid: 4242 }),
    moduleDir: over.moduleDir,
    paths: { database: "db", ledger: "ledger", sessions: "sessions" },
    probeDatabase: () => ({ ok: true, detail: "readable" }),
    probeSessions: () => ({ ok: true, detail: "readable" }),
    probeAgents: () => ({ ok: false, detail: "no adapters" }),
    probeScheduler: () => ({ ok: true, detail: "running" }),
    probeLedger: () => ({ ok: true, detail: "readable" }),
    runMemoryUpkeep: () => { calls.upkeep += 1; },
    recoverScheduler: () => { calls.scheduler += 1; return { resumed: 2 }; },
    resumeMissions: async () => { calls.missions += 1; return { resumed: [], blocked: [] }; },
    syncViews: () => { calls.views += 1; },
  });
  return { svc, calls };
}

test("identity: a running build that matches the stamp on disk is current, a mismatch is STALE", () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "build-info.json"), JSON.stringify({ buildId: "aaaa1111bbbb2222" }), "utf8");

    const match = service({ moduleDir: dir, buildId: "aaaa1111bbbb2222" });
    assert.equal(match.svc.status().identity.current, true);
    assert.match(match.svc.status().identity.detail, /IS the build stamped on disk/);

    const stale = service({ moduleDir: dir, buildId: "0000000000000000" });
    const report = stale.svc.status();
    assert.equal(report.identity.current, false);
    assert.match(report.identity.detail, /STALE/);
    assert.equal(report.identity.onDiskBuildId, "aaaa1111bbbb2222");
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("an absent stamp is reported honestly rather than assumed to match", () => {
  const dir = tempDir();
  try {
    const s = service({ moduleDir: dir, buildId: "aaaa1111bbbb2222" });
    const id = s.svc.status().identity;
    assert.equal(id.onDiskBuildId, undefined);
    assert.equal(id.current, true, "with nothing to compare against it does not claim staleness");
    assert.match(id.detail, /no build stamp found/);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("status inspects and changes nothing; run performs the four repairs", async () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "build-info.json"), JSON.stringify({ buildId: "keep" }), "utf8");
    const { svc, calls } = service({ moduleDir: dir, buildId: "keep" });

    const inspected = svc.status();
    assert.equal(inspected.repairs.length, 0, "status performs no repair");
    assert.deepEqual(calls, { upkeep: 0, scheduler: 0, missions: 0, views: 0 });
    // An unreachable worker is a WARN, not a failure: KAI runs with a worker down.
    assert.equal(inspected.checks.find((c) => c.name === "agents")?.status, "warn");
    assert.equal(inspected.ok, true);

    const repaired = await svc.run();
    assert.deepEqual(calls, { upkeep: 1, scheduler: 1, missions: 1, views: 1 });
    assert.equal(repaired.repairs.length, 4);
    assert.ok(repaired.repairs.every((r) => r.performed), JSON.stringify(repaired.repairs));
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("a failing probe is a FAIL, and a repair that throws is reported as not performed", async () => {
  const dir = tempDir();
  try {
    const svc = createMaintenanceService({
      identity: () => ({ buildId: "x", gitCommit: "y", protocolVersion: 1, pid: 1 }),
      moduleDir: dir,
      paths: { database: "db", ledger: "l", sessions: "s" },
      probeDatabase: () => ({ ok: false, detail: "unreadable" }),
      probeSessions: () => ({ ok: true, detail: "readable" }),
      probeAgents: () => ({ ok: true, detail: "one" }),
      probeScheduler: () => ({ ok: true, detail: "running" }),
      probeLedger: () => ({ ok: true, detail: "readable" }),
      runMemoryUpkeep: () => { throw new Error("upkeep exploded"); },
      recoverScheduler: () => undefined,
      resumeMissions: async () => ({ resumed: [], blocked: [] }),
      syncViews: () => undefined,
    });
    const report = await svc.run();
    assert.equal(report.ok, false, "a failed check means the report is not ok");
    assert.equal(report.checks.find((c) => c.name === "database")?.status, "fail");
    const upkeep = report.repairs.find((r) => r.name === "memory-upkeep");
    assert.equal(upkeep?.performed, false);
    assert.match(upkeep?.detail ?? "", /upkeep exploded/);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("the runtime exposes self-maintenance, and the routes inspect and repair through the boundary", async (t) => {
  const dir = tempDir();
  const dbPath = join(dir, "kai.db");
  const runtime = createCoreRuntime({
    dbPath,
    agents: { mode: "mock" },
    startScheduler: false,
    subsystemPaths: { runUpkeepOnStart: false },
  });
  t.after(async () => {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const api = createCoreApi(runtime);
  const get = api.handle({ method: "GET", path: "/maintenance/status", query: new URLSearchParams(), attested: true, ownerAuthConfigured: true });
  const inspected = await get;
  assert.equal(inspected.status, 200, JSON.stringify(inspected.body));
  const report = (inspected.body as { maintenance: { checks: Array<{ name: string; status: string }>; identity: { current: boolean } } }).maintenance;
  assert.ok(report.checks.length >= 6, JSON.stringify(report.checks));
  assert.equal(report.identity.current, true, "the running source IS the build on disk");
  assert.ok(report.checks.some((c) => c.name === "sessions" && c.status === "pass"));
  assert.ok(report.checks.some((c) => c.name === "recovery-ledger" && c.status === "pass"));

  const ran = await api.handle({ method: "POST", path: "/maintenance/run", query: new URLSearchParams(), attested: true, ownerAuthConfigured: true, body: {} });
  assert.equal(ran.status, 200, JSON.stringify(ran.body));
  const repairs = (ran.body as { maintenance: { repairs: Array<{ name: string; performed: boolean }> } }).maintenance.repairs;
  assert.equal(repairs.length, 4, JSON.stringify(repairs));
  assert.ok(repairs.every((r) => r.performed), JSON.stringify(repairs));
});
