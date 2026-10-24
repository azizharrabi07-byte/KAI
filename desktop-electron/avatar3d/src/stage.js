// KAI3D — the render stage.
//
// One stage = one WebGL renderer + one creature + one fur system + one animation
// loop. A stage owns everything it creates and disposes all of it. Two stages may
// coexist (the welcome avatar and the Character Studio preview); they are never two
// sources of truth: both read the same config object shape and the same
// `kai:character-state` signal, and only the preview renders the draft.
//
// The rendering itself is the vendored KAI character library (`blobCreature.js`,
// `furSystem.js`, `furShaders.js`, `gpuPhysics.js`, `kaiState.js`,
// `stateIndicators.js`), unchanged. This file is the integration: scene rig, one
// loop, config → uniforms, state → pose, and lifecycle.
//
// Performance rules kept here:
//   • ONE requestAnimationFrame loop per stage, and it stops when the element is
//     not on screen or the document is hidden;
//   • appearance changes write uniforms — they never rebuild geometry;
//   • fur density changes stride count on the EXISTING buffers (`updateDensity`);
//   • in reduced-motion mode the stage paints on change instead of animating.
//
// MIT.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createBlobCreature } from './blobCreature.js';
import { createGPUFurPhysics } from './gpuPhysics.js';
import { createGPUFurSystem } from './furSystem.js';
import { KAI_ACTIONS, KAI_STATES, KAIStateController } from './kaiState.js';
import { createStateIndicators } from './stateIndicators.js';
import { normalizeConfig } from './character-config.js';
import { AvatarStateGate, avatarStateFor } from './state-bridge.js';

/** Why a stage could not be created. Never thrown for a missing optional feature. */
export class AvatarUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AvatarUnavailableError';
  }
}

/**
 * True when this machine can render the character at all.
 *
 * The answer cannot change while the page lives, and every mark asks for it, so it is
 * probed ONCE. Each probe creates a WebGL context; without the cache, mounting many
 * message marks would churn contexts.
 */
let supportCache = null;
export function isAvatarSupported() {
  if (supportCache !== null) return supportCache;
  if (typeof document === 'undefined') return false;
  try {
    const probe = document.createElement('canvas');
    const gl = probe.getContext('webgl2') || probe.getContext('webgl');
    if (!gl) return (supportCache = false);
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
    supportCache = true;
  } catch {
    supportCache = false;
  }
  return supportCache;
}

const CAMERA_FOV = 40;
/** The margin around the character's bounds. 1.15 leaves ~7% of the frame empty. */
const FRAME_MARGIN = 1.15;
/** Fur extends past the skin along its normal; the coat is framed with that growth. */
const FUR_FRAME_GROWTH = 1.15;
const POINTER_ACTIVE = 0.004;

/**
 * Rendering detail by on-screen size, for the lightweight pipeline.
 *
 * The supplied library draws 32 shells and 26k strands, which is ~1.3M triangles per
 * frame — measured at ~17 fps on an Intel UHD here. Shells and strands are sampling
 * density, not appearance: the same config (length, curl, clumping, colours) renders
 * at every tier, and the shell layer scale keeps the coat's full length. The tier
 * follows the surface's own pixels, like mip selection, so the small hero and the
 * large preview are the same character seen at different sampling rates.
 *
 *   < 240 px  → 20 shells / 8k strands
 *   < 420 px  → 24 shells / 12k strands
 *   otherwise → 32 shells / 16k strands
 *
 * `quality: "high"` ignores the tiers and uses the library's 64 shells / 60k strands
 * plus GPGPU physics.
 */
const DETAIL_TIERS = Object.freeze([
  { maxWidth: 240, shells: 20, strands: 8000 },
  { maxWidth: 420, shells: 24, strands: 12000 },
  { maxWidth: Infinity, shells: 32, strands: 16000 },
]);

/**
 * How much of the state's own palette is blended over the owner's saved palette,
 * per state, as a fraction of the configured accent strength.
 *
 * IDLE IS ZERO on purpose: at rest KAI must look exactly like the character the
 * owner designed. A running turn, an approval, an error or a celebration tints the
 * fur; the moment the state returns to idle the saved palette is what renders —
 * nothing is overwritten in storage, and no state's colour outlives its state.
 */
const STATE_ACCENT = Object.freeze({
  idle: 0,
  thinking: 0.5,
  working: 0.65,
  waiting_for_approval: 0.85,
  error: 0.9,
  success: 0.8,
  offline: 0.75,
});

