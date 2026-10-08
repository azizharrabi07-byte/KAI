// A tiny DOM builder, owned by the shell.
//
// The shell deliberately does not import another stream's DOM helper: it is one
// surface with its own files, so a change elsewhere cannot break it. `element` is
// the whole API — create a tag, set attributes/props, append children.

type Child = Node | string | null | undefined;

export interface ElementAttrs {
  class?: string;
  text?: string;
  [key: string]: string | number | boolean | undefined;
}

export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: ElementAttrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key === "class") node.className = String(value);
    else if (key === "text") node.textContent = String(value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

export function clear(node: HTMLElement): void {
  node.replaceChildren();
}
