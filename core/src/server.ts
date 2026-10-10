// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * KAI Core HTTP surface — the control-plane the KAI desktop app (Tauri) talks to.
 *
 * Binds 127.0.0.1 ONLY. Every response is JSON except GET /events (SSE).
 * Upstream failure -> 502 with a `reason` code; never a stack trace to the client.
 */

import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";

import { HermesClient } from "./agents/hermes.ts";
import { OpenCodeClient, PERMISSION_REPLIES } from "./agents/opencode.ts";
import { AgentError, isAgentError, reasonOf } from "./errors.ts";
import { loadConfig, redactedConfig, type KaiConfig } from "./config.ts";
import { withResolvedHermesKey } from "./agents/hermes-key.ts";

const MAX_BODY_BYTES = 1_000_000;
const HERMES_STATUS_POLL_MS = 15_000;

import type { CoreRuntime } from "./runtime.ts";
import { createCoreRuntime } from "./runtime.ts";
import { loadIdentity, describeIdentity, identitySelfCheck } from "./identity.ts";
import { probeExistingCore, isAddressInUse, owningPidForPort } from "./ownership.ts";
import { createCoreApi, attachEventStream } from "./api/routes.ts";
import { registerSessionRoutes } from "./sessions/routes.ts";
import { registerCommandRoutes } from "./commands/routes.ts";
import { presentWorkerResult, presentWorkerFailure, relayGuardIsLive, FALLBACK_SELF, type WorkerId } from "./chat/relay.ts";
import { brainFailureReply, brainFailureReason } from "./chat/brain.ts";
import { previewToolResult } from "./chat/result-preview.ts";
import { beginTurn, finishTurn } from "./chat/turns.ts";

export interface KaiServerDeps {
  hermes: HermesClient;
  opencode: OpenCodeClient;
  /**
   * The Core control plane. Optional on purpose: the server's own tests drive it
   * with fake upstream clients and no Core, and every pre-existing route keeps
   * working exactly as before when this is absent.
   */
  core?: CoreRuntime;
}

export interface AggregateHealth {
  status: "ok" | "degraded";
  service: string;
  version: string;
  hermes: { reachable: boolean; authorized: boolean; version: string | null; reason: string | null };
  opencode: { reachable: boolean; version: string | null; reason: string | null };
  checked_at: string;
}

/**
 * Whether a settled turn may contribute a durable memory. ALL THREE must hold:
 * the host proved itself (loopback is unauthenticated — an arbitrary local
 * process must not plant user-authority memories), the answer came from KAI's
 * OWN reasoning loop (delegated worker turns belong to the worker), and a
 * conversation exists to attribute it to. Weakening any clause re-opens the
 * exact planting hole the host token closes; a test pins the conjunction.
 */
export function captureAllowed(input: { attested: boolean; isBrainAnswer: boolean; hasSession: boolean }): boolean {
  return input.attested && input.isBrainAnswer && input.hasSession;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return;
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

function sendAgentFailure(res: http.ServerResponse, error: unknown, target: string): void {
  const status = isAgentError(error) && error.kind === "http" && error.status !== undefined &&
      error.status >= 400 && error.status < 500 && error.status !== 404
    ? error.status
    : 502;
  sendJson(res, status === 502 ? 502 : status, {
    error: status === 502 ? "bad_gateway" : "upstream_error",
    target,
    reason: reasonOf(error),
    message: error instanceof Error ? error.message : "unknown upstream failure",
  });
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(buf);
  }
  if (size === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("request body was not valid JSON");
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Constant-time comparison of two equal-length strings. `timingSafeEqual` throws
 * on unequal lengths, so the length is checked first; the comparison itself is
 * constant-time so the token cannot be recovered a byte at a time.
 */
function secretMatches(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided, "utf8"), Buffer.from(expected, "utf8"));
}

/**
 * Body reader for the chat routes: sends the 400 itself and returns null when the
 * request is not usable, so each route does not repeat the same four checks.
 * `text` must be a non-empty string — an empty prompt is a client bug, not a turn.
 */
