// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Capability manager tests — no network, no live servers, fully deterministic.
 * Run from `core/`:  node --test tests/capabilities.test.ts
 *
 * The suites below are the ones the brief names: registration, availability,
 * honest health reporting, the employee↔capability mapping both directions,
 * permission checks including wrong scope, the minimum-authority planning query,
 * the risk-understatement invariant, and KAI's direct use of a capability with
 * zero employees installed.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createCapabilityRegistry } from "../src/capabilities/registry.ts";
import { createCapabilityMatrix } from "../src/capabilities/matrix.ts";
import { createCapabilityManager, isEmployeeAvailable } from "../src/capabilities/manager.ts";

/** A well-formed registration; every field is overridable per test. */
function makeCapability(overrides = {}) {
  return {
    id: "browser",
    name: "Browser",
    availability: "AVAILABLE",
    risk: "EXTERNAL",
    actions: [{ id: "navigate", risk: "EXTERNAL" }],
    health: async () => ({ availability: "AVAILABLE" }),
    ...overrides,
  };
}

// ── 1. Registration ───────────────────────────────────────────────────────────

test("registration: register / get / list / ids / has / unregister", () => {
  const registry = createCapabilityRegistry();

  const result = registry.register(makeCapability());
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.id, "browser");
    // supportedActions is derived from `actions`, so the two cannot disagree.
    assert.deepEqual(result.value.supportedActions, ["navigate"]);
    assert.equal(result.value.provider, "kai", "provider defaults to a direct capability");
  }

  assert.equal(registry.has("browser"), true);
  assert.equal(registry.get("browser").name, "Browser");
  assert.deepEqual(registry.ids(), ["browser"]);
  assert.equal(registry.list().length, 1);

  const removed = registry.unregister("browser");
  assert.equal(removed.ok, true);
  assert.equal(registry.get("browser"), undefined);

  const again = registry.unregister("browser");
  assert.equal(again.ok, false);
  if (!again.ok) assert.equal(again.error.code, "NOT_FOUND");
});

test("registration: a duplicate id, a missing name and an empty action list are refused", () => {
  const registry = createCapabilityRegistry();
  assert.equal(registry.register(makeCapability()).ok, true);

  const duplicate = registry.register(makeCapability());
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) {
    assert.equal(duplicate.error.code, "VALIDATION_FAILED");
    assert.match(duplicate.error.message, /already registered/);
  }

  const noName = registry.register(makeCapability({ id: "shell", name: "  " }));
  assert.equal(noName.ok, false);

  const noActions = registry.register(makeCapability({ id: "shell", actions: [] }));
  assert.equal(noActions.ok, false);
  if (!noActions.ok) assert.match(noActions.error.message, /at least one action/);

  const badRisk = registry.register(makeCapability({ id: "shell", risk: "NOPE" }));
  assert.equal(badRisk.ok, false);

  // None of the failed registrations entered the catalogue.
  assert.deepEqual(registry.ids(), ["browser"]);
});

// ── 2. Availability ───────────────────────────────────────────────────────────

test("availability: an unprobed capability is never advertised as available", () => {
  const registry = createCapabilityRegistry();

  registry.register(makeCapability({ id: "browser", availability: "AVAILABLE" }));
  const browser = registry.status("browser");
  assert.equal(browser.availability, "AVAILABLE");
  assert.equal(browser.healthy, true);

  // No availability declared -> the safe default, not AVAILABLE.
  registry.register(makeCapability({ id: "shell", availability: undefined }));
  const shell = registry.status("shell");
  assert.equal(shell.availability, "UNAVAILABLE");
  assert.equal(shell.healthy, false);

  assert.equal(registry.status("missing"), undefined, "unknown ids are undefined, not a default");
});

test("availability: an operator's disable outranks any health probe", async () => {
  const registry = createCapabilityRegistry();
  registry.register(makeCapability({ id: "browser", availability: "AVAILABLE" }));

  assert.equal(registry.disable("browser").ok, true);
  assert.equal(registry.status("browser").availability, "DISABLED");

  // A probe that says AVAILABLE must not resurrect a disabled capability.
  const checked = await registry.checkHealth("browser");
  assert.equal(checked.availability, "DISABLED");
  assert.equal(checked.disabled, true);

  assert.equal(registry.enable("browser").ok, true);
  assert.equal(registry.status("browser").availability, "AVAILABLE", "enable restores the probed value");
});

