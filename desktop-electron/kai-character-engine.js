/* KAI2 — KAI's real character engine, bundled for a page with no bundler.
 *
 * Generated, do not hand-edit. Source of truth: the KAI app's character module
 * (`C:\tmp\kai-exec\app\src\character\`, which is NOT modified — this file only
 * compiles it), re-exported by the entry in this repo at
 * `scripts/kai-character-entry.ts`, and built with the esbuild that ships with the
 * KAI app's vite dependency:
 *
 *   cd C:\tmp\kai-exec\app
 *   node node_modules/esbuild/bin/esbuild \
 *     C:/Users/DELL/source/kai2-desktop/scripts/kai-character-entry.ts \
 *     --bundle --format=iife --global-name=KaiCharacter --target=chrome120 \
 *     --outfile=C:/tmp/kai2-char-build/kai-character-engine.js
 *
 * then this header is put in front of the result and it is moved here.
 *
 * It exposes `KaiCharacter`: KaiEngine (setState / setAccessory / setSkin / greet /
 * blink / look), mountCharacterCanvas (the shared-RAF canvas bridge: mount, size,
 * dispose), KaiStates, KAI_STATE_POSE, poseForState, BOT_STATES, STATE_SOUND and
 * Sound. The only consumer is `ghost-thinking.js`.
 */
