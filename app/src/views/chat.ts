// Chat view — DOM port of PromptView / ChatBubble / TypingDotsView from
// IslandViewContent.swift, PLUS the shell's real Chat surface for the main
// window.
//
// The island's `buildPrompt` below is unchanged: it is the small companion
// prompt the island view map registers (`buildViews` in `views.ts`). The
// main-window surface is `mountChat`, a `PageFactory` the shell registers for
// the "chat" route. Both live here because they are the same feature at two
// sizes — the island's strip and the real window — and neither is a stub.

import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { Bridge, type ChatContext } from "../core/bridge";
import { Sound } from "../core/sound";
import { State, type ChatMessage } from "../core/state";
import type { ViewHost } from "./views";
import type { ShellContext, ShellPage, PageFactory } from "../shell/types";
import type { CoreSessionSummary, CoreToolCall } from "../core/kai-core";
import { describeToolCall } from "../chat/tool-card";
import type { CoreEventRow } from "../core/core-state";
import { sessionDisplayTitle } from "../chat/title";
import { chatActivity, activityLabel } from "../chat/activity";
import { StreamView } from "../chat/vendor/stream-view";
import * as Markdown from "../chat/vendor/markdown";
import { extractVisualBlocks, VISUAL_MARKER } from "../workspace/visual";
import { KaiVisualEngine } from "../visual/engine";
// KAI's own chat/sessions stylesheet (authored for this surface; no OpenGhost CSS).
import "../chat/chat.css";

let nextId = 1;

function bubble(message: ChatMessage): HTMLElement {
  if (message.role === "user") {
    return h(
      "div",
      { class: "chat-row user" },
      h("div", { class: "bubble", text: message.content }),
    );
  }
  return h("div", { class: "chat-row" }, h("div", { class: "reply", text: message.content }));
}

function typingDots(): HTMLElement {
  return h(
    "div",
    { class: "chat-row" },
    h("div", { class: "typing" }, h("i"), h("i"), h("i")),
  );
}

/** The coloured chip showing what the question is about (a dropped file). */
function contextChip(label: string): HTMLElement {
  const chip = h("div", { class: "chip" }, h("i", { class: "chip-dot" }), h("span", { text: label }));
  requestAnimationFrame(() => chip.classList.add("settled"));
  return chip;
}

