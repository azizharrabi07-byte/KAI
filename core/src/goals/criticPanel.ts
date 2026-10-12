// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The critic panel: how the six lenses actually RUN.
 *
 * `challenger.ts` already owns the roles, the rubrics, the isolation contract
 * (`RoleInput` has no `findings` field on purpose) and the synthesis — including
 * the rule that one blocking objection outvotes any majority. What it did not
 * own is execution: bounds, cancellation, provenance, and the honest difference
 * between "six independent reviews ran" and "no reviewer was available".
 *
 * This module is that execution layer, and nothing else. It is deliberately NOT
 * an orchestrator: it runs no tools, holds no state, writes nothing, and gives a
 * critic no way to act on the plan it judges.
 *
 * ## The three mechanisms, named
 *
 *   - `subagent`    — a role is assigned to a KAI subagent persona, which runs on
 *                     its own bound worker adapter. The strongest isolation KAI
 *                     can offer today.
 *   - `sequential`  — the documented FALLBACK: each role gets its OWN call with
 *                     only that role's input. Six roles are six calls; a single
 *                     response is NEVER shared between roles.
 *   - `unavailable` — no reviewer can run. The panel says so, and the challenger
 *                     turns it into BLOCKED. It is never reported as PASS.
 *
 * ## What a critic cannot do
 *
 * A critic receives the goal, the contract and its rubric. It has no tools, no
 * workspace and no ability to approve its own plan: the only thing it produces is
 * a finding, and `synthesizeFindings` decides what that finding means.
 */

import { createHash } from "node:crypto";

import { diagnoseProviderFailure, describeProviderFailure } from "../model/diagnostics.ts";
import type {
  ChallengeFinding,
  ChallengeMode,
  CriticRole,
  GoalChallengeContract,
  RoleInput,
  RoleRunner,
} from "./challenger.ts";
import { buildCriticPrompt } from "./runners.ts";

/** How a review was executed. Reported, never inferred. */
export type ReviewerKind = "subagent" | "sequential" | "unavailable";

export type CriticRunStatus = "OK" | "UNAVAILABLE" | "FAILED" | "CANCELLED";

export interface CriticProvenance {
  role: string;
  /** The reviewer identity that produced this finding. */
  reviewer: string;
  kind: ReviewerKind;
  round: number;
  goalRevisionId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /**
   * The hash of the EXACT prompt the reviewer judged. It is the proof of what
   * the finding is about, and it changes if the goal or rubric changes.
   */
  promptSha256: string;
  /** The reviewer saw only this role's input — never another role's finding. */
  isolated: boolean;
  source: "model" | "worker-adapter";
}

export interface CriticRunResult {
  role: string;
  status: CriticRunStatus;
  /** Present only when `status` is OK. A failure never carries a finding. */
  finding?: ChallengeFinding;
  provenance: CriticProvenance;
  /** Why it failed, was cancelled, or was unavailable. Empty when OK. */
  reason: string;
}

/**
 * A reviewer. The SMALLEST interface that can run one role: it is handed a
 * `RoleInput` and returns a finding. It cannot see other reviewers, and it is
 * given no way to mutate anything.
 */
export interface CriticReviewer {
  id: string;
  kind: Exclude<ReviewerKind, "unavailable">;
  /** The roles this reviewer may take. Absent = any role. */
  roles?: readonly string[];
  review(
    input: RoleInput,
    opts: { signal?: AbortSignal; timeoutMs: number },
  ): Promise<{ finding: ChallengeFinding; source: "model" | "worker-adapter" }>;
}

export interface PanelAvailability {
  ok: boolean;
  kind: ReviewerKind;
  reason: string;
  reviewers: number;
}

export interface PanelRunInput {
  roles: readonly CriticRole[];
  goal: string;
  content: string;
  contract: GoalChallengeContract;
  goalRevisionId: string;
  round: number;
  mode: ChallengeMode;
  /** Bounds ONE role. Defaults to `DEFAULT_ROLE_TIMEOUT_MS`. */
  timeoutMsPerRole?: number;
  /** Aborts the panel: remaining roles are reported CANCELLED, not silently dropped. */
  signal?: AbortSignal;
  now?: () => Date;
}

