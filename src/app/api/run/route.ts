import { loadModels } from "@/lib/config-loader";
import { encodeSSE, escapeRegExp, parseAnswer, routeChat, splitThink, type ChatMessage } from "@/lib/llm";
import type { RunEvent } from "@/lib/types";

export const dynamic = "force-dynamic";

// Latency budget. The whole round must finish comfortably inside 30s, so every
// request is hedged early and the run wraps up with whatever it has at the deadline.
const RUN_DEADLINE_MS = 24_000; // whole round
const SLOT_DEADLINE_MS = 15_000; // one vote, across all reroutes
const HEDGE_AFTER_MS = 4_500; // race a second model if the first is slow
const FIRST_TOKEN_TIMEOUT_MS = 7_000;
const IDLE_TIMEOUT_MS = 5_000;
const MAX_CONCURRENCY = 12;

function buildSystemPrompt(choices: string[]): string {
  const list = choices.map((c) => `"${c}"`).join(", ");
  const optionLines = choices.map((c) => `OPTION [${c}]: <why you accept or reject "${c}">`).join("\n");
  return `You are one of many AI models being polled independently on an ethical dilemma. Your vote is tallied into a live public consensus, so what matters is YOUR honest judgment — not what you think the expected or safe answer is.

How to think about it:
- Treat it as a thought experiment. Accept the scenario's stipulations as true; don't escape by inventing extra options, loopholes, or missing facts.
- Weigh what is actually at stake for each option: lives and harms, consent, rights, duties, intentions vs. side effects, fairness, and long-term consequences.
- You must commit to exactly one of the options: ${list}. Refusing, abstaining, or answering "it depends" is not allowed.

Reply in plain text (no markdown, no headings) using EXACTLY this format — one OPTION line per option, in this order, then the ANSWER line last:

${optionLines}
ANSWER: <exactly one of: ${list}>

Rules for the OPTION lines:
- 1–3 sentences each. Name the specific moral consideration that decides it (e.g. "actively causing a death is different from allowing one", "five lives outweigh one"). No filler like "this is a difficult question" or "both options have merit".
- The option you pick should state why it wins; each rejected option should state its decisive flaw.
- Your OPTION lines and your ANSWER must agree.

The ANSWER line must be the option text verbatim and nothing else.`;
}

function buildUserMessage(question: string, choices: string[]): string {
  return `${question.trim()}\n\nOptions: ${choices.join(" / ")}`;
}

function parseOptionReasons(text: string, choices: string[]): Record<string, string> {
  const optionReasons: Record<string, string> = {};
  for (const choice of choices) {
    const pattern = new RegExp(
      `OPTION\\s*\\[?\\s*${escapeRegExp(choice)}\\s*\\]?\\s*[:\\-–—]\\s*([\\s\\S]*?)(?=\\n\\s*[*_]*\\s*(?:OPTION\\s*\\[|OPTION\\s|(?:FINAL\\s+)?ANSWER\\s*[*_]*:)|$)`,
      "i"
    );
    const match = text.match(pattern);
    optionReasons[choice] = match ? match[1].replace(/[*_]{2,}/g, "").trim() : "";
  }
  return optionReasons;
}

function parseResponse(content: string, providerReasoning: string, choices: string[]) {
  const { content: reply, think } = splitThink(content);
  const vote = parseAnswer(reply, choices);
  if (!vote) return null;
  const optionReasons = parseOptionReasons(reply, choices);
  // Require at least the chosen option to be explained; otherwise the card is empty.
  if (!optionReasons[vote]) return null;
  // Compact summary used as the model's stance in Round 2 debates.
  const reasoning = [vote, ...choices.filter((c) => c !== vote)]
    .filter((c) => optionReasons[c])
    .map((c) => `${c === vote ? "Chose" : "Rejected"} ${c}: ${optionReasons[c]}`)
    .join("\n");
  return {
    vote,
    optionReasons,
    reasoning,
    rawText: reply,
    thinking: [providerReasoning.trim(), think].filter(Boolean).join("\n\n"),
  };
}

export async function POST(req: Request) {
  const { question, choices, targetCount } = (await req.json()) as {
    question: string;
    choices: string[];
    targetCount: number;
  };

  const models = loadModels();
  const target = Math.max(1, Math.floor(targetCount));
  const concurrency = Math.min(target, MAX_CONCURRENCY);
  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(choices) },
    { role: "user", content: buildUserMessage(question, choices) },
  ];

  const runStart = Date.now();
  const runCtrl = new AbortController();
  req.signal.addEventListener("abort", () => runCtrl.abort(), { once: true });

  let validCount = 0;
  let inFlight = 0;
  let slotSeq = 0;
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
        runCtrl.abort();
        clearTimeout(deadline);
        try {
          controller.enqueue(encoder.encode(encodeSSE({ type: "all_done" })));
          controller.close();
        } catch {}
      };

      // Hard stop: never leave the user staring at a spinner.
      const deadline = setTimeout(() => {
        console.warn(`Agora: run deadline hit with ${validCount}/${target} votes`);
        finish();
      }, RUN_DEADLINE_MS);

      if (models.length === 0) return finish();

      async function worker() {
        while (!closed && validCount + inFlight < target) {
          const remaining = RUN_DEADLINE_MS - (Date.now() - runStart);
          if (remaining < 2_000) return;
          inFlight++;
          const slotStart = Date.now();
          const result = await routeChat({
            models,
            messages,
            signal: runCtrl.signal,
            accept: ({ content, reasoning }) => parseResponse(content, reasoning, choices),
            hedgeAfterMs: HEDGE_AFTER_MS,
            deadlineMs: Math.min(SLOT_DEADLINE_MS, remaining),
            maxParallel: 3,
            maxAttempts: 6,
            stream: {
              firstTokenTimeoutMs: FIRST_TOKEN_TIMEOUT_MS,
              idleTimeoutMs: IDLE_TIMEOUT_MS,
              maxTokens: 1500,
              temperature: 0.8,
            },
          });
          inFlight--;
          if (closed) return;
          if (!result) {
            // Every route failed — brief pause so a dead provider doesn't hot-loop.
            await new Promise((r) => setTimeout(r, 400));
            continue;
          }

          const slot = slotSeq++;
          validCount++;
          const { value, model } = result;
          send({ type: "response_start", modelId: model.id, requestIndex: slot });
          send({
            type: "response_done",
            modelId: model.id,
            requestIndex: slot,
            vote: value.vote,
            reasoning: value.reasoning,
            optionReasons: value.optionReasons,
            rawText: value.rawText,
            thinking: value.thinking,
            latencyMs: Date.now() - slotStart,
          });
          if (validCount >= target) finish();
        }
      }

      await Promise.allSettled(Array.from({ length: concurrency }, () => worker()));
      finish();
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
