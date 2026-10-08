// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * CdpBrowserTransport — the REAL `BrowserTransport`: a semantic-first driver for
 * Edge/Chrome over the Chrome DevTools Protocol. No Playwright, no Puppeteer, no
 * npm dependency: it speaks CDP through Node's built-in `WebSocket` (Node ≥ 22)
 * and `node:http`/`node:child_process`.
 *
 * It satisfies the exact `BrowserTransport` interface (transport.ts) so
 * `capability.ts` needs no change — the capability keeps its inspect-once /
 * re-inspect-only-when-revision-moved logic and now runs against a real browser.
 *
 * ── Why CDP is the top rung, not a pixel driver ───────────────────────────────
 *
 * interaction.ts names CDP explicitly as a `native_api` channel ("a protocol/CLI
 * channel that talks to the browser ... directly (CDP, ...)"). So this transport
 * reports `nativeApi: true` AND `dom: true` AND `accessibility: true`, and
 * `screenshot: true` too. Because `selectStrategy` walks the hierarchy
 * highest-fidelity-first, the capability therefore ALWAYS picks `native_api` and
 * never falls to pixels. That is the point: screenshots are a verification
 * fallback, never the source of truth.
 *
 * ── The connection (what actually happens on the wire) ────────────────────────
 *
 *   1. Spawn Edge/Chrome with `--remote-debugging-port=0` (an OS-assigned port,
 *      so two concurrent transports never collide) and a dedicated
 *      `--user-data-dir` under the OS temp dir (so this browser is OUR browser:
 *      no profile bleed, nothing else can attach to our tabs).
 *   2. The browser prints `DevTools listening on ws://127.0.0.1:<port>/devtools/
 *      browser/<id>` on stderr; we parse that line — it is the authoritative
 *      endpoint, no port guessing, no race. (Attach mode instead GETs
 *      `/json/version` and reads `webSocketDebuggerUrl`.)
 *   3. Open ONE WebSocket to that endpoint and multiplex everything over it.
 *      Page-domain commands (Page/DOM/Runtime/Input/Accessibility) are routed to
 *      a specific tab with the `sessionId` from `Target.attachToTarget`
 *      (`flatten: true`) — CDP's built-in session multiplexing. Target-domain
 *      commands (getTargets/createTarget/closeTarget/activateTarget) go without a
 *      sessionId. So a single socket drives every tab.
 *
 * ── Ownership in terms of real ids ────────────────────────────────────────────
 *
 * `openTarget` returns the real CDP `targetId`; `closeTarget`/`listTargets`/
 * `switch_tab` all speak that id. ownership.ts keys leases by exactly this id, so
 * "agent A may drive tab X and agent B may not" is enforced against the same
 * identifier the browser itself uses.
 *
 * ── Revision: a real change signal ────────────────────────────────────────────
 *
 * `revision(targetId)` is a monotonic counter that moves only on REAL change:
 *
 *   - `Page.frameNavigated` / `Page.navigatedWithinDocument` (main frame) → +1.
 *     Observed live: a navigation emits `Page.frameNavigated` on the session.
 *   - a page-side `MutationObserver` counts DOM mutations into
 *     `window.__kaiMutationCount`; `revision()` reads that counter with one
 *     `Runtime.evaluate` and bumps once when the watermark advances.
 *
 * A `scroll` that reveals nothing, or a second `inspect` with no action between,
 * therefore returns the SAME number — which is what makes the capability's
 * "re-inspect only when the revision moved" rule true against real state instead
 * of against a fake counter. (An `<input>` `value` is a JS property, invisible to
 * a MutationObserver, so `type`/`select` bump explicitly; see act().)
 *
 * ── Verification loop ─────────────────────────────────────────────────────────
 *
 * `observe()` reads real DOM/AX data (role, name, value, text) from the live page,
 * so after any action the caller can confirm the new state by re-reading the same
 * cheap semantic fields — no screenshot required. `act()` also returns the
 * post-action revision, so "did it change?" is decidable without pixels.
 *
 * Errors are values (KaiError), never thrown across the seam.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { get as httpGet } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type KaiError } from "../../shared/contracts.ts";
import {
  NO_AFFORDANCES,
  type TransportAffordances,
} from "./interaction.ts";
import {
  BROWSER_ACTIONS,
  type BrowserAction,
  type BrowserTransport,
  type ActOutcome,
  type ActRequest,
  type ObservedPage,
  type ObserveRequest,
  type Result,
  type SemanticElement,
  type TargetInfo,
  type Result as CdpResult,
} from "./transport.ts";

// ── Tunables ──────────────────────────────────────────────────────────────────

const DEFAULT_LAUNCH_TIMEOUT_MS = 25_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;
const DEFAULT_WAIT_TIMEOUT_MS = 8_000;
/** After a click we poll briefly for the change so `changed` is not a race. */
const DEFAULT_SETTLE_TIMEOUT_MS = 600;
/** Bounds on what a single observation may pull back into Core (no blobs, no walls of text). */
const MAX_ELEMENTS = 600;
const MAX_TEXT_CHARS = 20_000;

// ── Small value helpers (CDP returns `unknown`; validate, never assume) ────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function rec(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function isNum(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** An AX/DOM field is a `{ type, value }` pair; only the string/number value matters. */
function pairText(field: unknown): string | undefined {
  const value = rec(field).value;
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return undefined;
}

// ── The transport surface (interface + a few real-browser extras) ─────────────

export interface CdpTransportStats {
  /** Semantic observations served. */
  observations: number;
  /** Actions performed. */
  actions: number;
  /** Screenshots captured — expected to stay 0 while semantics are available. */
  screenshots: number;
  /** Navigations observed/issued (the navigation half of the revision signal). */
  navigations: number;
}

export interface CdpTransportOptions {
  /** Which browser to launch when not attaching. `auto` prefers Edge on Windows. */
  browser?: "edge" | "chrome" | "auto";
  /** Explicit browser executable. Overrides discovery. */
  executablePath?: string;
  /** Headless by default; set false to watch the window. */
  headless?: boolean;
  /** Reuse a profile dir instead of a fresh temp one (not recommended between runs). */
  userDataDir?: string;
  /** ATTACH to an already-running browser on this debugging port. */
  port?: number;
  /** ATTACH to an already-running browser at this endpoint, e.g. http://127.0.0.1:9222. */
  endpoint?: string;
  /** ATTACH to this exact DevTools websocket URL. */
  wsUrl?: string;
  launchTimeoutMs?: number;
  commandTimeoutMs?: number;
  waitTimeoutMs?: number;
  settleTimeoutMs?: number;
  /** Extra command-line args appended to the launch line. */
  extraArgs?: readonly string[];
  now?: () => Date;
}

export interface CdpBrowserTransport extends BrowserTransport {
  /** The DevTools websocket endpoint in use, once connected. */
  endpoint(): string | null;
  /** True when this transport launched the browser (vs attached to one). */
  launched(): boolean;
  /** Real-browser call counters (screenshots stay 0 while semantics are used). */
  stats(): CdpTransportStats;
  /** Disconnect and, when we launched it, shut the browser down. Idempotent. */
  close(): Promise<void>;
}

