// The Tools / MCP / Activity pages — the pure layers, proven with no DOM, no
// socket and no Core. The DOM builders are exercised live (see the acceptance
// chain: mounted -> launched -> clicked -> real Core request -> real UI update);
// this suite pins the invariants that a live run cannot cheaply re-check:
//
//   - a tool's displayed risk/effect/dispatch comes from Core's DECLARED facts
//     only — never a front-end heuristic;
//   - the schema normalizer handles KAI's shape and the OpenGhost-style envelope;
//   - an MCP server's status is derived from {connected, enabled, transport}
//     only, and a remote (http/sse) server is BLOCKED with the honest
//     stdio-only reason — never hard-coded per name;
//   - the credential reader returns KEY NAMES and STATUS only — a value in the
//     payload is never carried out (the "never display a credential value" rule);
//   - the activity feed's grouping/filtering/time are pure and total.
//
//   cd app && node --test tests/pages-tools-mcp-activity.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  schemaFields,
  describeTool,
  toolExecutions,
  extractApprovalId,
  safeJson,
} from "../src/views/tools";
import { serverStatus, serverTarget, credentialKeys, fetchCredentialPresence } from "../src/views/mcp";
import { groupOf, groupColor, filterActivity, relativeTime } from "../src/views/activity";
import type { ToolDescription } from "../src/workspace/types";
import type { WorkspaceEventRow } from "../src/workspace/store";
import type { McpServerSummary } from "../src/workspace/types";

function tool(over: Partial<ToolDescription> = {}): ToolDescription {
  return {
    id: "agents.run_task",
    name: "Run a task",
    description: "Hand work to a worker.",
    permission: { risk: "EXTERNAL", effectful: false, sideEffecting: true },
    schema: { declared: true, schema: { kind: "object", properties: {}, additionalProperties: false } },
    ...over,
  };
}

test("schemaFields reads KAI's declared shape, per-property required, enum and items", () => {
  const view = tool({
    schema: {
      declared: true,
      schema: {
        kind: "object",
        properties: {
          limit: { type: "integer", description: "Max entries", minimum: 1, maximum: 500 },
          status: { type: "string", description: "Only this state", enum: ["DRAFT", "QUEUED"] },
          agentId: { type: "string", description: "The agent", required: true },
          tags: { type: "array", items: { type: "string" }, description: "Labels" },
        },
        additionalProperties: false,
      },
    },
  }).schema;
  const fields = schemaFields(view);
  assert.equal(fields.length, 4);
  const byName = Object.fromEntries(fields.map((f) => [f.name, f]));
  assert.equal(byName.limit?.type, "integer");
  assert.equal(byName.limit?.minimum, 1);
  assert.equal(byName.limit?.maximum, 500);
  assert.equal(byName.limit?.required, false);
  assert.equal(byName.status?.type, "enum");
  assert.deepEqual(byName.status?.enumValues, ["DRAFT", "QUEUED"]);
  assert.equal(byName.agentId?.required, true);
  assert.equal(byName.tags?.type, "array");
  assert.equal(byName.tags?.itemsType, "string");
});

test("schemaFields also accepts the OpenGhost-style { function: { parameters } } envelope", () => {
  const view = tool({
    schema: {
      declared: true,
      schema: {
        type: "function",
        function: {
          name: "read_file",
          parameters: { type: "object", properties: { path: { type: "string", description: "File path" } }, required: ["path"] },
        },
      },
    },
  }).schema;
  const fields = schemaFields(view);
  assert.equal(fields.length, 1);
  assert.equal(fields[0]?.name, "path");
  assert.equal(fields[0]?.required, true);
});

test("an undeclared schema yields an empty field list, never an invented field", () => {
  const view = tool({ schema: { declared: false, reason: "procedural validator" } }).schema;
  assert.deepEqual(schemaFields(view), []);
});

