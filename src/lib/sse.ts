// Server-Sent Events, both directions. Used for Agora's own streams and for
// reading flexrouter's OpenAI-style stream.

export function encodeEvent(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * Yields each `data:` payload of an SSE body as a string, in order.
 * Buffers across reads, so a line split between two network chunks is
 * reassembled rather than dropped. Stops at `[DONE]`.
 */
export async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split("\n");
      buffer = done ? "" : (lines.pop() ?? "");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") return;
        if (data) yield data;
      }
      if (done) return;
    }
  } finally {
    reader.releaseLock();
  }
}

/** readEvents, parsed as JSON; malformed payloads are skipped. */
export async function* readJsonEvents<T>(body: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  for await (const data of readEvents(body)) {
    try {
      yield JSON.parse(data) as T;
    } catch {
      // not JSON: ignore, as any SSE client would
    }
  }
}
