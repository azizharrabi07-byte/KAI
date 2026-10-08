/**
 * Pushes KAI Core's state onto the island's EXISTING surfaces.
 *
 * Deliberately not a new panel: the pills, the note bubble and the approval card
 * already exist, are already sized, and are already what a person looks at. What
 * changes is where their contents come from — the Core, which is authoritative — and
 * the phase spec is explicit that this must not become a redesign.
 *
 * Three behaviours, all restrained on purpose (a companion that interrupts constantly
 * is worse than one that says nothing):
 *
 *   agents       → the Hermes/OpenCode pills follow the Core's own view of those agents
 *   notifications→ a new one sets the note bubble and, only if the island is idle on
 *                  the overview, shows it; never a forced interruption mid-chat
 *   approvals    → a pending Core approval uses the existing approval card, and the
 *                  buttons are routed to the Core instead of to the Claude Code relay
 */

import type { Island } from "./island";
import { State } from "../core/state";
import type { CoreLink } from "../core/core-boot";
import type { BotStateName } from "../core/layout";
import type { SessionCommand } from "../views/views";
import {
  createCompanionController,
  type CompanionRequest,
  type SurfaceFocuser,
} from "./companion";

/** The pills that stand for a Core agent. */
const PILL_FOR_AGENT: Record<string, string> = {
  hermes: "integration_hermes",
  opencode: "integration_opencode",
};

/** The Core's agent states, as the pill/bot state machine names them. */
function pillStateFor(coreState: string): BotStateName {
  switch (coreState) {
    case "working":
    case "running":
      return "working";
    case "error":
      return "error";
    case "starting":
    case "connecting":
      return "thinking";
    // "offline" and "idle" both mean "not doing anything"; the pill's dot already
    // distinguishes configured/not, and inventing a state would be a lie.
    case "offline":
    case "idle":
    default:
      return "idle";
  }
}

/**
 * The approval buttons live in island.ts's `decide` action. The Core's approvals must go
 * to the Core, not to the Claude Code relay, so the island asks here first. Kept as a
 * module-level hook rather than an import of the link into island.ts, which would make
 * the island depend on the network layer.
 */
let coreApprovalDecider: ((requestId: string, decision: "allow" | "deny") => boolean) | null = null;

export function decideCoreApproval(requestId: string, decision: "allow" | "deny"): boolean {
  return coreApprovalDecider?.(requestId, decision) ?? false;
}

/**
 * The sessions view's buttons live in views.ts; the Core client must not be imported
 * there (a view reaching for the network would break the "one transport, one place"
 * rule). So island.ts calls this module-level hook, which attachCoreLink fills in.
 */
let coreSessionRequester: ((cmd: SessionCommand) => boolean) | null = null;

export function requestCoreSession(cmd: SessionCommand): boolean {
  return coreSessionRequester?.(cmd) ?? false;
}

/**
 * Run one task AS a subagent. The subagent view's Run button calls this; the hook
 * POSTs `/subagents/:id/run`, which is EXTERNAL and parks for approval — the run
 * then shows up in the approvals snapshot the panel already renders.
 */
let coreSubagentRunner: ((id: string, input: string) => boolean) | null = null;

export function requestSubagentRun(id: string, input: string): boolean {
  return coreSubagentRunner?.(id, input) ?? false;
}

/**
 * The island's companion actions. A person acting on the island (approve, reject,
 * cancel, open KAI, focus a mission) is routed here; `attachCoreLink` fills this
 * in with a controller bound to the SAME Core client the main workspace uses, so
 * the action lands on the ONE approval/mission both surfaces see. Kept as a
 * module-level hook for the same reason as the others: the island must not import
 * the network layer.
 */
let companionRequester: ((req: CompanionRequest) => boolean) | null = null;

export function requestCompanionAction(req: CompanionRequest): boolean {
  return companionRequester?.(req) ?? false;
}

/**
 * The main UI from the island's view — `window.__kaiWorkspace`, set by
 * `workspace/mount.ts`. Optional and guarded: in a browser, or before the
 * workspace mounts, opening KAI is a no-op rather than a crash. Navigation is not
 * policy, so it is a callback rather than a Core call.
 */
/**
 * Invoke a Tauri command from the island window without importing the Tauri API
 * (the island bundle stays free of it; the internals are present in the webview).
 * Returns undefined outside Tauri, so a browser build is a no-op and never a crash.
 */
function invokeTauri(command: string): Promise<unknown> | undefined {
  const internals = (
    globalThis as unknown as {
      __TAURI_INTERNALS__?: { invoke?: (cmd: string, args?: unknown) => Promise<unknown> };
    }
  ).__TAURI_INTERNALS__;
  try {
    return internals?.invoke?.(command, {});
  } catch {
    return undefined;
  }
}

