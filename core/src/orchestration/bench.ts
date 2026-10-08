// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Worker benchmark engine — measured per-domain stats plus one value score.
 *
 * Every number here comes from a recorded outcome; nothing is synthesised.
 * Domain means update incrementally: new = old + (x - old) / (n + 1).
 *
 * CONFIG-VERSION RULE (frozen): a profile is keyed by workerId AND configVersion
 * (the fingerprint of model+provider+instructions+skills+tools+objective config).
 * When `ensureProfile` sees a stored profile whose configVersion differs from the
 * requested one, it RESETS to a fresh profile (zero samples, empty domains).
 * Rationale: measurements taken under a different config describe a different
 * worker — mixing them would silently poison rankings. Never mix configs.
 *
 * OVERALL VALUE (frozen formula, documented so dispatch can explain itself):
 *   base       = 0.35*quality + 0.25*verification + 0.20*completion
 *                + 0.20*(reviewScore ?? 0.5)
 *   difficulty = difficultyNorm(0.5 + difficulty), difficultyNorm clamps to
 *                [0.5, 1.5] (with difficulty in 0..1 the sum is already in
 *                range, so this is the identity — kept as a named step so a
 *                future calibration has one place to land).
 *   penalties  = cost + latency + rework + failure + safety, each capped:
 *     cost     = min(0.3, costUsd * 0.1), skipped (0) when costUsd is unknown
 *     latency  = min(0.2, latencyMs / 300000 * 0.1)   (5-minute scale)
 *     rework   = min(0.3, (rework + corrections) * 0.5)
 *     failure  = completed ? 0 : 0.4
 *     safety   = min(0.5, 1 - safety)
 *   value = base * difficulty / (1 + penalties)
 *
 * The profile-level overallValue is the sample-weighted mean of per-outcome
 * values: overall += (outcomeValue - overall) / (totalSamples + 1). A costly
 * success therefore still outscores a cheap failure, because completion and
 * quality dominate the base while cost/latency can only discount.
 *
 * DIFFICULTY (frozen weights, each input normalised then clamped to its share):
 *   fileCount/10*0.2 + toolCount/8*0.15 + dependencyCount/5*0.15
 *   + subtaskCount/6*0.15 + risk(READ 0 / WRITE .33 / EXTERNAL .66
 *   / DESTRUCTIVE 1)*0.2 + reviewRounds/3*0.15, total clamped to 0..1.
 * Missing signals contribute 0.
 */

import type { WorkerProfileStore, WorkerProfileRecord } from "../shared/contracts.ts";
import type { DifficultySignals, DomainStats, TaskDomain, WorkerProfile } from "./types.ts";

/** Outcome recorded from a verified worker handoff. Numbers are 0..1 unless noted. */
export interface OutcomeInput {
  workerId: string;
  role: string;
  configVersion: string;
  domain: TaskDomain;
  quality: number;
  verification: number;
  completed: boolean;
  /** Rework count for this outcome (>= 0). */
  rework: number;
  /** Extra correction rounds for this outcome (>= 0). Folded into rework. */
  corrections: number;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  latencyMs: number;
  safety: number;
  difficulty: DifficultySignals | number;
  reviewScore?: number;
}

/** Inputs to the frozen overall-value formula. */
export interface ValueInput {
  quality: number;
  verification: number;
  completed: boolean;
  reviewScore?: number;
  /** Normalised difficulty, 0..1. */
  difficulty: number;
  costUsd?: number;
  latencyMs: number;
  rework: number;
  corrections: number;
  safety: number;
}

/** One small controlled baseline task used to seed a fresh profile. */
export interface ColdStartTask {
  objective: string;
  domain: TaskDomain;
  skills: string[];
  tools: string[];
  /** Expected difficulty (0..1); always small — baselines stay controlled. */
  expectedDifficulty: number;
}

export interface Evidence {
  profile: WorkerProfile;
  /** Domains sorted by samples descending (top 5). */
  recent: { domain: string; stats: DomainStats }[];
}

export interface Benchmark {
  ensureProfile(workerId: string, role: string, configVersion: string): WorkerProfile;
  recordOutcome(input: OutcomeInput): WorkerProfile;
  getProfile(workerId: string): WorkerProfile | null;
  listProfiles(): WorkerProfile[];
  withEvidence(workerId: string): Evidence | null;
  difficulty(signals: DifficultySignals): number;
  coldStart(role: string): ColdStartTask[];
}

