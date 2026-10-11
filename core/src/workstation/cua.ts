// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The CUA workstation provider — a real implementation of
 * {@link WorkstationProvider} that talks to the installed `cua-driver`.
 *
 * WHY the one-shot CLI (`cua-driver call <tool>`) and not MCP-over-stdio. The
 * installed driver offers both (its own `manifest` advertises
 * `mcp_invocation = ["mcp"]`), and `capabilities/computer/real-transport.ts`
 * already speaks MCP for the long-lived path. This provider is the *bounded
 * one-call* path: a caller wants one observation or one action with a hard
 * deadline and no session bookkeeping, so a single short-lived process that the
 * OS reaps is a better fit than a handshake, a framing layer and a child to
 * babysit. Both exist on purpose and share one driver.
 *
 * THE ARGV RULE, enforced by construction: the command line is built ONLY from
 * a fixed executable, one tool name drawn from {@link CUA_TOOL_BY_ACTION}, and
 * the fixed `--socket` flag. Every caller-supplied value — text to type, keys,
 * coordinates, window ids, element indices — travels as JSON on STDIN. There is
 * no code path that can put a caller string into argv, so a caller cannot
 * smuggle an argument, and there is no navigation target in the action union to
 * smuggle a URL through. (The driver's own `call --help` recommends stdin for
 * exactly this reason: its docs warn that PowerShell 5.1 mangles quoted JSON in
 * argv.)
 *
 * WHAT THIS PROVIDER REFUSES TO CLAIM: an action that the driver merely
 * delivered comes back `effect: "unverifiable"`, `verified: false`. The driver
 * publishes a verdict (`effect` / `route` / `evidence`) on its action results,
 * and this provider translates it — it never invents `confirmed`. On Windows
 * that distinction is not academic: a posted click on a UWP surface and a
 * posted key on a Chromium content area are both silently ignored, and the
 * driver's own documentation says so.
 *
 * Verified against the installed cua-driver 0.28.2 (see
 * `docs/architecture/KAI_WORKSTATION.md` for the raw probe transcript).
 */

import { spawn } from "node:child_process";

import { isRecord } from "../shared/contracts.ts";
import {
  isSupportedDriverVersion,
  parseDriverVersion,
  REAL_DRIVER_SEAM,
} from "../capabilities/computer/transport.ts";
import {
  fail,
  failure,
  ok,
  outcome,
  validateActionTarget,
  WORKSTATION_MINIMUM_DRIVER_VERSION,
  type AccessibilityElement,
  type ActionReport,
  type ConnectInfo,
  type ObservationTarget,
  type ProviderAvailability,
  type Screenshot,
  type WindowRef,
  type WindowSummary,
  type WorkstationAction,
  type WorkstationFailure,
  type WorkstationObservation,
  type WorkstationProvider,
  type WorkstationResult,
  type WorkstationRoute,
  type WorkstationStatus,
} from "./provider.ts";

// ── The closed tool surface ───────────────────────────────────────────────────

/**
 * Every driver tool this provider may call. A closed map: an action kind that
 * is not here cannot reach the driver, and no caller input contributes a name.
 */
export const CUA_TOOL_BY_ACTION = {
  click: "click",
  type: "type_text",
  key: "press_key",
  hotkey: "hotkey",
  scroll: "scroll",
  drag: "drag",
} as const;

export type CuaActionTool = (typeof CUA_TOOL_BY_ACTION)[keyof typeof CUA_TOOL_BY_ACTION];

/** Bare subcommands: run directly, not through `call`. */
export const CUA_PROBE_COMMANDS = {
  version: "--version",
  status: "status",
} as const;

/** The read-side tools, invoked through `call`. Also fixed. */
export const CUA_READ_TOOLS = {
  health: "health_report",
  screenSize: "get_screen_size",
  windowState: "get_window_state",
  desktopState: "get_desktop_state",
  accessibilityTree: "get_accessibility_tree",
  startSession: "start_session",
  endSession: "end_session",
} as const;

/** Every tool name this provider may pass to `call`. */
const CALLABLE_TOOLS: readonly string[] = [...Object.values(CUA_TOOL_BY_ACTION), ...Object.values(CUA_READ_TOOLS)];

