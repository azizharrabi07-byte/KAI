/**
 * The one typed front-end for KAI Core (see `docs/api.md`).
 *
 * This module is deliberately dumb: it moves JSON between the island and the
 * Core process over HTTP and does nothing else. It does not choose an agent, run
 * a mission, approve anything or execute a tool — that all lives in Core. The
 * only address it knows is the Core's own base URL.
 *
 * The important contract is that this file is *safe to call from anywhere*:
 *
 *   - every method resolves to a `CoreResult`; nothing ever rejects, so a call
 *     in a render path cannot take the island down,
 *   - a request that outlives its timeout is genuinely aborted (AbortController)
 *     and the timer is always cleared, so a long-lived process leaks nothing,
 *   - response bodies are read defensively into the summary types below; a body
 *     that is HTML, truncated JSON or the wrong top-level type is a typed
 *     `INVALID_RESPONSE`, never a crash and never a silent empty array,
 *   - the base URL is built in exactly one place, and the response body is never
 *     logged wholesale (it may carry more than a log should hold).
 *
 * It imports nothing Tauri-related and touches no global at import time, so the
 * same file runs in the Tauri webview and under `npm run dev` in a plain browser
 * (and under `node --test` with an injected `fetchImpl`).
 */

/**
 * Core's default bind address; the single source of the base URL. A host may
 * override it once at boot with `window.__KAI_CORE_BASE_URL__` (used by the
 * shell to point at an isolated Core in tests, and available to any host that
 * runs Core elsewhere) — never a hardcoded port baked into feature code.
 */
export const DEFAULT_CORE_BASE_URL: string =
  typeof window !== "undefined" && typeof (window as { __KAI_CORE_BASE_URL__?: unknown }).__KAI_CORE_BASE_URL__ === "string"
    ? ((window as { __KAI_CORE_BASE_URL__?: string }).__KAI_CORE_BASE_URL__ as string)
    : "http://127.0.0.1:8788";

export type CoreErrorCode =
  /** Nothing listening / connection refused / DNS failure. */
  | "CORE_OFFLINE"
  /** The request outlived its timeout and was aborted. */
  | "TIMEOUT"
  /** 401/403 from Core. */
  | "AUTH_REQUIRED"
  /** Another 4xx/5xx, carrying the body's `reason` when one is present. */
  | "REQUEST_FAILED"
  /** A 2xx whose body was not the object shape we expect (HTML, truncated JSON, wrong type). */
  | "INVALID_RESPONSE"
  | "UNKNOWN";

export interface CoreError {
  code: CoreErrorCode;
  message: string;
  status?: number;
  reason?: string;
  /** Core's machine-readable error code from the body (`code`), when present. */
  errorCode?: string;
}

export type CoreResult<T> = { ok: true; value: T } | { ok: false; error: CoreError };

// ── Summary types ───────────────────────────────────────────────────────────
// These are the wire shapes we are willing to believe, not the full Core schema:
// every optional field is omitted rather than invented when Core does not send
// it, because Core is a separate process and its payload can be older/newer than
// this client.

export interface CoreAgentSummary {
  id: string;
  state: string;
  detail?: string;
  lastActivity?: string;
  health?: { ok: boolean; latencyMs?: number; endpoint?: string; version?: string };
}

export interface CoreMissionStep {
  id: string;
  index: number;
  title: string;
  kind: string;
  status: string;
  error?: { code: string; message: string };
}

export interface CoreMissionSummary {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  steps?: CoreMissionStep[];
  /** The mission's stated objective, when Core reported one. */
  description?: string;
}

export interface CoreNotificationSummary {
  id: string;
  type: string;
  title: string;
  message?: string;
  priority: string;
  read: boolean;
  createdAt: string;
}

export interface CoreApprovalSummary {
  id: string;
  toolId: string;
  action: string;
  reason: string;
  risk: string;
  status: string;
  missionId?: string;
  createdAt: string;
}

/** The persisted digest of a KAI session, from Core's extractive summarizer. */
export interface CoreSessionDigest {
  objective: string;
  files: string[];
  toolsUsed: string[];
  toolStats: { total: number; executed: number };
  lastAssistantLine: string;
  builtAt: string;
  narrative?: string;
}

/** One persisted model-requested tool call on a turn, from `GET /sessions/:id/turns`. */
export interface CoreToolCall {
  id: string;
  toolCallId: string;
  /** The wire name the model selected. Prefer `toolId` for display. */
  toolName: string;
  /** The canonical registry id (`filesystem.search`), when Core resolved one. */
  toolId?: string;
  arguments: string;
  invocationId?: string;
  status: string;
  result?: unknown;
  approvalId?: string;
  startedAt: string;
  completedAt: string;
}

export interface CoreSessionSummary {
  id: string;
  title: string;
  /** "ACTIVE" | "ARCHIVED", as reported. */
  status: string;
  createdAt: string;
  updatedAt: string;
  /** When the last turn was recorded; absent until the first turn. */
  lastTurnAt?: string;
  /** How many turns the conversation holds. */
  turnCount?: number;
  /** The worker this conversation is bound to, once a turn ran. */
  agentId?: string;
  /** That worker's own conversation id (worker-side; never KAI's session identity). */
  agentSessionId?: string;
  /** Transcript kind: kai-conversation (default), agent-conversation, worker-execution. */
  sessionKind?: string;
  /** The persisted digest, when the session has turns. */
  summary?: CoreSessionDigest;
}

/** One recorded turn of a KAI session, from `GET /sessions/:id/turns`. */
export interface CoreSessionTurn {
  id: string;
  /** "user" | "assistant", as reported. */
  role: string;
  text: string;
  at: string;
  agentId?: string;
  /** The tool calls that produced this turn, oldest first — rendered, never invented. */
  tools?: CoreToolCall[];
}

/** `GET /sessions` carries the list AND which one new turns go to. */
export interface CoreSessionList {
  sessions: CoreSessionSummary[];
  activeSessionId: string | null;
}

// ── Subagents (KAI's own personas, above the workers) ────────────────────────

/** One of KAI's subagents, as `GET /subagents` returns it. */
export interface CoreSubagentSummary {
  id: string;
  name: string;
  role: string;
  /** The persona's soul/personality, redacted. */
  soul: string;
  /** The worker this persona runs on — infrastructure beneath the subagent. */
  workerId: string;
  model?: string;
  capabilities: string[];
  /** Visual reference the KAI_VARIANT model resolves (declared + resolved). */
  visual?: { declared?: Record<string, unknown>; resolved?: unknown };
  employeeId: string;
  status: string;
  enabled: boolean;
  instanceId?: string;
  problems: string[];
  createdAt: string;
}

/** One durable session bound to a subagent persona. */
export interface CoreSubagentSessionSummary {
  id: string;
  title: string;
  status: string;
  updatedAt?: string;
  turnCount?: number;
  agentId?: string;
  agentSessionId?: string;
}

/** `GET /subagents/:id` — the persona plus the sessions bound to it. */
export interface CoreSubagentDetailSummary {
  subagent: CoreSubagentSummary;
  sessions: CoreSubagentSessionSummary[];
}

/** An explicitly invoked agent/skill run behind a turn, from `POST /chat`. */
export interface CoreAgentRun {
  subagentId: string;
  approvalId: string;
  reason: string;
}

export interface CoreChatAnswer {
  agent: string;
  reply: string;
  fromState?: boolean;
  intent?: string;
  data?: unknown;
  sessionId?: string;
  /** The tool calls this turn made, as Core persisted them. */
  toolCalls?: CoreToolCall[];
  toolIterations?: number;
  toolBudgetExhausted?: boolean;
  /** True when the closing text came from the synthesis guard. */
  synthesized?: boolean;
  /** Tool calls requested but never executed (the honest remainder). */
  pendingTools?: string[];
  /** Task lifecycle state after the turn (COMPLETED, PAUSED, …). */
  taskState?: string;
  /** Which `@` invocation the turn used, when one decided it. */
  invocation?: { agents: string[]; skills: string[] };
  /** A delegated agent turn parked on an approval — Allow re-issues it. */
  agentRun?: CoreAgentRun;
}

/** One durable memory entry, from the engine routes (`/memory/search`, `/memory/:id`). */
export interface CoreMemoryEntry {
  id: string;
  content: string;
  type: string;
  /** Rich provenance (`user_statement`, `mission_result`, …) — never invented. */
  provenance: string;
  /** Coarse source (`user_statement`, `system_state`, …). */
  source: string;
  importance: number;
  /** 0..1 confidence in the fact itself. */
  confidence: number;
  scope: string;
  scopeId: string;
  createdAt: string;
  updatedAt: string;
}

/** KAI's live soul text + content version, from `GET /soul`. */
export interface CoreSoul {
  soul: string;
  version: string;
  soulPath: string;
}

/** One persisted KAI setting row, from `GET /settings`. */
export interface CoreSettingRow {
  key: string;
  value: string;
  updatedAt: string;
}

/** One provider as `GET /providers` reports it — live probes, never a static list. */
export interface CoreProviderSummary {
  id: string;
  label: string;
  kind: string;
  current: boolean;
  baseUrl: string;
  reachable: boolean;
  authConfigured: boolean;
  authorized: boolean;
  version?: string;
  latencyMs?: number;
  models: { id: string; current: boolean }[];
  modelsNote?: string;
  reason?: string;
}

/** A live probe result from `GET /providers/:id/test`. */
export interface CoreProviderTest {
  id: string;
  ok: boolean;
  reachable: boolean;
  authorized: boolean;
  latencyMs?: number;
  reason: string;
}

/** KAI's effective model settings + the winning source per key, from `GET /settings`. */
export interface CoreEffectiveSettings {
  values: { name: string; baseUrl: string; timeoutMs: number; apiKeyConfigured: boolean };
  sources: { name: string; baseUrl: string; timeoutMs: string };
}

/**
 * One delegated work item, from `GET /work-items` / inspect. Every optional
 * field is omitted rather than invented when Core does not send it.
 */
export interface CoreWorkItemSummary {
  id: string;
  state: string;
  objective?: string;
  deliverable?: string;
  workerId?: string;
  missionId?: string;
  taskId?: string;
  /**
   * The goal and the exact plan revision that authorised this item (schema v5).
   * Absent means the item is not part of a goal — which is a fact the cockpit
   * must show as "no plan link", never as a guessed one.
   */
  goalId?: string;
  goalRevisionId?: string;
  /** The item's acceptance criteria, so the UI can show what must be proven. */
  criteria?: string[];
  requiredEvidence?: string[];
  /** The item's recorded evidence (kai-observed vs worker-reported). */
  evidence?: { id: string; kind: string; source: string; detail: string; supports: string[]; at?: string }[];
  valueScore?: number;
  attempts?: number;
  retries?: number;
  tokensIn?: number;
  tokensOut?: number;
  latencyMs?: number;
  cost?: { tokensIn?: number; tokensOut?: number; toolCalls?: number; costUsd?: number; latencyMs?: number };
  review?: { reviewerId?: string; criteria?: string[]; verdict?: string; findings?: string[]; at?: string };
  verification?: { passed?: boolean; criteria?: { name: string; met: boolean; detail?: string }[]; at?: string };
  handoff?: {
    status?: string;
    result?: string;
    evidence?: string[];
    tests?: string;
    blockers?: string[];
    risks?: string[];
    followUps?: string[];
  };
  createdAt?: string;
  updatedAt?: string;
}

/** One orchestration activity event, from `GET /activity` / inspect. */
export interface CoreActivityEvent {
  seq: number;
  kind: string;
  label: string;
  detail?: string;
  at: string;
}

/** One benchmarked domain within a worker profile. */
export interface CoreBenchDomain {
  domain: string;
  quality: number;
  verification: number;
  samples: number;
  confidence: string;
  trend: string;
}

/** One worker bench profile with its top domains, from `GET /bench`. */
export interface CoreBenchEntry {
  profile: {
    workerId: string;
    role?: string;
    overallValue?: number;
    overallConfidence?: string;
    totalSamples?: number;
    updatedAt?: string;
  };
  recent: CoreBenchDomain[];
}

/** Full detail for the work-item inspector, from `GET /work-items/:id`. */
export interface CoreWorkItemDetail {
  item: CoreWorkItemSummary;
  children: CoreWorkItemSummary[];
  activity: CoreActivityEvent[];
  benchmark: CoreBenchEntry | null;
}

/** Outcome of `POST /work-items` — planned vs actually dispatched. */
export interface CoreWorkStartOutcome {
  workItemId: string;
  childIds: string[];
  /** True only once a worker was actually dispatched (planning alone: false). */
  delegated: boolean;
  /** A durable work item exists (planned, not necessarily running). */
  planned?: boolean;
  note?: string;
  decision?: unknown;
}

/** Outcome of `POST /work-items/:id/run`. */
export interface CoreWorkRunOutcome {
  workItemId: string;
  state: string;
  note?: string;
}

