// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The browser interaction hierarchy — the ordered answer to "how do I look at,
 * and act on, a page?".
 *
 * KAI's rule is that pixels are the LAST resort, never the first. The order
 * below is the whole design of this capability:
 *
 *   1. native_api     a protocol/CLI channel that talks to the browser or an
 *                     automation service directly (CDP, a browser CLI, a native
 *                     automation API). Structured, addressable, no guessing.
 *   2. dom            the page-aware DOM: query and act on elements by role/name/
 *                     selector. Page semantics without a full a11y tree.
 *   3. accessibility  the accessibility tree: roles, names, states. Usually the
 *                     best fit for "click the control named Save".
 *   4. semantic_ui    a native semantic UI surface the OS or app exposes.
 *   5. screenshot     pixels. A FALLBACK and a VERIFICATION mechanism only.
 *
 * Why this is a module and not a comment: the screenshot -> guess coordinates ->
 * click -> screenshot loop is slow, flaky and expensive, and it is exactly what
 * this capability must not become. So the choice of channel is a value —
 * `StrategyDecision` — that names the channel AND says why it was chosen, letting
 * a caller (or a test) prove that pixels were never picked while semantics were
 * on offer.
 *
 * This file is pure: no transport, no I/O. Selection reads a transport's declared
 * `TransportAffordances` and nothing else, so it is trivially testable and cannot
 * itself reach the network or the screen.
 */

import { isRecord } from "../../shared/contracts.ts";

/**
 * A channel through which a page can be inspected or driven. Ordered by fidelity
 * in `INTERACTION_HIERARCHY`; the order is load-bearing and must not be sorted
 * alphabetically anywhere.
 */
export type InteractionStrategy =
  | "native_api"
  | "dom"
  | "accessibility"
  | "semantic_ui"
  | "screenshot";

/** Every strategy except the pixel fallback. Present so callers can reason about
 * "is there ANY semantic channel?" without enumerating the union by hand. */
export type SemanticStrategy = Exclude<InteractionStrategy, "screenshot">;

/**
 * Highest fidelity first, pixels last. Read as "the order in which KAI is willing
 * to look at a page".
 */
export const INTERACTION_HIERARCHY: readonly InteractionStrategy[] = [
  "native_api",
  "dom",
  "accessibility",
  "semantic_ui",
  "screenshot",
];

export const SEMANTIC_STRATEGIES: readonly SemanticStrategy[] = [
  "native_api",
  "dom",
  "accessibility",
  "semantic_ui",
];

/**
 * What a transport can actually do, per level. A transport must be honest here:
 * reporting `dom: true` when it can only screenshot would make KAI believe it has
 * semantics it does not have, which is the one failure this file exists to
 * prevent. `screenshot` is the only field a minimal transport may set.
 */
export interface TransportAffordances {
  /** A direct protocol/CLI channel (CDP, a browser CLI, a native automation API). */
  nativeApi: boolean;
  /** A page-aware DOM with addressable elements. */
  dom: boolean;
  /** An accessibility tree with roles/names/states. */
  accessibility: boolean;
  /** A native semantic UI surface (platform accessibility, not the page DOM). */
  semanticUi: boolean;
  /** Pixels. Fallback and verification only. */
  screenshot: boolean;
}

/** A transport that can do nothing. Spelled out rather than inferred so a new
 * affordance field is a compile error here, not a silent `undefined`. */
export const NO_AFFORDANCES: TransportAffordances = {
  nativeApi: false,
  dom: false,
  accessibility: false,
  semanticUi: false,
  screenshot: false,
};

/** True when the transport declares this channel usable. */
export function affordanceFor(a: TransportAffordances, strategy: InteractionStrategy): boolean {
  switch (strategy) {
    case "native_api":
      return a.nativeApi;
    case "dom":
      return a.dom;
    case "accessibility":
      return a.accessibility;
    case "semantic_ui":
      return a.semanticUi;
    case "screenshot":
      return a.screenshot;
  }
}

/** True when at least one non-pixel channel is available. */
export function hasSemanticChannel(a: TransportAffordances): boolean {
  return SEMANTIC_STRATEGIES.some((strategy) => affordanceFor(a, strategy));
}

/** One hierarchy level as considered during selection. Kept for the audit trail:
 * a decision must be able to explain what it rejected, not only what it picked. */
