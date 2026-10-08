// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Pure schedule arithmetic for the KAI Core scheduler.
 *
 * This file deliberately has no I/O, no clock of its own and no dependency on
 * the store: given a task description and a reference instant it answers
 * "when should this run next?" — and nothing else. Keeping it pure is what
 * makes the scheduler's timing testable without waiting for a real clock.
 *
 * KAI's Core must be able to act on a timetable while the UI is closed
 * (spec §36), so correctness here is the difference between a persistent
 * runtime and a request handler that only wakes when poked.
 *
 * ── Contract friction: weekly / cron ─────────────────────────────────────────
 * `shared/contracts.ts` is frozen and types `ScheduleKind` as
 * `"once" | "interval" | "daily"`, and the `scheduled_tasks` table (owned by the
 * storage module) has no `dayOfWeek` / `cron` columns. Part F asks for weekly
 * and cron "where practical". They are provided here as *runtime* kinds via the
 * widened `ExtendedScheduleKind` and the optional `ScheduleExtensions` below;
 * the extra fields are persisted inside the existing `payload` column under a
 * reserved `__schedule` key (see `readScheduleExtensions` / `withScheduleExtensions`).
 * Nothing in the frozen contract or schema is changed — the same "extend, do not
 * reshape" rule the scheduler already follows for a cleared `nextRun`.
 */

import type { ScheduleKind, ScheduledTask } from "../shared/contracts.ts";

/** Kinds the frozen contract declares, plus the two KAI adds at runtime. */
export type ExtendedScheduleKind = ScheduleKind | "weekly" | "cron";

/** What to do when a task's due instant passed while the Core was not running. */
export type MissedPolicy = "run-now" | "skip" | "mark-missed";

/** The scheduled task fields that describe *when* a task runs. */
export type ScheduleSpec = Pick<ScheduledTask, "intervalMs" | "atTime" | "runAt"> & {
  kind: ExtendedScheduleKind;
  /** For "weekly": 0 (Sunday) .. 6 (Saturday). */
  dayOfWeek?: number;
  /** For "cron": a five-field expression (minute hour day-of-month month day-of-week). */
  cron?: string;
};

/** The reserved key that carries KAI's schedule extensions inside `payload`. */
export const SCHEDULE_PAYLOAD_KEY = "__schedule";

export interface ScheduleExtensions {
  missed?: MissedPolicy;
  dayOfWeek?: number;
  cron?: string;
}

const AT_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MISSED_POLICIES: readonly MissedPolicy[] = ["run-now", "skip", "mark-missed"];

function isScheduleKind(value: unknown): value is ExtendedScheduleKind {
  return (
    value === "once" ||
    value === "interval" ||
    value === "daily" ||
    value === "weekly" ||
    value === "cron"
  );
}

