// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * KAI-owned MCP contracts (Part Q).
 *
 * These are the *MCP* shapes that live outside the frozen `shared/contracts.ts`.
 * The frozen file owns the things every module shares (KaiError, RiskLevel,
 * ToolDefinition); this file owns only what an MCP server entry and a discovered
 * MCP tool are. Nothing here crosses an IPC boundary yet, so it is deliberately
 * kept beside the code that validates it rather than in the frozen contract.
 *
 * The one invariant that shapes every type below: a *secret* is stored, but it
 * is never part of anything that is listed, logged or shown. The stored server
 * holds the value; the listing holds only the key name; the mutation accepts a
 * write-only placeholder. See `listings` below.
 */

import type { RiskLevel } from "../shared/contracts.ts";

// ── Transport ────────────────────────────────────────────────────────────────

/**
 * How KAI talks to the server. `stdio` is a child process whose stdin/stdout is
 * the JSON-RPC transport; `http`/`sse` are remote endpoints. Deliberately the
 * same three strings every MCP client writes, so a pasted block is a stored
 * block.
 */
export type McpTransport = "stdio" | "http" | "sse";

// ── Secrets ──────────────────────────────────────────────────────────────────

/**
 * A secret on its way *in* from a caller.
 *
 *   - a string           → a new value, stored verbatim
 *   - the literal `true` → a write-only placeholder meaning "keep the value
 *                          already saved for this key"
 *
 * The placeholder exists so a UI can re-submit a form it cannot read: it sends
 * `true` for every secret it did not change. `true` for a key that was never
 * saved is an error, never a stored literal `true` — resolving that wrong would
 * silently replace a credential with the string "true".
 */
export type SecretInput = string | true;

// ── Risk declaration (KAI-owned, never provider-declared) ────────────────────

/**
 * The risk KAI assigns to an MCP tool.
 *
 * WHY THIS EXISTS AT ALL: an MCP server tells KAI the tool's *name*,
 * description and JSON input schema — and nothing about how dangerous it is.
 * A provider *may* attach MCP `annotations` (`readOnlyHint`, `destructiveHint`),
 * but those are self-reported hints from the very code that would benefit from
 * being trusted, so KAI never reads them as the risk. The risk has to be KAI's
 * own declaration, made by the user or an admin when the server is registered.
 *
 * Consequently a tool with no matching declaration has no risk, and a tool with
 * no risk is refused (fail closed) rather than defaulted to READ. See
 * `tool-adapter.ts`.
 */
export interface McpRiskDeclaration {
  /** Risk for any tool of this server with no per-tool entry. */
  default?: RiskLevel;
  /** Per-tool overrides, keyed by the server-local MCP tool name. */
  tools?: Record<string, RiskLevel>;
}

// ── Stored server ────────────────────────────────────────────────────────────

/** A local server: a command this machine runs. */
export interface StdioMcpServer {
  transport: "stdio";
  command: string;
  args: string[];
  /** Secret credential values, kept write-only: see `McpServerListing`. */
  env: Record<string, string>;
  risk?: McpRiskDeclaration;
}

/** A remote server: an address to connect to. */
export interface RemoteMcpServer {
  transport: "http" | "sse";
  url: string;
  /** Secret credential values, kept write-only: see `McpServerListing`. */
  headers: Record<string, string>;
  risk?: McpRiskDeclaration;
}

export type StoredMcpServer = StdioMcpServer | RemoteMcpServer;

/**
 * A stored server plus the one piece of state that is KAI's, not the server's:
 * whether KAI is allowed to start it. New servers are `enabled: false`.
 */
export interface McpServerRecord {
  server: StoredMcpServer;
  enabled: boolean;
}

// ── Listings (what a caller/UI may see) ──────────────────────────────────────
//
// A listing is the only representation that leaves the registry. It carries key
// NAMES for secrets and never their values — there is no field here that could
// hold a secret even by mistake. `hasRisk` is a boolean flag (risk is a
// classification, not a credential, but the full declaration is not needed in a
// list).

export interface StdioMcpServerListing {
  name: string;
  transport: "stdio";
  command: string;
  args: string[];
  /** Names of the env variables this server is given. Never the values. */
  envKeys: string[];
  enabled: boolean;
  hasRisk: boolean;
}

export interface RemoteMcpServerListing {
  name: string;
  transport: "http" | "sse";
  url: string;
  /** Names of the headers this server is sent. Never the values. */
  headerKeys: string[];
  enabled: boolean;
  hasRisk: boolean;
}

export type McpServerListing = StdioMcpServerListing | RemoteMcpServerListing;

// ── Discovered tools ─────────────────────────────────────────────────────────

/**
 * One entry from an MCP server's `tools/list`.
 *
 * `inputSchema` and `annotations` are `unknown` on purpose: they arrive over the
 * wire from an untrusted peer and must be validated before use. `annotations`
 * is carried only so a UI could *show* a provider's self-description; it is
 * never consulted to decide risk or permission.
 */
export interface McpDiscoveredTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: unknown;
}
