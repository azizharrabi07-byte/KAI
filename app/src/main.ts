// Entry point: boot the bridge, wire the island, start the greeting.

import "./style.css";
import "./visual/visual.css";
import { Bridge, IS_TAURI, onEvent } from "./core/bridge";
import { Sound } from "./core/sound";
import { State, type Settings } from "./core/state";
import { Island } from "./island/island";
import { registerHookHandlers } from "./island/hooks";
import { registerIntegrationHandlers, refreshConfigured } from "./island/integrations";
import { startCoreLink } from "./core/core-boot";
import { attachCoreLink } from "./island/core-bridge";
import type { KaiEngine } from "./character/engine";
import { APPEARANCE_KEY, applyVariant, loadVariant, type KaiVariant } from "./character/variant";
import { mountVisual } from "./visual/mount";

async function main() {
  const root = document.getElementById("root");
  if (!root) return;

  void Sound.preload();

  const island = new Island(root);

  // ── KAI's appearance (owner sections 8/9) ─────────────────────────────────
  //
  // KAI's own renderer is created inside the island. island.ts is owned by another
  // agent this round, so rather than editing it we reach its PUBLIC-SHAPED engine
  // field and drive the character module's own API (`setSkin` / `setAccessory`).
  // The choice itself is stored by character/variant.ts (see that file for why the
  // durable store lives there) and re-applied here at boot and on every change, so
  // it survives a real restart. No second avatar system: this IS KAI's renderer.
  const engine = (island as unknown as { engine?: KaiEngine }).engine;
  let appearance: KaiVariant = loadVariant();
  const applyAppearance = () => {
    appearance = loadVariant();
    if (engine) applyVariant(engine, appearance);
  };
  applyAppearance();
  // A read-only hook for the live verification harness (reads the variant the
  // island actually applied — never a value it merely intended to apply).
  (window as unknown as { __kaiAppearance?: () => KaiVariant }).__kaiAppearance = () => appearance;

  // The live verification harness needs the island's REAL state, not a DOM guess:
  // the runtime pose, the Core connection, the active session and how many turns
  // are loaded. Read-only — it observes and never drives.
  (window as unknown as { __kaiProbe?: () => unknown }).__kaiProbe = () => ({
    mode: State.mode,
    view: State.view,
    runtime: State.runtime,
    runtimeLabel: State.runtimeLabel,
    conn: State.core.conn,
    connError: State.core.lastError,
    note: State.noteMessage,
    turnError: State.turnError,
    activeSessionId: State.core.activeSessionId,
    sessionIds: State.core.sessions.map((s) => s.id),
    historyLength: State.chatHistory.length,
    historyLast: State.chatHistory.length > 0 ? State.chatHistory[State.chatHistory.length - 1]?.content : null,
    workspaceOpen: island.workspaceIsOpen,
  });

  const boot = await Bridge.boot();
  if (boot) {
    State.settings = { ...State.settings, ...boot.settings };
  }
  island.applySettings();
  State.loadIntegrationTasks();

  // The settings window writes the appearance and re-emits `settings-changed`;
  // the `storage` event also fires in this window for the shared store. Either
  // path re-applies without a restart.
  window.addEventListener("storage", (e) => {
    if (e.key === APPEARANCE_KEY) applyAppearance();
  });

  await onEvent<{ x: number; y: number }>("cursor", ({ x, y }) => island.onCursor(x, y));

  /** Pause has to reach Rust too, or the pollers keep calling out. */
  const setPaused = (on: boolean) => {
    if (State.paused === on) return;
    State.paused = on;
    void Bridge.setPaused(on);
  };

  await onEvent<string>("tray", (what) => {
    switch (what) {
      case "settings":
        setPaused(false);
        island.alert("settings");
        break;
      case "open":
        // The tray's "Open KAI" opens the REAL main window (Rust shows it). The
        // island must NOT also expand: opening the workspace makes the island step
        // aside, and re-expanding it here would fight that. Only the pause is
        // cleared — opening KAI means KAI is being used.
        setPaused(false);
        break;
      case "pause":
        setPaused(!State.paused);
        if (State.paused) island.fsm.forceHidden();
        else island.reveal();
        break;
    }
  });

  await onEvent<null>("screen-changed", () => void Bridge.reposition());

  // The wake path when the island is hidden. Rust watches the cursor itself, because
  // a collapsed, layered window cannot be relied on to receive a mouse event at all
  // (see spawn_wake_monitor): this is the signal that the pointer reached the strip.
  await onEvent<null>("wake", () => island.wake());

  // Anything that opens the settings window — the island's own button, the tray, a
  // future shortcut — comes through here, so the island steps out of the way first.
  await onEvent<null>("settings-opening", () => island.retractForSettings());

  // The companion contract (owner §36): Rust tracks whether the real main KAI window
  // is open on screen (shown and not minimised) and tells the island. Open → the
  // island steps aside; closed or minimised → it returns. An approval pending keeps
  // it up either way.
  await onEvent<boolean>("workspace-presence", (open) => island.setWorkspaceOpen(open));

  // The settings window writes preferences; apply them here without a restart.
  await onEvent<Settings>("settings-changed", (s) => {
    State.settings = { ...State.settings, ...s };
    island.applySettings();
    State.loadIntegrationTasks();
    void refreshConfigured();
    // A settings write may also carry a new appearance (the settings window
    // re-emits this event when the owner changes KAI's look).
    applyAppearance();
  });

  registerHookHandlers(island);
  registerIntegrationHandlers(island);

  island.launch();

  // Connect to KAI Core last and WITHOUT awaiting: the island is already up and stays
  // usable whether the Core is running or not. It reports its own connection state, so
  // a Core that is down shows as offline instead of holding the shell hostage.
  const coreLink = startCoreLink();
  // Core state drives the island's existing pills, note bubble and approval card.
  attachCoreLink(island, coreLink);

  // The visual host. It is mounted onto the Core client, so the ONLY path from a
  // model's text to a drawing runs through Core's validator (`POST /visual/compile`):
  // the host compiles, the engine re-guards, then draws. This stays on the island:
  // the companion still shows KAI's own drawings, at companion size.
  const visual = mountVisual(root, island, coreLink.client);
  void visual;

  // The main KAI workspace is NOT mounted here any more. It belongs to the real
  // application window (`shell.html` → `src/shell/**`), which carries the sidebar
  // and the routed outlet. The island is a companion: status, progress, approval
  // and open/focus actions — not a 240×6 host for sessions, agents, tools or MCP.

  // In a plain browser there is no wake strip behind the cursor: make the whole
  // page wake the island so the visuals can be checked with `npm run dev`.
  if (!IS_TAURI) {
    document.addEventListener("click", () => Sound.resume(), { once: true });
  }
}

void main();
