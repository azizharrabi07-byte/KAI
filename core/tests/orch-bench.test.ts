// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Benchmark engine tests: incremental means, frozen value formula (a costly
 * success outscores a cheap failure), difficulty weights, config-version
 * reset, confidence/trend transitions, cold-start baselines, evidence.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { computeOverallValue, createBenchmark, estimateDifficulty } from "../src/orchestration/bench.ts";
import type { OutcomeInput } from "../src/orchestration/bench.ts";
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

function outcome(over: Partial<OutcomeInput> & { workerId: string }): OutcomeInput {
  return {
    role: "coder",
    configVersion: "v1",
    domain: "coding",
    quality: 0.8,
    verification: 0.8,
    completed: true,
    rework: 0,
    corrections: 0,
    latencyMs: 10_000,
    safety: 1,
    difficulty: {},
    ...over,
  };
}

test("an 80k-token success outscores a 20k-token failure (completion dominates cost)", () => {
  const bench = createBenchmark(memoryStore());
  const success = bench.recordOutcome(
    outcome({
      workerId: "w-success",
      quality: 0.9,
      verification: 1,
      completed: true,
      rework: 0,
      corrections: 0,
      tokensIn: 60_000,
      tokensOut: 20_000,
      latencyMs: 60_000,
      safety: 1,
      reviewScore: 0.8,
    }),
  );
  const failure = bench.recordOutcome(
    outcome({
      workerId: "w-fail",
      quality: 0.3,
      verification: 0,
      completed: false,
      rework: 2,
      corrections: 3,
      tokensIn: 15_000,
      tokensOut: 5_000,
      latencyMs: 60_000,
      safety: 0.9,
    }),
  );
  assert.ok(success.overallValue > failure.overallValue, `success ${success.overallValue} vs failure ${failure.overallValue}`);
  // The failure is more token-efficient but still worth less — value is not cheapness.
  const effSuccess = success.domains["coding"]?.tokenEfficiency ?? 1;
  const effFailure = failure.domains["coding"]?.tokenEfficiency ?? 0;
  assert.ok(effFailure > effSuccess, `efficiency failure ${effFailure} vs success ${effSuccess}`);
  assert.ok(success.overallValue > failure.overallValue);
});

test("overall value of a perfect trivial outcome is exactly 0.5", () => {
  const value = computeOverallValue({
    quality: 1,
    verification: 1,
    completed: true,
    reviewScore: 1,
    difficulty: 0,
    costUsd: 0,
    latencyMs: 0,
    rework: 0,
    corrections: 0,
    safety: 1,
  });
  // base = 1, difficultyNorm(0.5) = 0.5, no penalties -> 0.5
  assert.equal(value, 0.5);
});

test("unknown cost is skipped while known cost discounts", () => {
  const base = { quality: 0.8, verification: 0.8, completed: true, difficulty: 0.5, latencyMs: 0, rework: 0, corrections: 0, safety: 1 as const };
  const free = computeOverallValue({ ...base });
  const cheap = computeOverallValue({ ...base, costUsd: 1 });
  const pricey = computeOverallValue({ ...base, costUsd: 10 });
  const capped = computeOverallValue({ ...base, costUsd: 100 });
  assert.ok(free > cheap && cheap > pricey, `${free} ${cheap} ${pricey}`);
  // cost penalty caps at 0.3: costUsd 10 and 100 penalise identically.
  assert.equal(pricey, capped);
});

test("domain means update incrementally", () => {
  const bench = createBenchmark(memoryStore());
  bench.recordOutcome(outcome({ workerId: "w1", quality: 0.8 }));
  const profile = bench.recordOutcome(outcome({ workerId: "w1", quality: 0.6 }));
  const stats = profile.domains["coding"];
  assert.equal(stats?.samples, 2);
  assert.ok(Math.abs((stats?.quality ?? -1) - 0.7) < 1e-9, JSON.stringify(stats));
  assert.equal(stats?.confidence, "low");
  assert.equal(profile.totalSamples, 2);
});

test("confidence rises at 5 (medium) and 20 (high) samples", () => {
  const bench = createBenchmark(memoryStore());
  let profile = bench.recordOutcome(outcome({ workerId: "w1" }));
  assert.equal(profile.domains["coding"]?.confidence, "low");
  for (let i = 0; i < 4; i++) profile = bench.recordOutcome(outcome({ workerId: "w1" }));
  assert.equal(profile.domains["coding"]?.confidence, "medium");
  assert.equal(profile.domains["coding"]?.samples, 5);
  for (let i = 0; i < 15; i++) profile = bench.recordOutcome(outcome({ workerId: "w1" }));
  assert.equal(profile.domains["coding"]?.confidence, "high");
  assert.equal(profile.overallConfidence, "high");
});

