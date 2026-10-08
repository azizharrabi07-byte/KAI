// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Mutation-tool DRIFT GUARD.
 *
 *   cd core && node --test tests/mutation-drift-guard.test.ts
 *
 * The API routes mutate state only by invoking a tool on the ONE registry —
 * `memory.write`, `mission.cancel`, `skill.toggle`, `checkpoint.restore`, … The
 * route table mirrors those ids in `MUTATION_TOOL_IDS` (it deliberately does not
 * import `runtime.ts` as a value). That mirror can DRIFT: a route could reference
 * an id the production runtime never registers, and the mutation would either
 * 404 at the boundary or — worse — be silently bypassed.
 *
 * This test builds the PRODUCTION runtime and asserts every id the routes rely
 * on actually resolves to a registered tool. A missing id fails with the id
 * named, so drift is loud rather than silent.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCoreRuntime, KAI_INTERNAL_STATE_TOOLS } from "../src/runtime.ts";
import { MUTATION_TOOL_IDS } from "../src/api/routes.ts";

/** Boot the real Core the way the HTTP wiring tests do. */
function bootRuntime(dbPath: string): ReturnType<typeof createCoreRuntime> {
  return createCoreRuntime({
    dbPath,
    agents: { mode: "mock" },
    startScheduler: false,
    subsystemPaths: { runUpkeepOnStart: false },
  });
}

test("every mutation tool the routes rely on is registered in the production runtime", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kai-mutation-drift-"));
  const runtime = bootRuntime(join(dir, "kai.db"));
  t.after(async () => {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  // Every id the route table references, plus the ones the task names that are
  // registered directly by the runtime rather than through `MUTATION_TOOLS`.
  const required: readonly string[] = [
    ...Object.values(MUTATION_TOOL_IDS),
    // Registered inline by `createCoreRuntime`; a scheduled `mission.create` job
    // resolves to it, so it must exist for that path to be inside the boundary.
    "missions.create",
    // Explicit coverage of the categories the guard must not lose.
    "memory.write",
    "mission.cancel",
    "notification.read",
    "approval.decide",
    "skill.toggle",
    "skill.delete",
    "checkpoint.create",
    "checkpoint.restore",
    "schedule.manage",
    "scheduler.recover",
  ];

  // Name each missing id individually so the failure is actionable.
  const missing: string[] = [];
  for (const id of required) {
    if (runtime.tools.get(id) === undefined) missing.push(id);
  }
  assert.deepEqual(
    missing,
    [],
    `mutation tool id(s) referenced by the routes are NOT registered in the production runtime: ${missing.join(", ")}`,
  );

  // The mirror itself must be non-trivial: a silently-empty MUTATION_TOOL_IDS
  // would otherwise make this guard vacuous.
  assert.ok(
    Object.values(MUTATION_TOOL_IDS).length >= 14,
    `expected the route mutation-id mirror to be substantial, got ${Object.values(MUTATION_TOOL_IDS).length}`,
  );
  assert.ok(required.length >= 25, `expected real coverage, got ${required.length} ids`);

  // Every id in the internal-state allow-list must also be a registered tool:
  // a policy rule that authorises an unregistered tool would be a hole.
  for (const id of KAI_INTERNAL_STATE_TOOLS) {
    assert.notEqual(
      runtime.tools.get(id),
      undefined,
      `KAI_INTERNAL_STATE_TOOLS names "${id}" but the production runtime does not register it`,
    );
  }
});
