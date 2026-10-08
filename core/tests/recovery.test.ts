// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Part H — the acceptance boundary and crash recovery.
 *
 * The crash tests are real: a child Node process starts an operation, is killed
 * with `process.exit()` mid-flight, and the parent restarts, reads the same
 * durable ledger and classifies. Side-effect counts are asserted to be exactly
 * what they should be (0 or 1), never 2 — a crash must never produce
 * unknown -> retry -> duplicate.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Mission } from "../src/shared/contracts.ts";
import { createMission } from "../src/missions/mission.ts";
import { createExecutionLedger, executionIdFor } from "../src/recovery/ledger.ts";
import {
  createBoundaryRunner,
  replayIfSafe,
} from "../src/recovery/boundary.ts";
import { openSqliteStores } from "../src/storage/sqlite.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/recovery-child.ts", import.meta.url));

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "kai-recovery-"));
}

function counter(path: string): number {
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf8").split("\n").filter((l) => l.length > 0).length;
}

function runChild(mode: string, ledgerPath: string, counterPath: string, dbPath?: string): number {
  const args = [FIXTURE, mode, ledgerPath, counterPath];
  if (dbPath !== undefined) args.push(dbPath);
  const result = spawnSync(process.execPath, args, { encoding: "utf8" });
  return result.status ?? -1;
}

// ── A. classification ────────────────────────────────────────────────────────

test("classification: before-accept is replay-safe, after-accept is not, unknown is unsafe", () => {
  const ledger = createExecutionLedger({ path: ":memory:" });

  ledger.begin({ executionId: "before", kind: "test", sideEffecting: true });
  const before = ledger.classify("before");
  assert.equal(before.phase, "BEFORE_ACCEPT");
  assert.equal(before.replaySafe, true);
  assert.equal(before.sideEffectCount, 0, "no side effect before the boundary");

  ledger.begin({ executionId: "after", kind: "test", sideEffecting: true });
  const accepted = ledger.accept("after");
  assert.equal(accepted.accepted, true);
  const after = ledger.classify("after");
  assert.equal(after.phase, "AFTER_ACCEPT");
  assert.equal(after.replaySafe, false);
  assert.equal(after.sideEffectCount, 1, "crossing the boundary counts exactly one side effect");

  const unknown = ledger.classify("never-heard-of-it");
  assert.equal(unknown.phase, "UNKNOWN");
  assert.equal(unknown.replaySafe, false, "an unknown effect is treated as unsafe");
  assert.equal(unknown.sideEffectCount, 0);

  // accept() crosses the boundary exactly once.
  const second = ledger.accept("after");
  assert.equal(second.accepted, false, "a second accept must not re-cross the boundary");
  assert.equal(ledger.classify("after").sideEffectCount, 1);

  ledger.begin({ executionId: "done", kind: "test", sideEffecting: true });
  ledger.accept("done");
  ledger.complete("done");
  const done = ledger.classify("done");
  assert.equal(done.status, "COMPLETED");
  assert.equal(done.replaySafe, false);

  ledger.close();
});

// ── B. the boundary runner refuses to replay an accepted side effect ──────────

