// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Tests for the KAI Core scheduler.
 *
 * No real time is spent: the clock is a mutable Date the tests own, and the
 * timer is never waited on. The store is a hand-written in-memory fake that
 * implements the frozen ScheduledTaskStore interface and CLONES on the way in
 * and out, so a passing test proves the scheduler actually persisted its state
 * rather than merely holding a live reference.
 */

import test from "node:test";
import assert from "node:assert/strict";

import type { ScheduledTask, ScheduledTaskStore } from "../src/shared/contracts.ts";
import { computeNextRun, validateSchedule } from "../src/scheduler/schedule.ts";
import { createScheduler } from "../src/scheduler/scheduler.ts";

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** Fixed reference instant in LOCAL time: 2026-01-15 08:00:00. */
const T0 = new Date(2026, 0, 15, 8, 0, 0, 0);
const iso = (d: Date): string => d.toISOString();
const plus = (d: Date, ms: number): Date => new Date(d.getTime() + ms);

function makeTask(
  over: Partial<ScheduledTask> & Pick<ScheduledTask, "id" | "kind">,
): ScheduledTask {
  const base: Omit<ScheduledTask, "id" | "kind"> = {
    title: over.id,
    action: "noop",
    enabled: true,
    failureCount: 0,
    createdAt: iso(T0),
    updatedAt: iso(T0),
  };
  return { ...base, ...over };
}

/**
 * In-memory ScheduledTaskStore. Deliberately clones, so anything a test reads
 * back is genuinely what the scheduler wrote, not a shared object.
 */
class FakeStore implements ScheduledTaskStore {
  private rows = new Map<string, ScheduledTask>();
  upserts = 0;

  seed(task: ScheduledTask): void {
    this.rows.set(task.id, structuredClone(task));
  }

  upsertScheduledTask(task: ScheduledTask): void {
    this.upserts += 1;
    this.rows.set(task.id, structuredClone(task));
  }

  getScheduledTask(id: string): ScheduledTask | null {
    const task = this.rows.get(id);
    return task ? structuredClone(task) : null;
  }

  listScheduledTasks(opts?: { enabledOnly?: boolean }): ScheduledTask[] {
    const all = [...this.rows.values()].map((task) => structuredClone(task));
    return opts?.enabledOnly ? all.filter((task) => task.enabled) : all;
  }

  deleteScheduledTask(id: string): void {
    this.rows.delete(id);
  }
}

/** A scheduler wired to a fake store and a controllable clock. */
function makeScheduler(
  store: FakeStore,
  onFire: (task: ScheduledTask) => Promise<void>,
  tickMs = 3_600_000,
) {
  let clock = T0;
  const scheduler = createScheduler({
    store,
    onFire,
    now: () => clock,
    tickMs,
  });
  return { scheduler, setClock: (d: Date) => (clock = d) };
}

// ── computeNextRun: pure arithmetic ──────────────────────────────────────────

test("computeNextRun: once returns the instant when still ahead, null when past", () => {
  const future = makeTask({ id: "f", kind: "once", runAt: iso(plus(T0, 60_000)) });
  assert.equal(computeNextRun(future, T0)?.getTime(), plus(T0, 60_000).getTime());

  const past = makeTask({ id: "p", kind: "once", runAt: iso(plus(T0, -1)) });
  assert.equal(computeNextRun(past, T0), null);

  const at = makeTask({ id: "a", kind: "once", runAt: iso(T0) });
  assert.equal(computeNextRun(at, T0)?.getTime(), T0.getTime(), "exactly-now is not yet past");
});

test("computeNextRun: interval is from + intervalMs", () => {
  const task = makeTask({ id: "i", kind: "interval", intervalMs: 90_000 });
  assert.equal(computeNextRun(task, T0)?.getTime(), plus(T0, 90_000).getTime());
});

test("computeNextRun: daily uses the next LOCAL occurrence", () => {
  const ahead = makeTask({ id: "d1", kind: "daily", atTime: "09:00" });
  const n1 = computeNextRun(ahead, T0);
  assert.ok(n1);
  assert.equal(n1.getFullYear(), 2026);
  assert.equal(n1.getMonth(), 0);
  assert.equal(n1.getDate(), 15, "09:00 is still ahead of 08:00 -> today");
  assert.equal(n1.getHours(), 9);
  assert.equal(n1.getMinutes(), 0);

  // Already passed today -> tomorrow.
  const passed = makeTask({ id: "d2", kind: "daily", atTime: "07:00" });
  const n2 = computeNextRun(passed, T0);
  assert.ok(n2);
  assert.equal(n2.getDate(), 16, "07:00 already passed -> tomorrow");
  assert.equal(n2.getHours(), 7);

  // Exactly the current time counts as passed, not as "still ahead".
  const exactly = makeTask({ id: "d3", kind: "daily", atTime: "08:00" });
  assert.equal(computeNextRun(exactly, T0)?.getDate(), 16);
});

