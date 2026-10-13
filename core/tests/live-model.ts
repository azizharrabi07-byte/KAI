// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The one place a suite asks "can a live model run here?".
 *
 * ## Why this exists
 *
 * Nine suites boot a real Core and then make a model call. They used to pass only
 * because the DEVELOPER'S real `KAI_HOME` happened to hold a working credential —
 * so the suite's result depended on the machine, and isolating `KAI_HOME` turned
 * nine tests red with `ModelError: no API key configured` instead of skipping.
 *
 * This helper makes the dependency explicit: a suite with no credential SKIPS with
 * a reason that names exactly what is missing.
 *
 * ## The rule that matters
 *
 * It inspects CONFIGURATION ONLY. It does not try a call and it catches nothing,
 * so a real failure — a bad response, an auth rejection, a bug — can never be
 * misreported as "no credential". A test that cannot run is skipped; a test that
 * ran and failed still fails.
 */

import { resolveModelSettings } from "../src/model/config.ts";

/** A named reason a live-model suite cannot run, or `undefined` when it can. */
export function liveModelSkipReason(): string | undefined {
  const settings = resolveModelSettings();
  if (settings.apiKey !== undefined && settings.apiKey.length > 0) return undefined;
  const home = process.env["KAI_HOME"] ?? "(default)";
  return (
    "no model credential is configured for this KAI_HOME " +
    `(${home}): set KAI_MODEL_API_KEY, or write KAI_HOME/model/credentials.json. ` +
    "This suite needs a live model and is skipped rather than failed."
  );
}
