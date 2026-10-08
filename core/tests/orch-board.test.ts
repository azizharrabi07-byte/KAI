// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * KAI work board tests. Plain `node --test`, no network, no child processes.
 * Run from `core/`:  node --test tests/orch-board.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createWorkBoard, type WorkBoard } from "../src/orchestration/board.ts";
import type { WorkItemRecord, WorkItemStore } from "../src/shared/contracts.ts";
import type { WorkerHandoff } from "../src/orchestration/types.ts";
import { openSqliteStores } from "../src/storage/sqlite.ts";

// ── Fakes ─────────────────────────────────────────────────────────────────────

function clone<T>(value: T): T {
  return structuredClone(value);
}

function fakeWorkItemStore(): WorkItemStore {
  const rows = new Map<string, WorkItemRecord>();
  return {
    upsert(item: WorkItemRecord): void {
      rows.set(item.id, clone(item));
    },
    get(id: string): WorkItemRecord | null {
      const row = rows.get(id);
      return row === undefined ? null : clone(row);
    },
    list(filter: { state?: string; missionId?: string; taskId?: string; workerId?: string; limit?: number } = {}): WorkItemRecord[] {
      let out = [...rows.values()];
      if (filter.state !== undefined) out = out.filter((r) => r.state === filter.state);
      if (filter.missionId !== undefined) out = out.filter((r) => r.missionId === filter.missionId);
      if (filter.taskId !== undefined) out = out.filter((r) => r.taskId === filter.taskId);
      if (filter.workerId !== undefined) out = out.filter((r) => r.workerId === filter.workerId);
      return out.slice(0, filter.limit ?? 100).map(clone);
    },
    children(parentId: string): WorkItemRecord[] {
      return [...rows.values()].filter((r) => r.parentId === parentId).map(clone);
    },
  };
}

/** Deterministic clock: 2026-01-01T00:00:00Z + 1s per call. */
function fixedClock(): () => string {
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  let tick = 0;
  return () => new Date(base + tick++ * 1000).toISOString();
}

function eventsTap(): { events: { type: string; payload: unknown }[]; onEvent: (type: string, payload: unknown) => void } {
  const events: { type: string; payload: unknown }[] = [];
  return {
    events,
    onEvent: (type: string, payload: unknown): void => {
      events.push({ type, payload });
    },
  };
}

function setup(): { board: WorkBoard; events: { type: string; payload: unknown }[] } {
  const tap = eventsTap();
  const board = createWorkBoard(fakeWorkItemStore(), { now: fixedClock(), onEvent: tap.onEvent });
  return { board, events: tap.events };
}

function okHandoff(result = "did the thing"): WorkerHandoff {
  return {
    status: "ok",
    result,
    changedArtifacts: ["src/a.ts"],
    evidence: ["tests pass"],
    blockers: [],
    risks: [],
    followUps: [],
    toolsUsed: ["read"],
  };
}

function badHandoff(): WorkerHandoff {
  return { ...okHandoff("blocked upstream"), status: "blocked", blockers: ["waiting on API"] };
}

