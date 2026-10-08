// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * P5 — plugin foundation: manifest, lifecycle, ceiling, config, one plane.
 *
 * A REAL plugin module (pure functions, no mocks) is defined, invoked through
 * the ONE registry boundary (validate -> policy -> execute), disabled and
 * removed with honest refusals, and persisted across registry reopens. A tool
 * above the manifest ceiling is refused at define time; a WRITE tool parks
 * under the default policy.
 *
 * Run from `core/`:  node --test tests/plugins.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createToolRegistry } from "../src/tools/registry.ts";
import { createPolicyEngine } from "../src/policies/gate.ts";
import { createPluginRegistry } from "../src/plugins/registry.ts";
import { pluginToolId } from "../src/plugins/registry.ts";
import type { PluginModule } from "../src/plugins/types.ts";

function tempRoot(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), "kai-plugins-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function harness(t: { after: (fn: () => void) => void }) {
  const tools = createToolRegistry({ policy: createPolicyEngine(), coreBuildId: "plugins-test" });
  const plugins = createPluginRegistry({ root: join(tempRoot(t), "plugins"), tools });
  return { tools, plugins };
}

/** A real plugin: pure string/date functions with honest validators. */
function textPlugin(): PluginModule {
  return {
    manifest: {
      id: "textutils",
      name: "Text utilities",
      version: "1.0.0",
      description: "Small pure-text helpers.",
      maxRisk: "READ",
      capabilities: ["text"],
      config: {
        shoutSuffix: { type: "string", description: "Appended by shout.", default: "!" },
      },
    },
    tools: [
      {
        id: "upper",
        name: "Uppercase text",
        description: "Return the input text in uppercase.",
        risk: "READ",
        validate: (input) =>
          typeof input === "object" && input !== null && typeof (input as Record<string, unknown>).text === "string"
            ? { ok: true, value: input }
            : { ok: false, reason: "text must be a string" },
        execute: (input) => ({ upper: ((input as { text: string }).text as string).toUpperCase() }),
      },
      {
        id: "shout",
        name: "Shout text",
        description: "Uppercase plus the configured suffix.",
        risk: "READ",
        validate: (input) =>
          typeof input === "object" && input !== null && typeof (input as Record<string, unknown>).text === "string"
            ? { ok: true, value: input }
            : { ok: false, reason: "text must be a string" },
        execute: (input) => {
          const record = input as { text: string; $plugin: { config: Record<string, unknown> } };
          return { shout: `${record.text.toUpperCase()}${String(record.$plugin.config.shoutSuffix ?? "")}` };
        },
      },
    ],
  };
}

test("define registers namespaced tools on the ONE plane; invoke runs the boundary", async (t) => {
  const { tools, plugins } = harness(t);
  const defined = await plugins.define({ module: textPlugin() });
  assert.equal(defined.ok, true, JSON.stringify(defined.ok ? {} : defined.error));
  if (!defined.ok) return;
  assert.deepEqual(defined.value.toolIds, ["plugin.textutils.upper", "plugin.textutils.shout"]);
  assert.deepEqual(defined.value.config, { shoutSuffix: "!" }, "defaults applied at define time");

  const ran = await tools.invoke("plugin.textutils.upper", { text: "hello" });
  assert.equal(ran.ok, true);
  if (ran.ok) assert.deepEqual(ran.result, { upper: "HELLO" });
  assert.equal(ran.invocation.status, "EXECUTED");

  const bad = await tools.invoke("plugin.textutils.upper", { text: 42 });
  assert.equal(bad.ok, false);
  assert.equal(bad.invocation.status, "INVALID", "the plugin validator runs first, like every tool");
});

test("config flows into execution and validates on set", async (t) => {
  const { tools, plugins } = harness(t);
  assert.equal((await plugins.define({ module: textPlugin() })).ok, true);
  const before = await tools.invoke("plugin.textutils.shout", { text: "hey" });
  assert.ok(before.ok && JSON.stringify(before.result).includes("HEY!"));

  assert.equal(plugins.setConfig("textutils", "shoutSuffix", "?").ok, true);
  const after = await tools.invoke("plugin.textutils.shout", { text: "hey" });
  assert.ok(after.ok && JSON.stringify(after.result).includes("HEY?"), "live config, no re-register");

  const wrongType = plugins.setConfig("textutils", "shoutSuffix", 42);
  assert.equal(wrongType.ok, false);
  const unknownKey = plugins.setConfig("textutils", "nope", "x");
  assert.equal(unknownKey.ok, false);
});

