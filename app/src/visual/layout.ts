// KAI Visual Engine — the layered flow layout (the adapted mechanism).
//
// Adapted from the layout engine in OpenGhost's MIT-covered `diagram.js`
// (rank assignment with back-edge detection, dummy vertices for long edges,
// barycenter crossing minimisation, and isotonic-regression cross placement).
// It is reimplemented here as KAI's own TypeScript, as pure functions over the
// validated intent — no DOM, no globals — so it is directly testable.
//
// See NOTICE.md for the attribution. The naming, constants and output shape are
// KAI's; the technique is what was learned from the source.

import type { VisualIntent, VisualNodeShape, SequenceIntent } from "./types";

// ── Geometry constants (KAI's own values) ────────────────────────────────────

const NODE = { padX: 14, padY: 9, maxWidth: 180, minWidth: 52, radius: 8 };
const TEXT = { size: 12.5, line: 17, weight: 500 };
const GAP = { rank: 48, node: 24, pad: 18 };
const SWEEPS = 8;

export interface LaidOutNode {
  id: string;
  label: string;
  shape: VisualNodeShape;
  /** Centre, in scene coordinates. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** The label, already wrapped to the node's width. */
  lines: string[];
  rank: number;
  order: number;
}

export interface LaidOutEdge {
  from: string;
  to: string;
  label?: string;
  /** Flat cubic path points: [x0,y0, c1x,c1y, c2x,c2y, x1,y1, …]. */
  pts: number[];
  /** Where the edge's label sits, when it has one. */
  labelX: number;
  labelY: number;
}

export interface VisualLayout {
  width: number;
  height: number;
  nodes: LaidOutNode[];
  edges: LaidOutEdge[];
}

/** Measures a string at a size/weight. Injectable so the layout is testable. */
export type Measure = (text: string, size: number, weight: number) => number;

/** A deterministic fallback: no canvas, no fonts — a plausible advance width. */
export const estimateWidth: Measure = (text, size) => text.length * size * 0.56;

// ── Text ────────────────────────────────────────────────────────────────────

function wrap(text: string, max: number, measure: Measure): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line.length > 0 ? `${line} ${word}` : word;
    if (line.length > 0 && measure(next, TEXT.size, TEXT.weight) > max) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  lines.push(line);
  return lines.length > 0 ? lines : [text];
}

interface Size {
  w: number;
  h: number;
  lines: string[];
}

function sizeOf(label: string, measure: Measure): Size {
  const maxText = NODE.maxWidth - NODE.padX * 2;
  const lines = wrap(label, maxText, measure);
  const widest = Math.max(...lines.map((l) => measure(l, TEXT.size, TEXT.weight)));
  const w = Math.max(NODE.minWidth, Math.min(NODE.maxWidth, Math.ceil(widest) + NODE.padX * 2));
  const h = lines.length * TEXT.line + NODE.padY * 2;
  return { w, h, lines };
}

// ── Isotonic regression (PAVA), as the source uses it ───────────────────────

interface V {
  id: string | null;
  dummy: boolean;
  rank: number;
  /** Size across the ranks. */
  cross: number;
  /** Size along the rank direction. */
  main: number;
  order: number;
  x: number;
  /** Position along the rank direction, filled in later. */
  y: number;
  up: V[];
  down: V[];
  back: boolean;
}

function isotonic(layer: V[], want: number[], weight: number[], gap: number): void {
  const n = layer.length;
  const offset: number[] = [0];
  for (let i = 1; i < n; i += 1) {
    offset[i] = (offset[i - 1] ?? 0) + ((layer[i - 1]?.cross ?? 0) + (layer[i]?.cross ?? 0)) / 2 + gap;
  }
  const blocks: { sum: number; weight: number; from: number; to: number }[] = [];
  for (let i = 0; i < n; i += 1) {
    let block = {
      sum: ((want[i] ?? 0) - (offset[i] ?? 0)) * (weight[i] ?? 1),
      weight: weight[i] ?? 1,
      from: i,
      to: i,
    };
    while (
      blocks.length > 0 &&
      (blocks[blocks.length - 1]?.sum ?? 0) / (blocks[blocks.length - 1]?.weight ?? 1) > block.sum / block.weight
    ) {
      const prev = blocks.pop();
      if (prev === undefined) break;
      block = { sum: prev.sum + block.sum, weight: prev.weight + block.weight, from: prev.from, to: block.to };
    }
    blocks.push(block);
  }
  for (const block of blocks) {
    for (let i = block.from; i <= block.to; i += 1) {
      const v = layer[i];
      if (v !== undefined) v.x = block.sum / block.weight + (offset[i] ?? 0);
    }
  }
}

