/**
 * agents/create.ts — the persona creation / edit flow.
 *
 * A persona is a real Core object: this form collects exactly the spec fields
 * `POST /subagents` accepts (id, name, role, soul, workerId, model, capabilities,
 * visual) and hands them to the store, which posts them to Core. Nothing is
 * registered frontend-only — the created persona appears in `GET /subagents` or
 * it was not created.
 *
 * Field vocabulary maps onto the owner's words:
 *   name          → name
 *   role/purpose  → role
 *   soul/personality → soul
 *   worker        → workerId (the worker Core runs the persona on)
 *   capabilities  → capabilities (grants, chosen from Core's catalogue)
 *   memory scope  → derived, read-only: `kai:<id>` (the persona's own bucket)
 *   appearance    → visual (a KAI_VARIANT bundle + this persona's own colour)
 */

import { el, clear, button, section, muted, input, textarea, select } from "./ui";
import { KAI_VARIANTS, findPreset, describeVariant } from "../character/variant";
import type { AgentsStore } from "./store";
import type { Subagent } from "./api";

export interface AgentFormOptions {
  mode: "create" | "edit";
  /** The persona being edited (edit mode). */
  agent?: Subagent;
  onDone(): void;
  onCancel(): void;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export function renderAgentForm(store: AgentsStore, options: AgentFormOptions): { el: HTMLElement; destroy(): void } {
  const editing = options.mode === "edit" && options.agent !== undefined ? options.agent : undefined;
  const declared = (editing?.visual?.declared ?? {}) as Record<string, unknown>;

  const nameField = input("e.g. Researcher");
  nameField.value = editing?.name ?? "";
  const idField = input("researcher");
  idField.value = editing?.id ?? "";
  idField.disabled = editing !== undefined; // an id is the persona's identity; editing it is a duplicate, not an edit
  const roleField = input("e.g. researcher — reads carefully and cites what it finds");
  roleField.value = editing?.role ?? "";
  const soulField = textarea("I am …, KAI's … . How I work, what I refuse, how I signal uncertainty.", 5);
  soulField.value = editing?.soul ?? "";
  const descriptionField = input("e.g. Competitive research specialist");
  descriptionField.value = editing?.description ?? "";
  const objectiveField = textarea("What this agent is responsible for, e.g. Research Tunisian competitors and produce a structured comparison with evidence.", 3);
  objectiveField.value = editing?.objective ?? "";
  const instructionsField = textarea("How it should behave, e.g. Be skeptical of unsupported claims, cite sources, return concise structured reports.", 4);
  instructionsField.value = editing?.instructions ?? "";
  const modelField = input("optional — e.g. sonnet");
  modelField.value = editing?.model ?? "";

  // Memory scope is derived, never invented.
  const scopeLine = el("code", {
    text: editing?.employeeId ?? "kai:<id>",
    style: "font:400 11.5px var(--mono,monospace);color:#8b93a1",
  });

  function refreshScope(): void {
    const id = editing?.id ?? slugify(nameField.value);
    scopeLine.textContent = id.length > 0 ? `kai:${id}` : "kai:<id>";
  }
  nameField.addEventListener("input", () => {
    if (editing === undefined) refreshScope();
  });

  // ── worker ──────────────────────────────────────────────────────────────────
  const workers = store.getState().workers;
  const workerOptions = workers.length > 0
    ? workers.map((w) => ({ value: w.id, label: `${w.id} (${w.state})` }))
    : [{ value: editing?.workerId ?? "hermes", label: editing?.workerId ?? "hermes" }];
  const workerSelect = select(workerOptions, editing?.workerId ?? workerOptions[0]?.value);

  // ── capabilities ────────────────────────────────────────────────────────────
  const caps = store.getState().capabilities;
  const chosenCaps = new Set<string>(editing?.capabilities ?? []);
  const capBox = el("div", { style: "display:flex;flex-wrap:wrap;gap:6px" });
  if (caps.length === 0) {
    capBox.append(muted("Core reported no capabilities."));
  } else {
    for (const cap of caps) {
      const on = chosenCaps.has(cap.id);
      const toggle = el("button", {
        type: "button",
        style:
          `font:500 11px var(--font,system-ui);padding:4px 9px;border-radius:8px;cursor:pointer;` +
          (on
            ? "background:rgba(99,102,241,0.26);border:1px solid rgba(99,102,241,0.6);color:#dfe3ff"
            : "background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.12);color:#9aa0aa"),
      });
      toggle.append(
        el("span", { text: cap.id }),
        el("span", { text: ` · ${cap.risk.toLowerCase()}`, style: "color:#6b7280" }),
      );
      toggle.addEventListener("click", () => {
        if (chosenCaps.has(cap.id)) chosenCaps.delete(cap.id);
        else chosenCaps.add(cap.id);
        const now = chosenCaps.has(cap.id);
        toggle.setAttribute(
          "style",
          `font:500 11px var(--font,system-ui);padding:4px 9px;border-radius:8px;cursor:pointer;` +
            (now
              ? "background:rgba(99,102,241,0.26);border:1px solid rgba(99,102,241,0.6);color:#dfe3ff"
              : "background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.12);color:#9aa0aa"),
        );
      });
      capBox.append(toggle);
    }
  }

  // ── appearance ──────────────────────────────────────────────────────────────
  const variantOptions = [
    { value: "", label: "— none (this persona's own colour only) —" },
    ...KAI_VARIANTS.map((v) => ({ value: v.id, label: describeVariant(v) })),
  ];
  const variantSelect = select(variantOptions, typeof declared.variant === "string" ? declared.variant : "");
  const colourField = input("#33bbaa");
  if (typeof declared.colour === "string") colourField.value = declared.colour;
  const outfitField = input("e.g. lab coat");
  if (typeof declared.outfit === "string") outfitField.value = declared.outfit;
  const accessoryField = input("comma-separated, e.g. glasses,headset");
  if (Array.isArray(declared.accessories)) accessoryField.value = (declared.accessories as string[]).join(",");

  const preview = el("div", { style: "display:flex;align-items:center;gap:8px" });
  function refreshPreview(): void {
    clear(preview);
    const preset = findPreset(variantSelect.value);
    const colour = colourField.value.trim() || preset?.primaryColor || "#8B93A1";
    preview.append(
      el("i", {
        style: `display:inline-block;width:16px;height:16px;border-radius:50%;background:${colour};box-shadow:0 0 10px ${colour}66`,
      }),
      el("span", {
        text: preset !== undefined ? describeVariant(preset) : colourField.value.trim() || "no variant resolved",
        style: "font:400 11px var(--font,system-ui);color:#9aa0aa",
      }),
    );
  }
  variantSelect.addEventListener("change", refreshPreview);
  colourField.addEventListener("input", refreshPreview);

  const errorLine = el("div", { style: "font:400 11px var(--font,system-ui);color:#f4505e;min-height:14px" });

  function collect(): { ok: true; spec: Parameters<AgentsStore["create"]>[0] } | { ok: false; reason: string } {
    const name = nameField.value.trim();
    const id = editing?.id ?? (idField.value.trim() || slugify(name));
    const role = roleField.value.trim();
    const soul = soulField.value.trim();
    const description = descriptionField.value.trim();
    const objective = objectiveField.value.trim();
    const instructions = instructionsField.value.trim();
    const workerId = workerSelect.value;
    if (name.length === 0) return { ok: false, reason: "A name is required." };
    if (id.length === 0) return { ok: false, reason: "An id is required (letters, digits, - and _)." };
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) return { ok: false, reason: "The id must match [a-z0-9][a-z0-9_-]{0,63}." };
    if (role.length === 0) return { ok: false, reason: "A role/purpose is required." };
    if (soul.length === 0) return { ok: false, reason: "A soul is required — it is the persona's personality." };
    if (workerId.length === 0) return { ok: false, reason: "A worker is required." };
    const visual: Record<string, unknown> = {};
    if (variantSelect.value.length > 0) visual.variant = variantSelect.value;
    if (colourField.value.trim().length > 0) visual.colour = colourField.value.trim();
    if (outfitField.value.trim().length > 0) visual.outfit = outfitField.value.trim();
    const accessories = accessoryField.value
      .split(",")
      .map((a) => a.trim())
      .filter((a) => a.length > 0);
    if (accessories.length > 0) visual.accessories = accessories;
    const spec: Parameters<AgentsStore["create"]>[0] = {
      id,
      name,
      role,
      soul,
      workerId,
      capabilities: [...chosenCaps],
    };
    if (description.length > 0) spec.description = description;
    if (objective.length > 0) spec.objective = objective;
    if (instructions.length > 0) spec.instructions = instructions;
    if (modelField.value.trim().length > 0) spec.model = modelField.value.trim();
    if (Object.keys(visual).length > 0) spec.visual = visual;
    return { ok: true, spec };
  }

