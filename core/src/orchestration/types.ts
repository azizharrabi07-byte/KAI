// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * KAI orchestration contracts — the ONE vocabulary for the autonomous
 * operator loop. Every orchestrator module (board, bench, dispatch, review,
 * trace, learn, autonomy) speaks these types; nothing invents a parallel
 * task/agent/work state shape.
 *
 * Design rules:
 * - Workers are identifiable profiles, never "Agent #N".
 * - A handoff is structured evidence, never "done" prose.
 * - Benchmarks are measured components, never one opaque number.
 * - Verification is structural (deliverable + evidence + criteria), matching
 *   the existing task synthesis guard — this layer extends it to delegation.
 */

export type WorkItemState =
  | "READY"
  | "CLAIMED"
  | "RUNNING"
  | "WAITING"
  | "REVIEW"
  | "CHANGES_REQUESTED"
  | "COMPLETED"
  | "BLOCKED"
  | "FAILED"
  | "CANCELLED";

/**
 * One evidence record in the CLAIM / OBSERVATION / EVIDENCE split.
 *
 * - `reportedClaims` live on the handoff (worker's words, never trusted).
 * - `observations` are facts KAI obtained itself (workspace inspection or an
 *   authorized check it ran) — this array, `source: "kai-observed"`.
 * - A worker's `EVIDENCE:` section stays `source: "worker-reported"`: counted
 *   for display, NEVER sufficient to satisfy a requirement.
 * - `supports` names the exact required-evidence labels this record settles
 *   (exact string equality — no token/substring matching anywhere).
 */
export interface VerifiedEvidence {
  /** Stable id: `ev_<workItem>_<seq>` (idempotency key for duplicate delivery). */
  id: string;
  /** What was established: file state, diff, test result, build result, etc. */
  kind: string;
  source: "kai-observed" | "worker-reported";
  /** How KAI obtained it: tool id + inputs, or "worker-handoff". */
  method: string;
  /** Human-readable finding (bounded, redacted at collection). */
  detail: string;
  /** File path / line range this record is about, when applicable. */
  path?: string;
  /** Command + cwd, for executed checks. */
  command?: string;
  /** Exit code for executed checks (null = killed/cancelled). */
  exitCode?: number | null;
  /** Bounded stdout/stderr capture for executed checks. */
  outputPreview?: string;
  /** Exact required-evidence labels this record settles. */
  supports: string[];
  /** ISO-8601 collection time. */
  at: string;
}

/** A corrective step the supervisor selected, and where it stands. */
export interface NextActionRecord {
  action: string;
  reason: string;
  /** Proposed, queued, running, done, blocked, or waiting-approval. */
  state: "proposed" | "queued" | "running" | "done" | "blocked" | "waiting-approval";
  /** Child work item carrying the action, when one was created. */
  workItemId?: string;
  /** Approval this action waits on, when parked. */
  approvalId?: string;
  at: string;
}

/** Which skills the supervisor actually selected/loaded for this work. */
export interface SkillReceipt {
  id: string;
  version?: string;
  hash?: string;
  /** Length of the body handed to the worker (bytes). */
  bodyLength: number;
  at: string;
}

/** A unit of delegated work on the KAI work board. Survives restarts. */
export interface WorkItem {
  id: string;
  parentId?: string;
  missionId?: string;
  taskId?: string;
  /**
   * The goal this work item was created for, and the EXACT plan revision that
   * authorised it. Both absent means "not part of a goal" — the pre-existing
   * behaviour. When `goalId` is set, the orchestration boundary refuses to
   * dispatch until that goal's current revision carries a matching approval.
   */
  goalId?: string;
  goalRevisionId?: string;
  objective: string;
  deliverable?: string;
  /**
   * Acceptance criteria that MUST each be met (all_criteria). Threaded from
   * the creation input through the Outcome Contract to the Gate — never
   * silently dropped. Default: derived from the deliverable.
   */
  criteria: string[];
  /** Constraints the worker must respect (also fed to its prompt). */
  constraints: string[];
  /** Outcomes that must not happen (also enforced by the Gate). */
  forbiddenOutcomes: string[];
  /** Required-evidence labels; each needs a kai-observed record to pass. */
  requiredEvidence: string[];
  /**
   * Criterion label -> required-evidence labels supporting it. Absent entries
   * default to ALL required evidence (strict). Additive; old rows lack it.
   */
  evidenceLinks?: Record<string, string[]>;
  /** Budgets binding this item (retries, depth, runtime, cost). */
  budget?: WorkBudget;
  /** Repository working directory evidence checks run in. */
  workingDir?: string;
  workerId?: string;
  workerVersion?: string;
  skills: string[];
  /** Skill selection/loading receipts (Phase 6: what ACTUALLY happened). */
  skillReceipts: SkillReceipt[];
  tools: string[];
  /** KAI-observed + worker-reported evidence records (the trust split). */
  evidence: VerifiedEvidence[];
  /** The latest corrective step and where it stands. */
  nextAction?: NextActionRecord;
  state: WorkItemState;
  attempts: number;
  heartbeats: { at: string; step?: string; note?: string }[];
  outputs?: unknown;
  handoff?: WorkerHandoff;
  verification?: VerificationRecord;
  review?: ReviewRecord;
  cost?: WorkCost;
  tokensIn?: number;
  tokensOut?: number;
  latencyMs?: number;
  failures: string[];
  retries: number;
  valueScore?: number;
  createdAt: string;
  updatedAt: string;
}

