// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * GET /recovery/status — the reporting defect (regression).
 *
 * The acceptance ledger holds settled history: records that crossed the
 * acceptance boundary and COMPLETED. The endpoint used to answer
 * `total: open.length`, so a ledger that was working perfectly — one settled
 * record and nothing left to decide — reported `{ open: [], total: 0 }`. That
 * looked like "the ledger is empty/broken" and sent two investigations after
 * the wrong thing. The contract pinned here is explicit about both fields:
 *
 *   open  = the records that still need a recovery decision (status RUNNING)
 *   total = EVERY persisted record (settled + open)
 *
 * The settled record must remain visible on the ledger — the fix reports
 * honestly, it does not delete or rewrite rows to make the numbers agree.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCoreRuntime } from "../src/runtime.ts";
import { createCoreApi } from "../src/api/routes.ts";
import type { CoreRuntime } from "../src/runtime.ts";
import type { CoreApi } from "../src/api/routes.ts";
import type { ExecutionRecord } from "../src/recovery/ledger.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "kai-recovery-status-"));
}

function boot(dir: string): { rt: CoreRuntime; api: CoreApi } {
  const rt = createCoreRuntime({
    dbPath: join(dir, "core.db"),
    agents: { mode: "mock" },
    startScheduler: false,
    subsystemPaths: { runUpkeepOnStart: false, ledgerPath: join(dir, "recovery-ledger.db") },
  });
  return { rt, api: createCoreApi(rt) };
}

async function status(api: CoreApi): Promise<{ ledger: string; open: ExecutionRecord[]; total: number }> {
  const resp = await api.handle({ method: "GET", path: "/recovery/status", query: new URLSearchParams() });
  assert.equal(resp.status, 200, JSON.stringify(resp.body));
  return resp.body as { ledger: string; open: ExecutionRecord[]; total: number };
}

test("GET /recovery/status: a settled record is NOT open, but it IS in total", async () => {
  const dir = tempDir();
  const { rt, api } = boot(dir);
  try {
    // A real, settled, side-effecting execution — the exact state the live
    // ledger was in when the endpoint reported total: 0.
    const id = "exec_mission_demo_step_0";
    rt.recovery.begin({
      executionId: id,
      kind: "mission_step",
      refId: "mission_demo",
      stepId: "step_0",
      sideEffecting: true,
    });
    rt.recovery.accept(id);
    rt.recovery.complete(id);

    const settled = rt.recovery.get(id);
    assert.equal(settled?.status, "COMPLETED");
    assert.equal(settled?.phase, "AFTER_ACCEPT");

    const body = await status(api);
    assert.equal(body.ledger, rt.recovery.path, "the endpoint names the ledger it read");
    assert.deepEqual(body.open, [], "a settled record still needs no recovery decision");
    assert.equal(body.total, 1, "the settled record is part of the ledger total");

    // The settled history is still visible (not deleted or rewritten).
    assert.equal(rt.recovery.listAll().length, 1);
    assert.equal(rt.recovery.listAll()[0]?.executionId, id);
    assert.equal(rt.recovery.listOpen().length, 0);
  } finally {
    await rt.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GET /recovery/status: an unresolved record appears in open AND in total", async () => {
  const dir = tempDir();
  const { rt, api } = boot(dir);
  try {
    // One settled record...
    rt.recovery.begin({ executionId: "settled", kind: "mission_step", sideEffecting: true });
    rt.recovery.accept("settled");
    rt.recovery.complete("settled");
    // ...and one that began but never settled (RUNNING = still open).
    rt.recovery.begin({ executionId: "open_one", kind: "mission_step", sideEffecting: true });

    const body = await status(api);
    assert.equal(body.open.length, 1, "the unresolved record is open");
    assert.equal(body.open[0]?.executionId, "open_one");
    assert.equal(body.total, 2, "total counts settled AND open records");
    assert.equal(rt.recovery.listAll().length, 2);
  } finally {
    await rt.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
