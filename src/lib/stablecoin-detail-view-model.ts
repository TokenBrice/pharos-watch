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
  MechanismArchetype,
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
import { CLIENT_TRACKED_META_BY_ID, type StablecoinClientMeta } from "@shared/lib/stablecoins/client-registry";
import {
  deriveDeviationBps,
  deriveGaugeDeviationBps,
  derivePegReferenceContext,
  deriveSupplyFromMarketCap,
} from "@/lib/stablecoin-detail-derive";
import type { ApiMeta } from "@/lib/api";
import type { ReserveResult } from "@shared/lib/reserve-templates";
import { REPORT_CARD_GRADE_COLORS } from "@shared/lib/report-cards";
import { isThreatBand, resolveMechanismArchetype } from "@shared/lib/classification";
import { deriveStablecoinVerdict, type StablecoinVerdict } from "@shared/lib/stablecoin-verdict";
import { getReserves } from "@shared/lib/reserve-templates";
import { buildLiveCompareUrl, getPrimaryStaticComparisonLinkForCoin } from "@/lib/compare-links";
import { getResolvedBlacklistStatus } from "@/lib/blacklist-status";
import { isQuietDeviationsEnabled } from "@/lib/feature-flags";
import { getScoreColor, pegScoreColor } from "@/lib/severity-colors";
import {
  buildMintAuthorityDetailViewModel,
  type MintAuthorityDetailViewModel,
  type StablecoinDetailCoinMeta,
} from "@/lib/stablecoin-detail-mint-authority-view-model";
import { getVariantDisplay } from "@shared/lib/variant-display";
import { getClientVariantParent, getClientVariantRelationship, getClientVariants } from "@/lib/client-variant-registry";
import {
  HERO_MUTED_CLASS,
  HERO_NEGATIVE_TREND_CLASS,
  HERO_POSITIVE_TREND_CLASS,
  buildDewsAccent,
  buildDewsDisplay,
  buildExcessYieldDisplay,
  buildLimitedDepegCoverageNote,
  buildLiquidityAccent,
  buildLiquidityDisplay,
  buildPegScoreAccent,
  buildPegScoreDisplay,
  buildPerformanceVsUsdDisplay,
  type HeroDewsDisplay,
  type HeroDisplayValue,
} from "@/lib/stablecoin-detail-hero-metrics";
import { buildHeroPassportItems, type HeroPassportItemViewModel } from "@/lib/stablecoin-detail-passport";
import { CASE_STUDY_CLIENT_BY_COIN_ID } from "@/app/learn/case-studies/content/client-index";
import {
  CASE_STUDY_OUTCOME_CHIPS,
  CASE_STUDY_OUTCOME_LABELS,
} from "@/app/learn/case-studies/case-study-outcomes";

const YEAR_SECONDS = 365 * DAY_SECONDS;
const YEARLY_PERFORMANCE_ANCHOR_TOLERANCE_SECONDS = 14 * DAY_SECONDS;

export interface DetailQueryResource<TData> {
  data?: TData;
  dataUpdatedAt: number;
  error: unknown | null;
  meta: ApiMeta | null;
}

