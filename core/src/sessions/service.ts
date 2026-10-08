// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The session service: KAI's conversation lifecycle.
 *
 * A thin, testable layer over `store.ts` that owns the RULES, so every caller
 * (the HTTP surface, the chat relay, the memory scope resolver) enforces the
 * same ones:
 *
 *   - exactly one session is ACTIVE and new turns go to it;
 *   - a session that does not exist is an error VALUE, never a silent success;
 *   - archiving the active session moves the active pointer, so KAI can never be
 *     left with "the conversation I am writing to" pointing at an archived one;
 *   - the first turn on a session binds the worker conversation to it, so a
 *     later turn continues that same worker conversation after a restart.
 *
 * Errors are values (the Core's convention): a caller gets `{ok:false,...}`
 * instead of an exception crossing a subsystem boundary.
 */

import {
  createSessionStore,
  deriveOwnership,
  type KaiSession,
  type SessionSearchHit,
  type SessionStatus,
  type SessionStore,
  type SessionSummaryBlob,
  type SessionToolCall,
  type SessionTurn,
} from "./store.ts";

export type { SessionToolCall };

/** Cap the digest inputs: a summary describes the session, it never IS the transcript. */
const SUMMARY_TURN_CAP = 200;
const SUMMARY_TOOL_CAP = 500;
const SUMMARY_FILES_CAP = 20;

/** String values that name a file under these argument/result keys count as touched files. */
const PATH_KEYS = new Set(["path", "root", "cwd", "file", "dir", "directory"]);

function looksLikePath(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 2 || trimmed.length > 500) return false;
  // ABSOLUTE paths only. A bare filename or a version string ("v24.11.0", a
  // timestamp, a DLL name) is not a file this session touched — the loose
  // fallback once filled digests with exactly that noise.
  return /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith("/") || trimmed.startsWith("~/");
}

function collectPaths(value: unknown, into: string[]): void {
  if (typeof value === "string") {
    if (looksLikePath(value) && !into.includes(value.trim())) into.push(value.trim());
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPaths(item, into);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      if (PATH_KEYS.has(key) && typeof entry === "string") {
        if (looksLikePath(entry) && !into.includes(entry.trim())) into.push(entry.trim());
      } else collectPaths(entry, into);
    }
  }
}

function firstLine(text: string, cap: number): string {
  const line = text
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part.length > 0) ?? "";
  return line.length <= cap ? line : `${line.slice(0, cap).trimEnd()}…`;
}

/**
 * Build the digest. Extractive only: the objective is the first user message,
 * files come from tool arguments/results, the last line is the last assistant
 * line. Nothing is inferred, so nothing can be invented.
 */
export function buildSessionSummary(
  turns: SessionTurn[],
  calls: SessionToolCall[],
  builtAt: string,
  previousNarrative?: string,
): SessionSummaryBlob {
  const firstUser = turns.find((turn) => turn.role === "user");
  const assistants = turns.filter((turn) => turn.role === "assistant" && turn.text.trim().length > 0);
  const files: string[] = [];
  for (const call of calls) {
    try {
      collectPaths(JSON.parse(call.arguments) as unknown, files);
    } catch {
      // A non-JSON argument string contributes nothing extractable.
    }
    if (call.result !== undefined) collectPaths(call.result, files);
    if (files.length >= SUMMARY_FILES_CAP) break;
  }
  // The digest names the canonical registry id (`filesystem.search`), never
  // the wire spelling (`filesystem_search`) the model happened to echo.
  const toolsUsed: string[] = [];
  for (const call of calls) {
    const canonical = call.toolId ?? call.toolName;
    if (!toolsUsed.includes(canonical)) toolsUsed.push(canonical);
  }
  const summary: SessionSummaryBlob = {
    objective: firstUser !== undefined ? firstLine(firstUser.text, 200) : "",
    files: files.slice(0, SUMMARY_FILES_CAP),
    toolsUsed,
    toolStats: { total: calls.length, executed: calls.filter((call) => call.status === "EXECUTED").length },
    lastAssistantLine: assistants.length > 0 ? firstLine(assistants[assistants.length - 1]!.text, 200) : "",
    builtAt,
  };
  // A model-written narrative survives rebuilds: it was written about this
  // session deliberately, and a rebuild must not erase it.
  if (previousNarrative !== undefined && previousNarrative.length > 0) summary.narrative = previousNarrative;
  return summary;
}

export interface SessionServiceOptions {
  store?: SessionStore;
  now?: () => Date;
  idFactory?: () => string;
}

export type SessionResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: SessionErrorCode; reason: string };

export type SessionErrorCode = "NOT_FOUND" | "ARCHIVED" | "INVALID";