// ── Errors as values ──────────────────────────────────────────────────────────

function fail<T>(code: KaiError["code"], message: string, at: () => Date, detail?: string): CdpResult<T> {
  const error: KaiError = { code, message, retryable: false, at: at().toISOString() };
  if (detail !== undefined) error.detail = detail;
  return { ok: false, error };
}
function ok<T>(value: T): CdpResult<T> {
  return { ok: true, value };
}

/**
 * Turns a CDP protocol error into a KaiError. The mapping is by message text
 * because CDP error codes are mostly -32000/-32602 and the *meaning* is in the
 * message ("No target with given id", "Cannot find context with specified id").
 * Getting this wrong only affects the error's `code`, never whether it is thrown:
 * this function is on the value path.
 */
function cdpError(error: { code?: number; message?: string; data?: string }, at: () => Date): KaiError {
  const text = `${error.message ?? "CDP error"}${error.data ? ` (${error.data})` : ""}`;
  let code: KaiError["code"] = "INTERNAL";
  if (
    /no target with given id|no session with given id|cannot find context|target .* not found|cannot find object|no node with given id|no node found/i.test(
      text,
    )
  ) {
    code = "NOT_FOUND";
  } else if (/timeout|timed out/i.test(text)) {
    code = "AGENT_TIMEOUT";
  } else if (/not attached|detached/i.test(text)) {
    code = "AGENT_NOT_LISTENING";
  }
  return { code, message: text, retryable: false, at: at().toISOString() };
}

// ── The CDP websocket client (dependency-free, over the global WebSocket) ─────

interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
  sessionId: string | undefined;
}

interface CdpClient {
  readonly endpoint: string;
  /** Send a command; resolve with a Result. `sessionId` routes it to one tab. */
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<Result<unknown>>;
  /** Subscribe to protocol events. Returns an unsubscribe function. */
  onEvent(listener: (event: CdpEvent) => void): () => void;
  /** Closes the socket; any in-flight command resolves as an error value. */
  close(): void;
}

/**
 * Opens the websocket and wires the request/response/event plumbing. Node ≥ 22
 * exposes a WHATWG `WebSocket` globally; we use it directly rather than shipping
 * an RFC 6455 client (fewer moving parts, no dependency).
 */
async function connectCdpClient(
  endpoint: string,
  commandTimeoutMs: number,
  at: () => Date,
): Promise<Result<CdpClient>> {
  let socket: WebSocket;
  try {
    socket = new WebSocket(endpoint);
  } catch (error) {
    return fail("AGENT_NOT_LISTENING", `could not open a CDP websocket to ${endpoint}: ${messageOf(error)}`, at);
  }

  const opened = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), commandTimeoutMs);
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        resolve(false);
      },
      { once: true },
    );
  });

  if (!opened) {
    try {
      socket.close();
    } catch {
      /* already gone */
    }
    return fail("AGENT_NOT_LISTENING", `the CDP endpoint ${endpoint} did not accept a websocket connection`, at);
  }

  let nextId = 1;
  const pending = new Map<number, { resolve: (r: Result<unknown>) => void; timer: ReturnType<typeof setTimeout> }>();
  const listeners = new Set<(event: CdpEvent) => void>();
  let closed = false;

  socket.addEventListener("message", (event) => {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(String((event as MessageEvent).data)) as Record<string, unknown>;
    } catch {
      // A malformed frame is not something we can route; drop it rather than
      // letting it corrupt the pending map.
      return;
    }

    const id = num(message.id);
    if (id !== undefined && pending.has(id)) {
      const entry = pending.get(id);
      if (entry === undefined) return;
      pending.delete(id);
      clearTimeout(entry.timer);
      const protocolError = rec(message.error);
      if (message.error !== undefined) {
        entry.resolve({ ok: false, error: cdpError({ code: num(protocolError.code), message: str(protocolError.message), data: str(protocolError.data) }, at) });
      } else {
        entry.resolve(ok(message.result ?? {}));
      }
      return;
    }

    const method = str(message.method);
    if (method !== undefined) {
      const eventObj: CdpEvent = { method, params: rec(message.params), sessionId: str(message.sessionId) };
      for (const listener of listeners) {
        // A listener throwing must not take down the socket for everyone else.
        try {
          listener(eventObj);
        } catch {
          /* ignore listener faults */
        }
      }
    }
  });

  socket.addEventListener("close", () => {
    closed = true;
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.resolve(fail("AGENT_NOT_LISTENING", `the CDP connection to ${endpoint} closed`, at));
    }
    pending.clear();
  });

  const client: CdpClient = {
    endpoint,
    send(method, params = {}, sessionId) {
      return new Promise<Result<unknown>>((resolve) => {
        if (closed) {
          resolve(fail("AGENT_NOT_LISTENING", `the CDP connection to ${endpoint} is closed`, at));
          return;
        }
        const id = nextId++;
        const timer = setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            resolve(fail("AGENT_TIMEOUT", `CDP ${method} did not answer within ${commandTimeoutMs}ms`, at));
          }
        }, commandTimeoutMs);
        pending.set(id, { resolve, timer });

        const payload: Record<string, unknown> = { id, method, params };
        if (sessionId !== undefined) payload.sessionId = sessionId;
        try {
          socket.send(JSON.stringify(payload));
        } catch (error) {
          pending.delete(id);
          clearTimeout(timer);
          resolve(fail("AGENT_NOT_LISTENING", `could not send CDP ${method}: ${messageOf(error)}`, at));
        }
      });
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      closed = true;
      try {
        socket.close();
      } catch {
        /* already closed */
      }
    },
  };

  return ok(client);
}

// ── Browser discovery / launch ────────────────────────────────────────────────

const WINDOWS_CANDIDATES: readonly string[] = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
];

const OTHER_CANDIDATES: readonly string[] = [
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];

/**
 * Finds a Chromium executable. Environment override first (so a CI or a user can
 * point at a specific build), then the platform's usual install locations, then
 * whatever PATH resolves the common names to. `prefer` reorders, it does not
 * filter: a missing Edge still lets Chrome be used.
 */
function findExecutable(prefer: "edge" | "chrome" | "auto"): string | null {
  const env = process.env.KAI_BROWSER_PATH;
  if (env !== undefined && env.trim() !== "" && existsSync(env)) return env;

  const discovered = [...WINDOWS_CANDIDATES, ...OTHER_CANDIDATES].filter((path) => existsSync(path));
  if (discovered.length === 0) {
    // Last resort: bare command names, spawned via PATH.
    return process.platform === "win32" ? null : "google-chrome";
  }
  if (prefer === "chrome") return discovered.find((p) => /chrome/i.test(p)) ?? discovered[0] ?? null;
  if (prefer === "edge") return discovered.find((p) => /edge/i.test(p)) ?? discovered[0] ?? null;
  // auto: on Windows Edge is guaranteed present, so prefer it and fall back to Chrome.
  return discovered.find((p) => /edge/i.test(p)) ?? discovered[0] ?? null;
}