export function isMissedPolicy(value: unknown): value is MissedPolicy {
  return typeof value === "string" && (MISSED_POLICIES as readonly string[]).includes(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read the schedule extensions out of a task's payload. Malformed extensions are
 * dropped (never trusted): a bad `missed` string falls back to the safe default
 * the scheduler applies.
 */
export function readScheduleExtensions(
  payload: Record<string, unknown> | undefined,
): ScheduleExtensions {
  if (!isPlainRecord(payload)) return {};
  const raw = payload[SCHEDULE_PAYLOAD_KEY];
  if (!isPlainRecord(raw)) return {};
  const ext: ScheduleExtensions = {};
  if (isMissedPolicy(raw.missed)) ext.missed = raw.missed;
  if (
    typeof raw.dayOfWeek === "number" &&
    Number.isInteger(raw.dayOfWeek) &&
    raw.dayOfWeek >= 0 &&
    raw.dayOfWeek <= 6
  ) {
    ext.dayOfWeek = raw.dayOfWeek;
  }
  if (typeof raw.cron === "string" && raw.cron.trim().length > 0) ext.cron = raw.cron.trim();
  return ext;
}

/**
 * Return a task with the schedule extensions merged into its `payload` while
 * preserving every other payload key (the payload is still the action's data).
 */
export function withScheduleExtensions(
  task: ScheduledTask,
  ext: ScheduleExtensions,
): ScheduledTask {
  const payload: Record<string, unknown> = isPlainRecord(task.payload) ? { ...task.payload } : {};
  const existing = payload[SCHEDULE_PAYLOAD_KEY];
  const merged: Record<string, unknown> = isPlainRecord(existing) ? { ...existing } : {};
  for (const [key, value] of Object.entries(ext)) {
    if (value !== undefined) merged[key] = value;
  }
  payload[SCHEDULE_PAYLOAD_KEY] = merged;
  return { ...task, payload };
}

/** Strip KAI's reserved schedule key so a job never sees scheduler metadata. */
export function stripScheduleExtensions(
  payload: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!isPlainRecord(payload)) return {};
  const copy: Record<string, unknown> = { ...payload };
  delete copy[SCHEDULE_PAYLOAD_KEY];
  return copy;
}

/** Overlay a task's persisted extensions onto a spec the arithmetic can use. */
export function specFor(task: ScheduledTask): ScheduleSpec {
  const ext = readScheduleExtensions(task.payload);
  const spec: ScheduleSpec = { kind: task.kind as ExtendedScheduleKind };
  if (task.intervalMs !== undefined) spec.intervalMs = task.intervalMs;
  if (task.atTime !== undefined) spec.atTime = task.atTime;
  if (task.runAt !== undefined) spec.runAt = task.runAt;
  if (ext.dayOfWeek !== undefined) spec.dayOfWeek = ext.dayOfWeek;
  if (ext.cron !== undefined) spec.cron = ext.cron;
  return spec;
}

/**
 * Parse a `"HH:MM"` 24-hour local time into hours/minutes.
 * Returns null when the string is malformed (wrong shape or out of range).
 */
function parseAtTime(value: unknown): { hh: number; mm: number } | null {
  if (typeof value !== "string") return null;
  const match = AT_TIME_RE.exec(value.trim());
  if (!match) return null;
  return { hh: Number(match[1]), mm: Number(match[2]) };
}

function parseInstant(value: unknown): Date | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

// ── cron ──────────────────────────────────────────────────────────────────────

interface CronField {
  values: Set<number>;
  /** True when the field is exactly `*` (needed for the day-of-month/day-of-week OR rule). */
  any: boolean;
}

function expandRange(min: number, max: number, step: number): number[] {
  const out: number[] = [];
  for (let v = min; v <= max; v += step) out.push(v);
  return out;
}

/**
 * Parse one cron field. `wrap` maps 7 -> 0 for day-of-week (both spell Sunday).
 * Returns null on any malformed token — cron input is untrusted and a bad
 * expression must be reported, not silently treated as `*`.
 */
function parseCronField(
  raw: string,
  min: number,
  max: number,
  wrap?: (v: number) => number,
): CronField | null {
  const text = raw.trim();
  if (text.length === 0) return null;
  const values = new Set<number>();
  const any = text === "*";

  for (const part of text.split(",")) {
    const piece = part.trim();
    if (piece.length === 0) return null;

    let step = 1;
    let body = piece;
    const slash = piece.indexOf("/");
    if (slash !== -1) {
      body = piece.slice(0, slash);
      const stepText = piece.slice(slash + 1);
      if (!/^\d+$/.test(stepText)) return null;
      step = Number(stepText);
      if (step <= 0) return null;
    }

    let lo: number;
    let hi: number;
    if (body === "*") {
      lo = min;
      hi = max;
    } else if (/^\d+$/.test(body)) {
      lo = Number(body);
      // "a/step" means "from a to the field maximum".
      hi = slash === -1 ? lo : max;
    } else {
      const range = /^(\d+)-(\d+)$/.exec(body);
      if (range === null) return null;
      lo = Number(range[1]);
      hi = Number(range[2]);
    }

    if (lo < min || hi > max || lo > hi) return null;
    for (const v of expandRange(lo, hi, step)) values.add(wrap ? wrap(v) : v);
  }

  if (values.size === 0) return null;
  return { values, any };
}

interface ParsedCron {
  minute: CronField;
  hour: CronField;
  dom: CronField;
  month: CronField;
  dow: CronField;
}

function parseCron(expression: unknown): ParsedCron | null {
  if (typeof expression !== "string") return null;
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minF, hourF, domF, monthF, dowF] = fields as [string, string, string, string, string];
  const minute = parseCronField(minF, 0, 59);
  const hour = parseCronField(hourF, 0, 23);
  const dom = parseCronField(domF, 1, 31);
  const month = parseCronField(monthF, 1, 12);
  const dow = parseCronField(dowF, 0, 7, (v) => (v === 7 ? 0 : v));
  if (minute === null || hour === null || dom === null || month === null || dow === null) {
    return null;
  }
  return { minute, hour, dom, month, dow };
}