// ── Process seam ──────────────────────────────────────────────────────────────

export interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnFailed: boolean;
}

/**
 * Runs one driver process. Injected so the mapping, the timeout discipline and
 * the failure classification are all testable without a driver on the machine —
 * and so a test can prove a call was bounded without waiting for a real hang.
 */
export type CuaCliRunner = (
  command: string,
  args: readonly string[],
  stdin: string | null,
  timeoutMs: number,
) => Promise<CliRun>;

export interface CuaProviderOptions {
  /** Defaults to the discovered install path. */
  executable?: string;
  /** Defaults to the Windows named pipe. */
  socket?: string;
  /** Budget for one driver call. */
  timeoutMs?: number;
  /** Shorter budget for the cheap `--version` / `status` probes. */
  probeTimeoutMs?: number;
  /** Stable label for this provider's driver session. */
  session?: string;
  /** Test seam. */
  runner?: CuaCliRunner;
  now?: () => string;
}

export interface CuaWorkstationProvider extends WorkstationProvider {
  readonly kind: "cua";
  /** The exact argv the provider would run for a tool. Exposed for tests. */
  invocation(tool: string): readonly string[];
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_PROBE_TIMEOUT_MS = 8_000;

/**
 * The production runner: spawn, feed stdin, cap the wall clock, collect both
 * streams, and never leave a process behind. A timeout KILLS the child — a
 * bounded call that leaves a driver process running is not bounded.
 */
export function createNodeCliRunner(): CuaCliRunner {
  return (command, args, stdin, timeoutMs) =>
    new Promise<CliRun>((resolve) => {
      let child;
      try {
        child = spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      } catch (error) {
        resolve({ code: null, stdout: "", stderr: String(error), timedOut: false, spawnFailed: true });
        return;
      }

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let spawnFailed = false;
      let settled = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);

      const settle = (code: number | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code, stdout, stderr, timedOut, spawnFailed });
      };

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      // A missing binary surfaces here, not as a throw.
      child.on("error", (error: Error) => {
        spawnFailed = true;
        stderr += String(error);
      });
      child.on("close", (code) => settle(code));

      if (stdin !== null && child.stdin.writable) child.stdin.end(stdin);
      else child.stdin.end();
    });
}

// ── Driver payload classification ─────────────────────────────────────────────

const KNOWN_EFFECTS: readonly string[] = ["confirmed", "partial", "unverifiable", "suspected_noop", "refused"];
const KNOWN_ROUTES: readonly string[] = ["accessibility", "synthetic_events", "global_input", "dom", "trusted_input"];

export interface DriverVerdict {
  effect: WorkstationObservation["effect"] | null;
  route?: WorkstationRoute;
  driverCode?: string;
  detail?: string;
  evidence?: readonly string[];
}

function readEffect(value: unknown): WorkstationObservation["effect"] | null {
  return typeof value === "string" && KNOWN_EFFECTS.includes(value)
    ? (value as WorkstationObservation["effect"])
    : null;
}

/**
 * Read the driver's own verdict out of a one-shot `call` response.
 *
 * The shapes below are not guessed — each was observed from the installed
 * 0.28.2 (transcript in the architecture doc):
 *
 *   refusal by target   { "code": "window_target_not_found", "effect": "refused", ... }
 *   refusal by handle   { "refusal": { "code": "stale_element_token", ... }, "status": "refused" }
 *   verification        { "status": "satisfied" | "unsatisfied" | "unknown", ... }
 *   action success      { "effect": ..., "route": ..., "evidence": [...] }  (documented)
 *
 * Returning `null` for the effect is the important part: an unrecognised shape
 * yields NO verdict, and the caller then reports `unverifiable` rather than
 * assuming the action worked.
 *
 * One inference is made, and only in the safe direction: a payload that names a
 * refusal — a `refusal` object, or a code from the driver's refusal vocabulary —
 * is read as `refused` even when the explicit marker is absent. `refused` never
 * claims the action landed, so this cannot manufacture a false success; the
 * opposite default (leaving it `unverifiable`) would throw away the driver's own
 * statement that it declined to act.
 */
