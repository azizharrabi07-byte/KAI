// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * thinking.ts — KAI's thinking levels, and what each one REALLY does to a request.
 *
 * ## The honesty rule
 *
 * A level is a KAI-owned REQUEST. Different providers expose different knobs:
 * some accept an OpenAI-style `reasoning_effort`, most OpenAI-compatible
 * endpoints ignore or reject it. So this module never claims a level "took
 * effect" — it returns a PLAN that says exactly which parameters were applied,
 * and the caller reports that plan back to the UI verbatim.
 *
 * Two parts, always:
 *   • a `max_tokens` budget — every OpenAI-compatible endpoint accepts it, so a
 *     level always changes something real about the request;
 *   • `reasoning_effort` — sent ONLY when the provider declares it accepts the
 *     parameter. Sending an unknown field to a strict endpoint is a 400, which
 *     would turn a preference into an outage.
 *
 * `note` is populated whenever the plan is a fallback, in plain language, so the
 * UI can say "this model has no reasoning control; a token budget was applied
 * instead" rather than implying a reasoning mode that is not in force.
 */

export const THINKING_LEVELS = ["instant", "low", "high", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "high";

/** True for one of KAI's own thinking levels. */
export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

export interface ThinkingPlan {
  level: ThinkingLevel;
  /** The completion budget this level asks for. Always applied. */
  maxTokens: number;
  /** The OpenAI-style reasoning effort, when the provider accepts it. */
  reasoningEffort?: "low" | "medium" | "high";
  /** The wire fields this plan actually set. Empty means the request is unchanged. */
  applied: string[];
  /** Present when the level was honoured only in part. Plain language, for the UI. */
  note?: string;
}

/**
 * The budget each level asks for.
 *
 * `instant` is deliberately small: the point of the level is a fast, cheap answer,
 * and a large budget is what makes a model keep thinking.
 */
const MAX_TOKENS: Readonly<Record<ThinkingLevel, number>> = {
  instant: 1_024,
  low: 2_048,
  high: 8_192,
  max: 16_384,
};

const REASONING_EFFORT: Readonly<Record<ThinkingLevel, "low" | "medium" | "high" | undefined>> = {
  instant: undefined,
  low: "low",
  high: "medium",
  max: "high",
};

/**
 * What this level does to a request against a given provider.
 *
 * `supportsReasoningEffort` must come from the provider's OWN declaration, never
 * from a guess about its name.
 */
export function thinkingPlan(
  level: ThinkingLevel,
  supportsReasoningEffort: boolean,
): ThinkingPlan {
  const maxTokens = MAX_TOKENS[level];
  const effort = REASONING_EFFORT[level];

  // An explicit caller budget is NOT overridden here: the plan is what the LEVEL
  // contributes. `instant` still sets a budget, because "answer quickly" is only
  // real if the request says so.
  if (effort === undefined) {
    return {
      level,
      maxTokens,
      applied: ["max_tokens"],
      ...(level === "instant"
        ? { note: "instant: a small completion budget; no reasoning pass is requested" }
        : {}),
    };
  }

  if (supportsReasoningEffort) {
    return {
      level,
      maxTokens,
      reasoningEffort: effort,
      applied: ["max_tokens", "reasoning_effort"],
    };
  }

  return {
    level,
    maxTokens,
    applied: ["max_tokens"],
    note: `this provider has no reasoning control, so "${level}" was applied as a ${maxTokens}-token budget only`,
  };
}
