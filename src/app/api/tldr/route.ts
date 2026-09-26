import { listModels, streamChat } from "@/lib/flexrouter";
import { encodeSSE } from "@/lib/llm";
import type { ResponseEntry } from "@/lib/types";

export const dynamic = "force-dynamic";

// How many of the best-scoring models to try before giving up.
const MAX_SYNTHESIZERS = 3;
// Cap on responses quoted in the prompt, to keep it inside small context windows.
const MAX_QUOTED = 30;

const SYSTEM_PROMPT = `You summarize how a crowd of AI models voted on a moral dilemma.
Write a short plain-English TL;DR (under 150 words): which option won and by how much,
the main reasons behind the majority, and the strongest points the minority raised.
Do not add your own opinion on the dilemma.`;

function buildDigest(question: string, responses: ResponseEntry[], choices: string[]): string {
  const voted = responses.filter((r) => r.vote);
  const tally = choices
    .map((c) => `${c}: ${voted.filter((r) => r.vote === c).length}`)
    .join(", ");
  const quoted = voted.slice(0, MAX_QUOTED).map((r, i) => {
    const reasons = choices
      .filter((c) => r.optionReasons?.[c])
      .map((c) => `  - ${c}: ${r.optionReasons[c]}`)
      .join("\n");
    return `Response ${i + 1} (voted ${r.vote}):\n${reasons || `  ${r.reasoning}`}`;
  });
  return `Dilemma: ${question}\n\nVotes (${voted.length} total) — ${tally}\n\n${quoted.join("\n\n")}`;
}

export async function POST(req: Request) {
  const { question, responses, choices } = (await req.json()) as {
    question: string;
    responses: ResponseEntry[];
    choices: string[];
  };

  let candidates;
  try {
    candidates = (await listModels()).slice(0, MAX_SYNTHESIZERS);
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }

  const digest = buildDigest(question, responses, choices);
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: unknown) => {
        try {
          controller.enqueue(encoder.encode(encodeSSE(event)));
        } catch {}
      };

      // Pinned to one model at a time (best score first) so the UI can name
      // the synthesizer; moves on only if a model fails before writing anything.
      for (const model of candidates) {
        let started = false;
        try {
          await streamChat(
            model.id,
            [
              { role: "system", content: SYSTEM_PROMPT },
              { role: "user", content: digest },
            ],
            {
              temperature: 0.3,
              signal: req.signal,
              onToken: (token) => {
                if (!started) {
                  started = true;
                  send({ type: "meta", synthesizer: model.modelName });
                }
                send({ type: "token", token });
              },
            }
          );
          if (started) break;
        } catch {
          if (started || req.signal.aborted) break;
        }
      }

      try {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch {}
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
