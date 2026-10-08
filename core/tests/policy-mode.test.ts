// Phase 1 Parts E/F/G — policy that can change at runtime without loosening.
//
// The properties under test are the ones that would be security bugs if they
// silently flipped:
//
//   * the default mode behaves exactly as KAI always has (no silent loosening)
//   * no mode ever auto-allows EXTERNAL or DESTRUCTIVE
//   * an elevation that was requested but not CONFIRMED has no effect
//   * a downgrade cannot be blocked, by anyone, ever
//   * a live rule change affects the very next decision
//   * a worker cannot raise its own authority

import { test } from "node:test";
import assert from "node:assert/strict";

import { createPolicyEngine } from "../src/policies/gate.ts";
import {
  BASELINE_MODE,
  cancelElevation,
  confirmElevation,
  downgrade,
  effectiveMode,
  initialPolicyState,
  isElevation,
  requestElevation,
  modeRank,
} from "../src/policies/mode.ts";
import { type PolicyMode, type RiskLevel } from "../src/shared/contracts.ts";

const RISKS: readonly RiskLevel[] = ["READ", "WRITE", "EXTERNAL", "DESTRUCTIVE"];

// ── The default mode must be byte-for-byte KAI's historical behaviour ─────────

test("the baseline mode is normal, and normal reproduces today's table", async () => {
  assert.equal(BASELINE_MODE, "normal");
  const gate = createPolicyEngine({});
  const expected: Record<RiskLevel, string> = {
    READ: "allow",
    WRITE: "needs_approval",
    EXTERNAL: "needs_approval",
    DESTRUCTIVE: "needs_approval",
  };
  for (const risk of RISKS) {
    const decision = await gate.check({ toolId: "t", action: "a", risk });
    assert.equal(decision.outcome, expected[risk], `${risk} in normal mode`);
    // and it reports itself as the plain default, not as a mode override
    assert.equal(decision.source, "default", `${risk} source`);
  }
});

test("a mode can only be reached through the mode API, never by omission", () => {
  assert.equal(modeRank("ask-all") < modeRank("normal"), true);
  assert.equal(modeRank("normal") < modeRank("auto-read"), true);
  assert.equal(modeRank("auto-read") < modeRank("elevated"), true);
  assert.equal(isElevation("normal", "elevated"), true);
  assert.equal(isElevation("elevated", "normal"), false, "a downgrade is not an elevation");
});

// ── No mode may auto-allow the dangerous end of the taxonomy ──────────────────

test("no mode ever auto-allows EXTERNAL or DESTRUCTIVE", async () => {
  const modes: PolicyMode[] = ["ask-all", "normal", "auto-read", "elevated"];
  for (const mode of modes) {
    const gate = createPolicyEngine({ mode });
    for (const risk of ["EXTERNAL", "DESTRUCTIVE"] as const) {
      const decision = await gate.check({ toolId: "danger", action: "act", risk });
      assert.equal(
        decision.outcome,
        "needs_approval",
        `mode "${mode}" must not allow ${risk} unattended`,
      );
    }
  }
});

test("ask-all is stricter than normal: even READ needs a human", async () => {
  const gate = createPolicyEngine({ mode: "ask-all" });
  const decision = await gate.check({ toolId: "safe.read", action: "read", risk: "READ" });
  assert.equal(decision.outcome, "needs_approval");
  assert.equal(decision.source, "mode:ask-all");
});

test("elevated allows WRITE but still asks for EXTERNAL and DESTRUCTIVE", async () => {
  const gate = createPolicyEngine({ mode: "elevated" });
  assert.equal((await gate.check({ toolId: "w", action: "write", risk: "WRITE" })).outcome, "allow");
  assert.equal((await gate.check({ toolId: "x", action: "call", risk: "EXTERNAL" })).outcome, "needs_approval");
  assert.equal((await gate.check({ toolId: "d", action: "rm", risk: "DESTRUCTIVE" })).outcome, "needs_approval");
});

// ── Two-phase elevation, fail closed ─────────────────────────────────────────

