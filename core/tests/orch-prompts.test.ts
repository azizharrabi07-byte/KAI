// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Worker prompt engine + pattern library tests.
 * Plain `node --test`, no dependencies, no network.
 * Run from `core/`:  node --test tests/orch-prompts.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  CONTEXT_CHAR_CAP,
  WORKER_PROMPT_SECTIONS,
  buildWorkerPrompt,
  createPattern,
  recordPatternOutcome,
  selectPattern,
  type WorkerPromptInput,
} from "../src/orchestration/prompts.ts";
import type {
  PromptPatternRecord,
  PromptPatternStore,
} from "../src/shared/contracts.ts";

// ── Fakes ─────────────────────────────────────────────────────────────────────

function fakePatternStore(): PromptPatternStore & {
  rows: Map<string, PromptPatternRecord>;
} {
  const rows = new Map<string, PromptPatternRecord>();
  const clone = (p: PromptPatternRecord): PromptPatternRecord =>
    JSON.parse(JSON.stringify(p)) as PromptPatternRecord;
  return {
    rows,
    upsert(pattern: PromptPatternRecord): void {
      rows.set(pattern.id, clone(pattern));
    },
    get(id: string): PromptPatternRecord | null {
      const row = rows.get(id);
      return row === undefined ? null : clone(row);
    },
    list(taskType?: string): PromptPatternRecord[] {
      const out: PromptPatternRecord[] = [];
      for (const row of rows.values()) {
        if (taskType === undefined || row.taskType === taskType) out.push(clone(row));
      }
      return out;
    },
  };
}

function baseInput(overrides: Partial<WorkerPromptInput> = {}): WorkerPromptInput {
  return {
    mission: "Ship the offline-first release",
    role: "coder",
    whySelected: "best measured quality on coding tasks",
    objective: "Implement the worker prompt engine",
    context: ["repo is kai/core", "node >= 20"],
    knownState: ["orchestration/types.ts is frozen"],
    previousAttempts: ["attempt 1: prompt too long"],
    constraints: ["only create new files"],
    scope: "src/orchestration/*",
    requiredOutput: "prompts.ts + review.ts + tests",
    successCriteria: ["tests green", "typecheck clean"],
    verification: ["node --test", "npm run typecheck"],
    budget: "max 200 tool calls",
    handoffFormat: "WorkerHandoff struct",
    ...overrides,
  };
}

// ── Template sections ─────────────────────────────────────────────────────────

test("all template sections are present in order", () => {
  const prompt = buildWorkerPrompt(baseInput());
  assert.equal(WORKER_PROMPT_SECTIONS.length, 13);
  let cursor = -1;
  for (const section of WORKER_PROMPT_SECTIONS) {
    const marker = `## ${section}`;
    const idx = prompt.indexOf(marker);
    assert.ok(idx !== -1, `missing section: ${marker}`);
    assert.ok(idx > cursor, `section out of order: ${marker}`);
    cursor = idx;
  }
});

test("secret values are redacted and never forwarded raw", () => {
  const secret = `api_key = "sk-live-1234567890"`;
  const prompt = buildWorkerPrompt(
    baseInput({ context: [`deployer used ${secret} yesterday`, "plain fact"] }),
  );
  assert.ok(!prompt.includes("sk-live-1234567890"), `secret leaked: ${prompt}`);
  assert.ok(prompt.includes("[redacted]"));
});

test("oversized context is capped", () => {
  const big = Array.from(
    { length: 200 },
    (_, i) => `fact ${i}: the worker prompt keeps thirteen ordered sections`,
  ).join(" ");
  const prompt = buildWorkerPrompt(baseInput({ context: [big] }));
  assert.ok(!prompt.includes(big), "unbounded context was forwarded whole");
  const marker = "## CONTEXT";
  const start = prompt.indexOf(marker);
  const end = prompt.indexOf("## KNOWN STATE");
  assert.ok(start !== -1 && end !== -1 && end > start);
  const body = prompt.slice(start, end);
  // 2000 chars of context + bullets + truncation note: generous ceiling.
  assert.ok(
    body.length < CONTEXT_CHAR_CAP + 500,
    `context section too long: ${body.length}`,
  );
  assert.ok(body.includes("truncated to 2000 chars"));
});

// ── Pattern library math ──────────────────────────────────────────────────────

test("createPattern stores a zeroed pattern via the store", () => {
  const store = fakePatternStore();
  const created = createPattern(store, {
    taskType: "coding",
    template: "do {{objective}}",
    requiredFields: ["objective"],
    id: "pat-coding-1",
  });
  assert.equal(created.uses, 0);
  assert.equal(created.successes, 0);
  const stored = store.get("pat-coding-1");
  assert.ok(stored !== null);
  assert.equal(stored?.template, "do {{objective}}");
});

test("selectPattern picks the best successes/uses ratio with min 1 use", () => {
  const store = fakePatternStore();
  createPattern(store, { taskType: "coding", template: "A", id: "a" });
  createPattern(store, { taskType: "coding", template: "B", id: "b" });
  createPattern(store, { taskType: "coding", template: "C", id: "c" });
  // A: 1/1 = 1.0 ; B: 3/4 = 0.75 ; C: 0 uses -> ineligible.
  recordPatternOutcome(store, "a", true);
  recordPatternOutcome(store, "b", true);
  recordPatternOutcome(store, "b", true);
  recordPatternOutcome(store, "b", true);
  recordPatternOutcome(store, "b", false);
  const picked = selectPattern(store, "coding");
  assert.ok(picked !== null);
  assert.equal(picked?.id, "a");
});

test("selectPattern returns null when nothing has been used", () => {
  const store = fakePatternStore();
  createPattern(store, { taskType: "research", template: "R", id: "r1" });
  assert.equal(selectPattern(store, "research"), null);
  assert.equal(selectPattern(store, "coding"), null);
});

test("recordPatternOutcome advances uses and successes", () => {
  const store = fakePatternStore();
  createPattern(store, { taskType: "testing", template: "T", id: "t1" });
  recordPatternOutcome(store, "t1", true);
  recordPatternOutcome(store, "t1", false);
  const row = store.get("t1");
  assert.equal(row?.uses, 2);
  assert.equal(row?.successes, 1);
  // A success now makes it selectable with a 2/3 ratio.
  recordPatternOutcome(store, "t1", true);
  const picked = selectPattern(store, "testing");
  assert.equal(picked?.id, "t1");
  assert.equal(picked?.uses, 3);
  assert.equal(picked?.successes, 2);
});

test("recordPatternOutcome throws on unknown ids", () => {
  const store = fakePatternStore();
  assert.throws(() => recordPatternOutcome(store, "missing", true), /unknown prompt pattern/);
});
