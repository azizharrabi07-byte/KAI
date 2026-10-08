// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * opencodeAdapter — wraps the (already live-verified) OpenCodeClient in the
 * frozen `AgentAdapter` contract.
 *
 * Like the Hermes adapter, this is the only place that knows the OpenCode port
 * (4096) or its routes. The prompt route is POST /session/{id}/message — NOT
 * /session/{id}/prompt, which is the web UI's SPA fallback and answers 200
 * text/html (see opencode.ts). `OpenCodeClient.prompt()` already targets the
 * correct route, so the adapter reuses it.
 */

import { OpenCodeClient } from "../opencode.ts";
import { AgentError } from "../../errors.ts";
import { nowIso } from "../../shared/contracts.ts";
import { adapterFailure, makeKaiError } from "./hermesAdapter.ts";
import type { AdapterFailure } from "./hermesAdapter.ts";
import type {
  AgentAdapter,
  AgentCapability,
  AgentHealth,
  AgentMessage,
  AgentResponse,
  AgentStatus,
  AgentTask,
  AgentTaskResult,
  KaiError,
} from "../../shared/contracts.ts";

const OPENCODE_CAPABILITIES: readonly AgentCapability[] = [
  "health",
  "status",
  "message",
  "run_task",
  "cancel_task",
  "sessions",
];

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Best-effort extraction of assistant text from a prompt response of any shape. */
function textFrom(result: unknown): string {
  const collect = (value: unknown, depth: number): string[] => {
    if (depth > 6) return [];
    if (typeof value === "string") return [value];
    if (Array.isArray(value)) return value.flatMap((entry) => collect(entry, depth + 1));
    if (value !== null && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (Array.isArray(record["parts"])) {
        return (record["parts"] as unknown[]).flatMap((part) => {
          const p = asRecord(part);
          const type = asString(p["type"]);
          const text = asString(p["text"]);
          return text !== null && (type === null || type === "text") ? [text] : [];
        });
      }
      const text = asString(record["text"]);
      if (text !== null && asString(record["type"]) !== "tool") return [text];
      return [];
    }
    return [];
  };
  return collect(result, 0).join("");
}

export interface OpenCodeAdapterOptions {
  baseUrl?: string;
  /** CONTROL requests (health, sessions, aborts). Short on purpose. */
  timeoutMs?: number;
  /** ONE WORKER TURN (POST /session/{id}/message). Minutes, because the model is working. */
  turnTimeoutMs?: number;
  pollIntervalMs?: number;
  /** Optional HTTP Basic password (env OPENCODE_SERVER_PASSWORD). Never logged. */
  password?: string;
  /** Injected for tests; production uses the global fetch. */
  fetchImpl?: typeof fetch;
  now?: () => number;
  onEvent?: (type: string, payload: unknown) => void;
}

/** Map an upstream AgentError onto the contract's KaiError union. */
function classify(error: unknown, target: string): KaiError {
  if (error instanceof AgentError) {
    if (error.kind === "unauthorized") {
      return makeKaiError("AGENT_AUTH_FAILED", `opencode rejected the credentials (${target})`, {
        detail: error.body,
      });
    }
    if (error.kind === "http") {
      return makeKaiError("AGENT_BAD_RESPONSE", `opencode answered HTTP ${error.status} (${target})`, {
        detail: error.body,
      });
    }
    const cause = (error as { cause?: unknown }).cause;
    const text = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
    if (/ECONNREFUSED|ECONNRESET|connection refused|ENOTFOUND/i.test(text)) {
      return makeKaiError("AGENT_NOT_LISTENING", `nothing is listening at ${target}`, {
        detail: `connection refused (${text || "no detail"})`,
      });
    }
    if (/TimeoutError|ETIMEDOUT|AbortError|timed out|timeout/i.test(text)) {
      return makeKaiError("AGENT_TIMEOUT", `opencode did not answer within the timeout (${target})`, {
        detail: text || "request aborted on timeout",
      });
    }
    return makeKaiError("INTERNAL", `transport failure talking to ${target}`, {
      detail: text || "unknown transport error",
    });
  }
  return makeKaiError("INTERNAL", `unexpected error talking to ${target}`, {
    detail: error instanceof Error ? error.message : String(error),
  });
}

