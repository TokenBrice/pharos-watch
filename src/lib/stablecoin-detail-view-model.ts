import type { SupplyHistoryPoint } from "@/hooks/use-stablecoins";
import type {
  BlacklistSummaryResponse,
  DexLiquidityData,
  DexLiquidityMap,
  Infrastructure,
  MintBurnFlowsResponse,
  PegSummaryCoin,
  PegSummaryResponse,
  RedemptionBackstopsResponse,
  ReportCard,
  ReportCardsResponse,
  StablecoinAiSummary,
  StablecoinData,
  StablecoinListResponse,
  StablecoinMeta,
  RedemptionBackstopEntry,
  StressSignalEntry,
  StressSignalsAllResponse,
  VariantKind,
  YieldRanking,
  YieldRankingsResponse,
} from "@shared/types";
import type { BlacklistStablecoin } from "@shared/types";
import { BLACKLIST_STABLECOINS } from "@shared/types/market";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import {
  getCirculatingRaw,
  getPrevDayRawOrNull,
  getPrevMonthRawOrNull,
  getPrevWeekRawOrNull,
} from "@shared/lib/supply";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import {
  deriveDeviationBps,
  deriveGaugeDeviationBps,
  derivePegReferenceContext,
  deriveSupplyFromMarketCap,
} from "@/lib/stablecoin-detail-derive";
import type { ApiMeta } from "@/lib/api";
import type { ReserveResult } from "@shared/lib/reserve-templates";
import { DEPEG_THRESHOLD_BPS, DEPEG_THRESHOLD_BPS_NON_USD } from "@shared/lib/depeg-config";
import { DEPEG_EVENT_MIN_SUPPLY_USD } from "@shared/lib/depeg-detection-config";
import { formatCurrency, formatSignedPercent } from "@shared/lib/format";
import { REPORT_CARD_GRADE_COLORS } from "@shared/lib/report-cards";
import { THREAT_BAND_LABELS, THREAT_BAND_TEXT_COLORS, isThreatBand, type ThreatBand } from "@shared/lib/classification";
import { getVariantParent, getVariantRelationship, getVariants } from "@shared/lib/stablecoins";
import { getReserves } from "@shared/lib/reserve-templates";
import { buildLiveCompareUrl, getPrimaryStaticComparisonPageForCoin } from "@/lib/compare-pages";
import { getFreezableLabel, getResolvedBlacklistStatus } from "@/lib/blacklist-status";
import { isQuietDeviationsEnabled } from "@/lib/feature-flags";
import { getScoreColor, pegScoreColor } from "@/lib/severity-colors";
import { getVariantDisplay } from "@/lib/variant-display";
import { getYieldBenchmarkGapReferenceText, getYieldBenchmarkGapUnavailableText } from "@/lib/yield-benchmark";

const YEAR_SECONDS = 365 * DAY_SECONDS;
const YEARLY_PERFORMANCE_ANCHOR_TOLERANCE_SECONDS = 14 * DAY_SECONDS;

export interface DetailQueryResource<TData> {
  data?: TData;
  dataUpdatedAt: number;
  error: unknown | null;
  meta: ApiMeta | null;
}

export interface DetailSupplyHistoryInput {
  data?: SupplyHistoryPoint[];
  isLoading: boolean;
  error: unknown | null;
}

export interface DetailStablecoinListInput extends DetailQueryResource<StablecoinListResponse> {
  isLoading: boolean;
  isError: boolean;
}

export interface StablecoinDetailViewModelQueryInputs {
  supplyHistory: DetailSupplyHistoryInput;
  stablecoinList: DetailStablecoinListInput;
  pegSummary: DetailQueryResource<PegSummaryResponse>;
  dexLiquidity: DetailQueryResource<DexLiquidityMap>;
  reportCards: DetailQueryResource<ReportCardsResponse>;
  redemptionBackstops: DetailQueryResource<RedemptionBackstopsResponse>;
}

export interface DetailFlowsInput {
  data?: MintBurnFlowsResponse;
  isLoading: boolean;
}

export interface DetailBlacklistInput {
  summary?: BlacklistSummaryResponse;
  isLoading: boolean;
}

