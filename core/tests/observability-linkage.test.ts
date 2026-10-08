// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Phase 2 Part L — observability linkage.
 * Plain `node --test`, no dependencies, no network.
 * Run from `core/`:  node --test tests/observability-linkage.test.ts
 *
 * The action record already CARRIES optional correlation ids. These tests prove
 * they are USEFUL: one correlated chain —
 *
 *   scheduled task -> mission -> worker action -> memory/learning artifact
 *
 * — is emitted on the ONE existing bus, persisted, and then resolved back. From
 * the events alone the reader answers the Part L question:
 *
 *   "Which schedule/execution caused this memory write, and which mission/turn
 *    did it happen in?"
 *
 * It also pins the anti-regression that matters most: a record with NO
 * correlation ids is still valid (the fields are optional and additive), and a
 * missing link is reported honestly rather than guessed.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createEventBus } from "../src/events/bus.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import { buildActionRecord, type ActionRecord } from "../src/observability/action-record.ts";
import {
  actionRecords,
  correlationOf,
  traceArtifact,
  scheduleOriginOf,
} from "../src/observability/correlation.ts";
import type { EventStore, KaiEvent } from "../src/shared/contracts.ts";

// ── A durable-looking in-memory event store (the real bus persists action records) ──

class MemEventStore implements EventStore {
  private readonly events: KaiEvent[] = [];
  insertEvent(event: KaiEvent): void {
    this.events.unshift(event);
  }
  listEvents(opts?: {
    limit?: number;
    missionId?: string;
    types?: readonly KaiEvent["type"][];
    since?: string;
  }): KaiEvent[] {
    let out = [...this.events];
    if (opts?.missionId !== undefined) out = out.filter((e) => e.missionId === opts.missionId);
    if (opts?.types !== undefined) out = out.filter((e) => opts.types!.includes(e.type));
    return out.slice(0, opts?.limit ?? out.length);
  }
}

const T0 = "2026-02-01T10:00:00.000Z";
const T1 = "2026-02-01T10:00:01.000Z";

// The one correlated chain, named once so every assertion uses the same values.
const SCHEDULE_ID = "sched_9f";
const MISSION_ID = "mis_42";
const TURN_ID = "turn_7";
const ACTION_ID = "act_88";
const MEMORY_ID = "mem_1";
const LEARNING_ID = "learn_5";
const CHECKPOINT_ID = "ckpt_3";

// ── Production: a worker action links its mission through the real registry ────

test("PRODUCTION: a worker action through the tool registry carries its mission onto the action record", async () => {
  const store = new MemEventStore();
  const bus = createEventBus({ store });
  const registry = createToolRegistry({
    coreBuildId: "build_link_1",
    policy: { check: async () => ({ outcome: "allow", reason: "test allows", source: "default" }) },
    publish: (type, payload, opts) => {
      bus.publish(type, payload, opts);
    },
  });
  registry.register({
    id: "agents.run_task",
    name: "run task",
    description: "worker",
    risk: "READ",
    validate: (input) => ({ ok: true, value: input }),
    execute: async () => ({ ok: true }),
  });

  const ran = await registry.invoke(
    "agents.run_task",
    { agentId: "hermes", input: "hi" },
    { missionId: MISSION_ID, stepId: "step_7" },
  );
  assert.equal(ran.ok, true, JSON.stringify(ran));

  const record = actionRecords(bus.recent())[0];
  assert.ok(record, "the registry emitted an action.executed record");
  assert.equal(record.missionId, MISSION_ID, "the mission id threads from invoke() onto the record");
  assert.equal(record.executorType, "employee");
  assert.equal(record.employeeId, "hermes");

  // The mission correlation is also on the EVENT, so a mission-filtered read finds it.
  const byMission = store.listEvents({ missionId: MISSION_ID });
  assert.ok(byMission.some((e) => e.type === "action.executed"), "the persisted record is reachable by mission");
});

// ── The full chain: schedule -> mission -> turn -> action -> artifact ──────────

