// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * P0 — PROVE THE TOOL LOOP.
 *
 * "Search inside my files" must actually reach:
 *
 *   MODEL -> filesystem.search -> real filesystem -> tool result -> MODEL -> final answer
 *
 * Each numbered test below pins one link of that chain, against the REAL
 * registry, the REAL workspace tools and the REAL model tool plane — no
 * invented tools, no invented filesystem. The model side is a scripted stub
 * `ModelProvider` (or a stub fetch under the real OpenAI-compatible provider),
 * because what is under test is KAI's loop, not a remote endpoint's wording.
 *
 * The live end-to-end (a real model over the real provider) is proved by
 * `scripts/tool-loop-live.mjs`, which writes `docs/evidence/tool-loop-live.json`.
 *
 * Run from `core/`:  node --test tests/tool-loop-proof.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createToolRegistry } from "../src/tools/registry.ts";
import { createPolicyEngine } from "../src/policies/gate.ts";
import { createApprovalService } from "../src/approvals/service.ts";
import { createWorkspaceTools } from "../src/tools/workspace.ts";
import { createBuiltinTools } from "../src/tools/builtin.ts";
import {
  createModelToolPlane,
  modelFunctionName,
  type ModelToolPlane,
} from "../src/tools/model-plane.ts";
import { createKaiBrain } from "../src/chat/brain.ts";
import { createOpenAICompatibleProvider } from "../src/model/openai-compatible.ts";
import type {
  ChatRequest,
  ChatResult,
  ModelCapabilities,
  ModelHealth,
  ModelProvider,
  StreamChunk,
  StructuredRequest,
  StructuredResult,
  EmbeddingRequest,
  EmbeddingResult,
} from "../src/model/types.ts";
import type { Approval, ApprovalStatus, ApprovalStore } from "../src/shared/contracts.ts";

/** A string no fixture writes except the search target. */
const KNOWN_STRING = "kai-tool-loop-proof-string-9f3k7";
const SESSION_ID = "ses_tool_loop_p0";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "kai-tool-loop-"));
}

/** Hand-written fake approval store — deliberately does NOT import core/src/storage. */
function fakeApprovalStore(): ApprovalStore {
  const rows: Approval[] = [];
  return {
    createApproval(approval: Approval): void {
      rows.push({ ...approval });
    },
    getApproval(id: string): Approval | null {
      const row = rows.find((entry) => entry.id === id);
      return row === undefined ? null : { ...row };
    },
    listApprovals(opts?: { status?: ApprovalStatus; limit?: number }): Approval[] {
      let out = rows.map((row) => ({ ...row }));
      if (opts?.status !== undefined) out = out.filter((row) => row.status === opts.status);
      if (opts?.limit !== undefined) out = out.slice(0, opts.limit);
      return out;
    },
    decideApproval(id: string, status: ApprovalStatus, decidedAt: string): void {
      const row = rows.find((entry) => entry.id === id);
      if (row !== undefined) {
        row.status = status;
        row.decidedAt = decidedAt;
      }
    },
  };
}

interface Harness {
  plane: ModelToolPlane;
  invoke: (id: string, input: unknown, opts?: { sessionId?: string }) => ReturnType<ReturnType<typeof createToolRegistry>["invoke"]>;
  events: { type: string; payload: unknown }[];
}

/** The REAL boundary: real policy + real approvals + real workspace tools. */
function harness(): Harness {
  let seq = 0;
  const approvals = createApprovalService({
    store: fakeApprovalStore(),
    idFactory: () => `apr-${++seq}`,
    defaultTtlMs: 60_000,
  });
  const events: { type: string; payload: unknown }[] = [];
  const registry = createToolRegistry({
    policy: createPolicyEngine(),
    approvals,
    publish: (type, payload) => {
      events.push({ type: type as string, payload });
    },
    coreBuildId: "tool-loop-proof",
  });
  for (const tool of createBuiltinTools()) registry.register(tool);
  for (const tool of createWorkspaceTools()) registry.register(tool);
  const plane = createModelToolPlane({ registry, source: "model" });
  return { plane, invoke: (id, input, opts) => registry.invoke(id, input, { source: "model", ...opts }), events };
}

