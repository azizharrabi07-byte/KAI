// Tests for the KAI Core event-stream manager.
//
//   cd app && node --test tests/core-events.test.ts
//
// Node v26 runs the TypeScript directly: no build step, no extra deps. Every
// test injects its own transport and its own timers, so nothing here touches the
// network and nothing really waits.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createCoreEventStream,
  parseEvent,
  parseFrame,
  type CoreConnState,
  type CoreEvent,
  type CoreTransport,
} from "../src/core/core-events.ts";

/** Drain all pending microtasks (and one macrotask turn). No real waiting. */
function flush(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

interface FakeTimers {
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  scheduled: { fn: () => void; ms: number; cancelled: boolean; fired: boolean }[];
  runNext: () => boolean;
}

function fakeTimers(): FakeTimers {
  const scheduled: FakeTimers["scheduled"] = [];
  return {
    scheduled,
    setTimer(fn, ms) {
      const entry = { fn, ms, cancelled: false, fired: false };
      scheduled.push(entry);
      return entry;
    },
    clearTimer(handle) {
      if (handle && typeof handle === "object") {
        (handle as { cancelled: boolean }).cancelled = true;
      }
    },
    runNext() {
      const entry = scheduled.find((e) => !e.cancelled && !e.fired);
      if (!entry) return false;
      entry.fired = true;
      entry.fn();
      return true;
    },
  };
}

interface ControlledTransport {
  transport: CoreTransport;
  calls: { signal: AbortSignal; onFrame: (f: string) => void; onOpen: () => void }[];
}

/** A transport that does nothing until the test drives it. */
function controlledTransport(): ControlledTransport {
  const calls: ControlledTransport["calls"] = [];
  const transport: CoreTransport = (signal, onFrame, onOpen) => {
    calls.push({ signal, onFrame, onOpen });
    return new Promise<void>(() => {
      /* never settles unless the test aborts/supersedes; abort is observed via signal */
    });
  };
  return { transport, calls };
}

// ── parseFrame ────────────────────────────────────────────────────────────────

test("parseFrame: a comment line is recognised as a keep-alive", () => {
  assert.deepEqual(parseFrame(": kai.core event stream connected"), {
    comment: "kai.core event stream connected",
  });
});

test("parseFrame: a single data line", () => {
  assert.deepEqual(parseFrame('data: {"type":"stream.ready"}'), {
    data: '{"type":"stream.ready"}',
  });
});

test("parseFrame: multi-line data is joined with newlines", () => {
  assert.deepEqual(parseFrame("data: line one\ndata: line two"), {
    data: "line one\nline two",
  });
});

test("parseFrame: CRLF is tolerated (data, id, comment)", () => {
  assert.deepEqual(parseFrame('data: {"a":1}\r\nid: 7\r\nevent: ping'), {
    data: '{"a":1}',
    id: "7",
    event: "ping",
  });
  assert.deepEqual(parseFrame(": keep-alive\r\n"), { comment: "keep-alive" });
});

test("parseFrame: unknown fields are ignored, a bare field is empty", () => {
  assert.deepEqual(parseFrame("retry: 5000\ndata: x"), { data: "x" });
  assert.deepEqual(parseFrame("data"), { data: "" });
  assert.deepEqual(parseFrame(""), {});
});

// ── parseEvent ────────────────────────────────────────────────────────────────

test("parseEvent: a good JSON object passes through", () => {
  const ev = parseEvent(
    '{"id":"e1","type":"mission.created","timestamp":"2026-01-01T00:00:00Z","source":"core","payload":{"a":1},"missionId":"m1"}',
  );
  assert.ok(ev);
  assert.equal(ev!.id, "e1");
  assert.equal(ev!.type, "mission.created");
  assert.equal(ev!.missionId, "m1");
  assert.deepEqual(ev!.payload, { a: 1 });
});

test("parseEvent: malformed JSON returns null instead of throwing", () => {
  assert.equal(parseEvent("{not json"), null);
  assert.equal(parseEvent(""), null);
  assert.equal(parseEvent('{"type":'), null);
});

test("parseEvent: non-object JSON is invalid consistently", () => {
  for (const bad of ["null", "42", "true", '"str"', "[]", "[1,2]", "{}"]) {
    assert.equal(parseEvent(bad), null, `expected null for ${bad}`);
  }
  // An object with no string `type` is not a Core event either.
  assert.equal(parseEvent('{"id":"x"}'), null);
});

// ── framing behaviour through the stream ──────────────────────────────────────

test("ready frame is proof of life, not a business event: ready + 2 events => 2 events", async () => {
  const events: CoreEvent[] = [];
  const states: CoreConnState[] = [];
  const { transport } = controlledTransport();
  let call!: { onFrame: (f: string) => void; onOpen: () => void };

  const stream = createCoreEventStream({
    transport: (signal, onFrame, onOpen) => {
      call = { onFrame, onOpen };
      return transport(signal, onFrame, onOpen);
    },
    setTimer: fakeTimers().setTimer,
    clearTimer: fakeTimers().clearTimer,
    onEvent: (e) => events.push(e),
    onState: (s) => states.push(s),
  });

  stream.connect();
  await flush();
  call.onOpen();
  call.onFrame(": kai.core event stream connected");
  call.onFrame('data: {"type":"stream.ready"}');
  call.onFrame('data: {"type":"mission.created","id":"a"}');
  call.onFrame('data: {"type":"mission.completed","id":"b"}');

  assert.equal(events.length, 2);
  assert.deepEqual(
    events.map((e) => e.type),
    ["mission.created", "mission.completed"],
  );
  // Comment + ready + 2 data frames were all received by the transport.
  assert.equal(stream.received, 4);
  assert.equal(states[0], "CONNECTING");
  assert.ok(states.includes("ONLINE"));
});

test("state sequence for a successful connect is CONNECTING then ONLINE", async () => {
  const states: CoreConnState[] = [];
  const { transport } = controlledTransport();
  let call!: { onOpen: () => void };

  const stream = createCoreEventStream({
    transport: (signal, onFrame, onOpen) => {
      call = { onOpen };
      return transport(signal, onFrame, onOpen);
    },
    onState: (s) => states.push(s),
  });

  assert.equal(stream.state, "OFFLINE");
  stream.connect();
  assert.equal(stream.state, "CONNECTING"); // synchronous, attempt in flight
  await flush();
  call.onOpen();
  assert.equal(stream.state, "ONLINE");
  assert.deepEqual(states, ["CONNECTING", "ONLINE"]);
});

test("onState fires on real transitions only, never twice with the same value", async () => {
  const states: CoreConnState[] = [];
  const { transport } = controlledTransport();
  let call!: { onFrame: (f: string) => void; onOpen: () => void };

  const stream = createCoreEventStream({
    transport: (signal, onFrame, onOpen) => {
      call = { onFrame, onOpen };
      return transport(signal, onFrame, onOpen);
    },
    onState: (s) => states.push(s),
  });

  stream.connect();
  await flush();
  call.onOpen();
  call.onOpen(); // repeated open must not re-fire ONLINE
  call.onFrame('data: {"type":"stream.ready"}'); // still ONLINE
  call.onFrame('data: {"type":"agent.output"}');
  call.onOpen(); // and again

  for (let i = 1; i < states.length; i++) {
    assert.notEqual(states[i], states[i - 1], "no two consecutive equal states");
  }
  assert.deepEqual(states, ["CONNECTING", "ONLINE"]);
});

test("malformed frame never reaches onEvent and does not throw", async () => {
  const events: CoreEvent[] = [];
  const { transport } = controlledTransport();
  let call!: { onFrame: (f: string) => void; onOpen: () => void };

  const stream = createCoreEventStream({
    transport: (signal, onFrame, onOpen) => {
      call = { onFrame, onOpen };
      return transport(signal, onFrame, onOpen);
    },
    onEvent: (e) => events.push(e),
  });

  stream.connect();
  await flush();
  call.onOpen();
  assert.doesNotThrow(() => {
    call.onFrame("data: {this is not json");
    call.onFrame("data: 42");
    call.onFrame("data: null");
  });
  call.onFrame('data: {"type":"agent.output","id":"ok"}');

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "agent.output");
});

