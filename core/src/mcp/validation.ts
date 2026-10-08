// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * MCP validation — the "nothing half-registered" layer.
 *
 * Every value that enters the MCP module is validated here first and refused as
 * a *value* (McpResult) rather than by throwing. That choice is the whole point:
 * a malformed server entry, or a tool definition a third-party server sent,
 * must leave the registry exactly as it was. Nothing here mutates shared state;
 * these are pure predicates and parsers, so a caller that gets `{ok:false}`
 * knows nothing was stored.
 *
 * The reserved-name and pattern rules exist so an MCP server cannot be handed a
 * name that collides with something KAI owns. MCP tool ids are namespaced with
 * an `mcp.` prefix downstream, but a server name like `system` would still be a
 * confusing, shadowy thing to display, so it is refused at the door.
 */

import { isNonEmptyString, isRecord, type RiskLevel } from "../shared/contracts.ts";
import { fail, ok, mcpError, type McpResult } from "./result.ts";
import { parseSecretReference, CREDMAN_PREFIX, ENV_PREFIX } from "./secrets.ts";
import type {
  McpDiscoveredTool,
  McpRiskDeclaration,
  SecretInput,
} from "./types.ts";

/** The four risk levels, duplicated here because the policy gate does not export its guard. */
const RISK_LEVELS: readonly RiskLevel[] = ["READ", "WRITE", "EXTERNAL", "DESTRUCTIVE"];

export function isRiskLevel(value: unknown): value is RiskLevel {
  return typeof value === "string" && (RISK_LEVELS as readonly string[]).includes(value);
}

// ── Names ────────────────────────────────────────────────────────────────────

/** Lowercase, starts with a letter, 1–32 chars: the shape every MCP client writes. */
const SERVER_NAME = /^[a-z][a-z0-9_-]{0,31}$/;

/**
 * Names KAI owns. A third-party server must never take one: even with the
 * `mcp.` tool-id namespace, `system` as a *server* name reads as if it were
 * KAI's own and invites exactly the confusion the boundary exists to prevent.
 */
const RESERVED_SERVER_NAMES: ReadonlySet<string> = new Set([
  "kai",
  "core",
  "system",
  "agents",
  "missions",
  "memory",
  "policy",
  "approval",
  "approvals",
  "tools",
  "tool",
  "internal",
  "mcp",
]);

export function validateServerName(name: unknown): McpResult<string> {
  if (!isNonEmptyString(name)) {
    return fail(
      mcpError("VALIDATION_FAILED", "MCP server name must be a non-empty string", () => new Date()),
    );
  }
  if (!SERVER_NAME.test(name)) {
    return fail(
      mcpError(
        "VALIDATION_FAILED",
        `MCP server name "${name}" is invalid: use 1–32 lowercase letters, digits, "_" or "-", starting with a letter`,
        () => new Date(),
      ),
    );
  }
  if (RESERVED_SERVER_NAMES.has(name)) {
    return fail(
      mcpError(
        "VALIDATION_FAILED",
        `MCP server name "${name}" is reserved by KAI and cannot be used`,
        () => new Date(),
      ),
    );
  }
  return ok(name);
}

/**
 * A tool name that is safe to carry: printable, no control characters (a name
 * with a newline would corrupt a log line and any line-oriented display), and
 * bounded in length. MCP itself is broad about tool names; KAI narrows them.
 */
const TOOL_NAME = /^[^\x00-\x1f\x7f]{1,128}$/;

export function validateToolName(name: unknown): McpResult<string> {
  if (!isNonEmptyString(name)) {
    return fail(
      mcpError("VALIDATION_FAILED", "MCP tool name must be a non-empty string", () => new Date()),
    );
  }
  if (!TOOL_NAME.test(name)) {
    return fail(
      mcpError(
        "VALIDATION_FAILED",
        `MCP tool name is not usable: it must be 1–128 printable characters with no control characters or newlines`,
        () => new Date(),
      ),
    );
  }
  return ok(name);
}

