// The island: DOM shell, sizing animation, KAI placement, mouse handling.
// Mirrors IslandRootView.swift + IslandWindowController.swift.

import { Tracked, Spring, clamp } from "../core/anim";
import { Bridge, IS_TAURI, onDragDrop } from "../core/bridge";
import { invoke } from "@tauri-apps/api/core";
import {
  EXPANDED_CORNER, EXPANDED_W, NOTCH_W, PANEL_H, PANEL_W,
  ROUNDED_CORNER, VIEW_LAYOUTS, botGlowColor, botGlowOpacity, botPosition, chatPromptHeight,
  islandSize,
  type IslandMode, type IslandViewName,
} from "../core/layout";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import { decideCoreApproval, requestCompanionAction, requestCoreSession } from "./core-bridge";
import {
  KaiEngine,
  type KaiStateName,
} from "../character/engine";
import { Greeting } from "../character/greeting";
import { createMiniBot, pruneMiniBots, syncMiniBotStates, tickMiniBots } from "../character/minibots";
import { UploadCanvas } from "../upload/canvas";
import { USC, UploadSeq } from "../upload/sequence";
import { buildViews, type ViewActions, type ViewHost } from "../views/views";
import { h } from "../views/dom";
import { buildCompanionHeader } from "./header";
import { IslandStateMachine, KaiRuntimeMachine, type RuntimeConnection, type RuntimeEventInput } from "./fsm";

const BOT_OVERHANG = 40;
/** Same margin as the Rust hit test (src-tauri/src/island.rs). */
const HIT_MARGIN = 14;

/** The three views the drop sequence owns; leaving them stops the engine. */
const UPLOAD_VIEWS: ReadonlySet<IslandViewName> = new Set(["upload", "uploading", "choose"]);

/**
 * The ONLY views the island — a companion — renders. Status, progress (the drop
 * sequence), one approval surface (the approval card and the structured
 * attention surface) and open/focus. Everything else — the session list, agent
 * management, the settings panel and the chat — belongs to the main window and
 * is deliberately NOT mounted here (docs/KAI_UI_RESET_PLAN.md).
 *
 * `greeting` is in the set because the island owns that canvas itself; it is not
 * a card view (see `views/views.ts`).
 */
const COMPANION_VIEWS: ReadonlySet<IslandViewName> = new Set<IslandViewName>([
  "overview",
  "empty",
  "approval",
  "question",
  "error",
  "finished",
  "confused",
  "note",
  "upload",
  "uploading",
  "choose",
  "greeting",
]);

/** Seconds between the drop and the moment the progress bar starts filling. */
const PRE_PROGRESS = USC.T_PROG_START - USC.T_DROP;

const modeOrder = (m: IslandMode) => (m === "hidden" ? 0 : m === "compact" ? 1 : 2);

export class Island {
  readonly fsm = new IslandStateMachine();
  /** What KAI is doing — driven by real Core events, hooks and user actions. */
  readonly runtime = new KaiRuntimeMachine();

  private root: HTMLElement;
  private islandEl!: HTMLElement;
  private clipEl!: HTMLElement;
  private contentEl!: HTMLElement;
  private viewsEl!: HTMLElement;
  private botCanvas!: HTMLCanvasElement;
  private botGlow!: HTMLElement;
  private greetingCanvas!: HTMLCanvasElement;
  private miniGrid!: HTMLElement;
  private countdown!: HTMLElement;
  private wakeStrip!: HTMLElement;

  private header!: ViewHost;
  private views!: Map<IslandViewName, ViewHost>;
  private uploadCanvas!: UploadCanvas;

  private width = new Tracked(NOTCH_W);
  private height = new Tracked(0);
  private radius = new Tracked(ROUNDED_CORNER);
  private botCx = new Spring(46);
  private botCy = new Spring(16);
  private botSize = new Spring(10);

  private engine = new KaiEngine();
  private greeting = new Greeting();

  private running = false;
  private lastFrame = 0;
  private dirty = true;
  private canvasPx = 0;

  // Rust starts the window at full size so the launch greeting has room.
  private collapsed = false;
  private collapseTimer: number | null = null;
  private wasInIsland = false;
  /** Last shape handed to Rust for the click-through test. */
  private pushedRect = { x: -1, y: -1, w: -1, h: -1 };
  private homeCollapseAt: number | null = null;

  /**
   * True while the main KAI workspace window is open on screen.
   *
   * The island is a COMPANION, not a second desktop presence (owner §36): when the
   * real workspace is open the island steps aside, and it returns when that
   * workspace is closed or minimised. A genuine ask for the person — a pending
   * approval, a pinned message — overrides this and stays on screen, because the
   * island MUST be able to surface an approval even while the workspace is up
   * (owner §§36/38).
   */
  private workspaceOpen = false;

  // Bot hover → love (IslandWindowController.botHoverIn)
  private botHovering = false;
  private botHoverTimer: number | null = null;
  private lastLoveTime = 0;
  private botHoverStart = { x: 0, y: 0 };

  private confusedRecovery: number | null = null;
  private prevViewBeforeConfused: IslandViewName = "overview";

  /** Drop sequence bookkeeping: last tick played, and whether the ✓ has fired. */
  private uploadTens = 0;
  private uploadDone = false;

  constructor(root: HTMLElement) {
    this.root = root;
    this.build();
    this.wireFsm();
    this.wireRuntime();
    this.wireInput();
    this.engine.onDizzy = () => this.handleDizzy();
    this.greeting.onComplete = () => this.fsm.greetComplete();
    State.subscribe(() => {
      this.dirty = true;
      this.reconcileRuntimeInput();
      this.ensureRunning();
    });
    // Live verification handle: the REAL island (never a stub), so a CDP harness
    // can read `attention`, the runtime state and the character's own receipt.
    (window as unknown as { __kaiIsland?: Island }).__kaiIsland = this;
  }

