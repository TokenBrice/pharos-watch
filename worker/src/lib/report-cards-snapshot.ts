import { ACTIVE_STABLECOINS, ACTIVE_META_BY_ID, TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { derivePegAnalyticsSnapshot } from "./peg-analytics";
import { writePegAnalyticsCache } from "./peg-analytics-cache";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { toErrorMessage } from "./error-utils";
import { summarizeCollateralDriftFromLiveReserveMap, type CollateralDriftEntry } from "./collateral-drift";
import { parseBluechipRatingsCache } from "./bluechip-cache";
import { resolveBlacklistStatuses } from "@shared/lib/report-cards";
import { loadReportCardsSnapshotInputs, type ReportCardsInputFreshness } from "./report-cards-snapshot-inputs";
import type { StablecoinsCacheLoadResult } from "./stablecoins-cache";
import { buildLiveReportCards } from "./report-cards-snapshot-card";
import {
  buildDefunctReportCards,
  buildReportCardsSnapshotEnvelope,
  sortReportCards,
} from "./report-cards-snapshot-finalize";
import type { StablecoinData } from "@shared/types/market";
import type { DependencyGraphEdge } from "@shared/lib/dependency-graph";
import type { DimensionKey, ReportCard, ReportCardGrade } from "@shared/types/report-cards";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";

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

export interface BuildReportCardsSnapshotOptions {
  /**
   * Publish the peg-analytics aggregate cache as a side effect. Only the
   * quarter-hourly report-card publish cron should set this; the builder is
   * also invoked from several read paths that must not perform D1 writes.
   */
  publishPegAnalytics?: boolean;
  preloadedStablecoinsCache?: StablecoinsCacheLoadResult;
  sameNotionalScoringMode?: "legacy" | "active";
}

export async function buildReportCardsSnapshot(
  db: D1Database,
  {
    publishPegAnalytics = false,
    preloadedStablecoinsCache,
    sameNotionalScoringMode = "legacy",
  }: BuildReportCardsSnapshotOptions = {},
): Promise<ReportCardsSnapshot> {
  const {
    stablecoinsCached,
    bluechipCached,
    dexLiquiditySnapshot,
    redemptionBackstopMap,
    liveReserveMap,
    liveReserveProvenanceMap,
    liquidityStale,
    redemptionStale,
    inputFreshness,
  } = await loadReportCardsSnapshotInputs(db, { preloadedStablecoinsCache });

  const peggedAssets: StablecoinData[] = stablecoinsCached.payload.peggedAssets;
  const fxFallbackRates = stablecoinsCached.payload.fxFallbackRates;

  const bluechipMap = parseBluechipRatingsCache(bluechipCached?.value, "report-cards-snapshot");

  // Nav-inclusive so the published peg-analytics cache can serve peg-summary
  // (which needs nav tokens); the cards path filters nav entries back out.
  const pegAnalytics = await derivePegAnalyticsSnapshot(db, {
    peggedAssets,
    fxFallbackRates,
    methodologyAsOf: stablecoinsCached.updatedAt,
    includeNavTokens: true,
  });

  // Publish the request-hot aggregate at producer cadence: peg-summary and the
  // per-coin OG renderer previously re-scanned ~21K depeg_events rows per edge
  // miss to rebuild this exact snapshot.
  if (publishPegAnalytics) {
    const todayStartSec = Math.floor(pegAnalytics.nowSec / DAY_SECONDS) * DAY_SECONDS;
    const yesterdayStartSec = todayStartSec - DAY_SECONDS;
    let depegEventsToday = 0;
    let depegEventsYesterday = 0;
    for (const event of pegAnalytics.allEvents ?? []) {
      if (TRACKED_META_BY_ID.get(event.stablecoinId)?.flags.navToken === true) continue;
      if (event.startedAt >= todayStartSec) depegEventsToday += 1;
      else if (event.startedAt >= yesterdayStartSec) depegEventsYesterday += 1;
    }
    try {
      await writePegAnalyticsCache(db, {
        computedAtSec: pegAnalytics.nowSec,
        depegEventsToday,
        depegEventsYesterday,
        pegData: [...pegAnalytics.pegDataById.values()],
      });
    } catch (error) {
      console.warn(
        "[report-cards-snapshot] peg-analytics cache publish failed (read paths fall back to direct compute):",
        toErrorMessage(error),
      );
    }
  }

  const nonNavPegDataById = new Map(
    [...pegAnalytics.pegDataById].filter(([id]) => ACTIVE_META_BY_ID.get(id)?.flags.navToken !== true),
  );

  const resolvedBlacklistStatuses = resolveBlacklistStatuses(ACTIVE_STABLECOINS, {
    reserveSlicesById: liveReserveMap,
    trackedMetaById: ACTIVE_META_BY_ID,
  });
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
    pegDataById: nonNavPegDataById,
    activeDepegPeakBpsById,
    dexLiqMap: dexLiquiditySnapshot.map,
    redemptionBackstopMap,
    bluechipMap,
    resolvedBlacklistStatuses,
    liveReserveMap,
    liveReserveProvenanceMap,
    chainCirculatingById: new Map(peggedAssets.map((asset) => [asset.id, asset.chainCirculating])),
    sameNotionalScoringMode,
    exitObservationAsOfSec: pegAnalytics.nowSec,
    maxExitObservationAgeSec:
      Math.max(CRON_INTERVALS["sync-dex-liquidity"], CRON_INTERVALS["sync-redemption-backstops"]) * 2,
  });

  const { driftCoins: collateralDriftCoins, fallbackCoins: liveToFallbackCoins } =
    summarizeCollateralDriftFromLiveReserveMap(liveReserveMap);

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
