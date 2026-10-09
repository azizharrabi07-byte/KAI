// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * KAI's command runtime — slash commands that EXECUTE, not prose that describes.
 *
 * A command is a named, described operation over the LIVE runtime (sessions,
 * tools, skills, agents, MCP, memory, model provider). `/help` lists exactly
 * what is registered here, so the catalogue can never promise what the runtime
 * cannot do. Parsing (`parseSlash`) is deliberately small: `/name` plus
 * whitespace-separated arguments with `"quoted"` support.
 *
 * Authority: a command runs because the USER invoked it explicitly — that is
 * the authority. READ commands only read. The two mutating commands (`new`,
 * `compress`) act on the user's own conversation state, never on the world,
 * and everything tool-shaped still goes through `registry.invoke`, never
 * around it.
 */

import type { SessionService } from "../sessions/service.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { SkillRegistry } from "../skills/registry.ts";
import type { MemoryService } from "../memory/service.ts";
import type { MemoryEngine } from "../memory/engine.ts";
import type { KaiBrain } from "../chat/brain.ts";
import type { Mission } from "../shared/contracts.ts";
import type { ProposeInput, SkillCandidate, SubmitResult } from "../orchestration/learn.ts";
import { parseReviewVerdict, REVIEWER_SYSTEM } from "../orchestration/review.ts";
import type { ModelProvider } from "../model/types.ts";
import type { SubagentRegistry } from "../workforce/subagent.ts";
import type { SummaryReportResult } from "../summary/daily.ts";
import type { ExternalAuditInput, ExternalAuditResult } from "../orchestration/orchestrator.ts";

/** The live runtime surface commands may read (structural, never the whole Core). */
export interface CommandRuntime {
  sessions: SessionService;
  tools: ToolRegistry;
  skills: SkillRegistry;
  /** The ONE provider registry — `/models` and `/providers` read it live. */
  providers: {
    list(): Promise<
      Array<{
        id: string;
        label: string;
        kind: string;
        baseUrl: string;
        reachable: boolean;
        authConfigured: boolean;
        authorized: boolean;
        version?: string;
        latencyMs?: number;
        models: Array<{ id: string; current: boolean }>;
        modelsNote?: string;
        reason?: string;
      }>
    >;
  };
  mcp: {
    summary(): {
      servers: number;
      enabled: number;
      connected: number;
      tools: number;
      resources: number;
    };
    listServers(): Array<{
      name: string;
      enabled?: boolean;
      connected: boolean;
      toolCount: number;
    }>;
  };
  memory: MemoryService;
  memoryEngine: MemoryEngine;
  brain: KaiBrain;
  model: ModelProvider;
  subagents: SubagentRegistry;
  workers(): Promise<Array<{ id: string; state: string; detail?: string }>>;
  /**
   * Generate a structured plan from a goal (Plan Mode): model-planned,
   * registry-validated, persisted as a DRAFT mission that runs nothing.
   */
  createPlan(goal: string): Promise<{ ok: true; mission: { id: string; title: string; steps: Array<{ title: string; kind: string; target?: string }> } } | { ok: false; reason: string }>;
  /** Skill-learning port (orchestrator learn). Absent in stub contexts. */
  learning?: {
    propose(input: ProposeInput): SkillCandidate | null;
    submit(candidate: SkillCandidate, markdown: string): SubmitResult;
  };
  /** Independent review: work items via the orchestrator, missions/sessions via the reviewer prompt. */
  reviewer?: {
    reviewWorkItem(id: string, criteria?: string[]): Promise<{ verdict: string; findings: string[] } | { error: string }>;
  };
  /** Mission lookup for /review. Absent in stub contexts. */
  missions?: {
    getMission(id: string): Mission | null;
  };
  /** Orchestration surface for /status /tasks /runs /bench /workers /activity /reasoning /abort. */
  orchestration?: {
    workItems(filter?: { state?: string; missionId?: string; taskId?: string; workerId?: string; limit?: number }): Array<{
      id: string;
      objective: string;
      state: string;
      workerId?: string;
      valueScore?: number;
      retries: number;
      missionId?: string;
      taskId?: string;
    }>;
    bench(): Array<{ profile: { workerId: string; role: string; overallValue: number; totalSamples: number; overallConfidence: string } }>;
    activity(ref?: { taskId?: string; workItemId?: string }, level?: "OFF" | "COMPACT" | "VERBOSE"): Array<{ kind: string; label: string; at: string; detail?: string }>;
    activeRuns(): Array<{ runId: string; subagentId: string; status: string; approvalId?: string; startedAt: string }>;
    cancelRun(runId: string): Promise<{ ok: boolean; reason?: string }>;
  };
  /** Task lifecycle read for /tasks. Absent in stub contexts. */
  tasks?: {
    active(sessionId: string): { id: string; objective: string; state: string; steps: { label: string; status: string }[]; pendingTools: string[] } | null;
  };
  /** Live orchestration prefs for /activity /reasoning /status. */
  prefs?: () => {
    autonomy: { level: number; workerAuto: string; review: string; skillLearning: string; maxDepth: number; maxParallel: number };
    activity: string;
    reasoning: string;
  };
  /** Registered capabilities for /self-audit. */
  capabilities?: { list(): Array<{ id: string; name?: string; availability?: string; provider?: string }> };
  /** Start an objective as an autonomous work item (Work Mode). */
  startWork?(goal: string): Promise<{ ok: true; workItemId: string; note: string } | { ok: false; reason: string }>;
  /**
   * The daily work summary: an evidence-backed report over a local-day range,
   * plus the durable offer state. `/summary` renders exactly this.
   */
  summary?: {
    report(fromDay?: string, toDay?: string): SummaryReportResult;
    state(): { lastOfferLocalDate?: string; lastOfferedAt?: string };
    offerMinutes(): number;
    today(): string;
  };
  /**
   * External worker-report audit. `/audit` hands a pasted report here; the
   * report is treated as UNTRUSTED claims and checked against the real
   * workspace. Auto-launch happens only through the orchestrator's own policy
   * gate; otherwise the audit returns the correction prompt to run.
   */
  audit?: {
    report(input: ExternalAuditInput): Promise<ExternalAuditResult>;
  };
}

/** What a command run returns: a title plus markdown the UI renders. */
export interface CommandResult {
  /** The command id that ran (`new`, `tools`, …). */
  command: string;
  /** One-line outcome for the chat log / palette. */
  title: string;
  /** Markdown body the UI renders with the existing renderer. */
  text: string;
  /** Structured facts behind the text, for tests and future cards. */
  data?: unknown;
}

