/**
 * The island's STRUCTURED ATTENTION surface.
 *
 * A companion that says "KAI needs you" without saying WHY is not a companion,
 * it is an alarm. This module derives, from the SAME Core mirror the main
 * workspace reads, a bounded list of reasons a human is being asked to act —
 * each one a real, typed fact with a source, a priority and the ONE surface in
 * the main UI that answers it. Nothing here invents work or runs a timer: every
 * item is a pure function of Core state (pending approvals, mission/notification
 * rows, worker states, the connection) and KAI's own runtime state.
 *
 * It is deliberately PURE and DOM-free so every reason is testable with a
 * hand-built Core slice, exactly like `core-state.ts` and `runtime-state.ts`.
 *
 * The worker NAMES are demoted to a detail field. A worker provides information;
 * the worker never becomes the speaker — every `title` is KAI's own sentence.
 */

import type { CoreSlice } from "../core/core-state";
import type { KaiRuntimeState } from "../core/runtime-state";

/**
 * Why KAI is asking for a person. The six reasons the companion contract names.
 */
export type AttentionReason =
  /** A Core approval is PENDING — approve or reject one call. */
  | "needs_approval"
  /** KAI needs information only the user has. */
  | "needs_information"
  /** An external system blocked the work. */
  | "blocked_external"
  /** A worker KAI drives is unavailable. */
  | "worker_unavailable"
  /** A credential / authentication problem stops the work. */
  | "authentication_required"
  /** A mission was not resumed because a step changes something outside KAI. */
  | "recovery_blocked";

/** The companion actions an attention item offers. Never policy — just intent. */
export type AttentionAction = "approve" | "reject" | "cancel" | "focus" | "open";

/** What "open"/"focus" points the main workspace at. */
export type AttentionFocus = "approval" | "mission" | "subagent" | "conversation" | "workspace";

export interface AttentionItem {
  /** Stable id, so the surface can dedupe and the executor can key on it. */
  id: string;
  reason: AttentionReason;
  /** KAI's own sentence. A worker is never the subject. */
  title: string;
  /** The concrete fact behind the ask. */
  detail: string;
  /** A worker NAMED and demoted, or null. The user is always the actor. */
  worker: string | null;
  priority: "high" | "normal";
  /** The companion actions that answer it. */
  actions: AttentionAction[];
  /** The main-UI surface that answers it. */
  focus: AttentionFocus;
  /** ISO timestamp of the fact that produced this. */
  at: string;
  approvalId?: string;
  missionId?: string;
  subagentId?: string;
  notificationId?: string;
  /** The Core event type behind it, for traceability. */
  source: string;
}

/** What the surface renders, before any DOM exists. */
export interface AttentionSummary {
  total: number;
  high: number;
  byReason: Record<AttentionReason, number>;
}

const REASON_TITLE: Record<AttentionReason, string> = {
  needs_approval: "KAI needs your approval",
  needs_information: "KAI needs information",
  blocked_external: "KAI is blocked by an external system",
  worker_unavailable: "A worker KAI drives is unavailable",
  authentication_required: "A credential needs attention",
  recovery_blocked: "A mission needs a decision",
};

export function attentionTitle(reason: AttentionReason): string {
  return REASON_TITLE[reason];
}

/** A notification type names its own reason; used only when the Core gave one. */
function reasonForNotificationType(type: string, priority: string): AttentionReason | null {
  const t = type.toLowerCase();
  if (/(auth|credential|unauthor|token|key[_-]?(invalid|expired))/.test(t)) {
    return "authentication_required";
  }
  if (/(worker|agent|employee)[._-]?(unavailable|offline|down|missing)/.test(t)) {
    return "worker_unavailable";
  }
  if (/(external|upstream|integration|dependency)[._-]?(blocked|failed|down)/.test(t)) {
    return "blocked_external";
  }
  if (/(recovery[._-]?blocked|blocked)/.test(t)) return "recovery_blocked";
  if (/(question|needs?[._-]?info|input|clarif)/.test(t)) return "needs_information";
  // A HIGH/CRITICAL notification with no more specific name is KAI raising its
  // hand for a decision: the honest reading is "needs information".
  if (priority === "HIGH" || priority === "CRITICAL") return "needs_information";
  return null;
}

