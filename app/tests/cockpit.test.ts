// The Cockpit's honesty layer, tested without a DOM and without a Core process.
//
// Every function exercised here is a PURE mapping, and the property this file
// exists to pin down is the one the whole surface is built around:
//
//   A CLAIM A WORKER MADE ABOUT ITS OWN WORK IS NEVER LABELLED AS KAI-VERIFIED.
//
// The cross-product case below asserts that for every combination of inputs, the
// `kai-verified` tier appears if and only if KAI itself verified — a worker
// report can never buy it, and an observation never substitutes for a check.
//
// cockpit.ts imports its stylesheet (the same way presence.ts does), and Node
// cannot load a `.css` module, so a load hook answers `.css` with an empty module
// before the surface is imported dynamically.
//
// Run from `app/`:  node --test tests/cockpit.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith(".css")) return { format: "module", source: "export {};", shortCircuit: true };
    return nextLoad(url, context);
  },
});

const {
  criterionBadge,
  doerBadge,
  eligibilityBadge,
  goalCriteriaStatuses,
  guardBadge,
  isLiveState,
  nextActionFor,
  parkedEvents,
  pendingLabel,
  pickActiveGoal,
  planTaskLink,
  provenanceLabel,
  verificationBadge,
  workItemBadge,
  workerAvailability,
} = await import("../src/shell/presence/cockpit.ts");

const OK = "gp-ok";
const PAUSED = "gp-paused";
const BLOCKED = "gp-blocked";
const UNVERIFIED = "gp-unverified";
const NEUTRAL = "gp-neutral";
const REVISE = "gp-revise";

// ── Eligibility / switches ──────────────────────────────────────────────────

test("eligibilityBadge separates eligible, paused and not-approved", () => {
  assert.equal(eligibilityBadge("ELIGIBLE").cls, OK);
  assert.equal(eligibilityBadge("PAUSED_DOER_OFF").cls, PAUSED);
  assert.match(eligibilityBadge("PAUSED_DOER_OFF").text, /Doer is OFF/);
  assert.equal(eligibilityBadge("NOT_APPROVED").cls, BLOCKED);
});

test("eligibilityBadge never dresses an unknown value as eligible", () => {
  const badge = eligibilityBadge("SOMETHING_NEW");
  assert.equal(badge.cls, BLOCKED);
  assert.match(badge.text, /unknown/i);
});

test("doerBadge and guardBadge report ON and OFF distinctly", () => {
  assert.equal(doerBadge("ON").cls, OK);
  assert.equal(doerBadge("OFF").cls, PAUSED);
  assert.equal(doerBadge("WHATEVER").cls, BLOCKED);
  assert.equal(guardBadge("ON").cls, OK);
  assert.equal(guardBadge("OFF").cls, BLOCKED, "Guard is never reported off, so 'OFF' is a lie to surface");
});

// ── The pending inbox ───────────────────────────────────────────────────────

test("pendingLabel calls unprocessed rows PARKED and never implies a review", () => {
  const label = pendingLabel({ state: "OFF", pending: { pending: 3, claimed: 0, done: 4, failed: 1 } });
  assert.equal(label.cls, PAUSED);
  assert.equal(label.count, 3);
  assert.match(label.text, /parked/);
  assert.match(label.text, /not yet processed/);
  assert.doesNotMatch(label.text, /reviewed|verified|checked|inspected/i, "parked rows were not reviewed by anyone");
});

test("pendingLabel with the Doer OFF and an empty inbox overstates nothing", () => {
  const label = pendingLabel({ state: "OFF", pending: { pending: 0, claimed: 0, done: 2, failed: 0 } });
  assert.match(label.text, /nothing parked/);
  assert.equal(label.count, 0);
  assert.doesNotMatch(label.text, /parked —/);
});

test("pendingLabel with the Doer ON describes processing, not parking", () => {
  const busy = pendingLabel({ state: "ON", pending: { pending: 2, claimed: 1, done: 0, failed: 0 } });
  assert.equal(busy.cls, REVISE);
  assert.equal(busy.count, 2);
  assert.doesNotMatch(busy.text, /parked/);
  assert.doesNotMatch(busy.text, /reviewed|verified/i);
  const idle = pendingLabel({ state: "ON", pending: { pending: 0, claimed: 0, done: 9, failed: 0 } });
  assert.equal(idle.cls, OK);
  assert.match(idle.text, /empty/);
});

