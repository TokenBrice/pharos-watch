import { withErrorHandler, isValidStablecoinId, addFreshnessHeaders } from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";

export const handleStressSignals = withErrorHandler(
  "stress-signals",
  async (db: D1Database, url: URL): Promise<Response> => {
    const stablecoinId = url.searchParams.get("stablecoin");
    const days = Math.min(
      365,
      Math.max(1, Number(url.searchParams.get("days")) || 30),
    );

    if (stablecoinId) {
      if (!isValidStablecoinId(stablecoinId)) {
        return new Response(JSON.stringify({ error: "Invalid stablecoin ID" }), {
          status: 400, headers: { "Content-Type": "application/json" },
        });
      }
      // Single coin: latest + daily history
      const latest = await db
        .prepare(
          `SELECT score, band, signals_json, computed_at
           FROM stress_signals
           WHERE stablecoin_id = ?
           ORDER BY computed_at DESC LIMIT 1`,
        )
        .bind(stablecoinId)
        .first<{
          score: number;
          band: string;
          signals_json: string;
          computed_at: number;
        }>();

      const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
      const history = await db
        .prepare(
          `SELECT snapshot_date, score, band, signals_json
           FROM stress_signal_history
           WHERE stablecoin_id = ? AND snapshot_date >= ?
           ORDER BY snapshot_date ASC`,
        )
        .bind(stablecoinId, cutoff)
        .all<{
          snapshot_date: number;
          score: number;
          band: string;
          signals_json: string;
        }>();

      const computedAt = latest?.computed_at ?? Math.floor(Date.now() / 1000);
      return new Response(
        JSON.stringify({
          current: latest
            ? {
                score: latest.score,
                band: latest.band,
                signals: JSON.parse(latest.signals_json),
                computedAt: latest.computed_at,
              }
            : null,
          history: history.results.map((r) => ({
            date: r.snapshot_date,
            score: r.score,
            band: r.band,
            signals: JSON.parse(r.signals_json),
          })),
        }),
        {
          headers: addFreshnessHeaders({
            "Content-Type": "application/json",
            "Cache-Control": CACHE_PROFILES.standard,
          }, computedAt, 900),
        },
      );
    }

    // All coins: latest only (subquery for most recent per coin)
    const rows = await db
      .prepare(
        `SELECT s.stablecoin_id, s.score, s.band, s.signals_json, s.computed_at
         FROM stress_signals s
         INNER JOIN (
           SELECT stablecoin_id, MAX(computed_at) as max_at
           FROM stress_signals GROUP BY stablecoin_id
         ) latest ON s.stablecoin_id = latest.stablecoin_id AND s.computed_at = latest.max_at`,
      )
      .all<{
        stablecoin_id: string;
        score: number;
        band: string;
        signals_json: string;
        computed_at: number;
      }>();

    const signals: Record<string, object> = {};
    let updatedAt = 0;
    for (const row of rows.results) {
      signals[row.stablecoin_id] = {
        score: row.score,
        band: row.band,
        signals: JSON.parse(row.signals_json),
        computedAt: row.computed_at,
      };
      updatedAt = Math.max(updatedAt, row.computed_at);
    }

    return new Response(JSON.stringify({ signals, updatedAt }), {
      headers: addFreshnessHeaders({
        "Content-Type": "application/json",
        "Cache-Control": CACHE_PROFILES.standard,
      }, updatedAt, 900),
    });
  },
);
