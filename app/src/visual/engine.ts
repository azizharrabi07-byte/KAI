// KAI Visual Engine — the renderer (SVG scene + spring animation).
//
// The scene-graph idea is adapted from OpenGhost's MIT-covered `diagram.js`:
// keyed items reconciled into layered SVG groups, with spring-integrated
// property interpolation driving the entrance. It is reimplemented here in
// KAI's own TypeScript, drawing KAI's own palette. No OpenGhost stylesheet,
// class name or visual identity is used (see NOTICE.md).
//
// THE BOUNDARY: this engine draws TEXT and GEOMETRY only. A label becomes a
// `textContent` string, never HTML; the model never supplies markup, a path or
// a URL. The intent it accepts has already been validated by Core, and it
// re-checks it here before drawing anything.

import { guardIntent, type VisualIntent, type SequenceIntent } from "./types";
import {
  layoutFlow,
  layoutSequence,
  estimateWidth,
  type Measure,
  type VisualLayout,
  type SequenceLayout,
} from "./layout";

const SVG_NS = "http://www.w3.org/2000/svg";

// KAI's palette, referenced through the app's own CSS variables so the drawing
// wears the same colours as the island. Fallbacks match style.css.
const INK = "var(--ink,#f5f6f8)";
const DIM = "var(--dim,#9398a1)";
const CARD = "var(--card,#141518)";
const HAIRLINE = "var(--hairline,rgba(255,255,255,0.06))";
const INDIGO = "var(--indigo,#6366f1)";

// The font is set HERE, on the SVG, rather than left to a stylesheet: the
// renderer must measure and draw at the same metrics in every window that hosts
// it (the island and the main workspace load different stylesheets). The
// per-text sizes below mirror layout.ts's TEXT constants.
const FONT_STACK = 'system-ui, "Segoe UI", sans-serif';
const SIZE = { node: 12.5, edge: 11, actor: 12.5, message: 11.5 };

function svg(tag: string, attrs: Record<string, string> = {}, parent?: Element): SVGElement {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (parent) parent.appendChild(el);
  return el;
}

