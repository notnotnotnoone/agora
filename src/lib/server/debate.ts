import { parseTurn, turnMessages } from "../prompts";
import type { DebateEvent, DebateMode, DebatePair, Speaker } from "../types";
import { clientTag, FlexrouterError, type ChatFn } from "./flexrouter";
import { guarded, StallError, type Liveness } from "./guard";

const CONCURRENCY = 6;
export const MAX_TURNS = 5;
/** Stand-ins a turn may try after the debater's own model, before the pair is cut short. */
const STAND_INS = 2;
/** Debate turns stream to the viewer, so silence is noticed sooner than in voting. */
const DEBATE_LIVENESS: Liveness = { routeMs: 6_000, firstTokenMs: 6_000, idleMs: 5_000 };

export interface DebateInput {
  question: string;
  choices: string[];
  pairs: DebatePair[];
  mode: DebateMode;
  runId: string;
}

export interface DebateDeps {
  chat: ChatFn;
  /** The bucket stand-ins are drawn from when a debater's own model can't take its turn. */
  bucket: string;
  emit: (event: DebateEvent) => void;
  signal: AbortSignal;
  /** Aborts when the viewer skips a pair. */
  skipSignal?: (pair: number) => AbortSignal;
  liveness?: Liveness;
}

const requestIdOf = (err: unknown) =>
  err instanceof FlexrouterError || err instanceof StallError ? err.requestId : null;

/**
 * Round 2. In each pair the majority voter and the minority voter take turns,
 * up to MAX_TURNS, each ending its turn with where it now stands. A pair ends
 * early once both hold the same vote.
 *
 * Each side is played by the model that cast that vote in round 1, so a turn
 * is pinned to it. A pinned call doesn't fail over, so when that model fails
 * or stalls, the turn goes to a stand-in from the bucket (never either
 * debater), which argues the same side. If no stand-in answers in time
 * either, or the viewer skips the pair, the pair ends with both votes as
 * they stood.
 */
export async function runDebate(input: DebateInput, deps: DebateDeps): Promise<void> {
  const { emit, signal, bucket } = deps;
  const chat = guarded(deps.chat, deps.liveness ?? DEBATE_LIVENESS);
  // Models that went quiet anywhere in this debate; no stand-in is drawn from them.
  const stalled = new Set<string>();
  const { question, choices, pairs, mode } = input;
  const client = clientTag(input.runId);
  const noSkips = new AbortController().signal;

  async function debatePair(i: number) {
    const pair = pairs[i];
    const votes: Record<Speaker, string> = { persuader: pair.persuader.choice, persuadee: pair.persuadee.choice };
    const history: { speaker: Speaker; text: string; vote: string }[] = [];
    const skipped = deps.skipSignal?.(i) ?? noSkips;
    const pairSignal = AbortSignal.any([signal, skipped]);
    let skipReason: string | null = skipped.aborted ? "Skipped" : null;

    if (!skipReason) emit({ type: "pair_start", pair: i });

    for (let turn = 0; turn < MAX_TURNS && !skipReason && !signal.aborted; turn++) {
      const speaker: Speaker = turn % 2 === 0 ? "persuader" : "persuadee";
      const other: Speaker = speaker === "persuader" ? "persuadee" : "persuader";
      emit({ type: "turn_start", pair: i, turn, speaker });

      const messages = turnMessages({
        question,
        choices,
        mode,
        speaker,
        turn,
        maxTurns: MAX_TURNS,
        own: { original: pair[speaker].choice, current: votes[speaker], reasoning: pair[speaker].reasoning },
        opponent: { original: pair[other].choice, current: votes[other] },
        history,
      });
      const onToken = (token: string) => emit({ type: "turn_token", pair: i, turn, token });

      let text: string | null = null;
      let requestId: string | null = null;
      // First the debater's own model, then stand-ins from the bucket.
      const tried = new Set([pair.persuader.model, pair.persuadee.model]);
      for (let attempt = 0; attempt <= STAND_INS; attempt++) {
        const standIn = attempt > 0;
        if (standIn) emit({ type: "turn_standin", pair: i, turn, model: null });
        try {
          const result = await chat({
            model: standIn ? bucket : pair[speaker].model,
            exclude: standIn ? [...new Set([...tried, ...stalled])] : undefined,
            messages,
            temperature: 0.7,
            client,
            signal: pairSignal,
            onModel: standIn
              ? (model) => {
                  tried.add(model);
                  emit({ type: "turn_standin", pair: i, turn, model });
                }
              : undefined,
            onToken,
          });
          text = result.text;
          requestId = result.requestId;
        } catch (err) {
          requestId = requestIdOf(err);
          if (err instanceof StallError && err.model) stalled.add(err.model);
          // A stall that already produced a usable argument keeps it.
          if (err instanceof StallError && err.partial.trim().length >= 80) text = err.partial;
        }
        if (requestId) emit({ type: "request", id: requestId, phase: "debate" });
        if (text !== null || pairSignal.aborted) break;
      }
      if (signal.aborted) return;
      if (skipped.aborted) skipReason = "Skipped";
      else if (text === null) skipReason = "No model could take this turn in time";

      const parsed = parseTurn(text ?? "", votes[speaker], choices);
      votes[speaker] = parsed.vote;
      history.push({ speaker, text: parsed.text, vote: parsed.vote });
      emit({
        type: "turn_done",
        pair: i,
        turn,
        text: parsed.text || `(${skipReason ?? "no reply"})`,
        vote: parsed.vote,
        requestId,
      });

      if (votes.persuader === votes.persuadee) break;
    }
    if (signal.aborted) return;

    if (skipReason) emit({ type: "pair_skipped", pair: i, reason: skipReason });
    emit({
      type: "verdict",
      pair: i,
      persuader: { finalChoice: votes.persuader, flipped: votes.persuader !== pair.persuader.choice },
      persuadee: { finalChoice: votes.persuadee, flipped: votes.persuadee !== pair.persuadee.choice },
    });
  }

  let next = 0;
  const lane = async () => {
    while (next < pairs.length && !signal.aborted) await debatePair(next++);
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pairs.length) }, lane));
}
