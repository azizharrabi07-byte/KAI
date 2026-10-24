// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * KAI's OWN reasoning loop — the inference half.
 *
 * ── What "KAI owns the reasoning loop" means here ─────────────────────────────
 * KAI Core already owns the responsibilities around a turn: system identity and
 * soul (agent/soul.ts), the composed system prompt — safety -> identity -> user
 * context -> memory -> skills -> mission -> request (prompts/**), the tool
 * registry and policy/approval plane (tools/**, policies/**, approvals/**),
 * planning (missions/**), delegation (workforce/**) and session state
 * (sessions/**). The ONE piece that was never KAI's was the actual model call: a
 * turn was handed to a worker and the worker's reply was relayed.
 *
 * This module closes that gap. `createKaiBrain` is the orchestrator that, for a
 * normal conversational turn, assembles the messages KAI's own identity/context
 * demand and calls KAI's own `ModelProvider`. No worker is consulted; the reply is
 * genuine inference through a KAI-owned abstraction.
 *
 * The brain deliberately does NOT re-implement tool execution, memory or
 * planning — those are separate KAI subsystems the runtime composes around it.
 * It is the model-facing edge of a loop KAI already owns.
 */

import type {
  ChatMessage,
  ChatResult,
  ModelHealth,
  ModelProvider,
  ModelToolDeclaration,
  StreamChunk,
  ToolCall,
  ToolStreamEvent,
} from "../model/types.ts";
import { ModelError, type ThinkingLevel } from "../model/types.ts";
import type { ModelToolExecution, ModelToolPlane } from "../tools/model-plane.ts";
import { synthesisDirective } from "../prompts/compose.ts";

/**
 * The most a single tool result may contribute to the continuation prompt.
 *
 * A browser read returns a whole page. Feeding ten of them back unbounded made
 * the continuation large enough to exceed the provider's request timeout, so a
 * research turn ran every tool and then produced NO answer at all. The model
 * needs the substance of a result, not the entire document; the full record is
 * still kept in `result` for the transcript and the activity timeline.
 */
const TOOL_RESULT_CHARS = 12_000;

export type { ToolStreamEvent };

export interface BrainTurnInput {
  /** The user's own message. */
  text: string;
  /**
   * The ORIGINAL objective this turn serves. Equals `text` on a fresh turn;
   * on a resumed ("continue") turn it is the task's objective while `text`
   * carries the resume prompt. The synthesis guard answers THIS.
   */
  objective?: string;
  /** KAI's composed system prompt (identity, soul, memory, skills, request). */
  system: string;
  /** KAI-owned provenance label for the audit trail. */
  purpose?: string;
  /** An existing KAI conversation id, passed for scope/telemetry only. */
  sessionId?: string;
  /** The agent that CAUSED this turn, stamped on every tool it selects. */
  agentId?: string;
  model?: string;
  temperature?: number;
  /**
   * The thinking level for this turn, chosen in the UI. The provider applies it;
   * the terminal frame reports which parameters it really produced.
   */
  thinking?: ThinkingLevel;
  signal?: AbortSignal;
  /**
   * Per-turn tool-event listener. Wins over the constructor's `onToolEvent`
   * for this turn — the server uses it to persist a streamed turn's tool
   * history without rewiring the shared brain.
   */
  onToolEvent?: (event: ToolStreamEvent) => void;
}

/** One tool the model selected this turn, and what the registry did with it. */
export interface BrainToolCallRecord {
  /** The model-side call id (`call_…`), so a transcript can bind request to outcome. */
  id: string;
  /** The wire name the model selected (`filesystem_search`). */
  name: string;
  /**
   * The canonical registry id (`filesystem.search`), when the name resolved to
   * a real tool. Transcripts and digests read THIS, never the wire spelling.
   */
  toolId?: string;
  ok: boolean;
  status: string;
  invocationId?: string;
  /** The raw JSON argument string the model sent, verbatim. */
  arguments: string;
  /** The tool's value, or the refusal value — what the MODEL read. */
  result: unknown;
  /** The approval that parked or authorised the call, when the refusal names one. */
  approvalId?: string;
  startedAt: string;
  completedAt: string;
}

export interface BrainTurnResult {
  text: string;
  model: string;
  provider: string;
  usage?: unknown;
  /** The tool calls this turn made, in order. Absent when none were made. */
  toolCalls?: BrainToolCallRecord[];
  /** How many model→tool→model rounds this turn took. */
  toolIterations: number;
  /**
   * True when the run's AbortSignal stopped the turn: the records so far are
   * what settled, and the caller must report ABORTED — never completion.
   */
  cancelled?: boolean;
  /** The budget that applied to this turn (runtime configuration, not a constant). */
  maxToolIterations: number;
  /**
   * True when the model still wanted tools after the budget ran out. The turn
   * answers with what it has — this flag (not silence) is how a caller knows
   * the answer is tool-truncated.
   */
  toolBudgetExhausted: boolean;
  /**
   * True when the final-synthesis guard ran: after tool work with no
   * deliverable (budget hit or empty text), the brain made ONE more
   * tools-disabled call to answer the original objective from the evidence.
   * The caller records this on the task (SYNTHESIZING happened) and verifies
   * the deliverable exists before completing.
   */
  synthesized: boolean;
  /**
   * Canonical names of tool calls the model requested but that never
   * executed (budget cut). The pause message names these as the remainder.
   */
  pendingTools?: string[];
}

export interface KaiBrainDescription {
  provider: string;
  model: string;
  /** True when a credential is configured and a call can be attempted. */
  configured: boolean;
  /** True when the model can select and run KAI's tools. */
  tools: boolean;
  /** The tool ids the model may choose from, when a tool plane is wired. */
  toolIds: string[];
  /**
   * Whether the provider accepts `reasoning_effort`. Reported so a thinking level
   * can be described honestly: as a reasoning setting, or only as a token budget.
   */
  supportsReasoningEffort: boolean;
}

/**
 * The interface the chat router/server depends on. Kept structural so a test can
 * inject a stub brain without a provider, exactly as the router's other ports are.
 */
export interface KaiBrain {
  /** True when this brain can attempt a real model call. */
  available(): boolean;
  describe(): KaiBrainDescription;
  respond(input: BrainTurnInput): Promise<BrainTurnResult>;
  stream(input: BrainTurnInput): AsyncIterable<StreamChunk>;
  health(): Promise<ModelHealth>;
}

export interface KaiBrainOptions {
  provider: ModelProvider;
  /**
   * KAI's tool plane. When present, a conversational turn offers these tools to
   * the model and EXECUTES the ones it selects through the registry boundary,
   * feeding each result back into the model context until the model answers
   * without a tool call. When absent the brain is a pure text turn, exactly as
   * before — so every existing caller is unaffected.
   */
  tools?: ModelToolPlane;
  /** Recorded on every call's provenance; defaults to "normal_chat". */
  purpose?: string;
  /**
   * How many tool-call rounds one turn may take before the loop stops and
   * answers with what it has. A guard against a model that loops forever.
   * Runtime configuration (see `CoreRuntimeOptions.brainMaxToolIterations`);
   * the applied value is reported on every turn result.
   */
  maxToolIterations?: number;
  /**
   * Listener for real tool-lifecycle events (`tool_start`, `tool_done`,
   * `tool_error`, `tool_approval_required`), fired from the actual execution in
   * both `respond()` and `stream()`. A throwing listener never breaks the turn.
   */
  onToolEvent?: (event: ToolStreamEvent) => void;
  /**
   * What to do when a tool parks for approval MID-TURN.
   *
   * Without this the turn ends at "I need your approval", the owner approves
   * later, the parked call runs — and the model never learns that. The action
   * succeeded and the user was told nothing about it. With it, the turn waits
   * for the verdict, then continues in the SAME tool loop with the real result,
   * so the assistant can answer the original question.
   */
  awaitApproval?: (approvalId: string, signal?: AbortSignal) => Promise<string | null>;
}

/** The default round cap: enough for search -> read -> answer, not an infinite loop. */
export const DEFAULT_MAX_TOOL_ITERATIONS = 6;

export function createKaiBrain(options: KaiBrainOptions): KaiBrain {
  const provider = options.provider;
  const purpose = options.purpose ?? "normal_chat";
  const plane = options.tools;
  const maxToolIterations = options.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS;

  function messagesFor(input: BrainTurnInput): ChatMessage[] {
    const messages: ChatMessage[] = [];
    const system = input.system.trim();
    if (system.length > 0) messages.push({ role: "system", content: system });
    messages.push({ role: "user", content: input.text });
    return messages;
  }

  /**
   * The tool declarations to offer, or none. A plane with no exposed tools is
   * treated as "no tools" — sending an empty array would be a lie about what
   * the model may do.
   */
  function toolDeclarations(): ModelToolDeclaration[] | undefined {
    if (plane === undefined) return undefined;
    const declarations = plane.declarations();
    return declarations.length > 0 ? declarations : undefined;
  }

  /**
   * A call, not a property read: TypeScript narrows `input.signal?.aborted`
   * across loop iterations after one check, so repeated inline comparisons
   * miscompile to `false | undefined`. The closure re-reads every time.
   */
  function isAborted(input: BrainTurnInput): boolean {
    return input.signal?.aborted === true;
  }

  function toolContext(input: BrainTurnInput): { sessionId?: string; agentId?: string; signal?: AbortSignal } {
    return {
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
      // The run's cancellation rides into every tool execution: a Stop that
      // arrives mid-tool kills the attempt through the registry boundary,
      // not just the text stream around it.
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    };
  }

  /** A listener that throws must never break the turn it observes. */
  function emitToolEvent(
    event: ToolStreamEvent,
    input: BrainTurnInput,
    onChunk?: (event: ToolStreamEvent) => void,
  ): void {
    const listener = input.onToolEvent ?? options.onToolEvent;
    try {
      listener?.(event);
    } catch {
      // Observation is best-effort; execution already happened.
    }
    if (onChunk !== undefined) {
      try {
        onChunk(event);
      } catch {
        // Same rule for the streaming sink.
      }
    }
  }

  /** The refusal value the plane returns carries {error, message} — surface it. */
  function refusalError(value: unknown): { code: string; message: string } | undefined {
    if (typeof value !== "object" || value === null) return undefined;
    const record = value as Record<string, unknown>;
    if (typeof record["error"] !== "string" || typeof record["message"] !== "string") return undefined;
    return { code: record["error"], message: record["message"] };
  }

  /** A parked refusal names its approval (`approvalRequired`) — keep it on the record. */
  function approvalIdOf(value: unknown): string | undefined {
    if (typeof value !== "object" || value === null) return undefined;
    const approvalRequired = (value as Record<string, unknown>)["approvalRequired"];
    return typeof approvalRequired === "string" && approvalRequired.length > 0 ? approvalRequired : undefined;
  }

  /**
   * Execute one round's tool calls and append the assistant call + each result
   * to `messages`, so the next model call can read what happened. The result
   * VALUE is JSON — the model reads it, not KAI's prose about it.
   *
   * Every call emits real lifecycle events (`tool_start`, then exactly one of
   * `tool_done` / `tool_error` / `tool_approval_required`) to the configured
   * listener and, when streaming, to the chunk sink — from the actual
   * execution, never synthesised.
   */
  async function runToolCalls(
    activePlane: ModelToolPlane,
    messages: ChatMessage[],
    calls: ToolCall[],
    input: BrainTurnInput,
    records: BrainToolCallRecord[],
    onChunk?: (event: ToolStreamEvent) => void,
    assistantContent = "",
  ): Promise<void> {
    // The assistant message must carry the calls so the provider can bind each
    // tool result to its request by `tool_call_id`. When streaming, the
    // model's already-sent preamble rides along so the next round reads the
    // same turn the user saw.
    messages.push({ role: "assistant", content: assistantContent, toolCalls: calls });
    for (const call of calls) {
      const startedAt = new Date().toISOString();
      emitToolEvent(
        {
          type: "tool_start",
          toolCallId: call.id,
          toolName: call.name,
          invocationId: "",
          arguments: call.arguments,
          startedAt,
        },
        input,
        onChunk,
      );
      let executed: ModelToolExecution = await activePlane.execute(call.name, call.arguments, toolContext(input));

      // ── A parked call: WAIT for the verdict, then run it in this same turn ──
      // The owner decides from the UI while this turn is still open. Parking and
      // returning "needs approval" used to end the turn, so the approved action
      // ran with nobody to tell — the model never saw its result and the user got
      // no answer. Waiting keeps the tool-call context and resumes in place.
      const parkedId = executed.status === "APPROVAL_REQUIRED" ? approvalIdOf(executed.value) : undefined;
      if (parkedId !== undefined && options.awaitApproval !== undefined) {
        const verdict = await options.awaitApproval(parkedId, input.signal);
        if (verdict === "APPROVED") {
          // Re-issue the SAME call with the approving id. It dispatches once: the
          // registry claims the approval atomically.
          //
          // The id goes in BOTH places, exactly as the non-turn re-issue path does:
          // as an invoke option (the registry's approval check reads it) and inside
          // the input (a tool whose own validator insists on naming the approving
          // record refuses an input that does not carry it). Passing only the option
          // left the call unauthorised and the turn produced no text at all.
          let reissuedArgs = call.arguments;
          try {
            const parsed = JSON.parse(call.arguments) as unknown;
            if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
              reissuedArgs = JSON.stringify({ ...(parsed as Record<string, unknown>), approvalId: parkedId });
            }
          } catch {
            // A non-JSON argument string cannot carry the id; the option still does.
          }
          executed = await activePlane.execute(call.name, reissuedArgs, {
            ...toolContext(input),
            approvalId: parkedId,
          });
        } else if (verdict !== null) {
          // Rejected or expired: the action must NOT run. The model is told, so it
          // explains the refusal instead of pretending it happened.
          executed = {
            ok: false,
            status: verdict === "EXPIRED" ? "EXPIRED" : "REJECTED",
            value: {
              error: verdict === "EXPIRED" ? "approval_expired" : "approval_rejected",
              message:
                verdict === "EXPIRED"
                  ? "the owner did not answer this request in time, so it was not run"
                  : "the owner rejected this action, so it was not run",
            },
            toolId: executed.toolId,
            invocationId: executed.invocationId,
          } as ModelToolExecution;
        }
      }

      const completedAt = new Date().toISOString();
      const approvalId = approvalIdOf(executed.value);
      records.push({
        id: call.id,
        name: call.name,
        ...(executed.toolId !== undefined ? { toolId: executed.toolId } : {}),
        ok: executed.ok,
        status: executed.status,
        ...(executed.invocationId.length > 0 ? { invocationId: executed.invocationId } : {}),
        arguments: call.arguments,
        result: executed.value ?? null,
        ...(approvalId !== undefined ? { approvalId } : {}),
        startedAt,
        completedAt,
      });
      const terminalType =
        executed.status === "APPROVAL_REQUIRED"
          ? "tool_approval_required"
          : executed.ok
            ? "tool_done"
            : "tool_error";
      const failure = refusalError(executed.value);
      emitToolEvent(
        {
          type: terminalType,
          toolCallId: call.id,
          toolName: call.name,
          ...(executed.toolId !== undefined ? { toolId: executed.toolId } : {}),
          invocationId: executed.invocationId,
          arguments: call.arguments,
          status: executed.status,
          startedAt,
          completedAt,
          ...(failure !== undefined ? { error: failure } : {}),
          ...(approvalId !== undefined ? { approvalId } : {}),
          result: executed.value ?? null,
        },
        input,
        onChunk,
      );
      const whole = JSON.stringify(executed.value ?? null);
      messages.push({
        role: "tool",
        toolCallId: call.id,
        content: whole.length > TOOL_RESULT_CHARS
          // Said plainly, because a silently shortened result invites the model to
          // treat the cut as the end of the document.
          ? `${whole.slice(0, TOOL_RESULT_CHARS)}\n… [result truncated: ${whole.length} characters total]`
          : whole,
      });
    }
  }

  /**
   * Compact evidence digest for the synthesis pass: what ran, with what
   * outcome, results truncated — the model answers from this, not from a
   * re-read of the whole transcript.
   */
  function evidenceDigest(records: BrainToolCallRecord[]): string {
    const lines: string[] = [];
    for (const record of records.slice(0, 12)) {
      const name = record.toolId ?? record.name;
      let result = "";
      try {
        result = JSON.stringify(record.result ?? null);
      } catch {
        result = "unserialisable result";
      }
      if (result.length > 400) result = `${result.slice(0, 400)}…`;
      lines.push(`- ${name} [${record.status}]: ${result}`);
    }
    if (records.length > 12) lines.push(`- (+${records.length - 12} more tool steps)`);
    return lines.join("\n");
  }

  /**
   * The final-synthesis guard. When a turn used tools but has no deliverable —
   * the budget ran out with calls still pending, or the final text is empty —
   * the loop must NOT terminate on a progress preamble. One more model call,
   * tools DISABLED, answers the ORIGINAL objective from the evidence. It never
   * throws: a failed synthesis is reported by flags, and the caller (task
   * lifecycle) writes the honest pause instead of pretending completion.
   */
  async function synthesize(
    input: BrainTurnInput,
    messages: ChatMessage[],
    records: BrainToolCallRecord[],
    budgetHit: boolean,
  ): Promise<{ text: string; ran: boolean }> {
    const objective = (input.objective ?? input.text).trim();
    if (records.length === 0 || objective.length === 0) return { text: "", ran: false };
    const directive = synthesisDirective(objective, { budgetHit, toolSteps: records.length });
    const synthesisMessages: ChatMessage[] = [
      ...messages,
      { role: "user", content: `Evidence gathered this turn:\n${evidenceDigest(records)}\n\n${directive}` },
    ];
    try {
      const result = await provider.chat({
        messages: synthesisMessages,
        purpose: `${input.purpose ?? purpose}:synthesis`,
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
        ...(input.thinking !== undefined ? { thinking: input.thinking } : {}),
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      });
      return { text: result.text, ran: true };
    } catch {
      return { text: "", ran: true };
    }
  }

  function pendingNames(calls: ToolCall[]): string[] {
    const names: string[] = [];
    for (const call of calls) {
      const name = call.name.trim();
      if (name.length > 0 && !names.includes(name)) names.push(name);
    }
    return names;
  }

  return {
    available(): boolean {
      return provider.capabilities().chat;
    },

    describe(): KaiBrainDescription {
      const capabilities = provider.capabilities();
      return {
        provider: provider.id,
        model: provider.model,
        configured: capabilities.chat,
        tools: capabilities.tools && plane !== undefined,
        toolIds: plane !== undefined ? plane.toolIds() : [],
        supportsReasoningEffort: capabilities.supportsReasoningEffort,
      };
    },

    async respond(input: BrainTurnInput): Promise<BrainTurnResult> {
      const messages = messagesFor(input);
      const declarations = toolDeclarations();
      const records: BrainToolCallRecord[] = [];
      let result: ChatResult | undefined;
      let iterations = 0;
      let cancelled = false;

      for (;;) {
        // A Stop that landed between rounds ends the turn before the next
        // model call — no phantom round after the user cancelled.
        if (isAborted(input)) {
          cancelled = true;
          break;
        }
        try {
          result = await provider.chat({
            messages,
            purpose: input.purpose ?? purpose,
            ...(declarations !== undefined ? { tools: declarations } : {}),
            ...(input.model !== undefined ? { model: input.model } : {}),
            ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
          ...(input.thinking !== undefined ? { thinking: input.thinking } : {}),
            ...(input.signal !== undefined ? { signal: input.signal } : {}),
          });
        } catch (error) {
          // An aborted provider call is a cancellation, not a brain failure:
          // report what settled instead of throwing.
          if (isAborted(input)) {
            cancelled = true;
            break;
          }
          throw error;
        }
        const calls = result.toolCalls ?? [];
        if (calls.length === 0 || plane === undefined || iterations >= maxToolIterations) break;
        iterations += 1;
        await runToolCalls(plane, messages, calls, input, records);
        if (isAborted(input)) {
          cancelled = true;
          break;
        }
      }

      if (cancelled) {
        return {
          text: result?.text ?? "",
          model: result?.model ?? provider.model,
          provider: result?.provider ?? provider.id,
          ...(records.length > 0 ? { toolCalls: records } : {}),
          toolIterations: iterations,
          maxToolIterations,
          toolBudgetExhausted: false,
          synthesized: false,
          cancelled: true,
        };
      }
      if (result === undefined) {
        // Unreachable: every non-cancelled loop exit assigns a model result
        // before breaking. Kept as a throw (not a silent empty turn) so a
        // future edit that breaks the invariant fails loudly in tests.
        throw new Error("brain turn ended with no model result");
      }

      // The budget ran out while the model still wanted tools: the turn answers
      // with what it has, and says so structurally — never silently.
      const toolBudgetExhausted =
        plane !== undefined && (result.toolCalls?.length ?? 0) > 0 && iterations >= maxToolIterations;
      const pending = toolBudgetExhausted ? pendingNames(result.toolCalls ?? []) : [];
      // Final-synthesis guard: tools ran but the turn has no deliverable.
      // One tools-disabled pass answers the original objective from the
      // evidence; a failed synthesis keeps the flags so the task lifecycle
      // pauses honestly instead of shipping a progress preamble as the answer.
      let text = result.text;
      let synthesized = false;
      if (records.length > 0 && (toolBudgetExhausted || text.trim().length === 0)) {
        const final = await synthesize(input, messages, records, toolBudgetExhausted);
        if (final.text.trim().length > 0) {
          text = final.text;
          synthesized = true;
        }
      }
      return {
        text,
        model: result.model,
        provider: result.provider,
        ...(result.usage !== undefined ? { usage: result.usage } : {}),
        ...(records.length > 0 ? { toolCalls: records } : {}),
        toolIterations: iterations,
        maxToolIterations,
        toolBudgetExhausted,
        synthesized,
        ...(pending.length > 0 ? { pendingTools: pending } : {}),
      };
    },

    /**
     * The streaming form of the same loop. A pure text turn streams exactly as
     * it always did (the model's tokens are yielded as they arrive). When the
     * model instead requests tools, each round's calls are executed and their
     * results appended, then the next round streams — so a tool-using turn is
     * still incremental, not buffered.
     */
    stream(input: BrainTurnInput): AsyncIterable<StreamChunk> {
      const declarations = toolDeclarations();
      if (declarations === undefined || plane === undefined) {
        return provider.stream({
          messages: messagesFor(input),
          purpose: input.purpose ?? purpose,
          ...(input.model !== undefined ? { model: input.model } : {}),
          ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
          ...(input.thinking !== undefined ? { thinking: input.thinking } : {}),
          ...(input.signal !== undefined ? { signal: input.signal } : {}),
        });
      }

      const planeRef = plane;
      // Events emitted during a tool round are queued here and yielded as
      // chunks by the loop below, in execution order.
      const pendingEvents: ToolStreamEvent[] = [];
      async function* loop(): AsyncIterable<StreamChunk> {
        const messages = messagesFor(input);
        // Every executed call across all rounds: the synthesis guard's evidence.
        const allRecords: BrainToolCallRecord[] = [];
        const cancelledTerminal = (iteration: number): StreamChunk => ({
          delta: "",
          done: true,
          toolIterations: iteration,
          maxToolIterations,
          toolBudgetExhausted: false,
          cancelled: true,
        });
        for (let iteration = 0; ; iteration += 1) {
          // A Stop between rounds ends the turn before the next model call.
          // (A provider that ignores the signal — or buffers — must not run
          // on: the loop checks the run's own flag, not just the fetch.)
          if (isAborted(input)) {
            yield cancelledTerminal(iteration);
            return;
          }
          let content = "";
          let calls: ToolCall[] = [];
          let terminal: StreamChunk | undefined;
          for await (const chunk of provider.stream({
            messages,
            tools: declarations,
            purpose: input.purpose ?? purpose,
            ...(input.model !== undefined ? { model: input.model } : {}),
            ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
          ...(input.thinking !== undefined ? { thinking: input.thinking } : {}),
            ...(input.signal !== undefined ? { signal: input.signal } : {}),
          })) {
            if (chunk.done) {
              terminal = chunk;
              calls = chunk.toolCalls ?? [];
              break;
            }
            content += chunk.delta;
            yield chunk;
          }
          // A Stop that landed mid-text ends the turn HERE with what
          // streamed — no tool round, no synthesis pass, no completion.
          if (isAborted(input)) {
            yield cancelledTerminal(iteration);
            return;
          }
          const exhausted = calls.length > 0 && iteration >= maxToolIterations;
          if (calls.length === 0 || iteration >= maxToolIterations) {
            // Final-synthesis guard (streaming form): tools ran but the turn
            // has no deliverable. The closing text streams from ONE
            // tools-disabled pass over the evidence — the user watches the
            // answer arrive, not another silent stop.
            let synthesized = false;
            if (allRecords.length > 0 && (exhausted || content.trim().length === 0)) {
              const objective = (input.objective ?? input.text).trim();
              if (objective.length > 0) {
                const directive = synthesisDirective(objective, { budgetHit: exhausted, toolSteps: allRecords.length });
                try {
                  for await (const chunk of provider.stream({
                    messages: [
                      ...messages,
                      {
                        role: "user",
                        content: `Evidence gathered this turn:\n${evidenceDigest(allRecords)}\n\n${directive}`,
                      },
                    ],
                    purpose: `${input.purpose ?? purpose}:synthesis`,
                    ...(input.model !== undefined ? { model: input.model } : {}),
                    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
          ...(input.thinking !== undefined ? { thinking: input.thinking } : {}),
                    ...(input.signal !== undefined ? { signal: input.signal } : {}),
                  })) {
                    if (chunk.done) break;
                    content += chunk.delta;
                    yield chunk;
                  }
                  if (content.trim().length > 0) synthesized = true;
                } catch {
                  // A failed synthesis keeps the flags; the task lifecycle
                  // pauses honestly instead of pretending completion.
                }
              }
            }
            const done: StreamChunk = terminal ?? { delta: "", done: true, finishReason: "stop" };
            yield {
              ...done,
              delta: "",
              done: true,
              toolIterations: iteration,
              maxToolIterations,
              toolBudgetExhausted: exhausted,
              ...(synthesized ? { synthesized: true } : {}),
            };
            return;
          }
          // A tool-call round: each execution emits its lifecycle events, which
          // are queued and yielded as chunks WITH their result value — the
          // server boundary attaches the bounded redacted wire preview, so the
          // timeline renders real content instead of bare names. The streamed
          // preamble was already sent; it rides on the assistant message for
          // the next round.
          const round: BrainToolCallRecord[] = [];
          await runToolCalls(
            planeRef,
            messages,
            calls,
            input,
            round,
            (event) => {
              // The FULL event rides the chunk now — the server boundary
              // attaches the bounded redacted preview for the wire. Stripping
              // here is what starved the timeline of result content.
              pendingEvents.push(event);
            },
            content,
          );
          for (const record of round) allRecords.push(record);
          for (const event of pendingEvents.splice(0)) {
            yield { delta: "", done: false, toolEvent: event };
          }
          // A Stop that landed mid-tool ends the turn HERE: no next model
          // round, no synthesis pass — the settled state says cancelled.
          if (isAborted(input)) {
            yield {
              delta: "",
              done: true,
              toolIterations: iteration + 1,
              maxToolIterations,
              toolBudgetExhausted: false,
              cancelled: true,
            };
            return;
          }
        }
      }
      return loop();
    },

    health(): Promise<ModelHealth> {
      return provider.health();
    },
  };
}

/**
 * KAI's own voice when its model provider cannot answer a conversational turn.
 *
 * This is the ONE user-facing wording for "KAI's inference is unavailable", and it
 * names KAI'S provider, never a worker. Hermes being down must never produce a
 * sentence about Hermes on an ordinary turn; only a genuinely delegated job may.
 * `detail` is available to logs and the health surface but is not echoed verbatim,
 * so wire jargon never reaches the user.
 */
export function brainFailureReply(detail: string): string {
  const reason = detail.trim().length > 0 ? detail.trim() : "it is not reachable";
  return (
    "My own model provider isn't answering that right now — " +
    `${reason}. I'm still KAI and my memory and state are available; ` +
    "ask me for status, what I remember, or what I can do, or tell me to retry."
  );
}

/** A stable reason code for a brain failure, for logs and the health surface. */
export function brainFailureReason(error: unknown): string {
  if (error instanceof ModelError) return error.kind;
  if (error instanceof Error) return error.message;
  return "unknown";
}

