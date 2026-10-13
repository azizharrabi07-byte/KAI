// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * SECURITY INVARIANTS — the boundaries developer mode must NOT move.
 *
 * `KAI_DEV_MODE=1` exists so a developer running the Core directly can drive an
 * owner route without the installer-injected credential. That is its ENTIRE
 * authority. The campaign's acceptance criterion is explicit:
 *
 *   "Developer mode must never disable Guard, policy enforcement, budget
 *    enforcement or approval requirements for protected actions."
 *
 * By inspection `devMode` is read in exactly two places — `api/authz.ts` (the
 * owner-credential gate) and `api/routes.ts` (the `requiresOwner` check). It does
 * not appear in `policies/`, `orchestration/budget.ts` or `approvals/`. These
 * tests make that a PINNED FACT rather than a reading, because a future change
 * that let dev mode reach Guard would be a silent privilege escalation.
 *
 * The effect is observed, not asserted: the restore target directory is read from
 * disk, so "performed nothing" means the filesystem says so.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCoreApi, type CoreApi } from "../src/api/routes.ts";
import { createCoreRuntime } from "../src/runtime.ts";

function tempDir(name: string): string {
  return mkdtempSync(join(tmpdir(), `kai-secinv-${name}-`));
}

function boot(dbPath: string) {
  return createCoreRuntime({
    dbPath,
    agents: { mode: "mock" },
    startScheduler: false,
    subsystemPaths: { runUpkeepOnStart: false },
  });
}

/** A caller that holds the install credential AND has asked for developer mode. */
function post(api: CoreApi, path: string, body: unknown, opts: { devMode?: boolean; attested?: boolean } = {}) {
  return api.handle({
    method: "POST",
    path,
    query: new URLSearchParams(),
    body,
    attested: opts.attested ?? true,
    ownerAuthConfigured: true,
    ...(opts.devMode !== undefined ? { devMode: opts.devMode } : {}),
  });
}

/**
 * Read a field off an unknown response body WITHOUT asserting a shape.
 * The API returns `unknown`; an inline cast would fabricate a type and trust it.
 */
function field(body: unknown, key: string): unknown {
  if (body === null || typeof body !== "object") return undefined;
  return key in body ? (body as Record<string, unknown>)[key] : undefined;
}

function str(body: unknown, key: string): string | null {
  const v = field(body, key);
  return typeof v === "string" ? v : null;
}