/** What every worker returns. A process exit is not a handoff. */
export interface WorkerHandoff {
  status: "ok" | "blocked" | "failed";
  result: string;
  changedArtifacts: string[];
  evidence: string[];
  tests?: string;
  blockers: string[];
  risks: string[];
  followUps: string[];
  recommendedNext?: string;
  tokenCost?: number;
  timeMs?: number;
  toolsUsed: string[];
}

export interface VerificationRecord {
  passed: boolean;
  criteria: { name: string; met: boolean; detail?: string }[];
  at: string;
}

export type ReviewVerdict = "PASS" | "CHANGES_REQUESTED" | "BLOCKED";

export interface ReviewRecord {
  reviewerId: string;
  criteria: string[];
  verdict: ReviewVerdict;
  findings: string[];
  at: string;
}

export interface WorkCost {
  tokensIn?: number;
  tokensOut?: number;
  toolCalls?: number;
  costUsd?: number;
  latencyMs?: number;
}

/** Per-domain measured stats. All rates are 0..1 from real outcomes only. */
export interface DomainStats {
  quality: number;
  verification: number;
  completion: number;
  rework: number;
  tokenEfficiency: number;
  latency: number;
  safety: number;
  samples: number;
  confidence: "low" | "medium" | "high";
  trend: "up" | "flat" | "down";
}

export interface WorkerProfile {
  workerId: string;
  role: string;
  /** Fingerprint of model+provider+instructions+skills+tools+objective config. */
  configVersion: string;
  domains: Record<string, DomainStats>;
  overallValue: number;
  overallConfidence: "low" | "medium" | "high";
  totalSamples: number;
  updatedAt: string;
}

export type TaskDomain =
  | "coding"
  | "debugging"
  | "research"
  | "writing"
  | "architecture"
  | "review"
  | "testing"
  | "document"
  | "mcp"
  | "system"
  | "planning"
  | "general";

export type RoutingDecisionKind =
  | "DO_IT_SELF"
  | "DELEGATE_ONE"
  | "PARALLELIZE"
  | "DELEGATE_AND_REVIEW"
  | "ASK_USER"
  | "CHANGE_WORKER";

export interface RoutingDecision {
  decision: RoutingDecisionKind;
  workerIds: string[];
  /** Compact user-facing rationale from structured data, never chain-of-thought. */
  rationale: string;
  taskType: TaskDomain;
  difficulty: number;
  alternatives: { workerId: string; value: number; reason: string }[];
}

export interface WorkBudget {
  maxToolCalls?: number;
  maxRuntimeMs?: number;
  maxRetries?: number;
  /**
   * How many WORKER REASSIGNMENTS this item may make (a dispatch to a worker
   * different from the one that ran last). Reassignment is the breaker's
   * sanctioned recovery after repeated failure, so it has its own allowance
   * instead of consuming `maxRetries`; it never resets `maxRetries` either.
   * Defaults to `maxRetries`.
   */
  maxReassignments?: number;
  maxCostUsd?: number;
  maxChildren?: number;
  maxDepth?: number;
}

export type AutonomyLevel = 0 | 1 | 2 | 3 | 4;

export interface AutonomyPolicy {
  level: AutonomyLevel;
  workerAuto: "AUTO" | "ASK" | "OFF";
  review: "AUTO" | "ASK" | "OFF";
  skillLearning: "OFF" | "PROPOSE" | "AUTO_SAFE";
  budgets: WorkBudget;
  maxDepth: number;
  maxParallel: number;
  taskRetentionDays: number;
}

export type TraceLevel = "OFF" | "COMPACT" | "VERBOSE";

export type ActivityKind =
  | "plan"
  | "tool"
  | "worker"
  | "review"
  | "approval"
  | "verify"
  | "memory"
  | "skill"
  | "error"
  | "done";

/** One compact status unit. Every instance comes from a real runtime event. */
export interface ActivityEvent {
  seq: number;
  taskId?: string;
  workItemId?: string;
  workerId?: string;
  kind: ActivityKind;
  /** Tiny words: "Searching files", "Coder-2 working", "18/18 passed". */
  label: string;
  detail?: string;
  at: string;
}

export type ReasoningMode = "HIDDEN" | "SUMMARY" | "PROVIDER_EXPOSED";

/** A reusable prompt strategy with measured outcomes. */
export interface PromptPattern {
  id: string;
  taskType: string;
  template: string;
  requiredFields: string[];
  failureModes: string[];
  verification: string[];
  version: number;
  uses: number;
  successes: number;
  updatedAt: string;
}

export type SkillProposalState = "CANDIDATE" | "IN_REVIEW" | "APPROVED" | "INSTALLED" | "REJECTED";

export interface SkillMetrics {
  skillId: string;
  triggers: number;
  successes: number;
  verifications: number;
  failures: number;
  corrections: number;
  tokensUsed: number;
  updatedAt: string;
}

/** Difficulty signals for value normalization (all optional, all observed). */
export interface DifficultySignals {
  fileCount?: number;
  toolCount?: number;
  dependencyCount?: number;
  subtaskCount?: number;
  risk?: "READ" | "WRITE" | "EXTERNAL" | "DESTRUCTIVE";
  reviewRounds?: number;
}