/** Outcome of `POST /work-items/:id/review` — the reviewer's verdict. */
export interface CoreWorkReviewOutcome {
  verdict: string;
  findings: string[];
  rounds?: number;
}

/**
 * Orchestration display + autonomy prefs, from `GET /settings` — passed
 * through as-is, never defaulted here; the UI reads them defensively.
 */
export interface CoreOrchestrationPrefs {
  autonomy?: Record<string, unknown>;
  activity?: string;
  reasoning?: string;
  toolsView?: string;
  agentsView?: string;
  [key: string]: unknown;
}

/** One installed skill, from `GET /skills` / inspect. */
export interface CoreSkillSummary {
  id: string;
  name: string;
  description: string;
  purpose?: string;
  tools?: string[];
  constraints?: string[];
  tags: string[];
  version?: string;
  source: string;
  contentHash: string;
  status: "enabled" | "disabled";
  revision: number;
  revisionCount: number;
  installedAt: string;
  updatedAt: string;
}

/** One staged skill awaiting approval, from `GET /skills/staging`. */
export interface CoreStagedSkill {
  stagedId: string;
  skillId: string;
  sha256: string;
  source: string;
  stagedAt: string;
  expiresAt: string;
  approvalId?: string;
  name: string;
  description: string;
  tags: string[];
}

/** One tool-lifecycle event from a streamed turn — the brain's real execution. */
export interface CoreToolEvent {
  type: "tool_start" | "tool_done" | "tool_error" | "tool_approval_required";
  toolCallId: string;
  toolName: string;
  toolId?: string;
  invocationId: string;
  status?: string;
  /** The raw JSON arguments (present from tool_start on). */
  arguments?: string;
  /** The approval a parked call waits on. */
  approvalId?: string;
  startedAt: string;
  completedAt?: string;
  error?: { code: string; message: string };
  /** Bounded, secret-redacted result preview (present on terminal events). */
  resultPreview?: string;
  /** True when the real value continued past the preview budget. */
  resultTruncated?: boolean;
}

/** A completed streamed turn. */
export interface CoreStreamedTurn {
  text: string;
  sessionId?: string;
  toolIterations: number;
  toolBudgetExhausted: boolean;
  /** True when the closing text came from the synthesis guard. */
  synthesized?: boolean;
  /** True when the run's AbortSignal stopped the turn: report ABORTED, never completion. */
  cancelled?: boolean;
  /** Task lifecycle state after the turn (COMPLETED, PAUSED, CANCELLED, …). */
  taskState?: string;
  invocation?: { agents: string[]; skills: string[] };
  agentRun?: CoreAgentRun;
}

/** One argument a command understands, from `GET /commands`. */
export interface CoreCommandArg {
  name: string;
  description?: string;
  /** LIVE pool the UI suggests from: sessions/agents/skills/mcp, or free text. */
  source: "sessions" | "agents" | "skills" | "mcp" | "free";
}

/** One executable KAI command, from `GET /commands`. */
export interface CoreCommandSummary {
  id: string;
  title: string;
  description: string;
  usage: string;
  args?: CoreCommandArg[];
}

/** The outcome of `POST /commands/:id/run` — markdown the UI renders. */
export interface CoreCommandOutcome {
  command: string;
  title: string;
  text: string;
  data?: unknown;
}

/**
 * `POST /visual/compile` — the KAI-owned visual-intent seam.
 *
 * `ok: true` carries the VALIDATED, bounded intent Core produced. `ok: false`
 * is a REFUSAL: Core's validator named the offending field and nothing was
 * drawn. A caller renders only the `ok: true` intent; the refusal is surfaced
 * verbatim, never repaired.
 */
export type CoreVisualCompileResponse =
  | { ok: true; intent: unknown }
  | { ok: false; code: string; reason: string };

/** Typed view of `GET /state`. Nested counts are omitted when Core omits them. */
export interface CoreStateSummary {
  ok?: boolean;
  startedAt?: string;
  uptimeMs?: number;
  database?: { path?: string };
  agents: CoreAgentSummary[];
  missions?: { active?: number; unfinished?: number };
  notifications?: { unread?: number };
  approvals?: { pending?: number };
  scheduler?: { running?: boolean; enabled?: number; total?: number };
  tools?: { registered?: number };
}

/** One plan revision, as the Core stores it. */
export interface CorePlanRevision {
  id: string;
  goalId: string;
  version: number;
  contentHash: string;
  createdAt: string;
  createdBy?: string;
  supersedes?: string;
  content: {
    summary: string;
    deliverables: string[];
    tasks: { id: string; title: string; objective: string; dependsOn: string[]; role: string; acceptanceCriteria: string[]; verification: string[] }[];
    acceptanceCriteria: string[];
    requiredEvidence: string[];
    constraints: string[];
    forbiddenOutcomes: string[];
    authorizedWorkspace: string[];
    assumptions: string[];
    uncertainties: string[];
    budgets: { maxTasks: number; maxRetries: number; maxDepth: number };
  };
}

/** A goal, with the approval state and eligibility the UI must show honestly. */
export interface CoreGoalSummary {
  id: string;
  statement: string;
  state: string;
  createdAt: string;
  updatedAt: string;
  assumptions: string[];
  constraints: string[];
  uncertainties: string[];
  blocker?: string;
  currentRevision: CorePlanRevision | null;
  approval: {
    approved: boolean;
    reason: string;
    revisionId: string | null;
    revisionVersion: number | null;
    approvedBy: string | null;
    approvedAt: string | null;
  };
  doer: "ON" | "OFF";
  /**
   * ELIGIBLE — approved AND the Doer is ON.
   * PAUSED_DOER_OFF — approved, but the Doer is OFF, so nothing runs.
   * NOT_APPROVED — no approval that matches the current revision.
   */
  eligibility: "ELIGIBLE" | "PAUSED_DOER_OFF" | "NOT_APPROVED";
  challenge?: {
    goalRevisionId: string;
    mode: string;
    rounds: number;
    verdict: string;
    findings: { role: string; verdict: string; objections: { statement: string; severity: string; blocking: boolean; evidence: string[]; remediation: string; verification: string }[] }[];
    synthesis: { verdict: string; conflicts: string[]; unresolved: string[]; criticalRisks: string[]; summary: string };
  };
}

/** The Doer switch and its pending-result inbox, as the Core reports them. */
export interface CoreDoerState {
  state: "ON" | "OFF";
  paused: boolean;
  guard: "ON";
  pending: { pending: number; claimed: number; done: number; failed: number };
}

// The Tauri boundary, used ONLY for owner-authorized calls: the install's host
// token never enters JavaScript, so those requests are made by the Rust side.
// Every other call is plain fetch. Outside Tauri the bridge is a no-op and the
// owner call falls back to a plain request, whose 401 is surfaced honestly.
import { Bridge } from "./bridge";

export interface CoreClientOptions {
  baseUrl?: string;
  /** Injected for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout in ms. Default 5000. */
  timeoutMs?: number;
}

export interface CoreClient {
  readonly baseUrl: string;
  health(): Promise<CoreResult<{ status: string; version?: string; workers?: CoreWorkerHealth }>>;
  state(): Promise<CoreResult<CoreStateSummary>>;
  agents(): Promise<CoreResult<CoreAgentSummary[]>>;
  agent(id: string): Promise<CoreResult<CoreAgentSummary>>;
  missions(opts?: { status?: string; limit?: number }): Promise<CoreResult<CoreMissionSummary[]>>;
  createMission(input: {
    title: string;
    description?: string;
    steps?: unknown[];
  }): Promise<CoreResult<CoreMissionSummary>>;
  cancelMission(id: string): Promise<CoreResult<CoreMissionSummary>>;
  /**
   * `POST /missions/:id/start` — the approve-to-work transition (DRAFT →
   * QUEUED → RUNNING). Every step still meets policy individually.
   */
  startMission(id: string): Promise<CoreResult<CoreMissionSummary>>;
  /**
   * `POST /plans` — Plan Mode: the model drafts a structured, validated plan
   * from a goal, persisted as a DRAFT mission that runs nothing. 503 when the
   * planner is unavailable, 422 when the draft is invalid.
   */
  createPlan(goal: string): Promise<CoreResult<CoreMissionSummary>>;
  notifications(opts?: {
    unreadOnly?: boolean;
    limit?: number;
  }): Promise<CoreResult<CoreNotificationSummary[]>>;
  markNotificationRead(id: string): Promise<CoreResult<unknown>>;
  approvals(opts?: { status?: string }): Promise<CoreResult<CoreApprovalSummary[]>>;
  decideApproval(id: string, approved: boolean): Promise<CoreResult<CoreApprovalSummary>>;
  sessions(opts?: {
    status?: string;
    limit?: number;
    includeArchived?: boolean;
  }): Promise<CoreResult<CoreSessionList>>;
  /** `GET /sessions/active` — resolves to null when no session has been chosen. */
  activeSession(): Promise<CoreResult<CoreSessionSummary | null>>;
  /** `GET /commands` — the real command catalogue Core serves. */
  commands(): Promise<CoreResult<CoreCommandSummary[]>>;
  /** `GET /sessions/:id/turns` — the recorded turns, oldest first. */
  sessionTurns(id: string, opts?: { limit?: number }): Promise<CoreResult<CoreSessionTurn[]>>;
  createSession(input?: { title?: string }): Promise<CoreResult<CoreSessionSummary>>;
  renameSession(id: string, title: string): Promise<CoreResult<CoreSessionSummary>>;
  archiveSession(id: string): Promise<CoreResult<CoreSessionSummary>>;
  unarchiveSession(id: string): Promise<CoreResult<CoreSessionSummary>>;
  activateSession(id: string): Promise<CoreResult<CoreSessionSummary>>;
  /** `GET /subagents` — KAI's own personas, above the workers. */
  subagents(): Promise<CoreResult<CoreSubagentSummary[]>>;
  /**
   * `POST /commands/:id/run` — execute one command for real. A command that
   * ran and failed returns `ok: true` with `ok: false` inside, because the
   * failure is the RESULT the UI renders, not a transport fault. `raw` is the
   * argument text exactly as typed (newlines intact) for commands that take
   * multiline input, e.g. a pasted report for `/audit`.
   */
  runCommand(id: string, args?: string[] | string, raw?: string): Promise<CoreResult<CoreCommandOutcome>>;
  /** `GET /skills` — the installed catalogue (metadata only, never bodies). */
  skills(): Promise<CoreResult<CoreSkillSummary[]>>;
  /** `GET /skills/:id` — full metadata record for one skill. */
  skill(id: string): Promise<CoreResult<CoreSkillSummary>>;
  /**
   * `POST /skills/:id/enable|disable` — WRITE, parks by default; a 409 means
   * the change is waiting, not applied.
   */
  setSkillEnabled(id: string, enabled: boolean): Promise<CoreResult<CoreSkillSummary>>;
  /**
   * `POST /skills/:id/delete` — DESTRUCTIVE, parks by default.
   */
  deleteSkill(id: string): Promise<CoreResult<{ deleted: boolean; id: string }>>;
  /** `GET /skills/staging` — staged skills awaiting approval. */
  stagedSkills(): Promise<CoreResult<CoreStagedSkill[]>>;
  /** `GET /skills/staging/:stagedId` — the review (incl. body) the human approves. */
  stagedSkill(stagedId: string): Promise<CoreResult<unknown>>;
  /** `POST /skills/staging/:stagedId/approve` — request install approval for the exact bytes. */
  approveStagedSkill(stagedId: string, sha256?: string): Promise<CoreResult<unknown>>;
  /** `POST /skills/staging/:stagedId/install` — install approved bytes. */
  installStagedSkill(stagedId: string, approvalId: string, sha256?: string): Promise<CoreResult<unknown>>;
  discardStagedSkill(stagedId: string): Promise<CoreResult<unknown>>;
  /** `GET /subagents/:id` — the persona plus the sessions bound to it. */
  subagent(id: string): Promise<CoreResult<CoreSubagentDetailSummary>>;
  /**
   * `POST /subagents/:id/run` — run a task AS a subagent. The run is EXTERNAL, so a
   * 409 (`parked: true`) is the normal, expected outcome: it waited for approval.
   */
  runSubagent(id: string, input?: string): Promise<CoreResult<unknown>>;
  memory(opts?: { type?: string; limit?: number }): Promise<CoreResult<unknown[]>>;
  remember(input: { type: string; content: string; importance?: number }): Promise<CoreResult<unknown>>;
  /** `GET /memory/search` — scoped, ranked search over durable entries. */
  searchMemoryEntries(query: string, opts?: { limit?: number }): Promise<CoreResult<CoreMemoryEntry[]>>;
  /** `GET /memory/:id` — one entry with its full provenance. */
  getMemoryEntry(id: string): Promise<CoreResult<CoreMemoryEntry>>;
  /**
   * `POST /memory/:id/correct` — edit content/type/importance/confidence.
   * WRITE through the boundary (auto-authorized internal state, journaled).
   */
  correctMemoryEntry(
    id: string,
    patch: { content?: string; type?: string; importance?: number; confidence?: number },
  ): Promise<CoreResult<CoreMemoryEntry>>;
  /**
   * `POST /memory/:id/delete` — forget one entry. DESTRUCTIVE: parks with a
   * 409 the caller surfaces, exactly like the session delete.
   */
  deleteMemoryEntry(id: string): Promise<CoreResult<{ deleted: string }>>;
  /** `GET /settings` — stored rows + effective model values with sources. */
  getSettings(): Promise<CoreResult<{ stored: CoreSettingRow[]; effective: CoreEffectiveSettings; orchestration?: CoreOrchestrationPrefs }>>;
  /** `GET /work-items` — delegated work, filterable. */
  getWorkItems(filter?: { state?: string; mission?: string; task?: string; worker?: string; limit?: number }): Promise<CoreResult<CoreWorkItemSummary[]>>;
  /** `GET /work-items/:id` — the item plus its children, activity and benchmark. */
  getWorkItem(id: string): Promise<CoreResult<CoreWorkItemDetail>>;
  /** `POST /work-items` — plan and route one objective. */
  startWorkItem(input: {
    objective: string;
    deliverable?: string;
    constraints?: string[];
    successCriteria?: string[];
    risk?: string;
    taskId?: string;
    missionId?: string;
    subtasks?: string[];
    skills?: string[];
  }): Promise<CoreResult<CoreWorkStartOutcome>>;
  /** `POST /work-items/:id/run` — run one item on a worker. */
  runWorkItem(id: string, opts?: { workerId?: string; approvalId?: string }): Promise<CoreResult<CoreWorkRunOutcome>>;
  /** `POST /work-items/:id/review` — review the item's current handoff. */
  reviewWorkItem(id: string, criteria?: string[]): Promise<CoreResult<CoreWorkReviewOutcome>>;
  /** `GET /bench` — worker profiles with their evidence. */
  getBench(): Promise<CoreResult<CoreBenchEntry[]>>;
  /** `GET /activity` — bounded orchestration activity for a task or work item. */
  getActivity(ref?: { task?: string; work?: string }, level?: string): Promise<CoreResult<CoreActivityEvent[]>>;
  /**
   * `POST /settings` — patch KAI's own settings. Parks by default
   * (traffic redirection is security-relevant); the caller surfaces the 409.
   */
  updateSettings(patch: Record<string, string>): Promise<CoreResult<unknown>>;

