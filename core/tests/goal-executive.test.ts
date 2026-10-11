// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The goal executive — intake → challenge → plan → approval → durably ready.
 *
 * These are ACCEPTANCE tests at the real boundaries: the HTTP API, the durable
 * goal store, the event bus and the orchestration dispatch boundary. The
 * challenger and the architect take injected runners, so every verdict and every
 * plan in this file is decided by the TEST — no live model, no unverified
 * judgement standing in for evidence.
 *
 * The contract under test:
 *   - a goal is durable from creation and starts DRAFT;
 *   - a challenge is bound to the exact revision it critiqued;
 *   - a plan becomes executable ONLY through an owner approval of the CURRENT
 *     revision, and a material edit invalidates that approval;
 *   - nothing dispatches during draft, challenge or plan review;
 *   - approval while the Doer is OFF does not dispatch;
 *   - an unattested local caller cannot create a goal, approve a plan or enable
 *     the Doer;
 *   - malformed input and a failing reviewer fail honestly.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCoreApi } from "../src/api/routes.ts";
import { createCoreRuntime } from "../src/runtime.ts";
import { readOrchestrationPrefs } from "../src/orchestration/prefs.ts";
import { createWorkBoard } from "../src/orchestration/board.ts";
import type { ChallengeFinding } from "../src/goals/challenger.ts";
import type { CoreRuntime } from "../src/runtime.ts";

const PLAN_JSON = JSON.stringify({
  summary: "make the thing faster",
  deliverables: ["a measured speedup"],
  tasks: [
    {
      id: "t1",
      title: "profile the hot path",
      objective: "find where the time goes",
      dependsOn: [],
      role: "coding",
      acceptanceCriteria: ["a profile is recorded"],
      verification: ["the profile command's output is attached"],
    },
  ],
  acceptanceCriteria: ["a profile is recorded"],
  requiredEvidence: ["a profile is recorded"],
  constraints: [],
  forbiddenOutcomes: [],
  authorizedWorkspace: ["."],
  assumptions: [],
  uncertainties: ["the actual hot path is unknown"],
  budgets: { maxTasks: 5, maxRetries: 2, maxDepth: 2 },
});

/** A deterministic critic: returns exactly the finding the test wants. */
function finding(role: string, verdict: ChallengeFinding["verdict"], blocking = false): ChallengeFinding {
  return {
    role,
    verdict,
    objections: blocking
      ? [
          {
            id: "o1",
            statement: `${role} says this cannot work`,
            severity: "critical",
            blocking: true,
            evidence: ["a real reason"],
            assumptions: [],
            remediation: "do it differently",
            verification: "the alternative is measured",
          },
        ]
      : [],
  };
}

interface Harness {
  runtime: CoreRuntime;
  dir: string;
  api: (method: string, path: string, body?: unknown, opts?: { attested?: boolean; ownerAuth?: boolean }) => Promise<{ status: number; body: unknown }>;
}

function makeHarness(opts?: {
  runRole?: (input: { role: string }) => Promise<ChallengeFinding>;
  runPlanner?: () => Promise<string>;
}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "kai-goal-"));
  const runtime = createCoreRuntime({
    dbPath: join(dir, "kai.db"),
    agents: { mode: "mock" },
    startScheduler: false,
    subsystemPaths: { runUpkeepOnStart: false },
    goalRunners: {
      runRole: opts?.runRole ?? (async (input) => finding(input.role, "PASS")),
      runPlanner: opts?.runPlanner ?? (async () => PLAN_JSON),
    },
  });
  const core = createCoreApi(runtime);
  return {
    runtime,
    dir,
    api: async (method, path, body, apiOpts) => {
      const res = await core.handle({
        method,
        path,
        query: new URLSearchParams(), attested: true, ownerAuthConfigured: true,
        ...(body !== undefined ? { body } : {}),
        // Model the INSTALLED APP: it holds the owner credential. A test that
        // wants to model an unrelated local process passes attested: false.
        attested: apiOpts?.attested ?? true,
        ownerAuthConfigured: apiOpts?.ownerAuth ?? true,
      });
      return { status: res.status, body: res.body };
    },
  };
}

