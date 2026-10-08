// Transport-contract tests for slash commands and tool-call rendering inputs
// (`src/core/kai-core.ts` client + `src/chat/tool-card.ts`).
//
//   cd app && node --test "tests/commands-surface.test.ts"
//
// Injected `fetchImpl` throughout; nothing touches a socket.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createCoreClient } from "../src/core/kai-core.ts";
import { describeToolActivity, describeToolCall } from "../src/chat/tool-card.ts";
import type { CoreToolEvent } from "../src/core/kai-core.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function recordingFetch(res: Response): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url: String(url), method: init?.method ?? "GET", body });
    return res;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

test("GET /commands parses the catalogue Core serves", async () => {
  const { fetchImpl } = recordingFetch(
    jsonResponse({
      commands: [
        { id: "new", title: "New session", description: "Create one.", usage: "/new" },
        { id: "help", title: "Help", description: "List.", usage: "/help" },
      ],
    }),
  );
  const client = createCoreClient({ fetchImpl });
  const res = await client.commands();
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.deepEqual(
    res.value.map((c) => c.id),
    ["new", "help"],
  );
  assert.equal(res.value[0]?.usage, "/new");
});

test("POST /commands/:id/run sends args and parses the markdown outcome", async () => {
  const { fetchImpl, calls } = recordingFetch(
    jsonResponse({ ok: true, result: { command: "tools", title: "3 tools", text: "## Tools\n- a", data: { count: 1 } } }),
  );
  const client = createCoreClient({ fetchImpl });
  const res = await client.runCommand("tools", ["git"]);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.value.command, "tools");
  assert.equal(res.value.title, "3 tools");
  assert.ok(res.value.text.includes("## Tools"));
  assert.equal(calls[0]?.url, "http://127.0.0.1:8788/commands/tools/run");
  assert.equal(calls[0]?.method, "POST");
  assert.deepEqual((calls[0]?.body as Record<string, unknown>)["args"], ["git"]);
});

test("runCommand passes a raw arg string through for Core to split", async () => {
  const { fetchImpl, calls } = recordingFetch(
    jsonResponse({ ok: true, result: { command: "memory", title: "x", text: "y" } }),
  );
  const client = createCoreClient({ fetchImpl });
  const res = await client.runCommand("memory", "my query here");
  assert.equal(res.ok, true);
  assert.deepEqual((calls[0]?.body as Record<string, unknown>)["args"], "my query here");
});

test("chat sends conversation_id (never session_id) and parses tool_calls", async () => {
  const { fetchImpl, calls } = recordingFetch(
    jsonResponse({
      agent: "core",
      reply: "found it",
      conversation_id: "sess_1",
      tool_calls: [
        {
          id: "t1",
          toolCallId: "call_1",
          toolName: "filesystem_search",
          toolId: "filesystem.search",
          arguments: '{"query":"x"}',
          status: "EXECUTED",
          startedAt: "2026-10-06T00:00:00.000Z",
          completedAt: "2026-10-06T00:00:01.000Z",
        },
      ],
    }),
  );
  const client = createCoreClient({ fetchImpl });
  const res = await client.chat("search please", "sess_1");
  assert.equal(res.ok, true);
  if (!res.ok) return;
  const body = calls[0]?.body as Record<string, unknown>;
  assert.equal(body["conversation_id"], "sess_1", "the KAI session rides as conversation_id");
  assert.equal(body["session_id"], undefined, "session_id (the worker namespace) is never sent");
  assert.equal(res.value.sessionId, "sess_1");
  assert.equal(res.value.toolCalls?.length, 1);
  assert.equal(res.value.toolCalls?.[0]?.toolId, "filesystem.search");
});

test("memory entry routes parse search/get/correct and surface a parked delete", async () => {
  const entry = {
    id: "m1",
    content: "the keeper likes tea",
    type: "note",
    provenance: "user_statement",
    source: "user_statement",
    importance: 3,
    confidence: 0.9,
    scope: "global",
    scopeId: "global",
    createdAt: "2026-10-06T00:00:00.000Z",
    updatedAt: "2026-10-06T00:00:00.000Z",
  };
  const { fetchImpl: searchFetch } = recordingFetch(jsonResponse({ hits: [{ entry, score: 1 }] }));
  const searchClient = createCoreClient({ fetchImpl: searchFetch });
  const searched = await searchClient.searchMemoryEntries("tea");
  assert.equal(searched.ok, true);
  if (!searched.ok) return;
  assert.equal(searched.value.length, 1);
  assert.equal(searched.value[0]?.provenance, "user_statement");
  assert.equal(searched.value[0]?.confidence, 0.9);

  const { fetchImpl: correctFetch, calls } = recordingFetch(jsonResponse({ memory: { ...entry, content: "weak tea" } }));
  const correctClient = createCoreClient({ fetchImpl: correctFetch });
  const corrected = await correctClient.correctMemoryEntry("m1", { content: "weak tea" });
  assert.equal(corrected.ok, true);
  if (!corrected.ok) return;
  assert.equal(corrected.value.content, "weak tea");
  assert.equal(calls[0]?.url, "http://127.0.0.1:8788/memory/m1/correct");

  const { fetchImpl: deleteFetch } = recordingFetch(
    jsonResponse({ error: true, reason: "parked", approvalRequired: true, approvalId: "apr-1" }, 409),
  );
  const deleteClient = createCoreClient({ fetchImpl: deleteFetch });
  const deleted = await deleteClient.deleteMemoryEntry("m1");
  assert.equal(deleted.ok, false, "a parked delete is a failure the UI renders as a park");
  if (deleted.ok) return;
  assert.equal(deleted.error.status, 409);
});

