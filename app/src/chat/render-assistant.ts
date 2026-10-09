// The ONE assistant renderer for KAI's production chat surface.
//
// Both the live streaming bubble and the settled/persisted answers in the
// main window render through here — on top of the existing OpenGhost-derived
// `Markdown.blocks` + `StreamView` modules (NOTICE.md / OPEN_GHOST_REUSE_MANIFEST.md
// record the provenance; no upstream branding, artwork, animation or layout is
// reused — the CSS classes below are styled by KAI's own presence.css).
//
// Safety boundary: model text NEVER touches the DOM as HTML except through
// `Markdown.blocks`, which escapes raw HTML and only links http/https/mailto
// URLs (SAFE_URL). `renderAssistantStatic` / `LiveAssistant` are the only two
// entry points; nothing else in the production shell may innerHTML model text.

import { blocks } from "./vendor/markdown";
import { StreamView } from "./vendor/stream-view";
import { VISUAL_MARKER } from "../workspace/visual";

/** Drop the visual-block marker lines the extractor leaves, so prose reads clean. */
export function stripAssistantMarkers(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.trim().startsWith(VISUAL_MARKER))
    .join("\n");
}

/** Render a complete answer once (settled turns, reloaded history). */
export function renderAssistantStatic(host: HTMLElement, text: string): void {
  host.innerHTML = blocks(stripAssistantMarkers(text), { live: false }).join("");
}

export interface LiveAssistant {
  /** Feed the FULL accumulated text; the view morphs incrementally (rAF-batched). */
  push(fullText: string): void;
  /** Settle the view and resolve when the final paint lands. */
  finish(): Promise<void>;
}

/**
 * Incremental live rendering for the streaming bubble. Push the accumulated
 * text on every delta — StreamView diffs and paints only what changed on its
 * own rAF loop, so a delta never rebuilds the conversation or re-parses the
 * whole response from scratch in OUR code.
 */
export function createLiveAssistant(host: HTMLElement, onChange?: () => void): LiveAssistant {
  if (typeof requestAnimationFrame !== "function") {
    // Non-browser/test harness: degrade to static re-render, still safe.
    return {
      push: (fullText: string) => renderAssistantStatic(host, fullText),
      finish: () => Promise.resolve(),
    };
  }
  const view = new StreamView(host, ...(onChange !== undefined ? [{ onChange }] : []));
  return {
    push: (fullText: string) => view.push(stripAssistantMarkers(fullText)),
    finish: () => view.finish() as Promise<void>,
  };
}

/** Bounded inline preview of a tool value for card bodies (history path). */
export const CARD_PREVIEW_CHARS = 2000;

export function previewCardValue(value: unknown): { text?: string; truncated: boolean } {
  if (value === undefined || value === null) return { truncated: false };
  let text: string;
  if (typeof value === "string") text = value;
  else {
    try {
      text = JSON.stringify(value, null, 2) ?? "";
    } catch {
      return { text: "unserialisable result", truncated: false };
    }
  }
  if (text.length === 0) return { truncated: false };
  if (text.length <= CARD_PREVIEW_CHARS) return { text, truncated: false };
  return { text: `${text.slice(0, CARD_PREVIEW_CHARS)}…`, truncated: true };
}

function codeTextOf(codeHost: HTMLElement): string {
  const code = codeHost.querySelector("pre code") ?? codeHost.querySelector("pre");
  return code?.textContent ?? "";
}

/**
 * One delegated listener for every `.md-copy` button the renderer emits
 * (markdown.ts emits the button but wires nothing). Install once on the
 * thread container: copy buttons in streamed AND settled answers work, and
 * there is exactly one listener no matter how many turns render.
 */
export function installCodeCopy(container: HTMLElement, toast: (message: string, kind?: "ok" | "err") => void): void {
  container.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null;
    const button = target?.closest?.(".md-copy") as HTMLElement | null;
    if (button === null || button === undefined || !container.contains(button)) return;
    const host = button.closest(".md-code") as HTMLElement | null;
    if (host === null) return;
    const text = codeTextOf(host);
    if (text.length === 0) return;
    try {
      void navigator.clipboard?.writeText(text).then(
        () => toast("Copied", "ok"),
        () => toast("Copy failed", "err"),
      );
    } catch {
      toast("Copy failed", "err");
    }
  });
}
