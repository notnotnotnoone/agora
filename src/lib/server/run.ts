import { extractMessages, parseChoices, parseVote, summaryMessages, voteMessages } from "../prompts";
import type { Journey, Model, Phase, RunEvent } from "../types";
import { clientTag, FlexrouterError, type ChatFn, type ChatResult } from "./flexrouter";
import { DEFAULT_LIVENESS, guarded, StallError, type Liveness } from "./guard";

export const MAX_VOTES = 60;
const CONCURRENCY = 8;
/** How long a vote waits for the one before it to name its model. */
const WAIT_FOR_MODEL_MS = 1200;
/**
 * How long voting may take in all. After this the round moves on to the
 * summary with the votes it has: a run that ends with 17 of 20 votes looks
 * far better on stage than one that sits waiting for the last three.
 */
const VOTING_WINDOW_MS = 25_000;
/** Requests one vote may use before it gives up (stalls, off-format answers, clashes). */
const MAX_TRIES_PER_VOTE = 5;

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
  votingWindowMs?: number;
  liveness?: Liveness;
}

function reason(err: unknown): string {
  if (err instanceof FlexrouterError && /excluded/i.test(err.message)) {
    return "Every model in the bucket has voted";
  }
  if (err instanceof FlexrouterError && /without success/i.test(err.message)) {
    return "Every model left was busy or rate-limited";
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
  outcome instanceof FlexrouterError || outcome instanceof StallError
    ? outcome.requestId
    : outcome instanceof Error
      ? null
      : ((outcome as ChatResult | null)?.requestId ?? null);

/**
 * Round 1. Extract the choices, then collect up to `votes` votes, one per
 * model. Every call asks the bucket and flexrouter picks the model and fails
 * over; Agora only keeps the list of models that have voted, which each vote
 * excludes. Finally the bucket writes the summary.
 */
export async function runRound(input: RunInput, deps: RunDeps): Promise<void> {
  const { models, bucket, emit, signal } = deps;
  const chat = guarded(deps.chat, deps.liveness ?? DEFAULT_LIVENESS);
  const client = clientTag(input.runId);

  /** Names a finished request's phase for the log, and reads its journey. */
  async function settle(outcome: ChatResult | unknown, phase: Phase): Promise<Journey | null> {
    const id = requestIdOf(outcome);
    if (!id) return null;
    emit({ type: "request", id, phase });
    return deps.journey(id).catch(() => null);
  }

  emit({ type: "models", models });

  // Extraction gates the whole run, so a stalled or off-format answer gets a
  // second go on a different model before the run gives up.
  let choices: string[] | null = null;
  const skip: string[] = [];
  // Models that went quiet on this run. Every later call leaves them out, so
  // one dead model costs the run a single timeout rather than one per phase.
  const stalled = new Set<string>();
  for (let attempt = 0; attempt < 2 && !choices; attempt++) {
    try {
      const result = await chat({
        model: bucket,
        messages: extractMessages(input.question),
        temperature: 0,
        client,
        exclude: skip,
        signal,
      });
      await settle(result, "extract");
      choices = parseChoices(result.text);
      if (!choices && result.answeredBy) skip.push(result.answeredBy);
    } catch (err) {
      await settle(err, "extract");
      if (signal.aborted || attempt === 1 || !(err instanceof StallError)) throw err;
      if (err.model) {
        skip.push(err.model);
        stalled.add(err.model);
      }
    }
  }
  if (!choices) throw new Error("Couldn't work out the options in this dilemma. Try rewording it.");
  emit({ type: "choices", choices });

  const messages = voteMessages(input.question, choices);
  const collected: { choice: string; reasons: Record<string, string> }[] = [];
  // Models that have voted or are answering a vote right now.
  const taken = new Set<string>(stalled);
  // Votes start one at a time: each waits until the one before it has a
  // model, so it can exclude that model too. Once a model starts answering,
  // flexrouter can no longer fail over, so the model named is final. The wait
  // is capped, so a vote stuck waiting for a model to cool down doesn't hold
  // up the rest; if two votes then land on one model, the later one is
  // stopped at its first token and asks again.
  const waitMs = deps.waitForModelMs ?? WAIT_FOR_MODEL_MS;
  let gate = Promise.resolve();

  // Voting has its own clock on top of the run's signal: when the window
  // closes, votes still in flight are stopped and marked out of time.
  const voting = new AbortController();
  const endVoting = () => voting.abort();
  signal.addEventListener("abort", endVoting, { once: true });
  const votingTimer = setTimeout(endVoting, deps.votingWindowMs ?? VOTING_WINDOW_MS);
  const outOfTime = () => voting.signal.aborted && !signal.aborted;

  await pool(Math.min(input.votes, models.length), CONCURRENCY, async (slot) => {
    if (voting.signal.aborted) return;
    emit({ type: "vote_start", slot });
    let tries = 0;
    let lastError = "";
    while (!voting.signal.aborted) {
      if (++tries > MAX_TRIES_PER_VOTE) {
        emit({ type: "vote_failed", slot, reason: lastError || "Gave up after several tries", requestId: null, journey: null });
        return;
      }
      const previous = gate;
      let named!: () => void;
      gate = new Promise((resolve) => {
        named = resolve;
        setTimeout(resolve, waitMs);
      });
      await previous;
      if (voting.signal.aborted) {
        named();
        break;
      }

      const request = new AbortController();
      const stop = () => request.abort();
      voting.signal.addEventListener("abort", stop, { once: true });
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
        voting.signal.removeEventListener("abort", stop);
      }
      if (voting.signal.aborted) break;
      if (duplicate) continue;

      const requestId = requestIdOf(outcome);
      const journey = await settle(outcome, "vote");
      if (outcome instanceof StallError) {
        // Too slow: ask again. A model that went quiet stays in `taken`, so
        // the next request goes to someone else.
        lastError = outcome.message;
        if (outcome.model) stalled.add(outcome.model);
        emit({ type: "vote_retry", slot, retry: { requestId, model: outcome.model, reason: outcome.message, journey } });
        continue;
      }
      if (outcome instanceof Error) {
        // A model that failed after it started answering has used its turn;
        // before that, flexrouter has already tried everything it could.
        if (answering) {
          lastError = outcome.message;
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
        emit({
          type: "vote_done",
          slot,
          choice,
          reasons,
          ms: result.ms,
          usage: result.usage,
          requestId,
          journey,
          thinking: result.reasoning || undefined,
        });
        return;
      }
      lastError = "Answer wasn't one of the options";
      emit({
        type: "vote_retry",
        slot,
        retry: { requestId, model: result.answeredBy, reason: "Answer wasn't one of the options", journey },
      });
    }
    if (outOfTime()) {
      emit({ type: "vote_failed", slot, reason: "Out of time: the round moved on without it", requestId: null, journey: null });
    }
  });
  clearTimeout(votingTimer);
  signal.removeEventListener("abort", endVoting);

  if (signal.aborted || collected.length === 0) return;

  // The summary is a nice-to-have; the votes stand without it. A writer
  // that stalls before its first word is swapped for another once.
  const avoid = [...stalled];
  for (let attempt = 0; attempt < 2; attempt++) {
    let writer: string | null = null;
    let started = false;
    try {
      const result = await chat({
        model: bucket,
        messages: summaryMessages(input.question, choices, collected),
        temperature: 0.3,
        client,
        exclude: avoid,
        signal,
        onModel: (model) => (writer = model),
        onToken: (token) => {
          if (!started) emit({ type: "summary_start", model: writer });
          started = true;
          emit({ type: "summary_token", token });
        },
      });
      await settle(result, "summary");
      return;
    } catch (err) {
      if (signal.aborted) return;
      await settle(err, "summary");
      if (started || !(err instanceof StallError)) return;
      if (err.model) avoid.push(err.model);
    }
  }
}
