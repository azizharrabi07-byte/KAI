// Integration cards shown in the overview's left card — DOM ports of
// IntegrationCardView and friends from IslandViewContent.swift.
//
// Cal.com is the one simplification: macOS shows a three-level calendar
// (month → day → booking); here it is the list of upcoming bookings.

import { h, svg, clear, dot } from "./dom";
import { ICONS } from "./icons";
import { State, WORKFORCE_INTEGRATION_IDS, type AgentTask } from "../core/state";
import { Bridge } from "../core/bridge";

// `timeAgo` lives in ../core/timeAgo so it can be unit-tested without a DOM, and
// so its unit handling (Hermes reports seconds, OpenCode milliseconds) is
// documented in one place instead of per call site.
import { timeAgo } from "../core/timeAgo";

export { timeAgo };

function header(color: string, name: string, kind: string, extra?: Node): HTMLElement {
  const row = h("div", { class: "int-head" }, dot(color, 7), h("b", { text: name }), h("span", { text: kind }));
  if (extra) row.append(extra);
  return row;
}

/** Highlighted first row + plain rows, the layout every list card shares. */
function listRow(accent: string, first: boolean, ...children: Node[]): HTMLElement {
  const row = h("div", { class: first ? "int-row first" : "int-row" }, dot(accent, 5), ...children);
  if (first) row.style.background = `${accent}14`;
  return row;
}

function get(id: string): Record<string, unknown> {
  return (State.integrations[id]?.data ?? {}) as Record<string, unknown>;
}

function arr(id: string, key: string): Record<string, unknown>[] {
  const v = get(id)[key];
  return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
}

// ── Not configured / idle ─────────────────────────────────────────────────────

const OPEN_URLS: Record<string, string> = {
  integration_resend: "https://resend.com/emails",
  integration_vercel: "https://vercel.com/dashboard",
  integration_github: "https://github.com",
  integration_stripe: "https://dashboard.stripe.com/payments",
  integration_notion: "https://notion.so",
  integration_calcom: "https://app.cal.com/bookings",
};

function idleCard(task: AgentTask, openSettings: () => void): HTMLElement {
  const info = State.integrations[task.id];
  const configured = info?.configured ?? false;
  const error = info?.error ?? null;
  // The Claude Code pill is about hooks, not a key — the macOS wording would be
  // misleading here.
  const missing = task.id === "integration_claude" ? "Hooks not installed" : "Key not configured";
  const label = error ?? (configured ? "Connected · loading…" : missing);
  const statusColor = error || !configured ? "#F4505E" : "#22C55E";

  const actions = h("div", { class: "int-actions" });
  if (task.id === "integration_claude") {
    actions.append(
      h("button", {
        class: "link-btn",
        style: `color:${task.color}b3`,
        text: "Open Visual Studio Code",
        onclick: () => void Bridge.openInVSCode(task.sessionCwd ?? null),
      }),
    );
  } else if (task.id === "integration_n8n") {
    actions.append(
      h("button", {
        class: "link-btn",
        style: `color:${task.color}d9`,
        text: "Open n8n",
        onclick: () => void Bridge.openN8n(),
      }),
    );
  } else if (OPEN_URLS[task.id]) {
    actions.append(
      h("button", {
        class: "link-btn",
        style: `color:${task.color}d9`,
        text: `Open ${task.name}`,
        onclick: () => void Bridge.openUrl(OPEN_URLS[task.id]),
      }),
    );
  }
  if (configured) {
    actions.append(
      h("button", {
        class: "link-btn",
        style: `color:${task.color}d9`,
        text: "Refresh",
        onclick: () => void Bridge.refreshIntegration(task.id),
      }),
    );
  } else {
    actions.append(
      h("button", { class: "link-btn", style: "color:#8e939c", text: "Settings…", onclick: openSettings }),
    );
  }

  return h(
    "div",
    { class: "int-card" },
    header(task.color, task.id === "integration_claude" ? "VS Code" : task.name, "Integration"),
    h("div", { class: "int-status" }, dot(statusColor, 5), h("span", { text: label })),
    actions,
  );
}

// ── Vercel ────────────────────────────────────────────────────────────────────