const RISK_WEIGHT: Record<NonNullable<DifficultySignals["risk"]>, number> = {
  READ: 0,
  WRITE: 0.33,
  EXTERNAL: 0.66,
  DESTRUCTIVE: 1,
};

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** Named normalisation step of the value formula; clamps the multiplier to [0.5, 1.5]. */
export function difficultyNorm(x: number): number {
  if (!Number.isFinite(x)) return 0.5;
  return Math.min(1.5, Math.max(0.5, x));
}

/** Frozen difficulty estimator: observed signals -> 0..1. */
export function estimateDifficulty(signals: DifficultySignals): number {
  const files = Math.min(1, (signals.fileCount ?? 0) / 10) * 0.2;
  const tools = Math.min(1, (signals.toolCount ?? 0) / 8) * 0.15;
  const deps = Math.min(1, (signals.dependencyCount ?? 0) / 5) * 0.15;
  const subs = Math.min(1, (signals.subtaskCount ?? 0) / 6) * 0.15;
  const risk = (signals.risk !== undefined ? RISK_WEIGHT[signals.risk] : 0) * 0.2;
  const rounds = Math.min(1, (signals.reviewRounds ?? 0) / 3) * 0.15;
  return clamp01(files + tools + deps + subs + risk + rounds);
}

/** Frozen overall-value formula; see module doc. Unknown cost is skipped (penalty 0). */
export function computeOverallValue(input: ValueInput): number {
  const completion = input.completed ? 1 : 0;
  const base =
    0.35 * input.quality +
    0.25 * input.verification +
    0.2 * completion +
    0.2 * (input.reviewScore ?? 0.5);
  const mult = difficultyNorm(0.5 + input.difficulty);
  const costPenalty = input.costUsd === undefined ? 0 : Math.min(0.3, input.costUsd * 0.1);
  const latencyPenalty = Math.min(0.2, (input.latencyMs / 300000) * 0.1);
  const reworkPenalty = Math.min(0.3, (input.rework + input.corrections) * 0.5);
  const failurePenalty = input.completed ? 0 : 0.4;
  const safetyPenalty = Math.min(0.5, 1 - input.safety);
  return (base * mult) / (1 + costPenalty + latencyPenalty + reworkPenalty + failurePenalty + safetyPenalty);
}

function confidenceFor(samples: number): DomainStats["confidence"] {
  if (samples < 5) return "low";
  if (samples < 20) return "medium";
  return "high";
}

export function freshDomainStats(): DomainStats {
  return {
    quality: 0,
    verification: 0,
    completion: 0,
    rework: 0,
    tokenEfficiency: 0.5,
    latency: 0.5,
    safety: 0,
    samples: 0,
    confidence: "low",
    trend: "flat",
  };
}

export function freshProfile(workerId: string, role: string, configVersion: string): WorkerProfile {
  return {
    workerId,
    role,
    configVersion,
    domains: {},
    overallValue: 0,
    overallConfidence: "low",
    totalSamples: 0,
    updatedAt: new Date().toISOString(),
  };
}

function isDomainStats(value: unknown): value is DomainStats {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  for (const k of ["quality", "verification", "completion", "rework", "tokenEfficiency", "latency", "safety", "samples"]) {
    if (typeof v[k] !== "number") return false;
  }
  if (v["confidence"] !== "low" && v["confidence"] !== "medium" && v["confidence"] !== "high") return false;
  return v["trend"] === "up" || v["trend"] === "flat" || v["trend"] === "down";
}

function fromRecord(record: WorkerProfileRecord): WorkerProfile {
  const domains: Record<string, DomainStats> = {};
  for (const [k, v] of Object.entries(record.domains)) {
    if (isDomainStats(v)) domains[k] = { ...v };
  }
  const confidence =
    record.overallConfidence === "medium" || record.overallConfidence === "high" ? record.overallConfidence : "low";
  return {
    workerId: record.workerId,
    role: record.role,
    configVersion: record.configVersion,
    domains,
    overallValue: record.overallValue,
    overallConfidence: confidence,
    totalSamples: record.totalSamples,
    updatedAt: record.updatedAt,
  };
}

