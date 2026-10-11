// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Tests for the Core HTTP API surface (src/api/routes.ts).
 *
 * These drive `handle()` directly against a hand-written STUB runtime — a plain
 * object that records what it was asked to do. No network, no HTTP server, no
 * database: the whole point of the pure request -> response shape is that the
 * API can be exercised as a function.
 *
 * The stub is cast to CoreRuntime because it implements only the slice the API
 * actually calls; if the API starts depending on more of the runtime, these
 * tests fail loudly (undefined is not a function) rather than silently passing.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createCoreApi, attachEventStream } from "../src/api/routes.ts";
import type { CoreRuntime, CoreRuntimeHealth } from "../src/runtime.ts";
import { createStateMutationTools, KAI_INTERNAL_STATE_TOOLS } from "../src/runtime.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import { registerBuiltinTools } from "../src/tools/builtin.ts";
import { createPolicyEngine } from "../src/policies/gate.ts";
import type { ApprovalService } from "../src/approvals/service.ts";
import type {
  AgentStatus,
  AgentTaskResult,
  Approval,
  Mission,
  MissionStep,
  RiskLevel,
} from "../src/shared/contracts.ts";

// ── Stub runtime ───────────────────────────────────────────────────────────────

interface Stub {
  runtime: CoreRuntime;
  spies: {
    createAndStartMission: Array<Record<string, unknown>>;
    publish: Array<{ type: string; payload: unknown }>;
    cancel: string[];
    decide: Array<{ id: string; approved: boolean }>;
    createMemory: unknown[];
    runTask: unknown[];
    createdApprovals: Approval[];
    markRead: string[];
    listMissions: unknown[];
  };
  /** Set to make the whole thing throw where a test wants a 500. */
  setHealthThrows(value: boolean): void;
  /** Feed an event to every bus subscriber (simulates bus.publish). */
  emit(event: unknown): void;
}