  // ── Runtime state machine ───────────────────────────────────────────────────
  //
  // KAI's face reflects KAI. Every transition is written to `State.runtime`
  // (a KAI-facing label the views render) and to the character via
  // `State.effectiveState`. The machine is fed from three REAL sources only:
  // Core events (core-bridge), the Core connection state, and genuine local user
  // actions (composing / submitting a turn / a Claude Code hook).

  private wireRuntime() {
    this.runtime.onTransition = (t) => {
      State.setRuntime(t.to);
      // A transition means the face should change on the next frame.
      this.dirty = true;
      this.ensureRunning();
    };
    // Seed from whatever the store already holds (e.g. a Core that was offline).
    this.runtime.setConnection(State.core.conn);
    State.setRuntime(this.runtime.state);
  }

  private lastComposing = false;
  private lastTurnInFlight = false;

  /** Folds the chat input's signals into the machine, on the real edges. */
  private reconcileRuntimeInput() {
    const ri = State.runtimeInput;
    if (ri.composing !== this.lastComposing) {
      this.lastComposing = ri.composing;
      this.runtime.setComposing(ri.composing);
    }
    if (ri.turnInFlight !== this.lastTurnInFlight) {
      this.lastTurnInFlight = ri.turnInFlight;
      if (ri.turnInFlight) {
        this.runtime.turnSubmitted();
      } else {
        this.runtime.turnResolved(ri.turnOutcome !== "error");
        // A turn that FAILED is KAI's own message about a real user action, and it
        // has to actually reach the screen. The chat view has already pointed the
        // island at the note; opening it here — rather than trusting the view alone —
        // is what makes a collapsed or compact island show the honest message
        // instead of hiding it behind an unopened window. `turnResolved` may have
        // been a no-op (KAI is already OFFLINE), so the surfacing is deliberately
        // independent of its result.
        if (ri.turnOutcome === "error") this.alert("note");
      }
      return;
    }
  }

  /** A Core event arrived on the stream. Deduped and mapped by the machine. */
  observeCoreEvent(event: RuntimeEventInput): void {
    this.runtime.applyEvent(event);
  }

  /** The Core's connection state changed. OFFLINE is owned here. */
  observeConnection(conn: RuntimeConnection): void {
    this.runtime.setConnection(conn);
  }

  /** A real Claude Code hook arrived: a worker KAI drives is doing something. */
  observeWorkerActivity(type: string, payload?: unknown): void {
    this.runtime.applyEvent({ type, ...(payload !== undefined ? { payload } : {}) });
  }

  // ── DOM ─────────────────────────────────────────────────────────────────────

