// The island's STRUCTURED ATTENTION surface.
//
//   cd app && node --import ./tests/register-ts.mjs --test tests/island-attention.test.ts
//
// Every reason is a pure function of the shared Core mirror; these tests build
// slices with the SAME reducer the app uses (`core-state.ts`) and assert the
// reasons, priorities, offered actions and the demotion of workers.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  attentionLine,
  attentionSummary,
  deriveAttention,
  primaryAttention,
  type AttentionItem,
} from "../src/island/attention.ts";
import {
  applyCoreEvent,
  applySnapshot,
  initialCoreSlice,
  type CoreSlice,
} from "../src/core/core-state.ts";
import type { KaiRuntimeState } from "../src/core/runtime-state.ts";

/** Fold real Core events into a fresh slice. */
function sliceOf(...events: Parameters<typeof applyCoreEvent>[1][]): CoreSlice {
  let s = initialCoreSlice();
  for (const e of events) s = applyCoreEvent(s, e);
  return s;
}

const derive = (core: CoreSlice, runtime: KaiRuntimeState = "IDLE") =>
  deriveAttention({ core, runtime, now: 1_700_000_000_000 });

test("a PENDING approval is a high-priority needs_approval with allow/deny", () => {
  const core = sliceOf({
    id: "a1",
    type: "approval.requested",
    payload: { id: "ap-1", toolId: "shell.run", action: "shell.run", reason: "Run npm test", risk: "EXTERNAL" },
  });
  const items = derive(core);
  const approval = items.find((i) => i.reason === "needs_approval");
  assert.ok(approval, "an approval reason is present");
  assert.equal(approval!.priority, "high");
  assert.equal(approval!.approvalId, "ap-1");
  assert.deepEqual(approval!.actions, ["approve", "reject", "focus"]);
  assert.equal(approval!.focus, "approval");
  assert.equal(approval!.detail, "Run npm test");
});

test("a settled approval is NOT an attention item", () => {
  const core = sliceOf(
    { id: "a1", type: "approval.requested", payload: { id: "ap-1", toolId: "t", action: "t", reason: "", risk: "WRITE" } },
    { id: "a2", type: "approval.approved", payload: { id: "ap-1" } },
  );
  assert.equal(derive(core).some((i) => i.reason === "needs_approval"), false);
});

test("a HIGH recovery_blocked notification is recovery_blocked with a cancel intent", () => {
  const core = sliceOf({
    id: "n1",
    type: "notification.created",
    payload: {
      id: "ntf-1",
      type: "mission.recovery_blocked",
      title: "2 mission(s) need a decision",
      priority: "HIGH",
      read: false,
      createdAt: "2026-10-05T10:00:00.000Z",
    },
  });
  const item = derive(core).find((i) => i.reason === "recovery_blocked");
  assert.ok(item, "recovery_blocked is surfaced");
  assert.equal(item!.priority, "high");
  assert.equal(item!.detail, "2 mission(s) need a decision");
  assert.ok(item!.actions.includes("cancel"), "offers the cancel intent");
  assert.equal(item!.focus, "mission");
  assert.equal(item!.notificationId, "ntf-1");
});

test("runtime RECOVERING surfaces the reason even without a notification row", () => {
  const item = derive(initialCoreSlice(), "RECOVERING").find((i) => i.reason === "recovery_blocked");
  assert.ok(item, "RECOVERING alone is enough");
  assert.equal(item!.source, "runtime.RECOVERING");
});

test("a worker in error is worker_unavailable, named as a DEMOTED detail", () => {
  const core = sliceOf({
    id: "ag1",
    type: "agent.status_changed",
    payload: { id: "hermes", state: "error", detail: "connection refused" },
  });
  const item = derive(core).find((i) => i.reason === "worker_unavailable");
  assert.ok(item);
  assert.equal(item!.worker, "hermes");
  assert.equal(item!.priority, "high", "an error worker is high priority");
  assert.equal(item!.detail, "connection refused");
  // The worker is never the speaker — KAI's sentence is the title.
  assert.equal(item!.title, "A worker KAI drives is unavailable");
  assert.equal(attentionLine(item!), "A worker KAI drives is unavailable · hermes");
});