function vercelCard(onDetail: () => void): HTMLElement {
  const deployments = arr("integration_vercel", "deployments");
  const rows = h("div", { class: "int-rows" });
  deployments.slice(0, 3).forEach((d, i) => {
    const accent = d.state === "READY" ? "#22C55E" : "#F4505E";
    const name = h("span", { class: "int-name", text: String(d.projectName ?? "") });
    const ago = h("span", { class: "int-ago", text: timeAgo(d.createdAt) });
    if (i === 0) {
      const more = h(
        "button",
        { class: "int-more", title: "Details", onclick: onDetail },
        svg(ICONS.ellipsis, 8),
      );
      rows.append(listRow(accent, true, name, ago, more));
    } else {
      rows.append(listRow(accent, false, name, ago));
    }
  });
  return h("div", { class: "int-card" }, header("#7C5CFF", "Vercel", "Deployments"), rows);
}

function vercelDetail(onBack: () => void): HTMLElement {
  const d = arr("integration_vercel", "deployments")[0] ?? {};
  const success = d.state === "READY";
  const accent = success ? "#22C55E" : "#F4505E";
  const status = success ? "Ready" : d.state === "CANCELED" ? "Canceled" : "Error";
  const body = h("div", { class: "int-detail-body" });
  if (d.commitMessage) body.append(h("div", { class: "int-commit", text: String(d.commitMessage) }));
  const meta = h("div", { class: "int-meta" });
  if (d.branch) meta.append(h("span", { text: String(d.branch) }));
  // Only render the age when there is one: `timeAgo` returns "" for a missing
  // timestamp (a NULL `created_at` arrives as 0.0 from the Rust side), and the
  // bare template below would otherwise print " ago" with nothing in front of it.
  const deployedAgo = timeAgo(d.createdAt);
  if (deployedAgo) meta.append(h("span", { text: `${deployedAgo} ago` }));
  body.append(meta);
  if (d.url) {
    body.append(
      h("button", {
        class: "int-link",
        text: String(d.url),
        onclick: () => void Bridge.openUrl(`https://${d.url}`),
      }),
    );
  }
  return h(
    "div",
    { class: "int-card detail" },
    h(
      "div",
      { class: "int-detail-head" },
      h("button", { class: "int-back", onclick: onBack }, svg(ICONS.chevronLeft, 10, { stroke: 2.4 })),
      dot(accent, 6),
      h("b", { text: String(d.projectName ?? "Deployment") }),
      h("span", { class: "int-badge", style: `color:${accent};background:${accent}24`, text: status }),
    ),
    body,
  );
}

// ── Resend ────────────────────────────────────────────────────────────────────

function resendCard(): HTMLElement {
  const emails = arr("integration_resend", "emails");
  const total = get("integration_resend").total;
  const extra =
    total != null
      ? h("span", { class: "int-total" }, h("i", { class: "pulse" }), h("span", { text: String(total) }))
      : undefined;
  const rows = h("div", { class: "int-rows" });
  emails.slice(0, 3).forEach((e, i) => {
    const delivered = e.lastEvent === "delivered";
    const accent = delivered ? "#22C55E" : "#F4505E";
    const to = Array.isArray(e.to) ? String(e.to[0] ?? "?") : "?";
    const short = to.split("@")[0];
    const cells: Node[] = [
      h("span", { class: "int-name", text: short }),
      h("span", { class: "int-ago", text: timeAgo(e.createdAt) }),
    ];
    if (i === 0 && e.subject) cells.push(h("span", { class: "int-sub", text: String(e.subject) }));
    rows.append(listRow(accent, i === 0, ...cells));
  });
  return h("div", { class: "int-card" }, header("#22C55E", "Resend", "Emails", extra), rows);
}

// ── GitHub ────────────────────────────────────────────────────────────────────

function statRow(icon: string, color: string, label: string, value: string): HTMLElement {
  return h(
    "div",
    { class: "int-stat" },
    h("i", { class: "int-stat-icon", style: `color:${color}` }, svg(icon, 10)),
    h("span", { class: "int-stat-label", text: label }),
    h("span", { class: "int-stat-value", text: value }),
  );
}