function toRecord(profile: WorkerProfile): WorkerProfileRecord {
  const domains: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(profile.domains)) domains[k] = { ...v };
  return {
    workerId: profile.workerId,
    role: profile.role,
    configVersion: profile.configVersion,
    domains,
    overallValue: profile.overallValue,
    overallConfidence: profile.overallConfidence,
    totalSamples: profile.totalSamples,
    updatedAt: profile.updatedAt,
  };
}

const CODING_BASELINE: ColdStartTask[] = [
  {
    objective: "Implement one pure helper function in a single file (under 50 lines), no network, with a docstring.",
    domain: "coding",
    skills: ["typescript"],
    tools: ["read", "edit"],
    expectedDifficulty: estimateDifficulty({ fileCount: 1, toolCount: 2, risk: "WRITE" }),
  },
  {
    objective: "Fix one failing unit test in a single file; do not change unrelated code.",
    domain: "debugging",
    skills: ["typescript", "testing"],
    tools: ["read", "edit", "test-runner"],
    expectedDifficulty: estimateDifficulty({ fileCount: 1, toolCount: 3, risk: "READ" }),
  },
  {
    objective: "Add unit tests for one small module (single file, no new dependencies).",
    domain: "testing",
    skills: ["testing"],
    tools: ["read", "edit", "test-runner"],
    expectedDifficulty: estimateDifficulty({ fileCount: 1, toolCount: 3, risk: "WRITE" }),
  },
];

const RESEARCH_BASELINE: ColdStartTask[] = [
  {
    objective: "Summarise in five bullets how the local config loader works, from at most three files (read-only).",
    domain: "research",
    skills: ["research"],
    tools: ["read"],
    expectedDifficulty: estimateDifficulty({ fileCount: 3, toolCount: 1, risk: "READ" }),
  },
  {
    objective: "Compare two approaches for local caching in a short table; no code changes.",
    domain: "research",
    skills: ["research"],
    tools: ["read"],
    expectedDifficulty: estimateDifficulty({ fileCount: 2, toolCount: 1, risk: "READ" }),
  },
  {
    objective: "Write a half-page findings note from the surveyed sources (single document).",
    domain: "document",
    skills: ["writing"],
    tools: ["read", "edit"],
    expectedDifficulty: estimateDifficulty({ fileCount: 2, toolCount: 2, risk: "WRITE" }),
  },
];

const REVIEWER_BASELINE: ColdStartTask[] = [
  {
    objective: "Review a small diff (under 100 lines) against the correctness checklist; list findings only.",
    domain: "review",
    skills: ["review"],
    tools: ["read"],
    expectedDifficulty: estimateDifficulty({ fileCount: 2, toolCount: 1, risk: "READ" }),
  },
  {
    objective: "Re-check one flagged edge case from a small diff using the existing tests (no new code).",
    domain: "testing",
    skills: ["testing", "review"],
    tools: ["read", "test-runner"],
    expectedDifficulty: estimateDifficulty({ fileCount: 2, toolCount: 2, risk: "READ" }),
  },
];

const GENERAL_BASELINE: ColdStartTask[] = [
  {
    objective: "Read one short document and restate its three key points (no changes).",
    domain: "general",
    skills: [],
    tools: ["read"],
    expectedDifficulty: estimateDifficulty({ fileCount: 1, toolCount: 1, risk: "READ" }),
  },
  {
    objective: "Make one tiny, reversible edit to a scratch file and describe what changed.",
    domain: "general",
    skills: [],
    tools: ["read", "edit"],
    expectedDifficulty: estimateDifficulty({ fileCount: 1, toolCount: 2, risk: "WRITE" }),
  },
];

/** 2–3 small controlled baseline descriptors used to seed a fresh profile. */
export function coldStartTasks(role: string): ColdStartTask[] {
  const r = role.toLowerCase();
  if (r.includes("cod") || r.includes("engineer") || r.includes("implement") || r.includes("developer")) {
    return CODING_BASELINE.map((t) => ({ ...t, skills: [...t.skills], tools: [...t.tools] }));
  }
  if (r.includes("research") || r.includes("analy")) {
    return RESEARCH_BASELINE.map((t) => ({ ...t, skills: [...t.skills], tools: [...t.tools] }));
  }
  if (r.includes("review")) {
    return REVIEWER_BASELINE.map((t) => ({ ...t, skills: [...t.skills], tools: [...t.tools] }));
  }
  return GENERAL_BASELINE.map((t) => ({ ...t, skills: [...t.skills], tools: [...t.tools] }));
}

