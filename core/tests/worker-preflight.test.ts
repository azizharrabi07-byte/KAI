// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Worker preflight: the two onboarding gaps found by running a live goal, made
 * visible BEFORE a plan is compiled.
 *
 * A fresh Core has no registered worker and defaults to `workerAuto: "ASK"`, so a
 * goal compiled and then refused to dispatch — correct, and invisible until the
 * goal was already half-executed. This report names exactly what is missing.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { buildWorkerPreflight } from "../src/workforce/preflight.ts";

test("a fresh Core reports what is missing instead of failing after compiling", (t) => {
  const report = buildWorkerPreflight({
    personas: [],
    health: { hermes: { ok: true, detail: "reachable" }, opencode: { ok: false, detail: "upstream_unreachable" } },
    capabilities: { hermes: ["health", "run_task"], opencode: ["health"] },
    autonomy: { workerAuto: "ASK", level: 2 },
  });
  assert.equal(report.ready, false);
  // Both real gaps are named, and named as DIFFERENT things.
  assert.ok(report.blockers.some((b) => /no worker is REGISTERED/.test(b)), JSON.stringify(report.blockers));
  assert.ok(report.blockers.some((b) => /workerAuto is "ASK"/.test(b)), JSON.stringify(report.blockers));
  // Installing is not registration, and registration is not reachability.
  const hermes = report.workers.find((w) => w.id === "hermes");
  assert.equal(hermes?.installed, true, "installed");
  assert.equal(hermes?.reachable, true, "reachable");
  assert.equal(hermes?.registered, false, "but NOT registered — nothing can select it yet");
  const opencode = report.workers.find((w) => w.id === "opencode");
  assert.equal(opencode?.installed, true);
  assert.equal(opencode?.reachable, false);
  assert.equal(opencode?.reason, "upstream_unreachable", "the adapter's own words are kept");
  t.diagnostic(report.blockers.join(" | "));
});

test("a configured Core reports ready, and says why", (t) => {
  const report = buildWorkerPreflight({
    personas: ["hermes"],
    health: { hermes: { ok: true, detail: "reachable" } },
    capabilities: { hermes: ["health", "run_task"] },
    autonomy: { workerAuto: "AUTO", level: 3 },
  });
  assert.equal(report.ready, true, JSON.stringify(report.blockers));
  assert.deepEqual(report.blockers, []);
  assert.equal(report.executionMode.autonomousDispatchReady, true);
  assert.match(report.executionMode.why, /without asking/);
  t.diagnostic(report.executionMode.why);
});

test("a registered persona whose runtime is unreachable is still not ready", (t) => {
  const report = buildWorkerPreflight({
    personas: ["hermes"],
    health: { hermes: { ok: false, detail: "ECONNREFUSED 127.0.0.1:8642" } },
    capabilities: { hermes: ["health"] },
    autonomy: { workerAuto: "AUTO", level: 3 },
  });
  assert.equal(report.ready, false, "registration is not reachability");
  assert.ok(report.blockers.some((b) => /no worker is REACHABLE/.test(b)), JSON.stringify(report.blockers));
  assert.match(report.blockers.join(" "), /ECONNREFUSED/, "the real reason is quoted");
  t.diagnostic(report.blockers.join(" | "));
});

test("the preflight reports; it never enables", (t) => {
  // The report must not claim to have changed a setting. It is a READ surface.
  const report = buildWorkerPreflight({
    personas: [],
    health: { hermes: { ok: true, detail: "reachable" } },
    capabilities: { hermes: [] },
    autonomy: { workerAuto: "OFF", level: 0 },
  });
  assert.equal(report.ready, false);
  assert.equal(report.executionMode.workerAuto, "OFF", "the reported mode is the actual mode, unmodified");
  assert.equal(report.executionMode.autonomyLevel, 0);
  t.diagnostic(report.executionMode.why);
});
