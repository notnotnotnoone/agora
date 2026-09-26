import { listModels } from "@/lib/flexrouter";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json(await listModels());
  } catch (err) {
    console.error("Agora:", (err as Error).message);
    // The page expects an array; an empty list just shows no models.
    return Response.json([], { status: 502 });
  }
}
