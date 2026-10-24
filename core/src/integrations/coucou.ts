// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * coucou.ts — the KAI → Coucou observability bridge.
 *
 * Coucou is a desktop island that renders one pill per agent session. It accepts
 * third-party events over a documented local transport
 * (`\\.\pipe\coucou-<sid>`, newline-terminated JSON) and gives them their own pill.
 * This module makes KAI's real lifecycle visible there.
 *
 * ── What this deliberately does NOT do ───────────────────────────────────────
 * It does not talk to the pipe itself, and it does not derive the user's SID.
 * `coucou-hook` — Coucou's own relay — already implements both against exactly
 * this contract, including the retry-while-busy behaviour and the "never block the
 * caller" budget. Re-implementing the pipe client here would duplicate a contract
 * we do not own and could drift from it.
 *
 * ── Authority ────────────────────────────────────────────────────────────────
 * The bridge only OBSERVES. It never calls into the goal executor, never processes
 * parked results, never starts supervision and never authorises anything. Its only
 * effect on the world is the short-lived child process it spawns. Coucou is a
 * presentation sink: KAI's board, approvals, Guard and execution records remain the
 * only authority.
 *
 * ── Failure posture ──────────────────────────────────────────────────────────
 * Coucou is optional. Absent, closed, restarting, broken or slow, KAI behaves
 * exactly as it does today: `send` never throws, never blocks the caller and never
 * waits on I/O. Observability failure must not become execution failure.
 */

import { existsSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";

import { redactSecrets } from "../redact/index.ts";

/** The events Coucou accepts from a third-party agent. */
export type CoucouEventName =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "Notification"
  | "Stop"
  | "StopFailure"
  | "SessionEnd";

const COUCOU_EVENT_NAMES: readonly CoucouEventName[] = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Notification",
  "Stop",
  "StopFailure",
  "SessionEnd",
];

export type CoucouState = "disabled" | "ready" | "unavailable";

export interface CoucouStatus {
  state: CoucouState;
  /** Why the bridge is not fully usable, e.g. "relay not found". Null only when the
   *  relay is present AND Coucou is listening. */
  reason: string | null;
  sent: number;
  dropped: number;
  lastError: string | null;
}

export interface CoucouBridge {
  /** Non-blocking. Validates, redacts, then enqueues. Never throws. */
  send(event: CoucouEventName, sessionId: string, fields?: Record<string, unknown>): void;
  status(): CoucouStatus;
  start(): void;
  stop(): Promise<void>;
}

/** The seam a test substitutes. Mirrors the shape real-transport.ts already uses. */
export type CoucouSpawnFn = (
  command: string,
  args: readonly string[],
  options: { stdio: readonly string[]; windowsHide: boolean },
) => {
  stdin: { write(chunk: string): boolean; end(): void } | null;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  kill(): boolean;
};

export interface CoucouBridgeOptions {
  relayPath?: string;
  agent?: string;
  timeoutMs?: number;
  maxQueue?: number;
  env?: NodeJS.ProcessEnv;
  spawnFn?: CoucouSpawnFn;
  /** Overridable so the connection state is testable without a running Coucou. */
  pipePresentFn?: () => boolean;
  now?: () => number;
}

/** Coucou validates the agent tag; an id outside this is routed to the wrong pill. */
const AGENT_PATTERN = /^[a-z0-9-]{1,24}$/;
/** A session id has to survive Coucou's own routing; keep it to a safe charset. */
const SESSION_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** Coucou's relay reads one JSON document per write; anything larger is refused. */
const MAX_PAYLOAD_BYTES = 4096;
/** Every string we forward is clamped, so one runaway label cannot fill the pipe. */
const MAX_FIELD_CHARS = 200;
/**
 * Absolute paths are the most common accidental leak in a label.
 *
 * Deliberately requires a real path shape — a drive path, or a slash path with at
 * least one complete segment — so ordinary prose containing a slash ("read and/or
 * write") is not mangled into a placeholder. A looser single-segment-slash form ate
 * the tail of any sentence containing a slash.
 */
const ABSOLUTE_PATH = /(?:[A-Za-z]:\\[^\s]+|\/(?:[A-Za-z0-9_.-]+\/)+[^\s]*)/g;

/** Fields the bridge is willing to send, and how they are sanitised. */
const FORWARDED_FIELDS: Record<string, true> = {
  prompt: true,
  tool_name: true,
  message: true,
  session_id: true,
};

/**
 * Names the ENVELOPE owns. A caller field must never reach these, however the
 * allowlist above is edited later — this is the guard that keeps `hook_event_name`
 * or `coucou_agent` from being forged by a payload.
 */
