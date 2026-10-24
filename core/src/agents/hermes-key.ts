// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Where the Hermes API key comes from — resolved in ONE place.
 *
 * There used to be two answers to this question in this process, and they disagreed:
 *
 *   - the agent adapter (runtime.ts) called `resolveHermesKey()`, which falls back to
 *     the Hermes install's own `~/.hermes/.env`;
 *   - the chat relay (server.ts) built its HermesClient straight from `loadConfig()`,
 *     which reads the ENVIRONMENT only.
 *
 * So a Core started by hand from a terminal could run a worker task over `POST /v1/runs`
 * (adapter, key resolved) while EVERY `/chat` turn failed — the same server was answered
 * with no `Authorization` header at all, because the chat client had no key. The 401 was
 * then reported as "agent rejected the credentials", which reads as a rejected key and
 * sent one investigation chasing a credential that was in fact accepted. The defect was
 * never the credential; it was two resolution paths for one credential.
 *
 * Order of preference:
 *
 *   1. whatever the caller passed (the desktop app passes the key it holds in the Windows
 *      Credential Manager, as `KAI_HERMES_KEY`, when it spawns this process),
 *   2. `KAI_HERMES_KEY` or `API_SERVER_KEY` in the environment,
 *   3. the targeted Hermes PROFILE's own `.env`
 *      (`~/.hermes/profiles/<profile>/.env`) when `KAI_HERMES_PROFILE` is set — the
 *      profile is where the worker's hooks and credentials live, so its key is the one
 *      that matches the `/p/<profile>` route,
 *   4. the Hermes install's own `~/.hermes/.env`, so the Core also works when it is
 *      started by hand from a terminal.
 *
 * The key is never written to this repository, never logged, and never returned in a
 * response: it is handed to a client and appears only in an `Authorization` header.
 * Returning `undefined` is a valid outcome — the caller then reports the auth failure
 * honestly instead of pretending the agent is reachable.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { KaiConfig } from "../config.ts";

/** Read `API_SERVER_KEY` out of an env file, or undefined when it is not there. */
function keyFromEnvFile(path: string): string | undefined {
  try {
    if (!existsSync(path)) return undefined;
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const match = /^\s*API_SERVER_KEY\s*=\s*(.+?)\s*$/.exec(line);
      if (match !== null && match[1] !== undefined) {
        return match[1].replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    // An unreadable file is not a reason to refuse to start; the caller will report the
    // auth failure with a code the UI can show.
  }
  return undefined;
}

export function resolveHermesKey(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  profile?: string,
): string | undefined {
  if (typeof explicit === "string" && explicit.length > 0) return explicit;

  const fromEnv = env.KAI_HERMES_KEY ?? env.API_SERVER_KEY;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;

  // A profile name is a path component; refuse anything that could escape profiles/.
  const wanted = (profile ?? env.KAI_HERMES_PROFILE ?? "").trim();
  if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(wanted)) {
    const fromProfile = keyFromEnvFile(join(home, ".hermes", "profiles", wanted, ".env"));
    if (fromProfile !== undefined && fromProfile.length > 0) return fromProfile;
  }

  return keyFromEnvFile(join(home, ".hermes", ".env"));
}

/**
 * The config the chat relay should use: the same credential resolution the adapter uses.
 *
 * `loadConfig()` deliberately reports only what the ENVIRONMENT provides, so it stays a
 * pure function of its argument and remains testable. This is where the one extra step —
 * the Hermes install's own file — is applied, at boot, for both the adapter and the chat
 * client at once.
 *
 * A key that IS already configured is returned untouched, so the key the desktop app
 * passes can never be overridden by whatever happens to sit in `~/.hermes/.env`.
 */
export function withResolvedHermesKey(
  config: KaiConfig,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): KaiConfig {
  if (config.hermes.apiKey !== undefined && config.hermes.apiKey.length > 0) return config;
  const key = resolveHermesKey(undefined, env, home, config.hermes.profile);
  if (key === undefined) return config;
  return { ...config, hermes: { ...config.hermes, apiKey: key } };
}
