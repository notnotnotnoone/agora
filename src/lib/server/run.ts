import { extractMessages, parseChoices, parseVote, summaryMessages, voteMessages } from "../prompts";
import type { Journey, Model, Phase, RunEvent } from "../types";
import { clientTag, FlexrouterError, type ChatFn, type ChatResult } from "./flexrouter";

export const MAX_VOTES = 60;
const CONCURRENCY = 6;
/** How long a vote waits for the one before it to name its model. */
const WAIT_FOR_MODEL_MS = 2500;

export interface RunInput {
  question: string;
  votes: number;
  runId: string;
}

export interface RunDeps {
  chat: ChatFn;
  /** Reads a finished request's journey from flexrouter. */
  journey: (requestId: string) => Promise<Journey | null>;
  models: Model[];
  bucket: string;
  emit: (event: RunEvent) => void;
  signal: AbortSignal;
  waitForModelMs?: number;
}

function reason(err: unknown): string {
  if (err instanceof FlexrouterError && /excluded/i.test(err.message)) {
    return "Every model in the bucket has voted";
  }
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

const requestIdOf = (outcome: ChatResult | unknown) =>
  outcome instanceof FlexrouterError ? outcome.requestId : ((outcome as ChatResult | null)?.requestId ?? null);

/**
 * Round 1. Extract the choices, then collect up to `votes` votes, one per
 * model. Every call asks the bucket and flexrouter picks the model and fails
 * over; Agora only keeps the list of models that have voted, which each vote
 * excludes. Finally the bucket writes the summary.
 */
export async function runRound(input: RunInput, deps: RunDeps): Promise<void> {
  const { chat, models, bucket, emit, signal } = deps;
  const client = clientTag(input.runId);

  /** Names a finished request's phase for the log, and reads its journey. */
  async function settle(outcome: ChatResult | unknown, phase: Phase): Promise<Journey | null> {
    const id = requestIdOf(outcome);
    if (!id) return null;
    emit({ type: "request", id, phase });
    return deps.journey(id).catch(() => null);
  }

  emit({ type: "models", models });

  let choices: string[] | null;
  try {
    const result = await chat({ model: bucket, messages: extractMessages(input.question), temperature: 0, client, signal });
    await settle(result, "extract");
    choices = parseChoices(result.text);
  } catch (err) {
    await settle(err, "extract");
    throw err;
  }
  if (!choices) throw new Error("Couldn't work out the options in this dilemma. Try rewording it.");
  emit({ type: "choices", choices });

  const messages = voteMessages(input.question, choices);
  const collected: { choice: string; reasons: Record<string, string> }[] = [];
  // Models that have voted or are answering a vote right now.
  const taken = new Set<string>();
  // Votes start one at a time: each waits until the one before it has a
  // model, so it can exclude that model too. Once a model starts answering,
  // flexrouter can no longer fail over, so the model named is final. The wait
  // is capped, so a vote stuck waiting for a model to cool down doesn't hold
  // up the rest; if two votes then land on one model, the later one is
  // stopped at its first token and asks again.
  const waitMs = deps.waitForModelMs ?? WAIT_FOR_MODEL_MS;
  let gate = Promise.resolve();

  await pool(Math.min(input.votes, models.length), CONCURRENCY, async (slot) => {
    emit({ type: "vote_start", slot });
    while (!signal.aborted) {
      const previous = gate;
      let named!: () => void;
      gate = new Promise((resolve) => {
        named = resolve;
        setTimeout(resolve, waitMs);
      });
      await previous;
      if (signal.aborted) return named();

      const request = new AbortController();
      const stop = () => request.abort();
      signal.addEventListener("abort", stop, { once: true });
      let answering: string | null = null;
      let duplicate = false;
      let outcome: ChatResult | unknown;
      try {
        outcome = await chat({
          model: bucket,
          messages,
          temperature: 0.9,
          client,
          exclude: [...taken],
          signal: request.signal,
          onModel: (model) => {
            named();
            if (taken.has(model)) {
              duplicate = true;
              return request.abort();
            }
            answering = model;
            taken.add(model);
            emit({ type: "vote_model", slot, model });
          },
          onToken: (token) => emit({ type: "vote_token", slot, token }),
        });
      } catch (err) {
        outcome = err;
      } finally {
        named();
        signal.removeEventListener("abort", stop);
      }
      if (signal.aborted) return;
      if (duplicate) continue;

      const requestId = requestIdOf(outcome);
      const journey = await settle(outcome, "vote");
      if (outcome instanceof Error) {
        // A model that failed after it started answering has used its turn;
        // before that, flexrouter has already tried everything it could.
        if (answering) {
          emit({ type: "vote_retry", slot, retry: { requestId, model: answering, reason: outcome.message, journey } });
          continue;
        }
        emit({ type: "vote_failed", slot, reason: reason(outcome), requestId, journey });
        return;
      }

      const result = outcome as ChatResult;
      const { choice, reasons } = parseVote(result.text, choices);
      if (choice) {
        collected.push({ choice, reasons });
        emit({ type: "vote_done", slot, choice, reasons, ms: result.ms, usage: result.usage, requestId, journey });
        return;
      }
      emit({
        type: "vote_retry",
        slot,
        retry: { requestId, model: result.answeredBy, reason: "Answer wasn't one of the options", journey },
      });
    }
  });

  if (signal.aborted || collected.length === 0) return;

  let writer: string | null = null;
  let started = false;
  try {
    const result = await chat({
      model: bucket,
      messages: summaryMessages(input.question, choices, collected),
      temperature: 0.3,
      client,
      signal,
      onModel: (model) => (writer = model),
      onToken: (token) => {
        if (!started) emit({ type: "summary_start", model: writer });
        started = true;
        emit({ type: "summary_token", token });
      },
    });
    await settle(result, "summary");
  } catch (err) {
    // The summary is a nice-to-have; the votes stand without it.
    if (!signal.aborted) await settle(err, "summary");
  }
}
