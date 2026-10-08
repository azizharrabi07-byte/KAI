// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * workforce tests — the Phase 1 Parts I+J proof, no network and no real installs.
 *
 * Deterministic by construction: employees are built from an in-memory
 * descriptor, discovery's "present service" is a throwaway localhost HTTP server
 * and its "absent service" is a closed port, and the executable probe is given an
 * injected locator. Nothing here depends on Hermes or OpenCode actually running.
 *
 * These sources use `.ts` import specifiers, so Node's TypeScript type-stripping
 * loads them directly (the same way the existing runtime-events suite does).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { createMockHermes } from "../src/agents/mock.ts";
import { createWorkforceManager } from "../src/workforce/manager.ts";
import {
  EMPLOYEE_TRANSITIONS,
  createLifecycle,
  isLegalTransition,
  transition,
  transitionPath,
} from "../src/workforce/lifecycle.ts";
import { createUnavailableEmployee, defineEmployee, makeInstance, makeSnapshot } from "../src/workforce/employee.ts";
import {
  classifyDiscovery,
  createCodexSource,
  createCommandProbe,
  createDiscovery,
  createHttpProbe,
  createTrustedSourceRegistry,
  defaultTrustedSources,
} from "../src/workforce/discovery.ts";

// ── Test helpers ──────────────────────────────────────────────────────────────

/**
 * A controllable employee. `health` and `throwOnCreate` are flipped between
 * assertions, and `createCalls`/`disposeCalls` are counters that prove the
 * "no duplicate instance" and "recover rebuilds" jobs.
 */
function buildEmployee(id, options = {}) {
  const adapter = options.adapter ?? createMockHermes();
  let createCalls = 0;
  let disposeCalls = 0;
  let health = options.health ?? "READY";
  let throwOnCreate = options.throwOnCreate ?? false;

  const descriptor = defineEmployee({
    id,
    name: options.name ?? id,
    kind: id,
    origin: options.origin ?? "builtin",
    capabilities: options.capabilities ?? ["run_task", "shell"],
    create: async (input = {}) => {
      createCalls++;
      if (throwOnCreate) throw new Error("boom-create");
      return makeInstance({
        instanceId: input.instanceId ?? `${id}#1`,
        employeeId: id,
        kind: id,
        adapter,
        capabilities: ["run_task", "health"],
        initialState: "INSTALLED",
        snapshot: async () => {
          if (health === "UNAVAILABLE") return makeSnapshot("UNAVAILABLE", { reachable: false });
          if (health === "DEGRADED") {
            return makeSnapshot("DEGRADED", { reachable: true, authenticated: false, problems: ["degraded (test)"] });
          }
          return makeSnapshot("READY", { reachable: true, authenticated: true, version: "1.2.3" });
        },
        dispose: async () => {
          disposeCalls++;
        },
      });
    },
  });

  return {
    descriptor,
    adapter,
    get createCalls() {
      return createCalls;
    },
    get disposeCalls() {
      return disposeCalls;
    },
    setHealth(next) {
      health = next;
    },
    setThrowOnCreate(next) {
      throwOnCreate = next;
    },
  };
}

