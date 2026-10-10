/**
 * KAI Core composition root.
 *
 * This is the only module that knows all the others exist. Everything else takes
 * its collaborators by injection, which is what let the modules be written in
 * parallel and what lets the tests run the whole Core with mock agents and an
 * in-memory database.
 *
 * The wiring order below is deliberate and worth keeping:
 *
 *   stores → bus → notifications → agents → policy → approvals → tools
 *          → missions → scheduler
 *
 * Persistence first (so the bus can persist events), policy before tools (so no
 * tool can ever be invoked without a decision), and approvals before both (so the
 * policy engine can park a request instead of allowing it).
 *
 * Two rules this file exists to enforce:
 *  - Nothing an agent or an LLM produces reaches the machine directly. A mission
 *    step is executed through the tool registry, which validates and applies
 *    policy; a step that wants an agent goes through the agent registry, which
 *    owns the protocol. No port number or route appears below.
 *  - Shutdown is ordered and idempotent: the scheduler stops before the database
 *    closes, or a firing task would write to a closed handle.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { openSqliteStores, defaultDatabasePath } from "./storage/sqlite.ts";
import { openMemoryStore } from "./storage/memoryStore.ts";
import { createEventBus } from "./events/bus.ts";
import { createNotificationService } from "./notifications/service.ts";
import { createAgentRegistry } from "./agents/registry.ts";
import { createHermesAdapter } from "./agents/adapters/hermesAdapter.ts";
import { resolveHermesKey } from "./agents/hermes-key.ts";
import { createOpenCodeAdapter } from "./agents/adapters/opencodeAdapter.ts";
import { createMockHermes, createMockOpenCode } from "./agents/mock.ts";
import { createPolicyEngine } from "./policies/gate.ts";
import { createApprovalService } from "./approvals/service.ts";
import { defineEmployee, createUnavailableEmployee } from "./workforce/employee.ts";
import { createWorkforceManager } from "./workforce/manager.ts";
import {
  createSubagentRegistry,
  descriptorForSubagent,
  personaPreamble,
  personaReply,
  type SubagentRegistry,
  type KaiSubagentSpec,
} from "./workforce/subagent.ts";
import { createCapabilityRegistry } from "./capabilities/registry.ts";
import { createCapabilityManager } from "./capabilities/manager.ts";
import { loadIdentity, PROTOCOL_VERSION } from "./identity.ts";
import { createRealComputerTransport } from "./capabilities/computer/real-transport.ts";
import { createCdpBrowserTransport } from "./capabilities/browser/cdp-transport.ts";
import type { TransportAction } from "./capabilities/computer/transport.ts";
import { ACTION_RISK, BROWSER_ACTIONS } from "./capabilities/browser/transport.ts";
import type { BrowserAction } from "./capabilities/browser/transport.ts";
import { createToolRegistry } from "./tools/registry.ts";
import { createModelToolPlane, type ModelToolPlane } from "./tools/model-plane.ts";
import type { ToolDefinition } from "./tools/registry.ts";
import { createBuiltinTools } from "./tools/builtin.ts";
import { createWorkspaceTools, WORKSPACE_OPS, probeGit, probeShell, setCommandStreamSink } from "./tools/workspace.ts";
import { createMcpManager } from "./mcp/manager.ts";
import { createPluginRegistry } from "./plugins/registry.ts";
import { dispatchMcpCapability, installMcpCapability } from "./mcp/capability.ts";
import { createParkedRequestStore, type ParkedRequestStore } from "./approvals/parked.ts";
import {
  createDoer,
  createPendingResultStore,
  DOER_RESULT_EVENT_TYPES,
  payloadCorrelation,
  type Doer,
  type DoerProcessOutcome,
  type PendingResult,
  type PendingResultStore,
} from "./orchestration/doer.ts";
import { createMissionExecutor } from "./missions/executor.ts";
import { createMission } from "./missions/mission.ts";
import { createScheduler } from "./scheduler/scheduler.ts";
import { createDurableLeaseStore, type DurableLeaseStore } from "./scheduler/lease.ts";
import { createScheduledJobRunner, type ScheduledJob } from "./scheduler/jobs.ts";
import { stripScheduleExtensions } from "./scheduler/schedule.ts";
import { createDailySummaryService, type DailySummaryService } from "./summary/daily.ts";
import { createCheckpointManager, type CheckpointManager } from "./checkpoints/checkpoint.ts";
import { createExecutionLedger, type ExecutionLedger } from "./recovery/ledger.ts";
import { createBoundaryRunner } from "./recovery/boundary.ts";
import { createMemoryService } from "./memory/service.ts";
import {
  createMemoryEngine,
  createSubagentMemoryShares,
  isActive,
  isMemoryScope,
  memoryRefusal,
  MEMORY_SCOPES,
  tokenizeMemoryText,
  type MemoryEngine,
  type MemoryScope,
  type MemoryScopeAccess,
  type MemorySearchHit,
  type MemoryWriteInput,
  type MemoryWriteResult,
  type SubagentMemoryShare,
  type SubagentMemoryShares,
} from "./memory/index.ts";
import { createPromptComposer, type ComposedPrompt, type ComposeTurnOptions, type PromptComposer } from "./prompts/index.ts";
import { createKaiIdentity } from "./agent/soul.ts";
import { defaultKaiHome } from "./agent/kai-home.ts";
import { createKaiIdentityModel, type KaiIdentityModel } from "./agent/identity-model.ts";
import { renderDelegationIdentity } from "./agent/kai-capabilities.ts";
import {
  createSkillStore,
  createSkillRegistry,
  createSkillStaging,
  createSkillToolDefinitions,
  seedBuiltinSkills,
  seedLibrarySkills,
  type SkillRegistry,
  type SkillStaging,
} from "./skills/index.ts";
import { createLearningPipeline, type LearningPipeline } from "./learning/index.ts";
import { createSessionService, createSessionStore, type SessionService } from "./sessions/index.ts";
import { createMissionSupervisor, type AutonomyDecision, type MissionSupervisor } from "./autonomy/supervisor.ts";
import { createMaintenanceService, type MaintenanceService } from "./maintenance/index.ts";
import { fileURLToPath } from "node:url";
import { createChatRouter } from "./chat/router.ts";
import { createKaiBrain, type KaiBrain } from "./chat/brain.ts";
import { createSettingsAwareProvider, type ModelProvider } from "./model/index.ts";
import { createTaskTracker, type TaskTracker } from "./chat/tasks.ts";
import { createProviderRegistry, kaiModelPort, type ProviderRegistry } from "./providers/registry.ts";
import { parseSkillMarkdown } from "./skills/validate.ts";
import { createWorkBoard } from "./orchestration/board.ts";
import { createBenchmark } from "./orchestration/bench.ts";
import { createDispatcher } from "./orchestration/dispatch.ts";
import { createTrace } from "./orchestration/trace.ts";
import { createLearning } from "./orchestration/learn.ts";
import { parseReviewVerdict, REVIEWER_SYSTEM } from "./orchestration/review.ts";
import { createOrchestrator, type Orchestrator } from "./orchestration/orchestrator.ts";
import { createUnavailableJevProvider, DEFAULT_JEV_BUDGET } from "./orchestration/decision.ts";
import { readOrchestrationPrefs, type OrchestrationPrefs } from "./orchestration/prefs.ts";
import { createSettingsService, isSettingKey, type SettingsService, type ValidatedSettingsInput } from "./settings/settings.ts";
import { isOrchestrationKey, validateOrchestrationValue, type OrchestrationKey } from "./orchestration/prefs.ts";
import type { StepRunner } from "./missions/executor.ts";
import { isRecord } from "./shared/contracts.ts";

import type {
  AgentStatus,
  KaiError,
  KaiErrorCode,
  KaiEventType,
  Mission,
  MissionStep,
  Stores,
  PolicyMode,
  EmployeeInstance,
  EmployeeDescriptor,
  CapabilityId,
  CapabilityAvailability,
  RiskLevel,
  AgentTaskResult,
  MemoryType,
} from "./shared/contracts.ts";
import type { PolicyDecision, PolicyGate, PolicyRequest, PolicyRule } from "./policies/gate.ts";

/** What a module is handed instead of the bus; keeps modules from importing it. */
export type Publish = (
  type: KaiEventType,
  payload: unknown,
  opts?: { source?: string; missionId?: string; stepId?: string },
) => void;

// ── Memory scope honesty (Phase 2 Part H) ─────────────────────────────────────
//
// The memory model defines five scopes. A scope is only meaningful when the
// runtime has a live PRODUCER of its ids: without one, a scoped fact is a fact
// nothing will ever recall. So the runtime reports which scopes it can honour
// and refuses the rest, rather than accepting a scope nobody knows.

/** One memory scope, and whether this runtime has a live producer for it. */
export interface MemoryScopeSupport {
  scope: MemoryScope;
  /** The subsystem that mints this scope's ids, or null when nothing does. */
  producer: string | null;
  wired: boolean;
  reason: string;
}

export type MemoryScopeResolution =
  | { ok: true; scope: MemoryScope; scopeId: string }
  | {
      ok: false;
      code: "MEMORY_SCOPE_UNSUPPORTED" | "MEMORY_SCOPE_SUBJECT_UNKNOWN";
      reason: string;
    };

/** A memory write whose scope is required, so a caller cannot fall back silently. */
export interface ScopedMemoryWrite extends Omit<MemoryWriteInput, "scope" | "scopeId"> {
  scope: MemoryScope;
  scopeId?: string;
}

/** A scoped recall. An omitted/`global` scope means the shared bucket only. */
export interface ScopedMemoryQuery {
  scope?: MemoryScope;
  scopeId?: string;
  text?: string;
  limit?: number;
  types?: readonly MemoryType[];
}

/**
 * Where a mission came from, when it did not come from a user request. The
 * schedule that fired is stamped onto the mission itself (`mission.metadata.
 * scheduleId`), so the origin survives on the durable record rather than living
 * only on a transient action record.
 */
export interface MissionOriginContext {
  /** The schedule whose fire caused this mission, when one did. */
  scheduleId?: string;
}

/**
 * Parse the opaque `scope` string the prompt composer passes to memory recall.
 * The grammar is `<scope>:<id>` (e.g. `mission:m-123`, `employee:hermes`), which
 * is how a mission/employee is named without the composer knowing about memory
 * scopes. Anything else — including a bare id or an unknown scope — yields null,
 * and the caller falls back to the shared global bucket rather than guessing.
 */
export function parseMemoryScopeRef(ref: string): { scope: MemoryScope; scopeId: string } | null {
  const at = ref.indexOf(":");
  if (at <= 0) return null;
  const scope = ref.slice(0, at).trim();
  const scopeId = ref.slice(at + 1).trim();
  if (!isMemoryScope(scope) || scopeId.length === 0) return null;
  return { scope, scopeId };
}

/** One tracked subagent run (P7-P9 lifecycle observability). */
export interface SubagentRunRecord {
  runId: string;
  subagentId: string;
  employeeId: string;
  startedAt: string;
  /** `running` while delegated; `parked` while an approval decides; never `done` (done runs leave the map). */
  status: "running" | "parked";
  /** The approval a parked run waits on — what `cancelSubagentRun` rejects. */
  approvalId?: string;
}

export interface CoreRuntimeOptions {
  /** Defaults to the user-scoped KAI database path, outside the repository. */
  dbPath?: string;
  /** Real agents unless overridden; mocks make the whole Core runnable in tests. */
  agents?: {
    mode?: "real" | "mock";
    hermes?: { baseUrl?: string; apiKey?: string };
    opencode?: { baseUrl?: string };
  };
  /**
   * KAI's OWN model/inference backend. This is the brain KAI uses for normal chat —
   * it is NOT a worker and does NOT go through Hermes. Omitted fields come from the
   * KAI-owned resolver (env KAI_MODEL_* -> KAI_HOME/model/credentials.json ->
   * defaults). `fetchImpl` is resolved to drive a real endpoint in tests.
   */
  model?: {
    id?: string;
    baseUrl?: string;
    apiKey?: string;
    name?: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
  };
  /**
   * How long an approval stays answerable. Defaults to the approval service's
   * own 10 minutes; overridable so a test can drive real expiry instead of
   * simulating it.
   */
  approvalTtlMs?: number;
  /**
   * How many model→tool→model rounds one conversational turn may take before
   * the brain stops and answers with what it has. Defaults to the brain's own
   * 6 (enough for search → read → answer); exposed here so it is runtime
   * configuration rather than a hidden constant, and so a session/run can read
   * the budget off the turn result (`toolIterations`/`maxToolIterations`).
   */
  brainMaxToolIterations?: number;
  policyRules?: PolicyRule[];
  /**
   * How much KAI asks before acting (Phase 1 Part G). Defaults to "normal",
   * which is KAI's historical behaviour — so this cannot loosen anything by
   * being added.
   */
  policyMode?: PolicyMode;
  /**
   * Audit sink for policy decisions. Every decision names WHICH authority made
   * it (`source`), which is what makes an audit log answer "why was this
   * allowed?" rather than just "it was allowed".
   */
  onPolicyDecision?: (decision: PolicyDecision, request: PolicyRequest) => void;
  /** Off in tests that want to drive the scheduler with tick(). */
  startScheduler?: boolean;
  tickMs?: number;
  /**
   * The autonomous loop's bounds (see `autonomy/supervisor.ts`). `maxAttempts`
   * is the number of AUTOMATIC re-attempts allowed for one mission chain; 0
   * disables the loop entirely, and the default (1) is one retry.
   */
  autonomy?: { maxAttempts?: number };
  /**
   * Where the Phase 2 subsystems keep their state. Defaults are DERIVED from
   * `dbPath`, so a test that points the Core at a temp directory gets every
   * subsystem file in that directory and nothing leaks into the user profile.
   * The memory engine is the one exception with a hard rule: it always uses
   * `memoryPath ?? dbPath` — the SAME database file the Core already uses.
   */
  subsystemPaths?: {
    /** Filesystem root for installed/staged skills. Default `<dbDir>/skills`. */
    skillsRoot?: string;
    /** Scheduler lease ledger (its own file). Default `<dbDir>/scheduler-leases.db`. */
    leasePath?: string;
    /** Recovery acceptance ledger (its own file). Default `<dbDir>/recovery-ledger.db`. */
    ledgerPath?: string;
    /** KAI conversation sessions (their own file). Default `<dbDir>/kai-sessions.db`. */
    sessionsPath?: string;
    /** Plugin catalogue root (plugins.json + one dir per plugin). Default `<dbDir>/plugins`. */
    pluginsRoot?: string;
    /** MCP server catalogue (JSON with credential values). Default `<dbDir>/kai-mcp.json`. */
    mcpPath?: string;
    /** KAI subagent persona registry (their own file). Default `<dbDir>/kai-subagents.json`. */
    subagentsPath?: string;
    /** Governed subagent-memory share registry (their own file). Default `<dbDir>/kai-subagent-memory-shares.json`. */
    subagentSharesPath?: string;
    /** Parked non-mission approval requests (their own file). Default `<dbDir>/parked-requests.db`. */
    parkedPath?: string;
    /** Doer pending-result inbox (its own file). Default `<dbDir>/doer-pending.db`. */
    doerPath?: string;
    /** Checkpoint store root. Default `<dbDir>/checkpoints`. */
    checkpointsDir?: string;
    /** KAI_HOME for identity docs (SOUL.md/USER.md). Defaults to the real KAI_HOME. */
    identityRoot?: string;
    /** The memory engine's database file. Defaults to `dbPath` (shared on purpose). */
    memoryPath?: string;
    /** Run a memory upkeep cycle at startup (after resume). Default true. */
    runUpkeepOnStart?: boolean;
  };
}

export interface CoreRuntimeHealth {
  ok: boolean;
  startedAt: string;
  uptimeMs: number;
  database: { path: string };
  agents: AgentStatus[];
  missions: { active: number; unfinished: number };
  notifications: { unread: number };
  approvals: { pending: number };
  scheduler: { running: boolean; enabled: number };
  tools: { registered: number };
}

export interface CoreRuntime {
  stores: Stores;
  bus: ReturnType<typeof createEventBus>;
  memory: ReturnType<typeof createMemoryService>;
  /** Live Phase 2 memory engine (canonical store). Additive: the legacy service above is unchanged. */
  memoryEngine: MemoryEngine;
  /** The ONE system-prompt composer. A real turn's prompt is `composeTurnPrompt(...).text`. */
  prompts: PromptComposer;
  /** Compose one turn's system prompt (safety → identity → … → memory → skills → request). */
  composeTurnPrompt(request: string, opts?: ComposeTurnOptions): Promise<ComposedPrompt>;
  /** Installed-skill catalogue (metadata only until `load`). */
  skills: SkillRegistry;
  /** The staged → human-approval → SHA-256 install pipeline. */
  skillStaging: SkillStaging;
  /** The learning loop (propose/learn; a skill is only ever STAGED here). */
  learning: LearningPipeline;
  /** KAI-owned shadow checkpoints. */
  checkpoints: CheckpointManager;
  /** Durable scheduler lease ledger (at-most-once per slot). */
  leases: DurableLeaseStore;
  /** Durable acceptance ledger that the recovery boundary is built on. */
  recovery: ExecutionLedger;
  /** KAI's own durable conversation sessions (Phase F). */
  sessions: SessionService;
  /**
   * THE canonical KAI identity model (agent/identity-model.ts), built at the
   * composition root over the running subsystems. Exposed so the Core API can
   * serve it (GET /identity/model) and it is observable, not merely composed.
   */
  identityModel: KaiIdentityModel;
  /**
   * KAI's LIVE soul text + content version, read through the identity
   * provider's refresh semantics — a hand-edited SOUL.md is visible here on
   * the next read with no restart. Served at GET /soul; writes go through the
   * policy-gated `soul.set` tool (POST /soul), never around it.
   */
  readSoul(): { soul: string; version: string; soulPath: string };
  /** KAI's subagent personas — first-class, above the workers (see workforce/subagent.ts). */
  subagents: SubagentRegistry;
  /**
   * Run one task as a specific subagent, through the ONE policy-governed path.
   * Resolves the persona's employee, brings it READY, then delegates. When a
   * decided `approvalId` is supplied, the SAME run is re-issued and executes
   * instead of parking again.
   */
  runSubagent(id: string, input: string, approvalId?: string): Promise<unknown>;
  /** One tracked subagent run: parked runs stay until decided or cancelled. */
  activeSubagentRuns(): SubagentRunRecord[];
  /**
   * Cancel a tracked run. A run PARKED on an approval is genuinely cancelled
   * (its approval is rejected, so the work never runs). An EXECUTING run has
   * no preemption point in synchronous delegation — the refusal says so and
   * names the real recourse (archive the persona to stop future runs).
   */
  cancelSubagentRun(runId: string): Promise<{ ok: true; runId: string } | { ok: false; reason: string }>;
  /** The autonomous loop: evaluates a settled mission and decides what is next. */
  supervisor: MissionSupervisor;
  /** KAI's own self-maintenance surface (inspect + repair what it owns). */
  maintenance: MaintenanceService;
  /** Every autonomy decision made so far, newest last. */
  autonomyDecisions(): AutonomyDecision[];
  chat: ReturnType<typeof createChatRouter>;
  /** THE KAI-owned model provider — normal chat inference goes here, never to a worker. */
  model: ModelProvider;
  /** KAI's OWN persisted settings (model name/endpoint/timeout), honoured live. */
  settings: SettingsService;
  /** The task lifecycle tracker (objective retention, verification, resume). */
  tasks: TaskTracker;
  /** The ONE provider registry (/models, /providers, Settings, palette). */
  providers: ProviderRegistry;
  /** The ONE orchestration loop (mission work, review, bench, trace, learn). */
  orchestrator: Orchestrator;
  /** KAI's own reasoning loop over `model`; the brain behind normal chat. */
  brain: KaiBrain;
  /**
   * The tools the model may SELECT and KAI will EXECUTE through the registry.
   * Built from the live registry, so GET /tools and the model see the same
   * tools; empty ids means the model was offered no tools.
   */
  modelTools: ModelToolPlane;
  notifications: ReturnType<typeof createNotificationService>;
  registry: ReturnType<typeof createAgentRegistry>;
  policy: ReturnType<typeof createPolicyEngine>;
  approvals: ReturnType<typeof createApprovalService>;
  /** Durable store of parked NON-mission requests, so a verdict can re-issue them. */
  parkedRequests: ParkedRequestStore;
  /**
   * KAI Doer — autonomous goal execution. Independent of Guard: switching the
   * Doer off never disables policy, approvals or the execution registry.
   */
  doer: Doer;
  /** The Doer's durable pending-result inbox (exposed for the UI and tests). */
  pendingResults: PendingResultStore;
  /** The live Workforce Manager: the employee layer above the agent registry. */
  workforce: ReturnType<typeof createWorkforceManager>;
  /** The live Capability Manager: one instance, in the production runtime. */
  capabilities: ReturnType<typeof createCapabilityManager>;
  /** Pushes each employee's declared capabilities into the capability manager. */
  syncEmployeeViews(): void;
  /**
   * Decides an approval and settles the mission parked on it, in one call. The
   * API uses this instead of `approvals.decide` so that a decision can never be
   * recorded without the waiting work being told about it.
   */
  decideApproval(
    id: string,
    approved: boolean,
  ): Promise<{
    approved: boolean;
    missionId?: string;
    resumed: boolean;
    /** A non-mission request was re-issued after an APPROVED verdict. */
    reissued?: boolean;
    /** The re-issued action's outcome, when one was re-issued. */
    result?: unknown;
  }>;
  tools: ReturnType<typeof createToolRegistry>;
  /** The ONE MCP manager: the server catalogue, live connections, the /mcp route engine. */
  mcp: ReturnType<typeof createMcpManager>;
  /** The plugin registry over the shared tool plane (foundation, not a marketplace). */
  plugins: ReturnType<typeof createPluginRegistry>;
  missions: ReturnType<typeof createMissionExecutor>;
  scheduler: ReturnType<typeof createScheduler>;
  /**
   * The daily work summary: the durable once-per-local-day offer plus the
   * evidence-backed report behind `/summary`. Built from the work board and the
   * activity log — never from a second event history.
   */
  summary: DailySummaryService;

