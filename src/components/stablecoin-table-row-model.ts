import { getStablecoinTableRowRiskLevel } from "@/components/stablecoin-table-logic";
import type { StablecoinTableRowVariant } from "@/components/stablecoin-table-row-types";
import type { V9SafetyTableRow } from "@/lib/safety-score-v9-consumers";
import { getResolvedBlacklistStatus } from "@/lib/blacklist-status";
import { resolveMintAuthorityScoreDisplay, resolveMintAuthorityStatus } from "@/lib/mint-authority-display";
import { deviationColorClass } from "@/lib/severity-colors";
import { formatNativePrice } from "@shared/lib/format";
import { CLIENT_TRACKED_META_BY_ID as TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import { getCirculatingRaw, getPrevDayRaw, getPrevWeekRaw } from "@shared/lib/supply";
import { getVariantAccessibleLabel, getVariantDisplay } from "@shared/lib/variant-display";
import type { DexLiquidityMap, PegSummaryCoin, StablecoinData } from "@shared/types";
import type { TableDensity } from "@/hooks/use-table-density";

export function buildStablecoinTableRowModel({
  coin,
  pegScores,
  dexLiquidity,
  reportCards,
  density,
  variant,
}: {
  coin: StablecoinData;
  pegScores?: Map<string, PegSummaryCoin>;
  dexLiquidity?: DexLiquidityMap;
  reportCards?: Record<string, V9SafetyTableRow>;
  density: TableDensity;
  variant: StablecoinTableRowVariant;
}) {
  const circulating = getCirculatingRaw(coin);
  const prevDay = getPrevDayRaw(coin);
  const prevWeek = getPrevWeekRaw(coin);
  const meta = TRACKED_META_BY_ID.get(coin.id);
  const pegSummary = pegScores?.get(coin.id);
  const pegScore = pegSummary?.pegScore ?? null;
  const liquidityScore = dexLiquidity?.[coin.id]?.liquidityScore ?? null;
  const pegRef = pegSummary?.pegReference?.valueUsd ?? null;
  const currentDeviationBps = pegSummary?.pegReferenceUnavailable === true
    ? null
    : pegSummary?.currentDeviationBps ?? null;
  const absPegDeviationBps = currentDeviationBps == null ? null : Math.abs(currentDeviationBps);
  const riskLevel = getStablecoinTableRowRiskLevel(coin, pegScores, reportCards);
  const isOverview = variant === "figmaOverview";

  return {
    circulating,
    prevDay,
    prevWeek,
    meta,
    reportCard: reportCards?.[coin.id],
    pegScore,
    liquidityScore,
    variantDisplay: meta?.variantKind ? getVariantDisplay(meta.variantKind) : null,
    variantContext: meta?.variantKind ? getVariantAccessibleLabel(meta.variantKind) : null,
    blacklistStatus: getResolvedBlacklistStatus(coin.id),
    mintAuthorityStatus: resolveMintAuthorityStatus(meta?.mintAuthoritySummary),
    mintAuthorityScore: resolveMintAuthorityScoreDisplay(reportCards?.[coin.id]?.mint),
    change24h: prevDay > 0 ? ((circulating - prevDay) / prevDay) * 100 : 0,
    change7d: prevWeek > 0 ? ((circulating - prevWeek) / prevWeek) * 100 : 0,
    supplySparklineValues: [prevWeek, prevDay, circulating],
    isOverview,
    isCompactDensity: density === "compact",
    riskClass: isOverview
      ? ""
      : riskLevel === "depeg"
        ? "pharos-row-risk-depeg"
        : riskLevel === "poor"
          ? "pharos-row-risk-poor"
          : riskLevel === "warning"
            ? "pharos-row-risk-warning"
            : "",
    pegRef,
    absPegDeviationBps,
    priceCell: pegRef == null ? "—" : formatNativePrice(coin.price, meta?.flags.pegCurrency ?? "USD", pegRef),
    pegDeviationColorClass: absPegDeviationBps === null
      ? "text-muted-foreground"
      : deviationColorClass(absPegDeviationBps),
  };
}

export type StablecoinTableRowModel = ReturnType<typeof buildStablecoinTableRowModel>;