test("an unconfirmed elevation has no effect: the confirmed mode stays in force", async () => {
  const gate = createPolicyEngine({});
  const requested = gate.requestElevation({
    to: "elevated",
    scope: { kind: "mission", id: "m-1" },
    requestedBy: "owner",
  });
  assert.equal(requested.ok, true);
  // Prepared, but NOT in force.
  assert.equal(gate.mode(), "normal");
  const decision = await gate.check({ toolId: "w", action: "write", risk: "WRITE" });
  assert.equal(decision.outcome, "needs_approval", "a prepared elevation must not loosen anything yet");
});

test("confirming with the wrong request id cannot commit someone else's elevation", () => {
  let state = initialPolicyState(new Date("2026-10-02T10:00:00Z"));
  const requested = requestElevation(state, {
    to: "elevated",
    scope: { kind: "thread", id: "t-1" },
    requestedBy: "owner",
    requestId: "req-A",
    now: new Date("2026-10-02T10:00:00Z"),
  });
  assert.ok(requested.ok);
  state = requested.state;

  const mismatched = confirmElevation(state, { requestId: "req-B", confirmedBy: "owner" });
  assert.equal(mismatched.ok, false);
  assert.equal(effectiveMode(state).mode, "normal", "still normal");
});

test("only the owner may elevate, and a worker cannot raise its own authority", async () => {
  const gate = createPolicyEngine({});
  const byWorker = gate.requestElevation({
    to: "elevated",
    scope: { kind: "employee", id: "hermes" },
    requestedBy: "worker:hermes",
  });
  assert.equal(byWorker.ok, false);
  assert.match(byWorker.reason, /only the owner/);
  assert.equal(gate.mode(), "normal");

  const byAgent = gate.requestElevation({
    to: "elevated",
    scope: { kind: "employee", id: "kai" },
    requestedBy: "agent",
  });
  assert.equal(byAgent.ok, false);
  assert.equal(gate.mode(), "normal");
});

test("elevated may not be scoped globally — no accidental inheritance", () => {
  const state = initialPolicyState();
  const global = requestElevation(state, {
    to: "elevated",
    scope: { kind: "global" },
    requestedBy: "owner",
    requestId: "req-1",
  });
  assert.equal(global.ok, false);
  assert.match(global.reason, /globally/);
});

test("a scope without an id is refused: a nameless scope means everywhere", () => {
  const state = initialPolicyState();
  const nameless = requestElevation(state, {
    to: "auto-read",
    scope: { kind: "thread" },
    requestedBy: "owner",
    requestId: "req-2",
  });
  assert.equal(nameless.ok, false);
  assert.match(nameless.reason, /explicit scope/);
});

test("a confirmed elevation takes effect, and can be cancelled while pending", () => {
  let state = initialPolicyState(new Date("2026-10-02T10:00:00Z"));
  const requested = requestElevation(state, {
    to: "auto-read",
    scope: { kind: "thread", id: "t-9" },
    requestedBy: "owner",
    requestId: "req-9",
    now: new Date("2026-10-02T10:00:00Z"),
  });
  assert.ok(requested.ok);
  state = requested.state;

  const cancelled = cancelElevation(state, new Date("2026-10-02T10:01:00Z"));
  assert.ok(cancelled.ok);
  assert.equal(effectiveMode(cancelled.state).mode, "normal");
  assert.equal(cancelled.state.pending, undefined);

  const requoted = requestElevation(state, {
    to: "auto-read",
    scope: { kind: "thread", id: "t-9" },
    requestedBy: "owner",
    requestId: "req-9",
    now: new Date("2026-10-02T10:02:00Z"),
  });
  assert.ok(requoted.ok);
  const confirmed = confirmElevation(requoted.state, {
    requestId: "req-9",
    confirmedBy: "owner",
    now: new Date("2026-10-02T10:03:00Z"),
  });
  assert.ok(confirmed.ok);
  assert.equal(effectiveMode(confirmed.state).mode, "auto-read");
});

// ── Downgrade is never blocked ───────────────────────────────────────────────