/**
 * One argument a command understands. `source` names the LIVE pool the UI
 * suggests from — never a hardcoded list: sessions/agents/skills/mcp resolve
 * against current runtime state, `free` means free text (see usage).
 */
export interface CommandArg {
  name: string;
  description?: string;
  source: "sessions" | "agents" | "skills" | "mcp" | "free";
}

export interface KaiCommand {
  /** Stable id and slash name (`new` ⇔ `/new`). */
  id: string;
  title: string;
  description: string;
  usage: string;
  /** Positional arguments, in order. Absent means the command takes none. */
  args?: CommandArg[];
  /**
   * Run the command. `args` are the whitespace-split arguments; `raw` is the
   * argument text EXACTLY as typed (after the command name), newlines intact.
   * Commands that accept free-form multiline input (a pasted worker report)
   * read `raw`; everything else can ignore it.
   */
  run(args: string[], ctx: CommandRuntime, raw?: string): Promise<CommandResult>;
}

/** Split an argument string on whitespace, honouring "double quotes". */
export function splitArgs(input: string): string[] {
  const out: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  for (;;) {
    match = pattern.exec(input);
    if (match === null) break;
    out.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return out.filter((part) => part.length > 0);
}

/** Parse `/name arg…` — null when the text is not a slash invocation. */
export function parseSlash(text: string): { name: string; args: string[] } | null {
  const match = /^\/([A-Za-z][A-Za-z0-9_-]*)(?:\s+(.*))?$/.exec(text.trim());
  if (match === null) return null;
  return { name: (match[1] ?? "").toLowerCase(), args: splitArgs((match[2] ?? "").trim()) };
}

function lines(items: string[]): string {
  return items.join("\n");
}

function section(title: string, body: string): string {
  return `## ${title}\n\n${body}`;
}

const COMMANDS: KaiCommand[] = [
  {
    id: "new",
    title: "New session",
    description: "Create a real persisted session and make it the active conversation.",
    usage: "/new [title]",
    args: [{ name: "title", description: "Session title (free text)", source: "free" }],
    async run(args, ctx) {
      const title = args.join(" ").trim();
      const session = ctx.sessions.create(title.length > 0 ? { title } : {});
      ctx.sessions.activate(session.id);
      return {
        command: "new",
        title: `Started “${session.title}”`,
        text: `Created session \`${session.id}\` and made it active.`,
        data: { sessionId: session.id, title: session.title },
      };
    },
  },
  {
    id: "compress",
    title: "Compress context",
    description: "Shrink a session's transcript to its digest plus the first 2 and last 8 turns.",
    usage: "/compress [session-id] [--keep N]",
    args: [
      { name: "session-id", description: "Defaults to the active session", source: "sessions" },
      { name: "--keep N", description: "Recent turns to keep", source: "free" },
    ],
    async run(args, ctx) {
      let keepLast = 8;
      const positional: string[] = [];
      for (let i = 0; i < args.length; i += 1) {
        if (args[i] === "--keep" && i + 1 < args.length) {
          const parsed = Number.parseInt(args[i + 1] ?? "", 10);
          if (Number.isFinite(parsed) && parsed >= 0) keepLast = Math.min(parsed, 100);
          i += 1;
        } else positional.push(args[i] ?? "");
      }
      const target = positional[0] ?? ctx.sessions.active()?.id ?? "";
      if (target.length === 0) {
        return { command: "compress", title: "No session to compress", text: "There is no active session." };
      }
      const compacted = ctx.sessions.compact(target, { keepFirst: 2, keepLast });
      if (!compacted.ok) {
        return { command: "compress", title: "Compress refused", text: compacted.reason };
      }
      const { removed, kept, session } = compacted.value;
      return {
        command: "compress",
        title: `Compressed “${session.title}”`,
        text:
          removed === 0
            ? `Nothing to compress — the transcript holds ${kept} turn(s); the digest is current.`
            : `Removed ${removed} middle turn(s), kept ${kept}. Objective: ${session.summary?.objective || "(none)"}.`,
        data: { sessionId: session.id, removed, kept },
      };
    },
  },
  {
    id: "models",
    title: "Models",
    description: "List the actual models from the live provider registry; select KAI's model.",
    usage: "/models [provider] | /models use <model>",
    args: [{ name: "args", description: "`use <model>` selects KAI's model, or a provider id filters", source: "free" }],
    async run(args, ctx) {
      // Model selection rides the policy-gated `settings.update` tool: it
      // parks for a human, and approving the parked request switches the
      // model — the command never writes around the boundary.
      if (args[0] === "use" && typeof args[1] === "string" && args[1].length > 0) {
        const wanted = args[1];
        const invoked = await ctx.tools.invoke("settings.update", { settings: { "model.name": wanted } });
        if (!invoked.ok && invoked.error.code === "APPROVAL_REQUIRED") {
          const approvalId = typeof invoked.error.detail === "string" ? invoked.error.detail : null;
          return {
            command: "models",
            title: `Switch to ${wanted} is waiting for approval`,
            text: section(
              "Model change parked",
              lines([
                `Requested model: \`${wanted}\``,
                approvalId !== null
                  ? `Approve \`${approvalId}\` in Approvals and KAI's next turn uses it — no restart.`
                  : "Approve it in Approvals and KAI's next turn uses it — no restart.",
              ]),
            ),
            data: { approvalRequired: true, ...(approvalId !== null ? { approvalId } : {}), model: wanted },
          };
        }
        if (!invoked.ok) {
          return {
            command: "models",
            title: "Model change refused",
            text: section("Model change refused", lines([`- ${invoked.error.message}`])),
            data: { error: invoked.error.message },
          };
        }
        return {
          command: "models",
          title: `Model: ${wanted}`,
          text: section("Model selected", lines([`- KAI's next turn uses \`${wanted}\` — no restart.`])),
          data: { model: wanted },
        };
      }
      const filter = args[0] !== "use" ? (args[0] ?? "").toLowerCase() : "";
      const listed = await ctx.providers.list().catch(() => []);
      const shown = listed.filter((p) => filter.length === 0 || p.id.toLowerCase().includes(filter));
      const blocks = shown.map((p) => {
        const head = p.kind === "model"
          ? `${p.reachable ? "✓" : "✗"} ${p.label} (${p.reachable ? "backing KAI now" : `unreachable — ${p.reason ?? "no reason"}`})`
          : `${p.reachable ? "✓" : "✗"} ${p.label} (worker${p.reachable ? "" : ` — ${p.reason ?? "offline"}`})`;
        const modelLines = p.models.length === 0
          ? [`- models: none listed${p.modelsNote !== undefined ? ` — ${p.modelsNote}` : ""}`]
          : p.models.map((m) => `- ${m.current ? "✓ " : ""}\`${m.id}\`${m.current ? " (active)" : ""}`);
        return section(head, lines(modelLines));
      });
      return {
        command: "models",
        title: shown.length === 0 ? "No providers match" : "Models (live)",
        text: blocks.length === 0 ? "No providers match." : blocks.join("\n\n"),
        data: { providers: shown.map((p) => ({ id: p.id, models: p.models.map((m) => m.id) })) },
      };
    },
  },
  {
    id: "providers",
    title: "Providers",
    description: "Read live provider state: KAI's model backend plus worker connectivity.",
    usage: "/providers [test <id>]",
    args: [{ name: "args", description: "`test <id>` probes one provider live", source: "free" }],
    async run(args, ctx) {
      const listed = await ctx.providers.list().catch(() => []);
      const linesOut: string[] = [];
      for (const p of listed) {
        const state = p.reachable ? (p.authorized ? "READY" : "REACHABLE (not authorized)") : `OFFLINE (${p.reason ?? "no reason"})`;
        linesOut.push(`- ${p.id} [${p.kind}]: ${state}`);
        linesOut.push(`  base URL: ${p.baseUrl}`);
        linesOut.push(`  authentication: ${p.authConfigured ? "configured" : "not configured"}`);
        if (p.kind === "model") {
          const current = p.models.find((m) => m.current);
          linesOut.push(`  current model: ${current !== undefined ? `\`${current.id}\`` : "(none)"}`);
        } else {
          linesOut.push(`  models: ${p.models.length === 0 ? (p.modelsNote ?? "none listed") : p.models.map((m) => `\`${m.id}\``).join(", ")}`);
        }
        if (p.version !== undefined) linesOut.push(`  version: ${p.version}`);
        if (p.latencyMs !== undefined) linesOut.push(`  latency: ${p.latencyMs}ms`);
      }
      if (args[0] === "test" && typeof args[1] === "string") {
        linesOut.push("", "Use Settings → Providers → Test for a live probe, or `GET /providers/:id/test`.");
      }
      return {
        command: "providers",
        title: "Providers (live)",
        text: section(
          "Providers",
          lines(
            listed.length === 0
              ? ["The provider registry answered nothing — Core may be unreachable."]
              : [...linesOut, "", "Select KAI's model with `/models use <model>`; worker models are not selectable (workers route by worker id)."],
          ),
        ),
        data: { providers: listed.map((p) => p.id) },
      };
    },
  },
  {
    id: "tools",
    title: "Tools",
    description: "List the actual tools registered in KAI's tool plane.",
    usage: "/tools [filter]",
    args: [{ name: "filter", description: "Substring over tool ids", source: "free" }],
    async run(args, ctx) {
      const filter = (args[0] ?? "").toLowerCase();
      const tools = ctx.tools
        .list()
        .filter((tool) => filter.length === 0 || tool.id.toLowerCase().includes(filter))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return {
        command: "tools",
        title: `${tools.length} tool(s) registered`,
        text: section(
          "KAI tools",
          tools.length === 0
            ? "No tools match."
            : lines(tools.map((tool) => `- \`${tool.id}\` (${tool.risk}): ${tool.description}`)),
        ),
        data: { count: tools.length, ids: tools.map((tool) => tool.id) },
      };
    },
  },
  {
    id: "skills",
    title: "Skills",
    description: "List the actual installed skills and whether each is enabled.",
    usage: "/skills [filter]",
    args: [{ name: "filter", description: "Substring over skill names", source: "free" }],
    async run(args, ctx) {
      const filter = (args.join(" ") ?? "").toLowerCase();
      const skills = ctx.skills
        .list()
        .filter((skill) => filter.length === 0 || skill.name.toLowerCase().includes(filter) || skill.id.toLowerCase().includes(filter));
      return {
        command: "skills",
        title: skills.length === 0 ? "No skills installed" : `${skills.length} skill(s)`,
        text: section(
          "KAI skills",
          skills.length === 0
            ? "No skills are installed yet. Staged skills awaiting approval install through the approvals surface."
            : lines(
                skills.map(
                  (skill) =>
                    `- \`${skill.name}\` — ${skill.status}${skill.description ? `: ${skill.description}` : ""}`,
                ),
              ),
        ),
        data: { count: skills.length, ids: skills.map((skill) => skill.id) },
      };
    },
  },
  {
    id: "agents",
    title: "Agents",
    description: "List KAI's real subagent personas and their live state.",
    usage: "/agents",
    async run(_args, ctx) {
      const personas = ctx.subagents.list();
      return {
        command: "agents",
        title: personas.length === 0 ? "No agents yet" : `${personas.length} agent(s)`,
        text: section(
          "KAI agents",
          personas.length === 0
            ? "No subagent personas exist. Create one from the Agents surface."
            : lines(
                personas.map(
                  (persona) => `- \`${persona.spec.name}\` — ${persona.spec.role} (worker: ${persona.spec.workerId})`,
                ),
              ),
        ),
        data: { count: personas.length, ids: personas.map((persona) => persona.employeeId) },
      };
    },
  },
  {
    id: "mcp",
    title: "MCP",
    description: "Read the real MCP manager state: servers, lifecycle, tools.",
    usage: "/mcp",
    async run(_args, ctx) {
      const summary = ctx.mcp.summary();
      const catalogue = ctx.mcp.listServers();
      return {
        command: "mcp",
        title: summary.servers === 0 ? "No MCP servers configured" : `${summary.servers} server(s), ${summary.connected} connected`,
        text: section(
          "MCP",
          lines([
            `- servers: ${summary.servers} (enabled: ${summary.enabled}, connected: ${summary.connected})`,
            `- tools adapted into KAI's plane: ${summary.tools}`,
            `- resources listed: ${summary.resources}`,
            ...(catalogue.length > 0
              ? [
                  "",
                  ...catalogue.map(
                    (entry) =>
                      `- \`${entry.name}\`: ${entry.enabled === true ? "enabled" : "disabled"}, ${entry.connected ? "connected" : "not connected"}, ${entry.toolCount} tool(s)`,
                  ),
                ]
              : []),
          ]),
        ),
        data: summary,
      };
    },
  },
  {
    id: "memory",
    title: "Memory",
    description: "Search KAI's durable memories, or show the digest when no query is given.",
    usage: "/memory [query]",
    args: [{ name: "query", description: "Search text", source: "free" }],
    async run(args, ctx) {
      const query = args.join(" ").trim();
      if (query.length === 0) {
        const remembered = ctx.memory.digest({ limit: 5 });
        return {
          command: "memory",
          title: remembered.length === 0 ? "Nothing remembered yet" : `${remembered.length} recent memor(ies)`,
          text: section(
            "KAI memory",
            remembered.length === 0
              ? "KAI holds no durable memories yet. Say “remember that …” to store one."
              : lines(remembered.map((entry) => `- [${entry.type}] ${entry.content}`)),
          ),
          data: { count: remembered.length },
        };
      }
      const hits = ctx.memoryEngine.search({ scopes: [{ scope: "global" }], text: query, limit: 10 });
      return {
        command: "memory",
        title: hits.length === 0 ? `No memories match “${query}”` : `${hits.length} match(es) for “${query}”`,
        text: section(
          "KAI memory search",
          hits.length === 0
            ? "No durable memory matches that query."
            : lines(
                hits.map((hit) => {
                  const entry = (hit as { entry?: { type?: string; content?: string } }).entry;
                  return `- [${entry?.type ?? "?"}] ${entry?.content ?? JSON.stringify(hit).slice(0, 160)}`;
                }),
              ),
        ),
        data: { count: hits.length },
      };
    },
  },
  {
    id: "session",
    title: "Session info",
    description: "Show the active session's real state: id, title, turns, digest.",
    usage: "/session",
    async run(_args, ctx) {
      const active = ctx.sessions.active();
      if (active === null) {
        return { command: "session", title: "No active session", text: "Use `/new` to start one." };
      }
      return {
        command: "session",
        title: `Session “${active.title}”`,
        text: section(
          "Active session",
          lines([
            `- id: \`${active.id}\``,
            `- kind: ${active.sessionKind ?? "kai-conversation"}`,
            `- turns: ${active.turnCount}`,
            `- objective: ${active.summary?.objective || "(just started)"}`,
            `- tools used: ${active.summary?.toolsUsed.join(", ") || "none yet"}`,
          ]),
        ),
        data: { sessionId: active.id },
      };
    },
  },
  {
    id: "plan",
    title: "Create a plan",
    description: "Plan Mode: the model drafts a structured, validated plan from a goal and stores it as a DRAFT mission. Planning executes nothing.",
    usage: "/plan <goal>",
    args: [{ name: "goal", description: "What to plan", source: "free" }],
    async run(args, ctx) {
      const goal = args.join(" ").trim();
      if (goal.length === 0) {
        return { command: "plan", title: "A plan needs a goal", text: "Usage: `/plan <goal>` — e.g. `/plan add search to the docs page`." };
      }
      const outcome = await ctx.createPlan(goal);
      if (!outcome.ok) {
        return { command: "plan", title: "Planning failed", text: outcome.reason };
      }
      const { mission } = outcome;
      return {
        command: "plan",
        title: `Planned: ${mission.title}`,
        text: section(
          `Plan “${mission.title}” (DRAFT — nothing runs until approved)`,
          lines([
            `Mission: \`${mission.id}\``,
            "",
            ...mission.steps.map((step, i) => `${i + 1}. [${step.kind}] ${step.title}${step.target !== undefined ? ` → \`${step.target}\`` : ""}`),
            "",
            "Approve it from the Missions surface to start the work.",
          ]),
        ),
        data: { missionId: mission.id },
      };
    },
  },
  {
    id: "refine",
    title: "Propose a skill",
    description: "Inspect a session's workflow and propose it as a reusable skill. Proposals stage for human approval — nothing installs silently.",
    usage: "/refine [session-id]",
    args: [{ name: "session", description: "Session to learn from (default: active)", source: "sessions" }],
    async run(args, ctx) {
      if (ctx.learning === undefined) {
        return { command: "refine", title: "Skill learning is unavailable here", text: "This context has no learning port." };
      }
      const wanted = args[0];
      const session = wanted !== undefined ? ctx.sessions.get(wanted) : ctx.sessions.active();
      if (session === null || session === undefined) {
        return { command: "refine", title: "No session to learn from", text: wanted !== undefined ? `No session "${wanted}".` : "No active session." };
      }
      const turnsResult = ctx.sessions.turns(session.id, 50);
      if (!turnsResult.ok || turnsResult.value.length < 2) {
        return { command: "refine", title: "Nothing reusable yet", text: `Session "${session.id}" has no workflow to learn from.` };
      }
      const turns = turnsResult.value;
      const firstUser = turns.find((t) => t.role === "user");
      const lastAssistant = [...turns].reverse().find((t) => t.role === "assistant" && t.text.trim().length > 0);
      const steps = turns
        .filter((t) => t.role === "assistant")
        .map((t) => ({ label: t.text.slice(0, 160), status: "completed" }));
      const candidate = ctx.learning.propose({
        taskId: session.id,
        objective: firstUser?.text.slice(0, 300) ?? session.id,
        steps,
        outcome: { success: lastAssistant !== undefined, verified: turns.some((t) => (t.tools?.length ?? 0) > 0), corrections: [] },
        existingSkillIds: ctx.skills.list().map((s) => s.id),
      });
      if (candidate === null) {
        return { command: "refine", title: "No reusable pattern detected", text: "This session's workflow does not qualify (too short, unverified, or failed). Successful multi-step verified work proposes cleanly." };
      }
      // Draft the SKILL.md from the candidate, then validate + stage. The
      // install still requires a human approval bound to the staged bytes.
      const draft = await ctx.brain.respond({
        text: [
          "Draft a KAI SKILL.md file from this candidate. Output ONLY the file, no commentary.",
          `Title: ${candidate.title}`,
          `Trigger: ${candidate.trigger}`,
          `Method: ${candidate.method}`,
          `Tools: ${candidate.tools.join(", ") || "filesystem.read"}`,
          `Constraints: ${candidate.constraints.join("; ")}`,
          "Frontmatter keys allowed: name, description, purpose, tools, constraints, version, license, tags, author, homepage.",
          "Body sections required: TRIGGER, CONTEXT, METHOD, TOOLS, CONSTRAINTS, OUTPUT CONTRACT, VERIFICATION.",
        ].join("\n"),
        system: "You author KAI skill files. Output only the SKILL.md file.",
        purpose: "refine:draft",
      }).catch(() => null);
      if (draft === null || draft.text.trim().length === 0) {
        return { command: "refine", title: "Drafting failed", text: "The model produced no draft. Nothing was staged." };
      }
      const submitted = ctx.learning.submit(candidate, draft.text);
      if (!submitted.ok) {
        return { command: "refine", title: "Proposal refused", text: submitted.reason };
      }
      return {
        command: "refine",
        title: `Skill proposed: ${candidate.title}`,
        text: section(
          "Skill candidate staged",
          lines([
            `Candidate: ${candidate.title} (${candidate.pattern})`,
            `Staged: \`${submitted.stagedId}\``,
            "",
            "Review it in Skills → Staged, then approve to install. Nothing installed yet.",
          ]),
        ),
        data: { stagedId: submitted.stagedId, pattern: candidate.pattern },
      };
    },
  },
  {
    id: "review",
    title: "Review",
    description: "Independent review of a work item, mission, or session: PASS, CHANGES_REQUESTED, or BLOCKED with findings. The reviewer sees only contract + artifact + evidence.",
    usage: "/review <work-id | mission-id | session-id> [criteria...]",
    args: [{ name: "target", description: "Work item, mission, or session to review", source: "free" }],
    async run(args, ctx) {
      const target = args[0] ?? "";
      if (target.length === 0) {
        return { command: "review", title: "Review needs a target", text: "Usage: `/review <work-id | mission-id | session-id> [criteria...]`." };
      }
      const criteria = args.slice(1);
      // Work items review through the orchestrator (recorded + bounded).
      if (target.startsWith("work_") && ctx.reviewer !== undefined) {
        const outcome = await ctx.reviewer.reviewWorkItem(target, criteria.length > 0 ? criteria : undefined);
        if ("error" in outcome) {
          return { command: "review", title: "Review refused", text: outcome.error };
        }
        return {
          command: "review",
          title: `Review: ${outcome.verdict}`,
          text: section(
            `Review of \`${target}\``,
            lines([`Verdict: **${outcome.verdict}**`, "", ...outcome.findings.map((f) => `- ${f}`)]),
          ),
          data: { verdict: outcome.verdict, findings: outcome.findings },
        };
      }
      // Missions and sessions review through a fresh reviewer call: contract +
      // artifact + evidence only, never the reviewer's own transcript.
      let objective = "";
      let artifact = "";
      if (ctx.missions !== undefined) {
        const mission = ctx.missions.getMission(target);
        if (mission !== null) {
          objective = mission.title;
          artifact = (mission.steps ?? [])
            .map((s) => `- [${s.status}] ${s.title}${s.output !== undefined ? `: ${JSON.stringify(s.output).slice(0, 400)}` : ""}`)
            .join("\n")
            .slice(0, 6000);
        }
      }
      if (artifact.length === 0) {
        const session = ctx.sessions.get(target);
        if (session !== null) {
          const turnsResult = ctx.sessions.turns(session.id, 40);
          if (turnsResult.ok) {
            const firstUser = turnsResult.value.find((t) => t.role === "user");
            objective = firstUser?.text.slice(0, 300) ?? session.id;
            artifact = turnsResult.value
              .map((t) => `${t.role}: ${t.text.slice(0, 300)}`)
              .join("\n")
              .slice(0, 6000);
          }
        }
      }
      if (artifact.length === 0) {
        return { command: "review", title: "Nothing to review", text: `No work item, mission, or session "${target}" with reviewable output.` };
      }
      const prompt = [
        "## REVIEW CONTRACT",
        `Objective: ${objective.slice(0, 500)}`,
        "## ACCEPTANCE CRITERIA",
        ...((criteria.length > 0 ? criteria : ["deliverable present", "evidence cited"]).map((c) => `- ${c}`)),
        "## ARTIFACT UNDER REVIEW",
        artifact,
        "## EVIDENCE",
        "(the artifact above)",
      ].join("\n");
      const result = await ctx.brain.respond({ text: prompt, system: REVIEWER_SYSTEM, purpose: "review:command" }).catch(() => null);
      if (result === null) {
        return { command: "review", title: "Reviewer unavailable", text: "The reviewer call failed. Nothing was judged." };
      }
      const parsed = parseReviewVerdict(result.text);
      return {
        command: "review",
        title: `Review: ${parsed.verdict}`,
        text: section(
          `Review of \`${target}\``,
          lines([`Verdict: **${parsed.verdict}**`, "", ...parsed.findings.map((f) => `- ${f}`)]),
        ),
        data: { verdict: parsed.verdict, findings: parsed.findings },
      };
    },
  },
  {
    id: "work",
    title: "Work on an objective",
    description: "Work Mode: hand KAI an objective and let the autonomous operator drive it to a verified result. Delegation only by autonomy policy.",
    usage: "/work <objective>",
    args: [{ name: "objective", description: "What to accomplish", source: "free" }],
    async run(args, ctx) {
      const goal = args.join(" ").trim();
      if (goal.length === 0) {
        return { command: "work", title: "Work needs an objective", text: "Usage: `/work <objective>` — e.g. `/work audit the repo and fix the top issue`." };
      }
      if (ctx.startWork === undefined) {
        return { command: "work", title: "Work mode is unavailable here", text: "This context has no orchestrator." };
      }
      const started = await ctx.startWork(goal);
      if (!started.ok) {
        return { command: "work", title: "Work not started", text: started.reason };
      }
      return {
        command: "work",
        title: "Objective accepted",
        text: section(
          "Work started",
          lines([
            `Objective: ${goal}`,
            started.workItemId.length > 0 ? `Work item: \`${started.workItemId}\`` : "",
            "",
            started.note,
          ].filter((l) => l.length > 0)),
        ),
        data: { workItemId: started.workItemId },
      };
    },
  },
  {
    id: "status",
    title: "Status",
    description: "Current mission state: active work items, open task, running workers, autonomy.",
    usage: "/status",
    async run(_args, ctx) {
      const orch = ctx.orchestration;
      const openItems = orch?.workItems({ limit: 50 }).filter((w) => !["COMPLETED", "CANCELLED"].includes(w.state)) ?? [];
      const runs = orch?.activeRuns() ?? [];
      const session = ctx.sessions.active();
      const task = session !== null && ctx.tasks !== undefined ? ctx.tasks.active(session.id) : null;
      const prefs = ctx.prefs?.();
      return {
        command: "status",
        title: openItems.length === 0 && runs.length === 0 ? "KAI is idle" : `${openItems.length} open · ${runs.length} running`,
        text: section(
          "Mission status",
          lines([
            `- autonomy: level ${prefs?.autonomy.level ?? "?"} · worker ${prefs?.autonomy.workerAuto ?? "?"} · review ${prefs?.autonomy.review ?? "?"}`,
            session !== null ? `- session: ${session.title} (${session.id})` : "- session: none active",
            task !== null ? `- task: ${task.objective.slice(0, 80)} — ${task.state}` : "- task: none open",
            "",
            "Open work items:",
            ...(openItems.length === 0
              ? ["- none"]
              : openItems.slice(0, 10).map((w) => `- \`${w.id}\` [${w.state}] ${w.objective.slice(0, 70)}${w.workerId !== undefined ? ` → ${w.workerId}` : ""}`)),
            "",
            "Running workers:",
            ...(runs.length === 0 ? ["- none"] : runs.map((r) => `- ${r.subagentId} (${r.status}) run ${r.runId}`)),
          ]),
        ),
        data: { openItems: openItems.length, runs: runs.length },
      };
    },
  },
  {
    id: "tasks",
    title: "Tasks",
    description: "The active task's plan, completed steps, and pending work.",
    usage: "/tasks [session-id]",
    args: [{ name: "session", description: "Session (default: active)", source: "sessions" }],
    async run(args, ctx) {
      if (ctx.tasks === undefined) {
        return { command: "tasks", title: "Task state is unavailable here", text: "This context has no task tracker." };
      }
      const session = args[0] !== undefined ? ctx.sessions.get(args[0]) : ctx.sessions.active();
      if (session === null || session === undefined) {
        return { command: "tasks", title: "No session", text: args[0] !== undefined ? `No session "${args[0]}".` : "No active session." };
      }
      const task = ctx.tasks.active(session.id);
      if (task === null) {
        return { command: "tasks", title: "No open task", text: `Session "${session.title}" has no open task.` };
      }
      const done = task.steps.filter((s) => s.status === "done");
      const open = task.steps.filter((s) => s.status !== "done");
      return {
        command: "tasks",
        title: `Task: ${task.state}`,
        text: section(
          task.objective.slice(0, 120),
          lines([
            `- state: ${task.state}`,
            `- id: \`${task.id}\``,
            "",
            `Completed (${done.length}):`,
            ...(done.length === 0 ? ["- none"] : done.slice(0, 12).map((s) => `- ✓ ${s.label}`)),
            "",
            `Pending (${open.length}):`,
            ...(open.length === 0 ? ["- none"] : open.slice(0, 12).map((s) => `- → ${s.label}`)),
            ...(task.pendingTools.length > 0 ? ["", "Planned calls not yet run:", ...task.pendingTools.map((t) => `- ${t}`)] : []),
          ]),
        ),
        data: { state: task.state, done: done.length, pending: open.length },
      };
    },
  },
  {
    id: "runs",
    title: "Runs",
    description: "Tracked worker runs in flight right now.",
    usage: "/runs",
    async run(_args, ctx) {
      const runs = ctx.orchestration?.activeRuns() ?? [];
      return {
        command: "runs",
        title: runs.length === 0 ? "No runs in flight" : `${runs.length} run(s)`,
        text: section(
          "Runs",
          lines(runs.length === 0
            ? ["No tracked worker runs are active."]
            : runs.map((r) => `- \`${r.runId}\` ${r.subagentId} · ${r.status}${r.approvalId !== undefined ? ` · approval ${r.approvalId}` : ""}`)),
        ),
        data: { runs: runs.map((r) => r.runId) },
      };
    },
  },
  {
    id: "bench",
    title: "Worker bench",
    description: "Measured worker benchmarks: value, confidence, samples.",
    usage: "/bench",
    async run(_args, ctx) {
      const bench = ctx.orchestration?.bench() ?? [];
      if (bench.length === 0) {
        return { command: "bench", title: "No benchmark data yet", text: "Completed work teaches the bench — run a mission first." };
      }
      const rows = bench
        .slice()
        .sort((a, b) => b.profile.overallValue - a.profile.overallValue)
        .map((b) => `- ${b.profile.workerId} (${b.profile.role}) · value ${(b.profile.overallValue * 100).toFixed(0)}% · ${b.profile.overallConfidence} · ${b.profile.totalSamples} samples`);
      return {
        command: "bench",
        title: `${bench.length} worker profile(s)`,
        text: section("Worker bench", lines(rows)),
        data: { workers: bench.map((b) => b.profile.workerId) },
      };
    },
  },
  {
    id: "workers",
    title: "Workers",
    description: "The worker fleet: id, state, detail.",
    usage: "/workers",
    async run(_args, ctx) {
      const workers = await ctx.workers().catch(() => []);
      return {
        command: "workers",
        title: workers.length === 0 ? "No workers registered" : `${workers.length} worker(s)`,
        text: section("Worker fleet", lines(workers.length === 0 ? ["No workers registered."] : workers.map((w) => `- ${w.id}: ${w.state}${w.detail !== undefined ? ` — ${w.detail}` : ""}`))),
        data: { workers: workers.map((w) => w.id) },
      };
    },
  },
  {
    id: "activity",
    title: "Activity",
    description: "Recent real activity, newest first. Level follows your visibility setting.",
    usage: "/activity [session-or-work-id]",
    args: [{ name: "ref", description: "Work-item id, or blank for recent", source: "free" }],
    async run(args, ctx) {
      const ref = args[0] !== undefined ? { workItemId: args[0] } : undefined;
      const events = ctx.orchestration?.activity(ref) ?? [];
      const level = ctx.prefs?.().activity ?? "COMPACT";
      return {
        command: "activity",
        title: `Activity (${level.toLowerCase()})`,
        text: section(
          "Activity",
          lines(events.length === 0
            ? ["No activity recorded."]
            : events.slice(0, 40).map((e) => `- \`${e.at.slice(11, 19)}\` ${e.label}${e.detail !== undefined && level === "VERBOSE" ? ` — ${e.detail.slice(0, 80)}` : ""}`)),
        ),
        data: { count: events.length, level },
      };
    },
  },
  {
    id: "reasoning",
    title: "Reasoning visibility",
    description: "Show or set how much safe reasoning KAI surfaces: hidden, summary, or provider-exposed.",
    usage: "/reasoning [hidden|summary|provider]",
    args: [{ name: "mode", description: "hidden | summary | provider", source: "free" }],
    async run(args, ctx) {
      const prefs = ctx.prefs?.();
      const current = prefs?.reasoning ?? "SUMMARY";
      const want = (args[0] ?? "").toLowerCase();
      if (want.length === 0) {
        return {
          command: "reasoning",
          title: `Reasoning: ${current}`,
          text: section("Reasoning visibility", lines([
            `Current: **${current}**`,
            "",
            "Change with `/reasoning hidden`, `/reasoning summary`, or `/reasoning provider`",
            "(also in Settings → Autonomy). KAI never exposes raw private chain-of-thought.",
          ])),
          data: { reasoning: current },
        };
      }
      const map: Record<string, string> = { hidden: "HIDDEN", summary: "SUMMARY", provider: "PROVIDER_EXPOSED", "provider-exposed": "PROVIDER_EXPOSED" };
      const value = map[want];
      if (value === undefined) {
        return { command: "reasoning", title: "Unknown mode", text: "Use hidden, summary, or provider." };
      }
      const invoked = await ctx.tools.invoke("settings.update", { settings: { "orchestration.reasoning": value } });
      if (!invoked.ok && invoked.error.code === "APPROVAL_REQUIRED") {
        return { command: "reasoning", title: "Change parked for approval", text: "Approve it in Approvals to apply." };
      }
      if (!invoked.ok) {
        return { command: "reasoning", title: "Change refused", text: invoked.error.message };
      }
      return { command: "reasoning", title: `Reasoning: ${value}`, text: `Reasoning visibility set to **${value}**.`, data: { reasoning: value } };
    },
  },
  {
    id: "abort",
    title: "Abort",
    description: "Stop the active worker run. Honest: a run with no preemption point reports so.",
    usage: "/abort [run-id]",
    args: [{ name: "run", description: "Run id (default: the only active run)", source: "free" }],
    async run(args, ctx) {
      const runs = ctx.orchestration?.activeRuns() ?? [];
      if (runs.length === 0) {
        return { command: "abort", title: "Nothing is running", text: "No tracked worker run is in flight to stop." };
      }
      const runId = args[0] ?? (runs.length === 1 ? runs[0]?.runId : undefined);
      if (runId === undefined) {
        return { command: "abort", title: "Which run?", text: `Several runs are active: ${runs.map((r) => r.runId).join(", ")}. Use \`/abort <run-id>\`.` };
      }
      const outcome = await ctx.orchestration?.cancelRun(runId);
      if (outcome === undefined) {
        return { command: "abort", title: "Abort unavailable", text: "This context has no orchestrator." };
      }
      return {
        command: "abort",
        title: outcome.ok ? `Run ${runId} stopped` : "Stop not possible",
        text: outcome.ok ? `Run \`${runId}\` was cancelled.` : outcome.reason ?? "the run could not be stopped",
        data: { runId, ok: outcome.ok },
      };
    },
  },
  {
    id: "self-audit",
    title: "Self-audit",
    description: "KAI's honest self-report from live runtime state: capabilities, workers, skills, tools, model, autonomy, limitations.",
    usage: "/self-audit",
    async run(_args, ctx) {
      const described = ctx.brain.describe();
      const workers = await ctx.workers().catch(() => []);
      const tools = ctx.tools.list();
      const skills = ctx.skills.list();
      const bench = ctx.orchestration?.bench() ?? [];
      const caps = ctx.capabilities?.list() ?? [];
      const prefs = ctx.prefs?.();
      const runs = ctx.orchestration?.activeRuns() ?? [];
      return {
        command: "self-audit",
        title: "KAI self-audit",
        text: section(
          "What I am, right now — from live state",
          lines([
            `- model: \`${described.model}\` via \`${described.provider}\` (configured: ${described.configured ? "yes" : "no"})`,
            `- autonomy: level ${prefs?.autonomy.level ?? "?"} · worker ${prefs?.autonomy.workerAuto ?? "?"} · review ${prefs?.autonomy.review ?? "?"} · skills ${prefs?.autonomy.skillLearning ?? "?"}`,
            `- tools: ${tools.length} registered`,
            `- skills: ${skills.length} installed (${skills.filter((s) => s.status === "enabled").length} enabled)`,
            `- workers: ${workers.length === 0 ? "none" : workers.map((w) => `${w.id} (${w.state})`).join(", ")}`,
            `- runs in flight: ${runs.length}`,
            `- benchmarked workers: ${bench.length}`,
            `- mcp: ${ctx.mcp.summary().connected}/${ctx.mcp.summary().servers} servers connected`,
            "",
            "Capabilities (from the registry):",
            ...(caps.length === 0 ? ["- none reported"] : caps.slice(0, 20).map((c) => `- ${c.id}${c.availability !== undefined ? ` (${c.availability})` : ""}`)),
            "",
            "Known limits (honest):",
            "- chat turns do not auto-delegate; delegation runs through missions, `/work`, and `@`.",
            "- verification is structural (deliverable + evidence + review), not semantic.",
            "- a worker mid-run has no preemption point; `/abort` stops parked runs and reports so otherwise.",
            "- remote MCP (http/sse) transport is not implemented; stdio only.",
          ]),
        ),
        data: { tools: tools.length, skills: skills.length, workers: workers.length },
      };
    },
  },
  {
    id: "summary",
    title: "Work summary",
    description: "The evidence-backed work report for a day (default: today), separating work KAI verified from worker-reported claims.",
    usage: "/summary [YYYY-MM-DD [YYYY-MM-DD]]",
    args: [
      { name: "from", description: "First day (default: today)", source: "free" },
      { name: "to", description: "Last day (default: the first day)", source: "free" },
    ],
    async run(args, ctx) {
      const port = ctx.summary;
      if (port === undefined) {
        return { command: "summary", title: "Summary is unavailable here", text: "This command context has no daily-summary service." };
      }
      const out = port.report(args[0], args[1]);
      const minutes = port.offerMinutes();
      const hhmm = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
      const last = port.state().lastOfferLocalDate;
      const offerLine = last !== undefined
        ? `Daily offer: last sent for ${last}; next at ${hhmm} local — at most once per local day, and only when work happened.`
        : `Daily offer: none sent yet; it fires at ${hhmm} local — at most once per local day, and only when work happened.`;
      return {
        command: "summary",
        title: `Work summary ${out.from}${out.to !== out.from ? ` → ${out.to}` : ""}`,
        text: `${out.text}\n\n---\n\n_${offerLine}_`,
        data: out.report,
      };
    },
  },
  {
    id: "audit",
    title: "Audit an external worker report",
    description: "Paste a worker's report (or name a file) and KAI audits it against the real workspace instead of trusting it: claims, what KAI observed, and the exact next-worker prompt.",
    usage: "/audit <report text> [--file path] [--dir working-dir]",
    args: [{ name: "report", description: "The worker's report (multiline paste is fine)", source: "free" }],
    async run(args, ctx, raw) {
      const port = ctx.audit;
      if (port === undefined) {
        return { command: "audit", title: "Audit is unavailable here", text: "This command context has no orchestrator audit port." };
      }
      let text = (raw ?? args.join(" ")).trim();
      // `--dir`/`--file` take one path each; unquoted paths must have no spaces.
      let workingDir: string | undefined;
      const dirMatch = /--dir\s+("([^"]*)"|'([^']*)'|(\S+))/.exec(text);
      if (dirMatch !== null) {
        workingDir = dirMatch[2] ?? dirMatch[3] ?? dirMatch[4];
        text = text.replace(dirMatch[0], " ").trim();
      }
      let source = "pasted text";
      const fileMatch = /--file\s+("([^"]*)"|'([^']*)'|(\S+))/.exec(text);
      if (fileMatch !== null) {
        const path = fileMatch[2] ?? fileMatch[3] ?? fileMatch[4];
        text = text.replace(fileMatch[0], " ").trim();
        if (path !== undefined) {
          const read = await ctx.tools.invoke("filesystem.read", { path });
          if (!read.ok) {
            return {
              command: "audit",
              title: "Report file not readable",
              text: `Could not read \`${path}\`: ${read.error.code} — ${read.error.message}. Nothing was audited.`,
            };
          }
          const file = read.result as { content?: string; truncated?: boolean; bytes?: number } | null;
          const content = typeof file?.content === "string" ? file.content : "";
          if (content.trim().length === 0) {
            return { command: "audit", title: "Report file is empty", text: `\`${path}\` held no text. Nothing was audited.` };
          }
          text = content;
          source = file?.truncated === true
            ? `file ${path} — READ TRUNCATED at the read limit (paste the remainder if findings look partial)`
            : `file ${path}`;
        }
      }
      if (text.trim().length === 0) {
        return {
          command: "audit",
          title: "Audit needs a report",
          text: [
            "Give KAI the worker's report to audit. Nothing was audited.",
            "",
            "- `/audit <report text>` — a multiline paste is fine",
            "- `/audit --file path/to/report.md`",
            "- add `--dir /path/to/repo` so the claims can be checked against that workspace",
          ].join("\n"),
        };
      }
      const result = await port.report({
        reportText: text,
        ...(workingDir !== undefined ? { workingDir } : {}),
      });
      const lines: string[] = [];
      lines.push(
        `Source: ${source}${workingDir !== undefined ? ` · workspace: ${workingDir}` : " · no workspace given — file claims cannot be checked"}`,
      );
      lines.push("", "### What the worker claimed (UNTRUSTED)");
      lines.push(...(result.claims.length > 0 ? result.claims.map((c) => `- ${c}`) : ["- (nothing parsed as a claim)"]));
      lines.push("", "### What KAI observed itself");
      lines.push(...(result.observed.length > 0
        ? result.observed.map(
          (o) => `- ${o.kind}: ${o.detail.slice(0, 240)}${o.supports.length > 0 ? ` [settles: ${o.supports.join(", ").slice(0, 120)}]` : " [does not settle its requirement]"}`,
        )
        : ["- nothing: no safe check could be run (see the limitation)"]));
      if (result.unmetCriteria.length > 0) {
        lines.push("", "### Unmet acceptance criteria", ...result.unmetCriteria.map((c) => `- ${c}`));
      }
      if (result.missingEvidence.length > 0) {
        lines.push("", "### Missing required evidence", ...result.missingEvidence.map((e) => `- ${e}`));
      }
      if (result.reviewNotes.length > 0) {
        lines.push("", "### Reviewer findings", ...result.reviewNotes.map((f) => `- ${f}`));
      }
      if (result.blockers.length > 0) {
        lines.push("", "### Blockers the worker reported", ...result.blockers.map((b) => `- ${b}`));
      }
      if (result.limitation !== undefined) lines.push("", "### Limitation", result.limitation);
      lines.push(
        "",
        "### Launch",
        result.launched.started
          ? `KAI launched the correction as \`${result.launched.workItemId ?? "?"}\` — ${result.launched.reason}.`
          : `Not launched: ${result.launched.reason}`,
      );
      if (result.nextPrompt.length > 0) {
        lines.push("", "### Next-worker prompt (copy or edit)", "", "```", result.nextPrompt, "```");
      }
      return {
        command: "audit",
        title: result.launched.started ? "Audit complete — correction launched" : "Audit complete — findings ready",
        text: lines.join("\n"),
        data: result,
      };
    },
  },
  {
    id: "help",
    title: "Help",
    description: "Show the actual registered commands.",
    usage: "/help",
    async run(_args, _ctx) {
      return {
        command: "help",
        title: `${COMMANDS.length} commands`,
        text: [
          section(
            "KAI commands",
            lines(COMMANDS.map((command) => `- \`/${command.id}\` — ${command.description}\n  Usage: \`${command.usage}\``)),
          ),
          "",
          section("Shortcuts", lines([
            "- `Ctrl/Cmd+K` — command palette",
            "- `/` — command palette (inline)",
            "- `@` — agents + skills palette",
            "- `Enter` — send · `Shift+Enter` — newline",
            "- `Ctrl/Cmd+Shift+Enter` — plan only (drafts, runs nothing)",
            "- `Ctrl/Cmd+Shift+S` — stop the active mission/run",
            "- `Esc` — close the open popover / dialog",
          ])),
        ].join("\n"),
        data: { ids: COMMANDS.map((command) => command.id) },
      };
    },
  },
];

const BY_ID = new Map(COMMANDS.map((command) => [command.id, command]));

/** Every registered command, in catalogue order — the palette's only source. */
export function listCommands(): Array<{
  id: string;
  title: string;
  description: string;
  usage: string;
  args?: CommandArg[];
}> {
  return COMMANDS.map(({ id, title, description, usage, args }) => ({
    id,
    title,
    description,
    usage,
    ...(args !== undefined ? { args: args.map((arg) => ({ ...arg })) } : {}),
  }));
}

export function getCommand(id: string): KaiCommand | undefined {
  return BY_ID.get(id);
}

/**
 * Run one command by id. An unknown id is a VALUE (`ok: false`), never a
 * throw, so the palette can render it as "no such command".
 */
export async function runCommand(
  id: string,
  args: string[],
  ctx: CommandRuntime,
  raw?: string,
): Promise<{ ok: true; result: CommandResult } | { ok: false; reason: string }> {
  const command = BY_ID.get(id);
  if (command === undefined) {
    return { ok: false, reason: `no command "/${id}" — try /help` };
  }
  try {
    return { ok: true, result: await command.run(args, ctx, raw) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `/${id} failed: ${detail}` };
  }
}
