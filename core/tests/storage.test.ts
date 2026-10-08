// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Storage tests for the SQLite persistence layer.
 *
 * Run directly against the TypeScript sources (Node strips the types):
 *   node --test tests/storage.test.ts
 *
 * Every database is an explicit `:memory:` handle or a file inside a fresh
 * temporary directory — the real user database path is never opened.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  Approval,
  KaiEvent,
  KaiNotification,
  Memory,
  Mission,
  MissionStep,
  ScheduledTask,
} from "../src/shared/contracts.ts";
import { openSqliteStores, defaultDatabasePath } from "../src/storage/sqlite.ts";
import { SCHEMA_VERSION } from "../src/storage/schema.ts";

const TABLE_NAMES = [
  "settings",
  "agents",
  "agent_runs",
  "missions",
  "mission_steps",
  "events",
  "notifications",
  "memories",
  "scheduled_tasks",
  "approvals",
  "tasks",
  "work_items",
  "worker_profiles",
  "prompt_patterns",
  "skill_metrics",
  "activity_log",
];

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "kai-core-storage-"));
}

function cleanup(t: { after: (fn: () => void) => void }, dir: string): void {
  t.after(() => rmSync(dir, { recursive: true, force: true }));
}

// ── Fixture builders ──────────────────────────────────────────────────────────

function makeStep(over: Partial<MissionStep> = {}): MissionStep {
  return {
    id: "step-1",
    missionId: "m1",
    index: 0,
    title: "Do the thing",
    kind: "tool",
    status: "PENDING",
    sideEffecting: false,
    ...over,
  };
}

function makeMission(over: Partial<Mission> = {}): Mission {
  return {
    id: "m1",
    title: "Mission",
    status: "QUEUED",
    priority: 3,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    steps: [],
    ...over,
  };
}

