// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * KAI Core learning — barrel export.
 *
 * The learning loop (spec C5/D): classify a completed turn as MEMORY | SKILL |
 * NONE, validate it, and — for a skill — stage it for a human to approve. The
 * extraction step is a PROPOSAL; validation and approval are the host's.
 */

export * from "./types.ts";
export { REPEAT_THRESHOLD, classify } from "./classify.ts";
export type { Classification } from "./classify.ts";
export { MAX_MEMORY_CHARS, createLearningPipeline } from "./pipeline.ts";
export type { LearningPipeline, LearningPipelineDeps } from "./pipeline.ts";
