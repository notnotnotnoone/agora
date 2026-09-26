import { DASHBOARD_URL, getRoster, getSpend } from "@/lib/server/flexrouter";
import type { FlexrouterSnapshot } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Live roster and spend for the routing panel; polled by the page. */
export async function GET() {
  try {
    const [models, spentUsd] = await Promise.all([getRoster(), getSpend()]);
    return Response.json({ connected: true, dashboardUrl: DASHBOARD_URL, models, spentUsd } satisfies FlexrouterSnapshot);
  } catch (err) {
    return Response.json({
      connected: false,
      error: err instanceof Error ? err.message : String(err),
      dashboardUrl: DASHBOARD_URL,
      models: [],
      spentUsd: 0,
    } satisfies FlexrouterSnapshot);
  }
}