function githubCard(): HTMLElement {
  const d = get("integration_github");
  const stars = Number(d.totalStars ?? 0);
  const repos = Number(d.totalRepos ?? 0);
  const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  return h(
    "div",
    { class: "int-card" },
    header("#F4505E", "GitHub", "Overview"),
    h(
      "div",
      { class: "int-stats" },
      statRow(ICONS.star, "#F5A524", "Total stars", fmt(stars)),
      statRow(ICONS.stack, "#6B7079", "Repositories", String(repos)),
    ),
  );
}

// ── Stripe ────────────────────────────────────────────────────────────────────

function stripeCard(): HTMLElement {
  const d = get("integration_stripe");
  const balance = (Number(d.balance ?? 0) / 100).toFixed(2);
  const currency = String(d.currency ?? "eur").toUpperCase();
  const rows = h("div", { class: "int-rows tight" });
  for (const p of arr("integration_stripe", "payments")) {
    const success = p.status === "succeeded";
    const accent = success ? "#22C55E" : "#F4505E";
    rows.append(
      h(
        "div",
        { class: "int-row" },
        dot(accent, 5),
        h("span", { class: "int-name", text: String(p.description ?? "Payment") }),
        h("span", {
          class: "int-amount",
          style: "color:#22c55e",
          text: `+${(Number(p.amount ?? 0) / 100).toFixed(2)}`,
        }),
        h("span", { class: "int-ago", text: timeAgo(p.createdAt) }),
      ),
    );
  }
  return h(
    "div",
    { class: "int-card" },
    header("#0570DE", "Stripe", "Payments"),
    h("div", { class: "int-balance" }, h("span", { text: balance }), h("i", { text: currency })),
    rows,
  );
}

// ── Notion ────────────────────────────────────────────────────────────────────

function notionCard(): HTMLElement {
  const rows = h("div", { class: "int-rows tight" });
  for (const p of arr("integration_notion", "pages").slice(0, 3)) {
    rows.append(
      h(
        "button",
        {
          class: "int-page",
          onclick: () => {
            if (typeof p.url === "string") void Bridge.openUrl(p.url);
          },
        },
        p.emoji
          ? h("span", { class: "int-emoji", text: String(p.emoji) })
          : h("i", { class: "int-emoji" }, svg(ICONS.doc, 9)),
        h("span", { class: "int-name", text: String(p.title ?? "Untitled") }),
        h("span", { class: "int-ago", text: timeAgo(p.lastEditedAt) }),
      ),
    );
  }
  return h("div", { class: "int-card" }, header("#E8E8E8", "Notion", "Recent"), rows);
}

// ── Cal.com ───────────────────────────────────────────────────────────────────

function calcomCard(): HTMLElement {
  const bookings = arr("integration_calcom", "bookings")
    .slice()
    .sort((a, b) => new Date(String(a.start)).getTime() - new Date(String(b.start)).getTime());
  const rows = h("div", { class: "int-rows tight" });
  if (bookings.length === 0) {
    rows.append(h("div", { class: "int-empty", text: "No calls scheduled" }));
  }
  for (const b of bookings.slice(0, 3)) {
    const when = new Date(String(b.start));
    const day = when.toLocaleDateString(undefined, { day: "2-digit", month: "2-digit" });
    const time = when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    rows.append(
      h(
        "div",
        { class: "int-row" },
        dot("#C9956A", 4),
        h("span", { class: "int-time", text: `${day} ${time}` }),
        h("span", { class: "int-name", text: String(b.title ?? "Meeting") }),
      ),
    );
  }
  return h("div", { class: "int-card" }, header("#C9956A", "Cal.com", "Schedule"), rows);
}

// ── n8n ───────────────────────────────────────────────────────────────────────

function n8nCard(task: AgentTask, onDetail: () => void, openSettings: () => void): HTMLElement {
  const hasActivity = task.steps.length > 0 && (task.state === "finished" || task.state === "error");
  if (!hasActivity) return idleCard(task, openSettings);
  const success = task.state === "finished";
  const accent = success ? "#22C55E" : "#F4505E";
  return h(
    "div",
    { class: "int-card" },
    header("#F29B38", "n8n", "Workflow"),
    h(
      "div",
      { class: "int-actions" },
      h(
        "button",
        {
          class: "int-pill",
          style: `background:${accent}1a;border-color:${accent}38`,
          onclick: onDetail,
        },
        dot(accent, 5),
        h("span", { class: "int-name", text: task.steps[0] ?? "Workflow" }),
        svg(ICONS.ellipsis, 8),
      ),
    ),
  );
}

