// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Contract tests for the Codex adapter.
 *
 * Everything here runs against a SCRIPTED child process injected through the
 * transport's spawn seam, so the mapping from the Codex JSONL event stream to
 * `AgentTaskResult` is verified deterministically and without the CLI installed
 * (it is not installed on this machine — `codex --version` exits 127).
 *
 * The one LIVE test at the bottom skips with a NAMED reason when the binary is
 * absent: a skipped test is not a green test, and the reason says exactly what
 * was not verified.
 */

import nodeTest from "node:test";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { EventEmitter } from "node:events";

import { createCodexAdapter } from "./codexAdapter.ts";
import { createCodexTransport } from "../codex.ts";
import type { CodexChildProcess, CodexSpawnFn, CodexSpawnOptions } from "../codex.ts";
import type { AgentAdapter, KaiError } from "../../shared/contracts.ts";

/** The Error an adapter throws for the void/response APIs (mirrors hermesAdapter). */
interface AdapterFailureLike extends Error {
  kaiError: KaiError;
}

// ── The scripted child ────────────────────────────────────────────────────────

interface FakePlan {
  /** Exact bytes written to stdout (JSONL, newline-separated). */
  stdout?: string;
  stderr?: string;
  /** Exit code for the auto-close; ignored when `holdOpen` is set. */
  exitCode?: number | null;
  /** Emit this on the child's `error` event instead of running at all. */
  emitSpawnError?: NodeJS.ErrnoException;
  /** Never auto-close: the child stays alive so a test can time out or cancel it. */
  holdOpen?: boolean;
  /** Set false to drive emission by hand. */
  auto?: boolean;
}

class FakeChild extends EventEmitter {
  readonly pid = 4242;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdinChunks: string[] = [];
  stdinEnded = false;
  readonly killSignals: (NodeJS.Signals | number | undefined)[] = [];
  readonly stdin = {
    write: (chunk: string): boolean => {
      this.stdinChunks.push(chunk);
      return true;
    },
    end: (): void => {
      this.stdinEnded = true;
    },
  };
  private closed = false;
  private readonly plan: FakePlan;

  constructor(plan: FakePlan) {
    super();
    this.plan = plan;
    if (plan.auto !== false) {
      queueMicrotask(() => {
        if (plan.stderr !== undefined) this.stderr.emit("data", Buffer.from(plan.stderr));
        if (plan.emitSpawnError !== undefined) {
          this.emit("error", plan.emitSpawnError);
          return;
        }
        if (plan.stdout !== undefined) this.stdout.emit("data", Buffer.from(plan.stdout));
        if (plan.holdOpen === true) return;
        queueMicrotask(() => this.close(plan.exitCode ?? 0, null));
      });
    }
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(signal);
    if (this.plan.holdOpen === true) queueMicrotask(() => this.close(null, "SIGTERM"));
    return true;
  }

  close(code: number | null, signal: string | null): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close", code, signal);
  }
}

interface SpawnCall {
  command: string;
  args: string[];
  options: CodexSpawnOptions;
  child: FakeChild;
}

function scriptedSpawn(plan: FakePlan | ((callIndex: number) => FakePlan)): { spawnImpl: CodexSpawnFn; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const spawnImpl: CodexSpawnFn = (command, args, options) => {
    const resolved = typeof plan === "function" ? plan(calls.length) : plan;
    const child = new FakeChild(resolved);
    calls.push({ command, args: [...args], options, child });
    return child as unknown as CodexChildProcess;
  };
  return { spawnImpl, calls };
}

function jsonl(...events: unknown[]): string {
  return events.map((event) => JSON.stringify(event)).join("\n");
}

const TURN_COMPLETED = {
  type: "turn.completed",
  usage: { input_tokens: 11, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 22, reasoning_output_tokens: 0 },
};
const AGENT_MESSAGE = (text: string) => ({ type: "item.completed", item: { id: "item_1", type: "agent_message", text } });

/** Read a failure thrown by the void/response APIs without widening to `any`. */
function kaiErrorOf(error: unknown): AdapterFailureLike {
  const failure = error as Partial<AdapterFailureLike>;
  assert.equal(failure.name, "AdapterFailure", `expected an AdapterFailure, got ${String(error)}`);
  assert.ok(failure.kaiError !== undefined, "an AdapterFailure must carry a KaiError");
  return failure as AdapterFailureLike;
}

// ── run_task: the result comes from the event stream, never from the exit code ─

