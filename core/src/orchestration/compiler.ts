// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Per-domain TASK COMPILER.
 *
 * Replaces the one-size-fits-all worker prompt: `compileTaskPacket` is a PURE
 * function (no I/O, no model call) from the facts available at dispatch time —
 * work-item fields, task domain, selected skills, prior failures, gate
 * observations — to a {@link TaskPacket}; `renderTaskPacket` turns that packet
 * into text with a section set that DEPENDS ON THE DOMAIN, not one fixed list.
 *
 * Design rules:
 * - `forbiddenOutcomes` and every acceptance criterion (PAIRED with the
 *   verification method that settles it) always reach the rendered packet. A
 *   criterion that does not exist is never fabricated from the deliverable.
 * - Every string crosses the canonical redaction boundary (`redactText`) at
 *   COMPILE TIME and again at RENDER TIME; the marker is idempotent, so the
 *   second pass is free and the packet can never carry a raw credential.
 * - Facts carry PROVENANCE (`plan` | `gate` | `observation` | `skill` |
 *   `prior-attempt`), at packet level and as a per-section tag, so a rendered
 *   prompt can never imply knowledge the dispatch did not have.
 * - Everything is bounded: list items, skill bodies, context characters, and
 *   the rendered packet as a whole.
 * - Skills are included only when relevant to the objective/contract, and are
 *   capped per skill and in total.
 */

import { redactText } from "../redact/index.ts";
import { CONTEXT_CHAR_CAP } from "./prompts.ts";
import type { TaskDomain } from "./types.ts";

// ── Bounds ──────────────────────────────────────────────────────────────────

/** Hard cap on the rendered packet, note included. */
export const PACKET_CHAR_CAP = 8000;
/** Max list items kept from any single input list. */
export const MAX_LIST_ITEMS = 8;
/** Max characters kept from a single list item. */
export const MAX_ITEM_CHARS = 400;
/** Max relevant skills embedded in a packet. */
export const SKILL_CAP = 3;
/** Max characters kept from one skill body. */
export const SKILL_BODY_CHAR_CAP = 600;
/** Max characters of total skill body text embedded in a packet. */
export const SKILL_TOTAL_CHAR_CAP = 1500;
/** Max facts listed by the rendered PROVENANCE section (the packet keeps all). */
export const PROVENANCE_RENDER_CAP = 20;

const PACKET_TRUNCATION_NOTE = "…[packet truncated at PACKET_CHAR_CAP]";
const CONTEXT_TRUNCATION_NOTE = `…[context truncated to ${CONTEXT_CHAR_CAP} chars]`;

// ── Shared packet shape ─────────────────────────────────────────────────────

/** Where a compiled fact came from. Mirrors the shared TaskPacket contract. */
export type ProvenanceSource =
  | "plan"
  | "gate"
  | "observation"
  | "skill"
  | "prior-attempt";

export interface TaskPacket {
  identity: {
    workItemId: string;
    missionId?: string;
    taskId?: string;
    goalId?: string;
    goalRevisionId?: string;
    role: string;
    whySelected: string;
  };
  contract: {
    objective: string;
    deliverable?: string;
    acceptanceCriteria: string[];
    requiredEvidence: string[];
    evidenceLinks?: Record<string, string[]>;
    forbiddenOutcomes: string[];
    constraints: string[];
    authorizedWorkspace: string[];
  };
  state: {
    knownFacts: string[];
    previousAttempts: string[];
    observations: string[];
  };
  authority: { allowedTools: string[]; budget?: unknown };
  render: { requiredOutput: string; handoffFormat: string; verification: string[] };
  skills: { id: string; name: string; body: string }[];
  /** Where each fact came from, so a prompt can never imply unverified knowledge. */
  provenance: { fact: string; source: ProvenanceSource }[];
  /**
   * Additive: domain-specific dispatch facts (the reproduction, the command
   * under test, the audience, …). Each one is provenance-tagged and rendered by
   * the domain section that owns it. Optional — a plain coding packet omits it.
   */
  signals?: TaskPacketSignals;
}

/** Domain-specific facts a packet may carry. All bounded + redacted. */
export interface TaskPacketSignals {
  reproduction?: string;
  observed?: string;
  expected?: string;
  failingOutput?: string;
  command?: string;
  expectedResult?: string;
  audience?: string;
  requiredSections?: string[];
  sources?: string[];
}

/** A skill candidate the compiler may embed when it is relevant. */
export interface PacketSkillInput {
  id: string;
  name: string;
  body: string;
  /** Explicit include/exclude; when absent, relevance is inferred from terms. */
  relevant?: boolean;
}