async function readChatBody(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<Record<string, unknown> | null> {
  let body: Record<string, unknown>;
  try {
    body = asRecord(await readBody(req));
  } catch (error) {
    sendJson(res, 400, { error: "invalid_request", reason: (error as Error).message });
    return null;
  }
  const text = body["text"];
  if (typeof text !== "string" || text.trim().length === 0) {
    sendJson(res, 400, { error: "invalid_request", reason: "invalid_text" });
    return null;
  }
  if (body["session_id"] !== undefined && typeof body["session_id"] !== "string") {
    sendJson(res, 400, { error: "invalid_request", reason: "invalid_session_id" });
    return null;
  }
  return body;
}

export function createKaiServer(config: KaiConfig, deps?: Partial<KaiServerDeps>): http.Server {
  const hermes = deps?.hermes ?? new HermesClient({
    baseUrl: config.hermes.baseUrl,
    apiKey: config.hermes.apiKey,
    timeoutMs: config.hermes.timeoutMs,
    chatTimeoutMs: config.hermes.chatTimeoutMs,
  });
  const opencode = deps?.opencode ?? new OpenCodeClient({
    baseUrl: config.opencode.baseUrl,
    password: config.opencode.password,
    timeoutMs: config.opencode.timeoutMs,
  });

  const core = deps?.core;
  const coreApi = core === undefined ? null : createCoreApi(core);

  /**
   * Inference-dependency telemetry.
   *
   * This is the machine-checkable proof that ordinary KAI chat does not call
   * Hermes. `normalChatCallsToHermes` counts Hermes worker calls made while
   * serving a NORMAL (non-delegated) turn; `delegatedCallsToHermes` counts the
   * optional delegation turns. A correct build answers every normal turn with
   * `normalChatCallsToHermes === 0`, and a delegated turn is the ONLY thing that
   * may raise `delegatedCallsToHermes`.
   */
  const telemetry = {
    startedAt: new Date().toISOString(),
    normalChatTurns: 0,
    delegatedTurns: 0,
    normalChatCallsToHermes: 0,
    delegatedCallsToHermes: 0,
  };

  function noteHermesCall(kind: "normal" | "delegated"): void {
    if (kind === "normal") telemetry.normalChatCallsToHermes += 1;
    else telemetry.delegatedCallsToHermes += 1;
  }

  // The session surface (integration handover #1): register the five session
  // tools on `runtime.tools` and WRAP `coreApi.handle` in place, so the live
  // Core answers `/sessions/search`, `/sessions/:id/{view,transcript}` and the
  // four gated mutations instead of 404. The wrapper is marked, so this call is
  // idempotent; a non-matching request falls through to the original handle
  // untouched. Safe because the request handler below calls `coreApi.handle`
  // BY PROPERTY ACCESS, so the object is the seam.
  if (coreApi !== null && core !== undefined) registerSessionRoutes(coreApi, { runtime: core });
  // The command surface (P2): GET /commands + POST /commands/:id/run, same
  // in-place pattern — real runtime behavior behind every slash command.
  if (coreApi !== null && core !== undefined) registerCommandRoutes(coreApi, { runtime: core });

  /**
   * The shared secret the desktop app holds. Absent unless the app passed it
   * through the environment (`KAI_HOST_TOKEN`), exactly as it passes the Hermes
   * key. A missing token means NO request is host-attested, so the relay's
   * user-authority learning call simply does not run: fail closed, never fail
   * open.
   */
  const hostToken = config.server.hostToken;

  /**
   * True only when the request carries the host token the app holds.
   *
   * `POST /chat` is loopback-only but otherwise unauthenticated, and any local
   * process can reach it. Without this check an arbitrary process could POST a
   * sentence and have it recorded as the USER's own learning — the gate
   * `/learning/propose` relies on, bypassed by a sibling route. The token is the
   * one thing only the app (and the Core it spawned) knows.
   */
  function hostAttested(req: http.IncomingMessage): boolean {
    if (hostToken === undefined || hostToken.length === 0) return false;
    const provided = req.headers["x-kai-host-token"];
    return typeof provided === "string" && provided.length > 0 && secretMatches(provided, hostToken);
  }

  /**
   * KAI's own voice at the relay boundary, read from the ONE identity mechanism
   * (the router's injected soul). With no runtime attached — the server tests —
   * it degrades to the built-in identity line rather than to a worker's name.
   */
  const kaiSelfDescription = (): string =>
    core !== undefined ? core.chat.selfDescription() : FALLBACK_SELF;

  /** KAI's own voiced reply when a worker cannot run a turn. Never an error shape. */
  function workerFailureReply(worker: WorkerId, detail: string): string {
    return presentWorkerFailure({
      worker,
      detail,
      kaiSelf: kaiSelfDescription(),
    });
  }

  /**
   * A user-safe reason for a worker failure: a stable reason code or the error
   * message, never a stack trace. Read once, here, so every failure path says the
   * same kind of thing.
   */
  function failureDetail(error: unknown): string {
    if (isAgentError(error)) return reasonOf(error).replace(/_/g, " ");
    if (error instanceof Error) return error.message;
    const record = asRecord(error);
    if (typeof record["reason"] === "string") return (record["reason"] as string).replace(/_/g, " ");
    return "an unexpected error";
  }

  interface RelayOutcome {
    /** The text KAI speaks. A failure is a KAI-voiced sentence, never empty. */
    reply: string;
    guarded: boolean;
    worker: WorkerId;
    workerSessionId: string | null;
    failed: boolean;
    /** Hermes reports token usage; OpenCode reports an inline error. */
    usage?: unknown;
    infoError?: unknown;
  }

  /**
   * Run ONE worker turn and compose KAI's reply.
   *
   * THE FAILURE GUARANTEE. This never throws for a worker failure — an
   * unreachable worker, a refused session, a timeout, a non-2xx response, a
   * crash or an EMPTY result all come back as a KAI-voiced reply from
   * `presentWorkerFailure`, so `/chat` never answers a turn with a bare 502 that
   * has no `reply` field. That bare-502 shape is exactly what made KAI look
   * silent when a worker was down.
   *
   * The relay boundary is applied on EVERY path: a worker's own
   * self-identification is stripped by `presentWorkerResult` before its text can
   * become KAI's speech, whichever worker ran and however it was reached.
   */
  async function relayWorkerTurn(input: {
    worker: WorkerId;
    turnText: string;
    /** An existing worker conversation id, or null to open a fresh one. */
    workerSessionId: string | null;
    /**
     * Whether this worker turn is an OPTIONAL delegation (the default) or a
     * NORMAL turn that reached a worker — which, for Hermes, must never happen in
     * a correct build and is exactly what the telemetry counts.
     */
    kind?: "normal" | "delegated";
  }): Promise<RelayOutcome> {
    const worker = input.worker;
    const kind = input.kind ?? "delegated";
    let workerSessionId = input.workerSessionId;
    const failed = (detail: string): RelayOutcome => ({
      reply: workerFailureReply(worker, detail),
      guarded: false,
      worker,
      workerSessionId,
      failed: true,
    });

    try {
      if (workerSessionId === null) {
        if (worker === "hermes") noteHermesCall(kind);
        const created =
          worker === "hermes"
            ? await hermes.createSession({ title: `KAI chat ${new Date().toISOString()}` })
            : await opencode.createSession({ title: "KAI chat" });
        if (created.id.length === 0) return failed("it did not open a conversation");
        workerSessionId = created.id;
      }

      if (worker === "hermes") {
        let result: Awaited<ReturnType<typeof hermes.sendChat>>;
        try {
          noteHermesCall(kind);
          result = await hermes.sendChat(workerSessionId, input.turnText);
        } catch (error) {
          // A worker conversation that upstream no longer has — a deleted Hermes
          // session, or a poisoned binding that was never real — answers 404. That
          // is KAI's mapping gap, not a user problem, so KAI repairs it: mint a
          // fresh worker conversation ONCE and retry. The successful turn then
          // re-binds the REAL worker session id (see `settleTurn`), so the mapping
          // self-heals instead of failing forever.
          if (!(isAgentError(error) && error.kind === "http" && error.status === 404)) throw error;
          const recreated =
            worker === "hermes"
              ? await hermes.createSession({ title: `KAI chat ${new Date().toISOString()}` })
              : await opencode.createSession({ title: "KAI chat" });
          if (recreated.id.length === 0) return failed("it did not open a conversation");
          workerSessionId = recreated.id;
          noteHermesCall(kind);
          result = await hermes.sendChat(workerSessionId, input.turnText);
        }
        const raw = (result.message?.content ?? "").trim();
        const sessionId = result.session_id ?? workerSessionId;
        if (raw.length === 0) return failed("it returned an empty result");
        const presented = presentWorkerResult({ worker, raw, kaiSelf: kaiSelfDescription() });
        return {
          reply: presented.reply,
          guarded: presented.guarded,
          worker,
          workerSessionId: sessionId,
          failed: false,
          usage: result.usage ?? null,
        };
      }

      const message = asRecord(await opencode.prompt(workerSessionId, input.turnText));
      const parts = asArray(asRecord(message)["parts"]);
      const raw = parts
        .map((part) => (typeof asRecord(part)["text"] === "string" ? (asRecord(part)["text"] as string) : ""))
        .join("")
        .trim();
      const infoError = asRecord(message["info"])["error"] ?? null;
      if (raw.length === 0) return failed("it returned an empty result");
      const presented = presentWorkerResult({ worker, raw, kaiSelf: kaiSelfDescription() });
      return {
        reply: presented.reply,
        guarded: presented.guarded,
        worker,
        workerSessionId,
        failed: false,
        infoError,
      };
    } catch (error) {
      return failed(failureDetail(error));
    }
  }

  /**
   * The worker conversation a turn continues — resolved-or-created from the KAI
   * session's OWN binding, and NEVER KAI's own session id.
   *
   * KAI's session is the conversation of record; the worker session is an
   * implementation detail bound to it (`agentSessionId`). The defect this closes:
   * a caller passed KAI's OWN session id as `session_id` (the app used to send it,
   * and the field was read as a WORKER id), so it was forwarded to Hermes, which
   * answered 404 for an id it never minted. Making it worse, the failure relay
   * echoed that same id back and the turn's bookkeeping re-bound the KAI id AS
   * the worker session — poisoning the mapping for every later turn.
   *
   * So an id that IS the KAI conversation is never a worker id here: it is
   * ignored, `null` is returned (which makes the relay mint a REAL worker
   * conversation), and the binding is repaired on the first successful turn. A
   * binding that equals the KAI session id is treated as absent for the same
   * reason. The KAI-vs-worker split also keeps an OpenCode turn from ever being
   * handed a Hermes session id (or vice versa).
   */
  function workerSessionIdFor(
    worker: WorkerId,
    body: Record<string, unknown>,
    conversation: { id: string; agentId?: string; worker?: string; agentSessionId?: string } | null,
  ): string | null {
    const kaiSessionId = conversation?.id ?? "";
    const explicit = body["session_id"];
    if (typeof explicit === "string" && explicit.length > 0 && explicit !== kaiSessionId) {
      return explicit;
    }
    if (
      conversation !== null &&
      (conversation.agentId === worker || conversation.worker === worker) &&
      conversation.agentSessionId !== undefined &&
      conversation.agentSessionId.length > 0 &&
      conversation.agentSessionId !== conversation.id
    ) {
      return conversation.agentSessionId;
    }
    return null;
  }

  const allowedOrigins = new Set(config.server.allowedOrigins);

  async function aggregate(): Promise<AggregateHealth> {
    const hermesProbe = await hermes.probe();
    let opencodeHealth: { reachable: boolean; version: string | null; reason: string | null };
    try {
      const health = await opencode.health();
      opencodeHealth = {
        reachable: health.healthy,
        version: health.version,
        reason: health.healthy ? null : "reported_unhealthy",
      };
    } catch (error) {
      opencodeHealth = {
        reachable: false,
        version: null,
        reason: isAgentError(error) ? `upstream_${error.kind}` : "internal_error",
      };
    }
    const ok = hermesProbe.reachable && hermesProbe.authorized && opencodeHealth.reachable;
    return {
      status: ok ? "ok" : "degraded",
      service: "kai-core",
      version: "0.1.0",
      hermes: hermesProbe,
      opencode: opencodeHealth,
      checked_at: new Date().toISOString(),
    };
  }

  /** CORS gate. Returns the headers to attach, or null when the origin is rejected. */
  function cors(origin: string | undefined): Record<string, string> | null {
    if (origin === undefined) return {};
    if (!allowedOrigins.has(origin)) return null;
    return {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": "600",
      vary: "Origin",
    };
  }

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (res.writableEnded) return;
      sendJson(res, 500, {
        error: "internal_error",
        reason: isAgentError(error) ? `upstream_${error.kind}` : "internal_error",
      });
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const origin = req.headers.origin;
    const corsHeaders = cors(typeof origin === "string" ? origin : undefined);
    if (corsHeaders === null) {
      sendJson(res, 403, { error: "forbidden", reason: "origin_not_allowed" });
      return;
    }
    for (const [key, value] of Object.entries(corsHeaders)) res.setHeader(key, value);

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method ?? "GET";

    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      // ---- health / integrations -------------------------------------------
      if ((path === "/health" || path === "/integrations") && method === "GET") {
        sendJson(res, 200, await aggregate());
        return;
      }

      // ---- inference independence (the KAI brain, and the dependency proof) --
      //
      // Reports KAI's OWN inference architecture and the live dependency counters.
      // `normal_chat_calls_to_hermes` must read 0: ordinary chat is KAI's own
      // model call, never a relay. Hermes is listed only as an OPTIONAL worker.
      if (path === "/independence" && method === "GET") {
        const described = core?.brain.describe() ?? null;
        const health = core !== undefined ? await core.model.health() : null;
        const capabilities = core?.model.capabilities() ?? null;
        let hermesProbe: { reachable: boolean; authorized: boolean } | null = null;
        try {
          const probe = await hermes.probe();
          hermesProbe = { reachable: probe.reachable, authorized: probe.authorized };
        } catch {
          hermesProbe = { reachable: false, authorized: false };
        }
        sendJson(res, 200, {
          architecture: "KAI UI -> KAI Core -> KAI ModelProvider -> model -> KAI",
          inference: {
            owner: "kai",
            provider: described?.provider ?? null,
            model: described?.model ?? null,
            configured: described?.configured ?? false,
            reachable: health?.ok ?? false,
            baseUrl: health?.baseUrl ?? null,
            reason: health?.reason ?? null,
            capabilities,
          },
          workers: {
            hermes: { optional: true, role: "worker", ...(hermesProbe ?? { reachable: false, authorized: false }) },
          },
          dependency: {
            normal_chat_turns: telemetry.normalChatTurns,
            delegated_turns: telemetry.delegatedTurns,
            normal_chat_calls_to_hermes: telemetry.normalChatCallsToHermes,
            delegated_calls_to_hermes: telemetry.delegatedCallsToHermes,
          },
        });
        return;
      }

      // ---- Hermes ----------------------------------------------------------
      if (path === "/agents/hermes/sessions" && method === "GET") {
        sendJson(res, 200, { agent: "hermes", data: await hermes.listSessions() });
        return;
      }

      // ---- OpenCode --------------------------------------------------------
      if (path === "/agents/opencode/sessions" && method === "GET") {
        sendJson(res, 200, { agent: "opencode", data: await opencode.listSessions() });
        return;
      }
      if (path === "/agents/opencode/permissions" && method === "GET") {
        sendJson(res, 200, { agent: "opencode", data: await opencode.listPermissions() });
        return;
      }
      if (path === "/agents/opencode/questions" && method === "GET") {
        sendJson(res, 200, { agent: "opencode", data: await opencode.listQuestions() });
        return;
      }

      /**
       * Conversation bookkeeping shared by BOTH chat relays (`/chat` and
       * `/agents/opencode/chat`).
       *
       * A KAI session is durable and switchable; the worker's own conversation id
       * stays `session_id`, so nothing that worked before changes meaning. An
       * explicit `conversation_id` names a KAI session; otherwise the ACTIVE
       * session is the one a person is looking at, so the turn belongs to it.
       */
      function conversationFor(body: Record<string, unknown>): {
        conversation: { id: string; agentId?: string; worker?: string; agentSessionId?: string } | null;
        captureConversationMemory: (userText: string, assistantText: string, attested: boolean) => void;
        settleTurn: (
          reply: string,
          agentId?: string,
          agentSessionId?: string,
          toolCalls?: Array<{
            id: string;
            name: string;
            toolId?: string;
            ok: boolean;
            status: string;
            invocationId?: string;
            arguments: string;
            result?: unknown;
            approvalId?: string;
            startedAt: string;
            completedAt: string;
          }>,
        ) => void;
      } {
        let conversation: { id: string; agentId?: string; worker?: string; agentSessionId?: string } | null = null;
        if (core !== undefined) {
          const requested = typeof body["conversation_id"] === "string" ? (body["conversation_id"] as string) : "";
          conversation =
            requested.length > 0
              ? core.sessions.get(requested)
              : core.sessions.active() ?? core.sessions.ensureActive();
          if (conversation !== null) {
            core.sessions.recordTurn({ sessionId: conversation.id, role: "user", text: String(body["text"] ?? "") });
          }
        }
        // Durable memory from a normal turn — controlled, never blind. See
        // `captureAllowed` below for the exact rule, pinned by test.
        //
        // HOST-ATTESTED, like learning.propose above: this route is loopback
        // but unauthenticated, and an arbitrary local process must not be able
        // to plant user-authority memories. The caller passes its attestation;
        // without it nothing is captured. Capture never breaks the turn.
        const captureConversationMemory = (userText: string, assistantText: string, attested: boolean): void => {
          if (!captureAllowed({ attested, isBrainAnswer: true, hasSession: conversation !== null })) return;
          if (core === undefined || conversation === null) return;
          try {
            core.memoryEngine.captureTurn({ userText, assistantText, sessionId: conversation.id });
          } catch {
            // The turn's record stands without its capture.
          }
        };
        // Record the answer against the conversation it belongs to, and bind the
        // worker conversation to it so a LATER turn continues the same one — which
        // is what makes a session survive a Core restart as one conversation.
        //
        // `toolCalls` (the brain's per-call records) are persisted against the
        // assistant turn, so a reload restores THAT tools were used — name,
        // arguments, result, status and approval state — not just the prose.
        const settleTurn = (
          reply: string,
          agentId?: string,
          agentSessionId?: string,
          toolCalls?: Array<{
            id: string;
            name: string;
            toolId?: string;
            ok: boolean;
            status: string;
            invocationId?: string;
            arguments: string;
            result?: unknown;
            approvalId?: string;
            startedAt: string;
            completedAt: string;
          }>,
        ): void => {
          if (core === undefined || conversation === null) return;
          const recorded = core.sessions.recordTurn({
            sessionId: conversation.id,
            role: "assistant",
            text: reply,
            ...(agentId !== undefined ? { agentId } : {}),
          });
          if (recorded.ok && toolCalls !== undefined && toolCalls.length > 0) {
            core.sessions.recordToolCalls(
              conversation.id,
              recorded.value.id,
              toolCalls.map((call) => ({
                toolCallId: call.id,
                toolName: call.name,
                ...(call.toolId !== undefined ? { toolId: call.toolId } : {}),
                arguments: call.arguments,
                ...(call.invocationId !== undefined ? { invocationId: call.invocationId } : {}),
                status: call.status,
                ...(call.result !== undefined ? { result: call.result } : {}),
                ...(call.approvalId !== undefined ? { approvalId: call.approvalId } : {}),
                startedAt: call.startedAt,
                completedAt: call.completedAt,
              })),
            );
          }
          // Binding the worker conversation to this KAI session is what makes a
          // LATER turn continue the same worker conversation after a restart. It
          // must never write a self-binding: an id equal to the KAI session id is
          // not a worker session, and persisting it is exactly the poison that made
          // every later turn forward KAI's own id to a worker and get a 404 back.
          if (
            agentId !== undefined &&
            agentSessionId !== undefined &&
            agentSessionId.length > 0 &&
            agentSessionId !== conversation.id
          ) {
            core.sessions.bindWorker(conversation.id, agentId, agentSessionId);
            conversation.agentId = agentId;
            conversation.agentSessionId = agentSessionId;
          }
        };
        return { conversation, settleTurn, captureConversationMemory };
      }

      // ---- streaming normal chat (KAI's OWN provider) ------------------------
      //
      // The streaming form of ordinary KAI chat. KAI composes its own system prompt
      // and streams tokens straight from KAI's own ModelProvider — no worker in the
      // path. `dependency.normal_chat_calls_to_hermes` is reported on the terminal
      // frame so a client can assert independence on a streamed turn too.
      if ((path === "/chat/stream" || path === "/agents/kai/chat/stream") && method === "POST") {
        const body = await readChatBody(req, res);
        if (body === null) return;
        const text = body["text"] as string;
        const { conversation, settleTurn, captureConversationMemory: captureStreamed } = conversationFor(body);

        if (core === undefined || core.brain === undefined || !core.brain.available()) {
          sendJson(res, 503, { error: "brain_unavailable", reason: "no_kai_model_provider" });
          return;
        }
        const described = core.brain.describe();
        // An `@` turn never streams blindly: invocations route through the
        // router (agent runs, skill loads, refusals), and the decided text is
        // delivered as frames. Streaming a model reply for an agent invocation
        // would silently drop the delegation.
        if (/^@[\w-]/.test(text.trimStart()) && core.chat !== undefined) {
          const answer = await core.chat.answer(
            text,
            ...(conversation?.id !== undefined ? [{ sessionId: conversation.id } as { sessionId: string }] : []),
          );
          res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });
          for (const slice of answer.text.match(/.{1,500}/gs) ?? []) {
            res.write(`data: ${JSON.stringify({ delta: slice })}\n\n`);
          }
          res.write(
            `data: ${JSON.stringify({
              done: true,
              provider: described.provider,
              model: described.model,
              finish_reason: "stop",
              usage: null,
              conversation_id: conversation?.id ?? null,
              tool_iterations: answer.toolIterations ?? 0,
              tool_budget_exhausted: answer.toolBudgetExhausted ?? false,
              invocation: answer.invocation ?? null,
              agent_run: answer.agentRun ?? null,
              dependency: { normal_chat_calls_to_hermes: telemetry.normalChatCallsToHermes },
            })}\n\n`,
          );
          telemetry.normalChatTurns += 1;
          settleTurn(answer.text, undefined, undefined, answer.toolCalls);
          if (answer.brain !== undefined) captureStreamed(text, answer.text, hostAttested(req));
          res.end();
          return;
        }
        let system = core.chat.selfDescription();
        try {
          system = (
            await core.composeTurnPrompt(
              text,
              ...(conversation?.id !== undefined ? [{ sessionId: conversation.id } as { sessionId: string }] : []),
            )
          ).text;
        } catch {
          // degrade to KAI's soul line — never to a worker
        }

        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        let full = "";
        // The task lifecycle wraps the streamed turn exactly like a router
        // turn: "continue" resumes the open task, and completion is verified
        // against the original objective — never assumed from tool activity.
        const begun = beginTurn(core?.tasks, conversation?.id, text);
        const streamText = begun.effectiveText;
        // Pair each tool_start with its terminal event to rebuild the turn's
        // tool records (arguments from the start, outcome from the terminal).
        const pairStreamedCalls = (): Array<{
          id: string;
          name: string;
          toolId?: string;
          ok: boolean;
          status: string;
          invocationId?: string;
          arguments: string;
          result?: unknown;
          approvalId?: string;
          startedAt: string;
          completedAt: string;
        }> => {
          const calls: Array<{
            id: string;
            name: string;
            toolId?: string;
            ok: boolean;
            status: string;
            invocationId?: string;
            arguments: string;
            result?: unknown;
            approvalId?: string;
            startedAt: string;
            completedAt: string;
          }> = [];
          const starts = new Map<string, (typeof streamedToolEvents)[number]>();
          for (const event of streamedToolEvents) {
            if (event.type === "tool_start") {
              starts.set(event.toolCallId, event);
              continue;
            }
            const start = starts.get(event.toolCallId);
            calls.push({
              id: event.toolCallId,
              name: event.toolName,
              ...(event.toolId !== undefined ? { toolId: event.toolId } : {}),
              ok: event.type === "tool_done",
              status: event.status ?? "UNKNOWN",
              ...(event.invocationId.length > 0 ? { invocationId: event.invocationId } : {}),
              arguments: event.arguments ?? start?.arguments ?? "",
              ...(event.result !== undefined ? { result: event.result } : {}),
              ...(event.approvalId !== undefined ? { approvalId: event.approvalId } : {}),
              startedAt: start?.startedAt ?? event.startedAt,
              completedAt: event.completedAt ?? event.startedAt,
            });
          }
          return calls;
        };
        // The streamed turn's tool history, collected from the REAL executions
        // via the per-turn listener and persisted on settle — a streamed turn
        // that used tools reloads with its tool record intact, exactly like a
        // non-streamed one.
        const streamedToolEvents: Array<{
          type: string;
          toolCallId: string;
          toolName: string;
          toolId?: string;
          invocationId: string;
          arguments?: string;
          status?: string;
          startedAt: string;
          completedAt?: string;
          error?: { code: string; message: string };
          approvalId?: string;
          result?: unknown;
        }> = [];
        // One run, one cancellation identity: when the client goes away
        // (Stop aborts the fetch; a dead tab closes the socket), the RUN is
        // aborted too — tools in flight are killed through the registry, not
        // left running behind a closed stream. Ending the SSE subscription is
        // otherwise NOT proof the work stopped.
        //
        // Both ends are watched: `req` close fires when the request stream
        // dies, `res` close fires when the response socket dies before
        // res.end() ran. Request-only watching misses aborts whose request
        // body was already fully consumed (the usual POST case) — the run
        // then finishes into the void instead of stopping.
        const runController = new AbortController();
        const onClientGone = (): void => {
          runController.abort();
        };
        req.on("close", onClientGone);
        res.on("close", onClientGone);
        try {
          for await (const chunk of core.brain.stream({
            text: streamText,
            system,
            ...(begun.objective !== streamText ? { objective: begun.objective } : {}),
            signal: runController.signal,
            onToolEvent: (event) => {
              streamedToolEvents.push({ ...event });
            },
          })) {
            if (chunk.done) {
              const exhausted = chunk.toolBudgetExhausted ?? false;
              const synthesized = chunk.synthesized ?? false;
              // A cancelled run settles as cancelled: the task lifecycle must
              // record ABORTED, never verify a half-turn as complete.
              const cancelled = chunk.cancelled === true || runController.signal.aborted;
              const pending = exhausted
                ? (chunk.toolCalls ?? []).map((call) => call.name).filter((name) => name.length > 0)
                : [];
              const calls = pairStreamedCalls();
              // Verify BEFORE closing the stream: when the turn pauses, the
              // pause message streams as the closing text (so the user READS
              // it) and settles as the reply — never a silent stop after the
              // last preamble.
              const finished = finishTurn(core?.tasks, begun, {
                text: full,
                ...(calls.length > 0
                  ? {
                    toolCalls: calls.map((call) => ({
                      id: call.id,
                      name: call.name,
                      ...(call.toolId !== undefined ? { toolId: call.toolId } : {}),
                      ok: call.ok,
                      status: call.status,
                      ...(call.invocationId !== undefined ? { invocationId: call.invocationId } : {}),
                      arguments: call.arguments ?? "",
                      ...(call.result !== undefined ? { result: call.result } : {}),
                      ...(call.approvalId !== undefined ? { approvalId: call.approvalId } : {}),
                      startedAt: call.startedAt,
                      completedAt: call.completedAt,
                    })),
                  }
                  : {}),
                toolIterations: chunk.toolIterations ?? 0,
                toolBudgetExhausted: exhausted,
                synthesized,
                ...(pending.length > 0 ? { pendingTools: pending } : {}),
                ...(cancelled ? { cancelled: true as const } : {}),
              });
              if (finished.state === "PAUSED" && finished.replyText.length > 0) {
                full += (full.length > 0 ? "\n\n" : "") + finished.replyText;
                res.write(`data: ${JSON.stringify({ delta: `\n\n${finished.replyText}` })}\n\n`);
              }
              res.write(
                `data: ${JSON.stringify({
                  done: true,
                  provider: described.provider,
                  model: described.model,
                  finish_reason: chunk.finishReason ?? null,
                  usage: chunk.usage ?? null,
                  conversation_id: conversation?.id ?? null,
                  tool_iterations: chunk.toolIterations ?? 0,
                  tool_budget_exhausted: exhausted,
                  ...(synthesized ? { synthesized: true } : {}),
                  ...(cancelled ? { cancelled: true as const } : {}),
                  task_state: finished.state,
                  dependency: { normal_chat_calls_to_hermes: telemetry.normalChatCallsToHermes },
                })}\n\n`,
              );
              break;
            }
            // A tool-lifecycle event chunk carries the REAL execution outcome.
            // The raw value stays server-side; the wire gets a bounded,
            // secret-redacted preview (chat/result-preview.ts) correlated by
            // the real invocationId — the UI renders THIS, it never invents it.
            if (chunk.toolEvent !== undefined) {
              const { result, ...streamable } = chunk.toolEvent;
              const preview = previewToolResult(result);
              res.write(
                `data: ${JSON.stringify({ tool_event: { ...streamable, ...preview } })}\n\n`,
              );
              continue;
            }
            full += chunk.delta;
            res.write(`data: ${JSON.stringify({ delta: chunk.delta })}\n\n`);
          }
        } catch (error) {
          // A run the user stopped is a cancellation, not a brain failure:
          // the task already settled CANCELLED inside the loop (or the socket
          // is gone and these writes are no-ops) — never report it BLOCKED.
          if (runController.signal.aborted) {
            try {
              res.write(`data: ${JSON.stringify({ done: true, cancelled: true, task_state: "CANCELLED" })}\n\n`);
            } catch {
              /* client already gone */
            }
            try {
              res.end();
            } catch {
              /* client already gone */
            }
            return;
          }
          if (core?.tasks !== undefined && begun.taskId !== null) core.tasks.move(begun.taskId, "BLOCKED");
          const reply = brainFailureReply(brainFailureReason(error));
          res.write(
            `data: ${JSON.stringify({
              done: true,
              error: "brain_unavailable",
              reason: brainFailureReason(error),
              reply,
              conversation_id: conversation?.id ?? null,
              task_state: "BLOCKED",
            })}\n\n`,
          );
          res.end();
          return;
        } finally {
          req.off("close", onClientGone);
          if (typeof res.off === "function") res.off("close", onClientGone);
        }
        telemetry.normalChatTurns += 1;
        // The turn was verified inside the loop (before `done`), so `full`
        // already carries the pause message when the turn paused — settle
        // exactly what the user read.
        const streamedToolCalls = pairStreamedCalls();
        settleTurn(full, undefined, undefined, streamedToolCalls);
        captureStreamed(text, full, hostAttested(req));
        res.end();
        return;
      }

      // ---- chat relay -------------------------------------------------------
      // The island's chat goes through here when KAI Core is running, so a turn
      // is KAI UI -> KAI Core -> agent server -> model. Hermes holds the
      // conversation itself, so the caller only has to keep `session_id`.
      if ((path === "/chat" || path === "/agents/hermes/chat") && method === "POST") {
        let body = await readChatBody(req, res);
        if (body === null) return;
        const text = body["text"] as string;

        const { conversation, settleTurn, captureConversationMemory: captureNormal } = conversationFor(body);

        // THE HOST ASSIGNS PROVENANCE — but only when the HOST is actually
        // calling. This text came from the user's own message in the app, so the
        // app's request is the one place in KAI that may claim user authority for
        // learning; the HTTP learning route denies it by default (and refuses an
        // explicit `source: "user"`). An arbitrary local process POSTing to this
        // unauthenticated route must NOT be able to borrow that authority, so the
        // call runs only for a request carrying the shared token the app holds.
        // Fail closed: with no token configured, nothing is learned here.
        const attested = hostAttested(req);
        if (core !== undefined && attested) {
          void core.tools
            .invoke("learning.propose", {
              kind: "explicit_instruction",
              source: "user",
              text,
              userText: text,
            })
            .catch(() => undefined);
        }

        // THE ROUTER DECIDES THE TURN, EVERY TURN.
        //
        // Before this, only a RECOGNISED intent was answered by KAI; an unknown
        // utterance bypassed the router entirely and became a raw pipe to Hermes.
        // Two defects fell out of that: `answerUnknown` (KAI's honest "no rule for
        // that" answer) was unreachable dead code, and an explicit "don't use
        // Hermes" was never consulted, so the turn went to Hermes anyway. Now every
        // turn is classified and answered by KAI first:
        //
        //   * `delegateTo` set — KAI ACTUALLY performs the delegation, through the
        //     same relay a worker turn always uses, honouring `avoid`. It does not
        //     merely promise it.
        //   * otherwise — KAI answers in its own voice: a state answer, its
        //     identity, or the unknown-turn fallback when no worker can take it.
        if (core !== undefined) {
          // `memory.remember` mutates the legacy memory store with user authority,
          // and `core.chat.answer()` PERFORMS that write — so the guard MUST run
          // before `answer()`, via `classify()`. Checking after the fact would be
          // too late: the write would already have happened.
          if (core.chat.classify(text) === "memory.remember" && !attested) {
            const refusal =
              "I can only record something as your own when the request comes from KAI itself.";
            settleTurn(refusal);
            sendJson(res, 200, {
              agent: "core",
              from_state: false,
              intent: "memory.remember",
              conversation_id: conversation?.id ?? null,
              reply: refusal,
              data: null,
            });
            return;
          }

          const answer = await core.chat.answer(
            text,
            ...(conversation?.id !== undefined ? [{ sessionId: conversation.id } as { sessionId: string }] : []),
          );

          if (answer.delegateTo !== undefined) {
            // The delegation the user asked for is PERFORMED, through the product's
            // one worker-relay path — never promised and then skipped.
            telemetry.delegatedTurns += 1;
            const worker = answer.delegateTo;
            let turnText = text;
            try {
              turnText = (await core.composeTurnPrompt(text)).text;
            } catch {
              turnText = text;
            }
            const outcome = await relayWorkerTurn({
              worker,
              turnText,
              kind: "delegated",
              workerSessionId: workerSessionIdFor(worker, body, conversation),
            });
            settleTurn(outcome.reply, worker, outcome.workerSessionId ?? undefined);
            sendJson(res, 200, {
              agent: "core",
              from_state: false,
              intent: answer.intent,
              worker,
              delegated: true,
              session_id: outcome.workerSessionId,
              conversation_id: conversation?.id ?? null,
              reply: outcome.reply,
              worker_identity_guarded: outcome.guarded,
              usage: outcome.usage ?? null,
            });
            return;
          }

          // No delegation: KAI answers from its OWN reasoning loop. This is the
          // normal chat path — its provenance is KAI's model provider, and its
          // dependency line proves no Hermes call was made. The brain's tool
          // records ride along so the turn persists its tool history.
          telemetry.normalChatTurns += 1;
          settleTurn(answer.text, undefined, undefined, answer.toolCalls);
          // Controlled capture on KAI's OWN answer only (answer.brain set),
          // and only for the attested host: durable user facts become memories
          // with provenance; chatter does not. Delegated worker turns skip
          // this — the worker owns them.
          if (answer.brain !== undefined) captureNormal(text, answer.text, attested);
          sendJson(res, 200, {
            agent: "core",
            from_state: answer.fromState,
            intent: answer.intent,
            conversation_id: conversation?.id ?? null,
            reply: answer.text,
            data: answer.data ?? null,
            brain: answer.brain ?? null,
            // The tool calls this turn made, as the transcript stores them —
            // the UI renders these records, it never invents them.
            tool_calls: answer.toolCalls ?? null,
            tool_iterations: answer.toolIterations ?? 0,
            tool_budget_exhausted: answer.toolBudgetExhausted ?? false,
            ...(answer.synthesized === true ? { synthesized: true } : {}),
            ...(answer.pendingTools !== undefined && answer.pendingTools.length > 0 ? { pending_tools: answer.pendingTools } : {}),
            task_state: answer.taskState ?? "COMPLETED",
            // Explicit `@` invocation behind the answer + a parked agent run
            // the UI can Allow (re-issued through the agent run path).
            invocation: answer.invocation ?? null,
            agent_run: answer.agentRun ?? null,
            dependency: { normal_chat_calls_to_hermes: telemetry.normalChatCallsToHermes },
          });
          return;
        }

        // No Core attached (the server's own tests): the historical relay to
        // Hermes — but a worker failure is still answered in KAI's voice rather
        // than as a reply-less 502. This path is a NORMAL turn reaching a worker,
        // which is exactly what the telemetry exists to surface: in production the
        // Core is always attached, so this counter stays 0.
        telemetry.normalChatTurns += 1;
        const outcome = await relayWorkerTurn({
          worker: "hermes",
          turnText: text,
          kind: "normal",
          workerSessionId: workerSessionIdFor("hermes", body, conversation),
        });
        settleTurn(outcome.reply, "hermes", outcome.workerSessionId ?? undefined);
        sendJson(res, 200, {
          agent: "core",
          worker: "hermes",
          session_id: outcome.workerSessionId,
          conversation_id: conversation?.id ?? null,
          reply: outcome.reply,
          worker_identity_guarded: outcome.guarded,
          usage: outcome.usage ?? null,
        });
        return;
      }

      // OpenCode's own prompt route, exposed the same way. Verified against the
      // live server: POST /session/{id}/message (operationId session.prompt).
      // Whether it answers depends entirely on a provider being configured —
      // the reply is relayed verbatim, including the server's own error text.
      if (path === "/agents/opencode/chat" && method === "POST") {
        const body = await readChatBody(req, res);
        if (body === null) return;
        const text = body["text"] as string;

        const { conversation, settleTurn } = conversationFor(body);

        // Same audit fix as the Hermes relay: the composed prompt is what a real
        // turn receives, and it ends with the user's request so the task itself is
        // unchanged.
        let turnText = text;
        if (core !== undefined) {
          try {
            turnText = (await core.composeTurnPrompt(text)).text;
          } catch {
            turnText = text;
          }
        }

        // THE FAILURE GUARANTEE. This route is where a bare 502 with no `reply`
        // was observed when OpenCode was down — KAI looked silent. It now answers
        // in KAI's own voice on every failure, and applies the relay boundary so
        // OpenCode's own voice never becomes KAI's speech.
        const outcome = await relayWorkerTurn({
          worker: "opencode",
          turnText,
          workerSessionId: workerSessionIdFor("opencode", body, conversation),
        });
        settleTurn(outcome.reply, "opencode", outcome.workerSessionId ?? undefined);
        sendJson(res, 200, {
          agent: "core",
          worker: "opencode",
          session_id: outcome.workerSessionId,
          conversation_id: conversation?.id ?? null,
          reply: outcome.reply,
          worker_identity_guarded: outcome.guarded,
          error: outcome.infoError ?? null,
        });
        return;
      }

      // ---- SSE fan-in ------------------------------------------------------
      if (path === "/events" && method === "GET") {
        await streamEvents(req, res, opencode, hermes);
        return;
      }

      // ---- parameterised routes -------------------------------------------
      const segments = path.split("/").filter((s) => s.length > 0);

      if (
        segments.length === 5 &&
        segments[0] === "agents" &&
        segments[1] === "hermes" &&
        segments[2] === "sessions" &&
        segments[4] === "messages" &&
        method === "GET"
      ) {
        const id = decodeURIComponent(segments[3] as string);
        sendJson(res, 200, { agent: "hermes", session_id: id, data: await hermes.sessionMessages(id) });
        return;
      }

      if (
        segments.length === 5 &&
        segments[0] === "agents" &&
        segments[1] === "opencode" &&
        segments[2] === "sessions" &&
        segments[4] === "messages" &&
        method === "GET"
      ) {
        const id = decodeURIComponent(segments[3] as string);
        sendJson(res, 200, { agent: "opencode", session_id: id, data: await opencode.messages(id) });
        return;
      }

      if (
        segments.length === 5 &&
        segments[0] === "agents" &&
        segments[1] === "opencode" &&
        segments[2] === "permissions" &&
        segments[4] === "reply" &&
        method === "POST"
      ) {
        const id = decodeURIComponent(segments[3] as string);
        let body: Record<string, unknown>;
        try {
          body = asRecord(await readBody(req));
        } catch (error) {
          sendJson(res, 400, { error: "invalid_request", reason: (error as Error).message });
          return;
        }
        const reply = body["reply"];
        if (typeof reply !== "string" || !PERMISSION_REPLIES.includes(reply as never)) {
          sendJson(res, 400, {
            error: "invalid_request",
            reason: "invalid_reply",
            allowed: [...PERMISSION_REPLIES],
          });
          return;
        }
        const message = typeof body["message"] === "string" ? (body["message"] as string) : undefined;
        const ok = await opencode.replyPermission(id, reply as never, message);
        sendJson(res, 200, { agent: "opencode", request_id: id, reply, ok });
        return;
      }

      if (
        segments.length === 5 &&
        segments[0] === "agents" &&
        segments[1] === "opencode" &&
        segments[2] === "questions" &&
        segments[4] === "reply" &&
        method === "POST"
      ) {
        const id = decodeURIComponent(segments[3] as string);
        let body: Record<string, unknown>;
        try {
          body = asRecord(await readBody(req));
        } catch (error) {
          sendJson(res, 400, { error: "invalid_request", reason: (error as Error).message });
          return;
        }
        const raw = body["answers"];
        if (!Array.isArray(raw) || raw.length === 0 || !raw.every((a) => typeof a === "string" || Array.isArray(a))) {
          sendJson(res, 400, { error: "invalid_request", reason: "invalid_answers" });
          return;
        }
        const answers = raw as string[] | string[][];
        const ok = await opencode.replyQuestion(id, answers);
        sendJson(res, 200, { agent: "opencode", request_id: id, answers, ok });
        return;
      }

      // ---- KAI Core surface (state, agents, missions, approvals, memory) ----
      // Mounted after the routes above on purpose: the pre-existing behaviour wins
      // any overlap, so adding the Core cannot change an existing response. A 404
      // from the Core API means "not one of mine" and falls through to the 404 below.
      if (path === "/core/events" && method === "GET") {
        if (core === undefined) {
          sendJson(res, 503, {
            error: "core_unavailable",
            reason: "no_core_runtime_attached",
          });
          return;
        }
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        const detach = attachEventStream(core, res);
        // ── Catch-up replay: events published BEFORE this client connected ──────
        //
        // THE FOURTH LINK. The Core publishes its startup events — most importantly
        // the recovery notification (`mission.recovery_blocked`, wire type
        // `notification.created`) — during `runtime.start()`, which runs BEFORE the
        // HTTP listener exists (see `main()` below). The bus does not re-emit them,
        // so a client that connects after the Core is listening (which every real
        // client does: it must first observe the Core is up) would never see them at
        // all. That is why RECOVERING was unreachable live even with the reducer,
        // the bridge and the event table all correct.
        //
        // The fix is a catch-up replay, not a reorder. `runtime.start()` publishes
        // the event; the bus keeps it in its bounded in-memory `recent()` ring,
        // ALREADY redacted at publish time; this writes that same ring to a newly
        // connected client, oldest first, in the same `data: <KaiEvent>` framing
        // `attachEventStream` uses — so there is one event model, not two, and the
        // generic `notification.created` envelope is untouched. (A listen-before-
        // start reorder was rejected: it would have to bind the port BEFORE the
        // ownership probe — which exists precisely to be asked "before binding" —
        // and it still would not be deterministic, because the client is not
        // connected during the tiny window in which `start()` publishes.)
        //
        // `attachEventStream` subscribed on the line above and this block runs in the
        // SAME synchronous tick (no `await` between them), so no event can be
        // published in between: an event is either in the snapshot (and was therefore
        // published before the subscription, so it was never delivered live) or it
        // arrives after the subscription (and is therefore not in the snapshot).
        // Nothing is lost and nothing is duplicated. The client also dedupes by
        // event id regardless, so a reconnect cannot double-count.
        for (const event of [...core.bus.recent()].reverse()) {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
        req.on("close", () => detach());
        return;
      }

      if (coreApi !== null) {
        let coreBody: unknown;
        if (method === "POST") {
          try {
            coreBody = await readBody(req);
          } catch (error) {
            sendJson(res, 400, { error: "invalid_request", reason: (error as Error).message });
            return;
          }
        }
        const result = await coreApi.handle({
          method,
          path,
          query: url.searchParams,
          body: coreBody,
          // Owner attestation for the routes that change what KAI is AUTHORIZED
          // to do. Computed here, where the request headers are, and passed as a
          // fact — the API module never re-reads a header.
          attested: hostAttested(req),
          ownerAuthConfigured: hostToken !== undefined && hostToken.length > 0,
          // An explicit developer switch, never inferred. A normal installation
          // (the app always injects the token) never sets this.
          devMode: process.env.KAI_DEV_MODE === "1",
        });
        if (result.status !== 404) {
          sendJson(res, result.status, result.body);
          return;
        }
      }

      // ---- known path, wrong method ---------------------------------------
      const knownPaths = new Set([
        "/health",
        "/integrations",
        "/independence",
        "/events",
        "/chat",
        "/chat/stream",
        "/agents/kai/chat/stream",
        "/agents/hermes/chat",
        "/agents/hermes/sessions",
        "/agents/opencode/chat",
        "/agents/opencode/sessions",
        "/agents/opencode/permissions",
        "/agents/opencode/questions",
      ]);
      if (knownPaths.has(path)) {
        sendJson(res, 405, { error: "method_not_allowed", reason: "method_not_allowed", method });
        return;
      }

      sendJson(res, 404, { error: "not_found", reason: "unknown_route", path });
    } catch (error) {
      sendAgentFailure(res, error, error instanceof AgentError ? error.target : "upstream");
    }
  }

  server.on("clientError", (_err, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });

  // KEEP-ALIVE: the client (undici, which backs `fetch` in the UI and in the
  // probes) derives its idle timeout from this server's `Keep-Alive: timeout=`
  // header. At Node's 5s default both sides expire at the same instant, so a
  // client can reuse a socket the server is closing and get ECONNRESET —
  // measured systematically in orch-e2e S6 (3/3 runs failed at the first
  // request after the burst; 3/3 clean once this was raised). `headersTimeout`
  // must stay above `keepAliveTimeout`.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  return server;
}

