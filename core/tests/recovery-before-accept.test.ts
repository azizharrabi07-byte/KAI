// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * C4 — before-accept recovery.
 *
 * The acceptance ledger must be able to answer "had this execution crossed its
 * point of no return?" with BEFORE_ACCEPT (replay is safe), not only
 * AFTER_ACCEPT (do not replay). The lifecycle is:
 *
 *     begin()   -> BEFORE_ACCEPT, durable
 *     accept()  -> AFTER_ACCEPT, durable; the point of no return
 *     inner()   -> the real effect
 *
 * Two things used to make BEFORE_ACCEPT unreachable through the real product:
 *
 *   1. A side-effecting step parked by the EXECUTOR's own policy gate left NO
 *      durable record at all, because the executor never calls the runner for a
 *      step a human must clear — so the boundary runner's approval-park rewind
 *      never fired. On restart such a step was UNKNOWN (unsafe), and a crash
 *      before a side effect was indistinguishable from one after it. The fix:
 *      the executor records the pre-effect boundary (`recordParkedBeforeEffect`).
 *
 *   2. A step whose tool was REFUSED before its effect ran (bad input, policy
 *      denial, missing tool, missing approval) was left AFTER_ACCEPT — even
 *      though the registry's `validate -> policy -> approval -> execute` chain
 *      never reached `execute()`. The fix: the boundary rewinds such an
 *      execution to BEFORE_ACCEPT. A failure DURING the effect is NOT rewound.
 *
 * Every test below fails if the phase write regresses.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createCoreRuntime } from "../src/runtime.ts";
import { createCoreApi } from "../src/api/routes.ts";
import { createMission } from "../src/missions/mission.ts";
import { createMissionExecutor } from "../src/missions/executor.ts";
import { createBoundaryRunner } from "../src/recovery/boundary.ts";
import { createExecutionLedger, executionIdFor } from "../src/recovery/ledger.ts";
import { openSqliteStores } from "../src/storage/sqlite.ts";
import type { CoreRuntime } from "../src/runtime.ts";
import type { CoreApi } from "../src/api/routes.ts";
import type { KaiError } from "../src/shared/contracts.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/recovery-child.ts", import.meta.url));

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "kai-before-accept-"));
}

function runChild(mode: string, ledgerPath: string, counterPath: string, dbPath: string): number {
  const result = spawnSync(process.execPath, [FIXTURE, mode, ledgerPath, counterPath, dbPath], {
    encoding: "utf8",
  });
  return result.status ?? -1;
}

function kaiError(code: KaiError["code"], message: string): KaiError {
  return { code, message, retryable: false, at: new Date().toISOString() };
}

// ── A. the boundary rewinds a refusal, not a mid-effect failure ───────────────