export function readDriverVerdict(payload: unknown): DriverVerdict {
  if (!isRecord(payload)) return { effect: null };

  const nested = isRecord(payload.structuredContent) ? payload.structuredContent : undefined;
  const source = nested ?? payload;

  const explicit = readEffect(source.effect) ?? readEffect(payload.effect);
  const status = typeof source.status === "string" ? source.status : typeof payload.status === "string" ? payload.status : null;
  const refusal = isRecord(source.refusal) ? source.refusal : isRecord(payload.refusal) ? payload.refusal : undefined;

  const code =
    typeof source.code === "string"
      ? source.code
      : refusal && typeof refusal.code === "string"
        ? refusal.code
        : typeof payload.code === "string"
          ? payload.code
          : undefined;

  // `status: "refused"` is a verdict even when no `effect` field accompanies it.
  let effect = explicit;
  if (effect === null && status === "refused") effect = "refused";
  if (effect === null && status === "satisfied") effect = "confirmed";
  // An unmet postcondition is evidence of no useful change; an unprovable one
  // is not evidence of anything. The driver's own docs are explicit that
  // `unknown` never implies success.
  if (effect === null && status === "unsatisfied") effect = "suspected_noop";
  // A payload that NAMES a refusal is a refusal even when it omits the explicit
  // `effect` / `status: "refused"` marker: a `refusal` object, or a code drawn
  // from the driver's refusal vocabulary. Reporting those as `unverifiable`
  // would discard the driver's own statement that it did not act. An explicit
  // `status` above still wins, because the driver said something more specific.
  if (effect === null && (refusal !== undefined || isRefusalCode(code))) effect = "refused";

  const routeValue = source.route ?? payload.route;
  const route =
    typeof routeValue === "string" && KNOWN_ROUTES.includes(routeValue) ? (routeValue as WorkstationRoute) : undefined;

  const evidenceValue = source.evidence ?? payload.evidence;
  const evidence = Array.isArray(evidenceValue)
    ? evidenceValue
        .map((entry) => (isRecord(entry) && typeof entry.kind === "string" ? entry.kind : null))
        .filter((kind): kind is string => kind !== null)
    : undefined;

  const verdict: DriverVerdict = { effect };
  if (route !== undefined) verdict.route = route;
  if (code !== undefined) verdict.driverCode = code;
  if (evidence !== undefined) verdict.evidence = evidence;
  const message = refusal && typeof refusal.message === "string" ? refusal.message : typeof source.message === "string" ? source.message : undefined;
  if (message !== undefined) verdict.detail = message;
  return verdict;
}

/**
 * Driver-native refusal codes → the seam's failure kinds.
 *
 * Every code in this table means the driver deliberately did NOT deliver: it
 * could not resolve the target, had no route, or was not permitted. One code
 * in the driver's published reason set is deliberately NOT a refusal —
 * `effect_unconfirmed` describes a delivery whose effect could not be proven —
 * so it stays in this table (a refusal that arrives with it still needs a kind)
 * but is excluded from {@link isRefusalCode}, keeping such a payload
 * `unverifiable` rather than overstating it as `refused`.
 */
const FAILURE_KIND_BY_DRIVER_CODE: Record<string, WorkstationFailure["kind"]> = {
  stale_element_token: "stale_session",
  stale_snapshot: "stale_session",
  stale_session: "stale_session",
  window_target_not_found: "target",
  target_not_found: "target",
  invalid_target: "target",
  route_unavailable: "route",
  delivery_failed: "route",
  background_unavailable: "route",
  effect_unconfirmed: "route",
  permission_required: "permission",
  permission_denied: "permission",
  not_authorized: "permission",
};

function kindForDriverCode(code: string | undefined): WorkstationFailure["kind"] {
  if (code === undefined) return "route";
  return FAILURE_KIND_BY_DRIVER_CODE[code] ?? "route";
}

/** Driver codes that are refusals. `effect_unconfirmed` is not one (see above). */
function isRefusalCode(code: string | undefined): boolean {
  if (code === undefined || code === "effect_unconfirmed") return false;
  return FAILURE_KIND_BY_DRIVER_CODE[code] !== undefined;
}

