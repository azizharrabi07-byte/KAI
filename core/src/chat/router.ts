// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * KAI Core intent/chat router.
 *
 * The spec's promise is that the user can type "What's Hermes doing?" and KAI
 * answers FROM ACTUAL SYSTEM STATE, not from a language model's imagination.
 * This module is where that promise is kept or broken, so its one hard rule is:
 *
 *   Every `answer()` either reads a number, a name or a list out of the
 *   injected runtime/memory service, or it refuses. It never invents one, and
 *   it never claims an agent handled something when none did.
 *
 * `classify()` is deliberately a small, ordered set of regex rules over
 * low-cardinality utterance patterns — not a model. A router that guesses is the
 * exact failure mode the product exists to avoid: an unrecognised utterance
 * becomes an honest `unknown` that is handed to a connected agent, rather than a
 * plausible-sounding answer nobody can trace.
 *
 * `artifact.run_tests` is intentionally inert. This module is not a shell: it
 * reports that a real test run needs the tool/policy path and says plainly that
 * KAI has NOT executed anything, so the user is not misled.
 */

import type {
  AgentStatus,
  Approval,
  ApprovalStatus,
  KaiNotification,
  Memory,
  MemoryType,
  Mission,
} from "../shared/contracts.ts";
import type { MemoryService } from "../memory/service.ts";
import { BUILT_IN_SOUL } from "../agent/soul.ts";
import { brainFailureReason, brainFailureReply, type BrainToolCallRecord, type KaiBrain } from "./brain.ts";
import { parseInvocations, resolveInvocations } from "./invoke.ts";
import type { TaskTracker } from "./tasks.ts";
import { beginTurn, finishTurn } from "./turns.ts";
import {
  KAI_DIRECT_CAPABILITIES,
  KAI_WORKERS,
  WORKER_RELATIONSHIP,
  WORKER_LABEL,
  renderCapabilities,
  renderLimits,
  type CapabilityAvailabilityFact,
} from "../agent/kai-capabilities.ts";

/**
 * The subset of CoreRuntimeHealth the router reads. Declared structurally (not
 * imported from runtime.ts) so `answer()` stays testable with a hand-built stub
 * — a real `CoreRuntimeHealth` is assignable to this without casting.
 */
export interface CoreRuntimeHealthLike {
  ok?: boolean;
  agents: AgentStatus[];
  missions: { active: number; unfinished: number };
  notifications: { unread: number };
  approvals: { pending: number };
}

/** The runtime surface the router is allowed to touch. Structural on purpose. */
export interface RouterRuntime {
  health(): Promise<CoreRuntimeHealthLike>;
  registry: { statusAll(): Promise<AgentStatus[]>; get(id: string): unknown };
  stores: {
    missions: { listMissions(o: object): Mission[] };
    scheduledTasks: { listScheduledTasks(o: object): unknown[] };
  };
  /** Optional so a stub may omit it; the answer falls back to health counts. */
  approvals?: { list(opts?: { status?: ApprovalStatus; limit?: number }): Approval[] };
  notifications?: { list(opts?: { unreadOnly?: boolean; limit?: number }): KaiNotification[] };
}

/**
 * The slice of KAI's own identity the router is allowed to read. Structural on
 * purpose, so the real `KaiIdentityProvider` (agent/soul.ts) is assignable
 * without a cast and a test can inject a hand-built soul.
 *
 * This is the ONE identity mechanism: the identity intent and the relay
 * boundary's fallback both read it. There is deliberately no second copy of
 * "who KAI is".
 */
export interface RouterIdentityLike {
  /** One sentence KAI can say about itself, with no dependency on any worker. */
  selfDescription(): string;
  identity(): { soul: string; version: string };
}

export interface RouterContext {
  runtime: RouterRuntime;
  memory: MemoryService;
  /**
   * The task lifecycle tracker. Optional so stubs keep compiling; when absent
   * the turn still answers (no lifecycle recorded). The runtime injects the
   * real tracker so "continue" resumes open work and completion is verified.
   */
  tasks?: TaskTracker;
  /**
   * KAI's own capability registry, read-only, so "what can you do?" is answered from
   * KAI's real architecture. Optional: when absent, KAI states its taxonomy without a
   * false availability claim. A worker's tool installation is NEVER consulted here.
   */
  capabilities?: RouterCapabilitiesLike;
  /**
   * KAI's soul. Optional so existing stubs keep compiling; when absent the
   * built-in identity is used, so KAI is never identity-less. A worker is never
   * consulted for this.
   */
  identity?: RouterIdentityLike;
  /**
   * KAI'S OWN reasoning loop. When present, a conversational turn that matches no
   * rule is answered by KAI's own model provider instead of being auto-delegated to
   * a worker. This is the architectural fix: normal chat is KAI's own inference,
   * and a worker is reached only on an EXPLICIT delegation intent.
   *
   * Optional so the pre-existing router tests (which inject no brain) keep their
   * pinned behaviour: with no brain, the legacy "hand it to a connected worker"
   * fallback stands, and an unknown turn with nothing connected is answered by KAI
   * as itself. See the F5 pins in tests/routing-relay.test.ts.
   */
  brain?: KaiBrain;
  /**
   * Compose KAI's own system prompt for a conversational turn. The runtime injects
   * its ONE prompt composer here (identity -> memory -> skills -> request), so the
   * model receives KAI's actual identity/context from KAI Core. Optional: a router
   * with a brain but no composer falls back to KAI's soul line.
   */
  composePrompt?: (request: string, opts?: { scope?: string; sessionId?: string }) => Promise<string>;
  /**
   * Explicit `@` invocation support. Optional so stubs keep compiling; when
   * absent, a turn opening with `@name` is ordinary text. When present, leading
   * `@agent`/`@skill` tokens are resolved against these live lists and executed
   * through `runAgent` / `loadSkill` — never as prose, never around policy.
   */
  invocations?: RouterInvocationLike;
}

/**
 * The live directory plus the two policy-governed executors behind `@`.
 * Structural on purpose, so the runtime can inject the real registries and a
 * test can inject fakes.
 */
export interface RouterInvocationLike {
  /** Subagent spec ids + display names. */
  agents(): Array<{ id: string; name: string }>;
  /** Skill ids + names + disabled state. */
  skills(): Array<{ id: string; name: string; disabled: boolean }>;
  /**
   * Run a task AS a subagent with optional skill guidance prepended. Returns
   * the persona-authored reply, or the park (`approvalId`) when policy held
   * it for a human. Never throws across this boundary.
   */
  runAgent(input: {
    id: string;
    task: string;
    skillContext?: string;
  }): Promise<
    | { ok: true; reply: string; guarded: boolean }
    | { ok: false; parked: true; approvalId: string; reason: string }
    | { ok: false; parked?: false; reason: string }
  >;
  /**
   * Load one skill body for prompt injection. Refuses disabled or unknown
   * skills as values — the router then says so instead of inventing context.
   */
  loadSkill(id: string): { ok: true; name: string; body: string } | { ok: false; reason: string };
}

/**
 * The slice of KAI's OWN capability registry the router reads. Structural, so the
 * real runtime registry is assignable without a cast and a test can inject a stub.
 */
