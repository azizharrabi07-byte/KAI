// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The command route surface — `registerCommandRoutes(app, { runtime })`.
 *
 * Two routes, same in-place wrapper pattern as the session surface (see
 * `sessions/routes.ts`), so the live Core answers them without a restart and a
 * second registration is a no-op:
 *
 *   GET  /commands            the catalogue (id, title, description, usage)
 *   POST /commands/:id/run    execute one command ({ args?: string[] | string })
 *
 * `args` accepts an array or a raw string (split server-side with the same
 * splitter the chat input uses). A run never throws across the boundary: an
 * unknown command is 404, a failed one is 200 with `{ ok: false, reason }`,
 * because the failure is the RESULT the UI renders.
 */

import type { CoreApi, ApiRequest, ApiResponse } from "../api/routes.ts";
import type { CoreRuntime } from "../runtime.ts";
import { createPlan } from "../plans/plans.ts";
import { readOrchestrationPrefs } from "../orchestration/prefs.ts";
import { listCommands, runCommand, splitArgs, type CommandRuntime } from "./commands.ts";

export interface CommandRouteDeps {
  runtime: CoreRuntime;
}

function commandContext(runtime: CoreRuntime): CommandRuntime {
  return {
    sessions: runtime.sessions,
    tools: runtime.tools,
    skills: runtime.skills,
    providers: runtime.providers,
    mcp: { summary: () => runtime.mcp.summary(), listServers: () => runtime.mcp.listServers() },
    memory: runtime.memory,
    memoryEngine: runtime.memoryEngine,
    brain: runtime.brain,
    model: runtime.model,
    subagents: runtime.subagents,
    learning: {
      propose: (input) => runtime.orchestrator.proposeTaskSkill(input),
      submit: (candidate, markdown) => runtime.orchestrator.submitSkillProposal(candidate, markdown),
    },
    reviewer: {
      reviewWorkItem: (id, criteria) => runtime.orchestrator.reviewItem(id, criteria),
    },
    missions: {
      getMission: (id) => runtime.stores.missions.getMission(id),
    },
    orchestration: {
      workItems: (filter) => runtime.stores.workItems.list(filter ?? {}).map((w) => ({
        id: w.id,
        objective: w.objective,
        state: w.state,
        ...(w.workerId !== undefined ? { workerId: w.workerId } : {}),
        ...(w.valueScore !== undefined ? { valueScore: w.valueScore } : {}),
        retries: w.retries,
        ...(w.missionId !== undefined ? { missionId: w.missionId } : {}),
        ...(w.taskId !== undefined ? { taskId: w.taskId } : {}),
      })),
      bench: () => runtime.orchestrator.benchList().flatMap((e) => e === null ? [] : [{ profile: {
        workerId: e.profile.workerId,
        role: e.profile.role,
        overallValue: e.profile.overallValue,
        totalSamples: e.profile.totalSamples,
        overallConfidence: e.profile.overallConfidence,
      } }]),
      activity: (ref, level) => runtime.orchestrator.activityList(ref ?? {}, level),
      activeRuns: () => runtime.activeSubagentRuns().map((r) => ({
        runId: r.runId,
        subagentId: r.subagentId,
        status: r.status,
        ...(r.approvalId !== undefined ? { approvalId: r.approvalId } : {}),
        startedAt: r.startedAt,
      })),
      cancelRun: async (runId) => {
        const outcome = await runtime.cancelSubagentRun(runId);
        return outcome.ok ? { ok: true } : { ok: false, reason: outcome.reason };
      },
    },
    tasks: {
      active: (sessionId) => {
        const task = runtime.tasks.active(sessionId);
        if (task === null) return null;
        return {
          id: task.id,
          objective: task.objective,
          state: task.state,
          steps: task.steps.map((s) => ({ label: s.label, status: s.status })),
          pendingTools: task.pendingTools,
        };
      },
    },
    prefs: () => {
      const p = readOrchestrationPrefs(runtime.stores.settings);
      return { autonomy: p.autonomy, activity: p.activity, reasoning: p.reasoning };
    },
    capabilities: { list: () => runtime.capabilities.registry.list().map((c) => ({ id: c.id, ...(c.name !== undefined ? { name: c.name } : {}), ...(c.availability !== undefined ? { availability: c.availability } : {}), ...(c.provider !== undefined ? { provider: c.provider } : {}) })) },
    startWork: async (goal: string) => {
      const candidates = runtime.subagents.list().map((persona) => persona.spec.id);
      const started = runtime.orchestrator.startObjective({ objective: goal }, candidates);
      if (started.workItemId.length > 0) {
        // Drive it in the background through the real loop; the work board is
        // the source of truth, the command returns immediately with the id.
        void runtime.orchestrator.runWorkItem(started.workItemId).catch(() => undefined);
      }
      return { ok: true, workItemId: started.workItemId, note: started.note };
    },
    workers: async () => {
      const statuses = await runtime.registry.statusAll();
      return statuses.map((entry) => ({
        id: entry.id,
        state: entry.state,
        ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
      }));
    },
    summary: {
      report: (fromDay, toDay) => runtime.summary.reportFor(fromDay, toDay),
      state: () => runtime.summary.state(),
      offerMinutes: () => runtime.summary.offerMinutes(),
      today: () => runtime.summary.today(),
    },
    audit: {
      report: (input) => runtime.orchestrator.auditExternalReport(input),
    },
    createPlan: async (goal: string) => {
      const subagents = runtime.subagents.list().map((persona) => persona.spec.id);
      const workers = (await runtime.registry.statusAll().catch(() => [] as Array<{ id: string }>)).map((w) => w.id);
      const outcome = await createPlan(goal, {
        model: runtime.model,
        tools: runtime.tools,
        agentIds: [...subagents, ...workers],
        upsertMission: (mission) => runtime.stores.missions.upsertMission(mission),
        publish: (type, payload, opts) =>
          runtime.bus.publish(type, payload, {
            source: "core",
            ...(opts?.missionId !== undefined ? { missionId: opts.missionId } : {}),
          }),
      });
      return outcome;
    },
  };
}

