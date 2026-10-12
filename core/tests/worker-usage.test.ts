// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Worker usage accounting, and the limits it CANNOT hold.
 *
 * The defect this pins: `maxToolCalls` and `maxCostUsd` were presented as limits
 * while nothing enforced them — and nothing could, because no adapter reports
 * tool calls and no provider reports cost. The failure mode to avoid is treating
 * the missing value as ZERO, which makes every limit look satisfied forever.
 *
 * Every test below is either "the measured value is debited" or "the unknown
 * value is NAMED and not debited".
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createBudgetLedger, type BudgetLedger } from "../src/orchestration/budget.ts";
import {
  debitUsage,
  describeEnforcement,
  enforceabilityOf,
  NO_USAGE_CAPABILITY,
  TOKEN_USAGE_CAPABILITY,
  usageReportFrom,
  type WorkerUsageReport,
} from "../src/orchestration/usage.ts";

function tempLedger(t: { after(fn: () => void): void }): BudgetLedger {
  const dir = mkdtempSync(join(tmpdir(), "kai-usage-"));
  const ledger = createBudgetLedger({ path: join(dir, "budget.db") });
  t.after(() => {
    ledger.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return ledger;
}

const scope = { goalId: "goal_a", planRevisionId: "rev_1", chainId: "root" };

test("a worker that reports tokens is MEASURED, and the note says so", (t) => {
  const report = usageReportFrom({
    workerId: "hermes",
    itemId: "w1",
    attempt: 1,
    cost: { tokensIn: 1200, tokensOut: 400 },
    latencyMs: 900,
    capability: TOKEN_USAGE_CAPABILITY,
  });
  assert.equal(report.inputTokens.provenance, "measured");
  assert.equal(report.inputTokens.value, 1200);
  assert.equal(report.outputTokens.value, 400);
  assert.equal(report.latencyMs.provenance, "measured", "KAI always measures its own clock");
  assert.match(report.inputTokens.note, /reported by the worker adapter/);
  t.diagnostic(describeEnforcement(report, {}));
});

test("a worker that reports NOTHING yields unavailable, never zero", (t) => {
  const report = usageReportFrom({ workerId: "opencode", attempt: 1, capability: NO_USAGE_CAPABILITY });
  for (const amount of [report.inputTokens, report.outputTokens, report.toolCalls, report.costUsd]) {
    assert.equal(amount.provenance, "unavailable");
    assert.equal(amount.value, undefined, "an unavailable amount carries NO number at all");
    assert.ok(amount.note.length > 0, "and it explains why");
  }
  assert.match(report.toolCalls.note, /no worker adapter reports tool invocations/);
  assert.match(report.costUsd.note, /KAI does not derive dollars from token counts/);
  t.diagnostic(report.costUsd.note);
});

test("an adapter that CAN report tokens but reported none is unavailable, not zero", (t) => {
  const report = usageReportFrom({ workerId: "hermes", attempt: 1, capability: TOKEN_USAGE_CAPABILITY });
  assert.equal(report.inputTokens.provenance, "unavailable");
  assert.match(report.inputTokens.note, /can report input tokens but this run reported none/);
  assert.equal(report.inputTokens.value, undefined);
});

test("ENFORCEABILITY: an unenforceable limit is named, and a good one is not", (t) => {
  const limits = { maxDispatches: 10, maxTokens: 1000, maxToolCalls: 5, maxCostUsd: 1 };
  const report = enforceabilityOf(limits, TOKEN_USAGE_CAPABILITY);
  assert.equal(report.maxDispatches, "enforced", "KAI observes dispatches itself");
  assert.equal(report.maxRuntimeMs, "enforced", "KAI observes its own clock");
  assert.equal(report.maxTokens, "enforced", "tokens are reported");
  assert.equal(report.maxToolCalls, "unenforceable");
  assert.equal(report.maxCostUsd, "unenforceable");
  assert.equal(report.unenforceable.length, 2);
  assert.ok(report.unenforceable.some((u) => u.limit === "maxToolCalls" && /needs worker support/.test(u.reason)));
  assert.ok(report.unenforceable.some((u) => u.limit === "maxCostUsd" && /provider-reported cost/.test(u.reason)));
  t.diagnostic(report.unenforceable.map((u) => u.limit).join(", "));
});

test("a limit that is NOT SET is not reported as unenforceable — there is nothing to enforce", (t) => {
  const report = enforceabilityOf({ maxDispatches: 3 }, NO_USAGE_CAPABILITY);
  assert.deepEqual(report.unenforceable, []);
  assert.equal(report.maxCostUsd, "enforced", "no cost ceiling was asked for, so nothing is unenforced");
});

test("MEASURED tokens are debited; an unavailable amount debits nothing", (t) => {
  const ledger = tempLedger(t);
  const measured = usageReportFrom({
    workerId: "hermes",
    itemId: "w1",
    attempt: 1,
    cost: { tokensIn: 1000, tokensOut: 500 },
    capability: TOKEN_USAGE_CAPABILITY,
  });
  const outcome = debitUsage(ledger, scope, measured, { maxTokens: 100000 });
  assert.equal(outcome.debited.length, 1);
  assert.equal(outcome.debited[0]?.kind, "token");
  assert.equal(outcome.debited[0]?.amount, 1500, "input + output");
  assert.equal(ledger.consumed(scope, "token"), 1500);
  // tool calls and cost are skipped WITH A REASON, not debited as zero.
  assert.equal(outcome.skipped.length, 2);
  assert.deepEqual(outcome.skipped.map((s) => s.kind).sort(), ["cost", "toolCall"]);
  assert.ok(outcome.skipped.every((s) => s.reason.length > 0));
  assert.equal(ledger.consumed(scope, "cost"), 0);
  assert.equal(ledger.consumed(scope, "toolCall"), 0);
  t.diagnostic(outcome.skipped.map((s) => `${s.kind}: ${s.reason}`).join(" | "));
});

test("a worker that reports NOTHING debits nothing at all", (t) => {
  const ledger = tempLedger(t);
  const report = usageReportFrom({ workerId: "opencode", itemId: "w1", attempt: 1, capability: NO_USAGE_CAPABILITY });
  const outcome = debitUsage(ledger, scope, report, { maxTokens: 10, maxToolCalls: 1, maxCostUsd: 0.01 });
  assert.deepEqual(outcome.debited, []);
  assert.equal(outcome.skipped.length, 3, "every kind is skipped and explained");
  assert.equal(ledger.consumed(scope, "token"), 0);
  assert.equal(ledger.consumed(scope, "toolCall"), 0);
  assert.equal(ledger.consumed(scope, "cost"), 0);
  assert.equal(outcome.exhausted, undefined, "nothing was debited, so nothing was exhausted");
  t.diagnostic(outcome.skipped.map((s) => s.kind).join(", "));
});

test("a DUPLICATE usage report takes no second debit", (t) => {
  const ledger = tempLedger(t);
  const report = usageReportFrom({
    workerId: "hermes",
    itemId: "w1",
    attempt: 1,
    reportId: "usage_hermes_w1_1",
    cost: { tokensIn: 800, tokensOut: 200 },
    capability: TOKEN_USAGE_CAPABILITY,
  });
  const first = debitUsage(ledger, scope, report, { maxTokens: 100000 });
  assert.equal(first.debited.length, 1);
  // The same report, delivered again (a retried callback).
  const second = debitUsage(ledger, scope, report, { maxTokens: 100000 });
  assert.equal(second.debited.length, 1, "the reservation is returned, not recreated");
  assert.equal(second.debited[0]?.reservationId, first.debited[0]?.reservationId, "the SAME reservation");
  assert.equal(ledger.consumed(scope, "token"), 1000, "one debit for one report delivered twice");
});

test("a DELAYED report still lands on the right scope, and a stale one cannot be replayed", (t) => {
  const ledger = tempLedger(t);
  const first = usageReportFrom({
    workerId: "hermes",
    itemId: "w1",
    attempt: 1,
    cost: { tokensIn: 500, tokensOut: 0 },
    capability: TOKEN_USAGE_CAPABILITY,
  });
  debitUsage(ledger, scope, first, { maxTokens: 100000 });
  // A report for a LATER attempt is a separate debit.
  const later = usageReportFrom({
    workerId: "hermes",
    itemId: "w1",
    attempt: 2,
    cost: { tokensIn: 300, tokensOut: 0 },
    capability: TOKEN_USAGE_CAPABILITY,
  });
  debitUsage(ledger, scope, later, { maxTokens: 100000 });
  assert.equal(ledger.consumed(scope, "token"), 800, "both attempts are accounted");
  // The FIRST report arriving again is still idempotent.
  debitUsage(ledger, scope, first, { maxTokens: 100000 });
  assert.equal(ledger.consumed(scope, "token"), 800, "the stale redelivery changed nothing");
});

test("PARTIAL usage debits only the half that was measured", (t) => {
  const ledger = tempLedger(t);
  // Output tokens reported, input tokens not.
  const report: WorkerUsageReport = {
    ...usageReportFrom({ workerId: "hermes", itemId: "w1", attempt: 1, capability: TOKEN_USAGE_CAPABILITY }),
    inputTokens: { provenance: "unavailable", note: "the run reported no input tokens" },
    outputTokens: { provenance: "measured", value: 250, note: "reported by the worker adapter" },
  };
  const outcome = debitUsage(ledger, scope, report, { maxTokens: 100000 });
  assert.equal(outcome.debited.length, 1);
  assert.equal(outcome.debited[0]?.amount, 250, "only the measured half is debited");
  assert.equal(ledger.consumed(scope, "token"), 250);
});

test("CONCURRENT sibling tasks accumulate against ONE revision allowance", (t) => {
  const ledger = tempLedger(t);
  const limits = { maxTokens: 1000 };
  let exhausted = 0;
  for (let i = 0; i < 6; i += 1) {
    const report = usageReportFrom({
      workerId: "hermes",
      itemId: `w${i}`,
      attempt: 1,
      cost: { tokensIn: 300, tokensOut: 0 },
      capability: TOKEN_USAGE_CAPABILITY,
    });
    const outcome = debitUsage(ledger, scope, report, limits);
    if (outcome.exhausted !== undefined) exhausted += 1;
  }
  assert.equal(ledger.consumed(scope, "token"), 900, "three siblings fit, the fourth would exceed");
  assert.equal(exhausted, 3, "the rest were refused, and the refusal is explicit");
});

test("EXHAUSTION is reported with the exact reason, and stops the loop", (t) => {
  const ledger = tempLedger(t);
  const report = usageReportFrom({
    workerId: "hermes",
    itemId: "w1",
    attempt: 1,
    cost: { tokensIn: 5000, tokensOut: 0 },
    capability: TOKEN_USAGE_CAPABILITY,
  });
  const outcome = debitUsage(ledger, scope, report, { maxTokens: 100 });
  assert.deepEqual(outcome.debited, [], "nothing was debited");
  assert.ok(outcome.exhausted !== undefined, "the ceiling was reported");
  assert.equal(outcome.exhausted?.kind, "token");
  assert.match(String(outcome.exhausted?.reason), /budget exhausted: token would reach 5000 of 100/);
  assert.match(String(outcome.exhausted?.reason), /never silently restored/);
  assert.equal(ledger.consumed(scope, "token"), 0, "a refused reservation leaves nothing behind");
  t.diagnostic(String(outcome.exhausted?.reason));
});

test("dispatch after exhaustion is still refused by the same ledger", (t) => {
  const ledger = tempLedger(t);
  // Spend the token allowance, then confirm the SAME scope refuses more.
  debitUsage(
    ledger,
    scope,
    usageReportFrom({ workerId: "hermes", itemId: "w1", attempt: 1, cost: { tokensIn: 1000, tokensOut: 0 }, capability: TOKEN_USAGE_CAPABILITY }),
    { maxTokens: 1000 },
  );
  const after = debitUsage(
    ledger,
    scope,
    usageReportFrom({ workerId: "hermes", itemId: "w2", attempt: 1, cost: { tokensIn: 1, tokensOut: 0 }, capability: TOKEN_USAGE_CAPABILITY }),
    { maxTokens: 1000 },
  );
  assert.ok(after.exhausted !== undefined, "the allowance is spent and cannot be re-entered");
  assert.equal(ledger.consumed(scope, "token"), 1000);
});

test("a worker CRASH reports no usage, and that is recorded honestly", (t) => {
  // The run failed before reporting anything: the adapter's capability is real,
  // but the value is not. It must read as unavailable, not as a free run.
  const report = usageReportFrom({ workerId: "hermes", itemId: "w1", attempt: 1, capability: TOKEN_USAGE_CAPABILITY });
  assert.equal(report.inputTokens.provenance, "unavailable");
  assert.equal(report.outputTokens.provenance, "unavailable");
  const enforceability = enforceabilityOf({ maxTokens: 1000 }, {
    inputTokens: report.inputTokens.provenance === "measured",
    outputTokens: report.outputTokens.provenance === "measured",
    toolCalls: false,
    costUsd: false,
  });
  assert.equal(enforceability.maxTokens, "unenforceable", "a crashed run cannot be held to a token ceiling");
  t.diagnostic(enforceability.unenforceable.map((u) => u.reason).join(" | "));
});

test("the user-facing line names what is NOT enforced", (t) => {
  const report = usageReportFrom({
    workerId: "hermes",
    itemId: "w1",
    attempt: 1,
    cost: { tokensIn: 10, tokensOut: 5 },
    capability: TOKEN_USAGE_CAPABILITY,
  });
  const line = describeEnforcement(report, { maxToolCalls: 5, maxCostUsd: 1 });
  assert.match(line, /measured usage: in 10, out 5/);
  assert.match(line, /NOT enforced: maxToolCalls/);
  assert.match(line, /maxCostUsd/);
  t.diagnostic(line);

  // With nothing to enforce, the line does not cry wolf.
  assert.doesNotMatch(describeEnforcement(report, {}), /NOT enforced/);
});
