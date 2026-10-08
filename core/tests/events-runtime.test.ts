// Part C — the hardened event bus: runtime ingress, attribution, the cross-
// provider check, redaction ordering and listener isolation.
//
//   cd core && node --test tests/events-runtime.test.ts
//
// These are the guarantees Part C adds on top of the existing bus (whose own
// tests remain in tests/events.test.ts and must keep passing).

import test from "node:test";
import assert from "node:assert/strict";

import { createEventBus, type ProviderBinding, type RuntimeEventSink } from "../src/events/bus.ts";
import type { EventStore, KaiEvent } from "../src/shared/contracts.ts";
import type { RuntimeEvent, RuntimeEventListener } from "../src/shared/runtime-events.ts";

// ── Test doubles ─────────────────────────────────────────────────────────────

function fakeEventStore(): EventStore & { inserted: KaiEvent[] } {
  const inserted: KaiEvent[] = [];
  return {
    inserted,
    insertEvent(event: KaiEvent): void {
      inserted.push(event);
    },
    listEvents(): KaiEvent[] {
      return inserted.slice();
    },
  };
}

function fakeRuntimeSink(): RuntimeEventSink & { appended: RuntimeEvent[] } {
  const appended: RuntimeEvent[] = [];
  return {
    appended,
    append(event: RuntimeEvent): void {
      appended.push(event);
    },
  };
}

/**
 * A stand-in for a TurnAdapter's stream: it captures the listener the bus
 * installs so a test can drive an event through the exact path a worker would,
 * and records whether the bus detached cleanly.
 */
function fakeProvider(instanceId: string, employeeKind: string): {
  binding: ProviderBinding;
  emit(event: unknown): void;
  detaches: number;
} {
  let listener: RuntimeEventListener | undefined;
  const state = {
    detaches: 0,
    binding: {
      instanceId,
      employeeKind,
      onEvent(next: RuntimeEventListener): () => void {
        listener = next;
        return () => {
          state.detaches += 1;
          listener = undefined;
        };
      },
    } satisfies ProviderBinding,
    emit(event: unknown): void {
      listener?.(event as RuntimeEvent);
    },
  };
  return state;
}

function turnStarted(instanceId: string, employeeKind: string, over: Record<string, unknown> = {}): RuntimeEvent {
  return {
    eventId: "e-1",
    type: "turn.started",
    at: "2026-10-02T12:00:00.000Z",
    instanceId,
    employeeKind,
    turnId: "t-1",
    model: "deepseek-v4.1-flash",
    ...over,
  } as RuntimeEvent;
}

function itemStarted(instanceId: string, employeeKind: string, inputSummary: string): RuntimeEvent {
  return {
    eventId: "e-2",
    type: "item.started",
    at: "2026-10-02T12:00:01.000Z",
    instanceId,
    employeeKind,
    turnId: "t-1",
    itemId: "i-1",
    itemKind: "tool",
    name: "run_shell",
    inputSummary,
  } as RuntimeEvent;
}

// ── Attribution / stamping ───────────────────────────────────────────────────

test("attachProvider registers an instance and every event is attributed to it", () => {
  const bus = createEventBus();
  const provider = fakeProvider("hermes#1", "hermes");
  bus.attachProvider(provider.binding);

  const seen: RuntimeEvent[] = [];
  bus.subscribeRuntime((event) => seen.push(event));

  const result = bus.ingestRuntime("hermes#1", turnStarted("hermes#1", "hermes"));

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.event.instanceId, "hermes#1");
    assert.equal(result.event.employeeKind, "hermes");
  }
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.instanceId, "hermes#1");
  assert.equal(seen[0]?.employeeKind, "hermes");
});

test("an event that arrives through an unregistered instance is refused", () => {
  const bus = createEventBus();
  const result = bus.ingestRuntime("nobody#9", turnStarted("nobody#9", "hermes"));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "UNKNOWN_INSTANCE");
  assert.deepEqual(bus.recentRuntime(), []);
});

test("a malformed payload is refused as INVALID_EVENT", () => {
  const bus = createEventBus();
  const provider = fakeProvider("hermes#1", "hermes");
  bus.attachProvider(provider.binding);

  const result = bus.ingestRuntime("hermes#1", { type: "turn.started" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "INVALID_EVENT");
});

// ── Cross-provider rejection ─────────────────────────────────────────────────

test("an event claiming another instance is rejected, not re-stamped", () => {
  const bus = createEventBus();
  bus.attachProvider(fakeProvider("hermes#1", "hermes").binding);

  const delivered: RuntimeEvent[] = [];
  bus.subscribeRuntime((event) => delivered.push(event));

  // Claims instance "opencode#1" but arrived through "hermes#1".
  const result = bus.ingestRuntime("hermes#1", turnStarted("opencode#1", "opencode"));

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "CROSS_PROVIDER");
  assert.deepEqual(delivered, [], "a rejected event is never delivered");
  assert.deepEqual(bus.recentRuntime(), [], "a rejected event is never retained");
});

