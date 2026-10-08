// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Activity trace tests. Run from `core/`:  node --test tests/orch-trace.test.ts
 *
 * Pins the trace filtering contract: OFF drops everything, COMPACT keeps only
 * the operator spine (+errors, details always visible), VERBOSE keeps All with
 * details, HIDDEN drops reasoning summaries, emit uses orchestration-owned
 * names only, and the store stays bounded via prune.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createTrace } from "../src/orchestration/trace.ts";
import type { ActivityKind, ReasoningMode, TraceLevel } from "../src/orchestration/types.ts";
import type { ActivityEventRecord, ActivityStore } from "../src/shared/contracts.ts";

function memoryStore(): ActivityStore & { events: ActivityEventRecord[] } {
  const events: ActivityEventRecord[] = [];
  let seq = 0;
  return {
    events,
    append(event) {
      seq += 1;
      events.push({ seq, ...event });
      return seq;
    },
    list(filter) {
      return events.filter(
        (e) =>
          (filter?.taskId === undefined || e.taskId === filter.taskId) &&
          (filter?.workItemId === undefined || e.workItemId === filter.workItemId),
      ).slice(-(filter?.limit ?? events.length));
    },
    prune(cap) {
      const excess = events.length - cap;
      if (excess <= 0) return 0;
      events.splice(0, excess);
      return excess;
    },
  };
}

const ORCHESTRATION_OWNED = new Set([
  "worker.started",
  "worker.heartbeat",
  "worker.progress",
  "worker.waiting",
  "worker.review",
  "worker.completed",
  "worker.failed",
  "worker.cancelled",
  "review.requested",
  "review.decided",
  "delegation.routed",
  "benchmark.updated",
]);

const ALL_KINDS: ActivityKind[] = [
  "plan", "tool", "worker", "review", "approval", "verify", "memory", "skill", "error", "done",
];

test("OFF drops everything: no store write, no emit, empty list", () => {
  const store = memoryStore();
  const emitted: Array<{ type: string; payload: unknown }> = [];
  const trace = createTrace({
    store,
    prefs: () => ({ activity: "OFF" as TraceLevel, reasoning: "SUMMARY" as ReasoningMode }),
    emit: (type, payload) => emitted.push({ type, payload }),
  });
  assert.equal(trace.record({ taskId: "t1" }, "done", "finished"), null);
  assert.equal(trace.reasoningSummary({ taskId: "t1" }, "plan", "thinking"), null);
  assert.equal(store.events.length, 0);
  assert.equal(emitted.length, 0);
  assert.deepEqual(trace.list({ taskId: "t1" }), []);
});

test("COMPACT records the spine plus errors, drops memory/skill", () => {
  const store = memoryStore();
  const trace = createTrace({
    store,
    prefs: () => ({ activity: "COMPACT", reasoning: "SUMMARY" }),
  });
  for (const kind of ALL_KINDS) {
    trace.record({ taskId: "t1" }, kind, `${kind} label`, `${kind} detail`);
  }
  const kinds = store.events.map((e) => e.kind).sort();
  assert.deepEqual(kinds, ["approval", "done", "error", "plan", "review", "tool", "verify", "worker"]);
});

test("VERBOSE records every kind with details", () => {
  const store = memoryStore();
  const trace = createTrace({
    store,
    prefs: () => ({ activity: "VERBOSE", reasoning: "SUMMARY" }),
  });
  for (const kind of ALL_KINDS) {
    trace.record({ taskId: "t1" }, kind, `${kind} label`, `${kind} detail`);
  }
  assert.equal(store.events.length, ALL_KINDS.length);
  const listed = trace.list({ taskId: "t1" });
  assert.equal(listed.length, ALL_KINDS.length);
  assert.ok(listed.every((e) => e.detail !== undefined), "VERBOSE shows detail payloads");
});

test("COMPACT list hides detail payloads but errors always stay visible with details", () => {
  const store = memoryStore();
  const trace = createTrace({
    store,
    prefs: () => ({ activity: "VERBOSE", reasoning: "SUMMARY" }),
  });
  trace.record({ taskId: "t1" }, "tool", "Searching files", "rg foo");
  trace.record({ taskId: "t1" }, "error", "Build failed", "exit code 1");
  const compact = trace.list({ taskId: "t1" }, "COMPACT");
  assert.equal(compact.length, 2);
  assert.equal(compact.find((e) => e.kind === "tool")?.detail, undefined);
  const err = compact.find((e) => e.kind === "error");
  assert.ok(err);
  assert.equal(err.detail, "exit code 1");
});

test("HIDDEN drops reasoning summaries; SUMMARY stores them as done events", () => {
  const hiddenStore = memoryStore();
  const hidden = createTrace({
    store: hiddenStore,
    prefs: () => ({ activity: "VERBOSE", reasoning: "HIDDEN" }),
  });
  assert.equal(hidden.reasoningSummary({ taskId: "t1" }, "plan", "considered X"), null);
  assert.equal(hiddenStore.events.length, 0);

  const shownStore = memoryStore();
  const shown = createTrace({
    store: shownStore,
    prefs: () => ({ activity: "VERBOSE", reasoning: "SUMMARY" }),
  });
  const event = shown.reasoningSummary({ taskId: "t1" }, "plan", "considered X");
  assert.ok(event);
  assert.equal(event.kind, "done");
  assert.equal(event.label, "Reasoning: plan");
  assert.equal(event.detail, "considered X");
});

test("emit uses orchestration-owned names only, never core event types", () => {
  const store = memoryStore();
  const emitted: string[] = [];
  const trace = createTrace({
    store,
    prefs: () => ({ activity: "VERBOSE", reasoning: "SUMMARY" }),
    emit: (type) => emitted.push(type),
  });
  trace.record({ taskId: "t1" }, "worker", "Coder-2 working");
  trace.record({ taskId: "t1" }, "review", "Reviewer checking");
  trace.record({ taskId: "t1" }, "approval", "Needs approval");
  assert.deepEqual(emitted, ["worker.progress", "worker.review", "review.requested"]);
  for (const type of emitted) {
    assert.ok(ORCHESTRATION_OWNED.has(type), `${type} must be orchestration-owned`);
  }
  assert.ok(!emitted.includes("approval.requested"), "must not fabricate core event types");
  assert.ok(!emitted.includes("memory.created"), "must not fabricate core event types");
});

test("store stays bounded: prune caps the log", () => {
  const store = memoryStore();
  const trace = createTrace({
    store,
    prefs: () => ({ activity: "VERBOSE", reasoning: "SUMMARY" }),
  });
  for (let i = 0; i < 50; i += 1) {
    trace.record({ taskId: "t1" }, "tool", `call ${i}`);
  }
  assert.equal(store.events.length, 50);
  const removed = store.prune(20);
  assert.equal(removed, 30);
  assert.equal(store.events.length, 20);
  assert.equal(store.list({ taskId: "t1" }).length, 20);
});
