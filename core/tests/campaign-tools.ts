// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Campaign helper: expose the REAL `filesystem.metadata` implementation through
 * the orchestrator's tools port, so evidence gathering resolves paths exactly as
 * production does (against the workspace sandbox roots), instead of through a
 * stub that would hide the behaviour under test.
 */

import { filesystemMetadata } from "../src/tools/workspace.ts";

export function filesystemMetadataProbe(
  id: string,
  input: unknown,
): { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } } {
  if (id !== "filesystem.metadata") return { ok: true, result: {} };
  try {
    return { ok: true, result: filesystemMetadata(input) };
  } catch (error) {
    return {
      ok: false,
      error: { code: "VALIDATION_FAILED", message: error instanceof Error ? error.message : String(error) },
    };
  }
}
