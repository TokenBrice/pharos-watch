import type { NativeSupplyCheckpoints } from "@shared/types/stablecoin-live-summary";
import type { DetailQuote } from "@/lib/stablecoin-detail-view-model-types";
import { CASE_STUDY_OUTCOME_CHIPS, CASE_STUDY_OUTCOME_LABELS } from "@/lib/case-study-outcomes";
import { CASE_STUDY_CLIENT_BY_COIN_ID } from "@/lib/case-study-client-index";
import { getResolvedBlacklistStatus } from "@shared/lib/blacklist-status";
import { buildComparePrefillUrl, getPrimaryStaticComparisonLinkForCoin } from "@/lib/compare-links";
import { isQuietDeviationsEnabled } from "@/lib/feature-flags";
import { getScoreColor } from "@/lib/severity-colors";
import type { SavedSafetyAssessment } from "@/lib/api";
import {
  buildDewsDisplay,
  buildExcessYieldDisplay,
  buildLimitedDepegCoverageNote,
  buildLiquidityDisplay,
  buildPegScoreDisplay,
  buildPerformanceVsUsdDisplay,
  buildSavedDewsDisplay,
  buildSavedLiquidityDisplay,
  formatDewsCoverageGap,
  formatPoolCount,
  formatSavedAssessmentAsOf,
  HERO_DEWS_SUPERSEDED,
  HERO_MUTED_CLASS,
  HERO_NO_USABLE_PRICE,
  HERO_PENDING_DEWS_DISPLAY,
  HERO_PENDING_DISPLAY,
  muteHeroDisplay,
  type HeroDewsDisplay,
  type HeroDisplayValue,
} from "@/lib/stablecoin-detail-hero-metrics";
import type { MintAuthorityDetailViewModel } from "@/lib/stablecoin-detail-mint-authority-view-model";
import {
  buildHeroPassportItems,
  type HeroPassportCoin,
  type HeroPassportItemViewModel,
} from "@/lib/stablecoin-detail-passport";
import { DIRECTION_TONE_CLASSES, getPegScoreTier, isDewsAlertBand, REPORT_CARD_GRADE_COLORS } from "@shared/lib/classification";
import type { CoinState } from "@shared/lib/coin-state";
import type { StablecoinVerdict } from "@shared/lib/stablecoin-verdict";
import { CLIENT_TRACKED_META_BY_ID, type StablecoinClientMeta } from "@shared/lib/stablecoins/client-registry";
import { isTokenizedFundId } from "@shared/lib/stablecoins/listing-governance";
import { getVariantDisplay } from "@shared/lib/variant-display";
import { roundForDisplay } from "@shared/lib/format";
import type {
  DexLiquidityData,
} from "@shared/types/dex-liquidity";
import type {
  Infrastructure,
  MechanismArchetype,
  VariantKind,
} from "@shared/types/stablecoin-taxonomy";
import type {
  PegSummaryCoin,
} from "@shared/types/peg";
import type {
  RedemptionBackstopEntry,
} from "@shared/types/redemption";
import type {
  StablecoinMeta,
} from "@shared/types/stablecoin-meta-schemas";
import type {
  StressSignalEntry,
} from "@shared/types/stress";
import type {
  YieldRanking,
} from "@shared/types/yield";
import type { V9ConsumerCard } from "@/lib/safety-score-v9-consumers";