test("parkedEvents reads the rows Core carried, dropping anything malformed", () => {
  const rows = parkedEvents({
    state: "OFF",
    paused: true,
    guard: "ON",
    pending: { pending: 1, claimed: 1, done: 0, failed: 1 },
    results: [
      { idempotencyKey: "k1", eventType: "worker.completed", state: "PENDING", createdAt: "2026-01-01T00:00:00.000Z", attempts: 0, workItemId: "wi_1" },
      { idempotencyKey: "k2", eventType: "worker.failed", state: "CLAIMED", createdAt: "2026-01-01T00:01:00.000Z", attempts: 2 },
      { eventType: "no key" },
      "not an object",
      null,
    ],
  });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    id: "k1",
    eventType: "worker.completed",
    state: "PENDING",
    at: "2026-01-01T00:00:00.000Z",
    attempts: 0,
    workItemId: "wi_1",
  });
  assert.equal(rows[1].workItemId, null, "an absent id is null, never invented");
});

test("parkedEvents yields nothing when Core sent no rows", () => {
  assert.deepEqual(parkedEvents({ state: "OFF", paused: true, guard: "ON", pending: { pending: 0, claimed: 0, done: 0, failed: 0 } }), []);
  assert.deepEqual(
    parkedEvents({ state: "ON", paused: false, guard: "ON", pending: { pending: 0, claimed: 0, done: 0, failed: 0 }, results: "nonsense" }),
    [],
  );
});

// ── Provenance: the invariant this surface exists for ───────────────────────

test("a worker-reported claim is NEVER labelled KAI-verified", () => {
  const claim = provenanceLabel(true, false, false);
  assert.equal(claim.tier, "worker-reported");
  assert.equal(claim.cls, UNVERIFIED);
  assert.doesNotMatch(claim.text, /KAI-verified/);
  assert.match(claim.text, /not checked by KAI/);
});

test("kai-verified appears if and only if KAI verified", () => {
  for (const workerReported of [false, true]) {
    for (const kaiObserved of [false, true]) {
      for (const kaiVerified of [false, true]) {
        const tier = provenanceLabel(workerReported, kaiObserved, kaiVerified).tier;
        assert.equal(
          tier === "kai-verified",
          kaiVerified,
          `tier=${tier} for workerReported=${workerReported} kaiObserved=${kaiObserved} kaiVerified=${kaiVerified}`,
        );
      }
    }
  }
});

test("an observation is never dressed as a verification", () => {
  const observed = provenanceLabel(false, true, false);
  assert.equal(observed.tier, "kai-observed");
  assert.equal(observed.cls, REVISE);
  assert.match(observed.text, /not verified/);
});

test("a claim with no source at all is unattributed, not assumed", () => {
  const none = provenanceLabel(false, false, false);
  assert.equal(none.tier, "unattributed");
  assert.equal(none.cls, NEUTRAL);
  assert.match(none.text, /No claim on record/);
});

test("a verified claim is the only green provenance", () => {
  const verified = provenanceLabel(true, true, true);
  assert.equal(verified.tier, "kai-verified");
  assert.equal(verified.cls, OK);
});

// ── Verification and work-item state ────────────────────────────────────────

test("verificationBadge distinguishes absent, passed and failed", () => {
  assert.equal(verificationBadge(undefined).cls, UNVERIFIED);
  const passed = verificationBadge({ passed: true, criteria: [{ name: "a", met: true }, { name: "b", met: true }] });
  assert.equal(passed.cls, OK);
  assert.match(passed.text, /2\/2 criteria met/);
  const failed = verificationBadge({ passed: false, criteria: [{ name: "a", met: true }, { name: "b", met: false }] });
  assert.equal(failed.cls, BLOCKED);
  assert.match(failed.text, /1\/2 criteria unmet/);
  assert.equal(verificationBadge({ at: "2026-01-01T00:00:00.000Z" }).cls, UNVERIFIED, "a record without a verdict is not a pass");
});

test("a worker saying 'done' is not a pass — COMPLETED without a record stays unverified", () => {
  assert.equal(workItemBadge("COMPLETED", undefined).cls, UNVERIFIED);
  assert.match(workItemBadge("COMPLETED", undefined).text, /UNVERIFIED/);
  assert.equal(workItemBadge("COMPLETED", { passed: true }).cls, OK);
});

test("a failed independent check dominates the item's self-reported state", () => {
  assert.equal(workItemBadge("COMPLETED", { passed: false }).cls, BLOCKED);
  assert.equal(workItemBadge("REVIEW", { passed: false }).cls, BLOCKED);
  assert.equal(workItemBadge("CANCELLED", { passed: false }).cls, NEUTRAL, "a cancelled item is not a failure");
});

