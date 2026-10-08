// KAI's runtime state machine — the character must never keep acting busy after
// the runtime it is reporting on is gone.
//
//   cd app && node --test tests/runtime-state.test.ts
//
// The defect these pin: `setConnection` entered OFFLINE only on the exact string
// "OFFLINE", but a Core death with a retry pending stays CONNECTING, so the
// machine kept its last active pose ("KAI is using a tool…") forever. These tests
// drive the machine with an injected clock, so nothing waits in real time.

import { test } from "node:test";
import assert from "node:assert/strict";
import { KaiRuntimeMachine, stateForEvent } from "../src/core/runtime-state.ts";

/** A machine with a clock the test controls. */
function machine(): { m: KaiRuntimeMachine; advance: (ms: number) => number } {
  let now = 1_000;
  const m = new KaiRuntimeMachine(() => now);
  return {
    m,
    advance(ms: number) {
      now += ms;
      return now;
    },
  };
}

/** Put the machine in a real active state via a real Core event. */
function intoUsingTool(m: KaiRuntimeMachine, at = 1_000): void {
  m.applyEvent({ id: "evt-tool-1", type: "action.executed", payload: {} }, at);
  assert.equal(m.state, "USING_TOOL");
}

test("(i) an active state + a connection outage falls to OFFLINE within the grace period", () => {
  const { m, advance } = machine();
  intoUsingTool(m);

  // A retry is pending: core-events reports CONNECTING, not OFFLINE.
  m.setConnection("CONNECTING");
  assert.equal(m.state, "USING_TOOL", "not offline on the first failed poll");

  // Still inside the grace: the pose holds (no flicker).
  m.tick(advance(m.offlineGraceMs - 1));
  assert.equal(m.state, "USING_TOOL", "inside the grace the pose is unchanged");

  // Past the grace with the outage still unhealed: KAI is honestly offline.
  m.tick(advance(1));
  assert.equal(m.state, "OFFLINE", "a sustained outage becomes OFFLINE");
  assert.equal(m.lastTransition?.cause, "core.connection.lost");
});

test("(ii) reconnection resumes the REAL state, not the stale pose", () => {
  const { m, advance } = machine();
  intoUsingTool(m);
  m.setConnection("CONNECTING");
  m.tick(advance(m.offlineGraceMs + 1));
  assert.equal(m.state, "OFFLINE");

  // The real reconnection event (ONLINE) leaves OFFLINE for a clean resting state.
  m.setConnection("ONLINE");
  assert.equal(m.state, "IDLE", "reconnect returns to a clean state, not the old pose");

  // The old action event is deduped, so a reconnect replay cannot resurrect the
  // stale pose; only a genuinely new real event moves KAI again.
  assert.equal(m.applyEvent({ id: "evt-tool-1", type: "action.executed", payload: {} }), false);
  assert.equal(m.state, "IDLE");
  m.applyEvent({ id: "evt-tool-2", type: "action.executed", payload: {} });
  assert.equal(m.state, "USING_TOOL", "a real new event drives the real state");
});

test("(iii) a blip shorter than the grace does not flicker", () => {
  const { m, advance } = machine();
  intoUsingTool(m);

  m.setConnection("CONNECTING");
  m.tick(advance(300));
  assert.equal(m.state, "USING_TOOL", "a short blip keeps the pose");

  // The connection comes back before the grace elapses.
  m.setConnection("ONLINE");
  m.tick(advance(m.offlineGraceMs * 2));
  assert.equal(m.state, "USING_TOOL", "no offline flip after a healed blip");
});

test("a local turn submit cannot fake liveness while OFFLINE", () => {
  const { m, advance } = machine();
  intoUsingTool(m);
  m.setConnection("DEGRADED");
  m.tick(advance(m.offlineGraceMs + 1));
  assert.equal(m.state, "OFFLINE");

  // Submitting a turn with the runtime gone must not show KAI as busy.
  m.turnSubmitted();
  assert.equal(m.state, "OFFLINE");
  m.turnResolved(false);
  assert.equal(m.state, "OFFLINE");
});

test("DEGRADED counts as an outage too (stream down while HTTP answers)", () => {
  const { m, advance } = machine();
  intoUsingTool(m);
  m.setConnection("DEGRADED");
  m.tick(advance(m.offlineGraceMs + 1));
  assert.equal(m.state, "OFFLINE");
});

// ── multi-agent: a real-event concurrency counter, with a latch ───────────────
//
// The trap these pin: a naive `count >= 2 ? MULTI_AGENT : DELEGATING` recomputed
// on every `subagent.stopped` drops KAI out of the multi-agent behaviour the
// instant ONE of two workers finishes, even though another is still running.

