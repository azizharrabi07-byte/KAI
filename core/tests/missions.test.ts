// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Mission lifecycle + executor tests. Plain `node --test`, no dependencies,
 * no network, no child processes.
 * Run from `core/`:  node --test tests/missions.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  addStep,
  createMission,
  nextRunnableStep,
  type MissionStepInput,
} from "../src/missions/mission.ts";
import {
  createMissionExecutor,
  riskForStep,
  type MissionExecutor,
  type PolicyDecision,
  type PolicyGate,
  type PolicyRequest,
  type StepRunner,
} from "../src/missions/executor.ts";
import type {
  Approval,
  ApprovalStore,
  KaiError,
  KaiEventType,
  Mission,
  MissionStatus,
  MissionStep,
  MissionStore,
} from "../src/shared/contracts.ts";

// ── Fakes ─────────────────────────────────────────────────────────────────────
// Hand-written, deliberately NOT importing core/src/storage (in flight).

function clone<T>(value: T): T {
  return structuredClone(value);
}

function fakeMissionStore(): MissionStore & { rows: Map<string, Mission> } {
  const rows = new Map<string, Mission>();
  const terminal = new Set<MissionStatus>(["COMPLETED", "FAILED", "CANCELLED"]);
  return {
    rows,
    upsertMission(mission: Mission): void {
      rows.set(mission.id, clone(mission));
    },
    getMission(id: string): Mission | null {
      const row = rows.get(id);
      return row === undefined ? null : clone(row);
    },
    listMissions(opts?: { status?: MissionStatus; limit?: number }): Mission[] {
      let out = [...rows.values()].map(clone);
      if (opts?.status !== undefined) out = out.filter((m) => m.status === opts.status);
      if (opts?.limit !== undefined) out = out.slice(0, opts.limit);
      return out;
    },
    listUnfinishedMissions(): Mission[] {
      return [...rows.values()]
        .filter((m) => !terminal.has(m.status))
        .map(clone);
    },
    deleteMission(id: string): void {
      rows.delete(id);
    },
  };
}

