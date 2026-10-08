// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * FakeTransport — an in-memory `BrowserTransport` for the tests.
 *
 * It exists to prove things a mock can prove and a real browser cannot easily:
 *
 *   - that the capability picks the highest-fidelity channel available and never
 *     touches pixels while a semantic channel is on offer (`screenshotCalls`),
 *   - that a re-inspection happens only after `revision()` really moved,
 *   - that a transport which DELIBERATELY WITHHOLDS semantics (`affordances()`
 *     returning `dom: false` etc.) drives KAI down the hierarchy to the pixel
 *     fallback, and that it says so.
 *
 * A page here is a small record: url, title, a revision counter, a list of
 * elements and some text. Mutating actions bump the revision according to a
 * configurable map, defaulting to realistic values (click/type/navigate change
 * state; scroll and wait do not, because a scroll that reveals nothing new is
 * the common case that must NOT trigger a re-inspection).
 *
 * This is a FAKE transport: it models a page, it does not render one. No real
 * browser is driven anywhere in this phase.
 */

import type { KaiError } from "../../shared/contracts.ts";
import {
  NO_AFFORDANCES,
  type InteractionStrategy,
  type TransportAffordances,
} from "./interaction.ts";
import {
  BROWSER_ACTIONS,
  type ActOutcome,
  type ActRequest,
  type BrowserAction,
  type BrowserTransport,
  type ObservedPage,
  type ObserveRequest,
  type Result,
  type SemanticElement,
  type TargetInfo,
} from "./transport.ts";

/** One seeded target for the fake page model. */
export interface FakeTargetSpec {
  url?: string;
  title?: string;
  elements?: readonly SemanticElement[];
  text?: string;
}

export interface FakeTransportOptions {
  id?: string;
  /** Defaults to a full semantic transport (native API + DOM + a11y + screenshot). */
  affordances?: Partial<TransportAffordances>;
  /** Targets present at construction. */
  targets?: readonly FakeTargetSpec[];
  /** Per-action revision bump. Unlisted actions fall back to the defaults below. */
  revisionBump?: Partial<Record<BrowserAction, number>>;
  now?: () => Date;
}

/** A transport-level call, recorded so a test can assert which channel was used. */
export interface FakeCall {
  kind: "observe" | "act";
  targetId: string;
  action: BrowserAction;
  strategy: InteractionStrategy;
}

export interface FakeStats {
  /** Observations served over a semantic channel. */
  observeCalls: number;
  /** Actions performed. */
  actCalls: number;
  /** Observations served over the screenshot channel — the pixel fallback. */
  screenshotCalls: number;
  /** Revisions read. */
  revisionCalls: number;
}

const DEFAULT_BUMP: Readonly<Record<BrowserAction, number>> = {
  // Navigation and page mutation change the page, so they move the revision.
  navigate: 1,
  back: 1,
  forward: 1,
  click: 1,
  type: 1,
  select: 1,
  // Scroll and wait frequently change nothing at all. Leaving them at 0 is what
  // makes "no re-inspection without a real change" observable in a test.
  scroll: 0,
  wait: 0,
  // Reads never change state.
  inspect: 0,
  find: 0,
  read: 0,
  // Tab lifecycle is handled through openTarget/closeTarget, not act().
  open: 0,
  new_tab: 0,
  close_tab: 0,
  switch_tab: 0,
};

const DEFAULT_ELEMENTS: readonly SemanticElement[] = [
  { ref: "e1", role: "input", kind: "text", name: "Search" },
  { ref: "e2", role: "button", name: "Go" },
  { ref: "e3", role: "link", name: "About", text: "About this site" },
];

interface FakeTarget {
  targetId: string;
  url: string;
  title: string;
  revision: number;
  elements: SemanticElement[];
  text: string;
  /** Minimal history so back/forward are not degenerate in the fake. */
  history: string[];
  historyIndex: number;
}

export interface FakeTransport extends BrowserTransport {
  /** Every channel call in order. */
  calls(): readonly FakeCall[];
  stats(): FakeStats;
  /** Overrides the bump for one action after construction (test ergonomics). */
  setRevisionBump(action: BrowserAction, bump: number): void;
  /** Mutates a target directly, simulating an out-of-band state change. */
  touch(targetId: string, bump?: number): Result<number>;
  /** Flips an affordance after construction (e.g. semantics become unavailable). */
  setAffordance(strategy: InteractionStrategy, available: boolean): void;
}

