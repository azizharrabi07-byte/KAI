// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Part F1 — the scheduler is not a policy bypass.
 *
 * Every scheduled execution goes through the SAME boundary as any other action:
 * the tool registry's validate -> policy -> approval -> execute chain. The test
 * the brief asks for is here: a job configured while the policy allowed it must
 * be refused (parked for approval) once the policy is tightened, because the
 * check happens at FIRE time, not at creation time.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { openSqliteStores } from "../src/storage/sqlite.ts";
import { createPolicyEngine } from "../src/policies/gate.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import { createApprovalService } from "../src/approvals/service.ts";
import { createScheduledJobRunner, type ScheduledJob } from "../src/scheduler/jobs.ts";
import { createScheduler } from "../src/scheduler/scheduler.ts";
import type { ScheduledTask } from "../src/shared/contracts.ts";

const T0 = new Date(2026, 0, 15, 8, 0, 0, 0);
const iso = (d: Date): string => d.toISOString();

function task(id: string, over: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id,
    title: id,
    kind: "interval",
    intervalMs: 3_600_000,
    action: "job.write",
    enabled: true,
    failureCount: 0,
    createdAt: iso(T0),
    updatedAt: iso(T0),
    nextRun: iso(T0),
    ...over,
  };
}

function buildRuntime(rules: Parameters<typeof createPolicyEngine>[0]) {
  const stores = openSqliteStores({ path: ":memory:" });
  const policy = createPolicyEngine(rules);
  const approvals = createApprovalService({ store: stores.approvals });
  const tools = createToolRegistry({ policy, approvals });

  let executions = 0;
  tools.register({
    id: "fs.write",
    name: "Write a file",
    description: "test tool that records an execution",
    risk: "WRITE",
    validate: (input) => ({ ok: true, value: input }),
    execute: async () => {
      executions += 1;
      return { written: true };
    },
  });

  const jobs: ScheduledJob[] = [
    { action: "job.write", toolId: "fs.write", risk: "WRITE", sideEffecting: true },
  ];
  const runner = createScheduledJobRunner({ boundary: tools, jobs });
  const scheduler = createScheduler({
    store: stores.scheduledTasks,
    onFire: (t, ctx) => runner.run(t, ctx),
    describe: (t) => runner.describe(t),
    now: () => T0,
    tickMs: 1_000,
  });

  return { stores, policy, approvals, tools, runner, scheduler, executions: () => executions };
}

test("a job allowed at creation is refused once the policy is tightened (checked at fire time)", async () => {
  const rt = buildRuntime({
    rules: [{ id: "allow-writes", risk: "WRITE", outcome: "allow", tools: ["fs.write"] }],
  });

  // Job configured while WRITE was allowed by an explicit rule.
  rt.stores.scheduledTasks.upsertScheduledTask(task("nightly-backup"));
  await rt.scheduler.reload();
  const first = await rt.scheduler.tick(T0);
  assert.deepEqual(first.fired, ["nightly-backup"]);
  assert.equal(rt.executions(), 1, "the allowed job executed through the boundary");

  // The policy is tightened AFTER the job was created: the explicit rule is gone,
  // so WRITE falls back to needs_approval. The SAME job must no longer run.
  const applied = rt.policy.setRules([]);
  assert.equal(applied.applied, 0);

  const nextRun = rt.stores.scheduledTasks.getScheduledTask("nightly-backup")?.nextRun;
  assert.ok(nextRun);
  const at = new Date(Date.parse(nextRun as string));
  const second = await rt.scheduler.tick(at);

  assert.equal(rt.executions(), 1, "a job whose policy tightened must NOT execute");
  assert.ok(second.parked.includes("nightly-backup"), "it is parked, awaiting an approval");
  assert.equal(rt.scheduler.stateOf("nightly-backup"), "WAITING_APPROVAL");

  // And a real pending approval, bound to the tool, actually exists.
  const pending = rt.stores.approvals.listApprovals({ status: "PENDING" });
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.toolId, "fs.write");

  rt.approvals.dispose();
  rt.stores.close();
});

