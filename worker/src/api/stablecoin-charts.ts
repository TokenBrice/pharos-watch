import { getCache } from "../lib/db";
import { withErrorHandler } from "../lib/api-utils";

export const handleStablecoinCharts = withErrorHandler("stablecoin-charts", async (db: D1Database): Promise<Response> => {
  const cached = await getCache(db, "stablecoin-charts");
  if (!cached) {
    return new Response(JSON.stringify({ error: "Data not yet available" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(cached.value, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, s-maxage=300, max-age=60",
    },
  });
});