  private build() {
    const actions: ViewActions = {
      setView: (v) => this.setView(v),
      collapse: () => this.collapse(),
      setFocus: (id) => {
        State.setFocus(id);
        Sound.play("blip");
      },
      openTerminal: () => {
        const cwd = State.focusTask?.sessionCwd ?? null;
        void Bridge.openInVSCode(cwd);
      },
      // The ↗ button — same targets as openAgentTarget() on macOS.
      openTarget: () => {
        const task = State.focusTask;
        if (!task) return;
        const urls: Record<string, string> = {
          integration_resend: "https://resend.com/emails",
          integration_vercel: "https://vercel.com/dashboard",
          integration_github: "https://github.com",
          integration_stripe: "https://dashboard.stripe.com/payments",
          integration_notion: "https://notion.so",
          integration_calcom: "https://app.cal.com/bookings",
        };
        if (task.id === "integration_claude") void Bridge.openInVSCode(task.sessionCwd ?? null);
        else if (task.id === "integration_n8n") void Bridge.openN8n();
        else if (urls[task.id]) void Bridge.openUrl(urls[task.id]);
      },
      openN8n: () => void Bridge.openN8n(),
      decide: (d) => {
        // A card can outlive the request it was drawn for: the Core settles or expires an
        // approval and the card stayed up. The old code returned silently here, which made
        // the button look broken — the log filled with `req=none` and the user got nothing.
        // So fall back to whatever the Core actually has pending, and if there is truly
        // nothing, take the card away and say why.
        const req = State.pendingApproval ?? (() => {
          const pending = State.core.approvals.find((a) => a.status === "PENDING");
          if (pending === undefined) return null;
          return {
            requestId: pending.id,
            sessionId: "",
            tool: pending.toolId,
            command: pending.reason.length > 0 ? pending.reason : pending.action,
          };
        })();
        void Bridge.log(`decide ${d} req=${req?.requestId ?? "none"}`);
        if (!req) {
          State.noteMessage = "Nothing is waiting for approval";
          State.pendingApproval = null;
          State.isPinned = false;
          this.fsm.pinned = false;
          this.setView(State.defaultView());
          State.notify();
          return;
        }
        Sound.play(d === "deny" ? "blip" : "approve");
        // A KAI Core approval must be answered by the Core, not by the Claude Code
        // relay — they are different systems and the relay would reject an id it has
        // never seen. The Core answers first, and only if it does not recognise the
        // request does this fall through to the relay as before.
        if (decideCoreApproval(req.requestId, d)) {
          State.isPinned = false;
          this.fsm.pinned = false;
          this.setView(State.defaultView());
          this.stepAsideAfterAlert();
          return;
        }
        void Bridge.approvalDecision(req.requestId, d);
        State.pendingApproval = null;
        State.isPinned = false;
        this.fsm.pinned = false;
        State.updateTask("integration_claude", "working");
        State.setPillBadge("integration_claude", null);
        this.setView(State.defaultView());
        this.stepAsideAfterAlert();
      },
      coreSession: (cmd) => {
        // The sessions view asks Core; the request goes through the same hook the
        // approval card uses, so the island keeps no client of its own.
        requestCoreSession(cmd);
      },
      toggleSound: () => {
        State.settings.soundEnabled = !State.settings.soundEnabled;
        Sound.setEnabled(State.settings.soundEnabled);
        void Bridge.saveSettings(State.settings);
        State.notify();
      },
      setVolume: (v) => {
        State.settings.soundVolume = v;
        Sound.setVolume(v);
        void Bridge.saveSettings(State.settings);
        State.notify();
      },
      setAutoClose: (s) => {
        State.settings.autoCloseInterval = s;
        this.fsm.homeToPetitDelay = s;
        void Bridge.saveSettings(State.settings);
        State.notify();
      },
      openSettingsWindow: () => void Bridge.openSettingsWindow(),
      blip: () => Sound.play("blip"),
    };

    this.wakeStrip = h("div", { id: "wake-strip" });
    this.botGlow = h("div", { id: "bot-glow" });
    this.botCanvas = h("canvas", { id: "bot-canvas" });
    this.greetingCanvas = h("canvas", { id: "greeting-canvas" });
    this.miniGrid = h("div", { id: "mini-grid" });
    this.countdown = h("div", { id: "countdown" });

    this.header = buildCompanionHeader({
      openKai: () => this.openKai(),
      collapse: () => this.collapse(),
      close: () => this.close(),
      drag: () => void this.startDrag(),
      blip: () => Sound.play("blip"),
    });
    this.views = buildViews(actions, () => this.animateGeometry(false));
    // Only the companion views are mounted. The session list, agent panel,
    // settings panel and chat are built (their construction is side-effect-free)
    // but never attached: the island must not carry them.
    for (const name of [...this.views.keys()]) {
      if (!COMPANION_VIEWS.has(name)) this.views.delete(name);
    }
    this.viewsEl = h("div", { id: "views" });
    for (const v of this.views.values()) this.viewsEl.append(v.el);
    this.contentEl = h("div", { id: "content" }, this.header.el, this.viewsEl);

    // The drop sequence draws the card, the bar and its own KAI. It sits under
    // the header, which stays visible on top of it exactly as on macOS.
    this.uploadCanvas = new UploadCanvas({
      ask: () => {
        State.promptContext = State.droppedFile
          ? { kind: "file", name: State.droppedFile.name, path: State.droppedFile.path }
          : null;
        this.setView("prompt");
      },
      cancel: () => this.setView(State.defaultView()),
    });

    this.clipEl = h(
      "div",
      { id: "island-clip" },
      this.greetingCanvas,
      this.uploadCanvas.el,
      this.contentEl,
    );
    this.islandEl = h(
      "div",
      { id: "island" },
      this.clipEl,
      this.botGlow,
      this.botCanvas,
      this.miniGrid,
      this.countdown,
    );
    // The owner controls (drag / collapse / close) and the single primary action
    // now live in the companion header inside `contentEl`, so they move with the
    // island, are only hittable where the island is (the Rust click-through test
    // uses the same rect), and are shown only while the island is open.

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.greetingCanvas.width = Math.round(EXPANDED_W * dpr);
    this.greetingCanvas.height = Math.round(150 * dpr);
    this.greetingCanvas.style.width = `${EXPANDED_W}px`;
    this.greetingCanvas.style.height = "150px";

    this.root.append(this.wakeStrip, this.islandEl);
    this.applyGeometry();
  }

  // ── FSM ─────────────────────────────────────────────────────────────────────

  private wireFsm() {
    this.fsm.homeToPetitDelay = State.settings.autoCloseInterval;
    this.fsm.onTransition = (from, to) => {
      switch (to) {
        case "hidden":
          this.setMode("hidden");
          break;
        case "petit":
          if (from === "greet") this.greeting.interrupt();
          else if (from === "hidden") Sound.play("peek");
          this.setMode("compact");
          if (from === "greet") State.view = State.defaultView();
          if (!this.wasInIsland) this.fsm.mouseLeft();
          break;
        case "home":
          this.expand(State.defaultView());
          if (!this.wasInIsland) this.fsm.mouseLeft();
          break;
        case "greet":
          this.expand("greeting");
          this.greeting.start();
          break;
      }
      State.notify();
    };
  }

  launch() {
    this.fsm.launch();
  }

  // ── Mode / view ─────────────────────────────────────────────────────────────

  private setMode(mode: IslandMode) {
    const prev = State.mode;
    if (mode === prev) return;
    State.mode = mode;
    if (mode === "expanded") Sound.play("open");
    if (prev === "expanded") {
      Sound.play("close");
      State.isPinned = false;
      void Bridge.focusWindow(false);
    }
    if (mode !== "expanded") {
      this.engine.resetMorph();
      // Nothing can be seen of the sequence once the island is shut, and leaving
      // it running would keep the frame loop awake — the island must cost
      // nothing while hidden.
      UploadSeq.deactivate();
    }
    this.updateWindowCollapsed();
    this.animateGeometry(modeOrder(mode) < modeOrder(prev));
    State.notify();
  }

  /** True while the drop sequence owns the island body. */
  private get uploadActive(): boolean {
    return State.mode === "expanded" && UploadSeq.isActive && UPLOAD_VIEWS.has(State.view);
  }

  /** Navigating out of the drop flow ends the sequence, as on macOS. */
  private stopSequenceIfLeaving(view: IslandViewName) {
    if (UploadSeq.isActive && !UPLOAD_VIEWS.has(view)) UploadSeq.deactivate();
  }

  expand(view: IslandViewName) {
    view = this.companionView(view);
    this.stopSequenceIfLeaving(view);
    State.view = view;
    if (State.mode !== "expanded") this.setMode("expanded");
    else this.animateGeometry(false);
    State.lastActivity = performance.now();
    this.homeCollapseAt = null;
    State.notify();
  }

