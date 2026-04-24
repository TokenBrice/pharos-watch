import { ACTIVE_STABLECOINS, ACTIVE_META_BY_ID } from "@shared/lib/stablecoins";
import { derivePegAnalyticsSnapshot } from "./peg-analytics";
import {
  summarizeCollateralDriftFromLiveReserveMap,
  type CollateralDriftEntry,
} from "./collateral-drift";
import { parseBluechipRatingsCache } from "./bluechip-cache";
import { resolveBlacklistStatuses } from "@shared/lib/report-cards";
import {
  loadReportCardsSnapshotInputs,
  type ReportCardsInputFreshness,
} from "./report-cards-snapshot-inputs";
import { buildLiveReportCards } from "./report-cards-snapshot-card";
import {
  buildDefunctReportCards,
  buildReportCardsSnapshotEnvelope,
  sortReportCards,
} from "./report-cards-snapshot-finalize";
import type { StablecoinData } from "@shared/types/market";
import type { DependencyGraphEdge } from "@shared/lib/dependency-graph";
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
    activeDepegSeveritySource: string;
    activeDepegCaps: {
      d: { thresholdBps: number; score: number };
      f: { thresholdBps: number; score: number };
    };
    thresholds: { grade: ReportCardGrade; min: number }[];
  };
  dependencyGraph: {
    edges: DependencyGraphEdge[];
  };
  updatedAt: number;
  liquidityStale: boolean;
  redemptionStale: boolean;
  inputFreshness: ReportCardsInputFreshness;
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
    redemptionStale,
    inputFreshness,
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
  const activeDepegPeakBpsById = new Map<string, number>();
  for (const [stablecoinId, events] of pegAnalytics.eventsByCoin ?? new Map()) {
    const activePeakBps = events
      .filter((event) => event.endedAt === null)
      .reduce((max, event) => Math.max(max, Math.abs(event.peakDeviationBps)), 0);
    if (activePeakBps > 0) {
      activeDepegPeakBpsById.set(stablecoinId, activePeakBps);
    }
  }

  const liveReportCards = buildLiveReportCards({
    pegDataById: pegAnalytics.pegDataById,
    activeDepegPeakBpsById,
    dexLiqMap: dexLiquiditySnapshot.map,
    redemptionBackstopMap,
    bluechipMap,
    resolvedBlacklistStatuses,
    liveReserveMap,
  });

  const {
    driftCoins: collateralDriftCoins,
    fallbackCoins: liveToFallbackCoins,
  } = summarizeCollateralDriftFromLiveReserveMap(liveReserveMap);

  return buildReportCardsSnapshotEnvelope({
    cards: sortReportCards([...liveReportCards.cards, ...buildDefunctReportCards()]),
    updatedAt: stablecoinsCached.updatedAt,
    liquidityStale,
    redemptionStale,
    inputFreshness,
    collateralDriftCoins,
    liveToFallbackCoins,
    dependencyGraphEdges: liveReportCards.dependencyGraphEdges,
  });
}
