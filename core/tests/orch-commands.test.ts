// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Orchestration commands + routes + autonomy + prefs.
 *
 * - `/refine` and `/review` run against a stub CommandRuntime built on the
 *   REAL session service + skill registry (the tests/commands.test.ts
 *   contextFor pattern), with scriptable brain / learning / reviewer /
 *   missions ports: no pattern is invented, every refusal is honest.
 * - Orchestration HTTP routes run against a REAL runtime (createCoreRuntime,
 *   mock agents) + createKaiServer on an ephemeral port.
 * - The autonomy matrix (autoVerdict) and orchestration prefs
 *   (readOrchestrationPrefs, validators, defaults) are pinned as pure units.
 *
 * Run from `core/`:  node --test tests/orch-commands.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { createSessionStore } from "../src/sessions/store.ts";
import { createSessionService } from "../src/sessions/service.ts";
import { createCoreRuntime } from "../src/runtime.ts";
import { createKaiServer } from "../src/server.ts";
import { loadConfig } from "../src/config.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import { createPolicyEngine } from "../src/policies/gate.ts";
import { createWorkspaceTools } from "../src/tools/workspace.ts";
import { createSkillRegistry } from "../src/skills/registry.ts";
import { createSkillStore } from "../src/skills/store.ts";
import { runCommand, type CommandRuntime } from "../src/commands/commands.ts";
import { autoVerdict } from "../src/orchestration/autonomy.ts";
import {
  ORCHESTRATION_KEYS,
  readOrchestrationPrefs,
  validateOrchestrationValue,
  type OrchestrationKey,
} from "../src/orchestration/prefs.ts";
import type { AutonomyPolicy } from "../src/orchestration/types.ts";
import type { SettingsStore, Mission } from "../src/shared/contracts.ts";
import type { ProposeInput, SkillCandidate, SubmitResult } from "../src/orchestration/learn.ts";

// ── Stub CommandRuntime (commands.test.ts contextFor pattern) ────────────────

interface ScriptState {
  brainRespond: (input: { text: string; system?: string; purpose?: string }) => Promise<{ text: string }>;
  brainPrompts: string[];
  learningPropose: (input: ProposeInput) => SkillCandidate | null;
  learningSubmit: (candidate: SkillCandidate, markdown: string) => SubmitResult;
  proposeCalls: number;
  submitCalls: number;
  reviewerReview: (id: string, criteria?: string[]) => Promise<{ verdict: string; findings: string[] } | { error: string }>;
  reviewerCalls: Array<{ id: string; criteria?: string[] }>;
  missions: Map<string, Mission>;
}

function contextFor(t: { after: (fn: () => void) => void }): { ctx: CommandRuntime; state: ScriptState } {
  const dir = mkdtempSync(join(tmpdir(), "kai-orch-commands-"));
  // One hook that closes the SQLite handle BEFORE removing the directory —
  // an open handle locks files on Windows and two separate hooks race.
  const store = createSessionStore({ path: join(dir, "sessions.db") });
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const sessions = createSessionService({ store });
  const tools = createToolRegistry({ policy: createPolicyEngine(), coreBuildId: "orch-commands-test" });
  for (const tool of createWorkspaceTools()) tools.register(tool);
  const skillStore = createSkillStore({ root: join(dir, "skills") });
  const skills = createSkillRegistry({ store: skillStore });

  const state: ScriptState = {
    brainRespond: () => Promise.reject(new Error("brain unused in this test")),
    brainPrompts: [],
    learningPropose: () => null,
    learningSubmit: () => ({ ok: false, refused: true, reason: "unscripted" }),
    proposeCalls: 0,
    submitCalls: 0,
    reviewerReview: () => Promise.resolve({ error: "unscripted reviewer" }),
    reviewerCalls: [],
    missions: new Map(),
  };

  const ctx: CommandRuntime = {
    sessions,
    tools,
    skills,
    mcp: {
      summary: () => ({ servers: 0, enabled: 0, connected: 0, tools: 0, resources: 0 }),
      listServers: () => [],
    },
    memory: {
      remember: () => ({ type: "note", content: "" }) as never,
      search: () => [],
      forget: () => false,
      digest: () => [],
    },
    memoryEngine: { search: () => [] } as never,
    brain: {
      available: () => true,
      describe: () => ({ provider: "test", model: "test-model", configured: true, tools: true, toolIds: [] }),
      respond: (input: { text: string; system?: string; purpose?: string }) => {
        state.brainPrompts.push(input.text);
        return state.brainRespond(input);
      },
      stream: () => (async function* () {})(),
      health: () => Promise.resolve({ ok: true, configured: true, provider: "test", baseUrl: "test", model: "test-model", reason: null }),
    } as never,
    model: {
      capabilities: () => ({ chat: true, stream: true, structured: true, embeddings: true, tools: true, models: [], defaultModel: "test-model" }),
      health: () => Promise.resolve({ ok: true, configured: true, provider: "test", baseUrl: "test", model: "test-model", reason: null }),
    } as never,
    subagents: { list: () => [] } as never,
    workers: () => Promise.resolve([]),
    createPlan: () => Promise.resolve({ ok: false, reason: "no planner in this test context" }),
    providers: { list: () => Promise.resolve([]) },
    learning: {
      propose: (input) => {
        state.proposeCalls += 1;
        return state.learningPropose(input);
      },
      submit: (candidate, markdown) => {
        state.submitCalls += 1;
        return state.learningSubmit(candidate, markdown);
      },
    },
    reviewer: {
      reviewWorkItem: (id, criteria) => {
        state.reviewerCalls.push({ id, ...(criteria !== undefined ? { criteria } : {}) });
        return state.reviewerReview(id, criteria);
      },
    },
    missions: {
      getMission: (id) => state.missions.get(id) ?? null,
    },
  };
  return { ctx, state };
}