/**
 * A double for the approvals the executor talks to.
 *
 * It answers BOTH shapes on purpose. The executor reads through the store shape
 * (`listApprovals`, `decideApproval`) and CREATES through the service shape
 * (`request`), because the service is what attaches the deadline — the executor
 * hand-building an approval produced a row with no `expiresAt`, which the expiry
 * sweep skips, so the approval could never expire. Keeping both here means these
 * tests still exercise the real creation path.
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
  list(opts?: { status?: Approval["status"] }): Approval[];
} {
  const rows: Approval[] = [];
  const store = {
    rows,
    createApproval(approval: Approval): void {
      rows.push(clone(approval));
    },
    getApproval(id: string): Approval | null {
      const row = rows.find((a) => a.id === id);
      return row === undefined ? null : clone(row);
    },
    listApprovals(opts?: { status?: Approval["status"]; limit?: number }): Approval[] {
      let out = rows.map(clone);
      if (opts?.status !== undefined) out = out.filter((a) => a.status === opts.status);
      if (opts?.limit !== undefined) out = out.slice(0, opts.limit);
      return out;
    },
    decideApproval(id: string, status: Approval["status"], decidedAt: string): void {
      const row = rows.find((a) => a.id === id);
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
        // The deadline the real service would attach.
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        ...(input.missionId !== undefined ? { missionId: input.missionId } : {}),
        ...(input.stepId !== undefined ? { stepId: input.stepId } : {}),
      };
      rows.push(clone(approval));
      return clone(approval);
    },
  };
}

interface SeenEvent {
  type: KaiEventType;
  missionId?: string;
  stepId?: string;
  payload: unknown;
}

function recorder(): { seen: SeenEvent[]; publish: (t: KaiEventType, p: unknown, o?: { source?: string; missionId?: string; stepId?: string }) => void } {
  const seen: SeenEvent[] = [];
  const publish = (type: KaiEventType, payload: unknown, o?: { source?: string; missionId?: string; stepId?: string }): void => {
    const e: SeenEvent = { type, payload };
    if (o?.missionId !== undefined) e.missionId = o.missionId;
    if (o?.stepId !== undefined) e.stepId = o.stepId;
    seen.push(e);
  };
  return { seen, publish };
}

const BASE_MS = Date.parse("2026-01-02T03:04:05.000Z");
function clock(): { now: () => Date; advance: (ms: number) => void } {
  let offset = 0;
  return {
    now: () => new Date(BASE_MS + offset),
    advance: (ms: number) => { offset += ms; },
  };
}

function counter(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}${++n}`;
}

const STEPS: MissionStepInput[] = [
  { title: "plan", kind: "manual" },
  { title: "call tool", kind: "tool", target: "fs.write", sideEffecting: true },
  { title: "report", kind: "agent", target: "hermes" },
];

function kaiError(code: KaiError["code"], message: string): KaiError {
  return { code, message, retryable: false, at: new Date(BASE_MS).toISOString() };
}

// ── Model ─────────────────────────────────────────────────────────────────────

test("createMission builds a DRAFT mission; addStep appends in index order", () => {
  const m = createMission(
    { title: "Ship it", priority: 3, steps: [STEPS[0] as MissionStepInput] },
    { idFactory: () => "m1", now: clock().now },
  );

  assert.equal(m.status, "DRAFT");
  assert.equal(m.id, "m1");
  assert.equal(m.priority, 3);
  assert.equal(m.steps.length, 1);
  assert.equal(m.steps[0]?.index, 0);
  assert.equal(m.steps[0]?.id, "step_m1_0");
  assert.equal(m.steps[0]?.status, "PENDING");
  assert.equal(m.steps[0]?.sideEffecting, false);

  addStep(m, STEPS[1] as MissionStepInput);
  addStep(m, STEPS[2] as MissionStepInput);
  assert.deepEqual(m.steps.map((s) => s.index), [0, 1, 2]);
  assert.equal(m.steps[1]?.sideEffecting, true);
  assert.equal(m.steps[1]?.target, "fs.write");

  assert.equal(nextRunnableStep(m)?.id, "step_m1_0");
  assert.equal(nextRunnableStep(m)?.title, "plan");
});

test("nextRunnableStep skips completed/failed/approval-parked steps", () => {
  const m = createMission({ title: "t", steps: STEPS }, { idFactory: () => "m2", now: clock().now });
  m.steps[0]!.status = "COMPLETED";
  assert.equal(nextRunnableStep(m)?.index, 1);
  m.steps[1]!.status = "FAILED";
  assert.equal(nextRunnableStep(m)?.index, 2);
  m.steps[2]!.status = "WAITING_APPROVAL";
  assert.equal(nextRunnableStep(m), null);
});

// ── Happy path ────────────────────────────────────────────────────────────────

test("start runs steps in index order and completes with ordered events", async () => {
  const store = fakeMissionStore();
  const { seen, publish } = recorder();
  const format = clock();
  const order: number[] = [];

  const runner: StepRunner = async (step) => {
    order.push(step.index);
    return { ok: true, output: { ran: step.index } };
  };
  const exec = createMissionExecutor({
    store, runner, publish, now: format.now, idFactory: counter("ap"),
  });

  const m = createMission({ title: "Job", steps: STEPS }, { publish, now: format.now, idFactory: () => "m1" });
  store.upsertMission(m);

  const done = await exec.start("m1");

  assert.equal(done.status, "COMPLETED");
  assert.deepEqual(order, [0, 1, 2], "runner called in ascending index order");
  assert.ok(done.steps.every((s) => s.status === "COMPLETED"));
  assert.equal(done.steps[0]?.output?.ran, 0);
  assert.equal(store.getMission("m1")?.status, "COMPLETED", "terminal status persisted");

  assert.deepEqual(
    seen.map((e) => e.type),
    ["mission.created", "mission.started", "mission.progress", "mission.progress", "mission.progress", "mission.completed"],
  );
  for (const e of seen) assert.equal(e.missionId, "m1");
  assert.deepEqual(
    seen.filter((e) => e.type === "mission.progress").map((e) => e.stepId),
    ["step_m1_0", "step_m1_1", "step_m1_2"],
  );
  assert.equal(new Set(done.steps.map((s) => s.id)).size, 3, "step ids unique");
});

// ── Failure ───────────────────────────────────────────────────────────────────

test("a failing step fails the mission; later steps are not run", async () => {
  const store = fakeMissionStore();
  const { seen, publish } = recorder();
  const format = clock();
  const ran: number[] = [];

  const runner: StepRunner = async (step) => {
    ran.push(step.index);
    if (step.index === 1) return { ok: false, error: kaiError("AGENT_RUN_FAILED", "boom") };
    return { ok: true };
  };
  const exec = createMissionExecutor({ store, runner, publish, now: format.now, idFactory: counter("ap") });
  const m = createMission({ title: "Job", steps: STEPS }, { now: format.now, idFactory: () => "m1" });
  store.upsertMission(m);

  const done = await exec.start("m1");

  assert.equal(done.status, "FAILED");
  assert.deepEqual(ran, [0, 1], "the step after the failure never runs");
  assert.equal(done.steps[0]?.status, "COMPLETED");
  assert.equal(done.steps[1]?.status, "FAILED");
  assert.equal(done.steps[2]?.status, "PENDING", "remaining step untouched");
  assert.equal(done.steps[1]?.error?.code, "AGENT_RUN_FAILED");
  assert.equal(done.error?.code, "AGENT_RUN_FAILED", "error stored on the mission too");

  const persisted = store.getMission("m1");
  assert.equal(persisted?.status, "FAILED");
  assert.equal(persisted?.steps[1]?.error?.code, "AGENT_RUN_FAILED");
  assert.ok(seen.some((e) => e.type === "mission.failed"));
});

// ── Policy ────────────────────────────────────────────────────────────────────

function gateReturning(decision: PolicyDecision, sink?: PolicyRequest[]): PolicyGate {
  return {
    async check(request: PolicyRequest): Promise<PolicyDecision> {
      sink?.push(request);
      return decision;
    },
  };
}

test("risk is derived: side-effecting >= WRITE, unknown tool target = EXTERNAL", () => {
  const m = createMission({ title: "t", steps: STEPS }, { idFactory: () => "m3", now: clock().now });
  const [manual, tool, agent] = m.steps as [MissionStep, MissionStep, MissionStep];
  assert.equal(riskForStep(manual), "READ");
  assert.equal(riskForStep(agent), "READ");
  assert.equal(riskForStep(tool), "EXTERNAL", "tool target unknown to the executor");

  const sideAgent = { ...agent, sideEffecting: true };
  assert.equal(riskForStep(sideAgent), "WRITE");
});

test("policy deny fails the step with POLICY_DENIED and stops the mission", async () => {
  const store = fakeMissionStore();
  const format = clock();
  const requests: PolicyRequest[] = [];
  const ran: number[] = [];
  const runner: StepRunner = async (step) => { ran.push(step.index); return { ok: true }; };

  // Deny every step; the first one must fail before the runner ever sees it.
  const policy = gateReturning({ outcome: "deny", reason: "not allowed" }, requests);
  const exec = createMissionExecutor({ store, runner, policy, now: format.now, idFactory: counter("ap") });
  const m = createMission({ title: "Job", steps: STEPS }, { now: format.now, idFactory: () => "m1" });
  store.upsertMission(m);

  const done = await exec.start("m1");

  assert.equal(done.status, "FAILED");
  assert.deepEqual(ran, [], "runner never runs a denied step");
  assert.equal(requests.length, 1, "only the first step is checked before stopping");
  assert.equal(done.steps[0]?.status, "FAILED");
  assert.equal(done.steps[0]?.error?.code, "POLICY_DENIED");
  assert.equal(done.steps[0]?.error?.message, "not allowed");
  assert.equal(done.steps[1]?.status, "PENDING");
});

test("policy needs_approval parks the mission and does NOT call the runner", async () => {
  const store = fakeMissionStore();
  const approvals = fakeApprovalStore();
  const { seen, publish } = recorder();
  const format = clock();
  const ran: number[] = [];
  const runner: StepRunner = async (step) => { ran.push(step.index); return { ok: true }; };

  let call = 0;
  const policy: PolicyGate = {
    async check(): Promise<PolicyDecision> {
      call += 1;
      return call === 2
        ? { outcome: "needs_approval", reason: "high risk write" }
        : { outcome: "allow", reason: "ok" };
    },
  };
  const exec = createMissionExecutor({
    store, runner, policy, approvals, publish, now: format.now, idFactory: counter("ap"),
  });
  const m = createMission({ title: "Job", steps: STEPS }, { now: format.now, idFactory: () => "m1" });
  store.upsertMission(m);

  const done = await exec.start("m1");

  assert.equal(done.status, "WAITING_APPROVAL");
  assert.deepEqual(ran, [0], "runner ran step 0 only; step 1 was parked");
  assert.equal(done.steps[1]?.status, "WAITING_APPROVAL");
  assert.equal(done.steps[2]?.status, "PENDING");
  assert.equal(store.getMission("m1")?.status, "WAITING_APPROVAL");
  assert.equal(approvals.rows.length, 1);
  assert.equal(approvals.rows[0]?.status, "PENDING");
  assert.equal(approvals.rows[0]?.stepId, "step_m1_1");
  assert.equal(approvals.rows[0]?.risk, "EXTERNAL");
  // The approval carries a DEADLINE. It is set by the approvals service, which
  // is why the executor now creates through it: a row without `expiresAt` is
  // skipped by the expiry sweep, so the approval could never expire and the
  // mission parked on it stayed parked forever.
  assert.ok(approvals.rows[0]?.expiresAt, "the parked approval carries an expiry");
  // `approval.requested` is published by the SERVICE, not by the executor — it
  // is the service that creates the row, and it publishes as part of doing so.
  // This recorder is wired to the executor alone, so the honest assertion here
  // is that the executor does NOT publish it and cannot publish it twice.
  assert.equal(
    seen.some((e) => e.type === "approval.requested"),
    false,
    "the executor must not publish approval.requested; the service owns that emit",
  );
});

// ── Cancel ────────────────────────────────────────────────────────────────────

test("cancel mid-mission stops further steps and is idempotent", async () => {
  const store = fakeMissionStore();
  const { seen, publish } = recorder();
  const format = clock();
  const ran: number[] = [];
  let exec: MissionExecutor;

  const runner: StepRunner = async (step) => {
    ran.push(step.index);
    if (step.index === 1) await exec.cancel("m1");
    return { ok: true };
  };
  exec = createMissionExecutor({ store, runner, publish, now: format.now, idFactory: counter("ap") });

  const m = createMission({ title: "Job", steps: STEPS }, { now: format.now, idFactory: () => "m1" });
  store.upsertMission(m);

  const result = await exec.start("m1");

  assert.equal(result.status, "CANCELLED");
  assert.deepEqual(ran, [0, 1], "steps after the cancel never run");
  assert.equal(result.steps[2]?.status, "PENDING");
  assert.equal(store.getMission("m1")?.status, "CANCELLED");

  const again = await exec.cancel("m1");
  assert.equal(again.status, "CANCELLED");
  assert.equal(seen.filter((e) => e.type === "mission.cancelled").length, 1, "cancel publishes once");
});

// ── Crash recovery (spec §29) ─────────────────────────────────────────────────

test("recover resumes a mission whose remaining steps are not side-effecting", async () => {
  const store = fakeMissionStore();
  const format = clock();
  const ran: string[] = [];
  const runner: StepRunner = async (step) => { ran.push(step.id); return { ok: true }; };
  const exec = createMissionExecutor({ store, runner, now: format.now, idFactory: counter("ap") });

  const m = createMission(
    {
      title: "Job",
      steps: [
        { title: "done", kind: "manual" },
        { title: "read", kind: "tool", target: "fs.read" },
        { title: "report", kind: "agent", target: "hermes" },
      ],
    },
    { now: format.now, idFactory: () => "m1" },
  );
  m.status = "RUNNING";
  m.steps[0]!.status = "COMPLETED";
  store.upsertMission(m);

  const { resumed, blocked } = await exec.recover();

  assert.deepEqual(resumed, ["m1"]);
  assert.deepEqual(blocked, []);
  assert.deepEqual(ran, ["step_m1_1", "step_m1_2"], "the completed step is not re-run");
  assert.equal(store.getMission("m1")?.status, "COMPLETED");
});

test("recover blocks a mission whose next step is side-effecting and never calls the runner", async () => {
  const store = fakeMissionStore();
  const format = clock();
  const ran: string[] = [];
  const runner: StepRunner = async (step) => { ran.push(step.id); return { ok: true }; };
  const exec = createMissionExecutor({ store, runner, now: format.now, idFactory: counter("ap") });

  const m = createMission(
    {
      title: "Job",
      steps: [
        { title: "done", kind: "manual" },
        { title: "write", kind: "tool", target: "fs.write", sideEffecting: true },
        { title: "report", kind: "agent", target: "hermes" },
      ],
    },
    { now: format.now, idFactory: () => "m1" },
  );
  m.status = "RUNNING";
  m.steps[0]!.status = "COMPLETED";
  store.upsertMission(m);

  const { resumed, blocked } = await exec.recover();

  assert.deepEqual(resumed, []);
  assert.deepEqual(blocked, ["m1"]);
  assert.deepEqual(ran, [], "runner was not called for the blocked mission");

  const persisted = store.getMission("m1");
  assert.equal(persisted?.status, "WAITING");
  assert.equal(persisted?.error?.code, "AGENT_RUN_ABANDONED");
  assert.match(persisted?.error?.message ?? "", /side-effecting/);
  assert.equal(persisted?.metadata?.recoveryBlocked, true);
});

test("recover settles an all-steps-complete mission without re-running anything", async () => {
  const store = fakeMissionStore();
  const format = clock();
  const ran: string[] = [];
  const runner: StepRunner = async (step) => { ran.push(step.id); return { ok: true }; };
  const exec = createMissionExecutor({ store, runner, now: format.now, idFactory: counter("ap") });

  const m = createMission({ title: "Job", steps: STEPS }, { now: format.now, idFactory: () => "m1" });
  m.status = "RUNNING";
  for (const s of m.steps) s.status = "COMPLETED";
  store.upsertMission(m);

  const { resumed, blocked } = await exec.recover();

  assert.deepEqual(resumed, []);
  assert.deepEqual(blocked, []);
  assert.deepEqual(ran, [], "settling runs nothing");
  assert.equal(store.getMission("m1")?.status, "COMPLETED");
});

// ── Approval resume (a parked mission continues when a human answers) ─────────

/**
 * Drive a mission to WAITING_APPROVAL: steps 0 (manual) and 2 (agent) are
 * allowed, step 1 (a side-effecting tool write) parks. Returns the rig so each
 * test can decide the created approval and then resume/recover.
 */
