// What KAI actually ran, described from Core's persisted tool-call record.
//
// Both chat surfaces (the presence thread and the views/chat page) render
// exactly this: the canonical tool id, the registry status, and a short line
// about WHAT was asked and WHAT came back. Nothing here guesses — an
// unparseable argument string simply yields no excerpt.

export interface ToolCallLike {
  toolName: string;
  toolId?: string;
  status: string;
  arguments: string;
  result?: unknown;
  approvalId?: string;
}

export interface ToolCallDescription {
  glyph: string;
  /** The canonical registry id (`filesystem.search`), never the wire spelling. */
  name: string;
  status: string;
  detail: string;
}

/** One line about WHAT the model asked for: the query/path of the call. */
function argsLine(call: ToolCallLike): string {
  try {
    const args = JSON.parse(call.arguments) as Record<string, unknown>;
    const query = typeof args["query"] === "string" ? args["query"] : null;
    const path = typeof args["path"] === "string" ? args["path"] : null;
    if (query !== null && path !== null) return `“${query}” in ${path}`;
    if (query !== null) return `“${query}”`;
    if (path !== null) return path;
  } catch {
    // Non-JSON arguments contribute no excerpt.
  }
  return "";
}

/** How many matches a tool result reported, when it reports any. */
function resultLine(call: ToolCallLike): string {
  if (call.status === "APPROVAL_REQUIRED") {
    return call.approvalId !== undefined
      ? `waiting for your approval (${call.approvalId})`
      : "waiting for your approval";
  }
  if (call.status !== "EXECUTED" || typeof call.result !== "object" || call.result === null) return "";
  const matches = (call.result as Record<string, unknown>)["matches"];
  if (Array.isArray(matches)) return matches.length === 1 ? "1 match" : `${matches.length} matches`;
  return "";
}

/**
 * What KAI says while a tool runs — derived from the canonical id, so the
 * sentence is about the real action, never a guess. Used for the live
 * "searching…" state during a streamed turn.
 */
export function describeToolActivity(toolId: string | undefined, toolName: string): string {
  const id = toolId ?? toolName;
  if (id === "filesystem.search" || toolName === "filesystem_search") return "searching files";
  if (id === "filesystem.read" || toolName === "filesystem_read") return "reading a file";
  if (id === "filesystem.list" || toolName === "filesystem_list") return "listing files";
  if (id === "filesystem.metadata" || toolName === "filesystem_metadata") return "checking a path";
  if (id.startsWith("git.") || toolName.startsWith("git_")) return "reading git state";
  if (id === "memory.list" || toolName === "memory_list") return "recalling memories";
  if (id === "agents.list" || toolName === "agents_list") return "checking agents";
  if (id === "missions.list" || toolName === "missions_list") return "checking missions";
  if (id === "system.get_status" || toolName === "system_get_status") return "checking system state";
  if (id.startsWith("mcp.")) return `calling MCP ${id.slice(4)}`;
  if (id.startsWith("plugin.")) return `running plugin ${id.slice(7)}`;
  return `running ${id}`;
}

export function describeToolCall(call: ToolCallLike): ToolCallDescription {
  const glyph = call.status === "EXECUTED" ? "✓" : call.status === "APPROVAL_REQUIRED" ? "…" : "✕";
  const parts = [argsLine(call), resultLine(call)].filter((part) => part.length > 0);
  return {
    glyph,
    name: call.toolId ?? call.toolName,
    status: call.status,
    detail: parts.join(" · "),
  };
}