// ── 3. Health failure reported honestly ───────────────────────────────────────

test("health: a probe that throws is reported UNAVAILABLE with the reason, never left AVAILABLE", async () => {
  const registry = createCapabilityRegistry();
  registry.register(
    makeCapability({
      id: "browser",
      availability: "AVAILABLE",
      health: async () => {
        throw new Error("boom-driver-missing");
      },
    }),
  );

  const checked = await registry.checkHealth("browser");
  assert.equal(checked.availability, "UNAVAILABLE");
  assert.equal(checked.healthy, false);
  assert.match(checked.detail, /boom-driver-missing/);
  // The stored availability is now the honest one.
  assert.equal(registry.status("browser").availability, "UNAVAILABLE");
});

test("health: a malformed probe result is UNAVAILABLE, and a DEGRADED probe is reported as DEGRADED", async () => {
  const registry = createCapabilityRegistry();
  registry.register(
    makeCapability({ id: "broken", availability: "AVAILABLE", health: async () => ({}) }),
  );
  const broken = await registry.checkHealth("broken");
  assert.equal(broken.availability, "UNAVAILABLE");
  assert.match(broken.detail, /malformed/);

  registry.register(
    makeCapability({
      id: "flaky",
      availability: "AVAILABLE",
      health: async () => ({ availability: "DEGRADED", detail: "half the tabs fail" }),
    }),
  );
  const flaky = await registry.checkHealth("flaky");
  assert.equal(flaky.availability, "DEGRADED");
  assert.equal(flaky.healthy, false);
  assert.equal(flaky.detail, "half the tabs fail");
});

// ── 4. Employee ↔ capability mapping, both directions ─────────────────────────

test("employees: the mapping is readable in both directions and availability filters it", () => {
  const manager = createCapabilityManager();
  assert.equal(manager.registerEmployee({ id: "emp-a", state: "READY", capabilities: ["browser", "shell"] }).ok, true);
  assert.equal(manager.registerEmployee({ id: "emp-b", state: "READY", capabilities: ["shell"] }).ok, true);
  assert.equal(manager.registerEmployee({ id: "emp-c", state: "UNAVAILABLE", capabilities: ["browser"] }).ok, true);

  // Forward: which capabilities does this employee declare?
  assert.deepEqual(manager.capabilitiesOf("emp-a"), ["browser", "shell"]);
  assert.deepEqual(manager.capabilitiesOf("nobody"), []);

  // Reverse: which employees declare this capability?
  const shellHolders = manager.employeesDeclaring("shell").map((employee) => employee.id);
  assert.deepEqual(shellHolders.sort(), ["emp-a", "emp-b"]);

  // Reverse, restricted to employees that are actually available.
  const browserProviders = manager.availableProviders("browser").map((employee) => employee.id);
  assert.deepEqual(browserProviders, ["emp-a"], "emp-c is UNAVAILABLE so it is not a provider");

  // State transitions are reported by re-registering the same employee.
  assert.equal(manager.registerEmployee({ id: "emp-a", state: "DEGRADED", capabilities: ["browser", "shell"] }).ok, true);
  assert.deepEqual(manager.availableProviders("browser"), []);

  assert.equal(manager.unregisterEmployee("emp-b").ok, true);
  assert.equal(manager.unregisterEmployee("emp-b").ok, false);

  assert.equal(isEmployeeAvailable("READY"), true);
  assert.equal(isEmployeeAvailable("DEGRADED"), false);
});

// ── 5. Permission checks ──────────────────────────────────────────────────────