function resolveReportCardSnapshotUpdatedAtMs(reportCards: DetailQueryResource<ReportCardsResponse>): number | null {
  const updatedAtSeconds = reportCards.meta?.updatedAt ?? reportCards.data?.updatedAt ?? null;
  return updatedAtSeconds != null && updatedAtSeconds > 0 ? updatedAtSeconds * 1000 : null;
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

type MarketSnapshot = {
  mcap: number;
  supply: number | null;
  prevDay: number | null;
  prevWeek: number | null;
  prevMonth: number | null;
  performanceVsUsd1y: number | null;
  earliestTrackingDate: number | null;
};

type PegPriceSnapshot = {
  pegRef: number;
  deviationBps: number;
  gaugeDeviationBps: number;
  pegReferenceUnavailable: boolean;
  pegScoreResult: PegSummaryCoin | null;
  consensusSources: string[];
  agreeSources: string[];
  dexPriceCheck: PegSummaryCoin["dexPriceCheck"];
};

type FeatureAvailabilitySnapshot = {
  yieldRanking: YieldRanking | null;
  hasYieldSection: boolean;
  stressSignal: StressSignalEntry | null;
  hasFlows: boolean;
  hasBlacklist: boolean;
  blacklistSymbol: BlacklistStablecoin | null;
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

function buildMarketSnapshot(
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

function buildPegPriceSnapshot(
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
    metaById: CLIENT_TRACKED_META_BY_ID,
  });
  const deviationBps = deriveDeviationBps(coinData.price, pegContext.pegReference);
  const pegScoreResult = pegSummaryData?.coins.find((candidate) => candidate.id === id) ?? null;
  // Worker-side gate (depeg-dews v6.08): thin non-USD peer groups without a
  // live FX fallback produce a self-referential reference, so deviation is
  // withheld and the hero shows "reference unavailable" instead.
  const pegReferenceUnavailable = !isNavToken && pegScoreResult?.pegReferenceUnavailable === true;

  return {
    pegRef: pegContext.pegReference,
    deviationBps,
    gaugeDeviationBps: deriveGaugeDeviationBps(deviationBps, isNavToken),
    pegReferenceUnavailable,
    pegScoreResult,
    consensusSources: pegScoreResult?.consensusSources ?? [],
    agreeSources: pegScoreResult?.agreeSources ?? [],
    dexPriceCheck: pegScoreResult?.dexPriceCheck ?? null,
  };
}

function buildFeatureAvailability(
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
  const blacklistSymbol = isBlacklistSupported ? (coin.symbol as BlacklistStablecoin) : null;

  return {
    yieldRanking,
    hasYieldSection,
    stressSignal,
    hasFlows,
    hasBlacklist,
    blacklistSymbol,
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

function buildStaleQueryInputs(queries: StablecoinDetailViewModelQueryInputs): StablecoinDetailStaleQuery[] {
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
  coin: StablecoinDetailCoinMeta;
  summary: StablecoinDetailSummary | null;
  logoSrc?: string;
  reportCard: ReportCard | undefined;
  reportCardUpdatedAt: number | null;
  variantParent: StablecoinClientMeta | null;
  variantSiblings: StablecoinClientMeta[];
  childVariants: StablecoinClientMeta[];
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
  pegReferenceUnavailable: boolean;
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
  blacklistSymbol: BlacklistStablecoin | null;
  supplyHistory: SupplyHistoryPoint[];
  earliestTrackingDate: number | null;
  reserves: ReserveResult | null;
  reserveFetchError: unknown | null;
  supplyError: unknown | null;
  staleQueries: StablecoinDetailStaleQuery[];
  verdict: StablecoinVerdict;
  mintAuthority: MintAuthorityDetailViewModel;
  mintAuthorityDecentralizationDrag: MintAuthorityDecentralizationDragViewModel | null;
}

export interface MintAuthorityDecentralizationDragViewModel {
  value: string;
  detail: string | null;
}

export interface HeroTertiaryMetricViewModel {
  key: "dews" | "peg-score" | "liquidity" | "excess-yield" | "performance-vs-usd";
  label: "DEWS" | "Peg Score" | "Liquidity" | "30d Excess" | "1Y vs USD";
  mobileLabel?: "Peg" | "Liq";
  methodologyTopic?: "dewsBand" | "pegScore" | "liquidityScore" | "pys";
  display: HeroDisplayValue | HeroDewsDisplay;
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

/**
 * Inbound link to the long-form `/learn/case-studies/` retrospective whose
 * subject (`primaryCoinId`) is this coin. Surfaced as a callout row at the foot
 * of the hero dossier; `null` when no study takes this coin as its subject.
 */
export interface HeroCaseStudyCalloutViewModel {
  href: string;
  title: string;
  outcomeLabel: string;
  outcomeChipClass: string;
}

export interface HeroCardViewModel {
  coin: StablecoinMeta;
  coinData: StablecoinData;
  logoSrc?: string;
  reportCard: ReportCard | null;
  verdict: StablecoinVerdict;
  variantParent?: StablecoinClientMeta | null;
  variantKind?: VariantKind | null;
  variantChipClass: string | null;
  infrastructures: Infrastructure[];
  header: {
    coinId: string;
    compareHref: string;
    benchmarkSymbol: string | null;
  };
  price: {
    pegRef: number;
    deviationBps: number;
    gaugeDeviationBps: number;
    pegReferenceUnavailable: boolean;
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
  passportItems: HeroPassportItemViewModel[];
  caseStudyCallout: HeroCaseStudyCalloutViewModel | null;
}

export type StablecoinDetailViewModel =
  | LoadingViewModel
  | ListErrorViewModel
  | NotFoundViewModel
  | StablecoinDetailReadyViewModel;

interface StablecoinDetailViewModelCoreInputs {
  id: string;
  coin: StablecoinDetailCoinMeta;
  summary: StablecoinDetailSummary | null;
  logoSrc?: string;
  handleRetryAll: () => void;
}

interface BuildStablecoinDetailViewModelParams {
  core: StablecoinDetailViewModelCoreInputs;
  queries: StablecoinDetailViewModelQueryInputs;
  supplemental: StablecoinDetailViewModelSupplementalInputs;
}
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
  pegReferenceUnavailable: boolean;
  pegScoreResult: PegSummaryCoin | null;
  liquidityData: DexLiquidityData | undefined;
  yieldRanking: YieldRanking | null;
  stressSignal: StressSignalEntry | null;
  reportCard: ReportCard | null;
  verdict: StablecoinVerdict;
  variantParent?: StablecoinClientMeta | null;
  variantKind?: VariantKind | null;
  resolvedMechanismArchetype: MechanismArchetype | null;
  mintAuthority: MintAuthorityDetailViewModel;
  redemptionBackstop: RedemptionBackstopEntry | null;
}

const MOBILE_ONLY_TERTIARY_KEYS: ReadonlySet<HeroTertiaryMetricViewModel["key"]> = new Set([
  "dews",
  "liquidity",
  "peg-score",
]);

function posOrNull(value: number | null): number | null {
  return typeof value === "number" && value > 0 ? value : null;
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

/**
 * Resolves the peg score that should drive hero presentation: the worker-side
 * value only when this is a non-NAV coin with a populated score, otherwise
 * `null`. Hoisted so the peg rail item, peg tertiary metric and `earlyPegScore`
 * share a single source of truth instead of repeating the nav/peg guard.
 */
function resolveEffectivePegScore(isNavToken: boolean, pegScoreResult: PegSummaryCoin | null): number | null {
  if (isNavToken || pegScoreResult?.pegScore == null) return null;
  return pegScoreResult.pegScore;
}

function buildMarketTrends(
  mcap: number,
  prevDay: number | null,
  prevWeek: number | null,
  prevMonth: number | null,
): Omit<HeroCardViewModel["market"], "supply"> {
  const safePrevDay = posOrNull(prevDay);
  const safePrevWeek = posOrNull(prevWeek);
  const safePrevMonth = posOrNull(prevMonth);
  return {
    mcap,
    safePrevDay,
    safePrevWeek,
    hasPrevMonth: safePrevMonth !== null,
    safePrevMonth,
    prevDayTrendClass: getTrendClass(safePrevDay !== null, mcap, safePrevDay ?? 0),
    prevWeekTrendClass: getTrendClass(safePrevWeek !== null, mcap, safePrevWeek ?? 0),
    prevMonthTrendClass: getTrendClass(safePrevMonth !== null, mcap, safePrevMonth ?? 0),
  };
}

function buildTertiaryMetrics(
  dewsDisplay: HeroDewsDisplay,
  dewsAccent: string | undefined,
  pegScoreDisplay: HeroDisplayValue,
  pegScoreAccent: string | undefined,
  liqDisplay: HeroDisplayValue,
  liqAccent: string | undefined,
  excessYieldDisplay: HeroDisplayValue,
  performanceVsUsdDisplay: HeroDisplayValue | null,
): HeroTertiaryMetricViewModel[] {
  return [
    {
      key: "dews",
      label: "DEWS",
      methodologyTopic: "dewsBand",
      display: dewsDisplay,
      accentClass: dewsAccent,
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
}

function buildSignalRailItems(
  reportCard: ReportCard | null,
  isNavToken: boolean,
  effectivePegScore: number | null,
  liquidityData: DexLiquidityData | undefined,
  dewsDisplay: HeroDewsDisplay,
): HeroSignalRailItemViewModel[] {
  return [
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
      primary: effectivePegScore != null ? String(effectivePegScore) : isNavToken ? "NAV" : "—",
      secondary: null,
      href: "#report-card",
      colorClass: effectivePegScore != null ? pegScoreColor(effectivePegScore) : HERO_MUTED_CLASS,
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
  pegReferenceUnavailable,
  pegScoreResult,
  liquidityData,
  yieldRanking,
  stressSignal,
  reportCard,
  verdict,
  variantParent,
  variantKind,
  resolvedMechanismArchetype,
  mintAuthority,
  redemptionBackstop,
}: BuildHeroCardViewModelParams): HeroCardViewModel {
  const recordedDepegEventCount = reportCard?.rawInputs.depegEventCount ?? null;
  const infrastructures: Infrastructure[] = coin.infrastructures ?? [];
  const chainCount = coinData?.chains?.length ?? 0;
  const blacklistStatus = getResolvedBlacklistStatus(coin.id, reportCard);
  const passport = {
    coin,
    chainCount,
    blacklistStatus,
    resolvedMechanismArchetype,
    mintAuthority,
    redemptionBackstop,
    pegScoreResult,
    isNavToken,
  };
  const primaryComparisonPage = getPrimaryStaticComparisonLinkForCoin(coin.id);
  const compareHref = primaryComparisonPage?.href ?? buildLiveCompareUrl([coin.id]);
  const benchmarkSymbol = primaryComparisonPage?.benchmarkSymbol ?? null;

  const effectivePegScore = resolveEffectivePegScore(isNavToken, pegScoreResult);

  const earlyPegScore =
    effectivePegScore !== null && pegScoreResult !== null && pegScoreResult.trackingSpanDays < 30;

  const pegScoreDisplay = buildPegScoreDisplay(isNavToken, pegScoreResult, recordedDepegEventCount);
  const liqDisplay = buildLiquidityDisplay(liquidityData);
  const excessYieldDisplay = buildExcessYieldDisplay(yieldRanking);
  const performanceVsUsdDisplay = buildPerformanceVsUsdDisplay(performanceVsUsd1y);
  const dewsDisplay = buildDewsDisplay(stressSignal);
  const pegScoreAccent = buildPegScoreAccent(pegScoreResult);
  const liqAccent = buildLiquidityAccent(liquidityData);
  const dewsAccent = buildDewsAccent(stressSignal);
  const limitedDepegCoverageNote = buildLimitedDepegCoverageNote(coinData, isNavToken, pegScoreResult, deviationBps);

  const tertiaryMetrics = buildTertiaryMetrics(
    dewsDisplay,
    dewsAccent,
    pegScoreDisplay,
    pegScoreAccent,
    liqDisplay,
    liqAccent,
    excessYieldDisplay,
    performanceVsUsdDisplay,
  );

  const passportItems = buildHeroPassportItems(passport);

  const subjectCaseStudy = CASE_STUDY_CLIENT_BY_COIN_ID[coin.id];
  const caseStudyCallout: HeroCaseStudyCalloutViewModel | null = subjectCaseStudy
    ? {
        href: `/learn/case-studies/${subjectCaseStudy.slug}/`,
        title: subjectCaseStudy.title,
        outcomeLabel: CASE_STUDY_OUTCOME_LABELS[subjectCaseStudy.outcome],
        outcomeChipClass: CASE_STUDY_OUTCOME_CHIPS[subjectCaseStudy.outcome],
      }
    : null;

  const signalRailItems = buildSignalRailItems(reportCard, isNavToken, effectivePegScore, liquidityData, dewsDisplay);

  return {
    coin,
    coinData,
    logoSrc,
    reportCard,
    verdict,
    variantParent,
    variantKind,
    variantChipClass: variantKind ? getVariantDisplay(variantKind).chipClass : null,
    infrastructures,
    header: {
      coinId: coin.id,
      compareHref,
      benchmarkSymbol,
    },
    price: {
      pegRef,
      deviationBps,
      gaugeDeviationBps,
      pegReferenceUnavailable,
      isNavToken,
      limitedDepegCoverageNote,
    },
    market: { ...buildMarketTrends(mcap, prevDay, prevWeek, prevMonth), supply },
    peg: {
      earlyPegScore,
      trackingSpanDays: pegScoreResult?.trackingSpanDays ?? 0,
      activeDepeg: pegScoreResult?.activeDepeg === true,
    },
    tertiaryMetrics,
    desktopTertiaryMetrics: tertiaryMetrics.filter((metric) => !MOBILE_ONLY_TERTIARY_KEYS.has(metric.key)),
    signalRailItems,
    passportItems,
    caseStudyCallout,
  };
}

function resolveMintAuthorityDecentralizationDrag(
  reportCard: ReportCard | null | undefined,
): MintAuthorityDecentralizationDragViewModel | null {
  const item = reportCard?.dimensions?.decentralization?.detailItems?.find(
    (candidate) => candidate.label === "Mint authority",
  );
  if (!item?.detail) return null;
  const drag = Number.parseInt(item.detail, 10);
  if (!Number.isFinite(drag) || drag >= 0) return null;

  return {
    value: item.detail,
    detail: item.value,
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

  const coinData = listData.peggedAssets?.find((candidate) => candidate.id === id);
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
  const variantRelationship = getClientVariantRelationship(id);
  const variantParent = getClientVariantParent(id);
  const childVariants = getClientVariants(id);
  const reserves = supplemental.reserves.live ?? getReserves(coin);
  const mintAuthority = buildMintAuthorityDetailViewModel(coin);
  const mintAuthorityDecentralizationDrag = resolveMintAuthorityDecentralizationDrag(reportCard);
  const stressBand =
    featureAvailability.stressSignal && isThreatBand(featureAvailability.stressSignal.band)
      ? featureAvailability.stressSignal.band
      : null;
  const verdict = deriveStablecoinVerdict({
    status: coin.status,
    reportCardGrade: reportCard?.overallGrade ?? null,
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
    reportCardUpdatedAt: resolveReportCardSnapshotUpdatedAtMs(reportCards),
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
    earliestTrackingDate: market.earliestTrackingDate,
    reserves,
    reserveFetchError: supplemental.reserves.error ?? null,
    supplyError: supplyHistory.error,
    staleQueries: buildStaleQueryInputs(queries),
    verdict,
    mintAuthority,
    mintAuthorityDecentralizationDrag,
  };
}
