// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * THE EVIDENCE GATE — a worker can no longer complete a mission by SAYING it succeeded.
 *
 * A live Hermes run demonstrated the defect: the worker's own output said
 * `read_file was blocked twice by kai-guard`, and the mission was marked COMPLETED.
 * These tests pin the replacement rule against that exact scenario and its variants.
 *
 * Every case drives the EXECUTOR's real status transition, not a helper: the bug lived
 * in the transition, so a unit test of the verifier alone would not have caught it.
 *
 * The criteria point at REAL files in this suite's workspace (`core/package.json`), so
 * "verified" means KAI actually read something — never that a fixture said so.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMission, type MissionStepInput } from "../src/missions/mission.ts";
import { createMissionExecutor, type StepRunner } from "../src/missions/executor.ts";
import type { KaiEventType, Mission, MissionStatus, MissionStore } from "../src/shared/contracts.ts";

// ── Fakes (same shape the mission suite uses) ─────────────────────────────────

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function fakeStore(): MissionStore {
  const rows = new Map<string, Mission>();
  const terminal = new Set<MissionStatus>(["COMPLETED", "FAILED", "CANCELLED"]);
  return {
    upsertMission: (m) => rows.set(m.id, clone(m)),
    getMission: (id) => (rows.has(id) ? clone(rows.get(id)!) : null),
    listMissions: (opts) => {
      let out = [...rows.values()].map(clone);
      if (opts?.status !== undefined) out = out.filter((m) => m.status === opts.status);
      return opts?.limit === undefined ? out : out.slice(0, opts.limit);
    },
    listUnfinishedMissions: () => [...rows.values()].filter((m) => !terminal.has(m.status)).map(clone),
    deleteMission: (id) => rows.delete(id),
  };
}

interface Seen {
  type: KaiEventType;
  payload: unknown;
}
function recorder(): { seen: Seen[]; publish: (t: KaiEventType, p: unknown, o?: Record<string, unknown>) => void } {
  const seen: Seen[] = [];
  return { seen, publish: (type, payload) => seen.push({ type, payload }) };
}

const ONE_STEP: MissionStepInput[] = [{ title: "report", kind: "agent", target: "hermes" }];

/** A mission over a given step set, with explicitly declared acceptance criteria. */
function missionWith(criteria: string[], steps: MissionStepInput[] = ONE_STEP): Mission {
  return createMission(
    { title: "Job", steps, ...(criteria.length > 0 ? { metadata: { criteria } } : {}) },
    { idFactory: () => "m1" },
  );
}

/** Run one mission to completion through the REAL executor and return the settled row. */
async function run(
  criteria: string[],
  runner: StepRunner,
  opts: { store?: MissionStore; seen?: Seen[]; steps?: MissionStepInput[]; mission?: Mission } = {},
): Promise<{ mission: Mission | null; store: MissionStore }> {
  const store = opts.store ?? fakeStore();
  const { seen, publish } = recorder();
  const exec = createMissionExecutor({ store, runner, publish });
  const mission = opts.mission ?? missionWith(criteria, opts.steps);
  store.upsertMission(mission);
  await exec.start(mission.id);
  if (opts.seen !== undefined) opts.seen.push(...seen);
  return { mission: store.getMission(mission.id), store };
}

// ── 1. The demonstrated bug: an honest worker reporting a BLOCKED tool ────────

test("1. a worker that CLAIMS success while reporting a blocked tool cannot complete", async () => {
  // The exact shape of the live run: the runner returns ok, and its text says the tool
  // was blocked and it has no value.
  const { mission } = await run(["file present: build/mission-artifact.txt"], async () => ({
    ok: true,
    output: {
      output:
        'Couldn\'t read it — read_file was blocked twice by kai-guard: "the KAI owner credential could not be read, so this action was not authorized." So I have no version value to give you.',
    },
  }));

  assert.notEqual(mission?.status, "COMPLETED", "a blocked tool plus a claim must never be completion");
  assert.equal(mission?.status, "FAILED");
  assert.match(String(mission?.error?.message), /UNVERIFIED/i);
});

// ── 2. A denied tool ─────────────────────────────────────────────────────────

test("2. a DENIED action authorises nothing and cannot be completed on a claim", async () => {
  // The policy refuses the step outright; later steps never run.
  const denied = createMissionExecutor({
    store: fakeStore(),
    runner: async () => ({ ok: true, output: { output: "done!" } }),
    policy: {
      check: () => ({ outcome: "deny" as const, reason: "terminal is permanently denied" }),
    },
  });
  const store = fakeStore();
  const m = missionWith(["file present: package.json"]);
  store.upsertMission(m);
  const exec = createMissionExecutor({
    store,
    runner: async () => ({ ok: true, output: { output: "done!" } }),
    policy: { check: () => ({ outcome: "deny" as const, reason: "terminal is permanently denied" }) },
  });
  const settled = await exec.start(m.id);
  assert.equal(settled.status, "FAILED");
  assert.notEqual(settled.status, "COMPLETED");
  void denied;
});

// ── 3. Missing evidence ─────────────────────────────────────────────────────

