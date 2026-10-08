// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * KAI Visual Engine — the structured visual intent contract, its parser and its
 * validator. THIS FILE IS THE AUTHORITY. It is the seam through which a model's
 * raw text becomes a typed, bounded structure that a renderer may draw.
 *
 * The shape is deliberately the one the OpenGhost audit named (see
 * `docs/OPEN_GHOST_AUDIT.md` §13):
 *
 *     raw dialect text -> parse -> structured intent -> VALIDATE -> renderer
 *
 * and NOT the one the licence forbids:
 *
 *     model text -> DOM / SVG / machine   (never; the model describes WHAT)
 *
 * The mechanism (a Mermaid-like flow dialect parsed into a rank-layered graph)
 * is adapted from OpenGhost's MIT-covered `diagram.js`; the CODE, the types, the
 * limits and the renderer that consumes this contract are KAI's own. No OpenGhost
 * source, no OpenGhost visual identity, and no OpenGhost stylesheet is imported —
 * see `NOTICE.md`.
 *
 * Two rules this module exists to enforce:
 *   - A malformed or adversarial intent is REJECTED with a reason that names the
 *     offending field. It is never silently repaired into something drawable,
 *     because a repaired structure is a structure nobody validated.
 *   - The structure is BOUNDED. Node/edge/label counts and lengths are capped, so
 *     a hostile input cannot turn a drawing into a denial-of-service.
 */

// ── The contract ────────────────────────────────────────────────────────────

/** How the ranks run. `TD` = top→down, `LR` = left→right. */
export type VisualDirection = "TD" | "LR";

/** The three node silhouettes the flow dialect can express. */
export type VisualNodeShape = "box" | "round" | "diamond";

export interface VisualNode {
  id: string;
  label: string;
  shape: VisualNodeShape;
}

export interface VisualEdge {
  from: string;
  to: string;
  label?: string;
}

export interface FlowIntent {
  kind: "flow";
  direction: VisualDirection;
  nodes: VisualNode[];
  edges: VisualEdge[];
  title?: string;
}

/** One participant on a sequence diagram's lifeline. */
export interface SequenceActor {
  id: string;
  label: string;
}

/** One ordered message between two participants. */
export interface SequenceMessage {
  from: string;
  to: string;
  text: string;
  /** A `-->>` / `-->` reply is drawn dashed; a `->>` / `->` call is solid. */
  dashed: boolean;
}

/** A validated, renderable sequence-diagram intent. */
export interface SequenceIntent {
  kind: "sequence";
  actors: SequenceActor[];
  messages: SequenceMessage[];
  title?: string;
}

/**
 * A validated, renderable visual intent. Nothing else may reach the engine.
 *
 * The union is closed on purpose: adding a kind is a deliberate act in this
 * file, and both the Core validator and the renderer's own mirror guard must
 * learn the new kind before it can draw.
 */
export type VisualIntent = FlowIntent | SequenceIntent;

/** Every kind this build can validate and draw. */
export const VISUAL_KINDS = ["flow", "sequence"] as const;

/** Hard bounds. A structure that exceeds any of these is refused, not truncated. */
export const VISUAL_LIMITS = {
  /** Raw dialect source, before parsing. */
  maxSourceChars: 20_000,
  maxNodes: 64,
  maxEdges: 128,
  maxActors: 24,
  maxMessages: 128,
  maxIdChars: 40,
  maxLabelChars: 80,
} as const;

/** Node ids are conservative on purpose: no punctuation an injector can use. */
const ID_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * Labels may not carry markup delimiters or control characters. A label is text
 * the engine will draw as a string — never HTML — and this makes that explicit
 * at the boundary rather than trusting the renderer to escape it.
 */
const BAD_LABEL_RE = /[<>{}\\]|[\u0000-\u001f\u007f]/;

// ── Result types ────────────────────────────────────────────────────────────

export type VisualCompileResult =
  | { ok: true; intent: VisualIntent }
  | { ok: false; code: string; reason: string };