/** Non-JSON text the driver prints. Two streams, two meanings. */
function classifyText(stderr: string, stdout: string): WorkstationFailure | null {
  const text = `${stderr}\n${stdout}`.trim();
  if (text.length === 0) return null;
  const lower = text.toLowerCase();

  if (lower.includes("daemon is not running")) {
    return failure({
      kind: "unavailable",
      message: "the cua-driver daemon is not running",
      detail: text,
      retryable: true,
    });
  }
  if (lower.includes("permission denied") || lower.includes("no reviewed risk classification")) {
    return failure({ kind: "permission", message: "the driver denied this tool", detail: text, effect: "refused" });
  }
  if (lower.includes("timed out")) {
    return failure({ kind: "timeout", message: "the driver reported a timeout", detail: text, retryable: true });
  }
  if (lower.includes("missing required") || lower.includes("did not parse")) {
    return failure({ kind: "target", message: "the driver rejected the call arguments", detail: text });
  }
  return failure({ kind: "protocol", message: "the driver returned an unrecognised response", detail: text });
}

/**
 * Turn one completed driver process into either a parsed payload or a typed
 * failure.
 *
 * The exit code alone is not enough, and this is the trap worth naming: the
 * installed driver exits 0 while printing a plain-text rejection to stdout for
 * a schema violation ("Missing required integer field: pid"), and exits 1 for a
 * daemon that is not running. So both the code AND whether stdout parsed are
 * load-bearing.
 */
export function classifyCliRun(run: CliRun): { ok: true; payload: unknown } | { ok: false; error: WorkstationFailure } {
  if (run.timedOut) {
    return {
      ok: false,
      error: failure({
        kind: "timeout",
        message: "the driver call exceeded its time budget",
        retryable: true,
        detail: run.stderr.trim() || undefined,
      }),
    };
  }
  if (run.spawnFailed) {
    return {
      ok: false,
      error: failure({
        kind: "unavailable",
        message: "the cua-driver executable could not be started",
        detail: run.stderr.trim() || undefined,
      }),
    };
  }

  const stdout = run.stdout.trim();
  const stderr = run.stderr.trim();

  if (run.code === 2) {
    return {
      ok: false,
      error: failure({ kind: "protocol", message: "the driver rejected the invocation", detail: stderr || stdout }),
    };
  }

  if (stdout.length > 0) {
    let parsed: unknown;
    let parsedOk = true;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      parsedOk = false;
    }
    if (parsedOk) return { ok: true, payload: parsed };
    // Exit 0 with unparseable stdout is a plain-text rejection.
    const classified = classifyText(stderr, stdout);
    if (classified) return { ok: false, error: classified };
  }

  if (run.code !== 0) {
    const classified = classifyText(stderr, stdout);
    if (classified) return { ok: false, error: classified };
    return {
      ok: false,
      error: failure({
        kind: "protocol",
        message: `the driver exited with code ${String(run.code)}`,
        detail: stderr || stdout || undefined,
      }),
    };
  }

  return {
    ok: false,
    error: failure({ kind: "protocol", message: "the driver returned no output", detail: stderr || undefined }),
  };
}

// ── Response readers ──────────────────────────────────────────────────────────