function createStub(): Stub {
  const spies: Stub["spies"] = {
    createAndStartMission: [],
    publish: [],
    cancel: [],
    decide: [],
    createMemory: [],
    runTask: [],
    createdApprovals: [],
    markRead: [],
    listMissions: [],
  };

  let healthThrows = false;
  const busHandlers = new Set<(event: unknown) => void>();

  const now = new Date().toISOString();

  const runningMission: Mission = {
    id: "m-running",
    title: "Running mission",
    status: "RUNNING",
    priority: 0,
    createdAt: now,
    updatedAt: now,
    steps: [
      {
        id: "m-running:0",
        missionId: "m-running",
        index: 0,
        title: "do the thing",
        kind: "manual",
        status: "PENDING",
        sideEffecting: false,
      },
    ],
  };

  const pendingApproval: Approval = {
    id: "ap-1",
    toolId: "fs.write",
    action: "write",
    reason: "writes a file",
    risk: "WRITE",
    createdAt: now,
    status: "PENDING",
  };

  const decidedApproval: Approval = { ...pendingApproval, id: "ap-done", status: "APPROVED" };

  const agents: AgentStatus[] = [
    { id: "hermes", state: "idle" },
    { id: "opencode", state: "idle" },
  ];

  const capabilitiesFor = (id: string): readonly string[] =>
    id === "hermes" ? ["health", "status", "run_task"] : ["health", "status"];

  const health: CoreRuntimeHealth = {
    ok: true,
    startedAt: now,
    uptimeMs: 1234,
    database: { path: "C:/Users/x/.kai/kai.db" },
    agents,
    missions: { active: 1, unfinished: 1 },
    notifications: { unread: 2 },
    approvals: { pending: 1 },
    scheduler: { running: true, enabled: 0 },
    tools: { registered: 5 },
  };

  /**
   * The tool registry is REAL here rather than stubbed.
   *
   * Phase 1 Part F routes `POST /agents/:id/action` through it, so a faked
   * registry would hide the exact boundary these tests exist to prove. Its
   * policy engine is a real one in the default mode, and its approval service
   * delegates to the stub below so a card created here is visible to the tests.
   *
   * The policy also carries the SAME `kai-internal-state` rule the production
   * runtime appends (Phase 2 Part I): the state-mutation routes below are
   * WRITE-classified, and without this rule a WRITE gate tool would park at 409
   * instead of completing. This mirrors production deliberately — the stub is
   * not a weaker boundary than the real Core.
   */
  const createdApprovals = spies.createdApprovals;
  const tools = createToolRegistry({
    policy: createPolicyEngine({
      rules: [
        { id: "kai-internal-state", risk: "WRITE", outcome: "allow", tools: [...KAI_INTERNAL_STATE_TOOLS] },
      ],
    }),
    approvals: {
      request(input: { toolId: string; action: string; reason: string; risk: RiskLevel }) {
        const approval: Approval = {
          id: `ap-auto-${createdApprovals.length + 1}`,
          toolId: input.toolId,
          action: input.action,
          reason: input.reason,
          risk: input.risk,
          createdAt: now,
          status: "PENDING",
        };
        createdApprovals.push(approval);
        return approval;
      },
      get(id: string): Approval | null {
        return createdApprovals.find((approval) => approval.id === id) ?? null;
      },
    } as unknown as ApprovalService,
  });
  registerBuiltinTools(tools, {
    // References `runtime` lazily: this closure runs at invoke time, long after
    // the object below has been built.
    runAgentTask: async ({ agentId, action, input }) => {
      const adapter = runtime.registry.get(agentId);
      if (adapter === undefined) throw new Error(`no agent registered as "${agentId}"`);
      return adapter.runTask({ id: "task-1", input: input ?? action, options: { action } });
    },
  });

  // The state-mutation tools the HTTP routes reach through the ONE boundary
  // (Phase 2 Part I). They are registered on the SAME real registry the routes
  // use — exactly as the production runtime does — so a route that references a
  // gate tool finds it. Without this, the state-mutating routes answer 404, which
  // is precisely the wiring these tests exist to catch. Each dep delegates back
  // to the stub's own spies/services, so the assertions still observe the effect
  // the route was supposed to cause.
  for (const tool of createStateMutationTools({
    writeCanonicalMemory: (input) => {
      const record = (input ?? {}) as Record<string, unknown>;
      return {
        ok: true,
        entry: { ...record, id: `mem-engine-${spies.createMemory.length + 1}` },
        deduped: false,
      };
    },
    createLegacyMemory: (memory) => {
      spies.createMemory.push(memory);
      spies.publish.push({ type: "memory.created", payload: memory });
    },
    markNotificationRead: (id) => {
      spies.markRead.push(id);
    },
    decideApproval: (id, approved) => runtime.decideApproval(id, approved),
    registerEmployee: () => ({ registered: true }),
    employeeLifecycle: async () => ({ ok: true }),
    cancelMission: (id) => runtime.missions.cancel(id),
    createSchedule: async (task) => ({ schedule: task }),
    cancelSchedule: () => false,
    recoverScheduler: () => ({ recovered: [] }),
    proposeLearning: () => ({ outcome: null }),
    createCheckpoint: () => ({ ok: true }),
    restoreCheckpoint: () => ({ ok: true }),
    deleteSkill: () => ({ ok: true }),
    toggleSkill: () => ({ ok: true }),
    setPolicyRules: () => ({ applied: 0, dropped: 0, reason: "test stub" }),
  })) {
    tools.register(tool);
  }

  const runtime = {
    stores: {
      missions: {
        getMission(id: string): Mission | null {
          return id === runningMission.id ? runningMission : null;
        },
        listMissions(opts: unknown): Mission[] {
          spies.listMissions.push(opts);
          return [runningMission];
        },
      },
      memory: {
        createMemory(memory: unknown): void {
          spies.createMemory.push(memory);
        },
        listMemories(): unknown[] {
          return [];
        },
      },
      notifications: {
        getNotification(id: string): unknown {
          return id === "n-1" ? { id, read: false } : null;
        },
        listNotifications(): unknown[] {
          return [];
        },
        markRead(id: string, read: boolean): void {
          spies.markRead.push(id);
        },
      },
      approvals: {
        getApproval(id: string): Approval | null {
          if (id === pendingApproval.id) return pendingApproval;
          if (id === decidedApproval.id) return decidedApproval;
          return null;
        },
        listApprovals(): Approval[] {
          return [pendingApproval];
        },
        decideApproval(): void {
          /* the service is stubbed at runtime.approvals, not here */
        },
      },
      scheduledTasks: {
        listScheduledTasks(): unknown[] {
          return [];
        },
      },
    },
    bus: {
      publish(type: string, payload: unknown): void {
        spies.publish.push({ type, payload });
      },
      subscribe(handler: (event: unknown) => void): () => void {
        busHandlers.add(handler);
        return () => {
          busHandlers.delete(handler);
        };
      },
      unsubscribe(handler: (event: unknown) => void): void {
        busHandlers.delete(handler);
      },
      recent(): unknown[] {
        return [];
      },
    },
    notifications: {
      list(): unknown[] {
        return [];
      },
      markRead(id: string): void {
        spies.markRead.push(id);
      },
    },
    tools,
    registry: {
      get(id: string): { id: string; capabilities(): readonly string[]; runTask(t: unknown): Promise<AgentTaskResult> } | undefined {
        if (id !== "hermes" && id !== "opencode") return undefined;
        return {
          id,
          capabilities: () => capabilitiesFor(id),
          async runTask(task: unknown): Promise<AgentTaskResult> {
            spies.runTask.push({ id, task });
            return { taskId: (task as { id: string }).id, state: "completed", output: "ok" };
          },
        };
      },
      list(): unknown[] {
        return [];
      },
      ids(): string[] {
        return agents.map((a) => a.id);
      },
      async statusAll(): Promise<AgentStatus[]> {
        return agents;
      },
      async healthAll(): Promise<Record<string, unknown>> {
        return { hermes: { ok: true, latencyMs: 1 }, opencode: { ok: true, latencyMs: 2 } };
      },
    },
    // Mirrors the runtime's combined operation: decide, then settle whatever
    // was parked on it. The stub records both so a test can assert the mission
    // was told, not just that the row changed.
    async decideApproval(
      id: string,
      approved: boolean,
    ): Promise<{ approved: boolean; missionId?: string; resumed: boolean }> {
      const approval = this.approvals.get(id);
      const decided = this.approvals.decide(id, approved);
      if (decided !== null && approval !== null) approval.status = approved ? "APPROVED" : "REJECTED";
      return { approved, resumed: approval?.missionId !== undefined };
    },
    approvals: {
      get(id: string): Approval | null {
        if (id === pendingApproval.id) return pendingApproval;
        if (id === decidedApproval.id) return decidedApproval;
        return null;
      },
      list(): Approval[] {
        return [pendingApproval];
      },
      decide(id: string, approved: boolean): { ok: true; approval: Approval } {
        spies.decide.push({ id, approved });
        return { ok: true, approval: { ...pendingApproval, id, status: approved ? "APPROVED" : "REJECTED" } };
      },
    },
    missions: {
      async cancel(id: string): Promise<Mission> {
        spies.cancel.push(id);
        return { ...runningMission, status: "CANCELLED" };
      },
    },
    async health(): Promise<CoreRuntimeHealth> {
      if (healthThrows) {
        throw new Error("boom at C:\\Users\\secret\\internal-path.ts line 42");
      }
      return health;
    },
    async createAndStartMission(input: Record<string, unknown>): Promise<Mission> {
      spies.createAndStartMission.push(input);
      const steps = (input.steps as MissionStep[] | undefined) ?? [];
      return {
        id: "m-new",
        title: input.title as string,
        status: "QUEUED",
        priority: 0,
        createdAt: now,
        updatedAt: now,
        steps,
      };
    },
  } as unknown as CoreRuntime;

  return {
    runtime,
    spies,
    setHealthThrows(value: boolean) {
      healthThrows = value;
    },
    emit(event: unknown) {
      for (const handler of [...busHandlers]) handler(event);
    },
  };
}

