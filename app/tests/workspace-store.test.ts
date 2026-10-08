// Chain proof for the workspace slice (`src/workspace/store.ts`).
//
//   cd app && node --test tests/workspace-store.test.ts
//
// The store is pure, so the whole event→slice→panel-data chain is asserted
// without a Core, a socket or a DOM: an event in, a bounded, deduped,
// KAI-subject row out; a snapshot in, the tools/MCP/diagnostics/actions slices
// out; counts derived, never invented.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  actionLine,
  applySnapshot,
  applyWorkspaceEvent,
  initialWorkspaceSlice,
  setConnection,
  toolDispatchHint,
  workspaceCounts,
} from "../src/workspace/store.ts";
import { CORE_EVENT_LIMIT } from "../src/core/core-state.ts";
import type { McpSummary, ToolDescription } from "../src/workspace/types.ts";

test("an event becomes a bounded, KAI-subject, worker-demoted row", () => {
  const slice = applyWorkspaceEvent(initialWorkspaceSlice(), {
    id: "e1",
    type: "mission.progress",
    timestamp: "2026-10-05T00:00:00.000Z",
    payload: { id: "m1", title: "step 1" },
  });
  assert.equal(slice.events.length, 1);
  const row = slice.events[0];
  assert.ok(row);
  assert.equal(row.type, "mission.progress");
  assert.equal(row.line, "KAI is working…");
  assert.equal(row.text, "Working: step 1");
  assert.equal(row.at, "2026-10-05T00:00:00.000Z");
});

test("a delegated action demotes the worker and keeps KAI the speaker", () => {
  const slice = applyWorkspaceEvent(initialWorkspaceSlice(), {
    id: "a1",
    type: "action.executed",
    payload: { employeeId: "hermes", toolId: "agents.run_task" },
  });
  const row = slice.events[0];
  assert.ok(row);
  assert.equal(row.worker?.id, "hermes");
  assert.ok(row.line.startsWith("KAI"));
  assert.ok(!row.line.includes("hermes"));
});

test("an event id is deduped — a reconnect replaying a frame shows it once", () => {
  let slice = initialWorkspaceSlice();
  const event = { id: "dup", type: "mission.started", payload: { id: "m1" } };
  slice = applyWorkspaceEvent(slice, event);
  slice = applyWorkspaceEvent(slice, event);
  assert.equal(slice.events.length, 1);
});

test("the event ring is bounded at CORE_EVENT_LIMIT", () => {
  let slice = initialWorkspaceSlice();
  for (let i = 0; i < CORE_EVENT_LIMIT + 5; i += 1) {
    slice = applyWorkspaceEvent(slice, { id: `e${i}`, type: "mission.progress", payload: { id: `m${i}` } });
  }
  assert.equal(slice.events.length, CORE_EVENT_LIMIT);
  // Newest first: the last event added is at the head.
  assert.equal(slice.events[0]?.id, `e${CORE_EVENT_LIMIT + 4}`);
});

test("core.stopped flips the connection to OFFLINE", () => {
  const slice = applyWorkspaceEvent(initialWorkspaceSlice(), { id: "s1", type: "core.stopped" });
  assert.equal(slice.conn, "OFFLINE");
  assert.equal(slice.lastError, "KAI Core stopped");
});

test("a snapshot fills every slice and proves the Core is answering", () => {
  const tools: ToolDescription[] = [
    {
      id: "system.get_status",
      name: "System status",
      description: "Read host status",
      permission: { risk: "READ", effectful: false, sideEffecting: false },
      schema: { declared: true, schema: {} },
    },
    {
      id: "agents.run_task",
      name: "Run a task",
      description: "Hand work to a worker",
      permission: { risk: "EXTERNAL", effectful: true, sideEffecting: true },
      schema: { declared: false, reason: "procedural" },
    },
  ];
  const mcp: McpSummary = {
    capability: { availability: "AVAILABLE", detail: "1 connected" },
    counts: { servers: 1, enabled: 1, connected: 1, tools: 3, resources: 0 },
    servers: [],
    management: { registered: ["mcp.register"], refused: [] },
    persistence: { path: null, problem: null },
    provenanceCount: 2,
  };
  const slice = applySnapshot(setConnection(initialWorkspaceSlice(), "OFFLINE"), {
    tools,
    mcp,
    maintenance: {
      ok: false,
      checkedAt: "2026-10-05T00:00:00.000Z",
      identity: { buildId: "b", gitCommit: "c", protocolVersion: 1, pid: 1, current: true, detail: "" },
      checks: [
        { name: "identity", status: "pass", detail: "" },
        { name: "database", status: "fail", detail: "locked" },
      ],
      repairs: [],
    },
    actions: [{ toolId: "memory.write" }],
    now: 123,
  });
  assert.equal(slice.conn, "ONLINE");
  assert.equal(slice.tools.length, 2);
  assert.equal(slice.mcp?.counts.connected, 1);
  assert.equal(slice.maintenance?.checks.length, 2);
  assert.equal(slice.actions.length, 1);
  assert.equal(slice.lastSyncAt, 123);
});

test("counts are derived from the slices, never invented", () => {
  const slice = applySnapshot(initialWorkspaceSlice(), {
    tools: [
      { id: "a", name: "a", description: "", permission: { risk: "READ", effectful: false, sideEffecting: false }, schema: { declared: false, reason: "" } },
      { id: "b", name: "b", description: "", permission: { risk: "WRITE", effectful: true, sideEffecting: true }, schema: { declared: false, reason: "" } },
    ],
    mcp: {
      capability: { availability: "DEGRADED", detail: "" },
      counts: { servers: 2, enabled: 1, connected: 1, tools: 0, resources: 0 },
      servers: [], management: { registered: [], refused: [] }, persistence: { path: null, problem: null }, provenanceCount: 0,
    },
    maintenance: {
      ok: false, checkedAt: "", identity: { buildId: "b", gitCommit: "c", protocolVersion: 1, pid: 1, current: false, detail: "" },
      checks: [{ name: "x", status: "fail", detail: "" }], repairs: [],
    },
  });
  const counts = workspaceCounts(slice);
  assert.equal(counts.registeredTools, 2);
  assert.equal(counts.sideEffectingTools, 1);
  assert.equal(counts.mcpServers, 2);
  assert.equal(counts.mcpConnected, 1);
  assert.equal(counts.maintenanceFailing, 1);
});

test("toolDispatchHint tells the truth about a READ vs a parked tool", () => {
  const read: ToolDescription = {
    id: "system.get_status", name: "", description: "",
    permission: { risk: "READ", effectful: false, sideEffecting: false }, schema: { declared: false, reason: "" },
  };
  const write: ToolDescription = {
    id: "x", name: "", description: "",
    permission: { risk: "WRITE", effectful: true, sideEffecting: true }, schema: { declared: false, reason: "" },
  };
  assert.match(toolDispatchHint(read), /runs directly/);
  assert.match(toolDispatchHint(write), /parks for approval/);
});

test("actionLine names the tool, the executor and the status", () => {
  const line = actionLine({ action: "memory.write", toolId: "memory.write", employeeId: "hermes", status: "EXECUTED" });
  assert.match(line, /memory\.write/);
  assert.match(line, /via hermes/);
  assert.match(line, /executed/);
});
