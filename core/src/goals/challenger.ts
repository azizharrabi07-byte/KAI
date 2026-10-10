// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Goal Challenger — the adversarial step between "the user typed a goal" and
 * "KAI is allowed to plan/execute it".
 *
 * The challenger runs several INDEPENDENT critic roles against one exact goal
 * revision, captures every finding before any synthesis happens, and then folds
 * the findings together with a PURE deterministic function. No model call ever
 * decides the verdict: if the verdict depended on a model, a second model could
 * be talked out of it, and a majority of agreeable critics could outvote the one
 * that noticed the fatal flaw. Here a single blocking objection stops the goal
 * no matter how many critics said PASS.
 *
 * Why roles are DATA (`CRITIC_ROLES`) and not branches:
 *   - roles can be listed, versioned, counted and selected by mode without
 *     editing control flow;
 *   - independence is a property of the data shape (`RoleInput` has no
 *     `findings` field) instead of a promise in a comment;
 *   - adding a lens is a table row, not a new `if`.
 *
 * Why the runner is injectable (`createGoalChallenger({ runRole, ... })`):
 *   - production wires `runRole` to `chat/brain.ts` `respond`;
 *   - tests inject scripted runners, so no live model is ever needed and every
 *     precedence rule is provable with real inputs (mirrors
 *     `orchestration/review.ts`).
 *
 * ── Honesty rules (never violated) ───────────────────────────────────────────
 *   - A critic that throws, or returns something that fails validation, becomes
 *     a BLOCKED finding quoting the real error/output. It can never be read as
 *     PASS.
 *   - A goal is never asserted PASS without an evaluation. Mode OFF runs zero
 *     critics and therefore returns BLOCKED with `evaluated: false`.
 *   - Missing facts stay missing: an objection with no remediation is reported
 *     in `unresolved[]` and is NOT turned into a revision. `tradeoffs` and
 *     `newAcceptanceCriteria` are never invented.
 *   - No numeric score is fabricated. `counts` are real per-verdict finding
 *     counts and are NEVER used to compute the verdict.
 */

import { createHash } from "node:crypto";
import { redactText } from "../redact/index.ts";

// ── Vocabulary ────────────────────────────────────────────────────────────────

/** A critic's judgement of one goal revision. Any non-PASS value is a signal. */
export type ChallengeVerdict = "PASS" | "CONDITIONAL" | "REVISE" | "BLOCKED";

/** How much adversarial effort to spend. See `selectCriticRoles` for the map. */
export type ChallengeMode = "OFF" | "QUICK" | "DEEP" | "CONTINUOUS";

export type ChallengeSeverity = "low" | "medium" | "high" | "critical";

/** One critic's objection. `remediation` empty ⇒ the objection is unresolved. */
export interface ChallengeObjection {
  id: string;
  statement: string;
  severity: ChallengeSeverity;
  blocking: boolean;
  evidence: string[];
  assumptions: string[];
  remediation: string;
  verification: string;
}

/** One critic's independent finding, stamped with the role that produced it. */
export interface ChallengeFinding {
  role: string;
  verdict: ChallengeVerdict;
  objections: ChallengeObjection[];
  notes?: string;
}

/** A concrete change synthesis derived from a remediable objection. */
export interface ProposedRevision {
  issue: string;
  change: string;
  expectedImprovement: string;
  tradeoffs: string[];
  newAssumptions: string[];
  newAcceptanceCriteria: string[];
  falsifiableTest: string;
}

/** Real per-verdict finding counts. Never a score; never drives the verdict. */
export interface ChallengeCounts {
  total: number;
  pass: number;
  conditional: number;
  revise: number;
  blocked: number;
}

export interface ChallengeSynthesis {
  verdict: ChallengeVerdict;
  /** Roles whose verdicts disagree, kept verbatim — never averaged away. */
  conflicts: string[];
  /** Objections with no remediation (unknown how to fix them yet). */
  unresolved: string[];
  /** Objections that are critical or explicitly blocking. */
  criticalRisks: string[];
  /** Deterministically derived revisions (remediable objections only). */
  revisions: ProposedRevision[];
  counts: ChallengeCounts;
  /** False when no critic ran, i.e. nothing was actually assessed. */
  evaluated: boolean;
  summary: string;
}

