import { describe, expect, it } from "vitest";
import type { DebateEvent, DebateMode } from "../types";
import { MAX_TURNS, runDebate } from "./debate";
import { FlexrouterError, type ChatFn, type ChatRequest } from "./flexrouter";

const pair = {
  persuader: { model: "a/1", choice: "YES", reasoning: "five > one" },
  persuadee: { model: "b/1", choice: "NO", reasoning: "don't kill" },
};

async function debate(chat: ChatFn, mode: DebateMode = "persuade") {
  const events: DebateEvent[] = [];
  await runDebate(
    { question: "Pull?", choices: ["YES", "NO"], pairs: [pair], mode, runId: "r1" },
    { chat, emit: (e) => events.push(e), signal: new AbortController().signal }
  );
  return events;
}

const reply = (text: string, n = 1) => ({ text, requestId: `req_${n}`, answeredBy: null, usage: { in: 1, out: 1 }, ms: 1 });

/** Each model answers from its own script, one line per turn it takes. */
function scripted(scripts: Record<string, string[]>) {
  const asked: ChatRequest[] = [];
  const chat: ChatFn = async (req) => {
    asked.push(req);
    const line = scripts[req.model].shift();
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

  it("stops the pair when a model fails, keeping both votes as they stood", async () => {
    const { chat, asked } = scripted({ "a/1": ["Pull it.\nVOTE: YES"], "b/1": [] });
    const events = await debate(chat);
    expect(asked).toHaveLength(2);
    expect(of(events, "turn_done")[1].text).toMatch(/failed/);
    expect(of(events, "verdict")[0]).toMatchObject({
      persuader: { finalChoice: "YES", flipped: false },
      persuadee: { finalChoice: "NO", flipped: false },
    });
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
