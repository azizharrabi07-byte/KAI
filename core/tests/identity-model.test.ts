// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The canonical KAI identity model is REAL.
 *
 * These tests prove the twelve brief fields exist and that every `*Authority` field IS
 * the actual running subsystem (reference identity + a real method call), not a string
 * that names one. They also prove the four competing pieces resolve into ONE model:
 * CoreIdentity -> `build`, KaiIdentity -> `identity`/`soul`/`capabilities`/`userContext`,
 * SOUL.md -> `soul`, KAI_HARNESS -> `harnessStatement()`.
 *
 *   cd core && node --test tests/identity-model.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createKaiIdentityModel, KAI_AGENT_ID, KAI_DISPLAY_NAME } from "../src/agent/identity-model.ts";
import { createKaiIdentity } from "../src/agent/soul.ts";
import { KAI_DIRECT_CAPABILITIES, KAI_LIMITS, capabilityProfile } from "../src/agent/kai-capabilities.ts";
import { createMemoryEngine } from "../src/memory/index.ts";
import { openMemoryStore } from "../src/storage/memoryStore.ts";
import { createSubagentMemoryShares } from "../src/memory/shares.ts";
import { createWorkforceManager } from "../src/workforce/manager.ts";
import { createSessionService, createSessionStore } from "../src/sessions/index.ts";
import { createPolicyEngine } from "../src/policies/gate.ts";
import { createApprovalService } from "../src/approvals/service.ts";
import type { Approval, ApprovalStatus, ApprovalStore } from "../src/shared/contracts.ts";
import { loadIdentity } from "../src/identity.ts";

function fakeApprovalStore(): ApprovalStore {
  const rows: Approval[] = [];
  return {
    createApproval(approval: Approval): void {
      rows.push({ ...approval });
    },
    getApproval(id: string): Approval | null {
      const row = rows.find((entry) => entry.id === id);
      return row === undefined ? null : { ...row };
    },
    listApprovals(opts?: { status?: ApprovalStatus; limit?: number }): Approval[] {
      let out = rows.map((row) => ({ ...row }));
      if (opts?.status !== undefined) out = out.filter((row) => row.status === opts.status);
      return out;
    },
    decideApproval(id: string, status: ApprovalStatus, decidedAt: string): void {
      const row = rows.find((entry) => entry.id === id);
      if (row !== undefined) {
        row.status = status;
        row.decidedAt = decidedAt;
      }
    },
  };
}

interface Harness {
  root: string;
  model: ReturnType<typeof createKaiIdentityModel>;
  subs: {
    memory: ReturnType<typeof createMemoryEngine>;
    workforce: ReturnType<typeof createWorkforceManager>;
    sessions: ReturnType<typeof createSessionService>;
    policy: ReturnType<typeof createPolicyEngine>;
    approvals: ReturnType<typeof createApprovalService>;
    shares: ReturnType<typeof createSubagentMemoryShares>;
  };
  cleanup: () => void;
}

function harness(): Harness {
  const root = mkdtempSync(join(tmpdir(), "kai-identity-model-"));
  const identity = createKaiIdentity({ root });
  const memory = createMemoryEngine({ store: openMemoryStore({ path: join(root, "memory.db") }), importLegacyOnCreate: false });
  const workforce = createWorkforceManager({});
  const sessions = createSessionService({ store: createSessionStore({ path: join(root, "sessions.db") }) });
  const policy = createPolicyEngine({});
  const approvals = createApprovalService({ store: fakeApprovalStore() });
  const shares = createSubagentMemoryShares({ path: join(root, "shares.json") });

  const model = createKaiIdentityModel({
    identity,
    memoryAuthority: memory,
    workforceAuthority: workforce,
    sessionAuthority: sessions,
    policyAuthority: policy,
    approvalAuthority: approvals,
    memoryShares: shares,
    build: loadIdentity({}),
  });

  return {
    root,
    model,
    subs: { memory, workforce, sessions, policy, approvals, shares },
    cleanup: () => {
      // Windows holds SQLite files briefly; a failed cleanup is not a test failure.
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    },
  };
}

// ── The twelve fields exist and are the right KIND of thing ──────────────────

test("the model carries all twelve canonical fields", () => {
  const h = harness();
  try {
    const m = h.model;
    assert.equal(m.agentId, KAI_AGENT_ID);
    assert.equal(m.displayName, KAI_DISPLAY_NAME);
    assert.equal(typeof m.identity, "string");
    assert.equal(typeof m.soul, "string");
    assert.ok(Array.isArray(m.capabilities) && m.capabilities.length > 0);
    assert.ok(Array.isArray(m.limits) && m.limits.length > 0);
    assert.equal(typeof m.userContext, "string");
    // authority fields are OBJECTS, never strings that name a subsystem
    for (const key of ["memoryAuthority", "workforceAuthority", "sessionAuthority", "policyAuthority", "approvalAuthority"] as const) {
      assert.equal(typeof m[key], "object", `${key} must be the real subsystem object, not a description`);
      assert.notEqual(m[key], null);
    }
    assert.equal(m.capabilities.length, KAI_DIRECT_CAPABILITIES.length);
    assert.equal(m.limits.length, KAI_LIMITS.length);
  } finally {
    h.cleanup();
  }
});