function crossings(layers: V[][]): number {
  let count = 0;
  for (let r = 1; r < layers.length; r += 1) {
    const links: [number, number][] = [];
    const layer = layers[r] ?? [];
    for (const v of layer) for (const u of v.up) links.push([u.order, v.order]);
    for (let i = 0; i < links.length; i += 1) {
      for (let j = i + 1; j < links.length; j += 1) {
        const a = links[i];
        const b = links[j];
        if (a === undefined || b === undefined) continue;
        if ((a[0] - b[0]) * (a[1] - b[1]) < 0) count += 1;
      }
    }
  }
  return count;
}

interface EdgeRec {
  from: string;
  to: string;
  label?: string;
  chain: V[];
}

// ── The layout ──────────────────────────────────────────────────────────────

/**
 * Lays a validated flow intent out on ranked layers. Pure: the same intent and
 * the same measure always produce the same geometry.
 */
export function layoutFlow(intent: VisualIntent, measure: Measure): VisualLayout {
  const side = intent.direction === "LR";
  const index = new Map(intent.nodes.map((n, i) => [n.id, i]));
  const sizes = intent.nodes.map((n) => sizeOf(n.label, measure));
  const n = intent.nodes.length;

  const verts: V[] = intent.nodes.map((node, i) => {
    const size = sizes[i] ?? { w: NODE.minWidth, h: 40, lines: [node.label] };
    return {
      id: node.id,
      dummy: false,
      rank: 0,
      cross: side ? size.h : size.w,
      main: side ? size.w : size.h,
      order: 0,
      x: 0,
      y: 0,
      up: [],
      down: [],
      back: false,
    };
  });

  // Break cycles: an edge that returns to a node already on the DFS stack is a
  // back edge, drawn from the later rank to the earlier one.
  const out: { u: number; v: number }[][] = intent.nodes.map(() => []);
  for (const edge of intent.edges) {
    const u = index.get(edge.from);
    const v = index.get(edge.to);
    if (u === undefined || v === undefined) continue;
    out[u]?.push({ u, v });
  }
  const state = new Uint8Array(n);
  const backFlag = new Set<string>();
  const visit = (u: number): void => {
    state[u] = 1;
    for (const link of out[u] ?? []) {
      if (state[link.v] === 1) backFlag.add(`${link.u}>${link.v}`);
      else if (state[link.v] === 0) visit(link.v);
    }
    state[u] = 2;
  };
  for (let u = 0; u < n; u += 1) if (state[u] === 0) visit(u);

  const succ: { link: EdgeRec }[][] = intent.nodes.map(() => []);
  const pred: { link: EdgeRec }[][] = intent.nodes.map(() => []);
  const links: EdgeRec[] = [];
  for (const edge of intent.edges) {
    const u = index.get(edge.from);
    const v = index.get(edge.to);
    if (u === undefined || v === undefined) continue;
    const back = backFlag.has(`${u}>${v}`);
    const a = back ? v : u;
    const b = back ? u : v;
    const rec: EdgeRec = { from: edge.from, to: edge.to, chain: [] };
    if (edge.label !== undefined) rec.label = edge.label;
    (rec as EdgeRec & { back?: boolean }).back = back;
    links.push(rec);
    succ[a]?.push({ link: rec });
    pred[b]?.push({ link: rec });
  }

  // Longest-path ranking over the acyclic orientation.
  const rank = new Array<number>(n).fill(0);
  const indegree = pred.map((list) => list.length);
  const queue: number[] = [];
  for (let u = 0; u < n; u += 1) if ((indegree[u] ?? 0) === 0) queue.push(u);
  for (let q = 0; q < queue.length; q += 1) {
    const u = queue[q] ?? 0;
    for (const { link } of succ[u] ?? []) {
      const b = index.get(link.to) ?? 0;
      rank[b] = Math.max(rank[b] ?? 0, (rank[u] ?? 0) + 1);
      indegree[b] = (indegree[b] ?? 1) - 1;
      if (indegree[b] === 0) queue.push(b);
    }
  }
  for (let u = 0; u < n; u += 1) {
    if ((pred[u] ?? []).length === 0 && (succ[u] ?? []).length > 0) {
      const targets = (succ[u] ?? []).map(({ link }) => rank[index.get(link.to) ?? 0] ?? 0);
      rank[u] = Math.min(...targets) - 1;
    }
  }
  verts.forEach((v, i) => {
    v.rank = rank[i] ?? 0;
  });

  // A dummy vertex per rank an edge crosses, so long edges route cleanly.
  const allVerts: V[] = [...verts];
  for (const link of links) {
    const u = index.get(link.from) ?? 0;
    const v = index.get(link.to) ?? 0;
    const back = backFlag.has(`${u}>${v}`);
    const a = back ? v : u;
    const b = back ? u : v;
    const chain: V[] = [verts[a] as V];
    for (let r = (rank[a] ?? 0) + 1; r < (rank[b] ?? 0); r += 1) {
      const dummy: V = { id: null, dummy: true, rank: r, cross: 12, main: 0, order: 0, x: 0, y: 0, up: [], down: [], back };
      allVerts.push(dummy);
      chain.push(dummy);
    }
    chain.push(verts[b] as V);
    for (let k = 1; k < chain.length; k += 1) {
      (chain[k - 1] as V).down.push(chain[k] as V);
      (chain[k] as V).up.push(chain[k - 1] as V);
    }
    link.chain = chain;
  }

  const depth = Math.max(0, ...allVerts.map((v) => v.rank)) + 1;
  const layers: V[][] = Array.from({ length: depth }, () => []);
  const placed = new Set<V>();
  const place = (v: V): void => {
    if (placed.has(v)) return;
    placed.add(v);
    (layers[v.rank] ??= []).push(v);
    for (const w of v.down) place(w);
  };
  for (const v of allVerts) if (!v.dummy && v.up.length === 0) place(v);
  for (const v of allVerts) place(v);

  const number = (): void => {
    for (const layer of layers) layer.forEach((v, i) => { v.order = i; });
  };
  number();

  // Barycenter sweeps; keep the best ordering seen.
  let best = layers.map((l) => [...l]);
  let bestCount = crossings(layers);
  for (let sweep = 0; sweep < SWEEPS && bestCount > 0; sweep += 1) {
    const down = sweep % 2 === 0;
    for (let k = 1; k < depth; k += 1) {
      const layer = layers[down ? k : depth - 1 - k] ?? [];
      for (const v of layer) {
        const near = down ? v.up : v.down;
        const bary = near.length > 0 ? near.reduce((s, w) => s + w.order, 0) / near.length : v.order;
        (v as V & { bary?: number }).bary = bary;
      }
      layer.sort((a, b) => (((a as V & { bary?: number }).bary ?? a.order) - ((b as V & { bary?: number }).bary ?? b.order)) || a.order - b.order);
      layer.forEach((v, i) => { v.order = i; });
    }
    const count = crossings(layers);
    if (count < bestCount) {
      bestCount = count;
      best = layers.map((l) => [...l]);
    }
  }
  best.forEach((layer, r) => { layers[r] = layer; });
  number();

  // Cross-axis placement: pack, then smooth toward neighbours (isotonic).
  for (const layer of layers) {
    let x = 0;
    for (const v of layer) {
      v.x = x + v.cross / 2;
      x += v.cross + GAP.node;
    }
    const shift = (x - GAP.node) / 2;
    for (const v of layer) v.x -= shift;
  }
  const solid = (v: V, near: V[]): V[] => {
    if (v.dummy) return near;
    const kept = near.filter((w) => !w.dummy || !w.back);
    return kept.length > 0 ? kept : near;
  };
  for (let sweep = 0; sweep < SWEEPS * 3; sweep += 1) {
    const down = sweep % 2 === 0;
    for (let k = 0; k < depth; k += 1) {
      const layer = layers[down ? k : depth - 1 - k] ?? [];
      const want = layer.map((v) => {
        const near = solid(v, down ? (v.up.length > 0 ? v.up : v.down) : (v.down.length > 0 ? v.down : v.up));
        return near.length > 0 ? near.reduce((s, w) => s + w.x, 0) / near.length : v.x;
      });
      isotonic(layer, want, layer.map((v) => (v.dummy ? (v.back ? 0.001 : 3) : 1)), GAP.node);
    }
  }

  // Main-axis placement: rank sizes plus a gap.
  const size = layers.map((layer) => Math.max(0, ...layer.map((v) => v.main)));
  const drawn = new Array<boolean>(depth).fill(false);
  for (const link of links) {
    const u = index.get(link.from) ?? 0;
    const v = index.get(link.to) ?? 0;
    for (let r = Math.min(rank[u] ?? 0, rank[v] ?? 0); r < Math.max(rank[u] ?? 0, rank[v] ?? 0); r += 1) drawn[r] = true;
  }
  const mainAt: number[] = [];
  let cursor = 0;
  for (let r = 0; r < depth; r += 1) {
    mainAt[r] = cursor + (size[r] ?? 0) / 2;
    cursor += (size[r] ?? 0) + (drawn[r] ? GAP.rank : GAP.node);
  }
  const mainEnd = Math.max(0, cursor - (drawn[depth - 1] ? GAP.rank : GAP.node));
  for (const v of allVerts) v.y = mainAt[v.rank] ?? 0;

  // Map (cross, main) → scene (x, y) and shift cross so it starts at 0.
  const minCross = Math.min(0, ...allVerts.map((v) => v.x - v.cross / 2));
  const maxCross = Math.max(...allVerts.map((v) => v.x + v.cross / 2));
  const cx = (v: V): number => v.x - minCross;
  const toXY = (v: V): [number, number] => (side ? [v.y, cx(v)] : [cx(v), v.y]);

  const nodes: LaidOutNode[] = intent.nodes.map((node, i) => {
    const v = verts[i] as V;
    const size = sizes[i] ?? { w: NODE.minWidth, h: 40, lines: [node.label] };
    const [x, y] = toXY(v);
    return { id: node.id, label: node.label, shape: node.shape, x, y, w: size.w, h: size.h, lines: size.lines, rank: v.rank, order: v.order };
  });

  // Route each edge through its chain, from the source boundary to the target's.
  const half = (v: V): number => v.main / 2;
  const edges: LaidOutEdge[] = links.map((link) => {
    const chain = link.chain;
    const first = chain[0] as V;
    const last = chain[chain.length - 1] as V;
    const sign = chain.length > 1 && (chain[1] as V).y > first.y ? 1 : -1;
    const startMain = first.y + sign * half(first);
    const endMain = last.y - sign * half(last);
    const points: [number, number][] = [];
    points.push(side ? [startMain, cx(first)] : [cx(first), startMain]);
    for (let k = 1; k < chain.length - 1; k += 1) {
      const v = chain[k] as V;
      points.push(side ? [v.y, cx(v)] : [cx(v), v.y]);
    }
    points.push(side ? [endMain, cx(last)] : [cx(last), endMain]);

    const pts: number[] = [points[0]?.[0] ?? 0, points[0]?.[1] ?? 0];
    for (let i = 1; i < points.length; i += 1) {
      const a = points[i - 1];
      const b = points[i];
      if (a === undefined || b === undefined) continue;
      pts.push(a[0] + (b[0] - a[0]) / 3, a[1] + (b[1] - a[1]) / 3, a[0] + ((b[0] - a[0]) * 2) / 3, a[1] + ((b[1] - a[1]) * 2) / 3, b[0], b[1]);
    }
    const mid = points[Math.floor(points.length / 2)] ?? [0, 0];
    const out: LaidOutEdge = { from: link.from, to: link.to, pts, labelX: mid[0], labelY: mid[1] };
    if (link.label !== undefined) out.label = link.label;
    return out;
  });

  const width = maxCross - minCross + GAP.pad * 2;
  const height = mainEnd + GAP.pad * 2;
  return {
    width: side ? height : width,
    height: side ? width : height,
    nodes,
    edges,
  };
}

