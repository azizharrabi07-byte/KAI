import * as THREE from 'three';

/**
 * Official Operational States for KAI 3D AI Companion
 */
export const KAI_STATES = Object.freeze({
  IDLE: 'idle',
  THINKING: 'thinking',
  WORKING: 'working',
  WAITING_FOR_APPROVAL: 'waiting_for_approval',
  BLOCKED_OR_ERROR: 'error',
  SUCCESS: 'success',
  PAUSED: 'paused',
  OFFLINE: 'offline'
});

/**
 * Recognizable One-Shot Choreographed Actions
 */
export const KAI_ACTIONS = Object.freeze({
  SUCCESS_CELEBRATION: 'success_celebration',
  ERROR_RECOIL: 'error_recoil',
  APPROVAL_ALERT: 'approval_alert',
  THINKING_PONDER: 'thinking_ponder',
  WORKING_ENGAGE: 'working_engage',
  PAUSED_SETTLE: 'paused_settle',
  OFFLINE_SLEEP: 'offline_sleep',
  BOOP_REACTION: 'boop_reaction',
  DANCE_GROOVE: 'dance_groove'
});

/**
 * Authoritative State Color Palettes per Visual Specification:
 * Preserves KAI's deep navy primary identity with state-specific accents.
 */
export const KAI_STATE_PALETTES = Object.freeze({
  [KAI_STATES.IDLE]: {
    baseColor: '#111b2e',   // Deep navy
    tipColor: '#7dd3fc',    // Soft sky blue
    skinColor: '#0a1324',
    rimColor: '#38bdf8',
    specular: 0.35,
    roughness: 0.72,
    statusBadgeColor: '#0ea5e9'
  },
  [KAI_STATES.THINKING]: {
    baseColor: '#0f172a',   // Deep navy-blue
    tipColor: '#38bdf8',    // Cool cyan
    skinColor: '#0c1626',
    rimColor: '#7dd3fc',
    specular: 0.42,
    roughness: 0.70,
    statusBadgeColor: '#38bdf8'
  },
  [KAI_STATES.WORKING]: {
    baseColor: '#0a1120',   // Rich midnight blue
    tipColor: '#00e5ff',    // Brighter electric cyan
    skinColor: '#08101e',
    rimColor: '#00e5ff',
    specular: 0.48,
    roughness: 0.68,
    statusBadgeColor: '#0284c7'
  },
  [KAI_STATES.WAITING_FOR_APPROVAL]: {
    baseColor: '#111b2e',   // Deep navy
    tipColor: '#fbbf24',    // Restrained warm amber
    skinColor: '#121a2b',
    rimColor: '#f59e0b',
    specular: 0.40,
    roughness: 0.72,
    statusBadgeColor: '#f59e0b'
  },
  [KAI_STATES.BLOCKED_OR_ERROR]: {
    baseColor: '#0c1322',   // Deep navy with slightly cooler, subdued base
    tipColor: '#64748b',    // Subdued, dignified slate-blue (preserves navy identity)
    skinColor: '#0e121c',
    rimColor: '#ef4444',    // Warm coral warning rim
    specular: 0.28,
    roughness: 0.76,
    statusBadgeColor: '#ef4444'
  },
  [KAI_STATES.SUCCESS]: {
    baseColor: '#111b2e',   // Deep navy
    tipColor: '#34d399',    // Mint green
    skinColor: '#0a1928',
    rimColor: '#2dd4bf',
    specular: 0.50,
    roughness: 0.65,
    statusBadgeColor: '#10b981'
  },
  [KAI_STATES.PAUSED]: {
    baseColor: '#1e293b',   // Muted blue-gray
    tipColor: '#94a3b8',    // Desaturated blue
    skinColor: '#161e2e',
    rimColor: '#64748b',
    specular: 0.22,
    roughness: 0.78,
    statusBadgeColor: '#64748b'
  },
  [KAI_STATES.OFFLINE]: {
    baseColor: '#0f172a',   // Dark, subdued blue-gray
    tipColor: '#475569',    // Dim, cool slate blue
    skinColor: '#090e18',
    rimColor: '#334155',
    specular: 0.16,
    roughness: 0.84,
    statusBadgeColor: '#334155'
  }
});

