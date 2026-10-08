// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Policy engine + approval lifecycle tests. Plain `node --test`, no deps.
 * Run from `core/`:  node --test tests/policy.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createPolicyEngine } from "../src/policies/gate.ts";
import type { PolicyRule } from "../src/policies/gate.ts";
import { createApprovalService, DEFAULT_APPROVAL_TTL_MS } from "../src/approvals/service.ts";
import type {
  Approval,
  ApprovalStatus,
  ApprovalStore,
  KaiEventType,
  RiskLevel,
} from "../src/shared/contracts.ts";

/** Hand-written fake — deliberately does NOT import core/src/storage. */
/**
 * Doubles for the approvals an executor talks to.
 *
 * The store shape is what the executor READS through. The service shape
 * (`request`/`list`) is what it CREATES through, because the service is what
 * attaches the deadline — an approval with no `expiresAt` is skipped by the
 * expiry sweep, so it could never expire. Modelling both keeps these tests on
 * the real creation path.
 */
function fakeApprovalStore(): ApprovalStore & {
  rows: Approval[];
  request(input: {
    toolId: string;
    action: string;
    reason: string;
    risk: Approval["risk"];
    missionId?: string;
    stepId?: string;
  }): Approval;
  list(opts?: { status?: ApprovalStatus }): Approval[];
} {
  const rows: Approval[] = [];
  const store = {
    rows,
    createApproval(approval: Approval): void {
      rows.push({ ...approval });
    },
    getApproval(id: string): Approval | null {
      const row = rows.find((entry) => entry.id === id);
      return row === undefined ? null : { ...row };
    },
    listApprovals(opts?: { status?: ApprovalStatus; limit?: number }): Approval[] {
      let out = rows.map((row) => ({ ...row }));
      if (opts?.status !== undefined) out = out.filter((row) => row.status === opts.status);
      if (opts?.limit !== undefined) out = out.slice(0, opts.limit);
      return out;
    },
    decideApproval(id: string, status: ApprovalStatus, decidedAt: string): void {
      const row = rows.find((entry) => entry.id === id);
      if (row !== undefined) {
        row.status = status;
        row.decidedAt = decidedAt;
      }
    },
  };
  return {
    ...store,
    list: (opts) => store.listApprovals(opts),
    request(input) {
      const approval: Approval = {
        id: `ap-${rows.length + 1}`,
        toolId: input.toolId,
        action: input.action,
        reason: input.reason,
        risk: input.risk,
        createdAt: new Date().toISOString(),
        status: "PENDING",
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        ...(input.missionId !== undefined ? { missionId: input.missionId } : {}),
        ...(input.stepId !== undefined ? { stepId: input.stepId } : {}),
      };
      rows.push({ ...approval });
      return { ...approval };
    },
  };
}

interface Published {
  type: KaiEventType;
  payload: unknown;
  opts?: { source?: string; missionId?: string; stepId?: string };
}

function recorder(): { events: Published[]; publish: (t: KaiEventType, p: unknown, o?: Published["opts"]) => void } {
  const events: Published[] = [];
  return {
    events,
    publish: (type, payload, opts) => {
      events.push({ type, payload, opts });
    },
  };
}

const BASE_MS = Date.parse("2026-01-02T03:04:05.000Z");
function clock(): { now: () => Date; advance: (ms: number) => void } {
  let offset = 0;
  return {
    now: () => new Date(BASE_MS + offset),
    advance: (ms: number) => {
      offset += ms;
    },
  };
}

// ── Policy defaults ───────────────────────────────────────────────────────────

test("safe by default: READ allows, everything that touches the world asks first", async () => {
  const gate = createPolicyEngine();

  const expectations: Array<[RiskLevel, "allow" | "needs_approval"]> = [
    ["READ", "allow"],
    ["WRITE", "needs_approval"],
    ["EXTERNAL", "needs_approval"],
    ["DESTRUCTIVE", "needs_approval"],
  ];

  for (const [risk, outcome] of expectations) {
    const decision = await gate.check({ toolId: "demo.tool", action: "demo", risk });
    assert.equal(decision.outcome, outcome, `${risk} must default to ${outcome}`);
    assert.ok(decision.reason.length > 0, `${risk} decision must carry a reason`);
    assert.notEqual(decision.reason, "allowed", "a reason must explain itself, not just say 'allowed'");
    assert.match(decision.reason, /demo\.tool/, "the reason names the tool");
  }
});

