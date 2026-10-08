/**
 * The KAI workspace — public surface.
 *
 * One import for the composition root: build a workspace (`createWorkspace` /
 * `startWorkspace`), mount it (`mountWorkspace`), and read its typed routes.
 * See `README.md` for the contract and the route→panel map.
 */

export { createWorkspace, startWorkspace } from "./workspace";
export type { Workspace, WorkspaceOptions } from "./workspace";
export { mountWorkspace } from "./mount";
export type { WorkspaceHandle, WorkspaceMountOptions } from "./mount";
export { createWorkspaceRoutes } from "./routes";
export type {
  WorkspaceRoutes,
  WorkspaceRoutesOptions,
  InvokeOptions,
  McpCallInput,
  McpServerCommand,
} from "./routes";
export {
  initialWorkspaceSlice,
  applySnapshot,
  applyWorkspaceEvent,
  setConnection,
  workspaceCounts,
  toolDispatchHint,
  actionLine,
} from "./store";
export type { WorkspaceSlice, WorkspaceEventRow, WorkspaceSnapshotInput } from "./store";
export { presentActivity, presentRuntime, presentWorkerRow, workerOf } from "./presenter";
export type { PresentedActivity, PresentedWorker } from "./presenter";
export { extractVisualBlocks, presentKaiMessage, VISUAL_MARKER } from "./visual";
export type { ExtractedVisual, PresentedMessage, VisualCompileHost, VisualMessageOutcome } from "./visual";
export type {
  ActionRecord,
  ComposedPromptView,
  MaintenanceReport,
  MaintenanceCheck,
  MaintenanceIdentity,
  McpCapabilityHealth,
  McpProvenanceRecord,
  McpServerSummary,
  McpSummary,
  PromptSectionReport,
  ToolDescription,
  ToolInvokeOutcome,
  ToolPermission,
  ToolSchemaView,
} from "./types";
