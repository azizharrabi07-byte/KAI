// UI state tests: the Core's events and snapshots must land in the island's state
// correctly, and nothing else must change.
//
//   cd app && node --test tests/core-state.test.ts
//
// The reducer is pure, so none of this needs a Core, a socket, a timer or a DOM.
// The event payloads below are the shapes the Core actually emits (a mission has an
// id/title/status, an agent event carries id + state, an approval carries toolId +
// risk), not invented ones.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CORE_EVENT_LIMIT,
  applyCoreEvent,
  applySnapshot,
  coreCounts,
  initialCoreSlice,
  setConnection,
  summarizeEvent,
  type CoreSlice,
} from "../src/core/core-state.ts";

test("a fresh slice knows nothing and says so", () => {
  const s = initialCoreSlice();
  assert.equal(s.conn, "CONNECTING");
  assert.equal(s.lastError, null);
  assert.equal(s.lastSyncAt, null);
  assert.deepEqual(s.agents, []);
  assert.deepEqual(s.missions, []);
  assert.equal(coreCounts(s).activeMissions, 0);
});

test("an agent event updates the agent row the island shows", () => {
  let s: CoreSlice = initialCoreSlice();

  s = applyCoreEvent(s, {
    id: "ev-1",
    type: "agent.status_changed",
    timestamp: "2026-10-02T06:00:00.000Z",
    payload: { id: "hermes", state: "working" },
  });

  assert.equal(s.agents.length, 1);
  assert.equal(s.agents[0]?.id, "hermes");
  assert.equal(s.agents[0]?.state, "working");
  assert.equal(s.agents[0]?.lastActivity, "2026-10-02T06:00:00.000Z");

  // A second event for the same agent must update the row, not add another one.
  s = applyCoreEvent(s, { id: "ev-2", type: "agent.status_changed", payload: { id: "hermes", state: "idle" } });
  assert.equal(s.agents.length, 1);
  assert.equal(s.agents[0]?.state, "idle");

  // A different agent is a new row.
  s = applyCoreEvent(s, { id: "ev-3", type: "agent.status_changed", payload: { id: "opencode", state: "idle" } });
  assert.equal(s.agents.length, 2);
});

test("a disconnect marks the agent offline and an error keeps the reason", () => {
  let s = applyCoreEvent(initialCoreSlice(), {
    id: "e1",
    type: "agent.disconnected",
    payload: { id: "opencode" },
  });
  assert.equal(s.agents[0]?.state, "offline");

  s = applyCoreEvent(s, {
    id: "e2",
    type: "agent.error",
    payload: { id: "hermes", detail: "AGENT_AUTH_FAILED: the agent rejected the credentials" },
  });
  const hermes = s.agents.find((a) => a.id === "hermes");
  assert.equal(hermes?.state, "error");
  assert.match(hermes?.detail ?? "", /AGENT_AUTH_FAILED/);
});

test("mission lifecycle updates state, and a failed mission keeps its reason", () => {
  let s: CoreSlice = initialCoreSlice();

  s = applyCoreEvent(s, { id: "m1", type: "mission.created", missionId: "mission_1", payload: { title: "read status" } });
  assert.equal(s.missions.length, 1);
  assert.equal(s.missions[0]?.title, "read status");
  assert.equal(s.missions[0]?.status, "QUEUED", "a created mission is QUEUED, a real Core status");

  s = applyCoreEvent(s, { id: "m2", type: "mission.started", missionId: "mission_1" });
  assert.equal(s.missions[0]?.status, "RUNNING", "mission.started means RUNNING — not a made-up STARTED status");
  assert.equal(coreCounts(s).activeMissions, 1, "a RUNNING mission is active");

  // Progress must not end the mission, and must not lose the title.
  s = applyCoreEvent(s, { id: "m3", type: "mission.progress", missionId: "mission_1", payload: { index: 1, totalSteps: 3 } });
  assert.equal(s.missions[0]?.title, "read status");
  assert.equal(s.missions[0]?.doneSteps, 1);
  assert.equal(s.missions[0]?.totalSteps, 3);
  assert.notEqual(s.missions[0]?.status, "COMPLETED");

  s = applyCoreEvent(s, { id: "m4", type: "mission.completed", missionId: "mission_1" });
  assert.equal(s.missions[0]?.status, "COMPLETED");

  s = applyCoreEvent(s, {
    id: "m5",
    type: "mission.failed",
    missionId: "mission_2",
    payload: { title: "publish", message: "POLICY_DENIED: needs a rule" },
  });
  const failed = s.missions.find((m) => m.id === "mission_2");
  assert.equal(failed?.status, "FAILED");
  assert.match(failed?.errorText ?? "", /POLICY_DENIED/, "a failure keeps the reason, never a bare 'failed'");
});

