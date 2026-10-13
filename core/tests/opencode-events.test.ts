// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The OpenCode EVENT STREAM, consumed for real.
 *
 * `OpenCodeClient.events()` has always existed and nothing called it, so KAI
 * learned "working" and then "idle" and nothing in between. These tests drive the
 * adapter against a DETERMINISTIC fake SSE stream — no live runtime, no skip —
 * and pin the four rules the pump must keep:
 *
 *   - it forwards real progress, deduped and scoped to the run's session;
 *   - it is ADVISORY: zero events, or a stream that dies mid-run, must leave a
 *     completed turn exactly as it was;
 *   - it is CLEANED UP: a finished run leaves no reader holding the connection.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createOpenCodeAdapter } from "../src/agents/adapters/opencodeAdapter.ts";
import type { AgentAdapter, AgentTask } from "../src/shared/contracts.ts";

const enc = new TextEncoder();

/** One SSE frame. */
function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * A body that yields the given frames, then either closes cleanly or FAILS —
 * `dieAfter` makes the stream break after N frames, which is the mid-run death
 * the pump must survive.
 */
function sseBody(
  frames: string[],
  opts: { dieAfter?: number; onEnd: () => void },
): ReadableStream<Uint8Array> {
  let i = 0;
  let ended = false;
  const end = (): void => {
    if (ended) return;
    ended = true;
    opts.onEnd();
  };
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (opts.dieAfter !== undefined && i >= opts.dieAfter) {
        end();
        controller.error(new Error("the stream died"));
        return;
      }
      if (i >= frames.length) {
        end();
        controller.close();
        return;
      }
      controller.enqueue(enc.encode(frames[i] ?? ""));
      i += 1;
    },
    cancel() {
      end();
    },
  });
}

interface Harness {
  adapter: AgentAdapter;
  events: { type: string; payload: unknown }[];
  /** Await the CONDITION (n progress events), never a guessed duration. */
  waitForProgress(n: number): Promise<void>;
}

