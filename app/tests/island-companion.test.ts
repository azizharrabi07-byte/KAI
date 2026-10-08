// The island's COMPANION ACTIONS — every action executes through Core, and each
// core-mutating action fires exactly ONCE.
//
//   cd app && node --import ./tests/register-ts.mjs --test tests/island-companion.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { createCompanionController, type CompanionCoreClient } from "../src/island/companion.ts";
import type { CoreResult, CoreApprovalSummary, CoreMissionSummary } from "../src/core/kai-core.ts";

/** A fake Core client that records what was dispatched to it. */
function fakeClient() {
  const calls: { approve: [string, boolean][]; cancel: string[] } = { approve: [], cancel: [] };
  let decideImpl: (id: string, approved: boolean) => Promise<CoreResult<CoreApprovalSummary>> = async (id, approved) => {
    calls.approve.push([id, approved]);
    return { ok: true, value: { id, status: approved ? "APPROVED" : "REJECTED" } as unknown as CoreApprovalSummary };
  };
  const client: CompanionCoreClient = {
    decideApproval: (id, approved) => decideImpl(id, approved),
    cancelMission: async (id): Promise<CoreResult<CoreMissionSummary>> => {
      calls.cancel.push(id);
      return { ok: true, value: { id, status: "CANCELLED" } as unknown as CoreMissionSummary };
    },
  };
  return { client, calls, setDecide: (fn: typeof decideImpl) => (decideImpl = fn) };
}

function harness() {
  const { client, calls, setDecide } = fakeClient();
  let refreshed = 0;
  const focused: { target: string; id?: string }[] = [];
  let opened = 0;
  const controller = createCompanionController({
    client,
    refresh: async () => {
      refreshed += 1;
    },
    focuser: {
      openKai: () => {
        opened += 1;
      },
      focus: (target, id) => {
        focused.push(id !== undefined ? { target, id } : { target });
      },
    },
  });
  return { controller, calls, setDecide, focused, stats: () => ({ refreshed, opened }) };
}

test("approve dispatches to Core once and re-reads the shared mirror", async () => {
  const h = harness();
  const out = await h.controller.execute({ action: "approve", targetId: "ap-1" });
  assert.deepEqual(out, { ok: true, executed: true, detail: "KAI recorded your approval." });
  assert.deepEqual(h.calls.approve, [["ap-1", true]]);
  assert.equal(h.stats().refreshed, 1, "the shared mirror was refreshed");
});

test("a second approval of the SAME request does not fire again", async () => {
  const h = harness();
  const first = await h.controller.execute({ action: "approve", targetId: "ap-1" });
  const second = await h.controller.execute({ action: "approve", targetId: "ap-1" });
  assert.equal(first.executed, true);
  assert.equal(second.executed, false, "the repeat is a visible no-op");
  assert.equal(h.calls.approve.length, 1, "Core was decided exactly once");
  assert.equal(h.controller.executedCount, 1);
});

test("a CONCURRENT double-click cannot decide twice (the latch precedes the await)", async () => {
  const h = harness();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  h.setDecide(async (id, approved) => {
    h.calls.approve.push([id, approved]);
    await gate;
    return { ok: true, value: { id, status: "APPROVED" } as unknown as CoreApprovalSummary };
  });
  const p1 = h.controller.execute({ action: "approve", targetId: "ap-9" });
  const p2 = h.controller.execute({ action: "approve", targetId: "ap-9" });
  release();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(h.calls.approve.length, 1, "only one dispatch won the race");
  assert.equal([r1.executed, r2.executed].filter(Boolean).length, 1);
});

test("reject sends approved:false", async () => {
  const h = harness();
  await h.controller.execute({ action: "reject", targetId: "ap-2" });
  assert.deepEqual(h.calls.approve, [["ap-2", false]]);
});

test("approve with no target is refused locally and never reaches Core", async () => {
  const h = harness();
  const out = await h.controller.execute({ action: "approve" });
  assert.equal(out.ok, false);
  assert.equal(out.reason, "MISSING_TARGET");
  assert.equal(h.calls.approve.length, 0);
});

test("cancel goes to Core; a Core REFUSAL is reported, not pre-filtered, and is retryable", async () => {
  // A Core that refuses once (not safe to cancel) then accepts: the island must
  // not decide safety itself, must surface Core's reason, and must allow a retry.
  let attempts = 0;
  const client: CompanionCoreClient = {
    decideApproval: async (id, approved) => ({ ok: true, value: { id, status: approved ? "APPROVED" : "REJECTED" } as unknown as CoreApprovalSummary }),
    cancelMission: async (id) => {
      attempts += 1;
      if (attempts === 1) {
        return { ok: false, error: { code: "REQUEST_FAILED", message: "mission is not cancellable", reason: "NOT_CANCELLABLE" } };
      }
      return { ok: true, value: { id, status: "CANCELLED" } as unknown as CoreMissionSummary };
    },
  };
  const controller = createCompanionController({
    client,
    refresh: async () => undefined,
    focuser: { openKai() {}, focus() {} },
  });
  const refused = await controller.execute({ action: "cancel", targetId: "m-1" });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "NOT_CANCELLABLE", "Core's own reason is surfaced");
  assert.equal(refused.executed, false);
  // A FAILED attempt is not an execution: a genuine retry is allowed.
  const retried = await controller.execute({ action: "cancel", targetId: "m-1" });
  assert.equal(retried.ok, true);
  assert.equal(attempts, 2, "the retry reached Core");
});

test("focus and open are navigation: they call the focuser, not Core, and may repeat", async () => {
  const h = harness();
  await h.controller.execute({ action: "focus", focus: "approval", targetId: "ap-3" });
  await h.controller.execute({ action: "focus", focus: "approval", targetId: "ap-3" });
  await h.controller.execute({ action: "open", focus: "workspace" });
  assert.deepEqual(h.focused, [
    { target: "approval", id: "ap-3" },
    { target: "approval", id: "ap-3" },
    { target: "workspace" },
  ]);
  assert.equal(h.stats().opened, 1);
  assert.equal(h.calls.approve.length + h.calls.cancel.length, 0, "navigation never touches Core mutations");
});

test("a thrown Core call is caught, reported, and left retryable", async () => {
  const h = harness();
  h.setDecide(async () => {
    throw new Error("boom");
  });
  const out = await h.controller.execute({ action: "approve", targetId: "ap-x" });
  assert.equal(out.ok, false);
  assert.equal(out.executed, false);
  assert.equal(h.controller.executedCount, 0);
});