test("DESTRUCTIVE is never silently allowed and its reason says so", async () => {
  const gate = createPolicyEngine();
  const decision = await gate.check({ toolId: "fs.delete", action: "delete", risk: "DESTRUCTIVE" });
  assert.equal(decision.outcome, "needs_approval");
  assert.match(decision.reason, /DESTRUCTIVE/);
  assert.match(decision.reason, /never|always/i);
});

test("a rule can override any risk level, and an absent tools list is a blanket rule", async () => {
  const gate = createPolicyEngine({
    rules: [{ id: "wr-general", risk: "WRITE", outcome: "allow" }],
  });

  const write = await gate.check({ toolId: "any.tool", action: "write", risk: "WRITE" });
  assert.equal(write.outcome, "allow");
  assert.match(write.reason, /wr-general/, "the reason cites the rule that decided it");
  assert.match(write.reason, /every WRITE tool/);

  // Overriding one level leaves the others on their defaults.
  const destructive = await gate.check({ toolId: "any.tool", action: "delete", risk: "DESTRUCTIVE" });
  assert.equal(destructive.outcome, "needs_approval");
});

test("a scoped rule applies only to the tools it names", async () => {
  const rules: PolicyRule[] = [
    { id: "write-echo-only", risk: "WRITE", outcome: "allow", tools: ["demo.echo"] },
  ];
  const gate = createPolicyEngine({ rules });

  const named = await gate.check({ toolId: "demo.echo", action: "echo", risk: "WRITE" });
  assert.equal(named.outcome, "allow");
  assert.match(named.reason, /write-echo-only/);

  const other = await gate.check({ toolId: "demo.other", action: "write", risk: "WRITE" });
  assert.equal(other.outcome, "needs_approval", "a scoped allow must not leak to other tools");
});

test("an unscoped deny rule blocks a whole risk level, and the first matching rule wins", async () => {
  const denyAll = createPolicyEngine({
    rules: [{ id: "no-external", risk: "EXTERNAL", outcome: "deny" }],
  });
  const denied = await denyAll.check({ toolId: "any", action: "send", risk: "EXTERNAL" });
  assert.equal(denied.outcome, "deny");
  assert.match(denied.reason, /denies/);

  // Specific rule placed before a general one takes precedence.
  const ordered = createPolicyEngine({
    rules: [
      { id: "allow-read", risk: "READ", outcome: "allow", tools: ["safe.read"] },
      { id: "deny-read", risk: "READ", outcome: "deny" },
    ],
  });
  assert.equal((await ordered.check({ toolId: "safe.read", action: "read", risk: "READ" })).outcome, "allow");
  assert.equal((await ordered.check({ toolId: "other.read", action: "read", risk: "READ" })).outcome, "deny");
});

test("malformed rules are ignored, never trusted to loosen anything", async () => {
  const gate = createPolicyEngine({
    rules: [
      { id: "", risk: "WRITE", outcome: "allow" }, // no id
      { id: "bad-risk", risk: "NOPE" as never, outcome: "allow" }, // unknown risk
      { id: "bad-outcome", risk: "WRITE", outcome: "sure" as never }, // unknown outcome
      { id: "empty-tools", risk: "WRITE", outcome: "allow", tools: [] }, // empty scope
      { id: "good", risk: "WRITE", outcome: "allow", tools: ["demo.write"] },
    ],
  });

  assert.deepEqual(
    gate.rules().map((rule) => rule.id),
    ["good"],
    "only well-formed rules survive normalization",
  );
  const decision = await gate.check({ toolId: "demo.write", action: "write", risk: "WRITE" });
  assert.equal(decision.outcome, "allow");
});

test("an unrecognized risk at runtime is treated as needs_approval, not trusted", async () => {
  const gate = createPolicyEngine();
  const decision = await gate.check({ toolId: "shadow", action: "x", risk: "BOSS" as never });
  assert.equal(decision.outcome, "needs_approval");
  assert.match(decision.reason, /unrecognized risk/);
});

test("rules() returns a defensive copy", () => {
  const gate = createPolicyEngine({ rules: [{ id: "r", risk: "WRITE", outcome: "allow", tools: ["a"] }] });
  const snapshot = gate.rules();
  assert.equal(snapshot.length, 1);
  snapshot[0]!.tools!.push("b");
  snapshot.pop();
  assert.deepEqual(gate.rules()[0]!.tools, ["a"], "mutating the snapshot must not touch the engine");
});

// ── Approval lifecycle ────────────────────────────────────────────────────────

