import "server-only";

import { readEvents } from "../sse";
import type { Attempt, ChatMessage, Journey, Model, ModelState, RequestOutcome, RequestPage, RosterModel, Usage } from "../types";

// Agora talks to a local flexrouter server (`flexrouter serve`), which owns
// provider keys, rate limits, key rotation and failover. Nothing here knows
// about any provider.

const BASE_URL = (process.env.FLEXROUTER_URL ?? "http://localhost:4891").replace(/\/+$/, "");
const TOKEN = process.env.FLEXROUTER_TOKEN;

/** The bucket every call asks. "all" is flexrouter's built-in bucket of every model (its ADR 0019). */
export const BUCKET = process.env.FLEXROUTER_BUCKET ?? "all";

/** Where the browser can open flexrouter's own dashboard. */
export const DASHBOARD_URL = (process.env.FLEXROUTER_DASHBOARD_URL ?? BASE_URL).replace(/\/+$/, "");

const REQUEST_ID_HEADER = "x-flexrouter-request-id";
// flexrouter's own request options (ADR 0018). Headers, so they never reach a provider.
const CLIENT_HEADER = "X-Flexrouter-Client";
const EXCLUDE_HEADER = "X-Flexrouter-Exclude";

/** The tag a run's requests carry in flexrouter's log. */
export const clientTag = (runId: string) => `agora-${runId}`;

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

function headers(extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json", ...extra };
  if (TOKEN) h.Authorization = `Bearer ${TOKEN}`;
  return h;
}

const unreachable = () =>
  new FlexrouterError(`Can't reach flexrouter at ${BASE_URL}. Is \`flexrouter serve\` running?`);

async function request(path: string, init: RequestInit = {}, extra?: Record<string, string>): Promise<Response> {
  try {
    return await fetch(`${BASE_URL}${path}`, { ...init, headers: headers(extra), cache: "no-store" });
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
    /** A bucket's models, as "provider/model" ids. */
    models?: string[];
    /** What `auto` stands for. */
    resolves_to?: string;
    provider?: string;
    model?: string;
    score?: number;
    vision?: boolean;
    status?: { value?: string; reason?: string; until?: number | null };
  };
}

async function modelEntries(signal?: AbortSignal): Promise<ModelEntry[]> {
  const res = await request("/v1/models", { signal });
  if (!res.ok) throw new FlexrouterError(`flexrouter /v1/models answered ${res.status}`);
  return ((await res.json()) as { data: ModelEntry[] }).data;
}

/** Every model flexrouter knows, with its live status, best score first. */
export async function getRoster(signal?: AbortSignal): Promise<RosterModel[]> {
  return roster(await modelEntries(signal));
}

function roster(data: ModelEntry[]): RosterModel[] {
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

/**
 * The models a run can use: those in `bucket` that aren't waiting on a human.
 * A bucket flexrouter doesn't list models for (an older flexrouter's `all`)
 * counts as every model.
 */
export async function listModels(signal?: AbortSignal, bucket = BUCKET): Promise<Model[]> {
  const data = await modelEntries(signal);
  const entry = (id: string) => data.find((e) => e.id === id && e.flexrouter?.kind === "bucket");
  let found = entry(bucket);
  if (found?.flexrouter?.resolves_to) found = entry(found.flexrouter.resolves_to);
  const members = found?.flexrouter?.models?.length ? new Set(found.flexrouter.models) : null;
  return roster(data)
    .filter((m) => !UNUSABLE.has(m.state) && (!members || members.has(m.id)))
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
  /** Tags the request in flexrouter's log, so Agora can find it again. */
  client?: string;
  /** "provider/model" ids a bucket call must leave out. */
  exclude?: string[];
  signal?: AbortSignal;
  /** Called once, as soon as flexrouter names the model answering. */
  onModel?: (model: string) => void;
  onToken?: (token: string) => void;
  /** Chain-of-thought tokens, from models that stream them apart from the reply. */
  onReasoning?: (token: string) => void;
  /** Called once flexrouter has accepted the request, with its id. */
  onRequest?: (requestId: string) => void;
}

export interface ChatResult {
  text: string;
  /** Chain-of-thought, if the model streamed any. */
  reasoning: string;
  requestId: string | null;
  /** The model that answered, as flexrouter's stream named it; for a pinned call, the pin. */
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
export const streamChat: ChatFn = async ({
  model,
  messages,
  temperature,
  client,
  exclude,
  signal,
  onModel,
  onToken,
  onReasoning,
  onRequest,
}) => {
  const started = Date.now();
  const options: Record<string, string> = {};
  if (client) options[CLIENT_HEADER] = client;
  if (exclude?.length) options[EXCLUDE_HEADER] = exclude.join(",");
  const res = await request(
    "/v1/chat/completions",
    { method: "POST", body: JSON.stringify({ model, messages, temperature, stream: true }), signal },
    options
  );
  const requestId = res.headers.get(REQUEST_ID_HEADER);
  if (requestId) onRequest?.(requestId);

  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => null)) as ErrorBody | null;
    throw toError(body, `flexrouter answered ${res.status}`, requestId, Date.now() - started);
  }

  let text = "";
  let reasoning = "";
  let usage: Usage = { in: 0, out: 0 };
  let answeredBy = pinned(model);
  if (answeredBy) onModel?.(answeredBy);
  for await (const data of readEvents(res.body)) {
    let chunk: ErrorBody & {
      flexrouter?: { model?: string };
      choices?: { delta?: { content?: string; reasoning_content?: string; reasoning?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    if (chunk.error) throw toError(chunk, "flexrouter stream failed", requestId, Date.now() - started);
    if (chunk.usage) usage = { in: chunk.usage.prompt_tokens ?? 0, out: chunk.usage.completion_tokens ?? 0 };
    if (!answeredBy && chunk.flexrouter?.model) {
      answeredBy = chunk.flexrouter.model;
      onModel?.(answeredBy);
    }
    const delta = chunk.choices?.[0]?.delta;
    const thought = delta?.reasoning_content ?? delta?.reasoning;
    if (thought) {
      reasoning += thought;
      onReasoning?.(thought);
    }
    const token = delta?.content;
    if (token) {
      text += token;
      onToken?.(token);
    }
  }

  return { text, reasoning, requestId, answeredBy, usage, ms: Date.now() - started };
};

// ── flexrouter's request log ────────────────────────────────────────────

export interface RequestQuery {
  client: string;
  result?: RequestOutcome | "";
  q?: string;
  limit?: number;
}

/** Requests flexrouter logged under one client tag, newest first. */
export async function listRequests({ client, result, q, limit }: RequestQuery): Promise<RequestPage> {
  const params = new URLSearchParams({ client });
  if (result) params.set("result", result);
  if (q?.trim()) params.set("q", q.trim());
  if (limit) params.set("limit", String(limit));
  const res = await request(`/api/requests?${params}`);
  if (!res.ok) throw new FlexrouterError(`flexrouter /api/requests answered ${res.status}`);
  return (await res.json()) as RequestPage;
}

/** One request's journey, or null if flexrouter has no record of it. */
export async function getJourney(id: string, signal?: AbortSignal): Promise<Journey | null> {
  const res = await request(`/api/requests/${encodeURIComponent(id)}`, { signal });
  if (res.status === 404) return null;
  if (!res.ok) throw new FlexrouterError(`flexrouter /api/requests/${id} answered ${res.status}`);
  return (await res.json()) as Journey;
}
