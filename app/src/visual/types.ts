// KAI Visual Engine — the shared vocabulary.
//
// This file mirrors the Core-owned contract in `core/src/visual/spec.ts` and adds
// a CLIENT-SIDE structural guard. It is deliberately a second, independent check:
// the Core is the authority that emits a validated intent, and the engine refuses
// to draw anything that does not itself satisfy the contract — so a bug (or a
// hostile payload) on the wire cannot reach the renderer unvalidated either.
//
// The mechanism this module's siblings implement is adapted from OpenGhost's
// MIT-covered `diagram.js` (see NOTICE.md). The contract, the names, the limits
// and the styling are KAI's own; no OpenGhost source or visual identity is used.

export type VisualDirection = "TD" | "LR";
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

export interface VisualIntent {
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

export interface SequenceIntent {
  kind: "sequence";
  actors: SequenceActor[];
  messages: SequenceMessage[];
  title?: string;
}

/** Any validated, renderable intent. The mirror of Core's union. */
export type AnyVisualIntent = VisualIntent | SequenceIntent;

/** Same bounds as the Core contract; a drift here would be a bug. */
export const VISUAL_LIMITS = {
  maxNodes: 64,
  maxEdges: 128,
  maxActors: 24,
  maxMessages: 128,
  maxIdChars: 40,
  maxLabelChars: 80,
} as const;

/** Every kind the mirror guard and the renderer understand. */
export const VISUAL_KINDS = ["flow", "sequence"] as const;

const ID_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
const BAD_LABEL_RE = /[<>{}\\]|[\u0000-\u001f\u007f]/;

export type VisualGuard =
  | { ok: true; intent: AnyVisualIntent }
  | { ok: false; code: string; reason: string };

function refuse(code: string, reason: string): VisualGuard {
  return { ok: false, code, reason };
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The client-side mirror of the Core validator. It accepts exactly the shape the
 * Core emits and refuses everything else, naming the first offending field.
 */
export function guardIntent(raw: unknown): VisualGuard {
  const obj = asObject(raw);
  if (obj === null) return refuse("NOT_AN_OBJECT", "a visual intent must be a JSON object");
  if (obj.kind === "sequence") return guardSequenceIntent(obj);
  if (obj.kind === "flow") return guardFlowIntent(obj);
  return refuse("BAD_KIND", `"kind" must be one of ${VISUAL_KINDS.join(", ")}; got ${JSON.stringify(obj.kind)}`);
}

/** The mirror guard for a `sequence` intent. */
function guardSequenceIntent(obj: Record<string, unknown>): VisualGuard {
  if (!Array.isArray(obj.actors)) return refuse("BAD_ACTORS", '"actors" must be an array');
  if (obj.actors.length === 0) return refuse("EMPTY", "a sequence diagram must hold at least one actor");
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
    if (typeof label !== "string" || label.length === 0 || label.length > VISUAL_LIMITS.maxLabelChars || BAD_LABEL_RE.test(label)) {
      return refuse("BAD_ACTOR_LABEL", `"actors[${i}].label" must be a safe 1..${VISUAL_LIMITS.maxLabelChars}-char string`);
    }
    actors.push({ id, label });
  }
  if (!Array.isArray(obj.messages)) return refuse("BAD_MESSAGES", '"messages" must be an array');
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
      return refuse("BAD_MESSAGE_ENDPOINT", `"messages[${i}].from" must name an existing actor`);
    }
    if (typeof to !== "string" || !seen.has(to)) {
      return refuse("BAD_MESSAGE_ENDPOINT", `"messages[${i}].to" must name an existing actor`);
    }
    const text = message.text;
    if (typeof text !== "string" || text.length === 0 || text.length > VISUAL_LIMITS.maxLabelChars || BAD_LABEL_RE.test(text)) {
      return refuse("BAD_MESSAGE_TEXT", `"messages[${i}].text" must be a safe 1..${VISUAL_LIMITS.maxLabelChars}-char string`);
    }
    if (message.dashed !== undefined && typeof message.dashed !== "boolean") {
      return refuse("BAD_MESSAGE_STYLE", `"messages[${i}].dashed" must be a boolean when present`);
    }
    messages.push({ from, to, text, dashed: message.dashed === true });
  }
  const intent: SequenceIntent = { kind: "sequence", actors, messages };
  if (obj.title !== undefined) {
    const title = obj.title;
    if (typeof title !== "string" || title.length === 0 || title.length > VISUAL_LIMITS.maxLabelChars || BAD_LABEL_RE.test(title)) {
      return refuse("BAD_TITLE", '"title" must be a safe 1..80-character string');
    }
    intent.title = title;
  }
  return { ok: true, intent };
}