export function createBenchmark(store: WorkerProfileStore): Benchmark {
  function ensureProfile(workerId: string, role: string, configVersion: string): WorkerProfile {
    const stored = store.get(workerId);
    if (stored && stored.configVersion === configVersion) return fromRecord(stored);
    // Missing, or config drift: NEVER mix measurements across configs — reset.
    const profile = freshProfile(workerId, role, configVersion);
    store.upsert(toRecord(profile));
    return profile;
  }

  function recordOutcome(input: OutcomeInput): WorkerProfile {
    const profile = ensureProfile(input.workerId, input.role, input.configVersion);
    const prev = profile.domains[input.domain] ?? freshDomainStats();
    const n = prev.samples;
    const mean = (old: number, x: number): number => old + (x - old) / (n + 1);

    let trend: DomainStats["trend"] = "flat";
    if (n > 0) {
      if (input.quality > prev.quality + 0.05) trend = "up";
      else if (input.quality < prev.quality - 0.05) trend = "down";
    }

    const completion = input.completed ? 1 : 0;
    const reworkSample = Math.min(1, input.rework + input.corrections);
    const totalTokens = (input.tokensIn ?? 0) + (input.tokensOut ?? 0);
    const tokenSample = totalTokens > 0 ? 1 / (1 + totalTokens / 50000) : null;
    const latencySample = Number.isFinite(input.latencyMs) ? clamp01(1 - input.latencyMs / 300000) : null;
    const difficultyNumber =
      typeof input.difficulty === "number" ? clamp01(input.difficulty) : estimateDifficulty(input.difficulty);

    const next: DomainStats = {
      quality: mean(prev.quality, input.quality),
      verification: mean(prev.verification, input.verification),
      completion: mean(prev.completion, completion),
      rework: mean(prev.rework, reworkSample),
      tokenEfficiency: tokenSample === null ? prev.tokenEfficiency : mean(prev.tokenEfficiency, tokenSample),
      latency: latencySample === null ? prev.latency : mean(prev.latency, latencySample),
      safety: mean(prev.safety, input.safety),
      samples: n + 1,
      confidence: confidenceFor(n + 1),
      trend,
    };
    profile.domains[input.domain] = next;

    const outcomeValue = computeOverallValue({
      quality: input.quality,
      verification: input.verification,
      completed: input.completed,
      ...(input.reviewScore !== undefined ? { reviewScore: input.reviewScore } : {}),
      difficulty: difficultyNumber,
      ...(input.costUsd !== undefined ? { costUsd: input.costUsd } : {}),
      latencyMs: input.latencyMs,
      rework: input.rework,
      corrections: input.corrections,
      safety: input.safety,
    });
    profile.overallValue += (outcomeValue - profile.overallValue) / (profile.totalSamples + 1);
    profile.totalSamples += 1;
    profile.overallConfidence = confidenceFor(profile.totalSamples);
    profile.updatedAt = new Date().toISOString();
    store.upsert(toRecord(profile));
    return profile;
  }

  function getProfile(workerId: string): WorkerProfile | null {
    const stored = store.get(workerId);
    return stored ? fromRecord(stored) : null;
  }

  function listProfiles(): WorkerProfile[] {
    return store.list().map(fromRecord);
  }

  function withEvidence(workerId: string): Evidence | null {
    const profile = getProfile(workerId);
    if (!profile) return null;
    const recent = Object.entries(profile.domains)
      .map(([domain, stats]) => ({ domain, stats }))
      .sort((a, b) => b.stats.samples - a.stats.samples)
      .slice(0, 5);
    return { profile, recent };
  }

  return {
    ensureProfile,
    recordOutcome,
    getProfile,
    listProfiles,
    withEvidence,
    difficulty: estimateDifficulty,
    coldStart: coldStartTasks,
  };
}