/** The facts available at dispatch time. Everything is optional but the goal. */
export interface TaskCompilerInput {
  domain: TaskDomain;
  /** Refines a domain the frozen `TaskDomain` union cannot express. */
  specialization?: PacketSpecialization;
  identity: {
    workItemId: string;
    missionId?: string;
    taskId?: string;
    goalId?: string;
    goalRevisionId?: string;
    role?: string;
    whySelected?: string;
  };
  contract: {
    objective: string;
    deliverable?: string;
    criteria?: string[];
    constraints?: string[];
    forbiddenOutcomes?: string[];
    requiredEvidence?: string[];
    evidenceLinks?: Record<string, string[]>;
    authorizedWorkspace?: string[];
    requiredOutput?: string;
  };
  state?: {
    knownFacts?: string[];
    priorFailures?: string[];
    gateObservations?: string[];
  };
  authority?: { tools?: string[]; budget?: unknown };
  skills?: PacketSkillInput[];
  signals?: TaskPacketSignals;
  /** Overrides the default handoff format (orchestrator passes HANDOFF_FORMAT). */
  handoffFormat?: string;
}

// ── Domains ─────────────────────────────────────────────────────────────────

/**
 * The frozen `TaskDomain` union has no `security` or `verification` member, so
 * the section table is keyed by a SUPERSET: every `TaskDomain` plus the two
 * refinements. `specialization` selects a refinement; the plain domain rules
 * otherwise.
 */
export type PacketSpecialization = "security" | "verification";
export type PacketDomain = TaskDomain | PacketSpecialization;

/** Every key the section table must define (drives the totality test). */
export const PACKET_DOMAINS: readonly PacketDomain[] = [
  "coding",
  "debugging",
  "research",
  "writing",
  "architecture",
  "review",
  "testing",
  "document",
  "mcp",
  "system",
  "planning",
  "general",
  "security",
  "verification",
];

/** The effective section-table key for a domain + refinement. */
export function packetDomain(domain: TaskDomain, specialization?: PacketSpecialization): PacketDomain {
  return specialization ?? domain;
}

/** Default tool scope per domain, used only when the work item declares none. */
export const DEFAULT_TOOL_SCOPE: Record<PacketDomain, readonly string[]> = {
  coding: ["read", "grep", "glob", "write", "edit", "bash", "test"],
  debugging: ["read", "grep", "glob", "bash", "test"],
  testing: ["read", "grep", "glob", "bash", "test"],
  research: ["read", "grep", "glob", "web_search"],
  review: ["read", "grep", "glob"],
  writing: ["read", "grep", "write", "edit"],
  document: ["read", "grep", "write", "edit"],
  architecture: ["read", "grep", "glob", "write"],
  mcp: ["read", "grep", "glob", "bash", "mcp"],
  system: ["read", "grep", "glob", "bash"],
  planning: ["read", "grep", "glob"],
  general: ["read", "grep", "glob", "bash"],
  security: ["read", "grep", "glob", "bash"],
  verification: ["read", "grep", "glob", "bash"],
};

/** The required output a domain asks for, absent an explicit deliverable. */
export const DEFAULT_REQUIRED_OUTPUT: Record<PacketDomain, string> = {
  coding: "A working change: the changed artifacts plus the build and test commands with their exit codes and counts.",
  debugging: "The root cause, the failing command's raw output, and the change that makes the reproduction pass.",
  testing: "Test code that fails before and passes after, with the exact command and its pass/fail counts.",
  research: "A findings report where every claim carries a resolvable citation; uncited statements are UNKNOWN.",
  review: "A verdict per criterion with file:line findings and the artifact revision reviewed — no edits.",
  writing: "The finished piece for the stated audience, containing every required section.",
  document: "The finished document for the stated audience, containing every required section.",
  architecture: "A design: the decision, its constraints and trade-offs, and the rejected alternatives.",
  security: "A threat/policy assessment with one audit record per check (what, command, result) and the boundary tested.",
  verification: "A per-criterion pass/fail with the observed record attached for each required evidence label.",
  mcp: "The tool interaction result, with the exact invocation and its observed response.",
  system: "The observed system fact (command + result), not a description of what should happen.",
  planning: "A plan whose steps each name the evidence that would prove them done.",
  general: "The requested deliverable, with the evidence that shows it is complete.",
};

/** The verification method paired to a criterion that declares none. */
export const DEFAULT_VERIFICATION: Record<PacketDomain, string> = {
  coding: "the build command and the test command both exit 0 — paste the counts",
  debugging: "the reproduction no longer fails and the originally failing command exits 0",
  testing: "the named test command's exit code and pass/fail counts",
  research: "each claim carries a resolvable citation",
  review: "a verdict per criterion with file:line references into the artifact",
  writing: "every required section is present and written for the stated audience",
  document: "every required section is present and written for the stated audience",
  architecture: "the design names its constraints, trade-offs and rejected alternatives",
  security: "an audit record per check (command + result) plus the boundary tested",
  verification: "the observed record (command, exit code, output) for the criterion",
  mcp: "the invocation and its observed response",
  system: "a reproducible observation (command + result)",
  planning: "each step names the evidence that would prove it done",
  general: "a reproducible observation that the objective holds",
};

// ── Sections ────────────────────────────────────────────────────────────────