/** A trusted source with a probe the test controls directly. */
function mockSource(id, observation) {
  return {
    id,
    kind: id,
    name: id,
    capabilities: ["run_task"],
    probe: { employeeId: id, probe: async () => observation },
  };
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

test("lifecycle: legal moves apply, illegal moves are refused as a value, same-state is a no-op", () => {
  assert.equal(isLegalTransition("READY", "DEGRADED"), true);
  assert.equal(isLegalTransition("READY", "INSTALLING"), true);
  assert.equal(isLegalTransition("INSTALLING", "READY"), false, "installing must not skip installation");
  assert.equal(isLegalTransition("REMOVED", "READY"), false, "a tombstone must not resurrect itself");
  assert.equal(isLegalTransition("DISABLED", "READY"), true, "enable must be a legal move");

  const allowed = transition("DISCOVERED", "INSTALLED");
  assert.equal(allowed.ok, true);
  assert.equal(allowed.changed, true);

  const refused = transition("REMOVED", "READY");
  assert.equal(refused.ok, false);
  assert.equal(refused.changed, false);
  assert.equal(refused.error?.code, "VALIDATION_FAILED");

  const noop = transition("READY", "READY");
  assert.equal(noop.ok, true);
  assert.equal(noop.changed, false);

  const lifecycle = createLifecycle("DISCOVERED");
  assert.equal(lifecycle.apply("INSTALLED").ok, true);
  assert.equal(lifecycle.state(), "INSTALLED");
  const bad = lifecycle.apply("DISCOVERED"); // INSTALLED -> DISCOVERED is not legal
  assert.equal(bad.ok, false);
  assert.equal(lifecycle.state(), "INSTALLED", "a refused move must not be applied");
  assert.deepEqual(lifecycle.history(), ["DISCOVERED", "INSTALLED"]);
});

test("lifecycle: the table is total and every pair of states is reachable from every other", () => {
  const states = Object.keys(EMPLOYEE_TRANSITIONS);
  for (const state of states) {
    assert.ok(Array.isArray(EMPLOYEE_TRANSITIONS[state]), `${state} must have a table entry`);
    assert.equal(EMPLOYEE_TRANSITIONS[state].includes(state), false, `${state} must not list itself`);
  }
  // This is a property worth pinning: recovery (UNAVAILABLE -> READY) and removal
  // (anything -> REMOVED) must always have a legal route, or a stuck employee
  // could never be brought back or gotten rid of.
  for (const from of states) {
    for (const to of states) {
      const path = transitionPath(from, to);
      assert.notEqual(path, null, `${from} must be able to reach ${to}`);
      let cursor = from;
      for (const step of path ?? []) {
        assert.equal(isLegalTransition(cursor, step), true, `${cursor} -> ${step} must be legal`);
        cursor = step;
      }
      assert.equal(cursor, to);
    }
  }
  assert.deepEqual(transitionPath("DISCOVERED", "READY"), ["INSTALLED", "READY"]);
  assert.deepEqual(transitionPath("UNAVAILABLE", "READY"), ["READY"]);
  assert.deepEqual(transitionPath("READY", "READY"), []);
});

// ── Registration ──────────────────────────────────────────────────────────────

test("manager: register / get / list / describe, and a malformed descriptor is a value", () => {
  const workforce = createWorkforceManager();
  const employee = buildEmployee("hermes");

  const registered = workforce.register(employee.descriptor);
  assert.equal(registered.ok, true);
  assert.equal(registered.state, "DISCOVERED");
  assert.equal(workforce.has("hermes"), true);
  assert.equal(workforce.get("hermes"), employee.descriptor);

  assert.equal(workforce.configure("hermes", { model: "test" }).ok, true);
  assert.equal(workforce.assignRole("hermes", "coder").ok, true);

  const rows = workforce.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "hermes");
  assert.equal(rows[0].state, "DISCOVERED");
  assert.equal(rows[0].role, "coder");
  assert.deepEqual(rows[0].config, { model: "test" });

  const malformed = workforce.register({ metadata: { id: "", name: "", origin: "x", capabilities: [] } });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.error?.code, "VALIDATION_FAILED");
});

test("manager: duplicate registration is safe — first registration kept, no duplicate instance", async () => {
  const workforce = createWorkforceManager();
  const first = buildEmployee("hermes");
  const impostor = buildEmployee("hermes", { name: "Impostor" });

  assert.equal(workforce.register(first.descriptor).ok, true);
  const dup = workforce.register(impostor.descriptor);
  assert.equal(dup.ok, false);
  assert.equal(dup.duplicate, true);
  assert.equal(dup.error?.code, "VALIDATION_FAILED");
  assert.equal(workforce.get("hermes"), first.descriptor, "the first registration must not be lost");

  // Re-registering the identical descriptor is an idempotent success.
  const again = workforce.register(first.descriptor);
  assert.equal(again.ok, true);
  assert.equal(again.duplicate, true);

  // Only the first employee ever creates an instance, exactly once.
  await workforce.healthCheck("hermes");
  await workforce.healthCheck("hermes");
  assert.equal(first.createCalls, 1, "one instance, created once");
  assert.equal(impostor.createCalls, 0, "the refused duplicate must never start");
});

