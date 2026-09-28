import { describe, expect, it } from "vitest";
import type { DebateEvent, DebateMode } from "../types";
import { MAX_TURNS, runDebate, type DebateDeps } from "./debate";
import { FlexrouterError, type ChatFn, type ChatRequest } from "./flexrouter";

const pair = {
  persuader: { model: "a/1", choice: "YES", reasoning: "five > one" },
  persuadee: { model: "b/1", choice: "NO", reasoning: "don't kill" },
};

async function debate(chat: ChatFn, mode: DebateMode = "persuade", extra: Partial<DebateDeps> = {}) {
  const events: DebateEvent[] = [];
  await runDebate(
    { question: "Pull?", choices: ["YES", "NO"], pairs: [pair], mode, runId: "r1" },
    { chat, bucket: "all", emit: (e) => events.push(e), signal: new AbortController().signal, ...extra }
  );
  return events;
}

const reply = (text: string, n = 1) => ({ text, reasoning: "", requestId: `req_${n}`, answeredBy: null, usage: { in: 1, out: 1 }, ms: 1 });

/** Each model answers from its own script, one line per turn it takes. */
function scripted(scripts: Record<string, string[]>) {
  const asked: ChatRequest[] = [];
  const chat: ChatFn = async (req) => {
    asked.push(req);
    const line = scripts[req.model]?.shift();
    if (line === undefined) throw new FlexrouterError("out of script");
    return reply(line, asked.length);
  };
  return { chat, asked };
}

const of = <T extends DebateEvent["type"]>(events: DebateEvent[], type: T) =>
  events.filter((e): e is Extract<DebateEvent, { type: T }> => e.type === type);

describe("runDebate", () => {
  it("alternates the two sides, each played by the model that cast that vote", async () => {
    const { chat, asked } = scripted({
      "a/1": ["Pull it.\nVOTE: YES", "Still pull.\nVOTE: YES", "Last word.\nVOTE: YES"],
      "b/1": ["No.\nVOTE: NO", "Still no.\nVOTE: NO"],
    });
    const events = await debate(chat);
    expect(asked.map((r) => r.model)).toEqual(["a/1", "b/1", "a/1", "b/1", "a/1"]);
    expect(asked).toHaveLength(MAX_TURNS);
    expect(asked.every((r) => r.client === "agora-r1")).toBe(true);
    expect(of(events, "turn_done").map((e) => e.text)).toEqual([
      "Pull it.",
      "No.",
      "Still pull.",
      "Still no.",
      "Last word.",
    ]);
    expect(of(events, "verdict")[0]).toEqual({
      type: "verdict",
      pair: 0,
      persuader: { finalChoice: "YES", flipped: false },
      persuadee: { finalChoice: "NO", flipped: false },
    });
  });

  it("ends early once both sides hold the same vote", async () => {
    const { chat, asked } = scripted({
      "a/1": ["Pull it.\nVOTE: YES"],
      "b/1": ["You're right.\nVOTE: YES"],
    });
    const events = await debate(chat);
    expect(asked).toHaveLength(2);
    expect(of(events, "verdict")[0]).toMatchObject({
      persuader: { finalChoice: "YES", flipped: false },
      persuadee: { finalChoice: "YES", flipped: true },
    });
  });

  it("lets the persuader be the one who flips", async () => {
    const { chat } = scripted({
      "a/1": ["Pull it.\nVOTE: YES", "Fair, I switch.\nVOTE: NO"],
      "b/1": ["Killing is killing.\nVOTE: NO"],
    });
    const events = await debate(chat, "symmetric");
    expect(of(events, "verdict")[0]).toMatchObject({ persuader: { finalChoice: "NO", flipped: true } });
    expect(of(events, "turn_done").map((e) => e.vote)).toEqual(["YES", "NO", "NO"]);
  });

  it("hands a failed turn to a stand-in from the bucket, never either debater", async () => {
    const { chat, asked } = scripted({
      "a/1": ["Pull it.\nVOTE: YES", "Pull.\nVOTE: YES", "Pull!\nVOTE: YES"],
      "b/1": [],
      all: ["Standing in: no.\nVOTE: NO", "Still no.\nVOTE: NO"],
    });
    const events = await debate(chat);
    expect(asked.slice(0, 3).map((r) => r.model)).toEqual(["a/1", "b/1", "all"]);
    expect(asked[2].exclude).toEqual(["a/1", "b/1"]);
    // b/1 has no script at all, so both of its turns go to a stand-in.
    expect(of(events, "turn_standin").map((e) => e.turn)).toEqual([1, 3]);
    expect(of(events, "turn_done")[1].text).toBe("Standing in: no.");
    expect(of(events, "pair_skipped")).toHaveLength(0);
  });

  it("skips the pair when no stand-in answers either, keeping both votes as they stood", async () => {
    const { chat, asked } = scripted({ "a/1": ["Pull it.\nVOTE: YES"], "b/1": [], all: [] });
    const events = await debate(chat);
    // The debater's own model, then two stand-ins.
    expect(asked.map((r) => r.model)).toEqual(["a/1", "b/1", "all", "all"]);
    expect(of(events, "turn_done")[1].text).toMatch(/in time/);
    expect(of(events, "pair_skipped")[0].reason).toMatch(/in time/);
    expect(of(events, "verdict")[0]).toMatchObject({
      persuader: { finalChoice: "YES", flipped: false },
      persuadee: { finalChoice: "NO", flipped: false },
    });
  });

  it("gives a stalled model's turn to a stand-in instead of hanging", async () => {
    const asked: ChatRequest[] = [];
    const chat: ChatFn = async (req) => {
      asked.push(req);
      if (req.model === "b/1") {
        req.onModel?.("b/1");
        // Accepts the request, then never says a word.
        await new Promise((_, reject) => req.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
      }
      const text = req.model === "a/1" ? "Pull it.\nVOTE: YES" : "Fine, yes.\nVOTE: YES";
      req.onToken?.(text);
      return reply(text, asked.length);
    };
    const events = await debate(chat, "persuade", { liveness: { routeMs: 50, firstTokenMs: 20, idleMs: 20 } });
    expect(asked.map((r) => r.model)).toEqual(["a/1", "b/1", "all"]);
    expect(of(events, "verdict")[0]).toMatchObject({ persuadee: { finalChoice: "YES", flipped: true } });
  });

  it("ends a pair the viewer skips, mid-turn or before it starts", async () => {
    const skip = new AbortController();
    const chat: ChatFn = async () => {
      skip.abort();
      throw new DOMException("aborted", "AbortError");
    };
    const events = await debate(chat, "persuade", { skipSignal: () => skip.signal });
    expect(of(events, "pair_skipped")).toEqual([{ type: "pair_skipped", pair: 0, reason: "Skipped" }]);
    expect(of(events, "verdict")).toHaveLength(1);

    const before = await debate(chat, "persuade", { skipSignal: () => skip.signal });
    expect(of(before, "turn_start")).toHaveLength(0);
    expect(of(before, "pair_skipped")).toHaveLength(1);
  });

  it("labels each turn's request as debate for the log", async () => {
    const { chat } = scripted({ "a/1": ["Pull.\nVOTE: YES"], "b/1": ["Ok.\nVOTE: YES"] });
    const events = await debate(chat);
    expect(of(events, "request")).toEqual([
      { type: "request", id: "req_1", phase: "debate" },
      { type: "request", id: "req_2", phase: "debate" },
    ]);
  });
});