test("workItemBadge maps the board's states without inventing success", () => {
  assert.equal(workItemBadge("READY", undefined).cls, NEUTRAL);
  assert.equal(workItemBadge("CLAIMED", undefined).cls, REVISE);
  assert.equal(workItemBadge("RUNNING", undefined).cls, REVISE);
  assert.equal(workItemBadge("WAITING", undefined).cls, PAUSED);
  assert.equal(workItemBadge("CHANGES_REQUESTED", undefined).cls, PAUSED);
  assert.equal(workItemBadge("FAILED", undefined).cls, BLOCKED);
  assert.equal(workItemBadge("BLOCKED", undefined).cls, BLOCKED);
  assert.equal(workItemBadge("CANCELLED", undefined).cls, NEUTRAL);
  const unknown = workItemBadge("SOMETHING_NEW", undefined);
  assert.equal(unknown.cls, UNVERIFIED);
  assert.match(unknown.text, /not recognised/);
});

test("criterionBadge distinguishes PASS, FAILED and UNVERIFIED", () => {
  assert.equal(criterionBadge("PASS").cls, OK);
  assert.equal(criterionBadge("FAILED").cls, BLOCKED);
  assert.equal(criterionBadge("UNVERIFIED").cls, UNVERIFIED);
});

test("isLiveState is true only for states that may hold a worker", () => {
  for (const state of ["READY", "CLAIMED", "RUNNING", "WAITING", "REVIEW", "CHANGES_REQUESTED"]) {
    assert.equal(isLiveState(state), true, state);
  }
  for (const state of ["COMPLETED", "FAILED", "BLOCKED", "CANCELLED", "NEW"]) {
    assert.equal(isLiveState(state), false, state);
  }
});

// ── Next action (derived, never reported) ───────────────────────────────────

test("nextActionFor derives from the state and never claims the work passed", () => {
  assert.match(nextActionFor("RUNNING"), /handoff/);
  assert.match(nextActionFor("REVIEW"), /review/i);
  assert.match(nextActionFor("COMPLETED"), /verification record/i);
  assert.doesNotMatch(nextActionFor("COMPLETED"), /^done/i);
  assert.match(nextActionFor("NOT_A_STATE"), /Unknown state/);
});

// ── Worker availability ─────────────────────────────────────────────────────

test("workerAvailability never reports availability it was not told", () => {
  const unknown = workerAvailability(undefined);
  assert.equal(unknown.cls, UNVERIFIED);
  assert.match(unknown.text, /unknown/i);
  assert.equal(unknown.reason, null);
});

test("workerAvailability carries Core's own reason when the adapter cannot be reached", () => {
  const down = workerAvailability({ reachable: false, reason: "ECONNREFUSED 127.0.0.1:8789" });
  assert.equal(down.cls, BLOCKED);
  assert.match(down.text, /Unavailable/);
  assert.equal(down.reason, "ECONNREFUSED 127.0.0.1:8789");
  const unauthorized = workerAvailability({ reachable: true, authorized: false, reason: "no host token" });
  assert.equal(unauthorized.cls, BLOCKED);
  assert.match(unauthorized.text, /NOT authorized/);
  const up = workerAvailability({ reachable: true, authorized: true });
  assert.equal(up.cls, OK);
  assert.equal(up.reason, null);
});

// ── Acceptance criteria from KAI's verification only ────────────────────────

const revision = {
  id: "rev_1",
  goalId: "goal_1",
  version: 1,
  contentHash: "hash0000000000",
  createdAt: "2026-01-01T00:00:00.000Z",
  content: {
    summary: "s",
    deliverables: [],
    tasks: [{ id: "t1", title: "One", objective: "o", dependsOn: [], role: "coding", acceptanceCriteria: [], verification: [] }],
    acceptanceCriteria: ["build is green", "no new warnings", "docs updated"],
    requiredEvidence: [],
    constraints: [],
    forbiddenOutcomes: [],
    authorizedWorkspace: [],
    assumptions: [],
    uncertainties: [],
    budgets: { maxTasks: 3, maxRetries: 1, maxDepth: 2 },
  },
};

test("goalCriteriaStatuses reports UNVERIFIED when no revision exists", () => {
  assert.deepEqual(goalCriteriaStatuses({ currentRevision: null }, []), []);
});