test("manager: health-state changes are observable through the event sink", async () => {
  const events = [];
  const workforce = createWorkforceManager({ onEvent: (type, payload) => events.push({ type, payload }) });
  const employee = buildEmployee("hermes");
  workforce.register(employee.descriptor);

  assert.equal((await workforce.healthCheck("hermes")).state, "READY");
  employee.setHealth("DEGRADED");
  assert.equal((await workforce.healthCheck("hermes")).state, "DEGRADED");
  employee.setHealth("UNAVAILABLE");
  assert.equal((await workforce.healthCheck("hermes")).state, "UNAVAILABLE");

  const transitions = events
    .filter((event) => event.type === "workforce.state_changed")
    .map((event) => `${event.payload.from}->${event.payload.to}`);
  assert.ok(transitions.includes("DISCOVERED->READY"), `expected DISCOVERED->READY in ${transitions.join(", ")}`);
  assert.ok(transitions.includes("READY->DEGRADED"), `expected READY->DEGRADED in ${transitions.join(", ")}`);
  assert.ok(transitions.includes("DEGRADED->UNAVAILABLE"), `expected DEGRADED->UNAVAILABLE in ${transitions.join(", ")}`);
  assert.ok(events.some((event) => event.type === "workforce.health_checked"), "a health check must be observable");
});

// ── Enable / disable / remove ─────────────────────────────────────────────────

test("manager: disabling stops selection and delegation, and enable is reversible", async () => {
  const workforce = createWorkforceManager();
  const employee = buildEmployee("hermes");
  workforce.register(employee.descriptor);
  workforce.assignRole("hermes", "coder");
  assert.equal((await workforce.healthCheck("hermes")).state, "READY");

  assert.equal(workforce.select({ role: "coder" })?.employeeId, "hermes");

  const disabled = await workforce.disable("hermes");
  assert.equal(disabled.ok, true);
  assert.equal(disabled.state, "DISABLED");

  assert.equal(workforce.select({ role: "coder" }), null, "a disabled employee must not be selected");
  assert.equal(workforce.available().length, 0);
  const delegated = await workforce.delegate({ taskId: "t-1", input: "do the thing", role: "coder" });
  assert.equal(delegated.ok, false);
  assert.equal(delegated.error?.code, "NOT_FOUND");

  const enabled = await workforce.enable("hermes");
  assert.equal(enabled.ok, true);
  assert.equal(enabled.state, "READY");
  assert.equal(workforce.select({ role: "coder" })?.employeeId, "hermes");
});

test("manager: remove tombstones the employee and clears its grants", async () => {
  const workforce = createWorkforceManager();
  workforce.register(buildEmployee("hermes").descriptor);
  await workforce.healthCheck("hermes");
  workforce.grant("hermes", { capabilityId: "shell", permission: "READ", scope: "employee" });

  const removed = await workforce.remove("hermes");
  assert.equal(removed.ok, true);
  assert.equal(removed.state, "REMOVED");
  assert.equal(workforce.has("hermes"), true, "the tombstone is kept so a stale handle cannot resurrect it");
  assert.equal(workforce.permissions("hermes").length, 0);
  assert.equal(workforce.select(), null);
  assert.equal((await workforce.disable("hermes")).ok, false);
  assert.equal((await workforce.enable("hermes")).ok, false);
});

// ── Delegation ────────────────────────────────────────────────────────────────

// Phase 1 §11 changed delegation's contract. It used to call the adapter directly,
// which made the workforce manager a SECOND way to reach a worker — the same bypass
// class the Phase 1 review closed on the HTTP route. Delegation now runs through an
// injected, policy-governed executor, and REFUSES without one.
test("manager: delegate runs through the injected executor, not the adapter", async () => {
  const adapter = createMockHermes();
  await adapter.connect();
  const delegated: Array<{ employeeId: string; taskId: string; input: string }> = [];
  const workforce = createWorkforceManager({
    executeTask: async ({ employeeId, taskId, input }) => {
      delegated.push({ employeeId, taskId, input });
      return adapter.runTask({ id: taskId, input });
    },
  });
  workforce.register(buildEmployee("hermes", { adapter }).descriptor);
  await workforce.healthCheck("hermes");

  const out = await workforce.delegate({ taskId: "t-1", input: "hello there" });
  assert.equal(out.ok, true);
  assert.equal(out.employeeId, "hermes");
  assert.equal(out.result?.state, "completed");
  assert.match(String(out.result?.output), /hello there/);
  assert.equal(delegated.length, 1, "the governed executor was the path taken");
  assert.equal(delegated[0]!.employeeId, "hermes");
});

