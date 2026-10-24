// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The daily work summary — an evidence-backed report of what KAI actually did,
 * and the once-a-day offer to produce it.
 *
 * Two things are deliberately separate here:
 *
 *  1. The OFFER. It is a small notification, offered at most once per LOCAL
 *     calendar day, after the configured offer time, and only when there was
 *     meaningful work in the window. Its whole state ("which local day did I
 *     last offer on?") lives in the durable settings store, so a Core restart
 *     cannot reset it and a second offer can never fire for the same day. The
 *     local date is derived with `Intl.DateTimeFormat` for the configured IANA
 *     zone, so DST boundaries and offset changes are handled by the platform's
 *     timezone database rather than by arithmetic that would drift.
 *
 *  2. The REPORT. It is compiled from DURABLE state — the work board, the
 *     activity log, and the evidence records stored on each item — never from
 *     transient UI events. It reconciles its own counts (the per-state numbers
 *     sum to the item count) and never labels a worker-reported completion as
 *     verified.
 *
 * The offer deliberately does NOT include the report: a long report is only
 * produced when the user asks (`/summary`), or accepts the offer.
 */

import type {
  ActivityStore,
  KaiNotification,
  SettingsStore,
  WorkItemRecord,
  WorkItemStore,
} from "../shared/contracts.ts";
import type { NotificationService } from "../notifications/service.ts";
import type { VerifiedEvidence } from "../orchestration/types.ts";

export interface DailySummaryConfig {
  /** Whether the daily offer may fire at all. */
  enabled: boolean;
  /** Local wall-clock offer time, "HH:MM" (24-hour), in `timezone`. */
  time: string;
  /** IANA timezone the offer time is interpreted in (e.g. "Europe/Berlin"). */
  timezone: string;
  /** Only offer when at least this many work items changed in the window. */
  minWorkItems: number;
}

export const DEFAULT_DAILY_SUMMARY_CONFIG: DailySummaryConfig = {
  enabled: true,
  time: "18:00",
  timezone: "UTC",
  minWorkItems: 1,
};

/** Durable offer state: at most one offer per local calendar day, ever. */
export interface DailySummaryState {
  /** `YYYY-MM-DD` in the configured timezone. */
  lastOfferLocalDate?: string;
  lastOfferedAt?: string;
}

const STATE_KEY = "summary.daily.state";

/** One work item's contribution to the report, all facts derived, none invented. */
export interface SummaryItem {
  id: string;
  objective: string;
  state: string;
  workerId?: string;
  /** A settled category that partitions the item list (counts reconcile). */
  classification:
    | "verified"
    | "reported-only"
    | "planned"
    | "running"
    | "waiting"
    | "blocked"
    | "failed"
    | "cancelled";
  /** KAI-observed evidence records on the item. */
  observedEvidence: number;
  /** Worker-reported (untrusted) evidence records on the item. */
  reportedEvidence: number;
  /** Files the worker claimed to change (a claim, shown as such). */
  changedArtifacts: string[];
  /** Real checks KAI ran, with the exit status it observed. */
  checks: { command: string; exitCode: number | null; ok: boolean }[];
  blockers: string[];
  failures: string[];
  retries: number;
  updatedAt: string;
}

export interface DailyActivityReport {
  from: string;
  to: string;
  /** Per-classification counts — they sum to `items.length`. */
  totals: {
    tasks: number;
    verified: number;
    reportedOnly: number;
    planned: number;
    running: number;
    waiting: number;
    blocked: number;
    failed: number;
    cancelled: number;
    /** Repeated failures across the included items (diagnostic). */
    failureCount: number;
  };
  items: SummaryItem[];
  /** Durable decisions/events in the window (from the activity log). */
  decisions: { kind: string; label: string; at: string }[];
  nextPriorities: string[];
  /** Real tool executions in the window, grouped by outcome. */
  toolWork?: { tool: string; executions: number; failed: number; examples: string[] }[];
  /** A concrete prompt for the next worker, when one is genuinely useful. */
  nextWorkerPrompt?: string;
  /** True when nothing happened in the window. */
  empty: boolean;
}

export interface DailySummaryService {
  /** Offer to summarise, at most once per local day. Returns the notification when it offered. */
  maybeOffer(at?: Date): KaiNotification | null;
  /** Build the evidence-backed report for an ISO window. */
  buildReport(fromIso: string, toIso: string): DailyActivityReport;
  /**
   * Report + rendered markdown for a local-day range (inclusive), defaulting to
   * today. Days are `YYYY-MM-DD` in the configured timezone; a malformed day
   * falls back to today rather than throwing.
   */
  reportFor(fromDay?: string, toDay?: string): SummaryReportResult;
  /** Render a report as markdown for the chat surface. */
  renderReport(report: DailyActivityReport): string;
  /** Read the durable offer state (diagnostics/tests). */
  state(): DailySummaryState;
  /** The offer time as minutes-past-midnight, for diagnostics/tests. */
  offerMinutes(): number;
  /** The local calendar date right now in the configured timezone. */
  today(): string;
}

/** What `/summary` needs: the structured report and its rendered markdown. */
export interface SummaryReportResult {
  from: string;
  to: string;
  report: DailyActivityReport;
  text: string;
}

interface LocalParts {
  date: string;
  minutes: number;
}

const FALLBACK_ZONE = "UTC";

/**
 * The local calendar date and minutes-past-midnight in `timeZone`, via the
 * platform timezone database. An unknown zone falls back to UTC rather than
 * throwing — an offer at the wrong hour is a nuisance; a Core that will not
 * boot is a failure.
 */
function localParts(at: Date, timeZone: string): LocalParts {
  const run = (zone: string): LocalParts => {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    const parts: Record<string, string> = {};
    for (const p of fmt.formatToParts(at)) {
      if (p.type !== "literal") parts[p.type] = p.value;
    }
    const date = `${parts["year"]}-${parts["month"]}-${parts["day"]}`;
    const hour = Number(parts["hour"] ?? "0");
    const minute = Number(parts["minute"] ?? "0");
    return { date, minutes: hour * 60 + minute };
  };
  try {
    return run(timeZone);
  } catch {
    return run(FALLBACK_ZONE);
  }
}

/** "HH:MM" → minutes past midnight; a malformed value falls back to 18:00. */
export function offerTimeMinutes(time: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (m === null) return 18 * 60;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return 18 * 60;
  return h * 60 + min;
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` shifted by whole days (calendar arithmetic on the naive date). */
function shiftDay(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The UTC instant at which the local calendar day `day` begins in `timeZone`.
 *
 * A fixed offset is wrong across DST: the offset that applies at the day's
 * midnight is not necessarily the offset at other instants. This solves for it
 * by fixed point — take the local wall-clock reading at a candidate instant,
 * measure how far it is from the target naive time, and correct — which
 * converges in two passes for real timezone data and needs no offset table.
 */
function localDayStartMs(day: string, timeZone: string): number {
  const naive = Date.parse(`${day}T00:00:00.000Z`);
  let ms = naive;
  for (let pass = 0; pass < 2; pass += 1) {
    const local = localParts(new Date(ms), timeZone);
    const localAsUtc = Date.parse(`${local.date}T00:00:00.000Z`) + local.minutes * 60_000;
    ms = naive - (localAsUtc - ms);
  }
  return ms;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string") out.push(entry);
  }
  return out;
}

function evidenceRecords(value: unknown): VerifiedEvidence[] {
  if (!Array.isArray(value)) return [];
  const out: VerifiedEvidence[] = [];
  for (const raw of value) {
    const record = asRecord(raw);
    if (record === null) continue;
    if (record["source"] !== "kai-observed" && record["source"] !== "worker-reported") continue;
    if (typeof record["id"] !== "string") continue;
    out.push(record as unknown as VerifiedEvidence);
  }
  return out;
}

/**
 * Classify an item for the report. The rule that matters: a COMPLETED item is
 * only "verified" when KAI holds at least one OBSERVED evidence record behind
 * it. A completion with none is a worker-reported completion — reported, never
 * dressed up as verified.
 */
function classify(item: WorkItemRecord, observed: number): SummaryItem["classification"] {
  switch (item.state) {
    case "COMPLETED":
      return observed > 0 ? "verified" : "reported-only";
    case "CLAIMED":
    case "RUNNING":
    case "VERIFYING":
    case "REVIEW":
      return "running";
    case "WAITING":
    case "CHANGES_REQUESTED":
      return "waiting";
    case "BLOCKED":
      return "blocked";
    case "FAILED":
      return "failed";
    case "CANCELLED":
      return "cancelled";
    default:
      return "planned";
  }
}

function toSummaryItem(item: WorkItemRecord): SummaryItem {
  const evidence = evidenceRecords(item.evidence);
  const observed = evidence.filter((r) => r.source === "kai-observed");
  const handoff = asRecord(item.handoff);
  const changedArtifacts = asStringArray(handoff?.["changedArtifacts"]);
  const blockers = asStringArray(handoff?.["blockers"]);
  const checks = observed
    .filter((r) => typeof r.command === "string" && r.command.length > 0)
    .map((r) => ({
      command: r.command as string,
      exitCode: typeof r.exitCode === "number" ? r.exitCode : null,
      ok: r.exitCode === 0,
    }));
  return {
    id: item.id,
    objective: item.objective,
    state: item.state,
    ...(item.workerId !== undefined ? { workerId: item.workerId } : {}),
    classification: classify(item, observed.length),
    observedEvidence: observed.length,
    reportedEvidence: evidence.length - observed.length,
    changedArtifacts,
    checks,
    blockers,
    failures: [...item.failures],
    retries: item.retries,
    updatedAt: item.updatedAt,
  };
}

/** A concrete, honest prompt for the next worker, or undefined when none is needed. */
function nextPromptFor(items: SummaryItem[]): string | undefined {
  const target = items.find((i) => i.classification === "blocked" || i.classification === "failed")
    ?? items.find((i) => i.classification === "reported-only")
    ?? items.find((i) => i.classification === "waiting");
  if (target === undefined) return undefined;
  const why =
    target.classification === "reported-only"
      ? "the worker reported completion but KAI holds no independent evidence for it"
      : target.blockers[0] ?? target.failures[target.failures.length - 1] ?? `the item is ${target.state}`;
  return [
    `Objective: ${target.objective}`,
    `Why it is not settled: ${why}`,
    target.blockers.length > 0 ? `Blockers: ${target.blockers.slice(0, 5).join("; ")}` : "Blockers: none recorded",
    target.changedArtifacts.length > 0 ? `Claimed files: ${target.changedArtifacts.slice(0, 10).join(", ")}` : "Claimed files: none recorded",
    "Required: produce the missing artifact and cite exact evidence (paths and command output).",
  ].join("\n");
}

export function createDailySummaryService(opts: {
  workItems: WorkItemStore;
  activity: ActivityStore;
  /**
   * The durable tool calls (kai-sessions.db -> session_tool_calls). Optional so
   * every existing caller is unaffected; when present, real execution shows up in
   * the report instead of the day reading as empty while KAI demonstrably worked.
   */
  toolCalls?: (limit?: number) => readonly {
    toolName?: string;
    toolId?: string;
    status?: string;
    arguments?: unknown;
    result?: unknown;
    startedAt?: string;
    completedAt?: string;
  }[];
  notifications: NotificationService;
  settings: SettingsStore;
  now?: () => Date;
  config?: () => Partial<DailySummaryConfig>;
}): DailySummaryService {
  const now = opts.now ?? (() => new Date());

  function config(): DailySummaryConfig {
    const over = opts.config?.() ?? {};
    return {
      enabled: over.enabled ?? DEFAULT_DAILY_SUMMARY_CONFIG.enabled,
      time: over.time ?? DEFAULT_DAILY_SUMMARY_CONFIG.time,
      timezone: over.timezone ?? DEFAULT_DAILY_SUMMARY_CONFIG.timezone,
      minWorkItems: over.minWorkItems ?? DEFAULT_DAILY_SUMMARY_CONFIG.minWorkItems,
    };
  }

  function loadState(): DailySummaryState {
    const raw = opts.settings.get(STATE_KEY);
    if (raw === null) return {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      const record = asRecord(parsed);
      if (record === null) return {};
      const state: DailySummaryState = {};
      if (typeof record["lastOfferLocalDate"] === "string") state.lastOfferLocalDate = record["lastOfferLocalDate"];
      if (typeof record["lastOfferedAt"] === "string") state.lastOfferedAt = record["lastOfferedAt"];
      return state;
    } catch {
      // A corrupt state row must never block booting or offering; treat as none.
      return {};
    }
  }

  function saveState(state: DailySummaryState): void {
    opts.settings.set(STATE_KEY, JSON.stringify(state), now().toISOString());
  }

  function buildReport(fromIso: string, toIso: string): DailyActivityReport {
    const fromMs = Date.parse(fromIso);
    const toMs = Date.parse(toIso);
    const inWindow = (at: string): boolean => {
      const t = Date.parse(at);
      return Number.isFinite(t) && t >= fromMs && t <= toMs;
    };
    const records = opts.workItems.list({ limit: 500 }).filter((item) => inWindow(item.updatedAt));
    const items = records.map(toSummaryItem);
    const count = (c: SummaryItem["classification"]): number => items.filter((i) => i.classification === c).length;
    const totals = {
      tasks: items.length,
      verified: count("verified"),
      reportedOnly: count("reported-only"),
      planned: count("planned"),
      running: count("running"),
      waiting: count("waiting"),
      blocked: count("blocked"),
      failed: count("failed"),
      cancelled: count("cancelled"),
      failureCount: items.reduce((sum, i) => sum + i.failures.length, 0),
    };
    const decisions = opts.activity
      .list({ limit: 500 })
      .filter((e) => inWindow(e.at))
      .map((e) => ({ kind: e.kind, label: e.label, at: e.at }));
    // ── Real execution ──────────────────────────────────────────────────────
    // The report used to read only work items and decisions, so a day where KAI
    // demonstrably ran the browser still read "nothing to report". These are the
    // same durable rows the activity inspector shows.
    const calls = (opts.toolCalls?.(500) ?? []).filter((c) => {
      const at = c.completedAt ?? c.startedAt;
      return typeof at === "string" && inWindow(at);
    });
    const grouped = new Map<string, { executions: number; failed: number; examples: string[] }>();
    for (const call of calls) {
      const name = String(call.toolName ?? call.toolId ?? "unknown");
      const entry = grouped.get(name) ?? { executions: 0, failed: 0, examples: [] };
      entry.executions += 1;
      const status = String(call.status ?? "").toUpperCase();
      if (status === "FAILED" || status === "DENIED") entry.failed += 1;
      // One short, sanitized example per tool: what it acted ON, never the payload.
      if (entry.examples.length < 2) {
        const args = call.arguments;
        let hint = "";
        if (typeof args === "string") hint = args;
        else if (args !== null && typeof args === "object") hint = JSON.stringify(args);
        // Redact, then KEEP the whole JSON: the renderer parses it to build a human
        // sentence, and a truncated body no longer parses at all.
        hint = hint.replace(/"(?:api[-_]?key|token|authorization|password)"\s*:\s*"[^"]*"/gi, '"$1":"***"');
        if (hint.length > 0) entry.examples.push(`${status || "?"} ${hint}`);
      }
      grouped.set(name, entry);
    }
    const toolWork = [...grouped.entries()]
      .map(([tool, e]) => ({ tool, executions: e.executions, failed: e.failed, examples: e.examples }))
      .sort((a, b) => b.executions - a.executions);

    const nextPriorities: string[] = [];
    if (totals.blocked > 0) nextPriorities.push(`Unblock ${totals.blocked} blocked item(s) — they need a decision or a prerequisite`);
    if (totals.reportedOnly > 0) nextPriorities.push(`Collect evidence for ${totals.reportedOnly} worker-reported completion(s) before trusting them`);
    if (totals.failed > 0) nextPriorities.push(`Decide whether to retry the ${totals.failed} failed item(s) or change the approach`);
    if (totals.waiting > 0) nextPriorities.push(`Answer the ${totals.waiting} item(s) waiting on you or an approval`);
    if (totals.verified > 0) nextPriorities.push(`Ship/annotate the ${totals.verified} item(s) KAI verified`);
    const report: DailyActivityReport = {
      from: fromIso,
      to: toIso,
      totals,
      items,
      decisions,
      nextPriorities,
      empty: items.length === 0 && decisions.length === 0 && toolWork.length === 0,
      ...(toolWork.length > 0 ? { toolWork } : {}),
    };
    const prompt = nextPromptFor(items);
    if (prompt !== undefined) report.nextWorkerPrompt = prompt;
    return report;
  }

  function renderReport(report: DailyActivityReport): string {
    const { totals } = report;
    // Plain language, not a dump. The first version printed raw JSON arguments and a
    // "0 verified / 0 failed / …" line, which read like a log file rather than a
    // summary of someone's day. Tool ids are translated, arguments become the SUBJECT
    // of the sentence, and empty categories are left out entirely.
    const toolBlock = (): string[] => {
      const work = report.toolWork ?? [];
      if (work.length === 0) return [];
      const lines = ["", "### What KAI did", ""];
      for (const t of work) {
        const n = t.executions;
        const noun = n === 1 ? "time" : "times";
        const failed = t.failed > 0 ? ` (${t.failed} of them failed)` : "";
        lines.push(`- ${humanTool(t.tool)} — ${n} ${noun}${failed}`);
        for (const ex of t.examples) {
          const line = humanExample(ex);
          if (line.length > 0) lines.push(`  - ${line}`);
        }
      }
      return lines;
    };
    if (report.empty) {
      return [
        `## Work summary — ${report.from.slice(0, 10)} → ${report.to.slice(0, 10)}`,
        "",
        "No durable work or decisions fell in this window, so there is nothing to report. " +
          "(This is an honest empty result, not a failure.)",
      ].join("\n");
    }
    const lines: string[] = [];
    lines.push(`## Work summary — ${report.from.slice(0, 10)} → ${report.to.slice(0, 10)}`);
    lines.push("");
    lines.push(...toolBlock());
    // Only when there ARE tasks. A line of zeroes tells the reader nothing except
    // that the report is machine output.
    if (totals.tasks > 0) {
      lines.push(
        `**${totals.tasks}** item(s): **${totals.verified}** verified · ${totals.reportedOnly} worker-reported (unverified) · ` +
          `${totals.running} running · ${totals.waiting} waiting · ${totals.blocked} blocked · ${totals.failed} failed · ` +
          `${totals.cancelled} cancelled · ${totals.planned} planned.`,
      );
    }
    const detail = (c: SummaryItem["classification"], title: string): void => {
      const picked = report.items.filter((i) => i.classification === c);
      if (picked.length === 0) return;
      lines.push("", `### ${title} (${picked.length})`);
      for (const item of picked.slice(0, 25)) {
        let row = `- \`${item.id}\` ${item.objective.slice(0, 140)}`;
        if (item.classification === "verified") {
          row += ` — ${item.observedEvidence} KAI-observed record(s)`;
        } else if (item.classification === "reported-only") {
          row += ` — worker-reported completion; NO independent evidence recorded`;
        }
        if (item.checks.length > 0) {
          row += `; checks: ${item.checks.slice(0, 3).map((c) => `${c.command} → ${c.ok ? "exit 0" : `exit ${c.exitCode ?? "?"}`}`).join(", ")}`;
        }
        if (item.blockers.length > 0) row += `; blocker: ${item.blockers[0]?.slice(0, 100)}`;
        lines.push(row);
      }
    };
    detail("verified", "Verified (evidence KAI observed)");
    detail("reported-only", "Worker-reported only (unverified — do not treat as done)");
    detail("waiting", "Waiting on a decision or approval");
    detail("blocked", "Blocked");
    detail("failed", "Failed");
    detail("running", "Running");
    detail("planned", "Planned (not yet run)");
    detail("cancelled", "Cancelled");
    if (report.nextPriorities.length > 0) {
      lines.push("", "### Recommended next priorities", ...report.nextPriorities.map((p) => `- ${p}`));
    }
    if (report.nextWorkerPrompt !== undefined) {
      lines.push("", "### Suggested next-worker prompt", "", "```", report.nextWorkerPrompt, "```");
    }
    return lines.join("\n");
  }

  function maybeOffer(at: Date = now()): KaiNotification | null {
    const cfg = config();
    if (!cfg.enabled) return null;
    const local = localParts(at, cfg.timezone);
    const state = loadState();
    // At most one offer per local calendar day — across restarts and ticks.
    if (state.lastOfferLocalDate === local.date) return null;
    if (local.minutes < offerTimeMinutes(cfg.time)) return null;
    // Only offer when there was meaningful work: no offer for an empty day.
    const toIso = at.toISOString();
    const fromIso = new Date(at.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const report = buildReport(fromIso, toIso);
    if (report.items.length < cfg.minWorkItems) return null;
    // Claim the day durably BEFORE notifying: a second tick (or a second
    // process) then sees the day as claimed and produces nothing.
    saveState({ lastOfferLocalDate: local.date, lastOfferedAt: toIso });
    const verified = report.totals.verified;
    const reported = report.totals.reportedOnly;
    return opts.notifications.notify({
      type: "summary.daily.offer",
      title: "Summarise today's work?",
      message:
        `${report.totals.tasks} item(s) moved in the last day — ${verified} verified, ${reported} worker-reported. ` +
        `Run /summary for the evidence-backed report.`,
      priority: "LOW",
      dedupeKey: `summary.daily.offer:${local.date}`,
    });
  }

  return {
    maybeOffer,
    buildReport,
    renderReport,
    reportFor(fromDay, toDay) {
      const todayDay = localParts(now(), config().timezone).date;
      const from = fromDay !== undefined && DAY_PATTERN.test(fromDay.trim()) ? fromDay.trim() : todayDay;
      const to = toDay !== undefined && DAY_PATTERN.test(toDay.trim()) ? toDay.trim() : from;
      const zone = config().timezone;
      // The window ends at the START of the day after `to`, so a DST day is
      // exactly as long as it really is (23h or 25h), not a fixed 24h.
      const fromIso = new Date(localDayStartMs(from, zone)).toISOString();
      const toIso = new Date(localDayStartMs(shiftDay(to, 1), zone) - 1).toISOString();
      const report = buildReport(fromIso, toIso);
      return { from, to, report, text: renderReport(report) };
    },
    state: loadState,
    offerMinutes: () => offerTimeMinutes(config().time),
    today: () => localParts(now(), config().timezone).date,
  };
}

