// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * KAI plugin contracts — the foundation, not a marketplace.
 *
 * A plugin is a directory with `plugin.json` (the manifest) and `plugin.mjs`
 * (the code: a `manifest` export mirroring the JSON plus a `tools` array).
 * Plugins integrate into the EXISTING tool plane: every contributed tool is
 * registered on the ONE `ToolRegistry` as `plugin.<id>.<tool>` with its
 * declared risk, so validate → policy → (approval) → execute applies exactly
 * as it does to every builtin. There is no second permission system and no
 * second registry — the plugin's own permission model is a RISK CEILING: a
 * tool declared above the manifest's `maxRisk` is refused at define time.
 *
 * Trust model: a plugin directory is code the owner installed (like a skill's
 * bytes, but executable). Defining a plugin imports its module — that is the
 * trust decision, made explicitly by calling `define`, never implicitly.
 */

import type { RiskLevel } from "../shared/contracts.ts";

/** The risk order: a ceiling allows its level and everything below it. */
export const RISK_ORDER: readonly RiskLevel[] = ["READ", "WRITE", "EXTERNAL", "DESTRUCTIVE"];

/** One config key a plugin declares, with its type and default. */
export interface PluginConfigSpec {
  type: "string" | "number" | "boolean";
  description?: string;
  default?: string | number | boolean;
  required?: boolean;
}

/** The `plugin.json` manifest (mirrored by the module's `manifest` export). */
export interface PluginManifest {
  /** `^[a-z][a-z0-9_-]{0,31}$` — also the directory/tool-namespace name. */
  id: string;
  name: string;
  /** Free-form version string (`1.2.0`). */
  version: string;
  description: string;
  author?: string;
  license?: string;
  /** The highest risk any contributed tool may declare. Defaults to READ. */
  maxRisk?: RiskLevel;
  /** Capability labels the plugin advertises (display only). */
  capabilities?: string[];
  /** Config keys with types/defaults; values live in the plugin record. */
  config?: Record<string, PluginConfigSpec>;
}

/** One tool a plugin module contributes (before namespacing). */
export interface PluginToolContribution {
  /** Local name (`upper` → `plugin.<id>.upper`). Same id rules as the plugin. */
  id: string;
  name: string;
  description: string;
  risk: RiskLevel;
  validate(input: unknown): { ok: true; value: unknown } | { ok: false; reason: string };
  execute(input: unknown): unknown | Promise<unknown>;
}

/** The module shape `plugin.mjs` must export. */
export interface PluginModule {
  manifest: PluginManifest;
  tools?: PluginToolContribution[];
}

export type PluginStatus = "enabled" | "disabled";

/** A defined plugin: its manifest, lifecycle state, config values, provenance. */
export interface PluginRecord {
  manifest: PluginManifest;
  status: PluginStatus;
  /** Config values by key (defaults applied at define time). */
  config: Record<string, string | number | boolean>;
  /** Where it was defined from: `dir:<path>` or `test:<label>`. */
  source: string;
  installedAt: string;
  updatedAt: string;
  /** The registry tool ids it contributed. */
  toolIds: string[];
}

export type PluginErrorCode =
  | "INVALID"
  | "NOT_FOUND"
  | "ALREADY_EXISTS"
  | "RISK_EXCEEDED"
  | "LOAD_FAILED";

export interface PluginError {
  code: PluginErrorCode;
  message: string;
}

export type PluginResult<T> = { ok: true; value: T } | { ok: false; error: PluginError };