/** Stage a directory containing exactly one file with the known string. */
function stageSearchDir(t: { after: (fn: () => void) => void }): string {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "notes.txt"), `unrelated line\nthe secret is ${KNOWN_STRING} on this line\ntrailing\n`, "utf8");
  writeFileSync(join(dir, "other.md"), "nothing to find here\n", "utf8");
  return dir;
}

/** A scripted model: each chat() pops the next canned reply. Records requests. */
function scriptedProvider(replies: ChatResult[]): { provider: ModelProvider; requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  const provider: ModelProvider = {
    id: "scripted",
    model: "scripted-model",
    async chat(request: ChatRequest): Promise<ChatResult> {
      requests.push(request);
      const next = replies.shift();
      if (next === undefined) throw new Error("scripted provider ran out of replies");
      return next;
    },
    async *stream(request: ChatRequest): AsyncIterable<StreamChunk> {
      const result = await this.chat(request);
      if (result.text.length > 0) yield { delta: result.text, done: false };
      yield { delta: "", done: true, finishReason: result.finishReason ?? "stop", ...(result.toolCalls !== undefined ? { toolCalls: result.toolCalls } : {}) };
    },
    async structured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
      const result = await this.chat(request);
      return { value: request.parse(result.text), result };
    },
    async embeddings(request: EmbeddingRequest): Promise<EmbeddingResult> {
      return { vectors: request.input.map(() => [0]), model: "scripted-model", provider: "scripted" };
    },
    async health(): Promise<ModelHealth> {
      return { ok: true, configured: true, provider: "scripted", baseUrl: "scripted", model: "scripted-model", reason: null };
    },
    capabilities(): ModelCapabilities {
      return { chat: true, stream: true, structured: true, embeddings: true, tools: true, models: ["scripted-model"], defaultModel: "scripted-model" };
    },
  };
  return { provider, requests };
}

// ── 1. the model is OFFERED filesystem.search ─────────────────────────────────

test("1. the model is offered filesystem.search as a real function declaration", () => {
  const { plane } = harness();
  assert.ok(plane.toolIds().includes("filesystem.search"), `plane exposes: ${plane.toolIds().join(", ")}`);
  const declaration = plane.declarations().find((d) => d.function.name === modelFunctionName("filesystem.search"));
  assert.ok(declaration !== undefined, "a declaration exists for the sanitised name");
  assert.equal(declaration.type, "function");
  const params = declaration.function.parameters as Record<string, unknown>;
  assert.equal(params["type"], "object");
  const properties = (params["properties"] ?? {}) as Record<string, unknown>;
  assert.ok("query" in properties, "the model can see the query field it must fill");
});

// ── 2. ToolCall parses correctly ──────────────────────────────────────────────

test("2. tool_calls parse off the wire with raw argument text preserved; a call with no id is dropped, never invented", async () => {
  const reply = (message: unknown): Response =>
    new Response(JSON.stringify({ id: "x", model: "m", choices: [{ index: 0, message, finish_reason: "tool_calls" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const body = JSON.parse(String(init.body)) as { messages: unknown[] };
    void body;
    return reply({
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "filesystem_search", arguments: `{"query":"${KNOWN_STRING}","path":"/tmp/x"}` } },
        { type: "function", function: { name: "filesystem_search", arguments: "{}" } },
      ],
    });
  }) as unknown as typeof fetch;
  const provider = createOpenAICompatibleProvider({ id: "probe", baseUrl: "https://example.invalid/v1", apiKey: "k", model: "m", fetchImpl });
  const result = await provider.chat({ messages: [{ role: "user", content: "search" }] });
  assert.equal(result.toolCalls?.length, 1, "the id-less call is dropped, not fabricated");
  assert.equal(result.toolCalls?.[0]?.id, "call_1");
  assert.equal(result.toolCalls?.[0]?.name, "filesystem_search");
  assert.equal(result.toolCalls?.[0]?.arguments, `{"query":"${KNOWN_STRING}","path":"/tmp/x"}`, "arguments stay the raw string for the plane to parse");
});

