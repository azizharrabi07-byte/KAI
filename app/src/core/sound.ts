// KAI's audio — synthesised at runtime, sample-free.
//
// KAI ships no audio files. Every sound is generated with WebAudio oscillators
// and a short noise buffer, from the recipe table below, so the whole sound
// palette is original KAI audio with nothing sampled or copied from anywhere.
//
// The API is the same shape the rest of the app already calls (`Sound.play`,
// `Sound.resume`, `Sound.idle`, `Sound.setEnabled`, `Sound.setVolume`,
// `Sound.preload`), so call sites never need to know how the sound is made.
//
// Default volume 0.12 with a 0 … 0.2 range, matching the settings slider.
//
// MIT.

export const SOUND_NAMES = [
  "peek", "open", "close", "hover", "blip", "slap", "annoyed", "dizzy", "greet",
  "work", "finish", "error", "approval", "question", "approve", "gulp", "tick",
  "send", "love", "pop", "proud", "wink", "yawn", "attach", "think", "search",
  "rate", "sleep",
] as const;

export type SoundName = (typeof SOUND_NAMES)[number];

type Wave = OscillatorType;

interface Recipe {
  /** Start/end frequency in Hz — a slide when they differ. */
  f0: number;
  f1: number;
  /** Seconds. */
  dur: number;
  wave: Wave;
  /** Peak linear gain before the master volume. */
  gain: number;
  /** 0…1 wet noise layer mixed under the tone (gives the "material" click). */
  noise?: number;
  /** Optional low-pass cutoff, Hz. */
  lp?: number;
  /** Detuned voice count — reads as one thicker voice rather than a chord. */
  voices?: number;
  /** Second, delayed tone: [delaySec, freq, durSec, gain]. */
  tail?: readonly [number, number, number, number];
}

// KAI's own voices, tuned by ear: the low ones are ambient, the mid ones are the
// confident UI ticks, the noisy pair is the "something hit the shell" family.
const RECIPES: Record<SoundName, Recipe> = {
  peek: { f0: 720, f1: 1180, dur: 0.075, wave: "sine", gain: 0.5 },
  open: { f0: 300, f1: 760, dur: 0.16, wave: "triangle", gain: 0.5, lp: 3200 },
  close: { f0: 660, f1: 250, dur: 0.15, wave: "triangle", gain: 0.46, lp: 2600 },
  hover: { f0: 1420, f1: 1560, dur: 0.035, wave: "sine", gain: 0.16 },
  blip: { f0: 900, f1: 900, dur: 0.05, wave: "square", gain: 0.18, lp: 2400 },
  slap: { f0: 220, f1: 90, dur: 0.11, wave: "square", gain: 0.5, noise: 0.6, lp: 1400 },
  annoyed: { f0: 320, f1: 240, dur: 0.2, wave: "sawtooth", gain: 0.3, lp: 1600, voices: 2 },
  dizzy: { f0: 520, f1: 120, dur: 0.5, wave: "triangle", gain: 0.34, voices: 2 },
  greet: {
    f0: 520, f1: 900, dur: 0.22, wave: "sine", gain: 0.46,
    tail: [0.1, 1320, 0.26, 0.3],
  },
  work: { f0: 240, f1: 300, dur: 0.1, wave: "sawtooth", gain: 0.24, lp: 1500 },
  finish: {
    f0: 780, f1: 1180, dur: 0.16, wave: "sine", gain: 0.44,
    tail: [0.1, 1560, 0.3, 0.3],
  },
  error: { f0: 340, f1: 150, dur: 0.3, wave: "sawtooth", gain: 0.4, voices: 2, lp: 1800 },
  approval: {
    f0: 620, f1: 620, dur: 0.1, wave: "square", gain: 0.32, lp: 2600,
    tail: [0.13, 840, 0.16, 0.3],
  },
  question: { f0: 640, f1: 1080, dur: 0.18, wave: "triangle", gain: 0.36 },
  approve: {
    f0: 700, f1: 1050, dur: 0.11, wave: "sine", gain: 0.42,
    tail: [0.07, 1400, 0.18, 0.26],
  },
  gulp: { f0: 420, f1: 120, dur: 0.22, wave: "sine", gain: 0.42, lp: 900 },
  tick: { f0: 1800, f1: 1800, dur: 0.02, wave: "square", gain: 0.14, lp: 5000 },
  send: { f0: 560, f1: 980, dur: 0.13, wave: "triangle", gain: 0.38 },
  love: {
    f0: 880, f1: 1320, dur: 0.2, wave: "sine", gain: 0.38,
    tail: [0.12, 1760, 0.3, 0.24],
  },
  pop: { f0: 1100, f1: 520, dur: 0.06, wave: "sine", gain: 0.34 },
  proud: {
    f0: 620, f1: 930, dur: 0.14, wave: "sine", gain: 0.36,
    tail: [0.09, 1240, 0.34, 0.3],
  },
  wink: { f0: 1200, f1: 700, dur: 0.07, wave: "square", gain: 0.2, lp: 3400 },
  yawn: { f0: 500, f1: 200, dur: 0.55, wave: "sine", gain: 0.3, lp: 1200 },
  attach: { f0: 380, f1: 620, dur: 0.12, wave: "triangle", gain: 0.36, noise: 0.25 },
  think: { f0: 440, f1: 470, dur: 0.26, wave: "sine", gain: 0.2, voices: 2 },
  search: { f0: 900, f1: 520, dur: 0.22, wave: "triangle", gain: 0.24 },
  rate: { f0: 300, f1: 500, dur: 0.4, wave: "sawtooth", gain: 0.3, voices: 2, lp: 1500 },
  sleep: { f0: 300, f1: 170, dur: 0.6, wave: "sine", gain: 0.26, lp: 900 },
};

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

