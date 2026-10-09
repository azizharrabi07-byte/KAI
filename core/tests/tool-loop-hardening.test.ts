// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * P0 HARDENING — the five gaps closed after the live proof:
 *
 *   H1. filesystem.search resolves an omitted path to the workspace root.
 *   H2. The plane enforces declarations: DECLARATION → POLICY → APPROVAL → EXECUTE.
 *   H3. brain.stream()/respond() emit real tool-lifecycle events.
 *   H5. The tool-iteration budget is explicit config with a structured outcome.
 *
 * (H4 — tool-call transcript persistence — lives in tests/session-tool-history.test.ts
 * beside the session store work, because the persistence layer owns it.)
 *
 * Run from `core/`:  node --test tests/tool-loop-hardening.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createToolRegistry } from "../src/tools/registry.ts";
import { createPolicyEngine } from "../src/policies/gate.ts";
import { createApprovalService } from "../src/approvals/service.ts";
import { createBuiltinTools } from "../src/tools/builtin.ts";
import { createWorkspaceTools, defaultWorkspaceRoot } from "../src/tools/workspace.ts";
import { createModelToolPlane, modelFunctionName } from "../src/tools/model-plane.ts";
import { createKaiBrain, type BrainToolCallRecord } from "../src/chat/brain.ts";
import type {
  ChatRequest,
  ChatResult,
  ModelCapabilities,
  ModelHealth,
  ModelProvider,
  StreamChunk,
  ToolStreamEvent,
  StructuredRequest,
  StructuredResult,
  EmbeddingRequest,
  EmbeddingResult,
} from "../src/model/types.ts";
import type { Approval, ApprovalStatus, ApprovalStore } from "../src/shared/contracts.ts";

const KNOWN = "kai-hardening-proof-string-4x8q2";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "kai-hardening-"));
}

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

function registryWithTools() {
  let seq = 0;
  const approvals = createApprovalService({
    store: fakeApprovalStore(),
    idFactory: () => `apr-${++seq}`,
    defaultTtlMs: 60_000,
  });
  const registry = createToolRegistry({
    policy: createPolicyEngine(),
    approvals,
    coreBuildId: "hardening",
  });
  for (const tool of createBuiltinTools()) registry.register(tool);
  for (const tool of createWorkspaceTools()) registry.register(tool);
  return { registry, approvals };
}

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
      yield {
        delta: "",
        done: true,
        finishReason: result.finishReason ?? "stop",
        ...(result.toolCalls !== undefined ? { toolCalls: result.toolCalls } : {}),
      };
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
      return { chat: true, stream: true, structured: true, embeddings: true, tools: true, models: ["s"], defaultModel: "s" };
    },
  };
  return { provider, requests };
}

// ── H1. default search path ──────────────────────────────────────────────────

test("H1. an omitted search path resolves to the workspace root, not a failure", async (t) => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "notes.txt"), `line one\n${KNOWN} lives here\n`, "utf8");
  const previous = process.env.KAI_WORKSPACE_ROOT;
  process.env.KAI_WORKSPACE_ROOT = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.KAI_WORKSPACE_ROOT;
    else process.env.KAI_WORKSPACE_ROOT = previous;
  });

  assert.equal(defaultWorkspaceRoot(), dir, "the intended root is the declared workspace");
  const { registry } = registryWithTools();
  const plane = createModelToolPlane({ registry, source: "model" });
  const executed = await plane.execute(modelFunctionName("filesystem.search"), JSON.stringify({ query: KNOWN }));
  assert.equal(executed.ok, true, `omitted path must execute, got ${executed.status}: ${JSON.stringify(executed.value).slice(0, 200)}`);
  assert.equal(executed.status, "EXECUTED");
  const value = executed.value as { root: string; matches: { path: string }[] };
  assert.equal(value.root, dir);
  assert.equal(value.matches.length, 1);
  assert.ok(value.matches[0]?.path.endsWith("notes.txt"));
});

