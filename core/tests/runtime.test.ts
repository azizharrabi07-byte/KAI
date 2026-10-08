/**
 * End-to-end tests for the composition root.
 *
 * These are the tests that decide whether KAI Core is a real runtime or just nine
 * modules that pass their own unit tests. They boot the whole Core against a real
 * SQLite file in a temp directory, with mock agents so nothing touches the network,
 * and they assert on observed behaviour: a mission that runs, a step that is
 * refused, an approval that parks work, a scheduled task that fires, and state that
 * is still there after the process it belonged to has stopped.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCoreRuntime } from "../src/runtime.ts";
import { createMission } from "../src/missions/mission.ts";
import type { KaiEvent, Mission } from "../src/shared/contracts.ts";

function tempDb(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `kai-runtime-${name}-`));
  return join(dir, "kai-core.db");
}

/** Boots a Core with mock agents and the scheduler driven manually. */
function boot(dbPath: string, extra: Record<string, unknown> = {}) {
  const rt = createCoreRuntime({
    dbPath,
    agents: { mode: "mock" },
    startScheduler: false, // tests drive tick() instead of waiting on a timer
    ...extra,
  });
  return rt;
}

test("the Core boots, connects its agents and reports health derived from live calls", async () => {
  const dbPath = tempDb("boot");
  const rt = boot(dbPath);
  try {
    const started = await rt.start();

    assert.equal(Object.keys(started.agents).length, 2, "both agents were attempted");
    assert.ok(
      Object.values(started.agents).every((connected) => connected === true),
      `mocked agents connect: ${JSON.stringify(started.agents)}`,
    );

    const health = await rt.health();
    assert.equal(health.ok, true);
    assert.equal(health.database.path, dbPath);
    assert.equal(health.agents.length, 2);
    assert.ok(health.tools.registered >= 4, `builtin tools registered: ${health.tools.registered}`);
    assert.equal(health.scheduler.running, false, "the scheduler was deliberately not started");
    assert.equal(health.missions.unfinished, 0);

    // A real file, not an in-memory database: persistence is the point.
    assert.ok(existsSync(dbPath));
  } finally {
    await rt.stop();
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  }
});

// Phase 1 §6 changed this test's meaning on purpose. Handing work to a worker is
// now governed by the SAME boundary as everything else (`agents.run_task`, risk
// EXTERNAL), so an agent step needs explicit authorisation where it previously ran
// unasked. The rule below is that authorisation; with it, the mission still runs
// end to end, which is what the original test was protecting.
test("a mission runs a read tool step and an agent step through to COMPLETED", async () => {
  const dbPath = tempDb("mission");
  const rt = boot(dbPath, {
    policyRules: [{ id: "allow-worker-tool", risk: "EXTERNAL", outcome: "allow", tools: ["agents.run_task"] }],
  });
  const seen: KaiEvent[] = [];
  const unsubscribe = rt.bus.subscribe((event) => seen.push(event));
  try {
    await rt.start();

    const mission = await rt.createAndStartMission({
      title: "inspect this machine and ask Hermes about it",
      steps: [
        { title: "read core status", kind: "tool", target: "system.get_status" },
        { title: "ask hermes", kind: "agent", target: "hermes", input: { input: "report status" } },
      ],
    });

    assert.equal(mission.status, "COMPLETED", `mission ended ${mission.status}`);
    assert.equal(mission.steps.length, 2);
    assert.ok(
      mission.steps.every((step) => step.status === "COMPLETED"),
      `step statuses: ${mission.steps.map((s) => `${s.index}:${s.status}`).join(", ")}`,
    );

    // The tool step's output is the real tool result, not a placeholder.
    const status = mission.steps[0]?.output ?? {};
    assert.ok(
      typeof status.platform === "string" || typeof status.status === "string" || Object.keys(status).length > 0,
      `tool step produced output: ${JSON.stringify(status).slice(0, 200)}`,
    );

    const types = seen.map((event) => event.type);
    for (const expected of ["mission.created", "mission.started", "mission.completed"]) {
      assert.ok(types.includes(expected as KaiEvent["type"]), `saw ${expected} (got ${types.join(", ")})`);
    }
    // Progress events must carry the mission correlation, or the UI cannot attribute them.
    const progress = seen.filter((event) => event.type === "mission.progress");
    assert.ok(progress.length >= 2, `one progress event per step (got ${progress.length})`);
    assert.ok(progress.every((event) => event.missionId === mission.id));

    // And it is genuinely persisted, not only in memory.
    assert.equal(rt.stores.missions.getMission(mission.id)?.status, "COMPLETED");
  } finally {
    unsubscribe();
    await rt.stop();
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  }
});

