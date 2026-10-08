// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Error helpers for the computer-use foundation.
 *
 * WHY a local helper instead of a new KaiErrorCode: `shared/contracts.ts` is
 * FROZEN and other Phase 1 work is building against it in parallel, so this
 * module must express its refusals with the codes that already exist. The
 * mapping chosen here, and why:
 *
 *   POLICY_DENIED        the human holds the computer, OR the control endpoint
 *                        could not be read and we FAILED CLOSED. Both are
 *                        policy decisions — "we may not act" — not transport
 *                        failures, so POLICY_DENIED is the honest code.
 *   AGENT_NOT_LISTENING  the driver/transport could not be reached at all.
 *   AGENT_TIMEOUT        the driver or control endpoint did not answer in time.
 *   AGENT_RUN_FAILED     the driver ran, but the result had to be discarded
 *                        because control of the machine changed mid-sequence.
 *
 * A `COMPUTER_CONTROL_HELD` member would have been clearer, but adding one
 * would have reshaped a frozen contract — explicitly forbidden. The `detail`
 * field carries the machine-readable nuance the code cannot.
 */

import { nowIso, type KaiError, type KaiErrorCode } from "../../shared/contracts.ts";

export interface KaiErrorOptions {
  retryable?: boolean;
  detail?: string;
}

/** Build a contract-shaped KaiError. `retryable` defaults to false: a refusal
 * is not something a caller should blindly retry, and the safety-critical
 * cases here (human hold, unreachable control) must never invite a retry loop. */
export function kaiError(code: KaiErrorCode, message: string, options: KaiErrorOptions = {}): KaiError {
  const error: KaiError = {
    code,
    message,
    retryable: options.retryable ?? false,
    at: nowIso(),
  };
  if (options.detail !== undefined) error.detail = options.detail;
  return error;
}
