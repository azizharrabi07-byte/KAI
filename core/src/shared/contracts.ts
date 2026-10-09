/**
 * KAI Core — shared contracts.
 *
 * FROZEN INTERFACE. Core modules are written in parallel against this file, so
 * changing a shape here breaks work in flight elsewhere: extend, do not reshape.
 *
 * Every shape that crosses an IPC boundary (Core <-> desktop app, Core <-> an
 * agent adapter, Core <-> storage) is defined once here rather than per module —
 * the failure mode this prevents is three modules each inventing "status".
 *
 * Runtime validation lives next to each type. TypeScript types are erased at
 * runtime, and data crossing the IPC boundary is untrusted, so the guards below
 * (not the types) are what actually protect the Core.
 */

// Type-only: `runtime-events.ts` is dependency-free, so this cannot cycle. The
// employee and turn shapes below are defined here; the *event* vocabulary they
// emit lives there, kept separate on purpose (a provider stream and a
// control-plane log are different things and must not share one union).
import type { EmployeeKind, TurnAdapter } from "./runtime-events.ts";

// ── Agents ────────────────────────────────────────────────────────────────────

/**
 * Coarse, agent-agnostic state. Deliberately small: an agent that cannot tell us
 * anything finer must be able to report one of these honestly.
 */
export type AgentState =
  | "offline"
  | "connecting"
  | "idle"
  | "working"
  | "waiting"
  | "error";

export interface AgentStatus {
  id: string;
  state: AgentState;
  /** Human-readable task the agent says it is doing, when it can say. */
  currentTask?: string;
  /** ISO-8601, when the current task started. */
  startedAt?: string;
  /** ISO-8601, last successful contact with the agent. */
  lastActivity?: string;
  /** Short, user-facing explanation when state is "error". */
  detail?: string;
}

export interface AgentHealth {
  ok: boolean;
  /** Round-trip time of the health probe, milliseconds. */
  latencyMs?: number;
  version?: string;
  /** Where the agent was reached, e.g. http://127.0.0.1:8642. */
  endpoint?: string;
  detail?: string;
}

/** What an agent can actually do. Capabilities are declared, never assumed. */
export type AgentCapability =
  | "health"
  | "status"
  | "message"
  | "run_task"
  | "cancel_task"
  | "events"
  | "sessions";

export interface AgentMessage {
  text: string;
  /** Free-form context an adapter may forward (a file, a project path). */
  context?: Record<string, unknown>;
}

export interface AgentResponse {
  text: string;
  /** Agent-reported usage, when available. Never used for billing. */
  usage?: { inputTokens?: number; outputTokens?: number };
  raw?: unknown;
}

export interface AgentTask {
  /** KAI's own id for the work, so a run can be traced back to a mission step. */
  id: string;
  input: string;
  /** Adapter-specific options; adapters ignore what they do not understand. */
  options?: Record<string, unknown>;
}

/**
 * Explicit run lifecycle (spec §18). A run that KAI gave up on must be
 * distinguishable from one that failed on its own, and nothing may be silently
 * forgotten: `abandoned` means KAI stopped talking to it *and* asked it to stop.
 */
export type RunState =
  | "created"
  | "submitted"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "abandoned";

export interface AgentTaskResult {
  taskId: string;
  state: RunState;
  output?: string;
  startedAt?: string;
  completedAt?: string;
  /** Structured, not a string: callers switch on `code`. */
  error?: KaiError;
  usage?: { inputTokens?: number; outputTokens?: number };
}

/**
 * A machine-readable failure. Errors are values, never bare strings, so the UI
 * can decide what to say and the Core can decide whether to retry.
 */
export interface KaiError {
  code: KaiErrorCode;
  message: string;
  retryable: boolean;
  /** ISO-8601. */
  at: string;
  detail?: string;
}

export type KaiErrorCode =
  | "AGENT_NOT_LISTENING"
  | "AGENT_TIMEOUT"
  | "AGENT_AUTH_FAILED"
  | "AGENT_BAD_RESPONSE"
  | "AGENT_RUN_FAILED"
  | "AGENT_RUN_ABANDONED"
  | "AGENT_CAPABILITY_MISSING"
  | "VALIDATION_FAILED"
  | "NOT_FOUND"
  | "STORAGE_FAILED"
  | "POLICY_DENIED"
  | "APPROVAL_REQUIRED"
  | "CANCELLED"
  | "INTERNAL";

