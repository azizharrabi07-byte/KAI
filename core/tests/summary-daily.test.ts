// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The daily work-summary offer and report.
 *
 * Two properties, each pinned by the failure it prevents:
 *
 *  - THE OFFER IS DURABLE AND BOUNDED. At most one offer per LOCAL calendar
 *    day, from the durable settings store, so a Core restart cannot re-offer
 *    and two ticks cannot double-offer. It fires after the configured local
 *    time, only when meaningful work happened, and never for an empty day.
 *  - THE REPORT IS EVIDENCE-BACKED AND RECONCILES. Its per-state counts sum to
 *    the item count, and a COMPLETED item with no KAI-observed record is
 *    reported as worker-reported — never counted as verified.
 *
 * Time is injected everywhere, so this suite never sleeps.
 *
 * Run from `core/`:  node --test tests/summary-daily.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createDailySummaryService, offerTimeMinutes } from "../src/summary/daily.ts";
import { createWorkBoard, type WorkBoard } from "../src/orchestration/board.ts";
import { createNotificationService } from "../src/notifications/service.ts";
import { createEventBus } from "../src/events/bus.ts";
import { openSqliteStores } from "../src/storage/sqlite.ts";
import type { Stores } from "../src/shared/contracts.ts";

const AT = new Date("2026-06-15T20:00:00.000Z"); // 20:00 UTC on 2026-06-15

function fixture(opts: { time?: string; timezone?: string; minWorkItems?: number; at?: Date } = {}) {
  const stores = openSqliteStores({ path: ":memory:" });
  const board = createWorkBoard(stores.workItems, { now: () => (opts.at ?? AT).toISOString() });
  const bus = createEventBus();
  const notifications = createNotificationService({ store: stores.notifications, bus, now: () => opts.at ?? AT });
  const summary = createDailySummaryService({
    workItems: stores.workItems,
    activity: stores.activity,
    notifications,
    settings: stores.settings,
    now: () => opts.at ?? AT,
    config: () => ({
      enabled: true,
      time: opts.time ?? "18:00",
      timezone: opts.timezone ?? "UTC",
      minWorkItems: opts.minWorkItems ?? 1,
    }),
  });
  return { stores, board, notifications, summary, close: () => stores.close() };
}

/** Seed a work item in a given state with evidence; returns its board id. */
function seed(board: WorkBoard, opts: { state: string; observed?: number; reported?: number }): string {
  const created = board.create({ objective: `objective for ${opts.state}`, deliverable: "the thing" });
  if (!created.ok) assert.fail(created.reason);
  const id = created.value.id;
  const records = [
    ...Array.from({ length: opts.observed ?? 0 }, (_, i) => ({
      id: `ev_o${i}`,
      kind: "check",
      source: "kai-observed" as const,
      method: "fixture",
      detail: "established",
      supports: ["x"],
      at: AT.toISOString(),
    })),
    ...Array.from({ length: opts.reported ?? 0 }, (_, i) => ({
      id: `ev_r${i}`,
      kind: "worker claim",
      source: "worker-reported" as const,
      method: "worker-handoff",
      detail: "claimed",
      supports: [],
      at: AT.toISOString(),
    })),
  ];
  if (records.length > 0) board.recordEvidence(id, records);
  // Force the item into the state under test through the real board transitions.
  if (opts.state === "COMPLETED") {
    board.complete(id, { status: "ok", result: "done", changedArtifacts: [], evidence: [], blockers: [], risks: [], followUps: [], toolsUsed: [] });
  } else if (opts.state === "FAILED") {
    board.fail(id, "boom");
  } else if (opts.state === "BLOCKED") {
    board.block(id, "needs a decision");
  } else if (opts.state === "WAITING") {
    board.wait(id, "waiting on approval");
  } else if (opts.state === "CANCELLED") {
    board.cancel(id, "cancelled");
  }
  return id;
}

// ── The offer ─────────────────────────────────────────────────────────────────

