// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The authoritative execution budget, attacked.
 *
 * The defect this pins was real: the retry budget was enforced PER WORK ITEM,
 * from that item's own dispatch ledger. A corrective child — or any caller that
 * created a NEW item for the same goal revision — arrived with a fresh
 * allowance, so one goal could spend unbounded attempts while every individual
 * item stayed inside its own limit. `maxDepth` did not close it either: ten
 * children of one parent are all depth 1.
 *
 * Every test below is an attempt to get budget back that was already spent.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { budgetScopeKey, createBudgetLedger, type BudgetLedger } from "../src/orchestration/budget.ts";

function tempLedger(t: { after(fn: () => void): void }): { ledger: BudgetLedger; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "kai-budget-"));
  const path = join(dir, "budget-ledger.db");
  const ledger = createBudgetLedger({ path });
  t.after(() => {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { ledger, path };
}

const goalScope = (chainId: string, revision = "rev_1") => ({ goalId: "goal_a", planRevisionId: revision, chainId });

test("the ceiling refuses, and the refusal is exact", (t) => {
  const { ledger } = tempLedger(t);
  const limits = { maxDispatches: 2 };
  assert.equal(ledger.reserve({ scope: goalScope("root"), kind: "dispatch", limits, idempotencyKey: "a1" }).ok, true);
  assert.equal(ledger.reserve({ scope: goalScope("root"), kind: "dispatch", limits, idempotencyKey: "a2" }).ok, true);
  const third = ledger.reserve({ scope: goalScope("root"), kind: "dispatch", limits, idempotencyKey: "a3" });
  assert.equal(third.ok, false);
  if (third.ok) return;
  assert.equal(third.consumed, 2);
  assert.equal(third.limit, 2);
  assert.match(third.reason, /budget exhausted: dispatch would reach 3 of 2/);
  assert.match(third.reason, /never silently restored/, "the refusal says why it will not be restored");
  t.diagnostic(third.reason);
});

test("THE HOLE: a NEW item for the same goal revision does NOT mint a fresh allowance", (t) => {
  const { ledger } = tempLedger(t);
  // The approved plan: 2 tasks, 1 retry each → 4 dispatches for the revision.
  const limits = { maxDispatches: 2 * (1 + 1) };
  let spent = 0;
  let refused = 0;
  // A caller loops, each time through a DIFFERENT item (so a different chain
  // root) — the shape that defeated the per-item ledger.
  for (let i = 0; i < 20; i += 1) {
    const outcome = ledger.reserve({
      scope: goalScope(`chain_of_item_${i}`),
      kind: "dispatch",
      limits,
      idempotencyKey: `item_${i}:attempt:1`,
      itemId: `item_${i}`,
    });
    if (outcome.ok) spent += 1;
    else refused += 1;
  }
  assert.equal(spent, 4, "exactly the revision's allowance was spendable, across 20 different items");
  assert.equal(refused, 16, "the other 16 were refused — a new item cannot mint budget");
  assert.equal(ledger.consumed(goalScope("anything"), "dispatch"), 4);
});

test("the chain is recorded for audit but does NOT widen the allowance", (t) => {
  const { ledger } = tempLedger(t);
  const limits = { maxDispatches: 1 };
  const a = ledger.reserve({ scope: goalScope("chain_a"), kind: "dispatch", limits, idempotencyKey: "k1" });
  assert.equal(a.ok, true);
  const b = ledger.reserve({ scope: goalScope("chain_b"), kind: "dispatch", limits, idempotencyKey: "k2" });
  assert.equal(b.ok, false, "a sibling chain shares the revision's allowance");
  // Both rows carry their own chain, so the audit can say which chain spent what.
  const rows = ledger.listByScope(goalScope("chain_a"));
  assert.equal(rows[0]?.chainId, "chain_a");
  assert.equal(budgetScopeKey(goalScope("chain_b")), budgetScopeKey(goalScope("chain_a")), "same enforcement key");
});

test("a redelivered event takes NO second debit", (t) => {
  const { ledger } = tempLedger(t);
  const limits = { maxDispatches: 1 };
  const first = ledger.reserve({ scope: goalScope("root"), kind: "dispatch", limits, idempotencyKey: "event_77" });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  // The same event, delivered again.
  const again = ledger.reserve({ scope: goalScope("root"), kind: "dispatch", limits, idempotencyKey: "event_77" });
  assert.equal(again.ok, true, "a duplicate is not a refusal");
  if (!again.ok) return;
  assert.equal(again.duplicate, true);
  assert.equal(again.reservation.id, first.reservation.id, "the SAME reservation, not a new one");
  assert.equal(ledger.consumed(goalScope("root"), "dispatch"), 1, "one debit for one event delivered twice");
});

test("a genuinely new call with no event id DOES debit", (t) => {
  const { ledger } = tempLedger(t);
  const limits = { maxDispatches: 3 };
  for (const key of ["run:1", "run:2", "run:3"]) {
    assert.equal(ledger.reserve({ scope: goalScope("root"), kind: "dispatch", limits, idempotencyKey: key }).ok, true);
  }
  assert.equal(ledger.reserve({ scope: goalScope("root"), kind: "dispatch", limits, idempotencyKey: "run:4" }).ok, false);
});

test("a release only rewinds an operation that provably never ran", (t) => {
  const { ledger } = tempLedger(t);
  const limits = { maxDispatches: 1 };
  const r = ledger.reserve({ scope: goalScope("root"), kind: "dispatch", limits, idempotencyKey: "k1" });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(ledger.release(r.reservation.id, "policy denied before any effect"), true);
  assert.equal(ledger.consumed(goalScope("root"), "dispatch"), 0, "the budget came back");
  assert.equal(
    ledger.reserve({ scope: goalScope("root"), kind: "dispatch", limits, idempotencyKey: "k2" }).ok,
    true,
    "so the allowance is spendable again",
  );

  // But a SETTLED reservation is spent forever: releasing it would restore
  // budget for work that already ran — the exact bug this module prevents.
  const s = ledger.reserve({ scope: goalScope("root"), kind: "dispatch", limits, idempotencyKey: "k3" });
  assert.equal(s.ok, false, "the allowance is now spent");
  const other = { goalId: "goal_b", planRevisionId: "rev_1", chainId: "root" };
  const first = ledger.reserve({ scope: other, kind: "dispatch", limits, idempotencyKey: "k4" });
  assert.equal(first.ok, true, "a DIFFERENT goal has its own allowance");
  if (!first.ok) return;
  assert.equal(ledger.settle(first.reservation.id, 1, "dispatched for real"), true);
  assert.equal(ledger.release(first.reservation.id, "trying to get it back"), false, "a settle cannot be rewound");
  assert.equal(ledger.consumed(other, "dispatch"), 1, "and it stays debited");
});

test("a reservation abandoned by a dead process STAYS debited", (t) => {
  const { ledger, path } = tempLedger(t);
  const limits = { maxDispatches: 2 };
  assert.equal(ledger.reserve({ scope: goalScope("root"), kind: "dispatch", limits, idempotencyKey: "k1" }).ok, true);

  // The process dies. A new one opens the SAME file with a new owner id.
  const successor = createBudgetLedger({ path, ownerId: "core_successor" });
  const abandoned = successor.reconcileOpen(["core_successor"]);
  assert.equal(abandoned.length, 1);
  assert.equal(abandoned[0]?.state, "ABANDONED");
  assert.match(String(abandoned[0]?.detail), /stays debited because the operation may have had side effects/);
  assert.equal(successor.consumed(goalScope("root"), "dispatch"), 1, "the amount was NOT restored");
  assert.equal(
    successor.reserve({ scope: goalScope("root"), kind: "dispatch", limits, idempotencyKey: "k2" }).ok,
    true,
    "one attempt remained",
  );
  assert.equal(
    successor.reserve({ scope: goalScope("root"), kind: "dispatch", limits, idempotencyKey: "k3" }).ok,
    false,
    "and the ceiling still binds after the restart",
  );
  successor.close();
  t.diagnostic(abandoned[0]?.detail ?? "");
});

test("budget is durable: a restart cannot restore what was spent", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kai-budget-restart-"));
  const path = join(dir, "budget-ledger.db");
  const limits = { maxDispatches: 2 };
  const first = createBudgetLedger({ path });
  const opened = first.reserve({ scope: goalScope("root"), kind: "dispatch", limits, idempotencyKey: "k1" });
  assert.equal(opened.ok, true);
  if (opened.ok) assert.equal(first.settle(opened.reservation.id, 1), true, "settled for real");
  first.close();

  const second = createBudgetLedger({ path });
  t.after(() => {
    second.close();
    rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(second.consumed(goalScope("root"), "dispatch"), 1, "the spend survived the restart");
  assert.equal(second.reserve({ scope: goalScope("root"), kind: "dispatch", limits, idempotencyKey: "k2" }).ok, true);
  assert.equal(second.reserve({ scope: goalScope("root"), kind: "dispatch", limits, idempotencyKey: "k3" }).ok, false);
});

test("a new plan revision is a deliberate new allowance", (t) => {
  const { ledger } = tempLedger(t);
  const limits = { maxDispatches: 1 };
  assert.equal(ledger.reserve({ scope: goalScope("root", "rev_1"), kind: "dispatch", limits, idempotencyKey: "k1" }).ok, true);
  assert.equal(ledger.reserve({ scope: goalScope("root", "rev_1"), kind: "dispatch", limits, idempotencyKey: "k2" }).ok, false);
  // A replan produces rev_2, which the user approved. That is a NEW allowance —
  // and it is the only way to get one.
  assert.equal(
    ledger.reserve({ scope: goalScope("root", "rev_2"), kind: "dispatch", limits, idempotencyKey: "k3" }).ok,
    true,
    "an approved replan is the sanctioned way to raise the ceiling",
  );
  assert.equal(ledger.consumed(goalScope("root", "rev_1"), "dispatch"), 1);
  assert.equal(ledger.consumed(goalScope("root", "rev_2"), "dispatch"), 1);
});

test("kinds are ceilinged and summed independently", (t) => {
  const { ledger } = tempLedger(t);
  const limits = { maxDispatches: 5, maxModelCalls: 1, maxToolCalls: 2 };
  assert.equal(ledger.reserve({ scope: goalScope("root"), kind: "dispatch", limits, idempotencyKey: "d1" }).ok, true);
  assert.equal(ledger.reserve({ scope: goalScope("root"), kind: "modelCall", limits, idempotencyKey: "m1" }).ok, true);
  assert.equal(ledger.reserve({ scope: goalScope("root"), kind: "modelCall", limits, idempotencyKey: "m2" }).ok, false);
  assert.equal(ledger.reserve({ scope: goalScope("root"), kind: "toolCall", limits, idempotencyKey: "t1" }).ok, true);
  assert.equal(ledger.reserve({ scope: goalScope("root"), kind: "toolCall", limits, idempotencyKey: "t2" }).ok, true);
  assert.equal(ledger.reserve({ scope: goalScope("root"), kind: "toolCall", limits, idempotencyKey: "t3" }).ok, false);
  const all = ledger.consumedAll(goalScope("root"));
  assert.equal(all.dispatch, 1);
  assert.equal(all.modelCall, 1);
  assert.equal(all.toolCall, 2);
  assert.equal(all.replan, 0, "an unspent kind is reported as zero, not omitted");
});

test("maxRuntimeMs is reachable, not a dead field", (t) => {
  const { ledger } = tempLedger(t);
  const limits = { maxRuntimeMs: 1000 };
  assert.equal(
    ledger.reserve({ scope: goalScope("root"), kind: "runtime", limits, amount: 600, idempotencyKey: "r1" }).ok,
    true,
  );
  const over = ledger.reserve({ scope: goalScope("root"), kind: "runtime", limits, amount: 600, idempotencyKey: "r2" });
  assert.equal(over.ok, false, "1200ms does not fit in a 1000ms ceiling");
  if (over.ok) return;
  assert.equal(over.limit, 1000);
  t.diagnostic(over.reason);
});

test("an unbounded kind is unbounded, and says so with Infinity", (t) => {
  const { ledger } = tempLedger(t);
  const r = ledger.reserve({ scope: goalScope("root"), kind: "dispatch", limits: {}, idempotencyKey: "k1" });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.limit, Number.POSITIVE_INFINITY, "no ceiling configured means no ceiling, stated explicitly");
});

test("a fractional cost accumulates against its own ceiling", (t) => {
  const { ledger } = tempLedger(t);
  const limits = { maxCostUsd: 1 };
  // 0.25 is exact in binary, so the sum is deterministic.
  for (let i = 0; i < 4; i += 1) {
    assert.equal(
      ledger.reserve({ scope: goalScope("root"), kind: "cost", limits, amount: 0.25, idempotencyKey: `c${i}` }).ok,
      true,
      `call ${i} within a $1 budget`,
    );
  }
  assert.equal(ledger.consumed(goalScope("root"), "cost"), 1, "four quarters is exactly one dollar");
  assert.equal(
    ledger.reserve({ scope: goalScope("root"), kind: "cost", limits, amount: 0.25, idempotencyKey: "c5" }).ok,
    false,
    "and the fifth quarter is refused",
  );
  // Cost is a KIND, so it has its own ceiling and does not consume dispatch.
  assert.equal(ledger.consumed(goalScope("root"), "dispatch"), 0, "a dollar of model spend is not a dispatch");
});
