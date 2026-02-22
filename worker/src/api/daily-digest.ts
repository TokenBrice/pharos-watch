import { withErrorHandler, addFreshnessHeaders } from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";

export const handleDailyDigest = withErrorHandler("daily-digest", async (db: D1Database): Promise<Response> => {
  const row = await db.prepare(
    "SELECT digest_text, digest_title, generated_at FROM daily_digest ORDER BY generated_at DESC LIMIT 1"
  ).first<{ digest_text: string; digest_title: string | null; generated_at: number }>();

  if (!row) {
    return new Response(JSON.stringify({ digest: null }), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": CACHE_PROFILES.standard,
      },
    });
  }

  return new Response(JSON.stringify({
    digest: row.digest_text,
    digestTitle: row.digest_title ?? null,
    generatedAt: row.generated_at,
  }), {
    headers: addFreshnessHeaders({
      "Content-Type": "application/json",
      "Cache-Control": CACHE_PROFILES.slow,
    }, row.generated_at, 7200),
  });
});