test("request creates a PENDING approval with an expiry and publishes approval.requested", () => {
  const store = fakeApprovalStore();
  const rec = recorder();
  const c = clock();
  const service = createApprovalService({ store, publish: rec.publish, now: c.now, idFactory: () => "ap1" });

  const approval = service.request({
    toolId: "demo.write",
    action: "write",
    reason: "writes need approval",
    risk: "WRITE",
    missionId: "m-1",
  });

  assert.equal(approval.id, "ap1");
  assert.equal(approval.status, "PENDING");
  assert.equal(approval.createdAt, new Date(BASE_MS).toISOString());
  assert.equal(
    approval.expiresAt,
    new Date(BASE_MS + DEFAULT_APPROVAL_TTL_MS).toISOString(),
    "default TTL is documented and applied",
  );
  assert.equal(store.rows.length, 1);

  assert.equal(rec.events.length, 1);
  assert.equal(rec.events[0]!.type, "approval.requested");
  assert.deepEqual(rec.events[0]!.payload, approval);
  assert.equal(rec.events[0]!.opts?.missionId, "m-1");
  assert.equal(rec.events[0]!.opts?.source, "core");
});

test("an explicit ttlMs overrides the default", () => {
  const store = fakeApprovalStore();
  const c = clock();
  const service = createApprovalService({ store, now: c.now, idFactory: () => "ap-x" });
  const approval = service.request({
    toolId: "t",
    action: "a",
    reason: "r",
    risk: "WRITE",
    ttlMs: 1_000,
  });
  assert.equal(approval.expiresAt, new Date(BASE_MS + 1_000).toISOString());
});

test("decide publishes the verdict and a second decide cannot flip it", () => {
  const store = fakeApprovalStore();
  const rec = recorder();
  const c = clock();
  let n = 0;
  const service = createApprovalService({ store, publish: rec.publish, now: c.now, idFactory: () => `ap${++n}` });

  const approval = service.request({ toolId: "demo.write", action: "write", reason: "r", risk: "WRITE" });
  const approved = service.decide(approval.id, true);

  assert.equal(approved.ok, true);
  if (approved.ok) {
    assert.equal(approved.approval.status, "APPROVED");
    assert.equal(approved.approval.decidedAt, new Date(BASE_MS).toISOString());
  }
  assert.equal(rec.events.at(-1)!.type, "approval.approved");

  const second = service.decide(approval.id, false);
  assert.equal(second.ok, false, "deciding twice is reported as a failure");
  if (!second.ok) assert.match(second.reason, /already APPROVED/);
  assert.equal(service.get(approval.id)?.status, "APPROVED", "the verdict must not flip");
  assert.equal(rec.events.filter((event) => event.type === "approval.approved").length, 1);
});

test("a rejected approval records REJECTED and publishes approval.rejected", () => {
  const store = fakeApprovalStore();
  const rec = recorder();
  const service = createApprovalService({ store, publish: rec.publish, idFactory: () => "ap1" });

  const approval = service.request({ toolId: "t", action: "a", reason: "r", risk: "EXTERNAL" });
  const rejected = service.decide(approval.id, false);

  assert.equal(rejected.ok, true);
  assert.equal(service.get(approval.id)?.status, "REJECTED");
  assert.equal(rec.events.at(-1)!.type, "approval.rejected");
});

test("decide on an unknown id fails without touching anything", () => {
  const store = fakeApprovalStore();
  const service = createApprovalService({ store, idFactory: () => "ap1" });
  const result = service.decide("nope", true);
  assert.equal(result.ok, false);
  assert.match(result.reason, /does not exist/);
});

test("expireStale retires only past-due PENDING approvals and returns their ids", () => {
  const store = fakeApprovalStore();
  const c = clock();
  let n = 0;
  const service = createApprovalService({ store, now: c.now, idFactory: () => `ap${++n}` });

  const shortLived = service.request({ toolId: "t", action: "a", reason: "r", risk: "WRITE", ttlMs: 1_000 });
  const longLived = service.request({ toolId: "t", action: "a", reason: "r", risk: "WRITE", ttlMs: 60_000 });

  c.advance(999);
  assert.deepEqual(service.expireStale(), [], "not due yet");

  c.advance(1); // exactly at shortLived's expiry instant: stale
  assert.deepEqual(service.expireStale(), [shortLived.id], "the boundary instant counts as expired");
  assert.equal(service.get(shortLived.id)?.status, "EXPIRED");
  assert.equal(service.get(longLived.id)?.status, "PENDING");

  // Idempotent and it never re-reports.
  assert.deepEqual(service.expireStale(), []);

  // A decided-then-expired id is final: deciding an EXPIRED approval fails.
  const late = service.decide(shortLived.id, true);
  assert.equal(late.ok, false);
  if (!late.ok) assert.match(late.reason, /already EXPIRED/);
});

