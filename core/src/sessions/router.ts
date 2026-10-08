// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The session transcript router — WHICH conversation a read is allowed to see.
 *
 * Three kinds of transcript exist in KAI, and they must never collapse into one
 * another:
 *
 *   kai-conversation       KAI's own conversation with the person. No persona
 *                          owns it (`agentOwner` absent).
 *   subagent-conversation  a persona's own conversation, OWNED by that persona
 *                          (`agentOwner === "kai:<id>"`). Private to the owner.
 *   worker-execution       the worker's own execution transcript of a turn.
 *                          No reader is wired in this Core yet, so the router
 *                          says so (NOT_WIRED) instead of pretending an empty
 *                          transcript is the truth.
 *
 * The router is the anti-collapse guard. The store keeps KAI's conversation and
 * a persona's conversation apart at rest (`agentOwner`); this router keeps them
 * apart at READ time: a request that names a kind the session does not have is
 * refused (CROSS_KIND) — it is never silently answered from the other kind's
 * rows. A subagent-conversation read is OWNER-CHECKED: the caller must name the
 * owning persona and it must match the session's `agentOwner`, so omitting the
 * owner cannot open a persona's private conversation to everyone.
 *
 * Errors are values, like every other boundary in this tree.
 */

import type { KaiSession, SessionTurn } from "./store.ts";
import type { SessionMemoryScope, SessionService } from "./service.ts";

/** The three transcript kinds a caller may name. */
export const TRANSCRIPT_KINDS = ["kai-conversation", "subagent-conversation", "worker-execution"] as const;

export type TranscriptKind = (typeof TRANSCRIPT_KINDS)[number];

/** The kinds a SESSION can actually be — worker-execution is not a session kind. */
export type SessionTranscriptKind = Exclude<TranscriptKind, "worker-execution">;

export type TranscriptErrorCode = "NOT_FOUND" | "NOT_WIRED" | "CROSS_KIND" | "VALIDATION_FAILED";

/** One session's transcript, as the router is willing to serve it. */
export interface SessionTranscript {
  sessionId: string;
  kind: SessionTranscriptKind;
  /** The persona that owns the conversation (`kai:<id>`), when one does. */
  owner?: string;
  /** The worker conversation the session is bound to, when one is. */
  worker?: string;
  status: string;
  /** The recorded turns, oldest first — the order a conversation reads in. */
  turns: SessionTurn[];
  memoryScope: SessionMemoryScope;
}

export type TranscriptResult =
  | { ok: true; transcript: SessionTranscript }
  | { ok: false; code: TranscriptErrorCode; reason: string };

export interface TranscriptInput {
  sessionId: string;
  /** Defaults to `kai-conversation` — the safe read for a session whose kind the caller did not state. */
  kind?: TranscriptKind;
  /** The claimed owner (`kai:<id>`); REQUIRED for a subagent-conversation read. */
  owner?: string;
  limit?: number;
}

export interface SessionTranscriptRouter {
  /** Which transcript kind a session may be read as — the classification, once. */
  classify(session: KaiSession): SessionTranscriptKind;
  read(input: TranscriptInput): TranscriptResult;
}

/** The most turns one read serves; a bound, not a silent truncation of real data. */
const MAX_TRANSCRIPT_LIMIT = 1000;

/**
 * The ONE classification of a session: a session with an `agentOwner` is that
 * persona's conversation; a session without one is KAI's own. Everything that
 * asks "which kind is this?" (the router, the routes, a test) must read it from
 * here rather than re-deriving it from `agentId`, whose overload is exactly the
 * ambiguity this layer exists to end.
 */
export function classifySession(session: KaiSession): SessionTranscriptKind {
  return session.agentOwner !== undefined ? "subagent-conversation" : "kai-conversation";
}

export function createSessionTranscriptRouter(deps: { sessions: SessionService }): SessionTranscriptRouter {
  const sessions = deps.sessions;

  function invalid(reason: string): TranscriptResult {
    return { ok: false, code: "VALIDATION_FAILED", reason };
  }

  function classify(session: KaiSession): SessionTranscriptKind {
    return classifySession(session);
  }

  function read(input: TranscriptInput): TranscriptResult {
    // ── 1. the request's shape ────────────────────────────────────────────────
    const sessionId = input.sessionId;
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      return invalid('"sessionId" must be a non-empty string');
    }
    const kind = input.kind ?? "kai-conversation";
    if (!(TRANSCRIPT_KINDS as readonly string[]).includes(kind)) {
      return invalid(`"kind" must be one of ${TRANSCRIPT_KINDS.join(", ")}`);
    }
    if (
      input.limit !== undefined &&
      (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > MAX_TRANSCRIPT_LIMIT)
    ) {
      return invalid(`"limit" must be an integer between 1 and ${MAX_TRANSCRIPT_LIMIT}`);
    }
    // The worker's own execution transcript has no reader anywhere in this Core.
    // Say NOT_WIRED for every subject rather than answering with an empty or
    // borrowed transcript — an unwired read that returns something is worse
    // than one that refuses, because it looks like evidence.
    if (kind === "worker-execution") {
      return {
        ok: false,
        code: "NOT_WIRED",
        reason:
          "the worker's own execution transcript is not wired yet: no reader exists in this Core, " +
          "so this route refuses rather than serving a borrowed or empty transcript",
      };
    }

    // ── 2. the subject ────────────────────────────────────────────────────────
    const session = sessions.get(sessionId);
    if (session === null) {
      return { ok: false, code: "NOT_FOUND", reason: `no session "${sessionId}" exists` };
    }

    // ── 3. the anti-collapse checks ───────────────────────────────────────────
    const actual = classify(session);
    if (kind !== actual) {
      return {
        ok: false,
        code: "CROSS_KIND",
        reason:
          `session "${sessionId}" is a ${actual}; it cannot be read as a ${kind}. ` +
          "A persona's conversation never merges into KAI's own, and KAI's own never masquerades as a persona's.",
      };
    }
    if (kind === "kai-conversation") {
      // A KAI conversation has NO owner; a caller claiming one is asking for a
      // different conversation than the one this id names.
      if (input.owner !== undefined && input.owner.length > 0) {
        return {
          ok: false,
          code: "CROSS_KIND",
          reason:
            `owner mismatch: session "${sessionId}" is KAI's own conversation and has no persona owner, ` +
            `not "${input.owner}"`,
        };
      }
    } else {
      const owner = session.agentOwner as string;
      if (input.owner === undefined || input.owner.length === 0) {
        // The read is owner-checked by construction: without a claimed owner
        // there is nothing to check, so the request is refused rather than
        // served — omitting the owner must not open a persona's conversation.
        return invalid(
          `"owner" is required when reading a subagent conversation: session "${sessionId}" belongs to persona "${owner}" and the read is owner-checked`,
        );
      }
      if (input.owner !== owner) {
        return {
          ok: false,
          code: "CROSS_KIND",
          reason: `owner mismatch: session "${sessionId}" belongs to persona "${owner}", not "${input.owner}"`,
        };
      }
    }

    // ── 4. serve it ───────────────────────────────────────────────────────────
    const turns = sessions.turns(sessionId, input.limit);
    const transcript: SessionTranscript = {
      sessionId,
      kind,
      status: session.status,
      turns: turns.ok ? turns.value : [],
      memoryScope: { scope: "session", scopeId: sessionId },
    };
    if (session.agentOwner !== undefined) transcript.owner = session.agentOwner;
    if (session.worker !== undefined) transcript.worker = session.worker;
    return { ok: true, transcript };
  }

  return { classify, read };
}
