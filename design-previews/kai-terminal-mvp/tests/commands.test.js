// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Louis Raillé — MIT (see repository LICENSE).

/**
 * The prototype's own tests.
 *
 * A preview whose commands print canned strings would pass a screenshot review
 * and teach us nothing, so these assert on BEHAVIOUR: the parser's edges, and the
 * state transitions a reviewer will actually click through.
 *
 *   node --test tests/
 */

import assert from "node:assert/strict";
import test from "node:test";

import { commandNames, parseCommand, runCommand, suggest } from "../src/commands.js";
import { createDemoState, isDispatchable, taskById, taskCounts, goalById } from "../src/state.js";

const textOf = (result) => JSON.stringify(result.blocks);
/** The human-readable text of a result, unescaped, for assertion. */
const said = (result) =>
  result.blocks
    .flatMap((b) => [b.message, b.text, b.title, b.hint].filter((v) => typeof v === "string"))
    .join(" | ");

/* ── the parser ──────────────────────────────────────────────────────────── */

test("a bare command parses to a name and no arguments", () => {
  assert.deepEqual(parseCommand("/help"), { ok: true, name: "/help", args: [], raw: "/help" });
});

test("arguments split on whitespace, and case is normalised on the NAME only", () => {
  const parsed = parseCommand("/Goal Inspect g-1041");
  assert.equal(parsed.ok, true);
  assert.equal(parsed.name, "/goal");
  // The argument keeps its case: a goal id is data, not a keyword.
  assert.deepEqual(parsed.args, ["Inspect", "g-1041"]);
});

test("quotes hold an argument together", () => {
  const parsed = parseCommand('/memory search "evidence before adjectives"');
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.args, ["search", "evidence before adjectives"]);
});

test("a missing slash is refused WITH a hint at what was meant", () => {
  const parsed = parseCommand("goal list");
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /commands start with "\/"/);
  assert.match(parsed.error, /\/goal/);
});

test("an unbalanced quote is refused rather than silently swallowed", () => {
  const parsed = parseCommand('/memory search "unterminated');
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /unbalanced quote/);
});

test("an empty line is not a command", () => {
  assert.equal(parseCommand("   ").ok, false);
});

/* ── the table ───────────────────────────────────────────────────────────── */

test("every command in /help is one that actually runs", () => {
  const listed = commandNames();
  assert.ok(listed.length >= 20, `the prototype implements a real vocabulary: ${listed.length}`);
  for (const name of listed) {
    const result = runCommand(createDemoState(), `${name}`);
    // Either it runs, or it refuses for a REASON (a missing argument) — never
    // "not implemented", which is reserved for names outside the table.
    assert.ok(!textOf(result).includes("is not implemented"), `${name} is listed but not implemented`);
  }
});

test("/help output lists exactly the commands that exist", () => {
  const result = runCommand(createDemoState(), "/help");
  assert.equal(result.ok, true);
  const printed = textOf(result);
  for (const name of commandNames()) {
    assert.ok(printed.includes(name), `/help omits ${name}`);
  }
});

test("an unimplemented command says so, and suggests the nearest name", () => {
  const result = runCommand(createDemoState(), "/goals");
  assert.equal(result.ok, false);
  assert.match(textOf(result), /is not implemented/);
  assert.match(textOf(result), /did you mean \/goal/, "a near-miss is a hint, not a dead end");
});

test("suggestions follow the typed prefix", () => {
  const names = suggest("/skill").map((c) => c.name);
  assert.ok(names.includes("/skill"), `expected /skill in ${names.join(",")}`);
  assert.ok(!names.includes("/run"), "unrelated commands are not suggested");
});

/* ── goals and approval binding ──────────────────────────────────────────── */

test("/goal inspect shows the approved revision and the task board", () => {
  const state = createDemoState();
  const result = runCommand(state, "/goal inspect g-1041");
  assert.equal(result.ok, true);
  const printed = textOf(result);
  assert.match(printed, /rev_2/, "the approved revision is shown");
  assert.match(printed, /t1/);
});