export interface ChallengeReport {
  /** Findings are bound to the EXACT revision they judged. */
  goalRevisionId: string;
  mode: ChallengeMode;
  rounds: number;
  /** Independent findings, in selected-role order, captured before synthesis. */
  findings: ChallengeFinding[];
  synthesis: ChallengeSynthesis;
  verdict: ChallengeVerdict;
}

// ── Critic roles (DATA) ───────────────────────────────────────────────────────

export interface CriticRole {
  role: string;
  /** The shared rubric: identical for every goal, specific to this lens. */
  rubric: string;
}

/**
 * The six lenses, in evaluation order. Each rubric states its own blindness:
 * a critic sees the goal, the contract and this rubric — nothing else.
 */
export const CRITIC_ROLES: readonly CriticRole[] = [
  {
    role: "feasibility",
    rubric:
      "Can this goal actually be achieved with the stated workspace, constraints and evidence? Name any missing precondition as an assumption; if a precondition is unknown, say so rather than assuming it is satisfiable. Object when the goal is impossible or under-specified.",
  },
  {
    role: "failure-analysis",
    rubric:
      "Assume the goal fails. What is the most likely cause? Prefer the failure that is cheap to trigger and expensive to discover. Object when a single point of failure has no check that would surface it.",
  },
  {
    role: "user-value",
    rubric:
      "Does the goal, once achieved, actually deliver the outcome the user asked for? Object when the acceptance criteria could pass while the user still gets nothing useful.",
  },
  {
    role: "security",
    rubric:
      "What can this goal touch, disclose or change that it should not? Object on credential exposure, scope widening, destructive or irreversible operations, and any action against an unauthorized workspace.",
  },
  {
    role: "verification",
    rubric:
      "Is each acceptance criterion paired with a method that could falsify it? Object when a criterion has no honest test, or when the evidence could be satisfied without doing the work.",
  },
  {
    role: "cost-alternatives",
    rubric:
      "Is there a materially cheaper path to the same outcome, and is the current path worth its budget? Object when the plan spends more tasks, retries or depth than the goal requires, or when a simpler alternative was ignored.",
  },
];

/**
 * QUICK is deliberately a bounded subset: the three lenses that catch the
 * cheapest-to-detect, highest-frequency failures (can it be done, what breaks
 * it, does the user get value) without paying for the specialist lenses.
 * DEEP and CONTINUOUS run every lens; CONTINUOUS additionally expects the loop
 * to keep re-challenging revised goals, but the round budget still caps it.
 */
export const QUICK_CRITIC_ROLES: Record<string, true> = {
  feasibility: true,
  "failure-analysis": true,
  "user-value": true,
};

export function selectCriticRoles(mode: ChallengeMode): CriticRole[] {
  switch (mode) {
    case "OFF":
      return [];
    case "QUICK":
      return CRITIC_ROLES.filter((r) => QUICK_CRITIC_ROLES[r.role] === true);
    case "DEEP":
    case "CONTINUOUS":
      return [...CRITIC_ROLES];
  }
}

// ── Role input — the ONLY thing a critic may see ──────────────────────────────

/**
 * The parts of a plan/goal contract a critic is allowed to read. Deliberately
 * has no `findings` field: independence is structural, not a convention.
 */
export interface GoalChallengeContract {
  acceptanceCriteria: string[];
  constraints: string[];
  forbiddenOutcomes: string[];
  requiredEvidence?: string[];
}

export interface RoleInput {
  role: string;
  rubric: string;
  mode: ChallengeMode;
  round: number;
  goalRevisionId: string;
  goal: string;
  /** The artifact under challenge (goal text, or a plan revision's content). */
  content: string;
  contract: GoalChallengeContract;
}

export type RoleRunner = (input: RoleInput) => Promise<ChallengeFinding>;

// ── Revision identity ─────────────────────────────────────────────────────────

export interface GoalRevision {
  id: string;
  content: string;
  round: number;
}

/**
 * A revision's identity is a hash of its parent id AND its content, so any
 * change to the artifact yields a new id. A reviewer can therefore never
 * evaluate one revision while another one is approved.
 */
export function revisionIdFor(parentId: string, content: string): string {
  const digest = createHash("sha256").update(`${parentId}\u0000${content}`).digest("hex");
  return `rev-${digest.slice(0, 16)}`;
}

// ── Deterministic synthesis (pure; never a model call) ────────────────────────