function buildArgs(headless: boolean, userDataDir: string, extraArgs: readonly string[]): string[] {
  const args = [
    `--user-data-dir=${userDataDir}`,
    // Port 0 lets the OS pick a free port: two transports can run at once without
    // a port-collision dance, and the real port is read off the DevTools line.
    "--remote-debugging-port=0",
    // Chrome refuses a DevTools websocket whose Origin it does not recognise;
    // the Node client sends no Origin, and this makes that explicit rather than
    // relying on a default that has changed across Chrome versions.
    "--remote-allow-origins=*",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--disable-gpu",
    "--hide-scrollbars",
    "--mute-audio",
    "--window-size=1280,900",
  ];
  if (headless) args.push("--headless=new");
  args.push(...extraArgs);
  args.push("about:blank");
  return args;
}

interface LaunchResult {
  endpoint: string;
  child: ChildProcess;
  userDataDir: string;
}

/**
 * Spawns the browser and waits for the authoritative `DevTools listening on ...`
 * line. Resolves to an error value (never throws) if the process dies first or
 * the line never arrives — an unreachable browser must degrade, not crash Core.
 */
function launchBrowser(
  executable: string,
  headless: boolean,
  userDataDir: string,
  extraArgs: readonly string[],
  timeoutMs: number,
  at: () => Date,
): Promise<Result<LaunchResult>> {
  return new Promise((resolve) => {
    let settled = false;
    let buffered = "";
    let child: ChildProcess;
    const finish = (result: Result<LaunchResult>): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    try {
      child = spawn(executable, buildArgs(headless, userDataDir, extraArgs), {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      finish(fail("AGENT_NOT_LISTENING", `could not launch ${executable}: ${messageOf(error)}`, at));
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish(fail("AGENT_TIMEOUT", `no "DevTools listening" line from ${executable} within ${timeoutMs}ms`, at));
    }, timeoutMs);

    const onData = (chunk: Buffer | string): void => {
      buffered += String(chunk);
      const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(buffered);
      if (match?.[1] !== undefined) {
        clearTimeout(timer);
        finish(ok({ endpoint: match[1], child, userDataDir }));
      }
    };

    child.stderr?.on("data", onData);
    child.stdout?.on("data", onData);
    child.on("error", (error) => {
      clearTimeout(timer);
      finish(fail("AGENT_NOT_LISTENING", `the browser process failed to start: ${messageOf(error)}`, at));
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      finish(fail("AGENT_NOT_LISTENING", `the browser exited before opening a DevTools port (code ${String(code)})`, at));
    });
  });
}

/** GET /json/version and read `webSocketDebuggerUrl` — the attach-mode discovery. */
function fetchJson(url: string, timeoutMs: number, at: () => Date): Promise<Result<unknown>> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (result: Result<unknown>): void => {
      if (done) return;
      done = true;
      resolve(result);
    };
    const request = httpGet(url, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("end", () => {
        try {
          finish(ok(JSON.parse(body)));
        } catch (error) {
          finish(fail("AGENT_BAD_RESPONSE", `could not parse ${url}: ${messageOf(error)}`, at));
        }
      });
    });
    request.on("error", (error) => {
      finish(fail("AGENT_NOT_LISTENING", `could not reach ${url}: ${messageOf(error)}`, at));
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      finish(fail("AGENT_TIMEOUT", `timed out reaching ${url}`, at));
    });
  });
}

// ── Semantic extraction ───────────────────────────────────────────────────────

/**
 * AX roles that are pure structure or text runs: they are not addressable
 * controls and including them would drown the real controls in noise.
 */
const NOISY_AX_ROLES = new Set([
  "RootWebArea",
  "WebArea",
  "none",
  "generic",
  "StaticText",
  "InlineTextBox",
  "LineBreak",
  "Ignored",
  "IgnoredRepeat",
]);

/** Roles a person can act on — included even when the name is empty (so a
 * nameless-but-addressable control still shows up as a ref). */
const INTERACTIVE_AX_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "treeitem",
]);

function normalizeRole(role: string): string {
  return role.toLowerCase();
}

interface DomNodeInfo {
  nodeName: string;
  type?: string;
  disabled: boolean;
}

/** Flattens a CDP `attributes` array (`[name, value, name, value, ...]`). */
function attributesToRecord(attributes: unknown): Record<string, string> {
  const list = arr(attributes);
  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < list.length; i += 2) {
    const key = str(list[i]);
    const value = str(list[i + 1]);
    if (key !== undefined && value !== undefined) out[key.toLowerCase()] = value;
  }
  return out;
}

/**
 * Walks the DOM tree from `DOM.getDocument` once and indexes nodes by
 * `backendNodeId`. This buys two things for the price of one round trip: the
 * `kind` of a form control (an AX `textbox` cannot say whether it is `text` or
 * `password`) and a DOM-only fallback when the accessibility tree is unavailable.
 */
function walkDom(node: unknown, into: Map<number, DomNodeInfo>, collected: SemanticElement[]): void {
  if (!isRecord(node)) return;
  const backendNodeId = num(node.backendNodeId);
  const nodeName = str(node.nodeName) ?? "";
  const attributes = attributesToRecord(node.attributes);
  if (backendNodeId !== undefined) {
    const info: DomNodeInfo = { nodeName, disabled: attributes.disabled !== undefined };
    if (attributes.type !== undefined) info.type = attributes.type;
    into.set(backendNodeId, info);

    // DOM-only candidate: a coarse role from the tag, named from aria-label /
    // alt / value / first text. Used only when the AX tree is unavailable.
    const fallbackRole = domRole(nodeName, attributes);
    if (fallbackRole !== undefined) {
      collected.push({
        ref: `ax:${backendNodeId}`,
        role: fallbackRole,
        ...(domName(attributes) !== undefined ? { name: domName(attributes) } : {}),
        ...(attributes.type !== undefined ? { kind: attributes.type } : {}),
        ...(attributes.disabled !== undefined ? { disabled: true } : {}),
      });
    }
  }
  for (const child of arr(node.children)) walkDom(child, into, collected);
  walkDom(node.contentDocument, into, collected);
}

