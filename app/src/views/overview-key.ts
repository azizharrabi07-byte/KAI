/**
 * The overview left-card's rebuild key.
 *
 * Why this is its own module: the key decides whether `buildOverview.sync()`
 * tears down and re-renders the focused card, and it is the exact thing that was
 * wrong. KAI's own card renders `State.runtimeLabel` and the Core connection
 * (see `integrations.ts` `kaiCard`), but the key was built only from
 * `task.id / state / steps` plus the integration data — so a runtime change left
 * the card on screen with a stale label: the glow moved to USING_TOOL while the
 * text a user actually reads still said "KAI is idle". The two inputs the card
 * reads are now part of the key. Pure and DOM-free so it can be pinned without a
 * WebView.
 */

/** Everything `buildOverview.sync()` folds into the left card's identity. */
export interface OverviewCardKeyInput {
  /** `task.id` — which card is focused. */
  id: string;
  /** Whether an integration card is showing its detail sub-view. */
  detailOpen: boolean;
  /** `task.state` — the focused worker's own state. */
  state: string;
  /** `task.steps` — the worker's step log. */
  steps: readonly string[];
  /** The integration poller's last report, when the focused card is one. */
  loaded?: boolean;
  error?: string | null;
  configured?: boolean;
  data?: unknown;
  /** KAI's own runtime state (`State.runtime`). KAI's card label reads this. */
  runtime: string;
  /** The Core connection (`State.core.conn`). KAI's card accent/meta read this. */
  connection: string;
}

/**
 * A stable string that changes exactly when the focused card's rendered content
 * would change. The separator and order are deliberate: equal inputs must give
 * the same string, and any field's change must give a different one.
 */
export function overviewCardKey(i: OverviewCardKeyInput): string {
  return [
    i.id,
    i.detailOpen,
    i.state,
    i.steps.join("|"),
    i.loaded,
    i.error,
    i.configured,
    JSON.stringify(i.data ?? {}),
    // The two the KAI card renders but the key previously ignored.
    i.runtime,
    i.connection,
  ].join("~");
}
