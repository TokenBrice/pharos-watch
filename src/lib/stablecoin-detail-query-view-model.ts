import type { SupplyHistoryPoint } from "@shared/types";
import type { NativeSupplyCheckpoints, StablecoinLiveSummary } from "@shared/types/stablecoin-live-summary";
import { isObservedPrice } from "@shared/lib/pricing-source-policy";
import { CRON_24H, CRON_RESERVE_SYNC } from "@/lib/cron-intervals";
import { resolveQueryViewState } from "@/lib/query-view-state";
import { deriveSupplyFromMarketCap } from "@/lib/stablecoin-detail-derive";
import type {
  DetailQueryResource,
  DetailFlowsInput,
  StablecoinDetailFeatureState,
  StablecoinDetailFeatureStates,
  StablecoinDetailFeatureStatus,
  StablecoinDetailStaleQuery,
  StablecoinDetailViewModelQueryInputs,
  StablecoinDetailViewModelSupplementalInputs,
} from "@/lib/stablecoin-detail-view-model-types";
import { getCirculatingRawOrNull, getPrevDayRawOrNull } from "@shared/lib/supply";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import type {
  BlacklistStablecoin,
  PegSummaryCoin,
  PegSummaryResponse,
  ReportCardsV9CurrentResponse,
  StablecoinMeta,
  StressSignalEntry,
  YieldRanking,
} from "@shared/types";
import { BLACKLIST_STABLECOINS } from "@shared/types/market";
import type { ReportCardsV9DetailResponse } from "@shared/types/report-cards-v9-projections";
import { MINT_BURN_FTQ_DEPENDENCY_KEY } from "@shared/types/mint-burn";
import { parseDataHealthWarnings } from "@/lib/data-health";

const YEAR_SECONDS = 365 * DAY_SECONDS;
const YEARLY_PERFORMANCE_ANCHOR_TOLERANCE_SECONDS = 14 * DAY_SECONDS;

export interface DetailMarketSnapshot {
  mcap: number | null;
  supply: number | null;
  prevDay: number | null;
  /** Token-count checkpoints for the hero Supply trend; USD market-cap history never feeds it. */
  nativeSupply: NativeSupplyCheckpoints | null;
  performanceVsUsd1y: number | null;
}

export interface DetailPegPriceSnapshot {
  pegRef: number | null;
  deviationBps: number | null;
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
  reportCards: DetailQueryResource<ReportCardsV9CurrentResponse | ReportCardsV9DetailResponse>,
): number | null {
  const updatedAtSeconds = reportCards.meta?.updatedAt ?? reportCards.data?.updatedAt ?? null;
  return updatedAtSeconds != null && updatedAtSeconds > 0 ? updatedAtSeconds * 1000 : null;
}

export function isAnnualUsdPerformanceEligible(coin: Pick<StablecoinMeta, "flags">): boolean {
  const pegCurrency = coin.flags.pegCurrency;
  return !coin.flags.navToken && pegCurrency !== "USD" && pegCurrency !== "VAR" && pegCurrency !== "OTHER";
}

function computePerformanceVsUsd1y(
  coin: StablecoinMeta,
  currentPrice: number | null | undefined,
  supplyHistory: SupplyHistoryPoint[],
  nowMs: number,
): number | null {
  if (!isAnnualUsdPerformanceEligible(coin) || currentPrice == null || !Number.isFinite(currentPrice) || currentPrice <= 0) return null;
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
  coinData: StablecoinLiveSummary,
  nativeSupply: NativeSupplyCheckpoints | null,
  supplyHistory: SupplyHistoryPoint[],
  nowMs: number,
): DetailMarketSnapshot {
  const mcap = getCirculatingRawOrNull(coinData);
  const observedPrice = isObservedPrice(coinData) ? coinData.price : null;
  return {
    mcap,
    supply: deriveSupplyFromMarketCap(mcap, observedPrice),
    prevDay: getPrevDayRawOrNull(coinData),
    nativeSupply,
    performanceVsUsd1y: computePerformanceVsUsd1y(coin, observedPrice, supplyHistory, nowMs),
  };
}

export function buildDetailPegPriceSnapshot(
  id: string,
  coin: StablecoinMeta,
  pegSummaryData?: PegSummaryResponse,
): DetailPegPriceSnapshot {
  const isNavToken = coin.flags.navToken ?? false;
  const pegScoreResult = pegSummaryData?.coins.find((candidate) => candidate.id === id) ?? null;
  const pegRef = pegScoreResult?.pegReference?.valueUsd ?? null;
  const deviationBps = pegScoreResult?.currentDeviationBps ?? null;
  return {
    pegRef,
    deviationBps,
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
    enabled: query.enabled,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isFetchedAfterMount: query.isFetchedAfterMount,
    isSnapshot: query.isSnapshot,
  };
}

