/**
 * agents/chat.ts — the direct chat with ONE persona, on its OWN session.
 *
 * Every turn is `POST /subagents/:id/message`: the ONE policy-governed run, AS
 * the persona, and Core records the persona's AUTHORED reply on the persona's own
 * session (never KAI's). When the run is EXTERNAL it parks; this panel says so and
 * offers Allow / Refuse — approving re-issues with the approval id. It is never a
 * Bash panel and never a frontend-only fake reply.
 */

import { el, clear, button, muted } from "./ui";
import type { AgentsStore } from "./store";

function bubble(role: "user" | "assistant", text: string, failed: boolean): HTMLElement {
  const mine = role === "user";
  return el(
    "div",
    { style: `display:flex;justify-content:${mine ? "flex-end" : "flex-start"}` },
    el("div", {
      text,
      style:
        `max-width:78%;padding:8px 11px;border-radius:12px;font:400 12.5px var(--font,system-ui);` +
        `white-space:pre-wrap;overflow-wrap:anywhere;` +
        (mine
          ? `background:${failed ? "rgba(244,80,94,0.18)" : "rgba(99,102,241,0.24)"};color:#eef0f4;`
          : "background:rgba(255,255,255,0.06);color:#e7e9ee;"),
    }),
  );
}

export interface AgentChatHandle {
  el: HTMLElement;
  focus(): void;
  destroy(): void;
}

export function renderAgentChat(store: AgentsStore): AgentChatHandle {
  const sessionLine = el("span", { style: "font:400 10.5px var(--font,system-ui);color:#8b93a1" });
  const newSessionBtn = button("New session", "ghost", () => void store.newSession());

  const log = el("div", {
    style:
      "flex:1 1 auto;min-height:120px;overflow-y:auto;display:flex;flex-direction:column;gap:8px;" +
      "padding:10px;border:1px solid rgba(255,255,255,0.08);border-radius:10px;background:rgba(0,0,0,0.16)",
  });

  const pendingBox = el("div", { style: "display:none" });
  const noticeLine = el("div", { style: "font:400 11px var(--font,system-ui);min-height:14px" });

  const inputField = el("input", {
    type: "text",
    placeholder: "Ask this persona…",
    spellcheck: "false",
    style:
      "flex:1 1 auto;min-width:0;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.14);" +
      "border-radius:8px;color:inherit;font:400 12.5px var(--font,system-ui);padding:8px 10px",
  }) as HTMLInputElement;
  const sendBtn = button("Send", "primary", () => void submit());

  const assignField = el("input", {
    type: "text",
    placeholder: "Assign a task (runs as this persona, parks for approval)…",
    spellcheck: "false",
    style:
      "flex:1 1 auto;min-width:0;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.14);" +
      "border-radius:8px;color:inherit;font:400 12px var(--font,system-ui);padding:7px 10px",
  }) as HTMLInputElement;

  const el0 = el(
    "div",
    { class: "kai-agents-chat", style: "display:flex;flex-direction:column;gap:8px;min-width:0;height:100%" },
    el(
      "div",
      { style: "display:flex;align-items:center;gap:8px" },
      el("span", { text: "Direct chat", style: "font:600 12px var(--font,system-ui);color:var(--ink,#f5f6f8)" }),
      sessionLine,
      el("div", { style: "flex:1 1 auto" }),
      newSessionBtn,
    ),
    log,
    pendingBox,
    noticeLine,
    el("div", { style: "display:flex;gap:8px" }, inputField, sendBtn),
    el(
      "div",
      { style: "display:flex;gap:8px" },
      assignField,
      button("Assign", "secondary", () => void assign()),
    ),
  );

  let renderedKey = "";
  let renderedPending = "";

  async function submit(): Promise<void> {
    const text = inputField.value.trim();
    if (text.length === 0) return;
    inputField.value = "";
    await store.send(text);
  }

  async function assign(): Promise<void> {
    const text = assignField.value.trim();
    if (text.length === 0) return;
    assignField.value = "";
    await store.assignTask(text);
  }

  inputField.addEventListener("keydown", (e) => {
    const ke = e as KeyboardEvent;
    if (ke.key === "Enter") {
      ke.preventDefault();
      void submit();
    }
    ke.stopPropagation();
  });
  inputField.addEventListener("input", () => store.clearNotice());
  assignField.addEventListener("keydown", (e) => {
    const ke = e as KeyboardEvent;
    if (ke.key === "Enter") {
      ke.preventDefault();
      void assign();
    }
    ke.stopPropagation();
  });

  function render(): void {
    const s = store.getState();
    const agentKey = `${s.selectedId}#${s.chatSessionId}#${s.chat.length}#${s.busy ? 1 : 0}#${
      s.chat.length > 0 ? s.chat[s.chat.length - 1]?.text : ""
    }`;
    if (agentKey !== renderedKey) {
      renderedKey = agentKey;
      clear(log);
      if (s.chat.length === 0) {
        log.append(
          muted("No turns on this persona's own session yet. The reply you get is authored by the persona, not by KAI."),
        );
      } else {
        for (const m of s.chat) log.append(bubble(m.role, m.text, m.failed === true));
      }
      if (s.busy && s.pending === null) log.append(muted("Working…"));
      log.scrollTop = log.scrollHeight;
    }

    const sessionLabel = s.chatSessionId !== null ? `session ${s.chatSessionId}` : "no session yet";
    if (sessionLine.textContent !== sessionLabel) sessionLine.textContent = sessionLabel;

    const pendingKey = s.pending !== null ? `${s.pending.approvalId}#${s.busy ? 1 : 0}` : "";
    if (pendingKey !== renderedPending) {
      renderedPending = pendingKey;
      clear(pendingBox);
      pendingBox.style.display = s.pending === null ? "none" : "";
      if (s.pending !== null) {
        pendingBox.append(
          el(
            "div",
            {
              style:
                "display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:10px;" +
                "background:rgba(245,165,36,0.14);border:1px solid rgba(245,165,36,0.35)",
            },
            el("span", { text: "⏸", style: "color:#f5a524" }),
            el("span", {
              text: `Waiting for your approval — ${s.pending.reason}`,
              style: "flex:1 1 auto;font:400 11px var(--font,system-ui);color:#f2d9a8",
            }),
            button("Refuse", "danger", () => void store.denyPending()),
            button(s.busy ? "Working…" : "Allow & send", "primary", () => void store.approvePending()),
          ),
        );
      }
    }

    const notice = s.notice;
    noticeLine.textContent = notice?.text ?? "";
    noticeLine.style.color =
      notice?.kind === "ok" ? "#34d399" : notice?.kind === "error" ? "#f4505e" : notice?.kind === "warn" ? "#f5a524" : "";
    inputField.disabled = s.busy || s.selectedId === null;
    sendBtn.disabled = inputField.disabled;
    assignField.disabled = s.selectedId === null;
  }

  const unsubscribe = store.subscribe(render);
  render();

  return {
    el: el0,
    focus: () => inputField.focus(),
    destroy: () => unsubscribe(),
  };
}
