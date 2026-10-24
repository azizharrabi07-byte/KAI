// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The Browser capability: KAI's first-class, semantic-first way to drive a page.
 *
 * It is a plain `Capability` (shared/contracts.ts) that is deliberately
 * INDEPENDENT of the generic computer-use capability: driving a browser through
 * pixels-with-a-general-CUA is the worst case, and this module is the good one.
 * It sits on a `BrowserTransport` (transport.ts), owns target/session ownership
 * (ownership.ts) and chooses its interaction channel from the hierarchy
 * (interaction.ts).
 *
 * ── The operating model: inspect once, act semantically, verify cheaply ───────
 *
 * The failure mode this whole module is built to avoid is
 *
 *     screenshot -> guess coordinates -> click -> screenshot -> ...
 *
 * which is slow, flaky and expensive. Instead:
 *
 *   1. `inspect`  reads the page over the best channel available and caches it
 *                 against the page's revision.
 *   2. actions    (`click`, `type`, `navigate`, ...) drive the page over that same
 *                 channel using refs from the last inspection. No coordinates.
 *   3. verify     each action returns the transport's new `revision`. That is the
 *                 cheap "did anything actually change?" signal.
 *   4. re-inspect ONLY when the revision moved. A scroll that changed nothing, or
 *                 a second `inspect` with no action in between, reuses the cached
 *                 observation and does not touch the transport.
 *
 * Every decision is written to a strategy log (`strategyLog()`): which channel was
 * chosen and why, the revision, and whether a fresh inspection was really needed.
 * That is how a test proves the pipeline never fell back to pixels when semantics
 * were available — without counting wall-clock calls.
 *
 * ── Honesty ───────────────────────────────────────────────────────────────────
 * No real browser is wired in this phase. The capability is exercised end to end
 * against `FakeTransport`; the `BrowserTransport` seam is where a real CDP/CLI
 * transport (the same shape KAI's own text-first browser tooling uses) would plug
 * in, with no change to this file.
 *
 * Errors are values: every entry point returns `Result<T>`, never throws.
 */

import {
  isNonEmptyString,
  isRecord,
  type Capability,
  type CapabilityAvailability,
  type KaiError,
} from "../../shared/contracts.ts";
import {
  hasSemanticChannel,
  selectStrategy,
  type InteractionStrategy,
  type StrategyDecision,
} from "./interaction.ts";
import { createOwnershipRegistry, type OwnershipRegistry, type TargetLease } from "./ownership.ts";
import {
  BROWSER_ACTIONS,
  isBrowserAction,
  maxActionRisk,
  type ActRequest,
  type BrowserAction,
  type BrowserTransport,
  type ObservedPage,
  type Result,
} from "./transport.ts";

/** Who is asking. Every action carries it; ownership is decided from it. */
export interface CallerContext {
  ownerId: string;
}

/** The outcome of a driving action, carrying the channel that was used and why. */
export interface ActionResult {
  action: BrowserAction;
  targetId: string;
  strategy: InteractionStrategy;
  /** Why that channel — copied from the StrategyDecision. */
  reason: string;
  /** Revision after the action; compare with the previous to decide on re-inspection. */
  revision: number;
  /** True when the transport observed a real state change. */
  changed: boolean;
  detail?: string;
  result?: unknown;
}

/** The outcome of looking at a page, cached-aware. */
export interface InspectionResult {
  targetId: string;
  page: ObservedPage;
  decision: StrategyDecision;
  revision: number;
  /** True when a fresh transport observation happened because state had changed. */
  reInspected: boolean;
  /** True when the cached observation was reused (state unchanged). */
  reusedCached: boolean;
}

/**
 * One line of the audit trail. `reInspected` is the field that makes "re-inspect
 * only when state changed" assertable from the log rather than from call counts.
 */
export interface StrategyLogEntry {
  seq: number;
  at: string;
  targetId: string;
  action: BrowserAction;
  strategy: InteractionStrategy;
  reason: string;
  revision: number;
  reInspected: boolean;
  fallbackToPixels: boolean;
}

export interface BrowserCapability extends Capability {
  /** The runtime entry point: validate -> ownership -> route -> transport. */
  invoke(action: string, input: unknown, ctx: CallerContext): Promise<Result<unknown>>;
  /** Look at a page, reusing the cache unless state changed (or `force`). */
  observe(
    ctx: CallerContext,
    request: { targetId: string; query?: string; force?: boolean },
  ): Promise<Result<InspectionResult>>;
  /** The audit trail, oldest first. */
  strategyLog(): readonly StrategyLogEntry[];
  /** Every lease currently held. */
  leases(): readonly TargetLease[];
  /** The target this owner last opened/selected, if any. */
  activeTarget(ownerId: string): string | null;
  /** Releases everything an owner holds (disconnect / cleanup). */
  releaseAll(ownerId: string): number;
}

export interface BrowserCapabilityOptions {
  transport: BrowserTransport;
  ownership?: OwnershipRegistry;
  now?: () => Date;
  idFactory?: () => string;
}

const ACTION_FIELDS: Readonly<Record<BrowserAction, readonly string[]>> = {
  open: ["url"],
  new_tab: ["url"],

  navigate: ["targetId", "url"],
  find: ["targetId", "query"],
  inspect: ["targetId", "force"],
  click: ["targetId", "ref"],
  type: ["targetId", "ref", "text"],
  select: ["targetId", "ref", "value"],
  scroll: ["targetId", "direction"],
  wait: ["targetId"],
  read: ["targetId"],
  back: ["targetId"],
  forward: ["targetId"],
  close_tab: ["targetId"],
  switch_tab: ["targetId"],
};

const SCROLL_DIRECTIONS = ["up", "down", "left", "right"] as const;

function kaiError(
  code: KaiError["code"],
  message: string,
  at: () => Date,
  detail?: string,
): KaiError {
  const error: KaiError = { code, message, retryable: false, at: at().toISOString() };
  if (detail !== undefined) error.detail = detail;
  return error;
}

interface CacheEntry {
  revision: number;
  page: ObservedPage;
  decision: StrategyDecision;
}

/** Extracts an optional/required non-empty string field. Values, not throws. */
function takeString(
  raw: Record<string, unknown>,
  key: string,
  required: boolean,
): { ok: true; value: string | undefined } | { ok: false; reason: string } {
  const value = raw[key];
  if (value === undefined) {
    return required ? { ok: false, reason: `"${key}" is required` } : { ok: true, value: undefined };
  }
  if (!isNonEmptyString(value)) {
    return { ok: false, reason: `"${key}" must be a non-empty string` };
  }
  return { ok: true, value };
}

/**
 * Validates the raw input for one action. Deliberately strict — unknown keys are
 * refused, so a caller that misnames a field learns immediately instead of
 * silently driving the wrong thing.
 */
function validateInput(
  action: BrowserAction,
  input: unknown,
): { ok: true; value: Record<string, unknown> } | { ok: false; reason: string } {
  const raw = input === undefined ? {} : input;
  if (!isRecord(raw)) return { ok: false, reason: "input must be an object" };

  const allowed = ACTION_FIELDS[action];
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      return { ok: false, reason: `unknown option "${key}" for action "${action}"` };
    }
  }

  switch (action) {
    case "open": {
      const url = takeString(raw, "url", true);
      if (!url.ok) return { ok: false, reason: url.reason };
      return { ok: true, value: { url: url.value } };
    }
    case "new_tab": {
      const url = takeString(raw, "url", false);
      if (!url.ok) return { ok: false, reason: url.reason };
      return { ok: true, value: { ...(url.value !== undefined ? { url: url.value } : {}) } };
    }
    case "navigate": {
      // `targetId` is OPTIONAL on navigate. A model asked to look something up names
      // the URL, not a tab it has never seen — requiring an id it does not have made
      // every first research call fail with "navigate needs {targetId, action}".
      // With no target, navigate opens one at that url: the obvious meaning.
      const targetId = takeString(raw, "targetId", false);
      if (!targetId.ok) return { ok: false, reason: targetId.reason };
      const url = takeString(raw, "url", true);
      if (!url.ok) return { ok: false, reason: url.reason };
      return {
        ok: true,
        value: {
          ...(targetId.value !== undefined ? { targetId: targetId.value } : {}),
          url: searchableUrl(url.value ?? ""),
        },
      };
    }
    case "find": {
      const targetId = takeString(raw, "targetId", true);
      if (!targetId.ok) return { ok: false, reason: targetId.reason };
      const query = takeString(raw, "query", true);
      if (!query.ok) return { ok: false, reason: query.reason };
      return { ok: true, value: { targetId: targetId.value, query: query.value } };
    }
    case "inspect": {
      const targetId = takeString(raw, "targetId", true);
      if (!targetId.ok) return { ok: false, reason: targetId.reason };
      const force = raw.force;
      if (force !== undefined && typeof force !== "boolean") {
        return { ok: false, reason: `"force" must be a boolean` };
      }
      return { ok: true, value: { targetId: targetId.value, ...(force !== undefined ? { force } : {}) } };
    }
    case "type": {
      const targetId = takeString(raw, "targetId", true);
      if (!targetId.ok) return { ok: false, reason: targetId.reason };
      const ref = takeString(raw, "ref", true);
      if (!ref.ok) return { ok: false, reason: ref.reason };
      const text = takeString(raw, "text", true);
      if (!text.ok) return { ok: false, reason: text.reason };
      return { ok: true, value: { targetId: targetId.value, ref: ref.value, text: text.value } };
    }
    case "select": {
      const targetId = takeString(raw, "targetId", true);
      if (!targetId.ok) return { ok: false, reason: targetId.reason };
      const ref = takeString(raw, "ref", true);
      if (!ref.ok) return { ok: false, reason: ref.reason };
      const value = takeString(raw, "value", true);
      if (!value.ok) return { ok: false, reason: value.reason };
      return { ok: true, value: { targetId: targetId.value, ref: ref.value, value: value.value } };
    }
    case "click": {
      const targetId = takeString(raw, "targetId", true);
      if (!targetId.ok) return { ok: false, reason: targetId.reason };
      const ref = takeString(raw, "ref", true);
      if (!ref.ok) return { ok: false, reason: ref.reason };
      return { ok: true, value: { targetId: targetId.value, ref: ref.value } };
    }
    case "scroll": {
      const targetId = takeString(raw, "targetId", true);
      if (!targetId.ok) return { ok: false, reason: targetId.reason };
      const direction = raw.direction;
      if (direction !== undefined) {
        if (typeof direction !== "string" || !(SCROLL_DIRECTIONS as readonly string[]).includes(direction)) {
          return { ok: false, reason: `"direction" must be one of ${SCROLL_DIRECTIONS.join(", ")}` };
        }
      }
      return { ok: true, value: { targetId: targetId.value, ...(direction !== undefined ? { direction } : {}) } };
    }
    default: {
      // Every remaining action takes only a targetId.
      const targetId = takeString(raw, "targetId", true);
      if (!targetId.ok) return { ok: false, reason: targetId.reason };
      return { ok: true, value: { targetId: targetId.value } };
    }
  }
}

