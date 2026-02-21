import { withErrorHandler } from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";

export const handleDigestArchive = withErrorHandler("digest-archive", async (db: D1Database): Promise<Response> => {
  const rows = await db.prepare(
    "SELECT digest_text, generated_at FROM daily_digest ORDER BY generated_at DESC"
  ).all<{ digest_text: string; generated_at: number }>();

  const digests = (rows.results ?? []).map((r) => ({
    digestText: r.digest_text,
    generatedAt: r.generated_at,
  }));

  return new Response(JSON.stringify({ digests }), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": CACHE_PROFILES.slow,
    },
  });
});
