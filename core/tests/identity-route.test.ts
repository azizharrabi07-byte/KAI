// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The canonical identity model is OBSERVABLE on the Core API surface.
 *
 * `agent/identity-routes.ts` exposes the ONE identity model as `GET /identity/model`.
 * These tests prove the route serves the model's own projection, that it registers
 * the exact pattern the integration wires into `core/src/api/routes.ts`, and that
 * an unknown path 404s (so the additive surface cannot swallow another route).
 *
 *   cd core && node --test tests/identity-route.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createKaiIdentityModel } from "../src/agent/identity-model.ts";
import { createIdentityApi, registerIdentityRoutes } from "../src/agent/identity-routes.ts";
import { createKaiIdentity } from "../src/agent/soul.ts";
import { createMemoryEngine } from "../src/memory/index.ts";
import { openMemoryStore } from "../src/storage/memoryStore.ts";
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
  model: ReturnType<typeof createKaiIdentityModel>;
  cleanup: () => void;
}

function harness(): Harness {
  const root = mkdtempSync(join(tmpdir(), "kai-identity-route-"));
  const identity = createKaiIdentity({ root });
  const memory = createMemoryEngine({ store: openMemoryStore({ path: join(root, "memory.db") }), importLegacyOnCreate: false });
  const workforce = createWorkforceManager({});
  const sessions = createSessionService({ store: createSessionStore({ path: join(root, "sessions.db") }) });
  const policy = createPolicyEngine({});
  const approvals = createApprovalService({ store: fakeApprovalStore() });

  const model = createKaiIdentityModel({
    identity,
    memoryAuthority: memory,
    workforceAuthority: workforce,
    sessionAuthority: sessions,
    policyAuthority: policy,
    approvalAuthority: approvals,
    build: loadIdentity({}),
  });

  return {
    model,
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* Windows holds SQLite files briefly; best effort. */
      }
    },
  };
}

async function get(api: ReturnType<typeof createIdentityApi>, path: string) {
  return api.handle({ method: "GET", path });
}

test("GET /identity/model serves the canonical model's own projection", async () => {
  const h = harness();
  try {
    const api = createIdentityApi({ model: h.model });
    const res = await get(api, "/identity/model");
    assert.equal(res.status, 200);
    const body = res.body as {
      service: string;
      model: { agentId: string; displayName: string; authority: Record<string, { subsystem: string; methods: string[] }>; binding: unknown[] };
      harness: string;
    };
    assert.equal(body.service, "identity");
    assert.equal(body.model.agentId, "kai");
    assert.equal(body.model.displayName, "KAI");
    // The five authorities name REAL methods present on the live subsystems — proof
    // the field is the running subsystem, not a string about one.
    assert.ok(body.model.authority.memory.methods.includes("write"));
    assert.ok(body.model.authority.workforce.methods.length > 0);
    assert.ok(body.model.authority.sessions.methods.length > 0);
    assert.ok(body.model.authority.policy.methods.length > 0);
    assert.ok(body.model.authority.approvals.methods.length > 0);
    // The per-field binding is carried, so an unbacked field is visible.
    assert.ok(Array.isArray(body.model.binding) && body.model.binding.length >= 12);
    // The harness statement is the model's own — it names KAI Core, not a worker.
    assert.match(body.harness, /KAI Core/);
  } finally {
    h.cleanup();
  }
});

test("the route registers exactly GET /identity/model and 404s anything else", async () => {
  const h = harness();
  try {
    const patterns: string[] = [];
    const registration = registerIdentityRoutes(
      { route: (m, p) => patterns.push(`${m} ${p}`) },
      { model: h.model },
    );
    assert.deepEqual(patterns, ["GET /identity/model"]);
    assert.deepEqual(registration.patterns, ["GET /identity/model"]);
    assert.deepEqual(registration.api.routes(), ["GET /identity/model"]);

    const missing = await get(registration.api, "/identity/does-not-exist");
    assert.equal(missing.status, 404);
  } finally {
    h.cleanup();
  }
});

test("a registering host without a route() method throws at startup (not a silent 404)", () => {
  const h = harness();
  try {
    assert.throws(
      () => registerIdentityRoutes({} as never, { model: h.model }),
      /registerIdentityRoutes/,
    );
  } finally {
    h.cleanup();
  }
});
