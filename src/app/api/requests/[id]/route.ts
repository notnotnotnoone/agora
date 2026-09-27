import { getJourney } from "@/lib/server/flexrouter";
import { badRequest } from "@/lib/server/stream";
import { isRequestId } from "@/lib/server/validate";

export const dynamic = "force-dynamic";

/** One request's journey, straight from flexrouter (GET /api/requests/{id}). */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isRequestId(id)) return badRequest("not a flexrouter request id");
  try {
    const journey = await getJourney(id);
    if (!journey) return Response.json({ error: "flexrouter no longer has this request" }, { status: 404 });
    return Response.json(journey);
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}