  // ── Goals ─────────────────────────────────────────────────────────────────
  // Reads go straight to Core. Every mutation is an OWNER call: it is performed
  // by the Rust side with the install's host token, because the Core refuses an
  // unattested caller on anything that changes what KAI is authorized to do.
  listGoals(): Promise<CoreResult<CoreGoalSummary[]>>;
  getGoal(id: string): Promise<CoreResult<CoreGoalSummary>>;
  createGoal(intent: string, options?: { constraints?: string[]; forbiddenOutcomes?: string[] }): Promise<CoreResult<CoreGoalSummary>>;
  challengeGoal(id: string, mode: "QUICK" | "DEEP"): Promise<CoreResult<CoreGoalSummary>>;
  planGoal(id: string): Promise<CoreResult<CoreGoalSummary>>;
  approvePlan(id: string, revisionId?: string): Promise<CoreResult<CoreGoalSummary>>;
  rejectPlan(id: string, note?: string): Promise<CoreResult<CoreGoalSummary>>;
  setGoalState(id: string, state: string): Promise<CoreResult<CoreGoalSummary>>;

  // ── The Doer switch ───────────────────────────────────────────────────────
  getDoer(): Promise<CoreResult<CoreDoerState>>;
  /** OFF applies immediately (authority-reducing); ON is policy-gated. */
  setDoer(state: "ON" | "OFF"): Promise<CoreResult<unknown>>;
  /** `POST /settings/reset` — clear stored keys (all when omitted), revealing the layer below. */
  resetSettings(keys?: string[]): Promise<CoreResult<unknown>>;
  /** `GET /providers` — live provider summaries from the ONE registry. */
  getProviders(): Promise<CoreResult<CoreProviderSummary[]>>;
  /** `GET /providers/:id/test` — a real live probe (CONNECTED or FAILED + reason). */
  testProvider(id: string): Promise<CoreResult<CoreProviderTest>>;
  /** `GET /models` — the live model catalogue per provider. */
  listModels(): Promise<CoreResult<{ id: string; current: boolean; models: { id: string; current: boolean }[]; note?: string }[]>>;
  /**
   * `POST /models/use` — select KAI's model. Parks by default (traffic
   * redirection is security-relevant); approving the parked request switches
   * the model with no restart. Returns the parked approval when held.
   */
  useModel(model: string, approvalId?: string): Promise<CoreResult<unknown>>;
  /** `GET /soul` — KAI's live soul text + version. */
  getSoul(): Promise<CoreResult<CoreSoul>>;
  /**
   * `POST /soul` — replace KAI's soul. Parks by default (security-relevant);
   * a 409 means the write is waiting, not applied.
   */
  setSoul(soul: string): Promise<CoreResult<unknown>>;
  /**
   * `POST /chat` — one turn to KAI. The wire contract is `{ text }` plus an
   * OPTIONAL `conversation_id`: pass it to keep the turn on a chosen KAI
   * session instead of Core's active one. (`session_id` is never sent here —
   * on Core it names the WORKER session override.)
   */
  chat(text: string, forSessionId?: string): Promise<CoreResult<CoreChatAnswer>>;
  /**
   * `POST /chat/stream` — one turn with live deltas + real tool-lifecycle
   * events (`tool_event` frames carry the brain's actual executions, result
   * values stripped). The resolved turn is the same record `/chat` would
   * persist; only the delivery is incremental.
   */
  chatStream(
    text: string,
    forSessionId: string | undefined,
    handlers: {
      onDelta?(text: string): void;
      onToolEvent?(event: CoreToolEvent): void;
      /** External STOP: aborting it cancels this stream (the reader sees abort). */
      signal?: AbortSignal;
    },
  ): Promise<CoreResult<CoreStreamedTurn>>;
  /**
   * `POST /visual/compile` — raw dialect text (model output) → a VALIDATED,
   * bounded visual intent, or a typed refusal. This is the ONLY path by which a
   * model's text may reach the visual renderer: it always passes the Core's
   * validator first. A 400 is returned as an `ok: true` {@link CoreVisualCompileResponse}
   * with `ok: false`, because a refusal is a legitimate answer, not a transport fault.
   */
  visualCompile(source: string): Promise<CoreResult<CoreVisualCompileResponse>>;
  /** One cheap liveness probe used by the connection state machine. */
  ping(): Promise<CoreResult<{ ok: boolean }>>;
}

// ── Small defensive readers ─────────────────────────────────────────────────

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function ok<T>(value: T): CoreResult<T> {
  return { ok: true, value };
}

/** One worker's reachability as Core's own probe reported it. */
export interface CoreWorkerProbe {
  reachable: boolean;
  authorized?: boolean;
  reason?: string;
}

export interface CoreWorkerHealth {
  hermes?: CoreWorkerProbe;
  opencode?: CoreWorkerProbe;
}

function parseProbe(raw: unknown): CoreWorkerProbe | undefined {
  if (!isObject(raw)) return undefined;
  const reachable = asBoolean(raw["reachable"]);
  if (reachable === undefined) return undefined;
  const probe: CoreWorkerProbe = { reachable };
  const authorized = asBoolean(raw["authorized"]);
  if (authorized !== undefined) probe.authorized = authorized;
  const reason = asString(raw["reason"]);
  if (reason !== undefined && reason.length > 0) probe.reason = reason;
  return probe;
}

function parseWorkerHealth(raw: unknown): CoreWorkerHealth | undefined {
  if (!isObject(raw)) return undefined;
  const out: CoreWorkerHealth = {};
  const hermes = parseProbe(raw["hermes"]);
  if (hermes !== undefined) out.hermes = hermes;
  const opencode = parseProbe(raw["opencode"]);
  if (opencode !== undefined) out.opencode = opencode;
  return out.hermes !== undefined || out.opencode !== undefined ? out : undefined;
}

function fail<T>(
  code: CoreErrorCode,
  message: string,
  status?: number,
  reason?: string,
  errorCode?: string,
): CoreResult<T> {
  const error: CoreError = { code, message };
  if (status !== undefined) error.status = status;
  if (reason !== undefined) error.reason = reason;
  if (errorCode !== undefined) error.errorCode = errorCode;
  return { ok: false, error };
}

/** Short, safe description of a thrown value — never the raw body. */
function describeThrown(err: unknown): string {
  if (err instanceof Error && typeof err.message === "string" && err.message !== "") {
    return err.message.slice(0, 200);
  }
  return "unknown error";
}

function isAbortError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const name = (err as { name?: unknown }).name;
  return name === "AbortError";
}

/** Pull `reason` / `error` out of an error body without echoing the whole thing. */
function extractReason(bodyText: string): string | undefined {
  if (bodyText === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return undefined;
  }
  if (!isObject(parsed)) return undefined;
  const reason = asString(parsed.reason);
  if (reason !== undefined) return reason;
  const error = asString(parsed.error);
  if (error !== undefined) return error;
  return undefined;
}

/** Pull Core's machine-readable `code` out of an error body, when present. */
function extractErrorCode(bodyText: string): string | undefined {
  if (bodyText === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return undefined;
  }
  if (!isObject(parsed)) return undefined;
  return asString(parsed.code);
}

async function readBodyText(res: Response): Promise<string> {
  try {
    if (typeof res.text !== "function") return "";
    return await res.text();
  } catch {
    return "";
  }
}

/** Parse a 2xx body: must be a JSON *object*, else INVALID_RESPONSE. */
function parseJsonObject(bodyText: string): CoreResult<JsonObject> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return fail("INVALID_RESPONSE", "response body was not JSON");
  }
  if (!isObject(parsed)) {
    return fail("INVALID_RESPONSE", "response body was not a JSON object");
  }
  return ok(parsed);
}

// ── Entity parsers ──────────────────────────────────────────────────────────
// A record that is missing one of its *required* fields is dropped rather than
// filled in with a guessed value.

function parseAgent(raw: unknown): CoreAgentSummary | null {
  if (!isObject(raw)) return null;
  const id = asString(raw.id);
  const state = asString(raw.state);
  if (id === undefined || state === undefined) return null;
  const out: CoreAgentSummary = { id, state };
  const detail = asString(raw.detail);
  if (detail !== undefined) out.detail = detail;
  const lastActivity = asString(raw.lastActivity);
  if (lastActivity !== undefined) out.lastActivity = lastActivity;
  const h = raw.health;
  if (isObject(h) && typeof h.ok === "boolean") {
    const health: NonNullable<CoreAgentSummary["health"]> = { ok: h.ok };
    const latencyMs = asNumber(h.latencyMs);
    if (latencyMs !== undefined) health.latencyMs = latencyMs;
    const endpoint = asString(h.endpoint);
    if (endpoint !== undefined) health.endpoint = endpoint;
    const version = asString(h.version);
    if (version !== undefined) health.version = version;
    out.health = health;
  }
  return out;
}

function parseMissionStep(raw: unknown): CoreMissionStep | null {
  if (!isObject(raw)) return null;
  const id = asString(raw.id);
  const index = asNumber(raw.index);
  const title = asString(raw.title);
  const kind = asString(raw.kind);
  const status = asString(raw.status);
  if (id === undefined || index === undefined || title === undefined || kind === undefined || status === undefined) {
    return null;
  }
  const out: CoreMissionStep = { id, index, title, kind, status };
  const e = raw.error;
  if (isObject(e)) {
    const code = asString(e.code);
    const message = asString(e.message);
    if (code !== undefined && message !== undefined) out.error = { code, message };
  }
  return out;
}

function parseMission(raw: unknown): CoreMissionSummary | null {
  if (!isObject(raw)) return null;
  const id = asString(raw.id);
  const title = asString(raw.title);
  const status = asString(raw.status);
  const createdAt = asString(raw.createdAt);
  const updatedAt = asString(raw.updatedAt);
  if (id === undefined || title === undefined || status === undefined || createdAt === undefined || updatedAt === undefined) {
    return null;
  }
  const out: CoreMissionSummary = { id, title, status, createdAt, updatedAt };
  if (Array.isArray(raw.steps)) {
    const steps: CoreMissionStep[] = [];
    for (const s of raw.steps) {
      const parsed = parseMissionStep(s);
      if (parsed !== null) steps.push(parsed);
    }
    out.steps = steps;
  }
  const description = asString(raw.description);
  if (description !== undefined) out.description = description;
  return out;
}

