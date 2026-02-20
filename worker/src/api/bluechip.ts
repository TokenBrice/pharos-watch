import { getCache } from "../lib/db";
import { withErrorHandler, addFreshnessHeaders } from "../lib/api-utils";

export const handleBluechipRatings = withErrorHandler("bluechip-ratings", async (db: D1Database): Promise<Response> => {
  const cached = await getCache(db, "bluechip-ratings");
  if (!cached) {
    return new Response(JSON.stringify({ error: "Data not yet available" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(cached.value, {
    headers: addFreshnessHeaders({
      "Content-Type": "application/json",
      "Cache-Control": "public, s-maxage=3600, max-age=300",
    }, cached.updatedAt, 43200),
  });
});
