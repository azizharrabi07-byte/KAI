// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * subagent.ts — KAI's own subordinate personas.
 *
 * ── What a subagent IS, and what it deliberately is not ───────────────────────
 *
 * A subagent is a *persona KAI owns*: a name, a role, a soul/personality, a visual
 * identity, a preferred worker/model and a declared set of capabilities. It is NOT a
 * second execution path, a second registry, a second policy engine or a second
 * approval service. It is a thin layer on top of the EXISTING workforce: a subagent
 * is registered as an `EmployeeDescriptor` in the one `WorkforceManager`, its
 * capabilities are pushed into the one `CapabilityManager`, and every task it runs
 * is handed to the one policy-governed `executeTask` the runtime injects.
 *
 * That is the whole safety argument, and it is structural rather than a promise:
 *
 *   - `delegate()` on the workforce manager already REFUSES when no policy-governed
 *     executor is wired (`manager.ts`, "Refuse rather than bypass"). A subagent runs
 *     through exactly that path, so a subagent cannot be a hole around it.
 *   - A subagent's instance carries the UNDERLYING WORKER'S ADAPTER, and nothing
 *     else. The manager requires an adapter before it will call `executeTask`, so a
 *     subagent whose preferred worker is unavailable is simply not delegate-able —
 *     it reports UNAVAILABLE rather than inventing a way to run.
 *   - The persona never touches the tool registry, the policy engine or the approval
 *     service directly. It has no handle to them. Its soul is data, its capabilities
 *     are a declaration the capability manager adjudicates, and its execution is the
 *     runtime's `executeTask` (validate -> policy -> approval -> execute).
 *
 * The hierarchy this expresses is: KAI -> (KAI itself, subagent A, subagent B, …,
 * external workers: Hermes, OpenCode, …). Subagents sit UNDER KAI and beside the
 * external workers; they are KAI's, and KAI remains the authority.
 *
 * ── The visual half is a reference, not a table ───────────────────────────────
 *
 * Colour / skin / outfit / accessories / visual identity are carried as a `visual`
 * reference — most importantly a `variant` id that names a bundle owned by the
 * KAI_VARIANT asset model (app/character). This module deliberately does NOT copy an
 * asset table: the variant resolver seam (`KaiVariantResolver`) is where the variant
 * model is called, and when it is not wired the raw reference is still preserved so a
 * UI can render the persona's intent honestly.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { isNonEmptyString, isRecord, nowIso } from "../shared/contracts.ts";
import type {
  AgentAdapter,
  CapabilityId,
  EmployeeDescriptor,
  KaiError,
  KaiErrorCode,
} from "../shared/contracts.ts";
import { normalizeCapabilities, makeInstance, makeSnapshot } from "./employee.ts";
import { employeeError } from "./lifecycle.ts";
import { redactText } from "../redact/index.ts";
import { presentWorkerResult } from "../chat/relay.ts";

/** Subagent employee ids are namespaced, so one can never shadow a real worker. */
export const SUBAGENT_ID_PREFIX = "kai:";

/** The workforce id a subagent registers under. Idempotent for an already-prefixed id. */
export function subagentEmployeeId(id: string): string {
  return id.startsWith(SUBAGENT_ID_PREFIX) ? id : `${SUBAGENT_ID_PREFIX}${id}`;
}

/**
 * The visual half of a persona. Every field is an OPTIONAL REFERENCE the character
 * model resolves; none of them is an asset table. `variant` is the load-bearing one:
 * it names a KAI_VARIANT bundle, which is what makes colour/skin/outfit an owned
 * asset rather than a hex string duplicated in three places.
 */
export interface SubagentVisual {
  /** A KAI_VARIANT bundle id, resolved by the variant model. */
  variant?: string;
  /** Fallback hints when no variant is resolved. References, not assets. */
  colour?: string;
  skin?: string;
  outfit?: string;
  accessories?: readonly string[];
  /** Free-form visual notes (e.g. a silhouette brief) carried to the renderer. */
  notes?: string;
}

