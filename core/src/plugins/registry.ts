// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The plugin registry — lifecycle + config + the ONE tool plane.
 *
 * `define()` imports the plugin module (the explicit trust decision),
 * validates the manifest AND every contributed tool, checks each tool against
 * the manifest's risk ceiling, persists the record, and registers wrapped
 * definitions on the shared `ToolRegistry`. The wrapper does two things the
 * raw contribution cannot: it refuses while the plugin is DISABLED (lifecycle
 * without registry removal — the registry has no unregister, by design), and
 * it injects the plugin's current config into the call.
 *
 * Everything else — validation order, policy, approvals, the action record —
 * is the registry's, untouched. A plugin tool that throws is a FAILED tool,
 * exactly like a builtin.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isRecord } from "../shared/contracts.ts";
import type { RiskLevel } from "../shared/contracts.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import { safeJoin } from "../skills/paths.ts";
import {
  RISK_ORDER,
  type PluginError,
  type PluginManifest,
  type PluginModule,
  type PluginRecord,
  type PluginResult,
  type PluginToolContribution,
} from "./types.ts";

export interface PluginRegistryOptions {
  /** Directory holding `plugins.json` + one subdir per plugin. */
  root: string;
  tools: ToolRegistry;
  now?: () => Date;
}

export interface PluginRegistry {
  /** Import + validate + persist + register. The trust decision, made explicit. */
  define(input: { id?: string; dir?: string; module?: PluginModule; source?: string }): Promise<PluginResult<PluginRecord>>;
  get(id: string): PluginRecord | null;
  list(): PluginRecord[];
  enable(id: string): PluginResult<PluginRecord>;
  disable(id: string): PluginResult<PluginRecord>;
  remove(id: string): PluginResult<{ id: string }>;
  /** Set one config value (type-checked against the manifest spec). */
  setConfig(id: string, key: string, value: unknown): PluginResult<PluginRecord>;
}

const PLUGIN_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const TOOL_ID_RE = /^[a-z][A-Za-z0-9_-]{0,63}$/;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

function fail(code: PluginError["code"], message: string): PluginResult<never> {
  return { ok: false, error: { code, message } };
}

function riskAllows(ceiling: RiskLevel, risk: RiskLevel): boolean {
  return RISK_ORDER.indexOf(risk) <= RISK_ORDER.indexOf(ceiling);
}

function validateManifest(raw: unknown): { ok: true; value: PluginManifest } | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: "manifest must be an object" };
  const id = raw["id"];
  if (typeof id !== "string" || !PLUGIN_ID_RE.test(id)) {
    return { ok: false, error: `manifest.id must match ${PLUGIN_ID_RE}` };
  }
  for (const key of ["name", "description"] as const) {
    const value = raw[key];
    if (typeof value !== "string" || value.trim().length === 0 || value.length > 256) {
      return { ok: false, error: `manifest.${key} must be a non-empty string (<=256 chars)` };
    }
  }
  const version = raw["version"];
  if (typeof version !== "string" || !VERSION_RE.test(version)) {
    return { ok: false, error: "manifest.version must be a non-empty version string" };
  }
  const maxRisk = raw["maxRisk"] ?? "READ";
  if (typeof maxRisk !== "string" || !(RISK_ORDER as readonly string[]).includes(maxRisk)) {
    return { ok: false, error: `manifest.maxRisk must be one of ${RISK_ORDER.join(", ")}` };
  }
  for (const key of ["author", "license"] as const) {
    const value = raw[key];
    if (value !== undefined && (typeof value !== "string" || value.length > 256)) {
      return { ok: false, error: `manifest.${key} must be a string (<=256 chars) when present` };
    }
  }
  const capabilities = raw["capabilities"];
  if (capabilities !== undefined) {
    if (!Array.isArray(capabilities) || capabilities.some((c) => typeof c !== "string" || c.length > 64)) {
      return { ok: false, error: "manifest.capabilities must be an array of short strings when present" };
    }
  }
  const config = raw["config"];
  if (config !== undefined) {
    if (!isRecord(config)) return { ok: false, error: "manifest.config must be an object when present" };
    for (const [key, spec] of Object.entries(config)) {
      if (!isRecord(spec) || (spec["type"] !== "string" && spec["type"] !== "number" && spec["type"] !== "boolean")) {
        return { ok: false, error: `config "${key}" must declare type string|number|boolean` };
      }
      if (spec["default"] !== undefined && typeof spec["default"] !== spec["type"]) {
        return { ok: false, error: `config "${key}" default must match its declared type` };
      }
    }
  }
  return { ok: true, value: raw as unknown as PluginManifest };
}