  // ── Memory scope honesty (Phase 2 Part H) ───────────────────────────────────
  /** Which memory scopes this runtime can genuinely honour, and why not for the rest. */
  memoryScopeSupport(): MemoryScopeSupport[];
  /** Resolve a caller-supplied scope against ids the runtime really knows. */
  resolveMemoryScope(input: { scope: MemoryScope; scopeId?: string }): MemoryScopeResolution;
  /** Write a fact into a scope the runtime can honour (refuses one it cannot). */
  rememberScoped(input: ScopedMemoryWrite & { actor?: string; reason?: string }): MemoryWriteResult;
  /** Recall from the shared global bucket plus one honoured private scope. */
  recallScoped(query: ScopedMemoryQuery): MemorySearchHit[];
  /** Write a fact scoped to a real mission. Refuses an unknown mission. */
  rememberForMission(missionId: string, input: Omit<ScopedMemoryWrite, "scope" | "scopeId">): MemoryWriteResult;
  /** Write a fact scoped to a real employee. Refuses an unknown employee. */
  rememberForEmployee(employeeId: string, input: Omit<ScopedMemoryWrite, "scope" | "scopeId">): MemoryWriteResult;
  /** Recall global facts plus the ones mission-scoped to `missionId`. */
  recallForMission(missionId: string, query?: Omit<ScopedMemoryQuery, "scope" | "scopeId">): MemorySearchHit[];
  /** Recall global facts plus the ones employee-scoped to `employeeId`. */
  recallForEmployee(employeeId: string, query?: Omit<ScopedMemoryQuery, "scope" | "scopeId">): MemorySearchHit[];
  /** Write a fact scoped to a real conversation. Refuses an unknown session. */
  rememberForSession(sessionId: string, input: Omit<ScopedMemoryWrite, "scope" | "scopeId">): MemoryWriteResult;
  /** Recall global facts plus the ones session-scoped to `sessionId`. */
  recallForSession(sessionId: string, query?: Omit<ScopedMemoryQuery, "scope" | "scopeId">): MemorySearchHit[];
  /**
   * Write a fact private to ONE KAI subagent persona. Refuses an unknown
   * subagent, so a scope nothing would recall is never recorded.
   */
  rememberForSubagent(subagentId: string, input: Omit<ScopedMemoryWrite, "scope" | "scopeId">): MemoryWriteResult;
  /**
   * Recall global facts plus the subagent's OWN private bucket plus ONLY the
   * entries explicitly shared TO it. Never another subagent's private bucket.
   */
  recallForSubagent(subagentId: string, query?: Omit<ScopedMemoryQuery, "scope" | "scopeId">): MemorySearchHit[];
  /** The governed share registry: the ONLY path by which one persona's fact reaches another. */
  subagentMemoryShares: SubagentMemoryShares;
  /**
   * Grant ONE entry from `fromSubagent`'s private bucket to `toSubagent`, under a
   * KAI approval. Validates both personas exist and the entry really belongs to
   * the source's bucket; refuses otherwise.
   */
  shareSubagentMemory(input: {
    fromSubagent: string;
    entryId: string;
    toSubagent: string;
    approvalId: string;
    reason?: string;
  }): { ok: true; share: SubagentMemoryShare } | { ok: false; reason: string };

  /** Derived from live calls, never invented. */
  health(): Promise<CoreRuntimeHealth>;
  /** Start a mission from a description. Returns the queued mission. */
  createAndStartMission(
    input: Parameters<typeof createMission>[0],
    /** Where the mission came from: the schedule that fired it, when one did. */
    ctx?: MissionOriginContext,
  ): Promise<Mission>;
  start(): Promise<{ agents: Record<string, boolean>; recovered: { resumed: string[]; blocked: string[] } }>;
  stop(): Promise<void>;
}


function kerr(code: KaiErrorCode, message: string, retryable = false): KaiError {
  return { code, message, retryable, at: new Date().toISOString() };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { value };
}

// ── State-mutation tools (Phase 2 Part I) ─────────────────────────────────────
//
// Every HTTP route that mutates state earns its way through the SAME boundary as
// every other action. These tools are registered on the one tool registry, so a
// request becomes `validate -> risk classification -> policy -> (approval) ->
// execute`. There is deliberately no second mechanism: the route asks the
// registry to run the action, and the registry consults the existing policy
// engine and approval service. A route cannot mutate anything without a policy
// decision, and a DESTRUCTIVE one cannot run without a human.
//
// The ids are referenced by the route table through `MUTATION_TOOLS` rather than
// as string literals, so the classification cannot drift from the registration.

export const MUTATION_TOOLS = {
  memoryWrite: "memory.write",
  memoryCreate: "memory.create",
  /** Governed cross-subagent memory share. Deliberately NOT in the internal-state list. */
  memoryShare: "memory.share",
  /** Correct an existing memory entry (content/type/importance/confidence). Reversible, like a write. */
  memoryCorrect: "memory.correct",
  /**
   * Forget (delete) a memory entry. DESTRUCTIVE and deliberately NOT in the
   * internal-state list, so the default policy parks it for a human — a fact
   * KAI forgets is gone from every recall, which is not silently reversible.
   */
  memoryForget: "memory.forget",
  notificationRead: "notification.read",
  approvalDecide: "approval.decide",
  workforceRegister: "workforce.register",
  workforceLifecycle: "workforce.lifecycle",
  subagentCreate: "workforce.subagent",
  soulSet: "soul.set",
  missionCancel: "mission.cancel",
  /**
   * Start an approved plan: DRAFT -> QUEUED -> RUNNING through the executor.
   * WRITE and internal-state (like cancel): starting is orchestration, and
   * every step still meets policy individually when it runs.
   */
  missionStart: "mission.start",
  scheduleManage: "schedule.manage",
  schedulerRecover: "scheduler.recover",
  learningPropose: "learning.propose",
  checkpointCreate: "checkpoint.create",
  checkpointRestore: "checkpoint.restore",
  sessionManage: "session.manage",
  maintenanceRun: "maintenance.run",
  skillDelete: "skill.delete",
  skillToggle: "skill.toggle",
  /**
   * Plugin lifecycle (enable/disable/config). WRITE but NOT internal-state:
   * flipping what code may run is closer to an install than to a memory note,
   * so the default policy parks it for a human — same rule as skill.toggle.
   */
  pluginLifecycle: "plugin.lifecycle",
  policySet: "policy.set",
  /**
   * Change KAI's OWN persisted settings (model name/endpoint/timeout). WRITE
   * and deliberately ABSENT from `KAI_INTERNAL_STATE_TOOLS`: redirecting where
   * inference traffic goes is security-relevant, so the default policy parks it
   * for a human — same rule as `soul.set`.
   */
  settingsUpdate: "settings.update",
} as const;

/**
 * The KAI-internal, REVERSIBLE state mutations the running policy may authorize
 * without a human: they change what KAI knows, owes or has scheduled — never the
 * world, and never a file on disk.
 *
 * Everything consequential is deliberately ABSENT:
 *   - `checkpoint.restore` and `skill.delete` are DESTRUCTIVE (they overwrite or
 *     remove files), so the default policy parks them for a human.
 *   - `skill.toggle` is WRITE but changes which skills KAI will load and act on,
 *     which is closer to an install than to a memory note, so it also parks.
 *   - `policy.set` is WRITE and changes what KAI is AUTHORIZED to do, so it is
 *     deliberately ABSENT: the default policy parks it for a human. A policy
 *     change that authorized itself silently would let an HTTP caller loosen its
 *     own constraints — a privilege escalation, not a memory note.
 *
 * A caller-supplied policy rule narrows or overrides this: explicit rules are
 * evaluated before this one, so a project that wants every memory write approved
 * only has to add `{ risk: "WRITE", outcome: "needs_approval", tools: ["memory.write"] }`.
 */
export const KAI_INTERNAL_STATE_TOOLS: readonly string[] = [
  MUTATION_TOOLS.memoryWrite,
  MUTATION_TOOLS.memoryCreate,
  // Correcting a memory is the same kind of reversible self-knowledge change
  // as writing one. `memory.forget` is deliberately ABSENT (see above): the
  // default policy parks a forget for a human.
  MUTATION_TOOLS.memoryCorrect,
  MUTATION_TOOLS.notificationRead,
  MUTATION_TOOLS.approvalDecide,
  MUTATION_TOOLS.workforceRegister,
  MUTATION_TOOLS.workforceLifecycle,
  // Defining a persona is a reversible change to KAI's own workforce registry, of the
  // same kind as registering an employee, so it is authorized by default. `soul.set`
  // is deliberately ABSENT: replacing KAI's identity is security-relevant, so the
  // default policy PARKS it for a human, exactly like `policy.set`.
  MUTATION_TOOLS.subagentCreate,
  MUTATION_TOOLS.missionCancel,
  MUTATION_TOOLS.missionStart,
  MUTATION_TOOLS.scheduleManage,
  MUTATION_TOOLS.schedulerRecover,
  MUTATION_TOOLS.learningPropose,
  MUTATION_TOOLS.checkpointCreate,
  MUTATION_TOOLS.sessionManage,
  MUTATION_TOOLS.maintenanceRun,
];

/**
 * How the registry-backed mutation tools reach KAI's own subsystems. Injected so
 * the tool definitions are testable without a full runtime, and so the runtime
 * remains the only thing that owns a store handle.
 */
export interface StateMutationToolDeps {
  writeCanonicalMemory(input: unknown): unknown;
  /** Grant ONE entry from one persona's private bucket to another, under approval. */
  shareSubagentMemory(input: unknown): unknown;
  /** Edit an existing memory entry (content/type/importance/confidence). */
  correctMemory(input: unknown): unknown;
  /** Delete a memory entry. Fail-closed: unknown ids are refused, not ignored. */
  forgetMemory(input: unknown): unknown;
  createLegacyMemory(memory: unknown): void;
  markNotificationRead(id: string): void;
  decideApproval(id: string, approved: boolean): Promise<unknown>;
  registerEmployee(descriptor: unknown, kind: string): unknown;
  employeeLifecycle(id: string, action: string): Promise<unknown>;
  /** Define (or replace) a KAI subagent persona and register it in the workforce. */
  createSubagent(spec: unknown): unknown;
  /** Replace SOUL.md and reload KAI's live identity. The identity mutation surface. */
  setSoul(text: string): unknown;
  cancelMission(id: string): Promise<unknown>;
  /** Start a DRAFT plan through the mission executor (the approve -> work transition). */
  startMission(id: string): Promise<unknown>;
  createSchedule(task: unknown): Promise<unknown>;
  cancelSchedule(id: string): boolean;
  recoverScheduler(): unknown;
  proposeLearning(event: unknown): unknown;
  createCheckpoint(input: unknown): unknown;
  restoreCheckpoint(id: string, target: string | undefined): unknown;
  deleteSkill(id: string): unknown;
  toggleSkill(id: string, enabled: boolean): unknown;
  /** Enable/disable a plugin or set one config value (lifecycle, policy-gated at the route). */
  pluginLifecycle(input: unknown): unknown;
  /** Replace the live policy rule set (the security-relevant mutation surface). */
  setPolicyRules(rules: unknown): unknown;
  /** Create/rename/archive/unarchive/activate a conversation session. */
  manageSession(input: unknown): unknown;
  /** Inspect KAI's own subsystems and repair the ones it is allowed to touch. */
  runMaintenance(): Promise<unknown>;
  /**
   * Validate + persist a settings patch through the settings service. The
   * service refuses unknown keys and bad values, so this never writes junk.
   */
  updateSettings(input: unknown): unknown;
  /** Dry-run validation for the tool boundary (a refusal is a 400). */
  checkSettings(
    input: unknown,
  ):
    | { ok: true; value: { settings?: Record<string, unknown>; reset?: string[]; orchestration?: Partial<Record<OrchestrationKey, string>> } }
    | { ok: false; reason: string };
}

