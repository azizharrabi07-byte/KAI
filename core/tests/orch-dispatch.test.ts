// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Routing engine tests: keyword analysis over the 12 TaskDomain values,
 * all six decision kinds, rationale quality, value-based ranking, and the
 * empty-workers no-throw guarantee.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createBenchmark } from "../src/orchestration/bench.ts";
import { createDispatcher } from "../src/orchestration/dispatch.ts";
import type { DecidePolicy, DecideTask, Dispatcher } from "../src/orchestration/dispatch.ts";
import type { TaskDomain } from "../src/orchestration/types.ts";
import type { WorkerProfileRecord, WorkerProfileStore } from "../src/shared/contracts.ts";

function memoryStore(): WorkerProfileStore {
  const map = new Map<string, WorkerProfileRecord>();
  return {
    upsert: (p) => {
      map.set(p.workerId, p);
    },
    get: (id) => map.get(id) ?? null,
    list: () => [...map.values()],
  };
}

const CAPS: Record<string, { skills: string[]; tools: string[] }> = {
  "w-high": { skills: ["typescript", "testing"], tools: ["read", "edit", "test-runner"] },
  "w-low": { skills: ["typescript", "testing"], tools: ["read", "edit", "test-runner"] },
  "w-docs": { skills: ["writing"], tools: ["read", "edit"] },
};

/** Dispatcher backed by a real benchmark: w-high carries value, w-low carries failure. */
function harness() {
  const bench = createBenchmark(memoryStore());
  bench.recordOutcome({
    workerId: "w-high",
    role: "coder",
    configVersion: "v1",
    domain: "coding",
    quality: 0.95,
    verification: 0.97,
    completed: true,
    rework: 0,
    corrections: 0,
    latencyMs: 30_000,
    safety: 1,
    difficulty: {},
    reviewScore: 0.9,
  });
  bench.recordOutcome({
    workerId: "w-low",
    role: "coder",
    configVersion: "v1",
    domain: "coding",
    quality: 0.3,
    verification: 0.2,
    completed: false,
    rework: 2,
    corrections: 1,
    latencyMs: 30_000,
    safety: 0.8,
    difficulty: {},
  });
  const dispatcher = createDispatcher({
    bench,
    availability: () => ["w-high", "w-low", "w-docs"],
    capabilities: (id) => CAPS[id] ?? { skills: [], tools: [] },
  });
  return { bench, dispatcher };
}

function task(over: Partial<DecideTask>): DecideTask {
  return {
    objective: "Implement the thing",
    taskType: "coding",
    difficulty: 0.4,
    risk: "WRITE",
    requiredSkills: ["typescript"],
    requiredTools: ["read", "edit"],
    ...over,
  };
}

const AUTO_OFF: DecidePolicy = { workerAuto: "AUTO", review: "OFF" };

test("analyze classifies all 12 TaskDomain values by keyword", () => {
  const { dispatcher } = harness();
  const cases: [string, TaskDomain][] = [
    ["Implement a new login endpoint in the API", "coding"],
    ["Debug the crash in the payment worker stack trace", "debugging"],
    ["Research how vector indexes compare for our workload", "research"],
    ["Draft a blog post announcing the release", "writing"],
    ["Write an ADR for the system design of the cache layer", "architecture"],
    ["Review this pull request for correctness", "review"],
    ["Add unit tests to raise coverage of the billing module", "testing"],
    ["Update the README and changelog for the release", "document"],
    ["Build an MCP server exposing our search tool", "mcp"],
    ["Deploy the staging stack with Docker and fix the CI pipeline", "system"],
    ["Plan the Q3 roadmap with milestones and breakdown", "planning"],
    ["Say hello and confirm you are online", "general"],
  ];
  for (const [objective, want] of cases) {
    const got = dispatcher.analyze(objective);
    assert.equal(got.taskType, want, objective);
    assert.ok(got.difficulty >= 0 && got.difficulty <= 1, objective);
  }
});

test("analyze infers risk, skills, tools, and signal-based difficulty", () => {
  const { dispatcher } = harness();
  assert.equal(dispatcher.analyze("Delete all rows from the users table").risk, "DESTRUCTIVE");
  assert.equal(dispatcher.analyze("Send the report by email to the client").risk, "EXTERNAL");
  assert.equal(dispatcher.analyze("Fix the typo in the header file").risk, "WRITE");
  assert.equal(dispatcher.analyze("Explain how caching works").risk, "READ");
  const skills = dispatcher.analyze("Implement the endpoint in TypeScript with React");
  assert.ok(skills.requiredSkills.includes("typescript"), JSON.stringify(skills));
  assert.ok(skills.requiredTools.includes("edit"), JSON.stringify(skills));
  const easy = dispatcher.analyze("Fix it");
  const hard = dispatcher.analyze("Fix it", {
    signals: { fileCount: 9, toolCount: 7, dependencyCount: 4, subtaskCount: 5, risk: "DESTRUCTIVE", reviewRounds: 2 },
  });
  assert.ok(hard.difficulty > easy.difficulty, `${easy.difficulty} vs ${hard.difficulty}`);
});

test("DO_IT_SELF for trivial READ work with no workers", () => {
  const dispatcher = createDispatcher({
    bench: createBenchmark(memoryStore()),
    availability: () => [],
    capabilities: () => ({ skills: [], tools: [] }),
  });
  const decision = dispatcher.decide(AUTO_OFF, task({ difficulty: 0.1, risk: "READ", requiredSkills: [], requiredTools: [] }), []);
  assert.equal(decision.decision, "DO_IT_SELF");
  assert.deepEqual(decision.workerIds, []);
  assert.ok(decision.rationale.length > 0);
});

