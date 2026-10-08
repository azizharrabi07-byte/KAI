// KAI's launch sequence — the "boot" that plays when the island first opens.
//
// ORIGINAL sequence written for KAI: the core materialises, a scan sweep crosses
// the frame, the KAI wordmark types itself in, then everything tucks down into
// the island. No upstream artwork, layout or audio is reused; the drawing is
// procedural and lives in the 640×150 reference space the greeting canvas uses.
//
// MIT.

import { Sound } from "../core/sound";

// ── Timeline (seconds) ────────────────────────────────────────────────────────

const T = {
  core0: 0.0,
  core1: 0.45,
  ring0: 0.35,
  ring1: 0.85,
  sweep0: 0.55,
  sweep1: 1.35,
  mark0: 1.05,
  mark1: 1.85,
  sub0: 1.7,
  sub1: 2.15,
  hold: 2.45,
  tuck0: 2.45,
  tuck1: 2.85,
  end: 2.9,
  autoLeave: 3.4,
};

export const GREETING_END = T.end;

// ── Geometry (640×150 reference space) ───────────────────────────────────────

const W = 640;
const H = 150;
const CORE_X = 132; // core centre
const CORE_Y = 75;
const CORE_R = 40;
const MARK_X = 196; // wordmark left edge
const MARK_Y = 66;

const INK = "#05070E";
const BAND = "#D9F5FF";
const RIM = "#B4E5FF";
const ACCENT = "#38BDF8";

// ── Easing ────────────────────────────────────────────────────────────────────

const E = {
  out: (t: number) => 1 - Math.pow(1 - t, 3),
  in: (t: number) => t * t * t,
  inOut: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  back: (t: number) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
};

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const seg = (t: number, a: number, b: number) => clamp((t - a) / (b - a), 0, 1);

/** Superellipse core path, so the boot's core matches the island's character. */
function corePath(x: CanvasRenderingContext2D, cx: number, cy: number, r: number, exp = 4): void {
  const n = 72;
  const e = 2 / exp;
  x.beginPath();
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const px = cx + r * (ca >= 0 ? Math.pow(ca, e) : -Math.pow(-ca, e));
    const py = cy + r * (sa >= 0 ? Math.pow(sa, e) : -Math.pow(-sa, e));
    if (i === 0) x.moveTo(px, py);
    else x.lineTo(px, py);
  }
  x.closePath();
}

function rr(x: CanvasRenderingContext2D, X: number, Y: number, Wd: number, Hh: number, R: number) {
  const r = Math.max(0, Math.min(R, Wd / 2, Hh / 2));
  x.beginPath();
  x.moveTo(X + r, Y);
  x.arcTo(X + Wd, Y, X + Wd, Y + Hh, r);
  x.arcTo(X + Wd, Y + Hh, X, Y + Hh, r);
  x.arcTo(X, Y + Hh, X, Y, r);
  x.arcTo(X, Y, X + Wd, Y, r);
  x.closePath();
}

interface Pose {
  core: number; // 0…1 core presence
  scale: number;
  ring: number; // 0…1 expanding ring
  sweep: number; // −1 (left of frame) … 2 (right of frame); <0 = not started
  mark: number; // letters revealed (0…3)
  sub: number; // subtitle alpha
  tuck: number; // 0…1 tuck progress
  alpha: number; // whole-frame alpha
}

function pose(t: number, tc: number): Pose {
  const out: Pose = {
    core: 0,
    scale: 1,
    ring: 0,
    sweep: -1,
    mark: 0,
    sub: 0,
    tuck: 0,
    alpha: 1,
  };

  out.scale = seg(t, T.core0, T.core1) < 1 ? E.back(seg(t, T.core0, T.core1)) : 1;
  out.core = seg(t, T.core0, T.core1 * 0.8);
  out.ring = seg(t, T.ring0, T.ring1);
  if (t >= T.sweep0) out.sweep = -0.1 + E.inOut(seg(t, T.sweep0, T.sweep1)) * 2.2;
  out.mark = E.out(seg(t, T.mark0, T.mark1)) * 3;
  out.sub = E.out(seg(t, T.sub0, T.sub1));

  if (Number.isFinite(tc) && t >= tc) {
    out.tuck = E.in(seg(t, tc, tc + (T.tuck1 - T.tuck0)));
  } else if (t >= T.tuck0) {
    out.tuck = E.in(seg(t, T.tuck0, T.tuck1));
  }

  // The frame fades just before the island takes over.
  out.alpha = 1 - seg(t, T.end - 0.25, T.end);
  return out;
}