export interface RouterCapabilitiesLike {
  /** KAI's own capabilities (provider "kai") and their honest availability. */
  list(): Array<{ id: string; name?: string; availability?: string; provider?: string; detail?: string }>;
}

export type RouterIntent =
  | "identity"
  | "capability.list"
  | "capability.limits"
  | "harness"
  | "independence"
  | "status.summary"
  | "agent.status"
  | "agent.list"
  | "task.delegate"
  | "mission.list"
  | "approval.list"
  | "notification.list"
  | "memory.list"
  | "memory.remember"
  | "artifact.run_tests"
  | "unknown";

export type WorkerId = "hermes" | "opencode";

export interface RouterAnswer {
  intent: RouterIntent;
  /** The answer, built from real state. */
  text: string;
  /** The structured facts behind it, so the UI can render them. */
  data?: unknown;
  /** true when the answer came from live state rather than from a model. */
  fromState: boolean;
  /**
   * Set when the request should be handled by a worker instead (a task turn).
   * The server routes the turn to THIS worker; KAI remains the speaker and the
   * worker is only provenance. `undefined` means no worker can take the turn, in
   * which case `text` is KAI's own answer — never silence.
   */
  delegateTo?: WorkerId;
  /**
   * A worker the user explicitly ruled out ("I don't want Hermes"). Delegation
   * honours it: KAI will not route the turn to this worker, and if no other
   * worker can take it KAI says so as itself rather than disobeying.
   */
  avoid?: WorkerId;
  /**
   * Set when the answer came from KAI's OWN model provider (its reasoning loop),
   * with the model that produced it. KAI itself spoke; no worker was involved.
   */
  brain?: { provider: string; model: string };
  /**
   * The tool calls the brain made this turn, in order — the server persists
   * them against the assistant turn so a reload restores that tools were used.
   * Present only on brain answers that used tools.
   */
  toolCalls?: BrainToolCallRecord[];
  /** Tool-round budget state, so the session/run knows the turn's cost. */
  toolIterations?: number;
  toolBudgetExhausted?: boolean;
  /** True when the brain's final-synthesis guard authored the closing text. */
  synthesized?: boolean;
  /** Tool calls requested but never executed (the honest remainder). */
  pendingTools?: string[];
  /** Task lifecycle state after this turn (COMPLETED, PAUSED, …). */
  taskState?: string;
  /**
   * Explicit `@` invocation behind this answer: which agents/skills the turn
   * used, so the UI can show the interpretation it acted on.
   */
  invocation?: { agents: string[]; skills: string[] };
  /**
   * A delegated agent turn parked on an approval. The UI offers Allow/Refuse;
   * Allow re-issues through the agent run path with the approval id.
   */
  agentRun?: { subagentId: string; approvalId: string; reason: string };
}

export interface IntentDoc {
  intent: RouterIntent;
  description: string;
  examples: string[];
}

export interface ChatRouter {
  classify(text: string): RouterIntent;
  answer(text: string, opts?: { sessionId?: string }): Promise<RouterAnswer>;
  /** Which utterances each intent matches — used by the tests and by docs. */
  intents(): IntentDoc[];
  /**
   * One sentence KAI can say about itself, read from its soul. The relay
   * boundary uses this so a worker's self-identification can never be spoken as
   * the product's own voice.
   */
  selfDescription(): string;
}

/** Agent ids this Core knows by name, for "is X busy" style questions. */
const KNOWN_AGENT_IDS = ["hermes", "opencode"] as const;

/** Things a user might confuse KAI with that are not workers KAI uses. */
const CONFUSED_WITH = ["claude", "codex"] as const;

/** Display names, so a denial reads as prose rather than as an id. */
const AGENT_LABEL: Record<string, string> = {
  hermes: "Hermes",
  opencode: "OpenCode",
  claude: "Claude",
  codex: "Codex",
};

const ACTIVE_MISSION_STATUSES = new Set(["QUEUED", "RUNNING", "WAITING", "WAITING_APPROVAL"]);

interface IntentRule {
  intent: Exclude<RouterIntent, "unknown">;
  description: string;
  examples: string[];
  patterns: RegExp[];
  /**
   * An extra, structured test for utterances a regex list cannot express cleanly
   * (e.g. "does this sentence ask a status question ABOUT a named worker?").
   * Kept beside `patterns` so the ordered rules stay the single source of truth.
   */
  predicate?: (text: string) => boolean;
}

/**
 * The predicates below give `classify()` the STRUCTURE the four concepts need:
 * naming a worker, asking about a worker, delegating to a worker, and ruling a
 * worker out are four different things — and a bare name is none of them.
 */
/** The worker names actually present in a normalised utterance, in a stable order. */
function workerNamesIn(t: string): string[] {
  return KNOWN_AGENT_IDS.filter((id) => new RegExp(`\\b${id}\\b`).test(t));
}

/**
 * Status/availability/activity words. These are what turn a sentence that merely
 * CONTAINS a worker's name into a question ABOUT that worker. Deliberately
 * narrow: bare "up"/"down" are excluded so an ordinary sentence cannot trip it.
 */
const WORKER_STATUS_WORDS =
  "(?:doing|up\\s+to|working(?:\\s+on)?|status|state|health|online|offline|connected|disconnected|reachable|unreachable|busy|idle|available|unavailable|running|active|failed|failure|error|errored|broken|crash(?:ed)?|stuck|hung|responding|alive)";

/**
 * True only when the utterance is a status/health/availability question about a
 * NAMED worker (or a comparison of two workers) — the "worker status question"
 * concept. This is the whole point of the fix: the bare presence of the word
 * "hermes" no longer makes a sentence a status question. A sentence that merely
 * mentions a worker ("I was reading about Hermes and…") returns false and falls
 * through to ordinary conversation.
 */
function looksLikeWorkerStatus(t: string): boolean {
  const names = workerNamesIn(t);
  if (names.length === 0) return false;
  const N = `(?:${names.join("|")})`;
  const patterns = [
    // "what is hermes" / "who is opencode" — a question about what the worker is.
    new RegExp(`\\b(?:what|who)\\s+(?:is|are)\\s+${N}\\b`),
    // "is hermes online" / "was opencode working" — the worker is the subject.
    new RegExp(`\\b(?:is|are|was|were)\\s+${N}\\b`),
    // "what is hermes doing" / "how is opencode doing".
    new RegExp(`\\b(?:what|how)\\b[^.!?]*${N}[^.!?]*${WORKER_STATUS_WORDS}`),
    // "hermes failed" / "opencode is busy" / "hermes status".
    new RegExp(`\\b${N}\\b[^.!?]*${WORKER_STATUS_WORDS}`),
    // "compare hermes and opencode" / "hermes vs opencode".
    new RegExp(`\\b(?:compare|comparison|versus|vs\\.?|difference|differences)\\b[^.!?]*${N}\\b`),
    new RegExp(`\\b${N}\\b[^.!?]*\\b(?:compare|comparison|versus|vs\\.?|difference|differences)\\b`),
  ];
  return patterns.some((re) => re.test(t));
}

