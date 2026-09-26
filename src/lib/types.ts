// Shared by the route handlers and the browser: the wire protocol and the
// records the UI renders.

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** A model flexrouter can serve. `id` is flexrouter's "provider/model" name. */
export interface Model {
  id: string;
  provider: string;
  name: string;
  score: number;
  vision: boolean;
}

/** flexrouter's one status for a model (flexrouter/status.py). */
export type ModelState = "ready" | "busy" | "struggling" | "needs_you" | "off";

/** A model with its live status, for the routing panel. */
export interface RosterModel extends Model {
  state: ModelState;
  reason: string;
  /** Epoch seconds when the status clears on its own; null if it won't. */
  until: number | null;
}

export interface Usage {
  in: number;
  out: number;
}

/** One failed try inside a single flexrouter request, as flexrouter reports it. */
export interface Attempt {
  model: string;
  status: number | null;
  message: string;
  verdict: string | null;
  ms: number | null;
}

export type Phase = "extract" | "vote" | "summary" | "debate";
export type Outcome = "ok" | "failed";

/** One request Agora sent through flexrouter: a row in the request log. */
export interface CallRecord {
  id: string;
  at: number;
  phase: Phase;
  /** What Agora asked for: a pinned "provider/model" or a bucket name. */
  asked: string;
  answeredBy: string | null;
  outcome: Outcome;
  attempts: Attempt[];
  usage: Usage;
  ms: number;
  error?: string;
}

export interface Skip {
  model: string;
  reason: string;
}

export interface Vote {
  slot: number;
  model: string;
  status: "streaming" | "done" | "failed";
  text: string;
  choice: string | null;
  reasons: Record<string, string>;
  /** Models this vote moved past before `model` answered. */
  skipped: Skip[];
  ms?: number;
  usage?: Usage;
}

export type RunEvent =
  | { type: "models"; models: Model[] }
  | { type: "choices"; choices: string[] }
  | { type: "vote_start"; slot: number; model: string }
  | { type: "vote_token"; slot: number; token: string }
  | { type: "vote_skip"; slot: number; model: string; reason: string }
  | { type: "vote_done"; slot: number; choice: string; reasons: Record<string, string>; ms: number; usage: Usage }
  | { type: "vote_failed"; slot: number; reason: string }
  | { type: "summary_start"; model: string }
  | { type: "summary_token"; token: string }
  | { type: "call"; call: CallRecord }
  | { type: "error"; message: string }
  | { type: "done" };

export interface DebatePair {
  persuader: { model: string; choice: string; reasoning: string };
  persuadee: { model: string; choice: string; reasoning: string };
}

export type Turn = "persuader" | "persuadee";

export type DebateEvent =
  | { type: "pair_start"; pair: number }
  | { type: "turn_token"; pair: number; turn: Turn; token: string }
  | { type: "turn_done"; pair: number; turn: Turn; text: string }
  | { type: "verdict"; pair: number; finalChoice: string; flipped: boolean }
  | { type: "call"; call: CallRecord }
  | { type: "error"; message: string }
  | { type: "done" };

/** What /api/flexrouter reports for the live panels. */
export interface FlexrouterSnapshot {
  connected: boolean;
  error?: string;
  dashboardUrl: string;
  models: RosterModel[];
  spentUsd: number;
}