nodeTest("codex: a completed turn maps the terminal event, agent_message and usage", async () => {
  const { spawnImpl, calls } = scriptedSpawn({
    stdout: jsonl(
      { type: "thread.started", thread_id: "th_1" },
      { type: "turn.started" },
      { type: "future.event_we_do_not_know" }, // forward-compatible: ignored
      AGENT_MESSAGE("hello from codex"),
      TURN_COMPLETED,
    ),
    exitCode: 0,
  });
  const adapter = createCodexAdapter({ spawnImpl });

  const result = await adapter.runTask({ id: "t-success", input: "do the thing" });

  assert.equal(result.taskId, "t-success");
  assert.equal(result.state, "completed");
  assert.equal(result.output, "hello from codex");
  assert.deepEqual(result.usage, { inputTokens: 11, outputTokens: 22 });
  assert.equal(result.error, undefined);
  assert.equal(typeof result.startedAt, "string");
  assert.equal(typeof result.completedAt, "string");
  assert.match(result.startedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);

  // The prompt went to stdin, not to the command line.
  const call = calls[0]!;
  assert.equal(call.command, "codex");
  assert.equal(call.child.stdinChunks.join(""), "do the thing\n");
  assert.equal(call.child.stdinEnded, true);
});

nodeTest("codex: a non-zero exit with no terminal event is a failure carrying the code", async () => {
  const { spawnImpl } = scriptedSpawn({
    stdout: jsonl({ type: "turn.started" }),
    stderr: "boom: the model refused\n",
    exitCode: 2,
  });
  const adapter = createCodexAdapter({ spawnImpl });

  const result = await adapter.runTask({ id: "t-exit", input: "x" });

  assert.equal(result.state, "failed");
  assert.equal(result.error?.code, "AGENT_RUN_FAILED");
  assert.match(result.error?.message ?? "", /exited with code 2/);
  assert.match(result.error?.detail ?? "", /boom: the model refused/);
});

nodeTest("codex: exit 0 WITHOUT a terminal event is a failure, never success", async () => {
  const { spawnImpl } = scriptedSpawn({
    stdout: jsonl({ type: "thread.started", thread_id: "th_2" }, { type: "turn.started" }, AGENT_MESSAGE("looks done")),
    exitCode: 0,
  });
  const adapter = createCodexAdapter({ spawnImpl });

  const result = await adapter.runTask({ id: "t-missing-terminal", input: "x" });

  assert.equal(result.state, "failed");
  assert.notEqual(result.state, "completed");
  assert.equal(result.error?.code, "AGENT_BAD_RESPONSE");
  assert.match(result.error?.message ?? "", /without a terminal event/);
});

nodeTest("codex: malformed JSONL with no terminal event is a bad response", async () => {
  const { spawnImpl } = scriptedSpawn({ stdout: '{"type":"turn.started"\nnot-json-at-all', exitCode: 0 });
  const adapter = createCodexAdapter({ spawnImpl });

  const result = await adapter.runTask({ id: "t-malformed", input: "x" });

  assert.equal(result.state, "failed");
  assert.equal(result.error?.code, "AGENT_BAD_RESPONSE");
  assert.match(result.error?.message ?? "", /malformed JSONL/);
});

nodeTest("codex: turn.failed maps to a failed run carrying the CLI's message", async () => {
  const { spawnImpl } = scriptedSpawn({
    stdout: jsonl({ type: "turn.started" }, { type: "turn.failed", error: { message: "rate limited" } }),
    exitCode: 0,
  });
  const adapter = createCodexAdapter({ spawnImpl });

  const result = await adapter.runTask({ id: "t-turn-failed", input: "x" });

  assert.equal(result.state, "failed");
  assert.equal(result.error?.code, "AGENT_RUN_FAILED");
  assert.equal(result.error?.message, "rate limited");
});

nodeTest("codex: an unrecoverable stream error event is a failure", async () => {
  const { spawnImpl } = scriptedSpawn({ stdout: jsonl({ type: "error", message: "stream exploded" }), exitCode: 0 });
  const adapter = createCodexAdapter({ spawnImpl });

  const result = await adapter.runTask({ id: "t-stream-error", input: "x" });

  assert.equal(result.state, "failed");
  assert.equal(result.error?.code, "AGENT_RUN_FAILED");
  assert.equal(result.error?.message, "stream exploded");
});

