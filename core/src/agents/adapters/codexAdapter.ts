// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * codexAdapter — wraps the Codex CLI transport (../codex.ts) in the frozen
 * `AgentAdapter` contract.
 *
 * Like the Hermes and OpenCode adapters, this is the only place that knows what
 * one Codex turn means; `codex.ts` owns the transport, this file owns the
 * contract mapping.
 *
 * Capabilities are declared, never assumed. This adapter declares exactly what
 * it can really do:
 *
 *   health, status, message, run_task, cancel_task
 *
 * `sessions` is deliberately ABSENT: the CLI can resume a thread (`codex exec
 * resume …`), but this adapter neither lists nor manages sessions, so claiming it
 * would be a lie the Core would act on.
 *
 * The state of a run comes from the parsed terminal event, never from the exit
 * code: a process that exits 0 without `turn.completed` is a FAILURE, and a child
 * that is lost is `abandoned`.
 */

import { nowIso } from "../../shared/contracts.ts";
import { adapterFailure, makeKaiError } from "./hermesAdapter.ts";
import {
  createCodexTransport,
  type CodexOutcome,
  type CodexProbe,
  type CodexRunHandle,
  type CodexTransport,
  type CodexTransportOptions,
} from "../codex.ts";
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

const CODEX_CAPABILITIES: readonly AgentCapability[] = [
  "health",
  "status",
  "message",
  "run_task",
  "cancel_task",
];

export interface CodexAdapterOptions extends CodexTransportOptions {
  /** Optional event sink so this module never imports core/src/events. */
  onEvent?: ((type: string, payload: unknown) => void) | undefined;
  /** Injected for tests, so the contract can be exercised without a real CLI. */
  transport?: CodexTransport | undefined;
}

/** The Machine-readable failure for one non-completed outcome. */
function errorFor(outcome: Exclude<CodexOutcome, { kind: "completed" }>): KaiError {
  switch (outcome.kind) {
    case "failed":
      return makeKaiError("AGENT_RUN_FAILED", outcome.message, outcome.detail === undefined ? {} : { detail: outcome.detail });
    case "malformed":
      return makeKaiError("AGENT_BAD_RESPONSE", outcome.message, outcome.detail === undefined ? {} : { detail: outcome.detail });
    case "timeout":
      return makeKaiError("AGENT_TIMEOUT", outcome.message, outcome.detail === undefined ? {} : { detail: outcome.detail });
    case "cancelled":
      return makeKaiError("CANCELLED", outcome.message);
    case "abandoned":
      return makeKaiError("AGENT_RUN_ABANDONED", outcome.message, outcome.detail === undefined ? {} : { detail: outcome.detail });
    case "exit":
      // Exit 0 with no terminal event is not success — say so as a bad response,
      // not as "the run failed", because the run never reported anything at all.
      return outcome.code === 0
        ? makeKaiError("AGENT_BAD_RESPONSE", outcome.message, outcome.detail === undefined ? {} : { detail: outcome.detail })
        : makeKaiError("AGENT_RUN_FAILED", outcome.message, outcome.detail === undefined ? {} : { detail: outcome.detail });
  }
}

function stateFor(outcome: Exclude<CodexOutcome, { kind: "completed" }>): AgentTaskResult["state"] {
  switch (outcome.kind) {
    case "timeout":
      return "timed_out";
    case "cancelled":
      return "cancelled";
    case "abandoned":
      return "abandoned";
    case "failed":
    case "malformed":
    case "exit":
      return "failed";
  }
}

