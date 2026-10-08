// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Event bus tests. Plain `node --test`, no dependencies.
 * Run from `core/`:  node --test tests/events.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createEventBus } from "../src/events/bus.ts";
import type { EventStore, KaiEvent } from "../src/shared/contracts.ts";

/** Hand-written fake — deliberately does NOT import core/src/storage. */
function fakeEventStore(): EventStore & { inserted: KaiEvent[] } {
  const inserted: KaiEvent[] = [];
  return {
    inserted,
    insertEvent(event: KaiEvent): void {
      inserted.push(event);
    },
    listEvents(): KaiEvent[] {
      return inserted.slice();
    },
  };
}

/** Deterministic clock + ids for tests that must not depend on wall time. */
const FIXED_ISO = "2026-01-02T03:04:05.000Z";
function fixedNow(): () => Date {
  return () => new Date(FIXED_ISO);
}
function counterIds(): { next: () => string; calls: number } {
  const state = { calls: 0, next: () => `id-${++state.calls}` };
  return state as { next: () => string; calls: number };
}

test("publish delivers the built event to a subscriber and returns it", () => {
  const bus = createEventBus();
  const seen: KaiEvent[] = [];
  bus.subscribe((event) => seen.push(event));

  const emitted = bus.publish("mission.created", { id: "m1" }, { source: "mission:m1", missionId: "m1" });

  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.id, emitted.id);
  assert.equal(emitted.type, "mission.created");
  assert.equal(emitted.source, "mission:m1");
  assert.equal(emitted.missionId, "m1");
  assert.deepEqual(emitted.payload, { id: "m1" });
  assert.ok(Number.isFinite(Date.parse(emitted.timestamp)), "timestamp must be ISO-8601");
  assert.equal(typeof emitted.stepId, "undefined");
});

test("source defaults to \"core\"", () => {
  const bus = createEventBus();
  assert.equal(bus.publish("core.status_changed", {}).source, "core");
});

test("subscribe's returned unsubscribe function stops delivery (and is idempotent)", () => {
  const bus = createEventBus();
  let calls = 0;
  const off = bus.subscribe(() => { calls += 1; });

  bus.publish("agent.output", "one");
  assert.equal(calls, 1);

  off();
  bus.publish("agent.output", "two");
  assert.equal(calls, 1, "handler must not fire after unsubscribe");

  assert.doesNotThrow(() => off());
  assert.doesNotThrow(() => off());
  bus.publish("agent.output", "three");
  assert.equal(calls, 1);
});

test("unsubscribe(handler) works directly and twice without removing others", () => {
  const bus = createEventBus();
  const hitsA: string[] = [];
  const hitsB: string[] = [];
  const a = (event: KaiEvent): void => { hitsA.push(event.type); };
  const b = (event: KaiEvent): void => { hitsB.push(event.type); };

  bus.subscribe(a);
  bus.subscribe(b);

  bus.unsubscribe(a);
  bus.publish("mission.started", {});
  assert.deepEqual(hitsA, [], "unsubscribed handler must not fire");
  assert.deepEqual(hitsB, ["mission.started"], "other subscriber unaffected");

  // Calling it again must not throw, and must not take out the neighbour.
  assert.doesNotThrow(() => bus.unsubscribe(a));
  bus.publish("mission.progress", {});
  assert.deepEqual(hitsB, ["mission.started", "mission.progress"]);
});

test("multiple independent subscribers all receive a matching event", () => {
  const bus = createEventBus();
  let first = 0;
  let second = 0;
  bus.subscribe(() => { first += 1; });
  bus.subscribe(() => { second += 1; });

  bus.publish("memory.created", { id: "mem1" });

  assert.equal(first, 1);
  assert.equal(second, 1);
});

test("type filtering delivers only the requested types", () => {
  const bus = createEventBus();
  const seen: string[] = [];
  bus.subscribe((event) => seen.push(event.type), { types: ["mission.created", "mission.failed"] });

  bus.publish("mission.created", {});
  bus.publish("agent.output", "ignored");
  bus.publish("mission.failed", {});
  bus.publish("notification.created", {});

  assert.deepEqual(seen, ["mission.created", "mission.failed"]);
});

test("an empty types array matches nothing; no types receives everything", () => {
  const bus = createEventBus();
  let none = 0;
  let all = 0;
  bus.subscribe(() => { none += 1; }, { types: [] });
  bus.subscribe(() => { all += 1; });

  bus.publish("agent.connected", {});

  assert.equal(none, 0);
  assert.equal(all, 1);
});

