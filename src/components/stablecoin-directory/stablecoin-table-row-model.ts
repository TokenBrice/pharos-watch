import { getStablecoinTableRowRiskLevel, getMarketCapBaseline, getSupplyChangePercent } from "@/components/stablecoin-directory/stablecoin-table-logic";
import { formatObservedPrice, hasObservedDisplayPrice, hasPublishedDeviation, resolveCurrentDeviation, resolveDisplayPegReference } from "@/lib/current-peg";
import type { StablecoinTableRowVariant } from "@/components/stablecoin-directory/stablecoin-table-row-types";
import type { V9SafetyTableRow } from "@/lib/safety-score-v9-consumers";
import { getResolvedBlacklistStatus } from "@shared/lib/blacklist-status";
import { resolveMintAuthorityScoreDisplay, resolveMintAuthorityStatus } from "@/lib/mint-authority-display";
import { getQuoteMatchedNavPriceReference } from "@/lib/nav-price-reference";
import { pegCurrencySymbol } from "@shared/lib/peg-format";
import { isObservedPrice } from "@shared/lib/pricing-source-policy";
import { deviationColorClass } from "@/lib/severity-colors";
import { CLIENT_TRACKED_META_BY_ID as TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import { getCirculatingRawOrNull } from "@shared/lib/supply";
import { buildSupplyObservationProvenance, classifySupplyCoverage } from "@shared/lib/supply-provenance";
import { getVariantAccessibleLabel, getVariantDisplay } from "@shared/lib/variant-display";
import type { DexLiquidityTableMap } from "@shared/types/dex-liquidity";
import type { PegSummaryCoin } from "@shared/types/peg";
import type { StablecoinData } from "@shared/types/supply";
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
  const prevDay = getMarketCapBaseline(coin, "day");
  const prevWeek = getMarketCapBaseline(coin, "week");
  const meta = TRACKED_META_BY_ID.get(coin.id);
  const pegSummary = pegScores?.get(coin.id);
  const pegScore = pegSummary?.pegScore ?? null;
  const liquidityScore = dexLiquidity?.[coin.id]?.liquidityScore ?? null;
  const currency = meta?.flags.pegCurrency ?? "USD";
  const pegRef = resolveDisplayPegReference(coin, pegSummary, currency);
  const priceReference = meta?.flags.navToken
    ? getQuoteMatchedNavPriceReference(currency, coin.priceObservedAt, pegScores)
    : pegRef;
  // A NAV token has no fixed peg for a reference market to hold.
  const { deviationBps: currentDeviationBps, referenceNote } = resolveCurrentDeviation(
    coin, pegSummary, meta?.flags.navToken ? null : meta?.flags.pegCurrency,
  );
  const showPrice = isObservedPrice(coin) && (meta?.flags.navToken || priceReference != null
    || pegCurrencySymbol(currency) === "$" || referenceNote != null
    || (!hasPublishedDeviation(coin.currentPeg) && hasPublishedDeviation(pegSummary)));
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
    change24h: getSupplyChangePercent(coin, "day"),
    change7d: getSupplyChangePercent(coin, "week"),
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
    referenceNote,
    priceCell: showPrice
      ? formatObservedPrice(hasObservedDisplayPrice(coin) ? coin.price : null, currency, priceReference)
      : "—",
    pegDeviationColorClass: absPegDeviationBps === null
      ? "text-muted-foreground"
      : deviationColorClass(absPegDeviationBps),
  };
}

export type StablecoinTableRowModel = ReturnType<typeof buildStablecoinTableRowModel>;