const VERDICTS: readonly ChallengeVerdict[] = ["PASS", "CONDITIONAL", "REVISE", "BLOCKED"];
const SEVERITIES: readonly ChallengeSeverity[] = ["low", "medium", "high", "critical"];

export function isChallengeVerdict(value: unknown): value is ChallengeVerdict {
  return typeof value === "string" && (VERDICTS as readonly string[]).includes(value);
}

function isSeverity(value: unknown): value is ChallengeSeverity {
  return typeof value === "string" && (SEVERITIES as readonly string[]).includes(value);
}

function hasText(value: string): boolean {
  return value.trim().length > 0;
}

export function tallyFindings(findings: readonly ChallengeFinding[]): ChallengeCounts {
  const counts: ChallengeCounts = {
    total: findings.length,
    pass: 0,
    conditional: 0,
    revise: 0,
    blocked: 0,
  };
  for (const finding of findings) {
    if (finding.verdict === "PASS") counts.pass += 1;
    else if (finding.verdict === "CONDITIONAL") counts.conditional += 1;
    else if (finding.verdict === "REVISE") counts.revise += 1;
    else counts.blocked += 1;
  }
  return counts;
}

function formatConflict(finding: ChallengeFinding): string {
  const suffix = finding.notes !== undefined && hasText(finding.notes) ? ` (${finding.notes})` : "";
  return `${finding.role}: ${finding.verdict}${suffix}`;
}

function deriveRevisions(findings: readonly ChallengeFinding[]): ProposedRevision[] {
  const revisions: ProposedRevision[] = [];
  for (const finding of findings) {
    for (const objection of finding.objections) {
      if (!hasText(objection.remediation)) continue; // unknown fix ⇒ unresolved, not revised
      revisions.push({
        issue: objection.statement,
        change: objection.remediation,
        // Derived from real fields only; nothing is invented about the goal.
        expectedImprovement: `clear ${objection.severity} objection ${objection.id}`,
        tradeoffs: [],
        newAssumptions: [...objection.assumptions],
        newAcceptanceCriteria: [],
        falsifiableTest: objection.verification,
      });
    }
  }
  return revisions;
}

function summarizeSynthesis(
  mode: ChallengeMode,
  verdict: ChallengeVerdict,
  counts: ChallengeCounts,
  conflicts: string[],
  unresolved: string[],
  criticalRisks: string[],
  revisions: ProposedRevision[],
  evaluated: boolean,
): string {
  if (!evaluated) {
    return `mode ${mode}: no critic roles ran, so no evaluation happened; verdict BLOCKED by construction — a goal is never asserted PASS without a challenge.`;
  }
  const parts = [
    `mode ${mode}`,
    `${counts.total} finding(s): ${counts.pass} PASS, ${counts.conditional} CONDITIONAL, ${counts.revise} REVISE, ${counts.blocked} BLOCKED`,
    `verdict ${verdict}`,
  ];
  if (conflicts.length > 0) parts.push(`disagreement retained — ${conflicts.join("; ")}`);
  if (unresolved.length > 0) parts.push(`${unresolved.length} unresolved objection(s)`);
  if (criticalRisks.length > 0) parts.push(`${criticalRisks.length} high/critical risk(s)`);
  if (revisions.length > 0) parts.push(`${revisions.length} deterministic revision(s) proposed`);
  return `${parts.join(" | ")}.`;
}

/**
 * PURE function of the findings. Precedence, in order:
 *   1. no findings at all            ⇒ BLOCKED  (nothing was evaluated)
 *   2. any finding BLOCKED, or any finding with a blocking objection ⇒ BLOCKED
 *   3. else any REVISE              ⇒ REVISE
 *   4. else any CONDITIONAL         ⇒ CONDITIONAL
 *   5. else                          ⇒ PASS
 * Step 2 is why a 5-vs-1 majority can never outvote one blocking objection:
 * counts feed `counts` only, they are never an input to the verdict.
 */