test("offer fires after the configured local time, once per local day", () => {
  const f = fixture({ time: "18:00" });
  try {
    seed(f.board, { state: "COMPLETED", observed: 1 });
    const first = f.summary.maybeOffer(AT);
    assert.ok(first !== null, "an offer is made at 20:00 with the time set to 18:00");
    assert.equal(first?.type, "summary.daily.offer");
    assert.match(first?.message ?? "", /1 item\(s\) moved/, "the offer counts real work");
    // Same local day, later: no second offer.
    assert.equal(f.summary.maybeOffer(new Date("2026-06-15T23:00:00.000Z")), null);
    assert.equal(f.summary.state().lastOfferLocalDate, "2026-06-15");
    assert.equal(f.notifications.list().length, 1, "exactly one notification was created");
  } finally {
    f.close();
  }
});

test("no offer before the configured time", () => {
  const f = fixture({ time: "23:00" });
  try {
    seed(f.board, { state: "COMPLETED", observed: 1 });
    assert.equal(f.summary.maybeOffer(AT), null, "20:00 is before a 23:00 offer time");
    assert.equal(f.summary.state().lastOfferLocalDate, undefined, "a skipped hour does not consume the day");
  } finally {
    f.close();
  }
});

test("no offer on an empty day — and the day is NOT consumed, so work later can still be offered", () => {
  const f = fixture({ time: "18:00" });
  try {
    assert.equal(f.summary.maybeOffer(AT), null, "nothing happened: no offer, no spam");
    assert.equal(f.summary.state().lastOfferLocalDate, undefined);
    seed(f.board, { state: "COMPLETED", observed: 1 });
    assert.ok(f.summary.maybeOffer(AT) !== null, "work that appears later the same day is still offered");
  } finally {
    f.close();
  }
});

test("the offer is restart-safe: a new service over the same stores does not re-offer", () => {
  const stores = openSqliteStores({ path: ":memory:" });
  try {
    const board = createWorkBoard(stores.workItems, { now: () => AT.toISOString() });
    seed(board, { state: "COMPLETED", observed: 1 });
    const bus = createEventBus();
    const notifications = createNotificationService({ store: stores.notifications, bus, now: () => AT });
    const config = () => ({ enabled: true, time: "18:00", timezone: "UTC", minWorkItems: 1 });
    const first = createDailySummaryService({ workItems: stores.workItems, activity: stores.activity, notifications, settings: stores.settings, now: () => AT, config });
    assert.ok(first.maybeOffer(AT) !== null);
    // A second service = a restarted Core over the same durable state.
    const second = createDailySummaryService({ workItems: stores.workItems, activity: stores.activity, notifications, settings: stores.settings, now: () => AT, config });
    assert.equal(second.maybeOffer(AT), null, "the restart must not re-offer the same local day");
    assert.equal(second.state().lastOfferLocalDate, "2026-06-15");
  } finally {
    stores.close();
  }
});

test("timezone: the offer day is the LOCAL day, not the UTC day", () => {
  // 2026-06-16T02:00Z is 2026-06-15T19:00 in Los Angeles (UTC-7 in June): the
  // offer time (18:00) is past, and the LOCAL date is the 15th while UTC is
  // already the 16th. The recorded day must be the local one.
  const at = new Date("2026-06-16T02:00:00.000Z");
  const f = fixture({ time: "18:00", timezone: "America/Los_Angeles", at });
  try {
    seed(f.board, { state: "COMPLETED", observed: 1 });
    assert.ok(f.summary.maybeOffer(at) !== null);
    assert.equal(f.summary.state().lastOfferLocalDate, "2026-06-15", "the local date is what is recorded");
    assert.equal(f.summary.today(), "2026-06-15");
  } finally {
    f.close();
  }
});

test("DST: a spring-forward local day is 23 hours long, not a fixed 24", () => {
  const f = fixture({ timezone: "Europe/Berlin" });
  try {
    // 2026-03-29 is the EU spring-forward day: 00:00 → 24:00 lasts 23 hours.
    const out = f.summary.reportFor("2026-03-29", "2026-03-29");
    const spanMs = Date.parse(out.report.to) - Date.parse(out.report.from) + 1;
    assert.equal(spanMs, 23 * 60 * 60 * 1000, `expected a 23h window, got ${spanMs / 3_600_000}h`);
  } finally {
    f.close();
  }
});

