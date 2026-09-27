import { describe, expect, it } from "vitest";
import type { Journey, Model, RunEvent } from "../types";
import { FlexrouterError, type ChatFn, type ChatRequest } from "./flexrouter";
import { runRound, type RunDeps } from "./run";

const model = (id: string, score = 50): Model => ({
  id,
  provider: id.split("/")[0],
  name: id.split("/")[1],
  score,
  vision: false,
});

const VOTE_YES = "OPTION [YES]: saves five.\nOPTION [NO]: no direct harm.\nANSWER: YES";

type Reply = string | FlexrouterError;

const tick = () => new Promise((r) => setTimeout(r, 1));

/**
 * A stand-in for flexrouter. A bucket call goes to the first bucket model not
 * excluded, like a router whose top pick is always the same model, so votes
 * running at once would all land on it unless each excludes the others.
 * `votes` maps a model to its reply; an error is flexrouter giving up before
 * any model answered. `routing` delays the moment a model is named, like
 * flexrouter waiting for one to cool down.
 */
function fakeFlexrouter(
  bucket: string[],
  votes: Record<string, Reply> = {},
  summary: Reply = "Most said YES.",
  routing: Record<string, number> = {}
) {
  const asked: ChatRequest[] = [];
  const stats = { aborted: 0, inFlight: 0, maxInFlight: 0 };
  let n = 0;
  const stopIfAborted = (req: ChatRequest) => {
    if (!req.signal?.aborted) return;
    stats.aborted++;
    throw new DOMException("aborted", "AbortError");
  };
  const chat: ChatFn = async (req) => {
    asked.push(req);
    const id = `req_${++n}`;
    stats.maxInFlight = Math.max(stats.maxInFlight, ++stats.inFlight);
    try {
      return await answer(req, id);
    } finally {
      stats.inFlight--;
    }
  };
  const answer = async (req: ChatRequest, id: string) => {
    await tick();
    const system = req.messages[0].content;
    let reply: Reply;
    let answering: string | undefined;
    if (system.includes("CHOICES:")) reply = "CHOICES: YES | NO";
    else if (system.includes("OPTION [")) {
      answering = bucket.find((m) => !req.exclude?.includes(m));
      if (!answering) throw new FlexrouterError("Every model in bucket auto is excluded by the request", id);
      reply = votes[answering] ?? VOTE_YES;
    } else reply = summary;
    answering ??= bucket[0];
    if (routing[answering]) await new Promise((r) => setTimeout(r, routing[answering]));
    if (reply instanceof FlexrouterError) throw new FlexrouterError(reply.message, id);
    req.onModel?.(answering);
    stopIfAborted(req);
    for (const token of reply.match(/.{1,5}/gs) ?? []) {
      await tick();
      stopIfAborted(req);
      req.onToken?.(token);
    }
    return { text: reply, requestId: id, answeredBy: answering, usage: { in: 10, out: 5 }, ms: 3 };
  };
  const journey = async (id: string): Promise<Journey> => ({
    id,
    at: "",
    bucket: "auto",
    client: "agora-r1",
    ok: true,
    outcome: "ok",
    tokens_in: 10,
    tokens_out: 5,
    ms_total: 3,
    steps: [],
  });
  return { chat, journey, asked, stats };
}

async function run(
  fake: Pick<ReturnType<typeof fakeFlexrouter>, "chat" | "journey">,
  models: Model[],
  votes: number,
  signal?: AbortSignal,
  waitForModelMs?: number
) {
  const events: RunEvent[] = [];
  const deps: RunDeps = {
    chat: fake.chat,
    journey: fake.journey,
    models,
    bucket: "auto",
    emit: (e) => events.push(e),
    signal: signal ?? new AbortController().signal,
    waitForModelMs,
  };
  await runRound({ question: "Pull the lever?", votes, runId: "r1" }, deps);
  return events;
}

const of = <T extends RunEvent["type"]>(events: RunEvent[], type: T) =>
  events.filter((e): e is Extract<RunEvent, { type: T }> => e.type === type);

const ids = ["a/1", "a/2", "b/1", "b/2", "c/1"];
const models = ids.map((id) => model(id));

