// KAI — the character renderer (public face of the character module).
//
// The drawing is now the ported orb (see ./orb.ts, from
// app/assets/kai/KAI_matrix_orb_v17.html). This class keeps the *exact* public
// surface the island, the mini bots and the greeting already program against, so
// the character could be swapped without touching those call sites. Every method
// and field below existed before the port; the wider state union and the
// accessory/skin setters are the only additions.
//
// MIT.

import { Sound } from "../core/sound";
import type { BotEmoteName, BotStateName } from "../core/layout";
import {
  BOT_STATES,
  STATE_SOUND,
  EMOTE_EYE,
  poseForState,
  type Badge,
  type BotStateCfg,
  type EyeShape,
  type RGB,
  type ParticleType,
  type PropKey,
  type TweenKey,
  type KaiStateName,
} from "./types";
import { KaiOrb, type AccessoryName, type SkinName } from "./orb";

export { BOT_STATES, STATE_SOUND, hexToRGB, poseForState } from "./types";
export { KaiStates, KAI_STATE_POSE } from "./types";
export type { Badge, EyeShape, RGB, ParticleType, BotStateCfg, KaiStateName } from "./types";
export type { AccessoryName, SkinName } from "./orb";
export { Ease, lerp, clamp } from "../core/anim";
export type { EaseFn } from "../core/anim";

interface Tween {
  prop: PropKey;
  keys: TweenKey[];
  index: number;
  from: number;
  startMs: number;
  onComplete?: () => void;
}

/** Emote → the closest supplied orb expression (EY table). */
const EMOTE_EXPR: Record<BotEmoteName, string> = {
  love: "happy",
  surprised: "surprised",
  proud: "determined",
  wink: "sideglance",
  yawn: "sleepy",
  happy: "happy",
  annoyed: "skeptical",
};

const now = () => performance.now() / 1000;
const lin = (t: number) => t;

/**
 * KAI's renderer. The body is drawn at 60 % of the canvas width, centred; callers
 * size the canvas to `bodyDiameter / 0.6` and hand the same numbers to `draw()`.
 */
export class KaiEngine {
  isMini = false;
  /** Flat fill for mini bots and integration pills; null = KAI's own orb. */
  bodyColor: RGB | null = null;

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

  col: RGB = BOT_STATES.idle.color;
  colT: RGB = BOT_STATES.idle.color;

  state = "idle";
  cfg: BotStateCfg = BOT_STATES.idle;

  eyeOverride: EyeShape | null = null;
  eyeOverrideUntil = 0;
  permanentEye: EyeShape | null = null;
  permanentEmote: BotEmoteName | null = null;

  badge: Badge | null = null;
  private badgeKey = "none";
  private badgeToken = 0;

  private tweens = new Map<PropKey, Tween>();
  private locks = new Set<PropKey>();

  lookX = 0;
  lookY = 0;

  lastTime = now();
  waveUntil = 0;
  waveStart = 0;
  private greetToken = 0;
  private slapTimes: number[] = [];

  /** Three slaps inside 1.7 s → dizzy. */
  onDizzy: (() => void) | null = null;