function validateTool(raw: unknown): { ok: true; value: PluginToolContribution } | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: "tool must be an object" };
  const id = raw["id"];
  if (typeof id !== "string" || !TOOL_ID_RE.test(id)) {
    return { ok: false, error: `tool.id must match ${TOOL_ID_RE}` };
  }
  for (const key of ["name", "description"] as const) {
    const value = raw[key];
    if (typeof value !== "string" || value.trim().length === 0 || value.length > 256) {
      return { ok: false, error: `tool.${key} must be a non-empty string (<=256 chars)` };
    }
  }
  const risk = raw["risk"];
  if (typeof risk !== "string" || !(RISK_ORDER as readonly string[]).includes(risk)) {
    return { ok: false, error: `tool.risk must be one of ${RISK_ORDER.join(", ")}` };
  }
  if (typeof raw["validate"] !== "function" || typeof raw["execute"] !== "function") {
    return { ok: false, error: `tool "${id}" must export validate() and execute()` };
  }
  return { ok: true, value: raw as unknown as PluginToolContribution };
}

export function pluginToolId(pluginId: string, toolId: string): string {
  return `plugin.${pluginId}.${toolId}`;
}

export function createPluginRegistry(options: PluginRegistryOptions): PluginRegistry {
  const { root, tools } = options;
  const now = options.now ?? (() => new Date());
  const records = new Map<string, PluginRecord>();
  // A `:`-prefixed root (like the `:memory:` convention) is ephemeral: no
  // catalogue file is read or written, and define() still works in-process.
  const persistent = !root.startsWith(":");

  const filePath = join(root, "plugins.json");

  function persist(): void {
    if (!persistent) return;
    mkdirSync(root, { recursive: true });
    const tmp = `${filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, plugins: [...records.values()] }, null, 2), "utf8");
    renameSync(tmp, filePath);
  }

  function rehydrate(): void {
    if (!persistent) return;
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    } catch {
      return;
    }
    if (!isRecord(parsed) || !Array.isArray(parsed["plugins"])) return;
    for (const entry of parsed["plugins"]) {
      if (!isRecord(entry) || !isRecord(entry["manifest"])) continue;
      const manifest = validateManifest(entry["manifest"]);
      if (!manifest.ok) continue;
      const record = entry as unknown as PluginRecord;
      records.set(manifest.value.id, {
        ...record,
        manifest: manifest.value,
        status: record.status === "disabled" ? "disabled" : "enabled",
      });
    }
  }

  rehydrate();

  function isEnabled(id: string): boolean {
    return records.get(id)?.status === "enabled";
  }

  async function loadModule(input: { dir?: string; module?: PluginModule }): Promise<{ ok: true; value: PluginModule; source: string } | { ok: false; error: string }> {
    if (input.module !== undefined) {
      return { ok: true, value: input.module, source: "test:inline" };
    }
    if (input.dir === undefined) return { ok: false, error: "define needs dir or module" };
    let resolved: string;
    try {
      resolved = safeJoin(root, input.dir);
    } catch {
      return { ok: false, error: `plugin dir "${input.dir}" escapes the plugins root` };
    }
    try {
      const imported = (await import(pathToFileURL(join(resolved, "plugin.mjs")).href)) as Record<string, unknown>;
      const manifest = imported["manifest"];
      const tools = imported["tools"] ?? [];
      if (!isRecord(manifest)) return { ok: false, error: "plugin.mjs must export a manifest object" };
      if (!Array.isArray(tools)) return { ok: false, error: "plugin.mjs tools export must be an array" };
      return { ok: true, value: { manifest: manifest as unknown as PluginManifest, tools: tools as PluginToolContribution[] }, source: `dir:${resolved}` };
    } catch (error) {
      return { ok: false, error: `plugin module failed to load: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async function define(input: { id?: string; dir?: string; module?: PluginModule; source?: string }): Promise<PluginResult<PluginRecord>> {
    const loaded = await loadModule(input);
    if (!loaded.ok) return fail("LOAD_FAILED", loaded.error);
    const checked = validateManifest(loaded.value.manifest);
    if (!checked.ok) return fail("INVALID", checked.error);
    const manifest = checked.value;
    if (input.id !== undefined && input.id !== manifest.id) {
      return fail("INVALID", `manifest id "${manifest.id}" does not match requested "${input.id}"`);
    }
    if (records.has(manifest.id)) {
      return fail("ALREADY_EXISTS", `plugin "${manifest.id}" is already defined; remove it first`);
    }
    const ceiling = manifest.maxRisk ?? "READ";
    const contributions = loaded.value.tools ?? [];
    const seen = new Set<string>();
    for (const raw of contributions) {
      const tool = validateTool(raw);
      if (!tool.ok) return fail("INVALID", tool.error);
      if (seen.has(tool.value.id)) return fail("INVALID", `duplicate tool id "${tool.value.id}" in plugin "${manifest.id}"`);
      seen.add(tool.value.id);
      if (!riskAllows(ceiling, tool.value.risk)) {
        return fail("RISK_EXCEEDED", `tool "${tool.value.id}" declares ${tool.value.risk} above the plugin ceiling ${ceiling}`);
      }
    }

    const at = now().toISOString();
    const config: Record<string, string | number | boolean> = {};
    for (const [key, spec] of Object.entries(manifest.config ?? {})) {
      if (spec.default !== undefined) config[key] = spec.default;
      else if (spec.required === true) return fail("INVALID", `config "${key}" is required but has no value; set it after define`);
    }

    const record: PluginRecord = {
      manifest,
      status: "enabled",
      config,
      source: input.source ?? loaded.source,
      installedAt: at,
      updatedAt: at,
      toolIds: contributions.map((tool) => pluginToolId(manifest.id, (tool as PluginToolContribution).id)),
    };

    // Register on the ONE plane, wrapped: the wrapper enforces the lifecycle
    // (disabled plugins refuse without touching the registry) and injects the
    // live config. Policy, approvals and records stay the registry's.
    for (const raw of contributions) {
      const contribution = raw as PluginToolContribution;
      const namespaced = pluginToolId(manifest.id, contribution.id);
      try {
        tools.register({
          id: namespaced,
          name: contribution.name,
          description: `${contribution.description} (plugin ${manifest.id} v${manifest.version})`,
          risk: contribution.risk,
          validate: (value) => {
            if (!isEnabled(manifest.id)) return { ok: false, reason: `plugin "${manifest.id}" is disabled` };
            try {
              return contribution.validate(value);
            } catch (error) {
              return { ok: false, reason: `plugin validator threw: ${error instanceof Error ? error.message : String(error)}` };
            }
          },
          execute: async (value) => {
            if (!isEnabled(manifest.id)) throw new Error(`plugin "${manifest.id}" is disabled`);
            const live = records.get(manifest.id);
            const injected = { ...(isRecord(value) ? value : {}), $plugin: { id: manifest.id, config: live?.config ?? {} } };
            return contribution.execute(isRecord(value) ? injected : value);
          },
        });
      } catch (error) {
        return fail("ALREADY_EXISTS", `tool id collision on "${namespaced}": ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    records.set(manifest.id, record);
    try {
      persist();
    } catch (error) {
      return fail("INVALID", `plugin defined but the catalogue could not persist: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { ok: true, value: record };
  }

  function get(id: string): PluginRecord | null {
    return records.get(id) ?? null;
  }

  function list(): PluginRecord[] {
    return [...records.values()].sort((a, b) => (a.manifest.id < b.manifest.id ? -1 : 1));
  }

  function touch(record: PluginRecord): PluginRecord {
    const next = { ...record, updatedAt: now().toISOString() };
    records.set(record.manifest.id, next);
    persist();
    return next;
  }

  function enable(id: string): PluginResult<PluginRecord> {
    const record = records.get(id);
    if (record === undefined) return fail("NOT_FOUND", `no plugin "${id}" is defined`);
    return { ok: true, value: touch({ ...record, status: "enabled" }) };
  }

  function disable(id: string): PluginResult<PluginRecord> {
    const record = records.get(id);
    if (record === undefined) return fail("NOT_FOUND", `no plugin "${id}" is defined`);
    return { ok: true, value: touch({ ...record, status: "disabled" }) };
  }

  function remove(id: string): PluginResult<{ id: string }> {
    if (!records.has(id)) return fail("NOT_FOUND", `no plugin "${id}" is defined`);
    // Tools stay registered (the registry has no unregister, by design) but
    // their wrapper refuses: a removed plugin's record is gone, so isEnabled
    // is false and every call is refused at validation. The catalogue forgets it.
    records.delete(id);
    persist();
    return { ok: true, value: { id } };
  }

  function setConfig(id: string, key: string, value: unknown): PluginResult<PluginRecord> {
    const record = records.get(id);
    if (record === undefined) return fail("NOT_FOUND", `no plugin "${id}" is defined`);
    const spec = record.manifest.config?.[key];
    if (spec === undefined) return fail("INVALID", `plugin "${id}" declares no config key "${key}"`);
    if (typeof value !== spec.type) {
      return fail("INVALID", `config "${key}" must be a ${spec.type}`);
    }
    return { ok: true, value: touch({ ...record, config: { ...record.config, [key]: value as string | number | boolean } }) };
  }

  return { define, get, list, enable, disable, remove, setConfig };
}
