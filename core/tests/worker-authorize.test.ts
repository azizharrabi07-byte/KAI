// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * POST /worker/authorize — the per-action authorization boundary.
 *
 * These tests pin the properties that make the endpoint an AUTHORITY rather than a
 * suggestion. They run the real decision function against a stub runtime, so no server,
 * no socket and no policy file is needed, and each property is asserted directly.
 *
 * The load-bearing ones:
 *   • risk comes from the REGISTRY, never from the caller (a worker cannot self-declare READ)
 *   • an unknown tool is denied, not assumed safe
 *   • the decision is bound to the exact arguments, so an approval cannot be replayed
 *   • a policy error is never a grant
 *   • nothing returns `allow` without a policy decision behind it
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

// Dynamic import is REQUIRED here, not a preference: `registerHooks` above must be
// installed before these modules are loaded, or their ".js" specifiers do not resolve
// to the TypeScript sources under Node's type stripping. A static import would be
// hoisted and evaluated before the hook exists.
const { authorizeWorkerAction, authorizationBinding, canonicalJson } = await import(
  "../src/api/worker-authorize.ts"
);
const { createApprovalService } = await import("../src/approvals/service.ts");

/**
 * The REAL approval service over an in-memory store.
 *
 * A hand-written fake would let the tests pass while the store's own guarantees were
 * broken; this exercises the same `consume` guard production uses (only an APPROVED,
 * unspent row can be spent), which is the property that makes a replay impossible.
 */
function memoryApprovals() {
  const rows = new Map();
  let next = 0;
  const store = {
    createApproval: (a) => rows.set(a.id, { ...a }),
    getApproval: (id) => (rows.has(id) ? { ...rows.get(id) } : null),
    listApprovals: (opts = {}) => {
      const all = [...rows.values()].map((a) => ({ ...a }));
      const filtered = opts.status === undefined ? all : all.filter((a) => a.status === opts.status);
      return opts.limit === undefined ? filtered : filtered.slice(0, opts.limit);
    },
    decideApproval: (id, status, decidedAt) => {
      const row = rows.get(id);
      if (row !== undefined) rows.set(id, { ...row, status, decidedAt });
    },
    consumeApproval: (id, consumedAt) => {
      const row = rows.get(id);
      if (row === undefined || row.status !== "APPROVED" || row.consumedAt !== undefined) return false;
      rows.set(id, { ...row, consumedAt });
      return true;
    },
  };
  return createApprovalService({
    store,
    publish: () => {},
    idFactory: () => `apr_stub_${(next += 1)}`,
  });
}

/** A stub runtime exposing only what the endpoint is allowed to use. */
function stubRuntime({ tools = {}, check, approvals } = {}) {
  return {
    tools: {
      get: (id) => tools[id],
    },
    policy: {
      check: check || (async () => ({ outcome: "allow", reason: "default allow", source: "default" })),
    },
    approvals: approvals ?? memoryApprovals(),
  };
}

const READ_TOOL = { id: "filesystem.read", name: "Read a file", risk: "READ" };
const DESTRUCTIVE_TOOL = { id: "shell.run", name: "Run a program", risk: "DESTRUCTIVE" };

// ── Validation: every malformed input denies ─────────────────────────────────────
test("a request with no toolId is denied, and says so", async () => {
  const d = await authorizeWorkerAction(stubRuntime({}), { args: {} });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /names no toolId/);
});

test("a non-object args is rejected as unbindable", async () => {
  for (const bad of ["a string", 42, [1, 2], true]) {
    const d = await authorizeWorkerAction(stubRuntime({ tools: { "shell.run": DESTRUCTIVE_TOOL } }), {
      toolId: "shell.run",
      args: bad,
    });
    assert.equal(d.decision, "deny", `args ${JSON.stringify(bad)} must be refused`);
    assert.match(d.reason, /must be an object or omitted/);
  }
});

test("an unknown tool is denied rather than assumed safe", async () => {
  const d = await authorizeWorkerAction(stubRuntime({ tools: {} }), { toolId: "not.a.tool", args: {} });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /is not a tool this Core registers/);
});

// ── THE property: the registry owns the risk, not the caller ─────────────────────
test("the risk used for the decision comes from the registry, never from the request", async () => {
  let seen = null;
  const runtime = stubRuntime({
    tools: { "shell.run": DESTRUCTIVE_TOOL },
    check: async (request) => {
      seen = request;
      return { outcome: "needs_approval", reason: "destructive actions need a human", source: "default", approvalId: "ap-1" };
    },
  });

  // The caller claims READ. The registry says DESTRUCTIVE. The registry must win.
  const d = await authorizeWorkerAction(runtime, {
    toolId: "shell.run",
    args: { cmd: "rm -rf build" },
    risk: "READ",
    action: "harmless",
  });

  assert.equal(seen.risk, "DESTRUCTIVE", "a self-declared low risk must not reach policy");
  assert.equal(seen.action, "Run a program");
  assert.equal(d.decision, "needs_approval");
  assert.equal(d.risk, "DESTRUCTIVE");
  assert.equal(d.approvalId, "ap-1");
});

