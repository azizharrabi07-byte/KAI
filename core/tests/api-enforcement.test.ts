// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * HTTP enforcement (Phase 2 Part I): every state-mutating route earns its way
 * through the ONE tool registry, and a DESTRUCTIVE route cannot act without a
 * human.
 *
 * This is an end-to-end proof over a real runtime:
 *   - a READ route executes directly, asking no one;
 *   - a DESTRUCTIVE route returns 409 {approvalRequired, approvalId}, performs
 *     NOTHING, and — once the approval is decided — the runtime RE-ISSUES the exact
 *     parked request itself (Phase 4), so the effect happens on the verdict. The
 *     caller may also re-issue carrying the id, and that remains honoured.
 *
 * It uses `POST /checkpoints/:id/restore` — the route that OVERWRITES files — so
 * "performs nothing" is observable as an untouched target directory, not merely
 * asserted.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCoreRuntime } from "../src/runtime.ts";
import { createCoreApi, type CoreApi } from "../src/api/routes.ts";

function tempDir(name: string): string {
  return mkdtempSync(join(tmpdir(), `kai-enforce-${name}-`));
}

function boot(dbPath: string) {
  return createCoreRuntime({
    dbPath,
    agents: { mode: "mock" },
    startScheduler: false,
    subsystemPaths: { runUpkeepOnStart: false },
  });
}

/**
 * A mutation from the INSTALLED APP: it holds the per-install owner credential.
 * The Core now fails closed, so an unattested mutation is refused before any
 * policy runs — which is the correct production posture and would make these
 * policy tests vacuous if they did not model the real caller.
 */
function post(api: CoreApi, path: string, body: unknown) {
  return api.handle({
    method: "POST",
    path,
    query: new URLSearchParams(),
    body,
    attested: true,
    ownerAuthConfigured: true,
  });
}

function get(api: CoreApi, path: string, q?: Record<string, string>) {
  return api.handle({ method: "GET", path, query: new URLSearchParams(q ?? {}) });
}

test("a READ route executes directly and asks for no approval", async (t) => {
  const dir = tempDir("read");
  const dbPath = join(dir, "kai.db");
  const runtime = boot(dbPath);
  t.after(async () => {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const api = createCoreApi(runtime);

  const res = await get(api, "/checkpoints");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(Array.isArray((res.body as { checkpoints: unknown[] }).checkpoints));
  assert.equal(
    runtime.approvals.list({ status: "PENDING" }).length,
    0,
    "a READ route must not create an approval",
  );
});

test("a DESTRUCTIVE route parks (409), performs nothing, and acts once approved", async (t) => {
  const dir = tempDir("destructive");
  const dbPath = join(dir, "kai.db");
  const runtime = boot(dbPath);

  const srcDir = tempDir("src");
  const restoreDir = tempDir("restore");
  writeFileSync(join(srcDir, "a.txt"), "the original bytes\n");

  t.after(async () => {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    rmSync(srcDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    rmSync(restoreDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const api = createCoreApi(runtime);

  // Take a real checkpoint of the source directory (WRITE: authorized by default).
  const created = await post(api, "/checkpoints", { target: srcDir });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const checkpointId = (created.body as { checkpoint: { id: string } }).checkpoint.id;

  // The restore target exists and is empty; a restore would populate it.
  assert.deepEqual(readdirSync(restoreDir), [], "the restore target starts empty");

  // ── First attempt: DESTRUCTIVE -> parked, NOTHING performed. ────────────────
  const parked = await post(api, `/checkpoints/${checkpointId}/restore`, { target: restoreDir });
  assert.equal(parked.status, 409, JSON.stringify(parked.body));
  assert.equal((parked.body as { approvalRequired: boolean }).approvalRequired, true);
  const approvalId = (parked.body as { approvalId: string }).approvalId;
  assert.ok(typeof approvalId === "string" && approvalId.length > 0, "the parked action hands back the id");

  assert.deepEqual(readdirSync(restoreDir), [], "the parked restore performed NOTHING");

  // ── A human decides: the parked request is RE-ISSUED and runs. ──────────────
  const decided = await post(api, `/approvals/${approvalId}/decide`, { approved: true });
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
  assert.equal((decided.body as { approval: { status: string } }).approval.status, "APPROVED");

  // Phase 4: for a request with no MISSION behind it, deciding is no longer a
  // no-op. The runtime re-issues the EXACT parked call (registry.onApprovalRequest
  // recorded it durably), so the effect happens on the verdict itself — this is
  // the "verdict recorded, nothing happens" defect being closed.
  assert.equal((decided.body as { reissued: boolean }).reissued, true, JSON.stringify(decided.body));
  assert.deepEqual(readdirSync(restoreDir), ["a.txt"], "the approved restore ran without a manual re-issue");

  // Re-issuing the SAME request with the id is still honoured: the approval is
  // bound to the tool and the restore is idempotent, so nothing regresses.
  const restored = await post(api, `/checkpoints/${checkpointId}/restore`, {
    target: restoreDir,
    approvalId,
  });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.equal((restored.body as { restore: { ok: boolean } }).restore.ok, true);

  // The files really were restored — the effect is observed, not assumed.
  assert.deepEqual(readdirSync(restoreDir), ["a.txt"]);
  assert.equal(readFileSync(join(restoreDir, "a.txt"), "utf8"), "the original bytes\n");
});

test("a DESTRUCTIVE route refuses an approval issued for a different tool", async (t) => {
  const dir = tempDir("mismatch");
  const dbPath = join(dir, "kai.db");
  const runtime = boot(dbPath);
  t.after(async () => {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const api = createCoreApi(runtime);

  // An approval for an unrelated WRITE tool (memory.write) — a real, APPROVED card.
  const created = await runtime.approvals.request({
    toolId: "memory.write",
    action: "Write a memory",
    reason: "unrelated",
    risk: "WRITE",
  });
  runtime.approvals.decide(created.id, true);

  const res = await post(api, "/checkpoints/ghost/restore", { approvalId: created.id });
  assert.equal(res.status, 403, JSON.stringify(res.body));
  assert.match((res.body as { reason: string }).reason, /does not authorise/);
});
