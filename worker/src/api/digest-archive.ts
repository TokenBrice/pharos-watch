import { withErrorHandler, addFreshnessHeaders } from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";

export const handleDigestArchive = withErrorHandler("digest-archive", async (db: D1Database): Promise<Response> => {
  const rows = await db.prepare(
    "SELECT digest_text, digest_title, generated_at, digest_extended FROM daily_digest ORDER BY generated_at DESC LIMIT 365"
  ).all<{ digest_text: string; digest_title: string | null; generated_at: number; digest_extended: string | null }>();

  const digests = (rows.results ?? []).map((r) => ({
    digestText: r.digest_text,
    digestTitle: r.digest_title ?? null,
    digestExtended: r.digest_extended ?? null,
    generatedAt: r.generated_at,
  }));

  const latestTs = digests.length > 0 ? digests[0].generatedAt : Math.floor(Date.now() / 1000);

  return new Response(JSON.stringify({ digests }), {
    headers: addFreshnessHeaders({
      "Content-Type": "application/json",
      "Cache-Control": CACHE_PROFILES.standard,
    }, latestTs, 86400),
  });
});
