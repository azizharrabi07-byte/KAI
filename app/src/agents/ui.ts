/**
 * agents/ui.ts — the agent surface's own tiny DOM builder.
 *
 * Deliberately not another stream's helper: the agents page is one surface with
 * its own files, so a change in the shell or the island cannot break it. `el` is
 * the whole API — create a tag, set attributes/props, append children.
 */

type Child = Node | string | null | undefined | false;

export interface ElAttrs {
  class?: string;
  text?: string;
  style?: string;
  title?: string;
  [key: string]: string | number | boolean | EventListener | undefined;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: ElAttrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false || value === null) continue;
    if (key === "class") node.className = String(value);
    else if (key === "text") node.textContent = String(value);
    else if (key === "style") node.setAttribute("style", String(value === true ? "" : value));
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

export function clear(node: Element): void {
  node.replaceChildren();
}

/** A coloured identity dot, matching the island's `.dot`. */
export function dot(color: string, size = 8): HTMLElement {
  return el("i", {
    class: "dot",
    style: `display:inline-block;width:${size}px;height:${size}px;border-radius:50%;background:${color};flex:0 0 auto`,
  });
}

export function chip(text: string, color: string): HTMLElement {
  return el("span", {
    style:
      `flex:0 0 auto;font:600 10px var(--font,system-ui);color:${color};` +
      `border:1px solid ${color}55;background:${color}1f;border-radius:999px;padding:2px 8px`,
    text,
  });
}

export function button(label: string, kind: "primary" | "secondary" | "danger" | "ghost", onClick: () => void): HTMLButtonElement {
  const bg =
    kind === "primary" ? "rgba(99,102,241,0.92)"
      : kind === "danger" ? "rgba(244,80,94,0.16)"
        : kind === "ghost" ? "transparent"
          : "rgba(255,255,255,0.06)";
  const color = kind === "danger" ? "#f4505e" : kind === "ghost" ? "#9aa0aa" : "#f5f6f8";
  const border = kind === "ghost" ? "none" : kind === "primary" ? "none" : "1px solid rgba(255,255,255,0.12)";
  return el("button", {
    type: "button",
    text: label,
    style:
      `font:500 12px var(--font,system-ui);padding:6px 11px;border-radius:8px;cursor:pointer;` +
      `background:${bg};color:${color};border:${border}`,
    onclick: onClick,
  });
}

/** A titled block — the page's section primitive. */
export function section(title: string, ...children: Child[]): HTMLElement {
  return el(
    "section",
    { class: "kai-agents-section", style: "display:flex;flex-direction:column;gap:8px;min-width:0" },
    el("h3", {
      text: title,
      style:
        "margin:0;font:600 10.5px var(--font,system-ui);letter-spacing:.08em;text-transform:uppercase;color:#7b8290",
    }),
    ...children,
  );
}

export function fieldRow(label: string, value: HTMLElement | string): HTMLElement {
  return el(
    "div",
    { class: "kai-agents-field", style: "display:flex;gap:10px;min-width:0;align-items:baseline" },
    el("span", { text: label, style: "flex:0 0 108px;font:400 11px var(--font,system-ui);color:#6b7280" }),
    typeof value === "string"
      ? el("span", { text: value, style: "font:400 12px var(--font,system-ui);color:var(--ink,#f5f6f8);min-width:0;overflow-wrap:anywhere" })
      : value,
  );
}

export function spacer(): HTMLElement {
  return el("div", { style: "flex:1 1 auto" });
}

export function muted(text: string): HTMLElement {
  return el("span", { text, style: "font:400 10.5px var(--font,system-ui);color:#6b7280" });
}

/** A styled text input. */
export function input(placeholder: string): HTMLInputElement {
  return el("input", {
    type: "text",
    placeholder,
    spellcheck: "false",
    style:
      "flex:1 1 auto;min-width:0;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.14);" +
      "border-radius:8px;color:inherit;font:400 12.5px var(--font,system-ui);padding:7px 10px",
  }) as HTMLInputElement;
}

export function textarea(placeholder: string, rows = 4): HTMLTextAreaElement {
  return el("textarea", {
    placeholder,
    rows: String(rows),
    spellcheck: "false",
    style:
      "flex:1 1 auto;min-width:0;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.14);" +
      "border-radius:8px;color:inherit;font:400 12.5px var(--font,system-ui);padding:8px 10px;resize:vertical",
  }) as HTMLTextAreaElement;
}

export function select(options: { value: string; label: string }[], value?: string): HTMLSelectElement {
  const node = el("select", {
    style:
      "flex:1 1 auto;min-width:0;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.14);" +
      "border-radius:8px;color:inherit;font:400 12.5px var(--font,system-ui);padding:7px 10px",
  }) as HTMLSelectElement;
  for (const opt of options) {
    node.append(el("option", { value: opt.value, text: opt.label, ...(value === opt.value ? { selected: true } : {}) }));
  }
  return node;
}