  async function submit(): Promise<void> {
    const collected = collect();
    if (!collected.ok) {
      errorLine.textContent = collected.reason;
      return;
    }
    errorLine.textContent = "";
    const ok =
      editing !== undefined
        ? await store.update(editing.id, collected.spec)
        : (await store.create(collected.spec)) !== null;
    if (ok) options.onDone();
    else errorLine.textContent = store.getState().notice?.text ?? "Core refused the change.";
  }

  const el0 = el(
    "div",
    { class: "kai-agents-form", style: "display:flex;flex-direction:column;gap:16px;padding:18px;max-width:760px" },
    el("h2", {
      text: editing !== undefined ? `Edit ${editing.name}` : "New agent",
      style: "margin:0;font:600 18px var(--font,system-ui);color:var(--ink,#f5f6f8)",
    }),
    el("p", {
      text:
        editing !== undefined
          ? "Re-defining the persona replaces it. KAI remains the authority; the persona is registered in the one workforce."
          : "A persona is a real Core object registered in KAI's one workforce. It acts only through KAI's policy and approvals.",
      style: "margin:0;font:400 12px var(--font,system-ui);color:#8b93a1",
    }),
    section("Identity", field("Name", nameField), field("Id", idField), field("Role / purpose", roleField), field("Description", descriptionField)),
    section("Soul & personality", soulField),
    section(
      "Objective — what this agent is responsible for",
      objectiveField,
      muted("Persistent. Carried into every run after KAI's immutable authority lines; it directs the work, never the policy."),
    ),
    section(
      "System instructions — how it behaves",
      instructionsField,
      muted("User-editable prompt material only. Tools, policy and approvals are enforced outside the prompt and cannot be waived in prose."),
    ),
    section(
      "Worker",
      field("Runs on", workerSelect),
      field("Model", modelField),
    ),
    section("Capabilities — the tools this persona may reach", capBox),
    section(
      "Memory scope",
      field("Own bucket", scopeLine),
      muted("Derived from the id. A persona's turns and memory never merge into KAI's."),
    ),
    section(
      "Appearance",
      field("Variant", variantSelect),
      field("Colour", colourField),
      field("Outfit", outfitField),
      field("Accessories", accessoryField),
      preview,
    ),
    errorLine,
    el(
      "div",
      { style: "display:flex;gap:8px" },
      button(editing !== undefined ? "Save" : "Create agent", "primary", () => void submit()),
      button("Cancel", "secondary", () => options.onCancel()),
    ),
  );

  refreshScope();
  refreshPreview();

  return { el: el0, destroy: () => undefined };
}

function field(label: string, control: HTMLElement): HTMLElement {
  return el(
    "div",
    { style: "display:flex;gap:10px;align-items:center;min-width:0" },
    el("span", { text: label, style: "flex:0 0 108px;font:400 11px var(--font,system-ui);color:#6b7280" }),
    control,
  );
}
