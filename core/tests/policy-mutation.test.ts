// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Policy mutation surface (Part I) and R4 — a schedule created under policy A is
 * evaluated under the CURRENT policy at fire time, never under authority cached
 * when it was created.
 *
 *   cd core && node --test tests/policy-mutation.test.ts
 *
 * There was no live surface to change policy, so "policy changed between creation
 * and fire" could not be exercised through the product. POST /policy/rules is the
 * smallest one on the EXISTING policy engine (gate.ts): it replaces the caller
 * rules through the SAME tool/policy/approval boundary as every other mutation,
 * and GET /policy reports the live authority. This test proves the surface, its
 * honest classification (a policy change PARKS for a human), and the R4
 * consequence over a real runtime.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCoreRuntime } from "../src/runtime.ts";
import { createCoreApi, type CoreApi } from "../src/api/routes.ts";
import type { PolicyRule } from "../src/policies/gate.ts";

function tempDir(name: string): string {
  return mkdtempSync(join(tmpdir(), `kai-policy-${name}-`));
}

function boot(dbPath: string): ReturnType<typeof createCoreRuntime> {
  return createCoreRuntime({
    dbPath,
    agents: { mode: "mock" },
    startScheduler: false,
    subsystemPaths: { runUpkeepOnStart: false },
  });
}

function get(api: CoreApi, path: string) {
  return api.handle({ method: "GET", path, query: new URLSearchParams() });
}

function post(api: CoreApi, path: string, body: unknown) {
  return api.handle({ method: "POST", path, query: new URLSearchParams(), body });
}

interface PolicyBody {
  applied: number;
  dropped: number;
  reason: string;
  policy: { mode: string; state: unknown; rules: PolicyRule[] };
}

/** Policy A: the scheduled action is allowed. */
const POLICY_A: PolicyRule = {
  id: "allow-mission-create",
  risk: "READ",
  outcome: "allow",
  tools: ["missions.create"],
};

/** Policy B: the SAME action now needs a human. */
const POLICY_B: PolicyRule = {
  id: "guard-mission-create",
  risk: "READ",
  outcome: "needs_approval",
  tools: ["missions.create"],
};

/**
 * Apply a caller rule set through the real route, deciding the human card it
 * demands. A policy change is a security-relevant mutation, so by default it
 * parks; this drives the same park -> decide -> re-issue flow any caller would.
 */
async function applyRules(api: CoreApi, rules: PolicyRule[]): Promise<PolicyBody> {
  const first = await post(api, "/policy/rules", { rules });
  assert.equal(first.status, 409, `a policy change must park: ${JSON.stringify(first.body)}`);
  const approvalId = (first.body as { approvalId: string }).approvalId;
  assert.ok(
    typeof approvalId === "string" && approvalId.length > 0,
    "the parked change hands back the id",
  );
  const decided = await post(api, `/approvals/${approvalId}/decide`, { approved: true });
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
  const applied = await post(api, "/policy/rules", { rules, approvalId });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  return applied.body as PolicyBody;
}

