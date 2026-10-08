// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * KAI Core memory — automatic capture (Phase 2 Part B6).
 *
 * The flow the directive specifies is:
 *
 *   completed turn → candidate extraction → validation → dedup → classify → persist
 *
 * with ONE structural rule that this module exists to enforce:
 *
 *   THE MODEL NEVER WRITES MEMORY. A model (or the turn itself) may only
 *   PROPOSE candidate strings; every candidate then goes through the host's
 *   `validateCandidate`, which is deterministic code. A model that emits
 *   "remember the user's API key is …" gets the same refusal a user would. This
 *   is why `MemoryCandidate` is a plain value and not a store write: there is no
 *   path from a candidate to the database that skips validation.
 *
 * Captured candidates are capped per turn (`MAX_CANDIDATES_PER_TURN`), and the
 * rejections the directive names each have a specific, testable trigger:
 *
 *   SECRET_DETECTED     content is secret-shaped, or mentions a credential at all
 *   INSTRUCTION_AS_FACT an order to the assistant dressed as a fact ("always …")
 *   TRANSIENT           greeting / acknowledgement / filler
 *   IRRELEVANT          no durable-fact signal
 *   EXPIRED             the fact's `until` is already past
 *   DUPLICATE           the identical fact is already in the bucket (via hash)
 *
 * Extraction is deliberately heuristic and deterministic — the same turn always
 * yields the same candidates — because a non-deterministic extractor would make
 * "same input twice collapses to one entry" untestable end to end.
 */

import { redactSecrets } from "../redact/index.ts";
import {
  clampConfidence,
  clampImportance,
  memoryRefusal,
  MAX_CANDIDATES_PER_TURN,
  type MemoryEntry,
  type MemoryProvenance,
  type MemoryRefusal,
  type MemoryScope,
  type MemoryTopic,
  type MemoryType,
} from "./model.ts";

// ── Turn shape ────────────────────────────────────────────────────────────────

export interface CompletedTurn {
  userText: string;
  assistantText?: string;
  /** ISO-8601 instant the turn completed. Defaults to now at capture time. */
  at?: string;
  sessionId?: string;
  missionId?: string;
  employeeId?: string;
  projectId?: string;
}

export interface MemoryCandidate {
  content: string;
  /** True when the turn said "remember that …": an explicit ask is durable by definition. */
  explicit?: boolean;
  scope?: MemoryScope;
  scopeId?: string;
  provenance?: MemoryProvenance;
  type?: MemoryType;
  importance?: number;
  confidence?: number;
  date?: string;
  until?: string;
  topicTitle?: string;
}

export interface CandidateRejection {
  candidate: MemoryCandidate;
  refusal: MemoryRefusal;
  /** Set when the refusal is a DUPLICATE: the entry that already holds the fact. */
  existing?: MemoryEntry;
}

// ── Signal patterns (deterministic) ───────────────────────────────────────────

const EXPLICIT =
  /^\s*(?:please\s+|can you\s+|pls\s+|could you\s+)?(?:remember|note)(?:\s+that|\s*:)\s*(.+)$/i;
const PREFERENCE =
  /\b(?:i|we)\s+(?:prefer|like|love|hate|use|want|need|always|usually|tend to|am working on|work on|worked on|chose|decided|agreed)\b/i;
const IDENTITY = /\b(?:my name is|i am|i'm|my (?:email|timezone|role|job|team|company) is)\b/i;
const PROJECT =
  /\b(?:project|repo|repository|codebase|workspace|app|service|package|api|database|backend|frontend)\b[^.!?]*\b(?:is|are|uses|use|has|have|needs|requires|depends on|runs on|targets)\b/i;
const DECISION = /\b(?:we|i)\s+(?:decided|chose|settled on|agreed)\b/i;

const INSTRUCTION =
  /^\s*(?:you|kai|assistant|system)\b[^.!?]{0,60}\b(?:must|should|shall|need to|have to|are not allowed to|are required to)\b|\b(?:ignore (?:all |the )?(?:previous|prior|above)|disregard (?:all |the )?(?:previous|prior|above)|act as|pretend to be|from now on you|you are now|system prompt|jailbreak|override your)\b|^\s*(?:always|never|don'?t|do not|please\s+(?:always|never|don'?t))\b|^\s*(?:write|run|delete|send|click|open|execute|install|create|make|add|remove|update|set|change|remember to)\b/i;