export function createBrowserCapability(opts: BrowserCapabilityOptions): BrowserCapability {
  const transport = opts.transport;
  const now = opts.now ?? (() => new Date());
  let seq = 0;
  const idFactory = opts.idFactory ?? (() => `lease-${++seq}`);
  const ownership = opts.ownership ?? createOwnershipRegistry({ now, idFactory });

  const cache = new Map<string, CacheEntry>();
  const activeByOwner = new Map<string, string>();
  const log: StrategyLogEntry[] = [];
  let logSeq = 0;

  function record(entry: {
    targetId: string;
    action: BrowserAction;
    strategy: InteractionStrategy;
    reason: string;
    revision: number;
    reInspected: boolean;
    fallbackToPixels: boolean;
  }): void {
    log.push({ seq: ++logSeq, at: now().toISOString(), ...entry });
  }

  /**
   * Ownership check shared by every action that names a target. Returns the error
   * to hand back, or null when the caller may proceed. A caller who does not hold
   * the lease is refused — this is the "two agents must not drive the same target"
   * rule made mechanical.
   */
  function requireOwner(targetId: string, ownerId: string): KaiError | null {
    const lease = ownership.ownerOf(targetId);
    if (lease === null) {
      return kaiError(
        "NOT_FOUND",
        `target "${targetId}" has no owner; open it before driving it`,
        now,
        targetId,
      );
    }
    if (lease.ownerId !== ownerId) {
      return kaiError(
        "POLICY_DENIED",
        `agent "${ownerId}" does not own target "${targetId}" (owned by "${lease.ownerId}"); ` +
          `actions on a target a caller does not own are refused`,
        now,
        targetId,
      );
    }
    return null;
  }

  /**
   * Look at a page. Reuses the cached observation whenever the transport's
   * revision is unchanged — the "re-inspect only when state actually changed"
   * rule. `logAction` exists so find/read/inspect each leave an honest log line.
   */
  async function inspectInternal(
    ctx: CallerContext,
    targetId: string,
    logAction: BrowserAction,
    options: { query?: string; force?: boolean } = {},
  ): Promise<Result<InspectionResult>> {
    const denied = requireOwner(targetId, ctx.ownerId);
    if (denied !== null) return { ok: false, error: denied };

    const revisionResult = await transport.revision(targetId);
    if (!revisionResult.ok) return { ok: false, error: revisionResult.error };
    const revision = revisionResult.value;

    const cached = cache.get(targetId);
    if (!options.force && cached !== undefined && cached.revision === revision) {
      record({
        targetId,
        action: logAction,
        strategy: cached.decision.strategy,
        reason: `state unchanged since revision ${revision}; reused the cached observation rather than re-inspecting`,
        revision,
        reInspected: false,
        fallbackToPixels: cached.decision.fallbackToPixels,
      });
      return {
        ok: true,
        value: {
          targetId,
          page: cached.page,
          decision: cached.decision,
          revision,
          reInspected: false,
          reusedCached: true,
        },
      };
    }

    const decision = selectStrategy(transport.affordances());
    const observed = await transport.observe({ targetId, strategy: decision.strategy, ...(options.query !== undefined ? { query: options.query } : {}) });
    if (!observed.ok) {
      // The attempt is logged even on failure: "we tried this channel and the
      // transport refused" is part of the honest audit trail.
      record({
        targetId,
        action: logAction,
        strategy: decision.strategy,
        reason: `${decision.reason}; the transport refused the observation: ${observed.error.message}`,
        revision,
        reInspected: true,
        fallbackToPixels: decision.fallbackToPixels,
      });
      return { ok: false, error: observed.error };
    }

    const page = observed.value;
    cache.set(targetId, { revision: page.revision, page, decision });
    record({
      targetId,
      action: logAction,
      strategy: decision.strategy,
      reason: decision.reason,
      revision: page.revision,
      reInspected: true,
      fallbackToPixels: decision.fallbackToPixels,
    });
    return {
      ok: true,
      value: {
        targetId,
        page,
        decision,
        revision: page.revision,
        reInspected: true,
        reusedCached: false,
      },
    };
  }

  async function observe(
    ctx: CallerContext,
    request: { targetId: string; query?: string; force?: boolean },
  ): Promise<Result<InspectionResult>> {
    if (!isNonEmptyString(request.targetId)) {
      return { ok: false, error: kaiError("VALIDATION_FAILED", "observe() requires a targetId", now) };
    }
    return inspectInternal(ctx, request.targetId, "inspect", request);
  }

  /** Runs a driving action over the best available channel. */
  async function drive(
    targetId: string,
    action: BrowserAction,
    input: Record<string, unknown>,
  ): Promise<Result<ActionResult>> {
    const decision = selectStrategy(transport.affordances());
    const request: ActRequest = { targetId, action, input, strategy: decision.strategy };
    const acted = await transport.act(request);
    if (!acted.ok) {
      record({
        targetId,
        action,
        strategy: decision.strategy,
        reason: `${decision.reason}; the transport failed the action: ${acted.error.message}`,
        revision: -1,
        reInspected: false,
        fallbackToPixels: decision.fallbackToPixels,
      });
      return { ok: false, error: acted.error };
    }
    record({
      targetId,
      action,
      strategy: decision.strategy,
      reason: decision.reason,
      revision: acted.value.revision,
      reInspected: false,
      fallbackToPixels: decision.fallbackToPixels,
    });
    return {
      ok: true,
      value: {
        action,
        targetId,
        strategy: decision.strategy,
        reason: decision.reason,
        revision: acted.value.revision,
        changed: acted.value.changed,
        ...(acted.value.detail !== undefined ? { detail: acted.value.detail } : {}),
        ...(acted.value.result !== undefined ? { result: acted.value.result } : {}),
      },
    };
  }

  async function route(
    action: BrowserAction,
    input: Record<string, unknown>,
    ctx: CallerContext,
  ): Promise<Result<unknown>> {
    const ownerId = ctx.ownerId;

    // ── THE LAST BOUNDARY BEFORE THE TRANSPORT ────────────────────────────────
    // Normalising the url in `validateInput` was not enough: every execution
    // path below reads `input.url` directly, so the validated value was thrown
    // away and the browser really navigated to the raw address. A Google search
    // therefore still hit `/sorry/index` and the model was handed a CAPTCHA as
    // if it were research. Normalise HERE, once, for open / new_tab / navigate.
    if (typeof input.url === "string") input = { ...input, url: searchableUrl(input.url) };

    switch (action) {
      case "open":
      case "new_tab": {
        const url = typeof input.url === "string" ? input.url : undefined;
        const opened = await transport.openTarget(url !== undefined ? { url } : undefined);
        if (!opened.ok) return { ok: false, error: opened.error };

        const acquired = ownership.acquire(opened.value.targetId, ownerId);
        if (!acquired.ok) {
          // Do not leak a target we just opened but cannot lease: close it so the
          // failure is a refusal, not a stranded tab.
          await transport.closeTarget(opened.value.targetId);
          return { ok: false, error: acquired.error };
        }
        activeByOwner.set(ownerId, opened.value.targetId);
        return {
          ok: true,
          value: {
            action,
            target: opened.value,
            lease: acquired.value,
            active: true,
          },
        };
      }

      case "close_tab": {
        const targetId = String(input.targetId);
        const denied = requireOwner(targetId, ownerId);
        if (denied !== null) return { ok: false, error: denied };

        const closed = await transport.closeTarget(targetId);
        if (!closed.ok) return { ok: false, error: closed.error };

        ownership.release(targetId, ownerId);
        cache.delete(targetId);
        if (activeByOwner.get(ownerId) === targetId) activeByOwner.delete(ownerId);
        return { ok: true, value: { targetId, closed: true } };
      }

      case "switch_tab": {
        const targetId = String(input.targetId);
        const denied = requireOwner(targetId, ownerId);
        if (denied !== null) return { ok: false, error: denied };

        // Confirm the target still exists in the transport. Ownership alone is not
        // enough: a tab can be closed out from under us.
        const revisionResult = await transport.revision(targetId);
        if (!revisionResult.ok) return { ok: false, error: revisionResult.error };

        activeByOwner.set(ownerId, targetId);
        return { ok: true, value: { targetId, active: true, revision: revisionResult.value } };
      }

      case "inspect": {
        const targetId = String(input.targetId);
        const inspected = await inspectInternal(ctx, targetId, "inspect", {
          ...(typeof input.force === "boolean" ? { force: input.force } : {}),
        });
        return inspected;
      }

      case "find": {
        const targetId = String(input.targetId);
        const query = String(input.query);
        const inspected = await inspectInternal(ctx, targetId, "find", { query });
        if (!inspected.ok) return { ok: false, error: inspected.error };

        const elements = inspected.value.page.elements;
        if (elements === undefined) {
          // Only the pixel channel was available, so there is nothing addressable
          // to search. Say so rather than pretending find succeeded.
          return {
            ok: false,
            error: kaiError(
              "INTERNAL",
              "find requires structured page data, but only the screenshot channel was available " +
                "(pixels cannot be searched by role/name/text)",
              now,
              targetId,
            ),
          };
        }
        const needle = query.toLowerCase();
        const matches = elements.filter((element) =>
          [element.ref, element.role, element.name, element.text, element.value]
            .filter((value): value is string => typeof value === "string")
            .some((value) => value.toLowerCase().includes(needle)),
        );
        return {
          ok: true,
          value: {
            targetId,
            revision: inspected.value.revision,
            strategy: inspected.value.decision.strategy,
            query,
            matches,
            count: matches.length,
          },
        };
      }

      case "read": {
        const targetId = String(input.targetId);
        const inspected = await inspectInternal(ctx, targetId, "read");
        if (!inspected.ok) return { ok: false, error: inspected.error };
        const page = inspected.value.page;
        // A page that blocked us is NOT a page we read. Google answers a scraped
        // search with /sorry/index and no body text; the model used to receive
        // that as empty content, concluded it had nothing, and answered a
        // research request with a canned apology. Say what actually happened, so
        // the turn can report the block or try another source instead.
        const blocked = blockedReason(page.url, page.text);
        if (blocked !== null) {
          // Retrying the SAME url is pointless — the engine withheld the body —
          // so `retryable` is false and the message says what to do instead.
          return {
            ok: false,
            error: { code: "PAGE_UNREADABLE", message: blocked, retryable: false, at: new Date().toISOString() },
          };
        }
        return {
          ok: true,
          value: {
            targetId,
            url: page.url,
            title: page.title,
            revision: inspected.value.revision,
            strategy: inspected.value.decision.strategy,
            text: page.text ?? null,
            elements: page.elements ?? null,
            elementCount: page.elements?.length ?? 0,
          },
        };
      }

      default: {
        // A navigate with no tab opens one at that url. Nothing else can be driven
        // without a target, because ownership is per-target.
        if (action === "navigate" && (input.targetId === undefined || String(input.targetId).length === 0)) {
          const opened = await invoke("open", { url: input.url }, ctx);
          return opened;
        }
        // Everything else drives the page and needs ownership of its target.
        const targetId = String(input.targetId);
        const denied = requireOwner(targetId, ownerId);
        if (denied !== null) return { ok: false, error: denied };
        return drive(targetId, action, input);
      }
    }
  }

  async function invoke(action: string, input: unknown, ctx: CallerContext): Promise<Result<unknown>> {
    // ctx crosses the IPC boundary and may be absent or malformed at runtime.
    if (!isRecord(ctx) || !isNonEmptyString(ctx.ownerId)) {
      return {
        ok: false,
        error: kaiError("VALIDATION_FAILED", "every browser action requires ctx.ownerId (a non-empty string)", now),
      };
    }
    if (!isBrowserAction(action)) {
      return {
        ok: false,
        error: kaiError(
          "VALIDATION_FAILED",
          `unknown browser action "${String(action)}"; supported actions are ${BROWSER_ACTIONS.join(", ")}`,
          now,
        ),
      };
    }

    const checked = validateInput(action, input);
    if (!checked.ok) {
      return {
        ok: false,
        error: kaiError("VALIDATION_FAILED", `browser.${action} rejected its input: ${checked.reason}`, now, checked.reason),
      };
    }

    try {
      return await route(action, checked.value, ctx);
    } catch (error) {
      // The transport seam is untrusted code; a throw here is a capability bug,
      // not a caller error. Report it as INTERNAL rather than letting it propagate.
      const detail = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        error: kaiError("INTERNAL", `browser.${action} failed unexpectedly: ${detail}`, now, detail),
      };
    }
  }

  function computeAvailability(): { availability: CapabilityAvailability; detail: string } {
    const affordances = transport.affordances();
    if (hasSemanticChannel(affordances)) {
      return { availability: "AVAILABLE", detail: "a semantic channel (API/DOM/accessibility) is available" };
    }
    if (affordances.screenshot) {
      return {
        availability: "DEGRADED",
        detail:
          "no semantic channel is available; only the screenshot fallback is offered, so actions " +
          "are pixel-based and less reliable",
      };
    }
    return { availability: "UNAVAILABLE", detail: "the transport exposes no usable channel" };
  }

  const initial = computeAvailability();

  const capability: BrowserCapability = {
    id: "browser",
    name: "Browser",
    version: "0.1.0",
    availability: initial.availability,
    // Never lower than the worst action: open/navigate/back/forward are EXTERNAL,
    // so the capability reports EXTERNAL (see ACTION_RISK).
    risk: maxActionRisk(),
    requirements: ["a BrowserTransport implementation (the fake transport backs this phase)"],
    provider: "kai",
    supportedActions: BROWSER_ACTIONS,

    async health() {
      const current = computeAvailability();
      return { availability: current.availability, detail: current.detail };
    },

    invoke,
    observe,

    strategyLog(): readonly StrategyLogEntry[] {
      return log.map((entry) => ({ ...entry }));
    },
    leases(): readonly TargetLease[] {
      return ownership.leases();
    },
    activeTarget(ownerId: string): string | null {
      return activeByOwner.get(ownerId) ?? null;
    },
    releaseAll(ownerId: string): number {
      const removed = ownership.releaseOwner(ownerId);
      activeByOwner.delete(ownerId);
      return removed;
    },
  };

  return capability;
}