test("boundary runner: a side-effecting step runs once and a replay is refused (side effects stay at 1)", async () => {
  const dir = tempDir();
  const ledger = createExecutionLedger({ path: join(dir, "ledger.db") });
  const countPath = join(dir, "count.txt");

  const mission: Mission = createMission({
    title: "one side effect",
    steps: [{ title: "write", kind: "tool", target: "fs.write", sideEffecting: true }],
  });
  const step = mission.steps[0]!;

  let effects = 0;
  const inner = async (): Promise<{ ok: true }> => {
    effects += 1;
    return { ok: true };
  };
  const runner = createBoundaryRunner(inner, { ledger });

  const first = await runner(step, mission);
  assert.equal("ok" in first && first.ok, true);
  assert.equal(effects, 1);
  assert.equal(ledger.classify(executionIdFor(mission.id, step.id)).phase, "AFTER_ACCEPT");

  // A naive replay of the accepted step must be refused, not re-executed.
  const second = await runner(step, mission);
  assert.equal("ok" in second && second.ok, false);
  assert.equal("ok" in second && second.ok === false ? second.error.code : "", "AGENT_RUN_ABANDONED");
  assert.equal(effects, 1, "the side effect was not applied a second time");
  assert.equal(counter(countPath), 0);

  // A non-side-effecting step has no boundary and may be repeated.
  const safeMission = createMission({
    title: "read only",
    steps: [{ title: "read", kind: "tool", target: "fs.read", sideEffecting: false }],
  });
  const safeStep = safeMission.steps[0]!;
  const safeRunner = createBoundaryRunner(async () => ({ ok: true }), { ledger });
  await safeRunner(safeStep, safeMission);
  await safeRunner(safeStep, safeMission);
  assert.equal(effects, 1, "non-side-effecting steps do not touch the effect counter");

  ledger.close();
});

test("boundary runner: an approval park rewinds the boundary so an approved resume may run", async () => {
  const dir = tempDir();
  const ledger = createExecutionLedger({ path: join(dir, "ledger.db") });
  const mission = createMission({
    title: "approval",
    steps: [{ title: "send", kind: "tool", target: "net.send", sideEffecting: true }],
  });
  const step = mission.steps[0]!;

  let calls = 0;
  const runner = createBoundaryRunner(async () => {
    calls += 1;
    return calls === 1 ? { pending: true as const, reason: "needs approval" } : { ok: true as const };
  }, { ledger });

  const parked = await runner(step, mission);
  assert.equal("pending" in parked, true);
  // The effect did not happen, so the boundary is back to BEFORE_ACCEPT.
  assert.equal(ledger.classify(executionIdFor(mission.id, step.id)).phase, "BEFORE_ACCEPT");

  const resumed = await runner(step, mission);
  assert.equal("ok" in resumed && resumed.ok, true);
  assert.equal(calls, 2, "the approved resume actually ran");

  ledger.close();
});

// ── C. real crash / restart ──────────────────────────────────────────────────

test("crash before accept: restart classifies BEFORE_ACCEPT, replays once, side effects = 1", async () => {
  const dir = tempDir();
  const ledgerPath = join(dir, "ledger.db");
  const countPath = join(dir, "count.txt");

  assert.equal(runChild("begin-exit", ledgerPath, countPath), 7, "child died mid-operation");

  const ledger = createExecutionLedger({ path: ledgerPath });
  const classified = ledger.classify("exec_before");
  assert.equal(classified.phase, "BEFORE_ACCEPT");
  assert.equal(classified.replaySafe, true);

  const replayed = await replayIfSafe(ledger, "exec_before", async () => {
    // The "effect" a replay is allowed to perform.
    const { appendFileSync } = await import("node:fs");
    appendFileSync(countPath, "effect\n");
    return true;
  });
  assert.equal(replayed.ok, true, replayed.ok === false ? JSON.stringify(replayed) : "");
  assert.equal(counter(countPath), 1);
  assert.equal(ledger.classify("exec_before").status, "COMPLETED");
  ledger.close();
});

test("crash after accept: restart classifies AFTER_ACCEPT and refuses to replay, side effects stay at 1", async () => {
  const dir = tempDir();
  const ledgerPath = join(dir, "ledger.db");
  const countPath = join(dir, "count.txt");

  assert.equal(runChild("accept-effect-exit", ledgerPath, countPath), 7);
  assert.equal(counter(countPath), 1, "the child applied the effect exactly once before dying");

  const ledger = createExecutionLedger({ path: ledgerPath });
  const classified = ledger.classify("exec_after");
  assert.equal(classified.phase, "AFTER_ACCEPT");
  assert.equal(classified.replaySafe, false, "an accepted effect must not be blindly replayed");

  const replayed = await replayIfSafe(ledger, "exec_after", async () => {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(countPath, "effect\n");
    return true;
  });
  assert.equal(replayed.ok, false);
  assert.equal(replayed.ok === false && replayed.refused, true);
  assert.equal(counter(countPath), 1, "no duplicate side effect after the crash");

  ledger.close();
});