function harness(opts: { frames?: string[]; dieAfter?: number } = {}): Harness {
  const events: { type: string; payload: unknown }[] = [];
  // The stream signals when it is finished; the turn waits for THAT, so the
  // ordering is deterministic rather than a race the test hopes to win.
  const streamDone = Promise.withResolvers<void>();

  const fetchImpl = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const target = String(url);
    const method = (init?.method ?? "GET").toUpperCase();

    if (target.includes("/global/health")) {
      return new Response(JSON.stringify({ healthy: true, version: "test" }), { status: 200 });
    }
    if (target.endsWith("/session") && method === "POST") {
      return new Response(JSON.stringify({ id: "sess_1" }), { status: 200 });
    }
    if (target.includes("/session/sess_1/message") && method === "POST") {
      await streamDone.promise; // the turn ends only after the stream has drained
      return new Response(JSON.stringify({ info: { id: "m1" }, parts: [{ type: "text", text: "done" }] }), { status: 200 });
    }
    if (target.includes("/event")) {
      const body = sseBody(opts.frames ?? [], {
        ...(opts.dieAfter !== undefined ? { dieAfter: opts.dieAfter } : {}),
        onEnd: () => streamDone.resolve(),
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return new Response("not found", { status: 404 });
  };

  const adapter = createOpenCodeAdapter({
    baseUrl: "http://127.0.0.1:4096",
    timeoutMs: 5000,
    turnTimeoutMs: 5000,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    onEvent: (type, payload) => events.push({ type, payload }),
  });

  return {
    adapter,
    events,
    async waitForProgress(n) {
      // Yield macrotasks until the pump has forwarded n progress events. This
      // awaits the SIGNAL, and a bounded cap means a bug fails the test rather
      // than hanging it.
      for (let i = 0; i < 200; i += 1) {
        if (events.filter((e) => e.type === "agent.progress").length >= n) return;
        await new Promise((r) => setImmediate(r));
      }
    },
  };
}

const TASK: AgentTask = { id: "t1", input: "do the thing" };

test("THREE event types reach the KAI bus as progress, scoped to the run's session", async (t) => {
  const h = harness({
    frames: [
      frame({ id: "e1", type: "session.status", properties: { sessionID: "sess_1", status: { type: "busy" } } }),
      frame({ id: "e2", type: "message.part.updated", properties: { sessionID: "sess_1", messageID: "m1" } }),
      frame({ id: "e3", type: "session.idle", properties: { sessionID: "sess_1" } }),
    ],
  });
  const result = await h.adapter.runTask(TASK);
  await h.waitForProgress(0);

  assert.equal(result.state, "completed", `the turn still completed: ${JSON.stringify(result)}`);
  const progress = h.events.filter((e) => e.type === "agent.progress");
  assert.equal(progress.length, 3, `three progress events, got: ${JSON.stringify(h.events.map((e) => e.type))}`);
  const types = progress.map((e) => (e.payload as { type: string }).type);
  assert.deepEqual(types, ["session.status", "message.part.updated", "session.idle"]);
  for (const e of progress) {
    assert.equal((e.payload as { sessionId: string }).sessionId, "sess_1", "every event carries the session");
    assert.equal((e.payload as { id: string }).id, "opencode", "and the worker id");
  }
  t.diagnostic(`3 event types forwarded: ${types.join(", ")}`);
});

test("a ZERO-event stream leaves the run EXACTLY as it was", async (t) => {
  const h = harness({ frames: [] });
  const result = await h.adapter.runTask(TASK);
  await h.waitForProgress(0);

  assert.equal(result.state, "completed");
  assert.equal(result.output, "done", "the output is unchanged");
  assert.equal(
    h.events.filter((e) => e.type === "agent.progress").length,
    0,
    "no events were invented",
  );
  // The status lifecycle is untouched by the pump.
  const statuses = h.events.filter((e) => e.type === "agent.status_changed").map((e) => (e.payload as { state: string }).state);
  assert.deepEqual(statuses, ["working", "idle"]);
  t.diagnostic("zero events -> completed, no progress emitted");
});

test("a stream that DIES mid-run does NOT fail the turn", async (t) => {
  const h = harness({
    frames: [
      frame({ id: "e1", type: "session.status", properties: { sessionID: "sess_1" } }),
      frame({ id: "e2", type: "message.part.updated", properties: { sessionID: "sess_1" } }),
      frame({ id: "e3", type: "session.idle", properties: { sessionID: "sess_1" } }),
    ],
    dieAfter: 2,
  });
  const result = await h.adapter.runTask(TASK);
  await h.waitForProgress(0);

  assert.equal(result.state, "completed", `a dead stream must not fail a completed turn: ${JSON.stringify(result)}`);
  assert.equal(result.output, "done");
  assert.equal(result.error, undefined, "and must not attach an error");
  const progress = h.events.filter((e) => e.type === "agent.progress");
  assert.equal(progress.length, 2, "the frames before the break were still forwarded");
  t.diagnostic(`stream died after 2 frames; turn completed with ${progress.length} progress events`);
});

test("DUPLICATE events are deduped by id", async (t) => {
  const dup = frame({ id: "same", type: "session.status", properties: { sessionID: "sess_1" } });
  const h = harness({ frames: [dup, dup, dup, frame({ id: "other", type: "session.idle", properties: { sessionID: "sess_1" } })] });
  await h.adapter.runTask(TASK);
  await h.waitForProgress(0);

  const progress = h.events.filter((e) => e.type === "agent.progress");
  assert.equal(progress.length, 2, `one per distinct id, got ${progress.length}`);
  const ids = progress.map((e) => (e.payload as { type: string }).type);
  assert.deepEqual(ids, ["session.status", "session.idle"]);
  t.diagnostic("3 copies of one id -> 1 event");
});

test("events for ANOTHER session are ignored; unnamed events are kept", async (t) => {
  const h = harness({
    frames: [
      frame({ id: "a", type: "session.status", properties: { sessionID: "someone_else" } }),
      frame({ id: "b", type: "session.status", properties: { sessionID: "sess_1" } }),
      frame({ id: "c", type: "global.heartbeat" }),
    ],
  });
  await h.adapter.runTask(TASK);
  await h.waitForProgress(0);

  const types = h.events.filter((e) => e.type === "agent.progress").map((e) => (e.payload as { type: string }).type);
  assert.ok(!types.includes("session.status") || types.filter((x) => x === "session.status").length === 1, "the other session's event was dropped");
  assert.ok(types.includes("global.heartbeat"), `an event naming NO session is kept: ${types.join(",")}`);
  assert.equal(types.length, 2, `two events survive, got: ${types.join(",")}`);
  t.diagnostic(`kept: ${types.join(", ")}`);
});

test("a CANCEL still terminates and releases an IDLE stream", async (t) => {
  // A real SSE stream is IDLE most of the time: it emits a few frames and then
  // sends nothing until something happens. The old parser checked the abort
  // signal only BETWEEN reads, so an idle stream stayed parked on `read()`
  // forever. This pins the fix: the abort must release the read.
  let cancelled = false;
  let emitted = 0;
  const idleAfterFrames = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (emitted >= 2) return; // park: a live stream with nothing to say
      emitted += 1;
      controller.enqueue(enc.encode(frame({ id: `f${emitted}`, type: "session.status", properties: { sessionID: "sess_1" } })));
    },
    cancel() {
      cancelled = true;
    },
  });

  const fetchImpl = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const target = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    if (target.includes("/global/health")) return new Response(JSON.stringify({ healthy: true }), { status: 200 });
    if (target.endsWith("/session") && method === "POST") return new Response(JSON.stringify({ id: "sess_1" }), { status: 200 });
    if (target.includes("/session/sess_1/message") && method === "POST") {
      return new Response(JSON.stringify({ info: { id: "m1" }, parts: [{ type: "text", text: "ok" }] }), { status: 200 });
    }
    if (target.includes("/event")) return new Response(idleAfterFrames, { status: 200, headers: { "content-type": "text/event-stream" } });
    return new Response("nope", { status: 404 });
  };

  const progress: unknown[] = [];
  const adapter = createOpenCodeAdapter({
    baseUrl: "http://127.0.0.1:4096",
    timeoutMs: 5000,
    turnTimeoutMs: 5000,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    onEvent: (type, payload) => {
      if (type === "agent.progress") progress.push(payload);
    },
  });

  // The turn returns immediately; the pump is left parked on an idle stream.
  const result = await adapter.runTask(TASK);
  assert.equal(result.state, "completed", "the run finished while the stream was idle");

  // The run's `finally` aborted the stream. Yield macrotasks until the cancel
  // propagates — awaiting the CONDITION, not a guessed duration.
  for (let i = 0; i < 200 && !cancelled; i += 1) await new Promise((r) => setImmediate(r));

  assert.equal(cancelled, true, "the abort RELEASED the parked read — no reader is left holding the connection");
  assert.ok(progress.length >= 1, `the frames before the idle were forwarded: ${progress.length}`);
  t.diagnostic(`idle stream released after ${progress.length} progress events`);
});

test("the pump never turns a worker's own event into a completion claim", async (t) => {
  // `session.idle` is the WORKER saying it stopped. It must reach the bus as
  // advisory progress and must not, by itself, produce a terminal result — the
  // adapter's result comes from the turn, and the Outcome Gate judges the work.
  const h = harness({ frames: [frame({ id: "x", type: "session.idle", properties: { sessionID: "sess_1" } })] });
  const result = await h.adapter.runTask(TASK);
  await h.waitForProgress(0);

  const progress = h.events.filter((e) => e.type === "agent.progress");
  assert.equal(progress.length, 1, "the idle event is forwarded as progress");
  assert.equal(
    h.events.filter((e) => e.type === "worker.completed").length,
    0,
    "the adapter emits NO completion event of its own from a stream event",
  );
  assert.equal(result.state, "completed", "the state still comes from the turn");
  t.diagnostic("session.idle -> agent.progress only; no completion claim");
});