export interface DetailReservesInput {
  live?: ReserveResult | null;
  error?: unknown | null;
}

export interface StablecoinDetailViewModelSupplementalInputs {
  yieldRankingsData?: YieldRankingsResponse;
  stressSignalsData?: StressSignalsAllResponse;
  flows: DetailFlowsInput;
  blacklist: DetailBlacklistInput;
  reserves: DetailReservesInput;
  nowMs?: number;
}

export type StablecoinDetailStaleQuery = {
  preset: "stablecoins" | "pegSummary" | "dexLiquidity" | "reportCards" | "redemptionBackstops";
  dataUpdatedAt: number;
  error: unknown | null;
  hasData: boolean;
  meta: ApiMeta | null;
};

export type MarketSnapshot = {
  mcap: number;
  supply: number | null;
  prevDay: number | null;
  prevWeek: number | null;
  prevMonth: number | null;
  performanceVsUsd1y: number | null;
  earliestTrackingDate: number | null;
};

export type PegPriceSnapshot = {
  pegRef: number;
  deviationBps: number;
  gaugeDeviationBps: number;
  pegScoreResult: PegSummaryCoin | null;
  consensusSources: string[];
  agreeSources: string[];
  dexPriceCheck: PegSummaryCoin["dexPriceCheck"];
};

export type FeatureAvailabilitySnapshot = {
  yieldRanking: YieldRanking | null;
  hasYieldSection: boolean;
  stressSignal: StressSignalEntry | null;
  hasFlows: boolean;
  hasBlacklist: boolean;
};

function isEligibleForUsdPerformance(coin: StablecoinMeta): boolean {
  const pegCurrency = coin.flags.pegCurrency;
  return !coin.flags.navToken && pegCurrency !== "USD" && pegCurrency !== "VAR" && pegCurrency !== "OTHER";
}

