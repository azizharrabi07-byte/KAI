// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * KAI Core event bus.
 *
 * The single fan-out point for every KaiEvent the Core produces, and — since
 * Phase 1 — the single fan-in point for every canonical `RuntimeEvent` a worker
 * instance emits. The desktop UI subscribes once (over SSE) instead of polling
 * each module, so this bus — not the HTTP layer — is what decides who sees what.
 *
 * Design constraints that shape the code below:
 *   - Subscribers are untrusted: a handler that throws must not rob every other
 *     subscriber of the event, so delivery is per-subscriber try/catch. That
 *     applies to runtime listeners exactly as it does to control-plane ones.
 *   - **Redact before persistence and before delivery.** The bus is a trust
 *     boundary: one payload is redacted once, and that same value is what the
 *     store writes and what every subscriber receives. Upstream's bus redacts
 *     only the persisted copy and hands the un-redacted event to subscribers —
 *     the leak to the UI that this design exists to avoid.
 *   - **Attribution is mandatory.** A runtime event entering the bus is
 *     associated with the provider instance it arrived through. An event that
 *     claims a different instance/kind than the binding it arrived on is
 *     rejected as a value, never silently re-stamped.
 *   - SQLite is not a log sink (spec §13): only events that `shouldPersist()`
 *     names are written, everything else lives briefly in memory for `recent()`.
 *     Runtime events are high-frequency and mostly not persisted; an optional
 *     sink keeps the ones a caller chooses, already redacted.
 *   - `now` and `idFactory` are injectable so tests are deterministic; the
 *     default id factory stays unique even when two events share a millisecond.
 */

import {
  shouldPersist,
  type EventStore,
  type KaiEvent,
  type KaiEventType,
} from "../shared/contracts.ts";
import {
  isRuntimeEvent,
  type EmployeeInstanceId,
  type EmployeeKind,
  type RuntimeEvent,
  type RuntimeEventListener,
  type RuntimeEventType,
} from "../shared/runtime-events.ts";
import { redactSecrets } from "../redact/index.ts";

/** How many in-memory events `recent()` can serve. A UI catch-up window, not a store. */
const MAX_RECENT = 200;
/** How many runtime events `recentRuntime()` can serve. Same idea, separate stream. */
const MAX_RECENT_RUNTIME = 200;

export interface SubscribeOptions {
  types?: readonly KaiEventType[];
  missionId?: string;
}

export interface PublishOptions {
  source?: string;
  missionId?: string;
  stepId?: string;
}

// ── Runtime ingress ──────────────────────────────────────────────────────────

/**
 * What `attachProvider` registers: the instance identity and the adapter's
 * canonical stream. The bus subscribes to `onEvent` and validates every event
 * against this binding — it never trusts the event's own claim about who made
 * it when that disagrees with the subscription it arrived on.
 */
export interface ProviderBinding {
  readonly instanceId: EmployeeInstanceId;
  readonly employeeKind: EmployeeKind;
  /** The adapter's stream, matching `TurnAdapter.onEvent`. Returns an unsubscribe. */
  onEvent(listener: RuntimeEventListener): () => void;
}

/** Why a runtime event was refused. Errors are values here, not exceptions. */
export type RuntimeRejectCode =
  /** The instance id the event arrived through is not attached to this bus. */
  | "UNKNOWN_INSTANCE"
  /** The payload is not a well-formed canonical runtime event. */
  | "INVALID_EVENT"
  /** The event's claimed instance/kind disagrees with the subscription it came on. */
  | "CROSS_PROVIDER";

export type RuntimeIngestResult =
  | { ok: true; event: RuntimeEvent }
  | { ok: false; code: RuntimeRejectCode; detail: string };

/** Optional sink for runtime events a caller chooses to keep. Receives redacted events. */
export interface RuntimeEventSink {
  append(event: RuntimeEvent): void;
}