test("H1. the declaration leaves path optional and the boundary records the resolved path", async () => {
  const { registry } = registryWithTools();
  const plane = createModelToolPlane({ registry, source: "model" });
  const declaration = plane.declarations().find((d) => d.function.name === modelFunctionName("filesystem.search"))!;
  const params = declaration.function.parameters as { properties: Record<string, unknown>; required?: string[] };
  assert.ok("path" in params.properties, "path is visible on the wire");
  assert.ok(!(params.required ?? []).includes("path"), "path is optional on the wire");
  assert.ok((params.required ?? []).includes("query"), "query stays required");

  const tool = registry.get("filesystem.search")!;
  const validated = tool.validate({ query: KNOWN });
  assert.equal(validated.ok, true);
  if (validated.ok) {
    const args = validated.value as Record<string, unknown>;
    assert.equal(typeof args["path"], "string", "the boundary fills the resolved root into the validated value");
    assert.ok((args["path"] as string).length > 0);
  }
});

// ── H2. declaration enforcement ───────────────────────────────────────────────

test("H2. a declared READ tool executes; an undeclared READ tool is refused pre-policy", async (t) => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "a.txt"), `${KNOWN}\n`, "utf8");
  const { registry } = registryWithTools();
  // This turn exposes ONLY filesystem.list — search is registered but undeclared.
  const plane = createModelToolPlane({ registry, source: "model", ids: ["filesystem.list"] });
  assert.deepEqual(plane.toolIds(), ["filesystem.list"]);

  const listed = await plane.execute(modelFunctionName("filesystem.list"), JSON.stringify({ path: dir }));
  assert.equal(listed.ok, true);
  assert.equal(listed.status, "EXECUTED");

  const smuggled = await plane.execute("filesystem.search", JSON.stringify({ query: KNOWN, path: dir }));
  assert.equal(smuggled.ok, false);
  assert.equal(smuggled.status, "NOT_FOUND", "the declaration gate fires before policy");
  const value = smuggled.value as { error: string; message: string };
  assert.equal(value.error, "unknown_tool");
  assert.match(value.message, /not offered/, "the refusal says WHY: registered but not offered this turn");
});

test("H2. declared WRITE parks for approval; undeclared WRITE never reaches policy", async () => {
  const { registry } = registryWithTools();
  const declaredWrite = createModelToolPlane({ registry, source: "model", ids: ["filesystem.write"] });
  const parked = await declaredWrite.execute(
    modelFunctionName("filesystem.write"),
    JSON.stringify({ path: join(tmpdir(), "kai-hardening-should-not-exist.txt"), content: "x" }),
  );
  assert.equal(parked.ok, false);
  assert.equal(parked.status, "APPROVAL_REQUIRED", "DECLARATION passed, POLICY demanded a human");

  const defaultPlane = createModelToolPlane({ registry, source: "model" });
  assert.ok(!defaultPlane.toolIds().includes("filesystem.write"));
  const blocked = await defaultPlane.execute("filesystem.write", JSON.stringify({ path: "x", content: "y" }));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.status, "NOT_FOUND", "undeclared WRITE is refused at the declaration gate");

  const destructive = await defaultPlane.execute("shell.run", JSON.stringify({ command: "echo", args: ["hi"] }));
  assert.equal(destructive.ok, false);
  assert.equal(destructive.status, "NOT_FOUND", "undeclared DESTRUCTIVE never reaches policy either");
});

