import { getCache } from "../lib/db";
import { withErrorHandler } from "../lib/api-utils";

export const handleUsdsStatus = withErrorHandler("usds-status", async (db: D1Database): Promise<Response> => {
  const cached = await getCache(db, "usds-status");
  if (!cached) {
    return new Response(JSON.stringify(null), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=300",
      },
    });
  }

  return new Response(cached.value, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=300",
    },
  });
});
