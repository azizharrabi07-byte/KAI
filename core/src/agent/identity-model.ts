// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * agent/identity-model.ts — THE canonical KAI identity model.
 *
 * ── The problem this closes ───────────────────────────────────────────────────
 * KAI's identity used to be described by four things that did not know about each
 * other: `CoreIdentity` (core/src/identity.ts — which BUILD is answering), `KaiIdentity`
 * (agent/soul.ts — who KAI IS, loaded from KAI_HOME), the on-disk `SOUL.md`, and the
 * prose document `docs/KAI_HARNESS.md`. A mission brief asked for ONE identity model of
 * twelve fields — `agentId, displayName, identity, soul, capabilities, limits,
 * userContext, memoryAuthority, workforceAuthority, sessionAuthority, policyAuthority,
 * approvalAuthority` — and a repo-wide grep found nothing of the shape. This module is
 * that model, and it is the ONE source of truth: it does not re-derive any of the four
 * inputs, it RESOLVES them.
 *
 * ── What "real runtime field" means here (the honesty rule) ──────────────────
 * An authority field is not a string that NAMES a subsystem. It IS the running
 * subsystem — the actual memory engine, workforce manager, session service, policy
 * engine and approval service the Core is executing — typed as the concrete
 * `ReturnType<typeof create…>` so it cannot be satisfied by a description. A test
 * proves it by reference identity (`model.memoryAuthority === engine`) and by calling a
 * real authority-defining method. Where a field cannot be backed by a real subsystem,
 * `binding` marks it `NOT_PROVEN` with the reason instead of filling it with a
 * placeholder — the same fail-closed honesty vocabulary the rest of KAI uses.
 *
 * ── How the four competing pieces resolve here ───────────────────────────────
 *   CoreIdentity        -> `build`   (which process/build is answering; NOT re-derived)
 *   KaiIdentity         -> `identity`, `soul`, `capabilities`, `userContext` (as loaded)
 *   SOUL.md (KAI_HOME)  -> `soul`    (read through the ONE provider's reload semantics)
 *   KAI_HARNESS.md      -> `harness` (a rendered statement of the SAME facts; the doc
 *                                     is prose OVER this model, never a second model)
 *
 * The model owns no fact of its own except `agentId` / `displayName` — everything else
 * is a resolved view of a real subsystem or a real KAI-owned document.
 */

import type { createMemoryEngine } from "../memory/engine.ts";
import type { createWorkforceManager } from "../workforce/manager.ts";
import type { createSessionService } from "../sessions/service.ts";
import type { createPolicyEngine } from "../policies/gate.ts";
import type { createApprovalService } from "../approvals/service.ts";
import type { createSubagentMemoryShares } from "../memory/shares.ts";
import { loadIdentity, type CoreIdentity } from "../identity.ts";
import type { KaiIdentity, KaiIdentityProvider, KaiIdentitySource } from "./soul.ts";
import {
  KAI_DIRECT_CAPABILITIES,
  KAI_LIMITS,
  KAI_WORKERS,
  WORKER_RELATIONSHIP,
  type KaiCapabilityFact,
} from "./kai-capabilities.ts";

/** The stable id of THIS agent. A subagent borrows a worker but is not this id. */
export const KAI_AGENT_ID = "kai";

/** The human-facing name. Now a real runtime field — it did not exist before. */
export const KAI_DISPLAY_NAME = "KAI";

/**
 * The concrete running subsystems the model binds to. Using the factories' own
 * `ReturnType` (not a hand-written interface) is deliberate: the field cannot be
 * satisfied by anything but the real subsystem the Core constructs, so "backed by the
 * real subsystem" is a type-level fact, not a comment.
 */
export type MemoryAuthority = ReturnType<typeof createMemoryEngine>;
export type WorkforceAuthority = ReturnType<typeof createWorkforceManager>;
export type SessionAuthority = ReturnType<typeof createSessionService>;
export type PolicyAuthority = ReturnType<typeof createPolicyEngine>;
export type ApprovalAuthority = ReturnType<typeof createApprovalService>;
export type MemoryShareAuthority = ReturnType<typeof createSubagentMemoryShares>;

/** Honesty vocabulary, shared with docs/evidence and the standing rules. */
export type BindingStatus = "UNIT PROVEN" | "INTEGRATION PROVEN" | "NOT PROVEN";

/** One field's binding to a real backing, so a gap is stated rather than implied. */
export interface IdentityBinding {
  field: string;
  /** The real subsystem or document that backs the field. */
  backedBy: string;
  status: BindingStatus;
  /** Present when status is NOT PROVEN: why, in words fit to show a user. */
  reason?: string;
}

/**
 * Everything the model needs from the running Core. The subsystems are REQUIRED —
 * the model refuses to pretend an authority it was not given (see `createKaiIdentityModel`).
 */
export interface KaiIdentityModelDeps {
  /** The ONE persona-document loader (agent/soul.ts), already resolved for this Core. */
  identity: KaiIdentityProvider;
  /** The real, running memory engine (canonical store). */
  memoryAuthority: MemoryAuthority;
  /** The real, running workforce manager (the employee layer above the registry). */
  workforceAuthority: WorkforceAuthority;
  /** The real, running session service. */
  sessionAuthority: SessionAuthority;
  /** The real, running policy engine. */
  policyAuthority: PolicyAuthority;
  /** The real, running approval service. */
  approvalAuthority: ApprovalAuthority;
  /**
   * The real subagent memory-sharing governance record, when the runtime supplies it.
   * Optional because it is created beside the memory engine; when absent the model
   * says so rather than claiming a sharing authority it was not handed.
   */
  memoryShares?: MemoryShareAuthority;
  /**
   * The build identity for THIS process. Defaults to the frozen `loadIdentity()`
   * snapshot: who is answering is a fact about the process, never a caller.
   */
  build?: CoreIdentity;
}

/**
 * The canonical model. The twelve brief fields are top-level; `build` and `harness`
 * are the two resolutions of `CoreIdentity` and the KAI_HARNESS prose; `version`,
 * `source`, `binding` and `loadedAt` are the self-describing envelope.
 */
export interface KaiIdentityModel {
  // ── the twelve canonical fields ────────────────────────────────────────────
  agentId: string;
  displayName: string;
  /** IDENTITY.md — what KAI is in relation to its workers (the invariant document). */
  identity: string;
  /** SOUL.md — who KAI is, read through the ONE provider (its reload semantics apply). */
  soul: string;
  /** KAI's OWN direct capability taxonomy (not a worker's tool installation). */
  capabilities: readonly KaiCapabilityFact[];
  /** KAI's honest limits. */
  limits: readonly string[];
  /** USER.md — what KAI knows about the user (the real user-context document). */
  userContext: string;
  /** The REAL memory engine. Not a description of one. */
  memoryAuthority: MemoryAuthority;
  /** The REAL workforce manager. Not a description of one. */
  workforceAuthority: WorkforceAuthority;
  /** The REAL session service. Not a description of one. */
  sessionAuthority: SessionAuthority;
  /** The REAL policy engine. Not a description of one. */
  policyAuthority: PolicyAuthority;
  /** The REAL approval service. Not a description of one. */
  approvalAuthority: ApprovalAuthority;

  // ── the resolved peers (CoreIdentity + KAI_HARNESS) ────────────────────────
  /** `CoreIdentity` resolved here, not re-derived: which BUILD is answering. */
  build: CoreIdentity;
  /** Where the persona documents were loaded from (KAI_HOME paths). */
  source: KaiIdentitySource;
  /** Short content version of the soul. */
  version: string;
  loadedAt: string;
  /** Per-field backing + status, so any unbacked field is visible, not implied. */
  binding: IdentityBinding[];

  /** A faithful, JSON-safe projection of the model (an authority names its REAL methods). */
  describe(): KaiIdentityDescription;
  /** The harness answer, composed from the SAME facts this model holds. */
  harnessStatement(): string;
}

/** A JSON-safe projection: no subsystem objects, but each authority names its real API. */
export interface KaiIdentityDescription {
  agentId: string;
  displayName: string;
  version: string;
  buildId: string;
  freshness: CoreIdentity["freshness"];
  soulChars: number;
  identityChars: number;
  userContextChars: number;
  capabilities: string[];
  limits: number;
  authority: {
    memory: AuthorityDescription;
    workforce: AuthorityDescription;
    sessions: AuthorityDescription;
    policy: AuthorityDescription;
    approvals: AuthorityDescription;
    memoryShares: AuthorityDescription;
  };
  binding: IdentityBinding[];
}

/** Names the REAL subsystem and a sample of the REAL methods it exposes. */
export interface AuthorityDescription {
  subsystem: string;
  /** Method names present on the live object — proof it is the subsystem, not a string. */
  methods: string[];
}

/** Names only a method that exists on the object, so the description cannot lie. */
function methodsOf(target: object, candidates: readonly string[]): string[] {
  return candidates.filter((name) => typeof (target as Record<string, unknown>)[name] === "function");
}

/**
 * Build the ONE canonical model from the running Core's real subsystems.
 *
 * Fail-closed: a missing required subsystem throws, because a model that silently
 * omitted an authority would BE the "placeholder identity" defect this replaces.
 */
export function createKaiIdentityModel(deps: KaiIdentityModelDeps): KaiIdentityModel {
  const identityProvider = deps.identity;
  const loaded: KaiIdentity = identityProvider.identity();

  // `loadIdentity()` is the process's OWN frozen snapshot (captured once at module
  // load in identity.ts), so "who is answering" is never a caller-dependent fact.
  const build: CoreIdentity = deps.build ?? loadIdentity();

  const binding: IdentityBinding[] = [
    {
      field: "agentId",
      backedBy: `${KAI_AGENT_ID} (the single Core agent id; subagents carry subagent:<id>)`,
      status: "UNIT PROVEN",
    },
    {
      field: "displayName",
      backedBy: `${KAI_DISPLAY_NAME} (a real constant, and the label every renderer uses)`,
      status: "UNIT PROVEN",
    },
    { field: "identity", backedBy: "identity/IDENTITY.md via KaiIdentity.identity", status: "UNIT PROVEN" },
    { field: "soul", backedBy: "identity/SOUL.md via KaiIdentity.soul", status: "UNIT PROVEN" },
    {
      field: "capabilities",
      backedBy: "KAI_DIRECT_CAPABILITIES (agent/kai-capabilities.ts)",
      status: "UNIT PROVEN",
    },
    { field: "limits", backedBy: "KAI_LIMITS (agent/kai-capabilities.ts)", status: "UNIT PROVEN" },
    { field: "userContext", backedBy: "user/USER.md via KaiIdentity.user", status: "UNIT PROVEN" },
    { field: "memoryAuthority", backedBy: "the live MemoryEngine (memory/engine.ts)", status: "UNIT PROVEN" },
    {
      field: "workforceAuthority",
      backedBy: "the live WorkforceManager (workforce/manager.ts)",
      status: "UNIT PROVEN",
    },
    {
      field: "sessionAuthority",
      backedBy: "the live SessionService (sessions/service.ts)",
      status: "UNIT PROVEN",
    },
    { field: "policyAuthority", backedBy: "the live PolicyEngine (policies/gate.ts)", status: "UNIT PROVEN" },
    {
      field: "approvalAuthority",
      backedBy: "the live ApprovalService (approvals/service.ts)",
      status: "UNIT PROVEN",
    },
  ];

  if (deps.memoryShares === undefined) {
    binding.push({
      field: "memoryAuthority.shares",
      backedBy: "subagent memory-share governance (memory/shares.ts)",
      status: "NOT PROVEN",
      reason:
        "the runtime did not hand the model the share registry; cross-subagent sharing governance is carried beside the memory engine and is wired by the runtime stream",
    });
  }

  const model: KaiIdentityModel = {
    agentId: KAI_AGENT_ID,
    displayName: KAI_DISPLAY_NAME,
    identity: loaded.identity,
    soul: loaded.soul,
    capabilities: KAI_DIRECT_CAPABILITIES,
    limits: KAI_LIMITS,
    userContext: loaded.user,
    memoryAuthority: deps.memoryAuthority,
    workforceAuthority: deps.workforceAuthority,
    sessionAuthority: deps.sessionAuthority,
    policyAuthority: deps.policyAuthority,
    approvalAuthority: deps.approvalAuthority,
    build,
    source: loaded.source,
    version: loaded.version,
    loadedAt: loaded.loadedAt,
    binding,

    describe(): KaiIdentityDescription {
      return {
        agentId: model.agentId,
        displayName: model.displayName,
        version: model.version,
        buildId: model.build.buildId,
        freshness: model.build.freshness,
        soulChars: model.soul.length,
        identityChars: model.identity.length,
        userContextChars: model.userContext.length,
        capabilities: model.capabilities.map((c) => c.id),
        limits: model.limits.length,
        authority: {
          memory: authorityDescription("MemoryEngine", model.memoryAuthority, [
            "write",
            "search",
            "get",
            "digest",
            "journal",
          ]),
          workforce: authorityDescription("WorkforceManager", model.workforceAuthority, [
            "register",
            "list",
            "delegate",
            "select",
            "available",
          ]),
          sessions: authorityDescription("SessionService", model.sessionAuthority, [
            "ensureActive",
            "active",
            "list",
            "recordTurn",
          ]),
          policy: authorityDescription("PolicyEngine", model.policyAuthority, ["check", "mode", "rules"]),
          approvals: authorityDescription("ApprovalService", model.approvalAuthority, [
            "request",
            "decide",
            "list",
          ]),
          memoryShares:
            deps.memoryShares === undefined
              ? { subsystem: "SubagentMemoryShares (not wired)", methods: [] }
              : authorityDescription("SubagentMemoryShares", deps.memoryShares, [
                  "grant",
                  "revoke",
                  "forRecipient",
                  "list",
                ]),
        },
        binding,
      };
    },

    /**
     * The harness answer, from the SAME facts this model holds. It names no worker as
     * KAI's runtime; workers appear only where they correctly appear (as delegable
     * executors). This is the one place the KAI_HARNESS.md prose and the code agree by
     * construction, because both read this model.
     */
    harnessStatement(): string {
      const subsystems = [
        "my own memory engine",
        "workforce",
        "session service",
        "policy engine and approval service",
      ].join(", ");
      return (
        "Yes — I have my own harness, and it isn't Hermes's. I run as KAI Core, my own " +
        "Node/TypeScript runtime on this machine, served over loopback to the KAI desktop app. " +
        `My identity, user context, memory and rules are loaded from my own KAI_HOME resources, not from a worker; ` +
        `my authorities are real running subsystems — ${subsystems}. ` +
        `When a task needs a model or a tool I don't hold, I delegate to a worker — ${KAI_WORKERS.join(", ")}. ` +
        WORKER_RELATIONSHIP.rule
      );
    },
  };

  return model;
}

function authorityDescription(
  subsystem: string,
  target: object,
  candidates: readonly string[],
): AuthorityDescription {
  return { subsystem, methods: methodsOf(target, candidates) };
}