export class AvatarStage {
  /**
   * @param {HTMLElement} host the element the canvas fills
   * @param {{ config?: object, interactive?: boolean, className?: string }} [options]
   */
  constructor(host, options = {}) {
    if (!host) throw new AvatarUnavailableError('No host element for the avatar.');
    if (!isAvatarSupported()) throw new AvatarUnavailableError('WebGL is not available on this machine.');

    this.host = host;
    this.config = normalizeConfig(options.config);
    this.interactive = options.interactive === true;
    // An ambient character on screen for hours does not need 60 fps; the interactive
    // preview in Settings does. The cap is a frame budget, not a lower frame rate when
    // the machine cannot reach it (measured on the real renderer in the report).
    this.frameRate = options.frameRate || (this.interactive ? 60 : 30);
    this._minFrameMs = 1000 / this.frameRate;
    // A fixed pixel ratio is used by the shared "source" stage: its canvas is copied
    // into the small mirrors, so it renders at 1:1 and never at the display's DPR.
    this._fixedDpr = Number(options.pixelRatio) > 0 ? Number(options.pixelRatio) : 0;
    // The shared source renders off-screen on purpose; an IntersectionObserver on its
    // (deliberately invisible) host would stop the very frames the marks copy.
    this._alwaysRender = options.alwaysRender === true;
    this._preserveBuffer = options.preserveDrawingBuffer === true;
    this._frames = 0;
    this.quality = this.config.render.quality;
    this._disposed = false;
    this._running = false;
    this._visible = true;
    this._paused = false;
    this._raf = 0;
    this._lastFrame = 0;
    this._elapsed = 0;
    this._dpr = 1;
    this._width = 0;
    this._height = 0;

    // State machine + the transition gate that stops one-shots re-firing.
    this.controller = new KAIStateController(KAI_STATES.IDLE);
    this.gate = new AvatarStateGate('idle');
    this._pendingShots = [];

    // Pointer / gaze state (creature's look target is NDC in [-1, 1]).
    this.gaze = new THREE.Vector2(0, 0);
    this._pointerVelocity = new THREE.Vector3();
    this._pointerLocal = new THREE.Vector3(0, 0, 2);
    this._pointerPrevious = new THREE.Vector3(0, 0, 2);
    this._pointerOver = false;
    this._pointerDown = false;
    this._pointerDownAt = 0;
    this._pointerDownPos = { x: 0, y: 0 };
    this._hitOrigin = new THREE.Vector3(0, 0.1, 0.98);
    this._hitNormal = new THREE.Vector3(0, 0.1, 0.98);
    this._hitStrength = 0;
    this._hitTime = 0;
    this._shockwave = 0;
    this._webglInertia = new THREE.Vector3();
    this._webglVelocity = new THREE.Vector3();
    this._force = new THREE.Vector3();
    this._raycaster = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();

    // Effective palette: the user's saved colours blended with the state accent.
    this._colors = {
      base: new THREE.Color('#111b2e'),
      tip: new THREE.Color('#7dd3fc'),
      accent: new THREE.Color('#38bdf8'),
    };
    this._stateColors = {
      base: new THREE.Color(this.controller.getStatePalette('idle').baseColor),
      tip: new THREE.Color(this.controller.getStatePalette('idle').tipColor),
      rim: new THREE.Color(this.controller.getStatePalette('idle').rimColor),
    };
    this._scratch = new THREE.Color();
    this._scratchTip = new THREE.Color();
    this._stillRendering = false;
    this._accentNow = 0;

    this._motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    this._onMotionPref = () => this._syncMotionMode();
    this._onVisibility = () => {
      if (document.hidden) this._stopLoop();
      else this._syncMotionMode();
    };
    this._onControlsChange = () => {
      if (this._stillMode() && !this._stillRendering) this.renderStill();
    };

    try {
      this._buildRenderer();
      this._buildScene();
      this._buildCharacter();
      this._buildObservers();
      this._bindPointer();
    } catch (error) {
      this.dispose();
      throw error instanceof AvatarUnavailableError ? error : new AvatarUnavailableError(String(error && error.message ? error.message : error));
    }

    this.applyConfig(this.config, { refresh: true });
    this._syncMotionMode();
  }

  // ── Construction ────────────────────────────────────────────────────────────

