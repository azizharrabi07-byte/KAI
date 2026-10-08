// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Phase 1 Part P — the computer-use (CUA) foundation and its safety mechanisms.
 *
 * The four mechanisms below are the point of the task, so each has a test that
 * fails if the mechanism is removed rather than merely asserted in prose:
 *
 *   1. human hold blocks an agent action (and the driver never sees it)
 *   2. an unreachable control endpoint FAILS CLOSED (an action is refused)
 *   3. a stale timer cannot release an active lease
 *   4. an identical frame is suppressed, a changed one is not
 *   5. a control transition mid-sequence invalidates the result
 *
 * Everything runs against the FAKE transport — no real driver is spawned.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ControlLedger,
  createComputerSession,
  createControlProbeClient,
  createFakeTransport,
  frameFromData,
  isSupportedDriverVersion,
  MINIMUM_DRIVER_VERSION,
  ObservationDeduper,
  parseDriverVersion,
  type ControlEndpoint,
  type GuardFailure,
} from "../src/capabilities/computer/index.ts";

/** Narrow a guarded failure, failing loudly if the call unexpectedly succeeded. */
function expectFailure<T extends { ok: boolean }>(result: T): GuardFailure {
  if (result.ok) {
    assert.fail("expected the call to be refused or invalidated, but it succeeded");
  }
  // `assert.fail` is `never`, so TS narrows the remainder to the failure branch.
  return result as unknown as GuardFailure;
}

// ── 1. Human control hold ─────────────────────────────────────────────────────

test("human control hold blocks an agent action and the driver never sees it", async () => {
  const ledger = new ControlLedger();
  const fake = createFakeTransport();
  const session = createComputerSession({ transport: fake, control: ledger });

  ledger.takeByHuman();

  const result = await session.click({ x: 5, y: 6 });
  const failure = expectFailure(result);

  assert.equal(failure.reason, "human_hold");
  assert.equal(failure.error.code, "POLICY_DENIED");
  assert.equal(failure.performedButInvalidated, false);
  assert.equal(fake.calls.act.length, 0, "a refused click must never reach the driver");

  // The same rule applies to every input action, not just click.
  const typed = await session.type("rm -rf /");
  assert.equal(expectFailure(typed).reason, "human_hold");
  assert.equal(fake.calls.act.length, 0);
});

test("an ongoing human hold also blocks observation and inspection", async () => {
  const ledger = new ControlLedger();
  const fake = createFakeTransport();
  const session = createComputerSession({ transport: fake, control: ledger });

  ledger.takeByHuman();

  const observed = await session.observe();
  assert.equal(expectFailure(observed).reason, "human_hold");
  const inspected = await session.inspect();
  assert.equal(expectFailure(inspected).reason, "human_hold");

  assert.equal(fake.calls.observe, 0, "the driver must not screenshot while a person holds the wheel");
  assert.equal(fake.calls.inspect, 0);
});

test("the agent can only ASK for the wheel; requestHelp never grants control", async () => {
  const ledger = new ControlLedger();
  const snapshot = await ledger.requestHelp("please take over");

  assert.equal(snapshot.holder, "none", "asking must not make the agent the holder");
  assert.equal(snapshot.held, false);
  assert.equal(snapshot.helpReason, "please take over");

  // And an agent cannot clear a human hold through the lease API.
  const acquired = ledger.acquireLease("agent-1");
  assert.ok(acquired.lease);
  ledger.takeByHuman();
  const release = ledger.releaseLease(acquired.lease);
  assert.equal(release.released, false, "a human hold cannot be released by an agent lease");
  assert.equal(ledger.read().holder, "human");
});

// ── 2. Fail closed ────────────────────────────────────────────────────────────

test("an unreachable control endpoint fails CLOSED: the action is refused, not allowed", async () => {
  const deadEndpoint: ControlEndpoint = {
    label: "dead-control",
    async read() {
      throw new Error("ECONNREFUSED");
    },
  };
  const fake = createFakeTransport();
  const session = createComputerSession({
    transport: fake,
    control: createControlProbeClient({ endpoint: deadEndpoint }),
  });

  const result = await session.click({ x: 1, y: 1 });
  const failure = expectFailure(result);

  assert.equal(failure.reason, "human_hold", "unreachable is treated as HELD");
  assert.equal(failure.error.code, "POLICY_DENIED");
  assert.match(failure.error.message, /unreachable|fail closed/i);
  assert.equal(fake.calls.act.length, 0, "the driver must not be invoked when control is unknown");
});

test("a control endpoint that answers 'not held' lets the action through (the refusal is not unconditional)", async () => {
  const liveEndpoint: ControlEndpoint = {
    label: "live-control",
    async read() {
      return { held: false, generation: 1 };
    },
  };
  const fake = createFakeTransport();
  const session = createComputerSession({
    transport: fake,
    control: createControlProbeClient({ endpoint: liveEndpoint }),
  });

  const result = await session.click({ x: 1, y: 1 });
  assert.equal(result.ok, true, "a reachable, unheld control reading permits the action");
  assert.equal(fake.calls.act.length, 1);
});

// ── 3. Stale lease protection ─────────────────────────────────────────────────