test("multi-agent is entered by two concurrent subagents and HOLDS until the last stops", () => {
  const { m } = machine();

  // A alone is delegation, not multi-agent.
  m.applyEvent({ id: "sub-A-start", type: "subagent.started" });
  assert.equal(m.state, "DELEGATING", "one live subagent is delegation");

  // B starting makes it two at once: genuine multi-agent.
  m.applyEvent({ id: "sub-B-start", type: "subagent.started" });
  assert.equal(m.state, "MULTI_AGENT", "two concurrent subagents enter multi-agent");

  // A stops while B still runs: KAI REMAINS multi-agent. This is the assertion a
  // naive counter fails.
  m.applyEvent({ id: "sub-A-stop", type: "subagent.stopped" });
  assert.equal(m.state, "MULTI_AGENT", "one of two finishing must not drop out");

  // B stops: the set is empty, so the behaviour exits (the parent worker goes on).
  m.applyEvent({ id: "sub-B-stop", type: "subagent.stopped" });
  assert.equal(m.state, "WORKING", "the last stop exits multi-agent");

  // A fresh lone subagent is delegation again — the latch was cleared.
  m.applyEvent({ id: "sub-C-start", type: "subagent.started" });
  assert.equal(m.state, "DELEGATING", "the latch clears when the set drains");
});

test("a duplicate/unknown subagent.stop cannot drive the count negative", () => {
  const { m } = machine();
  m.applyEvent({ id: "sub-X-start", type: "subagent.started" });
  m.applyEvent({ id: "sub-X-stop", type: "subagent.stopped" });
  assert.equal(m.state, "WORKING");
  // A stray second stop must not re-enter a state or go negative.
  m.applyEvent({ id: "sub-X-stop2", type: "subagent.stopped" });
  assert.equal(m.state, "WORKING");
});

// ── the generic-notification envelope ─────────────────────────────────────────
//
// The defect these pin: the Core publishes EVERY notification as the wire type
// `notification.created`, with the real semantic type nested in `payload.type`
// (see core/src/notifications/service.ts). `stateForEvent` keyed on `event.type`,
// so its `mission.recovery_blocked` branch could NEVER fire — RECOVERING was
// unreachable from the real stream. The mapping now resolves the nested type.

test("a notification.created wrapping mission.recovery_blocked maps to RECOVERING", () => {
  const mapped = stateForEvent({
    id: "ntf-1",
    type: "notification.created",
    payload: {
      id: "ntf-1",
      type: "mission.recovery_blocked",
      title: "1 mission(s) need a decision",
      priority: "HIGH",
    },
  });
  assert.deepEqual(mapped, { state: "RECOVERING", cause: "mission.recovery_blocked" });
});

test("the runtime machine ENTERS RECOVERING from the real wrapped notification", () => {
  const { m } = machine();
  const changed = m.applyEvent({
    id: "ntf-2",
    type: "notification.created",
    payload: { id: "ntf-2", type: "mission.recovery_blocked", priority: "HIGH" },
  });
  assert.equal(changed, true, "the wrapped event caused a transition");
  assert.equal(m.state, "RECOVERING");
  assert.equal(m.lastTransition?.cause, "mission.recovery_blocked");
  assert.equal(m.lastTransition?.eventId, "ntf-2");
});

test("a plain notification with no mapped nested type changes nothing", () => {
  // A generic user notification (`type: "approval"`, "autonomy", …) is NOT a
  // runtime state — an unknown nested type must not invent one.
  assert.equal(stateForEvent({ type: "notification.created", payload: { type: "approval" } }), null);
  assert.equal(stateForEvent({ type: "notification.created", payload: { type: "notification" } }), null);
  // The envelope with no nested type at all is likewise inert (and cannot recurse).
  assert.equal(stateForEvent({ type: "notification.created", payload: {} }), null);
  assert.equal(stateForEvent({ type: "notification.created", payload: { type: "notification.created" } }), null);

  const { m } = machine();
  m.applyEvent({ id: "ntf-3", type: "notification.created", payload: { type: "autonomy" } });
  assert.equal(m.state, "IDLE", "an unmapped notification leaves the runtime at rest");
});

test("the wrapped type is what names the cause, so the envelope never leaks as the state", () => {
  // Guards against a regression where the outer wire type is used as the cause.
  const mapped = stateForEvent({ type: "notification.created", payload: { type: "mission.recovery_blocked" } });
  assert.equal(mapped?.cause, "mission.recovery_blocked");
  assert.notEqual(mapped?.cause, "notification.created");
});
