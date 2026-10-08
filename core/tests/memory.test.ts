// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Memory service tests. Plain `node --test`, no dependencies, no network.
 * Run from `core/`:  node --test tests/memory.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  createMemoryService,
  MemoryValidationError,
} from "../src/memory/service.ts";
import type {
  KaiEventType,
  Memory,
  MemoryStore,
} from "../src/shared/contracts.ts";
import type { Publish } from "../src/runtime.ts";

/** Hand-written in-memory fake — deliberately does NOT import core/src/storage. */
function fakeMemoryStore(): MemoryStore & { rows: Memory[] } {
  const rows: Memory[] = [];
  return {
    rows,
    createMemory(memory: Memory): void {
      rows.push({ ...memory });
    },
    getMemory(id: string): Memory | null {
      return rows.find((row) => row.id === id) ?? null;
    },
    listMemories(opts: { type?: Memory["type"]; limit?: number } = {}): Memory[] {
      let out = rows.slice().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      if (opts.type !== undefined) out = out.filter((row) => row.type === opts.type);
      if (opts.limit !== undefined) out = out.slice(0, Math.max(0, opts.limit));
      return out;
    },
    updateMemory(memory: Memory): void {
      const i = rows.findIndex((row) => row.id === memory.id);
      if (i >= 0) rows[i] = { ...memory };
    },
    deleteMemory(id: string): void {
      const i = rows.findIndex((row) => row.id === id);
      if (i >= 0) rows.splice(i, 1);
    },
  };
}

interface Published {
  type: KaiEventType;
  payload: unknown;
}

function spyPublish(): { publish: Publish; events: Published[] } {
  const events: Published[] = [];
  return {
    events,
    publish: (type, payload) => {
      events.push({ type, payload });
    },
  };
}

const BASE_MS = Date.parse("2026-01-02T03:04:05.000Z");
function clock(): { now: () => Date; advance: (ms: number) => void } {
  let offset = 0;
  return {
    now: () => new Date(BASE_MS + offset),
    advance: (ms: number) => {
      offset += ms;
    },
  };
}

test("remember stores a row, applies defaults, and publishes memory.created", () => {
  const store = fakeMemoryStore();
  const { publish, events } = spyPublish();
  let id = 0;
  const service = createMemoryService({
    store,
    publish,
    now: clock().now,
    idFactory: () => `m${id++}`,
    defaultImportance: 4,
  });

  const memory = service.remember({ type: "note", content: "  User is working on KAI  " });

  assert.equal(memory.id, "m0");
  assert.equal(memory.type, "note");
  assert.equal(memory.content, "User is working on KAI"); // trimmed
  assert.equal(memory.source, "user_statement"); // default
  assert.equal(memory.importance, 4); // defaultImportance
  assert.equal(memory.createdAt, new Date(BASE_MS).toISOString());
  assert.equal(memory.updatedAt, memory.createdAt);
  assert.equal(store.rows.length, 1);

  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "memory.created");
  assert.deepEqual(events[0]?.payload, memory);
});

test("remember honors explicit source, importance clamp and metadata", () => {
  const store = fakeMemoryStore();
  const service = createMemoryService({ store, idFactory: () => "m" });

  const high = service.remember({
    type: "project_fact",
    content: "Project X has failing tests",
    source: "system_state",
    importance: 99,
    metadata: { project: "X" },
  });
  const low = service.remember({ type: "note", content: "trivia", importance: -3 });

  assert.equal(high.importance, 5); // clamped down
  assert.equal(high.source, "system_state");
  assert.deepEqual(high.metadata, { project: "X" });
  assert.equal(low.importance, 1); // clamped up
});

test("remember rejects blank content with a KaiError-shaped throw", () => {
  const store = fakeMemoryStore();
  const service = createMemoryService({ store });

  assert.throws(
    () => service.remember({ type: "note", content: "   " }),
    (error: unknown) => {
      assert.ok(error instanceof MemoryValidationError);
      assert.equal(error.kaiError.code, "VALIDATION_FAILED");
      assert.equal(error.kaiError.retryable, false);
      return true;
    },
  );
  assert.equal(store.rows.length, 0);
});

test("dedupe: true (and the default) keeps one row for the same (type, content)", () => {
  const store = fakeMemoryStore();
  const { publish, events } = spyPublish();
  let id = 0;
  const service = createMemoryService({ store, publish, idFactory: () => `m${id++}` });

  const first = service.remember({ type: "note", content: "User is working on KAI", dedupe: true });
  const again = service.remember({ type: "note", content: "User is working on KAI", dedupe: true });

  assert.equal(store.rows.length, 1);
  assert.equal(again.id, first.id);
  assert.equal(events.length, 1); // no event for a no-op dedupe

  // Default behaviour is to dedupe too.
  const byDefault = service.remember({ type: "note", content: "User is working on KAI" });
  assert.equal(store.rows.length, 1);
  assert.equal(byDefault.id, first.id);
  assert.equal(events.length, 1);
});