test("goalCriteriaStatuses reads PASS and FAILED from KAI's records only", () => {
  const rows = goalCriteriaStatuses({ currentRevision: revision }, [
    {
      id: "wi_1",
      state: "COMPLETED",
      taskId: "t1",
      verification: {
        passed: false,
        criteria: [
          { name: "build is green", met: true },
          { name: "no new warnings", met: false, detail: "2 new warnings" },
        ],
      },
    },
  ]);
  assert.deepEqual(
    rows.map((r) => [r.criterion, r.status]),
    [
      ["build is green", "PASS"],
      ["no new warnings", "FAILED"],
      ["docs updated", "UNVERIFIED"],
    ],
  );
  assert.equal(rows[1].detail, "2 new warnings");
  assert.match(rows[2].detail, /no verification record/);
});

test("a criterion with any unmet record is FAILED, never averaged to a pass", () => {
  const rows = goalCriteriaStatuses({ currentRevision: revision }, [
    { id: "wi_1", state: "COMPLETED", taskId: "t1", verification: { passed: false, criteria: [{ name: "build is green", met: true }] } },
    { id: "wi_2", state: "FAILED", taskId: "t1", verification: { passed: false, criteria: [{ name: "build is green", met: false, detail: "exit 1" }] } },
  ]);
  assert.equal(rows[0].status, "FAILED");
  assert.equal(rows[0].detail, "exit 1");
});

test("verification recorded against work this revision did not authorise does not count", () => {
  const rows = goalCriteriaStatuses({ currentRevision: revision }, [
    { id: "wi_9", state: "COMPLETED", taskId: "t_other", verification: { passed: true, criteria: [{ name: "build is green", met: true }] } },
    { id: "wi_8", state: "COMPLETED", verification: { passed: true, criteria: [{ name: "docs updated", met: true }] } },
  ]);
  assert.deepEqual(
    rows.map((r) => r.status),
    ["UNVERIFIED", "UNVERIFIED", "UNVERIFIED"],
  );
});

test("goalCriteriaStatuses falls back to the tasks' criteria when the revision states none", () => {
  const bare = {
    ...revision,
    content: { ...revision.content, acceptanceCriteria: [], tasks: [{ ...revision.content.tasks[0], acceptanceCriteria: ["ship it"] }] },
  };
  const rows = goalCriteriaStatuses({ currentRevision: bare }, []);
  assert.deepEqual(
    rows.map((r) => r.criterion),
    ["ship it"],
  );
  assert.equal(rows[0].status, "UNVERIFIED");
});

// ── Dependency links from the authorising revision ──────────────────────────

test("planTaskLink reads dependencies from the authorised plan task", () => {
  const goals = [
    {
      id: "goal_1",
      statement: "Ship the thing",
      state: "EXECUTING",
      updatedAt: "2026-01-02T00:00:00.000Z",
      currentRevision: revision,
    },
  ];
  const link = planTaskLink({ taskId: "t1" }, goals);
  assert.equal(link.goalId, "goal_1");
  assert.equal(link.taskTitle, "One");
  assert.deepEqual(link.dependsOn, []);
});

test("planTaskLink returns null when Core reported no link", () => {
  assert.equal(planTaskLink({}, []), null);
  assert.equal(planTaskLink({ taskId: "t_missing" }, [{ id: "goal_1", currentRevision: revision }]), null);
  assert.equal(planTaskLink({ taskId: "t1" }, [{ id: "goal_1", currentRevision: null }]), null);
});

// ── Which goal the cockpit opens on ─────────────────────────────────────────

test("pickActiveGoal prefers the newest unfinished goal", () => {
  const goals = [
    { state: "COMPLETED", updatedAt: "2026-01-05T00:00:00.000Z", id: "done" },
    { state: "EXECUTING", updatedAt: "2026-01-01T00:00:00.000Z", id: "older" },
    { state: "AWAITING_PLAN_APPROVAL", updatedAt: "2026-01-03T00:00:00.000Z", id: "newer" },
  ];
  assert.equal(pickActiveGoal(goals).id, "newer");
});

test("pickActiveGoal falls back to the newest goal when every goal is terminal", () => {
  const goals = [
    { state: "FAILED", updatedAt: "2026-01-05T00:00:00.000Z", id: "failed" },
    { state: "COMPLETED", updatedAt: "2026-01-01T00:00:00.000Z", id: "done" },
  ];
  assert.equal(pickActiveGoal(goals).id, "failed");
  assert.equal(pickActiveGoal([]), null);
});