const TRANSIENT =
  /^\s*(?:hi|hello|hey|yo|sup|thanks|thank you|thx|ty|ok|okay|k|sure|cool|nice|great|awesome|perfect|got it|bye|goodbye|good morning|good night|good afternoon|what'?s up|how are you|how'?s it going|lol|haha|please continue|go on|continue|yes|no|yeah|nope)\b[\s\S]{0,30}$/i;

const SECRET_MENTION =
  /\b(?:api[\s_-]?key|apikey|secret|password|passwd|passphrase|token|credential|private[\s_-]?key|access[\s_-]?key|auth[\s_-]?token)\b/i;

// ── Extraction ────────────────────────────────────────────────────────────────

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\r?\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function stripTrailingPunctuation(text: string): string {
  return text.replace(/[.!?]+$/, "").trim();
}

const DURABLE_MARKER = new RegExp(
  [EXPLICIT.source, PREFERENCE.source, IDENTITY.source, PROJECT.source, DECISION.source].join("|"),
  "i",
);

/**
 * Extract durable-fact candidates from a completed turn. Only the USER's text
 * is scanned: an assistant's prose is where the model would try to inject a
 * fact, and a model may only PROPOSE via the explicit `modelCandidates` path,
 * which is validated identically. Returns at most `MAX_CANDIDATES_PER_TURN`.
 */
export function extractCandidates(turn: CompletedTurn, opts: { limit?: number } = {}): MemoryCandidate[] {
  const limit = opts.limit === undefined ? MAX_CANDIDATES_PER_TURN : Math.max(0, opts.limit);
  const out: MemoryCandidate[] = [];
  const seen = new Set<string>();

  for (const sentence of splitSentences(turn.userText)) {
    if (out.length >= limit) break;
    const explicit = EXPLICIT.exec(sentence);
    let content: string;
    let confidence: number;
    if (explicit !== null && explicit[1] !== undefined) {
      content = stripTrailingPunctuation(explicit[1]);
      confidence = 0.9;
      if (content.length === 0) continue;
      const key = content.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ content, confidence, provenance: "user_statement", explicit: true });
      continue;
    }
    if (!DURABLE_MARKER.test(sentence)) continue;
    if (/[?]\s*$/.test(sentence)) continue; // a question is not a fact
    content = stripTrailingPunctuation(sentence);
    confidence = 0.7;
    if (content.length === 0) continue;
    const key = content.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ content, confidence, provenance: "user_statement" });
  }

  return out;
}

/**
 * Validate a candidate with deterministic, host-owned rules. Returns a refusal
 * or null. Duplicate detection is NOT here: it needs the classified bucket, so
 * the engine performs it after classification.
 */
export function validateCandidate(candidate: MemoryCandidate, ctx: { now: string }): MemoryRefusal | null {
  const content = typeof candidate.content === "string" ? candidate.content.trim() : "";
  if (content.length < 3) {
    return memoryRefusal("INVALID", "candidate is blank or too short to be a fact");
  }
  if (content.length > 500) {
    return memoryRefusal("INVALID", "candidate is too long to be a single fact");
  }

  // 1. Secrets first — a credential must not even be considered a fact.
  if (SECRET_MENTION.test(content) || redactSecrets(content) !== content) {
    return memoryRefusal("SECRET_DETECTED", "candidate mentions or contains a credential; refusing to persist it", {
      consolidationHint: "Store a secret in the credential store, never in memory.",
    });
  }

  // 2. An instruction aimed at the assistant is not a fact about the world.
  if (INSTRUCTION.test(content)) {
    return memoryRefusal("INSTRUCTION_AS_FACT", "candidate is an instruction, not a durable fact");
  }

  // 3. Greetings and acknowledgements are not memory.
  if (TRANSIENT.test(content) || content.length < 12) {
    return memoryRefusal("TRANSIENT", "candidate looks like transient chatter");
  }

  // 4. No durable-fact signal at all — unless the turn explicitly asked to
  //    remember it, which is a durable intent by construction.
  if (candidate.explicit !== true && !DURABLE_MARKER.test(content)) {
    return memoryRefusal("IRRELEVANT", "candidate carries no durable-fact signal");
  }

  // 5. Already expired.
  if (candidate.until !== undefined && candidate.until.length > 0) {
    const until = Date.parse(candidate.until);
    const now = Date.parse(ctx.now);
    if (Number.isFinite(until) && Number.isFinite(now) && until <= now) {
      return memoryRefusal("EXPIRED", `candidate expired at ${candidate.until}`);
    }
  }

  return null;
}