test("offerTimeMinutes parses valid times and falls back safely", () => {
  assert.equal(offerTimeMinutes("18:00"), 1080);
  assert.equal(offerTimeMinutes("00:00"), 0);
  assert.equal(offerTimeMinutes("23:59"), 1439);
  assert.equal(offerTimeMinutes("garbage"), 1080, "a malformed time is not a crash");
  assert.equal(offerTimeMinutes("99:99"), 1080);
});

// ── The report ────────────────────────────────────────────────────────────────

test("report separates verified from worker-reported and its counts reconcile", () => {
  const f = fixture({ timezone: "UTC" });
  try {
    const verifiedId = seed(f.board, { state: "COMPLETED", observed: 2 });
    const reportedId = seed(f.board, { state: "COMPLETED", reported: 1 });
    seed(f.board, { state: "BLOCKED" });
    seed(f.board, { state: "FAILED" });
    seed(f.board, { state: "WAITING" });

    const { report } = f.summary.reportFor("2026-06-15", "2026-06-15");
    assert.equal(report.totals.tasks, 5);
    assert.equal(report.totals.verified, 1, "only the item with an OBSERVED record is verified");
    assert.equal(report.totals.reportedOnly, 1, "a completion with no observed record is reported-only");
    assert.equal(report.totals.blocked, 1);
    assert.equal(report.totals.failed, 1);
    assert.equal(report.totals.waiting, 1);
    // The counts reconcile exactly with the included items.
    const sum =
      report.totals.verified + report.totals.reportedOnly + report.totals.planned + report.totals.running +
      report.totals.waiting + report.totals.blocked + report.totals.failed + report.totals.cancelled;
    assert.equal(sum, report.totals.tasks, "per-state counts must sum to the item count");
    assert.equal(report.items.length, report.totals.tasks);
    // And the reported-only item is NEVER labelled verified.
    const reportedItem = report.items.find((i) => i.id === reportedId);
    assert.equal(reportedItem?.classification, "reported-only");
    assert.equal(reportedItem?.observedEvidence, 0);
    const verifiedItem = report.items.find((i) => i.id === verifiedId);
    assert.equal(verifiedItem?.classification, "verified");
    const text = f.summary.renderReport(report);
    assert.match(text, /Worker-reported only \(unverified/);
    assert.doesNotMatch(text, new RegExp(`${reportedId}[^\\n]*KAI-observed`), "no fabricated verification claim");
  } finally {
    f.close();
  }
});

test("report is honest when nothing happened", () => {
  const f = fixture();
  try {
    const out = f.summary.reportFor("2026-06-15", "2026-06-15");
    assert.equal(out.report.empty, true);
    assert.equal(out.report.totals.tasks, 0);
    assert.match(out.text, /nothing to report/i);
  } finally {
    f.close();
  }
});

test("report includes real checks KAI ran, with exit status", () => {
  const f = fixture();
  try {
    const created = f.board.create({ objective: "run the tests", deliverable: "tests" });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const id = created.value.id;
    f.board.recordEvidence(id, [
      {
        id: "ev_check_1",
        kind: "test result",
        source: "kai-observed",
        method: "shell.run",
        detail: "npm test exited 1",
        command: "npm test (cwd C:/p)",
        exitCode: 1,
        outputPreview: "2 failed",
        supports: [],
        at: AT.toISOString(),
      },
    ]);
    const { report } = f.summary.reportFor("2026-06-15", "2026-06-15");
    const item = report.items.find((i) => i.id === id);
    assert.equal(item?.checks.length, 1);
    assert.equal(item?.checks[0]?.exitCode, 1);
    assert.equal(item?.checks[0]?.ok, false);
  } finally {
    f.close();
  }
});

test("the report never fires on its own: only maybeOffer notifies", () => {
  const f = fixture();
  try {
    seed(f.board, { state: "COMPLETED", observed: 1 });
    f.summary.reportFor("2026-06-15", "2026-06-15");
    assert.equal(f.notifications.list().length, 0, "building a report sends nothing");
    assert.ok(f.summary.maybeOffer(AT) !== null);
    assert.equal(f.notifications.list().length, 1, "only the offer notifies");
    // The offer is a short prompt, not a report dump.
    const notice = f.notifications.list()[0];
    assert.ok((notice?.message ?? "").length < 200, "the offer stays short; the report is on request");
  } finally {
    f.close();
  }
});