test("a step whose tool needs approval parks the mission and does NOT execute it", async () => {
  const dbPath = tempDb("approval");
  const rt = boot(dbPath);
  try {
    await rt.start();

    let executed = false;
    rt.tools.register({
      id: "test.publish_thing",
      name: "Publish a thing",
      description: "Test double: stands in for a tool with an external side effect.",
      risk: "EXTERNAL",
      validate: (input) => ({ ok: true, value: input }),
      execute: async () => {
        executed = true;
        return { published: true };
      },
    });

    const mission = await rt.createAndStartMission({
      title: "publish something",
      steps: [{ title: "publish", kind: "tool", target: "test.publish_thing", sideEffecting: true }],
    });

    assert.equal(mission.status, "WAITING_APPROVAL", `mission ended ${mission.status}`);
    assert.equal(executed, false, "the tool must not run before a human approves");

    const pending = rt.approvals.list({ status: "PENDING" });
    assert.equal(pending.length, 1, "exactly one approval was requested");
    assert.equal(pending[0]?.toolId, "test.publish_thing");
    assert.equal(pending[0]?.missionId, mission.id);

    // And the UI would see it: pending approvals are part of health.
    assert.equal((await rt.health()).approvals.pending, 1);
  } finally {
    await rt.stop();
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  }
});

test("a deny policy fails the step before the tool runs, with the reason recorded", async () => {
  const dbPath = tempDb("deny");
  const rt = boot(dbPath, {
    policyRules: [{ id: "deny-reads", risk: "READ", outcome: "deny" }],
  });
  try {
    await rt.start();

    let executed = false;
    rt.tools.register({
      id: "test.read_thing",
      name: "Read a thing",
      description: "Test double whose declared risk is READ.",
      risk: "READ",
      validate: () => ({ ok: true, value: {} }),
      execute: async () => {
        executed = true;
        return { ok: true };
      },
    });

    const mission = await rt.createAndStartMission({
      title: "blocked by policy",
      steps: [{ title: "read", kind: "tool", target: "test.read_thing" }],
    });

    assert.equal(mission.status, "FAILED", `mission ended ${mission.status}`);
    assert.equal(executed, false, "a denied tool must never execute");
    assert.equal(mission.steps[0]?.error?.code, "POLICY_DENIED");
    assert.ok((mission.steps[0]?.error?.message ?? "").length > 0, "the refusal explains itself");
  } finally {
    await rt.stop();
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  }
});

