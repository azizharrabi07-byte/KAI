// The Goals surface: intake → challenge → plan → approval.
//
// Everything here reads REAL Core state through the typed client. There is no
// placeholder goal, no fabricated approval and no invented plan: if Core has not
// answered, the surface says so.
//
// Two properties this file exists to keep honest:
//
//   1. A goal is only shown as executable when the Core says an approval matches
//      the CURRENT revision AND the Doer is ON. The three states are distinct —
//      ELIGIBLE, PAUSED_DOER_OFF and NOT_APPROVED — because "approved but paused"
//      is not the same thing as "approved and running", and showing one badge for
//      both would be the lie this whole phase is about.
//   2. A conditional verdict is never dressed as a pass. The challenge verdict is
//      printed with its conflicts and unresolved objections beside it.

import type { ShellContext } from "../types";
import type { CoreGoalSummary, CoreResult } from "../../core/kai-core";

type El = HTMLElement;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Partial<Record<string, unknown>>,
  children?: (El | string)[],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props !== undefined) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null) continue;
      if (key === "text") node.textContent = String(value);
      else if (key === "class") node.className = String(value);
      else if (key === "html") node.innerHTML = String(value);
      else if (key.startsWith("on") && typeof value === "function") {
        node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
      } else node.setAttribute(key, String(value));
    }
  }
  for (const child of children ?? []) node.append(child);
  return node;
}

/** A row of label + value, used for the goal's stated facts. */
function field(label: string, value: string | null | undefined): El {
  return el("div", { class: "gp-field" }, [
    el("span", { class: "gp-field-label", text: label }),
    el("span", { class: "gp-field-value", text: value === undefined || value === null || value === "" ? "—" : value }),
  ]);
}

function list(label: string, values: readonly string[]): El {
  return el("div", { class: "gp-field" }, [
    el("span", { class: "gp-field-label", text: label }),
    el(
      "span",
      { class: "gp-field-value" },
      values.length === 0 ? ["—"] : values.map((v) => el("span", { class: "gp-chip", text: v })),
    ),
  ]);
}

/** The one badge that must never overstate what KAI is allowed to do. */
function eligibilityBadge(goal: CoreGoalSummary): El {
  const map: Record<string, { text: string; cls: string }> = {
    ELIGIBLE: { text: "Approved — eligible to run", cls: "gp-ok" },
    PAUSED_DOER_OFF: { text: "Approved — PAUSED (KAI Doer is OFF)", cls: "gp-paused" },
    NOT_APPROVED: { text: "Not approved — nothing may be dispatched", cls: "gp-blocked" },
  };
  const entry = map[goal.eligibility] ?? { text: goal.eligibility, cls: "gp-blocked" };
  return el("span", { class: `gp-badge ${entry.cls}`, text: entry.text });
}

function verdictBadge(verdict: string): El {
  const cls =
    verdict === "PASS" ? "gp-ok" : verdict === "CONDITIONAL" ? "gp-paused" : verdict === "REVISE" ? "gp-revise" : "gp-blocked";
  return el("span", { class: `gp-badge ${cls}`, text: `Challenge: ${verdict}` });
}

export interface GoalsSurfaceOptions {
  /** Called after any mutation so the shell can refresh its own views. */
  onChanged?: () => void;
}

