// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Phase 2 Part E — the scheduler's duplicate-execution hole.
 *
 * A scheduled occurrence must have a DURABLE EXECUTION IDENTITY, so that one
 * schedule occurrence can never start two missions. Before this fix a scheduled
 * `mission.create` job was registered `sideEffecting: false`, so recovery
 * treated a missed or interrupted occurrence as safe to replay and could start
 * a SECOND mission for the same slot.
 *
 * These tests use REAL SQLite stores and a REAL durable lease ledger: the crash
 * test claims the occurrence through the same boundary the scheduler uses,
 * performs the side effect, and then "dies" — the restart must observe one
 * execution, not two.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ScheduledTask } from "../src/shared/contracts.ts";
import { openSqliteStores } from "../src/storage/sqlite.ts";
import {
  createScheduler,
  missedSlotOutcome,
  MISSED_SLOT_CATCHUP,
} from "../src/scheduler/scheduler.ts";
import { createScheduledJobRunner, type ScheduledJob } from "../src/scheduler/jobs.ts";
import { createDurableLeaseStore, leaseKey, occurrenceId } from "../src/scheduler/lease.ts";
import { withScheduleExtensions } from "../src/scheduler/schedule.ts";

const T0 = new Date(2026, 0, 15, 8, 0, 0, 0); // Thu 2026-01-15 08:00 local
const iso = (d: Date): string => d.toISOString();
const plus = (d: Date, ms: number): Date => new Date(d.getTime() + ms);

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "kai-dedup-"));
}