// ── Classification ────────────────────────────────────────────────────────────

export interface ClassifyContext {
  turn: CompletedTurn;
  /** Scope a candidate without an explicit scope lands in. Defaults to "global". */
  defaultScope?: MemoryScope;
  /** Known topics, so a captured fact can be filed as it is stored. */
  topics?: readonly MemoryTopic[];
}

export interface ClassifiedCandidate {
  scope: MemoryScope;
  scopeId: string;
  type: MemoryType;
  importance: number;
  confidence: number;
  provenance: MemoryProvenance;
  topicId?: string;
  date: string;
  until?: string;
}

function scopeIdFor(scope: MemoryScope, turn: CompletedTurn, explicit?: string): string | undefined {
  if (explicit !== undefined && explicit.length > 0) return explicit;
  switch (scope) {
    case "global":
      return "global";
    case "session":
      return turn.sessionId;
    case "mission":
      return turn.missionId;
    case "employee":
      return turn.employeeId;
    case "project":
      return turn.projectId;
    default:
      return undefined;
  }
}

/**
 * Pick a bucket and a type for a validated candidate. Classification is an
 * ordered rule set, not a model: the same candidate always lands in the same
 * scope with the same type.
 */
export function classifyCandidate(
  candidate: MemoryCandidate,
  ctx: ClassifyContext,
): ClassifiedCandidate | MemoryRefusal {
  const content = candidate.content.trim();
  const wantedScope = candidate.scope ?? ctx.defaultScope ?? "global";
  const scopeId = scopeIdFor(wantedScope, ctx.turn, candidate.scopeId);

  // A private scope with no id has nowhere to live. Falling back to global would
  // quietly widen a fact the caller meant to keep private, so this is refused.
  if (wantedScope !== "global" && (scopeId === undefined || scopeId.length === 0)) {
    return memoryRefusal(
      "SCOPE_VIOLATION",
      `candidate targets the private "${wantedScope}" scope but the turn carries no ${wantedScope} id`,
    );
  }

  let type: MemoryType = candidate.type ?? "note";
  let importance = 3;
  if (candidate.type === undefined) {
    if (IDENTITY.test(content)) {
      type = "user_preference";
      importance = 5;
    } else if (PREFERENCE.test(content)) {
      type = "user_preference";
      importance = 4;
    } else if (wantedScope === "mission") {
      type = "mission_context";
      importance = 3;
    } else if (wantedScope === "employee") {
      type = "agent_fact";
      importance = 3;
    } else if (PROJECT.test(content) || DECISION.test(content)) {
      type = "project_fact";
      importance = 4;
    }
  }

  const classified: ClassifiedCandidate = {
    scope: wantedScope,
    scopeId: scopeId ?? "global",
    type,
    importance: clampImportance(candidate.importance ?? importance, importance),
    confidence: clampConfidence(candidate.confidence ?? 0.7, 0.7),
    provenance: candidate.provenance ?? (wantedScope === "mission" ? "mission_result" : "user_statement"),
    date: candidate.date ?? ctx.turn.at ?? new Date().toISOString(),
  };
  if (candidate.until !== undefined) classified.until = candidate.until;

  // Best-effort topic assignment from the candidate's own hint, then by alias.
  const topicId = resolveTopic(candidate.topicTitle, content, ctx.topics ?? []);
  if (topicId !== undefined) classified.topicId = topicId;

  return classified;
}

/** Find a topic by explicit title or by an alias/title token appearing in the text. */
export function resolveTopic(
  hint: string | undefined,
  content: string,
  topics: readonly MemoryTopic[],
): string | undefined {
  if (hint !== undefined) {
    const wanted = hint.trim().toLowerCase();
    const exact = topics.find(
      (t) => t.title.toLowerCase() === wanted || t.slug === wanted || t.aliases.some((a) => a.toLowerCase() === wanted),
    );
    if (exact !== undefined) return exact.id;
  }
  const lower = content.toLowerCase();
  for (const topic of topics) {
    const needles = [topic.title, ...topic.aliases].map((n) => n.toLowerCase()).filter((n) => n.length >= 3);
    if (needles.some((n) => lower.includes(n))) return topic.id;
  }
  return undefined;
}