class SoundEngine {
  enabled = true;
  volume = 0.12;

  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private loading: Promise<void> | null = null;
  private idleTimer: number | null = null;

  /** Creates the context and the shared noise buffer. Safe to call repeatedly. */
  preload(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      const ctx = new Ctor();
      this.ctx = ctx;
      const master = ctx.createGain();
      master.gain.value = this.volume;
      master.connect(ctx.destination);
      this.master = master;
      // One decaying noise buffer, reused by every recipe that wants a transient.
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

  setVolume(v: number) {
    this.volume = clamp(v, 0, 0.2);
    if (this.master) this.master.gain.value = this.volume;
  }

  setEnabled(on: boolean) {
    this.enabled = on;
  }

  /** Plays a named KAI voice. Unknown names are ignored, never thrown. */
  play(name: SoundName | string) {
    if (!this.enabled) return;
    const recipe = RECIPES[name as SoundName];
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

  private tone(
    ctx: AudioContext,
    master: GainNode,
    recipe: Recipe,
    at: number,
    f0: number,
    f1: number,
    gain: number,
  ) {
    const osc = ctx.createOscillator();
    osc.type = recipe.wave;
    osc.frequency.setValueAtTime(Math.max(1, f0), at);
    if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), at + recipe.dur);

    const env = ctx.createGain();
    // Fast attack, exponential decay — a soft click, never a pop.
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(
      Math.max(0.0002, gain),
      at + Math.min(0.012, recipe.dur * 0.2),
    );
    env.gain.exponentialRampToValueAtTime(0.0001, at + recipe.dur);

    let node: AudioNode = osc;
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

  private noiseBurst(ctx: AudioContext, master: GainNode, recipe: Recipe, at: number) {
    if (!this.noise) return;
    const dur = Math.min(0.09, recipe.dur);
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const env = ctx.createGain();
    env.gain.setValueAtTime(Math.max(0.0002, recipe.gain * (recipe.noise ?? 0) * 0.6), at);
    env.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = recipe.lp ?? 3000;
    src.connect(lp);
    lp.connect(env);
    env.connect(master);
    src.start(at);
    src.stop(at + dur + 0.01);
  }
}

export const Sound = new SoundEngine();
