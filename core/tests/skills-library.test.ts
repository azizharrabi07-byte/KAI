// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

// KAI's curated third-party skill library: the files on disk validate, the
// runtime seeds them after the builtins, reseeding is a no-op, `@` resolves
// them, and `relevant()` surfaces them.
//
//   cd core && node --test tests/skills-library.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCoreRuntime } from "../src/runtime.ts";
import { parseSkillMarkdown } from "../src/skills/validate.ts";
import {
  KAI_LIBRARY_SOURCE,
  libraryDir,
  listLibrarySkills,
  seedLibrarySkills,
} from "../src/skills/library.ts";
import { BUILTIN_SKILLS } from "../src/skills/builtin.ts";
import { parseInvocations, resolveInvocations } from "../src/chat/invoke.ts";

const EXPECTED_BUILTINS = ["deep-research", "session-briefing", "plan-review", "fact-check"];

function bootOptions(dir: string) {
  return {
    dbPath: join(dir, "core.db"),
    agents: { mode: "mock" as const },
    startScheduler: false,
    subsystemPaths: { runUpkeepOnStart: false, ledgerPath: join(dir, "ledger.db") },
  };
}

test("library on disk holds >=250 skills and every file validates", () => {
  const dir = libraryDir();
  const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  assert.ok(files.includes("SOURCES.md"), "library keeps its SOURCES.md provenance file");
  const skillFiles = files.filter((f) => f !== "SOURCES.md");
  assert.ok(
    skillFiles.length >= 250,
    `expected >=250 library skills on disk, found ${skillFiles.length}`,
  );

  for (const file of skillFiles) {
    const id = file.slice(0, -".md".length);
    const markdown = readFileSync(join(dir, file), "utf8");
    const parsed = parseSkillMarkdown(markdown, { id });
    assert.equal(
      parsed.ok,
      true,
      `library file "${file}" (id "${id}") refused: ${!parsed.ok ? parsed.error.message : ""}`,
    );
  }

  // The loader agrees: nothing skipped, everything reported as a skill.
  const listed = listLibrarySkills();
  assert.equal(
    listed.skipped.length,
    0,
    `listLibrarySkills skipped ${listed.skipped.length}: ${listed.skipped
      .slice(0, 5)
      .map((s) => `${s.file} (${s.reason.slice(0, 120)})`)
      .join("; ")}`,
  );
  assert.ok(
    listed.skills.length >= 250,
    `expected >=250 skills from listLibrarySkills, got ${listed.skills.length}`,
  );
});