/** Verbs that, directly before a worker's name, make the sentence a delegation. */
const DELEGATION_VERBS =
  "(?:use|using|have|having|ask|asking|get|getting|tell|telling|send|sending|let|invoke|invoking|call|calling|route|routing|delegate|delegating|assign|assigning)";

/** Imperative verbs that, right after a leading worker name, make it an address. */
const IMPERATIVE_VERBS =
  "(?:do|run|make|build|write|fix|find|check|search|create|add|delete|remove|update|refactor|test|explain|summarize|summarise|translate|help|analyze|analyse|review|plan|clean|install|deploy|generate|draft|implement|debug|investigate|read|open|close|move|copy|rename)";

/**
 * True when the utterance is an explicit instruction to USE a worker — the "task
 * delegation" concept. Distinguished from a status question by grammatical form:
 * a delegation has a delegating verb ("use/ask/have… hermes") or addresses the
 * worker directly ("Hermes, do X"), never a status predicate.
 */
function looksLikeDelegation(t: string): boolean {
  const names = workerNamesIn(t);
  if (names.length === 0) return false;
  const N = `(?:${names.join("|")})`;
  const patterns = [
    // "use hermes", "ask opencode to …", "have hermes do …"
    new RegExp(`\\b${DELEGATION_VERBS}\\s+${N}\\b`),
    // "hand this to hermes", "give it to opencode".
    new RegExp(`\\b(?:hand|give|pass|route|send)\\b[^.!?]*\\b(?:to\\s+)?${N}\\b`),
    // "Hermes, do X" — the worker is addressed directly.
    new RegExp(`^\\s*${N}\\s*,`),
    // "Hermes please do X" / "Hermes do X".
    new RegExp(`^\\s*${N}\\s+(?:please\\s+)?${IMPERATIVE_VERBS}\\b`),
  ];
  return patterns.some((re) => re.test(t));
}

/**
 * A worker the user ruled out ("I don't want Hermes", "without OpenCode"). Kept
 * separate from classification because it is a CONSTRAINT on delegation, not a
 * kind of question — an ordinary sentence can carry it.
 */
function avoidWorker(t: string): WorkerId | undefined {
  for (const id of KNOWN_AGENT_IDS) {
    const re = new RegExp(
      `\\b(?:don'?t|do\\s+not|doesn'?t|not|without|never|stop\\s+using|no)\\b[^.!?]*\\b${id}\\b`,
    );
    if (re.test(t)) return id;
  }
  return undefined;
}

/** The worker names in a KAI-independence question. Codex is a worker too. */
const WORKER_ALT = "(?:hermes|opencode|codex)";

/**
 * True when the utterance asks whether KAI DEPENDS ON or works WITHOUT a worker, or
 * what happens if one is unavailable — the independence concept, answered from KAI's
 * own architecture. Deliberately distinct from a status question: it fires on
 * "without hermes" / "if hermes is offline" / "connected to hermes" / "do you need
 * hermes", and NOT on "what's hermes doing" or "is hermes offline" (those stay
 * workforce-status questions).
 */
function looksLikeWorkerIndependence(t: string): boolean {
  const patterns = [
    new RegExp(`\\bwithout\\s+${WORKER_ALT}\\b`),
    new RegExp(`\\bif\\s+${WORKER_ALT}\\b`),
    new RegExp(`\\b(?:need|needs|depend|depends|dependent|rely|relies|relying|reliant)\\b[^.!?]*\\b${WORKER_ALT}\\b`),
    new RegExp(`\\bconnected\\s+to\\s+${WORKER_ALT}\\b`),
    new RegExp(`\\b${WORKER_ALT}\\b[^.!?]*\\b(?:needed|required|necessary)\\b`),
    /\bwork(?:s|ing)?\s+(?:on\s+my\s+own|independently|by\s+myself|alone)\b/,
  ];
  return patterns.some((re) => re.test(t));
}

/**
 * True when the utterance asks about KAI's HARNESS — what runs KAI — so the answer
 * comes from KAI's own runtime architecture and never names Hermes's harness as KAI's.
 */
function looksLikeHarnessQuestion(t: string): boolean {
  const patterns = [
    /\bharness\b/,
    /\bwhat\s+(?:runs|powers|drives|backs|hosts)\s+you\b/,
    /\bhow\s+do\s+you\s+run\b/,
    /\bwhat\s+are\s+you\s+running\s+(?:inside|in|under|within)\b/,
    /\bare\s+you\s+running\s+(?:inside|in|under|within)\b/,
  ];
  return patterns.some((re) => re.test(t));
}