function parseWorkItem(raw: unknown): CoreWorkItemSummary | null {
  if (!isObject(raw)) return null;
  const id = asString(raw.id);
  const state = asString(raw.state);
  if (id === undefined || state === undefined) return null;
  const out: CoreWorkItemSummary = { id, state };
  for (const k of [
    "objective", "deliverable", "workerId", "missionId", "taskId", "createdAt", "updatedAt",
    // The goal linkage (schema v5): a work item created from an approved plan.
    "goalId", "goalRevisionId",
  ] as const) {
    const v = asString(raw[k]);
    if (v !== undefined) out[k] = v;
  }
  for (const k of ["criteria", "requiredEvidence"] as const) {
    const v = raw[k];
    if (Array.isArray(v) && v.every((e) => typeof e === "string")) out[k] = v;
  }
  // Evidence records carry the trust split: a `worker-reported` claim must stay
  // distinguishable from a `kai-observed` fact all the way to the UI.
  const evidence = raw.evidence;
  if (Array.isArray(evidence)) {
    const records: NonNullable<CoreWorkItemSummary["evidence"]> = [];
    for (const entry of evidence) {
      if (!isObject(entry)) continue;
      const id = asString(entry.id);
      const kind = asString(entry.kind);
      const source = asString(entry.source);
      const detail = asString(entry.detail);
      if (id === undefined || kind === undefined || source === undefined || detail === undefined) continue;
      const supports = Array.isArray(entry.supports) && entry.supports.every((e) => typeof e === "string") ? entry.supports : [];
      const at = asString(entry.at);
      records.push({ id, kind, source, detail, supports, ...(at !== undefined ? { at } : {}) });
    }
    if (records.length > 0) out.evidence = records;
  }
  for (const k of ["valueScore", "attempts", "retries", "tokensIn", "tokensOut", "latencyMs"] as const) {
    const v = asNumber(raw[k]);
    if (v !== undefined) out[k] = v;
  }
  const cost = raw.cost;
  if (isObject(cost)) {
    const c: NonNullable<CoreWorkItemSummary["cost"]> = {};
    for (const k of ["tokensIn", "tokensOut", "toolCalls", "costUsd", "latencyMs"] as const) {
      const v = asNumber(cost[k]);
      if (v !== undefined) c[k] = v;
    }
    if (Object.keys(c).length > 0) out.cost = c;
  }
  const review = raw.review;
  if (isObject(review)) {
    const r: NonNullable<CoreWorkItemSummary["review"]> = {};
    const reviewerId = asString(review.reviewerId);
    if (reviewerId !== undefined) r.reviewerId = reviewerId;
    const verdict = asString(review.verdict);
    if (verdict !== undefined) r.verdict = verdict;
    const at = asString(review.at);
    if (at !== undefined) r.at = at;
    if (Array.isArray(review.criteria)) {
      const criteria = asStringArray(review.criteria);
      if (criteria.length > 0) r.criteria = criteria;
    }
    if (Array.isArray(review.findings)) {
      const findings = asStringArray(review.findings);
      if (findings.length > 0) r.findings = findings;
    }
    if (Object.keys(r).length > 0) out.review = r;
  }
  const verification = raw.verification;
  if (isObject(verification)) {
    const v: NonNullable<CoreWorkItemSummary["verification"]> = {};
    if (typeof verification.passed === "boolean") v.passed = verification.passed;
    const at = asString(verification.at);
    if (at !== undefined) v.at = at;
    if (Array.isArray(verification.criteria)) {
      const criteria: NonNullable<NonNullable<CoreWorkItemSummary["verification"]>["criteria"]> = [];
      for (const entry of verification.criteria) {
        if (!isObject(entry)) continue;
        const name = asString(entry.name);
        const met = asBoolean(entry.met);
        if (name === undefined || met === undefined) continue;
        const row: { name: string; met: boolean; detail?: string } = { name, met };
        const detail = asString(entry.detail);
        if (detail !== undefined) row.detail = detail;
        criteria.push(row);
      }
      if (criteria.length > 0) v.criteria = criteria;
    }
    if (Object.keys(v).length > 0) out.verification = v;
  }
  const handoff = raw.handoff;
  if (isObject(handoff)) {
    const hf: NonNullable<CoreWorkItemSummary["handoff"]> = {};
    for (const k of ["status", "result", "tests"] as const) {
      const v = asString(handoff[k]);
      if (v !== undefined) hf[k] = v;
    }
    for (const k of ["evidence", "blockers", "risks", "followUps"] as const) {
      if (Array.isArray(handoff[k])) {
        const list = asStringArray(handoff[k]);
        if (list.length > 0) hf[k] = list;
      }
    }
    if (Object.keys(hf).length > 0) out.handoff = hf;
  }
  return out;
}

function parseActivityEvent(raw: unknown): CoreActivityEvent | null {
  if (!isObject(raw)) return null;
  const kind = asString(raw.kind);
  const label = asString(raw.label);
  if (kind === undefined || label === undefined) return null;
  const out: CoreActivityEvent = { seq: asNumber(raw.seq) ?? 0, kind, label, at: asString(raw.at) ?? "" };
  const detail = asString(raw.detail);
  if (detail !== undefined) out.detail = detail;
  return out;
}

function parseBenchEntry(raw: unknown): CoreBenchEntry | null {
  if (!isObject(raw)) return null;
  const p = raw.profile;
  if (!isObject(p)) return null;
  const workerId = asString(p.workerId);
  if (workerId === undefined) return null;
  const profile: CoreBenchEntry["profile"] = { workerId };
  const role = asString(p.role);
  if (role !== undefined) profile.role = role;
  const overallValue = asNumber(p.overallValue);
  if (overallValue !== undefined) profile.overallValue = overallValue;
  const overallConfidence = asString(p.overallConfidence);
  if (overallConfidence !== undefined) profile.overallConfidence = overallConfidence;
  const totalSamples = asNumber(p.totalSamples);
  if (totalSamples !== undefined) profile.totalSamples = totalSamples;
  const updatedAt = asString(p.updatedAt);
  if (updatedAt !== undefined) profile.updatedAt = updatedAt;
  const recent: CoreBenchDomain[] = [];
  if (Array.isArray(raw.recent)) {
    for (const r of raw.recent) {
      if (!isObject(r)) continue;
      const domain = asString(r.domain);
      const stats = r.stats;
      if (domain === undefined || !isObject(stats)) continue;
      recent.push({
        domain,
        quality: asNumber(stats.quality) ?? 0,
        verification: asNumber(stats.verification) ?? 0,
        samples: asNumber(stats.samples) ?? 0,
        confidence: asString(stats.confidence) ?? "low",
        trend: asString(stats.trend) ?? "flat",
      });
    }
  }
  return { profile, recent };
}

/** The orchestration block rides `GET /settings` — taken as-is, never defaulted. */
function parseOrchestration(raw: unknown): CoreOrchestrationPrefs | undefined {
  if (!isObject(raw)) return undefined;
  const out: CoreOrchestrationPrefs = {};
  if (isObject(raw.autonomy)) out.autonomy = raw.autonomy;
  for (const k of ["activity", "reasoning", "toolsView", "agentsView"] as const) {
    const v = asString(raw[k]);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function parseNotification(raw: unknown): CoreNotificationSummary | null {
  if (!isObject(raw)) return null;
  const id = asString(raw.id);
  const type = asString(raw.type);
  const title = asString(raw.title);
  const priority = asString(raw.priority);
  const read = asBoolean(raw.read);
  const createdAt = asString(raw.createdAt);
  if (id === undefined || type === undefined || title === undefined || priority === undefined || read === undefined || createdAt === undefined) {
    return null;
  }
  const out: CoreNotificationSummary = { id, type, title, priority, read, createdAt };
  const message = asString(raw.message);
  if (message !== undefined) out.message = message;
  return out;
}

function parseApproval(raw: unknown): CoreApprovalSummary | null {
  if (!isObject(raw)) return null;
  const id = asString(raw.id);
  const toolId = asString(raw.toolId);
  const action = asString(raw.action);
  const reason = asString(raw.reason);
  const risk = asString(raw.risk);
  const status = asString(raw.status);
  const createdAt = asString(raw.createdAt);
  if (id === undefined || toolId === undefined || action === undefined || reason === undefined || risk === undefined || status === undefined || createdAt === undefined) {
    return null;
  }
  const out: CoreApprovalSummary = { id, toolId, action, reason, risk, status, createdAt };
  const missionId = asString(raw.missionId);
  if (missionId !== undefined) out.missionId = missionId;
  return out;
}

function parseDigest(raw: unknown): CoreSessionDigest | null {
  if (!isObject(raw)) return null;
  const objective = asString(raw.objective);
  const lastAssistantLine = asString(raw.lastAssistantLine);
  const builtAt = asString(raw.builtAt);
  if (objective === undefined || lastAssistantLine === undefined || builtAt === undefined) return null;
  const out: CoreSessionDigest = {
    objective,
    files: asStringArray(raw.files),
    toolsUsed: asStringArray(raw.toolsUsed),
    toolStats: {
      total: asNumber((raw.toolStats as Record<string, unknown> | undefined)?.total) ?? 0,
      executed: asNumber((raw.toolStats as Record<string, unknown> | undefined)?.executed) ?? 0,
    },
    lastAssistantLine,
    builtAt,
  };
  const narrative = asString(raw.narrative);
  if (narrative !== undefined) out.narrative = narrative;
  return out;
}

function parseToolCall(raw: unknown): CoreToolCall | null {
  if (!isObject(raw)) return null;
  const id = asString(raw.id);
  const toolCallId = asString(raw.toolCallId);
  const toolName = asString(raw.toolName);
  const args = asString(raw.arguments);
  const status = asString(raw.status);
  const startedAt = asString(raw.startedAt);
  const completedAt = asString(raw.completedAt);
  if (
    id === undefined || toolCallId === undefined || toolName === undefined || args === undefined ||
    status === undefined || startedAt === undefined || completedAt === undefined
  ) {
    return null;
  }
  const out: CoreToolCall = { id, toolCallId, toolName, arguments: args, status, startedAt, completedAt };
  const toolId = asString(raw.toolId);
  if (toolId !== undefined) out.toolId = toolId;
  const invocationId = asString(raw.invocationId);
  if (invocationId !== undefined) out.invocationId = invocationId;
  if (raw.result !== undefined) out.result = raw.result;
  const approvalId = asString(raw.approvalId);
  if (approvalId !== undefined) out.approvalId = approvalId;
  return out;
}

function parseSession(raw: unknown): CoreSessionSummary | null {
  if (!isObject(raw)) return null;
  const id = asString(raw.id);
  const title = asString(raw.title);
  const status = asString(raw.status);
  const createdAt = asString(raw.createdAt);
  const updatedAt = asString(raw.updatedAt);
  if (id === undefined || title === undefined || status === undefined || createdAt === undefined || updatedAt === undefined) {
    return null;
  }
  const out: CoreSessionSummary = { id, title, status, createdAt, updatedAt };
  const lastTurnAt = asString(raw.lastTurnAt);
  if (lastTurnAt !== undefined) out.lastTurnAt = lastTurnAt;
  const turnCount = asNumber(raw.turnCount);
  if (turnCount !== undefined) out.turnCount = turnCount;
  const agentId = asString(raw.agentId);
  if (agentId !== undefined) out.agentId = agentId;
  const agentSessionId = asString(raw.agentSessionId);
  if (agentSessionId !== undefined) out.agentSessionId = agentSessionId;
  const sessionKind = asString(raw.sessionKind);
  if (sessionKind !== undefined) out.sessionKind = sessionKind;
  // A session without turns yet has no digest — absence is honest, not an error.
  const digest = parseDigest(raw.summary);
  if (digest !== null) out.summary = digest;
  return out;
}

function parseMemoryEntry(raw: unknown): CoreMemoryEntry | null {
  if (!isObject(raw)) return null;
  const id = asString(raw.id);
  const content = asString(raw.content);
  const type = asString(raw.type);
  const provenance = asString(raw.provenance);
  const source = asString(raw.source);
  const scope = asString(raw.scope);
  const scopeId = asString(raw.scopeId);
  const createdAt = asString(raw.createdAt);
  const updatedAt = asString(raw.updatedAt);
  if (
    id === undefined || content === undefined || type === undefined || provenance === undefined ||
    source === undefined || scope === undefined || scopeId === undefined ||
    createdAt === undefined || updatedAt === undefined
  ) {
    return null;
  }
  const out: CoreMemoryEntry = {
    id, content, type, provenance, source, scope, scopeId, createdAt, updatedAt,
    importance: asNumber(raw.importance) ?? 1,
    confidence: typeof raw.confidence === "number" ? raw.confidence : 1,
  };
  return out;
}

function parseSkill(raw: unknown): CoreSkillSummary | null {
  if (!isObject(raw)) return null;
  const id = asString(raw.id);
  const name = asString(raw.name);
  const description = asString(raw.description);
  const source = asString(raw.source);
  const contentHash = asString(raw.contentHash);
  const status = asString(raw.status);
  const installedAt = asString(raw.installedAt);
  const updatedAt = asString(raw.updatedAt);
  if (
    id === undefined || name === undefined || description === undefined || source === undefined ||
    contentHash === undefined || updatedAt === undefined || installedAt === undefined ||
    (status !== "enabled" && status !== "disabled")
  ) {
    return null;
  }
  const out: CoreSkillSummary = {
    id, name, description, source, contentHash, status, installedAt, updatedAt,
    tags: asStringArray(raw.tags),
    revision: asNumber(raw.revision) ?? 1,
    revisionCount: asNumber(raw.revisionCount) ?? 1,
  };
  const purpose = asString(raw.purpose);
  if (purpose !== undefined) out.purpose = purpose;
  if (Array.isArray(raw.tools)) {
    const tools = asStringArray(raw.tools);
    if (tools.length > 0) out.tools = tools;
  }
  if (Array.isArray(raw.constraints)) {
    const constraints = asStringArray(raw.constraints);
    if (constraints.length > 0) out.constraints = constraints;
  }
  const version = asString(raw.version);
  if (version !== undefined) out.version = version;
  return out;
}

function parseStagedSkill(raw: unknown): CoreStagedSkill | null {
  if (!isObject(raw)) return null;
  const stagedId = asString(raw.stagedId);
  const skillId = asString(raw.skillId);
  const sha256 = asString(raw.sha256);
  const source = asString(raw.source);
  const stagedAt = asString(raw.stagedAt);
  const expiresAt = asString(raw.expiresAt);
  const name = asString(raw.name);
  const description = asString(raw.description);
  if (
    stagedId === undefined || skillId === undefined || sha256 === undefined || source === undefined ||
    stagedAt === undefined || expiresAt === undefined || name === undefined || description === undefined
  ) {
    return null;
  }
  const out: CoreStagedSkill = {
    stagedId, skillId, sha256, source, stagedAt, expiresAt, name, description,
    tags: asStringArray(raw.tags),
  };
  const approvalId = asString(raw.approvalId);
  if (approvalId !== undefined) out.approvalId = approvalId;
  return out;
}

function parseTurn(raw: unknown): CoreSessionTurn | null {
  if (!isObject(raw)) return null;
  const id = asString(raw.id);
  const role = asString(raw.role);
  const text = asString(raw.text);
  const at = asString(raw.at);
  if (id === undefined || role === undefined || text === undefined || at === undefined) {
    return null;
  }
  const out: CoreSessionTurn = { id, role, text, at };
  const agentId = asString(raw.agentId);
  if (agentId !== undefined) out.agentId = agentId;
  // Tool history rides on the turn; a malformed entry is dropped, never fatal.
  if (Array.isArray(raw.tools)) {
    const tools = parseArray(raw.tools, parseToolCall);
    if (tools.length > 0) out.tools = tools;
  }
  return out;
}

function asStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    const s = asString(item);
    if (s !== undefined) out.push(s);
  }
  return out;
}

