import { withErrorHandler, addFreshnessHeaders } from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";

export const handleDailyDigest = withErrorHandler("daily-digest", async (db: D1Database): Promise<Response> => {
  const row = await db.prepare(
    "SELECT digest_text, digest_title, generated_at, digest_extended FROM daily_digest ORDER BY generated_at DESC LIMIT 1"
  ).first<{ digest_text: string; digest_title: string | null; generated_at: number; digest_extended: string | null }>();

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
    digestExtended: row.digest_extended ?? null,
    generatedAt: row.generated_at,
  }), {
    headers: addFreshnessHeaders({
      "Content-Type": "application/json",
      "Cache-Control": CACHE_PROFILES.standard,
    }, row.generated_at, 7200),
  });
});