test("soul routes parse the live text and post an edit", async () => {
  const { fetchImpl } = recordingFetch(
    jsonResponse({ soul: { soul: "I am KAI.", version: "abc12345", soulPath: "C:/x/SOUL.md" } }),
  );
  const client = createCoreClient({ fetchImpl });
  const read = await client.getSoul();
  assert.equal(read.ok, true);
  if (!read.ok) return;
  assert.equal(read.value.version, "abc12345");
  assert.ok(read.value.soul.includes("KAI"));

  const { fetchImpl: setFetch, calls } = recordingFetch(jsonResponse({ soul: { ok: true } }));
  const setClient = createCoreClient({ fetchImpl: setFetch });
  const set = await setClient.setSoul("I am KAI, revised.");
  assert.equal(set.ok, true);
  assert.deepEqual((calls[0]?.body as Record<string, unknown>)["soul"], "I am KAI, revised.");
});

test("skill routes parse catalogue, detail, staging and park-aware mutations", async () => {
  const skill = {
    id: "nightly",
    name: "Nightly Verifier",
    description: "Verifies builds.",
    purpose: "Keep it green.",
    tools: ["filesystem.search"],
    constraints: ["Read-only"],
    tags: ["nightly"],
    version: "1.2.0",
    source: "user",
    contentHash: "ab".repeat(32),
    status: "enabled",
    revision: 1,
    revisionCount: 1,
    installedAt: "2026-10-06T00:00:00.000Z",
    updatedAt: "2026-10-06T00:00:00.000Z",
  };
  const { fetchImpl } = recordingFetch(jsonResponse({ skills: [skill] }));
  const listClient = createCoreClient({ fetchImpl });
  const listed = await listClient.skills();
  assert.equal(listed.ok, true);
  if (!listed.ok) return;
  assert.equal(listed.value.length, 1);
  assert.equal(listed.value[0]?.purpose, "Keep it green.");
  assert.deepEqual(listed.value[0]?.tools, ["filesystem.search"]);
  assert.deepEqual(listed.value[0]?.constraints, ["Read-only"]);

  const { fetchImpl: stagedFetch } = recordingFetch(
    jsonResponse({
      staged: [
        {
          stagedId: "stg_1",
          skillId: "nightly",
          sha256: "cd".repeat(32),
          source: "learned",
          stagedAt: "2026-10-06T00:00:00.000Z",
          expiresAt: "2026-10-06T00:15:00.000Z",
          name: "Nightly Verifier",
          description: "Verifies builds.",
          tags: [],
        },
      ],
    }),
  );
  const stagedClient = createCoreClient({ fetchImpl: stagedFetch });
  const staged = await stagedClient.stagedSkills();
  assert.equal(staged.ok, true);
  if (!staged.ok) return;
  assert.equal(staged.value[0]?.stagedId, "stg_1");

  const { fetchImpl: toggleFetch } = recordingFetch(
    jsonResponse({ error: true, reason: "parked", approvalRequired: true, approvalId: "apr-9" }, 409),
  );
  const toggleClient = createCoreClient({ fetchImpl: toggleFetch });
  const toggled = await toggleClient.setSkillEnabled("nightly", false);
  assert.equal(toggled.ok, false, "a parked toggle surfaces as a 409, never a fake change");
  if (toggled.ok) return;
  assert.equal(toggled.error.status, 409);
});

