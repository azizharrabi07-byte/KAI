#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * P0 LIVE PROOF — "Search inside my files" end to end through the real loop:
 *
 *   USER text -> KAI brain -> real model -> tool_calls -> plane.execute ->
 *   registry.invoke -> REAL filesystem.search -> result -> model -> final answer
 *
 * Stages a temp directory containing one file with a known string, points
 * KAI_WORKSPACE_ROOT at it, and asks the REAL configured model to search for
 * the string. Exits non-zero unless the model actually selected
 * filesystem.search, the registry executed it, and the final answer names the
 * real hit. Writes the full trace to docs/evidence/tool-loop-live.json.
 *
 * Run from `core/`:  node scripts/tool-loop-live.mjs
 * Requires a configured model (KAI_MODEL_API_KEY or <KAI_HOME>/model/credentials.json).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CORE = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const { createToolRegistry } = await import("../src/tools/registry.ts");
const { createPolicyEngine } = await import("../src/policies/gate.ts");
const { createApprovalService } = await import("../src/approvals/service.ts");
const { createWorkspaceTools } = await import("../src/tools/workspace.ts");
const { createBuiltinTools } = await import("../src/tools/builtin.ts");
const { createModelToolPlane, modelFunctionName } = await import("../src/tools/model-plane.ts");
const { createKaiBrain } = await import("../src/chat/brain.ts");
const { createKaiModelProvider } = await import("../src/model/index.ts");

const KNOWN = `kai-live-proof-${Date.now().toString(36)}`;
const dir = mkdtempSync(join(tmpdir(), "kai-tool-loop-live-"));
writeFileSync(join(dir, "field-notes.txt"), `monday log\nthe lighthouse keeper wrote ${KNOWN} on the margin\nend\n`, "utf8");
writeFileSync(join(dir, "unrelated.md"), "groceries: bread, salt\n", "utf8");
// Sandbox the search to the staged dir (tmpdir is always an allowed root).
process.env.KAI_WORKSPACE_ROOT = dir;

const trace = {
  at: new Date().toISOString(),
  user: `Search my files for ${KNOWN}`,
  workspace: dir,
  knownString: KNOWN,
  provider: null,
  capabilities: null,
  declarationsOffered: [],
  rounds: [],
  toolExecutions: [],
  busRecords: [],
  finalAnswer: null,
  verdict: "pending",
};

const fail = (reason) => {
  trace.verdict = `FAIL: ${reason}`;
  console.error(`\nLIVE PROOF FAIL: ${reason}`);
  process.exitCode = 1;
};