function computePerformanceVsUsd1y(
  coin: StablecoinMeta,
  currentPrice: number | null | undefined,
  supplyHistory: SupplyHistoryPoint[],
  nowMs: number,
): number | null {
  if (!isEligibleForUsdPerformance(coin)) return null;
  if (currentPrice == null || !Number.isFinite(currentPrice) || currentPrice <= 0) return null;

  // The tracked USD price series is the repo-local proxy for non-USD/commodity
  // asset performance without adding an FX-history dependency.
  const pricedHistory = supplyHistory.filter(
    (point) => point.price != null && Number.isFinite(point.price) && point.price > 0,
  );
  if (pricedHistory.length === 0) return null;

  const targetDate = Math.floor(nowMs / 1000) - YEAR_SECONDS;
  if (pricedHistory[0].date > targetDate + YEARLY_PERFORMANCE_ANCHOR_TOLERANCE_SECONDS) {
    return null;
  }

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

export function buildMarketSnapshot(
  coin: StablecoinMeta,
  coinData: StablecoinData,
  supplyHistory: SupplyHistoryPoint[],
  nowMs: number,
): MarketSnapshot {
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

export function buildPegPriceSnapshot(
  id: string,
  coin: StablecoinMeta,
  coinData: StablecoinData,
  listData: StablecoinListResponse,
  pegSummaryData?: PegSummaryResponse,
): PegPriceSnapshot {
  const isNavToken = coin.flags.navToken ?? false;
  const pegContext = derivePegReferenceContext({
    assets: listData.peggedAssets ?? [],
    pegType: coinData.pegType,
    commodityOunces: coin.commodityOunces,
    fallbackRates: listData.fxFallbackRates,
    metaById: TRACKED_META_BY_ID,
  });
  const deviationBps = deriveDeviationBps(coinData.price, pegContext.pegReference);
  const pegScoreResult = pegSummaryData?.coins.find((candidate) => candidate.id === id) ?? null;

  return {
    pegRef: pegContext.pegReference,
    deviationBps,
    gaugeDeviationBps: deriveGaugeDeviationBps(deviationBps, isNavToken),
    pegScoreResult,
    consensusSources: pegScoreResult?.consensusSources ?? [],
    agreeSources: pegScoreResult?.agreeSources ?? [],
    dexPriceCheck: pegScoreResult?.dexPriceCheck ?? null,
  };
}

export function buildFeatureAvailability(
  id: string,
  coin: StablecoinMeta,
  supplemental: StablecoinDetailViewModelSupplementalInputs,
): FeatureAvailabilitySnapshot {
  const yieldRanking = supplemental.yieldRankingsData?.rankings.find((candidate) => candidate.id === id) ?? null;
  const hasYieldSection = (coin.flags.yieldBearing ?? false) || yieldRanking !== null;
  const stressSignal = supplemental.stressSignalsData?.signals[id] ?? null;
  const hasFlows =
    supplemental.flows.isLoading || !!supplemental.flows.data?.coins.find((entry) => entry.stablecoinId === id);
  const isBlacklistSupported = (BLACKLIST_STABLECOINS as readonly string[]).includes(coin.symbol);
  const hasBlacklist =
    isBlacklistSupported &&
    (supplemental.blacklist.isLoading ||
      (!!supplemental.blacklist.summary &&
        (supplemental.blacklist.summary.stats.perCoinTotalEvents[coin.symbol as BlacklistStablecoin] ?? 0) > 0));

  return {
    yieldRanking,
    hasYieldSection,
    stressSignal,
    hasFlows,
    hasBlacklist,
  };
}

function staleQueryFrom<T>(
  preset: StablecoinDetailStaleQuery["preset"],
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

export function buildStaleQueryInputs(
  queries: StablecoinDetailViewModelQueryInputs,
): StablecoinDetailStaleQuery[] {
  return [
    staleQueryFrom("stablecoins", queries.stablecoinList, (data) => !!data?.peggedAssets?.length),
    staleQueryFrom("pegSummary", queries.pegSummary, (data) => !!data?.coins?.length),
    staleQueryFrom("dexLiquidity", queries.dexLiquidity, (data) => !!data),
    staleQueryFrom("reportCards", queries.reportCards, (data) => !!data?.cards?.length),
    staleQueryFrom("redemptionBackstops", queries.redemptionBackstops, (data) => !!data?.coins),
  ];
}

export type StablecoinDetailSummary = StablecoinAiSummary;

interface BaseViewModel {
  handleRetryAll: () => void;
}

interface LoadingViewModel extends BaseViewModel {
  status: "loading";
}

interface ListErrorViewModel extends BaseViewModel {
  status: "list-error";
  listError: unknown;
}

interface NotFoundViewModel extends BaseViewModel {
  status: "not-found";
}

interface StablecoinDetailReadyViewModel extends BaseViewModel {
  status: "ready";
  id: string;
  coin: StablecoinMeta;
  summary: StablecoinDetailSummary | null;
  logoSrc?: string;
  reportCard: ReportCard | undefined;
  reportCardUpdatedAt: number | null;
  variantParent: StablecoinMeta | null;
  variantSiblings: StablecoinMeta[];
  childVariants: StablecoinMeta[];
  isVariant: boolean;
  hasVariants: boolean;
  coinData: StablecoinData;
  mcap: number;
  supply: number | null;
  prevDay: number | null;
  prevWeek: number | null;
  prevMonth: number | null;
  performanceVsUsd1y: number | null;
  pegRef: number;
  deviationBps: number;
  gaugeDeviationBps: number;
  isNavToken: boolean;
  pegScoreResult: PegSummaryCoin | null;
  consensusSources: string[];
  agreeSources: string[];
  dexPriceCheck: PegSummaryCoin["dexPriceCheck"];
  liquidityData: DexLiquidityData | undefined;
  yieldRanking: YieldRanking | null;
  hasYieldSection: boolean;
  stressSignal: StressSignalEntry | null;
  redemptionBackstop: RedemptionBackstopEntry | undefined;
  hasFlows: boolean;
  hasBlacklist: boolean;
  supplyHistory: SupplyHistoryPoint[];
  earliestTrackingDate: number | null;
  reserves: ReserveResult | null;
  reserveFetchError: unknown | null;
  supplyError: unknown | null;
  staleQueries: StablecoinDetailStaleQuery[];
}

export interface HeroDisplayValue {
  value: string;
  sub?: string;
  color: string;
}

export interface HeroBlacklistDisplay extends HeroDisplayValue {
  status: ReturnType<typeof getResolvedBlacklistStatus>;
  source?: StablecoinMeta["canBeBlacklistedSource"];
  methodologyTopic: "freezable" | "freezableNo" | "freezablePossible" | "freezableDilutable" | "freezableUpstream";
}

export interface HeroDewsDisplay {
  value: string;
  band: ThreatBand | null;
  sub?: string;
  color: string;
}

export interface HeroTertiaryMetricViewModel {
  key: "dews" | "blacklistable" | "peg-score" | "liquidity" | "excess-yield" | "performance-vs-usd";
  label: "DEWS" | "Freezable" | "Peg Score" | "Liquidity" | "30d Excess" | "1Y vs USD";
  mobileLabel?: "Peg" | "Liq";
  methodologyTopic?: "dewsBand" | HeroBlacklistDisplay["methodologyTopic"] | "pegScore" | "liquidityScore" | "pys";
  display: HeroDisplayValue | HeroBlacklistDisplay | HeroDewsDisplay;
  accentClass?: string;
}

export interface HeroSignalRailItemViewModel {
  key: "safety" | "peg" | "liquidity" | "dews";
  label: string;
  primary: string;
  secondary: string | null;
  href: string;
  colorClass: string;
}

export interface HeroCardViewModel {
  coin: StablecoinMeta;
  coinData: StablecoinData;
  logoSrc?: string;
  reportCard: ReportCard | null;
  variantParent?: StablecoinMeta | null;
  variantKind?: VariantKind | null;
  variantChipClass: string | null;
  infrastructures: Infrastructure[];
  chainCount: number;
  header: {
    coinId: string;
    coinName: string;
    compareHref: string;
    benchmarkSymbol: string | null;
  };
  price: {
    pegRef: number;
    deviationBps: number;
    gaugeDeviationBps: number;
    isNavToken: boolean;
    limitedDepegCoverageNote: string | null;
  };
  market: {
    mcap: number;
    supply: number | null;
    safePrevDay: number | null;
    safePrevWeek: number | null;
    hasPrevMonth: boolean;
    safePrevMonth: number | null;
    prevDayTrendClass: string;
    prevWeekTrendClass: string;
    prevMonthTrendClass: string;
  };
  peg: {
    earlyPegScore: boolean;
    trackingSpanDays: number;
    activeDepeg: boolean;
  };
  tertiaryMetrics: HeroTertiaryMetricViewModel[];
  desktopTertiaryMetrics: HeroTertiaryMetricViewModel[];
  signalRailItems: HeroSignalRailItemViewModel[];
}

export type StablecoinDetailViewModel =
  | LoadingViewModel
  | ListErrorViewModel
  | NotFoundViewModel
  | StablecoinDetailReadyViewModel;

interface StablecoinDetailViewModelCoreInputs {
  id: string;
  coin: StablecoinMeta;
  summary: StablecoinDetailSummary | null;
  logoSrc?: string;
  handleRetryAll: () => void;
}

interface BuildStablecoinDetailViewModelParams {
  core: StablecoinDetailViewModelCoreInputs;
  queries: StablecoinDetailViewModelQueryInputs;
  supplemental: StablecoinDetailViewModelSupplementalInputs;
}
const HERO_POSITIVE_TREND_CLASS = "text-green-700 dark:text-green-400";
const HERO_NEGATIVE_TREND_CLASS = "text-red-700 dark:text-red-400";
const HERO_MUTED_CLASS = "text-muted-foreground";

export interface BuildHeroCardViewModelParams {
  coin: StablecoinMeta;
  coinData: StablecoinData;
  logoSrc?: string;
  isNavToken: boolean;
  mcap: number;
  supply: number | null;
  prevDay: number | null;
  prevWeek: number | null;
  prevMonth: number | null;
  performanceVsUsd1y: number | null;
  pegRef: number;
  deviationBps: number;
  gaugeDeviationBps: number;
  pegScoreResult: PegSummaryCoin | null;
  liquidityData: DexLiquidityData | undefined;
  yieldRanking: YieldRanking | null;
  stressSignal: StressSignalEntry | null;
  reportCard: ReportCard | null;
  variantParent?: StablecoinMeta | null;
  variantKind?: VariantKind | null;
}

function getTrendClass(hasPreviousValue: boolean, currentValue: number, previousValue: number): string {
  if (!hasPreviousValue) return HERO_MUTED_CLASS;
  if (isQuietDeviationsEnabled()) {
    if (previousValue <= 0) return HERO_MUTED_CLASS;
    const pctChange = Math.abs((currentValue - previousValue) / previousValue) * 100;
    if (pctChange < 0.5) return HERO_MUTED_CLASS;
    return currentValue >= previousValue ? HERO_POSITIVE_TREND_CLASS : HERO_NEGATIVE_TREND_CLASS;
  }
  return currentValue >= previousValue ? HERO_POSITIVE_TREND_CLASS : HERO_NEGATIVE_TREND_CLASS;
}

function buildPegScoreEventLine(
  pegScoreResult: PegSummaryCoin | null,
  recordedDepegEventCount: number | null,
): string | null {
  if (!pegScoreResult) return null;
  const scoreWindowCount = pegScoreResult.eventCount;
  const totalRecorded = recordedDepegEventCount;
  if (totalRecorded == null || totalRecorded === scoreWindowCount) {
    return `${scoreWindowCount.toLocaleString()} event${scoreWindowCount !== 1 ? "s" : ""}`;
  }
  return `${totalRecorded.toLocaleString()} recorded · ${scoreWindowCount.toLocaleString()} in 4y window`;
}

export function buildStablecoinDetailHeroViewModel({
  coin,
  coinData,
  logoSrc,
  isNavToken,
  mcap,
  supply,
  prevDay,
  prevWeek,
  prevMonth,
  performanceVsUsd1y,
  pegRef,
  deviationBps,
  gaugeDeviationBps,
  pegScoreResult,
  liquidityData,
  yieldRanking,
  stressSignal,
  reportCard,
  variantParent,
  variantKind,
}: BuildHeroCardViewModelParams): HeroCardViewModel {
  const recordedDepegEventCount = reportCard?.rawInputs.depegEventCount ?? null;
  const infrastructures: Infrastructure[] = coin.infrastructures ?? [];
  const chainCount = coinData?.chains?.length ?? 0;
  const blacklistStatus = getResolvedBlacklistStatus(coin.id, reportCard);
  const blacklistSource = blacklistStatus === "dilutable" ? coin.canBeBlacklistedSource : undefined;
  const primaryComparisonPage = getPrimaryStaticComparisonPageForCoin(coin.id);
  const compareHref = primaryComparisonPage?.href ?? buildLiveCompareUrl([coin.id]);
  const benchmarkSymbol = primaryComparisonPage
    ? primaryComparisonPage.left.id === coin.id
      ? primaryComparisonPage.right.symbol
      : primaryComparisonPage.left.symbol
    : null;

  const hasPrevDay = typeof prevDay === "number" && prevDay > 0;
  const hasPrevWeek = typeof prevWeek === "number" && prevWeek > 0;
  const hasPrevMonth = typeof prevMonth === "number" && prevMonth > 0;
  const safePrevDay = hasPrevDay ? prevDay : null;
  const safePrevWeek = hasPrevWeek ? prevWeek : null;
  const safePrevMonth = hasPrevMonth ? prevMonth : null;
  const prevDayValue = safePrevDay ?? 0;
  const prevWeekValue = safePrevWeek ?? 0;
  const prevMonthValue = safePrevMonth ?? 0;

  const tooNewForPegScore =
    !isNavToken &&
    pegScoreResult !== null &&
    pegScoreResult.pegScore === null &&
    pegScoreResult.trackingSpanDays > 0 &&
    pegScoreResult.trackingSpanDays < 7;
  const earlyPegScore =
    !isNavToken && pegScoreResult !== null && pegScoreResult.pegScore !== null && pegScoreResult.trackingSpanDays < 30;

  const pegScoreEventLine = buildPegScoreEventLine(pegScoreResult, recordedDepegEventCount);
  const pegScoreDisplay: HeroDisplayValue = !isNavToken
    ? pegScoreResult?.pegScore != null
      ? {
          value: String(pegScoreResult.pegScore),
          sub: pegScoreEventLine ?? `${pegScoreResult.pegPct.toFixed(1)}% at peg`,
          color: pegScoreColor(pegScoreResult.pegScore),
        }
      : tooNewForPegScore
        ? {
            value: "NR",
            sub: `${pegScoreResult?.trackingSpanDays ?? 0}d tracked`,
            color: HERO_MUTED_CLASS,
          }
        : { value: "—", color: HERO_MUTED_CLASS }
    : { value: "NAV", sub: "Token", color: HERO_MUTED_CLASS };

  const liquidityScore = liquidityData?.liquidityScore ?? null;
  const liqDisplay: HeroDisplayValue =
    liquidityData == null || (liquidityScore === null && liquidityData.poolCount === 0)
      ? { value: "—", color: HERO_MUTED_CLASS }
      : {
          value: String(Math.round(liquidityScore ?? 0)),
          sub: `${liquidityData.poolCount} pools`,
          color: getScoreColor(liquidityScore ?? 0),
        };

  const blacklistDisplay: HeroBlacklistDisplay = (() => {
    switch (blacklistStatus) {
      case true:
        return {
          status: blacklistStatus,
          value: getFreezableLabel(blacklistStatus) ?? "Freezable",
          color: HERO_NEGATIVE_TREND_CLASS,
          methodologyTopic: "freezable",
        };
      case "dilutable":
        return {
          status: blacklistStatus,
          value: getFreezableLabel(blacklistStatus) ?? "Dilutable",
          color: "text-purple-700 dark:text-purple-400",
          source: blacklistSource,
          methodologyTopic: "freezableDilutable",
        };
      case "possible":
        return {
          status: blacklistStatus,
          value: getFreezableLabel(blacklistStatus) ?? "Possible Freeze",
          color: "text-amber-700 dark:text-amber-400",
          methodologyTopic: "freezablePossible",
        };
      case "inherited":
        return {
          status: blacklistStatus,
          value: getFreezableLabel(blacklistStatus) ?? "Upstream Freeze",
          color: "text-amber-700 dark:text-amber-400",
          methodologyTopic: "freezableUpstream",
        };
      default:
        return {
          status: blacklistStatus,
          value: "No",
          color: HERO_POSITIVE_TREND_CLASS,
          methodologyTopic: "freezableNo",
        };
    }
  })();

  const excessYieldDisplay: HeroDisplayValue = (() => {
    if (!yieldRanking) return { value: "—", color: HERO_MUTED_CLASS };
    if (yieldRanking.excessYield === null) {
      return {
        value: "—",
        sub: getYieldBenchmarkGapUnavailableText(),
        color: HERO_MUTED_CLASS,
      };
    }
    return {
      value: formatSignedPercent(yieldRanking.excessYield),
      sub: getYieldBenchmarkGapReferenceText(yieldRanking),
      color: yieldRanking.excessYield >= 0 ? HERO_POSITIVE_TREND_CLASS : HERO_NEGATIVE_TREND_CLASS,
    };
  })();

  const performanceVsUsdDisplay: HeroDisplayValue | null =
    performanceVsUsd1y === null
      ? null
      : {
          value: formatSignedPercent(performanceVsUsd1y),
          color:
            performanceVsUsd1y > 0
              ? HERO_POSITIVE_TREND_CLASS
              : performanceVsUsd1y < 0
                ? HERO_NEGATIVE_TREND_CLASS
                : HERO_MUTED_CLASS,
        };

  const dewsDisplay: HeroDewsDisplay =
    stressSignal && isThreatBand(stressSignal.band)
      ? {
          value: THREAT_BAND_LABELS[stressSignal.band],
          band: stressSignal.band,
          sub: `${Math.round(stressSignal.score)}/100`,
          color: THREAT_BAND_TEXT_COLORS[stressSignal.band],
        }
      : { value: "—", band: null, color: HERO_MUTED_CLASS };

  const pegScoreAccent = (() => {
    const score = pegScoreResult?.pegScore;
    if (score == null) return undefined;
    if (score < 50) return "border-l-2 border-l-red-500";
    if (score < 70) return "border-l-2 border-l-amber-500";
    return undefined;
  })();
  const liqAccent = (() => {
    const score = liquidityData?.liquidityScore;
    if (score == null) return undefined;
    if (score < 30) return "border-l-2 border-l-red-500";
    if (score < 50) return "border-l-2 border-l-amber-500";
    return undefined;
  })();
  const dewsAccent = (() => {
    if (!stressSignal || !isThreatBand(stressSignal.band)) return undefined;
    if (stressSignal.band === "DANGER") return "border-l-2 border-l-red-500";
    if (stressSignal.band === "WARNING") return "border-l-2 border-l-orange-500";
    return undefined;
  })();

  const depegThresholdBps = coinData.pegType === "peggedUSD" ? DEPEG_THRESHOLD_BPS : DEPEG_THRESHOLD_BPS_NON_USD;
  const limitedDepegCoverageNote =
    !isNavToken && pegScoreResult?.depegEventCoverageLimited === true && Math.abs(deviationBps) >= depegThresholdBps
      ? `Below ${formatCurrency(DEPEG_EVENT_MIN_SUPPLY_USD)} live-event floor. Deviation is shown, but event history may stay empty.`
      : null;

  const tertiaryMetrics: HeroTertiaryMetricViewModel[] = [
    {
      key: "dews",
      label: "DEWS",
      methodologyTopic: "dewsBand",
      display: dewsDisplay,
      accentClass: dewsAccent,
    },
    {
      key: "blacklistable",
      label: "Freezable",
      methodologyTopic: blacklistDisplay.methodologyTopic,
      display: blacklistDisplay,
      accentClass: blacklistStatus === true ? "border-l-2 border-l-amber-500" : undefined,
    },
    {
      key: "peg-score",
      label: "Peg Score",
      mobileLabel: "Peg",
      methodologyTopic: "pegScore",
      display: pegScoreDisplay,
      accentClass: pegScoreAccent,
    },
    {
      key: "liquidity",
      label: "Liquidity",
      mobileLabel: "Liq",
      methodologyTopic: "liquidityScore",
      display: liqDisplay,
      accentClass: liqAccent,
    },
    {
      key: "excess-yield",
      label: "30d Excess",
      methodologyTopic: "pys",
      display: excessYieldDisplay,
    },
    ...(performanceVsUsdDisplay
      ? [
          {
            key: "performance-vs-usd" as const,
            label: "1Y vs USD" as const,
            display: performanceVsUsdDisplay,
          },
        ]
      : []),
  ];

  const signalRailItems: HeroSignalRailItemViewModel[] = [
    {
      key: "safety",
      label: "Safety",
      primary: reportCard?.overallGrade ?? "—",
      secondary: reportCard?.overallScore != null ? `${reportCard.overallScore}/100` : null,
      href: "#report-card",
      colorClass: reportCard?.overallGrade ? REPORT_CARD_GRADE_COLORS[reportCard.overallGrade] : HERO_MUTED_CLASS,
    },
    {
      key: "peg",
      label: "Peg",
      primary:
        !isNavToken && pegScoreResult?.pegScore != null ? String(pegScoreResult.pegScore) : isNavToken ? "NAV" : "—",
      secondary: null,
      href: "#report-card",
      colorClass:
        !isNavToken && pegScoreResult?.pegScore != null ? pegScoreColor(pegScoreResult.pegScore) : HERO_MUTED_CLASS,
    },
    {
      key: "liquidity",
      label: "Liquidity",
      primary: liquidityData?.liquidityScore != null ? String(Math.round(liquidityData.liquidityScore)) : "—",
      secondary: liquidityData?.poolCount != null ? `${liquidityData.poolCount} pools` : null,
      href: "#liquidity",
      colorClass:
        liquidityData?.liquidityScore != null ? getScoreColor(liquidityData.liquidityScore) : HERO_MUTED_CLASS,
    },
    {
      key: "dews",
      label: "DEWS",
      primary: dewsDisplay.value,
      secondary: dewsDisplay.sub ?? null,
      href: "#report-card",
      colorClass: dewsDisplay.color,
    },
  ];

  return {
    coin,
    coinData,
    logoSrc,
    reportCard,
    variantParent,
    variantKind,
    variantChipClass: variantKind ? getVariantDisplay(variantKind).chipClass : null,
    infrastructures,
    chainCount,
    header: {
      coinId: coin.id,
      coinName: coin.name,
      compareHref,
      benchmarkSymbol,
    },
    price: {
      pegRef,
      deviationBps,
      gaugeDeviationBps,
      isNavToken,
      limitedDepegCoverageNote,
    },
    market: {
      mcap,
      supply,
      safePrevDay,
      safePrevWeek,
      hasPrevMonth,
      safePrevMonth,
      prevDayTrendClass: getTrendClass(hasPrevDay, mcap, prevDayValue),
      prevWeekTrendClass: getTrendClass(hasPrevWeek, mcap, prevWeekValue),
      prevMonthTrendClass: getTrendClass(hasPrevMonth, mcap, prevMonthValue),
    },
    peg: {
      earlyPegScore,
      trackingSpanDays: pegScoreResult?.trackingSpanDays ?? 0,
      activeDepeg: pegScoreResult?.activeDepeg === true,
    },
    tertiaryMetrics,
    desktopTertiaryMetrics: tertiaryMetrics.filter(
      (metric) =>
        metric.key !== "dews"
        && metric.key !== "liquidity"
        && metric.key !== "peg-score"
        && metric.key !== "blacklistable",
    ),
    signalRailItems,
  };
}

export function buildStablecoinDetailViewModel({
  core: { id, coin, summary, logoSrc, handleRetryAll },
  queries,
  supplemental,
}: BuildStablecoinDetailViewModelParams): StablecoinDetailViewModel {
  const { supplyHistory, stablecoinList, pegSummary, dexLiquidity, reportCards, redemptionBackstops } = queries;
  const nowMs = supplemental.nowMs ?? Date.now();

  if (supplyHistory.isLoading || stablecoinList.isLoading) {
    return { status: "loading", handleRetryAll };
  }

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

  const coinData = listData?.peggedAssets?.find((candidate) => candidate.id === id);
  if (!coinData) {
    return { status: "not-found", handleRetryAll };
  }

  const isNavToken = coin.flags.navToken ?? false;
  const resolvedSupplyHistory = supplyHistory.data ?? [];
  const market = buildMarketSnapshot(coin, coinData, resolvedSupplyHistory, nowMs);
  const pegPrice = buildPegPriceSnapshot(id, coin, coinData, listData, pegSummary.data);
  const liquidityData = dexLiquidity.data?.[id];
  const redemptionBackstop = redemptionBackstops.data?.coins?.[id];
  const reportCard = reportCards.data?.cards.find((candidate) => candidate.id === id);
  const featureAvailability = buildFeatureAvailability(id, coin, supplemental);
  const variantRelationship = getVariantRelationship(id);
  const variantParent = getVariantParent(id);
  const childVariants = getVariants(id);
  const reserves = supplemental.reserves.live ?? getReserves(coin);

  return {
    status: "ready",
    handleRetryAll,
    id,
    coin,
    summary,
    logoSrc,
    reportCard,
    reportCardUpdatedAt: reportCards.dataUpdatedAt > 0 ? reportCards.dataUpdatedAt : null,
    variantParent,
    variantSiblings: variantRelationship?.siblings ?? [],
    childVariants,
    isVariant: variantRelationship != null,
    hasVariants: childVariants.length > 0,
    coinData,
    mcap: market.mcap,
    supply: market.supply,
    prevDay: market.prevDay,
    prevWeek: market.prevWeek,
    prevMonth: market.prevMonth,
    performanceVsUsd1y: market.performanceVsUsd1y,
    pegRef: pegPrice.pegRef,
    deviationBps: pegPrice.deviationBps,
    gaugeDeviationBps: pegPrice.gaugeDeviationBps,
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
    supplyHistory: resolvedSupplyHistory,
    earliestTrackingDate: market.earliestTrackingDate,
    reserves,
    reserveFetchError: supplemental.reserves.error ?? null,
    supplyError: supplyHistory.error,
    staleQueries: buildStaleQueryInputs(queries),
  };
}