function refuse(code: string, reason: string): VisualCompileResult {
  return { ok: false, code, reason };
}

// ── The dialect parser ──────────────────────────────────────────────────────

interface DraftNode {
  id: string;
  /** First label supplied anywhere in the source, or null if never supplied. */
  label: string | null;
  shape: VisualNodeShape | null;
}

interface DraftEdge {
  from: string;
  to: string;
  label: string | null;
}

interface Draft {
  direction: VisualDirection;
  nodes: Map<string, DraftNode>;
  order: string[];
  edges: DraftEdge[];
}

/** One node reference: `ID` optionally followed by `[..]`, `{..}` or `(..)`. */
function readNodeRef(s: string, p: number): { node: DraftNode; next: number } | null {
  if (p >= s.length) return null;
  const first = s[p];
  if (first === undefined || !/[A-Za-z]/.test(first)) return null;
  let j = p + 1;
  while (j < s.length) {
    const c = s[j];
    if (c === undefined || !/[A-Za-z0-9_-]/.test(c)) break;
    j += 1;
  }
  const id = s.slice(p, j);
  if (id.length > VISUAL_LIMITS.maxIdChars) return null;

  let label: string | null = null;
  let shape: VisualNodeShape | null = null;
  const ch = s[j];
  if (ch === "[") {
    const close = s.indexOf("]", j + 1);
    if (close < 0) return null;
    label = s.slice(j + 1, close);
    shape = "box";
    j = close + 1;
  } else if (ch === "{") {
    const close = s.indexOf("}", j + 1);
    if (close < 0) return null;
    label = s.slice(j + 1, close);
    shape = "diamond";
    j = close + 1;
  } else if (ch === "(") {
    const close = s.indexOf(")", j + 1);
    if (close < 0) return null;
    let inner = s.slice(j + 1, close);
    // Mermaid's stadium form `([text])` wraps the label in brackets.
    if (inner.startsWith("[") && inner.endsWith("]")) inner = inner.slice(1, -1);
    label = inner;
    shape = "round";
    j = close + 1;
  }
  return { node: { id, label, shape }, next: j };
}

const EDGE_OPS: readonly string[] = ["-.->", "==>", "-->", "---"];

/** One edge operator, with its optional `|label|`. */
function readEdge(s: string, p: number): { label: string | null; next: number } | null {
  let i = p;
  while (i < s.length && /\s/.test(s[i] ?? "")) i += 1;
  let op: string | null = null;
  for (const candidate of EDGE_OPS) {
    if (s.startsWith(candidate, i)) {
      op = candidate;
      i += candidate.length;
      break;
    }
  }
  if (op === null) return null;
  while (i < s.length && /\s/.test(s[i] ?? "")) i += 1;
  let label: string | null = null;
  if (s[i] === "|") {
    const close = s.indexOf("|", i + 1);
    if (close < 0) return null;
    label = s.slice(i + 1, close);
    i = close + 1;
  }
  while (i < s.length && /\s/.test(s[i] ?? "")) i += 1;
  return { label, next: i };
}

function register(draft: Draft, node: DraftNode): void {
  const existing = draft.nodes.get(node.id);
  if (existing === undefined) {
    draft.nodes.set(node.id, node);
    draft.order.push(node.id);
    return;
  }
  // A later reference may name a node the first reference left bare.
  if (existing.label === null && node.label !== null) {
    existing.label = node.label;
    existing.shape = node.shape;
  }
}

/** Parses one statement; returns an error reason, or null on success. */
function parseStatement(line: string, draft: Draft): string | null {
  const head = readNodeRef(line, 0);
  if (head === null) {
    return `could not parse a node at the start of "${line.slice(0, 48)}"`;
  }
  register(draft, head.node);
  let cursor = head.next;
  let from = head.node.id;

  for (;;) {
    while (cursor < line.length && /\s/.test(line[cursor] ?? "")) cursor += 1;
    if (cursor >= line.length) return null;
    const edge = readEdge(line, cursor);
    if (edge === null) {
      return `could not parse an edge operator after "${from}" in "${line.slice(0, 48)}"`;
    }
    const target = readNodeRef(line, edge.next);
    if (target === null) {
      return `an edge from "${from}" has no valid target node`;
    }
    register(draft, target.node);
    draft.edges.push({ from, to: target.node.id, label: edge.label });
    if (draft.edges.length > VISUAL_LIMITS.maxEdges) {
      return `a flow may hold at most ${VISUAL_LIMITS.maxEdges} edges`;
    }
    from = target.node.id;
    cursor = target.next;
  }
}

