import { describe, expect, it } from "vitest";
import { arenaReducer, initialState, providerShares, toSavedRun, voteChain, type Action, type ArenaState } from "./arena";
import type { DebateEvent, Journey, JourneyStep, RequestRow, RunEvent, Vote } from "./types";

const run = (...events: RunEvent[]): Action[] => events.map((event) => ({ type: "run", event }));
const debate = (...events: DebateEvent[]): Action[] => events.map((event) => ({ type: "debate", event }));

function play(actions: Action[], from: ArenaState = initialState): ArenaState {
  return actions.reduce(arenaReducer, from);
}

const start: Action = { type: "start", runId: "r1", at: 1, question: "Pull?", votes: 2 };

const journey = (id: string, ...steps: JourneyStep[]): Journey => ({
  id,
  at: "",
  bucket: "auto",
  client: "agora-r1",
  ok: true,
  outcome: steps.some((s) => s.kind === "failed") ? "failover" : "ok",
  tokens_in: 1,
  tokens_out: 1,
  ms_total: 1,
  steps,
});

const failed = (id: string, message = "429"): JourneyStep => {
  const [provider, model] = id.split("/");
  return { kind: "failed", provider, model, status: 429, message, verdict: "rate_limited", ms: 5 };
};

const row = (provider: string | null, tokens = 10): RequestRow => ({
  id: `req_${Math.random()}`,
  at: "",
  bucket: "auto",
  ok: provider !== null,
  answered_by: provider ? { provider, model: "m" } : null,
  tokens_in: tokens,
  tokens_out: 0,
  ms_total: 1,
  skipped_count: 0,
  outcome: provider ? "ok" : "failed",
  attempt_count: 0,
  client: "agora-r1",
});

describe("arenaReducer", () => {
  it("walks a run from extraction to done", () => {
    const state = play([
      start,
      ...run(
        { type: "request", id: "req_x", phase: "extract" },
        { type: "choices", choices: ["YES", "NO"] },
        { type: "vote_start", slot: 0 },
        { type: "vote_model", slot: 0, model: "a/1" },
        { type: "vote_token", slot: 0, token: "OPT" },
        {
          type: "vote_done",
          slot: 0,
          choice: "YES",
          reasons: { YES: "r" },
          ms: 5,
          usage: { in: 1, out: 2 },
          requestId: "req_1",
          journey: journey("req_1"),
        },
        { type: "summary_start", model: "b/1" },
        { type: "summary_token", token: "Most " },
        { type: "summary_token", token: "agreed." },
        { type: "done" }
      ),
    ]);
    expect(state.phase).toBe("done");
    expect(state.votes[0]).toMatchObject({ model: "a/1", status: "done", choice: "YES", text: "OPT", requestId: "req_1" });
    expect(state.summary).toEqual({ model: "b/1", text: "Most agreed." });
    expect(state.phases).toEqual({ req_x: "extract" });
  });

  it("a vote that's asked again starts over, keeping what happened before", () => {
    const retry = { requestId: "req_1", model: "a/1", reason: "off-format", journey: null };
    const state = play([
      start,
      ...run(
        { type: "vote_start", slot: 0 },
        { type: "vote_model", slot: 0, model: "a/1" },
        { type: "vote_token", slot: 0, token: "half an answer" },
        { type: "vote_retry", slot: 0, retry }
      ),
    ]);
    expect(state.votes).toHaveLength(1);
    expect(state.votes[0]).toMatchObject({ model: null, text: "", status: "streaming", retries: [retry] });
  });

  it("marks in-flight votes failed when stopped", () => {
    const state = play([start, ...run({ type: "vote_start", slot: 0 }), { type: "stop" }]);
    expect(state.phase).toBe("stopped");
    expect(state.votes[0].status).toBe("failed");
  });

  it("an error stays an error when the stream then ends", () => {
    const state = play([start, ...run({ type: "error", message: "no models" }, { type: "done" })]);
    expect(state).toMatchObject({ phase: "error", error: "no models" });
  });

  it("builds a debate turn by turn", () => {
    const pairs = [
      {
        persuader: { model: "a/1", choice: "YES", reasoning: "" },
        persuadee: { model: "b/1", choice: "NO", reasoning: "" },
      },
    ];
    const state = play([
      start,
      ...run({ type: "done" }),
      { type: "debate_start", pairs, mode: "symmetric" },
      ...debate(
        { type: "pair_start", pair: 0 },
        { type: "turn_start", pair: 0, turn: 0, speaker: "persuader" },
        { type: "turn_token", pair: 0, turn: 0, token: "Pull" },
        { type: "turn_done", pair: 0, turn: 0, text: "Pull it.", vote: "YES", requestId: "req_9" },
        { type: "turn_start", pair: 0, turn: 1, speaker: "persuadee" },
        { type: "turn_token", pair: 0, turn: 1, token: "Fine" }
      ),
    ]);
    expect(state.debate?.mode).toBe("symmetric");
    expect(state.debate?.exchanges[0].turns).toEqual([
      { speaker: "persuader", text: "Pull it.", vote: "YES", done: true },
      { speaker: "persuadee", text: "Fine", vote: null, done: false },
    ]);
  });

  it("restarts a turn for a stand-in, names it, and marks skipped pairs", () => {
    const pairs = [
      {
        persuader: { model: "a/1", choice: "YES", reasoning: "" },
        persuadee: { model: "b/1", choice: "NO", reasoning: "" },
      },
    ];
    const state = play([
      start,
      ...run({ type: "done" }),
      { type: "debate_start", pairs, mode: "persuade" },
      ...debate(
        { type: "pair_start", pair: 0 },
        { type: "turn_start", pair: 0, turn: 0, speaker: "persuader" },
        { type: "turn_token", pair: 0, turn: 0, token: "half an arg" },
        { type: "turn_standin", pair: 0, turn: 0, model: null },
        { type: "turn_standin", pair: 0, turn: 0, model: "c/1" },
        { type: "turn_token", pair: 0, turn: 0, token: "Pull" },
        { type: "pair_skipped", pair: 0, reason: "Skipped" }
      ),
    ]);
    const exchange = state.debate!.exchanges[0];
    expect(exchange.turns[0]).toMatchObject({ text: "Pull", standIn: "c/1" });
    expect(exchange.skipped).toBe("Skipped");
  });

  it("keeps a vote's reasoning trace", () => {
    const state = play([
      start,
      ...run(
        { type: "choices", choices: ["YES", "NO"] },
        { type: "vote_start", slot: 0 },
        {
          type: "vote_done",
          slot: 0,
          choice: "YES",
          reasons: {},
          ms: 1,
          usage: { in: 1, out: 1 },
          requestId: null,
          journey: null,
          thinking: "hmm",
        }
      ),
    ]);
    expect(state.votes[0].thinking).toBe("hmm");
  });

  it("saves only finished runs, and loads them back with the debate", () => {
    expect(toSavedRun(play([start]))).toBeNull();
    const pairs = [
      {
        persuader: { model: "a/1", choice: "YES", reasoning: "" },
        persuadee: { model: "b/1", choice: "NO", reasoning: "" },
      },
    ];
    const verdict = {
      persuader: { finalChoice: "YES", flipped: false },
      persuadee: { finalChoice: "YES", flipped: true },
    };
    const state = play([
      start,
      ...run({ type: "request", id: "req_1", phase: "vote" }, { type: "done" }),
      { type: "debate_start", pairs, mode: "persuade" },
      ...debate({ type: "verdict", pair: 0, ...verdict }, { type: "done" }),
    ]);
    const saved = toSavedRun(state)!;
    expect(saved.phases).toEqual({ req_1: "vote" });

    const loaded = play([{ type: "load", run: saved }]);
    expect(loaded).toMatchObject({ fromHistory: true, phase: "done", question: "Pull?", phases: { req_1: "vote" } });
    expect(loaded.debate).toMatchObject({ mode: "persuade", running: false });
    expect(loaded.debate?.exchanges[0].verdict).toEqual(verdict);
  });
});

