// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Per-domain TASK COMPILER tests.
 * Plain `node --test`, no dependencies, no network, no live model: the compiler
 * is a pure function, so every assertion is a direct call.
 * Run from `core/`:  node --test --experimental-strip-types tests/task-compiler.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  CLARIFICATION_CLAUSE,
  MAX_LIST_ITEMS,
  PACKET_CHAR_CAP,
  PACKET_DOMAINS,
  PACKET_HANDOFF_FORMAT,
  SECTION_ORDER,
  SKILL_BODY_CHAR_CAP,
  SKILL_CAP,
  SKILL_TOTAL_CHAR_CAP,
  compileTaskPacket,
  compilerInputFromWorkItem,
  criterionPairs,
  packetDomain,
  renderTaskPacket,
  type PacketDomain,
  type TaskCompilerInput,
} from "../src/orchestration/compiler.ts";
import type { TaskDomain } from "../src/orchestration/types.ts";

/** Every member of the frozen `TaskDomain` union. */
const TASK_DOMAINS: readonly TaskDomain[] = [
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
];

const SECRET = "api_key=sk-abcdefghijklmnop1234";

function baseInput(domain: TaskDomain, overrides?: Partial<TaskCompilerInput>): TaskCompilerInput {
  return {
    domain,
    identity: {
      workItemId: "wi-1",
      missionId: "m-1",
      role: "Coder-1",
      whySelected: "best measured coding value",
    },
    contract: {
      objective: "Fix the login bug in the auth module",
      deliverable: "a patched auth.ts",
      criteria: ["login test passes", "no regression in signup"],
      constraints: ["no new dependencies"],
      forbiddenOutcomes: ["deleting the auth test suite"],
      requiredEvidence: ["test run output"],
      evidenceLinks: { "login test passes": ["test run output"] },
      authorizedWorkspace: ["core/src/auth"],
    },
    state: {
      knownFacts: ["auth.ts:42 returns null on an empty password"],
      gateObservations: ["gate: the previous attempt left criteria unmet"],
      priorFailures: ["attempt 1: test suite red"],
    },
    authority: { tools: [] },
    ...overrides,
  };
}

// ── 1. Domains differ materially ────────────────────────────────────────────

test("coding and research packets differ materially: sections, tool scope, required output", () => {
  const coding = compileTaskPacket(baseInput("coding"));
  const research = compileTaskPacket(baseInput("research"));

  // Section SETS differ, not just their order.
  assert.notDeepEqual([...SECTION_ORDER.coding], [...SECTION_ORDER.research]);
  const codingOnly = SECTION_ORDER.coding.filter((s) => !SECTION_ORDER.research.includes(s));
  const researchOnly = SECTION_ORDER.research.filter((s) => !SECTION_ORDER.coding.includes(s));
  assert.ok(codingOnly.length >= 2, "coding must own sections research does not");
  assert.ok(researchOnly.length >= 2, "research must own sections coding does not");
  assert.ok(codingOnly.includes("changedArtifacts"));
  assert.ok(codingOnly.includes("buildTest"));
  assert.ok(researchOnly.includes("citationRequirements"));
  assert.ok(researchOnly.includes("noMutation"));

  const codingText = renderTaskPacket(coding, "coding");
  const researchText = renderTaskPacket(research, "research");
  assert.notEqual(codingText, researchText);
  assert.ok(codingText.includes("## CHANGED ARTIFACT LIST"));
  assert.ok(codingText.includes("## BUILD + TEST VERIFICATION"));
  assert.ok(!codingText.includes("## CITATION REQUIREMENTS"));
  assert.ok(researchText.includes("## CITATION REQUIREMENTS"));
  assert.ok(researchText.includes("## READ-ONLY BOUNDARY"));
  assert.ok(!researchText.includes("## BUILD + TEST VERIFICATION"));

  // Tool scope.
  assert.ok(coding.authority.allowedTools.includes("write"));
  assert.ok(coding.authority.allowedTools.includes("edit"));
  assert.ok(coding.authority.allowedTools.includes("test"));
  assert.ok(!research.authority.allowedTools.includes("write"));
  assert.ok(!research.authority.allowedTools.includes("edit"));
  assert.ok(research.authority.allowedTools.includes("web_search"));

  // Required output.
  assert.notEqual(coding.render.requiredOutput, research.render.requiredOutput);
  assert.match(research.render.requiredOutput, /citation/i);
  assert.match(coding.render.requiredOutput, /build and test/i);
});

// ── 2. Forbidden outcomes + criterion⇄verification pairing, every domain ────

