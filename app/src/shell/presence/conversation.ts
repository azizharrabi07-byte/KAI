// Which chat surface the main window is showing — the thread or the greeting.
//
// This is the ONE decision behind the owner's "sending a prompt throws me back
// to Home" report, extracted so it can be tested without a DOM.
//
// WHY IT EXISTS: the presence interface overloads a single CSS class (`.talking`)
// for TWO different questions — "is a turn in flight?" and "is there a
// conversation to show?". `runTurn`'s completion path removed that class 600ms
// after EVERY turn (so the composer could settle), and the stylesheet ties the
// greeting hero and the thread to it: `.talking .thread{display:block}` /
// `.talking .hero{display:none}`. So as soon as the reply arrived the thread was
// hidden and the greeting hero — the landing/Home screen — came back, even though
// the conversation was still loaded. The route never changed; the surface did.
//
// The fix is that the thread is in front whenever there is a conversation OR a
// live turn. A finished turn must NOT remove it. That is the invariant this
// module states, and `presence.ts` computes the class from it instead of adding
// and blindly removing the class by hand.

export interface ChatSurfaceState {
  /** Turns currently loaded for the active session. */
  turns: number;
  /** A turn is being sent/handled right now. */
  busy: boolean;
}

/**
 * True when the chat surface must show the thread rather than the greeting.
 *
 * A turn in flight counts even before the first reply (turns may still be 0), and
 * a loaded conversation counts even when idle — which is the regression case: the
 * moment a turn finishes it is idle again, and the conversation must stay.
 */
export function conversationVisible(state: ChatSurfaceState): boolean {
  return state.busy || state.turns > 0;
}