function domRole(nodeName: string, attributes: Record<string, string>): string | undefined {
  const tag = nodeName.toLowerCase();
  switch (tag) {
    case "a":
      return attributes.href !== undefined ? "link" : undefined;
    case "button":
      return "button";
    case "input": {
      const type = (attributes.type ?? "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "submit" || type === "reset" || type === "button") return "button";
      return "textbox";
    }
    case "textarea":
      return "textbox";
    case "select":
      return "combobox";
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return "heading";
    case "img":
      return "image";
    default:
      return undefined;
  }
}

function domName(attributes: Record<string, string>): string | undefined {
  return attributes["aria-label"] ?? attributes.alt ?? attributes.placeholder ?? attributes.value;
}

/**
 * Turns the AX tree into `SemanticElement[]`. The `ref` is `ax:<backendDOMNodeId>`
 * — an id the browser itself assigned, which every DOM/Input command below
 * accepts directly, so a ref observed here is immediately actionable with no
 * coordinate preselection.
 */
function elementsFromAx(nodes: readonly unknown[], domIndex: Map<number, DomNodeInfo>): SemanticElement[] {
  const out: SemanticElement[] = [];
  const seen = new Set<string>();
  for (const raw of nodes) {
    if (out.length >= MAX_ELEMENTS) break;
    const node = rec(raw);
    if (node.ignored === true) continue;
    const role = pairText(node.role) ?? "";
    if (role === "" || NOISY_AX_ROLES.has(role)) continue;
    const backendNodeId = num(node.backendDOMNodeId);
    if (backendNodeId === undefined) continue;
    const name = pairText(node.name);
    if ((name === undefined || name === "") && !INTERACTIVE_AX_ROLES.has(role)) continue;

    const ref = `ax:${backendNodeId}`;
    if (seen.has(ref)) continue; // several AX nodes can share one DOM node; keep the first.
    seen.add(ref);

    const value = pairText(node.value);
    const dom = domIndex.get(backendNodeId);
    const properties = arr(node.properties);
    const disabled =
      dom?.disabled === true ||
      properties.some((property) => rec(property).name === "disabled" && rec(rec(property).value).value === true);

    const element: SemanticElement = { ref, role: normalizeRole(role) };
    if (name !== undefined && name !== "") element.name = name;
    if (value !== undefined && value !== "") element.value = value;
    if (dom?.type !== undefined) element.kind = dom.type;
    if (disabled) element.disabled = true;
    out.push(element);
  }
  return out;
}

// ── Ref parsing / node resolution ─────────────────────────────────────────────

interface NodeHandle {
  backendNodeId?: number;
  nodeId?: number;
  selector?: string;
}

/**
 * A ref is an observation-time handle. We accept the transport's own
 * `ax:<backendNodeId>`, a bare `backendNodeId`, a raw `dom:<nodeId>`, and a
 * `dom:css=<selector>` escape hatch (resolved with `DOM.querySelector`).
 */
function parseRef(ref: string): NodeHandle | null {
  if (/^ax:\d+$/.test(ref)) return { backendNodeId: Number(ref.slice(3)) };
  if (/^dom:\d+$/.test(ref)) return { nodeId: Number(ref.slice(4)) };
  if (/^\d+$/.test(ref)) return { backendNodeId: Number(ref) };
  if (ref.startsWith("dom:css=") && ref.length > "dom:css=".length) return { selector: ref.slice("dom:css=".length) };
  return null;
}

/** The params object DOM/Input commands accept for a resolved handle. */
function nodeParams(handle: NodeHandle): Record<string, unknown> {
  if (handle.backendNodeId !== undefined) return { backendNodeId: handle.backendNodeId };
  if (handle.nodeId !== undefined) return { nodeId: handle.nodeId };
  return {};
}

/** The centre of a box-model content quad (8 numbers). Null if it is degenerate. */
function quadCenter(quad: readonly unknown[]): { x: number; y: number } | null {
  const numbers = quad.filter(isNum);
  if (numbers.length < 8) return null;
  const xs = [quad[0], quad[2], quad[4], quad[6]].filter(isNum);
  const ys = [quad[1], quad[3], quad[5], quad[7]].filter(isNum);
  if (xs.length === 0 || ys.length === 0) return null;
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
}

// ── The transport ─────────────────────────────────────────────────────────────

interface TargetState {
  targetId: string;
  /** Monotonic; moves only on a real change (navigation or DOM mutation). */
  revision: number;
  /** Last page-side mutation count we counted. */
  mutationWatermark: number;
  sessionId: string | null;
  domainsEnabled: boolean;
  url: string;
  title: string;
}

/** Read (and, if needed, install) the page-side MutationObserver, returning its count. */
const MUTATION_COUNT_EXPRESSION = `(() => {
  window.__kaiMutationCount = window.__kaiMutationCount || 0;
  if (!window.__kaiMutationObserver) {
    try {
      window.__kaiMutationObserver = new MutationObserver(function () { window.__kaiMutationCount++; });
      window.__kaiMutationObserver.observe(document, {
        subtree: true, childList: true, characterData: true, attributes: true
      });
    } catch (error) { /* no observer: the counter simply stays put */ }
  }
  return window.__kaiMutationCount;
})()`;

const PAGE_INFO_EXPRESSION = `(() => ({
  url: location.href,
  title: document.title,
  ready: document.readyState
}))()`;

const PAGE_TEXT_EXPRESSION = `(() => {
  if (document.body && typeof document.body.innerText === "string") return document.body.innerText;
  if (document.documentElement && typeof document.documentElement.innerText === "string") return document.documentElement.innerText;
  return "";
})()`;

/**
 * Builds a real browser-backed transport. Resolves to an error value (never
 * throws) when no browser can be launched or attached — the caller decides
 * whether to degrade the capability.
 *
 * Async because "launch a browser" is inherently async; the resulting object is
 * a plain `BrowserTransport`, so `createBrowserCapability({ transport })` takes
 * it unchanged.
 */
export async function createCdpBrowserTransport(
  opts: CdpTransportOptions = {},
): Promise<Result<CdpBrowserTransport>> {
  const now = opts.now ?? (() => new Date());
  const at = now;
  const commandTimeoutMs = opts.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const launchTimeoutMs = opts.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS;
  const waitTimeoutMs = opts.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const settleTimeoutMs = opts.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS;

  let child: ChildProcess | null = null;
  let ownedProfileDir: string | null = null;
  const launched = opts.wsUrl === undefined && opts.port === undefined && opts.endpoint === undefined;

  // ── 1. Establish the DevTools endpoint ─────────────────────────────────────
  let endpoint: string;
  if (opts.wsUrl !== undefined) {
    endpoint = opts.wsUrl;
  } else if (opts.port !== undefined || opts.endpoint !== undefined) {
    const base = (opts.endpoint ?? `http://127.0.0.1:${String(opts.port)}`).replace(/\/+$/, "");
    const version = await fetchJson(`${base}/json/version`, commandTimeoutMs, at);
    if (!version.ok) return version;
    const ws = str(rec(version.value).webSocketDebuggerUrl);
    if (ws === undefined) {
      return fail("AGENT_BAD_RESPONSE", `${base}/json/version did not include webSocketDebuggerUrl`, at);
    }
    endpoint = ws;
  } else {
    const executable = opts.executablePath ?? findExecutable(opts.browser ?? "auto");
    if (executable === null) {
      return fail(
        "NOT_FOUND",
        "no Chromium browser (Edge/Chrome) found; set KAI_BROWSER_PATH or opts.executablePath, or attach with opts.port/opts.endpoint/opts.wsUrl",
        at,
      );
    }
    const userDataDir = opts.userDataDir ?? mkdtempSync(join(tmpdir(), "kai-cdp-browser-"));
    ownedProfileDir = opts.userDataDir === undefined ? userDataDir : null;
    const extraArgs = opts.extraArgs ?? [];

    // Headless first (the default). If the browser refuses `--headless=new` and
    // exits, retry headful once so a quirky build or a locked-down CI still works.
    let result = await launchBrowser(executable, opts.headless !== false, userDataDir, extraArgs, launchTimeoutMs, at);
    if (!result.ok && opts.headless !== false) {
      result = await launchBrowser(executable, false, userDataDir, extraArgs, launchTimeoutMs, at);
    }
    if (!result.ok) return result;
    child = result.value.child;
    endpoint = result.value.endpoint;
  }

  // ── 2. Connect ─────────────────────────────────────────────────────────────
  const connected = await connectCdpClient(endpoint, commandTimeoutMs, at);
  if (!connected.ok) {
    if (child !== null) {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }
    return connected;
  }
  const client = connected.value;

  // ── Transport state ────────────────────────────────────────────────────────
  const targets = new Map<string, TargetState>();
  const sessionToTarget = new Map<string, string>();
  const stats: CdpTransportStats = { observations: 0, actions: 0, screenshots: 0, navigations: 0 };
  let closed = false;

  // The affordances are a property of CDP, not of the page: CDP always exposes a
  // DOM, an accessibility tree and a screenshot, and is itself the native API.
  // Declaring them up-front (rather than probing) is what makes `selectStrategy`
  // deterministic — see interaction.ts on why selection must not be a probe.
  const affordances: TransportAffordances = {
    ...NO_AFFORDANCES,
    nativeApi: true,
    dom: true,
    accessibility: true,
    semanticUi: false,
    screenshot: true,
  };

  // ── Events: the navigation half of the revision signal ─────────────────────

  function bumpNavigation(state: TargetState): void {
    state.revision += 1;
    state.mutationWatermark = 0; // the observer was destroyed with the old document
    stats.navigations += 1;
  }

  client.onEvent((event) => {
    if (event.method === "Page.frameNavigated") {
      const frame = rec(event.params.frame);
      // Child frames navigate too; only a main-frame navigation is a state change
      // of the tab we own (its `parentId` is absent for the main frame).
      if (event.sessionId !== undefined && str(frame.parentId) === undefined) {
        const targetId = sessionToTarget.get(event.sessionId);
        const state = targetId !== undefined ? targets.get(targetId) : undefined;
        if (state !== undefined) bumpNavigation(state);
      }
      return;
    }
    if (event.method === "Page.navigatedWithinDocument") {
      // A hash/history change replaces rendered state without a new document.
      if (event.sessionId !== undefined) {
        const targetId = sessionToTarget.get(event.sessionId);
        const state = targetId !== undefined ? targets.get(targetId) : undefined;
        if (state !== undefined) bumpNavigation(state);
      }
      return;
    }
    if (event.method === "Target.detachedFromTarget") {
      const sessionId = str(event.params.sessionId);
      if (sessionId !== undefined) {
        const targetId = sessionToTarget.get(sessionId);
        sessionToTarget.delete(sessionId);
        if (targetId !== undefined) {
          const state = targets.get(targetId);
          if (state !== undefined) state.sessionId = null;
        }
      }
      return;
    }
    if (event.method === "Target.targetDestroyed") {
      const targetId = str(event.params.targetId);
      if (targetId !== undefined) {
        const state = targets.get(targetId);
        if (state?.sessionId !== null && state?.sessionId !== undefined) sessionToTarget.delete(state.sessionId);
        targets.delete(targetId);
      }
    }
  });

  // ── Target bookkeeping ─────────────────────────────────────────────────────

  function ensureState(targetId: string, url = "", title = ""): TargetState {
    const existing = targets.get(targetId);
    if (existing !== undefined) return existing;
    // A freshly seen target starts at revision 1, not 0: "it exists" is already
    // one state, and a caller caching on 0 would miss the first observation.
    const state: TargetState = {
      targetId,
      revision: 1,
      mutationWatermark: 0,
      sessionId: null,
      domainsEnabled: false,
      url,
      title,
    };
    targets.set(targetId, state);
    return state;
  }

  async function refreshTargets(): Promise<Result<readonly TargetInfo[]>> {
    const response = await client.send("Target.getTargets");
    if (!response.ok) return response;
    const infos = arr(rec(response.value).targetInfos);
    const seen = new Set<string>();
    for (const raw of infos) {
      const info = rec(raw);
      if (str(info.type) !== "page") continue; // ignore extension/service workers
      const targetId = str(info.targetId);
      if (targetId === undefined) continue;
      seen.add(targetId);
      const state = ensureState(targetId, str(info.url) ?? "", str(info.title) ?? "");
      state.url = str(info.url) ?? state.url;
      state.title = str(info.title) ?? state.title;
    }
    // Forget tabs the browser no longer reports, so listTargets() cannot lie.
    for (const targetId of [...targets.keys()]) {
      if (!seen.has(targetId)) {
        const state = targets.get(targetId);
        if (state?.sessionId !== null && state?.sessionId !== undefined) sessionToTarget.delete(state.sessionId);
        targets.delete(targetId);
      }
    }
    return ok([...targets.values()].map(toInfo));
  }

  function toInfo(state: TargetState): TargetInfo {
    return { targetId: state.targetId, url: state.url, title: state.title, revision: state.revision };
  }

  async function requireState(targetId: string): Promise<Result<TargetState>> {
    let state = targets.get(targetId);
    if (state === undefined) {
      const refreshed = await refreshTargets();
      if (!refreshed.ok) return refreshed;
      state = targets.get(targetId);
    }
    if (state === undefined) {
      return fail("NOT_FOUND", `no browser target "${targetId}" is open`, at, targetId);
    }
    return ok(state);
  }

  // ── Sessions (one per tab, multiplexed over the single socket) ─────────────

  async function enableDomains(state: TargetState): Promise<Result<string>> {
    if (state.sessionId !== null && state.domainsEnabled) return ok(state.sessionId);

    let sessionId = state.sessionId;
    if (sessionId === null) {
      const attached = await client.send("Target.attachToTarget", { targetId: state.targetId, flatten: true });
      if (!attached.ok) return attached;
      const id = str(rec(attached.value).sessionId);
      if (id === undefined) return fail("AGENT_BAD_RESPONSE", `attachToTarget returned no sessionId for "${state.targetId}"`, at);
      sessionId = id;
      state.sessionId = id;
      sessionToTarget.set(id, state.targetId);
    }

    // Page/Runtime/DOM are load-bearing; a failure means the session is unusable.
    for (const domain of ["Page.enable", "Runtime.enable", "DOM.enable"]) {
      const enabled = await client.send(domain, {}, sessionId);
      if (!enabled.ok) return enabled;
    }
    // Accessibility is best-effort: a page can still be driven by DOM alone.
    await client.send("Accessibility.enable", {}, sessionId);
    state.domainsEnabled = true;
    return ok(sessionId);
  }

  // ── The cheap change signal ────────────────────────────────────────────────

  async function readMutationCount(sessionId: string): Promise<number | undefined> {
    const response = await client.send(
      "Runtime.evaluate",
      { expression: MUTATION_COUNT_EXPRESSION, returnByValue: true },
      sessionId,
    );
    if (!response.ok) return undefined; // e.g. mid-navigation the context is gone
    return num(rec(rec(response.value).result).value);
  }

  async function revision(targetId: string): Promise<Result<number>> {
    const stateResult = await requireState(targetId);
    if (!stateResult.ok) return stateResult;
    const state = stateResult.value;

    const session = await enableDomains(state);
    if (!session.ok) return session;

    // One Runtime.evaluate: installs the observer on first use (idempotent) and
    // returns the running mutation count. A move of the watermark is a real DOM
    // change, so the revision advances exactly once per change.
    const count = await readMutationCount(session.value);
    if (count !== undefined && count !== state.mutationWatermark) {
      state.mutationWatermark = count;
      state.revision += 1;
    }
    return ok(state.revision);
  }

  // ── Page info helpers ──────────────────────────────────────────────────────

  interface PageInfo {
    url: string;
    title: string;
    ready: string;
  }

  async function pageInfo(sessionId: string): Promise<PageInfo | null> {
    const response = await client.send(
      "Runtime.evaluate",
      { expression: PAGE_INFO_EXPRESSION, returnByValue: true },
      sessionId,
    );
    if (!response.ok) return null;
    const value = rec(rec(response.value).result).value;
    if (!isRecord(value)) return null;
    return { url: str(value.url) ?? "", title: str(value.title) ?? "", ready: str(value.ready) ?? "unknown" };
  }

  async function pageText(sessionId: string): Promise<string> {
    const response = await client.send(
      "Runtime.evaluate",
      { expression: PAGE_TEXT_EXPRESSION, returnByValue: true },
      sessionId,
    );
    if (!response.ok) return "";
    const text = str(rec(rec(response.value).result).value) ?? "";
    return text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text;
  }

  async function domIndex(sessionId: string): Promise<{ info: Map<number, DomNodeInfo>; fallback: SemanticElement[] }> {
    const info = new Map<number, DomNodeInfo>();
    const fallback: SemanticElement[] = [];
    const document = await client.send("DOM.getDocument", { depth: -1, pierce: true }, sessionId);
    if (document.ok) walkDom(rec(document.value).root, info, fallback);
    return { info, fallback };
  }

  // ── Node resolution ────────────────────────────────────────────────────────

  async function resolveNode(sessionId: string, ref: string): Promise<Result<NodeHandle>> {
    const parsed = parseRef(ref);
    if (parsed === null) {
      return fail("VALIDATION_FAILED", `unrecognised element ref "${ref}" (expected ax:<id>, dom:<nodeId> or dom:css=<selector>)`, at);
    }
    if (parsed.selector !== undefined) {
      const document = await client.send("DOM.getDocument", { depth: 0 }, sessionId);
      if (!document.ok) return document;
      const rootId = num(rec(rec(document.value).root).nodeId);
      if (rootId === undefined) return fail("INTERNAL", "DOM.getDocument returned no root nodeId", at);
      const found = await client.send("DOM.querySelector", { nodeId: rootId, selector: parsed.selector }, sessionId);
      if (!found.ok) return found;
      const nodeId = num(rec(found.value).nodeId);
      // querySelector reports "no match" as nodeId 0, which is a NOT_FOUND here.
      if (nodeId === undefined || nodeId === 0) {
        return fail("NOT_FOUND", `no element matches selector "${parsed.selector}"`, at, ref);
      }
      return ok({ nodeId });
    }
    return ok(parsed);
  }

  async function objectIdFor(sessionId: string, handle: NodeHandle): Promise<Result<string>> {
    const resolved = await client.send("DOM.resolveNode", nodeParams(handle), sessionId);
    if (!resolved.ok) return resolved;
    const objectId = str(rec(rec(resolved.value).object).objectId);
    if (objectId === undefined) {
      // A node with no JS wrapper (e.g. a detached or non-JS object) cannot be
      // driven by callFunctionOn. Report it rather than acting on nothing.
      return fail("NOT_FOUND", "could not resolve the element to a live JS object", at);
    }
    return ok(objectId);
  }

  // ── Wait / settle ──────────────────────────────────────────────────────────

  /** Polls until the page reports `complete` or the budget runs out. Best-effort. */
  async function waitForSettle(sessionId: string, budgetMs: number): Promise<string> {
    const deadline = Date.now() + budgetMs;
    let ready = "unknown";
    for (;;) {
      const info = await pageInfo(sessionId);
      if (info !== null) ready = info.ready;
      if (ready === "complete" || Date.now() >= deadline) break;
      await sleep(50);
    }
    return ready;
  }

  /**
   * Polls pageInfo until the tab actually shows the document we asked for, then
   * returns that reading (or the last one seen, bounded by `budgetMs`).
   *
   * ── The race this closes ────────────────────────────────────────────────────
   * `Target.createTarget({ url })` resolves as soon as the new target EXISTS —
   * BEFORE the requested navigation commits. For fast local documents (a
   * `file://` fixture, a `data:` URL) the target still exposes its initial empty
   * document for a few milliseconds: `location.href` is `"about:blank"`, the
   * title is empty and `Accessibility.getFullAXTree` is empty. A single
   * `pageInfo()` read right after `createTarget` (see openTarget) could sample
   * exactly that pre-commit state, so the returned TargetInfo — and the caller's
   * first `observe()` — described `about:blank` instead of the page. This was
   * load-dependent, which is why it failed once in a busy full-suite run and
   * passed in isolation.
   *
   * The fix waits on the REAL signal: the committed URL leaving `about:blank`
   * (unless we asked for `about:blank`) AND `readyState === "complete"`. No fixed
   * sleep; bounded by the caller's budget so a page that never finishes loading
   * cannot hang the open.
   */
  async function waitForDocument(
    sessionId: string,
    requestedUrl: string,
    budgetMs: number,
  ): Promise<PageInfo | null> {
    const deadline = Date.now() + budgetMs;
    const wantsBlank = requestedUrl === "" || requestedUrl === "about:blank";
    let last: PageInfo | null = null;
    for (;;) {
      const info = await pageInfo(sessionId);
      if (info !== null) {
        last = info;
        const committed = wantsBlank || (info.url !== "" && info.url !== "about:blank");
        if (committed && info.ready === "complete") return info;
      }
      if (Date.now() >= deadline) return last;
      await sleep(50);
    }
  }

  /**
   * After a mutating action, poll the revision briefly so `changed` is a fact
   * rather than a race between our read and the page's mutation event.
   */
  async function settleRevision(targetId: string, before: number, state: TargetState): Promise<boolean> {
    const deadline = Date.now() + settleTimeoutMs;
    for (;;) {
      const current = await revision(targetId);
      if (current.ok && current.value !== before) return true;
      if (Date.now() >= deadline) return state.revision !== before;
      await sleep(50);
    }
  }

  // ── BrowserTransport: affordances / tabs ───────────────────────────────────

  async function openTarget(input?: { url?: string }): Promise<Result<TargetInfo>> {
    const url = input?.url ?? "about:blank";
    const created = await client.send("Target.createTarget", { url });
    if (!created.ok) return created;
    const targetId = str(rec(created.value).targetId);
    if (targetId === undefined) return fail("AGENT_BAD_RESPONSE", "Target.createTarget returned no targetId", at);

    const state = ensureState(targetId, url, "");
    // Attach eagerly so the tab's very first navigation is captured for revision.
    const session = await enableDomains(state);
    if (session.ok) {
      // RACE: Target.createTarget resolves as soon as the target exists, BEFORE
      // the requested document commits, so a single pageInfo() read here could
      // return the initial empty `about:blank` document (empty title / empty AX
      // tree) for a fast local page. Wait (bounded) for the real commit+load
      // signal before reporting the target, so the returned TargetInfo and the
      // caller's first observe() describe the page we asked for. See
      // waitForDocument for the full interleaving.
      const info = await waitForDocument(session.value, url, waitTimeoutMs);
      if (info !== null) {
        state.url = info.url;
        state.title = info.title;
      }
    }
    return ok(toInfo(state));
  }

  async function closeTarget(targetId: string): Promise<Result<{ targetId: string }>> {
    const response = await client.send("Target.closeTarget", { targetId });
    if (!response.ok) return response;
    const state = targets.get(targetId);
    if (state?.sessionId !== null && state?.sessionId !== undefined) sessionToTarget.delete(state.sessionId);
    targets.delete(targetId);
    // `success: false` means the id was not a live target.
    if (rec(response.value).success === false && state === undefined) {
      return fail("NOT_FOUND", `no browser target "${targetId}" to close`, at, targetId);
    }
    return ok({ targetId });
  }

  async function listTargets(): Promise<Result<readonly TargetInfo[]>> {
    return refreshTargets();
  }

  // ── BrowserTransport: observe ──────────────────────────────────────────────

  function screenshotRef(base64: string): string {
    // No blobs cross the seam: the screenshot is an opaque, content-addressed
    // handle (hash + size), exactly like FakeTransport's `shot:` reference.
    const digest = createHash("sha256").update(base64, "base64").digest("hex").slice(0, 16);
    return `cdp-shot:sha256:${digest}:${base64.length}`;
  }

  async function observe(request: ObserveRequest): Promise<Result<ObservedPage>> {
    const stateResult = await requireState(request.targetId);
    if (!stateResult.ok) return stateResult;
    const state = stateResult.value;

    const session = await enableDomains(state);
    if (!session.ok) return session;
    const sessionId = session.value;

    const revisionResult = await revision(request.targetId);
    const currentRevision = revisionResult.ok ? revisionResult.value : state.revision;
    let info = await pageInfo(sessionId);
    // A target that was JUST opened can still be mid-commit for a few ms (see
    // waitForDocument/openTarget). Never snapshot that stale initial document:
    // if this read shows the empty about:blank while the target's known URL is a
    // real document, wait for the real document (bounded), then re-read. Without
    // this, an observe() racing a fresh open returned about:blank, no title and
    // an empty element list — the flaky assertion in the real-browser test.
    if (
      info !== null &&
      (info.url === "" || info.url === "about:blank") &&
      state.url !== "" &&
      state.url !== "about:blank"
    ) {
      info = await waitForDocument(sessionId, state.url, waitTimeoutMs);
    }
    if (info !== null) {
      state.url = info.url;
      state.title = info.title;
    }
    const url = info?.url ?? state.url;
    const title = info?.title ?? state.title;

    if (request.strategy === "screenshot") {
      stats.screenshots += 1;
      const captured = await client.send("Page.captureScreenshot", { format: "png" }, sessionId);
      if (!captured.ok) return captured;
      const data = str(rec(captured.value).data);
      if (data === undefined) return fail("AGENT_BAD_RESPONSE", "Page.captureScreenshot returned no data", at);
      const page: ObservedPage = {
        targetId: request.targetId,
        revision: currentRevision,
        url,
        title,
        strategy: "screenshot",
        screenshot: screenshotRef(data),
      };
      return ok(page);
    }

    // Semantic observation. `request.query` is deliberately ignored here: the
    // capability caches this observation and reuses it for `find` AND `read`, so
    // the transport must return the FULL element set, never a pre-filtered slice.
    const { info: domNodes, fallback } = await domIndex(sessionId);
    const axTree = await client.send("Accessibility.getFullAXTree", {}, sessionId);
    let elements: SemanticElement[];
    if (axTree.ok) {
      elements = elementsFromAx(arr(rec(axTree.value).nodes), domNodes);
    } else {
      // Accessibility genuinely unavailable: degrade to the DOM-derived view
      // rather than failing — still semantics, still no pixels.
      elements = fallback.slice(0, MAX_ELEMENTS);
    }
    const text = await pageText(sessionId);

    stats.observations += 1;
    const page: ObservedPage = {
      targetId: request.targetId,
      revision: currentRevision,
      url,
      title,
      strategy: request.strategy,
      elements,
      ...(text !== "" ? { text } : {}),
    };
    return ok(page);
  }

  // ── BrowserTransport: act ──────────────────────────────────────────────────

  async function act(request: ActRequest): Promise<Result<ActOutcome>> {
    if (!(BROWSER_ACTIONS as readonly string[]).includes(request.action)) {
      return fail("VALIDATION_FAILED", `unsupported browser action "${String(request.action)}"`, at);
    }
    const action = request.action;
    const input = request.input;
    stats.actions += 1;

    // Tab lifecycle is handled here too, so a direct transport caller gets the
    // same behaviour the capability's router already assumes.
    if (action === "open" || action === "new_tab") {
      const opened = await openTarget(typeof input.url === "string" ? { url: input.url } : undefined);
      if (!opened.ok) return opened;
      return ok({ targetId: opened.value.targetId, action, revision: opened.value.revision, changed: true, detail: `opened ${opened.value.url}` });
    }
    if (action === "close_tab") {
      const targetId = typeof input.targetId === "string" ? input.targetId : request.targetId;
      const closed = await closeTarget(targetId);
      if (!closed.ok) return closed;
      return ok({ targetId, action, revision: 0, changed: true, detail: "closed the tab" });
    }

    const stateResult = await requireState(request.targetId);
    if (!stateResult.ok) return stateResult;
    const state = stateResult.value;
    const session = await enableDomains(state);
    if (!session.ok) return session;
    const sessionId = session.value;

    const beforeResult = await revision(request.targetId);
    const before = beforeResult.ok ? beforeResult.value : state.revision;

    let bump = false;
    let settle = false;
    let detail = "";
    let result: unknown;

    switch (action) {
      case "navigate": {
        const url = typeof input.url === "string" ? input.url : "about:blank";
        const navigated = await client.send("Page.navigate", { url }, sessionId);
        if (!navigated.ok) return navigated;
        // A navigation is a state change by definition; the frameNavigated event
        // will usually bump as well, which is harmless for an equality compare.
        bump = true;
        await waitForSettle(sessionId, waitTimeoutMs);
        detail = `navigated to ${url}`;
        break;
      }
      case "back":
      case "forward": {
        const history = await client.send("Page.getNavigationHistory", {}, sessionId);
        if (!history.ok) return history;
        const entries = arr(rec(history.value).entries);
        const index = num(rec(history.value).currentIndex) ?? 0;
        const next = action === "back" ? index - 1 : index + 1;
        if (next < 0 || next >= entries.length) {
          detail = "no history entry in that direction; nothing to do";
          break; // not a change and not an error
        }
        const entryId = num(rec(entries[next]).id);
        if (entryId === undefined) return fail("INTERNAL", "navigation history entry had no id", at);
        const moved = await client.send("Page.navigateToHistoryEntry", { entryId }, sessionId);
        if (!moved.ok) return moved;
        bump = true;
        await waitForSettle(sessionId, waitTimeoutMs);
        detail = `went ${action} through history`;
        break;
      }
      case "click": {
        const ref = typeof input.ref === "string" ? input.ref : "";
        const handle = await resolveNode(sessionId, ref);
        if (!handle.ok) return handle;
        // Best effort: make sure the element is on screen before we click it.
        await client.send("DOM.scrollIntoViewIfNeeded", nodeParams(handle.value), sessionId);

        const box = await client.send("DOM.getBoxModel", nodeParams(handle.value), sessionId);
        const center = box.ok ? quadCenter(arr(rec(rec(box.value).model).content)) : null;
        if (center !== null) {
          // A real mouse press/release at the element's centre: this is what a
          // user does, and it fires the page's own listeners. (Verified: the
          // box-model content quad is in viewport coordinates, so these are the
          // coordinates Input.dispatchMouseEvent expects.)
          await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: center.x, y: center.y, button: "left", clickCount: 1 }, sessionId);
          await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: center.x, y: center.y, button: "left", clickCount: 1 }, sessionId);
          detail = `clicked ${ref} at (${Math.round(center.x)}, ${Math.round(center.y)})`;
        } else {
          // No layout box (off-screen, zero-size, or display:none): fall back to
          // invoking the element's own click() semantically.
          const objectId = await objectIdFor(sessionId, handle.value);
          if (!objectId.ok) return objectId;
          const invoked = await client.send(
            "Runtime.callFunctionOn",
            { objectId: objectId.value, functionDeclaration: "function () { this.click(); }", returnByValue: true },
            sessionId,
          );
          if (!invoked.ok) return invoked;
          detail = `invoked click() on ${ref} (no layout box)`;
        }
        // A click that mutates the DOM is detected by the mutation counter; give
        // it a moment so `changed` reflects the page rather than our read speed.
        settle = true;
        break;
      }
      case "type": {
        const ref = typeof input.ref === "string" ? input.ref : "";
        const text = typeof input.text === "string" ? input.text : "";
        const handle = await resolveNode(sessionId, ref);
        if (!handle.ok) return handle;
        const focused = await client.send("DOM.focus", nodeParams(handle.value), sessionId);
        if (!focused.ok) return focused;
        const typed = await client.send("Input.insertText", { text }, sessionId);
        if (!typed.ok) return typed;
        // An <input> value is a JS property, not a DOM mutation, so the observer
        // cannot see it — the transport bumps explicitly to keep `changed` honest.
        bump = true;
        detail = `typed ${text.length} character(s) into ${ref}`;
        break;
      }
      case "select": {
        const ref = typeof input.ref === "string" ? input.ref : "";
        const value = typeof input.value === "string" ? input.value : "";
        const handle = await resolveNode(sessionId, ref);
        if (!handle.ok) return handle;
        const objectId = await objectIdFor(sessionId, handle.value);
        if (!objectId.ok) return objectId;
        const applied = await client.send(
          "Runtime.callFunctionOn",
          {
            objectId: objectId.value,
            functionDeclaration:
              "function (value) { this.value = value; this.dispatchEvent(new Event('input', { bubbles: true })); this.dispatchEvent(new Event('change', { bubbles: true })); return this.value; }",
            arguments: [{ value }],
            returnByValue: true,
          },
          sessionId,
        );
        if (!applied.ok) return applied;
        result = { value: str(rec(rec(applied.value).result).value) ?? value };
        bump = true;
        detail = `selected ${value} on ${ref}`;
        break;
      }
      case "scroll": {
        const direction = typeof input.direction === "string" ? input.direction : "down";
        const step = 600;
        const dx = direction === "right" ? step : direction === "left" ? -step : 0;
        const dy = direction === "down" ? step : direction === "up" ? -step : 0;
        const scrolled = await client.send(
          "Runtime.evaluate",
          { expression: `window.scrollBy(${String(dx)}, ${String(dy)}); ({ x: window.scrollX, y: window.scrollY })`, returnByValue: true },
          sessionId,
        );
        if (!scrolled.ok) return scrolled;
        result = rec(rec(scrolled.value).result).value;
        // Scrolling is not itself a DOM mutation; if it lazily rendered new DOM
        // the mutation counter moves and the revision advances on its own.
        detail = `scrolled ${direction}`;
        break;
      }
      case "wait": {
        // The capability passes only a targetId, so `wait` means "until the page
        // is settled": poll readyState to `complete`, bounded by a timeout.
        const ready = await waitForSettle(sessionId, waitTimeoutMs);
        result = { ready };
        detail = `waited for the page to settle (readyState=${ready})`;
        break;
      }
      case "read": {
        const text = await pageText(sessionId);
        result = { text };
        detail = `read ${text.length} character(s) of page text`;
        break;
      }
      case "find":
      case "inspect": {
        // Observation is served by observe(); the capability calls it, not act().
        detail = "observation is served by observe()";
        break;
      }
      case "switch_tab": {
        const activated = await client.send("Target.activateTarget", { targetId: request.targetId });
        if (!activated.ok) return activated;
        await client.send("Page.bringToFront", {}, sessionId);
        detail = `activated tab ${request.targetId}`;
        break;
      }
      default:
        return fail("VALIDATION_FAILED", `unsupported browser action "${String(action)}"`, at);
    }

    if (bump) {
      state.revision += 1;
      state.mutationWatermark = 0;
    }
    const changed = bump ? true : settle ? await settleRevision(request.targetId, before, state) : false;

    const afterResult = await revision(request.targetId);
    const revisionAfter = afterResult.ok ? afterResult.value : state.revision;
    return ok({
      targetId: request.targetId,
      action,
      revision: revisionAfter,
      changed,
      ...(detail !== "" ? { detail } : {}),
      ...(result !== undefined ? { result } : {}),
    });
  }

  // ── BrowserTransport object ────────────────────────────────────────────────

  const transport: CdpBrowserTransport = {
    id: "cdp",
    affordances: () => ({ ...affordances }),
    revision,
    openTarget,
    closeTarget,
    listTargets,
    observe,
    act,
    endpoint: () => endpoint,
    launched: () => launched,
    stats: () => ({ ...stats }),

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      client.close();
      if (child !== null) {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
      }
      if (ownedProfileDir !== null) {
        // Best-effort: a Windows lock on the profile must not make close() fail.
        try {
          rmSync(ownedProfileDir, { recursive: true, force: true });
        } catch {
          /* leave the temp dir for the OS to reap */
        }
      }
    },
  };

  return ok(transport);
}

export default createCdpBrowserTransport;
