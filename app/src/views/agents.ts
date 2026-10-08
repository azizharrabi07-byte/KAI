/**
 * views/agents.ts — the Agents page, registered with the shell.
 *
 * Stream C's whole delivery meets the shell here. The shell owns the outlet, the
 * router and the Core client; this module is the ONE line the integrator adds:
 *
 *     import { mountAgents } from "./views/agents";
 *     registerPage("agents", mountAgents);
 *
 * `mountAgents` is a `PageFactory`: it builds a real `AgentApi` over the shell's
 * OWN Core client (`GET/POST /subagents…`), a store, and the surface DOM. Nothing
 * frontend-only: the list, the persona page, the creation flow and the chat all
 * read and write the real Core.
 */

import type { ShellContext, ShellPage, PageFactory } from "../shell/types";
import { createAgentApi, type AgentApi } from "../agents/api";
import { createAgentsStore, type AgentsStore } from "../agents/store";
import { renderAgentsSurface, type AgentsSurfaceHandle } from "../agents/agents-page";

/** The shell route this page answers. */
export const AGENTS_ROUTE = "agents" as const;

/** Build the store over the shell's Core client (its base URL, its transport). */
export function createAgentsStoreFor(ctx: ShellContext): AgentsStore {
  const api: AgentApi = createAgentApi({ baseUrl: ctx.client.baseUrl });
  return createAgentsStore(api);
}

/** The `PageFactory` the shell registers for the "agents" route. */
export const mountAgents: PageFactory = (ctx: ShellContext): ShellPage => {
  const store = createAgentsStoreFor(ctx);
  const surface: AgentsSurfaceHandle = renderAgentsSurface(store);
  return {
    el: surface.el,
    sync: () => surface.sync(),
    destroy: () => surface.destroy(),
  };
};

/**
 * Mount the Agents surface onto a bare host element, with no shell.
 *
 * Used by the live verification harness (and `npm run dev`): point it at a
 * running Core and the real list/detail/chat render. Returns the handle so a
 * probe can drive it.
 */
export function mountAgentsStandalone(
  root: HTMLElement,
  options: { baseUrl?: string; api?: AgentApi } = {},
): { store: AgentsStore; el: HTMLElement; destroy(): void } {
  const api = options.api ?? createAgentApi(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {});
  const store = createAgentsStore(api);
  const surface = renderAgentsSurface(store);
  root.append(surface.el);
  return {
    store,
    el: surface.el,
    destroy: () => {
      surface.destroy();
      surface.el.remove();
    },
  };
}