/** Reserve fetch/source clocks have independent budgets; the first expiry owns aging. */
function reserveStaleQuery(
  reserves: StablecoinDetailViewModelSupplementalInputs["reserves"],
): StablecoinDetailStaleQuery {
  const live = reserves.live;
  const sync = live?.sync;
  const freshness = sync?.freshness;
  const fetchedAt = freshness?.fetchedAt ?? live?.liveAt;
  const isLive = live?.mode === "live" || live?.mode === "live-stale";
  const sourceAuthorityAvailable = freshness?.freshnessMode === "not-applicable"
    || (freshness?.freshnessMode === "verified" && freshness.sourceTimestamp != null
      && freshness.sourceTimestamp > 0 && freshness.sourceAgeBudgetSec != null);
  const clocks: { at: number; budget: number }[] = [];
  if (isLive && freshness && fetchedAt != null && fetchedAt > 0 && sourceAuthorityAvailable) {
    clocks.push({ at: fetchedAt, budget: freshness.fetchBudgetSec });
    if (freshness.freshnessMode === "verified" && freshness.sourceTimestamp != null
      && freshness.sourceTimestamp > 0 && freshness.sourceAgeBudgetSec != null) {
      clocks.push({ at: freshness.sourceTimestamp, budget: freshness.sourceAgeBudgetSec });
    }
  }
  const authority = clocks.reduce<{ at: number; budget: number } | null>((first, clock) =>
    !first || clock.at + clock.budget < first.at + first.budget ? clock : first, null);
  const stale = live?.mode === "live-stale" || sync?.stale || freshness?.stale || freshness?.sourceFreshnessInvalid;
  const issues = [
    live?.mode,
    sync && `sync:${sync.status}`,
    ...(freshness?.staleReasons ?? []),
    freshness?.sourceFreshnessInvalid && "invalid-source-freshness",
    sync?.uncertainWrite && "uncertain-write",
    sync?.failureCategory,
    ...(sync?.warnings ?? []),
  ].filter(Boolean).join("; ");
  const fetchClock = fetchedAt != null && fetchedAt > 0 ? new Date(fetchedAt * 1000).toISOString() : "unknown";
  const sourceClock = freshness?.sourceTimestamp != null && freshness.sourceTimestamp > 0
    ? new Date(freshness.sourceTimestamp * 1000).toISOString() : "unknown";
  const details = `${issues}; producer fetch ${fetchClock}; fetch budget ${freshness?.fetchBudgetSec ?? "unknown"} seconds; attempt ${freshness?.attemptId ?? "unknown"}; source ${sourceClock}; source mode ${freshness?.freshnessMode ?? "unknown"}; source budget ${freshness?.sourceAgeBudgetSec ?? "unknown"} seconds (${freshness?.sourceAgeBudgetCap ?? "unknown"})`;
  return {
    label: "Live Reserves",
    staleTime: CRON_RESERVE_SYNC,
    // A successful request receipt is never a reserve producer generation.
    dataUpdatedAt: authority ? authority.at * 1000 : 0,
    error: reserves.error,
    hasData: live != null && live.mode !== "unavailable",
    isLoading: reserves.isLoading,
    meta: authority && freshness ? {
      updatedAt: authority.at,
      ageSeconds: freshness.assessedAt - authority.at,
      assessedAt: freshness.assessedAt,
      status: stale ? "stale" : sync?.status !== "ok" || sync?.uncertainWrite ? "degraded" : "fresh",
      freshBudgetSec: authority.budget,
      degradedBudgetSec: authority.budget,
      ...(sync?.status !== "ok" || sync?.uncertainWrite ? { warning: issues } : {}),
      dependencies: { reserveEvidence: { status: stale ? "stale" : "fresh", reason: details } },
    } : {
      updatedAt: null,
      ageSeconds: null,
      status: stale ? "stale" : "unknown",
      reason: `${live?.mode ?? "unavailable"}: reserve-generation-or-budget-unavailable`,
      dependencies: { reserveEvidence: { status: "unavailable", reason: details } },
    },
  };
}

/** Coin totals do not consume the aggregate flight-to-quality classification. */
export function resolveDetailFlowMeta(flows: Pick<DetailFlowsInput, "data" | "meta">) {
  let meta = flows.meta;
  if (meta?.dependencies?.[MINT_BURN_FTQ_DEPENDENCY_KEY]) {
    // Remove only the typed FTQ dependency and matching advisory; preserve
    // unknown warnings, flow clocks and other dependencies.
    const dependencies = { ...meta.dependencies };
    delete dependencies[MINT_BURN_FTQ_DEPENDENCY_KEY];
    const classificationWarning = flows.data?.sync?.classificationWarning;
    const warning = meta.warning && classificationWarning
      ? parseDataHealthWarnings(meta.warning)
        .filter((entry) => entry.message !== classificationWarning)
        .map((entry) => entry.raw).join(", ") || null
      : meta.warning;
    meta = { ...meta, dependencies, warning };
  }
  const syncWarning = flows.data?.sync?.warning;
  if (syncWarning) {
    const warnings = meta?.warning ? parseDataHealthWarnings(meta.warning) : [];
    if (!warnings.some((entry) => entry.message === syncWarning)) {
      const warning = [...warnings.map((entry) => entry.raw), syncWarning].join(", ");
      meta = meta ? { ...meta, warning } : { status: "degraded", warning };
    }
  }
  return meta;
}