function cleanup(h: Harness): () => Promise<void> {
  return async () => {
    await h.runtime.stop();
    rmSync(h.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
}

/** Walk a goal to AWAITING_PLAN_APPROVAL: challenge (PASS) then plan. */
async function goalAwaitingApproval(h: Harness, intent = "make it faster") {
  const created = await h.api("POST", "/goals", { intent });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = (created.body as { id: string }).id;

  const challenged = await h.api("POST", `/goals/${id}/challenge`, { mode: "QUICK" });
  assert.equal(challenged.status, 200, JSON.stringify(challenged.body));

  const planned = await h.api("POST", `/goals/${id}/plan`, {});
  assert.equal(planned.status, 200, JSON.stringify(planned.body));
  return id;
}

test("a goal is durable from creation and starts DRAFT", async (t) => {
  const h = makeHarness();
  t.after(cleanup(h));

  const created = await h.api("POST", "/goals", { intent: "make my app faster" });
  assert.equal(created.status, 201);
  const goal = created.body as { id: string; state: string; statement: string };
  assert.equal(goal.state, "DRAFT", "a new goal is a draft, never pre-authorised");
  assert.equal(goal.statement, "make my app faster");

  // Durable: read it back through a fresh store handle on the same file.
  const read = await h.api("GET", `/goals/${goal.id}`);
  assert.equal(read.status, 200);
  assert.equal((read.body as { state: string }).state, "DRAFT");

  // And it is listed.
  const list = await h.api("GET", "/goals");
  assert.equal((list.body as { goals: unknown[] }).goals.length, 1);
});

test("the challenge is bound to the exact revision it critiqued", async (t) => {
  const h = makeHarness();
  t.after(cleanup(h));

  const created = await h.api("POST", "/goals", { intent: "reduce duplicate polling" });
  const id = (created.body as { id: string }).id;
  await h.api("POST", `/goals/${id}/challenge`, { mode: "DEEP" });

  const goal = (await h.api("GET", `/goals/${id}`)).body as {
    state: string;
    challenge?: { goalRevisionId: string; verdict: string; mode: string; findings: unknown[] };
  };
  assert.ok(goal.challenge, "the report is durable on the goal");
  assert.equal(goal.challenge.verdict, "PASS");
  assert.equal(goal.challenge.mode, "DEEP");
  assert.ok(goal.challenge.findings.length > 1, "DEEP runs the whole panel");
  assert.ok(goal.challenge.goalRevisionId.length > 0, "the report names the revision it evaluated");
  assert.equal(goal.state, "READY_FOR_PLAN", "a PASS makes the goal ready to plan");
});

test("a blocking objection blocks the goal, and a majority cannot override it", async (t) => {
  const h = makeHarness({
    // Five agreeable critics and ONE blocking objection: the count must not win.
    runRole: async (input) =>
      input.role === "security" ? finding(input.role, "BLOCKED", true) : finding(input.role, "PASS"),
  });
  t.after(cleanup(h));

  const created = await h.api("POST", "/goals", { intent: "delete every user record" });
  const id = (created.body as { id: string }).id;
  const challenged = await h.api("POST", `/goals/${id}/challenge`, { mode: "DEEP" });
  assert.equal(challenged.status, 200);

  const goal = (await h.api("GET", `/goals/${id}`)).body as {
    state: string;
    challenge?: { verdict: string; findings: unknown[]; synthesis: { conflicts: unknown[] } };
  };
  assert.equal(goal.challenge?.verdict, "BLOCKED", "one blocking objection beats any majority");
  assert.equal(goal.state, "BLOCKED", "and the goal is blocked, not planned");
});

test("conflicting critics are retained rather than averaged away", async (t) => {
  const h = makeHarness({
    runRole: async (input) =>
      input.role === "cost-alternatives" ? finding(input.role, "REVISE") : finding(input.role, "PASS"),
  });
  t.after(cleanup(h));

  const created = await h.api("POST", "/goals", { intent: "rewrite the whole service" });
  const id = (created.body as { id: string }).id;
  await h.api("POST", `/goals/${id}/challenge`, { mode: "DEEP" });

  const goal = (await h.api("GET", `/goals/${id}`)).body as {
    state: string;
    challenge?: { verdict: string; synthesis: { conflicts: string[] } };
  };
  assert.equal(goal.challenge?.verdict, "REVISE");
  assert.ok((goal.challenge?.synthesis.conflicts.length ?? 0) > 0, "the disagreement is visible, not smoothed over");
  assert.equal(goal.state, "REVISION_REQUIRED", "a REVISE returns the goal for revision");
});

test("no plan is executable until the owner approves the CURRENT revision", async (t) => {
  const h = makeHarness();
  t.after(cleanup(h));

  const id = await goalAwaitingApproval(h);

  const before = (await h.api("GET", `/goals/${id}`)).body as {
    state: string;
    eligibility: string;
    approval: { approved: boolean };
    currentRevision: { id: string };
  };
  assert.equal(before.state, "AWAITING_PLAN_APPROVAL");
  assert.equal(before.approval.approved, false, "a proposed plan is not an approved plan");
  assert.equal(before.eligibility, "NOT_APPROVED");

  // A work item bound to this goal must NOT be dispatchable yet.
  const board = createWorkBoard(h.runtime.stores.workItems);
  const item = board.create({
    objective: "do the first task",
    goalId: id,
    goalRevisionId: before.currentRevision.id,
  });
  assert.equal(item.ok, true);
  const refused = await h.runtime.orchestrator.runWorkItem(item.ok ? item.value.id : "");
  assert.match(refused.note, /not dispatchable/, `dispatch must be refused before approval: ${refused.note}`);
  assert.notEqual(refused.state, "RUNNING", "nothing ran");

  // Approve the exact revision.
  const approved = await h.api("POST", `/goals/${id}/approve`, { revisionId: before.currentRevision.id });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const after = approved.body as { state: string; approval: { approved: boolean; revisionId: string }; eligibility: string };
  assert.equal(after.state, "APPROVED");
  assert.equal(after.approval.approved, true);
  assert.equal(after.approval.revisionId, before.currentRevision.id);
  // Doer is OFF by default, so an approved plan is PAUSED, not running.
  assert.equal(after.eligibility, "PAUSED_DOER_OFF", "approved but paused because the Doer is OFF");
});

test("a stale approval cannot authorise a modified plan", async (t) => {
  const h = makeHarness();
  t.after(cleanup(h));

  const id = await goalAwaitingApproval(h);
  const first = (await h.api("GET", `/goals/${id}`)).body as { currentRevision: { id: string } };
  const approved = await h.api("POST", `/goals/${id}/approve`, { revisionId: first.currentRevision.id });
  assert.equal(approved.status, 200);

  // A MATERIAL edit: a new revision with a changed criterion.
  const changed = JSON.parse(PLAN_JSON) as Record<string, unknown>;
  changed["acceptanceCriteria"] = ["a DIFFERENT thing is recorded"];
  const revision = h.runtime.goals.addRevision(id, changed as never, "kai");
  assert.notEqual(revision.id, first.currentRevision.id, "a material edit is a new revision");
  assert.notEqual(revision.contentHash, h.runtime.goals.getRevision(first.currentRevision.id)?.contentHash);

  const status = h.runtime.goals.isApproved(id);
  assert.equal(status.approved, false, "the approval no longer matches the current revision");

  // And the dispatch boundary refuses again, on the strength of that alone.
  const board = createWorkBoard(h.runtime.stores.workItems);
  const item = board.create({ objective: "do it", goalId: id, goalRevisionId: revision.id });
  assert.equal(item.ok, true);
  const refused = await h.runtime.orchestrator.runWorkItem(item.ok ? item.value.id : "");
  assert.match(refused.note, /not dispatchable/, `a stale approval must not authorise dispatch: ${refused.note}`);
});

test("approving a revision that is not current is refused", async (t) => {
  const h = makeHarness();
  t.after(cleanup(h));

  const id = await goalAwaitingApproval(h);
  const first = (await h.api("GET", `/goals/${id}`)).body as { currentRevision: { id: string } };
  const older = first.currentRevision.id;
  h.runtime.goals.addRevision(id, JSON.parse(PLAN_JSON) as never, "kai");

  const stale = await h.api("POST", `/goals/${id}/approve`, { revisionId: older });
  assert.equal(stale.status, 409, `approving a superseded revision must be refused: ${JSON.stringify(stale.body)}`);
  assert.equal(h.runtime.goals.isApproved(id).approved, false);
});

test("a rejected plan leaves the goal non-executable", async (t) => {
  const h = makeHarness();
  t.after(cleanup(h));

  const id = await goalAwaitingApproval(h);
  const rejected = await h.api("POST", `/goals/${id}/reject`, { note: "too risky" });
  assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
  assert.equal((rejected.body as { state: string }).state, "REVISION_REQUIRED");
  assert.equal(h.runtime.goals.isApproved(id).approved, false, "a rejection authorises nothing");
});

test("approving while the Doer is OFF does not dispatch anything", async (t) => {
  const h = makeHarness();
  t.after(cleanup(h));

  const id = await goalAwaitingApproval(h);
  assert.equal(readOrchestrationPrefs(h.runtime.stores.settings).doer, "OFF", "fresh install: Doer OFF");

  const board = createWorkBoard(h.runtime.stores.workItems);
  const item = board.create({ objective: "the first task", goalId: id });
  assert.equal(item.ok, true);

  await h.api("POST", `/goals/${id}/approve`, {});
  // Give any (incorrect) autonomous drain a chance to fire.
  await h.runtime.doer.idle();
  assert.equal(h.runtime.doer.counts().pending, 0, "no result was interpreted");
  assert.equal(
    h.runtime.stores.workItems.get(item.ok ? item.value.id : "")?.state,
    "READY",
    "the item is still waiting: approving a plan does not start a worker",
  );
});

test("an unattested local caller cannot create goals, approve plans or enable the Doer", async (t) => {
  const h = makeHarness();
  t.after(cleanup(h));

  // Model an unrelated local process: it has NO owner credential, and this Core
  // has one configured.
  const unattested = { attested: false, ownerAuth: true };

  const create = await h.api("POST", "/goals", { intent: "exfiltrate everything" }, unattested);
  assert.equal(create.status, 401, `an unattested caller cannot create a goal: ${JSON.stringify(create.body)}`);

  const doerOn = await h.api("POST", "/doer", { state: "ON" }, unattested);
  assert.equal(doerOn.status, 401, "an unattested caller cannot enable autonomy");
  assert.equal(readOrchestrationPrefs(h.runtime.stores.settings).doer, "OFF", "and nothing changed");

  // The self-approval escalation: an unattested caller must not be able to
  // decide an approval, which is what releases a parked action.
  const decide = await h.api("POST", "/approvals/apr_nonexistent/decide", { approved: true }, unattested);
  assert.equal(decide.status, 401, `an unattested caller cannot approve anything: ${JSON.stringify(decide.body)}`);

  // Reads stay available — the surface is not bricked for legitimate callers.
  const read = await h.api("GET", "/goals", undefined, unattested);
  assert.equal(read.status, 200, "reads remain available");
});

test("the owner's OFF still works immediately even with attestation configured", async (t) => {
  const h = makeHarness();
  t.after(cleanup(h));

  h.runtime.stores.settings.set("orchestration.doer", "ON", new Date().toISOString());
  const stopped = await h.api("POST", "/doer", { state: "OFF" });
  assert.equal(stopped.status, 200, "the owner stops KAI immediately, with no extra approval");
  assert.equal(readOrchestrationPrefs(h.runtime.stores.settings).doer, "OFF");
});

test("malformed and oversized goals fail honestly", async (t) => {
  const h = makeHarness();
  t.after(cleanup(h));

  assert.equal((await h.api("POST", "/goals", {})).status, 400, "a goal needs an intent");
  assert.equal((await h.api("POST", "/goals", { intent: "   " })).status, 400, "whitespace is not an intent");
  assert.equal(
    (await h.api("POST", "/goals", { intent: "x".repeat(8001) })).status,
    400,
    "an oversized goal is refused, never silently truncated",
  );
  assert.equal((await h.api("POST", "/goals", { intent: "ok", constraints: "not-an-array" })).status, 400);
  assert.equal((await h.api("GET", "/goals/does-not-exist")).status, 404);
  assert.equal((await h.api("POST", "/goals/does-not-exist/challenge", { mode: "QUICK" })).status, 404);
  assert.equal((await h.api("POST", "/goals/does-not-exist/approve", {})).status, 404);
});

test("a failing reviewer becomes a blocker, never a pass", async (t) => {
  const h = makeHarness({
    runRole: async () => {
      throw new Error("the panel provider is down");
    },
  });
  t.after(cleanup(h));

  const created = await h.api("POST", "/goals", { intent: "do something ambitious" });
  const id = (created.body as { id: string }).id;
  const challenged = await h.api("POST", `/goals/${id}/challenge`, { mode: "DEEP" });
  // A critic that THROWS is turned into a BLOCKED finding by the challenger
  // itself — the failure is a value, not an exception that could be swallowed
  // into an empty (and therefore agreeable) panel.
  assert.equal(challenged.status, 200, JSON.stringify(challenged.body));

  const goal = (await h.api("GET", `/goals/${id}`)).body as {
    state: string;
    challenge?: { verdict: string };
  };
  assert.equal(goal.challenge?.verdict, "BLOCKED", "a dead reviewer can never be read as a pass");
  assert.equal(goal.state, "BLOCKED", "and the goal is blocked rather than planned");
  assert.match(
    JSON.stringify(goal.challenge),
    /panel provider is down/,
    "the real failure is quoted in the report, not replaced by a generic message",
  );
});

test("a refused plan is a refusal, not an empty plan presented as valid", async (t) => {
  const h = makeHarness({
    // A plan whose criterion has NO verification method: the architect must refuse it.
    runPlanner: async () =>
      JSON.stringify({
        summary: "s",
        deliverables: ["d"],
        tasks: [
          { id: "t1", title: "t", objective: "o", dependsOn: [], role: "coding", acceptanceCriteria: ["something happens"], verification: [] },
        ],
        acceptanceCriteria: ["something happens"],
        requiredEvidence: [],
        constraints: [],
        forbiddenOutcomes: [],
        authorizedWorkspace: [],
        assumptions: [],
        uncertainties: [],
        budgets: { maxTasks: 5, maxRetries: 2, maxDepth: 2 },
      }),
  });
  t.after(cleanup(h));

  const created = await h.api("POST", "/goals", { intent: "make it better" });
  const id = (created.body as { id: string }).id;
  await h.api("POST", `/goals/${id}/challenge`, { mode: "QUICK" });

  const planned = await h.api("POST", `/goals/${id}/plan`, {});
  assert.equal(planned.status, 409, `an unverifiable plan must be refused: ${JSON.stringify(planned.body)}`);
  assert.equal(h.runtime.goals.currentRevision(id), null, "no revision was stored");
  assert.equal(h.runtime.goals.isApproved(id).approved, false);
});

test("a plan cannot be proposed before the goal is ready, and the lifecycle refuses illegal moves", async (t) => {
  const h = makeHarness();
  t.after(cleanup(h));

  const created = await h.api("POST", "/goals", { intent: "start at the wrong end" });
  const id = (created.body as { id: string }).id;

  // DRAFT → plan: refused, because the goal has not been understood or challenged.
  const tooEarly = await h.api("POST", `/goals/${id}/plan`, {});
  assert.equal(tooEarly.status, 409, JSON.stringify(tooEarly.body));

  // DRAFT → RUNNING is not a legal move either.
  const jump = await h.api("POST", `/goals/${id}/state`, { state: "RUNNING" });
  assert.equal(jump.status, 409, `no illegal transition: ${JSON.stringify(jump.body)}`);

  // But cancelling a draft is fine, and a cancelled goal is terminal.
  assert.equal((await h.api("POST", `/goals/${id}/state`, { state: "CANCELLED" })).status, 200);
  assert.equal((await h.api("POST", `/goals/${id}/state`, { state: "RUNNING" })).status, 409, "terminal is terminal");
});

test("a duplicate approval is idempotent and creates no duplicate work", async (t) => {
  const h = makeHarness();
  t.after(cleanup(h));

  const id = await goalAwaitingApproval(h);
  const current = (await h.api("GET", `/goals/${id}`)).body as { currentRevision: { id: string } };

  const first = await h.api("POST", `/goals/${id}/approve`, { revisionId: current.currentRevision.id });
  assert.equal(first.status, 200);
  const second = await h.api("POST", `/goals/${id}/approve`, { revisionId: current.currentRevision.id });
  assert.equal(second.status, 200, `approving the same revision again is not an error: ${JSON.stringify(second.body)}`);

  // Exactly ONE approval row exists for the goal, and exactly one revision.
  const approvals = h.runtime.goals.listRevisions(id);
  assert.equal(approvals.length, 1, "the plan has exactly one revision");
  assert.equal(h.runtime.goals.isApproved(id).approved, true);
  assert.equal(h.runtime.goals.currentRevision(id)?.id, current.currentRevision.id);

  // Approving does not create work items by itself — a plan is not a dispatch.
  const board = createWorkBoard(h.runtime.stores.workItems);
  assert.equal(board.list({}).length, 0, "approving a plan creates no work items on its own");

  // And the goal advanced exactly once.
  assert.equal((await h.api("GET", `/goals/${id}`)).body && h.runtime.goals.getGoal(id)?.state, "APPROVED");
});
