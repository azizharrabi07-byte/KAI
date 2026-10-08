/**
 * The visual engine wired into NORMAL KAI messages.
 *
 * A normal KAI reply may carry a diagram. This module is the seam that turns
 * such a reply into a drawing — and it does so through the SAME boundary the
 * rest of the product uses:
 *
 *     message text  →  extract the fenced dialect block  →  Core compile
 *                   →  the engine renders the VALIDATED intent
 *
 * Model text NEVER becomes DOM/SVG directly. `compile` is `VisualHost.compile`
 * (see `src/visual/mount.ts`), which POSTs `/visual/compile`: Core validates the
 * dialect and returns a bounded intent, or REFUSES with a code and a reason. A
 * refusal is surfaced verbatim; nothing is repaired and nothing is drawn.
 *
 * `extractVisualBlocks` is pure and DOM-free, so the parse half is fully
 * testable; `presentKaiMessage` takes an injectable host, so the compile half is
 * testable with no DOM and no network.
 */

/** The part of `VisualHost` this module needs. Kept structural so tests can fake it. */
export interface VisualCompileHost {
  compile(source: string): Promise<{ ok: boolean; code?: string; reason?: string }>;
}

/** The result of splitting a message into prose and visual sources. */
export interface ExtractedVisual {
  /** The prose with each visual block replaced by a short marker. */
  text: string;
  /** The dialect sources, in the order they appeared. */
  blocks: string[];
}

/** Fence info strings this build treats as a visual source. */
const VISUAL_FENCES = new Set(["kai-visual", "mermaid", "flowchart", "graph", "sequence", "sequencediagram"]);

/** The marker left in the prose where a diagram was rendered. */
export const VISUAL_MARKER = "▦";

const FENCE_RE = /^(\s*)(`{3,}|~{3,})\s*([A-Za-z][\w-]*)?\s*$/;

/**
 * Split a message into prose and visual sources. A fenced block whose info
 * string names a supported dialect becomes a source; every other fenced block
 * (a `ts` snippet, a shell command) is left exactly as it was, because only the
 * supported dialects can be compiled.
 */
export function extractVisualBlocks(text: string): ExtractedVisual {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  const blocks: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const open = FENCE_RE.exec(line);
    const info = open?.[3]?.toLowerCase();
    if (open !== null && info !== undefined && VISUAL_FENCES.has(info)) {
      const fence = open[2] ?? "```";
      const body: string[] = [];
      i += 1;
      // Consume until the matching close fence (same character, at least as long).
      let closed = false;
      while (i < lines.length) {
        const raw = lines[i] ?? "";
        const trimmed = raw.trim();
        if (trimmed.length >= fence.length && trimmed.startsWith(fence[0] ?? "`") && /^[`~]+$/.test(trimmed)) {
          closed = true;
          i += 1;
          break;
        }
        body.push(raw);
        i += 1;
      }
      const source = body.join("\n").trim();
      if (source.length > 0) {
        blocks.push(source);
        out.push(`${VISUAL_MARKER} diagram`);
      } else {
        // An empty block is nothing to draw; keep the fence so the user's text is
        // not silently altered.
        out.push(line, ...body.slice(), closed ? fence : "");
      }
      continue;
    }
    out.push(line);
    i += 1;
  }

  return { text: out.join("\n"), blocks };
}

export interface VisualMessageOutcome {
  source: string;
  ok: boolean;
  /** Core's refusal code, when the validator refused. */
  code?: string;
  /** Core's refusal reason, verbatim. */
  reason?: string;
}

export interface PresentedMessage {
  /** The prose to show (visual blocks replaced by a marker). */
  text: string;
  /** One outcome per visual block, in order. Empty when there was none. */
  outcomes: VisualMessageOutcome[];
}

/**
 * Present a normal KAI message: draw any diagrams it carries through the visual
 * host, and return the prose alongside one outcome per block.
 *
 * A `null` host (the workspace running with no engine mounted, e.g. a headless
 * test) is HONEST, not a failure: the prose is returned with its blocks intact
 * and no outcomes, so a caller can decide to show the raw source rather than a
 * half-drawn picture.
 */
export async function presentKaiMessage(
  host: VisualCompileHost | null,
  text: string,
): Promise<PresentedMessage> {
  const { text: prose, blocks } = extractVisualBlocks(text);
  if (host === null || blocks.length === 0) {
    return { text, outcomes: [] };
  }
  const outcomes: VisualMessageOutcome[] = [];
  for (const source of blocks) {
    const res = await host.compile(source);
    const outcome: VisualMessageOutcome = { source, ok: res.ok };
    if (res.code !== undefined) outcome.code = res.code;
    if (res.reason !== undefined) outcome.reason = res.reason;
    outcomes.push(outcome);
  }
  return { text: prose, outcomes };
}
