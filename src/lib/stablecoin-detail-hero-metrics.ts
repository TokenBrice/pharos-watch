import type {
  DexLiquidityData,
  PegSummaryCoin,
  StablecoinData,
  StressSignalEntry,
  YieldRanking,
} from "@shared/types";
import { DEPEG_EVENT_MIN_SUPPLY_USD, DEPEG_THRESHOLD_BPS, DEPEG_THRESHOLD_BPS_NON_USD } from "@shared/lib/depeg-config";
import { formatCurrency, formatSignedPercent } from "@shared/lib/format";
import { THREAT_BAND_LABELS, THREAT_BAND_STYLES, isThreatBand, type ThreatBand } from "@shared/lib/classification";
import { getScoreColor, pegScoreColor } from "@/lib/severity-colors";
import { getYieldBenchmarkGapReferenceText, getYieldBenchmarkGapUnavailableText } from "@/lib/yield-benchmark";

export const HERO_POSITIVE_TREND_CLASS = "text-green-700 dark:text-green-400";
export const HERO_NEGATIVE_TREND_CLASS = "text-red-700 dark:text-red-400";
export const HERO_MUTED_CLASS = "text-muted-foreground";

export interface HeroDisplayValue {
  value: string;
  sub?: string;
  color: string;
}

export interface HeroDewsDisplay {
  value: string;
  band: ThreatBand | null;
  sub?: string;
  color: string;
}

function buildPegScoreEventLine(
  pegScoreResult: PegSummaryCoin | null,
  recordedDepegEventCount: number | null,
): string | null {
  if (!pegScoreResult) return null;
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
      sub: pegScoreEventLine ?? `${pegScoreResult.pegPct.toFixed(1)}% at peg`,
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

export function buildLiquidityDisplay(liquidityData: DexLiquidityData | undefined): HeroDisplayValue {
  const liquidityScore = liquidityData?.liquidityScore ?? null;
  return liquidityData == null || (liquidityScore === null && liquidityData.poolCount === 0)
    ? { value: "—", color: HERO_MUTED_CLASS }
    : {
        value: String(Math.round(liquidityScore ?? 0)),
        sub: `${liquidityData.poolCount} pools`,
        color: getScoreColor(liquidityScore ?? 0),
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
  if (score < 50) return "border-l-2 border-l-red-500";
  if (score < 70) return "border-l-2 border-l-amber-500";
  return undefined;
}

export function buildLiquidityAccent(liquidityData: DexLiquidityData | undefined): string | undefined {
  const score = liquidityData?.liquidityScore;
  if (score == null) return undefined;
  if (score < 30) return "border-l-2 border-l-red-500";
  if (score < 50) return "border-l-2 border-l-amber-500";
  return undefined;
}

export function buildDewsAccent(stressSignal: StressSignalEntry | null): string | undefined {
  if (!stressSignal || !isThreatBand(stressSignal.band)) return undefined;
  if (stressSignal.band === "DANGER") return "border-l-2 border-l-red-500";
  if (stressSignal.band === "WARNING") return "border-l-2 border-l-orange-500";
  return undefined;
}

export function buildLimitedDepegCoverageNote(
  coinData: StablecoinData,
  isNavToken: boolean,
  pegScoreResult: PegSummaryCoin | null,
  deviationBps: number,
): string | null {
  const depegThresholdBps = coinData.pegType === "peggedUSD" ? DEPEG_THRESHOLD_BPS : DEPEG_THRESHOLD_BPS_NON_USD;
  return !isNavToken &&
    pegScoreResult?.depegEventCoverageLimited === true &&
    Math.abs(deviationBps) >= depegThresholdBps
    ? `Below ${formatCurrency(DEPEG_EVENT_MIN_SUPPLY_USD)} live-event floor. Deviation is shown, but event history may stay empty.`
    : null;
}