/** Set up a real checkpoint of a source dir, plus an empty restore target. */
async function fixture(t: { after(fn: () => void | Promise<void>): void }) {
  const dir = tempDir("run");
  const runtime = boot(join(dir, "kai.db"));
  const srcDir = tempDir("src");
  const restoreDir = tempDir("restore");
  writeFileSync(join(srcDir, "a.txt"), "the original bytes\n");
  t.after(async () => {
    // Stop FIRST, then delete: the runtime holds the database open, and Windows
    // refuses to remove a directory whose handle is still live (EPERM).
    await runtime.stop();
    for (const d of [dir, srcDir, restoreDir]) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const api = createCoreApi(runtime);
  const created = await post(api, "/checkpoints", { target: srcDir });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const checkpoint = field(created.body, "checkpoint");
  const checkpointId = str(checkpoint, "id");
  assert.ok(checkpointId !== null, `the checkpoint id is present: ${JSON.stringify(created.body)}`);
  return { runtime, api, checkpointId, restoreDir };
}

test("dev mode does NOT disable Guard: a DESTRUCTIVE action still parks and performs nothing", async (t) => {
  const { api, checkpointId, restoreDir } = await fixture(t);
  assert.deepEqual(readdirSync(restoreDir), [], "the target starts empty");

  // Developer mode is ON. If it reached Guard, this would execute immediately.
  const parked = await post(api, `/checkpoints/${checkpointId}/restore`, { target: restoreDir }, { devMode: true });

  assert.equal(parked.status, 409, `dev mode must not skip the approval gate: ${JSON.stringify(parked.body)}`);
  assert.equal(field(parked.body, "approvalRequired"), true);
  assert.deepEqual(readdirSync(restoreDir), [], "the filesystem proves nothing was performed");
  t.diagnostic("devMode=true, DESTRUCTIVE route still parked 409");
});

test("dev mode does NOT disable the approval requirement: an undecided action never runs", async (t) => {
  const { api, checkpointId, restoreDir } = await fixture(t);
  const parked = await post(api, `/checkpoints/${checkpointId}/restore`, { target: restoreDir }, { devMode: true });
  const approvalId = str(parked.body, "approvalId");
  assert.ok(approvalId !== null, "the parked action hands back an id");

  // Re-issue the SAME call carrying the id, but never decide it. A pending
  // approval is not an approval.
  const replayed = await post(api, `/checkpoints/${checkpointId}/restore`, { target: restoreDir, approvalId }, { devMode: true });
  assert.notEqual(replayed.status, 200, "an undecided approval must not authorize the action");
  assert.deepEqual(readdirSync(restoreDir), [], "still nothing performed");
  t.diagnostic(`undecided approval -> ${replayed.status}`);
});

test("a FORGED approval id is refused even in dev mode", async (t) => {
  const { api, checkpointId, restoreDir } = await fixture(t);
  const forged = await post(
    api,
    `/checkpoints/${checkpointId}/restore`,
    { target: restoreDir, approvalId: "apr_forged_00000000" },
    { devMode: true },
  );
  assert.notEqual(forged.status, 200, `a forged approval must never authorize: ${JSON.stringify(forged.body)}`);
  assert.deepEqual(readdirSync(restoreDir), [], "nothing performed under a forged approval");
  t.diagnostic(`forged approval -> ${forged.status}`);
});

test("a STALE approval for a different tool is refused", async (t) => {
  const { api, checkpointId, restoreDir } = await fixture(t);
  // Park a DIFFERENT action and approve it, then try to spend that approval here.
  const other = await post(api, "/checkpoints", { target: restoreDir });
  assert.equal(other.status, 201, JSON.stringify(other.body));
  const otherId = str(field(other.body, "checkpoint"), "id");
  assert.ok(otherId !== null, "the second checkpoint was created");

  const parkedOther = await post(api, `/checkpoints/${otherId}/restore`, { target: restoreDir });
  const wrongApproval = str(parkedOther.body, "approvalId");
  assert.ok(wrongApproval !== null, "the other action parks too");
  await post(api, `/approvals/${wrongApproval}/decide`, { approved: true });

  const crossed = await post(
    api,
    `/checkpoints/${checkpointId}/restore`,
    { target: restoreDir, approvalId: wrongApproval },
    { devMode: true },
  );
  assert.notEqual(crossed.status, 200, "an approval issued for another action must not be spent here");
  t.diagnostic(`cross-action approval -> ${crossed.status}`);
});

test("dev mode is NEVER the default: with a credential configured, omitting it is refused", async (t) => {
  const { api, checkpointId, restoreDir } = await fixture(t);
  // attested:false + devMode omitted, with a credential configured.
  const refused = await post(api, `/checkpoints/${checkpointId}/restore`, { target: restoreDir }, { attested: false });
  assert.equal(refused.status, 401, `an unattested caller must be refused: ${JSON.stringify(refused.body)}`);
  assert.equal(field(refused.body, "code"), "OWNER_AUTH_REQUIRED");
  assert.match(String(field(refused.body, "reason")), /owner credential|KAI_DEV_MODE/);
  assert.deepEqual(readdirSync(restoreDir), [], "nothing performed");
  t.diagnostic("omitted devMode -> 403");
});

test("the NON-HTTP surface policy-checks too: tools.invoke cannot skip Guard", async (t) => {
  // The HTTP route is one door. `runtime.tools.invoke` is the registry every
  // door goes through, and it must apply the SAME policy — otherwise a command,
  // an MCP call or an internal caller would be a bypass.
  const { runtime, restoreDir, checkpointId } = await fixture(t);

  const invoked = await runtime.tools.invoke(
    "checkpoint.restore",
    { id: checkpointId, target: restoreDir },
    { source: "test:bypass-probe" },
  );
  assert.equal(invoked.ok, false, `a DESTRUCTIVE tool must not run without an approval: ${JSON.stringify(invoked)}`);
  if (!invoked.ok) {
    assert.equal(invoked.error.code, "APPROVAL_REQUIRED", `expected APPROVAL_REQUIRED, got ${invoked.error.code}`);
  }
  assert.deepEqual(readdirSync(restoreDir), [], "the registry boundary held: nothing performed");
  t.diagnostic("tools.invoke -> APPROVAL_REQUIRED, no effect");
});

test("an UNKNOWN tool id is refused, never defaulted open", async (t) => {
  const { runtime } = await fixture(t);
  const invoked = await runtime.tools.invoke("does.not.exist", {}, { source: "test:unknown-tool" });
  assert.equal(invoked.ok, false, "an unregistered tool must not run");
  if (!invoked.ok) assert.match(invoked.error.code, /NOT_FOUND|VALIDATION_FAILED|POLICY_DENIED/);
  t.diagnostic(`unknown tool -> ${invoked.ok ? "RAN (BUG)" : invoked.error.code}`);
});