/** True for a question about what KAI cannot do / its limits. */
function looksLikeLimitQuestion(t: string): boolean {
  const patterns = [
    /\bwhat\s+can(?:'?t)\s+you\s+do\b/,
    /\bwhat\s+can\s+you\s+not\s+do\b/,
    /\bwhat\s+are\s+you\s+unable\s+to\s+do\b/,
    /\bwhat\s+(?:are|is)\s+your\s+limitations?\b/,
    /\byour\s+limitations?\b/,
    /\byour\s+limits?\b/,
  ];
  return patterns.some((re) => re.test(t));
}

/** True for a question about what KAI can do / its capabilities. */
function looksLikeCapabilityQuestion(t: string): boolean {
  const patterns = [
    /\bwhat\s+can\s+you\s+do\b/,
    /\bwhat\s+are\s+you\s+(?:capable|able)\s+of\b/,
    /\bwhat\s+are\s+your\s+capabilit/,
    /\bwhat\s+capabilit/,
    /\blist\s+(?:your\s+)?capabilit/,
    /\byour\s+capabilit/,
    /\bcapabilit(?:y|ies)\b/,
    /\bwhat\s+(?:skills|tools|abilities)\s+do\s+you\s+have\b/,
  ];
  return patterns.some((re) => re.test(t));
}

/** A status phrase about one worker, in the third person, for KAI's own prose. */
function statusPhrase(agent: AgentStatus): string {
  switch (agent.state) {
    case "offline":
      return "it is not connected right now";
    case "working":
      return agent.currentTask !== undefined && agent.currentTask.length > 0
        ? `it is working on ${agent.currentTask}`
        : "it is working";
    case "idle":
      return "it is idle, with no task right now";
    case "waiting":
      return "it is waiting";
    case "connecting":
      return "it is connecting";
    case "error":
      return agent.detail !== undefined && agent.detail.length > 0
        ? `it reports an error: ${agent.detail}`
        : "it reports an error";
    default:
      return `it is ${agent.state}`;
  }
}

/**
 * Ordered rules. Order is significant where two rules could match one utterance:
 *
 *  - `identity` is FIRST, so "who are you" / "are you hermes?" is KAI's own
 *    identity and can never be answered as a worker-status report.
 *  - `task.delegate` precedes `agent.status`, so "use hermes to do this" is a
 *    delegation and not a status question.
 *  - `agent.status` no longer matches a bare worker name. Its predicate fires
 *    only on a status/health/availability question about a named worker, so an
 *    ordinary sentence that merely mentions a worker falls through to normal
 *    conversation.
 *  - `memory.remember` is anchored to a leading "remember", so "what do you
 *    remember" falls through to `memory.list`; `agent.status` is matched before
 *    `status.summary` so "agent status" is about agents while a bare "status" is
 *    the whole-system summary.
 */
const RULES: IntentRule[] = [
  {
    intent: "identity",
    description:
      "Who KAI is — answered from KAI's own soul, never from a worker's self-description.",
    examples: [
      "who are you",
      "what are you",
      "who made you",
      "which model are you",
      "are you hermes",
      "what are you running on",
    ],
    patterns: [
      /\bwho\s+are\s+you\b/,
      // "what are you" is identity; "what are you doing" is not (it is status).
      /^what\s+are\s+you\b(?!\s+(?:doing|working|waiting|planning|up\s+to|going\s+to|building|running|reading|writing))/,
      /\bwho\s+(?:made|built|created|owns?|is\s+behind)\s+you\b/,
      /\b(?:which|what)\s+model\s+are\s+you\b/,
      /\bare\s+you\s+(?:hermes|opencode|claude|codex|nous|an?\s+ai|a\s+bot|a\s+human|a\s+model|a\s+person|an?\s+assistant)\b/,
      /\bwhat\s+are\s+you\s+running\s+on\b/,
      /\bwhat\s+(?:are|is)\s+you\s+(?:built|based|running)\s+on\b/,
      /\bwho\s+do\s+you\s+work\s+for\b/,
      /\bare\s+you\s+the\s+same\s+as\s+(?:hermes|opencode|claude|codex)\b/,
    ],
  },
  {
    intent: "capability.limits",
    description:
      "What KAI cannot do — answered from KAI's own architecture and limits, never a worker's.",
    examples: ["what can you not do", "what can't you do", "what are your limitations"],
    patterns: [],
    predicate: looksLikeLimitQuestion,
  },
  {
    intent: "capability.list",
    description:
      "What KAI can do — answered from KAI's own capability registry, never Hermes's tools.",
    examples: ["what can you do", "what are your capabilities", "capabilities"],
    patterns: [],
    predicate: looksLikeCapabilityQuestion,
  },
  {
    intent: "harness",
    description:
      "What runs KAI — KAI's own harness, not Hermes's.",
    examples: ["do you have a harness", "what is your harness", "what runs you"],
    patterns: [],
    predicate: looksLikeHarnessQuestion,
  },
  {
    intent: "independence",
    description:
      "Whether KAI needs a worker to exist or speak — KAI does not; a worker is an ability, not KAI.",
    examples: [
      "can you work without hermes",
      "what happens if hermes is offline",
      "are you connected to hermes",
    ],
    patterns: [],
    predicate: looksLikeWorkerIndependence,
  },
  {
    intent: "memory.remember",
    description: "Store a fact the user states, from \"remember that X\" / \"remember: X\".",
    examples: ["remember that the build is green", "remember: project X has failing tests"],
    patterns: [/^\s*(?:please\s+|can you\s+|pls\s+)?remember(?:\s+that\b|\s*:)/],
  },
  {
    intent: "memory.list",
    description: "Recall what KAI has remembered (the memory digest).",
    examples: ["what do you remember", "recall", "show me your memories"],
    patterns: [
      /what\s+do\s+you\s+remember/,
      /what.*\bremember\b/,
      /\brecall\b/,
      /\bmemories\b/,
      /\bmemory\b.*\b(list|digest)\b/,
      /what\s+do\s+you\s+know/,
    ],
  },
  {
    intent: "task.delegate",
    description:
      "An explicit instruction to use a worker for a task — KAI delegates, the worker is provenance.",
    examples: ["use hermes to do this", "hermes, do x", "ask opencode to fix the build"],
    patterns: [],
    predicate: looksLikeDelegation,
  },
  {
    intent: "artifact.run_tests",
    description: "A request to run the test suite — reported, never executed here.",
    examples: ["run the tests", "run the test suite", "execute the test suite"],
    patterns: [/\btest\s+suite\b/, /\b(run|execute)\b[^.!?]*\btests?\b/],
  },
  {
    intent: "agent.status",
    description:
      "A status/health/availability question about a named worker, or of all agents when asked generically.",
    examples: ["what's hermes doing", "is opencode busy", "what is hermes", "agent status"],
    patterns: [
      /\bagents?\b.*\b(status|state|doing|busy|up|health)\b/,
      /\b(status|state|health)\b.*\bagents?\b/,
    ],
    // The fix: a worker's NAME alone is not a status question. Only a sentence
    // that actually asks about the worker's state/health/availability is.
    predicate: looksLikeWorkerStatus,
  },
  {
    intent: "agent.list",
    description: "Which agents KAI has registered.",
    examples: ["list agents", "what agents are available", "which agents do you have"],
    patterns: [/\blist\s+agents\b/, /\bagents?\b.*\b(list|registered|available)\b/],
  },
  {
    intent: "mission.list",
    description: "The missions KAI has, optionally filtered to the running ones.",
    examples: ["what missions are running", "list missions", "mission status"],
    patterns: [/\bmissions?\b/],
  },
  {
    intent: "approval.list",
    description: "Approvals waiting on the user's decision.",
    examples: ["what needs my approval", "any approvals", "approve pending"],
    patterns: [/\bapprov\w*\b/],
  },
  {
    intent: "notification.list",
    description: "Unread notifications.",
    examples: ["do I have any notifications", "any notifications", "unread notifications"],
    patterns: [/\bnotifications?\b/],
  },
  {
    intent: "status.summary",
    description: "Whole-system status: agents, active missions, pending approvals.",
    examples: ["what's happening", "what is going on", "status", "how are you"],
    patterns: [
      /what'?s\s+happening/,
      /what\s+is\s+happening/,
      /what'?s\s+going\s+on/,
      /what\s+is\s+going\s+on/,
      /how\s+are\s+you/,
      /how'?s\s+it\s+going/,
      /\bstatus\b/,
    ],
  },
];

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export function createChatRouter(ctx: RouterContext): ChatRouter {
  function classify(text: string): RouterIntent {
    const t = normalize(text);
    if (t.length === 0) return "unknown";
    for (const rule of RULES) {
      if (rule.patterns.some((pattern) => pattern.test(t))) return rule.intent;
      if (rule.predicate?.(t) === true) return rule.intent;
    }
    return "unknown";
  }

  function intents(): IntentDoc[] {
    const docs: IntentDoc[] = RULES.map((rule) => ({
      intent: rule.intent,
      description: rule.description,
      examples: [...rule.examples],
    }));
    docs.push({
      intent: "unknown",
      description: "Anything with no rule — handed to a connected agent, never answered inline.",
      examples: ["what's the weather", "write me a poem"],
    });
    return docs;
  }

  async function healthOrNull(): Promise<CoreRuntimeHealthLike | null> {
    try {
      return await ctx.runtime.health();
    } catch {
      // A health probe that throws must not turn into an invented answer.
      return null;
    }
  }

  function agentLine(agent: AgentStatus): string {
    switch (agent.state) {
      case "offline":
        return `${agent.id} is offline — it is not connected right now.`;
      case "working":
        return `${agent.id} is working${agent.currentTask ? ` on ${agent.currentTask}` : ""}.`;
      case "idle":
        return `${agent.id} is idle — no task right now.`;
      case "waiting":
        return `${agent.id} is waiting.`;
      case "connecting":
        return `${agent.id} is connecting.`;
      case "error":
        return `${agent.id} reports an error${agent.detail ? `: ${agent.detail}` : ""}.`;
      default:
        return `${agent.id} is ${agent.state}.`;
    }
  }

  async function answerStatusSummary(): Promise<RouterAnswer> {
    const health = await healthOrNull();
    if (health === null) {
      return {
        intent: "status.summary",
        text: "I could not read KAI's state just now, so I won't guess at it.",
        fromState: true,
      };
    }
    const agents = health.agents;
    const agentDetail =
      agents.length === 0
        ? "none registered"
        : agents.map((agent) => `${agent.id} (${agent.state})`).join(", ");
    const text =
      `KAI status: ${agents.length} agent(s) — ${agentDetail}; ` +
      `${health.missions.active} active mission(s); ` +
      `${health.approvals.pending} approval(s) pending.`;
    return {
      intent: "status.summary",
      text,
      data: {
        agents,
        activeMissions: health.missions.active,
        pendingApprovals: health.approvals.pending,
      },
      fromState: true,
    };
  }

  async function answerAgentStatus(t: string): Promise<RouterAnswer> {
    const health = await healthOrNull();
    if (health === null) {
      return {
        intent: "agent.status",
        text: "I could not read the agent registry just now, so I won't guess.",
        fromState: true,
      };
    }
    const agents = health.agents;
    // Every worker the utterance actually names — not just the first — so a
    // comparison ("compare Hermes and OpenCode") is answered about both.
    const mentioned = KNOWN_AGENT_IDS.filter((id) => new RegExp(`\\b${id}\\b`).test(t));

    if (mentioned.length > 0) {
      // "what is hermes" / "who is opencode" asks WHAT the worker is, not what it
      // is doing right now — so KAI names its role and then its live state.
      const isDefinition =
        /\b(?:what|who)\s+(?:is|are)\s+/.test(t) && !/\bdoing\b/.test(t) && !/\bup\s+to\b/.test(t);
      const lines: string[] = [];
      for (const id of mentioned) {
        const label = AGENT_LABEL[id] ?? id;
        const agent = agents.find((a) => a.id === id);
        if (agent === undefined) {
          lines.push(`${label} is one of the workers I can use, but it is not connected to KAI right now.`);
        } else if (isDefinition) {
          lines.push(`${label} is one of the workers I can use to get things done; ${statusPhrase(agent)}.`);
        } else {
          lines.push(agentLine(agent));
        }
      }
      // A failure question the live state does not corroborate: say so, rather
      // than implying a failure KAI cannot see.
      if (/\b(?:fail|failed|failure|error|errored|broke|broken|crash(?:ed)?|stuck|hung)\b/.test(t)) {
        const anyBad = mentioned.some((id) => {
          const agent = agents.find((a) => a.id === id);
          return agent !== undefined && (agent.state === "error" || agent.state === "offline");
        });
        if (!anyBad) lines.push("I have no failure recorded for it right now.");
      }
      const text = lines.join(" ");
      return {
        intent: "agent.status",
        text,
        data: mentioned.length === 1 ? agents.find((a) => a.id === mentioned[0]) ?? { agents } : { agents, mentioned },
        fromState: true,
      };
    }

    if (agents.length === 0) {
      return {
        intent: "agent.status",
        text: "No agents are registered with KAI.",
        data: { agents },
        fromState: true,
      };
    }
    return {
      intent: "agent.status",
      text: agents.map(agentLine).join(" "),
      data: { agents },
      fromState: true,
    };
  }

  /**
   * Answer a request to USE a worker, AS KAI. KAI owns the turn and names the
   * worker it will hand the task to; the worker's output comes back as KAI's
   * result (see the relay boundary in server.ts). This is a separate concept
   * from a status question: the delegation is what the user asked for, not a
   * report about the worker.
   */
  function answerTaskDelegate(t: string): RouterAnswer {
    const named = KNOWN_AGENT_IDS.find((id) => new RegExp(`\\b${id}\\b`).test(t));
    const avoid = avoidWorker(t);
    const target =
      named !== undefined && named !== avoid
        ? named
        : KNOWN_AGENT_IDS.find((id) => id !== avoid && id !== named);
    const label = target !== undefined ? AGENT_LABEL[target] ?? target : "a worker";
    return {
      intent: "task.delegate",
      text: `Understood — I'll hand this to ${label}.`,
      fromState: false,
      ...(target !== undefined ? { delegateTo: target } : {}),
      ...(avoid !== undefined ? { avoid } : {}),
    };
  }

  async function answerAgentList(): Promise<RouterAnswer> {
    const health = await healthOrNull();
    if (health === null) {
      return {
        intent: "agent.list",
        text: "I could not read the agent registry just now, so I won't guess.",
        fromState: true,
      };
    }
    const agents = health.agents;
    if (agents.length === 0) {
      return {
        intent: "agent.list",
        text: "No agents are registered with KAI.",
        data: { agents },
        fromState: true,
      };
    }
    const text =
      `${agents.length} agent(s) registered: ` +
      agents.map((agent) => `${agent.id} (${agent.state})`).join(", ") +
      ".";
    return { intent: "agent.list", text, data: { agents }, fromState: true };
  }

  async function answerMissionList(t: string): Promise<RouterAnswer> {
    let missions: Mission[];
    try {
      missions = ctx.runtime.stores.missions.listMissions({});
    } catch {
      return {
        intent: "mission.list",
        text: "I could not read the mission list just now, so I won't guess.",
        fromState: true,
      };
    }
    const wantsActive = /\b(running|active|in progress|currently|ongoing)\b/.test(t);
    const shown = wantsActive
      ? missions.filter((mission) => ACTIVE_MISSION_STATUSES.has(mission.status))
      : missions;
    if (shown.length === 0) {
      return {
        intent: "mission.list",
        text: wantsActive ? "No missions are running right now." : "There are no missions.",
        data: shown,
        fromState: true,
      };
    }
    const label = wantsActive ? "running mission(s)" : "mission(s)";
    const text =
      `${shown.length} ${label}: ` +
      shown.map((mission) => `"${mission.title}" (${mission.status})`).join(", ") +
      ".";
    return { intent: "mission.list", text, data: shown, fromState: true };
  }

  async function answerApprovalList(): Promise<RouterAnswer> {
    if (ctx.runtime.approvals !== undefined) {
      let approvals: Approval[];
      try {
        approvals = ctx.runtime.approvals.list({ status: "PENDING" });
      } catch {
        return {
          intent: "approval.list",
          text: "I could not read the approval list just now, so I won't guess.",
          fromState: true,
        };
      }
      const text =
        approvals.length === 0
          ? "Nothing needs your approval right now."
          : `${approvals.length} approval(s) waiting: ` +
            approvals.map((a) => `${a.action} (${a.risk})`).join(", ") +
            ".";
      return { intent: "approval.list", text, data: approvals, fromState: true };
    }
    const health = await healthOrNull();
    if (health === null) {
      return {
        intent: "approval.list",
        text: "I could not read KAI's state just now, so I won't guess.",
        fromState: true,
      };
    }
    const pending = health.approvals.pending;
    return {
      intent: "approval.list",
      text:
        pending === 0
          ? "Nothing needs your approval right now."
          : `${pending} approval(s) are pending.`,
      data: { pending },
      fromState: true,
    };
  }

  async function answerNotificationList(): Promise<RouterAnswer> {
    if (ctx.runtime.notifications !== undefined) {
      let notifications: KaiNotification[];
      try {
        notifications = ctx.runtime.notifications.list({ unreadOnly: true });
      } catch {
        return {
          intent: "notification.list",
          text: "I could not read the notifications just now, so I won't guess.",
          fromState: true,
        };
      }
      const text =
        notifications.length === 0
          ? "No unread notifications."
          : `${notifications.length} unread notification(s): ` +
            notifications.map((n) => n.title).join(", ") +
            ".";
      return { intent: "notification.list", text, data: notifications, fromState: true };
    }
    const health = await healthOrNull();
    if (health === null) {
      return {
        intent: "notification.list",
        text: "I could not read KAI's state just now, so I won't guess.",
        fromState: true,
      };
    }
    const unread = health.notifications.unread;
    return {
      intent: "notification.list",
      text: unread === 0 ? "No unread notifications." : `${unread} unread notification(s).`,
      data: { unread },
      fromState: true,
    };
  }

  function answerMemoryList(): RouterAnswer {
    const rows: Memory[] = ctx.memory.digest({ limit: 10 });
    if (rows.length === 0) {
      return {
        intent: "memory.list",
        text: "I don't have anything remembered yet.",
        data: rows,
        fromState: true,
      };
    }
    const text =
      "Here's what I remember: " + rows.map((memory) => `- ${memory.content}`).join(" ");
    return { intent: "memory.list", text, data: rows, fromState: true };
  }

  function answerMemoryRemember(rawText: string): RouterAnswer {
    const match =
      /^\s*(?:please\s+|can you\s+|pls\s+)?remember(?:\s+that|\s*:)\s*(.*)$/i.exec(rawText);
    const fact = (match?.[1] ?? "").trim().replace(/[.!]+$/, "").trim();
    if (fact.length === 0) {
      return {
        intent: "memory.remember",
        text: "There's nothing to remember — tell me the fact after \"remember that\" or \"remember:\".",
        fromState: false,
      };
    }
    let memory: Memory;
    try {
      memory = ctx.memory.remember({ type: "note", content: fact, source: "user_statement" });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        intent: "memory.remember",
        text: `I couldn't store that: ${detail}`,
        fromState: false,
      };
    }
    return {
      intent: "memory.remember",
      text: `Got it — remembered: ${memory.content}`,
      data: memory,
      fromState: true,
    };
  }

  function answerRunTests(): RouterAnswer {
    // Deliberately inert. This module holds no shell and no tool registry; a real
    // run goes through the tool/policy path. Say so, so no one thinks it ran.
    return {
      intent: "artifact.run_tests",
      text:
        "Running the test suite needs the tool/policy path — KAI has not executed anything here. " +
        "Ask me to start it as a mission or approve a tool run and I'll route it properly.",
      data: { executed: false, note: "routing only; no test run was performed" },
      fromState: true,
    };
  }

  /**
   * One sentence KAI can say about itself, read from the injected soul. Falls
   * back to the built-in identity so KAI is never identity-less, and NEVER asks
   * a worker — "who are you" must be answerable with every worker offline.
   */
  function identitySelfDescription(): string {
    if (ctx.identity !== undefined) return ctx.identity.selfDescription();
    return (BUILT_IN_SOUL.split("\n")[0] ?? "I am KAI.").trim();
  }

  /**
   * Answer an identity question AS KAI, from KAI's own soul.
   *
   * The defect this closes: identity questions used to fall through to a
   * connected worker, which then spoke as the product ("under the hood it's
   * Hermes Agent by Nous Research"). KAI answers who it is itself, and a
   * question that names a worker ("Are you Hermes?") is DENIED — Hermes is a
   * worker KAI may use, not what KAI is. No worker call is made here.
   */
  function answerIdentity(t: string): RouterAnswer {
    const self = identitySelfDescription();
    const worker = KNOWN_AGENT_IDS.find((id) => new RegExp(`\\b${id}\\b`).test(t));
    const confused = CONFUSED_WITH.find((id) => new RegExp(`\\b${id}\\b`).test(t));

    const parts: string[] = [];
    if (worker !== undefined) {
      parts.push(`No — ${AGENT_LABEL[worker] ?? worker} is a worker I can use, not what I am.`);
    } else if (confused !== undefined) {
      parts.push(`No — I'm not ${AGENT_LABEL[confused] ?? confused}.`);
    }
    parts.push(self);
    if (/\bmodel\b/.test(t)) {
      // "Which model are you?" must NOT be answered by reading a config file or
      // by naming the runtime: KAI is not a model, it delegates to one.
      parts.push(
        "I'm not a model myself; when a task needs one I delegate to a worker and it runs whichever model it is configured with.",
      );
    } else if (worker === undefined && confused === undefined) {
      parts.push(
        "Hermes and OpenCode are workers I can use; I'm still KAI when they are unavailable.",
      );
    }
    return {
      intent: "identity",
      text: parts.join(" "),
      data: { version: ctx.identity?.identity().version ?? null },
      fromState: true,
    };
  }

  /**
   * Read KAI's OWN capability registry, if one is injected, as availability facts.
   * A registry that throws is reported as no reading — never as an invented one.
   * Only provider "kai" entries are KAI's direct capabilities; the taxonomy itself
   * comes from the KAI-owned module so the answer never depends on the registry.
   */
  function liveCapabilityFacts(): CapabilityAvailabilityFact[] | undefined {
    if (ctx.capabilities === undefined) return undefined;
    try {
      return ctx.capabilities
        .list()
        .filter((entry) => entry.provider === undefined || entry.provider === "kai")
        .map((entry) => ({
          id: entry.id,
          availability: typeof entry.availability === "string" ? entry.availability : "UNKNOWN",
          ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
        }));
    } catch {
      return undefined;
    }
  }

  /**
   * Answer "what can you do?", AS KAI, from KAI's own architecture. Reads KAI's
   * capability registry when available (its own, not a worker's) and otherwise
   * states the taxonomy without a fake availability claim. No worker is consulted.
   */
  function answerCapabilities(): RouterAnswer {
    const live = liveCapabilityFacts();
    const text = renderCapabilities(live);
    return {
      intent: "capability.list",
      text,
      data: {
        direct: KAI_DIRECT_CAPABILITIES.map((cap) => cap.id),
        workers: [...KAI_WORKERS],
        availability: live ?? null,
      },
      fromState: true,
    };
  }

  /** Answer "what can you not do?", AS KAI, from KAI's stated limits. */
  function answerLimits(): RouterAnswer {
    return {
      intent: "capability.limits",
      text: renderLimits(),
      data: { limits: true },
      fromState: true,
    };
  }

  /**
   * Answer "do you have a harness?" from KAI's OWN runtime architecture. KAI runs on
   * its own Core, loads its identity from KAI_HOME, and delegates to workers; its
   * harness is not Hermes's harness and does not require one to exist.
   */
  function answerHarness(): RouterAnswer {
    const text =
      "Yes — I have my own harness, and it isn't Hermes's. I run as KAI Core, my own " +
      "Node/TypeScript runtime on this machine, served over loopback to the KAI desktop app. " +
      "My identity, user context, memory and rules are loaded from my own KAI_HOME resources, " +
      `not from a worker. When a task needs a model or a tool I don't hold, I delegate to a worker — ${KAI_WORKERS.join(", ")}.`;
    return { intent: "harness", text, data: { harness: "kai-core" }, fromState: true };
  }

  /**
   * Answer the independence questions ("can you work without Hermes?", "what happens
   * if Hermes is offline?", "are you connected to Hermes?") from KAI's real
   * architecture. KAI does not depend on a worker to exist, boot, know who it is or
   * speak; a named worker's live state is reported when the registry knows it.
   */
  async function answerIndependence(t: string): Promise<RouterAnswer> {
    const named = KNOWN_AGENT_IDS.find((id) => new RegExp(`\\b${id}\\b`).test(t));
    const parts: string[] = [];
    parts.push(
      "No — I don't need a worker to exist, to boot, to know who I am or to speak. " +
        "My identity and my runtime are my own; a worker is an ability I can use, never what I am.",
    );
    parts.push(
      "Workers are " + WORKER_RELATIONSHIP.workers.join(", ") + ". " + WORKER_RELATIONSHIP.rule,
    );
    if (named !== undefined) {
      const label = WORKER_LABEL[named] ?? named;
      const health = await healthOrNull();
      const agent = health?.agents.find((a) => a.id === named);
      if (agent === undefined) {
        parts.push(`If ${label} is not connected, I stay up as KAI; the task that needs it reports the worker unavailable rather than failing silently.`);
      } else {
        parts.push(`Right now ${label} is ${agent.state}; either way I remain KAI and will say if it is unavailable.`);
      }
    } else {
      parts.push("If every worker is offline I still boot, identify as KAI, load my soul and talk to you; only tasks that genuinely need a worker become unavailable, and I say so.");
    }
    return {
      intent: "independence",
      text: parts.join(" "),
      data: named !== undefined ? { worker: named } : null,
      fromState: true,
    };
  }

  /**
   * Explicit `@` invocation: leading `@agent`/`@skill` tokens route the turn
   * instead of becoming prose. Returns the answer when the invocation decides
   * the turn, or `skillPrologue` (skill bodies for the brain's system prompt)
   * when the turn still goes to normal chat. Anything ambiguous or unresolvable
   * is answered plainly with the interpretation — never executed silently.
   */
  async function answerInvocation(
    rawText: string,
  ): Promise<{ answer?: RouterAnswer; skillPrologue?: string; skillIds?: string[]; agentIds?: string[] }> {
    if (ctx.invocations === undefined) return {};
    const parsed = parseInvocations(rawText);
    if (parsed === null) return {};
    const resolved = resolveInvocations(parsed, {
      agents: ctx.invocations.agents(),
      skills: ctx.invocations.skills(),
    });
    const interpretation = { agents: resolved.agents, skills: resolved.skills };
    if (resolved.content.length === 0) {
      return {
        answer: {
          intent: "unknown",
          text: "That's an invocation with no task — tell me what to do after the @name.",
          data: interpretation,
          fromState: true,
          invocation: interpretation,
        },
      };
    }
    if (resolved.unknown.length > 0) {
      return {
        answer: {
          intent: "unknown",
          text:
            `I don't know ${resolved.unknown.map((name) => `@${name}`).join(", ")} — ` +
            "name a real agent or skill after @, or drop the @ to talk normally.",
          data: interpretation,
          fromState: true,
          invocation: interpretation,
        },
      };
    }
    if (resolved.disabledSkills.length > 0) {
      return {
        answer: {
          intent: "unknown",
          text: `The skill "${resolved.disabledSkills[0]}" is disabled — enable it before invoking it. Nothing ran.`,
          data: interpretation,
          fromState: true,
          invocation: interpretation,
        },
      };
    }
    if (resolved.agents.length > 1) {
      return {
        answer: {
          intent: "unknown",
          text:
            `You named ${resolved.agents.length} agents (${resolved.agents.join(", ")}) — ` +
            "I run one agent per turn, so pick one and I'll run it.",
          data: interpretation,
          fromState: true,
          invocation: interpretation,
        },
      };
    }
    if (resolved.agents.length === 1) {
      // USE the agent: the task (plus any skill guidance) runs AS the persona
      // through the policy-governed run path. A park comes back as an approval
      // the UI can Allow — the work never runs silently.
      const agentId = resolved.agents[0]!;
      const guides: string[] = [];
      for (const skillId of resolved.skills) {
        const loaded = ctx.invocations.loadSkill(skillId);
        if (!loaded.ok) {
          return {
            answer: {
              intent: "unknown",
              text: `I couldn't load the skill "${skillId}": ${loaded.reason}. Nothing ran.`,
              data: interpretation,
              fromState: true,
              invocation: interpretation,
            },
          };
        }
        guides.push(`Skill ${loaded.name} guidance:\n${loaded.body.slice(0, 4000)}`);
      }
      const ran = await ctx.invocations.runAgent({
        id: agentId,
        task: resolved.content,
        ...(guides.length > 0 ? { skillContext: guides.join("\n\n") } : {}),
      });
      if (ran.ok) {
        return {
          answer: {
            intent: "unknown",
            text: ran.reply,
            data: { ...interpretation, guarded: ran.guarded },
            fromState: false,
            brain: undefined,
            invocation: interpretation,
          },
        };
      }
      if (ran.parked === true) {
        return {
          answer: {
            intent: "unknown",
            text:
              `I handed "${resolved.content.slice(0, 120)}" to ${agentId}, ` +
              "but the run is waiting for your approval — Allow it and I'll collect the result.",
            data: interpretation,
            fromState: false,
            invocation: interpretation,
            agentRun: { subagentId: agentId, approvalId: ran.approvalId, reason: ran.reason },
          },
        };
      }
      return {
        answer: {
          intent: "unknown",
          text: `I couldn't run ${agentId}: ${ran.reason}. Nothing ran.`,
          data: interpretation,
          fromState: true,
          invocation: interpretation,
        },
      };
    }
    // Skills only: force-load each body into this turn's system prompt. The
    // turn still goes through KAI's brain — the skill guides it.
    const guides: string[] = [];
    for (const skillId of resolved.skills) {
      const loaded = ctx.invocations.loadSkill(skillId);
      if (!loaded.ok) {
        return {
          answer: {
            intent: "unknown",
            text: `I couldn't load the skill "${skillId}": ${loaded.reason}. Nothing ran.`,
            data: interpretation,
            fromState: true,
            invocation: interpretation,
          },
        };
      }
      guides.push(`## Active skill: ${loaded.name}\n${loaded.body.slice(0, 4000)}`);
    }
    return {
      skillPrologue: guides.join("\n\n"),
      skillIds: resolved.skills,
      agentIds: [],
    };
  }

  async function answerUnknown(rawText: string, sessionId?: string): Promise<RouterAnswer> {
    const t = normalize(rawText);
    const avoid = avoidWorker(t);

    // ── EXPLICIT INVOCATION first: `@agent`/`@skill` decide the turn before
    // normal chat is even considered.
    const invoked = await answerInvocation(rawText);
    if (invoked.answer !== undefined) return invoked.answer;

    // ── NORMAL CHAT: KAI answers from its OWN model provider ────────────────
    //
    // This is the architectural correction. When KAI's own reasoning loop is
    // wired, an ordinary conversational turn is KAI's OWN inference: the model
    // receives KAI's identity/context (composed by KAI Core: safety -> identity ->
    // memory -> skills -> request) and KAI speaks its result. NO worker is
    // consulted here, so `normal_chat_calls_to_hermes` stays 0 with Hermes fully
    // stopped. The user's own message is sent, not a normalised copy.
    //
    // `avoid` is still honoured: a "don't use Hermes" constraint is about
    // delegation, and the brain never delegates, so it is trivially satisfied.
    if (ctx.brain !== undefined && ctx.brain.available()) {
      const described = ctx.brain.describe();
      let system = identitySelfDescription();
      if (ctx.composePrompt !== undefined) {
        try {
          system = await ctx.composePrompt(
            rawText,
            ...(sessionId !== undefined ? [{ sessionId } as { sessionId: string }] : []),
          );
        } catch {
          // A composer failure degrades to KAI's soul line — never to a worker.
          system = identitySelfDescription();
        }
      }
      // An explicitly invoked skill rides AFTER the composed prompt: same
      // safety/identity/memory context, plus the skill the user named.
      if (invoked.skillPrologue !== undefined && invoked.skillPrologue.length > 0) {
        system = `${system}\n\n${invoked.skillPrologue}`;
      }
      // The task lifecycle wraps the brain call: the objective survives the
      // turn, "continue" resumes open work, and completion is verified —
      // a tool execution is never mistaken for a deliverable.
      const begun = beginTurn(ctx.tasks, sessionId, rawText);
      if (ctx.tasks !== undefined && begun.taskId !== null) ctx.tasks.move(begun.taskId, "EXECUTING");
      try {
        const result = await ctx.brain.respond({
          text: begun.effectiveText,
          system,
          ...(begun.objective !== begun.effectiveText ? { objective: begun.objective } : {}),
          ...(sessionId !== undefined ? { sessionId } : {}),
        });
        const finished = finishTurn(ctx.tasks, begun, {
          text: result.text,
          toolCalls: result.toolCalls,
          toolIterations: result.toolIterations,
          toolBudgetExhausted: result.toolBudgetExhausted,
          synthesized: result.synthesized,
          ...(result.pendingTools !== undefined ? { pendingTools: result.pendingTools } : {}),
        });
        return {
          intent: "unknown",
          text: finished.replyText,
          data: { provider: result.provider, model: result.model },
          fromState: false,
          brain: { provider: result.provider, model: result.model },
          ...(result.toolCalls !== undefined && result.toolCalls.length > 0 ? { toolCalls: result.toolCalls } : {}),
          toolIterations: result.toolIterations,
          toolBudgetExhausted: result.toolBudgetExhausted,
          ...(result.synthesized ? { synthesized: true } : {}),
          ...(result.pendingTools !== undefined && result.pendingTools.length > 0 ? { pendingTools: result.pendingTools } : {}),
          taskState: finished.state,
          ...((invoked.skillIds !== undefined && invoked.skillIds.length > 0) || (invoked.agentIds !== undefined && invoked.agentIds.length > 0)
            ? { invocation: { agents: invoked.agentIds ?? [], skills: invoked.skillIds ?? [] } }
            : {}),
        };
      } catch (error) {
        // KAI's OWN provider failed. This is NOT a Hermes failure and must never
        // be reported as one: KAI says its own inference is unavailable, in its
        // own voice, and the state/identity surfaces still work.
        if (ctx.tasks !== undefined && begun.taskId !== null) ctx.tasks.move(begun.taskId, "BLOCKED");
        const reason = brainFailureReason(error);
        return {
          intent: "unknown",
          text: brainFailureReply(reason),
          data: { provider: described.provider, model: described.model, error: reason },
          fromState: false,
          taskState: "BLOCKED",
        };
      }
    }

    // ── No brain wired: the pre-existing worker fallback ────────────────────
    const health = await healthOrNull();
    const agents = health?.agents ?? [];

    const connected = (agent: AgentStatus | undefined): boolean =>
      agent !== undefined && agent.state !== "offline";
    const statusOf = (id: WorkerId): AgentStatus | undefined => agents.find((agent) => agent.id === id);

    // A task turn KAI does not recognise as a state question: KAI delegates it to
    // a connected worker it is ALLOWED to use — never the one the user ruled out.
    const candidate = KNOWN_AGENT_IDS.filter((id) => id !== avoid).find((id) => connected(statusOf(id)));

    if (candidate !== undefined) {
      return {
        intent: "unknown",
        text: `I don't have a rule for that. ${AGENT_LABEL[candidate] ?? candidate} is connected and can handle it.`,
        fromState: false,
        delegateTo: candidate,
        ...(avoid !== undefined ? { avoid } : {}),
      };
    }
    // Nothing can take the turn. KAI still answers — this is the fallback
    // guarantee: never "router fails → worker stalls → no response".
    const text =
      avoid !== undefined
        ? `I don't have a rule for that, and you asked me not to use ${AGENT_LABEL[avoid] ?? avoid}. ` +
          "No other worker is connected right now, so I can't hand it off — tell me how you'd like to proceed."
        : "I don't have a rule for that, and no agent is connected right now, so I can't hand it off.";
    return {
      intent: "unknown",
      text,
      fromState: false,
      ...(avoid !== undefined ? { avoid } : {}),
    };
  }

  async function answer(text: string, opts?: { sessionId?: string }): Promise<RouterAnswer> {
    const t = normalize(text);
    const intent = classify(text);
    const sessionId = opts?.sessionId;
    switch (intent) {
      case "identity":
        return answerIdentity(t);
      case "capability.list":
        return answerCapabilities();
      case "capability.limits":
        return answerLimits();
      case "harness":
        return answerHarness();
      case "independence":
        return answerIndependence(t);
      case "status.summary":
        return answerStatusSummary();
      case "agent.status":
        return answerAgentStatus(t);
      case "agent.list":
        return answerAgentList();
      case "task.delegate":
        return answerTaskDelegate(t);
      case "mission.list":
        return answerMissionList(t);
      case "approval.list":
        return answerApprovalList();
      case "notification.list":
        return answerNotificationList();
      case "memory.list":
        return answerMemoryList();
      case "memory.remember":
        return answerMemoryRemember(text);
      case "artifact.run_tests":
        return answerRunTests();
      case "unknown":
        return answerUnknown(text, sessionId);
      default:
        return answerUnknown(text, sessionId);
    }
  }

  return { classify, answer, intents, selfDescription: identitySelfDescription };
}
