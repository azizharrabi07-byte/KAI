// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Orchestration preferences — autonomy levels, visibility, budgets — persisted
 * in the Core `settings` table and read live. Separate from the model settings
 * service (which owns provider inputs); both ride the same `settings.update`
 * tool and the same GET /settings surface.
 *
 * Nothing here bypasses policy: autonomy only selects AMONG policy-allowed
 * actions. Irreversible and high-risk operations stay approval-gated at every
 * level, enforced by the policy engine, not by these preferences.
 */

import type { SettingsStore } from "../shared/contracts.ts";
import type { AutonomyPolicy, AutonomyLevel, ReasoningMode, TraceLevel } from "./types.ts";

export const ORCHESTRATION_KEYS = [
  "orchestration.autonomy",
  "orchestration.workerAuto",
  "orchestration.review",
  "orchestration.skillLearning",
  "orchestration.activity",
  "orchestration.reasoning",
  "orchestration.toolsView",
  "orchestration.agentsView",
  "orchestration.maxDepth",
  "orchestration.maxParallel",
  "orchestration.maxRetries",
  "orchestration.taskRetentionDays",
  // Optional decision accelerator (JEV). Default is deterministic — KAI never
  // requires JEV. "deterministic+jev" enables the provider boundary; the
  // deterministic kernel and Outcome Gate stay authoritative either way.
  "orchestration.decision",
  "orchestration.jevMaxCalls",
  // KAI Doer — the autonomous goal-execution capability. NOT the security
  // layer: Guard (policy, risk, approvals, the execution registry) is never
  // affected by this switch. A fresh install starts OFF.
  "orchestration.doer",
  // Monster Mode — the high-autonomy execution profile. Separate from Doer:
  // Doer says "may KAI act on its own at all", Monster says "how far does it
  // carry a mission without being asked again". Neither touches Guard.
  "orchestration.monster",
  "orchestration.monsterMinutes",
  "orchestration.monsterSteps",
  "orchestration.monsterParallel",
] as const;

export type OrchestrationKey = (typeof ORCHESTRATION_KEYS)[number];

export function isOrchestrationKey(key: string): key is OrchestrationKey {
  return (ORCHESTRATION_KEYS as readonly string[]).includes(key);
}

type Check = { ok: true; value: string } | { ok: false; reason: string };

function intIn(key: string, value: unknown, min: number, max: number): Check {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) {
    return { ok: false, reason: `"${key}" must be an integer ${min}..${max}` };
  }
  return { ok: true, value: String(n) };
}

function oneOf(key: string, value: unknown, allowed: readonly string[]): Check {
  if (typeof value !== "string" || !allowed.includes(value)) {
    return { ok: false, reason: `"${key}" must be one of ${allowed.join(", ")}` };
  }
  return { ok: true, value };
}

export function validateOrchestrationValue(key: OrchestrationKey, value: unknown): Check {
  switch (key) {
    case "orchestration.autonomy":
      return intIn(key, value, 0, 4);
    case "orchestration.workerAuto":
      return oneOf(key, value, ["AUTO", "ASK", "OFF"]);
    case "orchestration.review":
      return oneOf(key, value, ["AUTO", "ASK", "OFF"]);
    case "orchestration.skillLearning":
      return oneOf(key, value, ["OFF", "PROPOSE", "AUTO_SAFE"]);
    case "orchestration.activity":
      return oneOf(key, value, ["OFF", "COMPACT", "VERBOSE"]);
    case "orchestration.reasoning":
      return oneOf(key, value, ["HIDDEN", "SUMMARY", "PROVIDER_EXPOSED"]);
    case "orchestration.toolsView":
      return oneOf(key, value, ["COLLAPSED", "EXPANDED"]);
    case "orchestration.agentsView":
      return oneOf(key, value, ["COMPACT", "DETAILED"]);
    case "orchestration.maxDepth":
      return intIn(key, value, 1, 5);
    case "orchestration.maxParallel":
      return intIn(key, value, 1, 10);
    case "orchestration.maxRetries":
      return intIn(key, value, 0, 5);
    case "orchestration.taskRetentionDays":
      return intIn(key, value, 1, 365);
    case "orchestration.decision":
      return oneOf(key, value, ["deterministic", "deterministic+jev"]);
    case "orchestration.jevMaxCalls":
      return intIn(key, value, 0, 50);
    case "orchestration.doer":
      return oneOf(key, value, ["ON", "OFF"]);
    case "orchestration.monster":
      return oneOf(key, value, ["ON", "OFF"]);
    case "orchestration.monsterMinutes":
      return intIn(key, value, 1, 240);
    case "orchestration.monsterSteps":
      return intIn(key, value, 1, 100);
    case "orchestration.monsterParallel":
      return intIn(key, value, 1, 8);
  }
}

export const DEFAULT_AUTONOMY: AutonomyPolicy = {
  level: 2,
  workerAuto: "ASK",
  review: "ASK",
  skillLearning: "PROPOSE",
  budgets: { maxDepth: 2, maxRetries: 2 },
  maxDepth: 2,
  maxParallel: 3,
  taskRetentionDays: 30,
};

