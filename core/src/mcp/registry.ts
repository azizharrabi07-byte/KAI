// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * KAI MCP server registry (Part Q).
 *
 * Owns the set of MCP servers KAI knows about: parsing them, validating them,
 * storing their secrets, and — critically — keeping them DISABLED until a human
 * explicitly enables them. An MCP server is third-party code that KAI would run
 * with KAI's own authority, so the safe default is the only acceptable default:
 * a freshly registered server does nothing until `enable()` is called.
 *
 * ── Secrets are write-only ───────────────────────────────────────────────────
 * `env` values and `headers` values are credentials (an API key a server needs,
 * an Authorization header). They are stored because the launcher needs them, and
 * they are exposed through exactly two surfaces:
 *
 *   `list()`          → listings, which carry key NAMES only (see types.ts).
 *   `credentialsFor()` → the actual values, for the one caller that launches
 *                        the server. Named so it is obvious it is privileged.
 *
 * Nothing else in this file reads a secret value, and no error message ever
 * interpolates one: a message that leaked a key into a log would defeat the
 * whole design.
 *
 * ── Errors are values ────────────────────────────────────────────────────────
 * `register`/`update`/`loadConfig` never throw on bad input; they return
 * `{ok:false, error}` and leave the registry untouched. `loadConfig` is the
 * strictest case: a malformed entry anywhere in a config file is reported as a
 * rejected entry and skipped, never a crash and never a partial install of that
 * entry.
 */

import { isNonEmptyString, isRecord } from "../shared/contracts.ts";
import { fail, ok, mcpError, type McpResult } from "./result.ts";
import type {
  McpRiskDeclaration,
  McpServerListing,
  McpServerRecord,
  RemoteMcpServer,
  SecretInput,
  StdioMcpServer,
  StoredMcpServer,
} from "./types.ts";
import {
  looksRemote,
  parseTransport,
  resolveSecret,
  tooManyEntries,
  validateEnvName,
  validateHeader,
  validateRiskDeclaration,
  validateSecretValue,
  validateServerName,
  validateUrl,
} from "./validation.ts";
import {
  defaultSecretResolver,
  inspectStoredSecret,
  parseSecretReference,
  resolveStoredSecret,
  type ReferenceStatus,
  type SecretResolver,
} from "./secrets.ts";

const STDIO_KEYS = new Set(["command", "args", "env", "risk", "enabled"]);
const REMOTE_KEYS = new Set(["transport", "type", "url", "headers", "risk", "enabled"]);

/** Which way an incoming entry is being parsed; it decides how secrets resolve. */
export type ParseMode = "create" | "update";

function unknownKeys(raw: Record<string, unknown>, allowed: ReadonlySet<string>): string | undefined {
  return Object.keys(raw).find((key) => !allowed.has(key));
}

function parseStdio(
  name: string,
  raw: Record<string, unknown>,
  existing: StoredMcpServer | undefined,
  mode: ParseMode,
): McpResult<StdioMcpServer> {
  if (!isNonEmptyString(raw.command)) {
    return fail(mcpError("VALIDATION_FAILED", `MCP server "${name}" requires a non-empty command`, () => new Date()));
  }
  const extra = unknownKeys(raw, STDIO_KEYS);
  if (extra !== undefined) {
    return fail(mcpError("VALIDATION_FAILED", `MCP server "${name}" has an unknown key "${extra}"`, () => new Date()));
  }

  const args: string[] = [];
  if (raw.args !== undefined) {
    if (!Array.isArray(raw.args)) {
      return fail(mcpError("VALIDATION_FAILED", `MCP server "${name}" args must be an array of strings`, () => new Date()));
    }
    for (const arg of raw.args) {
      if (typeof arg !== "string") {
        return fail(mcpError("VALIDATION_FAILED", `MCP server "${name}" args must all be strings`, () => new Date()));
      }
      args.push(arg);
    }
    if (args.length > 256) {
      return fail(mcpError("VALIDATION_FAILED", `MCP server "${name}" has too many args`, () => new Date()));
    }
  }

  // Secrets are resolved key by key against what was saved. On create there is
  // no saved state, so `true` is always an error; on update it keeps the value.
  const savedEnv = existing !== undefined && existing.transport === "stdio" ? existing.env : undefined;
  const env: Record<string, string> = {};
  if (raw.env !== undefined) {
    if (!isRecord(raw.env)) {
      return fail(mcpError("VALIDATION_FAILED", `MCP server "${name}" env must be an object`, () => new Date()));
    }
    const count = tooManyEntries(raw.env, "environment variables");
    if (!count.ok) return count;
    for (const [key, value] of Object.entries(raw.env)) {
      const nameOk = validateEnvName(key);
      if (!nameOk.ok) return nameOk;
      // `true` on create with no saved value is refused; on update it keeps.
      const resolved = resolveSecret(key, value as SecretInput, mode === "update" ? savedEnv?.[key] : undefined);
      if (!resolved.ok) return resolved;
      const valueOk = validateSecretValue(key, resolved.value);
      if (!valueOk.ok) return valueOk;
      env[key] = resolved.value;
    }
  }

  const risk = parseRisk(raw.risk);
  if (!risk.ok) return risk;

  const server: StdioMcpServer = { transport: "stdio", command: raw.command, args, env };
  if (risk.value !== undefined) server.risk = risk.value;
  return ok(server);
}