test("an authentication notification maps to authentication_required", () => {
  const core = sliceOf({
    id: "n2",
    type: "notification.created",
    payload: { id: "ntf-2", type: "auth.required", title: "Hermes key rejected", priority: "HIGH", read: false, createdAt: "2026-10-05T10:00:00.000Z" },
  });
  const item = derive(core).find((i) => i.reason === "authentication_required");
  assert.ok(item, "auth reason surfaced");
  assert.equal(item!.priority, "high");
});

test("a worker-unavailable notification maps to worker_unavailable", () => {
  const core = sliceOf({
    id: "n3",
    type: "notification.created",
    payload: { id: "ntf-3", type: "worker.unavailable", title: "Codex is not installed", priority: "NORMAL", read: false, createdAt: "2026-10-05T10:00:00.000Z" },
  });
  const item = derive(core).find((i) => i.reason === "worker_unavailable");
  assert.ok(item);
  assert.equal(item!.detail, "Codex is not installed");
});

test("the Core being OFFLINE is blocked_external, high priority", () => {
  const core = sliceOf({ id: "e1", type: "core.stopped", payload: {} });
  const item = derive(core).find((i) => i.reason === "blocked_external");
  assert.ok(item);
  assert.equal(item!.priority, "high");
  assert.equal(item!.source, "core.connection.OFFLINE");
});

test("a HIGH notification with no specific type is needs_information", () => {
  const core = sliceOf({
    id: "n4",
    type: "notification.created",
    payload: { id: "ntf-4", type: "something.custom", title: "KAI needs your call", priority: "HIGH", read: false, createdAt: "2026-10-05T10:00:00.000Z" },
  });
  const item = derive(core).find((i) => i.reason === "needs_information");
  assert.ok(item, "a HIGH unmapped notification is KAI raising its hand");
});

test("a READ notification is not attention", () => {
  const core = sliceOf({
    id: "n5",
    type: "notification.created",
    payload: { id: "ntf-5", type: "anything", title: "seen", priority: "CRITICAL", read: true, createdAt: "2026-10-05T10:00:00.000Z" },
  });
  assert.equal(derive(core).length, 0);
});

test("a mission blocked in Core is recovery_blocked with its mission id and cancel", () => {
  const core = sliceOf({
    id: "m1",
    type: "mission.progress",
    payload: { id: "mission-9", title: "Deploy to prod", status: "BLOCKED", message: "awaiting external" },
  });
  const item = derive(core).find((i) => i.missionId === "mission-9");
  assert.ok(item, "a BLOCKED mission is surfaced");
  assert.equal(item!.reason, "recovery_blocked");
  assert.ok(item!.actions.includes("cancel"));
  assert.equal(item!.detail, "Deploy to prod", "the mission title is the honest detail Core carries");
});

test("runtime WAITING with nothing else is needs_information", () => {
  const item = derive(initialCoreSlice(), "WAITING").find((i) => i.reason === "needs_information");
  assert.ok(item);
  assert.equal(item!.source, "runtime.WAITING");
});

test("items are deduped by id, HIGH first, and the summary counts them", () => {
  const core = sliceOf(
    { id: "a1", type: "approval.requested", payload: { id: "ap-1", toolId: "t", action: "t", reason: "r", risk: "WRITE" } },
    { id: "ag1", type: "agent.status_changed", payload: { id: "opencode", state: "offline" } },
  );
  const items = derive(core);
  const ids = items.map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length, "no duplicate ids");
  assert.equal(items[0]!.priority, "high", "a high item leads");
  const sum = attentionSummary(items);
  assert.equal(sum.total, items.length);
  assert.equal(sum.byReason.needs_approval, 1);
  assert.equal(sum.byReason.worker_unavailable, 1);
  assert.ok(sum.high >= 1);
});

test("primaryAttention is the top item, null when nothing needs a human", () => {
  assert.equal(primaryAttention([]), null);
  const core = sliceOf({ id: "a1", type: "approval.requested", payload: { id: "ap-1", toolId: "t", action: "t", reason: "r", risk: "WRITE" } });
  const top: AttentionItem | null = primaryAttention(derive(core));
  assert.ok(top && top.reason === "needs_approval");
});

test("a full snapshot with a pending approval produces the same reason", () => {
  const core = applySnapshot(initialCoreSlice(), {
    approvals: [{ id: "ap-2", toolId: "mcp.x", action: "mcp.call", reason: "call an MCP tool", risk: "EXTERNAL", status: "PENDING" }],
  });
  assert.ok(derive(core).some((i) => i.approvalId === "ap-2"));
});
