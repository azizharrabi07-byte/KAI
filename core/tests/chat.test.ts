// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Chat router tests. Plain `node --test`, no dependencies, no network.
 * Run from `core/`:  node --test tests/chat.test.ts
 *
 * The runtime is a hand-built stub (NOT core/src/runtime.ts), so every number
 * the router reports can be traced to a value planted here — which is exactly
 * what these tests assert.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createChatRouter } from "../src/chat/router.ts";
import type { RouterContext, RouterIntent } from "../src/chat/router.ts";
import { createMemoryService } from "../src/memory/service.ts";
import type { MemoryService } from "../src/memory/service.ts";
import type {
  AgentStatus,
  Approval,
  KaiNotification,
  Memory,
  MemoryStore,
  Mission,
} from "../src/shared/contracts.ts";

// ── Fake memory store + service ───────────────────────────────────────────────

function fakeMemoryStore(): MemoryStore {
  const rows: Memory[] = [];
  return {
    createMemory(memory: Memory): void {
      rows.push({ ...memory });
    },
    getMemory(id: string): Memory | null {
      return rows.find((row) => row.id === id) ?? null;
    },
    listMemories(opts: { type?: Memory["type"]; limit?: number } = {}): Memory[] {
      let out = rows.slice().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      if (opts.type !== undefined) out = out.filter((row) => row.type === opts.type);
      if (opts.limit !== undefined) out = out.slice(0, Math.max(0, opts.limit));
      return out;
    },
    updateMemory(): void {},
    deleteMemory(id: string): void {
      const i = rows.findIndex((row) => row.id === id);
      if (i >= 0) rows.splice(i, 1);
    },
  };
}

function memoryHarness(): MemoryService {
  let id = 0;
  return createMemoryService({
    store: fakeMemoryStore(),
    idFactory: () => `m${id++}`,
    defaultImportance: 4,
  });
}

// ── Stub runtime ──────────────────────────────────────────────────────────────

interface HarnessOptions {
  agents?: AgentStatus[];
  missions?: Mission[];
  activeMissions?: number;
  unfinishedMissions?: number;
  pendingApprovals?: number;
  unreadNotifications?: number;
  approvals?: Approval[];
  notifications?: KaiNotification[];
  /** When false, the optional approvals/notifications services are omitted. */
  withApprovalService?: boolean;
}

interface Harness {
  ctx: RouterContext;
  calls: Record<string, number>;
}

function mission(id: string, title: string, status: Mission["status"]): Mission {
  const at = new Date(Date.parse("2026-01-02T03:04:05.000Z")).toISOString();
  return {
    id,
    title,
    status,
    priority: 1,
    createdAt: at,
    updatedAt: at,
    steps: [],
  };
}

function buildHarness(opts: HarnessOptions = {}): Harness {
  const agents = opts.agents ?? [];
  const missions = opts.missions ?? [];
  const approvals = opts.approvals ?? [];
  const notifications = opts.notifications ?? [];
  const calls: Record<string, number> = {
    health: 0,
    statusAll: 0,
    listMissions: 0,
    approvalsList: 0,
    notificationsList: 0,
  };
  const bump = (key: string): void => {
    calls[key] = (calls[key] ?? 0) + 1;
  };

  const runtime: RouterContext["runtime"] = {
    async health() {
      bump("health");
      return {
        ok: true,
        agents,
        missions: {
          active: opts.activeMissions ?? 0,
          unfinished: opts.unfinishedMissions ?? opts.activeMissions ?? 0,
        },
        notifications: { unread: opts.unreadNotifications ?? 0 },
        approvals: { pending: opts.pendingApprovals ?? 0 },
      };
    },
    registry: {
      async statusAll() {
        bump("statusAll");
        return agents;
      },
      get() {
        return undefined;
      },
    },
    stores: {
      missions: {
        listMissions() {
          bump("listMissions");
          return missions;
        },
      },
      scheduledTasks: {
        listScheduledTasks() {
          return [];
        },
      },
    },
  };

  if (opts.withApprovalService !== false) {
    runtime.approvals = {
      list() {
        bump("approvalsList");
        return approvals;
      },
    };
  }
  if (opts.withApprovalService !== false) {
    runtime.notifications = {
      list() {
        bump("notificationsList");
        return notifications;
      },
    };
  }

  return { ctx: { runtime, memory: memoryHarness() }, calls };
}

