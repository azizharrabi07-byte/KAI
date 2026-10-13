// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

// KAI's builtin skill library: every builtin passes the same validation as a
// staged third-party skill, seeding is idempotent, a human replacement wins,
// and the library is visible through the live routes + `@` invocation.
//
//   cd core && node --test tests/skills-builtin.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { createCoreRuntime } from "../src/runtime.ts";
import { createKaiServer } from "../src/server.ts";
import { loadConfig } from "../src/config.ts";
import { parseSkillMarkdown } from "../src/skills/validate.ts";
import { BUILTIN_SKILLS, seedBuiltinSkills } from "../src/skills/builtin.ts";
import { parseInvocations, resolveInvocations } from "../src/chat/invoke.ts";
import { liveModelSkipReason } from "./live-model.ts";

/** A live model is required here; without one this suite SKIPS, named. */
const MODEL_SKIP = liveModelSkipReason();

test("every builtin passes the same validation as a third-party skill", () => {
  assert.ok(BUILTIN_SKILLS.length >= 4, "a library, not a sample");
  const ids = new Set<string>();
  for (const skill of BUILTIN_SKILLS) {
    assert.ok(!ids.has(skill.id), `duplicate builtin id ${skill.id}`);
    ids.add(skill.id);
    const parsed = parseSkillMarkdown(skill.markdown, { id: skill.id });
    assert.equal(parsed.ok, true, `builtin "${skill.id}" refused: ${!parsed.ok ? parsed.error.message : ""}`);
  }
});

