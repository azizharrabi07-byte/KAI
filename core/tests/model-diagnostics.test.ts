// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Provider failures, told apart.
 *
 * The real failure this pins: a monthly allowance exhaustion was reported as if it
 * were an ordinary rate limit. Those need opposite responses, so KAI must classify
 * them — and must never leak a credential while doing it.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { describeProviderFailure, diagnoseProviderFailure } from "../src/model/diagnostics.ts";
import { ModelError } from "../src/model/types.ts";

/** The EXACT body a live run received from the opencode-go gateway. */
const REAL_QUOTA_DETAIL =
  '{"type":"error","error":{"type":"GoUsageLimitError","message":"Go usage limit exceeded"},"metadata":{"workspace":"wrk_01M298R3SA1WN8J6G3XYF4XB6R","limitName":"monthly"}}';

test("a spent monthly allowance is quota-exhausted, NOT a rate limit", (t) => {
  const error = new ModelError("http", 'the "opencode-go" model provider answered HTTP 429', {
    provider: "opencode-go",
    status: 429,
    detail: REAL_QUOTA_DETAIL,
  });
  const d = diagnoseProviderFailure(error);
  assert.equal(d.class, "quota-exhausted", `a 429 with a usage-limit body is NOT throttling: ${d.class}`);
  assert.equal(d.retryable, false, "retrying a spent allowance wastes time");
  assert.match(d.recovery, /allowance is SPENT/i);
  assert.match(d.recovery, /do not switch accounts automatically/i, "and it must not propose a silent account switch");
  t.diagnostic(describeProviderFailure(d));
});

test("a bare 429 with no quota wording is a transient rate limit", (t) => {
  const error = new ModelError("http", "provider answered HTTP 429", {
    provider: "somewhere",
    status: 429,
    detail: '{"error":{"message":"Too many requests, slow down"}}',
  });
  const d = diagnoseProviderFailure(error);
  assert.equal(d.class, "rate-limited");
  assert.equal(d.retryable, true, "throttling clears, so retrying is reasonable");
  t.diagnostic(describeProviderFailure(d));
});

test("authentication, unreachability, timeouts and bad responses are each their own class", () => {
  const cases: { error: ModelError; expected: string; retryable: boolean }[] = [
    { error: new ModelError("http", "rejected", { provider: "p", status: 401 }), expected: "auth", retryable: false },
    { error: new ModelError("http", "forbidden", { provider: "p", status: 403 }), expected: "auth", retryable: false },
    { error: new ModelError("unreachable", "ECONNREFUSED", { provider: "p" }), expected: "unreachable", retryable: true },
    { error: new ModelError("timeout", "did not answer", { provider: "p" }), expected: "timeout", retryable: true },
    { error: new ModelError("bad_response", "not JSON", { provider: "p" }), expected: "bad-response", retryable: true },
    { error: new ModelError("unconfigured", "no endpoint", { provider: "p" }), expected: "unconfigured", retryable: false },
    { error: new ModelError("http", "server error", { provider: "p", status: 503 }), expected: "http", retryable: true },
  ];
  for (const c of cases) {
    const d = diagnoseProviderFailure(c.error);
    assert.equal(d.class, c.expected, `${c.error.message} -> ${d.class}`);
    assert.equal(d.retryable, c.retryable, `${c.expected}: retryable`);
    assert.ok(d.recovery.length > 0, "every class says what to do");
  }
});

test("a credential never appears in the diagnostic, even when the provider echoes it", (t) => {
  const error = new ModelError("http", "bad key", {
    provider: "p",
    status: 401,
    detail: '{"error":"invalid key sk-abcdefghijklmnopqrstuvwxyz0123456789","authorization":"Bearer sk-abcdefghijklmnopqrstuvwxyz0123456789"}',
  });
  const d = diagnoseProviderFailure(error);
  const rendered = `${d.detail ?? ""} ${describeProviderFailure(d)}`;
  assert.ok(!/sk-abcdefghijklmnopqrstuvwxyz/.test(rendered), `a credential leaked into the diagnostic: ${rendered.slice(0, 160)}`);
  t.diagnostic(`redacted: ${String(d.detail).slice(0, 100)}`);
});

test("a non-provider error is unknown, and says so rather than guessing", () => {
  const d = diagnoseProviderFailure(new Error("something else entirely"));
  assert.equal(d.class, "unknown");
  assert.equal(d.retryable, false);
  assert.match(d.recovery, /not a recognised provider failure/i);
});