test("manager: delegate REFUSES without a governed executor instead of bypassing policy", async () => {
  const adapter = createMockHermes();
  await adapter.connect();
  const workforce = createWorkforceManager(); // no executeTask
  workforce.register(buildEmployee("hermes", { adapter }).descriptor);
  await workforce.healthCheck("hermes");

  const out = await workforce.delegate({ taskId: "t-1", input: "hello there" });
  assert.equal(out.ok, false, "it must not run unsupervised");
  assert.match(String(out.error?.message), /policy-governed executor/, "and it must say why");
});

test("manager: delegation with nothing selectable is a value, never a throw", async () => {
  const workforce = createWorkforceManager();
  const out = await workforce.delegate({ taskId: "t-1", input: "x" });
  assert.equal(out.ok, false);
  assert.equal(out.error?.code, "NOT_FOUND");
});

// ── Resilience: a missing worker must never take KAI down ─────────────────────

test("manager: an unavailable employee never crashes KAI", async () => {
  const workforce = createWorkforceManager();
  const broken = buildEmployee("broken", { throwOnCreate: true });
  workforce.register(broken.descriptor);

  const health = await workforce.healthCheck("broken");
  assert.equal(health.ok, false);
  assert.equal(health.state, "UNAVAILABLE");

  const delegated = await workforce.delegate({ taskId: "t", input: "x" });
  assert.equal(delegated.ok, false);
  assert.ok(delegated.error);

  const sweep = await workforce.monitor();
  assert.equal(sweep.length, 1);
  assert.equal(sweep[0].state, "UNAVAILABLE");
  assert.ok(sweep[0].snapshot?.problems?.length >= 1);

  const rows = workforce.describe("broken");
  assert.equal(rows[0].state, "UNAVAILABLE");

  // Operations on an employee that was never registered are values too.
  const missing = await workforce.healthCheck("nope");
  assert.equal(missing.ok, false);
  assert.equal(missing.error?.code, "NOT_FOUND");
  assert.equal((await workforce.delegate({ taskId: "t2", input: "x" })).error?.code, "NOT_FOUND");
});

test("manager: an employee whose snapshot throws still reports UNAVAILABLE", async () => {
  const workforce = createWorkforceManager();
  const descriptor = defineEmployee({
    id: "bad",
    name: "Bad",
    kind: "bad",
    capabilities: [],
    create: async (input = {}) =>
      makeInstance({
        instanceId: input.instanceId ?? "bad#1",
        employeeId: "bad",
        kind: "bad",
        initialState: "INSTALLED",
        snapshot: async () => {
          throw new Error("snapshot boom");
        },
      }),
  });
  workforce.register(descriptor);

  const sweep = await workforce.monitor();
  assert.equal(sweep.length, 1);
  assert.equal(sweep[0].state, "UNAVAILABLE");
  assert.equal(workforce.describe("bad")[0].state, "UNAVAILABLE");
});

test("employee: createUnavailableEmployee is an honest UNAVAILABLE, and dispose is idempotent", async () => {
  const descriptor = createUnavailableEmployee(
    { id: "codex", name: "Codex CLI", origin: "discovered:codex", capabilities: ["run_task"] },
    "not installed",
  );
  const instance = await descriptor.create();
  const snapshot = await instance.snapshot();
  assert.equal(snapshot.state, "UNAVAILABLE");
  assert.equal(snapshot.reachable, false);
  assert.ok(snapshot.problems?.includes("not installed"));
  await instance.dispose();
  await instance.dispose(); // must not throw
});

// ── Install: policy boundary + lifecycle ──────────────────────────────────────