test("dedupe: false forces a second row", () => {
  const store = fakeMemoryStore();
  let id = 0;
  const service = createMemoryService({ store, idFactory: () => `m${id++}` });

  service.remember({ type: "note", content: "same", dedupe: false });
  service.remember({ type: "note", content: "same", dedupe: false });

  assert.equal(store.rows.length, 2);
});

test("dedupe is scoped by type — same content under a different type is a new row", () => {
  const store = fakeMemoryStore();
  let id = 0;
  const service = createMemoryService({ store, idFactory: () => `m${id++}` });

  service.remember({ type: "note", content: "shared text" });
  service.remember({ type: "project_fact", content: "shared text" });

  assert.equal(store.rows.length, 2);
});

test("search filters by type and by case-insensitive content substring", () => {
  const store = fakeMemoryStore();
  const service = createMemoryService({ store });

  service.remember({ type: "note", content: "KAI is a control plane" });
  service.remember({ type: "project_fact", content: "Project X has failing tests" });
  service.remember({ type: "note", content: "lunch at noon" });

  const control = service.search({ text: "CONTROL" });
  assert.equal(control.length, 1);
  assert.equal(control[0]?.content, "KAI is a control plane");

  const notes = service.search({ type: "note" });
  assert.equal(notes.length, 2);

  const notesWithX = service.search({ type: "note", text: "x" });
  // "KAI is a control plane" (no x) vs "lunch at noon" (no x) — neither has an x.
  assert.equal(notesWithX.length, 0);

  const limited = service.search({ limit: 1 });
  assert.equal(limited.length, 1);
});

test("digest orders by importance desc, then createdAt desc", () => {
  const store = fakeMemoryStore();
  const c = clock();
  let id = 0;
  const service = createMemoryService({ store, now: c.now, idFactory: () => `m${id++}` });

  const lowOld = service.remember({ type: "note", content: "low old", importance: 1 });
  c.advance(1000);
  const highOld = service.remember({ type: "note", content: "high old", importance: 5 });
  c.advance(1000);
  const highNew = service.remember({ type: "note", content: "high new", importance: 5 });
  c.advance(1000);
  const mid = service.remember({ type: "note", content: "mid", importance: 3 });

  const digest = service.digest();
  assert.deepEqual(
    digest.map((memory) => memory.id),
    [highNew.id, highOld.id, mid.id, lowOld.id],
  );

  const top2 = service.digest({ limit: 2 });
  assert.deepEqual(
    top2.map((memory) => memory.id),
    [highNew.id, highOld.id],
  );
});

test("digest can be restricted to specific types", () => {
  const store = fakeMemoryStore();
  const service = createMemoryService({ store });

  service.remember({ type: "note", content: "a note" });
  service.remember({ type: "project_fact", content: "a project fact", importance: 5 });

  const onlyProject = service.digest({ types: ["project_fact"] });
  assert.equal(onlyProject.length, 1);
  assert.equal(onlyProject[0]?.type, "project_fact");

  const both = service.digest({ types: ["note", "project_fact"] });
  assert.equal(both.length, 2);
});

test("forget returns true and publishes memory.deleted for a known id", () => {
  const store = fakeMemoryStore();
  const { publish, events } = spyPublish();
  const service = createMemoryService({ store, publish, idFactory: () => "gone" });

  const memory = service.remember({ type: "note", content: "temporary" });
  events.length = 0;

  assert.equal(service.forget(memory.id), true);
  assert.equal(store.rows.length, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "memory.deleted");
  assert.deepEqual(events[0]?.payload, { id: "gone" });
});

test("forget returns false for an unknown id, never throws, and publishes nothing", () => {
  const store = fakeMemoryStore();
  const { publish, events } = spyPublish();
  const service = createMemoryService({ store, publish });

  assert.equal(service.forget("does-not-exist"), false);
  assert.equal(events.length, 0);
  assert.equal(store.rows.length, 0);
});

test("an omitted publish seam is tolerated by every mutation", () => {
  const store = fakeMemoryStore();
  const service = createMemoryService({ store });

  const memory = service.remember({ type: "note", content: "no bus here" });
  assert.equal(service.forget(memory.id), true);
  assert.equal(store.rows.length, 0);
});
