import { getCache } from "../lib/db";
import { withErrorHandler } from "../lib/api-utils";

export const handleBluechipRatings = withErrorHandler("bluechip-ratings", async (db: D1Database): Promise<Response> => {
  const cached = await getCache(db, "bluechip-ratings");
  if (!cached) {
    return new Response(JSON.stringify(null), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=3600",
      },
    });
  }

  return new Response(cached.value, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600",
    },
  });
});
