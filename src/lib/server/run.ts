import { extractMessages, parseChoices, parseVote, summaryMessages, voteMessages } from "../prompts";
import type { Model, RunEvent } from "../types";
import { callRecord, FlexrouterError, type ChatFn } from "./flexrouter";

export const MAX_VOTES = 60;
const CONCURRENCY = 6;
const SUMMARY_CANDIDATES = 3;

export interface RunInput {
  question: string;
  votes: number;
}

export interface RunDeps {
  chat: ChatFn;
  models: Model[];
  bucket: string;
  emit: (event: RunEvent) => void;
  signal: AbortSignal;
}

/**
 * Spread consecutive picks across providers: one model from each provider
 * in turn, best score first within a provider. Pooling many providers' free
 * tiers is the point, and it keeps any one provider's rate limit from being
 * hit by several votes at once.
 */
export function interleaveByProvider(models: Model[]): Model[] {
  const byProvider = new Map<string, Model[]>();
  for (const m of [...models].sort((a, b) => b.score - a.score)) {
    const list = byProvider.get(m.provider) ?? [];
    list.push(m);
    byProvider.set(m.provider, list);
  }
  const queues = [...byProvider.values()];
  const out: Model[] = [];
  for (let round = 0; out.length < models.length; round++) {
    for (const q of queues) if (q[round]) out.push(q[round]);
  }
  return out;
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Runs `worker` over `count` slots, at most `limit` at a time. */
async function pool(count: number, limit: number, worker: (slot: number) => Promise<void>) {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, count) }, async () => {
    while (next < count) await worker(next++);
  });
  await Promise.all(lanes);
}

async function extractChoices(question: string, deps: RunDeps): Promise<string[]> {
  const { chat, bucket, emit, signal } = deps;
  try {
    const result = await chat({ model: bucket, messages: extractMessages(question), temperature: 0, signal });
    emit({ type: "call", call: callRecord("extract", bucket, result) });
    const choices = parseChoices(result.text);
    if (!choices) throw new Error("Couldn't work out the options in this dilemma. Try rewording it.");
    return choices;
  } catch (err) {
    if (err instanceof FlexrouterError) emit({ type: "call", call: callRecord("extract", bucket, err) });
    throw err;
  }
}

/**
 * Round 1. Extract the choices, then collect up to `votes` votes, each from
 * a different model. A model that fails or answers off-format is recorded as
 * skipped on that vote, which moves on to the next unused model. Finally one
 * of the best-scoring models writes the summary.
 */
export async function runRound(input: RunInput, deps: RunDeps): Promise<void> {
  const { chat, models, emit, signal } = deps;

  emit({ type: "models", models });
  const choices = await extractChoices(input.question, deps);
  emit({ type: "choices", choices });

  const queue = interleaveByProvider(models);
  const collected: { choice: string; reasons: Record<string, string> }[] = [];
  const messages = voteMessages(input.question, choices);

  await pool(Math.min(input.votes, models.length), CONCURRENCY, async (slot) => {
    for (let model = queue.shift(); model; model = queue.shift()) {
      if (signal.aborted) return;
      emit({ type: "vote_start", slot, model: model.id });
      try {
        const result = await chat({
          model: model.id,
          messages,
          temperature: 0.9,
          signal,
          onToken: (token) => emit({ type: "vote_token", slot, token }),
        });
        emit({ type: "call", call: callRecord("vote", model.id, result) });
        const { choice, reasons } = parseVote(result.text, choices);
        if (choice) {
          collected.push({ choice, reasons });
          emit({ type: "vote_done", slot, choice, reasons, ms: result.ms, usage: result.usage });
          return;
        }
        emit({ type: "vote_skip", slot, model: model.id, reason: "Answer wasn't one of the options" });
      } catch (err) {
        if (signal.aborted) return;
        if (err instanceof FlexrouterError) emit({ type: "call", call: callRecord("vote", model.id, err) });
        emit({ type: "vote_skip", slot, model: model.id, reason: reason(err) });
      }
    }
    emit({ type: "vote_failed", slot, reason: "Every model was used or unavailable" });
  });

  if (signal.aborted || collected.length === 0) return;

  const summary = summaryMessages(input.question, choices, collected);
  for (const model of models.slice(0, SUMMARY_CANDIDATES)) {
    let started = false;
    try {
      const result = await chat({
        model: model.id,
        messages: summary,
        temperature: 0.3,
        signal,
        onToken: (token) => {
          if (!started) emit({ type: "summary_start", model: model.id });
          started = true;
          emit({ type: "summary_token", token });
        },
      });
      emit({ type: "call", call: callRecord("summary", model.id, result) });
      return;
    } catch (err) {
      if (err instanceof FlexrouterError) emit({ type: "call", call: callRecord("summary", model.id, err) });
      if (started || signal.aborted) return;
    }
  }
}
