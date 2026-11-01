import type { NativeSupplyCheckpoints } from "@shared/types/stablecoin-live-summary";
import type { DetailQuote } from "@/lib/stablecoin-detail-view-model-types";
import { CASE_STUDY_OUTCOME_CHIPS, CASE_STUDY_OUTCOME_LABELS } from "@/lib/case-study-outcomes";
import { CASE_STUDY_CLIENT_BY_COIN_ID } from "@/lib/case-study-client-index";
import { getResolvedBlacklistStatus } from "@shared/lib/blacklist-status";
import { deriveDepegSignal } from "@shared/lib/depeg-signals";
import { isObservedPrice } from "@shared/lib/pricing-source-policy";
import { buildComparePrefillUrl, getPrimaryStaticComparisonLinkForCoin } from "@/lib/compare-links";
import { isQuietDeviationsEnabled } from "@/lib/feature-flags";
import { getScoreColor, pegScoreColor } from "@/lib/severity-colors";
import type { SavedSafetyAssessment } from "@/lib/api";
import {
  buildDewsAccent,
  buildDewsBandAccent,
  buildDewsDisplay,
  buildExcessYieldDisplay,
  buildLimitedDepegCoverageNote,
  buildLiquidityAccent,
  buildLiquidityDisplay,
  buildLiquidityScoreAccent,
  buildPegScoreAccent,
  buildPegScoreDisplay,
  buildPerformanceVsUsdDisplay,
  buildSavedDewsDisplay,
  buildSavedLiquidityDisplay,
  formatPoolCount,
  formatSavedAssessmentAsOf,
  HERO_MUTED_CLASS,
  HERO_PENDING_DEWS_DISPLAY,
  HERO_PENDING_DISPLAY,
  HERO_NEGATIVE_TREND_CLASS,
  HERO_POSITIVE_TREND_CLASS,
  type HeroDewsDisplay,
  type HeroDisplayValue,
} from "@/lib/stablecoin-detail-hero-metrics";
import type { MintAuthorityDetailViewModel } from "@/lib/stablecoin-detail-mint-authority-view-model";
import {
  buildHeroPassportItems,
  type HeroPassportCoin,
  type HeroPassportItemViewModel,
} from "@/lib/stablecoin-detail-passport";
import { REPORT_CARD_GRADE_COLORS } from "@shared/lib/classification";
import type { StablecoinVerdict } from "@shared/lib/stablecoin-verdict";
import type { StablecoinClientMeta } from "@shared/lib/stablecoins/client-registry";
import { getVariantDisplay } from "@shared/lib/variant-display";
import { roundForDisplay } from "@shared/lib/format";
import type {
  DexLiquidityData,
  Infrastructure,
  MechanismArchetype,
  PegSummaryCoin,
  RedemptionBackstopEntry,
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
  methodologyTopic?: "dewsBand" | "pegScore" | "liquidityScore" | "excessYield";
  display: HeroDisplayValue | HeroDewsDisplay;
  accentClass?: string;
}

export interface HeroSignalRailItemViewModel {
  key: "safety" | "peg" | "liquidity" | "dews";
  label: string;
  primary: string;
  secondary: string | null;
  /** The release date of a saved value ("as of 2026-10-22"). */
  note?: string;
  href: string;
  colorClass: string;
  /** The live read is still in its first fetch: a neutral placeholder. */
  pending?: true;
}

export interface HeroCaseStudyCalloutViewModel {
  href: string;
  title: string;
  outcomeLabel: string;
  outcomeChipClass: string;
}