function entity(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function entityOf(value: unknown, label: string): { ok: true; value: Record<string, unknown> } | { ok: false; reason: string } {
  const record = entity(value);
  return record === null ? { ok: false, reason: `${label} must be an object` } : { ok: true, value: record };
}

function idOf(value: unknown, label: string): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * The mutation tools, returned (never registered here) so the runtime and its
 * tests register the SAME definitions. Each `execute` performs the mutation: the
 * registry is the boundary, so the effect happens inside it.
 */
export function createStateMutationTools(deps: StateMutationToolDeps): ToolDefinition[] {
  return [
    {
      id: MUTATION_TOOLS.memoryWrite,
      name: "Write a memory",
      description:
        "Append a fact to KAI's canonical memory store, in a scope the runtime can genuinely honour. `scope` is REQUIRED (global, session, mission, employee, project); a private scope additionally needs its scopeId. Refuses a scope with no producer.",
      risk: "WRITE",
      validate(input) {
        const record = entityOf(input, "memory write input");
        if (!record.ok) return record;
        // scope is REQUIRED and validated HERE, at the boundary — not deep in
        // the resolver. A missing scope used to fall through to
        // "must be one of …", which read like the VALUE was wrong when the
        // field was simply absent (the mission-step SCOPE_VIOLATION reports).
        // Never default it: silently landing a fact in global would widen
        // something the caller meant to keep private.
        const scope = record.value.scope;
        if (typeof scope !== "string" || scope.length === 0) {
          return { ok: false, reason: `scope is required; must be one of ${MEMORY_SCOPES.join(", ")}` };
        }
        if (!(MEMORY_SCOPES as readonly string[]).includes(scope)) {
          return {
            ok: false,
            reason: `scope must be one of ${MEMORY_SCOPES.join(", ")}; got ${JSON.stringify(scope)}`,
          };
        }
        return { ok: true, value: record.value };
      },
      async execute(input) {
        return deps.writeCanonicalMemory(input);
      },
    },
    {
      id: MUTATION_TOOLS.memoryCreate,
      name: "Create a memory (legacy)",
      description: "Append one row to the frozen flat memory table.",
      risk: "WRITE",
      validate(input) {
        return entityOf(input, "memory");
      },
      async execute(input) {
        deps.createLegacyMemory(input);
        return { created: true };
      },
    },
    {
      id: MUTATION_TOOLS.memoryCorrect,
      name: "Correct a memory",
      description:
        "Edit an existing memory entry's content, type, importance or confidence. Identity (id/scope) is never editable; the change is journaled.",
      risk: "WRITE",
      validate(input) {
        const record = entityOf(input, "memory correction");
        if (!record.ok) return record;
        const id = idOf(record.value.id, "id");
        if (id === null) return { ok: false, reason: "id must be a non-empty memory entry id" };
        const patch: Record<string, unknown> = {};
        if (record.value.content !== undefined) {
          if (typeof record.value.content !== "string" || record.value.content.trim().length === 0) {
            return { ok: false, reason: "content must be a non-empty string when present" };
          }
          patch.content = record.value.content;
        }
        if (record.value.type !== undefined) {
          if (typeof record.value.type !== "string") return { ok: false, reason: "type must be a string when present" };
          patch.type = record.value.type;
        }
        if (record.value.importance !== undefined) {
          if (!Number.isInteger(record.value.importance)) {
            return { ok: false, reason: "importance must be an integer when present" };
          }
          patch.importance = record.value.importance;
        }
        if (record.value.confidence !== undefined) {
          if (typeof record.value.confidence !== "number") {
            return { ok: false, reason: "confidence must be a number when present" };
          }
          patch.confidence = record.value.confidence;
        }
        if (Object.keys(patch).length === 0) {
          return { ok: false, reason: "at least one of content/type/importance/confidence must be present" };
        }
        return { ok: true, value: { id, patch } };
      },
      async execute(input) {
        return deps.correctMemory(input);
      },
    },
    {
      id: MUTATION_TOOLS.memoryForget,
      name: "Forget a memory",
      description:
        "Delete a memory entry so it is never recalled again. DESTRUCTIVE: the default policy parks it for a human.",
      risk: "DESTRUCTIVE",
      validate(input) {
        const record = entityOf(input, "memory forget");
        if (!record.ok) return record;
        const id = idOf(record.value.id, "id");
        return id === null ? { ok: false, reason: "id must be a non-empty memory entry id" } : { ok: true, value: { id } };
      },
      async execute(input) {
        return deps.forgetMemory(input);
      },
    },
    {
      id: MUTATION_TOOLS.memoryShare,
      name: "Share one subagent's private memory",
      description:
        "Grant ONE entry from a KAI subagent's private memory to another subagent, under a KAI approval. The share stores a pointer, never a copy.",
      risk: "WRITE",
      validate(input) {
        const record = entityOf(input, "subagent memory share");
        if (!record.ok) return record;
        const from = idOf(record.value.fromSubagent, "fromSubagent");
        const to = idOf(record.value.toSubagent, "toSubagent");
        const entryId = idOf(record.value.entryId, "entryId");
        if (from === null) return { ok: false, reason: "fromSubagent must be a non-empty subagent id" };
        if (to === null) return { ok: false, reason: "toSubagent must be a non-empty subagent id" };
        if (entryId === null) return { ok: false, reason: "entryId must be a non-empty memory entry id" };
        // `approvalId` is OPTIONAL at validate time on purpose. The FIRST call
        // carries none — the policy boundary PARKS it for a human and hands back
        // the id — so requiring one here would refuse the request before it could
        // ever park. The retry carries the decided approval; a share that reaches
        // execute with an EMPTY approval is refused there (`grant` is fail-closed),
        // never minted. Type-checked here only so a non-string cannot slip through.
        const rawApproval = record.value.approvalId;
        if (rawApproval !== undefined && (typeof rawApproval !== "string" || rawApproval.trim().length === 0)) {
          return { ok: false, reason: "approvalId must be a non-empty string when present" };
        }
        const reason = typeof record.value.reason === "string" && record.value.reason.length > 0
          ? record.value.reason
          : undefined;
        return {
          ok: true,
          value: {
            fromSubagent: from,
            toSubagent: to,
            entryId,
            ...(typeof rawApproval === "string" ? { approvalId: rawApproval.trim() } : {}),
            ...(reason !== undefined ? { reason } : {}),
          },
        };
      },
      async execute(input) {
        return deps.shareSubagentMemory(input);
      },
    },
    {
      id: MUTATION_TOOLS.notificationRead,
      name: "Mark a notification read",
      description: "Mark one notification as read.",
      risk: "WRITE",
      validate(input) {
        const record = entityOf(input, "notification input");
        if (!record.ok) return record;
        const id = idOf(record.value.id, "id");
        return id === null ? { ok: false, reason: "id must be a non-empty string" } : { ok: true, value: { id } };
      },
      async execute(input) {
        deps.markNotificationRead((input as { id: string }).id);
        return { read: true };
      },
    },
    {
      id: MUTATION_TOOLS.approvalDecide,
      name: "Decide an approval",
      description: "Record a human's decision on an approval and settle the work parked on it.",
      risk: "WRITE",
      validate(input) {
        const record = entityOf(input, "approval decision");
        if (!record.ok) return record;
        const id = idOf(record.value.id, "id");
        if (id === null) return { ok: false, reason: "id must be a non-empty string" };
        if (typeof record.value.approved !== "boolean") {
          return { ok: false, reason: "approved must be a boolean" };
        }
        return { ok: true, value: { id, approved: record.value.approved } };
      },
      async execute(input) {
        const value = input as { id: string; approved: boolean };
        return deps.decideApproval(value.id, value.approved);
      },
    },
    {
      id: MUTATION_TOOLS.workforceRegister,
      name: "Register an employee",
      description: "Register a known employee with no transport (honest registration).",
      risk: "WRITE",
      validate(input) {
        const record = entityOf(input, "employee registration");
        if (!record.ok) return record;
        if (entity(record.value.descriptor) === null) {
          return { ok: false, reason: "descriptor must be an object" };
        }
        const kind = idOf(record.value.kind, "kind");
        return { ok: true, value: { descriptor: record.value.descriptor, kind: kind ?? "registered" } };
      },
      async execute(input) {
        const value = input as { descriptor: unknown; kind: string };
        return deps.registerEmployee(value.descriptor, value.kind);
      },
    },
    {
      id: MUTATION_TOOLS.workforceLifecycle,
      name: "Change an employee's lifecycle state",
      description: "Enable, disable or recover one registered employee.",
      risk: "WRITE",
      validate(input) {
        const record = entityOf(input, "employee lifecycle");
        if (!record.ok) return record;
        const id = idOf(record.value.id, "id");
        const action = idOf(record.value.action, "action");
        if (id === null) return { ok: false, reason: "id must be a non-empty string" };
        if (action === null || !["enable", "disable", "recover"].includes(action)) {
          return { ok: false, reason: "action must be one of enable, disable, recover" };
        }
        return { ok: true, value: { id, action } };
      },
      async execute(input) {
        const value = input as { id: string; action: string };
        return deps.employeeLifecycle(value.id, value.action);
      },
    },
    {
      id: MUTATION_TOOLS.subagentCreate,
      name: "Create a KAI subagent",
      description:
        "Define a KAI subagent persona (name, role, soul, preferred worker/model, capabilities, visual variant) and register it in the workforce. The persona runs only through KAI's policy-governed executor.",
      risk: "WRITE",
      validate(input) {
        const record = entityOf(input, "subagent spec");
        if (!record.ok) return record;
        // Shape is validated in full by the subagent registry; here we only confirm
        // it is an object so a non-object is refused before any state moves.
        return { ok: true, value: record.value };
      },
      async execute(input) {
        return deps.createSubagent(input);
      },
    },
    {
      id: MUTATION_TOOLS.soulSet,
      name: "Replace KAI's soul",
      description:
        "Replace SOUL.md — KAI's identity and personality — and reload the live identity. Security-relevant: the default policy parks it for a human.",
      risk: "WRITE",
      validate(input) {
        const record = entityOf(input, "soul replacement");
        if (!record.ok) return record;
        const text = idOf(record.value.text, "text");
        if (text === null) return { ok: false, reason: "text must be a non-empty string" };
        return { ok: true, value: { text } };
      },
      async execute(input) {
        return deps.setSoul((input as { text: string }).text);
      },
    },
    {
      id: MUTATION_TOOLS.settingsUpdate,
      name: "Change KAI's own settings",
      description:
        "Persist a patch to KAI's own settings (model.* provider inputs, orchestration.* autonomy/visibility/budgets) — it takes effect live with no restart. Security-relevant: the default policy parks it for a human.",
      risk: "WRITE",
      validate(input) {
        // The service dry-runs, so a refusal is a 400 here — never a 200
        // carrying an error out of execute.
        const checked = deps.checkSettings(input);
        if (!checked.ok) return { ok: false, reason: checked.reason };
        return { ok: true, value: checked.value };
      },
      async execute(input) {
        return deps.updateSettings(input);
      },
    },
    {
      id: MUTATION_TOOLS.maintenanceRun,
      name: "Run KAI's self-maintenance",
      description:
        "Inspect KAI's own subsystems (database, sessions, acceptance ledger, workers, scheduler, build identity) and repair the ones it may touch: memory upkeep, interrupted scheduler leases, crashed missions, and the employee/capability view.",
      risk: "WRITE",
      validate(input) {
        return { ok: true, value: entity(input) ?? {} };
      },
      async execute() {
        return deps.runMaintenance();
      },
    },
    {
      id: MUTATION_TOOLS.sessionManage,
      name: "Manage a conversation session",
      description:
        "Create, rename, archive, unarchive or switch one of KAI's conversation sessions. Changes what KAI remembers a conversation to be — never the world.",
      risk: "WRITE",
      validate(input) {
        const record = entityOf(input, "session operation");
        if (!record.ok) return record;
        const op = record.value.op;
        if (op !== "create" && op !== "rename" && op !== "archive" && op !== "unarchive" && op !== "activate") {
          return { ok: false, reason: 'op must be one of "create", "rename", "archive", "unarchive", "activate"' };
        }
        if (op !== "create") {
          const id = idOf(record.value.id, "id");
          if (id === null) return { ok: false, reason: "id must be a non-empty string" };
        }
        if (op === "rename" && (typeof record.value.title !== "string" || record.value.title.trim().length === 0)) {
          return { ok: false, reason: "title must be a non-empty string" };
        }
        return { ok: true, value: record.value };
      },
      async execute(input) {
        return deps.manageSession(input);
      },
    },
    {
      id: MUTATION_TOOLS.missionCancel,
      name: "Cancel a mission",
      description: "Cancel one mission through the mission executor (its own idempotence and event).",
      risk: "WRITE",
      validate(input) {
        const record = entityOf(input, "mission cancel");
        if (!record.ok) return record;
        const id = idOf(record.value.id, "id");
        return id === null ? { ok: false, reason: "id must be a non-empty string" } : { ok: true, value: { id } };
      },
      async execute(input) {
        return deps.cancelMission((input as { id: string }).id);
      },
    },
    {
      id: MUTATION_TOOLS.missionStart,
      name: "Start an approved plan",
      description:
        "Start a DRAFT mission through the mission executor (DRAFT -> QUEUED -> RUNNING). The approve-to-work transition: every step still meets policy individually when it runs.",
      risk: "WRITE",
      validate(input) {
        const record = entityOf(input, "mission start");
        if (!record.ok) return record;
        const id = idOf(record.value.id, "id");
        return id === null ? { ok: false, reason: "id must be a non-empty string" } : { ok: true, value: { id } };
      },
      async execute(input) {
        return deps.startMission((input as { id: string }).id);
      },
    },
    {
      id: MUTATION_TOOLS.scheduleManage,
      name: "Create or cancel a scheduled task",
      description: "Persist a new scheduled task (create) or remove one (cancel), reloading the scheduler.",
      risk: "WRITE",
      validate(input) {
        const record = entityOf(input, "schedule input");
        if (!record.ok) return record;
        const op = idOf(record.value.op, "op");
        if (op !== "create" && op !== "cancel") {
          return { ok: false, reason: "op must be create or cancel" };
        }
        if (op === "create" && entity(record.value.task) === null) {
          return { ok: false, reason: "task must be an object for op=create" };
        }
        if (op === "cancel" && idOf(record.value.id, "id") === null) {
          return { ok: false, reason: "id must be a non-empty string for op=cancel" };
        }
        return { ok: true, value: record.value };
      },
      async execute(input) {
        const value = input as { op: "create" | "cancel"; task?: unknown; id?: string };
        return value.op === "create"
          ? deps.createSchedule(value.task)
          : { cancelled: deps.cancelSchedule(value.id ?? ""), id: value.id };
      },
    },
    {
      id: MUTATION_TOOLS.schedulerRecover,
      name: "Recover interrupted scheduled slots",
      description: "Reconcile leases a previous process claimed and died on.",
      risk: "WRITE",
      validate(input) {
        const record = entityOf(input, "scheduler recover");
        return record.ok ? { ok: true, value: {} } : record;
      },
      async execute() {
        return deps.recoverScheduler();
      },
    },
    {
      id: MUTATION_TOOLS.learningPropose,
      name: "Propose a lesson from a turn",
      description:
        "Run the learning loop on a completed turn. A skill is only STAGED; a memory is written through the live engine and its own redaction and bounds.",
      risk: "WRITE",
      validate(input) {
        return entityOf(input, "learning turn");
      },
      async execute(input) {
        return deps.proposeLearning(input);
      },
    },
    {
      id: MUTATION_TOOLS.checkpointCreate,
      name: "Create a checkpoint",
      description: "Take a KAI-owned shadow checkpoint of a target directory.",
      risk: "WRITE",
      validate(input) {
        return entityOf(input, "checkpoint input");
      },
      async execute(input) {
        return deps.createCheckpoint(input);
      },
    },
    {
      id: MUTATION_TOOLS.checkpointRestore,
      name: "Restore a checkpoint",
      description:
        "Restore one checkpoint, OVERWRITING files at the target. Re-hashes before applying; refuses a corrupt or mismatched checkpoint.",
      risk: "DESTRUCTIVE",
      validate(input) {
        const record = entityOf(input, "checkpoint restore input");
        if (!record.ok) return record;
        const id = idOf(record.value.id, "id");
        if (id === null) return { ok: false, reason: "id must be a non-empty string" };
        const target = record.value.target;
        if (target !== undefined && typeof target !== "string") {
          return { ok: false, reason: "target must be a string when present" };
        }
        return { ok: true, value: { id, ...(typeof target === "string" ? { target } : {}) } };
      },
      async execute(input) {
        const value = input as { id: string; target?: string };
        return deps.restoreCheckpoint(value.id, value.target);
      },
    },
    {
      id: MUTATION_TOOLS.skillDelete,
      name: "Delete an installed skill",
      description: "Remove one installed skill from the catalogue and its files from disk.",
      risk: "DESTRUCTIVE",
      validate(input) {
        const record = entityOf(input, "skill delete");
        if (!record.ok) return record;
        const id = idOf(record.value.id, "id");
        return id === null ? { ok: false, reason: "id must be a non-empty string" } : { ok: true, value: { id } };
      },
      async execute(input) {
        return deps.deleteSkill((input as { id: string }).id);
      },
    },
    {
      id: MUTATION_TOOLS.skillToggle,
      name: "Enable or disable a skill",
      description: "Flip one installed skill's enabled state, changing what KAI will load on future turns.",
      risk: "WRITE",
      validate(input) {
        const record = entityOf(input, "skill toggle");
        if (!record.ok) return record;
        const id = idOf(record.value.id, "id");
        if (id === null) return { ok: false, reason: "id must be a non-empty string" };
        if (typeof record.value.enabled !== "boolean") {
          return { ok: false, reason: "enabled must be a boolean" };
        }
        return { ok: true, value: { id, enabled: record.value.enabled } };
      },
      async execute(input) {
        const value = input as { id: string; enabled: boolean };
        return deps.toggleSkill(value.id, value.enabled);
      },
    },
    {
      id: MUTATION_TOOLS.pluginLifecycle,
      name: "Plugin lifecycle",
      description:
        "Enable or disable a defined plugin, or set one of its declared config values. Flipping what code may run is install-like, so the default policy parks it for a human.",
      risk: "WRITE",
      validate(input) {
        const record = entityOf(input, "plugin lifecycle");
        if (!record.ok) return record;
        const op = record.value.op;
        if (op !== "enable" && op !== "disable" && op !== "config") {
          return { ok: false, reason: 'op must be one of "enable", "disable", "config"' };
        }
        const id = idOf(record.value.id, "id");
        if (id === null) return { ok: false, reason: "id must be a non-empty plugin id" };
        if (op === "config") {
          const key = idOf(record.value.key, "key");
          if (key === null) return { ok: false, reason: "key must be a non-empty config key" };
          if (record.value.value === undefined) return { ok: false, reason: "value must be present" };
          return { ok: true, value: { op, id, key, value: record.value.value } };
        }
        return { ok: true, value: { op, id } };
      },
      async execute(input) {
        return deps.pluginLifecycle(input);
      },
    },
    {
      id: MUTATION_TOOLS.policySet,
      name: "Change the live policy rules",
      description:
        "Replace the live policy rule set, which decides what KAI is authorized to do. Malformed rules are dropped toward the safe default.",
      risk: "WRITE",
      validate(input) {
        const record = entityOf(input, "policy rule input");
        if (!record.ok) return record;
        if (!Array.isArray(record.value.rules)) {
          return { ok: false, reason: "rules must be an array of policy rules" };
        }
        return { ok: true, value: { rules: record.value.rules } };
      },
      async execute(input) {
        return deps.setPolicyRules((input as { rules: unknown[] }).rules);
      },
    },
  ];
}

export function createCoreRuntime(options: CoreRuntimeOptions = {}): CoreRuntime {
  const dbPath = options.dbPath ?? defaultDatabasePath();
  const stores = openSqliteStores({ path: dbPath });
  const bus = createEventBus({ store: stores.events });

  const publish: Publish = (type, payload, opts) => {
    bus.publish(type, payload, opts);
  };

  // Live command output → the existing Core event bus. Every chunk a real child
  // process emits is published as `command.stdout` / `command.stderr` AS IT
  // ARRIVES, so the UI can show output while the command still runs. One seam,
  // no second event model (see tools/workspace.ts `exec`).
  setCommandStreamSink((event) => {
    publish(
      event.type,
      {
        commandExecutionId: event.commandExecutionId,
        command: event.command,
        args: event.args,
        cwd: event.cwd,
        ...(event.stream !== undefined ? { stream: event.stream } : {}),
        ...(event.chunk !== undefined ? { chunk: event.chunk } : {}),
        ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
        ...(event.timedOut !== undefined ? { timedOut: event.timedOut } : {}),
        ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
      },
      { source: "core" },
    );
  });

  const notifications = createNotificationService({
    store: stores.notifications,
    bus,
  });

  const memory = createMemoryService({ store: stores.memory, publish });

  // KAI's OWN persisted settings over the `settings` table — the live top
  // layer of the model resolution order (settings > env > file > defaults).
  const settings = createSettingsService({ store: stores.settings });

  /**
   * Dry-run validation across BOTH settings namespaces: model.* through the
   * model service, orchestration.* through the prefs validators. A refusal is
   * a 400 at the tool boundary — never a 200 carrying an error.
   */
  function checkCombinedSettings(input: unknown): (
    | { ok: true; value: { settings?: Record<string, unknown>; reset?: string[]; orchestration?: Partial<Record<OrchestrationKey, string>> } }
    | { ok: false; reason: string }
  ) {
    const record = (typeof input === "object" && input !== null ? input : {}) as {
      settings?: Record<string, unknown>;
      orchestration?: Record<string, string>;
      reset?: string[];
    };
    if (record.reset !== undefined) {
      if (!Array.isArray(record.reset) || !record.reset.every((k) => typeof k === "string")) {
        return { ok: false, reason: "reset must be an array of setting keys when present" };
      }
      for (const key of record.reset as string[]) {
        if (!isSettingKey(key) && !isOrchestrationKey(key)) {
          return { ok: false, reason: `unknown setting "${key}"` };
        }
      }
      return { ok: true, value: { reset: record.reset as string[] } };
    }
    const patch = record.settings;
    if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
      return { ok: false, reason: "settings must be an object patch when present" };
    }
    const modelPatch: Record<string, unknown> = {};
    const orchClean: Partial<Record<OrchestrationKey, string>> = {};
    let sawModel = false;
    // A parked call is re-issued with the NORMALISED input this function
    // returned (`{ settings, orchestration }`), so validation must accept that
    // shape too — otherwise an approved orchestration-only change could never be
    // resumed: the verdict lands and the setting silently never applies.
    const claimed: [string, unknown][] = [
      ...Object.entries(patch),
      ...Object.entries(record.orchestration ?? {}),
    ];
    for (const [key, value] of claimed) {
      if (isOrchestrationKey(key)) {
        const validated = validateOrchestrationValue(key, value);
        if (!validated.ok) return validated;
        orchClean[key] = validated.value;
        continue;
      }
      sawModel = true;
      modelPatch[key] = value;
    }
    if (sawModel) {
      const checked = settings.check({ settings: modelPatch });
      if (!checked.ok) return checked;
    } else if (Object.keys(orchClean).length === 0) {
      return { ok: false, reason: "nothing to update: pass at least one settable key" };
    }
    return { ok: true, value: { settings: modelPatch, orchestration: orchClean } };
  }

  // ── Phase 2 subsystem paths ────────────────────────────────────────────────
  //
  // Every subsystem default is derived from the Core's OWN data directory, so a
  // test that boots the Core against a temp database gets all of its Phase 2
  // state in that same temp directory (and cleans up with one rmSync). The
  // memory engine is deliberately the exception: it shares the Core's database
  // FILE (`memoryPath ?? dbPath`), because "KAI remembers across restarts"
  // means the same file, not a second database.
  const subsystemPaths = options.subsystemPaths ?? {};
  /**
   * THE KAI_HOME this runtime uses — resolved ONCE, here, and passed down.
   *
   * Everything KAI owns about itself lives under this root: the identity tree AND
   * KAI's own model credential (`<KAI_HOME>/model/credentials.json`). Resolving it
   * in one place and passing it explicitly is what stops a subsystem re-deriving a
   * default of its own: the model resolver used to default to `homedir()/.kai`
   * while the Core's own data sat under `%LOCALAPPDATA%\KAI`, so a fresh install's
   * credential was looked for in the wrong root and the provider reported itself
   * unconfigured. `subsystemPaths.identityRoot` (a test/deployment override) is the
   * same knob, because it IS a KAI_HOME.
   */
  const kaiHome = subsystemPaths.identityRoot ?? defaultKaiHome();
  const dbIsFile = dbPath !== ":memory:" && !dbPath.startsWith("file:");
  const dataDir = dbIsFile ? dirname(resolve(dbPath)) : undefined;
  const underData = (name: string): string =>
    dataDir !== undefined ? join(dataDir, name) : join(tmpdir(), `kai-${name}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  const memoryPath = subsystemPaths.memoryPath ?? dbPath;
  const skillsRoot = subsystemPaths.skillsRoot ?? underData("skills");
  const leasePath = subsystemPaths.leasePath ?? (dataDir !== undefined ? join(dataDir, "scheduler-leases.db") : ":memory:");
  const ledgerPath = subsystemPaths.ledgerPath ?? (dataDir !== undefined ? join(dataDir, "recovery-ledger.db") : ":memory:");
  const sessionsPath = subsystemPaths.sessionsPath ?? (dataDir !== undefined ? join(dataDir, "kai-sessions.db") : ":memory:");
  const subagentsPath = subsystemPaths.subagentsPath ?? (dataDir !== undefined ? join(dataDir, "kai-subagents.json") : undefined);
  // Governed subagent-memory shares persist beside the personas they concern, so a
  // recipient's access survives a restart exactly as the source fact does.
  const subagentSharesPath = subsystemPaths.subagentSharesPath ?? (dataDir !== undefined ? join(dataDir, "kai-subagent-memory-shares.json") : undefined);
  const parkedPath = subsystemPaths.parkedPath ?? (dataDir !== undefined ? join(dataDir, "parked-requests.db") : ":memory:");
  // The Doer's pending-result inbox lives in its own file, like the parked
  // approvals and the scheduler leases: a worker result that arrives while the
  // Doer is OFF must survive a restart, and it must not reshape `Stores`.
  const doerPath = subsystemPaths.doerPath ?? (dataDir !== undefined ? join(dataDir, "doer-pending.db") : ":memory:");
  const checkpointsDir = subsystemPaths.checkpointsDir ?? underData("checkpoints");

  /**
   * The live memory engine (Phase 2 Part B). It opens its own connection to the
   * SAME database file the Core already uses (see storage/memoryStore.ts for why
   * it owns that connection rather than reshaping the frozen `Stores`), and it
   * performs the one-time `importLegacy` copy so the desktop app's existing flat
   * `memories` rows become canonical entries. The legacy service above keeps
   * serving the existing GET/POST /memory unchanged — this is purely additive.
   */
  const memoryStore = openMemoryStore({ path: memoryPath });
  const memoryEngine = createMemoryEngine({ store: memoryStore, publish, importLegacyOnCreate: true });

  const registry = createAgentRegistry({
    onEvent: (type, payload) => publish(type as KaiEventType, payload, { source: "core" }),
  });

  if (options.agents?.mode === "mock") {
    registry.register(createMockHermes());
    registry.register(createMockOpenCode());
  } else {
    registry.register(
      createHermesAdapter({
        ...(options.agents?.hermes ?? {}),
        // KAI owns the delegated turn's identity (the L2 fix): a delegated run
        // carries KAI's identity as the worker run's system instruction, so a
        // subagent does not execute on the worker's default product identity.
        delegatedIdentity: () => renderDelegationIdentity(),
        apiKey: resolveHermesKey(options.agents?.hermes?.apiKey),
      }),
    );
    registry.register(createOpenCodeAdapter(options.agents?.opencode ?? {}));
  }

  /**
   * The Workforce layer (Phase 1 Parts I+J) — the higher-level employee
   * abstraction ABOVE the agent registry, not a second registry. Each employee's
   * `create()` returns an instance wrapping the SAME adapter object the registry
   * already owns, so there is one adapter lifecycle and one place a protocol
   * detail lives.
   */
  /**
   * Subagent employee id -> (underlying worker id, redacted persona preamble).
   *
   * A subagent is NOT an agent adapter of its own: it borrows its preferred
   * worker's adapter. So a delegated run must be routed to THAT worker's agent
   * id, and the persona carried along as a redacted preamble. This map is the one
   * place that remembers the pairing; it is written by `createSubagent` (below)
   * and read by the delegation path (immediately after).
   */
  const subagentRuns = new Map<string, { workerId: string; preamble: string }>();

  const workforce = createWorkforceManager({
    onEvent: (type, payload) => publish("core.status_changed", { workforce: type, ...(payload as object) }, { source: "workforce" }),
    // Delegation goes through the WORKER TOOL, so it is validated, risk-classified
    // and policy-checked like every other action. `tools` is referenced lazily:
    // this closure runs long after the runtime is assembled.
    executeTask: async ({ employeeId, taskId, input, options }): Promise<AgentTaskResult> => {
      // A subagent employee borrows its preferred worker's adapter, so the run is
      // routed to THAT worker's agent id — it still goes through the ONE
      // policy-governed `agents.run_task` (validate -> policy -> approval ->
      // execute), with the persona prefixed as a redacted preamble. A non-subagent
      // employee's id is already its own agent id, so it is passed through.
      const sub = subagentRuns.get(employeeId);
      const runId = sub?.workerId ?? employeeId;
      const runInput = sub !== undefined ? `${sub.preamble}\n\n${input}` : input;
      // The caller may already hold a DECIDED approval for this exact run (the
      // persona chat path re-issues with the approval id after a human decides).
      // Passing it through lets the registry execute instead of parking again —
      // the same `approvalId` mechanism every other gated route uses. Without it,
      // the EXTERNAL run parks, which is the default.
      const approvalId = typeof options?.approvalId === "string" ? options.approvalId : undefined;
      const invoked = await tools.invoke(
        "agents.run_task",
        {
          agentId: runId,
          action: taskId,
          input: runInput,
        },
        approvalId !== undefined ? { approvalId } : undefined,
      );
      // A refusal is a value here too: the manager reports it, rather than the
      // caller discovering a bypass by accident.
      return invoked.ok ? (invoked.result as AgentTaskResult) : { taskId, state: "failed", error: invoked.error };
    },
  });

  function employeeFromAdapter(id: string, name: string, capabilities: CapabilityId[]): EmployeeDescriptor {
    return defineEmployee({
      id,
      name,
      origin: `builtin:${id}`,
      capabilities,
      create: async (input): Promise<EmployeeInstance> => ({
        instanceId: input?.instanceId ?? `${id}#1`,
        employeeId: id,
        kind: id,
        adapter: registry.get(id),
        state: () => (registry.get(id) === undefined ? "UNAVAILABLE" : "READY"),
        snapshot: async () => ({
          state: registry.get(id) === undefined ? "UNAVAILABLE" : "READY",
          at: new Date().toISOString(),
          reachable: registry.get(id) !== undefined,
          authenticated: registry.get(id) !== undefined,
        }),
        capabilities: () => capabilities,
        dispose: async () => {},
      }),
    });
  }

  workforce.register(employeeFromAdapter("hermes", "Hermes", ["filesystem", "shell", "browser", "mcp"]), { kind: "hermes" });
  workforce.register(employeeFromAdapter("opencode", "OpenCode", ["filesystem", "shell", "git", "browser", "mcp"]), { kind: "opencode" });
  // Codex is a KNOWN employee this machine cannot start. Registering it as
  // unavailable (rather than omitting it) is the difference between "KAI does not
  // know about Codex" and "KAI knows, and it is not installed".
  workforce.register(
    createUnavailableEmployee(
      { id: "codex", name: "Codex", origin: "builtin:codex", capabilities: ["filesystem", "shell", "git"] },
      "the codex CLI is not installed on this machine",
    ),
    { kind: "codex" },
  );

  /**
   * The Capability layer (Phase 1 Parts K+L) — one live manager in the
   * production runtime.
   *
   * Availability is UNDER-claimed on purpose. A capability whose transport is not
   * connected is registered but reports UNAVAILABLE with the reason, because
   * "implemented + disconnected" is not "implemented + available" and reporting
   * the second when the first is true is exactly the fake this brief forbids.
   */
  /**
   * The REAL transports (Phase 1 §5/§6), connected lazily.
   *
   * Lazy on purpose: connecting the CUA driver and launching a headless browser at
   * startup would make every Core boot pay for capabilities a given session may
   * never use — and a browser that fails to launch must not stop KAI from starting.
   * The first use connects; a failure is remembered and reported as the reason the
   * capability is unavailable, rather than being retried in a loop.
   */
  type BrowserHandle = Extract<Awaited<ReturnType<typeof createCdpBrowserTransport>>, { ok: true }>["value"];
  let computerTransport: ReturnType<typeof createRealComputerTransport> | undefined;
  let computerProblem: string | undefined;
  let browserTransport: BrowserHandle | undefined;
  let browserProblem: string | undefined;

  async function ensureComputer(): Promise<ReturnType<typeof createRealComputerTransport> | undefined> {
    if (computerTransport !== undefined) return computerTransport;
    if (computerProblem !== undefined) return undefined;
    const candidate = createRealComputerTransport();
    const connected = await candidate.connect();
    if (!connected.ok) {
      computerProblem = `cua-driver did not connect: ${connected.error.message}`;
      return undefined;
    }
    computerTransport = candidate;
    return candidate;
  }

  async function ensureBrowser(): Promise<BrowserHandle | undefined> {
    if (browserTransport !== undefined) return browserTransport;
    if (browserProblem !== undefined) return undefined;
    const created = await createCdpBrowserTransport({ headless: true });
    if (!created.ok) {
      browserProblem = `browser did not start: ${created.error.message}`;
      return undefined;
    }
    browserTransport = created.value;
    return created.value;
  }

  const capabilityRegistry = createCapabilityRegistry({ now: () => new Date() });
  const capabilities = createCapabilityManager({ registry: capabilityRegistry, now: () => new Date() });

  function registerCapability(input: {
    id: CapabilityId;
    name: string;
    risk: "READ" | "WRITE" | "EXTERNAL" | "DESTRUCTIVE";
    actions: { id: string; risk: "READ" | "WRITE" | "EXTERNAL" | "DESTRUCTIVE" }[];
    provider: string;
    availability: CapabilityAvailability;
    requirements?: string[];
    /** A REAL probe. When supplied, availability is derived from it, never declared. */
    probe?: () => Promise<{ availability: CapabilityAvailability; detail?: string }>;
  }): void {
    capabilityRegistry.register({
      id: input.id,
      name: input.name,
      risk: input.risk,
      provider: input.provider,
      availability: input.availability,
      ...(input.requirements !== undefined ? { requirements: input.requirements } : {}),
      actions: input.actions,
      // The probe reports what is TRUE now. A capability with a transport probes it;
      // one without reports the honest reason it cannot work. Either way the answer
      // is measured rather than declared.
      health: async () =>
        input.probe !== undefined
          ? input.probe()
          : { availability: input.availability, detail: input.requirements?.[0] ?? "no transport connected" },
    });
  }

  // KAI's OWN direct capability: real, backed by the read-only builtin tools that
  // already work. This is what lets KAI act with zero employees installed.
  registerCapability({
    id: "system",
    name: "System and state inspection",
    risk: "READ",
    provider: "kai",
    availability: "AVAILABLE",
    actions: [
      { id: "system.get_status", risk: "READ" },
      { id: "agents.list", risk: "READ" },
      { id: "missions.list", risk: "READ" },
      { id: "memory.list", risk: "READ" },
    ],
  });
  // Registered but NOT available: the seam exists, the transport does not.
  registerCapability({
    id: "browser",
    name: "Browser (semantic-first)",
    risk: "EXTERNAL",
    provider: "kai",
    availability: "UNAVAILABLE",
    requirements: ["a real CDP transport over the installed Edge/Chrome; semantic-first, screenshots only as a fallback"],
    probe: async () => {
      const transport = await ensureBrowser();
      if (transport === undefined) {
        return { availability: "UNAVAILABLE", detail: browserProblem ?? "browser not started" };
      }
      const affordances = transport.affordances();
      return {
        availability: affordances.dom || affordances.accessibility ? "AVAILABLE" : "DEGRADED",
        detail: `CDP connected; dom=${affordances.dom} accessibility=${affordances.accessibility} screenshot=${affordances.screenshot}`,
      };
    },
    // The WHOLE surface, not a sample of it: the tool must accept exactly what
    // the transport can do (BROWSER_ACTIONS, the same list the browser capability
    // object advertises), because the action list is what the dispatch guard in
    // `registerCapabilityTool` checks membership against. The risk of each action
    // is taken from the transport's own ACTION_RISK table, whose max is EXTERNAL —
    // equal to this capability's risk, so registration's understatement invariant
    // still holds. `observe` is not in BROWSER_ACTIONS (the object surface does
    // not expose it) but the tool branch routes it, so it is declared here too.
    actions: [
      ...BROWSER_ACTIONS.map((id) => ({ id, risk: ACTION_RISK[id] })),
      { id: "observe", risk: "READ" as const },
    ],
  });
  registerCapability({
    id: "computer",
    name: "Computer use (CUA)",
    risk: "DESTRUCTIVE",
    provider: "kai",
    availability: "UNAVAILABLE",
    requirements: ["cua-driver 0.28.2 over MCP stdio, connected lazily on first use"],
    probe: async () => {
      const transport = await ensureComputer();
      if (transport === undefined) {
        return { availability: "UNAVAILABLE", detail: computerProblem ?? "cua-driver not connected" };
      }
      const reported = await transport.health();
      return reported.state === "available"
        ? { availability: "AVAILABLE", detail: "cua-driver connected" }
        : { availability: "UNAVAILABLE", detail: reported.error?.message ?? "cua-driver unhealthy" };
    },
    // Declared = routed: the tool branch handles `windows`, `observe` and
    // `inspect` by name and every driver-shaped action (`click`/`type`/`keypress`/
    // `scroll`) through `transport.act`. Naming all seven is what lets the dispatch
    // guard tell "an action this capability does not have" from "an action whose
    // payload is wrong". Every risk is at most this capability's DESTRUCTIVE.
    actions: [
      { id: "click", risk: "WRITE" },
      { id: "type", risk: "WRITE" },
      { id: "keypress", risk: "WRITE" },
      { id: "scroll", risk: "WRITE" },
      { id: "observe", risk: "READ" },
      { id: "inspect", risk: "READ" },
      { id: "windows", risk: "READ" },
    ],
  });
  registerCapability({
    id: "mcp",
    name: "MCP servers and tools",
    risk: "EXTERNAL",
    provider: "kai",
    availability: "UNAVAILABLE",
    requirements: ["no MCP server is configured or connected"],
    actions: [{ id: "call", risk: "EXTERNAL" }],
  });
  // The REAL workspace capabilities (Phase 4 gap 1). These replace the honest
  // UNAVAILABLE stubs: each availability is PROBED (git by running `git --version`,
  // shell by spawning this Node binary) rather than declared, and each action maps
  // to a tool that already earned its way through the boundary.
  registerCapability({
    id: "filesystem",
    name: "Filesystem",
    risk: "WRITE",
    provider: "kai",
    availability: "UNAVAILABLE",
    requirements: ["node fs is available; a write is WRITE and parks for a human by default"],
    probe: async () => ({
      availability: "AVAILABLE",
      detail: "node fs is available; filesystem.read/list are READ, filesystem.write is WRITE",
    }),
    actions: [
      { id: "read", risk: "READ" },
      { id: "list", risk: "READ" },
      { id: "write", risk: "WRITE" },
    ],
  });
  registerCapability({
    id: "git",
    name: "Git (read-only)",
    risk: "READ",
    provider: "kai",
    availability: "UNAVAILABLE",
    requirements: ["the git CLI is on PATH"],
    probe: async () => {
      const probed = await probeGit();
      return { availability: probed.available ? "AVAILABLE" : "UNAVAILABLE", detail: probed.detail };
    },
    actions: [
      { id: "status", risk: "READ" },
      { id: "log", risk: "READ" },
      { id: "diff", risk: "READ" },
    ],
  });
  registerCapability({
    id: "shell",
    name: "Shell (program execution)",
    risk: "DESTRUCTIVE",
    provider: "kai",
    availability: "UNAVAILABLE",
    requirements: ["run a program with an explicit argument list; DESTRUCTIVE, so the default policy parks it for a human"],
    probe: async () => {
      const probed = await probeShell();
      return { availability: probed.available ? "AVAILABLE" : "UNAVAILABLE", detail: probed.detail };
    },
    actions: [{ id: "run", risk: "DESTRUCTIVE" }],
  });

  /**
   * Every capability gets a TOOL, so a capability action passes the same boundary
   * as everything else (validate -> policy -> approval -> execute) instead of
   * inventing a second route to act. The tool carries the capability's own risk,
   * which registration already guarantees is not understated.
   *
   * This is what makes "no capability action may bypass policy" enforceable rather
   * than aspirational: there is no other way to run one.
   */
  function registerCapabilityTool(capability: {
    id: CapabilityId;
    name: string;
    risk: RiskLevel;
    availability: CapabilityAvailability;
  }): void {
    tools.register({
      id: `capability.${capability.id}`,
      name: `Use capability: ${capability.name}`,
      description: `Invokes the "${capability.id}" capability. Availability is reported honestly: an unconnected capability refuses rather than pretending.`,
      risk: capability.risk,
      validate(input: unknown) {
        if (input === undefined || input === null) return { ok: true, value: {} };
        if (typeof input !== "object" || Array.isArray(input)) {
          return { ok: false, reason: "input must be an object or omitted" };
        }
        return { ok: true, value: input as Record<string, unknown> };
      },
      execute: async (input: unknown) => {
        const { action, input: payload } = input as { action?: string; input?: unknown };
        const spec = capabilityRegistry.get(capability.id);
        if (spec === undefined) {
          throw new Error(`capability "${capability.id}" is not registered`);
        }
        // Which action, and is it OURS? Resolved before the health probe on
        // purpose: an action this capability never declared is a refusal about
        // the REQUEST, and must not be masked by (or delayed behind) the state
        // of a transport. This is the guard that makes the declared action list
        // real: without it a READ-classified capability could dispatch any tool
        // it liked — `capability.system` with {action:"shell.run"} reached the
        // DESTRUCTIVE shell — and the registration-time invariant that the
        // capability's risk covers its actions then proved nothing about what
        // could actually be reached. Everything downstream (workspace ops,
        // transports, KAI's own tools) is therefore reachable only through a
        // name that was declared with a risk registration already checked.
        const chosen = action ?? spec.supportedActions[0];
        if (typeof chosen !== "string" || chosen.length === 0) {
          throw new Error(`capability "${capability.id}" has no action to run`);
        }
        const supported = spec.supportedActions.join(", ");
        if (!spec.supportedActions.includes(chosen)) {
          throw new Error(
            `capability "${capability.id}" has no handler for action "${chosen}" (it accepts: ${supported})`,
          );
        }
        // Availability is PROBED at execution time. Reading the recorded snapshot
        // instead was a real defect: a snapshot only says what was true when something
        // last asked, so a lazily-connected transport looked dead until an unrelated
        // route happened to wake it — the capability refused to run while its driver
        // was perfectly available. Asking the transport makes "can this work?" a
        // measurement. DEGRADED is allowed through: it means partly working, and the
        // dispatch below produces the precise reason if it cannot.
        const status = await capabilityRegistry.checkHealth(capability.id);
        if (
          status !== undefined &&
          status.availability !== "AVAILABLE" &&
          status.availability !== "DEGRADED"
        ) {
          throw new Error(
            `capability "${capability.id}" is ${status.availability}: ${status.detail ?? "no transport connected"}`,
          );
        }
        // KAI's own capability executes here, in-process, with no worker involved.
        if (capability.id === "system") {
          const inner = await tools.invoke(chosen, payload ?? {});
          if (!inner.ok) throw new Error(inner.error.message);
          return { capabilityId: capability.id, action: chosen, executor: "kai", result: inner.result };
        }
        // ── the REAL workspace capabilities (filesystem / git / shell) ───────
        // The capability tool has ALREADY been validated and policy-checked (and
        // approved, when its risk demanded one) before this execute is reached, so
        // the op runs here — inside the one boundary, exactly once. Re-entering the
        // registry for the inner tool id would either double-park a DESTRUCTIVE
        // action or need the same approval re-bound to a second tool id, which the
        // registry correctly refuses.
        const workspaceOp = WORKSPACE_OPS[`${capability.id}.${chosen}`];
        if (workspaceOp !== undefined) {
          const out = await workspaceOp(payload ?? {});
          return { capabilityId: capability.id, action: chosen, executor: "kai", result: out };
        }
        // ── the real CUA transport ──────────────────────────────────────────
        if (capability.id === "computer") {
          const transport = await ensureComputer();
          if (transport === undefined) throw new Error(computerProblem ?? "cua-driver is not connected");
          if (chosen === "windows") {
            const out = await transport.windows();
            if (!out.ok) throw new Error(out.error.message);
            return { capabilityId: capability.id, action: chosen, executor: "kai", result: out.value };
          }
          if (chosen === "observe") {
            const out = await transport.observe();
            if (!out.ok) throw new Error(out.error.message);
            return { capabilityId: capability.id, action: chosen, executor: "kai", result: out.value };
          }
          if (chosen === "inspect") {
            const out = await transport.inspect();
            if (!out.ok) throw new Error(out.error.message);
            return { capabilityId: capability.id, action: chosen, executor: "kai", result: out.value };
          }
          // An input action: the caller supplies the driver-shaped action rather than
          // KAI guessing pixel geometry from a screenshot, which is exactly the
          // coordinate-guessing loop the brief forbids.
          // NOTE: the shaped action is read from "input", NOT from "action" — "action"
          // carries the action's NAME (the string the registry resolves), so overloading
          // it would have made a driver-shaped action unaddressable.
          const shaped = (payload as { input?: unknown } | undefined)?.input;
          if (typeof shaped === "object" && shaped !== null && "kind" in shaped) {
            const out = await transport.act(shaped as TransportAction);
            if (!out.ok) throw new Error(out.error.message);
            return { capabilityId: capability.id, action: chosen, executor: "kai", result: out.value };
          }
          throw new Error(
            `computer action "${chosen}" needs a driver-shaped action ({kind:"type",text} | {kind:"keypress",keys} | {kind:"click",target} | {kind:"scroll",target}) in "action"`,
          );
        }

        // ── the real CDP browser transport ──────────────────────────────────
        if (capability.id === "browser") {
          const transport = await ensureBrowser();
          if (transport === undefined) throw new Error(browserProblem ?? "the browser is not connected");
          const detail = (payload as { input?: unknown } | undefined)?.input;
          const request = (typeof detail === "object" && detail !== null ? detail : payload) as
            | { targetId?: unknown; url?: unknown; action?: unknown }
            | undefined;
          if (chosen === "open" || chosen === "new_tab") {
            const out = await transport.openTarget(typeof request?.url === "string" ? { url: request.url } : {});
            if (!out.ok) throw new Error(out.error.message);
            return { capabilityId: capability.id, action: chosen, executor: "kai", result: out.value };
          }
          if (chosen === "read" || chosen === "inspect" || chosen === "observe" || chosen === "find") {
            const targetId = typeof request?.targetId === "string" ? request.targetId : undefined;
            const target = targetId !== undefined ? undefined : await transport.openTarget();
            if (target !== undefined && !target.ok) throw new Error(target.error.message);
            const opened = targetId ?? (target?.ok ? target.value.targetId : undefined);
            if (opened === undefined) throw new Error("no browser target is open");
            const out = await transport.observe({ targetId: opened, strategy: "dom" });
            if (!out.ok) throw new Error(out.error.message);
            return { capabilityId: capability.id, action: chosen, executor: "kai", result: out.value };
          }
          if (typeof request?.targetId === "string" && typeof request.action === "object" && request.action !== null) {
            const out = await transport.act({
              targetId: request.targetId,
              action: request.action as unknown as BrowserAction,
              input: {},
              strategy: "dom",
            });
            if (!out.ok) throw new Error(out.error.message);
            return { capabilityId: capability.id, action: chosen, executor: "kai", result: out.value };
          }
          throw new Error(`browser action "${chosen}" needs {targetId, action} or is not supported`);
        }

        // ── MCP (integration handover #2) ────────────────────────────────────
        // Dispatch one discovered MCP tool on a live connection. This execute is
        // ALREADY inside the boundary (validated, policy-checked and — because
        // the capability is EXTERNAL — approval-gated), so the dispatch calls the
        // server directly rather than re-entering the registry, exactly like the
        // workspace capability ops above. The old unconditional throw here is
        // why the capability could never do anything but refuse.
        if (capability.id === "mcp") {
          return dispatchMcpCapability(mcp, chosen, payload);
        }

        // Defence in depth: the membership guard above already refused any action
        // this capability never declared, so reaching here means a DECLARED action
        // with no branch below — a declaration/dispatch disagreement to fix here,
        // not to paper over. Naming the action and listing what is accepted is the
        // same shape the guard uses, so a caller sees one honest refusal either way.
        throw new Error(
          `capability "${capability.id}" has no handler for action "${chosen}" (it accepts: ${supported})`,
        );
      },
    });
  }

  // Employee <-> capability, live rather than documented.
  function syncEmployeeViews(): void {
    for (const described of workforce.describe()) {
      capabilities.registerEmployee({
        id: described.id,
        state: described.state,
        capabilities: described.capabilities,
      });
    }
  }

  const policy = createPolicyEngine({
    // Caller rules first so an explicit rule always wins on overlap; KAI's own
    // internal-state authorization is appended LAST, which is what makes it a
    // default that a project can narrow or override rather than a blanket pass.
    rules: [
      ...(options.policyRules ?? []),
      { id: "kai-internal-state", risk: "WRITE", outcome: "allow", tools: [...KAI_INTERNAL_STATE_TOOLS] },
    ],
    ...(options.policyMode !== undefined ? { mode: options.policyMode } : {}),
    ...(options.onPolicyDecision !== undefined ? { onDecision: options.onPolicyDecision } : {}),
  });

  const approvals = createApprovalService({
    store: stores.approvals,
    publish,
    ...(options.approvalTtlMs !== undefined ? { defaultTtlMs: options.approvalTtlMs } : {}),
  });

  /**
   * Durable parked non-mission requests (the "approve and it actually runs" gap).
   * Created before the tool registry so the registry's `onApprovalRequest` hook can
   * record every request it parks; a mission step is NOT parked here (the mission
   * executor owns its resume), only a request with no mission behind it.
   */
  const parkedRequests = createParkedRequestStore({ path: parkedPath });

  const tools = createToolRegistry({
    policy,
    approvals,
    publish,
    // Stamped on every action record so a trace names the build that produced it.
    coreBuildId: loadIdentity().buildId,
    /**
     * Remember exactly what was parked, so `decideApproval` can re-issue it.
     * Only a request with no mission is recorded: a mission-bound step is resumed
     * by the executor, and re-issuing it here as well would run it twice.
     */
    onApprovalRequest: (info) => {
      if (info.missionId !== undefined) return;
      parkedRequests.record({
        approvalId: info.approvalId,
        toolId: info.toolId,
        input: info.input,
        ...(info.stepId !== undefined ? { stepId: info.stepId } : {}),
        ...(info.scheduleId !== undefined ? { scheduleId: info.scheduleId } : {}),
        ...(info.turnId !== undefined ? { turnId: info.turnId } : {}),
      });
    },
  });

  for (const tool of createBuiltinTools({
    listAgents: () => registry.statusAll(),
    listMissions: (opts) => stores.missions.listMissions(opts),
    listMemories: (opts) => stores.memory.listMemories(opts),
    /**
     * The agent registry is owned here, so this is the one place that can hand
     * the tool its runner. `agents.run_task` is EXTERNAL, so in practice the
     * registry has already applied policy before this closure is reached —
     * which is the point: the executor below cannot execute anything that did
     * not first pass the boundary.
     */
    runAgentTask: async ({ agentId, action, input }) => {
      const adapter = registry.get(agentId);
      if (adapter === undefined) {
        throw new Error(`no agent registered as "${agentId}"`);
      }
      return adapter.runTask({
        id: `task-${Date.now().toString(36)}`,
        input: input ?? action,
        options: { action },
      });
    },
  })) {
    tools.register(tool);
  }

  // The REAL shell / git / filesystem actions (Phase 4 gap 1). Registered on the
  // SAME registry as everything else, so a command or a file write is validated,
  // risk-classified, policy-checked and — for WRITE/DESTRUCTIVE — parked for a
  // human, exactly like a worker task. There is deliberately no second path.
  for (const tool of createWorkspaceTools()) tools.register(tool);

  // Capability tools are registered HERE, after the registry exists: registering
  // them where the capabilities are DEFINED would touch `tools` before it is
  // constructed, and a Core that cannot start is worse than one missing a route.
  for (const spec of capabilityRegistry.list()) {
    registerCapabilityTool(spec);
  }

  // ── MCP (integration handover #2) ─────────────────────────────────────────
  // ONE manager, over the same registry every built-in lives in: it registers
  // its 8 management tools there (so a management call cannot bypass policy),
  // and its provenance ledger is served at GET /mcp/provenance.
  //
  // NOTE on the handover text (`createMcpManager({ tools, publish })`): the
  // manager's deps expose the provenance sink as `record`, not `publish`, and
  // the frozen KaiEventType has no `mcp.*` member — so the sink stays unwired
  // rather than emitting a mis-typed event (the registry's own `action.executed`
  // record already covers the bus for every registry-mediated call).
  // The catalogue persists under the Core's data dir (credential VALUES live
  // in it, so it belongs there and nowhere else) — a restart rehydrates the
  // same servers instead of forgetting them.
  const mcpPath = subsystemPaths.mcpPath ?? (dataDir !== undefined ? join(dataDir, "kai-mcp.json") : undefined);
  const mcp = createMcpManager({ tools, ...(mcpPath !== undefined ? { persistPath: mcpPath } : {}) });
  // Replace the probe-less `mcp` capability registered above with the measured
  // one: availability is derived from live manager state, never declared.
  installMcpCapability(capabilityRegistry, mcp);

  // ── Plugins (foundation, not a marketplace) ───────────────────────────────
  // The registry is created over the shared tool plane: a defined plugin's
  // tools land on THIS registry with the manifest's risk ceiling enforced at
  // define time and the registry boundary enforcing policy at invoke time.
  const pluginsRoot = subsystemPaths.pluginsRoot ?? (dataDir !== undefined ? join(dataDir, "plugins") : ":memory-plugins:");
  const plugins = createPluginRegistry({ root: pluginsRoot, tools });

  /**
   * `missions.create` — the action a scheduled `mission.create` job resolves to.
   *
   * It exists so the scheduler is NOT a policy bypass (Part F1): a scheduled job
   * is handed to the SAME boundary every other action goes through rather than
   * calling `createAndStartMission` directly. The tool is READ because it is
   * KAI-internal orchestration: it starts work, and every step of that work is
   * itself validated and policy-checked through this registry. It does not touch
   * the world by itself, and the mission's own side-effecting steps still park.
   */
  tools.register({
    id: "missions.create",
    name: "Create and start a mission",
    description:
      "Create a mission from {title, description?, steps?} and start it. KAI-internal orchestration; each mission step passes the boundary in its own right.",
    risk: "READ",
    // READ is honest about what creating a mission does to the WORLD (it starts
    // work whose own steps are policy-checked; it touches nothing itself). It is
    // NOT honest about durability: running the same creation twice creates TWO
    // missions, which is exactly why the scheduled `mission.create` job carries
    // `sideEffecting: true`. The acceptance boundary must therefore record a step
    // that targets this tool, even though its risk is READ.
    effectful: true,
    validate(input: unknown) {
      const record = typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : null;
      if (record === null) return { ok: false, reason: "input must be an object with a title" };
      if (typeof record.title !== "string" || record.title.trim().length === 0) {
        return { ok: false, reason: "title must be a non-empty string" };
      }
      return { ok: true, value: record };
    },
    execute: async (input: unknown, ctx) => {
      const record = input as Record<string, unknown>;
      // The boundary's context carries the schedule whose fire caused this
      // creation, so the mission can be stamped with its origin.
      return createAndStartMission(
        record as unknown as Parameters<typeof createMission>[0],
        ctx?.scheduleId !== undefined ? { scheduleId: ctx.scheduleId } : undefined,
      );
    },
  });

  // ── Skills (Phase 2 Part C) ─────────────────────────────────────────────────
  //
  // The store owns `installed/`, `staging/` and `registry.json` under a root the
  // Core owns. Staging is handed the SAME approval service the rest of the Core
  // uses, so an install fails closed without a human. The READ-only tools are
  // registered on the existing registry — there is deliberately no install tool,
  // because an approval must be bound to the exact bytes, not merely to a tool id.
  const skillStore = createSkillStore({ root: skillsRoot });
  const skills = createSkillRegistry({ store: skillStore });
  // KAI's builtin library: seeded on every boot, idempotently — an id a
  // human already owns (their replacement of a builtin) is never overwritten.
  seedBuiltinSkills(skills);
  // Curated third-party library: seeded on every boot, idempotently — an id
  // a human already owns (their replacement of a library skill) is never
  // overwritten.
  seedLibrarySkills(skills);
  const skillStaging = createSkillStaging({ store: skillStore, approvals });
  for (const tool of createSkillToolDefinitions(skills)) tools.register(tool);

  // ── Learning (Phase 2 Parts C5/D) ───────────────────────────────────────────
  //
  // A memory candidate is written to the LIVE engine; a skill candidate is only
  // ever STAGED — `submit` has no code path that installs anything.
  const learning = createLearningPipeline({
    staging: skillStaging,
    memoryWriter: (candidate) =>
      memoryEngine.write({
        content: candidate.content,
        type: candidate.type,
        importance: candidate.importance,
        provenance: "model_candidate",
        actor: "learning",
      }),
  });

  // ── Checkpoints (Phase 2 Part G) ────────────────────────────────────────────
  const checkpoints = createCheckpointManager({ root: checkpointsDir });

  // ── Recovery acceptance ledger (Phase 2 Part H) ─────────────────────────────
  //
  // Created here so the mission runner (below) can be wrapped in the boundary
  // runner; `createBoundaryRunner` implements the executor's StepRunner seam, so
  // executor.ts is untouched.
  const recovery = createExecutionLedger({ path: ledgerPath });
  /**
   * KAI's own conversation sessions (Phase F). Durable, per-user, and the
   * producer of the id the `session` memory scope binds to — which is why the
   * session scope can now be honoured honestly instead of refused.
   */
  const sessions = createSessionService({ store: createSessionStore({ path: sessionsPath }) });

  // ── The one system-prompt composer (Phase 2 Part E) ─────────────────────────
  //
  // KAI's composed prompt had ZERO call sites before this: the identity prompt
  // was never sent on a real turn. The composer is now built with KAI's identity
  // and the LIVE memory/skill ports above, and a turn's prompt is its `.text`.
  const identityProvider = createKaiIdentity({ root: kaiHome });
  // ── the canonical KAI identity model (owner section 4) ──────────────────────
  //
  // ONE source of truth, resolving the four pieces that used to compete:
  // CoreIdentity -> `build`, KaiIdentity -> identity/soul/capabilities/userContext,
  // SOUL.md -> `soul`, KAI_HARNESS -> `harnessStatement()`. Each authority field
  // below IS the running subsystem object -- typed as that factory's own
  // `ReturnType`, so an authority can never be a string describing a subsystem
  // that does not exist. Built here, at the composition root, because this is the
  // only place where all five authorities are simultaneously in scope and already
  // started. `memoryShares` and `build` are omitted deliberately rather than
  // stubbed: the model reports them NOT PROVEN in `binding[]` instead of pretending.
  const identityModel = createKaiIdentityModel({
    identity: identityProvider,
    memoryAuthority: memoryEngine,
    workforceAuthority: workforce,
    sessionAuthority: sessions,
    policyAuthority: policy,
    approvalAuthority: approvals,
  });
  // The composer reads `identity.soul`/`identity.user` at COMPOSE time, so these are
  // getters over the live provider: a SOUL.md edit or an explicit `setSoul` reaches
  // KAI's very next turn without rebuilding the composer (the documented reload
  // semantics in agent/soul.ts). A static snapshot here would silently keep the old
  // personality after a soul replacement — the staleness this closes.
  const prompts = createPromptComposer({
    identity: {
      get soul(): string {
        return identityProvider.identity().soul;
      },
      get user(): string {
        return identityProvider.identity().user;
      },
    },
    memory: async (query, opts) => {
      // The composer passes an opaque `scope` string; `<scope>:<id>` names a
      // mission or employee the runtime genuinely knows, and recall then includes
      // that private bucket alongside the shared global one. An unparseable or
      // unwired scope falls back to global only — never a silent widening.
      const ref = opts.scope !== undefined ? parseMemoryScopeRef(opts.scope) : null;
      // A `subagent:<id>` scope recalls through the PERSONA-AWARE path: the
      // recipient's OWN bucket plus ONLY the entries explicitly shared TO it —
      // never a neighbour's private bucket. Every other scope uses the generic
      // global+one-bucket recall. Both are fail-closed (an unwired scope yields
      // global only, never a silent widening).
      const hits = ref !== null && ref.scope === "subagent"
        ? recallForSubagent(ref.scopeId, {
            text: query,
            limit: opts.limit,
          })
        : recallScoped({
            text: query,
            limit: opts.limit,
            ...(ref !== null ? { scope: ref.scope, scopeId: ref.scopeId } : {}),
          });
      return hits.map((hit) => ({
        id: hit.entry.id,
        content: hit.entry.content,
        source: hit.entry.source,
        createdAt: hit.entry.createdAt,
        score: hit.score,
      }));
    },
    skills: {
      relevant: async (query, limit) =>
        skills.relevant(query, limit).map((item) => ({
          id: item.id,
          name: item.name,
          description: item.description,
          path: item.path,
        })),
    },
  });

  /**
   * The mission executor knows no tools by design, so it offers every `kind:
   * "tool"` step as EXTERNAL and read-only work would park for approval. The
   * runtime is the layer that owns the registry, so it supplies the narrower
   * judgement the executor asks callers for: the risk a tool itself declares is
   * authoritative.
   *
   * This is also the safer direction. A mission template (which may be built from
   * agent or LLM output) can assert `sideEffecting: false`, but it cannot lower a
   * tool's risk — the registry's declared risk is the fact, and the registry is not
   * reachable from a template.
   */
  const missionGate: PolicyGate = {
    async check(request) {
      const tool = request.toolId.length > 0 ? tools.get(request.toolId) : undefined;
      return tool !== undefined && tool.risk !== request.risk
        ? policy.check({ ...request, risk: tool.risk })
        : policy.check(request);
    },
  };

  /**
   * How a mission step becomes work.
   *
   * "tool" goes through the registry (so validation and policy always apply),
   * "agent" goes through the registry of adapters (so no protocol detail leaks
   * here), and "manual" is reported as satisfied with a note rather than being
   * silently skipped — an unattended step that claims success would be a lie.
   */
  /**
   * The canonical refusal VALUE ({ok:false, refusal:{reason, detail?…}})
   * tools like memory.write answer with when they run but decline. Returns
   * the human-readable reason, or undefined for any other value.
   */
  function refusalOfValue(value: unknown): string | undefined {
    if (!isRecord(value) || value["ok"] !== false) return undefined;
    const refusal = value["refusal"];
    if (!isRecord(refusal) || typeof refusal["reason"] !== "string") return undefined;
    const detail = typeof refusal["detail"] === "string" && refusal["detail"].length > 0 ? `: ${refusal["detail"]}` : "";
    return `${refusal["reason"]}${detail}`;
  }

  const rawRunner: StepRunner = async (step: MissionStep, mission: Mission, opts) => {
    // The schedule that created this mission (if any) is carried ON the mission,
    // so every step's action record can name its causal schedule. The step's own
    // identity is the turn: one step execution == one turn of work.
    const originScheduleId =
      typeof mission.metadata?.scheduleId === "string" ? mission.metadata.scheduleId : undefined;
    const turnId = step.id;
    if (step.kind === "tool") {
      if (!step.target) {
        return { ok: false, error: kerr("VALIDATION_FAILED", "tool step without a target") };
      }
      // A mission step that writes memory without naming a scope is writing
      // MISSION context by definition: bind it to this mission rather than
      // fail it. A step that names any scope (even a wrong one) is left alone
      // so the tool's own validation judges it — the runner never silently
      // rewrites an explicit choice, and never widens one to global.
      const stepInput =
        step.target === MUTATION_TOOLS.memoryWrite && isRecord(step.input) && step.input["scope"] === undefined
          ? { ...step.input, scope: "mission", scopeId: mission.id }
          : (step.input ?? {});
      // `opts.approvalId` is present only when a human already cleared this
      // step. Passing it through is what makes the resume actually resume: the
      // boundary sees an approval bound to this exact tool and executes instead
      // of asking a second time.
      const result = await tools.invoke(step.target, stepInput, {
        missionId: mission.id,
        stepId: step.id,
        turnId,
        ...(originScheduleId !== undefined ? { scheduleId: originScheduleId } : {}),
        ...(opts?.approvalId !== undefined ? { approvalId: opts.approvalId } : {}),
      });
      if (!result.ok) return { ok: false, error: result.error };
      // A tool VALUE shaped {ok:false, refusal} is an explicit refusal, not a
      // result: the step did NOT do its work. Settling it COMPLETED would be
      // the false-completion pathology (a refused memory.write once completed
      // its mission). Narrow on purpose: only the canonical refusal shape
      // flips the outcome; any other value — including {ok:false} WITHOUT a
      // refusal — stays the tool's own data.
      const refusal = refusalOfValue(result.result);
      if (refusal !== undefined) {
        return { ok: false, error: kerr("POLICY_DENIED", `step "${step.title}" refused: ${refusal}`) };
      }
      return { ok: true, output: asRecord(result.result) };
    }

    if (step.kind === "agent") {
      /**
       * ONE authoritative worker execution path (Phase 1 §6).
       *
       * This branch used to call `adapter.runTask` directly, which made a mission
       * step a second way to reach a worker — the same class of bypass Part F
       * closed on the HTTP route. It now goes through `agents.run_task`, so every
       * path to a worker is validated, risk-classified and policy-checked once,
       * in one place. The pre-checks below stay: they are reads, and they give a
       * precise error instead of a policy card.
       */
      const adapter = step.target ? registry.get(step.target) : undefined;
      if (!adapter) {
        return {
          ok: false,
          error: kerr("NOT_FOUND", `no agent registered as "${step.target ?? ""}"`),
        };
      }
      const capabilities = await adapter.capabilities();
      if (!capabilities.includes("run_task")) {
        return {
          ok: false,
          error: kerr("AGENT_CAPABILITY_MISSING", `agent "${adapter.id}" cannot run tasks`),
        };
      }
      const input =
        typeof step.input?.input === "string"
          ? step.input.input
          : typeof step.input?.prompt === "string"
            ? step.input.prompt
            : step.title;

      const invoked = await tools.invoke(
        "agents.run_task",
        { agentId: adapter.id, action: step.title, input },
        {
          missionId: mission.id,
          stepId: step.id,
          turnId,
          ...(originScheduleId !== undefined ? { scheduleId: originScheduleId } : {}),
          ...(opts?.approvalId !== undefined ? { approvalId: opts.approvalId } : {}),
        },
      );
      if (!invoked.ok) {
        if (invoked.error.code === "APPROVAL_REQUIRED") {
          // A human has to clear this worker action. The step parks and the
          // mission waits — see the executor's `pending` result.
          return { pending: true, reason: invoked.error.message };
        }
        return { ok: false, error: invoked.error };
      }
      const result = invoked.result as { state: string; output?: string; error?: KaiError };
      if (result.state === "completed") {
        return { ok: true, output: { output: result.output ?? "" } };
      }
      return {
        ok: false,
        error: result.error ?? kerr("AGENT_RUN_FAILED", `agent run ended as ${result.state}`),
      };
    }

    return { ok: true, output: { note: "manual step: reported, not automated" } };
  };

  /**
   * The recovery acceptance boundary, wrapped around the mission runner (Phase 2
   * Part H). It implements the executor's `StepRunner` seam, so executor.ts is
   * untouched: a side-effecting step records `begin` (BEFORE_ACCEPT) then `accept`
   * (AFTER_ACCEPT) BEFORE the effect, and a step recovery classifies AFTER_ACCEPT
   * (or UNKNOWN) is REFUSED rather than replayed. Non-side-effecting steps take the
   * fast path unchanged.
   */
  const runner: StepRunner = createBoundaryRunner(rawRunner, { ledger: recovery });

  const missions = createMissionExecutor({
    store: stores.missions,
    // The SERVICE, not the store: it is what stamps the deadline and arms the
    // expiry timer for each parked step.
    approvals,
    policy: missionGate,
    publish,
    runner,
  });

  /**
   * The autonomous loop (an autonomy/ CLAUDE.md-style subsystem, see
   * `autonomy/supervisor.ts`). It subscribes to the bus rather than owning the
   * mission lifecycle: a Core with `maxAttempts: 0` behaves exactly as before.
   */
  const supervisor = createMissionSupervisor({
    getMission: (id) => stores.missions.getMission(id),
    startAttempt: (input) => createAndStartMissionImpl(input),
    /**
     * Durable half of the duplicate-delivery bound: stamp the settled mission so
     * a replayed `mission.failed` — or a Core restart re-reading the same FAILED
     * row — cannot start a second re-attempt for one failure.
     */
    markRetried: (missionId) => {
      try {
        const mission = stores.missions.getMission(missionId);
        if (mission === null) return;
        const stampedAt = new Date().toISOString();
        stores.missions.upsertMission({
          ...mission,
          metadata: { ...(mission.metadata ?? {}), autonomyRetriedAt: stampedAt },
          updatedAt: stampedAt,
        });
      } catch {
        // The supervisor's in-process marker still bounds duplicates.
      }
    },
    notify: (input) => {
      notifications.notify({
        type: "autonomy",
        title: input.title,
        message: input.message,
        priority: "HIGH",
        missionId: input.missionId,
      });
    },
    // Supervision lessons: mission-scoped, provenance-carrying, verified basis
    // only. A bogus mission id refuses structurally (never silently global).
    recordLesson: (input) => {
      try {
        const result = rememberForMission(input.scopeId, {
          content: input.content,
          type: "mission_context",
          provenance: "system_state",
        });
        return result.ok
          ? { ok: true as const }
          : { ok: false as const, refusal: { reason: result.refusal.reason } };
      } catch (error) {
        return { ok: false as const, refusal: { reason: error instanceof Error ? error.message : String(error) } };
      }
    },
    ...(options.autonomy?.maxAttempts !== undefined ? { bounds: { maxAttempts: options.autonomy.maxAttempts } } : {}),
  });

  /**
   * KAI's self-maintenance surface. It inspects the subsystems KAI owns and
   * repairs the four it can repair in-process; `identity` is the anti-stale
   * check that this project already needed once.
   */
  const maintenance: MaintenanceService = createMaintenanceService({
    identity: () => ({
      buildId: loadIdentity().buildId,
      gitCommit: loadIdentity().gitCommit,
      protocolVersion: PROTOCOL_VERSION,
      pid: process.pid,
    }),
    moduleDir: fileURLToPath(new URL(".", import.meta.url)),
    paths: { database: dbPath, ledger: recovery.path, sessions: sessions.store.path },
    probeDatabase: () => {
      try {
        const missions = stores.missions.listMissions({ limit: 1 });
        return { ok: true, detail: `database readable (${missions.length} of the newest missions read back)` };
      } catch (error) {
        return { ok: false, detail: `database unreadable: ${error instanceof Error ? error.message : String(error)}` };
      }
    },
    probeSessions: () => {
      try {
        const list = sessions.list({ limit: 1, includeArchived: true });
        return { ok: true, detail: `session store readable (${list.length} newest session(s))` };
      } catch (error) {
        return { ok: false, detail: `session store unreadable: ${error instanceof Error ? error.message : String(error)}` };
      }
    },
    probeLedger: () => {
      try {
        const all = recovery.listAll();
        const open = recovery.listOpen();
        return { ok: true, detail: `acceptance ledger readable (${all.length} record(s), ${open.length} open)` };
      } catch (error) {
        return { ok: false, detail: `acceptance ledger unreadable: ${error instanceof Error ? error.message : String(error)}` };
      }
    },
    probeAgents: () => {
      // A worker being unreachable is a WARN, not a failure: KAI is designed to
      // run with a worker offline. So this only reports what is registered.
      const adapters = registry.list();
      const ids = adapters.map((a) => a.id);
      return {
        ok: adapters.length > 0,
        detail: adapters.length > 0 ? `worker adapters registered: ${ids.join(", ")}` : "no worker adapters are registered",
      };
    },
    probeScheduler: () => {
      const running = scheduler.isRunning();
      return { ok: running, detail: running ? "scheduler is running" : "scheduler is not running" };
    },
    runMemoryUpkeep: async () => {
      memoryEngine.upkeep.resume("maintenance");
      await memoryEngine.upkeep.runCycle({ reason: "maintenance" });
    },
    recoverScheduler: () => {
      const out = scheduler.recoverInterrupted();
      return { resumed: out.interrupted.length };
    },
    resumeMissions: () => missions.recover(),
    syncViews: () => syncEmployeeViews(),
  });

  // The loop's triggers live with the KAI Doer (below), because whether a
  // settled mission is retried, re-planned or supervised for settlement truth
  // is exactly the autonomous capability the Doer switches on and off. Guard is
  // not involved: a retry still passes the same policy gate as any other action.
  let detachDoer: (() => void) | null = null;

  /**
   * The scheduled-job catalog (Part F1). A schedule says WHEN; the boundary says
   * WHETHER. Every fire is resolved to a tool id and handed to the SAME
   * validate → policy → (approval) → execute path as any other action, so a job
   * configured yesterday is checked against today's policy at fire time.
   */
  const scheduledJobs: ScheduledJob[] = [
    {
      action: "mission.create",
      toolId: "missions.create",
      risk: "READ",
      // sideEffecting: TRUE, and this is a correction of an earlier judgement call.
      //
      // The reasoning for `false` was that creating a mission starts work whose own steps
      // are policy-checked, so it is "just orchestration". That is true and it is not the
      // point: running the SAME occurrence twice creates TWO missions. Duplicate work is a
      // side effect whether or not each copy is individually checked.
      //
      // Measured, not argued: with `false`, a crash/restart at the claim boundary produced a
      // mission-execution count of 2; with `true`, exactly 1 (the occurrence parks instead of
      // replaying). The tool's own risk stays READ — that describes what creating a mission
      // does to the world; this flag describes what happens if it happens twice.
      sideEffecting: true,
      buildInput: (task) => {
        const raw = stripScheduleExtensions(task.payload);
        const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
        return {
          title: typeof record.title === "string" ? record.title : task.title,
          ...(typeof record.description === "string" ? { description: record.description } : {}),
          ...(Array.isArray(record.steps) ? { steps: record.steps } : {}),
        };
      },
    },
  ];
  const jobRunner = createScheduledJobRunner({ boundary: tools, jobs: scheduledJobs });

  /**
   * The daily work-summary offer. It rides the ONE scheduler through its tick
   * seam (below) rather than adding a second timer, and keeps its "already
   * offered on <local day>" state in the durable settings store so a restart
   * cannot re-offer. It compiles reports from the work board + activity log.
   */
  const summary = createDailySummaryService({
    workItems: stores.workItems,
    activity: stores.activity,
    notifications,
    settings: stores.settings,
  });

  /**
   * Durable lease ledger (Part F). Every fire is claimed before it runs, so two
   * processes — or one process restarting over another — cannot both execute the
   * same slot. `recoverInterrupted()` is called on boot (below).
   */
  const leases = createDurableLeaseStore({ path: leasePath });

  const scheduler = createScheduler({
    store: stores.scheduledTasks,
    publish,
    lease: leases,
    describe: (task) => jobRunner.describe(task),
    onFire: (task, ctx) => jobRunner.run(task, { missed: ctx.missed, scheduleId: task.id }),
    ...(options.tickMs === undefined ? {} : { tickMs: options.tickMs }),
    // Housekeeping on the same loop: the daily summary offer, at most once per
    // local calendar day. Contained inside the scheduler, so a throw here is a
    // recorded tick failure, never a lost loop.
    onTick: (at) => {
      summary.maybeOffer(at);
    },
  });

  const startedAt = new Date();
  let stopped = false;

  async function createAndStartMissionImpl(
    input: Parameters<typeof createMission>[0],
    ctx?: MissionOriginContext,
  ): Promise<Mission> {
    // The schedule that caused this mission is stamped ON THE MISSION, not only
    // on an action record: the mission is the durable thing a later reader has,
    // so the origin must live with it.
    const scheduleId = ctx?.scheduleId;

    // A mission template may only RAISE a step's side-effect classification — never lower it.
    //
    // The derivation reflects what the TARGET DOES, not only what the template claims and not
    // only a tool's declared risk:
    //   - a tool whose risk is not READ touches the world (WRITE / EXTERNAL / DESTRUCTIVE);
    //   - a tool flagged `effectful` creates work despite a READ risk (`missions.create`),
    //     so running it twice creates two missions — a real side effect;
    //   - an agent step reaches a worker through `agents.run_task`, which is EXTERNAL by
    //     nature, so it always records.
    //
    // The registry's declared facts are the authority: a template (which may be built from
    // agent or LLM output) can assert `sideEffecting: false`, but it cannot lower what the
    // target implies. The acceptance boundary records only side-effecting steps, so trusting
    // the template left the recovery ledger permanently empty for these cases and let a real
    // side-effecting step execute with no acceptance record at all.
    const steps = (input.steps ?? []).map((step) => {
      // A "tool" step names its tool in `target` (MissionStepInput), not in a `toolId` field.
      let implied = false;
      if (step.kind === "tool" && step.target !== undefined) {
        const tool = tools.get(step.target);
        implied = tool !== undefined && (tool.risk !== "READ" || tool.effectful === true);
      } else if (step.kind === "agent") {
        implied = true;
      }
      return implied && step.sideEffecting !== true ? { ...step, sideEffecting: true } : step;
    });

    const mission = createMission(
      scheduleId !== undefined
        ? { ...input, steps, metadata: { ...(input.metadata ?? {}), scheduleId } }
        : { ...input, steps },
    );
    mission.status = "QUEUED";
    stores.missions.upsertMission(mission);
    publish("mission.created", { title: mission.title, steps: mission.steps.length }, {
      missionId: mission.id,
    });
    return missions.start(mission.id);
  }

  // The scheduler's fire callback needs this before it is declared; function
  // declarations hoist, so `createAndStartMissionImpl` is the real entry point.
  function createAndStartMission(
    input: Parameters<typeof createMission>[0],
    ctx?: MissionOriginContext,
  ): Promise<Mission> {
    return createAndStartMissionImpl(input, ctx);
  }

  async function healthImpl(): Promise<CoreRuntimeHealth> {
    const agentStatuses = await registry.statusAll();
    const unfinished = stores.missions.listUnfinishedMissions();
    return {
      ok: true,
      startedAt: startedAt.toISOString(),
      uptimeMs: Date.now() - startedAt.getTime(),
      database: { path: dbPath },
      agents: agentStatuses,
      missions: { active: unfinished.length, unfinished: unfinished.length },
      notifications: { unread: notifications.list({ unreadOnly: true }).length },
      approvals: { pending: approvals.list({ status: "PENDING" }).length },
      scheduler: {
        running: scheduler.isRunning(),
        enabled: stores.scheduledTasks.listScheduledTasks({ enabledOnly: true }).length,
      },
      tools: { registered: tools.list().length },
    };
  }

  /**
   * Chat routing. Questions about KAI's own state are answered from that state, not
   * sent to a model: "what's Hermes doing" must reflect the real adapter, and a
   * fabricated answer would be worse than no answer. Anything the router does not
   * recognise is delegated to a connected agent instead.
   *
   * `identityProvider` is KAI's soul. Injecting it here is what lets the router
   * answer "who are you" / "are you Hermes?" AS KAI, with no worker call and no
   * worker self-description — and lets the relay boundary answer as KAI when a
   * worker volunteers its own identity.
   */
  // ── KAI's OWN model provider + reasoning loop (inference independence) ───────
  //
  // KAI's normal chat is KAI -> ModelProvider -> model -> KAI. This is the brain;
  // it never routes through a worker. It is built from KAI-owned settings (env
  // KAI_MODEL_* -> KAI_HOME/model/credentials.json -> defaults), so it works with
  // Hermes stopped, disconnected or uninstalled. A worker (Hermes/OpenCode) stays
  // an OPTIONAL delegation target, reached only on an explicit `task.delegate`.
  const { fetchImpl: modelFetch, ...modelSettings } = options.model ?? {};
  // The provider every turn reads through this wrapper, so a `POST /settings`
  // that changes `model.name` reaches KAI's very next turn with no restart.
  // The wrapper re-resolves per call over the construction base — an empty
  // settings row resolves byte-identically to the unwrapped provider.
  const modelProvider: ModelProvider = createSettingsAwareProvider({
    base: modelSettings,
    overrides: () => settings.modelOverrides(),
    kaiHome,
    ...(modelFetch !== undefined ? { fetchImpl: modelFetch } : {}),
  });
  /**
   * THE MODEL TOOL PLANE — the tools a normal KAI turn may select and run.
   *
   * The set is explicit and READ-only: filesystem search/list/read/metadata,
   * the git read ops, and the status/list tools. A WRITE or DESTRUCTIVE tool is
   * deliberately NOT offered here — exposing `filesystem.write` or `shell.run`
   * to the model would put a parking approval in front of a model that cannot
   * answer it, and the mission's rule is to not blindly enable destructive
   * tools. They remain reachable by id through `/tools/:id/invoke` and missions.
   */
  const modelToolsPlane = createModelToolPlane({
    registry: tools,
    source: "model",
    ids: [
      "filesystem.search",
      "filesystem.list",
      "filesystem.read",
      "filesystem.metadata",
      "git.status",
      "git.log",
      "git.diff",
      "system.get_status",
      "agents.list",
      "missions.list",
      "memory.list",
    ],
  });
  // The ONE provider registry behind /models, /providers, Settings and the
  // palette: live probes, never a static list. Built AFTER the provider it
  // reads (it probes the live object, not a snapshot). Secrets never enter
  // it — configured/not-configured booleans only.
  const providers: ProviderRegistry = createProviderRegistry({
    ...kaiModelPort({ provider: modelProvider, effective: (env, kaiHome) => settings.effective(env, kaiHome) }),
    hermesBaseUrl: options.agents?.hermes?.baseUrl ?? "http://127.0.0.1:8642",
    ...(options.agents?.hermes?.apiKey !== undefined ? { hermesApiKey: options.agents.hermes.apiKey } : {}),
    opencodeBaseUrl: options.agents?.opencode?.baseUrl ?? "http://127.0.0.1:4096",
  });

  const brain: KaiBrain = createKaiBrain({
    provider: modelProvider,
    // KAI's tool plane: the model may SELECT these and KAI EXECUTES them through
    // the ONE registry boundary. Only READ, non-effectful tools are exposed, so
    // a normal turn can search/read files and answer from real data without a
    // parking approval the model could not answer. `POST /tools/:id/invoke` and
    // a mission step still reach every other tool by id.
    tools: modelToolsPlane,
    // The tool-iteration budget is runtime configuration, not a hidden constant
    // (see `CoreRuntimeOptions.brainMaxToolIterations`).
    ...(options.brainMaxToolIterations !== undefined
      ? { maxToolIterations: options.brainMaxToolIterations }
      : {}),
  });

  /**
   * Explicit `@agent` execution for chat: the task (plus optional skill
   * guidance, marked as such) runs AS the persona through the policy-governed
   * run path, and the worker's output is authored AS the persona. A park comes
   * back as an approval the UI can Allow — the work never runs silently.
   */
  async function runAgentForChat(input: { id: string; task: string; skillContext?: string }): Promise<
    | { ok: true; reply: string; guarded: boolean }
    | { ok: false; parked: true; approvalId: string; reason: string }
    | { ok: false; parked?: false; reason: string }
  > {
    const rec = subagentRegistry.get(input.id);
    if (rec === undefined) return { ok: false, reason: `no subagent "${input.id}" is defined` };
    const task =
      input.skillContext !== undefined && input.skillContext.length > 0
        ? `Skill guidance for this task:\n${input.skillContext}\n\nTask: ${input.task}`
        : input.task;
    let outcome: unknown;
    try {
      outcome = await runSubagent(input.id, task);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { ok: false, reason };
    }
    const record = entity(outcome);
    const nested = record !== null ? (entity(record["result"]) ?? record) : null;
    const error = nested !== null ? (entity(nested["error"]) ?? entity(record?.["error"])) : null;
    if (error !== null && error["code"] === "APPROVAL_REQUIRED") {
      const approvalId = typeof error["detail"] === "string" ? error["detail"] : "";
      if (approvalId.length === 0) return { ok: false, reason: "the run parked but named no approval" };
      return { ok: false, parked: true, approvalId, reason: typeof error["message"] === "string" ? error["message"] : "approval required" };
    }
    if (error !== null) {
      return { ok: false, reason: typeof error["message"] === "string" ? error["message"] : "the run was refused" };
    }
    const output =
      (nested !== null && typeof nested["output"] === "string" ? nested["output"] : "") ||
      (nested !== null && typeof nested["result"] === "object" && nested["result"] !== null
        ? String((nested["result"] as Record<string, unknown>)["output"] ?? "")
        : "");
    const authored = personaReply(rec.spec, output);
    return { ok: true, reply: authored.reply, guarded: authored.guarded };
  }

  // The task lifecycle tracker: every turn opens (or resumes) a task carrying
  // the original objective, and completion is verified against it — a tool
  // execution is never mistaken for a deliverable.
  const tasks = createTaskTracker(stores.tasks);



  const chat = createChatRouter({
    runtime: { health: healthImpl, registry, stores },
    memory,
    tasks,
    // KAI's OWN capability registry (provider "kai"), so "what can you do?" is
    // answered from KAI's real architecture and never from a worker's tool install.
    capabilities: { list: () => capabilities.registry.list() },
    identity: identityProvider,
    invocations: {
      agents: () => subagentRegistry.list().map((persona) => ({ id: persona.spec.id, name: persona.spec.name })),
      skills: () =>
        skills
          .list()
          .map((skill) => ({ id: skill.id, name: skill.name, disabled: skill.status === "disabled" })),
      runAgent: (input) => runAgentForChat(input),
      loadSkill: (id: string) => {
        const result = skills.load(id);
        if (!result.ok) return { ok: false as const, reason: result.error.message };
        return { ok: true as const, name: result.value.metadata.name, body: result.value.body };
      },
    },
    // KAI's OWN reasoning loop and the ONE prompt composer, so a normal turn is
    // KAI's own inference over KAI's own identity/context — never a worker.
    brain,
    composePrompt: async (request, opts) => (await composeTurnPrompt(request, opts)).text,
  });

  /**
   * Re-issue a parked NON-mission request after its verdict.
   *
   * The record was written (durably) by the tool registry's `onApprovalRequest`
   * hook at the moment the action was parked. An APPROVED verdict re-invokes the
   * SAME tool with the SAME input and the approval id in hand, so the registry's
   * approval check authorizes exactly this action and nothing else; a REJECTED (or
   * EXPIRED) verdict drops the record and runs nothing. The result is announced as
   * a notification so the person who answered the card sees what happened to it —
   * the island's Allow button therefore completes the whole loop.
   */
  async function reissueParked(
    id: string,
    approved: boolean,
  ): Promise<{ approved: boolean; resumed: boolean; reissued: boolean; result?: unknown }> {
    // Orchestrator WAITING work (ASK autonomy, ASK review) resumes here FIRST:
    // the registry hook records the same park, but the WORK ITEM owns the
    // continuation — consuming the record and continuing the loop executes
    // exactly once instead of twice.
    if (orchestrator.ownsApproval(id)) {
      parkedRequests.remove(id);
      const settled = await orchestrator.onApprovalDecided(id, approved);
      return { approved, resumed: settled.handled > 0, reissued: true, result: { orchestratorResumed: settled.handled } };
    }
    const parked = parkedRequests.get(id);
    if (parked === null) {
      // Nothing was parked for this id: an approval created outside the tool
      // registry (e.g. a staged-skill install approval) has its own re-issue path.
      return { approved, resumed: false, reissued: false };
    }
    parkedRequests.remove(id);
    if (!approved) return { approved, resumed: false, reissued: false };

    const invoked = await tools.invoke(parked.toolId, parked.input, {
      approvalId: id,
      ...(parked.stepId !== undefined ? { stepId: parked.stepId } : {}),
      ...(parked.scheduleId !== undefined ? { scheduleId: parked.scheduleId } : {}),
      ...(parked.turnId !== undefined ? { turnId: parked.turnId } : {}),
    });
    if (invoked.ok) {
      notifications.notify({
        type: "approval",
        title: `Approved action ran: ${parked.toolId}`,
        message: "The action you approved has been re-issued and completed.",
        priority: "NORMAL",
      });
      return { approved, resumed: false, reissued: true, result: invoked.result };
    }
    notifications.notify({
      type: "approval",
      title: `Approved action failed: ${parked.toolId}`,
      message: invoked.error.message,
      priority: "HIGH",
    });
    return { approved, resumed: false, reissued: true, result: { error: invoked.error } };
  }

  /**
   * Decide an approval AND settle whatever was waiting on it (Phase 1 Part H).
   *
   * The requirement is that the mission parked on an approval receives a
   * deterministic terminal outcome rather than the approval merely being marked.
   * Deciding and settling are therefore ONE call: a caller cannot do the first
   * without the second, which is what stops a mission being parked forever by a
   * decision that nothing acts on.
   *
   * `resume()` re-reads the recorded verdict itself (APPROVED runs the step,
   * REJECTED/EXPIRED fails the mission with a reason, still-PENDING leaves it
   * parked), so this does not have to interpret the verdict — and a double
   * decision therefore cannot double-execute: the second resume finds the
   * mission no longer waiting and is a no-op.
   */
  /**
   * Settle tracked subagent runs waiting on a decided approval. A rejection
   * means the work will never run (`run_cancelled`); an approval means the
   * wait ended and execution continues on re-issue as a NEW run, so the
   * parked record leaves with a `run_completed` that says exactly that.
   */
  function settleParkedRunsOnVerdict(approvalId: string, approved: boolean): void {
    for (const [runId, tracked] of activeSubagentRuns) {
      if (tracked.approvalId !== approvalId) continue;
      activeSubagentRuns.delete(runId);
      publish(
        approved ? "agent.run_completed" : "agent.run_cancelled",
        approved
          ? {
              runId,
              subagentId: tracked.subagentId,
              decided: "approved",
              note: "approval granted; execution continues on re-issue as a new run",
            }
          : { runId, subagentId: tracked.subagentId, decided: "rejected" },
        { source: "core" },
      );
    }
  }

  async function decideApproval(
    id: string,
    approved: boolean,
  ): Promise<{ approved: boolean; missionId?: string; resumed: boolean; reissued?: boolean; result?: unknown }> {
    const before = approvals.get(id);
    const decided = approvals.decide(id, approved);
    settleParkedRunsOnVerdict(id, approved);
    // `decide` returns a result union; the mission id may come from either the
    // row we read first or the one it just wrote.
    const missionId = before?.missionId ?? (decided.ok ? decided.approval.missionId : undefined);
    if (missionId === undefined) {
      // No mission owns this request. Before Phase 4 the verdict was recorded and
      // the parked work simply never ran; now the exact call is re-issued from the
      // durable parked-request store (see reissueParked).
      return reissueParked(id, approved);
    }
    // `resumed` must mean "the mission actually moved", not "resume() was
    // called": resume() is a documented no-op for a mission that is not waiting,
    // so reporting the call would claim work that did not happen. Compare the
    // observable state instead.
    const waitingBefore = stores.missions.getMission(missionId)?.status === "WAITING_APPROVAL";
    try {
      await missions.resume(missionId);
    } catch {
      // A failure to resume must not lose the decision that was recorded: the
      // approval is decided either way, and recover() will settle the mission on
      // the next startup if this pass could not.
      return { approved, missionId, resumed: false };
    }
    const settledNow = stores.missions.getMission(missionId)?.status !== "WAITING_APPROVAL";
    return { approved, missionId, resumed: waitingBefore && settledNow };
  }

  /**
   * Compose ONE turn's system prompt (Phase 2 Part E).
   *
   * This is the audit fix. Before this existed, `KaiIdentityProvider.systemPrompt()`
   * had zero call sites in core/src: KAI had a composed system prompt that nothing
   * used, and a real turn sent the RAW user message to the worker. Now the turn's
   * prompt is composed from safety → identity → user context → relevant memory
   * (keyed to the request) → relevant skills → mission → request, and the chat
   * relay sends `.text`. Retrieval is bounded, and a port failure degrades to a
   * prompt without that section rather than throwing.
   */
  async function composeTurnPrompt(request: string, opts?: ComposeTurnOptions): Promise<ComposedPrompt> {
    const composed = await prompts.compose(request, opts ?? {});
    // SESSION CONTEXT — digest + recent turns, never the lifetime transcript.
    // Built here (not in prompts/) so the fixed section pipeline is untouched:
    // the session block is an additive suffix the model reads as context.
    const sessionBlock = buildSessionContextBlock(opts?.sessionId);
    if (sessionBlock === null) return composed;
    const text = `${composed.text}\n\n${sessionBlock}`;
    return { ...composed, text, totalChars: text.length };
  }

  /**
   * The bounded session block: the persisted digest plus the last 10 turns
   * (each truncated), with per-turn tool outcomes named. Null when there is no
   * session or nothing recorded — a caller then sends the prompt unchanged.
   */
  function buildSessionContextBlock(sessionId: string | undefined): string | null {
    if (sessionId === undefined || sessionId.length === 0) return null;
    const session = sessions.get(sessionId);
    if (session === null) return null;
    const lines: string[] = [`## Current conversation (session ${session.id}: ${session.title})`];
    if (session.summary !== undefined) {
      const digest = session.summary;
      const parts = [`Objective: ${digest.objective || "(just started)"}`];
      if (digest.lastAssistantLine.length > 0) parts.push(`Last: ${digest.lastAssistantLine}`);
      if (digest.toolsUsed.length > 0) {
        parts.push(`Tools used: ${digest.toolsUsed.join(", ")} (${digest.toolStats.executed}/${digest.toolStats.total} executed)`);
      }
      if (digest.files.length > 0) parts.push(`Files: ${digest.files.slice(0, 8).join("; ")}`);
      lines.push(parts.join(" | "));
    }
    const recent = sessions.turns(session.id, 10);
    if (recent.ok && recent.value.length > 0) {
      lines.push("Recent turns (oldest first):");
      for (const turn of recent.value) {
        const tools =
          turn.tools !== undefined && turn.tools.length > 0
            ? ` [tools: ${turn.tools.map((call) => `${call.toolName}=${call.status}`).join(", ")}]`
            : "";
        const clipped = turn.text.length <= 400 ? turn.text : `${turn.text.slice(0, 400).trimEnd()}…`;
        lines.push(`${turn.role}: ${clipped.replace(/\s+/g, " ")}${tools}`);
      }
    }
    if (lines.length <= 1) return null;
    const block = lines.join("\n");
    return block.length <= 4000 ? block : `${block.slice(0, 4000).trimEnd()}…\n[session context truncated]`;
  }

  /**
   * Whether this runtime can REALLY honour a memory scope. A scope is only
   * meaningful when something in the runtime mints its ids; otherwise a scoped
   * fact is a fact nothing will ever recall, which is exactly the fake this
   * surface exists to prevent.
   */
  function memoryScopeSupport(): MemoryScopeSupport[] {
    return [
      {
        scope: "global",
        producer: "core",
        wired: true,
        reason: "shared, durable facts; written by the API, capture and learning, and recalled by default",
      },
      {
        scope: "mission",
        producer: "missions",
        wired: true,
        reason: "bound to a real mission id from the mission store",
      },
      {
        scope: "employee",
        producer: "workforce",
        wired: true,
        reason: "bound to a real employee id from the workforce manager",
      },
      {
        scope: "session",
        producer: "sessions",
        wired: true,
        reason: "bound to a real KAI session id from the session service, which also owns the worker conversation the turns belong to",
      },
      {
        scope: "subagent",
        producer: "subagents",
        wired: true,
        reason: "bound to a real KAI subagent persona id from the subagent registry; recall is fail-closed to that persona's own bucket plus explicitly shared entries",
      },
      {
        scope: "project",
        producer: null,
        wired: false,
        reason: "nothing in KAI mints or tracks a project id, so there is no producer to bind the scope to",
      },
    ];
  }

  function resolveMemoryScope(input: { scope: MemoryScope; scopeId?: string }): MemoryScopeResolution {
    const scope = input.scope;
    if (!isMemoryScope(scope)) {
      return { ok: false, code: "MEMORY_SCOPE_UNSUPPORTED", reason: `memory scope must be one of ${MEMORY_SCOPES.join(", ")}` };
    }
    if (scope === "global") return { ok: true, scope, scopeId: "global" };

    const support = memoryScopeSupport().find((s) => s.scope === scope);
    if (support === undefined || !support.wired) {
      return {
        ok: false,
        code: "MEMORY_SCOPE_UNSUPPORTED",
        reason: `the "${scope}" memory scope is not wired in this runtime: ${support?.reason ?? "no producer"}`,
      };
    }

    const scopeId = typeof input.scopeId === "string" ? input.scopeId.trim() : "";
    if (scopeId.length === 0) {
      return { ok: false, code: "MEMORY_SCOPE_SUBJECT_UNKNOWN", reason: `the "${scope}" memory scope needs a scopeId naming a real ${scope}` };
    }
    if (scope === "mission" && stores.missions.getMission(scopeId) === null) {
      return { ok: false, code: "MEMORY_SCOPE_SUBJECT_UNKNOWN", reason: `no mission "${scopeId}" exists, so a mission-scoped fact would be unreachable` };
    }
    if (scope === "session" && !sessions.exists(scopeId)) {
      return { ok: false, code: "MEMORY_SCOPE_SUBJECT_UNKNOWN", reason: `no session "${scopeId}" exists, so a session-scoped fact would be unreachable` };
    }
    if (scope === "employee" && workforce.describe(scopeId).length === 0) {
      return { ok: false, code: "MEMORY_SCOPE_SUBJECT_UNKNOWN", reason: `no employee "${scopeId}" is registered` };
    }
    if (scope === "subagent" && subagentRegistry.get(scopeId) === undefined) {
      return { ok: false, code: "MEMORY_SCOPE_SUBJECT_UNKNOWN", reason: `no subagent "${scopeId}" is defined, so a subagent-scoped fact would be unreachable` };
    }
    return { ok: true, scope, scopeId };
  }

  function rememberScoped(input: ScopedMemoryWrite & { actor?: string; reason?: string }): MemoryWriteResult {
    const resolved = resolveMemoryScope({
      scope: input.scope,
      ...(input.scopeId !== undefined ? { scopeId: input.scopeId } : {}),
    });
    if (!resolved.ok) {
      return { ok: false, refusal: memoryRefusal("SCOPE_VIOLATION", resolved.reason) };
    }
    const { scope: _scope, scopeId: _scopeId, ...rest } = input;
    return memoryEngine.write({ ...rest, scope: resolved.scope, scopeId: resolved.scopeId });
  }

  /**
   * Recall from the shared global bucket PLUS one honoured private scope. A
   * private scope that cannot be resolved yields nothing (fail closed: never a
   * silent widening to another scope's memory).
   */
  function recallScoped(query: ScopedMemoryQuery): MemorySearchHit[] {
    const scopes: MemoryScopeAccess[] = [{ scope: "global" }];
    if (query.scope !== undefined && query.scope !== "global") {
      const resolved = resolveMemoryScope({
        scope: query.scope,
        ...(query.scopeId !== undefined ? { scopeId: query.scopeId } : {}),
      });
      if (!resolved.ok) return [];
      scopes.push({ scope: resolved.scope, ids: [resolved.scopeId] });
    }
    return memoryEngine.search({
      scopes,
      ...(query.text !== undefined ? { text: query.text } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
      ...(query.types !== undefined ? { types: query.types } : {}),
    });
  }

  function rememberForMission(
    missionId: string,
    input: Omit<ScopedMemoryWrite, "scope" | "scopeId">,
  ): MemoryWriteResult {
    return rememberScoped({ ...input, scope: "mission", scopeId: missionId });
  }

  function rememberForEmployee(
    employeeId: string,
    input: Omit<ScopedMemoryWrite, "scope" | "scopeId">,
  ): MemoryWriteResult {
    return rememberScoped({ ...input, scope: "employee", scopeId: employeeId });
  }

  function recallForMission(
    missionId: string,
    query: Omit<ScopedMemoryQuery, "scope" | "scopeId"> = {},
  ): MemorySearchHit[] {
    return recallScoped({ ...query, scope: "mission", scopeId: missionId });
  }

  function recallForEmployee(
    employeeId: string,
    query: Omit<ScopedMemoryQuery, "scope" | "scopeId"> = {},
  ): MemorySearchHit[] {
    return recallScoped({ ...query, scope: "employee", scopeId: employeeId });
  }

  /** Write a fact scoped to a real conversation. Refuses an unknown session. */
  function rememberForSession(
    sessionId: string,
    input: Omit<ScopedMemoryWrite, "scope" | "scopeId">,
  ): MemoryWriteResult {
    return rememberScoped({ ...input, scope: "session", scopeId: sessionId });
  }

  /** Recall global facts plus the ones session-scoped to `sessionId`. */
  function recallForSession(
    sessionId: string,
    query: Omit<ScopedMemoryQuery, "scope" | "scopeId"> = {},
  ): MemorySearchHit[] {
    return recallScoped({ ...query, scope: "session", scopeId: sessionId });
  }

  // ── A subagent's own memory (private) + governed shares ─────────────────────
  //
  // A subagent's private memory is just the canonical store, scoped to that
  // persona via the SAME scope machinery every other private scope uses. No
  // second store is created. `subagentId` must name a registered persona, so a
  // fact written into a bucket nothing recalls is refused rather than orphaned.
  //
  // Reading is fail-closed: a persona sees global facts, its OWN bucket, and the
  // specific entries another persona EXPLICITLY shared to it — never a neighbour's
  // bucket. The share is a pointer resolved at read time; revoking it removes
  // access without the fact ever having been copied.

  /** Write a fact private to one persona. Refuses an unknown subagent. */
  function rememberForSubagent(
    subagentId: string,
    input: Omit<ScopedMemoryWrite, "scope" | "scopeId">,
  ): MemoryWriteResult {
    return rememberScoped({ ...input, scope: "subagent", scopeId: subagentId });
  }

  /** Recall global facts plus the subagent's own bucket, plus entries shared TO it. */
  function recallForSubagent(
    subagentId: string,
    query: Omit<ScopedMemoryQuery, "scope" | "scopeId"> = {},
  ): MemorySearchHit[] {
    const own = recallScoped({ ...query, scope: "subagent", scopeId: subagentId });
    const shares = subagentMemoryShares.forRecipient(subagentId);
    if (shares.length === 0) return own;

    const nowIso = new Date().toISOString();
    // The SAME token matching the store uses: a share must never be recalled
    // through a different (and stricter) rule than the source bucket, or a
    // granted fact would be invisible exactly when it is needed. An empty query
    // matches everything in the allowed set, as the store's browse path does.
    const tokens = typeof query.text === "string" ? tokenizeMemoryText(query.text) : [];
    const wantedTypes = query.types !== undefined ? new Set(query.types) : null;

    const seen = new Set(own.map((hit) => hit.entry.id));
    const shared: MemorySearchHit[] = [];
    for (const share of shares) {
      const entry = memoryEngine.get(share.entryId);
      if (entry === null) continue; // the source fact is gone: access simply follows it
      if (seen.has(entry.id)) continue; // already recalled via own/global
      if (!isActive(entry, nowIso)) continue; // expiry/supersession still applies
      if (wantedTypes !== null && !wantedTypes.has(entry.type)) continue;
      if (tokens.length > 0 && !tokens.some((token) => entry.content.toLowerCase().includes(token))) continue;
      seen.add(entry.id);
      // A shared fact ranks just below the recipient's own: the pointer is real
      // but the recipient is not its author, so an own entry of equal relevance wins.
      shared.push({ entry, score: 0.5 });
    }
    return [...own, ...shared];
  }

  /**
   * Grant ONE entry from `fromSubagent`'s private bucket to `toSubagent`, under a
   * KAI approval. Refuses when either persona is unknown, when the entry does not
   * exist, or when it is not actually private to the source persona — so a share
   * can never move a fact out of a bucket it did not belong to.
   */
  function shareSubagentMemory(input: {
    fromSubagent: string;
    entryId: string;
    toSubagent: string;
    approvalId: string;
    reason?: string;
  }): { ok: true; share: SubagentMemoryShare } | { ok: false; reason: string } {
    if (subagentRegistry.get(input.fromSubagent) === undefined) {
      return { ok: false, reason: `no subagent "${input.fromSubagent}" is defined` };
    }
    if (subagentRegistry.get(input.toSubagent) === undefined) {
      return { ok: false, reason: `no subagent "${input.toSubagent}" is defined` };
    }
    const entry = memoryEngine.get(input.entryId);
    if (entry === null) return { ok: false, reason: `no memory entry "${input.entryId}" exists` };
    if (entry.scope !== "subagent" || entry.scopeId !== input.fromSubagent) {
      return {
        ok: false,
        reason: `entry "${input.entryId}" is not private to subagent "${input.fromSubagent}" (it is ${entry.scope}:${entry.scopeId})`,
      };
    }
    const granted = subagentMemoryShares.grant({
      fromSubagent: input.fromSubagent,
      entryId: input.entryId,
      toSubagent: input.toSubagent,
      approvalId: input.approvalId,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });
    if (!granted.ok) return granted;
    // The frozen `KaiEventType` union has no `memory.shared`, and inventing an
    // off-contract event would break type-checking for every consumer, so the
    // journal-free share is recorded only in the governed-share registry itself.
    return { ok: true, share: granted.share };
  }


  // ── KAI's subagent personas ─────────────────────────────────────────────────
  //
  // One registry, persisted beside the Core's other state. Each persona is a thin
  // EmployeeDescriptor in the ONE workforce: it borrows its preferred worker's
  // adapter and runs only through the policy-governed `executeTask` above. Defined
  // here, after the workforce and capabilities exist, so registration can push the
  // persona's declared capabilities into the one capability manager.
  const subagentRegistry: SubagentRegistry = createSubagentRegistry(
    subagentsPath !== undefined ? { path: subagentsPath } : {},
  );

  /**
   * The governed-share registry: the ONLY path by which one persona's private
   * memory reaches another. It stores POINTERS (entry ids), not facts, so the
   * canonical memory store remains the single source of truth.
   */
  const subagentMemoryShares: SubagentMemoryShares = createSubagentMemoryShares(
    subagentSharesPath !== undefined ? { path: subagentSharesPath } : {},
  );

  /**
   * Run one task AS a specific subagent.
   *
   * This does not open a second execution path: it resolves the persona's
   * employee, brings it READY (an employee's state is OBSERVED, never assumed),
   * and then delegates through the ONE policy-governed workforce path — so the
   * run is validated, risk-classified and (for the EXTERNAL worker tool)
   * approval-gated exactly like any other action. The subagent's unique role
   * (`subagent:<id>`, assigned at registration) is what targets it deterministically.
   */
  // ── Tracked subagent runs (P7-P9) ─────────────────────────────────────────
  //
  // Every run gets a runId and a record while it is in flight. A run that
  // completes or fails leaves the map with a terminal event; a run that PARKS
  // on an approval stays tracked so `cancelSubagentRun` can genuinely cancel
  // it (by rejecting its approval). The events come from this actual state —
  // agent.run_started, then exactly one of run_completed / run_failed /
  // run_cancelled — never from a progress guess.
  const activeSubagentRuns = new Map<string, SubagentRunRecord>();
  let subagentRunSeq = 0;

  /** The approval a delegation outcome parked on, when it parked on one. */
  function parkedApprovalOf(outcome: unknown): string | undefined {
    const record = entity(outcome);
    if (record === null) return undefined;
    const nested = entity(record["result"]) ?? record;
    const error = entity(nested["error"]) ?? entity(record["error"]);
    if (error === null || error["code"] !== "APPROVAL_REQUIRED") return undefined;
    const detail = error["detail"];
    return typeof detail === "string" && detail.length > 0 ? detail : undefined;
  }

  function withRunId(outcome: unknown, runId: string): unknown {
    const record = entity(outcome);
    return record === null ? { result: outcome, runId } : { ...record, runId };
  }

  async function runSubagent(id: string, input: string, approvalId?: string): Promise<unknown> {
    const rec = subagentRegistry.get(id);
    if (rec === undefined) {
      return { ok: false, error: kerr("NOT_FOUND", `no subagent "${id}" is defined`) };
    }
    const runId = `run_${Date.now().toString(36)}_${(subagentRunSeq++).toString(36)}`;
    const tracked: SubagentRunRecord = {
      runId,
      subagentId: id,
      employeeId: rec.employeeId,
      startedAt: new Date().toISOString(),
      status: "running",
    };
    activeSubagentRuns.set(runId, tracked);
    publish("agent.run_started", { runId, subagentId: id, employeeId: rec.employeeId }, { source: "core" });
    let outcome: unknown;
    try {
      await workforce.healthCheck(rec.employeeId).catch(() => undefined);
      outcome = await workforce.delegate({
        capability: "run_task",
        role: `subagent:${id}`,
        taskId: `subagent:${id}`,
        input,
        ...(approvalId !== undefined && approvalId.length > 0 ? { options: { approvalId } } : {}),
      });
    } catch (error) {
      activeSubagentRuns.delete(runId);
      const reason = error instanceof Error ? error.message : String(error);
      publish("agent.run_failed", { runId, subagentId: id, reason }, { source: "core" });
      throw error;
    }
    const parkedOn = parkedApprovalOf(outcome);
    if (parkedOn !== undefined) {
      // Still pending: the record stays so a cancel can reject this approval.
      tracked.status = "parked";
      tracked.approvalId = parkedOn;
      return withRunId(outcome, runId);
    }
    activeSubagentRuns.delete(runId);
    publish("agent.run_completed", { runId, subagentId: id }, { source: "core" });
    return withRunId(outcome, runId);
  }

  function listActiveSubagentRuns(): SubagentRunRecord[] {
    return [...activeSubagentRuns.values()];
  }

  async function cancelSubagentRun(runId: string): Promise<{ ok: true; runId: string } | { ok: false; reason: string }> {
    const tracked = activeSubagentRuns.get(runId);
    if (tracked === undefined) {
      return { ok: false, reason: `no active run "${runId}" — it completed, failed, was cancelled, or was never tracked` };
    }
    if (tracked.approvalId === undefined) {
      // Synchronous delegation has no preemption point mid-flight; saying
      // otherwise would be the fake. The honest recourse is named.
      return {
        ok: false,
        reason: `run "${runId}" is executing and cannot be preempted; archive the persona to stop future runs`,
      };
    }
    // Rejecting the approval genuinely cancels the work — and the verdict hook
    // above settles the tracked record with the run_cancelled event. If the
    // record somehow survived, settle it here rather than leak it.
    await decideApproval(tracked.approvalId, false);
    if (activeSubagentRuns.has(runId)) {
      activeSubagentRuns.delete(runId);
      publish("agent.run_cancelled", { runId, subagentId: tracked.subagentId }, { source: "core" });
    }
    return { ok: true, runId };
  }

  /**
   * Register ONE persona as an employee in the ONE workforce, and remember how to
   * route its runs to its preferred worker.
   *
   * Shared by `createSubagent` (the HTTP/tool definition path) and by `start()`
   * (the BOOT path). Boot is a different object graph: the persona registry loads
   * `kai-subagents.json` at construction, but the workforce is empty, so without
   * re-registering here the employee rows are absent and `/subagents` falls back
   * to UNKNOWN — a first-class entity KAI owns must not evaporate on restart. The
   * descriptor borrows the preferred worker's adapter, so a persona whose worker
   * is down registers as UNAVAILABLE rather than inventing a way to run.
   */
  function registerSubagentEmployee(spec: KaiSubagentSpec, employeeId: string) {
    const descriptor = descriptorForSubagent(spec, {
      adapterFor: (workerId) => registry.get(workerId),
    });
    const registered = workforce.register(descriptor, { kind: "subagent" });
    // Route + target the persona: which worker its runs go to, its (redacted)
    // preamble, and the unique role `runSubagent` selects it by.
    subagentRuns.set(employeeId, {
      workerId: spec.workerId,
      preamble: personaPreamble(spec),
    });
    workforce.assignRole(employeeId, `subagent:${spec.id}`);
    return registered;
  }

  // ── The state-mutation tools (Phase 2 Part I) ───────────────────────────────
  //
  // Registered LAST, after every subsystem and closure they call exists, so the
  // tools a route invokes are the ones the runtime actually assembled. Each
  // executes the real mutation, so the effect happens INSIDE the boundary rather
  // than after it.
  for (const tool of createStateMutationTools({
    writeCanonicalMemory: (input) => rememberScoped(input as ScopedMemoryWrite & { actor?: string; reason?: string }),
    shareSubagentMemory: (input) =>
      shareSubagentMemory(input as { fromSubagent: string; entryId: string; toSubagent: string; approvalId: string; reason?: string }),
    correctMemory: (input) => {
      const record = input as { id: string; patch: Record<string, unknown> };
      return memoryEngine.update(record.id, record.patch as Parameters<MemoryEngine["update"]>[1], {
        actor: "command",
        reason: "memory correction",
      });
    },
    forgetMemory: (input) => {
      const record = input as { id: string };
      return memoryEngine.forget(record.id, { actor: "command", reason: "memory deletion" });
    },
    createLegacyMemory: (memory) => {
      stores.memory.createMemory(memory as Parameters<typeof stores.memory.createMemory>[0]);
      bus.publish("memory.created", memory, { source: "ui" });
    },
    markNotificationRead: (id) => {
      notifications.markRead(id);
    },
    decideApproval: (id, approved) => decideApproval(id, approved),
    registerEmployee: (descriptor, kind) =>
      workforce.register(descriptor as Parameters<typeof workforce.register>[0], { kind }),
    employeeLifecycle: (id, action) => {
      const lifecycle = action as "enable" | "disable" | "recover";
      return workforce[lifecycle](id);
    },
    createSubagent: (spec) => {
      // Validate + persist the persona, then register it as an employee through the
      // SAME helper boot uses, so the in-process path and the restart path cannot
      // drift apart.
      const defined = subagentRegistry.define(spec);
      if (!defined.ok || defined.value === undefined) return defined;
      const registered = registerSubagentEmployee(defined.value.spec, defined.value.employeeId);
      // Push the persona's declared capabilities into the one capability manager,
      // exactly as every other registered employee's are.
      syncEmployeeViews();
      publish(
        "agent.spawned",
        { subagentId: defined.value.spec.id, employeeId: defined.value.employeeId, name: defined.value.spec.name },
        { source: "core" },
      );
      return { subagent: defined.value, registered };
    },
    setSoul: (text) => {
      // The ONE owner of the soul write: replaces SOUL.md and reloads immediately.
      // The prompt composer reads the live provider (see its construction), so the
      // new soul reaches KAI's next turn with no restart and no stale snapshot.
      const identity = identityProvider.replaceSoul(text);
      return { soul: identity.soul, version: identity.version, path: identity.source.soulPath };
    },
    checkSettings: (input) => checkCombinedSettings(input),
    updateSettings: (input) => {
      // The ONE owner of the settings write. `input` is the VALIDATED value
      // from checkCombinedSettings: model.* patch, orchestration.* patch, or
      // reset list. Raw calls route the same way (validated again defensively).
      const record = (typeof input === "object" && input !== null ? input : {}) as {
        settings?: Record<string, unknown>;
        orchestration?: Record<string, string>;
        reset?: string[];
      };
      const at = new Date().toISOString();
      if (record.reset !== undefined) {
        const modelKeys: string[] = [];
        const orchKeys: string[] = [];
        for (const key of record.reset) {
          if (typeof key !== "string") return { ok: false, reason: "reset keys must be strings" };
          if (!isSettingKey(key) && !isOrchestrationKey(key)) return { ok: false, reason: `unknown setting "${key}"` };
          (isOrchestrationKey(key) ? orchKeys : modelKeys).push(key);
        }
        if (modelKeys.length > 0) {
          const result = settings.reset(modelKeys);
          if (!result.ok) return { ok: false, reason: result.reason };
        }
        const cleared: string[] = [];
        for (const key of orchKeys) {
          if (stores.settings.delete(key)) cleared.push(key);
        }
        if (cleared.length > 0) syncAutonomyDelegateRule();
        return { ok: true, cleared, effective: settings.effective() };
      }
      const updated: string[] = [];
      for (const [key, value] of Object.entries(record.orchestration ?? {})) {
        if (!isOrchestrationKey(key)) return { ok: false, reason: `unknown setting "${key}"` };
        const validated = validateOrchestrationValue(key, value);
        if (!validated.ok) return { ok: false, reason: validated.reason };
        stores.settings.set(key, validated.value, at);
        updated.push(key);
      }
      if (updated.some((key) => isOrchestrationKey(key))) syncAutonomyDelegateRule();
      const modelPatch: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(record.settings ?? {})) {
        if (isOrchestrationKey(key)) {
          const validated = validateOrchestrationValue(key, value);
          if (!validated.ok) return { ok: false, reason: validated.reason };
          stores.settings.set(key, validated.value, at);
          updated.push(key);
        } else {
          modelPatch[key] = value;
        }
      }
      if (Object.keys(modelPatch).length > 0) {
        const result = settings.set(modelPatch);
        if (!result.ok) return { ok: false, reason: result.reason };
        updated.push(...result.value.updated);
      }
      if (updated.length === 0) return { ok: false, reason: "nothing to update: pass at least one settable key" };
      // The ONE place the Doer preference changes. Emitting the transition here
      // (rather than at an HTTP handler) means every writer — a direct tool
      // call, a gated route, and the re-issue that follows an approved park —
      // produces exactly one switch event, and the Doer drains the backlog it
      // accumulated while it was OFF.
      if (updated.includes("orchestration.doer")) {
        const now = readOrchestrationPrefs(stores.settings).doer;
        publish(now === "ON" ? "doer.enabled" : "doer.disabled", { source: "core" }, { source: "core" });
      }
      return { ok: true, updated, effective: settings.effective() };
    },
    cancelMission: (id) => missions.cancel(id),
    startMission: (id) => missions.start(id),
    runMaintenance: () => maintenance.run(),
    manageSession: (input) => {
      const record = input as { op: string; id?: string; title?: string; agentId?: string };
      switch (record.op) {
        case "create": {
          // `agentId` is set only for a session OWNED by a persona (a subagent's own
          // session), so it is born separate from KAI's conversation and never
          // becomes the active one (see sessions/service.ts `create`).
          const opts: { title?: string; agentId?: string } = {};
          if (record.title !== undefined) opts.title = record.title;
          if (typeof record.agentId === "string" && record.agentId.length > 0) opts.agentId = record.agentId;
          return { session: sessions.create(opts) };
        }
        case "rename": {
          const out = sessions.rename(record.id as string, record.title as string);
          return out.ok ? { session: out.value } : { ok: false, reason: out.reason };
        }
        case "archive": {
          const out = sessions.archive(record.id as string);
          return out.ok ? { session: out.value } : { ok: false, reason: out.reason };
        }
        case "unarchive": {
          const out = sessions.unarchive(record.id as string);
          return out.ok ? { session: out.value } : { ok: false, reason: out.reason };
        }
        case "activate": {
          const out = sessions.activate(record.id as string);
          return out.ok ? { session: out.value } : { ok: false, reason: out.reason };
        }
        default:
          return { ok: false, reason: `unknown session operation "${record.op}"` };
      }
    },
    createSchedule: async (task) => {
      stores.scheduledTasks.upsertScheduledTask(task as Parameters<typeof stores.scheduledTasks.upsertScheduledTask>[0]);
      await scheduler.reload();
      return { schedule: task };
    },
    cancelSchedule: (id) => {
      const existing = stores.scheduledTasks.getScheduledTask(id);
      if (existing === null) return false;
      stores.scheduledTasks.deleteScheduledTask(id);
      return true;
    },
    recoverScheduler: () => scheduler.recoverInterrupted(),
    proposeLearning: (event) => learning.learnFromTurn(event as Parameters<typeof learning.learnFromTurn>[0]),
    createCheckpoint: (input) =>
      checkpoints.create(input as Parameters<typeof checkpoints.create>[0]),
    restoreCheckpoint: (id, target) =>
      target !== undefined ? checkpoints.restore(id, { target }) : checkpoints.restore(id),
    deleteSkill: (id) => skills.delete(id),
    toggleSkill: (id, enabled) => (enabled ? skills.enable(id) : skills.disable(id)),
    pluginLifecycle: (input) => {
      const record = input as { op: string; id: string; key?: string; value?: unknown };
      if (record.op === "enable") return plugins.enable(record.id);
      if (record.op === "disable") return plugins.disable(record.id);
      return plugins.setConfig(record.id, record.key as string, record.value);
    },
    setPolicyRules: (rules) => {
      // Replace the CALLER rules, then re-append KAI's own baseline internal-state
      // rule — the same rule the runtime installed at construction. `setRules`
      // replaces the set wholesale, so without this a project rule change would
      // silently drop KAI's authorization to do its own low-consequence bookkeeping
      // (including deciding approvals), which would make KAI unable to be operated.
      // The baseline is always appended LAST, so it is a fallback: a caller rule
      // that wants to narrow it can supply its own `kai-internal-state` rule ahead
      // of it (first match wins). It is visible in GET /policy, so nothing is hidden.
      const callerRules = rules as PolicyRule[];
      const baseline: PolicyRule = {
        id: "kai-internal-state",
        risk: "WRITE",
        outcome: "allow",
        tools: [...KAI_INTERNAL_STATE_TOOLS],
      };
      const result = policy.setRules([...callerRules, baseline]);
      // `applied` is the CALLER's rule count: the baseline is well-formed and is
      // always the last rule, so it always survives normalization. `dropped` counts
      // the caller's malformed rules, which the engine drops toward the safe default.
      const applied = Math.max(0, result.applied - 1);
      return {
        applied,
        dropped: result.dropped,
        reason:
          result.dropped > 0
            ? `applied ${applied} caller rule(s); dropped ${result.dropped} malformed rule(s), which leaves their subjects on the safe default; KAI's baseline internal-state rule is always in force`
            : `applied ${applied} caller rule(s); KAI's baseline internal-state rule is always in force`,
        mode: policy.mode(),
        state: policy.policyState(),
        rules: policy.rules(),
      };
    },
  })) {
    tools.register(tool);
  }

  // ── Orchestrator: ONE authoritative loop over mission work ──────────────────
  //
  // Composes board + bench + dispatch + prompts + review + trace + learn.
  // Delegation executes ONLY through runSubagent (the policy-governed worker
  // path); ASK autonomy parks through approvals; terminal states come only
  // from verify + review evidence. Workers can never self-complete.
  //
  // Autonomy/policy bridge (managed rule `kai-autonomy-delegate`): the tool
  // boundary classifies agents.run_task as EXTERNAL, which parks by default.
  // When the human-approved autonomy says AUTO (level ≥ 2, workerAuto AUTO),
  // a VISIBLE allow rule scoped to exactly that tool id is kept in the
  // policy set — readable in GET /policy, removable by changing autonomy.
  // This is user configuration authorizing reversible delegation, not a
  // bypass: the boundary still evaluates every call, irreversible and
  // high-risk operations still park, and ASK still parks everything.
  function syncAutonomyDelegateRule(): void {
    let prefs: OrchestrationPrefs;
    try {
      prefs = readOrchestrationPrefs(stores.settings);
    } catch {
      return;
    }
    const allow = prefs.autonomy.level >= 2 && prefs.autonomy.workerAuto === "AUTO";
    const kept = policy.rules().filter((rule) => rule.id !== "kai-autonomy-delegate");
    const hasManaged = policy.rules().some((rule) => rule.id === "kai-autonomy-delegate");
    if (allow && !hasManaged) {
      policy.setRules([
        { id: "kai-autonomy-delegate", risk: "EXTERNAL", outcome: "allow", tools: ["agents.run_task"] },
        ...kept,
      ]);
    } else if (!allow && hasManaged) {
      policy.setRules(kept);
    }
  }
  syncAutonomyDelegateRule();
  const reviewBrain: KaiBrain = createKaiBrain({ provider: modelProvider });

  const orchestrator = createOrchestrator({
    board: createWorkBoard(stores.workItems, {
      onEvent: (type, payload) => publish(type as Parameters<typeof publish>[0], payload, { source: "core" }),
    }),
    bench: createBenchmark(stores.workerProfiles),
    dispatcher: createDispatcher({
      bench: createBenchmark(stores.workerProfiles),
      availability: () => subagentRegistry.list().map((persona) => persona.spec.id),
      capabilities: (workerId: string) => {
        const rec = subagentRegistry.get(workerId);
        return { skills: [], tools: ["run_task", ...(rec?.spec.capabilities ?? [])] };
      },
    }),
    trace: createTrace({
      store: stores.activity,
      prefs: () => {
        const prefs = readOrchestrationPrefs(stores.settings);
        return { activity: prefs.activity, reasoning: prefs.reasoning };
      },
      emit: (type, payload) => publish(type as Parameters<typeof publish>[0], payload, { source: "core" }),
    }),
    learning: createLearning({
      metrics: stores.skillMetrics,
      stage: (input) => {
        const staged = skillStaging.stage({ id: input.id, markdown: input.markdown, source: "orchestrator" });
        return staged.ok ? { ok: true } : { ok: false, reason: staged.error.message };
      },
      validate: (markdown) => {
        const parsed = parseSkillMarkdown(markdown);
        return parsed.ok ? { ok: true } : { ok: false, reason: parsed.error.message };
      },
    }),
    patterns: stores.promptPatterns,
    reviewRunner: async (prompt: string) => {
      const result = await reviewBrain.respond({ text: prompt, system: REVIEWER_SYSTEM, purpose: "orchestrator:review" });
      return parseReviewVerdict(result.text);
    },
    delegate: async ({ agentId, prompt, approvalId }) => {
      const started = Date.now();
      let outcome: unknown;
      try {
        outcome = await runSubagent(
          agentId,
          prompt,
          ...(approvalId !== undefined ? [approvalId] : []),
        );
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error), latencyMs: Date.now() - started };
      }
      const record = entity(outcome);
      const nested = record !== null ? (entity(record["result"]) ?? record) : null;
      const error = nested !== null ? (entity(nested["error"]) ?? entity(record?.["error"])) : null;
      if (error !== null && error["code"] === "APPROVAL_REQUIRED") {
        const parkedId = typeof error["detail"] === "string" ? error["detail"] : "";
        if (parkedId.length === 0) return { ok: false, error: "the run parked but named no approval", latencyMs: Date.now() - started };
        return { ok: false, parkedApprovalId: parkedId, latencyMs: Date.now() - started };
      }
      if (error !== null) {
        return {
          ok: false,
          error: typeof error["message"] === "string" ? error["message"] : "the run was refused",
          latencyMs: Date.now() - started,
        };
      }
      const rec = subagentRegistry.get(agentId);
      const output =
        (nested !== null && typeof nested["output"] === "string" ? nested["output"] : "") ||
        (nested !== null && typeof nested["result"] === "object" && nested["result"] !== null
          ? String((nested["result"] as Record<string, unknown>)["output"] ?? "")
          : "");
      const authored = rec !== undefined ? personaReply(rec.spec, output) : { reply: output, guarded: false };
      return { ok: true, reply: authored.reply, latencyMs: Date.now() - started };
    },
    skills: {
      relevant: (query: string, limit: number) => skills.relevant(query, limit).map((s) => ({ id: s.id })),
      load: (id: string) => {
        const result = skills.load(id);
        if (!result.ok) return { ok: false as const, reason: result.error.message };
        return { ok: true as const, name: result.value.metadata.name, body: result.value.body };
      },
      inspect: (id: string) => {
        const result = skills.inspect(id);
        if (!result.ok) return null;
        const metadata = result.value;
        return {
          ...(metadata.version !== undefined ? { version: metadata.version } : {}),
          ...(metadata.contentHash !== undefined ? { hash: metadata.contentHash } : {}),
        };
      },
    },
    // Supervision inspects through KAI's own tools (READ allowlist enforced
    // by the collectors; the registry boundary still policy-checks).
    tools: {
      invoke: async (id, input, opts) => {
        const invoked = await tools.invoke(id, input, {
          source: "orchestrator:verify",
          ...(opts?.missionId !== undefined ? { missionId: opts.missionId } : {}),
          ...(opts?.turnId !== undefined ? { turnId: opts.turnId } : {}),
          ...(opts?.approvalId !== undefined ? { approvalId: opts.approvalId } : {}),
        });
        if (invoked.ok) return { ok: true as const, result: invoked.result };
        return {
          ok: false as const,
          error: { code: invoked.error.code, message: invoked.error.message },
          ...(invoked.invocation.approvalId !== undefined ? { approvalId: invoked.invocation.approvalId } : {}),
        };
      },
    },
    rememberLesson: (input) => {
      try {
        const result = rememberForMission(input.scopeId, {
          content: input.content,
          type: "mission_context",
          provenance: "system_state",
        });
        return result.ok
          ? { ok: true as const }
          : { ok: false as const, refusal: { reason: result.refusal.reason } };
      } catch (error) {
        return { ok: false as const, refusal: { reason: error instanceof Error ? error.message : String(error) } };
      }
    },
    policyCheck: (input) => policy.check(input),
    approvals: {
      request: (input) => ({ id: approvals.request({ ...input, risk: input.risk as "READ" | "WRITE" | "EXTERNAL" | "DESTRUCTIVE" }).id }),
      get: (id) => {
        const row = approvals.get(id);
        return row === null ? null : { status: row.status };
      },
    },
    autonomy: () => readOrchestrationPrefs(stores.settings).autonomy,
    // OPTIONAL decision accelerator. No JEV is shipped (no dependency, no
    // network); the provider boundary is available and OFF by default. KAI's
    // completion is OutcomeGate-authoritative regardless of this setting.
    decisionProvider: createUnavailableJevProvider(),
    jevBudget: {
      ...DEFAULT_JEV_BUDGET,
      enabled: readOrchestrationPrefs(stores.settings).decision === "deterministic+jev",
      maxCallsPerMission: readOrchestrationPrefs(stores.settings).jevMaxCalls,
    },
    publish: (type, payload, opts) => publish(type as Parameters<typeof publish>[0], payload, opts),
  });

  /**
   * ── The KAI Doer ──────────────────────────────────────────────────────────
   *
   * The switch, read LIVE from the durable preference on every decision, and
   * the pending-result inbox behind it.
   *
   * OFF — the Doer interprets nothing: no mission is re-observed, no worker
   * result is read, no follow-up is generated, no retry or corrective action
   * runs, and no model is asked to produce work. Results still arrive and are
   * recorded (durably, idempotently) so nothing is lost.
   *
   * ON — every recorded result is claimed under a lease and processed once:
   * a mission result wakes the mission supervisor (the same authoritative path
   * the loop always used), and a work-item result is advanced through
   * `runWorkItem`, which enforces policy, approvals, the retry ceiling and the
   * Outcome Gate exactly as a user-triggered run does.
   */
  const pendingResults = createPendingResultStore({ path: doerPath });
  const doerEnabled = (): boolean => readOrchestrationPrefs(stores.settings).doer === "ON";

  async function processPendingResult(result: PendingResult): Promise<DoerProcessOutcome> {
    // Reload authoritative state; the event payload is a pointer, never truth.
    if (result.missionId !== undefined && result.missionId.length > 0) {
      await supervisor.observe(result.missionId);
      return { processed: true };
    }
    if (result.workItemId !== undefined && result.workItemId.length > 0) {
      const move = orchestrator.nextMove(result.workItemId);
      // Only the moves that actually advance a live item run autonomously.
      // `ask`/`wait`/`stop` are real decisions the executive has made, not
      // failures to act, so the result settles with the reason they carry.
      if (move.action === "assign" || move.action === "retry" || move.action === "recover") {
        // The inbox row's idempotency key doubles as the orchestrator's resume
        // key, so the same recorded result cannot advance the same item twice
        // even if this drain is retried or a duplicate delivery arrives.
        await orchestrator.runWorkItem(result.workItemId, { resumeEventId: result.idempotencyKey });
        return { processed: true };
      }
      return { processed: true, reason: `no autonomous action: ${move.action} — ${move.reason}` };
    }
    // A terminal event with nothing to correlate against has been seen and
    // needs no action; it is settled with that explanation rather than left
    // pending forever, so the inbox is an audit trail and not a leak.
    return { processed: true, reason: "uncorrelated result: nothing to advance" };
  }

  const doer = createDoer({
    store: pendingResults,
    enabled: doerEnabled,
    process: (result) => processPendingResult(result),
    emit: (type, payload) => publish(type as Parameters<typeof publish>[0], payload, { source: "core" }),
  });

  const detachDoerResults = bus.subscribe(
    (event) => {
      // Record FIRST, and unconditionally: this is what makes OFF safe. The
      // payload is stored redacted as delivered; nothing reads it here.
      // Correlation: mission/step ride on the event; the worker ids ride inside
      // the payload. Absent means unknown — never fabricated.
      const correlation = {
        missionId: event.missionId ?? payloadCorrelation(event.payload, "missionId"),
        stepId: event.stepId ?? payloadCorrelation(event.payload, "stepId"),
        workItemId: payloadCorrelation(event.payload, "workItemId"),
        turnId: payloadCorrelation(event.payload, "turnId"),
        scheduleId: payloadCorrelation(event.payload, "scheduleId"),
      };
      const recorded = doer.record({
        type: event.type,
        eventId: event.id,
        payload: event.payload,
        ...(correlation.missionId !== undefined ? { missionId: correlation.missionId } : {}),
        ...(correlation.stepId !== undefined ? { stepId: correlation.stepId } : {}),
        ...(correlation.workItemId !== undefined ? { workItemId: correlation.workItemId } : {}),
        ...(correlation.turnId !== undefined ? { turnId: correlation.turnId } : {}),
        ...(correlation.scheduleId !== undefined ? { scheduleId: correlation.scheduleId } : {}),
      });
      if (!recorded.created) return;
      // Interpretation is gated on the live preference, never on a captured
      // value: turning the Doer ON starts draining, OFF stops it, immediately.
      if (doerEnabled()) void doer.drain().catch(() => undefined);
    },
    { types: DOER_RESULT_EVENT_TYPES },
  );

  // A switch to ON starts working the backlog immediately, whichever writer
  // flipped it (an approved park included). Guard is untouched by this.
  const detachDoerSwitch = bus.subscribe(
    () => {
      if (doerEnabled()) void doer.drain().catch(() => undefined);
    },
    { types: ["doer.enabled"] },
  );

  detachDoer = () => {
    detachDoerResults();
    detachDoerSwitch();
  };

  return {
    stores,
    bus,
    notifications,
    registry,
    policy,
    approvals,
    parkedRequests,
    doer,
    pendingResults,
    decideApproval,
    workforce,
    capabilities,
    syncEmployeeViews,
    tools,
    mcp,
    plugins,
    missions,
    scheduler,
    summary,
    leases,
    recovery,
    sessions,
    identityModel,
    readSoul: () => {
      const identity = identityProvider.identity();
      return { soul: identity.soul, version: identity.version, soulPath: identity.source.soulPath };
    },
    subagents: subagentRegistry,
    runSubagent,
    activeSubagentRuns: listActiveSubagentRuns,
    cancelSubagentRun,
    supervisor,
    autonomyDecisions: () => supervisor.decisions(),
    maintenance,

    memory,
    memoryEngine,
    memoryScopeSupport,
    resolveMemoryScope,
    rememberScoped,
    recallScoped,
    rememberForMission,
    rememberForEmployee,
    recallForMission,
    recallForEmployee,
    rememberForSession,
    recallForSession,
    rememberForSubagent,
    recallForSubagent,
    subagentMemoryShares,
    shareSubagentMemory,
    prompts,
    composeTurnPrompt,
    skills,
    skillStaging,
    learning,
    checkpoints,
    chat,
    model: modelProvider,
    settings,
    tasks,
    providers,
    orchestrator,
    brain,
    modelTools: modelToolsPlane,
    health: healthImpl,

    createAndStartMission,

    async start() {
      publish("core.started", { dbPath, pid: process.pid }, { source: "core" });
      const agents = await registry.connectAll();
      // Re-register PERSISTED subagent personas into the fresh workforce BEFORE the
      // monitor sweep below. The persona registry loaded `kai-subagents.json` at
      // construction, but boot is a new object graph: without this the employees are
      // absent and `/subagents` reports UNKNOWN. Registering first lets the monitor
      // OBSERVE each persona too, so one whose worker is down reads UNAVAILABLE
      // (known and enabled, with the reason) instead of vanishing.
      for (const rec of subagentRegistry.list()) {
        registerSubagentEmployee(rec.spec, rec.employeeId);
      }
      // Expiry FIRST, then recovery. An approval whose deadline passed while
      // Core was down is still PENDING in the database — its per-request timer
      // did not survive the process — so without this sweep recovery would read
      // a live question that no longer exists and leave the mission parked, with
      // nothing left to ever move it. Sweeping first turns those rows into
      // EXPIRED so recovery can settle them.
      // Employee state must be OBSERVED, not assumed. Without this an employee
      // sits at DISCOVERED forever, which reads as "known" while telling a user
      // nothing about whether it works. monitor() probes each employee once, so
      // Hermes/OpenCode report READY because their endpoints answer, and Codex
      // reports UNAVAILABLE because it is not installed.
      await workforce.monitor().catch(() => undefined);
      // Employee <-> capability is live state, so it is refreshed at startup.
      syncEmployeeViews();
      const expired = approvals.expireStale();
      // Drop parked requests whose approval is gone or no longer PENDING: an
      // approval that expired while the Core was down is a verdict, not a question,
      // so its parked call can never run and must not be re-issued. This is the
      // crash-recovery half of the non-mission resume path.
      parkedRequests.prune((approvalId) => approvals.get(approvalId)?.status ?? null);
      if (expired.length > 0) {
        publish(
          "notification.created",
          { type: "approval.expired", count: expired.length },
          { source: "core" },
        );
      }
      const recovered = await missions.recover();
      if (recovered.blocked.length > 0) {
        notifications.notify({
          type: "mission.recovery_blocked",
          title: `${recovered.blocked.length} mission(s) need a decision`,
          message:
            "These were interrupted with a step that changes something outside KAI, so they were not resumed automatically.",
          priority: "HIGH",
        });
      }
      await scheduler.reload();
      // Classify any slot a previous process claimed and died on BEFORE the loop
      // can fire it again: an INTERRUPTED lease is a recovery decision, never a
      // blind replay. (`reload()` also sweeps, but calling it explicitly at
      // startup is what the durability contract promises.)
      scheduler.recoverInterrupted();
      if (options.startScheduler !== false) scheduler.start();

      // Results that arrived while the Doer was OFF (or while the Core was
      // down) are durable, so a restart with the Doer ON resumes them — once
      // each, in correlation order. With the Doer OFF nothing is claimed and
      // the inbox simply keeps its rows.
      if (doerEnabled()) {
        await doer.drain().catch(() => undefined);
      }

      // The memory upkeep resume path (Part B7). The enabled flag and the last
      // run live in the store, not a closure, so a restart reads them back: we
      // re-enable a pause left behind and run one resume cycle to drain any turns
      // queued before the Core went down. `runUpkeepOnStart:false` is the seam a
      // test uses to drive cycles itself.
      memoryEngine.upkeep.resume("core-startup");
      if (subsystemPaths.runUpkeepOnStart !== false) {
        await memoryEngine.upkeep.runCycle({ reason: "startup" }).catch(() => undefined);
      }
      return { agents, recovered };
    },

    async stop() {
      if (stopped) return;
      stopped = true;
      // Order matters: nothing may fire a task after the database is gone.
      scheduler.stop();
      detachDoer?.();
      publish("core.stopped", {}, { source: "core" });
      await registry.disconnectAll();
      // MCP servers are child processes this runtime spawned; stop them with
      // everything else, or a stopped Core leaves orphans behind (dispose is
      // idempotent and swallows per-connection errors by design).
      await mcp.dispose();
      // Disarm approval timers BEFORE the store closes: one firing afterwards
      // would throw inside a timer callback and surface as a crash rather than
      // as an expiry. Waiters are released here too, so nobody is left parked.
      // Cut in-flight worker turns short BEFORE tearing anything down: a turn may legitimately
      // have minutes left on its clock, and waiting for that clock is not a shutdown.
      for (const adapter of registry.list()) {
        try {
          adapter.abort?.();
        } catch {
          // An adapter that cannot be aborted must not stop the others from stopping.
        }
      }
      approvals.dispose();
      // Phase 2 subsystem handles hold their own SQLite connections, so they are
      // closed BEFORE the Core's database: on Windows an open handle would make
      // the file un-removable, and a scheduler/memory write after `stores.close()`
      // would throw into a closed database. Adapters were already aborted above.
      try {
        memoryStore.close();
      } catch {
        // A close that fails is not a reason to leave the rest open.
      }
      try {
        leases.close();
      } catch {
        /* see above */
      }
      try {
        recovery.close();
      } catch {
        /* see above */
      }
      try {
        sessions.close();
      } catch {
        /* see above */
      }
      try {
        parkedRequests.close();
      } catch {
        /* see above */
      }
      try {
        pendingResults.close();
      } catch {
        /* see above */
      }
      stores.close();
    },
  };
}