// ── backoff, failure and recovery ─────────────────────────────────────────────

test("a rejected attempt stays CONNECTING with a retry at the FIRST backoff value", async () => {
  const states: CoreConnState[] = [];
  const timers = fakeTimers();
  const transport: CoreTransport = () => Promise.reject(new Error("boom"));

  const stream = createCoreEventStream({
    transport,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    onState: (s) => states.push(s),
  });

  stream.connect();
  await flush();

  // Retry pending => CONNECTING (documented), never OFFLINE/ONLINE while waiting.
  assert.equal(stream.state, "CONNECTING");
  assert.deepEqual(states, ["CONNECTING"]);
  assert.equal(timers.scheduled.length, 1);
  assert.equal(timers.scheduled[0].ms, 1000); // schedule[0]
});

test("consecutive failures walk the schedule then repeat the last value", async () => {
  const timers = fakeTimers();
  let calls = 0;
  const transport: CoreTransport = () => {
    calls += 1;
    return Promise.reject(new Error("boom"));
  };

  createCoreEventStream({
    transport,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  }).connect();
  await flush();

  // Drive the injected timers; each fired retry fails again and schedules the next.
  for (let i = 0; i < 8; i++) {
    timers.runNext();
    await flush();
  }

  const delays = timers.scheduled.map((e) => e.ms);
  assert.deepEqual(delays.slice(0, 7), [1000, 2000, 5000, 10000, 15000, 15000, 15000]);
  // and it repeats the last value indefinitely, never a tight loop
  assert.equal(delays[delays.length - 1], 15000);
  assert.equal(calls, timers.scheduled.length); // one attempt per scheduled retry
});