function isAdapterFailure(value: unknown): value is AdapterFailure {
  return (
    value instanceof Error &&
    typeof (value as { kaiError?: unknown }).kaiError === "object" &&
    (value as { kaiError?: unknown }).kaiError !== null
  );
}

export function createOpenCodeAdapter(options: OpenCodeAdapterOptions = {}): AgentAdapter {
  const baseUrl = (options.baseUrl ?? "http://127.0.0.1:4096").replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? 10_000;
  const onEvent = options.onEvent;
  const now = options.now ?? (() => Date.now());

  const client = new OpenCodeClient({
    baseUrl,
    password: options.password,
    timeoutMs,
    // Undefined here means the client's own turn default applies — the split must not
    // be undone by an adapter that forgets to pass it.
    ...(options.turnTimeoutMs !== undefined ? { turnTimeoutMs: options.turnTimeoutMs } : {}),
    fetchImpl: options.fetchImpl,
  });

  const activeRuns = new Map<string, { startedAt: string; input: string }>();
  let lastOkAt: string | undefined;
  let lastHealthError: KaiError | undefined;

  const emit = (type: string, payload: unknown): void => {
    if (onEvent === undefined) return;
    try {
      onEvent(type, payload);
    } catch {
      /* an event sink must never break an agent call */
    }
  };

  function resultState(
    taskId: string,
    state: AgentTaskResult["state"],
    startedAt: string,
    extra: Partial<AgentTaskResult> = {},
  ): AgentTaskResult {
    return { taskId, state, startedAt, completedAt: nowIso(), ...extra };
  }

  async function bestEffortAbort(sessionId: string): Promise<void> {
    try {
      await client.fetchRaw(`/session/${encodeURIComponent(sessionId)}/abort`, { method: "POST" });
    } catch {
      /* best effort */
    }
  }

  return {
    id: "opencode",
    name: "OpenCode",

    capabilities(): readonly AgentCapability[] {
      return OPENCODE_CAPABILITIES;
    },

    async connect(): Promise<void> {
      const health = await this.health();
      if (!health.ok) {
        throw adapterFailure(
          lastHealthError ??
            makeKaiError("AGENT_NOT_LISTENING", `opencode is not reachable at ${baseUrl}`),
        );
      }
    },

    async disconnect(): Promise<void> {
      activeRuns.clear();
    },

    async health(): Promise<AgentHealth> {
      const started = now();
      try {
        const health = await client.health();
        const latencyMs = Math.max(0, now() - started);
        const out: AgentHealth = { ok: health.healthy, latencyMs, endpoint: baseUrl };
        if (health.version !== null) out.version = health.version;
        if (out.ok) {
          lastOkAt = nowIso();
          lastHealthError = undefined;
        } else {
          out.detail = "opencode reported healthy=false";
          lastHealthError = makeKaiError("AGENT_BAD_RESPONSE", out.detail);
        }
        return out;
      } catch (cause) {
        const latencyMs = Math.max(0, now() - started);
        const error = classify(cause, baseUrl);
        lastHealthError = error;
        return {
          ok: false,
          latencyMs,
          endpoint: baseUrl,
          detail: `${error.code}: ${error.message}`,
        };
      }
    },

    async getStatus(): Promise<AgentStatus> {
      const health = await this.health();
      if (!health.ok) {
        return { id: "opencode", state: "offline", detail: health.detail };
      }

      if (activeRuns.size > 0) {
        const first = [...activeRuns.values()][0];
        const status: AgentStatus = { id: "opencode", state: "working" };
        if (first !== undefined) {
          status.currentTask = first.input.slice(0, 200);
          status.startedAt = first.startedAt;
        }
        if (lastOkAt !== undefined) status.lastActivity = lastOkAt;
        return status;
      }

      try {
        const pending = await client.listPermissions();
        lastOkAt = nowIso();
        const status: AgentStatus = { id: "opencode", state: "idle" };
        if (pending.length > 0) {
          status.state = "waiting";
          status.currentTask = "permission requested";
          status.detail = `${pending.length} pending permission request(s)`;
        }
        status.lastActivity = lastOkAt;
        return status;
      } catch (cause) {
        const error = classify(cause, baseUrl);
        if (error.code === "AGENT_NOT_LISTENING" || error.code === "AGENT_TIMEOUT") {
          return { id: "opencode", state: "offline", detail: error.message };
        }
        return { id: "opencode", state: "error", detail: `${error.code}: ${error.message}` };
      }
    },

    async sendMessage(message: AgentMessage): Promise<AgentResponse> {
      try {
        const session = await client.createSession({});
        if (session.id.length === 0) {
          throw adapterFailure(makeKaiError("AGENT_BAD_RESPONSE", "opencode did not return a session id"));
        }
        const result = await client.prompt(session.id, message.text);
        return { text: textFrom(result), raw: result };
      } catch (cause) {
        if (isAdapterFailure(cause)) throw cause;
        throw adapterFailure(classify(cause, baseUrl));
      }
    },

    async runTask(task: AgentTask): Promise<AgentTaskResult> {
      const startedAt = nowIso();

      let session: { id: string };
      try {
        session = await client.createSession({ title: `kai-${task.id}` });
      } catch (cause) {
        const error = isAdapterFailure(cause) ? cause.kaiError : classify(cause, baseUrl);
        return resultState(task.id, "failed", startedAt, { error });
      }
      if (session.id.length === 0) {
        return resultState(task.id, "failed", startedAt, {
          error: makeKaiError("AGENT_BAD_RESPONSE", "opencode did not return a session id"),
        });
      }

      activeRuns.set(session.id, { startedAt, input: task.input });
      emit("agent.status_changed", { id: "opencode", state: "working", sessionId: session.id });
      try {
        // prompt() is synchronous: it resolves once the turn is done.
        const result = await client.prompt(session.id, task.input);

        // A turn counts as completed only if the SERVER said so. opencode answers HTTP 200
        // with an assistant message that carries `info.error` (e.g. MessageAbortedError) and
        // empty `parts` — a failed turn wearing a success status code. Reporting that as
        // completed, with no output, is the silent success this codebase forbids: a caller
        // would believe work happened that never did. The error is surfaced instead, with
        // whatever the server named, because "aborted" and "the provider refused" are
        // different problems for whoever reads this next.
        const info = asRecord(asRecord(result)["info"]);
        const failure = asRecord(info["error"]);
        if (Object.keys(failure).length > 0) {
          const name = asString(failure["name"]) ?? "unknown error";
          const detail = asString(asRecord(failure["data"])["message"]);
          const error = makeKaiError("AGENT_RUN_FAILED", `the turn did not complete: ${name}`, {
            ...(detail !== null ? { detail } : {}),
          });
          await bestEffortAbort(session.id);
          emit("agent.error", { id: "opencode", sessionId: session.id, code: error.code });
          return resultState(task.id, "failed", startedAt, { error });
        }

        const completed: AgentTaskResult = resultState(task.id, "completed", startedAt);
        const text = textFrom(result);
        if (text.length > 0) completed.output = text;
        return completed;
      } catch (cause) {
        const error = isAdapterFailure(cause) ? cause.kaiError : classify(cause, baseUrl);
        // Nothing was left executing: abort the session before returning.
        await bestEffortAbort(session.id);
        emit("agent.error", { id: "opencode", sessionId: session.id, code: error.code });

        if (error.code === "AGENT_TIMEOUT") {
          return resultState(task.id, "timed_out", startedAt, { error });
        }
        if (error.code === "AGENT_NOT_LISTENING" || error.code === "INTERNAL") {
          return resultState(task.id, "abandoned", startedAt, {
            error: makeKaiError("AGENT_RUN_ABANDONED", `lost contact with session ${session.id}; aborted it`, {
              detail: `${error.code}: ${error.message}`,
            }),
          });
        }
        return resultState(task.id, "failed", startedAt, { error });
      } finally {
        activeRuns.delete(session.id);
        emit("agent.status_changed", { id: "opencode", state: "idle", sessionId: session.id });
      }
    },

    /**
     * Aborts every in-flight request, including a turn in progress. A timeout cannot be
     * hurried, so without this a shutdown would wait for the turn's own (now long) limit.
     */
    abort(): void {
      client.abort("opencode adapter aborted");
    },

    async cancelTask(taskId: string): Promise<void> {
      // `taskId` is the session id for OpenCode runs.
      try {
        await client.fetchRaw(`/session/${encodeURIComponent(taskId)}/abort`, { method: "POST" });
      } catch (cause) {
        if (isAdapterFailure(cause)) throw cause;
        throw adapterFailure(classify(cause, baseUrl));
      }
      activeRuns.delete(taskId);
    },
  };
}
