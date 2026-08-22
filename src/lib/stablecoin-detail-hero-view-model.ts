import { CASE_STUDY_OUTCOME_CHIPS, CASE_STUDY_OUTCOME_LABELS } from "@/lib/case-study-outcomes";
import { CASE_STUDY_CLIENT_BY_COIN_ID } from "@/lib/case-study-client-index";
import { getResolvedBlacklistStatus } from "@/lib/blacklist-status";
import { buildLiveCompareUrl, getPrimaryStaticComparisonLinkForCoin } from "@/lib/compare-links";
import { isQuietDeviationsEnabled } from "@/lib/feature-flags";
import { getScoreColor, pegScoreColor } from "@/lib/severity-colors";
import {
  buildDewsAccent,
  buildDewsDisplay,
  buildExcessYieldDisplay,
  buildLimitedDepegCoverageNote,
  buildLiquidityAccent,
  buildLiquidityDisplay,
  buildPegScoreAccent,
  buildPegScoreDisplay,
  buildPerformanceVsUsdDisplay,
  HERO_MUTED_CLASS,
  HERO_NEGATIVE_TREND_CLASS,
  HERO_POSITIVE_TREND_CLASS,
  type HeroDewsDisplay,
  type HeroDisplayValue,
} from "@/lib/stablecoin-detail-hero-metrics";
import type { MintAuthorityDetailViewModel } from "@/lib/stablecoin-detail-mint-authority-view-model";
import { buildHeroPassportItems, type HeroPassportItemViewModel } from "@/lib/stablecoin-detail-passport";
import { REPORT_CARD_GRADE_COLORS } from "@shared/lib/report-cards";
import type { StablecoinVerdict } from "@shared/lib/stablecoin-verdict";
import type { StablecoinClientMeta } from "@shared/lib/stablecoins/client-registry";
import { getVariantDisplay } from "@shared/lib/variant-display";
import type {
  DexLiquidityData,
  Infrastructure,
  MechanismArchetype,
  PegSummaryCoin,
  RedemptionBackstopEntry,
  StablecoinData,
  StablecoinMeta,
  StressSignalEntry,
  VariantKind,
  YieldRanking,
} from "@shared/types";
import type { V9ConsumerCard } from "@/lib/safety-score-v9-consumers";

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
  reportCard: V9ConsumerCard | null;
  verdict: StablecoinVerdict;
  variantParent?: StablecoinClientMeta | null;
  variantKind?: VariantKind | null;
  variantChipClass: string | null;
  infrastructures: Infrastructure[];
  header: { coinId: string; compareHref: string; benchmarkSymbol: string | null };
  price: {
    pegRef: number | null;
    deviationBps: number | null;
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
  peg: { activeDepeg: boolean };
  tertiaryMetrics: HeroTertiaryMetricViewModel[];
  desktopTertiaryMetrics: HeroTertiaryMetricViewModel[];
  signalRailItems: HeroSignalRailItemViewModel[];
  passportItems: HeroPassportItemViewModel[];
  caseStudyCallout: HeroCaseStudyCalloutViewModel | null;
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
  pegRef: number | null;
  deviationBps: number | null;
  gaugeDeviationBps: number;
  pegReferenceUnavailable: boolean;
  pegScoreResult: PegSummaryCoin | null;
  liquidityData: DexLiquidityData | undefined;
  yieldRanking: YieldRanking | null;
  stressSignal: StressSignalEntry | null;
  reportCard: V9ConsumerCard | null;
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
    const percentChange = Math.abs((currentValue - previousValue) / previousValue) * 100;
    if (percentChange < 0.5) return HERO_MUTED_CLASS;
  }
  return currentValue >= previousValue ? HERO_POSITIVE_TREND_CLASS : HERO_NEGATIVE_TREND_CLASS;
}

function resolveEffectivePegScore(isNavToken: boolean, pegScoreResult: PegSummaryCoin | null): number | null {
  return isNavToken || pegScoreResult?.pegScore == null ? null : pegScoreResult.pegScore;
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
  liquidityDisplay: HeroDisplayValue,
  liquidityAccent: string | undefined,
  excessYieldDisplay: HeroDisplayValue,
  performanceVsUsdDisplay: HeroDisplayValue | null,
): HeroTertiaryMetricViewModel[] {
  return [
    { key: "dews", label: "DEWS", methodologyTopic: "dewsBand", display: dewsDisplay, accentClass: dewsAccent },
    { key: "peg-score", label: "Peg Score", mobileLabel: "Peg", methodologyTopic: "pegScore", display: pegScoreDisplay, accentClass: pegScoreAccent },
    { key: "liquidity", label: "Liquidity", mobileLabel: "Liq", methodologyTopic: "liquidityScore", display: liquidityDisplay, accentClass: liquidityAccent },
    { key: "excess-yield", label: "30d Excess", methodologyTopic: "pys", display: excessYieldDisplay },
    ...(performanceVsUsdDisplay
      ? [{ key: "performance-vs-usd" as const, label: "1Y vs USD" as const, display: performanceVsUsdDisplay }]
      : []),
  ];
}

