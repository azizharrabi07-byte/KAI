// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * hermesAdapter — wraps the (already live-verified) HermesClient in the frozen
 * `AgentAdapter` contract.
 *
 * This file is the ONLY place in the Core that knows the Hermes port (8642) or
 * the run routes (`/v1/runs`). Everything else talks to the adapter.
 *
 * Two real interfaces are in play, and they are deliberately kept apart:
 *   - `sendMessage`  -> POST /api/sessions (+ /api/sessions/{id}/chat), i.e. a
 *                       synchronous "one turn" against a real session.
 *   - `runTask`      -> the run lifecycle: POST /v1/runs -> poll
 *                       GET /v1/runs/{id} to a terminal state -> return.
 *
 * The API key is only ever placed in an `authorization: Bearer …` header. It is
 * never stored on a returned object, never logged, and never embedded in a
 * KaiError.
 */

import { HermesClient } from "../hermes.ts";
import { AgentError } from "../../errors.ts";
import { nowIso } from "../../shared/contracts.ts";
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
  KaiErrorCode,
} from "../../shared/contracts.ts";

// ── KaiError construction (shared with the other agent modules) ────────────────

const RETRYABLE_BY_DEFAULT: ReadonlySet<KaiErrorCode> = new Set<KaiErrorCode>([
  "AGENT_NOT_LISTENING",
  "AGENT_TIMEOUT",
  "AGENT_BAD_RESPONSE",
  "AGENT_RUN_ABANDONED",
  "INTERNAL",
]);

/** Build a contract-shaped KaiError. Never carries anything from the api key. */
export function makeKaiError(
  code: KaiErrorCode,
  message: string,
  options: { retryable?: boolean; detail?: string } = {},
): KaiError {
  const error: KaiError = {
    code,
    message,
    retryable: options.retryable ?? RETRYABLE_BY_DEFAULT.has(code),
    at: nowIso(),
  };
  if (options.detail !== undefined) error.detail = options.detail;
  return error;
}

/** An Error that also carries the structured KaiError, for the void/response APIs. */
export interface AdapterFailure extends Error {
  kaiError: KaiError;
}

export function adapterFailure(error: KaiError): AdapterFailure {
  const failure = new Error(`${error.code}: ${error.message}`) as AdapterFailure;
  failure.name = "AdapterFailure";
  failure.kaiError = error;
  return failure;
}

// ── Transport classification ──────────────────────────────────────────────────

function describeErrorChain(value: unknown): string {
  const seen = new Set<unknown>();
  const out: string[] = [];
  const walk = (node: unknown, depth: number): void => {
    if (node === null || node === undefined || depth > 6 || seen.has(node)) return;
    if (typeof node === "object") seen.add(node);
    if (node instanceof Error) {
      out.push(`${node.name}: ${node.message}`);
      const withCode = node as Error & { code?: unknown; cause?: unknown; errors?: unknown };
      if (typeof withCode.code === "string") out.push(withCode.code);
      walk(withCode.cause, depth + 1);
      if (Array.isArray(withCode.errors)) for (const inner of withCode.errors) walk(inner, depth + 1);
      return;
    }
    if (typeof node === "object") {
      const record = node as Record<string, unknown>;
      if (typeof record.code === "string") out.push(record.code);
      if (typeof record.message === "string") out.push(record.message);
      walk(record.cause, depth + 1);
      if (Array.isArray(record.errors)) for (const inner of record.errors) walk(inner, depth + 1);
      return;
    }
    out.push(String(node));
  };
  walk(value, 0);
  return out.join(" | ");
}

