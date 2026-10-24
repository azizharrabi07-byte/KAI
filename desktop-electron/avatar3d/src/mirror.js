// KAI3D — the shared frame source for KAI's small character marks.
//
// The new character is not only the welcome hero: it is also the 30 px face beside a
// reply while KAI is working, the launch splash, the mini-chat and the effort panel.
// Those surfaces cannot each own a WebGL context (a chat can mount several marks, and
// the browser caps contexts), so ONE hidden `<kai-avatar source>` renders the character
// and every mark copies its frame into a small 2D canvas.
//
// Ownership:
//   • the source is created on demand, at 256 px, pixel ratio 1, preserveDrawingBuffer
//     so a frame can be copied at any time;
//   • it is paused while no mirror is on screen, and resumed when one is;
//   • mirrors never create a renderer and never choose a state — they copy the source,
//     which follows the same `kai:character-state` / `kai2.onActivity` / saved config
//     as the welcome hero;
//   • a mark that is not visible is not drawn.
//
// If WebGL is unavailable `ensureSource()` returns null and the caller keeps its 2D
// face (ghost-thinking's existing path).

const SOURCE_SIZE = 256;
/**
 * How much of the source canvas a mark shows.
 *
 * The source frames the WHOLE character (the camera is fitted to the coat), so a large
 * mirror — the launch splash — copies the full frame and shows all of it. A 30 px mark
 * would be mostly empty space at that framing, so small mirrors copy the centre where
 * the face is; they are the one place a crop is intended.
 */
const SOURCE_CROP_SMALL = 0.8;
/** Below this many CSS pixels on its short side, a mirror is a face mark, not a portrait. */
const FULL_FRAME_MIN = 64;

function cropFor(host) {
  const short = Math.min(host.clientWidth || 0, host.clientHeight || 0);
  return short >= FULL_FRAME_MIN ? 1 : SOURCE_CROP_SMALL;
}

let sourceElement = null;
let raf = 0;
let lastDrawn = -1;

/** Every attached mirror: { host, canvas, visible, lastFrame }. */
const mirrors = new Set();

function ensureSource() {
  if (sourceElement) return sourceElement;
  if (!window.KaiAvatar || typeof window.KaiAvatar.isSupported !== 'function' || !window.KaiAvatar.isSupported()) return null;
  const element = document.createElement('kai-avatar');
  element.setAttribute('source', '');
  // Off the layout on purpose: it must have a size to render, but never be seen or hit.
  element.style.cssText = `position:fixed;left:-10000px;top:0;width:${SOURCE_SIZE}px;height:${SOURCE_SIZE}px;pointer-events:none;`;
  document.body.appendChild(element);
  sourceElement = element;
  return element;
}

function sourceCanvas() {
  return sourceElement && typeof sourceElement.frameCanvas === 'function' ? sourceElement.frameCanvas() : null;
}

function sourceFrame() {
  return sourceElement && typeof sourceElement.frameCount === 'function' ? sourceElement.frameCount() : 0;
}

/** Pauses/resumes the one renderer according to whether anything is actually showing. */
function syncSource() {
  if (!sourceElement) return;
  let visible = 0;
  for (const mirror of mirrors) if (mirror.visible && mirror.host.isConnected) visible += 1;
  if (visible > 0) sourceElement.resume();
  else sourceElement.pause();
}

function start() {
  if (raf || !sourceElement) return;
  raf = requestAnimationFrame(draw);
}

function stop() {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
}

function draw() {
  raf = requestAnimationFrame(draw);
  let anyVisible = false;
  for (const mirror of mirrors) if (mirror.visible && mirror.host.isConnected) anyVisible = true;
  if (!anyVisible) {
    // Nothing on screen copies the source: stop the loop until one is visible again.
    stop();
    lastDrawn = -1;
    return;
  }
  const source = sourceCanvas();
  if (!source || !source.width) return;
  const frame = sourceFrame();
  if (frame === lastDrawn) return;
  lastDrawn = frame;
  for (const mirror of mirrors) {
    if (!mirror.visible || !mirror.host.isConnected) continue;
    paintMirror(mirror, source);
  }
}

function paintMirror(mirror, source) {
  const canvas = mirror.canvas;
  const width = Math.max(1, Math.round(canvas.clientWidth || mirror.host.clientWidth || 1));
  const height = Math.max(1, Math.round(canvas.clientHeight || mirror.host.clientHeight || 1));
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const backingW = Math.round(width * dpr);
  const backingH = Math.round(height * dpr);
  if (canvas.width !== backingW || canvas.height !== backingH) {
    canvas.width = backingW;
    canvas.height = backingH;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, backingW, backingH);
  // Cover the box: the full frame for a portrait mirror, the centre for a face mark.
  const crop = Math.min(source.width, source.height) * cropFor(mirror.host);
  const sx = (source.width - crop) / 2;
  const sy = (source.height - crop) / 2;
  const scale = Math.max(backingW / crop, backingH / crop);
  const dw = crop * scale;
  const dh = crop * scale;
  ctx.drawImage(source, sx, sy, crop, crop, (backingW - dw) / 2, (backingH - dh) / 2, dw, dh);
}

/**
 * Attaches a 2D canvas to the shared source.
 *
 * @param {HTMLElement} host the element whose box the canvas fills
 * @param {HTMLCanvasElement} canvas the mirror's own canvas
 * @returns {() => void} dispose
 */
export function attachMirror(host, canvas) {
  const element = ensureSource();
  if (!element) return () => {};
  const mirror = { host, canvas, visible: true, lastFrame: -1 };
  const observer = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver(([entry]) => {
      mirror.visible = Boolean(entry && entry.isIntersecting);
      syncSource();
      lastDrawn = -1;
      if (mirror.visible) start();
    }, { threshold: 0.01 })
    : null;
  observer?.observe(host);
  mirrors.add(mirror);
  lastDrawn = -1;
  syncSource();
  start();
  return () => {
    mirrors.delete(mirror);
    observer?.disconnect();
    if (mirrors.size === 0) {
      stop();
      lastDrawn = -1;
    }
    syncSource();
  };
}

/**
 * Paints every visible mirror from the CURRENT source frame, synchronously.
 *
 * The live path is requestAnimationFrame; a hidden or occluded window throttles rAF,
 * so a test (or a one-shot render after a state change) needs a way to ask for the
 * frame now. Returns false when the source has not produced a frame yet.
 */
export function flushMirrors() {
  const source = sourceCanvas();
  if (!source || !source.width) return false;
  let painted = false;
  for (const mirror of mirrors) {
    if (!mirror.visible || !mirror.host.isConnected) continue;
    paintMirror(mirror, source);
    painted = true;
  }
  return painted;
}

/** Gaze, in the 2D ghost's caller units (see `<kai-avatar>.look`). */
export function lookSource(x, y, hold) {
  sourceElement?.look?.(x, y, hold);
}

/** The shared face's own blink; the source engine blinks on its own too. */
export function blinkSource() {
  sourceElement?.blink?.();
}

/** True once the shared renderer exists and has painted at least one frame. */
export function isMirrorReady() {
  return Boolean(sourceCanvas());
}