// ── Risk declaration ─────────────────────────────────────────────────────────

/**
 * Parse a risk declaration. An unrecognized level is a refusal, not a
 * coercion: silently mapping a typo to READ would be the precise hole this
 * module exists to close. Extra keys are ignored rather than rejected — a
 * declaration is KAI-authored, and being strict there buys nothing.
 */
export function validateRiskDeclaration(raw: unknown): McpResult<McpRiskDeclaration> {
  if (raw === undefined || raw === null) return ok({});
  if (!isRecord(raw)) {
    return fail(mcpError("VALIDATION_FAILED", "MCP risk declaration must be an object", () => new Date()));
  }
  const declaration: McpRiskDeclaration = {};
  if (raw.default !== undefined) {
    if (!isRiskLevel(raw.default)) {
      return fail(
        mcpError(
          "VALIDATION_FAILED",
          `MCP risk declaration has an unrecognized default risk ${JSON.stringify(raw.default)}`,
          () => new Date(),
        ),
      );
    }
    declaration.default = raw.default;
  }
  if (raw.tools !== undefined) {
    if (!isRecord(raw.tools)) {
      return fail(
        mcpError("VALIDATION_FAILED", "MCP risk declaration `tools` must be an object", () => new Date()),
      );
    }
    const tools: Record<string, RiskLevel> = {};
    for (const [toolName, risk] of Object.entries(raw.tools)) {
      if (!isNonEmptyString(toolName) || !isRiskLevel(risk)) {
        return fail(
          mcpError(
            "VALIDATION_FAILED",
            `MCP risk declaration for tool "${toolName}" is not one of READ/WRITE/EXTERNAL/DESTRUCTIVE`,
            () => new Date(),
          ),
        );
      }
      tools[toolName] = risk;
    }
    if (Object.keys(tools).length > 0) declaration.tools = tools;
  }
  return ok(declaration);
}

// ── Discovered tool ──────────────────────────────────────────────────────────

/**
 * Validate one `tools/list` entry. The schema is deliberately permissive about
 * `inputSchema`/`annotations` (any JSON is kept as `unknown`, normalised later
 * before it reaches a provider) but strict about identity: a tool without a
 * usable name cannot be turned into a tool id, so it is refused here rather
 * than producing a half-formed registration.
 */
export function validateDiscoveredTool(raw: unknown): McpResult<McpDiscoveredTool> {
  if (!isRecord(raw)) {
    return fail(mcpError("VALIDATION_FAILED", "MCP tool definition must be an object", () => new Date()));
  }
  const name = validateToolName(raw.name);
  if (!name.ok) return name;

  const tool: McpDiscoveredTool = { name: name.value };
  if (raw.description !== undefined) {
    if (typeof raw.description !== "string") {
      return fail(
        mcpError("VALIDATION_FAILED", `MCP tool "${name.value}" has a non-string description`, () => new Date()),
      );
    }
    tool.description = raw.description;
  }
  // Kept as-is; normalisation happens in tool-schema.ts, never trust it here.
  if (raw.inputSchema !== undefined) tool.inputSchema = raw.inputSchema;
  // Carried only for display. NEVER consulted for risk (see types.ts).
  if (raw.annotations !== undefined) tool.annotations = raw.annotations;
  return ok(tool);
}

// ── Server entries ───────────────────────────────────────────────────────────