export interface HeroCardViewModel {
  coin: StablecoinMeta;
  coinData: DetailQuote;
  logoSrc?: string;
  reportCard: V9ConsumerCard | null;
  /** The release's dated grade while the live report card is pending; null otherwise. */
  savedGrade: SavedSafetyAssessment | null;
  verdict: StablecoinVerdict;
  variantParent?: StablecoinClientMeta | null;
  variantKind?: VariantKind | null;
  variantChipClass: string | null;
  infrastructures: Infrastructure[];
  header: { coinId: string; compareHref: string; benchmarkSymbol: string | null };
  price: {
    pegRef: number | null;
    deviationBps: number | null;
    pegReferenceUnavailable: boolean;
    isNavToken: boolean;
    limitedDepegCoverageNote: string | null;
  };
  market: {
    mcap: number | null;
    supply: number | null;
    safePrevDay: number | null;
    prevDayTrendClass: string;
    supplyTrend: HeroSupplyTrendViewModel;
  };
  peg: { activeDepeg: boolean };
  tertiaryMetrics: HeroTertiaryMetricViewModel[];
  desktopTertiaryMetrics: HeroTertiaryMetricViewModel[];
  signalRailItems: HeroSignalRailItemViewModel[];
  passportItems: HeroPassportItemViewModel[];
  caseStudyCallout: HeroCaseStudyCalloutViewModel | null;
}

/**
 * 7D/30D token-supply deltas. `current` and both anchors come from the native token-count
 * series, never from USD market-cap history, so non-$1 prices cannot leak into the ratio.
 */
export interface HeroSupplyTrendViewModel {
  current: number | null;
  safePrevWeek: number | null;
  safePrevMonth: number | null;
  hasPrevMonth: boolean;
  prevWeekTrendClass: string;
  prevMonthTrendClass: string;
}

export interface BuildHeroCardViewModelParams {
  coin: HeroPassportCoin;
  coinData: DetailQuote;
  logoSrc?: string;
  isNavToken: boolean;
  mcap: number | null;
  supply: number | null;
  prevDay: number | null;
  nativeSupply: NativeSupplyCheckpoints | null;
  performanceVsUsd1y: number | null;
  pegRef: number | null;
  deviationBps: number | null;
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
  /** The build snapshot's dated scores-latest values, shown while their live read is pending. */
  savedAssessment?: SavedSafetyAssessment | null;
  /** Live reads still in their first fetch (the prerender included): placeholders, never "unavailable". */
  pendingReads?: HeroPendingReads;
}

