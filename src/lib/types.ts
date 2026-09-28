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

// ── flexrouter's request log (GET /api/requests, ADR 0018) ──────────────

export type RequestOutcome = "ok" | "failover" | "failed";

/** One row of flexrouter's request log. */
export interface RequestRow {
  id: string;
  /** ISO time; flexrouter writes it as "...+00:00Z", see parseAt(). */
  at: string;
  bucket: string;
  ok: boolean;
  answered_by: { provider: string; model: string } | null;
  tokens_in: number;
  tokens_out: number;
  ms_total: number;
  skipped_count: number;
  outcome: RequestOutcome;
  attempt_count: number;
  client: string | null;
}

export interface RequestPage {
  requests: RequestRow[];
  total: number;
}

/** One step of a request's journey, in the order flexrouter took it. */
export type JourneyStep =
  | { kind: "skipped"; provider: string; model: string; reason: string; detail: string }
  | {
      kind: "failed";
      provider: string;
      model: string;
      status: number | null;
      message: string;
      verdict: string;
      ms: number | null;
    }
  | { kind: "answered"; provider: string; model: string; ms: number | null }
  | { kind: "gave_up" };

/** GET /api/requests/{id}: what flexrouter passed over, tried and got back. */
export interface Journey {
  id: string;
  at: string;
  bucket: string;
  client: string | null;
  ok: boolean;
  outcome: RequestOutcome;
  tokens_in: number;
  tokens_out: number;
  ms_total: number;
  steps: JourneyStep[];
}

/** What Agora was doing when it sent a request; flexrouter doesn't know. */
export type Phase = "extract" | "vote" | "summary" | "debate";

/** A request made for a vote that didn't end in a vote. */
export interface Retry {
  requestId: string | null;
  /** The model that answered, when there was one. */
  model: string | null;
  reason: string;
  journey: Journey | null;
}

export interface Vote {
  slot: number;
  /** The model answering; null until flexrouter names it. */
  model: string | null;
  status: "streaming" | "done" | "failed";
  text: string;
  choice: string | null;
  reasons: Record<string, string>;
  requestId: string | null;
  /** The journey of the request that produced this vote, once it's finished. */
  journey: Journey | null;
  /** Earlier requests for this vote that didn't produce one. */
  retries: Retry[];
  /** Chain-of-thought, for models that stream it separately from their reply. */
  thinking?: string;
  ms?: number;
  usage?: Usage;
  error?: string;
}

export type RunEvent =
  | { type: "models"; models: Model[] }
  | { type: "request"; id: string; phase: Phase }
  | { type: "choices"; choices: string[] }
  | { type: "vote_start"; slot: number }
  | { type: "vote_model"; slot: number; model: string }
  | { type: "vote_token"; slot: number; token: string }
  | { type: "vote_retry"; slot: number; retry: Retry }
  | {
      type: "vote_done";
      slot: number;
      choice: string;
      reasons: Record<string, string>;
      ms: number;
      usage: Usage;
      requestId: string | null;
      journey: Journey | null;
      thinking?: string;
    }
  | { type: "vote_failed"; slot: number; reason: string; requestId: string | null; journey: Journey | null }
  | { type: "summary_start"; model: string | null }
  | { type: "summary_token"; token: string }
  | { type: "error"; message: string }
  | { type: "done" };

export interface DebatePair {
  persuader: { model: string; choice: string; reasoning: string };
  persuadee: { model: string; choice: string; reasoning: string };
}

export type Speaker = "persuader" | "persuadee";

/**
 * "persuade": the majority voter sets out to change the minority voter's mind.
 * "symmetric": both argue their side and stay open to the other's.
 */
export type DebateMode = "persuade" | "symmetric";

export type DebateEvent =
  | { type: "pair_start"; pair: number }
  | { type: "turn_start"; pair: number; turn: number; speaker: Speaker }
  | { type: "turn_token"; pair: number; turn: number; token: string }
  /** The debater's own model failed or stalled; a stand-in from the bucket takes this turn. */
  | { type: "turn_standin"; pair: number; turn: number; model: string | null }
  /** The pair ended early: skipped by the viewer, or no model could take a turn in time. */
  | { type: "pair_skipped"; pair: number; reason: string }
  | { type: "turn_done"; pair: number; turn: number; text: string; vote: string; requestId: string | null }
  | { type: "request"; id: string; phase: Phase }
  | {
      type: "verdict";
      pair: number;
      persuader: { finalChoice: string; flipped: boolean };
      persuadee: { finalChoice: string; flipped: boolean };
    }
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
