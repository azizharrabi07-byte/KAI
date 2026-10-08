// Regression tests for the "20707d" bug: Hermes reports session timestamps in
// Unix SECONDS, and passing them to `new Date()` (which reads numbers as
// MILLISECONDS) rendered a session from minutes ago as ~20,707 days old.
//
//   cd app && npm test
//
// The fixed value below is taken verbatim from a live GET /api/sessions on the
// Hermes install, so the regression is pinned to the real payload shape rather
// than to a number invented for the test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { timeAgo } from "../src/core/timeAgo.ts";

/** The exact shape Hermes returns: float Unix seconds. */
const HERMES_LIVE_SAMPLE = 1790888537.0502937;

function withNow(fixedMs: number, fn: () => void) {
  const real = Date.now;
  Date.now = () => fixedMs;
  try {
    fn();
  } finally {
    Date.now = real;
  }
}

test("the live Hermes sample renders as an age, not as 20707d", () => {
  // 2026-10-01T21:02:17Z, one hour before the sample was captured.
  withNow(HERMES_LIVE_SAMPLE * 1000 + 3600_000, () => {
    const out = timeAgo(HERMES_LIVE_SAMPLE);
    assert.equal(out, "1h");
    assert.ok(!out.endsWith("d"), `seconds must not be read as milliseconds: got ${out}`);
  });
});

test("very recent: seconds and milliseconds agree", () => {
  const now = Date.now();
  assert.equal(timeAgo(Math.floor(now / 1000) - 5), "just now"); // seconds
  assert.equal(timeAgo(now - 5000), "just now"); // milliseconds
});

test("one minute ago", () => {
  const now = Date.now();
  assert.equal(timeAgo(Math.floor(now / 1000) - 60), "1m");
  assert.equal(timeAgo(now - 60_000), "1m");
});

test("one hour ago", () => {
  const now = Date.now();
  assert.equal(timeAgo(Math.floor(now / 1000) - 3600), "1h");
  assert.equal(timeAgo(now - 3_600_000), "1h");
});

test("one day ago", () => {
  const now = Date.now();
  assert.equal(timeAgo(Math.floor(now / 1000) - 86400), "1d");
  assert.equal(timeAgo(now - 86_400_000), "1d");
});

test("ISO strings still work (GitHub's shape)", () => {
  const oneHourAgo = new Date(Date.now() - 3_600_000).toISOString();
  assert.equal(timeAgo(oneHourAgo), "1h");
});

test("a stringified seconds value is not sent to the Date parser", () => {
  const now = Date.now();
  assert.equal(timeAgo(String(Math.floor(now / 1000) - 3600)), "1h");
});

test("a future timestamp never renders a negative age", () => {
  assert.equal(timeAgo(Date.now() + 60_000), "just now");
});

test("unusable input renders nothing rather than nonsense", () => {
  for (const bad of [null, undefined, "", "not a date", {}, [], NaN]) {
    assert.equal(timeAgo(bad), "", `expected empty string for ${JSON.stringify(bad)}`);
  }
});

test("milliseconds stay milliseconds", () => {
  // OpenCode's shape: integer milliseconds. Must not be multiplied again.
  const now = Date.now();
  assert.equal(timeAgo(now - 7200_000), "2h");
});

// A missing timestamp arrives as 0, not as 1970.
//
// Hermes' API omits `started_at` entirely when it is absent, and the Rust side
// maps that absence with `.unwrap_or(0.0)` (integrations.rs:891) — so `0.0`
// reaches the UI meaning "no timestamp". Read literally it rendered a day-scale
// age (~20728d at the time of writing), which is worse than showing no age.
test("a missing timestamp renders no age, never a 1970 age", () => {
  for (const sentinel of [0, 0.0, -1, "0", "-1", "", null, undefined, NaN]) {
    assert.equal(timeAgo(sentinel), "", `${String(sentinel)} must render no age`);
  }
});

// The guard must reject only *unusable* values. A real timestamp still renders —
// including an old one — so the fix cannot quietly hide genuine activity.
test("the missing-value guard does not reject real timestamps", () => {
  const now = Date.now();
  assert.notEqual(timeAgo(Math.floor(now / 1000) - 7200), ""); // 2h ago, in seconds
  assert.notEqual(timeAgo(now - 7200_000), ""); // 2h ago, in milliseconds
  // A genuinely old but real timestamp (a repo last pushed in 2008) still reads.
  assert.equal(timeAgo("2008-07-01T00:00:00Z").endsWith("d"), true);
});