export interface KaiSubagentSpec {
  /** Short id, e.g. "researcher". Namespaced to `kai:researcher` when registered. */
  id: string;
  name: string;
  role: string;
  /** One-line description, shown in lists. Never sent to the worker. */
  description?: string;
  /** The persona's own soul/personality text. Carried into its turns, redacted. */
  soul: string;
  /**
   * WHAT the agent is responsible for ("Research Tunisian competitors…").
   * Persistent, editable, and carried into every run AFTER the immutable
   * authority lines — it directs the work, it never overrides policy.
   */
  objective?: string;
  /**
   * HOW the agent behaves while doing its objective (custom system
   * instructions). Same position and same rule as the objective: prompt
   * material only, enforced by the registry boundary outside the prompt.
   */
  instructions?: string;
  /** The worker this persona runs on ("hermes", "opencode", …). */
  workerId: string;
  /** Preferred model for that worker, when it takes one. */
  model?: string;
  capabilities: readonly CapabilityId[];
  visual?: SubagentVisual;
}

/** A validated spec plus the workforce id it was registered under. */
export interface KaiSubagent {
  spec: KaiSubagentSpec;
  employeeId: string;
  createdAt: string;
}

export interface SubagentResult<T = KaiSubagent> {
  ok: boolean;
  value?: T;
  error?: KaiError;
}

/**
 * How the persona layer resolves a KAI_VARIANT bundle. The variant model (the visual
 * half, app/character) satisfies this; this module never owns an asset table. When it
 * is absent the raw `visual` reference is still carried, so nothing is lost.
 */
export interface KaiVariantResolver {
  resolve(variantId: string): unknown | undefined;
}

export interface SubagentDeps {
  /** The underlying worker's adapter, or undefined when that worker is unavailable. */
  adapterFor(workerId: string): AgentAdapter | undefined;
  /** Optional: the KAI_VARIANT model, called rather than duplicated. */
  variants?: KaiVariantResolver;
}

export interface SubagentRegistry {
  /** Define (or replace) a subagent from untrusted input. Never throws. */
  define(input: unknown): SubagentResult;
  get(id: string): KaiSubagent | undefined;
  list(): KaiSubagent[];
  remove(id: string): boolean;
  /** The persona's soul, redacted. Empty string for an unknown id. */
  soul(id: string): string;
  role(id: string): string;
  visual(id: string): SubagentVisual | undefined;
  /**
   * Resolve the visual through the variant model when it is wired, returning the
   * persona's declared reference merged with whatever the model resolved.
   */
  resolveVisual(id: string): { declared?: SubagentVisual; resolved?: unknown };
  /** The employee id a subagent registers under, or null for an unknown id. */
  employeeIdOf(id: string): string | null;
}

export interface SubagentRegistryOptions {
  /** JSON file to persist specs to. Absent => in-memory only (tests). */
  path?: string;
  variants?: KaiVariantResolver;
}

// ── Validation ────────────────────────────────────────────────────────────────

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function invalid(reason: string, detail?: string): SubagentResult {
  return { ok: false, error: employeeError("VALIDATION_FAILED" as KaiErrorCode, reason, detail) };
}

function validateVisual(value: unknown): { ok: true; value: SubagentVisual } | { ok: false; reason: string } {
  if (value === undefined || value === null) return { ok: true, value: {} };
  if (!isRecord(value)) return { ok: false, reason: "visual must be an object when present" };
  const visual: SubagentVisual = {};
  for (const key of ["variant", "colour", "skin", "outfit", "notes"] as const) {
    const field = value[key];
    if (field !== undefined && typeof field !== "string") {
      return { ok: false, reason: `visual.${key} must be a string when present` };
    }
    if (typeof field === "string" && field.length > 0) visual[key] = field;
  }
  if (value.accessories !== undefined) {
    if (!Array.isArray(value.accessories)) {
      return { ok: false, reason: "visual.accessories must be an array of strings when present" };
    }
    const accessories: string[] = [];
    for (const item of value.accessories) {
      if (!isNonEmptyString(item)) return { ok: false, reason: "visual.accessories must all be non-empty strings" };
      accessories.push(item);
    }
    visual.accessories = accessories;
  }
  return { ok: true, value: visual };
}