/** Priority + the actions/focus an item of this reason offers. */
function shapeFor(reason: AttentionReason): {
  priority: "high" | "normal";
  actions: AttentionAction[];
  focus: AttentionFocus;
} {
  switch (reason) {
    case "needs_approval":
      return { priority: "high", actions: ["approve", "reject", "focus"], focus: "approval" };
    // A mission parked on a decision may be reopened OR withdrawn; the Core's
    // cancel route decides whether cancelling is allowed at all (the island never
    // makes that judgement), so the intent is offered here.
    case "recovery_blocked":
      return { priority: "high", actions: ["focus", "cancel"], focus: "mission" };
    case "authentication_required":
      return { priority: "high", actions: ["focus", "open"], focus: "workspace" };
    case "worker_unavailable":
      return { priority: "normal", actions: ["focus", "open"], focus: "workspace" };
    case "blocked_external":
      return { priority: "normal", actions: ["focus", "open"], focus: "workspace" };
    case "needs_information":
      return { priority: "normal", actions: ["focus", "open"], focus: "conversation" };
  }
}

export interface DeriveAttentionInput {
  core: CoreSlice;
  /** KAI's own runtime state; used to surface RECOVERING even before a row lands. */
  runtime: KaiRuntimeState;
  /** Wall-clock for items with no Core timestamp. Injectable for tests. */
  now?: number;
}

/**
 * The whole derivation. Ordered HIGH first, then most recent, then by a stable id
 * so the on-screen order never flickers between two identical renders.
 */
