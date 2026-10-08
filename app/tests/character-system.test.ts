// The ONE shared character system — the AUTO/MANUAL resolution rule.
//
//   cd app && node --import ./tests/register-ts.mjs --test tests/character-system.test.ts
//
// What this pins:
//   (a) AUTO is driven by REAL events — a hand-built Core event moves the state;
//   (b) MANUAL HOLDS the user's pick, so a cosmetic choice is stable;
//   (c) a real SAFETY state overrides a held feeling (KAI never hides a problem);
//   (d) the choice round-trips through the durable store, and a bad value is
//       rejected rather than entering a state the machine cannot;
//   (e) appearance persists to the shared store AND is broadcast to every view.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  FEELINGS,
  FEELINGS_KEY,
  KaiCharacterSystem,
  isSafetyOverride,
  parseFeelingPrefs,
} from "../src/character/system.ts";
import { KaiRuntimeMachine } from "../src/core/runtime-state.ts";
import { makeVariant } from "../src/character/variant.ts";

function memoryStore(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    getItem: (k: string) => (k in data ? data[k] : null),
    setItem: (k: string, v: string) => { data[k] = v; },
    _data: data,
  };
}

/** A machine whose clock we control, so a bounded safeguard is deterministic. */
function fixedClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

// ── (a) AUTO follows real events ──────────────────────────────────────────────

test("AUTO: a real approval event moves KAI to WAITING_APPROVAL", () => {
  const sys = new KaiCharacterSystem({ store: memoryStore() });
  assert.equal(sys.mode, "AUTO");
  assert.equal(sys.resolve(), "IDLE");
  sys.applyEvent({ id: "e1", type: "approval.requested" });
  assert.equal(sys.runtime, "WAITING_APPROVAL");
  assert.equal(sys.resolve(), "WAITING_APPROVAL");
});

test("AUTO: an unknown event changes nothing (no invented states)", () => {
  const sys = new KaiCharacterSystem({ store: memoryStore() });
  sys.applyEvent({ id: "e1", type: "something.unmapped" });
  assert.equal(sys.resolve(), "IDLE");
});

test("AUTO: a tool action classifies the real activity", () => {
  const sys = new KaiCharacterSystem({ store: memoryStore() });
  sys.applyEvent({ id: "e1", type: "action.executed", payload: { toolId: "bash" } });
  assert.equal(sys.resolve(), "USING_CLI");
});

// ── (b) MANUAL holds the pick ─────────────────────────────────────────────────

test("MANUAL: the pick is held even as unrelated real events arrive", () => {
  const sys = new KaiCharacterSystem({ store: memoryStore() });
  sys.selectFeeling("RECOVERING");
  assert.equal(sys.mode, "MANUAL");
  assert.equal(sys.resolve(), "RECOVERING");
  // A non-safety event must NOT displace the held feeling.
  sys.applyEvent({ id: "e1", type: "mission.progress" });
  assert.equal(sys.runtime, "WORKING");
  assert.equal(sys.resolve(), "RECOVERING");
});

test("clearManual returns to AUTO and the runtime shows through", () => {
  const sys = new KaiCharacterSystem({ store: memoryStore() });
  sys.selectFeeling("WORKING");
  sys.clearManual();
  assert.equal(sys.mode, "AUTO");
  assert.equal(sys.resolve(), "IDLE");
});

// ── (c) a safety state overrides a held feeling ───────────────────────────────

test("MANUAL: a real safety state overrides the held feeling", () => {
  for (const safety of ["OFFLINE", "ERROR", "WAITING_APPROVAL", "NEEDS_USER"]) {
    assert.equal(isSafetyOverride(safety as never), true, safety);
  }
  const sys = new KaiCharacterSystem({ store: memoryStore() });
  sys.selectFeeling("SUCCESS");
  assert.equal(sys.resolve(), "SUCCESS");
  // A real Core outage must show, not the held smile.
  sys.applyEvent({ id: "s1", type: "core.stopped" });
  assert.equal(sys.runtime, "OFFLINE");
  assert.equal(sys.resolve(), "OFFLINE");
});

test("isSafetyOverride is false for ordinary work states", () => {
  for (const s of ["IDLE", "WORKING", "THINKING", "SUCCESS"]) {
    assert.equal(isSafetyOverride(s as never), false, s);
  }
});

// ── (d) persistence ───────────────────────────────────────────────────────────

test("a MANUAL choice round-trips through the durable store", () => {
  const store = memoryStore();
  const a = new KaiCharacterSystem({ store });
  a.selectFeeling("CODING");
  assert.ok(store._data[FEELINGS_KEY], "the pick was persisted");

  const b = new KaiCharacterSystem({ store });
  assert.equal(b.mode, "MANUAL");
  assert.equal(b.manual, "CODING");
  assert.equal(b.resolve(), "CODING");
});

test("parseFeelingPrefs rejects a state the machine cannot enter", () => {
  assert.equal(parseFeelingPrefs("{ not json"), null);
  assert.deepEqual(
    parseFeelingPrefs(JSON.stringify({ mode: "MANUAL", manual: "NOT_A_STATE" })),
    { mode: "AUTO", manual: null },
  );
});

test("every offered feeling is a value the machine can actually resolve", () => {
  const sys = new KaiCharacterSystem({ store: memoryStore() });
  for (const state of FEELINGS) {
    sys.selectFeeling(state);
    assert.equal(sys.resolve(), state, state);
  }
});

// ── (e) appearance persists and broadcasts ────────────────────────────────────

test("setAppearance persists to the shared store and broadcasts to views", () => {
  const store = memoryStore();
  const sys = new KaiCharacterSystem({ store });
  const seen: string[] = [];
  sys.attachAppearance({ setAppearance: (v) => seen.push(v.skin) });
  // Attaching applies the current appearance once.
  assert.equal(seen.length, 1);

  sys.setAppearance(makeVariant({ skin: "yellow", accessory: "cap", theme: "sun" }));
  assert.equal(seen.length, 2);
  assert.equal(seen[1], "yellow");
  assert.ok(store._data["kai.appearance.v1"], "the appearance was persisted to the shared key");

  // A fresh system reads it back.
  const b = new KaiCharacterSystem({ store });
  assert.equal(b.appearance.skin, "yellow");
  assert.equal(b.appearance.accessory, "cap");
});

test("a state view is pushed the resolved state, and the safety override reaches it", () => {
  const sys = new KaiCharacterSystem({ store: memoryStore() });
  const states: string[] = [];
  sys.attachState({ setState: (s) => states.push(s) });
  assert.deepEqual(states, ["IDLE"]);
  sys.selectFeeling("WORKING");
  assert.equal(states.at(-1), "WORKING");
  sys.applyEvent({ id: "s1", type: "core.stopped" });
  assert.equal(states.at(-1), "OFFLINE");
});
