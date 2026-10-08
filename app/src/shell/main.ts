// The main KAI window's front end — the composition root.
//
// `index.html` (the island) renders the companion; `shell.html` renders the real
// application window. They are two different pages in two different windows,
// which is the whole correction: the island is a companion, the main window is
// where KAI lives.
//
// The main window now IS the owner's reference design (docs/design/
// kai-presence-v2.html), mounted by `mountShell` and driven by real Core. It
// opens its OWN Core surface (client + event stream + slice); it does not import
// the island, so either window runs without the other.

import "../style.css";
import { IS_TAURI } from "../core/bridge";
import { startWorkspace } from "../workspace";
import { mountShell, type ShellHandle } from "./shell";

/** The handle the live verification harness reaches (never a stub). */
interface ShellProbe {
  hasCore(): boolean;
  getRoute(): string;
}

async function main(): Promise<void> {
  const root = document.getElementById("root");
  if (!root) return;

  if (IS_TAURI) document.body.dataset.window = "main";

  // One Core surface for the whole window: one client, one SSE stream, one slice.
  const workspace = startWorkspace();
  const shell: ShellHandle = mountShell(root, { client: workspace.client, workspace });

  (window as unknown as { __kaiShell?: ShellProbe }).__kaiShell = {
    hasCore: () => true,
    getRoute: () => shell.getRoute(),
  };
}

void main();
