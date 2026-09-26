import { afterEach, describe, expect, it, vi } from "vitest";
import { callRecord, FlexrouterError, getRoster, listModels, streamChat } from "./flexrouter";

function sse(...payloads: unknown[]): string {
  return payloads.map((p) => `data: ${typeof p === "string" ? p : JSON.stringify(p)}\n\n`).join("");
}

function mockFetch(body: string, init: ResponseInit = {}) {
  const fn = vi.fn(async () => new Response(body, init));
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

const delta = (content: string) => ({ model: "a/1", choices: [{ delta: { content } }] });

describe("streamChat", () => {
  it("streams tokens and reads the request id and usage", async () => {
    mockFetch(
      sse(delta("Hel"), delta("lo"), { choices: [], usage: { prompt_tokens: 7, completion_tokens: 2 } }, "[DONE]"),
      { headers: { "x-flexrouter-request-id": "req_abc" } }
    );
    const tokens: string[] = [];
    const result = await streamChat({ model: "a/1", messages: [], onToken: (t) => tokens.push(t) });
    expect(tokens).toEqual(["Hel", "lo"]);
    expect(result).toMatchObject({ text: "Hello", requestId: "req_abc", answeredBy: "a/1", usage: { in: 7, out: 2 } });
  });

  it("throws with flexrouter's attempts when the stream carries an error", async () => {
    mockFetch(
      sse({
        error: {
          message: "a/1 is rate limited",
          flexrouter: {
            request_id: "req_err",
            attempts: [{ model: "a/1", status: 429, provider_message: "slow down", verdict: "rate_limited", ms: 12 }],
          },
        },
      })
    );
    const err = await streamChat({ model: "a/1", messages: [] }).catch((e) => e);
    expect(err).toBeInstanceOf(FlexrouterError);
    expect(err.message).toBe("a/1 is rate limited");
    expect(err.requestId).toBe("req_err");
    expect(err.attempts).toEqual([{ model: "a/1", status: 429, message: "slow down", verdict: "rate_limited", ms: 12 }]);
  });

  it("throws flexrouter's message on an HTTP error", async () => {
    mockFetch(JSON.stringify({ error: { message: "There is no bucket or model named 'x/y'." } }), {
      status: 404,
      headers: { "x-flexrouter-request-id": "req_404" },
    });
    await expect(streamChat({ model: "x/y", messages: [] })).rejects.toMatchObject({
      message: "There is no bucket or model named 'x/y'.",
      requestId: "req_404",
    });
  });

  it("explains an unreachable flexrouter", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    await expect(streamChat({ model: "a/1", messages: [] })).rejects.toThrow(/flexrouter serve/);
  });

  it("sends the model name and asks for a stream", async () => {
    const fetchFn = mockFetch(sse("[DONE]"));
    await streamChat({ model: "auto", messages: [] });
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({ model: "auto", stream: true });
  });
});

describe("roster", () => {
  const entries = {
    data: [
      { id: "free", flexrouter: { kind: "bucket" } },
      { id: "a/low", flexrouter: { kind: "model", provider: "a", model: "low", score: 10, status: { value: "ready" } } },
      { id: "b/hi", flexrouter: { kind: "model", provider: "b", model: "hi", score: 90, status: { value: "busy", until: 99 } } },
      { id: "c/key", flexrouter: { kind: "model", provider: "c", model: "key", score: 50, status: { value: "needs_you" } } },
    ],
  };

  it("lists models only, best score first, with status", async () => {
    mockFetch(JSON.stringify(entries));
    const roster = await getRoster();
    expect(roster.map((m) => [m.id, m.state])).toEqual([
      ["b/hi", "busy"],
      ["c/key", "needs_you"],
      ["a/low", "ready"],
    ]);
    expect(roster[0].until).toBe(99);
  });

  it("leaves out models that need a human", async () => {
    mockFetch(JSON.stringify(entries));
    expect((await listModels()).map((m) => m.id)).toEqual(["b/hi", "a/low"]);
  });
});

describe("callRecord", () => {
  it("turns a failure into a failed log row", () => {
    const row = callRecord("vote", "a/1", new FlexrouterError("down", "req_1", [], 40));
    expect(row).toMatchObject({ id: "req_1", phase: "vote", asked: "a/1", outcome: "failed", error: "down", ms: 40 });
  });

  it("gives a local id when flexrouter never answered", () => {
    expect(callRecord("extract", "auto", new FlexrouterError("unreachable")).id).toMatch(/^local_/);
  });
});