/**
 * The concrete memory bucket a session's own facts live in. `scopeId` IS the
 * session id: the runtime's `resolveMemoryScope` validates that pairing, and
 * the `session` scope is only wired because this service really mints the ids.
 */
export interface SessionMemoryScope {
  scope: "session";
  scopeId: string;
}

/**
 * The compact extractive digest of a session: what the conversation is about,
 * in fields — never a dump of the transcript. Built deterministically from
 * recorded turns and tool calls (no model call), so it never invents facts
 * and never changes randomly between reloads. A model-written summary may
 * replace it later; the shape already fits.
 */
export interface SessionSummary {
  /** The objective, from the first user message, trimmed. */
  objective: string;
  /** Files the session's tool calls touched (absolute paths, deduplicated). */
  files: string[];
  /** Tool names the session used (deduplicated, in first-use order). */
  toolsUsed: string[];
  /** How many tool calls ran, and how many executed. */
  toolStats: { total: number; executed: number };
  /** The most recent assistant line, trimmed — the "where we left off". */
  lastAssistantLine: string;
  /** When the digest was built. */
  builtAt: string;
}

/**
 * One session as the rest of KAI reads it: the durable facts (ownership,
 * bindings, status, timestamps) plus the two things a caller otherwise has to
 * fetch separately — the recorded history, and the memory scope the session
 * binds to. Read-only by construction: every field comes from the store.
 */
export interface SessionView {
  sessionId: string;
  /** The persona that OWNS this conversation (`kai:<id>`), when one does. */
  agentOwner?: string;
  /** The worker conversation bound to this session (hermes/opencode), once one is. */
  worker?: string;
  /** The mission this conversation is bound to, when one is. */
  missionId?: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  /** The recorded turns, oldest first — the order a conversation reads in. */
  history: SessionTurn[];
  memoryScope: SessionMemoryScope;
  /** The persisted digest, when the session has turns. */
  summary?: SessionSummary;
}

/**
 * A title is auto-derived ONLY while it is still the placeholder the service
 * itself minted (`Conversation N`). A human rename is authoritative: once the
 * title differs, the service never touches it again.
 */
export function isPlaceholderTitle(title: string): boolean {
  return /^Conversation \d+$/.test(title.trim());
}

/**
 * Deterministic title from the first user message: strip markdown noise, take
 * the first sentence, cap at 68 chars. Same words in, same title out — a
 * reload never renames the session.
 */
export function deriveTitle(text: string): string {
  const cleaned = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_~|-]/g, " ")
    .replace(/^(?:please\s+|can you\s+|could you\s+|hey(?:\s+kai)?[,.]?\s+|hi(?:\s+kai)?[,.]?\s+|hello(?:\s+kai)?[,.]?\s+)/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length === 0) return "";
  const sentence = cleaned.split(/(?<=[.!?])\s+/)[0] ?? cleaned;
  const titled = sentence.charAt(0)?.toUpperCase() !== sentence.charAt(0)?.toLowerCase()
    ? sentence.charAt(0).toUpperCase() + sentence.slice(1)
    : sentence;
  return titled.length <= 68 ? titled : `${titled.slice(0, 65).trimEnd()}…`;
}

/**
 * What a resume names: the worker conversation being continued, the mission a
 * conversation belongs to, or nothing (the conversation the person is in, else
 * the newest one KAI owns).
 */
export interface SessionResumeInput {
  agentSessionId?: string;
  missionId?: string;
}

