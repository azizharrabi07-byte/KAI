// Tests for the KAI Visual Engine's pure half: the layered flow layout and the
// client-side structural guard.
//
//   cd app && node --test tests/visual.test.ts
//
// The renderer (`engine.ts`) needs a DOM and is proven live against the running
// product; what is testable in isolation — and what must not drift from the
// Core contract — is the geometry and the guard. The guard is a real boundary:
// the engine refuses anything that does not satisfy it, so a bug (or a hostile
// payload) on the wire cannot reach the SVG either.

import { test } from "node:test";
import assert from "node:assert/strict";
import { layoutFlow, layoutSequence, estimateWidth, type VisualLayout, type SequenceLayout } from "../src/visual/layout.ts";
import { guardIntent, VISUAL_LIMITS, type VisualIntent, type SequenceIntent } from "../src/visual/types.ts";

function flow(overrides: Partial<VisualIntent> = {}): VisualIntent {
  return {
    kind: "flow",
    direction: "TD",
    nodes: [
      { id: "A", label: "Start", shape: "round" },
      { id: "B", label: "Check the thing", shape: "diamond" },
      { id: "C", label: "Done", shape: "box" },
    ],
    edges: [
      { from: "A", to: "B" },
      { from: "B", to: "C", label: "yes" },
    ],
    ...overrides,
  };
}

function allFinite(layout: VisualLayout): boolean {
  const nums: number[] = [layout.width, layout.height];
  for (const n of layout.nodes) nums.push(n.x, n.y, n.w, n.h, n.rank, n.order);
  for (const e of layout.edges) nums.push(...e.pts, e.labelX, e.labelY);
  return nums.every((n) => Number.isFinite(n));
}

// ── The layout ──────────────────────────────────────────────────────────────

test("layoutFlow places every node and edge with finite geometry", () => {
  const layout = layoutFlow(flow(), estimateWidth);
  assert.equal(layout.nodes.length, 3);
  assert.equal(layout.edges.length, 2);
  assert.ok(layout.width > 0, "a laid-out flow has a positive width");
  assert.ok(layout.height > 0, "a laid-out flow has a positive height");
  assert.ok(allFinite(layout), "no NaN/Infinity may reach the renderer");
});

test("layoutFlow ranks a top-down chain in order and stacks it vertically", () => {
  const layout = layoutFlow(flow(), estimateWidth);
  const [a, b, c] = layout.nodes;
  assert.ok(a && b && c);
  assert.equal(a.rank, 0);
  assert.equal(b.rank, 1);
  assert.equal(c.rank, 2);
  // Top-down: later ranks sit below earlier ones.
  assert.ok(c.y > b.y && b.y > a.y, "TD ranks descend");
});

test("layoutFlow runs left-to-right when the direction is LR", () => {
  const layout = layoutFlow(flow({ direction: "LR" }), estimateWidth);
  const [a, , c] = layout.nodes;
  assert.ok(a && c);
  assert.ok(c.x > a.x, "LR ranks advance to the right");
});

test("layoutFlow is deterministic for the same intent and measure", () => {
  const first = layoutFlow(flow(), estimateWidth);
  const second = layoutFlow(flow(), estimateWidth);
  assert.deepEqual(second, first);
});

test("layoutFlow wraps a long label onto several lines inside the node", () => {
  const layout = layoutFlow(
    flow({
      nodes: [
        { id: "A", label: "a very long label that must wrap across several lines to fit", shape: "box" },
        { id: "B", label: "B", shape: "box" },
      ],
      edges: [{ from: "A", to: "B" }],
    }),
    estimateWidth,
  );
  const a = layout.nodes[0];
  assert.ok(a);
  assert.ok(a.lines.length > 1, "a long label wraps rather than overflowing");
});

// ── The guard (the client-side mirror of Core's validator) ───────────────────

test("guardIntent accepts a well-formed intent and normalises it", () => {
  const guarded = guardIntent(flow());
  assert.equal(guarded.ok, true);
  if (!guarded.ok) return;
  assert.equal(guarded.intent.nodes.length, 3);
  assert.equal(guarded.intent.edges[1]?.label, "yes");
});

test("guardIntent refuses a non-object", () => {
  const g = guardIntent("flowchart TD\nA-->B");
  assert.equal(g.ok, false);
  if (g.ok) return;
  assert.equal(g.code, "NOT_AN_OBJECT");
});

test("guardIntent refuses the wrong kind", () => {
  const g = guardIntent({ ...flow(), kind: "mindmap" });
  assert.equal(g.ok, false);
  if (g.ok) return;
  assert.equal(g.code, "BAD_KIND");
});

test("guardIntent refuses an unknown direction", () => {
  const g = guardIntent({ ...flow(), direction: "sideways" });
  assert.equal(g.ok, false);
  if (g.ok) return;
  assert.equal(g.code, "BAD_DIRECTION");
});

test("guardIntent refuses an empty node list", () => {
  const g = guardIntent({ ...flow(), nodes: [], edges: [] });
  assert.equal(g.ok, false);
  if (g.ok) return;
  assert.equal(g.code, "EMPTY");
});

