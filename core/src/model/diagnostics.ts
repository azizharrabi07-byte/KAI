// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Provider failures, classified so a reader can tell them apart.
 *
 * The defect this closes was concrete: a monthly allowance exhaustion
 * (`GoUsageLimitError`, `limitName: "monthly"`) was reported as if it were an
 * ordinary rate limit. Those are different facts with opposite responses —
 * throttling clears in seconds and is worth retrying; a spent monthly allowance
 * does not clear until it resets, and retrying just burns time.
 *
 * A `ModelError` already carries the provider, the kind and (for HTTP) the status,
 * so this module reads THAT and the provider's own message, and returns one typed
 * diagnostic with an actionable recovery. It never returns the API key: the detail
 * is redacted before it is reported.
 */

import { redactText } from "../redact/index.ts";
import { ModelError } from "./types.ts";

/** What actually went wrong, at the level a decision is made on. */
export type ProviderFailureClass =
  /** A usage/quota allowance is SPENT (monthly, weekly, daily). Not transient. */
  | "quota-exhausted"
  /** Transient throttling. Retrying with backoff is reasonable. */
  | "rate-limited"
  /** The credential was rejected or is missing. */
  | "auth"
  /** Nothing answered on the endpoint. */
  | "unreachable"
  /** The endpoint answered, but not in time. */
  | "timeout"
  /** The endpoint answered with something unusable. */
  | "bad-response"
  /** No endpoint/credential is configured at all. */
  | "unconfigured"
  /** An HTTP failure with no more specific class. */
  | "http"
  /** Not a provider failure, or not enough information to classify it. */
  | "unknown";

export interface ProviderDiagnostic {
  class: ProviderFailureClass;
  /** The provider id KAI was talking to (a stable label, not a URL with secrets). */
  provider: string;
  /** The HTTP status, when there was one. */
  status?: number;
  /** Whether retrying the SAME request could plausibly succeed. */
  retryable: boolean;
  /** What the operator or KAI should do next. */
  recovery: string;
  /** The provider's own message, REDACTED. Never contains a credential. */
  detail?: string;
}

/** The provider's own wording for "your allowance is spent", across providers. */
const QUOTA_MARKERS = [
  "usage limit",
  "usagelimit",
  "quota",
  "insufficient_quota",
  "exceeded your current quota",
  "limitname",
  "billing",
  "credit balance",
  "out of credits",
];

/** The provider's own wording for transient throttling. */
const RATE_MARKERS = ["rate limit", "rate_limit", "too many requests", "slow down", "throttl"];

/** Read a redacted detail string off a ModelError. */
function redactedDetail(error: ModelError): string | undefined {
  if (error.detail === undefined || error.detail.length === 0) return undefined;
  return redactText(error.detail).slice(0, 500);
}

/**
 * Classify one failure. The order matters: an explicit quota marker beats a bare
 * 429, because providers commonly return 429 for BOTH and only the body says which.
 */
export function diagnoseProviderFailure(error: unknown): ProviderDiagnostic {
  if (!(error instanceof ModelError)) {
    return {
      class: "unknown",
      provider: "unknown",
      retryable: false,
      recovery: "This was not a recognised provider failure; inspect the raw error.",
      ...(error instanceof Error ? { detail: redactText(error.message).slice(0, 500) } : {}),
    };
  }

  const provider = error.provider;
  const detail = redactedDetail(error);
  const haystack = `${error.message} ${error.detail ?? ""}`.toLowerCase();
  const status = error.status;
  const base = { provider, ...(status !== undefined ? { status } : {}) };

  // ── A spent allowance is not a rate limit ─────────────────────────────────
  if (QUOTA_MARKERS.some((m) => haystack.includes(m))) {
    return {
      ...base,
      class: "quota-exhausted",
      retryable: false,
      recovery:
        "The provider's usage allowance is SPENT (not throttled). Retrying will not help until it resets. " +
        "Use a different configured provider, or wait for the allowance to reset — do not switch accounts automatically.",
      ...(detail !== undefined ? { detail } : {}),
    };
  }

  if (status === 401 || status === 403) {
    return {
      ...base,
      class: "auth",
      retryable: false,
      recovery: "The credential was rejected. Check the configured key for this provider; retrying will not help.",
      ...(detail !== undefined ? { detail } : {}),
    };
  }

  if (status === 429 || RATE_MARKERS.some((m) => haystack.includes(m))) {
    return {
      ...base,
      class: "rate-limited",
      retryable: true,
      recovery: "Transient throttling. Retrying with backoff is reasonable.",
      ...(detail !== undefined ? { detail } : {}),
    };
  }

  switch (error.kind) {
    case "unconfigured":
      return {
        ...base,
        class: "unconfigured",
        retryable: false,
        recovery: "No model endpoint or credential is configured. Configure one before this path can run.",
      };
    case "unreachable":
      return {
        ...base,
        class: "unreachable",
        retryable: true,
        recovery: "Nothing answered on the endpoint. Check that the runtime or gateway is running.",
        ...(detail !== undefined ? { detail } : {}),
      };
    case "timeout":
      return {
        ...base,
        class: "timeout",
        retryable: true,
        recovery: "The endpoint did not answer in time. A slow local agent is a common cause; a longer timeout may help.",
      };
    case "bad_response":
      return {
        ...base,
        class: "bad-response",
        retryable: true,
        recovery: "The endpoint answered with something unusable. Check the provider's compatibility with the request shape.",
        ...(detail !== undefined ? { detail } : {}),
      };
    default:
      return {
        ...base,
        class: "http",
        retryable: status === undefined || status >= 500,
        recovery:
          status !== undefined && status >= 500
            ? "The provider failed server-side. Retrying is reasonable."
            : "The provider refused the request. Inspect the detail before retrying.",
        ...(detail !== undefined ? { detail } : {}),
      };
  }
}

/** One line for a log or a UI badge: the class, the provider and whether to retry. */
export function describeProviderFailure(diagnostic: ProviderDiagnostic): string {
  const where = diagnostic.status !== undefined ? `${diagnostic.provider} (HTTP ${diagnostic.status})` : diagnostic.provider;
  return `${diagnostic.class} on ${where} — ${diagnostic.retryable ? "retryable" : "not retryable"}: ${diagnostic.recovery}`;
}