test("seeding is idempotent and a human replacement wins", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kai-skills-builtin-"));
  const rt = createCoreRuntime({
    dbPath: join(dir, "core.db"),
    agents: { mode: "mock" },
    startScheduler: false,
    subsystemPaths: { runUpkeepOnStart: false, ledgerPath: join(dir, "ledger.db") },
  });
  await rt.start();
  t.after(async () => {
    await rt.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  // Boot seeded the library.
  for (const skill of BUILTIN_SKILLS) {
    assert.ok(rt.skills.has(skill.id), `builtin "${skill.id}" missing after boot`);
  }
  const again = seedBuiltinSkills(rt.skills);
  assert.deepEqual(again.seeded, [], "a second seed plants nothing");
  assert.equal(again.failed.length, 0);
  assert.ok(again.skipped.length >= 4, "present ids are reported as skipped");

  // The registry is create-only: a builtin id cannot be overwritten by register.
  const clash = rt.skills.register({ id: BUILTIN_SKILLS[0]!.id, markdown: BUILTIN_SKILLS[0]!.markdown });
  assert.equal(clash.ok, false, "re-registering a builtin id is refused");
});

test("builtins are listed with source builtin and resolve through @ invocation", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kai-skills-builtin-live-"));
  const rt = createCoreRuntime({
    dbPath: join(dir, "core.db"),
    agents: { mode: "mock" },
    startScheduler: false,
    subsystemPaths: { runUpkeepOnStart: false, ledgerPath: join(dir, "ledger.db") },
  });
  await rt.start();
  t.after(async () => {
    await rt.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  const listed = rt.skills.list();
  const builtins = listed.filter((s) => s.source === "builtin");
  assert.ok(builtins.length >= 4, `expected builtins in list, got ${listed.length} total`);
  assert.ok(builtins.every((s) => s.status === "enabled"), "builtins boot enabled");

  // The `@` directory the router reads is the LIVE registry: builtins resolve.
  const directory = listed.map((skill) => ({ id: skill.id, name: skill.name, disabled: skill.status === "disabled" }));
  const parsed = parseInvocations("@deep-research what do we know");
  assert.ok(parsed !== null);
  const resolved = resolveInvocations(parsed, { agents: [], skills: directory });
  assert.deepEqual(resolved.skills, ["deep-research"]);
  assert.deepEqual(resolved.unknown, []);
  const loaded = rt.skills.load("deep-research");
  assert.equal(loaded.ok, true, "the builtin body loads for the turn");
  if (loaded.ok) assert.match(loaded.value.body, /shared schema/, "the skill body renders as guidance");
});

test("the KAI workflow pack resolves, loads, and carries output contracts", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kai-skills-pack-"));
  const rt = createCoreRuntime({
    dbPath: join(dir, "core.db"),
    agents: { mode: "mock" },
    startScheduler: false,
    subsystemPaths: { runUpkeepOnStart: false, ledgerPath: join(dir, "ledger.db") },
  });
  await rt.start();
  t.after(async () => {
    await rt.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const ids = [
    "deep-research",
    "skill-creator",
    "artifact-verification",
    "goal-tracking",
    "memory-forgetting",
    "travel-planning",
    "connector-workflow",
    "execution-trace",
  ];
  for (const id of ids) {
    const parsed = parseInvocations(`@${id} do the work`);
    assert.ok(parsed !== null);
    const resolved = resolveInvocations(parsed, { agents: [], skills: rt.skills.list().map((s) => ({ id: s.id, name: s.name, disabled: s.status === "disabled" })) });
    assert.deepEqual(resolved.skills, [id], `@${id} resolves`);
    const loaded = rt.skills.load(id);
    assert.equal(loaded.ok, true, `${id} loads`);
    if (loaded.ok) {
      assert.match(loaded.value.body, /OUTPUT CONTRACT/, `${id} defines its output contract`);
      assert.match(loaded.value.body, /VERIFICATION/, `${id} defines verification`);
    }
  }
  const relevant = rt.skills.relevant("verify a created deliverable before sending it", 5);
  assert.ok(relevant.some((s) => s.id === "artifact-verification"), "trigger wording finds the skill");
  const trace = rt.skills.relevant("what happened during that failed task", 5);
  assert.ok(trace.some((s) => s.id === "execution-trace"), "failure post-mortem finds execution-trace");
});

test("an adapted skill rides a real turn end to end", { skip: MODEL_SKIP }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kai-skills-ride-"));
  const rt = createCoreRuntime({
    dbPath: join(dir, "core.db"),
    agents: { mode: "mock" },
    startScheduler: false,
    model: {
      fetchImpl: (async () => new Response(
        JSON.stringify({ choices: [{ message: { role: "assistant", content: "TRACE-RIDE-OK" } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch,
    },
    subsystemPaths: { runUpkeepOnStart: false, ledgerPath: join(dir, "ledger.db") },
  });
  await rt.start();
  t.after(async () => {
    await rt.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const session = rt.sessions.create({ title: "ride" });
  const answer = await rt.chat.answer("@execution-trace what happened in that failed task", { sessionId: session.id });
  assert.deepEqual(answer.invocation, { agents: [], skills: ["execution-trace"] });
  assert.equal(answer.text, "TRACE-RIDE-OK");
  assert.equal(answer.taskState, "COMPLETED");
});

test("LIVE HTTP: a staged skill discards cleanly, an unknown id 404s", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kai-skills-discard-"));
  const rt = createCoreRuntime({
    dbPath: join(dir, "core.db"),
    agents: { mode: "mock" },
    startScheduler: false,
    subsystemPaths: { runUpkeepOnStart: false, ledgerPath: join(dir, "ledger.db") },
  });
  await rt.start();
  const server = createKaiServer(loadConfig(process.env), { core: rt });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rt.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const staged = rt.skillStaging.stage({ id: "throwaway", markdown: BUILTIN_SKILLS[0]!.markdown });
  assert.equal(staged.ok, true);
  const stagedId = staged.ok ? staged.value.stagedId : "";
  const before = (await (await fetch(`${base}/skills/staging`)).json()) as { staged: unknown[] };
  assert.ok(before.staged.length >= 1);

  const discarded = await fetch(`${base}/skills/staging/${stagedId}/discard`, { method: "POST" });
  assert.equal(discarded.status, 200);
  const after = (await (await fetch(`${base}/skills/staging`)).json()) as { staged: unknown[] };
  assert.ok(!after.staged.some((s) => (s as { stagedId: string }).stagedId === stagedId), "the staged skill is gone");

  const missing = await fetch(`${base}/skills/staging/staged_nope/discard`, { method: "POST" });
  assert.equal(missing.status, 404, "discarding an unknown staged id is a 404, not a silent ok");
});