/**
 * Every adapter implements this. Nothing else in the Core may talk to an agent
 * directly — that is what keeps Hermes' port number out of the UI and out of
 * the mission engine.
 */
export interface AgentAdapter {
  /**
   * Aborts in-flight work so shutdown is immediate. Optional and additive.
   *
   * A timeout cannot be hurried — it only fires when it expires — so once a worker turn
   * is allowed to run for minutes, a Core that is stopping needs a way to cut it short
   * that is not "wait up to fifteen minutes". Adapters that hold no long request omit it.
   */
  abort?(): void;
  readonly id: string;
  readonly name: string;

  connect(): Promise<void>;
  disconnect(): Promise<void>;

  health(): Promise<AgentHealth>;
  getStatus(): Promise<AgentStatus>;
  capabilities(): readonly AgentCapability[];

  sendMessage(message: AgentMessage): Promise<AgentResponse>;

  runTask(task: AgentTask): Promise<AgentTaskResult>;
  /** Absent when the agent cannot cancel — callers must check capabilities(). */
  cancelTask?(taskId: string): Promise<void>;
}

// ── Events ────────────────────────────────────────────────────────────────────

export type KaiEventType =
  // Process lifecycle. Added when the Core runtime was wired: these are the events
  // that say whether the control plane itself is up, which is the first thing the
  // UI needs to know. Extended, never reshaped — no existing member changed.
  | "app.started"
  | "app.stopped"
  | "core.started"
  | "core.stopped"
  | "core.status_changed"
  | "agent.connected"
  | "agent.disconnected"
  | "agent.status_changed"
  | "agent.output"
  | "agent.error"
  // Subagent run/persona lifecycle (P7-P9). Extended, never reshaped: every
  // event is emitted from actual runtime state in runSubagent/createSubagent,
  // never synthesised. A parked run emits run_started, then run_completed or
  // run_cancelled when its approval is decided.
  | "agent.spawned"
  | "agent.run_started"
  | "agent.run_completed"
  | "agent.run_failed"
  | "agent.run_cancelled"
  | "mission.created"
  | "mission.started"
  | "mission.progress"
  | "mission.completed"
  | "mission.failed"
  | "mission.cancelled"
  | "notification.created"
  | "notification.read"
  | "approval.requested"
  | "approval.approved"
  | "approval.rejected"
  | "memory.created"
  | "memory.deleted"
  | "scheduler.started"
  | "scheduler.stopped"
  | "scheduled_task.triggered"
  // A housekeeping callback on the scheduler's tick seam threw. The tick keeps
  // running; this records the failure so it is observable, not swallowed.
  | "scheduler.tick_failed"
  // Phase 1 observability: one record per executable action, carrying the executor
  // identity, the deciding authority, the approval and the Core build.
  | "action.executed"
  // Orchestration: worker/task lifecycle, reviews, benchmarks. Extended,
  // never reshaped. Heartbeats and progress are live-only (never persisted);
  // completions, failures, reviews and benchmark updates persist.
  | "worker.started"
  | "worker.heartbeat"
  | "worker.progress"
  | "worker.waiting"
  | "worker.review"
  | "worker.completed"
  | "worker.failed"
  | "worker.cancelled"
  | "review.requested"
  | "review.decided"
  | "delegation.routed"
  | "benchmark.updated"
  // Live command execution: a real child process's output, chunk by chunk, so
  // the UI can show stdout/stderr WHILE the command runs — never a post-exit
  // dump. Chunks are live-only; started/exit persist as lifecycle records.
  | "command.started"
  | "command.stdout"
  | "command.stderr"
  | "command.exit"
  // Optional decision accelerator telemetry (JEV): recorded only when a
  // provider is actually consulted. Live-only; never persisted.
  | "decision.provider_used";

export interface KaiEvent<T = unknown> {
  id: string;
  type: KaiEventType;
  /** ISO-8601. */
  timestamp: string;
  /** Who caused it: "core", "hermes", "opencode", "scheduler", "ui", "mission:<id>". */
  source: string;
  payload: T;
  /** Correlation for missions/steps: set when the event belongs to a mission. */
  missionId?: string;
  stepId?: string;
}

