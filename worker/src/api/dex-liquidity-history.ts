import { withErrorHandler } from "../lib/api-utils";

export const handleDexLiquidityHistory = withErrorHandler("dex-liquidity-history", async (
  db: D1Database,
  url: URL
): Promise<Response> => {
  const stablecoinId = url.searchParams.get("stablecoin");
  if (!stablecoinId) {
    return new Response(
      JSON.stringify({ error: "Missing ?stablecoin= parameter" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const days = Math.min(365, Math.max(1, parseInt(url.searchParams.get("days") ?? "90", 10) || 90));
  const cutoff = Math.floor(Date.now() / 1000) - days * 86_400;

  const result = await db
    .prepare(
      `SELECT total_tvl_usd, total_volume_24h_usd, liquidity_score, snapshot_date
       FROM dex_liquidity_history
       WHERE stablecoin_id = ? AND snapshot_date >= ?
       ORDER BY snapshot_date ASC`
    )
    .bind(stablecoinId, cutoff)
    .all();

  const history = (result.results ?? []).map((row) => ({
    tvl: row.total_tvl_usd as number,
    volume24h: row.total_volume_24h_usd as number,
    score: row.liquidity_score as number | null,
    date: row.snapshot_date as number,
  }));

  return new Response(JSON.stringify(history), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, s-maxage=3600, max-age=300",
    },
  });
});