const HEADER_RE = /^(flowchart|graph)\s+(TD|TB|LR|RL|BT)\s*$/i;

function directionOf(raw: string): VisualDirection {
  const upper = raw.toUpperCase();
  return upper === "LR" || upper === "RL" ? "LR" : "TD";
}

// ── The sequence dialect parser ─────────────────────────────────────────────

/** `sequenceDiagram` opens a sequence. Kept narrow, like the flow header. */
const SEQ_HEADER_RE = /^sequenceDiagram\s*$/i;

/**
 * A sequence identifier. Unlike a flow id it may not *end* in `-`, because an
 * arrow starts with `-`: without this, `B-->>A` would read the sender as `B-`.
 * Internal hyphens (`shopping-cart`) are still allowed.
 */
const SEQ_ID = "[A-Za-z][A-Za-z0-9_]*(?:-[A-Za-z0-9_]+)*";

/** `participant B` / `participant B as Bob` / `actor B as Bob`. */
const SEQ_PARTICIPANT_RE = new RegExp(`^(participant|actor)\\s+(${SEQ_ID})\\s*(?:\\bas\\s+(.*))?$`, "i");

/**
 * One message. The operators are ordered longest-first so `-->>` is not read as
 * `-->` followed by a stray `>`. A trailing `: text` is required — a message
 * with nothing to say is refused rather than drawn as a nameless arrow.
 */
const SEQ_MESSAGE_RE = new RegExp(`^(${SEQ_ID})\\s*(-->>|->>|-->|->)\\s*(${SEQ_ID})\\s*:\\s*(.+)$`);

interface SeqDraft {
  actors: Map<string, SequenceActor>;
  order: string[];
  messages: SequenceMessage[];
}

/** Registers an actor on first mention; a later mention may name it. */
function registerActor(draft: SeqDraft, id: string, label: string | null): void {
  const existing = draft.actors.get(id);
  if (existing === undefined) {
    draft.actors.set(id, { id, label: label ?? id });
    draft.order.push(id);
    return;
  }
  if (existing.label === id && label !== null && label !== id) existing.label = label;
}

/**
 * Compiles the `sequenceDiagram` dialect into a validated {@link SequenceIntent}:
 *
 *     sequenceDiagram
 *     participant A as Alice
 *     participant B as Bob
 *     A->>B: Hello
 *     B-->>A: Hi
 *
 * Statements: `participant`/`actor` declarations and `A->>B: text` messages
 * (`->>`/`->` solid, `-->>`/`-->` dashed). `%%` starts a comment. An actor used
 * without a declaration is registered on first mention, exactly as a bare flow
 * node is. Anything else is refused, never ignored.
 */
