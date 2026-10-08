// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * KAI's OWN persisted settings — the small set of Core knobs a human may change
 * at runtime, stored in the Core database (`settings` table) and honoured LIVE,
 * with no restart and no environment edit.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 * Only keys Core actually reads per turn are settable here. A setting that took
 * effect only after a restart would be a decoration, so the allowlist is exactly
 * the model provider's live inputs:
 *
 *   model.name       default model id sent to the provider
 *   model.baseUrl    provider endpoint (http(s) only)
 *   model.timeoutMs  per-request timeout, 1s..10min
 *
 * The credential itself is deliberately NOT a setting: an API key in a SQLite
 * TEXT column is a leak, so the key stays in the environment / KAI_HOME file /
 * OS credential store, exactly as before. GET /settings reports the key's
 * presence (configured yes/no), never its value.
 *
 * ── Precedence ──────────────────────────────────────────────────────────────
 * settings row > environment > KAI_HOME/model/credentials.json > built-in
 * defaults — the same order `resolveModelSettings` already uses, with the
 * settings row as the new top layer. GET reports the winning SOURCE per key so
 * a human always sees WHY a value is what it is.
 *
 * ── Policy ──────────────────────────────────────────────────────────────────
 * Changing where KAI sends inference traffic is traffic redirection, so POST
 * rides the `settings.update` WRITE tool, which the default policy PARKS for a
 * human — same rule as `soul.set`. Nothing applies until approved.
 */

import type { SettingsStore } from "../shared/contracts.ts";
import {
  MODEL_DEFAULTS,
  defaultKaiHome,
  readModelCredentialFile,
  type ModelSettings,
} from "../model/config.ts";

export const SETTING_KEYS = ["model.name", "model.baseUrl", "model.timeoutMs"] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

/** True for a model-namespace key owned by this service. */
export function isSettingKey(key: string): key is SettingKey {
  return (SETTING_KEYS as readonly string[]).includes(key);
}

export type SettingSource = "settings" | "environment" | "credential-file" | "defaults";

export interface EffectiveSettings {
  values: { name: string; baseUrl: string; timeoutMs: number; apiKeyConfigured: boolean };
  sources: { name: SettingSource; baseUrl: SettingSource; timeoutMs: SettingSource };
}

export type SettingsResult<T> = { ok: true; value: T } | { ok: false; reason: string };

function isKey(key: string): key is SettingKey {
  return (SETTING_KEYS as readonly string[]).includes(key);
}

function validateValue(key: SettingKey, value: unknown): SettingsResult<string> {
  if (key === "model.timeoutMs") {
    const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    if (!Number.isInteger(n) || n < 1000 || n > 600_000) {
      return { ok: false, reason: '"model.timeoutMs" must be an integer 1000..600000 (ms)' };
    }
    return { ok: true, value: String(n) };
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return { ok: false, reason: `"${key}" must be a non-empty string` };
  }
  const trimmed = value.trim();
  if (key === "model.baseUrl") {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return { ok: false, reason: '"model.baseUrl" must be a valid http(s) URL' };
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { ok: false, reason: '"model.baseUrl" must be a valid http(s) URL' };
    }
    return { ok: true, value: trimmed.replace(/\/+$/, "") };
  }
  if (trimmed.length > 200) return { ok: false, reason: '"model.name" must be 200 characters or fewer' };
  return { ok: true, value: trimmed };
}

export interface ValidatedSettingsInput {
  settings?: Partial<Record<SettingKey, string>>;
  reset?: SettingKey[];
}

export interface SettingsService {
  /** Raw stored rows (only allowlisted keys are ever present). */
  stored(): { key: string; value: string; updatedAt: string }[];
  /** Effective values + the winning source per key. */
  effective(env?: NodeJS.ProcessEnv, kaiHome?: string): EffectiveSettings;
  /** The override layer handed to `resolveModelSettings` as `explicit`. */
  modelOverrides(): Partial<ModelSettings>;
  /**
   * Dry-run validation for the tool boundary: unknown keys and bad values are
   * refused HERE so a refusal is a 400, never a 200 carrying an error.
   */
  check(input: unknown): SettingsResult<ValidatedSettingsInput>;
  /** Validate + persist a patch. Unknown keys and bad values are refused. */
  set(patch: Record<string, unknown>): SettingsResult<{ updated: string[]; effective: EffectiveSettings }>;
  /** Drop stored keys (one, or all when omitted), revealing the layer below. */
  reset(keys?: string[]): SettingsResult<{ cleared: string[]; effective: EffectiveSettings }>;
}