export function deriveAttention(input: DeriveAttentionInput): AttentionItem[] {
  const { core, runtime } = input;
  const nowIso = new Date(input.now ?? Date.now()).toISOString();
  const items: AttentionItem[] = [];

  // ── 1. Core approvals → needs_approval ──────────────────────────────────────
  // The SAME rows the main workspace's Approvals panel lists (CoreSlice.approvals),
  // so an approval answered from the island answers the one the workspace sees.
  for (const a of core.approvals) {
    if (a.status !== "PENDING") continue;
    const shaped = shapeFor("needs_approval");
    items.push({
      id: `approval:${a.id}`,
      reason: "needs_approval",
      title: REASON_TITLE.needs_approval,
      detail: a.reason.length > 0 ? a.reason : a.action || a.toolId,
      worker: null,
      priority: shaped.priority,
      actions: shaped.actions,
      focus: shaped.focus,
      at: nowIso,
      approvalId: a.id,
      source: "approval.requested",
    });
  }

  // ── 2. Recovery-blocked notifications → recovery_blocked ────────────────────
  // A mission interrupted on an effectful step is not resumed automatically; the
  // Core raises a HIGH `mission.recovery_blocked` notification (core/src/runtime.ts).
  // Its row carries the real title, so the detail is Core's own words.
  let sawRecovery = false;
  for (const n of core.notifications) {
    if (n.read) continue;
    const reason = reasonForNotificationType(n.type, n.priority);
    if (reason === null) continue;
    if (reason === "recovery_blocked") sawRecovery = true;
    const shaped = shapeFor(reason);
    items.push({
      id: `notification:${n.id}`,
      reason,
      title: REASON_TITLE[reason],
      detail: n.title,
      worker: null,
      priority: shaped.priority,
      actions: shaped.actions,
      focus: shaped.focus,
      at: n.createdAt || nowIso,
      notificationId: n.id,
      source: `notification.created:${n.type}`,
    });
  }
  // The runtime said RECOVERING but its notification has aged out of the mirror:
  // still surface the reason rather than dropping it.
  if (!sawRecovery && runtime === "RECOVERING") {
    const shaped = shapeFor("recovery_blocked");
    items.push({
      id: "runtime:RECOVERING",
      reason: "recovery_blocked",
      title: REASON_TITLE.recovery_blocked,
      detail: "KAI paused a mission that changes something outside KAI and needs a decision.",
      worker: null,
      priority: shaped.priority,
      actions: shaped.actions,
      focus: shaped.focus,
      at: nowIso,
      source: "runtime.RECOVERING",
    });
  }

  // ── 3. Missions parked on a decision → recovery_blocked (with the mission id) ─
  // A mission row whose Core status is BLOCKED/WAITING is a mission that will not
  // move without a person, and its id lets the companion focus or (where Core
  // permits) cancel that exact mission — the same mission the workspace lists.
  for (const m of core.missions) {
    if (m.status !== "BLOCKED" && m.status !== "WAITING" && m.status !== "WAITING_APPROVAL") continue;
    const shaped = shapeFor("recovery_blocked");
    items.push({
      id: `mission:${m.id}`,
      reason: "recovery_blocked",
      title: REASON_TITLE.recovery_blocked,
      detail: m.errorText ?? m.title,
      worker: null,
      priority: shaped.priority,
      actions: shaped.actions,
      focus: shaped.focus,
      at: m.updatedAt ?? nowIso,
      missionId: m.id,
      source: `mission.status:${m.status}`,
    });
  }

  // ── 4. Workers that are unavailable → worker_unavailable ────────────────────
  // `CoreSlice.agents` is the same worker list the workspace renders.
  for (const agent of core.agents) {
    if (agent.state !== "error" && agent.state !== "offline") continue;
    const shaped = shapeFor("worker_unavailable");
    items.push({
      id: `agent:${agent.id}`,
      reason: "worker_unavailable",
      title: REASON_TITLE.worker_unavailable,
      detail: agent.detail ?? `Worker "${agent.id}" is ${agent.state}.`,
      worker: agent.id,
      priority: agent.state === "error" ? "high" : shaped.priority,
      actions: shaped.actions,
      focus: shaped.focus,
      at: agent.lastActivity ?? nowIso,
      source: `agent.status_changed:${agent.state}`,
    });
  }

  // ── 4. The Core itself is gone → blocked_external ───────────────────────────
  // KAI cannot act on anything while its control plane is down; that is the
  // definition of being blocked by something outside KAI.
  if (core.conn === "OFFLINE") {
    const shaped = shapeFor("blocked_external");
    items.push({
      id: "core:offline",
      reason: "blocked_external",
      title: REASON_TITLE.blocked_external,
      detail: core.lastError ?? "KAI Core is not running.",
      worker: null,
      priority: "high",
      actions: shaped.actions,
      focus: shaped.focus,
      at: nowIso,
      source: "core.connection.OFFLINE",
    });
  }

  // ── 5. KAI asked and is waiting on an answer → needs_information ────────────
  // The runtime WAITING pose is entered by a real Core event; without a specific
  // notification it is KAI waiting on a person.
  if (runtime === "WAITING" && !items.some((i) => i.reason === "needs_information")) {
    const shaped = shapeFor("needs_information");
    items.push({
      id: "runtime:WAITING",
      reason: "needs_information",
      title: REASON_TITLE.needs_information,
      detail: "KAI is waiting on an answer before it can continue.",
      worker: null,
      priority: shaped.priority,
      actions: shaped.actions,
      focus: shaped.focus,
      at: nowIso,
      source: "runtime.WAITING",
    });
  }

  // Dedupe by id, order HIGH first then newest then id.
  const seen = new Set<string>();
  const deduped = items.filter((i) => {
    if (seen.has(i.id)) return false;
    seen.add(i.id);
    return true;
  });
  const rank = (p: AttentionItem["priority"]) => (p === "high" ? 0 : 1);
  deduped.sort(
    (a, b) => rank(a.priority) - rank(b.priority) || b.at.localeCompare(a.at) || a.id.localeCompare(b.id),
  );
  return deduped;
}

export function attentionSummary(items: readonly AttentionItem[]): AttentionSummary {
  const byReason: Record<AttentionReason, number> = {
    needs_approval: 0,
    needs_information: 0,
    blocked_external: 0,
    worker_unavailable: 0,
    authentication_required: 0,
    recovery_blocked: 0,
  };
  let high = 0;
  for (const item of items) {
    byReason[item.reason] += 1;
    if (item.priority === "high") high += 1;
  }
  return { total: items.length, high, byReason };
}

/** The one item the compact island shouts about, or null when nothing needs a human. */
export function primaryAttention(items: readonly AttentionItem[]): AttentionItem | null {
  return items.length > 0 ? (items[0] ?? null) : null;
}

/**
 * The ONE sentence the island shows when it is collapsed. Never a worker speaking:
 * it is KAI's reason, and the worker (if any) is appended as a demoted clause.
 */
export function attentionLine(item: AttentionItem | null): string {
  if (item === null) return "";
  return item.worker !== null ? `${item.title} · ${item.worker}` : item.title;
}