function parseRemote(
  name: string,
  raw: Record<string, unknown>,
  existing: StoredMcpServer | undefined,
  mode: ParseMode,
): McpResult<RemoteMcpServer> {
  if (!isNonEmptyString(raw.url)) {
    return fail(mcpError("VALIDATION_FAILED", `MCP server "${name}" requires a non-empty url`, () => new Date()));
  }
  const extra = unknownKeys(raw, REMOTE_KEYS);
  if (extra !== undefined) {
    return fail(mcpError("VALIDATION_FAILED", `MCP server "${name}" has an unknown key "${extra}"`, () => new Date()));
  }
  const transport = parseTransport(raw.transport ?? raw.type, "http");
  if (!transport.ok) return transport;
  const url = validateUrl(raw.url);
  if (!url.ok) return url;

  const savedHeaders =
    existing !== undefined && existing.transport !== "stdio" ? existing.headers : undefined;
  const headers: Record<string, string> = {};
  if (raw.headers !== undefined) {
    if (!isRecord(raw.headers)) {
      return fail(mcpError("VALIDATION_FAILED", `MCP server "${name}" headers must be an object`, () => new Date()));
    }
    const count = tooManyEntries(raw.headers, "headers");
    if (!count.ok) return count;
    for (const [key, value] of Object.entries(raw.headers)) {
      const resolved = resolveSecret(key, value as SecretInput, mode === "update" ? savedHeaders?.[key] : undefined);
      if (!resolved.ok) return resolved;
      // Validate name and line-safety on the RESOLVED value: a saved value must
      // still be safe to send, and a new one can carry a newline past the name. 
      const lineOk = validateHeader(key, resolved.value);
      if (!lineOk.ok) return lineOk;
      const valueOk = validateSecretValue(key, resolved.value);
      if (!valueOk.ok) return valueOk;
      headers[key] = resolved.value;
    }
  }

  const risk = parseRisk(raw.risk);
  if (!risk.ok) return risk;

  const server: RemoteMcpServer = { transport: transport.value, url: url.value, headers };
  if (risk.value !== undefined) server.risk = risk.value;
  return ok(server);
}

/** Shared risk parse: `undefined` input is fine (no declaration) but invalid input is not. */
function parseRisk(raw: unknown): McpResult<McpRiskDeclaration | undefined> {
  if (raw === undefined || raw === null) return ok(undefined);
  const parsed = validateRiskDeclaration(raw);
  return parsed;
}

function parseEntry(
  name: string,
  raw: unknown,
  existing: StoredMcpServer | undefined,
  mode: ParseMode,
): McpResult<StoredMcpServer> {
  if (!isRecord(raw)) {
    return fail(mcpError("VALIDATION_FAILED", `MCP server "${name}" must be an object`, () => new Date()));
  }
  return looksRemote(raw) ? parseRemote(name, raw, existing, mode) : parseStdio(name, raw, existing, mode);
}

// ── Listing ──────────────────────────────────────────────────────────────────

/**
 * Build the only representation that leaves the registry. It is written by
 * copying key NAMES and never values, so there is no code path by which a
 * secret could reach a listing — including by a future edit that adds a field
 * carelessly, because the value is not in scope as a variable named like one.
 */
export function listServer(name: string, record: McpServerRecord): McpServerListing {
  const { server, enabled } = record;
  if (server.transport === "stdio") {
    return {
      name,
      transport: "stdio",
      command: server.command,
      args: [...server.args],
      envKeys: Object.keys(server.env).sort(),
      enabled,
      hasRisk: server.risk !== undefined,
    };
  }
  return {
    name,
    transport: server.transport,
    url: server.url,
    headerKeys: Object.keys(server.headers).sort(),
    enabled,
    hasRisk: server.risk !== undefined,
  };
}

