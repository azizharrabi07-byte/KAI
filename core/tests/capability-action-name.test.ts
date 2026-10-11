// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * A capability action that is not a real op must be refused with the ACTION named.
 *
 * Found live: the island's approval card was driven with
 * `POST /capabilities/filesystem/test {action: "filesystem.write", …}` — the TOOL id
 * where the op name belongs. It parked (the capability's declared risk governs, not the
 * action), the human approved it, and the re-issued call failed with
 *
 *   capability "filesystem" has no connected transport, so action "filesystem.write"
 *   cannot run
 *
 * which is false on both halves: the transport was available and the fault was the
 * payload. That message is what sent a previous investigation after a missing driver.
 *
 * Run from `core/`:  node --test tests/capability-action-name.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCoreRuntime } from "../src/runtime.ts";
import { createCoreApi } from "../src/api/routes.ts";
import type { CoreApi } from "../src/api/routes.ts";

function boot(dbPath: string) {
  return createCoreRuntime({
    dbPath,
    agents: { mode: "mock" },
    startScheduler: false,
    subsystemPaths: { runUpkeepOnStart: false },
  });
}

function post(api: CoreApi, path: string, body: unknown) {
  return api.handle({ method: "POST", path, query: new URLSearchParams(), attested: true, ownerAuthConfigured: true, body });
}

test("an unknown capability action is refused by NAME, never blamed on a transport", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kai-cap-action-"));
  const runtime = boot(join(dir, "kai.db"));
  t.after(async () => {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const api = createCoreApi(runtime);
  const target = join(dir, "never-written.txt");

  // The mistaken payload. The capability tool's declared risk is WRITE, so this PARKS
  // exactly as it did live — nothing about the wrong action name is reported yet.
  const parked = await post(api, "/capabilities/filesystem/test", {
    action: "filesystem.write",
    input: { path: target, content: "should never appear" },
  });
  assert.equal(parked.status, 409, JSON.stringify(parked.body));
  const approvalId = (parked.body as { approvalId: string }).approvalId;
  assert.equal(typeof approvalId, "string");
  assert.equal(existsSync(target), false, "a parked write must not have run");

  // The human approves, and the parked call is re-issued: now the action name matters.
  const decided = await post(api, `/approvals/${approvalId}/decide`, { approved: true });
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
  const reason = String((decided.body as { result?: { error?: { message?: string } } }).result?.error?.message ?? "");
  assert.ok(reason.length > 0, `the re-issued call must report why it failed: ${JSON.stringify(decided.body)}`);
  assert.ok(reason.includes("filesystem.write"), `the reason must name the action that was sent: ${reason}`);
  assert.ok(reason.includes("write"), `the reason must list what IS accepted: ${reason}`);
  assert.ok(
    !/no connected transport|not connected/i.test(reason),
    `a wrong action name must never be reported as a transport problem: ${reason}`,
  );
  assert.equal(existsSync(target), false, "the refused write must not have created the file");
});

test("the same call with the real op name works, so the refusal above is about the name", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kai-cap-action-ok-"));
  const runtime = boot(join(dir, "kai.db"));
  t.after(async () => {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const api = createCoreApi(runtime);
  const target = join(dir, "written.txt");

  const parked = await post(api, "/capabilities/filesystem/test", {
    action: "write",
    input: { path: target, content: "the right op name" },
  });
  assert.equal(parked.status, 409, JSON.stringify(parked.body));
  const approvalId = (parked.body as { approvalId: string }).approvalId;

  const decided = await post(api, `/approvals/${approvalId}/decide`, { approved: true });
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
  assert.equal((decided.body as { reissued?: boolean }).reissued, true, JSON.stringify(decided.body));
  assert.equal(existsSync(target), true, "an approved write with the real op name must have run");
  assert.equal(readFileSync(target, "utf8"), "the right op name");
});
