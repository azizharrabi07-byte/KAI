// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * KAI's provider registry — the ONE source of truth behind `/models`,
 * `/providers`, the Settings Providers/Models area and the palette.
 *
 * Three providers, three honest states:
 *   - `kai-model`: KAI's OWN inference backend (the brain). Model selection
 *     persists through the settings service and applies on the next turn.
 *   - `hermes` / `opencode`: optional delegation targets (workers), never the
 *     brain. KAI has no per-request model override for workers, so worker
 *     model selection is reported as unsupported rather than faked.
 *
 * Every reading is a live probe (real HTTP), never a static list. Secrets are
 * never present here: configured/not-configured booleans only, values stay in
 * the environment, KAI_HOME files or the OS credential store.
 */

import { HermesClient } from "../agents/hermes.ts";
import { resolveHermesKey } from "../agents/hermes-key.ts";
import { OpenCodeClient } from "../agents/opencode.ts";
import type { ModelHealth, ModelProvider } from "../model/types.ts";
import type { EffectiveSettings } from "../settings/settings.ts";

export type ProviderId = "kai-model" | "hermes" | "opencode";

export interface ProviderModel {
  id: string;
  /** True when this model backs KAI's inference right now. */
  current: boolean;
}

export interface ProviderSummary {
  id: ProviderId;
  label: string;
  /** "model" backs KAI's inference; "worker" is a delegation target only. */
  kind: "model" | "worker";
  /** True when this provider backs KAI's inference right now. */
  current: boolean;
  baseUrl: string;
  reachable: boolean;
  /** A credential is present (value never included). */
  authConfigured: boolean;
  /** The credential was accepted by a live probe (false when untested). */
  authorized: boolean;
  version?: string;
  latencyMs?: number;
  /** Live catalogue; empty with `modelsNote` explaining why. */
  models: ProviderModel[];
  modelsNote?: string;
  /** Failure reason when unreachable/unauthorized, never a secret. */
  reason?: string;
}

export interface ProviderTest {
  id: ProviderId;
  ok: boolean;
  reachable: boolean;
  authorized: boolean;
  latencyMs?: number;
  reason: string;
}

export interface ProviderPorts {
  kaiBaseUrl: string;
  kaiEffective: (env?: NodeJS.ProcessEnv, kaiHome?: string) => EffectiveSettings;
  kaiHealth: () => Promise<ModelHealth>;
  kaiModels: () => Promise<string[]>;
  hermesBaseUrl: string;
  hermesApiKey?: string;
  opencodeBaseUrl: string;
  opencodePassword?: string;
  fetchImpl?: typeof fetch;
}

export interface ProviderRegistry {
  list(): Promise<ProviderSummary[]>;
  models(): Promise<{ providers: { id: ProviderId; current: boolean; models: ProviderModel[]; note?: string }[] }>;
  test(id: string): Promise<ProviderTest>;
}

function errReason(error: unknown): string {
  if (error !== null && typeof error === "object") {
    const record = error as Record<string, unknown>;
    if (typeof record["kind"] === "string") return record["kind"] as string;
    if (typeof record["message"] === "string") return (record["message"] as string).slice(0, 160);
  }
  return "unreachable";
}

