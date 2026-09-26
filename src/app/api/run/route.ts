import { BUCKET, listModels, streamChat } from "@/lib/server/flexrouter";
import { runRound } from "@/lib/server/run";
import { badRequest, eventStream } from "@/lib/server/stream";
import { parseRunBody } from "@/lib/server/validate";
import type { RunEvent } from "@/lib/types";

export async function POST(request: Request) {
  const parsed = parseRunBody(await request.json().catch(() => null));
  if (!parsed.ok) return badRequest(parsed.error);

  return eventStream<RunEvent>(request, async (emit, signal) => {
    const models = await listModels(signal);
    if (models.length === 0) {
      throw new Error("flexrouter has no usable models. Add some to its config.yaml, or check `flexrouter doctor`.");
    }
    await runRound(parsed.value, { chat: streamChat, models, bucket: BUCKET, emit, signal });
  });
}