test("missionId filtering receives only events carrying that mission", () => {
  const bus = createEventBus();
  const seen: string[] = [];
  bus.subscribe((event) => seen.push(event.id), { missionId: "m1" });

  const inMission = bus.publish("mission.progress", {}, { missionId: "m1" });
  bus.publish("mission.progress", {}, { missionId: "m2" });
  bus.publish("agent.output", "no mission");
  const stillIn = bus.publish("mission.completed", {}, { missionId: "m1" });

  assert.deepEqual(seen, [inMission.id, stillIn.id]);
});

test("types and missionId filters combine (both must match)", () => {
  const bus = createEventBus();
  let hits = 0;
  bus.subscribe(() => { hits += 1; }, { types: ["mission.progress"], missionId: "m1" });

  bus.publish("mission.progress", {}, { missionId: "m1" }); // match
  bus.publish("mission.progress", {}, { missionId: "m2" }); // wrong mission
  bus.publish("agent.output", "x", { missionId: "m1" });    // wrong type

  assert.equal(hits, 1);
});

test("a throwing subscriber does not stop the others or break publish", () => {
  const bus = createEventBus();
  const order: string[] = [];
  bus.subscribe(() => { order.push("first"); throw new Error("subscriber exploded"); });
  bus.subscribe(() => { order.push("second"); });

  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
  let emitted: KaiEvent | undefined;
  try {
    assert.doesNotThrow(() => {
      emitted = bus.publish("agent.error", { reason: "boom" });
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(order, ["first", "second"], "second subscriber must still see the event");
  assert.equal(emitted?.type, "agent.error", "publish must still return the event");
  assert.ok(
    warnings.some((line) => line.includes(emitted?.id ?? "%%") && line.includes("agent.error")),
    "the failure must be recorded with the event id and type",
  );
});

test("recent() returns in-memory events newest first, honouring limit", () => {
  const bus = createEventBus();
  const a = bus.publish("agent.connected", "a");
  const b = bus.publish("agent.output", "b");
  const c = bus.publish("mission.created", "c");

  assert.deepEqual(bus.recent().map((e) => e.id), [c.id, b.id, a.id]);
  assert.deepEqual(bus.recent(2).map((e) => e.id), [c.id, b.id]);
  assert.deepEqual(bus.recent(0), []);
});

test("recent() is a copy — mutating it cannot corrupt the bus", () => {
  const bus = createEventBus();
  bus.publish("agent.connected", "a");
  const snapshot = bus.recent();
  snapshot.length = 0;
  assert.equal(bus.recent().length, 1);
});

test("persistence is skipped for a non-persisted type and performed for a persisted one", () => {
  const store = fakeEventStore();
  const bus = createEventBus({ store, now: fixedNow(), idFactory: counterIds().next });

  const chatty = bus.publish("agent.output", "stream chunk"); // not in PERSISTED_EVENT_TYPES
  bus.publish("mission.progress", {});                        // not persisted
  const important = bus.publish("mission.created", { id: "m1" }); // persisted

  assert.equal(store.inserted.length, 1);
  assert.equal(store.inserted[0]?.id, important.id);
  assert.equal(store.inserted[0]?.type, "mission.created");
  assert.ok(!store.inserted.some((e) => e.id === chatty.id));
});

test("without a store the bus behaves identically, minus persistence", () => {
  const bus = createEventBus();
  let hits = 0;
  bus.subscribe(() => { hits += 1; });
  bus.publish("mission.created", {});
  assert.equal(hits, 1);
  assert.equal(bus.recent().length, 1);
});

test("injected now and idFactory make events deterministic", () => {
  const ids = counterIds();
  const bus = createEventBus({ now: fixedNow(), idFactory: ids.next });

  const first = bus.publish("agent.connected", "one");
  const second = bus.publish("agent.output", "two");

  assert.equal(first.id, "id-1");
  assert.equal(second.id, "id-2");
  assert.equal(first.timestamp, FIXED_ISO);
  assert.equal(second.timestamp, FIXED_ISO);
});

test("default ids stay unique within the same millisecond", () => {
  const bus = createEventBus({ now: fixedNow() });
  const ids = new Set<string>();
  for (let i = 0; i < 5; i += 1) ids.add(bus.publish("agent.output", i).id);
  assert.equal(ids.size, 5);
});