async function call(
  stub: Stub,
  method: string,
  path: string,
  opts: { query?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const api = createCoreApi(stub.runtime);
  const request = {
    method,
    path,
    query: new URLSearchParams(opts.query ?? {}),
    ...(opts.body !== undefined ? { body: opts.body } : {}),
    // This suite drives a hand-written STUB runtime directly, so it models the
    // INSTALLED APP (which holds the owner credential). The Core fails closed, so
    // an unattested mutation would be refused before the route's own validation
    // could report the 400 these tests are about.
    attested: true,
    ownerAuthConfigured: true,
  };
  return (await api.handle(request)) as { status: number; body: any };
}

// ── GET /state ─────────────────────────────────────────────────────────────────

test("GET /state reports core, agents, counts and scheduler state", async () => {
  const stub = createStub();
  const res = await call(stub, "GET", "/state");

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.uptimeMs, 1234);
  assert.equal(res.body.database.path, "C:/Users/x/.kai/kai.db");
  assert.equal(res.body.agents.length, 2);
  assert.equal(res.body.agents[0].id, "hermes");
  assert.equal(res.body.agents[0].state, "idle");
  assert.equal(res.body.agents[0].health.ok, true);
  assert.equal(res.body.missions.active, 1);
  assert.equal(res.body.notifications.unread, 2);
  assert.equal(res.body.approvals.pending, 1);
  assert.equal(res.body.scheduler.running, true);
  assert.equal(res.body.scheduler.total, 0);
});