/**
 * Persisting every event would turn SQLite into a high-frequency dump (spec §13),
 * so the bus asks this predicate before writing. User-visible and
 * lifecycle-defining events are kept; chit-chat is not.
 */
export const PERSISTED_EVENT_TYPES: readonly KaiEventType[] = [
  "core.status_changed",
  "agent.connected",
  "agent.disconnected",
  "mission.created",
  "mission.started",
  "mission.completed",
  "mission.failed",
  "mission.cancelled",
  "notification.created",
  "approval.requested",
  "approval.approved",
  "approval.rejected",
  "agent.spawned",
  "agent.run_started",
  "agent.run_completed",
  "agent.run_failed",
  "agent.run_cancelled",
  "scheduled_task.triggered",
  // An action record is exactly the kind of event worth keeping: it answers "who did
  // this, under which authority, in which build" long after the process is gone.
  "action.executed",
  // Orchestration lifecycle: completions, failures, reviews and benchmark
  // updates persist; heartbeats and progress stay live-only by construction.
  "worker.started",
  "worker.completed",
  "worker.failed",
  "worker.cancelled",
  "review.requested",
  "review.decided",
  "delegation.routed",
  "benchmark.updated",
  // Command lifecycle persists (started/exit); stdout/stderr chunks stay live.
  "command.started",
  "command.exit",
];

export function shouldPersist(type: KaiEventType): boolean {
  return PERSISTED_EVENT_TYPES.includes(type);
}

// ── Missions ──────────────────────────────────────────────────────────────────

export type MissionStatus =
  | "DRAFT"
  | "QUEUED"
  | "RUNNING"
  | "WAITING"
  | "WAITING_APPROVAL"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export type StepStatus =
  | "PENDING"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "SKIPPED"
  | "WAITING_APPROVAL";

export interface MissionStep {
  id: string;
  missionId: string;
  /** Position in the mission; the executor runs them in ascending order. */
  index: number;
  title: string;
  /** What kind of work: which module or agent is expected to perform it. */
  kind: "tool" | "agent" | "manual";
  /** Tool id or agent id, depending on `kind`. */
  target?: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  status: StepStatus;
  startedAt?: string;
  completedAt?: string;
  error?: KaiError;
  /**
   * True for steps that touch the world (write, publish, delete, send). The
   * executor must never re-run one of these automatically after a crash
   * (spec §29) — only steps with this false may be resumed.
   */
  sideEffecting: boolean;
}

export interface Mission {
  id: string;
  title: string;
  description?: string;
  status: MissionStatus;
  priority: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  steps: MissionStep[];
  error?: KaiError;
  metadata?: Record<string, unknown>;
}

// ── Notifications ─────────────────────────────────────────────────────────────

export type NotificationPriority = "LOW" | "NORMAL" | "HIGH" | "CRITICAL";

export interface KaiNotification {
  id: string;
  type: string;
  title: string;
  message?: string;
  priority: NotificationPriority;
  createdAt: string;
  read: boolean;
  missionId?: string;
  metadata?: Record<string, unknown>;
}

// ── Approvals ─────────────────────────────────────────────────────────────────

export type ApprovalStatus = "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED";
/** Mirrors the tool risk levels in the policy engine (spec §37/§38). */
export type RiskLevel = "READ" | "WRITE" | "EXTERNAL" | "DESTRUCTIVE";

export interface Approval {
  id: string;
  toolId: string;
  action: string;
  reason: string;
  risk: RiskLevel;
  createdAt: string;
  status: ApprovalStatus;
  expiresAt?: string;
  decidedAt?: string;
  missionId?: string;
  stepId?: string;
}

// ── Memory ────────────────────────────────────────────────────────────────────

export type MemoryType =
  | "user_preference"
  | "project_fact"
  | "agent_fact"
  | "mission_context"
  | "note";

/** Memory is intentional and traceable (spec §32): every row says where it came from. */
export type MemorySource =
  | "user_statement"
  | "system_state"
  | "mission_result"
  | "agent_output";

