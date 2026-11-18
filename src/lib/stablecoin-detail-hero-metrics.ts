import type {
  DexLiquidityData,
} from "@shared/types/dex-liquidity";
import type {
  PegSummaryCoin,
} from "@shared/types/peg";
import type {
  StressSignalEntry,
} from "@shared/types/stress";
import type {
  YieldRanking,
} from "@shared/types/yield";
import { PEG_SCORE_EARLY_MAX_DAYS } from "@shared/lib/peg-score";
import { projectTopDriver } from "@shared/lib/safety-score-v9/public-top-driver";
import type { SafetyScoreV9CurrentCard } from "@shared/types/safety-score-v9-public";
import { DEPEG_EVENT_MIN_SUPPLY_USD, DEPEG_THRESHOLD_BPS, DEPEG_THRESHOLD_BPS_NON_USD } from "@shared/lib/depeg-config";
import { formatCurrency, formatIsoDate, formatIsoTimestamp, formatSignedPercent } from "@shared/lib/format";
import {
  THREAT_BAND_LABELS,
  THREAT_BAND_STYLES,
  isThreatBand,
  type ThreatBand,
} from "@shared/lib/classification";
import { getScoreColor, pegScoreColor } from "@/lib/severity-colors";
import type { SavedSafetyAssessment } from "@/lib/api";
import { getYieldBenchmarkGapReferenceText, getYieldBenchmarkGapUnavailableText } from "@/lib/yield-benchmark";

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

const SAFETY_PILLAR_LABELS: Record<"backing" | "exit" | "control", string> = {
  backing: "Backing",
  exit: "Exit",
  control: "Economic Control",
};

/** The one reason a reader needs beside a grade: the binding cap, the peg multiplier that moved it, else the weakest pillar. */
export interface SafetyVerdictLine {
  lead: string;
  detail: string;
}

/**
 * The grade's one reason in words. The branch comes from `projectTopDriver`,
 * the rule Compare, the Screener and the Safety Score cards share; the
 * peg-bound wording is the score waterfall's ("Peg performance · x0.510 on
 * pillar quality 52/100").
 */
export function buildSafetyVerdictLine(card: SafetyScoreV9CurrentCard | null): SafetyVerdictLine | null {
  const driver = card ? projectTopDriver(card) : null;
  if (!card || !driver || driver.value === null) return null;
  if (driver.kind === "cap-bound") {
    return driver.reason ? { lead: `Capped at ${driver.value}`, detail: driver.reason.trim().replace(/\.$/, "") } : null;
  }
  if (driver.kind === "peg-bound") {
    const quality = driver.quality === undefined ? "" : ` on pillar quality ${driver.quality.toFixed(0)}/100`;
    return { lead: "Peg performance", detail: `x${driver.value.toFixed(3)}${quality}` };
  }
  const weakest = card.weakestPillar;
  if (driver.kind === "pillar-bound" && weakest) {
    return { lead: "Weakest pillar", detail: `${SAFETY_PILLAR_LABELS[weakest.pillar]} ${Math.round(weakest.score)}/100` };
  }
  return null;
}

/** DEWS is a precursor: once a depeg is confirmed it is no longer the reading that matters. */
export const HERO_DEWS_SUPERSEDED = "Superseded by the live depeg";

/** Why a price-derived reading cannot stand: peg-summary has no usable current price. */
export const HERO_NO_USABLE_PRICE = "No usable price";

/**
 * A Peg or DEWS reading that must not read calm keeps its value, with the
 * reason as its sub-line, and drops its tone unless that tone already warns
 * (`keepTone`): a caveat never calms a warning. A dash or a pending read is
 * unchanged.
 */
export function muteHeroDisplay<T extends HeroDisplayValue | HeroDewsDisplay>(display: T, reason: string | null, keepTone = false): T {
  return reason && !display.pending && display.value !== "—"
    ? { ...display, sub: reason, color: keepTone ? display.color : HERO_MUTED_CLASS }
    : display;
}

/** "3 of 8 signals" when a live DEWS score was computed from fewer than half its signals; null otherwise. */
export function formatDewsCoverageGap(stressSignal: Pick<StressSignalEntry, "signals"> | null): string | null {
  const signals = Object.values(stressSignal?.signals ?? {});
  const available = signals.filter((signal) => signal.available).length;
  return available * 2 < signals.length ? `${available} of ${signals.length} signals` : null;
}

/** "as of 2026-10-22": the release date a saved value was published. */
export function formatSavedAssessmentAsOf(asOfMs: number): string {
  return `as of ${formatIsoDate(asOfMs / 1000)}`;
}

/** "as of 2026-11-14 22:03 UTC": the live report card's own update clock; null without one. */
export function formatLiveCardAsOf(updatedAtSec: number | null | undefined): string | null {
  if (updatedAtSec == null || !Number.isFinite(updatedAtSec) || updatedAtSec <= 0) return null;
  return `as of ${formatIsoTimestamp(updatedAtSec).slice(0, 16).replace("T", " ")} UTC`;
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

/**
 * The peg tile's figure. Its sub-line is the time at peg: the incident count
 * belongs to the passport's Record field alone. A NAV token has no peg, so its
 * tile carries no value and the hero leaves it out. A score withheld for want
 * of a usable price reads NR, like one too new to rate.
 */
export function buildPegScoreDisplay(
  isNavToken: boolean,
  pegScoreResult: PegSummaryCoin | null,
): HeroDisplayValue {
  const tooNewForPegScore =
    !isNavToken &&
    pegScoreResult !== null &&
    pegScoreResult.pegScore === null &&
    pegScoreResult.trackingSpanDays > 0 &&
    pegScoreResult.trackingSpanDays < 7;

  if (isNavToken) return { value: "—", color: HERO_MUTED_CLASS };
  if (pegScoreResult?.pegScore != null) {
    const early = pegScoreResult.trackingSpanDays < PEG_SCORE_EARLY_MAX_DAYS;
    return {
      value: String(pegScoreResult.pegScore),
      sub: early
        ? `Early score · ${pegScoreResult.trackingSpanDays}d tracked`
        : pegScoreResult.pegPct == null ? undefined : `${pegScoreResult.pegPct.toFixed(1)}% at peg`,
      color: pegScoreColor(pegScoreResult.pegScore),
    };
  }
  if (pegScoreResult?.currentPriceUnavailable === true) {
    return { value: "NR", sub: HERO_NO_USABLE_PRICE, color: HERO_MUTED_CLASS };
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
    // A spread against T-bills is performance, not risk: neutral ink, the
    // sign carries the direction.
    color: "text-foreground",
  };
}

export function buildPerformanceVsUsdDisplay(performanceVsUsd1y: number | null): HeroDisplayValue | null {
  if (performanceVsUsd1y === null) return null;
  // A currency or commodity move against USD is context, not risk: neutral
  // ink, the sign carries the direction.
  return { value: formatSignedPercent(performanceVsUsd1y), color: "text-foreground" };
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
