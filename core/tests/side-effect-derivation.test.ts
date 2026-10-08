// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The side-effect derivation (FALSIFIED 2).
 *
 * The derivation used to be `impliedByRisk = tool.risk !== "READ"` — it keyed
 * off the declared RISK, not what the tool DOES. `missions.create` is READ (it
 * starts work whose own steps are policy-checked; it touches nothing itself)
 * yet creating a mission twice creates TWO missions, which the runtime's own
 * scheduled-job reasoning already treats as side-effecting. So a
 * `missions.create` step stored `sideEffecting:false`, ran, and left NO recovery
 * record — and since `executor.recover()` resumes such steps, a writing step
 * could be REPLAYED after a crash. Agent steps were never raised at all (the
 * derivation only looked at `kind === "tool"`), so an agent step calling the
 * EXTERNAL `agents.run_task` recorded nothing either.
 *
 * These cases pin the corrected derivation:
 *   - a `missions.create` step is side-effecting AND writes a recovery record;
 *   - an agent step is side-effecting AND records;
 *   - a plain READ step is still NOT, and writes no record;
 *   - a template may RAISE the classification but never LOWER it;
 *   - regression: a writing step can no longer escape the ledger.
 *
 * Every "side-effecting" case asserts a REAL ledger record exists — not merely a
 * boolean — because a boolean that writes nothing is exactly the defect.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCoreRuntime } from "../src/runtime.ts";
import { executionIdFor } from "../src/recovery/ledger.ts";
import type { CoreRuntime } from "../src/runtime.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "kai-derivation-"));
}

function boot(dir: string): CoreRuntime {
  return createCoreRuntime({
    dbPath: join(dir, "core.db"),
    agents: { mode: "mock" },
    startScheduler: false,
    subsystemPaths: { runUpkeepOnStart: false, ledgerPath: join(dir, "recovery-ledger.db") },
  });
}

interface StepView {
  sideEffecting: boolean;
  hasRecord: boolean;
  phase: string | null;
  status: string | null;
}

async function runToolStep(
  rt: CoreRuntime,
  toolId: string,
  templateSideEffecting?: boolean,
): Promise<StepView> {
  const mission = await rt.createAndStartMission({
    title: `derivation ${toolId}`,
    steps: [
      {
        title: "step",
        kind: "tool",
        target: toolId,
        ...(toolId === "missions.create" ? { input: { title: "nested" } } : {}),
        ...(templateSideEffecting !== undefined ? { sideEffecting: templateSideEffecting } : {}),
      },
    ],
  });
  const step = mission.steps[0]!;
  const record = rt.recovery.get(executionIdFor(mission.id, step.id));
  return {
    sideEffecting: step.sideEffecting,
    hasRecord: record !== null,
    phase: record?.phase ?? null,
    status: record?.status ?? null,
  };
}

test("a missions.create step is side-effecting and writes a recovery record", async () => {
  const dir = tempDir();
  const rt = boot(dir);
  try {
    const r = await runToolStep(rt, "missions.create");
    assert.equal(r.sideEffecting, true, "a READ tool that CREATES work is a side effect");
    assert.equal(r.hasRecord, true, "the acceptance boundary must record it");
    assert.equal(r.phase, "AFTER_ACCEPT", "it crossed the acceptance boundary");
    assert.equal(r.status, "COMPLETED");
  } finally {
    await rt.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an agent step is side-effecting and records (it reaches a worker through agents.run_task)", async () => {
  const dir = tempDir();
  const rt = boot(dir);
  try {
    const mission = await rt.createAndStartMission({
      title: "ask a worker",
      steps: [{ title: "ask hermes", kind: "agent", target: "hermes" }],
    });
    const step = mission.steps[0]!;
    assert.equal(step.sideEffecting, true, "an agent step is EXTERNAL by nature");
    const record = rt.recovery.get(executionIdFor(mission.id, step.id));
    assert.notEqual(record, null, "the acceptance boundary must record the agent step");
    // Default policy parks the worker action, so the durable record is the
    // pre-effect BEFORE_ACCEPT (the step has provably not run).
    assert.equal(record?.phase, "BEFORE_ACCEPT");
  } finally {
    await rt.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a READ tool step is still NOT side-effecting and writes no record", async () => {
  const dir = tempDir();
  const rt = boot(dir);
  try {
    rt.tools.register({
      id: "test.read",
      name: "Test read",
      description: "A READ tool registered only to pin the derivation.",
      risk: "READ",
      validate: () => ({ ok: true, value: {} }),
      execute: async () => ({ read: true }),
    });
    const r = await runToolStep(rt, "test.read");
    assert.equal(r.sideEffecting, false, "a READ tool does not imply a side effect");
    assert.equal(r.hasRecord, false, "a non-side-effecting step writes NO recovery record");
    assert.equal(rt.recovery.listAll().length, 0, "the ledger stays empty");
  } finally {
    await rt.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a template cannot lower the derived classification", async () => {
  const dir = tempDir();
  const rt = boot(dir);
  try {
    // The template asserts `false`; the tool's own effect wins.
    const r = await runToolStep(rt, "missions.create", false);
    assert.equal(r.sideEffecting, true, "a template may RAISE but never LOWER the classification");
    assert.equal(r.hasRecord, true, "the raised classification produced a real record");
  } finally {
    await rt.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("regression: a writing step can no longer escape the ledger", async () => {
  const dir = tempDir();
  const rt = boot(dir);
  try {
    const mission = await rt.createAndStartMission({
      title: "ledger completeness",
      steps: [
        { title: "create nested", kind: "tool", target: "missions.create", input: { title: "nested" } },
        { title: "ask hermes", kind: "agent", target: "hermes" },
      ],
    });
    // Every step that implies a side effect must have a durable acceptance record.
    const implied = mission.steps.filter((s) => s.sideEffecting);
    assert.equal(implied.length, 2, "both steps imply a side effect");
    for (const step of implied) {
      const record = rt.recovery.get(executionIdFor(mission.id, step.id));
      assert.notEqual(record, null, `step "${step.title}" escaped the ledger`);
    }
  } finally {
    await rt.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