function compileSequence(source: string): VisualCompileResult {
  const draft: SeqDraft = { actors: new Map(), order: [], messages: [] };
  const lines = source.split(/\r?\n/);
  let headerSeen = false;

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? "";
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line.startsWith("%%")) continue;

    if (!headerSeen && SEQ_HEADER_RE.test(line)) {
      headerSeen = true;
      continue;
    }
    // Another `XDiagram` line inside a sequence is not a silent no-op.
    if (/^[A-Za-z]+Diagram\b/.test(line)) {
      return refuse("UNSUPPORTED_KIND", `line ${i + 1}: a sequence diagram cannot contain "${line.slice(0, 32)}"`);
    }
    // Control blocks this build does not draw are refused, not swallowed.
    if (/^(loop|alt|else|opt|par|and|rect|note|activate|deactivate|autonumber|title)\b/i.test(line)) {
      return refuse("UNSUPPORTED_SEQUENCE", `line ${i + 1}: this sequence engine draws declarations and messages; got "${line.slice(0, 32)}"`);
    }

    const participant = SEQ_PARTICIPANT_RE.exec(line);
    if (participant !== null) {
      const id = participant[2] ?? "";
      const label = (participant[3] ?? "").trim();
      registerActor(draft, id, label.length > 0 ? label : null);
      if (draft.order.length > VISUAL_LIMITS.maxActors) {
        return refuse("TOO_MANY_ACTORS", `a sequence may hold at most ${VISUAL_LIMITS.maxActors} participants`);
      }
      continue;
    }

    const message = SEQ_MESSAGE_RE.exec(line);
    if (message !== null) {
      const from = message[1] ?? "";
      const op = message[2] ?? "";
      const to = message[3] ?? "";
      const text = (message[4] ?? "").trim();
      registerActor(draft, from, null);
      registerActor(draft, to, null);
      if (draft.order.length > VISUAL_LIMITS.maxActors) {
        return refuse("TOO_MANY_ACTORS", `a sequence may hold at most ${VISUAL_LIMITS.maxActors} participants`);
      }
      draft.messages.push({ from, to, text, dashed: op.startsWith("--") });
      if (draft.messages.length > VISUAL_LIMITS.maxMessages) {
        return refuse("TOO_MANY_MESSAGES", `a sequence may hold at most ${VISUAL_LIMITS.maxMessages} messages`);
      }
      continue;
    }

    return refuse("PARSE_ERROR", `line ${i + 1}: could not parse a participant or a message from "${line.slice(0, 48)}"`);
  }

  if (draft.order.length === 0) {
    return refuse("EMPTY", "a sequence diagram must declare or mention at least one participant");
  }

  const intent: SequenceIntent = {
    kind: "sequence",
    actors: draft.order.map((id) => draft.actors.get(id) as SequenceActor),
    messages: draft.messages,
  };
  return validateIntent(intent);
}

/**
 * Turns raw dialect text into a validated {@link VisualIntent}.
 *
 * The dialect is a deliberately small, safe subset of the one `diagram.js` reads:
 *
 *     flowchart TD
 *     A[Start] --> B{Check}
 *     B -->|yes| C([Done])
 *     B -->|no| A
 *
 * Header (optional): `flowchart TD` / `graph LR` (TB→TD, RL/BT are accepted and
 * folded). Nodes: `ID`, `ID[label]`, `ID{label}`, `ID(label)`. Edges: `-->`,
 * `-.->`, `==>`, `---`, each optionally labelled `|label|`. `%%` starts a comment.
 *
 * A source opening with `sequenceDiagram` is parsed as a sequence instead (see
 * {@link compileSequence}); every other unsupported dialect is refused.
 */
