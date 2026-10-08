/**
 * agents/index.ts — the public surface of the Agents module (stream C).
 *
 * The shell mounts it through ONE line (see `views/agents.ts`):
 *   registerPage("agents", mountAgents);
 */

export { createAgentApi, AGENT_CORE_BASE_URL } from "./api";
export type {
  AgentApi,
  AgentResult,
  AgentError,
  Subagent,
  SubagentDetail,
  SubagentSession,
  SubagentSpecInput,
  SubagentVisual,
  SessionTurn,
  WorkerRow,
  CapabilityRow,
  CreateOutcome,
  LifecycleOutcome,
  MessageOutcome,
} from "./api";

export { createAgentsStore } from "./store";
export type { AgentsStore, AgentsState, AgentConn, AgentChatMessage, PendingTurn } from "./store";

export { renderAgentsSurface } from "./agents-page";
export type { AgentsSurfaceHandle } from "./agents-page";

export { renderAgentPage } from "./page";
export type { AgentPageHandle, AgentPageCallbacks } from "./page";

export { renderAgentChat } from "./chat";
export type { AgentChatHandle } from "./chat";

export { renderAgentForm } from "./create";
export type { AgentFormOptions } from "./create";