/** Validate untrusted input (an HTTP body, a persisted row) into a spec. */
export function validateSubagentSpec(input: unknown): { ok: true; value: KaiSubagentSpec } | { ok: false; reason: string } {
  if (!isRecord(input)) return { ok: false, reason: "a subagent must be a JSON object" };
  if (!isNonEmptyString(input.id) || !ID_RE.test(input.id)) {
    return { ok: false, reason: "id must match [a-z0-9][a-z0-9_-]{0,63}" };
  }
  if (!isNonEmptyString(input.name)) return { ok: false, reason: "name must be a non-empty string" };
  if (!isNonEmptyString(input.role)) return { ok: false, reason: "role must be a non-empty string" };
  if (!isNonEmptyString(input.soul)) return { ok: false, reason: "soul must be a non-empty string" };
  if (!isNonEmptyString(input.workerId)) return { ok: false, reason: "workerId must be a non-empty string" };
  // Objective / instructions / description: user-authored prompt material.
  // Bounded and trimmed; emptiness means absent. They are validated as TEXT
  // only — their authority comes from WHERE they are placed in the preamble
  // (after the immutable harness lines), never from their content.
  const textField = (
    value: unknown,
    label: string,
    max: number,
  ): { ok: true; value?: string } | { ok: false; reason: string } => {
    if (value === undefined) return { ok: true };
    if (typeof value !== "string" || value.trim().length === 0) {
      return { ok: false, reason: `${label} must be a non-empty string when present` };
    }
    if (value.trim().length > max) {
      return { ok: false, reason: `${label} must be at most ${max} characters` };
    }
    return { ok: true, value: value.trim() };
  };
  const description = textField(input.description, "description", 500);
  if (!description.ok) return { ok: false, reason: description.reason };
  const objective = textField(input.objective, "objective", 2000);
  if (!objective.ok) return { ok: false, reason: objective.reason };
  const instructions = textField(input.instructions, "instructions", 4000);
  if (!instructions.ok) return { ok: false, reason: instructions.reason };
  if (input.model !== undefined && !isNonEmptyString(input.model)) {
    return { ok: false, reason: "model must be a non-empty string when present" };
  }
  if (input.capabilities !== undefined && !Array.isArray(input.capabilities)) {
    return { ok: false, reason: "capabilities must be an array of strings when present" };
  }
  const capabilities = normalizeCapabilities(
    Array.isArray(input.capabilities) ? (input.capabilities as CapabilityId[]) : undefined,
  );
  if (Array.isArray(input.capabilities) && capabilities.length !== input.capabilities.length) {
    return { ok: false, reason: "capabilities must all be non-empty strings" };
  }
  const visual = validateVisual(input.visual);
  if (!visual.ok) return { ok: false, reason: visual.reason };

  const spec: KaiSubagentSpec = {
    id: input.id,
    name: input.name,
    role: input.role,
    soul: input.soul,
    workerId: input.workerId,
    capabilities,
  };
  if (description.value !== undefined) spec.description = description.value;
  if (objective.value !== undefined) spec.objective = objective.value;
  if (instructions.value !== undefined) spec.instructions = instructions.value;
  if (typeof input.model === "string" && input.model.length > 0) spec.model = input.model;
  if (Object.keys(visual.value).length > 0) spec.visual = visual.value;
  return { ok: true, value: spec };
}

// ── Registry ──────────────────────────────────────────────────────────────────

