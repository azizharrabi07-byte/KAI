// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The MCP stdio bridge seam.
 *
 * MCP's stdio transport is one JSON-RPC frame per line. This seam sits between
 * the agent (KAI) and an MCP server process and is BYTE-TRANSPARENT except for
 * three deliberate, named exceptions:
 *
 *   1. `ping` is answered locally. Some bundled MCP servers do not implement it
 *      and would answer `-32601`, wedging a handshake. Answering near-side keeps
 *      the session alive without reaching a driver that never wanted the call.
 *   2. A `tools/list` response is rewritten to provider-safe schemas (see
 *      tool-schema.ts) so a strict provider does not reject the whole turn.
 *   3. A KAI policy hook may refuse a `tools/call` near-side. This is the seam
 *      where "every MCP tool passes the same boundary as a built-in" is
 *      enforced at the transport: a call KAI will not authorise is answered with
 *      an error result and never forwarded to the server. NOTE this differs from
 *      upstream's gate, which asks "who is driving the machine"; KAI's hook asks
 *      "has this call been through KAI's policy boundary", which is a risk
 *      question, not a control question.
 *
 * ── Line granularity is a correctness property ───────────────────────────────
 * A refusal or a rewrite must never land inside a half-written frame, or it
 * would corrupt a legitimate response. So every byte crosses this seam through
 * `createLineSplitter`, which emits only complete newline-terminated lines (and
 * holds a trailing partial one until more bytes or `flush()` arrive). Nothing
 * that inspects or injects bytes is allowed to see a chunk boundary.
 *
 * ── Byte transparency ────────────────────────────────────────────────────────
 * Forwarded lines are forwarded VERBATIM — the original string, not
 * `JSON.stringify(JSON.parse(line))`, which would silently re-format a JSON
 * frame's whitespace and key order. Only frames this seam deliberately produces
 * or rewrites differ.
 */

import { StringDecoder } from "node:string_decoder";
import { createToolListNormalizer, type ToolListNormalizer } from "./tool-schema.ts";

const ENCODER = "utf8";

/**
 * Collect a byte stream into complete newline-terminated lines.
 *
 * The StringDecoder is what makes this safe for UTF-8: a multi-byte character
 * split across two chunks is buffered, not mangled, and `flush()` drains the
 * decoder's tail. Without it a chunk boundary inside "café" would emit a broken
 * line that then failed to parse as JSON.
 */
export function createLineSplitter(onLine: (line: string) => void): {
  push: (chunk: Buffer | string) => void;
  flush: () => void;
} {
  let pending = "";
  const decoder = new StringDecoder(ENCODER);
  return {
    push(chunk) {
      pending += typeof chunk === "string" ? chunk : decoder.write(chunk);
      let newline: number;
      while ((newline = pending.indexOf("\n")) !== -1) {
        // A trailing `\r` (CRLF from a Windows server) is not part of the frame
        // content; strip it so JSON.parse sees clean text.
        let line = pending.slice(0, newline);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        pending = pending.slice(newline + 1);
        onLine(line);
      }
    },
    flush() {
      pending += decoder.end();
      if (pending.length > 0) {
        let line = pending;
        // A final line without a newline is still a complete frame at EOF.
        if (line.endsWith("\r")) line = line.slice(0, -1);
        onLine(line);
      }
      pending = "";
    },
  };
}

/** One near-side answer/refusal, formatted as a JSON-RPC 2.0 result line. */
function resultLine(id: unknown, text: string, isError: boolean): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: id ?? null,
    ...(isError
      ? { result: { content: [{ type: "text", text }], isError: true } }
      : { result: {} }),
  });
}

export interface McpBridgeOptions {
  /** Where a near-side response goes: the agent's stdout. */
  answer(line: string): void;
  /** Where a forwarded line goes: the server's stdin. A VERBATIM line. */
  forward(line: string): void;
  /**
   * Optional KAI policy hook, called for each agent → server `tools/call`.
   * Return false to refuse. The hook is awaited, so a decision may be async;
   * frames are handled on a serialized queue, so an await here never lets frame
   * N+1 overtake frame N.
   */
  mayCall?(tool: string, line: string): Promise<boolean>;
  /** Optional reason text attached to a refusal. */
  refusalReason?(): string | undefined;
}

/**
 * The near-side frame filter for the agent → server direction.
 *
 * Returns a function that takes one complete line and returns a promise that
 * settles when the line has been either forwarded or answered. The promise is
 * the queue: a caller can `await` it, and the next line naturally waits behind.
 */
export function createBridgeInterceptor(
  options: McpBridgeOptions,
): (line: string) => Promise<void> {
  let queue: Promise<void> = Promise.resolve();
  return (line: string) => {
    queue = queue.then(async () => {
      let frame: unknown;
      try {
        frame = JSON.parse(line);
      } catch {
        // Not JSON the bridge understands. It is still the agent's frame to
        // send, so forward it verbatim rather than stand in its way.
        options.forward(line);
        return;
      }
      if (!isFrame(frame)) {
        options.forward(line);
        return;
      }

      // Exception 1: `ping` answered near-side. A notification (no id) needs no
      // answer and is simply consumed.
      if (frame.method === "ping") {
        if (frame.id !== undefined) options.answer(resultLine(frame.id, "", false));
        return;
      }

      // Exception 3: a tools/call the policy hook will not authorise.
      if (frame.method === "tools/call" && options.mayCall !== undefined) {
        const params = isFrame(frame.params) ? frame.params : undefined;
        const tool = params !== undefined && typeof params.name === "string" ? params.name : "unknown";
        const allowed = await options.mayCall(tool, line).catch(() => false);
        if (!allowed) {
          const reason = options.refusalReason?.() ?? `MCP tool "${tool}" was refused by KAI policy`;
          options.answer(resultLine(frame.id, reason, true));
          return;
        }
      }

      // Everything else (initialize, tools/list, notifications, unknown
      // methods) is routed through untouched.
      options.forward(line);
    });
    return queue;
  };
}

function isFrame(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// ── Process wiring ───────────────────────────────────────────────────────────

export interface RunMcpBridgeOptions extends McpBridgeOptions {
  /** The server's stdout, as complete lines are read from it. */
  serverStdout: NodeJS.ReadableStream;
  /** Optional normalizer for the outbound (server → agent) direction. */
  toolLists?: ToolListNormalizer;
}

/**
 * Wire the seam onto concrete streams. Kept separate from
 * `createBridgeInterceptor` so the decision logic is testable with strings and
 * this only owns the plumbing. Line granularity is applied to BOTH directions:
 * inbound lines are inspected one at a time, and outbound lines are re-emitted
 * one at a time so an injected refusal can never appear mid-frame.
 */
export function runMcpBridge(options: RunMcpBridgeOptions): { stop(): void } {
  const toolLists = options.toolLists ?? createToolListNormalizer();
  const interceptor = createBridgeInterceptor(options);

  const inbound = createLineSplitter((line) => {
    toolLists.observeRequest(line);
    void interceptor(line);
  });
  const outbound = createLineSplitter((line) => {
    options.answer(toolLists.rewriteResponse(line));
  });

  const onData = (chunk: Buffer) => inbound.push(chunk);
  options.serverStdout.on("data", onData);

  return {
    stop() {
      options.serverStdout.off("data", onData);
      inbound.flush();
      outbound.flush();
    },
  };
}
