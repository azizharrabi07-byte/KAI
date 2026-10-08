// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Registry tests — no network, no live servers, fully deterministic.
 *
 * WHY THE HOOK BELOW: the repo's sources use NodeNext-style ".js" specifiers
 * (hermes.ts imports "../errors.js"), but Node's built-in TypeScript
 * type-stripping does not remap ".js" -> ".ts". A synchronous resolve hook maps
 * them at runtime, so `node --test tests/registry.test.ts` works with no build.
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
      if (existsSync(fileURLToPath(candidate))) {
        return { url: candidate.href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});

const { createAgentRegistry } = await import("../src/agents/registry.ts");
const { createMockHermes, createMockOpenCode } = await import("../src/agents/mock.ts");

/** An adapter whose calls throw, to prove the registry never propagates. */
function crashingAdapter(id) {
  return {
    id,
    name: id,
    capabilities: () => ["health"],
    connect: async () => {
      throw new Error("boom-connect");
    },
    disconnect: async () => {},
    health: async () => {
      throw new Error("boom-health");
    },
    getStatus: async () => {
      throw new Error("boom-status");
    },
    sendMessage: async () => {
      throw new Error("boom-message");
    },
    runTask: async () => {
      throw new Error("boom-run");
    },
  };
}

test("registry: register / get / list / ids / unregister", () => {
  const registry = createAgentRegistry();
  const hermes = createMockHermes();
  const opencode = createMockOpenCode();

  registry.register(hermes);
  registry.register(opencode);

  assert.equal(registry.get("hermes"), hermes);
  assert.equal(registry.get("opencode"), opencode);
  assert.equal(registry.get("does-not-exist"), undefined);
  assert.deepEqual([...registry.ids()].sort(), ["hermes", "opencode"]);
  assert.equal(registry.list().length, 2);

  registry.unregister("hermes");
  assert.equal(registry.get("hermes"), undefined);
  assert.deepEqual(registry.ids(), ["opencode"]);
  // unregistering an unknown id is a no-op, not an error
  registry.unregister("hermes");
});

test("registry: connectAll returns a per-agent result and never throws on a failing adapter", async () => {
  const registry = createAgentRegistry();
  registry.register(createMockHermes());
  registry.register(createMockOpenCode({ failAt: "connect" }));
  registry.register(crashingAdapter("crasher"));

  const result = await registry.connectAll();

  assert.equal(result["hermes"], true);
  assert.equal(result["opencode"], false);
  assert.equal(result["crasher"], false);
});

test("registry: healthAll reports ok:false (never a crash) for failing probes", async () => {
  const registry = createAgentRegistry();
  registry.register(createMockHermes());
  registry.register(createMockOpenCode({ failAt: "health" }));
  registry.register(crashingAdapter("crasher"));

  await registry.connectAll();
  const health = await registry.healthAll();

  assert.equal(health["hermes"].ok, true);
  assert.equal(health["opencode"].ok, false);
  assert.equal(typeof health["opencode"].detail, "string");
  assert.equal(health["crasher"].ok, false);
  assert.match(String(health["crasher"].detail), /INTERNAL|boom-health/);
});

test("registry: statusAll reports offline for an unreachable adapter (and a crash)", async () => {
  const registry = createAgentRegistry();
  registry.register(createMockHermes({ failAt: "connect" })); // never connects
  registry.register(crashingAdapter("crasher"));

  const statuses = await registry.statusAll();
  const byId = Object.fromEntries(statuses.map((s) => [s.id, s]));

  assert.equal(byId["hermes"].state, "offline");
  assert.equal(byId["crasher"].state, "offline");
});

test("registry: statusAll reflects connected -> idle for a healthy adapter", async () => {
  const registry = createAgentRegistry();
  const hermes = createMockHermes();
  registry.register(hermes);
  await registry.connectAll();

  const statuses = await registry.statusAll();
  assert.equal(statuses[0].state, "idle");
});

test("registry: onEvent fires on register and on connect transitions", async () => {
  const seen = [];
  const registry = createAgentRegistry({ onEvent: (type, payload) => seen.push({ type, payload }) });

  registry.register(createMockHermes());
  registry.register(createMockOpenCode({ failAt: "connect" }));
  await registry.connectAll();
  registry.unregister("hermes");

  const types = seen.map((entry) => entry.type);
  assert.ok(types.includes("agent.registered"), "register must emit");
  assert.ok(types.includes("agent.connected"), "a successful connect must emit");
  assert.ok(types.includes("agent.error"), "a failed connect must be observable");
  assert.ok(types.includes("agent.unregistered"), "unregister must emit");
});

test("registry: disconnectAll never throws even when an adapter does", async () => {
  const registry = createAgentRegistry();
  registry.register(createMockHermes());
  registry.register({
    ...crashingAdapter("bad-disconnect"),
    disconnect: async () => {
      throw new Error("boom-disconnect");
    },
  });

  await registry.disconnectAll(); // must resolve
});