test("a stale timer cannot release a newer, active lease", () => {
  const ledger = new ControlLedger();

  const first = ledger.acquireLease("agent-1");
  assert.equal(first.acquired, true);
  assert.ok(first.lease, "an acquired lease must carry a handle");
  const staleHandle = first.lease;

  // The lease is superseded: the human takes over, hands back, and a NEW lease
  // is acquired. The first lease's expiry timer has not fired yet.
  ledger.takeByHuman();
  ledger.releaseByHuman();
  const second = ledger.acquireLease("agent-1");
  assert.equal(second.acquired, true);
  assert.ok(second.lease);
  assert.ok(ledger.ownsLease(second.lease), "the newer lease is active");

  // The old timer fires.
  const release = ledger.releaseLease(staleHandle);
  assert.equal(release.released, false, "a stale timer must NOT release a newer lease");
  assert.equal(release.stale, true);
  assert.ok(ledger.ownsLease(second.lease), "the live lease must still own the machine");
  assert.equal(ledger.read().holder, "agent");

  // The live lease can still release itself.
  assert.equal(ledger.releaseLease(second.lease).released, true);
  assert.equal(ledger.read().holder, "none");
});

// ── 4. Observation deduplication ──────────────────────────────────────────────

test("an identical frame is suppressed, a changed one is not, and the hash is reported", async () => {
  const ledger = new ControlLedger();
  const fake = createFakeTransport();
  const session = createComputerSession({ transport: fake, control: ledger });

  const first = await session.observe();
  if (!first.ok) return assert.fail("first observe should succeed");
  assert.equal(first.suppressed, false, "the first frame is always sent");
  assert.equal(typeof first.hash, "string");
  assert.ok(first.value);

  const second = await session.observe();
  if (!second.ok) return assert.fail("second observe should succeed");
  assert.equal(second.suppressed, true, "a byte-identical frame is suppressed");
  assert.equal(second.value, null, "a suppressed frame withholds its payload");
  assert.equal(second.hash, first.hash, "the hash is still reported when suppressed");

  // The screen changes.
  fake.setFrame(frameFromData("frame-0002"));
  const third = await session.observe();
  if (!third.ok) return assert.fail("third observe should succeed");
  assert.equal(third.suppressed, false, "a changed frame is NOT suppressed");
  assert.notEqual(third.hash, first.hash);
  assert.ok(third.value);

  assert.deepEqual(session.observationStats(), { captured: 3, sent: 2 });
  assert.equal(fake.calls.observe, 3, "every observation still captures fresh pixels");
});

test("deduplication fails OPEN when the driver cannot hash a frame", () => {
  const deduper = new ObservationDeduper();
  const first = deduper.note(null);
  const second = deduper.note(null);
  assert.equal(first.suppressed, false);
  assert.equal(second.suppressed, false, "an unhashed frame is never suppressed");
  assert.equal(second.hash, null);
  assert.deepEqual(deduper.stats(), { captured: 2, sent: 2 });
});

// ── 5. Transition protection ──────────────────────────────────────────────────

test("a control transition during an observation invalidates the result", async () => {
  const ledger = new ControlLedger();
  const fake = createFakeTransport({
    hooks: {
      onObserve() {
        // The human grabs the wheel while the screenshot is in flight.
        ledger.takeByHuman();
      },
    },
  });
  const session = createComputerSession({ transport: fake, control: ledger });

  const result = await session.observe();
  const failure = expectFailure(result);

  assert.equal(failure.reason, "control_changed");
  assert.equal(failure.error.code, "AGENT_RUN_FAILED");
  assert.equal(failure.performedButInvalidated, true, "the observation happened but is untrustworthy");
  assert.equal(failure.control.held, true, "the post-read reports the human now holds");
});

test("a control transition during an action invalidates the action result", async () => {
  const ledger = new ControlLedger();
  const fake = createFakeTransport({
    hooks: {
      onAct() {
        ledger.takeByHuman();
      },
    },
  });
  const session = createComputerSession({ transport: fake, control: ledger });

  const result = await session.click({ x: 10, y: 20 });
  const failure = expectFailure(result);

  assert.equal(failure.reason, "control_changed");
  assert.equal(failure.error.code, "AGENT_RUN_FAILED");
  assert.equal(failure.performedButInvalidated, true);
  assert.equal(fake.calls.act.length, 1, "the driver ran, but its result was discarded");
});

// ── Driver contract check (re-derived for 0.28.2) ─────────────────────────────

test("the driver version floor is re-derived for 0.28.2, not copied from upstream", () => {
  assert.equal(MINIMUM_DRIVER_VERSION, "0.28.2");
  assert.equal(isSupportedDriverVersion("0.28.2"), true);
  assert.equal(isSupportedDriverVersion("cua-driver 0.28.2"), true);
  assert.equal(isSupportedDriverVersion("0.29.0"), true, "a later 0.x is allowed");
  assert.equal(isSupportedDriverVersion("0.19.3"), false, "upstream's pin is not this machine's floor");
  assert.equal(isSupportedDriverVersion("0.20.0"), false);
  assert.equal(isSupportedDriverVersion("garbage"), false, "an unreadable version is never supported");
  assert.deepEqual(parseDriverVersion("v0.28.2"), { major: 0, minor: 28, patch: 2, raw: "v0.28.2" });
});

// ── Honest reporting: the transport is fake-backed ───────────────────────────

test("the transport backing is reported honestly as fake in this phase", () => {
  const fake = createFakeTransport();
  assert.equal(fake.endpoint.kind, "fake");
  const session = createComputerSession({ transport: fake, control: new ControlLedger() });
  assert.equal(session.transport.endpoint.kind, "fake", "no real driver is wired in this phase");
});