// ── GET /agents ────────────────────────────────────────────────────────────────

test("GET /agents lists agents with status", async () => {
  const stub = createStub();
  const res = await call(stub, "GET", "/agents");
  assert.equal(res.status, 200);
  assert.equal(res.body.agents.length, 2);
  assert.deepEqual(res.body.agents.map((a: AgentStatus) => a.id), ["hermes", "opencode"]);
});

test("GET /agents/:id returns one agent or 404", async () => {
  const stub = createStub();
  const found = await call(stub, "GET", "/agents/hermes");
  assert.equal(found.status, 200);
  assert.equal(found.body.agent.id, "hermes");

  const missing = await call(stub, "GET", "/agents/ghost");
  assert.equal(missing.status, 404);
  assert.match(missing.body.reason, /ghost/);
});

// ── Unknown route ──────────────────────────────────────────────────────────────

test("unknown path returns 404 JSON, never HTML", async () => {
  const stub = createStub();
  const res = await call(stub, "GET", "/nope");
  assert.equal(res.status, 404);
  assert.equal(typeof res.body, "object");
  assert.equal(res.body.error, true);
  assert.match(res.body.reason, /no route/);
});

test("known path with the wrong method returns 404", async () => {
  const stub = createStub();
  const res = await call(stub, "DELETE", "/state");
  assert.equal(res.status, 404);
  assert.equal(res.body.error, true);
});

// ── POST /missions ─────────────────────────────────────────────────────────────

