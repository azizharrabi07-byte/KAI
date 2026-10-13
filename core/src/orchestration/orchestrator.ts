// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The KAI orchestrator — ONE authoritative loop over mission work:
 *
 *   REQUEST -> UNDERSTAND -> SELECT SKILLS -> PLAN -> DECOMPOSE
 *   -> SELECT WORKER(S) -> EXECUTE -> OBSERVE -> VERIFY -> REVIEW
 *   -> RETRY/REASSIGN -> SYNTHESIZE -> COMPLETE
 *
 * It composes the board (work items), bench (benchmarks), dispatcher
 * (routing), prompts (worker prompts + patterns), review (independent
 * verification), trace (real activity), and learn (skill proposals). It does
 * NOT replace missions, tasks, the tool loop, or the policy engine — it sits
 * above delegation and consults each subsystem through injected ports.
 *
 * Constitution: every delegation passes policyCheck first and executes ONLY
 * through the injected delegate port (which the runtime wires to the
 * policy-governed `agents.run_task` tool). ASK autonomy parks through the
 * approvals port. Workers can never mark themselves complete or verified:
 * only the verify + review path here writes terminal states, from evidence.
 */

import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import type { PolicyRequest } from "../policies/gate.ts";
import type {
  AutonomyPolicy,
  ReviewVerdict,
  RoutingDecision,
  SkillReceipt,
  TaskDomain,
  VerificationRecord,
  WorkBudget,
  WorkCost,
  WorkItem,
  WorkerHandoff,
} from "./types.ts";
import type { WorkBoard } from "./board.ts";
import type { Benchmark } from "./bench.ts";
import type { Dispatcher } from "./dispatch.ts";
import type { ActivityTrace, TraceRef } from "./trace.ts";
import type { ProposeInput, SkillCandidate, SkillLearning, SubmitResult } from "./learn.ts";
import { compileTaskPacket, compilerInputFromWorkItem, packetDomain, renderTaskPacket } from "./compiler.ts";
import { buildWorkerPrompt, recordPatternOutcome, selectPattern } from "./prompts.ts";
import type { PromptPatternStore } from "../shared/contracts.ts";
import { buildReviewerPrompt, requestReview, runReviewLoop } from "./review.ts";
import { autoVerdict } from "./autonomy.ts";
import { classifyCriterion, presencePathFor, runnableCommandFor } from "../goals/criteria.ts";
import { redactText } from "../redact/index.ts";
import { estimateDifficulty } from "./bench.ts";
import {
  createOutcomeContract,
  criterionMet,
  evaluateOutcome,
  type KernelAction,
  type Observation,
  type OutcomeContract,
} from "./outcome.ts";
import type { VerifiedEvidence } from "./types.ts";
import type { GoalBudgets } from "../goals/goal.ts";
import type { BudgetLedger, BudgetLimits } from "./budget.ts";
import { debitUsage, usageReportFrom, type WorkerUsageCapability } from "./usage.ts";

/**
 * A per-attempt nonce, so two INDEPENDENT calls for the same item take two
 * debits. A duplicate DELIVERY is identified by its event id instead, and reuses
 * that key — the distinction is what makes redelivery free and a re-run paid.
 */