export function buildPrompt(onHeightChange: () => void): ViewHost {
  const chipRow = h("div", { class: "chip-row" });
  const log = h("div", { class: "chat-log" });
  const input = h("input", {
    type: "text",
    class: "chat-input",
    placeholder: "Ask me anything…",
    spellcheck: "false",
  }) as HTMLInputElement;
  const send = h("button", { class: "send-btn", title: "Send" }, svg(ICONS.arrowUp, 11));
  const bar = h("div", { class: "chat-bar" }, input, send);

  const el = h(
    "div",
    { class: "view" },
    h("div", { class: "card wash chat-card" }, h("div", { class: "chat-body" }, chipRow, log, bar)),
  );
  (el.querySelector(".card") as HTMLElement).style.setProperty("--wash", "rgba(99,102,241,0.5)");

  let sending = false;
  let renderedCount = -1;
  // The history ARRAY itself, not just its length. A session switch swaps the array
  // (core-boot loads the session's turns and calls setChatHistory), so two different
  // sessions can hold the same number of messages — keying on the count alone kept
  // rendering the PREVIOUS session's log, which is how switching appeared to work
  // while still showing the wrong conversation.
  let renderedHistory: unknown = null;

  /** Repaint the chip row, the log and the input from the CURRENT state. */
  function paint(): void {
    const file = State.droppedFile;
    const wantChip = file?.name ?? "";
    if (chipRow.dataset.label !== wantChip) {
      chipRow.dataset.label = wantChip;
      clear(chipRow);
      if (wantChip) chipRow.append(contextChip(wantChip));
    }

    const thinking = State.runtime === "THINKING";
    const history = State.chatHistory;
    const count = history.length + (thinking ? 0.5 : 0);
    if (count !== renderedCount || history !== renderedHistory) {
      renderedCount = count;
      renderedHistory = history;
      clear(log);
      for (const m of history) log.append(bubble(m));
      if (thinking) log.append(typingDots());
      log.scrollTop = log.scrollHeight;
    }

    input.placeholder = State.chatHistory.length === 0 ? "Ask me anything…" : "Continue…";
    input.disabled = sending;
  }

  async function submit() {
    const query = input.value.trim();
    if (!query || sending) return;
    input.value = "";
    sending = true;
    Sound.play("send");

    State.chatHistory.push({ id: nextId++, role: "user", content: query });
    // A new turn clears the previous turn's failure: KAI is trying again, so the
    // old message is no longer what is happening.
    State.turnError = null;
    // A real user action: KAI is now thinking. The runtime machine turns this into
    // the THINKING state (and the character reflects it); the worker's own state
    // stays on the worker's pill.
    State.setRuntimeInput({ turnInFlight: true, composing: false, turnOutcome: null });
    State.notify();
    onHeightChange();

    const file = State.droppedFile;
    const context: ChatContext | null =
      State.chatHistory.length === 1 && file ? { kind: "file", name: file.name, path: file.path } : null;

    try {
      // The turn belongs to the ACTIVE KAI session, so it goes to that session's
      // own conversation. Sending no conversation id would let the turn fall to
      // whichever session the Core last used.
      const reply = await Bridge.chatSend(query, context, State.core.activeSessionId);
      State.chatHistory.push({ id: nextId++, role: "assistant", content: reply.text });
      State.setRuntimeInput({ turnInFlight: false, turnOutcome: "ok" });
      Sound.play("finish");
    } catch (err) {
      State.setRuntimeInput({ turnInFlight: false, turnOutcome: "error" });
      // The honest failure is KAI's OWN message about a real user action, so it goes
      // in `turnError`, not `noteMessage`. The Core link owns `noteMessage` and
      // rewrites it on every connection-state change and clears it on reconnect —
      // which is exactly what erased this message on screen before: the turn's
      // "I can't reach my Core" was replaced by a generic connection line and then
      // wiped to an empty card. `turnError` is KAI's and the note view renders it.
      State.turnError = String(err).replace(/^Error:\s*/, "");
      State.view = "note";
      Sound.play("error");
    } finally {
      sending = false;
      State.notify();
      onHeightChange();
      input.focus();
    }
  }

  send.addEventListener("click", () => void submit());
  input.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") {
      e.preventDefault();
      void submit();
    }
    e.stopPropagation(); // Escape closes the island, not the chat
  });
  // LISTENING is entered by a genuine local signal: the user is composing.
  input.addEventListener("input", () => {
    State.setRuntimeInput({ composing: input.value.trim().length > 0 });
  });
  input.addEventListener("blur", () => {
    State.setRuntimeInput({ composing: false });
  });

  // The island only calls `sync()` for the VISIBLE view (see island.ts syncDom), so
  // while the Sessions tab is up the chat view would keep the PREVIOUS session's
  // bubbles in the DOM. A session switch happens exactly then — the user clicks a
  // row's "Use" on the Sessions tab — so the log must repaint on the state change
  // itself, not only when the view is next shown. Without this the rendered history
  // disagreed with the active session until you navigated to Ask.
  State.subscribe(() => paint());

  return {
    el,
    sync: paint,
    focus() {
      input.focus();
      input.select();
    },
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// The shell's Chat surface — the main window's real conversation with KAI.
//
// One page: a comfortably large composer, the message list and its history,
// live streaming through the ported StreamView, KAI's own tool/worker activity
// as demoted metadata (KAI stays the speaker), visual output through a
// Core-validated intent, approvals and errors. Nothing here invents a turn:
// every user turn goes to `POST /chat` on the active session and what Core
// records is what is shown. `mountChat` is the ONE line the shell registers.
// ═════════════════════════════════════════════════════════════════════════════

interface ChatTurn {
  id: number;
  role: "user" | "assistant";
  text: string;
  /** The persisted tool calls that produced this turn — rendered, never invented. */
  tools?: CoreToolCall[];
}

/**
 * The tool card: what KAI actually ran this turn, from Core's persisted
 * record. A searching turn reads "KAI is searching your files…" while busy
 * (the thinking dots) and lands as "✓ filesystem.search — EXECUTED · 1 match".
 */
function toolCard(call: CoreToolCall): HTMLElement {
  const described = describeToolCall(call);
  return h(
    "div",
    { class: `kai-tool is-${call.status.toLowerCase()}` },
    h("span", { class: "kai-tool-glyph", text: described.glyph }),
    h("span", { class: "kai-tool-name", text: described.name }),
    h("span", { class: "kai-tool-status", text: described.status }),
    described.detail.length > 0 ? h("span", { class: "kai-tool-detail", text: described.detail }) : null,
  );
}

let chatSeq = 1;

/** Drop the visual-block markers the extractor leaves, so the prose reads clean. */
function proseWithoutMarkers(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.trim().startsWith(VISUAL_MARKER))
    .join("\n");
}