export interface SessionService {
  readonly store: SessionStore;
  /** Which session chat goes to, creating an empty one when none exists. */
  ensureActive(): KaiSession;
  active(): KaiSession | null;
  create(input?: {
    title?: string;
    agentId?: string;
    agentOwner?: string;
    worker?: string;
    missionId?: string;
    sessionKind?: string;
  }): KaiSession;
  list(opts?: { status?: SessionStatus; limit?: number; includeArchived?: boolean }): KaiSession[];
  get(id: string): KaiSession | null;
  rename(id: string, title: string): SessionResult<KaiSession>;
  archive(id: string): SessionResult<KaiSession>;
  unarchive(id: string): SessionResult<KaiSession>;
  activate(id: string): SessionResult<KaiSession>;
  /** Record one turn. Refuses an unknown or archived session. */
  recordTurn(input: {
    sessionId: string;
    role: "user" | "assistant";
    text: string;
    agentId?: string;
  }): SessionResult<SessionTurn>;
  /**
   * Record the tool calls that produced one assistant turn. Each call keeps
   * the model-side id, the arguments verbatim, the registry outcome and the
   * value the model read — so a reload restores THAT a tool was used, not just
   * the prose around it. Refuses an unknown/archived session or a turn that
   * does not belong to it.
   */
  recordToolCalls(
    sessionId: string,
    turnId: string,
    calls: Array<{
      toolCallId: string;
      toolName: string;
      toolId?: string;
      arguments: string;
      invocationId?: string;
      status: string;
      result?: unknown;
      approvalId?: string;
      startedAt: string;
      completedAt: string;
    }>,
  ): SessionResult<SessionToolCall[]>;
  /** Every tool call of a session, oldest first. */
  toolCalls(sessionId: string, limit?: number): SessionResult<SessionToolCall[]>;
  /** Bind the worker conversation this session talks to (idempotent). */
  bindWorker(sessionId: string, agentId: string, agentSessionId: string): SessionResult<KaiSession>;
  turns(sessionId: string, limit?: number): SessionResult<SessionTurn[]>;
  /**
   * Open a conversation: an existing id (must exist and be live) or a fresh
   * session. A conversation KAI owns becomes the ACTIVE one; a persona's own
   * session is opened for reading and never takes the pointer.
   */
  open(input?: { id?: string; title?: string; agentId?: string }): SessionResult<SessionView>;
  /** Make an existing KAI-owned session the active conversation. Refuses a persona's own. */
  switchTo(id: string): SessionResult<SessionView>;
  /** Restore an archived session to ACTIVE (does not steal the active pointer). */
  restore(id: string): SessionResult<SessionView>;
  /**
   * Fork a conversation: same title/ownership/binding and the same recorded
   * turns, but DELIBERATELY no worker conversation id — the copy starts its
   * OWN worker conversation, which is what keeps per-session worker isolation.
   */
  duplicate(id: string, opts?: { title?: string }): SessionResult<SessionView>;
  /** Close a conversation: archive it and move the active pointer off it. */
  close(id: string): SessionResult<SessionView>;
  /** Remove every recorded turn of a session and reset its counters. */
  clear(id: string): SessionResult<{ removed: number; session: KaiSession }>;
  /**
   * Compress a transcript: keep the first `keepFirst` and last `keepLast`
   * turns (with their tool calls, on their ORIGINAL ids), drop the middle,
   * and rebuild the digest. The digest is what preserves the dropped middle —
   * a compacted session keeps its objective, files and tools-used. Refuses an
   * unknown or archived session.
   */
  compact(id: string, opts?: { keepFirst?: number; keepLast?: number }): SessionResult<{
    session: KaiSession;
    kept: number;
    removed: number;
  }>;
  /** Hard-delete a session and its turns. */
  delete(id: string): SessionResult<{ sessionId: string }>;
  /** Bind (or, with null, unbind) the mission a conversation belongs to. */
  bindMission(sessionId: string, missionId: string | null): SessionResult<SessionView>;
  /** The durable record of one session: ownership + bindings + history + memory scope. */
  record(id: string, opts?: { limit?: number }): SessionResult<SessionView>;
  /** Search ids, titles and turn text (LIKE; `%` and `_` are literal characters). */
  search(query: string, opts?: { limit?: number }): SessionResult<SessionSearchHit[]>;
  /**
   * Resume a conversation: resolve the target (a worker conversation id, a
   * mission, or the current/newest conversation), make it active when KAI owns
   * it, and return its view. Refuses an archived target — restore it first.
   */
  resume(input?: SessionResumeInput): SessionResult<SessionView>;
  /** WHICH conversation a resume acts on — null when nothing matches. */
  resumeTarget(input?: SessionResumeInput): KaiSession | null;
  /** The recorded turns of one session, oldest first (same contract as `turns`). */
  history(id: string, limit?: number): SessionResult<SessionTurn[]>;
  /** True when the session exists (the memory-scope subject test). */
  exists(id: string): boolean;
  /**
   * Rebuild the extractive digest from recorded turns + tool calls and persist
   * it. Deterministic: the same transcript always yields the same summary.
   */
  summarize(id: string): SessionResult<SessionSummary>;
  /**
   * Store a model-written narrative on the digest (the extractive fields are
   * kept). Absent narrative reads as absent — never invented.
   */
  setNarrative(id: string, narrative: string): SessionResult<SessionSummary>;
  close(): void;
}

function newId(prefix: string, now: () => Date, random: () => number): string {
  return `${prefix}${now().getTime().toString(36)}_${Math.floor(random() * 1e6).toString(36)}`;
}