test("H2. an approved declaration executes on re-issue; a rejected one stays denied", async (t) => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { registry, approvals } = registryWithTools();
  const plane = createModelToolPlane({ registry, source: "model", ids: ["filesystem.write"] });
  const target = join(dir, "written.txt");
  const parked = await plane.execute(modelFunctionName("filesystem.write"), JSON.stringify({ path: target, content: "hello" }));
  assert.equal(parked.status, "APPROVAL_REQUIRED");
  const approvalId = (parked.value as { approvalRequired?: string }).approvalRequired;
  assert.ok(typeof approvalId === "string" && approvalId.length > 0);

  // As the UI Allow button would: grant, then re-issue the SAME tool+input.
  assert.equal(approvals.decide(approvalId, true).ok, true);
  const granted = await registry.invoke("filesystem.write", { path: target, content: "hello" }, { approvalId });
  assert.equal(granted.ok, true, "DECLARATION passed, POLICY saw the grant, EXECUTION ran");
  assert.equal(granted.invocation.status, "EXECUTED");

  // And a rejection never runs, even with the id in hand.
  const parked2 = await plane.execute(modelFunctionName("filesystem.write"), JSON.stringify({ path: join(dir, "no.txt"), content: "x" }));
  const approvalId2 = (parked2.value as { approvalRequired?: string }).approvalRequired!;
  assert.equal(approvals.decide(approvalId2, false).ok, true);
  const refused = await registry.invoke("filesystem.write", { path: join(dir, "no.txt"), content: "x" }, { approvalId: approvalId2 });
  assert.equal(refused.ok, false);
  assert.equal(refused.invocation.status, "DENIED");
});

// ── H3. real tool stream events ───────────────────────────────────────────────

test("H3. respond() emits tool_start/tool_done with identity, status and timestamps", async (t) => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "n.txt"), `${KNOWN}\n`, "utf8");
  const { registry } = registryWithTools();
  const plane = createModelToolPlane({ registry, source: "model" });
  const searchFn = modelFunctionName("filesystem.search");
  const events: ToolStreamEvent[] = [];
  const { provider } = scriptedProvider([
    { text: "", model: "s", provider: "scripted", toolCalls: [{ id: "call_1", name: searchFn, arguments: JSON.stringify({ query: KNOWN, path: dir }) }] },
    { text: "found", model: "s", provider: "scripted" },
  ]);
  const brain = createKaiBrain({ provider, tools: plane, onToolEvent: (e) => events.push(e) });
  const result = await brain.respond({ text: "search", system: "sys" });
  assert.equal(result.text, "found");
  assert.equal(events.length, 2);
  assert.equal(events[0]?.type, "tool_start");
  assert.equal(events[0]?.toolCallId, "call_1");
  assert.equal(events[0]?.toolName, searchFn);
  assert.ok((events[0]?.startedAt ?? "").length > 0);
  assert.equal(events[1]?.type, "tool_done");
  assert.equal(events[1]?.status, "EXECUTED");
  assert.ok((events[1]?.invocationId ?? "").length > 0, "the event carries the registry attempt identity");
  assert.ok((events[1]?.completedAt ?? "").length > 0);
  assert.ok(!Number.isNaN(Date.parse(events[1]?.completedAt ?? "")), "timestamps are real ISO strings");
  const record: BrainToolCallRecord | undefined = result.toolCalls?.[0];
  assert.equal(record?.invocationId, events[1]?.invocationId, "record and event name the same attempt");
});

test("H3. refusals emit tool_error; parks emit tool_approval_required", async () => {
  const { registry } = registryWithTools();
  const plane = createModelToolPlane({ registry, source: "model", ids: ["filesystem.list", "filesystem.write"] });
  const events: ToolStreamEvent[] = [];
  const { provider } = scriptedProvider([
    {
      text: "", model: "s", provider: "scripted",
      toolCalls: [
        { id: "bad", name: modelFunctionName("filesystem.list"), arguments: "{oops" },
        { id: "park", name: modelFunctionName("filesystem.write"), arguments: JSON.stringify({ path: "x", content: "y" }) },
      ],
    },
    { text: "done", model: "s", provider: "scripted" },
  ]);
  const brain = createKaiBrain({ provider, tools: plane, onToolEvent: (e) => events.push(e) });
  await brain.respond({ text: "go", system: "sys" });
  const kinds = events.map((e) => e.type);
  assert.deepEqual(kinds, ["tool_start", "tool_error", "tool_start", "tool_approval_required"]);
  const err = events[1]!;
  assert.equal(err.status, "INVALID");
  assert.ok((err.error?.code ?? "").length > 0, "the error carries a code");
  const park = events[3]!;
  assert.equal(park.status, "APPROVAL_REQUIRED");
});

