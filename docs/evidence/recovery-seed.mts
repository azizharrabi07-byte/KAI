// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Seed a REAL recovery-blocked condition into a Core database, using the
 * product's own storage and acceptance-ledger layers (no raw SQL, no invented
 * schema) — the same shape `core/tests/fixtures/recovery-child.ts` leaves behind
 * when a process dies mid-side-effect.
 *
 *   node docs/evidence/recovery-seed.mts <coreDbPath> <ledgerPath>
 *
 * Why `.mts` and not `.ts`: this file lives under `docs/evidence/`, which has no
 * package.json, so Node treats a bare `.ts` there as CommonJS and the `import`
 * statements throw `SyntaxError: Cannot use import statement outside a module`.
 * `.mts` is always ESM, so Node's native type-stripping runs it directly. The
 * `.ts` sources it imports live under `core/` (`"type": "module"`) and load as ESM.
 *
 * What it writes:
 *   - a mission in RUNNING status with a single SIDE-EFFECTING step, also RUNNING
 *     (so `listUnfinishedMissions()` returns it and the executor's `recover()`
 *     reaches the side-effecting-step branch);
 *   - an AFTER_ACCEPT record in the acceptance ledger for that step — the
 *     "the effect may already have happened" verdict, which is exactly what makes
 *     recovery REFUSE to replay and report the mission `blocked`.
 *
 * On the next Core start, `missions.recover()` blocks it and
 * `runtime.start()` calls `notifications.notify({ type: "mission.recovery_blocked" })`,
 * which publishes the wire event `notification.created` with the semantic type
 * nested in `payload.type`. That is the real event this proof follows.
 *
 * It prints one JSON line: { missionId, stepId, executionId, phase }.
 */

import { openSqliteStores } from "../../core/src/storage/sqlite.ts";
import { createMission } from "../../core/src/missions/mission.ts";
import { createExecutionLedger, executionIdFor } from "../../core/src/recovery/ledger.ts";

const [dbPath, ledgerPath] = process.argv.slice(2);
if (!dbPath || !ledgerPath) {
  process.stderr.write("usage: node docs/evidence/recovery-seed.mts <coreDbPath> <ledgerPath>\n");
  process.exit(2);
}

const stores = openSqliteStores({ path: dbPath });
const ledger = createExecutionLedger({ path: ledgerPath });

try {
  const mission = createMission({
    title: "recovery-proof: blocked side effect",
    steps: [{ title: "send the irreversible thing", kind: "tool", target: "fs.write", sideEffecting: true }],
  });
  mission.status = "RUNNING";
  const step = mission.steps[0]!;
  step.status = "RUNNING";
  step.startedAt = new Date().toISOString();
  stores.missions.upsertMission(mission);

  // The effect crossed its acceptance boundary and the process died before
  // completing: AFTER_ACCEPT, not replay-safe. Recovery must BLOCK, not replay.
  const executionId = executionIdFor(mission.id, step.id);
  ledger.begin({ executionId, kind: "mission_step", refId: mission.id, stepId: step.id, sideEffecting: true });
  ledger.accept(executionId, "seed: effect crossed the boundary, process died before completion");

  const record = ledger.get(executionId);
  process.stdout.write(
    JSON.stringify({ missionId: mission.id, stepId: step.id, executionId, phase: record?.phase ?? null }) + "\n",
  );
} finally {
  ledger.close();
  stores.close();
}