export function compileVisual(source: string): VisualCompileResult {
  if (typeof source !== "string") {
    return refuse("INVALID_SOURCE", "source must be a string");
  }
  if (source.length > VISUAL_LIMITS.maxSourceChars) {
    return refuse(
      "SOURCE_TOO_LARGE",
      `source must be at most ${VISUAL_LIMITS.maxSourceChars} characters; got ${source.length}`,
    );
  }

  // The FIRST meaningful line selects the dialect. A sequence is parsed by its
  // own parser; everything else falls through to the flow parser, which refuses
  // an unsupported dialect rather than ignoring it.
  const firstLine = source
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("%%"));
  if (firstLine !== undefined && SEQ_HEADER_RE.test(firstLine)) {
    return compileSequence(source);
  }

  const draft: Draft = { direction: "TD", nodes: new Map(), order: [], edges: [] };
  const lines = source.split(/\r?\n/);
  let headerSeen = false;

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? "";
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line.startsWith("%%")) continue;

    if (!headerSeen && HEADER_RE.test(line)) {
      const m = HEADER_RE.exec(line);
      draft.direction = directionOf(m?.[2] ?? "TD");
      headerSeen = true;
      continue;
    }
    // An unknown leading keyword (e.g. `sequenceDiagram`) is a refusal, not a
    // silently-ignored line: the caller asked for a flow and did not get one.
    if (/^[A-Za-z]+Diagram\b/.test(line) || /^(pie|xychart-beta|gantt|mindmap|classDiagram|erDiagram)\b/.test(line)) {
      return refuse("UNSUPPORTED_KIND", `line ${i + 1}: this visual engine renders "flow"; got "${line.slice(0, 32)}"`);
    }

    const error = parseStatement(line, draft);
    if (error !== null) return refuse("PARSE_ERROR", `line ${i + 1}: ${error}`);
  }

  const intent: FlowIntent = {
    kind: "flow",
    direction: draft.direction,
    nodes: [],
    edges: [],
  };

  for (const id of draft.order) {
    const node = draft.nodes.get(id);
    if (node === undefined) continue;
    intent.nodes.push({
      id: node.id,
      label: node.label ?? node.id,
      shape: node.shape ?? "box",
    });
  }
  for (const edge of draft.edges) {
    const built: VisualEdge = { from: edge.from, to: edge.to };
    if (edge.label !== null) built.label = edge.label;
    intent.edges.push(built);
  }

  return validateIntent(intent);
}

// ── The validator (the security boundary) ───────────────────────────────────

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Validates a `sequence` intent: its participants and its ordered messages.
 * Same discipline as the flow validator — every field checked, first failure
 * named, nothing repaired.
 */
function validateSequenceIntent(obj: Record<string, unknown>): VisualCompileResult {
  if (!Array.isArray(obj.actors)) {
    return refuse("BAD_ACTORS", '"actors" must be an array');
  }
  if (obj.actors.length === 0) {
    return refuse("EMPTY", "a sequence diagram must hold at least one actor");
  }
  if (obj.actors.length > VISUAL_LIMITS.maxActors) {
    return refuse("TOO_MANY_ACTORS", `a sequence may hold at most ${VISUAL_LIMITS.maxActors} actors; got ${obj.actors.length}`);
  }

  const actors: SequenceActor[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < obj.actors.length; i += 1) {
    const actor = asObject(obj.actors[i]);
    if (actor === null) return refuse("BAD_ACTOR", `"actors[${i}]" must be an object`);
    const id = actor.id;
    if (typeof id !== "string" || !ID_RE.test(id) || id.length > VISUAL_LIMITS.maxIdChars) {
      return refuse("BAD_ACTOR_ID", `"actors[${i}].id" must be a conservative identifier; got ${JSON.stringify(id)}`);
    }
    if (seen.has(id)) return refuse("DUPLICATE_ACTOR", `actor id "${id}" is declared more than once`);
    seen.add(id);
    const label = actor.label;
    if (typeof label !== "string" || label.length === 0 || label.length > VISUAL_LIMITS.maxLabelChars) {
      return refuse("BAD_ACTOR_LABEL", `"actors[${i}].label" must be 1..${VISUAL_LIMITS.maxLabelChars} characters`);
    }
    if (BAD_LABEL_RE.test(label)) {
      return refuse("UNSAFE_ACTOR_LABEL", `"actors[${i}].label" must not contain markup or control characters`);
    }
    actors.push({ id, label });
  }

  if (!Array.isArray(obj.messages)) {
    return refuse("BAD_MESSAGES", '"messages" must be an array');
  }
  if (obj.messages.length > VISUAL_LIMITS.maxMessages) {
    return refuse("TOO_MANY_MESSAGES", `a sequence may hold at most ${VISUAL_LIMITS.maxMessages} messages; got ${obj.messages.length}`);
  }
  const messages: SequenceMessage[] = [];
  for (let i = 0; i < obj.messages.length; i += 1) {
    const message = asObject(obj.messages[i]);
    if (message === null) return refuse("BAD_MESSAGE", `"messages[${i}]" must be an object`);
    const from = message.from;
    const to = message.to;
    if (typeof from !== "string" || !seen.has(from)) {
      return refuse("BAD_MESSAGE_ENDPOINT", `"messages[${i}].from" must name an existing actor; got ${JSON.stringify(from)}`);
    }
    if (typeof to !== "string" || !seen.has(to)) {
      return refuse("BAD_MESSAGE_ENDPOINT", `"messages[${i}].to" must name an existing actor; got ${JSON.stringify(to)}`);
    }
    const text = message.text;
    if (typeof text !== "string" || text.length === 0 || text.length > VISUAL_LIMITS.maxLabelChars) {
      return refuse("BAD_MESSAGE_TEXT", `"messages[${i}].text" must be 1..${VISUAL_LIMITS.maxLabelChars} characters`);
    }
    if (BAD_LABEL_RE.test(text)) {
      return refuse("UNSAFE_MESSAGE_TEXT", `"messages[${i}].text" must not contain markup or control characters`);
    }
    if (message.dashed !== undefined && typeof message.dashed !== "boolean") {
      return refuse("BAD_MESSAGE_STYLE", `"messages[${i}].dashed" must be a boolean when present`);
    }
    messages.push({ from, to, text, dashed: message.dashed === true });
  }

  const intent: SequenceIntent = { kind: "sequence", actors, messages };
  if (obj.title !== undefined) {
    const title = obj.title;
    if (typeof title !== "string" || title.length === 0 || title.length > VISUAL_LIMITS.maxLabelChars) {
      return refuse("BAD_TITLE", `"title" must be 1..${VISUAL_LIMITS.maxLabelChars} characters`);
    }
    if (BAD_LABEL_RE.test(title)) {
      return refuse("UNSAFE_TITLE", '"title" must not contain markup or control characters');
    }
    intent.title = title;
  }
  return { ok: true, intent };
}

