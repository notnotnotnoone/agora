import { describe, expect, it } from "vitest";
import { arenaReducer, initialState, providerShares, toSavedRun, type Action, type ArenaState } from "./arena";
import type { CallRecord, RunEvent } from "./types";

const run = (...events: RunEvent[]): Action[] => events.map((event) => ({ type: "run", event }));

function play(actions: Action[], from: ArenaState = initialState): ArenaState {
  return actions.reduce(arenaReducer, from);
}

const start: Action = { type: "start", runId: "r1", at: 1, question: "Pull?", votes: 2 };

const call = (answeredBy: string | null, tokens = 10): CallRecord => ({
  id: `req_${Math.random()}`,
  at: 0,
  phase: "vote",
  asked: answeredBy ?? "auto",
  answeredBy,
  outcome: "ok",
  attempts: [],
  usage: { in: tokens, out: 0 },
  ms: 1,
});

describe("arenaReducer", () => {
  it("walks a run from extraction to done", () => {
    const state = play([
      start,
      ...run(
        { type: "choices", choices: ["YES", "NO"] },
        { type: "vote_start", slot: 0, model: "a/1" },
        { type: "vote_token", slot: 0, token: "OPT" },
        { type: "vote_done", slot: 0, choice: "YES", reasons: { YES: "r" }, ms: 5, usage: { in: 1, out: 2 } },
        { type: "summary_start", model: "a/1" },
        { type: "summary_token", token: "Most " },
        { type: "summary_token", token: "agreed." },
        { type: "done" }
      ),
    ]);
    expect(state.phase).toBe("done");
    expect(state.votes[0]).toMatchObject({ model: "a/1", status: "done", choice: "YES", text: "OPT" });
    expect(state.summary).toEqual({ model: "a/1", text: "Most agreed." });
  });

  it("keeps a vote's failover chain as it moves between models", () => {
    const state = play([
      start,
      ...run(
        { type: "vote_start", slot: 0, model: "a/1" },
        { type: "vote_token", slot: 0, token: "half an answer" },
        { type: "vote_skip", slot: 0, model: "a/1", reason: "429" },
        { type: "vote_start", slot: 0, model: "b/1" }
      ),
    ]);
    expect(state.votes).toHaveLength(1);
    expect(state.votes[0]).toMatchObject({ model: "b/1", text: "", skipped: [{ model: "a/1", reason: "429" }] });
  });

  it("marks in-flight votes failed when stopped", () => {
    const state = play([start, ...run({ type: "vote_start", slot: 0, model: "a/1" }), { type: "stop" }]);
    expect(state.phase).toBe("stopped");
    expect(state.votes[0].status).toBe("failed");
  });

  it("an error stays an error when the stream then ends", () => {
    const state = play([start, ...run({ type: "error", message: "no models" }, { type: "done" })]);
    expect(state).toMatchObject({ phase: "error", error: "no models" });
  });

  it("only finished runs are saved, with their debate verdicts", () => {
    expect(toSavedRun(play([start]))).toBeNull();
    const pairs = [
      {
        persuader: { model: "a/1", choice: "YES", reasoning: "" },
        persuadee: { model: "b/1", choice: "NO", reasoning: "" },
      },
    ];
    const state = play([
      start,
      ...run({ type: "done" }),
      { type: "debate_start", pairs },
      { type: "debate", event: { type: "verdict", pair: 0, finalChoice: "YES", flipped: true } },
      { type: "debate", event: { type: "done" } },
    ]);
    const saved = toSavedRun(state)!;
    expect(saved.debate?.verdicts).toEqual([{ finalChoice: "YES", flipped: true }]);

    const loaded = play([{ type: "load", run: saved }]);
    expect(loaded).toMatchObject({ fromHistory: true, phase: "done", question: "Pull?" });
    expect(loaded.debate?.exchanges[0].verdict).toEqual({ finalChoice: "YES", flipped: true });
  });
});

describe("providerShares", () => {
  it("counts votes and tokens per provider", () => {
    const votes = [
      { slot: 0, model: "a/1", status: "done" as const, text: "", choice: "YES", reasons: {}, skipped: [] },
      { slot: 1, model: "a/2", status: "done" as const, text: "", choice: "NO", reasons: {}, skipped: [] },
      { slot: 2, model: "b/1", status: "failed" as const, text: "", choice: null, reasons: {}, skipped: [] },
    ];
    const shares = providerShares(votes, [call("a/1", 10), call("b/1", 30), call(null, 99)]);
    expect(shares).toEqual([
      { provider: "a", votes: 2, calls: 1, tokens: 10 },
      { provider: "b", votes: 0, calls: 1, tokens: 30 },
    ]);
  });
});