test("plan and mission transitions ride the typed client", async () => {
  const mission = {
    id: "mission_1",
    title: "Add search",
    status: "DRAFT",
    createdAt: "2026-10-06T00:00:00.000Z",
    updatedAt: "2026-10-06T00:00:00.000Z",
    steps: [{ id: "s1", index: 0, title: "Search", kind: "tool", status: "PENDING" }],
  };
  const { fetchImpl: planFetch, calls: planCalls } = recordingFetch(jsonResponse({ mission }));
  const planClient = createCoreClient({ fetchImpl: planFetch });
  const planned = await planClient.createPlan("add search");
  assert.equal(planned.ok, true);
  if (!planned.ok) return;
  assert.equal(planned.value.status, "DRAFT");
  assert.equal(planned.value.steps?.length, 1);
  assert.deepEqual((planCalls[0]?.body as Record<string, unknown>)["goal"], "add search");

  const { fetchImpl: startFetch, calls: startCalls } = recordingFetch(
    jsonResponse({ mission: { ...mission, status: "RUNNING" } }),
  );
  const startClient = createCoreClient({ fetchImpl: startFetch });
  const started = await startClient.startMission("mission_1");
  assert.equal(started.ok, true);
  if (!started.ok) return;
  assert.equal(started.value.status, "RUNNING");
  assert.equal(startCalls[0]?.url, "http://127.0.0.1:8788/missions/mission_1/start");
  assert.equal(startCalls[0]?.method, "POST");
});

test("POST /chat/stream parses deltas, tool events and the budget terminal", async () => {
  const sse = [
    `data: ${JSON.stringify({ delta: "Found " })}\n\n`,
    `data: ${JSON.stringify({ delta: "it." })}\n\n`,
    `data: ${JSON.stringify({ tool_event: { type: "tool_start", toolCallId: "call_1", toolName: "filesystem_search", toolId: "filesystem.search", invocationId: "", arguments: "{}", startedAt: "2026-10-06T00:00:00.000Z" } })}\n\n`,
    `data: ${JSON.stringify({ tool_event: { type: "tool_done", toolCallId: "call_1", toolName: "filesystem_search", toolId: "filesystem.search", invocationId: "act_1", status: "EXECUTED", startedAt: "2026-10-06T00:00:00.000Z", completedAt: "2026-10-06T00:00:01.000Z" } })}\n\n`,
    `data: ${JSON.stringify({ done: true, provider: "p", model: "m", conversation_id: "sess_9", tool_iterations: 1, tool_budget_exhausted: false })}\n\n`,
  ].join("");
  const calls: unknown[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  const client = createCoreClient({ fetchImpl });
  const deltas: string[] = [];
  const events: CoreToolEvent[] = [];
  const res = await client.chatStream("search please", "sess_9", {
    onDelta: (delta) => deltas.push(delta),
    onToolEvent: (event) => events.push(event),
  });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.value.text, "Found it.");
  assert.equal(res.value.sessionId, "sess_9");
  assert.equal(res.value.toolIterations, 1);
  assert.equal(res.value.toolBudgetExhausted, false);
  assert.deepEqual(deltas, ["Found ", "it."]);
  assert.equal(events.length, 2);
  assert.equal(events[0]?.type, "tool_start");
  assert.equal(events[1]?.type, "tool_done");
  assert.equal(events[1]?.toolId, "filesystem.search");
  const body = (calls[0] as { body: Record<string, unknown> }).body;
  assert.equal(body["conversation_id"], "sess_9", "streams name the KAI session too");
});

test("describeToolActivity sentences the real action", () => {
  assert.equal(describeToolActivity("filesystem.search", "filesystem_search"), "searching files");
  assert.equal(describeToolActivity(undefined, "filesystem_read"), "reading a file");
  assert.equal(describeToolActivity("mcp.echo.echo", "mcp_echo_echo"), "calling MCP echo.echo");
  assert.equal(describeToolActivity("bogus.tool", "bogus_tool"), "running bogus.tool");
});

test("describeToolCall names the canonical id with status glyphs and excerpts", () => {
  const search = describeToolCall({
    toolName: "filesystem_search",
    toolId: "filesystem.search",
    status: "EXECUTED",
    arguments: JSON.stringify({ query: "lighthouse", path: "/tmp/x" }),
    result: { matches: [{ path: "/tmp/x/a.txt" }] },
  });
  assert.equal(search.glyph, "✓");
  assert.equal(search.name, "filesystem.search", "canonical id, not the wire spelling");
  assert.equal(search.status, "EXECUTED");
  assert.ok(search.detail.includes("lighthouse"));
  assert.ok(search.detail.includes("1 match"));

  const parked = describeToolCall({
    toolName: "filesystem_write",
    status: "APPROVAL_REQUIRED",
    arguments: "{}",
    approvalId: "apr-1",
  });
  assert.equal(parked.glyph, "…");
  assert.equal(parked.name, "filesystem_write", "wire name when nothing resolved");
  assert.ok(parked.detail.includes("apr-1"));

  const failed = describeToolCall({ toolName: "x", status: "FAILED", arguments: "not-json{{{" });
  assert.equal(failed.glyph, "✕");
  assert.equal(failed.detail, "", "unparseable args yield no excerpt, never a guess");
});
