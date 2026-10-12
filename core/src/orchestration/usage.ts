// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * What an external worker actually reports, and what KAI may therefore enforce.
 *
 * ## The defect this closes
 *
 * `WorkBudget` declares `maxToolCalls` and `maxCostUsd`, and until now those
 * fields were presented as limits while nothing enforced them — and, worse,
 * nothing could. A worker does not report tool invocations, and no provider
 * reports a dollar amount, so treating the missing values as ZERO would have
 * made every limit look satisfied forever. That is the failure mode this module
 * exists to prevent: an unenforceable limit must be REPORTED as unenforceable,
 * not silently passed.
 *
 * ## What is real
 *
 * Audited, per adapter:
 *
 *     hermes   input/output tokens, parsed from the worker's own response
 *     codex    input/output tokens, when the run reports them
 *     opencode NO usage of any kind
 *     (none)   tool-call counts — no adapter reports them
 *     (none)   cost — no provider reports it, and KAI will not invent dollars
 *              from token counts, because a price table KAI does not have is a
 *              guess dressed as a measurement
 *
 * So `measured` means a worker reported it; `unavailable` means nobody did. There
 * is no third state that quietly becomes a number, and an unavailable amount is
 * NEVER debited as zero.
 */

import type { BudgetKind, BudgetLedger, BudgetLimits, BudgetScope } from "./budget.ts";
import type { WorkCost } from "./types.ts";

/** Where a number came from. `unavailable` is a first-class answer, not an error. */
export type UsageProvenance = "measured" | "estimated" | "unavailable";

export interface UsageAmount {
  provenance: UsageProvenance;
  /** Present only for `measured` and `estimated`. Never present for `unavailable`. */
  value?: number;
  /** Why it is what it is: how it was measured, or why nobody could. */
  note: string;
}

/** What a given worker is able to report. It decides what KAI can enforce. */
export interface WorkerUsageCapability {
  inputTokens: boolean;
  outputTokens: boolean;
  toolCalls: boolean;
  costUsd: boolean;
}

/** The capability of a worker that reports nothing — the conservative default. */
export const NO_USAGE_CAPABILITY: WorkerUsageCapability = {
  inputTokens: false,
  outputTokens: false,
  toolCalls: false,
  costUsd: false,
};

/** Token reporting only, which is what KAI's real adapters do. */
export const TOKEN_USAGE_CAPABILITY: WorkerUsageCapability = {
  inputTokens: true,
  outputTokens: true,
  toolCalls: false,
  costUsd: false,
};

export interface WorkerUsageReport {
  /** The idempotency key. A redelivered report is never debited twice. */
  reportId: string;
  workerId: string;
  itemId?: string;
  /** The dispatch attempt this belongs to. */
  attempt: number;
  reportedAt: string;
  source: "worker-adapter" | "kai-observed";
  inputTokens: UsageAmount;
  outputTokens: UsageAmount;
  toolCalls: UsageAmount;
  costUsd: UsageAmount;
  /** Wall-clock as KAI observed it. KAI can always measure this itself. */
  latencyMs: UsageAmount;
}

export interface UsageReportInput {
  workerId: string;
  itemId?: string;
  attempt: number;
  /** Stable across redeliveries of the same worker turn. */
  reportId?: string;
  /** What the adapter returned, when it returned anything. */
  cost?: WorkCost;
  latencyMs?: number;
  capability?: WorkerUsageCapability;
  now?: () => Date;
}

function measured(value: number, note: string): UsageAmount {
  return { provenance: "measured", value, note };
}

function unavailable(note: string): UsageAmount {
  return { provenance: "unavailable", note };
}

/**
 * Build the report. Every field is either MEASURED with a reason or explicitly
 * UNAVAILABLE with a reason; nothing is defaulted to zero.
 */