test("trend compares incoming quality to the prior mean ±0.05", () => {
  const bench = createBenchmark(memoryStore());
  let p = bench.recordOutcome(outcome({ workerId: "w1", quality: 0.5 }));
  assert.equal(p.domains["coding"]?.trend, "flat"); // first sample has no prior
  p = bench.recordOutcome(outcome({ workerId: "w1", quality: 0.9 }));
  assert.equal(p.domains["coding"]?.trend, "up");
  p = bench.recordOutcome(outcome({ workerId: "w1", quality: 0.1 }));
  assert.equal(p.domains["coding"]?.trend, "down");
  p = bench.recordOutcome(outcome({ workerId: "w1", quality: 0.52 }));
  assert.equal(p.domains["coding"]?.trend, "flat");
});

test("config-version drift resets to fresh samples (never mixes configs)", () => {
  const store = memoryStore();
  const bench = createBenchmark(store);
  bench.recordOutcome(outcome({ workerId: "w1", configVersion: "cfg-a" }));
  bench.recordOutcome(outcome({ workerId: "w1", configVersion: "cfg-a" }));
  assert.equal(bench.getProfile("w1")?.totalSamples, 2);
  const reset = bench.ensureProfile("w1", "coder", "cfg-b");
  assert.equal(reset.configVersion, "cfg-b");
  assert.equal(reset.totalSamples, 0);
  assert.deepEqual(reset.domains, {});
  assert.equal(reset.overallValue, 0);
  // Same version afterwards keeps accumulating.
  bench.recordOutcome(outcome({ workerId: "w1", configVersion: "cfg-b" }));
  assert.equal(bench.getProfile("w1")?.totalSamples, 1);
  // Recording under a new version also resets implicitly.
  const moved = bench.recordOutcome(outcome({ workerId: "w1", configVersion: "cfg-c", quality: 0.9 }));
  assert.equal(moved.totalSamples, 1);
  assert.ok(Math.abs((moved.domains["coding"]?.quality ?? -1) - 0.9) < 1e-9);
});

test("difficulty math: empty signals are 0, full signals clamp to 1", () => {
  assert.equal(estimateDifficulty({}), 0);
  assert.equal(estimateDifficulty({ risk: "READ" }), 0);
  assert.equal(estimateDifficulty({ risk: "DESTRUCTIVE" }), 0.2);
  assert.equal(estimateDifficulty({ fileCount: 10 }), 0.2);
  assert.ok(Math.abs(estimateDifficulty({ fileCount: 5, toolCount: 4, risk: "WRITE" }) - (0.1 + 0.075 + 0.066)) < 1e-9);
  const maxed = estimateDifficulty({
    fileCount: 100,
    toolCount: 80,
    dependencyCount: 50,
    subtaskCount: 60,
    risk: "DESTRUCTIVE",
    reviewRounds: 30,
  });
  assert.equal(maxed, 1);
  const bench = createBenchmark(memoryStore());
  assert.equal(bench.difficulty({ risk: "EXTERNAL" }), 0.66 * 0.2);
});

test("coldStart returns 2–3 small controlled baselines per role", () => {
  const bench = createBenchmark(memoryStore());
  const coding = bench.coldStart("coding");
  const research = bench.coldStart("Research Analyst");
  const reviewer = bench.coldStart("reviewer");
  const other = bench.coldStart("mystery-role");
  for (const [tasks, want] of [
    [coding, "coding"],
    [research, "research"],
    [reviewer, "review"],
  ] as const) {
    assert.ok(tasks.length >= 2 && tasks.length <= 3, `${want}: ${tasks.length}`);
    assert.ok(tasks.some((t) => t.domain === want), `${want}: ${JSON.stringify(tasks.map((t) => t.domain))}`);
    for (const t of tasks) {
      assert.ok(t.objective.length > 0);
      assert.ok(t.expectedDifficulty < 0.35, `${t.objective}: ${t.expectedDifficulty}`);
    }
  }
  assert.ok(other.length >= 2 && other.length <= 3);
});

test("withEvidence returns the profile plus domains ranked by samples", () => {
  const bench = createBenchmark(memoryStore());
  assert.equal(bench.withEvidence("ghost"), null);
  bench.recordOutcome(outcome({ workerId: "w1", domain: "coding" }));
  bench.recordOutcome(outcome({ workerId: "w1", domain: "coding" }));
  bench.recordOutcome(outcome({ workerId: "w1", domain: "research" }));
  const evidence = bench.withEvidence("w1");
  assert.ok(evidence);
  assert.equal(evidence.profile.workerId, "w1");
  assert.equal(evidence.recent.length, 2);
  assert.equal(evidence.recent[0]?.domain, "coding");
  assert.equal(evidence.recent[0]?.stats.samples, 2);
});

test("getProfile is null for unknown workers; listProfiles lists all", () => {
  const bench = createBenchmark(memoryStore());
  assert.equal(bench.getProfile("nobody"), null);
  bench.ensureProfile("a", "coder", "v1");
  bench.ensureProfile("b", "reviewer", "v1");
  const listed = bench.listProfiles().map((p) => p.workerId).sort();
  assert.deepEqual(listed, ["a", "b"]);
});