// ── The sequence layout ─────────────────────────────────────────────────────
//
// A sequence is not a graph: actors sit in columns, each column carries a
// lifeline, and ordered messages cross between lifelines. This is KAI's own
// geometry, in the same spirit as the flow layout but for the sequence kind.

const SEQ = {
  pad: 18,
  colGap: 40,
  minCol: 96,
  headerGap: 26,
  rowGap: 46,
  selfWidth: 46,
};

export interface LaidOutActor {
  id: string;
  label: string;
  /** The header label, wrapped to the header width. */
  lines: string[];
  /** Header box centre. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Lifeline x (the column centre). */
  cx: number;
  /** Lifeline top and bottom. */
  top: number;
  bottom: number;
}

export interface LaidOutMessage {
  from: string;
  to: string;
  text: string;
  dashed: boolean;
  /** Arrow y. */
  y: number;
  /** Arrow runs x1 → x2. */
  x1: number;
  x2: number;
  labelX: number;
  labelY: number;
  /** A message to self loops right instead of crossing to another lifeline. */
  self: boolean;
}

export interface SequenceLayout {
  width: number;
  height: number;
  actors: LaidOutActor[];
  messages: LaidOutMessage[];
}

/**
 * Lays a validated sequence out as actor columns, lifelines and ordered message
 * rows. Pure: the same intent and the same measure always produce the same
 * geometry.
 */