test("LINKAGE: one scheduled chain links schedule -> mission -> turn -> action -> memory/learning artifact", () => {
  const store = new MemEventStore();
  const bus = createEventBus({ store });

  // 1. The scheduler fires the task (taskId IS the schedule id).
  bus.publish(
    "scheduled_task.triggered",
    { taskId: SCHEDULE_ID, title: "nightly deploy", action: "mission.create", firedAt: T0, ok: true },
    { source: "scheduler" },
  );

  // 2. The runtime creates the mission the fire asked for.
  bus.publish("mission.created", { title: "nightly deploy", steps: 1 }, { missionId: MISSION_ID });

  // 3. The worker action that wrote the memory and produced the learning event.
  //    ONE record carries the whole chain.
  const record = buildActionRecord({
    coreBuildId: "build_link_1",
    actionId: ACTION_ID,
    toolId: "memory.write",
    policyDecision: "allow",
    decisionSource: "default",
    resultState: "EXECUTED",
    startedAt: T0,
    completedAt: T1,
    scheduleId: SCHEDULE_ID,
    missionId: MISSION_ID,
    turnId: TURN_ID,
    memoryId: MEMORY_ID,
    learningEventId: LEARNING_ID,
    checkpointId: CHECKPOINT_ID,
    recoveryDecision: "BEFORE_ACCEPT",
  });
  bus.publish("action.executed", record, { source: "core", missionId: MISSION_ID, stepId: "step_1" });

  // 4. The artifact itself lands on the same bus.
  bus.publish(
    "memory.created",
    { id: MEMORY_ID, type: "project_fact", content: "the deploy needs approval", source: "mission_result", importance: 4, createdAt: T1, updatedAt: T1 },
    { source: "core" },
  );

  const events = store.listEvents();

  // ── Answer "which schedule/execution caused this memory write, and which mission/turn" ──
  const trace = traceArtifact(events, { kind: "memory", id: MEMORY_ID });
  assert.equal(trace.linked, true, trace.reason);
  assert.equal(trace.actionId, ACTION_ID);
  assert.equal(trace.scheduleId, SCHEDULE_ID, "which schedule");
  assert.equal(trace.missionId, MISSION_ID, "which mission");
  assert.equal(trace.turnId, TURN_ID, "which turn");
  assert.equal(trace.checkpointId, CHECKPOINT_ID, "which execution/checkpoint");
  assert.equal(trace.recoveryDecision, "BEFORE_ACCEPT");
  assert.equal(trace.action?.toolId, "memory.write");

  // The learning artifact links the same way, off the same record.
  const learning = scheduleOriginOf(events, { kind: "learning", id: LEARNING_ID });
  assert.deepEqual(
    learning,
    { actionId: ACTION_ID, scheduleId: SCHEDULE_ID, missionId: MISSION_ID, turnId: TURN_ID },
    "the learning event resolves to the same schedule/mission/turn",
  );

  // And the schedule id resolves to a REAL fire event with that taskId.
  const fire = store.listEvents({ types: ["scheduled_task.triggered"] })[0];
  assert.ok(fire, "the schedule fire is on the bus");
  assert.equal((fire.payload as { taskId: string }).taskId, trace.scheduleId, "the schedule id names a real fire");

  // The single action record carries everything, so correlationOf is the whole link.
  assert.deepEqual(correlationOf(record), {
    actionId: ACTION_ID,
    scheduleId: SCHEDULE_ID,
    missionId: MISSION_ID,
    turnId: TURN_ID,
    checkpointId: CHECKPOINT_ID,
    recoveryDecision: "BEFORE_ACCEPT",
    memoryId: MEMORY_ID,
    learningEventId: LEARNING_ID,
  });
});

// ── Non-tautological: the resolver picks the RIGHT record among several ────────

test("the resolver links the artifact to the action that names it, not an earlier unrelated action", () => {
  const store = new MemEventStore();
  const bus = createEventBus({ store });

  // An unrelated action first, with a DIFFERENT memory id.
  bus.publish(
    "action.executed",
    buildActionRecord({
      coreBuildId: "b",
      actionId: "act_other",
      toolId: "memory.write",
      policyDecision: "allow",
      decisionSource: "default",
      resultState: "EXECUTED",
      startedAt: T0,
      completedAt: T0,
      missionId: "mis_other",
      memoryId: "mem_other",
    }),
    { source: "core", missionId: "mis_other" },
  );

  // The correlated action for THIS artifact.
  bus.publish(
    "action.executed",
    buildActionRecord({
      coreBuildId: "b",
      actionId: ACTION_ID,
      toolId: "memory.write",
      policyDecision: "allow",
      decisionSource: "default",
      resultState: "EXECUTED",
      startedAt: T0,
      completedAt: T1,
      scheduleId: SCHEDULE_ID,
      missionId: MISSION_ID,
      memoryId: MEMORY_ID,
    }),
    { source: "core", missionId: MISSION_ID },
  );

  const trace = traceArtifact(bus.recent(), { kind: "memory", id: MEMORY_ID });
  assert.equal(trace.linked, true);
  assert.equal(trace.actionId, ACTION_ID, "the record that names the artifact wins");
  assert.equal(trace.scheduleId, SCHEDULE_ID);
  assert.equal(trace.missionId, MISSION_ID, "not the unrelated action's mission");
});

