import type { ModelConfig } from "./types";

// Agora sends every model call through a local flexrouter server
// (`flexrouter serve`), which owns provider keys, rate limits and key rotation.
const BASE_URL = (process.env.FLEXROUTER_URL ?? "http://localhost:4891").replace(/\/+$/, "");
const TOKEN = process.env.FLEXROUTER_TOKEN;

// Bucket used for calls where the exact model doesn't matter (choice extraction).
// "auto" is flexrouter's bucket holding the highest-scoring model.
export const DEFAULT_BUCKET = process.env.FLEXROUTER_BUCKET ?? "auto";

// Statuses that won't recover on their own; "busy" and "struggling" are kept
// since they clear by themselves and the callers already retry.
const UNUSABLE_STATUSES = new Set(["needs_you", "off"]);

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export class FlexrouterError extends Error {}

function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  return headers;
}

interface FlexModelEntry {
  id: string;
  flexrouter?: {
    kind: "bucket" | "model";
    provider?: string;
    model?: string;
    score?: number;
    rpm?: number;
    vision?: boolean;
    status?: { value?: string };
  };
}

function unreachable(): FlexrouterError {
  return new FlexrouterError(`Can't reach flexrouter at ${BASE_URL} — is \`flexrouter serve\` running?`);
}

async function postChat(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
  try {
    return await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: buildHeaders(),
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw unreachable();
  }
}

/** Every individual model flexrouter can serve right now, best score first. */
export async function listModels(): Promise<ModelConfig[]> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/v1/models`, { headers: buildHeaders(), cache: "no-store" });
  } catch {
    throw unreachable();
  }
  if (!res.ok) throw new FlexrouterError(`flexrouter /v1/models returned ${res.status}`);

  const { data } = (await res.json()) as { data: FlexModelEntry[] };
  return data
    .filter((e) => e.flexrouter?.kind === "model")
    .filter((e) => !UNUSABLE_STATUSES.has(e.flexrouter?.status?.value ?? ""))
    .map((e) => ({
      id: e.id,
      modelName: e.flexrouter?.model ?? e.id,
      provider: e.flexrouter?.provider ?? e.id.split("/")[0],
      score: e.flexrouter?.score ?? 0,
      rpm: e.flexrouter?.rpm ?? 0,
      vision: e.flexrouter?.vision ?? false,
    }))
    .sort((a, b) => b.score - a.score);
}

function errorMessage(payload: unknown): string | null {
  const err = (payload as { error?: { message?: string } | string } | null)?.error;
  if (!err) return null;
  return typeof err === "string" ? err : (err.message ?? "flexrouter error");
}

/**
 * Streams one chat completion. `model` is a flexrouter model id
 * ("provider/model", pinned to exactly that model) or a bucket name.
 * Resolves to the full text; throws FlexrouterError on any failure, including
 * errors flexrouter reports inside an HTTP-200 stream.
 */
export async function streamChat(
  model: string,
  messages: ChatMessage[],
  opts: { temperature?: number; onToken?: (token: string) => void; signal?: AbortSignal } = {}
): Promise<string> {
  const res = await postChat(
    { model, messages, stream: true, temperature: opts.temperature },
    opts.signal
  );

  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => null);
    throw new FlexrouterError(errorMessage(body) ?? `flexrouter returned ${res.status}`);
  }

  let fullText = "";
  let buffer = "";
  const reader = res.body.getReader();
  const dec = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += dec.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const jsonStr = trimmed.slice(5).trim();
      if (jsonStr === "[DONE]") return fullText;
      let parsed: unknown;
      try {
        parsed = JSON.parse(jsonStr);
      } catch {
        continue; // skip malformed lines
      }
      const error = errorMessage(parsed);
      if (error) throw new FlexrouterError(error);
      const token: string =
        (parsed as { choices?: { delta?: { content?: string } }[] })?.choices?.[0]?.delta?.content ?? "";
      if (token) {
        fullText += token;
        opts.onToken?.(token);
      }
    }
  }

  return fullText;
}

/** Non-streaming chat completion; same model semantics as streamChat. */
export async function complete(
  model: string,
  messages: ChatMessage[],
  opts: { temperature?: number; signal?: AbortSignal } = {}
): Promise<string> {
  const res = await postChat({ model, messages, temperature: opts.temperature }, opts.signal);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new FlexrouterError(errorMessage(body) ?? `flexrouter returned ${res.status}`);
  return body?.choices?.[0]?.message?.content ?? "";
}