export type PacketSection =
  | "identity"
  | "objective"
  | "deliverable"
  | "criteria"
  | "forbidden"
  | "workspace"
  | "state"
  | "attempts"
  | "skills"
  | "constraints"
  | "requiredOutput"
  | "verification"
  | "clarification"
  | "handoff"
  | "provenance"
  | "changedArtifacts"
  | "buildTest"
  | "reproduction"
  | "observedVsExpected"
  | "failingOutput"
  | "exactCommand"
  | "expectedResult"
  | "productionBoundary"
  | "citationRequirements"
  | "noMutation"
  | "artifactCriteria"
  | "reviewerBoundary"
  | "audience"
  | "requiredSections"
  | "noInventedFacts"
  | "threatBoundary"
  | "auditRecord"
  | "criteriaUnderTest"
  | "evidenceToAttach";

/**
 * Per-DOMAIN section order. Shared sections sit in a fixed frame; the
 * domain-specific protocol sections slot in right after the deliverable, so a
 * coding packet and a research packet are materially different documents.
 */
function order(...domainSections: PacketSection[]): readonly PacketSection[] {
  return [
    "identity",
    "objective",
    "deliverable",
    ...domainSections,
    "criteria",
    "forbidden",
    "workspace",
    "state",
    "attempts",
    "skills",
    "constraints",
    "requiredOutput",
    "verification",
    "clarification",
    "handoff",
    "provenance",
  ];
}

export const SECTION_ORDER: Record<PacketDomain, readonly PacketSection[]> = {
  coding: order("changedArtifacts", "buildTest"),
  debugging: order("reproduction", "observedVsExpected", "failingOutput", "buildTest"),
  testing: order("exactCommand", "expectedResult", "productionBoundary"),
  research: order("citationRequirements", "noMutation"),
  review: order("artifactCriteria", "reviewerBoundary"),
  writing: order("audience", "requiredSections", "noInventedFacts"),
  document: order("audience", "requiredSections", "noInventedFacts"),
  architecture: order("changedArtifacts"),
  security: order("threatBoundary", "auditRecord"),
  verification: order("criteriaUnderTest", "evidenceToAttach"),
  mcp: order(),
  system: order(),
  planning: order(),
  general: order(),
};

const SECTION_TITLES: Record<PacketSection, string> = {
  identity: "TASK IDENTITY",
  objective: "OBJECTIVE",
  deliverable: "DELIVERABLE",
  criteria: "ACCEPTANCE CRITERIA × VERIFICATION",
  forbidden: "FORBIDDEN OUTCOMES",
  workspace: "WORKSPACE & TOOL SCOPE",
  state: "KNOWN STATE",
  attempts: "PREVIOUS ATTEMPTS",
  skills: "RELEVANT SKILLS",
  constraints: "CONSTRAINTS",
  requiredOutput: "REQUIRED OUTPUT",
  verification: "EVIDENCE REQUIRED",
  clarification: "IF YOU CANNOT PROCEED",
  handoff: "HANDOFF FORMAT",
  provenance: "PROVENANCE",
  changedArtifacts: "CHANGED ARTIFACT LIST",
  buildTest: "BUILD + TEST VERIFICATION",
  reproduction: "REPRODUCTION REQUIRED",
  observedVsExpected: "OBSERVED vs EXPECTED",
  failingOutput: "FAILING COMMAND OUTPUT (EVIDENCE)",
  exactCommand: "EXACT COMMAND UNDER TEST",
  expectedResult: "EXPECTED EXIT CODE / PASS COUNTS",
  productionBoundary: "PRODUCTION CODE IS OFF-LIMITS",
  citationRequirements: "CITATION REQUIREMENTS",
  noMutation: "READ-ONLY BOUNDARY",
  artifactCriteria: "ARTIFACT UNDER REVIEW",
  reviewerBoundary: "REVIEWER BOUNDARY — NO IMPLEMENTATION",
  audience: "AUDIENCE",
  requiredSections: "REQUIRED SECTIONS",
  noInventedFacts: "NO INVENTED FACTS",
  threatBoundary: "THREAT / POLICY BOUNDARY",
  auditRecord: "AUDIT RECORD REQUIRED",
  criteriaUnderTest: "CRITERIA UNDER TEST",
  evidenceToAttach: "EVIDENCE TO ATTACH",
};

/** The clarification clause every rendered packet ends its protocol with. */
export const CLARIFICATION_CLAUSE =
  "If you cannot proceed without a decision only the requester can make, STOP and report it under BLOCKERS: " +
  "— do not invent the decision, do not guess an answer, and do not substitute a different task.";

/**
 * The default handoff format. Kept byte-compatible with the orchestrator's
 * module-private `HANDOFF_FORMAT` (that parser reads these exact headers);
 * callers may pass their own via `TaskCompilerInput.handoffFormat`.
 */
export const PACKET_HANDOFF_FORMAT = [
  "STATUS: ok | blocked | failed",
  "RESULT: the deliverable or summary",
  "CHANGED ARTIFACTS: files/paths, one per line",
  "EVIDENCE: facts supporting the result",
  "TESTS: commands run and pass counts",
  "BLOCKERS: what stopped full completion",
  "RISKS: what could still be wrong",
  "FOLLOW-UPS: recommended next steps",
  "RECOMMENDED NEXT STEP: one line",
  "TOOLS USED: tool ids, comma-separated",
].join("\n");