export function createSubagentRegistry(options: SubagentRegistryOptions = {}): SubagentRegistry {
  const records = new Map<string, KaiSubagent>();
  const path = options.path;
  const variants = options.variants;

  /** Load persisted specs once. A corrupt or missing file is empty, never an error. */
  function loadPersisted(): void {
    if (path === undefined) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return; // absent or unreadable: a first run, not a failure
    }
    if (!Array.isArray(parsed)) return;
    for (const row of parsed) {
      const validated = validateSubagentSpec(row);
      if (!validated.ok) continue; // drop a malformed row rather than refuse to start
      const spec = validated.value;
      records.set(spec.id, {
        spec,
        employeeId: subagentEmployeeId(spec.id),
        createdAt: nowIso(),
      });
    }
  }

  function persist(): void {
    if (path === undefined) return;
    try {
      writeFileSync(path, JSON.stringify([...records.values()].map((r) => r.spec), null, 2), "utf8");
    } catch {
      // A read-only home must not take the workforce down; the registry still holds it.
    }
  }

  loadPersisted();

  function define(input: unknown): SubagentResult {
    const validated = validateSubagentSpec(input);
    if (!validated.ok) return invalid(validated.reason);
    const spec = validated.value;
    // Re-defining an existing id replaces the persona: a persona is configuration,
    // and "edit then re-define" is the owner's control surface. No duplicate hazard.
    records.set(spec.id, { spec, employeeId: subagentEmployeeId(spec.id), createdAt: nowIso() });
    persist();
    return { ok: true, value: records.get(spec.id) };
  }

  return {
    define,
    get: (id) => records.get(id),
    list: () => [...records.values()],
    remove: (id) => {
      const deleted = records.delete(id);
      if (deleted) persist();
      return deleted;
    },
    soul: (id) => {
      const rec = records.get(id);
      return rec === undefined ? "" : redactText(rec.spec.soul).trim();
    },
    role: (id) => records.get(id)?.spec.role ?? "",
    visual: (id) => records.get(id)?.spec.visual,
    resolveVisual: (id) => {
      const rec = records.get(id);
      if (rec === undefined) return {};
      const variantId = rec.spec.visual?.variant;
      const resolved =
        variants !== undefined && typeof variantId === "string" ? variants.resolve(variantId) : undefined;
      return {
        ...(rec.spec.visual !== undefined ? { declared: rec.spec.visual } : {}),
        ...(resolved !== undefined ? { resolved } : {}),
      };
    },
    employeeIdOf: (id) => records.get(id)?.employeeId ?? null,
  };
}

// ── Bridging a persona into the workforce ─────────────────────────────────────

/**
 * The persona preamble carried into a delegated turn. Redacted and bounded, exactly
 * like the identity soul: a persona is prompt material, so it must not become a
 * secret in a log.
 *
 * Order is the safety model: the IMMUTABLE harness lines come first, then the
 * user-editable objective and instructions. A custom instruction can direct
 * the work, but the boundary it runs under (validate -> policy -> approval ->
 * execute, owned by KAI Core outside the prompt) is not negotiable in prose.
 */
export function personaPreamble(spec: KaiSubagentSpec): string {
  const soul = redactText(spec.soul).trim();
  const objective = spec.objective !== undefined ? redactText(spec.objective).trim() : "";
  const instructions = spec.instructions !== undefined ? redactText(spec.instructions).trim() : "";
  const lines = [
    `You are acting as KAI's subagent "${spec.name}" (${spec.role}).`,
    "KAI remains the authority: you run under KAI's policy, approvals and permissions.",
  ];
  if (spec.model !== undefined) lines.push(`Preferred model: ${spec.model}.`);
  if (objective.length > 0) lines.push("", `Objective: ${objective}`);
  if (instructions.length > 0) lines.push("", `Instructions: ${instructions}`);
  if (soul.length > 0) lines.push("", soul);
  return lines.join("\n");
}

/** The persona's own first-person self-introduction, from its name and role. */
export function personaSelfLine(spec: KaiSubagentSpec): string {
  return `I'm ${spec.name}, KAI's ${spec.role}.`;
}

/** Drop the delegation preamble a worker may echo back, so the reply is the work. */
function stripDelegationPreamble(raw: string): string {
  return raw
    .split(/\r?\n/)
    .filter(
      (line) =>
        !/^You are acting as KAI's subagent\b/.test(line) &&
        !/^KAI remains the authority\b/.test(line) &&
        !/^Preferred model:/.test(line) &&
        !/^Objective:/.test(line) &&
        !/^Instructions:/.test(line),
    )
    .join("\n")
    .trim();
}