/**
 * Why this page is not readable, or null when it is.
 *
 * Only anti-bot interstitials and empty documents qualify. A short page that a
 * human would read normally is still a real read.
 */
function blockedReason(url: string, text: string | null | undefined): string | null {
  const where = String(url ?? "");
  const body = String(text ?? "").trim();
  if (/google\.[a-z.]+\/sorry\//i.test(where) || /\/sorry\/index/i.test(where)) {
    return "The search engine served a bot-verification page (CAPTCHA) instead of results, so there is nothing to read. Do not retry the same engine; answer from another source or report the block.";
  }
  if (/\/captcha|challenge-platform|\/cdn-cgi\/challenge/i.test(where)) {
    return "This page served a bot challenge instead of its content. Report the block rather than treating the page as empty.";
  }
  if (body.length === 0) {
    return "The page returned no readable text — it may require sign-in, script execution, or it blocked the request. This is not evidence that the topic has no answer.";
  }
  return null;
}


/**
 * The url to actually open for a search.
 *
 * Google answers an automated search from a datacenter address with
 * `/sorry/index` — a CAPTCHA, and no results at all. Measured here: every
 * research turn died on that page, so the model received no evidence and
 * replied with a canned apology while the browser operations looked healthy.
 * DuckDuckGo's HTML endpoint serves the same query as plain results, so a
 * Google search url is redirected there rather than being sent to a wall.
 */
function searchableUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const host = parsed.hostname.toLowerCase();
  const isGoogleSearch = /^(www\.)?google\.[a-z.]+$/.test(host) && parsed.pathname === "/search";
  if (!isGoogleSearch) return url;
  const query = parsed.searchParams.get("q");
  if (query === null || query.trim().length === 0) return url;
  return `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
}
