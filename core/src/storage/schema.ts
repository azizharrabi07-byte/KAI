// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * KAI Core — SQLite schema and migrations (spec §30).
 *
 * The schema lives here, not in the SQLite module, so the tables can be read
 * (and reviewed) without reading the query code.
 *
 * Design rules that the rest of the storage layer depends on:
 *   - Timestamps are ISO-8601 TEXT, stored exactly as the contract carries
 *     them — no epoch conversion, no timezone normalisation on the way in.
 *   - Booleans are INTEGER 0/1 (`sideEffecting`, `read`, `enabled`).
 *   - Structured fields (payload, metadata, input, output, error) are JSON
 *     TEXT, written with JSON.stringify and read back with JSON.parse, so a
 *     value that goes in comes back byte-equal when re-serialised.
 *   - Migrations are ordered and idempotent, tracked with `PRAGMA
 *     user_version`. Every statement uses CREATE ... IF NOT EXISTS: an
 *     existing table is never dropped or recreated, because that would
 *     silently destroy user data on an upgrade.
 */

/** Target schema version. Bump by appending to MIGRATIONS, never by editing. */
export const SCHEMA_VERSION = 3;

export interface Migration {
  readonly version: number;
  readonly statements: readonly string[];
}

/**
 * Ordered, append-only migration list. Migration N runs only when the
 * database's `user_version` is below N; each is applied inside a transaction
 * together with its version bump, so a failed migration leaves the version
 * untouched and can be retried.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    statements: [
      // ── settings ──────────────────────────────────────────────────────────
      `CREATE TABLE IF NOT EXISTS settings (
        "key"     TEXT PRIMARY KEY,
        value     TEXT,
        updatedAt TEXT NOT NULL
      )`,

      // ── agents ────────────────────────────────────────────────────────────
      // Declared capabilities/state of an agent adapter. One row per adapter id.
      `CREATE TABLE IF NOT EXISTS agents (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        kind         TEXT,
        state        TEXT,
        currentTask  TEXT,
        startedAt    TEXT,
        lastActivity TEXT,
        detail       TEXT,
        endpoint     TEXT,
        version      TEXT,
        updatedAt    TEXT NOT NULL
      )`,

      // ── agent_runs ────────────────────────────────────────────────────────
      // One row per AgentTask KAI handed to an adapter (spec §18). A run that
      // KAI abandoned is distinguishable from one that failed on its own.
      `CREATE TABLE IF NOT EXISTS agent_runs (
        id                TEXT PRIMARY KEY,
        agentId           TEXT,
        taskId            TEXT NOT NULL,
        state             TEXT NOT NULL,
        input             TEXT,
        output            TEXT,
        error             TEXT,
        usageInputTokens  INTEGER,
        usageOutputTokens INTEGER,
        startedAt         TEXT,
        completedAt       TEXT,
        createdAt         TEXT NOT NULL,
        missionId         TEXT,
        stepId            TEXT
      )`,

      // ── missions ──────────────────────────────────────────────────────────
      `CREATE TABLE IF NOT EXISTS missions (
        id          TEXT PRIMARY KEY,
        title       TEXT NOT NULL,
        description TEXT,
        status      TEXT NOT NULL,
        priority    INTEGER NOT NULL DEFAULT 0,
        createdAt   TEXT NOT NULL,
        updatedAt   TEXT NOT NULL,
        startedAt   TEXT,
        completedAt TEXT,
        error       TEXT,
        metadata    TEXT
      )`,

      // ── mission_steps ─────────────────────────────────────────────────────
      // `index` is reserved in SQLite and must stay quoted. The executor runs
      // steps in ascending index order, so the read side orders by it.
      `CREATE TABLE IF NOT EXISTS mission_steps (
        id            TEXT PRIMARY KEY,
        missionId     TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        "index"       INTEGER NOT NULL,
        title         TEXT NOT NULL,
        kind          TEXT NOT NULL,
        target        TEXT,
        input         TEXT,
        output        TEXT,
        status        TEXT NOT NULL,
        startedAt     TEXT,
        completedAt   TEXT,
        error         TEXT,
        sideEffecting INTEGER NOT NULL DEFAULT 0
      )`,

      // ── events ────────────────────────────────────────────────────────────
      // Only user-visible / lifecycle-defining events reach here (the bus
      // filters with shouldPersist), so this stays a small audit trail.
      `CREATE TABLE IF NOT EXISTS events (
        id        TEXT PRIMARY KEY,
        type      TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        source    TEXT NOT NULL,
        payload   TEXT,
        missionId TEXT,
        stepId    TEXT
      )`,

      // ── notifications ─────────────────────────────────────────────────────
      `CREATE TABLE IF NOT EXISTS notifications (
        id        TEXT PRIMARY KEY,
        type      TEXT NOT NULL,
        title     TEXT NOT NULL,
        message   TEXT,
        priority  TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        read      INTEGER NOT NULL DEFAULT 0,
        missionId TEXT,
        metadata  TEXT
      )`,

      // ── memories ──────────────────────────────────────────────────────────
      // Every row says where it came from (`source`); importance is 1..5.
      `CREATE TABLE IF NOT EXISTS memories (
        id         TEXT PRIMARY KEY,
        type       TEXT NOT NULL,
        content    TEXT NOT NULL,
        source     TEXT NOT NULL,
        importance INTEGER NOT NULL DEFAULT 3,
        createdAt  TEXT NOT NULL,
        updatedAt  TEXT NOT NULL,
        metadata   TEXT
      )`,

      // ── scheduled_tasks ───────────────────────────────────────────────────
      `CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id           TEXT PRIMARY KEY,
        title        TEXT NOT NULL,
        kind         TEXT NOT NULL,
        intervalMs   INTEGER,
        atTime       TEXT,
        runAt        TEXT,
        action       TEXT NOT NULL,
        payload      TEXT,
        enabled      INTEGER NOT NULL DEFAULT 1,
        lastRun      TEXT,
        nextRun      TEXT,
        failureCount INTEGER NOT NULL DEFAULT 0,
        createdAt    TEXT NOT NULL,
        updatedAt    TEXT NOT NULL
      )`,

      // ── approvals ─────────────────────────────────────────────────────────
      `CREATE TABLE IF NOT EXISTS approvals (
        id        TEXT PRIMARY KEY,
        toolId    TEXT NOT NULL,
        action    TEXT NOT NULL,
        reason    TEXT NOT NULL,
        risk      TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        status    TEXT NOT NULL,
        expiresAt TEXT,
        decidedAt TEXT,
        missionId TEXT,
        stepId    TEXT
      )`,

      // ── indexes ───────────────────────────────────────────────────────────
      `CREATE INDEX IF NOT EXISTS idx_mission_steps_mission ON mission_steps (missionId, "index")`,
      `CREATE INDEX IF NOT EXISTS idx_events_timestamp        ON events (timestamp DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_events_mission          ON events (missionId)`,
      `CREATE INDEX IF NOT EXISTS idx_events_type             ON events (type)`,
      `CREATE INDEX IF NOT EXISTS idx_missions_status         ON missions (status)`,
      `CREATE INDEX IF NOT EXISTS idx_notifications_created   ON notifications (createdAt DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_notifications_read      ON notifications (read)`,
      `CREATE INDEX IF NOT EXISTS idx_memories_type           ON memories (type)`,
      `CREATE INDEX IF NOT EXISTS idx_approvals_status        ON approvals (status)`,
      `CREATE INDEX IF NOT EXISTS idx_scheduled_enabled       ON scheduled_tasks (enabled)`,
      `CREATE INDEX IF NOT EXISTS idx_agent_runs_agent        ON agent_runs (agentId)`,
      `CREATE INDEX IF NOT EXISTS idx_agent_runs_mission      ON agent_runs (missionId)`,
    ],
  },
  {
    version: 2,
    statements: [
      // ── tasks ─────────────────────────────────────────────────────────────
      // One row per user objective per session: the ORIGINAL request plus the
      // plan, the completed/current/pending steps, the verification record and
      // the synthesis state. The task lifecycle (RECEIVED -> … -> COMPLETED /
      // BLOCKED / PAUSED) is the thing that stops KAI from mistaking "a tool
      // ran" for "the task is done", and it is what "continue" resumes.
      `CREATE TABLE IF NOT EXISTS tasks (
        id            TEXT PRIMARY KEY,
        sessionId     TEXT NOT NULL,
        objective     TEXT NOT NULL,
        plan          TEXT NOT NULL,
        steps         TEXT NOT NULL,
        state         TEXT NOT NULL,
        pendingTools  TEXT NOT NULL,
        verification  TEXT,
        synthesis     TEXT,
        createdAt     TEXT NOT NULL,
        updatedAt     TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks (sessionId, updatedAt DESC)`,
    ],
  },
  {
    version: 3,
    statements: [
      // ── work_items (KAI work board) ───────────────────────────────────────
      // One row per delegated unit with parent linkage, worker assignment,
      // heartbeats, structured handoff, verification and review — the durable
      // state behind the autonomous operator loop. Survives restarts.
      `CREATE TABLE IF NOT EXISTS work_items (
        id            TEXT PRIMARY KEY,
        parentId      TEXT,
        missionId     TEXT,
        taskId        TEXT,
        objective     TEXT NOT NULL,
        deliverable   TEXT,
        workerId      TEXT,
        workerVersion TEXT,
        skills        TEXT NOT NULL,
        tools         TEXT NOT NULL,
        state         TEXT NOT NULL,
        attempts      INTEGER NOT NULL,
        heartbeats    TEXT NOT NULL,
        outputs       TEXT,
        handoff       TEXT,
        verification  TEXT,
        review        TEXT,
        cost          TEXT,
        tokensIn      INTEGER,
        tokensOut     INTEGER,
        latencyMs     INTEGER,
        failures      TEXT NOT NULL,
        retries       INTEGER NOT NULL,
        valueScore    REAL,
        createdAt     TEXT NOT NULL,
        updatedAt     TEXT NOT NULL
      )`,
      // ── worker_profiles (benchmarks) ──────────────────────────────────────
      // Measured per-domain stats + overall value. Written ONLY from verified
      // runtime outcomes — workers can never write their own scores.
      `CREATE TABLE IF NOT EXISTS worker_profiles (
        workerId          TEXT PRIMARY KEY,
        role              TEXT NOT NULL,
        configVersion     TEXT NOT NULL,
        domains           TEXT NOT NULL,
        overallValue      REAL NOT NULL,
        overallConfidence TEXT NOT NULL,
        totalSamples      INTEGER NOT NULL,
        updatedAt         TEXT NOT NULL
      )`,
      // ── prompt_patterns ───────────────────────────────────────────────────
      // Reusable prompt strategies with measured uses/successes.
      `CREATE TABLE IF NOT EXISTS prompt_patterns (
        id              TEXT PRIMARY KEY,
        taskType        TEXT NOT NULL,
        template        TEXT NOT NULL,
        requiredFields  TEXT NOT NULL,
        failureModes    TEXT NOT NULL,
        verification    TEXT NOT NULL,
        version         INTEGER NOT NULL,
        uses            INTEGER NOT NULL,
        successes       INTEGER NOT NULL,
        updatedAt       TEXT NOT NULL
      )`,
      // ── skill_metrics ─────────────────────────────────────────────────────
      // Trigger/success/verification/failure counts per skill for the quality
      // feedback loop. Updated from verified outcomes only.
      `CREATE TABLE IF NOT EXISTS skill_metrics (
        skillId       TEXT PRIMARY KEY,
        triggers      INTEGER NOT NULL,
        successes     INTEGER NOT NULL,
        verifications INTEGER NOT NULL,
        failures      INTEGER NOT NULL,
        corrections   INTEGER NOT NULL,
        tokensUsed    INTEGER NOT NULL,
        updatedAt     TEXT NOT NULL
      )`,
      // ── activity_log (bounded) ────────────────────────────────────────────
      // Compact status units for the activity trace. Bounded: the store prunes
      // beyond ACTIVITY_LOG_CAP so the log can never grow without limit.
      `CREATE TABLE IF NOT EXISTS activity_log (
        seq         INTEGER PRIMARY KEY AUTOINCREMENT,
        taskId      TEXT,
        workItemId  TEXT,
        workerId    TEXT,
        kind        TEXT NOT NULL,
        label       TEXT NOT NULL,
        detail      TEXT,
        at          TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_work_items_state  ON work_items (state, updatedAt DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_work_items_parent ON work_items (parentId)`,
      `CREATE INDEX IF NOT EXISTS idx_work_items_task   ON work_items (taskId)`,
      `CREATE INDEX IF NOT EXISTS idx_activity_task     ON activity_log (taskId, seq DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_activity_work     ON activity_log (workItemId, seq DESC)`,
    ],
  },
];