test("boundary: a refusal BEFORE the effect rewinds to BEFORE_ACCEPT (replay-safe)", async () => {
  const dir = tempDir();
  const ledger = createExecutionLedger({ path: join(dir, "ledger.db") });
  try {
    const mission = createMission({
      title: "refused-before-effect",
      steps: [{ title: "send", kind: "tool", target: "net.send", sideEffecting: true }],
    });
    const step = mission.steps[0]!;
    const id = executionIdFor(mission.id, step.id);

    // The registry refused before execute(): policy denied. The world was not touched.
    const runner = createBoundaryRunner(async () => ({ ok: false as const, error: kaiError("POLICY_DENIED", "denied") }), { ledger });
    const result = await runner(step, mission);

    assert.equal("ok" in result && result.ok, false);
    const record = ledger.get(id);
    assert.equal(record?.phase, "BEFORE_ACCEPT", "a refusal before the effect is not past the point of no return");
    assert.equal(record?.status, "FAILED");
    assert.equal(record?.sideEffectCount, 0, "no effect was attempted");
    assert.equal(ledger.classify(id).replaySafe, true);
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("boundary: a failure DURING the effect stays AFTER_ACCEPT (unsafe to replay)", async () => {
  const dir = tempDir();
  const ledger = createExecutionLedger({ path: join(dir, "ledger.db") });
  try {
    const mission = createMission({
      title: "failed-mid-effect",
      steps: [{ title: "send", kind: "tool", target: "net.send", sideEffecting: true }],
    });
    const step = mission.steps[0]!;
    const id = executionIdFor(mission.id, step.id);

    // INTERNAL means the tool threw while executing: the effect may have partially
    // applied, so the boundary must NOT rewind it.
    const runner = createBoundaryRunner(async () => ({ ok: false as const, error: kaiError("INTERNAL", "boom") }), { ledger });
    await runner(step, mission);

    assert.equal(ledger.get(id)?.phase, "AFTER_ACCEPT", "a mid-effect failure must not be rewound");
    assert.equal(ledger.classify(id).replaySafe, false);
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── B. the executor's park is durable, and classify reports it over HTTP ───────

test("a side-effecting step parked on approval records BEFORE_ACCEPT, and POST /recovery/classify says replaySafe:true", async () => {
  const dir = tempDir();
  const rt: CoreRuntime = createCoreRuntime({
    dbPath: join(dir, "core.db"),
    agents: { mode: "mock" },
    startScheduler: false,
    subsystemPaths: { runUpkeepOnStart: false, ledgerPath: join(dir, "recovery-ledger.db") },
  });
  try {
    // A WRITE tool the DEFAULT policy parks (it is not one of KAI's internal-state
    // tools): the executor gate demands approval, so the runner is never called.
    rt.tools.register({
      id: "test.gated",
      name: "Gated write",
      description: "A WRITE tool the default policy parks for a human.",
      risk: "WRITE",
      validate: () => ({ ok: true, value: {} }),
      execute: async () => ({ ran: true }),
    });

    const mission = await rt.createAndStartMission({
      title: "park before the effect",
      steps: [{ title: "write", kind: "tool", target: "test.gated", sideEffecting: true }],
    });
    assert.equal(mission.status, "WAITING_APPROVAL", "the step is parked, not run");

    const step = mission.steps[0]!;
    const id = executionIdFor(mission.id, step.id);
    const record = rt.recovery.get(id);
    assert.ok(record !== null, "a parked side-effecting step MUST have a durable record");
    assert.equal(record.phase, "BEFORE_ACCEPT");
    assert.equal(record.status, "RUNNING");
    assert.equal(record.sideEffectCount, 0);

    const api: CoreApi = createCoreApi(rt);
    const resp = await api.handle({
      method: "POST",
      path: "/recovery/classify",
      query: new URLSearchParams(), attested: true, ownerAuthConfigured: true,
      body: { executionId: id },
    });
    assert.equal(resp.status, 200, JSON.stringify(resp.body));
    const classification = (resp.body as { classification: { phase: string; replaySafe: boolean; sideEffectCount: number } }).classification;
    assert.equal(classification.phase, "BEFORE_ACCEPT");
    assert.equal(classification.replaySafe, true, "a before-accept execution is replay-safe");
    assert.equal(classification.sideEffectCount, 0);
  } finally {
    await rt.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recordRefusedBeforeEffect settles a pre-effect record as FAILED while staying BEFORE_ACCEPT", () => {
  const dir = tempDir();
  const ledger = createExecutionLedger({ path: join(dir, "ledger.db") });
  try {
    const mission = createMission({
      title: "refused park",
      steps: [{ title: "write", kind: "tool", target: "fs.write", sideEffecting: true }],
    });
    const step = mission.steps[0]!;
    const id = executionIdFor(mission.id, step.id);

    const runner = createBoundaryRunner(async () => ({ ok: true as const }), { ledger });
    runner.recordParkedBeforeEffect!(step, mission);
    assert.equal(ledger.get(id)?.status, "RUNNING");

    runner.recordRefusedBeforeEffect!(step, mission, "approval was not granted");
    const record = ledger.get(id);
    assert.equal(record?.phase, "BEFORE_ACCEPT", "the effect still never happened");
    assert.equal(record?.status, "FAILED", "a refused park does not linger as an open execution");
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── C. real crash + restart, from persisted state ─────────────────────────────

test("crash while parked before the effect: a RESTART classifies BEFORE_ACCEPT from the persisted ledger", () => {
  const dir = tempDir();
  const dbPath = join(dir, "core.db");
  const ledgerPath = join(dir, "ledger.db");
  try {
    assert.equal(runChild("mission-park", ledgerPath, join(dir, "count.txt"), dbPath), 7, "child died while parked");

    const stores = openSqliteStores({ path: dbPath });
    const ledger = createExecutionLedger({ path: ledgerPath });
    const mission = stores.missions.listMissions()[0]!;
    const step = mission.steps[0]!;
    const id = executionIdFor(mission.id, step.id);

    assert.equal(ledger.classify(id).phase, "BEFORE_ACCEPT");
    assert.equal(ledger.classify(id).replaySafe, true, "the decision comes from persisted state, not memory");
    ledger.close();
    stores.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("crash before accept: recover() resumes from the durable verdict and applies the effect exactly once", async () => {
  const dir = tempDir();
  const dbPath = join(dir, "core.db");
  const ledgerPath = join(dir, "ledger.db");
  const countPath = join(dir, "count.txt");
  try {
    assert.equal(runChild("mission-running-before-accept", ledgerPath, countPath, dbPath), 7);

    const stores = openSqliteStores({ path: dbPath });
    const ledger = createExecutionLedger({ path: ledgerPath });
    const mission = stores.missions.listMissions()[0]!;
    const step = mission.steps[0]!;
    const id = executionIdFor(mission.id, step.id);

    assert.equal(ledger.classify(id).phase, "BEFORE_ACCEPT");
    assert.equal(ledger.classify(id).replaySafe, true);

    let effects = 0;
    const runner = createBoundaryRunner(async () => {
      effects += 1;
      return { ok: true as const };
    }, { ledger });
    const executor = createMissionExecutor({ store: stores.missions, runner });

    const recovered = await executor.recover();
    assert.ok(recovered.resumed.includes(mission.id), "a before-accept mission is RESUMED, not blocked");
    assert.equal(effects, 1, "the effect was applied exactly once");

    const after = ledger.get(id);
    assert.equal(after?.phase, "AFTER_ACCEPT");
    assert.equal(after?.status, "COMPLETED");
    assert.equal(after?.sideEffectCount, 1, "the recovered action's side-effect count is exactly 1");
    assert.equal(ledger.classify(id).replaySafe, false, "a second recovery may not replay it again");

    ledger.close();
    stores.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