function candidateFor(taskId: string): SkillCandidate {
  return {
    title: "Skill: lighthouse log migration",
    trigger: "Tasks like: migrate the lighthouse logs",
    method: "- collect the logs\n- migrate the schema",
    tools: [],
    constraints: ["Verified pattern — keep the verification step when reusing"],
    sourceTaskId: taskId,
    consideredSkillIds: [],
    pattern: "success",
  };
}

/** A session rich enough to learn from: user goal + assistant work + evidence. */
function richSessionId(ctx: CommandRuntime, title: string): string {
  const session = ctx.sessions.create({ title });
  ctx.sessions.recordTurn({ sessionId: session.id, role: "user", text: "Migrate the lighthouse logs to the new schema" });
  ctx.sessions.recordTurn({ sessionId: session.id, role: "assistant", text: "Collected the logs and mapped the old fields" });
  ctx.sessions.recordTurn({ sessionId: session.id, role: "user", text: "Continue with the migration" });
  ctx.sessions.recordTurn({ sessionId: session.id, role: "assistant", text: "Migrated the schema and verified row counts match" });
  const turns = ctx.sessions.turns(session.id);
  assert.ok(turns.ok && turns.value.length === 4);
  if (turns.ok) {
    const lastAssistant = [...turns.value].reverse().find((turn) => turn.role === "assistant");
    assert.ok(lastAssistant !== undefined);
    if (lastAssistant !== undefined) {
      ctx.sessions.recordToolCalls(session.id, lastAssistant.id, [
        {
          toolCallId: "call_verify",
          toolName: "verify_rows",
          toolId: "filesystem.search",
          arguments: "{}",
          status: "EXECUTED",
          result: { ok: true },
          startedAt: "2026-10-06T00:00:00.000Z",
          completedAt: "2026-10-06T00:00:01.000Z",
        },
      ]);
    }
  }
  return session.id;
}

function missionFixture(id: string): Mission {
  return {
    id,
    title: "Ship the lighthouse summary",
    status: "COMPLETED",
    priority: 0,
    createdAt: "2026-10-06T00:00:00.000Z",
    updatedAt: "2026-10-06T00:00:01.000Z",
    steps: [
      {
        id: "s0",
        missionId: id,
        index: 0,
        title: "Draft the summary",
        kind: "manual",
        status: "COMPLETED",
        sideEffecting: false,
        output: { text: "summary draft complete" },
      },
      {
        id: "s1",
        missionId: id,
        index: 1,
        title: "Verify the row counts",
        kind: "tool",
        target: "filesystem.search",
        status: "COMPLETED",
        sideEffecting: false,
      },
    ],
  };
}

// ── /refine ───────────────────────────────────────────────────────────────────

