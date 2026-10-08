// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Routing engine — keyword analysis plus policy-gated dispatch.
 *
 * `analyze` turns a free-text objective into structured task facts (type,
 * difficulty, required skills/tools, risk) using keyword tables only. It never
 * calls a model: classification must be cheap, deterministic, and explainable.
 *
 * `decide` maps (policy, task, workers) to exactly one RoutingDecision:
 *   DO_IT_SELF         difficulty < 0.25, risk READ, no workers available
 *   DELEGATE_ONE       best-ranked capable worker does it
 *   PARALLELIZE        explicit independent subtasks ride along on the task
 *   DELEGATE_AND_REVIEW risk EXTERNAL|DESTRUCTIVE, or difficulty > 0.7,
 *                      or policy.review is not OFF
 *   ASK_USER           policy.workerAuto is ASK with risk beyond READ, or no
 *                      capable worker exists
 *   CHANGE_WORKER      opts.avoid + failureCount >= 2 routes to a different
 *                      (non-avoided) worker
 *
 * Ranking is capability match first, then benchmark value, then latency
 * (normalised 0..1, higher = faster). Rationales are compact user-facing
 * strings built from structured data ("Assigning X — verification 0.97 on
 * coding (23 samples)"), never chain-of-thought.
 */

import type { RiskLevel } from "../shared/contracts.ts";
import type { DifficultySignals, RoutingDecision, TaskDomain, WorkerProfile } from "./types.ts";
import { estimateDifficulty } from "./bench.ts";

export interface DispatcherBench {
  getProfile(workerId: string): WorkerProfile | null;
}

export interface DispatcherDeps {
  bench: DispatcherBench;
  /** Currently reachable worker ids (source of truth for presence). */
  availability: () => string[];
  capabilities: (workerId: string) => { skills: string[]; tools: string[] };
}

export interface TaskAnalysis {
  taskType: TaskDomain;
  difficulty: number;
  requiredSkills: string[];
  requiredTools: string[];
  risk: RiskLevel;
}

export interface AnalyzeOpts {
  signals?: DifficultySignals;
}

export interface DecideTask {
  objective: string;
  taskType: TaskDomain;
  difficulty: number;
  risk: RiskLevel;
  requiredSkills?: string[];
  requiredTools?: string[];
  /** Explicit independent subtasks — presence (2+) selects PARALLELIZE. */
  subtasks?: string[];
}

export interface DecidePolicy {
  workerAuto: "AUTO" | "ASK" | "OFF";
  review: "AUTO" | "ASK" | "OFF";
}

export interface DecideOpts {
  /** Worker ids that already failed this task. */
  avoid?: string[];
  failureCount?: number;
}

export interface Dispatcher {
  analyze(objective: string, opts?: AnalyzeOpts): TaskAnalysis;
  decide(policy: DecidePolicy, task: DecideTask, workers: string[], opts?: DecideOpts): RoutingDecision;
}

/** Ordered most-specific-first; the first domain with a keyword hit wins. */
const DOMAIN_RULES: { domain: TaskDomain; keywords: string[] }[] = [
  { domain: "debugging", keywords: ["debug", "stack trace", "stacktrace", "flaky", "regression", "crash", "bug"] },
  { domain: "testing", keywords: ["unit test", "e2e", "coverage", "test suite", "write test", "add test"] },
  { domain: "review", keywords: ["code review", "pull request", "review", "audit", "critique", "approve"] },
  { domain: "mcp", keywords: ["model context protocol", "mcp server", "mcp tool", "tool server"] },
  { domain: "architecture", keywords: ["adr", "system design", "blueprint", "architect", "design doc", "refactor plan"] },
  { domain: "document", keywords: ["readme", "changelog", "api doc", "user guide", "javadoc", "document"] },
  { domain: "research", keywords: ["research", "investigate", "survey", "landscape", "find out", "what is", "how does", "compare"] },
  { domain: "writing", keywords: ["blog", "essay", "draft", "prose", "announcement", "write-up", "write up", "summar"] },
  { domain: "planning", keywords: ["roadmap", "milestone", "breakdown", "sprint", "schedule", "plan"] },
  { domain: "system", keywords: ["deploy", "docker", "kubernetes", "infra", "pipeline", "server config", "ops"] },
  {
    domain: "coding",
    keywords: ["implement", "endpoint", "feature", "refactor", "component", "cli", "function", "build", "code"],
  },
];

const DESTRUCTIVE_KEYWORDS = ["rm -rf", "destroy", "wipe", "format", "revoke", "delete", "drop table", "drop column"];
const EXTERNAL_KEYWORDS = [
  "publish",
  "send",
  "email",
  "notify",
  "post to",
  "http",
  "api call",
  "fetch remote",
  "network",
  "deploy",
];
const WRITE_KEYWORDS = [
  "write",
  "edit",
  "create",
  "update",
  "fix",
  "implement",
  "refactor",
  "add",
  "change",
  "migrate",
  "remove",
];

const SKILL_RULES: { skill: string; keywords: string[] }[] = [
  { skill: "typescript", keywords: ["typescript", " ts ", " tsx", ".ts"] },
  { skill: "python", keywords: ["python", ".py"] },
  { skill: "react", keywords: ["react", ".tsx", ".jsx"] },
  { skill: "rust", keywords: ["rust", ".rs"] },
  { skill: "sql", keywords: ["sql", "query", "table"] },
  { skill: "docker", keywords: ["docker", "container"] },
  { skill: "testing", keywords: ["test", "coverage", "spec"] },
  { skill: "review", keywords: ["review", "audit"] },
  { skill: "research", keywords: ["research", "survey", "compare"] },
  { skill: "writing", keywords: ["blog", "essay", "draft", "readme", "docs", "document"] },
];

const TOOL_RULES: { tool: string; keywords: string[] }[] = [
  { tool: "read", keywords: ["file", "read", "codebase", "repo"] },
  { tool: "edit", keywords: ["edit", "write", "create", "update", "fix", "implement", "refactor"] },
  { tool: "shell", keywords: ["shell", "terminal", "command", "run ", "script"] },
  { tool: "browser", keywords: ["browser", "web page", "website"] },
  { tool: "git", keywords: ["git", "commit", "branch"] },
  { tool: "test-runner", keywords: ["test", "coverage", "spec"] },
  { tool: "mcp", keywords: ["mcp"] },
];

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function hits(haystack: string, needles: string[]): boolean {
  return needles.some((k) => haystack.includes(k));
}

/** Keyword classification over the 12 TaskDomain values; falls back to "general". */
export function classifyTaskType(objective: string): TaskDomain {
  const text = objective.toLowerCase();
  for (const rule of DOMAIN_RULES) {
    if (hits(text, rule.keywords)) return rule.domain;
  }
  return "general";
}

/** Keyword risk inference; most severe match wins, default READ. */
export function inferRisk(objective: string): RiskLevel {
  const text = objective.toLowerCase();
  if (hits(text, DESTRUCTIVE_KEYWORDS)) return "DESTRUCTIVE";
  if (hits(text, EXTERNAL_KEYWORDS)) return "EXTERNAL";
  if (hits(text, WRITE_KEYWORDS)) return "WRITE";
  return "READ";
}

function dedup(values: string[]): string[] {
  return [...new Set(values)];
}

/** Keyword skill inference (may be empty — no requirement, not "unknown"). */
export function inferSkills(objective: string): string[] {
  const text = ` ${objective.toLowerCase()} `;
  const out: string[] = [];
  for (const rule of SKILL_RULES) {
    if (hits(text, rule.keywords)) out.push(rule.skill);
  }
  return dedup(out);
}

/** Keyword tool inference (may be empty). */
export function inferTools(objective: string): string[] {
  const text = objective.toLowerCase();
  const out: string[] = [];
  for (const rule of TOOL_RULES) {
    if (hits(text, rule.keywords)) out.push(rule.tool);
  }
  return dedup(out);
}

/**
 * Length/signals difficulty heuristic. Base 0.15 + up to 0.4 for length +
 * 0.1 for scope words; when observed signals are passed in, the heuristic and
 * the benchmark's estimateDifficulty each carry half the weight.
 */
export function inferDifficulty(objective: string, signals?: DifficultySignals): number {
  let heuristic = 0.15 + Math.min(0.4, objective.length / 1500);
  if (/(multiple|several|entire|every|across|migrate|all files)/i.test(objective)) heuristic += 0.1;
  heuristic = clamp01(heuristic);
  if (!signals) return heuristic;
  return clamp01(0.5 * heuristic + 0.5 * estimateDifficulty(signals));
}

interface Ranked {
  workerId: string;
  match: number;
  hit: number;
  total: number;
  value: number;
  latency: number;
}

export function createDispatcher(deps: DispatcherDeps): Dispatcher {
  function safeCapabilities(workerId: string): { skills: string[]; tools: string[] } {
    try {
      const caps = deps.capabilities(workerId);
      return {
        skills: (caps.skills ?? []).map((s) => s.toLowerCase()),
        tools: (caps.tools ?? []).map((t) => t.toLowerCase()),
      };
    } catch {
      return { skills: [], tools: [] };
    }
  }

  function score(workerId: string, task: DecideTask): Ranked {
    const caps = safeCapabilities(workerId);
    const reqSkills = (task.requiredSkills ?? []).map((s) => s.toLowerCase());
    const reqTools = (task.requiredTools ?? []).map((t) => t.toLowerCase());
    const total = reqSkills.length + reqTools.length;
    const hitSkills = reqSkills.filter((s) => caps.skills.includes(s)).length;
    const hitTools = reqTools.filter((t) => caps.tools.includes(t)).length;
    const hit = hitSkills + hitTools;
    const match = total === 0 ? 1 : hit / total;
    const profile = deps.bench.getProfile(workerId);
    const value = profile?.overallValue ?? 0;
    let latency = 0;
    if (profile) {
      const stats = Object.values(profile.domains);
      if (stats.length > 0) latency = stats.reduce((sum, s) => sum + s.latency, 0) / stats.length;
    }
    return { workerId, match, hit, total, value, latency };
  }

  /** Capability match first, then benchmark value, then latency (higher = faster). */
  function rank(task: DecideTask, workerIds: string[]): Ranked[] {
    return workerIds
      .map((id) => score(id, task))
      .sort((a, b) => b.match - a.match || b.value - a.value || b.latency - a.latency);
  }

  function assignmentRationale(task: DecideTask, ranked: Ranked, verb = "Assigning"): string {
    const profile = deps.bench.getProfile(ranked.workerId);
    const stats = profile?.domains[task.taskType];
    if (profile && stats && stats.samples > 0) {
      return `${verb} ${ranked.workerId} — verification ${stats.verification.toFixed(2)} on ${task.taskType} (${stats.samples} samples).`;
    }
    if (profile && profile.totalSamples > 0) {
      return `${verb} ${ranked.workerId} — overall value ${profile.overallValue.toFixed(2)} across ${profile.totalSamples} samples (no ${task.taskType} history).`;
    }
    if (ranked.total === 0) {
      return `${verb} ${ranked.workerId} — no prior benchmarks (cold start), no special requirements.`;
    }
    return `${verb} ${ranked.workerId} — no prior benchmarks (cold start); capability match ${ranked.hit}/${ranked.total}.`;
  }

  function alternativesOf(task: DecideTask, ranked: Ranked[], skip: string, limit = 3): RoutingDecision["alternatives"] {
    return ranked
      .filter((r) => r.workerId !== skip)
      .slice(0, limit)
      .map((r) => ({
        workerId: r.workerId,
        value: r.value,
        reason: `value ${r.value.toFixed(2)}, capability match ${Math.round(r.match * 100)}%`,
      }));
  }

  function askUser(reason: string, task: DecideTask, ranked: Ranked[]): RoutingDecision {
    return {
      decision: "ASK_USER",
      workerIds: [],
      rationale: `Asking user — ${reason}`,
      taskType: task.taskType,
      difficulty: task.difficulty,
      alternatives: alternativesOf(task, ranked, ""),
    };
  }

  function analyze(objective: string, opts?: AnalyzeOpts): TaskAnalysis {
    return {
      taskType: classifyTaskType(objective),
      difficulty: inferDifficulty(objective, opts?.signals),
      requiredSkills: inferSkills(objective),
      requiredTools: inferTools(objective),
      risk: inferRisk(objective),
    };
  }

  function decide(policy: DecidePolicy, task: DecideTask, workers: string[], opts?: DecideOpts): RoutingDecision {
    let available: string[];
    try {
      available = deps.availability() ?? [];
    } catch {
      available = [];
    }
    const present = new Set(available);
    const effective = workers.length > 0 ? workers.filter((w) => present.has(w)) : available.filter((w) => w !== undefined);
    const ranked = rank(task, effective);

    // Past failures: route to a different worker once the evidence is clear (>= 2).
    const avoid = new Set(opts?.avoid ?? []);
    const failureCount = opts?.failureCount ?? 0;
    if (avoid.size > 0 && failureCount >= 2) {
      const capable = ranked.filter((r) => r.match === 1 && !avoid.has(r.workerId));
      const fallback = ranked.find((r) => !avoid.has(r.workerId));
      const next = capable[0] ?? fallback;
      if (next) {
        return {
          decision: "CHANGE_WORKER",
          workerIds: [next.workerId],
          rationale:
            `Reassigning to ${next.workerId} after ${failureCount} failures ` +
            `(${[...avoid].join(", ")} avoided) — ${assignmentRationale(task, next, "Assigning").replace(/^Assigning /, "")}`,
          taskType: task.taskType,
          difficulty: task.difficulty,
          alternatives: alternativesOf(task, ranked, next.workerId),
        };
      }
      return askUser(`every available worker is in the avoid list after ${failureCount} failures.`, task, ranked);
    }

    if (ranked.length === 0) {
      if (task.difficulty < 0.25 && task.risk === "READ") {
        return {
          decision: "DO_IT_SELF",
          workerIds: [],
          rationale: `Handling directly — difficulty ${task.difficulty.toFixed(2)} is low, risk is READ, and no workers are available.`,
          taskType: task.taskType,
          difficulty: task.difficulty,
          alternatives: [],
        };
      }
      const reason =
        workers.length > 0
          ? "none of the requested workers are available."
          : "no workers are available and the task is not trivially safe.";
      return askUser(reason, task, ranked);
    }

    const capable = ranked.filter((r) => r.match === 1);
    if (capable.length === 0) {
      const needed = [...(task.requiredSkills ?? []), ...(task.requiredTools ?? [])].join(", ");
      return askUser(`no worker has the required skills/tools (${needed}).`, task, ranked);
    }

    if (policy.workerAuto === "ASK" && task.risk !== "READ") {
      return askUser(`policy requires approval for ${task.risk} work.`, task, ranked);
    }

    const subtasks = task.subtasks ?? [];
    if (subtasks.length >= 2) {
      const first = capable[0];
      if (!first) return askUser("no capable worker for the parallel subtasks.", task, ranked);
      const assigned = subtasks.map((_, i) => {
        const pick = capable[i % capable.length];
        return (pick ?? first).workerId;
      });
      const unique = [...new Set(assigned)];
      return {
        decision: "PARALLELIZE",
        workerIds: unique,
        rationale: `Parallelizing ${subtasks.length} independent subtasks across ${unique.join(", ")}.`,
        taskType: task.taskType,
        difficulty: task.difficulty,
        alternatives: alternativesOf(task, ranked, unique[0] ?? ""),
      };
    }

    const best = capable[0];
    if (!best) return askUser("no capable worker is available.", task, ranked);

    if (task.risk === "EXTERNAL" || task.risk === "DESTRUCTIVE" || task.difficulty > 0.7 || policy.review !== "OFF") {
      const why =
        task.risk === "EXTERNAL" || task.risk === "DESTRUCTIVE"
          ? `${task.risk} risk requires review`
          : task.difficulty > 0.7
            ? `difficulty ${task.difficulty.toFixed(2)} requires review`
            : `policy review is ${policy.review}`;
      return {
        decision: "DELEGATE_AND_REVIEW",
        workerIds: [best.workerId],
        rationale: `${assignmentRationale(task, best)} Review required — ${why}.`,
        taskType: task.taskType,
        difficulty: task.difficulty,
        alternatives: alternativesOf(task, ranked, best.workerId),
      };
    }

    return {
      decision: "DELEGATE_ONE",
      workerIds: [best.workerId],
      rationale: assignmentRationale(task, best),
      taskType: task.taskType,
      difficulty: task.difficulty,
      alternatives: alternativesOf(task, ranked, best.workerId),
    };
  }

  return { analyze, decide };
}
