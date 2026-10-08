// Standalone browser harness for the ported orb — used to verify the character
// renders and that the state/accessory/skin setters change what is drawn.
// Bundled with esbuild into app/public/character/demo.js and loaded by
// app/public/character/index.html. Not part of the app bundle.
//
// MIT.

import { KaiEngine, type KaiStateName, type AccessoryName, type SkinName } from "./engine";

const DPR = Math.min(2, window.devicePixelRatio || 1);
const OVER = 40;

interface Tile { engine: KaiEngine; canvas: HTMLCanvasElement; w: number; h: number; label: string }
const tiles: Tile[] = [];

function makeTile(parent: HTMLElement, label: string, size: number): Tile {
  const box = document.createElement("div");
  box.className = "tile";
  const cap = document.createElement("div");
  cap.className = "cap";
  cap.textContent = label;
  const canvas = document.createElement("canvas");
  const w = size, h = size + OVER;
  canvas.width = Math.round(w * DPR);
  canvas.height = Math.round(h * DPR);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  box.append(canvas, cap);
  parent.append(box);
  const engine = new KaiEngine();
  engine.particleOverhang = OVER;
  const t: Tile = { engine, canvas, w, h, label };
  tiles.push(t);
  return t;
}

// ── Stage: one big orb the harness drives programmatically ────────────────────

const stageWrap = document.getElementById("stage") as HTMLElement;
const stage = makeTile(stageWrap, "stage", 240);

// ── Grid: states, accessories, skins ─────────────────────────────────────────

const states: KaiStateName[] = [
  "idle", "listening", "thinking", "working", "using_tool", "delegating",
  "waiting", "waiting_approval", "success", "error", "offline", "planning",
];
const stateGrid = document.getElementById("states") as HTMLElement;
for (const s of states) {
  const t = makeTile(stateGrid, s, 104);
  t.engine.setState(s, true);
}

// Boot + a few of the source's BN poses, reached intentionally (no random picker).
const poses = ["boot", "jump", "rolling", "idea", "scan", "cool", "cross", "derp"];
const poseGrid = document.getElementById("poses") as HTMLElement;
for (const p of poses) {
  const t = makeTile(poseGrid, p, 104);
  (t.engine as unknown as { orb: { go(n: string): void } }).orb.go(p);
}

const accessories: AccessoryName[] = ["none", "hair", "cap", "bat", "phones", "cat", "crown", "halo"];
const acGrid = document.getElementById("accessories") as HTMLElement;
for (const a of accessories) {
  const t = makeTile(acGrid, a, 104);
  t.engine.setAccessory(a);
  t.engine.setState("idle", true);
}

const skins: SkinName[] = ["blue", "black", "yellow"];
const skinGrid = document.getElementById("skins") as HTMLElement;
for (const s of skins) {
  const t = makeTile(skinGrid, s, 104);
  t.engine.setSkin(s);
  t.engine.setState("working", true);
  t.engine.setAccessory("hair");
}

// ── Loop ─────────────────────────────────────────────────────────────────────

function renderAll(steps: number) {
  for (let s = 0; s < steps; s++) {
    for (const t of tiles) {
      t.engine.update(1 / 60);
      const ctx = t.canvas.getContext("2d");
      if (!ctx) continue;
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      ctx.clearRect(0, 0, t.w, t.h);
      t.engine.draw(ctx, t.w, t.h);
    }
  }
}

// Settle every tile to its pose before the first paint, so a still screenshot
// shows the real poses rather than mid-transition springs.
renderAll(150);

let last = performance.now();
function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  renderAll(1);
  void dt;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ── Programmatic control + a pixel signature for automated verification ──────

function signature(canvas: HTMLCanvasElement): string {
  const ctx = canvas.getContext("2d");
  if (!ctx) return "none";
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  let on = 0, sum = 0;
  for (let i = 0; i < data.length; i += 4 * 97) {
    const a = data[i + 3];
    if (a > 8) { on++; sum += data[i] + data[i + 1] * 3 + data[i + 2] * 7; }
  }
  return `${on}:${sum % 100000}`;
}

interface KaiHarness {
  setState(s: KaiStateName): void;
  setAccessory(a: AccessoryName): void;
  setSkin(s: SkinName): void;
  pose(p: string): void;
  signature(which: number): string;
  tileCount(): number;
  labels(): string[];
  engine(): KaiEngine;
  settle(steps: number): void;
}

(window as unknown as { kai: KaiHarness }).kai = {
  setState: (s) => stage.engine.setState(s, true),
  setAccessory: (a) => stage.engine.setAccessory(a),
  setSkin: (s) => stage.engine.setSkin(s),
  pose: (p) => (stage.engine as unknown as { orb: { go(n: string): void } }).orb.go(p),
  signature: (which) => signature(tiles[which]?.canvas ?? stage.canvas),
  tileCount: () => tiles.length,
  labels: () => tiles.map((t) => t.label),
  engine: () => stage.engine,
  settle: (steps) => renderAll(steps),
};