test("/refine with no session reports honestly instead of inventing a pattern", async (t) => {
  const { ctx } = contextFor(t);
  const ran = await runCommand("refine", [], ctx);
  assert.equal(ran.ok, true);
  if (ran.ok) {
    assert.equal(ran.result.title, "No session to learn from");
    assert.match(ran.result.text, /No active session/);
  }
  const named = await runCommand("refine", ["ghost-session"], ctx);
  assert.equal(named.ok, true);
  if (named.ok) {
    assert.equal(named.result.title, "No session to learn from");
    assert.match(named.result.text, /No session "ghost-session"/);
  }
});

test("/refine with a thin session reports nothing reusable", async (t) => {
  const { ctx } = contextFor(t);
  const session = ctx.sessions.create({ title: "Thin" });
  ctx.sessions.recordTurn({ sessionId: session.id, role: "user", text: "hello" });
  const ran = await runCommand("refine", [], ctx);
  assert.equal(ran.ok, true);
  if (ran.ok) {
    assert.equal(ran.result.title, "Nothing reusable yet");
    assert.match(ran.result.text, /no workflow to learn from/);
  }
});

test("/refine with a rich session runs propose -> draft -> stage and returns the staged id", async (t) => {
  const { ctx, state } = contextFor(t);
  const sessionId = richSessionId(ctx, "Rich");
  state.learningPropose = (input) => {
    assert.ok(input.objective.includes("lighthouse"), "the objective reaches propose");
    assert.ok(input.steps.length >= 2, "assistant steps reach propose");
    return candidateFor(input.taskId);
  };
  state.brainRespond = () => Promise.resolve({ text: "# Skill: lighthouse log migration\n\nBody." });
  state.learningSubmit = () => ({ ok: true, stagedId: "staged_1" });

  const ran = await runCommand("refine", [], ctx);
  assert.equal(ran.ok, true);
  if (ran.ok) {
    assert.equal(ran.result.title, "Skill proposed: Skill: lighthouse log migration");
    assert.equal((ran.result.data as { stagedId: string }).stagedId, "staged_1");
    assert.match(ran.result.text, /staged_1/);
  }
  assert.equal(state.proposeCalls, 1);
  assert.equal(state.submitCalls, 1);
  assert.ok(state.brainPrompts[0]?.includes("Skill: lighthouse log migration"), "the draft prompt carries the candidate");
  void sessionId;
});

test("/refine stages nothing when drafting fails", async (t) => {
  const { ctx, state } = contextFor(t);
  richSessionId(ctx, "Rich Draft Fail");
  state.learningPropose = (input) => candidateFor(input.taskId);
  state.brainRespond = () => Promise.resolve({ text: "   " });

  const ran = await runCommand("refine", [], ctx);
  assert.equal(ran.ok, true);
  if (ran.ok) assert.equal(ran.result.title, "Drafting failed");
  assert.equal(state.submitCalls, 0, "no draft, no staging");
});

// ── /review ───────────────────────────────────────────────────────────────────

test("/review with no target shows usage", async (t) => {
  const { ctx } = contextFor(t);
  const ran = await runCommand("review", [], ctx);
  assert.equal(ran.ok, true);
  if (ran.ok) {
    assert.equal(ran.result.title, "Review needs a target");
    assert.match(ran.result.text, /\/review <work-id/);
  }
});

test("/review routes work_ targets through the reviewer stub, PASS and CHANGES alike", async (t) => {
  const { ctx, state } = contextFor(t);
  state.reviewerReview = () => Promise.resolve({ verdict: "PASS", findings: ["solid evidence"] });
  const pass = await runCommand("review", ["work_1"], ctx);
  assert.equal(pass.ok, true);
  if (pass.ok) {
    assert.equal(pass.result.title, "Review: PASS");
    assert.match(pass.result.text, /solid evidence/);
    assert.equal((pass.result.data as { verdict: string }).verdict, "PASS");
  }

  state.reviewerReview = () => Promise.resolve({ verdict: "CHANGES_REQUESTED", findings: ["missing tests", "no evidence"] });
  const changes = await runCommand("review", ["work_2", "thorough"], ctx);
  assert.equal(changes.ok, true);
  if (changes.ok) {
    assert.equal(changes.result.title, "Review: CHANGES_REQUESTED");
    assert.match(changes.result.text, /missing tests/);
    assert.match(changes.result.text, /no evidence/);
  }
  assert.deepEqual(state.reviewerCalls[1], { id: "work_2", criteria: ["thorough"] });
});