function defaultSurfaceFocuser(): SurfaceFocuser {
  const workspace = (): { show?: (tab?: string) => void } | undefined =>
    (globalThis as unknown as { __kaiWorkspace?: { show?: (tab?: string) => void } }).__kaiWorkspace;
  return {
    openKai() {
      // Two paths, because the island and the main window are now different
      // windows. In a plain browser, or before a workspace has mounted in-page,
      // there is nothing here to show — so fall through to the real thing: the
      // Rust `open_main_window` command that creates the main window.
      //
      // Without this fallback "Open KAI" was a DEAD END: it reached
      // `globalThis.__kaiWorkspace`, which is set only by `mountWorkspace`, and
      // the island entry never calls it. The command existed and worked from the
      // tray and the single-instance path; only the island's own button did
      // nothing.
      try {
        const ws = workspace();
        if (ws?.show) {
          ws.show();
          return;
        }
      } catch {
        /* fall through to the Tauri command */
      }
      void invokeTauri("open_main_window");
    },
    focus(target) {
      try {
        const ws = workspace();
        if (!ws?.show) return;
        // The workspace's own tab ids (views/workspace-panels.ts WorkspaceTab):
        // an approval lives on the approvals tab; a mission / conversation /
        // subagent is activity.
        const tab = target === "approval" ? "approvals" : target === "workspace" ? undefined : "activity";
        ws.show(tab);
      } catch {
        /* never let navigation break an action */
      }
    },
  };
}