export interface HeroTertiaryMetricViewModel {
  key: "dews" | "peg-score" | "liquidity" | "excess-yield" | "performance-vs-usd";
  label: "DEWS" | "Peg Score" | "Liquidity" | "30d Excess" | "1Y vs USD";
  mobileLabel?: "Peg" | "Liq";
  methodologyTopic?: "dewsBand" | "pegScore" | "liquidityScore" | "excessYield";
  display: HeroDisplayValue | HeroDewsDisplay;
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
  /** The coin's highest exceptional state (`resolveCoinStates`): the hero chip names it instead of the verdict. */
  state: CoinState | null;
  variantParent?: StablecoinClientMeta | null;
  variantKind?: VariantKind | null;
  variantChipClass: string | null;
  infrastructures: Infrastructure[];
  header: { coinId: string; compareHref: string; benchmarkSymbol: string | null };
  price: {
    pegRef: number | null;
    deviationBps: number | null;
    pegReferenceUnavailable: boolean;
    /** The peg's reference market was shut at the observation: the deviation is held. */
    referenceNote: string | null;
    isNavToken: boolean;
    limitedDepegCoverageNote: string | null;
    /** Why the price cannot read as a calm peg reading (no usable price, or an inherited quote under a critical/paused state). */
    caveat: string | null;
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
  /** Passport facts whose live read is still in flight: the strip holds their slot so nothing reflows when they land. */
  passportPendingKeys: HeroPassportItemViewModel["key"][];
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
  referenceNote: string | null;
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
  /** Exceptional states, highest precedence first; the Peg and DEWS tiles read them. */
  coinStates?: readonly CoinState[];
  /** No usable current price (peg row unavailable or unusable, or the `missing` source). */
  priceUnusable?: boolean;
  /** The parent whose quote the price is derived from (`priceDerivation.inheritedFrom`). */
  priceInheritedFrom?: string | null;
}

export interface HeroPendingReads {
  reportCard?: boolean;
  stress?: boolean;
  liquidity?: boolean;
  peg?: boolean;
  yield?: boolean;
  /** The redemption-backstop read (the passport's Redeemability fact), deferred or in flight. */
  redemption?: boolean;
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
  return currentValue > previousValue ? DIRECTION_TONE_CLASSES.up : DIRECTION_TONE_CLASSES.down;
}

function resolveEffectivePegScore(isNavToken: boolean, pegScoreResult: PegSummaryCoin | null): number | null {
  return isNavToken || pegScoreResult?.pegScore == null ? null : pegScoreResult.pegScore;
}

function buildSupplyTrend(nativeSupply: NativeSupplyCheckpoints | null): HeroSupplyTrendViewModel {
  // Keep the current native quantity paired with its own checkpoints.
  const current = nativeSupply?.current ?? null;
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
  pegScoreDisplay: HeroDisplayValue,
  liquidityDisplay: HeroDisplayValue,
  excessYieldDisplay: HeroDisplayValue,
  performanceVsUsdDisplay: HeroDisplayValue | null,
): HeroTertiaryMetricViewModel[] {
  return [
    { key: "dews", label: "DEWS", methodologyTopic: "dewsBand", display: dewsDisplay },
    { key: "peg-score", label: "Peg Score", mobileLabel: "Peg", methodologyTopic: "pegScore", display: pegScoreDisplay },
    { key: "liquidity", label: "Liquidity", mobileLabel: "Liq", methodologyTopic: "liquidityScore", display: liquidityDisplay },
    { key: "excess-yield", label: "30d Excess", methodologyTopic: "excessYield", display: excessYieldDisplay },
    ...(performanceVsUsdDisplay
      ? [{ key: "performance-vs-usd" as const, label: "1Y vs USD" as const, display: performanceVsUsdDisplay }]
      : []),
  ];
}

function buildSignalRailItems(
  reportCard: V9ConsumerCard | null,
  isNavToken: boolean,
  pegDisplay: HeroDisplayValue,
  liquidityData: DexLiquidityData | undefined,
  dewsDisplay: HeroDewsDisplay,
  {
    savedGrade,
    pegCaveat,
    dewsHref,
    liquidityFallback,
  }: {
    /** The release's dated grade while the live report card is pending. */
    savedGrade: SavedSafetyAssessment | null;
    /** Why the peg score cannot read calm (see `muteHeroDisplay`); null when it can. */
    pegCaveat: string | null;
    /** A live depeg supersedes DEWS: its row links to the resolver instead. */
    dewsHref: string;
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
      // The Peg tile's figure and tone; its sub-line names only the tile's caveat, never the time at peg.
      key: "peg",
      label: "Peg",
      primary: isNavToken ? "NAV" : pegDisplay.value,
      secondary: pegCaveat !== null && pegDisplay.sub === pegCaveat ? pegCaveat : null,
      href: "#report-card",
      colorClass: pegDisplay.color,
      ...(pegDisplay.pending ? { pending: true as const } : {}),
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
      href: dewsHref,
      colorClass: dewsDisplay.color,
      ...(dewsDisplay.pending ? { pending: true as const } : {}),
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
  nativeSupply,
  performanceVsUsd1y,
  pegRef,
  deviationBps,
  pegReferenceUnavailable,
  referenceNote,
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
  coinStates = [],
  priceUnusable = false,
  priceInheritedFrom = null,
}: BuildHeroCardViewModelParams): HeroCardViewModel {
  const infrastructures: Infrastructure[] = coin.infrastructures ?? [];
  const blacklistStatus = getResolvedBlacklistStatus(coin.id);
  const primaryComparisonPage = getPrimaryStaticComparisonLinkForCoin(coin.id);
  const effectivePegScore = resolveEffectivePegScore(isNavToken, pegScoreResult);
  // NAV tokens and frozen archives have no live peg/DEWS reading to wait for.
  const awaitsSignals = !isNavToken && coin.status !== "frozen";
  const pegPending = awaitsSignals && pegScoreResult === null && pendingReads.peg === true;
  const stateKinds = new Set(coinStates.map((state) => state.kind));
  const liveDepeg = stateKinds.has("depeg");
  // Why a price-derived reading cannot read calm: no usable price, or a price
  // inherited from a parent quote while a current notice says the exit is closed.
  const priceCaveat = priceUnusable
    ? HERO_NO_USABLE_PRICE
    : priceInheritedFrom && (stateKinds.has("critical") || stateKinds.has("paused"))
      ? `Price inherited from ${CLIENT_TRACKED_META_BY_ID.get(priceInheritedFrom)?.symbol ?? priceInheritedFrom}`
      : null;
  // The caveat calms only a calm score: a weak one keeps its tier colour beside the reason.
  const pegScoreDisplay = muteHeroDisplay(
    pegPending ? HERO_PENDING_DISPLAY : buildPegScoreDisplay(isNavToken, pegScoreResult),
    priceCaveat,
    effectivePegScore != null && getPegScoreTier(effectivePegScore) !== "good",
  );
  // Without live data, a pending read shows the dated release value or a placeholder.
  const liquidityFallback = liquidityData === undefined && pendingReads.liquidity === true
    ? buildSavedLiquidityDisplay(savedAssessment) ?? HERO_PENDING_DISPLAY
    : null;
  const liquidityDisplay = liquidityFallback ?? buildLiquidityDisplay(liquidityData);
  const savedDews = stressSignal === null && awaitsSignals && pendingReads.stress === true
    ? buildSavedDewsDisplay(savedAssessment) ?? HERO_PENDING_DEWS_DISPLAY
    : null;
  const dewsBase = savedDews ?? buildDewsDisplay(stressSignal);
  // DEWS is a precursor score: a confirmed live depeg supersedes it at any band. Below
  // ALERT, a reading without a usable price or computed from fewer than half its signals
  // is no all-clear.
  const dewsDisplay = muteHeroDisplay(
    dewsBase,
    liveDepeg
      ? HERO_DEWS_SUPERSEDED
      : dewsBase.band && !isDewsAlertBand(dewsBase.band)
        ? priceCaveat ?? (savedDews ? null : formatDewsCoverageGap(stressSignal))
        : null,
  );
  const excessYieldDisplay = yieldRanking === null && pendingReads.yield === true
    ? HERO_PENDING_DISPLAY
    : buildExcessYieldDisplay(yieldRanking);
  const performanceVsUsdDisplay = buildPerformanceVsUsdDisplay(performanceVsUsd1y);
  const isTokenizedFund = isTokenizedFundId(coin.id);
  const savedGrade = !isTokenizedFund && pendingReads.reportCard === true && !reportCard && savedAssessment?.grade
    ? savedAssessment
    : null;
  const tertiaryMetrics = buildTertiaryMetrics(
    dewsDisplay,
    pegScoreDisplay,
    liquidityDisplay,
    excessYieldDisplay,
    performanceVsUsdDisplay,
  );
  const redemptionPending = coin.status !== "frozen" && redemptionBackstop === null && pendingReads.redemption === true;
  const passportPendingKeys: HeroPassportItemViewModel["key"][] = [
    ...(redemptionPending ? ["redeemability" as const] : []),
    ...(pegPending ? ["record" as const] : []),
  ];
  const subjectCaseStudy = CASE_STUDY_CLIENT_BY_COIN_ID[coin.id];
  const caseStudyCallout: HeroCaseStudyCalloutViewModel | null = subjectCaseStudy ? {
    href: `/learn/case-studies/${subjectCaseStudy.slug}/`,
    title: subjectCaseStudy.title,
    outcomeLabel: CASE_STUDY_OUTCOME_LABELS[subjectCaseStudy.outcome],
    outcomeChipClass: CASE_STUDY_OUTCOME_CHIPS[subjectCaseStudy.outcome],
  } : null;
  // A partial-coverage current supply (K-031) is not comparable with the prior day.
  const safePrevDay = coinData.supplyExcludedChains?.length ? null : posOrNull(prevDay);

  return {
    coin,
    coinData,
    logoSrc,
    reportCard,
    savedGrade,
    verdict,
    state: coinStates[0] ?? null,
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
      deviationBps,
      pegReferenceUnavailable,
      referenceNote,
      isNavToken,
      limitedDepegCoverageNote: buildLimitedDepegCoverageNote(coinData, isNavToken, pegScoreResult, deviationBps),
      caveat: priceCaveat,
    },
    market: {
      mcap,
      supply,
      safePrevDay,
      prevDayTrendClass: getTrendClass(mcap !== null && safePrevDay !== null, mcap ?? 0, safePrevDay ?? 0),
      supplyTrend: buildSupplyTrend(nativeSupply),
    },
    peg: { activeDepeg: pegScoreResult?.activeDepeg === true },
    tertiaryMetrics,
    desktopTertiaryMetrics: tertiaryMetrics.filter((metric) => !MOBILE_ONLY_TERTIARY_KEYS.has(metric.key)),
    signalRailItems: buildSignalRailItems(isTokenizedFund ? null : reportCard, isNavToken, pegScoreDisplay, liquidityData, dewsDisplay, {
      savedGrade,
      pegCaveat: priceCaveat,
      dewsHref: liveDepeg ? "#depeg-resolver" : "#report-card",
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
    passportPendingKeys,
    caseStudyCallout,
  };
}
