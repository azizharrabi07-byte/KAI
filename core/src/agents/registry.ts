// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * registry.ts — the Core's single catalogue of agent adapters.
 *
 * The registry owns adapter identity (id -> adapter), fans lifecycle calls out
 * to every adapter, and — critically — never lets one broken adapter take down
 * the batch: connectAll/healthAll/statusAll always resolve, and a failure is
 * reported as a value (false / ok:false / state:"offline"), never as a throw.
 *
 * It deliberately imports nothing from core/src/events or core/src/storage:
 * observers are supplied as an `onEvent` callback so this module has no edges
 * into modules owned by other workstreams.
 */

import { makeKaiError } from "./adapters/hermesAdapter.ts";
import type {
  AgentAdapter,
  AgentHealth,
  AgentStatus,
} from "../shared/contracts.ts";

export interface AgentRegistry {
  register(adapter: AgentAdapter): void;
  unregister(id: string): void;
  get(id: string): AgentAdapter | undefined;
  list(): AgentAdapter[];
  ids(): string[];
  connectAll(): Promise<Record<string, boolean>>;
  disconnectAll(): Promise<void>;
  healthAll(): Promise<Record<string, AgentHealth>>;
  statusAll(): Promise<AgentStatus[]>;
}

export interface AgentRegistryOptions {
  onEvent?: (type: string, payload: unknown) => void;
}

/** Best-effort human string for an error, without leaking anything. */
function describe(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { kaiError?: { code?: unknown } }).kaiError?.code;
    return typeof code === "string" ? `${code}: ${error.message}` : error.message;
  }
  return String(error);
}

export function createAgentRegistry(options: AgentRegistryOptions = {}): AgentRegistry {
  const adapters = new Map<string, AgentAdapter>();
  const onEvent = options.onEvent;

  const emit = (type: string, payload: unknown): void => {
    if (onEvent === undefined) return;
    try {
      onEvent(type, payload);
    } catch {
      // an observer must never break a lifecycle call
    }
  };

  return {
    register(adapter: AgentAdapter): void {
      adapters.set(adapter.id, adapter);
      emit("agent.registered", { id: adapter.id, name: adapter.name });
    },

    unregister(id: string): void {
      if (adapters.delete(id)) emit("agent.unregistered", { id });
    },

    get(id: string): AgentAdapter | undefined {
      return adapters.get(id);
    },

    list(): AgentAdapter[] {
      return [...adapters.values()];
    },

    ids(): string[] {
      return [...adapters.keys()];
    },

    async connectAll(): Promise<Record<string, boolean>> {
      const result: Record<string, boolean> = {};
      for (const adapter of adapters.values()) {
        try {
          await adapter.connect();
          result[adapter.id] = true;
          emit("agent.connected", { id: adapter.id });
        } catch (error) {
          result[adapter.id] = false;
          emit("agent.error", { id: adapter.id, phase: "connect", detail: describe(error) });
        }
      }
      return result;
    },

    async disconnectAll(): Promise<void> {
      for (const adapter of adapters.values()) {
        try {
          await adapter.disconnect();
          emit("agent.disconnected", { id: adapter.id });
        } catch (error) {
          emit("agent.error", { id: adapter.id, phase: "disconnect", detail: describe(error) });
        }
      }
    },

    async healthAll(): Promise<Record<string, AgentHealth>> {
      const result: Record<string, AgentHealth> = {};
      for (const adapter of adapters.values()) {
        try {
          result[adapter.id] = await adapter.health();
        } catch (error) {
          // A crashed health probe is still a health result: ok:false, never a throw.
          const kai = makeKaiError("INTERNAL", describe(error));
          result[adapter.id] = { ok: false, detail: `${kai.code}: ${kai.message}` };
        }
      }
      return result;
    },

    async statusAll(): Promise<AgentStatus[]> {
      const result: AgentStatus[] = [];
      for (const adapter of adapters.values()) {
        try {
          result.push(await adapter.getStatus());
        } catch (error) {
          // Unreachable / crashed -> offline, never a throw.
          result.push({ id: adapter.id, state: "offline", detail: describe(error) });
        }
      }
      return result;
    },
  };
}