export interface PanelRunOutcome {
  results: CriticRunResult[];
  availability: PanelAvailability;
  /** Which mechanism actually ran the reviews. */
  mechanism: ReviewerKind;
  /**
   * True when the panel could NOT produce an independent review for every role.
   * A caller must not read `results` as a complete challenge when this is set.
   */
  incomplete: boolean;
  cancelled: boolean;
  counts: { ok: number; unavailable: number; failed: number; cancelled: number };
  /** One line a user can read, so the mechanism is never invisible. */
  summary: string;
}

export const DEFAULT_ROLE_TIMEOUT_MS = 120_000;

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * The exact bytes a reviewer is shown.
 *
 * It DELEGATES to `buildCriticPrompt`, so there is one prompt builder and the
 * provenance hash is the hash of the prompt that actually ran — not of a second
 * rendering that could drift from it. `buildCriticPrompt` also carries the reply
 * schema, which is what makes a reviewer's output parseable.
 */
export function criticPromptFor(input: RoleInput): string {
  return buildCriticPrompt(input);
}

/**
 * The isolation guard.
 *
 * `RoleInput` has no `findings` field, so independence is structural — but a
 * caller could still hand a reviewer an object carrying one. This refuses it, so
 * isolation is enforced at runtime as well as by the type. It also refuses a role
 * whose rubric is missing: a lens with no rubric is not a lens.
 */
function isolationViolation(input: RoleInput): string | null {
  const smuggled = Object.keys(input as unknown as Record<string, unknown>).filter(
    (key) => key === "findings" || key === "otherFindings" || key === "peers" || key === "previousFindings",
  );
  if (smuggled.length > 0) {
    return `the input carries ${smuggled.join(", ")}, which would break reviewer isolation`;
  }
  if (input.rubric.trim().length === 0) return `role "${input.role}" has no rubric, so it is not a lens`;
  if (input.role.trim().length === 0) return "the role has no name";
  return null;
}

function emptyProvenance(input: RoleInput, at: Date): CriticProvenance {
  return {
    role: input.role,
    reviewer: "(none)",
    kind: "unavailable",
    round: input.round,
    goalRevisionId: input.goalRevisionId,
    startedAt: at.toISOString(),
    finishedAt: at.toISOString(),
    durationMs: 0,
    promptSha256: sha256(criticPromptFor(input)),
    isolated: true,
    source: "model",
  };
}

/**
 * Race a review against its own deadline, and against the panel's cancellation.
 *
 * A timed-out or cancelled review is reported as such and NEVER as a finding: a
 * missing critic must not become a silent PASS.
 */
async function reviewWithBounds(
  reviewer: CriticReviewer,
  input: RoleInput,
  opts: { timeoutMs: number; signal?: AbortSignal; now: () => Date },
): Promise<{ status: CriticRunStatus; finding?: ChallengeFinding; source: "model" | "worker-adapter"; reason: string }> {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  if (opts.signal !== undefined) {
    if (opts.signal.aborted) return { status: "CANCELLED", source: "model", reason: "the panel was cancelled before this role ran" };
    opts.signal.addEventListener("abort", onAbort, { once: true });
  }

  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`critic "${input.role}" exceeded its ${opts.timeoutMs}ms budget`));
    }, opts.timeoutMs);
  });

  try {
    const outcome = await Promise.race([
      reviewer.review(input, { signal: controller.signal, timeoutMs: opts.timeoutMs }),
      deadline,
    ]);
    return { status: "OK", finding: outcome.finding, source: outcome.source, reason: "" };
  } catch (error) {
    if (opts.signal?.aborted === true) {
      return { status: "CANCELLED", source: "model", reason: "the panel was cancelled while this role ran" };
    }
    const message = error instanceof Error ? error.message : String(error);
    if (/exceeded its \d+ms budget/.test(message)) {
      return { status: "FAILED", source: "model", reason: message };
    }
    // A provider failure is classified, so the reason distinguishes a spent
    // allowance from throttling without ever carrying a credential.
    const diagnostic = diagnoseProviderFailure(error);
    return { status: "FAILED", source: "model", reason: `critic "${input.role}" could not run: ${describeProviderFailure(diagnostic)}` };
  } finally {
    clearTimeout(timer);
    if (opts.signal !== undefined) opts.signal.removeEventListener("abort", onAbort);
  }
}