/** Is this raw entry meant to be remote? `url`/`transport` decides, as in every MCP client. */
export function looksRemote(raw: unknown): boolean {
  if (!isRecord(raw)) return false;
  return "url" in raw || raw.transport === "http" || raw.transport === "sse" || raw.type === "http" || raw.type === "sse";
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** RFC 9110 token characters. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;

const MAX_ITEMS = 64;

export function validateEnvName(name: string): McpResult<string> {
  if (!ENV_NAME.test(name)) {
    return fail(mcpError("VALIDATION_FAILED", `Environment variable "${name}" is not a valid name`, () => new Date()));
  }
  // A server must not be able to set variables that redirect KAI's own runtime.
  if (name === "ELECTRON_RUN_AS_NODE" || name.startsWith("KAI_")) {
    return fail(mcpError("VALIDATION_FAILED", `Environment variable "${name}" is reserved by KAI`, () => new Date()));
  }
  return ok(name);
}

export function validateHeader(name: string, value: string): McpResult<string> {
  if (!HEADER_NAME.test(name)) {
    return fail(mcpError("VALIDATION_FAILED", `Header "${name}" is not a valid HTTP header name`, () => new Date()));
  }
  if (/[\r\n]/.test(value)) {
    return fail(mcpError("VALIDATION_FAILED", `Header "${name}" must be a single line`, () => new Date()));
  }
  return ok(name);
}

/** A remote address must be a full http(s) URL with no embedded credentials. */
export function validateUrl(value: string): McpResult<string> {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return fail(mcpError("VALIDATION_FAILED", "Use a full address like https://example.com/mcp", () => new Date()));
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return fail(mcpError("VALIDATION_FAILED", "The address must start with http:// or https://", () => new Date()));
  }
  if (parsed.username || parsed.password) {
    return fail(
      mcpError("VALIDATION_FAILED", "Put credentials in a header, not in the address", () => new Date()),
    );
  }
  return ok(value);
}

export function parseTransport(raw: unknown, fallback: "http" | "sse"): McpResult<"http" | "sse"> {
  if (raw === undefined || raw === null) return ok(fallback);
  if (raw === "http" || raw === "sse") return ok(raw);
  return fail(
    mcpError("VALIDATION_FAILED", `MCP transport must be "http" or "sse", received ${JSON.stringify(raw)}`, () => new Date()),
  );
}

/**
 * Validate one RESOLVED secret string.
 *
 * A plain string is a literal and is accepted unchanged (existing catalogues
 * keep working). A string that begins with a reserved reference prefix must be
 * a well-formed reference — `env:` with no name, or a reference name carrying a
 * newline, is refused here rather than stored as a literal that would never
 * resolve and would fail much later, at launch, as an unexplained empty value.
 * The value is never returned in the error, only the key name.
 */
export function validateSecretValue(key: string, value: string): McpResult<string> {
  if (value.startsWith(ENV_PREFIX) || value.startsWith(CREDMAN_PREFIX)) {
    const reference = parseSecretReference(value);
    if (reference.kind === "literal") {
      return fail(
        mcpError(
          "VALIDATION_FAILED",
          `Secret "${key}" looks like a reference but is malformed: use "env:NAME" or "credman:TARGET" with a non-empty name`,
          () => new Date(),
        ),
      );
    }
  }
  return ok(value);
}

/**
 * Resolve one secret input against what is already saved.
 *
 * A string is a new value. `true` keeps the saved value — and is refused when
 * there is nothing saved, because storing the literal `true` as a credential is
 * always wrong and would fail later in a way that is far harder to diagnose.
 */
export function resolveSecret(
  key: string,
  incoming: SecretInput,
  saved: string | undefined,
): McpResult<string> {
  if (incoming === true) {
    if (saved === undefined) {
      return fail(
        mcpError("VALIDATION_FAILED", `No saved value exists for secret "${key}"`, () => new Date()),
      );
    }
    return ok(saved);
  }
  if (typeof incoming !== "string") {
    return fail(mcpError("VALIDATION_FAILED", `Secret "${key}" must be a string or a keep-placeholder`, () => new Date()));
  }
  return ok(incoming);
}

/** Cap the count of a record before iterating, so a hostile config cannot wedge us. */
export function tooManyEntries(record: Record<string, unknown>, label: string): McpResult<void> {
  if (Object.keys(record).length > MAX_ITEMS) {
    return fail(mcpError("VALIDATION_FAILED", `Use at most ${MAX_ITEMS} ${label}`, () => new Date()));
  }
  return ok(undefined);
}
