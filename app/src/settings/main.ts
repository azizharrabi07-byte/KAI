// Settings window — the place where anything that writes to disk is confirmed:
// KAI's appearance, the workers KAI drives (its own Hermes api-server key), the
// third-party integrations and the general preferences.

import "./settings.css";
import { Bridge, onEvent } from "../core/bridge";
import {
  ALWAYS_ON_INTEGRATION_IDS,
  DEFAULT_SETTINGS,
  MAX_OPT_IN_INTEGRATIONS,
  optInIntegrationCount,
  type Settings,
} from "../core/state";
import { h, clear } from "../views/dom";
import { KaiEngine } from "../character/engine";
import {
  ACCESSORIES,
  KAI_VARIANTS,
  SKINS,
  THEMES,
  applyVariant,
  describeVariant,
  loadVariant,
  makeVariant,
  saveVariant,
  withAccessory,
  withSkin,
  withTheme,
  type KaiVariant,
} from "../character/variant";

let settings: Settings = { ...DEFAULT_SETTINGS };
let version = "";

const root = document.getElementById("settings-root")!;

async function save() {
  await Bridge.saveSettings(settings);
}

// ── Reusable bits ─────────────────────────────────────────────────────────────

function toggle(on: boolean, onChange: (v: boolean) => void): HTMLElement {
  const el = h("button", { class: on ? "switch on" : "switch", "aria-pressed": on });
  el.addEventListener("click", () => {
    const next = !el.classList.contains("on");
    el.classList.toggle("on", next);
    onChange(next);
  });
  return el;
}

function statusDot(ok: boolean): HTMLElement {
  return h("i", { class: "dot", style: `background:${ok ? "#22c55e" : "#f4505e"}` });
}

// ── KAI's worker: Hermes Agent ────────────────────────────────────────────────

/** The key KAI's Core uses for Hermes Agent's authenticated routes. */
const HERMES_KEY = "hermes-api-key";

/**
 * Where the Hermes Agent api-server key lives.
 *
 * This is genuinely a WORKER's key: Hermes Agent is one of KAI's workers, and KAI
 * Core reads this key for Hermes' authenticated routes on 127.0.0.1:8642 — listing
 * sessions, and the chat turns the island does not answer from state. The heading
 * says whose key it is rather than dressing a worker setting up as KAI's own.
 *
 * Same credential store as every other key (Windows Credential Manager). The value is
 * never read back into this page: the field only ever learns whether a key is stored.
 */
