import { loadModels } from "@/lib/config-loader";
import type { ModelConfig, RunEvent } from "@/lib/types";

export const dynamic = "force-dynamic";

function buildSystemPrompt(choices: string[]): string {
  const list = choices.join(", ");
  return `You are answering a moral dilemma question. Think through the situation carefully and reason as thoroughly as needed.

You MUST format your response EXACTLY as:
REASONING: <your full reasoning, any length>
ANSWER: <one of: ${list}>

You MUST pick exactly one of the following options: ${list}. Any other answer is invalid.
The ANSWER line must contain exactly one of the listed options verbatim.`;
}

function buildHeaders(model: ModelConfig): Record<string, string> {
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

function parseResponse(
  text: string,
  choices: string[]
): { vote: string | null; reasoning: string } {
  const answerMatch = text.match(/ANSWER:\s*(.+?)[\r\n]*$/im);
  const rawAnswer = answerMatch ? answerMatch[1].trim() : null;
  const vote = rawAnswer
    ? (choices.find((c) => c.toLowerCase() === rawAnswer.toLowerCase()) ?? null)
    : null;
  const reasoningMatch = text.match(/REASONING:\s*([\s\S]*?)(?=\nANSWER:|$)/i);
  const reasoning = reasoningMatch ? reasoningMatch[1].trim() : text.trim();
  return { vote, reasoning };
}

function encodeSSE(event: RunEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

async function trySingleRequest(
  model: ModelConfig,
  question: string,
  choices: string[]
): Promise<{ vote: string; reasoning: string } | null> {
  try {
    const res = await fetch(`${model.baseUrl}/chat/completions`, {
      method: "POST",
      headers: buildHeaders(model),
      body: JSON.stringify({
        model: model.modelName,
        messages: [
          { role: "system", content: buildSystemPrompt(choices) },
          { role: "user", content: question },
        ],
        stream: true,
        temperature: 0.9,
      }),
    });

    if (!res.ok || !res.body) return null;

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
          if (token) fullText += token;
        } catch {
          // skip malformed lines
        }
      }
    }

    const { vote, reasoning } = parseResponse(fullText, choices);
    if (!vote) return null;
    return { vote, reasoning };
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  const { question, choices, targetCount } = (await req.json()) as {
    question: string;
    choices: string[];
    targetCount: number;
  };

  const models = loadModels();
  const MAX_RETRIES = 3;
  const CONCURRENCY = Math.min(models.length, 5, targetCount);
  const MAX_TOTAL_ATTEMPTS = targetCount * MAX_RETRIES * 3;

  let validCount = 0;
  let modelRobin = 0;
  let slotSeq = 0;
  let totalAttempts = 0;
  let closed = false;

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: RunEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(encodeSSE(event)));
        } catch {
          closed = true;
        }
      };

      const finish = () => {
        if (closed) return;
        closed = true;
        try {
          controller.enqueue(encoder.encode(encodeSSE({ type: "all_done" })));
          controller.close();
        } catch {}
      };

      async function worker() {
        while (!closed) {
          if (totalAttempts >= MAX_TOTAL_ATTEMPTS) {
            console.error("Agora: exhausted global attempt budget");
            return;
          }

          const mySlot = slotSeq++;
          let succeeded = false;

          for (let retry = 0; retry < MAX_RETRIES; retry++) {
            if (closed) return;
            totalAttempts++;
            const model = models[modelRobin++ % models.length];
            const result = await trySingleRequest(model, question, choices);

            if (result !== null) {
              validCount++;
              send({ type: "response_start", modelId: model.id, requestIndex: mySlot });
              send({
                type: "response_done",
                modelId: model.id,
                requestIndex: mySlot,
                vote: result.vote,
                reasoning: result.reasoning,
              });
              if (validCount >= targetCount) finish();
              succeeded = true;
              break;
            }
          }

          if (!succeeded) {
            console.log(`Agora: slot ${mySlot} exhausted ${MAX_RETRIES} retries`);
          }
        }
      }

      const workers = Array.from({ length: CONCURRENCY }, () => worker());
      await Promise.allSettled(workers);
      finish();
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