test("POST /missions with a valid body creates and starts the mission", async () => {
  const stub = createStub();
  const res = await call(stub, "POST", "/missions", {
    body: {
      title: "Ship the API",
      description: "make it mountable",
      steps: [{ title: "write tests", kind: "tool", target: "fs.write" }],
    },
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.mission.title, "Ship the API");
  assert.equal(stub.spies.createAndStartMission.length, 1);
  assert.equal(stub.spies.createAndStartMission[0]!.title, "Ship the API");
  assert.equal((stub.spies.createAndStartMission[0]!.steps as unknown[]).length, 1);
});

test("POST /missions with a missing title returns 400 naming the field", async () => {
  const stub = createStub();
  const res = await call(stub, "POST", "/missions", { body: {} });
  assert.equal(res.status, 400);
  assert.match(res.body.reason, /title/);
  assert.equal(stub.spies.createAndStartMission.length, 0);
});

test("POST /missions with a blank title returns 400", async () => {
  const stub = createStub();
  const res = await call(stub, "POST", "/missions", { body: { title: "   " } });
  assert.equal(res.status, 400);
  assert.match(res.body.reason, /title/);
});

test("POST /missions with a bad step kind returns 400 naming the field", async () => {
  const stub = createStub();
  const res = await call(stub, "POST", "/missions", {
    body: { title: "ok", steps: [{ title: "x", kind: "sorcery" }] },
  });
  assert.equal(res.status, 400);
  assert.match(res.body.reason, /steps\[0\]\.kind/);
  assert.equal(stub.spies.createAndStartMission.length, 0);
});

test("POST /missions with a non-object body returns 400, not a crash", async () => {
  const stub = createStub();
  const res = await call(stub, "POST", "/missions", { body: "just a string" });
  assert.equal(res.status, 400);
  assert.match(res.body.reason, /body/);
});

// ── GET /missions ──────────────────────────────────────────────────────────────

test("GET /missions with a bad status returns 400 naming the field", async () => {
  const stub = createStub();
  const res = await call(stub, "GET", "/missions", { query: { status: "FLYING" } });
  assert.equal(res.status, 400);
  assert.match(res.body.reason, /status/);
  assert.match(res.body.reason, /FLYING/);
});

test("GET /missions with a bad limit returns 400 naming the field", async () => {
  const stub = createStub();
  const res = await call(stub, "GET", "/missions", { query: { limit: "zero" } });
  assert.equal(res.status, 400);
  assert.match(res.body.reason, /limit/);
});

test("GET /missions passes a valid status and limit through", async () => {
  const stub = createStub();
  const res = await call(stub, "GET", "/missions", { query: { status: "RUNNING", limit: "10" } });
  assert.equal(res.status, 200);
  assert.deepEqual(stub.spies.listMissions[0], { status: "RUNNING", limit: 10 });
});

test("GET /missions/:id unknown returns 404", async () => {
  const stub = createStub();
  const res = await call(stub, "GET", "/missions/ghost");
  assert.equal(res.status, 404);
  assert.match(res.body.reason, /ghost/);
});

test("GET /missions/:id known returns the mission with its steps", async () => {
  const stub = createStub();
  const res = await call(stub, "GET", "/missions/m-running");
  assert.equal(res.status, 200);
  assert.equal(res.body.mission.id, "m-running");
  assert.equal(res.body.mission.steps.length, 1);
});

// ── POST /missions/:id/cancel ──────────────────────────────────────────────────

test("POST /missions/:id/cancel unknown returns 404 and does not call the executor", async () => {
  const stub = createStub();
  const res = await call(stub, "POST", "/missions/ghost/cancel");
  assert.equal(res.status, 404);
  assert.equal(stub.spies.cancel.length, 0);
});

test("POST /missions/:id/cancel known calls through and returns the mission", async () => {
  const stub = createStub();
  const res = await call(stub, "POST", "/missions/m-running/cancel");
  assert.equal(res.status, 200);
  assert.equal(res.body.mission.status, "CANCELLED");
  assert.deepEqual(stub.spies.cancel, ["m-running"]);
});

// ── Approvals ──────────────────────────────────────────────────────────────────

test("POST /approvals/:id/decide with a non-boolean returns 400 naming the field", async () => {
  const stub = createStub();
  const res = await call(stub, "POST", "/approvals/ap-1/decide", { body: { approved: "yes" } });
  assert.equal(res.status, 400);
  assert.match(res.body.reason, /approved/);
  assert.equal(stub.spies.decide.length, 0);
});

test("POST /approvals/:id/decide with a missing approved returns 400", async () => {
  const stub = createStub();
  const res = await call(stub, "POST", "/approvals/ap-1/decide", { body: {} });
  assert.equal(res.status, 400);
  assert.match(res.body.reason, /approved/);
});

test("POST /approvals/:id/decide with a valid body decides", async () => {
  const stub = createStub();
  const res = await call(stub, "POST", "/approvals/ap-1/decide", { body: { approved: true } });
  assert.equal(res.status, 200);
  assert.equal(res.body.approval.status, "APPROVED");
  assert.deepEqual(stub.spies.decide, [{ id: "ap-1", approved: true }]);
});

test("POST /approvals/:id/decide unknown returns 404", async () => {
  const stub = createStub();
  const res = await call(stub, "POST", "/approvals/ghost/decide", { body: { approved: true } });
  assert.equal(res.status, 404);
});

test("POST /approvals/:id/decide on an already-decided approval returns 409 with a reason", async () => {
  const stub = createStub();
  const res = await call(stub, "POST", "/approvals/ap-done/decide", { body: { approved: true } });
  assert.equal(res.status, 409);
  assert.match(res.body.reason, /ap-done/);
  assert.match(res.body.reason, /APPROVED/);
});

// ── Memory ─────────────────────────────────────────────────────────────────────

test("POST /memory with a valid body creates the record and publishes memory.created", async () => {
  const stub = createStub();
  const res = await call(stub, "POST", "/memory", {
    body: { type: "user_preference", content: "prefers dark mode", importance: 4 },
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.memory.type, "user_preference");
  assert.ok(typeof res.body.memory.id === "string" && res.body.memory.id.length > 0);
  assert.ok(typeof res.body.memory.createdAt === "string");
  assert.equal(stub.spies.createMemory.length, 1);
  const published = stub.spies.publish.find((p) => p.type === "memory.created");
  assert.ok(published !== undefined, "memory.created was published");
  assert.deepEqual((published!.payload as { content: string }).content, "prefers dark mode");
});

test("POST /memory with an invalid type returns 400 naming the field", async () => {
  const stub = createStub();
  const res = await call(stub, "POST", "/memory", { body: { type: "vibes", content: "x" } });
  assert.equal(res.status, 400);
  assert.match(res.body.reason, /type/);
  assert.equal(stub.spies.createMemory.length, 0);
});

test("POST /memory with an out-of-range importance returns 400 naming the field", async () => {
  const stub = createStub();
  const res = await call(stub, "POST", "/memory", {
    body: { type: "note", content: "x", importance: 9 },
  });
  assert.equal(res.status, 400);
  assert.match(res.body.reason, /importance/);
});

test("POST /memory with a blank content returns 400 naming the field", async () => {
  const stub = createStub();
  const res = await call(stub, "POST", "/memory", { body: { type: "note", content: "  " } });
  assert.equal(res.status, 400);
  assert.match(res.body.reason, /content/);
});

test("GET /memory with a bad type returns 400 naming the field", async () => {
  const stub = createStub();
  const res = await call(stub, "GET", "/memory", { query: { type: "nonsense" } });
  assert.equal(res.status, 400);
  assert.match(res.body.reason, /type/);
});

// ── Notifications ──────────────────────────────────────────────────────────────

test("GET /notifications with a bad unreadOnly returns 400 naming the field", async () => {
  const stub = createStub();
  const res = await call(stub, "GET", "/notifications", { query: { unreadOnly: "maybe" } });
  assert.equal(res.status, 400);
  assert.match(res.body.reason, /unreadOnly/);
});

test("POST /notifications/:id/read unknown returns 404, known marks read", async () => {
  const stub = createStub();
  const missing = await call(stub, "POST", "/notifications/ghost/read");
  assert.equal(missing.status, 404);

  const found = await call(stub, "POST", "/notifications/n-1/read");
  assert.equal(found.status, 200);
  assert.deepEqual(stub.spies.markRead, ["n-1"]);
});

// ── POST /agents/:id/action ────────────────────────────────────────────────────

test("POST /agents/:id/action unknown agent returns 404", async () => {
  const stub = createStub();
  const res = await call(stub, "POST", "/agents/ghost/action", { body: { action: "do_thing" } });
  assert.equal(res.status, 404);
  assert.equal(stub.spies.runTask.length, 0);
});

test("POST /agents/:id/action without run_task returns 409 and never calls runTask", async () => {
  const stub = createStub();
  const res = await call(stub, "POST", "/agents/opencode/action", { body: { action: "do_thing" } });
  assert.equal(res.status, 409);
  assert.match(res.body.reason, /run_task/);
  assert.equal(stub.spies.runTask.length, 0);
});

// The next four tests replace one that asserted the opposite. Until Phase 1
// Part F, `POST /agents/:id/action` called the adapter directly, and the old
// test asserted exactly that: "with run_task calls the adapter and returns the
// result" was a test PINNING THE BYPASS. It is not weakened here, it is
// inverted — the action now has to earn its way through policy like everything
// else, and these tests are what stop the bypass being reintroduced.

test("POST /agents/:id/action cannot reach the adapter before policy allows it", async () => {
  const stub = createStub();
  const res = await call(stub, "POST", "/agents/hermes/action", {
    body: { action: "summarise", input: "the meeting notes" },
  });
  // EXTERNAL by default => parked, not run.
  assert.equal(res.status, 409);
  assert.equal(res.body.approvalRequired, true);
  assert.ok(res.body.approvalId, "the parked action must hand back the approval id");
  assert.equal(stub.spies.runTask.length, 0, "the adapter must not have been called");
  assert.equal(stub.spies.createdApprovals.length, 1, "an approval must have been recorded");
  assert.equal(stub.spies.createdApprovals[0]!.toolId, "agents.run_task");
  assert.equal(stub.spies.createdApprovals[0]!.risk, "EXTERNAL");
});

test("POST /agents/:id/action runs once the approval is granted, and only then", async () => {
  const stub = createStub();
  const parked = await call(stub, "POST", "/agents/hermes/action", { body: { action: "summarise" } });
  const approvalId = parked.body.approvalId as string;

  // A human says yes.
  stub.spies.createdApprovals[0]!.status = "APPROVED";

  const resumed = await call(stub, "POST", "/agents/hermes/action", {
    body: { action: "summarise", approvalId },
  });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.state, "completed");
  assert.equal(stub.spies.runTask.length, 1);
});

test("POST /agents/:id/action still refuses an approval issued for another tool", async () => {
  const stub = createStub();
  await call(stub, "POST", "/agents/hermes/action", { body: { action: "summarise" } });
  // Somebody else's approval, for a different tool, marked approved.
  stub.spies.createdApprovals.push({
    id: "ap-other",
    toolId: "fs.write",
    action: "write",
    reason: "unrelated",
    risk: "WRITE",
    createdAt: new Date().toISOString(),
    status: "APPROVED",
  });
  const res = await call(stub, "POST", "/agents/hermes/action", {
    body: { action: "summarise", approvalId: "ap-other" },
  });
  assert.equal(res.status, 403, "an approval authorises one tool and no other");
  assert.equal(stub.spies.runTask.length, 0);
});

test("POST /agents/:id/action with an unknown approvalId never executes", async () => {
  const stub = createStub();
  const res = await call(stub, "POST", "/agents/hermes/action", {
    body: { action: "summarise", approvalId: "ap-does-not-exist" },
  });
  assert.equal(res.status, 409);
  assert.equal(stub.spies.runTask.length, 0);
});

test("POST /agents/:id/action with a missing action returns 400 naming the field", async () => {
  const stub = createStub();
  const res = await call(stub, "POST", "/agents/hermes/action", { body: {} });
  assert.equal(res.status, 400);
  assert.match(res.body.reason, /action/);
});

// ── Failing dependency ─────────────────────────────────────────────────────────

test("a throwing dependency becomes a 500 JSON body with a reason and no internals", async () => {
  const stub = createStub();
  stub.setHealthThrows(true);
  const res = await call(stub, "GET", "/state");

  assert.equal(res.status, 500);
  assert.equal(res.body.error, true);
  assert.equal(typeof res.body.reason, "string");
  assert.ok(res.body.reason.length > 0);
  assert.equal(res.body.stack, undefined);

  const serialized = JSON.stringify(res.body);
  assert.doesNotMatch(serialized, /internal-path/);
  assert.doesNotMatch(serialized, /secret/);
  assert.doesNotMatch(serialized, /boom/);
});

// ── attachEventStream ──────────────────────────────────────────────────────────

test("attachEventStream writes a frame per event and stops after unsubscribe", async () => {
  const stub = createStub();
  const writes: string[] = [];
  let ended = false;

  const off = attachEventStream(stub.runtime, {
    write: (chunk: string) => writes.push(chunk),
    end: () => {
      ended = true;
    },
  });

  // Initial connect frame (a comment, so an EventSource knows it is live).
  assert.ok(writes.some((w) => w.startsWith(":")));

  const event = { id: "evt_1", type: "mission.created", timestamp: new Date().toISOString(), source: "core", payload: { title: "x" } };
  stub.emit(event);

  const frame = writes.find((w) => w.includes("mission.created"));
  assert.ok(frame !== undefined, "a frame was written for the published event");
  assert.match(frame!, /^data: /);
  assert.match(frame!, /\n\n$/);
  assert.equal(JSON.parse(frame!.slice("data: ".length).trim()).id, "evt_1");

  const countBefore = writes.length;
  off();
  assert.equal(ended, true);
  stub.emit({ ...event, id: "evt_2" });
  assert.equal(writes.length, countBefore, "no writes after unsubscribe");
});

// ── routes() ───────────────────────────────────────────────────────────────────

test("routes() lists every served path", async () => {
  const stub = createStub();
  const routes = createCoreApi(stub.runtime).routes();
  for (const expected of [
    "GET /state",
    "GET /agents",
    "GET /agents/:id",
    "POST /agents/:id/action",
    "GET /missions",
    "POST /missions",
    "GET /missions/:id",
    "POST /missions/:id/cancel",
    "GET /notifications",
    "POST /notifications/:id/read",
    "GET /approvals",
    "POST /approvals/:id/decide",
    "GET /memory",
    "POST /memory",
  ]) {
    assert.ok(routes.includes(expected), `routes() includes ${expected}`);
  }
});
