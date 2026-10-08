// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Minimal Server-Sent Events parser over a WHATWG ReadableStream.
 * Verified against the live OpenCode `GET /event` stream, which emits blocks of
 * the shape:  `data: {"id":"evt_...","type":"server.connected","properties":{}}\n\n`
 */

export interface SseEvent {
  event: string | undefined;
  data: string;
  id: string | undefined;
}

function parseBlock(block: string): SseEvent | undefined {
  const lines = block.split("\n");
  let event: string | undefined;
  let id: string | undefined;
  const data: string[] = [];
  for (const line of lines) {
    if (line.length === 0 || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "event") event = value;
    else if (field === "id") id = value;
  }
  if (data.length === 0 && event === undefined) return undefined;
  return { event, data: data.join("\n"), id };
}

/** Yield one SseEvent per `\n\n`-delimited block arriving on `body`. */
export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      let index = buffer.indexOf("\n\n");
      while (index !== -1) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const parsed = parseBlock(block);
        if (parsed) yield parsed;
        index = buffer.indexOf("\n\n");
      }
    }
    const tail = parseBlock(buffer);
    if (tail) yield tail;
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* the stream is already gone; nothing to release */
    }
  }
}