test("expireStale leaves already-decided approvals alone and an explicit `at` wins over the clock", () => {
  const store = fakeApprovalStore();
  const c = clock();
  let n = 0;
  const service = createApprovalService({ store, now: c.now, idFactory: () => `ap${++n}` });

  const approved = service.request({ toolId: "t", action: "a", reason: "r", risk: "WRITE", ttlMs: 1_000 });
  service.decide(approved.id, true);
  const pending = service.request({ toolId: "t", action: "a", reason: "r", risk: "WRITE", ttlMs: 1_000 });

  const ids = service.expireStale(new Date(BASE_MS + 5_000));
  assert.deepEqual(ids, [pending.id], "APPROVED is never swept");
  assert.equal(service.get(approved.id)?.status, "APPROVED");
});

test("get and list delegate to the store, honouring the status filter", () => {
  const store = fakeApprovalStore();
  let n = 0;
  const service = createApprovalService({ store, idFactory: () => `ap${++n}` });

  const a = service.request({ toolId: "t", action: "a", reason: "r", risk: "WRITE" });
  service.request({ toolId: "t", action: "a", reason: "r", risk: "READ" });
  service.decide(a.id, true);

  assert.equal(service.list().length, 2);
  assert.deepEqual(service.list({ status: "PENDING" }).map((x) => x.id), ["ap2"]);
  assert.deepEqual(service.list({ status: "APPROVED" }).map((x) => x.id), ["ap1"]);
  assert.equal(service.get("missing"), null);
  assert.equal(service.get(a.id)?.id, "ap1");
});

test("default ids stay unique within the same millisecond", () => {
  const store = fakeApprovalStore();
  const service = createApprovalService({ store, now: clock().now });
  const ids = new Set<string>();
  for (let i = 0; i < 5; i += 1) {
    ids.add(service.request({ toolId: "t", action: "a", reason: "r", risk: "WRITE" }).id);
  }
  assert.equal(ids.size, 5);
});

// ── Waiter resolution ─────────────────────────────────────────────────────────
// Expiry must RESOLVE a waiter, not just mark a row: a caller blocked on an
// answer cannot hang past the deadline. These pin each settle path.

test("waitFor resolves with the verdict when the approval is decided", async () => {
  const store = fakeApprovalStore();
  const c = clock();
  const service = createApprovalService({ store, now: c.now, idFactory: () => "ap1" });

  const approval = service.request({ toolId: "t", action: "a", reason: "r", risk: "WRITE" });
  const waiting = service.waitFor(approval.id);

  service.decide(approval.id, true);
  const settled = await waiting;

  assert.equal(settled?.status, "APPROVED");
  assert.equal(settled?.decidedAt, new Date(BASE_MS).toISOString());
});

test("a rejected verdict also releases the waiter", async () => {
  const store = fakeApprovalStore();
  const service = createApprovalService({ store, idFactory: () => "ap1" });

  const approval = service.request({ toolId: "t", action: "a", reason: "r", risk: "WRITE" });
  const waiting = service.waitFor(approval.id);
  service.decide(approval.id, false);

  assert.equal((await waiting)?.status, "REJECTED");
});

test("the expireStale sweep releases a waiter with EXPIRED", async () => {
  const store = fakeApprovalStore();
  const c = clock();
  const service = createApprovalService({ store, now: c.now, idFactory: () => "ap1" });

  const approval = service.request({ toolId: "t", action: "a", reason: "r", risk: "WRITE", ttlMs: 1_000 });
  const waiting = service.waitFor(approval.id);

  c.advance(1_000);
  assert.deepEqual(service.expireStale(), [approval.id]);

  assert.equal((await waiting)?.status, "EXPIRED");
});

test("waitFor answers immediately when already settled, and null for an unknown id", async () => {
  const store = fakeApprovalStore();
  const service = createApprovalService({ store, idFactory: () => "ap1" });

  const approval = service.request({ toolId: "t", action: "a", reason: "r", risk: "WRITE" });
  service.decide(approval.id, true);

  assert.equal((await service.waitFor(approval.id))?.status, "APPROVED");
  assert.equal(await service.waitFor("never-existed"), null);
});