function cronDayMatches(cron: ParsedCron, date: Date): boolean {
  if (!cron.dom.any && !cron.dow.any) {
    // Both restricted: standard cron ORs them.
    return cron.dom.values.has(date.getDate()) || cron.dow.values.has(date.getDay());
  }
  if (cron.dom.any) return cron.dow.values.has(date.getDay());
  return cron.dom.values.has(date.getDate());
}

/** Upper bound on the cron search: five years of days is far more than any real schedule needs. */
const CRON_MAX_DAYS = 366 * 5;

function computeNextCron(from: Date, expression: unknown): Date | null {
  const cron = parseCron(expression);
  if (cron === null) return null;

  // Cron granularity is one minute; the next run is strictly after `from`.
  const start = new Date(Math.floor(from.getTime() / 60_000) * 60_000 + 60_000);
  const day = new Date(start.getFullYear(), start.getMonth(), start.getDate(), 0, 0, 0, 0);

  for (let offset = 0; offset < CRON_MAX_DAYS; offset += 1) {
    const candidateDay = new Date(day);
    candidateDay.setDate(day.getDate() + offset);
    if (!cron.month.values.has(candidateDay.getMonth() + 1)) continue;
    if (!cronDayMatches(cron, candidateDay)) continue;

    for (let h = 0; h < 24; h += 1) {
      if (!cron.hour.values.has(h)) continue;
      for (let m = 0; m < 60; m += 1) {
        if (!cron.minute.values.has(m)) continue;
        const at = new Date(
          candidateDay.getFullYear(),
          candidateDay.getMonth(),
          candidateDay.getDate(),
          h,
          m,
          0,
          0,
        );
        if (at.getTime() > from.getTime() && at.getTime() >= start.getTime()) return at;
      }
    }
  }
  return null;
}

// ── validation ────────────────────────────────────────────────────────────────

/**
 * Explain whether a task's schedule fields are usable.
 *
 * Why a value rather than a throw: schedule data crosses the IPC boundary and
 * comes back out of SQLite after a restart, so it is untrusted. A malformed
 * row must be *reported and set aside*, never allowed to crash the tick loop.
 */