test("/review builds a mission artifact from its steps", async (t) => {
  const { ctx, state } = contextFor(t);
  state.missions.set("mission_1", missionFixture("mission_1"));
  state.brainRespond = () => Promise.resolve({ text: "PASS\n- looks good" });

  const ran = await runCommand("review", ["mission_1"], ctx);
  assert.equal(ran.ok, true);
  if (ran.ok) {
    assert.equal(ran.result.title, "Review: PASS");
    assert.match(ran.result.text, /looks good/);
  }
  assert.ok(state.brainPrompts[0]?.includes("Draft the summary"), "the artifact carries the mission steps");
  assert.ok(state.brainPrompts[0]?.includes("REVIEW CONTRACT"), "the reviewer sees the contract shape");
});

test("/review builds a session artifact from its turns", async (t) => {
  const { ctx, state } = contextFor(t);
  const session = ctx.sessions.create({ title: "Review Me" });
  ctx.sessions.recordTurn({ sessionId: session.id, role: "user", text: "Summarize the beacon rota" });
  ctx.sessions.recordTurn({ sessionId: session.id, role: "assistant", text: "The rota covers four keepers" });
  state.brainRespond = () => Promise.resolve({ text: "CHANGES_REQUESTED\n- needs citations" });

  const ran = await runCommand("review", [session.id], ctx);
  assert.equal(ran.ok, true);
  if (ran.ok) assert.equal(ran.result.title, "Review: CHANGES_REQUESTED");
  assert.ok(state.brainPrompts[0]?.includes("beacon rota"), "the artifact carries the session turns");
});

test("/review of an unknown target is honest, and a brain failure is unavailable", async (t) => {
  const { ctx, state } = contextFor(t);
  const missing = await runCommand("review", ["ghost_999"], ctx);
  assert.equal(missing.ok, true);
  if (missing.ok) {
    assert.equal(missing.result.title, "Nothing to review");
    assert.match(missing.result.text, /ghost_999/);
  }

  state.missions.set("mission_9", missionFixture("mission_9"));
  state.brainRespond = () => Promise.reject(new Error("model down"));
  const down = await runCommand("review", ["mission_9"], ctx);
  assert.equal(down.ok, true);
  if (down.ok) assert.equal(down.result.title, "Reviewer unavailable");
});

// ── Autonomy matrix ───────────────────────────────────────────────────────────

function policy(level: AutonomyPolicy["level"], over: Partial<AutonomyPolicy> = {}): AutonomyPolicy {
  return {
    level,
    workerAuto: "AUTO",
    review: "AUTO",
    skillLearning: "AUTO_SAFE",
    budgets: { maxDepth: 2, maxRetries: 2 },
    maxDepth: 2,
    maxParallel: 3,
    taskRetentionDays: 30,
    ...over,
  };
}

test("autonomy: level 0 (Advisor) never acts on its own", () => {
  const zero = policy(0);
  for (const action of ["delegate", "review", "learn", "retry", "reassign"] as const) {
    assert.equal(autoVerdict(zero, action), "OFF", `level 0 ${action} is OFF`);
  }
});

test("autonomy: level 4 AUTO_SAFE learning runs automatically", () => {
  assert.equal(autoVerdict(policy(4, { skillLearning: "AUTO_SAFE" }), "learn"), "AUTO");
  assert.equal(autoVerdict(policy(3, { skillLearning: "PROPOSE" }), "learn"), "ASK", "Guardian proposes for a human");
});

test("autonomy: high-risk work always asks, whatever the level", () => {
  const hot = policy(4);
  for (const action of ["delegate", "review", "retry", "reassign"] as const) {
    assert.equal(autoVerdict(hot, action, "EXTERNAL"), "ASK", `${action} + EXTERNAL asks`);
    assert.equal(autoVerdict(hot, action, "DESTRUCTIVE"), "ASK", `${action} + DESTRUCTIVE asks`);
  }
});

