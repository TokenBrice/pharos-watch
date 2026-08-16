import type { SupplyHistoryPoint } from "@shared/types";
import { CRON_24H, CRON_RESERVE_SYNC } from "@/lib/cron-intervals";
import { resolveQueryViewState } from "@/lib/query-view-state";
import {
  deriveDeviationBps,
  deriveGaugeDeviationBps,
  derivePegReferenceContext,
  deriveSupplyFromMarketCap,
} from "@/lib/stablecoin-detail-derive";
import type {
  DetailQueryResource,
  StablecoinDetailFeatureState,
  StablecoinDetailFeatureStates,
  StablecoinDetailFeatureStatus,
  StablecoinDetailStaleQuery,
  StablecoinDetailViewModelQueryInputs,
  StablecoinDetailViewModelSupplementalInputs,
} from "@/lib/stablecoin-detail-view-model-types";
import {
  getCirculatingRaw,
  getPrevDayRawOrNull,
  getPrevMonthRawOrNull,
  getPrevWeekRawOrNull,
} from "@shared/lib/supply";
import { CLIENT_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import type {
  BlacklistStablecoin,
  PegSummaryCoin,
  PegSummaryResponse,
  ReportCardsV9CurrentResponse,
  StablecoinData,
  StablecoinListResponse,
  StablecoinMeta,
  StressSignalEntry,
  YieldRanking,
} from "@shared/types";
import { BLACKLIST_STABLECOINS } from "@shared/types/market";

const YEAR_SECONDS = 365 * DAY_SECONDS;
const YEARLY_PERFORMANCE_ANCHOR_TOLERANCE_SECONDS = 14 * DAY_SECONDS;

export interface DetailMarketSnapshot {
  mcap: number;
  supply: number | null;
  prevDay: number | null;
  prevWeek: number | null;
  prevMonth: number | null;
  performanceVsUsd1y: number | null;
  earliestTrackingDate: number | null;
}

export interface DetailPegPriceSnapshot {
  pegRef: number;
  deviationBps: number | null;
  gaugeDeviationBps: number;
  pegReferenceUnavailable: boolean;
  pegScoreResult: PegSummaryCoin | null;
  consensusSources: string[];
  agreeSources: string[];
  dexPriceCheck: PegSummaryCoin["dexPriceCheck"];
}

export interface DetailFeatureAvailabilitySnapshot {
  yieldRanking: YieldRanking | null;
  hasYieldSection: boolean;
  stressSignal: StressSignalEntry | null;
  hasFlows: boolean;
  hasBlacklist: boolean;
  blacklistSymbol: BlacklistStablecoin | null;
}

export function resolveReportCardSnapshotUpdatedAtMs(
  reportCards: DetailQueryResource<ReportCardsV9CurrentResponse>,
): number | null {
  const updatedAtSeconds = reportCards.meta?.updatedAt ?? reportCards.data?.updatedAt ?? null;
  return updatedAtSeconds != null && updatedAtSeconds > 0 ? updatedAtSeconds * 1000 : null;
}

function computePerformanceVsUsd1y(
  coin: StablecoinMeta,
  currentPrice: number | null | undefined,
  supplyHistory: SupplyHistoryPoint[],
  nowMs: number,
): number | null {
  const pegCurrency = coin.flags.pegCurrency;
  const eligible = !coin.flags.navToken && pegCurrency !== "USD" && pegCurrency !== "VAR" && pegCurrency !== "OTHER";
  if (!eligible || currentPrice == null || !Number.isFinite(currentPrice) || currentPrice <= 0) return null;
  const pricedHistory = supplyHistory.filter(
    (point) => point.price != null && Number.isFinite(point.price) && point.price > 0,
  );
  if (pricedHistory.length === 0) return null;
  const targetDate = Math.floor(nowMs / 1000) - YEAR_SECONDS;
  if (pricedHistory[0].date > targetDate + YEARLY_PERFORMANCE_ANCHOR_TOLERANCE_SECONDS) return null;

  let anchor = pricedHistory[0];
  let closestDelta = Math.abs(anchor.date - targetDate);
  for (const point of pricedHistory) {
    const delta = Math.abs(point.date - targetDate);
    if (delta < closestDelta) {
      anchor = point;
      closestDelta = delta;
    }
  }
  if (closestDelta > YEARLY_PERFORMANCE_ANCHOR_TOLERANCE_SECONDS || anchor.price == null || anchor.price <= 0) {
    return null;
  }
  return (currentPrice / anchor.price - 1) * 100;
}

export function buildDetailMarketSnapshot(
  coin: StablecoinMeta,
  coinData: StablecoinData,
  supplyHistory: SupplyHistoryPoint[],
  nowMs: number,
): DetailMarketSnapshot {
  const mcap = getCirculatingRaw(coinData);
  return {
    mcap,
    supply: deriveSupplyFromMarketCap(mcap, coinData.price),
    prevDay: getPrevDayRawOrNull(coinData),
    prevWeek: getPrevWeekRawOrNull(coinData),
    prevMonth: getPrevMonthRawOrNull(coinData),
    performanceVsUsd1y: computePerformanceVsUsd1y(coin, coinData.price, supplyHistory, nowMs),
    earliestTrackingDate: supplyHistory.length > 0 ? supplyHistory[0].date : null,
  };
}

export function buildDetailPegPriceSnapshot(
  id: string,
  coin: StablecoinMeta,
  coinData: StablecoinData,
  listData: StablecoinListResponse,
  pegSummaryData?: PegSummaryResponse,
): DetailPegPriceSnapshot {
  const isNavToken = coin.flags.navToken ?? false;
  const pegContext = derivePegReferenceContext({
    assets: listData.peggedAssets ?? [],
    pegType: coinData.pegType,
    commodityOunces: coin.commodityOunces,
    fallbackRates: listData.fxFallbackRates,
    metaById: CLIENT_TRACKED_META_BY_ID,
  });
  const pegScoreResult = pegSummaryData?.coins.find((candidate) => candidate.id === id) ?? null;
  const pegRef = pegScoreResult?.pegReference?.valueUsd ?? pegContext.pegReference;
  const deviationBps = deriveDeviationBps(coinData.price, pegRef);
  return {
    pegRef,
    deviationBps,
    gaugeDeviationBps: deriveGaugeDeviationBps(deviationBps, isNavToken),
    pegReferenceUnavailable: !isNavToken && pegScoreResult?.pegReferenceUnavailable === true,
    pegScoreResult,
    consensusSources: pegScoreResult?.consensusSources ?? [],
    agreeSources: pegScoreResult?.agreeSources ?? [],
    dexPriceCheck: pegScoreResult?.dexPriceCheck ?? null,
  };
}

function staleQueryFrom<T>(
  preset: NonNullable<StablecoinDetailStaleQuery["preset"]>,
  query: DetailQueryResource<T>,
  hasData: (data: T | undefined) => boolean,
): StablecoinDetailStaleQuery {
  return {
    preset,
    dataUpdatedAt: query.dataUpdatedAt,
    error: query.error,
    hasData: hasData(query.data),
    meta: query.meta,
  };
}

export function buildDetailStaleQueries(
  queries: StablecoinDetailViewModelQueryInputs,
  supplemental: StablecoinDetailViewModelSupplementalInputs,
): StablecoinDetailStaleQuery[] {
  const result: StablecoinDetailStaleQuery[] = [
    staleQueryFrom("stablecoins", queries.stablecoinList, (data) => Boolean(data?.peggedAssets?.length)),
    staleQueryFrom("pegSummary", queries.pegSummary, (data) => Boolean(data?.coins?.length)),
    staleQueryFrom("dexLiquidity", queries.dexLiquidity, (data) => Boolean(data)),
    staleQueryFrom("reportCards", queries.reportCards, (data) => Boolean(data?.cards?.length)),
    staleQueryFrom("redemptionBackstops", queries.redemptionBackstops, (data) => Boolean(data?.coins)),
    staleQueryFrom("yieldRankings", supplemental.yieldRankings, (data) => Boolean(data)),
    staleQueryFrom("stressSignals", supplemental.stressSignals, (data) => Boolean(data)),
    {
      label: "Supply History",
      staleTime: CRON_24H,
      dataUpdatedAt: queries.supplyHistory.dataUpdatedAt,
      error: queries.supplyHistory.error,
      hasData: queries.supplyHistory.dataUpdatedAt > 0 || (queries.supplyHistory.data?.length ?? 0) > 0,
      meta: null,
    },
  ];
  if (supplemental.flows.enabled) {
    result.push({
      preset: "mintBurnFlows",
      dataUpdatedAt: supplemental.flows.dataUpdatedAt,
      error: supplemental.flows.error,
      hasData: supplemental.flows.data !== undefined,
      meta: supplemental.flows.meta,
    });
  }
  if (supplemental.blacklist.enabled) {
    result.push({
      preset: "blacklist",
      dataUpdatedAt: supplemental.blacklist.dataUpdatedAt,
      error: supplemental.blacklist.error,
      hasData: supplemental.blacklist.summary !== undefined,
      meta: supplemental.blacklist.meta,
    });
  }
  if (supplemental.reserves.enabled) {
    result.push({
      label: "Live Reserves",
      staleTime: CRON_RESERVE_SYNC,
      dataUpdatedAt: supplemental.reserves.dataUpdatedAt,
      error: supplemental.reserves.error,
      hasData: supplemental.reserves.live != null,
      meta: null,
    });
  }
  return result;
}

function featureState(
  status: StablecoinDetailFeatureStatus,
  dataUpdatedAt: number,
  error: unknown | null | undefined,
): StablecoinDetailFeatureState {
  return { status, dataUpdatedAt, error: error ?? null };
}

export interface DetailFeatureSnapshot {
  availability: DetailFeatureAvailabilitySnapshot;
  states: StablecoinDetailFeatureStates;
}

/**
 * One pass over the per-feature lookups. Availability ("does this section render at all")
 * and the per-feature transport status were previously two functions that re-derived the
 * same `find()` results, membership tests and event counts from the same inputs.
 */
export function buildDetailFeatureSnapshot(
  id: string,
  coin: StablecoinMeta,
  queries: StablecoinDetailViewModelQueryInputs,
  supplemental: StablecoinDetailViewModelSupplementalInputs,
): DetailFeatureSnapshot {
  const { yieldRankings, stressSignals, flows, blacklist, reserves } = supplemental;
  const liquidityEntry = queries.dexLiquidity.data?.[id];
  const yieldRanking = yieldRankings.data?.rankings.find((candidate) => candidate.id === id) ?? null;
  const stressSignal = stressSignals.data?.signals[id] ?? null;
  const flowEntry = flows.data?.coins.find((entry) => entry.stablecoinId === id) ?? null;
  const blacklistSupported = (BLACKLIST_STABLECOINS as readonly string[]).includes(coin.symbol);
  const blacklistSymbol = blacklistSupported ? (coin.symbol as BlacklistStablecoin) : null;
  const blacklistEventCount = blacklistSymbol
    ? blacklist.summary?.stats.perCoinTotalEvents[blacklistSymbol] ?? 0
    : 0;

  const hasFlows = flows.enabled && (flows.isLoading || flows.error != null || flowEntry != null);
  const hasBlacklist = blacklistSupported
    && blacklist.enabled
    && (blacklist.isLoading || blacklist.error != null || blacklistEventCount > 0);

  return {
    availability: {
      yieldRanking,
      hasYieldSection: (coin.flags.yieldBearing ?? false) || yieldRanking !== null,
      stressSignal,
      hasFlows,
      hasBlacklist,
      blacklistSymbol,
    },
    states: {
      liquidity: featureState(
        resolveQueryViewState({
          hasData: queries.dexLiquidity.data !== undefined,
          isLoading: queries.dexLiquidity.isLoading ?? false,
          error: queries.dexLiquidity.error,
          isEmpty: liquidityEntry == null,
        }),
        queries.dexLiquidity.dataUpdatedAt,
        queries.dexLiquidity.error,
      ),
      yield: featureState(
        resolveQueryViewState({
          hasData: yieldRankings.data !== undefined,
          isLoading: yieldRankings.isLoading,
          error: yieldRankings.error,
          isEmpty: yieldRanking == null,
          // A non-yield-bearing coin with no ranking has nothing to show, not an empty section.
          emptyState: coin.flags.yieldBearing ? "empty" : "unsupported",
        }),
        yieldRankings.dataUpdatedAt,
        yieldRankings.error,
      ),
      stress: featureState(
        resolveQueryViewState({
          supported: !coin.flags.navToken,
          hasData: stressSignals.data !== undefined,
          isLoading: stressSignals.isLoading,
          error: stressSignals.error,
          isEmpty: stressSignal == null,
        }),
        stressSignals.dataUpdatedAt,
        stressSignals.error,
      ),
      flows: featureState(
        resolveQueryViewState({
          enabled: flows.enabled,
          hasData: flows.data !== undefined,
          isLoading: flows.isLoading,
          error: flows.error,
          isEmpty: flowEntry == null,
          emptyState: "unsupported",
        }),
        flows.dataUpdatedAt,
        flows.error,
      ),
      blacklist: featureState(
        resolveQueryViewState({
          supported: blacklistSupported,
          enabled: blacklist.enabled,
          hasData: blacklist.summary !== undefined,
          isLoading: blacklist.isLoading,
          error: blacklist.error,
          isEmpty: blacklistEventCount === 0,
        }),
        blacklist.dataUpdatedAt,
        blacklist.error,
      ),
      reserves: featureState(
        resolveQueryViewState({
          supported: Boolean(coin.liveReservesConfig),
          enabled: reserves.enabled,
          hasData: reserves.live != null,
          isLoading: reserves.isLoading,
          error: reserves.error,
        }),
        reserves.dataUpdatedAt,
        reserves.error,
      ),
    },
  };
}