export const KAI_STATE_METADATA = Object.freeze({
  [KAI_STATES.IDLE]: {
    label: 'Idle',
    description: 'Calm & observant · Attentive baseline',
    palette: KAI_STATE_PALETTES[KAI_STATES.IDLE]
  },
  [KAI_STATES.THINKING]: {
    label: 'Thinking',
    description: 'Actively synthesizing plan · Pondering',
    palette: KAI_STATE_PALETTES[KAI_STATES.THINKING]
  },
  [KAI_STATES.WORKING]: {
    label: 'Working',
    description: 'Subagents executing tasks · Controlled focus',
    palette: KAI_STATE_PALETTES[KAI_STATES.WORKING]
  },
  [KAI_STATES.WAITING_FOR_APPROVAL]: {
    label: 'Waiting for Approval',
    description: 'Awaiting human authorization · Attentive posture',
    palette: KAI_STATE_PALETTES[KAI_STATES.WAITING_FOR_APPROVAL]
  },
  [KAI_STATES.BLOCKED_OR_ERROR]: {
    label: 'Blocked / Error',
    description: 'Task exception or blocked status · Stable warning',
    palette: KAI_STATE_PALETTES[KAI_STATES.BLOCKED_OR_ERROR]
  },
  [KAI_STATES.SUCCESS]: {
    label: 'Success',
    description: 'Task verified & delivered · Confirmed celebration',
    palette: KAI_STATE_PALETTES[KAI_STATES.SUCCESS]
  },
  [KAI_STATES.PAUSED]: {
    label: 'Paused',
    description: 'Execution suspended by operator · Resting',
    palette: KAI_STATE_PALETTES[KAI_STATES.PAUSED]
  },
  [KAI_STATES.OFFLINE]: {
    label: 'Offline',
    description: 'Control link inactive · Quietly dormant',
    palette: KAI_STATE_PALETTES[KAI_STATES.OFFLINE]
  }
});

const STATE_ALIASES = {
  idle: KAI_STATES.IDLE,
  ready: KAI_STATES.IDLE,
  standby: KAI_STATES.IDLE,
  thinking: KAI_STATES.THINKING,
  think: KAI_STATES.THINKING,
  planning: KAI_STATES.THINKING,
  reasoning: KAI_STATES.THINKING,
  working: KAI_STATES.WORKING,
  work: KAI_STATES.WORKING,
  busy: KAI_STATES.WORKING,
  executing: KAI_STATES.WORKING,
  running: KAI_STATES.WORKING,
  waiting_for_approval: KAI_STATES.WAITING_FOR_APPROVAL,
  waiting: KAI_STATES.WAITING_FOR_APPROVAL,
  approval: KAI_STATES.WAITING_FOR_APPROVAL,
  pending: KAI_STATES.WAITING_FOR_APPROVAL,
  blocked: KAI_STATES.BLOCKED_OR_ERROR,
  error: KAI_STATES.BLOCKED_OR_ERROR,
  blocked_or_error: KAI_STATES.BLOCKED_OR_ERROR,
  failed: KAI_STATES.BLOCKED_OR_ERROR,
  fail: KAI_STATES.BLOCKED_OR_ERROR,
  success: KAI_STATES.SUCCESS,
  completed: KAI_STATES.SUCCESS,
  done: KAI_STATES.SUCCESS,
  passed: KAI_STATES.SUCCESS,
  paused: KAI_STATES.PAUSED,
  pause: KAI_STATES.PAUSED,
  offline: KAI_STATES.OFFLINE,
  sleep: KAI_STATES.OFFLINE,
  sleeping: KAI_STATES.OFFLINE
};

export function normalizeState(rawState) {
  if (typeof rawState !== 'string') return null;
  const key = rawState.trim().toLowerCase();
  return STATE_ALIASES[key] || null;
}

