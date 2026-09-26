import type { SavedRun } from "./history";
import type { CallRecord, DebateEvent, DebatePair, Model, RunEvent, Vote } from "./types";

// All of a run's state, driven by the server's events. Pure, so the whole
// flow is testable without a browser.

export type Phase = "idle" | "extracting" | "voting" | "summarizing" | "done" | "stopped" | "error";

export interface Exchange {
  started: boolean;
  persuader: string;
  persuaderDone: boolean;
  persuadee: string;
  persuadeeDone: boolean;
  verdict: { finalChoice: string; flipped: boolean } | null;
}

export interface DebateState {
  pairs: DebatePair[];
  exchanges: Exchange[];
  running: boolean;
  error: string | null;
}

export interface ArenaState {
  runId: string | null;
  /** True when showing a run from history rather than a live one. */
  fromHistory: boolean;
  phase: Phase;
  at: number;
  question: string;
  requested: number;
  models: Model[];
  choices: string[];
  votes: Vote[];
  summary: { model: string | null; text: string };
  /** Every flexrouter request this run made, newest first. */
  calls: CallRecord[];
  error: string | null;
  debate: DebateState | null;
}

export type Action =
  | { type: "start"; runId: string; at: number; question: string; votes: number }
  | { type: "run"; event: RunEvent }
  | { type: "stop" }
  | { type: "fail"; message: string }
  | { type: "debate_start"; pairs: DebatePair[] }
  | { type: "debate"; event: DebateEvent }
  | { type: "debate_stop" }
  | { type: "debate_fail"; message: string }
  | { type: "load"; run: SavedRun };

export const initialState: ArenaState = {
  runId: null,
  fromHistory: false,
  phase: "idle",
  at: 0,
  question: "",
  requested: 0,
  models: [],
  choices: [],
  votes: [],
  summary: { model: null, text: "" },
  calls: [],
  error: null,
  debate: null,
};

export const isLive = (phase: Phase) => phase === "extracting" || phase === "voting" || phase === "summarizing";

function updateVote(votes: Vote[], slot: number, change: (v: Vote) => Vote): Vote[] {
  return votes.map((v) => (v.slot === slot ? change(v) : v));
}

function updateExchange(debate: DebateState, pair: number, change: (e: Exchange) => Exchange): DebateState {
  return { ...debate, exchanges: debate.exchanges.map((e, i) => (i === pair ? change(e) : e)) };
}

function runEvent(state: ArenaState, event: RunEvent): ArenaState {
  switch (event.type) {
    case "models":
      return { ...state, models: event.models };
    case "choices":
      return { ...state, choices: event.choices, phase: "voting" };
    case "vote_start": {
      const existing = state.votes.find((v) => v.slot === event.slot);
      if (existing) {
        return {
          ...state,
          votes: updateVote(state.votes, event.slot, (v) => ({ ...v, model: event.model, status: "streaming", text: "" })),
        };
      }
      const vote: Vote = {
        slot: event.slot,
        model: event.model,
        status: "streaming",
        text: "",
        choice: null,
        reasons: {},
        skipped: [],
      };
      return { ...state, votes: [...state.votes, vote].sort((a, b) => a.slot - b.slot) };
    }
    case "vote_token":
      return { ...state, votes: updateVote(state.votes, event.slot, (v) => ({ ...v, text: v.text + event.token })) };
    case "vote_skip":
      return {
        ...state,
        votes: updateVote(state.votes, event.slot, (v) => ({
          ...v,
          skipped: [...v.skipped, { model: event.model, reason: event.reason }],
        })),
      };
    case "vote_done":
      return {
        ...state,
        votes: updateVote(state.votes, event.slot, (v) => ({
          ...v,
          status: "done",
          choice: event.choice,
          reasons: event.reasons,
          ms: event.ms,
          usage: event.usage,
        })),
      };
    case "vote_failed":
      return { ...state, votes: updateVote(state.votes, event.slot, (v) => ({ ...v, status: "failed", text: "" })) };
    case "summary_start":
      return { ...state, phase: "summarizing", summary: { model: event.model, text: "" } };
    case "summary_token":
      return { ...state, summary: { ...state.summary, text: state.summary.text + event.token } };
    case "call":
      return { ...state, calls: [event.call, ...state.calls] };
    case "error":
      return { ...state, phase: "error", error: event.message };
    case "done":
      return state.phase === "error" ? state : { ...state, phase: "done" };
  }
}