export function layoutSequence(intent: SequenceIntent, measure: Measure): SequenceLayout {
  const sizes = intent.actors.map((a) => sizeOf(a.label, measure));
  const columns = sizes.map((s) => Math.max(SEQ.minCol, s.w));
  const headerH = Math.max(40, ...sizes.map((s) => s.h));

  // Column centres, laid out left to right with a gap between them.
  const centres: number[] = [];
  let cursor = SEQ.pad;
  for (const w of columns) {
    centres.push(cursor + w / 2);
    cursor += w + SEQ.colGap;
  }
  const rowWidth = cursor - SEQ.colGap;
  const centre = new Map(intent.actors.map((a, i) => [a.id, centres[i] ?? 0]));

  const headerCenterY = SEQ.pad + headerH / 2;
  const lifelineTop = SEQ.pad + headerH;
  const messagesTop = lifelineTop + SEQ.headerGap;

  let right = rowWidth;
  const actors: LaidOutActor[] = intent.actors.map((a, i) => {
    const size = sizes[i] ?? { w: SEQ.minCol, h: 40, lines: [a.label] };
    const cx = centres[i] ?? 0;
    return {
      id: a.id,
      label: a.label,
      lines: size.lines,
      x: cx,
      y: headerCenterY,
      w: size.w,
      h: size.h,
      cx,
      top: lifelineTop,
      bottom: 0,
    };
  });

  const messages: LaidOutMessage[] = intent.messages.map((m, i) => {
    const y = messagesTop + i * SEQ.rowGap;
    const a = centre.get(m.from) ?? 0;
    const b = centre.get(m.to) ?? a;
    const self = m.from === m.to;
    const x1 = a;
    const x2 = self ? a + SEQ.selfWidth : b;
    right = Math.max(right, Math.max(x1, x2));
    return {
      from: m.from,
      to: m.to,
      text: m.text,
      dashed: m.dashed,
      y,
      x1,
      x2,
      labelX: self ? a + SEQ.selfWidth + 6 : (x1 + x2) / 2,
      labelY: self ? y : y - 7,
      self,
    };
  });

  const lifelineBottom = messagesTop + intent.messages.length * SEQ.rowGap + 6;
  for (const actor of actors) actor.bottom = lifelineBottom;

  return {
    width: right + SEQ.pad,
    height: lifelineBottom + SEQ.pad,
    actors,
    messages,
  };
}
