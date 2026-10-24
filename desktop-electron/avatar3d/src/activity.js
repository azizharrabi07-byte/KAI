// KAI3D — the TOOL activity adapter.
//
// KAI2 already records every real tool execution Core reports: `window.KAI2.activity()`
// and `window.KAI2.onActivity(listener)` expose the bridge's own entries, and
// `kai-activity.js` renders them. The character consumes the SAME stream so the face can
// say "a tool is running" while a tool is running, instead of waiting for the model to
// start speaking.
//
// Rules kept here:
//   • only Core's own phases/statuses are read (`tool_start`, `tool_done`,
//     `tool_error`, `tool_approval_required`, EXECUTED/DENIED/FAILED/…);
//   • an entry KEY is used for dedupe: the bridge updates one row per call, and a
//     repeated frame must not restart an animation;
//   • a finished tool is NEVER a celebration — completion belongs to the turn, which
//     the runtime state already reports;
//   • a denied tool is a person's decision, not a system error; only a real failure
//     asks for the error behaviour.

/** What one activity entry means to the character. */
export const TOOL_KINDS = Object.freeze(['started', 'approval', 'failed', 'finished']);

const TERMINAL = new Set(['EXECUTED', 'DENIED', 'INVALID', 'FAILED', 'NOT_FOUND']);
const FAILED_STATUS = new Set(['INVALID', 'FAILED', 'NOT_FOUND']);

/**
 * Normalizes one bridge entry. Returns null for anything that is not an actionable
 * tool event (no phase, no key) so the face never reacts to a malformed row.
 */
export function toToolEvent(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const key = typeof entry.key === 'string' ? entry.key : '';
  const phase = typeof entry.phase === 'string' ? entry.phase : '';
  const status = typeof entry.status === 'string' ? entry.status : '';
  if (!key || !phase) return null;

  if (status === 'APPROVAL_REQUIRED' || phase === 'tool_approval_required') {
    return { kind: 'approval', key, name: entry.name || '', status };
  }
  if (FAILED_STATUS.has(status) || phase === 'tool_error') {
    return { kind: 'failed', key, name: entry.name || '', status };
  }
  if (TERMINAL.has(status) || phase === 'tool_done') {
    // DENIED is terminal but not a failure: the person said no.
    return { kind: 'finished', key, name: entry.name || '', status };
  }
  if (phase === 'tool_start') {
    return { kind: 'started', key, name: entry.name || '', status };
  }
  return null;
}

/**
 * Tracks the tools that are genuinely in flight for the current conversation.
 *
 * `update(event)` returns true when the face it implies CHANGED, which is what makes a
 * repeated `tool_start` frame a no-op. `face()` returns the character state the tool
 * activity asks for, or null when no tool is active.
 */
export class ToolActivityState {
  constructor() {
    this.running = new Set();
    this.approvals = new Set();
    this._face = null;
  }

  update(event) {
    if (!event) return false;
    switch (event.kind) {
      case 'started':
        this.running.add(event.key);
        break;
      case 'approval':
        this.approvals.add(event.key);
        break;
      case 'finished':
        this.running.delete(event.key);
        this.approvals.delete(event.key);
        break;
      case 'failed':
        this.running.delete(event.key);
        this.approvals.delete(event.key);
        break;
      default:
        return false;
    }
    const next = this.face();
    return next !== this._face && ((this._face = next), true);
  }

  face() {
    if (this.approvals.size > 0) return 'waiting_for_approval';
    if (this.running.size > 0) return 'working';
    return null;
  }

  /** The conversation changed (or was reset): nothing is in flight any more. */
  reset() {
    this.running.clear();
    this.approvals.clear();
    this._face = null;
  }
}

/**
 * Subscribes to the bridge's real activity stream.
 *
 * Returns an unsubscribe function, or null when the bridge is not there (the app's
 * optional surface). Never throws: a missing bridge is a normal state during boot.
 */
export function subscribeToolActivity(api, listener) {
  if (!api || typeof api.onActivity !== 'function' || typeof listener !== 'function') return null;
  try {
    const off = api.onActivity(listener);
    return typeof off === 'function' ? off : null;
  } catch {
    return null;
  }
}