async function parkOnApproval() {
  const store = fakeMissionStore();
  const approvals = fakeApprovalStore();
  const format = clock();
  const ran: number[] = [];
  const runner: StepRunner = async (step) => { ran.push(step.index); return { ok: true }; };
  let call = 0;
  const policy: PolicyGate = {
    async check(): Promise<PolicyDecision> {
      call += 1;
      return call === 2
        ? { outcome: "needs_approval", reason: "high risk write" }
        : { outcome: "allow", reason: "ok" };
    },
  };
  const exec = createMissionExecutor({
    store, runner, policy, approvals, now: format.now, idFactory: counter("ap"),
  });
  const m = createMission({ title: "Job", steps: STEPS }, { now: format.now, idFactory: () => "m1" });
  store.upsertMission(m);

  const parked = await exec.start("m1");
  assert.equal(parked.status, "WAITING_APPROVAL");
  assert.deepEqual(ran, [0], "only the pre-approval step ran");

  return { store, approvals, exec, ran, format, approval: approvals.rows[0]! };
}

test("resume runs a parked step once its approval is APPROVED", async () => {
  const { approvals, exec, ran, format, approval } = await parkOnApproval();

  approvals.decideApproval(approval.id, "APPROVED", format.now().toISOString());
  const done = await exec.resume("m1");

  assert.equal(done.status, "COMPLETED");
  assert.deepEqual(ran, [0, 1, 2], "the cleared step ran, then the remaining steps");
  assert.equal(done.steps[1]?.status, "COMPLETED");
});

