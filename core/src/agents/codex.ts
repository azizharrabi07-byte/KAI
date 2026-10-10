// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * codex.ts — the ONLY module in the Core that knows how to talk to the Codex CLI.
 *
 * The transport facts below were read out of openai/codex itself, not inferred
 * from the binary's name (a name is not evidence):
 *
 *   - The non-interactive entry point is `codex exec [OPTIONS] [PROMPT]`
 *     (codex-rs/exec/src/cli.rs).
 *
 *   - `--json` (alias `--experimental-json`) prints the event stream to stdout as
 *     JSONL, one `ThreadEvent` per line (codex-rs/exec/src/exec_events.rs):
 *
 *         { "type": "thread.started",  "thread_id": "..." }
 *         { "type": "turn.started" }
 *         { "type": "item.started" | "item.updated" | "item.completed", "item": { ... } }
 *         { "type": "turn.completed", "usage": { "input_tokens": n, "output_tokens": n, ... } }
 *         { "type": "turn.failed", "error": { "message": "..." } }
 *         { "type": "error", "message": "..." }        // unrecoverable stream error
 *
 *     The ONLY terminal events are `turn.completed`, `turn.failed` and the
 *     unrecoverable `error`. An assistant answer arrives as an item with
 *     `item.type === "agent_message"` and `item.text`. Because the vocabulary is
 *     open-ended upstream, an unknown `type` is ignored rather than fatal.
 *
 *   - A PROMPT is delivered on STDIN behind the `-` positional and never placed in
 *     argv. A prompt is user content; `ps`, Task Manager and a crash dump must
 *     never be able to read it back.
 *
 *   - Credentials are Codex's own business: it reads `OPENAI_API_KEY` /
 *     `CODEX_API_KEY` (or `codex login` state) from its environment. This module
 *     therefore passes the environment through and puts NOTHING credential-like
 *     into argv, into a returned object, or into any log line.
 *
 * A run is bounded by `runTimeoutMs`, the read is bounded and cancellable, and the
 * outcome comes from the parsed event stream — never from the exit code alone. An
 * exit code of 0 with no terminal event is a failure, and a lost child is
 * `abandoned`, not success.
 */

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

// ── Process seam ──────────────────────────────────────────────────────────────
//
// The transport spawns through this narrow interface so a test can hand it a
// scripted child. It is deliberately NOT `ChildProcess`: only these members are
// ever used, so a fake that implements them is a faithful stand-in.

export interface CodexReadable {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
}

export interface CodexWritable {
  write(chunk: string): unknown;
  end(): unknown;
}

export interface CodexChildProcess {
  readonly pid?: number | undefined;
  readonly stdout: CodexReadable | null;
  readonly stderr: CodexReadable | null;
  readonly stdin: CodexWritable | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "close", listener: (code: number | null, signal: string | null) => void): unknown;
}

export type CodexStdio = readonly ("pipe" | "ignore" | "inherit")[];

export interface CodexSpawnOptions {
  cwd?: string | undefined;
  env: NodeJS.ProcessEnv;
  stdio: CodexStdio;
  windowsHide: boolean;
  shell: false;
}

export type CodexSpawnFn = (
  command: string,
  args: readonly string[],
  options: CodexSpawnOptions,
) => CodexChildProcess;

const defaultSpawn: CodexSpawnFn = (command, args, options) =>
  spawn(command, [...args], options as unknown as Parameters<typeof spawn>[2]) as unknown as CodexChildProcess;

// ── argv ──────────────────────────────────────────────────────────────────────

/**
 * Flags that select a run, kept in one place so the argv is auditable and a test
 * can assert exactly what the child was handed. No prompt, no credential.
 */
export interface CodexExecConfig {
  /** Working root for the agent (`--cd`). */
  cwd?: string | undefined;
  /** Model override (`--model`). */
  model?: string | undefined;
  /** Sandbox policy (`--sandbox`), e.g. `read-only` | `workspace-write`. */
  sandbox?: string | undefined;
  /**
   * Allow running outside a Git repository (`--skip-git-repo-check`). Default
   * true: KAI's authorized workspace is often not a repo, and Codex refuses to
   * start in one without this flag.
   */
  skipGitRepoCheck?: boolean | undefined;
  /** Extra flags appended verbatim, for a caller that knows what it is doing. */
  extraArgs?: readonly string[] | undefined;
}