function ok(body: unknown): ApiResponse {
  return { status: 200, body };
}

function notFound(reason: string): ApiResponse {
  return { status: 404, body: { error: true, reason } };
}

export function buildCommandRoutes(runtime: CoreRuntime): Array<{
  method: string;
  pattern: string;
  segments: string[];
  handler: (request: ApiRequest, params: Record<string, string>) => Promise<ApiResponse>;
}> {
  return [
    {
      method: "GET",
      pattern: "/commands",
      segments: ["commands"],
      handler: () => Promise.resolve(ok({ commands: listCommands() })),
    },
    {
      method: "POST",
      pattern: "/commands/:id/run",
      segments: ["commands", ":id", "run"],
      handler: (request, params) => {
        const id = params.id ?? "";
        const body =
          typeof request.body === "object" && request.body !== null
            ? (request.body as Record<string, unknown>)
            : {};
        const rawArgs = body["args"];
        const args =
          typeof rawArgs === "string" ? splitArgs(rawArgs) : Array.isArray(rawArgs) ? rawArgs.filter((entry) => typeof entry === "string") : [];
        // `raw` is the argument text EXACTLY as typed (newlines intact). It is
        // optional and additive: commands that take free-form multiline input
        // (a pasted external report for /audit) read it; the rest ignore it.
        const raw = typeof body["raw"] === "string" ? body["raw"] : undefined;
        return runCommand(id, args, commandContext(runtime), raw).then((outcome) => {
          if (!outcome.ok) {
            // Unknown command: 404. A command that RAN and failed is 200 with
            // ok:false — the failure is data the UI renders, not a transport error.
            return notFound(outcome.reason);
          }
          return ok({ ok: true, result: outcome.result });
        });
      },
    },
  ];
}

const WRAPPED_KEY = "__kaiCommandRoutesWrapped";

export function registerCommandRoutes(app: CoreApi, deps: CommandRouteDeps): string[] {
  const defs = buildCommandRoutes(deps.runtime);
  const marker = app.handle as unknown as Record<string, unknown>;
  if (marker[WRAPPED_KEY] !== true) {
    const original = app.handle;
    const wrapper = async (request: ApiRequest): Promise<ApiResponse> => {
      const method = typeof request.method === "string" ? request.method.toUpperCase() : "";
      const rawPath = typeof request.path === "string" ? request.path : "/";
      const path = rawPath.split("?")[0] ?? "/";
      const segs = path.split("/").filter((s) => s.length > 0);
      for (const def of defs) {
        if (def.method !== method || def.segments.length !== segs.length) continue;
        const params: Record<string, string> = {};
        let matched = true;
        for (let i = 0; i < segs.length; i += 1) {
          const pattern = def.segments[i];
          const actual = segs[i];
          if (pattern === undefined || actual === undefined) {
            matched = false;
            break;
          }
          if (pattern.startsWith(":")) params[pattern.slice(1)] = decodeURIComponent(actual);
          else if (pattern !== actual) {
            matched = false;
            break;
          }
        }
        if (matched) {
          try {
            return await def.handler(request, params);
          } catch {
            return { status: 500, body: { error: true, reason: `internal error while handling ${method} ${path}` } };
          }
        }
      }
      return original.call(app, request);
    };
    (wrapper as unknown as Record<string, unknown>)[WRAPPED_KEY] = true;
    app.handle = wrapper;
  }
  return defs.map((def) => `${def.method} ${def.pattern}`);
}