test("permissions: granted, not granted, and wrong scope", () => {
  const matrix = createCapabilityMatrix();

  const granted = matrix.grant({
    employeeId: "emp-a",
    capabilityId: "browser",
    permission: "WRITE",
    scope: "thread",
    scopeId: "thread-1",
  });
  assert.equal(granted.ok, true);

  // Granted: the request is thread-1, and WRITE covers a READ use.
  const ok = matrix.checkUse({
    employeeId: "emp-a",
    capabilityId: "browser",
    risk: "READ",
    scope: "thread",
    scopeId: "thread-1",
  });
  assert.equal(ok.allowed, true);
  assert.equal(ok.authority, "WRITE");

  // Wrong thread: a scoped grant must not leak to another thread.
  const wrongThread = matrix.checkUse({
    employeeId: "emp-a",
    capabilityId: "browser",
    risk: "READ",
    scope: "thread",
    scopeId: "thread-2",
  });
  assert.equal(wrongThread.allowed, false);
  assert.match(wrongThread.reason, /no capability grant/);

  // Wrong scope: a thread grant must never cover a global request.
  const wrongScope = matrix.checkUse({
    employeeId: "emp-a",
    capabilityId: "browser",
    risk: "READ",
    scope: "global",
  });
  assert.equal(wrongScope.allowed, false);

  // Not granted at all: a different employee.
  const otherEmployee = matrix.checkUse({
    employeeId: "emp-b",
    capabilityId: "browser",
    risk: "READ",
    scope: "thread",
    scopeId: "thread-1",
  });
  assert.equal(otherEmployee.allowed, false);
});

test("permissions: the permission is a ceiling, and a scoped grant without an anchor is refused", () => {
  const matrix = createCapabilityMatrix();
  matrix.grant({ employeeId: "emp-a", capabilityId: "browser", permission: "READ", scope: "global" });

  const overCeiling = matrix.checkUse({
    employeeId: "emp-a",
    capabilityId: "browser",
    risk: "WRITE",
    scope: "global",
  });
  assert.equal(overCeiling.allowed, false);
  assert.match(overCeiling.reason, /at most READ/);

  // "no implicit everywhere": a mission/thread grant must name its anchor.
  const unanchored = matrix.grant({
    employeeId: "emp-a",
    capabilityId: "shell",
    permission: "WRITE",
    scope: "mission",
  });
  assert.equal(unanchored.ok, false);
  if (!unanchored.ok) assert.match(unanchored.error.message, /requires a scopeId/);

  // A global grant must not carry one either.
  const contradictory = matrix.grant({
    employeeId: "emp-a",
    capabilityId: "shell",
    permission: "WRITE",
    scope: "global",
    scopeId: "m-1",
  });
  assert.equal(contradictory.ok, false);
});

// ── 6. Minimum-authority planning query ───────────────────────────────────────

test("planning: picks the lower-risk employee when two can do the job", () => {
  const manager = createCapabilityManager();
  manager.register(makeCapability({ id: "browser", provider: "emp-a", risk: "EXTERNAL" }));
  manager.registerEmployee({ id: "emp-a", state: "READY", capabilities: ["browser"] });
  manager.registerEmployee({ id: "emp-b", state: "READY", capabilities: ["browser"] });

  // emp-a may use up to DESTRUCTIVE, emp-b only up to WRITE.
  manager.grant({ employeeId: "emp-a", capabilityId: "browser", permission: "DESTRUCTIVE", scope: "global" });
  manager.grant({ employeeId: "emp-b", capabilityId: "browser", permission: "WRITE", scope: "global" });

  // Required WRITE: both qualify, so the least authority (emp-b) wins.
  const write = manager.plan({ capabilityId: "browser", risk: "WRITE", scope: "global" });
  assert.equal(write.ok, true);
  if (write.ok && write.via === "employee") {
    assert.equal(write.employeeId, "emp-b");
    assert.equal(write.authority, "WRITE");
  } else {
    assert.fail("expected an employee plan");
  }

  // Required EXTERNAL: emp-b's WRITE no longer covers it, so emp-a is the only choice.
  const external = manager.plan({ capabilityId: "browser", risk: "EXTERNAL", scope: "global" });
  assert.equal(external.ok, true);
  if (external.ok && external.via === "employee") {
    assert.equal(external.employeeId, "emp-a");
    assert.equal(external.authority, "DESTRUCTIVE");
  } else {
    assert.fail("expected an employee plan");
  }
});