test("describeTool derives its display from Core's declared facts only", () => {
  const read = describeTool(tool({ permission: { risk: "READ", effectful: false, sideEffecting: false } }));
  assert.equal(read.effectWord, "reads only");
  assert.equal(read.risk, "READ");
  assert.match(read.dispatch, /read-only/);

  const external = describeTool(tool());
  assert.equal(external.effectWord, "affects other processes");
  assert.match(external.dispatch, /parks for approval/);

  const destructive = describeTool(tool({ permission: { risk: "DESTRUCTIVE", effectful: true, sideEffecting: true } }));
  assert.equal(destructive.effectWord, "can destroy");
});

test("describeTool reports an honest schema reason when none is declared", () => {
  const d = describeTool(tool({ schema: { declared: false, reason: "no input contract declared" } }));
  assert.equal(d.hasSchema, false);
  assert.equal(d.fieldCount, 0);
  assert.equal(d.schemaReason, "no input contract declared");
});

test("toolExecutions includes only events/actions that name the tool, and sorts newest first", () => {
  const events: WorkspaceEventRow[] = [
    { id: "e1", type: "approval.requested", at: "2026-10-05T10:00:00Z", text: "approval", line: "KAI needs approval for agents.run_task", worker: null, payload: { toolId: "agents.run_task" } },
    { id: "e2", type: "mission.progress", at: "2026-10-05T11:00:00Z", text: "working", line: "KAI is working", worker: null, payload: { title: "x" } },
    { id: "e3", type: "approval.requested", at: "2026-10-05T12:00:00Z", text: "approval", line: "KAI needs approval for missions.list", worker: null, payload: { toolId: "missions.list" } },
  ];
  const slice = {
    conn: "ONLINE" as const, lastError: null, lastSyncAt: null, tools: [], mcp: null, maintenance: null,
    actions: [{ toolId: "agents.run_task", action: "run", status: "EXECUTED", at: "2026-10-05T09:00:00Z" }],
    events,
  };
  const rows = toolExecutions(slice, "agents.run_task");
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.at, "2026-10-05T10:00:00Z"); // approval e1 outranks the older action
  assert.equal(rows[0]?.kind, "approval");
  assert.equal(rows[1]?.kind, "action");
});

test("extractApprovalId pulls Core's apr_ id out of a park reason", () => {
  assert.equal(extractApprovalId('approval "apr_muuk9sgg_4" is pending'), "apr_muuk9sgg_4");
  assert.equal(extractApprovalId("no id here"), undefined);
});

test("safeJson never throws on a cyclic or exotic value", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.doesNotThrow(() => safeJson(cyclic));
});

// ── MCP status ───────────────────────────────────────────────────────────────

function server(over: Partial<McpServerSummary> = {}): McpServerSummary {
  return {
    name: "discord", transport: "stdio", enabled: true, hasRisk: true, connected: false,
    toolCount: 0, resourceCount: null, ...over,
  };
}

test("a connected stdio server is CONNECTED", () => {
  const st = serverStatus(server({ connected: true, toolCount: 22 }));
  assert.equal(st.status, "CONNECTED");
  assert.equal(st.connectable, true);
});

test("a remote (http) enabled-but-unconnected server is BLOCKED with the honest stdio-only reason", () => {
  const st = serverStatus({ connected: false, enabled: true, transport: "http", hasRisk: true });
  assert.equal(st.status, "BLOCKED");
  assert.equal(st.connectable, false);
  assert.match(st.reason, /stdio transport only/);
});

test("a disabled server is DISABLED and an enabled-but-unconnected stdio server is ENABLED", () => {
  assert.equal(serverStatus(server({ enabled: false })).status, "DISABLED");
  assert.equal(serverStatus(server({ enabled: true, connected: false })).status, "ENABLED");
});

test("serverStatus is a pure function of the declared facts — the same facts give the same word", () => {
  const a = serverStatus({ connected: false, enabled: true, transport: "sse", hasRisk: true });
  const b = serverStatus({ connected: false, enabled: true, transport: "sse", hasRisk: true });
  assert.deepEqual(a, b);
});