test("DELEGATE_ONE picks the higher-value worker and explains with evidence", () => {
  const { dispatcher } = harness();
  const decision = dispatcher.decide(AUTO_OFF, task({ risk: "READ" }), ["w-high", "w-low"]);
  assert.equal(decision.decision, "DELEGATE_ONE");
  assert.deepEqual(decision.workerIds, ["w-high"]);
  assert.match(decision.rationale, /w-high/);
  assert.match(decision.rationale, /verification 0\.97 on coding \(1 samples\)/);
  assert.ok(decision.alternatives.some((a) => a.workerId === "w-low"));
});

test("PARALLELIZE fans explicit independent subtasks out to workers", () => {
  const { dispatcher } = harness();
  const decision = dispatcher.decide(
    AUTO_OFF,
    task({ risk: "READ", subtasks: ["one", "two", "three"] }),
    ["w-high", "w-low"],
  );
  assert.equal(decision.decision, "PARALLELIZE");
  assert.ok(decision.workerIds.length >= 1 && decision.workerIds.length <= 3, JSON.stringify(decision.workerIds));
  assert.ok(decision.workerIds.includes("w-high"));
  assert.ok(decision.rationale.length > 0);
});

test("DELEGATE_AND_REVIEW on risky, hard, or review-policy tasks", () => {
  const { dispatcher } = harness();
  const risky = dispatcher.decide(AUTO_OFF, task({ risk: "DESTRUCTIVE" }), ["w-high"]);
  assert.equal(risky.decision, "DELEGATE_AND_REVIEW");
  assert.deepEqual(risky.workerIds, ["w-high"]);
  const hard = dispatcher.decide(AUTO_OFF, task({ risk: "READ", difficulty: 0.8 }), ["w-high"]);
  assert.equal(hard.decision, "DELEGATE_AND_REVIEW");
  const policy = dispatcher.decide({ workerAuto: "AUTO", review: "ASK" }, task({ risk: "READ", difficulty: 0.3 }), ["w-high"]);
  assert.equal(policy.decision, "DELEGATE_AND_REVIEW");
  assert.ok(risky.rationale.length > 0 && hard.rationale.length > 0 && policy.rationale.length > 0);
});

test("ASK_USER when policy gates risk, or nobody is capable", () => {
  const { dispatcher } = harness();
  const gated = dispatcher.decide({ workerAuto: "ASK", review: "OFF" }, task({ risk: "WRITE" }), ["w-high"]);
  assert.equal(gated.decision, "ASK_USER");
  assert.deepEqual(gated.workerIds, []);
  const nobody = dispatcher.decide(AUTO_OFF, task({ requiredSkills: ["quantum-cobol"], requiredTools: [] }), ["w-high", "w-low"]);
  assert.equal(nobody.decision, "ASK_USER");
  const offline = createDispatcher({
    bench: createBenchmark(memoryStore()),
    availability: () => [],
    capabilities: () => ({ skills: [], tools: [] }),
  });
  const empty = offline.decide(AUTO_OFF, task({ difficulty: 0.6, risk: "WRITE" }), []);
  assert.equal(empty.decision, "ASK_USER");
});

test("CHANGE_WORKER after two failures against an avoided worker", () => {
  const { dispatcher } = harness();
  const changed = dispatcher.decide(AUTO_OFF, task({ risk: "READ" }), ["w-high", "w-low"], {
    avoid: ["w-high"],
    failureCount: 2,
  });
  assert.equal(changed.decision, "CHANGE_WORKER");
  assert.deepEqual(changed.workerIds, ["w-low"]);
  assert.ok(changed.rationale.length > 0);
  // One failure is not enough evidence to switch.
  const staying = dispatcher.decide(AUTO_OFF, task({ risk: "READ" }), ["w-high", "w-low"], {
    avoid: ["w-high"],
    failureCount: 1,
  });
  assert.equal(staying.decision, "DELEGATE_ONE");
  assert.deepEqual(staying.workerIds, ["w-high"]);
});

test("every decision carries a non-empty rationale; empty workers never throw", () => {
  const { dispatcher }: { dispatcher: Dispatcher } = harness();
  const policies: DecidePolicy[] = [
    { workerAuto: "AUTO", review: "OFF" },
    { workerAuto: "ASK", review: "ASK" },
  ];
  const tasks: DecideTask[] = [
    task({ difficulty: 0.1, risk: "READ", requiredSkills: [], requiredTools: [] }),
    task({ risk: "DESTRUCTIVE" }),
    task({ subtasks: ["a", "b"] }),
    task({ requiredSkills: ["missing-skill"] }),
  ];
  for (const policy of policies) {
    for (const t of tasks) {
      for (const workers of [[], ["w-high"], ["w-high", "w-low", "w-docs"]]) {
        const d = dispatcher.decide(policy, t, workers);
        assert.ok(d.rationale.length > 0, JSON.stringify({ policy, task: t, workers }));
        assert.ok(d.difficulty >= 0 && d.difficulty <= 1);
      }
    }
    const changed = dispatcher.decide(policies[0] as DecidePolicy, task({}), ["w-high"], {
      avoid: ["w-high"],
      failureCount: 5,
    });
    assert.ok(changed.rationale.length > 0);
  }
});