function err(code: KaiError["code"], message: string, at: () => Date, detail?: string): KaiError {
  const error: KaiError = { code, message, retryable: false, at: at().toISOString() };
  if (detail !== undefined) error.detail = detail;
  return error;
}

function strategyField(strategy: InteractionStrategy): keyof TransportAffordances {
  switch (strategy) {
    case "native_api":
      return "nativeApi";
    case "dom":
      return "dom";
    case "accessibility":
      return "accessibility";
    case "semantic_ui":
      return "semanticUi";
    case "screenshot":
      return "screenshot";
  }
}

export function createFakeTransport(opts: FakeTransportOptions = {}): FakeTransport {
  const now = opts.now ?? (() => new Date());
  const id = opts.id ?? "fake";

  const affordances: TransportAffordances = {
    ...NO_AFFORDANCES,
    nativeApi: true,
    dom: true,
    accessibility: true,
    semanticUi: false,
    screenshot: true,
    ...(opts.affordances ?? {}),
  };

  const bump: Record<BrowserAction, number> = { ...DEFAULT_BUMP, ...(opts.revisionBump ?? {}) };

  const targets = new Map<string, FakeTarget>();
  const calls: FakeCall[] = [];
  const stats: FakeStats = { observeCalls: 0, actCalls: 0, screenshotCalls: 0, revisionCalls: 0 };
  let seq = 0;

  function seed(spec: FakeTargetSpec): FakeTarget {
    const targetId = `t${++seq}`;
    const url = spec.url ?? "about:blank";
    const target: FakeTarget = {
      targetId,
      url,
      title: spec.title ?? "Fake Page",
      // A freshly opened target is revision 1, not 0: "it exists" is already one
      // state, and a caller caching on 0 would miss the initial observation.
      revision: 1,
      elements: [...(spec.elements ?? DEFAULT_ELEMENTS)],
      text: spec.text ?? "fake page text",
      history: [url],
      historyIndex: 0,
    };
    targets.set(targetId, target);
    return target;
  }

  for (const spec of opts.targets ?? []) seed(spec);

  function info(target: FakeTarget): TargetInfo {
    return { targetId: target.targetId, url: target.url, title: target.title, revision: target.revision };
  }

  function requireTarget(targetId: string): FakeTarget | null {
    return targets.get(targetId) ?? null;
  }

  async function revision(targetId: string): Promise<Result<number>> {
    stats.revisionCalls += 1;
    const target = requireTarget(targetId);
    if (target === null) {
      return { ok: false, error: err("NOT_FOUND", `fake transport has no target "${targetId}"`, now) };
    }
    return { ok: true, value: target.revision };
  }

  async function openTarget(input?: { url?: string }): Promise<Result<TargetInfo>> {
    const target = seed({ url: input?.url ?? "about:blank" });
    return { ok: true, value: info(target) };
  }

  async function closeTarget(targetId: string): Promise<Result<{ targetId: string }>> {
    if (!targets.has(targetId)) {
      return { ok: false, error: err("NOT_FOUND", `fake transport has no target "${targetId}"`, now) };
    }
    targets.delete(targetId);
    return { ok: true, value: { targetId } };
  }

  async function listTargets(): Promise<Result<readonly TargetInfo[]>> {
    return { ok: true, value: [...targets.values()].map(info) };
  }

  async function observe(request: ObserveRequest): Promise<Result<ObservedPage>> {
    calls.push({
      kind: "observe",
      targetId: request.targetId,
      action: "inspect",
      strategy: request.strategy,
    });
    const field = strategyField(request.strategy);
    if (!affordances[field]) {
      // Defensive: the capability must not ask for a channel the transport lacks.
      // Surfacing it as an error here means a selection bug cannot masquerade as
      // a successful observation.
      return {
        ok: false,
        error: err(
          "INTERNAL",
          `fake transport was asked to observe over "${request.strategy}" but does not expose that channel`,
          now,
        ),
      };
    }
    const target = requireTarget(request.targetId);
    if (target === null) {
      return { ok: false, error: err("NOT_FOUND", `fake transport has no target "${request.targetId}"`, now) };
    }

    if (request.strategy === "screenshot") {
      stats.screenshotCalls += 1;
      return {
        ok: true,
        value: {
          targetId: target.targetId,
          revision: target.revision,
          url: target.url,
          title: target.title,
          strategy: "screenshot",
          // An opaque reference, never image bytes — Core does not carry blobs.
          screenshot: `shot:${target.targetId}:${target.revision}`,
        },
      };
    }

    stats.observeCalls += 1;
    return {
      ok: true,
      value: {
        targetId: target.targetId,
        revision: target.revision,
        url: target.url,
        title: target.title,
        strategy: request.strategy,
        elements: target.elements.map((element) => ({ ...element })),
        text: target.text,
      },
    };
  }

  async function act(request: ActRequest): Promise<Result<ActOutcome>> {
    if (!(BROWSER_ACTIONS as readonly string[]).includes(request.action)) {
      return {
        ok: false,
        error: err("VALIDATION_FAILED", `fake transport does not know action "${String(request.action)}"`, now),
      };
    }
    calls.push({
      kind: "act",
      targetId: request.targetId,
      action: request.action,
      strategy: request.strategy,
    });
    stats.actCalls += 1;

    const target = requireTarget(request.targetId);
    if (target === null) {
      return { ok: false, error: err("NOT_FOUND", `fake transport has no target "${request.targetId}"`, now) };
    }

    // Validate element refs the way a real DOM action would: acting on an element
    // that does not exist is a NOT_FOUND, not a silent success.
    const ref = request.input.ref;
    if ((request.action === "click" || request.action === "type" || request.action === "select") && typeof ref === "string") {
      if (!target.elements.some((element) => element.ref === ref)) {
        return {
          ok: false,
          error: err("NOT_FOUND", `fake transport: element "${ref}" is not present on "${target.targetId}"`, now),
        };
      }
    }

    switch (request.action) {
      case "navigate": {
        const url = typeof request.input.url === "string" ? request.input.url : "about:blank";
        target.url = url;
        target.title = `Fake Page @ ${url}`;
        target.history = target.history.slice(0, target.historyIndex + 1);
        target.history.push(url);
        target.historyIndex = target.history.length - 1;
        break;
      }
      case "back": {
        if (target.historyIndex > 0) target.historyIndex -= 1;
        target.url = target.history[target.historyIndex] ?? target.url;
        break;
      }
      case "forward": {
        if (target.historyIndex < target.history.length - 1) target.historyIndex += 1;
        target.url = target.history[target.historyIndex] ?? target.url;
        break;
      }
      case "type": {
        const text = typeof request.input.text === "string" ? request.input.text : "";
        const element = target.elements.find((candidate) => candidate.ref === ref);
        if (element !== undefined) element.value = text;
        break;
      }
      default:
        // click/select/scroll/wait mutate nothing else in the fake model; only the
        // configured revision bump distinguishes them.
        break;
    }

    const delta = bump[request.action];
    target.revision += delta;
    return {
      ok: true,
      value: {
        targetId: target.targetId,
        action: request.action,
        revision: target.revision,
        changed: delta > 0,
        detail: delta > 0 ? `state changed by ${delta}` : "no state change",
      },
    };
  }

  function setRevisionBump(action: BrowserAction, value: number): void {
    bump[action] = value;
  }

  function touch(targetId: string, bumpBy = 1): Result<number> {
    const target = requireTarget(targetId);
    if (target === null) {
      return { ok: false, error: err("NOT_FOUND", `fake transport has no target "${targetId}"`, now) };
    }
    target.revision += bumpBy;
    return { ok: true, value: target.revision };
  }

  function setAffordance(strategy: InteractionStrategy, available: boolean): void {
    affordances[strategyField(strategy)] = available;
  }

  return {
    id,
    affordances: () => ({ ...affordances }),
    revision,
    openTarget,
    closeTarget,
    listTargets,
    observe,
    act,
    calls: () => calls.map((call) => ({ ...call })),
    stats: () => ({ ...stats }),
    setRevisionBump,
    touch,
    setAffordance,
  };
}
