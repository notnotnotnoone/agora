import { clientTag, listRequests } from "@/lib/server/flexrouter";
import { badRequest } from "@/lib/server/stream";
import { isRunId } from "@/lib/server/validate";

export const dynamic = "force-dynamic";

/** One run's rows from flexrouter's request log (GET /api/requests?client=agora-<run>). */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const run = params.get("run");
  const limit = Number(params.get("limit") ?? 50);
  if (!isRunId(run)) return badRequest("run must be a run id");
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) return badRequest("limit must be 1-1000");

  try {
    const page = await listRequests({ client: clientTag(run), limit });
    return Response.json(page);
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}
