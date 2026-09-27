import { describe, expect, it } from "vitest";
import { isRequestId, isRunId, parseDebateBody, parseRunBody } from "./validate";

describe("parseRunBody", () => {
  it("accepts a question and a vote count", () => {
    expect(parseRunBody({ question: "  Pull?  ", votes: 5, runId: "mf3k2-abc" })).toEqual({
      ok: true,
      value: { question: "Pull?", votes: 5, runId: "mf3k2-abc" },
    });
  });

  it.each([
    [null],
    [{ question: "", votes: 5, runId: "r1" }],
    [{ question: "x".repeat(4001), votes: 5, runId: "r1" }],
    [{ question: "Pull?", votes: 0, runId: "r1" }],
    [{ question: "Pull?", votes: 2.5, runId: "r1" }],
    [{ question: "Pull?", votes: 1000, runId: "r1" }],
    [{ question: "Pull?", votes: "5", runId: "r1" }],
    [{ question: "Pull?", votes: 5 }],
    [{ question: "Pull?", votes: 5, runId: "has space" }],
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
    mode: "symmetric",
    runId: "r1",
  };

  it("accepts well-formed pairs", () => {
    expect(parseDebateBody(good)).toMatchObject({ ok: true, value: { mode: "symmetric", runId: "r1" } });
  });

  it("defaults to persuade mode, and rejects any other", () => {
    expect(parseDebateBody({ ...good, mode: undefined })).toMatchObject({ value: { mode: "persuade" } });
    expect(parseDebateBody({ ...good, mode: "shouting" }).ok).toBe(false);
  });

  it("needs the run it belongs to", () => {
    expect(parseDebateBody({ ...good, runId: undefined }).ok).toBe(false);
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

describe("ids", () => {
  it("run ids are short and safe inside a client tag", () => {
    expect(isRunId("mf3k2x1-9zq8a7b6")).toBe(true);
    expect(isRunId("")).toBe(false);
    expect(isRunId("a".repeat(50))).toBe(false);
    expect(isRunId("../x")).toBe(false);
  });

  it("request ids look like flexrouter's", () => {
    expect(isRequestId("req_0123456789abcdef01234567")).toBe(true);
    expect(isRequestId("req_1/../../api")).toBe(false);
  });
});
