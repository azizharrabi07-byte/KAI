/**
 * agents/page.ts — one persona's full page.
 *
 * The owner's facets, each read from the REAL Core record:
 *   identity · soul · personality · worker · capabilities · memory scope ·
 *   appearance · sessions · permissions
 *
 * Actions are all real Core calls (via the store): Edit, Duplicate, Archive /
 * Restore, and — inside the chat — Assign work, Allow/Refuse, Retry. Delete is
 * shown DISABLED with the honest reason: Core exposes no hard delete for a
 * persona; Archiving is the lifecycle it does expose.
 */

import { el, clear, button, section, fieldRow, chip, dot, spacer, muted, input } from "./ui";
import { findPreset, describeVariant } from "../character/variant";
import { renderAgentChat, type AgentChatHandle } from "./chat";
import type { AgentsStore } from "./store";
import type { Subagent } from "./api";

export interface AgentPageCallbacks {
  onBack(): void;
  onEdit(agent: Subagent): void;
}

function visualOf(sub: Subagent): { primary: string; secondary: string; label: string } {
  const declared = (sub.visual?.declared ?? {}) as Record<string, unknown>;
  const variantId = typeof declared.variant === "string" ? declared.variant : undefined;
  const preset = variantId !== undefined ? findPreset(variantId) : undefined;
  const colour = typeof declared.colour === "string" ? declared.colour : undefined;
  const primary = preset?.primaryColor ?? colour ?? "#8B93A1";
  const secondary = preset?.secondaryColor ?? primary;
  const bits: string[] = [];
  if (typeof declared.outfit === "string") bits.push(`${declared.outfit} outfit`);
  if (typeof declared.skin === "string") bits.push(`${declared.skin} skin`);
  if (Array.isArray(declared.accessories) && declared.accessories.length > 0) {
    bits.push(declared.accessories.filter((a): a is string => typeof a === "string").join("/"));
  }
  const label =
    preset !== undefined ? describeVariant(preset)
      : bits.length > 0 ? `${sub.name} — ${bits.join(" · ")}`
        : "no declared visual variant";
  return { primary, secondary, label };
}

export interface AgentPageHandle {
  el: HTMLElement;
  focusChat(): void;
  destroy(): void;
}