describe("runRound", () => {
  it("asks the bucket for everything, tagged with the run", async () => {
    const fake = fakeFlexrouter(ids);
    const events = await run(fake, models, 3);
    expect(fake.asked.map((r) => r.model)).toEqual(["auto", "auto", "auto", "auto", "auto"]);
    expect(fake.asked.every((r) => r.client === "agora-r1")).toBe(true);
    expect(of(events, "choices")[0].choices).toEqual(["YES", "NO"]);
    expect(of(events, "vote_done")).toHaveLength(3);
  });

  it("never lets the same model vote twice, though votes run at once", async () => {
    const fake = fakeFlexrouter(ids);
    const events = await run(fake, models, 5);
    const voters = of(events, "vote_model").map((e) => e.model);
    expect(voters.sort()).toEqual([...ids].sort());
    expect(of(events, "vote_done")).toHaveLength(5);
  });

  it("each vote excludes every model already voting or voted", async () => {
    const fake = fakeFlexrouter(ids);
    await run(fake, models, 3);
    const votes = fake.asked.filter((r) => r.messages[0].content.includes("OPTION ["));
    expect(votes.map((r) => r.exclude)).toEqual([[], ["a/1"], ["a/1", "a/2"]]);
  });

  it("doesn't hold up the other votes while one waits for a model", async () => {
    const busy = new FlexrouterError("Tried every model in bucket 'auto' for about 30s without success");
    const fake = fakeFlexrouter(ids, { "a/1": busy }, "", { "a/1": 60 });
    await run(fake, models, 3, undefined, 5);
    expect(fake.stats.maxInFlight).toBeGreaterThan(1);
  });

  it("stops a vote that lands on a model already answering another, and asks again", async () => {
    const fake = fakeFlexrouter(ids, {}, "Most said YES.", { "a/1": 30 });
    const events = await run(fake, models, 2, undefined, 5);
    expect(fake.stats.aborted).toBe(1);
    expect(of(events, "vote_model").map((e) => e.model)).toEqual(["a/1", "a/2"]);
    expect(of(events, "vote_done")).toHaveLength(2);
    expect(of(events, "vote_retry")).toHaveLength(0);
  });

  it("asks again when a model answers off-format, and that model doesn't get another turn", async () => {
    const fake = fakeFlexrouter(ids, { "a/1": "ANSWER: perhaps" });
    const events = await run(fake, models, 2);

    const [retry] = of(events, "vote_retry");
    expect(retry.retry).toMatchObject({ model: "a/1", reason: "Answer wasn't one of the options" });
    expect(retry.retry.journey?.id).toBe(retry.retry.requestId);
    expect(of(events, "vote_model").map((e) => e.model)).toEqual(["a/1", "a/2", "b/1"]);
    expect(of(events, "vote_done")).toHaveLength(2);
  });

  it("fails a vote flexrouter couldn't answer, with its journey", async () => {
    const fake = fakeFlexrouter(ids, { "a/1": new FlexrouterError("Every model in auto is busy") });
    const events = await run(fake, models, 1);
    const [failed] = of(events, "vote_failed");
    expect(failed).toMatchObject({ slot: 0, reason: "Every model in auto is busy" });
    expect(failed.journey?.id).toBe(failed.requestId);
    expect(of(events, "summary_start")).toHaveLength(0);
  });

  it("says so when every model in the bucket has voted", async () => {
    const fake = fakeFlexrouter(["a/1", "a/2"]);
    const events = await run(fake, models, 3);
    expect(of(events, "vote_done")).toHaveLength(2);
    expect(of(events, "vote_failed")[0].reason).toMatch(/every model .* has voted/i);
  });

  it("streams the summary from whichever model flexrouter picks", async () => {
    const fake = fakeFlexrouter(ids);
    const events = await run(fake, models, 2);
    expect(of(events, "summary_start")).toEqual([{ type: "summary_start", model: "a/1" }]);
    expect(of(events, "summary_token").map((e) => e.token).join("")).toBe("Most said YES.");
  });

  it("labels every request with the phase that sent it", async () => {
    const fake = fakeFlexrouter(ids);
    const events = await run(fake, models, 2);
    expect(of(events, "request").map((e) => e.phase)).toEqual(["extract", "vote", "vote", "summary"]);
  });

  it("stops asking for votes once aborted", async () => {
    const ctrl = new AbortController();
    const fake = fakeFlexrouter(ids);
    // Stop as soon as the first vote has a model.
    const chat: ChatFn = (req) =>
      fake.chat({
        ...req,
        onModel: (m) => {
          req.onModel?.(m);
          if (req.messages[0].content.includes("OPTION [")) ctrl.abort();
        },
      });
    const events = await run({ ...fake, chat }, models, 5, ctrl.signal);
    const votes = fake.asked.filter((r) => r.messages[0].content.includes("OPTION ["));
    expect(votes).toHaveLength(1);
    expect(of(events, "summary_start")).toHaveLength(0);
  });

  it("fails the run when the options can't be extracted", async () => {
    const fake = fakeFlexrouter(ids);
    const chat: ChatFn = async () => ({ text: "no idea", requestId: null, answeredBy: null, usage: { in: 0, out: 0 }, ms: 1 });
    await expect(run({ ...fake, chat }, models, 2)).rejects.toThrow(/options/);
  });
});
