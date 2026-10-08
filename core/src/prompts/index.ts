// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * KAI's system-prompt composition pipeline.
 *
 * The ONE writer of a turn's system prompt. Import the factory here:
 *
 *   import { createPromptComposer } from "../prompts/index.ts";
 *
 * Wiring (done by the composition root, not here): build one composer per Core
 * with KAI's identity docs and the live memory/skill ports, then call
 * `composer.compose(request, { mission, scope })` once per turn and pass
 * `result.text` as `SendTurnInput.prompt`. `result.stable` is safe to cache and
 * compare across turns; `result.sections` is the measurable size report.
 */

export * from "./compose.ts";