test("counts come from the mirror, not from a guess", () => {
  let s: CoreSlice = initialCoreSlice();
  s = applyCoreEvent(s, { id: "1", type: "mission.started", missionId: "a", payload: { title: "a" } });
  s = applyCoreEvent(s, { id: "2", type: "mission.completed", missionId: "b", payload: { title: "b" } });
  s = applyCoreEvent(s, { id: "3", type: "approval.requested", payload: { id: "ap-1", toolId: "test.publish", risk: "EXTERNAL" } });
  s = applyCoreEvent(s, {
    id: "4",
    type: "notification.created",
    payload: { id: "n-1", title: "Hermes finished", type: "agent", priority: "NORMAL" },
  });

  const counts = coreCounts(s);
  assert.equal(counts.activeMissions, 1, "only the running mission counts as active");
  assert.equal(counts.pendingApprovals, 1);
  assert.equal(counts.unread, 1);
});

test("the same notification is never reported twice (an SSE reconnect must not duplicate it)", () => {
  let s: CoreSlice = initialCoreSlice();
  const frame = {
    id: "n-frame",
    type: "notification.created",
    payload: { id: "n-42", title: "Mission completed", type: "mission", priority: "HIGH" },
  };
  s = applyCoreEvent(s, frame);
  s = applyCoreEvent(s, frame);            // replayed frame, same id
  const again = applyCoreEvent(s, frame);  // a third time for good measure

  assert.equal(again.notifications.length, 1);
  assert.equal(again.notifications[0]?.id, "n-42");
  assert.equal(again.notifications[0]?.priority, "HIGH");
  // The event list is deduped by event id as well.
  assert.equal(again.recentEvents.filter((e) => e.id === "n-frame").length, 1);
});

test("notification.read flips the flag and clears it from the unread count", () => {
  let s = applyCoreEvent(initialCoreSlice(), {
    id: "e",
    type: "notification.created",
    payload: { id: "n-1", title: "Approval required", type: "approval", priority: "HIGH" },
  });
  assert.equal(coreCounts(s).unread, 1);

  s = applyCoreEvent(s, { id: "e2", type: "notification.read", payload: { id: "n-1" } });
  assert.equal(s.notifications[0]?.read, true);
  assert.equal(coreCounts(s).unread, 0);
});

test("an approval request appears pending and is settled by its decision", () => {
  let s = applyCoreEvent(initialCoreSlice(), {
    id: "a1",
    type: "approval.requested",
    payload: { id: "ap-1", toolId: "test.publish", action: "Publish", reason: "external side effect", risk: "EXTERNAL" },
  });
  assert.equal(s.approvals.length, 1);
  assert.equal(s.approvals[0]?.status, "PENDING");
  assert.equal(s.approvals[0]?.risk, "EXTERNAL");
  assert.equal(coreCounts(s).pendingApprovals, 1);

  s = applyCoreEvent(s, { id: "a2", type: "approval.approved", payload: { id: "ap-1" } });
  assert.equal(s.approvals[0]?.status, "APPROVED");
  assert.equal(coreCounts(s).pendingApprovals, 0);
});

test("core going away flips the connection to OFFLINE with a reason; a snapshot restores it", () => {
  let s = setConnection(initialCoreSlice(), "ONLINE");
  assert.equal(s.conn, "ONLINE");
  assert.equal(s.lastError, null);

  // A transport failure, then the Core's own goodbye frame.
  s = setConnection(s, "OFFLINE", "KAI Core is not reachable");
  assert.equal(s.conn, "OFFLINE");
  assert.equal(s.lastError, "KAI Core is not reachable");

  s = applyCoreEvent(s, { id: "x", type: "core.stopped" });
  assert.equal(s.conn, "OFFLINE");
  assert.match(s.lastError ?? "", /stopped/);

  // Recovery: an offline state must not stick once the Core answers again.
  s = setConnection(s, "CONNECTING", "reconnecting");
  assert.equal(s.conn, "CONNECTING");
  s = applySnapshot(s, {
    agents: [{ id: "hermes", state: "idle" }],
    missions: [{ id: "mission_1", title: "read status", status: "COMPLETED" }],
    coreStartedAt: "2026-10-02T05:00:00.000Z",
    uptimeMs: 1234,
    schedulerRunning: true,
    toolCount: 4,
    now: 1_700_000_000_000,
  });
  assert.equal(s.conn, "ONLINE");
  assert.equal(s.lastError, null, "a successful snapshot clears the error");
  assert.equal(s.lastSyncAt, 1_700_000_000_000);
  assert.equal(s.missions[0]?.status, "COMPLETED", "state came back after the restart");
  assert.equal(s.schedulerRunning, true);
  assert.equal(s.toolCount, 4);
});