test("boot seeds the library after the builtins, all enabled", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kai-skills-library-boot-"));
  const rt = createCoreRuntime(bootOptions(dir));
  await rt.start();
  t.after(async () => {
    await rt.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  assert.ok(BUILTIN_SKILLS.length >= 4, "sanity: builtins are a library, not a sample");

  const listed = rt.skills.list();
  const library = listed.filter((s) => s.source === KAI_LIBRARY_SOURCE);
  assert.ok(
    library.length >= 250,
    `expected >=250 skills with source ${KAI_LIBRARY_SOURCE}, got ${library.length} of ${listed.length}`,
  );
  for (const id of EXPECTED_BUILTINS) {
    assert.ok(rt.skills.has(id), `builtin "${id}" missing after boot with library`);
  }
  const builtins = listed.filter((s) => s.source === "builtin");
  assert.ok(builtins.length >= 4, `expected >=4 builtins, got ${builtins.length}`);
  assert.ok(
    library.every((s) => s.status === "enabled"),
    "library skills boot enabled",
  );
  assert.ok(
    builtins.every((s) => s.status === "enabled"),
    "builtins stay enabled with the library seeded",
  );
});

test("reseeding the library plants nothing and fails nothing", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kai-skills-library-idem-"));
  const rt = createCoreRuntime(bootOptions(dir));
  await rt.start();
  t.after(async () => {
    await rt.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  const again = seedLibrarySkills(rt.skills);
  assert.deepEqual(again.seeded, [], "a second library seed plants nothing");
  assert.equal(again.failed.length, 0, `resed failures: ${JSON.stringify(again.failed).slice(0, 400)}`);
});

test("@ resolution and load work for real library skills", async (t) => {
  const { skills } = listLibrarySkills();
  assert.ok(skills.length >= 3, "need at least 3 library skills to sample");
  const sample = [skills[0]!.id, skills[Math.floor(skills.length / 2)]!.id, skills[skills.length - 1]!.id];
  assert.equal(new Set(sample).size, 3, `sample ids collide: ${sample.join(", ")}`);

  const dir = mkdtempSync(join(tmpdir(), "kai-skills-library-at-"));
  const rt = createCoreRuntime(bootOptions(dir));
  await rt.start();
  t.after(async () => {
    await rt.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  const listed = rt.skills.list();
  const directory = listed.map((skill) => ({
    id: skill.id,
    name: skill.name,
    disabled: skill.status === "disabled",
  }));

  for (const id of sample) {
    const parsed = parseInvocations(`@${id} do work`);
    assert.ok(parsed !== null, `@${id} should parse as an invocation`);
    const resolved = resolveInvocations(parsed, { agents: [], skills: directory });
    assert.deepEqual(resolved.skills, [id], `@${id} resolves to itself`);
    assert.deepEqual(resolved.unknown, [], `@${id} leaves no unknowns`);

    const loaded = rt.skills.load(id);
    assert.equal(loaded.ok, true, `library skill "${id}" loads for the turn`);
    if (loaded.ok) {
      assert.ok(
        loaded.value.body.trim().length > 0,
        `library skill "${id}" has a non-empty body`,
      );
    }
  }
});

test("relevant() surfaces library skills for a topic like git or testing", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kai-skills-library-rel-"));
  const rt = createCoreRuntime(bootOptions(dir));
  await rt.start();
  t.after(async () => {
    await rt.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  assert.equal(
    typeof (rt.skills as { relevant?: unknown }).relevant,
    "function",
    "registry exposes relevant() for discovery",
  );

  const topics = ["git", "testing"];
  if (typeof rt.skills.relevant === "function") {
    const perTopic = topics.map((topic) => ({
      topic,
      hits: rt.skills.relevant!(topic, 10),
    }));
    const withLibrary = perTopic.filter((entry) =>
      entry.hits.some((hit) => hit.source === KAI_LIBRARY_SOURCE),
    );
    assert.ok(
      withLibrary.length > 0,
      `expected relevant() to return library skills for at least one of ${topics.join("/")}; ` +
        perTopic.map((e) => `${e.topic}=>${e.hits.length}`).join(", "),
    );
  } else {
    // Fallback the spec allows: match by name when relevant() is absent.
    const listed = rt.skills.list();
    const matches = listed.filter(
      (s) =>
        s.source === KAI_LIBRARY_SOURCE &&
        (s.id.includes("git") || s.name.toLowerCase().includes("git") ||
          s.id.includes("test") || s.name.toLowerCase().includes("test")),
    );
    assert.ok(matches.length > 0, "library holds git/testing skills matchable by name");
  }
});

test("boot with the full library stays under the 120s budget", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kai-skills-library-budget-"));
  const t0 = Date.now();
  const rt = createCoreRuntime(bootOptions(dir));
  await rt.start();
  const ms = Date.now() - t0;
  t.after(async () => {
    await rt.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  t.diagnostic(`full library boot took ${ms}ms`);
  console.log(`[skills-library] boot took ${ms}ms`);
  assert.ok(ms < 120_000, `library boot took ${ms}ms, over the 120s budget`);
  assert.ok(
    rt.skills.list().filter((s) => s.source === KAI_LIBRARY_SOURCE).length >= 250,
    "budget boot still seeded the library",
  );
});
