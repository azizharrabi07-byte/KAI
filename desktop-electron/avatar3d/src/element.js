// KAI3D — `<kai-avatar>`: the element every KAI surface mounts.
//
// It is the ONLY thing that creates an AvatarStage, and it owns that stage:
//   • lazy — no WebGL context until the element has a size and is on screen, so the
//     launch splash is not competing with a fur renderer;
//   • one stage per element, disposed when the element leaves the document;
//   • the saved character config is loaded from the existing webview store
//     (`kai.character.v1`), and a save (`kai:character-changed`) is applied live;
//   • the real runtime state `kai-character-state.js` dispatches is applied through
//     the transition gate, so repeated status reads never restart a one-shot;
//   • when WebGL is unavailable (or the context is lost and cannot be restored) it
//     mounts the existing 2D `<ghost-thinking>` instead of showing an empty box.
//
// It never decides anything about KAI's work: it consumes state, it does not emit it.

import { CHANGE_EVENT, loadConfig, normalizeConfig } from './character-config.js';
import { ToolActivityState, subscribeToolActivity, toToolEvent } from './activity.js';
import { AvatarStage, AvatarUnavailableError, isAvatarSupported } from './stage.js';
import { avatarStateFor, labelForState } from './state-bridge.js';

const STATE_EVENT = 'kai:character-state';
const STYLE = `
  :host { display: block; position: relative; }
  :host([hidden]) { display: none; }
  .stage { position: absolute; inset: 0; overflow: hidden; }
  .notice {
    position: absolute; inset: auto 6px 6px 6px;
    font: 11px/1.4 var(--font, system-ui, sans-serif);
    color: var(--text-muted, #8a8f98);
    text-align: center;
    pointer-events: none;
  }
  .fallback { position: absolute; inset: 0; }
`;

export class KaiAvatarElement extends HTMLElement {
  static get observedAttributes() {
    return ['interactive'];
  }

  constructor() {
    super();
    this._root = this.attachShadow({ mode: 'open' });
    this._root.innerHTML = `<style>${STYLE}</style><div class="stage" part="stage"></div>`;
    this._stageHost = this._root.querySelector('.stage');
    this._stage = null;
    this._error = null;
    this._config = loadConfig();
    this._paused = false;
    this._gazeTimer = 0;
    this._tool = new ToolActivityState();
    this._unsubscribeActivity = null;
    this._onBridgeReady = () => this._bindToolActivity();
    this._visible = false;
    this._started = false;
    this._onState = (event) => this._applyRuntimeState(event && event.detail ? event.detail.state : null);
    this._onChange = (event) => {
      const config = event && event.detail ? event.detail.config : null;
      this.setConfig(config || loadConfig());
    };
    this._onResize = () => this._maybeStart();
    // Named, so a disposed stage never leaves this listener on the persistent shadow host.
    this._onContextLost = () => this._fallback('The graphics context was lost.');
  }

  connectedCallback() {
    document.addEventListener(STATE_EVENT, this._onState);
    document.addEventListener(CHANGE_EVENT, this._onChange);
    if (typeof ResizeObserver === 'function') {
      this._resizeObserver = new ResizeObserver(this._onResize);
      this._resizeObserver.observe(this);
    }
    if (this.hasAttribute('source')) {
      // The shared source lives off-screen on purpose: it must render whenever a mirror
      // needs a frame, so visibility never gates it.
      this._visible = true;
    } else if (typeof IntersectionObserver === 'function') {
      this._intersectionObserver = new IntersectionObserver(([entry]) => {
        this._visible = Boolean(entry && entry.isIntersecting);
        if (this._visible) this._maybeStart();
      }, { threshold: 0.01 });
      this._intersectionObserver.observe(this);
    } else {
      this._visible = true;
    }
    // Join a turn that is already running instead of waiting for the next change.
    this._bindToolActivity();
    const current = window.KaiCharacterState && window.KaiCharacterState.current;
    if (current) this._applyRuntimeState(current);
  }

