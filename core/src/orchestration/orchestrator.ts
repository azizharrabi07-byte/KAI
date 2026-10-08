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

import type { PolicyRequest } from "../policies/gate.ts";
import type {
  AutonomyPolicy,
  ReviewVerdict,
  RoutingDecision,
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
import { buildWorkerPrompt, recordPatternOutcome, selectPattern } from "./prompts.ts";
import type { PromptPatternStore } from "../shared/contracts.ts";
import { buildReviewerPrompt, requestReview, runReviewLoop } from "./review.ts";
import { autoVerdict } from "./autonomy.ts";
import { estimateDifficulty } from "./bench.ts";
import {
  createOutcomeContract,
  evaluateOutcome,
  type KernelAction,
  type Observation,
  type OutcomeContract,
} from "./outcome.ts";
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
  relevant(query: string, limit: number): { id: string }[];
  load(id: string): { ok: boolean; name?: string; body?: string; reason?: string };
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
  publish(type: string, payload: unknown, opts?: { source?: string }): void;
  now?(): string;
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
  constraints?: string[];
  forbidden?: string[];
  successCriteria?: string[];
  risk?: string;
  budget?: WorkBudget;
  taskId?: string;
  missionId?: string;
  subtasks?: string[];
  skills?: string[];
}

export interface StartOutcome {
  workItemId: string;
  childIds: string[];
  decision: RoutingDecision;
  delegated: boolean;
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

export interface RunOpts {
  workerId?: string;
  approvalId?: string;
  candidates?: string[];
  role?: string;
  configVersion?: string;
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

/** Structural verification: deliverable present, evidence cited, criteria met. */
export function verifyHandoff(handoff: WorkerHandoff, criteria: string[]): VerificationRecord {
  const checks: { name: string; met: boolean; detail?: string }[] = [
    { name: "deliverable present", met: handoff.result.trim().length > 0 },
    { name: "evidence cited", met: handoff.evidence.length > 0, detail: `${handoff.evidence.length} item(s)` },
    {
      name: "no unresolved blockers",
      met: handoff.blockers.length === 0,
      detail: handoff.blockers.join("; ").slice(0, 200) || undefined,
    },
  ];
  for (const criterion of criteria) {
    const hit = criterion.trim().length === 0 || handoff.result.toLowerCase().includes(criterion.toLowerCase().slice(0, 24));
    checks.push({ name: `criterion: ${criterion.slice(0, 80)}`, met: hit });
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
      return { workItemId: "", childIds: [], decision, delegated: false, note: decision.rationale };
    }
    const created = deps.board.create({
      objective: input.objective,
      ...(input.deliverable !== undefined ? { deliverable: input.deliverable } : {}),
      ...(input.missionId !== undefined ? { missionId: input.missionId } : {}),
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      ...(input.skills !== undefined ? { skills: input.skills } : {}),
    });
    if (!created.ok) {
      return { workItemId: "", childIds: [], decision, delegated: false, note: `Work item refused: ${created.reason}` };
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
    deps.trace.record(ref(created.value), "plan", `Planned: ${input.objective.slice(0, 120)}`);
    emit("delegation.routed", { workItemId: created.value.id, decision: decision.decision, rationale: decision.rationale });
    return { workItemId: created.value.id, childIds, decision, delegated: true, note: decision.rationale };
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

  function buildPrompt(item: WorkItem, workerId: string, whySelected: string, previousAttempts: string[]): string {
    const skillContext = item.skills.length > 0
      ? item.skills
        .map((sid) => {
          const loaded = deps.skills.load(sid);
          return loaded.ok && loaded.body !== undefined ? `## ${sid}\n${loaded.body.slice(0, 1500)}` : null;
        })
        .filter((s): s is string => s !== null)
        .join("\n\n")
        .slice(0, 3000)
      : undefined;
    return buildWorkerPrompt({
      mission: item.missionId ?? item.taskId ?? "direct objective",
      role: workerId,
      whySelected,
      objective: item.objective,
      context: [],
      knownState: [],
      previousAttempts,
      constraints: ["Stay inside the allowed scope.", "Return the HANDOFF FORMAT exactly."],
      scope: item.tools.length > 0 ? `tools: ${item.tools.join(", ")}` : "read-only inspection",
      requiredOutput: item.deliverable ?? item.objective,
      successCriteria: item.deliverable !== undefined ? [item.deliverable] : [],
      verification: ["cite evidence", "name blockers plainly"],
      budget: `attempt ${item.attempts + 1}`,
      handoffFormat: HANDOFF_FORMAT,
      ...(skillContext !== undefined && skillContext.length > 0 ? { skillContext } : {}),
    });
  }

  async function runWorkItem(id: string, opts: RunOpts = {}): Promise<RunOutcome> {
    const started = Date.now();
    const item = deps.board.get(id);
    if (item === null) return { workItemId: id, state: "UNKNOWN", note: `unknown work item "${id}"` };
    const policy = autonomy();
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

    const claimed = deps.board.claim(id, workerId);
    if (!claimed.ok) return { workItemId: id, state: item.state, note: claimed.reason };
    deps.trace.record(ref(claimed.value), "worker", `${workerId} working`);
    emit("worker.started", { workItemId: id, workerId });
    deps.board.heartbeat(id, "started", workerId);

    // Constitution: delegation passes policy first, executes only through the
    // policy-governed delegate port.
    const gate = await deps.policyCheck({ toolId: "agents.run_task", action: `run ${workerId} on objective`, risk: "EXTERNAL" });
    if (gate.outcome === "deny") {
      deps.board.block(id, `policy denied delegation: ${gate.reason}`);
      deps.trace.record(ref(claimed.value), "error", `Blocked: ${gate.reason}`);
      return { workItemId: id, state: "BLOCKED", note: `Policy denied delegation: ${gate.reason}` };
    }
    const verdict = autoVerdict(policy, "delegate", "EXTERNAL");
    if (verdict === "OFF") {
      deps.board.block(id, "delegation disabled by autonomy policy");
      return { workItemId: id, state: "BLOCKED", note: "Delegation is OFF." };
    }

    const prompt = buildPrompt(claimed.value, workerId, whySelected, item.failures);
    const pattern = selectPattern(deps.patterns, analysis.taskType);
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
      const retry = deps.board.checkRetry(id, policy.budgets.maxRetries ?? policy.maxDepth);
      deps.board.fail(id, reason);
      deps.trace.record(ref({ ...item, workerId }), "error", reason);
      emit("worker.failed", { workItemId: id, workerId, reason });
      // Delegate-level failures still teach the bench: an empty handoff that
      // fails verification, recorded like any other failed outcome.
      const emptyHandoff = emptyFailedHandoff(reason);
      const emptyVerification = verifyHandoff(emptyHandoff, []);
      recordBench(id, workerId, benchCtx(analysis, opts, Date.now() - started), emptyHandoff, emptyVerification, null);
      const rec = failure.ok ? failure.value.recommendation : null;
      const retryNote = retry.ok ? ` — retry ${retry.value.retries}/${retry.value.maxRetries} available` : " — retry budget spent";
      return { workItemId: id, state: "FAILED", handoff: emptyHandoff, verification: emptyVerification, note: rec !== null ? `${reason} — recommended: ${rec.action} (${rec.reason})` : `${reason}${retryNote}` };
    }

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
      const retry = deps.board.checkRetry(id, policy.budgets.maxRetries ?? policy.maxDepth);
      const failure = deps.board.recordFailure(id, reason, workerId);
      if (!retry.ok) {
        deps.board.fail(id, `${reason} (retry budget spent)`);
        deps.trace.record(ref({ ...item, workerId }), "error", reason);
        emit("worker.failed", { workItemId: id, workerId, reason });
        recordBench(id, workerId, ctx, handoff, verification, null);
        return { workItemId: id, state: "FAILED", handoff, verification, note: reason };
      }
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
        note: rec !== null ? `${reason} — recommended: ${rec.action} (${rec.reason})` : `${reason} — retry ${retry.value.retries}/${retry.value.maxRetries} available`,
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
    // The retry budget binds the whole work item (not per review round), so
    // a stubborn loop terminates instead of cycling forever.
    const retry = deps.board.checkRetry(id, policy.budgets.maxRetries ?? 2);
    if (!retry.ok) {
      deps.board.fail(id, "review changes unmet: retry budget spent");
      recordBench(id, workerId, ctx, handoff, verification, "CHANGES_REQUESTED");
      return { workItemId: id, state: "FAILED", handoff, verification, review: { verdict: "CHANGES_REQUESTED", findings: loop.findings }, note: "Reviewer requested changes; retry budget spent." };
    }
    const changed = deps.board.changesRequested(id, loop.findings);
    if (!changed.ok) {
      return { workItemId: id, state: item.state, handoff, verification, note: changed.reason };
    }
    deps.board.heartbeat(id, "retry", `review round: ${loop.findings.length} finding(s)`);
    deps.trace.record(ref({ ...item, workerId }), "review", `Changes requested (${loop.findings.length} findings) — retrying`);
    recordBench(id, workerId, ctx, handoff, verification, "CHANGES_REQUESTED");
    // Retry now with the review findings as previous attempts.
    const retryItem = deps.board.get(id);
    const prompt = buildPrompt(retryItem ?? item, workerId, `retry after review: ${loop.findings.slice(0, 3).join("; ").slice(0, 300)}`, [
      ...item.failures,
      `review: ${loop.findings.slice(0, 3).join("; ").slice(0, 300)}`,
    ]);
    let delegated: DelegateResult;
    try {
      delegated = await deps.delegate({
        agentId: workerId,
        prompt,
        ...(ctx.approvalId !== undefined ? { approvalId: ctx.approvalId } : {}),
      });
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

  /** The mission's Outcome Contract: the caller's, or one synthesized from the
   * item — persisted on the item's `outputs` so a resume never forgets it. */
  function outcomeContractFor(item: WorkItem): OutcomeContract {
    const outputs = (item.outputs ?? {}) as { contract?: OutcomeContract };
    if (outputs.contract !== undefined && typeof outputs.contract === "object") return outputs.contract;
    const contract = createOutcomeContract({
      missionId: item.missionId ?? item.taskId ?? item.id,
      intent: item.objective,
      ...(item.deliverable !== undefined ? { deliverables: [item.deliverable] } : {}),
    });
    deps.board.annotate(item.id, { ...outputs, contract });
    return contract;
  }

  /** Does `criterion` appear satisfied by the observed result + evidence? */
  function criterionMet(criterion: string, result: string, evidence: string, verificationPassed: boolean): boolean {
    if (!verificationPassed) return false;
    if (criterion.startsWith("deliverable present") || criterion === "a user-facing deliverable exists") {
      return result.trim().length > 0;
    }
    const tokens = criterion.toLowerCase().match(/[a-z0-9]+/g)?.filter((t) => t.length >= 4) ?? [];
    const hay = `${result}\n${evidence}`.toLowerCase();
    return tokens.length === 0 ? true : tokens.some((t) => hay.includes(t));
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

    // ── THE OUTCOME GATE IS THE COMPLETION AUTHORITY ────────────────────────
    // Structural verification and review are INPUTS. A worker's claim, a
    // passing test, a PASS review, or "no actions left" never complete a
    // mission — only OutcomeGate = PASS does.
    const contract = outcomeContractFor(doneItem);
    const evidenceText = [...handoff.evidence, ...verification.criteria.filter((c) => c.met).map((c) => c.name)].join("\n");
    const criteriaMet: Record<string, boolean> = {};
    for (const c of contract.acceptanceCriteria) criteriaMet[c] = criterionMet(c, handoff.result, evidenceText, verification.passed);
    const observation: Observation = {
      deliverable: handoff.result,
      evidence: handoff.evidence,
      criteriaMet,
      ...(handoff.changedArtifacts.length > 0 ? { changedArtifacts: handoff.changedArtifacts } : {}),
      unresolvedBlockers: handoff.blockers,
    };
    const gate = evaluateOutcome(contract, observation);

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
      emit("worker.progress", { workItemId: id, phase: "next_action", action: decision.action, reason: decision.reason });
      const needsEvidence = decision.action === "RUN_TESTS" || decision.action === "VERIFY" || decision.action === "INSPECT";
      // Evidence-gathering and corrective actions keep the mission OPEN
      // (CHANGES_REQUESTED → the loop continues); only a hard RETRY/FAIL
      // (deliverable genuinely absent) lands FAILED.
      if (needsEvidence || decision.action === "ASK_USER" || decision.action === "REPLAN" || decision.action === "CHANGE_WORKER") {
        deps.board.changesRequested(id, [`${gate.result}: ${gate.reason}`, `next: ${decision.action}`]);
      } else {
        deps.board.fail(id, `${gate.result}: ${gate.reason}`);
      }
      recordBench(id, workerId, ctx, handoff, verification, review?.verdict ?? null);
      return {
        workItemId: id,
        state: needsEvidence ? "CHANGES_REQUESTED" : "FAILED",
        handoff,
        verification,
        ...(review !== null ? { review } : {}),
        note: `Outcome gate ${gate.result} — ${decision.action}: ${decision.reason}`,
      };
    }

    // Gate PASSED: this is the ONLY route to COMPLETED.
    for (const skillId of doneItem.skills) {
      try {
        deps.learning.recordSkillUsage(skillId, { success: true, ...(verification.passed ? { verified: true } : {}) });
      } catch {
        // Metrics never break completion.
      }
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
    emit("worker.completed", { workItemId: id, workerId, valueScore, gate: gate.result });
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

  return { plan: planObjective, startObjective, nextMove, runWorkItem, reviewItem, inspect, benchList, activityList, heartbeat, proposeSkill, proposeTaskSkill, submitSkillProposal, ownsApproval, onApprovalDecided, handoffFromText, verifyHandoff };
}

export type Orchestrator = ReturnType<typeof createOrchestrator>;
