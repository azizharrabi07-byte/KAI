// Chain proof for the visual engine wired into normal KAI messages
// (`src/workspace/visual.ts`).
//
//   cd app && node --test tests/workspace-visual.test.ts
//
// Two halves, both DOM-free:
//   1. the pure extractor — prose vs. a supported dialect block;
//   2. the compile path — each block goes through the injected host (which is
//      `VisualHost.compile` → `POST /visual/compile`), and a REFUSAL is surfaced
//      verbatim rather than swallowed or repaired.

import { test } from "node:test";
import assert from "node:assert/strict";
import { extractVisualBlocks, presentKaiMessage, VISUAL_MARKER, type VisualCompileHost } from "../src/workspace/visual.ts";

test("a kai-visual fenced block is extracted, prose kept with a marker", () => {
  const message = "Here is the plan:\n\n```kai-visual\nflowchart TD\nA[Start] --> B{Done}\n```\n\nThat is all.";
  const out = extractVisualBlocks(message);
  assert.equal(out.blocks.length, 1);
  assert.equal(out.blocks[0], "flowchart TD\nA[Start] --> B{Done}");
  assert.ok(out.text.includes("Here is the plan:"));
  assert.ok(out.text.includes(VISUAL_MARKER));
  assert.ok(!out.text.includes("flowchart TD"));
  assert.ok(out.text.includes("That is all."));
});

test("mermaid and flowchart fences are recognised; a ts fence is left alone", () => {
  const mermaid = extractVisualBlocks("```mermaid\nflowchart LR\nA-->B\n```");
  assert.equal(mermaid.blocks.length, 1);
  const ts = extractVisualBlocks("```ts\nconst x = 1;\n```");
  assert.equal(ts.blocks.length, 0);
  assert.ok(ts.text.includes("const x = 1;"));
});

test("a message with no visual block is returned unchanged by the extractor", () => {
  const text = "Just a normal answer with a `code` span.";
  const out = extractVisualBlocks(text);
  assert.equal(out.blocks.length, 0);
  assert.equal(out.text, text);
});

test("each visual block is compiled through the injected host", async () => {
  const seen: string[] = [];
  const host: VisualCompileHost = {
    async compile(source) {
      seen.push(source);
      return { ok: true };
    },
  };
  const presented = await presentKaiMessage(host, "```kai-visual\nflowchart TD\nA-->B\n```");
  assert.deepEqual(seen, ["flowchart TD\nA-->B"]);
  assert.equal(presented.outcomes.length, 1);
  assert.equal(presented.outcomes[0]?.ok, true);
  assert.ok(presented.text.includes(VISUAL_MARKER));
});

test("a Core refusal is surfaced verbatim, never repaired", async () => {
  const host: VisualCompileHost = {
    async compile() {
      return { ok: false, code: "UNSAFE_NODE_LABEL", reason: '"nodes[0].label" must not contain markup' };
    },
  };
  const presented = await presentKaiMessage(host, "```mermaid\nflowchart TD\nA[<script>]-->B\n```");
  assert.equal(presented.outcomes[0]?.ok, false);
  assert.equal(presented.outcomes[0]?.code, "UNSAFE_NODE_LABEL");
  assert.match(presented.outcomes[0]?.reason ?? "", /must not contain markup/);
});

test("with no host mounted, the message is returned with its blocks intact", async () => {
  const message = "```kai-visual\nflowchart TD\nA-->B\n```";
  const presented = await presentKaiMessage(null, message);
  assert.equal(presented.text, message, "no host means no silent stripping of the diagram");
  assert.equal(presented.outcomes.length, 0);
});

test("an empty visual fence is not a source and the text is not altered", () => {
  const message = "```kai-visual\n\n```";
  const out = extractVisualBlocks(message);
  assert.equal(out.blocks.length, 0);
  assert.ok(out.text.includes("kai-visual"));
});
