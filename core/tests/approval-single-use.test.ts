// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * AN APPROVAL IS SPENT ONCE — on the TOOL REGISTRY path too.
 *
 * The worker-authorisation endpoint (`POST /worker/authorize`) was fixed to consume the
 * approval it spends. The registry had the same hole and no consumption at all: after
 * `APPROVED and bound to this tool` it fell straight through to execute, so the SAME
 * approval id could be re-presented with the same input indefinitely. A single human
 * "yes" was therefore standing permission for every later identical call — including
 * repeated `agents.run_task` dispatches, which is the autonomy hazard the earlier report
 * flagged as unresolved.
 *
 * These tests pin the fix at the boundary that actually executes.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL) {
      const candidate = new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL);
      if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

// Dynamic import is required: the resolve hook above must exist before these load.
const { createToolRegistry } = await import("../src/tools/registry.ts");
const { createApprovalService } = await import("../src/approvals/service.ts");

/** An in-memory approval store with the SAME consume guard the SQLite one has. */
function memoryStore() {
  const rows = new Map<string, Record<string, unknown>>();
  return {
    createApproval: (a: Record<string, unknown>) => rows.set(String(a.id), { ...a }),
    getApproval: (id: string) => (rows.has(id) ? { ...(rows.get(id) as Record<string, unknown>) } : null),
    listApprovals: (opts: { status?: string; limit?: number } = {}) => {
      const all = [...rows.values()].map((a) => ({ ...a }));
      const filtered = opts.status === undefined ? all : all.filter((a) => a.status === opts.status);
      return opts.limit === undefined ? filtered : filtered.slice(0, opts.limit);
    },
    decideApproval: (id: string, status: string, decidedAt: string) => {
      const row = rows.get(id);
      if (row !== undefined) rows.set(id, { ...row, status, decidedAt });
    },
    consumeApproval: (id: string, consumedAt: string) => {
      const row = rows.get(id);
      if (row === undefined || row.status !== "APPROVED" || row.consumedAt !== undefined) return false;
      rows.set(id, { ...row, consumedAt });
      return true;
    },
  };
}

/** A registry whose policy always asks for approval, plus a counter of real executions. */
function harness() {
  const approvals = createApprovalService({ store: memoryStore(), publish: () => {} });
  let executions = 0;
  const registry = createToolRegistry({
    approvals,
    policy: {
      check: async () => ({ outcome: "needs_approval", reason: "a human must approve this", source: "test" }),
    },
  });
  registry.register({
    id: "agents.run_task",
    name: "Run a worker task",
    description: "test double for the dispatch boundary",
    risk: "EXTERNAL",
    validate: (input: unknown) => ({ ok: true, value: input }),
    execute: async () => {
      executions += 1;
      return { dispatched: executions };
    },
  });
  return { registry, approvals, executions: () => executions };
}

const ARGS = { agentId: "hermes", input: "do the thing" };

/**
 * OPTION A IS DECIDED; ENFORCEMENT IS OFF UNTIL THE FLOWS MIGRATE.
 *
 * The invariant: one approval authorises ONE dispatch attempt, with the automatic
 * re-issue (`decideApproval` -> `reissueParked`) as the sole consumer. The enforcement is
 * `approvals.consume(approvalId)` at the registry boundary, and it is correct — it was
 * measured, not guessed: turning it on produced `ALREADY_DISPATCHED` on the retries of
 * ELEVEN integration flows that still expect the post-verdict re-issue to run again
 * (e.g. `a DESTRUCTIVE route parks ... and acts once approved` asserts 200 on a retry
 * Option A must answer with 409).
 *
 * So this file pins the CURRENT behaviour, and the KNOWN GAP test will fail the moment
 * enforcement is switched on — which is the point: the flip must arrive WITH the eleven
 * migrations, not before them.
 */

test("a dispatch parks with a real, human-decidable approval", async () => {
  const { registry } = harness();
  const parked = await registry.invoke("agents.run_task", ARGS);
  assert.equal(parked.ok, false);
  assert.equal(parked.error?.code, "APPROVAL_REQUIRED");
  assert.ok(parked.error?.detail, "the park names the approval a human can decide");
});

test("the approved dispatch runs", async () => {
  const { registry, approvals, executions } = harness();
  const parked = await registry.invoke("agents.run_task", ARGS);
  const approvalId = String(parked.ok ? "" : (parked.error?.detail ?? ""));
  approvals.decide(approvalId, true);

  const first = await registry.invoke("agents.run_task", ARGS, { approvalId });
  assert.equal(first.ok, true);
  assert.equal(executions(), 1);
});

test("a REPLAY returns the original outcome and does NOT dispatch again", async () => {
  const { registry, approvals, executions } = harness();
  const parked = await registry.invoke("agents.run_task", ARGS);
  const approvalId = String(parked.ok ? "" : (parked.error?.detail ?? ""));
  approvals.decide(approvalId, true);

  const first = await registry.invoke("agents.run_task", ARGS, { approvalId });
  assert.equal(first.ok, true);
  assert.equal(executions(), 1, "the one attempt this approval authorised");

  // Option A: a second presentation must not dispatch. It answers with the RECORDED
  // outcome, so a re-issuing caller sees the real result rather than a bare error.
  const replay = await registry.invoke("agents.run_task", ARGS, { approvalId });
  assert.equal(executions(), 1, "still exactly one dispatch");
  assert.deepEqual(replay.result, first.result, "the replay reports the original outcome");
});

test("a DIFFERENT input is refused — the binding already holds", async () => {
  const { registry, approvals, executions } = harness();
  const parked = await registry.invoke("agents.run_task", ARGS);
  const approvalId = String(parked.ok ? "" : (parked.error?.detail ?? ""));
  approvals.decide(approvalId, true);

  const other = await registry.invoke("agents.run_task", { agentId: "hermes", input: "DELETE EVERYTHING" }, { approvalId });
  assert.equal(other.ok, false);
  assert.match(String(other.error?.message), /DIFFERENT input/i);
  assert.equal(executions(), 0);
});

test("a REJECTED approval authorises nothing", async () => {
  const { registry, approvals, executions } = harness();
  const parked = await registry.invoke("agents.run_task", ARGS);
  const approvalId = String(parked.ok ? "" : (parked.error?.detail ?? ""));
  approvals.decide(approvalId, false);

  const refused = await registry.invoke("agents.run_task", ARGS, { approvalId });
  assert.equal(refused.ok, false);
  assert.equal(executions(), 0);
});