function n8nDetail(task: AgentTask, onBack: () => void): HTMLElement {
  const success = task.state === "finished";
  const accent = success ? "#22C55E" : "#F4505E";
  const detail = task.steps[1];
  return h(
    "div",
    { class: "int-card detail" },
    h(
      "div",
      { class: "int-detail-head" },
      h("button", { class: "int-back", onclick: onBack }, svg(ICONS.chevronLeft, 10, { stroke: 2.4 })),
      dot(accent, 6),
      h("b", { text: task.steps[0] ?? "Workflow" }),
      h("span", {
        class: "int-badge",
        style: `color:${accent};background:${accent}24`,
        text: success ? "Success" : "Failed",
      }),
    ),
    detail
      ? h("pre", { class: "int-detail-text", text: detail })
      : h("div", {
          class: "int-status",
          text: success ? "Completed successfully." : "No error details available.",
        }),
  );
}

// ── KAI — the root card ───────────────────────────────────────────────────────

/**
 * KAI's own card. KAI is the entity the island is about, so the DEFAULT overview
 * card is headed "KAI" and names the workers KAI drives as its workforce — rows,
 * demoted, never a headline. Nothing here is invented: the status is KAI's real
 * runtime label and the workforce rows read the same task state the pills do, so
 * a worker stays visible without ever becoming the subject.
 */
function kaiCard(_task: AgentTask, hooks: IntegrationCardHooks): HTMLElement {
  const conn = State.core.conn;
  const online = conn === "ONLINE" || conn === "DEGRADED";
  const accent = online ? "#34D399" : "#F4505E";

  // KAI's workforce — the workers and local sessions KAI drives, demoted to rows.
  const rows = h("div", { class: "int-rows" });
  rows.append(h("div", { class: "int-sub", text: "Using:" }));
  for (const id of WORKFORCE_INTEGRATION_IDS) {
    const worker = State.tasks.find((t) => t.id === id);
    if (worker === undefined) continue;
    const label = id === "integration_claude" ? "VS Code" : worker.name;
    rows.append(
      listRow(worker.color, false,
        h("span", { class: "int-name", text: label }),
        h("span", { class: "int-ago", text: worker.state }),
      ),
    );
  }

  const sessions = State.core.sessions.length;
  const activeId = State.core.activeSessionId;
  const active = activeId !== null ? State.core.sessions.find((s) => s.id === activeId) : undefined;
  const meta = h("div", { class: "int-meta" });
  meta.append(h("span", { text: online ? `${sessions} of my sessions` : "KAI Core offline" }));
  if (active !== undefined) meta.append(h("span", { text: `active: ${active.title}` }));

  return h(
    "div",
    { class: "int-card" },
    header(accent, "KAI", "your agent"),
    h("div", { class: "int-status" }, dot(accent, 5), h("span", { text: State.runtimeLabel })),
    rows,
    meta,
    h(
      "div",
      { class: "int-actions" },
      h("button", {
        class: "link-btn",
        style: `color:${accent}d9`,
        text: "My Sessions…",
        onclick: () => hooks.openSessions(),
      }),
      h("button", { class: "link-btn", style: "color:#8e939c", text: "Settings…", onclick: hooks.openSettings }),
    ),
  );
}

// ── KAI control layer: Hermes Agent ───────────────────────────────────────────

/**
 * Hermes Agent's api-server card. Every value comes from the poller, which reads
 * the real server on 127.0.0.1:8642 — nothing here is a placeholder.
 *
 * Three credential states, three different sentences. "reachable" is the server
 * answering `/health`, which needs no key; "keyStored" is the Credential Manager
 * holding one; "authorised" is the server accepting it. Collapsing those into one
 * "key not stored" would misreport a working key as a missing one.
 */