export function createCodexAdapter(options: CodexAdapterOptions = {}): AgentAdapter {
  const transport =
    options.transport ??
    createCodexTransport({
      command: options.command,
      cwd: options.cwd,
      model: options.model,
      sandbox: options.sandbox,
      skipGitRepoCheck: options.skipGitRepoCheck,
      extraArgs: options.extraArgs,
      env: options.env,
      spawnImpl: options.spawnImpl,
      probeTimeoutMs: options.probeTimeoutMs,
      runTimeoutMs: options.runTimeoutMs,
      maxOutputBytes: options.maxOutputBytes,
      now: options.now,
    });
  const onEvent = options.onEvent;
  const now = options.now ?? (() => Date.now());

  const activeRuns = new Map<string, { handle: CodexRunHandle; startedAt: string; input: string }>();
  let lastProbe: CodexProbe | undefined;
  let lastOkAt: string | undefined;

  const emit = (type: string, payload: unknown): void => {
    if (onEvent === undefined) return;
    try {
      onEvent(type, payload);
    } catch {
      // an event sink must never break an agent call
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

  /** Map a finished handle to the contract. The outcome, not the exit code, decides. */
  function toResult(taskId: string, startedAt: string, outcome: CodexOutcome): AgentTaskResult {
    if (outcome.kind === "completed") {
      const result = resultState(taskId, "completed", startedAt);
      if (outcome.output !== undefined) result.output = outcome.output;
      if (outcome.usage !== undefined) result.usage = outcome.usage;
      return result;
    }
    const error = errorFor(outcome);
    emit("agent.error", { id: "codex", taskId, code: error.code });
    return resultState(taskId, stateFor(outcome), startedAt, { error });
  }

  return {
    id: "codex",
    name: "Codex CLI",

    capabilities(): readonly AgentCapability[] {
      return CODEX_CAPABILITIES;
    },

    async connect(): Promise<void> {
      const probe = await transport.probe();
      lastProbe = probe;
      if (!probe.available) {
        throw adapterFailure(
          makeKaiError("AGENT_NOT_LISTENING", `codex is not available: ${probe.detail ?? "the CLI did not answer"}`, {
            ...(probe.detail === undefined ? {} : { detail: probe.detail }),
          }),
        );
      }
      lastOkAt = nowIso();
    },

    async disconnect(): Promise<void> {
      for (const run of activeRuns.values()) run.handle.cancel("the adapter disconnected");
      activeRuns.clear();
    },

    async health(): Promise<AgentHealth> {
      const started = now();
      const probe = await transport.probe();
      lastProbe = probe;
      const out: AgentHealth = { ok: probe.available, latencyMs: Math.max(0, now() - started), endpoint: transport.command };
      // A version is reported only when the CLI actually printed one.
      if (out.version === undefined && probe.version !== undefined) out.version = probe.version;
      if (probe.available) {
        lastOkAt = nowIso();
      } else {
        out.detail = probe.detail ?? "codex did not answer";
      }
      return out;
    },

    async getStatus(): Promise<AgentStatus> {
      // Never claim idle without asking: a probe is a real check, not a memory.
      const probe = lastProbe ?? (await transport.probe());
      lastProbe = probe;
      if (!probe.available) {
        return { id: "codex", state: "offline", detail: probe.detail ?? "codex is not available" };
      }

      if (activeRuns.size > 0) {
        const first = [...activeRuns.values()][0];
        const status: AgentStatus = { id: "codex", state: "working" };
        if (first !== undefined) {
          status.currentTask = first.input.slice(0, 200);
          status.startedAt = first.startedAt;
        }
        if (lastOkAt !== undefined) status.lastActivity = lastOkAt;
        return status;
      }

      const status: AgentStatus = { id: "codex", state: "idle" };
      if (probe.version !== undefined) status.currentTask = `codex ${probe.version}`;
      status.lastActivity = lastOkAt ?? nowIso();
      return status;
    },

    async sendMessage(message: AgentMessage): Promise<AgentResponse> {
      // One turn of `codex exec` IS the message exchange; there is no session route.
      const handle = transport.run(message.text);
      const outcome = await handle.result;
      if (outcome.kind === "completed") {
        const response: AgentResponse = { text: outcome.output ?? "" };
        if (outcome.usage !== undefined) response.usage = outcome.usage;
        response.raw = { threadId: outcome.threadId };
        return response;
      }
      throw adapterFailure(errorFor(outcome));
    },

    async runTask(task: AgentTask): Promise<AgentTaskResult> {
      const startedAt = nowIso();
      // A caller may shorten the budget for one task; otherwise the transport's applies.
      const timeoutOption = task.options?.["timeoutMs"];
      const handle = transport.run(
        task.input,
        typeof timeoutOption === "number" && Number.isFinite(timeoutOption) ? { timeoutMs: timeoutOption } : {},
      );

      activeRuns.set(task.id, { handle, startedAt, input: task.input });
      emit("agent.status_changed", { id: "codex", state: "working", taskId: task.id });
      try {
        return toResult(task.id, startedAt, await handle.result);
      } finally {
        activeRuns.delete(task.id);
        emit("agent.status_changed", { id: "codex", state: "idle", taskId: task.id });
      }
    },

    /**
     * Kills every in-flight child. A turn is bounded by minutes, so a shutdown
     * must not wait for one; the transport resolves each run as `cancelled`.
     */
    abort(): void {
      for (const run of activeRuns.values()) run.handle.cancel("the adapter was aborted");
      activeRuns.clear();
    },

    async cancelTask(taskId: string): Promise<void> {
      const run = activeRuns.get(taskId);
      // An unknown task is already gone, which is the outcome cancellation wants.
      if (run === undefined) return;
      run.handle.cancel(`task ${taskId} was cancelled`);
      activeRuns.delete(taskId);
    },
  };
}
