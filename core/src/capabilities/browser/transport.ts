// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The browser transport seam.
 *
 * This is the ONE place a real browser dependency would attach. The capability
 * (capability.ts) never touches a browser directly; it speaks to a
 * `BrowserTransport`, and the tests speak to a `FakeTransport`. That keeps the
 * control plane free of Playwright/Puppeteer/CDP imports while making the plug-in
 * point explicit and typed.
 *
 * Why an interface with these five affordances rather than one `execute()`:
 *
 *   - `affordances()` declares which rungs of the interaction hierarchy the
 *     transport can serve. Selection (interaction.ts) reads this and nothing
 *     else, so KAI can never "accidentally" screenshot a page whose DOM it can
 *     read.
 *   - `revision(targetId)` is the cheap "did anything change?" probe. It is what
 *     lets the capability re-inspect only after a genuine state change instead of
 *     after every action — the difference between inspect-once-then-act and the
 *     screenshot-per-step loop.
 *   - `observe()` returns structured page data (elements, text) for a semantic
 *     channel, or an opaque pixel reference for the screenshot channel. It never
 *     returns raw image bytes: Core does not carry blobs.
 *   - `act()` performs an action over a caller-chosen channel.
 *   - the target methods (`openTarget`/`closeTarget`/`listTargets`) own tab/window
 *     lifecycle, which is what the ownership layer (ownership.ts) arbitrates.
 *
 * Everything returns a value. A transport failure is a `KaiError`, never a thrown
 * exception at this boundary — an unreachable browser must degrade, not crash KAI
 * (spec Part M).
 *
 * Honesty note for this phase: no real transport is wired yet. `FakeTransport`
 * implements this interface so the capability, the hierarchy and the ownership
 * rules are exercised for real, but they are exercised against a fake page model.
 */

import type { KaiError, RiskLevel } from "../../shared/contracts.ts";
import type { InteractionStrategy, TransportAffordances } from "./interaction.ts";

/** The uniform result: a value, or a typed error. Errors are values. */
export type Result<T> = { ok: true; value: T } | { ok: false; error: KaiError };

/**
 * The full action set of the browser capability. This list is the contract the
 * capability advertises through `Capability.supportedActions`; keep it and the
 * routing switch in capability.ts in step.
 */
export type BrowserAction =
  | "open"
  | "navigate"
  | "find"
  | "inspect"
  | "click"
  | "type"
  | "select"
  | "scroll"
  | "wait"
  | "read"
  | "back"
  | "forward"
  | "new_tab"
  | "close_tab"
  | "switch_tab";

export const BROWSER_ACTIONS: readonly BrowserAction[] = [
  "open",
  "navigate",
  "find",
  "inspect",
  "click",
  "type",
  "select",
  "scroll",
  "wait",
  "read",
  "back",
  "forward",
  "new_tab",
  "close_tab",
  "switch_tab",
];

/**
 * The risk of each individual action. The capability's own `risk` is the maximum
 * over this table — a capability that under-reports the risk of its worst action
 * is a policy hole (contracts.ts, `Capability.risk`).
 *
 * Reading is READ. Driving the page (click/type/select/scroll) mutates state, so
 * WRITE. Reaching the network or opening/closing a browsing context is EXTERNAL.
 */
export const ACTION_RISK: Readonly<Record<BrowserAction, RiskLevel>> = {
  inspect: "READ",
  find: "READ",
  read: "READ",
  wait: "READ",
  switch_tab: "READ",
  click: "WRITE",
  type: "WRITE",
  select: "WRITE",
  scroll: "WRITE",
  close_tab: "WRITE",
  open: "EXTERNAL",
  navigate: "EXTERNAL",
  back: "EXTERNAL",
  forward: "EXTERNAL",
  new_tab: "EXTERNAL",
};

export function isBrowserAction(value: unknown): value is BrowserAction {
  return typeof value === "string" && (BROWSER_ACTIONS as readonly string[]).includes(value);
}

/** The highest risk any action carries — what the capability must declare. */
export function maxActionRisk(): RiskLevel {
  const order: readonly RiskLevel[] = ["READ", "WRITE", "EXTERNAL", "DESTRUCTIVE"];
  let highest: RiskLevel = "READ";
  for (const action of BROWSER_ACTIONS) {
    if (order.indexOf(ACTION_RISK[action]) > order.indexOf(highest)) highest = ACTION_RISK[action];
  }
  return highest;
}

/** One addressable page element, as reported by a semantic channel. */
export interface SemanticElement {
  /**
   * A handle valid within the observation's revision. Callers pass it back to
   * click/type/select. It is NOT a durable id: a new revision may renumber it,
   * which is exactly why the revision is carried alongside.
   */
  ref: string;
  role: string;
  name?: string;
  text?: string;
  value?: string;
  kind?: string;
  disabled?: boolean;
}

/** A browsing context (tab/window) known to the transport. */
export interface TargetInfo {
  targetId: string;
  url: string;
  title: string;
  revision: number;
}

/**
 * The result of looking at a page. Which fields are populated depends on the
 * channel: a semantic channel fills `elements`/`text`; the screenshot channel
 * fills `screenshot` with an opaque reference (never raw bytes).
 */
export interface ObservedPage {
  targetId: string;
  revision: number;
  url: string;
  title: string;
  /** The channel that produced this observation. */
  strategy: InteractionStrategy;
  elements?: readonly SemanticElement[];
  text?: string;
  /** Opaque pixel reference (a path/hash/handle), not image data. */
  screenshot?: string;
}

export interface ObserveRequest {
  targetId: string;
  strategy: InteractionStrategy;
  /** Optional filter for `find`; a transport may pre-filter or return all. */
  query?: string;
}

export interface ActRequest {
  targetId: string;
  action: BrowserAction;
  input: Record<string, unknown>;
  /** Which channel to drive through — chosen by the capability, honoured here. */
  strategy: InteractionStrategy;
}

export interface ActOutcome {
  targetId: string;
  action: BrowserAction;
  /** Revision AFTER the action. Compare with the pre-action revision to decide
   * whether a re-inspection is genuinely needed. */
  revision: number;
  /** True when the transport observed a real state change. */
  changed: boolean;
  detail?: string;
  result?: unknown;
}

export interface BrowserTransport {
  readonly id: string;

  /** Which rungs of the hierarchy this transport can serve. Must be honest. */
  affordances(): TransportAffordances;

  /**
   * Monotonic per-target state revision. Cheap and side-effect free. Increments
   * only when the page state actually changed, which is what makes
   * "re-inspect only when state changed" decidable without counting calls.
   */
  revision(targetId: string): Promise<Result<number>>;

  openTarget(input?: { url?: string }): Promise<Result<TargetInfo>>;
  closeTarget(targetId: string): Promise<Result<{ targetId: string }>>;
  listTargets(): Promise<Result<readonly TargetInfo[]>>;

  observe(request: ObserveRequest): Promise<Result<ObservedPage>>;
  act(request: ActRequest): Promise<Result<ActOutcome>>;
}

/**
 * Builds a KaiError with the frozen shape. Re-exported here only as a local
 * convenience; contracts.ts owns the type.
 */
export function transportError(
  code: KaiError["code"],
  message: string,
  detail?: string,
  now: () => Date = () => new Date(),
): KaiError {
  const error: KaiError = { code, message, retryable: false, at: now().toISOString() };
  if (detail !== undefined) error.detail = detail;
  return error;
}
