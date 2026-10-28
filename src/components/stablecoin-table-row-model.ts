import { getStablecoinTableRowRiskLevel, getSupplyChangePercent } from "@/components/stablecoin-table-logic";
import { isObservedPrice } from "@shared/lib/pricing-source-policy";
import type { StablecoinTableRowVariant } from "@/components/stablecoin-table-row-types";
import type { V9SafetyTableRow } from "@/lib/safety-score-v9-consumers";
import { getResolvedBlacklistStatus } from "@shared/lib/blacklist-status";
import { resolveMintAuthorityScoreDisplay, resolveMintAuthorityStatus } from "@/lib/mint-authority-display";
import { getNavPriceReference } from "@/lib/nav-price-reference";
import { deviationColorClass } from "@/lib/severity-colors";
import { formatNativePrice } from "@shared/lib/format";
import { CLIENT_TRACKED_META_BY_ID as TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import { getCirculatingRawOrNull, getPrevDayRawOrNull, getPrevWeekRawOrNull } from "@shared/lib/supply";
import { buildSupplyObservationProvenance, classifySupplyCoverage } from "@shared/lib/supply-provenance";
import { getVariantAccessibleLabel, getVariantDisplay } from "@shared/lib/variant-display";
import type { DexLiquidityTableMap, PegSummaryCoin, StablecoinData } from "@shared/types";
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
  dexLiquidity?: DexLiquidityTableMap;
  reportCards?: Record<string, V9SafetyTableRow>;
  density: TableDensity;
  variant: StablecoinTableRowVariant;
}) {
  const circulating = getCirculatingRawOrNull(coin);
  const prevDay = getPrevDayRawOrNull(coin);
  const prevWeek = getPrevWeekRawOrNull(coin);
  const meta = TRACKED_META_BY_ID.get(coin.id);
  const pegSummary = pegScores?.get(coin.id);
  const pegScore = pegSummary?.pegScore ?? null;
  const liquidityScore = dexLiquidity?.[coin.id]?.liquidityScore ?? null;
  const pegRef = pegSummary?.pegReference?.valueUsd ?? null;
  // NAV tokens have no peg reference, but their observed price is still shown,
  // converted to the peg currency (USD fallback inside formatNativePrice).
  const priceRef = meta?.flags.navToken ? getNavPriceReference(meta.flags.pegCurrency, pegScores) : pegRef;
  const currentDeviationBps = !isObservedPrice(coin) || pegSummary?.pegReferenceUnavailable === true
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
    change24h: getSupplyChangePercent(coin, prevDay),
    change7d: getSupplyChangePercent(coin, prevWeek),
    supplySparklineValues: classifySupplyCoverage(buildSupplyObservationProvenance(coin)) === "partial"
      ? [] : [prevWeek, prevDay, circulating],
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
    pegDeviationBps: currentDeviationBps,
    absPegDeviationBps,
    priceCell: !isObservedPrice(coin) || (pegRef == null && !meta?.flags.navToken)
      ? "—"
      : formatNativePrice(coin.price, meta?.flags.pegCurrency ?? "USD", priceRef),
    pegDeviationColorClass: absPegDeviationBps === null
      ? "text-muted-foreground"
      : deviationColorClass(absPegDeviationBps),
  };
}

export type StablecoinTableRowModel = ReturnType<typeof buildStablecoinTableRowModel>;
