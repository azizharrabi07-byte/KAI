// Session titles derived from the conversation topic.
//
// Core creates a session with a placeholder title (`Conversation N` — see
// `core/src/sessions/service.ts`). A title that says nothing is not a title:
// this module derives a short, meaningful one from the conversation's FIRST
// user turn, and is deliberately pure so the rule is testable without a DOM,
// a Core or a network.
//
// It never touches a title a person chose: only a generic placeholder is
// eligible (`isGenericSessionTitle`). That is what keeps an explicit rename
// authoritative — the derived title can only ever fill a gap, never overwrite.

/** Core's placeholder shape, plus the obvious variants. */
const GENERIC = /^(conversation\s*\d*|new conversation|new session|session\s*\d*|untitled|chat\s*\d*)$/i;

/** Is this title a placeholder Core (or we) put there, rather than a name? */
export function isGenericSessionTitle(title: string | null | undefined): boolean {
  if (typeof title !== "string") return true;
  const trimmed = title.trim();
  if (trimmed.length === 0) return true;
  return GENERIC.test(trimmed);
}

const MAX_TITLE_CHARS = 68;

/**
 * Derive a topic title from one turn's text.
 *
 * The rules, in order: normalise whitespace; drop leading Markdown noise
 * (bullets, hashes, quotes) and leading pleasantries; cut at the first
 * sentence end so a long opening message does not become a paragraph; then cap
 * at a word boundary. Returns `null` when nothing meaningful survives — the
 * caller keeps Core's title rather than inventing one.
 */
export function deriveSessionTitle(text: string | null | undefined): string | null {
  if (typeof text !== "string") return null;
  let s = text.replace(/\s+/g, " ").trim();
  if (s.length === 0) return null;

  // Strip a leading bullet/heading/quote/list marker and any surrounding quotes.
  s = s.replace(/^(?:[#>*\-+]+\s*|\d{1,3}[.)]\s*)+/, "").trim();
  s = s.replace(/^[«"'“”‘’(\[]+/, "").trim();
  if (s.length === 0) return null;

  // Drop a leading pleasantry so "hey KAI, can you plan my trip" titles as the task.
  s = s.replace(/^(?:hi|hey|hello|yo|ok|okay|please|pls|thanks|thank you)\b[\s,!.…-]*/i, "").trim();
  if (s.length < 2) return null;

  // First sentence, if one closes early.
  const stop = s.search(/[.!?…](?:\s|$)/);
  if (stop > 0 && stop + 1 <= MAX_TITLE_CHARS) s = s.slice(0, stop + 1);

  // Cap on a word boundary.
  if (s.length > MAX_TITLE_CHARS) {
    const cut = s.slice(0, MAX_TITLE_CHARS);
    const space = cut.lastIndexOf(" ");
    s = space > 24 ? cut.slice(0, space) : cut;
  }

  s = s.replace(/[\s,;:.!?…\-–—]+$/, "").trim();
  if (s.length < 2) return null;

  // Capitalise the first letter without disturbing the rest (acronyms, code).
  return s[0]!.toUpperCase() + s.slice(1);
}

/**
 * The title to SHOW for a session.
 *
 * `firstUserText` is the session's first recorded user turn, when the caller
 * has it. A derived title is only produced for a generic placeholder; a real
 * title passes through untouched.
 */
export function sessionDisplayTitle(
  storedTitle: string | null | undefined,
  firstUserText: string | null | undefined,
): { title: string; derived: boolean } {
  const stored = typeof storedTitle === "string" ? storedTitle.trim() : "";
  if (!isGenericSessionTitle(stored)) {
    return { title: stored, derived: false };
  }
  const derived = deriveSessionTitle(firstUserText);
  if (derived !== null) return { title: derived, derived: true };
  // Nothing meaningful yet: say so plainly instead of showing "Conversation 7".
  return { title: stored.length > 0 ? stored : "New conversation", derived: false };
}
