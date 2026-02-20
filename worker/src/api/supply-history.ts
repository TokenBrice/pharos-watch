import { withErrorHandler } from "../lib/api-utils";

interface SupplyHistoryRow {
  snapshot_date: number;
  circulating_usd: number;
  price: number | null;
}

export const handleSupplyHistory = withErrorHandler("supply-history", async (
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
  // Validate ID format to prevent edge cache pollution
  if (!/^\d+$/.test(stablecoinId) && !/^(?:gold|silver|cg)-/.test(stablecoinId)) {
    return new Response(
      JSON.stringify({ error: "Invalid stablecoin ID" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const days = Math.min(1825, Math.max(1, parseInt(url.searchParams.get("days") ?? "365", 10) || 365));
  const cutoff = Math.floor(Date.now() / 1000) - days * 86_400;

  const result = await db
    .prepare(
      `SELECT snapshot_date, circulating_usd, price
       FROM supply_history
       WHERE stablecoin_id = ? AND snapshot_date >= ?
       ORDER BY snapshot_date ASC`
    )
    .bind(stablecoinId, cutoff)
    .all<SupplyHistoryRow>();

  const history = (result.results ?? []).map((row) => ({
    date: row.snapshot_date,
    circulatingUsd: row.circulating_usd,
    price: row.price,
  }));

  return new Response(JSON.stringify(history), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, s-maxage=3600, max-age=300",
    },
  });
});