test("autonomy: learning below level 3 stays off", () => {
  assert.equal(autoVerdict(policy(2, { skillLearning: "PROPOSE" }), "learn"), "OFF");
  assert.equal(autoVerdict(policy(2, { skillLearning: "AUTO_SAFE" }), "learn"), "OFF");
  assert.equal(autoVerdict(policy(1, { skillLearning: "AUTO_SAFE" }), "learn"), "OFF");
  assert.equal(autoVerdict(policy(2, { skillLearning: "OFF" }), "learn"), "OFF");
});

test("autonomy: delegation and review open up with level", () => {
  assert.equal(autoVerdict(policy(2), "delegate", "READ"), "AUTO");
  assert.equal(autoVerdict(policy(1), "delegate", "READ"), "AUTO", "level 1 still delegates READ-scoped work");
  assert.equal(autoVerdict(policy(1), "delegate", "WRITE"), "ASK", "level 1 asks beyond READ");
  assert.equal(autoVerdict(policy(3), "review"), "AUTO");
  assert.equal(autoVerdict(policy(2), "review"), "AUTO", "level 2 Operator auto-reviews; ASK would silently downgrade the pref");
  assert.equal(autoVerdict(policy(1), "review"), "ASK");
  assert.equal(autoVerdict(policy(2, { workerAuto: "OFF" }), "delegate", "READ"), "OFF", "an explicit OFF always wins");
});

// ── Prefs ─────────────────────────────────────────────────────────────────────

function memStore(initial: Record<string, string> = {}): SettingsStore {
  const rows = new Map(Object.entries(initial));
  const now = "2026-10-06T00:00:00.000Z";
  return {
    get: (key) => rows.get(key) ?? null,
    set: (key, value) => {
      rows.set(key, value);
    },
    delete: (key) => rows.delete(key),
    list: () => [...rows.entries()].map(([key, value]) => ({ key, value, updatedAt: now })),
  };
}

test("prefs: an empty store reads the documented defaults", () => {
  const prefs = readOrchestrationPrefs(memStore());
  assert.equal(prefs.autonomy.level, 2);
  assert.equal(prefs.autonomy.workerAuto, "ASK");
  assert.equal(prefs.autonomy.review, "ASK");
  assert.equal(prefs.autonomy.skillLearning, "PROPOSE");
  assert.equal(prefs.activity, "COMPACT");
  assert.equal(prefs.reasoning, "SUMMARY");
  assert.equal(prefs.toolsView, "COLLAPSED");
  assert.equal(prefs.agentsView, "COMPACT");
  assert.equal(prefs.autonomy.maxDepth, 2);
  assert.equal(prefs.autonomy.maxParallel, 3);
  assert.equal(prefs.autonomy.taskRetentionDays, 30);
});

test("prefs: invalid stored values fall back to defaults", () => {
  const prefs = readOrchestrationPrefs(
    memStore({
      "orchestration.autonomy": "soon",
      "orchestration.workerAuto": "SOMETIMES",
      "orchestration.review": "NEVER",
      "orchestration.skillLearning": "ALWAYS",
      "orchestration.activity": "LOUD",
      "orchestration.reasoning": "FULL",
      "orchestration.toolsView": "OPEN",
      "orchestration.agentsView": "WIDE",
      "orchestration.maxDepth": "deep",
      "orchestration.maxParallel": "many",
      "orchestration.maxRetries": "lots",
      "orchestration.taskRetentionDays": "forever",
    }),
  );
  assert.equal(prefs.autonomy.level, 2);
  assert.equal(prefs.autonomy.workerAuto, "ASK");
  assert.equal(prefs.autonomy.review, "ASK");
  assert.equal(prefs.autonomy.skillLearning, "PROPOSE");
  assert.equal(prefs.activity, "COMPACT");
  assert.equal(prefs.reasoning, "SUMMARY");
  assert.equal(prefs.toolsView, "COLLAPSED");
  assert.equal(prefs.agentsView, "COMPACT");
  assert.equal(prefs.autonomy.maxDepth, 2);
  assert.equal(prefs.autonomy.maxParallel, 3);
  assert.equal(prefs.autonomy.taskRetentionDays, 30);
});