export interface RuntimeSubscribeOptions {
  types?: readonly RuntimeEventType[];
  instanceId?: EmployeeInstanceId;
  employeeKind?: EmployeeKind;
}

export interface EventBus {
  publish<T>(
    type: KaiEventType,
    payload: T,
    opts?: PublishOptions,
  ): KaiEvent<T>;
  /** Returns an unsubscribe function; safe to call more than once. */
  subscribe(handler: (event: KaiEvent) => void, opts?: SubscribeOptions): () => void;
  unsubscribe(handler: (event: KaiEvent) => void): void;
  /** Most recent in-memory events, newest first. */
  recent(limit?: number): KaiEvent[];

  /**
   * Attaches a provider instance: registers its identity and wires its stream
   * into the bus. Returns a detach function (idempotent) that also unregisters
   * the instance, so a stopped worker can no longer inject events.
   */
  attachProvider(binding: ProviderBinding): () => void;
  /**
   * Validates and admits one runtime event that arrived through `instanceId`.
   * Returns a result value; a rejected event is never persisted or delivered.
   */
  ingestRuntime(instanceId: EmployeeInstanceId, event: unknown): RuntimeIngestResult;
  /** Subscribes to the canonical runtime stream (the SSE/UI path). */
  subscribeRuntime(listener: RuntimeEventListener, opts?: RuntimeSubscribeOptions): () => void;
  /** Most recent in-memory runtime events, newest first. */
  recentRuntime(limit?: number): RuntimeEvent[];
}

interface Subscriber {
  handler: (event: KaiEvent) => void;
  types?: readonly KaiEventType[];
  missionId?: string;
}

interface RuntimeSubscriber {
  listener: RuntimeEventListener;
  types?: readonly RuntimeEventType[];
  instanceId?: EmployeeInstanceId;
  employeeKind?: EmployeeKind;
}

function matchesFilter(sub: Subscriber, event: KaiEvent): boolean {
  if (sub.types !== undefined && !sub.types.includes(event.type)) return false;
  if (sub.missionId !== undefined && event.missionId !== sub.missionId) return false;
  return true;
}

function matchesRuntimeFilter(sub: RuntimeSubscriber, event: RuntimeEvent): boolean {
  if (sub.types !== undefined && !sub.types.includes(event.type)) return false;
  if (sub.instanceId !== undefined && event.instanceId !== sub.instanceId) return false;
  if (sub.employeeKind !== undefined && event.employeeKind !== sub.employeeKind) return false;
  return true;
}

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Redacts a runtime event before it can be seen. `raw` is the one field that
 * can hold a provider object that resists enumeration, so the fallback drops it
 * — the bus is the UI boundary and `raw` is explicitly never sent to the UI.
 * A redaction that throws must not become a redaction that leaks, and must not
 * take the event stream down either.
 */
function redactRuntimeEvent(event: RuntimeEvent): RuntimeEvent {
  try {
    return redactSecrets(event) as RuntimeEvent;
  } catch {
    const { raw: _raw, ...rest } = event as RuntimeEvent & { raw?: unknown };
    try {
      return redactSecrets(rest) as RuntimeEvent;
    } catch {
      return rest as RuntimeEvent;
    }
  }
}