test("manager: install enforces the trusted-source boundary and the lifecycle", async () => {
  const sources = createTrustedSourceRegistry([
    {
      id: "codex",
      kind: "codex",
      name: "Codex CLI",
      capabilities: ["run_task"],
      install: { kind: "npm", package: "@openai/codex" },
    },
  ]);
  let installs = 0;
  const installer = {
    canInstall: () => true,
    install: async () => {
      installs++;
      return { ok: true };
    },
  };
  const workforce = createWorkforceManager({ sources, installer });
  workforce.register(buildEmployee("codex").descriptor);

  // A URL is refused before any state moves.
  const url = await workforce.install("codex", { package: "https://evil.example/x.tgz" });
  assert.equal(url.ok, false);
  assert.equal(url.error?.code, "POLICY_DENIED");
  assert.equal(workforce.describe("codex")[0].state, "DISCOVERED", "a refused install changes nothing");

  // A package that is not the trusted one is refused.
  const wrong = await workforce.install("codex", { package: "some-other-package" });
  assert.equal(wrong.error?.code, "POLICY_DENIED");

  // A trusted install moves DISCOVERED -> INSTALLING -> INSTALLED.
  const ok = await workforce.install("codex");
  assert.equal(ok.ok, true);
  assert.equal(ok.state, "INSTALLED");
  assert.equal(installs, 1);

  // A source that is not registered as trusted is refused.
  const rogueWorkforce = createWorkforceManager({ sources, installer });
  rogueWorkforce.register(buildEmployee("rogue").descriptor);
  const rogue = await rogueWorkforce.install("rogue");
  assert.equal(rogue.ok, false);
  assert.equal(rogue.error?.code, "POLICY_DENIED");
});

test("manager: install with no installer configured lands UNAVAILABLE with the manual instruction", async () => {
  const sources = createTrustedSourceRegistry([
    { id: "hermes", kind: "hermes", name: "Hermes", capabilities: [], install: { kind: "manual", instructions: "install it by hand" } },
  ]);
  const workforce = createWorkforceManager({ sources });
  workforce.register(buildEmployee("hermes").descriptor);

  const result = await workforce.install("hermes");
  assert.equal(result.ok, false);
  assert.equal(result.state, "UNAVAILABLE");
  assert.equal(result.error?.code, "INTERNAL");
  assert.match(String(result.error?.detail), /install it by hand/);
});

test("manager: without a trusted-source registry, installation is disabled (deny by default)", async () => {
  const workforce = createWorkforceManager();
  workforce.register(buildEmployee("codex").descriptor);
  const result = await workforce.install("codex");
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "POLICY_DENIED");
});

// ── Role and permissions ──────────────────────────────────────────────────────

test("manager: roles and capability grants validate, replace and revoke", async () => {
  const workforce = createWorkforceManager();
  workforce.register(buildEmployee("hermes", { capabilities: ["browser"] }).descriptor);
  assert.equal(workforce.assignRole("hermes", "coder").ok, true);
  assert.equal(workforce.assignRole("hermes", "").ok, false);

  assert.equal(workforce.grant("hermes", { capabilityId: "browser", permission: "WRITE", scope: "employee" }).ok, true);
  assert.equal(workforce.permissions("hermes").length, 1);

  // Invalid risk level and scope are refused as values.
  assert.equal(workforce.grant("hermes", { capabilityId: "x", permission: "GOD", scope: "employee" }).ok, false);
  assert.equal(workforce.grant("hermes", { capabilityId: "x", permission: "READ", scope: "galaxy" }).ok, false);

  // Same tuple replaces rather than accumulates.
  assert.equal(workforce.grant("hermes", { capabilityId: "browser", permission: "READ", scope: "employee" }).ok, true);
  assert.equal(workforce.permissions("hermes").length, 1);
  assert.equal(workforce.permissions("hermes")[0].permission, "READ");

  assert.equal(workforce.revoke("hermes", "browser"), true);
  assert.equal(workforce.revoke("hermes", "browser"), false);
  assert.equal(workforce.permissions("hermes").length, 0);

  // Selection can filter by a declared capability, once the employee is READY.
  await workforce.healthCheck("hermes");
  assert.equal(workforce.select({ capabilityId: "browser" })?.employeeId, "hermes");
  assert.equal(workforce.select({ capabilityId: "does-not-exist" }), null);
});

// ── Recovery ──────────────────────────────────────────────────────────────────