  setView(view: IslandViewName) {
    view = this.companionView(view);
    this.stopSequenceIfLeaving(view);
    // Leaving the note dismisses KAI's failed-turn message with it: it was about the
    // turn the user has moved on from, and it must not resurface on a later note
    // (e.g. a Core notification) that reuses this view.
    if (view !== "note") State.turnError = null;
    if (State.mode !== "expanded") {
      this.fsm.forceHome();
      State.view = view;
      this.animateGeometry(false);
      State.notify();
      return;
    }
    const grew = VIEW_LAYOUTS[view].height >= VIEW_LAYOUTS[State.view].height;
    State.view = view;
    State.lastActivity = performance.now();
    this.animateGeometry(!grew);
    State.notify();
  }

  collapse() {
    State.isPinned = false;
    this.fsm.pinned = false;
    // Drive the state machine rather than the mode: setting the mode behind its
    // back left it thinking the island was still open, and a click on the compact
    // island then did nothing — the island could never be reopened.
    //
    // COLLAPSE is `petit`: the compact bar, still on screen and still clickable.
    // That is deliberately distinct from CLOSE (`close()`), which hides the
    // window entirely. Both reuse this one placement FSM; there is no second
    // state machine for the two buttons.
    this.fsm.forcePetit();
  }

  /**
   * The ONE primary action: reveal and focus the main KAI surface. The island is
   * a companion — it does not host the application, so this hands the person to
   * the real main window. Navigation only: the action is routed through the
   * companion controller (`island/core-bridge.ts`), which is bound to the same
   * Core and the same `SurfaceFocuser` the main UI uses.
   */
  openKai() {
    Sound.resume();
    this.fsm.pinned = false;
    requestCompanionAction({ action: "open" });
  }

  /**
   * Maps a requested view onto the companion set. The island only renders status,
   * progress, the approval surface and open/focus; a request for the session
   * list, the settings panel, an agent detail panel or the chat does not belong
   * here. Settings is a real separate window, so it is opened there; everything
   * else is the main window's job, so `Open KAI` is dispatched instead. A
   * redirect always lands on the default companion view.
   */
  private companionView(view: IslandViewName): IslandViewName {
    if (COMPANION_VIEWS.has(view)) return view;
    if (view === "settings") {
      void Bridge.openSettingsWindow();
      return State.defaultView();
    }
    this.openKai();
    return State.defaultView();
  }

  /** Alert from the hook server: open on this view. Pinned alerts never auto-close. */
  alert(view: IslandViewName) {
    this.fsm.pinned = State.isPinned;
    this.fsm.forceHome();
    this.expand(view);
  }

  reveal() {
    this.fsm.reveal();
  }

  /**
   * The OS reports that the pointer entered the hidden island's wake strip.
   *
   * The normal case is `hidden` and this is a `reveal()`. The second branch exists
   * because the one state a presence must never enter is "the window is a 9 px strip
   * and the front end believes the island is open": nothing could then bring it back.
   * If that ever happens, the window is grown again rather than left as a trap.
   */
  wake() {
    if (State.mode === "hidden") {
      this.reveal();
      return;
    }
    if (this.collapsed) {
      this.collapsed = false;
      void Bridge.setCollapsed(false);
      this.ensureRunning();
    }
  }

  /**
   * The settings window is opening (from the island, the tray or anywhere else) and
   * it opens exactly where the island sits. Retract first: an always-on-top island
   * left open covers the settings window's title bar and its first rows.
   */
  retractForSettings() {
    this.fsm.forceHidden();
  }

  /**
   * The main workspace window opened or closed. This is the companion contract the
   * owner is explicit about (docs/mission/KAI_ULTRA_PRODUCT_RECOVERY.md §36):
   *
   *   workspace OPEN    → the island disappears from the primary desktop presence.
   *   workspace CLOSED
   *   or MINIMISED      → the island returns as the companion.
   *
   * The ONE exception is a real ask for the person: if an approval is pending, a
   * message is pinned, or KAI is already showing a question, the island stays —
   * presenting an approval while the workspace is up is REQUIRED (§§36/38), and a
   * companion that vanishes exactly when it has something to say is not a
   * companion.
   */
  setWorkspaceOpen(open: boolean) {
    if (open === this.workspaceOpen) return;
    this.workspaceOpen = open;
    if (open) {
      if (this.needsPerson()) return;
      State.isPinned = false;
      this.fsm.pinned = false;
      this.fsm.forceHidden();
      return;
    }
    // The workspace went away: come back as the companion. `forceHidden` first
    // settles the placement machine out of whatever state it was left in (an alert
    // may have opened it), then `reveal` brings back the lightweight compact bar —
    // the persistent status surface while the workspace is closed (§27).
    this.fsm.forceHidden();
    this.reveal();
  }

  /** For the live verification harness: is the workspace keeping the island aside? */
  get workspaceIsOpen(): boolean {
    return this.workspaceOpen;
  }

  /**
   * True when KAI genuinely needs the person right now: a pending approval, a pinned
   * message, or a question/approval surface already up. This is the only reason the
   * island may stay on screen while the main workspace is open.
   */
  private needsPerson(): boolean {
    if (State.isPinned) return true;
    if (State.pendingApproval !== null) return true;
    if (State.core.approvals.some((a) => a.status === "PENDING")) return true;
    if (State.mode === "expanded" && (State.view === "approval" || State.view === "question")) {
      return true;
    }
    return false;
  }

  /** An alert answered while the workspace is open: step aside again, as a companion. */
  private stepAsideAfterAlert(): void {
    if (!this.workspaceOpen) return;
    this.fsm.pinned = false;
    State.isPinned = false;
    this.fsm.forceHidden();
  }