test("guardIntent refuses a markup-bearing label (the injection boundary)", () => {
  const g = guardIntent(
    flow({
      nodes: [
        { id: "A", label: "<script>alert(1)</script>", shape: "box" },
        { id: "B", label: "B", shape: "box" },
      ],
      edges: [{ from: "A", to: "B" }],
    }),
  );
  assert.equal(g.ok, false);
  if (g.ok) return;
  assert.equal(g.code, "UNSAFE_NODE_LABEL");
});

test("guardIntent refuses a dangling edge endpoint", () => {
  const g = guardIntent(flow({ edges: [{ from: "A", to: "Z" }] }));
  assert.equal(g.ok, false);
  if (g.ok) return;
  assert.equal(g.code, "BAD_EDGE_ENDPOINT");
});

test("guardIntent refuses a self-loop", () => {
  const g = guardIntent(flow({ edges: [{ from: "A", to: "A" }] }));
  assert.equal(g.ok, false);
  if (g.ok) return;
  assert.equal(g.code, "SELF_LOOP");
});

test("guardIntent refuses a duplicate node id", () => {
  const g = guardIntent(
    flow({
      nodes: [
        { id: "A", label: "one", shape: "box" },
        { id: "A", label: "two", shape: "box" },
      ],
      edges: [],
    }),
  );
  assert.equal(g.ok, false);
  if (g.ok) return;
  assert.equal(g.code, "DUPLICATE_NODE");
});

test("guardIntent refuses an oversized node list", () => {
  const nodes = Array.from({ length: VISUAL_LIMITS.maxNodes + 1 }, (_v, i) => ({
    id: `N${i}`,
    label: `node ${i}`,
    shape: "box" as const,
  }));
  const g = guardIntent(flow({ nodes, edges: [] }));
  assert.equal(g.ok, false);
  if (g.ok) return;
  assert.equal(g.code, "TOO_MANY_NODES");
});

// ── The sequence kind (the second designed-output layout) ────────────────────

function sequence(overrides: Partial<SequenceIntent> = {}): SequenceIntent {
  return {
    kind: "sequence",
    actors: [
      { id: "A", label: "Alice" },
      { id: "B", label: "Bob" },
    ],
    messages: [
      { from: "A", to: "B", text: "Hello", dashed: false },
      { from: "B", to: "A", text: "Hi", dashed: true },
    ],
    ...overrides,
  };
}

function seqFinite(layout: SequenceLayout): boolean {
  const nums: number[] = [layout.width, layout.height];
  for (const a of layout.actors) nums.push(a.x, a.y, a.w, a.h, a.cx, a.top, a.bottom);
  for (const m of layout.messages) nums.push(m.y, m.x1, m.x2, m.labelX, m.labelY);
  return nums.every((n) => Number.isFinite(n));
}

test("guardIntent accepts a sequence and normalises a missing dashed to false", () => {
  const g = guardIntent({
    kind: "sequence",
    actors: [{ id: "A", label: "Alice" }],
    messages: [{ from: "A", to: "A", text: "note" }],
  });
  assert.equal(g.ok, true);
  if (!g.ok) return;
  assert.equal(g.intent.kind, "sequence");
  if (g.intent.kind !== "sequence") return;
  assert.equal(g.intent.messages[0]?.dashed, false);
});

test("guardIntent refuses a sequence message to an actor that does not exist", () => {
  const g = guardIntent(sequence({ messages: [{ from: "A", to: "ghost", text: "hi", dashed: false }] }));
  assert.equal(g.ok, false);
  if (g.ok) return;
  assert.equal(g.code, "BAD_MESSAGE_ENDPOINT");
});

test("guardIntent refuses a sequence message with markup (the injection boundary)", () => {
  const g = guardIntent(sequence({ messages: [{ from: "A", to: "B", text: "<b>x</b>", dashed: false }] }));
  assert.equal(g.ok, false);
  if (g.ok) return;
  assert.equal(g.code, "BAD_MESSAGE_TEXT");
});

test("guardIntent refuses a sequence with no actor", () => {
  const g = guardIntent({ kind: "sequence", actors: [], messages: [] });
  assert.equal(g.ok, false);
  if (g.ok) return;
  assert.equal(g.code, "EMPTY");
});

test("layoutSequence places finite geometry with actors in columns and messages ordered", () => {
  const layout = layoutSequence(sequence(), estimateWidth);
  assert.equal(layout.actors.length, 2);
  assert.equal(layout.messages.length, 2);
  assert.ok(layout.width > 0 && layout.height > 0);
  assert.ok(seqFinite(layout), "no NaN/Infinity may reach the renderer");
  const [a, b] = layout.actors;
  assert.ok(a && b);
  assert.ok(b.cx > a.cx, "actors advance left to right");
  const [m0, m1] = layout.messages;
  assert.ok(m0 && m1);
  assert.ok(m1.y > m0.y, "messages are ordered top to bottom");
});

test("layoutSequence is deterministic and loops a self message to the right", () => {
  const first = layoutSequence(sequence({ messages: [{ from: "A", to: "A", text: "retry", dashed: false }] }), estimateWidth);
  const second = layoutSequence(sequence({ messages: [{ from: "A", to: "A", text: "retry", dashed: false }] }), estimateWidth);
  assert.deepEqual(second, first);
  const self = first.messages[0];
  assert.ok(self);
  assert.equal(self.self, true);
  assert.ok(self.x2 > self.x1, "a self message loops to the right of its lifeline");
});