test("an event claiming the wrong employeeKind for its instance is rejected", () => {
  const bus = createEventBus();
  bus.attachProvider(fakeProvider("hermes#1", "hermes").binding);

  // Same instance id, but claims a kind this instance is not registered as.
  const result = bus.ingestRuntime("hermes#1", turnStarted("hermes#1", "opencode"));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "CROSS_PROVIDER");
});

test("a cross-provider event emitted on the real stream is dropped, with a warning", () => {
  const bus = createEventBus();
  const provider = fakeProvider("hermes#1", "hermes");
  bus.attachProvider(provider.binding);

  const delivered: RuntimeEvent[] = [];
  bus.subscribeRuntime((event) => delivered.push(event));

  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
  try {
    provider.emit(turnStarted("hermes#1", "opencode"));
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(delivered, [], "the mis-attributed event must not reach the UI");
  assert.ok(warnings.some((line) => line.includes("CROSS_PROVIDER")), `expected a CROSS_PROVIDER warning: ${warnings}`);
});

// ── Listener isolation ───────────────────────────────────────────────────────

test("one throwing runtime listener does not stop delivery to the others", () => {
  const bus = createEventBus();
  bus.attachProvider(fakeProvider("hermes#1", "hermes").binding);

  const order: string[] = [];
  bus.subscribeRuntime(() => { order.push("first"); throw new Error("ui stream exploded"); });
  bus.subscribeRuntime(() => { order.push("second"); });

  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
  let result;
  try {
    result = bus.ingestRuntime("hermes#1", turnStarted("hermes#1", "hermes"));
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(result.ok, true);
  assert.deepEqual(order, ["first", "second"], "the second listener must still see the event");
  assert.ok(warnings.some((line) => line.includes("e-1") && line.includes("turn.started")));
});

// ── Redaction ordering ───────────────────────────────────────────────────────

test("a KaiEvent is redacted before persistence and before delivery", () => {
  const store = fakeEventStore();
  const bus = createEventBus({ store });

  const delivered: KaiEvent[] = [];
  bus.subscribe((event) => delivered.push(event));

  const emitted = bus.publish("mission.created", { api_key: "sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345" });

  assert.deepEqual(store.inserted.map((e) => e.id), [emitted.id]);
  assert.equal((store.inserted[0]?.payload as { api_key: string }).api_key, "[redacted]");
  assert.equal((delivered[0]?.payload as { api_key: string }).api_key, "[redacted]");
  assert.equal((emitted.payload as { api_key: string }).api_key, "[redacted]");
});

test("a runtime event is redacted before persistence and before delivery", () => {
  const sink = fakeRuntimeSink();
  const bus = createEventBus({ runtimeStore: sink });
  bus.attachProvider(fakeProvider("hermes#1", "hermes").binding);

  const delivered: RuntimeEvent[] = [];
  bus.subscribeRuntime((event) => delivered.push(event));

  const secret = "sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";
  const result = bus.ingestRuntime("hermes#1", itemStarted("hermes#1", "hermes", `run_shell with ${secret}`));

  assert.equal(result.ok, true);
  assert.ok(!JSON.stringify(sink.appended).includes(secret), "the sink must never see the secret");
  assert.ok(!JSON.stringify(delivered).includes(secret), "the subscriber must never see the secret");
  assert.match((delivered[0] as { inputSummary: string }).inputSummary, /\[redacted\]/);
  assert.match((sink.appended[0] as { inputSummary: string }).inputSummary, /\[redacted\]/);
});

// ── recent()/recentRuntime() and detach ──────────────────────────────────────

test("recentRuntime() is newest-first and a copy", () => {
  const bus = createEventBus();
  bus.attachProvider(fakeProvider("hermes#1", "hermes").binding);

  bus.ingestRuntime("hermes#1", turnStarted("hermes#1", "hermes", { eventId: "e-1" }));
  bus.ingestRuntime("hermes#1", turnStarted("hermes#1", "hermes", { eventId: "e-2" }));

  assert.deepEqual(bus.recentRuntime().map((e) => e.eventId), ["e-2", "e-1"]);
  assert.deepEqual(bus.recentRuntime(1).map((e) => e.eventId), ["e-2"]);

  const snapshot = bus.recentRuntime();
  snapshot.length = 0;
  assert.equal(bus.recentRuntime().length, 2, "recentRuntime() must hand back a copy");
});

test("detaching a provider stops its events and unregisters it", () => {
  const bus = createEventBus();
  const provider = fakeProvider("hermes#1", "hermes");
  const detach = bus.attachProvider(provider.binding);

  assert.equal(bus.ingestRuntime("hermes#1", turnStarted("hermes#1", "hermes")).ok, true);

  detach();
  detach(); // idempotent

  assert.equal(provider.detaches, 1, "the underlying adapter subscription is released once");
  const after = bus.ingestRuntime("hermes#1", turnStarted("hermes#1", "hermes"));
  assert.equal(after.ok, false);
  if (!after.ok) assert.equal(after.code, "UNKNOWN_INSTANCE");
});

test("existing recent() behaviour is unchanged by the runtime additions", () => {
  const bus = createEventBus();
  const a = bus.publish("agent.connected", "a");
  const b = bus.publish("agent.output", "b");

  assert.deepEqual(bus.recent().map((e) => e.id), [b.id, a.id]);
  assert.equal((b.payload), "b");
});