test("resume fails the mission when the parked approval is REJECTED, without running it", async () => {
  const { store, approvals, exec, ran, format, approval } = await parkOnApproval();

  approvals.decideApproval(approval.id, "REJECTED", format.now().toISOString());
  const done = await exec.resume("m1");

  assert.equal(done.status, "FAILED");
  assert.deepEqual(ran, [0], "the refused step never ran");
  assert.equal(done.steps[1]?.status, "FAILED");
  assert.equal(done.steps[1]?.error?.code, "POLICY_DENIED");
  assert.equal(done.steps[2]?.status, "PENDING", "later steps are not run");
  assert.equal(store.getMission("m1")?.status, "FAILED");
});

test("resume leaves a still-PENDING approval parked (silence is not consent)", async () => {
  const { exec, ran } = await parkOnApproval();

  const again = await exec.resume("m1");

  assert.equal(again.status, "WAITING_APPROVAL");
  assert.deepEqual(ran, [0], "a PENDING approval does not clear the step");
});

test("recover resumes a WAITING_APPROVAL mission whose approval was APPROVED", async () => {
  const { store, approvals, exec, ran, format, approval } = await parkOnApproval();

  approvals.decideApproval(approval.id, "APPROVED", format.now().toISOString());
  const { resumed, blocked } = await exec.recover();

  assert.deepEqual(resumed, ["m1"]);
  assert.deepEqual(blocked, []);
  assert.deepEqual(ran, [0, 1, 2]);
  assert.equal(store.getMission("m1")?.status, "COMPLETED");
});

test("recover settles a WAITING_APPROVAL mission whose approval was REJECTED", async () => {
  const { store, approvals, exec, ran, format, approval } = await parkOnApproval();

  approvals.decideApproval(approval.id, "REJECTED", format.now().toISOString());
  const { resumed, blocked } = await exec.recover();

  assert.deepEqual(resumed, []);
  assert.deepEqual(blocked, [], "a refused mission is settled, not blocked");
  assert.deepEqual(ran, [0], "the refused step never ran");
  assert.equal(store.getMission("m1")?.status, "FAILED");
  assert.equal(store.getMission("m1")?.error?.code, "POLICY_DENIED");
});

test("recover blocks a WAITING_APPROVAL mission whose approval is still PENDING", async () => {
  const { store, exec, ran } = await parkOnApproval();

  const { resumed, blocked } = await exec.recover();

  assert.deepEqual(resumed, []);
  assert.deepEqual(blocked, ["m1"], "nothing can answer a card whose waiter died");
  assert.deepEqual(ran, [0]);
  assert.equal(store.getMission("m1")?.status, "WAITING_APPROVAL");
  assert.equal(store.getMission("m1")?.metadata?.recoveryBlocked, true);
});



