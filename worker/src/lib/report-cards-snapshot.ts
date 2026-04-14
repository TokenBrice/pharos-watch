import { ACTIVE_STABLECOINS, ACTIVE_META_BY_ID } from "@shared/lib/stablecoins";
import { derivePegAnalyticsSnapshot } from "./peg-analytics";
import {
  summarizeCollateralDriftFromLiveReserveMap,
  type CollateralDriftEntry,
} from "./collateral-drift";
import { parseBluechipRatingsCache } from "./bluechip-cache";
import { resolveBlacklistStatuses } from "@shared/lib/report-cards";
import { loadReportCardsSnapshotInputs } from "./report-cards-snapshot-inputs";
import { buildLiveReportCards } from "./report-cards-snapshot-card";
import {
  buildDefunctReportCards,
  buildReportCardsSnapshotEnvelope,
  sortReportCards,
} from "./report-cards-snapshot-finalize";
import type { StablecoinData } from "@shared/types/market";
import type {
  DimensionKey,
  ReportCard,
  ReportCardGrade,
} from "@shared/types/report-cards";

export { ReportCardsSnapshotUnavailableError } from "./report-cards-snapshot-inputs";
export { topologicalOrder } from "./report-cards-snapshot-card";

export interface ReportCardsSnapshot {
  cards: ReportCard[];
  methodology: {
    version: string;
    weights: Record<DimensionKey, number>;
    pegMultiplierExponent: number;
    thresholds: { grade: ReportCardGrade; min: number }[];
  };
  dependencyGraph: {
    edges: { from: string; to: string }[];
  };
  updatedAt: number;
  liquidityStale: boolean;
  /** Coins where live vs curated collateral score diverges by >15 points */
  collateralDriftCoins?: CollateralDriftEntry[];
  /** Coins that fell back from live to curated scoring */
  liveToFallbackCoins?: string[];
}

export async function buildReportCardsSnapshot(db: D1Database): Promise<ReportCardsSnapshot> {
  const {
    stablecoinsCached,
    bluechipCached,
    dexLiquiditySnapshot,
    redemptionBackstopMap,
    liveReserveMap,
    liquidityStale,
  } = await loadReportCardsSnapshotInputs(db);

  const peggedAssets: StablecoinData[] = stablecoinsCached.payload.peggedAssets;
  const fxFallbackRates = stablecoinsCached.payload.fxFallbackRates;

  const bluechipMap = parseBluechipRatingsCache(
    bluechipCached?.value,
    "report-cards-snapshot",
  );

  const pegAnalytics = await derivePegAnalyticsSnapshot(db, {
    peggedAssets,
    fxFallbackRates,
    methodologyAsOf: stablecoinsCached.updatedAt,
    includeNavTokens: false,
  });

  const resolvedBlacklistStatuses = resolveBlacklistStatuses(
    ACTIVE_STABLECOINS,
    {
      reserveSlicesById: liveReserveMap,
      trackedMetaById: ACTIVE_META_BY_ID,
    },
  );

  const liveCards = buildLiveReportCards({
    pegDataById: pegAnalytics.pegDataById,
    dexLiqMap: dexLiquiditySnapshot.map,
    redemptionBackstopMap,
    bluechipMap,
    resolvedBlacklistStatuses,
    liveReserveMap,
    liquidityStale,
  });

  const {
    driftCoins: collateralDriftCoins,
    fallbackCoins: liveToFallbackCoins,
  } = summarizeCollateralDriftFromLiveReserveMap(liveReserveMap);

  return buildReportCardsSnapshotEnvelope({
    cards: sortReportCards([...liveCards, ...buildDefunctReportCards()]),
    updatedAt: stablecoinsCached.updatedAt,
    liquidityStale,
    collateralDriftCoins,
    liveToFallbackCoins,
  });
}
