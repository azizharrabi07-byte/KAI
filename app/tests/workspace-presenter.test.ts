// Chain proof for the worker-activity presentation (`src/workspace/presenter.ts`).
//
//   cd app && node --test tests/workspace-presenter.test.ts
//
// The invariant this suite exists to protect: KAI is ALWAYS the speaker. A
// worker — hermes, opencode, a subagent — may appear only as a DEMOTED field,
// never as the subject of the sentence. This is the "Hermes wearing a KAI
// persona" defect's permanent defence: if any branch ships a line whose subject
// is a worker, these assertions fail.

import { test } from "node:test";
import assert from "node:assert/strict";
import { presentActivity, presentRuntime, presentWorkerRow, workerOf } from "../src/workspace/presenter.ts";
import type { RuntimeEventInput } from "../src/core/runtime-state.ts";

/** Every event shape the presenter is expected to narrate. */
const EVENTS: RuntimeEventInput[] = [
  { type: "mission.created", payload: { id: "m1", title: "read status" } },
  { type: "mission.started", payload: { id: "m1" } },
  { type: "mission.progress", payload: { id: "m1", title: "step 1" } },
  { type: "mission.completed", payload: { id: "m1" } },
  { type: "mission.failed", payload: { id: "m1", message: "boom" } },
  { type: "mission.cancelled", payload: { id: "m1" } },
  { type: "mission.recovery_blocked", payload: { id: "m1" } },
  { type: "approval.requested", payload: { id: "ap1", toolId: "agents.run_task" } },
  { type: "approval.approved", payload: { id: "ap1" } },
  { type: "approval.rejected", payload: { id: "ap1" } },
  { type: "action.executed", payload: { id: "a1", employeeId: "hermes", toolId: "agents.run_task" } },
  { type: "action.executed", payload: { id: "a2", toolId: "system.get_status" } },
  { type: "action.executed", payload: { id: "a3", toolId: "bash" } },
  { type: "scheduled_task.triggered", payload: { title: "nightly" } },
  { type: "agent.connected", payload: { id: "hermes" } },
  { type: "agent.status_changed", payload: { id: "hermes", state: "working" } },
  { type: "agent.status_changed", payload: { id: "hermes", state: "idle" } },
  { type: "agent.status_changed", payload: { id: "opencode", state: "error" } },
  { type: "agent.error", payload: { id: "hermes" } },
  { type: "item.started", payload: { tool_name: "Bash" } },
  { type: "item.started", payload: { tool_name: "WebSearch" } },
  { type: "turn.completed" },
  { type: "turn.failed" },
  { type: "core.stopped" },
  { type: "core.started" },
];

test("every narrated activity keeps KAI as the subject", () => {
  for (const event of EVENTS) {
    const presented = presentActivity(event);
    assert.ok(presented !== null, `${event.type} should be narrated`);
    if (presented === null) continue;
    assert.ok(
      /(^|\s)KAI\b/.test(presented.line),
      `"${presented.line}" (from ${event.type}) does not name KAI`,
    );
    assert.ok(
      presented.line.startsWith("KAI"),
      `"${presented.line}" (from ${event.type}) does not START with KAI`,
    );
  }
});

test("a worker named in the payload is demoted, never the subject", () => {
  const delegated = presentActivity({
    type: "action.executed",
    payload: { id: "a1", employeeId: "hermes", toolId: "agents.run_task" },
  });
  assert.ok(delegated);
  if (delegated === null) return;
  assert.equal(delegated.worker?.id, "hermes");
  assert.ok(!delegated.line.includes("hermes"), "the worker name must not leak into the sentence");
  assert.equal(delegated.state, "DELEGATING");

  const working = presentActivity({ type: "agent.status_changed", payload: { id: "hermes", state: "working" } });
  assert.ok(working);
  if (working === null) return;
  assert.equal(working.worker?.id, "hermes");
  assert.equal(working.worker?.state, "working");
  assert.ok(working.line.startsWith("KAI"));
  assert.ok(!working.line.startsWith("hermes"));
});

test("a worker going idle reports the worker without moving KAI's pose", () => {
  const idle = presentActivity({ type: "agent.status_changed", payload: { id: "hermes", state: "idle" } });
  assert.ok(idle);
  if (idle === null) return;
  assert.equal(idle.state, null, "a resting worker must not move KAI's pose");
  assert.equal(idle.worker?.id, "hermes");
  assert.ok(idle.line.startsWith("KAI is idle"));
});

test("an event the presenter does not narrate returns null (KAI says nothing)", () => {
  assert.equal(presentActivity({ type: "something.unknown", payload: {} }), null);
});

test("the KAI line for a state comes from the one shared label table", () => {
  assert.equal(presentRuntime("CODING"), "KAI is coding…");
  assert.equal(presentRuntime("WAITING_APPROVAL"), "KAI needs your approval");
});

test("workerOf reads the id from employeeId, agentId or id, in that order", () => {
  assert.equal(workerOf({ type: "x", payload: { employeeId: "emp", agentId: "ag", id: "i" } })?.id, "emp");
  assert.equal(workerOf({ type: "x", payload: { agentId: "ag", id: "i" } })?.id, "ag");
  assert.equal(workerOf({ type: "x", payload: { id: "i" } })?.id, "i");
  assert.equal(workerOf({ type: "x", payload: {} }), null);
});

test("presentWorkerRow is the roster view — the one place a worker is the subject", () => {
  const row = presentWorkerRow({ id: "hermes", state: "working" });
  assert.equal(row.name, "hermes");
  assert.equal(row.label, "working");
});
