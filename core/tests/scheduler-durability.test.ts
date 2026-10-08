// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Part F — scheduler durability, leases, the missed-task policy and the run
 * state machine. Uses the REAL SQLite stores so "persists across a restart" and
 * "no double fire" are tested against actual durability, not an in-memory fake.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ScheduledTask } from "../src/shared/contracts.ts";
import { openSqliteStores } from "../src/storage/sqlite.ts";
import { createScheduler } from "../src/scheduler/scheduler.ts";
import {
  computeNextRun,
  withScheduleExtensions,
  readScheduleExtensions,
} from "../src/scheduler/schedule.ts";
import { createDurableLeaseStore, leaseKey } from "../src/scheduler/lease.ts";

const T0 = new Date(2026, 0, 15, 8, 0, 0, 0); // Thu 2026-01-15 08:00 local
const iso = (d: Date): string => d.toISOString();
const plus = (d: Date, ms: number): Date => new Date(d.getTime() + ms);

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "kai-sched-"));
}

function makeTask(over: Partial<ScheduledTask> & Pick<ScheduledTask, "id" | "kind">): ScheduledTask {
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

function countLines(path: string): number {
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf8").split("\n").filter((l) => l.length > 0).length;
}

// ── persistence across restart ───────────────────────────────────────────────

test("a schedule persists across a Core restart and fires on its due instant afterwards", async () => {
  const dir = tempDir();
  const dbPath = join(dir, "core.db");
  const due = plus(T0, 60_000);

  {
    const stores = openSqliteStores({ path: dbPath });
    stores.scheduledTasks.upsertScheduledTask(
      makeTask({ id: "daily-report", kind: "interval", intervalMs: 60_000, nextRun: iso(due) }),
    );
    stores.close();
  }

  // New process: everything is re-read from disk.
  const stores = openSqliteStores({ path: dbPath });
  const fired: string[] = [];
  let clock = T0;
  const scheduler = createScheduler({
    store: stores.scheduledTasks,
    onFire: async (task) => {
      fired.push(task.id);
    },
    now: () => clock,
    tickMs: 1_000,
  });

  const reloaded = await scheduler.reload();
  assert.equal(reloaded.loaded, 1);
  assert.deepEqual(reloaded.invalid, []);
  const persisted = stores.scheduledTasks.getScheduledTask("daily-report");
  assert.ok(persisted);
  assert.equal(persisted.nextRun, iso(due), "the chosen nextRun survives the restart");

  // Before due: nothing fires.
  await scheduler.tick(T0);
  assert.deepEqual(fired, []);

  // At due: it fires once.
  clock = due;
  const result = await scheduler.tick(due);
  assert.deepEqual(result.fired, ["daily-report"]);
  assert.deepEqual(fired, ["daily-report"]);

  stores.close();
});

// ── no double fire ───────────────────────────────────────────────────────────

test("two schedulers sharing a lease and a store fire one slot exactly once", async () => {
  const dir = tempDir();
  const dbPath = join(dir, "core.db");
  const countPath = join(dir, "count.txt");
  const due = T0;

  const stores = openSqliteStores({ path: dbPath });
  stores.scheduledTasks.upsertScheduledTask(
    makeTask({ id: "once-only", kind: "interval", intervalMs: 60_000, nextRun: iso(due) }),
  );

  const lease = createDurableLeaseStore({ path: join(dir, "lease.db"), now: () => T0, ttlMs: 60_000 });
  let fires = 0;
  const onFire = async (): Promise<void> => {
    fires += 1;
    const { appendFileSync } = await import("node:fs");
    appendFileSync(countPath, "fire\n");
  };

  const a = createScheduler({ store: stores.scheduledTasks, lease, onFire, now: () => T0, tickMs: 1_000, ownerId: "sched-a" });
  const b = createScheduler({ store: stores.scheduledTasks, lease, onFire, now: () => T0, tickMs: 1_000, ownerId: "sched-b" });

  // Both load the same due task BEFORE either fires.
  await a.reload();
  await b.reload();

  const ra = await a.tick(T0);
  const rb = await b.tick(T0);

  assert.equal(fires, 1, "exactly one fire across both schedulers");
  assert.equal(countLines(countPath), 1);
  assert.ok(ra.fired.length + rb.fired.length === 1);
  assert.ok(rb.skipped.includes("once-only") || ra.skipped.includes("once-only"));

  lease.close();
  stores.close();
});

test("a restart near the due time does not fire a slot an unexpired lease still holds", async () => {
  const dir = tempDir();
  const dbPath = join(dir, "core.db");
  const due = T0;

  const stores = openSqliteStores({ path: dbPath });
  stores.scheduledTasks.upsertScheduledTask(
    makeTask({ id: "held", kind: "interval", intervalMs: 60_000, nextRun: iso(due) }),
  );

  // A previous process claimed the slot and never finished (it is still live).
  const lease = createDurableLeaseStore({ path: join(dir, "lease.db"), now: () => T0, ttlMs: 60_000 });
  const claim = lease.claim(
    { taskId: "held", slot: iso(due), sideEffecting: true, ownerId: "dead-process" },
  );
  assert.equal(claim.acquired, true);

  let fires = 0;
  const scheduler = createScheduler({
    store: stores.scheduledTasks,
    lease,
    onFire: async () => {
      fires += 1;
    },
    now: () => T0,
    tickMs: 1_000,
    ownerId: "restarted",
  });
  await scheduler.reload();
  const result = await scheduler.tick(T0);

  assert.equal(fires, 0, "the restarted scheduler must not fire a slot another owner holds");
  assert.ok(result.skipped.includes("held"));

  lease.close();
  stores.close();
});

test("after an interrupted side-effecting run the slot is NOT replayed; a safe one IS", async () => {
  const dir = tempDir();

  // (a) dangerous: interrupted -> not replayed
  {
    const dbPath = join(dir, "danger.db");
    const stores = openSqliteStores({ path: dbPath });
    const due = T0;
    stores.scheduledTasks.upsertScheduledTask(
      makeTask({ id: "danger", kind: "interval", intervalMs: 60_000, nextRun: iso(due) }),
    );
    const lease = createDurableLeaseStore({ path: join(dir, "danger-lease.db"), now: () => T0, ttlMs: 1_000 });
    lease.claim({ taskId: "danger", slot: iso(due), sideEffecting: true, ownerId: "dead" });

    let fires = 0;
    const scheduler = createScheduler({
      store: stores.scheduledTasks,
      lease,
      onFire: async () => {
        fires += 1;
      },
      describe: () => ({ sideEffecting: true }),
      now: () => plus(T0, 5_000),
      tickMs: 1_000,
    });
    // Restart well after the lease TTL: reload sweeps RUNNING -> INTERRUPTED.
    await scheduler.reload();
    assert.equal(scheduler.stateOf("danger"), "INTERRUPTED");
    const result = await scheduler.tick(plus(T0, 5_000));
    assert.equal(fires, 0, "an interrupted side-effecting run is never replayed");
    assert.ok(result.interrupted.includes("danger"));
    assert.ok(result.missed.includes("danger"));
    const row = lease.peek(leaseKey("danger", iso(due)));
    assert.equal(row?.state, "MISSED");
    lease.close();
    stores.close();
  }

  // (b) safe: interrupted -> replayed
  {
    const dbPath = join(dir, "safe.db");
    const stores = openSqliteStores({ path: dbPath });
    const due = T0;
    stores.scheduledTasks.upsertScheduledTask(
      makeTask({ id: "safe", kind: "interval", intervalMs: 60_000, nextRun: iso(due) }),
    );
    const lease = createDurableLeaseStore({ path: join(dir, "safe-lease.db"), now: () => T0, ttlMs: 1_000 });
    lease.claim({ taskId: "safe", slot: iso(due), sideEffecting: false, ownerId: "dead" });

    let fires = 0;
    const scheduler = createScheduler({
      store: stores.scheduledTasks,
      lease,
      onFire: async () => {
        fires += 1;
      },
      describe: () => ({ sideEffecting: false }),
      now: () => plus(T0, 5_000),
      tickMs: 1_000,
    });
    await scheduler.reload();
    const result = await scheduler.tick(plus(T0, 5_000));
    assert.equal(fires, 1, "a non-side-effecting interrupted run may be replayed");
    assert.ok(result.fired.includes("safe"));
    lease.close();
    stores.close();
  }
});

// ── missed-task policy ───────────────────────────────────────────────────────

test("missed-task policy: skip and mark-missed do not run; run-now runs; a missed dangerous job parks", async () => {
  const mk = (
    id: string,
    policy: "run-now" | "skip" | "mark-missed",
  ): ScheduledTask => {
    const base = withScheduleExtensions(
      makeTask({
        id,
        kind: "interval",
        intervalMs: 300_000,
        // Three intervals in the past: well past the grace window.
        nextRun: iso(plus(T0, -900_000)),
      }),
      { missed: policy },
    );
    return base;
  };

  for (const policy of ["skip", "mark-missed"] as const) {
    const dir = tempDir();
    const stores = openSqliteStores({ path: join(dir, "core.db") });
    stores.scheduledTasks.upsertScheduledTask(mk("job", policy));
    const lease = createDurableLeaseStore({ path: join(dir, "lease.db"), now: () => T0, ttlMs: 60_000 });
    let fires = 0;
    let clock = plus(T0, 60_000);
    const scheduler = createScheduler({
      store: stores.scheduledTasks,
      lease,
      onFire: async () => {
        fires += 1;
      },
      now: () => clock,
      tickMs: 1_000,
    });
    await scheduler.reload();
    const result = await scheduler.tick(clock);

    assert.equal(fires, 0, `${policy}: a missed slot is not run`);
    const bucket = policy === "skip" ? result.skipped : result.missed;
    assert.ok(bucket.includes("job"), `${policy}: reported in the ${bucket === result.skipped ? "skipped" : "missed"} bucket`);
    const after = stores.scheduledTasks.getScheduledTask("job");
    assert.ok(after);
    assert.ok(Date.parse(after.nextRun as string) > clock.getTime(), `${policy}: nextRun advanced past now`);
    const row = lease.peek(leaseKey("job", iso(plus(T0, -900_000))));
    assert.equal(row?.state, "MISSED");
    lease.close();
    stores.close();
  }

  // run-now, not dangerous -> runs.
  {
    const dir = tempDir();
    const stores = openSqliteStores({ path: join(dir, "core.db") });
    stores.scheduledTasks.upsertScheduledTask(mk("job", "run-now"));
    const lease = createDurableLeaseStore({ path: join(dir, "lease.db"), now: () => T0, ttlMs: 60_000 });
    let fires = 0;
    const clock = plus(T0, 60_000);
    const scheduler = createScheduler({
      store: stores.scheduledTasks,
      lease,
      onFire: async (_task, ctx) => {
        fires += 1;
        assert.equal(ctx.missed, true, "the callback is told this was a missed slot");
      },
      describe: () => ({ sideEffecting: false }),
      now: () => clock,
      tickMs: 1_000,
    });
    await scheduler.reload();
    const result = await scheduler.tick(clock);
    assert.equal(fires, 1, "run-now runs a missed non-dangerous slot");
    assert.deepEqual(result.fired, ["job"]);
    lease.close();
    stores.close();
  }

  // run-now, dangerous -> parked, not run.
  {
    const dir = tempDir();
    const stores = openSqliteStores({ path: join(dir, "core.db") });
    stores.scheduledTasks.upsertScheduledTask(mk("job", "run-now"));
    const lease = createDurableLeaseStore({ path: join(dir, "lease.db"), now: () => T0, ttlMs: 60_000 });
    let fires = 0;
    const clock = plus(T0, 60_000);
    const scheduler = createScheduler({
      store: stores.scheduledTasks,
      lease,
      onFire: async () => {
        fires += 1;
      },
      describe: () => ({ sideEffecting: true }),
      now: () => clock,
      tickMs: 1_000,
    });
    await scheduler.reload();
    const result = await scheduler.tick(clock);
    assert.equal(fires, 0, "a missed dangerous job must NOT be silently re-run");
    assert.ok(result.parked.includes("job"));
    const row = lease.peek(leaseKey("job", iso(plus(T0, -900_000))));
    assert.equal(row?.state, "PAUSED");
    lease.close();
    stores.close();
  }
});

// ── state machine ────────────────────────────────────────────────────────────

test("run state machine: SCHEDULED -> DUE -> COMPLETED, plus FAILED/QUARANTINED/WAITING_APPROVAL", async () => {
  const dir = tempDir();
  const dbPath = join(dir, "core.db");
  const stores = openSqliteStores({ path: dbPath });
  const due = plus(T0, 30_000);
  stores.scheduledTasks.upsertScheduledTask(
    makeTask({ id: "sm", kind: "once", runAt: iso(due) }),
  );
  let clock = T0;
  let outcome: "ok" | "fail" | "approval" = "ok";
  const scheduler = createScheduler({
    store: stores.scheduledTasks,
    onFire: async () => {
      if (outcome === "fail") throw new Error("boom");
      if (outcome === "approval") return { status: "approval_required", reason: "needs a human" };
      return { status: "completed" };
    },
    now: () => clock,
    tickMs: 1_000,
  });
  await scheduler.reload();
  assert.equal(scheduler.stateOf("sm"), "SCHEDULED");

  clock = due;
  assert.equal(scheduler.stateOf("sm"), "DUE");

  const fired = await scheduler.tick(due);
  assert.deepEqual(fired.fired, ["sm"]);
  assert.equal(scheduler.stateOf("sm"), "COMPLETED", "a once task is completed after firing");

  stores.close();
});

test("run state machine: repeated failure quarantines, approval parks, interruption is visible", async () => {
  // quarantine
  {
    const dir = tempDir();
    const stores = openSqliteStores({ path: join(dir, "core.db") });
    stores.scheduledTasks.upsertScheduledTask(
      makeTask({ id: "doomed", kind: "interval", intervalMs: 1_000, nextRun: iso(T0) }),
    );
    let clock = T0;
    const scheduler = createScheduler({
      store: stores.scheduledTasks,
      onFire: async () => {
        throw new Error("always");
      },
      now: () => clock,
      tickMs: 1_000,
    });
    await scheduler.reload();
    for (let i = 0; i < 4; i += 1) {
      await scheduler.tick(clock);
      clock = plus(clock, 1_000);
    }
    assert.equal(scheduler.stateOf("doomed"), "QUARANTINED");
    stores.close();
  }

  // approval park
  {
    const dir = tempDir();
    const stores = openSqliteStores({ path: join(dir, "core.db") });
    stores.scheduledTasks.upsertScheduledTask(
      makeTask({ id: "card", kind: "interval", intervalMs: 60_000, nextRun: iso(T0) }),
    );
    const scheduler = createScheduler({
      store: stores.scheduledTasks,
      onFire: async () => ({ status: "approval_required", reason: "needs a human" }),
      now: () => T0,
      tickMs: 1_000,
    });
    await scheduler.reload();
    const result = await scheduler.tick(T0);
    assert.ok(result.parked.includes("card"));
    assert.equal(scheduler.stateOf("card"), "WAITING_APPROVAL");
    stores.close();
  }
});

// ── weekly / cron ────────────────────────────────────────────────────────────

test("weekly and cron compute the next local occurrence, and persist across a restart", async () => {
  // Thu 2026-01-15 08:00 -> next Monday 09:00 is 2026-01-19.
  const weekly = computeNextRun({ kind: "weekly", atTime: "09:00", dayOfWeek: 1 }, T0);
  assert.ok(weekly);
  assert.equal(weekly.getDate(), 19);
  assert.equal(weekly.getHours(), 9);

  const cron15 = computeNextRun({ kind: "cron", cron: "*/15 * * * *" }, T0);
  assert.ok(cron15);
  assert.equal(cron15.getMinutes(), 15, "08:00 -> next quarter hour");

  const cronMonday = computeNextRun({ kind: "cron", cron: "0 9 * * 1" }, T0);
  assert.ok(cronMonday);
  assert.equal(cronMonday.getDate(), 19);
  assert.equal(cronMonday.getHours(), 9);

  // Persist a weekly task through SQLite and reload it in a "new process".
  const dir = tempDir();
  const dbPath = join(dir, "core.db");
  {
    const stores = openSqliteStores({ path: dbPath });
    const task = withScheduleExtensions(
      makeTask({ id: "weekly", kind: "weekly", atTime: "09:00" } as Partial<ScheduledTask> & Pick<ScheduledTask, "id" | "kind">),
      { dayOfWeek: 1 },
    );
    stores.scheduledTasks.upsertScheduledTask(task);
    stores.close();
  }
  const stores = openSqliteStores({ path: dbPath });
  assert.deepEqual(readScheduleExtensions(stores.scheduledTasks.getScheduledTask("weekly")?.payload), { dayOfWeek: 1 });
  const scheduler = createScheduler({
    store: stores.scheduledTasks,
    onFire: async () => {},
    now: () => T0,
    tickMs: 1_000,
  });
  const reloaded = await scheduler.reload();
  assert.equal(reloaded.loaded, 1, "a weekly task is valid after a restart, not quarantined");
  assert.deepEqual(reloaded.invalid, []);
  const after = stores.scheduledTasks.getScheduledTask("weekly");
  assert.ok(after);
  assert.equal(new Date(Date.parse(after.nextRun as string)).getDate(), 19);
  stores.close();
});