nodeTest("codex: a lost child is abandoned, not success", async () => {
  const enoent = Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" });
  const { spawnImpl } = scriptedSpawn({ emitSpawnError: enoent });
  const adapter = createCodexAdapter({ spawnImpl });

  const result = await adapter.runTask({ id: "t-lost", input: "x" });

  assert.equal(result.state, "abandoned");
  assert.equal(result.error?.code, "AGENT_RUN_ABANDONED");
  assert.match(result.error?.detail ?? "", /not installed or not on PATH/);
});

nodeTest("codex: a run past its budget is killed and reported timed_out", async () => {
  const { spawnImpl, calls } = scriptedSpawn({ holdOpen: true });
  const adapter = createCodexAdapter({ spawnImpl, runTimeoutMs: 30 });

  const result = await adapter.runTask({ id: "t-timeout", input: "slow" });

  assert.equal(result.state, "timed_out");
  assert.equal(result.error?.code, "AGENT_TIMEOUT");
  assert.ok(calls[0]!.child.killSignals.length > 0, "a timed-out run must kill its child");
});

nodeTest("codex: cancelTask kills the child and reports cancelled", async () => {
  const { spawnImpl, calls } = scriptedSpawn({ holdOpen: true });
  const adapter = createCodexAdapter({ spawnImpl, runTimeoutMs: 60_000 });

  const pending = adapter.runTask({ id: "t-cancel", input: "stop me" });
  await adapter.cancelTask?.("t-cancel");
  const result = await pending;

  assert.equal(result.state, "cancelled");
  assert.equal(result.error?.code, "CANCELLED");
  assert.ok(calls[0]!.child.killSignals.length > 0, "a cancelled run must kill its child");
});

nodeTest("codex: cancelTask on an unknown task is a no-op, not a throw", async () => {
  const { spawnImpl } = scriptedSpawn({ holdOpen: true });
  const adapter = createCodexAdapter({ spawnImpl });
  await adapter.cancelTask?.("never-started");
});

nodeTest("codex: abort() cuts an in-flight turn", async () => {
  const { spawnImpl, calls } = scriptedSpawn({ holdOpen: true });
  const adapter = createCodexAdapter({ spawnImpl, runTimeoutMs: 60_000 });

  const pending = adapter.runTask({ id: "t-abort", input: "x" });
  adapter.abort?.();
  const result = await pending;

  assert.equal(result.state, "cancelled");
  assert.ok(calls[0]!.child.killSignals.length > 0);
});

// ── health / status / capabilities ────────────────────────────────────────────

nodeTest("codex: health() reports unavailable with a precise reason when the binary is missing", async () => {
  const enoent = Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" });
  const { spawnImpl, calls } = scriptedSpawn({ emitSpawnError: enoent });
  const adapter = createCodexAdapter({ spawnImpl });

  const health = await adapter.health();

  assert.equal(health.ok, false);
  assert.equal(health.endpoint, "codex");
  assert.equal(health.version, undefined);
  assert.match(health.detail ?? "", /not installed or not on PATH/);
  assert.deepEqual(calls[0]!.args, ["--version"], "health must probe with `codex --version`");

  await assert.rejects(
    () => adapter.connect(),
    (error: unknown) => {
      const failure = kaiErrorOf(error);
      assert.equal(failure.kaiError.code, "AGENT_NOT_LISTENING");
      return true;
    },
  );
});

nodeTest("codex: health() reports ok and the real version string when the CLI answers", async () => {
  const { spawnImpl } = scriptedSpawn({ stdout: "codex-cli 0.42.0\n", exitCode: 0 });
  const adapter = createCodexAdapter({ spawnImpl });

  const health = await adapter.health();
  assert.equal(health.ok, true);
  assert.equal(health.version, "codex-cli 0.42.0");
  assert.equal(health.detail, undefined);
  assert.equal(health.endpoint, "codex");

  const status = await adapter.getStatus();
  assert.equal(status.state, "idle");
});

nodeTest("codex: getStatus() is offline, with the probe's reason, when the binary is missing", async () => {
  const enoent = Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" });
  const { spawnImpl } = scriptedSpawn({ emitSpawnError: enoent });
  const adapter = createCodexAdapter({ spawnImpl });

  const status = await adapter.getStatus();
  assert.equal(status.state, "offline");
  assert.match(status.detail ?? "", /not installed or not on PATH/);
});