/** The exact argv for one `codex exec`. The prompt is NOT here — it goes on stdin. */
export function codexExecArgs(config: CodexExecConfig = {}): string[] {
  const args = ["exec", "--json"];
  if (config.skipGitRepoCheck !== false) args.push("--skip-git-repo-check");
  if (config.cwd !== undefined && config.cwd.length > 0) args.push("--cd", config.cwd);
  if (config.model !== undefined && config.model.length > 0) args.push("--model", config.model);
  if (config.sandbox !== undefined && config.sandbox.length > 0) args.push("--sandbox", config.sandbox);
  if (config.extraArgs !== undefined) args.push(...config.extraArgs);
  // The trailing `-` means "read the instructions from stdin" (cli.rs).
  args.push("-");
  return args;
}

// ── Outcomes ──────────────────────────────────────────────────────────────────

export interface CodexUsage {
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * What one run actually did. `exit` means the process ended without a terminal
 * event — the caller decides what a 0 there is worth (nothing good).
 */
export type CodexOutcome =
  | { kind: "completed"; threadId?: string; output?: string; usage?: CodexUsage }
  | { kind: "failed"; message: string; detail?: string }
  | { kind: "malformed"; message: string; detail?: string }
  | { kind: "timeout"; message: string; detail?: string }
  | { kind: "cancelled"; message: string }
  | { kind: "abandoned"; message: string; detail?: string }
  | { kind: "exit"; code: number | null; message: string; detail?: string };

export interface CodexRunHandle {
  /** The exact argv the child was spawned with. Never carries the prompt or a credential. */
  readonly args: readonly string[];
  /** Resolves exactly once: on a terminal event, on exit, on timeout, or on cancel. */
  readonly result: Promise<CodexOutcome>;
  /** Kills the child and resolves the run as `cancelled`. Idempotent. */
  cancel(reason?: string): void;
}

export interface CodexProbe {
  available: boolean;
  latencyMs: number;
  /** First line of `codex --version`, verbatim, when the CLI answered. */
  version?: string;
  detail?: string;
}

export interface CodexTransport {
  /** The executable the transport spawns. Part of the health `endpoint`. */
  readonly command: string;
  /** `codex --version`. Never throws: an unavailable CLI is a value, not an exception. */
  probe(): Promise<CodexProbe>;
  /** Start one `codex exec --json` turn. Synchronous: the handle is live on return. */
  run(prompt: string, options?: { timeoutMs?: number }): CodexRunHandle;
}

export interface CodexTransportOptions extends CodexExecConfig {
  /** Executable to spawn. Default `codex`. */
  command?: string | undefined;
  /** Environment for the child. Merged over `process.env`; the ONE legitimate channel for credentials. */
  env?: NodeJS.ProcessEnv | undefined;
  /** Injected for tests; production spawns a real process. */
  spawnImpl?: CodexSpawnFn | undefined;
  /** Budget for `codex --version`. */
  probeTimeoutMs?: number | undefined;
  /** Budget for one turn before it is killed and reported `timed_out`. */
  runTimeoutMs?: number | undefined;
  /** Cap on parsed event bytes before the stream is considered runaway. */
  maxOutputBytes?: number | undefined;
  now?: (() => number) | undefined;
}

// ── Local readers ─────────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function firstLine(text: string): string | null {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length > 0) return line;
  }
  return null;
}

/** A missing binary is not a crash; it is a precise, user-facing reason. */
function describeSpawnError(error: Error): string {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return "codex is not installed or not on PATH";
  if (code === "EACCES") return "codex is not executable";
  return code === undefined ? `${error.name}: ${error.message}` : `${error.name} (${code}): ${error.message}`;
}

function usageOf(value: unknown): CodexUsage | undefined {
  const record = asRecord(value);
  const input = record["input_tokens"];
  const output = record["output_tokens"];
  const usage: CodexUsage = {};
  if (typeof input === "number") usage.inputTokens = input;
  if (typeof output === "number") usage.outputTokens = output;
  return usage.inputTokens === undefined && usage.outputTokens === undefined ? undefined : usage;
}

/** Split a byte stream into lines without losing the tail, or corrupting a multi-byte char. */
function makeFramer(onLine: (line: string) => void): { feed: (chunk: Buffer | string) => void; flush: () => void } {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  return {
    feed(chunk: Buffer | string): void {
      buffer += decoder.write(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        onLine(line);
        index = buffer.indexOf("\n");
      }
    },
    flush(): void {
      buffer += decoder.end();
      const rest = buffer;
      buffer = "";
      if (rest.trim().length > 0) onLine(rest);
    },
  };
}

