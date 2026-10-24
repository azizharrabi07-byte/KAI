// KAI3D — the runtime-state → avatar-state bridge.
//
// KAI2 already decides what KAI is doing, in ONE place: `kai-character-state.js`
// resolves the state from real events (a turn's promise, a text delta, an approval
// card in the DOM, the Core compatibility notice) and dispatches it on
// `kai:character-state`. This module translates that vocabulary into the 3D
// character's own state machine and makes sure a one-shot animation only fires on
// a REAL transition.
//
// It is pure (no DOM, no three.js) so the rules are provable in a node test:
//   • an unknown state is never invented — `avatarStateFor` returns null and the
//     avatar keeps the face it had;
//   • a repeated state never re-fires an entrance animation, however often the
//     emitter repeats it;
//   • a state the app cannot observe is reported as unmapped instead of faked.

/** KAI2's runtime face vocabulary (kai-character-state.js), as documented there. */
export const KAI2_STATES = Object.freeze([
  'idle',
  'listening',
  'thinking',
  'working',
  'waiting_approval',
  'error',
  'success',
  'offline',
]);

/**
 * The 3D character's states (kaiState.js `KAI_STATES`), repeated here as strings so
 * this module stays dependency-free.
 */
export const AVATAR_STATES = Object.freeze([
  'idle',
  'thinking',
  'working',
  'waiting_for_approval',
  'error',
  'success',
  'paused',
  'offline',
]);

/**
 * KAI2 state → avatar state.
 *
 * `listening` maps to `idle`: the 3D character has no separate listening pose, and
 * KAI is not doing anything yet — a made-up pose would be a lie. The state still
 * matters to the studio (it shows "listening" in the live readout), it just does not
 * invent a body animation.
 */
export const STATE_MAP = Object.freeze({
  idle: 'idle',
  listening: 'idle',
  thinking: 'thinking',
  working: 'working',
  waiting_approval: 'waiting_for_approval',
  error: 'error',
  success: 'success',
  offline: 'offline',
});

/** The avatar states KAI2 cannot currently signal. Reported, never fabricated. */
export const UNMAPPED_AVATAR_STATES = Object.freeze(['paused']);

/** Which states also fire the indicator one-shots (success sparkle / error cue). */
export const INDICATOR_SHOTS = Object.freeze({ success: 'success', error: 'error' });

/**
 * Normalizes a state name (either vocabulary, case-insensitive) to an avatar state.
 * Returns null for anything this build cannot render honestly.
 */
export function avatarStateFor(state) {
  if (typeof state !== 'string') return null;
  const key = state.trim().toLowerCase();
  if (STATE_MAP[key]) return STATE_MAP[key];
  // The avatar's own vocabulary is accepted as-is (used by the motion preview).
  return AVATAR_STATES.includes(key) ? key : null;
}

/** The KAI2 state that caused the current avatar state, for the live readout. */
export function labelForState(state) {
  const labels = {
    idle: 'Idle',
    listening: 'Listening',
    thinking: 'Thinking',
    working: 'Working',
    waiting_approval: 'Waiting for approval',
    error: 'Error',
    success: 'Success',
    offline: 'Offline',
    waiting_for_approval: 'Waiting for approval',
    paused: 'Paused',
  };
  return labels[state] || String(state);
}

/**
 * A gate over the avatar state machine.
 *
 * `next(runtimeState)` returns `{ state, changed, shot }`:
 *   • `state`   — the avatar state to show (or the previous one for unknown input);
 *   • `changed` — true only when this is a real transition (the renderer may play
 *                 its entrance animation);
 *   • `shot`    — 'success' | 'error' when a one-shot indicator should fire, else null.
 *
 * The gate keeps no timers: the caller decides how long a state is held. Repeating
 * the same state is a no-op, which is what stops a celebration re-firing while a
 * turn's status keeps being re-read.
 */
export class AvatarStateGate {
  constructor(initial = 'idle') {
    this.current = avatarStateFor(initial) || 'idle';
    this.runtime = avatarStateFor(initial) ? initial : 'idle';
    this.shot = null;
  }

  /**
   * @param {string} runtimeState a KAI2 or avatar state name
   * @param {{ replay?: boolean }} [options] replay re-fires a one-shot for the SAME state
   */
  next(runtimeState, options = {}) {
    const state = avatarStateFor(runtimeState);
    if (!state) return { state: this.current, changed: false, shot: null, unknown: true };
    const changed = state !== this.current || options.replay === true;
    const shot = changed ? INDICATOR_SHOTS[state] || null : null;
    this.current = state;
    this.runtime = runtimeState;
    this.shot = shot;
    return { state, changed, shot, unknown: false };
  }

  reset() {
    this.current = 'idle';
    this.runtime = 'idle';
    this.shot = null;
  }
}