// ── Registry ─────────────────────────────────────────────────────────────────

export interface McpRegistry {
  /** Create a NEW server. A name that already exists is refused, not overwritten. */
  register(name: unknown, raw: unknown): McpResult<McpServerListing>;
  /** Edit an existing server. Enabled state and untouched secrets are preserved. */
  update(name: string, raw: unknown): McpResult<McpServerListing>;
  remove(name: string): McpResult<{ name: string }>;
  enable(name: string): McpResult<McpServerListing>;
  disable(name: string): McpResult<McpServerListing>;
  get(name: string): McpServerRecord | undefined;
  list(): McpServerListing[];
  /** Servers a launcher may start: enabled only. */
  enabledNames(): string[];
  /**
   * The privileged read: actual secret values for the server's launcher. Named
   * deliberately so it is obvious this is the one call that resolves them.
   * Returns a defensive copy so a caller cannot mutate stored credentials.
   *
   * A stored value that is a REFERENCE (`env:`/`credman:`) is resolved here, at
   * launch time, against the live environment / Credential Manager; an
   * unresolvable reference is an `AGENT_AUTH_FAILED` value and NEVER a partial
   * or empty credential set — the launch must fail closed, not run unauthenticated.
   */
  credentialsFor(name: string): McpResult<{ env: Record<string, string> } | { headers: Record<string, string> }>;
  /**
   * Redacted credential requirement for one server: the key NAMES, whether each
   * is a literal or a reference, and its PRESENT/MISSING/UNREADABLE status.
   * Never carries a value. This is what a UI, a doc, or evidence may show.
   */
  credentialReport(name: string): McpResult<{
    keys: { key: string; kind: "literal" | "env" | "credman"; target: string | null; status: ReferenceStatus }[];
    required: boolean;
  }>;
  /** Parse a whole config map; malformed entries are reported, not thrown, not stored. */
  loadConfig(raw: unknown): { loaded: string[]; rejected: { name: string; error: string }[] };
}

