// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * KAI Visual Engine — the structured-visual-intent seam (Core side).
 *
 * Plain `node --test`, no network. Run from `core/`:
 *   node --test tests/visual.test.ts
 *
 * These tests are the CONTRACT: a valid dialect compiles to a bounded, typed
 * intent; anything malformed or adversarial is REFUSED with a named field, and
 * is never silently repaired into something a renderer would draw.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  compileVisual,
  validateIntent,
  VISUAL_LIMITS,
  type VisualIntent,
} from "../src/visual/spec.ts";

test("compiles a Mermaid-like flow into a typed, bounded intent", () => {
  const result = compileVisual(
    [
      "flowchart TD",
      "A[Start] --> B{Check}",
      "B -->|yes| C([Done])",
      "B -->|no| A",
      "%% a comment is ignored",
    ].join("\n"),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const intent: VisualIntent = result.intent;
  assert.equal(intent.kind, "flow");
  assert.equal(intent.direction, "TD");
  assert.deepEqual(
    intent.nodes.map((n) => [n.id, n.label, n.shape]),
    [
      ["A", "Start", "box"],
      ["B", "Check", "diamond"],
      ["C", "Done", "round"],
    ],
  );
  assert.equal(intent.edges.length, 3);
  assert.deepEqual(intent.edges[1], { from: "B", to: "C", label: "yes" });
});

test("defaults a bare id to its own label and a box shape", () => {
  const result = compileVisual("A --> B");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.intent.nodes, [
    { id: "A", label: "A", shape: "box" },
    { id: "B", label: "B", shape: "box" },
  ]);
  assert.equal(result.intent.direction, "TD");
});

test("folds TB/RL/BT into the two directions the engine draws", () => {
  const lr = compileVisual("graph LR\nA --> B");
  assert.equal(lr.ok && lr.intent.direction, "LR");
  const rl = compileVisual("flowchart RL\nA --> B");
  assert.equal(rl.ok && rl.intent.direction, "LR");
  const tb = compileVisual("flowchart TB\nA --> B");
  assert.equal(tb.ok && tb.intent.direction, "TD");
});

test("REFUSES a label carrying markup (adversarial input)", () => {
  const result = compileVisual('A[<script>alert(1)</script>] --> B');
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "UNSAFE_NODE_LABEL");
  assert.match(result.reason, /markup or control characters/);
});

test("REFUSES a structured intent with an unsafe label", () => {
  const result = validateIntent({
    kind: "flow",
    direction: "TD",
    nodes: [{ id: "A", label: "<img onerror=alert(1)>", shape: "box" }],
    edges: [],
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "UNSAFE_NODE_LABEL");
});

test("REFUSES a self-loop", () => {
  const result = compileVisual("A --> A");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "SELF_LOOP");
});

test("REFUSES an edge that names a node that does not exist", () => {
  const result = validateIntent({
    kind: "flow",
    direction: "TD",
    nodes: [{ id: "A", label: "A", shape: "box" }],
    edges: [{ from: "A", to: "ghost" }],
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "BAD_EDGE_ENDPOINT");
});

test("REFUSES a node id that is not a conservative identifier", () => {
  const result = validateIntent({
    kind: "flow",
    direction: "TD",
    nodes: [{ id: "a b", label: "x", shape: "box" }],
    edges: [],
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "BAD_NODE_ID");
});

test("REFUSES a duplicate node id", () => {
  const result = validateIntent({
    kind: "flow",
    direction: "TD",
    nodes: [
      { id: "A", label: "one", shape: "box" },
      { id: "A", label: "two", shape: "box" },
    ],
    edges: [],
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "DUPLICATE_NODE");
});

test("REFUSES a structure that exceeds the node bound", () => {
  const nodes = Array.from({ length: VISUAL_LIMITS.maxNodes + 1 }, (_, i) => ({
    id: `N${i}`,
    label: `n${i}`,
    shape: "box" as const,
  }));
  const result = validateIntent({ kind: "flow", direction: "TD", nodes, edges: [] });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "TOO_MANY_NODES");
});

test("REFUSES an unsupported diagram kind rather than ignoring it", () => {
  const result = compileVisual("pie\n\"A\": 40");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "UNSUPPORTED_KIND");
});

test("compiles a sequence diagram into typed actors and ordered messages", () => {
  const result = compileVisual(
    [
      "sequenceDiagram",
      "participant A as Alice",
      "participant B",
      "A->>B: Hello",
      "B-->>A: Hi",
      "A->>A: note",
    ].join("\n"),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const intent = result.intent;
  assert.equal(intent.kind, "sequence");
  if (intent.kind !== "sequence") return;
  assert.deepEqual(intent.actors, [
    { id: "A", label: "Alice" },
    { id: "B", label: "B" },
  ]);
  assert.deepEqual(intent.messages, [
    { from: "A", to: "B", text: "Hello", dashed: false },
    { from: "B", to: "A", text: "Hi", dashed: true },
    { from: "A", to: "A", text: "note", dashed: false },
  ]);
});

test("a sequence registers an actor on first mention, like a bare flow node", () => {
  const result = compileVisual("sequenceDiagram\nX->>Y: go");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.intent.kind, "sequence");
  if (result.intent.kind !== "sequence") return;
  assert.deepEqual(result.intent.actors, [
    { id: "X", label: "X" },
    { id: "Y", label: "Y" },
  ]);
});

test("REFUSES a sequence message text carrying markup (the injection boundary)", () => {
  const result = compileVisual("sequenceDiagram\nA->>B: <script>alert(1)</script>");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "UNSAFE_MESSAGE_TEXT");
});

test("REFUSES a sequence control block it cannot draw, never ignoring it", () => {
  const result = compileVisual("sequenceDiagram\nA->>B: hi\nloop every day\nA->>B: again");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "UNSUPPORTED_SEQUENCE");
});

test("REFUSES a malformed sequence message", () => {
  const result = compileVisual("sequenceDiagram\nA B C");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "PARSE_ERROR");
});

test("REFUSES a structured sequence whose endpoints name no actor", () => {
  const result = validateIntent({
    kind: "sequence",
    actors: [{ id: "A", label: "A" }],
    messages: [{ from: "A", to: "ghost", text: "hi" }],
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "BAD_MESSAGE_ENDPOINT");
});

test("REFUSES a wrong kind on an otherwise-valid structure", () => {
  const result = validateIntent({
    kind: "mindmap",
    direction: "TD",
    nodes: [{ id: "A", label: "A", shape: "box" }],
    edges: [],
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "BAD_KIND");
});

test("REFUSES an empty intent", () => {
  const result = validateIntent({ kind: "flow", direction: "TD", nodes: [], edges: [] });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "EMPTY");
});

test("REFUSES a source larger than the bound", () => {
  const result = compileVisual("A --> B\n".repeat(VISUAL_LIMITS.maxSourceChars));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "SOURCE_TOO_LARGE");
});

test("accepts a hand-built structured intent unchanged", () => {
  const intent = {
    kind: "flow" as const,
    direction: "LR" as const,
    nodes: [
      { id: "a", label: "Alpha", shape: "box" as const },
      { id: "b", label: "Beta", shape: "round" as const },
    ],
    edges: [{ from: "a", to: "b", label: "then" }],
    title: "A pipeline",
  };
  const result = validateIntent(intent);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.intent, intent);
});
