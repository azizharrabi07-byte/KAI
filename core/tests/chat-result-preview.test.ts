// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The live tool_event wire carries a preview, never the raw value.
 *
 *   cd core && node --test tests/chat-result-preview.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";

import { previewToolResult, TOOL_RESULT_PREVIEW_CHARS } from "../src/chat/result-preview.ts";

test("null/undefined/empty produce no preview", () => {
  assert.deepEqual(previewToolResult(undefined), { resultTruncated: false });
  assert.deepEqual(previewToolResult(null), { resultTruncated: false });
  assert.deepEqual(previewToolResult(""), { resultTruncated: false });
});

test("a short string passes through", () => {
  const out = previewToolResult("3 files matched");
  assert.equal(out.resultPreview, "3 files matched");
  assert.equal(out.resultTruncated, false);
});

test("an object is serialised", () => {
  const out = previewToolResult({ ok: true, matches: ["a.ts", "b.ts"] });
  assert.ok((out.resultPreview ?? "").includes("a.ts"));
  assert.equal(out.resultTruncated, false);
});

test("a large value is bounded with an honest flag", () => {
  const out = previewToolResult({ blob: "x".repeat(100_000) });
  assert.equal(out.resultTruncated, true);
  assert.ok((out.resultPreview ?? "").length <= TOOL_RESULT_PREVIEW_CHARS + 1);
});

test("a secret-shaped value is redacted before it leaves the Core", () => {
  const out = previewToolResult({ token: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" });
  assert.ok(!(out.resultPreview ?? "").includes("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"));
  assert.ok((out.resultPreview ?? "").includes("[redacted]"));
});

test("a circular value degrades to an honest placeholder", () => {
  const circular: Record<string, unknown> = {};
  circular["self"] = circular;
  const out = previewToolResult(circular);
  assert.equal(out.resultPreview, "unserialisable result");
  assert.equal(out.resultTruncated, false);
});
