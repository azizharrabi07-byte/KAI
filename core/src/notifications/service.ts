// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * KAI Core notification service.
 *
 * Owns the user-visible notification list and mirrors every change onto the
 * event bus, so the UI can render alerts from the same subscription it uses for
 * everything else (no polling). Persistence is delegated to NotificationStore;
 * this module never talks to the database directly.
 *
 * Dedupe exists because scheduled jobs and retry loops can fire the same failure
 * repeatedly: without it the notification list becomes noise and is ignored.
 */

import type {
  KaiNotification,
  NotificationPriority,
  NotificationStore,
} from "../shared/contracts.ts";
import type { EventBus } from "../events/bus.ts";

/**
 * A repeat of the same notification (same `dedupeKey`, or same `type` + `title`
 * when no key is given) inside this window returns the EXISTING notification
 * instead of creating another. 60 seconds: long enough to collapse a retry
 * storm, short enough that a genuinely new occurrence an hour later still shows.
 */
export const DEDUPE_WINDOW_MS = 60_000;

const PRIORITIES: readonly NotificationPriority[] = ["LOW", "NORMAL", "HIGH", "CRITICAL"];

export interface NotifyInput {
  type: string;
  title: string;
  message?: string;
  priority?: NotificationPriority;
  missionId?: string;
  metadata?: Record<string, unknown>;
  dedupeKey?: string;
}

export interface NotificationListOptions {
  unreadOnly?: boolean;
  limit?: number;
}

export interface NotificationService {
  notify(input: NotifyInput): KaiNotification;
  list(opts?: NotificationListOptions): KaiNotification[];
  markRead(id: string): void;
}

/** Runtime check: priority arrives from callers/IPC and is not to be trusted. */
function coercePriority(value: unknown): NotificationPriority {
  return typeof value === "string" && (PRIORITIES as readonly string[]).includes(value)
    ? (value as NotificationPriority)
    : "NORMAL";
}

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createNotificationService(opts: {
  store: NotificationStore;
  bus: EventBus;
  now?: () => Date;
  idFactory?: () => string;
}): NotificationService {
  const { store, bus } = opts;
  const now = opts.now ?? (() => new Date());

  let seq = 0;
  const idFactory = opts.idFactory ?? (() => `ntf_${now().getTime().toString(36)}_${(seq++).toString(36)}`);

  // Dedupe index: key -> the notification it produced and when. In-memory only —
  // it is a spam brake, not state that must survive a restart.
  const dedupe = new Map<string, { atMs: number; notification: KaiNotification }>();

  function dedupeKeyFor(input: NotifyInput): string {
    // NUL separator keeps ("a", "b c") from colliding with ("a b", "c").
    return input.dedupeKey ?? `${input.type}\u0000${input.title}`;
  }

  function notify(input: NotifyInput): KaiNotification {
    const at = now();
    const key = dedupeKeyFor(input);

    const seen = dedupe.get(key);
    if (seen !== undefined && at.getTime() - seen.atMs < DEDUPE_WINDOW_MS) {
      return seen.notification;
    }

    const notification: KaiNotification = {
      id: idFactory(),
      type: input.type,
      title: input.title,
      priority: coercePriority(input.priority),
      createdAt: at.toISOString(),
      read: false,
    };
    if (input.message !== undefined) notification.message = input.message;
    if (input.missionId !== undefined) notification.missionId = input.missionId;
    if (input.metadata !== undefined) notification.metadata = input.metadata;

    store.createNotification(notification);
    dedupe.set(key, { atMs: at.getTime(), notification });

    bus.publish("notification.created", notification, {
      source: "core",
      ...(input.missionId !== undefined ? { missionId: input.missionId } : {}),
    });

    return notification;
  }

  function list(listOpts?: NotificationListOptions): KaiNotification[] {
    return store.listNotifications(listOpts);
  }

  function markRead(id: string): void {
    const existing = store.getNotification(id);
    if (existing !== null && existing.read) {
      // Already read: nothing changed, so nothing to announce.
      return;
    }
    store.markRead(id, true);

    const payload = { id };
    try {
      bus.publish("notification.read", payload, {
        source: "core",
        ...(existing?.missionId !== undefined ? { missionId: existing.missionId } : {}),
      });
    } catch (error) {
      // markRead's job is done; an event-bus hiccup must not surface as a failure.
      console.warn(`[kai-core] failed to publish notification.read for ${id}: ${detailOf(error)}`);
    }
  }

  return { notify, list, markRead };
}
