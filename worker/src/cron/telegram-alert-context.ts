import { formatCompactUsdShort } from "@shared/lib/format";
import { getCirculatingRaw } from "@shared/lib/supply";
import { buildReportCardsSnapshot } from "../lib/report-cards-snapshot";
import { DEX_LIQUIDITY_PUBLISHED_ROW_FILTER } from "../lib/dex-liquidity";
import { loadStablecoinsCache } from "../lib/stablecoins-cache";
import { buildInClause, chunkArray } from "../lib/db";
import { toErrorMessage } from "../lib/error-utils";
import { logTelegramEvent } from "../lib/telegram-log";

function formatUsdCompact(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "n/a";
  return formatCompactUsdShort(value);
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
  const uniqueIds = Array.from(new Set(stablecoinIds));
  if (uniqueIds.length === 0) return new Map();
  const rows: Array<{ stablecoin_id: string; liquidity_score: number | null; total_tvl_usd: number }> = [];
  for (const idChunk of chunkArray(uniqueIds)) {
    const inClause = buildInClause(idChunk);
    try {
      const result = await db
        .prepare(
          `SELECT stablecoin_id, liquidity_score, total_tvl_usd
           FROM dex_liquidity
           WHERE stablecoin_id IN (${inClause.sql})
             AND ${DEX_LIQUIDITY_PUBLISHED_ROW_FILTER}`,
        )
        .bind(...inClause.binds)
        .all<{ stablecoin_id: string; liquidity_score: number | null; total_tvl_usd: number }>();
      rows.push(...(result.results ?? []));
    } catch (error) {
      logTelegramEvent({
        level: "warn",
        message: "Failed to load Telegram alert liquidity context",
        action: "alert-context-liquidity",
        module: "telegram-alert-context",
        requestedStablecoinCount: uniqueIds.length,
        chunkSize: idChunk.length,
        err: toErrorMessage(error),
      });
    }
  }

  return new Map(rows.map((row) => [
    row.stablecoin_id,
    { score: row.liquidity_score, tvl: row.total_tvl_usd },
  ]));
}