function debateEvent(state: ArenaState, event: DebateEvent): ArenaState {
  const debate = state.debate;
  if (!debate) return state;
  switch (event.type) {
    case "pair_start":
      return { ...state, debate: updateExchange(debate, event.pair, (e) => ({ ...e, started: true })) };
    case "turn_token":
      return {
        ...state,
        debate: updateExchange(debate, event.pair, (e) => ({ ...e, [event.turn]: e[event.turn] + event.token })),
      };
    case "turn_done":
      return {
        ...state,
        debate: updateExchange(debate, event.pair, (e) => ({ ...e, [event.turn]: event.text, [`${event.turn}Done`]: true })),
      };
    case "verdict":
      return {
        ...state,
        debate: updateExchange(debate, event.pair, (e) => ({
          ...e,
          verdict: { finalChoice: event.finalChoice, flipped: event.flipped },
        })),
      };
    case "call":
      return { ...state, calls: [event.call, ...state.calls] };
    case "error":
      return { ...state, debate: { ...debate, running: false, error: event.message } };
    case "done":
      return { ...state, debate: { ...debate, running: false } };
  }
}

const emptyExchange = (): Exchange => ({
  started: false,
  persuader: "",
  persuaderDone: false,
  persuadee: "",
  persuadeeDone: false,
  verdict: null,
});

export function arenaReducer(state: ArenaState, action: Action): ArenaState {
  switch (action.type) {
    case "start":
      return {
        ...initialState,
        runId: action.runId,
        at: action.at,
        phase: "extracting",
        question: action.question,
        requested: action.votes,
      };
    case "run":
      return runEvent(state, action.event);
    case "stop":
      return isLive(state.phase)
        ? {
            ...state,
            phase: "stopped",
            votes: state.votes.map((v) => (v.status === "streaming" ? { ...v, status: "failed" } : v)),
          }
        : state;
    case "fail":
      return { ...state, phase: "error", error: action.message };
    case "debate_start":
      return {
        ...state,
        debate: { pairs: action.pairs, exchanges: action.pairs.map(emptyExchange), running: true, error: null },
      };
    case "debate":
      return debateEvent(state, action.event);
    case "debate_stop":
      return state.debate ? { ...state, debate: { ...state.debate, running: false } } : state;
    case "debate_fail":
      return state.debate ? { ...state, debate: { ...state.debate, running: false, error: action.message } } : state;
    case "load": {
      const { run } = action;
      return {
        ...initialState,
        runId: run.id,
        fromHistory: true,
        phase: "done",
        at: run.at,
        question: run.question,
        requested: run.votes.length,
        models: run.models,
        choices: run.choices,
        votes: run.votes,
        summary: run.summary,
        calls: run.calls,
        debate: run.debate
          ? {
              pairs: run.debate.pairs,
              exchanges: run.debate.verdicts.map((verdict) => ({ ...emptyExchange(), started: true, verdict })),
              running: false,
              error: null,
            }
          : null,
      };
    }
  }
}

/** What goes into history once a run finishes. */
export function toSavedRun(state: ArenaState): SavedRun | null {
  if (!state.runId || state.phase !== "done") return null;
  return {
    id: state.runId,
    at: state.at,
    question: state.question,
    choices: state.choices,
    models: state.models,
    votes: state.votes.filter((v) => v.status === "done"),
    summary: state.summary,
    calls: state.calls,
    debate: state.debate
      ? { pairs: state.debate.pairs, verdicts: state.debate.exchanges.map((e) => e.verdict) }
      : undefined,
  };
}

// ── derived numbers for the panels ──────────────────────────────────────

export function tally(votes: Vote[], choices: string[]): Map<string, number> {
  const counts = new Map(choices.map((c) => [c, 0]));
  for (const v of votes) if (v.status === "done" && v.choice) counts.set(v.choice, (counts.get(v.choice) ?? 0) + 1);
  return counts;
}

export interface ProviderShare {
  provider: string;
  votes: number;
  calls: number;
  tokens: number;
}

/** Per provider: votes it cast, requests it answered, tokens it served. */
export function providerShares(votes: Vote[], calls: CallRecord[]): ProviderShare[] {
  const shares = new Map<string, ProviderShare>();
  const share = (provider: string) => {
    let s = shares.get(provider);
    if (!s) shares.set(provider, (s = { provider, votes: 0, calls: 0, tokens: 0 }));
    return s;
  };
  for (const v of votes) if (v.status === "done") share(v.model.split("/")[0]).votes++;
  for (const c of calls) {
    if (!c.answeredBy) continue;
    const s = share(c.answeredBy.split("/")[0]);
    s.calls++;
    s.tokens += c.usage.in + c.usage.out;
  }
  return [...shares.values()].sort((a, b) => b.votes - a.votes || b.tokens - a.tokens);
}
