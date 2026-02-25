import { withErrorHandler, addFreshnessHeaders } from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";

export const handleStabilityIndex = withErrorHandler("stability-index", async (db: D1Database, url: URL): Promise<Response> => {
  const detail = url.searchParams.get("detail") === "true";

  const query = detail
    ? "SELECT computed_at, score, band, components FROM stability_index ORDER BY computed_at DESC"
    : "SELECT computed_at, score, band, components FROM stability_index ORDER BY computed_at DESC LIMIT 91";

  const rows = await db
    .prepare(query)
    .all<{ computed_at: number; score: number; band: string; components: string }>();
  const results = rows.results ?? [];

  if (results.length === 0) {
    return new Response(JSON.stringify({ current: null, history: [] }), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": CACHE_PROFILES.slow,
      },
    });
  }

  const current = results[0];
  const history = results.slice(1).map((r) => detail
    ? { date: r.computed_at, score: r.score, band: r.band, components: JSON.parse(r.components) }
    : { date: r.computed_at, score: r.score, band: r.band }
  );

  return new Response(JSON.stringify({
    current: {
      score: current.score,
      band: current.band,
      components: JSON.parse(current.components),
      computedAt: current.computed_at,
    },
    history,
  }), {
    headers: addFreshnessHeaders({
      "Content-Type": "application/json",
      "Cache-Control": CACHE_PROFILES.slow,
    }, current.computed_at, 86400),
  });
});