  _buildRenderer() {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
      alpha: true,
      // The shared source stage is read back with drawImage() by its mirrors; without
      // this the buffer is undefined after compositing.
      preserveDrawingBuffer: this._preserveBuffer,
    });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.renderer.shadowMap.enabled = this.quality === 'high';
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const canvas = this.renderer.domElement;
    canvas.className = 'kai-avatar-canvas';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    canvas.style.background = 'transparent';
    canvas.style.touchAction = 'none';
    if (!this.interactive) canvas.style.pointerEvents = 'none';
    // A lost context is reported to the owner (the element shows its 2D fallback)
    // instead of leaving a frozen frame behind.
    canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      this._stopLoop();
      this.host.dispatchEvent(new CustomEvent('kai-avatar-context-lost'));
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this._syncMotionMode();
      this.host.dispatchEvent(new CustomEvent('kai-avatar-context-restored'));
    });
    this.host.appendChild(canvas);
  }

  _buildScene() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 0.1, 80);
    this.camera.position.set(0, 0.35, 6);

    this.keyLight = new THREE.DirectionalLight('#f0f9ff', 1.8);
    this.keyLight.position.set(2.7, 2.1, 1.5);
    this.keyLight.castShadow = this.quality === 'high';
    this.keyLight.shadow.mapSize.set(1024, 1024);
    this.keyLight.shadow.bias = -0.0005;
    this.keyLight.shadow.radius = 2.5;
    this.keyLight.shadow.camera.left = -2.2;
    this.keyLight.shadow.camera.right = 2.2;
    this.keyLight.shadow.camera.top = 2.2;
    this.keyLight.shadow.camera.bottom = -2.2;
    this.keyLight.shadow.camera.near = 0.5;
    this.keyLight.shadow.camera.far = 10;
    this.keyLight.shadow.camera.updateProjectionMatrix();
    this.scene.add(this.keyLight);

    this.rimLight = new THREE.DirectionalLight('#38bdf8', 1.45);
    this.rimLight.position.set(-2.4, 1.8, -3.2);
    this.scene.add(this.rimLight);

    this.hemiLight = new THREE.HemisphereLight('#38bdf8', '#080f1d', 0.85);
    this.scene.add(this.hemiLight);

    if (this.interactive) {
      this.controls = new OrbitControls(this.camera, this.renderer.domElement);
      this.controls.enableDamping = true;
      this.controls.dampingFactor = 0.06;
      this.controls.minDistance = 2.4;
      this.controls.maxDistance = 24;
      this.controls.maxPolarAngle = Math.PI * 0.62;
      this.controls.enablePan = false;
      this.controls.target.set(0, 0.05, 0);
      this.controls.addEventListener('change', this._onControlsChange);
      this.controls.update();
    } else {
      this.controls = null;
      this.camera.lookAt(0, 0.05, 0);
    }
  }

  _buildCharacter() {
    this.creature = createBlobCreature(this.controller);
    this.scene.add(this.creature.root);
    // The camera is fitted to THIS character's real bounds (skin + the longest fur),
    // not to a hardcoded distance. `boundingSphere` is the skin; the coat is added from
    // the config every time the fur length changes.
    this.creature.bodyGeometry.computeBoundingSphere();
    this._bodySphere = {
      center: this.creature.bodyGeometry.boundingSphere.center.clone(),
      radius: this.creature.bodyGeometry.boundingSphere.radius,
    };
    this._framedLength = this.config.fur.length;

    this.indicators = createStateIndicators(this.controller);
    this.creature.orientationRoot.add(this.indicators.root);

    this.physics = createGPUFurPhysics(this.renderer);
    this._gpuFur = this.config.render.quality === 'high' && this.physics.isGPGPUActive;

    this.fur = createGPUFurSystem(this.creature.bodyGeometry, {
      furLength: this.config.fur.length,
      furDensity: this.config.fur.density,
      clumping: this.config.fur.clumping,
      curliness: this.config.fur.curliness,
      baseColor: this.config.palette.base,
      tipColor: this.config.palette.tip,
      roughness: this.config.fur.roughness,
      specular: this.config.fur.specular,
      lightIntensity: 1.35,
      rimIntensity: 1.45,
      windStrength: this.config.motion.wind,
      gpuFurEnabled: this._gpuFur,
    });
    this.creature.motionRoot.add(this.fur.shellMesh);
    this.creature.motionRoot.add(this.fur.strandMesh);
  }

  _buildObservers() {
    this._resize = () => this.resize();
    if (typeof ResizeObserver === 'function') {
      this._resizeObserver = new ResizeObserver(this._resize);
      this._resizeObserver.observe(this.host);
    }
    if (!this._alwaysRender && typeof IntersectionObserver === 'function') {
      this._intersectionObserver = new IntersectionObserver(([entry]) => {
        this._visible = Boolean(entry && entry.isIntersecting);
        this._syncMotionMode();
      }, { threshold: 0.01 });
      this._intersectionObserver.observe(this.host);
    }
    document.addEventListener('visibilitychange', this._onVisibility);
    if (this._motionQuery.addEventListener) this._motionQuery.addEventListener('change', this._onMotionPref);
    else if (this._motionQuery.addListener) this._motionQuery.addListener(this._onMotionPref);
    this.resize();
  }

  // ── Public surface ──────────────────────────────────────────────────────────

  /** Applies a config (draft or saved). Writes uniforms; never rebuilds geometry. */
  applyConfig(config, { refresh = false } = {}) {
    if (this._disposed) return;
    const next = normalizeConfig(config);
    this.config = next;

    const uniforms = this.fur.sharedUniforms;
    uniforms.uFurLength.value = next.fur.length;
    uniforms.uClumping.value = next.fur.clumping;
    uniforms.uCurliness.value = next.fur.curliness;
    uniforms.uRoughness.value = next.fur.roughness;
    uniforms.uSpecular.value = next.fur.specular;
    uniforms.uWindStrength.value = next.motion.wind;
    this.fur.updateDensity(next.fur.density);
    this._applyDetail();

    this._colors.base.set(next.palette.base);
    this._colors.tip.set(next.palette.tip);
    this._colors.accent.set(next.palette.accent);
    this.creature.skinMaterial.color.copy(this._colors.base).multiplyScalar(0.55);
    uniforms.uBaseColor.value.copy(this._colors.base);
    uniforms.uTipColor.value.copy(this._colors.tip);

    this.controller.setAnimationSpeed(next.motion.speed);
    this.controller.setAnimationIntensity(next.motion.intensity);

    // Longer fur is a bigger silhouette: re-fit the camera when the coat grows.
    if (this._framedLength !== next.fur.length) {
      this._framedLength = next.fur.length;
      this._frameCamera();
    }

    if (this.quality !== next.render.quality || refresh) {
      this.quality = next.render.quality;
      const wantGpu = next.render.quality === 'high' && this.physics.isGPGPUActive;
      this._gpuFur = wantGpu;
      this.fur.setGPUFurEnabled(wantGpu);
      this.renderer.shadowMap.enabled = next.render.quality === 'high';
      this._applyDetail();
    }

    this._applyStateColors(this.controller.getState());
    // A config edit can switch reduced-motion on or off; the loop follows it.
    this._syncMotionMode();
    if (this._stillMode()) this.renderStill();
  }

  /**
   * Applies the shell/strand sampling for the current size (or the library's full
   * budget in high-fidelity mode). Never changes an appearance value.
   */
  _applyDetail() {
    if (!this.fur) return;
    const density = this.config.fur.density;
    const uniforms = this.fur.sharedUniforms;
    if (this._gpuFur) {
      const shellGeometry = this.fur.shellMesh.geometry;
      shellGeometry.instanceCount = 64;
      uniforms.uShellCountScale.value = 1;
      this.fur.strandMesh.geometry.instanceCount = Math.floor(60000 * density);
      return;
    }
    const width = this._width || this.host.clientWidth || 0;
    const tier = DETAIL_TIERS.find((candidate) => width < candidate.maxWidth) || DETAIL_TIERS[DETAIL_TIERS.length - 1];
    const shellGeometry = this.fur.shellMesh.geometry;
    shellGeometry.instanceCount = tier.shells;
    // The supplied layers are indexed over 64; the scale maps this tier onto the same
    // 0…1 fur length, so fewer layers never means a shorter coat.
    uniforms.uShellCountScale.value = 64 / tier.shells;
    this.fur.strandMesh.geometry.instanceCount = Math.floor(tier.strands * density);
  }

  /** The detail tier currently sampling the character (diagnostics). */
  get detail() {
    if (this._gpuFur) return { shells: 64, strands: 60000, gpu: true };
    const width = this._width || this.host.clientWidth || 0;
    const tier = DETAIL_TIERS.find((candidate) => width < candidate.maxWidth) || DETAIL_TIERS[DETAIL_TIERS.length - 1];
    return { shells: tier.shells, strands: this.fur ? this.fur.strandMesh.geometry.instanceCount : 0, gpu: false };
  }

  /** The quality actually in use after the renderer's own capability check. */
  get effectiveQuality() {
    return this._gpuFur ? 'high' : 'light';
  }

  /** True when the requested GPU fur could not be enabled on this machine. */
  get gpuFurUnavailable() {
    return this.config.render.quality === 'high' && !this._gpuFur;
  }

  /** Feeds one KAI2 state (or avatar state) through the transition gate. */
  setState(runtimeState, options = {}) {
    if (this._disposed) return { state: this.controller.getState(), changed: false };
    const result = this.gate.next(runtimeState, options);
    if (result.changed) {
      this.controller.setState(result.state, { force: Boolean(options.replay) });
      this._applyStateColors(result.state);
      if (result.shot === 'success') this.indicators.triggerSuccess();
      if (result.shot === 'error') this.indicators.triggerError();
      if (this._stillMode()) this.renderStill();
    }
    return result;
  }

  /**
   * A one-shot error reaction that does NOT claim the persistent error state (used when
   * a tool really failed while the turn itself is still running). Ends by itself.
   */
  flashError() {
    if (this._disposed) return;
    this.controller.playAction(KAI_ACTIONS.ERROR_RECOIL, { priority: 100, force: true });
    this.indicators.triggerError();
    if (this._stillMode()) this.renderStill();
  }

  /** Plays one of the character's own one-shot actions. Never touches app state. */
  previewAction(name) {
    if (this._disposed) return false;
    const actions = Object.values(KAI_ACTIONS);
    if (!actions.includes(name)) return false;
    return this.controller.playAction(name, { priority: 95, force: true });
  }

  /** The state the character is visibly in. */
  getState() {
    return this.controller.getState();
  }

  /** Looks toward a normalized direction (x right, y up, both in [-1, 1]). */
  setGaze(x, y) {
    if (this._disposed) return;
    this.gaze.set(clamp(x, -1, 1), clamp(y, -1, 1));
    if (this._stillMode()) this.renderStill();
  }

  /** A localized boop at the surface facing the camera. */
  boop() {
    if (this._disposed) return;
    this._triggerHit(new THREE.Vector3(0, 0.1, 0.98), new THREE.Vector3(0, 0.1, 0.98));
    this.controller.playAction(KAI_ACTIONS.BOOP_REACTION, { priority: 85, force: true });
    if (this._stillMode()) this.renderStill();
  }

  resetView() {
    if (this._disposed) return;
    if (this.controls) {
      // Damping would keep the drag's momentum and stop short of the framed view;
      // one undamped update applies the reset and clears the accumulated deltas.
      const damping = this.controls.enableDamping;
      this.controls.enableDamping = false;
      // First update with damping off consumes the residual momentum and zeroes it;
      // then the framing is applied on a clean control state.
      this.controls.update();
      this._frameCamera();
      this.controls.enableDamping = damping;
    } else {
      this._frameCamera();
    }
    if (this._stillMode()) this.renderStill();
  }

  resize() {
    if (this._disposed) return;
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    const dpr = this._fixedDpr || Math.min(2, window.devicePixelRatio || 1);
    if (width === this._width && height === this._height && dpr === this._dpr) return;
    this._width = width;
    this._height = height;
    this._dpr = dpr;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this._applyDetail();
    this._frameCamera();
    this.renderStill();
  }

  /** Paints ONE settled frame (used by reduced-motion mode and layout changes). */
  renderStill() {
    if (this._disposed || this._stillRendering) return;
    this._stillRendering = true;
    try {
      for (let i = 0; i < 40; i++) this._step(1 / 60, true);
      this._draw();
    } finally {
      this._stillRendering = false;
    this._accentNow = 0;
    }
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._stopLoop();
    document.removeEventListener('visibilitychange', this._onVisibility);
    if (this._motionQuery.removeEventListener) this._motionQuery.removeEventListener('change', this._onMotionPref);
    else if (this._motionQuery.removeListener) this._motionQuery.removeListener(this._onMotionPref);
    this._resizeObserver?.disconnect();
    this._intersectionObserver?.disconnect();
    this._detachPointer();
    if (this.controls) {
      this.controls.removeEventListener('change', this._onControlsChange);
      this.controls.dispose();
      this.controls = null;
    }
    if (this.scene) {
      this.scene.traverse((object) => {
        if (object.geometry) object.geometry.dispose();
        if (object.material) {
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          for (const material of materials) {
            for (const value of Object.values(material)) {
              if (value && value.isTexture) value.dispose();
            }
            material.dispose();
          }
        }
      });
      this.scene.clear();
    }
    if (this.renderer) {
      this.renderer.dispose();
      try {
        this.renderer.forceContextLoss();
      } catch {
        // A context already lost is fine.
      }
      this.renderer.domElement.remove();
      this.renderer = null;
    }
  }

  // ── Motion mode ─────────────────────────────────────────────────────────────

  _stillMode() {
    return this.config.motion.reducedMotion || this._motionQuery.matches;
  }

  /**
   * Stops or restarts painting without discarding the renderer (used by the welcome
   * surface while it is faded out: an invisible character must not cost frames).
   */
  setPaused(paused) {
    if (this._disposed) return;
    this._paused = Boolean(paused);
    this._syncMotionMode();
  }

  get paused() {
    return this._paused;
  }

  _syncMotionMode() {
    if (this._disposed) return;
    if (this._paused || this._stillMode() || !this._visible || document.hidden) {
      this._stopLoop();
      if (!this._paused && this._stillMode() && this._visible && !document.hidden) this.renderStill();
      return;
    }
    this._startLoop();
  }

  _startLoop() {
    if (this._disposed || this._running) return;
    this._running = true;
    this._lastFrame = performance.now();
    this._raf = requestAnimationFrame(this._tick);
  }

  _stopLoop() {
    this._running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
  }

  _tick = (now) => {
    if (this._disposed || !this._running) return;
    this._raf = requestAnimationFrame(this._tick);
    if (document.hidden || !this._visible) {
      this._lastFrame = now;
      return;
    }
    const since = now - this._lastFrame;
    if (since < this._minFrameMs - 0.5) return;
    this._lastFrame = now;
    const dt = Math.min(0.033, since / 1000);
    if (dt <= 0) return;
    this._step(dt, false);
    this._draw();
  };

  // ── Simulation ──────────────────────────────────────────────────────────────

  _step(dt, still) {
    this._elapsed += dt;
    if (this.controls) this.controls.update();

    this._shockwave = this._decay(this._shockwave, dt, 2.8);
    if (this._hitStrength > 0.001) {
      this._hitTime += dt;
      this._hitStrength = this._decay(this._hitStrength, dt, 3.2);
    } else {
      this._hitStrength = 0;
      this._hitTime = 0;
    }
    this._pointerVelocity.multiplyScalar(Math.exp(-dt * 12));

    this.creature.update(dt, this.gaze, this.camera.position, false, still || this._stillMode());
    this.indicators.update(dt, this.controller.currentMotion, this.camera);
    this._updateColors();

    const motion = this.controller.currentMotion;
    const pointerActive = this._pointerDown || (this._pointerOver && this._pointerVelocity.lengthSq() > POINTER_ACTIVE);
    const activeShockwave = Math.max(this._shockwave, motion ? motion.furPulse : 0);
    const uniforms = this.fur.sharedUniforms;

    if (this._gpuFur) {
      uniforms.uPhysicsTex.value = this.physics.step({
        time: this._elapsed,
        dt,
        windStrength: this.config.motion.wind,
        creatureVelocity: this.creature.animState.velocity,
        creatureAngularVel: this.creature.animState.angularVelocity,
        pointerLocalPos: this._pointerLocal,
        pointerVelocity: this._pointerVelocity,
        pointerActive,
        boopShockwave: activeShockwave,
        hitOrigin: this._hitOrigin,
        hitOriginNormal: this._hitNormal,
        hitStrength: this._hitStrength,
        hitTime: this._hitTime,
      });
    } else {
      this._stepAnalyticalInertia(dt, pointerActive);
      uniforms.uPhysicsTex.value = this.physics.fallbackTexture;
    }

    uniforms.uTime.value = this._elapsed;
    uniforms.uPointerLocalPos.value.copy(this._pointerLocal);
    uniforms.uPointerVelocity.value.copy(this._pointerVelocity);
    uniforms.uPointerActive.value = pointerActive ? 1 : 0;
    uniforms.uWebGLInertia.value.copy(this._webglInertia);
    uniforms.uBoopShockwave.value = activeShockwave;
    uniforms.uHitOrigin.value.copy(this._hitOrigin);
    uniforms.uHitOriginNormal.value.copy(this._hitNormal);
    uniforms.uHitStrength.value = this._hitStrength;
    uniforms.uHitTime.value = this._hitTime;
  }

  _stepAnalyticalInertia(dt, pointerActive) {
    this._force.set(0, -0.32, 0);
    this._force.addScaledVector(this.creature.animState.velocity, -1.65);
    if (pointerActive) this._force.addScaledVector(this._pointerVelocity, 0.85);
    this._force.addScaledVector(this._webglInertia, -24);

    const speed = this.creature.animState.velocity.length();
    const angular = this.creature.animState.angularVelocity.length();
    const totalMotion = speed + angular * 0.55;
    let damping = 5.2 + totalMotion * 4.5;
    const displacement = this._webglInertia.length();
    const velocity = this._webglVelocity.length();
    if (totalMotion < 0.42 && (displacement > 0.003 || velocity > 0.005)) {
      damping += (1 - totalMotion / 0.42) * (10 + displacement * 12 + velocity * 3.5);
    }
    this._webglVelocity.addScaledVector(this._force, dt);
    this._webglVelocity.multiplyScalar(Math.exp(-damping * dt));
    this._webglInertia.addScaledVector(this._webglVelocity, dt);
    if (this._webglInertia.lengthSq() < 0.00002 && this._webglVelocity.lengthSq() < 0.00004) {
      this._webglInertia.set(0, 0, 0);
      this._webglVelocity.set(0, 0, 0);
    } else if (this._webglInertia.lengthSq() > 0.64) {
      this._webglInertia.normalize().multiplyScalar(0.8);
    }
  }

  _decay(value, dt, rate) {
    return value > 0.001 ? value * Math.exp(-dt * rate) : 0;
  }

  /** The saved palette, blended with the CURRENT state's accent (never overwritten). */
  _updateColors() {
    const strength = this._accentNow;
    const uniforms = this.fur.sharedUniforms;
    const palette = this._stateColors;
    // Two scratch colours on purpose: reusing one would make `base` alias `tip`.
    const base = this._scratch.copy(this._colors.base).lerp(palette.base, strength * 0.35);
    const tip = this._scratchTip.copy(this._colors.tip).lerp(palette.tip, strength);
    uniforms.uBaseColor.value.copy(base);
    uniforms.uTipColor.value.copy(tip);
    this.creature.skinMaterial.color.copy(base).multiplyScalar(0.55);
    this.rimLight.color.copy(this._colors.accent).lerp(palette.rim, Math.min(1, strength + 0.15));
    uniforms.uRimLightColor.value.copy(this.rimLight.color);
  }

  _applyStateColors(state) {
    const avatar = avatarStateFor(state) || 'idle';
    const palette = this.controller.getStatePalette(avatar);
    this._stateColors.base.set(palette.baseColor);
    this._stateColors.tip.set(palette.tipColor);
    this._stateColors.rim.set(palette.rimColor);
    this._accentNow = (STATE_ACCENT[avatar] ?? 0) * this.config.motion.accentStrength;
    this._updateColors();
  }

  _draw() {
    if (this._disposed || !this.renderer) return;
    this.renderer.render(this.scene, this.camera);
    this._frames += 1;
  }

  /**
   * Frames the whole character, at any aspect and any fur length.
   *
   * The old version used a fixed distance and only zoomed out for narrow boxes; with
   * the fur grown (0.43 or more) the coat reached the left and right edges — the
   * character was cropped. The distance is now derived from the body's bounding
   * sphere plus the fur growth, fitted to the NARROWER field of view, with a margin.
   */
  _frameCamera() {
    if (!this.camera || !this._bodySphere) return;
    const aspect = Math.max(0.1, this._width / Math.max(1, this._height));
    const vFov = (this.camera.fov * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
    const radius = (this._bodySphere.radius + this.config.fur.length * FUR_FRAME_GROWTH) * FRAME_MARGIN;
    const distance = radius / Math.sin(Math.min(vFov, hFov) / 2);
    const centerY = this._bodySphere.center.y;
    if (this.controls) {
      this.controls.target.set(0, centerY, 0);
      this.camera.position.set(0, centerY, distance);
      this.controls.minDistance = distance * 0.5;
      this.controls.maxDistance = distance * 2.4;
      this.controls.update();
    } else {
      this.camera.position.set(0, centerY, distance);
      this.camera.lookAt(0, centerY, 0);
    }
    this.camera.updateProjectionMatrix();
  }

  // ── Interaction (preview only) ──────────────────────────────────────────────

  _bindPointer() {
    if (!this.interactive) return;
    this._onPointerMove = (event) => this._handlePointerMove(event);
    this._onPointerDown = (event) => this._handlePointerDown(event);
    this._onPointerUp = (event) => this._handlePointerUp(event);
    this._onPointerLeave = () => {
      this._pointerOver = false;
      this._pointerVelocity.multiplyScalar(0.7);
      if (!this._pointerDown) this.renderer.domElement.style.cursor = 'default';
    };
    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointermove', this._onPointerMove);
    canvas.addEventListener('pointerdown', this._onPointerDown);
    canvas.addEventListener('pointerup', this._onPointerUp);
    canvas.addEventListener('pointercancel', this._onPointerUp);
    canvas.addEventListener('pointerleave', this._onPointerLeave);
    canvas.style.cursor = 'grab';
  }

  _detachPointer() {
    if (!this.interactive || !this.renderer) return;
    const canvas = this.renderer.domElement;
    canvas.removeEventListener('pointermove', this._onPointerMove);
    canvas.removeEventListener('pointerdown', this._onPointerDown);
    canvas.removeEventListener('pointerup', this._onPointerUp);
    canvas.removeEventListener('pointercancel', this._onPointerUp);
    canvas.removeEventListener('pointerleave', this._onPointerLeave);
  }

  _handlePointerMove(event) {
    if (this._disposed) return;
    const box = this.renderer.domElement.getBoundingClientRect();
    this._ndc.x = ((event.clientX - box.left) / Math.max(1, box.width)) * 2 - 1;
    this._ndc.y = -(((event.clientY - box.top) / Math.max(1, box.height)) * 2 - 1);
    this.gaze.copy(this._ndc);
    this._raycaster.setFromCamera(this._ndc, this.camera);
    const hits = this._raycaster.intersectObject(this.creature.bodyMesh, false);
    if (hits.length) {
      this._pointerPrevious.copy(this._pointerLocal);
      this._pointerLocal.copy(hits[0].point);
      this.creature.root.worldToLocal(this._pointerLocal);
      if (this._pointerDown || this._pointerOver) {
        this._pointerVelocity.x += ((this._pointerLocal.x - this._pointerPrevious.x) * 36 - this._pointerVelocity.x) * 0.45;
        this._pointerVelocity.y += ((this._pointerLocal.y - this._pointerPrevious.y) * 36 - this._pointerVelocity.y) * 0.45;
        this._pointerVelocity.z += ((this._pointerLocal.z - this._pointerPrevious.z) * 36 - this._pointerVelocity.z) * 0.45;
      }
      this._pointerOver = true;
      this.renderer.domElement.style.cursor = this._pointerDown ? 'grabbing' : 'pointer';
    } else {
      this._pointerOver = false;
      this._pointerVelocity.multiplyScalar(0.7);
      if (!this._pointerDown) this.renderer.domElement.style.cursor = 'grab';
    }
    if (this._stillMode()) this.renderStill();
  }

  _handlePointerDown(event) {
    if (this._disposed || !this.renderer) return;
    const box = this.renderer.domElement.getBoundingClientRect();
    this._ndc.x = ((event.clientX - box.left) / Math.max(1, box.width)) * 2 - 1;
    this._ndc.y = -(((event.clientY - box.top) / Math.max(1, box.height)) * 2 - 1);
    this._raycaster.setFromCamera(this._ndc, this.camera);
    const hits = this._raycaster.intersectObject(this.creature.bodyMesh, false);
    if (!hits.length) return;
    this._pointerDown = true;
    this._pointerDownAt = performance.now();
    this._pointerDownPos = { x: event.clientX, y: event.clientY };
    if (this.controls) this.controls.enabled = false;
    this._pointerLocal.copy(hits[0].point);
    this.creature.root.worldToLocal(this._pointerLocal);
    const local = hits[0].point.clone();
    this.creature.bodyMesh.worldToLocal(local);
    const normal = hits[0].face && hits[0].face.normal ? hits[0].face.normal.clone() : local.clone().normalize();
    this._hitOrigin.copy(local);
    this._hitNormal.copy(normal);
    this._pointerVelocity.set(0, 0, 0);
  }

  _handlePointerUp(event) {
    if (this._disposed) return;
    if (this.controls) this.controls.enabled = true;
    if (!this._pointerDown) return;
    this._pointerDown = false;
    const distance = Math.hypot(event.clientX - this._pointerDownPos.x, event.clientY - this._pointerDownPos.y);
    if (distance < 8 && performance.now() - this._pointerDownAt < 350) {
      this._triggerHit(this._hitOrigin, this._hitNormal);
      this.controller.playAction(KAI_ACTIONS.BOOP_REACTION, { priority: 85, force: true });
      if (this._stillMode()) this.renderStill();
    }
  }

  _triggerHit(origin, normal) {
    this._hitOrigin.copy(origin);
    this._hitNormal.copy(normal);
    this._hitStrength = 1;
    this._hitTime = 0;
    this._shockwave = 1;
    this.creature.triggerBoop(origin);
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
