// KAI's runtime STATES the companion contract requires, driven by real events.
//
//   cd app && node --import ./tests/register-ts.mjs --test tests/island-states.test.ts
//
// Covers the additions this stream makes (NEEDS_USER, and the character pose it
// maps to) and re-asserts that the already-proven states stay reachable:
// RECOVERING from the real wrapped notification, and the MULTI_AGENT latch.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  KaiRuntimeMachine,
  characterStateFor,
  stateForEvent,
} from "../src/core/runtime-state.ts";
import {
  KAI_STATE_POSE,
  KaiStates,
  poseForState,
} from "../src/character/types.ts";
import { stateActions } from "../src/character/actions.ts";

function machine(): KaiRuntimeMachine {
  let now = 1_000;
  return new KaiRuntimeMachine(() => now++);
}

test("a HIGH notification with an unmapped type enters NEEDS_USER, cause names the nested type", () => {
  const mapped = stateForEvent({
    id: "n1",
    type: "notification.created",
    payload: { type: "something.custom", priority: "HIGH" },
  });
  assert.deepEqual(mapped, { state: "NEEDS_USER", cause: "notification.created:something.custom" });
});

test("a LOW/NORMAL notification with an unmapped type still changes NOTHING", () => {
  // The regression the existing suite pins must survive the priority fallback.
  assert.equal(stateForEvent({ type: "notification.created", payload: { type: "autonomy" } }), null);
  assert.equal(
    stateForEvent({ type: "notification.created", payload: { type: "autonomy", priority: "NORMAL" } }),
    null,
  );
  const m = machine();
  m.applyEvent({ id: "n2", type: "notification.created", payload: { type: "autonomy", priority: "LOW" } });
  assert.equal(m.state, "IDLE");
});

test("the machine ENTERS NEEDS_USER from the real HIGH envelope and is sticky", () => {
  const m = machine();
  const changed = m.applyEvent({
    id: "n3",
    type: "notification.created",
    payload: { id: "n3", type: "mission.blocked", priority: "HIGH" },
  });
  assert.equal(changed, true);
  assert.equal(m.state, "NEEDS_USER");
  assert.equal(m.lastTransition?.cause, "mission.blocked");

  // An unrelated worker event must not clear a question the user has not answered.
  m.applyEvent({ id: "w1", type: "item.started", payload: { tool_name: "Read" } });
  assert.equal(m.state, "NEEDS_USER", "NEEDS_USER is sticky like WAITING_APPROVAL");

  // A real decision does clear it.
  m.applyEvent({ id: "d1", type: "approval.approved", payload: { id: "ap-1" } });
  assert.equal(m.state, "WORKING");
});

test("an explicit attention semantic type maps to NEEDS_USER", () => {
  assert.equal(stateForEvent({ type: "auth.required" })?.state, "NEEDS_USER");
  assert.equal(stateForEvent({ type: "worker.unavailable" })?.state, "NEEDS_USER");
});

test("the bounded safeguard never times a waiting USER_ATTENTION state to IDLE", () => {
  const m = machine();
  m.applyEvent({ id: "n4", type: "notification.created", payload: { type: "blocked.thing", priority: "HIGH" } });
  assert.equal(m.state, "NEEDS_USER");
  // Well past maxActiveMs: a genuine "waiting on a person" must not vanish.
  m.tick(1_000 + m.maxActiveMs + 1);
  assert.equal(m.state, "NEEDS_USER");
});

test("RECOVERING is still reachable end-to-end from the real wrapped notification", () => {
  const m = machine();
  m.applyEvent({
    id: "rec-1",
    type: "notification.created",
    payload: { id: "rec-1", type: "mission.recovery_blocked", priority: "HIGH" },
  });
  assert.equal(m.state, "RECOVERING", "the four-link recovery wiring is intact");
});

test("the MULTI_AGENT latch still holds when one of two subagents stops", () => {
  const m = machine();
  m.applyEvent({ id: "s1", type: "subagent.started" });
  m.applyEvent({ id: "s2", type: "subagent.started" });
  assert.equal(m.state, "MULTI_AGENT");
  m.applyEvent({ id: "s1x", type: "subagent.stopped" });
  assert.equal(m.state, "MULTI_AGENT", "one of two finishing must not drop out");
});

test("NEEDS_USER maps to the attentively-asking character face, not idle", () => {
  assert.equal(KaiStates.NEEDS_USER, "needs_user");
  assert.equal(KAI_STATE_POSE.needs_user, "needsuser");
  assert.equal(poseForState("needs_user"), "needsuser");
  assert.equal(poseForState("NEEDS_USER"), "needsuser", "the directive casing resolves too");
  assert.equal(characterStateFor("NEEDS_USER"), "approval", "the amber 'asks for help' colour");
  assert.ok(stateActions("needs_user").includes("needsuser"));
});