// ── Each authority field IS the running subsystem (reference identity) ───────

test("each authority field is the identical running subsystem, not a copy or a name", () => {
  const h = harness();
  try {
    const m = h.model;
    assert.equal(m.memoryAuthority, h.subs.memory);
    assert.equal(m.workforceAuthority, h.subs.workforce);
    assert.equal(m.sessionAuthority, h.subs.sessions);
    assert.equal(m.policyAuthority, h.subs.policy);
    assert.equal(m.approvalAuthority, h.subs.approvals);
  } finally {
    h.cleanup();
  }
});

// ── …and the authority can actually DO its job through the model field ───────

test("the memory authority works through the model field (write then read back)", () => {
  const h = harness();
  try {
    const write = h.model.memoryAuthority.write({
      content: "the canonical model binds the real memory engine",
      provenance: "user_statement",
    });
    assert.equal(write.ok, true, "a real write through the model's memory authority succeeds");
    const hits = h.model.memoryAuthority.search({ text: "canonical model" });
    assert.ok(hits.length >= 1, "the entry is really retrievable");
  } finally {
    h.cleanup();
  }
});

test("the session authority works through the model field (ensureActive mints a real session)", () => {
  const h = harness();
  try {
    const active = h.model.sessionAuthority.ensureActive();
    assert.ok(typeof active.id === "string" && active.id.length > 0);
    assert.equal(h.model.sessionAuthority.active()?.id, active.id, "the same session is the active one");
  } finally {
    h.cleanup();
  }
});

test("the policy authority works through the model field (real READ decision)", async () => {
  const h = harness();
  try {
    const decision = await h.model.policyAuthority.check({ risk: "READ", toolId: "file.read", action: "read a file" });
    assert.equal(typeof decision.outcome, "string");
    assert.equal(decision.outcome, "allow", "READ is allowed under the default posture");
    assert.equal(typeof h.model.policyAuthority.mode(), "string");
  } finally {
    h.cleanup();
  }
});

test("the approval authority works through the model field (a real request is recorded)", () => {
  const h = harness();
  try {
    const approval = h.model.approvalAuthority.request({
      toolId: "shell.run",
      action: "run a program",
      risk: "DESTRUCTIVE",
      reason: "prove the approval authority is live",
    });
    assert.ok(typeof approval.id === "string" && approval.id.length > 0);
    assert.equal(h.model.approvalAuthority.get(approval.id)?.id, approval.id, "the request is really stored");
  } finally {
    h.cleanup();
  }
});

test("the workforce authority works through the model field (a real, empty employee list)", () => {
  const h = harness();
  try {
    const list = h.model.workforceAuthority.list();
    assert.ok(Array.isArray(list), "the live workforce answers");
  } finally {
    h.cleanup();
  }
});

// ── The four competing pieces resolve into the ONE model ─────────────────────

test("CoreIdentity resolves into `build` (the same frozen facts, not re-derived)", () => {
  const h = harness();
  try {
    const fresh = loadIdentity({});
    // The model reports the SAME frozen facts the process's own snapshot carries —
    // build id, commit, pid and start time are facts about the process, not the caller.
    assert.equal(h.model.build.service, "kai-core");
    assert.equal(h.model.build.buildId, fresh.buildId);
    assert.equal(h.model.build.gitCommit, fresh.gitCommit);
    assert.equal(h.model.build.pid, fresh.pid);
    assert.equal(h.model.build.startedAt, fresh.startedAt);
    assert.equal(typeof h.model.build.buildId, "string");
    assert.equal(h.model.describe().buildId, h.model.build.buildId);
  } finally {
    h.cleanup();
  }
});

test("KaiIdentity resolves into identity/soul/capabilities/userContext", () => {
  const h = harness();
  try {
    const loaded = createKaiIdentity({ root: h.root }).identity();
    assert.equal(h.model.soul, loaded.soul, "soul comes from SOUL.md, not re-authored");
    assert.equal(h.model.identity, loaded.identity, "identity comes from IDENTITY.md");
    assert.equal(h.model.userContext, loaded.user, "userContext comes from USER.md");
    assert.equal(h.model.version, loaded.version);
    assert.equal(h.model.source.soulPath, loaded.source.soulPath);
  } finally {
    h.cleanup();
  }
});

test("KAI_HARNESS resolves into harnessStatement(), which claims no worker as its runtime", () => {
  const h = harness();
  try {
    const text = h.model.harnessStatement();
    assert.match(text, /KAI Core/);
    assert.match(text, /isn't Hermes's/);
    assert.match(text, /KAI_HOME/);
    // Workers are named only as delegable executors, never as what KAI is/run on.
    assert.match(text, /delegate to a worker/);
    for (const forbidden of ["Nous Research", "Hermes Agent", "HERMES_"]) {
      assert.ok(!text.includes(forbidden), `harness statement must not contain "${forbidden}"`);
    }
  } finally {
    h.cleanup();
  }
});

