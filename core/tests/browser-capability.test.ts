// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Browser capability tests. Plain `node --test`, no deps.
 * Run from `core/`:  node --test tests/browser-capability.test.ts
 *
 * These prove the four things the design promises:
 *   1. the semantic-first hierarchy is honoured (semantics over pixels),
 *   2. pixels are used only when semantics are genuinely unavailable,
 *   3. target/session ownership is exclusive,
 *   4. a re-inspection happens only when the page revision really moved — asserted
 *      from the strategy log, not from counting wall-clock calls.
 * Plus the full action set routes, and every failure is a value.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createFakeTransport } from "../src/capabilities/browser/fake-transport.ts";
import { createBrowserCapability } from "../src/capabilities/browser/capability.ts";
import { createOwnershipRegistry } from "../src/capabilities/browser/ownership.ts";
import {
  INTERACTION_HIERARCHY,
  NO_AFFORDANCES,
  selectStrategy,
  type TransportAffordances,
} from "../src/capabilities/browser/interaction.ts";
import {
  BROWSER_ACTIONS,
  type Result,
  type TargetInfo,
} from "../src/capabilities/browser/transport.ts";
import type { OwnershipRegistry, TargetLease } from "../src/capabilities/browser/ownership.ts";
import type {
  ActionResult,
  CallerContext,
  InspectionResult,
} from "../src/capabilities/browser/capability.ts";

const AGENT_A: CallerContext = { ownerId: "agent-A" };
const AGENT_B: CallerContext = { ownerId: "agent-B" };

/** Asserts a Result is a success and returns its value, so the tests read cleanly. */
function mustOk<T>(result: Result<T>): T {
  assert.equal(
    result.ok,
    true,
    result.ok ? "" : `expected success, got ${result.error.code}: ${result.error.message}`,
  );
  if (!result.ok) throw new Error("unreachable");
  return result.value;
}

interface OpenValue {
  action: string;
  target: TargetInfo;
  lease: TargetLease;
  active: boolean;
}

function rig(
  options: { affordances?: Partial<TransportAffordances>; ownership?: OwnershipRegistry } = {},
): {
  transport: ReturnType<typeof createFakeTransport>;
  capability: ReturnType<typeof createBrowserCapability>;
} {
  const transport = createFakeTransport({
    ...(options.affordances !== undefined ? { affordances: options.affordances } : {}),
  });
  const capability = createBrowserCapability({
    transport,
    ...(options.ownership !== undefined ? { ownership: options.ownership } : {}),
  });
  return { transport, capability };
}

/** Opens a target as AGENT_A and returns its id. */
async function openForA(
  capability: ReturnType<typeof createBrowserCapability>,
  url = "https://example.test",
): Promise<{ targetId: string; lease: TargetLease }> {
  const opened = mustOk(await capability.invoke("open", { url }, AGENT_A)) as OpenValue;
  return { targetId: opened.target.targetId, lease: opened.lease };
}

// ── 1. The interaction hierarchy (pure selection) ─────────────────────────────

test("selectStrategy prefers the highest-fidelity channel, never pixels while semantics exist", () => {
  const all: TransportAffordances = {
    nativeApi: true,
    dom: true,
    accessibility: true,
    semanticUi: true,
    screenshot: true,
  };
  const top = selectStrategy(all);
  assert.equal(top.strategy, "native_api");
  assert.equal(top.fallbackToPixels, false);

  const domOnly = selectStrategy({ ...NO_AFFORDANCES, dom: true, screenshot: true });
  assert.equal(domOnly.strategy, "dom", "DOM beats the screenshot fallback");

  const a11yOnly = selectStrategy({ ...NO_AFFORDANCES, accessibility: true, screenshot: true });
  assert.equal(a11yOnly.strategy, "accessibility");

  const uiOnly = selectStrategy({ ...NO_AFFORDANCES, semanticUi: true, screenshot: true });
  assert.equal(uiOnly.strategy, "semantic_ui");

  const pixels = selectStrategy({ ...NO_AFFORDANCES, screenshot: true });
  assert.equal(pixels.strategy, "screenshot");
  assert.equal(pixels.fallbackToPixels, true);
  assert.match(pixels.reason, /fallback|no semantic/i);

  // Every decision records the ladder it considered, in hierarchy order.
  assert.deepEqual(
    [...pixels.considered].map((candidate) => candidate.strategy),
    [...INTERACTION_HIERARCHY],
  );
  assert.equal(pixels.considered.find((c) => c.strategy === "dom")?.available, false);
});

