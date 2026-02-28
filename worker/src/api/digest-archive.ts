import { withErrorHandler, addFreshnessHeaders } from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";

export const handleDigestArchive = withErrorHandler("digest-archive", async (db: D1Database): Promise<Response> => {
  const rows = await db.prepare(
    "SELECT digest_text, digest_title, generated_at, digest_extended, input_data FROM daily_digest ORDER BY generated_at DESC LIMIT 365"
  ).all<{ digest_text: string; digest_title: string | null; generated_at: number; digest_extended: string | null; input_data: string | null }>();

  const digests = (rows.results ?? []).map((r) => {
    let psiScore: number | null = null;
    let psiBand: string | null = null;
    let totalMcapUsd: number | null = null;
    if (r.input_data) {
      try {
        const input = JSON.parse(r.input_data) as {
          stabilityIndex?: { score: number; band: string } | null;
          totalMcapUsd?: number;
        };
        psiScore = input.stabilityIndex?.score ?? null;
        psiBand = input.stabilityIndex?.band ?? null;
        totalMcapUsd = input.totalMcapUsd ?? null;
      } catch { /* malformed input_data, skip */ }
    }
    return {
      digestText: r.digest_text,
      digestTitle: r.digest_title ?? null,
      digestExtended: r.digest_extended ?? null,
      generatedAt: r.generated_at,
      psiScore,
      psiBand,
      totalMcapUsd,
    };
  });

  const latestTs = digests.length > 0 ? digests[0].generatedAt : Math.floor(Date.now() / 1000);

  return new Response(JSON.stringify({ digests }), {
    headers: addFreshnessHeaders({
      "Content-Type": "application/json",
      "Cache-Control": CACHE_PROFILES.standard,
    }, latestTs, 86400),
  });
});