export function createSessionService(options: SessionServiceOptions = {}): SessionService {
  const now = options.now ?? (() => new Date());
  const store = options.store ?? createSessionStore({ ...(options.now !== undefined ? { now: options.now } : {}) });
  const idFactory = options.idFactory ?? (() => newId("sess_", now, Math.random));
  /** Turn ids are minted the same way session ids are — one convention, not two. */
  const turnIdFactory = (): string => newId("turn_", now, Math.random);
  const toolCallIdFactory = (): string => newId("tcall_", now, Math.random);

  function notFound(id: string): SessionResult<never> {
    return { ok: false, code: "NOT_FOUND", reason: `no session "${id}" exists` };
  }

  function active(): KaiSession | null {
    const id = store.activeSessionId();
    if (id === null) return null;
    const session = store.get(id);
    // An active pointer at a session that no longer exists (or was archived) is
    // repaired here rather than reported: a dangling pointer is KAI's own bug,
    // not something a caller can act on.
    if (session === null || session.status !== "ACTIVE") {
      store.setActiveSessionId(null);
      return null;
    }
    return session;
  }

  function create(input?: {
    title?: string;
    agentId?: string;
    agentOwner?: string;
    worker?: string;
    missionId?: string;
    sessionKind?: string;
  }): KaiSession {
    const existing = store.list({ limit: 1000 });
    const index = existing.length + 1;
    const session = store.create({
      id: idFactory(),
      title: input?.title?.trim() && input.title.trim().length > 0 ? input.title.trim() : `Conversation ${index}`,
      // A session born owned by a persona (a subagent session) carries its
      // agentId/agentOwner from the start, so it is never the active KAI
      // conversation and never merges into KAI's own history.
      ...(input?.agentId !== undefined && input.agentId.length > 0 ? { agentId: input.agentId } : {}),
      ...(input?.agentOwner !== undefined && input.agentOwner.length > 0 ? { agentOwner: input.agentOwner } : {}),
      ...(input?.worker !== undefined && input.worker.length > 0 ? { worker: input.worker } : {}),
      ...(input?.missionId !== undefined && input.missionId.length > 0 ? { missionId: input.missionId } : {}),
      ...(input?.sessionKind !== undefined && input.sessionKind.length > 0 ? { sessionKind: input.sessionKind } : {}),
    });
    // Only a session KAI itself owns may become the ACTIVE conversation: making a
    // persona's own session active would route KAI's next turn into it.
    const personaOwned =
      (input?.agentId !== undefined && input.agentId.length > 0) ||
      (input?.agentOwner !== undefined && input.agentOwner.length > 0);
    if (!personaOwned && active() === null) store.setActiveSessionId(session.id);
    return session;
  }

  function ensureActive(): KaiSession {
    return active() ?? create({ title: "Conversation 1" });
  }

  function get(id: string): KaiSession | null {
    return store.get(id);
  }

  function list(opts?: { status?: SessionStatus; limit?: number; includeArchived?: boolean }): KaiSession[] {
    return store.list(opts ?? {});
  }

  function requireLive(id: string): SessionResult<KaiSession> {
    const session = store.get(id);
    if (session === null) return notFound(id);
    if (session.status !== "ACTIVE") {
      return { ok: false, code: "ARCHIVED", reason: `session "${id}" is ${session.status}; unarchive it before using it` };
    }
    return { ok: true, value: session };
  }

  function rename(id: string, title: string): SessionResult<KaiSession> {
    if (typeof title !== "string" || title.trim().length === 0) {
      return { ok: false, code: "INVALID", reason: '"title" must be a non-empty string' };
    }
    if (store.get(id) === null) return notFound(id);
    const updated = store.update(id, { title: title.trim() });
    return updated === null ? notFound(id) : { ok: true, value: updated };
  }

  function archive(id: string): SessionResult<KaiSession> {
    if (store.get(id) === null) return notFound(id);
    const updated = store.update(id, { status: "ARCHIVED" });
    if (updated === null) return notFound(id);
    // Never leave the active pointer aimed at an archived conversation.
    if (store.activeSessionId() === id) store.setActiveSessionId(null);
    return { ok: true, value: updated };
  }

  function unarchive(id: string): SessionResult<KaiSession> {
    if (store.get(id) === null) return notFound(id);
    const updated = store.update(id, { status: "ACTIVE" });
    return updated === null ? notFound(id) : { ok: true, value: updated };
  }

  function activate(id: string): SessionResult<KaiSession> {
    const live = requireLive(id);
    if (!live.ok) return live;
    store.setActiveSessionId(id);
    return { ok: true, value: live.value };
  }

  function recordTurn(input: {
    sessionId: string;
    role: "user" | "assistant";
    text: string;
    agentId?: string;
  }): SessionResult<SessionTurn> {
    const live = requireLive(input.sessionId);
    if (!live.ok) return live;
    const turn = store.appendTurn({
      id: turnIdFactory(),
      sessionId: input.sessionId,
      role: input.role,
      text: input.text,
      at: now().toISOString(),
      ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
    });
    // A still-placeholder title is derived from the first user message — once,
    // deterministically. A human rename is authoritative and never overwritten.
    if (isPlaceholderTitle(live.value.title) && input.role === "user") {
      const derived = deriveTitle(input.text);
      if (derived.length > 0) store.update(input.sessionId, { title: derived });
    }
    refreshSummary(input.sessionId);
    const reread = store.get(input.sessionId);
    void reread;
    return { ok: true, value: turn };
  }

  /**
   * Rebuild the digest from the recorded transcript. Runs after every recorded
   * turn and tool batch: the inputs are bounded (200 turns, 500 calls) so a
   * long conversation stays cheap, and the build is deterministic so the digest
   * never flickers between reloads.
   */
  function refreshSummary(sessionId: string): void {
    const session = store.get(sessionId);
    if (session === null) return;
    const digest = buildSessionSummary(
      store.turns(sessionId, SUMMARY_TURN_CAP),
      store.toolCalls(sessionId, SUMMARY_TOOL_CAP),
      now().toISOString(),
      session.summary?.narrative,
    );
    store.update(sessionId, { summary: digest });
  }

  function recordToolCalls(
    sessionId: string,
    turnId: string,
    calls: Array<{
      toolCallId: string;
      toolName: string;
      toolId?: string;
      arguments: string;
      invocationId?: string;
      status: string;
      result?: unknown;
      approvalId?: string;
      startedAt: string;
      completedAt: string;
    }>,
  ): SessionResult<SessionToolCall[]> {
    const live = requireLive(sessionId);
    if (!live.ok) return live;
    const turn = store.turns(sessionId, 10_000).find((candidate) => candidate.id === turnId);
    if (turn === undefined) {
      return { ok: false, code: "NOT_FOUND", reason: `no turn "${turnId}" in session "${sessionId}"` };
    }
    if (calls.length === 0) return { ok: true, value: [] };
    const stored: SessionToolCall[] = [];
    store.transaction(() => {
      for (const call of calls) {
        stored.push(
          store.appendToolCall({
            id: toolCallIdFactory(),
            sessionId,
            turnId,
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            ...(call.toolId !== undefined ? { toolId: call.toolId } : {}),
            arguments: call.arguments,
            ...(call.invocationId !== undefined ? { invocationId: call.invocationId } : {}),
            status: call.status,
            ...(call.result !== undefined ? { result: call.result } : {}),
            ...(call.approvalId !== undefined ? { approvalId: call.approvalId } : {}),
            startedAt: call.startedAt,
            completedAt: call.completedAt,
          }),
        );
      }
    });
    refreshSummary(sessionId);
    return { ok: true, value: stored };
  }

  function toolCalls(sessionId: string, limit?: number): SessionResult<SessionToolCall[]> {
    if (store.get(sessionId) === null) return notFound(sessionId);
    return { ok: true, value: store.toolCalls(sessionId, limit ?? 500) };
  }

  /** Join persisted tool calls onto their turns, so a transcript reads whole. */
  function withTools(turns: SessionTurn[], calls: SessionToolCall[]): SessionTurn[] {
    const byTurn = new Map<string, SessionToolCall[]>();
    for (const call of calls) {
      const group = byTurn.get(call.turnId) ?? [];
      group.push(call);
      byTurn.set(call.turnId, group);
    }
    return turns.map((turn) => {
      const group = byTurn.get(turn.id);
      return group !== undefined && group.length > 0 ? { ...turn, tools: group } : turn;
    });
  }

  function bindWorker(sessionId: string, agentId: string, agentSessionId: string): SessionResult<KaiSession> {
    const live = requireLive(sessionId);
    if (!live.ok) return live;
    // A worker binding must name a WORKER. A persona id here would re-create the
    // overload the store split apart; refuse it rather than write it.
    if (deriveOwnership(agentId).agentOwner !== undefined) {
      return {
        ok: false,
        code: "INVALID",
        reason: `"${agentId}" is a persona id, not a worker id; a worker binding names the worker (hermes/opencode)`,
      };
    }
    const current = live.value;
    // Already bound to the same worker conversation: nothing to write.
    if (current.worker === agentId && current.agentSessionId === agentSessionId) {
      return { ok: true, value: current };
    }
    const patch: { worker: string; agentSessionId: string; agentId?: string } = {
      worker: agentId,
      agentSessionId,
    };
    // The legacy `agentId` column stays a MIRROR of the worker for a session KAI
    // owns — existing readers depend on it (api/routes.ts `personaSessionFor`,
    // the chat relay). It must never be overwritten on a persona-owned session:
    // there it carries the persona (`kai:<id>`), which is what keeps the session
    // from merging into KAI's conversation. `agentOwner` is never touched by a
    // worker binding at all.
    const legacyOwner = current.agentOwner ?? deriveOwnership(current.agentId).agentOwner;
    if (legacyOwner === undefined) patch.agentId = agentId;
    const updated = store.update(sessionId, patch);
    return updated === null ? notFound(sessionId) : { ok: true, value: updated };
  }

  // ── The extended surface ────────────────────────────────────────────────────
  //
  // Everything above predates the session architecture work; everything below is
  // what the router/tools/routes read. The rules stay the same: errors are
  // values, only a session KAI owns can be the ACTIVE conversation, and a
  // persona's own session never merges into KAI's.

  /** The most turns a `duplicate` copies — a bound, not a silent loss: no real conversation here is close. */
  const DUPLICATE_TURN_CAP = 10_000;

  function memoryScopeFor(sessionId: string): SessionMemoryScope {
    return { scope: "session", scopeId: sessionId };
  }

  /** Build the read-only view of a session; every field comes from the store. */
  function viewOf(session: KaiSession, limit?: number): SessionView {
    const view: SessionView = {
      sessionId: session.id,
      status: session.status,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      history: withTools(store.turns(session.id, limit ?? 100), store.toolCalls(session.id)),
      memoryScope: memoryScopeFor(session.id),
    };
    if (session.summary !== undefined) {
      view.summary = {
        objective: session.summary.objective,
        files: [...session.summary.files],
        toolsUsed: [...session.summary.toolsUsed],
        toolStats: { ...session.summary.toolStats },
        lastAssistantLine: session.summary.lastAssistantLine,
        builtAt: session.summary.builtAt,
        ...(session.summary.narrative !== undefined ? { narrative: session.summary.narrative } : {}),
      };
    }
    if (session.agentOwner !== undefined) view.agentOwner = session.agentOwner;
    if (session.worker !== undefined) view.worker = session.worker;
    if (session.missionId !== undefined) view.missionId = session.missionId;
    return view;
  }

  function open(input?: { id?: string; title?: string; agentId?: string }): SessionResult<SessionView> {
    const requestedId = input?.id?.trim() ?? "";
    if (requestedId.length > 0) {
      const live = requireLive(requestedId);
      if (!live.ok) return live;
      // Opening a conversation KAI owns is what makes it the one turns go to; a
      // persona's own session is opened for reading and never takes the pointer.
      if (live.value.agentOwner === undefined) store.setActiveSessionId(live.value.id);
      return { ok: true, value: viewOf(live.value) };
    }
    const created = create(input);
    if (created.agentOwner === undefined) store.setActiveSessionId(created.id);
    return { ok: true, value: viewOf(created) };
  }

  function switchTo(id: string): SessionResult<SessionView> {
    const live = requireLive(id);
    if (!live.ok) return live;
    if (live.value.agentOwner !== undefined) {
      return {
        ok: false,
        code: "INVALID",
        reason: `session "${id}" belongs to persona "${live.value.agentOwner}" and can never be KAI's active conversation`,
      };
    }
    store.setActiveSessionId(id);
    return { ok: true, value: viewOf(live.value) };
  }

  function restore(id: string): SessionResult<SessionView> {
    const session = store.get(id);
    if (session === null) return notFound(id);
    const updated = store.update(id, { status: "ACTIVE" });
    return updated === null ? notFound(id) : { ok: true, value: viewOf(updated) };
  }

  function duplicate(id: string, opts?: { title?: string }): SessionResult<SessionView> {
    const source = store.get(id);
    if (source === null) return notFound(id);
    const title =
      opts?.title !== undefined && opts.title.trim().length > 0 ? opts.title.trim() : `${source.title} (copy)`;
    const copy = store.create({
      id: idFactory(),
      title,
      // The same ownership/worker/mission facts carry over (the legacy `agentId`
      // mirror rides along, so existing readers see the same thing on the copy)…
      ...(source.agentId !== undefined ? { agentId: source.agentId } : {}),
      ...(source.agentOwner !== undefined ? { agentOwner: source.agentOwner } : {}),
      ...(source.worker !== undefined ? { worker: source.worker } : {}),
      ...(source.missionId !== undefined ? { missionId: source.missionId } : {}),
      // …but DELIBERATELY not `agentSessionId`: the copy gets its own worker
      // conversation on its first turn. Copying it would make two KAI sessions
      // claim ONE worker conversation — the per-session worker isolation this
      // subsystem exists to keep.
    });
    if (source.metadata !== undefined) store.update(copy.id, { metadata: source.metadata });
    // The recorded turns are copied (fresh turn ids, same text/role/timestamps),
    // so the fork reads as the same conversation up to the point it forked —
    // and the tool history rides along, remapped onto the copied turns, so the
    // fork keeps the fact that tools were used.
    const copied = store.turns(id, DUPLICATE_TURN_CAP);
    const copiedCalls = store.toolCalls(id, DUPLICATE_TURN_CAP);
    store.transaction(() => {
      const turnIdMap = new Map<string, string>();
      for (const turn of copied) {
        const freshId = turnIdFactory();
        turnIdMap.set(turn.id, freshId);
        store.appendTurn({
          id: freshId,
          sessionId: copy.id,
          role: turn.role,
          text: turn.text,
          at: turn.at,
          ...(turn.agentId !== undefined ? { agentId: turn.agentId } : {}),
        });
      }
      for (const call of copiedCalls) {
        const mappedTurn = turnIdMap.get(call.turnId);
        if (mappedTurn === undefined) continue;
        store.appendToolCall({ ...call, id: toolCallIdFactory(), sessionId: copy.id, turnId: mappedTurn });
      }
    });
    if (source.summary !== undefined) store.update(copy.id, { summary: source.summary });
    return { ok: true, value: viewOf(store.get(copy.id) ?? copy) };
  }

  function closeSession(id: string): SessionResult<SessionView> {
    const session = store.get(id);
    if (session === null) return notFound(id);
    const updated = store.update(id, { status: "ARCHIVED" });
    if (updated === null) return notFound(id);
    // Never leave the active pointer aimed at a closed conversation.
    if (store.activeSessionId() === id) store.setActiveSessionId(null);
    return { ok: true, value: viewOf(updated) };
  }

  function clear(id: string): SessionResult<{ removed: number; session: KaiSession }> {
    const session = store.get(id);
    if (session === null) return notFound(id);
    const removed = store.clearTurns(id);
    return { ok: true, value: { removed, session: store.get(id) ?? session } };
  }

  function compact(id: string, opts?: { keepFirst?: number; keepLast?: number }): SessionResult<{
    session: KaiSession;
    kept: number;
    removed: number;
  }> {
    const live = requireLive(id);
    if (!live.ok) return live;
    const keepFirst = Math.max(0, opts?.keepFirst ?? 2);
    const keepLast = Math.max(0, opts?.keepLast ?? 8);
    const all = store.turns(id, 100_000);
    if (all.length <= keepFirst + keepLast) {
      refreshSummary(id);
      const session = store.get(id);
      if (session === null) return notFound(id);
      return { ok: true, value: { session, kept: all.length, removed: 0 } };
    }
    const keptTurns = [...all.slice(0, keepFirst), ...all.slice(all.length - keepLast)];
    const keptIds = new Set(keptTurns.map((turn) => turn.id));
    const keptCalls = store.toolCalls(id, 100_000).filter((call) => keptIds.has(call.turnId));
    // Rebuild under the ORIGINAL ids (turns and tool calls both), so the
    // surviving transcript keeps its identity and its tool linkage — one
    // atomic replace, so a crash never leaves a half-compacted session.
    store.replaceTurns(id, keptTurns, keptCalls);
    refreshSummary(id);
    const session = store.get(id);
    if (session === null) return notFound(id);
    return { ok: true, value: { session, kept: keptTurns.length, removed: all.length - keptTurns.length } };
  }

  function remove(id: string): SessionResult<{ sessionId: string }> {
    if (store.get(id) === null) return notFound(id);
    if (!store.delete(id)) return notFound(id);
    // The store clears a dangling active pointer; reconcile it onto the newest
    // remaining conversation KAI owns, so a delete never strands the UI with
    // "the conversation I am writing to" pointing nowhere.
    if (store.activeSessionId() === null) {
      const fallback = store.list({ limit: 50 }).find((candidate) => candidate.agentOwner === undefined);
      if (fallback !== undefined) store.setActiveSessionId(fallback.id);
    }
    return { ok: true, value: { sessionId: id } };
  }

  function bindMission(sessionId: string, missionId: string | null): SessionResult<SessionView> {
    const session = store.get(sessionId);
    if (session === null) return notFound(sessionId);
    if (missionId !== null && missionId.trim().length === 0) {
      return { ok: false, code: "INVALID", reason: '"missionId" must be a non-empty string, or null to unbind' };
    }
    const updated = store.update(sessionId, { missionId: missionId === null ? null : missionId.trim() });
    return updated === null ? notFound(sessionId) : { ok: true, value: viewOf(updated) };
  }

  function record(id: string, opts?: { limit?: number }): SessionResult<SessionView> {
    const session = store.get(id);
    if (session === null) return notFound(id);
    return { ok: true, value: viewOf(session, opts?.limit) };
  }

  function search(query: string, opts?: { limit?: number }): SessionResult<SessionSearchHit[]> {
    if (typeof query !== "string" || query.trim().length === 0) {
      return { ok: false, code: "INVALID", reason: '"query" must be a non-empty string' };
    }
    return { ok: true, value: store.search(query, opts ?? {}) };
  }

  function resumeTarget(input: SessionResumeInput = {}): KaiSession | null {
    // A named worker conversation is the strongest claim: it is the worker
    // saying "I am continuing THIS conversation" — route it back to its KAI
    // session (newest first; a worker conversation belongs to one session).
    if (input.agentSessionId !== undefined && input.agentSessionId.length > 0) {
      return store.findByWorkerSessionId(input.agentSessionId);
    }
    if (input.missionId !== undefined && input.missionId.length > 0) {
      return store.findByMissionId(input.missionId);
    }
    // Nothing named: the conversation the person is in, else the most recently
    // updated live conversation KAI itself owns (never a persona's own).
    const current = active();
    if (current !== null) return current;
    return store.list({ limit: 50 }).find((s) => s.agentOwner === undefined) ?? null;
  }

  function resume(input: SessionResumeInput = {}): SessionResult<SessionView> {
    const target = resumeTarget(input);
    if (target === null) return { ok: false, code: "NOT_FOUND", reason: "no conversation to resume" };
    if (target.status !== "ACTIVE") {
      return {
        ok: false,
        code: "ARCHIVED",
        reason: `session "${target.id}" is ${target.status}; restore it before resuming`,
      };
    }
    if (target.agentOwner === undefined) store.setActiveSessionId(target.id);
    return { ok: true, value: viewOf(target) };
  }

  function history(id: string, limit?: number): SessionResult<SessionTurn[]> {
    return turns(id, limit);
  }

  function turns(sessionId: string, limit?: number): SessionResult<SessionTurn[]> {
    if (store.get(sessionId) === null) return notFound(sessionId);
    return {
      ok: true,
      value: withTools(store.turns(sessionId, limit ?? 100), store.toolCalls(sessionId)),
    };
  }

  function summarize(id: string): SessionResult<SessionSummary> {
    const session = store.get(id);
    if (session === null) return notFound(id);
    const digest = buildSessionSummary(
      store.turns(id, SUMMARY_TURN_CAP),
      store.toolCalls(id, SUMMARY_TOOL_CAP),
      now().toISOString(),
      session.summary?.narrative,
    );
    store.update(id, { summary: digest });
    return {
      ok: true,
      value: {
        objective: digest.objective,
        files: [...digest.files],
        toolsUsed: [...digest.toolsUsed],
        toolStats: { ...digest.toolStats },
        lastAssistantLine: digest.lastAssistantLine,
        builtAt: digest.builtAt,
        ...(digest.narrative !== undefined ? { narrative: digest.narrative } : {}),
      },
    };
  }

  function setNarrative(id: string, narrative: string): SessionResult<SessionSummary> {
    if (typeof narrative !== "string" || narrative.trim().length === 0) {
      return { ok: false, code: "INVALID", reason: '"narrative" must be a non-empty string' };
    }
    const session = store.get(id);
    if (session === null) return notFound(id);
    const digest = buildSessionSummary(
      store.turns(id, SUMMARY_TURN_CAP),
      store.toolCalls(id, SUMMARY_TOOL_CAP),
      now().toISOString(),
      narrative.trim(),
    );
    store.update(id, { summary: digest });
    return summarize(id);
  }

  function exists(id: string): boolean {
    return store.get(id) !== null;
  }

  /**
   * Two lives, one name — the interface declares both overloads, and both are
   * real:
   *
   *   - `close()` shuts the STORE down (runtime shutdown, runtime.ts `stop`);
   *   - `close(id)` closes a CONVERSATION: archive it and move the active
   *     pointer off it. That is the router/tools/routes spelling of the
   *     lifecycle operation; internally it is `closeSession` above.
   */
  function close(): void;
  function close(id: string): SessionResult<SessionView>;
  function close(id?: string): SessionResult<SessionView> | void {
    if (id === undefined) {
      store.close();
      return;
    }
    return closeSession(id);
  }

  return {
    store,
    ensureActive,
    active,
    create,
    list,
    get,
    rename,
    archive,
    unarchive,
    activate,
    recordTurn,
    recordToolCalls,
    toolCalls,
    bindWorker,
    turns,
    open,
    switchTo,
    restore,
    duplicate,
    close,
    clear,
    compact,
    delete: remove,
    bindMission,
    record,
    search,
    resume,
    resumeTarget,
    history,
    exists,
    summarize,
    setNarrative,
  };
}