let budgetAttempts = 0;
function budgetNonce(): string {
  budgetAttempts += 1;
  return `${budgetAttempts.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
import { decideAction, type DecisionProvider, type JevBudget } from "./decision.ts";

/** The corrective actions a provider may rank (all legal by construction). */
const CORRECTIVE_ACTIONS: KernelAction[] = ["VERIFY", "RUN_TESTS", "INSPECT", "RETRY", "REPLAN", "CHANGE_WORKER", "ASK_USER"];

export interface DelegateInput {
  agentId: string;
  prompt: string;
  approvalId?: string;
}

export interface DelegateResult {
  ok: boolean;
  reply?: string;
  parkedApprovalId?: string;
  error?: string;
  cost?: WorkCost;
  latencyMs?: number;
}

export interface ApprovalPorts {
  request(input: { toolId: string; action: string; reason: string; risk: string }): { id: string };
  get(id: string): { status: string } | null;
}

export interface SkillPorts {
  /**
   * Skills to offer this run. The CONTEXT is what makes applicability real: a
   * skill for another platform, or one needing a tool this run does not have, is
   * not a candidate. Absent context means "no applicability filtering".
   */
  relevant(query: string, limit: number, context?: { domain?: string }): { id: string }[];
  load(id: string): { ok: boolean; name?: string; body?: string; reason?: string };
  /** Version + content hash for usage receipts (Phase 6). Optional; absent → receipts carry id only. */
  inspect?(id: string): { version?: string; hash?: string } | null;
}

/**
 * Bounded evidence collection through KAI's OWN tools. The registry boundary
 * still validates + policy-checks every call — this port adds no trust, it
 * only lets supervision inspect the workspace itself instead of taking a
 * worker's word. Callers restrict themselves to the READ allowlist
 * (filesystem.read/list/search/metadata, git.status/log/diff); anything else
 * is refused at the call site, and policy may still park or deny.
 */
export interface SupervisorToolsPort {
  invoke(
    id: string,
    input: unknown,
    opts?: {
      missionId?: string;
      turnId?: string;
      source?: string;
      approvalId?: string;
      /** The goal revision whose tool-call allowance this call spends. */
      goalId?: string;
      goalRevisionId?: string;
      /** The item's declared ceiling, when it has one. */
      maxToolCalls?: number;
    },
  ): Promise<{
    ok: boolean;
    result?: unknown;
    error?: { code: string; message: string };
    /** Registry-created approval when the call parked (resume via onApprovalDecided). */
    approvalId?: string;
  }>;
}

export interface OrchestratorDeps {
  board: WorkBoard;
  bench: Benchmark;
  dispatcher: Dispatcher;
  trace: ActivityTrace;
  learning: SkillLearning;
  patterns: PromptPatternStore;
  reviewRunner: (prompt: string) => Promise<{ verdict: ReviewVerdict; findings: string[] }>;
  delegate: (input: DelegateInput) => Promise<DelegateResult>;
  skills: SkillPorts;
  policyCheck: (input: PolicyRequest) => Promise<{ outcome: "allow" | "deny" | "needs_approval"; reason: string }>;
  approvals: ApprovalPorts;
  autonomy: () => AutonomyPolicy;
  /**
   * May this goal be dispatched right now? Answers from the DURABLE goal store:
   * an approval that still matches the current plan revision. Absent means the
   * runtime has no goal layer and goal-linked items are not gated.
   */
  goalGate?: (goalId: string, goalRevisionId: string | undefined) => { ok: boolean; reason: string };
  /**
   * The AUTHORITATIVE execution budget. Absent → the per-item retry ledger still
   * binds, but the goal-wide rollup does not, so a caller that creates a new item
   * for the same goal revision is not capped here.
   */
  budgetLedger?: BudgetLedger;
  /**
   * The budgets of the approved plan revision, when the goal layer is present.
   * Used ONLY to derive the goal-wide dispatch ceiling.
   */
  goalBudgetFor?: (goalId: string, goalRevisionId: string | undefined) => GoalBudgets | undefined;
  /**
   * What the dispatched worker can REPORT. It decides which limits are
   * enforceable: a worker that reports no tool calls cannot be held to
   * `maxToolCalls`, and saying otherwise would be a claim KAI cannot keep.
   */
  usageCapability?: WorkerUsageCapability;
  publish(type: string, payload: unknown, opts?: { source?: string }): void;
  now?(): string;
  /** KAI's own tools for evidence collection (absent → supervision degrades honestly, never invents). */
  tools?: SupervisorToolsPort;
  /**
   * Record a supervision lesson with provenance (wired to mission-scoped
   * memory). Absent → lessons are traced but not persisted. Never throws.
   */
  rememberLesson?: (input: { scopeId: string; content: string; verified: string }) => { ok: boolean; refusal?: { reason?: string } };
  /**
   * OPTIONAL decision accelerator (JEV). Absent → deterministic only. KAI is
   * never dependent on it: correctness lives in the Outcome Gate, Guard and the
   * deterministic kernel, not in this provider.
   */
  decisionProvider?: DecisionProvider;
  jevBudget?: JevBudget;
}

export interface ObjectiveInput {
  objective: string;
  deliverable?: string;
  /** The goal and plan revision this objective belongs to, when it has one. */
  goalId?: string;
  goalRevisionId?: string;
  constraints?: string[];
  forbidden?: string[];
  successCriteria?: string[];
  requiredEvidence?: string[];
  evidenceLinks?: Record<string, string[]>;
  risk?: string;
  budget?: WorkBudget;
  workingDir?: string;
  taskId?: string;
  missionId?: string;
  subtasks?: string[];
  skills?: string[];
}

export interface StartOutcome {
  workItemId: string;
  childIds: string[];
  decision: RoutingDecision;
  /**
   * TRUE only once a worker was ACTUALLY dispatched through the
   * policy-governed path. Planning/queueing alone is `planned`, never
   * delegated — the old `delegated: true`-on-plan lie is gone.
   */
  delegated: boolean;
  /** A durable work item exists for this objective (planned, not necessarily running). */
  planned: boolean;
  note: string;
}

export interface RunOutcome {
  workItemId: string;
  state: string;
  handoff?: WorkerHandoff;
  verification?: VerificationRecord;
  review?: { verdict: ReviewVerdict; findings: string[] };
  valueScore?: number;
  parkedApprovalId?: string;
  note: string;
}

export interface PendingEvidenceCheck {
  label: string;
  command: string;
  args: string[];
  cwd?: string;
  reason: string;
}

export interface EvidenceGathered {
  /** KAI-observed records (affirmative ones carry supports:[label]). */
  observed: VerifiedEvidence[];
  /** Checks parked for approval (durable; resume with the approval id). */
  pending: PendingEvidenceCheck[];
  /** Labels with no safe check (reason recorded, never invented). */
  blocked: { label: string; reason: string }[];
}

/** Input to the external-report audit: what to audit and where to look. */
export interface ExternalAuditInput {
  reportText: string;
  objective?: string;
  workingDir?: string;
  missionId?: string;
  taskId?: string;
  workerId?: string;
}

/**
 * The audit's answer. `claims` are the worker's UNTRUSTED assertions, `observed`
 * are the facts KAI established itself; `nextPrompt` is the concrete correction
 * prompt, and `launched` says whether KAI auto-delegated it (only when autonomy
 * permits) or left it for the user.
 */
export interface ExternalAuditResult {
  workItemId: string;
  claims: string[];
  observed: VerifiedEvidence[];
  unmetCriteria: string[];
  missingEvidence: string[];
  blockers: string[];
  reviewNotes: string[];
  limitation?: string;
  nextPrompt: string;
  launched: { started: boolean; workItemId?: string; reason: string };
}

export interface RunOpts {
  workerId?: string;
  approvalId?: string;
  candidates?: string[];
  role?: string;
  configVersion?: string;
  /** Delegation depth for corrective children (0 = root objective). */
  depth?: number;
  /**
   * Idempotency key for event-driven resumes (completion/approval event id).
   * A resume carrying a key already recorded in outputs is a no-op — duplicate
   * delivery can never double-execute.
   */
  resumeEventId?: string;
}

const HANDOFF_FORMAT = [
  "STATUS: ok | blocked | failed",
  "RESULT: the deliverable or summary",
  "CHANGED ARTIFACTS: files/paths, one per line",
  "EVIDENCE: facts supporting the result",
  "TESTS: commands run and pass counts",
  "BLOCKERS: what stopped full completion",
  "RISKS: what could still be wrong",
  "FOLLOW-UPS: recommended next steps",
  "RECOMMENDED NEXT STEP: one line",
  "TOOLS USED: tool ids, comma-separated",
].join("\n");

/** Lenient section parser: extracts what matches, never invents the rest. */
export function handoffFromText(text: string): WorkerHandoff {
  const lines = text.split(/\r?\n/);
  const sections = new Map<string, string[]>();
  let current = "RESULT";
  sections.set(current, []);
  for (const line of lines) {
    const header = /^(STATUS|RESULT|CHANGED ARTIFACTS|EVIDENCE|TESTS|BLOCKERS|RISKS|FOLLOW-UPS|RECOMMENDED NEXT STEP|TOOLS USED)\s*:(.*)$/i.exec(line.trim());
    if (header !== null && header[1] !== undefined) {
      current = header[1].toUpperCase();
      if (!sections.has(current)) sections.set(current, []);
      const rest = (header[2] ?? "").trim();
      if (rest.length > 0) sections.get(current)?.push(rest);
      continue;
    }
    sections.get(current)?.push(line);
  }
  const get = (name: string): string => (sections.get(name) ?? []).join("\n").trim();
  const listOf = (name: string): string[] =>
    get(name)
      .split(/\r?\n/)
      .map((l) => l.replace(/^[-*]\s*/, "").trim())
      .filter((l) => l.length > 0 && l.toLowerCase() !== "(none)");
  const statusRaw = get("STATUS").toLowerCase();
  const status = statusRaw.includes("block") ? "blocked" : statusRaw.includes("fail") ? "failed" : "ok";
  const toolsRaw = get("TOOLS USED");
  return {
    status,
    result: get("RESULT").length > 0 ? get("RESULT") : text.trim().slice(0, 4000),
    changedArtifacts: listOf("CHANGED ARTIFACTS"),
    evidence: listOf("EVIDENCE"),
    ...(get("TESTS").length > 0 ? { tests: get("TESTS") } : {}),
    blockers: listOf("BLOCKERS"),
    risks: listOf("RISKS"),
    followUps: listOf("FOLLOW-UPS"),
    ...(get("RECOMMENDED NEXT STEP").length > 0 ? { recommendedNext: get("RECOMMENDED NEXT STEP") } : {}),
    toolsUsed: toolsRaw.length > 0 ? toolsRaw.split(/[,\n]/).map((t) => t.trim()).filter((t) => t.length > 0) : [],
  };
}

/**
 * Structural verification ONLY: deliverable present, evidence CITED (counted,
 * never trusted — worker `EVIDENCE:` text stays worker-reported), no blockers.
 * Per-criterion truth is NOT decided here: every criterion is recorded
 * UNVERIFIED until KAI-observed evidence or an independent review settles it
 * at the Gate. The old substring/token match ("first 24 characters") is gone.
 */
export function verifyHandoff(handoff: WorkerHandoff, criteria: string[]): VerificationRecord {
  const checks: { name: string; met: boolean; detail?: string }[] = [
    { name: "deliverable present", met: handoff.result.trim().length > 0 },
    { name: "evidence cited", met: handoff.evidence.length > 0, detail: `${handoff.evidence.length} item(s) worker-reported` },
    {
      name: "no unresolved blockers",
      met: handoff.blockers.length === 0,
      detail: handoff.blockers.join("; ").slice(0, 200) || undefined,
    },
  ];
  for (const criterion of criteria) {
    const label = criterion.trim();
    checks.push({
      name: `criterion: ${label.slice(0, 80)}`,
      met: false,
      detail: label.length === 0 ? "empty criterion" : "unverified: needs KAI-observed evidence or independent review",
    });
  }
  return { passed: checks.every((c) => c.met), criteria: checks, at: new Date().toISOString() };
}

export function createOrchestrator(deps: OrchestratorDeps) {
  const ref = (item: WorkItem): TraceRef => ({
    ...(item.taskId !== undefined ? { taskId: item.taskId } : {}),
    workItemId: item.id,
    ...(item.workerId !== undefined ? { workerId: item.workerId } : {}),
  });

  function autonomy(): AutonomyPolicy {
    return deps.autonomy();
  }

  function emit(type: string, payload: unknown): void {
    try {
      deps.publish(type, payload, { source: "core" });
    } catch {
      // Observation never breaks orchestration.
    }
  }

  /** Analyze + route an objective without executing anything. */
  function planObjective(
    objective: string,
    opts?: { subtasks?: string[]; risk?: string },
  ): { taskType: TaskDomain; difficulty: number; decision: RoutingDecision } {
    const analysis = deps.dispatcher.analyze(objective);
    const policy = autonomy();
    const decision = deps.dispatcher.decide(
      { workerAuto: policy.workerAuto, review: policy.review },
      {
        objective,
        taskType: analysis.taskType,
        difficulty: analysis.difficulty,
        risk: (opts?.risk ?? analysis.risk) as "READ" | "WRITE" | "EXTERNAL" | "DESTRUCTIVE",
        ...(opts?.subtasks !== undefined ? { subtasks: opts.subtasks } : {}),
      },
      [],
      {},
    );
    return { taskType: analysis.taskType, difficulty: analysis.difficulty, decision };
  }

  function startObjective(input: ObjectiveInput, candidates: string[] = []): StartOutcome {
    const policy = autonomy();
    const emptyDecision = (rationale: string, kind: RoutingDecision["decision"]): StartOutcome => ({
      workItemId: "",
      childIds: [],
      decision: { decision: kind, workerIds: [], rationale, taskType: "general", difficulty: 0, alternatives: [] },
      delegated: false,
      planned: false,
      note: rationale,
    });
    if (policy.level === 0) {
      return emptyDecision("Autonomy is Advisor: objectives are answered, never delegated.", "DO_IT_SELF");
    }
    const analysis = deps.dispatcher.analyze(input.objective);
    const decision = deps.dispatcher.decide(
      { workerAuto: policy.workerAuto, review: policy.review },
      {
        objective: input.objective,
        taskType: analysis.taskType,
        difficulty: analysis.difficulty,
        risk: (input.risk ?? analysis.risk) as "READ" | "WRITE" | "EXTERNAL" | "DESTRUCTIVE",
        ...(input.subtasks !== undefined ? { subtasks: input.subtasks } : {}),
      },
      candidates,
      {},
    );
    if (decision.decision === "DO_IT_SELF" || decision.decision === "ASK_USER") {
      return { workItemId: "", childIds: [], decision, delegated: false, planned: false, note: decision.rationale };
    }
    // Skill auto-selection (Phase 6): when the caller names none, ask the
    // REAL registry for the top matches on the objective. Bodies load later
    // (buildPrompt), capped; selection is recorded on the item either way.
    let skillIds = input.skills ?? [];
    if (skillIds.length === 0) {
      try {
        skillIds = deps.skills
          .relevant(input.objective, 3, { domain: analysis.taskType })
          .map((s) => s.id)
          .slice(0, 3);
      } catch {
        skillIds = [];
      }
    }
    // Every supported requirement rides the item to the Gate (Phase 5).
    const created = deps.board.create({
      objective: input.objective,
      ...(input.deliverable !== undefined ? { deliverable: input.deliverable } : {}),
      ...(input.missionId !== undefined ? { missionId: input.missionId } : {}),
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      ...(input.goalId !== undefined ? { goalId: input.goalId } : {}),
      ...(input.goalRevisionId !== undefined ? { goalRevisionId: input.goalRevisionId } : {}),
      ...(skillIds.length > 0 ? { skills: skillIds } : {}),
      ...(input.successCriteria !== undefined ? { criteria: input.successCriteria } : {}),
      ...(input.constraints !== undefined ? { constraints: input.constraints } : {}),
      ...(input.forbidden !== undefined ? { forbiddenOutcomes: input.forbidden } : {}),
      ...(input.requiredEvidence !== undefined ? { requiredEvidence: input.requiredEvidence } : {}),
      ...(input.evidenceLinks !== undefined ? { evidenceLinks: input.evidenceLinks } : {}),
      ...(input.budget !== undefined ? { budget: input.budget } : {}),
      ...(input.workingDir !== undefined ? { workingDir: input.workingDir } : {}),
    });
    if (!created.ok) {
      return { workItemId: "", childIds: [], decision, delegated: false, planned: false, note: `Work item refused: ${created.reason}` };
    }
    const childIds: string[] = [];
    for (const sub of input.subtasks ?? []) {
      const child = deps.board.createChild(
        created.value.id,
        { objective: sub, ...(input.missionId !== undefined ? { missionId: input.missionId } : {}) },
        { maxDepth: policy.maxDepth, maxChildren: policy.maxParallel },
      );
      if (child.ok) childIds.push(child.value.id);
    }
    deps.trace.record(
      ref(created.value),
      "plan",
      `Planned: ${input.objective.slice(0, 120)}${skillIds.length > 0 ? ` (skills: ${skillIds.join(", ")})` : ""}`,
    );
    // Truthful lifecycle (Phase 2B): planning is PLANNED, not delegated. The
    // item is durable and runnable; `delegated` flips only when a worker is
    // actually dispatched through the policy-governed path in runWorkItem.
    emit("work.planned", {
      workItemId: created.value.id,
      decision: decision.decision,
      rationale: decision.rationale,
      ...(skillIds.length > 0 ? { skills: skillIds } : {}),
    });
    return { workItemId: created.value.id, childIds, decision, delegated: false, planned: true, note: `${decision.rationale} — planned, awaiting dispatch (run to execute)` };
  }

  /** Evaluate state and select the next move. Pure decision, no execution. */
  function nextMove(id: string): { action: string; reason: string } {
    const item = deps.board.get(id);
    if (item === null) return { action: "stop", reason: `unknown work item "${id}"` };
    switch (item.state) {
      case "READY":
        return { action: "assign", reason: "work item is ready for a worker" };
      case "WAITING":
        return { action: "wait", reason: "waiting on an external decision" };
      case "BLOCKED":
        return { action: "ask", reason: item.failures[item.failures.length - 1] ?? "blocked with no recorded reason" };
      case "FAILED":
        return { action: "recover", reason: item.failures[item.failures.length - 1] ?? "failed with no recorded reason" };
      case "CHANGES_REQUESTED":
        return { action: "retry", reason: "reviewer requested changes" };
      case "REVIEW":
        return { action: "review", reason: "awaiting review verdict" };
      case "COMPLETED":
      case "CANCELLED":
        return { action: "stop", reason: `terminal state ${item.state}` };
      case "CLAIMED":
      case "RUNNING":
        return { action: "observe", reason: "worker is active; observe heartbeats" };
      default:
        return { action: "stop", reason: `unrecognized state ${item.state}` };
    }
  }

  function nowIso(): string {
    try {
      return deps.now?.() ?? new Date().toISOString();
    } catch {
      return new Date().toISOString();
    }
  }

  /**
   * Load the item's skill bodies once for this delegation and record RECEIPTS
   * (Phase 6): id + version + content hash + bytes handed over. The receipts
   * persist on the item, so "skill X was followed" is checkable against what
   * actually loaded — never claimed from a list appearance.
   */
  function loadSkillReceipts(item: WorkItem): { bodies: Map<string, string>; receipts: SkillReceipt[] } {
    const bodies = new Map<string, string>();
    const receipts: SkillReceipt[] = [];
    for (const sid of item.skills.slice(0, 5)) {
      try {
        const loaded = deps.skills.load(sid);
        if (!loaded.ok || loaded.body === undefined) {
          deps.trace.record(ref(item), "skill", `Skill ${sid} selected but unloadable: ${loaded.reason ?? "unknown"}`);
          continue;
        }
        bodies.set(sid, loaded.body);
        let version: string | undefined;
        let hash: string | undefined;
        try {
          const inspected = deps.skills.inspect?.(sid);
          version = inspected?.version;
          hash = inspected?.hash;
        } catch {
          // Receipts never break delegation.
        }
        // The receipt must describe the body that was ACTUALLY handed over. When
        // the registry exposes no hash, hash the loaded body here: receipts are
        // deduped by id@hash, so a missing hash made two different bodies of the
        // same skill collapse into one receipt and misreport what was loaded.
        if (hash === undefined) {
          hash = createHash("sha256").update(loaded.body, "utf8").digest("hex");
        }
        receipts.push({
          id: sid,
          ...(version !== undefined ? { version } : {}),
          hash,
          bodyLength: loaded.body.length,
          at: nowIso(),
        });
      } catch {
        deps.trace.record(ref(item), "skill", `Skill ${sid} load threw; skipped`);
      }
    }
    return { bodies, receipts };
  }

  function buildPrompt(
    item: WorkItem,
    workerId: string,
    whySelected: string,
    previousAttempts: string[],
    preloaded?: Map<string, string>,
  ): string {
    // The worker's task domain decides the packet's SHAPE: a coding task gets
    // changed-artifact and build/test sections, a research task gets citation
    // requirements and a no-mutation boundary, and so on. It comes from the same
    // dispatcher that chose the worker, so the packet cannot disagree with the
    // routing decision.
    const domain = ((): TaskDomain => {
      try {
        return deps.dispatcher.analyze(item.objective).taskType;
      } catch {
        // A classifier that cannot decide must not stop a dispatch: fall back to
        // the general packet rather than throwing inside prompt construction.
        return "general";
      }
    })();

    // Only the skills this item selected, loaded once, bounded. A skill that
    // will not load is simply absent from the packet — it is already recorded as
    // a missing receipt, so silence here is not a lost fact.
    const skills = item.skills
      .map((sid) => {
        const body = preloaded?.get(sid) ?? (() => {
          try {
            const loaded = deps.skills.load(sid);
            return loaded.ok ? loaded.body : undefined;
          } catch {
            return undefined;
          }
        })();
        // `relevant: true` is deliberate. These skills came from the registry's
        // own relevance ranking at planning time and a receipt already records
        // that their bodies were loaded and handed over. Re-deciding relevance
        // here would silently drop them while the receipt still claimed the
        // handover — a false receipt. The compiler still caps COUNT and SIZE.
        return body !== undefined ? { id: sid, name: sid, body, relevant: true } : null;
      })
      .filter((skill): skill is { id: string; name: string; body: string; relevant: true } => skill !== null);

    const packet = compileTaskPacket(
      compilerInputFromWorkItem(item, {
        domain,
        role: workerId,
        whySelected,
        // Prior failures are the corrective context; they never widen scope.
        gateObservations: previousAttempts,
        ...(skills.length > 0 ? { skills } : {}),
        // The handoff format stays byte-identical to the one the parser expects.
        handoffFormat: HANDOFF_FORMAT,
      }),
    );
    return renderTaskPacket(packet, packetDomain(domain));
  }

  // ── Evidence collection (Phase 3A/4): KAI inspects the workspace ITSELF ──

  /** READ-only tools supervision may call directly (policy still gates each call). */
  const EVIDENCE_READ_TOOLS = new Set([
    "filesystem.read",
    "filesystem.list",
    "filesystem.search",
    "filesystem.metadata",
    "git.status",
    "git.log",
    "git.diff",
  ]);

  function clipPreview(value: string, budget = 2000): string {
    const redacted = redactText(value);
    return redacted.length <= budget ? redacted : `${redacted.slice(0, budget)}…(truncated)`;
  }

  /** Ground a requirement label in a claimed artifact (exact/suffix match only). */
  function matchArtifact(label: string, artifacts: string[]): string | null {
    const norm = (s: string): string => s.replace(/\\/g, "/").toLowerCase();
    const want = norm(label);
    for (const artifact of artifacts) {
      const have = norm(artifact);
      if (have.length === 0) continue;
      if (want === have || want.includes(have)) return artifact;
      const base = have.split("/").pop() ?? "";
      if (base.length > 3 && want.includes(base)) return artifact;
    }
    return null;
  }

  /**
   * Parse an explicit, safely-runnable test/build command from a requirement
   * label. STRICT allowlist shapes only (program + constrained args, no shell
   * metacharacters — the executor runs argv without a shell anyway). This is
   * ROUTING, not adjudication: the real exit code decides. Anything else
   * returns null (recorded unsupported, never guessed).
   */
  /**
   * Did the intended tests actually RUN?
   *
   * A test runner's exit code alone is NOT proof: `node --test` in a directory
   * with no discoverable tests exits 0 and reports "tests 0 / pass 0", and
   * `go test` prints "no test files". A live Goal Challenger found exactly this
   * and was right, so a zero exit is now only HALF the evidence — the run must
   * also show a POSITIVE count of discovered/executed tests.
   *
   *   - a positive count  -> satisfied (exit 0 + count > 0)
   *   - an explicit zero  -> NOT satisfied, named as a vacuous run
   *   - no count at all   -> NOT satisfied, reported as unestablished
   *
   * A typecheck has no test count to establish, so exit 0 remains its signal.
   */
  function testRunSatisfied(
    cmd: { command: string; args: string[] },
    exitCode: number | null,
    output: string,
  ): { satisfied: boolean; reason: string } {
    const line = `${cmd.command} ${cmd.args.join(" ")}`;
    const counts = {
      // node --test (TAP): `# pass 12`; the summary reporter prints `ℹ pass 12`.
      pass: /(?:^|\n)\s*(?:#|ℹ|i)?\s*pass\s+(\d+)/i.exec(output),
      tests: /(?:^|\n)\s*(?:#|ℹ|i)?\s*tests\s+(\d+)/i.exec(output),
      // pytest: `12 passed`; cargo: `test result: ok. 12 passed; 0 failed`.
      passed: /(\d+)\s+passed\b/i.exec(output),
    };
    const zeroed = /no test files|#\s*tests\s+0\b|\btests\s+0\b|\bpass\s+0\b/i.test(output);
    const n = (m: RegExpExecArray | null): number | null => (m?.[1] !== undefined ? Number(m[1]) : null);
    const positive = [n(counts.pass), n(counts.tests), n(counts.passed)].filter((v): v is number => v !== null && v > 0);

    if (exitCode !== 0) {
      return { satisfied: false, reason: `${line} exited ${exitCode ?? "?"} — failing output retained.` };
    }
    if (positive.length > 0) {
      const most = Math.max(...positive);
      return { satisfied: true, reason: `${line} exited 0 and reported ${most} test(s).` };
    }
    if (zeroed) {
      return {
        satisfied: false,
        reason: `${line} exited 0 but ran ZERO tests (a vacuous pass) — a green exit code is not proof the intended tests exist or ran.`,
      };
    }
    return {
      satisfied: false,
      reason: `${line} exited 0 but no test count could be established from its output, so it cannot be treated as proof the intended tests ran.`,
    };
  }

  /**
   * Parse a CONTENT requirement: `file content equals: <path> = <spec>`.
   *
   * The goal panel kept (correctly) refusing goals whose acceptance criterion was
   * "the file exists" while the stated outcome was byte-exact — because existence
   * cannot detect a trailing newline, and it cannot tell a freshly written file
   * from a leftover one. This is the check that closes that gap: KAI reads the
   * file ITSELF and compares the bytes, so a content requirement is VERIFIED
   * rather than assumed from the worker's word.
   *
   * Specs: `hex:4f4b` (exact bytes) or a quoted literal (`"OK"`, `'OK'`).
   * The comparison is on the file's bytes as re-encoded from its decoded text, so
   * it is exact for UTF-8 (and therefore for every ASCII case) and is reported as
   * a mismatch — never as a pass — for a file that is not valid UTF-8.
   */
  function contentCheckFor(label: string): { path: string; bytes: Buffer; describe: string } | null {
    // Same classifier the architect refuses with: if it is not `file-content`,
    // the gate must not silently treat it as one.
    if (classifyCriterion(label).kind !== "file-content") return null;
    const m = /^\s*file content equals:\s*(.+?)\s*=\s*(.+?)\s*$/i.exec(label);
    if (m === null || m[1] === undefined || m[2] === undefined) return null;
    const path = m[1].trim();
    const spec = m[2].trim();
    if (path.length === 0) return null;
    const hex = /^hex:([0-9a-fA-F]*)$/.exec(spec);
    if (hex !== null && hex[1] !== undefined && hex[1].length % 2 === 0) {
      return { path, bytes: Buffer.from(hex[1], "hex"), describe: `hex ${hex[1].toLowerCase()}` };
    }
    const quoted = /^(["'])([\s\S]*)\1$/.exec(spec);
    if (quoted !== null && quoted[2] !== undefined) {
      const literal = quoted[2].replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\r/g, "\r");
      return { path, bytes: Buffer.from(literal, "utf8"), describe: `the literal ${JSON.stringify(literal)}` };
    }
    return null;
  }

  function testCommandFor(label: string): { command: string; args: string[] } | null {
    // ONE definition, shared with the Goal Architect (`goals/criteria.ts`): the
    // thing that REFUSES a criterion at plan time and the thing that SETTLES it at
    // gate time must not be able to drift apart.
    return runnableCommandFor(label);
  }

  /**
   * Run the safe checks behind required-evidence labels and return typed
   * records. READ inspection runs immediately through the policy-governed
   * tools port; test/build commands run only when autonomy permits
   * (AUTO → execute, ASK → pending approval linkage, OFF → blocked). A
   * negative finding is recorded with EMPTY supports — it informs, it never
   * satisfies. Throws nothing; every label lands in exactly one bucket.
   */
  async function gatherEvidence(
    item: WorkItem,
    handoff: WorkerHandoff,
    entries: string[],
    opts?: { approvalId?: string },
  ): Promise<EvidenceGathered> {
    const observed: VerifiedEvidence[] = [];
    const pending: PendingEvidenceCheck[] = [];
    const blocked: { label: string; reason: string }[] = [];
    const base = (item.evidence ?? []).length;
    let seq = 0;
    const mkId = (): string => `ev_${item.id}_${base + (seq += 1)}`;
    const at = nowIso();
    const cwd = item.workingDir;
    const invokeOpts = {
      ...(item.missionId !== undefined ? { missionId: item.missionId } : {}),
      turnId: `supervise:${item.id}`,
      source: "orchestrator:verify",
      ...(opts?.approvalId !== undefined ? { approvalId: opts.approvalId } : {}),
      // The tool-call allowance belongs to the PLAN REVISION, exactly as the
      // dispatch allowance does, so a goal cannot multiply it by adding items.
      ...(item.goalId !== undefined ? { goalId: item.goalId } : {}),
      ...(item.goalRevisionId !== undefined ? { goalRevisionId: item.goalRevisionId } : {}),
      ...(item.budget?.maxToolCalls !== undefined ? { maxToolCalls: item.budget.maxToolCalls } : {}),
    };
    if (deps.tools === undefined) {
      return {
        observed,
        pending,
        blocked: entries.map((label) => ({
          label,
          reason: "no tools port: supervision cannot inspect; worker claims stay unverified",
        })),
      };
    }
    const tools = deps.tools;
    const policy = autonomy();
    for (const label of entries) {
      // 0. CONTENT checks: KAI reads the file ITSELF and compares the bytes.
      //    This runs before the existence check so a content requirement is
      //    settled by a real comparison, not by the file merely being there.
      const content = contentCheckFor(label);
      if (content !== null) {
        if (cwd === undefined) {
          blocked.push({
            label,
            reason: "no working directory on this work item: a content check cannot be scoped to its own workspace",
          });
          continue;
        }
        const target = isAbsolute(content.path) ? content.path : join(cwd, content.path);
        try {
          const read = await tools.invoke("filesystem.read", { path: target }, invokeOpts);
          if (!read.ok) {
            blocked.push({
              label,
              reason: `content check refused: ${read.error?.code ?? "unknown"} — ${read.error?.message ?? ""}`.slice(0, 200),
            });
            continue;
          }
          const info = typeof read.result === "object" && read.result !== null
            ? (read.result as { content?: unknown; bytes?: unknown })
            : {};
          const text = typeof info.content === "string" ? info.content : "";
          const actual = Buffer.from(text, "utf8");
          const matches = actual.equals(content.bytes);
          observed.push({
            id: mkId(),
            kind: "file content",
            source: "kai-observed",
            method: "filesystem.read + byte comparison",
            detail: matches
              ? `${target} content matches ${content.describe} (${actual.length} bytes) in ${cwd}.`
              : `${target} content does NOT match ${content.describe}: observed ${actual.length} bytes ${JSON.stringify(actual.toString("hex").slice(0, 80))} (text ${JSON.stringify(text.slice(0, 80))}).`,
            path: target,
            // A mismatch records EMPTY supports: it informs, it never satisfies.
            supports: matches ? [label] : [],
            at,
          });
        } catch (error) {
          blocked.push({
            label,
            reason: `content check threw: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200),
          });
        }
        continue;
      }
      // 0b. PRESENCE checks: KAI stats the path ITSELF, so a `file present:`
      //     criterion does not depend on the worker naming the artifact in its
      //     handoff. `deliverable present:` still uses the handoff below, because
      //     that criterion IS about the worker's claim.
      const presencePath = presencePathFor(label);
      if (presencePath !== null) {
        if (cwd === undefined) {
          blocked.push({
            label,
            reason: "no working directory on this work item: a presence check cannot be scoped to its own workspace",
          });
          continue;
        }
        const target = isAbsolute(presencePath) ? presencePath : join(cwd, presencePath);
        try {
          const meta = await tools.invoke("filesystem.metadata", { path: target }, invokeOpts);
          if (!meta.ok) {
            blocked.push({
              label,
              reason: `presence check refused: ${meta.error?.code ?? "unknown"} — ${meta.error?.message ?? ""}`.slice(0, 200),
            });
            continue;
          }
          const info = typeof meta.result === "object" && meta.result !== null
            ? (meta.result as { exists?: unknown; size?: unknown })
            : {};
          const exists = info.exists === true;
          observed.push({
            id: mkId(),
            kind: "file state",
            source: "kai-observed",
            method: "filesystem.metadata",
            detail: exists
              ? `${target} exists${typeof info.size === "number" ? ` (${info.size} bytes)` : ""} in ${cwd}.`
              : `${target} is ABSENT in ${cwd}.`,
            path: target,
            supports: exists ? [label] : [],
            at,
          });
        } catch (error) {
          blocked.push({ label, reason: `presence check threw: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200) });
        }
        continue;
      }
      // 1. Claimed-artifact checks: existence + working-tree state.
      //
      // SCOPED TO THE ITEM'S WORKSPACE. `filesystem.metadata` resolves a bare
      // path against KAI's OWN sandbox roots, so an unscoped check would verify
      // whatever KAI happens to have at that path — evidence about the wrong
      // tree, which could satisfy the gate for work KAI never inspected. With
      // no `workingDir` there is no workspace to check, so the label is
      // recorded as unverifiable instead of being checked against KAI's cwd.
      const artifact = matchArtifact(label, handoff.changedArtifacts);
      if (artifact !== null) {
        if (cwd === undefined) {
          blocked.push({
            label,
            reason: "no working directory on this work item: the claimed artifact cannot be checked against its own workspace",
          });
          continue;
        }
        const target = isAbsolute(artifact) ? artifact : join(cwd, artifact);
        try {
          const meta = await tools.invoke("filesystem.metadata", { path: target }, invokeOpts);
          // A REFUSED call is not a fact about the file. The tool answers
          // `ok:false` when it will not look (out-of-sandbox path, policy), and
          // treating that as "absent" invented an observation for a path KAI
          // never stat'd. Refusals are recorded as unverifiable, with the
          // tool's own reason, and never as an observation.
          if (!meta.ok) {
            blocked.push({
              label,
              reason: `artifact check refused: ${meta.error?.code ?? "unknown"} — ${meta.error?.message ?? ""}`.slice(0, 200),
            });
            continue;
          }
          const info = typeof meta.result === "object" && meta.result !== null
            ? (meta.result as Record<string, unknown>)
            : null;
          const exists = info?.["exists"] === true;
          let diffNote = "";
          try {
            const st = await tools.invoke("git.status", { cwd }, invokeOpts);
            if (st.ok) diffNote = ` git: ${clipPreview(JSON.stringify(st.result)).slice(0, 300)}`;
          } catch {
            // Status is enrichment; existence is the verdict.
          }
          observed.push({
            id: mkId(),
            kind: "file state",
            source: "kai-observed",
            method: "filesystem.metadata + git.status",
            detail: exists
              ? `${target} exists${typeof info?.["size"] === "number" ? ` (${info["size"]} bytes)` : ""} in ${cwd}.${diffNote}`
              : `${target} ABSENT in ${cwd} — claimed change not on disk.${diffNote}`,
            path: target,
            supports: exists ? [label] : [],
            at,
          });
        } catch (error) {
          blocked.push({ label, reason: `artifact check threw: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200) });
        }
        continue;
      }
      // 2. Test/build commands: explicit shapes only, autonomy-gated.
      const cmd = testCommandFor(label);
      if (cmd !== null) {
        const verdict = autoVerdict(policy, "verify", "DESTRUCTIVE");
        if (verdict === "OFF") {
          blocked.push({ label, reason: "verification OFF by autonomy policy" });
          continue;
        }
        if (verdict === "ASK" && opts?.approvalId === undefined) {
          pending.push({ label, ...cmd, ...(cwd !== undefined ? { cwd } : {}), reason: "shell execution needs approval" });
          continue;
        }
        try {
          const ran = await tools.invoke(
            "shell.run",
            { command: cmd.command, args: cmd.args, ...(cwd !== undefined ? { cwd } : {}), timeoutMs: 120000 },
            invokeOpts,
          );
          if (!ran.ok && ran.error?.code === "APPROVAL_REQUIRED") {
            pending.push({
              label,
              ...cmd,
              ...(cwd !== undefined ? { cwd } : {}),
              reason: `parked for approval ${ran.approvalId ?? "(registry)"}`,
            });
            continue;
          }
          if (!ran.ok) {
            blocked.push({ label, reason: `check refused: ${ran.error?.code ?? "unknown"} — ${ran.error?.message ?? ""}`.slice(0, 200) });
            continue;
          }
          const value = (ran.result ?? {}) as Record<string, unknown>;
          const exitCode = typeof value["exitCode"] === "number" ? value["exitCode"] : null;
          const out = clipPreview(
            `${typeof value["stdout"] === "string" ? value["stdout"] : ""}\n${typeof value["stderr"] === "string" ? value["stderr"] : ""}`.trim(),
          );
          // Exit 0 is necessary, never sufficient: the run must also show that
          // the intended tests actually executed.
          const verdictOfRun = testRunSatisfied(cmd, exitCode, `${value["stdout"] ?? ""}\n${value["stderr"] ?? ""}`);
          observed.push({
            id: mkId(),
            kind: "test result",
            source: "kai-observed",
            method: "shell.run",
            detail: verdictOfRun.reason,
            command: `${cmd.command} ${cmd.args.join(" ")}${cwd !== undefined ? ` (cwd ${cwd})` : ""}`,
            exitCode,
            outputPreview: out,
            // A vacuous or unestablished run records EMPTY supports: it informs,
            // it never satisfies.
            supports: verdictOfRun.satisfied ? [label] : [],
            at,
          });
        } catch (error) {
          blocked.push({ label, reason: `test run threw: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200) });
        }
        continue;
      }
      // 3. Nothing safe applies.
      blocked.push({ label, reason: "no safe check available: name a claimed file path or an explicit test command" });
    }
    return { observed, pending, blocked };
  }

  /**
   * Record a supervision lesson on verified completion (Phase 10): mission-
   * scoped, provenance-carrying, gate verdict as the verified basis. A worker's
   * assertion is never saved as trusted memory — only KAI's own verified
   * outcome is. Refusals are surfaced in the trace, never swallowed; lessons
   * never break completion.
   */
  function recordCompletionLesson(item: WorkItem, handoff: WorkerHandoff, gateResult: string): void {
    if (deps.rememberLesson === undefined) return;
    const missionId = item.missionId;
    if (missionId === undefined || missionId.length === 0) return;
    try {
      const lines = [
        `Work completed and verified: ${item.objective.slice(0, 200)}`,
        `verified basis: outcome-gate ${gateResult}`,
        `criteria: ${item.criteria.slice(0, 5).join("; ").slice(0, 300) || "(deliverable)"}`,
        `evidence records: ${(item.evidence ?? []).filter((r) => r.source === "kai-observed").length} observed`,
      ];
      if (handoff.blockers.length > 0) lines.push(`residual risks: ${handoff.blockers.slice(0, 3).join("; ").slice(0, 200)}`);
      if (handoff.risks.length > 0) lines.push(`noted risks: ${handoff.risks.slice(0, 3).join("; ").slice(0, 200)}`);
      const outcome = deps.rememberLesson({ scopeId: missionId, content: lines.join("\n"), verified: `outcome-gate:${gateResult}` });
      if (!outcome.ok) {
        deps.trace.record(ref(item), "memory", `Supervision lesson refused: ${outcome.refusal?.reason ?? "unknown"}`);
      }
    } catch (error) {
      // A lesson write that THREW must be as visible as one that was refused —
      // otherwise a failure to record looks identical to "nothing to record".
      // It still never breaks completion.
      try {
        deps.trace.record(
          ref(item),
          "memory",
          `Supervision lesson write threw: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300),
        );
      } catch {
        // Tracing must not break completion either.
      }
    }
  }

  /**
   * Continue a WAITING/CHANGES_REQUESTED item's evidence collection (approval
   * verdicts, restarts, supervisor resumes land here). Never restarts
   * delegation: it gathers with the stored handoff, merges observations, and
   * re-gates through finishComplete.
   */
  async function resumeEvidenceRun(
    id: string,
    item: WorkItem,
    labels: string[],
    opts: RunOpts,
    dedupeKey?: string,
  ): Promise<RunOutcome> {
    const claimed = deps.board.claim(id, item.workerId ?? "supervisor");
    if (!claimed.ok) return { workItemId: id, state: item.state, note: claimed.reason };
    if (dedupeKey !== undefined) markResumeKey(id, dedupeKey);
    deps.trace.record(ref(claimed.value), "verify", `Resuming evidence collection (${labels.length} label(s))`);
    emit("worker.progress", { workItemId: id, phase: "evidence", result: "resumed" });
    const handoff = item.handoff ?? emptyFailedHandoff("resume without prior handoff");
    const gathered = await gatherEvidence(
      claimed.value,
      handoff,
      labels.slice(0, 8),
      { ...(opts.approvalId !== undefined ? { approvalId: opts.approvalId } : {}) },
    );
    mergeEvidence(id, gathered.observed);
    // The pending labels have now been consumed: clear them so a later re-entry
    // re-delegates (subject to the ceiling) instead of silently re-gathering
    // the same checks. `undefined` deletes the key on persist.
    if (gathered.pending.length === 0) {
      deps.board.annotate(id, { pendingEvidence: undefined });
    }
    if (gathered.pending.length > 0) {
      const first = gathered.pending[0]!;
      const approval = deps.approvals.request({
        toolId: "orchestrator.verify",
        action: `run evidence checks for work item ${id}`,
        reason: `Evidence requires guarded execution: ${first.label.slice(0, 120)}`,
        risk: "DESTRUCTIVE",
      });
      deps.board.wait(id, `evidence gathering parked for approval ${approval.id}`);
      const cur = deps.board.get(id);
      if (cur !== null) {
        const outputs = readOutputs(cur);
        deps.board.annotate(id, {
          ...outputs,
          parked: { approvalId: approval.id, workerId: item.workerId, kind: "evidence" },
          pendingEvidence: { labels: gathered.pending.map((p) => p.label), requestedAt: nowIso() },
        });
      }
      emit("worker.waiting", { workItemId: id, approvalId: approval.id, reason: "evidence checks need approval" });
      emit("approval.requested", { approvalId: approval.id, workItemId: id, reason: "evidence checks need approval" });
      const stored = deps.board.get(id);
      return {
        workItemId: id,
        state: "WAITING",
        handoff,
        verification: stored?.verification ?? verifyHandoff(handoff, []),
        parkedApprovalId: approval.id,
        note: `Evidence gathering parked for approval ${approval.id}`,
      };
    }
    const stored = deps.board.get(id) ?? claimed.value;
    const verification = stored.verification ?? verifyHandoff(handoff, stored.deliverable !== undefined ? [stored.deliverable] : []);
    const review = stored.review !== undefined
      ? { verdict: stored.review.verdict, findings: stored.review.findings }
      : null;
    return finishComplete(id, stored.workerId ?? item.workerId ?? "supervisor", handoff, verification, review, {
      latencyMs: 0,
      role: "worker",
      configVersion: "v1",
      domain: "general",
      ...(opts.approvalId !== undefined ? { approvalId: opts.approvalId } : {}),
    });
  }

  async function runWorkItem(id: string, opts: RunOpts = {}): Promise<RunOutcome> {
    const started = Date.now();
    const item = deps.board.get(id);
    if (item === null) return { workItemId: id, state: "UNKNOWN", note: `unknown work item "${id}"` };
    // ── The goal gate ─────────────────────────────────────────────────────────
    // An item created from a goal plan may not be dispatched until the goal's
    // CURRENT revision carries a matching approval. This is checked HERE, at the
    // one boundary every dispatch passes through — HTTP routes, the slash
    // command, the Doer drain, corrective children and approval resumes — so a
    // new caller cannot forget it. An item with no `goalId` is not part of a
    // goal and is unaffected.
    if (item.goalId !== undefined && deps.goalGate !== undefined) {
      const gate = deps.goalGate(item.goalId, item.goalRevisionId);
      if (!gate.ok) {
        deps.trace.record(ref(item), "plan", `Dispatch refused: ${gate.reason}`);
        return { workItemId: id, state: item.state, note: `not dispatchable: ${gate.reason}` };
      }
    }
    const policy = autonomy();
    // Duplicate-delivery guard (Phase 2C/12-10): a resume key (completion /
    // approval event id) recorded on the item makes a redelivered trigger a
    // no-op. External side effects are never blindly replayed.
    const outputs0 = readOutputs(item);
    const resumeKeys = Array.isArray(outputs0["resumeKeys"]) ? (outputs0["resumeKeys"] as string[]) : [];
    const dedupeKey = opts.resumeEventId ?? (opts.approvalId !== undefined ? `approval:${opts.approvalId}` : undefined);
    if (dedupeKey !== undefined && resumeKeys.includes(dedupeKey)) {
      return { workItemId: id, state: item.state, note: `duplicate delivery ${dedupeKey} ignored — no double execution` };
    }

    // Resume path: a WAITING/CHANGES_REQUESTED item with pending evidence
    // continues gathering (e.g. after an approval verdict or a restart)
    // instead of restarting delegation from scratch.
    const pending = outputs0["pendingEvidence"] as { labels?: string[] } | undefined;
    if (
      (item.state === "WAITING" || item.state === "CHANGES_REQUESTED") &&
      pending !== undefined && Array.isArray(pending.labels) && pending.labels.length > 0
    ) {
      return resumeEvidenceRun(id, item, pending.labels, opts, dedupeKey);
    }

    // Resume path: a REVIEW park is NOT a dispatch. The item parked because
    // review policy is ASK — "a human clears the review" — so approving it must
    // produce the review OUTCOME and settle through the gate. Treating it as a
    // fresh run re-dispatched the worker, consumed another attempt and could
    // park again forever (observed: ledger [initial, retry], then a second park).
    const parked = outputs0["parked"] as { approvalId?: string; kind?: string } | undefined;
    if (
      item.state === "REVIEW" &&
      parked?.kind === "review" &&
      opts.approvalId !== undefined &&
      parked.approvalId === opts.approvalId
    ) {
      const handoff = item.handoff;
      if (handoff === undefined) {
        return { workItemId: id, state: item.state, note: "review resume has no stored handoff to settle" };
      }
      const claimedReview = deps.board.claim(id, item.workerId ?? "reviewer");
      if (!claimedReview.ok) return { workItemId: id, state: item.state, note: claimedReview.reason };
      if (dedupeKey !== undefined) markResumeKey(id, dedupeKey);
      const cleared = claimedReview.value.workerId ?? item.workerId ?? "worker";
      deps.trace.record(ref(claimedReview.value), "review", "A human cleared the review — settling through the gate");
      emit("review.decided", { workItemId: id, verdict: "PASS", rounds: 0, by: "human" });
      const verification = item.verification ?? verifyHandoff(handoff, item.deliverable !== undefined ? [item.deliverable] : []);
      return finishComplete(id, cleared, handoff, verification, { verdict: "PASS", findings: ["review cleared by a human"] }, {
        latencyMs: 0,
        role: "worker",
        configVersion: "v1",
        domain: "general",
        ...(opts.approvalId !== undefined ? { approvalId: opts.approvalId } : {}),
      });
    }

    // A REVIEW park means a HUMAN is the reviewer. A plain run must not slip past
    // it and re-dispatch the worker (that duplicated real work and burned
    // budget); the approval is the only way forward.
    if (item.state === "REVIEW" && parked?.kind === "review" && opts.approvalId === undefined) {
      const waitingOn = parked.approvalId ?? "(unknown)";
      deps.trace.record(ref(item), "review", `Run refused: a human review (${waitingOn}) is pending`);
      return {
        workItemId: id,
        state: item.state,
        note: `waiting for a human review (approval ${waitingOn}) — decide the approval instead of re-running`,
      };
    }
    /**
     * Resuming a PARKED DELEGATION continues the SAME attempt: the worker never
     * ran when the park happened, so the approval must not be charged as a fresh
     * retry (otherwise two approvals could exhaust the budget with a single real
     * execution). Evidence parks are handled above and review parks above that.
     */
    const resumingParkedDispatch =
      item.state === "WAITING" &&
      opts.approvalId !== undefined &&
      parked?.approvalId !== undefined &&
      parked.approvalId === opts.approvalId &&
      parked.kind === undefined;

    const analysis = deps.dispatcher.analyze(item.objective);
    // Worker selection: explicit > ranked (avoiding repeat failures).
    let workerId = opts.workerId;
    let whySelected = "explicitly assigned";
    if (workerId === undefined) {
      const failures = item.failures.length;
      const decision = deps.dispatcher.decide(
        { workerAuto: policy.workerAuto, review: policy.review },
        {
          objective: item.objective,
          taskType: analysis.taskType,
          difficulty: analysis.difficulty,
          risk: analysis.risk,
        },
        opts.candidates ?? [],
        { ...(failures > 0 ? { failureCount: failures } : {}) },
      );
      if (decision.decision === "DO_IT_SELF" || decision.decision === "ASK_USER" || decision.workerIds.length === 0) {
        return { workItemId: id, state: item.state, note: `No worker selected: ${decision.rationale}` };
      }
      workerId = decision.workerIds[0] as string;
      whySelected = decision.rationale;
      if (decision.decision === "CHANGE_WORKER") {
        deps.trace.record(ref(item), "worker", `Switching worker: ${whySelected.slice(0, 160)}`);
      }
    }

    // ── RETRY BUDGET, ENFORCED AT THE BOUNDARY (per ITEM) ────────────────────
    // The item's durable dispatch ledger is the authoritative attempt record,
    // and the ceiling is checked HERE — before any claim or delegation — so no
    // caller can exceed it: not the API, not the UI's run control, not a
    // supervisor resume, not a caller that rotates through workers.
    //
    // Attempts are classified by the ledger, from the previous dispatch:
    //   initial (1, free) · retry (same worker, ≤ maxRetries) ·
    //   reassign (different worker, ≤ maxReassignments).
    // Reassignment is the breaker's sanctioned "never blind retry" path
    // (./bench.ts, scripts/orch-e2e.mjs S2), so it has its own allowance — but
    // it never resets the retry count, and both ceilings bind the same item.
    const refusal = resumingParkedDispatch ? null : retryRefusal(item, policy, workerId);
    if (refusal !== null) {
      deps.trace.record(ref(item), "error", refusal);
      emit("worker.progress", { workItemId: id, phase: "retry", result: "refused", workerId });
      deps.board.block(id, refusal);
      recordNextAction(id, "STOP", refusal, "blocked");
      return { workItemId: id, state: "BLOCKED", note: refusal };
    }

    // ── EXECUTION BUDGET, ENFORCED AT THE SAME BOUNDARY (per GOAL REVISION) ──
    // The item ledger above bounds ONE item. This bounds the revision: every
    // item of the approved plan draws on one allowance, so a corrective child or
    // a caller that creates a NEW item cannot mint a fresh one. Reserved BEFORE
    // the claim, so an interrupted dispatch is never replayed for free.
    let reservedId = "";
    if (!resumingParkedDispatch) {
      const reserved = reserveDispatch(id, item, dedupeKey);
      if (!reserved.ok) {
        emit("budget.refused", { workItemId: id, workerId, reason: reserved.reason });
        deps.board.block(id, reserved.reason);
        recordNextAction(id, "STOP", reserved.reason, "blocked");
        return { workItemId: id, state: "BLOCKED", note: reserved.reason };
      }
      reservedId = reserved.reservationId;
    }

    const claimed = deps.board.claim(id, workerId);
    if (!claimed.ok) {
      // Nothing was dispatched, so the reservation is REWOUND rather than
      // burned. Only a reservation whose operation provably never ran may be
      // released; a refusal to claim is exactly that.
      if (reservedId !== "") deps.budgetLedger?.release(reservedId, "the item could not be claimed, so nothing was dispatched");
      return { workItemId: id, state: item.state, note: claimed.reason };
    }
    if (!resumingParkedDispatch) appendDispatch(id, workerId);
    deps.trace.record(ref(claimed.value), "worker", `${workerId} working`);
    emit("worker.started", { workItemId: id, workerId });
    deps.board.heartbeat(id, "started", workerId);

    // Constitution: delegation passes policy first, executes only through the
    // policy-governed delegate port.
    const gate = await deps.policyCheck({ toolId: "agents.run_task", action: `run ${workerId} on objective`, risk: "EXTERNAL" });
    if (gate.outcome === "deny") {
      // The worker never ran, so the dispatch budget is rewound.
      if (reservedId !== "") deps.budgetLedger?.release(reservedId, "policy denied the delegation before the worker ran");
      deps.board.block(id, `policy denied delegation: ${gate.reason}`);
      deps.trace.record(ref(claimed.value), "error", `Blocked: ${gate.reason}`);
      return { workItemId: id, state: "BLOCKED", note: `Policy denied delegation: ${gate.reason}` };
    }
    const verdict = autoVerdict(policy, "delegate", "EXTERNAL");
    if (verdict === "OFF") {
      if (reservedId !== "") deps.budgetLedger?.release(reservedId, "delegation is disabled by autonomy policy");
      deps.board.block(id, "delegation disabled by autonomy policy");
      return { workItemId: id, state: "BLOCKED", note: "Delegation is OFF." };
    }

    // Skill receipts: what was actually selected AND loaded for this run.
    const { bodies: skillBodies, receipts } = loadSkillReceipts(claimed.value);
    if (receipts.length > 0) deps.board.recordSkillReceipts(id, receipts);
    const prompt = buildPrompt(claimed.value, workerId, whySelected, item.failures, skillBodies);
    const pattern = selectPattern(deps.patterns, analysis.taskType);
    // The execution consumes the idempotency key (approval or resume event):
    // a redelivered trigger after this point is a duplicate, never a rerun.
    if (dedupeKey !== undefined) markResumeKey(id, dedupeKey);
    emit("delegation.routed", { workItemId: id, workerId, decision: "DELEGATE_ONE", rationale: whySelected });
    let delegated: DelegateResult;
    try {
      delegated = await deps.delegate({
        agentId: workerId,
        prompt,
        ...(opts.approvalId !== undefined ? { approvalId: opts.approvalId } : {}),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      deps.board.recordFailure(id, reason, workerId, analysis.taskType);
      deps.board.fail(id, reason);
      deps.trace.record(ref({ ...item, workerId }), "error", reason);
      emit("worker.failed", { workItemId: id, workerId, reason });
      const thrown = emptyFailedHandoff(reason);
      recordBench(id, workerId, benchCtx(analysis, opts, Date.now() - started), thrown, verifyHandoff(thrown, []), null);
      return { workItemId: id, state: "FAILED", handoff: thrown, verification: verifyHandoff(thrown, []), note: reason };
    }

    // ASK path: parked for a human. The approval id is recorded on the item
    // (outputs.parked, persisted) so onApprovalDecided resumes exactly this
    // work, even across a restart.
    if (!delegated.ok && delegated.parkedApprovalId !== undefined) {
      const parkedId = delegated.parkedApprovalId;
      deps.board.wait(id, `waiting for approval ${parkedId}`);
      deps.board.annotate(id, { parked: { approvalId: parkedId, workerId } });
      deps.trace.record(ref({ ...item, workerId }), "approval", "Waiting for approval");
      emit("worker.waiting", { workItemId: id, workerId, approvalId: parkedId });
      return { workItemId: id, state: "WAITING", parkedApprovalId: parkedId, note: `Waiting for approval ${parkedId}` };
    }
    if (!delegated.ok) {
      const reason = delegated.error ?? "delegation failed";
      const failure = deps.board.recordFailure(id, reason, workerId, analysis.taskType);
      const budget = budgetNote(deps.board.get(id) ?? item, policy);
      deps.board.fail(id, reason);
      deps.trace.record(ref({ ...item, workerId }), "error", reason);
      emit("worker.failed", { workItemId: id, workerId, reason });
      // Delegate-level failures still teach the bench: an empty handoff that
      // fails verification, recorded like any other failed outcome.
      const emptyHandoff = emptyFailedHandoff(reason);
      const emptyVerification = verifyHandoff(emptyHandoff, []);
      recordBench(id, workerId, benchCtx(analysis, opts, Date.now() - started), emptyHandoff, emptyVerification, null);
      const rec = failure.ok ? failure.value.recommendation : null;
      return { workItemId: id, state: "FAILED", handoff: emptyHandoff, verification: emptyVerification, note: rec !== null ? `${reason} — recommended: ${rec.action} (${rec.reason})` : `${reason} — ${budget}` };
    }

    debitWorkerUsage(id, item, workerId, delegated);

    return completeFromReply(id, workerId, delegated.reply ?? "", {
      latencyMs: delegated.latencyMs ?? (Date.now() - started),
      ...(delegated.cost !== undefined ? { cost: delegated.cost } : {}),
      ...(opts.approvalId !== undefined ? { approvalId: opts.approvalId } : {}),
      role: opts.role ?? "worker",
      configVersion: opts.configVersion ?? "v1",
      domain: analysis.taskType,
      patternId: pattern?.id,
    });
  }

  interface CompletionCtx {
    latencyMs: number;
    cost?: WorkCost;
    approvalId?: string;
    role: string;
    configVersion: string;
    domain: TaskDomain;
    patternId?: string;
  }

  /** An empty failed handoff so delegate-level failures still teach the bench. */
  function emptyFailedHandoff(reason: string): WorkerHandoff {
    return {
      status: "failed",
      result: reason,
      changedArtifacts: [],
      evidence: [],
      blockers: [reason],
      risks: [],
      followUps: [],
      toolsUsed: [],
    };
  }

  /** Completion context for paths that never reached delegation output. */
  function benchCtx(
    analysis: { taskType: TaskDomain },
    opts: RunOpts,
    latencyMs: number,
  ): CompletionCtx {
    return {
      latencyMs,
      role: opts.role ?? "worker",
      configVersion: opts.configVersion ?? "v1",
      domain: analysis.taskType,
    };
  }

  async function completeFromReply(id: string, workerId: string, reply: string, ctx: CompletionCtx): Promise<RunOutcome> {
    const policy = autonomy();
    const item = deps.board.get(id);
    if (item === null) return { workItemId: id, state: "UNKNOWN", note: `unknown work item "${id}"` };
    const handoff = handoffFromText(reply);
    // Persist what the worker actually said BEFORE any review or evidence
    // gathering: a run that parks (review ASK, guarded check) must be
    // resumable, and the resume re-gates on THIS handoff. Losing it here made
    // a parked item unresolvable (an empty failed handoff blocked its own gate).
    deps.board.recordHandoff(id, handoff);
    const criteria = item.deliverable !== undefined ? [item.deliverable] : [];
    const verification = verifyHandoff(handoff, criteria);

    // A worker that produced no deliverable (or is blocked/failed) did not
    // deliver: record, consult the breaker, do NOT complete. Retry is
    // bounded; the breaker may reassign or escalate.
    const empty = handoff.status !== "ok" || handoff.result.trim().length === 0;
    if (empty) {
      const reason = handoff.status !== "ok"
        ? `handoff ${handoff.status}: ${handoff.blockers.join("; ").slice(0, 200) || handoff.result.slice(0, 200)}`
        : "empty result: no deliverable to verify";
      const failure = deps.board.recordFailure(id, reason, workerId);
      const budget = budgetNote(deps.board.get(id) ?? item, policy);
      deps.board.fail(id, reason);
      const rec = failure.ok ? failure.value.recommendation : null;
      deps.trace.record(ref({ ...item, workerId }), "error", reason);
      emit("worker.failed", { workItemId: id, workerId, reason });
      recordBench(id, workerId, ctx, handoff, verification, null);
      return {
        workItemId: id,
        state: "FAILED",
        handoff,
        verification,
        note: rec !== null ? `${reason} — recommended: ${rec.action} (${rec.reason})` : `${reason} — ${budget}`,
      };
    }
    // A deliverable exists but structural verification is thin (typically a
    // free-text reply with no cited evidence): route to REVIEW rather than
    // failing outright. The independent reviewer judges what the checklist
    // cannot, and its verdict compensates the thin checks below.
    const thin = !verification.passed;

    // Review for high-value work. OFF skips; ASK parks for a human decision.
    // A thin (evidence-light) deliverable with review OFF cannot complete:
    // nothing verified it, and no reviewer will.
    const reviewVerdict = autoVerdict(policy, "review", handoff.blockers.length > 0 ? "EXTERNAL" : "WRITE");
    if (reviewVerdict === "OFF") {
      if (thin) {
        const reason = `unverified: ${verification.criteria.filter((c) => !c.met).map((c) => c.name).join("; ")} (review is OFF)`;
        deps.board.fail(id, reason);
        deps.trace.record(ref({ ...item, workerId }), "error", reason);
        emit("worker.failed", { workItemId: id, workerId, reason });
        recordBench(id, workerId, ctx, handoff, verification, null);
        return { workItemId: id, state: "FAILED", handoff, verification, note: reason };
      }
      return finishComplete(id, workerId, handoff, verification, null, ctx);
    }
    if (reviewVerdict === "ASK") {
      const approval = deps.approvals.request({
        toolId: "orchestrator.review",
        action: `review work item ${id}`,
        reason: "review policy is ASK: a human clears the review",
        risk: "WRITE",
      });
      deps.board.review(id, "pending-human");
      deps.board.annotate(id, { parked: { approvalId: approval.id, workerId, kind: "review" } });
      deps.trace.record(ref({ ...item, workerId }), "approval", "Review waiting for approval");
      emit("review.requested", { workItemId: id, approvalId: approval.id });
      return { workItemId: id, state: "REVIEW", handoff, verification, parkedApprovalId: approval.id, note: `Review waiting for approval ${approval.id}` };
    }
    // AUTO: independent reviewer, bounded rounds. The reviewer sees ONLY the
    // contract + artifact + evidence — never the worker's transcript.
    deps.board.review(id, "kai-reviewer");
    deps.trace.record(ref({ ...item, workerId }), "review", "Reviewer checking");
    emit("worker.review", { workItemId: id, reviewerId: "kai-reviewer" });
    const loop = await runReviewLoop(
      { runner: deps.reviewRunner, buildPrompt: buildReviewerPrompt },
      {
        contract: {
          objective: item.objective,
          ...(item.deliverable !== undefined ? { deliverable: item.deliverable } : {}),
          criteria: criteria.length > 0 ? criteria : ["deliverable present", "evidence cited"],
        },
        artifact: handoff.result,
        evidence: handoff.evidence,
      },
      2,
    );
    emit("review.decided", { workItemId: id, verdict: loop.verdict, rounds: loop.rounds });
    if (loop.verdict === "PASS") {
      // A PASS compensates thin structural checks: the independent reviewer
      // judged what the checklist could not. Recorded, not hidden.
      const compensated: VerificationRecord = thin
        ? { passed: true, criteria: [...verification.criteria, { name: "independent review passed", met: true }], at: verification.at }
        : verification;
      return finishComplete(id, workerId, handoff, compensated, { verdict: "PASS", findings: loop.findings }, ctx);
    }
    if (loop.verdict === "BLOCKED") {
      deps.board.block(id, `reviewer blocked: ${loop.findings.join("; ").slice(0, 300)}`);
      deps.trace.record(ref({ ...item, workerId }), "error", "Reviewer blocked the deliverable");
      recordBench(id, workerId, ctx, handoff, verification, "BLOCKED");
      return { workItemId: id, state: "BLOCKED", handoff, verification, review: { verdict: "BLOCKED", findings: loop.findings }, note: loop.findings.join("; ").slice(0, 300) };
    }
    // CHANGES_REQUESTED: bounded retry with the findings as the next prompt.
    // The retry is a real dispatch, so it must fit the item's durable ceiling —
    // the SAME ceiling the entry guard enforces. A spent ceiling terminates the
    // loop honestly instead of cycling.
    const retryRefused = retryRefusal(deps.board.get(id) ?? item, policy, workerId);
    if (retryRefused !== null) {
      deps.board.block(id, `review changes unmet: ${retryRefused}`);
      deps.trace.record(ref({ ...item, workerId }), "error", retryRefused);
      recordBench(id, workerId, ctx, handoff, verification, "CHANGES_REQUESTED");
      return {
        workItemId: id,
        state: "BLOCKED",
        handoff,
        verification,
        review: { verdict: "CHANGES_REQUESTED", findings: loop.findings },
        note: `Reviewer requested changes; ${retryRefused}`,
      };
    }
    const changed = deps.board.changesRequested(id, loop.findings);
    if (!changed.ok) {
      return { workItemId: id, state: item.state, handoff, verification, note: changed.reason };
    }
    deps.board.heartbeat(id, "retry", `review round: ${loop.findings.length} finding(s)`);
    deps.trace.record(ref({ ...item, workerId }), "review", `Changes requested (${loop.findings.length} findings) — retrying`);
    recordBench(id, workerId, ctx, handoff, verification, "CHANGES_REQUESTED");
    // The retry is a NEW delegation, not a continuation: it re-passes policy
    // and needs a FRESH approval. Reusing the spent approvalId (or skipping
    // the check) would execute a second action on one human answer.
    const retryGate = await deps.policyCheck({ toolId: "agents.run_task", action: `retry ${workerId} after review`, risk: "EXTERNAL" });
    if (retryGate.outcome === "deny") {
      deps.board.block(id, `policy denied review retry: ${retryGate.reason}`);
      return { workItemId: id, state: "BLOCKED", handoff, verification, note: `Policy denied review retry: ${retryGate.reason}` };
    }
    if (autoVerdict(policy, "retry", "EXTERNAL") === "ASK") {
      const approval = deps.approvals.request({
        toolId: "agents.run_task",
        action: `retry ${workerId} after review`,
        reason: "review retry needs a fresh approval (the prior one is spent)",
        risk: "EXTERNAL",
      });
      deps.board.wait(id, `review retry waiting for approval ${approval.id}`);
      deps.board.annotate(id, { parked: { approvalId: approval.id, workerId, kind: "review-retry" } });
      deps.trace.record(ref({ ...item, workerId }), "approval", `Review retry waiting for approval ${approval.id}`);
      emit("worker.waiting", { workItemId: id, workerId, approvalId: approval.id, reason: "review retry needs a fresh approval" });
      return { workItemId: id, state: "WAITING", handoff, verification, parkedApprovalId: approval.id, note: `Review retry waiting for approval ${approval.id}` };
    }
    // Retry now with the review findings as previous attempts. The dispatch is
    // recorded in the durable ledger BEFORE it runs, so an attempt is consumed
    // exactly once whether it succeeds, fails or throws.
    appendDispatch(id, workerId);
    const retryItem = deps.board.get(id);
    const prompt = buildPrompt(retryItem ?? item, workerId, `retry after review: ${loop.findings.slice(0, 3).join("; ").slice(0, 300)}`, [
      ...item.failures,
      `review: ${loop.findings.slice(0, 3).join("; ").slice(0, 300)}`,
    ]);
    let delegated: DelegateResult;
    try {
      delegated = await deps.delegate({ agentId: workerId, prompt });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      deps.board.fail(id, reason);
      return { workItemId: id, state: "FAILED", handoff, verification, note: reason };
    }
    if (!delegated.ok) {
      const reason = delegated.parkedApprovalId !== undefined
        ? `Waiting for approval ${delegated.parkedApprovalId}`
        : (delegated.error ?? "delegation failed");
      deps.board.fail(id, reason);
      return { workItemId: id, state: "FAILED", handoff, verification, ...(delegated.parkedApprovalId !== undefined ? { parkedApprovalId: delegated.parkedApprovalId } : {}), note: reason };
    }
    return completeFromReply(id, workerId, delegated.reply ?? "", ctx);
  }

  function recordBench(
    id: string,
    workerId: string,
    ctx: CompletionCtx,
    handoff: WorkerHandoff,
    verification: VerificationRecord,
    reviewVerdict: ReviewVerdict | null,
  ): number {
    // Rework is what actually happened: retries spent on this item so far.
    const current = deps.board.get(id);
    const rework = current?.retries ?? 0;
    // Skill quality loop, failure side: a failed verification debits every
    // skill this work used. One place, every path — metrics stay complete.
    if (!verification.passed) {
      for (const skillId of current?.skills ?? []) {
        try {
          deps.learning.recordSkillUsage(skillId, { success: false, failed: true });
        } catch {
          // Metrics never break completion accounting.
        }
      }
    }
    const value = recordBenchOutcome(workerId, ctx, handoff, verification, reviewVerdict, rework);
    if (ctx.patternId !== undefined) {
      try {
        recordPatternOutcome(deps.patterns, ctx.patternId, verification.passed && reviewVerdict !== "BLOCKED");
      } catch {
        // Pattern accounting never breaks completion.
      }
    }
    void id;
    return value;
  }

  function recordBenchOutcome(
    workerId: string,
    ctx: CompletionCtx,
    handoff: WorkerHandoff,
    verification: VerificationRecord,
    reviewVerdict: ReviewVerdict | null,
    rework = 0,
  ): number {
    deps.bench.ensureProfile(workerId, ctx.role, ctx.configVersion);
    const profile = deps.bench.recordOutcome({
      workerId,
      role: ctx.role,
      configVersion: ctx.configVersion,
      domain: ctx.domain,
      quality: reviewVerdict === "PASS" ? 0.9 : verification.passed ? 0.7 : 0.3,
      verification: verification.criteria.filter((c) => c.met).length / Math.max(1, verification.criteria.length),
      completed: handoff.status === "ok" && verification.passed,
      rework,
      corrections: 0,
      ...(ctx.cost?.tokensIn !== undefined ? { tokensIn: ctx.cost.tokensIn } : {}),
      ...(ctx.cost?.tokensOut !== undefined ? { tokensOut: ctx.cost.tokensOut } : {}),
      ...(ctx.cost?.costUsd !== undefined ? { costUsd: ctx.cost.costUsd } : {}),
      latencyMs: ctx.latencyMs,
      safety: 1,
      difficulty: estimateDifficulty({ toolCount: handoff.toolsUsed.length }),
      ...(reviewVerdict !== null
        ? { reviewScore: reviewVerdict === "PASS" ? 1 : reviewVerdict === "CHANGES_REQUESTED" ? 0.4 : 0 }
        : {}),
    });
    emit("benchmark.updated", { workerId, overallValue: profile.overallValue, samples: profile.totalSamples });
    return profile.overallValue;
  }

  /** The mission's Outcome Contract: the caller's persisted fields, or one
   * synthesized from the item — persisted on the item's `outputs` so a resume
   * never forgets it. Every supported requirement rides the item (Phase 5). */
  function outcomeContractFor(item: WorkItem): OutcomeContract {
    const outputs = (item.outputs ?? {}) as { contract?: OutcomeContract };
    if (outputs.contract !== undefined && typeof outputs.contract === "object") return outputs.contract;
    const criteria = item.criteria.length > 0
      ? [...item.criteria]
      : item.deliverable !== undefined
        ? [`deliverable present: ${item.deliverable}`]
        : [];
    const contract = createOutcomeContract({
      missionId: item.missionId ?? item.taskId ?? item.id,
      intent: item.objective,
      ...(item.deliverable !== undefined ? { deliverables: [item.deliverable] } : {}),
      ...(item.constraints.length > 0 ? { constraints: [...item.constraints] } : {}),
      ...(criteria.length > 0 ? { acceptanceCriteria: criteria } : {}),
      ...(item.requiredEvidence.length > 0 ? { requiredEvidence: [...item.requiredEvidence] } : {}),
      ...(item.evidenceLinks !== undefined ? { evidenceLinks: { ...item.evidenceLinks } } : {}),
      ...(item.forbiddenOutcomes.length > 0 ? { forbiddenOutcomes: [...item.forbiddenOutcomes] } : {}),
      ...(item.budget?.maxRetries !== undefined ? { maxRetries: item.budget.maxRetries } : {}),
    });
    deps.board.annotate(item.id, { ...outputs, contract });
    return contract;
  }

  /** Read the persisted outputs object safely (always an object for merging). */
  function readOutputs(item: WorkItem): Record<string, unknown> {
    const outputs = item.outputs as Record<string, unknown> | null | undefined;
    return outputs !== null && typeof outputs === "object" && !Array.isArray(outputs) ? { ...outputs } : {};
  }

  function markResumeKey(id: string, key: string): void {
    const cur = deps.board.get(id);
    if (cur === null) return;
    const outputs = readOutputs(cur);
    const keys = Array.isArray(outputs["resumeKeys"]) ? (outputs["resumeKeys"] as string[]) : [];
    if (!keys.includes(key)) {
      deps.board.annotate(id, { ...outputs, resumeKeys: [...keys.slice(-19), key] });
    }
  }

  /**
   * One worker dispatch against a work item. The LEDGER of these is the
   * authoritative, durable attempt record: it is what makes the per-item retry
   * ceiling enforceable at the boundary, immune to a restart, a duplicate event
   * or a caller that rotates workers.
   *
   * `kind` is derived from the previous entry, so a caller cannot relabel a
   * retry as a "reassignment" to buy extra attempts:
   *   - `initial`  the item's first dispatch;
   *   - `retry`    same worker as the previous dispatch;
   *   - `reassign` a different worker than the previous dispatch.
   */
  interface DispatchRecord {
    workerId: string;
    kind: "initial" | "retry" | "reassign";
    at: string;
  }

  /** The durable dispatch ledger for an item (absent/older rows read as empty). */
  function dispatchLedger(item: WorkItem): DispatchRecord[] {
    const raw = readOutputs(item)["dispatches"];
    if (!Array.isArray(raw)) return [];
    const out: DispatchRecord[] = [];
    for (const entry of raw) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      const workerId = record["workerId"];
      const kind = record["kind"];
      if (typeof workerId !== "string") continue;
      if (kind !== "initial" && kind !== "retry" && kind !== "reassign") continue;
      out.push({ workerId, kind, at: typeof record["at"] === "string" ? record["at"] : nowIso() });
    }
    return out;
  }

  /**
   * Debit the worker's REPORTED usage against the same durable budget.
   *
   * An unreported amount is skipped and named — never debited as zero, which
   * would make an unenforceable limit look satisfied. Each debit is keyed by the
   * report id, so a redelivered result (a retried callback, a duplicate event)
   * takes no second debit. An exhausted ceiling is reported on the item rather
   * than thrown, so the failure is durable and explainable.
   */
  function debitWorkerUsage(
    id: string,
    item: WorkItem,
    workerId: string,
    delegated: DelegateResult,
  ): void {
    const ledger = deps.budgetLedger;
    if (ledger === undefined) return;
    const capability = deps.usageCapability ?? { inputTokens: false, outputTokens: false, toolCalls: false, costUsd: false };
    const report = usageReportFrom({
      workerId,
      itemId: id,
      attempt: dispatchLedger(item).length,
      ...(delegated.cost !== undefined ? { cost: delegated.cost } : {}),
      ...(delegated.latencyMs !== undefined ? { latencyMs: delegated.latencyMs } : {}),
      capability,
    });
    const goal = item.goalId !== undefined ? deps.goalBudgetFor?.(item.goalId, item.goalRevisionId) : undefined;
    const limits: BudgetLimits = {
      ...(goal !== undefined ? { maxTokens: goal.maxTasks * 200_000 } : {}),
      ...(item.budget?.maxToolCalls !== undefined ? { maxToolCalls: item.budget.maxToolCalls } : {}),
      ...(item.budget?.maxCostUsd !== undefined ? { maxCostUsd: item.budget.maxCostUsd } : {}),
    };
    const scope = {
      ...(item.goalId !== undefined ? { goalId: item.goalId } : {}),
      ...(item.goalRevisionId !== undefined ? { planRevisionId: item.goalRevisionId } : {}),
      chainId: deps.board.chainRootOf(id) || id,
    };
    const outcome = debitUsage(ledger, scope, report, limits);
    if (outcome.debited.length > 0 || outcome.skipped.length > 0 || outcome.exhausted !== undefined) {
      emit("worker.usage", {
        workItemId: id,
        workerId,
        reportId: report.reportId,
        inputTokens: report.inputTokens.provenance,
        outputTokens: report.outputTokens.provenance,
        toolCalls: report.toolCalls.provenance,
        costUsd: report.costUsd.provenance,
        debited: outcome.debited.map((d) => `${d.kind}:${d.amount}`),
        notDebited: outcome.skipped.map((s) => `${s.kind}: ${s.reason}`),
        ...(outcome.exhausted !== undefined ? { exhausted: outcome.exhausted.reason } : {}),
      });
    }
    if (outcome.exhausted !== undefined) {
      deps.board.block(id, `usage budget exhausted: ${outcome.exhausted.reason}`);
      recordNextAction(id, "STOP", outcome.exhausted.reason, "blocked");
    }
  }

  /**
   * RESERVE the goal-wide dispatch allowance, before anything is claimed.
   *
   * This is the boundary the per-item retry ledger could not be: that ledger is
   * scoped to ONE item, so a corrective child — or any caller that created a NEW
   * item for the same goal revision — arrived with a fresh allowance. `maxDepth`
   * does not close it either: siblings of one parent are all depth 1.
   *
   * The reservation is taken BEFORE the claim, so a crash mid-dispatch cannot
   * replay the work for free. A genuine duplicate delivery (a resume/approval
   * event id) reuses its idempotency key and takes NO second debit; a fresh call
   * with no event id is a new attempt and DOES debit.
   */
  function reserveDispatch(
    id: string,
    item: WorkItem,
    dedupeKey: string | undefined,
  ): { ok: true; reservationId: string } | { ok: false; reason: string } {
    const ledger = deps.budgetLedger;
    if (ledger === undefined) return { ok: true, reservationId: "" };

    const goal =
      item.goalId !== undefined ? deps.goalBudgetFor?.(item.goalId, item.goalRevisionId) : undefined;
    const limits: BudgetLimits = {};
    if (goal !== undefined) {
      // The approved revision's allowance, rolled up across EVERY item of the
      // revision: each task may spend its initial attempt plus its retries, and
      // that total is the ceiling no caller can raise by adding items.
      limits.maxDispatches = Math.max(1, goal.maxTasks * (1 + goal.maxRetries));
      limits.maxCorrections = Math.max(0, goal.maxTasks * goal.maxRetries);
      limits.maxReplans = Math.max(0, goal.maxDepth);
    }

    const scope = {
      ...(item.goalId !== undefined ? { goalId: item.goalId } : {}),
      ...(item.goalRevisionId !== undefined ? { planRevisionId: item.goalRevisionId } : {}),
      chainId: deps.board.chainRootOf(id) || id,
    };
    const attempt = dispatchLedger(item).length + 1;
    const idempotencyKey =
      dedupeKey !== undefined
        ? `budget:${id}:${dedupeKey}`
        : `budget:${id}:attempt:${attempt}:${budgetNonce()}`;

    const reserved = ledger.reserve({
      scope,
      kind: "dispatch",
      limits,
      idempotencyKey,
      itemId: id,
      detail: `dispatch attempt ${attempt} for ${id}`,
    });
    if (reserved.ok) return { ok: true, reservationId: reserved.reservation.id };
    deps.trace.record(ref(item), "error", reserved.reason);
    return { ok: false, reason: reserved.reason };
  }

  /** The item's effective ceilings, and what its ledger has already consumed. */
  function retryBudget(item: WorkItem, policy: AutonomyPolicy): {
    maxRetries: number;
    maxReassignments: number;
    retries: number;
    reassignments: number;
    total: number;
    maxTotal: number;
  } {
    const maxRetries = Math.max(0, item.budget?.maxRetries ?? policy.budgets.maxRetries ?? policy.maxDepth);
    const maxReassignments = Math.max(
      0,
      item.budget?.maxReassignments ?? policy.budgets.maxReassignments ?? policy.budgets.maxRetries ?? policy.maxDepth,
    );
    const ledger = dispatchLedger(item);
    const retries = ledger.filter((d) => d.kind === "retry").length;
    const reassignments = ledger.filter((d) => d.kind === "reassign").length;
    return {
      maxRetries,
      maxReassignments,
      retries,
      reassignments,
      total: ledger.length,
      maxTotal: 1 + maxRetries + maxReassignments,
    };
  }

  /**
   * The refusal reason when the item has no attempt left for `workerId`, or
   * null when the dispatch is allowed. Enforced BEFORE claim, from durable
   * state, so no caller — API, UI control, supervisor resume — can exceed it.
   */
  function retryRefusal(item: WorkItem, policy: AutonomyPolicy, workerId: string): string | null {
    const b = retryBudget(item, policy);
    if (b.retries >= b.maxRetries && b.reassignments >= b.maxReassignments) {
      return `retry budget exhausted for work item (${b.retries}/${b.maxRetries} retries, ${b.reassignments}/${b.maxReassignments} reassignments) — create a new work item or raise the autonomy budget`;
    }
    const ledger = dispatchLedger(item);
    const last = ledger[ledger.length - 1];
    const isReassign = last !== undefined && last.workerId !== workerId;
    if (isReassign && b.reassignments >= b.maxReassignments) {
      return `reassignment budget exhausted for work item (${b.reassignments}/${b.maxReassignments} reassignments) — create a new work item or raise the autonomy budget`;
    }
    if (!isReassign && b.retries >= b.maxRetries) {
      return `retry budget exhausted for ${workerId} on this work item (${b.retries}/${b.maxRetries} retries) — reassign a different worker or create a new work item`;
    }
    return null;
  }

  /**
   * What attempts remain, from the durable ledger — the honest replacement for
   * the old `item.retries` arithmetic, which no longer governs anything.
   */
  function budgetNote(item: WorkItem, policy: AutonomyPolicy): string {
    const b = retryBudget(item, policy);
    return `retry ${Math.max(0, b.maxRetries - b.retries)}/${b.maxRetries} left, reassignment ${Math.max(0, b.maxReassignments - b.reassignments)}/${b.maxReassignments} left`;
  }

  /**
   * Append one dispatch to the durable ledger and classify it against the
   * previous entry. Called ONLY after a claim succeeds (so a refused claim,
   * a duplicate delivery or an evidence resume never consumes an attempt) and
   * before the review-retry re-delegation.
   */
  function appendDispatch(id: string, workerId: string): DispatchRecord | null {
    const cur = deps.board.get(id);
    if (cur === null) return null;
    const outputs = readOutputs(cur);
    const ledger = dispatchLedger(cur);
    const last = ledger[ledger.length - 1];
    const kind: DispatchRecord["kind"] = last === undefined ? "initial" : last.workerId === workerId ? "retry" : "reassign";
    const record: DispatchRecord = { workerId, kind, at: nowIso() };
    // Bounded by construction: the ceilings cap the ledger's length, so this
    // array can never grow without bound.
    deps.board.annotate(id, { ...outputs, dispatches: [...ledger, record] });
    return record;
  }

  /** Merge observed records into the item (dedupe by evidence id). */
  function mergeEvidence(id: string, records: VerifiedEvidence[]): void {
    if (records.length === 0) return;
    deps.board.recordEvidence(id, records);
    const cur = deps.board.get(id);
    if (cur === null) return;
    const outputs = readOutputs(cur);
    deps.board.annotate(id, {
      ...outputs,
      evidenceRounds: (typeof outputs["evidenceRounds"] === "number" ? outputs["evidenceRounds"] : 0) + 1,
    });
  }

  function currentEvidence(item: WorkItem): VerifiedEvidence[] {
    return [...(item.evidence ?? [])];
  }

  /** Record the supervisor's selected corrective step (durable + emitted). */
  function recordNextAction(
    id: string,
    action: string,
    reason: string,
    state: "proposed" | "queued" | "running" | "done" | "blocked" | "waiting-approval",
    extra?: { workItemId?: string; approvalId?: string },
  ): void {
    const cur = deps.board.get(id);
    if (cur === null) return;
    const outputs = readOutputs(cur);
    const refItem = deps.board.get(id);
    if (refItem !== null) {
      deps.trace.record(
        { taskId: refItem.taskId, workItemId: refItem.id, ...(refItem.workerId !== undefined ? { workerId: refItem.workerId } : {}) },
        "verify",
        `Next: ${action} — ${reason.slice(0, 160)}`,
      );
    }
    deps.board.annotate(id, {
      ...outputs,
      nextAction: { action, reason: reason.slice(0, 500), state, ...(extra ?? {}), at: nowIso() },
    });
    emit("worker.progress", { workItemId: id, phase: "next_action", action, reason, state });
  }

  interface GateEvaluation {
    contract: OutcomeContract;
    observation: Observation;
    gate: import("./outcome.ts").OutcomeGateDecision;
    observed: VerifiedEvidence[];
  }

  /**
   * THE OUTCOME GATE IS THE COMPLETION AUTHORITY — one evaluation helper used
   * by every completion path. Structural verification and review are INPUTS.
   * A worker's claim, a passing test, a PASS review, or "no actions left"
   * never complete a mission — only OutcomeGate = PASS does.
   */
  function evaluateGate(
    doneItem: WorkItem,
    handoff: WorkerHandoff,
    review: { verdict: ReviewVerdict; findings: string[] } | null,
  ): GateEvaluation {
    const contract = outcomeContractFor(doneItem);
    // CLAIM vs OBSERVATION split (Phase 3A): the worker's EVIDENCE:/TESTS:
    // sections ride along LABELED worker-reported for display — they NEVER
    // satisfy a requirement. Only KAI-observed records collected by evidence
    // gathering settle criteria, via exact-label links.
    const observed: VerifiedEvidence[] = currentEvidence(doneItem).filter(
      (record) => record.source === "kai-observed",
    );
    const reported: VerifiedEvidence[] = handoff.evidence.map((text, index) => ({
      id: `ev_${doneItem.id}_worker_${index}`,
      kind: "worker claim",
      source: "worker-reported" as const,
      method: "worker-handoff",
      detail: text.slice(0, 500),
      supports: [],
      at: nowIso(),
    }));
    const compensated = review?.verdict === "PASS";
    const deliverablePresent = handoff.result.trim().length > 0;
    const criteriaMet: Record<string, boolean> = {};
    for (const c of contract.acceptanceCriteria) {
      criteriaMet[c] = criterionMet(contract, c, observed, { compensated, deliverablePresent });
    }
    const observation: Observation = {
      deliverable: handoff.result,
      evidence: [...observed, ...reported],
      criteriaMet,
      ...(handoff.changedArtifacts.length > 0 ? { changedArtifacts: handoff.changedArtifacts } : {}),
      unresolvedBlockers: handoff.blockers,
    };
    return { contract, observation, gate: evaluateOutcome(contract, observation), observed };
  }

  async function finishComplete(
    id: string,
    workerId: string,
    handoff: WorkerHandoff,
    verification: VerificationRecord,
    review: { verdict: ReviewVerdict; findings: string[] } | null,
    ctx: CompletionCtx,
  ): Promise<RunOutcome> {
    const doneItem = deps.board.get(id);
    if (doneItem === null) return { workItemId: id, state: "UNKNOWN", note: `unknown work item "${id}"` };

    const first = evaluateGate(doneItem, handoff, review);
    const gate = first.gate;

    if (gate.result !== "PASS") {
      // NOT complete. Route through the Decision Kernel (advisory) and apply
      // the bounded corrective action; the mission stays active.
      // Deterministic by default; an OPTIONAL provider may only rank among the
      // legal corrective actions, and is re-validated. Never bypasses the Gate.
      const decision = await decideAction(
        {
          gate: gate.result,
          unmetCriteria: gate.unmetCriteria,
          noProgressStreak: doneItem.retries,
          sameFailureStreak: doneItem.failures.length,
          sameWorkerFailures: doneItem.failures.length,
          limits: { maxNoProgress: 3, maxSameFailure: 2, maxWorkerFailures: 3, maxDepth: 3 },
          alternativeWorkerAvailable: deps.board.list({ limit: 200 }).some((w) => w.workerId !== undefined && w.workerId !== workerId),
          depth: deps.board.depthOf(id),
        },
        {
          ...(deps.decisionProvider !== undefined ? { provider: deps.decisionProvider } : {}),
          ...(deps.jevBudget !== undefined ? { budget: deps.jevBudget } : {}),
          candidates: CORRECTIVE_ACTIONS,
          missionId: id,
          onProviderUsed: (e) => emit("decision.provider_used", e),
        },
      );
      // Safe, operational trace — never private reasoning.
      deps.trace.record(ref(doneItem), "verify", `Outcome not met (${gate.result}): ${gate.reason}`);
      emit("worker.progress", { workItemId: id, phase: "evaluation", result: gate.result, reason: gate.reason });
      // Phase 4: the decision EXECUTES (bounded, policy-governed) instead of
      // stalling in CHANGES_REQUESTED. Each branch below either gathers real
      // evidence and re-gates, runs a bounded correction, or parks visibly.
      const acted = await executeCorrective(id, workerId, handoff, verification, review, ctx, decision.action, decision.reason, gate);
      if (acted !== null) return acted;
      // No execution path applied (ASK_USER parks below; anything else here
      // is a hard stop): record and settle honestly.
      recordBench(id, workerId, ctx, handoff, verification, review?.verdict ?? null);
      return {
        workItemId: id,
        state: "FAILED",
        handoff,
        verification,
        ...(review !== null ? { review } : {}),
        note: `Outcome gate ${gate.result} — ${decision.action}: ${decision.reason}`,
      };
    }

    // Gate PASSED: this is the ONLY route to COMPLETED.
    return completeItem(id, workerId, handoff, verification, review, ctx, gate.result);
  }

  /**
   * Execute one corrective round for a gate that did not pass, then re-gate.
   * Returns a RunOutcome when the round settles the item, or null when the
   * caller should fall through to the hard-stop path. Bounded everywhere:
   * evidence rounds capped, children depth-capped, approvals never reused.
   */
  async function executeCorrective(
    id: string,
    workerId: string,
    handoff: WorkerHandoff,
    verification: VerificationRecord,
    review: { verdict: ReviewVerdict; findings: string[] } | null,
    ctx: CompletionCtx,
    action: KernelAction,
    reason: string,
    gate: import("./outcome.ts").OutcomeGateDecision,
  ): Promise<RunOutcome | null> {
    const policy = autonomy();
    const needsEvidence = action === "RUN_TESTS" || action === "VERIFY" || action === "INSPECT";

    if (needsEvidence) {
      // Which labels still need settling: unmet criteria links + missing entries.
      const item = deps.board.get(id);
      if (item === null) return null;
      const contract = outcomeContractFor(item);
      const wanted = new Set<string>();
      for (const c of gate.unmetCriteria) {
        const links = contract.evidenceLinks?.[c] ?? contract.requiredEvidence;
        for (const entry of links) wanted.add(entry);
      }
      for (const entry of gate.missingEvidence) wanted.add(entry);
      const entries = [...wanted].slice(0, 8);
      recordNextAction(id, action, reason, "running");
      const round = await collectEvidenceRound(id, handoff, entries, ctx.approvalId);
      if (round.parked !== undefined) {
        // Policy wants a human for the shell checks: durable park with
        // linkage; onApprovalDecided resumes exactly here, even restarted.
        deps.board.wait(id, `evidence gathering parked for approval ${round.parked.approvalId}`);
        const cur = deps.board.get(id);
        if (cur !== null) {
          const outputs = readOutputs(cur);
          deps.board.annotate(id, {
            ...outputs,
            parked: { approvalId: round.parked.approvalId, workerId, kind: "evidence" },
            pendingEvidence: { labels: round.parked.labels, requestedAt: nowIso() },
          });
        }
        deps.trace.record(ref(item), "approval", `Evidence checks waiting for approval ${round.parked.approvalId}`);
        emit("worker.waiting", { workItemId: id, workerId, approvalId: round.parked.approvalId, reason: "evidence checks need approval" });
        recordNextAction(id, action, reason, "waiting-approval", { approvalId: round.parked.approvalId });
        return { workItemId: id, state: "WAITING", handoff, verification, ...(review !== null ? { review } : {}), parkedApprovalId: round.parked.approvalId, note: `Evidence gathering parked for approval ${round.parked.approvalId}` };
      }
      // Re-gate with what KAI itself just established.
      const re = evaluateGate(deps.board.get(id) ?? item, handoff, review);
      if (re.gate.result === "PASS") {
        recordNextAction(id, action, reason, "done");
        return completeItem(id, workerId, handoff, verification, review, ctx, re.gate.result);
      }
      deps.board.changesRequested(id, [`${re.gate.result}: ${re.gate.reason}`, `next: ${action} (evidence round complete)`]);
      recordNextAction(id, action, reason, re.gate.result === "FAIL" ? "blocked" : "done");
      recordBench(id, workerId, ctx, handoff, verification, review?.verdict ?? null);
      return {
        workItemId: id,
        state: "CHANGES_REQUESTED",
        handoff,
        verification,
        ...(review !== null ? { review } : {}),
        note: `Outcome gate ${re.gate.result} after evidence round — ${action}: ${reason}`,
      };
    }

    if (action === "ASK_USER") {
      // Park visibly with the specific missing decision — never a dead DRAFT,
      // never silent execution of something unauthorized.
      const question = gate.unmetCriteria.length > 0
        ? `Decision needed for: ${gate.unmetCriteria.slice(0, 3).join("; ")} — ${reason}`
        : `Decision needed: ${reason}`;
      deps.board.wait(id, question);
      deps.trace.record(ref(doneItemRef(id)), "approval", `Waiting on user: ${question.slice(0, 160)}`);
      emit("worker.waiting", { workItemId: id, workerId, reason: question });
      recordNextAction(id, action, reason, "blocked");
      return {
        workItemId: id,
        state: "WAITING",
        handoff,
        verification,
        ...(review !== null ? { review } : {}),
        note: question,
      };
    }

    if (action === "RETRY" || action === "REPLAN" || action === "CHANGE_WORKER") {
      return runCorrectiveChild(id, workerId, handoff, verification, review, ctx, action, reason, gate);
    }

    return null;
  }

  function doneItemRef(id: string): WorkItem {
    return deps.board.get(id) ?? ({ id } as WorkItem);
  }

  /**
   * One bounded evidence round: cap, collect, merge. Returns what parked (if
   * policy demanded approval) — the caller durably parks and resumes.
   */
  async function collectEvidenceRound(
    id: string,
    handoff: WorkerHandoff,
    entries: string[],
    approvalId?: string,
  ): Promise<{ parked?: { approvalId: string; labels: string[] } }> {
    const item = deps.board.get(id);
    if (item === null) return {};
    const outputs = readOutputs(item);
    const rounds = typeof outputs["evidenceRounds"] === "number" ? outputs["evidenceRounds"] : 0;
    if (rounds >= 3) {
      deps.trace.record(ref(item), "verify", "Evidence budget spent (3 rounds) — parking for a human");
      return {};
    }
    if (entries.length === 0) return {};
    const gathered = await gatherEvidence(item, handoff, entries, { ...(approvalId !== undefined ? { approvalId } : {}) });
    mergeEvidence(id, gathered.observed);
    for (const blocked of gathered.blocked) {
      deps.trace.record(ref(item), "verify", `Evidence unsupported for "${blocked.label.slice(0, 80)}": ${blocked.reason.slice(0, 160)}`);
    }
    if (gathered.pending.length > 0) {
      // ONE approval covers the batch: request it here (orchestrator.verify
      // toolId keeps the linkage attributable), park, resume on verdict.
      const first = gathered.pending[0]!;
      const approval = deps.approvals.request({
        toolId: "orchestrator.verify",
        action: `run evidence checks for work item ${id}`,
        reason: `Evidence requires guarded execution: ${first.label.slice(0, 120)}${gathered.pending.length > 1 ? ` (+${gathered.pending.length - 1} more)` : ""}`,
        risk: "DESTRUCTIVE",
      });
      emit("approval.requested", { approvalId: approval.id, workItemId: id, reason: "evidence checks need approval" });
      return { parked: { approvalId: approval.id, labels: gathered.pending.map((p) => p.label) } };
    }
    return {};
  }

  /**
   * Bounded corrective delegation: a CHILD work item carries the correction
   * (never a blind re-run of the parent), executed through the SAME
   * policy/approval path as any delegation, depth-capped. After it settles,
   * the parent re-gathers (the workspace changed) and re-gates.
   */
  async function runCorrectiveChild(
    id: string,
    workerId: string,
    handoff: WorkerHandoff,
    verification: VerificationRecord,
    review: { verdict: ReviewVerdict; findings: string[] } | null,
    ctx: CompletionCtx,
    action: KernelAction,
    reason: string,
    gate: import("./outcome.ts").OutcomeGateDecision,
    depth?: number,
  ): Promise<RunOutcome> {
    const policy = autonomy();
    const item = deps.board.get(id);
    const itemDepth = depth ?? (item !== null ? deps.board.depthOf(id) : 0);
    const maxDepth = policy.maxDepth;
    if (item === null || itemDepth >= maxDepth) {
      const why = item === null ? "parent gone" : `delegation depth ${itemDepth} reached the ceiling (${maxDepth})`;
      deps.trace.record(ref(doneItemRef(id)), "verify", `Correction bounded: ${why} — parking for a human`);
      emit("worker.progress", { workItemId: id, phase: "next_action", action: "ASK_USER", reason: why });
      deps.board.wait(id, `Correction bounded (${why}). ${reason}`);
      recordNextAction(id, action, reason, "blocked");
      return {
        workItemId: id, state: "WAITING", handoff, verification,
        ...(review !== null ? { review } : {}),
        note: `Correction bounded (${why}). ${reason}`,
      };
    }
    // Worker choice: CHANGE_WORKER picks a different worker that has run on
    // this board; RETRY/REPLAN keep the worker but change the instructions.
    let childWorker = workerId;
    if (action === "CHANGE_WORKER") {
      const alternative = deps.board.list({ limit: 200 })
        .map((w) => w.workerId)
        .find((candidate) => candidate !== undefined && candidate !== workerId);
      if (alternative === undefined) {
        deps.board.wait(id, `No alternative worker for CHANGE_WORKER. ${reason}`);
        recordNextAction(id, action, reason, "blocked");
        return {
          workItemId: id, state: "WAITING", handoff, verification,
          ...(review !== null ? { review } : {}),
          note: `No alternative worker for CHANGE_WORKER. ${reason}`,
        };
      }
      childWorker = alternative;
    }
    const findings = [...gate.unmetCriteria, ...gate.missingEvidence].slice(0, 5);
    const childObjective = action === "REPLAN"
      ? `Replan and correct: ${item.objective}`
      : `Correct and re-verify: ${item.objective}`;
    const child = deps.board.createChild(
      id,
      {
        objective: childObjective,
        ...(item.deliverable !== undefined ? { deliverable: item.deliverable } : {}),
        ...(item.missionId !== undefined ? { missionId: item.missionId } : {}),
        criteria: [...item.criteria],
        constraints: [...item.constraints, "Address ONLY the findings below; do not redo unrelated work."],
        forbiddenOutcomes: [...item.forbiddenOutcomes],
        requiredEvidence: [...item.requiredEvidence],
        ...(item.budget !== undefined ? { budget: item.budget } : {}),
        ...(item.workingDir !== undefined ? { workingDir: item.workingDir } : {}),
        skills: [...item.skills],
      },
      { maxDepth: policy.maxDepth, maxChildren: policy.maxParallel },
    );
    if (!child.ok) {
      deps.board.wait(id, `Correction refused: ${child.reason}. ${reason}`);
      recordNextAction(id, action, reason, "blocked");
      return {
        workItemId: id, state: "WAITING", handoff, verification,
        ...(review !== null ? { review } : {}),
        note: `Correction refused: ${child.reason}. ${reason}`,
      };
    }
    recordNextAction(id, action, reason, "running", { workItemId: child.value.id });
    deps.trace.record(ref(item), "worker", `${action}: delegated correction to ${childWorker} as ${child.value.id}`);
    const childOutcome = await runWorkItem(child.value.id, {
      workerId: childWorker,
      role: ctx.role,
      configVersion: ctx.configVersion,
      depth: itemDepth + 1,
    });
    // The workspace changed (or pointedly did not): re-gather and re-gate.
    const parent = deps.board.get(id);
    if (parent === null) return childOutcome;
    const contract = outcomeContractFor(parent);
    const wanted = new Set<string>();
    for (const c of gate.unmetCriteria) {
      for (const entry of contract.evidenceLinks?.[c] ?? contract.requiredEvidence) wanted.add(entry);
    }
    for (const entry of gate.missingEvidence) wanted.add(entry);
    const round = await collectEvidenceRound(id, handoff, [...wanted].slice(0, 8), ctx.approvalId);
    if (round.parked !== undefined) {
      deps.board.wait(id, `evidence gathering parked for approval ${round.parked.approvalId}`);
      const cur = deps.board.get(id);
      if (cur !== null) {
        const outputs = readOutputs(cur);
        deps.board.annotate(id, {
          ...outputs,
          parked: { approvalId: round.parked.approvalId, workerId, kind: "evidence" },
          pendingEvidence: { labels: round.parked.labels, requestedAt: nowIso() },
        });
      }
      emit("worker.waiting", { workItemId: id, workerId, approvalId: round.parked.approvalId, reason: "evidence checks need approval" });
      recordNextAction(id, action, reason, "waiting-approval", { approvalId: round.parked.approvalId });
      return {
        workItemId: id, state: "WAITING", handoff, verification,
        ...(review !== null ? { review } : {}),
        parkedApprovalId: round.parked.approvalId,
        note: `Evidence gathering parked for approval ${round.parked.approvalId}`,
      };
    }
    const re = evaluateGate(deps.board.get(id) ?? parent, handoff, review);
    if (re.gate.result === "PASS") {
      recordNextAction(id, action, reason, "done", { workItemId: child.value.id });
      return completeItem(id, workerId, handoff, verification, review, ctx, re.gate.result);
    }
    deps.board.changesRequested(id, [`${re.gate.result}: ${re.gate.reason}`, `correction ${child.value.id} settled ${childOutcome.state}`]);
    recordNextAction(id, action, reason, "done", { workItemId: child.value.id });
    recordBench(id, workerId, ctx, handoff, verification, review?.verdict ?? null);
    return {
      workItemId: id,
      state: "CHANGES_REQUESTED",
      handoff,
      verification,
      ...(review !== null ? { review } : {}),
      note: `Correction ${child.value.id} settled ${childOutcome.state}; gate ${re.gate.result}: ${re.gate.reason}`,
    };
  }

  /**
   * The ONLY route to COMPLETED (extracted so re-gated passes share it).
   * Gate PASS was decided by the caller — this persists it.
   */
  async function completeItem(
    id: string,
    workerId: string,
    handoff: WorkerHandoff,
    verification: VerificationRecord,
    review: { verdict: ReviewVerdict; findings: string[] } | null,
    ctx: CompletionCtx,
    gateResult: string,
  ): Promise<RunOutcome> {
    const doneItem = deps.board.get(id);
    // Skill success metrics + supervision lesson (Phase 6/10): only on the
    // verified path, with the gate verdict as the verified basis.
    if (doneItem !== null) {
      for (const skillId of doneItem.skills) {
        try {
          deps.learning.recordSkillUsage(skillId, { success: true, ...(verification.passed ? { verified: true } : {}) });
        } catch {
          // Metrics never break completion.
        }
      }
      recordCompletionLesson(doneItem, handoff, gateResult);
    }
    const completed = deps.board.complete(id, handoff, {
      verification,
      ...(review !== null
        ? { review: { reviewerId: "kai-reviewer", criteria: [], verdict: review.verdict, findings: review.findings, at: new Date().toISOString() } }
        : {}),
    });
    if (!completed.ok) {
      return { workItemId: id, state: "FAILED", handoff, verification, note: completed.reason };
    }
    const valueScore = recordBench(id, workerId, ctx, handoff, verification, review?.verdict ?? null);
    const item = deps.board.get(id);
    deps.trace.record(ref({ ...(item ?? ({ id } as WorkItem)), workerId }), "done", "Outcome gate PASS");
    emit("worker.completed", { workItemId: id, workerId, valueScore, gate: gateResult });
    return {
      workItemId: id,
      state: "COMPLETED",
      handoff,
      verification,
      ...(review !== null ? { review } : {}),
      valueScore,
      note: "Outcome gate PASS — completed and verified.",
    };
  }

  /** True when a WAITING/REVIEW work item parked on this approval. */
  function ownsApproval(approvalId: string): boolean {
    for (const item of deps.board.list({ limit: 500 })) {
      if (item.state !== "WAITING" && item.state !== "REVIEW") continue;
      const outputs = (item.outputs ?? {}) as { parked?: { approvalId?: string } };
      if (outputs.parked?.approvalId === approvalId) return true;
    }
    return false;
  }

  /** Resume WAITING/REVIEW work after an approval verdict. Restart-safe: the
   * approval id is matched against persisted items, not memory. */
  async function onApprovalDecided(approvalId: string, approved: boolean): Promise<{ handled: number }> {
    const items = deps.board.list({ limit: 500 });
    let handled = 0;
    for (const item of items) {
      if (item.state !== "WAITING" && item.state !== "REVIEW") continue;
      const outputs = (item.outputs ?? {}) as { parked?: { approvalId?: string } };
      if (outputs.parked?.approvalId !== approvalId) continue;
      handled += 1;
      if (!approved) {
        deps.board.cancel(id(item), `approval ${approvalId} rejected`);
        deps.trace.record(mkRef(item), "error", "Approval rejected — work cancelled");
        emit("worker.cancelled", { workItemId: item.id });
        continue;
      }
      await runWorkItem(item.id, {
        ...(item.workerId !== undefined ? { workerId: item.workerId } : {}),
        approvalId,
      });
    }
    return { handled };
    function id(item: WorkItem): string {
      return item.id;
    }
    function mkRef(item: WorkItem): TraceRef {
      return {
        ...(item.taskId !== undefined ? { taskId: item.taskId } : {}),
        workItemId: item.id,
        ...(item.workerId !== undefined ? { workerId: item.workerId } : {}),
      };
    }
  }

  /** Standalone review of an item's current handoff (the /review command). */
  async function reviewItem(
    id: string,
    criteria?: string[],
  ): Promise<{ verdict: ReviewVerdict; findings: string[]; prompt: string; rounds: number } | { error: string }> {
    const item = deps.board.get(id);
    if (item === null) return { error: `unknown work item "${id}"` };
    if (item.handoff === undefined) return { error: `work item "${id}" has no handoff to review` };
    const input = {
      contract: {
        objective: item.objective,
        ...(item.deliverable !== undefined ? { deliverable: item.deliverable } : {}),
        criteria: criteria ?? (item.deliverable !== undefined ? [item.deliverable] : ["deliverable present", "evidence cited"]),
      },
      artifact: item.handoff.result,
      evidence: item.handoff.evidence,
    };
    const deps_ = { runner: deps.reviewRunner, buildPrompt: buildReviewerPrompt };
    const first = await requestReview(deps_, input);
    if (first.verdict !== "CHANGES_REQUESTED") {
      return { verdict: first.verdict, findings: first.findings, prompt: first.prompt, rounds: 1 };
    }
    const second = await requestReview(deps_, input);
    return { verdict: second.verdict, findings: second.findings, prompt: second.prompt, rounds: 2 };
  }

  /** Bench profiles with evidence, for the Worker Bench panel. */
  function benchList(): ReturnType<Benchmark["withEvidence"]>[] {
    return deps.bench.listProfiles().map((p) => deps.bench.withEvidence(p.workerId)).filter((e) => e !== null);
  }

  /** Bounded activity for a task or work item, at a visibility level. */
  function activityList(
    ref: { taskId?: string; workItemId?: string },
    level?: "OFF" | "COMPACT" | "VERBOSE",
  ): { seq: number; kind: string; label: string; detail?: string; at: string }[] {
    return deps.trace.list(ref, level).map((e) => ({
      seq: e.seq,
      kind: e.kind,
      label: e.label,
      ...(e.detail !== undefined ? { detail: e.detail } : {}),
      at: e.at,
    }));
  }

  /** Record a heartbeat from outside (external workers, future use). */
  function heartbeat(id: string, step?: string, note?: string): { ok: boolean; reason?: string } {
    const result = deps.board.heartbeat(id, step, note);
    return result.ok ? { ok: true } : { ok: false, reason: result.reason };
  }

  /** Full detail for the inspector: item + children + activity + benchmark. */
  function inspect(id: string): {
    item: WorkItem | null;
    children: WorkItem[];
    activity: { seq: number; kind: string; label: string; detail?: string; at: string }[];
    benchmark: ReturnType<Benchmark["withEvidence"]>;
  } {
    const item = deps.board.get(id);
    if (item === null) return { item, children: [], activity: [], benchmark: null };
    const children = deps.board.children(id);
    const activity = deps.trace.list({ workItemId: id }, "VERBOSE").map((e) => ({
      seq: e.seq,
      kind: e.kind,
      label: e.label,
      ...(e.detail !== undefined ? { detail: e.detail } : {}),
      at: e.at,
    }));
    const benchmark = item.workerId !== undefined ? deps.bench.withEvidence(item.workerId) : null;
    return { item, children, activity, benchmark };
  }

  /** Propose + submit passthroughs for the /refine command (staging gates install). */
  function proposeTaskSkill(input: ProposeInput): SkillCandidate | null {
    return deps.learning.proposeFromTask(input);
  }

  function submitSkillProposal(candidate: SkillCandidate, markdown: string): SubmitResult {
    return deps.learning.submitProposal(candidate, markdown);
  }

  /**
   * Ingest an EXTERNAL worker report (Case B): the user pasted output from a
   * worker KAI did not dispatch. The report is parsed into claims (labeled
   * worker-reported), attached to the real project context when one can be
   * resolved, audited against the actual workspace (file state, runnable
   * checks), gated, and turned into a ready-to-copy correction prompt.
   *
   * Nothing is auto-executed here except through startObjective when autonomy
   * permits (AUTO, level ≥ 2) — otherwise the audit returns waiting with the
   * exact reason. An offline worker never produces a completion event; this
   * path is the honest substitute, and it says which worker it audited.
   */
  async function auditExternalReport(input: ExternalAuditInput): Promise<ExternalAuditResult> {
    const policy = autonomy();
    const report = (input.reportText ?? "").trim();
    if (report.length === 0) {
      return {
        workItemId: "", claims: [], observed: [], unmetCriteria: [], missingEvidence: [],
        blockers: ["empty report: nothing to audit"], reviewNotes: [], nextPrompt: "",
        launched: { started: false, reason: "empty report: nothing to audit" },
      };
    }
    // STRUCTURE CHECK. `handoffFromText` is deliberately lenient — it treats any
    // text as a RESULT and defaults a missing STATUS to "ok" — which is fine for
    // a worker reply (the gate still demands real evidence) but wrong for an
    // audit: auditing a document that is not a worker report invents a status it
    // never asserted and creates a durable item out of nothing. A report must
    // declare at least one real section before anything is audited.
    const REPORT_SECTIONS = /^\s*(STATUS|RESULT|CHANGED ARTIFACTS|EVIDENCE|TESTS|BLOCKERS|RISKS|FOLLOW-UPS|RECOMMENDED NEXT STEP|TOOLS USED)\s*:/im;
    if (!REPORT_SECTIONS.test(report)) {
      const reason = "unrecognized report: no worker-report section (STATUS, RESULT, EVIDENCE, TESTS, CHANGED ARTIFACTS, BLOCKERS, …) was found — nothing was audited";
      return {
        workItemId: "", claims: [], observed: [], unmetCriteria: [], missingEvidence: [],
        blockers: [reason], reviewNotes: [], nextPrompt: "",
        launched: { started: false, reason },
      };
    }
    const handoff = handoffFromText(report);
    const objective = (input.objective ?? "").trim().length > 0
      ? (input.objective as string).trim()
      : handoff.result.split("\n")[0]?.slice(0, 200) || "external worker report";
    // Proposed checks grounded in the REPORT (not invented): one entry per
    // claimed artifact, plus runnable test commands from the TESTS section.
    const proposed: string[] = [];
    for (const artifact of handoff.changedArtifacts.slice(0, 10)) {
      proposed.push(`file present: ${artifact}`);
    }
    if (handoff.tests !== undefined) {
      for (const line of handoff.tests.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0).slice(0, 5)) {
        proposed.push(testCommandFor(line) !== null ? line : `verify: ${line.slice(0, 160)}`);
      }
    }
    const created = deps.board.create({
      objective,
      deliverable: objective,
      ...(input.missionId !== undefined ? { missionId: input.missionId } : {}),
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      ...(input.workingDir !== undefined ? { workingDir: input.workingDir } : {}),
      requiredEvidence: proposed,
    });
    if (!created.ok) {
      return {
        workItemId: "", claims: [], observed: [], unmetCriteria: [], missingEvidence: [],
        blockers: [`audit work item refused: ${created.reason}`], reviewNotes: [], nextPrompt: "",
        launched: { started: false, reason: `audit work item refused: ${created.reason}` },
      };
    }
    const item = created.value;
    deps.board.annotate(item.id, {
      source: "external-report",
      ...(input.workerId !== undefined ? { externalWorkerId: input.workerId } : {}),
      reportedAt: nowIso(),
    });
    deps.trace.record(ref(item), "plan", `External report ingested (${handoff.status}) — auditing, not trusting`);
    emit("worker.progress", { workItemId: item.id, phase: "audit", result: "report-ingested" });
    const fresh = deps.board.get(item.id) ?? item;
    // Auto-select skills for the correction prompt (same path as planned work).
    let skillIds: string[] = [];
    try {
      // No domain is known here, but the runtime still applies platform and
      // tool applicability, which is what stops an inapplicable skill being offered.
      skillIds = deps.skills.relevant(objective, 3, {}).map((s) => s.id).slice(0, 3);
    } catch {
      skillIds = [];
    }
    // NO WORKSPACE, NO CHECKS. Without a working directory the claimed paths
    // would resolve against KAI's OWN sandbox — evidence about the wrong tree,
    // which is worse than none. Every requirement is recorded as unverifiable
    // and the limitation says exactly that; nothing is claimed as checked.
    const gathered = input.workingDir === undefined
      ? {
        observed: [],
        pending: [],
        blocked: proposed.slice(0, 8).map((label) => ({
          label,
          reason: "no working directory was supplied, so the report's workspace cannot be inspected",
        })),
      }
      : await gatherEvidence(fresh, handoff, proposed.slice(0, 8));
    mergeEvidence(item.id, gathered.observed);
    const withEvidence = deps.board.get(item.id) ?? fresh;
    const evaluation = evaluateGate(withEvidence, handoff, null);
    const gate = evaluation.gate;
    // Independent review when policy runs reviewers (bounded, one round).
    const reviewNotes: string[] = [];
    if (autoVerdict(policy, "review") === "AUTO") {
      try {
        const loop = await runReviewLoop(
          { runner: deps.reviewRunner, buildPrompt: buildReviewerPrompt },
          {
            contract: {
              objective,
              deliverable: objective,
              criteria: evaluation.contract.acceptanceCriteria.slice(0, 5),
            },
            artifact: handoff.result.slice(0, 4000),
            evidence: handoff.evidence.slice(0, 10),
          },
          1,
        );
        emit("review.decided", { workItemId: item.id, verdict: loop.verdict, rounds: loop.rounds });
        for (const finding of loop.findings.slice(0, 8)) reviewNotes.push(finding);
      } catch {
        reviewNotes.push("reviewer unavailable — findings rest on KAI-observed evidence only");
      }
    } else {
      reviewNotes.push("review skipped by autonomy policy (ASK/OFF) — findings rest on KAI-observed evidence only");
    }
    // Only claim a status the document ACTUALLY asserted. `handoffFromText`
    // defaults a missing STATUS line to "ok", which is a lenient default for a
    // worker reply but a fabrication when presented as an audit claim.
    const declaredStatus = /^\s*STATUS\s*:/im.test(report);
    const claims = [
      ...(declaredStatus ? [`worker status: ${handoff.status}`] : []),
      `result: ${handoff.result.slice(0, 300)}`,
      ...handoff.evidence.slice(0, 5).map((e) => `claimed evidence: ${e.slice(0, 160)}`),
      ...(handoff.tests !== undefined ? [`claimed tests: ${handoff.tests.slice(0, 200)}`] : []),
      ...handoff.blockers.slice(0, 3).map((b) => `claimed blocker: ${b.slice(0, 160)}`),
    ];
    // Surface the REASON a requirement could not be checked, not just its label:
    // a refused check (out-of-sandbox path, policy) must be visible as a refusal.
    const limitation = gathered.blocked.length > 0 || input.workingDir === undefined
      ? `Workspace ${input.workingDir === undefined ? "not provided — file claims unverified" : "checked"}; ${gathered.blocked.length} requirement(s) could not be checked: ${gathered.blocked.slice(0, 3).map((b) => `${b.label.slice(0, 80)} (${b.reason.slice(0, 200)})`).join("; ") || "none"}. Unverified is reported, never passed.`
      : undefined;
    // The correction prompt: exact issues, exact files, exact commands.
    const remaining = [
      ...gate.unmetCriteria.map((c) => `unmet: ${c}`),
      ...gate.missingEvidence.map((e) => `missing evidence: ${e}`),
      ...reviewNotes.slice(0, 5).map((f) => `reviewer: ${f}`),
      ...gathered.blocked.slice(0, 3).map((b) => `unverifiable: ${b.label} (${b.reason})`),
    ];
    const observedState = evaluation.observed.map(
      (record) => `${record.kind}: ${record.detail.slice(0, 200)}${record.supports.length > 0 ? ` [settles: ${record.supports.join(", ").slice(0, 120)}]` : " [does not settle its requirement]"}`,
    );
    const nextPrompt = buildWorkerPrompt({
      mission: withEvidence.missionId ?? withEvidence.taskId ?? "external correction",
      role: input.workerId ?? "worker",
      whySelected: `correction after independent audit of an external report (gate: ${gate.result})`,
      objective: `Correct and complete: ${objective}`,
      context: [`Original worker report (UNTRUSTED claims): ${report.slice(0, 1500)}`],
      knownState: observedState.length > 0 ? observedState.slice(0, 10) : ["no independent observations yet — inspect first, then change"],
      previousAttempts: remaining.length > 0 ? remaining.slice(0, 10) : ["none recorded"],
      constraints: [
        "Fix ONLY the listed issues; do not redo unrelated work.",
        "Return the HANDOFF FORMAT exactly.",
        // The contract's forbidden outcomes must reach the worker, not only the
        // post-hoc Gate: a worker that never saw the prohibition cannot be said
        // to have been told.
        ...evaluation.contract.forbiddenOutcomes.map((f) => `forbidden: ${f}`),
      ],
      scope: withEvidence.workingDir !== undefined ? `repository: ${withEvidence.workingDir}` : "as instructed",
      requiredOutput: objective,
      successCriteria: evaluation.contract.acceptanceCriteria.slice(0, 8),
      verification: [
        ...evaluation.contract.requiredEvidence.slice(0, 8).map((e) => `evidence required: ${e}`),
        "cite evidence",
        "name blockers plainly",
      ],
      budget: "one correction round",
      handoffFormat: HANDOFF_FORMAT,
      ...(skillIds.length > 0
        ? {
          skillContext: skillIds.map((sid) => {
            try {
              const loaded = deps.skills.load(sid);
              return loaded.ok && loaded.body !== undefined ? `## ${sid}\n${loaded.body.slice(0, 1500)}` : null;
            } catch {
              return null;
            }
          }).filter((s): s is string => s !== null).join("\n\n").slice(0, 3000) || undefined,
        }
        : {}),
    });
    const auditPrompt = nextPrompt.slice(0, 8000);
    const cur = deps.board.get(item.id);
    if (cur !== null) {
      const outputs = readOutputs(cur);
      deps.board.annotate(item.id, {
        ...outputs,
        audit: {
          claims: claims.length,
          observed: gathered.observed.length,
          unmet: gate.unmetCriteria,
          missing: gate.missingEvidence,
          gate: gate.result,
          at: nowIso(),
        },
        auditPrompt,
      });
    }
    deps.trace.record(ref(withEvidence), "verify", `External audit: gate ${gate.result} — ${gate.reason.slice(0, 160)}`);
    emit("worker.progress", { workItemId: item.id, phase: "evaluation", result: gate.result, reason: gate.reason });
    // Launch ONLY when autonomy permits autonomous delegation. Anything else
    // returns the prompt for the user to run — never forced execution.
    if (remaining.length > 0 && policy.level >= 2 && policy.workerAuto === "AUTO") {
      const started = startObjective(
        {
          objective: `Correct and complete: ${objective}`,
          deliverable: objective,
          constraints: ["Fix ONLY the listed issues; do not redo unrelated work."],
          successCriteria: evaluation.contract.acceptanceCriteria.slice(0, 8),
          requiredEvidence: evaluation.contract.requiredEvidence.slice(0, 8),
          ...(withEvidence.missionId !== undefined ? { missionId: withEvidence.missionId } : {}),
          ...(withEvidence.workingDir !== undefined ? { workingDir: withEvidence.workingDir } : {}),
          skills: skillIds,
        },
        [],
      );
      if (started.workItemId.length > 0) {
        void runWorkItem(started.workItemId).catch(() => undefined);
        return {
          workItemId: item.id, claims, observed: gathered.observed,
          unmetCriteria: gate.unmetCriteria, missingEvidence: gate.missingEvidence,
          blockers: handoff.blockers, reviewNotes,
          ...(limitation !== undefined ? { limitation } : {}),
          nextPrompt,
          launched: { started: true, workItemId: started.workItemId, reason: "autonomy permits autonomous correction — launched" },
        };
      }
    }
    return {
      workItemId: item.id, claims, observed: gathered.observed,
      unmetCriteria: gate.unmetCriteria, missingEvidence: gate.missingEvidence,
      blockers: handoff.blockers, reviewNotes,
      ...(limitation !== undefined ? { limitation } : {}),
      nextPrompt,
      launched: {
        started: false,
        reason: remaining.length === 0
          ? "nothing remaining: the report already satisfies every checkable requirement"
          : `waiting: autonomy ${policy.workerAuto}/level ${policy.level} does not authorize auto-execution — run the prompt or approve`,
      },
    };
  }

  /** Propose a reusable skill from a notable work item (no silent mutation). */
  function proposeSkill(workItemId: string): ReturnType<SkillLearning["proposeFromTask"]> {
    const item = deps.board.get(workItemId);
    if (item === null) return null;
    const steps = [
      ...item.failures.map((f) => ({ label: f, status: "failed" as const })),
      { label: item.objective, status: (item.state === "COMPLETED" ? "completed" : "open") as "completed" | "open" },
    ];
    return deps.learning.proposeFromTask({
      taskId: workItemId,
      objective: item.objective,
      steps,
      outcome: {
        success: item.state === "COMPLETED",
        verified: item.verification !== undefined,
        corrections: [],
        ...(item.state === "COMPLETED" && item.failures.length > 0 ? { recovered: true } : {}),
      },
      existingSkillIds: item.skills,
    });
  }

  return { plan: planObjective, startObjective, nextMove, runWorkItem, reviewItem, inspect, benchList, activityList, heartbeat, proposeSkill, proposeTaskSkill, submitSkillProposal, ownsApproval, onApprovalDecided, handoffFromText, verifyHandoff, auditExternalReport };
}

export type Orchestrator = ReturnType<typeof createOrchestrator>;
