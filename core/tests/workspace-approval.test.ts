// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The workspace capabilities THROUGH the boundary, and the non-mission approval
 * resume (Phase 4 gaps 1 + 2), end to end over a real CoreRuntime.
 * Run from `core/`:  node --test tests/workspace-approval.test.ts
 *
 * Proves, with a real runtime and a real HTTP-shaped API:
 *   - a READ action runs unattended; a WRITE/DESTRUCTIVE one PARKS for a human;
 *   - the parked call is RECORDED durably (so it survives a restart);
 *   - an APPROVED verdict RE-ISSUES the exact call and the effect happens;
 *   - a REJECTED verdict runs nothing;
 *   - the "Allow" path completes for a NON-mission request (the reported defect).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCoreRuntime } from "../src/runtime.ts";
import { createCoreApi } from "../src/api/routes.ts";
import type { CoreApi } from "../src/api/routes.ts";
import { probeGit } from "../src/tools/workspace.ts";

function boot(dbPath: string) {
  return createCoreRuntime({
    dbPath,
    agents: { mode: "mock" },
    startScheduler: false,
    subsystemPaths: { runUpkeepOnStart: false },
  });
}

function post(api: CoreApi, path: string, body: unknown) {
  return api.handle({ method: "POST", path, query: new URLSearchParams(), body });
}

// ── (a) a non-mission approval actually re-issues the parked request ──────────