// ── Greeting ──────────────────────────────────────────────────────────────────

export class Greeting {
  private startMs = 0;
  private tc = Number.POSITIVE_INFINITY;
  private fired = false;
  private timers: number[] = [];

  onComplete: (() => void) | null = null;

  start() {
    this.startMs = performance.now();
    this.tc = Number.POSITIVE_INFINITY;
    this.fired = false;
    this.cancelTimers();
    this.timers.push(
      window.setTimeout(() => Sound.play("greet"), T.core1 * 1000),
      window.setTimeout(() => Sound.play("blip"), T.mark0 * 1000),
      window.setTimeout(() => Sound.play("blip"), T.sub0 * 1000),
      window.setTimeout(() => this.fire(), (T.end + 0.05) * 1000),
    );
  }

  /** Mouse entered the island during the greeting — hold it open. */
  hover() {
    if (this.tc >= T.autoLeave) this.tc = Number.POSITIVE_INFINITY;
  }

  /** Mouse left — collapse from now. */
  interrupt() {
    const t = this.elapsed;
    if (!Number.isFinite(this.tc) || this.tc > t) this.tc = t;
    this.cancelTimers();
  }

  get elapsed(): number {
    return (performance.now() - this.startMs) / 1000;
  }

  get done(): boolean {
    return this.fired;
  }

  private fire() {
    if (this.fired) return;
    this.fired = true;
    this.cancelTimers();
    this.onComplete?.();
  }

  private cancelTimers() {
    this.timers.forEach((id) => window.clearTimeout(id));
    this.timers = [];
  }