var KaiCharacter = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // ../../../Users/DELL/source/kai2-desktop/scripts/kai-character-entry.ts
  var kai_character_entry_exports = {};
  __export(kai_character_entry_exports, {
    BOT_STATES: () => BOT_STATES,
    Ease: () => Ease,
    KAI_STATE_POSE: () => KAI_STATE_POSE,
    KaiEngine: () => KaiEngine,
    KaiStates: () => KaiStates,
    STATE_SOUND: () => STATE_SOUND,
    Sound: () => Sound,
    applyAppearanceToCanvas: () => applyAppearanceToCanvas,
    clamp: () => clamp2,
    hexToRGB: () => hexToRGB,
    lerp: () => lerp,
    mountCharacterCanvas: () => mountCharacterCanvas,
    poseForState: () => poseForState
  });

  // src/core/sound.ts
  var RECIPES = {
    peek: { f0: 720, f1: 1180, dur: 0.075, wave: "sine", gain: 0.5 },
    open: { f0: 300, f1: 760, dur: 0.16, wave: "triangle", gain: 0.5, lp: 3200 },
    close: { f0: 660, f1: 250, dur: 0.15, wave: "triangle", gain: 0.46, lp: 2600 },
    hover: { f0: 1420, f1: 1560, dur: 0.035, wave: "sine", gain: 0.16 },
    blip: { f0: 900, f1: 900, dur: 0.05, wave: "square", gain: 0.18, lp: 2400 },
    slap: { f0: 220, f1: 90, dur: 0.11, wave: "square", gain: 0.5, noise: 0.6, lp: 1400 },
    annoyed: { f0: 320, f1: 240, dur: 0.2, wave: "sawtooth", gain: 0.3, lp: 1600, voices: 2 },
    dizzy: { f0: 520, f1: 120, dur: 0.5, wave: "triangle", gain: 0.34, voices: 2 },
    greet: {
      f0: 520,
      f1: 900,
      dur: 0.22,
      wave: "sine",
      gain: 0.46,
      tail: [0.1, 1320, 0.26, 0.3]
    },
    work: { f0: 240, f1: 300, dur: 0.1, wave: "sawtooth", gain: 0.24, lp: 1500 },
    finish: {
      f0: 780,
      f1: 1180,
      dur: 0.16,
      wave: "sine",
      gain: 0.44,
      tail: [0.1, 1560, 0.3, 0.3]
    },
    error: { f0: 340, f1: 150, dur: 0.3, wave: "sawtooth", gain: 0.4, voices: 2, lp: 1800 },
    approval: {
      f0: 620,
      f1: 620,
      dur: 0.1,
      wave: "square",
      gain: 0.32,
      lp: 2600,
      tail: [0.13, 840, 0.16, 0.3]
    },
    question: { f0: 640, f1: 1080, dur: 0.18, wave: "triangle", gain: 0.36 },
    approve: {
      f0: 700,
      f1: 1050,
      dur: 0.11,
      wave: "sine",
      gain: 0.42,
      tail: [0.07, 1400, 0.18, 0.26]
    },
    gulp: { f0: 420, f1: 120, dur: 0.22, wave: "sine", gain: 0.42, lp: 900 },
    tick: { f0: 1800, f1: 1800, dur: 0.02, wave: "square", gain: 0.14, lp: 5e3 },
    send: { f0: 560, f1: 980, dur: 0.13, wave: "triangle", gain: 0.38 },
    love: {
      f0: 880,
      f1: 1320,
      dur: 0.2,
      wave: "sine",
      gain: 0.38,
      tail: [0.12, 1760, 0.3, 0.24]
    },
    pop: { f0: 1100, f1: 520, dur: 0.06, wave: "sine", gain: 0.34 },
    proud: {
      f0: 620,
      f1: 930,
      dur: 0.14,
      wave: "sine",
      gain: 0.36,
      tail: [0.09, 1240, 0.34, 0.3]
    },
    wink: { f0: 1200, f1: 700, dur: 0.07, wave: "square", gain: 0.2, lp: 3400 },
    yawn: { f0: 500, f1: 200, dur: 0.55, wave: "sine", gain: 0.3, lp: 1200 },
    attach: { f0: 380, f1: 620, dur: 0.12, wave: "triangle", gain: 0.36, noise: 0.25 },
    think: { f0: 440, f1: 470, dur: 0.26, wave: "sine", gain: 0.2, voices: 2 },
    search: { f0: 900, f1: 520, dur: 0.22, wave: "triangle", gain: 0.24 },
    rate: { f0: 300, f1: 500, dur: 0.4, wave: "sawtooth", gain: 0.3, voices: 2, lp: 1500 },
    sleep: { f0: 300, f1: 170, dur: 0.6, wave: "sine", gain: 0.26, lp: 900 }
  };
  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }
  var SoundEngine = class {
    enabled = true;
    volume = 0.12;
    ctx = null;
    master = null;
    noise = null;
    loading = null;
    idleTimer = null;
    /** Creates the context and the shared noise buffer. Safe to call repeatedly. */
    preload() {
      if (this.loading) return this.loading;
      this.loading = (async () => {
        const Ctor = window.AudioContext ?? window.webkitAudioContext;
        if (!Ctor) return;
        const ctx = new Ctor();
        this.ctx = ctx;
        const master = ctx.createGain();
        master.gain.value = this.volume;
        master.connect(ctx.destination);
        this.master = master;
        const len = Math.max(1, Math.floor(ctx.sampleRate * 0.4));
        const buf = ctx.createBuffer(1, len, ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
        this.noise = buf;
      })();
      return this.loading;
    }
    /** WebView2 can hand us a suspended context; call after any user input. */
    resume() {
      if (this.idleTimer != null) {
        window.clearTimeout(this.idleTimer);
        this.idleTimer = null;
      }
      void this.ctx?.resume();
    }
    /**
     * Called when the island goes quiet. A running AudioContext keeps an audio
     * thread and its render quantum alive even with nothing playing, which shows
     * up as a steady trickle of CPU on a machine that is supposed to be idle.
     *
     * The delay covers the tail of whatever just played — suspending mid-sound
     * would clip it — and `play()` resumes the context on its own.
     */
    idle() {
      if (!this.ctx || this.ctx.state !== "running" || this.idleTimer != null) return;
      this.idleTimer = window.setTimeout(() => {
        this.idleTimer = null;
        void this.ctx?.suspend();
      }, 1500);
    }
    setVolume(v) {
      this.volume = clamp(v, 0, 0.2);
      if (this.master) this.master.gain.value = this.volume;
    }
    setEnabled(on) {
      this.enabled = on;
    }
    /** Plays a named KAI voice. Unknown names are ignored, never thrown. */
    play(name) {
      if (!this.enabled) return;
      const recipe = RECIPES[name];
      const ctx = this.ctx;
      const master = this.master;
      if (!recipe || !ctx || !master) return;
      if (this.idleTimer != null) {
        window.clearTimeout(this.idleTimer);
        this.idleTimer = null;
      }
      if (ctx.state === "suspended") void ctx.resume();
      const t0 = ctx.currentTime;
      const voices = recipe.voices ?? 1;
      for (let v = 0; v < voices; v++) {
        const detune = voices > 1 ? 1 + (v - (voices - 1) / 2) * 0.011 : 1;
        this.tone(ctx, master, recipe, t0, recipe.f0 * detune, recipe.f1 * detune, recipe.gain / voices);
      }
      if (recipe.tail) {
        const [at, f, dur, g] = recipe.tail;
        this.tone(ctx, master, { ...recipe, dur, noise: 0, voices: 1 }, t0 + at, f, f, g);
      }
      if (recipe.noise) this.noiseBurst(ctx, master, recipe, t0);
    }
    tone(ctx, master, recipe, at, f0, f1, gain) {
      const osc = ctx.createOscillator();
      osc.type = recipe.wave;
      osc.frequency.setValueAtTime(Math.max(1, f0), at);
      if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), at + recipe.dur);
      const env = ctx.createGain();
      env.gain.setValueAtTime(1e-4, at);
      env.gain.exponentialRampToValueAtTime(
        Math.max(2e-4, gain),
        at + Math.min(0.012, recipe.dur * 0.2)
      );
      env.gain.exponentialRampToValueAtTime(1e-4, at + recipe.dur);
      let node = osc;
      if (recipe.lp) {
        const lp = ctx.createBiquadFilter();
        lp.type = "lowpass";
        lp.frequency.value = recipe.lp;
        node.connect(lp);
        node = lp;
      }
      node.connect(env);
      env.connect(master);
      osc.start(at);
      osc.stop(at + recipe.dur + 0.02);
    }
    noiseBurst(ctx, master, recipe, at) {
      if (!this.noise) return;
      const dur = Math.min(0.09, recipe.dur);
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      const env = ctx.createGain();
      env.gain.setValueAtTime(Math.max(2e-4, recipe.gain * (recipe.noise ?? 0) * 0.6), at);
      env.gain.exponentialRampToValueAtTime(1e-4, at + dur);
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = recipe.lp ?? 3e3;
      src.connect(lp);
      lp.connect(env);
      env.connect(master);
      src.start(at);
      src.stop(at + dur + 0.01);
    }
  };
  var Sound = new SoundEngine();

  // src/character/types.ts
  var KaiStates = {
    IDLE: "idle",
    LISTENING: "listening",
    THINKING: "thinking",
    PLANNING: "planning",
    RESEARCHING: "researching",
    BROWSING: "browsing",
    CODING: "coding",
    WORKING: "working",
    USING_TOOL: "using_tool",
    USING_CLI: "using_cli",
    USING_BROWSER: "using_browser",
    USING_CUA: "using_cua",
    DELEGATING: "delegating",
    MULTI_AGENT: "multi_agent",
    WAITING: "waiting",
    WAITING_APPROVAL: "waiting_approval",
    LEARNING: "learning",
    BUILDING_SKILL: "building_skill",
    RECOVERING: "recovering",
    NEEDS_USER: "needs_user",
    SUCCESS: "success",
    ERROR: "error",
    OFFLINE: "offline"
  };
  var KAI_STATE_POSE_BASE = {
    idle: "idle",
    listening: "listening",
    thinking: "thinking",
    planning: "planning",
    // The widened runtime vocabulary → the CLOSEST EXISTING source pose (never a
    // new pose). Several states share a source pose where the source has no
    // finer-grained face; the sharing is deliberate and listed in the table above.
    researching: "scan",
    // NM 33 — sideL/sideglance sweep (searching)
    browsing: "toolcall",
    // NM 13 — determined→sideglance, a tool runs
    coding: "working",
    // NM 5  — determined/sideglance + Working chip (+ laptop)
    using_cli: "executing",
    // NM 12 — alias of working (running a command)
    using_browser: "scan",
    // NM 33 — a page sweep is the same gaze as scanning
    using_cua: "toolcall",
    // NM 13 — a tool call drives the machine
    multi_agent: "multiagent",
    // NM 17 — proc1→proc2, delegating through workers
    learning: "idea",
    // NM 32 — intense→surprised→happy (eureka)
    building_skill: "executing",
    // NM 12 — focused construction
    recovering: "verifying",
    // NM 14 — skeptical→sideglance→skeptical (re-checking)
    working: "working",
    using_tool: "toolcall",
    delegating: "multiagent",
    waiting: "waiting",
    waiting_approval: "needsuser",
    // "KAI needs you" shares the attentive "asks for help" face; the structured
    // reason is named by the island's attention surface, not by the orb.
    needs_user: "needsuser",
    success: "success",
    error: "error",
    offline: "sleeping",
    // Legacy BotStateName values.
    searching: "scan",
    approval: "needsuser",
    question: "confirmation",
    finished: "success",
    ratelimit: "warning",
    sleeping: "sleeping",
    dizzy: "rolling"
  };
  var KAI_STATE_POSE = {
    ...KAI_STATE_POSE_BASE,
    ...Object.fromEntries(Object.entries(KAI_STATE_POSE_BASE).map(([k, v]) => [k.toUpperCase(), v]))
  };
  function poseForState(state) {
    return KAI_STATE_POSE[state] ?? KAI_STATE_POSE[state.toLowerCase()] ?? "idle";
  }
  var C = {
    idle: [0.639, 0.714, 0.835],
    working: [0.231, 0.62, 1],
    thinking: [0.545, 0.361, 0.965],
    searching: [0.388, 0.396, 0.949],
    approval: [0.961, 0.647, 0.141],
    question: [0.133, 0.827, 0.933],
    error: [0.957, 0.314, 0.369],
    finished: [0.204, 0.831, 0.6],
    ratelimit: [0.984, 0.573, 0.235],
    sleeping: [0.475, 0.522, 0.612],
    dizzy: [0.957, 0.447, 0.714]
  };
  var base = {
    bounces: false,
    scans: false,
    breathes: false,
    zz: false,
    sweat: false,
    look: null,
    tilt: 0,
    orbitSpeed: 0.06
  };
  var BOT_STATES = {
    idle: { ...base, color: C.idle, tint: 0.1, eye: "pill", badge: null },
    working: {
      ...base,
      color: C.working,
      tint: 0.72,
      eye: "pill",
      badge: { kind: "dots", color: C.working },
      orbitSpeed: 1.5
    },
    thinking: {
      ...base,
      color: C.thinking,
      tint: 0.72,
      eye: "pill",
      badge: { kind: "dots", color: C.thinking },
      look: [0.55, 0.55],
      orbitSpeed: 0.9
    },
    searching: {
      ...base,
      color: C.searching,
      tint: 0.72,
      eye: "pill",
      badge: { kind: "dots", color: C.searching },
      scans: true,
      orbitSpeed: 2.2
    },
    approval: {
      ...base,
      color: C.approval,
      tint: 0.78,
      eye: "wide",
      badge: { kind: "bang", color: C.approval },
      bounces: true,
      orbitSpeed: 0.4
    },
    question: {
      ...base,
      color: C.question,
      tint: 0.75,
      eye: "pill",
      badge: { kind: "question", color: C.question },
      tilt: 0.17,
      orbitSpeed: 0.25
    },
    error: {
      ...base,
      color: C.error,
      tint: 0.78,
      eye: "flat",
      badge: { kind: "dot", color: C.error },
      orbitSpeed: 0
    },
    finished: {
      ...base,
      color: C.finished,
      tint: 0.35,
      eye: "happy",
      badge: { kind: "dot", color: C.finished },
      orbitSpeed: 0.9
    },
    ratelimit: {
      ...base,
      color: C.ratelimit,
      tint: 0.72,
      eye: "tired",
      badge: { kind: "dot", color: C.ratelimit },
      sweat: true,
      orbitSpeed: 0.15
    },
    sleeping: {
      ...base,
      color: C.sleeping,
      tint: 0.3,
      eye: "closed",
      badge: null,
      breathes: true,
      zz: true,
      orbitSpeed: 0.02
    },
    dizzy: {
      ...base,
      color: C.dizzy,
      tint: 0.7,
      eye: "spiral",
      badge: null,
      orbitSpeed: 5
    },
    // "KAI needs you": the same amber, wide-eyed, bouncing "asks for help" posture
    // as an approval — a human must look. The orb pose is `needsuser` (see the
    // state→pose table above); this entry gives the engine the matching colour,
    // badge and orbit speed so the face is not a colourless fallback.
    needs_user: {
      ...base,
      color: C.approval,
      tint: 0.78,
      eye: "wide",
      badge: { kind: "bang", color: C.approval },
      bounces: true,
      orbitSpeed: 0.4
    }
  };
  var STATE_SOUND = {
    working: "work",
    thinking: "think",
    searching: "search",
    approval: "approval",
    question: "question",
    error: "error",
    finished: "finish",
    ratelimit: "rate",
    sleeping: "sleep",
    dizzy: "dizzy"
  };
  var EMOTE_EYE = {
    love: "heart",
    surprised: "dot",
    proud: "star",
    wink: "wink",
    yawn: "tired",
    happy: "happy",
    annoyed: "line"
  };
  function hexToRGB(hex) {
    const h = hex.replace("#", "");
    const v = parseInt(h, 16);
    return [(v >> 16 & 255) / 255, (v >> 8 & 255) / 255, (v & 255) / 255];
  }

  // src/core/anim.ts
  var Ease = {
    out: (t) => 1 - Math.pow(1 - t, 3),
    inOut: (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2,
    back: (t) => {
      const c1 = 1.7;
      const c3 = c1 + 1;
      return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
    },
    lin: (t) => t,
    easeIn: (t) => t * t * t
  };
  var lerp = (a, b, t) => a + (b - a) * t;
  var clamp2 = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  function cubicBezier(x1, y1, x2, y2) {
    const cx = (t) => (1 - t) ** 2 * 3 * t * x1 + 3 * (1 - t) * t * t * x2 + t ** 3;
    const cy = (t) => (1 - t) ** 2 * 3 * t * y1 + 3 * (1 - t) * t * t * y2 + t ** 3;
    return (x) => {
      let lo = 0;
      let hi = 1;
      let t = x;
      for (let i = 0; i < 12; i++) {
        const v = cx(t);
        if (v < x) lo = t;
        else hi = t;
        t = (lo + hi) / 2;
      }
      return cy(t);
    };
  }
  var closeCurve = cubicBezier(0.45, 0, 0.2, 1);

  // src/character/orb.ts
  var EY = {
    calm: [1, 0.82, 0.82, 0, 1, 0, 0],
    relaxed: [1, 0.85, 0.85, 0, 1, 0, 3],
    attentive: [0.95, 1.15, 1.15, 0, 1, 0, -2],
    soft: [1.05, 0.7, 0.7, 0, 1, 0, 1],
    curious: [1.05, 1.08, 1.08, 0, 1.05, 0, -4],
    surprised: [1.15, 1.3, 1.3, 0, 1.05, 0, -2],
    small: [0.7, 0.6, 0.6, 0, 1, 0, 0],
    sleepy: [1.3, 0.08, 0.08, 0, 1, 0, 8],
    line: [1.5, 0.06, 0.06, 0, 1, 0, 0],
    sideL: [1, 0.95, 0.95, 0, 1, -16, 1],
    derpA: [1, 1.35, 0.55, 6, 1, 0, 0],
    derpB: [1, 0.55, 1.35, -6, 1, 0, 0],
    skeptical: [1, 0.6, 0.8, 5, 1, 0, 0],
    determined: [1, 0.72, 0.72, 8, 0.97, 0, -1],
    intense: [0.8, 0.62, 0.62, 0, 0.92, 0, -5],
    sideglance: [1, 0.95, 0.95, 0, 1, 16, 1],
    asym: [1, 0.58, 0.95, -4, 1, -8, -6],
    proc1: [0.55, 1.2, 0.95, 0, 1.05, 0, 0],
    proc2: [0.55, 0.95, 1.2, 0, 1.05, 0, 0],
    core: [0.6, 0.8, 0.8, 0, 0.65, 0, 0],
    happy: [1.12, 1.12, 1.12, 0, 1.05, 0, -2],
    sad: [1, 0.6, 0.6, 6, 1, 0, 8],
    blocked: [1, 0.65, 0.65, 3, 1, 0, 9]
  };
  var SC = {
    idle: [["calm", 3500], ["relaxed", 2500], ["soft", 2800], ["attentive", 1400], ["curious", 1500], ["calm", 3e3]],
    awake: [["relaxed", 150], ["attentive", 1100, { h: [1, 0], kick: -170 }], [">idle", 0]],
    listening: [["calm", 2600], ["attentive", 1500], ["soft", 2e3]],
    thinking: [["asym", 1500, { en: 0.1, sq: -0.01 }], ["intense", 2200, { en: 1, sq: -0.015 }], ["calm", 1100, { en: 0.4, pu: 1 }]],
    working: [["determined", 1100, { en: 0.6, h: [0.2, 0], sq: -0.01 }], ["determined", 900, { en: 0.3, h: [0, 0.2] }], ["sideglance", 700, { en: 0.5, h: [0.2, 0] }], ["determined", 1e3, { en: 0.6, h: [0, 0.2] }]],
    waiting: [["calm", 2400], ["sideglance", 1400], ["calm", 800], ["relaxed", 1300, { h: [0.2, 0.2] }]],
    success: [["happy", 1700, { h: [1, 1], kick: -200 }], ["calm", 700], [">idle", 0]],
    warning: [["skeptical", 1300, { pu: 1 }], ["asym", 2e3], ["skeptical", 1500]],
    error: [["small", 500], ["sad", 0, { ty: 6, pu: 1 }]],
    sleeping: [["sleepy", 0, { ty: 8 }]],
    toolcall: [["determined", 700], ["sideglance", 1300, { h: [0, 0.9] }], ["determined", 900]],
    verifying: [["skeptical", 1500, { en: 0.3 }], ["sideglance", 900], ["skeptical", 1200]],
    blocked: [["blocked", 0, { ty: 6 }]],
    needsuser: [["attentive", 1200, { h: [1, 0] }], ["attentive", 700, { h: [0.55, 0] }]],
    multiagent: [["proc1", 650, { en: 0.6 }], ["proc2", 650, { en: 0.3 }]],
    confirmation: [["attentive", 500, { ty: -5 }], ["calm", 500, { ty: 4 }], [">idle", 0]],
    boot: [["sleepy", 700], ["line", 320, { kick: -60 }], ["sleepy", 160], ["line", 260], ["calm", 240], ["surprised", 420, { kick: -170, h: [1, 1] }], ["calm", 500, { h: [0, 0] }], [">idle", 0]],
    cross: [["calm", 500], ["attentive", 1800, { cv: 1 }], ["calm", 700, { cv: 0.3 }], ["attentive", 1500, { cv: 1, h: [0.4, 0.4] }], ["calm", 600], [">idle", 0]],
    derp: [["soft", 500], ["derpA", 1800, { dg: 0.35 }], ["derpB", 1600, { dg: -0.35 }], ["calm", 500], [">idle", 0]],
    rolling: [["attentive", 400], ["calm", 2300, { ro: 1 }], ["surprised", 500, { kick: -120 }], ["calm", 400], [">idle", 0]],
    doze: [["soft", 600], ["sleepy", 1800], ["sleepy", 900, { ty: 7 }], ["surprised", 350, { kick: -190, h: [1, 1] }], ["calm", 500, { h: [0, 0] }], [">idle", 0]],
    doubletake: [["sideglance", 500], ["sideL", 420], ["sideglance", 300], ["surprised", 650, { kick: -120, h: [1, 0] }], ["calm", 500, { h: [0, 0] }], [">idle", 0]],
    idea: [["intense", 900, { en: 0.9 }], ["surprised", 700, { en: 1, pu: 1, kick: -150, h: [0, 1] }], ["happy", 900, { en: 0.4, h: [0, 1] }], [">idle", 0]],
    scan: [["sideL", 280], ["sideglance", 280], ["sideL", 240], ["sideglance", 240], ["determined", 900, { en: 0.5 }], ["calm", 500, { ty: -4 }], [">idle", 0]],
    cool: [["skeptical", 900], ["determined", 1400, { ty: -4 }], ["calm", 500], [">idle", 0]],
    funny: [["calm", 100]],
    jump: [["determined", 290], ["surprised", 1e3, { h: [1, 1] }], ["happy", 310, { h: [1, 1] }], ["calm", 0]],
    backflip: [["determined", 360], ["happy", 1240, { h: [0.3, 0.3] }], ["surprised", 400, { h: [1, 1] }], ["calm", 0, { h: [1, 1] }]],
    spin: [["determined", 500], ["surprised", 1750, { h: [1, 1] }], ["calm", 550, { ro: 1 }], ["calm", 0, { ro: 1 }]],
    fight: [["determined", 1100, { h: [1, 1], sq: -0.02 }], ["sideglance", 500, { h: [1, 1] }], ["determined", 900, { h: [1, 1], cv: 0.6, pu: 1 }], ["sideL", 500, { h: [1, 1] }]]
  };
  SC.planning = SC.thinking;
  SC.executing = SC.working;
  SC.done = SC.success;
  SC.frontflip = SC.backflip;
  var merge = (base2, over) => Object.assign({}, base2, over);
  var VN = {
    dp: 0.2,
    ta: 0,
    tc: [79, 180, 255],
    bt: 0,
    dm: 0,
    et: [255, 255, 255],
    eb: [169, 236, 255],
    gl: [168, 243, 255],
    hl: [79, 180, 255],
    rg: 0,
    sw: 0,
    wk: 0,
    ld: 0,
    gt: 0,
    wv: 0,
    sl: 0,
    sh: 0,
    lp: 0,
    mm: 0,
    gs: 0,
    bk: 0,
    th: 0
  };
  var K = {
    dm: 0.22,
    dp: 0.55,
    et: [170, 244, 255],
    eb: [95, 220, 248],
    gl: [90, 220, 255],
    hl: [60, 170, 230]
  };
  var AW = {
    bt: 0.95,
    dp: 0.1,
    et: [16, 38, 86],
    eb: [8, 24, 64],
    gl: [255, 255, 255],
    hl: [210, 238, 255]
  };
  var TH = {
    th: 1,
    dm: 0.12,
    dp: 0.35,
    mm: 0.2,
    ta: 0.22,
    tc: [30, 95, 205],
    hl: [40, 105, 190]
  };
  var ST = {
    idle: { p: {}, v: {} },
    awake: { p: { ew: 1.1, eL: 1.12, eR: 1.12, sq: -0.03, ty: -4 }, v: AW },
    thinking: { p: { gy: -6, eL: 0.8, eR: 0.8, sep: 0.95, sq: -0.012 }, v: merge(K, TH) },
    working: { p: { gy: 19, eL: 0.85, eR: 0.85, ty: 2 }, v: merge(AW, { lp: 1 }) },
    waiting: { p: { gy: 21, eL: 0.9, eR: 0.9, sep: 1.5 }, v: merge(K, { gs: 1, bk: 1, dm: 0.1, dp: 0.3 }) },
    success: { p: { ew: 1.12, eL: 1.12, eR: 1.12, sq: 0.02 }, v: { ta: 0.78, tc: [40, 215, 110], et: [225, 255, 235], eb: [150, 255, 190], gl: [120, 255, 170], hl: [70, 230, 130], rg: 1, dp: 0.4, mm: 0.3 } },
    warning: { p: { eL: 0.8, eR: 0.8, gy: 2 }, v: { ta: 0.5, tc: [255, 205, 40], et: [255, 250, 205], eb: [255, 225, 110], gl: [255, 225, 90], hl: [255, 200, 40], dp: 0.6, mm: 0.5 } },
    error: { p: { tilt: -10, ew: 0.85, eL: 0.72, eR: 0.72, sq: 0.03, ty: 5 }, v: { ta: 0.6, tc: [235, 50, 60], et: [255, 170, 170], eb: [255, 70, 80], gl: [255, 60, 70], hl: [255, 60, 70], gt: 1, dp: 0.6, mm: 0.5 } },
    sleeping: { p: { ew: 1.15, eL: 0.08, eR: 0.08, gy: 8, sq: 0.08, ty: 8, rot: -3 }, v: { dm: 0.42, dp: 0.12, et: [150, 200, 230], eb: [110, 170, 210], gl: [120, 180, 220], hl: [40, 90, 160] } }
  };
  ST.thinking = { p: {}, v: TH };
  ST.planning = ST.thinking;
  ST.working = { p: {}, v: { th: 0.5, dm: 0.06, dp: 0.3 } };
  ST.executing = ST.working;
  ST.waiting = { p: {}, v: { dm: 0.05 } };
  ST.verifying = { p: {}, v: { th: 0.3, dm: 0.1 } };
  ST.multiagent = { p: {}, v: { th: 0.6, dp: 0.4 } };
  ST.done = ST.success;
  ST.error.p = {};
  ST.warning.p = {};
  ST.success.p = {};
  ST.awake.p = {};
  ST.sleeping.p = {};
  for (const n of ["listening", "toolcall", "blocked", "needsuser", "confirmation"]) ST[n] = { p: {}, v: {} };
  var BN = ["backflip", "spin", "cross", "derp", "rolling", "doze", "doubletake", "idea", "scan", "cool"];
  for (const n of ["funny", ...BN]) ST[n] = { p: {}, v: {} };
  ST.idea.v = { th: 1, dm: 0.05 };
  for (const n of ["jump", "backflip", "frontflip", "spin", "fight"]) ST[n] = { p: {}, v: {} };
  ST.fight.v = { ta: 0.18, tc: [255, 130, 60] };
  var TMAP = {
    S1: "plan",
    S2: "aqua",
    S4: "wake",
    S6: "aqua",
    S7: "mint",
    S8: "sky",
    S9: "help",
    S10: "sun",
    S11: "sun",
    S12: "mint",
    S13: "sky",
    S17: "wake",
    V2: "aqua",
    V3: "progress",
    V7: "rose",
    V8: "aqua",
    V9: "error",
    V13: "mint",
    V15: "wake",
    V16: "sky",
    V17: "aqua",
    V18: "ultra",
    V20: "ultra",
    V23: "rose",
    V24: "sun",
    V26: "wake",
    V29: "sky",
    V30: "aqua",
    V31: "mint",
    V32: "sun"
  };
  var THM = {
    aqua: { ta: 0.4, tc: [60, 200, 255], et: [255, 255, 255], eb: [169, 236, 255], gl: [168, 243, 255], hl: [79, 190, 255], dm: 0.08 },
    wake: AW,
    sky: { ta: 0.5, tc: [70, 150, 255], et: [255, 255, 255], eb: [190, 225, 255], gl: [150, 205, 255], hl: [80, 150, 255], dm: 0.08 },
    mint: { ta: 0.55, tc: [40, 215, 170], et: [232, 255, 248], eb: [150, 255, 225], gl: [110, 255, 215], hl: [40, 220, 170], dm: 0.08 },
    sun: { ta: 0.58, tc: [255, 190, 50], et: [255, 252, 228], eb: [255, 228, 140], gl: [255, 220, 110], hl: [255, 190, 50], dm: 0.05 },
    rose: { ta: 0.52, tc: [255, 110, 170], et: [255, 242, 247], eb: [255, 185, 215], gl: [255, 160, 205], hl: [255, 110, 170], dm: 0.06 },
    plan: { ta: 0.6, tc: [96, 104, 255], et: [236, 238, 255], eb: [170, 178, 255], gl: [150, 160, 255], hl: [100, 110, 255], dm: 0.12, mm: 0.4 },
    help: { ta: 0.64, tc: [255, 168, 30], et: [255, 250, 228], eb: [255, 222, 120], gl: [255, 210, 90], hl: [255, 180, 40], dm: 0.04 },
    progress: { ta: 0.64, tc: [40, 215, 110], et: [225, 255, 235], eb: [150, 255, 190], gl: [120, 255, 170], hl: [70, 230, 130], rg: 1, dm: 0.05 },
    error: { ta: 0.68, tc: [235, 50, 60], et: [255, 180, 180], eb: [255, 70, 80], gl: [255, 60, 70], hl: [255, 60, 70], gt: 1, wv: 0.3, dm: 0.12 },
    ultra: { ta: 0.64, tc: [160, 80, 255], et: [247, 236, 255], eb: [205, 150, 255], gl: [200, 140, 255], hl: [165, 90, 255], lp: 1, rg: 1, mm: 0.3, dm: 0.05 }
  };
  var SKN = {
    blue: { b: ["#1B5FE0", "#2E84F6", "#5CB8FF", "#A4E4FF", "#E4F8FF"], d: "#0A3CB0", u: "#7FE0FF", m: [0.13, 0.45, 1], hl: 0, rim: "#D6F5FF", r3: "#8fe6ff", dot: "#CDEBFF" },
    black: { b: ["#020203", "#0a0a0c", "#17171b", "#34343c", "#9a9aa6"], d: "#000000", u: "#8a8a96", m: [0.5, 0.5, 0.55], hl: [190, 195, 205], gl: [205, 205, 215], eb: [225, 225, 232], rim: "#c8c8d0", r3: "#b8b8c4", dot: "#d8d8de" },
    yellow: { b: ["#E59B00", "#FFC21A", "#FFDC5C", "#FFEFA0", "#FFFBE0"], d: "#9a5a00", u: "#FFF0A0", m: [0.95, 0.6, 0.12], hl: 0, rim: "#D6F5FF", r3: "#8fe6ff", dot: "#CDEBFF" }
  };
  var JD = {
    jump: [1.6, 0, 0],
    backflip: [2, 1, 0],
    frontflip: [2, -1, 0],
    spin: [2.8, 0, 1]
  };
  var HC = [
    [[30, 92, 235], [160, 228, 255]],
    [[196, 214, 238], [255, 255, 255]],
    [[124, 66, 235], [255, 150, 225]],
    [[255, 92, 150], [255, 205, 125]],
    [[20, 172, 142], [160, 255, 214]],
    [[236, 160, 36], [255, 240, 150]],
    [[22, 28, 64], [80, 120, 230]],
    [[88, 58, 44], [196, 136, 84]]
  ];
  var CC = [
    [226, 52, 62],
    [44, 112, 236],
    [34, 36, 46],
    [248, 248, 250],
    [44, 184, 112],
    [255, 170, 40]
  ];
  var ACC = [
    [255, 92, 138],
    [80, 200, 255],
    [255, 200, 64],
    [140, 255, 170],
    [190, 130, 255]
  ];
  var BB = "#e8f4ff";
  var SK_ROWS = [
    "e-18,24,7,9;e20,28,8,5,-15",
    "e-24,-2,10,19;e24,-2,10,19",
    "d-22,-4,9,7;d22,-4,9,7",
    "d-22,0,10,8;d22,0,10,8",
    "d-22,4,9,7;d22,4,9,7",
    "e-22,0,9,17;e22,0,9,17",
    "e-30,0,4,6;e30,0,4,6",
    "e-30,0,12,3.5;e30,0,12,3.5",
    "e-36,2,17,8;e36,2,17,8",
    "b-22,-2,9,7;b22,-2,9,7",
    "e-24,0,12,4.5,28;e24,0,12,4.5,-28",
    "e8,-4,8,16,-14;e40,-2,8,16,-14",
    "e-26,0,6,12;e0,0,2.5,14;e26,0,6,12",
    "pM0 -34A34 34 0 0 1 0 34A17 17 0 0 1 0 0A17 17 0 0 0 0 -34Z",
    "r-14,-18,17;r-26,18,12;r8,20,15",
    "e-26,8,8,14;e12,16,7,18;e22,-44,3,3",
    "e-34,0,5,11;e34,0,5,11",
    "r0,0,22"
  ];
  var BT = "pM40 40L52 36L46 48Z|" + BB;
  var VX_ROWS = [
    "e-18,0,8,8;e18,0,8,8",
    "e-16,-2,9,16;e16,-2,9,16;e-50,-32,6,6,0," + BB + ";e52,34,9,5,-30," + BB,
    "e10,-22,6,6;e32,-28,5,5;e-52,-30,5,5,0,#46e04a",
    "e8,-8,5,15,-25;e28,-14,6,10,-30",
    "e-16,8,9,16;e16,8,9,16",
    "e-16,-2,9,16;e16,-2,9,16;e-50,-32,6,6,0," + BB + ";e52,34,9,5,-30," + BB,
    "e-20,0,9,3;e18,0,5,5",
    "e-12,28,7,5;e22,34,8,5",
    "e-20,2,9,3;e20,2,9,3;e-50,-30,4,4,0,#ff3b3b",
    "e-6,-14,5,5;e30,-20,4,4;e-50,-30,4,4,0,#46e04a",
    "pM0 -34A34 34 0 0 1 0 34A17 17 0 0 1 0 0A17 17 0 0 0 0 -34Z",
    "pM-18 -26H18V-19H-18ZM-14 -15H14V26Q14 30 10 30H-10Q-14 30 -14 26Z;e-6,6,3,4,0,#0b1530;e6,6,3,4,0,#0b1530",
    "e-14,-2,10,22;e24,14,6,18,12",
    "e-18,4,8,8;e18,4,8,8",
    "e-4,-14,5,10,-20;e14,-16,4,7,-20;" + BT,
    "e-18,-2,8,8;e14,-4,8,8;pM42 8L56 12L48 24Z|" + BB,
    "e-16,0,5,12;e16,0,5,12",
    "e-8,-10,12,12;e10,8,12,12;e-12,16,9,9",
    "e-16,0,8,16;e16,0,8,16",
    "e-28,0,7,12;e0,0,3,12;e28,0,7,12",
    "e-28,2,6,9;e0,0,6,17;e28,2,6,9",
    "e-28,0,7,12;e0,0,5,17;e28,0,7,12",
    "e-6,-14,13,13;e8,10,15,15",
    "e-4,-14,5,10,-20;e14,-16,4,7,-20;" + BT,
    "e-14,-8,10,10;e8,10,9,9;e-6,24,8,8",
    "e-16,-8,9,16;e16,-8,9,16",
    "e-16,8,9,16;e16,8,9,16;q-52,-40,28,12,#4aa8ff;t-52,-37,6|Working",
    "e-16,8,9,16;e16,8,9,16;q-52,-40,28,12,#4aa8ff;e-60,-40,2,2,0,#fff;e-52,-40,2,2,0,#fff;e-44,-40,2,2,0,#fff",
    "e-14,10,7,7;e14,10,7,7",
    "e-14,0,6,13;e14,0,6,13",
    "e-26,0,10,18;e26,0,10,18",
    "e-30,0,13,24;e30,0,13,24"
  ];
  var stp = (cx, cy, r, f) => {
    const k = r * 0.22;
    return `pM${cx} ${cy - r}Q${cx + k} ${cy - k} ${cx + r} ${cy}Q${cx + k} ${cy + k} ${cx} ${cy + r}Q${cx - k} ${cy + k} ${cx - r} ${cy}Q${cx - k} ${cy - k} ${cx} ${cy - r}Z|${f}`;
  };
  var hrt = (cx, cy, s, f) => `pM${cx} ${cy + s}C${cx - s * 1.7} ${cy - s * 0.1} ${cx - s * 0.9} ${cy - s * 1.3} ${cx} ${cy - s * 0.4}C${cx + s * 0.9} ${cy - s * 1.3} ${cx + s * 1.7} ${cy - s * 0.1} ${cx} ${cy + s}Z|${f}`;
  var ALL = {};
  SK_ROWS.forEach((v, i) => {
    ALL["S" + (i + 1)] = v;
  });
  VX_ROWS.forEach((v, i) => {
    ALL["V" + (i + 1)] = v;
  });
  ALL.V15 = `${VX_ROWS[14]};${stp(40, -32, 12, "#FFC93C")};${stp(-42, -34, 7, "#FFB020")};${stp(52, -6, 5, "#FFD966")}`;
  ALL.V16 = "e-28,8,8,14;e2,6,8,14;pM14 -22L46 -34L30 -16Z|#FFFFFF;pM30 -16L46 -34L32 -2Z|#BFE3FF;e8,-22,2.6,2.6,0,#FFFFFF;e0,-18,1.8,1.8,0,#FFFFFFB3";
  ALL.V23 = `${VX_ROWS[22]};${hrt(42, -26, 8, "#FF5C8A")};${stp(-44, -34, 6, "#FFFFFF")}`;
  var KEEP = ["S1", "S2", "S4", "S6", "S7", "S8", "S9", "S10", "S11", "S12", "S13", "S17", "V2", "V3", "V7", "V8", "V9", "V13", "V15", "V16", "V17", "V18", "V20", "V23", "V24", "V26", "V29", "V30", "V31", "V32"];
  var PZ = {};
  for (const k of KEEP) PZ[k] = ALL[k];
  function parseGallery(row) {
    return row.split(";").map((tok) => {
      const type = tok[0];
      const parts = tok.slice(1).split("|");
      const n = (parts[0] || "").split(",").map(Number);
      let fill = parts[0] && parts[0].split(",")[5] ? parts[0].split(",")[5] : "";
      let text = parts[1] ?? "";
      let ex = n[0] || 0, ey = n[1] || 0;
      if (type === "p") {
        fill = parts[1] || "";
        text = parts[0];
        ex = 0;
        ey = 0;
      } else if (type === "q") {
        fill = parts[0].split(",")[4] || "";
        ex = n[0] || 0;
        ey = n[1] || 0;
      } else if (type === "t") {
        text = parts[1] ?? "";
        ex = 0;
        ey = 0;
      }
      return { type, n, fill, text, ex, ey };
    });
  }
  function drawGalEl(ctx, el, c4) {
    const n = el.n;
    const fill = !el.fill || el.fill === "var(--c4)" ? c4 : el.fill;
    if (el.type === "e") {
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.ellipse(0, 0, n[2] || 1, n[3] || 1, (n[4] || 0) * Math.PI / 180, 0, Math.PI * 2);
      ctx.fill();
    } else if (el.type === "d" || el.type === "b") {
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.ellipse(0, 0, n[2] || 1, n[3] || 1, 0, Math.PI, 0, el.type === "d");
      ctx.closePath();
      ctx.fill();
    } else if (el.type === "r") {
      ctx.strokeStyle = c4;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(0, 0, n[2] || 1, 0, Math.PI * 2);
      ctx.stroke();
    } else if (el.type === "q") {
      ctx.fillStyle = el.fill && el.fill.length > 0 ? el.fill : c4;
      rrPath(ctx, -(n[2] || 0) / 2, -(n[3] || 0) / 2, n[2] || 1, n[3] || 1, (n[3] || 1) / 2);
      ctx.fill();
    } else if (el.type === "t") {
      ctx.fillStyle = "#fff";
      ctx.font = `700 ${n[2] || 10}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(el.text, 0, 0);
    } else {
      ctx.fillStyle = el.text && el.text[0] === "#" ? el.text : fill;
      ctx.beginPath();
      svgPath(ctx, el.text);
      ctx.fill();
    }
  }
  function svgPath(ctx, d) {
    const tk = d.match(/[MmLlHhVvCcQqAaZz]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? [];
    let i = 0, cmd = "", x = 0, y = 0, sx = 0, sy = 0;
    const num = () => parseFloat(tk[i++]);
    while (i < tk.length) {
      if (/[a-z]/i.test(tk[i])) cmd = tk[i++];
      switch (cmd) {
        case "M":
          x = num();
          y = num();
          ctx.moveTo(x, y);
          sx = x;
          sy = y;
          cmd = "L";
          break;
        case "L":
          x = num();
          y = num();
          ctx.lineTo(x, y);
          break;
        case "H":
          x = num();
          ctx.lineTo(x, y);
          break;
        case "V":
          y = num();
          ctx.lineTo(x, y);
          break;
        case "C": {
          const a = num(), b = num(), c = num(), e = num();
          x = num();
          y = num();
          ctx.bezierCurveTo(a, b, c, e, x, y);
          break;
        }
        case "Q": {
          const a = num(), b = num();
          x = num();
          y = num();
          ctx.quadraticCurveTo(a, b, x, y);
          break;
        }
        case "A": {
          const rx = num(), ry = num(), rot = num(), laf = num(), sf = num();
          const nx = num(), ny = num();
          arcSeg(ctx, x, y, nx, ny, rx, ry, rot, laf, sf);
          x = nx;
          y = ny;
          break;
        }
        case "Z":
          ctx.closePath();
          x = sx;
          y = sy;
          break;
        default:
          i++;
      }
    }
  }
  function arcSeg(ctx, x1, y1, x2, y2, rx, ry, rot, laf, sf) {
    const phi = rot * Math.PI / 180;
    const cosp = Math.cos(phi), sinp = Math.sin(phi);
    const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
    const x1p = cosp * dx + sinp * dy, y1p = -sinp * dx + cosp * dy;
    rx = Math.abs(rx);
    ry = Math.abs(ry);
    const lam = x1p * x1p / (rx * rx) + y1p * y1p / (ry * ry);
    if (lam > 1) {
      const s = Math.sqrt(lam);
      rx *= s;
      ry *= s;
    }
    const sign = laf === sf ? -1 : 1;
    const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
    const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
    const co = sign * Math.sqrt(Math.max(0, num / den));
    const cxp = co * rx * y1p / ry, cyp = -co * ry * x1p / rx;
    const cx = cosp * cxp - sinp * cyp + (x1 + x2) / 2;
    const cy = sinp * cxp + cosp * cyp + (y1 + y2) / 2;
    const ang = (ux, uy, vx, vy) => {
      const dot = ux * vx + uy * vy, len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
      let a = Math.acos(Math.min(1, Math.max(-1, dot / len)));
      if (ux * vy - uy * vx < 0) a = -a;
      return a;
    };
    const th1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
    let dth = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
    if (!sf && dth > 0) dth -= Math.PI * 2;
    else if (sf && dth < 0) dth += Math.PI * 2;
    ctx.ellipse(cx, cy, rx, ry, phi, th1, th1 + dth, dth < 0);
  }
  var D2R = Math.PI / 180;
  var nrm = (v) => {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  var SPt = (lon, lat, r) => {
    const lo = lon * D2R, la = lat * D2R, c = Math.cos(la);
    return [r * c * Math.sin(lo), r * Math.sin(la), r * c * Math.cos(lo)];
  };
  var ad = (v, w, k) => [v[0] + w[0] * k, v[1] + w[1] * k, v[2] + w[2] * k];
  var sc3 = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
  var Pt = (p, c, o) => {
    const out = { p, c, o: 0, ref: [0, 0, 0], bob: 0 };
    if (o) Object.assign(out, o);
    return out;
  };
  function dome(f, top, r, c, nl, nm, o) {
    const out = [];
    for (let i = 0; i < nl; i++) {
      const a = i * 360 / nl, b = (i + 1) * 360 / nl, s0 = f(a), s1 = f(b);
      for (let j = 0; j < nm; j++) {
        const fa = j / nm, fb = (j + 1) / nm;
        out.push(Pt(
          [SPt(a, s0 + (top - s0) * fa, r), SPt(b, s1 + (top - s1) * fa, r), SPt(b, s1 + (top - s1) * fb, r), SPt(a, s0 + (top - s0) * fb, r)],
          sc3(c, 0.86 + 0.28 * (fa + fb) / 2),
          o
        ));
      }
    }
    return out;
  }
  function spike(lon, lat, r, w, nl, ul, el, c, o, c2) {
    const n = nrm(SPt(lon, lat, 1));
    const e = [Math.cos(lon * D2R), 0, -Math.sin(lon * D2R)];
    const u = [-Math.sin(lat * D2R) * Math.sin(lon * D2R), Math.cos(lat * D2R), -Math.sin(lat * D2R) * Math.cos(lon * D2R)];
    const b = SPt(lon, lat, r), b0 = ad(b, e, -w), b1 = ad(b, e, w), b2 = ad(b, u, w * 1.3);
    const tip = ad(ad(ad(b, n, nl), u, ul), e, el);
    const op = Object.assign({ o: 1, ref: ad(b, n, nl * 0.35) }, o ?? {});
    if (!c2) return [Pt([b0, b1, tip], c, op), Pt([b1, b2, tip], c, op), Pt([b2, b0, tip], c, op)];
    const md = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2];
    const out = [];
    for (const ed of [[b0, b1], [b1, b2], [b2, b0]]) {
      const m0 = md(ed[0], tip), m1 = md(ed[1], tip);
      out.push(Pt([ed[0], ed[1], m1, m0], c, Object.assign({ sw: [0, 0, 0.5, 0.5] }, op)));
      out.push(Pt([m0, m1, tip], c2, Object.assign({ sw: [0.5, 0.5, 1] }, op)));
    }
    return out;
  }
  var FITS = {
    hair(v) {
      const c = HC[v % HC.length][0], c2 = HC[v % HC.length][1];
      let out = dome(() => 46, 90, 153, c, 20, 4);
      for (let i = 0; i < 18; i++) {
        out = out.concat(spike(i * 20 + 8, 62 + i % 2 * 7, 152, 10, 30 + i % 3 * 10, 14 + i % 4 * 4, i % 2 ? 9 : -9, sc3(c, 1.08), null, sc3(c2, 1.05)));
      }
      for (let i = 0; i < 5; i++) out = out.concat(spike(i * 72 + 16, 82, 151, 11, 36, 8, 0, sc3(c, 1.15), null, c2));
      for (const l of [-46, -32, -16, 0, 16, 32, 46]) {
        out = out.concat(spike(l, 54, 153, 10, 6, -30, l > 0 ? 6 : l < 0 ? -6 : 0, sc3(c, 0.92), null, sc3(c2, 0.95)));
      }
      return out.concat(spike(10, 76, 152, 6, 62, 26, 16, sc3(c, 1.2), null, [255, 255, 255]));
    },
    cap(v) {
      const c = CC[v % CC.length];
      let out = dome(() => 38, 90, 156, c, 20, 5);
      out = out.concat(dome(() => 38, 44, 158.5, sc3(c, 0.78), 20, 1));
      out = out.concat(dome(() => 79, 90, 163, sc3(c, 1.18), 10, 2, { o: 1 }));
      const inn = [], outr = [];
      for (let i = -4; i <= 4; i++) {
        const l = i * 16, I = SPt(l, 38, 158), f = [Math.sin(l * D2R), 0, Math.cos(l * D2R)];
        inn.push(I);
        outr.push(ad(ad(I, f, 40), [0, -16, 0], 1));
      }
      for (let i = 0; i < 8; i++) out.push(Pt([inn[i], inn[i + 1], outr[i + 1], outr[i]], sc3(c, 0.7), { o: 1, ref: [0, -30, 0] }));
      return out;
    },
    bat() {
      const c = [24, 26, 38];
      let out = dome((lon) => {
        const l = ((lon + 180) % 360 + 360) % 360 - 180;
        return Math.abs(l) <= 45 ? 12 + 10 * Math.abs(l) / 45 : 22;
      }, 90, 153, c, 24, 5);
      out = out.concat(spike(-34, 56, 152, 15, 50, 34, -10, [20, 22, 32]));
      out = out.concat(spike(34, 56, 152, 15, 50, 34, 10, [20, 22, 32]));
      const em = [[-20, 4], [-13, 9], [-9, 4], [-4, 8], [-2, 13], [0, 10], [2, 13], [4, 8], [9, 4], [13, 9], [20, 4], [12, -2], [6, -4], [0, -9], [-6, -4], [-12, -2]];
      out.push(Pt(em.map((q) => SPt(q[0] * 0.9, 50 + q[1] * 0.9, 155.5)), [255, 204, 60], { o: 2 }));
      const G = [];
      for (let j = 0; j <= 5; j++) {
        G.push([]);
        for (let i = 0; i <= 10; i++) G[j].push(SPt(100 + i * 18, 8 - j * 14 - (j === 5 ? 4 + 5 * Math.sin(i * 2.1) : 0), 158 + j * 4.5));
      }
      for (let j = 0; j < 5; j++) for (let i = 0; i < 10; i++) {
        out.push(Pt([G[j][i], G[j][i + 1], G[j + 1][i + 1], G[j + 1][i]], i % 2 ? [64, 68, 112] : [40, 42, 76]));
      }
      return out;
    },
    phones(v) {
      const out = [];
      const R = 163, band = [104, 116, 150], ac = ACC[v % ACC.length];
      for (let i = 0; i < 17; i++) {
        const a0 = (4 + i * 10.1) * D2R, a1 = (4 + (i + 1) * 10.1) * D2R;
        out.push(Pt([
          [(R - 6) * Math.cos(a0), (R - 6) * Math.sin(a0), 8],
          [(R + 8) * Math.cos(a0), (R + 8) * Math.sin(a0), 8],
          [(R + 8) * Math.cos(a1), (R + 8) * Math.sin(a1), 8],
          [(R - 6) * Math.cos(a1), (R - 6) * Math.sin(a1), 8]
        ], band, { o: 1 }));
      }
      for (const s of [-1, 1]) {
        const disc = [];
        for (let i = 0; i < 16; i++) {
          const f0 = i * 22.5 * D2R, f1 = (i + 1) * 22.5 * D2R;
          const y0 = 6 + 36 * Math.cos(f0), z0 = 36 * Math.sin(f0), y1 = 6 + 36 * Math.cos(f1), z1 = 36 * Math.sin(f1);
          out.push(Pt([[s * 150, y0, z0], [s * 150, y1, z1], [s * 180, y1, z1], [s * 180, y0, z0]], sc3(ac, 0.85), { o: 1, ref: [s * 165, 6, 0] }));
          disc.push([s * 180, y0, z0]);
        }
        out.push(Pt(disc, sc3(ac, 1.15), { o: 1, ref: [s * 150, 6, 0] }));
      }
      return out;
    },
    cat(v) {
      const c = HC[v % HC.length][0], out = [];
      for (const s of [-1, 1]) {
        const lon = s * 36, lat = 54, sp = spike(lon, lat, 152, 22, 44, 28, -s * 8, c);
        const f = sp[0].p;
        const cen = [(f[0][0] + f[1][0] + f[2][0]) / 3, (f[0][1] + f[1][1] + f[2][1]) / 3, (f[0][2] + f[1][2] + f[2][2]) / 3];
        const nn = nrm(SPt(lon, lat, 1));
        out.push(...sp);
        out.push(Pt(f.map((q) => ad(ad(cen, [q[0] - cen[0], q[1] - cen[1], q[2] - cen[2]], 0.55), nn, 2.5)), [255, 170, 190], { o: 2, ref: sp[0].ref }));
      }
      return out;
    },
    crown() {
      const gold = [255, 200, 64];
      let out = dome(() => 58, 68, 157, gold, 16, 1, { o: 1 });
      for (let i = 0; i < 8; i++) {
        const lon = i * 45 + 22, a = SPt(lon - 11, 68, 157), b = SPt(lon + 11, 68, 157), tip = ad(SPt(lon, 68, 157), [0, 1, 0], 34);
        out.push(Pt([a, b, tip], sc3(gold, 1.05), { o: 1, ref: [0, a[1] + 8, 0] }));
      }
      for (const g of [[0, [255, 70, 90]], [45, [70, 170, 255]], [-45, [70, 170, 255]]]) {
        const l = g[0], y = 63;
        out.push(Pt([SPt(l, y + 4, 159), SPt(l + 4, y, 159), SPt(l, y - 4, 159), SPt(l - 4, y, 159)], g[1], { o: 2 }));
      }
      return out;
    },
    halo(v) {
      const out = [];
      const ci = [[255, 226, 110], [190, 240, 255], [255, 170, 220]][v % 3];
      const Y = 190, tl = 0.38;
      const pt = (r, k) => {
        const ph = k * 15 * D2R, x = r * Math.cos(ph), z = r * Math.sin(ph);
        return [x, Y - z * Math.sin(tl), z * Math.cos(tl)];
      };
      for (let i = 0; i < 24; i++) out.push(Pt([pt(44, i), pt(44, i + 1), pt(58, i + 1), pt(58, i)], ci, { o: 1, bob: 1, ref: [0, Y - 70, 0] }));
      return out;
    }
  };
  var Sp = class {
    x;
    v = 0;
    t;
    k;
    d;
    constructor(x, k, d) {
      this.x = x;
      this.t = x;
      this.k = k;
      this.d = d;
    }
    s(dt) {
      this.v += (this.k * (this.t - this.x) - this.d * this.v) * dt;
      this.x += this.v * dt;
    }
  };
  var rgbStr = (c) => `rgb(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])})`;
  var KaiOrb = class {
    // Springs (source line 96–97)
    S = {
      hl: new Sp(0, 200, 16),
      hr: new Sp(0, 200, 16),
      hv: new Sp(0, 120, 14),
      en: new Sp(0, 30, 9),
      tx: new Sp(0, 70, 12),
      ty: new Sp(0, 60, 10),
      rot: new Sp(0, 60, 11),
      sq: new Sp(0, 110, 11),
      gx: new Sp(0, 160, 17),
      gy: new Sp(0, 160, 17),
      ew: new Sp(1, 180, 19),
      eL: new Sp(1, 200, 20),
      eR: new Sp(1, 200, 20),
      tilt: new Sp(0, 150, 18),
      sep: new Sp(1, 170, 19),
      bl: new Sp(1, 800, 40),
      wb: new Sp(0, 200, 14),
      tn: new Sp(0, 60, 10),
      ro: new Sp(0, 60, 12),
      cv: new Sp(0, 120, 14),
      dg: new Sp(0, 120, 14),
      sx: new Sp(0, 400, 28),
      sy: new Sp(0, 400, 28),
      yw: new Sp(0, 70, 9),
      pt: new Sp(0, 70, 9),
      lx: new Sp(0, 50, 10),
      ly: new Sp(0, 50, 10),
      pa: new Sp(1, 260, 13),
      ho: new Sp(1, 200, 18),
      pq: new Sp(0, 110, 14),
      m3: new Sp(1, 90, 13)
    };
    // Neutral targets (source line 99)
    N = { hl: 0, hr: 0, hv: 0, tx: 0, ty: 0, rot: 0, sq: 0, gx: 0, gy: 0, ew: 1, eL: 1, eR: 1, tilt: 0, sep: 1 };
    // Current / target theme vectors
    VC = JSON.parse(JSON.stringify(VN));
    VT = JSON.parse(JSON.stringify(VN));
    pose = "idle";
    timers = [];
    tMs = 0;
    t0 = Math.random() * 5;
    nextBlink = 1.5 + Math.random() * 2;
    blinkUntil = -1;
    nextGlance = 2.5;
    nextPerk = 7;
    nextJitter = 1.1;
    jitterX = 0;
    jitterY = 0;
    ge = 0;
    // cyc.ge — energy fraction
    ptPulse = -9;
    // PT — last core pulse time
    jtKey = "";
    // JT.k — running jump/flip pose
    jt0 = 0;
    // JT.t0
    glitchIdx = -1;
    accessory = "none";
    skin = "blue";
    acVariant = 0;
    acParts = [];
    /** 3-D eye rig (mode3) — source #e3, L66 / L226-228. */
    eyeMode3 = false;
    /** Pose-z gallery face key, or null (source PZ, L338-360). */
    galleryKey = null;
    /** Work props (source #lap/#bk/#hnd, L74-85). */
    laptop = false;
    backpack = false;
    hands = false;
    /** Pointer gaze, set by the host each frame (already normalised to -1…1). */
    lookX = 0;
    lookY = 0;
    gazeLocked = false;
    reducedMotion = false;
    /** When true the orb advances no animation (window hidden). */
    paused = false;
    dotCanvas = null;
    dotKey = "";
    constructor() {
      if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
        this.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      }
    }
    // ── Public API ──────────────────────────────────────────────────────────────
    /** Jumps straight to a pose (the source's `go`). */
    go(n) {
      if (n === "funny") return;
      const sc = SC[n];
      if (!sc) return;
      this.clearTimers();
      this.pose = n;
      const st = ST[n] ?? { p: {}, v: {} };
      this.setTargets(Object.assign({}, this.N, st.p));
      this.VT = Object.assign(JSON.parse(JSON.stringify(VN)), this.baseOverrides(), st.v);
      if (n === "working" || n === "executing") this.VT.lp = 1;
      if (n === "waiting") this.VT.bk = 1;
      if (n === "success") {
        this.S.ty.v = -300;
        this.later(() => {
          this.S.ty.v = -200;
        }, 520);
        this.later(() => {
          this.VT.rg = 0;
          this.VT.ta = 0.3;
        }, 2600);
      }
      if (n === "awake") {
        this.S.ty.v = -170;
        this.S.sq.v -= 0.8;
        this.later(() => {
          if (this.pose === "awake") this.go("idle");
        }, 1900);
      }
      if (n === "error") {
        this.S.tx.v += (Math.random() < 0.5 ? -1 : 1) * 60;
        this.S.sq.v += 0.4;
        this.later(() => {
          this.VT.gt = 0;
          this.VT.ta = 0.3;
        }, 900);
      }
      if (n === "warning") this.S.sq.v += 0.5;
      this.run(n);
      if (n === "sleeping") this.S.sq.v += 0.4;
    }
    setAccessory(name) {
      if (name === this.accessory) this.acVariant++;
      else this.acVariant = 0;
      this.accessory = name;
      this.acParts = name === "none" ? [] : FITS[name]?.(this.acVariant) ?? [];
    }
    setSkin(s) {
      this.skin = s;
      this.dotKey = "";
    }
    /** 3-D eye rig (mode3). Source's "3D" toggle, L390. */
    setEyeMode3(on) {
      this.eyeMode3 = on;
      if (on) this.clearGallery();
    }
    /** Shows a pose-z gallery face (PZ key) with its TMAP theme. Source selPose, L376. */
    showGallery(key) {
      if (!PZ[key]) return;
      this.galleryKey = key;
      const tm = TMAP[key] ?? "aqua";
      this.VT = Object.assign(JSON.parse(JSON.stringify(VN)), THM[tm] ?? {});
      this.S.pq.t = 1;
      this.S.tn.t = tm === "wake" ? 0.45 : 0.8;
      if (key === "S9") this.setTargets({ hl: 1, hr: 1, hv: 1 });
      if (tm === "error") {
        this.S.tx.v += (Math.random() < 0.5 ? -1 : 1) * 45;
        this.S.sq.v += 0.3;
      }
    }
    clearGallery() {
      this.galleryKey = null;
      this.S.pq.t = 0;
      this.S.tn.t = 0;
    }
    /** Direct shard/shell break-apart levels (0…1). Source VC.sl / VC.sh, L210-213. */
    setShatter(sl, sh) {
      this.VT.sl = clamp2(sl, 0, 1);
      this.VT.sh = clamp2(sh, 0, 1);
    }
    /** Deliberate break-apart: crack → shards fly → shell → reassemble. */
    shatter() {
      this.VT.sl = 1;
      this.VT.sh = 0;
      this.later(() => {
        this.VT.sh = 1;
        this.VT.sl = 0;
      }, 900);
      this.later(() => {
        this.VT.sh = 0;
      }, 2400);
    }
    /** Work props (source #lap / #bk / #hnd). */
    setProps(p) {
      if (p.laptop !== void 0) this.laptop = p.laptop;
      if (p.backpack !== void 0) this.backpack = p.backpack;
      if (p.hands !== void 0) this.hands = p.hands;
    }
    /** Ask for an eye expression for a while (ms); 0 = until cleared. */
    express(expr, ms) {
      const a = EY[expr];
      if (!a) return;
      this.setTargets({ ew: a[0], eL: a[1], eR: a[2], tilt: a[3], sep: a[4], gx: a[5], gy: a[6] });
      if (ms > 0) this.later(() => {
      }, ms);
    }
    blink() {
      this.blinkUntil = this.clock() + 0.14;
    }
    clock() {
      return this.tMs / 1e3 + this.t0;
    }
    /** Impulse used by squash/gulp/slap. */
    kickSquash(sq, ty) {
      this.S.sq.v += sq;
      this.S.ty.v += ty;
    }
    /** doRoll — a timed spin, matching the old engine's contract. */
    roll(durationMs) {
      this.pose = "rolling";
      this.S.ro.t = 1;
      this.later(() => {
        this.S.ro.t = 0;
      }, durationMs);
    }
    later(fn, ms) {
      this.timers.push({ at: this.tMs + ms, fn });
    }
    clearTimers() {
      this.timers = [];
    }
    setTargets(o) {
      for (const k in o) {
        const v = o[k];
        if (typeof v === "number" && this.S[k]) this.S[k].t = v;
      }
    }
    baseOverrides() {
      const sk = SKN[this.skin];
      const o = {};
      if (sk.hl) o.hl = sk.hl;
      if (sk.gl) o.gl = sk.gl;
      if (sk.eb) o.eb = sk.eb;
      return o;
    }
    /** Walks an SC step-sequence; returns to idle on `>idle`. */
    run(n) {
      const sc = SC[n];
      if (!sc) return;
      let i = 0;
      const step = () => {
        if (this.pose !== n) return;
        const x = sc[i++ % sc.length];
        if (x[0] === ">idle") {
          this.go("idle");
          return;
        }
        this.applyStep(x[0], x[2]);
        if (x[1]) this.later(step, x[1] * (0.85 + Math.random() * 0.4));
      };
      step();
    }
    /** The source's Pz: apply an expression plus step params. */
    applyStep(name, e) {
      const a = EY[name];
      if (a) this.setTargets({ ew: a[0], eL: a[1], eR: a[2], tilt: a[3], sep: a[4], gx: a[5], gy: a[6] });
      const p = e ?? {};
      const h = p.h ?? [0, 0];
      this.setTargets({ hl: h[0], hr: h[1], hv: h[0] || h[1] ? 1 : 0 });
      this.S.en.t = p.en ?? 0;
      this.S.cv.t = p.cv ?? 0;
      this.S.dg.t = p.dg ?? 0;
      this.S.ro.t = p.ro ?? 0;
      if (p.sq !== void 0) this.S.sq.t = p.sq;
      if (p.ty !== void 0) this.S.ty.t = p.ty;
      if (p.pu) this.ptPulse = this.tMs / 1e3;
      if (p.kick) this.S.ty.v = p.kick;
    }
    // ── Update ──────────────────────────────────────────────────────────────────
    /**
     * True while anything is still moving. Idle and sleeping settle, so the island's
     * RAF loop can stop when nothing is happening — the source's persistent idle
     * glance/blink still runs whenever the loop is alive (cursor, hover, transition).
     */
    get busy() {
      if (this.timers.length) return true;
      if (this.pose !== "idle" && this.pose !== "sleeping") return true;
      for (const k in this.S) {
        const s = this.S[k];
        if (Math.abs(s.t - s.x) > 2e-3 || Math.abs(s.v) > 0.01) return true;
      }
      return false;
    }
    update(dt) {
      if (this.paused) return;
      dt = Math.min(0.033, dt);
      const t = this.tMs / 1e3 + this.t0;
      for (const k in this.S) this.S[k].s(dt);
      const a = 1 - Math.exp(-dt * 7);
      const TG = this.VT;
      const vn = this.VC;
      const tn = TG;
      for (const k of ["dp", "ta", "bt", "dm", "rg", "ld", "gt", "wv", "sl", "sh", "lp", "mm", "gs", "bk", "th"]) {
        vn[k] += (tn[k] - vn[k]) * a;
      }
      const vr = this.VC;
      const tr = TG;
      for (const k of ["tc", "et", "eb", "gl", "hl"]) {
        const v = vr[k], g = tr[k];
        v[0] += (g[0] - v[0]) * a;
        v[1] += (g[1] - v[1]) * a;
        v[2] += (g[2] - v[2]) * a;
      }
      this.tMs += dt * 1e3;
      if (this.timers.length) {
        const due = this.timers.filter((x) => x.at <= this.tMs);
        this.timers = this.timers.filter((x) => x.at > this.tMs);
        for (const d of due) d.fn();
      }
      const n = t;
      if (n >= this.nextBlink && this.pose !== "sleeping") {
        this.blinkUntil = n + 0.14;
        this.nextBlink = n + 2 + Math.random() * 3.5;
        if (Math.random() < 0.2) this.later(() => this.blink(), 230);
      }
      if (this.blinkUntil > 0 && n >= this.blinkUntil) this.blinkUntil = -1;
      this.S.bl.t = this.blinkUntil > n ? 0.07 : 1;
      if (this.pose === "idle" && !this.gazeLocked) {
        if (n >= this.nextGlance) {
          this.nextGlance = n + 1.8 + Math.random() * 3.2;
          const x = (Math.random() - 0.5) * 34, y = (Math.random() - 0.5) * 20;
          this.S.tx.v += -Math.sign(x) * 40;
          this.setTargets({ gx: x, gy: y, tx: x * 0.18, rot: x * 0.1 });
          this.later(() => {
            if (this.pose === "idle") this.setTargets({ gx: 0, gy: 0, tx: 0, rot: 0 });
          }, 900 + Math.random() * 1200);
        }
        if (n >= this.nextPerk) {
          this.nextPerk = n + 9 + Math.random() * 7;
          this.S.ty.v = -130;
          this.S.rot.v += 35;
          this.setTargets({ ew: 1.1, eL: 1.16, eR: 1.16 });
          this.later(() => {
            if (this.pose === "idle") this.setTargets({ ew: 1, eL: 1, eR: 1 });
          }, 420);
        }
      }
      if (this.lookX || this.lookY) {
        const dx = clamp2(this.lookX, -1, 1), dy = clamp2(this.lookY, -1, 1);
        this.setTargets({ gx: dx * 24, gy: dy * 16, tx: dx * 4, rot: dx * 3 });
        this.S.lx.t = dx;
        this.S.ly.t = dy;
      } else {
        this.S.lx.t = 0;
        this.S.ly.t = 0;
      }
      if (n >= this.nextJitter) {
        this.nextJitter = n + 1.1 + Math.random() * 0.9;
        this.jitterX = (Math.random() - 0.5) * 5;
        this.jitterY = (Math.random() - 0.5) * 3;
      }
    }
    // ── Derived frame values (source frame() 187–198) ───────────────────────────
    frameVals(t) {
      const VC = this.VC;
      const sl = this.pose === "sleeping";
      let ty = this.S.ty.x + (sl ? 3 : 6 - 3 * VC.th) * Math.sin(t * (sl ? 0.6 : 1.05));
      let sq = this.S.sq.x + 0.012 * Math.sin(t * 1.37);
      let rot = this.S.rot.x + (sl ? 3 * Math.sin(t * 0.7) : 0);
      let tx = this.S.tx.x;
      sq -= VC.th * (6e-3 + 0.012 * this.ge);
      let FR = 0;
      const jd = JD[this.pose];
      if (jd) {
        if (this.jtKey !== this.pose) {
          this.jtKey = this.pose;
          this.jt0 = t;
        }
        const ju = (t - this.jt0) / jd[0];
        if (ju >= 1) this.go("idle");
        else if (ju < 0.18) {
          const ja = ju / 0.18;
          sq += 0.14 * Math.sin(ja * 1.57);
          ty += 12 * ja;
        } else if (ju < 0.8) {
          const ja = (ju - 0.18) / 0.62;
          ty -= 105 * 4 * ja * (1 - ja);
          sq -= 0.1 * Math.sin(ja * 3.14);
          const je = ja * ja * (3 - 2 * ja);
          FR = jd[1] * je * 360 + jd[2] * je * 720;
        } else {
          const ja = (ju - 0.8) / 0.2;
          sq += 0.18 * Math.sin(ja * 3.14) * (1 - ja * 0.3);
          FR = jd[1] * 360 + jd[2] * 720;
        }
      } else this.jtKey = "";
      if (this.pose === "fight") {
        const JL = Math.pow(Math.max(0, Math.sin(t * 4.2)), 3);
        const JR = Math.pow(Math.max(0, -Math.sin(t * 4.2)), 3);
        ty -= 5 * Math.abs(Math.sin(t * 6));
        tx += 7 * (JL - JR) + 3 * Math.sin(t * 2.1);
        rot += 3 * Math.sin(t * 2.1);
      }
      if (this.pose === "working") sq += 0.012 * Math.sin(t * 4);
      rot += FR;
      if (this.pose === "warning") {
        tx += 4 * Math.sin(t * 2);
        sq += 0.012 * Math.sin(t * 3);
      }
      if (VC.gt > 0.3) tx += (Math.random() - 0.5) * 3 * (Math.sin(t * 9) > 0 ? 1 : 0.3);
      return { ty, sq, rot, tx };
    }
    // ── Draw ────────────────────────────────────────────────────────────────────
    /**
     * Draws the orb centred at (cx, cy) with radius R. The host is responsible for
     * the clear and the DPR transform.
     */
    draw(ctx, cx, cy, R, opts = {}) {
      const u = R / 150;
      const t = this.tMs / 1e3 + this.t0;
      const f = this.frameVals(t);
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(u, u);
      if (opts.bodyColor) {
        ctx.beginPath();
        ctx.arc(0, 0, 150, 0, Math.PI * 2);
        ctx.fillStyle = rgbStr(opts.bodyColor);
        ctx.fill();
        ctx.lineWidth = 3;
        ctx.strokeStyle = "rgba(255,255,255,.35)";
        ctx.stroke();
        ctx.restore();
        return;
      }
      this.drawShadow(ctx, f.tx, f.ty);
      this.drawHalo(ctx, t);
      ctx.save();
      ctx.translate(f.tx, f.ty);
      ctx.rotate(f.rot * Math.PI / 180);
      ctx.translate(0, 150);
      ctx.scale(1 + f.sq, 1 - f.sq * 0.9);
      ctx.translate(0, -150);
      if (this.accessory !== "none" && !opts.mini) this.drawAccessories(ctx, t, true);
      const sl = clamp2(this.VC.sl, 0, 1);
      if (sl > 0.01) this.drawCrack(ctx, t);
      if (sl > 0.01) {
        const bmp = this.renderBitmap(t, false);
        ctx.save();
        ctx.globalAlpha = clamp2(1 - sl, 0, 1);
        ctx.drawImage(bmp, -200, -200);
        ctx.restore();
      } else {
        this.drawBody(ctx, t);
      }
      this.drawShards(ctx, t);
      if (!opts.mini) {
        this.drawMeridians(ctx, t);
        this.drawSuccessRings(ctx, t);
        this.drawGlitch(ctx, t);
        this.drawSpec(ctx, t);
        if (this.eyeMode3) this.drawEyeMode3(ctx, t);
        else if (this.galleryKey !== null) this.drawGallery(ctx, t);
        else this.drawEyes(ctx, t);
        this.drawGlasses(ctx, t);
        this.drawWorkingBadge(ctx, t);
        if (this.accessory !== "none") this.drawAccessories(ctx, t, false);
        this.drawHands(ctx, t);
        this.drawProps(ctx, t);
      }
      ctx.restore();
      ctx.restore();
    }
    // Body ----------------------------------------------------------------------
    drawShadow(ctx, tx, ty) {
      const sc = Math.max(0.5, Math.min(1.2, 1 + ty * 0.012));
      const x = tx * 0.6 - this.S.lx.x * 16;
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 112);
      g.addColorStop(0, "rgba(1,5,16,0.85)");
      g.addColorStop(0.55, "rgba(1,5,16,0.35)");
      g.addColorStop(1, "rgba(1,5,16,0)");
      ctx.save();
      ctx.globalAlpha = Math.max(0, 0.7 * sc);
      ctx.translate(x, 170);
      ctx.scale(sc, 1);
      ctx.translate(0, -170);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(0, 170, 112, 15, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    drawHalo(ctx, t) {
      const op = this.reducedMotion ? 0.8 : 0.8 + 0.2 * Math.cos(t * Math.PI * 2 / 4.6);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 198);
      const hl = this.VC.hl;
      g.addColorStop(0.6, `rgba(${hl[0] | 0},${hl[1] | 0},${hl[2] | 0},${(0.4 * op).toFixed(3)})`);
      g.addColorStop(1, "rgba(79,180,255,0)");
      ctx.save();
      ctx.globalAlpha = op;
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, 198, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    drawBody(ctx, t) {
      const sk = SKN[this.skin];
      const VC = this.VC;
      const g = ctx.createRadialGradient(0, -18, 0, 0, -18, 159);
      g.addColorStop(0, sk.b[0]);
      g.addColorStop(0.55, sk.b[1]);
      g.addColorStop(0.84, sk.b[2]);
      g.addColorStop(0.95, sk.b[3]);
      g.addColorStop(1, sk.b[4]);
      ctx.beginPath();
      ctx.arc(0, 0, 150, 0, Math.PI * 2);
      ctx.fillStyle = g;
      ctx.fill();
      ctx.save();
      ctx.globalAlpha = 0.2;
      ctx.fillStyle = this.dotPattern(ctx, sk.dot);
      ctx.beginPath();
      ctx.arc(0, 0, 148, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      const deep = ctx.createRadialGradient(0, -60, 0, 0, -60, 225);
      deep.addColorStop(0.55, "rgba(11,42,94,0)");
      deep.addColorStop(1, "rgba(10,60,176,0.28)");
      ctx.beginPath();
      ctx.arc(0, 0, 150, 0, Math.PI * 2);
      ctx.fillStyle = deep;
      ctx.fill();
      const under = ctx.createRadialGradient(0, 135, 0, 0, 135, 180);
      const uc = sk.u;
      under.addColorStop(0, hexA(uc, 0.5));
      under.addColorStop(1, hexA(uc, 0));
      ctx.beginPath();
      ctx.arc(0, 0, 150, 0, Math.PI * 2);
      ctx.fillStyle = under;
      ctx.fill();
      ctx.globalAlpha = clamp2(VC.ta, 0, 1);
      ctx.fillStyle = rgbStr(VC.tc);
      ctx.beginPath();
      ctx.arc(0, 0, 150, 0, Math.PI * 2);
      ctx.fill();
      const brg = ctx.createRadialGradient(0, 0, 0, 0, 0, 150);
      brg.addColorStop(0, "rgba(255,255,255,1)");
      brg.addColorStop(0.62, "rgba(255,255,255,1)");
      brg.addColorStop(0.88, "#DDF3FF");
      brg.addColorStop(1, "#86CCFF");
      ctx.globalAlpha = clamp2(VC.bt, 0, 1);
      ctx.fillStyle = brg;
      ctx.beginPath();
      ctx.arc(0, 0, 150, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = clamp2(VC.dm, 0, 1);
      ctx.fillStyle = "#050B1A";
      ctx.beginPath();
      ctx.arc(0, 0, 150, 0, Math.PI * 2);
      ctx.fill();
      if (VC.th > 0.01) this.drawCore(ctx, t);
      ctx.globalAlpha = 1;
      const hl = ctx.createRadialGradient(-52, -92, 0, -52, -92, 44);
      hl.addColorStop(0, "rgba(255,255,255,0.55)");
      hl.addColorStop(1, "rgba(255,255,255,0)");
      ctx.save();
      ctx.translate(-52, -92);
      ctx.rotate(-28 * Math.PI / 180);
      ctx.fillStyle = hl;
      ctx.beginPath();
      ctx.ellipse(0, 0, 44, 22, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.arc(-92, -52, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = hexA(sk.rim, 0.6);
      ctx.beginPath();
      ctx.arc(0, 0, 149, 0, Math.PI * 2);
      ctx.stroke();
    }
    drawCore(ctx, t) {
      const th = Math.min(1, this.VC.th);
      const ge = clamp2(this.S.en.x, 0, 1);
      this.ge = ge;
      const rr = 82 * (1 - ge) + 4;
      const cgr = ctx.createRadialGradient(0, 0, 0, 0, 0, 60);
      cgr.addColorStop(0, "#eafcff");
      cgr.addColorStop(0.4, "rgba(143,220,255,0.55)");
      cgr.addColorStop(1, "rgba(79,180,255,0)");
      ctx.save();
      ctx.globalAlpha = th;
      ctx.fillStyle = cgr;
      ctx.beginPath();
      ctx.arc(-rr * 0.82, -rr * 0.57 + 3 * Math.sin(t), 24, 0, Math.PI * 2);
      ctx.globalAlpha = th * 0.7 * (1 - ge * 0.5);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(rr * 0.94, rr * 0.34 + 3 * Math.cos(t * 0.8), 18, 0, Math.PI * 2);
      ctx.globalAlpha = th * 0.55 * (1 - ge * 0.5);
      ctx.fill();
      const pu = Math.max(0, 1 - (this.tMs / 1e3 - this.ptPulse) / 1.1);
      ctx.globalAlpha = Math.min(1, 0.22 + 0.6 * ge + 0.3 * pu);
      ctx.beginPath();
      ctx.arc(0, 0, 74 - ge * 30, 0, Math.PI * 2);
      ctx.fill();
      if (pu > 0) {
        ctx.globalAlpha = 0.35 * pu;
        ctx.lineWidth = 1.6;
        ctx.strokeStyle = "#a8e6ff";
        ctx.beginPath();
        ctx.arc(0, 0, 20 + (1 - pu) * 105, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }
    // Meridian cage -------------------------------------------------------------
    drawMeridians(ctx, t) {
      const VC = this.VC;
      const yw = this.S.yw.x - Math.PI * 2 * Math.round(this.S.yw.x / (Math.PI * 2));
      const lo = this.S.gx.x * (Math.PI / 180) * 1.7 + this.S.yw.x;
      const la = -(this.S.gy.x * (Math.PI / 180)) * 1.5 + this.S.pt.x;
      const mo = Math.max(VC.mm, Math.min(1, (Math.abs(yw) + Math.abs(this.S.pt.x)) * 2.6));
      if (mo <= 0.01) return;
      ctx.save();
      ctx.globalAlpha = clamp2(mo, 0, 1);
      ctx.strokeStyle = "#DFF4FF";
      ctx.lineWidth = 0.9;
      for (let q = 0; q < 6; q++) {
        const rx = 150 * Math.abs(Math.sin(q * Math.PI / 6 - lo));
        ctx.beginPath();
        ctx.ellipse(0, 0, rx, 150, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      for (let q = 0; q < 5; q++) {
        const fa = (q - 2) * Math.PI / 6, rq = 150 * Math.cos(fa);
        ctx.beginPath();
        ctx.ellipse(0, -150 * Math.sin(fa) * Math.cos(la), rq, rq * (0.08 + 0.92 * Math.abs(Math.sin(la))), 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
      void t;
    }
    // Eyes ----------------------------------------------------------------------
    drawEyes(ctx, t) {
      const VC = this.VC;
      const S = this.S;
      const sx = S.sx.x + this.jitterX, sy = S.sy.x + this.jitterY;
      const ex = S.gx.x + sx - S.tx.v * 0.012 + 0.9 * Math.sin(t * 2.3) + 0.6 * Math.sin(t * 5.1) + Math.sin(S.yw.x) * 80;
      const ey = S.gy.x + sy - S.ty.v * 0.01 + 0.7 * Math.sin(t * 1.9 + 1) - S.pt.x * 70;
      const br = 1 + 0.02 * Math.sin(t * 1.6) + 8e-3 * Math.sin(t * 3.7);
      const w = S.ew.x * (1 + (1 - S.bl.x) * 0.12) * br;
      const hl = Math.max(0.05, S.eL.x * S.bl.x);
      const hr = Math.max(0.05, S.eR.x * S.bl.x);
      ctx.save();
      ctx.translate(ex, ey);
      this.drawEye(ctx, -31, -12, S.sep.x, S.tilt.x, w, hl);
      this.drawEye(ctx, 31, -12, S.sep.x, -S.tilt.x, w, hr);
      ctx.restore();
      if (VC.ld > 0.01) {
        const bob = -2.5 * Math.sin(t * 1.4);
        ctx.save();
        ctx.globalAlpha = clamp2(VC.ld, 0, 1);
        ctx.strokeStyle = "#E4FCFF";
        ctx.lineWidth = 4;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(-45, -49 + bob);
        ctx.quadraticCurveTo(-31, -57 + bob, -17, -49 + bob);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(17, -49 - bob);
        ctx.quadraticCurveTo(31, -57 - bob, 45, -49 - bob);
        ctx.stroke();
        ctx.restore();
      }
    }
    drawEye(ctx, ecx, ecy, sep, tilt, w, h) {
      const VC = this.VC;
      ctx.save();
      ctx.translate(ecx * sep, ecy);
      ctx.rotate(tilt * Math.PI / 180);
      ctx.scale(w, h);
      const eg = ctx.createRadialGradient(0, 0, 0, 0, 0, 43);
      const gl = VC.gl;
      eg.addColorStop(0, `rgba(${gl[0] | 0},${gl[1] | 0},${gl[2] | 0},0.75)`);
      eg.addColorStop(1, `rgba(${gl[0] | 0},${gl[1] | 0},${gl[2] | 0},0)`);
      ctx.fillStyle = eg;
      ctx.beginPath();
      ctx.ellipse(0, 0, 33, 43, 0, 0, Math.PI * 2);
      ctx.fill();
      const et = VC.et, eb = VC.eb;
      const cg = ctx.createLinearGradient(0, -23, 0, 23);
      cg.addColorStop(0, rgbStr(et));
      cg.addColorStop(1, rgbStr(eb));
      ctx.fillStyle = cg;
      rrPath(ctx, -11.5, -23, 23, 46, 11.5);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.ellipse(-5.5, -11, 3.3, 7.5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      ctx.arc(1, 15, 2.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.restore();
    }
    /**
     * The pose-z shard gallery face (source frame() L225 + PJ L218).
     *
     * A gallery row is a set of shard shapes projected onto the orb sphere: each
     * element's (data-x, data-y) is read as a longitude/latitude offset from the
     * gaze, the 3-D point is projected to 2-D, and the shape is scaled by depth so
     * the far shards are smaller and dimmer. When a gallery face is showing it
     * REPLACES the eyes (the source hides eL/eR in `selPose`), so `draw()` calls
     * this instead of `drawEyes` while `galleryKey` is set.
     */
    drawGallery(ctx, t) {
      const key = this.galleryKey;
      if (key === null) return;
      const pq = clamp2(this.S.pq.x, 0, 1);
      if (pq <= 0.01) return;
      const row = PZ[key];
      if (row === void 0) return;
      const els = parseGallery(row);
      const c4 = rgbStr(this.VC.et);
      const lo = (this.S.gx.x + this.S.sx.x) * 1.7 * Math.PI / 180 + this.S.yw.x;
      const la = -(this.S.gy.x + this.S.sy.x) * 1.5 * Math.PI / 180 + this.S.pt.x;
      const pk = 2.2 * this.S.pa.x * this.S.ho.x * (1 + 0.02 * Math.sin(t * 1.6));
      const bl = Math.max(0.05, this.S.bl.x);
      ctx.save();
      ctx.globalAlpha = pq;
      els.forEach((el, i) => {
        const lon = lo + el.ex * 2.2 / 150 + 0.015 * Math.sin(t * 0.8 + i * 1.7);
        const lat = la - el.ey * 2.2 / 150 + 0.015 * Math.sin(t * 1.1 + i * 2.3);
        const ct = Math.cos(lat);
        const X = 150 * ct * Math.sin(lon);
        const Y = -150 * Math.sin(lat);
        const Z = ct * Math.cos(lon);
        const th = Math.atan2(Y, X) * 180 / Math.PI;
        ctx.save();
        ctx.translate(X, Y);
        ctx.rotate(th * Math.PI / 180);
        ctx.scale(Math.max(0.12, Z), 1);
        ctx.rotate(-th * Math.PI / 180);
        ctx.scale(pk, pk * bl);
        ctx.globalAlpha = pq * Math.max(0, Math.min(1, Z * 5));
        drawGalEl(ctx, el, c4);
        ctx.restore();
      });
      ctx.restore();
    }
    drawGlasses(ctx, t) {
      if (this.VC.gs <= 0.01) return;
      ctx.save();
      ctx.globalAlpha = clamp2(this.VC.gs, 0, 1);
      ctx.strokeStyle = "#10285a";
      ctx.lineWidth = 6;
      ctx.lineCap = "round";
      for (const s of [-1, 1]) {
        ctx.fillStyle = "rgba(207,238,255,0.14)";
        ctx.beginPath();
        ctx.arc(s * 48, -2, 46, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.moveTo(-3, -8);
      ctx.quadraticCurveTo(0, -13, 3, -8);
      ctx.moveTo(-93, -12);
      ctx.lineTo(-141, -24);
      ctx.moveTo(93, -12);
      ctx.lineTo(141, -24);
      ctx.stroke();
      ctx.restore();
      void t;
    }
    // Working badge -------------------------------------------------------------
    drawWorkingBadge(ctx, t) {
      const target = this.pose === "working" || this.pose === "executing" ? 1 : 0;
      this.S.wb.t = target;
      const s = this.S.wb.x;
      if (s <= 0.02) return;
      ctx.save();
      ctx.globalAlpha = clamp2(s, 0, 1);
      ctx.translate(-130, -134);
      ctx.scale(0.4 + 0.6 * s, 0.4 + 0.6 * s);
      ctx.translate(130, 134);
      ctx.fillStyle = "#3f9cff";
      ctx.strokeStyle = "#bfe3ff";
      ctx.lineWidth = 1.5;
      rrPath(ctx, -176, -148, 94, 28, 14);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#fff";
      ctx.font = "600 13px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("Working", -146, -133);
      for (let i = 0; i < 3; i++) {
        ctx.globalAlpha = clamp2(s, 0, 1) * (0.25 + 0.75 * (0.5 + 0.5 * Math.sin(t * 5.2 - i * 1.4)));
        ctx.beginPath();
        ctx.arc(-104 + i * 7, -134, 2.4, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
    // Success rings + glitch ----------------------------------------------------
    drawSuccessRings(ctx, t) {
      if (this.VC.rg <= 0.01) return;
      ctx.save();
      for (let i = 1; i < 3; i++) {
        const ph = (t * 0.8 + i * 0.5) % 1;
        ctx.strokeStyle = rgbStr(this.VC.tc);
        ctx.globalAlpha = clamp2(this.VC.rg * 0.7 * (1 - ph), 0, 1);
        ctx.lineWidth = i === 1 ? 3 : 2;
        ctx.beginPath();
        ctx.arc(0, 0, 150 + ph * 46, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }
    drawGlitch(ctx, t) {
      if (this.VC.gt <= 0.05) return;
      const gk = Math.floor(t * 12);
      if (gk !== this.glitchIdx) {
        this.glitchIdx = gk;
        this.glitchRects = Array.from({ length: 5 }, () => {
          const sd = Math.random() < 0.5 ? -1 : 1;
          return { x: sd < 0 ? -190 + Math.random() * 40 : 150 + Math.random() * 40, y: (Math.random() - 0.5) * 230, w: 20 + Math.random() * 45, o: Math.random() < 0.3 ? 0 : 0.9 };
        });
      }
      ctx.save();
      ctx.globalAlpha = clamp2(this.VC.gt, 0, 1);
      ctx.fillStyle = "#FF4A55";
      for (const r of this.glitchRects) {
        ctx.globalAlpha = clamp2(this.VC.gt, 0, 1) * r.o;
        ctx.fillRect(r.x, r.y, r.w, 3);
      }
      ctx.restore();
    }
    glitchRects = [];
    // Specular ------------------------------------------------------------------
    drawSpec(ctx, t) {
      const lo = this.S.gx.x * (Math.PI / 180) * 1.7 + this.S.yw.x;
      const la = -(this.S.gy.x * (Math.PI / 180)) * 1.5 + this.S.pt.x;
      let spx = -58 - lo * 34 + this.S.lx.x * 36;
      let spy = -96 + la * 26 + this.S.ly.x * 30;
      const d = Math.hypot(spx, spy);
      if (d > 118) {
        spx *= 118 / d;
        spy *= 118 / d;
      }
      ctx.save();
      ctx.translate(spx, spy);
      ctx.rotate(Math.atan2(spy, spx) + Math.PI / 2);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 28);
      g.addColorStop(0, "rgba(255,255,255,0.55)");
      g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(0, 0, 28, 10, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 0.75;
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.ellipse(0, 0, 11, 3.4, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      void t;
    }
    // Accessories ---------------------------------------------------------------
    drawAccessories(ctx, t, back) {
      if (!this.acParts.length) return;
      const cy = Math.cos(this.S.yw.x), sy = Math.sin(this.S.yw.x);
      const cp = Math.cos(this.S.pt.x), sp = Math.sin(this.S.pt.x);
      const bob = 5 * Math.sin(t * 2);
      const LDIR = [-0.45, 0.75, 0.55];
      const list = [];
      for (const p of this.acParts) {
        const pts = p.p, len = pts.length, y0 = p.bob ? bob : 0;
        const swp = p.sw ? 4 + 3 * Math.sin(t * 0.8) + 4 * Math.sin(t * 2.1 + p.ref[0] * 0.06) : 0;
        const P3 = [];
        let zs = 0, s = "";
        for (let j = 0; j < len; j++) {
          const q = pts[j];
          const wv = p.sw ? p.sw[j] : 0;
          const x = q[0] + wv * swp, y = q[1] + y0 - wv * Math.abs(swp) * 0.3, zz = q[2];
          const y1 = y * cp + zz * sp, z1 = -y * sp + zz * cp;
          const x2 = x * cy + z1 * sy, z2 = -x * sy + z1 * cy;
          P3.push([x2, y1, z2]);
          zs += z2;
          s += (j ? "L" : "M") + x2.toFixed(1) + " " + (-y1).toFixed(1);
        }
        const rf = p.ref, ry = rf[1] + y0;
        const ry1 = ry * cp + rf[2] * sp, rz1 = -ry * sp + rf[2] * cp;
        const rx2 = rf[0] * cy + rz1 * sy, rz2 = -rf[0] * sy + rz1 * cy;
        const a = P3[0], b = P3[1], c = P3[2];
        const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
        const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const nl = Math.hypot(nx, ny, nz) || 1;
        let mx = 0, my = 0, mz = 0;
        for (let j = 0; j < len; j++) {
          mx += P3[j][0];
          my += P3[j][1];
          mz += P3[j][2];
        }
        mx /= len;
        my /= len;
        mz /= len;
        nx /= nl;
        ny /= nl;
        nz /= nl;
        if (nx * (mx - rx2) + ny * (my - ry1) + nz * (mz - rz2) < 0) {
          nx = -nx;
          ny = -ny;
          nz = -nz;
        }
        const dl = Math.max(0, nx * LDIR[0] + ny * LDIR[1] + nz * LDIR[2]);
        const br = 0.5 + 0.7 * dl + 0.1 * Math.max(0, nz);
        const sg = Math.pow(Math.max(0, -0.3 * nx + 0.6 * ny + 0.75 * nz), 14) * 80;
        const rm = Math.pow(1 - Math.min(1, Math.abs(nz)), 3) * 45;
        const col = `rgb(${Math.min(255, p.c[0] * br + sg + rm * 0.4 | 0)},${Math.min(255, p.c[1] * br + sg + rm * 0.8 + 10 * (1 - dl) | 0)},${Math.min(255, p.c[2] * br + sg + rm + 34 * (1 - dl) | 0)})`;
        const z = zs / len;
        list.push({ d: s + "Z", col, z });
      }
      const grp = list.filter((r) => back ? r.z < 0 : r.z >= 0).sort((x, y) => x.z - y.z);
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - this.VC.sl);
      ctx.lineJoin = "round";
      ctx.lineWidth = 0.8;
      ctx.strokeStyle = "rgba(6,16,44,.38)";
      for (const r of grp) {
        ctx.fillStyle = r.col;
        ctx.beginPath();
        pathFrom(ctx, r.d);
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    }
    // Hands (source #hnd, L74 / L229-230) -----------------------------------------
    // Two white hand circles raised on success / awake / fight; the hl/hr/hv springs
    // are set by the SC step params (h:[1,1] on success/awake), so they appear from
    // the real pose sequence with no extra wiring.
    drawHands(ctx, t) {
      const hv = this.hands ? 1 : clamp2(this.S.hv.x, 0, 1);
      if (hv <= 0.02) return;
      const isf = this.pose === "fight";
      const JL = isf ? Math.pow(Math.max(0, Math.sin(t * 4.2)), 3) : 0;
      const JR = isf ? Math.pow(Math.max(0, -Math.sin(t * 4.2)), 3) : 0;
      const hLx = -154 - this.S.hl.x * 6 + 3 * Math.sin(t * 6.5) * this.S.hl.x + 85 * JL;
      const hLy = 78 - this.S.hl.x * 76 + 2.5 * Math.sin(t * 1.8) * this.S.hv.x;
      const hRx = 154 + this.S.hr.x * 6 - 3 * Math.sin(t * 6.5 + 1) * this.S.hr.x - 85 * JR;
      const hRy = 78 - this.S.hr.x * 76 + 2.5 * Math.sin(t * 1.8 + 1.5) * this.S.hv.x;
      ctx.save();
      ctx.globalAlpha = hv;
      ctx.fillStyle = "#fff";
      ctx.strokeStyle = "#bfe3ff";
      ctx.lineWidth = 2.5;
      for (const [x, y] of [[hLx, hLy], [hRx, hRy]]) {
        ctx.beginPath();
        ctx.arc(x, y, 10, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    }
    // Work props — laptop (source #lap, L76-80) and backpack (#bk, L81-85) --------
    // Opacity is the theme channel VC.lp / VC.bk, which the source lights for
    // working/ultra (lp) and waiting (bk); the y-offset slides them into place.
    drawProps(ctx, t) {
      const lp = this.laptop ? 1 : clamp2(this.VC.lp, 0, 1);
      const bk = this.backpack ? 1 : clamp2(this.VC.bk, 0, 1);
      if (lp > 0.02) {
        ctx.save();
        ctx.globalAlpha = lp;
        ctx.translate(0, (1 - lp) * 60 + 14);
        const lid = ctx.createLinearGradient(0, 66, 0, 158);
        lid.addColorStop(0, "#fff");
        lid.addColorStop(1, "#d6e3f2");
        ctx.fillStyle = lid;
        ctx.strokeStyle = "#c9d8ea";
        ctx.lineWidth = 2;
        rrPath(ctx, -100, 66, 200, 92, 12);
        ctx.fill();
        ctx.stroke();
        const hlg = ctx.createRadialGradient(0, 112, 0, 0, 112, 16);
        hlg.addColorStop(0, "rgba(255,255,255,0.55)");
        hlg.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = hlg;
        ctx.beginPath();
        ctx.arc(0, 112, 16, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#bfe3ff";
        ctx.beginPath();
        ctx.arc(0, 112, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(-120, 158);
        ctx.lineTo(120, 158);
        ctx.quadraticCurveTo(120, 173, 102, 173);
        ctx.lineTo(-102, 173);
        ctx.quadraticCurveTo(-120, 173, -120, 158);
        ctx.closePath();
        ctx.fillStyle = "#dce6f3";
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = "#fff";
        ctx.strokeStyle = "#bfe3ff";
        ctx.lineWidth = 2.5;
        for (const [hx, ph] of [[-60, 0], [60, 0.22]]) {
          const bob = 7 * Math.max(0, Math.sin((t / 0.45 + ph) % 1 * Math.PI));
          ctx.beginPath();
          ctx.arc(hx, 62 + bob, 14, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
        ctx.restore();
      }
      if (bk > 0.02) {
        ctx.save();
        ctx.globalAlpha = bk;
        ctx.translate(0, (1 - bk) * 70 + 5 * Math.sin(t * 2));
        ctx.fillStyle = "#fff6e0";
        ctx.strokeStyle = "#d8c9a0";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-70, 176);
        ctx.lineTo(78, 176);
        ctx.quadraticCurveTo(78, 186, 68, 186);
        ctx.lineTo(-68, 186);
        ctx.quadraticCurveTo(-78, 186, -78, 176);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        const bkg = ctx.createLinearGradient(-78, 76, 78, 180);
        bkg.addColorStop(0, "#e2604a");
        bkg.addColorStop(1, "#a63628");
        ctx.fillStyle = bkg;
        rrPath(ctx, -78, 76, 156, 104, 9);
        ctx.fill();
        ctx.fillStyle = "rgba(0,0,0,0.22)";
        rrPath(ctx, -78, 76, 14, 104, 7);
        ctx.fill();
        ctx.strokeStyle = "#ffe08a";
        ctx.lineWidth = 3.5;
        ctx.beginPath();
        ctx.arc(8, 112, 15, 0, Math.PI * 2);
        ctx.stroke();
        ctx.lineWidth = 4;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(-34, 148);
        ctx.lineTo(50, 148);
        ctx.moveTo(-20, 160);
        ctx.lineTo(36, 160);
        ctx.stroke();
        ctx.fillStyle = "#fff";
        ctx.strokeStyle = "#bfe3ff";
        ctx.lineWidth = 2.5;
        for (const hx of [-86, 86]) {
          ctx.beginPath();
          ctx.arc(hx, 152, 14, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
        ctx.restore();
      }
    }
    // 3-D eye rig (source #e3, L66 / L226-228) ------------------------------------
    // Alternate projected eyes placed on the sphere; replaces the flat eyes while
    // `eyeMode3` is on. Uses the same PJ projection as the accessories/gallery.
    drawEyeMode3(ctx, t) {
      const m3 = clamp2(this.S.m3.x, 0, 1);
      const pq = clamp2(this.S.pq.x, 0, 1);
      const glob = m3 * (1 - pq);
      if (glob <= 0.01) return;
      const S = this.S;
      const ro = S.ro.x, cv = S.cv.x, dg = S.dg.x;
      const br = 1 + 0.02 * Math.sin(t * 1.6) + 8e-3 * Math.sin(t * 3.7);
      const lo = (S.gx.x + S.sx.x) * 1.7 * Math.PI / 180 + S.yw.x;
      const la = -(S.gy.x + S.sy.x) * 1.5 * Math.PI / 180 + S.pt.x;
      const sh3cx = -45 - lo * 40 + S.lx.x * 50, sh3cy = -55 + la * 40 + S.ly.x * 50;
      const wash = ctx.createRadialGradient(sh3cx, sh3cy, 0, sh3cx, sh3cy, 230);
      wash.addColorStop(0, "rgba(255,255,255,0.5)");
      wash.addColorStop(0.3, "rgba(255,255,255,0.06)");
      wash.addColorStop(0.6, "rgba(2,6,26,0)");
      wash.addColorStop(1, "rgba(10,63,184,0.3)");
      ctx.save();
      ctx.globalAlpha = m3;
      ctx.beginPath();
      ctx.arc(0, 0, 150, 0, Math.PI * 2);
      ctx.fillStyle = wash;
      ctx.fill();
      const r3cx = -20 - lo * 22 + S.lx.x * 30, r3cy = -25 + la * 22 + S.ly.x * 30;
      const rim3 = ctx.createRadialGradient(r3cx, r3cy, 0, r3cx, r3cy, 168);
      rim3.addColorStop(0.8, "rgba(143,230,255,0)");
      rim3.addColorStop(1, "rgba(143,230,255,0.65)");
      ctx.globalAlpha = m3;
      ctx.beginPath();
      ctx.arc(0, 0, 150, 0, Math.PI * 2);
      ctx.fillStyle = rim3;
      ctx.fill();
      ctx.restore();
      for (const sg of [-1, 1]) {
        const lon = lo + sg * (0.27 * S.sep.x - 0.3 * cv) - sg * dg + ro * 0.5 * Math.cos(t * 7 + sg * 0.8);
        const lat = la + 0.06 + ro * 0.35 * Math.sin(t * 7 + sg * 0.8);
        const sxk = S.ew.x * br * S.ho.x;
        const syk = (sg < 0 ? S.eL.x : S.eR.x) * S.ho.x * Math.max(0.05, S.bl.x);
        const rot = sg < 0 ? S.tilt.x : -S.tilt.x;
        const ct = Math.cos(lat);
        const X = 150 * ct * Math.sin(lon), Y = -150 * Math.sin(lat), Z = ct * Math.cos(lon);
        const th = Math.atan2(Y, X);
        ctx.save();
        ctx.globalAlpha = glob * Math.max(0, Math.min(1, Z * 5));
        ctx.translate(X, Y);
        ctx.rotate(th);
        ctx.scale(Math.max(0.12, Z), 1);
        ctx.rotate(-th);
        ctx.rotate(rot * Math.PI / 180);
        ctx.scale(sxk, syk);
        ctx.fillStyle = "rgba(6,26,69,0.2)";
        ctx.beginPath();
        ctx.ellipse(0, 4, 21, 31, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = rgbStr(this.VC.et);
        ctx.beginPath();
        ctx.ellipse(0, 0, 15, 24, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = glob * Math.max(0, Math.min(1, Z * 5)) * 0.6;
        ctx.fillStyle = "#fff";
        ctx.beginPath();
        ctx.ellipse(-3, -9, 4, 8, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }
    // Shard / shell break-apart (source #crk/#shards/#shell, L64-65, L266-273) ----
    /** Renders the intact body (or the simplified shell) into a 400×400 bitmap. */
    renderBitmap(t, shell) {
      const c = document.createElement("canvas");
      c.width = 400;
      c.height = 400;
      const x = c.getContext("2d");
      if (x) {
        x.translate(200, 200);
        if (shell) this.drawShell(x);
        else this.drawBody(x, t);
      }
      return c;
    }
    /** The source's #shb — a simplified shell body used by the flying wedges. */
    drawShell(ctx) {
      const g = ctx.createRadialGradient(0, -12, 0, 0, -12, 159);
      g.addColorStop(0, "#1F5FDB");
      g.addColorStop(0.6, "#2E80F4");
      g.addColorStop(0.92, "#63BCFF");
      g.addColorStop(1, "#B9E8FF");
      ctx.beginPath();
      ctx.arc(0, 0, 150, 0, Math.PI * 2);
      ctx.fillStyle = g;
      ctx.fill();
      ctx.save();
      ctx.globalAlpha = 0.28;
      ctx.fillStyle = this.dotPattern(ctx, SKN[this.skin].dot);
      ctx.beginPath();
      ctx.arc(0, 0, 148, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = "rgba(214,245,255,0.75)";
      ctx.beginPath();
      ctx.arc(0, 0, 148.5, 0, Math.PI * 2);
      ctx.stroke();
    }
    shardGeom() {
      const angles = [0, 52, 108, 160, 218, 268, 318, 360].map((a) => a * Math.PI / 180);
      const wd = [];
      for (let q = 0; q < 7; q++) {
        const am = (angles[q] + angles[q + 1]) / 2;
        wd.push([Math.cos(am), Math.sin(am), (q % 2 ? 1 : -1) * (2 + q % 3)]);
      }
      return { angles, wd };
    }
    clipWedge(ctx, a0, a1) {
      const am = (a0 + a1) / 2;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(400 * Math.cos(a0), 400 * Math.sin(a0));
      ctx.lineTo(400 * Math.cos(am), 400 * Math.sin(am));
      ctx.lineTo(400 * Math.cos(a1), 400 * Math.sin(a1));
      ctx.closePath();
      ctx.clip();
    }
    /** Red crack glow behind the flying shards (source #crk). */
    drawCrack(ctx, t) {
      const sl = clamp2(this.VC.sl, 0, 1);
      if (sl <= 0.01) return;
      ctx.save();
      ctx.globalAlpha = clamp2(sl * (0.5 + 0.15 * Math.sin(t * 2)), 0, 1);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 125);
      g.addColorStop(0, "rgba(255,59,74,0.8)");
      g.addColorStop(1, "rgba(255,59,74,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, 125, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    /** Seven body slices fly outward (sl) / a shell ring shifts slightly (sh). */
    drawShards(ctx, t) {
      const sl = clamp2(this.VC.sl, 0, 1), sh = clamp2(this.VC.sh, 0, 1);
      if (sl <= 0.01 && sh <= 0.01) return;
      const { angles, wd } = this.shardGeom();
      if (sl > 0.01) {
        const bmp = this.renderBitmap(t, false);
        ctx.save();
        ctx.globalAlpha = sl;
        for (let q = 0; q < 7; q++) {
          const o = sl * (12 + 2 * Math.sin(t * 0.9 + q));
          ctx.save();
          ctx.translate(wd[q][0] * o, wd[q][1] * o);
          ctx.rotate((wd[q][2] * sl + 0.6 * sl * Math.sin(t * 0.8 + q)) * Math.PI / 180);
          this.clipWedge(ctx, angles[q], angles[q + 1]);
          ctx.drawImage(bmp, -200, -200);
          ctx.restore();
        }
        ctx.restore();
      }
      if (sh > 0.01) {
        const bmp = this.renderBitmap(t, true);
        ctx.save();
        ctx.globalAlpha = sh;
        for (let q = 0; q < 7; q++) {
          ctx.save();
          ctx.translate(wd[q][0] * 7, wd[q][1] * 7);
          ctx.rotate(wd[q][2] * 0.4 * Math.PI / 180);
          this.clipWedge(ctx, angles[q], angles[q + 1]);
          ctx.drawImage(bmp, -200, -200);
          ctx.restore();
        }
        ctx.restore();
      }
    }
    // ── Helpers ─────────────────────────────────────────────────────────────────
    dotPattern(ctx, color) {
      if (this.dotKey !== color || !this.dotCanvas) {
        const c = document.createElement("canvas");
        c.width = 6;
        c.height = 6;
        const x = c.getContext("2d");
        if (x) {
          x.fillStyle = color;
          x.beginPath();
          x.arc(3, 3, 0.8, 0, Math.PI * 2);
          x.fill();
        }
        this.dotCanvas = c;
        this.dotKey = color;
      }
      return ctx.createPattern(this.dotCanvas, "repeat") ?? color;
    }
  };
  function rrPath(ctx, X, Y, W, H, R) {
    const r = Math.max(0, Math.min(R, W / 2, H / 2));
    ctx.beginPath();
    ctx.moveTo(X + r, Y);
    ctx.arcTo(X + W, Y, X + W, Y + H, r);
    ctx.arcTo(X + W, Y + H, X, Y + H, r);
    ctx.arcTo(X, Y + H, X, Y, r);
    ctx.arcTo(X, Y, X + W, Y, r);
    ctx.closePath();
  }
  function pathFrom(ctx, d) {
    const parts = d.split(/(?=[MLZ])/);
    for (const seg of parts) {
      const cmd = seg[0];
      if (cmd === "M") {
        const [x, y] = seg.slice(1).trim().split(" ").map(Number);
        ctx.moveTo(x, y);
      } else if (cmd === "L") {
        const [x, y] = seg.slice(1).trim().split(" ").map(Number);
        ctx.lineTo(x, y);
      } else if (cmd === "Z") ctx.closePath();
    }
  }
  function hexA(hex, a) {
    const h = hex.replace("#", "");
    const v = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
    return `rgba(${v >> 16 & 255},${v >> 8 & 255},${v & 255},${a})`;
  }

  // src/character/engine.ts
  var EMOTE_EXPR = {
    love: "happy",
    surprised: "surprised",
    proud: "determined",
    wink: "sideglance",
    yawn: "sleepy",
    happy: "happy",
    annoyed: "skeptical"
  };
  var now = () => performance.now() / 1e3;
  var lin = (t) => t;
  var KaiEngine = class {
    isMini = false;
    /** Flat fill for mini bots and integration pills; null = KAI's own orb. */
    bodyColor = null;
    // ── Legacy animated scalars, kept because call sites still read/write them ──
    yaw = 0;
    pitch = 0;
    roll = 0;
    tilt = 0;
    open = 1;
    sx = 1;
    sy = 1;
    oy = 0;
    ox = 0;
    tint = 0;
    morph = 0;
    orbit = 0;
    blush = 0;
    es = 1;
    badgeS = 0;
    tgYaw = 0;
    tgPitch = 0;
    tgTilt = 1;
    tgSy = 1;
    tgSx = 1;
    tgEs = 1;
    /** Extra canvas height above the body so the shadow/halo can fly out unclipped. */
    particleOverhang = 0;
    /** Legacy intake-aperture fields (the orb has no aperture; kept for the API). */
    slotH = 0;
    slotHTarget = 0;
    slotHVel = 0;
    isChewing = false;
    col = BOT_STATES.idle.color;
    colT = BOT_STATES.idle.color;
    state = "idle";
    cfg = BOT_STATES.idle;
    eyeOverride = null;
    eyeOverrideUntil = 0;
    permanentEye = null;
    permanentEmote = null;
    badge = null;
    badgeKey = "none";
    badgeToken = 0;
    tweens = /* @__PURE__ */ new Map();
    locks = /* @__PURE__ */ new Set();
    lookX = 0;
    lookY = 0;
    lastTime = now();
    waveUntil = 0;
    waveStart = 0;
    greetToken = 0;
    slapTimes = [];
    /** Three slaps inside 1.7 s → dizzy. */
    onDizzy = null;
    /** The ported orb renderer. */
    orb = new KaiOrb();
    // ── Public API ──────────────────────────────────────────────────────────────
    /**
     * Sets the character state. Accepts the directive's full state set (IDLE,
     * LISTENING, THINKING, PLANNING, WORKING, USING_TOOL, DELEGATING, WAITING,
     * WAITING_APPROVAL, SUCCESS, ERROR, OFFLINE) in either case, plus the legacy
     * `BotStateName` values, which still typecheck. See `KAI_STATE_POSE` for the
     * auditable state → pose mapping.
     */
    setState(next, force = false) {
      const key = String(next).toLowerCase();
      if (this.state === key && !force) return;
      const prev = this.state;
      this.state = key;
      this.cfg = BOT_STATES[key] ?? BOT_STATES.idle;
      this.colT = this.cfg.color;
      this.tgTilt = this.cfg.tilt;
      this.setBadge(this.cfg.badge);
      const sound = STATE_SOUND[key];
      if (sound && !this.isMini && prev !== key) Sound.play(sound);
      this.orb.go(poseForState(key));
    }
    /** Selects one of the eight accessories (hair / cap / bat / phones / cat / crown / halo / none). */
    setAccessory(name) {
      this.orb.setAccessory(name);
    }
    /** Selects one of the three skins (blue / black / yellow). */
    setSkin(skin) {
      this.orb.setSkin(skin);
    }
    /**
     * 3-D eye rig toggle — the source's "3D" button (L390). Additive: the flat
     * expression eyes are the default and come back when this is false.
     */
    setEyeMode3(on) {
      this.orb.setEyeMode3(on);
    }
    /** Shows one of the 30 pose-z gallery faces (PZ key, e.g. "S1"). */
    showGallery(key) {
      this.orb.showGallery(key);
    }
    clearGallery() {
      this.orb.clearGallery();
    }
    /** Work props — laptop / backpack / hands (source #lap/#bk/#hnd). */
    setProps(p) {
      this.orb.setProps(p);
    }
    /** Direct shard/shell break-apart levels, 0…1 (source VC.sl / VC.sh). */
    setShatter(sl, sh) {
      this.orb.setShatter(sl, sh);
    }
    /** A timed break-apart: crack → shards fly → shell → reassemble. */
    shatter() {
      this.orb.shatter();
    }
    /** The live orb renderer, for verification harnesses (read-only). */
    get renderer() {
      return this.orb;
    }
    setBadge(b) {
      const key = b ? `${b.kind}:${b.color.join(",")}` : "none";
      if (key === this.badgeKey) return;
      this.badgeKey = key;
      this.badge = b;
      const token = ++this.badgeToken;
      if (b) this.anim("badgeS", [[1.15, 180, lin], [1, 160, lin]]);
      else this.anim("badgeS", [[0, 140, lin]], () => {
        if (token === this.badgeToken) this.badgeS = 0;
      });
    }
    blink() {
      this.orb.blink();
    }
    squash() {
      this.orb.kickSquash(0.14, 0);
    }
    gulp() {
      this.isChewing = true;
      this.orb.kickSquash(-0.16, -120);
      this.orb.express("surprised", 260);
      window.setTimeout(() => {
        this.isChewing = false;
      }, 260);
    }
    slap() {
      this.orb.kickSquash(0.12, -120);
      const t = now();
      this.slapTimes = this.slapTimes.filter((s) => t - s < 1.7);
      this.slapTimes.push(t);
      if (this.slapTimes.length >= 3) {
        this.slapTimes = [];
        this.setState("dizzy", true);
        this.onDizzy?.();
      }
    }
    doRoll(durationMs, _turns) {
      this.orb.roll(durationMs);
    }
    /** KAI "wakes up": a bright attentive glance and a slow settle. */
    greet() {
      const token = ++this.greetToken;
      this.waveStart = now();
      this.waveUntil = now() + 2.2;
      this.orb.go("awake");
      window.setTimeout(() => {
        if (token === this.greetToken) this.orb.express("happy", 700);
      }, 620);
    }
    interruptGreet() {
      this.greetToken++;
      this.waveUntil = 0;
      this.es = 1;
      this.orb.go("idle");
    }
    setPermanentEmote(emote) {
      this.permanentEmote = emote;
      this.permanentEye = emote ? EMOTE_EYE[emote] : null;
      if (emote) {
        this.eyeOverride = EMOTE_EYE[emote];
        this.eyeOverrideUntil = Number.POSITIVE_INFINITY;
      } else {
        this.eyeOverride = null;
        this.eyeOverrideUntil = 0;
      }
    }
    triggerEmote(emote, duration = 1.8) {
      this.orb.express(EMOTE_EXPR[emote], duration * 1e3);
    }
    /** Legacy particle hook — the orb draws no shards, so this is a no-op. */
    emit(_type, _count) {
    }
    /** Legacy aperture morph — the orb has no intake; the value is retained. */
    animateMorph(target, _durationMs = 260) {
      this.morph = Math.max(0, Math.min(1, target));
    }
    resetMorph() {
      this.morph = 0;
      this.tweens.delete("morph");
      this.locks.delete("morph");
    }
    anim(prop, keys, onComplete) {
      this.tweens.set(prop, { prop, keys, index: 0, from: this[prop], startMs: performance.now(), onComplete });
      this.locks.add(prop);
    }
    // ── Update ──────────────────────────────────────────────────────────────────
    update(dt) {
      const nowMs = performance.now();
      for (const tw of [...this.tweens.values()]) {
        const k = tw.keys[tw.index];
        const p = Math.min(1, Math.max(0, (nowMs - tw.startMs) / k[1]));
        this[tw.prop] = tw.from + (k[0] - tw.from) * k[2](p);
        if (p >= 1) {
          tw.from = k[0];
          tw.index += 1;
          tw.startMs = nowMs;
          if (tw.index >= tw.keys.length) {
            this.tweens.delete(tw.prop);
            this.locks.delete(tw.prop);
            tw.onComplete?.();
          }
        }
      }
      this.orb.lookX = this.lookX;
      this.orb.lookY = this.lookY;
      this.orb.update(dt);
      this.lastTime = now();
    }
    /** True while anything is still moving — lets the island stop its RAF loop. */
    get busy() {
      return this.tweens.size > 0 || this.orb.busy;
    }
    // ── Draw ────────────────────────────────────────────────────────────────────
    draw(x, W, H) {
      if (typeof window !== "undefined" && !this.isMini) {
        window.__kaiEngine = this;
      }
      const R = W * 0.3;
      const cx = W / 2 + this.ox * R;
      const cy = H / 2 + this.particleOverhang / 2 + this.oy * R;
      const bodyColor = this.bodyColor ? [this.bodyColor[0] * 255, this.bodyColor[1] * 255, this.bodyColor[2] * 255] : null;
      this.orb.draw(x, cx, cy, R, { bodyColor, mini: this.isMini });
    }
  };

  // src/character/canvas-view.ts
  var OVERHANG_DEFAULT = 0;
  var BODY_RATIO = 0.6;
  function dpr() {
    const d = typeof window !== "undefined" ? window.devicePixelRatio : 1;
    return Math.min(2, d || 1);
  }
  var mounted = /* @__PURE__ */ new Set();
  var rafHandle = 0;
  var lastFrame = 0;
  var pageHidden = false;
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      pageHidden = document.hidden;
      if (!pageHidden) lastFrame = performance.now();
    });
  }
  function tick(now2) {
    const dt = Math.min(0.05, Math.max(0, (now2 - lastFrame) / 1e3));
    lastFrame = now2;
    for (const view of mounted) view.frame(dt);
    rafHandle = requestAnimationFrame(tick);
  }
  function ensureLoop() {
    if (rafHandle !== 0 || typeof requestAnimationFrame !== "function") return;
    lastFrame = performance.now();
    rafHandle = requestAnimationFrame(tick);
  }
  function maybeStopLoop() {
    if (mounted.size === 0 && rafHandle !== 0) {
      cancelAnimationFrame(rafHandle);
      rafHandle = 0;
    }
  }
  var CharacterCanvasImpl = class {
    wrapper;
    el;
    engine = new KaiEngine();
    cssW;
    cssH;
    scale;
    disposed = false;
    constructor(options) {
      const size = Math.max(8, options.size);
      const overhang = options.overhang ?? OVERHANG_DEFAULT;
      this.cssW = size / BODY_RATIO;
      this.cssH = this.cssW + overhang;
      this.scale = dpr();
      this.engine.particleOverhang = overhang;
      if (options.mini === true) {
        this.engine.isMini = true;
        if (options.color !== void 0) this.engine.bodyColor = hexToRGB(options.color);
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
      if (options.hue !== void 0) wrapper.style.filter = `hue-rotate(${options.hue}deg)`;
      if (options.title !== void 0) wrapper.title = options.title;
      wrapper.append(canvas);
      this.wrapper = wrapper;
      this.el = canvas;
      mounted.add(this);
      ensureLoop();
    }
    frame(dt) {
      if (this.disposed) return;
      this.engine.update(dt);
      if (pageHidden) return;
      const ctx = this.el.getContext("2d");
      if (ctx === null) return;
      ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
      ctx.clearRect(0, 0, this.cssW, this.cssH);
      this.engine.draw(ctx, this.cssW, this.cssH);
    }
    setLook(x, y) {
      this.engine.lookX = Math.max(-1, Math.min(1, x));
      this.engine.lookY = Math.max(-1, Math.min(1, y));
    }
    boop() {
      this.engine.squash();
    }
    dispose() {
      if (this.disposed) return;
      this.disposed = true;
      mounted.delete(this);
      maybeStopLoop();
    }
  };
  function mountCharacterCanvas(options) {
    return new CharacterCanvasImpl(options);
  }
  function applyAppearanceToCanvas(handle, variant) {
    handle.engine.setSkin(variant.skin);
    handle.engine.setAccessory(variant.accessory);
  }
  return __toCommonJS(kai_character_entry_exports);
})();