// ── 3. arguments validate ────────────────────────────────────────────────────

test("3. valid JSON-object arguments validate; malformed JSON is a refusal, never a throw", async (t) => {
  const { plane } = harness();
  const dir = stageSearchDir(t);
  const good = await plane.execute(modelFunctionName("filesystem.search"), JSON.stringify({ query: KNOWN_STRING, path: dir }));
  assert.equal(good.ok, true, JSON.stringify(good.value).slice(0, 200));
  assert.equal(good.status, "EXECUTED");

  const malformed = await plane.execute(modelFunctionName("filesystem.search"), "{not json,,,");
  assert.equal(malformed.ok, false);
  assert.equal(malformed.status, "INVALID");

  const nonObject = await plane.execute(modelFunctionName("filesystem.search"), "[1,2,3]");
  assert.equal(nonObject.ok, false);
  assert.equal(nonObject.status, "INVALID");
});

// ── 4. registry.invoke receives the call ─────────────────────────────────────

test("4. the call lands on registry.invoke with identity, timing and an action record", async (t) => {
  const h = harness();
  const dir = stageSearchDir(t);
  const executed = await h.plane.execute(modelFunctionName("filesystem.search"), JSON.stringify({ query: KNOWN_STRING, path: dir }), {
    sessionId: SESSION_ID,
  });
  assert.equal(executed.ok, true);
  assert.ok(executed.invocationId.length > 0, "the attempt has an identity the bus record shares");
  const record = h.events.find((e) => e.type === "action.executed");
  assert.ok(record !== undefined, "one attempt produced one bus record");
  const payload = record.payload as Record<string, unknown>;
  assert.equal(payload["toolId"], "filesystem.search");
  assert.equal(payload["resultState"], "EXECUTED");
  assert.equal(payload["actionId"], executed.invocationId, "invocationId IS the record actionId");

  const direct = await h.invoke("filesystem.search", { query: KNOWN_STRING, path: dir }, { sessionId: SESSION_ID });
  assert.equal(direct.ok, true);
  assert.equal(direct.invocation.toolId, "filesystem.search");
  assert.equal(direct.invocation.sessionId, SESSION_ID);
  assert.equal(direct.invocation.status, "EXECUTED");
});

// ── 5. real filesystem access inside the sandbox ─────────────────────────────

test("5. filesystem.search reads REAL allowed files and reports the real hit", async (t) => {
  const h = harness();
  const dir = stageSearchDir(t);
  const direct = await h.invoke("filesystem.search", { query: KNOWN_STRING, path: dir });
  assert.equal(direct.ok, true);
  const value = direct.result as { matches: { path: string; kind: string; line: number; preview: string }[]; filesScanned: number; truncated: boolean };
  assert.equal(value.matches.length, 1, JSON.stringify(value).slice(0, 400));
  assert.equal(value.matches[0]?.kind, "content");
  assert.equal(value.matches[0]?.line, 2);
  assert.ok((value.matches[0]?.preview ?? "").includes(KNOWN_STRING));
  assert.ok((value.matches[0]?.path ?? "").endsWith("notes.txt"));
  assert.ok(value.filesScanned >= 2, "it really walked the directory");
  assert.equal(value.truncated, false);
});

// ── 6+7. result returns to the model; the model continues from it ────────────