test("manager: recover rebuilds a broken employee from its descriptor", async () => {
  const workplace = createWorkforceManager();
  const employee = buildEmployee("hermes", { throwOnCreate: true });
  workplace.register(employee.descriptor);

  await workplace.healthCheck("hermes");
  assert.equal(workplace.describe("hermes")[0].state, "UNAVAILABLE");
  assert.equal(employee.createCalls, 1);

  // The employee comes back to life; recovery must build a fresh instance.
  employee.setThrowOnCreate(false);
  const recovered = await workplace.recover("hermes");
  assert.equal(recovered.ok, true);
  assert.equal(recovered.state, "READY");
  assert.equal(employee.createCalls, 2, "recovery rebuilds the instance");
});

test("manager: recover on a healthy employee is a no-op, and on a disabled one is refused", async () => {
  const workforce = createWorkforceManager();
  workforce.register(buildEmployee("hermes").descriptor);
  await workforce.healthCheck("hermes");
  assert.equal((await workforce.recover("hermes")).ok, true);
  assert.equal((await workforce.recover("hermes")).changed, false);

  await workforce.disable("hermes");
  const refused = await workforce.recover("hermes");
  assert.equal(refused.ok, false);
  assert.equal(refused.state, "DISABLED");
  assert.equal(refused.error?.code, "VALIDATION_FAILED");
});

// ── Discovery integration ─────────────────────────────────────────────────────

test("manager: observe folds in a discovery result, stays observable but unselectable without an adapter", async () => {
  const workforce = createWorkforceManager();
  const result = classifyDiscovery(
    { id: "opencode", kind: "opencode", name: "OpenCode", capabilities: ["run_task"] },
    { installed: true, reachable: true, version: "1.18.33" },
  );
  const registered = workforce.observe(result);
  assert.equal(registered.ok, true);
  assert.equal(registered.state, "READY");

  const row = workforce.describe("opencode")[0];
  assert.equal(row.placeholder, true);
  assert.equal(row.version, "1.18.33");

  // A placeholder is not a hire: it has no adapter, so it is never delegated to.
  assert.equal(workforce.select(), null);
  const delegated = await workforce.delegate({ taskId: "t", input: "x" });
  assert.equal(delegated.ok, false);
  assert.equal(delegated.error?.code, "NOT_FOUND");
});

test("manager: a real registration upgrades a discovery placeholder", () => {
  const workforce = createWorkforceManager();
  workforce.observe(classifyDiscovery(mockSource("codex", { installed: false, reachable: false }), {
    installed: false,
    reachable: false,
  }));
  assert.equal(workforce.describe("codex")[0].placeholder, true);

  const real = buildEmployee("codex");
  const upgraded = workforce.register(real.descriptor);
  assert.equal(upgraded.ok, true);
  assert.equal(upgraded.replacedPlaceholder, true);
  assert.equal(workforce.get("codex"), real.descriptor);
});

test("manager: discover() runs the injected probes and never throws", async () => {
  const discovery = createDiscovery({
    sources: [mockSource("present", { installed: true, reachable: true, version: "2.0.0" }), mockSource("absent", { installed: false, reachable: false })],
  });
  const workforce = createWorkforceManager({ discovery });
  const results = await workforce.discover();
  assert.equal(results.length, 2);
  const byId = Object.fromEntries(results.map((r) => [r.employeeId, r.state]));
  assert.equal(byId.present, "READY");
  assert.equal(byId.absent, "UNAVAILABLE");
  assert.equal(workforce.describe("absent")[0].state, "UNAVAILABLE");
});

// ── Discovery classification (Part J) ─────────────────────────────────────────

test("discovery: a present service is READY; a closed port is UNAVAILABLE — never an error", async () => {
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: "ok", version: "9.9.9" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    const source = {
      id: "svc",
      kind: "svc",
      name: "Service",
      capabilities: ["run_task"],
      probe: createHttpProbe({ employeeId: "svc", baseUrl: `http://127.0.0.1:${port}`, healthPath: "/health" }),
    };
    const [present] = await createDiscovery({ sources: [source] }).scan();
    assert.equal(present.installed, true);
    assert.equal(present.reachable, true);
    assert.equal(present.state, "READY");
    assert.equal(present.version, "9.9.9");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  // The port is now closed: an absent service is UNAVAILABLE, not an exception.
  const absentSource = {
    id: "svc",
    kind: "svc",
    name: "Service",
    capabilities: ["run_task"],
    probe: createHttpProbe({ employeeId: "svc", baseUrl: `http://127.0.0.1:${port}`, healthPath: "/health", timeoutMs: 2000 }),
  };
  const [absent] = await createDiscovery({ sources: [absentSource] }).scan();
  assert.equal(absent.reachable, false);
  assert.equal(absent.state, "UNAVAILABLE");
  assert.ok(absent.problems.length >= 1);
});

