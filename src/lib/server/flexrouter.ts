import "server-only";

import { readEvents } from "../sse";
import type { Attempt, CallRecord, ChatMessage, Model, ModelState, Phase, RosterModel, Usage } from "../types";

// Agora talks to a local flexrouter server (`flexrouter serve`), which owns
// provider keys, rate limits, key rotation and failover. Nothing here knows
// about any provider.

const BASE_URL = (process.env.FLEXROUTER_URL ?? "http://localhost:4891").replace(/\/+$/, "");
const TOKEN = process.env.FLEXROUTER_TOKEN;

/** Bucket for calls where the exact model doesn't matter; "auto" = flexrouter's best bucket. */
export const BUCKET = process.env.FLEXROUTER_BUCKET ?? "auto";

/** Where the browser can open flexrouter's own dashboard. */
export const DASHBOARD_URL = (process.env.FLEXROUTER_DASHBOARD_URL ?? BASE_URL).replace(/\/+$/, "");

const REQUEST_ID_HEADER = "x-flexrouter-request-id";

// Statuses that won't clear by themselves. Busy and struggling models stay in
// the roster; they recover, and a vote that hits one simply moves on.
const UNUSABLE: ReadonlySet<string> = new Set(["needs_you", "off"]);

export class FlexrouterError extends Error {
  constructor(
    message: string,
    readonly requestId: string | null = null,
    readonly attempts: Attempt[] = [],
    readonly ms = 0
  ) {
    super(message);
    this.name = "FlexrouterError";
  }
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (TOKEN) h.Authorization = `Bearer ${TOKEN}`;
  return h;
}

const unreachable = () =>
  new FlexrouterError(`Can't reach flexrouter at ${BASE_URL}. Is \`flexrouter serve\` running?`);

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(`${BASE_URL}${path}`, { ...init, headers: headers(), cache: "no-store" });
  } catch (err) {
    if (init.signal?.aborted) throw err;
    throw unreachable();
  }
}

// ── reading flexrouter's state ──────────────────────────────────────────

interface ModelEntry {
  id: string;
  flexrouter?: {
    kind?: string;
    provider?: string;
    model?: string;
    score?: number;
    vision?: boolean;
    status?: { value?: string; reason?: string; until?: number | null };
  };
}

/** Every model flexrouter knows, with its live status, best score first. */
export async function getRoster(signal?: AbortSignal): Promise<RosterModel[]> {
  const res = await request("/v1/models", { signal });
  if (!res.ok) throw new FlexrouterError(`flexrouter /v1/models answered ${res.status}`);
  const { data } = (await res.json()) as { data: ModelEntry[] };
  return data
    .filter((e) => e.flexrouter?.kind === "model")
    .map((e) => {
      const fr = e.flexrouter!;
      return {
        id: e.id,
        provider: fr.provider ?? e.id.split("/")[0],
        name: fr.model ?? e.id,
        score: fr.score ?? 0,
        vision: fr.vision ?? false,
        state: (fr.status?.value ?? "ready") as ModelState,
        reason: fr.status?.reason ?? "",
        until: fr.status?.until ?? null,
      };
    })
    .sort((a, b) => b.score - a.score);
}

/** The models a run can use: everything not waiting on a human. */
export async function listModels(signal?: AbortSignal): Promise<Model[]> {
  return (await getRoster(signal))
    .filter((m) => !UNUSABLE.has(m.state))
    .map(({ id, provider, name, score, vision }) => ({ id, provider, name, score, vision }));
}

/** Spend so far this flexrouter session, in USD. */
export async function getSpend(): Promise<number> {
  const res = await request("/api/status");
  if (!res.ok) throw new FlexrouterError(`flexrouter /api/status answered ${res.status}`);
  const body = (await res.json()) as { total_cost_usd?: number };
  return body.total_cost_usd ?? 0;
}

// ── chat ────────────────────────────────────────────────────────────────

export interface ChatRequest {
  /** A pinned "provider/model" id, or a bucket name. */
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  signal?: AbortSignal;
  onToken?: (token: string) => void;
}

export interface ChatResult {
  text: string;
  requestId: string | null;
  /** The model that answered, when flexrouter says; for a pinned call, the pin. */
  answeredBy: string | null;
  usage: Usage;
  ms: number;
}

export type ChatFn = (req: ChatRequest) => Promise<ChatResult>;

interface ErrorBody {
  error?: {
    message?: string;
    flexrouter?: { request_id?: string; attempts?: RawAttempt[] };
  };
}

interface RawAttempt {
  model?: string;
  status?: number | null;
  provider_message?: string;
  verdict?: string | null;
  ms?: number | null;
}

function toError(body: ErrorBody | null, fallback: string, requestId: string | null, ms: number) {
  const err = body?.error;
  const attempts = (err?.flexrouter?.attempts ?? []).map(
    (a): Attempt => ({
      model: a.model ?? "",
      status: a.status ?? null,
      message: a.provider_message ?? "",
      verdict: a.verdict ?? null,
      ms: a.ms ?? null,
    })
  );
  return new FlexrouterError(err?.message ?? fallback, err?.flexrouter?.request_id ?? requestId, attempts, ms);
}

const pinned = (model: string) => (model.includes("/") ? model : null);

/**
 * One streamed chat completion through flexrouter. Throws FlexrouterError on
 * any failure, including one reported inside an HTTP 200 stream, carrying the
 * attempts flexrouter made.
 */
export const streamChat: ChatFn = async ({ model, messages, temperature, signal, onToken }) => {
  const started = Date.now();
  const res = await request("/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model, messages, temperature, stream: true }),
    signal,
  });
  const requestId = res.headers.get(REQUEST_ID_HEADER);

  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => null)) as ErrorBody | null;
    throw toError(body, `flexrouter answered ${res.status}`, requestId, Date.now() - started);
  }

  let text = "";
  let usage: Usage = { in: 0, out: 0 };
  let answeredBy: string | null = null;
  for await (const data of readEvents(res.body)) {
    let chunk: ErrorBody & {
      model?: string;
      choices?: { delta?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    if (chunk.error) throw toError(chunk, "flexrouter stream failed", requestId, Date.now() - started);
    if (chunk.usage) usage = { in: chunk.usage.prompt_tokens ?? 0, out: chunk.usage.completion_tokens ?? 0 };
    answeredBy ??= chunk.model && chunk.model !== model ? chunk.model : null;
    const token = chunk.choices?.[0]?.delta?.content;
    if (token) {
      text += token;
      onToken?.(token);
    }
  }

  return { text, requestId, answeredBy: pinned(model) ?? answeredBy, usage, ms: Date.now() - started };
};

/** The request-log row for a finished call. */
export function callRecord(phase: Phase, asked: string, outcome: ChatResult | FlexrouterError): CallRecord {
  const at = Date.now() - outcome.ms;
  const id = outcome.requestId ?? `local_${at.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  if (outcome instanceof FlexrouterError) {
    return {
      id, at, phase, asked,
      answeredBy: null,
      outcome: "failed",
      attempts: outcome.attempts,
      usage: { in: 0, out: 0 },
      ms: outcome.ms,
      error: outcome.message,
    };
  }
  return {
    id, at, phase, asked,
    answeredBy: outcome.answeredBy,
    outcome: "ok",
    attempts: [],
    usage: outcome.usage,
    ms: outcome.ms,
  };
}
