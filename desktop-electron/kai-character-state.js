(() => {
'use strict';

// kai-character-state.js — what KAI's face is doing, from real events only.
//
// The character (`ghost-thinking.js`) is a painter: it knows how to draw a state and
// nothing about why. This file is the only thing that decides the state, and every
// decision is traceable to something the app really did:
//
//   KAI2 state        the engine state it drives   the real event behind it
//   ─────────────────────────────────────────────  ─────────────────────────────────────────────
//   nothing happening  idle                        the default: no turn, no draft, no notice
//   you are writing    listening                   the composer holds a draft (`.composer-input`
//                                                  with text) — the user is addressing KAI
//   a turn is running  thinking                    `Providers.stream` was called and no word has
//                                                  come back yet (Core's own `turn.started` →
//                                                  THINKING, app/src/core/runtime-state.ts)
//   KAI is talking     working                     a text delta arrived on that stream (the
//     ("speaking")                                 engine has no talking face; its only
//                                                  "producing" pose is working — the same face
//                                                  Core's `item.completed` maps to)
//   asked to approve   waiting_approval            an unanswered approval card is in the thread
//                                                  (`.approval:not(.is-answered)`)
//   the turn failed    error                       the turn's promise rejected (AbortError = the
//                                                  user stopped it: back to idle, not an error)
//   the turn finished  success                     the turn's promise resolved
//   Core is unusable   offline                     the compatibility notice is showing
//                                                  (`#kai-core-compat`: unreachable, wrong
//                                                  build, malformed, stale, unverifiable)
//
// Ranking, most binding first: offline → error/success → waiting_approval → turn →
// listening → idle. A safety state is never hidden behind a cosmetic one, and nothing
// here invents work: there is no timer that enters a busy state.

const EVENT = 'kai:character-state';

// The engine's own resting paces: the success pose settles over ~2.6 s (orb.ts) and
// says so in its step sequence; an error holds long enough to be read.
const SUCCESS_HOLD = 2600;
const ERROR_HOLD = 4200;

const flags = { offline: false, approval: false, turn: null, flash: null, flashTimer: 0 };
let current = 'idle';
let pending = 0;
let compatNode = null;

/** Is there a draft in the composer? Read live, so a composer cleared by the app is seen. */
function listening() {
 const input = document.querySelector('.composer-input');
 return Boolean(input) && !input.disabled && input.value.trim().length > 0;
}

/** The two notices that live in the DOM: an approval waiting, and an unusable Core. */
function readNotices() {
 flags.approval = Boolean(document.querySelector('.approval:not(.is-answered)'));
 const compat = document.getElementById('kai-core-compat');
 if (compat && compat !== compatNode) {
  compatNode = compat;
  new MutationObserver(schedule).observe(compat, { attributes: true, attributeFilter: ['style', 'data-state'] });
 }
 // A verdict that is not `compatible` is a Core KAI2 refuses to send a turn to
 // (desktop/core-stream.js gates on it), so the honest face is offline — asleep.
 flags.offline = Boolean(compat) && compat.style.display !== 'none'
  && compat.dataset.state !== 'compatible';
}

function resolve() {
 if (flags.offline) return 'offline';
 if (flags.flash) return flags.flash.name;
 if (flags.approval) return 'waiting_approval';
 if (flags.turn) return flags.turn;
 if (listening()) return 'listening';
 return 'idle';
}

function apply() {
 readNotices();
 const next = resolve();
 if (next === current) return;
 current = next;
 document.dispatchEvent(new CustomEvent(EVENT, { detail: { state: next } }));
}

/** Coalesce the DOM readback: at most one re-resolve per frame, however busy the thread is. */
function schedule() {
 if (pending) return;
 pending = requestAnimationFrame(() => { pending = 0; apply(); });
}

/** A state that holds for `ms` and then gives way to whatever is really true. */
function flash(name, ms) {
 window.clearTimeout(flags.flashTimer);
 flags.flash = { name };
 apply();
 flags.flashTimer = window.setTimeout(() => {
  flags.flash = null;
  apply();
 }, ms);
}

/**
 * The turn, at the one place the renderer reaches a model. `kai-bridge.js` installs
 * `Providers.stream` (and the whole OpenGhost agent loop never runs because that seam
 * always returns no tool calls), so wrapping it here watches the real turn from
 * outside — no invented timing, no polling.
 */
function wrapTurn() {
 const providers = window.Providers;
 if (!providers || typeof providers.stream !== 'function' || providers.stream.__kaiCharacter) return;
 const real = providers.stream;
 const wrapped = function stream(config, options) {
  const opts = options || {};
  let spoke = false;
  flags.turn = 'thinking';
  apply();
  const wrappedOptions = Object.assign({}, opts, {
   onContent(delta, info) {
    if (!spoke) { spoke = true; flags.turn = 'working'; apply(); }
    if (typeof opts.onContent === 'function') opts.onContent(delta, info);
   },
  });
  const settle = (name, ms) => { flags.turn = null; if (name) flash(name, ms); else apply(); };
  return Promise.resolve()
   .then(() => real.call(this, config, wrappedOptions))
   .then(
    value => { settle('success', SUCCESS_HOLD); return value; },
    error => {
     // A turn the user stopped is not a failure — it just ends.
     if (error && error.name === 'AbortError') settle(null);
     else settle('error', ERROR_HOLD);
     throw error;
    },
   );
 };
 wrapped.__kaiCharacter = true;
 providers.stream = wrapped;
}

// ── Wiring ────────────────────────────────────────────────────────────────────────

// The composer is the one place the user addresses KAI, so its own `input` event is
// the whole "listening" signal (the state itself is read live in `listening()`).
document.addEventListener('input', event => {
 if (event.target instanceof Element && event.target.classList.contains('composer-input')) schedule();
}, true);

// Cards and errors are appended; a coalesced readback keeps up with a streaming thread
// without walking the document once per token.
new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });

// kai-bridge.js installs the provider seam when it loads; if that has not happened yet,
// keep asking. Guarded by `__kaiCharacter`, so a repeated call never double-wraps.
function install() {
 wrapTurn();
 if (!(window.Providers && window.Providers.stream && window.Providers.stream.__kaiCharacter)) {
  setTimeout(install, 200);
 }
}
install();

apply();

window.KaiCharacterState = {
 get current() { return current; },
 /** Re-read the notices and re-resolve (used by verification, and by nothing else). */
 refresh() { apply(); return current; },
};
})();
