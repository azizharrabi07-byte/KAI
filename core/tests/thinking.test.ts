// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Thinking levels — the settings must reach the REAL outbound request.
 *
 * A level that only changes a label is a lie the user has no way to check, so these
 * tests assert on the body the provider actually sends, captured through an injected
 * fetch. Two properties matter most:
 *
 *   • a level ALWAYS changes the request (a token budget), so no level is a no-op;
 *   • `reasoning_effort` is sent ONLY when the provider declares it accepts it —
 *     a preference must never be able to turn a working turn into a 400.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createOpenAICompatibleProvider } from "../src/model/openai-compatible.ts";
import { thinkingPlan, isThinkingLevel, THINKING_LEVELS } from "../src/model/thinking.ts";
import type { ThinkingLevel } from "../src/model/types.ts";

/** A provider whose outbound body is captured instead of sent. */
function capturingProvider(options: { supportsReasoningEffort?: boolean } = {}) {
  const sent: Record<string, unknown>[] = [];
  const fetchImpl = (async (_url: unknown, init: { body?: unknown } = {}) => {
    sent.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return new Response(
      JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  const provider = createOpenAICompatibleProvider({
    id: "test",
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "k",
    model: "m",
    fetchImpl,
    ...(options.supportsReasoningEffort === true ? { supportsReasoningEffort: true } : {}),
  });
  return { provider, sent };
}

test("every level is a real level, and a non-level is not", () => {
  for (const level of THINKING_LEVELS) assert.equal(isThinkingLevel(level), true);
  for (const bad of ["", "none", "ultra", "Instant", 42, null, undefined, {}]) {
    assert.equal(isThinkingLevel(bad), false, `${JSON.stringify(bad)} must not be a level`);
  }
});

test("the plan always changes the request, and names what it changed", () => {
  const budgets = new Set<number>();
  for (const level of THINKING_LEVELS) {
    const plan = thinkingPlan(level, false);
    assert.ok(plan.applied.includes("max_tokens"), `${level} must set a budget`);
    assert.ok(plan.maxTokens > 0, `${level} needs a positive budget`);
    budgets.add(plan.maxTokens);
  }
  // Distinct budgets: otherwise two levels would be the same request with different labels.
  assert.equal(budgets.size, THINKING_LEVELS.length, "each level must ask for a different budget");
});

test("a provider with NO reasoning control gets a budget and an honest note, never reasoning_effort", () => {
  for (const level of ["low", "high", "max"] as ThinkingLevel[]) {
    const plan = thinkingPlan(level, false);
    assert.equal(plan.reasoningEffort, undefined, `${level} must not claim a reasoning setting`);
    assert.ok(typeof plan.note === "string" && plan.note.length > 0, `${level} must explain the fallback`);
    assert.doesNotMatch(plan.note, /applied as a .* is in force/i);
  }
});

test("a provider WITH reasoning control gets reasoning_effort, and a note is not needed", () => {
  for (const level of ["low", "high", "max"] as ThinkingLevel[]) {
    const plan = thinkingPlan(level, true);
    assert.ok(plan.reasoningEffort !== undefined, `${level} must map to a reasoning effort`);
    assert.ok(plan.applied.includes("reasoning_effort"), `${level} must record it`);
    assert.equal(plan.note, undefined, `${level} needs no fallback note when it is honoured`);
  }
  // `instant` asks for no reasoning pass even where the knob exists.
  assert.equal(thinkingPlan("instant", true).reasoningEffort, undefined);
});

test("the level reaches the OUTBOUND body: one distinct max_tokens per level", async () => {
  const { provider, sent } = capturingProvider();
  for (const level of THINKING_LEVELS) {
    await provider.chat({ messages: [{ role: "user", content: "hi" }], thinking: level });
  }
  assert.equal(sent.length, THINKING_LEVELS.length);
  const budgets = sent.map((body) => body["max_tokens"]);
  assert.deepEqual(
    budgets,
    THINKING_LEVELS.map((level) => thinkingPlan(level, false).maxTokens),
    "each level must send its own budget on the wire",
  );
  // And none of them may carry a reasoning field the endpoint would reject.
  for (const body of sent) {
    assert.equal(body["reasoning_effort"], undefined);
  }
});

test("reasoning_effort is sent ONLY when the provider declares support", async () => {
  const off = capturingProvider();
  await off.provider.chat({ messages: [{ role: "user", content: "hi" }], thinking: "max" });
  assert.equal(off.sent[0]["reasoning_effort"], undefined, "unsupported provider must not receive the field");

  const on = capturingProvider({ supportsReasoningEffort: true });
  await on.provider.chat({ messages: [{ role: "user", content: "hi" }], thinking: "max" });
  assert.equal(on.sent[0]["reasoning_effort"], "high", "a supporting provider must receive it");
});

test("no thinking level leaves the request exactly as it was", async () => {
  const { provider, sent } = capturingProvider();
  await provider.chat({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(sent[0]["max_tokens"], undefined);
  assert.equal(sent[0]["reasoning_effort"], undefined);
});

test("an explicit maxTokens WINS over the level's budget", async () => {
  // A caller that set its own limit is making a stronger statement than a preference;
  // silently overriding it would make that caller's limit vanish.
  const { provider, sent } = capturingProvider();
  await provider.chat({ messages: [{ role: "user", content: "hi" }], thinking: "max", maxTokens: 77 });
  assert.equal(sent[0]["max_tokens"], 77);
});

test("the provider reports its reasoning support honestly through capabilities()", () => {
  assert.equal(capturingProvider().provider.capabilities().supportsReasoningEffort, false);
  assert.equal(
    capturingProvider({ supportsReasoningEffort: true }).provider.capabilities().supportsReasoningEffort,
    true,
  );
});