const RESERVED_FIELDS: Record<string, true> = {
  hook_event_name: true,
  coucou_agent: true,
  session_id: true,
};

function resolveRelayPath(env: NodeJS.ProcessEnv): string {
  const local = env["LOCALAPPDATA"] ?? env["localappdata"] ?? "";
  return join(local, "Coucou", "bin", "coucou-hook.exe");
}

/**
 * Is Coucou actually listening?
 *
 * The relay exits 0 whether or not it delivered — verified against the real binary:
 * with no pipe it returns in ~28 ms with status 0 — so the exit code cannot be used
 * to claim delivery. Enumerating the pipe namespace is the only honest signal, and it
 * does not derive or duplicate the SID: it only asks whether any `coucou-` pipe is up.
 */
function coucouPipePresent(): boolean {
  try {
    return readdirSync("\\\\.\\pipe\\").some((name) => name.toLowerCase().startsWith("coucou-"));
  } catch {
    // A namespace we cannot read is not evidence either way.
    return false;
  }
}

/**
 * Replace absolute paths with a placeholder and clamp the length.
 *
 * A task label is a *label*. The full text lives in KAI, where the person can read
 * it; Coucou only needs enough to say what is happening.
 */
function sanitiseText(value: string): string {
  const withoutPaths = value.replace(ABSOLUTE_PATH, "<path>");
  return withoutPaths.length > MAX_FIELD_CHARS ? `${withoutPaths.slice(0, MAX_FIELD_CHARS - 1)}…` : withoutPaths;
}

/**
 * Reduce caller fields to the forwarded allowlist, sanitise the strings, then run
 * the repository's own secret redactor over the result so the bridge and the event
 * bus share one definition of what a secret is.
 */
function prepareFields(fields: Record<string, unknown> | undefined, sessionId: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields ?? {})) {
    // The envelope guard runs FIRST and independently of the allowlist, so a later
    // edit to FORWARDED_FIELDS cannot open a hole that lets a payload forge the
    // event name or the agent tag.
    if (RESERVED_FIELDS[key] === true) continue;
    if (FORWARDED_FIELDS[key] !== true) continue;
    if (typeof value === "string") {
      if (value.length === 0) continue;
      out[key] = sanitiseText(value);
    } else if (typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    }
    // Anything else (objects, arrays, functions) is dropped: a label is a scalar.
  }
  out["session_id"] = sessionId;
  const redacted = redactSecrets(out);
  return typeof redacted === "object" && redacted !== null ? (redacted as Record<string, unknown>) : out;
}