function makeMemory(over: Partial<Memory> = {}): Memory {
  return {
    id: "mem-1",
    type: "user_preference",
    content: "prefers dark mode",
    source: "user_statement",
    importance: 4,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function makeNotification(over: Partial<KaiNotification> = {}): KaiNotification {
  return {
    id: "note-1",
    type: "mission.completed",
    title: "Done",
    priority: "NORMAL",
    createdAt: "2026-01-01T00:00:00.000Z",
    read: false,
    ...over,
  };
}

function makeApproval(over: Partial<Approval> = {}): Approval {
  return {
    id: "appr-1",
    toolId: "fs.write",
    action: "write file",
    reason: "needs a write",
    risk: "WRITE",
    createdAt: "2026-01-01T00:00:00.000Z",
    status: "PENDING",
    ...over,
  };
}

function makeTask(over: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "task-1",
    title: "Nightly",
    kind: "interval",
    intervalMs: 60_000,
    action: "nightly-job",
    enabled: true,
    failureCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function makeEvent(over: Partial<KaiEvent> = {}): KaiEvent {
  return {
    id: "evt-1",
    type: "mission.created",
    timestamp: "2026-01-01T00:00:00.000Z",
    source: "core",
    payload: { hello: "world" },
    ...over,
  };
}

// ── Memory ────────────────────────────────────────────────────────────────────

test("memory: create, read, update and delete", (t) => {
  const dir = tempDir();
  cleanup(t, dir);
  const stores = openSqliteStores({ path: join(dir, "kai.db") });

  const created = makeMemory({ metadata: { tags: ["a", "b"] } });
  stores.memory.createMemory(created);

  const read = stores.memory.getMemory("mem-1");
  assert.ok(read !== null);
  assert.equal(read.content, "prefers dark mode");
  assert.equal(read.importance, 4);
  assert.deepEqual(read.metadata, { tags: ["a", "b"] });

  stores.memory.updateMemory({ ...created, content: "prefers light mode", importance: 5, updatedAt: "2026-02-02T00:00:00.000Z" });
  const updated = stores.memory.getMemory("mem-1");
  assert.equal(updated?.content, "prefers light mode");
  assert.equal(updated?.importance, 5);
  assert.equal(updated?.updatedAt, "2026-02-02T00:00:00.000Z");

  stores.memory.deleteMemory("mem-1");
  assert.equal(stores.memory.getMemory("mem-1"), null);

  stores.memory.createMemory(makeMemory({ id: "mem-2", type: "note" }));
  stores.memory.createMemory(makeMemory({ id: "mem-3", type: "project_fact" }));
  const notes = stores.memory.listMemories({ type: "note" });
  assert.deepEqual(notes.map((m) => m.id), ["mem-2"]);
  assert.equal(stores.memory.listMemories().length, 2);
  assert.equal(stores.memory.listMemories({ limit: 1 }).length, 1);

  stores.close();
});

// ── Notifications ─────────────────────────────────────────────────────────────

test("notification: create, read, markRead and unread filter", (t) => {
  const dir = tempDir();
  cleanup(t, dir);
  const stores = openSqliteStores({ path: join(dir, "kai.db") });

  stores.notifications.createNotification(makeNotification({ id: "n1", read: false }));
  stores.notifications.createNotification(makeNotification({ id: "n2", read: false }));
  stores.notifications.createNotification(makeNotification({ id: "n3", read: true, priority: "HIGH" }));

  const got = stores.notifications.getNotification("n1");
  assert.equal(got?.read, false);
  assert.equal(typeof got?.read, "boolean");

  assert.equal(stores.notifications.listNotifications({ unreadOnly: true }).length, 2);
  assert.equal(stores.notifications.listNotifications().length, 3);

  stores.notifications.markRead("n1", true);
  assert.equal(stores.notifications.getNotification("n1")?.read, true);
  assert.equal(stores.notifications.listNotifications({ unreadOnly: true }).length, 1);

  // No throw for an unknown id.
  stores.notifications.markRead("does-not-exist", true);

  stores.close();
});

// ── Scheduled tasks ───────────────────────────────────────────────────────────

test("scheduled task: create, read, update and delete", (t) => {
  const dir = tempDir();
  cleanup(t, dir);
  const stores = openSqliteStores({ path: join(dir, "kai.db") });

  stores.scheduledTasks.upsertScheduledTask(makeTask({ id: "t1", enabled: true, payload: { a: 1 } }));
  stores.scheduledTasks.upsertScheduledTask(makeTask({ id: "t2", enabled: false }));

  const read = stores.scheduledTasks.getScheduledTask("t1");
  assert.equal(read?.kind, "interval");
  assert.equal(read?.intervalMs, 60_000);
  assert.equal(read?.enabled, true);
  assert.deepEqual(read?.payload, { a: 1 });

  stores.scheduledTasks.upsertScheduledTask(
    makeTask({ id: "t1", enabled: false, intervalMs: 120_000, failureCount: 2, lastRun: "2026-03-01T00:00:00.000Z" }),
  );
  const updated = stores.scheduledTasks.getScheduledTask("t1");
  assert.equal(updated?.enabled, false);
  assert.equal(updated?.intervalMs, 120_000);
  assert.equal(updated?.failureCount, 2);
  assert.equal(updated?.lastRun, "2026-03-01T00:00:00.000Z");

  assert.equal(stores.scheduledTasks.listScheduledTasks().length, 2);
  assert.equal(stores.scheduledTasks.listScheduledTasks({ enabledOnly: true }).length, 0);

  stores.scheduledTasks.deleteScheduledTask("t2");
  assert.equal(stores.scheduledTasks.getScheduledTask("t2"), null);
  assert.equal(stores.scheduledTasks.listScheduledTasks().length, 1);

  stores.close();
});

// ── Missions ──────────────────────────────────────────────────────────────────

test("mission: round-trips with three steps returned in index order", (t) => {
  const dir = tempDir();
  cleanup(t, dir);
  const stores = openSqliteStores({ path: join(dir, "kai.db") });

  // Inserted out of order on purpose: the read side must sort by index.
  const steps: MissionStep[] = [
    makeStep({
      id: "s2",
      index: 2,
      title: "final",
      kind: "manual",
      target: "user",
      input: { prompt: "confirm" },
      status: "PENDING",
      sideEffecting: true,
    }),
    makeStep({
      id: "s0",
      index: 0,
      title: "first",
      kind: "agent",
      target: "hermes",
      input: { text: "start" },
      output: { tokens: 10 },
      status: "COMPLETED",
      startedAt: "2026-01-01T00:00:01.000Z",
      completedAt: "2026-01-01T00:00:02.000Z",
      sideEffecting: false,
    }),
    makeStep({
      id: "s1",
      index: 1,
      title: "middle",
      kind: "tool",
      target: "shell",
      status: "FAILED",
      error: { code: "INTERNAL", message: "boom", retryable: false, at: "2026-01-01T00:00:03.000Z" },
      sideEffecting: false,
    }),
  ];

  stores.missions.upsertMission(
    makeMission({
      id: "m1",
      title: "Ship it",
      description: "multi-step",
      priority: 7,
      metadata: { tags: ["x"], nested: { deep: true } },
      steps,
    }),
  );

  const read = stores.missions.getMission("m1");
  assert.ok(read !== null);
  assert.equal(read.title, "Ship it");
  assert.equal(read.description, "multi-step");
  assert.equal(read.priority, 7);
  assert.deepEqual(read.metadata, { tags: ["x"], nested: { deep: true } });
  assert.equal(read.steps.length, 3);
  assert.deepEqual(read.steps.map((s) => s.index), [0, 1, 2]);
  assert.deepEqual(read.steps.map((s) => s.id), ["s0", "s1", "s2"]);

  const first = read.steps[0]!;
  assert.equal(first.missionId, "m1");
  assert.equal(first.kind, "agent");
  assert.equal(first.sideEffecting, false);
  assert.deepEqual(first.input, { text: "start" });
  assert.deepEqual(first.output, { tokens: 10 });
  assert.equal(first.startedAt, "2026-01-01T00:00:01.000Z");

  const failed = read.steps[1]!;
  assert.equal(failed.error?.code, "INTERNAL");
  assert.equal(failed.error?.retryable, false);
  assert.equal(read.steps[2]!.sideEffecting, true);

  stores.close();
});

test("mission: upsert replaces the step set instead of duplicating it", (t) => {
  const dir = tempDir();
  cleanup(t, dir);
  const stores = openSqliteStores({ path: join(dir, "kai.db") });

  stores.missions.upsertMission(
    makeMission({ id: "m1", steps: [makeStep({ id: "a", index: 0 }), makeStep({ id: "b", index: 1 })] }),
  );
  stores.missions.upsertMission(
    makeMission({
      id: "m1",
      status: "RUNNING",
      updatedAt: "2026-01-02T00:00:00.000Z",
      steps: [makeStep({ id: "c", index: 0, status: "RUNNING" })],
    }),
  );

  const read = stores.missions.getMission("m1");
  assert.equal(read?.status, "RUNNING");
  assert.equal(read?.steps.length, 1);
  assert.equal(read?.steps[0]?.id, "c");

  stores.close();
});

test("mission: list filters by status and delete removes the mission with its steps", (t) => {
  const dir = tempDir();
  cleanup(t, dir);
  const stores = openSqliteStores({ path: join(dir, "kai.db") });

  stores.missions.upsertMission(makeMission({ id: "m1", status: "QUEUED", steps: [makeStep()] }));
  stores.missions.upsertMission(makeMission({ id: "m2", status: "COMPLETED", createdAt: "2026-01-02T00:00:00.000Z" }));

  assert.equal(stores.missions.listMissions({ status: "QUEUED" }).length, 1);
  assert.equal(stores.missions.listMissions().length, 2);
  assert.equal(stores.missions.listMissions({ limit: 1 }).length, 1);

  stores.missions.deleteMission("m1");
  assert.equal(stores.missions.getMission("m1"), null);
  assert.equal(stores.missions.listMissions().length, 1);

  stores.close();
});

// ── Events ────────────────────────────────────────────────────────────────────

test("events: insert and filtered queries, newest first", (t) => {
  const dir = tempDir();
  cleanup(t, dir);
  const stores = openSqliteStores({ path: join(dir, "kai.db") });

  stores.events.insertEvent(
    makeEvent({ id: "e1", type: "mission.created", timestamp: "2026-01-01T00:00:01.000Z", missionId: "m1", payload: { n: 1 } }),
  );
  stores.events.insertEvent(
    makeEvent({ id: "e2", type: "mission.started", timestamp: "2026-01-01T00:00:02.000Z", missionId: "m1" }),
  );
  stores.events.insertEvent(
    makeEvent({ id: "e3", type: "agent.connected", timestamp: "2026-01-01T00:00:03.000Z", source: "hermes" }),
  );
  stores.events.insertEvent(
    makeEvent({ id: "e4", type: "mission.completed", timestamp: "2026-01-01T00:00:04.000Z", missionId: "m2" }),
  );

  const all = stores.events.listEvents();
  assert.equal(all.length, 4);
  assert.deepEqual(all.map((e) => e.id), ["e4", "e3", "e2", "e1"]);

  assert.deepEqual(stores.events.listEvents({ limit: 2 }).map((e) => e.id), ["e4", "e3"]);
  assert.deepEqual(stores.events.listEvents({ missionId: "m1" }).map((e) => e.id), ["e2", "e1"]);
  assert.deepEqual(
    stores.events.listEvents({ types: ["mission.created", "mission.completed"] }).map((e) => e.id),
    ["e4", "e1"],
  );
  assert.deepEqual(
    stores.events.listEvents({ since: "2026-01-01T00:00:03.000Z" }).map((e) => e.id),
    ["e4", "e3"],
  );
  assert.deepEqual(
    stores.events
      .listEvents({ missionId: "m1", types: ["mission.started"], since: "2026-01-01T00:00:00.000Z", limit: 1 })
      .map((e) => e.id),
    ["e2"],
  );
  // An empty type filter matches nothing rather than everything.
  assert.equal(stores.events.listEvents({ types: [] }).length, 0);

  const first = stores.events.listEvents({ limit: 1 })[0]!;
  assert.equal(first.source, "core");
  assert.deepEqual(first.payload, { hello: "world" });

  stores.close();
});

// ── Unfinished missions ───────────────────────────────────────────────────────

test("listUnfinishedMissions returns only QUEUED/RUNNING/WAITING/WAITING_APPROVAL", (t) => {
  const dir = tempDir();
  cleanup(t, dir);
  const stores = openSqliteStores({ path: join(dir, "kai.db") });

  const statuses = [
    "QUEUED",
    "RUNNING",
    "WAITING",
    "WAITING_APPROVAL",
    "COMPLETED",
    "CANCELLED",
    "FAILED",
  ] as const;

  let second = 0;
  for (const status of statuses) {
    stores.missions.upsertMission(
      makeMission({
        id: `m-${status}`,
        status,
        createdAt: `2026-01-01T00:00:${String(second++).padStart(2, "0")}.000Z`,
      }),
    );
  }

  const unfinished = stores.missions.listUnfinishedMissions();
  assert.deepEqual(
    unfinished.map((m) => m.status).sort(),
    ["QUEUED", "RUNNING", "WAITING", "WAITING_APPROVAL"],
  );
  assert.equal(unfinished.length, 4);
  for (const mission of unfinished) {
    assert.ok(!["COMPLETED", "CANCELLED", "FAILED"].includes(mission.status));
  }

  stores.close();
});

// ── Booleans and JSON ─────────────────────────────────────────────────────────

test("booleans and JSON survive a round-trip byte-equal", (t) => {
  const dir = tempDir();
  cleanup(t, dir);
  const stores = openSqliteStores({ path: join(dir, "kai.db") });

  const metadata = { b: true, n: null, arr: [1, "two", { three: 3 }], s: "héllo ✓" };
  stores.missions.upsertMission(
    makeMission({
      id: "m1",
      metadata,
      steps: [makeStep({ id: "s0", index: 0, sideEffecting: true, input: { q: [1, 2, 3] } })],
    }),
  );

  const mission = stores.missions.getMission("m1")!;
  assert.equal(JSON.stringify(mission.metadata), JSON.stringify(metadata));
  assert.equal(mission.steps[0]!.sideEffecting, true);
  assert.equal(typeof mission.steps[0]!.sideEffecting, "boolean");
  assert.equal(JSON.stringify(mission.steps[0]!.input), JSON.stringify({ q: [1, 2, 3] }));

  const event = makeEvent({ id: "e1", payload: { nested: { deep: [true, false, null] } } });
  stores.events.insertEvent(event);
  assert.equal(JSON.stringify(stores.events.listEvents()[0]!.payload), JSON.stringify(event.payload));

  const note = makeNotification({ id: "n1", read: true, metadata: { k: "v" } });
  stores.notifications.createNotification(note);
  const readNote = stores.notifications.getNotification("n1")!;
  assert.equal(readNote.read, true);
  assert.equal(typeof readNote.read, "boolean");
  assert.equal(JSON.stringify(readNote.metadata), JSON.stringify(note.metadata));

  stores.close();
});

// ── Approvals ─────────────────────────────────────────────────────────────────

test("approval: create, list by status and decide", (t) => {
  const dir = tempDir();
  cleanup(t, dir);
  const stores = openSqliteStores({ path: join(dir, "kai.db") });

  stores.approvals.createApproval(makeApproval({ id: "a1", missionId: "m1", stepId: "s1", risk: "DESTRUCTIVE" }));
  stores.approvals.createApproval(makeApproval({ id: "a2", createdAt: "2026-01-02T00:00:00.000Z" }));

  const read = stores.approvals.getApproval("a1")!;
  assert.equal(read.risk, "DESTRUCTIVE");
  assert.equal(read.status, "PENDING");
  assert.equal(read.missionId, "m1");
  assert.equal(read.stepId, "s1");

  stores.approvals.decideApproval("a1", "APPROVED", "2026-01-03T00:00:00.000Z");
  const decided = stores.approvals.getApproval("a1")!;
  assert.equal(decided.status, "APPROVED");
  assert.equal(decided.decidedAt, "2026-01-03T00:00:00.000Z");

  assert.equal(stores.approvals.listApprovals({ status: "PENDING" }).length, 1);
  assert.equal(stores.approvals.listApprovals().length, 2);

  // No throw for an unknown id.
  stores.approvals.decideApproval("missing", "REJECTED", "2026-01-03T00:00:00.000Z");

  stores.close();
});

// ── No-op semantics ───────────────────────────────────────────────────────────

test("mutations on a missing id are no-ops, not throws", (t) => {
  const dir = tempDir();
  cleanup(t, dir);
  const stores = openSqliteStores({ path: join(dir, "kai.db") });

  assert.doesNotThrow(() => {
    stores.notifications.markRead("nope", true);
    stores.approvals.decideApproval("nope", "REJECTED", "2026-01-01T00:00:00.000Z");
    stores.memory.deleteMemory("nope");
    stores.memory.updateMemory(makeMemory({ id: "nope", content: "x" }));
    stores.missions.deleteMission("nope");
    stores.scheduledTasks.deleteScheduledTask("nope");
  });

  assert.equal(stores.memory.getMemory("nope"), null);
  assert.equal(stores.missions.getMission("nope"), null);
  assert.equal(stores.notifications.getNotification("nope"), null);
  assert.equal(stores.approvals.getApproval("nope"), null);
  assert.equal(stores.scheduledTasks.getScheduledTask("nope"), null);

  stores.close();
});

// ── Persistence ───────────────────────────────────────────────────────────────

test("restart: a temp-file database keeps its data and does not re-run migrations", (t) => {
  const dir = tempDir();
  cleanup(t, dir);
  const path = join(dir, "nested", "kai.db");
  assert.ok(!existsSync(path), "parent directories should not exist yet");

  let stores = openSqliteStores({ path });
  assert.ok(existsSync(path), "openSqliteStores should create parent directories");

  stores.memory.createMemory(makeMemory({ id: "mem-1" }));
  stores.notifications.createNotification(makeNotification({ id: "note-1" }));
  stores.scheduledTasks.upsertScheduledTask(makeTask({ id: "task-1" }));
  stores.events.insertEvent(makeEvent({ id: "evt-1", missionId: "m1" }));
  stores.missions.upsertMission(
    makeMission({
      id: "m1",
      steps: [
        makeStep({ id: "s0", index: 0, status: "COMPLETED" }),
        makeStep({ id: "s1", index: 1, status: "PENDING" }),
      ],
    }),
  );
  stores.close();

  // Reopen the same file: everything must still be there.
  stores = openSqliteStores({ path });
  assert.equal(stores.memory.getMemory("mem-1")?.content, "prefers dark mode");
  assert.equal(stores.notifications.getNotification("note-1") !== null, true);
  assert.equal(stores.scheduledTasks.getScheduledTask("task-1")?.title, "Nightly");
  assert.equal(stores.events.listEvents().length, 1);
  const mission = stores.missions.getMission("m1")!;
  assert.equal(mission.steps.length, 2);
  assert.deepEqual(mission.steps.map((s) => s.id), ["s0", "s1"]);
  stores.close();

  // The schema version must be exactly the current one, and the table set
  // must not have been duplicated by the reopen.
  const raw = new DatabaseSync(path);
  const version = (raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  assert.equal(version, SCHEMA_VERSION);
  const tables = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[])
    .map((r) => r.name)
    .sort();
  assert.deepEqual(tables, [...TABLE_NAMES].sort());
  raw.close();

  // A third open is still a no-op.
  stores = openSqliteStores({ path });
  assert.equal(stores.missions.getMission("m1")?.steps.length, 2);
  stores.close();

  const rawAgain = new DatabaseSync(path);
  const versionAgain = (rawAgain.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  const tableCountAgain = (rawAgain.prepare("SELECT count(*) AS c FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get() as { c: number }).c;
  rawAgain.close();
  assert.equal(versionAgain, SCHEMA_VERSION);
  assert.equal(tableCountAgain, TABLE_NAMES.length);
});

test("open: twice on :memory: and once on a temp file does not throw", (t) => {
  const dir = tempDir();
  cleanup(t, dir);

  const a = openSqliteStores({ path: ":memory:" });
  const b = openSqliteStores({ path: ":memory:" });
  assert.notEqual(a, b);
  a.memory.createMemory(makeMemory({ id: "a" }));
  assert.equal(b.memory.getMemory("a"), null, "in-memory databases must be isolated");
  a.close();
  b.close();

  const file = openSqliteStores({ path: join(dir, "one.db") });
  file.memory.createMemory(makeMemory({ id: "f" }));
  assert.equal(file.memory.getMemory("f")?.id, "f");
  file.close();
});

test("close is safe to call twice", (t) => {
  const dir = tempDir();
  cleanup(t, dir);
  const stores = openSqliteStores({ path: join(dir, "kai.db") });
  stores.close();
  assert.doesNotThrow(() => stores.close());

  const mem = openSqliteStores({ path: ":memory:" });
  mem.close();
  assert.doesNotThrow(() => mem.close());
});

// ── defaultDatabasePath ───────────────────────────────────────────────────────

test("defaultDatabasePath honours KAI_CORE_DB and never points into the repository", (t) => {
  const dir = tempDir();
  cleanup(t, dir);

  const saved = {
    KAI_CORE_DB: process.env.KAI_CORE_DB,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  };
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  // Explicit override wins outright.
  const override = join(dir, "override.db");
  process.env.KAI_CORE_DB = override;
  assert.equal(defaultDatabasePath(), override);

  // Empty/whitespace override is ignored.
  process.env.KAI_CORE_DB = "   ";
  delete process.env.LOCALAPPDATA;
  delete process.env.XDG_DATA_HOME;
  const fallback = defaultDatabasePath();
  assert.ok(fallback.endsWith(join("KAI", "core", "kai-core.db")), fallback);
  assert.ok(!fallback.startsWith(process.cwd()), "the database must live outside the repo working tree");

  if (process.platform === "win32") {
    const local = join(dir, "LocalAppData");
    process.env.LOCALAPPDATA = local;
    assert.equal(defaultDatabasePath(), join(local, "KAI", "core", "kai-core.db"));
  } else {
    const xdg = join(dir, "xdg");
    process.env.XDG_DATA_HOME = xdg;
    assert.equal(defaultDatabasePath(), join(xdg, "KAI", "core", "kai-core.db"));
  }
});