test("a transport that withholds semantics drives selection down the ladder honestly", () => {
  // native API withheld, DOM withheld; accessibility survives.
  const decision = selectStrategy({ ...NO_AFFORDANCES, accessibility: true, screenshot: true });
  assert.equal(decision.strategy, "accessibility");
  const whyNative = decision.considered.find((c) => c.strategy === "native_api");
  assert.equal(whyNative?.available, false);
  assert.match(whyNative?.detail ?? "", /not available/);
});

// ── 2. The capability drives over semantics, never over pixels ────────────────

test("actions run over semantics and pixels are never touched while semantics are available", async () => {
  const { transport, capability } = rig(); // default fake: native API + DOM + a11y + screenshot

  const { targetId } = await openForA(capability);
  const inspected = mustOk(
    await capability.observe(AGENT_A, { targetId }),
  ) as InspectionResult;
  assert.equal(inspected.decision.strategy, "native_api");
  assert.equal(inspected.decision.fallbackToPixels, false);

  const clicked = mustOk(
    await capability.invoke("click", { targetId, ref: "e2" }, AGENT_A),
  ) as ActionResult;
  assert.equal(clicked.strategy, "native_api");
  assert.equal(clicked.changed, true, "the fake bumps the revision on a click");

  mustOk(await capability.invoke("read", { targetId }, AGENT_A));

  assert.equal(
    transport.stats().screenshotCalls,
    0,
    "the pixel channel must never be used while a semantic channel exists",
  );
  for (const entry of capability.strategyLog()) {
    assert.notEqual(entry.strategy, "screenshot", `log entry ${entry.seq} fell back to pixels`);
    assert.equal(entry.fallbackToPixels, false);
  }
});

// ── 3. Screenshot fallback only when semantics are unavailable ────────────────

test("with every semantic channel withheld, the capability falls back to pixels and says so", async () => {
  const { transport, capability } = rig({
    affordances: { nativeApi: false, dom: false, accessibility: false, semanticUi: false, screenshot: true },
  });

  // The capability reports itself degraded, not available: pixels are not parity.
  const health = await capability.health();
  assert.equal(health.availability, "DEGRADED");
  assert.match(health.detail ?? "", /screenshot|pixel/i);

  const { targetId } = await openForA(capability);
  const inspected = mustOk(await capability.observe(AGENT_A, { targetId })) as InspectionResult;
  assert.equal(inspected.decision.strategy, "screenshot");
  assert.equal(inspected.decision.fallbackToPixels, true);
  assert.ok(inspected.page.screenshot, "the pixel channel returns an opaque reference");
  assert.equal(inspected.page.elements, undefined, "pixels yield no addressable elements");
  assert.ok(transport.stats().screenshotCalls >= 1);
  assert.equal(transport.stats().observeCalls, 0, "no semantic observation happened");

  // find needs structure; it must refuse rather than pretend.
  const found = await capability.invoke("find", { targetId, query: "Go" }, AGENT_A);
  assert.equal(found.ok, false);
  if (!found.ok) assert.equal(found.error.code, "INTERNAL");

  // A transport with no channel at all is UNAVAILABLE.
  const none = rig({
    affordances: { nativeApi: false, dom: false, accessibility: false, semanticUi: false, screenshot: false },
  });
  assert.equal((await none.capability.health()).availability, "UNAVAILABLE");
});

// ── 4. Exclusive target/session ownership ─────────────────────────────────────

test("a second agent cannot drive, or lease, a target owned by another agent", async () => {
  const ownership = createOwnershipRegistry();
  const { capability } = rig({ ownership });
  const { targetId, lease } = await openForA(capability);

  // The capability refuses a driving action by a non-owner.
  const denied = await capability.invoke("click", { targetId, ref: "e2" }, AGENT_B);
  assert.equal(denied.ok, false);
  if (!denied.ok) {
    assert.equal(denied.error.code, "POLICY_DENIED");
    assert.match(denied.error.message, /does not own/);
  }

  // And the ownership layer refuses a competing acquire.
  const competing = ownership.acquire(targetId, "agent-B");
  assert.equal(competing.ok, false);
  if (!competing.ok) assert.equal(competing.error.code, "POLICY_DENIED");

  // Re-acquiring as the current owner is idempotent: same lease, not a new one.
  const again = ownership.acquire(targetId, "agent-A");
  assert.equal(again.ok, true);
  if (again.ok) assert.equal(again.value.leaseId, lease.leaseId);

  // A read action is refused too: ownership gates every action on the target.
  const readDenied = await capability.invoke("read", { targetId }, AGENT_B);
  assert.equal(readDenied.ok, false);
  if (!readDenied.ok) assert.equal(readDenied.error.code, "POLICY_DENIED");
});