export function attachCoreLink(island: Island, link: CoreLink): () => void {
  let agentStates: Record<string, string> = {};
  let lastNotificationId: string | null = null;
  let lastMissionEventId: string | null = null;
  let lastShownConn: string | null = null;
  /** True while the note bubble is showing a Core-connection message, so a
   *  reconnect may clear it without wiping a mission's note. */
  let noteIsAboutConnection = false;
  let shownApprovalId: string | null = null;
  let syncing = false;

  coreApprovalDecider = (requestId, decision) => {
    const approval = State.core.approvals.find((a) => a.id === requestId);
    if (approval === undefined) return false;
    // Optimistic local settle so the card leaves at once; the Core's own
    // approval.approved/rejected event is what makes it permanent.
    void link.client.decideApproval(requestId, decision === "allow");
    State.pendingApproval = null;
    State.setPillBadge("integration_hermes", null);
    State.notify();
    return true;
  };

  coreSessionRequester = (cmd) => {
    // Fire-and-forget: run the mutation, then re-read the snapshot so the view
    // converges on what Core actually stored rather than a local guess that
    // could drift. A failed call is not special-cased here — refresh() is the
    // same reconciliation the rest of the link uses.
    void (async () => {
      try {
        switch (cmd.op) {
          case "create":
            await link.client.createSession(cmd.title !== undefined ? { title: cmd.title } : {});
            break;
          case "activate":
            await link.client.activateSession(cmd.id);
            break;
          case "rename":
            await link.client.renameSession(cmd.id, cmd.title);
            break;
          case "archive":
            await link.client.archiveSession(cmd.id);
            break;
          case "unarchive":
            await link.client.unarchiveSession(cmd.id);
            break;
        }
      } finally {
        await link.refresh();
      }
    })();
    return true;
  };

  coreSubagentRunner = (id, input) => {
    // Fire-and-forget: run the persona's task, then re-read the snapshot so the
    // parked approval and the persona's status converge on what Core actually did.
    void (async () => {
      try {
        await link.client.runSubagent(id, input);
      } finally {
        await link.refresh();
      }
    })();
    return true;
  };

  // The companion actions execute through the SAME Core client the workspace
  // decides approvals with, so an approval taken from the island acts on the one
  // the main UI shows. `execute()` is fire-and-forget at this seam because the
  // action route (the attention surface's click) is synchronous; the controller
  // itself is awaited internally and refreshes the shared mirror.
  const companion = createCompanionController({
    client: link.client,
    refresh: link.refresh,
    focuser: defaultSurfaceFocuser(),
  });
  companionRequester = (req) => {
    void companion.execute(req);
    return true;
  };

  /**
   * The selected subagent's OWN state — `GET /subagents/:id` (persona + the sessions
   * bound to it). Held in `State.subagentDetail`, and re-read whenever the selection
   * changes or the approval poll ticks, so the view is never a stale guess.
   */
  let loadedSubagentId: string | null | undefined = undefined;
  let loadingSubagent = false;
  async function loadSubagentDetail(id: string): Promise<void> {
    if (loadingSubagent) return;
    loadingSubagent = true;
    try {
      const res = await link.client.subagent(id);
      // The selection may have moved while the request was in flight.
      if (State.selectedSubagentId !== id) return;
      if (!res.ok) {
        State.setSubagentDetail(null);
        return;
      }
      const s = res.value.subagent;
      State.setSubagentDetail({
        subagent: {
          id: s.id,
          name: s.name,
          role: s.role,
          soul: s.soul,
          workerId: s.workerId,
          capabilities: s.capabilities,
          employeeId: s.employeeId,
          status: s.status,
          enabled: s.enabled,
          problems: s.problems,
          createdAt: s.createdAt,
          ...(s.model !== undefined ? { model: s.model } : {}),
          ...(s.visual !== undefined ? { visual: s.visual } : {}),
          ...(s.instanceId !== undefined ? { instanceId: s.instanceId } : {}),
        },
        sessions: res.value.sessions,
      });
    } finally {
      loadingSubagent = false;
    }
  }

  function sync(): void {
    if (syncing) return;
    syncing = true;
    try {
      // ── the runtime state machine ────────────────────────────────────────────
      // KAI's own state is driven by the Core's REAL events, not by the focused
      // worker. Every event in the bounded ring is offered to the machine, which
      // dedupes by id — so a reconnect replaying a frame cannot double-count, and
      // several events arriving between two syncs are all applied in order.
      island.observeConnection(State.core.conn);

      // ── the selected subagent's OWN state ────────────────────────────────────
      // Selecting a subagent reads ITS OWN detail (`GET /subagents/:id`); KAI's
      // conversation is never merged into it, and one subagent's detail is never
      // left on screen while another is selected.
      const selSub = State.selectedSubagentId;
      if (selSub !== loadedSubagentId) {
        loadedSubagentId = selSub;
        if (selSub === null) State.setSubagentDetail(null);
        else void loadSubagentDetail(selSub);
      }
      for (let i = State.core.recentEvents.length - 1; i >= 0; i--) {
        const e = State.core.recentEvents[i];
        if (e === undefined) continue;
        // Carry the PAYLOAD, not just the envelope: a Core notification is
        // published as `notification.created` with its semantic type nested in
        // `payload.type`, and the runtime machine resolves that nested type. A
        // forward that dropped the payload made every such event a no-op.
        island.observeCoreEvent({
          type: e.type,
          ...(e.id !== undefined ? { id: e.id } : {}),
          timestamp: e.at,
          ...(e.payload !== undefined ? { payload: e.payload } : {}),
        });
      }

      // ── agents → pills ────────────────────────────────────────────────────────
      for (const agent of State.core.agents) {
        const pillId = PILL_FOR_AGENT[agent.id];
        if (pillId === undefined) continue;
        if (agentStates[agent.id] === agent.state) continue;
        agentStates[agent.id] = agent.state;
        State.updateTask(pillId, pillStateFor(agent.state));
        // An agent that went bad is worth a badge on its own pill, and nothing more.
        State.setPillBadge(pillId, agent.state === "error" ? "error" : null);
      }

      // ── the connection itself, made visible ────────────────────────────────
      // Tracked state that nothing renders is not much use: the phase spec asks for
      // "Core offline / Reconnecting…" to be visible, and a companion that silently
      // stops knowing anything is worse than one that says so.
      const conn = State.core.conn;
      if (conn !== lastShownConn) {
        lastShownConn = conn;
        if (conn === "ONLINE") {
          if (noteIsAboutConnection) {
            noteIsAboutConnection = false;
            State.noteMessage = null;
          }
        } else {
          State.noteMessage =
            conn === "DEGRADED"
              ? "KAI Core is connected but not sending events"
              : "KAI Core is not running — reconnecting…";
          noteIsAboutConnection = true;
          const idleOnOverview = State.view === "overview" || State.view === "empty";
          if (idleOnOverview) island.alert("note");
          else State.notify();
        }
      }

      // ── a new notification → the note bubble ────────────────────────────────
      const newest = State.core.notifications.find((n) => !n.read);
      if (newest !== undefined && newest.id !== lastNotificationId) {
        lastNotificationId = newest.id;
        State.noteMessage = newest.title;
        // Only take the screen when the island is not in the middle of something the
        // user is doing. A mission finishing while they read the chat is not an
        // emergency; it waits in the note.
        const idleOnOverview = State.view === "overview" || State.view === "empty";
        if (idleOnOverview && (newest.priority === "HIGH" || newest.priority === "CRITICAL")) {
          island.alert("note");
        } else {
          State.notify();
        }
      }

      // ── a mission finishing → the note bubble ──────────────────────────────
      // The Core's mission events are otherwise invisible: a mission can start and end
      // while the island shows nothing, which would make the whole control plane look
      // inert. Only terminal transitions speak, so a long mission does not narrate
      // every step.
      const newestEvent = State.core.recentEvents[0];
      if (
        newestEvent !== undefined &&
        newestEvent.id !== undefined &&
        newestEvent.id !== lastMissionEventId &&
        (newestEvent.type === "mission.completed" ||
          newestEvent.type === "mission.failed" ||
          newestEvent.type === "mission.cancelled")
      ) {
        lastMissionEventId = newestEvent.id;
        State.noteMessage = newestEvent.text;
        const idleOnOverview = State.view === "overview" || State.view === "empty";
        if (idleOnOverview) island.alert("note");
        else State.notify();
      }

      // ── a pending approval → the existing card ─────────────────────────────
      const pending = State.core.approvals.find((a) => a.status === "PENDING");
      if (pending === undefined) {
        // The list is boot-time state, so an approval asked for since boot is invisible
        // unless we look. Gating this on an `approval.requested` event did NOT work in
        // practice — verified against the running island over its debugger, where a
        // post-boot approval produced no card at all. So the timer below does the looking.
      }
      if (pending !== undefined && pending.id !== shownApprovalId) {
        shownApprovalId = pending.id;
        // Never clobber an approval the Claude Code relay is already holding.
        if (State.pendingApproval === null) {
          State.pendingApproval = {
            requestId: pending.id,
            sessionId: "",
            tool: pending.toolId,
            command: pending.reason.length > 0 ? pending.reason : pending.action,
          };
          State.setPillBadge("integration_hermes", "approval");
          island.alert("approval");
        }
      }
      if (pending === undefined && shownApprovalId !== null && State.pendingApproval !== null) {
        // The Core settled it (or it expired) while the card was up. The card has to go with
        // it: clearing the state alone left a live-looking Allow button whose request no
        // longer existed, and every click on it did nothing at all.
        shownApprovalId = null;
        State.setPillBadge("integration_hermes", null);
        island.dismissApprovalCard();
      }
    } finally {
      syncing = false;
    }
  }

  /**
   * A pending approval has to be able to appear AFTER boot.
   *
   * `State.core.approvals` is filled by the boot snapshot; an approval requested later arrives
   * as an event, and if that event does not add it to the list then no card is ever shown — the
   * island simply looks inert while a real question waits unanswered. So when an
   * `approval.requested` event arrives and the list holds nothing pending, ask the Core
   * directly. Bounded and fire-and-forget: a failed refresh must never break the island.
   */
  let refreshing = false;
  let lastRefreshAt = 0;
  async function refreshPendingApproval(): Promise<void> {
    const now = Date.now();
    if (refreshing || now - lastRefreshAt < 2_000) return;
    refreshing = true;
    lastRefreshAt = now;
    try {
      const res = await link.client.approvals({ status: "PENDING" });
      if (!res.ok) return;
      const pending = res.value.find((a) => a.status === "PENDING");
      if (pending === undefined || State.pendingApproval !== null) return;
      shownApprovalId = pending.id;
      State.pendingApproval = {
        requestId: pending.id,
        sessionId: "",
        tool: pending.toolId,
        command: pending.reason.length > 0 ? pending.reason : pending.action,
      };
      State.setPillBadge("integration_hermes", "approval");
      island.alert("approval");
    } catch {
      // A refresh that fails changes nothing; the card simply does not appear yet.
    } finally {
      refreshing = false;
    }
  }

  const unsubscribe = State.subscribe(sync);
  sync();

  /**
   * A bounded poll for pending approvals.
   *
   * `State.core.approvals` comes from the boot snapshot; an approval requested while the app
   * is already running never entered it, so no card appeared and a real question sat
   * unanswered. Verified against the running island: a post-boot approval showed nothing.
   * Five seconds is slow enough to be free and fast enough that a person does not sit
   * looking at an inert island, and the refresh is skipped whenever a card is already up.
   */
  const poll = setInterval(() => {
    void refreshPendingApproval();
    // Keep the selected subagent's OWN state live too: its status and the sessions
    // bound to it can change while the island sits on its view.
    const sel = State.selectedSubagentId;
    if (sel !== null) void loadSubagentDetail(sel);
  }, 5_000);

  return () => {
    unsubscribe();
    clearInterval(poll);
    coreApprovalDecider = null;
    coreSessionRequester = null;
    coreSubagentRunner = null;
    companionRequester = null;
  };
}
