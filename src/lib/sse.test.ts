import { describe, expect, it } from "vitest";
import { encodeEvent, readEvents, readJsonEvents } from "./sse";

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const chunk of chunks) c.enqueue(enc.encode(chunk));
      c.close();
    },
  });
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of gen) out.push(x);
  return out;
}

describe("readEvents", () => {
  it("reassembles an event split across chunks", async () => {
    const events = await collect(readEvents(streamOf('data: {"a":', '1}\n\ndata: {"b":2}\n\n')));
    expect(events).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("stops at [DONE] and ignores other SSE fields", async () => {
    const events = await collect(readEvents(streamOf(": comment\nevent: x\ndata: 1\n\ndata: [DONE]\n\ndata: 2\n\n")));
    expect(events).toEqual(["1"]);
  });

  it("reads a final event with no trailing newline", async () => {
    expect(await collect(readEvents(streamOf("data: last")))).toEqual(["last"]);
  });
});

describe("readJsonEvents", () => {
  it("round-trips encodeEvent and skips malformed payloads", async () => {
    const body = streamOf(encodeEvent({ type: "a" }), "data: not json\n\n", encodeEvent({ type: "b" }));
    expect(await collect(readJsonEvents(body))).toEqual([{ type: "a" }, { type: "b" }]);
  });
});
