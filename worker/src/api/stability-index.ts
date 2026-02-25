import { withErrorHandler, addFreshnessHeaders } from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";

export const handleStabilityIndex = withErrorHandler("stability-index", async (db: D1Database): Promise<Response> => {
  const current = await db
    .prepare("SELECT computed_at, score, band, components FROM stability_index ORDER BY computed_at DESC LIMIT 1")
    .first<{ computed_at: number; score: number; band: string; components: string }>();

  const historyRows = await db
    .prepare("SELECT computed_at, score, band FROM stability_index ORDER BY computed_at DESC LIMIT 91")
    .all<{ computed_at: number; score: number; band: string }>();

  // First row is "current", rest is history
  const history = (historyRows.results ?? [])
    .slice(1)
    .map((r) => ({ date: r.computed_at, score: r.score, band: r.band }));

  if (!current) {
    return new Response(JSON.stringify({ current: null, history: [] }), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": CACHE_PROFILES.slow,
      },
    });
  }

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