// ── Binding: an approval is valid for ONE command ────────────────────────────────
test("the binding is stable across key order but changes with the arguments", async () => {
  const a = authorizationBinding("shell.run", { cmd: "ls", dir: "/tmp" });
  const b = authorizationBinding("shell.run", { dir: "/tmp", cmd: "ls" });
  const c = authorizationBinding("shell.run", { cmd: "rm", dir: "/tmp" });
  const d = authorizationBinding("other.tool", { cmd: "ls", dir: "/tmp" });

  assert.equal(a, b, "key order must not change the binding");
  assert.notEqual(a, c, "different arguments must not share an approval");
  assert.notEqual(a, d, "a different tool must not share an approval");
});

test("the decision carries the binding for the exact declared command", async () => {
  const runtime = stubRuntime({ tools: { "shell.run": DESTRUCTIVE_TOOL } });
  const d = await authorizeWorkerAction(runtime, { toolId: "shell.run", args: { cmd: "ls" } });
  assert.equal(d.binding, authorizationBinding("shell.run", { cmd: "ls" }));
});

test("canonicalJson sorts nested keys so structurally equal args hash alike", () => {
  assert.equal(canonicalJson({ b: { d: 1, c: 2 }, a: 0 }), canonicalJson({ a: 0, b: { c: 2, d: 1 } }));
  assert.equal(canonicalJson({ a: [1, { z: 1, y: 2 }] }), '{"a":[1,{"y":2,"z":1}]}');
});

// ── Failure is never a grant ────────────────────────────────────────────────────
test("a policy error denies rather than allowing", async () => {
  const runtime = stubRuntime({
    tools: { "shell.run": DESTRUCTIVE_TOOL },
    check: async () => { throw new Error("policy engine exploded"); },
  });
  const d = await authorizeWorkerAction(runtime, { toolId: "shell.run", args: { cmd: "ls" } });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /policy evaluation failed/);
  assert.match(d.reason, /policy engine exploded/);
});

test("only the policy authority's outcome can produce an allow", async () => {
  // A policy that denies must deny; a policy that parks must park. Nothing else.
  const deny = await authorizeWorkerAction(
    stubRuntime({ tools: { "shell.run": DESTRUCTIVE_TOOL }, check: async () => ({ outcome: "deny", reason: "rule says no", source: "rule:no-shell" }) }),
    { toolId: "shell.run", args: { cmd: "rm -rf /" } },
  );
  assert.equal(deny.decision, "deny");
  assert.equal(deny.source, "rule:no-shell");

  const allow = await authorizeWorkerAction(
    stubRuntime({ tools: { "filesystem.read": READ_TOOL }, check: async () => ({ outcome: "allow", reason: "reads are free", source: "default" }) }),
    { toolId: "filesystem.read", args: { path: "/tmp/x" } },
  );
  assert.equal(allow.decision, "allow");
});

test("the endpoint parks a QUESTION, and never an ANSWER", async () => {
  // This used to assert the opposite — that no approval id was returned — which was the
  // bug: the hook told the worker "approve it in KAI, then retry" and there was nothing
  // to approve. The correct contract is that a park is a REAL, owner-decidable row.
  const runtime = stubRuntime({
    tools: { "shell.run": DESTRUCTIVE_TOOL },
    check: async () => ({ outcome: "needs_approval", reason: "human required", source: "default" }),
  });
  const parked = await authorizeWorkerAction(runtime, { toolId: "shell.run", args: { cmd: "ls" } });

  assert.equal(parked.decision, "needs_approval");
  assert.ok(
    typeof parked.approvalId === "string" && parked.approvalId.length > 0,
    "a park must name a real approval, or the caller cannot act on it",
  );
  const row = runtime.approvals.get(parked.approvalId);
  assert.ok(row !== null);
  assert.equal(row.status, "PENDING", "the ask is never pre-approved");
  // The ANSWER side is what the endpoint must never fabricate.
  assert.equal(runtime.approvals.list({ status: "APPROVED" }).length, 0, "no approval may be minted as granted");
});

test("the declared mission and step are forwarded, and omitted when absent", async () => {
  let seen = null;
  const runtime = stubRuntime({
    tools: { "filesystem.read": READ_TOOL },
    check: async (r) => { seen = r; return { outcome: "allow", reason: "ok", source: "default" }; },
  });
  await authorizeWorkerAction(runtime, { toolId: "filesystem.read", args: {}, missionId: "m1", stepId: "s1" });
  assert.equal(seen.missionId, "m1");
  assert.equal(seen.stepId, "s1");

  await authorizeWorkerAction(runtime, { toolId: "filesystem.read", args: {} });
  assert.equal("missionId" in seen, false, "an absent mission must not be sent as undefined");
});
// ── A worker's ask becomes a QUESTION A HUMAN CAN ANSWER ─────────────────────────
//
// Reporting `needs_approval` with no record is an unactionable dead end: the worker is
// told "approve it in KAI, then retry" and there is nothing to approve. These pin the
// whole round trip, including that the approval is spent by the retry it authorises.