test("3. the RIGHT answer with NO declared criteria cannot complete", async () => {
  // This is the old bug's core: "the output looks right" was enough. It is not evidence.
  const { mission } = await run([], async () => ({ ok: true, output: { output: "0.1.0" } }));
  assert.equal(mission?.status, "FAILED");
  assert.match(String(mission?.error?.message), /no acceptance criteria/i);
});

// ── 4. Mismatched evidence ──────────────────────────────────────────────────

test("4. a criterion naming a DIFFERENT artifact is not satisfied by this one", async () => {
  const { mission } = await run(["file json field: package.json#version = 0.1.0"], async () => ({
    ok: true,
    output: { output: "0.1.0" },
  }));
  assert.equal(mission?.status, "COMPLETED", "the real file does say 0.1.0");

  // Now the same mission pointed at a file that does not hold that value: the worker's
  // claim is unchanged, and it must not carry the mission.
  const { mission: mismatched } = await run(["file json field: tsconfig.json#version = 0.1.0"], async () => ({
    ok: true,
    output: { output: "0.1.0" },
  }));
  assert.equal(mismatched?.status, "FAILED", "evidence for another artifact settles nothing");
  // Either refusal is correct — the field is absent, or it is present with another
  // value. What must never happen is completion.
  assert.match(String(mismatched?.error?.message), /not present|does NOT match/i);
});

test("4b. a criterion outside the workspace sandbox is refused, not read", async () => {
  const { mission } = await run(["file content equals: C:/Windows/win.ini = anything"], async () => ({
    ok: true,
    output: { output: "anything" },
  }));
  assert.equal(mission?.status, "FAILED");
  assert.match(String(mission?.error?.message), /outside the workspace sandbox/i);
});

// ── 5. Incorrect artifact ───────────────────────────────────────────────────

test("5. a real file whose content does NOT satisfy the criterion cannot complete", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kai-gate-"));
  try {
    const file = join(dir, "artifact.txt");
    writeFileSync(file, "the wrong value");
    const { mission } = await run([`file content equals: ${file} = "the right value"`], async () => ({
      ok: true,
      output: { output: "the right value" },
    }));
    assert.equal(mission?.status, "FAILED", "a successful tool run is not a satisfied criterion");
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// ── 6. A genuinely successful mission ──────────────────────────────────────

test("6. real observed evidence that satisfies the criterion DOES complete", async () => {
  const { mission } = await run(["file json field: package.json#version = 0.1.0"], async () => ({
    ok: true,
    output: { output: "0.1.0" },
  }));
  assert.equal(mission?.status, "COMPLETED");
  const verification = mission?.metadata?.["verification"] as { source?: string; verified?: string[] } | undefined;
  assert.equal(verification?.source, "kai-observed", "the record must say KAI observed it");
  assert.deepEqual(verification?.verified, ["file json field: package.json#version = 0.1.0"]);
});

// ── 7. Partial success ─────────────────────────────────────────────────────

test("7. one criterion passing while another is unverified cannot complete", async () => {
  const { mission } = await run(
    ["file present: package.json", "file json field: package.json#version = not-the-real-version"],
    async () => ({ ok: true, output: { output: "0.1.0" } }),
  );
  assert.equal(mission?.status, "FAILED");
  const verification = mission?.metadata?.["verification"] as { verified?: string[]; unverified?: unknown[] } | undefined;
  assert.deepEqual(verification?.verified, ["file present: package.json"]);
  assert.equal(verification?.unverified?.length, 1);
});

// ── 8. Persistence ─────────────────────────────────────────────────────────

test("8. the verification survives on the stored mission (a restart reads the same verdict)", async () => {
  const { store } = await run(["file present: package.json"], async () => ({ ok: true }));
  // A second executor over the SAME store is what a restart is: it re-reads the row.
  const reopened = store.getMission("m1");
  assert.equal(reopened?.status, "COMPLETED");
  const verification = reopened?.metadata?.["verification"] as { source?: string; checkedAt?: string } | undefined;
  assert.equal(verification?.source, "kai-observed");
  assert.ok(typeof verification?.checkedAt === "string");
});

// ── 9. Retry and interruption ──────────────────────────────────────────────

test("9. a later claim cannot rescue a mission whose verification already failed", async () => {
  const store = fakeStore();
  const { mission } = await run(["file present: does-not-exist.txt"], async () => ({ ok: true, output: { output: "done" } }), { store });
  assert.equal(mission?.status, "FAILED");

  // A subsequent executor run over the same store, with a worker that claims success,
  // must leave it FAILED: a terminal verdict is not overwritten by a later sentence.
  const exec = createMissionExecutor({ store, runner: async () => ({ ok: true, output: { output: "0.1.0" } }) });
  const after = await exec.start("m1");
  assert.equal(after?.status, "FAILED", "a failed verification is final");
});

// ── Recovery must obey the same gate ───────────────────────────────────────

test("recovery cannot complete an evidence-free mission just because its steps finished", async () => {
  const store = fakeStore();
  // Every step already COMPLETED, so `recover` takes its "settle" branch.
  const m = missionWith([]);
  m.status = "RUNNING";
  for (const step of m.steps) step.status = "COMPLETED";
  store.upsertMission(m);

  const exec = createMissionExecutor({ store, runner: async () => ({ ok: true }) });
  await exec.recover();
  assert.equal(store.getMission("m1")?.status, "FAILED", "recovery must not bypass the gate");
});