export function createProviderRegistry(ports: ProviderPorts): ProviderRegistry {
  const fetchImpl = ports.fetchImpl ?? globalThis.fetch;

  async function kai(): Promise<ProviderSummary> {
    const effective = ports.kaiEffective();
    let health: ModelHealth | null = null;
    try {
      health = await ports.kaiHealth();
    } catch {
      health = null;
    }
    let catalogue: string[] = [];
    try {
      catalogue = await ports.kaiModels();
    } catch {
      catalogue = [];
    }
    const current = effective.values.name;
    const models: ProviderModel[] = catalogue.map((id) => ({ id, current: id === current }));
    if (!models.some((m) => m.current)) models.unshift({ id: current, current: true });
    return {
      id: "kai-model",
      label: "KAI model",
      kind: "model",
      baseUrl: effective.values.baseUrl,
      reachable: health?.ok ?? false,
      authConfigured: effective.values.apiKeyConfigured,
      authorized: (health?.ok ?? false) && effective.values.apiKeyConfigured,
      ...(health?.latencyMs !== undefined ? { latencyMs: health.latencyMs } : {}),
      current: true,
      models,
      ...(models.length <= 1 && !effective.values.apiKeyConfigured
        ? { modelsNote: "endpoint catalogue unavailable — no API key configured" }
        : models.length <= 1
          ? { modelsNote: "endpoint did not advertise a catalogue; showing the active model" }
          : {}),
      ...(health !== null && !health.ok ? { reason: health.reason ?? "unreachable" } : {}),
      ...(health === null ? { reason: "health probe failed" } : {}),
    };
  }

  function hermesClient(): HermesClient {
    return new HermesClient({
      baseUrl: ports.hermesBaseUrl,
      apiKey: resolveHermesKey(ports.hermesApiKey),
      fetchImpl,
    });
  }

  async function hermes(): Promise<ProviderSummary> {
    const client = hermesClient();
    const startedAt = Date.now();
    try {
      await client.health();
    } catch (error) {
      return {
        id: "hermes",
        label: "Hermes Agent",
        kind: "worker",
        baseUrl: ports.hermesBaseUrl,
        reachable: false,
        authConfigured: client.hasCredentials,
        authorized: false,
        current: false,
        models: [],
        modelsNote: "worker offline — no catalogue",
        reason: errReason(error),
      };
    }
    const latencyMs = Date.now() - startedAt;
    try {
      const probed = await client.probe();
      const listed = await client.models();
      return {
        id: "hermes",
        label: "Hermes Agent",
        kind: "worker",
        baseUrl: ports.hermesBaseUrl,
        reachable: true,
        authConfigured: client.hasCredentials,
        authorized: probed.authorized,
        ...(typeof probed.version === "string" ? { version: probed.version } : {}),
        latencyMs,
        current: false,
        models: listed.map((m) => ({ id: m.id, current: false })),
        ...(listed.length === 0 ? { modelsNote: "worker advertised no models" } : {}),
        ...(probed.authorized ? {} : { reason: probed.reason ?? "unauthorized" }),
      };
    } catch (error) {
      return {
        id: "hermes",
        label: "Hermes Agent",
        kind: "worker",
        baseUrl: ports.hermesBaseUrl,
        reachable: true,
        authConfigured: client.hasCredentials,
        authorized: false,
        latencyMs,
        current: false,
        models: [],
        modelsNote: "authorized routes refused — no catalogue",
        reason: errReason(error),
      };
    }
  }

  function opencodeClient(): OpenCodeClient {
    return new OpenCodeClient({ baseUrl: ports.opencodeBaseUrl, password: ports.opencodePassword, fetchImpl });
  }

  async function opencode(): Promise<ProviderSummary> {
    const client = opencodeClient();
    const startedAt = Date.now();
    try {
      const health = await client.health();
      const latencyMs = Date.now() - startedAt;
      const version = typeof health.version === "string" ? { version: health.version } : {};
      if (!health.healthy) {
        return {
          id: "opencode",
          label: "OpenCode",
          kind: "worker",
          baseUrl: ports.opencodeBaseUrl,
          reachable: true,
          authConfigured: client.hasCredentials,
          authorized: false,
          ...version,
          latencyMs,
          current: false,
          models: [],
          modelsNote: "worker reports unhealthy — no catalogue",
          reason: "unhealthy",
        };
      }
      return {
        id: "opencode",
        label: "OpenCode",
        kind: "worker",
        baseUrl: ports.opencodeBaseUrl,
        reachable: true,
        authConfigured: client.hasCredentials,
        authorized: true,
        ...version,
        latencyMs,
        current: false,
        models: [],
        // KAI's client does not expose the upstream /provider route (spec
        // drift risk), so no catalogue is claimed — reported, not faked.
        modelsNote: "model catalogue not exposed by KAI's client",
      };
    } catch (error) {
      return {
        id: "opencode",
        label: "OpenCode",
        kind: "worker",
        baseUrl: ports.opencodeBaseUrl,
        reachable: false,
        authConfigured: client.hasCredentials,
        authorized: false,
        current: false,
        models: [],
        modelsNote: "worker offline — no catalogue",
        reason: errReason(error),
      };
    }
  }

  async function list(): Promise<ProviderSummary[]> {
    return [await kai(), await hermes(), await opencode()];
  }

  async function models(): Promise<{ providers: { id: ProviderId; current: boolean; models: ProviderModel[]; note?: string }[] }> {
    const summaries = await list();
    return {
      providers: summaries.map((s) => ({
        id: s.id,
        current: s.kind === "model" && s.reachable,
        models: s.models,
        ...(s.modelsNote !== undefined ? { note: s.modelsNote } : {}),
      })),
    };
  }

  async function test(id: string): Promise<ProviderTest> {
    if (id === "kai-model") {
      const startedAt = Date.now();
      try {
        const health = await ports.kaiHealth();
        const ok = health.ok && health.configured;
        return {
          id,
          ok,
          reachable: health.ok,
          authorized: health.configured,
          latencyMs: Date.now() - startedAt,
          reason: ok ? "connected" : (health.reason ?? "unreachable"),
        };
      } catch (error) {
        return { id, ok: false, reachable: false, authorized: false, reason: errReason(error) };
      }
    }
    if (id === "hermes") {
      const startedAt = Date.now();
      try {
        const probed = await hermesClient().probe();
        const ok = probed.reachable && probed.authorized;
        return {
          id,
          ok,
          reachable: probed.reachable,
          authorized: probed.authorized,
          latencyMs: Date.now() - startedAt,
          reason: ok ? "connected" : (probed.reason ?? "unreachable"),
        };
      } catch (error) {
        return { id, ok: false, reachable: false, authorized: false, reason: errReason(error) };
      }
    }
    if (id === "opencode") {
      const startedAt = Date.now();
      try {
        const health = await opencodeClient().health();
        const ok = health.healthy;
        return {
          id,
          ok,
          reachable: true,
          authorized: ok,
          latencyMs: Date.now() - startedAt,
          reason: ok ? "connected" : "unhealthy",
        };
      } catch (error) {
        return { id, ok: false, reachable: false, authorized: false, reason: errReason(error) };
      }
    }
    return { id: id as ProviderId, ok: false, reachable: false, authorized: false, reason: `unknown provider "${id}"` };
  }

  return { list, models, test };
}

/** The live KAI-model port over the runtime's own provider + settings. */
export function kaiModelPort(deps: {
  provider: ModelProvider;
  effective: (env?: NodeJS.ProcessEnv, kaiHome?: string) => EffectiveSettings;
}): Pick<ProviderPorts, "kaiBaseUrl" | "kaiEffective" | "kaiHealth" | "kaiModels"> {
  return {
    kaiBaseUrl: deps.effective().values.baseUrl,
    kaiEffective: deps.effective,
    kaiHealth: () => deps.provider.health(),
    kaiModels: () => deps.provider.listModels?.() ?? Promise.resolve([]),
  };
}