function parseSubagent(raw: unknown): CoreSubagentSummary | null {
  if (!isObject(raw)) return null;
  const id = asString(raw.id);
  const name = asString(raw.name);
  const role = asString(raw.role);
  const soul = asString(raw.soul);
  const workerId = asString(raw.workerId);
  const employeeId = asString(raw.employeeId);
  const status = asString(raw.status);
  const enabled = asBoolean(raw.enabled);
  if (
    id === undefined || name === undefined || role === undefined || soul === undefined ||
    workerId === undefined || employeeId === undefined || status === undefined || enabled === undefined
  ) {
    return null;
  }
  const out: CoreSubagentSummary = {
    id, name, role, soul, workerId, employeeId, status, enabled,
    capabilities: asStringArray(raw.capabilities),
    problems: asStringArray(raw.problems),
    createdAt: asString(raw.createdAt) ?? "",
  };
  const model = asString(raw.model);
  if (model !== undefined) out.model = model;
  const instanceId = asString(raw.instanceId);
  if (instanceId !== undefined) out.instanceId = instanceId;
  const v = raw.visual;
  if (isObject(v)) {
    const visual: NonNullable<CoreSubagentSummary["visual"]> = {};
    if (isObject(v.declared)) visual.declared = v.declared;
    if (v.resolved !== undefined) visual.resolved = v.resolved;
    out.visual = visual;
  }
  return out;
}

function parseSubagentSession(raw: unknown): CoreSubagentSessionSummary | null {
  if (!isObject(raw)) return null;
  const id = asString(raw.id);
  const title = asString(raw.title);
  const status = asString(raw.status);
  if (id === undefined || title === undefined || status === undefined) return null;
  const out: CoreSubagentSessionSummary = { id, title, status };
  const updatedAt = asString(raw.updatedAt);
  if (updatedAt !== undefined) out.updatedAt = updatedAt;
  const turnCount = asNumber(raw.turnCount);
  if (turnCount !== undefined) out.turnCount = turnCount;
  const agentId = asString(raw.agentId);
  if (agentId !== undefined) out.agentId = agentId;
  const agentSessionId = asString(raw.agentSessionId);
  if (agentSessionId !== undefined) out.agentSessionId = agentSessionId;
  return out;
}

