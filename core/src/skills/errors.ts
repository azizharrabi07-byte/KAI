// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Errors-as-values for the skills module.
 *
 * Two kinds of failure exist here and they are handled differently:
 *
 *   - A VALIDATION failure is a `SkillIssue[]` — a list of precise reasons.
 *     It is returned, not thrown, because refusing a candidate is the normal,
 *     expected outcome of scanning third-party/model output.
 *   - A FILESYSTEM/INTEGRITY failure is a `KaiError`. The low-level path
 *     helpers throw a `SkillFsError` so a single `guard()` can convert any of
 *     them into the value the boundary returns. Nothing escapes as a raw throw.
 */

import type { KaiError, KaiErrorCode } from "../shared/contracts.ts";
import type { SkillIssue, SkillResult } from "./types.ts";

export function skillError(
  code: KaiErrorCode,
  message: string,
  at: () => Date,
  detail?: string,
): KaiError {
  const error: KaiError = { code, message, retryable: false, at: at().toISOString() };
  if (detail !== undefined) error.detail = detail;
  return error;
}

/** A refused operation, carrying the precise issues when there are any. */
export function fail<T>(error: KaiError, issues?: SkillIssue[]): SkillResult<T> {
  return issues !== undefined && issues.length > 0
    ? { ok: false, error, issues }
    : { ok: false, error };
}

export function ok<T>(value: T): SkillResult<T> {
  return { ok: true, value };
}

/**
 * A filesystem refusal (path escape, symlink escape, IO) carrying the KaiError
 * the boundary should report. Thrown only by the low-level helpers.
 */
export class SkillFsError extends Error {
  readonly kaiError: KaiError;

  constructor(kaiError: KaiError) {
    super(kaiError.message);
    this.name = "SkillFsError";
    this.kaiError = kaiError;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Run a fallible operation and convert any throw into a `SkillResult`. A
 * `SkillFsError` keeps its own KaiError (so an escape reports as POLICY_DENIED,
 * not INTERNAL); anything else becomes INTERNAL with the message.
 */
export function guard<T>(at: () => Date, fn: () => SkillResult<T>): SkillResult<T> {
  try {
    return fn();
  } catch (error) {
    if (error instanceof SkillFsError) return fail(error.kaiError);
    return fail(skillError("INTERNAL", `skill operation failed: ${describe(error)}`, at, describe(error)));
  }
}