/** The mirror guard for a `flow` intent. */
function guardFlowIntent(obj: Record<string, unknown>): VisualGuard {
  if (obj.direction !== "TD" && obj.direction !== "LR") {
    return refuse("BAD_DIRECTION", `"direction" must be "TD" or "LR"; got ${JSON.stringify(obj.direction)}`);
  }
  if (!Array.isArray(obj.nodes)) return refuse("BAD_NODES", '"nodes" must be an array');
  if (obj.nodes.length === 0) return refuse("EMPTY", "a visual intent must hold at least one node");
  if (obj.nodes.length > VISUAL_LIMITS.maxNodes) {
    return refuse("TOO_MANY_NODES", `a flow may hold at most ${VISUAL_LIMITS.maxNodes} nodes; got ${obj.nodes.length}`);
  }

  const nodes: VisualNode[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < obj.nodes.length; i += 1) {
    const node = asObject(obj.nodes[i]);
    if (node === null) return refuse("BAD_NODE", `"nodes[${i}]" must be an object`);
    const id = node.id;
    if (typeof id !== "string" || !ID_RE.test(id) || id.length > VISUAL_LIMITS.maxIdChars) {
      return refuse("BAD_NODE_ID", `"nodes[${i}].id" must be a conservative identifier; got ${JSON.stringify(id)}`);
    }
    if (seen.has(id)) return refuse("DUPLICATE_NODE", `node id "${id}" is declared more than once`);
    seen.add(id);
    const label = node.label;
    if (typeof label !== "string" || label.length === 0 || label.length > VISUAL_LIMITS.maxLabelChars) {
      return refuse("BAD_NODE_LABEL", `"nodes[${i}].label" must be 1..${VISUAL_LIMITS.maxLabelChars} characters`);
    }
    if (BAD_LABEL_RE.test(label)) {
      return refuse("UNSAFE_NODE_LABEL", `"nodes[${i}].label" must not contain markup or control characters`);
    }
    let shape: VisualNodeShape = "box";
    if (node.shape !== undefined) {
      if (node.shape !== "box" && node.shape !== "round" && node.shape !== "diamond") {
        return refuse("BAD_NODE_SHAPE", `"nodes[${i}].shape" must be "box", "round" or "diamond"`);
      }
      shape = node.shape;
    }
    nodes.push({ id, label, shape });
  }

  if (!Array.isArray(obj.edges)) return refuse("BAD_EDGES", '"edges" must be an array');
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
      return refuse("BAD_EDGE_ENDPOINT", `"edges[${i}].from" must name an existing node`);
    }
    if (typeof to !== "string" || !seen.has(to)) {
      return refuse("BAD_EDGE_ENDPOINT", `"edges[${i}].to" must name an existing node`);
    }
    if (from === to) return refuse("SELF_LOOP", `"edges[${i}]" is a self-loop on "${from}"`);
    const built: VisualEdge = { from, to };
    if (edge.label !== undefined) {
      const label = edge.label;
      if (typeof label !== "string" || label.length === 0 || label.length > VISUAL_LIMITS.maxLabelChars || BAD_LABEL_RE.test(label)) {
        return refuse("BAD_EDGE_LABEL", `"edges[${i}].label" must be a safe 1..${VISUAL_LIMITS.maxLabelChars}-char string`);
      }
      built.label = label;
    }
    edges.push(built);
  }

  const intent: VisualIntent = { kind: "flow", direction: obj.direction, nodes, edges };
  if (obj.title !== undefined) {
    const title = obj.title;
    if (typeof title !== "string" || title.length === 0 || title.length > VISUAL_LIMITS.maxLabelChars || BAD_LABEL_RE.test(title)) {
      return refuse("BAD_TITLE", '"title" must be a safe 1..80-character string');
    }
    intent.title = title;
  }
  return { ok: true, intent };
}
