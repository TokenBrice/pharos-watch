import { getCirculatingRaw } from "@shared/lib/supply";
import { buildReportCardsSnapshot } from "../lib/report-cards-snapshot";
import { DEX_LIQUIDITY_PUBLISHED_ROW_FILTER } from "../lib/dex-liquidity";
import { loadStablecoinsCache } from "../lib/stablecoins-cache";

function formatUsdCompact(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "n/a";
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
}

export async function buildAlertContextLines(
  db: D1Database,
  stablecoinIds: readonly string[],
): Promise<Map<string, string>> {
  const uniqueIds = Array.from(new Set(stablecoinIds));
  if (uniqueIds.length === 0) return new Map();

  const [snapshot, stablecoinsResult, liquidityResult] = await Promise.all([
    buildReportCardsSnapshot(db).catch(() => null),
    loadStablecoinsCache(db, { mode: "strict", allowLegacyArray: true }).catch(() => null),
    loadLiquidityRows(db, uniqueIds),
  ]);

  const cards = new Map((snapshot?.cards ?? []).map((card) => [card.id, card]));
  const supplies = new Map<string, number>();
  if (stablecoinsResult?.kind === "ok") {
    const wantedIds = new Set(uniqueIds);
    for (const asset of stablecoinsResult.payload.peggedAssets) {
      if (wantedIds.has(asset.id)) {
        supplies.set(asset.id, getCirculatingRaw(asset));
      }
    }
  }

  const out = new Map<string, string>();
  for (const id of uniqueIds) {
    const parts: string[] = [];
    const card = cards.get(id);
    const liq = liquidityResult.get(id);
    if (card) parts.push(`Safety ${card.overallGrade}${card.overallScore != null ? ` ${card.overallScore}` : ""}`);
    if (liq) parts.push(`Liquidity ${liq.score ?? "NR"}, DEX TVL ${formatUsdCompact(liq.tvl)}`);
    const supply = supplies.get(id);
    if (supply != null) parts.push(`Supply ${formatUsdCompact(supply)}`);
    if (parts.length > 0) out.set(id, `Context: ${parts.join(" · ")}`);
  }

  return out;
}

async function loadLiquidityRows(
  db: D1Database,
  stablecoinIds: readonly string[],
): Promise<Map<string, { score: number | null; tvl: number }>> {
  if (stablecoinIds.length === 0) return new Map();
  const placeholders = stablecoinIds.map(() => "?").join(",");
  const result = await db
    .prepare(
      `SELECT stablecoin_id, liquidity_score, total_tvl_usd
       FROM dex_liquidity
       WHERE stablecoin_id IN (${placeholders})
         AND ${DEX_LIQUIDITY_PUBLISHED_ROW_FILTER}`,
    )
    .bind(...stablecoinIds)
    .all<{ stablecoin_id: string; liquidity_score: number | null; total_tvl_usd: number }>()
    .catch(() => ({ results: [] }));

  return new Map((result.results ?? []).map((row) => [
    row.stablecoin_id,
    { score: row.liquidity_score, tvl: row.total_tvl_usd },
  ]));
}