/**
 * GET /events — SSE fan-in.
 *
 * OpenCode exposes a real global event stream at GET /event (verified live:
 * `data: {"id":"evt_...","type":"server.connected","properties":{}}`), so those
 * events are relayed verbatim, tagged `opencode`.
 *
 * The Hermes api-server has NO global event stream in its verified route table
 * (only the per-turn POST /api/sessions/{id}/chat/stream). KAI Core therefore
 * emits periodic `hermes.status` snapshots from the verified GET /health +
 * GET /v1/models probe instead of pretending a Hermes event feed exists.
 */
async function streamEvents(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opencode: OpenCodeClient,
  hermes: HermesClient,
): Promise<void> {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });

  let closed = false;
  const write = (event: string, data: unknown): void => {
    if (closed || res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  write("kai.ready", { service: "kai-core", at: new Date().toISOString() });

  const controller = new AbortController();
  const poll = setInterval(() => {
    void hermes.probe().then((probe) => write("hermes.status", probe));
  }, HERMES_STATUS_POLL_MS);

  const onClose = (): void => {
    closed = true;
    controller.abort();
    clearInterval(poll);
  };
  req.on("close", onClose);
  res.on("close", onClose);

  try {
    for await (const event of opencode.events(controller.signal)) {
      const type = typeof asRecord(event)["type"] === "string"
        ? (asRecord(event)["type"] as string)
        : "message";
      write(`opencode.${type}`, event);
    }
  } catch (error) {
    if (!closed) {
      write("opencode.error", {
        reason: isAgentError(error) ? `upstream_${error.kind}` : "internal_error",
      });
    }
  } finally {
    onClose();
    if (!res.writableEnded) res.end();
  }
}

export async function main(): Promise<void> {
  // ── Guard proof-of-life: refuse to serve a relay that cannot guard ───────────
  //
  // This closes the third recurrence of "the source is correct, the artifact the
  // process loaded is not". `core/dist/` is a compiled copy of chat/relay.ts; a
  // process that ran a dist built before the guard's latest patterns relayed a
  // worker's own self-introduction VERBATIM to the user while reporting
  // `worker_identity_guarded: false`. Every /chat path already funnels through
  // `relayWorkerTurn` → `presentWorkerResult`, so the defect was never a missing
  // call site — it was a stale compiled guard serving silently. Run THE guard
  // once over a known worker self-introduction and refuse to start if it is a
  // no-op: a build that cannot guard must not be able to answer a turn at all.
  if (!relayGuardIsLive()) {
    console.error(
      "[kai-core] REFUSED: the compiled relay guard is NOT live — this build cannot stop a " +
        "worker from speaking as KAI (a worker's self-identification would be relayed verbatim). " +
        "This is a stale compiled artifact (core/dist or core/bundle was built before the current " +
        "chat/relay.ts). Rebuild it: `cd core && npm run build` (dist) and/or `npm run bundle`. " +
        "No turn will be served by this process.",
    );
    process.exit(4);
  }

  // ── Identity self-check: refuse to serve a build that is not this source ─────
  //
  // The relay guard above proves the compiled guard is live; this proves the
  // WHOLE artifact is the build of the source beside it. It closes the other half
  // of "source != artifact": a stale `dist/` or `bundle/` whose relay guard was
  // fresh but whose rest was old, or a `dist/build-info.json` that drifted from
  // `bundle/build-info.json`. `/identity` now reports the identity this process
  // LOADED (frozen at startup), plus a source-hash-vs-stamp verdict; a "stale"
  // verdict refuses to start rather than serve as if it were current.
  const identityBoot = identitySelfCheck(loadIdentity());
  if (!identityBoot.ok) {
    console.error(`[kai-core] ${identityBoot.detail}`);
    process.exit(identityBoot.code);
  }
  console.log(`[kai-core] ${identityBoot.detail}`);

  // One credential, one resolution. `loadConfig()` reports what the ENVIRONMENT
  // provides; the extra step — the Hermes install's own ~/.hermes/.env — is applied
  // here so the chat relay and the agent adapter resolve the key identically. They
  // did not before, and the symptom was a hand-started Core that could run a worker
  // task over /v1/runs while every /chat turn sent no Authorization header at all.
  // A key the desktop app passed is left untouched.
  const config = withResolvedHermesKey(loadConfig());
  // The Core control plane runs inside this process. The UI is a client of this
  // server rather than the owner of the state, so the island can be closed and
  // reopened without losing missions, memory or approvals.
  const runtime = createCoreRuntime();
  const started = await runtime.start();
  console.log(
    `[kai-core] runtime started  agents=${JSON.stringify(started.agents)}` +
      `  missions=${started.recovered.resumed.length} resumed/${started.recovered.blocked.length} blocked`,
  );
  const server = createKaiServer(config, { core: runtime });

  // ── Ownership decision (Phase 1 Priority 1/2/9) ──────────────────────────────
  //
  // Asked BEFORE binding, so the answer is about who owns the port rather than
  // about which process happened to win a race. There are exactly three outcomes
  // and all three are explicit: adopt, refuse, or become the Core. The failure
  // this replaces exited on EADDRINUSE while its caller carried on believing a new
  // build was serving — and answers from an unknown Core look exactly like answers
  // from the right one.
  const base = `http://${config.server.host}:${config.server.port}`;
  const identity = loadIdentity();

  const existing = await probeExistingCore(base);
  if (existing !== null) {
    if (existing.protocolVersion === identity.protocolVersion) {
      console.log(
        `[kai-core] ADOPTED an existing Core at ${base}` +
          ` (protocol=${String(existing.protocolVersion)} build=${String(existing.buildId)} pid=${String(existing.pid)})` +
          ` — this process is standing down; the existing Core stays authoritative.`,
      );
      process.exit(0);
    }
    console.error(
      `[kai-core] REFUSED: ${base} is owned by an INCOMPATIBLE kai-core` +
        ` (protocol=${String(existing.protocolVersion)}, expected=${identity.protocolVersion}, build=${String(existing.buildId)}).` +
        ` No second control plane was started.`,
    );
    process.exit(3);
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.server.port, config.server.host, () => resolve());
  }).catch(async (error: unknown) => {
    if (!isAddressInUse(error)) throw error;
    // Something holds the port but did not answer /identity as a Core. Say so
    // distinctly, name the owner, and exit with a code a parent can act on —
    // never a silent stand-down.
    const pid = await owningPidForPort(config.server.port);
    console.error(
      `[kai-core] PORT_IN_USE: ${base} is held by pid ${pid ?? "unknown"}, which did not answer /identity as a compatible kai-core.` +
        ` Refusing to become a second control plane.`,
    );
    process.exit(2);
  });

  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : config.server.port;
  // redactedConfig() carries booleans in place of the two secrets. Nothing else is logged.
  console.log(`[kai-core] ${describeIdentity(identity)}`);
  console.log(
    `[kai-core] listening on http://${config.server.host}:${port}  config=${JSON.stringify(redactedConfig(config))}`,
  );

  const shutdown = (): void => {
    // Stop the Core first: the scheduler must not fire into a closed database, and
    // a step that is mid-flight should finish being recorded rather than be lost.
    void runtime
      .stop()
      .catch(() => undefined)
      .finally(() => server.close(() => process.exit(0)));
    setTimeout(() => process.exit(0), 2_000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error: unknown) => {
    console.error("[kai-core] failed to start:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