function numberField(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringField(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" ? value : undefined;
}

/** Read the structured `elements` array the driver returns from `get_window_state`. */
export function readAccessibilityElements(payload: unknown): AccessibilityElement[] {
  if (!isRecord(payload)) return [];
  const raw = payload.elements;
  if (!Array.isArray(raw)) return [];
  const out: AccessibilityElement[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const index = numberField(entry, "element_index");
    const role = stringField(entry, "role");
    if (index === undefined || role === undefined) continue;
    const element: AccessibilityElement = { index, role };
    const label = stringField(entry, "label");
    if (label !== undefined) element.label = label;
    const value = stringField(entry, "value");
    if (value !== undefined) element.value = value;
    const enabled = entry.enabled;
    if (typeof enabled === "boolean") element.enabled = enabled;
    const selected = entry.selected;
    if (typeof selected === "boolean") element.selected = selected;
    const actions = entry.actions;
    if (Array.isArray(actions)) element.actions = actions.filter((a): a is string => typeof a === "string");
    const depth = numberField(entry, "depth");
    if (depth !== undefined) element.depth = depth;
    const token = stringField(entry, "element_token");
    if (token !== undefined) element.token = token;
    const frame = entry.frame;
    if (isRecord(frame)) {
      const x = numberField(frame, "x");
      const y = numberField(frame, "y");
      const w = numberField(frame, "w");
      const h = numberField(frame, "h");
      if (x !== undefined && y !== undefined && w !== undefined && h !== undefined) {
        element.frame = { x, y, width: w, height: h };
      }
    }
    out.push(element);
  }
  return out;
}

/** Read the screenshot the driver returns inline. */
export function readScreenshot(payload: unknown): Screenshot | null {
  if (!isRecord(payload)) return null;
  const mimeType = stringField(payload, "screenshot_mime_type");
  const width = numberField(payload, "screenshot_width");
  const height = numberField(payload, "screenshot_height");
  const inline = stringField(payload, "screenshot_png_b64");

  if (inline === undefined || inline.length === 0) return null;
  return { mimeType: mimeType ?? "image/png", width: width ?? 0, height: height ?? 0, dataBase64: inline };
}

export function readWindows(payload: unknown): WindowSummary[] {
  if (!isRecord(payload)) return [];
  const raw = payload.windows;
  if (!Array.isArray(raw)) return [];
  const out: WindowSummary[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const pid = numberField(entry, "pid");
    const windowId = numberField(entry, "window_id");
    if (pid === undefined || windowId === undefined) continue;
    const summary: WindowSummary = { pid, windowId, title: stringField(entry, "title") ?? "" };
    const app = stringField(entry, "app_name");
    if (app !== undefined) summary.app = app;
    const minimized = entry.minimized;
    if (typeof minimized === "boolean") summary.minimized = minimized;
    const onScreen = entry.is_on_screen;
    if (typeof onScreen === "boolean") summary.onScreen = onScreen;
    // Two real 0.28.2 shapes, both captured live: `list_windows` nests the
    // geometry under `bounds`, while `get_accessibility_tree` — the tool this
    // provider actually uses for the desktop inventory — returns it FLAT on the
    // entry (`x`/`y`/`width`/`height`). Reading only the nested form silently
    // dropped the geometry of every window in a desktop observation, so a
    // caller could list windows but never address one by point.
    const geometry = isRecord(entry.bounds) ? entry.bounds : entry;
    const x = numberField(geometry, "x");
    const y = numberField(geometry, "y");
    const width = numberField(geometry, "width");
    const height = numberField(geometry, "height");
    if (x !== undefined && y !== undefined && width !== undefined && height !== undefined) {
      summary.bounds = { x, y, width, height };
    }
    out.push(summary);
  }
  return out;
}

// ── Action → driver arguments ─────────────────────────────────────────────────

function windowArgs(window: WindowRef): Record<string, unknown> {
  return { pid: window.pid, window_id: window.windowId };
}

/**
 * Translate one action into the driver's JSON arguments. Exported so the
 * mapping is testable without a driver — and so a test can assert that nothing
 * caller-supplied ever lands in argv.
 */
export function actionArguments(action: WorkstationAction): Record<string, unknown> {
  const target = action.target;
  const args: Record<string, unknown> = {};
  let scope: "window" | "desktop" = "window";

  switch (target.kind) {
    case "element":
      Object.assign(args, windowArgs(target.window), {
        element_index: target.elementIndex,
        snapshot_id: target.snapshotId,
      });
      if (target.token !== undefined) args.element_token = target.token;
      break;
    case "point":
      Object.assign(args, windowArgs(target.window), { x: target.x, y: target.y });
      break;
    case "desktop-point":
      Object.assign(args, { x: target.x, y: target.y });
      scope = "desktop";
      break;
    case "window":
      Object.assign(args, windowArgs(target.window));
      break;
    case "desktop":
      scope = "desktop";
      break;
  }

  if (scope === "desktop") args.scope = "desktop";
  if (action.deliveryMode !== undefined) args.delivery_mode = action.deliveryMode;

  switch (action.kind) {
    case "click":
      if (action.button !== undefined) args.button = action.button;
      if (action.count !== undefined) args.count = action.count;
      break;
    case "type":
      args.text = action.text;
      if (action.delayMs !== undefined) args.delay_ms = action.delayMs;
      break;
    case "key":
      args.key = action.key;
      if (action.modifiers !== undefined) args.modifiers = [...action.modifiers];
      break;
    case "hotkey":
      args.keys = [...action.keys];
      break;
    case "scroll":
      args.direction = action.direction;
      if (action.amount !== undefined) args.amount = action.amount;
      if (action.by !== undefined) args.by = action.by;
      break;
    case "drag":
      args.from_x = action.from.x;
      args.from_y = action.from.y;
      args.to_x = action.to.x;
      args.to_y = action.to.y;
      if (action.button !== undefined) args.button = action.button;
      if (action.durationMs !== undefined) args.duration_ms = action.durationMs;
      if (action.steps !== undefined) args.steps = action.steps;
      break;
  }

  return args;
}

// ── The provider ──────────────────────────────────────────────────────────────

export function createCuaWorkstationProvider(options: CuaProviderOptions = {}): CuaWorkstationProvider {
  const executable = options.executable ?? REAL_DRIVER_SEAM.executable;
  const socket = options.socket ?? REAL_DRIVER_SEAM.windowsPipe;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const session = options.session ?? "kai-workstation";
  const runner = options.runner ?? createNodeCliRunner();
  const now = options.now ?? ((): string => new Date().toISOString());

  let connected = false;
  let desktopAuthorized = false;
  let version: string | null = null;

  /**
   * Build the command line. The tool name comes from a closed map or the call
   * throws here — before a process exists — and no caller value is ever added.
   */
  function invocation(tool: string): readonly string[] {
    if (!CALLABLE_TOOLS.includes(tool)) {
      throw new Error(`refusing to run an unknown driver tool: ${tool}`);
    }
    return ["call", tool, "--socket", socket];
  }

  async function callTool(
    tool: string,
    args: Record<string, unknown>,
    budget: number,
  ): Promise<WorkstationResult<unknown>> {
    let argv: readonly string[];
    try {
      argv = invocation(tool);
    } catch (error) {
      return fail(failure({ kind: "internal", message: "unknown driver tool", detail: String(error) }));
    }
    const run = await runner(executable, argv, JSON.stringify(args), budget);
    const classified = classifyCliRun(run);
    if (!classified.ok) return fail(classified.error);
    return ok(classified.payload);
  }

  /** A refusal the driver stated in-band: a verdict, not a transport failure. */
  function refusalFrom(payload: unknown, action: WorkstationAction): WorkstationResult<ActionReport> {
    const verdict = readDriverVerdict(payload);
    const error = failure({
      kind: kindForDriverCode(verdict.driverCode),
      message: verdict.detail ?? "the driver refused the action",
      effect: "refused",
      driverCode: verdict.driverCode,
      detail: `action=${action.kind} target=${action.target.kind}`,
    });
    return fail(error);
  }

  async function probeVersion(): Promise<WorkstationResult<string | null>> {
    const run = await runner(executable, [CUA_PROBE_COMMANDS.version], null, probeTimeoutMs);
    if (run.spawnFailed) {
      return fail(
        failure({
          kind: "unavailable",
          message: "cua-driver is not installed or not on PATH",
          detail: `${executable}: ${run.stderr.trim()}`,
        }),
      );
    }
    if (run.timedOut) {
      return fail(failure({ kind: "timeout", message: "the driver did not answer --version", retryable: true }));
    }
    const parsed = parseDriverVersion(run.stdout.trim() || run.stderr.trim());
    return ok(parsed ? parsed.raw : null);
  }

  async function probeStatus(): Promise<WorkstationResult<{ daemonRunning: boolean; permissionMode: string | null }>> {
    // The daemon probe MUST name the same socket every `call` uses. `status`
    // with no `--socket` reports the DEFAULT pipe, so a provider pointed at any
    // other socket would report `daemonRunning: true` for a pipe with nothing
    // behind it — measured live against `\\.\pipe\kai-no-such-daemon`.
    const run = await runner(executable, [CUA_PROBE_COMMANDS.status, "--socket", socket], null, probeTimeoutMs);
    const text = `${run.stdout}\n${run.stderr}`;
    const daemonRunning = !run.spawnFailed && !run.timedOut && run.code === 0 && /daemon is running/i.test(text);
    const modeMatch = /permission mode:\s*([A-Za-z_-]+)/.exec(text);
    return ok({ daemonRunning, permissionMode: modeMatch?.[1] ?? null });
  }

  async function availability(): Promise<WorkstationResult<ProviderAvailability>> {
    const versionResult = await probeVersion();
    if (!versionResult.ok) {
      return ok({
        available: false,
        version: null,
        supported: false,
        daemonRunning: false,
        detail: versionResult.error.message,
      });
    }
    const reported = versionResult.value;
    const supported = isSupportedDriverVersion(reported);
    const statusResult = await probeStatus();
    const daemonRunning = statusResult.ok ? statusResult.value.daemonRunning : false;

    const value: ProviderAvailability = {
      available: true,
      version: reported,
      supported,
      daemonRunning,
    };
    if (!supported) {
      value.detail = `driver ${reported ?? "unknown"} is below the supported floor ${WORKSTATION_MINIMUM_DRIVER_VERSION}`;
    } else if (!daemonRunning) {
      value.detail = `the driver is installed but its daemon is not running; start it with: cua-driver serve`;
    }
    return ok(value);
  }

  return {
    id: `cua:${socket}`,
    kind: "cua",
    invocation,

    availability,

    async connect(): Promise<WorkstationResult<ConnectInfo>> {
      const available = await availability();
      if (!available.ok) return fail(available.error);
      if (!available.value.available) {
        return fail(
          failure({
            kind: "unavailable",
            message: available.value.detail ?? "cua-driver is unavailable",
          }),
        );
      }
      if (!available.value.supported) {
        return fail(
          failure({
            kind: "unsupported",
            message: available.value.detail ?? "the installed driver is not supported",
            detail: `floor=${WORKSTATION_MINIMUM_DRIVER_VERSION} found=${available.value.version ?? "unknown"}`,
          }),
        );
      }
      if (!available.value.daemonRunning) {
        return fail(
          failure({
            kind: "unavailable",
            message: "the cua-driver daemon is not running",
            detail: `start it with: cua-driver serve --socket ${socket}`,
            retryable: true,
          }),
        );
      }

      const started = await callTool(CUA_READ_TOOLS.startSession, { session }, probeTimeoutMs);
      if (!started.ok) return fail(started.error);

      const payload = started.value;
      desktopAuthorized =
        isRecord(payload) && payload.desktop_capture_authorized === true;
      version = available.value.version;
      connected = true;

      return ok({
        version: version ?? "unknown",
        platform: process.platform,
        daemon: true,
        capabilities: [...Object.values(CUA_TOOL_BY_ACTION)],
      });
    },

    async disconnect(): Promise<WorkstationResult<void>> {
      if (!connected) return ok(undefined);
      // End OUR session only. `cua-driver stop` would kill the user's daemon —
      // a host change this provider must never make on its own.
      await callTool(CUA_READ_TOOLS.endSession, { session }, probeTimeoutMs);
      connected = false;
      desktopAuthorized = false;
      return ok(undefined);
    },

    async status(): Promise<WorkstationResult<WorkstationStatus>> {
      const statusResult = await probeStatus();
      if (!statusResult.ok) return fail(statusResult.error);

      const health = await callTool(CUA_READ_TOOLS.health, {}, probeTimeoutMs);
      let reported: string | null = version;
      if (health.ok && isRecord(health.value) && typeof health.value.driver_version === "string") {
        reported = health.value.driver_version;
      }

      let screen: { width: number; height: number } | null = null;
      const size = await callTool(CUA_READ_TOOLS.screenSize, {}, probeTimeoutMs);
      if (size.ok && isRecord(size.value)) {
        const width = numberField(size.value, "width");
        const height = numberField(size.value, "height");
        if (width !== undefined && height !== undefined) screen = { width, height };
      }

      return ok({
        connected,
        version: reported,
        daemonRunning: statusResult.value.daemonRunning,
        permissionMode: statusResult.value.permissionMode,
        desktopAuthorized,
        screen,
        session: connected ? session : null,
      });
    },

    async observe(target: ObservationTarget): Promise<WorkstationResult<WorkstationObservation>> {
      if (!connected) {
        return fail(
          failure({ kind: "unavailable", message: "the provider is not connected", detail: "call connect() first" }),
        );
      }

      if (target.kind === "window") {
        const args: Record<string, unknown> = {
          pid: target.window.pid,
          window_id: target.window.windowId,
          // The tree is always requested; the pixel grab is skippable because
          // re-indexing before an element action does not need the image.
          include_accessibility_tree: true,
          include_screenshot: target.includeScreenshot !== false,
        };
        if (target.maxElements !== undefined) args.max_elements = target.maxElements;
        if (target.maxDepth !== undefined) args.max_depth = target.maxDepth;

        const captured = await callTool(CUA_READ_TOOLS.windowState, args, timeoutMs);
        if (!captured.ok) return fail(captured.error);

        const payload = captured.value;
        if (!isRecord(payload)) {
          return fail(failure({ kind: "protocol", message: "the driver returned no window state" }));
        }
        const elements = readAccessibilityElements(payload);
        const screenshot = readScreenshot(payload);
        const total = numberField(payload, "total_element_count") ?? elements.length;
        const complete = payload.elements_complete === true && total <= elements.length;

        const value: WorkstationObservation = {
          ...outcome({
            effect: screenshot === null && elements.length === 0 ? "unverifiable" : "confirmed",
            detail: stringField(payload, "window_title"),
            evidence: [
              ...(screenshot ? ["screenshot"] : []),
              ...(elements.length > 0 ? ["accessibility_tree"] : []),
            ],
          }),
          target,
          capturedAt: now(),
          screenshot,
          elements,
          complete,
        };
        const snapshotId = stringField(payload, "snapshot_id");
        if (snapshotId !== undefined) value.snapshotId = snapshotId;
        const markdown = stringField(payload, "tree_markdown");
        if (markdown !== undefined) value.treeMarkdown = markdown;
        return ok(value);
      }

      // Desktop: pixels from get_desktop_state, window inventory from
      // get_accessibility_tree. They are separate tools; an observation is the
      // union of both.
      const desktop = await callTool(CUA_READ_TOOLS.desktopState, {}, timeoutMs);
      if (!desktop.ok) return fail(desktop.error);
      const tree = await callTool(CUA_READ_TOOLS.accessibilityTree, {}, timeoutMs);

      const screenshot = readScreenshot(desktop.value);
      const windows = tree.ok ? readWindows(tree.value) : [];
      if (screenshot === null && windows.length === 0) {
        return fail(
          failure({
            kind: "protocol",
            message: "the desktop capture returned neither pixels nor a window inventory",
            effect: "unverifiable",
          }),
        );
      }

      return ok({
        ...outcome({
          effect: "confirmed",
          evidence: [...(screenshot ? ["screenshot"] : []), ...(windows.length > 0 ? ["windows"] : [])],
        }),
        target,
        capturedAt: now(),
        screenshot,
        elements: [],
        windows,
        complete: tree.ok,
      });
    },

    async act(action: WorkstationAction): Promise<WorkstationResult<ActionReport>> {
      const invalid = validateActionTarget(action);
      if (invalid) return fail(invalid);

      if (!connected) {
        return fail(
          failure({ kind: "unavailable", message: "the provider is not connected", detail: "call connect() first" }),
        );
      }

      const tool = CUA_TOOL_BY_ACTION[action.kind];
      const captured = await callTool(tool, actionArguments(action), timeoutMs);
      if (!captured.ok) return fail(captured.error);

      const verdict = readDriverVerdict(captured.value);
      if (verdict.effect === "refused") return refusalFrom(captured.value, action);

      const report: ActionReport = {
        // No verdict from the driver means the provider cannot vouch for the
        // effect. This is the honest default and the whole point of the seam.
        ...outcome({
          effect: verdict.effect ?? "unverifiable",
          detail: verdict.detail,
          evidence: verdict.evidence,
        }),
        action: action.kind,
        target: action.target.kind,
        at: now(),
      };
      if (verdict.route !== undefined) report.route = verdict.route;
      if (verdict.driverCode !== undefined) report.driverCode = verdict.driverCode;
      return ok(report);
    },

    async close(): Promise<void> {
      try {
        await this.disconnect();
      } catch {
        // close() never throws; a provider that cannot be torn down quietly is
        // worse than one that leaks a session the daemon will reap anyway.
      }
      connected = false;
    },
  };
}