export interface StrategyCandidate {
  strategy: InteractionStrategy;
  available: boolean;
  /** Why this level was or was not usable. */
  detail: string;
}

/**
 * The chosen channel and the reasoning. `reason` is written to be read by a human
 * later ("why did KAI screenshot this?"); `considered` is the full ladder so a
 * reviewer can see that a higher-fidelity option was genuinely absent, not
 * overlooked.
 */
export interface StrategyDecision {
  strategy: InteractionStrategy;
  reason: string;
  considered: readonly StrategyCandidate[];
  /** True when the only usable channel is pixels. */
  fallbackToPixels: boolean;
}

/** Per-level explanation fragments, kept here so every decision reads uniformly. */
const LEVEL_LABEL: Readonly<Record<InteractionStrategy, string>> = {
  native_api: "native API / CLI",
  dom: "page-aware DOM",
  accessibility: "accessibility tree",
  semantic_ui: "native semantic UI",
  screenshot: "screenshot / pixels",
};

const LEVEL_VALUE: Readonly<Record<InteractionStrategy, string>> = {
  native_api: "the highest-fidelity channel: structured requests and responses, no coordinate guessing",
  dom: "structured page data: elements can be addressed by role, name or selector",
  accessibility: "structured roles, names and states; a sound basis for semantic actions",
  semantic_ui: "a native semantic surface, still structured rather than pixels",
  screenshot: "pixels only: usable as a fallback or a verification step, never as the source of truth",
};

/**
 * Picks the highest-fidelity channel the transport declares, and records why.
 *
 * This is deliberately a plain function over declared affordances rather than a
 * probe: KAI must decide how it will look at a page *before* it looks, otherwise
 * "fallback to pixels" silently becomes "default to pixels". A transport that
 * wants to be driven semantically must say so.
 */
export function selectStrategy(affordances: TransportAffordances): StrategyDecision {
  const considered: StrategyCandidate[] = INTERACTION_HIERARCHY.map((strategy) => {
    const available = affordanceFor(affordances, strategy);
    return {
      strategy,
      available,
      detail: available
        ? `${LEVEL_LABEL[strategy]} is available: ${LEVEL_VALUE[strategy]}`
        : `${LEVEL_LABEL[strategy]} is not available on this transport`,
    };
  });

  const chosen = INTERACTION_HIERARCHY.find((strategy) => affordanceFor(affordances, strategy));

  if (chosen === undefined) {
    // No channel at all. We still return a decision (screenshot) rather than
    // throwing: the capability's health() is where "cannot see" belongs, and the
    // transport will reject the observation with a KaiError value.
    return {
      strategy: "screenshot",
      reason:
        "the transport declares no usable channel (no native API, DOM, accessibility tree, " +
        "semantic UI or screenshot); selecting the pixel fallback so the failure surfaces as an " +
        "explicit transport error rather than a silent no-op",
      considered,
      fallbackToPixels: true,
    };
  }

  if (chosen === "screenshot") {
    return {
      strategy: "screenshot",
      reason:
        "no semantic channel is available — native API, DOM, accessibility tree and native " +
        "semantic UI are all unavailable; falling back to pixels as a last resort (screenshots " +
        "are a fallback and a verification mechanism, never the default source of truth)",
      considered,
      fallbackToPixels: true,
    };
  }

  return {
    strategy: chosen,
    reason: `${LEVEL_LABEL[chosen]} is the highest-fidelity channel this transport offers: ${LEVEL_VALUE[chosen]}`,
    considered,
    fallbackToPixels: false,
  };
}

function isInteractionStrategy(value: unknown): value is InteractionStrategy {
  return typeof value === "string" && (INTERACTION_HIERARCHY as readonly string[]).includes(value);
}

/** Shape guard: affordances cross a transport seam and may be malformed. */
export function isTransportAffordances(value: unknown): value is TransportAffordances {
  if (!isRecord(value)) return false;
  return (
    typeof value.nativeApi === "boolean" &&
    typeof value.dom === "boolean" &&
    typeof value.accessibility === "boolean" &&
    typeof value.semanticUi === "boolean" &&
    typeof value.screenshot === "boolean"
  );
}

export { isInteractionStrategy };