// ── Bounded, redacted primitives ────────────────────────────────────────────

function clean(value: string): string {
  return redactText(value);
}

function clampText(value: string, max = MAX_ITEM_CHARS): string {
  const redacted = clean(value).trim();
  return redacted.length > max ? `${redacted.slice(0, max - 1)}…` : redacted;
}

function clampList(values: readonly string[] | undefined, max = MAX_LIST_ITEMS): string[] {
  if (values === undefined) return [];
  const out: string[] = [];
  for (const value of values) {
    const text = clampText(value);
    if (text.length > 0) out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

function bullet(items: readonly string[], empty: string): string {
  return items.length === 0 ? empty : items.map((item) => `- ${item}`).join("\n");
}

// ── Skill selection ─────────────────────────────────────────────────────────

/** Static membership table: a token in here never carries skill relevance. */
const RELEVANCE_STOPWORDS: Record<string, true> = {
  with: true, that: true, this: true, from: true, your: true, have: true,
  must: true, into: true, each: true, then: true, than: true, them: true,
  they: true, will: true, when: true, what: true, which: true, while: true,
  should: true, over: true, under: true, also: true, only: true, same: true,
  such: true, more: true, most: true, some: true, other: true, there: true,
  these: true, those: true, about: true, because: true,
};

function relevanceTerms(input: TaskCompilerInput): string[] {
  const raw = [
    input.contract.objective,
    input.contract.deliverable ?? "",
    ...(input.contract.criteria ?? []),
    ...(input.contract.constraints ?? []),
  ].join(" ");
  const terms = new Set<string>();
  for (const token of raw.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []) {
    if (RELEVANCE_STOPWORDS[token] !== true) terms.add(token);
  }
  return [...terms];
}

/** Relevant unless explicitly excluded; inferred from the objective's terms. */
function selectSkills(
  skills: readonly PacketSkillInput[] | undefined,
  terms: readonly string[],
): { id: string; name: string; body: string }[] {
  if (skills === undefined || skills.length === 0) return [];
  const out: { id: string; name: string; body: string }[] = [];
  let total = 0;
  for (const skill of skills) {
    if (out.length >= SKILL_CAP) break;
    const id = clampText(skill.id, 80);
    const name = clampText(skill.name, 120);
    const body = clampText(skill.body, SKILL_BODY_CHAR_CAP);
    if (id.length === 0) continue;
    if (skill.relevant === false) continue;
    if (skill.relevant !== true) {
      const haystack = `${skill.id} ${skill.name} ${skill.body.slice(0, 500)}`.toLowerCase();
      if (!terms.some((term) => haystack.includes(term))) continue;
    }
    if (total + body.length > SKILL_TOTAL_CHAR_CAP) {
      const room = SKILL_TOTAL_CHAR_CAP - total;
      if (room <= 0) break;
      out.push({ id, name, body: clampText(body.slice(0, room), room) });
      total = SKILL_TOTAL_CHAR_CAP;
      continue;
    }
    out.push({ id, name, body });
    total += body.length;
  }
  return out;
}

// ── Compile ─────────────────────────────────────────────────────────────────

interface ProvenanceEntry {
  fact: string;
  source: ProvenanceSource;
}

function pushFacts(
  out: ProvenanceEntry[],
  facts: readonly string[],
  source: ProvenanceSource,
  label?: string,
): void {
  for (const fact of facts) {
    out.push({ fact: label === undefined ? fact : `${label}: ${fact}`, source });
  }
}

/**
 * Compile the dispatch-time facts into a packet. Pure: no I/O, no model call,
 * no clock. Every string is redacted and bounded here.
 */
export function compileTaskPacket(input: TaskCompilerInput): TaskPacket {
  const domain = packetDomain(input.domain, input.specialization);

  const rawCriteria = input.contract.criteria ?? [];
  const criteria = clampList(rawCriteria);
  const requiredEvidence = clampList(input.contract.requiredEvidence);
  const forbiddenOutcomes = clampList(input.contract.forbiddenOutcomes);
  const constraints = clampList(input.contract.constraints);
  const authorizedWorkspace = clampList(input.contract.authorizedWorkspace);
  const declaredTools = clampList(input.authority?.tools, MAX_LIST_ITEMS);
  const allowedTools =
    declaredTools.length > 0 ? declaredTools : [...DEFAULT_TOOL_SCOPE[domain]];

  // Criteria are clamped, so links resolve against the ORIGINAL label and are
  // re-keyed by the clamped text — a paraphrase-by-truncation can never lose a
  // criterion's verification methods.
  const evidenceLinks: Record<string, string[]> = {};
  for (let i = 0; i < criteria.length; i += 1) {
    const criterion = criteria[i];
    if (criterion === undefined) continue;
    const original = rawCriteria[i];
    const linked = original !== undefined ? input.contract.evidenceLinks?.[original] : undefined;
    const methods =
      linked !== undefined && linked.length > 0
        ? clampList(linked, 6)
        : requiredEvidence.length > 0
          ? [...requiredEvidence]
          : [];
    if (methods.length > 0) evidenceLinks[criterion] = methods;
  }

  const knownFacts = clampList(input.state?.knownFacts, 6);
  const previousAttempts = clampList(input.state?.priorFailures, 6);
  const observations = clampList(input.state?.gateObservations, 6);

  const signals: TaskPacketSignals = {};
  const clampSignal = (value: string | undefined): string | undefined => {
    if (value === undefined) return undefined;
    const text = clampText(value, MAX_ITEM_CHARS);
    return text.length > 0 ? text : undefined;
  };
  const reproduction = clampSignal(input.signals?.reproduction);
  const observed = clampSignal(input.signals?.observed);
  const expected = clampSignal(input.signals?.expected);
  const failingOutput = clampSignal(input.signals?.failingOutput);
  const command = clampSignal(input.signals?.command);
  const expectedResult = clampSignal(input.signals?.expectedResult);
  const audience = clampSignal(input.signals?.audience);
  if (reproduction !== undefined) signals.reproduction = reproduction;
  if (observed !== undefined) signals.observed = observed;
  if (expected !== undefined) signals.expected = expected;
  if (failingOutput !== undefined) signals.failingOutput = failingOutput;
  if (command !== undefined) signals.command = command;
  if (expectedResult !== undefined) signals.expectedResult = expectedResult;
  if (audience !== undefined) signals.audience = audience;
  const requiredSections = clampList(input.signals?.requiredSections, MAX_LIST_ITEMS);
  if (requiredSections.length > 0) signals.requiredSections = requiredSections;
  const sources = clampList(input.signals?.sources, MAX_LIST_ITEMS);
  if (sources.length > 0) signals.sources = sources;

  const skills = selectSkills(input.skills, relevanceTerms(input));

  const objective = clampText(input.contract.objective, 600);
  const deliverable =
    input.contract.deliverable !== undefined ? clampText(input.contract.deliverable, 600) : undefined;
  const role = clampText(input.identity.role ?? "worker", 120);
  const whySelected = clampText(input.identity.whySelected ?? "", 300);

  const provenance: ProvenanceEntry[] = [];
  provenance.push({ fact: `objective: ${objective}`, source: "plan" });
  if (deliverable !== undefined) provenance.push({ fact: `deliverable: ${deliverable}`, source: "plan" });
  pushFacts(provenance, criteria, "plan", "criterion");
  pushFacts(provenance, forbiddenOutcomes, "plan", "forbidden");
  pushFacts(provenance, constraints, "plan", "constraint");
  pushFacts(provenance, requiredEvidence, "plan", "required evidence");
  pushFacts(provenance, authorizedWorkspace, "plan", "workspace");
  if (whySelected.length > 0) provenance.push({ fact: `selected because: ${whySelected}`, source: "plan" });
  provenance.push({ fact: `tool scope: ${allowedTools.join(", ")}`, source: "plan" });
  pushFacts(provenance, knownFacts, "observation");
  pushFacts(provenance, observations, "gate");
  pushFacts(provenance, previousAttempts, "prior-attempt");
  for (const skill of skills) {
    provenance.push({ fact: `skill ${skill.id} (${skill.body.length} chars loaded)`, source: "skill" });
  }
  if (signals.reproduction !== undefined) provenance.push({ fact: `reproduction: ${signals.reproduction}`, source: "observation" });
  if (signals.observed !== undefined) provenance.push({ fact: `observed: ${signals.observed}`, source: "observation" });
  if (signals.expected !== undefined) provenance.push({ fact: `expected: ${signals.expected}`, source: "observation" });
  if (signals.failingOutput !== undefined) {
    provenance.push({ fact: `failing output: ${signals.failingOutput}`, source: "observation" });
  }
  if (signals.command !== undefined) provenance.push({ fact: `command under test: ${signals.command}`, source: "plan" });
  if (signals.expectedResult !== undefined) {
    provenance.push({ fact: `expected result: ${signals.expectedResult}`, source: "plan" });
  }
  if (signals.audience !== undefined) provenance.push({ fact: `audience: ${signals.audience}`, source: "plan" });
  pushFacts(provenance, signals.requiredSections ?? [], "plan", "required section");
  pushFacts(provenance, signals.sources ?? [], "plan", "source");

  const requiredOutput = clampText(
    input.contract.requiredOutput ?? DEFAULT_REQUIRED_OUTPUT[domain],
    600,
  );

  const packet: TaskPacket = {
    identity: {
      workItemId: clampText(input.identity.workItemId, 120),
      ...(input.identity.missionId !== undefined ? { missionId: clampText(input.identity.missionId, 120) } : {}),
      ...(input.identity.taskId !== undefined ? { taskId: clampText(input.identity.taskId, 120) } : {}),
      ...(input.identity.goalId !== undefined ? { goalId: clampText(input.identity.goalId, 120) } : {}),
      ...(input.identity.goalRevisionId !== undefined
        ? { goalRevisionId: clampText(input.identity.goalRevisionId, 120) }
        : {}),
      role,
      whySelected,
    },
    contract: {
      objective,
      ...(deliverable !== undefined ? { deliverable } : {}),
      acceptanceCriteria: criteria,
      requiredEvidence,
      ...(Object.keys(evidenceLinks).length > 0 ? { evidenceLinks } : {}),
      forbiddenOutcomes,
      constraints,
      authorizedWorkspace,
    },
    state: { knownFacts, previousAttempts, observations },
    authority: {
      allowedTools,
      ...(input.authority?.budget !== undefined ? { budget: input.authority.budget } : {}),
    },
    render: {
      requiredOutput,
      handoffFormat: clampText(input.handoffFormat ?? PACKET_HANDOFF_FORMAT, 1000),
      verification: [],
    },
    skills,
    provenance,
    ...(Object.keys(signals).length > 0 ? { signals } : {}),
  };

  packet.render.verification = criterionPairs(packet, domain).map(
    (pair) => `${pair.criterion} ⟵ ${pair.verifiedBy.join("; ")}`,
  );
  return packet;
}

// ── Pairing ─────────────────────────────────────────────────────────────────

interface CriterionPair {
  criterion: string;
  verifiedBy: string[];
}

/** Every criterion paired with the method(s) that settle it. */
export function criterionPairs(packet: TaskPacket, domain: PacketDomain): CriterionPair[] {
  const required = packet.contract.requiredEvidence;
  return packet.contract.acceptanceCriteria.map((criterion) => {
    const linked = packet.contract.evidenceLinks?.[criterion];
    const verifiedBy =
      linked !== undefined && linked.length > 0
        ? [...linked]
        : required.length > 0
          ? [...required]
          : [DEFAULT_VERIFICATION[domain]];
    return { criterion, verifiedBy };
  });
}

// ── Render ──────────────────────────────────────────────────────────────────

interface RenderedSection {
  title: string;
  source: ProvenanceSource | "mixed";
  body: string;
}

function renderSection(
  id: PacketSection,
  packet: TaskPacket,
  domain: PacketDomain,
): RenderedSection | null {
  const signals = packet.signals ?? {};
  const title = SECTION_TITLES[id];
  const plan = (body: string): RenderedSection => ({ title, source: "plan", body });
  const observed = (body: string): RenderedSection => ({ title, source: "observation", body });

  switch (id) {
    case "identity": {
      const ids = [
        `work item: ${packet.identity.workItemId}`,
        `mission: ${packet.identity.missionId ?? "(none)"}`,
        `task: ${packet.identity.taskId ?? "(none)"}`,
        `goal: ${packet.identity.goalId ?? "(none)"} @ ${packet.identity.goalRevisionId ?? "(none)"}`,
      ];
      return plan(
        [
          `Role: ${clean(packet.identity.role)}`,
          `Selected because: ${packet.identity.whySelected.length > 0 ? clean(packet.identity.whySelected) : "(not stated)"}`,
          ...ids.map(clean),
        ].join("\n"),
      );
    }
    case "objective":
      return plan(clean(packet.contract.objective));
    case "deliverable":
      if (packet.contract.deliverable === undefined) return null;
      return plan(clean(packet.contract.deliverable));
    case "criteria": {
      const pairs = criterionPairs(packet, domain);
      if (pairs.length === 0) {
        return plan(
          "(none specified — do not invent criteria; if the contract is genuinely missing, report it as a blocker)",
        );
      }
      const body = pairs
        .map(
          (pair) =>
            `- criterion: ${clean(pair.criterion)}\n    verified by: ${pair.verifiedBy.map(clean).join("; ")}`,
        )
        .join("\n");
      return plan(body);
    }
    case "forbidden": {
      const body = bullet(packet.contract.forbiddenOutcomes.map(clean), "(none specified)");
      return plan(
        `${body}\nThe Outcome Gate fails this item when a forbidden outcome appears in the deliverable.`,
      );
    }
    case "workspace": {
      const workspace =
        packet.contract.authorizedWorkspace.length > 0
          ? packet.contract.authorizedWorkspace.map(clean).join("; ")
          : "(the repository working directory the dispatch named)";
      return plan(
        [
          `Authorized workspace: ${workspace}`,
          `Allowed tools: ${packet.authority.allowedTools.map(clean).join(", ")}`,
          "Anything outside this scope is not yours to touch; report it instead of reaching for it.",
        ].join("\n"),
      );
    }
    case "state": {
      if (packet.state.knownFacts.length === 0 && packet.state.observations.length === 0) return null;
      const lines = [
        ...packet.state.knownFacts.map((fact) => `- [observation] ${clean(fact)}`),
        ...packet.state.observations.map((fact) => `- [gate] ${clean(fact)}`),
      ].join("\n");
      const body =
        lines.length > CONTEXT_CHAR_CAP
          ? `${lines.slice(0, CONTEXT_CHAR_CAP)}\n${CONTEXT_TRUNCATION_NOTE}`
          : lines;
      return {
        title,
        source: packet.state.observations.length > 0 ? "gate" : "observation",
        body,
      };
    }
    case "attempts": {
      if (packet.state.previousAttempts.length === 0) return null;
      return {
        title,
        source: "prior-attempt",
        body: bullet(packet.state.previousAttempts.map(clean), "(none)"),
      };
    }
    case "skills": {
      if (packet.skills.length === 0) return null;
      return {
        title,
        source: "skill",
        body: packet.skills
          .map((skill) => `### ${clean(skill.id)} — ${clean(skill.name)}\n${clean(skill.body)}`)
          .join("\n\n"),
      };
    }
    case "constraints": {
      if (packet.contract.constraints.length === 0) return null;
      return plan(bullet(packet.contract.constraints.map(clean), "(none)"));
    }
    case "requiredOutput":
      return plan(clean(packet.render.requiredOutput));
    case "verification": {
      const evidence = bullet(packet.contract.requiredEvidence.map(clean), "(none named)");
      return plan(
        [
          "Per-criterion verification methods are paired in ACCEPTANCE CRITERIA × VERIFICATION.",
          "Required evidence (each needs an observed record whose label matches exactly):",
          evidence,
        ].join("\n"),
      );
    }
    case "clarification":
      return plan(CLARIFICATION_CLAUSE);
    case "handoff":
      return plan(clean(packet.render.handoffFormat));
    case "provenance": {
      const shown = packet.provenance.slice(0, PROVENANCE_RENDER_CAP);
      const lines = shown.map((entry) => `- [${entry.source}] ${clean(entry.fact)}`);
      const remaining = packet.provenance.length - shown.length;
      if (remaining > 0) lines.push(`- …and ${remaining} more fact(s) recorded on the packet`);
      return { title, source: "mixed", body: lines.join("\n") };
    }
    case "changedArtifacts":
      return plan(
        "List EVERY path you change under CHANGED ARTIFACTS: in the handoff, one per line. An edit that is not listed is an unverifiable change.",
      );
    case "buildTest":
      return plan(
        [
          "Verification MUST be the exact commands you ran, in order, with exit codes and counts:",
          "- build: the project's typecheck/build command",
          "- test: the test command for the area you touched",
          signals.command !== undefined ? `Command: ${clean(signals.command)}` : "A handoff without command output is a failed verification.",
        ].join("\n"),
      );
    case "reproduction":
      return observed(
        [
          "Provide a minimal, deterministic reproduction: the exact inputs/steps, the command, and the observed failure.",
          `Reproduction: ${signals.reproduction !== undefined ? clean(signals.reproduction) : "(not supplied — you must produce one)"}`,
          "A fix without a reproduction is not verifiable.",
        ].join("\n"),
      );
    case "observedVsExpected":
      return observed(
        [
          `Observed: ${signals.observed !== undefined ? clean(signals.observed) : "(not supplied)"}`,
          `Expected: ${signals.expected !== undefined ? clean(signals.expected) : "(not supplied)"}`,
          "State both explicitly: the defect is the gap between them.",
        ].join("\n"),
      );
    case "failingOutput":
      return observed(
        [
          "Paste the exact failing command and its raw output under EVIDENCE: — the output is the evidence, never a paraphrase.",
          signals.failingOutput !== undefined ? clean(signals.failingOutput) : "(no failing output supplied yet)",
        ].join("\n"),
      );
    case "exactCommand":
      return plan(
        `Command: ${signals.command !== undefined ? clean(signals.command) : "(not supplied — name the exact command under test)"}`,
      );
    case "expectedResult":
      return plan(
        `Expected: ${signals.expectedResult !== undefined ? clean(signals.expectedResult) : "(not supplied — state the expected exit code and pass/fail counts)"}`,
      );
    case "productionBoundary":
      return plan(
        "Do NOT change production code. The deliverable is test code plus a report; if the production code is wrong, report it as a finding instead of fixing it.",
      );
    case "citationRequirements": {
      const listed =
        signals.sources !== undefined && signals.sources.length > 0
          ? bullet(signals.sources.map(clean), "(none supplied — gather them yourself)")
          : "(none supplied — gather them yourself)";
      return plan(
        [
          "Every claim MUST carry a resolvable source (URL or path:line). A statement without a source is UNKNOWN, never asserted.",
          "Known sources:",
          listed,
        ].join("\n"),
      );
    }
    case "noMutation":
      return plan(
        "Do not modify artifacts. This task produces findings; a mutation is a failed handoff, not a helpful extra.",
      );
    case "artifactCriteria":
      return plan(
        "The artifact under review is the deliverable named above. Review it against every criterion below and cite file:line for each finding; name the artifact revision you reviewed.",
      );
    case "reviewerBoundary":
      return plan(
        "You are the REVIEWER. Do NOT implement fixes or edit the artifact; report findings and a verdict. Implementing your own fix invalidates the review.",
      );
    case "audience":
      return plan(
        `Audience: ${signals.audience !== undefined ? clean(signals.audience) : "(not stated — state the audience you are writing for)"}`,
      );
    case "requiredSections":
      return plan(
        bullet(
          (signals.requiredSections ?? []).map(clean),
          "(none specified — mirror the structure the deliverable itself implies)",
        ),
      );
    case "noInventedFacts":
      return plan(
        "Every fact MUST come from the objective, the known state, or a cited source. Anything else is labelled UNKNOWN. Never invent names, numbers, quotes, or citations.",
      );
    case "threatBoundary":
      return plan(
        [
          "State the threat model: the assets at risk, the attacker-controlled inputs, and the policy boundary a violation would cross.",
          "Report exactly which boundary you tested — and which you did not.",
        ].join("\n"),
      );
    case "auditRecord":
      return plan(
        "Every check MUST leave an audit record: what was checked, the exact command or observation, the result, and when. An unrecorded check did not happen.",
      );
    case "criteriaUnderTest":
      return plan(
        "Treat each acceptance criterion below as a separate pass/fail. Never mark one met without the evidence named for it.",
      );
    case "evidenceToAttach":
      return plan(
        "Attach, per criterion, the observed record: command, exit code, and output. A criterion without attached evidence is unverified — report it as such rather than asserting it.",
      );
    default:
      return null;
  }
}

/**
 * Render a packet as a domain-specific prompt. Sections follow
 * {@link SECTION_ORDER}[domain]; the result is capped at {@link PACKET_CHAR_CAP}
 * characters and every string is redacted again at this boundary.
 */
export function renderTaskPacket(packet: TaskPacket, domain: PacketDomain): string {
  const order = SECTION_ORDER[domain];
  const parts: string[] = [];
  for (const id of order) {
    const section = renderSection(id, packet, domain);
    if (section === null) continue;
    parts.push(`## ${section.title} [${section.source}]\n${section.body}`);
  }
  const rendered = parts.join("\n\n");
  if (rendered.length <= PACKET_CHAR_CAP) return rendered;
  const room = PACKET_CHAR_CAP - PACKET_TRUNCATION_NOTE.length - 1;
  return `${rendered.slice(0, room)}\n${PACKET_TRUNCATION_NOTE}`;
}

// ── Dispatch bridge ─────────────────────────────────────────────────────────

/** The subset of a work item the compiler reads. Keeps the bridge total. */
export interface CompilerWorkItemLike {
  id: string;
  missionId?: string;
  taskId?: string;
  goalId?: string;
  goalRevisionId?: string;
  objective: string;
  deliverable?: string;
  criteria: string[];
  constraints: string[];
  forbiddenOutcomes: string[];
  requiredEvidence: string[];
  evidenceLinks?: Record<string, string[]>;
  tools: string[];
  workingDir?: string;
  skills: string[];
  failures: string[];
}

export interface WorkItemCompilerOptions {
  role?: string;
  whySelected?: string;
  domain: TaskDomain;
  specialization?: PacketSpecialization;
  knownFacts?: string[];
  gateObservations?: string[];
  skills?: PacketSkillInput[];
  requiredOutput?: string;
  signals?: TaskPacketSignals;
  budget?: unknown;
  handoffFormat?: string;
}

/**
 * Bridge a persisted work item plus dispatch-time extras into compiler input.
 * Pure: it reads the item, it never touches the board.
 */
export function compilerInputFromWorkItem(
  item: CompilerWorkItemLike,
  opts: WorkItemCompilerOptions,
): TaskCompilerInput {
  return {
    domain: opts.domain,
    ...(opts.specialization !== undefined ? { specialization: opts.specialization } : {}),
    identity: {
      workItemId: item.id,
      ...(item.missionId !== undefined ? { missionId: item.missionId } : {}),
      ...(item.taskId !== undefined ? { taskId: item.taskId } : {}),
      ...(item.goalId !== undefined ? { goalId: item.goalId } : {}),
      ...(item.goalRevisionId !== undefined ? { goalRevisionId: item.goalRevisionId } : {}),
      ...(opts.role !== undefined ? { role: opts.role } : {}),
      ...(opts.whySelected !== undefined ? { whySelected: opts.whySelected } : {}),
    },
    contract: {
      objective: item.objective,
      ...(item.deliverable !== undefined ? { deliverable: item.deliverable } : {}),
      criteria: item.criteria,
      constraints: item.constraints,
      forbiddenOutcomes: item.forbiddenOutcomes,
      requiredEvidence: item.requiredEvidence,
      ...(item.evidenceLinks !== undefined ? { evidenceLinks: item.evidenceLinks } : {}),
      ...(item.workingDir !== undefined ? { authorizedWorkspace: [item.workingDir] } : {}),
      ...(opts.requiredOutput !== undefined ? { requiredOutput: opts.requiredOutput } : {}),
    },
    state: {
      ...(opts.knownFacts !== undefined ? { knownFacts: opts.knownFacts } : {}),
      priorFailures: item.failures,
      ...(opts.gateObservations !== undefined ? { gateObservations: opts.gateObservations } : {}),
    },
    authority: {
      ...(item.tools.length > 0 ? { tools: item.tools } : {}),
      ...(opts.budget !== undefined ? { budget: opts.budget } : {}),
    },
    ...(opts.skills !== undefined ? { skills: opts.skills } : {}),
    ...(opts.signals !== undefined ? { signals: opts.signals } : {}),
    ...(opts.handoffFormat !== undefined ? { handoffFormat: opts.handoffFormat } : {}),
  };
}