export function createEventBus(opts?: {
  store?: EventStore;
  /** Optional sink for canonical runtime events KAI chooses to keep. */
  runtimeStore?: RuntimeEventSink;
  now?: () => Date;
  idFactory?: () => string;
}): EventBus {
  const store = opts?.store;
  const runtimeStore = opts?.runtimeStore;
  const now = opts?.now ?? (() => new Date());

  // Monotonic counter is what guarantees uniqueness: two events published in the
  // same millisecond still get distinct ids from the default factory.
  let seq = 0;
  const idFactory = opts?.idFactory ?? (() => `evt_${now().getTime().toString(36)}_${(seq++).toString(36)}`);

  let subscribers: Subscriber[] = [];
  let recentEvents: KaiEvent[] = [];

  // The instance registry is the ground truth for cross-provider validation:
  // it records which kind each attached instance id registered as.
  const instances = new Map<EmployeeInstanceId, EmployeeKind>();
  let runtimeSubscribers: RuntimeSubscriber[] = [];
  let recentRuntimeEvents: RuntimeEvent[] = [];

  function unsubscribe(handler: (event: KaiEvent) => void): void {
    // Filter by identity rather than indexOf/splice: idempotent, and a second
    // call can never remove a neighbour that shifted into the old slot.
    subscribers = subscribers.filter((sub) => sub.handler !== handler);
  }

  function publish<T>(
    type: KaiEventType,
    payload: T,
    publishOpts?: PublishOptions,
  ): KaiEvent<T> {
    // Redact ONCE, here, so persistence, `recent()` replay and live delivery all
    // see the identical redacted payload. Redacting only the stored copy would
    // leak the raw value to subscribers — the exact upstream flaw this avoids.
    const safePayload = redactSecrets(payload) as T;

    const event: KaiEvent<T> = {
      id: idFactory(),
      type,
      timestamp: now().toISOString(),
      source: publishOpts?.source ?? "core",
      payload: safePayload,
    };
    if (publishOpts?.missionId !== undefined) event.missionId = publishOpts.missionId;
    if (publishOpts?.stepId !== undefined) event.stepId = publishOpts.stepId;

    // Persistence is opt-in per type. A store failure must not stop delivery.
    if (store !== undefined && shouldPersist(type)) {
      try {
        store.insertEvent(event);
      } catch (error) {
        console.warn(`[kai-core] failed to persist event ${event.id} (${event.type}): ${detailOf(error)}`);
      }
    }

    recentEvents.unshift(event);
    if (recentEvents.length > MAX_RECENT) recentEvents.length = MAX_RECENT;

    // Snapshot: a handler may subscribe/unsubscribe during delivery and must not
    // mutate the set the loop is walking.
    for (const sub of [...subscribers]) {
      if (!matchesFilter(sub, event)) continue;
      try {
        sub.handler(event);
      } catch (error) {
        // One bad subscriber is a bug in that subscriber, not a broken bus.
        console.warn(`[kai-core] event subscriber threw for ${event.id} (${event.type}): ${detailOf(error)}`);
      }
    }

    return event;
  }

  function subscribe(
    handler: (event: KaiEvent) => void,
    subscribeOpts?: SubscribeOptions,
  ): () => void {
    const sub: Subscriber = { handler };
    if (subscribeOpts?.types !== undefined) sub.types = subscribeOpts.types;
    if (subscribeOpts?.missionId !== undefined) sub.missionId = subscribeOpts.missionId;
    subscribers.push(sub);

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      unsubscribe(handler);
    };
  }

  function recent(limit?: number): KaiEvent[] {
    if (limit === undefined) return [...recentEvents];
    return recentEvents.slice(0, Math.max(0, limit));
  }

  // ── Runtime ingress ────────────────────────────────────────────────────────

  function ingestRuntime(instanceId: EmployeeInstanceId, input: unknown): RuntimeIngestResult {
    // 1. Attribution: the event must have arrived through an attached instance.
    //    An event from nowhere cannot be validated and is refused outright.
    const expectedKind = instances.get(instanceId);
    if (expectedKind === undefined) {
      return {
        ok: false,
        code: "UNKNOWN_INSTANCE",
        detail: `runtime event arrived through unregistered instance "${instanceId}"`,
      };
    }

    // 2. Shape: untrusted input at the boundary, so the canonical guard runs.
    if (!isRuntimeEvent(input)) {
      return {
        ok: false,
        code: "INVALID_EVENT",
        detail: `payload from "${instanceId}" is not a canonical runtime event`,
      };
    }

    // 3. Cross-provider check. The subscription is the source of truth: an event
    //    that claims a different instance, or a kind the instance is not
    //    registered as, is REJECTED — never re-stamped to match the binding,
    //    because re-stamping would hide the very confusion this guards against
    //    (a mis-wired adapter publishing another worker's events).
    if (input.instanceId !== instanceId) {
      return {
        ok: false,
        code: "CROSS_PROVIDER",
        detail: `event claims instance "${input.instanceId}" but arrived through "${instanceId}"`,
      };
    }
    if (input.employeeKind !== expectedKind) {
      return {
        ok: false,
        code: "CROSS_PROVIDER",
        detail: `instance "${instanceId}" is registered as "${expectedKind}" but the event claims "${input.employeeKind}"`,
      };
    }

    // 4. Redact BEFORE persistence and BEFORE delivery. The same redacted value
    //    goes to both, so a secret cannot be persisted and then replayed/SSE'd.
    const safe = redactRuntimeEvent(input);

    if (runtimeStore !== undefined) {
      try {
        runtimeStore.append(safe);
      } catch (error) {
        // A sink failure is the sink's problem, not the stream's.
        console.warn(`[kai-core] failed to persist runtime event ${safe.eventId} (${safe.type}): ${detailOf(error)}`);
      }
    }

    recentRuntimeEvents.unshift(safe);
    if (recentRuntimeEvents.length > MAX_RECENT_RUNTIME) recentRuntimeEvents.length = MAX_RECENT_RUNTIME;

    for (const sub of [...runtimeSubscribers]) {
      if (!matchesRuntimeFilter(sub, safe)) continue;
      try {
        sub.listener(safe);
      } catch (error) {
        // Listener isolation, same rule as the control-plane fan-out: one
        // throwing UI stream must not stop the others from seeing the event.
        console.warn(`[kai-core] runtime subscriber threw for ${safe.eventId} (${safe.type}): ${detailOf(error)}`);
      }
    }

    return { ok: true, event: safe };
  }

  function attachProvider(binding: ProviderBinding): () => void {
    const { instanceId, employeeKind } = binding;
    // A re-attached instance id takes over: the old stream is stale by
    // definition once its worker restarted under the same id.
    instances.set(instanceId, employeeKind);

    const off = binding.onEvent((event) => {
      const result = ingestRuntime(instanceId, event);
      if (!result.ok) {
        console.warn(`[kai-core] rejected runtime event from ${instanceId} (${result.code}): ${result.detail}`);
      }
    });

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      try {
        off();
      } catch (error) {
        console.warn(`[kai-core] provider detach threw for ${instanceId}: ${detailOf(error)}`);
      }
      // Only unregister if this binding still owns the id (a later attach wins).
      if (instances.get(instanceId) === employeeKind) instances.delete(instanceId);
    };
  }

  function subscribeRuntime(
    listener: RuntimeEventListener,
    subscribeOpts?: RuntimeSubscribeOptions,
  ): () => void {
    const sub: RuntimeSubscriber = { listener };
    if (subscribeOpts?.types !== undefined) sub.types = subscribeOpts.types;
    if (subscribeOpts?.instanceId !== undefined) sub.instanceId = subscribeOpts.instanceId;
    if (subscribeOpts?.employeeKind !== undefined) sub.employeeKind = subscribeOpts.employeeKind;
    runtimeSubscribers.push(sub);

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      runtimeSubscribers = runtimeSubscribers.filter((s) => s !== sub);
    };
  }

  function recentRuntime(limit?: number): RuntimeEvent[] {
    if (limit === undefined) return [...recentRuntimeEvents];
    return recentRuntimeEvents.slice(0, Math.max(0, limit));
  }

  return {
    publish,
    subscribe,
    unsubscribe,
    recent,
    attachProvider,
    ingestRuntime,
    subscribeRuntime,
    recentRuntime,
  };
}
