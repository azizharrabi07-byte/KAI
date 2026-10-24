// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * P10-P11 — plans are structured, validated, DRAFT-only artifacts.
 *
 * parsePlanDraft refuses malformed model output with reasons; createPlan
 * validates tool/agent targets against the LIVE registries and persists a
 * DRAFT mission that runs nothing; starting it through the executor runs the
 * steps (manual steps complete with a note) and completes the mission.
 *
 * Run from `core/`:  node --test tests/plans.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPlan, parsePlanDraft } from "../src/plans/plans.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import { createPolicyEngine } from "../src/policies/gate.ts";
import { createWorkspaceTools } from "../src/tools/workspace.ts";
import { createCoreRuntime } from "../src/runtime.ts";
import { createMission } from "../src/missions/mission.ts";
import type { Mission } from "../src/shared/contracts.ts";
import type { ModelProvider } from "../src/model/types.ts";

function stubModel(text: string): ModelProvider {
  return {
    id: "stub",
    model: "stub-plan",
    chat: () => Promise.reject(new Error("unused")),
    stream: () => (async function* () {})(),
    structured: <T>(request: { parse: (text: string) => T }): Promise<{ value: T; result: never }> =>
      Promise.resolve({ value: request.parse(text) as T, result: undefined as never }),
    embeddings: () => Promise.reject(new Error("unused")),
    health: () => Promise.resolve({ ok: true, configured: true, provider: "stub", baseUrl: "stub", model: "stub-plan", reason: null }),
    capabilities: () => ({ chat: true, stream: true, structured: true, embeddings: true, tools: false, models: [], defaultModel: "stub-plan" }),
  };
}

const DRAFT = JSON.stringify({
  title: "Add search",
  steps: [
    { title: "Search the docs", kind: "tool", target: "filesystem.search" },
    { title: "Read the hits", kind: "tool", target: "filesystem.read" },
    { title: "Tell the user", kind: "manual" },
  ],
});

test("parsePlanDraft accepts a well-formed draft and refuses the rest", () => {
  const good = parsePlanDraft(DRAFT);
  assert.equal(good.ok, true);
  if (good.ok) {
    assert.equal(good.value.title, "Add search");
    assert.equal(good.value.steps.length, 3);
  }
  assert.equal(parsePlanDraft("{oops").ok, false);
  const fenced = parsePlanDraft('Here is your plan:\n```json\n' + DRAFT + '\n```\nGood luck.');
  assert.equal(fenced.ok, true, "fenced output is found, then strictly validated");
  assert.equal(parsePlanDraft(JSON.stringify({ title: "", steps: [] })).ok, false);
  assert.equal(parsePlanDraft(JSON.stringify({ title: "T", steps: [{ title: "x", kind: "nuke" }] })).ok, false);
  assert.equal(
    parsePlanDraft(JSON.stringify({ title: "T", steps: [{ title: "x", kind: "tool" }] })).ok,
    false,
    "a tool step without a target is refused",
  );
  const many = { title: "T", steps: Array.from({ length: 20 }, (_, i) => ({ title: `s${i}`, kind: "manual" })) };
  assert.equal(parsePlanDraft(JSON.stringify(many)).ok, false, "step cap enforced");
});

test("createPlan validates targets against live registries and stores a DRAFT that runs nothing", async () => {
  const tools = createToolRegistry({ policy: createPolicyEngine(), coreBuildId: "plans-test" });
  for (const tool of createWorkspaceTools()) tools.register(tool);
  const stored: Mission[] = [];
  const outcome = await createPlan("add search to docs", {
    model: stubModel(DRAFT),
    tools,
    agentIds: ["hermes"],
    upsertMission: (mission) => {
      stored.push(mission);
    },
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.mission.status, "DRAFT", "a plan never queues itself");
  assert.equal(outcome.mission.steps.length, 3);
  assert.equal(stored.length, 1, "persisted exactly once");

  const badTool = await createPlan("x", {
    model: stubModel(JSON.stringify({ title: "T", steps: [{ title: "s", kind: "tool", target: "nope.missing" }] })),
    tools,
    agentIds: [],
    upsertMission: () => {
      assert.fail("an invalid plan must never persist");
    },
  });
  assert.equal(badTool.ok, false);
  if (!badTool.ok) assert.match(badTool.reason, /unknown tool/);

  const badAgent = await createPlan("x", {
    model: stubModel(JSON.stringify({ title: "T", steps: [{ title: "s", kind: "agent", target: "ghost" }] })),
    tools,
    agentIds: [],
    upsertMission: () => {
      assert.fail("an invalid plan must never persist");
    },
  });
  assert.equal(badAgent.ok, false);
  if (!badAgent.ok) assert.match(badAgent.reason, /unknown agent/);

  assert.deepEqual((await createPlan("   ", { model: stubModel(DRAFT), tools, agentIds: [], upsertMission: () => undefined })).ok, false);
});

test("LIVE: a DRAFT plan starts through the executor and manual steps complete", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kai-plans-"));
  const rt = createCoreRuntime({
    dbPath: join(dir, "core.db"),
    agents: { mode: "mock" },
    startScheduler: false,
    subsystemPaths: { runUpkeepOnStart: false, ledgerPath: join(dir, "ledger.db") },
  });
  await rt.start();
  // Ordered teardown: stop the runtime (closes every SQLite handle) BEFORE
  // removing the directory — one hook, no race.
  t.after(async () => {
    await rt.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  const draft = createMission({
    title: "Probe plan",
    steps: [
      { title: "Read the inbox", kind: "manual" },
      { title: "Write the summary", kind: "manual" },
    ],
    metadata: { plan: true, criteria: ["file present: package.json"] },
  });
  rt.stores.missions.upsertMission(draft);
  assert.equal(rt.stores.missions.getMission(draft.id)?.status, "DRAFT");

  const started = await rt.missions.start(draft.id);
  assert.equal(started.status, "COMPLETED", "manual steps report complete; the mission finishes");
  assert.ok(started.steps.every((step) => step.status === "COMPLETED"));
});