export function synthesizeFindings(
  findings: readonly ChallengeFinding[],
  mode: ChallengeMode = "DEEP",
): ChallengeSynthesis {
  const evaluated = findings.length > 0;
  const counts = tallyFindings(findings);

  let verdict: ChallengeVerdict;
  if (!evaluated) verdict = "BLOCKED";
  // A finding stops the goal if it says BLOCKED, or carries a blocking objection.
  else if (findings.some((f) => f.verdict === "BLOCKED" || f.objections.some((o) => o.blocking)))
    verdict = "BLOCKED";
  else if (findings.some((f) => f.verdict === "REVISE")) verdict = "REVISE";
  else if (findings.some((f) => f.verdict === "CONDITIONAL")) verdict = "CONDITIONAL";
  else verdict = "PASS";

  const distinct = new Set(findings.map((f) => f.verdict));
  const conflicts = distinct.size > 1 ? findings.map(formatConflict) : [];

  const unresolved: string[] = [];
  const criticalRisks: string[] = [];
  for (const finding of findings) {
    for (const objection of finding.objections) {
      if (!hasText(objection.remediation)) unresolved.push(`${finding.role}: ${objection.statement}`);
      if (objection.severity === "critical" || objection.blocking) {
        criticalRisks.push(`${finding.role}: ${objection.statement}`);
      }
    }
  }

  const revisions = deriveRevisions(findings);
  return {
    verdict,
    conflicts,
    unresolved,
    criticalRisks,
    revisions,
    counts,
    evaluated,
    summary: summarizeSynthesis(mode, verdict, counts, conflicts, unresolved, criticalRisks, revisions, evaluated),
  };
}

export interface ChallengeReportInput {
  goalRevisionId: string;
  mode: ChallengeMode;
  rounds: number;
  findings: ChallengeFinding[];
}

export function buildChallengeReport(input: ChallengeReportInput): ChallengeReport {
  const findings = [...input.findings];
  const synthesis = synthesizeFindings(findings, input.mode);
  return {
    goalRevisionId: input.goalRevisionId,
    mode: input.mode,
    rounds: input.rounds,
    findings,
    synthesis,
    verdict: synthesis.verdict,
  };
}

// ── Runner-output validation (honest failure, never a fabricated PASS) ────────

function safeSerialize(value: unknown, cap = 600): string {
  let text: string;
  try {
    text = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
  } catch {
    text = String(value);
  }
  return text.length > cap ? `${text.slice(0, cap)}…` : text;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message.length > 0 ? err.message : err.name;
  return safeSerialize(err, 200);
}

function blockedFinding(role: string, id: string, statement: string, evidence: string[]): ChallengeFinding {
  return {
    role,
    verdict: "BLOCKED",
    objections: [
      {
        id,
        statement,
        severity: "high",
        blocking: true,
        evidence,
        assumptions: [],
        remediation: `re-run the "${role}" critic so it returns a well-formed finding`,
        verification: "critic returns { verdict ∈ {PASS,CONDITIONAL,REVISE,BLOCKED}, objections: ChallengeObjection[] }",
      },
    ],
    notes: "runner output was not usable; recorded as BLOCKED so it can never be read as PASS",
  };
}

function normalizeObjection(role: string, raw: unknown, index: number): ChallengeObjection | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.statement !== "string" || rec.statement.trim().length === 0) return null;
  if (rec.severity !== undefined && !isSeverity(rec.severity)) return null;
  return {
    // A missing id is an identifier we mint, not a fact we invent.
    id: typeof rec.id === "string" && rec.id.length > 0 ? rec.id : `${role}:objection-${index + 1}`,
    statement: rec.statement,
    // Unspecified severity records as the neutral middle: never "low" (which
    // would hide risk) and never "critical" (which would overstate it).
    severity: isSeverity(rec.severity) ? rec.severity : "medium",
    blocking: rec.blocking === true,
    evidence: Array.isArray(rec.evidence)
      ? rec.evidence.filter((v): v is string => typeof v === "string")
      : [],
    assumptions: Array.isArray(rec.assumptions)
      ? rec.assumptions.filter((v): v is string => typeof v === "string")
      : [],
    remediation: typeof rec.remediation === "string" ? rec.remediation : "",
    verification: typeof rec.verification === "string" ? rec.verification : "",
  };
}

