import { withErrorHandler, addFreshnessHeaders, jsonResponse } from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";

const DAILY_FILTER = "digest_meta IS NULL OR json_extract(digest_meta, '$.type') IS NULL OR json_extract(digest_meta, '$.type') != 'weekly'";

export const handleDailyDigest = withErrorHandler("daily-digest", async (db: D1Database): Promise<Response> => {
  const [digestResult, countResult] = await db.batch([
    db.prepare(
      `SELECT digest_text, digest_title, generated_at, digest_extended FROM daily_digest WHERE ${DAILY_FILTER} ORDER BY generated_at DESC LIMIT 1`
    ),
    db.prepare(
      `SELECT COUNT(*) as cnt FROM daily_digest WHERE ${DAILY_FILTER}`
    ),
  ]);

  const row = digestResult.results?.[0] as { digest_text: string; digest_title: string | null; generated_at: number; digest_extended: string | null } | undefined;

  if (!row) {
    return jsonResponse({ digest: null }, { "Cache-Control": CACHE_PROFILES.standard });
  }

  const editionNumber = (countResult.results?.[0] as { cnt: number } | undefined)?.cnt ?? null;

  return jsonResponse({
    digest: row.digest_text,
    digestTitle: row.digest_title ?? null,
    digestExtended: row.digest_extended ?? null,
    generatedAt: row.generated_at,
    editionNumber,
  }, addFreshnessHeaders({
    "Cache-Control": CACHE_PROFILES.standard,
  }, row.generated_at, 7200));
});