function makeTask(over: Partial<ScheduledTask> & Pick<ScheduledTask, "id" | "kind">): ScheduledTask {
  const base: Omit<ScheduledTask, "id" | "kind"> = {
    title: over.id,
    action: "mission.create",
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

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("waitFor timed out");
}

// ── (a) crash/restart at the EXACT claim boundary ────────────────────────────

test("crash at the claim boundary: a mission-creating occurrence executes exactly once, never twice", async () => {
  const dir = tempDir();
  const dbPath = join(dir, "core.db");
  const leasePath = join(dir, "leases.db");
  const countPath = join(dir, "missions.log");
  const slot = iso(T0);
  const occurrence = occurrenceId("sched-1", slot);
  assert.equal(occurrence, `sched-1@${slot}`);

  const stores = openSqliteStores({ path: dbPath });
  stores.scheduledTasks.upsertScheduledTask(
    makeTask({ id: "sched-1", kind: "interval", intervalMs: 3_600_000, nextRun: slot }),
  );

  // Process A: claims the occurrence through the real ledger, performs the
  // side effect (the mission is created), then DIES mid-run — onFire never
  // settles, so `finish` is never written and the lease stays RUNNING.
  const leaseA = createDurableLeaseStore({
    path: leasePath,
    now: () => T0,
    ttlMs: 1_000,
    ownerId: "process-A",
  });
  const a = createScheduler({
    store: stores.scheduledTasks,
    lease: leaseA,
    describe: () => ({ sideEffecting: true }),
    onFire: async () => {
      appendFileSync(countPath, "mission\n");
      await new Promise<void>(() => {}); // crash: never resolves, never finishes
    },
    now: () => T0,
    tickMs: 1_000,
    ownerId: "process-A",
  });
  await a.reload();
  void a.tick(T0); // deliberately not awaited: the process "dies" mid-run
  await waitFor(() => countLines(countPath) === 1, 3_000);
  assert.equal(countLines(countPath), 1, "A created exactly one mission before it died");

  const claimInA = leaseA.peek(occurrence);
  assert.equal(claimInA?.state, "RUNNING");
  assert.equal(claimInA?.sideEffecting, true, "the occurrence is recorded as side-effecting");

  // Process A dies. Its lease handle closes with the occurrence still RUNNING.
  leaseA.close();

  // Process B restarts over the same files, well past the lease TTL. The sweep
  // classifies the dead run INTERRUPTED; the tick must NOT replay it.
  const clockB = plus(T0, 5_000);
  const leaseB = createDurableLeaseStore({
    path: leasePath,
    now: () => clockB,
    ttlMs: 1_000,
    ownerId: "process-B",
  });
  const b = createScheduler({
    store: stores.scheduledTasks,
    lease: leaseB,
    describe: () => ({ sideEffecting: true }),
    onFire: async () => {
      appendFileSync(countPath, "mission\n");
    },
    now: () => clockB,
    tickMs: 1_000,
    ownerId: "process-B",
  });
  await b.reload();
  assert.equal(b.stateOf("sched-1"), "INTERRUPTED", "the dead run is visible as interrupted");

  const result = await b.tick(clockB);

  assert.equal(
    countLines(countPath),
    1,
    "the mission-execution side effect happened exactly once, not twice",
  );
  assert.equal(result.fired.length, 0, "B did not re-run the crashed occurrence");
  assert.ok(result.interrupted.includes("sched-1"));
  assert.ok(result.missed.includes("sched-1"), "the interrupted occurrence is settled as missed");
  assert.equal(
    b.stateOf("sched-1"),
    "INTERRUPTED",
    "the visible state records that a dead process left the slot",
  );

  const row = leaseB.peek(occurrence);
  assert.equal(row?.occurrenceId, occurrence, "the ledger carries the durable occurrence id");
  assert.equal(row?.state, "MISSED", "the interrupted occurrence is settled, never replayed");

  leaseB.close();
  stores.close();
});

test("the hazard the fix closes: a mis-classified (non-side-effecting) occurrence WOULD replay and double", async () => {
  // This is the counter-example that justifies `sideEffecting: true` for a
  // mission-creating job. With the old classification, an interrupted slot is
  // treated as safe to repeat, and the restart creates a SECOND mission.
  const dir = tempDir();
  const dbPath = join(dir, "core.db");
  const leasePath = join(dir, "leases.db");
  const countPath = join(dir, "missions.log");
  const slot = iso(T0);

  const stores = openSqliteStores({ path: dbPath });
  stores.scheduledTasks.upsertScheduledTask(
    makeTask({ id: "misclassified", kind: "interval", intervalMs: 3_600_000, nextRun: slot }),
  );

  const leaseA = createDurableLeaseStore({ path: leasePath, now: () => T0, ttlMs: 1_000, ownerId: "A" });
  const a = createScheduler({
    store: stores.scheduledTasks,
    lease: leaseA,
    describe: () => ({ sideEffecting: false }),
    onFire: async () => {
      appendFileSync(countPath, "mission\n");
      await new Promise<void>(() => {});
    },
    now: () => T0,
    tickMs: 1_000,
    ownerId: "A",
  });
  await a.reload();
  void a.tick(T0);
  await waitFor(() => countLines(countPath) === 1, 3_000);
  leaseA.close();

  const clockB = plus(T0, 5_000);
  const leaseB = createDurableLeaseStore({ path: leasePath, now: () => clockB, ttlMs: 1_000, ownerId: "B" });
  const b = createScheduler({
    store: stores.scheduledTasks,
    lease: leaseB,
    describe: () => ({ sideEffecting: false }),
    onFire: async () => {
      appendFileSync(countPath, "mission\n");
    },
    now: () => clockB,
    tickMs: 1_000,
    ownerId: "B",
  });
  await b.reload();
  const result = await b.tick(clockB);

  assert.equal(result.fired.includes("misclassified"), true);
  assert.equal(
    countLines(countPath),
    2,
    "with sideEffecting:false the occurrence is replayed — this is the duplicate the fix removes",
  );

  leaseB.close();
  stores.close();
});

// ── (b) a missed side-effecting occurrence PARKS ─────────────────────────────

test("a missed side-effecting occurrence PARKS instead of silently re-running", async () => {
  const dir = tempDir();
  const stores = openSqliteStores({ path: join(dir, "core.db") });
  const overdue = plus(T0, -900_000);
  const task = withScheduleExtensions(
    makeTask({
      id: "mission-job",
      kind: "interval",
      intervalMs: 300_000,
      nextRun: iso(overdue),
    }),
    { missed: "run-now" },
  );
  stores.scheduledTasks.upsertScheduledTask(task);

  const lease = createDurableLeaseStore({ path: join(dir, "lease.db"), now: () => T0, ttlMs: 60_000 });
  let executions = 0;
  const scheduler = createScheduler({
    store: stores.scheduledTasks,
    lease,
    describe: () => ({ sideEffecting: true }),
    onFire: async () => {
      executions += 1;
    },
    now: () => T0,
    tickMs: 1_000,
  });
  await scheduler.reload();
  const result = await scheduler.tick(T0);

  assert.equal(executions, 0, "a missed side-effecting occurrence must not run unattended");
  assert.ok(result.parked.includes("mission-job"), "it is parked, awaiting an answer");
  assert.equal(result.alreadyExecuted.includes("mission-job"), false);
  assert.equal(scheduler.stateOf("mission-job"), "WAITING_APPROVAL");

  const row = lease.peek(occurrenceId("mission-job", iso(overdue)));
  assert.equal(row?.state, "PAUSED", "the parked occurrence is durably recorded as PAUSED");

  lease.close();
  stores.close();
});

// ── (c) the same occurrence claimed twice → one execution ────────────────────

test("the same occurrence claimed twice runs once; the second attempt reports already-executed", async () => {
  const dir = tempDir();
  const dbPath = join(dir, "core.db");
  const countPath = join(dir, "missions.log");
  const slot = iso(T0);

  const stores = openSqliteStores({ path: dbPath });
  stores.scheduledTasks.upsertScheduledTask(
    makeTask({ id: "once-only", kind: "interval", intervalMs: 3_600_000, nextRun: slot }),
  );

  const lease = createDurableLeaseStore({
    path: join(dir, "lease.db"),
    now: () => T0,
    ttlMs: 60_000,
    ownerId: "shared",
  });
  const onFire = async (): Promise<void> => {
    appendFileSync(countPath, "mission\n");
  };

  const a = createScheduler({
    store: stores.scheduledTasks,
    lease,
    describe: () => ({ sideEffecting: true }),
    onFire,
    now: () => T0,
    tickMs: 1_000,
    ownerId: "sched-a",
  });
  const b = createScheduler({
    store: stores.scheduledTasks,
    lease,
    describe: () => ({ sideEffecting: true }),
    onFire,
    now: () => T0,
    tickMs: 1_000,
    ownerId: "sched-b",
  });

  // Both load the same due occurrence BEFORE either fires.
  await a.reload();
  await b.reload();

  const ra = await a.tick(T0);
  const rb = await b.tick(T0);

  assert.deepEqual(ra.fired, ["once-only"]);
  assert.equal(countLines(countPath), 1, "exactly one mission execution for the occurrence");
  assert.equal(rb.fired.length, 0, "the second claimer must not run the same occurrence");
  assert.ok(
    rb.alreadyExecuted.includes("once-only"),
    "the second attempt is reported as already-executed, not silently skipped",
  );
  assert.equal(b.stateOf("once-only"), "ALREADY_EXECUTED");

  lease.close();
  stores.close();
});

// ── (d) a DIFFERENT occurrence still runs ────────────────────────────────────

test("a different occurrence still runs: dedup is per-slot identity, not a global kill switch", async () => {
  const dir = tempDir();
  const stores = openSqliteStores({ path: join(dir, "core.db") });
  const countPath = join(dir, "missions.log");
  const intervalMs = 3_600_000;
  const slot1 = T0;
  const slot2 = plus(T0, intervalMs);
  stores.scheduledTasks.upsertScheduledTask(
    makeTask({ id: "recurring", kind: "interval", intervalMs, nextRun: iso(slot1) }),
  );

  const lease = createDurableLeaseStore({ path: join(dir, "lease.db"), now: () => T0, ttlMs: 60_000 });
  let clock = T0;
  const scheduler = createScheduler({
    store: stores.scheduledTasks,
    lease,
    describe: () => ({ sideEffecting: true }),
    onFire: async () => {
      appendFileSync(countPath, "mission\n");
    },
    now: () => clock,
    tickMs: 1_000,
  });
  await scheduler.reload();

  const first = await scheduler.tick(slot1);
  assert.deepEqual(first.fired, ["recurring"]);

  clock = slot2;
  const second = await scheduler.tick(slot2);
  assert.deepEqual(second.fired, ["recurring"], "the next occurrence is not suppressed");
  assert.equal(countLines(countPath), 2, "two distinct occurrences -> two executions");

  // The two slots are distinct durable identities.
  assert.notEqual(
    occurrenceId("recurring", iso(slot1)),
    occurrenceId("recurring", iso(slot2)),
  );
  assert.equal(lease.peek(occurrenceId("recurring", iso(slot1)))?.state, "DONE");
  assert.equal(lease.peek(occurrenceId("recurring", iso(slot2)))?.state, "DONE");

  lease.close();
  stores.close();
});

// ── durable identity + lease-level semantics ─────────────────────────────────

test("occurrenceId is stable and leaseKey is exactly the occurrence identity", () => {
  const slot = iso(T0);
  assert.equal(occurrenceId("daily-report", slot), `daily-report@${slot}`);
  assert.equal(leaseKey("daily-report", slot), occurrenceId("daily-report", slot));
  // Same inputs -> same id, so a restart derives the same identity.
  assert.equal(occurrenceId("daily-report", slot), occurrenceId("daily-report", slot));
});

test("lease: an expired side-effecting claim is classified INTERRUPTED, never reclaimed; a safe one is reclaimed", () => {
  const dir = tempDir();
  const now = { at: T0 };
  const slot = iso(T0);

  // (1) side-effecting: expired run is NOT reclaimed.
  {
    const store = createDurableLeaseStore({
      path: join(dir, "danger.db"),
      now: () => now.at,
      ttlMs: 1_000,
    });
    const first = store.claim({ taskId: "danger", slot, sideEffecting: true, ownerId: "A" });
    assert.equal(first.acquired, true);

    now.at = plus(T0, 2_000);
    const second = store.claim({ taskId: "danger", slot, sideEffecting: true, ownerId: "B" });
    assert.equal(second.acquired, false, "an expired side-effecting run is not reclaimed");
    assert.equal(second.state, "INTERRUPTED");
    assert.equal(store.peek(occurrenceId("danger", slot))?.state, "INTERRUPTED");

    // Even an explicit replay grant can revive INTERRUPTED, but the scheduler
    // never grants it for a side-effecting occurrence.
    const replayed = store.claim(
      { taskId: "danger", slot, sideEffecting: true, ownerId: "C" },
      { replayInterrupted: true },
    );
    assert.equal(replayed.acquired, true);
    store.close();
  }

  // (2) non-side-effecting: expired run IS reclaimed (safe to repeat).
  {
    now.at = T0;
    const store = createDurableLeaseStore({
      path: join(dir, "safe.db"),
      now: () => now.at,
      ttlMs: 1_000,
    });
    store.claim({ taskId: "safe", slot, sideEffecting: false, ownerId: "A" });
    now.at = plus(T0, 2_000);
    const second = store.claim({ taskId: "safe", slot, sideEffecting: false, ownerId: "B" });
    assert.equal(second.acquired, true);
    assert.equal(second.reclaimed, true);
    store.close();
  }
});

test("lease: an existing ledger is migrated — the occurrence identity is backfilled and old keys become canonical", () => {
  const dir = tempDir();
  const path = join(dir, "legacy-lease.db");
  const slot = "2026-01-15T08:00:00.000Z";
  const legacyKey = `legacy::${slot}`;

  // A ledger written by an earlier build: no occurrenceId column, old key shape.
  {
    const raw = new DatabaseSync(path);
    raw.exec(`
      CREATE TABLE run_leases (
        key           TEXT PRIMARY KEY,
        taskId        TEXT NOT NULL,
        slot          TEXT NOT NULL,
        ownerId       TEXT NOT NULL,
        state         TEXT NOT NULL,
        sideEffecting INTEGER NOT NULL DEFAULT 0,
        createdAt     TEXT NOT NULL,
        heartbeatAt   TEXT NOT NULL,
        expiresAt     TEXT NOT NULL,
        detail        TEXT
      );
    `);
    raw
      .prepare(
        `INSERT INTO run_leases
           (key, taskId, slot, ownerId, state, sideEffecting, createdAt, heartbeatAt, expiresAt, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(legacyKey, "legacy", slot, "old", "DONE", 1, iso(T0), iso(T0), iso(T0), null);
    raw.close();
  }

  // Opening the store migrates in place.
  const store = createDurableLeaseStore({ path, now: () => T0 });
  const row = store.peek(occurrenceId("legacy", slot));
  assert.ok(row, "the settled occurrence is found under its canonical identity");
  assert.equal(row?.occurrenceId, occurrenceId("legacy", slot));
  assert.equal(row?.state, "DONE");

  // A claim for that occurrence now sees it as settled: it can never re-fire.
  const claim = store.claim({ taskId: "legacy", slot, sideEffecting: true, ownerId: "new" });
  assert.equal(claim.acquired, false);
  assert.equal(claim.state, "DONE");
  store.close();
});

// ── explicit missed-slot semantics ───────────────────────────────────────────

test("missedSlotOutcome states the decision for every policy and danger combination", () => {
  assert.equal(missedSlotOutcome({ policy: "skip", sideEffecting: false }), "skip");
  assert.equal(missedSlotOutcome({ policy: "skip", sideEffecting: true }), "skip");
  assert.equal(missedSlotOutcome({ policy: "mark-missed", sideEffecting: false }), "mark-missed");
  assert.equal(missedSlotOutcome({ policy: "mark-missed", sideEffecting: true }), "mark-missed");
  assert.equal(missedSlotOutcome({ policy: "run-now", sideEffecting: false }), "run");
  assert.equal(missedSlotOutcome({ policy: "run-now", sideEffecting: true }), "park");
  assert.equal(
    missedSlotOutcome({ policy: "run-now", sideEffecting: true, allowDangerousMissedRun: true }),
    "run",
    "the escape hatch is the ONLY way a side-effecting missed run executes",
  );
});

test("MISSED_SLOT_CATCHUP documents every schedule kind (and none replays missed slots)", () => {
  for (const kind of ["once", "interval", "daily", "weekly", "cron"] as const) {
    const text = MISSED_SLOT_CATCHUP[kind];
    assert.equal(typeof text, "string");
    assert.ok(text.length > 0);
    assert.ok(/at most once|spent/.test(text), `${kind}: states the at-most-once rule`);
  }
});

// ── the job-runner classification the runtime must use ───────────────────────

test("a mission-creating job with the honest classification: risk stays READ, but a missed run parks", async () => {
  // The job descriptor mirrors what runtime.ts must register for `mission.create`.
  const jobs: ScheduledJob[] = [
    { action: "mission.create", toolId: "missions.create", risk: "READ", sideEffecting: true },
  ];
  let creations = 0;
  const boundary = {
    invoke: async (_id: string, _input: unknown) => {
      creations += 1;
      return { ok: true as const, result: { missionId: "m1" } };
    },
  };
  const runner = createScheduledJobRunner({ boundary, jobs });

  const described = runner.describe(makeTask({ id: "j", kind: "interval", intervalMs: 1_000 }));
  assert.equal(described.risk, "READ", "the tool's own risk is unchanged: READ");
  assert.equal(described.sideEffecting, true, "starting work twice is still a duplicate effect");

  // Normal (not missed) fire executes through the boundary.
  const fresh = await runner.run(makeTask({ id: "j", kind: "interval", intervalMs: 1_000 }));
  assert.equal(fresh.status, "completed");
  assert.equal(creations, 1);

  // A MISSED occurrence must park, not create a second mission.
  const missed = await runner.run(
    makeTask({ id: "j", kind: "interval", intervalMs: 1_000 }),
    { missed: true },
  );
  assert.equal(missed.status, "approval_required");
  assert.equal(creations, 1, "a missed occurrence did not create another mission");
});
