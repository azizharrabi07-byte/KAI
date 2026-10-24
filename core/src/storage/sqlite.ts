// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * KAI Core — SQLite persistence.
 *
 * Implements the `Stores` aggregate from shared/contracts.ts on top of Node's
 * built-in `node:sqlite` (no third-party driver, nothing for the desktop app to
 * ship). Everything above this module depends on the interfaces, not on SQL.
 *
 * Conventions enforced here:
 *   - ISO-8601 timestamps stored verbatim as TEXT.
 *   - Booleans stored as INTEGER 0/1 and returned as real booleans.
 *   - Structured fields stored as JSON TEXT and parsed back, so what goes in
 *     comes back byte-equal when re-serialised.
 *   - Multi-row writes (a mission and its steps) run in one transaction, so a
 *     partial mission is never observable.
 *   - Mutations that name a missing id are no-ops, not throws: the caller
 *     (UI, scheduler) is allowed to race a delete.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type {
  ActivityEventRecord,
  ActivityStore,
  Approval,
  ApprovalStatus,
  ApprovalStore,
  EventStore,
  KaiEvent,
  KaiEventType,
  KaiNotification,
  Memory,
  MemoryStore,
  MemoryType,
  Mission,
  MissionStatus,
  MissionStep,
  MissionStore,
  NotificationStore,
  NotificationPriority,
  PromptPatternRecord,
  PromptPatternStore,
  ScheduledTask,
  ScheduledTaskStore,
  SettingsStore,
  SkillMetricsRecord,
  SkillMetricsStore,
  StepStatus,
  Stores,
  TaskRecord,
  TaskStore,
  WorkerProfileRecord,
  WorkerProfileStore,
  WorkItemRecord,
  WorkItemStore,
} from "../shared/contracts.ts";

import { MIGRATIONS, SCHEMA_VERSION } from "./schema.ts";

// ── Path resolution ───────────────────────────────────────────────────────────

/**
 * Where the Core keeps its database.
 *
 * Deliberately OUTSIDE the git repository (a database in the working tree gets
 * committed, wiped by `git clean`, and shared between checkouts) and per-user:
 *   - `KAI_CORE_DB` overrides everything, for tests and power users.
 *   - Windows: `%LOCALAPPDATA%\KAI\core\kai-core.db`.
 *   - Elsewhere: `$XDG_DATA_HOME/KAI/core/kai-core.db`, or `~/.local/share/...`.
 *
 * Parent directories are created by `openSqliteStores`, not here, so this stays
 * a pure function of the environment.
 */
export function defaultDatabasePath(): string {
  const override = cleanEnv(process.env.KAI_CORE_DB);
  if (override !== undefined) return override;

  if (process.platform === "win32") {
    const localAppData = cleanEnv(process.env.LOCALAPPDATA);
    if (localAppData !== undefined) {
      return join(localAppData, "KAI", "core", "kai-core.db");
    }
  }

  const xdgData = cleanEnv(process.env.XDG_DATA_HOME);
  if (xdgData !== undefined) {
    return join(xdgData, "KAI", "core", "kai-core.db");
  }

  // macOS uses ~/Library/Application Support; everything else ~/.local/share
  // is the closest thing to a convention. Both stay under the user's home.
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "KAI", "core", "kai-core.db");
  }
  return join(homedir(), ".local", "share", "KAI", "core", "kai-core.db");
}

