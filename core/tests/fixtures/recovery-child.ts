// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Crash child for the recovery tests. Run as:
 *
 *   node tests/fixtures/recovery-child.ts <mode> <ledgerPath> <counterPath> [dbPath]
 *
 * Each mode performs part of a real operation and then dies with `process.exit`
 * — an abrupt termination with no cleanup, which is what makes the durability of
 * the ledger meaningful. The parent process then restarts, reads the same files
 * and classifies.
 */

import { appendFileSync } from "node:fs";

import { createExecutionLedger, executionIdFor } from "../../src/recovery/ledger.ts";
import { createBoundaryRunner } from "../../src/recovery/boundary.ts";
import { createMission } from "../../src/missions/mission.ts";
import { createMissionExecutor } from "../../src/missions/executor.ts";
import { openSqliteStores } from "../../src/storage/sqlite.ts";
import type { MissionStep } from "../../src/shared/contracts.ts";

const [mode, ledgerPath, counterPath, dbPath] = process.argv.slice(2);

function die(): never {
  process.exit(7);
}

const ledger = createExecutionLedger({ path: ledgerPath as string });

if (mode === "begin-exit") {
  // Started, never crossed the acceptance boundary.
  ledger.begin({ executionId: "exec_before", kind: "test", sideEffecting: true });
  ledger.close();
  die();
}

if (mode === "accept-effect-exit") {
  // Crossed the boundary, performed the effect, died before completing.
  const id = "exec_after";
  ledger.begin({ executionId: id, kind: "test", sideEffecting: true });
  ledger.accept(id);
  appendFileSync(counterPath as string, "effect\n");
  ledger.close();
  die();
}

if (mode === "nothing-exit") {
  // Died without leaving any durable record: the UNKNOWN case.
  ledger.close();
  die();
}

if (mode === "mission-crash") {
  const stores = openSqliteStores({ path: dbPath as string });

  // The real effect, then an abrupt death — the boundary runner has already
  // recorded AFTER_ACCEPT before this function is reached.
  const inner = async (_step: MissionStep): Promise<{ ok: true }> => {
    appendFileSync(counterPath as string, "mission-effect\n");
    die();
  };

  const runner = createBoundaryRunner(inner, { ledger });
  const mission = createMission({
    title: "crash-mid-step",
    steps: [{ title: "write a file", kind: "tool", target: "fs.write", sideEffecting: true }],
  });
  mission.status = "QUEUED";
  stores.missions.upsertMission(mission);
  const executor = createMissionExecutor({ store: stores.missions, runner });
  await executor.start(mission.id);
  stores.close();
  ledger.close();
  die();
}

if (mode === "mission-park") {
  // A side-effecting step parked on approval BEFORE its effect. The executor's
  // own policy gate parks it (the runner is never called), and the boundary
  // runner records BEFORE_ACCEPT for it. The process then dies — the parent
  // restarts and must classify it BEFORE_ACCEPT (replay-safe), not UNKNOWN.
  const stores = openSqliteStores({ path: dbPath as string });
  const runner = createBoundaryRunner(async () => ({ ok: true as const }), { ledger });
  const policy = {
    async check(): Promise<{ outcome: "needs_approval"; reason: string }> {
      return { outcome: "needs_approval", reason: "test gate: approval required" };
    },
  };
  const mission = createMission({
    title: "park-before-effect",
    steps: [{ title: "write a file", kind: "tool", target: "fs.write", sideEffecting: true }],
  });
  mission.status = "QUEUED";
  stores.missions.upsertMission(mission);
  const executor = createMissionExecutor({ store: stores.missions, policy, runner });
  await executor.start(mission.id);
  stores.close();
  ledger.close();
  die();
}

if (mode === "mission-running-before-accept") {
  // The state a real crash between begin() and accept() leaves: a RUNNING
  // side-effecting step whose execution has a durable BEFORE_ACCEPT record but
  // never crossed the boundary. Written directly here for the same reason the
  // `begin-exit` mode above is: it is exactly what the boundary runner's begin()
  // commits before the process dies. The parent restarts, classifies and — with
  // a durable BEFORE_ACCEPT verdict — resumes the mission to apply the effect
  // exactly once.
  const stores = openSqliteStores({ path: dbPath as string });
  const mission = createMission({
    title: "crash-before-accept",
    steps: [{ title: "write a file", kind: "tool", target: "fs.write", sideEffecting: true }],
  });
  mission.status = "RUNNING";
  const step = mission.steps[0]!;
  step.status = "RUNNING";
  step.startedAt = new Date().toISOString();
  stores.missions.upsertMission(mission);
  ledger.begin({
    executionId: executionIdFor(mission.id, step.id),
    kind: "mission_step",
    refId: mission.id,
    stepId: step.id,
    sideEffecting: true,
  });
  stores.close();
  ledger.close();
  die();
}

// Unknown mode: fail loudly so a broken test does not look like a passing one.
process.stderr.write(`unknown mode: ${String(mode)}\n`);
process.exit(2);