for (const domain of TASK_DOMAINS) {
  test(`forbidden outcomes and criterion⇄verification pairs survive compilation (${domain})`, () => {
    const packet = compileTaskPacket(baseInput(domain));
    const key = packetDomain(domain);

    assert.deepEqual(packet.contract.forbiddenOutcomes, ["deleting the auth test suite"]);
    assert.deepEqual(packet.contract.acceptanceCriteria, ["login test passes", "no regression in signup"]);

    const pairs = criterionPairs(packet, key);
    assert.equal(pairs.length, 2);
    // Explicitly linked criterion keeps its own evidence.
    assert.deepEqual(pairs[0]?.verifiedBy, ["test run output"]);
    // Unlinked criterion defaults to ALL required evidence (strict), never none.
    assert.deepEqual(pairs[1]?.verifiedBy, ["test run output"]);
    assert.equal(packet.render.verification.length, 2);
    assert.ok(packet.render.verification.every((line) => line.includes("⟵")));

    const text = renderTaskPacket(packet, key);
    assert.ok(text.includes("## FORBIDDEN OUTCOMES"));
    assert.ok(text.includes("deleting the auth test suite"));
    assert.ok(text.includes("## ACCEPTANCE CRITERIA × VERIFICATION"));
    assert.ok(text.includes("login test passes"));
    assert.ok(text.includes("no regression in signup"));
    assert.ok(text.includes("verified by: test run output"));
    assert.ok(text.includes(CLARIFICATION_CLAUSE));
    assert.ok(SECTION_ORDER[key].includes("criteria"));
    assert.ok(SECTION_ORDER[key].includes("forbidden"));

    // A domain with no explicit tool list still gets a domain tool scope.
    assert.ok(packet.authority.allowedTools.length > 0);
  });
}

// ── 3. No criteria → nothing fabricated ─────────────────────────────────────

test("a domain with no criteria does not fabricate them or a verification method", () => {
  const packet = compileTaskPacket(
    baseInput("research", {
      contract: {
        objective: "Summarize the pagination options",
        deliverable: "a comparison note",
        criteria: [],
        constraints: [],
        forbiddenOutcomes: [],
        requiredEvidence: [],
      },
    }),
  );
  assert.deepEqual(packet.contract.acceptanceCriteria, []);
  assert.deepEqual(packet.render.verification, []);
  assert.deepEqual(criterionPairs(packet, "research"), []);

  const text = renderTaskPacket(packet, "research");
  assert.ok(text.includes("## ACCEPTANCE CRITERIA × VERIFICATION [plan]\n(none specified"));
  // The old one-size prompt derived "deliverable present: …" as a criterion.
  assert.ok(!text.includes("deliverable present:"));
  assert.ok(text.includes("## FORBIDDEN OUTCOMES [plan]\n(none specified"));
});

// ── 4. Skills are relevance-filtered, capped, and provenance-labelled ───────

test("skills are capped per packet and per body, relevance-filtered, and provenance-labelled", () => {
  const relevantBody = "check the login path and the auth token flow. ".repeat(200);
  const packet = compileTaskPacket(
    baseInput("debugging", {
      skills: [
        { id: "login-debug", name: "Login debugging", body: relevantBody },
        { id: "auth-trace", name: "Auth trace", body: relevantBody },
        { id: "auth-fix", name: "Auth fix", body: relevantBody },
        { id: "auth-review", name: "Auth review", body: relevantBody },
        { id: "auth-extra", name: "Auth extra", body: relevantBody },
        { id: "gardening", name: "Gardening", body: "plant tomatoes in spring soil" },
      ],
    }),
  );

  assert.equal(packet.skills.length, SKILL_CAP);
  assert.ok(packet.skills.every((skill) => skill.body.length <= SKILL_BODY_CHAR_CAP));
  const bodyTotal = packet.skills.reduce((sum, skill) => sum + skill.body.length, 0);
  assert.ok(bodyTotal <= SKILL_TOTAL_CHAR_CAP, `skill bodies total ${bodyTotal}`);
  assert.ok(!packet.skills.some((skill) => skill.id === "gardening"), "irrelevant skill must be dropped");

  const skillFacts = packet.provenance.filter((entry) => entry.source === "skill");
  assert.equal(skillFacts.length, packet.skills.length);
  assert.ok(skillFacts.every((entry) => entry.fact.startsWith("skill ")));

  const text = renderTaskPacket(packet, "debugging");
  assert.ok(text.includes("## RELEVANT SKILLS [skill]"));
  assert.ok(!text.includes("Gardening"));

  // An explicit exclusion wins even when the terms match.
  const excluded = compileTaskPacket(
    baseInput("debugging", { skills: [{ id: "login-debug", name: "Login debugging", body: "x", relevant: false }] }),
  );
  assert.deepEqual(excluded.skills, []);
});