  /** The ported orb renderer. */
  private orb = new KaiOrb();

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Sets the character state. Accepts the directive's full state set (IDLE,
   * LISTENING, THINKING, PLANNING, WORKING, USING_TOOL, DELEGATING, WAITING,
   * WAITING_APPROVAL, SUCCESS, ERROR, OFFLINE) in either case, plus the legacy
   * `BotStateName` values, which still typecheck. See `KAI_STATE_POSE` for the
   * auditable state → pose mapping.
   */
  setState(next: KaiStateName, force = false) {
    const key = String(next).toLowerCase();
    if (this.state === key && !force) return;
    const prev = this.state;
    this.state = key;
    this.cfg = BOT_STATES[key as BotStateName] ?? BOT_STATES.idle;
    this.colT = this.cfg.color;
    this.tgTilt = this.cfg.tilt;

    this.setBadge(this.cfg.badge);

    const sound = STATE_SOUND[key as BotStateName];
    if (sound && !this.isMini && prev !== key) Sound.play(sound);

    this.orb.go(poseForState(key));
  }

  /** Selects one of the eight accessories (hair / cap / bat / phones / cat / crown / halo / none). */
  setAccessory(name: AccessoryName) {
    this.orb.setAccessory(name);
  }

  /** Selects one of the three skins (blue / black / yellow). */
  setSkin(skin: SkinName) {
    this.orb.setSkin(skin);
  }

  /**
   * 3-D eye rig toggle — the source's "3D" button (L390). Additive: the flat
   * expression eyes are the default and come back when this is false.
   */
  setEyeMode3(on: boolean) {
    this.orb.setEyeMode3(on);
  }

  /** Shows one of the 30 pose-z gallery faces (PZ key, e.g. "S1"). */
  showGallery(key: string) {
    this.orb.showGallery(key);
  }

  clearGallery() {
    this.orb.clearGallery();
  }

  /** Work props — laptop / backpack / hands (source #lap/#bk/#hnd). */
  setProps(p: { laptop?: boolean; backpack?: boolean; hands?: boolean }) {
    this.orb.setProps(p);
  }

  /** Direct shard/shell break-apart levels, 0…1 (source VC.sl / VC.sh). */
  setShatter(sl: number, sh: number) {
    this.orb.setShatter(sl, sh);
  }

  /** A timed break-apart: crack → shards fly → shell → reassemble. */
  shatter() {
    this.orb.shatter();
  }

  /** The live orb renderer, for verification harnesses (read-only). */
  get renderer(): KaiOrb {
    return this.orb;
  }

  setBadge(b: Badge | null) {
    const key = b ? `${b.kind}:${b.color.join(",")}` : "none";
    if (key === this.badgeKey) return;
    this.badgeKey = key;
    this.badge = b;
    const token = ++this.badgeToken;
    if (b) this.anim("badgeS", [[1.15, 180, lin], [1, 160, lin]]);
    else this.anim("badgeS", [[0, 140, lin]], () => { if (token === this.badgeToken) this.badgeS = 0; });
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
    window.setTimeout(() => { this.isChewing = false; }, 260);
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

  doRoll(durationMs: number, _turns: number) {
    this.orb.roll(durationMs);
  }

  /** KAI "wakes up": a bright attentive glance and a slow settle. */
  greet() {
    const token = ++this.greetToken;
    this.waveStart = now();
    this.waveUntil = now() + 2.2;
    this.orb.go("awake");
    window.setTimeout(() => { if (token === this.greetToken) this.orb.express("happy", 700); }, 620);
  }

  interruptGreet() {
    this.greetToken++;
    this.waveUntil = 0;
    this.es = 1;
    this.orb.go("idle");
  }

  setPermanentEmote(emote: BotEmoteName | null) {
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

  triggerEmote(emote: BotEmoteName, duration = 1.8) {
    this.orb.express(EMOTE_EXPR[emote], duration * 1000);
  }

  /** Legacy particle hook — the orb draws no shards, so this is a no-op. */
  emit(_type: ParticleType, _count: number) {
    /* the ported orb has no particle layer (see PORT_NOTES in orb.ts) */
  }

  /** Legacy aperture morph — the orb has no intake; the value is retained. */
  animateMorph(target: number, _durationMs = 260) {
    this.morph = Math.max(0, Math.min(1, target));
  }

  resetMorph() {
    this.morph = 0;
    this.tweens.delete("morph");
    this.locks.delete("morph");
  }

  anim(prop: PropKey, keys: TweenKey[], onComplete?: () => void) {
    this.tweens.set(prop, { prop, keys, index: 0, from: this[prop], startMs: performance.now(), onComplete });
    this.locks.add(prop);
  }

  // ── Update ──────────────────────────────────────────────────────────────────

  update(dt: number) {
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
  get busy(): boolean {
    return this.tweens.size > 0 || this.orb.busy;
  }

  // ── Draw ────────────────────────────────────────────────────────────────────

  draw(x: CanvasRenderingContext2D, W: number, H: number) {
    // Live verification handle: the island's real renderer (never a mini bot)
    // registers itself so a CDP harness reaches the exact engine the product draws.
    if (typeof window !== "undefined" && !this.isMini) {
      (window as unknown as { __kaiEngine?: KaiEngine }).__kaiEngine = this;
    }
    const R = W * 0.3;
    const cx = W / 2 + this.ox * R;
    const cy = H / 2 + this.particleOverhang / 2 + this.oy * R;
    // `bodyColor` is the public 0…1 colour (types.ts `hexToRGB` / `rgba`), but the
    // ported orb's flat fill formats colours as 0…255 (`rgbStr`). Handing the 0…1
    // vector straight to the orb rounded every channel to 0 or 1, so a mini bot /
    // pill drew as a black disc instead of its integration's colour.
    const bodyColor = this.bodyColor
      ? ([this.bodyColor[0] * 255, this.bodyColor[1] * 255, this.bodyColor[2] * 255] as const)
      : null;
    this.orb.draw(x, cx, cy, R, { bodyColor, mini: this.isMini });
  }
}