export function buildDetailStaleQueries(
  queries: StablecoinDetailViewModelQueryInputs,
  supplemental: StablecoinDetailViewModelSupplementalInputs,
  stablecoinId: string,
): StablecoinDetailStaleQuery[] {
  const liquidity = staleQueryFrom("dexLiquidity", queries.dexLiquidity, (data) => Boolean(data));
  const coinWarning = queries.dexLiquidity.data?.[stablecoinId]?.warning;
  if (coinWarning !== undefined) {
    // Older responses omit the field; keep their global advisory conservatively.
    // Preserve the producer clock so a coin-scoped advisory never hides old data.
    liquidity.meta = liquidity.meta?.updatedAt != null
      ? { ...liquidity.meta, warning: coinWarning }
      : coinWarning ? { status: "degraded", warning: coinWarning } : null;
  }
  const result: StablecoinDetailStaleQuery[] = [
    {
      ...staleQueryFrom("stablecoins", queries.liveSummary, (data) => data !== undefined),
      label: "Detail snapshot",
    },
    staleQueryFrom("pegSummary", queries.pegSummary, (data) => Boolean(data?.coins?.length)),
    liquidity,
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
      meta: queries.supplyHistory.meta,
      isLoading: queries.supplyHistory.isLoading,
      isFetching: queries.supplyHistory.isFetching,
      isFetchedAfterMount: queries.supplyHistory.isFetchedAfterMount,
      isSnapshot: queries.supplyHistory.isSnapshot,
    },
  ];
  if (queries.annualPriceHistory?.enabled) {
    result.push({
      label: "Annual Price History",
      staleTime: CRON_24H,
      dataUpdatedAt: queries.annualPriceHistory.dataUpdatedAt,
      error: queries.annualPriceHistory.error,
      hasData: (queries.annualPriceHistory.data?.length ?? 0) > 0,
      meta: queries.annualPriceHistory.meta,
      isLoading: queries.annualPriceHistory.isLoading,
    });
  }
  const flows = supplemental.flows;
  const flowEntry = flows.data?.coins.find((coin) => coin.stablecoinId === stablecoinId);
  if (flows.enabled && (flowEntry != null || flows.isLoading || flows.error != null)) {
    const meta = resolveDetailFlowMeta(flows);
    result.push({
      preset: "mintBurnFlows",
      dataUpdatedAt: flows.dataUpdatedAt,
      error: flows.error,
      hasData: flowEntry != null,
      meta,
      isLoading: flows.isLoading,
    });
  }
  if (supplemental.blacklist.enabled) {
    result.push({
      preset: "blacklist",
      dataUpdatedAt: supplemental.blacklist.dataUpdatedAt,
      error: supplemental.blacklist.error,
      hasData: supplemental.blacklist.summary !== undefined,
      meta: supplemental.blacklist.meta,
      isLoading: supplemental.blacklist.isLoading,
    });
  }
  if (supplemental.reserves.enabled) {
    result.push(reserveStaleQuery(supplemental.reserves));
  }
  return result.filter((query) => query.enabled !== false);
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
      redemption: {
        status: queries.redemptionBackstops.enabled === false ? "deferred"
          : queries.redemptionBackstops.error
            ? queries.redemptionBackstops.data?.coins[id] ? "retained" : "unavailable"
            : queries.redemptionBackstops.data === undefined ? "loading"
              : queries.redemptionBackstops.data.coins[id] ? "ready" : "empty",
        dataUpdatedAt: queries.redemptionBackstops.dataUpdatedAt,
        error: queries.redemptionBackstops.error ?? null,
      },
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

export type DetailGradeRead = "settled" | "pending" | "failed";

/**
 * Whether the report-card read behind the grade has settled. Without a card,
 * "Not scored" is only a finding once the response arrived; a first fetch in
 * flight is pending and a failed read is unavailable (never "Not scored").
 */
export function resolveDetailGradeRead(
  reportCard: unknown,
  staleQueries: readonly StablecoinDetailStaleQuery[],
): DetailGradeRead {
  if (reportCard) return "settled";
  const query = staleQueries.find((entry) => entry.preset === "reportCards");
  if (!query || query.hasData) return "settled";
  if (query.error) return "failed";
  return query.isLoading ? "pending" : "settled";
}