test("a downgrade cannot be blocked, even with an elevation pending", () => {
  let state = initialPolicyState();
  const requested = requestElevation(state, {
    to: "elevated",
    scope: { kind: "mission", id: "m-2" },
    requestedBy: "owner",
    requestId: "req-3",
  });
  assert.ok(requested.ok);
  state = requested.state;

  const dropped = downgrade(state, { to: "ask-all", reason: "user slammed the brakes" });
  assert.ok(dropped.ok, "reducing authority must always succeed");
  assert.equal(dropped.state.mode, "ask-all");
  assert.equal(dropped.state.pending, undefined, "a downgrade also clears the pending elevation");
});

test("the emergency path always lands on the baseline", () => {
  const state = { ...initialPolicyState(new Date("2026-10-02T10:00:00Z")), mode: "elevated" as PolicyMode };
  const dropped = downgrade(state, { reason: "emergency" });
  assert.ok(dropped.ok);
  assert.equal(dropped.state.mode, "normal");
});

// ── Live rules and the audit trail ───────────────────────────────────────────

test("a live rule change affects the very next decision", async () => {
  const gate = createPolicyEngine({});
  assert.equal((await gate.check({ toolId: "demo.write", action: "w", risk: "WRITE" })).outcome, "needs_approval");

  const applied = gate.setRules([{ id: "allow-demo-write", risk: "WRITE", outcome: "allow", tools: ["demo.write"] }]);
  assert.equal(applied.applied, 1);
  assert.equal(applied.dropped, 0);

  const after = await gate.check({ toolId: "demo.write", action: "w", risk: "WRITE" });
  assert.equal(after.outcome, "allow");
  assert.equal(after.source, "rule:allow-demo-write", "the decision must name the rule that decided");
  // and the change did not leak to other tools
  assert.equal((await gate.check({ toolId: "other.write", action: "w", risk: "WRITE" })).outcome, "needs_approval");
});

test("a malformed live rule is dropped, leaving the safe default in place", async () => {
  const gate = createPolicyEngine({});
  const applied = gate.setRules([
    { id: "", risk: "WRITE", outcome: "allow" } as never,
    { id: "bad-risk", risk: "NOPE" as never, outcome: "allow" },
    { id: "good", risk: "WRITE", outcome: "allow", tools: ["demo.write"] },
  ]);
  assert.equal(applied.applied, 1);
  assert.equal(applied.dropped, 2);
  assert.equal((await gate.check({ toolId: "demo.write", action: "w", risk: "WRITE" })).outcome, "allow");
  assert.equal((await gate.check({ toolId: "anything.write", action: "w", risk: "WRITE" })).outcome, "needs_approval");
});

test("every decision names its authority, and the audit sink sees them", async () => {
  const seen: string[] = [];
  const gate = createPolicyEngine({
    rules: [{ id: "r1", risk: "EXTERNAL", outcome: "deny", tools: ["net.call"] }],
    onDecision: (decision) => seen.push(decision.source),
  });

  const byRule = await gate.check({ toolId: "net.call", action: "call", risk: "EXTERNAL" });
  assert.equal(byRule.source, "rule:r1");
  const byDefault = await gate.check({ toolId: "safe", action: "read", risk: "READ" });
  assert.equal(byDefault.source, "default");
  const unknown = await gate.check({ toolId: "weird", action: "x", risk: "MADE_UP" as never });
  assert.equal(unknown.source, "unknown-risk");

  assert.deepEqual(seen, ["rule:r1", "default", "unknown-risk"]);
});

test("a throwing audit sink cannot break a decision", async () => {
  const gate = createPolicyEngine({
    onDecision: () => {
      throw new Error("the audit log is down");
    },
  });
  // An audit log that can veto a decision has become a second gate.
  const decision = await gate.check({ toolId: "safe", action: "read", risk: "READ" });
  assert.equal(decision.outcome, "allow");
});

test("the mode is observable with a reason, so a UI can say why it is not in force yet", () => {
  const state = initialPolicyState();
  const requested = requestElevation(state, {
    to: "elevated",
    scope: { kind: "thread", id: "t-1" },
    requestedBy: "owner",
    requestId: "req-obs",
  });
  assert.ok(requested.ok);
  const inForce = effectiveMode(requested.state);
  assert.equal(inForce.mode, "normal");
  assert.match(inForce.reason, /prepared but unconfirmed/);
});