test("computeNextRun: malformed input returns null, never throws", () => {
  const cases: ScheduledTask[] = [
    makeTask({ id: "x1", kind: "interval" }),
    makeTask({ id: "x2", kind: "interval", intervalMs: -1 }),
    makeTask({ id: "x3", kind: "interval", intervalMs: 0 }),
    makeTask({ id: "x4", kind: "daily", atTime: "25:00" }),
    makeTask({ id: "x5", kind: "daily", atTime: "9am" }),
    makeTask({ id: "x6", kind: "once", runAt: "not-a-date" }),
    makeTask({ id: "x7", kind: "once" }),
  ];
  for (const task of cases) {
    assert.equal(computeNextRun(task, T0), null, `${task.id} should be null`);
  }
});

test("validateSchedule explains each malformed case", () => {
  assert.deepEqual(validateSchedule(makeTask({ id: "ok1", kind: "interval", intervalMs: 1000 })), {
    ok: true,
  });
  assert.deepEqual(validateSchedule(makeTask({ id: "ok2", kind: "daily", atTime: "00:00" })), {
    ok: true,
  });
  assert.deepEqual(
    validateSchedule(makeTask({ id: "ok3", kind: "once", runAt: iso(T0) })),
    { ok: true },
  );

  const missingInterval = validateSchedule(makeTask({ id: "b1", kind: "interval" }));
  assert.equal(missingInterval.ok, false);
  assert.match(missingInterval.ok === false ? missingInterval.reason : "", /intervalMs/);

  const nonPositive = validateSchedule(makeTask({ id: "b2", kind: "interval", intervalMs: -5 }));
  assert.equal(nonPositive.ok, false);
  assert.match(nonPositive.ok === false ? nonPositive.reason : "", /positive/i);

  const badTime = validateSchedule(makeTask({ id: "b3", kind: "daily", atTime: "7:5" }));
  assert.equal(badTime.ok, false);
  assert.match(badTime.ok === false ? badTime.reason : "", /HH:MM/);

  const badRunAt = validateSchedule(makeTask({ id: "b4", kind: "once", runAt: "whenever" }));
  assert.equal(badRunAt.ok, false);
  assert.match(badRunAt.ok === false ? badRunAt.reason : "", /runAt/);
});

// ── tick: firing ─────────────────────────────────────────────────────────────

test("tick fires a due interval task once and persists lastRun + advanced nextRun", async () => {
  const store = new FakeStore();
  store.seed(makeTask({ id: "i1", kind: "interval", intervalMs: 60_000, nextRun: iso(T0) }));

  const fired: string[] = [];
  const { scheduler } = makeScheduler(store, async (task) => {
    fired.push(task.id);
  });

  await scheduler.reload();
  const result = await scheduler.tick(T0);

  assert.deepEqual(result.fired, ["i1"]);
  assert.deepEqual(fired, ["i1"]);

  const persisted = store.getScheduledTask("i1");
  assert.ok(persisted);
  assert.equal(persisted.lastRun, iso(T0));
  assert.equal(persisted.nextRun, iso(plus(T0, 60_000)));
  assert.equal(persisted.enabled, true);
});

test("tick disables a once task after it fires", async () => {
  const store = new FakeStore();
  store.seed(makeTask({ id: "o1", kind: "once", runAt: iso(plus(T0, 30_000)) }));

  let calls = 0;
  const { scheduler } = makeScheduler(store, async () => {
    calls += 1;
  });

  await scheduler.reload();
  const at = plus(T0, 30_000);
  const first = await scheduler.tick(at);
  assert.deepEqual(first.fired, ["o1"]);

  const persisted = store.getScheduledTask("o1");
  assert.ok(persisted);
  assert.equal(persisted.enabled, false);
  assert.equal(persisted.nextRun, null);
  assert.equal(persisted.lastRun, iso(at));

  // Firing again changes nothing: the task is spent.
  const second = await scheduler.tick(plus(at, 60_000));
  assert.deepEqual(second.fired, []);
  assert.equal(calls, 1);
});