/**
 * Validates an already-structured intent. Used by `POST /visual/validate` and,
 * defensively, by the renderer's own client-side mirror. The `kind` selects the
 * validator; every field is checked for type, bound and safety; the FIRST
 * failure is returned with the field named. An unknown kind is refused.
 */
export function validateIntent(raw: unknown): VisualCompileResult {
  const obj = asObject(raw);
  if (obj === null) {
    return refuse("NOT_AN_OBJECT", "a visual intent must be a JSON object");
  }
  if (obj.kind === "sequence") return validateSequenceIntent(obj);
  if (obj.kind === "flow") return validateFlowIntent(obj);
  return refuse("BAD_KIND", `"kind" must be one of ${VISUAL_KINDS.join(", ")}; got ${JSON.stringify(obj.kind)}`);
}

/** Validates a `flow` intent (the original kind). */
function validateFlowIntent(obj: Record<string, unknown>): VisualCompileResult {
  if (obj.direction !== "TD" && obj.direction !== "LR") {
    return refuse("BAD_DIRECTION", `"direction" must be "TD" or "LR"; got ${JSON.stringify(obj.direction)}`);
  }
  if (!Array.isArray(obj.nodes)) {
    return refuse("BAD_NODES", '"nodes" must be an array');
  }
  if (obj.nodes.length === 0) {
    return refuse("EMPTY", "a visual intent must hold at least one node");
  }
  if (obj.nodes.length > VISUAL_LIMITS.maxNodes) {
    return refuse("TOO_MANY_NODES", `a flow may hold at most ${VISUAL_LIMITS.maxNodes} nodes; got ${obj.nodes.length}`);
  }

  const nodes: VisualNode[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < obj.nodes.length; i += 1) {
    const node = asObject(obj.nodes[i]);
    if (node === null) return refuse("BAD_NODE", `"nodes[${i}]" must be an object`);
    const id = node.id;
    if (typeof id !== "string" || !ID_RE.test(id)) {
      return refuse("BAD_NODE_ID", `"nodes[${i}].id" must match [A-Za-z][A-Za-z0-9_-]*; got ${JSON.stringify(id)}`);
    }
    if (id.length > VISUAL_LIMITS.maxIdChars) {
      return refuse("BAD_NODE_ID", `"nodes[${i}].id" must be at most ${VISUAL_LIMITS.maxIdChars} characters`);
    }
    if (seen.has(id)) {
      return refuse("DUPLICATE_NODE", `node id "${id}" is declared more than once`);
    }
    seen.add(id);

    const label = node.label;
    if (typeof label !== "string") {
      return refuse("BAD_NODE_LABEL", `"nodes[${i}].label" must be a string`);
    }
    if (label.length === 0 || label.length > VISUAL_LIMITS.maxLabelChars) {
      return refuse("BAD_NODE_LABEL", `"nodes[${i}].label" must be 1..${VISUAL_LIMITS.maxLabelChars} characters`);
    }
    if (BAD_LABEL_RE.test(label)) {
      return refuse(
        "UNSAFE_NODE_LABEL",
        `"nodes[${i}].label" must not contain markup or control characters; got ${JSON.stringify(label)}`,
      );
    }

    let shape: VisualNodeShape = "box";
    if (node.shape !== undefined) {
      if (node.shape !== "box" && node.shape !== "round" && node.shape !== "diamond") {
        return refuse("BAD_NODE_SHAPE", `"nodes[${i}].shape" must be "box", "round" or "diamond"; got ${JSON.stringify(node.shape)}`);
      }
      shape = node.shape;
    }
    nodes.push({ id, label, shape });
  }

  if (!Array.isArray(obj.edges)) {
    return refuse("BAD_EDGES", '"edges" must be an array');
  }
  if (obj.edges.length > VISUAL_LIMITS.maxEdges) {
    return refuse("TOO_MANY_EDGES", `a flow may hold at most ${VISUAL_LIMITS.maxEdges} edges; got ${obj.edges.length}`);
  }
  const edges: VisualEdge[] = [];
  for (let i = 0; i < obj.edges.length; i += 1) {
    const edge = asObject(obj.edges[i]);
    if (edge === null) return refuse("BAD_EDGE", `"edges[${i}]" must be an object`);
    const from = edge.from;
    const to = edge.to;
    if (typeof from !== "string" || !seen.has(from)) {
      return refuse("BAD_EDGE_ENDPOINT", `"edges[${i}].from" must name an existing node; got ${JSON.stringify(from)}`);
    }
    if (typeof to !== "string" || !seen.has(to)) {
      return refuse("BAD_EDGE_ENDPOINT", `"edges[${i}].to" must name an existing node; got ${JSON.stringify(to)}`);
    }
    if (from === to) {
      return refuse("SELF_LOOP", `"edges[${i}]" is a self-loop on "${from}", which this engine does not draw`);
    }
    const built: VisualEdge = { from, to };
    if (edge.label !== undefined) {
      const label = edge.label;
      if (typeof label !== "string" || label.length === 0 || label.length > VISUAL_LIMITS.maxLabelChars) {
        return refuse("BAD_EDGE_LABEL", `"edges[${i}].label" must be 1..${VISUAL_LIMITS.maxLabelChars} characters`);
      }
      if (BAD_LABEL_RE.test(label)) {
        return refuse("UNSAFE_EDGE_LABEL", `"edges[${i}].label" must not contain markup or control characters`);
      }
      built.label = label;
    }
    edges.push(built);
  }

  const intent: VisualIntent = {
    kind: "flow",
    direction: obj.direction,
    nodes,
    edges,
  };
  if (obj.title !== undefined) {
    const title = obj.title;
    if (typeof title !== "string" || title.length === 0 || title.length > VISUAL_LIMITS.maxLabelChars) {
      return refuse("BAD_TITLE", `"title" must be 1..${VISUAL_LIMITS.maxLabelChars} characters`);
    }
    if (BAD_LABEL_RE.test(title)) {
      return refuse("UNSAFE_TITLE", '"title" must not contain markup or control characters');
    }
    intent.title = title;
  }
  return { ok: true, intent };
}