/**
 * Present a worker's raw result as a reply AUTHORED BY THE PERSONA.
 *
 * The worker's own voice (its identity, its internals) is stripped by the ONE
 * relay guard KAI already uses, and the persona's own self-line leads the reply —
 * so a subagent turn reads as the subagent, never as "I'm Hermes Agent…". When the
 * worker said nothing usable, the persona answers from its own soul line rather
 * than relaying the worker's claim about itself.
 */
export function personaReply(spec: KaiSubagentSpec, raw: string): { reply: string; guarded: boolean } {
  const self = personaSelfLine(spec);
  const worker = (spec.workerId === "opencode" ? "opencode" : "hermes") as "hermes" | "opencode";
  const cleaned = stripDelegationPreamble(raw.trim());
  const presented = presentWorkerResult({ worker, raw: cleaned, kaiSelf: self });
  const body = presented.reply.trim();
  const reply = body.length === 0 || body === self ? self : `${self} ${body}`;
  return { reply, guarded: presented.guarded || body === "" };
}

/**
 * Build the `EmployeeDescriptor` for a persona.
 *
 * The instance borrows the preferred worker's adapter and declares the persona's
 * capabilities. It deliberately carries NO transport of its own and NO path to the
 * tool registry: the only way it can act is for the workforce manager to hand it to
 * the runtime's policy-governed `executeTask`, and the manager refuses to do even
 * that when `executeTask` is not wired.
 */
export function descriptorForSubagent(spec: KaiSubagentSpec, deps: SubagentDeps): EmployeeDescriptor {
  const employeeId = subagentEmployeeId(spec.id);
  // The persona's declared capabilities ARE ITS TOOL GRANTS (filesystem, shell,
  // browser, …): what tools the capability manager will let it reach.
  const capabilities = [...spec.capabilities];
  /**
   * Being *handed a task* is a separate, STRUCTURAL ability of the employee
   * INSTANCE, not a tool the persona was granted.
   *
   * The workforce manager requires the instance to declare the capability it is
   * being handed (`manager.ts` `delegateImpl`, default `"run_task"`), which is how
   * it tells "this employee can receive work" apart from "this employee can reach
   * this tool". A persona was previously refused with AGENT_CAPABILITY_MISSING
   * BEFORE it ever reached the policy/approval stage, because its instance carried
   * only its tool grants and never `run_task` — so the run could not park for
   * approval and the no-bypass proof could not exist.
   *
   * It is added to the INSTANCE here, never to `spec.capabilities`: the capability
   * manager is fed the employee's DECLARED capabilities (`workforce.describe()`),
   * so a persona still reaches exactly the tools it was granted. A persona without
   * `shell` therefore carries `run_task` — it can BE handed a task — while the task
   * itself stays constrained by policy and by that persona's own grants.
   */
  const instanceCapabilities = normalizeCapabilities([...capabilities, "run_task"]);
  return {
    metadata: {
      id: employeeId,
      name: spec.name,
      description: `KAI subagent — ${spec.role}`,
      origin: "subagent",
      capabilities,
    },
    async create(input = {}) {
      const adapter = deps.adapterFor(spec.workerId);
      const ready = adapter !== undefined;
      const problems = ready
        ? []
        : [`subagent "${spec.id}" has no available worker "${spec.workerId}" to run on`];
      return makeInstance({
        instanceId: input.instanceId ?? `${employeeId}#1`,
        employeeId,
        kind: spec.workerId,
        ...(adapter !== undefined ? { adapter } : {}),
        capabilities: instanceCapabilities,
        initialState: ready ? "READY" : "UNAVAILABLE",
        snapshot: async () =>
          makeSnapshot(ready ? "READY" : "UNAVAILABLE", {
            reachable: ready,
            authenticated: ready,
            problems,
          }),
      });
    },
  };
}