function parseArray<T>(raw: unknown, parse: (item: unknown) => T | null): T[] {
  const out: T[] = [];
  if (!Array.isArray(raw)) return out;
  for (const item of raw) {
    const parsed = parse(item);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}

export function createCoreClient(options: CoreClientOptions = {}): CoreClient {
  const baseUrl = (options.baseUrl ?? DEFAULT_CORE_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? 5000;
  const injectedFetch = options.fetchImpl;

  function resolveFetch(): typeof fetch | undefined {
    if (typeof injectedFetch === "function") return injectedFetch;
    if (typeof fetch === "function") return fetch;
    return undefined;
  }

  function buildUrl(path: string, query?: Record<string, string | number | boolean | undefined>): string {
    let url = `${baseUrl}${path}`;
    if (query !== undefined) {
      const parts: string[] = [];
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined) continue;
        parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
      }
      if (parts.length > 0) url += `?${parts.join("&")}`;
    }
    return url;
  }

  /**
   * The single transport primitive. Every branch below returns a CoreResult so a
   * caller can never observe a rejection. The abort timer is armed before fetch
   * and cleared in `finally`, covering the body read as well.
   */
  /**
   * A request that changes what KAI is AUTHORIZED to do.
   *
   * The Core's owner-only routes refuse a caller that cannot prove it holds the
   * install's host token. That token is never exposed to JavaScript, so the
   * request is handed to the Rust side, which attaches it and returns only the
   * response. Outside Tauri there is no credential to attach, so the call falls
   * through to a plain request and the Core's 401 is surfaced honestly as
   * AUTH_REQUIRED — never faked into a success.
   */
  async function ownerRequest(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<CoreResult<JsonObject>> {
    const bridged = await Bridge.coreOwnerCall(method, path, body);
    if (bridged !== null) {
      const payload = isObject(bridged.body) ? bridged.body : {};
      if (bridged.status >= 200 && bridged.status < 300) return ok(payload);
      if (bridged.status === 401 || bridged.status === 403) {
        return fail("AUTH_REQUIRED", "Core requires the owner credential for this control", bridged.status);
      }
      const reason = typeof payload["reason"] === "string" ? payload["reason"] : "Core refused the request";
      return fail("REQUEST_FAILED", reason, bridged.status);
    }
    return request(path, { method, ...(body !== undefined ? { body } : {}) });
  }

  async function request(
    path: string,
    init: { method?: string; body?: unknown; query?: Record<string, string | number | boolean | undefined> } = {},
  ): Promise<CoreResult<JsonObject>> {
    const doFetch = resolveFetch();
    if (doFetch === undefined) {
      return fail("CORE_OFFLINE", "no fetch implementation available");
    }

    const url = buildUrl(path, init.query);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const requestInit: RequestInit = {
        method: init.method ?? "GET",
        signal: controller.signal,
      };
      if (init.body !== undefined) {
        requestInit.body = JSON.stringify(init.body);
        requestInit.headers = { "content-type": "application/json" };
      }

      const res = await doFetch(url, requestInit);

      if (!res.ok) {
        const status = typeof res.status === "number" ? res.status : undefined;
        if (status === 401 || status === 403) {
          return fail("AUTH_REQUIRED", "Core requires authentication", status);
        }
        const bodyText = await readBodyText(res);
        const reason = extractReason(bodyText);
        const errorCode = extractErrorCode(bodyText);
        const message = reason !== undefined ? `Core request failed: ${reason}` : "Core request failed";
        return fail("REQUEST_FAILED", message, status, reason, errorCode);
      }

      const bodyText = await readBodyText(res);
      return parseJsonObject(bodyText);
    } catch (err) {
      if (controller.signal.aborted || isAbortError(err)) {
        return fail("TIMEOUT", `Core request timed out after ${timeoutMs}ms`);
      }
      if (err instanceof TypeError) {
        return fail("CORE_OFFLINE", "Core is not reachable");
      }
      return fail("UNKNOWN", describeThrown(err));
    } finally {
      clearTimeout(timer);
    }
  }

  async function listAt(
    path: string,
    key: string,
    parse: (item: unknown) => unknown,
    init: { query?: Record<string, string | number | boolean | undefined> } = {},
  ): Promise<CoreResult<unknown[]>> {
    const res = await request(path, init);
    if (!res.ok) return res;
    const raw = res.value[key];
    if (!Array.isArray(raw)) {
      return fail("INVALID_RESPONSE", `expected an array at "${key}"`);
    }
    return ok(parseArray(raw, parse));
  }

  /** Unwrap `{mission: ...}` / `{approval: ...}` or accept the object directly. */
  function unwrap(value: JsonObject, key: string): JsonObject | null {
    const inner = value[key];
    if (isObject(inner)) return inner;
    return value;
  }

  return {
    baseUrl,

    async health() {
      const res = await request("/health");
      if (!res.ok) return res;
      const status = asString(res.value.status);
      if (status === undefined) {
        return fail("INVALID_RESPONSE", "health response had no status");
      }
      const out: { status: string; version?: string; workers?: CoreWorkerHealth } = { status };
      const version = asString(res.value.version);
      if (version !== undefined) out.version = version;
      // Worker reachability, straight from Core's own probes — the header
      // renders THIS, never a guess. Absent fields stay absent, not "online".
      const workers = parseWorkerHealth(res.value);
      if (workers !== undefined) out.workers = workers;
      return ok(out);
    },

    async state() {
      const res = await request("/state");
      if (!res.ok) return res;
      const v = res.value;
      const out: CoreStateSummary = {
        agents: parseArray(v.agents, parseAgent),
      };
      const okFlag = asBoolean(v.ok);
      if (okFlag !== undefined) out.ok = okFlag;
      const startedAt = asString(v.startedAt);
      if (startedAt !== undefined) out.startedAt = startedAt;
      const uptimeMs = asNumber(v.uptimeMs);
      if (uptimeMs !== undefined) out.uptimeMs = uptimeMs;

      const db = v.database;
      if (isObject(db)) {
        const path = asString(db.path);
        out.database = path !== undefined ? { path } : {};
      }

      const missions = v.missions;
      if (isObject(missions)) {
        const m: NonNullable<CoreStateSummary["missions"]> = {};
        const active = asNumber(missions.active);
        if (active !== undefined) m.active = active;
        const unfinished = asNumber(missions.unfinished);
        if (unfinished !== undefined) m.unfinished = unfinished;
        out.missions = m;
      }
      const notifications = v.notifications;
      if (isObject(notifications)) {
        const n: NonNullable<CoreStateSummary["notifications"]> = {};
        const unread = asNumber(notifications.unread);
        if (unread !== undefined) n.unread = unread;
        out.notifications = n;
      }
      const approvals = v.approvals;
      if (isObject(approvals)) {
        const a: NonNullable<CoreStateSummary["approvals"]> = {};
        const pending = asNumber(approvals.pending);
        if (pending !== undefined) a.pending = pending;
        out.approvals = a;
      }
      const scheduler = v.scheduler;
      if (isObject(scheduler)) {
        const s: NonNullable<CoreStateSummary["scheduler"]> = {};
        const running = asBoolean(scheduler.running);
        if (running !== undefined) s.running = running;
        const enabled = asNumber(scheduler.enabled);
        if (enabled !== undefined) s.enabled = enabled;
        const total = asNumber(scheduler.total);
        if (total !== undefined) s.total = total;
        out.scheduler = s;
      }
      const tools = v.tools;
      if (isObject(tools)) {
        const t: NonNullable<CoreStateSummary["tools"]> = {};
        const registered = asNumber(tools.registered);
        if (registered !== undefined) t.registered = registered;
        out.tools = t;
      }
      return ok(out);
    },

    async agents(): Promise<CoreResult<CoreAgentSummary[]>> {
      const res = await listAt("/agents", "agents", parseAgent);
      if (!res.ok) return res;
      return ok(res.value as CoreAgentSummary[]);
    },

    async agent(id) {
      const res = await request(`/agents/${encodeURIComponent(id)}`);
      if (!res.ok) return res;
      const parsed = parseAgent(unwrap(res.value, "agent"));
      if (parsed === null) return fail("INVALID_RESPONSE", "agent response was not an agent");
      return ok(parsed);
    },

    async missions(opts) {
      const res = await listAt("/missions", "missions", parseMission, {
        query: { status: opts?.status, limit: opts?.limit },
      });
      if (!res.ok) return res;
      return ok(res.value as CoreMissionSummary[]);
    },

    async createMission(input) {
      const body: JsonObject = { title: input.title };
      if (input.description !== undefined) body.description = input.description;
      if (input.steps !== undefined) body.steps = input.steps;
      const res = await request("/missions", { method: "POST", body });
      if (!res.ok) return res;
      const parsed = parseMission(unwrap(res.value, "mission"));
      if (parsed === null) return fail("INVALID_RESPONSE", "create-mission response was not a mission");
      return ok(parsed);
    },

    async cancelMission(id) {
      const res = await request(`/missions/${encodeURIComponent(id)}/cancel`, { method: "POST" });
      if (!res.ok) return res;
      const parsed = parseMission(unwrap(res.value, "mission"));
      if (parsed === null) return fail("INVALID_RESPONSE", "cancel-mission response was not a mission");
      return ok(parsed);
    },

    async startMission(id) {
      const res = await request(`/missions/${encodeURIComponent(id)}/start`, { method: "POST" });
      if (!res.ok) return res;
      const parsed = parseMission(unwrap(res.value, "mission"));
      if (parsed === null) return fail("INVALID_RESPONSE", "start-mission response was not a mission");
      return ok(parsed);
    },

    async createPlan(goal) {
      const res = await request("/plans", { method: "POST", body: { goal } });
      if (!res.ok) return res;
      const parsed = parseMission(unwrap(res.value, "mission"));
      if (parsed === null) return fail("INVALID_RESPONSE", "plan response was not a mission");
      return ok(parsed);
    },

    async notifications(opts) {
      const res = await listAt("/notifications", "notifications", parseNotification, {
        query: { unreadOnly: opts?.unreadOnly, limit: opts?.limit },
      });
      if (!res.ok) return res;
      return ok(res.value as CoreNotificationSummary[]);
    },

    async markNotificationRead(id) {
      const res = await request(`/notifications/${encodeURIComponent(id)}/read`, { method: "POST" });
      if (!res.ok) return res;
      return ok(res.value as unknown);
    },

    async approvals(opts) {
      const res = await listAt("/approvals", "approvals", parseApproval, {
        query: { status: opts?.status },
      });
      if (!res.ok) return res;
      return ok(res.value as CoreApprovalSummary[]);
    },

    async decideApproval(id, approved) {
      const res = await request(`/approvals/${encodeURIComponent(id)}/decide`, {
        method: "POST",
        body: { approved },
      });
      if (!res.ok) return res;
      const parsed = parseApproval(unwrap(res.value, "approval"));
      if (parsed === null) return fail("INVALID_RESPONSE", "decide-approval response was not an approval");
      return ok(parsed);
    },

    async sessions(opts) {
      // Not `listAt`: the body also carries `activeSessionId`, which is part of
      // what the view must show, so both are read in one place.
      const res = await request("/sessions", {
        query: {
          status: opts?.status,
          limit: opts?.limit,
          ...(opts?.includeArchived !== undefined ? { includeArchived: opts.includeArchived } : {}),
        },
      });
      if (!res.ok) return res;
      const raw = res.value["sessions"];
      if (!Array.isArray(raw)) {
        return fail("INVALID_RESPONSE", 'expected an array at "sessions"');
      }
      return ok({
        sessions: parseArray(raw, parseSession),
        activeSessionId: asString(res.value["activeSessionId"]) ?? null,
      });
    },

    async activeSession() {
      const res = await request("/sessions/active");
      if (!res.ok) return res;
      const inner = res.value["session"];
      // No active session is a legitimate answer, not an error.
      if (inner === null || inner === undefined) return ok(null);
      const parsed = parseSession(inner);
      if (parsed === null) return fail("INVALID_RESPONSE", "active-session response was not a session");
      return ok(parsed);
    },

    async sessionTurns(id, opts) {
      const res = await request(`/sessions/${encodeURIComponent(id)}/turns`, {
        query: { limit: opts?.limit },
      });
      if (!res.ok) return res;
      const raw = res.value["turns"];
      if (!Array.isArray(raw)) {
        return fail("INVALID_RESPONSE", 'expected an array at "turns"');
      }
      return ok(parseArray(raw, parseTurn));
    },

    async createSession(input) {
      const body: JsonObject = {};
      if (input?.title !== undefined) body.title = input.title;
      const res = await request("/sessions", { method: "POST", body });
      if (!res.ok) return res;
      const parsed = parseSession(unwrap(res.value, "session"));
      if (parsed === null) return fail("INVALID_RESPONSE", "create-session response was not a session");
      return ok(parsed);
    },

    async renameSession(id, title) {
      const res = await request(`/sessions/${encodeURIComponent(id)}/rename`, {
        method: "POST",
        body: { title },
      });
      if (!res.ok) return res;
      const parsed = parseSession(unwrap(res.value, "session"));
      if (parsed === null) return fail("INVALID_RESPONSE", "rename-session response was not a session");
      return ok(parsed);
    },

    async archiveSession(id) {
      const res = await request(`/sessions/${encodeURIComponent(id)}/archive`, { method: "POST" });
      if (!res.ok) return res;
      const parsed = parseSession(unwrap(res.value, "session"));
      if (parsed === null) return fail("INVALID_RESPONSE", "archive-session response was not a session");
      return ok(parsed);
    },

    async unarchiveSession(id) {
      const res = await request(`/sessions/${encodeURIComponent(id)}/unarchive`, { method: "POST" });
      if (!res.ok) return res;
      const parsed = parseSession(unwrap(res.value, "session"));
      if (parsed === null) return fail("INVALID_RESPONSE", "unarchive-session response was not a session");
      return ok(parsed);
    },

    async activateSession(id) {
      const res = await request(`/sessions/${encodeURIComponent(id)}/activate`, { method: "POST" });
      if (!res.ok) return res;
      const parsed = parseSession(unwrap(res.value, "session"));
      if (parsed === null) return fail("INVALID_RESPONSE", "activate-session response was not a session");
      return ok(parsed);
    },

    async subagents(): Promise<CoreResult<CoreSubagentSummary[]>> {
      const res = await listAt("/subagents", "subagents", parseSubagent);
      if (!res.ok) return res;
      return ok(res.value as CoreSubagentSummary[]);
    },

    async subagent(id) {
      const res = await request(`/subagents/${encodeURIComponent(id)}`);
      if (!res.ok) return res;
      const parsed = parseSubagent(res.value["subagent"]);
      if (parsed === null) return fail("INVALID_RESPONSE", "subagent response was not a subagent");
      const rawSessions = res.value["sessions"];
      const sessions = Array.isArray(rawSessions)
        ? parseArray(rawSessions, parseSubagentSession)
        : [];
      return ok({ subagent: parsed, sessions });
    },

    async runSubagent(id, input) {
      const res = await request(`/subagents/${encodeURIComponent(id)}/run`, {
        method: "POST",
        body: { input: input ?? "" },
      });
      if (!res.ok) {
        // 409 = the EXTERNAL run parked for approval. That is the expected outcome,
        // not a failure: the caller re-reads `/approvals` to see the parked run.
        if (res.error.status === 409) {
          return ok({ subagentId: id, parked: true, reason: res.error.reason ?? res.error.message });
        }
        return res;
      }
      return ok(res.value);
    },

    async memory(opts) {
      const res = await listAt("/memory", "memories", (item) => item, {
        query: { type: opts?.type, limit: opts?.limit },
      });
      if (!res.ok) return res;
      return ok(res.value as unknown[]);
    },

    async remember(input) {
      const body: JsonObject = { type: input.type, content: input.content };
      if (input.importance !== undefined) body.importance = input.importance;
      const res = await request("/memory", { method: "POST", body });
      if (!res.ok) return res;
      return ok(res.value as unknown);
    },

    async commands(): Promise<CoreResult<CoreCommandSummary[]>> {
      const res = await request("/commands");
      if (!res.ok) return res;
      const raw = res.value["commands"];
      if (!Array.isArray(raw)) return fail("INVALID_RESPONSE", 'expected an array at "commands"');
      const out: CoreCommandSummary[] = [];
      for (const item of raw) {
        if (!isObject(item)) continue;
        const id = asString(item.id);
        const title = asString(item.title);
        const description = asString(item.description);
        const usage = asString(item.usage);
        if (id === undefined || title === undefined || description === undefined || usage === undefined) continue;
        const outItem: CoreCommandSummary = { id, title, description, usage };
        if (Array.isArray(item.args)) {
          const args: CoreCommandArg[] = [];
          for (const rawArg of item.args) {
            if (!isObject(rawArg)) continue;
            const name = asString(rawArg.name);
            const source = asString(rawArg.source);
            if (name === undefined) continue;
            if (source !== "sessions" && source !== "agents" && source !== "skills" && source !== "mcp" && source !== "free") continue;
            const arg: CoreCommandArg = { name, source };
            const argDescription = asString(rawArg.description);
            if (argDescription !== undefined) arg.description = argDescription;
            args.push(arg);
          }
          if (args.length > 0) outItem.args = args;
        }
        out.push(outItem);
      }
      return ok(out);
    },

    async runCommand(id, args, raw) {
      const res = await request(`/commands/${encodeURIComponent(id)}/run`, {
        method: "POST",
        body: { args: args ?? [], ...(raw !== undefined ? { raw } : {}) },
      });
      if (!res.ok) return res;
      const result = res.value["result"];
      if (!isObject(result)) return fail("INVALID_RESPONSE", "command response had no result");
      const command = asString(result.command);
      const title = asString(result.title);
      const text = asString(result.text);
      if (command === undefined || title === undefined || text === undefined) {
        return fail("INVALID_RESPONSE", "command result was malformed");
      }
      const out: CoreCommandOutcome = { command, title, text };
      if (result.data !== undefined) out.data = result.data;
      return ok(out);
    },

    async searchMemoryEntries(query, opts) {
      const res = await request("/memory/search", {
        query: { q: query, ...(opts?.limit !== undefined ? { limit: opts.limit } : {}) },
      });
      if (!res.ok) return res;
      const raw = res.value["hits"];
      if (!Array.isArray(raw)) return fail("INVALID_RESPONSE", 'expected an array at "hits"');
      // Hits wrap entries (`{ entry, score }`); either shape parses.
      const entries: CoreMemoryEntry[] = [];
      for (const hit of raw) {
        const candidate = isObject(hit) && hit["entry"] !== undefined ? hit["entry"] : hit;
        const parsed = parseMemoryEntry(candidate);
        if (parsed !== null) entries.push(parsed);
      }
      return ok(entries);
    },

    async getMemoryEntry(id) {
      const res = await request(`/memory/${encodeURIComponent(id)}`);
      if (!res.ok) return res;
      const parsed = parseMemoryEntry(res.value["memory"]);
      if (parsed === null) return fail("INVALID_RESPONSE", "memory response was not an entry");
      return ok(parsed);
    },

    async correctMemoryEntry(id, patch) {
      const res = await request(`/memory/${encodeURIComponent(id)}/correct`, { method: "POST", body: { ...patch } });
      if (!res.ok) return res;
      const parsed = parseMemoryEntry(res.value["memory"]);
      if (parsed === null) return fail("INVALID_RESPONSE", "correct response was not an entry");
      return ok(parsed);
    },

    async deleteMemoryEntry(id) {
      const res = await request(`/memory/${encodeURIComponent(id)}/delete`, { method: "POST" });
      if (!res.ok) return res;
      return ok({ deleted: id });
    },

    async getSettings() {
      const res = await request("/settings");
      if (!res.ok) return res;
      const stored = res.value["stored"];
      const effective = res.value["effective"];
      if (!Array.isArray(stored) || !isObject(effective)) {
        return fail("INVALID_RESPONSE", "settings response was malformed");
      }
      const rows: CoreSettingRow[] = [];
      for (const row of stored) {
        if (!isObject(row)) return fail("INVALID_RESPONSE", "settings row was malformed");
        const key = asString(row.key);
        const value = asString(row.value);
        const updatedAt = asString(row.updatedAt);
        if (key === undefined || value === undefined || updatedAt === undefined) {
          return fail("INVALID_RESPONSE", "settings row was malformed");
        }
        rows.push({ key, value, updatedAt });
      }
      const values = effective.values;
      const sources = effective.sources;
      if (!isObject(values) || !isObject(sources)) return fail("INVALID_RESPONSE", "effective settings were malformed");
      const name = asString(values.name);
      const baseUrl = asString(values.baseUrl);
      const apiKeyConfigured = typeof values.apiKeyConfigured === "boolean" ? values.apiKeyConfigured : undefined;
      if (name === undefined || baseUrl === undefined || typeof values.timeoutMs !== "number" || apiKeyConfigured === undefined) {
        return fail("INVALID_RESPONSE", "effective settings were malformed");
      }
      const orchestration = parseOrchestration(res.value["orchestration"]);
      return ok({
        stored: rows,
        effective: {
          values: { name, baseUrl, timeoutMs: values.timeoutMs, apiKeyConfigured },
          sources: {
            name: asString(sources.name) ?? "unknown",
            baseUrl: asString(sources.baseUrl) ?? "unknown",
            timeoutMs: asString(sources.timeoutMs) ?? "unknown",
          },
        },
        ...(orchestration !== undefined ? { orchestration } : {}),
      });
    },

    async getWorkItems(filter) {
      const res = await request("/work-items", {
        query: {
          state: filter?.state,
          mission: filter?.mission,
          task: filter?.task,
          worker: filter?.worker,
          limit: filter?.limit,
        },
      });
      if (!res.ok) return res;
      const raw = res.value["items"];
      if (!Array.isArray(raw)) return fail("INVALID_RESPONSE", 'expected an array at "items"');
      return ok(parseArray(raw, parseWorkItem));
    },

    async getWorkItem(id) {
      const res = await request(`/work-items/${encodeURIComponent(id)}`);
      if (!res.ok) return res;
      const item = parseWorkItem(res.value["item"]);
      if (item === null) return fail("INVALID_RESPONSE", "work-item response had no item");
      const children = Array.isArray(res.value["children"])
        ? parseArray(res.value["children"], parseWorkItem)
        : [];
      const activity = Array.isArray(res.value["activity"])
        ? parseArray(res.value["activity"], parseActivityEvent)
        : [];
      const benchRaw = res.value["benchmark"];
      const benchmark = benchRaw === null || benchRaw === undefined ? null : parseBenchEntry(benchRaw);
      return ok({ item, children, activity, benchmark });
    },

    async startWorkItem(input) {
      const body: JsonObject = { objective: input.objective };
      if (input.deliverable !== undefined) body.deliverable = input.deliverable;
      if (input.constraints !== undefined) body.constraints = input.constraints;
      if (input.successCriteria !== undefined) body.successCriteria = input.successCriteria;
      if (input.risk !== undefined) body.risk = input.risk;
      if (input.taskId !== undefined) body.taskId = input.taskId;
      if (input.missionId !== undefined) body.missionId = input.missionId;
      if (input.subtasks !== undefined) body.subtasks = input.subtasks;
      if (input.skills !== undefined) body.skills = input.skills;
      const res = await request("/work-items", { method: "POST", body });
      if (!res.ok) return res;
      const out: CoreWorkStartOutcome = {
        workItemId: asString(res.value.workItemId) ?? "",
        childIds: asStringArray(res.value.childIds),
        delegated: res.value.delegated === true,
      };
      const note = asString(res.value.note);
      if (note !== undefined) out.note = note;
      if (res.value.decision !== undefined) out.decision = res.value.decision;
      return ok(out);
    },

    async runWorkItem(id, opts) {
      const body: JsonObject = {};
      if (opts?.workerId !== undefined) body.workerId = opts.workerId;
      if (opts?.approvalId !== undefined) body.approvalId = opts.approvalId;
      const res = await request(`/work-items/${encodeURIComponent(id)}/run`, { method: "POST", body });
      if (!res.ok) return res;
      const workItemId = asString(res.value.workItemId);
      const state = asString(res.value.state);
      if (workItemId === undefined || state === undefined) {
        return fail("INVALID_RESPONSE", "run response had no workItemId/state");
      }
      const out: CoreWorkRunOutcome = { workItemId, state };
      const note = asString(res.value.note);
      if (note !== undefined) out.note = note;
      return ok(out);
    },

    async reviewWorkItem(id, criteria) {
      const res = await request(`/work-items/${encodeURIComponent(id)}/review`, {
        method: "POST",
        body: criteria !== undefined ? { criteria } : {},
      });
      if (!res.ok) return res;
      const verdict = asString(res.value.verdict);
      if (verdict === undefined) return fail("INVALID_RESPONSE", "review response had no verdict");
      const out: CoreWorkReviewOutcome = { verdict, findings: asStringArray(res.value.findings) };
      const rounds = asNumber(res.value.rounds);
      if (rounds !== undefined) out.rounds = rounds;
      return ok(out);
    },

    async getBench() {
      const res = await request("/bench");
      if (!res.ok) return res;
      const raw = res.value["workers"];
      if (!Array.isArray(raw)) return fail("INVALID_RESPONSE", 'expected an array at "workers"');
      return ok(parseArray(raw, parseBenchEntry));
    },

    async getActivity(ref, level) {
      const res = await request("/activity", {
        query: { task: ref?.task, work: ref?.work, level },
      });
      if (!res.ok) return res;
      const raw = res.value["events"];
      if (!Array.isArray(raw)) return fail("INVALID_RESPONSE", 'expected an array at "events"');
      return ok(parseArray(raw, parseActivityEvent));
    },

    async updateSettings(patch) {
      const res = await request("/settings", { method: "POST", body: patch });
      if (!res.ok) return res;
      return ok(res.value);
    },

    async listGoals() {
      const res = await request("/goals");
      if (!res.ok) return res;
      const raw = res.value["goals"];
      if (!Array.isArray(raw)) return fail("INVALID_RESPONSE", 'expected an array at "goals"');
      return ok(raw.filter(isObject) as unknown as CoreGoalSummary[]);
    },

    async getGoal(id) {
      const res = await request(`/goals/${encodeURIComponent(id)}`);
      if (!res.ok) return res;
      return ok(res.value as unknown as CoreGoalSummary);
    },

    async createGoal(intent, options) {
      const res = await ownerRequest("POST", "/goals", {
        intent,
        ...(options?.constraints !== undefined ? { constraints: options.constraints } : {}),
        ...(options?.forbiddenOutcomes !== undefined ? { forbiddenOutcomes: options.forbiddenOutcomes } : {}),
      });
      if (!res.ok) return res;
      return ok(res.value as unknown as CoreGoalSummary);
    },

    async challengeGoal(id, mode) {
      const res = await ownerRequest("POST", `/goals/${encodeURIComponent(id)}/challenge`, { mode });
      if (!res.ok) return res;
      return ok(res.value as unknown as CoreGoalSummary);
    },

    async planGoal(id) {
      const res = await ownerRequest("POST", `/goals/${encodeURIComponent(id)}/plan`, {});
      if (!res.ok) return res;
      return ok(res.value as unknown as CoreGoalSummary);
    },

    async approvePlan(id, revisionId) {
      const res = await ownerRequest("POST", `/goals/${encodeURIComponent(id)}/approve`, {
        ...(revisionId !== undefined ? { revisionId } : {}),
      });
      if (!res.ok) return res;
      return ok(res.value as unknown as CoreGoalSummary);
    },

    async rejectPlan(id, note) {
      const res = await ownerRequest("POST", `/goals/${encodeURIComponent(id)}/reject`, {
        ...(note !== undefined ? { note } : {}),
      });
      if (!res.ok) return res;
      return ok(res.value as unknown as CoreGoalSummary);
    },

    async setGoalState(id, state) {
      const res = await ownerRequest("POST", `/goals/${encodeURIComponent(id)}/state`, { state });
      if (!res.ok) return res;
      return ok(res.value as unknown as CoreGoalSummary);
    },

    async getDoer() {
      const res = await request("/doer");
      if (!res.ok) return res;
      return ok(res.value as unknown as CoreDoerState);
    },

    async setDoer(state) {
      const res = await ownerRequest("POST", "/doer", { state });
      if (!res.ok) return res;
      return ok(res.value);
    },

    async resetSettings(keys) {
      const res = await request("/settings/reset", {
        method: "POST",
        body: keys === undefined ? {} : { keys },
      });
      if (!res.ok) return res;
      return ok(res.value);
    },

    async getProviders() {
      const res = await request("/providers");
      if (!res.ok) return res;
      const raw = res.value["providers"];
      if (!Array.isArray(raw)) return fail("INVALID_RESPONSE", 'expected an array at "providers"');
      const out: CoreProviderSummary[] = [];
      for (const entry of raw) {
        if (!isObject(entry)) return fail("INVALID_RESPONSE", "provider entry was malformed");
        const id = asString(entry.id);
        const label = asString(entry.label);
        const kind = asString(entry.kind);
        const baseUrl = asString(entry.baseUrl);
        if (id === undefined || label === undefined || kind === undefined || baseUrl === undefined) {
          return fail("INVALID_RESPONSE", "provider entry was malformed");
        }
        const models: { id: string; current: boolean }[] = [];
        if (Array.isArray(entry.models)) {
          for (const m of entry.models) {
            if (!isObject(m)) return fail("INVALID_RESPONSE", "provider model was malformed");
            const mid = asString(m.id);
            if (mid === undefined) return fail("INVALID_RESPONSE", "provider model was malformed");
            models.push({ id: mid, current: m.current === true });
          }
        }
        out.push({
          id,
          label,
          kind,
          current: entry.current === true,
          baseUrl,
          reachable: entry.reachable === true,
          authConfigured: entry.authConfigured === true,
          authorized: entry.authorized === true,
          ...(asString(entry.version) !== undefined ? { version: asString(entry.version) as string } : {}),
          ...(typeof entry.latencyMs === "number" ? { latencyMs: entry.latencyMs } : {}),
          models,
          ...(asString(entry.modelsNote) !== undefined ? { modelsNote: asString(entry.modelsNote) as string } : {}),
          ...(asString(entry.reason) !== undefined ? { reason: asString(entry.reason) as string } : {}),
        });
      }
      return ok(out);
    },

    async testProvider(id) {
      const res = await request(`/providers/${encodeURIComponent(id)}/test`);
      if (!res.ok) return res;
      const inner = res.value["test"];
      if (!isObject(inner)) return fail("INVALID_RESPONSE", "provider test had no result");
      const reason = asString(inner.reason);
      if (reason === undefined) return fail("INVALID_RESPONSE", "provider test had no reason");
      return ok({
        id: asString(inner.id) ?? id,
        ok: inner.ok === true,
        reachable: inner.reachable === true,
        authorized: inner.authorized === true,
        ...(typeof inner.latencyMs === "number" ? { latencyMs: inner.latencyMs as number } : {}),
        reason,
      });
    },

    async listModels() {
      const res = await request("/models");
      if (!res.ok) return res;
      const raw = res.value["providers"];
      if (!Array.isArray(raw)) return fail("INVALID_RESPONSE", 'expected an array at "providers"');
      const out: { id: string; current: boolean; models: { id: string; current: boolean }[]; note?: string }[] = [];
      for (const entry of raw) {
        if (!isObject(entry)) return fail("INVALID_RESPONSE", "models entry was malformed");
        const id = asString(entry.id);
        if (id === undefined) return fail("INVALID_RESPONSE", "models entry was malformed");
        const models: { id: string; current: boolean }[] = [];
        if (Array.isArray(entry.models)) {
          for (const m of entry.models) {
            if (!isObject(m)) continue;
            const mid = asString(m.id);
            if (mid === undefined) continue;
            models.push({ id: mid, current: m.current === true });
          }
        }
        out.push({
          id,
          current: entry.current === true,
          models,
          ...(asString(entry.note) !== undefined ? { note: asString(entry.note) as string } : {}),
        });
      }
      return ok(out);
    },

    async useModel(model, approvalId) {
      const res = await request("/models/use", {
        method: "POST",
        body: approvalId !== undefined ? { model, approvalId } : { model },
      });
      if (!res.ok) return res;
      return ok(res.value);
    },

    async getSoul() {
      const res = await request("/soul");
      if (!res.ok) return res;
      const inner = res.value["soul"];
      if (!isObject(inner)) return fail("INVALID_RESPONSE", "soul response had no soul");
      const soul = asString(inner.soul);
      const version = asString(inner.version);
      const soulPath = asString(inner.soulPath);
      if (soul === undefined || version === undefined || soulPath === undefined) {
        return fail("INVALID_RESPONSE", "soul response was malformed");
      }
      return ok({ soul, version, soulPath });
    },

    async setSoul(soul) {
      const res = await request("/soul", { method: "POST", body: { soul } });
      if (!res.ok) return res;
      return ok(res.value);
    },

    async skills() {
      const res = await request("/skills");
      if (!res.ok) return res;
      const raw = res.value["skills"];
      if (!Array.isArray(raw)) return fail("INVALID_RESPONSE", 'expected an array at "skills"');
      return ok(parseArray(raw, parseSkill));
    },

    async skill(id) {
      const res = await request(`/skills/${encodeURIComponent(id)}`);
      if (!res.ok) return res;
      const parsed = parseSkill(res.value["skill"]);
      if (parsed === null) return fail("INVALID_RESPONSE", "skill response was not a skill");
      return ok(parsed);
    },

    async setSkillEnabled(id, enabled) {
      const res = await request(`/skills/${encodeURIComponent(id)}/${enabled ? "enable" : "disable"}`, {
        method: "POST",
      });
      if (!res.ok) return res;
      const parsed = parseSkill(res.value["skill"]);
      if (parsed === null) return fail("INVALID_RESPONSE", "skill toggle response was not a skill");
      return ok(parsed);
    },

    async deleteSkill(id) {
      const res = await request(`/skills/${encodeURIComponent(id)}/delete`, { method: "POST" });
      if (!res.ok) return res;
      return ok({ deleted: true, id });
    },

    async stagedSkills() {
      const res = await request("/skills/staging");
      if (!res.ok) return res;
      const raw = res.value["staged"];
      if (!Array.isArray(raw)) return fail("INVALID_RESPONSE", 'expected an array at "staged"');
      return ok(parseArray(raw, parseStagedSkill));
    },

    async stagedSkill(stagedId) {
      const res = await request(`/skills/staging/${encodeURIComponent(stagedId)}`);
      if (!res.ok) return res;
      return ok(res.value["staged"]);
    },

    async approveStagedSkill(stagedId, sha256) {
      const res = await request(`/skills/staging/${encodeURIComponent(stagedId)}/approve`, {
        method: "POST",
        body: sha256 !== undefined ? { sha256 } : {},
      });
      if (!res.ok) return res;
      return ok(res.value);
    },

    async installStagedSkill(stagedId, approvalId, sha256) {
      const res = await request(`/skills/staging/${encodeURIComponent(stagedId)}/install`, {
        method: "POST",
        body: { approvalId, ...(sha256 !== undefined ? { sha256 } : {}) },
      });
      if (!res.ok) return res;
      return ok(res.value["install"]);
    },

    async discardStagedSkill(stagedId) {
      const res = await request(`/skills/staging/${encodeURIComponent(stagedId)}/discard`, {
        method: "POST",
        body: {},
      });
      if (!res.ok) return res;
      return ok(res.value);
    },

    async chatStream(text, forSessionId, handlers) {
      const doFetch = resolveFetch();
      if (doFetch === undefined) {
        return fail("CORE_OFFLINE", "no fetch implementation available");
      }
      const body: JsonObject = { text };
      if (forSessionId !== undefined && forSessionId !== "") body.conversation_id = forSessionId;
      // A streamed turn can run tools; give it room, not the 5s probe budget.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 180_000);
      // External STOP (the composer's stop control) composes with the timeout.
      if (handlers.signal !== undefined) {
        if (handlers.signal.aborted) controller.abort();
        else handlers.signal.addEventListener("abort", () => controller.abort(), { once: true });
      }
      let full = "";
      let sessionId: string | undefined;
      let toolIterations = 0;
      let toolBudgetExhausted = false;
      let terminalSynthesized: boolean | undefined;
      let terminalCancelled = false;
      let terminalTaskState: string | undefined;
      let terminalInvocation: CoreStreamedTurn["invocation"];
      let terminalAgentRun: CoreAgentRun | undefined;
      const failReply = (reason: string): CoreResult<CoreStreamedTurn> => fail("REQUEST_FAILED", reason);
      try {
        const res = await doFetch(`${baseUrl}/chat/stream`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!res.ok || res.body === null) {
          return fail("REQUEST_FAILED", `Core stream answered HTTP ${res.status}`);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        // Dispatch EACH frame the moment it is parsed. Reading the whole body
        // into an array first (the old behaviour) buffered the entire turn and
        // surfaced deltas + tool events only when the stream closed — the
        // "shows only at the end" defect. Streaming means streaming.
        let finished = false;
        let streamError: string | null = null;
        const handleFrame = (frame: string): void => {
          for (const line of frame.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const payload = trimmed.slice(5).trim();
            if (payload === "[DONE]") continue;
            let parsed: unknown;
            try {
              parsed = JSON.parse(payload) as unknown;
            } catch {
              continue;
            }
            if (!isObject(parsed)) continue;
            const delta = asString(parsed["delta"]);
            if (delta !== undefined && delta.length > 0) {
              full += delta;
              try {
                handlers.onDelta?.(delta);
              } catch {
                // A listener that throws must never break the turn it observes.
              }
            }
            const event = parsed["tool_event"];
            if (isObject(event) && typeof event["type"] === "string") {
              try {
                handlers.onToolEvent?.(event as unknown as CoreToolEvent);
              } catch {
                // Same rule for the event sink.
              }
            }
            if (parsed["done"] === true) {
              const error = asString(parsed["error"]);
              if (error !== undefined) {
                const reply = asString(parsed["reply"]) ?? "KAI's model provider is not answering.";
                streamError = `${error}: ${reply.slice(0, 300)}`;
                finished = true;
                continue;
              }
              const conversationId = asString(parsed["conversation_id"]);
              if (conversationId !== undefined) sessionId = conversationId;
              const iterations = asNumber(parsed["tool_iterations"]);
              if (iterations !== undefined) toolIterations = iterations;
              const exhausted = asBoolean(parsed["tool_budget_exhausted"]);
              if (exhausted !== undefined) toolBudgetExhausted = exhausted;
              if (asBoolean(parsed["synthesized"]) === true) terminalSynthesized = true;
              if (parsed["cancelled"] === true) terminalCancelled = true;
              const taskState = asString(parsed["task_state"]);
              if (taskState !== undefined) terminalTaskState = taskState;
              if (isObject(parsed["invocation"])) {
                const agents = Array.isArray(parsed["invocation"].agents)
                  ? (parsed["invocation"].agents as unknown[]).filter((a): a is string => typeof a === "string")
                  : [];
                const skills = Array.isArray(parsed["invocation"].skills)
                  ? (parsed["invocation"].skills as unknown[]).filter((s): s is string => typeof s === "string")
                  : [];
                if (agents.length > 0 || skills.length > 0) terminalInvocation = { agents, skills };
              }
              if (isObject(parsed["agent_run"])) {
                const subagentId = asString(parsed["agent_run"].subagentId);
                const approvalId = asString(parsed["agent_run"].approvalId);
                const reason = asString(parsed["agent_run"].reason);
                if (subagentId !== undefined && approvalId !== undefined && reason !== undefined) {
                  terminalAgentRun = { subagentId, approvalId, reason };
                }
              }
              finished = true;
            }
          }
        };
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          for (;;) {
            const sep = /\r?\n\r?\n/.exec(buffer);
            if (sep === null) break;
            const frame = buffer.slice(0, sep.index);
            buffer = buffer.slice(sep.index + sep[0].length);
            handleFrame(frame);
          }
          if (finished) break;
        }
        if (buffer.trim().length > 0) handleFrame(buffer);
        if (streamError !== null) return failReply(streamError);
        return ok({
          text: full,
          ...(sessionId !== undefined ? { sessionId } : {}),
          toolIterations,
          toolBudgetExhausted,
          ...(terminalSynthesized === true ? { synthesized: true } : {}),
          ...(terminalCancelled ? { cancelled: true as const } : {}),
          ...(terminalTaskState !== undefined ? { taskState: terminalTaskState } : {}),
          ...(terminalInvocation !== undefined ? { invocation: terminalInvocation } : {}),
          ...(terminalAgentRun !== undefined ? { agentRun: terminalAgentRun } : {}),
        });
      } catch (err) {
        // A user Stop aborts the fetch: report cancellation, NOT a timeout.
        // Only the 180s timer expiring on its own is a TIMEOUT.
        if (controller.signal.aborted) {
          if (handlers.signal?.aborted === true) {
            return ok({
              text: full,
              toolIterations,
              toolBudgetExhausted,
              cancelled: true as const,
              ...(terminalTaskState !== undefined ? { taskState: terminalTaskState } : {}),
            });
          }
          return fail("TIMEOUT", "Core stream timed out");
        }
        if (err instanceof TypeError) return fail("CORE_OFFLINE", "Core is not reachable");
        return fail("UNKNOWN", describeThrown(err));
      } finally {
        clearTimeout(timer);
      }
    },

    async chat(text, forSessionId) {
      const body: JsonObject = { text };
      // Core's `/chat` reads `conversation_id` for the KAI session. `session_id`
      // is deliberately NOT sent here: on Core it names the WORKER session
      // override, and sending KAI's own id under that name is the exact poison
      // that once made every later turn 404. Only sent when a caller names a
      // session, so the default (Core's active session) is unchanged.
      if (forSessionId !== undefined && forSessionId !== "") body.conversation_id = forSessionId;
      const res = await request("/chat", { method: "POST", body });
      if (!res.ok) return res;
      const v = res.value;
      const agent = asString(v.agent);
      const reply = asString(v.reply);
      // Both shapes — Core's `{agent:"core",from_state,intent,reply,data}` and the
      // pre-existing agent shape `{agent,session_id,reply,usage}` — carry `agent`
      // and `reply`; the discriminator is `agent`.
      if (agent === undefined || reply === undefined) {
        return fail("INVALID_RESPONSE", "chat response had no agent/reply");
      }
      const out: CoreChatAnswer = { agent, reply };
      const fromState = asBoolean(v.from_state);
      if (fromState !== undefined) out.fromState = fromState;
      const intent = asString(v.intent);
      if (intent !== undefined) out.intent = intent;
      if (v.data !== undefined) out.data = v.data;
      // The KAI conversation this turn belonged to: `conversation_id` on the
      // Core path, `session_id` on the legacy worker path.
      const sessionId = asString(v.conversation_id) ?? asString(v.session_id);
      if (sessionId !== undefined) out.sessionId = sessionId;
      // Explicit `@` invocation metadata + a parked agent run to Allow.
      if (isObject(v.invocation)) {
        const agents = Array.isArray(v.invocation.agents) ? v.invocation.agents.filter((a): a is string => typeof a === "string") : [];
        const skills = Array.isArray(v.invocation.skills) ? v.invocation.skills.filter((s): s is string => typeof s === "string") : [];
        if (agents.length > 0 || skills.length > 0) out.invocation = { agents, skills };
      }
      if (isObject(v.agent_run)) {
        const subagentId = asString(v.agent_run.subagentId);
        const approvalId = asString(v.agent_run.approvalId);
        const reason = asString(v.agent_run.reason);
        if (subagentId !== undefined && approvalId !== undefined && reason !== undefined) {
          out.agentRun = { subagentId, approvalId, reason };
        }
      }
      // The tool calls this turn made, as Core persisted them — rendered, never invented.
      if (Array.isArray(v.tool_calls)) {
        const toolCalls = parseArray(v.tool_calls, parseToolCall);
        if (toolCalls.length > 0) out.toolCalls = toolCalls;
      }
      const toolIterations = asNumber(v.tool_iterations);
      if (toolIterations !== undefined) out.toolIterations = toolIterations;
      const toolBudgetExhausted = asBoolean(v.tool_budget_exhausted);
      if (toolBudgetExhausted !== undefined) out.toolBudgetExhausted = toolBudgetExhausted;
      if (asBoolean(v.synthesized) === true) out.synthesized = true;
      if (Array.isArray(v.pending_tools)) {
        const pending = v.pending_tools.filter((p): p is string => typeof p === "string");
        if (pending.length > 0) out.pendingTools = pending;
      }
      const taskState = asString(v.task_state);
      if (taskState !== undefined) out.taskState = taskState;
      return ok(out);
    },

    async visualCompile(source) {
      const res = await request("/visual/compile", { method: "POST", body: { source } });
      if (res.ok) {
        return ok<CoreVisualCompileResponse>({ ok: true, intent: res.value.intent });
      }
      // A 400 from the validator is a REFUSAL, not a transport failure: Core named
      // the offending field. Surface it as a typed rejection so a caller shows the
      // exact reason and code instead of a generic "request failed".
      if (res.error.status === 400) {
        return ok<CoreVisualCompileResponse>({
          ok: false,
          code: res.error.errorCode ?? "REJECTED",
          reason: res.error.reason ?? res.error.message,
        });
      }
      return res;
    },

    async ping() {
      const res = await request("/health");
      if (!res.ok) return res;
      return ok({ ok: true });
    },
  };
}