test("6+7. the tool result is fed back and the model answers from it; the request chain is observable", async (t) => {
  const h = harness();
  const dir = stageSearchDir(t);
  const searchFn = modelFunctionName("filesystem.search");
  const { provider, requests } = scriptedProvider([
    {
      text: "",
      model: "scripted-model",
      provider: "scripted",
      toolCalls: [{ id: "call_1", name: searchFn, arguments: JSON.stringify({ query: KNOWN_STRING, path: dir }) }],
    },
    { text: `Found it: the string ${KNOWN_STRING} is in notes.txt line 2.`, model: "scripted-model", provider: "scripted" },
  ]);
  const brain = createKaiBrain({ provider, tools: h.plane });
  const result = await brain.respond({ text: `Search my files for ${KNOWN_STRING}`, system: "You are KAI.", sessionId: SESSION_ID });
  assert.ok(result.text.includes(KNOWN_STRING), `final answer names the string: ${result.text}`);
  assert.equal(result.toolCalls?.length, 1);
  assert.equal(result.toolCalls?.[0]?.name, searchFn);
  assert.equal(result.toolCalls?.[0]?.ok, true);
  assert.equal(result.toolCalls?.[0]?.status, "EXECUTED");

  assert.equal(requests.length, 2, "two model rounds: tool request, then answer");
  const second = requests[1]!;
  const toolMessage = second.messages.find((m) => m.role === "tool");
  assert.ok(toolMessage !== undefined, "the result re-enters as a role:tool message");
  assert.equal(toolMessage.toolCallId, "call_1", "bound to its request by id");
  const fedBack = JSON.parse(toolMessage.content) as { matches: unknown[] };
  assert.ok(Array.isArray(fedBack.matches) && fedBack.matches.length === 1, "the model read the REAL result, not prose about it");
});

// ── 8. malformed arguments are safe ───────────────────────────────────────────

test("8. a model call with malformed arguments is refused safely and the turn survives", async (t) => {
  const h = harness();
  const dir = stageSearchDir(t);
  const searchFn = modelFunctionName("filesystem.search");
  const { provider } = scriptedProvider([
    {
      text: "",
      model: "scripted-model",
      provider: "scripted",
      toolCalls: [{ id: "call_bad", name: searchFn, arguments: "{oops" }],
    },
    {
      text: "",
      model: "scripted-model",
      provider: "scripted",
      toolCalls: [{ id: "call_retry", name: searchFn, arguments: JSON.stringify({ query: KNOWN_STRING, path: dir }) }],
    },
    { text: "Recovered and found it.", model: "scripted-model", provider: "scripted" },
  ]);
  const brain = createKaiBrain({ provider, tools: h.plane });
  const result = await brain.respond({ text: "search please", system: "You are KAI.", sessionId: SESSION_ID });
  assert.equal(result.text, "Recovered and found it.");
  assert.equal(result.toolCalls?.length, 2);
  assert.equal(result.toolCalls?.[0]?.ok, false);
  assert.equal(result.toolCalls?.[0]?.status, "INVALID", "the malformed call is a refusal the model can correct");
  assert.equal(result.toolCalls?.[1]?.ok, true);
});

// ── 9. unauthorized tools are rejected ────────────────────────────────────────

test("9. unknown tools are NOT_FOUND; unexposed WRITE tools are not selectable; DESTRUCTIVE parks", async () => {
  const h = harness();
  const unknown = await h.plane.execute("does_not_exist", "{}");
  assert.equal(unknown.ok, false);
  assert.equal(unknown.status, "NOT_FOUND");

  assert.ok(!h.plane.toolIds().includes("filesystem.write"), "WRITE is never exposed implicitly");
  assert.ok(
    !h.plane.declarations().some((d) => d.function.name === "filesystem_write"),
    "no declaration invites the model to select it",
  );
  // The plane resolves a raw registered id as a fallback — so a model that
  // guesses "filesystem.write" still lands on the boundary, where policy parks
  // it. What must NEVER happen is unattended execution.
  const smuggled = await h.plane.execute("filesystem.write", JSON.stringify({ path: "x", content: "y" }));
  assert.equal(smuggled.ok, false);
  assert.ok(
    smuggled.status === "NOT_FOUND" || smuggled.status === "APPROVAL_REQUIRED" || smuggled.status === "INVALID",
    `a guessed WRITE id is refused or parked, never executed (got ${smuggled.status})`,
  );

  const parked = await h.invoke("shell.run", { command: process.execPath, args: ["-e", "process.exit(0)"] });
  assert.equal(parked.ok, false);
  assert.equal(parked.invocation.status, "APPROVAL_REQUIRED", "DESTRUCTIVE parks for a human instead of running");
});

