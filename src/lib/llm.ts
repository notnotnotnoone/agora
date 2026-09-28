import type { ModelConfig } from "./types";

export function buildHeaders(model: ModelConfig): Record<string, string> {
  const base: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${model.apiKey}`,
  };
  if (model.headerParser === "openrouter") {
    base["HTTP-Referer"] = "http://localhost:9563";
    base["X-Title"] = "Agora";
  }
  return base;
}

export function encodeSSE(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

// ---------------------------------------------------------------------------
// Model health — lives for the lifetime of the server process so every run
// benefits from what earlier runs learned (who is slow, who is rate-limited).
// ---------------------------------------------------------------------------

interface ModelHealth {
  latencyMs: number; // EWMA of time-to-completion
  failures: number; // consecutive failures
  cooldownUntil: number;
  recent: number[]; // request start timestamps, for rpm budgeting
  inFlight: number;
}

const health = new Map<string, ModelHealth>();

function getHealth(id: string): ModelHealth {
  let h = health.get(id);
  if (!h) {
    h = { latencyMs: 6000, failures: 0, cooldownUntil: 0, recent: [], inFlight: 0 };
    health.set(id, h);
  }
  return h;
}

function recordSuccess(model: ModelConfig, ms: number) {
  const h = getHealth(model.id);
  h.latencyMs = h.latencyMs * 0.6 + ms * 0.4;
  h.failures = 0;
}

function recordFailure(model: ModelConfig, status?: number, retryAfterSec?: number) {
  const h = getHealth(model.id);
  h.failures++;
  let cooldown = 0;
  if (status === 429) cooldown = Math.min((retryAfterSec ?? 20) * 1000, 60_000);
  else if (status === 401 || status === 403 || status === 404) cooldown = 5 * 60_000;
  else if (h.failures >= 2) cooldown = Math.min(5_000 * 2 ** (h.failures - 2), 60_000);
  if (cooldown) h.cooldownUntil = Math.max(h.cooldownUntil, Date.now() + cooldown);
}

function rpmHeadroom(model: ModelConfig, h: ModelHealth): number {
  const now = Date.now();
  h.recent = h.recent.filter((t) => now - t < 60_000);
  const rpm = model.rpm > 0 ? model.rpm : 30;
  return rpm - h.recent.length;
}

/**
 * Score a model for routing — higher is better. Unavailable models
 * (cooling down, out of rpm budget) get -Infinity.
 */
function score(model: ModelConfig): number {
  const h = getHealth(model.id);
  if (h.cooldownUntil > Date.now()) return -Infinity;
  const headroom = rpmHeadroom(model, h);
  if (headroom <= 0) return -Infinity;
  // Fast models win; busy or flaky ones are penalized; a little noise
  // spreads load so the consensus isn't a single model talking to itself.
  return (
    -h.latencyMs / 1000 -
    h.inFlight * 1.5 -
    h.failures * 3 +
    Math.min(headroom, 10) * 0.2 +
    Math.random() * 2.5
  );
}

/**
 * Pick the best available model, excluding `exclude`. Falls back to the
 * least-bad model (even one cooling down) rather than returning nothing —
 * a slow answer beats no answer in a live demo.
 */
export function pickModel(models: ModelConfig[], exclude: Set<string> = new Set()): ModelConfig | null {
  const pool = models.filter((m) => !exclude.has(m.id));
  if (pool.length === 0) return null;
  let best: ModelConfig | null = null;
  let bestScore = -Infinity;
  for (const m of pool) {
    const s = score(m);
    if (s > bestScore) {
      bestScore = s;
      best = m;
    }
  }
  if (best) return best;
  // Everyone is cooling down: take whoever recovers soonest.
  return pool.reduce((a, b) => (getHealth(a.id).cooldownUntil <= getHealth(b.id).cooldownUntil ? a : b));
}

/** Order models by routing preference, with `preferred` ids first if they're usable. */
export function rankModels(models: ModelConfig[], preferred: string[] = []): ModelConfig[] {
  const seen = new Set<string>();
  const out: ModelConfig[] = [];
  for (const id of preferred) {
    const m = models.find((x) => x.id === id);
    if (m && !seen.has(m.id) && score(m) > -Infinity) {
      out.push(m);
      seen.add(m.id);
    }
  }
  while (true) {
    const m = pickModel(models, seen);
    if (!m) break;
    out.push(m);
    seen.add(m.id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Streaming chat call with liveness timeouts
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface StreamOptions {
  signal?: AbortSignal;
  /** Give up if the provider sends nothing (not even reasoning) for this long after the request. */
  firstTokenTimeoutMs?: number;
  /** Give up if the stream goes quiet for this long mid-response. */
  idleTimeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
  onContent?: (token: string) => void;
  onReasoning?: (token: string) => void;
}

export interface StreamResult {
  content: string;
  reasoning: string;
}

export class LLMError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
  }
}

export async function streamChat(
  model: ModelConfig,
  messages: ChatMessage[],
  opts: StreamOptions = {}
): Promise<StreamResult> {
  const {
    firstTokenTimeoutMs = 8_000,
    idleTimeoutMs = 6_000,
    maxTokens = 900,
    temperature = 0.8,
  } = opts;

  const ctrl = new AbortController();
  const onOuterAbort = () => ctrl.abort();
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort();
    else opts.signal.addEventListener("abort", onOuterAbort, { once: true });
  }

  let timedOut: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (ms: number, why: string) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = why;
      ctrl.abort();
    }, ms);
  };

  const h = getHealth(model.id);
  h.recent.push(Date.now());
  h.inFlight++;
  const started = Date.now();
  let content = "";
  let reasoning = "";

  try {
    arm(firstTokenTimeoutMs, "no first token");
    const res = await fetch(`${model.baseUrl}/chat/completions`, {
      method: "POST",
      headers: buildHeaders(model),
      body: JSON.stringify({
        model: model.modelName,
        messages,
        stream: true,
        temperature,
        max_tokens: maxTokens,
      }),
      signal: ctrl.signal,
    });

    if (!res.ok || !res.body) {
      const retryAfter = Number(res.headers.get("retry-after")) || undefined;
      recordFailure(model, res.status, retryAfter);
      throw new LLMError(`HTTP ${res.status}`, res.status);
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let sawAny = false;

    outer: while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      // SSE lines can be split across network chunks — only consume complete lines.
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const jsonStr = trimmed.slice(5).trim();
        if (jsonStr === "[DONE]") break outer;
        let parsed;
        try {
          parsed = JSON.parse(jsonStr);
        } catch {
          continue;
        }
        if (parsed?.error) throw new LLMError(String(parsed.error.message ?? "stream error"));
        const delta = parsed?.choices?.[0]?.delta ?? {};
        const r: string = delta.reasoning_content ?? delta.reasoning ?? "";
        const c: string = delta.content ?? "";
        if (r) {
          reasoning += r;
          opts.onReasoning?.(r);
        }
        if (c) {
          content += c;
          opts.onContent?.(c);
        }
        if (r || c) {
          if (!sawAny) sawAny = true;
          arm(idleTimeoutMs, "stream stalled");
        }
      }
    }

    if (!content.trim()) {
      recordFailure(model);
      throw new LLMError("empty response");
    }
    recordSuccess(model, Date.now() - started);
    return { content, reasoning };
  } catch (err) {
    if (err instanceof LLMError) throw err;
    if (timedOut) {
      recordFailure(model);
      const e = new LLMError(timedOut);
      Object.assign(e, { partial: { content, reasoning } });
      throw e;
    }
    if (opts.signal?.aborted) throw new LLMError("aborted");
    recordFailure(model);
    throw new LLMError(err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
    h.inFlight--;
    opts.signal?.removeEventListener("abort", onOuterAbort);
  }
}

// ---------------------------------------------------------------------------
// Hedged routing: start on the best model, and if it hasn't produced a
// result quickly, race a backup on a different model. First winner takes it,
// losers are aborted. Failures immediately fail over to the next model.
// ---------------------------------------------------------------------------

export interface RouteOptions<T> {
  models: ModelConfig[];
  /** Model ids to try first, in order (e.g. the model originally assigned). */
  preferred?: string[];
  messages: ChatMessage[];
  /** Validate/parse a completed response. Return null to treat it as a failure and reroute. */
  accept: (result: StreamResult, model: ModelConfig) => T | null;
  signal?: AbortSignal;
  /** Launch a backup on another model if nothing has won after this long. */
  hedgeAfterMs?: number;
  /** Hard ceiling for the whole routed call. */
  deadlineMs?: number;
  maxParallel?: number;
  maxAttempts?: number;
  stream?: Omit<StreamOptions, "signal" | "onContent" | "onReasoning">;
  /** Called whenever a new attempt starts. */
  onAttempt?: (model: ModelConfig) => void;
  /**
   * Streaming mode: the first attempt to emit content is "committed" — its
   * tokens are forwarded via onToken and all rival attempts are aborted. If the
   * committed attempt then dies, onReset fires and routing continues.
   */
  onCommit?: (model: ModelConfig) => void;
  onToken?: (token: string) => void;
  onReset?: () => void;
}

export interface Routed<T> {
  value: T;
  model: ModelConfig;
  result: StreamResult;
}

export function routeChat<T>(opts: RouteOptions<T>): Promise<Routed<T> | null> {
  const {
    models,
    preferred = [],
    hedgeAfterMs = 5_000,
    deadlineMs = 20_000,
    maxParallel = 3,
    maxAttempts = 6,
  } = opts;

  return new Promise((resolve) => {
    const tried = new Set<string>();
    const controllers = new Set<AbortController>();
    let attempts = 0;
    let running = 0;
    let settled = false;
    let hedgeTimer: ReturnType<typeof setTimeout> | undefined;
    let committed: AbortController | null = null;
    const streaming = !!opts.onToken;

    const finish = (v: Routed<T> | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(hedgeTimer);
      clearTimeout(deadline);
      for (const c of controllers) c.abort();
      opts.signal?.removeEventListener("abort", onAbort);
      resolve(v);
    };

    const onAbort = () => finish(null);
    if (opts.signal?.aborted) return resolve(null);
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const deadline = setTimeout(() => finish(null), deadlineMs);

    const nextModel = (): ModelConfig | null => {
      for (const id of preferred) {
        if (tried.has(id)) continue;
        const m = models.find((x) => x.id === id);
        if (m && score(m) > -Infinity) return m;
      }
      const m = pickModel(models, tried);
      if (m) return m;
      // Every model has been tried once — allow repeats rather than stalling.
      return pickModel(models);
    };

    const scheduleHedge = () => {
      clearTimeout(hedgeTimer);
      hedgeTimer = setTimeout(() => {
        if (!settled && !committed && running < maxParallel) launch();
        if (!settled) scheduleHedge();
      }, hedgeAfterMs);
    };

    const launch = () => {
      if (settled || attempts >= maxAttempts) return;
      const model = nextModel();
      if (!model) return;
      attempts++;
      running++;
      tried.add(model.id);
      const ctrl = new AbortController();
      controllers.add(ctrl);
      opts.onAttempt?.(model);

      const onContent = streaming
        ? (token: string) => {
            if (settled) return;
            if (!committed) {
              committed = ctrl;
              for (const c of controllers) if (c !== ctrl) c.abort();
              opts.onCommit?.(model);
            }
            if (committed === ctrl) opts.onToken!(token);
          }
        : undefined;

      streamChat(model, opts.messages, { ...opts.stream, signal: ctrl.signal, onContent })
        .then((result) => {
          if (settled) return;
          if (committed && committed !== ctrl) return;
          const value = opts.accept(result, model);
          if (value === null) throw new LLMError("unparseable response");
          finish({ value, model, result });
        })
        .catch((err) => {
          if (settled) return;
          if (committed && committed !== ctrl) return; // a rival we aborted
          if (committed === ctrl) {
            // Stalled mid-stream: keep what we have if it's usable.
            const partial = (err as { partial?: StreamResult }).partial;
            const value = partial ? opts.accept(partial, model) : null;
            if (partial && value !== null) return finish({ value, model, result: partial });
            committed = null;
            opts.onReset?.();
          }
          // Fail over immediately instead of waiting for the hedge timer.
          launch();
        })
        .finally(() => {
          running--;
          controllers.delete(ctrl);
          if (!settled && running === 0 && attempts >= maxAttempts) finish(null);
        });
    };

    launch();
    scheduleHedge();
  });
}

// ---------------------------------------------------------------------------
// Response parsing helpers
// ---------------------------------------------------------------------------

function clean(s: string): string {
  return s
    .replace(/[*_`"'\[\]()]/g, "")
    .replace(/[.!,;:]+$/, "")
    .trim()
    .toLowerCase();
}