// High-precision easing curves
function easeOutQuad(t) { return t * (2 - t); }
function easeInQuad(t) { return t * t; }
function easeInOutQuad(t) { return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; }
function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
function easeInOutCubic(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Centralized Animation Controller and Kinematic State Machine for KAI
 */
export class KAIStateController {
  constructor(initialState = KAI_STATES.IDLE) {
    this.currentState = initialState;
    this.previousState = initialState;
    this.subscribers = new Set();

    // Debugging and speed/intensity multipliers
    this.timeScale = 1.0;
    this.intensity = 1.0;

    // Persistent State Posture Targets (continuous baseline)
    this.persistentStance = {
      pitch: 0.0,
      yaw: 0.0,
      roll: 0.0,
      offsetY: 0.0,
      offsetZ: 0.0,
      squash: 1.0,
      breathSpeed: 1.85,
      breathAmp: 0.012,
      eyeSquint: 1.0,
      lookBiasX: 0.0,
      lookBiasY: 0.0
    };

    // Current smoothed motion parameters (Zero-GC, output to motionRoot)
    this.currentMotion = {
      liftY: 0.0,
      offsetZ: 0.0,
      tiltPitch: 0.0,
      tiltYaw: 0.0,
      tiltRoll: 0.0,
      squash: 1.0,
      breathPhase: 0.0,
      breathValue: 0.0,
      eyeSquint: 1.0,
      lookBiasX: 0.0,
      lookBiasY: 0.0,
      furPulse: 0.0,
      furWavePhase: 0.0
    };

    // Material & Color Interpolation State
    const initPalette = KAI_STATE_PALETTES[this.currentState] || KAI_STATE_PALETTES[KAI_STATES.IDLE];
    this.currentColors = {
      baseColor: new THREE.Color(initPalette.baseColor),
      tipColor: new THREE.Color(initPalette.tipColor),
      skinColor: new THREE.Color(initPalette.skinColor),
      rimColor: new THREE.Color(initPalette.rimColor),
      specular: initPalette.specular,
      roughness: initPalette.roughness
    };

    this.targetColors = {
      baseColor: new THREE.Color(initPalette.baseColor),
      tipColor: new THREE.Color(initPalette.tipColor),
      skinColor: new THREE.Color(initPalette.skinColor),
      rimColor: new THREE.Color(initPalette.rimColor),
      specular: initPalette.specular,
      roughness: initPalette.roughness
    };

    // One-Shot Action System
    this.activeAction = null;
    this.actionProgress = 1.0;
    this.actionCompleted = true;

    // Natural occasional micro-gaze shift timers for idle
    this.microGazeTimer = 0.0;
    this.nextMicroGaze = 3.5;
    this.microGazeOffset = { x: 0.0, y: 0.0 };
    // Real task progress tracking (null when not tracking a specific progress fraction)
    this.taskProgress = null;

    this._setupPersistentStance(this.currentState);
  }

  setProgress(progress) {
    if (progress === null || progress === undefined) {
      this.taskProgress = null;
      return;
    }
    const val = Number(progress);
    if (Number.isFinite(val)) {
      this.taskProgress = Math.max(0.0, Math.min(1.0, val));
    }
  }

  getProgress() {
    return this.taskProgress;
  }

  getState() {
    return this.currentState;
  }

  getPreviousState() {
    return this.previousState;
  }

  getAvailableStates() {
    return Object.values(KAI_STATES);
  }

  getMetadata(state = this.currentState) {
    const meta = KAI_STATE_METADATA[state] || KAI_STATE_METADATA[KAI_STATES.IDLE];
    return {
      label: meta.label,
      description: meta.description,
      statusBadgeColor: meta.palette.statusBadgeColor,
      accentColor: meta.palette.tipColor,
      palette: meta.palette
    };
  }

  getStatePalette(state = this.currentState) {
    return KAI_STATE_PALETTES[state] || KAI_STATE_PALETTES[KAI_STATES.IDLE];
  }

  get palettes() {
    return KAI_STATE_PALETTES;
  }

  getCurrentAction() {
    return this.activeAction ? this.activeAction.name : null;
  }

  getActionProgress() {
    return this.actionProgress;
  }

  isActionCompleted() {
    return this.actionCompleted;
  }

  setAnimationSpeed(speed) {
    const val = Number(speed);
    if (Number.isFinite(val) && val > 0.05 && val <= 3.0) {
      this.timeScale = val;
    }
  }

  setAnimationIntensity(intensity) {
    const val = Number(intensity);
    if (Number.isFinite(val) && val >= 0.0 && val <= 3.0) {
      this.intensity = val;
    }
  }

  subscribe(callback) {
    if (typeof callback === 'function') {
      this.subscribers.add(callback);
      return () => this.subscribers.delete(callback);
    }
    return () => {};
  }

  _notify(payload) {
    if (typeof window !== 'undefined') {
      try {
        window.dispatchEvent(new CustomEvent('kai:statechange', { detail: payload }));
      } catch {
        // Safe inside headless environments
      }
    }
    for (const sub of this.subscribers) {
      try {
        sub(payload);
      } catch (err) {
        console.error('[KAI Avatar] Error in state listener:', err);
      }
    }
  }

  /**
   * Set authorized operational state
   */
  setState(newState, options = {}) {
    const normalized = normalizeState(newState);
    if (!normalized) {
      console.warn(`[KAI Avatar] Invalid state requested: "${newState}". Valid states:`, this.getAvailableStates());
      return false;
    }

    // Guard: ignore redundant calls unless explicitly forced or triggering a one-shot re-entrance
    if (this.currentState === normalized && !options.force && !options.replayAction) {
      return true;
    }

    this.previousState = this.currentState;
    this.currentState = normalized;

    // 1. Setup persistent stance for this state
    this._setupPersistentStance(this.currentState);

    // 2. Setup target state color palette
    const pal = KAI_STATE_PALETTES[this.currentState] || KAI_STATE_PALETTES[KAI_STATES.IDLE];
    this.targetColors.baseColor.set(pal.baseColor);
    this.targetColors.tipColor.set(pal.tipColor);
    this.targetColors.skinColor.set(pal.skinColor);
    this.targetColors.rimColor.set(pal.rimColor);
    this.targetColors.specular = pal.specular;
    this.targetColors.roughness = pal.roughness;

    // 3. Trigger corresponding one-shot entrance animation if applicable
    switch (this.currentState) {
      case KAI_STATES.THINKING:
        this.playAction(KAI_ACTIONS.THINKING_PONDER, { priority: 50, force: true });
        break;
      case KAI_STATES.WORKING:
        this.playAction(KAI_ACTIONS.WORKING_ENGAGE, { priority: 50, force: true });
        break;
      case KAI_STATES.WAITING_FOR_APPROVAL:
        this.playAction(KAI_ACTIONS.APPROVAL_ALERT, { priority: 80, force: true });
        break;
      case KAI_STATES.BLOCKED_OR_ERROR:
        this.playAction(KAI_ACTIONS.ERROR_RECOIL, { priority: 100, force: true });
        break;
      case KAI_STATES.SUCCESS:
        this.playAction(KAI_ACTIONS.SUCCESS_CELEBRATION, {
          priority: 70,
          force: true,
          onComplete: () => {
            // Smoothly return to IDLE after celebration completes
            if (this.currentState === KAI_STATES.SUCCESS) {
              this.setState(KAI_STATES.IDLE);
            }
          }
        });
        break;
      case KAI_STATES.PAUSED:
        this.playAction(KAI_ACTIONS.PAUSED_SETTLE, { priority: 40, force: true });
        break;
      case KAI_STATES.OFFLINE:
        this.playAction(KAI_ACTIONS.OFFLINE_SLEEP, { priority: 40, force: true });
        break;
      default:
        break;
    }

    const payload = {
      state: this.currentState,
      previousState: this.previousState,
      metadata: this.getMetadata(this.currentState),
      timestamp: Date.now()
    };
    this._notify(payload);

    return true;
  }

  /**
   * Reset creature directly to neutral resting pose (useful for testing/debugger)
   */
  resetPose() {
    this.activeAction = null;
    this.actionProgress = 1.0;
    this.actionCompleted = true;
    this.setState(KAI_STATES.IDLE, { force: true });
  }

  /**
   * Play a recognizable one-shot animation with explicit lifecycle and priority
   */
  playAction(actionName, options = {}) {
    const priority = options.priority || 50;

    // Check preemption priority: higher-priority actions preempt lower ones
    if (this.activeAction && !this.actionCompleted && !options.force) {
      if (priority < this.activeAction.priority) {
        return false;
      }
    }

    let duration = 1.5;
    let evaluateFn = null;

    switch (actionName) {
      case KAI_ACTIONS.SUCCESS_CELEBRATION:
        duration = 2.4;
        evaluateFn = this._evalSuccessCelebration;
        break;

      case KAI_ACTIONS.ERROR_RECOIL:
        duration = 1.5;
        evaluateFn = this._evalErrorRecoil;
        break;

      case KAI_ACTIONS.APPROVAL_ALERT:
        duration = 1.6;
        evaluateFn = this._evalApprovalAlert;
        break;

      case KAI_ACTIONS.THINKING_PONDER:
        duration = 1.8;
        evaluateFn = this._evalThinkingPonder;
        break;

      case KAI_ACTIONS.WORKING_ENGAGE:
        duration = 1.2;
        evaluateFn = this._evalWorkingEngage;
        break;

      case KAI_ACTIONS.PAUSED_SETTLE:
        duration = 1.4;
        evaluateFn = this._evalPausedSettle;
        break;

      case KAI_ACTIONS.OFFLINE_SLEEP:
        duration = 1.8;
        evaluateFn = this._evalOfflineSleep;
        break;

      case KAI_ACTIONS.BOOP_REACTION:
        duration = 1.0;
        evaluateFn = this._evalBoopReaction;
        break;

      case KAI_ACTIONS.DANCE_GROOVE:
      case 'dance_groove':
      case 'dance':
      case 'happy_dance':
        duration = 3.6;
        evaluateFn = this._evalDanceGroove;
        break;

      default:
        console.warn(`[KAI Avatar] Unknown action requested: "${actionName}"`);
        return false;
    }

    this.activeAction = {
      name: actionName,
      priority,
      duration,
      elapsed: 0.0,
      evaluate: evaluateFn,
      onComplete: options.onComplete || null
    };
    this.actionProgress = 0.0;
    this.actionCompleted = false;

    return true;
  }

  _setupPersistentStance(state) {
    const s = this.persistentStance;
    switch (state) {
      case KAI_STATES.IDLE:
        s.pitch = 0.0;
        s.yaw = 0.0;
        s.roll = 0.0;
        s.offsetY = 0.0;
        s.offsetZ = 0.0;
        s.squash = 1.0;
        s.breathSpeed = 1.85;
        s.breathAmp = 0.012;
        s.eyeSquint = 1.0;
        s.lookBiasX = 0.0;
        s.lookBiasY = 0.0;
        break;

      case KAI_STATES.THINKING:
        s.pitch = -0.05;
        s.yaw = 0.08;
        s.roll = 0.04;
        s.offsetY = 0.015;
        s.offsetZ = 0.0;
        s.squash = 1.01;
        s.breathSpeed = 1.55;
        s.breathAmp = 0.010;
        s.eyeSquint = 0.94;
        s.lookBiasX = 0.12;
        s.lookBiasY = 0.16;
        break;

      case KAI_STATES.WORKING:
        s.pitch = 0.055;
        s.yaw = 0.0;
        s.roll = 0.0;
        s.offsetY = -0.01;
        s.offsetZ = 0.02;
        s.squash = 0.99;
        s.breathSpeed = 2.1;
        s.breathAmp = 0.011;
        s.eyeSquint = 0.96;
        s.lookBiasX = 0.0;
        s.lookBiasY = -0.04;
        break;

      case KAI_STATES.WAITING_FOR_APPROVAL:
        s.pitch = -0.04;
        s.yaw = -0.05;
        s.roll = -0.06;
        s.offsetY = 0.02;
        s.offsetZ = 0.0;
        s.squash = 1.02;
        s.breathSpeed = 1.4;
        s.breathAmp = 0.009;
        s.eyeSquint = 1.10; // slightly wider attentive eyes
        s.lookBiasX = 0.0;
        s.lookBiasY = 0.04;
        break;

      case KAI_STATES.BLOCKED_OR_ERROR:
        s.pitch = 0.09;
        s.yaw = -0.04;
        s.roll = -0.06;
        s.offsetY = -0.035;
        s.offsetZ = -0.01;
        s.squash = 0.96;
        s.breathSpeed = 1.2;
        s.breathAmp = 0.008;
        s.eyeSquint = 0.82;
        s.lookBiasX = -0.06;
        s.lookBiasY = -0.10;
        break;

      case KAI_STATES.SUCCESS:
        s.pitch = -0.06;
        s.yaw = 0.0;
        s.roll = 0.0;
        s.offsetY = 0.025;
        s.offsetZ = 0.0;
        s.squash = 1.03;
        s.breathSpeed = 2.2;
        s.breathAmp = 0.016;
        s.eyeSquint = 1.04;
        s.lookBiasX = 0.0;
        s.lookBiasY = 0.05;
        break;

      case KAI_STATES.PAUSED:
        s.pitch = 0.04;
        s.yaw = 0.05;
        s.roll = 0.04;
        s.offsetY = -0.022;
        s.offsetZ = 0.0;
        s.squash = 0.97;
        s.breathSpeed = 1.1;
        s.breathAmp = 0.007;
        s.eyeSquint = 0.45; // half-closed resting lids
        s.lookBiasX = 0.0;
        s.lookBiasY = -0.04;
        break;

      case KAI_STATES.OFFLINE:
        s.pitch = 0.12;
        s.yaw = 0.0;
        s.roll = 0.0;
        s.offsetY = -0.045;
        s.offsetZ = 0.0;
        s.squash = 0.93;
        s.breathSpeed = 0.85;
        s.breathAmp = 0.006;
        s.eyeSquint = 0.04; // closed sleeping eyes
        s.lookBiasX = 0.0;
        s.lookBiasY = 0.0;
        break;
    }
  }

  // =========================================================================
  // ONE-SHOT ACTION EVALUATORS (Distinct, authored choreographies)
  // =========================================================================

  // 1. Success Celebration: Crouch -> Joyful Hop (+0.18) & Stretch -> Soft Landing -> Proud Settle
  _evalSuccessCelebration(p) {
    let liftY = 0.0;
    let squash = 1.0;
    let tiltPitch = 0.0;
    let furPulse = 0.0;
    let eyeSquint = 1.0;

    if (p < 0.20) {
      // Phase 1: Anticipation Compression
      const t = p / 0.20;
      const e = easeInQuad(t);
      liftY = -0.04 * e;
      squash = 1.0 - 0.12 * e; // squash to 0.88
      tiltPitch = 0.04 * e;
    } else if (p < 0.55) {
      // Phase 2: Joyful Upward Hop & Stretch
      const t = (p - 0.20) / 0.35;
      const hopProgress = Math.sin(t * Math.PI);
      liftY = hopProgress * 0.19;
      // Stretch on ascent, neutral at apex
      squash = 1.0 + Math.sin(t * Math.PI) * 0.14;
      tiltPitch = -0.10 * Math.sin(t * Math.PI);
      furPulse = Math.sin(t * Math.PI) * 0.85;
      eyeSquint = 1.0 + 0.12 * Math.sin(t * Math.PI);
    } else if (p < 0.78) {
      // Phase 3: Landing Cushion & Happy Squint
      const t = (p - 0.55) / 0.23;
      const e = Math.sin(t * Math.PI);
      liftY = -0.03 * e;
      squash = 1.0 - 0.10 * e;
      tiltPitch = 0.03 * e;
      eyeSquint = 1.0 - 0.35 * e; // happy squint arc
      furPulse = 0.40 * (1.0 - t);
    } else {
      // Phase 4: Gentle Settle to Resting
      const t = (p - 0.78) / 0.22;
      const e = Math.sin(t * Math.PI);
      liftY = 0.02 * e;
      squash = 1.0 + 0.03 * e;
    }

    return { liftY, squash, tiltPitch, tiltYaw: 0, tiltRoll: 0, furPulse, eyeSquint, lookBiasX: 0, lookBiasY: 0.06 };
  }

  // 2. Error Recoil: Sudden Damped Recoil -> Troubled Tilt -> Settle into Blocked Stance
  _evalErrorRecoil(p) {
    let liftY = 0.0;
    let offsetZ = 0.0;
    let squash = 1.0;
    let tiltPitch = 0.0;
    let tiltRoll = 0.0;
    let furPulse = 0.0;
    let eyeSquint = 1.0;

    if (p < 0.25) {
      // Fast recoil
      const t = p / 0.25;
      const e = easeOutCubic(t);
      liftY = -0.05 * e;
      offsetZ = -0.04 * e;
      squash = 1.0 - 0.09 * e;
      tiltPitch = 0.14 * e;
      tiltRoll = -0.08 * e;
      furPulse = 0.75 * e;
      eyeSquint = 1.0 - 0.26 * e;
    } else if (p < 0.65) {
      // Troubled recoil hold
      const t = (p - 0.25) / 0.40;
      liftY = -0.05 + 0.02 * t;
      offsetZ = -0.04 + 0.02 * t;
      squash = 0.91 + 0.04 * t;
      tiltPitch = 0.14 - 0.03 * t;
      tiltRoll = -0.08 + 0.02 * t;
      furPulse = 0.75 * (1.0 - t);
      eyeSquint = 0.74;
    } else {
      // Smooth handoff to persistent error stance
      const t = (p - 0.65) / 0.35;
      const e = easeOutQuad(t);
      liftY = THREE.MathUtils.lerp(-0.03, 0.0, e);
      offsetZ = THREE.MathUtils.lerp(-0.02, 0.0, e);
      squash = THREE.MathUtils.lerp(0.95, 1.0, e);
      tiltPitch = THREE.MathUtils.lerp(0.11, 0.0, e);
      tiltRoll = THREE.MathUtils.lerp(-0.06, 0.0, e);
      eyeSquint = THREE.MathUtils.lerp(0.74, 1.0, e);
    }

    return { liftY, offsetZ, squash, tiltPitch, tiltYaw: -0.04, tiltRoll, furPulse, eyeSquint, lookBiasX: -0.06, lookBiasY: -0.10 };
  }

  // 3. Approval Alert: Perk Up -> Crown Fur Rise -> Deliberate Questioning Tilt -> Hold
  _evalApprovalAlert(p) {
    let liftY = 0.0;
    let tiltPitch = 0.0;
    let tiltRoll = 0.0;
    let furPulse = 0.0;
    let eyeSquint = 1.0;

    if (p < 0.30) {
      // Alert upward perk
      const t = p / 0.30;
      const e = easeOutCubic(t);
      liftY = 0.045 * e;
      tiltPitch = -0.06 * e;
      furPulse = 0.65 * e;
      eyeSquint = 1.0 + 0.14 * e;
    } else if (p < 0.75) {
      // Deliberate questioning tilt to viewer
      const t = (p - 0.30) / 0.45;
      const e = easeInOutCubic(t);
      liftY = 0.045 - 0.015 * e;
      tiltPitch = -0.06 + 0.02 * e;
      tiltRoll = -0.08 * e;
      furPulse = 0.65 * (1.0 - t);
      eyeSquint = 1.14;
    } else {
      // Settle into calm expectant stance
      const t = (p - 0.75) / 0.25;
      const e = easeOutQuad(t);
      liftY = THREE.MathUtils.lerp(0.03, 0.0, e);
      tiltPitch = THREE.MathUtils.lerp(-0.04, 0.0, e);
      tiltRoll = THREE.MathUtils.lerp(-0.08, 0.0, e);
      eyeSquint = THREE.MathUtils.lerp(1.14, 1.0, e);
    }

    return { liftY, squash: 1.0, tiltPitch, tiltYaw: -0.05, tiltRoll, furPulse, eyeSquint, lookBiasX: 0.0, lookBiasY: 0.05 };
  }

  // 4. Thinking Ponder: Attentive Pause -> Tilt Aside & Upward Gaze -> Thoughtful Blink -> Settle
  _evalThinkingPonder(p) {
    let liftY = 0.0;
    let tiltPitch = 0.0;
    let tiltYaw = 0.0;
    let tiltRoll = 0.0;
    let furPulse = 0.0;
    let eyeSquint = 1.0;
    let lookBiasX = 0.0;
    let lookBiasY = 0.0;

    if (p < 0.35) {
      const t = p / 0.35;
      const e = easeInOutCubic(t);
      liftY = 0.03 * e;
      tiltPitch = -0.06 * e;
      tiltYaw = 0.12 * e;
      tiltRoll = 0.05 * e;
      furPulse = 0.35 * e;
      lookBiasX = 0.16 * e;
      lookBiasY = 0.20 * e;
    } else if (p < 0.70) {
      // Hold & thoughtful slow blink
      const t = (p - 0.35) / 0.35;
      liftY = 0.03;
      tiltPitch = -0.06;
      tiltYaw = 0.12;
      tiltRoll = 0.05;
      furPulse = 0.35 * (1.0 - t);
      lookBiasX = 0.16;
      lookBiasY = 0.20;
      // Blink mid-hold
      eyeSquint = 1.0 - 0.55 * Math.sin(t * Math.PI);
    } else {
      const t = (p - 0.70) / 0.30;
      const e = easeOutQuad(t);
      liftY = THREE.MathUtils.lerp(0.03, 0.0, e);
      tiltPitch = THREE.MathUtils.lerp(-0.06, 0.0, e);
      tiltYaw = THREE.MathUtils.lerp(0.12, 0.0, e);
      tiltRoll = THREE.MathUtils.lerp(0.05, 0.0, e);
      lookBiasX = THREE.MathUtils.lerp(0.16, 0.0, e);
      lookBiasY = THREE.MathUtils.lerp(0.20, 0.0, e);
    }

    return { liftY, squash: 1.0, tiltPitch, tiltYaw, tiltRoll, furPulse, eyeSquint, lookBiasX, lookBiasY };
  }

  // 5. Working Engage: Purposeful forward lean
  _evalWorkingEngage(p) {
    const e = easeOutCubic(p);
    return {
      liftY: -0.015 * e,
      offsetZ: 0.025 * e,
      squash: 1.0 - 0.02 * e,
      tiltPitch: 0.065 * e,
      tiltYaw: 0,
      tiltRoll: 0,
      furPulse: 0.45 * Math.sin(p * Math.PI),
      eyeSquint: 0.95,
      lookBiasX: 0,
      lookBiasY: -0.04
    };
  }

  // 6. Paused Settle: Relaxation into resting pose
  _evalPausedSettle(p) {
    const e = easeOutCubic(p);
    return {
      liftY: -0.025 * e,
      squash: 1.0 - 0.03 * e,
      tiltPitch: 0.04 * e,
      tiltRoll: 0.05 * e,
      eyeSquint: THREE.MathUtils.lerp(1.0, 0.45, e)
    };
  }

  // 7. Offline Sleep: Quiet sinking & eye closure
  _evalOfflineSleep(p) {
    const e = easeOutCubic(p);
    return {
      liftY: -0.045 * e,
      squash: 1.0 - 0.06 * e,
      tiltPitch: 0.10 * e,
      eyeSquint: THREE.MathUtils.lerp(1.0, 0.04, e)
    };
  }

  // 8. Boop Reaction: Tap compression & bounce
  _evalBoopReaction(p) {
    const hop = Math.sin(p * Math.PI) * 0.06;
    const squash = 1.0 + Math.sin(p * Math.PI * 2.0) * 0.10 * (1.0 - p);
    const squint = 1.0 - Math.sin(p * Math.PI) * 0.35;
    return { liftY: hop, squash, furPulse: 1.0 - p, eyeSquint: squint };
  }

  // 9. Dance Groove: Joyful rhythmic dancing turning right and left with ear perks and bounces
  _evalDanceGroove(p) {
    // 4 full rhythmic turns right and left
    const beats = 4.0;
    const theta = p * Math.PI * 2.0 * beats;
    const envelope = Math.sin(p * Math.PI); // Smooth fade in and settle out

    // Energetic lateral turning right and left (yaw swivel)
    const tiltYaw = Math.sin(theta) * 0.38 * envelope;

    // Coordinated body roll groove countering yaw
    const tiltRoll = -Math.sin(theta) * 0.16 * envelope;

    // Playful nodding pitch
    const tiltPitch = (-0.05 + Math.cos(theta * 2.0) * 0.08) * envelope;

    // Rhythmic upward bounce on every beat
    const bounce = Math.abs(Math.sin(theta));
    const liftY = bounce * 0.12 * envelope;

    // Squash and stretch: stretch at peak of bounce, squash on landing into turn
    const squash = 1.0 + (Math.cos(theta * 2.0) * 0.14) * envelope;

    // Happy eye squints on turns
    const eyeSquint = 1.0 + (0.16 * Math.sin(theta)) * envelope;

    // Joyful fur shockwave pulse on each turn
    const furPulse = bounce * 0.65 * envelope;

    return {
      liftY,
      squash,
      tiltPitch,
      tiltYaw,
      tiltRoll,
      furPulse,
      eyeSquint,
      lookBiasX: tiltYaw * 0.5,
      lookBiasY: 0.08
    };
  }

  /**
   * Main per-frame animation and kinematic composition update
   */
  update(dt) {
    const safeDt = Math.min(Math.max(dt, 0.001), 0.05) * this.timeScale;

    // 1. Advance Action Lifecycle if active
    let actionResult = null;
    if (this.activeAction && !this.actionCompleted) {
      this.activeAction.elapsed += safeDt;
      this.actionProgress = Math.min(1.0, this.activeAction.elapsed / this.activeAction.duration);

      if (typeof this.activeAction.evaluate === 'function') {
        actionResult = this.activeAction.evaluate.call(this, this.actionProgress);
      }

      if (this.actionProgress >= 1.0) {
        this.actionCompleted = true;
        const cb = this.activeAction.onComplete;
        this.activeAction = null;
        if (typeof cb === 'function') {
          try { cb(); } catch (e) { console.error(e); }
        }
      }
    }

    // 2. Smoothly advance breathing rhythm
    const s = this.persistentStance;
    const m = this.currentMotion;
    m.breathPhase += safeDt * s.breathSpeed;

    // Organic asymmetrical respiration: gentle rise, pause, gentle settle
    const breathSin = Math.sin(m.breathPhase);
    const breathAsym = breathSin >= 0 ? Math.pow(breathSin, 0.8) : -Math.pow(-breathSin, 1.2);
    m.breathValue = breathAsym * s.breathAmp * this.intensity;

    // 3. Occasional Micro-Gaze shifts during idle for lifelike presence
    this.microGazeTimer += safeDt;
    if (this.microGazeTimer > this.nextMicroGaze) {
      this.microGazeTimer = 0.0;
      this.nextMicroGaze = 3.2 + Math.random() * 4.0;
      if (this.currentState === KAI_STATES.IDLE) {
        this.microGazeOffset.x = (Math.random() - 0.5) * 0.06;
        this.microGazeOffset.y = (Math.random() - 0.5) * 0.04;
      } else {
        this.microGazeOffset.x = 0;
        this.microGazeOffset.y = 0;
      }
    }

    // 4. Compose Motion Targets: Persistent Stance + One-Shot Action offsets
    const actionLift = actionResult ? (actionResult.liftY || 0.0) : 0.0;
    const actionOffsetZ = actionResult ? (actionResult.offsetZ || 0.0) : 0.0;
    const actionSquash = actionResult ? (actionResult.squash || 1.0) : 1.0;
    const actionPitch = actionResult ? (actionResult.tiltPitch || 0.0) : 0.0;
    const actionYaw = actionResult ? (actionResult.tiltYaw || 0.0) : 0.0;
    const actionRoll = actionResult ? (actionResult.tiltRoll || 0.0) : 0.0;
    const actionSquint = actionResult ? (actionResult.eyeSquint || 1.0) : 1.0;
    const actionLookX = actionResult ? (actionResult.lookBiasX || 0.0) : 0.0;
    const actionLookY = actionResult ? (actionResult.lookBiasY || 0.0) : 0.0;
    const actionFurPulse = actionResult ? (actionResult.furPulse || 0.0) : 0.0;

    const targetLiftY = (s.offsetY + m.breathValue + actionLift) * this.intensity;
    const targetOffsetZ = (s.offsetZ + actionOffsetZ) * this.intensity;
    const targetSquash = s.squash * (1.0 + m.breathValue * 0.8) * actionSquash;
    const targetPitch = (s.pitch + actionPitch) * this.intensity;
    const targetYaw = (s.yaw + actionYaw) * this.intensity;
    const targetRoll = (s.roll + actionRoll) * this.intensity;
    const targetSquint = Math.min(1.2, Math.max(0.04, s.eyeSquint * actionSquint));
    const targetLookX = (s.lookBiasX + this.microGazeOffset.x + actionLookX);
    const targetLookY = (s.lookBiasY + this.microGazeOffset.y + actionLookY);

    // Damped exponential interpolation (Zero-GC, prevents rapid jitter)
    const damp = Math.min(1.0, safeDt * 8.5);
    m.liftY += (targetLiftY - m.liftY) * damp;
    m.offsetZ += (targetOffsetZ - m.offsetZ) * damp;
    m.squash += (targetSquash - m.squash) * damp;
    m.tiltPitch += (targetPitch - m.tiltPitch) * damp;
    m.tiltYaw += (targetYaw - m.tiltYaw) * damp;
    m.tiltRoll += (targetRoll - m.tiltRoll) * damp;
    m.eyeSquint += (targetSquint - m.eyeSquint) * damp;
    m.lookBiasX += (targetLookX - m.lookBiasX) * damp;
    m.lookBiasY += (targetLookY - m.lookBiasY) * damp;

    // Fur shockwave pulse (outward ripple)
    if (actionFurPulse > m.furPulse) {
      m.furPulse = actionFurPulse;
    } else {
      m.furPulse *= Math.exp(-safeDt * 4.2);
    }

    // Working state traveling wave phase
    if (this.currentState === KAI_STATES.WORKING) {
      m.furWavePhase += safeDt * 2.2;
    } else {
      m.furWavePhase += safeDt * 0.4;
    }

    // 5. Smoothly Interpolate Material Color Palettes
    const colorLerp = Math.min(1.0, safeDt * 4.5);
    this.currentColors.baseColor.lerp(this.targetColors.baseColor, colorLerp);
    this.currentColors.tipColor.lerp(this.targetColors.tipColor, colorLerp);
    this.currentColors.skinColor.lerp(this.targetColors.skinColor, colorLerp);
    this.currentColors.rimColor.lerp(this.targetColors.rimColor, colorLerp);
    this.currentColors.specular += (this.targetColors.specular - this.currentColors.specular) * colorLerp;
    this.currentColors.roughness += (this.targetColors.roughness - this.currentColors.roughness) * colorLerp;

    // Legacy compatibility bridge for existing code paths
    this.currentParams = {
      headPitch: m.tiltPitch,
      headYaw: m.tiltYaw,
      headRoll: m.tiltRoll,
      postureOffsetY: m.liftY,
      postureScaleY: m.squash,
      breathSpeed: s.breathSpeed,
      breathAmp: s.breathAmp,
      eyeSquint: m.eyeSquint,
      lookBiasX: m.lookBiasX,
      lookBiasY: m.lookBiasY,
      accentColor: this.currentColors.tipColor,
      accentIntensity: this.currentColors.specular,
      alertGlow: m.furPulse
    };
  }
}