export interface HeroPendingReads {
  reportCard?: boolean;
  stress?: boolean;
  liquidity?: boolean;
  peg?: boolean;
  yield?: boolean;
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
  // A change that prints as 0.00% is neutral, whatever its unrounded sign.
  if (previousValue > 0 && roundForDisplay(((currentValue - previousValue) / previousValue) * 100, 2) === 0) {
    return HERO_MUTED_CLASS;
  }
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

function buildSupplyTrend(nativeSupply: NativeSupplyCheckpoints | null, supply: number | null): HeroSupplyTrendViewModel {
  // Positive trends keep the compact projection's paired clock/checkpoints. An observed
  // exhausted supply is zero in either basis and must not resurrect an older positive sample.
  const current = supply === 0 ? 0 : nativeSupply?.current ?? null;
  const safePrevWeek = current == null ? null : posOrNull(nativeSupply?.prevWeek ?? null);
  const safePrevMonth = current == null ? null : posOrNull(nativeSupply?.prevMonth ?? null);
  return {
    current,
    safePrevWeek,
    safePrevMonth,
    hasPrevMonth: safePrevMonth !== null,
    prevWeekTrendClass: getTrendClass(current !== null && safePrevWeek !== null, current ?? 0, safePrevWeek ?? 0),
    prevMonthTrendClass: getTrendClass(current !== null && safePrevMonth !== null, current ?? 0, safePrevMonth ?? 0),
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
    { key: "excess-yield", label: "30d Excess", methodologyTopic: "excessYield", display: excessYieldDisplay },
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
  {
    savedGrade,
    pegPending,
    liquidityFallback,
  }: {
    /** The release's dated grade while the live report card is pending. */
    savedGrade: SavedSafetyAssessment | null;
    pegPending: boolean;
    /** The saved release score or the pending placeholder, without live liquidity data. */
    liquidityFallback: HeroDisplayValue | null;
  },
): HeroSignalRailItemViewModel[] {
  const liveLiquidity = liquidityData !== undefined || liquidityFallback === null;
  return [
    reportCard || !savedGrade?.grade
      ? {
          key: "safety",
          label: "Safety",
          primary: reportCard?.grade ?? "—",
          secondary: reportCard?.score != null ? `${reportCard.score}/100` : null,
          href: "#report-card",
          colorClass: reportCard?.grade ? REPORT_CARD_GRADE_COLORS[reportCard.grade] : HERO_MUTED_CLASS,
        }
      : {
          key: "safety",
          label: "Safety",
          primary: savedGrade.grade,
          secondary: savedGrade.score != null ? `${savedGrade.score}/100` : null,
          note: formatSavedAssessmentAsOf(savedGrade.asOfMs),
          href: "#report-card",
          colorClass: REPORT_CARD_GRADE_COLORS[savedGrade.grade],
        },
    {
      key: "peg",
      label: "Peg",
      primary: effectivePegScore != null ? String(effectivePegScore) : isNavToken ? "NAV" : pegPending ? "" : "—",
      secondary: null,
      href: "#report-card",
      colorClass: effectivePegScore != null ? pegScoreColor(effectivePegScore) : HERO_MUTED_CLASS,
      ...(effectivePegScore == null && !isNavToken && pegPending ? { pending: true as const } : {}),
    },
    liveLiquidity
      ? {
          key: "liquidity",
          label: "Liquidity",
          primary: liquidityData?.liquidityScore != null ? String(Math.round(liquidityData.liquidityScore)) : "—",
          secondary: liquidityData?.poolCount != null ? formatPoolCount(liquidityData.poolCount) : null,
          href: "#liquidity",
          colorClass: liquidityData?.liquidityScore != null ? getScoreColor(liquidityData.liquidityScore) : HERO_MUTED_CLASS,
        }
      : {
          key: "liquidity",
          label: "Liquidity",
          primary: liquidityFallback.value,
          secondary: liquidityFallback.sub ?? null,
          href: "#liquidity",
          colorClass: liquidityFallback.color,
          ...(liquidityFallback.pending ? { pending: true as const } : {}),
        },
    {
      key: "dews",
      label: "DEWS",
      primary: dewsDisplay.value,
      secondary: dewsDisplay.sub ?? null,
      href: "#report-card",
      colorClass: dewsDisplay.color,
      ...(dewsDisplay.pending ? { pending: true as const } : {}),
    },
  ];
}

/**
 * The headline pairs one price with the deviation that price implies. The
 * peg-summary deviation can come from a different observation than the live
 * summary's displayed price, so derive the reader-facing bps from the shown
 * price whenever both it and the peg reference are observed.
 */
export function resolveHeadlineDeviationBps(
  coinData: Pick<DetailQuote, "price" | "priceSource" | "priceObservedAtMode">,
  pegRef: number | null,
  publishedDeviationBps: number | null,
  pegReferenceUnavailable: boolean,
  isNavToken: boolean,
): number | null {
  const price = coinData.price;
  if (
    isNavToken
    || pegReferenceUnavailable
    || !isObservedPrice(coinData)
    || price == null
    || !Number.isFinite(price)
    || price <= 0
    || pegRef == null
    || !Number.isFinite(pegRef)
    || pegRef <= 0
  ) {
    return publishedDeviationBps;
  }
  return deriveDepegSignal(price, pegRef)?.bps ?? publishedDeviationBps;
}

export function buildStablecoinDetailHeroViewModel({
  coin,
  coinData,
  logoSrc,
  isNavToken,
  mcap,
  supply,
  prevDay,
  nativeSupply,
  performanceVsUsd1y,
  pegRef,
  deviationBps,
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
  savedAssessment = null,
  pendingReads = {},
}: BuildHeroCardViewModelParams): HeroCardViewModel {
  const infrastructures: Infrastructure[] = coin.infrastructures ?? [];
  const blacklistStatus = getResolvedBlacklistStatus(coin.id);
  const primaryComparisonPage = getPrimaryStaticComparisonLinkForCoin(coin.id);
  const effectivePegScore = resolveEffectivePegScore(isNavToken, pegScoreResult);
  // NAV tokens and frozen archives have no live peg/DEWS reading to wait for.
  const awaitsSignals = !isNavToken && coin.status !== "frozen";
  const pegPending = awaitsSignals && pegScoreResult === null && pendingReads.peg === true;
  const pegScoreDisplay = pegPending ? HERO_PENDING_DISPLAY : buildPegScoreDisplay(
    isNavToken,
    pegScoreResult,
    null,
  );
  // Without live data, a pending read shows the dated release value or a placeholder.
  const liquidityFallback = liquidityData === undefined && pendingReads.liquidity === true
    ? buildSavedLiquidityDisplay(savedAssessment) ?? HERO_PENDING_DISPLAY
    : null;
  const liquidityDisplay = liquidityFallback ?? buildLiquidityDisplay(liquidityData);
  const savedDews = stressSignal === null && awaitsSignals && pendingReads.stress === true
    ? buildSavedDewsDisplay(savedAssessment) ?? HERO_PENDING_DEWS_DISPLAY
    : null;
  const dewsDisplay = savedDews ?? buildDewsDisplay(stressSignal);
  const excessYieldDisplay = yieldRanking === null && pendingReads.yield === true
    ? HERO_PENDING_DISPLAY
    : buildExcessYieldDisplay(yieldRanking);
  const performanceVsUsdDisplay = buildPerformanceVsUsdDisplay(performanceVsUsd1y);
  const savedGrade = pendingReads.reportCard === true && !reportCard && savedAssessment?.grade ? savedAssessment : null;
  const tertiaryMetrics = buildTertiaryMetrics(
    dewsDisplay,
    savedDews ? buildDewsBandAccent(savedDews.band) : buildDewsAccent(stressSignal),
    pegScoreDisplay,
    buildPegScoreAccent(pegScoreResult),
    liquidityDisplay,
    liquidityFallback ? buildLiquidityScoreAccent(savedAssessment?.liquidityScore ?? null) : buildLiquidityAccent(liquidityData),
    excessYieldDisplay,
    performanceVsUsdDisplay,
  );
  const subjectCaseStudy = CASE_STUDY_CLIENT_BY_COIN_ID[coin.id];
  const caseStudyCallout: HeroCaseStudyCalloutViewModel | null = subjectCaseStudy ? {
    href: `/learn/case-studies/${subjectCaseStudy.slug}/`,
    title: subjectCaseStudy.title,
    outcomeLabel: CASE_STUDY_OUTCOME_LABELS[subjectCaseStudy.outcome],
    outcomeChipClass: CASE_STUDY_OUTCOME_CHIPS[subjectCaseStudy.outcome],
  } : null;
  // A partial-coverage current supply (K-031) is not comparable with the prior day.
  const safePrevDay = coinData.supplyExcludedChains?.length ? null : posOrNull(prevDay);
  const headlineDeviationBps = resolveHeadlineDeviationBps(
    coinData,
    pegRef,
    deviationBps,
    pegReferenceUnavailable,
    isNavToken,
  );

  return {
    coin,
    coinData,
    logoSrc,
    reportCard,
    savedGrade,
    verdict,
    variantParent,
    variantKind,
    variantChipClass: variantKind ? getVariantDisplay(variantKind).chipClass : null,
    infrastructures,
    header: {
      coinId: coin.id,
      compareHref: primaryComparisonPage?.href ?? buildComparePrefillUrl([coin.id]),
      benchmarkSymbol: primaryComparisonPage?.benchmarkSymbol ?? null,
    },
    price: {
      pegRef,
      deviationBps: headlineDeviationBps,
      pegReferenceUnavailable,
      isNavToken,
      limitedDepegCoverageNote: buildLimitedDepegCoverageNote(coinData, isNavToken, pegScoreResult, headlineDeviationBps),
    },
    market: {
      mcap,
      supply,
      safePrevDay,
      prevDayTrendClass: getTrendClass(mcap !== null && safePrevDay !== null, mcap ?? 0, safePrevDay ?? 0),
      supplyTrend: buildSupplyTrend(nativeSupply, supply),
    },
    peg: { activeDepeg: pegScoreResult?.activeDepeg === true },
    tertiaryMetrics,
    desktopTertiaryMetrics: tertiaryMetrics.filter((metric) => !MOBILE_ONLY_TERTIARY_KEYS.has(metric.key)),
    signalRailItems: buildSignalRailItems(reportCard, isNavToken, effectivePegScore, liquidityData, dewsDisplay, {
      savedGrade,
      pegPending,
      liquidityFallback,
    }),
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