test("prefs: every key validates a good value and refuses one bad value", () => {
  assert.equal(ORCHESTRATION_KEYS.length, 14);
  const cases: Array<{ key: OrchestrationKey; good: unknown; bad: unknown }> = [
    { key: "orchestration.autonomy", good: 2, bad: "9" },
    { key: "orchestration.workerAuto", good: "AUTO", bad: "AUTO_SAFE" },
    { key: "orchestration.review", good: "ASK", bad: "PROPOSE" },
    { key: "orchestration.skillLearning", good: "AUTO_SAFE", bad: "AUTO" },
    { key: "orchestration.activity", good: "VERBOSE", bad: "LOUD" },
    { key: "orchestration.reasoning", good: "SUMMARY", bad: "FULL" },
    { key: "orchestration.toolsView", good: "EXPANDED", bad: "OPEN" },
    { key: "orchestration.agentsView", good: "DETAILED", bad: "FULL" },
    { key: "orchestration.maxDepth", good: 3, bad: 0 },
    { key: "orchestration.maxParallel", good: 10, bad: 11 },
    { key: "orchestration.maxRetries", good: 0, bad: 6 },
    { key: "orchestration.taskRetentionDays", good: 365, bad: 0 },
    { key: "orchestration.decision", good: "deterministic+jev", bad: "jev" },
    { key: "orchestration.jevMaxCalls", good: 5, bad: 51 },
  ];
  assert.equal(cases.length, 14);
  for (const { key, good, bad } of cases) {
    const accepted = validateOrchestrationValue(key, good);
    assert.equal(accepted.ok, true, `${key} accepts ${JSON.stringify(good)}`);
    const refused = validateOrchestrationValue(key, bad);
    assert.equal(refused.ok, false, `${key} refuses ${JSON.stringify(bad)}`);
  }
});

// ── Orchestration HTTP routes (real runtime, ephemeral port) ──────────────────

const READ_OBJECTIVE = "Say hello and confirm you are online";

async function bootLive(t: { after: (fn: () => void | Promise<void>) => void }) {
  // Manual temp dir (not a hook rm): teardown MUST close the server and the
  // runtime BEFORE removing the directory — an open SQLite handle locks files
  // on Windows and a separate rm hook would race the close.
  const dir = mkdtempSync(join(tmpdir(), "kai-orch-live-"));
  const rt = createCoreRuntime({
    dbPath: join(dir, "core.db"),
    agents: { mode: "mock" },
    startScheduler: false,
    subsystemPaths: { runUpkeepOnStart: false, ledgerPath: join(dir, "ledger.db") },
  });
  await rt.start();
  const server = createKaiServer(loadConfig(process.env), { core: rt });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rt.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { rt, base, post };
}

test("LIVE: the per-item retry ceiling holds over the real HTTP boundary", async (t) => {
  const { rt, post } = await bootLive(t);

  // A persona on a worker that cannot answer, so every dispatch fails fast.
  const spawned = await rt.tools.invoke("workforce.subagent", {
    id: "ghost-runner",
    name: "Ghost",
    role: "worker",
    soul: "I fail on purpose.",
    workerId: "ghost-worker",
  });
  assert.equal(spawned.ok, true, spawned.ok ? "" : spawned.error.message);

  const createdRes = await post("/work-items", { objective: READ_OBJECTIVE, deliverable: "the answer" });
  assert.equal(createdRes.status, 201);
  // The API body is untrusted JSON: narrow, never assert a shape.
  const createdBody: unknown = await createdRes.json();
  const workItemId =
    createdBody !== null && typeof createdBody === "object" && "workItemId" in createdBody && typeof createdBody.workItemId === "string"
      ? createdBody.workItemId
      : "";
  assert.ok(workItemId.length > 0, "the API returned a work item id");

  // Default policy is maxRetries 2 (maxReassignments defaults to it), so the
  // SAME worker gets one initial dispatch plus two retries; the fourth entry is
  // refused at the boundary. Driven entirely over HTTP.
  const states: string[] = [];
  for (let i = 0; i < 4; i += 1) {
    const res = await post(`/work-items/${workItemId}/run`, { workerId: "ghost-runner" });
    const body: unknown = await res.json();
    states.push(body !== null && typeof body === "object" && "state" in body && typeof body.state === "string" ? body.state : "?");
  }
  assert.deepEqual(states, ["FAILED", "FAILED", "FAILED", "BLOCKED"], `states=${JSON.stringify(states)}`);

  // And the ceiling holds on further attempts — it is durable, not per-call.
  const againRes = await post(`/work-items/${workItemId}/run`, { workerId: "ghost-runner" });
  const againBody: unknown = await againRes.json();
  const againState =
    againBody !== null && typeof againBody === "object" && "state" in againBody && typeof againBody.state === "string" ? againBody.state : "?";
  const againNote =
    againBody !== null && typeof againBody === "object" && "note" in againBody && typeof againBody.note === "string" ? againBody.note : "";
  assert.equal(againState, "BLOCKED");
  assert.match(againNote, /budget exhausted/);
});