function integersIn(text: string): number[] {
  return (text.match(/\d+/g) ?? []).map((n) => Number.parseInt(n, 10));
}

// ── identity ──────────────────────────────────────────────────────────────────

/**
 * A hand-built soul, so the identity answers are pinned to a known text rather
 * than to whatever `SOUL.md` happens to be on this machine. The real provider
 * (agent/soul.ts) is structurally assignable to `RouterIdentityLike`.
 */
const TEST_SOUL = {
  selfDescription: (): string => "I am KAI, the user's own agent on this machine.",
  identity: (): { soul: string; version: string } => ({
    soul: "I am KAI, the user's own agent on this machine.",
    version: "testsoul",
  }),
};

function withIdentity(ctx: RouterContext): RouterContext {
  return { ...ctx, identity: TEST_SOUL };
}

// ── classify ──────────────────────────────────────────────────────────────────

test("classify is deterministic, case-insensitive and punctuation-tolerant", () => {
  const { ctx } = buildHarness();
  const router = createChatRouter(ctx);
  const cases: Array<[string, RouterIntent]> = [
    ["what's happening", "status.summary"],
    ["What's happening?", "status.summary"],
    ["what is going on", "status.summary"],
    ["status", "status.summary"],
    ["STATUS!", "status.summary"],
    ["how are you", "status.summary"],
    ["what's hermes doing", "agent.status"],
    ["is opencode busy", "agent.status"],
    ["agent status", "agent.status"],
    ["what missions are running", "mission.list"],
    ["list missions", "mission.list"],
    ["do I have any notifications", "notification.list"],
    ["what needs my approval", "approval.list"],
    ["what do you remember", "memory.list"],
    ["recall", "memory.list"],
    ["remember that the build is green", "memory.remember"],
    ["remember: project X has failing tests", "memory.remember"],
    ["run the tests", "artifact.run_tests"],
    ["run the test suite", "artifact.run_tests"],
    ["tell me a joke", "unknown"],
    ["", "unknown"],
  ];
  for (const [text, expected] of cases) {
    assert.equal(router.classify(text), expected, `classify(${JSON.stringify(text)})`);
  }
});

test("intents() documents every intent, including unknown", () => {
  const { ctx } = buildHarness();
  const router = createChatRouter(ctx);
  const docs = router.intents();
  const seen = new Set(docs.map((doc) => doc.intent));
  const expected: RouterIntent[] = [
    "identity",
    "status.summary",
    "agent.status",
    "agent.list",
    "mission.list",
    "approval.list",
    "notification.list",
    "memory.list",
    "memory.remember",
    "artifact.run_tests",
    "unknown",
  ];
  for (const intent of expected) {
    assert.ok(seen.has(intent), `intents() missing ${intent}`);
    const doc = docs.find((d) => d.intent === intent);
    assert.ok(doc !== undefined);
    assert.ok(doc.examples.length > 0, `intent ${intent} has no examples`);
    assert.ok(doc.description.length > 0, `intent ${intent} has no description`);
  }
});

// ── identity ──────────────────────────────────────────────────────────────────

