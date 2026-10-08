// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Notification service tests. Plain `node --test`, no dependencies.
 * Run from `core/`:  node --test tests/notifications.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createEventBus } from "../src/events/bus.ts";
import { createNotificationService } from "../src/notifications/service.ts";
import type { KaiEvent, KaiNotification, NotificationStore } from "../src/shared/contracts.ts";

/** Hand-written fake — deliberately does NOT import core/src/storage. */
function fakeNotificationStore(): NotificationStore & { rows: KaiNotification[] } {
  const rows: KaiNotification[] = [];
  return {
    rows,
    createNotification(notification: KaiNotification): void {
      rows.push({ ...notification });
    },
    getNotification(id: string): KaiNotification | null {
      return rows.find((row) => row.id === id) ?? null;
    },
    listNotifications(opts?: { unreadOnly?: boolean; limit?: number }): KaiNotification[] {
      let out = rows.slice();
      if (opts?.unreadOnly) out = out.filter((row) => !row.read);
      if (opts?.limit !== undefined) out = out.slice(0, opts.limit);
      return out;
    },
    markRead(id: string, read: boolean): void {
      const row = rows.find((r) => r.id === id);
      if (row !== undefined) row.read = read;
    },
  };
}

const BASE_MS = Date.parse("2026-01-02T03:04:05.000Z");
function clock(): { now: () => Date; advance: (ms: number) => void } {
  let offset = 0;
  return {
    now: () => new Date(BASE_MS + offset),
    advance: (ms: number) => { offset += ms; },
  };
}

test("notify stores the notification and publishes notification.created on the bus", () => {
  const store = fakeNotificationStore();
  const bus = createEventBus();
  const seen: KaiEvent[] = [];
  bus.subscribe((event) => seen.push(event), { types: ["notification.created"] });

  const service = createNotificationService({ store, bus, now: clock().now, idFactory: () => "n1" });
  const created = service.notify({ type: "mission_failed", title: "Mission failed", message: "step 2" });

  assert.equal(created.id, "n1");
  assert.equal(created.read, false);
  assert.equal(created.priority, "NORMAL");
  assert.equal(store.rows.length, 1);
  assert.equal(store.rows[0]?.id, "n1");

  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.type, "notification.created");
  assert.deepEqual(seen[0]?.payload, created);
});

test("notify carries missionId onto the event and keeps payload/metadata", () => {
  const store = fakeNotificationStore();
  const bus = createEventBus();
  let event: KaiEvent | undefined;
  bus.subscribe((e) => { event = e; });

  const service = createNotificationService({ store, bus, idFactory: () => "n2" });
  const created = service.notify({
    type: "approval_needed",
    title: "Approve write",
    priority: "HIGH",
    missionId: "m-9",
    metadata: { tool: "fs.write" },
  });

  assert.equal(event?.missionId, "m-9");
  assert.equal(created.missionId, "m-9");
  assert.deepEqual(created.metadata, { tool: "fs.write" });
  assert.equal(created.priority, "HIGH");
});

test("dedupe returns the same notification inside the window and a new one after it", () => {
  const store = fakeNotificationStore();
  const bus = createEventBus();
  const c = clock();
  let n = 0;
  const service = createNotificationService({ store, bus, now: c.now, idFactory: () => `n${++n}` });

  const first = service.notify({ type: "mission_failed", title: "Mission failed" });
  const repeat = service.notify({ type: "mission_failed", title: "Mission failed" });

  assert.equal(repeat.id, first.id, "a repeat inside 60s must return the existing notification");
  assert.equal(store.rows.length, 1, "no new row inside the window");

  c.advance(59_999);
  assert.equal(service.notify({ type: "mission_failed", title: "Mission failed" }).id, first.id);

  c.advance(1); // exactly 60s after the first — window has elapsed
  const after = service.notify({ type: "mission_failed", title: "Mission failed" });
  assert.notEqual(after.id, first.id, "a new notification is created after the window");
  assert.equal(store.rows.length, 2);
});

test("dedupe falls back to type + title when no dedupeKey is given", () => {
  const store = fakeNotificationStore();
  const bus = createEventBus();
  let n = 0;
  const service = createNotificationService({ store, bus, idFactory: () => `n${++n}` });

  const a = service.notify({ type: "agent_down", title: "Hermes offline" });
  const sameTuple = service.notify({ type: "agent_down", title: "Hermes offline" });
  const otherTitle = service.notify({ type: "agent_down", title: "OpenCode offline" });
  const otherType = service.notify({ type: "agent_error", title: "Hermes offline" });

  assert.equal(sameTuple.id, a.id);
  assert.notEqual(otherTitle.id, a.id);
  assert.notEqual(otherType.id, a.id);
  assert.equal(store.rows.length, 3);
});