test("LIVE: work board, bench, and activity answer over real HTTP", async (t) => {
  const { rt, base, post } = await bootLive(t);

  const emptyItems = (await (await fetch(`${base}/work-items`)).json()) as { items: unknown[] };
  assert.deepEqual(emptyItems.items, [], "the board starts empty");

  const emptyBench = (await (await fetch(`${base}/bench`)).json()) as { workers: unknown[] };
  assert.deepEqual(emptyBench.workers, [], "no benchmarks exist yet");

  const emptyActivity = (await (await fetch(`${base}/activity`)).json()) as { events: unknown[] };
  assert.deepEqual(emptyActivity.events, [], "no activity happened yet");

  // With no personas nothing delegates — an honest refusal, not a fake item.
  const refused = await post("/work-items", { objective: READ_OBJECTIVE });
  assert.equal(refused.status, 200);
  const refusedBody = (await refused.json()) as { delegated: boolean; workItemId: string; note: string };
  assert.equal(refusedBody.delegated, false);
  assert.equal(refusedBody.workItemId, "");
  assert.ok(refusedBody.note.length > 0);

  // One persona is enough for a READ objective to route to a worker.
  const spawned = await rt.tools.invoke("workforce.subagent", {
    id: "researcher",
    name: "Researcher",
    role: "research",
    soul: "I am methodical, analytical and citation-focused.",
    workerId: "opencode",
  });
  assert.equal(spawned.ok, true, JSON.stringify(spawned.ok ? {} : spawned.error).slice(0, 300));

  const created = await post("/work-items", { objective: READ_OBJECTIVE });
  assert.equal(created.status, 201, "a routed objective creates a durable work item");
  const createdBody = (await created.json()) as {
    delegated: boolean;
    planned: boolean;
    workItemId: string;
    decision: { decision: string; rationale: string };
    note: string;
  };
  // Truthful dispatch: creating a work item is planning, not delegation. No
  // worker has started until the item is actually run.
  assert.equal(createdBody.delegated, false, "planning alone never reports a worker as started");
  assert.equal(createdBody.planned, true, "a durable work item exists and is runnable");
  assert.match(createdBody.workItemId, /^work_/);
  assert.ok(typeof createdBody.decision?.decision === "string", "the routing decision rides along");
  assert.ok(createdBody.note.length > 0);

  const listed = (await (await fetch(`${base}/work-items`)).json()) as { items: Array<{ id: string }> };
  assert.ok(listed.items.some((item) => item.id === createdBody.workItemId), "the item is listed");

  const inspected = await fetch(`${base}/work-items/${createdBody.workItemId}`);
  assert.equal(inspected.status, 200);
  const inspectedBody = (await inspected.json()) as { item: { id: string; state: string } };
  assert.equal(inspectedBody.item.id, createdBody.workItemId);

  // Reviewing an item with no handoff is a 400 with a reason, not a verdict.
  const earlyReview = await post(`/work-items/${createdBody.workItemId}/review`, {});
  assert.equal(earlyReview.status, 400);
  const earlyBody = (await earlyReview.json()) as { reason?: string; error?: boolean };
  assert.match(String(earlyBody.reason ?? ""), /no handoff/);

  // Back to no personas: running honestly reports that no worker exists.
  // No personas are created for this step — one is removed instead.
  assert.equal(rt.subagents.remove("researcher"), true);
  assert.deepEqual(rt.subagents.list(), []);
  const run = await post(`/work-items/${createdBody.workItemId}/run`, {});
  assert.equal(run.status, 200);
  const runBody = (await run.json()) as { workItemId: string; state: string; note: string };
  assert.equal(runBody.workItemId, createdBody.workItemId);
  assert.equal(runBody.state, "READY", "nothing claimed the item");
  assert.match(runBody.note, /no worker/i);
});