// ── Transport ─────────────────────────────────────────────────────────────────

export function createCodexTransport(options: CodexTransportOptions = {}): CodexTransport {
  const command = options.command ?? "codex";
  const spawnImpl = options.spawnImpl ?? defaultSpawn;
  const probeTimeoutMs = options.probeTimeoutMs ?? 5_000;
  const runTimeoutMs = options.runTimeoutMs ?? 15 * 60_000;
  const maxOutputBytes = options.maxOutputBytes ?? 8 * 1024 * 1024;
  const now = options.now ?? (() => Date.now());

  const config: CodexExecConfig = {
    cwd: options.cwd,
    model: options.model,
    sandbox: options.sandbox,
    skipGitRepoCheck: options.skipGitRepoCheck,
    extraArgs: options.extraArgs,
  };

  // Credentials live here and ONLY here: the child's environment.
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...(options.env ?? {}) };

  const spawnOptions = (stdio: CodexStdio): CodexSpawnOptions => ({
    ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
    env: childEnv,
    stdio,
    windowsHide: true,
    shell: false,
  });

  return {
    command,

    probe(): Promise<CodexProbe> {
      const started = now();
      return new Promise<CodexProbe>((resolve) => {
        let child: CodexChildProcess;
        try {
          child = spawnImpl(command, ["--version"], spawnOptions(["ignore", "pipe", "pipe"]));
        } catch (cause) {
          resolve({
            available: false,
            latencyMs: Math.max(0, now() - started),
            detail: `codex could not be spawned: ${cause instanceof Error ? cause.message : String(cause)}`,
          });
          return;
        }

        let stdout = "";
        let stderr = "";
        let settled = false;
        const finish = (probe: CodexProbe): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(probe);
        };
        const kill = (): void => {
          try {
            child.kill("SIGTERM");
          } catch {
            /* already gone */
          }
        };
        const timer = setTimeout(() => {
          kill();
          finish({
            available: false,
            latencyMs: Math.max(0, now() - started),
            detail: `codex --version did not answer within ${probeTimeoutMs}ms`,
          });
        }, probeTimeoutMs);

        child.stdout?.on("data", (chunk) => {
          stdout += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        });
        child.stderr?.on("data", (chunk) => {
          stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        });
        child.on("error", (error) => {
          finish({
            available: false,
            latencyMs: Math.max(0, now() - started),
            detail: describeSpawnError(error),
          });
        });
        child.on("close", (code) => {
          const latencyMs = Math.max(0, now() - started);
          if (code !== 0) {
            const reason = firstLine(stderr);
            finish({
              available: false,
              latencyMs,
              detail: `codex --version exited with code ${code ?? "null"}${reason === null ? "" : `: ${reason}`}`,
            });
            return;
          }
          const version = firstLine(stdout);
          const probe: CodexProbe = { available: true, latencyMs };
          if (version !== null) probe.version = version;
          finish(probe);
        });
      });
    },

    run(prompt: string, runOptions: { timeoutMs?: number } = {}): CodexRunHandle {
      const timeoutMs = runOptions.timeoutMs ?? runTimeoutMs;
      const args = codexExecArgs(config);

      let child: CodexChildProcess;
      try {
        child = spawnImpl(command, args, spawnOptions(["pipe", "pipe", "pipe"]));
      } catch (cause) {
        return {
          args,
          result: Promise.resolve({
            kind: "abandoned",
            message: `could not start codex`,
            detail: cause instanceof Error ? cause.message : String(cause),
          }),
          cancel: () => {},
        };
      }

      let settled = false;
      let cancelled = false;
      let timedOut = false;
      let threadId: string | undefined;
      let assistantText: string | null = null;
      let usage: CodexUsage | undefined;
      let stderrText = "";
      let bytes = 0;
      const malformed: string[] = [];

      let resolveResult!: (outcome: CodexOutcome) => void;
      const result = new Promise<CodexOutcome>((resolve) => {
        resolveResult = resolve;
      });

      const kill = (): void => {
        try {
          child.kill("SIGTERM");
        } catch {
          /* already gone */
        }
      };

      const settle = (outcome: CodexOutcome): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveResult(outcome);
        // A terminal event ends the turn; do not leave a process behind.
        kill();
      };

      const timer = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        kill();
        const outcome: CodexOutcome = { kind: "timeout", message: `codex did not finish within ${timeoutMs}ms` };
        const tail = firstLine(stderrText);
        if (tail !== null) outcome.detail = tail;
        settle(outcome);
      }, timeoutMs);

      const framer = makeFramer((line) => {
        const trimmed = line.trim();
        if (trimmed.length === 0) return;
        bytes += trimmed.length;
        if (bytes > maxOutputBytes) {
          kill();
          settle({
            kind: "abandoned",
            message: `codex emitted more than ${maxOutputBytes} bytes of events; the child was killed`,
          });
          return;
        }

        let event: unknown;
        try {
          event = JSON.parse(trimmed) as unknown;
        } catch {
          if (malformed.length < 20) malformed.push(trimmed.slice(0, 200));
          return;
        }
        if (typeof event !== "object" || event === null || Array.isArray(event)) {
          if (malformed.length < 20) malformed.push(trimmed.slice(0, 200));
          return;
        }

        const record = event as Record<string, unknown>;
        switch (asString(record["type"])) {
          case "thread.started": {
            const id = asString(record["thread_id"]);
            if (id !== null) threadId = id;
            return;
          }
          case "turn.started":
            return;
          case "turn.completed": {
            usage = usageOf(record["usage"]);
            const outcome: CodexOutcome = { kind: "completed" };
            if (threadId !== undefined) outcome.threadId = threadId;
            if (assistantText !== null) outcome.output = assistantText;
            if (usage !== undefined) outcome.usage = usage;
            settle(outcome);
            return;
          }
          case "turn.failed": {
            const failure = asRecord(record["error"]);
            const message = asString(failure["message"]) ?? "codex reported a failed turn";
            settle({ kind: "failed", message });
            return;
          }
          case "error": {
            const message = asString(record["message"]) ?? "codex emitted an unrecoverable stream error";
            const tail = firstLine(stderrText);
            const outcome: CodexOutcome = { kind: "failed", message };
            if (tail !== null) outcome.detail = tail;
            settle(outcome);
            return;
          }
          case "item.started":
          case "item.updated":
          case "item.completed": {
            const item = asRecord(record["item"]);
            if (asString(item["type"]) === "agent_message") {
              const text = asString(item["text"]);
              if (text !== null) assistantText = text;
            }
            return;
          }
          default:
            // Forward-compatible: an event this version does not know is not an error.
            return;
        }
      });

      child.stdout?.on("data", (chunk) => framer.feed(chunk));
      child.stderr?.on("data", (chunk) => {
        stderrText += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        if (stderrText.length > 8_000) stderrText = stderrText.slice(-8_000);
      });
      child.on("error", (error) => {
        // The child never really ran (ENOENT etc). Nothing was accomplished: abandoned.
        settle({ kind: "abandoned", message: "lost the codex child", detail: describeSpawnError(error) });
      });
      child.on("close", (code, signal) => {
        // Parse whatever the last, newline-less line held before deciding.
        framer.flush();
        if (settled) return;
        if (cancelled) {
          settle({ kind: "cancelled", message: "the task was cancelled" });
          return;
        }
        if (timedOut) {
          settle({ kind: "timeout", message: `codex did not finish within ${timeoutMs}ms` });
          return;
        }
        const tail = firstLine(stderrText);
        if (code !== 0 && code !== null) {
          const outcome: CodexOutcome = {
            kind: "exit",
            code,
            message: `codex exited with code ${code}${signal === null ? "" : ` (signal ${signal})`}`,
          };
          if (tail !== null) outcome.detail = tail;
          settle(outcome);
          return;
        }
        if (malformed.length > 0) {
          settle({
            kind: "malformed",
            message: `codex emitted ${malformed.length} malformed JSONL line(s) and no terminal event`,
            detail: malformed[0],
          });
          return;
        }
        // Exit 0 with no terminal event is NOT success: the turn never reported one.
        const outcome: CodexOutcome = {
          kind: "exit",
          code,
          message: "codex exited without a terminal event",
        };
        if (tail !== null) outcome.detail = tail;
        settle(outcome);
      });

      // The prompt travels on stdin, never on the command line.
      try {
        const stdin = child.stdin;
        if (stdin !== null) {
          stdin.write(prompt.endsWith("\n") ? prompt : `${prompt}\n`);
          stdin.end();
        }
      } catch {
        // The child may already have exited; the close/error path decides the outcome.
      }

      return {
        args,
        result,
        cancel(reason = "the task was cancelled"): void {
          if (settled) return;
          cancelled = true;
          kill();
          settle({ kind: "cancelled", message: reason });
        },
      };
    },
  };
}