/** Validates a runner result, stamping the requested role. Unknown fields are ignored. */
export function normalizeFinding(role: string, raw: unknown): ChallengeFinding {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return blockedFinding(role, `${role}:malformed`, `critic "${role}" did not return an object`, [
      safeSerialize(raw),
    ]);
  }
  const rec = raw as Record<string, unknown>;
  if (rec.role !== undefined && rec.role !== role) {
    return blockedFinding(role, `${role}:malformed`, `critic for "${role}" returned role "${String(rec.role)}"`, [
      safeSerialize(rec.role),
    ]);
  }
  if (!isChallengeVerdict(rec.verdict)) {
    return blockedFinding(
      role,
      `${role}:malformed`,
      `critic "${role}" returned an invalid verdict ${safeSerialize(rec.verdict, 60)} (expected PASS|CONDITIONAL|REVISE|BLOCKED)`,
      [safeSerialize(raw)],
    );
  }
  const rawObjections = rec.objections;
  if (rawObjections !== undefined && !Array.isArray(rawObjections)) {
    return blockedFinding(role, `${role}:malformed`, `critic "${role}" returned non-array objections`, [
      safeSerialize(rawObjections),
    ]);
  }
  const objections: ChallengeObjection[] = [];
  for (let i = 0; i < (rawObjections?.length ?? 0); i += 1) {
    const objection = normalizeObjection(role, rawObjections?.[i], i);
    if (objection === null) {
      return blockedFinding(role, `${role}:malformed`, `critic "${role}" objection #${i + 1} is malformed`, [
        safeSerialize(rawObjections?.[i]),
      ]);
    }
    objections.push(objection);
  }
  const finding: ChallengeFinding = { role, verdict: rec.verdict, objections };
  if (typeof rec.notes === "string" && rec.notes.length > 0) finding.notes = rec.notes;
  return finding;
}

// ── The challenger ────────────────────────────────────────────────────────────

export const DEFAULT_MAX_ROUNDS = 3;
/** Absolute ceiling; a caller-supplied budget is clamped to this. */
export const HARD_MAX_ROUNDS = 10;

export interface GoalChallengerOptions {
  runRole: RoleRunner;
  mode: ChallengeMode;
  maxRounds?: number;
  now?: () => Date;
}

export interface ChallengeInput {
  /** Identity of the revision being challenged; echoed into every finding. */
  goalRevisionId: string;
  goal: string;
  /** Artifact under challenge. Defaults to `goal`. */
  content?: string;
  contract: GoalChallengeContract;
  /** First round number (default 1); lets a caller continue a goal's budget. */
  round?: number;
  /** Override the deterministic revision step (defaults to `defaultApplyRevisions`). */
  applyRevisions?: (current: GoalRevision, revisions: ProposedRevision[]) => GoalRevision;
}

export interface ChallengeRoundRecord {
  round: number;
  goalRevisionId: string;
  content: string;
  at: string;
  findings: ChallengeFinding[];
  report: ChallengeReport;
}

export interface ChallengeOutcome {
  /** The final round's report — the one a reviewer must act on. */
  report: ChallengeReport;
  /** Rounds actually run. Always 1..maxRounds. */
  rounds: number;
  goalRevisionId: string;
  evaluated: boolean;
  recommendation: string;
  /** Best remaining proposed revisions when the budget ran out. */
  bestAlternatives: ProposedRevision[];
  unresolved: string[];
  /** Every round, in order, for audit. */
  history: ChallengeRoundRecord[];
}

export interface GoalChallenger {
  readonly mode: ChallengeMode;
  readonly roles: readonly CriticRole[];
  readonly maxRounds: number;
  challenge(input: ChallengeInput): Promise<ChallengeOutcome>;
}

function clampRounds(value: number | undefined): number {
  const requested = value ?? DEFAULT_MAX_ROUNDS;
  if (!Number.isInteger(requested) || requested < 1) return 1;
  return Math.min(requested, HARD_MAX_ROUNDS);
}

/** Deterministic default revision step: fold the proposed changes into the text. */
export function defaultApplyRevisions(
  current: GoalRevision,
  revisions: readonly ProposedRevision[],
): GoalRevision {
  const directives =
    revisions.length === 0
      ? "(no concrete revision was proposed; the unresolved objections must be answered before re-challenging)"
      : revisions
          .map((r) => `- ${r.issue} => ${r.change} (test: ${hasText(r.falsifiableTest) ? r.falsifiableTest : "unspecified"})`)
          .join("\n");
  const content = `${current.content}\n\n## Applied revision directives (round ${current.round + 1})\n${directives}`;
  return { id: revisionIdFor(current.id, content), content, round: current.round + 1 };
}

