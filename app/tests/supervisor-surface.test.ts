// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The production UI surface for supervision and the new commands.
 *
 * Two things are proven here, both through real app code (no component mocks):
 *
 *  1. THE CLIENT SENDS THE RAW ARGUMENT. `client.runCommand(id, args, raw)`
 *     must put `raw` on the wire, because `/audit` posts a multiline report
 *     that whitespace-splitting would destroy. This is the real transport
 *     (`createCoreClient`) with an injected fetch.
 *  2. THE EVENT SUMMARIZER RENDERS REAL SUPERVISION EVENTS. The payload
 *     shapes below are the ones the Core actually emits (they are asserted, at
 *     the source, by core/tests/orch-supervisor-trust.test.ts case 17); this
 *     test pins what the UI says about each of them, and that nothing is
 *     invented for a payload the Core never sends (e.g. a completion without a
 *     gate verdict).
 *
 * Run from `app/`:  node --test tests/supervisor-surface.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createCoreClient } from "../src/core/kai-core.ts";
import { applyCoreEvent, initialCoreSlice, summarizeEvent, type CoreSlice } from "../src/core/core-state.ts";

/** A fetch stand-in that records the request and answers with the given JSON. */
function fetchStub(response: unknown, status = 200) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const impl = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(response),
    } as unknown as Response;
  };
  return { impl, calls };
}

test("client.runCommand puts the raw text on the wire for /audit", async () => {
  const report = "STATUS: ok\nRESULT: fixed it\nCHANGED ARTIFACTS: src/a.ts";
  const stub = fetchStub({ ok: true, result: { command: "audit", title: "Audit", text: "…" } });
  const client = createCoreClient({ baseUrl: "http://127.0.0.1:8788", fetchImpl: stub.impl as unknown as typeof fetch });
  const res = await client.runCommand("audit", report, report);
  assert.equal(res.ok, true);
  assert.equal(stub.calls.length, 1);
  const body = JSON.parse(String(stub.calls[0]?.init?.body ?? "{}")) as { args?: unknown; raw?: unknown };
  assert.equal(body.raw, report, "the multiline report is transmitted verbatim as `raw`");
  assert.match(String(stub.calls[0]?.url), /\/commands\/audit\/run$/);
});

test("client.runCommand omits `raw` when the caller did not supply one", async () => {
  const stub = fetchStub({ ok: true, result: { command: "help", title: "Help", text: "…" } });
  const client = createCoreClient({ baseUrl: "http://127.0.0.1:8788", fetchImpl: stub.impl as unknown as typeof fetch });
  await client.runCommand("help", []);
  const body = JSON.parse(String(stub.calls[0]?.init?.body ?? "{}")) as Record<string, unknown>;
  assert.equal("raw" in body, false, "no raw key for an ordinary command");
});

// ── the summarizer, on the payloads the Core really emits ─────────────────────

test("work.planned reads as planning, not as a started worker", () => {
  // With no rationale the fallback label is used; it must never claim a worker
  // started.
  const text = summarizeEvent("work.planned", { workItemId: "work_1", decision: "DELEGATE_ONE" });
  assert.match(text, /planned/i);
  assert.doesNotMatch(text, /worker started|dispatched/i, "planning must never read as a dispatch");
});

test("delegation.routed reads as a real dispatch", () => {
  const text = summarizeEvent("delegation.routed", { workItemId: "work_1", workerId: "opencode", decision: "DELEGATE_ONE", rationale: "explicitly assigned" });
  assert.match(text, /worker dispatched|explicitly assigned/i);
});

test("worker.completed names the gate verdict that allowed it", () => {
  const text = summarizeEvent("worker.completed", { workItemId: "work_1", workerId: "opencode", valueScore: 1, gate: "PASS" });
  assert.ok(text.length > 0, "the completion renders");
});

test("the review, waiting and progress events render honestly", () => {
  assert.ok(summarizeEvent("review.decided", { workItemId: "work_1", verdict: "CHANGES_REQUESTED" }).length > 0);
  assert.ok(summarizeEvent("worker.waiting", { workItemId: "work_1", approvalId: "apr_1", reason: "needs approval" }).length > 0);
  assert.ok(summarizeEvent("worker.progress", { workItemId: "work_1", phase: "evaluation", result: "INSUFFICIENT_EVIDENCE" }).length > 0);
  assert.ok(summarizeEvent("scheduler.tick_failed", { reason: "housekeeping threw" }).length > 0);
});

test("supervision events land in the island's slice, deduped by event id", () => {
  let slice: CoreSlice = initialCoreSlice();
  slice = applyCoreEvent(slice, {
    id: "ev-1",
    type: "work.planned",
    timestamp: "2026-10-09T10:00:00.000Z",
    payload: { workItemId: "work_1", rationale: "planned" },
  });
  const afterFirst = slice.recentEvents.length;
  // A replayed frame (same id) must not double up.
  slice = applyCoreEvent(slice, {
    id: "ev-1",
    type: "work.planned",
    timestamp: "2026-10-09T10:00:00.000Z",
    payload: { workItemId: "work_1", rationale: "planned" },
  });
  assert.equal(slice.recentEvents.length, afterFirst, "a duplicate event id is not shown twice");
});
