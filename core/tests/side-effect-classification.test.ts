// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * A mission step's effective side-effect classification, derived from the tool
 * registry's DECLARED RISK.
 *
 * The rule (runtime.ts, at mission creation):
 *
 *     impliedByRisk = tool.risk !== "READ"
 *     effective     = impliedByRisk || template.sideEffecting
 *
 * A mission template may RAISE the classification, never LOWER it. The
 * registry's declared risk is the authority — never the step name, the tool
 * id's text, or a description. These six cases pin exactly that. Every
 * "effective true" case asserts a REAL recovery-ledger record exists (the
 * acceptance boundary ran), not merely a boolean.
 *
 * The risk levels are produced by registering real tools on the runtime's real
 * ToolRegistry; nothing here invents a second policy/classification mechanism.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCoreRuntime } from "../src/runtime.ts";
import { executionIdFor } from "../src/recovery/ledger.ts";
import type { CoreRuntime } from "../src/runtime.ts";
import type { RiskLevel } from "../src/shared/contracts.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "kai-classification-"));
}

function boot(dir: string): CoreRuntime {
  return createCoreRuntime({
    dbPath: join(dir, "core.db"),
    agents: { mode: "mock" },
    startScheduler: false,
    subsystemPaths: { runUpkeepOnStart: false, ledgerPath: join(dir, "recovery-ledger.db") },
    // Policy is NOT what is under test. Allow the test tools so each step
    // actually reaches the acceptance boundary and exercises the ledger; the
    // classification under test happens earlier, at mission creation.
    policyRules: [
      { id: "test-allow-write", risk: "WRITE", outcome: "allow", tools: ["test.write"] },
      { id: "test-allow-external", risk: "EXTERNAL", outcome: "allow", tools: ["test.external"] },
      { id: "test-allow-destructive", risk: "DESTRUCTIVE", outcome: "allow", tools: ["test.destructive"] },
    ],
  });
}

/** Register a real tool on the runtime's real registry, declaring the given risk. */
function registerTool(rt: CoreRuntime, id: string, risk: RiskLevel): void {
  rt.tools.register({
    id,
    name: `Test tool ${id}`,
    description: `A ${risk} tool registered only to pin the risk-derived classification.`,
    risk,
    validate: () => ({ ok: true, value: {} }),
    execute: async () => ({ ran: id }),
  });
}

interface CaseResult {
  sideEffecting: boolean;
  hasRecord: boolean;
  phase: string | null;
  status: string | null;
  total: number;
}

/** Create+start a one-step tool mission, then read back the derived classification. */
async function runCase(
  rt: CoreRuntime,
  toolId: string,
  templateSideEffecting: boolean,
): Promise<CaseResult> {
  const mission = await rt.createAndStartMission({
    metadata: { criteria: ["file present: package.json"] },
    title: `classification ${toolId}`,
    steps: [{ title: "step", kind: "tool", target: toolId, sideEffecting: templateSideEffecting }],
  });
  const step = mission.steps[0]!;
  const record = rt.recovery.get(executionIdFor(mission.id, step.id));
  return {
    sideEffecting: step.sideEffecting,
    hasRecord: record !== null,
    phase: record?.phase ?? null,
    status: record?.status ?? null,
    total: rt.recovery.listAll().length,
  };
}

test("1. READ tool + template sideEffecting=false → effective false, and NO recovery record", async () => {
  const dir = tempDir();
  const rt = boot(dir);
  try {
    registerTool(rt, "test.read", "READ");
    const r = await runCase(rt, "test.read", false);
    assert.equal(r.sideEffecting, false, "a READ tool does not imply a side effect");
    assert.equal(r.hasRecord, false, "a non-side-effecting step must write NO recovery record");
    assert.equal(r.total, 0, "the ledger stays empty for a READ-only step");
  } finally {
    await rt.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("2. WRITE tool + template sideEffecting=false → effective true, and a real recovery record exists", async () => {
  const dir = tempDir();
  const rt = boot(dir);
  try {
    registerTool(rt, "test.write", "WRITE");
    const r = await runCase(rt, "test.write", false);
    assert.equal(r.sideEffecting, true, "the registry's WRITE risk implies a side effect");
    assert.equal(r.hasRecord, true, "a side-effecting step must write a recovery record");
    assert.equal(r.phase, "AFTER_ACCEPT", "the record crossed the acceptance boundary");
    assert.equal(r.status, "COMPLETED", "the step ran to completion");
    assert.equal(r.total, 1, "the record is really in the ledger");
  } finally {
    await rt.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("3. EXTERNAL tool + template sideEffecting=false → effective true, and a real recovery record exists", async () => {
  const dir = tempDir();
  const rt = boot(dir);
  try {
    registerTool(rt, "test.external", "EXTERNAL");
    const r = await runCase(rt, "test.external", false);
    assert.equal(r.sideEffecting, true, "the registry's EXTERNAL risk implies a side effect");
    assert.equal(r.hasRecord, true, "a side-effecting step must write a recovery record");
    assert.equal(r.phase, "AFTER_ACCEPT");
    assert.equal(r.status, "COMPLETED");
    assert.equal(r.total, 1);
  } finally {
    await rt.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("4. DESTRUCTIVE tool + template sideEffecting=false → effective true, and a real recovery record exists", async () => {
  const dir = tempDir();
  const rt = boot(dir);
  try {
    registerTool(rt, "test.destructive", "DESTRUCTIVE");
    const r = await runCase(rt, "test.destructive", false);
    assert.equal(r.sideEffecting, true, "the registry's DESTRUCTIVE risk implies a side effect");
    assert.equal(r.hasRecord, true, "a side-effecting step must write a recovery record");
    assert.equal(r.phase, "AFTER_ACCEPT");
    assert.equal(r.status, "COMPLETED");
    assert.equal(r.total, 1);
  } finally {
    await rt.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("5. WRITE tool + template sideEffecting=false → still true (the template CANNOT lower it)", async () => {
  const dir = tempDir();
  const rt = boot(dir);
  try {
    registerTool(rt, "test.write", "WRITE");
    // The template's explicit `false` is the attempt to lower the classification;
    // the registry's WRITE risk wins, and the boundary record proves it.
    const r = await runCase(rt, "test.write", false);
    assert.equal(r.sideEffecting, true, "a template cannot lower a WRITE tool's classification");
    assert.equal(r.hasRecord, true, "the raised classification produced a real record");
  } finally {
    await rt.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("6. READ tool + template sideEffecting=true → true (the template CAN raise it)", async () => {
  const dir = tempDir();
  const rt = boot(dir);
  try {
    registerTool(rt, "test.read", "READ");
    const r = await runCase(rt, "test.read", true);
    assert.equal(r.sideEffecting, true, "a template may raise a READ tool's classification");
    assert.equal(r.hasRecord, true, "raising it produces a real recovery record");
    assert.equal(r.phase, "AFTER_ACCEPT");
    assert.equal(r.status, "COMPLETED");
  } finally {
    await rt.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
