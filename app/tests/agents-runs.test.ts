// Subagent run tracking: transport contracts + event narration.
//
//   cd app && node --test "tests/agents-runs.test.ts"
//
// `listSubagentRuns` / `cancelSubagentRun` hit the real route shapes with an
// injected fetch; the presenter sentences come from the real new Core events
// (agent.run_started/completed/failed/cancelled, agent.spawned), KAI-subject,
// persona demoted.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentApi } from "../src/agents/api.ts";
import { presentActivity } from "../src/workspace/presenter.ts";
import { stateForEvent } from "../src/core/runtime-state.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("GET /subagents/runs parses tracked runs", async () => {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return jsonResponse({
      runs: [
        { runId: "run_1", subagentId: "researcher", employeeId: "kai:researcher", startedAt: "2026-10-06T00:00:00.000Z", status: "parked", approvalId: "apr-1" },
        { runId: "run_2", subagentId: "coder", employeeId: "kai:coder", startedAt: "2026-10-06T00:01:00.000Z", status: "running" },
      ],
    });
  }) as unknown as typeof fetch;
  const api = createAgentApi({ fetchImpl });
  const res = await api.listSubagentRuns();
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.value.length, 2);
  assert.equal(res.value[0]?.approvalId, "apr-1");
  assert.equal(res.value[1]?.approvalId, undefined);
  assert.equal(calls[0], "http://127.0.0.1:8788/subagents/runs");
});

test("POST /subagents/runs/:runId/cancel parses the cancelled run", async () => {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${String(url)}`);
    return jsonResponse({ runId: "run_1", cancelled: true });
  }) as unknown as typeof fetch;
  const api = createAgentApi({ fetchImpl });
  const res = await api.cancelSubagentRun("run_1");
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.value.runId, "run_1");
  assert.equal(calls[0], "POST http://127.0.0.1:8788/subagents/runs/run_1/cancel");
});

test("run lifecycle events narrate KAI-subject sentences and real states", () => {
  const started = presentActivity({ type: "agent.run_started", payload: { runId: "run_1", subagentId: "researcher" } });
  assert.ok(started !== null && started.line.includes("KAI") && started.line.includes("researcher"));
  assert.equal(stateForEvent({ type: "agent.run_started", payload: {} })?.state, "DELEGATING");

  const completed = presentActivity({ type: "agent.run_completed", payload: { runId: "run_1", subagentId: "researcher" } });
  assert.ok(completed !== null && completed.line.includes("finished"));
  assert.equal(stateForEvent({ type: "agent.run_completed", payload: {} })?.state, "SUCCESS");

  const failed = presentActivity({ type: "agent.run_failed", payload: { runId: "run_1", subagentId: "coder" } });
  assert.ok(failed !== null && failed.line.includes("failed"));
  assert.equal(stateForEvent({ type: "agent.run_failed", payload: {} })?.state, "ERROR");

  const cancelled = presentActivity({ type: "agent.run_cancelled", payload: { runId: "run_1", subagentId: "coder" } });
  assert.ok(cancelled !== null && cancelled.line.includes("cancelled"));

  const spawned = presentActivity({ type: "agent.spawned", payload: { subagentId: "researcher", name: "Researcher" } });
  assert.ok(spawned !== null && spawned.line.includes("spawned"));
});