// ── 5. Bounded output for a large input ─────────────────────────────────────

test("a large input still yields a bounded packet and a bounded render", () => {
  const words = (count: number, prefix: string): string =>
    Array.from({ length: count }, (_, i) => `${prefix}${i}`).join(" ");
  const huge = baseInput("coding", {
    contract: {
      objective: words(800, "objectiveword"),
      deliverable: words(500, "deliverableword"),
      criteria: Array.from({ length: 50 }, (_, i) => `criterion ${i} ${words(20, "c")}`),
      constraints: Array.from({ length: 40 }, (_, i) => `constraint ${i}`),
      forbiddenOutcomes: Array.from({ length: 40 }, (_, i) => `forbidden ${i}`),
      requiredEvidence: Array.from({ length: 40 }, (_, i) => `evidence ${i}`),
      authorizedWorkspace: Array.from({ length: 20 }, (_, i) => `path/${i}`),
    },
    state: {
      knownFacts: Array.from({ length: 60 }, (_, i) => `fact ${i} ${words(40, "f")}`),
      gateObservations: Array.from({ length: 60 }, (_, i) => `gate ${i} ${words(40, "g")}`),
      priorFailures: Array.from({ length: 60 }, (_, i) => `attempt ${i} ${words(40, "p")}`),
    },
    skills: Array.from({ length: 10 }, (_, i) => ({
      id: `objective-skill-${i}`,
      name: `Objective skill ${i}`,
      body: relevantBodyForBound(),
    })),
    signals: {
      reproduction: words(600, "repro"),
      failingOutput: words(600, "fail"),
      command: "npm test",
    },
  });

  const packet = compileTaskPacket(huge);
  assert.ok(packet.contract.acceptanceCriteria.length <= MAX_LIST_ITEMS);
  assert.ok(packet.contract.forbiddenOutcomes.length <= MAX_LIST_ITEMS);
  assert.ok(packet.contract.requiredEvidence.length <= MAX_LIST_ITEMS);
  assert.ok(packet.contract.constraints.length <= MAX_LIST_ITEMS);
  assert.ok(packet.contract.authorizedWorkspace.length <= MAX_LIST_ITEMS);
  assert.ok(packet.state.knownFacts.length <= 6);
  assert.ok(packet.state.observations.length <= 6);
  assert.ok(packet.state.previousAttempts.length <= 6);
  assert.ok(packet.skills.length <= SKILL_CAP);

  const text = renderTaskPacket(packet, "coding");
  assert.ok(text.length <= PACKET_CHAR_CAP, `rendered ${text.length} chars`);
  assert.ok(text.length > 0);
});

function relevantBodyForBound(): string {
  return "objectiveword guidance for the coding task. ".repeat(200);
}

// ── 6. Redaction at the compile AND render boundary ─────────────────────────

test("redaction is applied to every compiled field and to the rendered packet", () => {
  const packet = compileTaskPacket(
    baseInput("coding", {
      contract: {
        objective: `Fix the login bug with ${SECRET}`,
        deliverable: `a patched auth.ts using ${SECRET}`,
        criteria: [`rotate the key ${SECRET}`],
        constraints: [`never log ${SECRET}`],
        forbiddenOutcomes: [`committing ${SECRET}`],
        requiredEvidence: [`command output for ${SECRET}`],
        authorizedWorkspace: ["core/src/auth"],
      },
      state: {
        knownFacts: [`observed ${SECRET}`],
        gateObservations: [`gate saw ${SECRET}`],
        priorFailures: [`attempt leaked ${SECRET}`],
      },
      signals: { failingOutput: `error with ${SECRET}` },
    }),
  );

  const serialized = JSON.stringify(packet);
  assert.ok(!serialized.includes(SECRET), "the packet must not carry the raw credential");
  assert.ok(serialized.includes("[redacted]"));

  const text = renderTaskPacket(packet, "coding");
  assert.ok(!text.includes(SECRET));
  assert.ok(text.includes("[redacted]"));
});

// ── 7. Provenance covers every source class ─────────────────────────────────