test("(a) capability filesystem.write parks, then an approval re-issues it and the file appears", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kai-ws-approval-"));
  const runtime = boot(join(dir, "kai.db"));
  t.after(async () => {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const api = createCoreApi(runtime);
  const target = join(dir, "written.txt");

  // First attempt: WRITE, so the capability tool parks and NOTHING is written.
  const parked = await post(api, "/capabilities/filesystem/test", {
    action: "write",
    input: { path: target, content: "from an approved write" },
  });
  assert.equal(parked.status, 409, JSON.stringify(parked.body));
  const approvalId = (parked.body as { approvalId: string }).approvalId;
  assert.equal(typeof approvalId, "string");
  assert.equal(existsSync(target), false, "the parked write must not have happened");

  // The runtime recorded EXACTLY what to replay.
  const record = runtime.parkedRequests.get(approvalId);
  assert.ok(record !== null, "the parked request must be recorded");
  assert.equal(record.toolId, "capability.filesystem");

  // The human allows it: the parked call is re-issued, not merely recorded.
  const decided = await post(api, `/approvals/${approvalId}/decide`, { approved: true });
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
  assert.equal((decided.body as { reissued: boolean }).reissued, true, JSON.stringify(decided.body));

  assert.equal(existsSync(target), true, "the approved write must have run");
  assert.equal(readFileSync(target, "utf8"), "from an approved write");
  // The record is consumed, so a second decision cannot run it again.
  assert.equal(runtime.parkedRequests.get(approvalId), null);
});

// ── (b) a rejection runs nothing ──────────────────────────────────────────────

test("(b) rejecting the approval runs nothing and consumes the parked request", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kai-ws-reject-"));
  const runtime = boot(join(dir, "kai.db"));
  t.after(async () => {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const api = createCoreApi(runtime);
  const target = join(dir, "never.txt");

  const parked = await post(api, "/capabilities/filesystem/test", {
    action: "write",
    input: { path: target, content: "should not exist" },
  });
  assert.equal(parked.status, 409);
  const approvalId = (parked.body as { approvalId: string }).approvalId;

  const decided = await post(api, `/approvals/${approvalId}/decide`, { approved: false });
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
  assert.equal((decided.body as { reissued: boolean }).reissued, false);
  assert.equal(existsSync(target), false);
  assert.equal(runtime.parkedRequests.get(approvalId), null);
});

// ── (c) the parked request survives a restart (crash recovery) ────────────────

test("(c) a parked request survives a Core restart and is re-issued afterwards", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kai-ws-restart-"));
  const dbPath = join(dir, "kai.db");
  const target = join(dir, "after-restart.txt");
  let runtime2: ReturnType<typeof boot> | undefined;
  t.after(async () => {
    if (runtime2 !== undefined) await runtime2.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const runtime1 = boot(dbPath);
  const api1 = createCoreApi(runtime1);

  const parked = await post(api1, "/capabilities/filesystem/test", {
    action: "write",
    input: { path: target, content: "survived the restart" },
  });
  assert.equal(parked.status, 409);
  const approvalId = (parked.body as { approvalId: string }).approvalId;
  await runtime1.stop();

  // A NEW Core over the same files boots; its startup sweep must NOT drop a live
  // PENDING approval, so the parked request is still there.
  runtime2 = boot(dbPath);
  await runtime2.start();
  assert.ok(runtime2.parkedRequests.get(approvalId) !== null, "the parked request must survive a restart");

  const api2 = createCoreApi(runtime2);
  const decided = await post(api2, `/approvals/${approvalId}/decide`, { approved: true });
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
  assert.equal((decided.body as { reissued: boolean }).reissued, true, JSON.stringify(decided.body));
  assert.equal(existsSync(target), true, "the re-issued write must have run after the restart");
  assert.equal(readFileSync(target, "utf8"), "survived the restart");
});

// ── (d) a DESTRUCTIVE shell action goes through the SAME path ─────────────────

test("(d) capability shell.run is DESTRUCTIVE: it parks, then runs once approved", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kai-ws-shell-"));
  const runtime = boot(join(dir, "kai.db"));
  t.after(async () => {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const api = createCoreApi(runtime);

  const parked = await post(api, "/capabilities/shell/test", {
    action: "run",
    input: { command: process.execPath, args: ["-e", "process.stdout.write('shell-approved')"] },
  });
  assert.equal(parked.status, 409, JSON.stringify(parked.body));
  const approvalId = (parked.body as { approvalId: string }).approvalId;

  const decided = await post(api, `/approvals/${approvalId}/decide`, { approved: true });
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
  assert.equal((decided.body as { reissued: boolean }).reissued, true);
  const result = (decided.body as { result: { result: { stdout: string; exitCode: number } } }).result;
  assert.equal(result.result.stdout, "shell-approved");
  assert.equal(result.result.exitCode, 0);
});

// ── (e) direct READ tools run unattended; direct WRITE tools park ─────────────

test("(e) a READ workspace tool runs without approval, a WRITE one is refused with an approval id", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kai-ws-direct-"));
  const runtime = boot(join(dir, "kai.db"));
  t.after(async () => {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  // READ: allowed by the default policy, no approval.
  const wrote = await runtime.tools.invoke("filesystem.write", { path: join(dir, "direct.txt"), content: "hi" });
  assert.equal(wrote.ok, false);
  if (!wrote.ok) {
    assert.equal(wrote.error.code, "APPROVAL_REQUIRED");
    assert.equal(typeof wrote.error.detail, "string");
  }
  const read = await runtime.tools.invoke("filesystem.read", { path: join(dir, "kai.db") });
  // The db path is a real file, so this READ executes; assert only that it did not
  // demand approval (the exact bytes are not the point here).
  assert.equal(read.ok, true, JSON.stringify(read));
});

// ── (f) a READ capability needs no approval ───────────────────────────────────

test("(f) capability git.status (READ) executes without a human when git is present", async (t) => {
  const probed = await probeGit();
  if (!probed.available) {
    t.skip(`git not runnable: ${probed.detail}`);
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "kai-ws-git-"));
  const runtime = boot(join(dir, "kai.db"));
  t.after(async () => {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const api = createCoreApi(runtime);
  const resp = await post(api, "/capabilities/git/test", { action: "status", input: { cwd: process.cwd() } });
  assert.equal(resp.status, 200, JSON.stringify(resp.body));
  const result = (resp.body as { result: { result: { branch: string } } }).result;
  assert.ok(typeof result.result.branch === "string");
});
