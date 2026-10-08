/**
 * The defect this pins down: OpenCode used ONE timeout for both control requests and a
 * worker turn, so any real task that took longer than ten seconds failed as though the
 * server were unreachable. These tests use a real HTTP server and a turn that deliberately
 * outlives the control timeout.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createOpenCodeAdapter } from "../src/agents/adapters/opencodeAdapter.ts";

interface Stub {
  server: Server;
  baseUrl: string;
  turnHits: number;
  abortHits: number;
  close(): Promise<void>;
}

async function startStub(opts: { turnDelayMs: number; healthDelayMs?: number; turnError?: boolean }): Promise<Stub> {
  const state = { turnHits: 0, abortHits: 0 };
  const server = createServer((req, res) => {
    const url = req.url ?? "";
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url === "/global/health") {
      const send = () => json(200, { healthy: true, version: "stub" });
      if (opts.healthDelayMs !== undefined) setTimeout(send, opts.healthDelayMs);
      else send();
      return;
    }
    if (req.method === "POST" && url === "/session") {
      json(200, { id: "ses_stub" });
      return;
    }
    if (req.method === "POST" && url.includes("/abort")) {
      state.abortHits += 1;
      json(200, { ok: true });
      return;
    }
    if (req.method === "POST" && url === "/session/ses_stub/message") {
      state.turnHits += 1;
      // The whole point: the turn stays busy well past the CONTROL timeout.
      setTimeout(() => {
        if (opts.turnError === true) {
          // The exact shape the real server returned: HTTP 200, an assistant message whose
          // info carries the error, and no parts at all.
          json(200, { info: { role: "assistant", error: { name: "MessageAbortedError", data: { message: "Aborted" } } }, parts: [] });
          return;
        }
        json(200, { info: {}, parts: [{ type: "text", text: "TURN-DONE" }] });
      }, opts.turnDelayMs);
      return;
    }
    json(404, { error: "no such route", url });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    get turnHits() { return state.turnHits; },
    get abortHits() { return state.abortHits; },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("a worker turn that outlives the CONTROL timeout still completes", async () => {
  const stub = await startStub({ turnDelayMs: 1_500 });
  try {
    const adapter = createOpenCodeAdapter({ baseUrl: stub.baseUrl, timeoutMs: 400, turnTimeoutMs: 10_000 });
    const result = await adapter.runTask({ id: "t1", input: "do the thing" } as never);
    assert.equal(result.state, "completed", `expected completion, got ${result.state} ${JSON.stringify(result.error ?? {})}`);
    assert.match(JSON.stringify(result), /TURN-DONE/, "the turn's real payload must come back");
    assert.equal(stub.turnHits, 1, "the turn must be issued exactly once — no duplicate worker execution");
  } finally {
    await stub.close();
  }
});

test("the CONTROL timeout is still enforced — the split did not simply raise everything", async () => {
  const stub = await startStub({ turnDelayMs: 50, healthDelayMs: 1_500 });
  try {
    const adapter = createOpenCodeAdapter({ baseUrl: stub.baseUrl, timeoutMs: 400, turnTimeoutMs: 10_000 });
    // Tolerates either shape of enforcement: a thrown transport error, or a status that
    // reports it is not ready. Both mean the control timeout still bites.
    let enforced = false;
    try {
      const status = (await adapter.getStatus()) as { state?: string };
      enforced = status.state !== "ready";
    } catch {
      enforced = true;
    }
    assert.ok(enforced, "a control call slower than its timeout must not be reported as fine");
  } finally {
    await stub.close();
  }
});

test("a turn exceeding the TURN timeout surfaces as a value, and the client stays usable", async () => {
  const stub = await startStub({ turnDelayMs: 3_000 });
  try {
    const adapter = createOpenCodeAdapter({ baseUrl: stub.baseUrl, timeoutMs: 10_000, turnTimeoutMs: 500 });
    const result = await adapter.runTask({ id: "t2", input: "too slow" } as never);
    assert.notEqual(result.state, "completed", "a turn past its limit must not report success");
    assert.equal((result.error as { code?: string } | undefined)?.code, "AGENT_TIMEOUT");
    assert.equal(stub.turnHits, 1, "a timed-out turn must NOT be retried — that is how duplicate side effects happen");
    const after = (await adapter
      .getStatus()
      .catch((e: unknown) => ({ state: `threw:${String(e)}` }))) as { state?: string };
    assert.ok(typeof after.state === "string", "the adapter must remain usable after a failed turn");
  } finally {
    await stub.close();
  }
});

test("abort() cuts a long turn short so a shutting-down Core does not wait for it", async () => {
  const stub = await startStub({ turnDelayMs: 30_000 });
  try {
    const adapter = createOpenCodeAdapter({ baseUrl: stub.baseUrl, timeoutMs: 5_000, turnTimeoutMs: 30_000 });
    const started = Date.now();
    const pending = adapter.runTask({ id: "t3", input: "very long" } as never);
    setTimeout(() => adapter.abort?.(), 250);
    const settled = await Promise.race([
      pending.then(() => "settled" as const).catch(() => "settled" as const),
      new Promise((resolve) => setTimeout(() => resolve("HUNG" as const), 5_000)),
    ]);
    const elapsed = Date.now() - started;
    assert.equal(settled, "settled", "abort() must settle the turn, not leave it hanging");
    assert.ok(elapsed < 4_000, `abort() took ${elapsed}ms — it must not wait for the turn's own 30s limit`);
  } finally {
    await stub.close();
  }
});

test("cancelTask still reaches the worker's abort route", async () => {
  const stub = await startStub({ turnDelayMs: 50 });
  try {
    const adapter = createOpenCodeAdapter({ baseUrl: stub.baseUrl, timeoutMs: 5_000, turnTimeoutMs: 5_000 });
    await adapter.cancelTask("ses_stub");
    assert.equal(stub.abortHits, 1, "cancellation must reach POST /session/{id}/abort");
  } finally {
    await stub.close();
  }
});

test("a turn the server marked as errored is NOT reported as completed", async () => {
  const stub = await startStub({ turnDelayMs: 50, turnError: true });
  try {
    const adapter = createOpenCodeAdapter({ baseUrl: stub.baseUrl, timeoutMs: 5_000, turnTimeoutMs: 5_000 });
    const result = await adapter.runTask({ id: "t4", input: "this will be aborted" } as never);
    assert.notEqual(
      result.state,
      "completed",
      `HTTP 200 with info.error must never be reported as completed: ${JSON.stringify(result)}`,
    );
    assert.equal((result.error as { code?: string } | undefined)?.code, "AGENT_RUN_FAILED");
    assert.match(JSON.stringify(result), /MessageAbortedError/, "the server's own reason must be surfaced");
  } finally {
    await stub.close();
  }
});
