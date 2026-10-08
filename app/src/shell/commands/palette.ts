// The command palette — a real, keyboard-navigable surface over the registry.
//
// Ctrl/Cmd+K opens it; every result is executable; the list is grouped by
// category and filtered/ranked by the registry against the LIVE context, so an
// approval command appears only when an approval is real (owner §11, §12).
//
// Keyboard: ↑/↓ move (wraps), Home/End jump, Enter runs, Esc closes. Mouse hover
// moves the selection too, so both input styles agree. DOM-only; the ranking and
// the context filter live in the DOM-free `registry.ts`.

import { searchCommands, GROUP_LABELS, type CommandContext, type CommandDescriptor } from "./registry";

export interface PaletteHandle {
  readonly el: HTMLElement;
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
}

export interface PaletteOptions {
  /** Read the fresh context each time the list is painted. */
  context: () => CommandContext;
  /** Run a command by id — the host maps id → the real action. */
  run: (id: string) => void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | undefined> = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    node.setAttribute(k, v === true ? "" : v);
  }
  return node;
}

export function createPalette(options: PaletteOptions): PaletteHandle {
  const overlay = el("div", { class: "ov", id: "kp-ov" });
  const dialog = el("div", { class: "pal", role: "dialog", "aria-label": "Commands" });
  const input = el("input", {
    placeholder: "Type a command…",
    "aria-label": "Command",
    role: "combobox",
    "aria-expanded": "true",
    "aria-controls": "kp-pal-list",
    autocomplete: "off",
    spellcheck: "false",
  });
  const list = el("ul", { id: "kp-pal-list", role: "listbox" });
  dialog.append(input, list);
  overlay.append(dialog);

  let rows: { cmd: CommandDescriptor; button: HTMLElement }[] = [];
  let selected = 0;

  function paint(): void {
    const ctx = options.context();
    const results = searchCommands(ctx, input.value);
    list.replaceChildren();
    rows = [];
    let lastGroup: string | null = null;
    for (const cmd of results) {
      if (cmd.group !== lastGroup) {
        lastGroup = cmd.group;
        const head = el("li", { class: "pal-group", role: "presentation" });
        head.textContent = GROUP_LABELS[cmd.group];
        list.append(head);
      }
      const li = el("li", { role: "option", "aria-selected": "false" });
      const button = el("button", { type: "button", class: "pal-row" });
      const label = document.createElement("span");
      label.className = "pal-label";
      label.textContent = cmd.label;
      button.append(label);
      if (cmd.hint !== "") {
        const hint = document.createElement("small");
        hint.textContent = cmd.hint;
        button.append(hint);
      }
      button.addEventListener("mouseenter", () => select(rows.findIndex((r) => r.button === button), false));
      button.addEventListener("click", () => execute(cmd.id));
      li.append(button);
      list.append(li);
      rows.push({ cmd, button });
    }
    if (rows.length === 0) {
      const empty = el("li", { class: "pal-empty" });
      empty.textContent = input.value.trim() === "" ? "No commands available here." : "No command matches.";
      list.append(empty);
      return;
    }
    selected = Math.min(selected, rows.length - 1);
    select(selected, true);
  }

  function select(index: number, scroll: boolean): void {
    if (rows.length === 0) return;
    selected = ((index % rows.length) + rows.length) % rows.length;
    rows.forEach((r, i) => {
      const on = i === selected;
      r.button.classList.toggle("sel", on);
      r.button.setAttribute("aria-selected", on ? "true" : "false");
      if (on && scroll) r.button.scrollIntoView({ block: "nearest" });
    });
  }

  function execute(id: string): void {
    close();
    options.run(id);
  }

  function open(): void {
    input.value = "";
    selected = 0;
    overlay.classList.add("on");
    paint();
    input.focus();
  }

  function close(): void {
    overlay.classList.remove("on");
  }

  function isOpen(): boolean {
    return overlay.classList.contains("on");
  }

  input.addEventListener("input", () => {
    selected = 0;
    paint();
  });

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  input.addEventListener("keydown", (e) => {
    const ke = e as KeyboardEvent;
    switch (ke.key) {
      case "ArrowDown":
        ke.preventDefault();
        select(selected + 1, true);
        break;
      case "ArrowUp":
        ke.preventDefault();
        select(selected - 1, true);
        break;
      case "Home":
        ke.preventDefault();
        select(0, true);
        break;
      case "End":
        ke.preventDefault();
        select(rows.length - 1, true);
        break;
      case "Enter": {
        ke.preventDefault();
        const row = rows[selected];
        if (row !== undefined) execute(row.cmd.id);
        break;
      }
      case "Escape":
        ke.preventDefault();
        close();
        break;
      default:
        break;
    }
    // Never let a composer's own key handling steal the palette's keys.
    ke.stopPropagation();
  });

  return { el: overlay, open, close, toggle: () => (isOpen() ? close() : open()), isOpen };
}