test("discovery: a missing executable (Codex is absent here) is UNAVAILABLE, not an error", async () => {
  const source = createCodexSource();
  const probe = createCommandProbe({ employeeId: "codex", command: "codex", locate: async () => null });
  const [result] = await createDiscovery({ sources: [{ ...source, probe }] }).scan();

  assert.equal(result.installed, false);
  assert.equal(result.reachable, false);
  assert.equal(result.supported, false);
  assert.equal(result.state, "UNAVAILABLE");
  assert.ok(result.problems.length >= 1);
});

test("discovery: an installed executable reports its version, and an unsupported one is refused", async () => {
  const source = {
    id: "codex",
    kind: "codex",
    name: "Codex CLI",
    capabilities: ["run_task"],
    supportedVersions: /^0\./,
  };

  const good = createCommandProbe({
    employeeId: "codex",
    command: "codex",
    locate: async () => "C:/bin/codex.exe",
    run: async () => ({ ok: true, stdout: "codex-cli 0.21.0" }),
  });
  const [supported] = await createDiscovery({ sources: [{ ...source, probe: good }] }).scan();
  assert.equal(supported.installed, true);
  assert.equal(supported.version, "0.21.0");
  assert.equal(supported.supported, true);
  assert.equal(supported.state, "READY");

  const tooNew = createCommandProbe({
    employeeId: "codex",
    command: "codex",
    locate: async () => "C:/bin/codex.exe",
    run: async () => ({ ok: true, stdout: "codex-cli 2.0.0" }),
  });
  const [unsupported] = await createDiscovery({ sources: [{ ...source, probe: tooNew }] }).scan();
  assert.equal(unsupported.supported, false);
  assert.equal(unsupported.state, "UNAVAILABLE");
});

test("discovery: an unauthenticated employee that requires auth is DEGRADED, not READY", () => {
  const source = { id: "svc", kind: "svc", name: "Service", capabilities: ["run_task"], requiresAuth: true };
  assert.equal(classifyDiscovery(source, { installed: true, reachable: true, authenticated: false }).state, "DEGRADED");
  assert.equal(classifyDiscovery(source, { installed: true, reachable: true, authenticated: true }).state, "READY");
});

// ── Trusted-source policy ─────────────────────────────────────────────────────

test("discovery: the trusted-source policy refuses unknown sources and URL packages", () => {
  const registry = createTrustedSourceRegistry([
    { id: "codex", kind: "codex", name: "Codex CLI", capabilities: ["run_task"], install: { kind: "npm", package: "@openai/codex" } },
  ]);

  const unknown = registry.authorizeInstall({ sourceId: "unknown" });
  assert.equal(unknown.allowed, false);
  assert.equal(unknown.error.code, "POLICY_DENIED");

  assert.equal(registry.authorizeInstall({ sourceId: "codex", package: "https://evil.example/x.tgz" }).allowed, false);
  assert.equal(registry.authorizeInstall({ sourceId: "codex", package: "git+ssh://host/repo" }).allowed, false);
  assert.equal(registry.authorizeInstall({ sourceId: "codex", package: "other-package" }).allowed, false);

  const allowed = registry.authorizeInstall({ sourceId: "codex" });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.allowed && allowed.install?.package, "@openai/codex");

  // A source with no declared install method can never be installed.
  const none = createTrustedSourceRegistry([{ id: "x", kind: "x", name: "X", capabilities: [] }]);
  assert.equal(none.authorizeInstall({ sourceId: "x" }).allowed, false);
});

test("discovery: the shipped trusted sources are Hermes, OpenCode and Codex", () => {
  const ids = defaultTrustedSources().map((source) => source.id).sort();
  assert.deepEqual(ids, ["codex", "hermes", "opencode"]);
  const codex = defaultTrustedSources().find((source) => source.id === "codex");
  assert.equal(codex?.install?.kind, "npm");
  assert.equal(codex?.install?.package, "@openai/codex");
});

