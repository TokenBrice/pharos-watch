import { withErrorHandler, addFreshnessHeaders, jsonResponse } from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";

export const handleDailyDigest = withErrorHandler("daily-digest", async (db: D1Database): Promise<Response> => {
  const row = await db.prepare(
    "SELECT digest_text, digest_title, generated_at, digest_extended FROM daily_digest WHERE digest_meta IS NULL OR json_extract(digest_meta, '$.type') IS NULL OR json_extract(digest_meta, '$.type') != 'weekly' ORDER BY generated_at DESC LIMIT 1"
  ).first<{ digest_text: string; digest_title: string | null; generated_at: number; digest_extended: string | null }>();

  if (!row) {
    return jsonResponse({ digest: null }, { "Cache-Control": CACHE_PROFILES.standard });
  }

  return jsonResponse({
    digest: row.digest_text,
    digestTitle: row.digest_title ?? null,
    digestExtended: row.digest_extended ?? null,
    generatedAt: row.generated_at,
  }, addFreshnessHeaders({
    "Cache-Control": CACHE_PROFILES.standard,
  }, row.generated_at, 7200));
});