function cleanEnv(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// ── Value helpers ─────────────────────────────────────────────────────────────

type SqlValue = string | number | bigint | null | Uint8Array;

function toJson(value: unknown): string | null {
  if (value === undefined) return null;
  const encoded = JSON.stringify(value);
  return encoded === undefined ? null : encoded;
}

function fromJson<T>(value: unknown): T | undefined {
  if (typeof value !== "string") return undefined;
  return JSON.parse(value) as T;
}

function toBool(value: unknown): boolean {
  return value === 1 || value === true || value === "1";
}

function toBoolInt(value: boolean): number {
  return value ? 1 : 0;
}

function toNum(value: unknown, fallback = 0): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toStr(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

/** Assign only when present, so a returned object omits absent optional keys. */
function optional<T>(target: T, key: keyof T, value: unknown): void {
  if (value !== null && value !== undefined) {
    (target as Record<string, unknown>)[key as string] = value;
  }
}

// ── Open ──────────────────────────────────────────────────────────────────────

/**
 * Open (creating if needed) the SQLite database and return the store aggregate.
 * Migrations run on every open; re-opening an existing database is a no-op that
 * preserves all rows.
 *
 * `openSqliteStores({ path: ":memory:" })` gives an isolated throwaway database
 * for tests.
 */
export function openSqliteStores(opts: { path?: string } = {}): Stores {
  const path = opts.path ?? defaultDatabasePath();

  if (path !== ":memory:" && !path.startsWith("file:")) {
    const dir = dirname(path);
    if (dir.length > 0 && dir !== ".") {
      mkdirSync(dir, { recursive: true });
    }
  }

  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);

  // Prepared once per connection; DatabaseSync statements are reusable.
  const stmts = {
    insertEvent: db.prepare(
      `INSERT OR REPLACE INTO events (id, type, timestamp, source, payload, missionId, stepId)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ),
    getEvent: db.prepare(`SELECT * FROM events WHERE id = ?`),
    listEvents: db.prepare(
      `SELECT * FROM events
       WHERE (? IS NULL OR missionId = ?)
         AND (? IS NULL OR timestamp >= ?)
         AND (? IS NULL OR type IN (SELECT value FROM json_each(?)))
       ORDER BY timestamp DESC, rowid DESC
       LIMIT ?`,
    ),

    upsertMission: db.prepare(
      `INSERT INTO missions
         (id, title, description, status, priority, createdAt, updatedAt, startedAt, completedAt, error, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         description = excluded.description,
         status = excluded.status,
         priority = excluded.priority,
         createdAt = excluded.createdAt,
         updatedAt = excluded.updatedAt,
         startedAt = excluded.startedAt,
         completedAt = excluded.completedAt,
         error = excluded.error,
         metadata = excluded.metadata`,
    ),
    getMission: db.prepare(`SELECT * FROM missions WHERE id = ?`),
    listMissions: db.prepare(
      `SELECT * FROM missions
       WHERE (? IS NULL OR status = ?)
       ORDER BY createdAt DESC, rowid DESC
       LIMIT ?`,
    ),
    listUnfinished: db.prepare(
      `SELECT * FROM missions
       WHERE status IN ('QUEUED', 'RUNNING', 'WAITING', 'WAITING_APPROVAL')
       ORDER BY createdAt ASC, rowid ASC`,
    ),
    deleteMission: db.prepare(`DELETE FROM missions WHERE id = ?`),

    deleteSteps: db.prepare(`DELETE FROM mission_steps WHERE missionId = ?`),
    insertStep: db.prepare(
      `INSERT INTO mission_steps
         (id, missionId, "index", title, kind, target, input, output, status, startedAt, completedAt, error, sideEffecting)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    listSteps: db.prepare(
      `SELECT * FROM mission_steps WHERE missionId = ? ORDER BY "index" ASC, rowid ASC`,
    ),

    upsertMemory: db.prepare(
      `INSERT OR REPLACE INTO memories
         (id, type, content, source, importance, createdAt, updatedAt, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    getMemory: db.prepare(`SELECT * FROM memories WHERE id = ?`),
    listMemories: db.prepare(
      `SELECT * FROM memories
       WHERE (? IS NULL OR type = ?)
       ORDER BY createdAt DESC, rowid DESC
       LIMIT ?`,
    ),
    updateMemory: db.prepare(
      `UPDATE memories
       SET type = ?, content = ?, source = ?, importance = ?, updatedAt = ?, metadata = ?
       WHERE id = ?`,
    ),
    deleteMemory: db.prepare(`DELETE FROM memories WHERE id = ?`),

    insertNotification: db.prepare(
      `INSERT OR REPLACE INTO notifications
         (id, type, title, message, priority, createdAt, read, missionId, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    getNotification: db.prepare(`SELECT * FROM notifications WHERE id = ?`),
    listNotifications: db.prepare(
      `SELECT * FROM notifications
       WHERE (? = 0 OR read = 0)
       ORDER BY createdAt DESC, rowid DESC
       LIMIT ?`,
    ),
    markRead: db.prepare(`UPDATE notifications SET read = ? WHERE id = ?`),

    insertApproval: db.prepare(
      `INSERT OR REPLACE INTO approvals
         (id, toolId, action, reason, risk, createdAt, status, expiresAt, decidedAt, missionId, stepId, inputHash, consumedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    getApproval: db.prepare(`SELECT * FROM approvals WHERE id = ?`),
    listApprovals: db.prepare(
      `SELECT * FROM approvals
       WHERE (? IS NULL OR status = ?)
       ORDER BY createdAt DESC, rowid DESC
       LIMIT ?`,
    ),
    decideApproval: db.prepare(`UPDATE approvals SET status = ?, decidedAt = ? WHERE id = ?`),
    // Spending an approval is its OWN transition: the status stays APPROVED (the human
    // did approve it) while `consumedAt` records that the use is gone. Marking it
    // EXPIRED would tell the audit trail something that did not happen.
    consumeApproval: db.prepare(
      `UPDATE approvals SET consumedAt = ? WHERE id = ? AND status = 'APPROVED' AND consumedAt IS NULL`,
    ),

    upsertScheduledTask: db.prepare(
      `INSERT INTO scheduled_tasks
         (id, title, kind, intervalMs, atTime, runAt, action, payload, enabled, lastRun, nextRun, failureCount, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         kind = excluded.kind,
         intervalMs = excluded.intervalMs,
         atTime = excluded.atTime,
         runAt = excluded.runAt,
         action = excluded.action,
         payload = excluded.payload,
         enabled = excluded.enabled,
         lastRun = excluded.lastRun,
         nextRun = excluded.nextRun,
         failureCount = excluded.failureCount,
         createdAt = excluded.createdAt,
         updatedAt = excluded.updatedAt`,
    ),
    getScheduledTask: db.prepare(`SELECT * FROM scheduled_tasks WHERE id = ?`),
    listScheduledTasks: db.prepare(
      `SELECT * FROM scheduled_tasks
       WHERE (? = 0 OR enabled = 1)
       ORDER BY createdAt DESC, rowid DESC`,
    ),
    deleteScheduledTask: db.prepare(`DELETE FROM scheduled_tasks WHERE id = ?`),

    getSetting: db.prepare(`SELECT * FROM settings WHERE "key" = ?`),
    setSetting: db.prepare(
      `INSERT INTO settings ("key", value, updatedAt)
       VALUES (?, ?, ?)
       ON CONFLICT("key") DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt`,
    ),
    deleteSetting: db.prepare(`DELETE FROM settings WHERE "key" = ?`),
    listSettings: db.prepare(`SELECT * FROM settings ORDER BY "key" ASC`),

    insertTask: db.prepare(
      `INSERT INTO tasks (id, sessionId, objective, plan, steps, state, pendingTools, verification, synthesis, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    getTask: db.prepare(`SELECT * FROM tasks WHERE id = ?`),
    activeTask: db.prepare(
      `SELECT * FROM tasks
       WHERE sessionId = ? AND state NOT IN ('COMPLETED', 'SUPERSEDED')
       ORDER BY updatedAt DESC, rowid DESC
       LIMIT 1`,
    ),
    updateTask: db.prepare(
      `UPDATE tasks SET plan = ?, steps = ?, state = ?, pendingTools = ?, verification = ?, synthesis = ?, updatedAt = ? WHERE id = ?`,
    ),
    listTasks: db.prepare(`SELECT * FROM tasks WHERE sessionId = ? ORDER BY updatedAt DESC, rowid DESC LIMIT ?`),

    upsertWorkItem: db.prepare(
      `INSERT INTO work_items (id, parentId, missionId, taskId, objective, deliverable, workerId, workerVersion,
        skills, tools, state, attempts, heartbeats, outputs, handoff, verification, review, cost,
        tokensIn, tokensOut, latencyMs, failures, retries, valueScore, createdAt, updatedAt,
        criteria, constraints, forbiddenOutcomes, requiredEvidence, evidenceLinks, budget, workingDir,
        evidence, skillReceipts, nextAction, goalId, goalRevisionId)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET parentId = excluded.parentId, missionId = excluded.missionId,
        taskId = excluded.taskId, objective = excluded.objective, deliverable = excluded.deliverable,
        workerId = excluded.workerId, workerVersion = excluded.workerVersion, skills = excluded.skills,
        tools = excluded.tools, state = excluded.state, attempts = excluded.attempts,
        heartbeats = excluded.heartbeats, outputs = excluded.outputs, handoff = excluded.handoff,
        verification = excluded.verification, review = excluded.review, cost = excluded.cost,
        tokensIn = excluded.tokensIn, tokensOut = excluded.tokensOut, latencyMs = excluded.latencyMs,
        failures = excluded.failures, retries = excluded.retries, valueScore = excluded.valueScore,
        criteria = excluded.criteria, constraints = excluded.constraints, forbiddenOutcomes = excluded.forbiddenOutcomes,
        requiredEvidence = excluded.requiredEvidence, evidenceLinks = excluded.evidenceLinks, budget = excluded.budget,
        workingDir = excluded.workingDir, evidence = excluded.evidence, skillReceipts = excluded.skillReceipts,
        nextAction = excluded.nextAction,
        goalId = excluded.goalId, goalRevisionId = excluded.goalRevisionId,
        updatedAt = excluded.updatedAt`,
    ),
    getWorkItem: db.prepare(`SELECT * FROM work_items WHERE id = ?`),
    listWorkItems: db.prepare(
      `SELECT * FROM work_items
       WHERE (? IS NULL OR state = ?) AND (? IS NULL OR missionId = ?)
         AND (? IS NULL OR taskId = ?) AND (? IS NULL OR workerId = ?)
       ORDER BY updatedAt DESC, rowid DESC LIMIT ?`,
    ),
    childWorkItems: db.prepare(`SELECT * FROM work_items WHERE parentId = ? ORDER BY createdAt ASC, rowid ASC`),

    upsertWorkerProfile: db.prepare(
      `INSERT INTO worker_profiles (workerId, role, configVersion, domains, overallValue, overallConfidence, totalSamples, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workerId) DO UPDATE SET role = excluded.role, configVersion = excluded.configVersion,
        domains = excluded.domains, overallValue = excluded.overallValue,
        overallConfidence = excluded.overallConfidence, totalSamples = excluded.totalSamples,
        updatedAt = excluded.updatedAt`,
    ),
    getWorkerProfile: db.prepare(`SELECT * FROM worker_profiles WHERE workerId = ?`),
    listWorkerProfiles: db.prepare(`SELECT * FROM worker_profiles ORDER BY updatedAt DESC`),

    upsertPromptPattern: db.prepare(
      `INSERT INTO prompt_patterns (id, taskType, template, requiredFields, failureModes, verification, version, uses, successes, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET taskType = excluded.taskType, template = excluded.template,
        requiredFields = excluded.requiredFields, failureModes = excluded.failureModes,
        verification = excluded.verification, version = excluded.version, uses = excluded.uses,
        successes = excluded.successes, updatedAt = excluded.updatedAt`,
    ),
    getPromptPattern: db.prepare(`SELECT * FROM prompt_patterns WHERE id = ?`),
    listPromptPatterns: db.prepare(
      `SELECT * FROM prompt_patterns WHERE (? IS NULL OR taskType = ?) ORDER BY updatedAt DESC`,
    ),

    upsertSkillMetrics: db.prepare(
      `INSERT INTO skill_metrics (skillId, triggers, successes, verifications, failures, corrections, tokensUsed, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(skillId) DO UPDATE SET triggers = excluded.triggers, successes = excluded.successes,
        verifications = excluded.verifications, failures = excluded.failures, corrections = excluded.corrections,
        tokensUsed = excluded.tokensUsed, updatedAt = excluded.updatedAt`,
    ),
    getSkillMetrics: db.prepare(`SELECT * FROM skill_metrics WHERE skillId = ?`),
    listSkillMetrics: db.prepare(`SELECT * FROM skill_metrics ORDER BY updatedAt DESC`),

    appendActivity: db.prepare(
      `INSERT INTO activity_log (taskId, workItemId, workerId, kind, label, detail, at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ),
    listActivity: db.prepare(
      `SELECT * FROM activity_log
       WHERE (? IS NULL OR taskId = ?) AND (? IS NULL OR workItemId = ?)
       ORDER BY seq DESC LIMIT ?`,
    ),
    pruneActivity: db.prepare(
      `DELETE FROM activity_log WHERE seq NOT IN (SELECT seq FROM activity_log ORDER BY seq DESC LIMIT ?)`,
    ),
  };

  function inTransaction<T>(fn: () => T): T {
    db.exec("BEGIN");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // A failed ROLLBACK is not the error worth surfacing.
      }
      throw error;
    }
  }

  // ── Missions ────────────────────────────────────────────────────────────────

  function missionFromRow(row: Record<string, unknown>): Mission {
    const mission: Mission = {
      id: toStr(row.id),
      title: toStr(row.title),
      status: toStr(row.status) as MissionStatus,
      priority: toNum(row.priority),
      createdAt: toStr(row.createdAt),
      updatedAt: toStr(row.updatedAt),
      steps: [],
    };
    optional(mission, "description", row.description);
    optional(mission, "startedAt", row.startedAt);
    optional(mission, "completedAt", row.completedAt);
    optional(mission, "error", fromJson(row.error));
    optional(mission, "metadata", fromJson(row.metadata));
    return mission;
  }

  function stepFromRow(row: Record<string, unknown>): MissionStep {
    const step: MissionStep = {
      id: toStr(row.id),
      missionId: toStr(row.missionId),
      index: toNum(row["index"]),
      title: toStr(row.title),
      kind: toStr(row.kind) as MissionStep["kind"],
      status: toStr(row.status) as StepStatus,
      sideEffecting: toBool(row.sideEffecting),
    };
    optional(step, "target", row.target);
    optional(step, "input", fromJson(row.input));
    optional(step, "output", fromJson(row.output));
    optional(step, "startedAt", row.startedAt);
    optional(step, "completedAt", row.completedAt);
    optional(step, "error", fromJson(row.error));
    return step;
  }

  function stepsFor(missionId: string): MissionStep[] {
    const rows = stmts.listSteps.all(missionId) as unknown as Record<string, unknown>[];
    return rows.map(stepFromRow);
  }

  function fullMission(row: Record<string, unknown>): Mission {
    const mission = missionFromRow(row);
    mission.steps = stepsFor(mission.id);
    return mission;
  }

  const missions: MissionStore = {
    upsertMission(mission: Mission): void {
      inTransaction(() => {
        stmts.upsertMission.run(
          mission.id,
          mission.title,
          mission.description ?? null,
          mission.status,
          mission.priority,
          mission.createdAt,
          mission.updatedAt,
          mission.startedAt ?? null,
          mission.completedAt ?? null,
          toJson(mission.error),
          toJson(mission.metadata),
        );
        // Replace the step set wholesale: the mission's step list is the
        // source of truth, and a stale row from an earlier shape must not
        // survive. All inside the transaction, so a partial mission is never
        // visible to a concurrent reader.
        stmts.deleteSteps.run(mission.id);
        for (const step of mission.steps) {
          stmts.insertStep.run(
            step.id,
            step.missionId,
            step.index,
            step.title,
            step.kind,
            step.target ?? null,
            toJson(step.input),
            toJson(step.output),
            step.status,
            step.startedAt ?? null,
            step.completedAt ?? null,
            toJson(step.error),
            toBoolInt(step.sideEffecting),
          );
        }
      });
    },

    getMission(id: string): Mission | null {
      const row = stmts.getMission.get(id) as Record<string, unknown> | undefined;
      return row === undefined ? null : fullMission(row);
    },

    listMissions(opts: { status?: MissionStatus; limit?: number } = {}): Mission[] {
      const status = opts.status ?? null;
      const limit = opts.limit === undefined ? -1 : Math.max(0, opts.limit);
      const rows = stmts.listMissions.all(status, status, limit) as unknown as Record<string, unknown>[];
      return rows.map(fullMission);
    },

    listUnfinishedMissions(): Mission[] {
      const rows = stmts.listUnfinished.all() as unknown as Record<string, unknown>[];
      return rows.map(fullMission);
    },

    deleteMission(id: string): void {
      // Steps are removed by the FK cascade; delete them explicitly too so the
      // behaviour does not depend on foreign_keys being enabled.
      inTransaction(() => {
        stmts.deleteSteps.run(id);
        stmts.deleteMission.run(id);
      });
    },
  };

  // ── Events ──────────────────────────────────────────────────────────────────

  function eventFromRow(row: Record<string, unknown>): KaiEvent {
    const event: KaiEvent = {
      id: toStr(row.id),
      type: toStr(row.type) as KaiEventType,
      timestamp: toStr(row.timestamp),
      source: toStr(row.source),
      payload: fromJson(row.payload),
    };
    optional(event, "missionId", row.missionId);
    optional(event, "stepId", row.stepId);
    return event;
  }

  const events: EventStore = {
    insertEvent(event: KaiEvent): void {
      stmts.insertEvent.run(
        event.id,
        event.type,
        event.timestamp,
        event.source,
        toJson(event.payload),
        event.missionId ?? null,
        event.stepId ?? null,
      );
    },

    listEvents(
      opts: { limit?: number; missionId?: string; types?: readonly KaiEventType[]; since?: string } = {},
    ): KaiEvent[] {
      // An empty `types` list means "no type matches", which SQL's IN () cannot
      // express — short-circuit instead of building an invalid statement.
      if (opts.types !== undefined && opts.types.length === 0) return [];

      const missionId = opts.missionId ?? null;
      const since = opts.since ?? null;
      const typesJson = opts.types === undefined ? null : JSON.stringify([...opts.types]);
      const limit = opts.limit === undefined ? -1 : Math.max(0, opts.limit);
      const rows = stmts.listEvents.all(
        missionId,
        missionId,
        since,
        since,
        typesJson,
        typesJson,
        limit,
      ) as unknown as Record<string, unknown>[];
      return rows.map(eventFromRow);
    },
  };

  // ── Memories ────────────────────────────────────────────────────────────────

  function memoryFromRow(row: Record<string, unknown>): Memory {
    const memory: Memory = {
      id: toStr(row.id),
      type: toStr(row.type) as MemoryType,
      content: toStr(row.content),
      source: toStr(row.source) as Memory["source"],
      importance: toNum(row.importance, 3),
      createdAt: toStr(row.createdAt),
      updatedAt: toStr(row.updatedAt),
    };
    optional(memory, "metadata", fromJson(row.metadata));
    return memory;
  }

  const memory: MemoryStore = {
    createMemory(m: Memory): void {
      stmts.upsertMemory.run(
        m.id,
        m.type,
        m.content,
        m.source,
        m.importance,
        m.createdAt,
        m.updatedAt,
        toJson(m.metadata),
      );
    },

    getMemory(id: string): Memory | null {
      const row = stmts.getMemory.get(id) as Record<string, unknown> | undefined;
      return row === undefined ? null : memoryFromRow(row);
    },

    listMemories(opts: { type?: MemoryType; limit?: number } = {}): Memory[] {
      const type = opts.type ?? null;
      const limit = opts.limit === undefined ? -1 : Math.max(0, opts.limit);
      const rows = stmts.listMemories.all(type, type, limit) as unknown as Record<string, unknown>[];
      return rows.map(memoryFromRow);
    },

    updateMemory(m: Memory): void {
      stmts.updateMemory.run(
        m.type,
        m.content,
        m.source,
        m.importance,
        m.updatedAt,
        toJson(m.metadata),
        m.id,
      );
    },

    deleteMemory(id: string): void {
      stmts.deleteMemory.run(id);
    },
  };

  // ── Notifications ───────────────────────────────────────────────────────────

  function notificationFromRow(row: Record<string, unknown>): KaiNotification {
    const notification: KaiNotification = {
      id: toStr(row.id),
      type: toStr(row.type),
      title: toStr(row.title),
      priority: toStr(row.priority) as NotificationPriority,
      createdAt: toStr(row.createdAt),
      read: toBool(row.read),
    };
    optional(notification, "message", row.message);
    optional(notification, "missionId", row.missionId);
    optional(notification, "metadata", fromJson(row.metadata));
    return notification;
  }

  const notifications: NotificationStore = {
    createNotification(n: KaiNotification): void {
      stmts.insertNotification.run(
        n.id,
        n.type,
        n.title,
        n.message ?? null,
        n.priority,
        n.createdAt,
        toBoolInt(n.read),
        n.missionId ?? null,
        toJson(n.metadata),
      );
    },

    getNotification(id: string): KaiNotification | null {
      const row = stmts.getNotification.get(id) as Record<string, unknown> | undefined;
      return row === undefined ? null : notificationFromRow(row);
    },

    listNotifications(opts: { unreadOnly?: boolean; limit?: number } = {}): KaiNotification[] {
      const unreadOnly = opts.unreadOnly === true ? 1 : 0;
      const limit = opts.limit === undefined ? -1 : Math.max(0, opts.limit);
      const rows = stmts.listNotifications.all(unreadOnly, limit) as unknown as Record<string, unknown>[];
      return rows.map(notificationFromRow);
    },

    markRead(id: string, read: boolean): void {
      stmts.markRead.run(toBoolInt(read), id);
    },
  };

  // ── Approvals ───────────────────────────────────────────────────────────────

  function approvalFromRow(row: Record<string, unknown>): Approval {
    const approval: Approval = {
      id: toStr(row.id),
      toolId: toStr(row.toolId),
      action: toStr(row.action),
      reason: toStr(row.reason),
      risk: toStr(row.risk) as Approval["risk"],
      createdAt: toStr(row.createdAt),
      status: toStr(row.status) as ApprovalStatus,
    };
    optional(approval, "expiresAt", row.expiresAt);
    optional(approval, "decidedAt", row.decidedAt);
    optional(approval, "missionId", row.missionId);
    optional(approval, "stepId", row.stepId);
    optional(approval, "inputHash", row.inputHash);
    optional(approval, "consumedAt", row.consumedAt);
    return approval;
  }

  const approvals: ApprovalStore = {
    createApproval(a: Approval): void {
      stmts.insertApproval.run(
        a.id,
        a.toolId,
        a.action,
        a.reason,
        a.risk,
        a.createdAt,
        a.status,
        a.expiresAt ?? null,
        a.decidedAt ?? null,
        a.missionId ?? null,
        a.stepId ?? null,
        a.inputHash ?? null,
        a.consumedAt ?? null,
      );
    },

    getApproval(id: string): Approval | null {
      const row = stmts.getApproval.get(id) as Record<string, unknown> | undefined;
      return row === undefined ? null : approvalFromRow(row);
    },

    listApprovals(opts: { status?: ApprovalStatus; limit?: number } = {}): Approval[] {
      const status = opts.status ?? null;
      const limit = opts.limit === undefined ? -1 : Math.max(0, opts.limit);
      const rows = stmts.listApprovals.all(status, status, limit) as unknown as Record<string, unknown>[];
      return rows.map(approvalFromRow);
    },

    decideApproval(id: string, status: ApprovalStatus, decidedAt: string): void {
      stmts.decideApproval.run(status, decidedAt, id);
    },

    consumeApproval(id: string, consumedAt: string): boolean {
      // The WHERE clause is the guarantee: only an APPROVED, not-yet-spent row can be
      // spent, so two racing retries cannot both succeed.
      const result = stmts.consumeApproval.run(consumedAt, id) as { changes?: number } | undefined;
      return (result?.changes ?? 0) > 0;
    },
  };

  // ── Scheduled tasks ─────────────────────────────────────────────────────────

  function scheduledTaskFromRow(row: Record<string, unknown>): ScheduledTask {
    const task: ScheduledTask = {
      id: toStr(row.id),
      title: toStr(row.title),
      kind: toStr(row.kind) as ScheduledTask["kind"],
      action: toStr(row.action),
      enabled: toBool(row.enabled),
      failureCount: toNum(row.failureCount),
      createdAt: toStr(row.createdAt),
      updatedAt: toStr(row.updatedAt),
    };
    optional(task, "intervalMs", row.intervalMs === null || row.intervalMs === undefined ? null : toNum(row.intervalMs));
    optional(task, "atTime", row.atTime);
    optional(task, "runAt", row.runAt);
    optional(task, "payload", fromJson(row.payload));
    optional(task, "lastRun", row.lastRun);
    optional(task, "nextRun", row.nextRun);
    return task;
  }

  const scheduledTasks: ScheduledTaskStore = {
    upsertScheduledTask(t: ScheduledTask): void {
      stmts.upsertScheduledTask.run(
        t.id,
        t.title,
        t.kind,
        t.intervalMs ?? null,
        t.atTime ?? null,
        t.runAt ?? null,
        t.action,
        toJson(t.payload),
        toBoolInt(t.enabled),
        t.lastRun ?? null,
        t.nextRun ?? null,
        t.failureCount,
        t.createdAt,
        t.updatedAt,
      );
    },

    getScheduledTask(id: string): ScheduledTask | null {
      const row = stmts.getScheduledTask.get(id) as Record<string, unknown> | undefined;
      return row === undefined ? null : scheduledTaskFromRow(row);
    },

    listScheduledTasks(opts: { enabledOnly?: boolean } = {}): ScheduledTask[] {
      const enabledOnly = opts.enabledOnly === true ? 1 : 0;
      const rows = stmts.listScheduledTasks.all(enabledOnly) as unknown as Record<string, unknown>[];
      return rows.map(scheduledTaskFromRow);
    },

    deleteScheduledTask(id: string): void {
      stmts.deleteScheduledTask.run(id);
    },
  };

  const settings: SettingsStore = {
    get(key: string): string | null {
      const row = stmts.getSetting.get(key) as Record<string, unknown> | undefined;
      return row === undefined ? null : toStr(row.value);
    },

    set(key: string, value: string, updatedAt: string): void {
      stmts.setSetting.run(key, value, updatedAt);
    },

    delete(key: string): boolean {
      const result = stmts.deleteSetting.run(key) as unknown as { changes?: unknown };
      return toNum(result.changes, 0) > 0;
    },

    list(): { key: string; value: string; updatedAt: string }[] {
      const rows = stmts.listSettings.all() as unknown as Record<string, unknown>[];
      return rows.map((row) => ({ key: toStr(row.key), value: toStr(row.value), updatedAt: toStr(row.updatedAt) }));
    },
  };

  function taskFromRow(row: Record<string, unknown>): TaskRecord {
    return {
      id: toStr(row.id),
      sessionId: toStr(row.sessionId),
      objective: toStr(row.objective),
      plan: (fromJson<string[]>(row.plan) ?? []) as string[],
      steps: (fromJson<TaskRecord["steps"]>(row.steps) ?? []) as TaskRecord["steps"],
      state: toStr(row.state),
      pendingTools: (fromJson<string[]>(row.pendingTools) ?? []) as string[],
      verification: typeof row.verification === "string" ? (row.verification as string) : null,
      synthesis: typeof row.synthesis === "string" ? (row.synthesis as string) : null,
      createdAt: toStr(row.createdAt),
      updatedAt: toStr(row.updatedAt),
    };
  }

  const tasks: TaskStore = {
    createTask(task: TaskRecord): void {
      stmts.insertTask.run(
        task.id,
        task.sessionId,
        task.objective,
        JSON.stringify(task.plan),
        JSON.stringify(task.steps),
        task.state,
        JSON.stringify(task.pendingTools),
        task.verification,
        task.synthesis,
        task.createdAt,
        task.updatedAt,
      );
    },

    getTask(id: string): TaskRecord | null {
      const row = stmts.getTask.get(id) as Record<string, unknown> | undefined;
      return row === undefined ? null : taskFromRow(row);
    },

    activeTask(sessionId: string): TaskRecord | null {
      const row = stmts.activeTask.get(sessionId) as Record<string, unknown> | undefined;
      return row === undefined ? null : taskFromRow(row);
    },

    updateTask(
      id: string,
      patch: Partial<Pick<TaskRecord, "plan" | "steps" | "state" | "pendingTools" | "verification" | "synthesis">>,
      updatedAt: string,
    ): void {
      const current = this.getTask(id);
      if (current === null) return;
      stmts.updateTask.run(
        JSON.stringify(patch.plan ?? current.plan),
        JSON.stringify(patch.steps ?? current.steps),
        patch.state ?? current.state,
        JSON.stringify(patch.pendingTools ?? current.pendingTools),
        patch.verification !== undefined ? patch.verification : current.verification,
        patch.synthesis !== undefined ? patch.synthesis : current.synthesis,
        updatedAt,
        id,
      );
    },

    listTasks(sessionId: string, limit = 20): TaskRecord[] {
      const rows = stmts.listTasks.all(sessionId, limit) as unknown as Record<string, unknown>[];
      return rows.map(taskFromRow);
    },
  };

  const optStr = (v: unknown): string | null => (typeof v === "string" ? v : null);
  const optNum = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
  const jsonText = (v: unknown): string => JSON.stringify(v ?? null);
  function jsonArr<T>(v: unknown): T[] {
    const parsed = fromJson<T[]>(v);
    return Array.isArray(parsed) ? parsed : [];
  }

  function workItemFromRow(row: Record<string, unknown>): WorkItemRecord {
    return {
      id: toStr(row.id),
      ...(optStr(row.parentId) !== null ? { parentId: optStr(row.parentId) as string } : {}),
      ...(optStr(row.missionId) !== null ? { missionId: optStr(row.missionId) as string } : {}),
      ...(optStr(row.taskId) !== null ? { taskId: optStr(row.taskId) as string } : {}),
      objective: toStr(row.objective),
      ...(optStr(row.deliverable) !== null ? { deliverable: optStr(row.deliverable) as string } : {}),
      ...(optStr(row.workerId) !== null ? { workerId: optStr(row.workerId) as string } : {}),
      ...(optStr(row.workerVersion) !== null ? { workerVersion: optStr(row.workerVersion) as string } : {}),
      skills: jsonArr<string>(row.skills),
      tools: jsonArr<string>(row.tools),
      state: toStr(row.state),
      attempts: toNum(row.attempts, 0),
      heartbeats: jsonArr<{ at: string; step?: string; note?: string }>(row.heartbeats),
      ...(row.outputs !== null && row.outputs !== undefined ? { outputs: fromJson(row.outputs) } : {}),
      ...(row.handoff !== null && row.handoff !== undefined ? { handoff: fromJson(row.handoff) } : {}),
      ...(row.verification !== null && row.verification !== undefined ? { verification: fromJson(row.verification) } : {}),
      ...(row.review !== null && row.review !== undefined ? { review: fromJson(row.review) } : {}),
      ...(row.cost !== null && row.cost !== undefined ? { cost: fromJson(row.cost) } : {}),
      ...(optNum(row.tokensIn) !== undefined ? { tokensIn: optNum(row.tokensIn) as number } : {}),
      ...(optNum(row.tokensOut) !== undefined ? { tokensOut: optNum(row.tokensOut) as number } : {}),
      ...(optNum(row.latencyMs) !== undefined ? { latencyMs: optNum(row.latencyMs) as number } : {}),
      failures: jsonArr<string>(row.failures),
      retries: toNum(row.retries, 0),
      ...(optNum(row.valueScore) !== undefined ? { valueScore: optNum(row.valueScore) as number } : {}),
      createdAt: toStr(row.createdAt),
      updatedAt: toStr(row.updatedAt),
      // Schema v4 trust fields: absent (null) on pre-migration rows — the
      // board normalizes them to empty, so old work reads back intact.
      ...(row.criteria !== null && row.criteria !== undefined ? { criteria: jsonArr<string>(row.criteria) } : {}),
      ...(row.constraints !== null && row.constraints !== undefined ? { constraints: jsonArr<string>(row.constraints) } : {}),
      ...(row.forbiddenOutcomes !== null && row.forbiddenOutcomes !== undefined ? { forbiddenOutcomes: jsonArr<string>(row.forbiddenOutcomes) } : {}),
      ...(row.requiredEvidence !== null && row.requiredEvidence !== undefined ? { requiredEvidence: jsonArr<string>(row.requiredEvidence) } : {}),
      ...(row.evidenceLinks !== null && row.evidenceLinks !== undefined ? { evidenceLinks: fromJson(row.evidenceLinks) } : {}),
      ...(row.budget !== null && row.budget !== undefined ? { budget: fromJson(row.budget) } : {}),
      ...(optStr(row.workingDir) !== null ? { workingDir: optStr(row.workingDir) as string } : {}),
      ...(row.evidence !== null && row.evidence !== undefined ? { evidence: fromJson(row.evidence) } : {}),
      ...(row.skillReceipts !== null && row.skillReceipts !== undefined ? { skillReceipts: fromJson(row.skillReceipts) } : {}),
      ...(row.nextAction !== null && row.nextAction !== undefined ? { nextAction: fromJson(row.nextAction) } : {}),
      ...(row.goalId !== null && row.goalId !== undefined ? { goalId: String(row.goalId) } : {}),
      ...(row.goalRevisionId !== null && row.goalRevisionId !== undefined ? { goalRevisionId: String(row.goalRevisionId) } : {}),
    };
  }

  const workItems: WorkItemStore = {
    upsert(item: WorkItemRecord): void {
      stmts.upsertWorkItem.run(
        item.id,
        item.parentId ?? null,
        item.missionId ?? null,
        item.taskId ?? null,
        item.objective,
        item.deliverable ?? null,
        item.workerId ?? null,
        item.workerVersion ?? null,
        jsonText(item.skills),
        jsonText(item.tools),
        item.state,
        item.attempts,
        jsonText(item.heartbeats),
        item.outputs !== undefined ? jsonText(item.outputs) : null,
        item.handoff !== undefined ? jsonText(item.handoff) : null,
        item.verification !== undefined ? jsonText(item.verification) : null,
        item.review !== undefined ? jsonText(item.review) : null,
        item.cost !== undefined ? jsonText(item.cost) : null,
        item.tokensIn ?? null,
        item.tokensOut ?? null,
        item.latencyMs ?? null,
        jsonText(item.failures),
        item.retries,
        item.valueScore ?? null,
        item.createdAt,
        item.updatedAt,
        item.criteria !== undefined ? jsonText(item.criteria) : null,
        item.constraints !== undefined ? jsonText(item.constraints) : null,
        item.forbiddenOutcomes !== undefined ? jsonText(item.forbiddenOutcomes) : null,
        item.requiredEvidence !== undefined ? jsonText(item.requiredEvidence) : null,
        item.evidenceLinks !== undefined ? jsonText(item.evidenceLinks) : null,
        item.budget !== undefined ? jsonText(item.budget) : null,
        item.workingDir ?? null,
        item.evidence !== undefined ? jsonText(item.evidence) : null,
        item.skillReceipts !== undefined ? jsonText(item.skillReceipts) : null,
        item.nextAction !== undefined ? jsonText(item.nextAction) : null,
        item.goalId ?? null,
        item.goalRevisionId ?? null,
      );
    },
    get(id: string): WorkItemRecord | null {
      const row = stmts.getWorkItem.get(id) as Record<string, unknown> | undefined;
      return row === undefined ? null : workItemFromRow(row);
    },
    list(filter: { state?: string; missionId?: string; taskId?: string; workerId?: string; limit?: number } = {}): WorkItemRecord[] {
      const rows = stmts.listWorkItems.all(
        filter.state ?? null, filter.state ?? null,
        filter.missionId ?? null, filter.missionId ?? null,
        filter.taskId ?? null, filter.taskId ?? null,
        filter.workerId ?? null, filter.workerId ?? null,
        filter.limit ?? 100,
      ) as unknown as Record<string, unknown>[];
      return rows.map(workItemFromRow);
    },
    children(parentId: string): WorkItemRecord[] {
      const rows = stmts.childWorkItems.all(parentId) as unknown as Record<string, unknown>[];
      return rows.map(workItemFromRow);
    },
  };

  const workerProfiles: WorkerProfileStore = {
    upsert(profile: WorkerProfileRecord): void {
      stmts.upsertWorkerProfile.run(
        profile.workerId,
        profile.role,
        profile.configVersion,
        jsonText(profile.domains),
        profile.overallValue,
        profile.overallConfidence,
        profile.totalSamples,
        profile.updatedAt,
      );
    },
    get(workerId: string): WorkerProfileRecord | null {
      const row = stmts.getWorkerProfile.get(workerId) as Record<string, unknown> | undefined;
      if (row === undefined) return null;
      return {
        workerId: toStr(row.workerId),
        role: toStr(row.role),
        configVersion: toStr(row.configVersion),
        domains: (fromJson(row.domains) ?? {}) as Record<string, unknown>,
        overallValue: toNum(row.overallValue, 0),
        overallConfidence: toStr(row.overallConfidence),
        totalSamples: toNum(row.totalSamples, 0),
        updatedAt: toStr(row.updatedAt),
      };
    },
    list(): WorkerProfileRecord[] {
      const rows = stmts.listWorkerProfiles.all() as unknown as Record<string, unknown>[];
      return rows.map((row) => workerProfiles.get(toStr(row.workerId)) as WorkerProfileRecord);
    },
  };

  const promptPatterns: PromptPatternStore = {
    upsert(pattern: PromptPatternRecord): void {
      stmts.upsertPromptPattern.run(
        pattern.id,
        pattern.taskType,
        pattern.template,
        jsonText(pattern.requiredFields),
        jsonText(pattern.failureModes),
        jsonText(pattern.verification),
        pattern.version,
        pattern.uses,
        pattern.successes,
        pattern.updatedAt,
      );
    },
    get(id: string): PromptPatternRecord | null {
      const row = stmts.getPromptPattern.get(id) as Record<string, unknown> | undefined;
      if (row === undefined) return null;
      return {
        id: toStr(row.id),
        taskType: toStr(row.taskType),
        template: toStr(row.template),
        requiredFields: jsonArr<string>(row.requiredFields),
        failureModes: jsonArr<string>(row.failureModes),
        verification: jsonArr<string>(row.verification),
        version: toNum(row.version, 1),
        uses: toNum(row.uses, 0),
        successes: toNum(row.successes, 0),
        updatedAt: toStr(row.updatedAt),
      };
    },
    list(taskType?: string): PromptPatternRecord[] {
      const rows = stmts.listPromptPatterns.all(taskType ?? null, taskType ?? null) as unknown as Record<string, unknown>[];
      return rows.map((row) => promptPatterns.get(toStr(row.id)) as PromptPatternRecord);
    },
  };

  const skillMetrics: SkillMetricsStore = {
    upsert(metrics: SkillMetricsRecord): void {
      stmts.upsertSkillMetrics.run(
        metrics.skillId,
        metrics.triggers,
        metrics.successes,
        metrics.verifications,
        metrics.failures,
        metrics.corrections,
        metrics.tokensUsed,
        metrics.updatedAt,
      );
    },
    get(skillId: string): SkillMetricsRecord | null {
      const row = stmts.getSkillMetrics.get(skillId) as Record<string, unknown> | undefined;
      if (row === undefined) return null;
      return {
        skillId: toStr(row.skillId),
        triggers: toNum(row.triggers, 0),
        successes: toNum(row.successes, 0),
        verifications: toNum(row.verifications, 0),
        failures: toNum(row.failures, 0),
        corrections: toNum(row.corrections, 0),
        tokensUsed: toNum(row.tokensUsed, 0),
        updatedAt: toStr(row.updatedAt),
      };
    },
    list(): SkillMetricsRecord[] {
      const rows = stmts.listSkillMetrics.all() as unknown as Record<string, unknown>[];
      return rows.map((row) => skillMetrics.get(toStr(row.skillId)) as SkillMetricsRecord);
    },
  };

  const activity: ActivityStore = {
    append(event: { taskId?: string; workItemId?: string; workerId?: string; kind: string; label: string; detail?: string; at: string }): number {
      const result = stmts.appendActivity.run(
        event.taskId ?? null,
        event.workItemId ?? null,
        event.workerId ?? null,
        event.kind,
        event.label,
        event.detail ?? null,
        event.at,
      ) as unknown as { lastInsertRowid?: unknown };
      stmts.pruneActivity.run(2000);
      const id = result.lastInsertRowid;
      return typeof id === "number" ? id : Number(id ?? 0);
    },
    list(filter: { taskId?: string; workItemId?: string; limit?: number } = {}): ActivityEventRecord[] {
      const rows = stmts.listActivity.all(
        filter.taskId ?? null, filter.taskId ?? null,
        filter.workItemId ?? null, filter.workItemId ?? null,
        filter.limit ?? 100,
      ) as unknown as Record<string, unknown>[];
      return rows.map((row) => ({
        seq: toNum(row.seq, 0),
        ...(optStr(row.taskId) !== null ? { taskId: optStr(row.taskId) as string } : {}),
        ...(optStr(row.workItemId) !== null ? { workItemId: optStr(row.workItemId) as string } : {}),
        ...(optStr(row.workerId) !== null ? { workerId: optStr(row.workerId) as string } : {}),
        kind: toStr(row.kind),
        label: toStr(row.label),
        ...(optStr(row.detail) !== null ? { detail: optStr(row.detail) as string } : {}),
        at: toStr(row.at),
      }));
    },
    prune(cap: number): number {
      const result = stmts.pruneActivity.run(cap) as unknown as { changes?: unknown };
      return toNum(result.changes, 0);
    },
  };

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  let closed = false;
  function close(): void {
    if (closed) return;
    closed = true;
    db.close();
  }

  return { events, missions, memory, notifications, approvals, scheduledTasks, settings, tasks, workItems, workerProfiles, promptPatterns, skillMetrics, activity, close };
}

// ── Migrations ────────────────────────────────────────────────────────────────

/**
 * Apply every migration whose version is above the database's `user_version`.
 * Each migration runs in its own transaction together with its version bump, so
 * a crash mid-migration leaves a retryable, consistent database — and an
 * already-migrated database is left exactly as it was.
 */
function migrate(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: unknown } | undefined;
  let current = toNum(row?.user_version, 0);

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    db.exec("BEGIN");
    try {
      for (const statement of migration.statements) {
        try {
          db.exec(statement);
        } catch (error) {
          // `ALTER TABLE … ADD COLUMN` is the one statement here that SQLite cannot make
          // idempotent, and a database can legitimately already have the column: another
          // build may have stamped a schema version this source does not carry. This file
          // promises idempotent migrations, so an already-present column counts as applied.
          // Every other failure still aborts the migration, untouched.
          const alreadyAdded =
            /^\s*ALTER\s+TABLE\s+\S+\s+ADD\s+COLUMN/i.test(statement) &&
            error instanceof Error &&
            /duplicate column name/i.test(error.message);
          if (alreadyAdded) continue;
          throw error;
        }
      }
      db.exec(`PRAGMA user_version = ${Math.trunc(migration.version)}`);
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Preserve the original failure.
      }
      throw error;
    }
    current = migration.version;
  }

  // Defensive: a database claiming a newer version than this build understands
  // is a downgrade, not something to "fix" by rewriting it.
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `database schema version ${current} is newer than this build (${SCHEMA_VERSION}); ` +
        "refusing to open (it may have been written by a newer KAI Core)",
    );
  }
}