/** A canvas-backed measure when a document is present, else the deterministic one. */
function defaultMeasure(): Measure {
  if (typeof document === "undefined") return estimateWidth;
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = document.createElement("canvas").getContext("2d");
  } catch {
    ctx = null;
  }
  if (ctx === null) return estimateWidth;
  const cache = new Map<string, number>();
  return (text, size, weight) => {
    const key = `${weight} ${size}px ${text}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    ctx.font = `${weight} ${size}px system-ui, "Segoe UI", sans-serif`;
    const w = ctx.measureText(text).width;
    cache.set(key, w);
    return w;
  };
}

interface Item {
  el: SVGElement;
  cur: { o: number; s: number };
  vel: { o: number; s: number };
  to: { o: number; s: number };
  /** Draw progress 0…1 for edges (dash offset); 1 for nodes. */
  draw: number;
  len: number;
  x: number;
  y: number;
  /** Wall-clock ms before this item starts moving (stagger). */
  beginAt: number;
}

function springTo(obj: Record<string, number>, vel: Record<string, number>, key: string, goal: number, dt: number, k = 170, c = 24): boolean {
  let x = obj[key] ?? 0;
  let v = vel[key] ?? 0;
  if (x === goal && v === 0) return false;
  const steps = Math.max(1, Math.ceil(dt / 0.008));
  const h = dt / steps;
  for (let i = 0; i < steps; i += 1) {
    v += ((goal - x) * k - v * c) * h;
    x += v * h;
  }
  if (Math.abs(goal - x) < 0.01 && Math.abs(v) < 0.05) {
    obj[key] = goal;
    vel[key] = 0;
    return false;
  }
  obj[key] = x;
  vel[key] = v;
  return true;
}

/** What a successful render reports back — the renderer's own receipt. */
export interface VisualReceipt {
  ok: true;
  kind: "flow" | "sequence";
  /** Present for a flow (`sequence` has no direction). */
  direction?: "TD" | "LR";
  /** Flow node count (0 for a sequence). */
  nodes: number;
  /** Flow edge count (0 for a sequence). */
  edges: number;
  /** Sequence participant count (0 for a flow). */
  actors: number;
  /** Sequence message count (0 for a flow). */
  messages: number;
  width: number;
  height: number;
  renderedAt: string;
}

export interface VisualRejection {
  ok: false;
  code: string;
  reason: string;
}

export type RenderResult = VisualReceipt | VisualRejection;

/**
 * KAI's visual renderer. One instance owns one SVG stage inside a host element.
 * The public surface is `render` / `clear`; `handle` is the read-only receipt.
 */
export class KaiVisualEngine {
  private host: HTMLElement;
  private items: Item[] = [];
  private raf = 0;
  private last = 0;
  private measure: Measure = defaultMeasure();
  private tick = (now: number): void => this.step(now);

  /** The last render's receipt, for verification harnesses (read-only). */
  lastReceipt: VisualReceipt | null = null;
  /** The last rejection, so a refusal is as observable as a success. */
  lastRejection: VisualRejection | null = null;

  constructor(host: HTMLElement) {
    this.host = host;
    // Follow the island's precedent: register the exact renderer the product
    // draws with, so a CDP harness reaches the real engine, never a stub.
    if (typeof window !== "undefined") {
      (window as unknown as { __kaiVisualEngine?: KaiVisualEngine }).__kaiVisualEngine = this;
    }
  }

  /** Renders a validated intent. Refuses anything that fails the guard. */
  render(rawIntent: unknown): RenderResult {
    const guarded = guardIntent(rawIntent);
    if (!guarded.ok) {
      const rejection: VisualRejection = { ok: false, code: guarded.code, reason: guarded.reason };
      this.lastRejection = rejection;
      return rejection;
    }
    const intent = guarded.intent;
    const renderedAt = new Date().toISOString();

    if (intent.kind === "sequence") {
      const layout = layoutSequence(intent, this.measure);
      this.buildSequence(intent, layout);
      const receipt: VisualReceipt = {
        ok: true,
        kind: "sequence",
        nodes: 0,
        edges: 0,
        actors: intent.actors.length,
        messages: intent.messages.length,
        width: Math.round(layout.width),
        height: Math.round(layout.height),
        renderedAt,
      };
      this.lastReceipt = receipt;
      this.lastRejection = null;
      return receipt;
    }

    const layout = layoutFlow(intent, this.measure);
    this.buildFlow(intent, layout);
    const receipt: VisualReceipt = {
      ok: true,
      kind: "flow",
      direction: intent.direction,
      nodes: intent.nodes.length,
      edges: intent.edges.length,
      actors: 0,
      messages: 0,
      width: Math.round(layout.width),
      height: Math.round(layout.height),
      renderedAt,
    };
    this.lastReceipt = receipt;
    this.lastRejection = null;
    return receipt;
  }

  clear(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.items = [];
    this.host.replaceChildren();
  }

  private buildFlow(intent: VisualIntent, layout: VisualLayout): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.items = [];
    this.host.replaceChildren();

    const width = Math.ceil(layout.width);
    const height = Math.ceil(layout.height);
    const root = svg("svg", {
      class: "kai-visual-svg",
      width: String(width),
      height: String(height),
      viewBox: `0 0 ${width} ${height}`,
      role: "img",
      "aria-label": intent.title ?? "KAI visual",
      "font-family": FONT_STACK,
    });
    this.host.appendChild(root);

    // Layered groups, in draw order. This is the mechanism's scene layering.
    const layer = (name: string): SVGElement => svg("g", { class: `kai-visual-layer is-${name}` }, root);
    const edgeLayer = layer("edges");
    const nodeLayer = layer("nodes");
    const labelLayer = layer("labels");
    const started = performance.now();

    // Edges: a bezier path, drawn on with a stroke dash, plus an arrowhead.
    for (const edge of layout.edges) {
      const g = svg("g", { class: "kai-visual-edge" }, edgeLayer);
      const d = pathOf(edge.pts);
      const path = svg("path", { class: "kai-visual-edge-path", d, style: `stroke:${INDIGO};fill:none` }, g);
      const head = svg("path", { class: "kai-visual-edge-head", d: arrowhead(edge.pts), style: `fill:${INDIGO}` }, g);
      const item: Item = {
        el: g,
        cur: { o: 1, s: 1 },
        vel: { o: 0, s: 0 },
        to: { o: 1, s: 1 },
        draw: 0,
        len: 0,
        x: 0,
        y: 0,
        beginAt: started + (0.06 + Math.min(0.3, edge.pts.length * 0.004)) * 1000,
      };
      this.items.push(item);
      let len = 0;
      try {
        len = (path as SVGPathElement).getTotalLength();
      } catch {
        len = 200;
      }
      item.len = len;
      path.style.strokeDasharray = `${len} ${len + 1}`;
      head.style.opacity = "0";

      if (edge.label !== undefined) {
        const label = svg("g", { class: "kai-visual-edge-label" }, labelLayer);
        svg("rect", {
          x: String(edge.labelX - Math.max(18, edge.label.length * 3.4)),
          y: String(edge.labelY - 9),
          width: String(Math.max(36, edge.label.length * 6.8)),
          height: "18",
          rx: "9",
          style: `fill:${CARD};stroke:${HAIRLINE}`,
        }, label);
        const text = svg("text", {
          x: String(edge.labelX),
          y: String(edge.labelY),
          "text-anchor": "middle",
          "dominant-baseline": "central",
          class: "kai-visual-edge-label-text",
          "font-size": String(SIZE.edge),
          style: `fill:${DIM}`,
        }, label);
        text.textContent = edge.label;
        this.items.push({
          el: label, cur: { o: 0, s: 1 }, vel: { o: 0, s: 0 }, to: { o: 1, s: 1 },
          draw: 1, len: 0, x: 0, y: 0, beginAt: started + 160,
        });
      }
      // Keep the reference so the draw animation can find it.
      (g as SVGElement & { __path?: SVGPathElement }).__path = path as SVGPathElement;
      (g as SVGElement & { __head?: SVGElement }).__head = head;
    }

    // Nodes: a shape and its wrapped label, rising and fading in by rank.
    for (const node of layout.nodes) {
      const g = svg("g", { class: `kai-visual-node is-${node.shape}` }, nodeLayer);
      const shapeStyle = `fill:${CARD};stroke:${HAIRLINE}`;
      if (node.shape === "diamond") {
        const hw = node.w / 2;
        const hh = node.h / 2;
        svg("path", {
          class: "kai-visual-shape",
          d: `M0,${-hh} L${hw},0 L0,${hh} L${-hw},0 Z`,
          style: shapeStyle,
        }, g);
      } else if (node.shape === "round") {
        svg("rect", {
          class: "kai-visual-shape",
          x: String(-node.w / 2), y: String(-node.h / 2),
          width: String(node.w), height: String(node.h),
          rx: String(node.h / 2),
          style: shapeStyle,
        }, g);
      } else {
        svg("rect", {
          class: "kai-visual-shape",
          x: String(-node.w / 2), y: String(-node.h / 2),
          width: String(node.w), height: String(node.h),
          rx: "8",
          style: shapeStyle,
        }, g);
      }
      const text = svg("text", {
        class: "kai-visual-label",
        "text-anchor": "middle",
        "dominant-baseline": "central",
        "font-size": String(SIZE.node),
        style: `fill:${INK}`,
      }, g);
      node.lines.forEach((line, i) => {
        const span = svg("tspan", {
          x: "0",
          y: String((i - (node.lines.length - 1) / 2) * 17),
        }, text);
        span.textContent = line;
      });

      g.setAttribute("transform", `translate(${node.x} ${node.y}) scale(0.92)`);
      g.style.opacity = "0";
      this.items.push({
        el: g,
        cur: { o: 0, s: 0.92 },
        vel: { o: 0, s: 0 },
        to: { o: 1, s: 1 },
        draw: 1,
        len: 0,
        x: node.x,
        y: node.y,
        beginAt: started + (0.05 + node.rank * 0.06 + node.order * 0.015) * 1000,
      });
    }

    this.wake();
  }

  /**
   * Builds a sequence as lifelines, ordered messages and actor headers. Same
   * layered-SVG, spring-animated mechanism as a flow; different geometry.
   */
  private buildSequence(intent: SequenceIntent, layout: SequenceLayout): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.items = [];
    this.host.replaceChildren();

    const width = Math.ceil(layout.width);
    const height = Math.ceil(layout.height);
    const root = svg("svg", {
      class: "kai-visual-svg",
      width: String(width),
      height: String(height),
      viewBox: `0 0 ${width} ${height}`,
      role: "img",
      "aria-label": intent.title ?? "KAI sequence",
      "font-family": FONT_STACK,
    });
    this.host.appendChild(root);

    const layer = (name: string): SVGElement => svg("g", { class: `kai-visual-layer is-${name}` }, root);
    const lifelineLayer = layer("lifelines");
    const messageLayer = layer("messages");
    const actorLayer = layer("actors");
    const started = performance.now();

    // Lifelines first — behind the messages and the actor headers.
    for (const actor of layout.actors) {
      const line = svg("line", {
        class: "kai-visual-lifeline",
        x1: f(actor.cx),
        y1: f(actor.top),
        x2: f(actor.cx),
        y2: f(actor.bottom),
        "stroke-dasharray": "4 5",
        style: `stroke:${HAIRLINE}`,
      }, lifelineLayer);
      line.style.opacity = "0";
      this.items.push({ el: line, cur: { o: 0, s: 1 }, vel: { o: 0, s: 0 }, to: { o: 1, s: 1 }, draw: 1, len: 0, x: 0, y: 0, beginAt: started + 40 });
    }

    // Messages: a path drawn on with a dash, plus an arrowhead and a label.
    layout.messages.forEach((m, i) => {
      const g = svg("g", { class: `kai-visual-message${m.self ? " is-self" : ""}` }, messageLayer);
      const d = m.self
        ? `M${f(m.x1)},${f(m.y)} H${f(m.x2)} V${f(m.y + 16)} H${f(m.x1)}`
        : `M${f(m.x1)},${f(m.y)} H${f(m.x2)}`;
      const path = svg("path", {
        class: "kai-visual-message-path",
        d,
        style: `stroke:${INDIGO};fill:none`,
        ...(m.dashed ? { "stroke-dasharray": "6 5" } : {}),
      }, g);
      const headDir = m.self ? -1 : m.x2 >= m.x1 ? 1 : -1;
      const head = svg("path", {
        class: "kai-visual-message-head",
        d: arrowAt(m.x1, m.self ? m.y + 16 : m.y, headDir),
        style: `fill:${INDIGO}`,
      }, g);
      head.style.opacity = "0";
      (g as SVGElement & { __path?: SVGPathElement }).__path = path as SVGPathElement;
      (g as SVGElement & { __head?: SVGElement }).__head = head;

      const item: Item = {
        el: g,
        cur: { o: 0, s: 1 },
        vel: { o: 0, s: 0 },
        to: { o: 1, s: 1 },
        draw: 0,
        len: 0,
        x: 0,
        y: 0,
        beginAt: started + (0.06 + i * 0.06) * 1000,
      };
      this.items.push(item);
      let len = 0;
      try {
        len = (path as SVGPathElement).getTotalLength();
      } catch {
        len = 120;
      }
      item.len = len;
      path.style.strokeDasharray = `${len} ${len + 1}`;

      const label = svg("text", {
        class: "kai-visual-message-label",
        x: f(m.labelX),
        y: f(m.labelY),
        "text-anchor": m.self ? "start" : "middle",
        "dominant-baseline": "central",
        "font-size": String(SIZE.message),
        style: `fill:${DIM}`,
      }, g);
      label.textContent = m.text;
      this.items.push({ el: label, cur: { o: 0, s: 1 }, vel: { o: 0, s: 0 }, to: { o: 1, s: 1 }, draw: 1, len: 0, x: 0, y: 0, beginAt: started + 200 });
    });

    // Actor headers on top, rising in left to right.
    layout.actors.forEach((actor, i) => {
      const g = svg("g", { class: "kai-visual-actor" }, actorLayer);
      svg("rect", {
        class: "kai-visual-actor-box",
        x: f(-actor.w / 2),
        y: f(-actor.h / 2),
        width: String(actor.w),
        height: String(actor.h),
        rx: "8",
        style: `fill:${CARD};stroke:${HAIRLINE}`,
      }, g);
      const text = svg("text", {
        class: "kai-visual-actor-label",
        "text-anchor": "middle",
        "dominant-baseline": "central",
        "font-size": String(SIZE.actor),
        style: `fill:${INK}`,
      }, g);
      actor.lines.forEach((line, li) => {
        const span = svg("tspan", { x: "0", y: String((li - (actor.lines.length - 1) / 2) * 17) }, text);
        span.textContent = line;
      });
      g.setAttribute("transform", `translate(${f(actor.x)} ${f(actor.y)}) scale(0.92)`);
      g.style.opacity = "0";
      this.items.push({
        el: g,
        cur: { o: 0, s: 0.92 },
        vel: { o: 0, s: 0 },
        to: { o: 1, s: 1 },
        draw: 1,
        len: 0,
        x: actor.x,
        y: actor.y,
        beginAt: started + (0.05 + i * 0.05) * 1000,
      });
    });

    this.wake();
  }

  private wake(): void {
    if (this.raf) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.tick);
  }

  private step(now: number): void {
    this.raf = 0;
    const dt = Math.min(0.05, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    let busy = false;
    for (const item of this.items) {
      // Wall-clock stagger: an item that has not reached its start time is still
      // pending, so the frame stays busy and is scheduled again.
      if (now < item.beginAt) {
        busy = true;
        continue;
      }
      if (springTo(item.cur, item.vel, "o", item.to.o, dt)) busy = true;
      if (springTo(item.cur, item.vel, "s", item.to.s, dt)) busy = true;
      item.el.style.opacity = Math.max(0, Math.min(1, item.cur.o)).toFixed(3);

      const path = (item.el as SVGElement & { __path?: SVGPathElement }).__path;
      if (path !== undefined) {
        const progress = Math.max(0, Math.min(1, item.cur.o));
        path.style.strokeDasharray = `${item.len * progress} ${item.len + 1}`;
        const head = (item.el as SVGElement & { __head?: SVGElement }).__head;
        if (head !== undefined) head.style.opacity = Math.max(0, (progress - 0.7) / 0.3).toFixed(3);
        continue;
      }
      if (item.to.s !== 1 || item.cur.s !== 1) {
        item.el.setAttribute("transform", `translate(${item.x} ${item.y}) scale(${item.cur.s.toFixed(3)})`);
      }
    }
    if (busy) this.raf = requestAnimationFrame(this.tick);
  }
}

// ── Path helpers ────────────────────────────────────────────────────────────

function f(n: number): string {
  return (Math.round(n * 100) / 100).toString();
}

/** Flat cubic points → an SVG path `d`. */
function pathOf(pts: number[]): string {
  let d = `M${f(pts[0] ?? 0)},${f(pts[1] ?? 0)}`;
  for (let i = 2; i + 5 < pts.length; i += 6) {
    d += ` C${f(pts[i] ?? 0)},${f(pts[i + 1] ?? 0)} ${f(pts[i + 2] ?? 0)},${f(pts[i + 3] ?? 0)} ${f(pts[i + 4] ?? 0)},${f(pts[i + 5] ?? 0)}`;
  }
  return d;
}

/** A small filled triangle at the end of the last cubic segment. */
function arrowhead(pts: number[]): string {
  const n = pts.length;
  const px = pts[n - 2] ?? 0;
  const py = pts[n - 1] ?? 0;
  const qx = pts[n - 4] ?? px;
  const qy = pts[n - 3] ?? py;
  let dx = px - qx;
  let dy = py - qy;
  const len = Math.hypot(dx, dy) || 1;
  dx /= len;
  dy /= len;
  const nx = -dy;
  const ny = dx;
  const L = 7;
  const H = 3.6;
  const tipX = px + dx * L;
  const tipY = py + dy * L;
  return `M${f(tipX)},${f(tipY)} L${f(px + nx * H)},${f(py + ny * H)} L${f(px - nx * H)},${f(py - ny * H)} Z`;
}

/** A small horizontal arrowhead at (x, y) pointing `dir` (+1 right, -1 left). */
function arrowAt(x: number, y: number, dir: number): string {
  const L = 8;
  const H = 4;
  return `M${f(x + dir * L)},${f(y)} L${f(x)},${f(y - H)} L${f(x)},${f(y + H)} Z`;
}