test("anti-catch-up (spec §36): a task 5 intervals overdue fires exactly ONCE", async () => {
  const store = new FakeStore();
  const intervalMs = 60_000;
  // nextRun is five whole intervals in the past — the classic "process was down" case.
  store.seed(
    makeTask({
      id: "late",
      kind: "interval",
      intervalMs,
      nextRun: iso(plus(T0, -5 * intervalMs)),
    }),
  );

  const fired: string[] = [];
  const { scheduler } = makeScheduler(store, async (task) => {
    fired.push(task.id);
  });

  await scheduler.reload();
  const first = await scheduler.tick(T0);
  assert.deepEqual(first.fired, ["late"], "fires once, not five times");
  assert.equal(fired.length, 1);

  const persisted = store.getScheduledTask("late");
  assert.ok(persisted);
  assert.ok(
    Date.parse(persisted.nextRun as string) > T0.getTime(),
    "nextRun must be scheduled forward from now, not left in the past",
  );
  assert.equal(persisted.nextRun, iso(plus(T0, intervalMs)));

  // A second tick at the same instant must not replay it.
  const second = await scheduler.tick(T0);
  assert.deepEqual(second.fired, []);
  assert.equal(fired.length, 1);
});

test("a failing onFire does not throw out of tick, does not block other tasks, increments failureCount", async () => {
  const store = new FakeStore();
  store.seed(makeTask({ id: "bad", kind: "interval", intervalMs: 60_000, nextRun: iso(T0) }));
  store.seed(makeTask({ id: "good", kind: "interval", intervalMs: 60_000, nextRun: iso(T0) }));

  const fired: string[] = [];
  const { scheduler } = makeScheduler(store, async (task) => {
    if (task.id === "bad") throw new Error("boom");
    fired.push(task.id);
  });

  await scheduler.reload();
  // Must resolve, not reject.
  const result = await scheduler.tick(T0);

  assert.deepEqual(result.fired, ["good"]);
  assert.deepEqual(fired, ["good"]);

  const bad = store.getScheduledTask("bad");
  assert.ok(bad);
  assert.equal(bad.failureCount, 1);
  assert.equal(bad.enabled, true, "still retryable below the failure limit");
  assert.ok(
    Date.parse(bad.nextRun as string) > T0.getTime(),
    "rescheduled forward so it cannot hot-loop",
  );

  const good = store.getScheduledTask("good");
  assert.ok(good);
  assert.equal(good.failureCount, 0);
});

test("a permanently failing task is quarantined at the bounded limit", async () => {
  const store = new FakeStore();
  store.seed(makeTask({ id: "doomed", kind: "interval", intervalMs: 1000, nextRun: iso(T0) }));

  const { scheduler } = makeScheduler(store, async () => {
    throw new Error("always");
  });
  await scheduler.reload();

  let at = T0;
  for (let i = 0; i < 5; i += 1) {
    await scheduler.tick(at);
    at = plus(at, 1000);
  }

  const task = store.getScheduledTask("doomed");
  assert.ok(task);
  assert.equal(task.failureCount, 3, "bounded by MAX_FAILURES");
  assert.equal(task.enabled, false);
  assert.equal(task.nextRun, null);
});

// ── reload ───────────────────────────────────────────────────────────────────

test("reload reports an invalid task and leaves it disabled in the store", async () => {
  const store = new FakeStore();
  store.seed(makeTask({ id: "valid", kind: "interval", intervalMs: 60_000 }));
  store.seed(makeTask({ id: "broken", kind: "interval", intervalMs: -1 }));

  const { scheduler } = makeScheduler(store, async () => {});
  const result = await scheduler.reload();

  assert.equal(result.loaded, 1);
  assert.deepEqual(result.invalid, ["broken"]);

  const broken = store.getScheduledTask("broken");
  assert.ok(broken, "invalid tasks are kept, not deleted");
  assert.equal(broken.enabled, false);
  assert.equal(broken.nextRun, null);

  const valid = store.getScheduledTask("valid");
  assert.ok(valid);
  assert.equal(valid.enabled, true);
  assert.equal(valid.nextRun, iso(plus(T0, 60_000)));

  // Safe to call again.
  const again = await scheduler.reload();
  assert.equal(again.loaded, 1);
  assert.deepEqual(again.invalid, ["broken"]);
});

// ── lifecycle ────────────────────────────────────────────────────────────────

test("stop clears the timer and makes tick a no-op; start is idempotent", async () => {
  const store = new FakeStore();
  store.seed(makeTask({ id: "t1", kind: "interval", intervalMs: 60_000, nextRun: iso(T0) }));

  const fired: string[] = [];
  const { scheduler } = makeScheduler(store, async (task) => {
    fired.push(task.id);
  });

  assert.equal(scheduler.isRunning(), false);
  scheduler.start();
  assert.equal(scheduler.isRunning(), true);
  scheduler.start(); // idempotent
  assert.equal(scheduler.isRunning(), true);

  scheduler.stop();
  assert.equal(scheduler.isRunning(), false);
  scheduler.stop(); // idempotent

  await scheduler.reload();
  const result = await scheduler.tick(T0);
  assert.deepEqual(result.fired, [], "tick after stop() does nothing");
  assert.equal(fired.length, 0);
});