export function usageReportFrom(input: UsageReportInput): WorkerUsageReport {
  const now = input.now ?? (() => new Date());
  const capability = input.capability ?? NO_USAGE_CAPABILITY;
  const cost = input.cost;

  const inputTokens =
    capability.inputTokens && typeof cost?.tokensIn === "number"
      ? measured(cost.tokensIn, "reported by the worker adapter")
      : unavailable(
          capability.inputTokens
            ? "the adapter can report input tokens but this run reported none"
            : "this worker adapter does not report input tokens",
        );

  const outputTokens =
    capability.outputTokens && typeof cost?.tokensOut === "number"
      ? measured(cost.tokensOut, "reported by the worker adapter")
      : unavailable(
          capability.outputTokens
            ? "the adapter can report output tokens but this run reported none"
            : "this worker adapter does not report output tokens",
        );

  const toolCalls =
    capability.toolCalls && typeof cost?.toolCalls === "number"
      ? measured(cost.toolCalls, "reported by the worker adapter")
      : unavailable(
          capability.toolCalls
            ? "the adapter can report tool calls but this run reported none"
            : "no worker adapter reports tool invocations, so KAI cannot count them",
        );

  // Cost is deliberately never derived from tokens. A price table KAI does not
  // have would turn a guess into a number, and a number is what a limit acts on.
  const costUsd =
    capability.costUsd && typeof cost?.costUsd === "number"
      ? measured(cost.costUsd, "reported by the provider")
      : unavailable(
          capability.costUsd
            ? "the adapter can report cost but this run reported none"
            : "no provider reports cost, and KAI does not derive dollars from token counts",
        );

  const report: WorkerUsageReport = {
    reportId: input.reportId ?? `usage_${input.workerId}_${input.itemId ?? "-"}_${input.attempt}`,
    workerId: input.workerId,
    attempt: input.attempt,
    reportedAt: now().toISOString(),
    source: "worker-adapter",
    inputTokens,
    outputTokens,
    toolCalls,
    costUsd,
    latencyMs:
      typeof input.latencyMs === "number"
        ? measured(input.latencyMs, "observed by KAI")
        : unavailable("KAI did not time this run"),
  };
  if (input.itemId !== undefined) report.itemId = input.itemId;
  return report;
}

export type Enforceability = "enforced" | "unenforceable";

export interface LimitEnforceability {
  /** A limit KAI itself observes: always enforceable. */
  maxDispatches: Enforceability;
  maxRetries: Enforceability;
  maxReassignments: Enforceability;
  /** Bounded by KAI's own clock, so enforceable even when the worker says nothing. */
  maxRuntimeMs: Enforceability;
  maxTokens: Enforceability;
  maxToolCalls: Enforceability;
  maxCostUsd: Enforceability;
  /** One line per limit that CANNOT be enforced, and why. Never empty by accident. */
  unenforceable: { limit: string; reason: string }[];
}

/**
 * Which of a budget's limits KAI can actually hold this worker to.
 *
 * A limit that is not set is not reported as unenforceable — there is nothing to
 * enforce. A limit that IS set and cannot be measured is reported, loudly.
 */
export function enforceabilityOf(limits: BudgetLimits, capability: WorkerUsageCapability): LimitEnforceability {
  const unenforceable: { limit: string; reason: string }[] = [];

  const tokensEnforceable = capability.inputTokens || capability.outputTokens;
  if (limits.maxTokens !== undefined && !tokensEnforceable) {
    unenforceable.push({
      limit: "maxTokens",
      reason: "this worker reports no token usage, so a token ceiling cannot be held",
    });
  }
  if (limits.maxToolCalls !== undefined && !capability.toolCalls) {
    unenforceable.push({
      limit: "maxToolCalls",
      reason:
        "no worker adapter reports tool invocations, so KAI cannot count them; " +
        "this limit needs worker support before it can be enforced",
    });
  }
  if (limits.maxCostUsd !== undefined && !capability.costUsd) {
    unenforceable.push({
      limit: "maxCostUsd",
      reason:
        "no provider reports cost, and KAI will not estimate dollars from token counts; " +
        "this limit needs provider-reported cost before it can be enforced",
    });
  }

  return {
    maxDispatches: "enforced",
    maxRetries: "enforced",
    maxReassignments: "enforced",
    maxRuntimeMs: "enforced",
    maxTokens: limits.maxTokens === undefined ? "enforced" : tokensEnforceable ? "enforced" : "unenforceable",
    maxToolCalls: limits.maxToolCalls === undefined ? "enforced" : capability.toolCalls ? "enforced" : "unenforceable",
    maxCostUsd: limits.maxCostUsd === undefined ? "enforced" : capability.costUsd ? "enforced" : "unenforceable",
    unenforceable,
  };
}

