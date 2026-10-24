// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * AUTONOMY SWITCHES — DOER and Monster must stop real execution, not merely be
 * readable.
 *
 * The defect these pin: a switch whose only effect is what an endpoint returns
 * is decoration. Every case below drives the REAL executor and asserts on what
 * it actually did — whether a step ran, how many ran, and what the mission says
 * afterwards.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createMission, type MissionStepInput } from "../src/missions/mission.ts";
import { createMissionExecutor, type AutonomySwitches, type StepRunner } from "../src/missions/executor.ts";
import type { KaiEventType, Mission, MissionStatus, MissionStep, MissionStore } from "../src/shared/contracts.ts";

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

const switches = (over: Partial<AutonomySwitches> = {}): AutonomySwitches => ({
  doer: "ON",
  monster: "ON",
  steps: 24,
  minutes: 30,
  ...over,
});

/**
 * A runner that records every step it is actually asked to execute.
 *
 * `StepRunner` is a CALLABLE, not an object with `execute` — the real one is
 * invoked as `runner(step, mission, opts)`. Getting this wrong here made the
 * first version of these tests fail for a reason that had nothing to do with
 * the switches.
 */
function countingRunner(): { runner: StepRunner; ran: string[] } {
  const ran: string[] = [];
  const runner = (async (step: MissionStep) => {
    ran.push(step.id);
    return { ok: true as const, output: { did: step.title } };
  }) as unknown as StepRunner;
  return { runner, ran };
}

const STEPS: MissionStepInput[] = [
  { title: "one", kind: "agent", target: "hermes" },
  { title: "two", kind: "agent", target: "hermes" },
  { title: "three", kind: "agent", target: "hermes" },
];

function autonomousMission(steps: MissionStepInput[] = STEPS): Mission {
  const mission = createMission({ title: "Job", steps }, { idFactory: () => "m1" });
  return { ...mission, metadata: { ...(mission.metadata ?? {}), autonomous: true } };
}

const build = (store: MissionStore, runner: StepRunner, autonomy: () => AutonomySwitches, seen: KaiEventType[] = []) =>
  createMissionExecutor({
    store,
    runner,
    autonomy,
    publish: (type) => seen.push(type),
  });

test("DOER OFF blocks an autonomous mission before any step runs", async () => {
  const store = fakeStore();
  const { runner, ran } = countingRunner();
  const seen: KaiEventType[] = [];
  const exec = build(store, runner, () => switches({ doer: "OFF" }), seen);

  const mission = autonomousMission();
  store.upsertMission(mission);
  const after = await exec.start("m1");

  assert.deepEqual(ran, [], "no step may execute while DOER is OFF");
  assert.equal(after?.status, "DRAFT", "the mission is left exactly as it was, so it can run later");
  assert.equal(after?.metadata?.["blockedBy"], "DOER_OFF", "the refusal is recorded, not silent");
  assert.ok(seen.includes("mission.blocked"), "the block is a real event");
});

test("DOER OFF does NOT freeze a mission the owner started", async () => {
  const store = fakeStore();
  const { runner, ran } = countingRunner();
  const exec = build(store, runner, () => switches({ doer: "OFF" }));

  // No `autonomous` flag: this plan was approved by hand.
  const mission = createMission({ title: "Owner job", steps: STEPS }, { idFactory: () => "m1" });
  store.upsertMission(mission);
  await exec.start("m1");

  assert.equal(ran.length, 3, "a hand-approved plan is the owner's own work and must still run");
});

test("Monster's step budget stops the run and keeps the remaining steps for later", async () => {
  const store = fakeStore();
  const { runner, ran } = countingRunner();
  const seen: KaiEventType[] = [];
  const exec = build(store, runner, () => switches({ steps: 2 }), seen);

  const mission = autonomousMission();
  store.upsertMission(mission);
  const after = await exec.start("m1");

  assert.equal(ran.length, 2, "exactly the budgeted number of steps ran");
  assert.equal(after?.status, "WAITING", "an exhausted budget parks the mission rather than failing it");
  assert.equal(after?.metadata?.["blockedBy"], "MONSTER_BUDGET");
  assert.equal(after?.metadata?.["budget"], "steps");
  assert.ok(seen.includes("mission.blocked"));
  // The third step did not run and was not marked done: resuming continues here.
  assert.notEqual(after?.steps[2]?.status, "COMPLETED");
});

test("a budget that is not exhausted lets the whole mission finish", async () => {
  const store = fakeStore();
  const { runner, ran } = countingRunner();
  const exec = build(store, runner, () => switches({ steps: 24 }));

  const mission = autonomousMission();
  store.upsertMission(mission);
  const after = await exec.start("m1");

  assert.equal(ran.length, 3);
  assert.notEqual(after?.status, "DRAFT");
  assert.equal(after?.metadata?.["blockedBy"], undefined);
});

test("the switches are read per start, so flipping DOER takes effect on the next mission", async () => {
  const store = fakeStore();
  const { runner, ran } = countingRunner();
  let doer: "ON" | "OFF" = "OFF";
  const exec = build(store, runner, () => switches({ doer }));

  store.upsertMission(autonomousMission());
  await exec.start("m1");
  assert.equal(ran.length, 0, "blocked while OFF");

  doer = "ON";
  await exec.start("m1");
  assert.equal(ran.length, 3, "the same mission runs once the owner turns DOER on");
});
