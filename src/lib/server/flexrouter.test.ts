import { afterEach, describe, expect, it, vi } from "vitest";
import { FlexrouterError, getJourney, getRoster, listModels, listRequests, streamChat } from "./flexrouter";

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

  it("sends the client tag and exclude list as flexrouter's headers", async () => {
    const fetchFn = mockFetch(sse("[DONE]"));
    await streamChat({ model: "auto", messages: [], client: "agora-r1", exclude: ["a/1", "b/2"] });
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Flexrouter-Client"]).toBe("agora-r1");
    expect(headers["X-Flexrouter-Exclude"]).toBe("a/1,b/2");
  });

  it("leaves the exclude header off when there is nothing to exclude", async () => {
    const fetchFn = mockFetch(sse("[DONE]"));
    await streamChat({ model: "auto", messages: [], exclude: [] });
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers).not.toHaveProperty("X-Flexrouter-Exclude");
  });

  it("reports the model answering as soon as the stream names it", async () => {
    const named = (content: string) => ({ ...delta(content), flexrouter: { model: "b/2" } });
    mockFetch(sse(named("Hi"), named("!"), "[DONE]"));
    const seen: string[] = [];
    const result = await streamChat({ model: "auto", messages: [], onModel: (m) => seen.push(m) });
    expect(seen).toEqual(["b/2"]);
    expect(result.answeredBy).toBe("b/2");
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

  it("keeps only the models in the bucket a run asks", async () => {
    mockFetch(JSON.stringify({ data: [{ id: "smart", flexrouter: { kind: "bucket", models: ["a/low"] } }, ...entries.data] }));
    expect((await listModels(undefined, "smart")).map((m) => m.id)).toEqual(["a/low"]);
  });

  it("follows auto to the bucket it stands for", async () => {
    mockFetch(
      JSON.stringify({
        data: [
          { id: "smart", flexrouter: { kind: "bucket", models: ["b/hi"] } },
          { id: "auto", flexrouter: { kind: "bucket", models: [], resolves_to: "smart" } },
          ...entries.data,
        ],
      })
    );
    expect((await listModels(undefined, "auto")).map((m) => m.id)).toEqual(["b/hi"]);
  });
});

describe("request log", () => {
  it("asks flexrouter for one client's requests", async () => {
    const fetchFn = mockFetch(JSON.stringify({ requests: [{ id: "req_1" }], total: 1 }));
    const page = await listRequests({ client: "agora-r1", result: "failover", q: "", limit: 50 });
    expect(page).toEqual({ requests: [{ id: "req_1" }], total: 1 });
    const [url] = fetchFn.mock.calls[0] as unknown as [string];
    const params = new URL(url).searchParams;
    expect(params.get("client")).toBe("agora-r1");
    expect(params.get("result")).toBe("failover");
    expect(params.get("limit")).toBe("50");
    expect(params.has("q")).toBe(false);
  });

  it("reads one request's journey, or null when flexrouter doesn't know it", async () => {
    mockFetch(JSON.stringify({ id: "req_1", steps: [{ kind: "gave_up" }] }));
    expect(await getJourney("req_1")).toMatchObject({ id: "req_1" });
    mockFetch(JSON.stringify({ error: "no request" }), { status: 404 });
    expect(await getJourney("req_2")).toBeNull();
  });
});
