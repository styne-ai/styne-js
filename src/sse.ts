import { APIConnectionError } from "./errors";

export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

/** Parse a text/event-stream response body into events. */
export async function* parseSse(res: Response, signal?: AbortSignal): AsyncGenerator<SseEvent> {
  if (!res.body) return;
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<string>;
      try {
        chunk = await reader.read();
      } catch (err) {
        if (signal?.aborted) throw err;
        throw new APIConnectionError(`stream interrupted: ${String(err)}`, { cause: err });
      }
      if (chunk.done) break;
      buffer += chunk.value;
      // A "\r" at the end may be the first half of a "\r\n" split across chunks; keep it until the next one.
      const keep = buffer.endsWith("\r") ? 1 : 0;
      let text = buffer.slice(0, buffer.length - keep).replace(/\r\n?/g, "\n");
      buffer = buffer.slice(buffer.length - keep);
      let sep: number;
      while ((sep = text.indexOf("\n\n")) !== -1) {
        const event = frame(text.slice(0, sep));
        text = text.slice(sep + 2);
        if (event) yield event;
      }
      buffer = text + buffer;
    }
    const tail = frame(buffer.replace(/\r\n?/g, "\n"));
    if (tail) yield tail;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function frame(block: string): SseEvent | undefined {
  let event = "message";
  let id: string | undefined;
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    else if (field === "id") id = value;
  }
  if (!data.length && event === "message") return undefined;
  return id === undefined ? { event, data: data.join("\n") } : { event, data: data.join("\n"), id };
}
