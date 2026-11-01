import type {
  DexLiquidityData,
  PegSummaryCoin,
  StressSignalEntry,
  YieldRanking,
} from "@shared/types";
import { DEPEG_EVENT_MIN_SUPPLY_USD, DEPEG_THRESHOLD_BPS, DEPEG_THRESHOLD_BPS_NON_USD } from "@shared/lib/depeg-config";
import { formatCurrency, formatIsoDate, formatSignedPercent } from "@shared/lib/format";
import {
  DIRECTION_TONE_CLASSES,
  QUALITY_TIER_3_CLASSES,
  THREAT_BAND_ACCENT_CLASSES,
  THREAT_BAND_LABELS,
  THREAT_BAND_STYLES,
  isThreatBand,
  type ThreatBand,
} from "@shared/lib/classification";
import { getScoreColor, pegScoreColor } from "@/lib/severity-colors";
import type { SavedSafetyAssessment } from "@/lib/api";
import { getYieldBenchmarkGapReferenceText, getYieldBenchmarkGapUnavailableText } from "@/lib/yield-benchmark";

export const HERO_POSITIVE_TREND_CLASS = DIRECTION_TONE_CLASSES.up;
export const HERO_NEGATIVE_TREND_CLASS = DIRECTION_TONE_CLASSES.down;
export const HERO_MUTED_CLASS = "text-muted-foreground";

export interface HeroDisplayValue {
  value: string;
  sub?: string;
  color: string;
  /** The live read is still in its first fetch (prerender included): a neutral placeholder, not "unavailable". */
  pending?: true;
}

export interface HeroDewsDisplay {
  value: string;
  band: ThreatBand | null;
  sub?: string;
  color: string;
  pending?: true;
}

export const HERO_PENDING_DISPLAY: HeroDisplayValue = { value: "", color: HERO_MUTED_CLASS, pending: true };
export const HERO_PENDING_DEWS_DISPLAY: HeroDewsDisplay = { ...HERO_PENDING_DISPLAY, band: null };

/** "as of 2026-10-22": the release date a saved value was published. */
export function formatSavedAssessmentAsOf(asOfMs: number): string {
  return `as of ${formatIsoDate(asOfMs / 1000)}`;
}

/** A saved release DEWS band, dated; null when the release has none. */
export function buildSavedDewsDisplay(saved: SavedSafetyAssessment | null): HeroDewsDisplay | null {
  if (!saved?.dewsBand) return null;
  return {
    value: THREAT_BAND_LABELS[saved.dewsBand],
    band: saved.dewsBand,
    sub: saved.dewsScore != null
      ? `${Math.round(saved.dewsScore)}/100 · ${formatSavedAssessmentAsOf(saved.asOfMs)}`
      : formatSavedAssessmentAsOf(saved.asOfMs),
    color: THREAT_BAND_STYLES[saved.dewsBand].textCls,
  };
}

/** A saved release liquidity score, dated; null when the release has none. */
export function buildSavedLiquidityDisplay(saved: SavedSafetyAssessment | null): HeroDisplayValue | null {
  if (saved?.liquidityScore == null) return null;
  return {
    value: String(Math.round(saved.liquidityScore)),
    sub: formatSavedAssessmentAsOf(saved.asOfMs),
    color: getScoreColor(saved.liquidityScore),
  };
}

function buildPegScoreEventLine(
  pegScoreResult: PegSummaryCoin | null,
  recordedDepegEventCount: number | null,
): string | null {
  if (!pegScoreResult) return null;
  // A coverage-limited event count is unmeasured, not an observed zero (R1).
  if (pegScoreResult.depegEventCoverageLimited === true) return null;
  const scoreWindowCount = pegScoreResult.eventCount;
  const totalRecorded = recordedDepegEventCount;
  if (totalRecorded == null || totalRecorded === scoreWindowCount) {
    return `${scoreWindowCount.toLocaleString()} incident${scoreWindowCount !== 1 ? "s" : ""}`;
  }
  return `${totalRecorded.toLocaleString()} recorded · ${scoreWindowCount.toLocaleString()} scored incidents`;
}