export function createCoucouBridge(options: CoucouBridgeOptions = {}): CoucouBridge {
  const env = options.env ?? process.env;
  const relayPath = options.relayPath ?? resolveRelayPath(env);
  const agent = options.agent ?? "kai";
  const timeoutMs = Math.max(250, options.timeoutMs ?? 2000);
  const maxQueue = Math.max(1, options.maxQueue ?? 64);
  const spawnFn: CoucouSpawnFn = options.spawnFn ?? (spawn as unknown as CoucouSpawnFn);
  const pipePresentFn = options.pipePresentFn ?? coucouPipePresent;
  const now = options.now ?? (() => Date.now());

  // A queue of already-serialised payloads, oldest first. Serialising at `send`
  // time is what keeps `send` free of work the caller would have to wait for.
  let queue: string[] = [];
  let sent = 0;
  let dropped = 0;
  let lastError: string | null = null;
  let state: CoucouState = "disabled";
  let reason: string | null = "not started";
  let inFlight = false;
  let stopped = false;
  /** The child currently holding the pipe, so shutdown can never orphan it. */
  let inFlightChild: { kill(): boolean } | null = null;

  /**
   * Record a diagnostic. Bounded, because it is surfaced in status and a raw error
   * message could otherwise carry an unbounded (or sensitive) path into the UI.
   */
  function noteError(message: string): void {
    lastError = message.length > MAX_FIELD_CHARS ? `${message.slice(0, MAX_FIELD_CHARS - 1)}…` : message;
  }

  function status(): CoucouStatus {
    return { state, reason, sent, dropped, lastError };
  }

  function drain(): void {
    if (inFlight || stopped || queue.length === 0) return;
    if (state !== "ready") {
      // Nothing to send to: account for the backlog honestly and clear it rather
      // than growing it forever while Coucou is away.
      dropped += queue.length;
      queue = [];
      return;
    }
    const payload = queue.shift();
    if (payload === undefined) return;
    inFlight = true;
    let finished = false;
    const finish = (error: string | null): void => {
      if (finished) return;
      finished = true;
      inFlight = false;
      inFlightChild = null;
      if (error !== null) noteError(error);
      // Schedule the next drain off the current turn so one slow child cannot
      // stall the caller's stack even if the queue is deep.
      queueMicrotask(drain);
    };

    try {
      const child = spawnFn(relayPath, ["--agent", agent], { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
      inFlightChild = child;
      const timer = setTimeout(() => {
        // The relay has its own budget and must never hold us: past ours it is gone.
        try {
          child.kill();
        } catch {
          /* the child is already gone; nothing to do */
        }
        finish(`relay timed out after ${timeoutMs}ms`);
      }, timeoutMs);
      timer.unref();

      child.on("error", (err: unknown) => {
        clearTimeout(timer);
        finish(err instanceof Error ? err.message : "relay failed to start");
      });
      child.on("close", (code: unknown) => {
        clearTimeout(timer);
        if (typeof code === "number" && code !== 0) {
          finish(`relay exited ${code}`);
          return;
        }
        sent += 1;
        finish(null);
      });

      const stdin = child.stdin;
      if (stdin === null || stdin === undefined) {
        clearTimeout(timer);
        finish("relay has no stdin");
        return;
      }
      stdin.write(payload);
      stdin.end();
    } catch (err) {
      // A synchronous spawn failure (bad path, ENOENT) is data, not a crash.
      finish(err instanceof Error ? err.message : "relay spawn threw");
    }
  }

  return {
    start(): void {
      stopped = false;
      if (!AGENT_PATTERN.test(agent)) {
        state = "unavailable";
        reason = `invalid agent id "${agent}"`;
        return;
      }
      if (!existsSync(relayPath)) {
        // Coucou is not installed. This is a normal state, not an error.
        state = "unavailable";
        reason = `relay not found at ${relayPath}`;
        return;
      }
      state = "ready";
      // The relay is present, so sending is possible — but the relay exits 0 even when
      // it has nothing to deliver, so "ready" alone would overstate the connection.
      // Say plainly whether Coucou is actually listening.
      reason = pipePresentFn() ? null : "Coucou is not running — the relay will accept and drop";
    },

    send(event: CoucouEventName, sessionId: string, fields?: Record<string, unknown>): void {
      // Validation first: a rejected event must not reach the queue at all.
      if (!COUCOU_EVENT_NAMES.includes(event)) {
        dropped += 1;
        noteError(`unsupported event "${String(event)}"`);
        return;
      }
      if (!SESSION_PATTERN.test(sessionId)) {
        dropped += 1;
        lastError = "session id rejected";
        return;
      }
      if (stopped || state === "disabled") {
        dropped += 1;
        return;
      }

      let payload: string;
      try {
        payload = `${JSON.stringify({
          hook_event_name: event,
          session_id: sessionId,
          coucou_agent: agent,
          ...prepareFields(fields, sessionId),
        })}\n`;
      } catch {
        // A circular or otherwise unserialisable payload is a caller bug; drop it
        // rather than throwing into the event bus.
        dropped += 1;
        lastError = "payload not serialisable";
        return;
      }

      if (Buffer.byteLength(payload, "utf8") > MAX_PAYLOAD_BYTES) {
        // Clamping already ran per field; a payload still over the limit is refused
        // rather than truncated into invalid JSON.
        dropped += 1;
        lastError = "payload over 4096 bytes";
        return;
      }

      if (queue.length >= maxQueue) {
        // Drop the OLDEST: a stale transition is less useful than the current one,
        // and an unbounded queue is a memory leak in a long mission.
        queue.shift();
        dropped += 1;
      }
      queue.push(payload);
      drain();
    },

    status,

    async stop(): Promise<void> {
      stopped = true;
      dropped += queue.length;
      queue = [];
      state = "disabled";
      reason = "stopped";
      // Kill the child still holding the pipe. Without this, a stopped Core could
      // leave a relay process behind for up to `timeoutMs` — an orphaned process is
      // exactly the kind of thing shutdown is supposed to prevent. `kill` is
      // best-effort: a child that already exited is a no-op, not an error.
      const child = inFlightChild;
      inFlightChild = null;
      if (child !== null) {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
      }
      inFlight = false;
      await Promise.resolve();
    },
  };
}

/** Exposed for the mapping module and tests; the single source of valid names. */
export const COUCOU_EVENTS = COUCOU_EVENT_NAMES;
