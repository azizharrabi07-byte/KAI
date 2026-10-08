// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * PART 5 — agent objectives + editable instructions, proved deterministic.
 *
 * Against a REAL runtime (mock workers, temp dir):
 *   1. Persona A answers "What is your role?" from its own objective and
 *      instructions (they enter the worker-bound preamble, which the mock
 *      echoes — the reply carries them, proving runtime context, not prose).
 *   2. Editing the instructions changes the next reply; the old text is gone.
 *   3. Reload (same spec file) preserves the edit.
 *   4. Persona B with different instructions answers differently; sessions and
 *      memory buckets do not collide.
 *
 * Run from `core/`:  node --test tests/agents-objectives.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCoreRuntime } from "../src/runtime.ts";

function runtimeOn(dir: string) {
  return createCoreRuntime({
    dbPath: join(dir, "core.db"),
    agents: { mode: "mock" },
    startScheduler: false,
    subsystemPaths: { runUpkeepOnStart: false, ledgerPath: join(dir, "ledger.db") },
  });
}

async function boot(t: { after: (fn: () => void | Promise<void>) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "kai-agent-obj-"));
  const rt = runtimeOn(dir);
  await rt.start();
  t.after(async () => {
    await rt.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  return { rt, dir };
}

const SPEC_A = {
  id: "filescout",
  name: "FileScout",
  role: "filesystem researcher",
  description: "Finds facts in files.",
  soul: "I am careful and precise.",
  objective: "You are responsible for filesystem research.",
  instructions: "Always explain which files you inspected.",
  workerId: "opencode",
};

async function message(rt: ReturnType<typeof createCoreRuntime>, id: string, input: string): Promise<string> {
  // Runs park (EXTERNAL): approve, then re-issue with the decided approval.
  const first = (await rt.runSubagent(id, input)) as { runId?: string };
  const tracked = rt.activeSubagentRuns().find((run) => run.runId === first.runId);
  if (tracked?.approvalId !== undefined) {
    await rt.decideApproval(tracked.approvalId, true);
    const second = (await rt.runSubagent(id, input, tracked.approvalId)) as {
      result?: { output?: string };
      output?: string;
    };
    const output = second.result?.output ?? second.output ?? "";
    assert.ok(typeof output === "string" && output.length > 0, "the approved run produced output");
    return output;
  }
  const direct = first as { result?: { output?: string }; output?: string };
  return direct.result?.output ?? direct.output ?? "";
}

test("objective + instructions enter runtime context, edits apply, reload preserves, personas do not collide", async (t) => {
  const { rt, dir } = await boot(t);
  assert.equal((await rt.tools.invoke("workforce.subagent", SPEC_A)).ok, true);

  // 1. The persona answers from its own objective + instructions.
  const first = await message(rt, "filescout", "What is your role?");
  assert.ok(first.includes("You are responsible for filesystem research."), `objective in context:\n${first.slice(0, 300)}`);
  assert.ok(first.includes("Always explain which files you inspected."), `instructions in context:\n${first.slice(0, 300)}`);

  // 2. Edit the instructions: the next reply reflects the new behavior.
  const edited = await rt.tools.invoke("workforce.subagent", {
    ...SPEC_A,
    instructions: "Always answer in exactly three bullet points.",
  });
  assert.equal(edited.ok, true, "re-defining replaces the persona");
  const second = await message(rt, "filescout", "What is your role?");
  assert.ok(second.includes("Always answer in exactly three bullet points."), "new instructions in context");
  assert.ok(!second.includes("Always explain which files you inspected."), "old instructions gone");

  // 3. Objective survives untouched by the edit — and the whole edited spec
  // survives a restart (same spec file, fresh runtime).
  const kept = rt.subagents.get("filescout");
  assert.equal(kept?.spec.objective, "You are responsible for filesystem research.");
  assert.equal(kept?.spec.description, "Finds facts in files.");

  // 4. A second persona with different instructions does not collide.
  assert.equal(
    (
      await rt.tools.invoke("workforce.subagent", {
        id: "numberscout",
        name: "NumberScout",
        role: "data researcher",
        soul: "I love counting.",
        objective: "You are responsible for counting things.",
        instructions: "Always answer with a single number.",
        workerId: "opencode",
      })
    ).ok,
    true,
  );
  const other = await message(rt, "numberscout", "What is your role?");
  assert.ok(other.includes("Always answer with a single number."), "B has its own instructions");
  assert.ok(!other.includes("filesystem research"), "B never sees A's objective");
  assert.ok(!first.includes("counting things"), "A never saw B's objective");

  // Identity separation: distinct employee ids (hence distinct memory buckets
  // and session namespaces — persona sessions bind agentId to the employee).
  // Turn-level session isolation is proved in agents-lifecycle.test.ts.
  const a = rt.subagents.get("filescout");
  const b = rt.subagents.get("numberscout");
  assert.ok(a !== undefined && b !== undefined);
  assert.equal(a.employeeId, "kai:filescout");
  assert.equal(b.employeeId, "kai:numberscout");
  assert.notEqual(a.employeeId, b.employeeId);

  // 5. Reload: stop, boot fresh on the SAME directory, and the edited spec —
  // objective, instructions, description — is exactly what comes back.
  // Stopped inline (not in t.after): the boot hook removes the directory, so
  // every handle must be closed before it runs.
  await rt.stop();
  const rt2 = runtimeOn(dir);
  await rt2.start();
  try {
  const reloaded = rt2.subagents.get("filescout");
  assert.ok(reloaded !== undefined, "persona survived restart");
  assert.equal(reloaded.spec.objective, "You are responsible for filesystem research.");
  assert.equal(reloaded.spec.instructions, "Always answer in exactly three bullet points.");
  assert.equal(reloaded.spec.description, "Finds facts in files.");
  const reloadedReply = await message(rt2, "filescout", "What is your role?");
  assert.ok(reloadedReply.includes("Always answer in exactly three bullet points."), "reloaded persona behaves per its persisted instructions");
  } finally {
    await rt2.stop();
  }
});