test("disable refuses at validation; enable restores; remove forgets", async (t) => {
  const { tools, plugins } = harness(t);
  assert.equal((await plugins.define({ module: textPlugin() })).ok, true);
  assert.equal(plugins.disable("textutils").ok, true);
  const refused = await tools.invoke("plugin.textutils.upper", { text: "hi" });
  assert.equal(refused.ok, false);
  assert.equal(refused.invocation.status, "INVALID");
  assert.match(refused.error.message, /disabled/);

  assert.equal(plugins.enable("textutils").ok, true);
  assert.equal((await tools.invoke("plugin.textutils.upper", { text: "hi" })).ok, true);

  assert.equal(plugins.remove("textutils").ok, true);
  assert.equal(plugins.get("textutils"), null);
  const afterRemove = await tools.invoke("plugin.textutils.upper", { text: "hi" });
  assert.equal(afterRemove.ok, false, "a removed plugin's tools refuse without touching the registry");
});

test("the ceiling is enforced at define time; duplicates and bad ids refused", async (t) => {
  const { plugins } = harness(t);
  const over = await plugins.define({
    module: {
      manifest: { id: "risky", name: "R", version: "1", description: "R.", maxRisk: "READ" },
      tools: [
        {
          id: "wipe",
          name: "W",
          description: "W.",
          risk: "DESTRUCTIVE",
          validate: (input) => ({ ok: true, value: input }),
          execute: () => null,
        },
      ],
    },
  });
  assert.equal(over.ok, false);
  if (!over.ok) assert.equal(over.error.code, "RISK_EXCEEDED");

  assert.equal((await plugins.define({ module: textPlugin() })).ok, true);
  const twice = await plugins.define({ module: textPlugin() });
  assert.equal(twice.ok, false);
  if (!twice.ok) assert.equal(twice.error.code, "ALREADY_EXISTS");

  const badId = await plugins.define({
    module: { manifest: { id: "../escape", name: "E", version: "1", description: "E." }, tools: [] },
  });
  assert.equal(badId.ok, false);
});

test("a WRITE plugin tool parks under the default policy", async (t) => {
  const tools = createToolRegistry({ policy: createPolicyEngine(), coreBuildId: "plugins-test" });
  const plugins = createPluginRegistry({ root: join(tempRoot(t), "plugins"), tools });
  const defined = await plugins.define({
    module: {
      manifest: { id: "writer", name: "W", version: "1", description: "W.", maxRisk: "WRITE" },
      tools: [
        {
          id: "note",
          name: "N",
          description: "N.",
          risk: "WRITE",
          validate: (input) => ({ ok: true, value: input }),
          execute: () => ({ noted: true }),
        },
      ],
    },
  });
  assert.equal(defined.ok, true);
  const parked = await tools.invoke(pluginToolId("writer", "note"), {});
  assert.equal(parked.ok, false);
  assert.equal(parked.invocation.status, "APPROVAL_REQUIRED", "plugin WRITE tools park like any other");
});

test("the catalogue persists across registry reopens", async (t) => {
  const root = join(tempRoot(t), "plugins");
  const firstTools = createToolRegistry({ policy: createPolicyEngine(), coreBuildId: "plugins-test" });
  const first = createPluginRegistry({ root, tools: firstTools });
  assert.equal((await first.define({ module: textPlugin() })).ok, true);
  assert.equal(first.list().length, 1);

  const secondTools = createToolRegistry({ policy: createPolicyEngine(), coreBuildId: "plugins-test" });
  const second = createPluginRegistry({ root, tools: secondTools });
  assert.equal(second.list().length, 1, "the catalogue rehydrates");
  assert.equal(second.get("textutils")?.status, "enabled");
});
