export interface ModelConfig {
  id: string;
  modelName: string;
  provider: string;
  baseUrl: string;
  apiKey: string;
  headerParser: string;
  rpm: number;
  intelligence: number;
  requestCount: number;
}

export interface ModelConfigPublic extends Omit<ModelConfig, "apiKey"> {}

export interface ResponseEntry {
  modelId: string;
  requestIndex: number;
  status: "pending" | "streaming" | "done" | "failed";
  reasoning: string;
  vote: string | null;
  rawText: string;
  error?: string;
}

export type RunEvent =
  | { type: "response_start"; modelId: string; requestIndex: number }
  | { type: "response_token"; modelId: string; requestIndex: number; token: string }
  | { type: "response_done"; modelId: string; requestIndex: number; vote: string | null; reasoning: string }
  | { type: "response_error"; modelId: string; requestIndex: number; error: string }
  | { type: "all_done" };

export interface DebatePair {
  persuaderId: string;
  persuaderVote: string;
  persuaderReasoning: string;
  persuadeeId: string;
  persuadeeVote: string;
  persuadeeReasoning: string;
}

export type DebateEvent =
  | { type: "pair_start";  pairIndex: number }
  | { type: "turn_token";  pairIndex: number; turn: "persuader" | "persuadee"; token: string }
  | { type: "turn_done";   pairIndex: number; turn: "persuader" | "persuadee"; text: string }
  | { type: "verdict";     pairIndex: number; finalVote: string; flipped: boolean }
  | { type: "all_done" };

export interface PairState {
  started: boolean;
  persuaderText: string;
  persuaderDone: boolean;
  persuadeeText: string;
  persuadeeDone: boolean;
  finalVote: string | null;
  flipped: boolean | null;
}