describe("providerShares", () => {
  it("counts votes per provider, and requests and tokens from flexrouter's log", () => {
    const vote = (model: string | null, status: Vote["status"]): Vote => ({
      slot: 0,
      model,
      status,
      text: "",
      choice: "YES",
      reasons: {},
      requestId: null,
      journey: null,
      retries: [],
    });
    const shares = providerShares(
      [vote("a/1", "done"), vote("a/2", "done"), vote("b/1", "failed")],
      [row("a", 10), row("b", 30), row(null, 99)]
    );
    expect(shares).toEqual([
      { provider: "a", votes: 2, requests: 1, tokens: 10 },
      { provider: "b", votes: 0, requests: 1, tokens: 30 },
    ]);
  });
});

describe("voteChain", () => {
  it("lists failovers inside each request, answers that didn't count, then the voter", () => {
    const vote: Vote = {
      slot: 0,
      model: "c/1",
      status: "done",
      text: "",
      choice: "YES",
      reasons: {},
      requestId: "req_2",
      retries: [
        {
          requestId: "req_1",
          model: "b/1",
          reason: "Answer wasn't one of the options",
          journey: journey("req_1", failed("a/1")),
        },
      ],
      journey: journey(
        "req_2",
        { kind: "skipped", provider: "b", model: "1", reason: "excluded", detail: "" },
        failed("d/1", "boom"),
        { kind: "answered", provider: "c", model: "1", ms: 9 }
      ),
    };
    expect(voteChain(vote)).toEqual([
      { model: "a/1", kind: "failed", note: "429" },
      { model: "b/1", kind: "rejected", note: "Answer wasn't one of the options" },
      { model: "d/1", kind: "failed", note: "boom" },
      { model: "c/1", kind: "answered", note: "" },
    ]);
  });

  it("is empty for a vote that went straight through", () => {
    const vote: Vote = {
      slot: 0,
      model: "a/1",
      status: "done",
      text: "",
      choice: "YES",
      reasons: {},
      requestId: "req_1",
      retries: [],
      journey: journey("req_1", { kind: "answered", provider: "a", model: "1", ms: 1 }),
    };
    expect(voteChain(vote).filter((l) => l.kind !== "answered")).toEqual([]);
  });
});