/** A runtime whose policy ALWAYS asks for approval. */
function askingRuntime() {
  return stubRuntime({
    tools: { "filesystem.read": READ_TOOL },
    check: async () => ({ outcome: "needs_approval", reason: "ask-all requires approval", source: "mode:ask-all" }),
  });
}

test("needs_approval creates a REAL approval, bound to the exact arguments", async () => {
  const runtime = askingRuntime();
  const args = { path: "C:/tmp/kai-exec/core/package.json" };
  const d = await authorizeWorkerAction(runtime, { toolId: "filesystem.read", args });

  assert.equal(d.decision, "needs_approval");
  assert.ok(typeof d.approvalId === "string" && d.approvalId.length > 0, "an id must be returned, or the ask is unactionable");

  const row = runtime.approvals.get(d.approvalId);
  assert.ok(row !== null, "the approval must exist in the store");
  assert.equal(row.toolId, "filesystem.read");
  assert.equal(row.inputHash, authorizationBinding("filesystem.read", args), "the binding must be the one the caller was given");
  assert.equal(row.status, "PENDING", "a worker ask never arrives pre-approved");
});

test("asking twice about the SAME action reuses the pending question instead of stacking", async () => {
  const runtime = askingRuntime();
  const args = { path: "a.txt" };
  const first = await authorizeWorkerAction(runtime, { toolId: "filesystem.read", args });
  const second = await authorizeWorkerAction(runtime, { toolId: "filesystem.read", args });

  assert.equal(second.approvalId, first.approvalId, "the same action must not create a second question");
  assert.equal(runtime.approvals.list().length, 1);
});

test("an approved ask allows EXACTLY ONE retry, and is then spent", async () => {
  const runtime = askingRuntime();
  const args = { path: "b.txt" };
  const asked = await authorizeWorkerAction(runtime, { toolId: "filesystem.read", args });
  const decided = runtime.approvals.decide(asked.approvalId, true);
  assert.equal(decided.ok, true);

  const retry = await authorizeWorkerAction(runtime, { toolId: "filesystem.read", args });
  assert.equal(retry.decision, "allow", "the retry the human approved must be authorised");
  assert.equal(retry.code, "approval_granted");

  const again = await authorizeWorkerAction(runtime, { toolId: "filesystem.read", args });
  // A spent "yes" is gone, so the next attempt ASKS AGAIN rather than being waved
  // through. That is the point: one approval is one action, never standing permission.
  assert.equal(again.decision, "needs_approval", "a spent approval must not authorise another call");
  assert.notEqual(again.approvalId, asked.approvalId, "the fresh ask is a NEW question, not the spent one");
});

test("an approval for one path can NEVER authorise a different path", async () => {
  const runtime = askingRuntime();
  const asked = await authorizeWorkerAction(runtime, { toolId: "filesystem.read", args: { path: "a.txt" } });
  runtime.approvals.decide(asked.approvalId, true);

  // Same tool, same shape, DIFFERENT value: a new question, not a grant.
  const other = await authorizeWorkerAction(runtime, { toolId: "filesystem.read", args: { path: "b.txt" } });
  assert.equal(other.decision, "needs_approval");
  assert.notEqual(other.approvalId, asked.approvalId, "a different binding must need its own approval");
  assert.notEqual(other.binding, asked.binding);
});

test("a rejected ask authorises nothing, and a later ask asks again", async () => {
  const runtime = askingRuntime();
  const args = { path: "c.txt" };
  const asked = await authorizeWorkerAction(runtime, { toolId: "filesystem.read", args });
  runtime.approvals.decide(asked.approvalId, false);

  const retry = await authorizeWorkerAction(runtime, { toolId: "filesystem.read", args });
  assert.equal(retry.decision, "needs_approval", "a rejection is not a grant");
  assert.notEqual(retry.approvalId, asked.approvalId, "a rejected row cannot be re-presented as the same question");
});

test("a DENY never creates an approval at all", async () => {
  const runtime = stubRuntime({
    tools: { "shell.run": DESTRUCTIVE_TOOL },
    check: async () => ({ outcome: "deny", reason: "permanently denied", source: "rule:deny" }),
  });
  const d = await authorizeWorkerAction(runtime, { toolId: "shell.run", args: { command: "echo hi" } });
  assert.equal(d.decision, "deny");
  assert.equal("approvalId" in d, false, "a denial is not a question");
  assert.equal(runtime.approvals.list().length, 0, "nothing was parked for a denied action");
});

test("a worker cannot approve itself: the ask path only ever writes PENDING", async () => {
  const runtime = askingRuntime();
  const d = await authorizeWorkerAction(runtime, { toolId: "filesystem.read", args: { path: "d.txt" } });
  const rows = runtime.approvals.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "PENDING", "only a human decides; the ask never sets APPROVED");
  assert.equal(rows[0].decidedAt, undefined);
  assert.ok(d.approvalId !== undefined);
});