export const DEFAULT_ACTIVITY: TraceLevel = "COMPACT";
export const DEFAULT_REASONING: ReasoningMode = "SUMMARY";
export const DEFAULT_TOOLS_VIEW: "COLLAPSED" | "EXPANDED" = "COLLAPSED";
export const DEFAULT_AGENTS_VIEW: "COMPACT" | "DETAILED" = "COMPACT";

/**
 * KAI Doer — autonomous goal execution. A fresh installation has no saved
 * preference, so it starts OFF: KAI answers, plans and observes, but does not
 * dispatch workers or interpret their results on its own. This is deliberately
 * separate from Guard, which is always active and is never switched off here.
 */
export type DoerState = "ON" | "OFF";
export const DEFAULT_DOER: DoerState = "OFF";

/**
 * Monster Mode — carry an authorized mission through its dependent steps
 * without asking again for each one. Bounded on purpose: the limits are not
 * advisory, the mission loop reads them, and exceeding one stops the mission
 * with a blocker instead of continuing silently. Default OFF.
 */
export type MonsterState = "ON" | "OFF";
export const DEFAULT_MONSTER: MonsterState = "OFF";
export const MONSTER_LIMITS = { minutes: 30, steps: 24, parallel: 3 } as const;

export interface OrchestrationPrefs {
  autonomy: AutonomyPolicy;
  activity: TraceLevel;
  reasoning: ReasoningMode;
  toolsView: "COLLAPSED" | "EXPANDED";
  agentsView: "COMPACT" | "DETAILED";
  /** "deterministic" (default) or "deterministic+jev" (optional accelerator). */
  decision: "deterministic" | "deterministic+jev";
  jevMaxCalls: number;
  /** Autonomous goal execution. Guard is unaffected: it is always active. */
  doer: DoerState;
  /** High-autonomy execution profile. Bounded, and never a permission grant. */
  monster: MonsterState;
  monsterMinutes: number;
  monsterSteps: number;
  monsterParallel: number;
}

/** Read effective orchestration prefs: stored rows over safe defaults. */
export function readOrchestrationPrefs(store: SettingsStore): OrchestrationPrefs {
  const get = (key: string): string | null => store.get(key);
  const num = (key: string, fallback: number): number => {
    const raw = get(key);
    const n = raw !== null ? Number(raw) : NaN;
    return Number.isInteger(n) ? n : fallback;
  };
  const pick = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
    const raw = get(key);
    return raw !== null && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
  };
  return {
    autonomy: {
      level: num("orchestration.autonomy", DEFAULT_AUTONOMY.level) as AutonomyLevel,
      workerAuto: pick("orchestration.workerAuto", ["AUTO", "ASK", "OFF"] as const, DEFAULT_AUTONOMY.workerAuto),
      review: pick("orchestration.review", ["AUTO", "ASK", "OFF"] as const, DEFAULT_AUTONOMY.review),
      skillLearning: pick("orchestration.skillLearning", ["OFF", "PROPOSE", "AUTO_SAFE"] as const, DEFAULT_AUTONOMY.skillLearning),
      budgets: {
        maxDepth: num("orchestration.maxDepth", 2),
        maxRetries: num("orchestration.maxRetries", 2),
      },
      maxDepth: num("orchestration.maxDepth", DEFAULT_AUTONOMY.maxDepth),
      maxParallel: num("orchestration.maxParallel", DEFAULT_AUTONOMY.maxParallel),
      taskRetentionDays: num("orchestration.taskRetentionDays", DEFAULT_AUTONOMY.taskRetentionDays),
    },
    activity: pick("orchestration.activity", ["OFF", "COMPACT", "VERBOSE"] as const, DEFAULT_ACTIVITY),
    reasoning: pick("orchestration.reasoning", ["HIDDEN", "SUMMARY", "PROVIDER_EXPOSED"] as const, DEFAULT_REASONING),
    toolsView: pick("orchestration.toolsView", ["COLLAPSED", "EXPANDED"] as const, DEFAULT_TOOLS_VIEW),
    agentsView: pick("orchestration.agentsView", ["COMPACT", "DETAILED"] as const, DEFAULT_AGENTS_VIEW),
    decision: pick("orchestration.decision", ["deterministic", "deterministic+jev"] as const, "deterministic"),
    jevMaxCalls: num("orchestration.jevMaxCalls", 5),
    doer: pick("orchestration.doer", ["ON", "OFF"] as const, DEFAULT_DOER),
    monster: pick("orchestration.monster", ["ON", "OFF"] as const, DEFAULT_MONSTER),
    monsterMinutes: num("orchestration.monsterMinutes", MONSTER_LIMITS.minutes),
    monsterSteps: num("orchestration.monsterSteps", MONSTER_LIMITS.steps),
    monsterParallel: num("orchestration.monsterParallel", MONSTER_LIMITS.parallel),
  };
}
