import { loadModels } from "@/lib/config-loader";
import { encodeSSE, parseAnswer, routeChat, splitThink, type ChatMessage } from "@/lib/llm";
import type { DebateEvent, DebatePair } from "@/lib/types";

export const dynamic = "force-dynamic";

const MAX_PAIRS = 20;

// Each turn gets its own budget so a whole pair always resolves in under ~30s.
// Slow models are raced against a backup early; a dead turn skips the pair.
const TURN_DEADLINE_MS = 13_000;
const HEDGE_AFTER_MS = 3_500;
const FIRST_TOKEN_TIMEOUT_MS = 6_000;
const IDLE_TIMEOUT_MS = 5_000;

type Turn = "persuader" | "persuadee";

function buildPersuaderSystem(pair: DebatePair, choices: string[]): string {
  return `You are in a one-on-one debate about an ethical dilemma. You voted "${pair.persuaderVote}". Your opponent voted "${pair.persuadeeVote}". Your goal is to get them to switch to "${pair.persuaderVote}".

Your own reasoning from the vote:
${pair.persuaderReasoning || "(not recorded)"}

Your opponent's reasoning:
${pair.persuadeeReasoning || "(not recorded)"}

How to argue well:
- Engage THEIR reasoning directly. Identify the consideration their vote rests on, then show why it fails, is outweighed, or actually supports "${pair.persuaderVote}".
- Lead with your single strongest point. Use a concrete example, analogy, or consequence rather than abstract principles.
- Acknowledge anything they got right — conceding a minor point makes the main point land harder.
- No preamble, no "great question", no restating the dilemma. Speak to them directly as "you".
- Plain text, no markdown or bullet lists. 90–150 words.

The options in this dilemma are: ${choices.join(", ")}.`;
}

function buildPersuadeeSystem(pair: DebatePair, argument: string, choices: string[]): string {
  const list = choices.map((c) => `"${c}"`).join(", ");
  return `You are in a one-on-one debate about an ethical dilemma. You voted "${pair.persuadeeVote}", with this reasoning:
${pair.persuadeeReasoning || "(not recorded)"}

Your opponent voted "${pair.persuaderVote}" and just made this argument to change your mind:
"""
${argument}
"""

Evaluate the argument on its merits, then give your final vote.
- Switch only if it exposes a real flaw in your reasoning or raises a consideration that genuinely outweighs yours. Being argued at is not itself a reason to switch — but neither is stubbornness a virtue. Updating on a good argument is a strength.
- Address their strongest point specifically; don't just repeat your original reasoning.
- If you switch, say plainly what changed your mind. If you hold, say plainly why their point doesn't carry.
- Plain text, no markdown. 60–120 words.

Format your reply EXACTLY as:
RESPONSE: <your reply to them>
ANSWER: <exactly one of: ${list}>`;
}

function parseArgument(text: string): string {
  const { content } = splitThink(text);
  return content.replace(/^\s*[*_]*\s*ARGUMENT\s*[*_]*\s*:\s*/i, "").trim();
}

function parsePersuadeeResponse(text: string, choices: string[]): { response: string; vote: string | null } {
  const { content } = splitThink(text);
  const vote = parseAnswer(content, choices);
  const response = content
    .replace(/^\s*[*_]*\s*RESPONSE\s*[*_]*\s*:\s*/i, "")
    .replace(/\n[^\n]*\bANSWER\b[^\n]*:[^\n]*$/i, "")
    .trim();
  return { response, vote };
}

export async function POST(req: Request) {
  const { question, choices, pairs: rawPairs } = (await req.json()) as {
    question: string;
    choices: string[];
    pairs: DebatePair[];
  };

  const pairs = rawPairs.slice(0, MAX_PAIRS);
  const models = loadModels();
  const encoder = new TextEncoder();
  const runCtrl = new AbortController();
  req.signal.addEventListener("abort", () => runCtrl.abort(), { once: true });
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: DebateEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(encodeSSE(event)));
        } catch {
          closed = true;
        }
      };

      /** Run one debate turn, rerouting to another model if the assigned one is slow or fails. */
      const runTurn = <T,>(
        pairIndex: number,
        turn: Turn,
        preferredId: string,
        system: string,
        accept: (text: string) => T | null
      ) => {
        const messages: ChatMessage[] = [
          { role: "system", content: system },
          { role: "user", content: `The dilemma:\n${question.trim()}` },
        ];
        return routeChat({
          models,
          preferred: [preferredId],
          messages,
          signal: runCtrl.signal,
          accept: ({ content }) => accept(content),
          hedgeAfterMs: HEDGE_AFTER_MS,
          deadlineMs: TURN_DEADLINE_MS,
          maxParallel: 3,
          maxAttempts: 5,
          stream: {
            firstTokenTimeoutMs: FIRST_TOKEN_TIMEOUT_MS,
            idleTimeoutMs: IDLE_TIMEOUT_MS,
            maxTokens: 1000,
            temperature: 0.7,
          },
          onCommit: (model) =>
            send({ type: "turn_model", pairIndex, turn, modelId: model.id, rerouted: model.id !== preferredId }),
          onToken: (token) => send({ type: "turn_token", pairIndex, turn, token }),
          onReset: () => send({ type: "turn_reset", pairIndex, turn }),
        });
      };

      const runPair = async (pair: DebatePair, pairIndex: number) => {
        if (closed) return;
        send({ type: "pair_start", pairIndex });

        const persuader = await runTurn(
          pairIndex,
          "persuader",
          pair.persuaderId,
          buildPersuaderSystem(pair, choices),
          (text) => {
            const arg = parseArgument(text);
            return arg.length >= 40 ? arg : null;
          }
        );
        if (closed) return;
        if (!persuader) {
          send({ type: "pair_skipped", pairIndex, reason: "No model could make the argument in time" });
          return;
        }
        const argument = persuader.value;
        send({ type: "turn_done", pairIndex, turn: "persuader", text: argument });

        const persuadee = await runTurn(
          pairIndex,
          "persuadee",
          pair.persuadeeId,
          buildPersuadeeSystem(pair, argument, choices),
          (text) => {
            const parsed = parsePersuadeeResponse(text, choices);
            return parsed.vote ? (parsed as { response: string; vote: string }) : null;
          }
        );
        if (closed) return;
        if (!persuadee) {
          send({ type: "pair_skipped", pairIndex, reason: "No model could respond in time" });
          return;
        }
        const { response, vote } = persuadee.value;
        send({ type: "turn_done", pairIndex, turn: "persuadee", text: response });

        const flipped = vote.toLowerCase() !== pair.persuadeeVote.toLowerCase();
        send({ type: "verdict", pairIndex, finalVote: vote, flipped });
      };

      await Promise.allSettled(pairs.map((pair, i) => runPair(pair, i)));

      if (!closed) {
        try {
          controller.enqueue(encoder.encode(encodeSSE({ type: "all_done" })));
          controller.close();
        } catch {}
        closed = true;
      }
    },
    cancel() {
      closed = true;
      runCtrl.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