test("approving the parked job lets it run; the approval is bound to the tool", async () => {
  const rt = buildRuntime({ rules: [] }); // WRITE requires approval from the outset
  rt.stores.scheduledTasks.upsertScheduledTask(task("guarded"));
  await rt.scheduler.reload();

  const parkedRun = await rt.scheduler.tick(T0);
  assert.ok(parkedRun.parked.includes("guarded"));
  assert.equal(rt.executions(), 0);

  const pending = rt.stores.approvals.listApprovals({ status: "PENDING" });
  assert.equal(pending.length, 1);
  const approvalId = pending[0]!.id;
  const decided = rt.approvals.decide(approvalId, true);
  assert.equal(decided.ok, true);

  // Re-run the parked slot WITH the approval: the boundary recognises it and
  // executes. This is the same path a human decision would drive.
  const out = await rt.runner.run(task("guarded"), { approvalId });
  assert.equal(out.status, "completed");
  assert.equal(rt.executions(), 1);

  rt.approvals.dispose();
  rt.stores.close();
});

test("a scheduled job cannot reach a tool through any path other than the registry", async () => {
  const rt = buildRuntime({ rules: [{ id: "allow-all-writes", risk: "WRITE", outcome: "allow" }] });

  // Unknown action: the runner refuses rather than guessing what it means.
  const unknown = await rt.runner.run(task("x", { action: "totally.unknown" }));
  assert.equal(unknown.status, "failed");
  assert.equal(unknown.status === "failed" ? unknown.error.code : "", "NOT_FOUND");
  assert.equal(rt.executions(), 0);
  assert.equal(rt.runner.describe(task("x", { action: "totally.unknown" })).sideEffecting, true);

  // A job pointing at an unregistered tool fails at the boundary, not silently.
  const missing = createScheduledJobRunner({
    boundary: rt.tools,
    jobs: [{ action: "job.ghost", toolId: "fs.nope", risk: "WRITE", sideEffecting: true }],
  });
  const ghost = await missing.run(task("g", { action: "job.ghost" }));
  assert.equal(ghost.status, "failed");
  assert.equal(ghost.status === "failed" ? ghost.error.code : "", "NOT_FOUND");
  assert.equal(rt.executions(), 0);

  rt.approvals.dispose();
  rt.stores.close();
});

test("scheduler + registry: a DESTRUCTIVE job still asks for approval even under a permissive WRITE rule", async () => {
  const stores = openSqliteStores({ path: ":memory:" });
  const policy = createPolicyEngine({
    rules: [{ id: "allow-writes", risk: "WRITE", outcome: "allow" }],
  });
  const approvals = createApprovalService({ store: stores.approvals });
  const tools = createToolRegistry({ policy, approvals });
  let executed = 0;
  tools.register({
    id: "fs.rm",
    name: "Delete a tree",
    description: "destructive test tool",
    risk: "DESTRUCTIVE",
    validate: (i) => ({ ok: true, value: i }),
    execute: async () => {
      executed += 1;
      return { deleted: true };
    },
  });
  const runner = createScheduledJobRunner({
    boundary: tools,
    jobs: [{ action: "job.rm", toolId: "fs.rm", risk: "DESTRUCTIVE", sideEffecting: true }],
  });
  const scheduler = createScheduler({
    store: stores.scheduledTasks,
    onFire: (t, ctx) => runner.run(t, ctx),
    describe: (t) => runner.describe(t),
    now: () => T0,
    tickMs: 1_000,
  });
  stores.scheduledTasks.upsertScheduledTask(task("purge", { action: "job.rm" }));
  await scheduler.reload();
  const result = await scheduler.tick(T0);
  assert.equal(executed, 0, "DESTRUCTIVE never runs without an approval");
  assert.ok(result.parked.includes("purge"));

  approvals.dispose();
  stores.close();
});
