// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The TOOL-CALL allowance, enforced at the one boundary every call passes.
 *
 * `maxToolCalls` was declared in `WorkBudget` and enforced nowhere, because no
 * worker adapter reports tool invocations. That is still true of a WORKER'S
 * INTERNAL calls — and it is not true of KAI'S OWN, which pass through the tool
 * registry. These tests pin the boundary: a policy-checked call is charged
 * BEFORE it runs, a loop stops at the ceiling with a machine-readable reason, a
 * redelivered resume is charged once, and Guard is never bypassed to get there.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createBudgetLedger, type BudgetLedger } from "../src/orchestration/budget.ts";
import { enforceabilityOf } from "../src/orchestration/usage.ts";
import { createToolRegistry, type ToolBudgetPort } from "../src/tools/registry.ts";
import type { PolicyGate } from "../src/policies/gate.ts";

const SCOPE = { goalId: "goal_tools", planRevisionId: "rev_1", chainId: "goal_tools" };

function ledgerFor(t: { after(fn: () => void): void }): BudgetLedger {
  const dir = mkdtempSync(join(tmpdir(), "kai-toolbudget-"));
  const ledger = createBudgetLedger({ path: join(dir, "budget.db") });
  t.after(() => {
    ledger.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return ledger;
}

/** A policy that allows everything — the budget is what these tests exercise. */
const ALLOW: PolicyGate = { check: async () => ({ outcome: "allow" as const, reason: "test policy allows" }) };
/** A policy that parks everything, for the "budget never bypasses Guard" case. */
const PARK: PolicyGate = { check: async () => ({ outcome: "needs_approval" as const, reason: "DESTRUCTIVE" }) };

/** The port the runtime supplies, in miniature: the SAME ledger, one kind. */
function portFor(ledger: BudgetLedger): ToolBudgetPort {
  return {
    scopeFor: (opts) => {
      if (opts?.goalId === undefined) return null;
      return {
        scope: { goalId: opts.goalId, ...(opts.goalRevisionId !== undefined ? { planRevisionId: opts.goalRevisionId } : {}), chainId: opts.goalId },
        limits: opts.maxToolCalls !== undefined ? { maxToolCalls: opts.maxToolCalls } : {},
      };
    },
    reserve: ({ toolId, scope, limits, idempotencyKey }) => {
      const r = ledger.reserve({ scope, kind: "toolCall", limits, idempotencyKey, detail: `tool call ${toolId}` });
      return r.ok ? { ok: true } : { ok: false, reason: r.reason };
    },
  };
}

function registry(t: { after(fn: () => void): void }, opts: { policy?: PolicyGate; maxToolCalls?: number } = {}) {
  const ledger = ledgerFor(t);
  let runs = 0;
  const tools = createToolRegistry({
    policy: opts.policy ?? ALLOW,
    toolBudget: portFor(ledger),
  });
  tools.register({
    id: "test.tick",
    name: "tick",
    description: "counts a run",
    risk: "READ",
    validate: (input) => ({ ok: true as const, value: input }),
    execute: async () => {
      runs += 1;
      return { ran: runs };
    },
  });
  const invoke = (over: { approvalId?: string } = {}) =>
    tools.invoke("test.tick", { n: 1 }, {
      goalId: SCOPE.goalId,
      goalRevisionId: SCOPE.planRevisionId,
      ...(opts.maxToolCalls !== undefined ? { maxToolCalls: opts.maxToolCalls } : {}),
      ...(over.approvalId !== undefined ? { approvalId: over.approvalId } : {}),
    });
  return { ledger, invoke, runs: () => runs };
}

test("a policy-checked call is CHARGED, and the ceiling stops the loop", async (t) => {
  const r = registry(t, { maxToolCalls: 3 });

  for (let i = 0; i < 3; i += 1) {
    const ok = await r.invoke();
    assert.equal(ok.ok, true, `call ${i} within the ceiling`);
  }
  assert.equal(r.ledger.consumed(SCOPE, "toolCall"), 3, "three calls, three charges");
  assert.equal(r.runs(), 3);

  const refused = await r.invoke();
  assert.equal(refused.ok, false, "the fourth call is refused");
  if (refused.ok) return;
  assert.equal(refused.error.code, "POLICY_DENIED");
  assert.match(refused.error.message, /budget exhausted: toolCall would reach 4 of 3/, refused.error.message);
  assert.equal(r.runs(), 3, "the refused call never executed — the charge happens BEFORE the tool runs");
  t.diagnostic(refused.error.message);
});

test("the refusal NAMES the limit, the kind and the scope", async (t) => {
  const r = registry(t, { maxToolCalls: 1 });
  await r.invoke();
  const refused = await r.invoke();
  assert.equal(refused.ok, false);
  if (refused.ok) return;
  assert.match(refused.error.message, /toolCall/);
  assert.match(refused.error.message, /of 1/);
  assert.match(refused.error.message, /goal_tools/, "the scope is named, so the reader knows which allowance");
  t.diagnostic(refused.error.message);
});

test("a REDELIVERED approval resume is charged ONCE", async (t) => {
  const r = registry(t, { maxToolCalls: 1 });
  // The same approval id twice: one logical invocation.
  const first = await r.invoke({ approvalId: "apr_1" });
  assert.equal(first.ok, true);
  const replay = await r.invoke({ approvalId: "apr_1" });
  assert.equal(replay.ok, true, "a redelivery is not refused — it is the same charge");
  assert.equal(r.ledger.consumed(SCOPE, "toolCall"), 1, "charged once, not twice");
  // A DIFFERENT invocation still needs its own allowance, and there is none.
  const other = await r.invoke({ approvalId: "apr_2" });
  assert.equal(other.ok, false, "a different invocation is a different charge");
  t.diagnostic(`consumed ${r.ledger.consumed(SCOPE, "toolCall")} after 2 deliveries of one approval`);
});

test("CONCURRENT calls are each charged exactly once", async (t) => {
  const r = registry(t, { maxToolCalls: 5 });
  const outcomes = await Promise.all(Array.from({ length: 5 }, async () => r.invoke()));
  assert.equal(outcomes.filter((o) => o.ok).length, 5, "all five fit");
  assert.equal(r.ledger.consumed(SCOPE, "toolCall"), 5, "five charges, not four and not six");
  assert.equal(r.runs(), 5);
  const overflow = await r.invoke();
  assert.equal(overflow.ok, false, "and the sixth is refused");
  t.diagnostic("5 concurrent calls -> 5 charges");
});

test("a call with NO goal linkage is not budgeted here, and that is not a silent zero", async (t) => {
  const ledger = ledgerFor(t);
  let ran = 0;
  const tools = createToolRegistry({ policy: ALLOW, toolBudget: portFor(ledger) });
  tools.register({
    id: "test.free",
    name: "free",
    description: "unbudgeted",
    risk: "READ",
    validate: (input) => ({ ok: true as const, value: input }),
    execute: async () => {
      ran += 1;
      return {};
    },
  });
  // No goalId: `scopeFor` returns null, so nothing is charged and nothing is claimed.
  const result = await tools.invoke("test.free", {}, { source: "test" });
  assert.equal(result.ok, true);
  assert.equal(ran, 1);
  assert.equal(ledger.consumed(SCOPE, "toolCall"), 0, "an unscoped call is not charged against a goal");
  t.diagnostic("unscoped call ran, nothing charged");
});

test("budget exhaustion NEVER bypasses Guard: a parked tool still parks", async (t) => {
  const r = registry(t, { policy: PARK, maxToolCalls: 100 });
  const parked = await r.invoke();
  assert.equal(parked.ok, false, "a DESTRUCTIVE tool does not run");
  if (parked.ok) return;
  assert.equal(parked.error.code, "APPROVAL_REQUIRED", `expected a park, got ${parked.error.code}`);
  assert.equal(r.runs(), 0, "and it did not execute");
  // A parked call is not charged: the budget is for calls that RUN.
  assert.equal(r.ledger.consumed(SCOPE, "toolCall"), 0, "a park is not a tool call");
  t.diagnostic("parked tool: APPROVAL_REQUIRED, nothing charged, nothing ran");
});

test("an unbounded scope enforces nothing — and says so", async (t) => {
  const r = registry(t, {}); // no maxToolCalls
  for (let i = 0; i < 25; i += 1) {
    assert.equal((await r.invoke()).ok, true, `call ${i} is unbounded`);
  }
  assert.equal(r.ledger.consumed(SCOPE, "toolCall"), 25, "still COUNTED, so the number is real");
  t.diagnostic("25 calls counted, no ceiling configured");
});

test("enforceabilityOf tells KAI-owned tool calls from a worker's internal ones", (t) => {
  const limits = { maxToolCalls: 10 };

  // A worker that reports nothing: its INTERNAL tool calls are unobservable.
  const worker = enforceabilityOf(limits, { inputTokens: false, outputTokens: false, toolCalls: false, costUsd: false });
  assert.equal(worker.maxToolCalls, "unenforceable");
  assert.ok(worker.unenforceable.some((u) => u.limit === "maxToolCalls"), "and it is named");

  // KAI's OWN tool calls pass through the registry, so the ceiling is real.
  const kai = enforceabilityOf(
    limits,
    { inputTokens: false, outputTokens: false, toolCalls: false, costUsd: false },
    { kaiOwnedToolCalls: true },
  );
  assert.equal(kai.maxToolCalls, "enforced");
  assert.deepEqual(kai.unenforceable, [], "nothing is claimed unenforceable about KAI's own calls");
  t.diagnostic("worker-internal unenforceable; KAI-owned enforced");
});