test("provenance labels every fact class and reaches the rendered packet", () => {
  const packet = compileTaskPacket(
    baseInput("debugging", {
      skills: [{ id: "login-debug", name: "Login debugging", body: "trace the login path" }],
    }),
  );
  const sources = new Set(packet.provenance.map((entry) => entry.source));
  for (const source of ["plan", "gate", "observation", "skill", "prior-attempt"] as const) {
    assert.ok(sources.has(source), `provenance must include a ${source} fact`);
  }

  const text = renderTaskPacket(packet, "debugging");
  for (const tag of ["[plan]", "[gate]", "[observation]", "[skill]", "[prior-attempt]"]) {
    assert.ok(text.includes(tag), `rendered packet must tag ${tag}`);
  }
  assert.ok(text.includes("## PROVENANCE [mixed]"));
  // Section-level provenance tags survive on the section headers.
  assert.ok(text.includes("## KNOWN STATE [gate]"));
  assert.ok(text.includes("## PREVIOUS ATTEMPTS [prior-attempt]"));
});

// ── 8. Specializations the frozen union cannot express ──────────────────────

test("security and verification specializations select their own section sets", () => {
  const security = compileTaskPacket(baseInput("review", { specialization: "security" }));
  const securityKey: PacketDomain = packetDomain("review", "security");
  assert.equal(securityKey, "security");
  const securityText = renderTaskPacket(security, securityKey);
  assert.ok(securityText.includes("## THREAT / POLICY BOUNDARY [plan]"));
  assert.ok(securityText.includes("## AUDIT RECORD REQUIRED [plan]"));
  assert.ok(!securityText.includes("## REVIEWER BOUNDARY"));

  const verification = compileTaskPacket(baseInput("testing", { specialization: "verification" }));
  const verificationText = renderTaskPacket(verification, packetDomain("testing", "verification"));
  assert.ok(verificationText.includes("## CRITERIA UNDER TEST [plan]"));
  assert.ok(verificationText.includes("## EVIDENCE TO ATTACH [plan]"));
  assert.ok(!verificationText.includes("## PRODUCTION CODE IS OFF-LIMITS"));

  // Section order is total over the superset, with no duplicates and the
  // mandatory frame present in every domain.
  assert.equal(PACKET_DOMAINS.length, TASK_DOMAINS.length + 2);
  assert.equal(new Set(PACKET_DOMAINS).size, PACKET_DOMAINS.length);
  const mandatory = [
    "identity",
    "objective",
    "criteria",
    "forbidden",
    "requiredOutput",
    "verification",
    "clarification",
    "handoff",
    "provenance",
  ] as const;
  for (const domain of PACKET_DOMAINS) {
    const order = SECTION_ORDER[domain];
    assert.equal(new Set(order).size, order.length, `${domain} lists a section twice`);
    for (const section of mandatory) {
      assert.ok(order.includes(section), `${domain} is missing ${section}`);
    }
  }
  for (const domain of TASK_DOMAINS) assert.ok(PACKET_DOMAINS.includes(domain));
});

// ── 9. Purity + the work-item bridge ────────────────────────────────────────

test("compileTaskPacket is pure and the work-item bridge threads every dispatch fact", () => {
  const input = compilerInputFromWorkItem(
    {
      id: "wi-9",
      missionId: "m-9",
      objective: "Add pagination to the board route",
      deliverable: "a paginated board endpoint",
      criteria: ["the route returns 20 items"],
      constraints: ["keep the existing response shape"],
      forbiddenOutcomes: ["changing the db schema"],
      requiredEvidence: ["curl output"],
      tools: ["read", "edit"],
      workingDir: "core",
      skills: [],
      failures: ["attempt 1: route returned 500"],
    },
    {
      domain: "coding",
      role: "Coder-2",
      whySelected: "measured coding owner",
      gateObservations: ["gate: criteria unmet after attempt 1"],
    },
  );

  const first = compileTaskPacket(input);
  const second = compileTaskPacket(input);
  assert.deepEqual(first, second, "same input must produce the same packet");

  assert.deepEqual(first.contract.forbiddenOutcomes, ["changing the db schema"]);
  assert.deepEqual(first.contract.authorizedWorkspace, ["core"]);
  assert.deepEqual(first.authority.allowedTools, ["read", "edit"]);
  assert.deepEqual(first.state.previousAttempts, ["attempt 1: route returned 500"]);
  assert.deepEqual(first.state.observations, ["gate: criteria unmet after attempt 1"]);
  assert.equal(first.render.handoffFormat, PACKET_HANDOFF_FORMAT);

  const text = renderTaskPacket(first, "coding");
  assert.ok(text.includes("changing the db schema"));
  assert.ok(text.includes("curl output"));
  assert.ok(text.includes("STATUS: ok | blocked | failed"));
  assert.ok(text.includes("## TASK IDENTITY [plan]"));
  assert.ok(text.includes("wi-9"));

  const custom = compileTaskPacket({ ...input, handoffFormat: "STATUS: ok | blocked" });
  assert.equal(custom.render.handoffFormat, "STATUS: ok | blocked");
});
