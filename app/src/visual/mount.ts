// KAI Visual Engine — the UI host and its product wiring.
//
// This is the seam's last mile. It owns the one `#kai-visual` host element, the
// one engine instance that draws into it, and the `window.__kaiVisual` handle the
// live verification harness (and, in the product, the Core-driven visual path)
// reaches. It follows the precedent of `src/character/**`: `types.ts` is the
// shared vocabulary, `layout.ts` + `engine.ts` are the mechanism, and this file
// puts the mechanism on screen.
//
// Nothing here decides WHAT to draw. A model's raw text is compiled by KAI Core
// (`POST /visual/compile`), which VALIDATES it and returns either a bounded
// typed intent or a refusal; this host renders only the validated intent, and the
// engine re-guards it before drawing. Model text never becomes DOM/SVG directly.
//
// The mechanism (a rank-layered flow drawn as an animated SVG scene) is adapted
// from OpenGhost's MIT-covered `diagram.js`; the host, the styling and the
// contract are KAI's own. No OpenGhost stylesheet, class name or visual identity
// is used — see NOTICE.md.

import type { Island } from "../island/island";
import type { CoreClient } from "../core/kai-core";
import { KaiVisualEngine, type RenderResult } from "./engine";

/**
 * The result of a compile→render round-trip.
 *
 * `via: "core"` is not decoration: it records that the intent reached the
 * renderer only after passing the Core validator. `code`/`reason` carry Core's
 * own refusal payload verbatim when the validator rejected the source.
 */
export interface VisualCompileOutcome {
  ok: boolean;
  via: "core";
  /** Core's refusal code (e.g. `UNSAFE_NODE_LABEL`), when the validator refused. */
  code?: string;
  reason?: string;
  /** The renderer's own receipt (or its own rejection) once Core returned an intent. */
  receipt?: RenderResult;
}

/** The host's public surface — what the product and the harness both use. */
export interface VisualHost {
  /** The host element (`#kai-visual`). */
  readonly el: HTMLElement;
  /** Compile raw dialect text via Core, then render the validated intent. */
  compile(source: string): Promise<VisualCompileOutcome>;
  /** Render an already-structured intent (still re-guarded by the engine). */
  render(intent: unknown): RenderResult;
  /** Bring the island up and show the host. */
  reveal(): void;
  /** Hide the host. */
  hide(): void;
}

/**
 * Mounts the visual host into `root` and returns its handle.
 *
 * `island.expand(...)` is called before the host is shown: the host is a
 * fixed-position panel over the island window, so the window must be open (not a
 * collapsed wake strip) for it to have room. Expanding to an existing view keeps
 * the island's own layout untouched — this slice adds no island view.
 */
export function mountVisual(root: HTMLElement, island: Island, client: CoreClient): VisualHost {
  const el = document.createElement("section");
  el.id = "kai-visual";
  el.className = "kai-visual";
  el.hidden = true;
  el.setAttribute("role", "img");
  el.setAttribute("aria-label", "KAI visual");
  root.appendChild(el);

  // The ONE engine the product draws with. Its constructor registers
  // `window.__kaiVisualEngine`, so a harness reaches the real renderer.
  const engine = new KaiVisualEngine(el);

  const reveal = (): void => {
    island.expand("overview");
    el.hidden = false;
  };

  const hide = (): void => {
    el.hidden = true;
  };

  const render = (intent: unknown): RenderResult => {
    reveal();
    return engine.render(intent);
  };

  const compile = async (source: string): Promise<VisualCompileOutcome> => {
    const res = await client.visualCompile(source);
    if (!res.ok) {
      // A transport failure (Core down, timeout, unreadable body). Nothing was
      // drawn and nothing was validated.
      return { ok: false, via: "core", code: res.error.code, reason: res.error.reason ?? res.error.message };
    }
    if (!res.value.ok) {
      // Core's validator REFUSED the source and named the offending field. This
      // is the security boundary working: model text did NOT become a drawing.
      return { ok: false, via: "core", code: res.value.code, reason: res.value.reason };
    }
    reveal();
    const receipt = engine.render(res.value.intent);
    return { ok: receipt.ok, via: "core", receipt };
  };

  const host: VisualHost = { el, compile, render, reveal, hide };

  // The live verification harness reaches the REAL host — the same one the
  // product uses — never a stub.
  (window as unknown as { __kaiVisual?: VisualHost }).__kaiVisual = host;

  return host;
}