test("identity questions are answered by KAI from its soul, never by a worker", async () => {
  const { ctx } = buildHarness({ agents: [{ id: "hermes", state: "idle" }] });
  const router = createChatRouter(withIdentity(ctx));
  const questions = [
    "Who are you?",
    "What are you?",
    "Who made you?",
    "Which model are you?",
    "What are you running on?",
    "Are you Hermes?",
    "Are you OpenCode?",
    "Are you Claude?",
  ];
  for (const q of questions) {
    const answer = await router.answer(q);
    assert.equal(answer.intent, "identity", `classify(${JSON.stringify(q)})`);
    assert.equal(answer.fromState, true, q);
    assert.ok(answer.text.includes("KAI"), `${q} -> ${answer.text}`);
    // The worker's own voice must not be in KAI's mouth.
    assert.ok(
      !/\bI(?:'m| am)\s+(?:Hermes|OpenCode|Claude)\b/i.test(answer.text),
      `${q} leaked a worker self-identification: ${answer.text}`,
    );
    assert.ok(!/Nous Research/i.test(answer.text), `${q} -> ${answer.text}`);
  }
});

test("'Are you Hermes?' is DENIED, not answered as a worker-status report", async () => {
  const { ctx } = buildHarness({ agents: [{ id: "hermes", state: "idle" }] });
  const router = createChatRouter(withIdentity(ctx));

  // The identity question is captured by `identity` and can never reach the
  // `agent.status` rule that matches the bare word "hermes".
  assert.equal(router.classify("Are you Hermes?"), "identity");
  assert.equal(router.classify("are you opencode"), "identity");

  const answer = await router.answer("Are you Hermes?");
  assert.equal(answer.intent, "identity");
  assert.notEqual(answer.intent, "agent.status");
  assert.match(answer.text, /not what I am/i);
  assert.ok(!answer.text.includes("is idle"), `must not report worker status: ${answer.text}`);
});

test("'What's Hermes doing?' still reports the worker from state", async () => {
  const { ctx } = buildHarness({ agents: [{ id: "hermes", state: "idle" }] });
  const router = createChatRouter(withIdentity(ctx));

  assert.equal(router.classify("What's Hermes doing?"), "agent.status");
  const answer = await router.answer("What's Hermes doing?");
  assert.equal(answer.intent, "agent.status");
  assert.equal(answer.fromState, true);
  assert.match(answer.text, /hermes is idle/i);
});

test("identity falls back to the built-in soul when no soul is injected", async () => {
  const { ctx } = buildHarness();
  const router = createChatRouter(ctx);
  const answer = await router.answer("Who are you?");
  assert.equal(answer.intent, "identity");
  assert.ok(answer.text.includes("KAI"), answer.text);
});

test("a model/provider question is answered from the LIVE provider, never by listing tools", async () => {
  // The defect this pins: "Which API or LLM are you using?" reached the model,
  // whose only concrete "API" surface on the wire is its own tool catalogue, so
  // it answered by enumerating filesystem and git tools. The identity intent now
  // owns this question and answers it from the live provider's description.
  const { ctx } = buildHarness();
  const brain = {
    available: () => true,
    describe: () => ({
      provider: "mistral",
      model: "codestral-latest",
      configured: true,
      tools: true,
      toolIds: ["filesystem.read", "shell.run"],
    }),
    respond: async () => ({ text: "" }),
    stream: async function* () {},
    health: async () => ({ ok: true }),
  } as unknown as RouterContext["brain"];
  const router = createChatRouter({ ...withIdentity(ctx), brain });

  for (const question of [
    "Which API or LLM are you using right now?",
    "Which API or LLM are you using?",
    "which provider are you using",
    "what llm are you",
  ]) {
    const answer = await router.answer(question);
    assert.equal(answer.intent, "identity", question);
    assert.equal(answer.fromState, true, question);
    assert.ok(answer.text.includes("mistral"), `provider missing for ${question}: ${answer.text}`);
    assert.ok(
      answer.text.includes("codestral-latest"),
      `model missing for ${question}: ${answer.text}`,
    );
    // The failure mode itself: a tool catalogue is never the answer to this.
    assert.doesNotMatch(answer.text, /filesystem\.|shell\.run|git_status/);
  }
});

test("a model/provider question with no brain reports unknown rather than inventing a model", async () => {
  // No brain => nothing to read. KAI must say it does not run a model itself,
  // and must never name a provider or model it cannot actually verify.
  const { ctx } = buildHarness();
  const router = createChatRouter(withIdentity(ctx));
  for (const question of ["Which API or LLM are you using?", "Which model are you?"]) {
    const answer = await router.answer(question);
    assert.equal(answer.intent, "identity", question);
    assert.ok(answer.text.includes("not a model myself"), answer.text);
    assert.doesNotMatch(answer.text, /mistral|codestral|openai|gpt/i, answer.text);
  }
});

// ── status.summary ────────────────────────────────────────────────────────────

test("status.summary reports the stub's numbers and invents none", async () => {
  const { ctx } = buildHarness({
    agents: [
      { id: "hermes", state: "idle" },
      { id: "opencode", state: "working" },
    ],
    activeMissions: 7,
    unfinishedMissions: 7,
    pendingApprovals: 0,
    unreadNotifications: 0,
  });
  const router = createChatRouter(ctx);

  const answer = await router.answer("What's happening?");
  assert.equal(answer.intent, "status.summary");
  assert.equal(answer.fromState, true);
  assert.ok(answer.text.includes("7"), `expected "7" in: ${answer.text}`);
  assert.ok(answer.text.includes("hermes"));
  assert.ok(answer.text.includes("opencode"));

  // Every integer in the answer came from the stub state: {agentCount, active, pending}.
  const allowed = new Set([2, 7, 0]);
  for (const n of integersIn(answer.text)) {
    assert.ok(allowed.has(n), `answer leaked an un-derived number ${n}: ${answer.text}`);
  }
});

// ── agent.status ──────────────────────────────────────────────────────────────

test("agent.status names the asked agent and its real state", async () => {
  const { ctx } = buildHarness({
    agents: [
      { id: "hermes", state: "working", currentTask: "reviewing PR #12" },
      { id: "opencode", state: "idle" },
    ],
  });
  const router = createChatRouter(ctx);

  const hermes = await router.answer("what's hermes doing");
  assert.equal(hermes.intent, "agent.status");
  assert.equal(hermes.fromState, true);
  assert.ok(hermes.text.startsWith("hermes "));
  assert.ok(hermes.text.includes("working"));
  assert.ok(hermes.text.includes("reviewing PR #12"));

  const opencode = await router.answer("is opencode busy");
  assert.equal(opencode.fromState, true);
  assert.ok(opencode.text.startsWith("opencode "));
  assert.ok(opencode.text.includes("idle"));
});

test("agent.status says plainly when the asked agent is offline", async () => {
  const { ctx } = buildHarness({ agents: [{ id: "hermes", state: "offline" }] });
  const router = createChatRouter(ctx);

  const answer = await router.answer("what's hermes doing");
  assert.equal(answer.fromState, true);
  assert.ok(answer.text.includes("hermes is offline"), answer.text);
});

test("agent.status is honest when the asked agent is not registered", async () => {
  const { ctx } = buildHarness({ agents: [{ id: "opencode", state: "idle" }] });
  const router = createChatRouter(ctx);

  const answer = await router.answer("what's hermes doing");
  assert.equal(answer.fromState, true);
  assert.ok(answer.text.includes("not connected"), answer.text);
});

// ── agent.list ────────────────────────────────────────────────────────────────

test("agent.list reports the registered agents from state", async () => {
  const { ctx } = buildHarness({
    agents: [
      { id: "hermes", state: "idle" },
      { id: "opencode", state: "offline" },
    ],
  });
  const router = createChatRouter(ctx);

  const answer = await router.answer("list agents");
  assert.equal(answer.intent, "agent.list");
  assert.equal(answer.fromState, true);
  assert.ok(answer.text.includes("hermes"));
  assert.ok(answer.text.includes("opencode"));
  for (const n of integersIn(answer.text)) {
    assert.equal(n, 2, `unexpected number ${n} in: ${answer.text}`);
  }
});

// ── mission.list ──────────────────────────────────────────────────────────────

test("mission.list counts and names the missions from the store", async () => {
  const { ctx } = buildHarness({
    missions: [
      mission("m1", "Deploy blog", "RUNNING"),
      mission("m2", "Fix tests", "RUNNING"),
      mission("m3", "Write docs", "COMPLETED"),
    ],
  });
  const router = createChatRouter(ctx);

  const running = await router.answer("what missions are running");
  assert.equal(running.intent, "mission.list");
  assert.equal(running.fromState, true);
  assert.ok(running.text.includes("2 running mission(s)"), running.text);
  assert.ok(running.text.includes("Deploy blog"));
  assert.ok(!running.text.includes("Write docs"));

  const all = await router.answer("list missions");
  assert.equal(all.fromState, true);
  assert.ok(all.text.includes("3 mission(s)"), all.text);
  assert.ok(all.text.includes("Write docs"));
});

test("mission.list reports an empty list honestly", async () => {
  const { ctx } = buildHarness({ missions: [] });
  const router = createChatRouter(ctx);
  const answer = await router.answer("what missions are running");
  assert.equal(answer.fromState, true);
  assert.ok(answer.text.includes("No missions are running"), answer.text);
});

// ── approval.list / notification.list ─────────────────────────────────────────

test("approval.list reports the pending approvals from state", async () => {
  const approvals: Approval[] = [
    { id: "a1", toolId: "fs.write", action: "write file", reason: "edit", risk: "WRITE", createdAt: new Date().toISOString(), status: "PENDING" },
    { id: "a2", toolId: "net.post", action: "post webhook", reason: "notify", risk: "EXTERNAL", createdAt: new Date().toISOString(), status: "PENDING" },
    { id: "a3", toolId: "db.drop", action: "drop table", reason: "cleanup", risk: "DESTRUCTIVE", createdAt: new Date().toISOString(), status: "PENDING" },
  ];
  const { ctx } = buildHarness({ approvals, pendingApprovals: 3 });
  const router = createChatRouter(ctx);

  const answer = await router.answer("what needs my approval");
  assert.equal(answer.intent, "approval.list");
  assert.equal(answer.fromState, true);
  assert.ok(answer.text.includes("3 approval(s)"), answer.text);
  assert.ok(answer.text.includes("drop table"));
});

test("approval.list falls back to health counts when no list service is injected", async () => {
  const { ctx } = buildHarness({ pendingApprovals: 5, withApprovalService: false });
  const router = createChatRouter(ctx);

  const answer = await router.answer("any approvals");
  assert.equal(answer.intent, "approval.list");
  assert.equal(answer.fromState, true);
  assert.ok(answer.text.includes("5"), answer.text);
});

test("notification.list reports unread notifications from state", async () => {
  const notifications: KaiNotification[] = [
    { id: "n1", type: "mission.failed", title: "Mission failed", priority: "HIGH", createdAt: new Date().toISOString(), read: false },
    { id: "n2", type: "info", title: "Backup done", priority: "LOW", createdAt: new Date().toISOString(), read: false },
  ];
  const { ctx } = buildHarness({ notifications, unreadNotifications: 2 });
  const router = createChatRouter(ctx);

  const answer = await router.answer("do I have any notifications");
  assert.equal(answer.intent, "notification.list");
  assert.equal(answer.fromState, true);
  assert.ok(answer.text.includes("2 unread notification(s)"), answer.text);
  assert.ok(answer.text.includes("Mission failed"));
});

// ── memory ────────────────────────────────────────────────────────────────────

test("memory.remember stores a note and confirms with the stored content", async () => {
  const harness = buildHarness();
  const router = createChatRouter(harness.ctx);

  const answer = await router.answer("remember that the build is green.");
  assert.equal(answer.intent, "memory.remember");
  assert.equal(answer.fromState, true);
  assert.ok(answer.text.includes("the build is green"), answer.text);

  const stored = harness.ctx.memory.search({ type: "note" });
  assert.equal(stored.length, 1);
  assert.equal(stored[0]?.content, "the build is green"); // trailing period stripped
  assert.equal(stored[0]?.source, "user_statement");
});

test("memory.remember with an empty fact is a clear message, not a silent no-op", async () => {
  const harness = buildHarness();
  const router = createChatRouter(harness.ctx);

  const answer = await router.answer("remember that   ");
  assert.equal(answer.intent, "memory.remember");
  assert.equal(answer.fromState, false);
  assert.match(answer.text, /nothing to remember/i);
  assert.equal(harness.ctx.memory.search().length, 0);
});

test("memory.list answers from the digest and says so when empty", async () => {
  const harness = buildHarness();
  const router = createChatRouter(harness.ctx);

  const empty = await router.answer("what do you remember");
  assert.equal(empty.intent, "memory.list");
  assert.equal(empty.fromState, true);
  assert.match(empty.text, /don't have anything remembered/i);

  await router.answer("remember: Project X has failing tests");
  const populated = await router.answer("recall");
  assert.equal(populated.fromState, true);
  assert.ok(populated.text.includes("Project X has failing tests"), populated.text);
});

// ── artifact.run_tests ────────────────────────────────────────────────────────

test("artifact.run_tests runs nothing and says so", async () => {
  const harness = buildHarness({
    agents: [{ id: "hermes", state: "idle" }],
    activeMissions: 7,
  });
  const router = createChatRouter(harness.ctx);

  const before = { ...harness.calls };
  const answer = await router.answer("run the test suite");
  const after = { ...harness.calls };

  assert.equal(answer.intent, "artifact.run_tests");
  assert.equal(answer.fromState, true);
  assert.match(answer.text, /has not executed/i);
  assert.match(answer.text, /tool\/policy path/i);
  // Nothing on the runtime (or memory) was touched: this module is not a shell.
  assert.deepEqual(after, before);
  for (const value of Object.values(after)) assert.equal(value, 0);
});

// ── unknown / delegation ──────────────────────────────────────────────────────

test("unknown with hermes connected delegates to hermes", async () => {
  const { ctx } = buildHarness({
    agents: [
      { id: "hermes", state: "idle" },
      { id: "opencode", state: "idle" },
    ],
  });
  const router = createChatRouter(ctx);

  const answer = await router.answer("what's the weather");
  assert.equal(answer.intent, "unknown");
  assert.equal(answer.fromState, false);
  assert.equal(answer.delegateTo, "hermes");
  assert.ok(answer.text.includes("Hermes"));
});

test("unknown with only opencode connected delegates to opencode", async () => {
  const { ctx } = buildHarness({
    agents: [
      { id: "hermes", state: "offline" },
      { id: "opencode", state: "idle" },
    ],
  });
  const router = createChatRouter(ctx);

  const answer = await router.answer("write me a poem");
  assert.equal(answer.intent, "unknown");
  assert.equal(answer.fromState, false);
  assert.equal(answer.delegateTo, "opencode");
});

test("unknown with no agent connected claims nothing and delegates to nobody", async () => {
  const { ctx } = buildHarness({
    agents: [
      { id: "hermes", state: "offline" },
      { id: "opencode", state: "offline" },
    ],
  });
  const router = createChatRouter(ctx);

  const answer = await router.answer("tell me a joke");
  assert.equal(answer.intent, "unknown");
  assert.equal(answer.fromState, false);
  assert.equal(answer.delegateTo, undefined);
  assert.match(answer.text, /no agent is connected/i);
});

test("unknown delegates to nobody when the registry is empty", async () => {
  const { ctx } = buildHarness({ agents: [] });
  const router = createChatRouter(ctx);

  const answer = await router.answer("hello there");
  assert.equal(answer.intent, "unknown");
  assert.equal(answer.delegateTo, undefined);
  assert.equal(answer.fromState, false);
});

test("a health probe that throws does not become an invented answer", async () => {
  const harness = buildHarness({ agents: [{ id: "hermes", state: "idle" }] });
  harness.ctx.runtime = {
    ...harness.ctx.runtime,
    async health() {
      throw new Error("database locked");
    },
  };
  const router = createChatRouter(harness.ctx);

  const summary = await router.answer("status");
  assert.equal(summary.fromState, true);
  assert.match(summary.text, /could not read|won't guess/i);

  const unknown = await router.answer("something else entirely");
  assert.equal(unknown.delegateTo, undefined);
  assert.equal(unknown.fromState, false);
});

// ── KAI's own identity foundation: capabilities, harness, independence ─────────

function withCapabilities(ctx: RouterContext): RouterContext {
  return {
    ...ctx,
    capabilities: {
      list: () => [
        { id: "system", name: "System and state inspection", availability: "AVAILABLE", provider: "kai" },
        { id: "filesystem", name: "Filesystem", availability: "AVAILABLE", provider: "kai" },
        { id: "shell", name: "Shell (program execution)", availability: "AVAILABLE", provider: "kai" },
        { id: "someEmployeeThing", name: "employee provided", availability: "AVAILABLE", provider: "worker-x" },
      ],
    },
  };
}

test("'What can you do?' is answered from KAI's OWN capability registry, never a worker's", async () => {
  const { ctx } = buildHarness({ agents: [{ id: "hermes", state: "idle" }] });
  const router = createChatRouter(withCapabilities(withIdentity(ctx)));

  assert.equal(router.classify("what can you do?"), "capability.list");
  assert.equal(router.classify("what are your capabilities"), "capability.list");
  assert.equal(router.classify("capabilities"), "capability.list");

  const answer = await router.answer("what can you do?");
  assert.equal(answer.intent, "capability.list");
  assert.equal(answer.fromState, true);
  // KAI's direct capabilities are named, with the live availability overlaid.
  assert.match(answer.text, /filesystem \(available\)/i);
  assert.match(answer.text, /I'm KAI/);
  // A worker-provided capability is NOT reported as KAI's own.
  assert.ok(!answer.text.includes("someEmployeeThing"), answer.text);
  // And no worker identity leaked into the answer.
  assert.ok(!/Nous Research/i.test(answer.text));
  assert.ok(!/(?:i am|i'm)\s+(?:hermes|opencode)/i.test(answer.text));
});

test("'What can you do?' without a registry still states KAI's taxonomy, with no fake availability", async () => {
  const { ctx } = buildHarness();
  const router = createChatRouter(withIdentity(ctx));
  const answer = await router.answer("what can you do");
  assert.equal(answer.intent, "capability.list");
  assert.match(answer.text, /filesystem/);
  assert.match(answer.text, /Hermes, OpenCode, Codex/);
  assert.ok(!/\(available\)/i.test(answer.text), "no availability is invented without a registry reading");
});

test("'What can you not do?' is answered from KAI's own limits", async () => {
  const { ctx } = buildHarness();
  const router = createChatRouter(withIdentity(ctx));
  assert.equal(router.classify("what can you not do?"), "capability.limits");
  assert.equal(router.classify("what can't you do?"), "capability.limits");
  const answer = await router.answer("what can you not do?");
  assert.equal(answer.intent, "capability.limits");
  assert.match(answer.text, /not myself a language model/i);
});

test("'Do you have a harness?' is answered from KAI's own runtime architecture", async () => {
  const { ctx } = buildHarness();
  const router = createChatRouter(withIdentity(ctx));
  assert.equal(router.classify("do you have a harness?"), "harness");
  assert.equal(router.classify("what is your harness"), "harness");
  const answer = await router.answer("do you have a harness?");
  assert.equal(answer.intent, "harness");
  assert.match(answer.text, /KAI Core/);
  assert.match(answer.text, /isn't Hermes's/);
});

test("independence questions are answered from KAI's architecture, never as worker status", async () => {
  const { ctx } = buildHarness({
    agents: [
      { id: "hermes", state: "offline" },
      { id: "opencode", state: "idle" },
    ],
  });
  const router = createChatRouter(withIdentity(ctx));

  for (const q of [
    "can you work without Hermes?",
    "what happens if Hermes is offline?",
    "are you connected to Hermes?",
    "do you need Hermes?",
  ]) {
    assert.equal(router.classify(q), "independence", `classify(${JSON.stringify(q)})`);
    const answer = await router.answer(q);
    assert.equal(answer.intent, "independence");
    assert.equal(answer.fromState, true);
    assert.match(answer.text, /don't need a worker/i, q);
    assert.ok(!/hermes is idle/i.test(answer.text), `${q} must not be a status report: ${answer.text}`);
  }

  // The workforce-status question is UNCHANGED: still a status answer.
  assert.equal(router.classify("what's hermes doing?"), "agent.status");
  const status = await router.answer("what's hermes doing?");
  assert.equal(status.intent, "agent.status");
  assert.match(status.text, /hermes is offline/);
});

test("identity/first-person questions still never leak a worker's self-description", async () => {
  const { ctx } = buildHarness({ agents: [{ id: "hermes", state: "idle" }] });
  const router = createChatRouter(withCapabilities(withIdentity(ctx)));
  for (const q of ["Who are you?", "What can you do?", "Do you have a harness?", "Can you work without Hermes?"]) {
    const answer = await router.answer(q);
    assert.ok(!/Nous Research/i.test(answer.text), q);
    assert.ok(!/(?:i am|i'm)\s+(?:hermes|opencode|claude|codex)\b/i.test(answer.text), `${q} -> ${answer.text}`);
  }
});
