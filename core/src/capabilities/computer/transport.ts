// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The computer-use transport seam.
 *
 * WHY this file exists before any real driver wiring: KAI's Phase 1 computer
 * capability has to be built and TESTED against a pluggable transport, because
 * the real thing — an MCP-over-stdio conversation with `cua-driver` — cannot be
 * spawned safely in a unit test and is deliberately OUT OF SCOPE for this phase.
 * The interface below is the contract a real transport will implement later; the
 * fake (fake-transport.ts) implements the SAME contract now, so every safety
 * mechanism above it is exercised by real tests rather than asserted in prose.
 *
 * ── The real seam, stated honestly ──────────────────────────────────────────
 * The installed driver on this machine, verified 2026-10-02, is `cua-driver`
 * 0.28.2 at:
 *
 *     C:\Users\DELL\AppData\Local\Programs\Cua\cua-driver\bin\cua-driver.exe
 *
 * It speaks MCP over stdio (newline-delimited JSON-RPC frames) and has a local
 * daemon. On Windows the daemon is reached over a NAMED PIPE, e.g.
 * `\\.\pipe\cua-driver` — NOT a unix socket, which is the POSIX transport. A
 * later phase that wires this for real must not reach for a socket path; the
 * pipe fact lives here, on the seam, so nobody rediscovers it the hard way.
 *
 * A real `connect()` would: spawn the executable, perform the MCP `initialize`
 * handshake, then `tools/list` to learn the actual tool surface. It must NOT
 * forward `ping` to the driver — versions through at least 0.22.x answer
 * `-32601`, which is why the upstream bridge answers ping itself (design
 * evidence: openmausbot-source/server/mcp-bridge.ts, read-only).
 *
 * ── Version check, re-derived ───────────────────────────────────────────────
 * Upstream OpenMausBot pins driver 0.19.3 / 0.20.0. Copying either constant
 * would be WRONG for this machine. The floor here is re-derived for the
 * installed 0.28.2 and lives in exactly one place, so a future upgrade changes
 * one constant instead of hunting scattered comparisons.
 */

import type { KaiError } from "../../shared/contracts.ts";

/**
 * Result of a transport call. Errors are VALUES, never thrown at this boundary:
 * a transport that throws would force every caller to wrap it, and a thrown
 * error crossing the module edge is exactly what the brief forbids.
 */
export type TransportResult<T> = { ok: true; value: T } | { ok: false; error: KaiError };

export type MouseButton = "left" | "right" | "middle";

export interface ClickTarget {
  x: number;
  y: number;
  button?: MouseButton;
  clickCount?: number;
}

export interface ScrollTarget {
  x: number;
  y: number;
  deltaX?: number;
  deltaY?: number;
}

/**
 * One driver action. A closed union rather than a free-form object so the
 * session layer can only ever ask the driver for the four things this
 * foundation exposes — click, type, keypress, scroll — and a future action
 * cannot sneak in without a deliberate change here.
 */
export type TransportAction =
  | { kind: "click"; target: ClickTarget }
  | { kind: "type"; text: string }
  | { kind: "keypress"; keys: readonly string[] }
  | { kind: "scroll"; target: ScrollTarget };

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowInfo {
  id: string;
  title: string;
  bounds: WindowBounds;
  focused: boolean;
  /** Application/process the window belongs to, when the driver reports one. */
  app?: string;
}

/** What the driver can see about the machine right now, minus pixels. */
export interface Inspection {
  screen: { width: number; height: number };
  windows: readonly WindowInfo[];
  cursor?: { x: number; y: number };
}

/** A captured frame. `data` is a driver-specific payload (base64 or a data URL). */
export interface Frame {
  data: string;
  width: number;
  height: number;
  /**
   * Content hash of the frame, when the driver supplies one. NULL means the
   * driver could not hash it — callers must then treat the frame as
   * possibly-new (the deduper fails open rather than suppressing a frame it
   * cannot prove is a repeat).
   */
  hash: string | null;
}

export interface ObserveOptions {
  /** Crop region, when the caller only needs part of the screen. */
  region?: { x: number; y: number; width: number; height: number };
}

export interface ActionOutcome {
  /** True when the driver reports it actually performed the action. */
  performed: boolean;
  detail?: string;
}

