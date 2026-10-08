// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * mock.ts — deterministic, network-free AgentAdapters.
 *
 * These exist so the Core's own tests never need a live Hermes or OpenCode
 * server. A mock can simulate connected / working / completed / failed /
 * timeout / disconnect, and it never sleeps for real: pass `sleep` + `now` to
 * collapse a run loop to zero wall-clock time.
 *
 * Nothing here talks to the network or reads process.env — the API key is not
 * part of the mock surface at all.
 */

import { nowIso } from "../shared/contracts.ts";
import { adapterFailure, makeKaiError } from "./adapters/hermesAdapter.ts";
import type {
  AgentAdapter,
  AgentCapability,
  AgentHealth,
  AgentMessage,
  AgentResponse,
  AgentStatus,
  AgentTask,
  AgentTaskResult,
} from "../shared/contracts.ts";

export interface MockBaseOptions {
  /** Reported health latency; also a hint only — never a real sleep. */
  latencyMs?: number;
  /** Which stage fails. `null` (default) means "everything works". */
  failAt?: "connect" | "health" | "run" | null;
  /** How long a run is "working" before it completes. Used by opencode too. */
  workMs?: number;
  /** Poll granularity used to burn the run budget with the injected clock. */
  pollIntervalMs?: number;
  /** Injectable clock: milliseconds, monotonically increasing in tests. */
  now?: () => number;
  /** Injectable sleep so a test with a 1ms interval finishes instantly. */
  sleep?: (ms: number) => Promise<void>;
  /** Optional event sink; the registry owns its own. */
  onEvent?: (type: string, payload: unknown) => void;
  version?: string;
}

export interface MockHermesOptions extends MockBaseOptions {
  /**
   * When > 0 the simulated run never reaches a terminal state; the mock gives
   * up after `hangMs` (measured with the injected clock) and returns
   * state "timed_out". This is what lets a test prove the adapter does not hang.
   */
  hangMs?: number;
}

export interface MockOpenCodeOptions extends MockBaseOptions {
  /** Same semantics as the Hermes mock. */
  hangMs?: number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const HERMES_CAPS: readonly AgentCapability[] = [
  "health",
  "status",
  "message",
  "run_task",
  "cancel_task",
  "sessions",
];

const OPENCODE_CAPS: readonly AgentCapability[] = HERMES_CAPS;

function buildMock(
  id: string,
  name: string,
  capabilities: readonly AgentCapability[],
  options: MockHermesOptions,
): AgentAdapter {
  const failAt = options.failAt ?? null;
  const latencyMs = options.latencyMs ?? 0;
  const pollIntervalMs = options.pollIntervalMs ?? 1;
  const version = options.version ?? "mock-1.0.0";
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => Date.now());
  const onEvent = options.onEvent;

  let connected = false;
  let running = false;
  let runStartedAt: string | undefined;

  const emit = (type: string, payload: unknown): void => {
    if (onEvent === undefined) return;
    try {
      onEvent(type, payload);
    } catch {
      /* never let a sink break the mock */
    }
  };

  function resultState(
    taskId: string,
    state: AgentTaskResult["state"],
    extra: Partial<AgentTaskResult> = {},
  ): AgentTaskResult {
    return {
      taskId,
      state,
      startedAt: runStartedAt ?? nowIso(),
      completedAt: nowIso(),
      ...extra,
    };
  }

  return {
    id,
    name,

    capabilities(): readonly AgentCapability[] {
      return capabilities;
    },

    async connect(): Promise<void> {
      if (failAt === "connect") {
        throw adapterFailure(
          makeKaiError("AGENT_NOT_LISTENING", `simulated connect failure for ${id}`),
        );
      }
      connected = true;
      emit("agent.connected", { id });
    },

    async disconnect(): Promise<void> {
      connected = false;
      running = false;
      emit("agent.disconnected", { id });
    },

    async health(): Promise<AgentHealth> {
      if (failAt === "health") {
        return { ok: false, latencyMs, endpoint: `mock://${id}`, detail: `simulated health failure for ${id}` };
      }
      if (!connected) {
        return {
          ok: false,
          endpoint: `mock://${id}`,
          detail: "AGENT_NOT_LISTENING: mock is disconnected",
        };
      }
      return { ok: true, latencyMs, version, endpoint: `mock://${id}` };
    },

    async getStatus(): Promise<AgentStatus> {
      if (!connected) {
        return {
          id,
          state: "offline",
          detail: failAt === "connect" ? "connect refused (simulated)" : "not connected",
        };
      }
      if (running) {
        const status: AgentStatus = { id, state: "working" };
        if (runStartedAt !== undefined) status.startedAt = runStartedAt;
        status.currentTask = "mock task";
        return status;
      }
      return { id, state: "idle", lastActivity: nowIso() };
    },

    async sendMessage(message: AgentMessage): Promise<AgentResponse> {
      if (failAt === "connect" || !connected) {
        throw adapterFailure(
          makeKaiError("AGENT_NOT_LISTENING", `${id} is not connected`),
        );
      }
      return { text: `${id} mock reply: ${message.text}` };
    },

    async runTask(task: AgentTask): Promise<AgentTaskResult> {
      runStartedAt = nowIso();

      if (failAt === "run") {
        return resultState(task.id, "failed", {
          error: makeKaiError("AGENT_RUN_FAILED", `simulated run failure for ${id}`),
        });
      }
      if (!connected) {
        return resultState(task.id, "failed", {
          error: makeKaiError("AGENT_NOT_LISTENING", `${id} is not connected`),
        });
      }

      // Set synchronously, before the first await, so getStatus() observed right
      // after a non-awaited runTask() call reports "working".
      running = true;
      emit("agent.status_changed", { id, state: "working" });
      try {
        const hangMs = options.hangMs ?? 0;
        const workMs = hangMs > 0 ? hangMs : (options.workMs ?? 0);
        const deadline = now() + workMs;
        while (now() < deadline) {
          const remaining = deadline - now();
          await sleep(Math.min(pollIntervalMs, remaining) || 1);
        }

        if (hangMs > 0) {
          return resultState(task.id, "timed_out", {
            error: makeKaiError("AGENT_TIMEOUT", `simulated run exceeded ${hangMs}ms for ${id}`),
          });
        }
        return resultState(task.id, "completed", {
          output: `${id} mock output: ${task.input}`,
        });
      } finally {
        running = false;
        emit("agent.status_changed", { id, state: "idle" });
      }
    },

    async cancelTask(taskId: string): Promise<void> {
      if (!connected) {
        throw adapterFailure(makeKaiError("AGENT_NOT_LISTENING", `${id} is not connected`));
      }
      running = false;
      emit("agent.status_changed", { id, state: "idle", cancelledTask: taskId });
    },
  };
}

export function createMockHermes(options: MockHermesOptions = {}): AgentAdapter {
  return buildMock("hermes", "Hermes Agent (mock)", HERMES_CAPS, options);
}

export function createMockOpenCode(options: MockOpenCodeOptions = {}): AgentAdapter {
  return buildMock("opencode", "OpenCode (mock)", OPENCODE_CAPS, options);
}
