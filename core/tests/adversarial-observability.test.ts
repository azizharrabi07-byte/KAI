// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Adversarial second pass — the observability dedup mislink.
 *
 * Run from `core/`:  node --test tests/adversarial-observability.test.ts
 *
 * docs/phase2-falsifications.md records this as a CANDIDATE mislink "not proven
 * live": a deduped `memory.write` returns the EXISTING entry id, so a second
 * action record names a memory it did not create, and `traceArtifact` resolves
 * the memory to the wrong action. This file proved it on the real runtime (a
 * temp DB, mock agents, no port, no product).
 *
 * RESOLVED (owner decision): a write only names an artifact it actually created,
 * so a deduped write names nothing and the trace is unambiguous. This file now
 * asserts that resolution instead of the defect it was written to demonstrate.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCoreRuntime } from "../src/runtime.ts";
import { traceArtifact } from "../src/observability/correlation.ts";

interface WriteResult {
  ok?: boolean;
  deduped?: boolean;
  entry?: { id?: string };
}

test("adversarial: a deduped memory.write names no artifact, so the trace resolves to the creating action", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kai-adv-obs-"));
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

  // memory.write is a KAI-internal-state tool, so the default policy allows it.
  const input = { content: "adversarial dedup probe fact", type: "note", scope: "global" };
  const first = (await runtime.tools.invoke("memory.write", input)) as { ok: boolean; result?: unknown };
  const second = (await runtime.tools.invoke("memory.write", input)) as { ok: boolean; result?: unknown };
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(second.ok, true, JSON.stringify(second));

  const firstEntry = (first.result as WriteResult).entry;
  const secondEntry = (second.result as WriteResult).entry;
  const firstId = firstEntry?.id ?? "";
  const secondId = secondEntry?.id ?? "";
  assert.ok(firstId.length > 0, "the first write names its new entry");

  // The dedup path returns the EXISTING entry — the engine's documented behaviour.
  assert.equal((second.result as WriteResult).deduped, true, "the second write is a dedup");
  assert.equal(firstId, secondId, "a deduped write returns the id of the entry that already existed");

  const writes = records.filter((r) => r.toolId === "memory.write" && r.resultState === "EXECUTED");
  assert.equal(writes.length, 2, "both writes emitted an action.executed record");
  const firstAction = writes[0]!;
  const secondAction = writes[1]!;

  // RESOLVED: only the write that CREATED the entry names it. The first action
  // names the memory; the deduped second action names nothing, because it
  // produced nothing.
  assert.equal(firstAction.memoryId, firstId, "the creating action names the memory it wrote");
  assert.equal(secondAction.memoryId, undefined, "a deduped write names no artifact: it created none");

  // Exactly one action claims the artifact, so the trace is unambiguous and
  // resolves to the action that actually created the memory.
  const events = runtime.stores.events.listEvents({ types: ["action.executed"], limit: 50 });
  const claimers = events.filter((e) => (e.payload as { memoryId?: string }).memoryId === firstId);
  assert.equal(claimers.length, 1, "exactly one action record claims the memory");
  const trace = traceArtifact(events, { kind: "memory", id: firstId });
  assert.equal(trace.linked, true, trace.reason);
  assert.equal(trace.actionId, firstAction.actionId, "the trace resolves to the action that created the memory");
});
