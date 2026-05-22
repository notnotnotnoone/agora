import { loadModels } from "@/lib/config-loader";
import { buildHeaders, encodeSSE } from "@/lib/llm";
import type { ModelConfig, DebateEvent, DebatePair } from "@/lib/types";

export const dynamic = "force-dynamic";

const MAX_PAIRS = 20;

function buildPersuaderSystem(persuaderVote: string, persuadeeVote: string): string {
  return `You argued for ${persuaderVote} on this moral dilemma. Your opponent chose ${persuadeeVote}.
Make your strongest case to change their mind. Be direct, use concrete reasoning, keep it under 200 words.
You MUST format your response as:
ARGUMENT: <your persuasion, under 200 words>`;
}

function buildPersuadeeSystem(
  persuadeeVote: string,
  persuaderVote: string,
  persuadeeReasoning: string,
  persuaderArgument: string,
  choices: string[]
): string {
  return `You originally chose ${persuadeeVote} on this moral dilemma, with this reasoning:
${persuadeeReasoning}

Your opponent argues for ${persuaderVote}:
${persuaderArgument}

Respond to their argument honestly. Only change your vote if you find the argument genuinely compelling — don't flip just to be polite, but don't be stubborn either.
You MUST format your response EXACTLY as:
RESPONSE: <your reply to their argument>
ANSWER: <one of: ${choices.join(", ")}>`;
}

function parseArgument(text: string): string {
  const match = text.match(/ARGUMENT:\s*([\s\S]*?)$/im);
  return match ? match[1].trim() : text.trim();
}

function parsePersuadeeResponse(
  text: string,
  choices: string[]
): { response: string; vote: string | null } {
  const responseMatch = text.match(/RESPONSE:\s*([\s\S]*?)(?=\nANSWER:|$)/im);
  const answerMatch = text.match(/ANSWER:\s*(.+?)[\r\n]*$/im);
  const response = responseMatch ? responseMatch[1].trim() : text.trim();
  const rawAnswer = answerMatch ? answerMatch[1].trim() : null;
  const vote = rawAnswer
    ? (choices.find((c) => c.toLowerCase() === rawAnswer.toLowerCase()) ?? null)
    : null;
  return { response, vote };
}

async function streamLLMCall(
  model: ModelConfig,
  systemPrompt: string,
  userMessage: string,
  onToken: (token: string) => void
): Promise<string> {
  try {
    const res = await fetch(`${model.baseUrl}/chat/completions`, {
      method: "POST",
      headers: buildHeaders(model),
      body: JSON.stringify({
        model: model.modelName,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        stream: true,
        temperature: 0.9,
      }),
    });

    if (!res.ok || !res.body) return "";

    let fullText = "";
    const reader = res.body.getReader();
    const dec = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = dec.decode(value, { stream: true });
      for (const line of chunk.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const jsonStr = trimmed.slice(5).trim();
        if (jsonStr === "[DONE]") break;
        try {
          const parsed = JSON.parse(jsonStr);
          const token: string = parsed?.choices?.[0]?.delta?.content ?? "";
          if (token) {
            fullText += token;
            onToken(token);
          }
        } catch {
          // skip malformed lines
        }
      }
    }

    return fullText;
  } catch {
    return "";
  }
}

function findModel(models: ModelConfig[], id: string): ModelConfig {
  return models.find((m) => m.id === id) ?? models[0];
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

      const runPair = async (pair: DebatePair, pairIndex: number) => {
        if (closed) return;
        send({ type: "pair_start", pairIndex });

        const persuaderModel = findModel(models, pair.persuaderId);
        const persuaderSystem = buildPersuaderSystem(pair.persuaderVote, pair.persuadeeVote);
        const persuaderFull = await streamLLMCall(
          persuaderModel,
          persuaderSystem,
          question,
          (token) => send({ type: "turn_token", pairIndex, turn: "persuader", token })
        );
        const argument = parseArgument(persuaderFull);
        send({ type: "turn_done", pairIndex, turn: "persuader", text: argument });

        if (closed) return;

        const persuadeeModel = findModel(models, pair.persuadeeId);
        const persuadeeSystem = buildPersuadeeSystem(
          pair.persuadeeVote,
          pair.persuaderVote,
          pair.persuadeeReasoning,
          argument,
          choices
        );
        const persuadeeFull = await streamLLMCall(
          persuadeeModel,
          persuadeeSystem,
          question,
          (token) => send({ type: "turn_token", pairIndex, turn: "persuadee", token })
        );
        const { response, vote } = parsePersuadeeResponse(persuadeeFull, choices);
        send({ type: "turn_done", pairIndex, turn: "persuadee", text: response });

        const finalVote = vote ?? pair.persuadeeVote;
        const flipped = finalVote.toLowerCase() !== pair.persuadeeVote.toLowerCase();
        send({ type: "verdict", pairIndex, finalVote, flipped });
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
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
