// The overview card's rebuild key must include what the card renders.
//
//   cd app && node --test tests/overview-key.test.ts
//
// The defect these pin (found live): the KAI card renders `State.runtimeLabel`
// and the Core connection, but the key that decides whether the card is rebuilt
// was built only from `task.id/state/steps` + the integration data. A real
// runtime change (IDLE → USING_TOOL, driven by a live `action.executed`) left the
// card showing "KAI is idle" while the character's glow proved USING_TOOL. The
// key is pure and DOM-free, so this asserts it directly with no WebView.

import { test } from "node:test";
import assert from "node:assert/strict";
import { overviewCardKey, type OverviewCardKeyInput } from "../src/views/overview-key.ts";
import { RUNTIME_LABELS } from "../src/core/runtime-state.ts";

/** The KAI card, idle, on a healthy Core. The regression's exact subject. */
function kaiInput(patch: Partial<OverviewCardKeyInput> = {}): OverviewCardKeyInput {
  return {
    id: "integration_kai",
    detailOpen: false,
    state: "idle",
    steps: [],
    loaded: true,
    error: null,
    configured: true,
    data: {},
    runtime: "IDLE",
    connection: "ONLINE",
    ...patch,
  };
}

test("equal inputs produce the same key (no spurious rebuilds)", () => {
  assert.equal(overviewCardKey(kaiInput()), overviewCardKey(kaiInput()));
});

test("a runtime change produces a new key — the stale-label fix", () => {
  // This is the regression: the label the card prints is RUNTIME_LABELS[runtime],
  // so a runtime change MUST change the key or the card keeps the old label.
  const idle = overviewCardKey(kaiInput({ runtime: "IDLE" }));
  const using = overviewCardKey(kaiInput({ runtime: "USING_TOOL" }));
  assert.notEqual(idle, using, "IDLE → USING_TOOL must rebuild the KAI card");
  assert.notEqual(RUNTIME_LABELS.IDLE, RUNTIME_LABELS.USING_TOOL);
});

test("every runtime state that changes the label changes the key", () => {
  const states = ["IDLE", "THINKING", "WORKING", "USING_TOOL", "WAITING_APPROVAL", "SUCCESS", "ERROR", "OFFLINE"] as const;
  const keys = new Map<string, string>();
  for (const s of states) keys.set(s, overviewCardKey(kaiInput({ runtime: s })));
  for (let i = 0; i < states.length; i++) {
    for (let j = i + 1; j < states.length; j++) {
      // Distinct runtime states carry distinct labels, so distinct keys are owed.
      if (RUNTIME_LABELS[states[i]] !== RUNTIME_LABELS[states[j]]) {
        assert.notEqual(keys.get(states[i]), keys.get(states[j]), `${states[i]} vs ${states[j]}`);
      }
    }
  }
});

test("a connection change produces a new key — the KAI card reads it too", () => {
  const online = overviewCardKey(kaiInput({ connection: "ONLINE" }));
  const offline = overviewCardKey(kaiInput({ connection: "OFFLINE" }));
  assert.notEqual(online, offline, "the KAI card's accent/meta read State.core.conn");
});

test("the worker/integration inputs still key as before", () => {
  const base = kaiInput();
  assert.notEqual(overviewCardKey(base), overviewCardKey(kaiInput({ state: "working" })));
  assert.notEqual(overviewCardKey(base), overviewCardKey(kaiInput({ steps: ["step 1"] })));
  assert.notEqual(overviewCardKey(base), overviewCardKey(kaiInput({ detailOpen: true })));
  assert.notEqual(overviewCardKey(base), overviewCardKey(kaiInput({ id: "integration_hermes" })));
  assert.notEqual(overviewCardKey(base), overviewCardKey(kaiInput({ data: { totalRepos: 3 } })));
});
