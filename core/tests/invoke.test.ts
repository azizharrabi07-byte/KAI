// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * `@` explicit invocation: parsing, resolution, and router execution.
 *
 * Pure parsing (leading tokens only, order kept) plus router behavior with a
 * stubbed invocation port: @Agent runs the agent, @Skill force-loads the body
 * into the brain turn, unknown/disabled/multi invocations are answered, never
 * executed. A parked agent run surfaces its approval for the UI Allow path.
 *
 * Run from `core/`:  node --test tests/invoke.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";

import { parseInvocations, resolveInvocations } from "../src/chat/invoke.ts";
import { createChatRouter, type RouterInvocationLike } from "../src/chat/router.ts";
import type { MemoryService } from "../src/memory/service.ts";

const DIRECTORY = {
  agents: [
    { id: "researcher", name: "Researcher" },
    { id: "coder", name: "Coder" },
  ],
  skills: [
    { id: "deep-research", name: "Deep Research", disabled: false },
    { id: "old-skill", name: "Old Skill", disabled: true },
  ],
};

function stubInvocations(overrides: Partial<RouterInvocationLike> = {}): RouterInvocationLike {
  return {
    agents: () => DIRECTORY.agents,
    skills: () => DIRECTORY.skills,
    runAgent: (input) =>
      Promise.resolve({ ok: true as const, reply: `${input.id} did: ${input.task}`, guarded: false }),
    loadSkill: (id: string) =>
      id === "deep-research"
        ? { ok: true as const, name: "Deep Research", body: "RESEARCH BODY" }
        : { ok: false as const, reason: "no such skill" },
    ...overrides,
  };
}

function scriptedBrain(text: string, seen: { system?: string; text?: string }) {
  return {
    available: () => true,
    describe: () => ({ provider: "test", model: "test", configured: true, tools: false, toolIds: [] }),
    respond: (input: { text: string; system: string }) => {
      seen.system = input.system;
      seen.text = input.text;
      return Promise.resolve({ text, model: "test", provider: "test", toolIterations: 0, maxToolIterations: 6, toolBudgetExhausted: false });
    },
    stream: () => (async function* () {})(),
    health: () => Promise.resolve({ ok: true, configured: true, provider: "test", baseUrl: "t", model: "test", reason: null }),
  };
}

const memory = { digest: () => [] } as unknown as MemoryService;

test("parse: leading @tokens split from content; mid-sentence @ is prose", () => {
  assert.deepEqual(parseInvocations("@Researcher analyze this"), { tokens: ["Researcher"], content: "analyze this" });
  assert.deepEqual(parseInvocations("@coder @deep-research go"), { tokens: ["coder", "deep-research"], content: "go" });
  assert.equal(parseInvocations("tell @Researcher hi"), null);
  assert.equal(parseInvocations("plain text"), null);
  assert.deepEqual(parseInvocations("@coder"), { tokens: ["coder"], content: "" });
});

test("resolve: agents by id or name, skills with disabled split out, unknown named", () => {
  const resolved = resolveInvocations({ tokens: ["Researcher", "deep-research"], content: "go" }, DIRECTORY);
  assert.deepEqual(resolved, { agents: ["researcher"], skills: ["deep-research"], unknown: [], disabledSkills: [], content: "go" });
  const unknown = resolveInvocations({ tokens: ["Nobody"], content: "go" }, DIRECTORY);
  assert.deepEqual(unknown.unknown, ["Nobody"]);
  const disabled = resolveInvocations({ tokens: ["old-skill"], content: "go" }, DIRECTORY);
  assert.deepEqual(disabled.disabledSkills, ["old-skill"]);
  assert.deepEqual(disabled.skills, []);
});

test("@Agent USES the agent: task runs, reply returns, interpretation recorded", async () => {
  const seen: { system?: string; text?: string } = {};
  const router = createChatRouter({
    runtime: { health: () => Promise.resolve({ agents: [], missions: { active: 0, unfinished: 0 }, notifications: { unread: 0 }, approvals: { pending: 0 } }), registry: { statusAll: () => Promise.resolve([]), get: () => undefined }, stores: { missions: { listMissions: () => [] }, scheduledTasks: { listScheduledTasks: () => [] } } },
    memory,
    brain: scriptedBrain("unused", seen),
    invocations: stubInvocations(),
  });
  const answer = await router.answer("@Researcher analyze these competitors");
  assert.ok(answer.text.includes("researcher did: analyze these competitors"), answer.text);
  assert.deepEqual(answer.invocation, { agents: ["researcher"], skills: [] });
  assert.equal(seen.text, undefined, "the model was never consulted for an agent turn");
});