export function createSettingsService(deps: {
  store: SettingsStore;
  env?: NodeJS.ProcessEnv;
  kaiHome?: string;
}): SettingsService {
  const { store } = deps;
  const envOf = () => deps.env ?? process.env;
  const homeOf = () => deps.kaiHome ?? defaultKaiHome(envOf());

  function storedMap(): Map<string, string> {
    const map = new Map<string, string>();
    for (const row of store.list()) {
      if (isKey(row.key)) map.set(row.key, row.value);
    }
    return map;
  }

  function effective(env = envOf(), kaiHome = homeOf()): EffectiveSettings {
    const stored = storedMap();
    const file = readModelCredentialFile(kaiHome);
    const pick = <T>(
      key: SettingKey,
      fromStored: () => T | undefined,
      fromEnv: () => T | undefined,
      fromFile: () => T | undefined,
      fallback: T,
    ): { value: T; source: SettingSource } => {
      const s = fromStored();
      if (s !== undefined) return { value: s, source: "settings" };
      const e = fromEnv();
      if (e !== undefined) return { value: e, source: "environment" };
      const f = fromFile();
      if (f !== undefined) return { value: f, source: "credential-file" };
      return { value: fallback, source: "defaults" };
    };
    const nonEmpty = (v: string | undefined): string | undefined =>
      v !== undefined && v.trim().length > 0 ? v.trim() : undefined;
    const name = pick("model.name", () => nonEmpty(stored.get("model.name")), () => nonEmpty(env.KAI_MODEL_NAME), () => nonEmpty(file.name), MODEL_DEFAULTS.NAME);
    const baseUrl = pick(
      "model.baseUrl",
      () => nonEmpty(stored.get("model.baseUrl")),
      () => nonEmpty(env.KAI_MODEL_URL),
      () => nonEmpty(file.baseUrl),
      MODEL_DEFAULTS.BASE_URL,
    );
    const timeoutRaw = pick(
      "model.timeoutMs",
      () => {
        const raw = stored.get("model.timeoutMs");
        const n = raw !== undefined ? Number(raw) : NaN;
        return Number.isInteger(n) ? n : undefined;
      },
      () => {
        const n = env.KAI_MODEL_TIMEOUT_MS !== undefined ? Number(env.KAI_MODEL_TIMEOUT_MS) : NaN;
        return Number.isInteger(n) ? n : undefined;
      },
      () => undefined,
      MODEL_DEFAULTS.TIMEOUT_MS,
    );
    const resolved = { name: name.value, baseUrl: baseUrl.value.replace(/\/+$/, ""), timeoutMs: timeoutRaw.value };
    const keyPresent =
      nonEmpty(env.KAI_MODEL_API_KEY) !== undefined || nonEmpty(file.apiKey) !== undefined;
    return {
      values: { ...resolved, apiKeyConfigured: keyPresent },
      sources: { name: name.source, baseUrl: baseUrl.source, timeoutMs: timeoutRaw.source },
    };
  }

  function modelOverrides(): Partial<ModelSettings> {
    const stored = storedMap();
    const out: Partial<ModelSettings> = {};
    const name = stored.get("model.name");
    if (name !== undefined && name.trim().length > 0) out.name = name.trim();
    const baseUrl = stored.get("model.baseUrl");
    if (baseUrl !== undefined && baseUrl.trim().length > 0) out.baseUrl = baseUrl.trim().replace(/\/+$/, "");
    const timeoutRaw = stored.get("model.timeoutMs");
    const timeoutMs = timeoutRaw !== undefined ? Number(timeoutRaw) : NaN;
    if (Number.isInteger(timeoutMs)) out.timeoutMs = timeoutMs;
    return out;
  }

  function check(input: unknown): SettingsResult<ValidatedSettingsInput> {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return { ok: false, reason: "pass settings (object patch) and/or reset (key array)" };
    }
    const record = input as Record<string, unknown>;
    const out: ValidatedSettingsInput = {};
    if (record.settings !== undefined) {
      if (typeof record.settings !== "object" || record.settings === null || Array.isArray(record.settings)) {
        return { ok: false, reason: "settings must be an object patch when present" };
      }
      const entries = Object.entries(record.settings as Record<string, unknown>);
      if (entries.length === 0 && record.reset === undefined) {
        return { ok: false, reason: "nothing to update: pass at least one of model.name, model.baseUrl, model.timeoutMs" };
      }
      const clean = {} as Partial<Record<SettingKey, string>>;
      for (const [key, value] of entries) {
        if (!isKey(key)) return { ok: false, reason: `unknown setting "${key}" — settable: ${SETTING_KEYS.join(", ")}` };
        const validated = validateValue(key, value);
        if (!validated.ok) return validated;
        clean[key] = validated.value;
      }
      out.settings = clean;
    }
    if (record.reset !== undefined) {
      if (!Array.isArray(record.reset) || !record.reset.every((k) => typeof k === "string")) {
        return { ok: false, reason: "reset must be an array of setting keys when present" };
      }
      for (const key of record.reset as string[]) {
        if (!isKey(key)) return { ok: false, reason: `unknown setting "${key}" — settable: ${SETTING_KEYS.join(", ")}` };
      }
      out.reset = [...(record.reset as string[])] as SettingKey[];
    }
    if (out.settings === undefined && out.reset === undefined) {
      return { ok: false, reason: "pass settings (object patch) and/or reset (key array)" };
    }
    return { ok: true, value: out };
  }

  function set(patch: Record<string, unknown>): SettingsResult<{ updated: string[]; effective: EffectiveSettings }> {
    const checked = check({ settings: patch });
    if (!checked.ok) return checked;
    const clean = checked.value.settings ?? {};
    const keys = Object.keys(clean) as SettingKey[];
    if (keys.length === 0) return { ok: false, reason: "nothing to update: pass at least one of model.name, model.baseUrl, model.timeoutMs" };
    const at = new Date().toISOString();
    for (const key of keys) store.set(key, clean[key]!, at);
    return { ok: true, value: { updated: keys, effective: effective() } };
  }

  function reset(keys: string[] = [...SETTING_KEYS]): SettingsResult<{ cleared: string[]; effective: EffectiveSettings }> {
    // An empty array means ALL — the reset route sends `[]` for "factory".
    const targets = keys.length === 0 ? [...SETTING_KEYS] : keys;
    const cleared: string[] = [];
    for (const key of targets) {
      if (!isKey(key)) return { ok: false, reason: `unknown setting "${key}" — settable: ${SETTING_KEYS.join(", ")}` };
      if (store.delete(key)) cleared.push(key);
    }
    return { ok: true, value: { cleared, effective: effective() } };
  }

  return {
    stored: () => store.list().filter((row) => isKey(row.key)),
    effective: (env, kaiHome) => effective(env ?? envOf(), kaiHome ?? homeOf()),
    modelOverrides,
    check,
    set,
    reset,
  };
}