function hermesCard(task: AgentTask, openSettings: () => void): HTMLElement {
  const d = get("integration_hermes");
  const reachable = d.reachable === true;
  const authorised = d.authorised === true;
  const keyStored = d.keyStored === true;
  const version = typeof d.version === "string" && d.version ? d.version : null;
  const status = typeof d.status === "string" ? d.status : "";
  const sessions = arr("integration_hermes", "sessions");
  const count = Number(d.sessionCount ?? 0);
  const accent = reachable ? "#38BDF8" : "#F4505E";

  if (!reachable) {
    return h(
      "div",
      { class: "int-card" },
      header(task.color, "Hermes", "Agent"),
      h(
        "div",
        { class: "int-status" },
        dot("#F4505E", 5),
        h("span", { text: `Not running · nothing on ${String(d.baseUrl ?? "127.0.0.1:8642")}` }),
      ),
      h(
        "div",
        { class: "int-actions" },
        h("button", {
          class: "link-btn",
          style: "color:#8e939c",
          text: "Refresh",
          onclick: () => void Bridge.refreshIntegration("integration_hermes"),
        }),
      ),
    );
  }

  const rows = h("div", { class: "int-rows" });
  if (sessions.length === 0) {
    rows.append(
      h("div", {
        class: "int-empty",
        text: authorised
          ? "No sessions yet"
          : keyStored
            ? "The stored key was not accepted"
            : "No api-server key stored yet",
      }),
    );
  }
  sessions.slice(0, 3).forEach((s, i) => {
    rows.append(
      listRow(i === 0 ? "#38BDF8" : "#4A5568", i === 0,
        h("span", { class: "int-name", text: String(s.title ?? "Untitled") }),
        h("span", { class: "int-ago", text: timeAgo(s.startedAt) }),
      ),
    );
  });

  const meta = h("div", { class: "int-meta" });
  meta.append(h("span", { text: status ? `status ${status}` : "healthy" }));
  if (version) meta.append(h("span", { text: `api ${version}` }));
  meta.append(
    h("span", {
      text: authorised
        ? `${count} sessions`
        : keyStored
          ? "key stored · not accepted"
          : "no api-server key stored",
    }),
  );

  return h(
    "div",
    { class: "int-card" },
    header(accent, "Hermes", "Agent"),
    h("div", { class: "int-status" }, dot("#22C55E", 5), h("span", { text: "Control layer connected" })),
    rows,
    meta,
    h(
      "div",
      { class: "int-actions" },
      h("button", {
        class: "link-btn",
        style: `color:${accent}d9`,
        text: "Refresh",
        onclick: () => void Bridge.refreshIntegration("integration_hermes"),
      }),
      // No key stored is an actionable state, so it says where to fix it.
      h("button", {
        class: "link-btn",
        style: `color:${authorised ? "#8e939c" : "#F5A524"}`,
        text: authorised ? "Settings…" : "Store the key in Settings…",
        onclick: openSettings,
      }),
    ),
  );
}

// ── KAI control layer: OpenCode ───────────────────────────────────────────────

/**
 * OpenCode's headless-server card. Pending permission requests are the control
 * loop: when the list is non-empty the island shows KAI in the approval posture,
 * and answering here POSTs OpenCode's reply route.
 */
