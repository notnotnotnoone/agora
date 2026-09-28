import { parseTurn, turnMessages } from "../prompts";
import type { DebateEvent, DebateMode, DebatePair, Speaker } from "../types";
import { clientTag, FlexrouterError, type ChatFn } from "./flexrouter";

const CONCURRENCY = 4;
export const MAX_TURNS = 5;

export interface DebateInput {
  question: string;
  choices: string[];
  pairs: DebatePair[];
  mode: DebateMode;
  runId: string;
}

export interface DebateDeps {
  chat: ChatFn;
  emit: (event: DebateEvent) => void;
  signal: AbortSignal;
}

/**
 * Round 2. In each pair the majority voter and the minority voter take turns,
 * up to MAX_TURNS, each ending its turn with where it now stands. A pair ends
 * early once both hold the same vote. Each side is played by the same model
 * that cast that vote in round 1, so every turn is pinned to it.
 */
export async function runDebate(input: DebateInput, deps: DebateDeps): Promise<void> {
  const { chat, emit, signal } = deps;
  const { question, choices, pairs, mode } = input;
  const client = clientTag(input.runId);

  async function debatePair(i: number) {
    const pair = pairs[i];
    const votes: Record<Speaker, string> = { persuader: pair.persuader.choice, persuadee: pair.persuadee.choice };
    const history: { speaker: Speaker; text: string; vote: string }[] = [];
    emit({ type: "pair_start", pair: i });

    for (let turn = 0; turn < MAX_TURNS && !signal.aborted; turn++) {
      const speaker: Speaker = turn % 2 === 0 ? "persuader" : "persuadee";
      const other: Speaker = speaker === "persuader" ? "persuadee" : "persuader";
      emit({ type: "turn_start", pair: i, turn, speaker });

      let text = "";
      let requestId: string | null = null;
      let failed = false;
      try {
        const result = await chat({
          model: pair[speaker].model,
          messages: turnMessages({
            question,
            choices,
            mode,
            speaker,
            turn,
            maxTurns: MAX_TURNS,
            own: { original: pair[speaker].choice, current: votes[speaker], reasoning: pair[speaker].reasoning },
            opponent: { original: pair[other].choice, current: votes[other] },
            history,
          }),
          temperature: 0.7,
          client,
          signal,
          onToken: (token) => {
            text += token;
            emit({ type: "turn_token", pair: i, turn, token });
          },
        });
        text = result.text;
        requestId = result.requestId;
      } catch (err) {
        if (signal.aborted) return;
        failed = true;
        if (err instanceof FlexrouterError) requestId = err.requestId;
      }
      if (requestId) emit({ type: "request", id: requestId, phase: "debate" });

      const parsed = parseTurn(text, votes[speaker], choices);
      votes[speaker] = parsed.vote;
      history.push({ speaker, text: parsed.text, vote: parsed.vote });
      emit({
        type: "turn_done",
        pair: i,
        turn,
        text: parsed.text || "(no reply: the model failed)",
        vote: parsed.vote,
        requestId,
      });

      if (failed || votes.persuader === votes.persuadee) break;
    }

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
