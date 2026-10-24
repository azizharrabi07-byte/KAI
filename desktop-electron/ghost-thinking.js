(() => {
'use strict';

// KAI's character, drawn by the REAL engine.
//
// This element used to paint a hand-written SVG of KAI (the "matrix orb") and load a
// whole animation machine around it that could never run: the SVG carried no
// `.shape` and no `.eye`, so the first thing `tick()` did was fall out again, and the
// character stood perfectly still. It is now a mount point for the engine KAI actually
// draws with — `app/src/character/` in the KAI app, compiled into
// `kai-character-engine.js` beside this file — so the face here is the same orb, the
// same 23 expressions, the same pose list and the same spring integrator, driven by
// the engine's own shared RAF loop (one loop for every mounted canvas, not one each).
//
// The element's contract is unchanged: a block the size of its CSS box, with
// `look(x, y, hold)`, `blink()` and `start`. Every caller — splash.js,
// welcome-ghost.js, chat.js, chat-list.js, mini-chat.js, effort-paint.js — works
// without a change.
//
// Two rules it keeps:
//   • it never takes a pointer event (`pointer-events: none` on the host): a chat
//     row's busy glyph must not stand between the user and the row;
//   • with `prefers-reduced-motion: reduce` it paints ONE settled still frame per
//     state and never starts the render loop.

const engine = window.KaiCharacter;
if (!engine) {
 console.error('KAI character: kai-character-engine.js is missing — the character cannot be drawn.');
} else {
 // The engine carries KAI's synthesised voices and would play one on every state change.
 // KAI2 has no sound design of its own and its other surfaces are silent, so the
 // character is silent here too (the engine only ever makes noise after its own
 // `Sound.preload()`/`resume()`, which KAI2 never calls; this makes it explicit).
 engine.Sound.setEnabled(false);
}

// The SVG this replaces drew the source's 400×420 art board into the host box with
// the default preserveAspectRatio ("meet"), and the orb body (r=150 ⇒ 300 units) is
// what you see. So the body filled min(300/400 · w, 300/420 · h) of the box. The
// engine's canvas is 1/0.6 wider than the body it draws (see BODY_RATIO in the
// engine's canvas-view.ts), so asking for exactly that body diameter reproduces the
// size and the centring the SVG had.
const BODY_FIT = { x: 300 / 400, y: 300 / 420 };
const MIN_BODY = 8;

// How long a `look()` holds before the eyes drift back, and the units the callers
// hand it: splash.js and welcome-ghost.js pass the old ghost's per-eye travel, up to
// ±4 across and 2.4 up / 2.2 down. The engine's gaze is normalised to ±1.
const GAZE = { x: 4, y: 2.4 };
const GAZE_HOLD = 1800;

// Steps of the engine's own 1/60 s clock run before a still frame is painted: 2.5 s
// is enough for a pose's timed step-sequence and its springs to have settled.
const STILL_STEPS = 150;

const STATE_EVENT = 'kai:character-state';
const STYLE = ':host{display:block;position:relative;pointer-events:none}';

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// KAI3D: every visible KAI face — the splash, a message status, the chat mark, mini
// chat, the effort panel — is the SAME 3D character as the welcome hero. One hidden
// <kai-avatar source> renders it and each mark copies that frame; a WebGL context per
// mark would not survive a long chat. Where WebGL is missing, the 2D engine below is
// still the face.
const mirrorApi = () => (window.KaiAvatar && window.KaiAvatar.mirror) || null;
const canMirror = () => Boolean(mirrorApi() && window.KaiAvatar.isSupported && window.KaiAvatar.isSupported());

/** The state the state-driver is on, so a surface that mounts late joins in mid-turn. */
function currentState() {
 return (window.KaiCharacterState && window.KaiCharacterState.current) || 'idle';
}

class GhostThinking extends HTMLElement {
 constructor() {
  super();
  this.attachShadow({ mode: 'open' }).innerHTML = `<style>${STYLE}</style>`;
  this.handle = null;
  this.mirroring = false;
  this.mirrorCanvas = null;
  this.detachMirror = null;
  this.size = 0;
  this.still = false;
  this.state = 'idle';
  this.gaze = null;
  this.gazeUntil = 0;
  this.gazeTimer = 0;
  this.observer = null;
  this.start = 0;
  this.onState = event => this.face(event.detail && event.detail.state);
 }

 connectedCallback() {
  this.setAttribute('role', 'img');
  this.setAttribute('aria-label', I18n.t('chat.thinking'));
  this.start = performance.now();
  document.addEventListener(STATE_EVENT, this.onState);
  this.mount();
  // The box is CSS's (the welcome box, a message status, an 11 px chat mark). Follow it
  // when it changes — a resized window, a panel opening — instead of drawing the orb at
  // the size it happened to have when it was appended.
  if (typeof ResizeObserver === 'function') {
   this.observer = new ResizeObserver(() => this.refit());
   this.observer.observe(this);
  }
 }

 disconnectedCallback() {
  document.removeEventListener(STATE_EVENT, this.onState);
  this.observer?.disconnect();
  this.observer = null;
  window.clearTimeout(this.gazeTimer);
  this.gazeTimer = 0;
  this.unmount();
 }

 /** The body diameter the CSS box asks for, or 0 while the box has no size yet.
  *
  *  The layout box, not `getBoundingClientRect()`: the welcome box is mounted while it
  *  is still scaled down (`transform: scale(0.6)` on `.welcome`), and a rect would
  *  report the scaled size. A transform scales the canvas with the element anyway, so
  *  the layout size is the honest one — and it is also what the ResizeObserver reports. */
 measure() {
  const width = this.clientWidth, height = this.clientHeight;
  if (!(width > 0) || !(height > 0)) return 0;
  return Math.max(MIN_BODY, Math.min(width * BODY_FIT.x, height * BODY_FIT.y));
 }

 mount() {
  if (this.handle || this.mirroring) return;
  if (canMirror()) {
   this.mountMirror();
   return;
  }
  if (!engine) return;
  const size = this.measure();
  if (!size) return; // not laid out yet (a hidden parent); the observer builds it later
  const handle = this.handle = engine.mountCharacterCanvas({ size });
  const wrap = handle.wrapper;
  // The engine's wrapper is the `size`-square box the body is centred in; put it in the
  // middle of the host box and let the canvas overhang it, as the SVG's art board did.
  wrap.style.position = 'absolute';
  wrap.style.left = '50%';
  wrap.style.top = '50%';
  wrap.style.margin = `${-size / 2}px 0 0 ${-size / 2}px`;
  this.shadowRoot.append(wrap);
  this.size = size;
  this.still = reducedMotion();
  if (this.still) handle.dispose(); // stills are painted by hand; never start the loop for one
  this.state = currentState();
  this.dataset.kaiState = this.state;
  handle.engine.setState(this.state, true);
  if (this.still) this.settle();
  else if (this.gaze) handle.setLook(this.gaze.x, this.gaze.y);
 }

 /** The 3D face: a canvas that copies KAI's shared character frame (see avatar3d/mirror.js). */
 mountMirror() {
  const api = mirrorApi();
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;background:none';
  this.shadowRoot.append(canvas);
  this.mirrorCanvas = canvas;
  this.mirroring = true;
  this.state = currentState();
  this.dataset.kaiState = this.state;
  this.detachMirror = api.attach(this, canvas);
  // The splash and the chat marks look at the pointer before the first frame arrives.
  if (this.lookRaw) api.look(this.lookRaw.x, this.lookRaw.y, 0);
 }

 unmount() {
  if (this.detachMirror) {
   this.detachMirror();
   this.detachMirror = null;
  }
  if (this.mirrorCanvas) {
   this.mirrorCanvas.remove();
   this.mirrorCanvas = null;
  }
  this.mirroring = false;
  if (!this.handle) return;
  this.handle.dispose();
  this.handle.wrapper.remove();
  this.handle = null;
  this.size = 0;
 }

 refit() {
  if (this.mirroring) return; // the copied canvas is sized by CSS
  if (!this.handle) { this.mount(); return; }
  const size = this.measure();
  if (!size || Math.abs(size - this.size) < 2) return;
  this.unmount();
  this.mount();
 }

 /** Runs the engine's own clock without drawing, then draws once: a settled still. */
 settle() {
  const handle = this.handle;
  if (!handle) return;
  for (let i = 0; i < STILL_STEPS; i++) handle.engine.update(1 / 60);
  this.paint();
 }

 /** One frame, exactly as the engine's canvas bridge draws it. */
 paint() {
  const handle = this.handle;
  if (!handle) return;
  const ctx = handle.el.getContext('2d');
  if (!ctx) return;
  const width = parseFloat(handle.el.style.width) || handle.el.width;
  const height = parseFloat(handle.el.style.height) || handle.el.height;
  const scale = handle.el.width / width;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, width, height);
  handle.engine.draw(ctx, width, height);
 }

 /** The state the state-driver broadcasts. Real KAI events only — see kai-character-state.js. */
 face(name) {
  const next = name || 'idle';
  if (next === this.state) return;
  this.state = next;
  this.dataset.kaiState = next;
  // The shared source follows `kai:character-state` itself; the mark only records.
  if (this.mirroring) return;
  const handle = this.handle;
  if (!handle) return;
  handle.engine.setState(next);
  if (this.still) this.settle();
 }

 /** Looks towards a point, in the callers' own eye-travel units; drifts back after `hold`. */
 look(x, y, hold = GAZE_HOLD) {
  if (this.mirroring) {
   this.lookRaw = { x, y };
   mirrorApi().look(x, y, hold);
   return;
  }
  this.gaze = { x: clamp(x / GAZE.x, -1, 1), y: clamp(y / GAZE.y, -1, 1) };
  this.gazeUntil = performance.now() + hold;
  this.handle?.setLook(this.gaze.x, this.gaze.y);
  if (this.still) this.paint();
  window.clearTimeout(this.gazeTimer);
  this.gazeTimer = window.setTimeout(() => {
   this.gazeTimer = 0;
   if (performance.now() < this.gazeUntil) return;
   this.gaze = null;
   this.handle?.setLook(0, 0);
   if (this.still) this.paint();
  }, hold);
 }

 blink() {
  if (this.mirroring) {
   mirrorApi().blink();
   return;
  }
  this.handle?.engine.blink();
  if (this.still) this.settle();
 }
}

if (!customElements.get('ghost-thinking')) customElements.define('ghost-thinking', GhostThinking);
})();