test("GET /policy reports the live authority and creates no approval", async (t) => {
  const dir = tempDir("read");
  const runtime = boot(join(dir, "kai.db"));
  t.after(async () => {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const api = createCoreApi(runtime);

  const res = await get(api, "/policy");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const policy = (res.body as { policy: { mode: string; rules: PolicyRule[] } }).policy;
  assert.equal(policy.mode, "normal");
  assert.ok(Array.isArray(policy.rules));
  assert.ok(
    policy.rules.some((rule) => rule.id === "kai-internal-state"),
    "the baseline internal-state rule is part of the live policy",
  );
  assert.equal(
    runtime.approvals.list({ status: "PENDING" }).length,
    0,
    "a READ route must not create an approval",
  );
});

test("changing policy parks by default and changes nothing until a human approves", async (t) => {
  const dir = tempDir("park");
  const runtime = boot(join(dir, "kai.db"));
  t.after(async () => {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const api = createCoreApi(runtime);

  const before = runtime.policy.rules();
  const res = await post(api, "/policy/rules", { rules: [POLICY_A] });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal((res.body as { approvalRequired: boolean }).approvalRequired, true);
  const approvalId = (res.body as { approvalId: string }).approvalId;
  assert.ok(approvalId.startsWith("apr_"), `the id names a real approval: ${approvalId}`);

  // Nothing changed: a parked security-relevant mutation performs nothing.
  assert.deepEqual(runtime.policy.rules(), before, "the rule set is untouched while parked");

  const pending = runtime.approvals.list({ status: "PENDING" });
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.toolId, "policy.set", "the card is bound to the policy tool");

  // An approval bound to another tool cannot authorise a policy change.
  const other = runtime.approvals.request({
    toolId: "memory.write",
    action: "Write a memory",
    reason: "unrelated",
    risk: "WRITE",
  });
  runtime.approvals.decide(other.id, true);
  const crossed = await post(api, "/policy/rules", { rules: [POLICY_A], approvalId: other.id });
  assert.equal(crossed.status, 403, JSON.stringify(crossed.body));
  assert.match((crossed.body as { reason: string }).reason, /does not authorise/);
  assert.deepEqual(runtime.policy.rules(), before, "a mismatched approval changed nothing");
});

test("an approved change applies the caller rules; malformed rules are dropped toward the safe default", async (t) => {
  const dir = tempDir("apply");
  const runtime = boot(join(dir, "kai.db"));
  t.after(async () => {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const api = createCoreApi(runtime);

  const body = await applyRules(api, [
    { id: "bad-rule", risk: "WRITE", outcome: "nonsense" as unknown as PolicyRule["outcome"] },
    { id: "allow-memory", risk: "WRITE", outcome: "allow", tools: ["memory.write"] },
  ]);

  assert.equal(body.applied, 1, "only the well-formed caller rule applied");
  assert.equal(body.dropped, 1, "the malformed rule was dropped, not trusted");
  assert.ok(body.policy.rules.some((rule) => rule.id === "allow-memory"));
  assert.ok(!body.policy.rules.some((rule) => rule.id === "bad-rule"));
  assert.ok(
    body.policy.rules.some((rule) => rule.id === "kai-internal-state"),
    "KAI's baseline remains in force so it can still be operated",
  );

  // GET agrees with the mutation's response: the live engine is what changed.
  const live = await get(api, "/policy");
  const liveRules = (live.body as { policy: { rules: PolicyRule[] } }).policy.rules;
  assert.ok(liveRules.some((rule) => rule.id === "allow-memory"));

  // A rejected body is a rich 400, not a silent no-op.
  const badBody = await post(api, "/policy/rules", { rules: "not-an-array" });
  assert.equal(badBody.status, 400, JSON.stringify(badBody.body));
  assert.match((badBody.body as { reason: string }).reason, /"rules" must be an array/);
});

test("R4: a schedule created under policy A is evaluated under policy B at fire time", async (t) => {
  const dir = tempDir("r4");
  const runtime = boot(join(dir, "kai.db"));
  t.after(async () => {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const api = createCoreApi(runtime);

  // ── Policy A is in force: the scheduled action is allowed. ──────────────────
  const appliedA = await applyRules(api, [POLICY_A]);
  assert.equal(
    appliedA.policy.rules.find((rule) => rule.id === "allow-mission-create")?.outcome,
    "allow",
  );

  // ── The schedule is created WHILE A IS IN FORCE. ────────────────────────────
  const created = await post(api, "/schedules", {
    title: "R4 policy-change probe",
    kind: "interval",
    intervalMs: 60_000,
    action: "mission.create",
    payload: { title: "r4 scheduled mission" },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const schedule = (created.body as { schedule: { id: string; nextRun: string } }).schedule;
  const scheduleId = schedule.id;
  const firstRun = schedule.nextRun;
  assert.ok(typeof firstRun === "string" && firstRun.length > 0);

  // ── First fire, still under A: the action runs. ─────────────────────────────
  const missionsBefore = runtime.stores.missions.listMissions().length;
  const fireA = await runtime.scheduler.tick(new Date(firstRun));
  assert.ok(fireA.fired.includes(scheduleId), `under A the fire executes: ${JSON.stringify(fireA)}`);
  assert.equal(
    runtime.stores.missions.listMissions().length,
    missionsBefore + 1,
    "A's fire created the mission",
  );

  // ── Policy B is now in force. The SCHEDULE is untouched; only the policy moved.
  await applyRules(api, [POLICY_B]);

  // Capture the boundary's decision for the next occurrence.
  const records: Array<{
    toolId: string;
    resultState: string;
    decisionSource: string;
    scheduleId?: string;
  }> = [];
  const off = runtime.bus.subscribe((event) => {
    if (event.type === "action.executed") {
      records.push(event.payload as (typeof records)[number]);
    }
  });

  const nextRun = runtime.stores.scheduledTasks.getScheduledTask(scheduleId)?.nextRun;
  assert.ok(typeof nextRun === "string" && nextRun.length > 0, "the schedule advanced to its next slot");
  const fireB = await runtime.scheduler.tick(new Date(nextRun as string));

  // ── The fire was evaluated under B: it PARKED with a real pending approval. ──
  assert.ok(fireB.parked.includes(scheduleId), `under B the same schedule parks: ${JSON.stringify(fireB)}`);
  assert.ok(!fireB.fired.includes(scheduleId), "under B the same schedule must NOT execute");
  assert.equal(runtime.scheduler.stateOf(scheduleId), "WAITING_APPROVAL");
  assert.equal(
    runtime.stores.missions.listMissions().length,
    missionsBefore + 1,
    "B's fire created NO new mission",
  );

  const card = runtime.approvals
    .list({ status: "PENDING" })
    .find((approval) => approval.toolId === "missions.create");
  assert.ok(card, "a real pending approval exists for the tool the job uses");
  assert.match(
    card!.reason,
    /guard-mission-create/,
    "the approval reason names the rule in force at FIRE time",
  );

  // ── The decision names the CURRENT authority, not creation-time state. ──────
  const fireRecord = records.find(
    (record) => record.toolId === "missions.create" && record.resultState === "APPROVAL_REQUIRED",
  );
  assert.ok(fireRecord, `the fire produced an action record: ${JSON.stringify(records)}`);
  assert.equal(
    fireRecord.decisionSource,
    "rule:guard-mission-create",
    "the decision source is policy B's rule, evaluated at fire time",
  );
  assert.equal(fireRecord.scheduleId, scheduleId, "the record names the schedule that fired");

  off();
});
