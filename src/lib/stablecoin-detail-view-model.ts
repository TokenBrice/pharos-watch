import {
  getClientVariantParent,
  getClientVariantRelationship,
  getClientVariants,
} from "@/lib/client-variant-registry";
import {
  buildMintAuthorityDetailViewModel,
} from "@/lib/stablecoin-detail-mint-authority-view-model";
import { readV9CardMintComponent } from "@/lib/safety-score-v9-consumers";
import {
  buildDetailFeatureSnapshot,
  buildDetailMarketSnapshot,
  buildDetailPegPriceSnapshot,
  buildDetailStaleQueries,
  resolveReportCardSnapshotUpdatedAtMs,
} from "@/lib/stablecoin-detail-query-view-model";
import type {
  BuildStablecoinDetailViewModelParams,
  StablecoinDetailViewModel,
} from "@/lib/stablecoin-detail-view-model-types";
import { isThreatBand, resolveMechanismArchetype } from "@shared/lib/classification";
import { getReserves } from "@shared/lib/reserve-templates";
import { CLIENT_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import { deriveStablecoinVerdict } from "@shared/lib/stablecoin-verdict";

export {
  buildStablecoinDetailHeroViewModel,
} from "@/lib/stablecoin-detail-hero-view-model";
export type { HeroCardViewModel, HeroTertiaryMetricViewModel } from "@/lib/stablecoin-detail-hero-view-model";
export type { BuildStablecoinDetailViewModelParams, StablecoinDetailSummary, StablecoinDetailViewModel } from "@/lib/stablecoin-detail-view-model-types";

export function buildStablecoinDetailViewModel({
  core: { id, coin, summary, logoSrc, handleRetryAll },
  queries,
  supplemental,
}: BuildStablecoinDetailViewModelParams): StablecoinDetailViewModel {
  const { supplyHistory, stablecoinList, pegSummary, dexLiquidity, reportCards, redemptionBackstops } = queries;
  if (supplyHistory.isLoading || stablecoinList.isLoading) return { status: "loading", handleRetryAll };
  if (stablecoinList.isError) {
    return { status: "list-error", listError: stablecoinList.error, handleRetryAll };
  }
  const listData = stablecoinList.data;
  if (!listData) {
    return {
      status: "list-error",
      listError: stablecoinList.error ?? new Error("Stablecoin list data unavailable"),
      handleRetryAll,
    };
  }
  const coinData = listData.peggedAssets?.find((candidate) => candidate.id === id);
  if (!coinData) return { status: "not-found", handleRetryAll };

  const isNavToken = coin.flags.navToken ?? false;
  const resolvedSupplyHistory = supplyHistory.data ?? [];
  const market = buildDetailMarketSnapshot(coin, coinData, resolvedSupplyHistory, supplemental.nowMs ?? Date.now());
  const pegPrice = buildDetailPegPriceSnapshot(id, coin, coinData, listData, pegSummary.data);
  const liquidityData = dexLiquidity.data?.[id];
  const redemptionBackstop = redemptionBackstops.data?.coins?.[id];
  const reportCard = reportCards.data?.cards.find((candidate) => candidate.id === id);
  const { availability: featureAvailability, states: featureStates } = buildDetailFeatureSnapshot(
    id,
    coin,
    queries,
    supplemental,
  );
  const variantRelationship = getClientVariantRelationship(id);
  const variantParent = getClientVariantParent(id);
  const childVariants = getClientVariants(id);
  const mintAuthority = buildMintAuthorityDetailViewModel(
    coin,
    reportCard
      ? { mint: readV9CardMintComponent(reportCard), caps: reportCard.caps }
      : { mint: null, caps: [] },
  );
  const stressBand = featureAvailability.stressSignal && isThreatBand(featureAvailability.stressSignal.band)
    ? featureAvailability.stressSignal.band
    : null;
  const verdict = deriveStablecoinVerdict({
    status: coin.status,
    reportCardGrade: reportCard?.grade ?? null,
    pegScore: isNavToken ? null : pegPrice.pegScoreResult?.pegScore ?? null,
    dewsBand: stressBand,
    mechanismArchetype: resolveMechanismArchetype(coin, CLIENT_TRACKED_META_BY_ID) ?? undefined,
    governance: coin.flags.governance,
    yieldBearing: coin.flags.yieldBearing ?? false,
    navToken: isNavToken,
    activeDepeg: !isNavToken && pegPrice.pegScoreResult?.activeDepeg === true,
  });

  return {
    status: "ready",
    handleRetryAll,
    id,
    coin,
    summary,
    logoSrc,
    reportCard,
    reportCardsResponse: reportCards.data,
    reportCardUpdatedAt: resolveReportCardSnapshotUpdatedAtMs(reportCards),
    variantParent,
    variantSiblings: variantRelationship?.siblings ?? [],
    childVariants,
    isVariant: variantRelationship != null,
    hasVariants: childVariants.length > 0,
    coinData,
    ...market,
    pegRef: pegPrice.pegRef,
    deviationBps: pegPrice.deviationBps,
    gaugeDeviationBps: pegPrice.gaugeDeviationBps,
    pegReferenceUnavailable: pegPrice.pegReferenceUnavailable,
    isNavToken,
    pegScoreResult: pegPrice.pegScoreResult,
    consensusSources: pegPrice.consensusSources,
    agreeSources: pegPrice.agreeSources,
    dexPriceCheck: pegPrice.dexPriceCheck,
    liquidityData,
    yieldRanking: featureAvailability.yieldRanking,
    hasYieldSection: featureAvailability.hasYieldSection,
    stressSignal: featureAvailability.stressSignal,
    redemptionBackstop,
    hasFlows: featureAvailability.hasFlows,
    hasBlacklist: featureAvailability.hasBlacklist,
    blacklistSymbol: featureAvailability.blacklistSymbol,
    supplyHistory: resolvedSupplyHistory,
    supplyUpdatedAt: supplyHistory.dataUpdatedAt,
    reserves: supplemental.reserves.live ?? getReserves(coin),
    reserveFetchError: supplemental.reserves.error ?? null,
    supplyError: supplyHistory.error,
    staleQueries: buildDetailStaleQueries(queries, supplemental),
    featureStates,
    verdict,
    mintAuthority,
  };
}
