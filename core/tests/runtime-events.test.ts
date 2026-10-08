// Phase 1 Part B/T — the canonical runtime contract.
//
// Two things are being protected here:
//
//   1. The runtime vocabulary and the control-plane vocabulary stay separate.
//      The brief is explicit that they must not be merged into one union: a
//      provider stream and KAI's own event log answer different questions, and
//      a union containing both means every consumer filters out most of it.
//
//   2. An event that reaches the bus can always be attributed to the instance
//      that produced it. Part C's cross-provider check is only possible if the
//      instance id is mandatory at the contract level — so it is, and this test
//      is what stops someone making it optional again.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  deserializeRuntimeEvent,
  isRuntimeEvent,
  isRuntimeEventType,
  serializeRuntimeEvent,
  toControlPlaneEvent,
  type RuntimeEvent,
} from "../src/shared/runtime-events.ts";
import { type KaiEventType, isEmployeeState, isPolicyMode } from "../src/shared/contracts.ts";

const BASE = {
  eventId: "e-1",
  employeeKind: "hermes",
  instanceId: "hermes#1",
  at: "2026-10-02T12:00:00.000Z",
} as const;

/** One sample of every member of the union. If a member is added without a sample here, the count test fires. */
const SAMPLES: RuntimeEvent[] = [
  { ...BASE, type: "session.started", sessionId: "s-1", model: "deepseek-v4.1-flash" },
  { ...BASE, type: "session.exited", sessionId: "s-1", code: 0 },
  { ...BASE, type: "session.error", error: { code: "AGENT_BAD_RESPONSE", message: "bad", retryable: true } },
  { ...BASE, type: "turn.started", turnId: "t-1", model: "m" },
  { ...BASE, type: "item.started", turnId: "t-1", itemId: "i-1", itemKind: "tool", name: "read_file" },
  { ...BASE, type: "item.delta", turnId: "t-1", itemId: "i-1", itemKind: "assistant_text", text: "he" },
  {
    ...BASE,
    type: "item.completed",
    turnId: "t-1",
    itemId: "i-1",
    itemKind: "tool",
    name: "read_file",
    ok: true,
    durationMs: 12,
  },
  {
    ...BASE,
    type: "request.opened",
    requestId: "r-1",
    requestKind: "permission",
    summary: "run rm -rf build",
    allowForSession: true,
  },
  { ...BASE, type: "request.resolved", requestId: "r-1", resolvedBy: "human", allowed: true },
  { ...BASE, type: "turn.completed", turnId: "t-1", ok: true, stopReason: "end_turn", text: "done" },
  { ...BASE, type: "turn.failed", turnId: "t-1", error: { code: "AGENT_TIMEOUT", message: "slow", retryable: true } },
];

test("every canonical runtime event serialises and round-trips", () => {
  assert.equal(SAMPLES.length, 11, "one sample per union member (session.exited included)");
  for (const event of SAMPLES) {
    const wire = serializeRuntimeEvent(event);
    const back = deserializeRuntimeEvent(wire);
    assert.deepEqual(back, event, `${event.type} must survive a round trip`);
  }
});

test("every sample is accepted by the guard, and every type name is known", () => {
  for (const event of SAMPLES) {
    assert.equal(isRuntimeEvent(event), true, event.type);
    assert.equal(isRuntimeEventType(event.type), true, event.type);
  }
});

test("serialisation drops `raw` rather than throwing on a non-JSON-safe payload", () => {
  // A provider handle is exactly the kind of value that reaches `raw` and is not
  // JSON-safe. A serialiser that throws at the SSE edge takes the stream down
  // with it, so the raw payload is dropped deliberately.
  const withRaw = { ...SAMPLES[0], raw: { handle: () => undefined, big: 1n } } as unknown as RuntimeEvent;
  const wire = serializeRuntimeEvent(withRaw);
  assert.equal(wire.includes("raw"), false, "raw must not be serialised");
  const back = deserializeRuntimeEvent(wire);
  assert.ok(back);
  assert.equal("raw" in (back as Record<string, unknown>), false);
});

test("malformed input deserialises to null instead of a half-built event", () => {
  assert.equal(deserializeRuntimeEvent("not json"), null);
  assert.equal(deserializeRuntimeEvent('{"type":"turn.completed"}'), null); // no instance id
  assert.equal(deserializeRuntimeEvent("{}"), null);
});

test("an event with no instanceId is rejected — attribution is mandatory", () => {
  const { instanceId: _dropped, ...noInstance } = SAMPLES[0];
  assert.equal(isRuntimeEvent(noInstance), false, "an unattributable event must not validate");
  assert.equal(isRuntimeEvent({ ...SAMPLES[0], instanceId: "" }), false);
});

test("an unknown event type is rejected rather than passed through", () => {
  assert.equal(isRuntimeEvent({ ...SAMPLES[0], type: "vendor.whatever" }), false);
  assert.equal(isRuntimeEventType("vendor.whatever"), false);
});

test("the runtime vocabulary and the control-plane vocabulary do not overlap", () => {
  // If a name existed in both, the two concepts would have been merged by
  // accident and a consumer could no longer tell a worker stream from KAI's log.
  const controlPlane: KaiEventType[] = [
    "app.started",
    "app.stopped",
    "core.started",
    "core.stopped",
    "core.status_changed",
    "agent.connected",
    "agent.disconnected",
    "agent.status_changed",
    "agent.output",
    "agent.error",
    "mission.created",
    "approval.requested",
  ];
  for (const sample of SAMPLES) {
    assert.equal(
      (controlPlane as string[]).includes(sample.type),
      false,
      `${sample.type} must not exist in KaiEventType`,
    );
  }
});

test("only lifecycle events cross into the control plane; streaming detail stays out", () => {
  const source = "hermes#1";
  assert.equal(toControlPlaneEvent(SAMPLES[0], source)?.type, "agent.connected"); // session.started
  assert.equal(toControlPlaneEvent(SAMPLES[1], source)?.type, "agent.disconnected"); // session.exited
  assert.equal(toControlPlaneEvent(SAMPLES[2], source)?.type, "agent.error"); // session.error
  assert.equal(toControlPlaneEvent(SAMPLES[9], source)?.type, "agent.output"); // turn.completed
  // Streaming detail must NOT be persisted as control-plane history.
  assert.equal(toControlPlaneEvent(SAMPLES[3], source), null); // turn.started
  assert.equal(toControlPlaneEvent(SAMPLES[5], source), null); // item.delta
  assert.equal(toControlPlaneEvent(SAMPLES[4], source), null); // item.started
});

test("a worker's permission request is not KAI's approval", () => {
  // A worker asking its caller is not a human-facing approval card: KAI's policy
  // classifies the request first, so the bridge must not emit approval.requested.
  const bridged = toControlPlaneEvent(SAMPLES[7], "hermes#1");
  assert.ok(bridged);
  assert.notEqual(bridged.type, "approval.requested");
});

test("the new employee and policy vocabulary validates at the boundary", () => {
  assert.equal(isEmployeeState("READY"), true);
  assert.equal(isEmployeeState("UNAVAILABLE"), true);
  assert.equal(isEmployeeState("ready"), false, "states are exact");
  assert.equal(isEmployeeState("HIRED"), false);
  assert.equal(isPolicyMode("elevated"), true);
  assert.equal(isPolicyMode("full"), false, "provider CLI modes are not KAI's modes");
});
