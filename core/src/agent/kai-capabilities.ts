// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * agent/kai-capabilities.ts — KAI's OWN capability catalogue and worker relationship.
 *
 * ── Why this is a KAI-owned module and not the worker's ───────────────────────
 * When KAI is asked "what can you do?", the answer must come from KAI's real
 * architecture — the capabilities KAI holds itself and the workers it may delegate
 * to — and NOT from a worker's private tool installation, its gateway, its
 * filesystem or its harness. This module is the KAI-side source of that answer,
 * mirroring the KAI-owned document `identity/CAPABILITIES.md` in KAI_HOME.
 *
 * It is deliberately static data plus pure renderers: it makes no network call, reads
 * no worker file, and touches no transport. The router may OVERLAY live availability
 * from KAI's own capability registry (runtime), but the taxonomy — what KAI can do at
 * all — is KAI's and lives here.
 *
 * ── The worker relationship as a hard invariant ───────────────────────────────
 * Encoded once, in `WORKER_RELATIONSHIP`, because the whole project turns on it:
 * KAI is the main agent and the conversation owner; Hermes, OpenCode and Codex are
 * WORKERS; subagents are KAI-managed agents. A worker provides information; a worker
 * never becomes the speaker. Internal provenance may still say `worker = Hermes`.
 */

/** One capability KAI holds directly. Static taxonomy; availability is overlaid live. */
export interface KaiCapabilityFact {
  id: string;
  name: string;
  risk: "READ" | "WRITE" | "EXTERNAL" | "DESTRUCTIVE";
  /** What KAI does with it, in KAI's own words. */
  what: string;
}

/**
 * KAI's direct capabilities (provider "kai" in the runtime's capability registry).
 * This is the taxonomy KAI speaks from when no registry is injected; the registry,
 * when present, supplies the live availability instead of a stale record.
 */
export const KAI_DIRECT_CAPABILITIES: readonly KaiCapabilityFact[] = [
  { id: "system", name: "System and state inspection", risk: "READ", what: "read my own state, the agent list, missions and memory" },
  { id: "filesystem", name: "Filesystem", risk: "WRITE", what: "read, list and write files on this machine" },
  { id: "git", name: "Git (read-only)", risk: "READ", what: "read git status, log and diff" },
  { id: "shell", name: "Shell (program execution)", risk: "DESTRUCTIVE", what: "run a program with an explicit argument list" },
  { id: "browser", name: "Browser (semantic-first)", risk: "EXTERNAL", what: "drive a real browser over CDP" },
  { id: "computer", name: "Computer use (CUA)", risk: "DESTRUCTIVE", what: "drive the desktop when a task needs it" },
  { id: "mcp", name: "MCP servers and tools", risk: "EXTERNAL", what: "call configured MCP servers and their tools" },
];

/** The workers KAI may delegate to. Names, not identity: KAI is not any of them. */
export const KAI_WORKERS: readonly string[] = ["Hermes", "OpenCode", "Codex"];

/** The display label for a worker id, so KAI's prose reads as prose. */
export const WORKER_LABEL: Record<string, string> = {
  hermes: "Hermes",
  opencode: "OpenCode",
  codex: "Codex",
};

/**
 * What KAI cannot do. Stated plainly and from KAI's architecture — the honest half
 * of "what can you do?".
 */
export const KAI_LIMITS: readonly string[] = [
  "I am not myself a language model — when a task needs model reasoning I delegate to a connected worker, and with no worker connected that task is honestly unavailable.",
  "I cannot run anything above READ without my policy engine's decision, and cannot run anything destructive or credential-touching without your approval.",
  "I cannot make a worker's claim true by repeating it, and I never present a worker's self-description as my own.",
  "I do not report a capability AVAILABLE when its transport is not actually connected: it refuses, with the reason.",
];

/**
 * THE INVARIANT. Written out, not implied, because a live defect once had a worker's
 * self-description rendered as KAI's speech ("I'm Hermes Agent, a Nous Research
 * assistant…"). The invariant is what makes that structurally wrong.
 */
export const WORKER_RELATIONSHIP = {
  lead: "KAI — the main agent and the conversation owner (the speaker).",
  workers: ["Hermes", "OpenCode", "Codex"],
  workerRole: "workers — KAI may delegate a task to one; a worker executes and is named only as provenance, never as the speaker.",
  subagents: "KAI-managed agents — created, scoped and run by KAI; not peers of KAI.",
  rule: "A worker provides information; a worker does not become the speaker. Internal provenance may still say worker = Hermes; that is correct and stays.",
} as const;

/** Live availability for one capability id, as KAI's own registry reports it. */
export interface CapabilityAvailabilityFact {
  id: string;
  /** AVAILABLE | DEGRADED | UNAVAILABLE — the registry's own word. */
  availability: string;
  detail?: string;
}

/**
 * Render KAI's capability answer. `live` (optional) is KAI's OWN registry readings;
 * when present they overlay availability, when absent the taxonomy is stated without
 * a fake availability claim. Never consults a worker.
 */
