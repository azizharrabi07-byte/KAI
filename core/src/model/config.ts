// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Where KAI's OWN model credential comes from — resolved in ONE place, with no
 * dependency on Hermes.
 *
 * ── The rule ──────────────────────────────────────────────────────────────────
 * KAI's inference credential belongs to KAI. This resolver reads, in order:
 *
 *   1. whatever the caller passed explicitly (the desktop app's injected value),
 *   2. KAI's OWN environment (`KAI_MODEL_API_KEY` / `KAI_MODEL_URL` / `KAI_MODEL_NAME`),
 *   3. KAI's OWN credential file under KAI_HOME (`<KAI_HOME>/model/credentials.json`).
 *
 * It deliberately does NOT read the Hermes install (`~/.hermes/.env` or
 * `~/.hermes/config.yaml`). Those belong to a worker. KAI must keep answering with
 * Hermes stopped, disconnected or uninstalled, so the model credential cannot live
 * there. Deployments seed `KAI_HOME/model/credentials.json` (or the environment)
 * with the endpoint + key; that is a one-time setup, not a runtime chat path.
 *
 * ── KAI_HOME: ONE rule, not two ───────────────────────────────────────────────
 * This file used to re-derive its own default (`homedir()/.kai`) while the runtime
 * resolved `%LOCALAPPDATA%\KAI`, so a fresh install looked for the credential in a
 * DIFFERENT root than the one the runtime wrote to and the provider stayed
 * unconfigured. The rule now lives in exactly one place — `agent/kai-home.ts` —
 * and this module re-exports it. In addition, the runtime passes the SAME
 * `kaiHome` it resolved (see `createCoreRuntime`) down to the provider, so nothing
 * re-derives a default at all.
 *
 * The key is never logged, never returned in a response and never written to the
 * repository — it appears only in the provider's `authorization` header.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// THE KAI_HOME rule is owned by the identity layer; re-exported here so the model
// resolver and the identity tree can never disagree about where KAI lives.
export { defaultKaiHome } from "../agent/kai-home.ts";
import { defaultKaiHome } from "../agent/kai-home.ts";

export interface ModelSettings {
  /** The provider id KAI records for provenance. */
  id: string;
  /** Base URL with no trailing slash. */
  baseUrl: string;
  /** Bearer credential, or undefined when unconfigured. */
  apiKey: string | undefined;
  /** Default model id. */
  name: string;
  /** Per-request timeout in ms. */
  timeoutMs: number;
}

export const MODEL_DEFAULTS = {
  /** The OpenAI-compatible endpoint this machine's configured provider serves. */
  BASE_URL: "https://opencode.ai/zen/go/v1",
  NAME: "deepseek-v4.1-flash",
  ID: "kai-model",
  TIMEOUT_MS: 120_000,
} as const;

function clean(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function stripSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export interface FileCredentials {
  baseUrl?: string;
  apiKey?: string;
  name?: string;
  id?: string;
}

function readCredentialFile(path: string): FileCredentials {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};
    const record = parsed as Record<string, unknown>;
    const out: FileCredentials = {};
    if (typeof record["baseUrl"] === "string") out.baseUrl = record["baseUrl"];
    if (typeof record["apiKey"] === "string") out.apiKey = record["apiKey"];
    if (typeof record["name"] === "string") out.name = record["name"];
    if (typeof record["id"] === "string") out.id = record["id"];
    return out;
  } catch {
    // A malformed file is not a reason to refuse to boot; the provider then
    // reports itself unconfigured honestly rather than pretending.
    return {};
  }
}

/**
 * The credential-file layer of the model resolution order, exposed so the
 * settings service can report per-key SOURCES honestly (settings >
 * environment > file > defaults) without re-implementing the file read.
 */
export function readModelCredentialFile(kaiHome: string): FileCredentials {
  return readCredentialFile(join(kaiHome, "model", "credentials.json"));
}

export function resolveModelSettings(
  explicit: Partial<ModelSettings> = {},
  env: NodeJS.ProcessEnv = process.env,
  kaiHome: string = defaultKaiHome(env),
): ModelSettings {
  const file = readModelCredentialFile(kaiHome);

  const baseUrl =
    clean(explicit.baseUrl) ??
    clean(env.KAI_MODEL_URL) ??
    clean(file.baseUrl) ??
    MODEL_DEFAULTS.BASE_URL;

  const apiKey =
    clean(explicit.apiKey) ??
    clean(env.KAI_MODEL_API_KEY) ??
    clean(file.apiKey);

  const name =
    clean(explicit.name) ??
    clean(env.KAI_MODEL_NAME) ??
    clean(file.name) ??
    MODEL_DEFAULTS.NAME;

  const id = clean(explicit.id) ?? clean(env.KAI_MODEL_ID) ?? clean(file.id) ?? MODEL_DEFAULTS.ID;

  const timeoutRaw = clean(env.KAI_MODEL_TIMEOUT_MS);
  const parsedTimeout = timeoutRaw !== undefined ? Number.parseInt(timeoutRaw, 10) : NaN;
  const timeoutMs =
    explicit.timeoutMs ?? (Number.isFinite(parsedTimeout) ? parsedTimeout : MODEL_DEFAULTS.TIMEOUT_MS);

  return { id, baseUrl: stripSlash(baseUrl), apiKey, name, timeoutMs };
}