/** A tool id said the way a person would say it. */
function humanTool(tool: string): string {
  const t = tool.toLowerCase();
  if (t.includes("browser")) return "Browsed the web";
  if (t.includes("shell") || t.includes("powershell")) return "Ran commands";
  if (t.includes("filesystem_write") || t.includes("write_file")) return "Wrote files";
  if (t.includes("filesystem")) return "Looked through files";
  if (t.includes("git")) return "Checked the repository";
  if (t.includes("memory")) return "Used its memory";
  if (t.includes("mission")) return "Checked missions";
  if (t.includes("agent") || t.includes("workforce")) return "Checked the workforce";
  return tool.replace(/^(capability|kai)[._]/, "").replace(/[._]/g, " ");
}

/**
 * One example line a person can read: what the call acted ON, never the payload.
 * `EXECUTED {"action":"navigate","input":{"url":"…"}}` becomes
 * `Opened https://…`.
 */
function humanExample(example: string): string {
  const status = /^FAILED/i.test(example) ? "Failed: " : "";
  const jsonStart = example.indexOf("{");
  if (jsonStart < 0) return `${status}${example.replace(/^[A-Z_?]+\s*/, "").slice(0, 100)}`.trim();
  let parsed: unknown;
  try { parsed = JSON.parse(example.slice(jsonStart)); } catch { return ""; }
  const rec = (parsed ?? {}) as Record<string, unknown>;
  const inner = (rec.input ?? rec) as Record<string, unknown>;
  const action = typeof rec.action === "string" ? rec.action : "";
  const url = typeof inner.url === "string" ? inner.url : "";
  if (url) {
    const label = action === "navigate" ? "Opened" : action === "open" ? "Opened" : "Used";
    return `${status}${label} ${url.length > 120 ? url.slice(0, 117) + "…" : url}`;
  }
  const query = typeof inner.query === "string" ? inner.query : "";
  if (query) return `${status}Searched for “${query}”`;
  const target = typeof inner.targetId === "string" ? inner.targetId : "";
  if (target) return `${status}${action === "read" ? "Read the page" : "Worked on the page"}`;
  const path = typeof inner.path === "string" ? inner.path : "";
  if (path) return `${status}${path.slice(0, 120)}`;
  return "";
}
