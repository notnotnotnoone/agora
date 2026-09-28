import { skipPair } from "@/lib/server/skips";
import { badRequest } from "@/lib/server/stream";
import { parseSkipBody } from "@/lib/server/validate";

/** Skips one pair, or every unfinished pair, of the debate streaming for a run. */
export async function POST(request: Request) {
  const parsed = parseSkipBody(await request.json().catch(() => null));
  if (!parsed.ok) return badRequest(parsed.error);
  const found = skipPair(parsed.value.runId, parsed.value.pair);
  return Response.json({ found }, { status: found ? 200 : 404 });
}