function buildSignalRailItems(
  reportCard: V9ConsumerCard | null,
  isNavToken: boolean,
  effectivePegScore: number | null,
  liquidityData: DexLiquidityData | undefined,
  dewsDisplay: HeroDewsDisplay,
): HeroSignalRailItemViewModel[] {
  return [
    {
      key: "safety",
      label: "Safety",
      primary: reportCard?.grade ?? "—",
      secondary: reportCard?.score != null ? `${reportCard.score}/100` : null,
      href: "#report-card",
      colorClass: reportCard?.grade ? REPORT_CARD_GRADE_COLORS[reportCard.grade] : HERO_MUTED_CLASS,
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
      colorClass: liquidityData?.liquidityScore != null ? getScoreColor(liquidityData.liquidityScore) : HERO_MUTED_CLASS,
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
  const infrastructures: Infrastructure[] = coin.infrastructures ?? [];
  const blacklistStatus = getResolvedBlacklistStatus(coin.id);
  const primaryComparisonPage = getPrimaryStaticComparisonLinkForCoin(coin.id);
  const effectivePegScore = resolveEffectivePegScore(isNavToken, pegScoreResult);
  const pegScoreDisplay = buildPegScoreDisplay(
    isNavToken,
    pegScoreResult,
    null,
  );
  const liquidityDisplay = buildLiquidityDisplay(liquidityData);
  const dewsDisplay = buildDewsDisplay(stressSignal);
  const performanceVsUsdDisplay = buildPerformanceVsUsdDisplay(performanceVsUsd1y);
  const tertiaryMetrics = buildTertiaryMetrics(
    dewsDisplay,
    buildDewsAccent(stressSignal),
    pegScoreDisplay,
    buildPegScoreAccent(pegScoreResult),
    liquidityDisplay,
    buildLiquidityAccent(liquidityData),
    buildExcessYieldDisplay(yieldRanking),
    performanceVsUsdDisplay,
  );
  const subjectCaseStudy = CASE_STUDY_CLIENT_BY_COIN_ID[coin.id];
  const caseStudyCallout: HeroCaseStudyCalloutViewModel | null = subjectCaseStudy ? {
    href: `/learn/case-studies/${subjectCaseStudy.slug}/`,
    title: subjectCaseStudy.title,
    outcomeLabel: CASE_STUDY_OUTCOME_LABELS[subjectCaseStudy.outcome],
    outcomeChipClass: CASE_STUDY_OUTCOME_CHIPS[subjectCaseStudy.outcome],
  } : null;

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
      compareHref: primaryComparisonPage?.href ?? buildLiveCompareUrl([coin.id]),
      benchmarkSymbol: primaryComparisonPage?.benchmarkSymbol ?? null,
    },
    price: {
      pegRef,
      deviationBps,
      gaugeDeviationBps,
      pegReferenceUnavailable,
      isNavToken,
      limitedDepegCoverageNote: buildLimitedDepegCoverageNote(coinData, isNavToken, pegScoreResult, deviationBps),
    },
    market: { ...buildMarketTrends(mcap, prevDay, prevWeek, prevMonth), supply },
    peg: { activeDepeg: pegScoreResult?.activeDepeg === true },
    tertiaryMetrics,
    desktopTertiaryMetrics: tertiaryMetrics.filter((metric) => !MOBILE_ONLY_TERTIARY_KEYS.has(metric.key)),
    signalRailItems: buildSignalRailItems(reportCard, isNavToken, effectivePegScore, liquidityData, dewsDisplay),
    passportItems: buildHeroPassportItems({
      coin,
      chainCount: coinData.chains?.length ?? 0,
      blacklistStatus,
      resolvedMechanismArchetype,
      mintAuthority,
      redemptionBackstop,
      pegScoreResult,
      isNavToken,
    }),
    caseStudyCallout,
  };
}