test("planning: equal authority is broken deterministically, and an unavailable capability is never planned onto", () => {
  const manager = createCapabilityManager();
  manager.register(makeCapability({ id: "browser", provider: "emp-a" }));
  manager.registerEmployee({ id: "emp-2", state: "READY", capabilities: ["browser"] });
  manager.registerEmployee({ id: "emp-1", state: "READY", capabilities: ["browser"] });
  manager.grant({ employeeId: "emp-2", capabilityId: "browser", permission: "EXTERNAL", scope: "global" });
  manager.grant({ employeeId: "emp-1", capabilityId: "browser", permission: "EXTERNAL", scope: "global" });

  const plan = manager.plan({ capabilityId: "browser", risk: "READ", scope: "global" });
  assert.equal(plan.ok, true);
  if (plan.ok && plan.via === "employee") assert.equal(plan.employeeId, "emp-1", "ties break by employee id");

  // An unhealthy capability is never planned onto, however healthy its employees.
  const unhealthy = createCapabilityManager();
  unhealthy.register(makeCapability({ id: "shell", provider: "emp-a", availability: "DEGRADED" }));
  unhealthy.registerEmployee({ id: "emp-a", state: "READY", capabilities: ["shell"] });
  unhealthy.grant({ employeeId: "emp-a", capabilityId: "shell", permission: "DESTRUCTIVE", scope: "global" });
  const blocked = unhealthy.plan({ capabilityId: "shell", risk: "READ", scope: "global" });
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.match(blocked.reason, /DEGRADED/);
});

// ── 7. Risk-understatement invariant ──────────────────────────────────────────

test("invariant: a capability may not understate the risk of its most dangerous action", () => {
  const registry = createCapabilityRegistry();

  const understated = registry.register(
    makeCapability({
      id: "sneaky",
      risk: "READ",
      actions: [
        { id: "peek", risk: "READ" },
        { id: "overwrite", risk: "WRITE" },
      ],
    }),
  );
  assert.equal(understated.ok, false);
  if (!understated.ok) {
    assert.equal(understated.error.code, "POLICY_DENIED");
    assert.match(understated.error.message, /most dangerous action/);
    assert.match(understated.error.message, /overwrite/);
  }
  assert.equal(registry.has("sneaky"), false, "a hole must not enter the catalogue");

  // Honest risk equal to the worst action is fine.
  const honest = registry.register(
    makeCapability({
      id: "honest",
      risk: "WRITE",
      actions: [
        { id: "peek", risk: "READ" },
        { id: "overwrite", risk: "WRITE" },
      ],
    }),
  );
  assert.equal(honest.ok, true);

  // Overstating is always allowed: erring toward "ask a human" is safe.
  const cautious = registry.register(
    makeCapability({
      id: "cautious",
      risk: "DESTRUCTIVE",
      actions: [{ id: "peek", risk: "READ" }],
    }),
  );
  assert.equal(cautious.ok, true);
});

// ── 8. KAI works with zero employees ──────────────────────────────────────────

test("KAI direct: a capability with zero employees is still usable by KAI itself", () => {
  const manager = createCapabilityManager();
  // No employee is registered anywhere in this test.
  manager.register(makeCapability({ id: "browser", provider: "kai", risk: "EXTERNAL" }));

  const direct = manager.kaiDirect("browser");
  assert.equal(direct.ok, true);
  if (direct.ok) assert.equal(direct.risk, "EXTERNAL");

  const resolved = manager.resolve({ capabilityId: "browser", risk: "EXTERNAL", scope: "global" });
  assert.equal(resolved.ok, true);
  if (resolved.ok) assert.equal(resolved.via, "kai");

  // An employee-provided capability cannot be resolved without an employee.
  manager.register(
    makeCapability({
      id: "shell",
      provider: "emp-x",
      risk: "WRITE",
      actions: [{ id: "exec", risk: "WRITE" }],
    }),
  );
  const shell = manager.resolve({ capabilityId: "shell", risk: "WRITE", scope: "global" });
  assert.equal(shell.ok, false);
  if (!shell.ok) assert.match(shell.reason, /no available employee/);

  const shellDirect = manager.kaiDirect("shell");
  assert.equal(shellDirect.ok, false);
  if (!shellDirect.ok) assert.match(shellDirect.reason, /provided by employee/);
});