/** Match a model's free-text answer to one of the choices, tolerating markdown and chatter. */
export function matchChoice(raw: string | null | undefined, choices: string[]): string | null {
  if (!raw) return null;
  const c = clean(raw);
  const exact = choices.find((ch) => clean(ch) === c);
  if (exact) return exact;
  // "YES — I would pull the lever" / "Option: NO"
  const prefix = choices.find((ch) => c.startsWith(clean(ch) + " ") || c.endsWith(" " + clean(ch)));
  if (prefix) return prefix;
  const contained = choices.filter((ch) => new RegExp(`\\b${escapeRegExp(clean(ch))}\\b`).test(c));
  return contained.length === 1 ? contained[0] : null;
}

/** Find the final ANSWER: line in a response and map it to a choice. */
export function parseAnswer(text: string, choices: string[]): string | null {
  const matches = [...text.matchAll(/^[\s>*_#-]*(?:final\s+)?answer[\s*_]*:[\s*_]*(.+)$/gim)];
  for (let i = matches.length - 1; i >= 0; i--) {
    const v = matchChoice(matches[i][1], choices);
    if (v) return v;
  }
  return null;
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Strip <think>…</think> blocks some open models inline into their content. */
export function splitThink(text: string): { content: string; think: string } {
  let think = "";
  const content = text
    .replace(/<think>([\s\S]*?)(<\/think>|$)/gi, (_, t: string) => {
      think += t;
      return "";
    })
    .trim();
  return { content, think: think.trim() };
}
