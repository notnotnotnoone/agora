import { runDebate } from "@/lib/server/debate";
import { streamChat } from "@/lib/server/flexrouter";
import { badRequest, eventStream } from "@/lib/server/stream";
import { parseDebateBody } from "@/lib/server/validate";
import type { DebateEvent } from "@/lib/types";

export async function POST(request: Request) {
  const parsed = parseDebateBody(await request.json().catch(() => null));
  if (!parsed.ok) return badRequest(parsed.error);

  return eventStream<DebateEvent>(request, (emit, signal) =>
    runDebate(parsed.value, { chat: streamChat, emit, signal })
  );
}