// ── The self-describing projection names REAL methods ────────────────────────

test("describe() reports every authority by real method names (proof it is not a string)", () => {
  const h = harness();
  try {
    const d = h.model.describe();
    assert.equal(d.authority.memory.subsystem, "MemoryEngine");
    assert.ok(d.authority.memory.methods.includes("write"));
    assert.ok(d.authority.memory.methods.includes("search"));
    assert.ok(d.authority.workforce.methods.includes("delegate"));
    assert.ok(d.authority.sessions.methods.includes("ensureActive"));
    assert.ok(d.authority.policy.methods.includes("check"));
    assert.ok(d.authority.approvals.methods.includes("request"));
    assert.ok(d.authority.memoryShares.methods.includes("grant"));
    for (const a of Object.values(d.authority)) {
      assert.ok(a.methods.length > 0, `${a.subsystem} must expose at least one real method`);
    }
  } finally {
    h.cleanup();
  }
});

test("binding marks every field backed, and is honest when a subsystem is not wired", () => {
  const h = harness();
  try {
    const binding = h.model.binding;
    for (const b of binding.filter((x) => !x.field.includes("shares"))) {
      assert.equal(b.status, "UNIT PROVEN", `${b.field} should be proven`);
      assert.ok(b.backedBy.length > 0);
    }
  } finally {
    h.cleanup();
  }

  // With no share registry handed over, the gap is stated, not hidden.
  const root = mkdtempSync(join(tmpdir(), "kai-identity-model-noshares-"));
  try {
    const model = createKaiIdentityModel({
      identity: createKaiIdentity({ root }),
      memoryAuthority: createMemoryEngine({ store: openMemoryStore({ path: join(root, "m.db") }) }),
      workforceAuthority: createWorkforceManager({}),
      sessionAuthority: createSessionService({ store: createSessionStore({}) }),
      policyAuthority: createPolicyEngine({}),
      approvalAuthority: createApprovalService({ store: fakeApprovalStore() }),
    });
    const gap = model.binding.find((b) => b.field === "memoryAuthority.shares");
    assert.ok(gap !== undefined);
    assert.equal(gap.status, "NOT PROVEN");
    assert.ok((gap.reason ?? "").length > 0, "a NOT PROVEN binding must carry a reason");
    assert.deepEqual(model.describe().authority.memoryShares.methods, []);
  } finally {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

// ── The identity layer stays free of a foreign self-claim ────────────────────

test("KAI's own seeded identity documents carry no Hermes/Nous self-claim", () => {
  // The invariant is about what KAI's identity actually SAYS, so read the real seeded
  // KAI_HOME documents rather than the source comments (which legitimately name the
  // strings only to state they are absent).
  const root = mkdtempSync(join(tmpdir(), "kai-identity-noclaim-"));
  try {
    // resolveKaiHome seeds the tree on first resolve.
    createKaiIdentity({ root }).identity();
    const docs = [
      join(root, "identity", "SOUL.md"),
      join(root, "identity", "IDENTITY.md"),
      join(root, "identity", "CAPABILITIES.md"),
      join(root, "user", "USER.md"),
      join(root, "workforce", "WORKFORCE.md"),
      join(root, "workforce", "DELEGATION.md"),
      join(root, "policy", "SAFETY.md"),
    ];
    for (const doc of docs) {
      const text = readFileSync(doc, "utf8");
      for (const forbidden of ["Nous Research", "Hermes Agent", "HERMES_"]) {
        assert.ok(!text.includes(forbidden), `${doc} must not contain "${forbidden}"`);
      }
    }
  } finally {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

// ── The capability profile answers the owner's five questions ────────────────

test("capabilityProfile classifies direct / workers / approval / external / unavailable", () => {
  const profile = capabilityProfile([
    { id: "browser", availability: "UNAVAILABLE", detail: "no CDP transport" },
    { id: "system", availability: "AVAILABLE" },
  ]);
  assert.ok(profile.direct.find((c) => c.id === "shell")?.risk === "DESTRUCTIVE");
  assert.deepEqual(profile.viaWorkers, ["Hermes", "OpenCode", "Codex"]);
  assert.ok(profile.requiresApproval.includes("shell"), "DESTRUCTIVE requires approval");
  assert.ok(!profile.requiresApproval.includes("git"), "READ does not");
  assert.ok(profile.requiresExternalAvailability.includes("browser"));
  assert.ok(profile.requiresExternalAvailability.includes("Hermes"), "a worker is an external runtime");
  assert.deepEqual(profile.currentlyUnavailable.map((u) => u.id), ["browser"]);
  assert.ok(!profile.currentlyUnavailable.find((u) => u.id === "system"));
});