  draw(x: CanvasRenderingContext2D) {
    const t = this.elapsed;
    if (!this.fired && t >= T.end && this.tc >= T.autoLeave) this.fire();

    const p = pose(t, this.tc);
    x.clearRect(0, 0, W, H);
    if (p.alpha <= 0) return;

    x.save();
    x.globalAlpha = p.alpha;

    // ── Backdrop: a soft dark vignette so the boot reads on any wallpaper.
    const bg = x.createLinearGradient(0, 0, W, 0);
    bg.addColorStop(0, "rgba(5,7,14,0.92)");
    bg.addColorStop(0.72, "rgba(5,7,14,0.86)");
    bg.addColorStop(1, "rgba(5,7,14,0.60)");
    rr(x, 8, 30, W - 16, 100, 22);
    x.fillStyle = bg;
    x.fill();

    x.save();
    rr(x, 8, 30, W - 16, 100, 22);
    x.clip();

    // ── Scan sweep: one bright band crossing the frame left to right.
    if (p.sweep >= -0.05 && p.sweep <= 1.05) {
      const sx = p.sweep * W;
      const sg = x.createLinearGradient(sx - 90, 0, sx + 90, 0);
      sg.addColorStop(0, "rgba(56,189,248,0)");
      sg.addColorStop(0.5, "rgba(56,189,248,0.20)");
      sg.addColorStop(1, "rgba(56,189,248,0)");
      x.fillStyle = sg;
      x.fillRect(sx - 90, 30, 180, 100);
      x.fillStyle = "rgba(217,245,255,0.75)";
      x.fillRect(sx, 30, 1.6, 100);
    }

    // ── The core, materialising and (on tuck) dropping into the island.
    const tuck = p.tuck;
    const coreScale = p.scale * (1 - tuck * 0.62);
    const coreY = CORE_Y + tuck * tuck * 36;
    const coreX = CORE_X + tuck * tuck * -98;
    const r = CORE_R * coreScale;

    if (p.core > 0.01 && r > 0.5) {
      if (p.ring > 0 && p.ring < 1) {
        const rr0 = r * (1 + p.ring * 1.6);
        x.strokeStyle = `rgba(180,229,255,${(1 - p.ring) * 0.55})`;
        x.lineWidth = Math.max(1, 3 * (1 - p.ring));
        x.beginPath();
        x.arc(coreX, coreY, rr0, 0, Math.PI * 2);
        x.stroke();
      }

      const halo = x.createRadialGradient(coreX, coreY, r * 0.2, coreX, coreY, r * 2.1);
      halo.addColorStop(0, "rgba(56,189,248,0.34)");
      halo.addColorStop(1, "rgba(56,189,248,0)");
      x.fillStyle = halo;
      x.beginPath();
      x.arc(coreX, coreY, r * 2.1, 0, Math.PI * 2);
      x.fill();

      const body = x.createLinearGradient(coreX + r * 0.8, coreY - r * 0.9, coreX - r * 0.7, coreY + r * 0.95);
      body.addColorStop(0, "#2A3352");
      body.addColorStop(1, "#0E1120");
      x.fillStyle = body;
      x.globalAlpha = p.alpha * clamp(p.core, 0, 1);
      corePath(x, coreX, coreY, r);
      x.fill();
      x.globalAlpha = p.alpha;

      x.strokeStyle = RIM;
      x.globalAlpha = p.alpha * 0.55;
      x.lineWidth = Math.max(1, r * 0.07);
      corePath(x, coreX, coreY, r);
      x.stroke();
      x.globalAlpha = p.alpha;

      // Kernel ring.
      x.strokeStyle = `rgba(180,229,255,0.22)`;
      x.lineWidth = Math.max(1, r * 0.045);
      rr(x, coreX - r * 0.6, coreY - r * 0.6, r * 1.2, r * 1.2, r * 0.26);
      x.stroke();

      // Iris band, opening with the core.
      const bh = r * 0.17 * clamp(p.core * 1.4, 0, 1);
      if (bh > 0.5) {
        x.fillStyle = BAND;
        x.globalAlpha = p.alpha * 0.96;
        rr(x, coreX - r * 0.34, coreY - r * 0.16 - bh / 2, r * 0.68, bh, bh / 2);
        x.fill();
        x.globalAlpha = p.alpha;
      }
    }

    // ── Wordmark: K·A·I typed in, with the tracking settling as it lands.
    if (p.mark > 0.01) {
      const letters = ["K", "A", "I"];
      const track = 34 + (1 - clamp(p.mark / 3, 0, 1)) * 26;
      x.textBaseline = "middle";
      x.font = `700 44px system-ui, "Segoe UI Variable Display", "Segoe UI", sans-serif`;
      for (let i = 0; i < letters.length; i++) {
        const appear = clamp(p.mark - i, 0, 1);
        if (appear <= 0) continue;
        x.globalAlpha = p.alpha * E.out(appear);
        x.fillStyle = i === 2 ? ACCENT : "#F4F8FF";
        x.fillText(letters[i], MARK_X + i * track, MARK_Y + (1 - E.out(appear)) * 10);
      }
      x.globalAlpha = p.alpha;
    }

    // ── Subtitle.
    if (p.sub > 0.01) {
      x.globalAlpha = p.alpha * p.sub;
      x.fillStyle = "rgba(210,225,245,0.86)";
      x.font = `400 15px system-ui, "Segoe UI Variable Text", "Segoe UI", sans-serif`;
      x.fillText("personal agent online", MARK_X, MARK_Y + 34);
      x.globalAlpha = p.alpha;
    }

    // Accent rule that draws itself under the subtitle.
    const ruleW = E.out(seg(t, T.sub0 + 0.12, T.sub1 + 0.25)) * 210;
    if (ruleW > 1) {
      x.fillStyle = "rgba(56,189,248,0.75)";
      rr(x, MARK_X, MARK_Y + 48, ruleW, 2, 1);
      x.fill();
    }

    x.restore();
    x.restore();
  }
}

// Keep T exported for tests/tools without leaking a mutable global to callers.
export const GREETING_TIMELINE = T;
export const GREETING_VIEWPORT = { W, H, INK };