try {
  // Real boundary, wired exactly like the runtime (minus stores/publish bus).
  const approvals = createApprovalService({ store: memApprovals(), defaultTtlMs: 60_000 });
  const bus = [];
  const registry = createToolRegistry({
    policy: createPolicyEngine(),
    approvals,
    publish: (type, payload) => bus.push({ type, payload }),
    coreBuildId: "tool-loop-live",
  });
  for (const tool of createBuiltinTools()) registry.register(tool);
  for (const tool of createWorkspaceTools()) registry.register(tool);

  const plane = createModelToolPlane({ registry, source: "model" });
  const provider = createKaiModelProvider();
  const caps = provider.capabilities();
  trace.provider = { id: provider.id, model: provider.model };
  trace.capabilities = caps;
  console.log(`provider=${provider.id} model=${provider.model} chat=${caps.chat} tools=${caps.tools}`);
  if (!caps.chat) {
    fail("model provider is not configured (no API key); cannot run a live proof");
    process.exit(1);
  }
  trace.declarationsOffered = plane.toolIds();
  if (!plane.toolIds().includes("filesystem.search")) {
    fail("filesystem.search is not offered to the model");
    process.exit(1);
  }

  // Wrap fetch to record every wire round (headers redacted, bodies truncated).
  const rawFetch = globalThis.fetch;
  const wireRounds = [];
  const tracingFetch = async (url, init = {}) => {
    const reqBody = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    const res = await rawFetch(url, init);
    const text = await res.text();
    wireRounds.push({
      url: String(url),
      status: res.status,
      requestMessages: reqBody?.messages?.map((m) => ({
        role: m.role,
        content: typeof m.content === "string" ? m.content.slice(0, 300) : m.content,
        tool_calls: m.tool_calls,
        tool_call_id: m.tool_call_id,
      })),
      requestTools: (reqBody?.tools ?? []).map((t) => t?.function?.name),
      responseBody: text.slice(0, 2000),
    });
    return new Response(text, { status: res.status, headers: { "content-type": "application/json" } });
  };

  const liveProvider = createKaiModelProvider({}, { fetchImpl: tracingFetch });
  const brain = createKaiBrain({ provider: liveProvider, tools: plane });

  const system =
    "You are KAI. The user asks to search inside their files. " +
    `Use the ${modelFunctionName("filesystem.search")} tool with the user's search string and path ${dir}, ` +
    "then answer from the tool result. Always search before answering.";
  const started = Date.now();
  const result = await brain.respond({
    text: `Search my files for ${KNOWN}`,
    system,
    sessionId: "ses_tool_loop_live",
  });
  trace.latencyMs = Date.now() - started;
  trace.rounds = wireRounds;
  trace.finalAnswer = result.text;
  trace.toolCalls = result.toolCalls ?? [];
  trace.busRecords = bus.map((e) => ({
    type: e.type,
    toolId: e.payload?.toolId,
    resultState: e.payload?.resultState,
    actionId: e.payload?.actionId,
    sessionId: undefined,
  }));

  // Verdict: the model must REALLY have searched, executed, and answered.
  const searchExec = (result.toolCalls ?? []).find((c) => c.name === modelFunctionName("filesystem.search"));
  const record = bus.find((e) => e.payload?.toolId === "filesystem.search" && e.payload?.resultState === "EXECUTED");
  const toolResultText = JSON.stringify(wireRounds.map((r) => r.responseBody)).slice(0, 4000);
  console.log("\n--- tool calls this turn ---");
  console.log(JSON.stringify(result.toolCalls ?? [], null, 2));
  console.log("\n--- final answer ---");
  console.log(result.text);
  if (!searchExec) fail("the model never selected filesystem.search");
  else if (!searchExec.ok) fail(`filesystem.search was selected but not executed (status ${searchExec.status})`);
  else if (!record) fail("no EXECUTED action record for filesystem.search on the bus");
  else if (!result.text.includes("field-notes.txt") && !result.text.includes(KNOWN))
    fail("final answer names neither the file nor the string — not grounded in the tool result");
  else {
    trace.verdict = "PASS: model selected filesystem.search, registry EXECUTED it on real files, final answer is grounded";
    console.log(`\nLIVE PROOF PASS (${trace.latencyMs} ms)`);
  }
  void toolResultText;
} finally {
  const outPath = join(CORE, "..", "docs", "evidence", "tool-loop-live.json");
  try {
    const { writeFileSync: write } = await import("node:fs");
    write(outPath, JSON.stringify(trace, null, 2), "utf8");
    console.log(`trace written to ${outPath}`);
  } catch (e) {
    console.error(`could not write trace: ${String(e)}`);
  }
  rmSync(dir, { recursive: true, force: true });
}

function memApprovals() {
  const rows = [];
  return {
    createApproval(a) {
      rows.push({ ...a });
    },
    getApproval(id) {
      return rows.find((r) => r.id === id) ?? null;
    },
    listApprovals(opts = {}) {
      let out = rows.map((r) => ({ ...r }));
      if (opts.status) out = out.filter((r) => r.status === opts.status);
      if (opts.limit) out = out.slice(0, opts.limit);
      return out;
    },
    decideApproval(id, status, decidedAt) {
      const row = rows.find((r) => r.id === id);
      if (row) {
        row.status = status;
        row.decidedAt = decidedAt;
      }
    },
  };
}