// ── Honest absence and additive/back-compat ───────────────────────────────────

test("a missing link is reported, never guessed, and sparse records stay valid (fields are additive)", () => {
  const store = new MemEventStore();
  const bus = createEventBus({ store });

  // A record with NONE of the Phase 2 correlation ids — the pre-existing shape.
  const sparse = buildActionRecord({
    coreBuildId: "b",
    actionId: "act_sparse",
    toolId: "system.get_status",
    policyDecision: "allow",
    decisionSource: "default",
    resultState: "EXECUTED",
    startedAt: T0,
    completedAt: T0,
  });
  bus.publish("action.executed", sparse, { source: "core" });

  // Still a complete record was produced; the additive fields are simply absent.
  assert.equal(sparse.coreBuildId, "b");
  assert.equal(sparse.actionId, "act_sparse");
  assert.equal(sparse.toolId, "system.get_status");
  assert.equal(sparse.resultState, "EXECUTED");
  assert.equal(sparse.memoryId, undefined);
  assert.equal(sparse.scheduleId, undefined);

  // correlationOf degrades to just the action identity.
  assert.deepEqual(correlationOf(sparse), { actionId: "act_sparse" });

  // An artifact nothing names is an honest, non-throwing "no link".
  const trace = traceArtifact(bus.recent(), { kind: "memory", id: MEMORY_ID });
  assert.equal(trace.linked, false);
  assert.equal(trace.action, undefined);
  assert.match(trace.reason, /no action\.executed record names memory/);
  assert.equal(scheduleOriginOf(bus.recent(), { kind: "skill", id: "sku_x" }), undefined);
});

test("a partial chain links what it has and does not fabricate a schedule that never fired", () => {
  const store = new MemEventStore();
  const bus = createEventBus({ store });

  // A user-initiated action: a mission and a memory, but NO schedule.
  bus.publish(
    "action.executed",
    buildActionRecord({
      coreBuildId: "b",
      actionId: ACTION_ID,
      toolId: "memory.write",
      policyDecision: "allow",
      decisionSource: "default",
      resultState: "EXECUTED",
      startedAt: T0,
      completedAt: T0,
      missionId: MISSION_ID,
      turnId: TURN_ID,
      memoryId: MEMORY_ID,
    }),
    { source: "core", missionId: MISSION_ID },
  );

  const trace = traceArtifact(bus.recent(), { kind: "memory", id: MEMORY_ID });
  assert.equal(trace.linked, true);
  assert.equal(trace.missionId, MISSION_ID);
  assert.equal(trace.turnId, TURN_ID);
  assert.equal(trace.scheduleId, undefined, "no schedule is invented for a user-initiated action");
  assert.match(trace.reason, /linked to action/);

  const origin = scheduleOriginOf(bus.recent(), { kind: "memory", id: MEMORY_ID });
  assert.ok(origin, "the memory is still linked");
  assert.equal(origin.actionId, ACTION_ID);
  assert.equal(origin.missionId, MISSION_ID);
  assert.equal(origin.scheduleId, undefined);
});

// ── The ids survive serialisation (they are persisted, not just in memory) ─────

test("the correlation ids survive a JSON round-trip, so a persisted record still links", () => {
  const record = buildActionRecord({
    coreBuildId: "b",
    actionId: ACTION_ID,
    toolId: "memory.write",
    policyDecision: "allow",
    decisionSource: "default",
    resultState: "EXECUTED",
    startedAt: T0,
    completedAt: T1,
    scheduleId: SCHEDULE_ID,
    missionId: MISSION_ID,
    turnId: TURN_ID,
    memoryId: MEMORY_ID,
    learningEventId: LEARNING_ID,
  });

  const revived = JSON.parse(JSON.stringify(record)) as ActionRecord;
  assert.deepEqual(revived, record, "every correlation id is serialisable and round-trips");
  assert.equal(revived.scheduleId, SCHEDULE_ID);
  assert.equal(revived.memoryId, MEMORY_ID);
  assert.equal(revived.learningEventId, LEARNING_ID);
});
