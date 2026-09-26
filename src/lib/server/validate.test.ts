import { describe, expect, it } from "vitest";
import { parseDebateBody, parseRunBody } from "./validate";

describe("parseRunBody", () => {
  it("accepts a question and a vote count", () => {
    expect(parseRunBody({ question: "  Pull?  ", votes: 5 })).toEqual({ ok: true, value: { question: "Pull?", votes: 5 } });
  });

  it.each([
    [null],
    [{ question: "", votes: 5 }],
    [{ question: "x".repeat(4001), votes: 5 }],
    [{ question: "Pull?", votes: 0 }],
    [{ question: "Pull?", votes: 2.5 }],
    [{ question: "Pull?", votes: 1000 }],
    [{ question: "Pull?", votes: "5" }],
  ])("rejects %j", (body) => {
    expect(parseRunBody(body).ok).toBe(false);
  });
});

describe("parseDebateBody", () => {
  const side = (model: string, choice: string) => ({ model, choice, reasoning: "r" });
  const good = {
    question: "Pull?",
    choices: ["YES", "NO"],
    pairs: [{ persuader: side("a/1", "YES"), persuadee: side("b/1", "NO") }],
  };

  it("accepts well-formed pairs", () => {
    expect(parseDebateBody(good).ok).toBe(true);
  });

  it("rejects a choice that isn't one of the options", () => {
    expect(parseDebateBody({ ...good, pairs: [{ persuader: side("a/1", "MAYBE"), persuadee: side("b/1", "NO") }] }).ok).toBe(false);
  });

  it("rejects a bucket name where a pinned model is required", () => {
    expect(parseDebateBody({ ...good, pairs: [{ persuader: side("auto", "YES"), persuadee: side("b/1", "NO") }] }).ok).toBe(false);
  });

  it("rejects missing pairs", () => {
    expect(parseDebateBody({ ...good, pairs: [] }).ok).toBe(false);
  });
});
