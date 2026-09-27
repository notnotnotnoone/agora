import type { SavedRun } from "./history";
import type {
  DebateEvent,
  DebateMode,
  DebatePair,
  Journey,
  Model,
  Phase as RequestPhase,
  RequestRow,
  RunEvent,
  Speaker,
  Vote,
} from "./types";

// All of a run's state, driven by the server's events. Pure, so the whole
// flow is testable without a browser.

export type Phase = "idle" | "extracting" | "voting" | "summarizing" | "done" | "stopped" | "error";

export interface DebateTurn {
  speaker: Speaker;
  text: string;
  /** Where the speaker stood at the end of the turn; null while it's speaking. */
  vote: string | null;
  done: boolean;
}

export interface Verdict {
  persuader: { finalChoice: string; flipped: boolean };
  persuadee: { finalChoice: string; flipped: boolean };
}

export interface Exchange {
  started: boolean;
  turns: DebateTurn[];
  verdict: Verdict | null;
}

export interface DebateState {
  mode: DebateMode;
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
  /** What each of this run's flexrouter requests was for, by request id. */
  phases: Record<string, RequestPhase>;
  error: string | null;
  debate: DebateState | null;
}

export type Action =
  | { type: "start"; runId: string; at: number; question: string; votes: number }
  | { type: "run"; event: RunEvent }
  | { type: "stop" }
  | { type: "fail"; message: string }
  | { type: "debate_start"; pairs: DebatePair[]; mode: DebateMode }
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
  phases: {},
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

function updateTurn(e: Exchange, turn: number, change: (t: DebateTurn) => DebateTurn): Exchange {
  return { ...e, turns: e.turns.map((t, i) => (i === turn ? change(t) : t)) };
}

const newVote = (slot: number): Vote => ({
  slot,
  model: null,
  status: "streaming",
  text: "",
  choice: null,
  reasons: {},
  requestId: null,
  journey: null,
  retries: [],
});

function runEvent(state: ArenaState, event: RunEvent): ArenaState {
  switch (event.type) {
    case "models":
      return { ...state, models: event.models };
    case "request":
      return { ...state, phases: { ...state.phases, [event.id]: event.phase } };
    case "choices":
      return { ...state, choices: event.choices, phase: "voting" };
    case "vote_start":
      return { ...state, votes: [...state.votes, newVote(event.slot)].sort((a, b) => a.slot - b.slot) };
    case "vote_model":
      return { ...state, votes: updateVote(state.votes, event.slot, (v) => ({ ...v, model: event.model })) };
    case "vote_token":
      return { ...state, votes: updateVote(state.votes, event.slot, (v) => ({ ...v, text: v.text + event.token })) };
    case "vote_retry":
      return {
        ...state,
        votes: updateVote(state.votes, event.slot, (v) => ({
          ...v,
          model: null,
          text: "",
          retries: [...v.retries, event.retry],
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
          requestId: event.requestId,
          journey: event.journey,
        })),
      };
    case "vote_failed":
      return {
        ...state,
        votes: updateVote(state.votes, event.slot, (v) => ({
          ...v,
          status: "failed",
          text: "",
          error: event.reason,
          requestId: event.requestId,
          journey: event.journey,
        })),
      };
    case "summary_start":
      return { ...state, phase: "summarizing", summary: { model: event.model, text: "" } };
    case "summary_token":
      return { ...state, summary: { ...state.summary, text: state.summary.text + event.token } };
    case "error":
      return { ...state, phase: "error", error: event.message };
    case "done":
      return state.phase === "error" ? state : { ...state, phase: "done" };
  }
}

function debateEvent(state: ArenaState, event: DebateEvent): ArenaState {
  const debate = state.debate;
  if (!debate) return state;
  const exchange = (pair: number, change: (e: Exchange) => Exchange) => ({
    ...state,
    debate: updateExchange(debate, pair, change),
  });
  switch (event.type) {
    case "pair_start":
      return exchange(event.pair, (e) => ({ ...e, started: true }));
    case "turn_start":
      return exchange(event.pair, (e) => ({
        ...e,
        turns: [...e.turns, { speaker: event.speaker, text: "", vote: null, done: false }],
      }));
    case "turn_token":
      return exchange(event.pair, (e) => updateTurn(e, event.turn, (t) => ({ ...t, text: t.text + event.token })));
    case "turn_done":
      return exchange(event.pair, (e) =>
        updateTurn(e, event.turn, (t) => ({ ...t, text: event.text, vote: event.vote, done: true }))
      );
    case "verdict":
      return exchange(event.pair, (e) => ({ ...e, verdict: { persuader: event.persuader, persuadee: event.persuadee } }));
    case "request":
      return { ...state, phases: { ...state.phases, [event.id]: event.phase } };
    case "error":
      return { ...state, debate: { ...debate, running: false, error: event.message } };
    case "done":
      return { ...state, debate: { ...debate, running: false } };
  }
}

const emptyExchange = (): Exchange => ({ started: false, turns: [], verdict: null });

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
        debate: {
          mode: action.mode,
          pairs: action.pairs,
          exchanges: action.pairs.map(emptyExchange),
          running: true,
          error: null,
        },
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
        phases: run.phases ?? {},
        debate: run.debate ? { ...run.debate, running: false, error: null } : null,
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
    phases: state.phases,
    debate: state.debate
      ? { mode: state.debate.mode, pairs: state.debate.pairs, exchanges: state.debate.exchanges }
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
  requests: number;
  tokens: number;
}

/** Per provider: votes it cast, and the requests and tokens flexrouter logged it answering. */
export function providerShares(votes: Vote[], requests: RequestRow[]): ProviderShare[] {
  const shares = new Map<string, ProviderShare>();
  const share = (provider: string) => {
    let s = shares.get(provider);
    if (!s) shares.set(provider, (s = { provider, votes: 0, requests: 0, tokens: 0 }));
    return s;
  };
  for (const v of votes) if (v.status === "done" && v.model) share(v.model.split("/")[0]).votes++;
  for (const r of requests) {
    if (!r.answered_by) continue;
    const s = share(r.answered_by.provider);
    s.requests++;
    s.tokens += r.tokens_in + r.tokens_out;
  }
  return [...shares.values()].sort((a, b) => b.votes - a.votes || b.tokens - a.tokens);
}

/** A step in a vote's failover chain: ✕ failed, ⊘ answered but didn't count, ● voted. */
export interface ChainLink {
  model: string;
  kind: "failed" | "rejected" | "answered";
  note: string;
}

const failures = (journey: Journey | null): ChainLink[] =>
  (journey?.steps ?? []).flatMap((s) =>
    s.kind === "failed"
      ? [{ model: `${s.provider}/${s.model}`, kind: "failed" as const, note: s.message || (s.status ? `HTTP ${s.status}` : "failed") }]
      : []
  );

/**
 * Everything a vote went through, from flexrouter's journeys: models that
 * failed inside each request, answers that didn't count, and the model that
 * voted. Models left out because they had already voted aren't listed.
 */
export function voteChain(vote: Vote): ChainLink[] {
  const chain: ChainLink[] = [];
  for (const r of vote.retries) {
    chain.push(...failures(r.journey));
    if (r.model) chain.push({ model: r.model, kind: "rejected", note: r.reason });
  }
  chain.push(...failures(vote.journey));
  if (vote.status === "done" && vote.model) chain.push({ model: vote.model, kind: "answered", note: "" });
  return chain;
}