function kaiSection(hasKey: boolean): HTMLElement {
  const dot = statusDot(hasKey);
  const state = h("span", {
    class: "hint",
    text: hasKey
      ? "api-server key saved in the Windows Credential Manager."
      : "No api-server key yet — KAI can see Hermes but cannot list sessions or chat through it.",
  });

  const field = h("input", {
    type: "password",
    placeholder: hasKey ? "••••••••••••  (stored)" : "the api-server key",
    style: "flex:1 1 auto;min-width:0",
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;

  const saveBtn = h("button", { class: "primary", text: "Save key" });
  const clearBtn = h("button", { class: "danger", text: "Remove" });
  const feedback = h("div", {});

  async function refresh() {
    const present = (await Bridge.secretPresent(HERMES_KEY)) ?? false;
    dot.style.background = present ? "#22c55e" : "#f4505e";
    state.textContent = present
      ? "api-server key saved in the Windows Credential Manager."
      : "No api-server key yet — KAI can see Hermes but cannot list sessions or chat through it.";
    field.placeholder = present ? "••••••••••••  (stored)" : "the api-server key";
    clearBtn.style.display = present ? "" : "none";
    // The island's Hermes card is fed by the app's own poller, so the card is told to
    // re-read now instead of waiting out its 20 s interval.
    void Bridge.refreshIntegration("integration_hermes");
  }

  saveBtn.addEventListener("click", async () => {
    const value = field.value.trim();
    if (!value) return;
    clear(feedback);
    try {
      await Bridge.secretSet(HERMES_KEY, value);
      field.value = "";
      feedback.append(h("div", { class: "notice ok", text: "Saved. It never touches disk." }));
      await refresh();
    } catch (err) {
      feedback.append(h("div", { class: "notice err", text: `Could not save: ${String(err)}` }));
    }
  });

  clearBtn.addEventListener("click", async () => {
    clear(feedback);
    try {
      await Bridge.secretClear(HERMES_KEY);
      feedback.append(h("div", { class: "notice ok", text: "Key removed." }));
      await refresh();
    } catch (err) {
      feedback.append(h("div", { class: "notice err", text: `Could not remove: ${String(err)}` }));
    }
  });

  clearBtn.style.display = hasKey ? "" : "none";

  return h(
    "section",
    {},
    h("h2", {}, dot, h("span", { text: "KAI's worker: Hermes Agent" })),
    state,
    h("div", { class: "row" }, h("label", { text: "Hermes api-server key" }), field, saveBtn, clearBtn),
    feedback,
    h("div", { class: "hint", text: `Stored as "${HERMES_KEY}" in the Windows Credential Manager. KAI Core reads it when the app starts it; a Core that was already running keeps its old key until it restarts.` }),
  );
}

// ── KAI's direct model (Core-less path) ───────────────────────────────────────
//
// The model + key KAI falls back to when Core is unreachable (the island's own
// chat path in lib.rs). This is NOT Core's model — Core's name/endpoint/timeout
// live in the main window's Settings page backed by POST /settings. Labelled
// plainly so the two are never confused.
const ANTHROPIC_KEY = "anthropic-api-key";

function directModelSection(hasKey: boolean): HTMLElement {
  const dot = statusDot(hasKey);
  const field = h("input", {
    type: "password",
    placeholder: hasKey ? "••••••••••••  (stored)" : "the Anthropic API key",
    style: "flex:1 1 auto;min-width:0",
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;
  const saveBtn = h("button", { class: "primary", text: "Save key" });
  const clearBtn = h("button", { class: "danger", text: "Remove" });
  const feedback = h("div", {});

  async function refresh() {
    const present = (await Bridge.secretPresent(ANTHROPIC_KEY)) ?? false;
    dot.style.background = present ? "#22c55e" : "#f4505e";
    field.placeholder = present ? "••••••••••••  (stored)" : "the Anthropic API key";
    clearBtn.style.display = present ? "" : "none";
  }

  saveBtn.addEventListener("click", async () => {
    const value = field.value.trim();
    if (!value) return;
    clear(feedback);
    try {
      await Bridge.secretSet(ANTHROPIC_KEY, value);
      field.value = "";
      feedback.append(h("div", { class: "notice ok", text: "Saved. It never touches disk." }));
      await refresh();
    } catch (err) {
      feedback.append(h("div", { class: "notice err", text: `Could not save: ${String(err)}` }));
    }
  });

  clearBtn.addEventListener("click", async () => {
    clear(feedback);
    try {
      await Bridge.secretClear(ANTHROPIC_KEY);
      feedback.append(h("div", { class: "notice ok", text: "Key removed." }));
      await refresh();
    } catch (err) {
      feedback.append(h("div", { class: "notice err", text: `Could not remove: ${String(err)}` }));
    }
  });

  clearBtn.style.display = hasKey ? "" : "none";

  const model = h("input", {
    type: "text",
    value: settings.model,
    placeholder: "claude-opus-5",
    style: "flex:1 1 auto;min-width:0",
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;
  model.addEventListener("change", () => {
    const value = model.value.trim();
    if (!value) {
      model.value = settings.model;
      return;
    }
    settings.model = value;
    void save();
  });

  return h(
    "section",
    {},
    h("h2", {}, dot, h("span", { text: "KAI's direct model (no Core)" })),
    h("div", { class: "hint", text: "Only used when KAI Core is unreachable. When Core is up, Core's own model settings apply instead." }),
    h("div", { class: "row" }, h("label", { text: "Model" }), model),
    h("div", { class: "row" }, h("label", { text: "Anthropic key" }), field, saveBtn, clearBtn),
    feedback,
    h("div", { class: "hint", text: `Stored as "${ANTHROPIC_KEY}" in the Windows Credential Manager.` }),
  );
}

// ── Integrations section ──────────────────────────────────────────────────────

interface IntegrationDef {
  id: string;
  name: string;
  color: string;
  /** Credential Manager keys, in the order they are shown. */
  fields: { key: string; label: string; placeholder: string; secret: boolean }[];
}

const INTEGRATIONS: IntegrationDef[] = [
  { id: "integration_stripe", name: "Stripe", color: "#0570DE",
    fields: [{ key: "stripe-api-key", label: "Secret key", placeholder: "sk_live_…", secret: true }] },
  { id: "integration_github", name: "GitHub", color: "#F4505E",
    fields: [{ key: "github-token", label: "Token", placeholder: "ghp_…", secret: true }] },
  { id: "integration_vercel", name: "Vercel", color: "#7C5CFF",
    fields: [{ key: "vercel-token", label: "Token", placeholder: "…", secret: true }] },
  { id: "integration_n8n", name: "n8n", color: "#F29B38",
    fields: [
      { key: "n8n-url", label: "Instance URL", placeholder: "https://n8n.example.com", secret: false },
      { key: "n8n-api-key", label: "API key", placeholder: "…", secret: true },
    ] },
  { id: "integration_resend", name: "Resend", color: "#22C55E",
    fields: [{ key: "resend-api-key", label: "API key", placeholder: "re_…", secret: true }] },
  { id: "integration_notion", name: "Notion", color: "#8C8C8C",
    fields: [{ key: "notion-api-key", label: "Integration token", placeholder: "ntn_…", secret: true }] },
  { id: "integration_calcom", name: "Cal.com", color: "#C9956A",
    fields: [{ key: "calcom-api-key", label: "API key", placeholder: "cal_…", secret: true }] },
];

function integrationsSection(present: Record<string, boolean>): HTMLElement {
  const note = h("div", { class: "hint" });
  const list = h("div", { style: "display:flex;flex-direction:column;gap:14px" });

  function updateNote() {
    // The cap counts opt-in pills only — always-on entries are not a choice
    // and must never eat the budget.
    const used = optInIntegrationCount(settings.activeIntegrations);
    note.textContent = `Pick up to ${MAX_OPT_IN_INTEGRATIONS} pills to show next to KAI — ${used}/${MAX_OPT_IN_INTEGRATIONS} in use. Keys are stored in the Windows Credential Manager, never on disk.`;
  }

  for (const def of INTEGRATIONS) {
    const active = settings.activeIntegrations.includes(def.id);
    const sw = h("button", { class: active ? "switch on" : "switch" });
    sw.addEventListener("click", () => {
      const on = settings.activeIntegrations.includes(def.id);
      if (on) {
        settings.activeIntegrations = settings.activeIntegrations.filter((x) => x !== def.id);
      } else {
        if (ALWAYS_ON_INTEGRATION_IDS.includes(def.id)) return;
        if (optInIntegrationCount(settings.activeIntegrations) >= MAX_OPT_IN_INTEGRATIONS) return;
        settings.activeIntegrations = [...settings.activeIntegrations, def.id];
      }
      sw.classList.toggle("on", !on);
      updateNote();
      void save();
    });

    const rows = h("div", { style: "display:flex;flex-direction:column;gap:6px;flex:1 1 auto;min-width:0" });
    for (const field of def.fields) {
      const input = h("input", {
        type: field.secret ? "password" : "text",
        placeholder: present[field.key] ? "••••••••  (stored)" : field.placeholder,
        autocomplete: "off",
        spellcheck: "false",
        style: "flex:1 1 auto;min-width:0",
      }) as HTMLInputElement;
      const saveBtn = h("button", { text: "Save" });
      const dotEl = statusDot(present[field.key] ?? false);
      saveBtn.addEventListener("click", async () => {
        const value = input.value.trim();
        try {
          await Bridge.secretSet(field.key, value);
          present[field.key] = value.length > 0;
          input.value = "";
          input.placeholder = value ? "••••••••  (stored)" : field.placeholder;
          dotEl.style.background = value ? "#22c55e" : "#f4505e";
        } catch {
          dotEl.style.background = "#f5a524";
        }
      });
      rows.append(
        h("div", { class: "row" },
          h("label", { style: "min-width:104px", text: field.label }),
          input, saveBtn, dotEl,
        ),
      );
    }

    list.append(
      h("div", { style: "display:flex;gap:12px;align-items:flex-start" },
        h("div", { style: "display:flex;align-items:center;gap:8px;min-width:132px;padding-top:4px" },
          sw,
          h("i", { class: "dot", style: `background:${def.color}` }),
          h("span", { style: "font-size:12.5px", text: def.name }),
        ),
        rows,
      ),
    );
  }

  updateNote();
  return h("section", {}, h("h2", {}, h("span", { text: "Integrations" })), note, list);
}

// ── General section ───────────────────────────────────────────────────────────

function generalSection(): HTMLElement {
  const volume = h("input", {
    type: "range", min: "0", max: "0.2", step: "0.005",
    value: String(settings.soundVolume),
  }) as HTMLInputElement;
  volume.addEventListener("input", () => {
    settings.soundVolume = Number(volume.value);
    void save();
  });

  const autoClose = h("input", {
    type: "number", min: "5", max: "120", step: "1",
    value: String(Math.round(settings.autoCloseInterval)),
    style: "width:72px",
  }) as HTMLInputElement;
  autoClose.addEventListener("change", () => {
    settings.autoCloseInterval = Math.max(5, Math.min(120, Number(autoClose.value) || 15));
    autoClose.value = String(settings.autoCloseInterval);
    void save();
  });

  const screen = h("select", {}) as HTMLSelectElement;
  screen.append(
    h("option", { value: "primary", text: "Main display" }),
    h("option", { value: "cursor", text: "Display under the cursor" }),
  );
  screen.value = settings.screen;
  screen.addEventListener("change", () => {
    settings.screen = screen.value as Settings["screen"];
    void save();
  });

  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: "General" })),
    h("div", { class: "row" },
      h("label", { text: "Sound" }),
      toggle(settings.soundEnabled, (v) => { settings.soundEnabled = v; void save(); }),
      volume,
    ),
    h("div", { class: "row" },
      h("label", { text: "Auto-close" }),
      autoClose,
      h("span", { class: "hint", text: "seconds after you leave the island" }),
    ),
    h("div", { class: "row" },
      h("label", { text: "Island lives on" }),
      screen,
    ),
    h("div", { class: "row" },
      h("label", { text: "Launch at startup" }),
      toggle(settings.autostart, (v) => { settings.autostart = v; void save(); }),
    ),
  );
}

// ── KAI's appearance ──────────────────────────────────────────────────────────
//
// The owner can change KAI's skin (body colour), colour treatment (theme) and
// outfit (accessory) — the parameters the character module actually exposes. The
// selection is stored in the webview's durable store (see character/variant.ts)
// and applied to the island's own renderer as it changes, so it survives a
// restart. A live preview of KAI is drawn here with the SAME KaiEngine the island
// uses, so what the owner picks is what KAI becomes — no second avatar system.

const DPR = Math.min(2, window.devicePixelRatio || 1);

function appearanceSection(): HTMLElement {
  let variant: KaiVariant = loadVariant();

  // ── Live preview: a real KaiEngine, the same class the island draws with ──
  const PW = 176;
  const PH = 196;
  const OVER = 30;
  const canvas = h("canvas", {
    width: String(Math.round(PW * DPR)),
    height: String(Math.round(PH * DPR)),
    style: `width:${PW}px;height:${PH}px;flex:0 0 auto;border-radius:14px;background:radial-gradient(circle at 50% 42%, rgba(255,255,255,0.05), rgba(0,0,0,0) 70%)`,
  }) as HTMLCanvasElement;
  const engine = new KaiEngine();
  engine.particleOverhang = OVER;
  const ctx = canvas.getContext("2d");

  const paint = () => {
    if (!ctx) return;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, PW, PH);
    engine.draw(ctx, PW, PH);
  };
  const settle = (frames = 50) => {
    for (let i = 0; i < frames; i++) engine.update(1 / 60);
    paint();
  };

  let last = performance.now();
  const frame = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    engine.update(dt);
    paint();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  // ── Controls ──
  const nameEl = h("span", { class: "hint" });
  const swatches = h("span", { style: "display:inline-flex;gap:4px;align-items:center" });

  const select = (values: readonly string[], value: string, onPick: (v: string) => void) => {
    const el = h("select", {}) as HTMLSelectElement;
    for (const v of values) el.append(h("option", { value: v, text: v }));
    el.value = value;
    el.addEventListener("change", () => onPick(el.value));
    return el;
  };

  const skinSel = select(SKINS, variant.skin, (v) => change(withSkin(variant, v as KaiVariant["skin"])));
  const themeSel = select(THEMES, variant.theme, (v) => change(withTheme(variant, v)));
  const accSel = select(ACCESSORIES, variant.accessory, (v) => change(withAccessory(variant, v as KaiVariant["accessory"])));
  // Stable hooks for the live-verification harness (it drives the REAL controls).
  skinSel.dataset.role = "appearance-skin";
  themeSel.dataset.role = "appearance-theme";
  accSel.dataset.role = "appearance-accessory";

  const presetRow = h("div", { class: "row" });
  const presetButtons = KAI_VARIANTS.map((preset) => {
    const btn = h("button", { text: preset.label, "data-preset": preset.id });
    btn.addEventListener("click", () => change(makeVariant({ ...preset })));
    presetRow.append(btn);
    return { preset, btn };
  });

  const themeHint = h("div", { class: "hint" });

  function sync() {
    skinSel.value = variant.skin;
    themeSel.value = variant.theme;
    accSel.value = variant.accessory;
    nameEl.textContent = describeVariant(variant);
    clear(swatches);
    swatches.append(
      h("i", { class: "dot", style: `background:${variant.primaryColor}` }),
      h("i", { class: "dot", style: `background:${variant.secondaryColor}` }),
    );
    for (const { preset, btn } of presetButtons) {
      const on = preset.skin === variant.skin && preset.theme === variant.theme && preset.accessory === variant.accessory;
      btn.className = on ? "primary" : "";
    }
    const result = applyVariant(engine, variant);
    engine.setState("idle", true);
    settle(50);
    themeHint.textContent = result.themeApplied
      ? "The colour treatment is applied to KAI."
      : "The colour treatment is recorded in KAI's identity; the renderer paints the body palette (skin) and outfit today.";
  }

  function change(next: KaiVariant) {
    variant = next;
    saveVariant(variant);
    sync();
    // Tell the island window without a restart: `save()` re-emits the app's
    // existing `settings-changed` event to every window.
    void save();
  }

  const preview = h("div", { style: "display:flex;gap:16px;align-items:flex-start" },
    canvas,
    h("div", { style: "display:flex;flex-direction:column;gap:10px;flex:1 1 auto;min-width:0" },
      h("div", { class: "row" }, h("label", { text: "Subagent preset" }), presetRow),
      h("div", { class: "row" }, h("label", { text: "Body colour (skin)" }), skinSel, swatches),
      h("div", { class: "row" }, h("label", { text: "Colour treatment" }), themeSel),
      h("div", { class: "row" }, h("label", { text: "Outfit" }), accSel),
      nameEl,
      themeHint,
    ),
  );

  sync();

  return h("section", {}, h("h2", {}, h("span", { text: "KAI's appearance" })), preview);
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function main() {
  const boot = await Bridge.boot();
  if (boot) {
    settings = { ...settings, ...boot.settings };
    version = boot.version;
  }

  const hasHermesKey = (await Bridge.secretPresent(HERMES_KEY)) ?? false;
  const hasAnthropicKey = (await Bridge.secretPresent(ANTHROPIC_KEY)) ?? false;

  const keys = [
    "stripe-api-key", "github-token", "vercel-token",
    "n8n-url", "n8n-api-key", "resend-api-key", "notion-api-key", "calcom-api-key",
  ];
  const present: Record<string, boolean> = {};
  for (const k of keys) present[k] = (await Bridge.secretPresent(k)) ?? false;

  clear(root);
  root.append(
    h("h1", {}, h("span", { text: "KAI" }), h("span", { class: "version", text: version })),
    appearanceSection(),
    kaiSection(hasHermesKey),
    directModelSection(hasAnthropicKey),
    integrationsSection(present),
    generalSection(),
    h("div", {
      class: "hint",
      text: "No telemetry. Network requests only go to the services you configure yourself.",
    }),
  );

  void onEvent<Settings>("settings-changed", (s) => {
    settings = { ...settings, ...s };
  });
}

void main();