test("the event list is bounded — a long-running Core must not grow the island", () => {
  let s: CoreSlice = initialCoreSlice();
  for (let i = 0; i < CORE_EVENT_LIMIT * 3; i += 1) {
    s = applyCoreEvent(s, { id: `e-${i}`, type: "mission.progress", missionId: "m", payload: { index: i } });
  }
  assert.equal(s.recentEvents.length, CORE_EVENT_LIMIT);
  assert.equal(s.recentEvents[0]?.id, `e-${CORE_EVENT_LIMIT * 3 - 1}`, "newest first");
});

test("hostile payloads cannot crash the reducer", () => {
  const bad: unknown[] = [undefined, null, 42, "text", [], { id: 7 }, { id: "x", state: 5 }];
  const types = [
    "agent.status_changed",
    "mission.progress",
    "notification.created",
    "approval.requested",
    "approval.approved",
    "mission.failed",
    "core.stopped",
    "something.unknown",
  ];

  for (const payload of bad) {
    for (const type of types) {
      const s = applyCoreEvent(initialCoreSlice(), { id: "e", type, payload });
      assert.ok(Array.isArray(s.agents) && Array.isArray(s.missions));
    }
  }

  // An event with no id at all is still recorded (only dedupe needs an id).
  const s = applyCoreEvent(initialCoreSlice(), { type: "mission.started", missionId: "m-1" });
  assert.equal(s.recentEvents.length, 1);
  assert.equal(s.missions.length, 1, "a mission event with only a missionId still names its mission");

  // An unknown type is surfaced by its type name rather than dropped silently.
  assert.equal(summarizeEvent("brand.new.thing"), "brand.new.thing");
});

test("event text is human-readable, and names the agent or mission when it can", () => {
  assert.equal(summarizeEvent("mission.completed"), "Mission completed");
  assert.equal(summarizeEvent("mission.created", { title: "Analyze project" }), "Mission created: Analyze project");
  assert.equal(summarizeEvent("mission.progress", { title: "read status" }), "Working: read status");
  assert.equal(summarizeEvent("agent.status_changed", { id: "hermes", state: "working" }), "hermes is working");
  assert.equal(summarizeEvent("approval.requested", { toolId: "test.publish" }), "Approval needed: test.publish");
  assert.equal(summarizeEvent("agent.disconnected", { id: "opencode" }), "opencode disconnected");
});

// ── the payload survives the reducer ──────────────────────────────────────────
//
// The Core wraps semantic events in `notification.created` with the real type in
// `payload.type`. `CoreEventRow` used to keep only {id,type,at,text}, consuming
// the payload for `text` and dropping it — so the nested type was lost before the
// bridge could forward it and RECOVERING was unreachable.

test("a recorded event row RETAINS the payload (the nested semantic type survives)", () => {
  const s = applyCoreEvent(initialCoreSlice(), {
    id: "evt-recovery",
    type: "notification.created",
    timestamp: "2026-10-04T00:00:00.000Z",
    payload: { id: "ntf-r", type: "mission.recovery_blocked", title: "1 mission(s) need a decision", priority: "HIGH" },
  });
  const row = s.recentEvents.find((e) => e.id === "evt-recovery");
  assert.ok(row !== undefined, "the event is recorded");
  // The outer wire type is what the row is keyed by...
  assert.equal(row?.type, "notification.created");
  // ...but the payload rides along, so the nested type is recoverable downstream.
  const payload = row?.payload as { type?: string } | undefined;
  assert.equal(payload?.type, "mission.recovery_blocked", "the nested semantic type is retained");
  // The notification mirror is unchanged (the type is the notification's own).
  assert.equal(s.notifications[0]?.type, "mission.recovery_blocked");
});

test("an event with no payload records no payload field (nothing invented)", () => {
  const s = applyCoreEvent(initialCoreSlice(), { id: "evt-bare", type: "core.started" });
  const row = s.recentEvents.find((e) => e.id === "evt-bare");
  assert.ok(row !== undefined);
  assert.equal("payload" in (row as object), false, "an absent payload is not fabricated");
});