  /** An alert stopped waiting for an answer: let the island auto-close again. */
  dropPin() {
    this.fsm.pinned = false;
  }

  // ── File drop ───────────────────────────────────────────────────────────────

  private onDragDrop(e: { type: string; paths?: string[] }) {
    if (e.type !== "over") void Bridge.log(`drag ${e.type} ${e.paths?.length ?? 0} file(s)`);
    if (State.paused) return;
    switch (e.type) {
      case "enter":
      case "over": {
        if (State.fileDragOver) return;
        State.fileDragOver = true;
        this.engine.animateMorph(1);
        // enterZone must run before the island expands, so the sequence is
        // already active by the time the view becomes `upload`.
        UploadSeq.enterZone(State.mouseInIsland.x, State.mouseInIsland.y);
        this.alert("upload");
        break;
      }
      case "leave": {
        if (!State.fileDragOver) return;
        State.fileDragOver = false;
        this.engine.animateMorph(0);
        // The island deliberately stays open: the drag session is still alive.
        UploadSeq.exitZone();
        State.notify();
        break;
      }
      case "drop": {
        State.fileDragOver = false;
        const path = e.paths?.[0];
        if (!path) {
          this.engine.animateMorph(0);
          this.setView(State.defaultView());
          return;
        }
        this.swallow(path);
        break;
      }
    }
  }

  /**
   * KAI eats the file. Nothing here waits on the file system: the copy into
   * the inbox runs in the background and swaps the path in when it lands, so a
   * slow disk can never stall the animation — same as FileDropHandler on macOS.
   */
  /**
   * Closes the approval card when the request behind it is gone.
   *
   * The bridge clears `State.pendingApproval` the moment the Core settles or expires an
   * approval, but clearing state does not remove a card that is already on screen — which
   * is how a person ends up pressing Allow on a question nobody is asking any more.
   */
  dismissApprovalCard(): void {
    State.pendingApproval = null;
    State.isPinned = false;
    this.fsm.pinned = false;
    this.setView(State.defaultView());
    State.notify();
  }

  private swallow(path: string) {
    const name = path.split(/[\\/]/).pop() || "file";
    State.droppedFile = { name, path };
    State.promptContext = { kind: "file", name, path };
    State.clearChatHistory(State.core.activeSessionId);
    void Bridge.chatReset(State.core.activeSessionId);

    UploadSeq.performDrop(State.uploadDuration);
    this.uploadTens = 0;
    this.uploadDone = false;

    this.engine.gulp();
    Sound.play("approve");
    this.engine.triggerEmote("happy");
    this.engine.animateMorph(0);

    State.uploadProgress = 0;
    this.setView("uploading");
    this.ensureRunning();

    void Bridge.ingestFile(path)
      .then((file) => {
        State.droppedFile = { name: file.name, path: file.path };
        State.promptContext = { kind: "file", name: file.name, path: file.path };
        State.notify();
      })
      .catch((err) => {
        UploadSeq.deactivate();
        State.noteMessage = String(err).replace(/^Error:\s*/, "");
        this.engine.animateMorph(0);
        this.setView("note");
        Sound.play("error");
        window.setTimeout(() => this.setView(State.defaultView()), 2400);
      });
  }

  /**
   * Sounds and view changes hung off the canvas timeline: a `tick` every 10 %,
   * the ✓ chime when the bar completes, then `choose` once KAI has grown back.
   */
  private stepSequence() {
    const since = UploadSeq.sinceDrop();
    if (since == null) return;
    const dur = State.uploadDuration;
    const p = Math.max(0, Math.min(1, (since - PRE_PROGRESS) / dur));

    const tens = Math.floor(p * 10);
    if (tens > this.uploadTens && tens < 10) {
      this.uploadTens = tens;
      Sound.play("tick");
    }

    if (!this.uploadDone && since >= PRE_PROGRESS + dur) {
      this.uploadDone = true;
      Sound.play("approve");
      this.engine.triggerEmote("happy");
    }
    // The extra second is the grow-back, after which the choose card is up.
    if (since >= PRE_PROGRESS + dur + 1 && State.view === "uploading") {
      this.setView("choose");
    }
  }

  // ── Geometry ────────────────────────────────────────────────────────────────

  private targetSize(): { w: number; h: number; r: number } {
    const { w, h } = islandSize(State.mode, State.view, State.chatHistory.length);
    const r = State.mode === "expanded" ? EXPANDED_CORNER : ROUNDED_CORNER;
    return { w, h, r };
  }

  private animateGeometry(shrinking: boolean) {
    const { w, h, r } = this.targetSize();
    if (shrinking) {
      this.width.curveTowards(w);
      this.height.curveTowards(h);
      this.radius.curveTowards(r);
    } else {
      this.width.springTo(w);
      this.height.springTo(h);
      this.radius.springTo(r);
    }
    this.ensureRunning();
  }

  private applyGeometry() {
    const w = this.width.value;
    const hh = this.height.value;
    const r = this.radius.value;
    this.islandEl.style.width = `${w}px`;
    this.islandEl.style.height = `${hh}px`;
    this.islandEl.style.borderRadius = `0 0 ${r}px ${r}px`;
    this.islandEl.style.transform = `translateX(-50%)`;
    // These follow the island as it resizes, so they belong here rather than in
    // the state-driven DOM sync.
    this.miniGrid.style.left = `${w - 40 - 14.5}px`;
    this.miniGrid.style.top = `${hh / 2 - 14.5}px`;
    this.greetingCanvas.style.left = `${(w - EXPANDED_W) / 2}px`;
    this.uploadCanvas.el.style.left = `${(w - EXPANDED_W) / 2}px`;

    const rect = { x: (PANEL_W - w) / 2, y: 0, w, h: hh };
    const p = this.pushedRect;
    if (Math.abs(p.x - rect.x) > 0.5 || Math.abs(p.w - rect.w) > 0.5 || Math.abs(p.h - rect.h) > 0.5) {
      this.pushedRect = rect;
      void Bridge.setIslandRect(rect.x, rect.y, rect.w, rect.h);
    }
  }