export interface DebitOutcome {
  /** The kinds actually debited, with the amount and the reservation. */
  debited: { kind: BudgetKind; amount: number; reservationId: string }[];
  /** The kinds deliberately NOT debited, because the value is unknown. */
  skipped: { kind: BudgetKind; reason: string }[];
  /** A ceiling was reached. The caller must stop, not retry. */
  exhausted?: { kind: BudgetKind; reason: string };
}

/**
 * Debit the MEASURED usage against the durable budget.
 *
 * Three properties, each of which is the reason this is not just two `reserve`
 * calls:
 *
 *   1. An UNAVAILABLE amount is skipped and named. It is never debited as zero,
 *      which would make an unenforceable limit look satisfied.
 *   2. Each debit carries a report-scoped idempotency key, so a redelivered
 *      report (a retried callback, a duplicated event) takes no second debit.
 *   3. An exhausted ceiling stops the loop and is reported; the remaining kinds
 *      are not attempted, so the caller gets one clear reason.
 */
export function debitUsage(
  ledger: BudgetLedger,
  scope: BudgetScope,
  report: WorkerUsageReport,
  limits: BudgetLimits,
): DebitOutcome {
  const outcome: DebitOutcome = { debited: [], skipped: [] };

  const plan: { kind: BudgetKind; amount: UsageAmount }[] = [
    { kind: "token", amount: { provenance: report.inputTokens.provenance, value: (report.inputTokens.value ?? 0) + (report.outputTokens.value ?? 0), note: "input + output tokens" } },
    { kind: "toolCall", amount: report.toolCalls },
    { kind: "cost", amount: report.costUsd },
  ];

  // Token accounting is only meaningful when at least ONE of the two was
  // measured; otherwise the sum would be a fabricated 0.
  const tokensMeasured = report.inputTokens.provenance === "measured" || report.outputTokens.provenance === "measured";

  for (const { kind, amount } of plan) {
    if (kind === "token" && !tokensMeasured) {
      outcome.skipped.push({ kind, reason: "no token usage was reported, so nothing is debited (never treated as zero)" });
      continue;
    }
    if (kind !== "token" && amount.provenance !== "measured") {
      outcome.skipped.push({ kind, reason: amount.note });
      continue;
    }
    if (kind === "token" && (amount.value ?? 0) <= 0) {
      outcome.skipped.push({ kind, reason: "the measured token count is zero, so there is nothing to debit" });
      continue;
    }
    const reserved = ledger.reserve({
      scope,
      kind,
      limits,
      amount: amount.value ?? 0,
      idempotencyKey: `usage:${report.reportId}:${kind}`,
      ...(report.itemId !== undefined ? { itemId: report.itemId } : {}),
      detail: amount.note,
    });
    if (reserved.ok) {
      outcome.debited.push({ kind, amount: amount.value ?? 0, reservationId: reserved.reservation.id });
      continue;
    }
    outcome.exhausted = { kind, reason: reserved.reason };
    return outcome;
  }

  return outcome;
}

/** A one-line, user-facing statement of what is and is not enforced. */
export function describeEnforcement(report: WorkerUsageReport, limits: BudgetLimits): string {
  const capability: WorkerUsageCapability = {
    inputTokens: report.inputTokens.provenance === "measured",
    outputTokens: report.outputTokens.provenance === "measured",
    toolCalls: report.toolCalls.provenance === "measured",
    costUsd: report.costUsd.provenance === "measured",
  };
  const enforceability = enforceabilityOf(limits, capability);
  const measured = [
    report.inputTokens.provenance === "measured" ? `in ${report.inputTokens.value}` : null,
    report.outputTokens.provenance === "measured" ? `out ${report.outputTokens.value}` : null,
    report.toolCalls.provenance === "measured" ? `tools ${report.toolCalls.value}` : null,
    report.costUsd.provenance === "measured" ? `cost $${report.costUsd.value}` : null,
  ].filter((part): part is string => part !== null);
  const base =
    measured.length > 0
      ? `measured usage: ${measured.join(", ")}`
      : "measured usage: none — this worker reported no usage";
  if (enforceability.unenforceable.length === 0) return `${base}.`;
  return `${base}. NOT enforced: ${enforceability.unenforceable.map((u) => `${u.limit} (${u.reason})`).join("; ")}.`;
}
