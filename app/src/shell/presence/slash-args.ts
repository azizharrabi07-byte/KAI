// The `/` palette's one decision that must not touch the composer: whether the
// text already carries an argument after the command name.
//
// Split out of `presence.ts` (which is DOM-bound) so the rule can be tested
// directly. It exists because accepting a palette row WRITES the row's template
// (`/work `) over the input, so doing that while the person has already typed
// arguments silently discards the whole task and submits a bare command — the
// reported "`/work` loses the task text" defect.

/** The command name and everything after it, as the palette parses the input. */
export function splitComposer(value: string): { name: string; args: string } | null {
  // `[\s\S]` rather than `.`: a task description may be a multi-line paste, and
  // `.` stops at the first newline — which would truncate the argument the palette
  // is deciding whether to preserve. `runSlash` already parses with `[\s\S]`.
  const match = /^\/([\w-]*)([\s\S]*)$/.exec(value);
  if (match === null) return null;
  return { name: match[1] ?? "", args: (match[2] ?? "").trim() };
}

/**
 * True when the person has already typed an argument, so the palette must not
 * overwrite the composer with a row's template.
 */
export function hasTypedArgs(value: string): boolean {
  const split = splitComposer(value);
  return split !== null && split.args.length > 0;
}
