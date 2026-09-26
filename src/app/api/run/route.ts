import { listModels, streamChat } from "@/lib/flexrouter";
import { encodeSSE } from "@/lib/llm";
import type { ModelConfig, RunEvent } from "@/lib/types";

export const dynamic = "force-dynamic";

function buildSystemPrompt(choices: string[]): string {
  const list = choices.join(", ");
  const optionLines = choices.map((c) => `OPTION [${c}]: <specific reason why you would or would not choose this option>`).join("\n");
  return `You are answering a moral dilemma question. Think through every available option carefully.

You MUST format your response EXACTLY as follows — one OPTION block per choice, then ANSWER:

${optionLines}
ANSWER: <one of: ${list}>

Rules:
- You MUST write an OPTION block for EVERY option listed above. Do not skip any.
- Each OPTION block must give a specific, concrete reason — not vague platitudes like "this seems right". Explain the actual moral reasoning for choosing or rejecting that option.
- The ANSWER line must contain exactly one of the listed options verbatim: ${list}.`;
}

function parseResponse(
  text: string,
  choices: string[]
): { vote: string | null; optionReasons: Record<string, string> } {
  const answerMatch = text.match(/ANSWER:[ \t]*(.+?)[\r\n]*$/im);
  const rawAnswer = answerMatch ? answerMatch[1].trim() : null;
  const vote = rawAnswer
    ? (choices.find((c) => c.toLowerCase() === rawAnswer.toLowerCase()) ?? null)
    : null;

  const optionReasons: Record<string, string> = {};
  for (const choice of choices) {
    const escaped = choice.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`OPTION\\s*\\[${escaped}\\]:\\s*([\\s\\S]*?)(?=\\nOPTION\\s*\\[|\\n+ANSWER:|(?:\\n|$))`, "i");
    const match = text.match(pattern);
    optionReasons[choice] = match ? match[1].trim() : "";
  }

  return { vote, optionReasons };
}

async function trySingleRequest(
  model: ModelConfig,
  question: string,
  choices: string[]
): Promise<{ vote: string; optionReasons: Record<string, string> } | null> {
  try {
    const fullText = await streamChat(
      model.id,
      [
        { role: "system", content: buildSystemPrompt(choices) },
        { role: "user", content: question },
      ],
      { temperature: 0.9 }
    );

    const { vote, optionReasons } = parseResponse(fullText, choices);
    if (!vote) return null;
    return { vote, optionReasons };
  } catch {
    // A pinned model that is busy or broken fails fast; the worker retries on the next one.
    return null;
  }
}

export async function POST(req: Request) {
  const { question, choices, targetCount } = (await req.json()) as {
    question: string;
    choices: string[];
    targetCount: number;
  };

  let models: ModelConfig[];
  try {
    models = await listModels();
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
  if (models.length === 0) {
    return Response.json({ error: "flexrouter has no usable models configured" }, { status: 503 });
  }

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
                reasoning: "",
                optionReasons: result.optionReasons,
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
