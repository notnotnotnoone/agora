import { runDebate } from "@/lib/server/debate";
import { BUCKET, streamChat } from "@/lib/server/flexrouter";
import { closeSkips, openSkips } from "@/lib/server/skips";
import { badRequest, eventStream } from "@/lib/server/stream";
import { parseDebateBody } from "@/lib/server/validate";
import type { DebateEvent } from "@/lib/types";

export async function POST(request: Request) {
  const parsed = parseDebateBody(await request.json().catch(() => null));
  if (!parsed.ok) return badRequest(parsed.error);

  return eventStream<DebateEvent>(request, async (emit, signal) => {
    const skips = openSkips(parsed.value.runId, parsed.value.pairs.length);
    try {
      await runDebate(parsed.value, {
        chat: streamChat,
        bucket: BUCKET,
        emit,
        signal,
        skipSignal: (pair) => skips.signal(pair),
      });
    } finally {
      closeSkips(parsed.value.runId, skips);
    }
  });
}
