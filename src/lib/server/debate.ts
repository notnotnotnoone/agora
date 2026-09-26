import { parsePersuadee, persuadeeMessages, persuaderMessages } from "../prompts";
import type { DebateEvent, DebatePair } from "../types";
import { callRecord, FlexrouterError, type ChatFn } from "./flexrouter";

const CONCURRENCY = 4;

export interface DebateInput {
  question: string;
  choices: string[];
  pairs: DebatePair[];
}

export interface DebateDeps {
  chat: ChatFn;
  emit: (event: DebateEvent) => void;
  signal: AbortSignal;
}

/**
 * Round 2. In each pair the majority voter argues once, the minority voter
 * replies and votes again. Each side is played by the same model that cast
 * that vote in round 1.
 */
export async function runDebate(input: DebateInput, deps: DebateDeps): Promise<void> {
  const { chat, emit, signal } = deps;
  const { question, choices, pairs } = input;

  async function speak(pair: number, turn: "persuader" | "persuadee", model: string, messages: Parameters<ChatFn>[0]["messages"]) {
    let partial = "";
    try {
      const result = await chat({
        model,
        messages,
        temperature: 0.7,
        signal,
        onToken: (token) => {
          partial += token;
          emit({ type: "turn_token", pair, turn, token });
        },
      });
      emit({ type: "call", call: callRecord("debate", model, result) });
      return result.text;
    } catch (err) {
      if (err instanceof FlexrouterError) emit({ type: "call", call: callRecord("debate", model, err) });
      return partial;
    }
  }

  let next = 0;
  const lane = async () => {
    while (next < pairs.length && !signal.aborted) {
      const i = next++;
      const { persuader, persuadee } = pairs[i];
      emit({ type: "pair_start", pair: i });

      const argument = (
        await speak(i, "persuader", persuader.model, persuaderMessages(question, persuader, persuadee.choice))
      ).trim();
      emit({ type: "turn_done", pair: i, turn: "persuader", text: argument || "(no argument: the model failed)" });
      if (signal.aborted) return;

      const reply = await speak(
        i,
        "persuadee",
        persuadee.model,
        persuadeeMessages(question, persuadee, persuader.choice, argument, choices)
      );
      const { response, choice } = parsePersuadee(reply, choices);
      emit({ type: "turn_done", pair: i, turn: "persuadee", text: response || "(no reply: the model failed)" });

      const finalChoice = choice ?? persuadee.choice;
      emit({ type: "verdict", pair: i, finalChoice, flipped: finalChoice !== persuadee.choice });
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pairs.length) }, lane));
}