export function buildPegScoreDisplay(
  isNavToken: boolean,
  pegScoreResult: PegSummaryCoin | null,
  recordedDepegEventCount: number | null,
): HeroDisplayValue {
  const tooNewForPegScore =
    !isNavToken &&
    pegScoreResult !== null &&
    pegScoreResult.pegScore === null &&
    pegScoreResult.trackingSpanDays > 0 &&
    pegScoreResult.trackingSpanDays < 7;
  const pegScoreEventLine = buildPegScoreEventLine(pegScoreResult, recordedDepegEventCount);

  if (isNavToken) return { value: "NAV", sub: "Token", color: HERO_MUTED_CLASS };
  if (pegScoreResult?.pegScore != null) {
    return {
      value: String(pegScoreResult.pegScore),
      sub: pegScoreEventLine ?? (pegScoreResult.pegPct == null ? "Peg coverage unavailable" : `${pegScoreResult.pegPct.toFixed(1)}% at peg`),
      color: pegScoreColor(pegScoreResult.pegScore),
    };
  }
  if (tooNewForPegScore) {
    return {
      value: "NR",
      sub: `${pegScoreResult?.trackingSpanDays ?? 0}d tracked`,
      color: HERO_MUTED_CLASS,
    };
  }
  return { value: "—", color: HERO_MUTED_CLASS };
}

/** "2,671 pools": grouped digits; a missing count still renders as before. */
export function formatPoolCount(poolCount: number | undefined): string {
  return `${typeof poolCount === "number" ? poolCount.toLocaleString("en-US") : poolCount} pools`;
}

export function buildLiquidityDisplay(liquidityData: DexLiquidityData | undefined): HeroDisplayValue {
  if (!liquidityData) return { value: "—", color: HERO_MUTED_CLASS };
  const liquidityScore = liquidityData.liquidityScore;
  return liquidityScore === null
    ? {
        value: "—",
        sub: formatPoolCount(liquidityData.poolCount),
        color: HERO_MUTED_CLASS,
      }
    : {
        value: String(Math.round(liquidityScore)),
        sub: formatPoolCount(liquidityData.poolCount),
        color: getScoreColor(liquidityScore),
      };
}

export function buildExcessYieldDisplay(yieldRanking: YieldRanking | null): HeroDisplayValue {
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
}

export function buildPerformanceVsUsdDisplay(performanceVsUsd1y: number | null): HeroDisplayValue | null {
  if (performanceVsUsd1y === null) return null;
  return {
    value: formatSignedPercent(performanceVsUsd1y),
    color:
      performanceVsUsd1y > 0
        ? HERO_POSITIVE_TREND_CLASS
        : performanceVsUsd1y < 0
          ? HERO_NEGATIVE_TREND_CLASS
          : HERO_MUTED_CLASS,
  };
}

export function buildDewsDisplay(stressSignal: StressSignalEntry | null): HeroDewsDisplay {
  return stressSignal && isThreatBand(stressSignal.band)
    ? {
        value: THREAT_BAND_LABELS[stressSignal.band],
        band: stressSignal.band,
        sub: `${Math.round(stressSignal.score)}/100`,
        color: THREAT_BAND_STYLES[stressSignal.band].textCls,
      }
    : { value: "—", band: null, color: HERO_MUTED_CLASS };
}

export function buildPegScoreAccent(pegScoreResult: PegSummaryCoin | null): string | undefined {
  const score = pegScoreResult?.pegScore;
  if (score == null) return undefined;
  if (score < 50) return QUALITY_TIER_3_CLASSES.bad.borderL;
  if (score < 70) return QUALITY_TIER_3_CLASSES.watch.borderL;
  return undefined;
}

export function buildLiquidityAccent(liquidityData: DexLiquidityData | undefined): string | undefined {
  return buildLiquidityScoreAccent(liquidityData?.liquidityScore ?? null);
}

export function buildLiquidityScoreAccent(score: number | null): string | undefined {
  if (score == null) return undefined;
  if (score < 30) return QUALITY_TIER_3_CLASSES.bad.borderL;
  if (score < 50) return QUALITY_TIER_3_CLASSES.watch.borderL;
  return undefined;
}

export function buildDewsAccent(stressSignal: StressSignalEntry | null): string | undefined {
  return buildDewsBandAccent(stressSignal?.band ?? null);
}

export function buildDewsBandAccent(band: string | null): string | undefined {
  if (!band || !isThreatBand(band)) return undefined;
  if (band === "DANGER" || band === "WARNING") {
    return THREAT_BAND_ACCENT_CLASSES[band].borderL;
  }
  return undefined;
}

export function buildLimitedDepegCoverageNote(
  coinData: { pegType: string },
  isNavToken: boolean,
  pegScoreResult: PegSummaryCoin | null,
  deviationBps: number | null,
): string | null {
  const depegThresholdBps = coinData.pegType === "peggedUSD" ? DEPEG_THRESHOLD_BPS : DEPEG_THRESHOLD_BPS_NON_USD;
  return !isNavToken &&
    pegScoreResult?.depegEventCoverageLimited === true &&
    deviationBps != null &&
    Math.abs(deviationBps) >= depegThresholdBps
    ? `Below ${formatCurrency(DEPEG_EVENT_MIN_SUPPLY_USD)} live-event floor. Deviation is shown, but event history may stay empty.`
    : null;
}