test("a NEW plan revision INVALIDATES the previous approval", () => {
  const state = createDemoState();
  assert.equal(goalById(state, "g-1041").approvedRevision, "rev_2");

  const planned = runCommand(state, "/goal plan g-1041");
  assert.equal(planned.ok, true);
  assert.equal(goalById(state, "g-1041").approvedRevision, null, "re-planning clears the approval");
  assert.match(textOf(planned), /Approval invalidated/);

  // And nothing may dispatch against it.
  const dispatch = runCommand(state, "/run g-1041");
  assert.equal(dispatch.ok, false);
  assert.match(textOf(dispatch), /no approved revision/);
});

test("approving binds dispatch to THAT revision and no other", () => {
  const state = createDemoState();
  runCommand(state, "/goal plan g-1041");
  const approved = runCommand(state, "/goal approve g-1041");
  assert.equal(approved.ok, true);
  const goal = goalById(state, "g-1041");
  assert.equal(goal.approvedRevision, "rev_3", "the NEWEST revision is the approved one");
  assert.equal(goal.state, "RUNNING");
});

test("a rejected plan dispatches nothing", () => {
  const state = createDemoState();
  runCommand(state, "/goal plan g-1041");
  const rejected = runCommand(state, "/goal reject g-1041");
  assert.equal(rejected.ok, true);
  assert.notEqual(goalById(state, "g-1041").approvedRevision, "rev_3");
});

/* ── execution ───────────────────────────────────────────────────────────── */

test("/run dispatches an eligible task, transitions it, and charges the allowance", () => {
  const state = createDemoState();
  const before = state.budget.dispatch.used;
  assert.equal(taskById(state, "t2").state, "QUEUED", "t2 starts ready, not already running");

  const result = runCommand(state, "/run g-1041");
  assert.equal(result.ok, true);
  assert.match(textOf(result), /reserved BEFORE the claim/);
  assert.equal(state.budget.dispatch.used, before + 1, "the dispatch was charged");
  assert.equal(taskById(state, "t2").state, "RUNNING", "t2 transitioned QUEUED -> RUNNING");
});

test("a second /run cannot double-dispatch the task already in flight", () => {
  const state = createDemoState();
  assert.equal(runCommand(state, "/run g-1041").ok, true);
  const charged = state.budget.dispatch.used;

  const again = runCommand(state, "/run g-1041");
  assert.equal(again.ok, false, "a replayed dispatch is refused, not executed twice");
  assert.match(textOf(again), /already in flight/);
  assert.equal(state.budget.dispatch.used, charged, "and it does not charge a second time");
});

test("isDispatchable refuses every in-flight state", () => {
  const state = createDemoState();
  const task = taskById(state, "t2");
  for (const s of ["DISPATCHING", "RUNNING", "VERIFYING", "REVIEWING"]) {
    task.state = s;
    const verdict = isDispatchable(state, task);
    assert.equal(verdict.ok, false, `${s} must not be dispatchable`);
    assert.match(verdict.reason, /already in flight/);
  }
  // QUEUED is the ready state a dispatch consumes — it must remain dispatchable.
  for (const s of ["PLANNED", "QUEUED"]) {
    task.state = s;
    assert.equal(isDispatchable(state, task).ok, true, `${s} IS dispatchable`);
  }
});

test("/run refuses when Doer is OFF", () => {
  const state = createDemoState();
  runCommand(state, "/doer off");
  const result = runCommand(state, "/run g-1041");
  assert.equal(result.ok, false);
  assert.match(textOf(result), /Doer is OFF|nothing is dispatchable/i);
});

test("/doer off leaves GUARD on, and says so", () => {
  const state = createDemoState();
  const result = runCommand(state, "/doer off");
  assert.equal(result.ok, true);
  assert.equal(state.doer, "OFF");
  assert.equal(state.guard, "ON", "Doer and Guard are separate controls");
  assert.match(textOf(result), /Guard/, "the output says Guard is unaffected");
});

test("/guard has no off switch", () => {
  const state = createDemoState();
  const attempt = runCommand(state, "/guard off");
  assert.equal(attempt.ok, false, "an argument is not a state change here");
  assert.equal(state.guard, "ON", "Guard was not turned off");
});