function recommendationFor(report: ChallengeReport, rounds: number, maxRounds: number): string {
  const s = report.synthesis;
  if (!s.evaluated) {
    return `No critic roles ran (mode ${report.mode}): revision ${report.goalRevisionId} is NOT approved — a goal is never asserted PASS without a challenge. Enable a challenge mode before planning.`;
  }
  switch (report.verdict) {
    case "PASS":
      return `Revision ${report.goalRevisionId} passed challenge after ${rounds} round(s); proceed to plan approval.`;
    case "BLOCKED":
      return `Revision ${report.goalRevisionId} is BLOCKED (${s.criticalRisks.length} critical/blocking risk(s)); do not plan or dispatch until the blocking objection(s) are cleared.`;
    case "REVISE":
      return `Revision ${report.goalRevisionId} still needs revision after ${rounds}/${maxRounds} round(s); ${s.unresolved.length} unresolved objection(s). Resolve them, then re-challenge — do not dispatch.`;
    case "CONDITIONAL":
      return `Revision ${report.goalRevisionId} is CONDITIONAL after ${rounds}/${maxRounds} round(s); proceed only if every condition below is accepted explicitly.`;
    default:
      return `Revision ${report.goalRevisionId} could not be classified; treat as not approved.`;
  }
}

/**
 * Build a challenger. The same `mode` selects the roles for every call; the
 * round budget is fixed at construction and clamped to `HARD_MAX_ROUNDS`.
 */
export function createGoalChallenger(options: GoalChallengerOptions): GoalChallenger {
  const mode = options.mode;
  const runRole = options.runRole;
  const roles = selectCriticRoles(mode);
  const maxRounds = clampRounds(options.maxRounds);
  const now = options.now ?? (() => new Date());

  return {
    mode,
    roles,
    maxRounds,
    async challenge(input: ChallengeInput): Promise<ChallengeOutcome> {
      const { goal, contract } = input;
      let revision: GoalRevision = {
        id: input.goalRevisionId,
        content: input.content ?? input.goal,
        round: input.round ?? 1,
      };
      const startRound = revision.round;
      const lastRound = startRound + maxRounds - 1;
      const history: ChallengeRoundRecord[] = [];
      let answer: ChallengeReport | null = null;
      let rounds = 0;

      for (let round = startRound; round <= lastRound; round += 1) {
        const goalRevisionId = revision.id;
        const content = revision.content;
        // All critics are interrogated with only goal + contract + their rubric,
        // and every finding is captured BEFORE synthesis reads any of them.
        const findings = await Promise.all(
          roles.map(async (spec): Promise<ChallengeFinding> => {
            const roleInput: RoleInput = {
              role: spec.role,
              rubric: spec.rubric,
              mode,
              round,
              goalRevisionId,
              goal: redactText(goal),
              content: redactText(content),
              contract: {
                acceptanceCriteria: contract.acceptanceCriteria.map(redactText),
                constraints: contract.constraints.map(redactText),
                forbiddenOutcomes: contract.forbiddenOutcomes.map(redactText),
                ...(contract.requiredEvidence !== undefined
                  ? { requiredEvidence: contract.requiredEvidence.map(redactText) }
                  : {}),
              },
            };
            try {
              return normalizeFinding(spec.role, await runRole(roleInput));
            } catch (err) {
              return blockedFinding(
                spec.role,
                `${spec.role}:threw`,
                `critic "${spec.role}" threw during evaluation: ${errorMessage(err)}`,
                [errorMessage(err)],
              );
            }
          }),
        );

        rounds += 1;
        const report = buildChallengeReport({ goalRevisionId, mode, rounds, findings });
        history.push({
          round,
          goalRevisionId,
          content,
          at: now().toISOString(),
          findings,
          report,
        });
        answer = report;

        if (report.verdict === "PASS" || report.verdict === "BLOCKED") break;
        if (round === lastRound) break; // REVISE/CONDITIONAL at the limit: stop, never force PASS

        const apply = input.applyRevisions ?? defaultApplyRevisions;
        revision = apply(revision, report.synthesis.revisions);
      }

      const report = answer as ChallengeReport;
      return {
        report,
        rounds,
        goalRevisionId: report.goalRevisionId,
        evaluated: report.synthesis.evaluated,
        recommendation: recommendationFor(report, rounds, maxRounds),
        bestAlternatives: report.synthesis.revisions,
        unresolved: report.synthesis.unresolved,
        history,
      };
    },
  };
}
