// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Single place for every environment variable and default KAI Core reads.
 * Nothing else in this service touches process.env.
 */

export interface HermesConfig {
  /** Base URL of the Hermes Agent api-server. Default http://127.0.0.1:8642 */
  baseUrl: string;
  /** Bearer key (env KAI_HERMES_KEY, fallback API_SERVER_KEY). NEVER logged. */
  apiKey: string | undefined;
  /** Per-request timeout in ms. */
  timeoutMs: number;
  /**
   * Timeout for one chat turn, in ms. A model turn takes seconds, not
   * milliseconds, so it must not share the probe timeout — a 10 s cap turned a
   * working turn into a 502.
   */
  chatTimeoutMs: number;
}

export interface OpenCodeConfig {
  /** Base URL of the OpenCode headless server. Default http://127.0.0.1:4096 */
  baseUrl: string;
  /** Optional HTTP Basic password (env OPENCODE_SERVER_PASSWORD). NEVER logged. */
  password: string | undefined;
  /** Per-request timeout in ms. */
  timeoutMs: number;
}

export interface ServerConfig {
  host: string;
  port: number;
  /** Exact Tauri dev origins allowed to call KAI Core. */
  allowedOrigins: string[];
  /**
   * Shared secret the desktop app holds and passes to authenticate the
   * host-attested chat relay (see `server.ts` POST /chat). The Core receives it
   * through the environment exactly as it receives the Hermes key, and the app
   * sends it back on the `x-kai-host-token` header. When it is absent, NO
   * request can claim user authority — the relay fails closed rather than
   * trusting any local process that can reach the unauthenticated route.
   */
  hostToken: string | undefined;
}

export interface KaiConfig {
  hermes: HermesConfig;
  opencode: OpenCodeConfig;
  server: ServerConfig;
}

export const DEFAULTS = {
  HERMES_URL: "http://127.0.0.1:8642",
  OPENCODE_URL: "http://127.0.0.1:4096",
  SERVER_HOST: "127.0.0.1",
  SERVER_PORT: 8788,
  REQUEST_TIMEOUT_MS: 10_000,
  /** One model turn through Hermes; measured 11.6 s on this host. */
  CHAT_TIMEOUT_MS: 120_000,
  // Origins the desktop UI can load from. The dev origin comes from
  // kai/app/vite.config.ts (server.port 1420, host 127.0.0.1); a *production* Tauri
  // window is served from tauri.localhost, so it must be listed too or every fetch
  // and the event stream would be rejected as cross-origin in the packaged app only.
  ALLOWED_ORIGINS: [
    "http://localhost:1420",
    "http://127.0.0.1:1420",
    "http://tauri.localhost",
    "tauri://localhost",
  ],
} as const;

function clean(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function intFrom(value: string | undefined, fallback: number): number {
  const cleaned = clean(value);
  if (cleaned === undefined) return fallback;
  const parsed = Number.parseInt(cleaned, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Strip a trailing slash so path joins stay predictable. */
function stripSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): KaiConfig {
  const allowedOrigins = clean(env.KAI_CORE_ALLOWED_ORIGINS)
    ? clean(env.KAI_CORE_ALLOWED_ORIGINS)!.split(",").map((o) => o.trim()).filter(Boolean)
    : [...DEFAULTS.ALLOWED_ORIGINS];

  return {
    hermes: {
      baseUrl: stripSlash(clean(env.KAI_HERMES_URL) ?? DEFAULTS.HERMES_URL),
      apiKey: clean(env.KAI_HERMES_KEY) ?? clean(env.API_SERVER_KEY),
      timeoutMs: intFrom(env.KAI_HERMES_TIMEOUT_MS, DEFAULTS.REQUEST_TIMEOUT_MS),
      chatTimeoutMs: intFrom(env.KAI_HERMES_CHAT_TIMEOUT_MS, DEFAULTS.CHAT_TIMEOUT_MS),
    },
    opencode: {
      baseUrl: stripSlash(clean(env.KAI_OPENCODE_URL) ?? DEFAULTS.OPENCODE_URL),
      password: clean(env.OPENCODE_SERVER_PASSWORD),
      timeoutMs: intFrom(env.KAI_OPENCODE_TIMEOUT_MS, DEFAULTS.REQUEST_TIMEOUT_MS),
    },
    server: {
      host: clean(env.KAI_CORE_HOST) ?? DEFAULTS.SERVER_HOST,
      port: intFrom(env.KAI_CORE_PORT, DEFAULTS.SERVER_PORT),
      allowedOrigins,
      hostToken: clean(env.KAI_HOST_TOKEN),
    },
  };
}

/**
 * Config with every secret replaced by a boolean. The only representation of
 * the config that is ever safe to log or return over HTTP.
 */
export function redactedConfig(config: KaiConfig): Record<string, unknown> {
  return {
    hermes: {
      baseUrl: config.hermes.baseUrl,
      apiKeyPresent: config.hermes.apiKey !== undefined,
      timeoutMs: config.hermes.timeoutMs,
      chatTimeoutMs: config.hermes.chatTimeoutMs,
    },
    opencode: {
      baseUrl: config.opencode.baseUrl,
      passwordPresent: config.opencode.password !== undefined,
      timeoutMs: config.opencode.timeoutMs,
    },
    server: {
      host: config.server.host,
      port: config.server.port,
      allowedOrigins: config.server.allowedOrigins,
      // A boolean, never the token itself: the value is a secret.
      hostTokenPresent: config.server.hostToken !== undefined,
    },
  };
}
