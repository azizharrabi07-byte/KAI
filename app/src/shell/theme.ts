// KAI's theme system — Light / Dark / System, applied consistently and persisted.
//
// The presence UI was authored as a single (light) design; there was no theme at
// all, which is why "dark mode" did nothing. This module is the ONE authority for
// the choice:
//
//   * the mode is one of `light | dark | system` and is PERSISTED (localStorage,
//     key `kai.theme`), so it survives a reload and a window re-open;
//   * `system` follows the OS `prefers-color-scheme` LIVE — changing the OS theme
//     repaints KAI without a restart;
//   * the resolved theme is written as `data-theme="light|dark"` (and the chosen
//     mode as `data-theme-mode`) on an element — the presence root — so the
//     stylesheet can key off it. `data-theme` is also mirrored on
//     `document.documentElement` so globals (scrollbars, the page background)
//     agree.
//
// The pure parts (mode parsing, system resolution, cycling) are DOM-free and
// tested with no browser; the controller guards every global it touches, so it
// is safe under `node --test` too.

export type ThemeMode = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

/** The localStorage key. One shared key, so any KAI window agrees on the theme. */
export const THEME_STORAGE_KEY = "kai.theme";

export const THEME_MODES: readonly ThemeMode[] = ["light", "dark", "system"];

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === "light" || value === "dark" || value === "system";
}

/** Parse a stored/raw value into a mode. Anything unrecognised is `system`. */
export function parseThemeMode(value: string | null | undefined): ThemeMode {
  return isThemeMode(value) ? value : "system";
}

/** The concrete theme a mode resolves to, given the OS preference. */
export function resolveTheme(mode: ThemeMode, prefersDark: boolean): ResolvedTheme {
  if (mode === "light") return "light";
  if (mode === "dark") return "dark";
  return prefersDark ? "dark" : "light";
}

/** Cycle order for a single toggle button: Light → Dark → System → Light. */
export function nextThemeMode(mode: ThemeMode): ThemeMode {
  return mode === "light" ? "dark" : mode === "dark" ? "system" : "light";
}

/** A human label for the current choice, for a button/palette hint. */
export function themeLabel(mode: ThemeMode): string {
  return mode === "light" ? "Light" : mode === "dark" ? "Dark" : "System";
}

/** Read the persisted mode. Guarded so it is safe with no DOM / no storage. */
export function readThemeMode(): ThemeMode {
  try {
    if (typeof localStorage === "undefined") return "system";
    return parseThemeMode(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

/** Persist the mode. Guarded: a blocked storage must not break the UI. */
export function writeThemeMode(mode: ThemeMode): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    /* private mode / quota — the in-memory choice still applies for this session */
  }
}

export interface ThemeState {
  mode: ThemeMode;
  resolved: ResolvedTheme;
}

export type ThemeListener = (state: ThemeState) => void;

/**
 * The live theme: owns the persisted choice, the OS-preference listener and the
 * DOM attributes. One instance per window.
 */
export class ThemeController {
  private readonly listeners = new Set<ThemeListener>();
  private currentMode: ThemeMode;
  private mql: MediaQueryList | null = null;
  private mqlHandler: ((e: MediaQueryListEvent) => void) | null = null;

  constructor(private readonly el: HTMLElement) {
    this.currentMode = readThemeMode();
  }

  get mode(): ThemeMode {
    return this.currentMode;
  }

  get resolved(): ResolvedTheme {
    return resolveTheme(this.currentMode, this.prefersDark());
  }

  state(): ThemeState {
    return { mode: this.currentMode, resolved: this.resolved };
  }

  /** Apply once and start following the OS preference (if the window has one). */
  start(): void {
    this.apply();
    try {
      if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
        this.mql = window.matchMedia("(prefers-color-scheme: dark)");
        this.mqlHandler = () => {
          // Only `system` cares; a fixed choice is unaffected by the OS.
          if (this.currentMode === "system") this.apply();
        };
        // addEventListener is the modern API; fall back for very old engines.
        if (typeof this.mql.addEventListener === "function") this.mql.addEventListener("change", this.mqlHandler);
        else if (typeof this.mql.addListener === "function") this.mql.addListener(this.mqlHandler);
      }
    } catch {
      /* no matchMedia — a fixed theme is still fully functional */
    }
  }

  stop(): void {
    if (this.mql !== null && this.mqlHandler !== null) {
      try {
        if (typeof this.mql.removeEventListener === "function") this.mql.removeEventListener("change", this.mqlHandler);
        else if (typeof this.mql.removeListener === "function") this.mql.removeListener(this.mqlHandler);
      } catch {
        /* nothing to detach */
      }
    }
    this.mql = null;
    this.mqlHandler = null;
  }

  /** Choose a mode: persist it, apply it, notify every listener. */
  set(mode: ThemeMode): void {
    if (mode === this.currentMode) {
      this.apply();
      return;
    }
    this.currentMode = mode;
    writeThemeMode(mode);
    this.apply();
  }

  /** Advance Light → Dark → System. Returns the new mode. */
  cycle(): ThemeMode {
    this.set(nextThemeMode(this.currentMode));
    return this.currentMode;
  }

  subscribe(fn: ThemeListener): () => void {
    this.listeners.add(fn);
    fn(this.state());
    return () => this.listeners.delete(fn);
  }

  /** Write the resolved theme to the element and the document root, then emit. */
  private apply(): void {
    const state = this.state();
    this.el.dataset.theme = state.resolved;
    this.el.dataset.themeMode = state.mode;
    try {
      if (typeof document !== "undefined") document.documentElement.dataset.theme = state.resolved;
    } catch {
      /* no document over the element — the root attribute is enough */
    }
    for (const fn of this.listeners) {
      try {
        fn(state);
      } catch {
        /* a repaint must not break the controller */
      }
    }
  }

  private prefersDark(): boolean {
    try {
      if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
        return window.matchMedia("(prefers-color-scheme: dark)").matches;
      }
    } catch {
      /* fall through to light */
    }
    return false;
  }
}