function must<T>(res: { ok: true; value: T } | { ok: false; reason: string }): T {
  assert.equal(res.ok, true, res.ok ? "" : `expected ok, got reason: ${res.reason}`);
  return (res as { ok: true; value: T }).value;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test("create initializes a READY item with id, counters, and timestamps", () => {
  const { board } = setup();
  const item = must(board.create({ objective: "Write the parser", skills: ["coding"], tools: ["read"] }));
  assert.match(item.id, /^work_[0-9a-z]+_\d+$/);
  assert.equal(item.state, "READY");
  assert.equal(item.attempts, 0);
  assert.deepEqual(item.heartbeats, []);
  assert.deepEqual(item.failures, []);
  assert.equal(item.retries, 0);
  assert.equal(item.objective, "Write the parser");
  assert.ok(Date.parse(item.createdAt) <= Date.parse(item.updatedAt));
});

test("full lifecycle: READY → CLAIMED → RUNNING → REVIEW → CHANGES_REQUESTED → COMPLETED", () => {
  const { board } = setup();
  const created = must(board.create({ objective: "Ship feature" }));
  const claimed = must(board.claim(created.id, "coder-1", "v3"));
  assert.equal(claimed.state, "CLAIMED");
  assert.equal(claimed.attempts, 1);
  assert.equal(claimed.workerId, "coder-1");
  assert.equal(claimed.workerVersion, "v3");

  const beaten = must(board.heartbeat(created.id, "step-1", "started"));
  assert.equal(beaten.state, "RUNNING");
  assert.equal(beaten.heartbeats.length, 1);
  assert.equal(beaten.heartbeats[0]?.step, "step-1");

  const inReview = must(board.review(created.id, "reviewer-7"));
  assert.equal(inReview.state, "REVIEW");

  const cr = must(board.changesRequested(created.id, ["missing tests"]));
  assert.equal(cr.state, "CHANGES_REQUESTED");
  assert.equal(cr.retries, 1);
  assert.equal(cr.review?.verdict, "CHANGES_REQUESTED");
  assert.deepEqual(cr.review?.findings, ["missing tests"]);

  // Re-claim after changes requested, then complete with an ok handoff.
  const reclaimed = must(board.claim(created.id, "coder-1", "v3"));
  assert.equal(reclaimed.attempts, 2);
  must(board.heartbeat(created.id, "fix", "added tests"));
  const done = must(board.complete(created.id, okHandoff()));
  assert.equal(done.state, "COMPLETED");
  assert.equal(done.handoff?.status, "ok");
  assert.equal(done.verification?.passed, true);
  assert.ok(done.verification?.at);
});

test("complete with a non-ok handoff lands FAILED with a failing verification", () => {
  const { board } = setup();
  const created = must(board.create({ objective: "Risky task" }));
  must(board.claim(created.id, "coder-2"));
  const done = must(board.complete(created.id, badHandoff()));
  assert.equal(done.state, "FAILED");
  assert.equal(done.verification?.passed, false);
});

test("wait and block park an item as WAITING / BLOCKED", () => {
  const { board } = setup();
  const a = must(board.create({ objective: "waiter" }));
  must(board.claim(a.id, "w-1"));
  assert.equal(must(board.wait(a.id, "need input")).state, "WAITING");
  assert.equal(must(board.block(a.id, "dependency down")).state, "BLOCKED");
  assert.equal(board.get(a.id)?.state, "BLOCKED");
});

test("fail appends the reason and lands FAILED; cancel lands CANCELLED", () => {
  const { board } = setup();
  const a = must(board.create({ objective: "fragile" }));
  must(board.claim(a.id, "w-9"));
  const failed = must(board.fail(a.id, "boom"));
  assert.equal(failed.state, "FAILED");
  assert.deepEqual(failed.failures, ["boom"]);

  const b = must(board.create({ objective: "scrapped" }));
  const cancelled = must(board.cancel(b.id));
  assert.equal(cancelled.state, "CANCELLED");
});

test("heartbeat caps at 50 entries and tracks latencyMs", () => {
  const { board } = setup();
  const created = must(board.create({ objective: "chatty worker" }));
  must(board.claim(created.id, "w-1"));
  for (let i = 0; i < 60; i++) must(board.heartbeat(created.id, `s${i}`));
  const item = board.get(created.id);
  assert.equal(item?.heartbeats.length, 50);
  assert.equal(item?.heartbeats[0]?.step, "s10");
  assert.equal(item?.heartbeats[49]?.step, "s59");
  assert.ok((item?.latencyMs ?? -1) >= 0);
});

test("children lists direct children and depthOf walks parents", () => {
  const { board } = setup();
  const root = must(board.create({ objective: "root" }));
  assert.equal(board.depthOf(root.id), 0);
  const c1 = must(board.createChild(root.id, { objective: "child-1" }));
  const c2 = must(board.createChild(root.id, { objective: "child-2" }));
  const grand = must(board.createChild(c1.id, { objective: "grand" }));
  assert.equal(board.children(root.id).length, 2);
  assert.equal(board.children(c1.id).length, 1);
  assert.equal(board.depthOf(c1.id), 1);
  assert.equal(board.depthOf(grand.id), 2);
  assert.equal(board.depthOf(c2.id), 1);
  assert.equal(board.depthOf("work_missing_0"), -1);
});

test("createChild refuses beyond maxDepth", () => {
  const { board } = setup();
  const root = must(board.create({ objective: "root" }));
  const child = must(board.createChild(root.id, { objective: "child" }, { maxDepth: 1 }));
  assert.equal(child.parentId, root.id);
  const refused = board.createChild(child.id, { objective: "too-deep" }, { maxDepth: 1 });
  assert.equal(refused.ok, false);
  assert.match((refused as { ok: false; reason: string }).reason, /maxDepth/);
});

test("createChild refuses beyond maxChildren and on unknown parents", () => {
  const { board } = setup();
  const root = must(board.create({ objective: "root" }));
  must(board.createChild(root.id, { objective: "one" }, { maxChildren: 1 }));
  const refused = board.createChild(root.id, { objective: "two" }, { maxChildren: 1 });
  assert.equal(refused.ok, false);
  assert.match((refused as { ok: false; reason: string }).reason, /maxChildren/);
  const unknownParent = board.createChild("work_missing_0", { objective: "orphan" }, {});
  assert.equal(unknownParent.ok, false);
});

test("checkRetry allows within budget and refuses beyond it", () => {
  const { board } = setup();
  const item = must(board.create({ objective: "flaky" }));
  must(board.claim(item.id, "w-1"));
  must(board.review(item.id, "r-1"));
  must(board.changesRequested(item.id, ["fix it"]));
  const allowed = must(board.checkRetry(item.id, 2));
  assert.equal(allowed.retries, 1);
  assert.equal(allowed.remaining, 1);
  must(board.review(item.id, "r-1"));
  must(board.changesRequested(item.id, ["again"]));
  const refused = board.checkRetry(item.id, 2);
  assert.equal(refused.ok, false);
  assert.match((refused as { ok: false; reason: string }).reason, /retry budget/);
  assert.equal(board.checkRetry("work_missing_0", 2).ok, false);
});

test("circuit breaker trips at 3 consecutive failures and resets on success", () => {
  const { board } = setup();
  const mk = (): string => must(board.create({ objective: "work" })).id;
  const first = must(board.recordFailure(mk(), "e1", "coder-1", "coding"));
  assert.equal(first.consecutiveFailures, 1);
  assert.equal(first.recommendation, null);
  const second = must(board.recordFailure(mk(), "e2", "coder-1", "coding"));
  assert.equal(second.consecutiveFailures, 2);
  assert.equal(second.recommendation, null);
  const third = must(board.recordFailure(mk(), "e3", "coder-1", "coding"));
  assert.equal(third.consecutiveFailures, 3);
  assert.ok(third.recommendation !== null);
  assert.ok(["reassign", "change-strategy", "ask", "block"].includes(third.recommendation?.action ?? ""));
  assert.equal(third.item.state, "FAILED");
  assert.deepEqual(third.item.failures, ["e3"]);

  // Failures for another worker/taskType do not share the count.
  const other = must(board.recordFailure(mk(), "e1", "coder-2", "coding"));
  assert.equal(other.consecutiveFailures, 1);
  assert.equal(other.recommendation, null);

  // Success resets the streak: the next failure starts back at 1.
  must(board.recordSuccess("coder-1", "coding"));
  const afterReset = must(board.recordFailure(mk(), "e4", "coder-1", "coding"));
  assert.equal(afterReset.consecutiveFailures, 1);
  assert.equal(afterReset.recommendation, null);
});

test("persistence round-trip via openSqliteStores({ path: ':memory:' })", () => {
  const stores = openSqliteStores({ path: ":memory:" });
  try {
    const board = createWorkBoard(stores.workItems, { now: fixedClock() });
    const created = must(board.create({ objective: "durable work", missionId: "m-1" }));
    must(board.claim(created.id, "coder-1"));
    must(board.heartbeat(created.id, "step-1"));

    // A fresh board over the same store sees the same rows: nothing lives
    // only in memory.
    const reopened = createWorkBoard(stores.workItems, { now: fixedClock() });
    const loaded = reopened.get(created.id);
    assert.ok(loaded !== null);
    assert.equal(loaded?.state, "RUNNING");
    assert.equal(loaded?.workerId, "coder-1");
    assert.equal(loaded?.attempts, 1);
    assert.equal(loaded?.heartbeats.length, 1);
    assert.equal(reopened.children(created.id).length, 0);
    const child = must(reopened.createChild(created.id, { objective: "kid" }));
    assert.equal(createWorkBoard(stores.workItems).children(created.id).length, 1);
    assert.equal(child.parentId, created.id);
  } finally {
    stores.close();
  }
});

test("lifecycle transitions emit worker.* events", () => {
  const tap = eventsTap();
  const board = createWorkBoard(fakeWorkItemStore(), { now: fixedClock(), onEvent: tap.onEvent });
  const created = must(board.create({ objective: "observed" }));
  must(board.claim(created.id, "w-1"));
  must(board.heartbeat(created.id, "s"));
  must(board.progress(created.id, "halfway"));
  must(board.wait(created.id, "paused"));
  must(board.block(created.id, "stuck"));
  must(board.review(created.id, "r-1"));
  must(board.complete(created.id, okHandoff()));
  const types = tap.events.map((e) => e.type);
  for (const expected of ["worker.started", "worker.heartbeat", "worker.progress", "worker.waiting", "worker.review", "worker.completed"]) {
    assert.ok(types.includes(expected), `missing event ${expected} in [${types.join(", ")}]`);
  }
  const failedTap = eventsTap();
  const failedBoard = createWorkBoard(fakeWorkItemStore(), { now: fixedClock(), onEvent: failedTap.onEvent });
  const item = must(failedBoard.create({ objective: "doomed" }));
  must(failedBoard.fail(item.id, "nope"));
  const cancelled = must(failedBoard.create({ objective: "scrapped" }));
  must(failedBoard.cancel(cancelled.id));
  const failedTypes = failedTap.events.map((e) => e.type);
  assert.ok(failedTypes.includes("worker.failed"));
  assert.ok(failedTypes.includes("worker.cancelled"));
});

test("every mutator no-ops with { ok: false } on unknown ids and never throws", () => {
  const { board } = setup();
  const missing = "work_missing_0";
  assert.equal(board.claim(missing, "w").ok, false);
  assert.equal(board.heartbeat(missing).ok, false);
  assert.equal(board.progress(missing, "x").ok, false);
  assert.equal(board.wait(missing, "why").ok, false);
  assert.equal(board.block(missing, "why").ok, false);
  assert.equal(board.complete(missing, okHandoff()).ok, false);
  assert.equal(board.fail(missing, "why").ok, false);
  assert.equal(board.cancel(missing).ok, false);
  assert.equal(board.review(missing, "r").ok, false);
  assert.equal(board.changesRequested(missing, ["f"]).ok, false);
  assert.equal(board.createChild(missing, { objective: "x" }).ok, false);
  assert.equal(board.checkRetry(missing, 3).ok, false);
  assert.equal(board.recordFailure(missing, "why").ok, false);
  assert.equal(board.get(missing), null);
});
