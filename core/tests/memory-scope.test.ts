// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The memory.write scope contract. A mission step that writes memory without
 * naming a scope used to die with SCOPE_VIOLATION ("must be one of …") — a
 * message that read like the VALUE was wrong when the field was simply absent.
 *
 * Producer/consumer repair:
 *   - the tool validates scope strictly at the boundary (missing vs malformed
 *     get distinct, structured errors; nothing silently defaults to global);
 *   - the mission runner binds a scope-less memory.write step to its own
 *     mission (the step IS mission context); an explicit scope is never
 *     rewritten.
 *
 *   cd core && node --test tests/memory-scope.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCoreRuntime } from "../src/runtime.ts";
import { createMission } from "../src/missions/mission.ts";

function testRuntime(dir: string) {
  return createCoreRuntime({
    dbPath: join(dir, "kai.db"),
    agents: { mode: "mock" },
    startScheduler: false,
    subsystemPaths: { runUpkeepOnStart: false, ledgerPath: join(dir, "ledger.db") },
  });
}

async function withRuntime<T>(fn: (rt: ReturnType<typeof createCoreRuntime>, dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "kai-memscope-"));
  const rt = testRuntime(dir);
  await rt.start();
  try {
    return await fn(rt, dir);
  } finally {
    await rt.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("valid global scope writes", async () => {
  await withRuntime(async (rt) => {
    const result = (await rt.tools.invoke("memory.write", {
      content: "global scope probe fact",
      type: "note",
      scope: "global",
    })) as { ok: boolean; result?: { entry?: { scope?: string; scopeId?: string } } };
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.result?.entry?.scope, "global");
  });
});

test("missing scope fails INVALID with a structured missing-field error", async () => {
  await withRuntime(async (rt) => {
    const result = (await rt.tools.invoke("memory.write", {
      content: "scope-less probe fact",
      type: "note",
    })) as { ok: boolean; error?: { code?: string; message?: string } };
    assert.equal(result.ok, false);
    assert.match(result.error?.message ?? "", /scope is required/);
  });
});

test("malformed scope fails INVALID naming the vocabulary, not a crash", async () => {
  await withRuntime(async (rt) => {
    const result = (await rt.tools.invoke("memory.write", {
      content: "bad scope probe fact",
      type: "note",
      scope: "everywhere",
    })) as { ok: boolean; error?: { code?: string; message?: string } };
    assert.equal(result.ok, false);
    assert.match(result.error?.message ?? "", /must be one of/);
    assert.match(result.error?.message ?? "", /"everywhere"/);
  });
});

test("mission scope with a bogus id refuses with a structured value, never silently", async () => {
  await withRuntime(async (rt) => {
    // The tool RUNS (validation passed: the scope is well-formed) and answers
    // with a typed refusal VALUE — the shape the model loop and the HTTP route
    // both consume. Silence would be an EXECUTED step with no trace of why.
    const result = (await rt.tools.invoke("memory.write", {
      content: "bogus mission probe",
      type: "note",
      scope: "mission",
      scopeId: "mission-that-does-not-exist",
    })) as { ok: boolean; result?: { ok?: boolean; refusal?: { reason?: string; detail?: string } } };
    assert.equal(result.ok, true, "the boundary ran; the refusal is data, not a throw");
    assert.equal(result.result?.ok, false);
    assert.equal(result.result?.refusal?.reason, "SCOPE_VIOLATION");
    assert.match(result.result?.refusal?.detail ?? "", /mission-that-does-not-exist/);
  });
});

test("a mission step whose write is refused FAILS honestly instead of completing", async () => {
  await withRuntime(async (rt) => {
    // A step whose tool answers {ok:false, refusal} did NOT do its work: the
    // mission must FAIL with the refusal reason, never COMPLETE over it.
    // (This is the exact pathology in docs/evidence/live/missions.json.)
    const mission = createMission({
    metadata: { criteria: ["file present: package.json"] },
      title: "refused write probe mission",
      steps: [
        {
          title: "write to a mission that does not exist",
          kind: "tool",
          target: "memory.write",
          sideEffecting: true,
          input: { content: "refused probe fact", type: "note", scope: "mission", scopeId: "mission-that-does-not-exist" },
        },
      ],
    });
    rt.stores.missions.upsertMission(mission);
    const done = await rt.missions.start(mission.id);
    assert.equal(done.status, "FAILED", "a refused write fails the mission");
    assert.equal(done.steps[0]?.status, "FAILED");
    assert.match(done.steps[0]?.error?.message ?? "", /mission-that-does-not-exist/);
  });
});

test("a mission step without scope lands mission-scoped on its own mission", async () => {
  await withRuntime(async (rt) => {
    const mission = createMission({
    metadata: { criteria: ["file present: package.json"] },
      title: "memory scope probe mission",
      steps: [
        {
          title: "write a memory",
          kind: "tool",
          target: "memory.write",
          sideEffecting: true,
          input: { content: "mission-step probe fact", type: "note" },
        },
      ],
    });
    rt.stores.missions.upsertMission(mission);
    const done = await rt.missions.start(mission.id);
    assert.equal(done.status, "COMPLETED", JSON.stringify(done.steps));
    assert.equal(done.steps[0]?.status, "COMPLETED");
    const hits = rt.memoryEngine.search({
      text: "mission-step probe fact",
      types: ["note"],
      scopes: [{ scope: "global" }, { scope: "mission", ids: [mission.id] }],
      limit: 50,
    });
    const entry = hits.map((h) => h.entry).find((m) => m.content === "mission-step probe fact");
    assert.ok(entry !== undefined, "the fact was written");
    assert.equal(entry.scope, "mission");
    assert.equal(entry.scopeId, mission.id);
  });
});

test("a mission step with an explicit scope is never rewritten by the runner", async () => {
  await withRuntime(async (rt) => {
    const mission = createMission({
    metadata: { criteria: ["file present: package.json"] },
      title: "explicit scope probe mission",
      steps: [
        {
          title: "write a global memory",
          kind: "tool",
          target: "memory.write",
          sideEffecting: true,
          input: { content: "explicit-global probe fact", type: "note", scope: "global" },
        },
      ],
    });
    rt.stores.missions.upsertMission(mission);
    const done = await rt.missions.start(mission.id);
    assert.equal(done.status, "COMPLETED", JSON.stringify(done.steps));
    const hits = rt.memoryEngine.search({ text: "explicit-global probe fact", types: ["note"], limit: 50 });
    const entry = hits.map((h) => h.entry).find((m) => m.content === "explicit-global probe fact");
    assert.ok(entry !== undefined, "the fact was written");
    assert.equal(entry.scope, "global");
  });
});