test("serverTarget shows the command for stdio and the url for remote; credentialKeys gives NAMES only", () => {
  assert.equal(serverTarget(server({ command: "npx", args: ["-y", "@iqai/mcp-discord"] })), "npx -y @iqai/mcp-discord");
  assert.equal(serverTarget(server({ transport: "http", url: "https://mcp.canva.com/mcp" })), "https://mcp.canva.com/mcp");
  assert.deepEqual(credentialKeys(server({ envKeys: ["DISCORD_TOKEN"] })), ["DISCORD_TOKEN"]);
  assert.deepEqual(credentialKeys(server({ transport: "http", headerKeys: ["Authorization"] })), ["Authorization"]);
});

test("the credential reader carries KEY + STATUS only — a value in the payload never leaves", async () => {
  const fake = (async () =>
    ({
      ok: true,
      json: async () => ({
        server: {
          name: "discord",
          credentials: {
            keys: [
              { key: "DISCORD_TOKEN", kind: "env", target: "DISCORD_TOKEN", status: "PRESENT", value: "SECRET-DO-NOT-LEAK" },
            ],
            required: true,
          },
        },
      }),
    }) as unknown as Response) as typeof fetch;

  const out = await fetchCredentialPresence("http://127.0.0.1:8788", "discord", fake);
  assert.deepEqual(out, [{ key: "DISCORD_TOKEN", status: "PRESENT" }]);
  const serialized = JSON.stringify(out);
  assert.ok(!serialized.includes("SECRET-DO-NOT-LEAK"), "a credential value must never leave the reader");
  assert.ok(!("value" in (out[0] as object)), "the reader's result has no value field");
});

test("the credential reader fails closed to an empty list on a bad response", async () => {
  const broken = (async () => ({ ok: false, json: async () => ({}) }) as unknown as Response) as typeof fetch;
  assert.deepEqual(await fetchCredentialPresence("http://x", "discord", broken), []);
  const thrower = (async () => { throw new Error("boom"); }) as typeof fetch;
  assert.deepEqual(await fetchCredentialPresence("http://x", "discord", thrower), []);
});

// ── Activity ─────────────────────────────────────────────────────────────────

test("groupOf classifies real Core event families and is total", () => {
  assert.equal(groupOf("mission.started"), "missions");
  assert.equal(groupOf("approval.requested"), "approvals");
  assert.equal(groupOf("session.activated"), "sessions");
  assert.equal(groupOf("agent.status_changed"), "workers");
  assert.equal(groupOf("tool.completed"), "tools");
  assert.equal(groupOf("core.started"), "core");
  assert.equal(groupOf("something.new"), "all");
});

test("filterActivity filters by group and free text over KAI's line, Core text, type and worker", () => {
  const events: WorkspaceEventRow[] = [
    { id: "a", type: "mission.started", at: "2026-10-05T10:00:00Z", text: "Mission started", line: "KAI started a mission", worker: null },
    { id: "b", type: "agent.status_changed", at: "2026-10-05T10:01:00Z", text: "hermes is working", line: "KAI is working through worker \"hermes\"", worker: { id: "hermes" } },
  ];
  assert.equal(filterActivity(events, "all", "").length, 2);
  assert.equal(filterActivity(events, "missions", "").length, 1);
  assert.equal(filterActivity(events, "all", "hermes").length, 1);
  assert.equal(filterActivity(events, "all", "kAI is working").length, 1);
  assert.equal(filterActivity(events, "all", "zzz").length, 0);
});

test("groupColor returns a colour for every group and never throws", () => {
  for (const t of ["mission.x", "approval.x", "session.x", "agent.x", "tool.x", "core.x", "misc.x"]) {
    assert.equal(typeof groupColor(t), "string");
  }
});

test("relativeTime is honest and total", () => {
  const now = Date.parse("2026-10-05T12:00:00Z");
  assert.equal(relativeTime("2026-10-05T12:00:00Z", now), "just now");
  assert.equal(relativeTime("2026-10-05T11:56:00Z", now), "4m");
  assert.equal(relativeTime("2026-10-05T10:00:00Z", now), "2h");
  assert.equal(relativeTime("2026-10-02T12:00:00Z", now), "3d");
  assert.equal(relativeTime("not-a-date", now), "");
});
