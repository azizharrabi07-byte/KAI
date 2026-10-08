// KAI — a mounted canvas of the REAL character engine.
//
// This is the bridge the CSS orb never had: it puts the actual `KaiEngine`
// (the same class the island draws with, `./engine.ts`) onto a `<canvas>` and
// keeps it animating. Every orb in the main workspace — the hero, the rail
// badge, the agent cards, the feelings-lab samples, the appearance preview —
// is one of these, so there is exactly ONE renderer for KAI in the app.
//
// It draws each frame from a single shared RAF loop (one loop for every mounted
// canvas, not one per canvas), and it deliberately knows nothing about the
// runtime machine or the appearance store: those are pushed in by the caller
// (`./system.ts` / the presence adapter). That keeps this file a dumb painter.
//
// MIT.

import { KaiEngine } from "./engine";
import { hexToRGB } from "./types";
import type { KaiVariant } from "./variant";

const OVERHANG_DEFAULT = 0;

/** The engine draws the body at 0.6 × the canvas width (see KaiEngine.draw). */
const BODY_RATIO = 0.6;

function dpr(): number {
  const d = typeof window !== "undefined" ? window.devicePixelRatio : 1;
  return Math.min(2, d || 1);
}

export interface CharacterCanvasOptions {
  /** The visual body diameter, in CSS px. The canvas is sized larger to fit it. */
  size: number;
  /** Extra canvas height so a halo / shadow can fly out unclipped. */
  overhang?: number;
  /** Flat single-colour orb (mini bots, identity chips). */
  mini?: boolean;
  /** Hue rotation (deg) for an agent's own identity colour. */
  hue?: number;
  /** Explicit flat body colour (hex) for a mini/identity orb. */
  color?: string;
  title?: string;
  /** Extra class on the layout wrapper. */
  className?: string;
}

export interface CharacterCanvasHandle {
  /** The layout box (what a caller inserts and sizes against). */
  wrapper: HTMLElement;
  /** The canvas itself. */
  el: HTMLCanvasElement;
  /** The live renderer, exposed read-only for verification harnesses. */
  engine: KaiEngine;
  setLook(x: number, y: number): void;
  boop(): void;
  dispose(): void;
}

// ── One shared RAF loop for every mounted canvas ──────────────────────────────

const mounted = new Set<CharacterCanvasImpl>();
let rafHandle = 0;
let lastFrame = 0;
let pageHidden = false;

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    pageHidden = document.hidden;
    if (!pageHidden) lastFrame = performance.now();
  });
}

function tick(now: number): void {
  const dt = Math.min(0.05, Math.max(0, (now - lastFrame) / 1000));
  lastFrame = now;
  for (const view of mounted) view.frame(dt);
  rafHandle = requestAnimationFrame(tick);
}

function ensureLoop(): void {
  if (rafHandle !== 0 || typeof requestAnimationFrame !== "function") return;
  lastFrame = performance.now();
  rafHandle = requestAnimationFrame(tick);
}

function maybeStopLoop(): void {
  if (mounted.size === 0 && rafHandle !== 0) {
    cancelAnimationFrame(rafHandle);
    rafHandle = 0;
  }
}

// ── The canvas ────────────────────────────────────────────────────────────────

class CharacterCanvasImpl implements CharacterCanvasHandle {
  readonly wrapper: HTMLElement;
  readonly el: HTMLCanvasElement;
  readonly engine = new KaiEngine();
  private readonly cssW: number;
  private readonly cssH: number;
  private readonly scale: number;
  private disposed = false;

  constructor(options: CharacterCanvasOptions) {
    const size = Math.max(8, options.size);
    const overhang = options.overhang ?? OVERHANG_DEFAULT;
    // Body diameter = size ⇒ canvas is size / 0.6 wide, plus the overhang in height.
    this.cssW = size / BODY_RATIO;
    this.cssH = this.cssW + overhang;
    this.scale = dpr();

    this.engine.particleOverhang = overhang;
    if (options.mini === true) {
      this.engine.isMini = true;
      if (options.color !== undefined) this.engine.bodyColor = hexToRGB(options.color);
    }

    const canvas = document.createElement("canvas");
    canvas.width = Math.round(this.cssW * this.scale);
    canvas.height = Math.round(this.cssH * this.scale);
    canvas.style.width = `${this.cssW}px`;
    canvas.style.height = `${this.cssH}px`;
    canvas.style.position = "absolute";
    canvas.style.left = `${-(this.cssW - size) / 2}px`;
    canvas.style.top = `${-(this.cssW - size) / 2 - overhang / 2}px`;
    canvas.style.pointerEvents = "none";
    canvas.style.background = "none";

    const wrapper = document.createElement("span");
    wrapper.className = options.className ?? "orb orb-c";
    wrapper.style.position = "relative";
    wrapper.style.display = "inline-block";
    wrapper.style.flex = "none";
    wrapper.style.width = `${size}px`;
    wrapper.style.height = `${size}px`;
    wrapper.style.background = "none";
    wrapper.style.borderRadius = "50%";
    if (options.hue !== undefined) wrapper.style.filter = `hue-rotate(${options.hue}deg)`;
    if (options.title !== undefined) wrapper.title = options.title;
    wrapper.append(canvas);

    this.wrapper = wrapper;
    this.el = canvas;
    mounted.add(this);
    ensureLoop();
  }

  frame(dt: number): void {
    if (this.disposed) return;
    this.engine.update(dt);
    if (pageHidden) return;
    const ctx = this.el.getContext("2d");
    if (ctx === null) return;
    ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);
    this.engine.draw(ctx, this.cssW, this.cssH);
  }

  setLook(x: number, y: number): void {
    this.engine.lookX = Math.max(-1, Math.min(1, x));
    this.engine.lookY = Math.max(-1, Math.min(1, y));
  }

  boop(): void {
    this.engine.squash();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    mounted.delete(this);
    maybeStopLoop();
  }
}

/** Mounts the real engine on its own canvas. The caller owns the returned handle. */
export function mountCharacterCanvas(options: CharacterCanvasOptions): CharacterCanvasHandle {
  return new CharacterCanvasImpl(options);
}

/** Applies an appearance variant to a mounted canvas via the engine's public API. */
export function applyAppearanceToCanvas(handle: CharacterCanvasHandle, variant: KaiVariant): void {
  handle.engine.setSkin(variant.skin);
  handle.engine.setAccessory(variant.accessory);
}