test("H3. stream() yields tool events as chunks (values ride server-side; the wire preview is attached at the boundary) plus a budget-stamped terminal", async (t) => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "n.txt"), `${KNOWN}\n`, "utf8");
  const { registry } = registryWithTools();
  const plane = createModelToolPlane({ registry, source: "model" });
  const searchFn = modelFunctionName("filesystem.search");
  const listener: ToolStreamEvent[] = [];
  const { provider } = scriptedProvider([
    { text: "searching", model: "s", provider: "scripted", toolCalls: [{ id: "c1", name: searchFn, arguments: JSON.stringify({ query: KNOWN, path: dir }) }] },
    { text: "found it", model: "s", provider: "scripted" },
  ]);
  const brain = createKaiBrain({ provider, tools: plane, onToolEvent: (e) => listener.push(e) });
  const chunks: StreamChunk[] = [];
  for await (const chunk of brain.stream({ text: "search", system: "sys" })) chunks.push(chunk);
  const eventChunks = chunks.filter((c) => c.toolEvent !== undefined);
  assert.equal(eventChunks.length, 2, "start + done arrive as chunks");
  assert.equal(eventChunks[0]?.toolEvent?.type, "tool_start");
  assert.equal(eventChunks[1]?.toolEvent?.type, "tool_done");
  assert.ok("result" in (eventChunks[1]?.toolEvent ?? {}), "the streamed event carries the value server-side; server.ts attaches the bounded redacted preview for the wire");
  const { previewToolResult } = await import("../src/chat/result-preview.ts");
  const preview = previewToolResult((eventChunks[1]?.toolEvent as { result?: unknown })?.result);
  assert.ok((preview.resultPreview ?? "").includes(KNOWN), "the wire preview shows the real match");
  assert.equal(preview.resultTruncated, false);
  assert.equal(listener.length, 2, "the listener saw the same executions");
  assert.ok((listener[1]?.result as object) !== undefined, "…with the full value server-side");
  const terminal = chunks[chunks.length - 1]!;
  assert.equal(terminal.done, true);
  assert.equal(terminal.toolIterations, 1);
  assert.equal(terminal.maxToolIterations, 6);
  assert.equal(terminal.toolBudgetExhausted, false);
  assert.ok(chunks.some((c) => c.delta === "found it"), "answer text still streams");
});

// ── H5. explicit budget ──────────────────────────────────────────────────────

test("H5. the budget is explicit config; exhaustion is a structured flag, not silence", async () => {
  const { registry } = registryWithTools();
  const plane = createModelToolPlane({ registry, source: "model" });
  const searchFn = modelFunctionName("filesystem.search");
  const looping: ChatResult = { text: "", model: "s", provider: "scripted", toolCalls: [{ id: "c", name: searchFn, arguments: "{}" }] };
  const { provider } = scriptedProvider([looping, looping, looping]);
  const brain = createKaiBrain({ provider, tools: plane, maxToolIterations: 1 });
  const result = await brain.respond({ text: "loop", system: "sys" });
  assert.equal(result.toolIterations, 1);
  assert.equal(result.maxToolIterations, 1, "the configured budget is reported back");
  assert.equal(result.toolBudgetExhausted, true, "the model still wanted tools when the budget ran out");
  assert.equal(result.toolCalls?.length, 1, "what ran is still reported");
});

test("H5. a turn that finishes inside the budget is not flagged", async (t) => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "n.txt"), `${KNOWN}\n`, "utf8");
  const { registry } = registryWithTools();
  const plane = createModelToolPlane({ registry, source: "model" });
  const searchFn = modelFunctionName("filesystem.search");
  const { provider } = scriptedProvider([
    { text: "", model: "s", provider: "scripted", toolCalls: [{ id: "c1", name: searchFn, arguments: JSON.stringify({ query: KNOWN, path: dir }) }] },
    { text: "ok", model: "s", provider: "scripted" },
  ]);
  const brain = createKaiBrain({ provider, tools: plane, maxToolIterations: 6 });
  const result = await brain.respond({ text: "go", system: "sys" });
  assert.equal(result.toolBudgetExhausted, false);
  assert.equal(result.toolIterations, 1);
  assert.equal(result.maxToolIterations, 6);
});
