// The navigation shell — the main window's whole chrome.
//
// This is the mount point for KAI's REAL main interface: the owner's reference
// design (docs/design/kai-presence-v2.html), wired to real Core (see
// `presence/presence.ts`). The shell's only job is to hand it the one Core
// surface (client + event stream + slice) it needs; the interface owns its own
// navigation between KAI's sections.
//
// The pure routing vocabulary (`routes.ts`) is live: `mountPresence` calls back
// through `navigate` on every `show` and follows the location hash, so
// `getRoute()` reports the real view and `navigate()` moves it. The page
// registry (`registry.ts`) stays as the tested seam for future surfaces.

import { startWorkspace } from "../workspace";
import { mountPresence } from "./presence/presence";
import { ThemeController } from "./theme";
import "./theme.css";
import type { CoreClient } from "../core/kai-core";
import type { Workspace } from "../workspace/workspace";
import type { RouteId } from "./routes";

export interface ShellMountOptions {
  readonly client: CoreClient;
  readonly workspace: Workspace;
}

export interface ShellHandle {
  /** The shell's root element. */
  readonly el: HTMLElement;
  getRoute(): RouteId;
  navigate(route: RouteId): void;
  /** The live theme (Light/Dark/System), owned by the shell. */
  readonly theme: ThemeController;
  /** Tear down listeners and pages. */
  stop(): void;
}

export function mountShell(root: HTMLElement, options: ShellMountOptions): ShellHandle {
  // The theme is created before the interface so the FIRST paint is already
  // themed — no light flash before a dark choice is applied.
  const theme = new ThemeController(root);
  theme.start();

  // The route the interface is actually on, kept in sync by `mountPresence`
  // through `navigate` (called on every `show`). `getRoute()` reports THIS, so it
  // tells the truth instead of a constant — the browser harness asserts it on
  // every rail click.
  let route: RouteId = "chat";
  const page = mountPresence(root, {
    client: options.client,
    workspace: options.workspace,
    navigate: (id: RouteId) => {
      route = id;
    },
    theme,
  });

  return {
    el: page.el,
    theme,
    getRoute: () => route,
    navigate: (id: RouteId) => {
      // A real navigation through the interface's own `show`, not a label write.
      if (page.showRoute !== undefined) page.showRoute(id);
      else route = id;
    },
    stop(): void {
      page.destroy?.();
      page.el.remove();
      theme.stop();
    },
  };
}

/** Boots the shell in the running app. Returns the workspace for teardown. */
export function startShell(root: HTMLElement): { workspace: Workspace; shell: ShellHandle } {
  const workspace = startWorkspace();
  const shell = mountShell(root, { client: workspace.client, workspace });
  return { workspace, shell };
}