export function createMcpRegistry(
  opts: { now?: () => Date; maxServers?: number; secretResolver?: SecretResolver } = {},
): McpRegistry {
  const now = opts.now ?? (() => new Date());
  const maxServers = opts.maxServers ?? 20;
  const resolver: SecretResolver = opts.secretResolver ?? defaultSecretResolver();
  const records = new Map<string, McpServerRecord>();

  function listing(name: string): McpServerListing {
    const record = records.get(name);
    if (record === undefined) throw new Error(`internal: listing "${name}" that is not stored`);
    return listServer(name, record);
  }

  function register(nameInput: unknown, raw: unknown): McpResult<McpServerListing> {
    const name = validateServerName(nameInput);
    if (!name.ok) return name;
    if (records.has(name.value)) {
      return fail(
        mcpError(
          "VALIDATION_FAILED",
          `MCP server "${name.value}" is already registered; update it instead of overwriting it`,
          now,
        ),
      );
    }
    if (records.size >= maxServers) {
      return fail(mcpError("VALIDATION_FAILED", `At most ${maxServers} MCP servers may be registered`, now));
    }
    const parsed = parseEntry(name.value, raw, undefined, "create");
    if (!parsed.ok) return parsed;
    // The safe default, enforced here and nowhere else: a new server is inert.
    // `raw.enabled` is deliberately ignored on create so a pasted config cannot
    // start a server on the same call that first defines it.
    records.set(name.value, { server: parsed.value, enabled: false });
    return ok(listing(name.value));
  }

  function update(nameInput: string, raw: unknown): McpResult<McpServerListing> {
    const name = validateServerName(nameInput);
    if (!name.ok) return name;
    const existing = records.get(name.value);
    if (existing === undefined) {
      return fail(mcpError("NOT_FOUND", `no MCP server named "${name.value}" is registered`, now));
    }
    // Enabled state is preserved on update: a user cannot flip a server on by
    // editing it, only by the explicit enable() call.
    const parsed = parseEntry(name.value, raw, existing.server, "update");
    if (!parsed.ok) return parsed;
    records.set(name.value, { server: parsed.value, enabled: existing.enabled });
    return ok(listing(name.value));
  }

  function remove(nameInput: string): McpResult<{ name: string }> {
    const name = validateServerName(nameInput);
    if (!name.ok) return name;
    if (!records.delete(name.value)) {
      return fail(mcpError("NOT_FOUND", `no MCP server named "${name.value}" is registered`, now));
    }
    return ok({ name: name.value });
  }

  function setEnabled(nameInput: string, enabled: boolean): McpResult<McpServerListing> {
    const name = validateServerName(nameInput);
    if (!name.ok) return name;
    const existing = records.get(name.value);
    if (existing === undefined) {
      return fail(mcpError("NOT_FOUND", `no MCP server named "${name.value}" is registered`, now));
    }
    records.set(name.value, { server: existing.server, enabled });
    return ok(listing(name.value));
  }

  function list(): McpServerListing[] {
    return [...records.entries()].map(([name, record]) => listServer(name, record));
  }

  function enabledNames(): string[] {
    return [...records.entries()].filter(([, record]) => record.enabled).map(([name]) => name);
  }

  /**
   * Resolve every stored secret for a server. A literal is returned as-is; a
   * reference is resolved now, against the live environment / Credential
   * Manager. The FIRST unresolvable key refuses the whole read: partially
   * resolving a credential set would let a server launch without the credential
   * it needs, which is worse than refusing to launch it at all.
   */
  function resolveAll(
    name: string,
    stored: Record<string, string>,
    what: "environment variables" | "headers",
  ): McpResult<Record<string, string>> {
    const resolved: Record<string, string> = {};
    for (const [key, value] of Object.entries(stored)) {
      const outcome = resolveStoredSecret(value, resolver);
      if (!outcome.ok) {
        return fail(
          mcpError(
            "AGENT_AUTH_FAILED",
            `MCP server "${name}" cannot launch: ${what} credential "${key}" is unavailable — ${outcome.reason}`,
            now,
          ),
        );
      }
      resolved[key] = outcome.value;
    }
    return ok(resolved);
  }

  function credentialsFor(
    nameInput: string,
  ): McpResult<{ env: Record<string, string> } | { headers: Record<string, string> }> {
    const name = validateServerName(nameInput);
    if (!name.ok) return name;
    const record = records.get(name.value);
    if (record === undefined) {
      return fail(mcpError("NOT_FOUND", `no MCP server named "${name.value}" is registered`, now));
    }
    if (record.server.transport === "stdio") {
      const resolved = resolveAll(name.value, record.server.env, "environment variables");
      return resolved.ok ? ok({ env: resolved.value }) : resolved;
    }
    const resolved = resolveAll(name.value, record.server.headers, "headers");
    return resolved.ok ? ok({ headers: resolved.value }) : resolved;
  }

  function credentialReport(nameInput: string): McpResult<{
    keys: { key: string; kind: "literal" | "env" | "credman"; target: string | null; status: ReferenceStatus }[];
    required: boolean;
  }> {
    const name = validateServerName(nameInput);
    if (!name.ok) return name;
    const record = records.get(name.value);
    if (record === undefined) {
      return fail(mcpError("NOT_FOUND", `no MCP server named "${name.value}" is registered`, now));
    }
    const stored = record.server.transport === "stdio" ? record.server.env : record.server.headers;
    const keys = Object.entries(stored)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => {
        const reference = parseSecretReference(value);
        return {
          key,
          kind: reference.kind,
          target: reference.kind === "literal" ? null : (reference.name as string),
          status: inspectStoredSecret(value, resolver),
        };
      });
    return ok({ keys, required: keys.length > 0 });
  }

  function loadConfig(raw: unknown): { loaded: string[]; rejected: { name: string; error: string }[] } {
    const loaded: string[] = [];
    const rejected: { name: string; error: string }[] = [];
    if (!isRecord(raw)) {
      return { loaded, rejected: [{ name: "", error: "config must be an object" }] };
    }
    for (const [name, entry] of Object.entries(raw)) {
      const nameOk = validateServerName(name);
      if (!nameOk.ok) {
        rejected.push({ name, error: nameOk.error.message });
        continue;
      }
      const parsed = parseEntry(name, entry, undefined, "create");
      if (!parsed.ok) {
        rejected.push({ name, error: parsed.error.message });
        continue;
      }
      // Loading from a config file is the one place `enabled` is honoured, and
      // only when it is literally `true`; anything else is off.
      const enabled = isRecord(entry) && entry.enabled === true;
      records.set(name, { server: parsed.value, enabled });
      loaded.push(name);
    }
    return { loaded, rejected };
  }

  return {
    register,
    update,
    remove,
    enable: (name) => setEnabled(name, true),
    disable: (name) => setEnabled(name, false),
    get: (name) => records.get(name),
    list,
    enabledNames,
    credentialsFor,
    credentialReport,
    loadConfig,
  };
}
