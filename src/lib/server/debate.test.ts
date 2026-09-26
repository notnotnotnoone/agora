import { describe, expect, it } from "vitest";
import type { DebateEvent } from "../types";
import { runDebate } from "./debate";
import { FlexrouterError, type ChatFn } from "./flexrouter";

const pair = {
  persuader: { model: "a/1", choice: "YES", reasoning: "five > one" },
  persuadee: { model: "b/1", choice: "NO", reasoning: "don't kill" },
};

async function debate(chat: ChatFn) {
  const events: DebateEvent[] = [];
  await runDebate(
    { question: "Pull?", choices: ["YES", "NO"], pairs: [pair] },
    { chat, emit: (e) => events.push(e), signal: new AbortController().signal }
  );
  return events;
}

const reply = (text: string) => ({ text, requestId: "req_1", answeredBy: null, usage: { in: 1, out: 1 }, ms: 1 });

describe("runDebate", () => {
  it("records a flip when the persuadee changes its vote", async () => {
    const chat: ChatFn = async (req) =>
      req.model === "a/1" ? reply("Five lives outweigh one.") : reply("RESPONSE: You're right.\nANSWER: YES");
    const events = await debate(chat);
    expect(events.find((e) => e.type === "verdict")).toEqual({ type: "verdict", pair: 0, finalChoice: "YES", flipped: true });
    const turns = events.filter((e) => e.type === "turn_done");
    expect(turns.map((t) => t.type === "turn_done" && t.text)).toEqual(["Five lives outweigh one.", "You're right."]);
  });

  it("each side is played by the model that cast that vote", async () => {
    const asked: string[] = [];
    await debate(async (req) => {
      asked.push(req.model);
      return reply("RESPONSE: no\nANSWER: NO");
    });
    expect(asked).toEqual(["a/1", "b/1"]);
  });

  it("keeps the original vote when the reply can't be parsed or the model fails", async () => {
    const chat: ChatFn = async (req) => {
      if (req.model === "b/1") throw new FlexrouterError("down");
      return reply("argument");
    };
    const events = await debate(chat);
    expect(events.find((e) => e.type === "verdict")).toMatchObject({ finalChoice: "NO", flipped: false });
    expect(events.some((e) => e.type === "call" && e.call.outcome === "failed")).toBe(true);
  });
});