test("two agents may each own a different target concurrently", async () => {
  const { capability } = rig();
  const a = await openForA(capability, "https://a.test");
  const bOpen = mustOk(await capability.invoke("open", { url: "https://b.test" }, AGENT_B)) as OpenValue;

  assert.equal((await capability.invoke("click", { targetId: a.targetId, ref: "e2" }, AGENT_A)).ok, true);
  assert.equal(
    (await capability.invoke("click", { targetId: bOpen.target.targetId, ref: "e2" }, AGENT_B)).ok,
    true,
  );
  // Cross-driving is still refused.
  const cross = await capability.invoke("click", { targetId: bOpen.target.targetId, ref: "e2" }, AGENT_A);
  assert.equal(cross.ok, false);
});

test("close_tab releases the lease and clears the owner's active target", async () => {
  const ownership = createOwnershipRegistry();
  const { capability } = rig({ ownership });
  const { targetId } = await openForA(capability);
  assert.equal(capability.activeTarget("agent-A"), targetId);

  mustOk(await capability.invoke("close_tab", { targetId }, AGENT_A));
  assert.equal(ownership.ownerOf(targetId), null, "the lease is released on close");
  assert.equal(capability.activeTarget("agent-A"), null);
  assert.equal(capability.leases().length, 0);

  // The closed target is gone, so even its former owner now gets NOT_FOUND.
  const after = await capability.invoke("inspect", { targetId }, AGENT_A);
  assert.equal(after.ok, false);
  if (!after.ok) assert.equal(after.error.code, "NOT_FOUND");
});

test("switch_tab changes only the owner's active target and is ownership-checked", async () => {
  const { capability } = rig();
  const first = await openForA(capability, "https://first.test");
  const second = mustOk(
    await capability.invoke("new_tab", { url: "https://second.test" }, AGENT_A),
  ) as OpenValue;

  assert.equal(capability.activeTarget("agent-A"), second.target.targetId);
  mustOk(await capability.invoke("switch_tab", { targetId: first.targetId }, AGENT_A));
  assert.equal(capability.activeTarget("agent-A"), first.targetId);

  // Another agent cannot switch to (or drive) a tab it does not own.
  const denied = await capability.invoke("switch_tab", { targetId: first.targetId }, AGENT_B);
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.error.code, "POLICY_DENIED");
});

// ── 5. Re-inspect only when state actually changed ────────────────────────────

test("a re-inspection happens only after the transport revision moves", async () => {
  const { transport, capability } = rig();
  const { targetId } = await openForA(capability);

  const first = mustOk(await capability.observe(AGENT_A, { targetId })) as InspectionResult;
  assert.equal(first.reInspected, true, "the first look always inspects");
  assert.equal(first.reusedCached, false);

  const second = mustOk(await capability.observe(AGENT_A, { targetId })) as InspectionResult;
  assert.equal(second.reInspected, false, "nothing changed, so nothing was re-inspected");
  assert.equal(second.reusedCached, true);
  assert.equal(transport.stats().observeCalls, 1, "the transport was not asked to observe again");

  // A scroll that changes nothing must NOT trigger a re-inspection.
  const scrolled = mustOk(
    await capability.invoke("scroll", { targetId, direction: "down" }, AGENT_A),
  ) as ActionResult;
  assert.equal(scrolled.changed, false);
  const third = mustOk(await capability.observe(AGENT_A, { targetId })) as InspectionResult;
  assert.equal(third.reusedCached, true);
  assert.equal(transport.stats().observeCalls, 1);

  // A click that really changes the page must trigger exactly one re-inspection.
  const clicked = mustOk(
    await capability.invoke("click", { targetId, ref: "e2" }, AGENT_A),
  ) as ActionResult;
  assert.equal(clicked.changed, true);
  const fourth = mustOk(await capability.observe(AGENT_A, { targetId })) as InspectionResult;
  assert.equal(fourth.reInspected, true);
  assert.equal(transport.stats().observeCalls, 2);

  // Verified from the strategy log (not wall-clock calls) and from the revisions.
  const inspectFlags = capability.strategyLog().filter((e) => e.action === "inspect").map((e) => e.reInspected);
  assert.deepEqual(inspectFlags, [true, false, false, true]);
  assert.equal(first.revision, 1);
  assert.equal(fourth.revision, 2, "a real state change advanced the revision the observation carries");

  // force re-inspects even when the revision is unchanged.
  const forced = mustOk(await capability.observe(AGENT_A, { targetId, force: true })) as InspectionResult;
  assert.equal(forced.reInspected, true);
  assert.equal(transport.stats().observeCalls, 3);
});