test("an explicit dedupeKey groups otherwise-different notifications", () => {
  const store = fakeNotificationStore();
  const bus = createEventBus();
  let n = 0;
  const service = createNotificationService({ store, bus, idFactory: () => `n${++n}` });

  const a = service.notify({ type: "sync_failed", title: "Attempt 1", dedupeKey: "sync:gdrive" });
  const b = service.notify({ type: "sync_failed", title: "Attempt 2", dedupeKey: "sync:gdrive" });

  assert.equal(b.id, a.id);
  assert.equal(store.rows.length, 1);
});

test("an invalid priority falls back to NORMAL; valid ones are preserved", () => {
  const store = fakeNotificationStore();
  const bus = createEventBus();
  let n = 0;
  const service = createNotificationService({ store, bus, idFactory: () => `n${++n}` });

  assert.equal(service.notify({ type: "t", title: "default" }).priority, "NORMAL");
  assert.equal(service.notify({ type: "t", title: "low", priority: "LOW" }).priority, "LOW");
  assert.equal(service.notify({ type: "t", title: "crit", priority: "CRITICAL" }).priority, "CRITICAL");
  assert.equal(
    service.notify({ type: "t", title: "bogus", priority: "URGENT" as never }).priority,
    "NORMAL",
  );
  assert.equal(
    service.notify({ type: "t", title: "notastring", priority: 3 as never }).priority,
    "NORMAL",
  );
});

test("markRead updates the store and publishes notification.read", () => {
  const store = fakeNotificationStore();
  const bus = createEventBus();
  const reads: KaiEvent[] = [];
  bus.subscribe((event) => reads.push(event), { types: ["notification.read"] });

  const service = createNotificationService({ store, bus, idFactory: () => "n1" });
  const created = service.notify({ type: "approval_needed", title: "Approve", missionId: "m-1" });

  service.markRead(created.id);

  assert.equal(store.getNotification(created.id)?.read, true);
  assert.equal(reads.length, 1);
  assert.equal(reads[0]?.type, "notification.read");
  assert.deepEqual(reads[0]?.payload, { id: created.id });
  assert.equal(reads[0]?.missionId, "m-1");
});

test("markRead is quiet when the notification is already read or unknown", () => {
  const store = fakeNotificationStore();
  const bus = createEventBus();
  let reads = 0;
  bus.subscribe(() => { reads += 1; }, { types: ["notification.read"] });

  const service = createNotificationService({ store, bus, idFactory: () => "n1" });
  const created = service.notify({ type: "t", title: "x" });

  service.markRead(created.id);
  service.markRead(created.id);
  assert.equal(reads, 1, "a no-op markRead must not republish");
  assert.equal(store.getNotification(created.id)?.read, true);
});

test("list delegates to the store, honouring unreadOnly and limit", () => {
  const store = fakeNotificationStore();
  const bus = createEventBus();
  let n = 0;
  const service = createNotificationService({ store, bus, idFactory: () => `n${++n}` });

  const a = service.notify({ type: "t", title: "a" });
  service.notify({ type: "t", title: "b" });
  service.notify({ type: "t", title: "c" });
  service.markRead(a.id);

  assert.equal(service.list().length, 3);
  assert.equal(service.list({ limit: 2 }).length, 2);
  assert.deepEqual(service.list({ unreadOnly: true }).map((x) => x.title), ["b", "c"]);
});

test("deterministic ids and timestamps come from injection", () => {
  const store = fakeNotificationStore();
  const bus = createEventBus();
  const c = clock();
  let n = 0;
  const service = createNotificationService({ store, bus, now: c.now, idFactory: () => `n${++n}` });

  const first = service.notify({ type: "t", title: "first" });
  const second = service.notify({ type: "t", title: "second" });

  assert.equal(first.id, "n1");
  assert.equal(second.id, "n2");
  assert.equal(first.createdAt, "2026-01-02T03:04:05.000Z");
});

test("default ids stay unique within the same millisecond", () => {
  const store = fakeNotificationStore();
  const bus = createEventBus();
  const service = createNotificationService({ store, bus, now: clock().now });
  const ids = new Set<string>();
  for (let i = 0; i < 5; i += 1) ids.add(service.notify({ type: "t", title: `t${i}` }).id);
  assert.equal(ids.size, 5);
});
