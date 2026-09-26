import { describe, expect, it } from "vitest";
import type { Model, RunEvent } from "../types";
import { FlexrouterError, type ChatFn, type ChatRequest } from "./flexrouter";
import { interleaveByProvider, runRound } from "./run";

const model = (id: string, score = 50): Model => ({
  id,
  provider: id.split("/")[0],
  name: id.split("/")[1],
  score,
  vision: false,
});

const VOTE_YES = "OPTION [YES]: saves five.\nOPTION [NO]: no direct harm.\nANSWER: YES";

type Reply = string | FlexrouterError;

/** A chat function answering by phase: extraction on the bucket, votes and the summary on pinned models. */
function fakeChat(votes: Record<string, Reply>, summary: Reply = "Most said YES."): { chat: ChatFn; asked: string[] } {
  const asked: string[] = [];
  const chat: ChatFn = async (req: ChatRequest) => {
    asked.push(req.model);
    const system = req.messages[0].content;
    let reply: Reply;
    if (system.includes("CHOICES:")) reply = "CHOICES: YES | NO";
    else if (system.includes("OPTION [")) reply = votes[req.model] ?? VOTE_YES;
    else reply = summary;
    if (reply instanceof FlexrouterError) throw reply;
    for (const token of reply.match(/.{1,5}/gs) ?? []) req.onToken?.(token);
    return { text: reply, requestId: `req_${asked.length}`, answeredBy: req.model, usage: { in: 10, out: 5 }, ms: 3 };
  };
  return { chat, asked };
}

async function run(models: Model[], votes: number, chat: ChatFn) {
  const events: RunEvent[] = [];
  await runRound(
    { question: "Pull the lever?", votes },
    { chat, models, bucket: "auto", emit: (e) => events.push(e), signal: new AbortController().signal }
  );
  return events;
}

const of = <T extends RunEvent["type"]>(events: RunEvent[], type: T) =>
  events.filter((e): e is Extract<RunEvent, { type: T }> => e.type === type);

describe("interleaveByProvider", () => {
  it("alternates providers, strongest provider first, best score first within each", () => {
    const order = interleaveByProvider([
      model("a/1", 10),
      model("a/2", 90),
      model("b/1", 50),
      model("c/1", 70),
      model("a/3", 40),
    ]).map((m) => m.id);
    expect(order).toEqual(["a/2", "c/1", "b/1", "a/3", "a/1"]);
  });
});

describe("runRound", () => {
  const models = ["a/1", "a/2", "b/1", "b/2", "c/1"].map((id) => model(id));

  it("extracts the choices through the bucket, then pins each vote to a model", async () => {
    const { chat, asked } = fakeChat({});
    const events = await run(models, 3, chat);
    expect(asked[0]).toBe("auto");
    expect(of(events, "choices")[0].choices).toEqual(["YES", "NO"]);
    expect(of(events, "vote_done")).toHaveLength(3);
  });

  it("never lets the same model vote twice", async () => {
    const { chat } = fakeChat({});
    const events = await run(models, 10, chat);
    const voters = of(events, "vote_start").map((e) => e.model);
    expect(new Set(voters).size).toBe(voters.length);
    expect(of(events, "vote_done")).toHaveLength(models.length);
  });

  it("moves a vote to an unused model when one fails, and records the skip", async () => {
    const busy = new FlexrouterError("rate limited", "req_x", [
      { model: "a/1", status: 429, message: "slow down", verdict: "rate_limited", ms: 5 },
    ]);
    const { chat } = fakeChat({ "a/1": busy, "b/1": "ANSWER: perhaps" });
    const events = await run(models, 3, chat);

    const skips = of(events, "vote_skip");
    expect(skips.map((s) => s.model).sort()).toEqual(["a/1", "b/1"]);
    expect(skips.find((s) => s.model === "a/1")?.reason).toBe("rate limited");
    expect(of(events, "vote_done")).toHaveLength(3);

    const failedCall = of(events, "call").find((e) => e.call.asked === "a/1")!.call;
    expect(failedCall).toMatchObject({ id: "req_x", outcome: "failed", phase: "vote" });
    expect(failedCall.attempts[0].status).toBe(429);
  });

  it("reports a vote that runs out of models", async () => {
    const down = new FlexrouterError("down");
    const { chat } = fakeChat(Object.fromEntries(models.map((m) => [m.id, down])));
    const events = await run(models, 2, chat);
    expect(of(events, "vote_failed")).toHaveLength(2);
    expect(of(events, "summary_start")).toHaveLength(0);
  });

  it("streams the summary from the first model that can write it", async () => {
    let summaryCalls = 0;
    const { chat: base } = fakeChat({});
    const chat: ChatFn = async (req) => {
      if (req.messages[0].content.includes("summarize") && summaryCalls++ === 0) throw new FlexrouterError("busy");
      return base(req);
    };
    const events = await run(models, 2, chat);
    expect(of(events, "summary_start")).toHaveLength(1);
    expect(of(events, "summary_token").map((e) => e.token).join("")).toBe("Most said YES.");
  });

  it("stops asking for votes once aborted", async () => {
    const ctrl = new AbortController();
    const { chat: base, asked } = fakeChat({});
    const chat: ChatFn = async (req) => {
      const res = await base(req);
      if (req.model !== "auto") ctrl.abort();
      return res;
    };
    await runRound(
      { question: "q", votes: 5 },
      { chat, models, bucket: "auto", emit: () => {}, signal: ctrl.signal }
    );
    // extraction + the votes already in flight when the first one finished
    expect(asked.length).toBeLessThanOrEqual(1 + 5);
    expect(asked.filter((m) => m !== "auto").length).toBeLessThan(models.length + 1);
  });

  it("fails the run when the options can't be extracted", async () => {
    const chat: ChatFn = async () => ({ text: "no idea", requestId: null, answeredBy: null, usage: { in: 0, out: 0 }, ms: 1 });
    await expect(run(models, 2, chat)).rejects.toThrow(/options/);
  });
});