export function validateSchedule(
  task: ScheduleSpec,
): { ok: true } | { ok: false; reason: string } {
  if (!isScheduleKind(task.kind)) {
    return { ok: false, reason: `unknown schedule kind: ${String(task.kind)}` };
  }

  switch (task.kind) {
    case "once": {
      if (typeof task.runAt !== "string" || task.runAt.trim().length === 0) {
        return { ok: false, reason: "once schedule requires runAt (ISO-8601)" };
      }
      if (parseInstant(task.runAt) === null) {
        return { ok: false, reason: `runAt is not a parseable instant: ${task.runAt}` };
      }
      return { ok: true };
    }
    case "interval": {
      if (typeof task.intervalMs !== "number" || !Number.isFinite(task.intervalMs)) {
        return { ok: false, reason: "interval schedule requires intervalMs" };
      }
      if (task.intervalMs <= 0) {
        return { ok: false, reason: `intervalMs must be positive, got ${task.intervalMs}` };
      }
      return { ok: true };
    }
    case "daily": {
      if (parseAtTime(task.atTime) === null) {
        return {
          ok: false,
          reason: `atTime must be a 24-hour "HH:MM" string, got ${String(task.atTime)}`,
        };
      }
      return { ok: true };
    }
    case "weekly": {
      if (parseAtTime(task.atTime) === null) {
        return {
          ok: false,
          reason: `atTime must be a 24-hour "HH:MM" string, got ${String(task.atTime)}`,
        };
      }
      if (
        typeof task.dayOfWeek !== "number" ||
        !Number.isInteger(task.dayOfWeek) ||
        task.dayOfWeek < 0 ||
        task.dayOfWeek > 6
      ) {
        return {
          ok: false,
          reason: `weekly schedule requires dayOfWeek 0..6 (Sun=0), got ${String(task.dayOfWeek)}`,
        };
      }
      return { ok: true };
    }
    case "cron": {
      if (parseCron(task.cron) === null) {
        return {
          ok: false,
          reason: `cron schedule requires a valid 5-field expression, got ${String(task.cron)}`,
        };
      }
      return { ok: true };
    }
    default:
      // Exhaustive: isScheduleKind already narrowed `kind`.
      return { ok: false, reason: "unreachable" };
  }
}

/**
 * When should `task` next run, at or after `from`?
 *
 * Returns null when there is no next run (a `once` task whose instant has
 * already passed) or when the schedule is malformed. It never throws: an
 * invalid row is the caller's problem to report, not a reason to take the
 * loop down.
 *
 * A note on the `daily` boundary: "today if still ahead, otherwise tomorrow"
 * is evaluated in the process's local timezone, because `atTime` is defined
 * as a *local* wall-clock time — a user who sets 09:00 means 09:00 where they
 * are, not 09:00 UTC. `weekly` and `cron` share that local-time reading.
 */
export function computeNextRun(task: ScheduleSpec, from: Date): Date | null {
  const check = validateSchedule(task);
  if (!check.ok) return null;

  switch (task.kind) {
    case "once": {
      const at = parseInstant(task.runAt);
      if (at === null) return null;
      // A `once` instant that has already gone by has no next run.
      return at.getTime() >= from.getTime() ? at : null;
    }
    case "interval": {
      const ms = task.intervalMs as number;
      return new Date(from.getTime() + ms);
    }
    case "daily": {
      const time = parseAtTime(task.atTime);
      if (time === null) return null;
      const candidate = new Date(
        from.getFullYear(),
        from.getMonth(),
        from.getDate(),
        time.hh,
        time.mm,
        0,
        0,
      );
      // Already passed today (or exactly on it) -> same wall-clock time tomorrow.
      // setDate keeps the local wall-clock time across a DST change.
      if (candidate.getTime() <= from.getTime()) {
        candidate.setDate(candidate.getDate() + 1);
      }
      return candidate;
    }
    case "weekly": {
      const time = parseAtTime(task.atTime);
      const dow = task.dayOfWeek;
      if (time === null || typeof dow !== "number") return null;
      const candidate = new Date(
        from.getFullYear(),
        from.getMonth(),
        from.getDate(),
        time.hh,
        time.mm,
        0,
        0,
      );
      const delta = (dow - candidate.getDay() + 7) % 7;
      candidate.setDate(candidate.getDate() + delta);
      // setDate preserves the local wall-clock time across a DST change.
      if (candidate.getTime() <= from.getTime()) candidate.setDate(candidate.getDate() + 7);
      return candidate;
    }
    case "cron": {
      return computeNextCron(from, task.cron);
    }
    default:
      return null;
  }
}