export function renderAgentPage(store: AgentsStore, cb: AgentPageCallbacks): AgentPageHandle {
  const chat: AgentChatHandle = renderAgentChat(store);

  // ── header + actions (rebuilt when the persona changes) ──────────────────────
  const header = el("div", { style: "display:flex;flex-direction:column;gap:12px" });
  const left = el("div", {
    class: "kai-agents-detail",
    style: "display:flex;flex-direction:column;gap:18px;min-width:0;overflow-y:auto;padding-right:6px",
  });
  left.append(header);

  const el0 = el(
    "div",
    {
      class: "kai-agents-page",
      style: "display:grid;grid-template-columns:minmax(0,1fr) minmax(320px,0.9fr);gap:20px;height:100%;min-height:0",
    },
    left,
    el("div", { style: "min-width:0;height:100%;min-height:0" }, chat.el),
  );

  // ── duplicate: a tiny inline form ────────────────────────────────────────────
  const dupBox = el("div", { style: "display:none;gap:6px;align-items:center" });
  const dupId = input("new id, e.g. researcher-2");
  const dupName = input("optional new name");
  dupBox.append(dupId, dupName);

  let builtFor = "";

  function buildHeader(sub: Subagent): HTMLElement {
    const vis = visualOf(sub);
    const archived = !sub.enabled;
    const head = el("div", { style: "display:flex;align-items:center;gap:10px;min-width:0" });
    head.append(
      button("‹ All agents", "ghost", () => cb.onBack()),
      dot(vis.primary, 14),
      el("span", {
        text: sub.name,
        style: "font:600 22px var(--font,system-ui);color:var(--ink,#f5f6f8);white-space:nowrap;overflow:hidden;text-overflow:ellipsis",
      }),
      el("span", { text: `· ${sub.role}`, style: "font:400 13px var(--font,system-ui);color:#8b93a1" }),
      spacer(),
      chip(
        archived ? "ARCHIVED" : sub.activity === "awaiting approval" ? "AWAITING APPROVAL" : sub.status,
        archived ? "#8b93a1" : sub.activity === "awaiting approval" ? "#f5a524" : "#34d399",
      ),
    );

    const actions = el("div", { style: "display:flex;gap:8px;flex-wrap:wrap;align-items:center" });
    actions.append(
      button("Chat", "primary", () => chat.focus()),
      button("Edit", "secondary", () => cb.onEdit(sub)),
      button("Duplicate", "secondary", () => {
        dupBox.style.display = dupBox.style.display === "none" ? "flex" : "none";
        if (dupBox.style.display === "flex") {
          dupId.value = `${sub.id}-copy`;
          dupName.value = `${sub.name} (copy)`;
        }
      }),
      archived
        ? button("Restore", "secondary", () => void store.unarchive(sub.id))
        : button("Archive", "secondary", () => void store.archive(sub.id)),
      el("button", {
        type: "button",
        text: "Delete",
        title: "Core exposes no hard delete for a persona — Archive disables it instead.",
        disabled: true,
        style:
          "font:500 12px var(--font,system-ui);padding:6px 11px;border-radius:8px;cursor:not-allowed;" +
          "background:transparent;color:#5b616b;border:1px solid rgba(255,255,255,0.08)",
      }),
    );

    const dupRow = el(
      "div",
      { style: "display:flex;gap:8px;align-items:center" },
      dupBox,
      button("Confirm", "secondary", async () => {
        const nextId = dupId.value.trim();
        if (nextId.length === 0) return;
        const name = dupName.value.trim();
        const done = await store.duplicate(sub.id, { id: nextId, ...(name.length > 0 ? { name } : {}) });
        if (done) {
          dupBox.style.display = "none";
          await store.select(nextId);
        }
      }),
    );

    return el("div", { style: "display:flex;flex-direction:column;gap:10px" }, head, actions, dupRow);
  }

  function buildSections(sub: Subagent): HTMLElement[] {
    const vis = visualOf(sub);
    const detail = store.getState().detail;
    const sessions = detail?.sessions ?? [];
    const pending = store.getState().pending;

    const identity = section(
      "Identity",
      fieldRow("id", sub.id),
      fieldRow("employee", sub.employeeId),
      fieldRow("status", `${sub.status}${sub.enabled ? "" : " · archived"}`),
      fieldRow("activity", sub.currentTask !== null ? `${sub.activity} — ${sub.currentTask}` : sub.activity),
      fieldRow("worker", `${sub.workerId}${sub.model !== undefined ? ` · ${sub.model}` : ""}`),
      ...(sub.instanceId !== undefined ? [fieldRow("instance", sub.instanceId)] : []),
      ...(sub.createdAt.length > 0 ? [fieldRow("created", new Date(sub.createdAt).toLocaleString())] : []),
    );

    const soul = section(
      "Soul",
      sub.soul.length > 0
        ? el("p", { text: sub.soul, style: "margin:0;font:400 12.5px var(--font,system-ui);color:#d5d8de;white-space:pre-wrap" })
        : muted("No soul recorded."),
    );

    const objective = section(
      "Objective — what this agent is responsible for",
      sub.objective !== undefined && sub.objective.length > 0
        ? el("p", { text: sub.objective, style: "margin:0;font:400 12.5px var(--font,system-ui);color:#d5d8de;white-space:pre-wrap" })
        : muted("No objective set — edit the agent to give it one."),
    );

    const instructions = section(
      "System instructions — how it behaves",
      sub.instructions !== undefined && sub.instructions.length > 0
        ? el("p", { text: sub.instructions, style: "margin:0;font:400 12.5px var(--font,system-ui);color:#d5d8de;white-space:pre-wrap" })
        : muted("No custom instructions — the soul and role drive it."),
    );

    const personality = section(
      "Personality",
      fieldRow("role", sub.role),
      muted("In KAI a persona's personality IS its soul — the text Core carries into its turns. Below is how it presents."),
      fieldRow("presents as", `${vis.label} · runs on ${sub.workerId}`),
    );

    const caps = section(
      "Capabilities",
      sub.capabilities.length > 0
        ? el(
            "div",
            { style: "display:flex;flex-wrap:wrap;gap:6px" },
            ...sub.capabilities.map((c) => chip(c, "#6366f1")),
          )
        : muted("No capabilities granted — it can still be handed a task, but reaches no tool."),
    );

    const memory = section(
      "Memory scope",
      fieldRow("own bucket", el("code", { text: sub.employeeId, style: "font:400 11.5px var(--mono,monospace);color:#8b93a1" })),
      muted("This persona's turns and memory stay in its own bucket; they never merge into KAI's."),
    );

    const declared = (sub.visual?.declared ?? {}) as Record<string, unknown>;
    const appearance = section(
      "Appearance",
      el("div", { style: "display:flex;align-items:center;gap:8px" }, dot(vis.primary, 12), dot(vis.secondary, 8), muted(vis.label)),
      ...(typeof declared.colour === "string" ? [fieldRow("colour", declared.colour)] : []),
      ...(typeof declared.outfit === "string" ? [fieldRow("outfit", declared.outfit)] : []),
      ...(Array.isArray(declared.accessories) ? [fieldRow("accessories", (declared.accessories as string[]).join(", "))] : []),
    );

    const sessionRows = el("div", { style: "display:flex;flex-direction:column;gap:6px" });
    if (sessions.length === 0) {
      sessionRows.append(muted("No sessions of its own yet."));
    } else {
      const current = store.getState().chatSessionId;
      for (const s of sessions.slice(0, 12)) {
        sessionRows.append(
          el(
            "div",
            { style: "display:flex;align-items:center;gap:8px;min-width:0" },
            dot(s.id === current ? "#34d399" : s.status === "ARCHIVED" ? "#6b7280" : "#8b93a1", 7),
            el("span", {
              text: s.title,
              style: `flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:${
                s.id === current ? 600 : 400
              } 12px var(--font,system-ui);color:var(--ink,#f5f6f8)`,
            }),
            muted(`${s.turnCount ?? 0} turn(s) · ${s.status.toLowerCase()}`),
            s.id === current ? chip("open", "#34d399") : button("Open", "ghost", () => void store.openSession(s.id)),
          ),
        );
      }
    }
    const sessionsSec = section("Sessions", sessionRows, button("New session", "secondary", () => void store.newSession()));

    const permRows = el("div", { style: "display:flex;flex-direction:column;gap:6px" });
    permRows.append(
      fieldRow("delegate", sub.enabled ? "allowed" : "not allowed (archived)"),
      fieldRow(
        "grants",
        sub.capabilities.length > 0 ? `${sub.capabilities.join(", ")}` : "none — no tool reach",
      ),
    );
    if (pending !== null) {
      permRows.append(
        el(
          "div",
          { style: "display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:8px;background:rgba(245,165,36,0.14)" },
          chip("PARKED", "#f5a524"),
          muted(pending.reason),
        ),
      );
    } else {
      permRows.append(muted("Nothing parked for this persona right now."));
    }
    const permissions = section("Permissions", permRows);

    return [identity, soul, objective, instructions, personality, caps, memory, appearance, sessionsSec, permissions];
  }

  function render(): void {
    const s = store.getState();
    const sub = s.detail?.subagent ?? s.agents.find((a) => a.id === s.selectedId) ?? null;
    if (sub === null) {
      clear(header);
      header.append(muted("Select a persona."));
      return;
    }
    // Rebuild the header/lists when the persona or its key facts change.
    const key = [
      sub.id, sub.name, sub.role, sub.status, String(sub.enabled), sub.activity,
      sub.currentTask ?? "", sub.soul, sub.capabilities.join(","), sub.workerId,
      (s.detail?.sessions ?? []).map((x) => `${x.id}:${x.status}:${x.turnCount ?? 0}`).join("|"),
      s.chatSessionId ?? "", s.pending?.approvalId ?? "", s.busy ? "b" : "",
    ].join("§");
    if (key !== builtFor) {
      builtFor = key;
      clear(header);
      header.append(buildHeader(sub));
      clear(left);
      left.append(header, ...buildSections(sub));
    }
  }

  const unsubscribe = store.subscribe(render);
  render();

  return {
    el: el0,
    focusChat: () => chat.focus(),
    destroy: () => {
      unsubscribe();
      chat.destroy();
    },
  };
}
