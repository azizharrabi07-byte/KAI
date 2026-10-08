// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Result values for the MCP module.
 *
 * The Core's rule is that errors are values (KaiError), not exceptions, at
 * every module boundary. This module deals with untrusted input triple-times
 * over — config a user pasted, tool definitions a third-party server sent,
 * JSON-RPC frames off a socket — so the boundary is exactly where it must hold.
 * Nothing below throws; every fallible call returns `McpResult<T>`.
 */

import type { KaiError, KaiErrorCode } from "../shared/contracts.ts";

export type McpResult<T> = { ok: true; value: T } | { ok: false; error: KaiError };

export function ok<T>(value: T): McpResult<T> {
  return { ok: true, value };
}

export function fail<T>(error: KaiError): McpResult<T> {
  return { ok: false, error };
}

/**
 * Build a KaiError value. `at` is injected rather than read from the clock so
 * tests are deterministic — the same reason the tool registry takes `now`.
 * `retryable` is always false: every failure this module reports is a
 * configuration or definition problem that retrying unchanged cannot fix.
 */
export function mcpError(
  code: KaiErrorCode,
  message: string,
  at: () => Date,
  detail?: string,
): KaiError {
  const error: KaiError = { code, message, retryable: false, at: at().toISOString() };
  if (detail !== undefined) error.detail = detail;
  return error;
}

/** Shape guard for "is this a McpResult". Handy when a result crosses a seam. */
export function isMcpResult(value: unknown): value is McpResult<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    typeof (value as { ok: unknown }).ok === "boolean"
  );
}