  /** Island rect in window coordinates (origin top-left of the 720×320 window). */
  private islandRect(): { x: number; y: number; w: number; h: number } {
    const w = this.width.value;
    const hh = this.height.value;
    return { x: (PANEL_W - w) / 2, y: 0, w, h: hh };
  }

  // ── Window collapse (hidden → tiny wake strip, zero polling) ────────────────

  private updateWindowCollapsed() {
    if (this.collapseTimer != null) {
      window.clearTimeout(this.collapseTimer);
      this.collapseTimer = null;
    }
    if (State.mode === "hidden") {
      // Let the island finish retracting, then drop the window to the wake strip:
      // from there the OS delivers no cursor events, so nothing polls at all.
      this.collapseTimer = window.setTimeout(() => {
        this.collapseTimer = null;
        if (State.mode !== "hidden") return;
        this.collapsed = true;
        void Bridge.setCollapsed(true);
      }, 420);
    } else if (this.collapsed) {
      // Grow the window back before the island animates open.
      this.collapsed = false;
      void Bridge.setCollapsed(false);
    }
  }

  // ── Input ───────────────────────────────────────────────────────────────────

  private wireInput() {
    // The wake strip is the only thing the OS can hit while the island is hidden.
    this.wakeStrip.addEventListener("mouseenter", () => {
      Sound.resume();
      if (State.mode === "hidden") this.fsm.mouseEntered();
    });

    this.islandEl.addEventListener("mousedown", (e) => {
      Sound.resume();
      State.lastActivity = performance.now();
      if (State.mode !== "expanded") {
        this.fsm.click();
        return;
      }
      if (this.isBotHit(e.clientX, e.clientY)) {
        this.cancelBotHover();
        this.engine.slap();
      }
    });

    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && State.mode === "expanded" && !State.isPinned) this.collapse();
      State.lastActivity = performance.now();
    });

    void onDragDrop((e) => this.onDragDrop(e));

    // Outside Tauri (plain browser) drive the cursor from DOM events so the
    // island can be inspected with `npm run dev`.
    if (!IS_TAURI) {
      window.addEventListener("mousemove", (e) => this.onCursor(e.clientX, e.clientY));
    }
  }

  // ── Owner controls ──────────────────────────────────────────────────────────
  // Move, collapse and close, as real OS-level actions, built by the companion
  // header (`island/header.ts`). Collapsing drives the placement FSM's `petit`
  // (the compact bar, still on screen). Closing hides the WINDOW and leaves KAI
  // running: the island is the visual front door, not the lifetime of the KAI
  // runtime. Neither touches Core.

  /** Hands the move to Windows; the OS runs it and Rust saves where it landed. */
  private async startDrag() {
    if (!IS_TAURI) return;
    try {
      await invoke("start_island_drag");
    } catch (err) {
      console.error("[kai] start_island_drag failed", err);
    }
  }

  /**
   * Closes the island: the window is hidden but KAI's runtime is untouched —
   * Core, the pollers and the hooks keep running. Reopen from the tray, or by
   * launching KAI again.
   */
  private close() {
    State.isPinned = false;
    this.fsm.pinned = false;
    // Tell Rust first (it hides the window and parks the wake strip), then reset
    // the front end so reopening starts from a clean, open island.
    if (IS_TAURI) {
      void invoke("close_island").catch((err) => console.error("[kai] close_island failed", err));
    }
    this.fsm.forceHidden();
  }

  /** Cursor in window-logical coordinates. */
  onCursor(x: number, y: number) {
    State.mouse = { x, y };
    const rect = this.islandRect();
    State.mouseInIsland = { x: x - rect.x, y: y - rect.y };

    // Windows sends no cursor position with an OLE drag, so the drop sequence is
    // fed from the Win32 cursor poll instead — it runs throughout the drag.
    if (UploadSeq.isActive && !UploadSeq.dropped) {
      UploadSeq.updateCursor(State.mouseInIsland.x, State.mouseInIsland.y);
    }

    const inIsland =
      x >= rect.x - HIT_MARGIN && x <= rect.x + rect.w + HIT_MARGIN &&
      y >= rect.y - HIT_MARGIN && y <= rect.y + rect.h + HIT_MARGIN;

    if (inIsland && !this.wasInIsland) {
      if (this.fsm.state === "greet") this.greeting.hover();
      this.fsm.mouseEntered();
      this.homeCollapseAt = null;
    }
    if (!inIsland && this.wasInIsland) {
      this.fsm.mouseLeft();
      if (this.fsm.state === "home" && !State.isPinned) {
        this.homeCollapseAt = performance.now() + State.settings.autoCloseInterval * 1000;
      }
    }
    this.wasInIsland = inIsland;

    // Bot hover → love
    const overBot = State.mode === "expanded" && State.stateOverride == null && this.isBotHit(x, y);
    if (overBot && !this.botHovering) this.botHoverIn(x, y);
    if (!overBot && this.botHovering) this.cancelBotHover();
    this.botHovering = overBot;
    if (this.botHovering) {
      const d = Math.hypot(x - this.botHoverStart.x, y - this.botHoverStart.y);
      if (d > 40) {
        this.botHoverStart = { x, y };
        this.scheduleLove();
      }
    }

    this.ensureRunning();
  }

  private isBotHit(x: number, y: number): boolean {
    const rect = this.islandRect();
    const cx = rect.x + this.botCx.value;
    const cy = rect.y + this.botCy.value;
    const radius = this.botSize.value / 2;
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius;
  }

  private botHoverIn(x: number, y: number) {
    if (performance.now() / 1000 - this.lastLoveTime < 6) return;
    this.botHoverStart = { x, y };
    this.engine.blink();
    this.engine.tgEs = 1.08;
    Sound.play("hover");
    this.scheduleLove();
  }

  private scheduleLove() {
    if (this.botHoverTimer != null) window.clearTimeout(this.botHoverTimer);
    this.botHoverTimer = window.setTimeout(() => {
      this.botHoverTimer = null;
      if (!this.botHovering || State.stateOverride != null) return;
      if (performance.now() / 1000 - this.lastLoveTime < 6) return;
      this.lastLoveTime = performance.now() / 1000;
      this.engine.triggerEmote("love");
      Sound.play("love");
    }, 1900);
  }

  private cancelBotHover() {
    if (this.botHoverTimer != null) window.clearTimeout(this.botHoverTimer);
    this.botHoverTimer = null;
    this.engine.tgEs = 1;
  }

  /**
   * The precise state the orb should show. `State.effectiveState` collapses every
   * runtime state onto the coarse legacy pose via `characterStateFor`, which is
   * correct for the CHIP/colour but throws away the widened vocabulary — a
   * running set of workers, a scan, a command line and a re-verification all
   * become the same "working"/"searching". Hand the engine the runtime name
   * ITSELF (non-idle) so `poseForState` on the widened `KAI_STATE_POSE` table
   * drives the intended orb pose; fall back to the focused worker only when KAI
   * is genuinely idle, and let the dizzy override win outright (a deliberate act).
   */
  private faceState(): KaiStateName {
    if (State.stateOverride !== null) return State.stateOverride;
    if (State.runtime !== "IDLE") return State.runtime;
    return State.focusTask?.state ?? "idle";
  }

  /** Three slaps → dizzy + confused view for 3.3 s, then back. */
  private handleDizzy() {
    this.prevViewBeforeConfused = State.view;
    State.stateOverride = "dizzy";
    this.engine.setState("dizzy");
    Sound.play("dizzy");
    this.alert("confused");
    if (this.confusedRecovery != null) window.clearTimeout(this.confusedRecovery);
    this.confusedRecovery = window.setTimeout(() => {
      this.confusedRecovery = null;
      State.stateOverride = null;
      this.engine.setState(this.faceState());
      if (State.view === "confused") {
        const fallback = State.defaultView();
        this.setView(this.prevViewBeforeConfused === "confused" ? fallback : this.prevViewBeforeConfused);
      }
      this.engine.triggerEmote("happy");
    }, 3300);
  }

  // ── Frame loop ──────────────────────────────────────────────────────────────

  ensureRunning() {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    requestAnimationFrame(this.frame);
  }

  private frame = (nowMs: number) => {
    const dt = Math.min(0.05, (nowMs - this.lastFrame) / 1000);
    this.lastFrame = nowMs;

    this.width.step(dt, nowMs);
    this.height.step(dt, nowMs);
    this.radius.step(dt, nowMs);
    this.applyGeometry();

    if (this.dirty) {
      this.dirty = false;
      this.syncDom();
    }

    this.updateBotTargets();
    this.botCx.step(dt);
    this.botCy.step(dt);
    this.botSize.step(dt);

    const greetingActive = State.mode === "expanded" && State.view === "greeting";
    if (greetingActive) {
      const gctx = this.greetingCanvas.getContext("2d");
      if (gctx) {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.greeting.draw(gctx);
      }
    } else {
      // Kept running even while the drop canvas is up, so the island's own KAI
      // is already in the right place the moment the canvas fades out.
      this.drawBot(dt);
    }

    const uploadActive = this.uploadActive;
    if (uploadActive) this.uploadCanvas.draw(UploadSeq.frame(), nowMs / 1000);
    this.uploadCanvas.el.classList.toggle("on", uploadActive);
    this.viewsEl.classList.toggle("hidden-by-upload", uploadActive);

    tickMiniBots(dt);
    this.views.get(State.view)?.tick?.(nowMs);
    if (UploadSeq.isActive) this.stepSequence();
    this.updateCountdown(nowMs);
    // The bounded safeguard only: returns a transient SUCCESS/ERROR to IDLE after
    // its hold, or a stranded active state after maxActiveMs. It never invents work.
    this.runtime.tick();

    // Nothing is drawn while the island is hidden, so nothing may keep the loop
    // alive either. This used to read `... || this.engine.busy || State.mode !==
    // "hidden"`, and engine.busy is permanently true for any state with a
    // looping animation — breathing, ratelimit sweat, sleeping z's, the search
    // sweep — so a hidden island went on burning frames in exactly the states it
    // spends most of its life in. Geometry still has to finish retracting.
    const settling =
      this.width.animating || this.height.animating || this.radius.animating;
    const busy = State.mode === "hidden"
      ? settling
      : settling ||
        !this.botCx.settled || !this.botCy.settled || !this.botSize.settled ||
        greetingActive || this.engine.busy || UploadSeq.isActive;

    if (busy) {
      requestAnimationFrame(this.frame);
    } else {
      this.running = false;
      Sound.idle();
    }
  };

  private updateBotTargets() {
    const p = botPosition(State.mode, State.view, this.height.value, State.uploadProgress);
    this.botCx.target = p.cx;
    this.botCy.target = p.cy;
    this.botSize.target = p.diameter / 0.6;

    const greetingActive = State.mode === "expanded" && State.view === "greeting";
    // The drop canvas draws its own KAI; two of them would overlap.
    const visible = p.opacity > 0 && !greetingActive && !this.uploadActive;
    this.botCanvas.style.opacity = visible ? "1" : "0";

    if (State.mode === "expanded" && State.view !== "uploading" && !greetingActive && !this.uploadActive) {
      const d = p.diameter;
      const color = botGlowColor(State.effectiveState);
      this.botGlow.style.display = "block";
      this.botGlow.style.width = `${d * 2.2}px`;
      this.botGlow.style.height = `${d * 2.2}px`;
      this.botGlow.style.left = `${this.botCx.value - d * 1.1}px`;
      this.botGlow.style.top = `${this.botCy.value - d * 1.1}px`;
      this.botGlow.style.background = `radial-gradient(circle, ${color} 0%, transparent 62%)`;
      this.botGlow.style.opacity = String(botGlowOpacity(State.effectiveState));
    } else {
      this.botGlow.style.display = "none";
    }
  }

  private drawBot(dt: number) {
    const size = this.botSize.value;
    const w = Math.max(1, Math.round(size));
    const hCss = w + BOT_OVERHANG;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (this.canvasPx !== w) {
      this.canvasPx = w;
      this.botCanvas.width = Math.round(w * dpr);
      this.botCanvas.height = Math.round(hCss * dpr);
      this.botCanvas.style.width = `${w}px`;
      this.botCanvas.style.height = `${hCss}px`;
    }
    this.botCanvas.style.left = `${this.botCx.value - w / 2}px`;
    this.botCanvas.style.top = `${this.botCy.value - BOT_OVERHANG / 2 - hCss / 2}px`;

    const ctx = this.botCanvas.getContext("2d");
    if (!ctx) return;

    // KAI's own character is ALWAYS the real orb — never the flat integration
    // fill. `bodyColor` is the mini-bot / pill path (`createMiniBot` sets it);
    // setting it here painted the whole character as one flat disc, and because
    // `focusTask` is an integration by default (the "KAI your agent" card) that
    // was the only thing the user ever saw. The focused worker's colour still
    // tints its own pill, which is where a flat fill belongs.
    this.engine.particleOverhang = BOT_OVERHANG;
    this.engine.lookX = this.lookX();
    this.engine.lookY = this.lookY();
    if (this.engine.morph > 0.3) {
      this.engine.slotHTarget = State.fileDragOver ? 0.2 : 0;
    } else {
      this.engine.slotHTarget = 0;
      if (this.engine.morph < 0.05) {
        this.engine.slotH = 0;
        this.engine.slotHVel = 0;
      }
    }
    this.engine.update(dt);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hCss);
    this.engine.draw(ctx, w, hCss);
  }

  /** BotCanvasView.lookX / lookY — tanh of the distance to the bot. */
  private lookX(): number {
    const rect = this.islandRect();
    const botScreenX = rect.x + this.botCx.value;
    return Math.tanh((State.mouse.x - botScreenX) / 260);
  }

  private lookY(): number {
    return -Math.tanh((State.mouse.y - this.botCy.value) / 200);
  }

  private updateCountdown(nowMs: number) {
    if (State.mode !== "expanded" || State.isPinned || this.homeCollapseAt == null) {
      this.countdown.style.width = "0px";
      return;
    }
    const autoClose = State.settings.autoCloseInterval;
    const windowS = Math.min(10, autoClose * 0.6);
    const remaining = (this.homeCollapseAt - nowMs) / 1000;
    this.countdown.style.width =
      remaining < windowS ? `${Math.max(0, clamp(remaining / windowS, 0, 1) * 160)}px` : "0px";
  }

  // ── DOM sync ────────────────────────────────────────────────────────────────

  private syncDom() {
    const expanded = State.mode === "expanded";
    const greetingActive = expanded && State.view === "greeting";

    this.contentEl.style.opacity = expanded && !greetingActive ? "1" : "0";
    this.contentEl.style.pointerEvents = expanded && !greetingActive ? "auto" : "none";
    this.greetingCanvas.style.display = greetingActive ? "block" : "none";
    // The companion header — status, the single `Open KAI` action and the window
    // controls — rides inside `contentEl`, so it is shown/hidden (and only made
    // hittable) with the rest of the open island by the two lines above.

    this.header.sync();
    for (const [name, view] of this.views) {
      const on = name === State.view;
      view.el.classList.toggle("on", on);
      // The overview is synced even while another view is up: its KAI card renders
      // `State.runtimeLabel`, while the character's glow tracks the runtime every
      // frame. Gating it on `on` let the glow move to the next state while the
      // label a user actually reads stayed on the previous one — the one-state lag
      // the pose evidence caught (glow=SUCCESS, label="KAI is using a tool…").
      if (on || name === "overview") view.sync();
    }

    // The island holds no chat (see `COMPANION_VIEWS`): text input lives in the
    // main window, so the island never needs to take keyboard focus. The previous
    // `prompt`-view focus handoff was the only reason it ever did.

    // Compact mini grid
    const showGrid = State.mode === "compact";
    this.miniGrid.style.opacity = showGrid ? "1" : "0";
    if (showGrid) {
      const others = State.otherTasks.slice(0, 4);
      const key = others.map((t) => t.id).join("|");
      if (this.miniGrid.dataset.key !== key) {
        this.miniGrid.dataset.key = key;
        this.miniGrid.replaceChildren();
        for (const t of others) {
          this.miniGrid.append(createMiniBot(t, 13));
        }
        pruneMiniBots();
      }
    }

    syncMiniBotStates(State.tasks);
    this.engine.setState(this.faceState());
  }

  /** Applies settings coming from Rust at boot. */
  applySettings() {
    Sound.setEnabled(State.settings.soundEnabled);
    Sound.setVolume(State.settings.soundVolume);
    this.fsm.homeToPetitDelay = State.settings.autoCloseInterval;
    State.notify();
  }

  get panelSize() {
    return { w: PANEL_W, h: PANEL_H };
  }

  get chatHeight() {
    return chatPromptHeight(State.chatHistory.length);
  }
}
