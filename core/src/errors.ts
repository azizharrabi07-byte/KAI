// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Typed errors for every upstream agent call.
 *
 * Three distinguishable kinds, matching the KAI Core contract:
 *   - "unreachable"  : the upstream could not be contacted at all (ECONNREFUSED, DNS, timeout)
 *   - "unauthorized" : the upstream answered 401/403 (bad or missing bearer key)
 *   - "http"         : the upstream answered any other non-2xx status
 */

export type AgentErrorKind = "unreachable" | "unauthorized" | "http";

export interface AgentErrorInit {
  target: string;
  status?: number;
  body?: string;
  cause?: unknown;
}

export class AgentError extends Error {
  readonly kind: AgentErrorKind;
  readonly target: string;
  readonly status: number | undefined;
  readonly body: string | undefined;

  constructor(kind: AgentErrorKind, message: string, init: AgentErrorInit) {
    super(message);
    this.name = new.target.name;
    this.kind = kind;
    this.target = init.target;
    this.status = init.status;
    this.body = init.body;
    if (init.cause !== undefined) {
      (this as { cause?: unknown }).cause = init.cause;
    }
  }

  static unreachable(target: string, cause: unknown): AgentUnreachableError {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return new AgentUnreachableError(
      `agent unreachable (${target}): ${detail}`,
      { target, cause },
    );
  }

  static unauthorized(target: string, body?: string, sentCredentials = true): AgentUnauthorizedError {
    return new AgentUnauthorizedError(
      sentCredentials
        ? `agent rejected the credentials (${target}): upstream returned 401/403`
        : `no credentials were sent to ${target}: it answered 401/403, and this process has no API key configured for it`,
      { target, status: 401, body },
    );
  }

  static http(target: string, status: number, body?: string): AgentHttpError {
    return new AgentHttpError(
      `agent returned HTTP ${status} (${target})`,
      { target, status, body },
    );
  }
}

export class AgentUnreachableError extends AgentError {
  constructor(message: string, init: AgentErrorInit) {
    super("unreachable", message, init);
  }
}

export class AgentUnauthorizedError extends AgentError {
  constructor(message: string, init: AgentErrorInit) {
    super("unauthorized", message, init);
  }
}

export class AgentHttpError extends AgentError {
  constructor(message: string, init: AgentErrorInit) {
    super("http", message, init);
  }
}

export function isAgentError(value: unknown): value is AgentError {
  return value instanceof AgentError;
}

/**
 * Stable, client-safe `reason` code for a failed upstream call.
 * Never returns a stack trace: this is the only thing KAI Core puts on the wire.
 */
export function reasonOf(value: unknown): string {
  if (value instanceof AgentError) {
    if (value.kind === "http" && value.status !== undefined) {
      return `upstream_http_${value.status}`;
    }
    return `upstream_${value.kind}`;
  }
  return "internal_error";
}
