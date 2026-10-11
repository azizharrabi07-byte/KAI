// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * L2 — a behaviour change, TRACED (Phase 4 gap 4).
 * Run from `core/`:  node --test tests/learning-trace.test.ts
 *
 * The Phase 2 review recorded L2 as PARTIAL: persistence was proven, but a
 * changed-behaviour ACTION TRACE was not produced. This file produces it, on the
 * real runtime, as one correlated chain:
 *
 *   a user-sourced lesson
 *     -> a learning.propose action.executed record whose `memoryId` names the
 *        exact memory entry the learning wrote (the trace)
 *     -> a LATER composed turn prompt whose recalled-memory section contains that
 *        lesson (the behaviour change), which an identically-composed prompt did
 *        NOT contain before the lesson existed.
 *
 * If the action trace were unproducible, this test could not pass — so it is
 * evidence, not a comment.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCoreRuntime } from "../src/runtime.ts";
import { createCoreApi } from "../src/api/routes.ts";

const LESSON = "The release codename is bluefalcon.";
const REQUEST = "bluefalcon";

test("L2: a learned lesson produces an action trace AND changes a later composed prompt", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kai-learning-trace-"));
  const runtime = createCoreRuntime({
    dbPath: join(dir, "kai.db"),
    agents: { mode: "mock" },
    startScheduler: false,
    subsystemPaths: { runUpkeepOnStart: false },
  });
  t.after(async () => {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  // Capture the action records the boundary emits.
  const records: Array<Record<string, unknown>> = [];
  runtime.bus.subscribe((event) => {
    if (event.type === "action.executed") records.push(event.payload as Record<string, unknown>);
  });

  // ── BEFORE: the lesson does not exist, so it is not recalled ────────────────
  const before = await runtime.composeTurnPrompt(REQUEST);
  assert.ok(
    !before.text.includes(LESSON),
    "the lesson must not be recalled before it has been learned",
  );
  assert.equal(before.sections.find((s) => s.name === "memory"), undefined);

  // ── the user teaches KAI (the HOST path: source "user") ────────────────────
  const learned = await runtime.tools.invoke("learning.propose", {
    kind: "user_correction",
    source: "user",
    userText: LESSON,
    correction: { before: "codename", after: LESSON },
  });
  assert.equal(learned.ok, true, JSON.stringify(learned));
  const outcome = (learned as { result: { decision: string; memory?: { entryId?: string; content?: string } } }).result;
  assert.equal(outcome.decision, "memory", JSON.stringify(outcome));
  const entryId = outcome.memory?.entryId;
  assert.ok(typeof entryId === "string" && entryId.length > 0, "the lesson must name the memory entry it wrote");

  // ── the ACTION TRACE: a record that names the memory artifact ──────────────
  const trace = records.find(
    (record) => record.toolId === "learning.propose" && record.resultState === "EXECUTED",
  );
  assert.ok(trace !== undefined, "learning.propose must have emitted an action.executed record");
  assert.equal(trace.memoryId, entryId, "the action trace must name the learned memory entry");

  // ── AFTER: the SAME request now recalls the lesson into the prompt ─────────
  const after = await runtime.composeTurnPrompt(REQUEST);
  assert.ok(after.text.includes(LESSON), "the learned lesson must reach a later composed prompt");
  const memorySection = after.sections.find((s) => s.name === "memory");
  assert.ok(memorySection !== undefined, "the memory section must be present after learning");

  // ── and the trace is readable over the API, not only from the bus ──────────
  const api = createCoreApi(runtime);
  const listed = await api.handle({ method: "GET", path: "/actions", query: new URLSearchParams({ limit: "50" }) });
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  const actions = (listed.body as { actions: Array<Record<string, unknown>> }).actions;
  const apiTrace = actions.find((record) => record.toolId === "learning.propose" && record.memoryId === entryId);
  assert.ok(apiTrace !== undefined, "GET /actions must expose the trace");

  // ── and the composed prompt is readable over the API too ───────────────────
  const composed = await api.handle({
    method: "POST",
    path: "/prompts/compose",
    query: new URLSearchParams(), attested: true, ownerAuthConfigured: true,
    body: { request: REQUEST },
  });
  assert.equal(composed.status, 200, JSON.stringify(composed.body));
  assert.ok((composed.body as { prompt: { text: string } }).prompt.text.includes(LESSON));
});