test("crash with no record: restart treats it as UNKNOWN and refuses to replay, side effects = 0", async () => {
  const dir = tempDir();
  const ledgerPath = join(dir, "ledger.db");
  const countPath = join(dir, "count.txt");

  assert.equal(runChild("nothing-exit", ledgerPath, countPath), 7);

  const ledger = createExecutionLedger({ path: ledgerPath });
  const classified = ledger.classify("exec_unknown");
  assert.equal(classified.phase, "UNKNOWN");
  assert.equal(classified.replaySafe, false, "unknown must be treated as unsafe");

  const replayed = await replayIfSafe(ledger, "exec_unknown", async () => {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(countPath, "effect\n");
    return true;
  });
  assert.equal(replayed.ok, false);
  assert.equal(replayed.ok === false && replayed.phase, "UNKNOWN");
  assert.equal(counter(countPath), 0, "unknown -> no retry -> no side effect");
  ledger.close();
});

// ── D. integration with the real mission executor ────────────────────────────

test("mission executor crash mid-side-effecting-step: recover blocks, classify says AFTER_ACCEPT, no duplicate", async () => {
  const dir = tempDir();
  const dbPath = join(dir, "core.db");
  const ledgerPath = join(dir, "ledger.db");
  const countPath = join(dir, "count.txt");

  assert.equal(runChild("mission-crash", ledgerPath, countPath, dbPath), 7, "child died mid-step");
  assert.equal(counter(countPath), 1, "the child applied the step's effect exactly once before dying");

  // ── Restart: same database, same ledger, fresh process state. ──────────────
  const stores = openSqliteStores({ path: dbPath });
  const ledger = createExecutionLedger({ path: ledgerPath });

  const missions = stores.missions.listMissions();
  assert.equal(missions.length, 1);
  const mission = missions[0]!;
  const step = mission.steps[0]!;

  const classified = ledger.classify(executionIdFor(mission.id, step.id));
  assert.equal(classified.phase, "AFTER_ACCEPT", "the step crossed its acceptance boundary before dying");
  assert.equal(classified.replaySafe, false);
  assert.equal(classified.sideEffectCount, 1);

  // The executor's own recovery classifies the side-effecting step as blocked.
  const executor = awaitMissionsRecover(stores, ledger);
  const recovered = await executor;
  assert.ok(recovered.blocked.includes(mission.id), "the side-effecting mission is blocked, not resumed");
  assert.equal(stores.missions.getMission(mission.id)?.status, "WAITING");

  // And even if something ignored that and re-ran the step, the boundary refuses.
  const replayRunner = createBoundaryRunner(async () => {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(countPath, "mission-effect\n");
    return { ok: true as const };
  }, { ledger });
  const refused = await replayRunner(step, mission);
  assert.equal("ok" in refused && refused.ok, false, "the boundary refuses to replay the accepted step");
  assert.equal(counter(countPath), 1, "no duplicate side effect");

  ledger.close();
  stores.close();
});

/** The recovery classification depends only on the ledger; this builds an executor to run recover(). */
async function awaitMissionsRecover(
  stores: ReturnType<typeof openSqliteStores>,
  ledger: ReturnType<typeof createExecutionLedger>,
): Promise<{ resumed: string[]; blocked: string[] }> {
  // Lazy imports keep the crash fixture and this test using exactly the same code.
  const { createMissionExecutor } = await import("../src/missions/executor.ts");
  const executor = createMissionExecutor({
    store: stores.missions,
    runner: createBoundaryRunner(
      async () => ({ ok: true as const }),
      { ledger },
    ),
  });
  return executor.recover();
}