/** Connect refused -> not listening. Everything else is a real failure. */
function classifyTransport(error: unknown, target: string): KaiError {
  if (error instanceof AgentError) {
    if (error.kind === "unauthorized") {
      return makeKaiError("AGENT_AUTH_FAILED", `the agent rejected the credentials (${target})`, {
        detail: error.body,
      });
    }
    if (error.kind === "http") {
      return makeKaiError("AGENT_BAD_RESPONSE", `the agent answered HTTP ${error.status} (${target})`, {
        detail: error.body,
      });
    }
    return classifyTransport((error as { cause?: unknown }).cause, target);
  }

  const text = describeErrorChain(error);
  if (/ECONNREFUSED|ECONNRESET|connection refused|ENOTFOUND|EAI_AGAIN/i.test(text)) {
    return makeKaiError("AGENT_NOT_LISTENING", `nothing is listening at ${target}`, {
      detail: `connection refused (${text || "no detail"})`,
    });
  }
  if (/TimeoutError|ETIMEDOUT|AbortError|timed out|timeout/i.test(text)) {
    return makeKaiError("AGENT_TIMEOUT", `the agent did not answer within the timeout (${target})`, {
      detail: text || "request aborted on timeout",
    });
  }
  return makeKaiError("INTERNAL", `transport failure talking to ${target}`, {
    detail: text || "unknown transport error",
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function usageOf(value: unknown): { inputTokens?: number; outputTokens?: number } | undefined {
  const record = asRecord(value);
  const input = record["input_tokens"] ?? record["inputTokens"] ?? record["prompt_tokens"];
  const output = record["output_tokens"] ?? record["outputTokens"] ?? record["completion_tokens"];
  const usage: { inputTokens?: number; outputTokens?: number } = {};
  if (typeof input === "number") usage.inputTokens = input;
  if (typeof output === "number") usage.outputTokens = output;
  return usage.inputTokens === undefined && usage.outputTokens === undefined ? undefined : usage;
}

const HERMES_CAPABILITIES: readonly AgentCapability[] = [
  "health",
  "status",
  "message",
  "run_task",
  "cancel_task",
  "sessions",
];

const TERMINAL_FAILED = new Set(["failed", "error", "errored"]);
const TERMINAL_CANCELLED = new Set(["cancelled", "canceled", "stopped", "aborted"]);
const TERMINAL_COMPLETED = new Set(["completed", "complete", "succeeded", "done"]);

/**
 * A run that has PARKED, waiting for a decision, before it executes a flagged operation.
 * This is the only point at which a delegated worker can be stopped before a side effect:
 * the gateway holds the run until it is answered.
 */
const AWAITING_APPROVAL_STATUS = "waiting_for_approval";

/** What Hermes reported about the operation it is holding back. */
export interface RunApprovalRequest {
  runId: string;
  taskId: string;
  /**
   * The pending approval as the gateway reported it — e.g. the flagged command, already
   * redacted by the worker before egress — plus the choices it will accept.
   */
  approval: Record<string, unknown>;
  /** The choices the gateway will accept for THIS request. */
  choices: readonly string[];
}

/**
 * KAI's answer to a parked run.
 *
 * Deliberately two values, not four. The gateway also accepts `session` and `always`,
 * which authorize FUTURE calls without asking again — a worker could then obtain its own
 * authorization by tripping the gate once. KAI answers for exactly one occurrence, or
 * refuses; widening is not expressible here on purpose.
 */
export type RunApprovalDecision = "once" | "deny";

export interface HermesAdapterOptions {
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  /** Overall budget for one run's poll loop before it is timed out. */
  runTimeoutMs?: number;
  /** Injected for tests; production uses the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected for tests so a run loop can finish without real sleeping. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /**
   * KAI's authorization decision for an operation Hermes has parked. Called while the run
   * is HELD, so a refusal means the operation never executes.
   *
   * When this is absent, a parked run is DENIED and the run fails closed — a delegated
   * worker must not be able to proceed on the strength of nobody having wired a decision
   * in. Returning `once` authorizes only that occurrence: a later, different call parks
   * again and is decided again, so an authorization can never be replayed against
   * changed arguments.
   */
  authorizeRunApproval?: (
    request: RunApprovalRequest,
  ) => Promise<RunApprovalDecision> | RunApprovalDecision;
  /**
   * KAI's own identity for a DELEGATED turn, supplied as the run's system
   * instruction (`instructions` on POST /v1/runs). Without it a delegated run
   * executes on the worker's DEFAULT product identity — measured live, a KAI
   * subagent then answered "I'm a Hermes Agent instance (Nous Research)". KAI
   * owns the delegated identity, so KAI supplies it here; the worker is
   * instructed as KAI's worker from the first token. Called lazily at each run so
   * a SOUL edit reaches the next delegated turn.
   */
  delegatedIdentity?: () => string | undefined;
  /** Optional event sink so this module never imports core/src/events. */
  onEvent?: (type: string, payload: unknown) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function createHermesAdapter(options: HermesAdapterOptions = {}): AgentAdapter {
  const baseUrl = (options.baseUrl ?? "http://127.0.0.1:8642").replace(/\/+$/, "");
  const apiKey = options.apiKey;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const runTimeoutMs = options.runTimeoutMs ?? 15 * 60_000;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => Date.now());
  const onEvent = options.onEvent;
  const delegatedIdentity = options.delegatedIdentity;
  const authorizeRunApproval = options.authorizeRunApproval;
  /**
   * Requests already answered, keyed per run. Answering the same gateway request twice
   * would be a second authorization for one decision, so a re-report is ignored.
   */
  const answeredApprovals = new Set<string>();

  // Reuse the verified client for health + session work.
  const client = new HermesClient({
    baseUrl,
    apiKey,
    timeoutMs,
    fetchImpl,
  });

  const activeRuns = new Map<string, { startedAt: string; input: string }>();
  let connected = false;
  let lastOkAt: string | undefined;
  let lastHealthError: KaiError | undefined;

  const hasCredentials =
    typeof apiKey === "string" && apiKey.length > 0;

  const emit = (type: string, payload: unknown): void => {
    if (onEvent === undefined) return;
    try {
      onEvent(type, payload);
    } catch {
      // an event sink must never break an agent call
    }
  };

  /** Direct request used for the run routes, which HermesClient does not wrap. */
  async function runsRequest(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<{ status: number; text: string; json: unknown }> {
    const headers: Record<string, string> = { accept: "application/json" };
    // The one and only place the key is used.
    if (hasCredentials) headers["authorization"] = `Bearer ${apiKey}`;
    if (init.body !== undefined) headers["content-type"] = "application/json";

    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method: init.method ?? "GET",
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      throw adapterFailure(classifyTransport(cause, baseUrl));
    }

    const text = await response.text().catch(() => "");
    let json: unknown = null;
    if (text.length > 0) {
      try {
        json = JSON.parse(text) as unknown;
      } catch {
        json = null;
      }
    }
    return { status: response.status, text, json };
  }

  async function bestEffortStop(runId: string): Promise<void> {
    try {
      await runsRequest(`/v1/runs/${encodeURIComponent(runId)}/stop`, { method: "POST" });
    } catch {
      // best effort: the run is being abandoned regardless
    }
  }

  /**
   * Decide an operation the gateway is HOLDING.
   *
   * The run does not continue until this answers, which is what makes it enforcement
   * rather than reporting: a `deny` here means the flagged operation never executes. KAI's
   * policy/approval authority supplies the decision; this function only transports it.
   *
   * Returns `null` when the run may keep polling, or a terminal result when the run must
   * end (KAI's answer could not be delivered, so the safe outcome is to stop it).
   */
  async function answerParkedRun(
    runId: string,
    taskId: string,
    startedAt: string,
    runBody: Record<string, unknown>,
  ): Promise<AgentTaskResult | null> {
    const approval = asRecord(runBody["approval"]);
    const rawChoices = approval["choices"];
    const choices: string[] = Array.isArray(rawChoices)
      ? rawChoices.map((choice) => String(choice))
      : [];
    const requestId =
      asString(approval["request_id"]) ?? asString(approval["id"]) ?? "";

    // A gateway that re-reports the same request must not be answered twice: a second
    // answer would be a second authorization for a single decision.
    const key = `${runId}\u0000${requestId.length > 0 ? requestId : "current"}`;
    if (answeredApprovals.has(key)) return null;

    let decision: RunApprovalDecision = "deny";
    let reason =
      "no authorization decision is wired for delegated runs, so the operation was refused";

    if (authorizeRunApproval !== undefined) {
      try {
        const answer = await authorizeRunApproval({ runId, taskId, approval, choices });
        if (answer === "once") {
          decision = "once";
          reason = "authorized once by KAI policy";
        } else {
          reason = "refused by KAI policy";
        }
      } catch (cause) {
        // KAI's authority being unreachable must never become an approval.
        reason = `KAI could not decide this request (${describeErrorChain(cause)}), so it was refused`;
      }
    }

    // Only a choice the gateway actually offered may be sent. `session` and `always` are
    // never produced here — see RunApprovalDecision — so a worker cannot convert one
    // KAI decision into standing authority for later, different calls.
    if (!choices.includes(decision)) decision = "deny";

    answeredApprovals.add(key);
    emit("agent.approval_decided", { id: "hermes", runId, decision, reason });

    let answer: { status: number; text: string; json: unknown };
    try {
      answer = await runsRequest(`/v1/runs/${encodeURIComponent(runId)}/approval`, {
        method: "POST",
        body: requestId.length > 0 ? { choice: decision, request_id: requestId } : { choice: decision },
      });
    } catch (cause) {
      await bestEffortStop(runId);
      const error = isAdapterFailure(cause) ? cause.kaiError : classifyTransport(cause, baseUrl);
      emit("agent.error", { id: "hermes", runId, code: "AGENT_APPROVAL_UNANSWERED" });
      return resultState(taskId, "abandoned", startedAt, {
        error: makeKaiError(
          "AGENT_RUN_ABANDONED",
          `the parked operation on run ${runId} could not be answered, so the run was stopped`,
          { detail: `${error.code}: ${error.message}` },
        ),
      });
    }

    if (answer.status < 200 || answer.status >= 300) {
      await bestEffortStop(runId);
      emit("agent.error", { id: "hermes", runId, code: "AGENT_APPROVAL_REJECTED" });
      return resultState(taskId, "abandoned", startedAt, {
        error: makeKaiError(
          "AGENT_RUN_ABANDONED",
          `KAI's decision on run ${runId} was not accepted (HTTP ${answer.status})`,
          { detail: answer.text.slice(0, 500) },
        ),
      });
    }

    return null;
  }

  function resultState(
    taskId: string,
    state: AgentTaskResult["state"],
    startedAt: string,
    extra: Partial<AgentTaskResult> = {},
  ): AgentTaskResult {
    return { taskId, state, startedAt, completedAt: nowIso(), ...extra };
  }

  return {
    id: "hermes",
    name: "Hermes Agent",

    capabilities(): readonly AgentCapability[] {
      return HERMES_CAPABILITIES;
    },

    async connect(): Promise<void> {
      const health = await this.health();
      if (!health.ok) {
        throw adapterFailure(
          lastHealthError ??
            makeKaiError("AGENT_NOT_LISTENING", `hermes is not reachable at ${baseUrl}`),
        );
      }
      connected = true;
    },

    async disconnect(): Promise<void> {
      connected = false;
      activeRuns.clear();
    },

    async health(): Promise<AgentHealth> {
      const started = now();
      try {
        // GET /health is the unauthenticated route.
        const health = await client.health();
        const latencyMs = Math.max(0, now() - started);
        const ok = health.status === "ok";
        const out: AgentHealth = { ok, latencyMs, endpoint: baseUrl };
        if (health.version !== null) out.version = health.version;
        if (ok) {
          lastOkAt = nowIso();
          lastHealthError = undefined;
        } else {
          out.detail = `endpoint answered status "${health.status}"`;
          lastHealthError = makeKaiError("AGENT_BAD_RESPONSE", out.detail);
        }
        return out;
      } catch (cause) {
        const latencyMs = Math.max(0, now() - started);
        const error = classifyTransport(cause, baseUrl);
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
        return { id: "hermes", state: "offline", detail: health.detail };
      }

      if (activeRuns.size > 0) {
        const first = [...activeRuns.values()][0];
        const status: AgentStatus = { id: "hermes", state: "working" };
        if (first !== undefined) {
          status.currentTask = first.input.slice(0, 200);
          status.startedAt = first.startedAt;
        }
        if (lastOkAt !== undefined) status.lastActivity = lastOkAt;
        return status;
      }

      try {
        // A real read of the session view, not a guess.
        await client.listSessions();
        lastOkAt = nowIso();
        const status: AgentStatus = { id: "hermes", state: "idle" };
        status.lastActivity = lastOkAt;
        return status;
      } catch (cause) {
        const error = classifyTransport(cause, baseUrl);
        if (error.code === "AGENT_NOT_LISTENING" || error.code === "AGENT_TIMEOUT") {
          return { id: "hermes", state: "offline", detail: error.message };
        }
        return {
          id: "hermes",
          state: "error",
          detail: `${error.code}: ${error.message}`,
        };
      }
    },

    async sendMessage(message: AgentMessage): Promise<AgentResponse> {
      try {
        // No title: a fixed title is rejected as a duplicate on the second use.
        const session = await client.createSession({});
        if (typeof session.id !== "string" || session.id.length === 0) {
          throw adapterFailure(
            makeKaiError("AGENT_BAD_RESPONSE", "hermes did not return a session id"),
          );
        }
        const result = await client.sendChat(session.id, message.text);
        const response: AgentResponse = {
          text: asString(result.message?.content) ?? "",
          raw: result.raw,
        };
        const usage = usageOf(result.usage);
        if (usage !== undefined) response.usage = usage;
        return response;
      } catch (cause) {
        if (isAdapterFailure(cause)) throw cause;
        throw adapterFailure(classifyTransport(cause, baseUrl));
      }
    },

    async runTask(task: AgentTask): Promise<AgentTaskResult> {
      const startedAt = nowIso();

      let submit: { status: number; text: string; json: unknown };
      try {
        // KAI owns the delegated turn's identity: send KAI's own identity as the
        // run's system instruction, so a delegated run does not execute on the
        // worker's default product identity (the L2 leak). Absent/empty => the
        // field is omitted and the worker behaves as before.
        const instructions = delegatedIdentity?.();
        const body: Record<string, unknown> = { input: task.input };
        if (typeof instructions === "string" && instructions.length > 0) {
          body["instructions"] = instructions;
        }
        submit = await runsRequest("/v1/runs", { method: "POST", body });
      } catch (cause) {
        const error = isAdapterFailure(cause) ? cause.kaiError : classifyTransport(cause, baseUrl);
        return resultState(task.id, "failed", startedAt, { error });
      }

      if (submit.status === 401 || submit.status === 403) {
        return resultState(task.id, "failed", startedAt, {
          error: makeKaiError("AGENT_AUTH_FAILED", "hermes rejected the credentials on /v1/runs"),
        });
      }
      if (submit.status < 200 || submit.status >= 300) {
        return resultState(task.id, "failed", startedAt, {
          error: makeKaiError("AGENT_BAD_RESPONSE", `hermes answered HTTP ${submit.status} on /v1/runs`, {
            detail: submit.text.slice(0, 500),
          }),
        });
      }

      const submitBody = asRecord(submit.json);
      const runId = asString(submitBody["run_id"]);
      if (runId === null || runId.length === 0) {
        return resultState(task.id, "failed", startedAt, {
          error: makeKaiError("AGENT_BAD_RESPONSE", "hermes did not return a run_id"),
        });
      }

      activeRuns.set(runId, { startedAt, input: task.input });
      emit("agent.status_changed", { id: "hermes", state: "working", runId });

      const deadline = now() + runTimeoutMs;
      try {
        for (;;) {
          if (now() >= deadline) {
            await bestEffortStop(runId);
            emit("agent.error", { id: "hermes", runId, code: "AGENT_TIMEOUT" });
            emit("agent.run_failed", {
              subagentId: "hermes",
              runId,
              taskId: task.id,
              state: "timed_out",
              code: "AGENT_TIMEOUT",
            });
            return resultState(task.id, "timed_out", startedAt, {
              error: makeKaiError("AGENT_TIMEOUT", `run ${runId} did not finish within ${runTimeoutMs}ms`),
            });
          }

          await sleep(pollIntervalMs);

          let poll: { status: number; text: string; json: unknown };
          try {
            poll = await runsRequest(`/v1/runs/${encodeURIComponent(runId)}`);
          } catch (cause) {
            // A poll that fails must not leave the run executing.
            await bestEffortStop(runId);
            const error = isAdapterFailure(cause)
              ? cause.kaiError
              : classifyTransport(cause, baseUrl);
            emit("agent.error", { id: "hermes", runId, code: "AGENT_RUN_ABANDONED" });
            emit("agent.run_failed", {
              subagentId: "hermes",
              runId,
              taskId: task.id,
              state: "abandoned",
              code: "AGENT_RUN_ABANDONED",
            });
            return resultState(task.id, "abandoned", startedAt, {
              error: makeKaiError("AGENT_RUN_ABANDONED", `lost contact with run ${runId}; asked it to stop`, {
                detail: `${error.code}: ${error.message}`,
              }),
            });
          }

          if (poll.status === 401 || poll.status === 403) {
            await bestEffortStop(runId);
            return resultState(task.id, "abandoned", startedAt, {
              error: makeKaiError("AGENT_RUN_ABANDONED", `credentials rejected while polling run ${runId}`, {
                detail: "AGENT_AUTH_FAILED",
              }),
            });
          }
          if (poll.status < 200 || poll.status >= 300) {
            await bestEffortStop(runId);
            return resultState(task.id, "abandoned", startedAt, {
              error: makeKaiError("AGENT_RUN_ABANDONED", `poll of run ${runId} answered HTTP ${poll.status}`, {
                detail: poll.text.slice(0, 500),
              }),
            });
          }

          const body = asRecord(poll.json);
          const status = (asString(body["status"]) ?? "").toLowerCase();

          // ── A parked run: the one moment a side effect can still be stopped ──
          // The gateway is holding the operation until it is answered. Left unhandled this
          // burned the whole run budget and then reported a timeout, which looks like a
          // slow worker rather than an undecided authorization.
          if (status === AWAITING_APPROVAL_STATUS) {
            const ended = await answerParkedRun(runId, task.id, startedAt, body);
            if (ended !== null) return ended;
            continue;
          }

          // ── The worker RESULT event ───────────────────────────────────────
          // A terminal outcome is the thing KAI's Doer supervises: it is the
          // only signal that says "the worker finished, go look". Emitting it
          // here — at the one place that observes the real terminal status —
          // means every caller of this adapter wakes the supervisor, without
          // each caller having to remember to. `agent.status_changed idle` in
          // the `finally` below says the worker is free again; it does not say
          // the run produced a result, and it is not in the Doer's intake.
          if (TERMINAL_COMPLETED.has(status)) {
            const out: AgentTaskResult = resultState(task.id, "completed", startedAt);
            const output = asString(body["output"]);
            if (output !== null) out.output = output;
            const usage = usageOf(body["usage"]);
            if (usage !== undefined) out.usage = usage;
            emit("agent.run_completed", {
              subagentId: "hermes",
              runId,
              taskId: task.id,
              state: "completed",
            });
            return out;
          }
          if (TERMINAL_FAILED.has(status)) {
            const detail =
              asString(body["error"]) ??
              asString(asRecord(body["error"])["message"]) ??
              undefined;
            emit("agent.run_failed", {
              subagentId: "hermes",
              runId,
              taskId: task.id,
              state: "failed",
              ...(detail !== undefined ? { detail } : {}),
            });
            return resultState(task.id, "failed", startedAt, {
              error: makeKaiError(
                "AGENT_RUN_FAILED",
                `run ${runId} failed`,
                detail === undefined ? {} : { detail },
              ),
            });
          }
          if (TERMINAL_CANCELLED.has(status)) {
            emit("agent.run_cancelled", { subagentId: "hermes", runId, taskId: task.id, state: "cancelled" });
            return resultState(task.id, "cancelled", startedAt, {
              error: makeKaiError("AGENT_RUN_FAILED", `run ${runId} was cancelled`),
            });
          }
          // running / started / queued / unknown-but-not-terminal -> keep polling.
        }
      } finally {
        activeRuns.delete(runId);
        emit("agent.status_changed", { id: "hermes", state: "idle", runId });
      }
    },

    async cancelTask(taskId: string): Promise<void> {
      let response: { status: number; text: string; json: unknown };
      try {
        response = await runsRequest(`/v1/runs/${encodeURIComponent(taskId)}/stop`, {
          method: "POST",
        });
      } catch (cause) {
        throw isAdapterFailure(cause) ? cause : adapterFailure(classifyTransport(cause, baseUrl));
      }
      if (response.status === 401 || response.status === 403) {
        throw adapterFailure(
          makeKaiError("AGENT_AUTH_FAILED", "hermes rejected the credentials on /v1/runs/{id}/stop"),
        );
      }
      // 404 means the run is already gone, which is the outcome we wanted.
      if (response.status >= 400 && response.status !== 404) {
        throw adapterFailure(
          makeKaiError("AGENT_BAD_RESPONSE", `stop answered HTTP ${response.status}`, {
            detail: response.text.slice(0, 500),
          }),
        );
      }
      activeRuns.delete(taskId);
    },
  };
}

function isAdapterFailure(value: unknown): value is AdapterFailure {
  return (
    value instanceof Error &&
    typeof (value as { kaiError?: unknown }).kaiError === "object" &&
    (value as { kaiError?: unknown }).kaiError !== null
  );
}