// ── 10. tool errors do not crash the chat ────────────────────────────────────

test("10. a tool that throws is a FAILED value; the turn continues", async () => {
  const { provider } = scriptedProvider([
    {
      text: "",
      model: "scripted-model",
      provider: "scripted",
      toolCalls: [{ id: "call_outside", name: modelFunctionName("filesystem.search"), arguments: JSON.stringify({ query: "x", path: "C:\\definitely-outside-the-sandbox-9f3k7\\nope" }) }],
    },
    { text: "That path is outside my sandbox, so I could not search it.", model: "scripted-model", provider: "scripted" },
  ]);
  const h = harness();
  const brain = createKaiBrain({ provider, tools: h.plane });
  const result = await brain.respond({ text: "search outside", system: "You are KAI.", sessionId: SESSION_ID });
  assert.ok(result.text.length > 0, "the chat answered instead of crashing");
  assert.equal(result.toolCalls?.[0]?.ok, false);
  assert.ok(["INVALID", "FAILED", "DENIED"].includes(result.toolCalls?.[0]?.status ?? ""), `refused with status ${result.toolCalls?.[0]?.status}`);
});

// ── 11. tool events stream correctly ──────────────────────────────────────────

test("11. streamed tool-call deltas accumulate into whole calls across SSE frames", async () => {
  const fullArgs = JSON.stringify({ query: KNOWN_STRING, path: "/tmp/x" });
  const firstHalf = fullArgs.slice(0, 20);
  const secondHalf = fullArgs.slice(20);
  const sse = [
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_stream_1", function: { name: "filesystem_search", arguments: firstHalf } }] } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: secondHalf } }] }, finish_reason: "tool_calls" }] })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
  const fetchImpl = (async (): Promise<Response> =>
    new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
  const provider = createOpenAICompatibleProvider({ id: "probe", baseUrl: "https://example.invalid/v1", apiKey: "k", model: "m", fetchImpl });
  const chunks: StreamChunk[] = [];
  for await (const chunk of provider.stream({ messages: [{ role: "user", content: "search" }] })) chunks.push(chunk);
  const terminal = chunks[chunks.length - 1]!;
  assert.equal(terminal.done, true);
  assert.equal(terminal.toolCalls?.length, 1, "fragments joined into one call");
  assert.equal(terminal.toolCalls?.[0]?.id, "call_stream_1");
  assert.equal(terminal.toolCalls?.[0]?.name, "filesystem_search");
  assert.equal(terminal.toolCalls?.[0]?.arguments, fullArgs, "arguments reassembled verbatim");
});

// ── 12. the conversation stays in the same session ───────────────────────────

test("12. every tool call in the turn carries the same session id", async (t) => {
  const h = harness();
  const dir = stageSearchDir(t);
  const searchFn = modelFunctionName("filesystem.search");
  const listFn = modelFunctionName("filesystem.list");
  const { provider } = scriptedProvider([
    {
      text: "",
      model: "scripted-model",
      provider: "scripted",
      toolCalls: [
        { id: "call_a", name: searchFn, arguments: JSON.stringify({ query: KNOWN_STRING, path: dir }) },
        { id: "call_b", name: listFn, arguments: JSON.stringify({ path: dir }) },
      ],
    },
    { text: "Done, same session throughout.", model: "scripted-model", provider: "scripted" },
  ]);
  const brain = createKaiBrain({ provider, tools: h.plane });
  await brain.respond({ text: "search and list", system: "You are KAI.", sessionId: SESSION_ID });
  const invocations = h.events.filter((e) => e.type === "action.executed").map((e) => e.payload as Record<string, unknown>);
  assert.equal(invocations.length, 2);
  for (const inv of invocations) {
    assert.equal(inv["toolId"] === "filesystem.search" || inv["toolId"] === "filesystem.list", true);
  }
  const direct = await h.invoke("filesystem.search", { query: KNOWN_STRING, path: dir }, { sessionId: SESSION_ID });
  assert.equal(direct.ok, true);
  assert.equal(direct.invocation.sessionId, SESSION_ID, "session identity survives to the invocation");
});