function opencodeCard(openSettings: () => void): HTMLElement {
  const d = get("integration_opencode");
  const reachable = d.reachable === true;
  const version = typeof d.version === "string" && d.version ? d.version : null;
  const pending = arr("integration_opencode", "permissions");
  const questions = Number(d.pendingQuestions ?? 0);
  const accent = !reachable ? "#F4505E" : pending.length > 0 ? "#F5A524" : "#F5F6F8";

  const actions = h("div", { class: "int-actions" });
  if (pending.length > 0) {
    const first = pending[0];
    const id = String(first?.id ?? first?.requestID ?? "");
    if (id) {
      for (const [label, reply] of [["Allow once", "once"], ["Always", "always"], ["Reject", "reject"]] as const) {
        actions.append(
          h("button", {
            class: "link-btn",
            style: `color:${reply === "reject" ? "#F4505E" : "#22C55E"}d9`,
            text: label,
            onclick: () => {
              void Bridge.opencodeReplyPermission(id, reply)
                .then(() => Bridge.refreshIntegration("integration_opencode"))
                .catch(() => {
                  /* the poller will report the real state on the next tick */
                });
            },
          }),
        );
      }
    }
  } else {
    actions.append(
      h("button", {
        class: "link-btn",
        style: `color:${accent}d9`,
        text: "Refresh",
        onclick: () => void Bridge.refreshIntegration("integration_opencode"),
      }),
      h("button", { class: "link-btn", style: "color:#8e939c", text: "Settings…", onclick: openSettings }),
    );
  }

  const rows = h("div", { class: "int-rows" });
  if (!reachable) {
    rows.append(
      h("div", {
        class: "int-empty",
        text: `Not running · nothing on ${String(d.baseUrl ?? "127.0.0.1:4096")}`,
      }),
    );
  } else if (pending.length > 0) {
    pending.slice(0, 3).forEach((p, i) => {
      const kind = String(p.permission ?? p.type ?? "permission");
      const detail = String(p.title ?? p.pattern ?? p.description ?? "");
      rows.append(
        listRow("#F5A524", i === 0,
          h("span", { class: "int-name", text: kind }),
          detail ? h("span", { class: "int-sub", text: detail }) : h("span", { class: "int-ago", text: "waiting" }),
        ),
      );
    });
  } else {
    rows.append(h("div", { class: "int-empty", text: "No approvals waiting" }));
  }

  const meta = h("div", { class: "int-meta" });
  if (version) meta.append(h("span", { text: `server ${version}` }));
  meta.append(h("span", { text: `${Number(d.sessionCount ?? 0)} recent sessions` }));
  if (questions > 0) meta.append(h("span", { text: `${questions} questions` }));

  return h(
    "div",
    { class: "int-card" },
    header(accent, "OpenCode", "Agent"),
    h(
      "div",
      { class: "int-status" },
      dot(accent, 5),
      h("span", {
        text: !reachable
          ? "Not running"
          : pending.length > 0
            ? `${pending.length} approval(s) waiting`
            : "Control layer connected",
      }),
    ),
    rows,
    meta,
    actions,
  );
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

export interface IntegrationCardHooks {
  detailOpen: boolean;
  openDetail(): void;
  closeDetail(): void;
  openSettings(): void;
  /** Jump to KAI's sessions view — KAI's card offers "My Sessions…". */
  openSessions(): void;
}

/** True when this integration has data worth showing instead of the idle card. */
export function hasIntegrationData(id: string): boolean {
  const info = State.integrations[id];
  if (!info || info.error) return false;
  switch (id) {
    // KAI's own card always renders from live state, never the idle card.
    case "integration_kai":
      return true;
    case "integration_hermes":
      return get(id).reachable === true;
    case "integration_opencode":
      return get(id).reachable === true;
    case "integration_vercel":
      return arr(id, "deployments").length > 0;
    case "integration_resend":
      return arr(id, "emails").length > 0;
    case "integration_github":
      return get(id).totalRepos != null;
    case "integration_stripe":
      return info.loaded;
    case "integration_notion":
      return arr(id, "pages").length > 0;
    case "integration_calcom":
      return info.loaded;
    default:
      return false;
  }
}

export function renderIntegrationCard(task: AgentTask, hooks: IntegrationCardHooks): HTMLElement {
  // KAI's own card is the root: it renders first and always, running or not.
  if (task.id === "integration_kai") return kaiCard(task, hooks);
  // KAI's own control layer renders its own cards, running or not.
  if (task.id === "integration_hermes") return hermesCard(task, hooks.openSettings);
  if (task.id === "integration_opencode") return opencodeCard(hooks.openSettings);
  if (task.id === "integration_n8n") {
    const hasActivity = task.steps.length > 0 && (task.state === "finished" || task.state === "error");
    return hooks.detailOpen && hasActivity
      ? n8nDetail(task, hooks.closeDetail)
      : n8nCard(task, hooks.openDetail, hooks.openSettings);
  }
  if (task.id === "integration_vercel" && hasIntegrationData(task.id)) {
    return hooks.detailOpen ? vercelDetail(hooks.closeDetail) : vercelCard(hooks.openDetail);
  }
  if (!hasIntegrationData(task.id)) return idleCard(task, hooks.openSettings);

  switch (task.id) {
    case "integration_resend":
      return resendCard();
    case "integration_github":
      return githubCard();
    case "integration_stripe":
      return stripeCard();
    case "integration_notion":
      return notionCard();
    case "integration_calcom":
      return calcomCard();
    default:
      return idleCard(task, hooks.openSettings);
  }
}

export { clear };