test("a success after failures resets the schedule to the first delay", async () => {
  const timers = fakeTimers();
  const states: CoreConnState[] = [];
  let attempt = 0;
  const transport: CoreTransport = (_signal, _onFrame, onOpen) => {
    attempt += 1;
    if (attempt <= 2) return Promise.reject(new Error("boom")); // fail twice
    onOpen(); // third attempt succeeds, then the stream ends (server closed)
    return Promise.resolve();
  };

  const stream = createCoreEventStream({
    transport,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    onState: (s) => states.push(s),
  });

  stream.connect();
  await flush();
  assert.equal(timers.scheduled[0].ms, 1000); // first failure -> schedule[0]

  timers.runNext();
  await flush();
  assert.equal(timers.scheduled[1].ms, 2000); // second failure -> schedule[1]

  timers.runNext(); // third attempt opens ONLINE and then ends
  await flush();
  assert.deepEqual(states, ["CONNECTING", "ONLINE", "CONNECTING"]); // reached ONLINE

  // The ended connection fails to hold, so a retry is scheduled — but the good
  // connection reset the index, so it is schedule[0] again, not schedule[2].
  assert.equal(timers.scheduled[2].ms, 1000);
});

// ── disconnect / reconnect ────────────────────────────────────────────────────

test("disconnect aborts the in-flight request and prevents any further retry", async () => {
  const timers = fakeTimers();
  let calls = 0;
  const transport: CoreTransport = () => {
    calls += 1;
    return Promise.reject(new Error("boom")); // fail so a retry gets scheduled
  };

  const stream = createCoreEventStream({
    transport,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  stream.connect();
  await flush();
  assert.equal(calls, 1);
  assert.equal(timers.scheduled.length, 1);

  stream.disconnect();
  assert.equal(stream.state, "OFFLINE");
  assert.equal(timers.scheduled[0].cancelled, true);

  // Advance every timer: nothing may fire, no second transport call.
  for (let i = 0; i < 5; i++) {
    timers.runNext();
    await flush();
  }
  assert.equal(calls, 1);
});

test("disconnect aborts the live signal and a late frame cannot flip state back to ONLINE", async () => {
  const states: CoreConnState[] = [];
  const { transport, calls } = controlledTransport();
  let call!: { signal: AbortSignal; onFrame: (f: string) => void; onOpen: () => void };

  const stream = createCoreEventStream({
    transport: (signal, onFrame, onOpen) => {
      call = { signal, onFrame, onOpen };
      return transport(signal, onFrame, onOpen);
    },
    onState: (s) => states.push(s),
  });

  stream.connect();
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(call.signal.aborted, false);

  stream.disconnect();
  assert.equal(call.signal.aborted, true);
  assert.equal(stream.state, "OFFLINE");

  // Late frames from the aborted attempt must be ignored.
  call.onOpen();
  call.onFrame('data: {"type":"stream.ready"}');
  call.onFrame('data: {"type":"mission.created"}');
  assert.equal(stream.state, "OFFLINE");
  assert.ok(!states.includes("ONLINE"));
});

test("reconnect cannot leave two live connections", async () => {
  const { transport, calls } = controlledTransport();
  const stream = createCoreEventStream({ transport });

  stream.connect();
  await flush();
  assert.equal(calls.length, 1);

  stream.reconnect();
  await flush();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].signal.aborted, true, "old attempt aborted");
  assert.equal(calls[1].signal.aborted, false, "exactly one live attempt");
});