function assistantNode(): { node: HTMLElement; mdEl: HTMLElement } {
  const mdEl = h("div", { class: "kai-md" });
  const node = h(
    "div",
    { class: "kai-msg" },
    h("div", { class: "kai-avatar", text: "K" }),
    h("div", { class: "kai-turn" }, h("div", { class: "kai-speaker-name", text: "KAI" }), mdEl),
  );
  return { node, mdEl };
}

/** The shell page factory the integrator registers for the "chat" route. */
export const mountChat: PageFactory = (ctx: ShellContext): ShellPage => {
  const el = h("section", { class: "kai-page kai-chat-host" });
  el.style.padding = "0";
  el.style.overflow = "hidden";
  el.style.display = "flex";

  // ── header ────────────────────────────────────────────────────────────────
  const conn = h("span", { class: "kai-chat-conn", text: "connecting…" });
  const titleLine = h("span", { class: "kai-chat-title", text: "" });
  const newBtn = h("button", { class: "kai-btn", type: "button", text: "New session" });
  const sessionsBtn = h("button", { class: "kai-btn", type: "button", text: "Sessions" });
  const head = h(
    "header",
    { class: "kai-chat-head" },
    h("span", { class: "kai-chat-speaker", text: "KAI" }),
    titleLine,
    h("span", { class: "grow" }),
    conn,
    sessionsBtn,
    newBtn,
  );

  // Compact session digest under the header — the objective Core persisted,
  // so a resumed conversation says what it is about at a glance.
  const summaryLine = h("div", { class: "kai-chat-summary", text: "" });
  summaryLine.style.display = "none";

  const log = h("div", { class: "kai-chat-log" });

  // ── composer ──────────────────────────────────────────────────────────────
  const activity = h("div", { class: "kai-activity" });
  const approvals = h("div", { class: "kai-chat-approvals" });
  const input = h("textarea", {
    class: "kai-input",
    placeholder: "Talk to KAI…",
    rows: "3",
    spellcheck: "false",
  });
  const sendBtn = h("button", { class: "kai-send", type: "button", text: "Send" });
  const hint = h("div", { class: "kai-hint", text: "Enter to send · Shift+Enter for a new line" });
  const composer = h(
    "div",
    { class: "kai-composer" },
    activity,
    approvals,
    h("div", { class: "kai-composer-row" }, input, sendBtn),
    hint,
  );

  el.append(h("div", { class: "kai-chat" }, head, summaryLine, log, composer));

  // ── state ─────────────────────────────────────────────────────────────────
  let turns: ChatTurn[] = [];
  let busy = false;
  let active: CoreSessionSummary | null = null;
  let loadedSessionId: string | null = null;
  let firstUserText: string | undefined;
  let pendingApprovals: { id: string; toolId: string; action: string; reason: string; risk: string }[] = [];

  function scrollBottom(): void {
    log.scrollTop = log.scrollHeight;
  }

  // ── rendering helpers ─────────────────────────────────────────────────────
  async function drawVisual(container: HTMLElement, source: string): Promise<void> {
    const res = await ctx.client.visualCompile(source);
    if (!res.ok) {
      container.append(h("div", { class: "kai-error", text: res.error.message }));
      return;
    }
    if (res.value.ok) {
      const host = h("div", { class: "kai-visual-host" });
      container.append(host);
      new KaiVisualEngine(host).render(res.value.intent);
      scrollBottom();
      return;
    }
    // Core's validator REFUSED the source and named the offending field. The
    // refusal is surfaced verbatim; nothing is repaired and nothing is drawn.
    container.append(
      h("div", { class: "kai-error", text: `I couldn't draw that: ${res.value.reason} (${res.value.code})` }),
    );
  }

  function renderAssistantStatic(mdEl: HTMLElement, text: string): void {
    mdEl.innerHTML = Markdown.blocks(proseWithoutMarkers(text), { live: false }).join("");
    for (const src of extractVisualBlocks(text).blocks) void drawVisual(mdEl, src);
  }

  function renderAssistantLive(mdEl: HTMLElement, text: string): void {
    const view = new StreamView(mdEl, { onChange: scrollBottom });
    view.push(proseWithoutMarkers(text));
    void view.finish();
    for (const src of extractVisualBlocks(text).blocks) void drawVisual(mdEl, src);
  }

  function appendTurn(t: ChatTurn): void {
    if (t.role === "user") {
      log.append(
        h(
          "div",
          { class: "kai-msg is-user" },
          h("div", { class: "kai-turn" }, h("div", { class: "kai-bubble", text: t.text })),
        ),
      );
    } else {
      const { node, mdEl } = assistantNode();
      log.append(node);
      renderAssistantStatic(mdEl, t.text);
      // The persisted tool history renders as cards under the answer it
      // produced — the same cards a reloaded session shows.
      if (t.tools !== undefined) {
        const toolsEl = h("div", { class: "kai-tools" });
        for (const call of t.tools) toolsEl.append(toolCard(call));
        log.append(toolsEl);
      }
    }
  }

  function appendThinking(): HTMLElement {
    const node = h(
      "div",
      { class: "kai-msg" },
      h("div", { class: "kai-avatar", text: "K" }),
      h("div", { class: "kai-turn" }, h("span", { class: "kai-thinking" }, h("i"), h("i"), h("i"))),
    );
    log.append(node);
    scrollBottom();
    return node;
  }

  function appendError(msg: string): void {
    log.append(
      h("div", { class: "kai-msg" }, h("div", { class: "kai-turn" }, h("div", { class: "kai-error", text: msg }))),
    );
    scrollBottom();
  }

  function renderAll(): void {
    clear(log);
    for (const t of turns) appendTurn(t);
    scrollBottom();
  }

  // ── activity (tool / worker / mission / approval), KAI as the speaker ──────
  function renderActivity(): void {
    const rows = chatActivity(
      ctx.workspace.getState().events.map((e) => ({
        ...(e.id !== undefined ? { id: e.id } : {}),
        type: e.type,
        at: e.at,
        // `line` is KAI's own sentence (presenter.ts) — the worker is demoted
        // inside it, never the subject. This is what keeps the activity strip
        // from becoming "Hermes: I'm researching…".
        text: e.line,
      })) as CoreEventRow[],
      3,
    );
    clear(activity);
    if (rows.length === 0) {
      activity.style.display = "none";
      return;
    }
    activity.style.display = "";
    for (const r of rows) {
      activity.append(
        h(
          "div",
          { class: `kai-activity-row is-${r.kind}` },
          h("span", { class: "tag", text: activityLabel(r.kind) }),
          h("span", { class: "kai-activity-text", text: r.text }),
        ),
      );
    }
  }

  // ── approvals ─────────────────────────────────────────────────────────────
  function renderApprovals(): void {
    clear(approvals);
    if (pendingApprovals.length === 0) {
      approvals.style.display = "none";
      return;
    }
    approvals.style.display = "";
    for (const a of pendingApprovals) {
      approvals.append(
        h(
          "div",
          { class: "kai-approval" },
          h("div", { class: "ap-title", text: `KAI needs your approval — ${a.toolId}` }),
          h("div", { class: "ap-meta", text: `${a.risk} · ${a.action}` }),
          a.reason.length > 0 ? h("div", { class: "ap-code", text: a.reason }) : null,
          h(
            "div",
            { class: "ap-actions" },
            h("button", {
              class: "kai-btn is-danger",
              type: "button",
              text: "Refuse",
              onclick: () => void decide(a.id, false),
            }),
            h("button", {
              class: "kai-btn is-primary",
              type: "button",
              text: "Allow",
              onclick: () => void decide(a.id, true),
            }),
          ),
        ),
      );
    }
  }

  async function refreshApprovals(): Promise<void> {
    const res = await ctx.client.approvals({ status: "PENDING" });
    if (!res.ok) return;
    pendingApprovals = res.value.map((a) => ({
      id: a.id,
      toolId: a.toolId,
      action: a.action,
      reason: a.reason,
      risk: a.risk,
    }));
    renderApprovals();
  }

  async function decide(id: string, approved: boolean): Promise<void> {
    const res = await ctx.client.decideApproval(id, approved);
    if (!res.ok) appendError(res.error.reason ?? res.error.message);
    await refreshApprovals();
  }

  // ── header ────────────────────────────────────────────────────────────────
  function renderHeader(): void {
    const current = ctx.workspace.getState().conn;
    conn.textContent =
      current === "ONLINE"
        ? "connected"
        : current === "OFFLINE"
          ? "Core offline"
          : current === "DEGRADED"
            ? "degraded"
            : "connecting…";
    conn.classList.toggle("is-on", current === "ONLINE");
    conn.classList.toggle("is-off", current === "OFFLINE");

    if (active === null) {
      titleLine.textContent = "no session yet — your next message starts one";
      summaryLine.style.display = "none";
      summaryLine.textContent = "";
      return;
    }
    const shown = sessionDisplayTitle(active.title, firstUserText);
    const turnsLabel = active.turnCount !== undefined ? ` · ${active.turnCount} turn(s)` : "";
    titleLine.textContent = `${shown.title}${turnsLabel}`;
    // The persisted digest, compact: objective first, tools/files only when
    // they add meaning. Absent until the first turn — nothing is guessed.
    const digest = active.summary;
    const excerpt =
      digest !== undefined && digest.objective.length > 0
        ? digest.toolsUsed.length > 0
          ? `${digest.objective} · used ${digest.toolsUsed.join(", ")}`
          : digest.objective
        : "";
    summaryLine.textContent = excerpt;
    summaryLine.style.display = excerpt.length > 0 ? "" : "none";
  }

  // ── loading ───────────────────────────────────────────────────────────────
  async function loadHistory(id: string): Promise<void> {
    const res = await ctx.client.sessionTurns(id, { limit: 200 });
    if (!res.ok) return;
    // `tools` ride along from Core's transcript — a reloaded session shows the
    // same tool cards the live turn showed. Nothing is reconstructed locally.
    turns = res.value
      .filter((t) => t.role === "user" || t.role === "assistant")
      .map((t) => ({
        id: chatSeq++,
        role: t.role as "user" | "assistant",
        text: t.text,
        ...(t.tools !== undefined && t.tools.length > 0 ? { tools: t.tools } : {}),
      }));
    loadedSessionId = id;
    firstUserText = turns.find((t) => t.role === "user")?.text;
    renderHeader();
    renderAll();
  }

  async function refreshActive(): Promise<void> {
    const res = await ctx.client.activeSession();
    if (!res.ok) {
      renderHeader();
      return;
    }
    active = res.value;
    if (active !== null && active.id !== loadedSessionId) {
      await loadHistory(active.id);
      return;
    }
    renderHeader();
  }

  // ── sending ───────────────────────────────────────────────────────────────
  async function send(): Promise<void> {
    const text = input.value.trim();
    if (text.length === 0 || busy) return;
    input.value = "";
    autosize();
    busy = true;
    sendBtn.disabled = true;

    const userTurn: ChatTurn = { id: chatSeq++, role: "user", text };
    turns.push(userTurn);
    appendTurn(userTurn);
    scrollBottom();

    const thinking = appendThinking();
    try {
      // The ONE path to a turn: POST /chat, explicitly on the session the user
      // is looking at. KAI Core classifies it, answers as itself or performs
      // a delegation, and records the turn — never a frontend-only fake reply.
      const res = await ctx.client.chat(text, active?.id ?? undefined);
      thinking.remove();
      if (res.ok) {
        const reply = res.value.reply;
        const assistantTurn: ChatTurn = {
          id: chatSeq++,
          role: "assistant",
          text: reply,
          ...(res.value.toolCalls !== undefined && res.value.toolCalls.length > 0
            ? { tools: res.value.toolCalls }
            : {}),
        };
        turns.push(assistantTurn);
        const { node, mdEl } = assistantNode();
        log.append(node);
        renderAssistantLive(mdEl, reply);
        if (assistantTurn.tools !== undefined) {
          const toolsEl = h("div", { class: "kai-tools" });
          for (const call of assistantTurn.tools) toolsEl.append(toolCard(call));
          log.append(toolsEl);
        }
        scrollBottom();
        void refreshApprovals();
        void refreshActive();
      } else {
        appendError(res.error.reason ?? res.error.message);
      }
    } catch (err) {
      thinking.remove();
      appendError(err instanceof Error ? err.message : String(err));
    } finally {
      busy = false;
      sendBtn.disabled = false;
      input.focus();
    }
  }

  // ── new session ───────────────────────────────────────────────────────────
  async function newSession(): Promise<void> {
    const created = await ctx.client.createSession({});
    if (!created.ok) {
      appendError(created.error.reason ?? created.error.message);
      return;
    }
    const activated = await ctx.client.activateSession(created.value.id);
    if (!activated.ok) {
      appendError(activated.error.reason ?? activated.error.message);
      return;
    }
    loadedSessionId = null;
    await refreshActive();
  }

  // ── composer wiring ───────────────────────────────────────────────────────
  function autosize(): void {
    input.style.height = "auto";
    const max = Math.round(window.innerHeight * 0.4);
    input.style.height = `${Math.min(Math.max(input.scrollHeight, 76), max)}px`;
  }
  input.addEventListener("input", autosize);
  input.addEventListener("keydown", (e) => {
    const ke = e as KeyboardEvent;
    if (ke.key === "Enter" && !ke.shiftKey) {
      ke.preventDefault();
      void send();
    }
    ke.stopPropagation();
  });
  sendBtn.addEventListener("click", () => void send());
  newBtn.addEventListener("click", () => void newSession());
  sessionsBtn.addEventListener("click", () => ctx.navigate("sessions"));

  // ── live wiring ───────────────────────────────────────────────────────────
  const unsubscribe = ctx.workspace.subscribe(() => {
    renderActivity();
    renderHeader();
  });

  function boot(): void {
    renderActivity();
    renderApprovals();
    autosize();
    void refreshActive();
    void refreshApprovals();
  }
  boot();

  return {
    el,
    sync(): void {
      renderActivity();
      void refreshActive().then(() => input.focus());
      void refreshApprovals();
    },
    destroy(): void {
      unsubscribe();
    },
  };
};