nodeTest("codex: capabilities are exactly what the adapter can really do (no sessions claim)", () => {
  const adapter: AgentAdapter = createCodexAdapter({});
  const capabilities = [...adapter.capabilities()];
  assert.deepEqual(capabilities, ["health", "status", "message", "run_task", "cancel_task"]);
  assert.equal(capabilities.includes("sessions"), false, "the adapter neither lists nor manages Codex sessions");
  assert.equal(adapter.id, "codex");
  assert.ok(typeof adapter.cancelTask === "function");
  assert.ok(typeof adapter.abort === "function");
});

// ── credentials never reach argv ──────────────────────────────────────────────

nodeTest("codex: no credential and no prompt ever appear in the spawned argv", async () => {
  const SECRET = "sk-live-SUPERSECRET-000";
  const { spawnImpl, calls } = scriptedSpawn({ stdout: jsonl({ type: "turn.started" }, TURN_COMPLETED), exitCode: 0 });
  const adapter = createCodexAdapter({
    spawnImpl,
    cwd: "C:/work",
    model: "gpt-5-codex",
    sandbox: "workspace-write",
    env: { OPENAI_API_KEY: SECRET },
  });

  await adapter.runTask({ id: "t-secret", input: `please use ${SECRET} on the repo` });

  const call = calls[0]!;
  const argv = call.args.join(" ");
  assert.equal(argv.includes(SECRET), false, "the credential must never be an argv element");
  assert.equal(argv.includes("please use"), false, "the prompt must never be an argv element");
  assert.deepEqual(call.args, [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--cd",
    "C:/work",
    "--model",
    "gpt-5-codex",
    "--sandbox",
    "workspace-write",
    "-",
  ]);
  // The credential IS in the child's environment — Codex's documented auth channel.
  assert.equal(call.options.env["OPENAI_API_KEY"], SECRET);
});

// ── sendMessage delegates to one turn ─────────────────────────────────────────

nodeTest("codex: sendMessage returns the agent text, and throws a KaiError on a failed turn", async () => {
  const ok = scriptedSpawn({ stdout: jsonl(AGENT_MESSAGE("pong"), TURN_COMPLETED), exitCode: 0 });
  const okAdapter = createCodexAdapter({ spawnImpl: ok.spawnImpl });
  const response = await okAdapter.sendMessage({ text: "ping" });
  assert.equal(response.text, "pong");
  assert.deepEqual(response.usage, { inputTokens: 11, outputTokens: 22 });

  const bad = scriptedSpawn({ stdout: jsonl({ type: "turn.failed", error: { message: "no auth" } }), exitCode: 1 });
  const badAdapter = createCodexAdapter({ spawnImpl: bad.spawnImpl });
  await assert.rejects(
    () => badAdapter.sendMessage({ text: "ping" }),
    (error: unknown) => {
      const failure = kaiErrorOf(error);
      assert.equal(failure.kaiError.code, "AGENT_RUN_FAILED");
      assert.equal(failure.kaiError.message, "no auth");
      return true;
    },
  );
});

// ── LIVE (skips with a named reason when the CLI is absent) ───────────────────

const liveProbe = await createCodexTransport({ probeTimeoutMs: 3_000 }).probe();
const LIVE_SKIP: string | false = liveProbe.available
  ? false
  : `codex CLI is not installed or not on PATH (probe said: ${liveProbe.detail ?? "unavailable"})`;

const liveTest = (name: string, fn: (t: TestContext) => unknown): void => {
  nodeTest(name, { skip: LIVE_SKIP }, fn as never);
};

liveTest("codex: LIVE — `codex --version` reports a version", async () => {
  const probe = await createCodexTransport({ probeTimeoutMs: 5_000 }).probe();
  console.log(`      -> live codex --version: ${probe.version ?? "(none)"}`);
  assert.equal(probe.available, true);
  assert.ok(typeof probe.version === "string" && probe.version.length > 0);
});

liveTest("codex: LIVE — a real `codex exec --json` turn reaches a definite terminal outcome", async () => {
  const transport = createCodexTransport({ runTimeoutMs: 120_000 });
  const handle = transport.run("Reply with the single word: pong");
  const outcome = await handle.result;
  console.log(`      -> live codex exec outcome: ${outcome.kind}`);
  assert.ok(
    outcome.kind === "completed" || outcome.kind === "failed" || outcome.kind === "exit" || outcome.kind === "timeout",
    `a real run must reach a definite outcome, got ${outcome.kind}`,
  );
});