  disconnectedCallback() {
    document.removeEventListener(STATE_EVENT, this._onState);
    document.removeEventListener(CHANGE_EVENT, this._onChange);
    this._resizeObserver?.disconnect();
    this._intersectionObserver?.disconnect();
    this._resizeObserver = null;
    this._intersectionObserver = null;
    window.clearTimeout(this._gazeTimer);
    document.removeEventListener('kai2:ready', this._onBridgeReady);
    if (this._unsubscribeActivity) {
      this._unsubscribeActivity();
      this._unsubscribeActivity = null;
    }
    this.dispose();
  }

  attributeChangedCallback() {
    // The interactive flag is read at construction; a change replaces the stage.
    if (!this._started) return;
    this.dispose();
    this._started = false;
    this._maybeStart();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Replaces the appearance. Accepts a partial/draft config; it is normalized here. */
  setConfig(config) {
    this._config = normalizeConfig(config);
    if (this._stage) this._stage.applyConfig(this._config);
  }

  /** Current (normalized) appearance of this element. */
  getConfig() {
    return normalizeConfig(this._config);
  }

  /** Applies one KAI2 state (idle | listening | thinking | working | …). */
  setState(state, options = {}) {
    this._applyRuntimeState(state, options);
  }

  /** Plays a character one-shot for the motion preview. Never touches app state. */
  previewAction(name) {
    return this._stage ? this._stage.previewAction(name) : false;
  }

  boop() {
    this._stage?.boop();
  }

  resetView() {
    this._stage?.resetView();
  }

  /**
   * Gaze, in the units the 2D ghost's callers already use (up to ±4 across, ±2.4 up,
   * ±2.2 down — see welcome-ghost.js/splash.js). They are normalized for the 3D eyes
   * here, so both surfaces read the same input, and the fallback still receives the
   * original values. `hold` ms later the eyes drift back.
   */
  look(x = 0, y = 0, hold = 0) {
    const nx = clampUnit(x / 4);
    const ny = clampUnit(y / 2.4);
    this._stage?.setGaze(nx, ny);
    this._fallbackGhost?.look?.(x, y, hold);
    window.clearTimeout(this._gazeTimer);
    if (hold > 0) {
      this._gazeTimer = window.setTimeout(() => {
        this._stage?.setGaze(0, 0);
        this._fallbackGhost?.look?.(0, 0, 0);
      }, hold);
    }
  }

  /** Kept for the callers that used the 2D ghost's `blink()`; the 3D engine blinks by itself. */
  blink() {
    this._stage?.setGaze(0, 0);
    this._fallbackGhost?.blink?.();
  }

  /** The canvas the stage renders into, when it exists (used by the mirror source). */
  frameCanvas() {
    return this._stage ? this._stage.renderer?.domElement || null : null;
  }

  /** Monotonic count of painted frames, so a mirror can skip identical ones. */
  frameCount() {
    return this._stage ? this._stage._frames : 0;
  }

  /** True when the 3D renderer is the one painting (false ⇒ the 2D fallback is up). */
  get live() {
    return Boolean(this._stage);
  }

  /** The quality actually running (after the renderer's own capability check). */
  get effectiveQuality() {
    return this._stage ? this._stage.effectiveQuality : null;
  }

  /** True when high-fidelity fur was asked for but this machine could not start it. */
  get gpuFurUnavailable() {
    return Boolean(this._stage && this._stage.gpuFurUnavailable);
  }

  get error() {
    return this._error;
  }

  /** Stops painting while the surface is hidden (the renderer and its state stay). */
  pause() {
    this._paused = true;
    this._stage?.setPaused(true);
  }

  /** Paints again after `pause()`. */
  resume() {
    this._paused = false;
    this._maybeStart();
    this._stage?.setPaused(false);
  }

  /** Discards the renderer entirely (a removed element never keeps a WebGL context). */
  suspend() {
    this._stage?.dispose();
    this._stage = null;
  }

  dispose() {
    window.clearTimeout(this._gazeTimer);
    this._stageHost.removeEventListener('kai-avatar-context-lost', this._onContextLost);
    if (this._stage) {
      this._stage.dispose();
      this._stage = null;
    }
    this._stageHost.replaceChildren();
    this._started = false;
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  _applyRuntimeState(state, options = {}) {
    const avatar = avatarStateFor(state);
    if (!avatar) return;
    this._runtimeState = state;
    this._face(options);
    this.dispatchEvent(new CustomEvent('kai-avatar-state', {
      detail: { runtime: state, avatar, label: labelForState(state) },
      bubbles: true,
      composed: true,
    }));
  }

  /**
   * One face, resolved from the two REAL inputs: the app's runtime state and the
   * bridge's tool activity. The runtime's safety states always win; a running tool
   * wins over thinking/listening/idle because it is the more specific truth.
   */
  _face(options = {}) {
    if (!this._stage) return;
    const runtime = avatarStateFor(this._runtimeState) || 'idle';
    const safety = runtime === 'offline' || runtime === 'error' || runtime === 'success';
    const tool = this._tool.face();
    const next = safety ? runtime : tool || runtime;
    this._stage.setState(next, options);
  }

  /** Subscribes to `window.KAI2.onActivity` once the bridge exists. */
  _bindToolActivity() {
    if (this._unsubscribeActivity) return;
    const bind = () => {
      const off = subscribeToolActivity(window.KAI2, (entry) => this._onToolActivity(entry));
      if (!off) return false;
      this._unsubscribeActivity = off;
      return true;
    };
    if (bind()) return;
    document.addEventListener('kai2:ready', this._onBridgeReady);
  }

  _onToolActivity(entry) {
    if (entry === null) {
      // The active conversation changed: nothing from the previous one is in flight.
      this._tool.reset();
      this._face();
      return;
    }
    const event = toToolEvent(entry);
    if (!event) return;
    const changed = this._tool.update(event);
    if (event.kind === 'failed') {
      // A real tool failure is a one-shot recoil; it is not the turn's error state and
      // it never celebrates a completion.
      this._stage?.flashError();
    }
    if (changed) this._face();
  }

  _maybeStart() {
    if (this._started || !this.isConnected) return;
    if (this._visible === false) return;
    if (this.clientWidth < 2 || this.clientHeight < 2) return;
    this._started = true;
    this._stageHost.replaceChildren();
    this._error = null;

    if (!isAvatarSupported()) {
      this._fallback('WebGL is not available on this machine.');
      return;
    }
    try {
      const isSource = this.hasAttribute('source');
      this._stage = new AvatarStage(this._stageHost, {
        config: this._config,
        interactive: this.hasAttribute('interactive'),
        // The source is copied into the marks: it renders at 1:1 and keeps its buffer.
        ...(isSource ? { pixelRatio: 1, preserveDrawingBuffer: true, frameRate: 30, alwaysRender: true } : {}),
      });
    } catch (error) {
      this._fallback(error instanceof AvatarUnavailableError ? error.message : String(error));
      return;
    }
    this._stageHost.removeEventListener('kai-avatar-context-lost', this._onContextLost);
    this._stageHost.addEventListener('kai-avatar-context-lost', this._onContextLost);
    if (this._paused) this._stage.setPaused(true);
    const current = this._runtimeState || (window.KaiCharacterState && window.KaiCharacterState.current);
    if (current) this._runtimeState = current;
    this._face({ replay: true });
    this.dispatchEvent(new CustomEvent('kai-avatar-ready', { bubbles: true, composed: true }));
  }

  _fallback(reason) {
    this._error = reason;
    this._stage?.dispose();
    this._stage = null;
    this._stageHost.replaceChildren();
    // The 2D character is already part of the app; reusing it means an unsupported
    // GPU never leaves KAI faceless.
    this._fallbackGhost = null;
    if (customElements.get('ghost-thinking')) {
      const ghost = document.createElement('ghost-thinking');
      ghost.className = 'fallback';
      this._stageHost.append(ghost);
      this._fallbackGhost = ghost;
    }
    this.dispatchEvent(new CustomEvent('kai-avatar-unavailable', {
      detail: { reason },
      bubbles: true,
      composed: true,
    }));
  }
}

function clampUnit(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(1, Math.max(-1, number));
}

if (!customElements.get('kai-avatar')) customElements.define('kai-avatar', KaiAvatarElement);