export interface Memory {
  id: string;
  type: MemoryType;
  content: string;
  source: MemorySource;
  /** 1 (trivia) to 5 (must not be forgotten). */
  importance: number;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

export type ScheduleKind = "once" | "interval" | "daily";

export interface ScheduledTask {
  id: string;
  title: string;
  kind: ScheduleKind;
  /** For "interval": milliseconds between runs. */
  intervalMs?: number;
  /** For "daily": "HH:MM" local time. */
  atTime?: string;
  /** For "once": ISO-8601 instant. */
  runAt?: string;
  /** What to do when it fires: a mission template or a registered job name. */
  action: string;
  payload?: Record<string, unknown>;
  enabled: boolean;
  lastRun?: string;
  nextRun?: string;
  failureCount: number;
  createdAt: string;
  updatedAt: string;
}

// ── Core health ───────────────────────────────────────────────────────────────

export type CoreLifecycle =
  | "STARTING"
  | "RUNNING"
  | "DEGRADED"
  | "STOPPING"
  | "STOPPED"
  | "FAILED";

export interface CoreHealth {
  status: "ok" | "degraded" | "failed";
  service: "kai-core";
  version: string;
  lifecycle: CoreLifecycle;
  /** Milliseconds since start. */
  uptime: number;
  startedAt: string;
}

export interface Diagnostics {
  core: "ok" | "degraded" | "failed";
  database: "ok" | "degraded" | "failed";
  hermes: "ok" | "degraded" | "failed" | "unknown";
  opencode: "ok" | "degraded" | "failed" | "unknown";
  scheduler: "ok" | "degraded" | "failed";
  ipc: "ok" | "degraded" | "failed";
  checkedAt: string;
  notes?: string[];
}

// ── Persistence boundary ──────────────────────────────────────────────────────
//
// The stores below are interfaces, not implementations: the SQLite module
// implements them, and everything else (event bus, missions, notifications,
// scheduler) depends only on the interface. That keeps the database out of the
// business logic and lets tests swap in an in-memory implementation.

export interface EventStore {
  insertEvent(event: KaiEvent): void;
  listEvents(opts?: {
    limit?: number;
    missionId?: string;
    types?: readonly KaiEventType[];
    since?: string;
  }): KaiEvent[];
}

export interface MissionStore {
  upsertMission(mission: Mission): void;
  getMission(id: string): Mission | null;
  listMissions(opts?: { status?: MissionStatus; limit?: number }): Mission[];
  /**
   * Missions that were mid-flight when the process died. The executor uses this
   * on startup to decide what may be resumed — and what must not be (spec §29).
   */
  listUnfinishedMissions(): Mission[];
  deleteMission(id: string): void;
}

export interface MemoryStore {
  createMemory(memory: Memory): void;
  getMemory(id: string): Memory | null;
  listMemories(opts?: { type?: MemoryType; limit?: number }): Memory[];
  updateMemory(memory: Memory): void;
  deleteMemory(id: string): void;
}

export interface NotificationStore {
  createNotification(notification: KaiNotification): void;
  getNotification(id: string): KaiNotification | null;
  listNotifications(opts?: { unreadOnly?: boolean; limit?: number }): KaiNotification[];
  markRead(id: string, read: boolean): void;
}

export interface ApprovalStore {
  createApproval(approval: Approval): void;
  getApproval(id: string): Approval | null;
  listApprovals(opts?: { status?: ApprovalStatus; limit?: number }): Approval[];
  decideApproval(id: string, status: ApprovalStatus, decidedAt: string): void;
}

export interface ScheduledTaskStore {
  upsertScheduledTask(task: ScheduledTask): void;
  getScheduledTask(id: string): ScheduledTask | null;
  listScheduledTasks(opts?: { enabledOnly?: boolean }): ScheduledTask[];
  deleteScheduledTask(id: string): void;
}

/**
 * KAI's own persisted settings (the `settings` table). A plain string KV: the
 * settings SERVICE above it owns the allowlist and validation, so the store
 * never decides what a key means.
 */
export interface SettingsStore {
  get(key: string): string | null;
  set(key: string, value: string, updatedAt: string): void;
  delete(key: string): boolean;
  list(): { key: string; value: string; updatedAt: string }[];
}

/**
 * One user objective and its execution state. `plan`/`steps`/`pendingTools`
 * are JSON; `verification`/`synthesis` are JSON or null. States: RECEIVED,
 * UNDERSTANDING, PLANNING, EXECUTING, VERIFYING, SYNTHESIZING, COMPLETED,
 * BLOCKED, PAUSED, SUPERSEDED.
 */
export interface TaskRecord {
  id: string;
  sessionId: string;
  objective: string;
  plan: string[];
  steps: { label: string; status: string; detail?: string }[];
  state: string;
  pendingTools: string[];
  verification: string | null;
  synthesis: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskStore {
  createTask(task: TaskRecord): void;
  getTask(id: string): TaskRecord | null;
  /** Latest non-terminal task for a session (null when none is open). */
  activeTask(sessionId: string): TaskRecord | null;
  updateTask(id: string, patch: Partial<Pick<TaskRecord, "plan" | "steps" | "state" | "pendingTools" | "verification" | "synthesis">>, updatedAt: string): void;
  listTasks(sessionId: string, limit?: number): TaskRecord[];
}

/** KAI work board: delegated units with parent linkage and handoffs. */
export interface WorkItemStore {
  upsert(item: WorkItemRecord): void;
  get(id: string): WorkItemRecord | null;
  list(filter?: { state?: string; missionId?: string; taskId?: string; workerId?: string; limit?: number }): WorkItemRecord[];
  children(parentId: string): WorkItemRecord[];
}

/** Measured worker benchmark profiles. Written from verified outcomes only. */
export interface WorkerProfileStore {
  upsert(profile: WorkerProfileRecord): void;
  get(workerId: string): WorkerProfileRecord | null;
  list(): WorkerProfileRecord[];
}

/** Reusable prompt strategies with measured outcomes. */
export interface PromptPatternStore {
  upsert(pattern: PromptPatternRecord): void;
  get(id: string): PromptPatternRecord | null;
  list(taskType?: string): PromptPatternRecord[];
}

/** Per-skill quality counters for the feedback loop. */
export interface SkillMetricsStore {
  upsert(metrics: SkillMetricsRecord): void;
  get(skillId: string): SkillMetricsRecord | null;
  list(): SkillMetricsRecord[];
}

/** Bounded compact activity log. Pruned beyond the cap on write. */
export interface ActivityStore {
  append(event: { taskId?: string; workItemId?: string; workerId?: string; kind: string; label: string; detail?: string; at: string }): number;
  list(filter?: { taskId?: string; workItemId?: string; limit?: number }): ActivityEventRecord[];
  prune(cap: number): number;
}

export interface WorkItemRecord {
  id: string;
  parentId?: string;
  missionId?: string;
  taskId?: string;
  objective: string;
  deliverable?: string;
  /** Supervisor trust fields (schema v4; absent on older rows). */
  criteria?: string[];
  constraints?: string[];
  forbiddenOutcomes?: string[];
  requiredEvidence?: string[];
  evidenceLinks?: unknown;
  budget?: unknown;
  workingDir?: string;
  evidence?: unknown[];
  skillReceipts?: unknown[];
  nextAction?: unknown;
  workerId?: string;
  workerVersion?: string;
  skills: string[];
  tools: string[];
  state: string;
  attempts: number;
  heartbeats: { at: string; step?: string; note?: string }[];
  outputs?: unknown;
  handoff?: unknown;
  verification?: unknown;
  review?: unknown;
  cost?: unknown;
  tokensIn?: number;
  tokensOut?: number;
  latencyMs?: number;
  failures: string[];
  retries: number;
  valueScore?: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkerProfileRecord {
  workerId: string;
  role: string;
  configVersion: string;
  domains: Record<string, unknown>;
  overallValue: number;
  overallConfidence: string;
  totalSamples: number;
  updatedAt: string;
}

export interface PromptPatternRecord {
  id: string;
  taskType: string;
  template: string;
  requiredFields: string[];
  failureModes: string[];
  verification: string[];
  version: number;
  uses: number;
  successes: number;
  updatedAt: string;
}

export interface SkillMetricsRecord {
  skillId: string;
  triggers: number;
  successes: number;
  verifications: number;
  failures: number;
  corrections: number;
  tokensUsed: number;
  updatedAt: string;
}

export interface ActivityEventRecord {
  seq: number;
  taskId?: string;
  workItemId?: string;
  workerId?: string;
  kind: string;
  label: string;
  detail?: string;
  at: string;
}

/**
 * What every Core module is handed instead of a live database handle. Modules
 * that need persistence take this; modules that do not, take nothing.
 */
export interface Stores {
  events: EventStore;
  missions: MissionStore;
  memory: MemoryStore;
  notifications: NotificationStore;
  approvals: ApprovalStore;
  scheduledTasks: ScheduledTaskStore;
  settings: SettingsStore;
  tasks: TaskStore;
  workItems: WorkItemStore;
  workerProfiles: WorkerProfileStore;
  promptPatterns: PromptPatternStore;
  skillMetrics: SkillMetricsStore;
  activity: ActivityStore;
  /** Closes the underlying database. Safe to call twice. */
  close(): void;
}

// ── Employees (workforce) ─────────────────────────────────────────────────────
//
// KAI's Phase 1 model puts a level above the provider adapters. An *employee* is
// a reasoning worker KAI can hire, and it has three parts, mirroring the split
// the Phase 0 audit found worth adopting:
//
//   EmployeeDescriptor  stateless: what it is, and how to start it
//         ↓ create()
//   EmployeeInstance    live: state, snapshot, capabilities, dispose
//         ↓ turns
//   TurnAdapter         streams what it does (shared/runtime-events.ts)
//
// `AgentAdapter` above is deliberately unchanged. The existing Hermes and
// OpenCode adapters keep working exactly as they do now; this layer wraps them,
// it does not replace them.

export type EmployeeState =
  | "DISCOVERED"
  | "INSTALLING"
  | "INSTALLED"
  | "AUTHENTICATING"
  | "READY"
  | "DEGRADED"
  | "UNAVAILABLE"
  | "DISABLED"
  | "REMOVED";

export interface EmployeeMetadata {
  id: string;
  name: string;
  /** Version string, when the employee reports one. */
  version?: string;
  description?: string;
  /** Where it came from: "builtin", "discovered:<path>", "installed:<source>". */
  origin: string;
  /**
   * Capability ids this employee declares it can use. Declared, not trusted:
   * the capability manager decides what is actually available, and the policy
   * boundary decides whether a given use is allowed.
   */
  capabilities: readonly CapabilityId[];
}

export interface EmployeeSnapshot {
  state: EmployeeState;
  /** ISO-8601. */
  at: string;
  reachable: boolean;
  authenticated: boolean;
  version?: string;
  /** Why, when the state is DEGRADED or UNAVAILABLE. */
  problems?: readonly string[];
}

export interface EmployeeDescriptor {
  readonly metadata: EmployeeMetadata;
  /**
   * Starts an instance. `create` owns ALL per-instance state and resolves to a
   * value rather than throwing: an employee that cannot start reports it through
   * a snapshot, because a missing worker must never crash KAI (spec Part M).
   */
  create(input?: { instanceId?: string }): Promise<EmployeeInstance>;
}

export interface EmployeeInstance {
  readonly instanceId: string;
  readonly employeeId: string;
  readonly kind: EmployeeKind;
  /** The request/response adapter, when the employee is one of KAI's own. */
  readonly adapter?: AgentAdapter;
  /** The streaming turn protocol, when the employee supports it. */
  readonly turns?: TurnAdapter;
  state(): EmployeeState;
  snapshot(): Promise<EmployeeSnapshot>;
  capabilities(): readonly CapabilityId[];
  /** Releases resources. Idempotent: calling it twice is not an error. */
  dispose(): Promise<void>;
}

// ── Capabilities ──────────────────────────────────────────────────────────────
//
// A capability is something KAI — or an employee — can *use*: browser, computer,
// shell, git, filesystem, mcp, network. It is explicitly not the same thing as an
// employee: employees reason, capabilities act. KAI holds direct capabilities of
// its own, which is what keeps it working with zero employees installed.

export type CapabilityId = string;

export type CapabilityAvailability = "AVAILABLE" | "DEGRADED" | "UNAVAILABLE" | "DISABLED";

export interface Capability {
  id: CapabilityId;
  name: string;
  version?: string;
  availability: CapabilityAvailability;
  /**
   * The risk of *using* this capability. It must never be lower than the risk of
   * the most dangerous action the capability exposes — a capability that reports
   * READ while one of its actions writes is a policy hole.
   */
  risk: RiskLevel;
  /** Free-form requirements ("blender", "cua-driver >= 0.28"): advisory, for planning. */
  requirements?: readonly string[];
  /** Who provides it: "kai" for a direct capability, otherwise an employee id. */
  provider: string;
  supportedActions: readonly string[];
  health(): Promise<{ availability: CapabilityAvailability; detail?: string }>;
}

/**
 * The machine-readable Employee × Capability × Permission relationship (spec
 * Part L). This is the abstraction the planner will eventually read to answer
 * "which available employee can do this, with the least authority?" — for now it
 * is only stored and queried, not optimised.
 */
export interface CapabilityGrant {
  employeeId: string;
  capabilityId: CapabilityId;
  /** The highest risk of use this grant permits. */
  permission: RiskLevel;
  /** Where it applies. Scope must be explicit; there is no implicit "everywhere". */
  scope: "thread" | "mission" | "employee" | "global";
  /** Identifies the thread/mission when the scope is narrower than the employee. */
  scopeId?: string;
}

// ── Policy mode ───────────────────────────────────────────────────────────────

/**
 * How much KAI asks before acting. Deliberately KAI's own vocabulary and NOT a
 * provider CLI's approval mode: a worker's mode describes what that CLI will ask
 * its caller, whereas this describes what KAI does when *it* is the decider.
 *
 * The risk classification (RiskLevel) stays KAI's and is what a mode modulates:
 *
 *   ask-all     every action needs approval, including READ
 *   normal      READ allowed; WRITE/EXTERNAL/DESTRUCTIVE need approval (default)
 *   auto-read   as normal, and additionally allows tools the registry marks READ
 *               without a per-call card
 *   elevated    WRITE allowed without a card; EXTERNAL/DESTRUCTIVE still ask
 *
 * `elevated` is never inherited: it requires an explicit, confirmed, owner-only
 * transition and is scoped to a thread or mission, never to "everything".
 */
export type PolicyMode = "ask-all" | "normal" | "auto-read" | "elevated";

// ── Runtime validation ────────────────────────────────────────────────────────
//
// Small hand-written guards rather than a schema library: the Core is a local
// process with a handful of boundaries, and every dependency added here is one
// more thing the desktop app has to ship. They validate *shape*, which is what
// matters at the IPC edge.

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

const AGENT_STATES: readonly string[] = [
  "offline",
  "connecting",
  "idle",
  "working",
  "waiting",
  "error",
];

export function isAgentState(value: unknown): value is AgentState {
  return typeof value === "string" && AGENT_STATES.includes(value);
}

export function isKaiEvent(value: unknown): value is KaiEvent {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.type) &&
    isNonEmptyString(value.timestamp) &&
    isNonEmptyString(value.source) &&
    "payload" in value
  );
}

export function isAgentStatus(value: unknown): value is AgentStatus {
  if (!isRecord(value)) return false;
  return isNonEmptyString(value.id) && isAgentState(value.state);
}

/** ISO-8601 instant, as every timestamp in these contracts must be. */
export function isIsoTimestamp(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms);
}

export function nowIso(): string {
  return new Date().toISOString();
}

const EMPLOYEE_STATES: readonly string[] = [
  "DISCOVERED",
  "INSTALLING",
  "INSTALLED",
  "AUTHENTICATING",
  "READY",
  "DEGRADED",
  "UNAVAILABLE",
  "DISABLED",
  "REMOVED",
];

export function isEmployeeState(value: unknown): value is EmployeeState {
  return typeof value === "string" && EMPLOYEE_STATES.includes(value);
}

const CAPABILITY_AVAILABILITIES: readonly string[] = [
  "AVAILABLE",
  "DEGRADED",
  "UNAVAILABLE",
  "DISABLED",
];

export function isCapabilityAvailability(value: unknown): value is CapabilityAvailability {
  return typeof value === "string" && CAPABILITY_AVAILABILITIES.includes(value);
}

const POLICY_MODES: readonly string[] = ["ask-all", "normal", "auto-read", "elevated"];

export function isPolicyMode(value: unknown): value is PolicyMode {
  return typeof value === "string" && POLICY_MODES.includes(value);
}