/**
 * How a transport reaches a machine. The `kind` discriminator is what lets a
 * caller — and a test — state plainly which backing is in use: this phase ships
 * `"fake"` only, and reporting that honestly is part of the deliverable.
 */
export interface TransportEndpoint {
  kind: "fake" | "mcp-stdio";
  /** For `mcp-stdio`: absolute path to the driver executable. */
  command?: string;
  args?: readonly string[];
  /**
   * Windows named pipe for the local daemon, e.g. `\\.\pipe\cua-driver`.
   * Present so the real wiring does not assume a unix socket on Windows.
   */
  daemonPipe?: string;
  version?: string;
}

export interface ConnectInfo {
  version: string;
  endpoint: TransportEndpoint;
  /** MCP tools the driver advertised via `tools/list`, when it advertises them. */
  capabilities: readonly string[];
}

/**
 * The mandated transport surface: connect / inspect / act / observe, plus a
 * dedicated window listing (window discovery is a named responsibility and a
 * caller should not have to pull a full inspection to enumerate windows).
 *
 * `act` covers click, type, keypress and scroll — the closed union above — so
 * the interface stays four methods rather than nine near-identical ones.
 */
export interface ComputerTransport {
  readonly endpoint: TransportEndpoint;
  connect(): Promise<TransportResult<ConnectInfo>>;
  inspect(): Promise<TransportResult<Inspection>>;
  act(action: TransportAction): Promise<TransportResult<ActionOutcome>>;
  observe(options?: ObserveOptions): Promise<TransportResult<Frame>>;
  windows(): Promise<TransportResult<readonly WindowInfo[]>>;
}

// ── Driver contract check ─────────────────────────────────────────────────────

/**
 * The known-good driver floor for THIS machine.
 *
 * Re-derived for the installed 0.28.2 — do NOT replace with upstream's
 * 0.19.3 / 0.20.0 pins. The check is a FLOOR, not equality: 0.28.2 is
 * known-good and a later 0.x that keeps the same tool surface should not be
 * rejected out of hand. It is not a guarantee the surface is unchanged, so a
 * real `connect()` still negotiates `tools/list` rather than assuming.
 */
export const MINIMUM_DRIVER_VERSION = "0.28.2";

/**
 * Facts about the installed driver, captured once so the later real wiring has
 * them in one place. This is DOCUMENTATION of the environment, not wiring — no
 * code here spawns anything.
 */
export const REAL_DRIVER_SEAM = {
  transport: "mcp-stdio",
  installedVersion: "0.28.2",
  /** Windows: the daemon is a NAMED PIPE, not a unix socket. */
  windowsPipe: String.raw`\\.\pipe\cua-driver`,
  /** Discovered default install path; a later phase should make this configurable. */
  executable: String.raw`C:\Users\DELL\AppData\Local\Programs\Cua\cua-driver\bin\cua-driver.exe`,
} as const;

export interface DriverVersion {
  major: number;
  minor: number;
  patch: number;
  raw: string;
}

/** Parse `0.28.2`, `v0.28.2`, or `cua-driver 0.28.2`. Returns null on anything else. */
export function parseDriverVersion(raw: string | null | undefined): DriverVersion | null {
  if (typeof raw !== "string") return null;
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(raw.trim().replace(/^[a-z-]+\s+/i, ""));
  if (!match) return null;
  const [, major, minor, patch] = match;
  if (major === undefined || minor === undefined || patch === undefined) return null;
  return { major: Number(major), minor: Number(minor), patch: Number(patch), raw: raw.trim() };
}

/** Negative when `a` is older than `b`, positive when newer, 0 when equal. */
export function compareDriverVersions(a: DriverVersion, b: DriverVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/**
 * Is `raw` at least MINIMUM_DRIVER_VERSION? An unparseable string is NOT
 * supported: a version we cannot read is a version we cannot vouch for, and the
 * safe answer to "can this driver do what we need?" is no.
 */
export function isSupportedDriverVersion(raw: string | null | undefined): boolean {
  const version = parseDriverVersion(raw);
  const minimum = parseDriverVersion(MINIMUM_DRIVER_VERSION);
  if (!version || !minimum) return false;
  return compareDriverVersions(version, minimum) >= 0;
}