// ── 6. The whole action set routes; failures are values ───────────────────────

test("every advertised action routes through the capability and succeeds", async () => {
  const { capability } = rig();
  assert.deepEqual([...capability.supportedActions], [...BROWSER_ACTIONS]);

  const opened = mustOk(
    await capability.invoke("open", { url: "https://start.test" }, AGENT_A),
  ) as OpenValue;
  const targetId = opened.target.targetId;

  const cases: readonly (readonly [string, Record<string, unknown>])[] = [
    ["navigate", { targetId, url: "https://nav.test" }],
    ["inspect", { targetId }],
    ["find", { targetId, query: "Go" }],
    ["click", { targetId, ref: "e2" }],
    ["type", { targetId, ref: "e1", text: "hello" }],
    ["select", { targetId, ref: "e1", value: "x" }],
    ["scroll", { targetId, direction: "down" }],
    ["wait", { targetId }],
    ["read", { targetId }],
    ["back", { targetId }],
    ["forward", { targetId }],
    ["new_tab", { url: "https://second.test" }],
    ["switch_tab", { targetId }],
    ["close_tab", { targetId }],
  ];

  for (const [action, input] of cases) {
    const result = await capability.invoke(action, input, AGENT_A);
    assert.equal(
      result.ok,
      true,
      result.ok ? action : `${action} failed: ${result.error.code} — ${result.error.message}`,
    );
  }

  // find returns real matches from the semantic observation.
  const second = mustOk(
    await capability.invoke("open", { url: "https://find.test" }, AGENT_A),
  ) as OpenValue;
  const matches = mustOk(
    await capability.invoke("find", { targetId: second.target.targetId, query: "Go" }, AGENT_A),
  ) as { count: number; matches: readonly { ref: string }[] };
  assert.equal(matches.count, 1);
  assert.equal(matches.matches[0]!.ref, "e2");
});

test("bad input, unknown actions and unknown targets are values, never throws", async () => {
  const { capability } = rig();

  const unknownAction = await capability.invoke("teleport", {}, AGENT_A);
  assert.equal(unknownAction.ok, false);
  if (!unknownAction.ok) {
    assert.equal(unknownAction.error.code, "VALIDATION_FAILED");
    assert.match(unknownAction.error.message, /unknown browser action/);
  }

  const noOwner = await capability.invoke("inspect", { targetId: "t1" }, {} as CallerContext);
  assert.equal(noOwner.ok, false);
  if (!noOwner.ok) assert.equal(noOwner.error.code, "VALIDATION_FAILED");

  const missingRef = await capability.invoke("click", { targetId: "t1" }, AGENT_A);
  assert.equal(missingRef.ok, false);
  if (!missingRef.ok) {
    assert.equal(missingRef.error.code, "VALIDATION_FAILED");
    assert.match(missingRef.error.message, /"ref" is required/);
  }

  const unknownKey = await capability.invoke("inspect", { targetId: "t1", wat: true }, AGENT_A);
  assert.equal(unknownKey.ok, false);
  if (!unknownKey.ok) assert.match(unknownKey.error.message, /unknown option/);

  const unknownTarget = await capability.invoke("inspect", { targetId: "nope" }, AGENT_A);
  assert.equal(unknownTarget.ok, false);
  if (!unknownTarget.ok) assert.equal(unknownTarget.error.code, "NOT_FOUND");
});

test("the capability declares a safe, complete Capability shape", async () => {
  const { capability } = rig();
  assert.equal(capability.id, "browser");
  assert.equal(capability.provider, "kai");
  // The declared risk is the maximum over the action set: open/navigate are EXTERNAL.
  assert.equal(capability.risk, "EXTERNAL");
  for (const action of BROWSER_ACTIONS) {
    assert.ok(capability.supportedActions.includes(action), `${action} must be advertised`);
  }
  assert.ok(capability.requirements !== undefined && capability.requirements.length > 0);
  assert.equal((await capability.health()).availability, "AVAILABLE");
});