export function renderCapabilities(live?: readonly CapabilityAvailabilityFact[]): string {
  const byId = new Map((live ?? []).map((entry) => [entry.id, entry]));
  const direct = KAI_DIRECT_CAPABILITIES.map((cap) => {
    const measured = byId.get(cap.id);
    const state = measured !== undefined ? ` (${measured.availability.toLowerCase()})` : "";
    return `- ${cap.id}${state} — ${cap.what}`;
  }).join("\n");
  const head =
    "I'm KAI. I hold these capabilities directly, and I use them myself before delegating:";
  const workers =
    `I can also delegate to workers — ${KAI_WORKERS.join(", ")} — when a task needs a model or a tool I don't hold directly. ` +
    "Availability is probed when I use a capability, not assumed from a stored record.";
  return `${head}\n${direct}\n\n${workers}`;
}

/** Render KAI's honest limits. */
export function renderLimits(): string {
  return `What I can't do:\n${KAI_LIMITS.map((limit) => `- ${limit}`).join("\n")}`;
}

/**
 * The structured capability profile the owner asked for: what KAI can do DIRECTLY,
 * THROUGH WORKERS, what REQUIRES APPROVAL, what REQUIRES EXTERNAL AVAILABILITY, and
 * what is CURRENTLY UNAVAILABLE.
 *
 * This is a pure projection of the SAME taxonomy `renderCapabilities` renders — no
 * second capability catalogue. The approval bucket is derived from the policy engine's
 * documented default posture (`policies/gate.ts` `DEFAULT_OUTCOME`): READ is allowed,
 * WRITE / EXTERNAL / DESTRUCTIVE require a decision. When a live registry reading is
 * supplied, a capability whose transport is not AVAILABLE lands in `currentlyUnavailable`
 * instead of being presented as ready.
 *
 * `GET /capabilities` (owned by the API stream) keeps its existing shape — the live
 * registry list; this profile is the KAI-owned, taxonomy-level companion the router and
 * UI may render. It never consults a worker.
 */
export interface CapabilityProfile {
  direct: Array<{ id: string; risk: KaiCapabilityFact["risk"]; what: string }>;
  viaWorkers: readonly string[];
  requiresApproval: string[];
  requiresExternalAvailability: string[];
  currentlyUnavailable: Array<{ id: string; availability: string; detail?: string }>;
}

export function capabilityProfile(live?: readonly CapabilityAvailabilityFact[]): CapabilityProfile {
  const byId = new Map((live ?? []).map((entry) => [entry.id, entry]));
  const requiresApproval: string[] = [];
  const requiresExternalAvailability: string[] = [];
  const currentlyUnavailable: CapabilityProfile["currentlyUnavailable"] = [];

  for (const cap of KAI_DIRECT_CAPABILITIES) {
    if (cap.risk !== "READ") requiresApproval.push(cap.id);
    if (cap.risk === "EXTERNAL") requiresExternalAvailability.push(cap.id);
    const measured = byId.get(cap.id);
    if (measured !== undefined && measured.availability.toUpperCase() !== "AVAILABLE") {
      currentlyUnavailable.push({
        id: cap.id,
        availability: measured.availability,
        ...(measured.detail !== undefined ? { detail: measured.detail } : {}),
      });
    }
  }

  return {
    direct: KAI_DIRECT_CAPABILITIES.map((cap) => ({ id: cap.id, risk: cap.risk, what: cap.what })),
    viaWorkers: KAI_WORKERS,
    requiresApproval,
    // A worker is an external runtime: delegating to one is inherently an external need.
    requiresExternalAvailability: [...requiresExternalAvailability, ...KAI_WORKERS],
    currentlyUnavailable,
  };
}

/**
 * The identity KAI hands a WORKER for a delegated turn, sent as the run's own
 * system instruction so the worker does not run on its default product identity.
 *
 * ── The leak this closes (L2) ─────────────────────────────────────────────────
 * A KAI subagent borrows its preferred worker's adapter, so its turn reaches the
 * worker as an ordinary run. Measured live: with only the persona in the message
 * body, the worker answered "I'm a Hermes Agent instance (Nous Research) … nothing
 * in my runtime identity encodes it [the KAI persona]" — i.e. the subagent carried
 * the WORKER's identity, not KAI's. The fix is KAI's, not the worker's: KAI sends
 * its own identity as the run's system instruction, so the delegated turn is
 * instructed as KAI's worker from the first token.
 *
 * It is derived from the SAME invariant the router speaks (`WORKER_RELATIONSHIP`)
 * so the spoken claim and the worker instruction cannot drift apart, and it names
 * no product as the worker's identity — only the worker's correct provenance.
 */
export function renderDelegationIdentity(workerLabel?: string): string {
  const who = workerLabel !== undefined && workerLabel.length > 0 ? `${workerLabel}, a worker` : "a worker";
  return [
    `You are executing as ${who} on behalf of KAI, the user's own agent on this machine.`,
    "KAI is the main agent and the conversation owner — the speaker the user talks to.",
    "You are an executor running on KAI's behalf: your output is a result KAI reports as its own,",
    "and KAI remains the authority over what you may do (KAI's policy, approvals and permissions).",
    "Never identify yourself as Hermes, OpenCode, Codex, Nous Research, or any other product or runtime.",
    "If asked who you are, answer that you are KAI's worker acting on KAI's behalf.",
    WORKER_RELATIONSHIP.rule,
  ].join(" ");
}