// Test 5's original tick landed 60s past the slot. The scheduler's grace window
// is one tick (DEFAULT_TICK_MS = 30s), so that occurrence was genuinely MISSED —
// and because the `mission.create` job is now `sideEffecting: true`, a missed
// occurrence correctly PARKS rather than being replayed. That is explanation (a):
// the old expectation ("it ran") was stale for the scenario the test built.
//
// So the expectation is changed deliberately. A missed side-effecting occurrence
// parks and creates NOTHING. The "fires, creates a mission and runs it" coverage
// is not dropped — it is moved to the companion test below, which drives the DUE
// (not-missed) path the real timer produces.
test("a MISSED side-effecting scheduled task PARKS instead of starting a second mission", async () => {
  const dbPath = tempDb("schedule");
  const rt = boot(dbPath);
  try {
    await rt.start();

    // A once-task scheduled for the future.
    const dueAt = new Date(Date.now() + 60_000).toISOString();
    rt.stores.scheduledTasks.upsertScheduledTask({
      id: "task-1",
      title: "hourly machine check",
      kind: "once",
      runAt: dueAt,
      action: "mission.create",
      payload: { title: "scheduled machine check" },
      enabled: true,
      failureCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await rt.scheduler.reload();

    // Not due yet: the scheduler must not fire early.
    assert.deepEqual((await rt.scheduler.tick(new Date())).fired, [], "nothing fires before it is due");

    // The clock is now 60s past the slot — beyond the 30s grace window — so this
    // is a MISSED occurrence. A missed side-effecting job parks; it does not run.
    const ticked = await rt.scheduler.tick(new Date(Date.now() + 120_000));
    assert.deepEqual(ticked.fired, [], "a missed side-effecting occurrence must not fire");
    assert.deepEqual(ticked.parked, ["task-1"], "it is parked, awaiting an answer");
    assert.equal(rt.scheduler.stateOf("task-1"), "WAITING_APPROVAL");

    // Nothing was created: the duplicate this rule exists to prevent did not happen.
    assert.equal(rt.stores.missions.listMissions().length, 0, "no mission was created");
  } finally {
    await rt.stop();
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  }
});

// The DUE path: an occurrence evaluated within the grace window (which is what a
// running timer produces — tick() fires within one tickMs of the slot) fires and
// runs its mission. This is the coverage the test above used to carry.
test("a due scheduled task fires, creates a mission and runs it — through the timer path", async () => {
  const dbPath = tempDb("schedule-due");
  const rt = boot(dbPath);
  try {
    await rt.start();

    const dueMs = Date.now() + 60_000;
    rt.stores.scheduledTasks.upsertScheduledTask({
      id: "task-1",
      title: "hourly machine check",
      kind: "once",
      runAt: new Date(dueMs).toISOString(),
      action: "mission.create",
      payload: { title: "scheduled machine check" },
      enabled: true,
      failureCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await rt.scheduler.reload();

    // Not due yet: the scheduler must not fire early.
    assert.deepEqual((await rt.scheduler.tick(new Date())).fired, [], "nothing fires before it is due");

    // One tick interval (30s) past the slot is within grace: a real timer would
    // have ticked here. The task is due, not missed, so it runs.
    const ticked = await rt.scheduler.tick(new Date(dueMs + 1_000));
    assert.deepEqual(ticked.fired, ["task-1"], "the due task fired exactly once");

    // The fire handler really ran a mission; it did not merely log a line.
    const missions = rt.stores.missions.listMissions();
    assert.equal(missions.length, 1, `missions after the tick: ${missions.length}`);
    assert.equal(missions[0]?.status, "COMPLETED");
    assert.equal(missions[0]?.title, "scheduled machine check");

    // A once-task must not fire again.
    const second = await rt.scheduler.tick(new Date(dueMs + 180_000));
    assert.deepEqual(second.fired, []);
    assert.equal(rt.stores.missions.listMissions().length, 1);
  } finally {
    await rt.stop();
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  }
});

test("state survives a restart, and recovery resumes only what is safe", async () => {
  const dbPath = tempDb("restart");
  let dangerousId = "";

  // ── first process ────────────────────────────────────────────────────────────
  const first = boot(dbPath);
  try {
    await first.start();

    first.stores.memory.createMemory({
      id: "mem-1",
      type: "project_fact",
      content: "KAI Core persists across restarts.",
      source: "system_state",
      importance: 4,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    first.stores.scheduledTasks.upsertScheduledTask({
      id: "task-interval",
      title: "check the machine",
      kind: "interval",
      intervalMs: 60_000,
      action: "mission.create",
      payload: { title: "interval check" },
      enabled: true,
      failureCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    first.notifications.notify({
      type: "test.note",
      title: "a notification that must outlive the process",
      priority: "HIGH",
    });

    // An interrupted mission whose next step touches the world: never auto-resumed.
    const dangerous = createMission({
      title: "interrupted while publishing",
      steps: [
        { title: "already done", kind: "tool", target: "system.get_status" },
        { title: "would publish", kind: "tool", target: "system.get_status", sideEffecting: true },
      ],
    });
    dangerous.status = "RUNNING";
    const firstStep = dangerous.steps[0];
    if (firstStep) firstStep.status = "COMPLETED";
    first.stores.missions.upsertMission(dangerous);
    dangerousId = dangerous.id;

    // An interrupted mission with only safe work left: this one may be resumed.
    const safe = createMission({
      title: "interrupted with safe work left",
      steps: [
        { title: "already done", kind: "tool", target: "system.get_status" },
        { title: "safe read", kind: "tool", target: "system.get_status" },
      ],
    });
    safe.status = "RUNNING";
    const safeFirst = safe.steps[0];
    if (safeFirst) safeFirst.status = "COMPLETED";
    first.stores.missions.upsertMission(safe);

    first.bus.publish("notification.created", { probe: true });
    await first.stop();
  } finally {
    // stop() already ran; a second stop must be safe.
    await first.stop();
  }

  // ── second process, same database ───────────────────────────────────────────
  const second = boot(dbPath);
  try {
    const started = await second.start();

    assert.ok(
      started.recovered.blocked.includes(dangerousId),
      `the side-effecting mission was blocked: ${JSON.stringify(started.recovered)}`,
    );

    const memories = second.stores.memory.listMemories();
    assert.equal(memories.length, 1, "the memory survived the restart");
    assert.equal(memories[0]?.content, "KAI Core persists across restarts.");

    const tasks = second.stores.scheduledTasks.listScheduledTasks();
    assert.equal(tasks.length, 1, "the scheduled task survived");
    assert.ok((tasks[0]?.nextRun ?? "").length > 0, "the scheduler recomputed nextRun on reload");

    // Notifications persisted too. Note the count is 2, not 1: recovery raised its
    // own HIGH notification about the mission it refused to resume, which is exactly
    // the behaviour we want — so assert on identity, not on the count.
    const unread = second.notifications.list({ unreadOnly: true });
    const survived = unread.find((n) => n.title === "a notification that must outlive the process");
    assert.ok(survived, `the unread notification survived: ${JSON.stringify(unread.map((n) => n.title))}`);
    assert.equal(survived?.priority, "HIGH");
    assert.ok(
      unread.some((n) => n.type === "mission.recovery_blocked" && n.priority === "HIGH"),
      "recovery told the user that a mission needs a decision",
    );

    // The blocked mission was parked, not silently resumed or lost.
    const blocked = second.stores.missions.listMissions().find((m: Mission) => m.title === "interrupted while publishing");
    assert.ok(blocked, "the blocked mission is still present");
    assert.equal(blocked?.status, "WAITING", `blocked mission parked as ${blocked?.status}`);
    const blockedStep = blocked?.steps[1];
    assert.equal(blockedStep?.status, "PENDING", "the side-effecting step was not run");

    // The safe one completed because every remaining step was safe.
    const resumed = second.stores.missions.listMissions().find((m: Mission) => m.title === "interrupted with safe work left");
    assert.equal(resumed?.status, "COMPLETED", `safe mission settled as ${resumed?.status}`);

    // Events written before the restart are readable afterwards.
    const events = second.stores.events.listEvents({ limit: 50 });
    assert.ok(events.length >= 1, "persisted events survived the restart");

    // Reopening must not duplicate anything.
    assert.equal(second.stores.memory.listMemories().length, 1);
    assert.equal(second.stores.scheduledTasks.listScheduledTasks().length, 1);
  } finally {
    await second.stop();
    await second.stop(); // idempotent
    assert.equal(second.scheduler.isRunning(), false, "the scheduler is not left running");
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  }
});

// ── Part H: a decision must SETTLE the work waiting on it ──────────────────────
//
// The tests below exist because "the approval was marked" and "the mission was
// told" are different things, and only the second one is the requirement. A
// parked mission that outlives its decision is a mission parked forever.

test("approving the approval resumes the parked mission and runs the step exactly once", async () => {
  const dbPath = tempDb("resume-approve");
  const rt = boot(dbPath);
  try {
    await rt.start();

    let runs = 0;
    rt.tools.register({
      id: "test.publish_once",
      name: "Publish once",
      description: "Test double: counts how many times the side effect actually happened.",
      risk: "EXTERNAL",
      validate: (input) => ({ ok: true, value: input }),
      execute: async () => {
        runs += 1;
        return { published: true, run: runs };
      },
    });

    const mission = await rt.createAndStartMission({
      title: "publish once",
      steps: [{ title: "publish", kind: "tool", target: "test.publish_once", sideEffecting: true }],
    });
    assert.equal(mission.status, "WAITING_APPROVAL");
    assert.equal(runs, 0, "nothing runs before the decision");

    const approvalId = rt.approvals.list({ status: "PENDING" })[0]!.id;

    // The one call the API route makes. Decision AND settlement.
    const settled = await rt.decideApproval(approvalId, true);
    assert.equal(settled.approved, true);
    assert.equal(settled.missionId, mission.id, "the decision reports which mission it settled");
    assert.equal(settled.resumed, true);

    const after = rt.stores.missions.getMission(mission.id);
    assert.equal(after?.status, "COMPLETED", `mission ended ${after?.status}`);
    assert.equal(runs, 1, "the approved step ran exactly once");

    // Deciding again must not double-execute: the mission is no longer parked.
    const again = await rt.decideApproval(approvalId, true);
    assert.equal(runs, 1, "a second decision must not re-run the side effect");
    assert.equal(again.resumed, false, "a settled mission is not resumed twice");
  } finally {
    await rt.stop();
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  }
});

test("rejecting the approval fails the parked mission with a reason, and the step never runs", async () => {
  const dbPath = tempDb("resume-reject");
  const rt = boot(dbPath);
  try {
    await rt.start();

    let runs = 0;
    rt.tools.register({
      id: "test.publish_rejected",
      name: "Publish (rejected)",
      description: "Test double for a refused side effect.",
      risk: "EXTERNAL",
      validate: (input) => ({ ok: true, value: input }),
      execute: async () => {
        runs += 1;
        return { published: true };
      },
    });

    const mission = await rt.createAndStartMission({
      title: "publish rejected",
      steps: [{ title: "publish", kind: "tool", target: "test.publish_rejected", sideEffecting: true }],
    });
    const approvalId = rt.approvals.list({ status: "PENDING" })[0]!.id;

    const settled = await rt.decideApproval(approvalId, false);
    assert.equal(settled.resumed, true, "a rejection is also a terminal outcome");

    const after = rt.stores.missions.getMission(mission.id);
    assert.equal(after?.status, "FAILED", `mission ended ${after?.status}`);
    assert.equal(runs, 0, "a rejected action must never run");
    // A machine-readable reason, not just a status.
    assert.ok(after?.error, "the failure must carry an error value");
    assert.equal(after?.error?.code, "POLICY_DENIED");
  } finally {
    await rt.stop();
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  }
});

test("a decision recorded before a restart still settles the mission after it", async () => {
  const dbPath = tempDb("resume-restart");

  // First boot: park the mission, then die with it still parked.
  const first = boot(dbPath);
  let missionId = "";
  let approvalId = "";
  try {
    await first.start();
    first.tools.register({
      id: "test.publish_restart",
      name: "Publish (restart)",
      description: "Test double for a side effect that must survive a restart.",
      risk: "EXTERNAL",
      validate: (input) => ({ ok: true, value: input }),
      execute: async () => ({ published: true }),
    });
    const mission = await first.createAndStartMission({
      title: "survives a restart",
      steps: [{ title: "publish", kind: "tool", target: "test.publish_restart", sideEffecting: true }],
    });
    missionId = mission.id;
    approvalId = first.approvals.list({ status: "PENDING" })[0]!.id;
    assert.equal(mission.status, "WAITING_APPROVAL");
  } finally {
    await first.stop();
  }

  // Second boot on the SAME database: the mission is still parked, and the
  // recorded decision must still be able to settle it.
  const second = boot(dbPath);
  try {
    await second.start();
    const parked = second.stores.missions.getMission(missionId);
    assert.equal(parked?.status, "WAITING_APPROVAL", "the parked mission outlived the process");

    const settled = await second.decideApproval(approvalId, false);
    assert.equal(settled.resumed, true, "the stored decision settles the mission after a restart");
    const after = second.stores.missions.getMission(missionId);
    assert.notEqual(after?.status, "WAITING_APPROVAL", "it must not stay parked forever");
  } finally {
    await second.stop();
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  }
});

test("an approval that expired while Core was down is settled on restart, not left parked", async () => {
  const dbPath = tempDb("resume-expired");
  // A real, short TTL: expiry is driven by a check that runs, so the test drives
  // real time rather than pretending a deadline passed.
  const TTL_MS = 60;

  const first = boot(dbPath, { approvalTtlMs: TTL_MS });
  let missionId = "";
  let runs = 0;
  try {
    await first.start();
    first.tools.register({
      id: "test.publish_expired",
      name: "Publish (expires)",
      description: "Test double for a side effect whose approval times out.",
      risk: "EXTERNAL",
      validate: (input) => ({ ok: true, value: input }),
      execute: async () => {
        runs += 1;
        return { published: true };
      },
    });
    const mission = await first.createAndStartMission({
      title: "expires while down",
      steps: [{ title: "publish", kind: "tool", target: "test.publish_expired", sideEffecting: true }],
    });
    missionId = mission.id;
    assert.equal(mission.status, "WAITING_APPROVAL");

    const approval = first.approvals.list({ status: "PENDING" })[0]!;
    assert.ok(approval.expiresAt, "a pending approval carries its deadline");
  } finally {
    await first.stop();
  }

  // Core is down across the deadline. Nothing is running, so no timer exists for
  // this row: the row is still PENDING on disk and the mission is still parked.
  await new Promise((resolve) => setTimeout(resolve, TTL_MS + 120));

  const second = boot(dbPath, { approvalTtlMs: TTL_MS });
  try {
    await second.start();

    // The deadline was honoured on startup, so the mission is settled rather than
    // stranded: a parked mission with no live question would be parked forever.
    const after = second.stores.missions.getMission(missionId);
    assert.notEqual(after?.status, "WAITING_APPROVAL", "it must not stay parked forever");
    assert.equal(after?.status, "FAILED", `mission ended ${after?.status}`);
    assert.equal(after?.error?.code, "POLICY_DENIED", "an expired approval is a refusal");
    assert.equal(runs, 0, "an expired approval must never run the step");

    const approval = second.approvals.list()[0];
    assert.equal(approval?.status, "EXPIRED", "the row is retired, not left pending");
  } finally {
    await second.stop();
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  }
});

// ── Part 6: ONE authoritative worker execution path ───────────────────────────
//
// This test DISCRIMINATES between the two implementations, which is why it is
// worth having. It sets a deny rule naming the tool `agents.run_task`.
//
//   * through the tool boundary (now): the rule matches, the step is denied, the
//     mission FAILS with POLICY_DENIED.
//   * through a direct `adapter.runTask` call (before): the rule would not match —
//     the step-level check uses the AGENT id, not the tool id — so the step would
//     have parked for approval instead, and the worker would have run once a human
//     said yes.
//
// So a passing assertion here is evidence that no alternate direct-execution route
// remains, not merely that the mission did something plausible.
test("a mission agent step is governed by the worker tool's policy, not a side door", async () => {
  const dbPath = tempDb("worker-path");
  const rt = boot(dbPath, {
    policyRules: [
      { id: "deny-worker-tool", risk: "EXTERNAL", outcome: "deny", tools: ["agents.run_task"] },
    ],
  });
  try {
    await rt.start();
    assert.ok(rt.tools.get("agents.run_task"), "the worker tool is registered");

    const mission = await rt.createAndStartMission({
      title: "ask a worker",
      // Deliberately NOT side-effecting: that keeps the step-level check out of
      // the way so the assertion below is about the WORKER TOOL boundary and
      // nothing else.
      steps: [{ title: "ask hermes", kind: "agent", target: "hermes" }],
    });

    assert.equal(mission.status, "FAILED", `mission ended ${mission.status}`);
    assert.equal(mission.error?.code, "POLICY_DENIED");
    assert.match(mission.error?.message ?? "", /agents\.run_task/);
  } finally {
    await rt.stop();
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  }
});

test("the live Core exposes exactly one workforce and one capability manager", async () => {
  const dbPath = tempDb("managers");
  const rt = boot(dbPath);
  try {
    await rt.start();

    // Employees: the two that work, plus Codex registered as known-but-unavailable.
    const employees = rt.workforce.describe();
    const ids = employees.map((e) => e.id).sort();
    assert.deepEqual(ids, ["codex", "hermes", "opencode"], `employees: ${JSON.stringify(ids)}`);
    const codex = employees.find((e) => e.id === "codex");
    assert.notEqual(codex?.state, "READY", "Codex is not installed, so it must not read as ready");

    // Capabilities: KAI's own is genuinely available; the disconnected ones are
    // registered but honest.
    const caps = rt.capabilities.registry.list().map((c) => c.id).sort();
    for (const expected of ["browser", "computer", "filesystem", "git", "mcp", "shell", "system"]) {
      assert.ok(caps.includes(expected), `capability "${expected}" must be registered`);
    }
    // Read the DECLARED status, not a probe. Probing here would connect the real
    // CUA driver and launch a headless browser inside a unit test — which made the
    // suite slow and environment-dependent, and is not what this test is about.
    const declared = (id: string) => rt.capabilities.registry.status(id)?.availability;
    assert.equal(declared("system"), "AVAILABLE", "KAI's own capability really works");
    for (const external of ["browser", "computer", "mcp"]) {
      assert.equal(
        declared(external),
        "UNAVAILABLE",
        `"${external}" is not connected until asked, so it must not claim AVAILABLE`,
      );
    }

    // Employee <-> capability is live, not documentation.
    assert.ok(
      rt.capabilities.employeesDeclaring("git").length > 0,
      "some employee declares git",
    );
  } finally {
    await rt.stop();
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  }
});

// ── Action observability ──────────────────────────────────────────────────────
//
// The record must be produced by the PRODUCTION path — the bus the runtime already
// owns — not by a serializer called directly from a test. These subscribe to the
// real bus and read what the real registry emitted.

interface SeenRecord {
  coreBuildId?: string;
  executorType?: string;
  employeeId?: string;
  toolId?: string;
  policyDecision?: string;
  decisionSource?: string;
  approvalId?: string;
  resultState?: string;
  missionId?: string;
}

test("an employee action records who did it, under which decision, approval and build", async () => {
  const dbPath = tempDb("obs-employee");
  const rt = boot(dbPath);
  const records: SeenRecord[] = [];
  try {
    await rt.start();
    const unsubscribe = rt.bus.subscribe((event) => {
      if (event.type === "action.executed") records.push(event.payload as SeenRecord);
    });

    // A worker action: EXTERNAL, so it parks first.
    const parked = await rt.tools.invoke("agents.run_task", {
      agentId: "hermes",
      action: "say hello",
      input: "hello",
    });
    assert.equal(parked.ok, false);
    const approvalId = rt.approvals.list({ status: "PENDING" })[0]?.id;
    assert.ok(approvalId, "an approval was requested");

    // Approve, then run it for real through the same boundary.
    rt.approvals.decide(approvalId, true);
    const ran = await rt.tools.invoke(
      "agents.run_task",
      { agentId: "hermes", action: "say hello", input: "hello" },
      { approvalId },
    );
    assert.equal(ran.ok, true, "the approved action executed");

    const parkedRecord = records.find((r) => r.resultState === "APPROVAL_REQUIRED");
    const executed = records.find((r) => r.resultState === "EXECUTED");
    assert.ok(parkedRecord, `a parked record exists: ${JSON.stringify(records)}`);
    assert.ok(executed, "an executed record exists");

    for (const record of [parkedRecord, executed]) {
      assert.equal(record.executorType, "employee", "an employee action names the employee path");
      assert.equal(record.employeeId, "hermes", "which employee");
      assert.equal(record.toolId, "agents.run_task");
      assert.equal(record.approvalId, approvalId, "which approval");
      assert.ok(record.policyDecision && record.policyDecision !== "none", "which decision");
      assert.ok(record.decisionSource && record.decisionSource.length > 0, "which authority");
      assert.ok(record.coreBuildId && record.coreBuildId.length > 0, "which build");
    }
    unsubscribe();
  } finally {
    await rt.stop();
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  }
});

test("a KAI-direct action records executor=kai with no employee", async () => {
  const dbPath = tempDb("obs-direct");
  const rt = boot(dbPath);
  const records: SeenRecord[] = [];
  try {
    await rt.start();
    rt.bus.subscribe((event) => {
      if (event.type === "action.executed") records.push(event.payload as SeenRecord);
    });

    const result = await rt.tools.invoke("system.get_status", {});
    assert.equal(result.ok, true, "KAI's own read tool runs unattended");

    const record = records.find((r) => r.toolId === "system.get_status");
    assert.ok(record, `a record for the direct action exists: ${JSON.stringify(records)}`);
    assert.equal(record.executorType, "kai", "KAI did this itself");
    assert.equal(record.employeeId, undefined, "and no employee is named");
    assert.equal(record.resultState, "EXECUTED");
    assert.equal(record.policyDecision, "allow");
    assert.equal(record.decisionSource, "default", "the default table allowed a READ");

    // The record names the build it came from, which is what makes a stale Core
    // self-evidently wrong rather than merely suspicious.
    const { loadIdentity } = await import("../src/identity.ts");
    assert.equal(record.coreBuildId, loadIdentity().buildId);
  } finally {
    await rt.stop();
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  }
});