export interface CriticPanelOptions {
  reviewers: readonly CriticReviewer[];
  now?: () => Date;
  timeoutMsPerRole?: number;
}

export interface CriticPanel {
  availability(): PanelAvailability;
  /**
   * Run ONE role. This is the same execution `run` uses, exposed so the existing
   * `GoalChallenger` (which asks for one role at a time) gets the bounds,
   * cancellation and provenance without a second implementation.
   */
  runRole(input: RoleInput, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<CriticRunResult>;
  run(input: PanelRunInput): Promise<PanelRunOutcome>;
}

export function createCriticPanel(options: CriticPanelOptions): CriticPanel {
  const now = options.now ?? (() => new Date());
  const defaultTimeout = options.timeoutMsPerRole ?? DEFAULT_ROLE_TIMEOUT_MS;

  function availability(): PanelAvailability {
    const reviewers = options.reviewers;
    if (reviewers.length === 0) {
      return {
        ok: false,
        kind: "unavailable",
        reviewers: 0,
        reason:
          "no critic reviewer is configured: neither a subagent persona nor a model can run a lens, " +
          "so no independent challenge is possible",
      };
    }
    const hasSubagent = reviewers.some((r) => r.kind === "subagent");
    return {
      ok: true,
      kind: hasSubagent ? "subagent" : "sequential",
      reviewers: reviewers.length,
      reason: hasSubagent
        ? `${reviewers.length} reviewer(s), at least one a subagent persona`
        : `${reviewers.length} reviewer(s), sequential isolated calls (no subagent available)`,
    };
  }

  /**
   * Pick the reviewer for a role.
   *
   * A reviewer that NAMES the role wins, and one that has not been used yet in
   * this round is preferred, so distinct lenses go to distinct reviewers wherever
   * the configuration allows it. Falling back to a shared reviewer is allowed —
   * each role still gets its own isolated call — but the choice is recorded.
   */
  function assign(role: string, used: ReadonlySet<string>): CriticReviewer | null {
    const named = options.reviewers.filter((r) => r.roles?.includes(role) === true);
    const pool = named.length > 0 ? named : options.reviewers;
    return pool.find((r) => !used.has(r.id)) ?? pool[0] ?? null;
  }

  /**
   * ONE role, bounded. Everything the panel promises is implemented here; `run`
   * is only the loop over it, so the challenger and the panel cannot drift.
   */
  async function runRole(
    roleInput: RoleInput,
    opts: { timeoutMs?: number; signal?: AbortSignal; clock?: () => Date; used?: Set<string> } = {},
  ): Promise<CriticRunResult> {
    const clock = opts.clock ?? now;
    const timeoutMs = opts.timeoutMs ?? defaultTimeout;
    const startedAt = clock();

    if (opts.signal?.aborted === true) {
      return {
        role: roleInput.role,
        status: "CANCELLED",
        provenance: { ...emptyProvenance(roleInput, startedAt), reviewer: "(cancelled)" },
        reason: "the panel was cancelled",
      };
    }
    const violation = isolationViolation(roleInput);
    if (violation !== null) {
      return {
        role: roleInput.role,
        status: "FAILED",
        provenance: emptyProvenance(roleInput, startedAt),
        reason: violation,
      };
    }
    const reviewer = assign(roleInput.role, opts.used ?? new Set<string>());
    if (reviewer === null) {
      return {
        role: roleInput.role,
        status: "UNAVAILABLE",
        provenance: emptyProvenance(roleInput, startedAt),
        reason: availability().reason,
      };
    }
    opts.used?.add(reviewer.id);

    const outcome = await reviewWithBounds(reviewer, roleInput, {
      timeoutMs,
      now: clock,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
    const finishedAt = clock();
    return {
      role: roleInput.role,
      status: outcome.status,
      ...(outcome.finding !== undefined ? { finding: outcome.finding } : {}),
      provenance: {
        role: roleInput.role,
        reviewer: reviewer.id,
        kind: reviewer.kind,
        round: roleInput.round,
        goalRevisionId: roleInput.goalRevisionId,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
        promptSha256: sha256(criticPromptFor(roleInput)),
        isolated: true,
        source: outcome.source,
      },
      reason: outcome.reason,
    };
  }

  async function run(input: PanelRunInput): Promise<PanelRunOutcome> {
    const availabilityReport = availability();
    const timeoutMs = input.timeoutMsPerRole ?? defaultTimeout;
    const clock = input.now ?? now;
    const results: CriticRunResult[] = [];
    const used = new Set<string>();
    let cancelled = false;

    for (const role of input.roles) {
      const roleInput: RoleInput = {
        role: role.role,
        rubric: role.rubric,
        mode: input.mode,
        round: input.round,
        goalRevisionId: input.goalRevisionId,
        goal: input.goal,
        content: input.content,
        contract: input.contract,
      };
      // Cancellation is checked per role, so a cancelled panel reports EVERY
      // remaining role rather than quietly returning a short list.
      const result = await runRole(roleInput, {
        timeoutMs,
        clock,
        used,
        ...(cancelled ? { signal: AbortSignal.abort() } : {}),
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      });
      if (result.status === "CANCELLED") cancelled = true;
      results.push(result);
    }

    const counts = {
      ok: results.filter((r) => r.status === "OK").length,
      unavailable: results.filter((r) => r.status === "UNAVAILABLE").length,
      failed: results.filter((r) => r.status === "FAILED").length,
      cancelled: results.filter((r) => r.status === "CANCELLED").length,
    };
    const mechanism: ReviewerKind = !availabilityReport.ok
      ? "unavailable"
      : results.some((r) => r.provenance.kind === "subagent")
        ? "subagent"
        : "sequential";
    const incomplete = counts.ok !== input.roles.length;

    const parts = [
      `${counts.ok}/${input.roles.length} lens(es) evaluated via ${mechanism}`,
      `${new Set(results.filter((r) => r.status === "OK").map((r) => r.provenance.promptSha256)).size} distinct prompt(s)`,
    ];
    if (counts.failed > 0) parts.push(`${counts.failed} failed`);
    if (counts.unavailable > 0) parts.push(`${counts.unavailable} unavailable`);
    if (counts.cancelled > 0) parts.push(`${counts.cancelled} cancelled`);
    if (incomplete) parts.push("the challenge is INCOMPLETE — a missing lens is never a PASS");

    return {
      results,
      availability: availabilityReport,
      mechanism,
      incomplete,
      cancelled,
      counts,
      summary: `${parts.join(" | ")}.`,
    };
  }

  return { availability, runRole, run };
}

/**
 * Adapt a panel into the `RoleRunner` the GoalChallenger asks for.
 *
 * The challenger interrogates roles CONCURRENTLY. A panel backed by one model —
 * or by one worker — should not fire six requests at once, so this SERIALISES
 * them: the documented sequential fallback. Every guarantee survives: each role
 * gets its own isolated prompt, its own bound, and its own provenance.
 *
 * A non-OK result is THROWN, so the challenger's existing catch turns it into a
 * BLOCKED finding. A lens that did not run must never look like a PASS.
 */
export function criticRoleRunner(
  panel: CriticPanel,
  opts: { timeoutMs?: number; signal?: AbortSignal; onResult?: (result: CriticRunResult) => void } = {},
): RoleRunner {
  let chain: Promise<unknown> = Promise.resolve();
  return (input: RoleInput): Promise<ChallengeFinding> => {
    const next = chain.then(async () => {
      const result = await panel.runRole(input, {
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      });
      opts.onResult?.(result);
      if (result.status === "OK" && result.finding !== undefined) return result.finding;
      throw new Error(`${result.status}: ${result.reason}`);
    });
    // The chain stays alive when a role rejects, so one failure does not cancel
    // the roles queued behind it — each lens is reported on its own merits.
    chain = next.catch(() => undefined);
    return next;
  };
}

/** The findings of an outcome, in role order. Failed and missing lenses are absent by design. */
export function findingsOf(outcome: PanelRunOutcome): ChallengeFinding[] {
  return outcome.results
    .filter((result) => result.status === "OK" && result.finding !== undefined)
    .map((result) => result.finding as ChallengeFinding);
}