test("/pause suspends autonomy; /resume re-validates the approval first", () => {
  const state = createDemoState();
  runCommand(state, "/pause g-1041");
  assert.equal(state.doer, "OFF");
  assert.equal(goalById(state, "g-1041").state, "PAUSED");

  const resumed = runCommand(state, "/resume g-1041");
  assert.equal(resumed.ok, true);
  assert.equal(state.doer, "ON");

  // With the approval cleared, resuming must refuse rather than dispatch.
  runCommand(state, "/goal plan g-1041");
  state.doer = "OFF";
  const refused = runCommand(state, "/resume g-1041");
  assert.equal(refused.ok, false);
  assert.match(textOf(refused), /no approved revision/);
});

test("a BLOCKED task is not dispatchable, and states why", () => {
  const state = createDemoState();
  const verdict = isDispatchable(state, taskById(state, "t4"));
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /blocked/);

  const inspected = runCommand(state, "/task inspect t4");
  assert.match(textOf(inspected), /budget exhausted/, "the reason is shown, not hidden");
});

test("a task bound to a different revision is refused", () => {
  const state = createDemoState();
  const task = taskById(state, "t2");
  task.revisionId = "rev_1"; // pretend it came from the unapproved plan
  const verdict = isDispatchable(state, task);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /rev_1.*rev_2|approved revision/);
});

test("task counts are derived, so the header can never disagree with the board", () => {
  const state = createDemoState();
  const counts = taskCounts(state);
  assert.equal(counts.total, 4);
  assert.equal(counts.COMPLETED, 1);
  assert.equal(counts.QUEUED, 1, "one task is ready to dispatch");
  assert.equal(counts.BLOCKED, 1);
  assert.equal(counts.CHANGES_REQUESTED, 1);
});

/* ── evidence honesty ────────────────────────────────────────────────────── */

test("evidence carries its SOURCE, and a worker's claim is marked unverified", () => {
  const state = createDemoState();
  const result = runCommand(state, "/evidence g-1041");
  const printed = textOf(result);
  assert.match(printed, /KAI-OBSERVED/);
  assert.match(printed, /WORKER-REPORTED/);
  assert.match(printed, /UNVERIFIED/, "the worker's claim is not presented as proof");
  assert.match(printed, /a claim is not proof|Limitation/);
});

test("/task inspect says plainly when there is NO evidence", () => {
  const state = createDemoState();
  const result = runCommand(state, "/task inspect t2");
  assert.match(textOf(result), /No evidence/);
  assert.match(textOf(result), /cannot be reported complete/);
});

/* ── the demo is unmistakable ────────────────────────────────────────────── */

test("state-reading commands carry the DEMO banner", () => {
  const state = createDemoState();
  for (const line of ["/goal list", "/workers", "/tasks", "/health", "/guard", "/approvals"]) {
    const result = runCommand(state, line);
    assert.ok(textOf(result).includes("DEMO DATA"), `${line} must mark its output as demo data`);
  }
});

test("an unknown worker or task is refused by name", () => {
  const state = createDemoState();
  assert.match(said(runCommand(state, "/worker inspect nobody")), /no worker "nobody"/);
  assert.match(said(runCommand(state, "/task inspect t99")), /no task "t99"/);
});

test("emitted events continue the DEMO clock, not the machine clock", () => {
  const state = createDemoState();
  const before = state.events.at(-1).at;
  runCommand(state, "/run g-1041");
  const swept = state.events.filter((e) => e.at > before);
  assert.ok(swept.length > 0, "the dispatch emitted events");
  for (const e of swept) {
    // Same fictional day as the fixtures, and always after the last fixture event.
    assert.match(e.at, /^09:(4[6-9]|[5-9][0-9]):[0-5][0-9]\.\d{3}$/, `event stamped ${e.at} is off the demo timeline`);
  }
  // Monotonic: a feed that goes backwards is a bug.
  const clock = state.events.map((e) => e.at);
  assert.deepEqual(clock, [...clock].sort(), "the event feed is monotonic");
});

test("command history records what the user actually typed", () => {
  const state = createDemoState();
  runCommand(state, "/tasks");
  runCommand(state, "/goal list");
  assert.deepEqual(state.history, ["/tasks", "/goal list"]);
});