export function buildGoalsView(container: El, ctx: ShellContext, options: GoalsSurfaceOptions = {}): { refresh: () => void } {
  const client = ctx.client;
  const listHost = el("div", { class: "gp-list" });
  const detailHost = el("div", { class: "gp-detail" });
  let selected: string | null = null;
  let goals: CoreGoalSummary[] = [];
  let busy = false;

  /** Report a Core refusal verbatim — never as a silent no-op. */
  function showFailure(host: El, result: CoreResult<unknown>): void {
    if (result.ok) return;
    const status = result.error.status === undefined ? "" : ` (HTTP ${result.error.status})`;
    host.append(el("div", { class: "gp-error", text: `${result.error.message}${status}` }));
  }

  async function run(action: () => Promise<CoreResult<unknown>>, host: El): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      const result = await action();
      showFailure(host, result);
    } finally {
      busy = false;
      options.onChanged?.();
      await refresh();
    }
  }

  function renderIntake(): El {
    const intent = el("textarea", {
      class: "gp-intent",
      rows: "3",
      placeholder: "Describe the outcome you want. KAI will challenge it, plan it, and wait for your approval before anything runs.",
    }) as HTMLTextAreaElement;
    const status = el("div", { class: "gp-status" });
    const button = el("button", { class: "gp-primary", type: "button", text: "Create goal" });
    button.addEventListener("click", () => {
      const text = intent.value.trim();
      if (text.length === 0) {
        status.textContent = "A goal needs an intent.";
        return;
      }
      status.textContent = "";
      void run(() => client.createGoal(text), status).then(() => {
        intent.value = "";
      });
    });
    return el("div", { class: "gp-intake" }, [
      el("div", { class: "gp-section-title", text: "New goal" }),
      intent,
      el("div", { class: "gp-row" }, [button]),
      status,
    ]);
  }

  function renderDetail(goal: CoreGoalSummary): El {
    const host = el("div", { class: "gp-card" });
    host.append(
      el("div", { class: "gp-card-head" }, [
        el("div", { class: "gp-title", text: goal.statement }),
        eligibilityBadge(goal),
        el("span", { class: "gp-badge gp-neutral", text: `State: ${goal.state}` }),
      ]),
    );

    // What KAI knows, what it assumes, and what it does not know. An empty list
    // is shown as empty, not hidden.
    host.append(
      el("div", { class: "gp-facts" }, [
        list("Assumptions", goal.assumptions),
        list("Uncertainties", goal.uncertainties),
        list("Constraints", goal.constraints),
        field("Blocker", goal.blocker),
      ]),
    );

    if (goal.challenge !== undefined) {
      const c = goal.challenge;
      const panel = el("div", { class: "gp-challenge" }, [
        el("div", { class: "gp-section-title", text: "Challenge panel" }),
        el("div", { class: "gp-row" }, [
          verdictBadge(c.verdict),
          el("span", { class: "gp-badge gp-neutral", text: `${c.mode} · ${c.rounds} round(s)` }),
          el("span", { class: "gp-badge gp-neutral", text: `revision ${c.goalRevisionId.slice(0, 12)}` }),
        ]),
      ]);
      // Conflicting findings are shown as conflicts — never averaged into a
      // comfortable single score.
      if (c.synthesis.conflicts.length > 0) panel.append(list("Unresolved disagreement", c.synthesis.conflicts));
      if (c.synthesis.unresolved.length > 0) panel.append(list("Unanswered", c.synthesis.unresolved));
      if (c.synthesis.criticalRisks.length > 0) panel.append(list("Critical risks", c.synthesis.criticalRisks));
      for (const finding of c.findings) {
        if (finding.objections.length === 0) continue;
        const block = el("div", { class: "gp-finding" }, [
          el("div", { class: "gp-finding-role", text: `${finding.role} — ${finding.verdict}` }),
        ]);
        for (const objection of finding.objections) {
          block.append(
            el("div", { class: "gp-objection" }, [
              el("div", { class: "gp-objection-text", text: objection.statement }),
              el("div", {
                class: "gp-objection-meta",
                text: `${objection.severity}${objection.blocking ? " · BLOCKING" : ""} — fix: ${objection.remediation || "(none proposed)"}`,
              }),
            ]),
          );
        }
        panel.append(block);
      }
      host.append(panel);
    }

    const revision = goal.currentRevision;
    if (revision !== null) {
      const plan = el("div", { class: "gp-plan" }, [
        el("div", { class: "gp-section-title", text: `Plan — revision ${revision.version} (${revision.contentHash.slice(0, 10)})` }),
        el("div", { class: "gp-plan-summary", text: revision.content.summary }),
        list("Deliverables", revision.content.deliverables),
        list("Acceptance criteria", revision.content.acceptanceCriteria),
        list("Required evidence", revision.content.requiredEvidence),
        list("Uncertainties", revision.content.uncertainties),
        field(
          "Budgets",
          `max ${revision.content.budgets.maxTasks} tasks · ${revision.content.budgets.maxRetries} retries · depth ${revision.content.budgets.maxDepth}`,
        ),
      ]);
      for (const task of revision.content.tasks) {
        plan.append(
          el("div", { class: "gp-task" }, [
            el("div", { class: "gp-task-title", text: `${task.title} (${task.role})` }),
            el("div", { class: "gp-task-objective", text: task.objective }),
            list("Verify", task.verification),
            task.dependsOn.length > 0 ? list("Depends on", task.dependsOn) : el("span"),
          ]),
        );
      }
      host.append(plan);
    }

    // Actions, gated by the real state — the surface never offers a button whose
    // Core call the current state would refuse.
    const actions = el("div", { class: "gp-actions" });
    const status = el("div", { class: "gp-status" });
    const addAction = (label: string, enabled: boolean, action: () => Promise<CoreResult<unknown>>): void => {
      const button = el("button", { class: "gp-action", type: "button", text: label });
      if (!enabled) button.setAttribute("disabled", "disabled");
      button.addEventListener("click", () => void run(action, status));
      actions.append(button);
    };

    addAction("Quick challenge", goal.state === "DRAFT" || goal.state === "UNDERSTANDING" || goal.state === "REVISION_REQUIRED", () =>
      client.challengeGoal(goal.id, "QUICK"),
    );
    addAction("Deep challenge", goal.state === "DRAFT" || goal.state === "UNDERSTANDING" || goal.state === "REVISION_REQUIRED", () =>
      client.challengeGoal(goal.id, "DEEP"),
    );
    addAction("Propose plan", goal.state === "READY_FOR_PLAN" || goal.state === "CONDITIONAL", () => client.planGoal(goal.id));
    addAction("Approve this revision", goal.state === "AWAITING_PLAN_APPROVAL" && revision !== null, () =>
      client.approvePlan(goal.id, revision?.id),
    );
    addAction("Reject plan", goal.state === "AWAITING_PLAN_APPROVAL", () => client.rejectPlan(goal.id));
    addAction("Cancel goal", !["COMPLETED", "FAILED", "CANCELLED"].includes(goal.state), () =>
      client.setGoalState(goal.id, "CANCELLED"),
    );

    host.append(actions, status);
    return host;
  }

  function renderList(): void {
    listHost.replaceChildren();
    if (goals.length === 0) {
      listHost.append(el("div", { class: "gp-empty", text: "No goals yet." }));
      return;
    }
    for (const goal of goals) {
      const row = el("button", { class: `gp-row-item${goal.id === selected ? " gp-selected" : ""}`, type: "button" }, [
        el("span", { class: "gp-row-title", text: goal.statement.slice(0, 80) }),
        el("span", { class: "gp-badge gp-neutral", text: goal.state }),
        eligibilityBadge(goal),
      ]);
      row.addEventListener("click", () => {
        selected = goal.id;
        renderList();
        renderDetailFor(goal.id);
      });
      listHost.append(row);
    }
  }

  function renderDetailFor(id: string): void {
    detailHost.replaceChildren();
    const goal = goals.find((g) => g.id === id);
    if (goal === undefined) return;
    detailHost.append(renderDetail(goal));
  }

  async function refresh(): Promise<void> {
    const result = await client.listGoals();
    if (!result.ok) {
      listHost.replaceChildren(el("div", { class: "gp-error", text: `Could not read goals: ${result.error.message}` }));
      detailHost.replaceChildren();
      return;
    }
    goals = result.value;
    if (selected !== null && !goals.some((g) => g.id === selected)) selected = null;
    renderList();
    if (selected === null && goals.length > 0) selected = goals[0]!.id;
    if (selected !== null) renderDetailFor(selected);
    else detailHost.replaceChildren();
  }

  container.replaceChildren(
    el("div", { class: "gp-head" }, [
      el("div", { class: "gp-head-title", text: "Goals" }),
      el("div", {
        class: "gp-head-blurb",
        text: "A goal is challenged, planned and approved before anything is dispatched. The KAI Doer decides whether approved work runs.",
      }),
    ]),
    renderIntake(),
    el("div", { class: "gp-body" }, [listHost, detailHost]),
  );

  void refresh();
  return { refresh: () => void refresh() };
}
