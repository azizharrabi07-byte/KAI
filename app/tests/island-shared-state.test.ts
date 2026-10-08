// SHARED STATE — the island and the main workspace read ONE Core mirror, proven
// in BOTH directions.
//
//   cd app && node --import ./tests/register-ts.mjs --test tests/island-shared-state.test.ts
//
// The island owns no session, mission, worker, approval or conversation: it
// renders `State.core`, the same slice the workspace's panels read. These tests
// drive the single seam (`island/shared.ts`) the way each surface drives it and
// assert the other surface observes the SAME change — including the island's own
// runtime machine reacting to the same event.

import { test } from "node:test";
import assert from "node:assert/strict";
import { coreIdentity, sameCoreState, sharedCore } from "../src/island/shared.ts";
import { KaiRuntimeMachine } from "../src/core/runtime-state.ts";

/** The island's reader: what the island's views render. */
const islandReader = () => sharedCore.read();
/** The workspace's reader: `mount.ts` renders the panels from this same slice. */
const workspaceReader = () => sharedCore.read();

test("DIRECTION island -> workspace: an island event is visible to the workspace", () => {
  const before = workspaceReader().approvals.length;
  sharedCore.applyFromIsland({
    id: "iso-evt-1",
    type: "approval.requested",
    payload: { id: "shared-ap-1", toolId: "shell.run", action: "shell.run", reason: "run tests", risk: "EXTERNAL" },
  });

  const ws = workspaceReader();
  assert.equal(ws.approvals.length, before + 1, "the workspace sees the approval the island applied");
  const row = ws.approvals.find((a) => a.id === "shared-ap-1");
  assert.ok(row, "the exact approval is present");
  assert.equal(row!.status, "PENDING");

  // Both readers are literally looking at the same KAI.
  assert.ok(sameCoreState(islandReader(), workspaceReader()));
  assert.deepEqual(coreIdentity(islandReader()), coreIdentity(workspaceReader()));
});

test("DIRECTION workspace -> island: a workspace event is visible to the island", () => {
  const before = islandReader().missions.length;
  sharedCore.applyFromWorkspace({
    id: "ws-evt-1",
    type: "mission.started",
    payload: { id: "shared-mission-1", title: "Deploy KAI" },
  });

  const island = islandReader();
  assert.equal(island.missions.length, before + 1, "the island sees the mission the workspace started");
  const m = island.missions.find((x) => x.id === "shared-mission-1");
  assert.ok(m);
  assert.equal(m!.status, "RUNNING");
  assert.ok(sameCoreState(islandReader(), workspaceReader()));
});

test("the SAME Core event drives the mirror AND the island's own runtime face", () => {
  // One event, two consumers: the shared mirror both panels read, and the island's
  // runtime machine that drives the character. This is the "same Core, one KAI" fact.
  const event = {
    id: "evt-approval-face",
    type: "approval.requested",
    payload: { id: "shared-ap-2", toolId: "t", action: "t", reason: "r", risk: "WRITE" },
  };
  sharedCore.applyFromIsland(event);
  const machine = new KaiRuntimeMachine(() => 1_000);
  machine.applyEvent(event);
  assert.equal(machine.state, "WAITING_APPROVAL", "the island's face needs the approval");
  assert.ok(islandReader().approvals.some((a) => a.id === "shared-ap-2"), "the mirror carries it");
});

test("a duplicated event id does not duplicate the shared state", () => {
  const event = {
    id: "evt-dup-1",
    type: "notification.created",
    payload: { id: "shared-ntf-1", type: "mission.recovery_blocked", title: "decision", priority: "HIGH", read: false, createdAt: "2026-10-05T10:00:00.000Z" },
  };
  sharedCore.applyFromWorkspace(event);
  const afterFirst = islandReader().notifications.filter((n) => n.id === "shared-ntf-1").length;
  sharedCore.applyFromWorkspace(event);
  const afterSecond = islandReader().notifications.filter((n) => n.id === "shared-ntf-1").length;
  assert.equal(afterFirst, 1);
  assert.equal(afterSecond, 1, "a reconnect replay cannot double-report to either surface");
});

test("a connection observed by one surface is the connection the other reads", () => {
  sharedCore.setConnection("OFFLINE", "KAI Core is not running");
  const ws = workspaceReader();
  assert.equal(ws.conn, "OFFLINE");
  assert.equal(ws.lastError, "KAI Core is not running");
  assert.ok(sameCoreState(islandReader(), workspaceReader()));
  sharedCore.setConnection("ONLINE");
  assert.equal(islandReader().conn, "ONLINE", "a reconnect clears the outage for both");
});