test("@Skill force-loads its body into the brain turn", async () => {
  const seen: { system?: string; text?: string } = {};
  const router = createChatRouter({
    runtime: { health: () => Promise.resolve({ agents: [], missions: { active: 0, unfinished: 0 }, notifications: { unread: 0 }, approvals: { pending: 0 } }), registry: { statusAll: () => Promise.resolve([]), get: () => undefined }, stores: { missions: { listMissions: () => [] }, scheduledTasks: { listScheduledTasks: () => [] } } },
    memory,
    brain: scriptedBrain("skill-guided answer", seen),
    composePrompt: () => Promise.resolve("BASE SYSTEM"),
    invocations: stubInvocations(),
  });
  const answer = await router.answer("@deep-research compare these three products");
  assert.equal(answer.text, "skill-guided answer");
  assert.ok((seen.system ?? "").includes("BASE SYSTEM"), "the composed prompt stays");
  assert.ok((seen.system ?? "").includes("RESEARCH BODY"), "the invoked skill body rides along");
  assert.deepEqual(answer.invocation, { agents: [], skills: ["deep-research"] });
});

test("unknown, disabled, multi-agent and empty invocations are answered, never run", async () => {
  let ran = 0;
  const seen: { system?: string; text?: string } = {};
  const router = createChatRouter({
    runtime: { health: () => Promise.resolve({ agents: [], missions: { active: 0, unfinished: 0 }, notifications: { unread: 0 }, approvals: { pending: 0 } }), registry: { statusAll: () => Promise.resolve([]), get: () => undefined }, stores: { missions: { listMissions: () => [] }, scheduledTasks: { listScheduledTasks: () => [] } } },
    memory,
    brain: scriptedBrain("unused", seen),
    invocations: stubInvocations({ runAgent: () => {
      ran += 1;
      return Promise.resolve({ ok: true as const, reply: "x", guarded: false });
    } }),
  });
  const unknown = await router.answer("@Nobody do this");
  assert.match(unknown.text, /don't know @Nobody/);
  const disabled = await router.answer("@old-skill do this");
  assert.match(disabled.text, /disabled/);
  const multi = await router.answer("@researcher @coder do this");
  assert.match(multi.text, /pick one/);
  const empty = await router.answer("@coder");
  assert.match(empty.text, /no task/);
  assert.equal(ran, 0, "nothing ambiguous ever executed");
  assert.equal(seen.text, undefined);
});

test("a parked agent run surfaces its approval for the UI Allow path", async () => {
  const seen: { system?: string; text?: string } = {};
  const router = createChatRouter({
    runtime: { health: () => Promise.resolve({ agents: [], missions: { active: 0, unfinished: 0 }, notifications: { unread: 0 }, approvals: { pending: 0 } }), registry: { statusAll: () => Promise.resolve([]), get: () => undefined }, stores: { missions: { listMissions: () => [] }, scheduledTasks: { listScheduledTasks: () => [] } } },
    memory,
    brain: scriptedBrain("unused", seen),
    invocations: stubInvocations({
      runAgent: () => Promise.resolve({ ok: false as const, parked: true as const, approvalId: "apr-1", reason: "waiting" }),
    }),
  });
  const answer = await router.answer("@coder build it");
  assert.match(answer.text, /waiting for your approval/);
  assert.deepEqual(answer.agentRun, { subagentId: "coder", approvalId: "apr-1", reason: "waiting" });
});

test("@Agent + @Skill composes skill guidance into the agent task", async () => {
  let received = "";
  const seen: { system?: string; text?: string } = {};
  const router = createChatRouter({
    runtime: { health: () => Promise.resolve({ agents: [], missions: { active: 0, unfinished: 0 }, notifications: { unread: 0 }, approvals: { pending: 0 } }), registry: { statusAll: () => Promise.resolve([]), get: () => undefined }, stores: { missions: { listMissions: () => [] }, scheduledTasks: { listScheduledTasks: () => [] } } },
    memory,
    brain: scriptedBrain("unused", seen),
    invocations: stubInvocations({
      runAgent: (input) => {
        received = `${input.task} || ${input.skillContext ?? ""}`;
        return Promise.resolve({ ok: true as const, reply: "done", guarded: false });
      },
    }),
  });
  await router.answer("@coder @deep-research build it");
  assert.ok(received.includes("build it"), "the task survives");
  assert.ok(received.includes("RESEARCH BODY"), "the skill guidance rides into the agent run");
});

test("no invocation port: @text stays ordinary prose", async () => {
  const seen: { system?: string; text?: string } = {};
  const router = createChatRouter({
    runtime: { health: () => Promise.resolve({ agents: [], missions: { active: 0, unfinished: 0 }, notifications: { unread: 0 }, approvals: { pending: 0 } }), registry: { statusAll: () => Promise.resolve([]), get: () => undefined }, stores: { missions: { listMissions: () => [] }, scheduledTasks: { listScheduledTasks: () => [] } } },
    memory,
    brain: scriptedBrain("plain answer", seen),
  });
  const answer = await router.answer("@coder hi");
  assert.equal(answer.text, "plain answer");
  assert.equal(answer.invocation, undefined);
});
