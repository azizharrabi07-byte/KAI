// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The trust boundary between a tool's real value and the streaming wire.
 *
 * The UI needs to SHOW what a tool returned — a timeline of names is not
 * evidence of work. But the raw value must never leave the Core unexamined:
 * tool results can carry secrets (tokens, keys, private paths) and unbounded
 * bulk (full file dumps, huge listings). This module is the ONE place a live
 * `tool_event` frame gains a result preview:
 *
 *   - serialised safely (circular/unserialisable → an honest placeholder),
 *   - secret-redacted through the canonical redactor,
 *   - bounded to TOOL_RESULT_PREVIEW_CHARS with an explicit truncated flag.
 *
 * The full value stays server-side (persisted tool history, the `done` frame's
 * toolCalls). The preview is what the timeline renders inline.
 */

import { redactText } from "../redact/index.ts";

/** Inline preview budget per live tool event, in characters. */
export const TOOL_RESULT_PREVIEW_CHARS = 2000;

export interface ToolResultPreview {
  /** The bounded, redacted preview. Absent when there is nothing to show. */
  resultPreview?: string;
  /** True when the real value continued past the preview budget. */
  resultTruncated: boolean;
}

export function previewToolResult(result: unknown): ToolResultPreview {
  if (result === undefined || result === null) return { resultTruncated: false };
  let text: string;
  if (typeof result === "string") {
    text = result;
  } else {
    try {
      text = JSON.stringify(result);
    } catch {
      return { resultPreview: "unserialisable result", resultTruncated: false };
    }
    if (text === undefined) return { resultTruncated: false };
  }
  if (text.length === 0) return { resultTruncated: false };
  // Measured on the RAW value: redaction may shrink bulk (a 100 KB blob can
  // become one marker), but the UI must still know there was more.
  const overBudget = text.length > TOOL_RESULT_PREVIEW_CHARS;
  const redacted = redactText(text);
  if (redacted.length <= TOOL_RESULT_PREVIEW_CHARS) {
    return { resultPreview: redacted, resultTruncated: overBudget };
  }
  return {
    resultPreview: `${redacted.slice(0, TOOL_RESULT_PREVIEW_CHARS)}…`,
    resultTruncated: true,
  };
}
