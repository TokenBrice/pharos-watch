/**
 * Cemetery below-fold view model: one pure, SSR-deterministic pass over the
 * cemetery entries that feeds the key facts, cause band, charts, pattern
 * headlines and FAQ. Callers pass the entries (server: `CEMETERY_ENTRIES`).
 *
 * Integrity rules:
 * - A missing, zero, negative or non-finite peak is "not recorded" (`null`),
 *   never 0. Sums and medians run over recorded peaks only and every recorded
 *   peak aggregate carries `knownCount`.
 * - `asOf` is the latest recorded `deathDate`, never the wall clock.
 * - Headline counts use the full set; every trend claim must also hold on the
 *   curated records alone, because the tracked archive grew with Pharos's own
 *   coverage.
 * - Copy says "peak market cap" and "failed or discontinued"; "failure" never
 *   labels a regulatory or abandoned exit.
 */
import { CAUSE_META, CAUSE_ORDER, type CauseOfDeath } from "@shared/lib/cause-of-death";
import { parseCemeteryDeathDate } from "@shared/lib/cemetery";
import {
  formatCurrency,
  formatDeathDate,
  formatPercentFromRatio,
  formatUtcDayLabel,
} from "@shared/lib/format";
import { median } from "@shared/lib/stats";
import { MECHANISM_ARCHETYPE_VALUES, type MechanismArchetype } from "@shared/types/core";
import {
  CEMETERY_PEAK_BUCKET_KEYS,
  peakBucketOf,
  type CemeteryPeakBucket,
  type CemeteryRegisterFilters,
} from "@/lib/cemetery-selection";

/** Structural input: satisfied by `CemeteryEntry` before and after the optional T1/T2 fields land. */
export interface CemeteryStatsInput {
  readonly id: string;
  readonly name: string;
  readonly symbol: string;
  readonly causeOfDeath: CauseOfDeath;
  /** `YYYY-MM` or `YYYY-MM-DD`. */
  readonly deathDate: string;
  readonly peakMcap?: number | null;
  readonly pegCurrency: string;
  /** `true` marks the tracked archive (frozen registry rows); anything else is curated. */
  readonly archivedDataAvailable?: boolean;
  /** UTC `YYYY-MM-DD` the record entered Pharos. */
  readonly recordedAt?: string;
  readonly mechanismArchetype?: string | null;
}

/** Length of the trailing and prior comparison windows, in calendar months. */
const CEMETERY_TRAILING_WINDOW_MONTHS = 12;
/** Last year of the "early record" era used by the algorithmic pattern. */
const CEMETERY_ALGORITHMIC_ERA_END_YEAR = 2022;
/** A curated-only count counts as rising (or falling) only past both thresholds. */
const TREND_MIN_RELATIVE_CHANGE = 0.25;
const TREND_MIN_ABSOLUTE_CHANGE = 5;
const ALGORITHMIC_EARLY_MIN_SHARE = 0.5;
const ALGORITHMIC_LATE_MAX_SHARE = 0.1;
const TOP_TWO_MIN_SHARE = 0.5;
const LABELLED_DOT_COUNT = 5;

export type CemeteryDatePrecision = "day" | "month";
export type CemeteryTrendDirection = "rising" | "falling" | "flat";

export interface CemeteryAsOf {
  /** The latest recorded `deathDate`, verbatim. */
  date: string;
  year: number;
  month: number;
  /** Day of month for day-precision dates, else null. */
  day: number | null;
  precision: CemeteryDatePrecision;
  /** "Aug 27, 2026" (day precision) or "Aug 2026" (month precision). */
  label: string;
  /** "Aug 2026". */
  monthLabel: string;
}

export interface CemeteryWindowCounts {
  /** First month of the window, `YYYY-MM`. */
  startMonth: string;
  /** Last month of the window, `YYYY-MM`. */
  endMonth: string;
  months: number;
  total: number;
  tracked: number;
  curated: number;
}

export interface CemeteryTopTwo {
  ids: [string, string];
  symbols: [string, string];
  names: [string, string];
  peaks: [number, number];
  sum: number;
  /** `sum / recordedTotal`, 0–1. */
  share: number;
  recordedTotal: number;
  knownCount: number;
  total: number;
}

export interface CemeteryPeakSummary {
  /** Sum of recorded peaks; null when none is recorded. */
  recordedTotal: number | null;
  median: number | null;
  knownCount: number;
  unrecordedCount: number;
  /** Records in the `1b-plus` bucket. */
  atLeastOneBillionCount: number;
}

export interface CemeteryCurationTrend {
  trailing: number;
  prior: number;
  direction: CemeteryTrendDirection;
}

export interface CemeteryKeyFacts {
  trailing12: CemeteryWindowCounts;
  prior12: CemeteryWindowCounts;
  /** Curated-only change between the two windows; the only authority for "more/fewer deaths" claims. */
  curatedTrend: CemeteryCurationTrend;
  /** Null when fewer than two peaks are recorded. */
  topTwo: CemeteryTopTwo | null;
  medianPeak: { value: number | null; knownCount: number };
  atLeastOneBillionCount: number;
  trackedCount: number;
}

export interface CemeteryCauseStats {
  cause: CauseOfDeath;
  count: number;
  /** `count / total`, 0–1. */
  share: number;
  /** Null when no record of this cause has a recorded peak. */
  recordedPeakSum: number | null;
  /** Share of the recorded peak total, 0–1; null when this cause has no recorded peak. */
  peakShare: number | null;
  medianPeak: number | null;
  largest: { id: string; name: string; symbol: string; peak: number } | null;
  knownCount: number;
  unrecordedCount: number;
}

export interface CemeteryYearStats {
  year: number;
  total: number;
  byCause: Record<CauseOfDeath, number>;
  /** Tracked-archive records per cause; each value is at most `byCause[cause]`. */
  trackedByCause: Record<CauseOfDeath, number>;
  tracked: number;
  curated: number;
  /** Null prints "n/r" (no recorded peak) or "none" (no records) depending on `total`. */
  medianPeak: number | null;
  recordedPeakSum: number | null;
  recordedPeakCount: number;
  /** The as-of year when the data stops before its end. */
  partial: boolean;
}

export interface CemeteryPeakBucketCount {
  key: CemeteryPeakBucket;
  count: number;
}

export interface CemeteryPeakDot {
  id: string;
  symbol: string;
  name: string;
  peak: number;
  deathDate: string;
  /** Global top five by peak. */
  labelled: boolean;
}

export interface CemeteryPeakLane {
  cause: CauseOfDeath;
  /** Recorded peaks only, peak descending (keyboard order). */
  dots: CemeteryPeakDot[];
  median: number | null;
  /** Number of plotted dots (recorded peaks). */
  n: number;
  unrecordedCount: number;
}

export interface CemeteryPeakByCauseSeries {
  lanes: CemeteryPeakLane[];
  labelledIds: string[];
  /** Records without a recorded peak, not plotted. */
  unplottedCount: number;
  /** Smallest and largest recorded peak; null when none is recorded. */
  extent: { min: number; max: number } | null;
}

export interface CemeteryMechanismStats {
  counts: { archetype: MechanismArchetype; count: number }[];
  mappedCount: number;
  /** Records without a (known) `mechanismArchetype`. */
  unmappedCount: number;
}

export interface CemeteryEraShare {
  count: number;
  total: number;
}

export interface CemeteryAlgorithmicEra {
  cutoffYear: number;
  through: CemeteryEraShare;
  since: CemeteryEraShare;
  curatedThrough: CemeteryEraShare;
  curatedSince: CemeteryEraShare;
}

export interface CemeteryCounterpartyRecent {
  /** First year of the recent window (Jan of as-of year − 1). */
  recentFromYear: number;
  /** The two calendar years before the recent window. */
  priorYears: [number, number];
  curatedRecent: CemeteryEraShare;
  curatedPrior: CemeteryEraShare;
}

export type CemeteryPatternKey =
  | "algorithmic-early"
  | "abandoned-most-common"
  | "counterparty-rising"
  | "top-two-concentration"
  | "largest-not-collapse"
  | "deaths-more-frequent";

export interface CemeteryPattern {
  key: CemeteryPatternKey;
  headline: string;
  body: string;
  /** Register view behind the pattern; pass to `buildRegisterHref`. */
  registerFilter: CemeteryRegisterFilters;
}

export interface CemeteryStats {
  total: number;
  trackedCount: number;
  curatedCount: number;
  firstYear: number;
  latestYear: number;
  asOf: CemeteryAsOf;
  /** Latest `recordedAt`; null when no record carries one. */
  updatedAt: string | null;
  /** Records whose `deathDate` is day-precise vs month-precise; sums to `total`. */
  datePrecision: { day: number; month: number };
  peak: CemeteryPeakSummary;
  keyFacts: CemeteryKeyFacts;
  /** In `CAUSE_ORDER`. */
  causes: CemeteryCauseStats[];
  /** Continuous `firstYear` → `latestYear`; years without records have `total: 0`. */
  years: CemeteryYearStats[];
  /** In `CEMETERY_PEAK_BUCKET_KEYS` order. */
  peakBuckets: CemeteryPeakBucketCount[];
  peakByCause: CemeteryPeakByCauseSeries;
  mechanisms: CemeteryMechanismStats;
  algorithmicEra: CemeteryAlgorithmicEra;
  counterpartyRecent: CemeteryCounterpartyRecent;
  /** Guarded pattern headlines; a pattern whose guard fails is absent. */
  patterns: CemeteryPattern[];
  /** "2018–2026 · each with cause, date, obituary and source". */
  heroSubline: string;
}

export interface CemeteryFaqItem {
  question: string;
  answer: string;
}

interface ParsedEntry {
  entry: CemeteryStatsInput;
  year: number;
  month: number;
  day: number | null;
  /** `year * 12 + month - 1`. */
  monthIndex: number;
  peak: number | null;
  tracked: boolean;
}

const RECORDED_AT_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Peak market cap as printed across the cemetery ("$48.8M", "$23.5B"). */
export function formatCemeteryPeak(value: number): string {
  return formatCurrency(value, 1);
}

function parseDeathDate(entry: CemeteryStatsInput): { year: number; month: number; day: number | null } {
  const parsed = parseCemeteryDeathDate(entry.deathDate);
  if (parsed?.month == null) {
    throw new Error(`Cemetery entry ${entry.id} has an invalid deathDate "${entry.deathDate}"`);
  }
  return { year: parsed.year, month: parsed.month, day: parsed.day };
}

function monthKey(monthIndex: number): string {
  const year = Math.floor(monthIndex / 12);
  const month = (monthIndex % 12) + 1;
  return `${year}-${String(month).padStart(2, "0")}`;
}

function sum(values: readonly number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

/** Peak descending, id ascending (locale-independent): deterministic for equal peaks. */
function byPeakDesc(a: ParsedEntry, b: ParsedEntry): number {
  return (b.peak ?? 0) - (a.peak ?? 0) || (a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0);
}

function windowCounts(rows: readonly ParsedEntry[], startIndex: number, endIndex: number): CemeteryWindowCounts {
  let tracked = 0;
  let curated = 0;
  for (const row of rows) {
    if (row.monthIndex < startIndex || row.monthIndex > endIndex) continue;
    if (row.tracked) tracked += 1;
    else curated += 1;
  }
  return {
    startMonth: monthKey(startIndex),
    endMonth: monthKey(endIndex),
    months: endIndex - startIndex + 1,
    total: tracked + curated,
    tracked,
    curated,
  };
}

/** `a` rises over `b` only past both the relative and the absolute threshold. */
function exceedsBy(a: number, b: number): boolean {
  return a - b >= TREND_MIN_ABSOLUTE_CHANGE && a >= b * (1 + TREND_MIN_RELATIVE_CHANGE);
}

function trendDirection(trailing: number, prior: number): CemeteryTrendDirection {
  if (exceedsBy(trailing, prior)) return "rising";
  if (exceedsBy(prior, trailing)) return "falling";
  return "flat";
}

function eraShare(rows: readonly ParsedEntry[], inEra: (row: ParsedEntry) => boolean, cause: CauseOfDeath): CemeteryEraShare {
  let count = 0;
  let total = 0;
  for (const row of rows) {
    if (!inEra(row)) continue;
    total += 1;
    if (row.entry.causeOfDeath === cause) count += 1;
  }
  return { count, total };
}

function ratio(share: CemeteryEraShare): number | null {
  return share.total > 0 ? share.count / share.total : null;
}

function algorithmicEarlyHolds(through: CemeteryEraShare, since: CemeteryEraShare): boolean {
  const early = ratio(through);
  const late = ratio(since);
  return early !== null && late !== null && early >= ALGORITHMIC_EARLY_MIN_SHARE && late <= ALGORITHMIC_LATE_MAX_SHARE;
}

function buildAsOf(rows: readonly ParsedEntry[]): CemeteryAsOf {
  let latest = rows[0];
  for (const row of rows) {
    // ISO strings order chronologically; within one month a day-precise date sorts after the bare month.
    if (row.entry.deathDate > latest.entry.deathDate) latest = row;
  }
  const { year, month, day } = latest;
  const monthLabel = formatDeathDate(latest.entry.deathDate.slice(0, 7));
  return {
    date: latest.entry.deathDate,
    year,
    month,
    day,
    precision: day === null ? "month" : "day",
    label: day === null ? monthLabel : formatUtcDayLabel(new Date(Date.UTC(year, month - 1, day))),
    monthLabel,
  };
}

function buildPatterns(stats: Omit<CemeteryStats, "patterns" | "heroSubline">): CemeteryPattern[] {
  const patterns: CemeteryPattern[] = [];
  const { algorithmicEra: era, counterpartyRecent: cp, keyFacts, causes, peak } = stats;

  if (algorithmicEarlyHolds(era.through, era.since) && algorithmicEarlyHolds(era.curatedThrough, era.curatedSince)) {
    patterns.push({
      key: "algorithmic-early",
      headline: "Algorithmic failures belong to the early record",
      body: `Algorithmic failures made up ${era.through.count} of the ${era.through.total} records through ${era.cutoffYear}, and ${era.since.count} of the ${era.since.total} since.`,
      registerFilter: { cause: "algorithmic-failure" },
    });
  }

  const abandoned = causes.find((c) => c.cause === "abandoned");
  if (abandoned && abandoned.count > 0 && causes.every((c) => c.cause === "abandoned" || c.count < abandoned.count)) {
    const medianSentence = abandoned.medianPeak === null
      ? ""
      : ` Their median recorded peak market cap was ${formatCemeteryPeak(abandoned.medianPeak)}.`;
    patterns.push({
      key: "abandoned-most-common",
      headline: "Abandonment is the most common cause",
      body: `${abandoned.count} of ${stats.total} records (${formatPercentFromRatio(abandoned.share, 0)}) ended with the issuer or protocol no longer maintaining the coin.${medianSentence}`,
      registerFilter: { cause: "abandoned" },
    });
  }

  const recentShare = ratio(cp.curatedRecent);
  const priorShare = ratio(cp.curatedPrior);
  if (recentShare !== null && priorShare !== null && recentShare > priorShare) {
    patterns.push({
      key: "counterparty-rising",
      headline: "Counterparty failures are a larger share of recent deaths",
      body: `Among curated records, counterparty failures were ${cp.curatedRecent.count} of ${cp.curatedRecent.total} since January ${cp.recentFromYear} (${formatPercentFromRatio(recentShare, 0)}), against ${cp.curatedPrior.count} of ${cp.curatedPrior.total} in ${cp.priorYears[0]} and ${cp.priorYears[1]} (${formatPercentFromRatio(priorShare, 0)}).`,
      registerFilter: { cause: "counterparty-failure", record: "curated" },
    });
  }

  const topTwo = keyFacts.topTwo;
  if (topTwo && topTwo.share > TOP_TWO_MIN_SHARE) {
    const medianSentence = peak.median === null ? "" : ` The median recorded peak was ${formatCemeteryPeak(peak.median)}.`;
    patterns.push({
      key: "top-two-concentration",
      headline: "Two coins hold most of the recorded peak",
      body: `${topTwo.symbols[0]} (${formatCemeteryPeak(topTwo.peaks[0])}) and ${topTwo.symbols[1]} (${formatCemeteryPeak(topTwo.peaks[1])}) account for ${formatPercentFromRatio(topTwo.share, 1)} of the ${formatCemeteryPeak(topTwo.recordedTotal)} combined peak market cap, recorded for ${topTwo.knownCount} of ${topTwo.total} records.${medianSentence}`,
      registerFilter: { sort: "peak", dir: "desc" },
    });
  }

  // The largest recorded peak was discontinued rather than collapsed: size at the top is not a measure of failure.
  const largestEnded = largestAmong(stats, true);
  const largestCollapse = largestAmong(stats, false);
  if (largestEnded && largestCollapse && largestEnded.peak > largestCollapse.peak) {
    patterns.push({
      key: "largest-not-collapse",
      headline: "The largest coins did not all collapse",
      body: `The largest recorded peak, ${largestEnded.symbol} (${formatCemeteryPeak(largestEnded.peak)}), was ended by ${DISCONTINUED_BY[largestEnded.cause]}; the largest collapse was ${largestCollapse.symbol} (${formatCemeteryPeak(largestCollapse.peak)}).`,
      registerFilter: { sort: "peak", dir: "desc" },
    });
  }

  if (keyFacts.curatedTrend.direction === "rising") {
    const { trailing12, prior12, curatedTrend } = keyFacts;
    patterns.push({
      key: "deaths-more-frequent",
      headline: "Recorded deaths are becoming more frequent",
      body: `Pharos recorded ${trailing12.total} deaths in the ${trailing12.months} months to ${stats.asOf.monthLabel}, against ${prior12.total} in the ${prior12.months} months before. Curated records alone rose from ${curatedTrend.prior} to ${curatedTrend.trailing}, so the rise is not only wider tracking.`,
      registerFilter: { record: "curated" },
    });
  }

  return patterns;
}

export function buildCemeteryStats(entries: readonly CemeteryStatsInput[]): CemeteryStats {
  if (entries.length === 0) throw new Error("buildCemeteryStats needs at least one cemetery entry");

  const rows: ParsedEntry[] = entries.map((entry) => {
    const { year, month, day } = parseDeathDate(entry);
    const peakMcap = entry.peakMcap;
    return {
      entry,
      year,
      month,
      day,
      monthIndex: year * 12 + month - 1,
      peak: typeof peakMcap === "number" && Number.isFinite(peakMcap) && peakMcap > 0 ? peakMcap : null,
      tracked: entry.archivedDataAvailable === true,
    };
  });

  const total = rows.length;
  const trackedCount = rows.filter((row) => row.tracked).length;
  const curatedCount = total - trackedCount;
  const asOf = buildAsOf(rows);
  let firstYear = asOf.year;
  for (const row of rows) if (row.year < firstYear) firstYear = row.year;
  const latestYear = asOf.year;

  let updatedAt: string | null = null;
  for (const { entry } of rows) {
    if (entry.recordedAt && RECORDED_AT_RE.test(entry.recordedAt) && (updatedAt === null || entry.recordedAt > updatedAt)) {
      updatedAt = entry.recordedAt;
    }
  }
  const dayPreciseCount = rows.filter((row) => row.day !== null).length;
  const datePrecision = { day: dayPreciseCount, month: total - dayPreciseCount };

  // Recorded peaks
  const known = rows.filter((row) => row.peak !== null).sort(byPeakDesc);
  const knownPeaks = known.map((row) => row.peak as number);
  const recordedTotal = known.length > 0 ? sum(knownPeaks) : null;
  const medianPeak = median(knownPeaks);
  const bucketCounts = Object.fromEntries(CEMETERY_PEAK_BUCKET_KEYS.map((key) => [key, 0])) as Record<CemeteryPeakBucket, number>;
  for (const row of rows) bucketCounts[peakBucketOf(row.peak)] += 1;
  const atLeastOneBillionCount = bucketCounts["1b-plus"];
  const peak: CemeteryPeakSummary = {
    recordedTotal,
    median: medianPeak,
    knownCount: known.length,
    unrecordedCount: total - known.length,
    atLeastOneBillionCount,
  };

  // Key facts
  const asOfIndex = asOf.year * 12 + asOf.month - 1;
  const trailing12 = windowCounts(rows, asOfIndex - CEMETERY_TRAILING_WINDOW_MONTHS + 1, asOfIndex);
  const prior12 = windowCounts(rows, asOfIndex - 2 * CEMETERY_TRAILING_WINDOW_MONTHS + 1, asOfIndex - CEMETERY_TRAILING_WINDOW_MONTHS);
  const topTwo: CemeteryTopTwo | null = known.length >= 2 && recordedTotal !== null
    ? (() => {
        const [a, b] = [known[0], known[1]];
        const peaks: [number, number] = [a.peak as number, b.peak as number];
        const pairSum = peaks[0] + peaks[1];
        return {
          ids: [a.entry.id, b.entry.id],
          symbols: [a.entry.symbol, b.entry.symbol],
          names: [a.entry.name, b.entry.name],
          peaks,
          sum: pairSum,
          share: pairSum / recordedTotal,
          recordedTotal,
          knownCount: known.length,
          total,
        };
      })()
    : null;
  const keyFacts: CemeteryKeyFacts = {
    trailing12,
    prior12,
    curatedTrend: {
      trailing: trailing12.curated,
      prior: prior12.curated,
      direction: trendDirection(trailing12.curated, prior12.curated),
    },
    topTwo,
    medianPeak: { value: medianPeak, knownCount: known.length },
    atLeastOneBillionCount,
    trackedCount,
  };

  // Causes and chart C lanes
  const labelledIds = known.slice(0, LABELLED_DOT_COUNT).map((row) => row.entry.id);
  const labelledSet = new Set(labelledIds);
  const causes: CemeteryCauseStats[] = [];
  const lanes: CemeteryPeakLane[] = [];
  for (const cause of CAUSE_ORDER) {
    const causeRows = rows.filter((row) => row.entry.causeOfDeath === cause);
    const causeKnown = known.filter((row) => row.entry.causeOfDeath === cause);
    const causePeaks = causeKnown.map((row) => row.peak as number);
    const causeSum = causeKnown.length > 0 ? sum(causePeaks) : null;
    const causeMedian = median(causePeaks);
    const largest = causeKnown[0];
    causes.push({
      cause,
      count: causeRows.length,
      share: causeRows.length / total,
      recordedPeakSum: causeSum,
      peakShare: causeSum !== null && recordedTotal !== null ? causeSum / recordedTotal : null,
      medianPeak: causeMedian,
      largest: largest
        ? { id: largest.entry.id, name: largest.entry.name, symbol: largest.entry.symbol, peak: largest.peak as number }
        : null,
      knownCount: causeKnown.length,
      unrecordedCount: causeRows.length - causeKnown.length,
    });
    lanes.push({
      cause,
      dots: causeKnown.map((row) => ({
        id: row.entry.id,
        symbol: row.entry.symbol,
        name: row.entry.name,
        peak: row.peak as number,
        deathDate: row.entry.deathDate,
        labelled: labelledSet.has(row.entry.id),
      })),
      median: causeMedian,
      n: causeKnown.length,
      unrecordedCount: causeRows.length - causeKnown.length,
    });
  }

  // Years, continuous
  // The as-of year is partial unless the data reaches its last month (or, day-precise, its last day).
  const partialLatest = asOf.month < 12 || (asOf.day !== null && asOf.day < 31);
  const years: CemeteryYearStats[] = [];
  for (let year = firstYear; year <= latestYear; year += 1) {
    const yearRows = rows.filter((row) => row.year === year);
    const byCause = Object.fromEntries(CAUSE_ORDER.map((cause) => [cause, 0])) as Record<CauseOfDeath, number>;
    const trackedByCause = Object.fromEntries(CAUSE_ORDER.map((cause) => [cause, 0])) as Record<CauseOfDeath, number>;
    let tracked = 0;
    const yearPeaks: number[] = [];
    for (const row of yearRows) {
      byCause[row.entry.causeOfDeath] += 1;
      if (row.tracked) {
        tracked += 1;
        trackedByCause[row.entry.causeOfDeath] += 1;
      }
      if (row.peak !== null) yearPeaks.push(row.peak);
    }
    years.push({
      year,
      total: yearRows.length,
      byCause,
      trackedByCause,
      tracked,
      curated: yearRows.length - tracked,
      medianPeak: median(yearPeaks),
      recordedPeakSum: yearPeaks.length > 0 ? sum(yearPeaks) : null,
      recordedPeakCount: yearPeaks.length,
      partial: year === latestYear && partialLatest,
    });
  }

  // Mechanisms
  const mechanismCounts = Object.fromEntries(MECHANISM_ARCHETYPE_VALUES.map((archetype) => [archetype, 0])) as Record<MechanismArchetype, number>;
  let mappedCount = 0;
  for (const { entry } of rows) {
    const archetype = entry.mechanismArchetype;
    // Values outside the enum cannot link to an explainer, so they count as unmapped.
    if (typeof archetype !== "string" || !(MECHANISM_ARCHETYPE_VALUES as readonly string[]).includes(archetype)) continue;
    mechanismCounts[archetype as MechanismArchetype] += 1;
    mappedCount += 1;
  }

  // Era comparisons behind the trend patterns
  const curatedRows = rows.filter((row) => !row.tracked);
  const cutoffYear = CEMETERY_ALGORITHMIC_ERA_END_YEAR;
  const throughCutoff = (row: ParsedEntry) => row.year <= cutoffYear;
  const sinceCutoff = (row: ParsedEntry) => row.year > cutoffYear;
  const algorithmicEra: CemeteryAlgorithmicEra = {
    cutoffYear,
    through: eraShare(rows, throughCutoff, "algorithmic-failure"),
    since: eraShare(rows, sinceCutoff, "algorithmic-failure"),
    curatedThrough: eraShare(curatedRows, throughCutoff, "algorithmic-failure"),
    curatedSince: eraShare(curatedRows, sinceCutoff, "algorithmic-failure"),
  };
  const recentFromYear = asOf.year - 1;
  const priorYears: [number, number] = [recentFromYear - 2, recentFromYear - 1];
  const counterpartyRecent: CemeteryCounterpartyRecent = {
    recentFromYear,
    priorYears,
    curatedRecent: eraShare(curatedRows, (row) => row.year >= recentFromYear, "counterparty-failure"),
    curatedPrior: eraShare(curatedRows, (row) => row.year >= priorYears[0] && row.year <= priorYears[1], "counterparty-failure"),
  };

  const base: Omit<CemeteryStats, "patterns" | "heroSubline"> = {
    total,
    trackedCount,
    curatedCount,
    firstYear,
    latestYear,
    asOf,
    updatedAt,
    datePrecision,
    peak,
    keyFacts,
    causes,
    years,
    peakBuckets: CEMETERY_PEAK_BUCKET_KEYS.map((key) => ({ key, count: bucketCounts[key] })),
    peakByCause: {
      lanes,
      labelledIds,
      unplottedCount: total - known.length,
      extent: known.length > 0 ? { min: knownPeaks[knownPeaks.length - 1], max: knownPeaks[0] } : null,
    },
    mechanisms: {
      counts: MECHANISM_ARCHETYPE_VALUES.map((archetype) => ({ archetype, count: mechanismCounts[archetype] })),
      mappedCount,
      unmappedCount: total - mappedCount,
    },
    algorithmicEra,
    counterpartyRecent,
  };

  return {
    ...base,
    patterns: buildPatterns(base),
    heroSubline: `${firstYear}–${latestYear} · each with cause, date, obituary and source`,
  };
}

/**
 * Causes whose exits are "discontinued", never "failure" or "collapse"; the value
 * names who ended the coin. Every other cause is a collapse.
 */
const DISCONTINUED_BY: Partial<Record<CauseOfDeath, string>> = {
  regulatory: "a regulator or licensing regime",
  abandoned: "its issuer or protocol",
};

/** Largest recorded peak among discontinued (or collapsed) causes; lanes are already peak-descending. */
function largestAmong(
  stats: Pick<CemeteryStats, "peakByCause">,
  discontinued: boolean,
): (CemeteryPeakDot & { cause: CauseOfDeath }) | null {
  let best: (CemeteryPeakDot & { cause: CauseOfDeath }) | null = null;
  for (const lane of stats.peakByCause.lanes) {
    if ((DISCONTINUED_BY[lane.cause] !== undefined) !== discontinued) continue;
    const top = lane.dots[0];
    if (top && (best === null || top.peak > best.peak || (top.peak === best.peak && top.id < best.id))) {
      best = { ...top, cause: lane.cause };
    }
  }
  return best;
}

/** FAQ answers, every figure templated from `stats`. */
export function buildCemeteryFaq(stats: CemeteryStats): CemeteryFaqItem[] {
  const items: CemeteryFaqItem[] = [];
  const { keyFacts, algorithmicEra: era } = stats;

  items.push({
    question: "How many stablecoins have failed or been discontinued?",
    answer: `Pharos documents ${stats.total} stablecoins that failed or were discontinued between ${stats.firstYear} and ${stats.latestYear}: ${stats.curatedCount} curated records and ${stats.trackedCount} coins Pharos tracked live before they ended. The latest recorded death is ${stats.asOf.label}. The catalog is not exhaustive.`,
  });

  const collapse = largestAmong(stats, false);
  if (collapse) {
    items.push({
      question: "What was the largest collapse?",
      answer: `${collapse.name} (${collapse.symbol}) is the largest recorded collapse by peak market cap: it peaked at ${formatCemeteryPeak(collapse.peak)} and failed in ${formatDeathDate(collapse.deathDate.slice(0, 7))}. Its recorded primary cause is ${CAUSE_META[collapse.cause].label.toLowerCase()}. Regulatory and abandoned exits count as discontinued, not collapsed.`,
    });
  }

  const discontinued = largestAmong(stats, true);
  if (discontinued) {
    items.push({
      question: "What was the largest discontinued stablecoin?",
      answer: `${discontinued.name} (${discontinued.symbol}) is the largest discontinued stablecoin by peak market cap: it peaked at ${formatCemeteryPeak(discontinued.peak)} and was ended by ${DISCONTINUED_BY[discontinued.cause]} in ${formatDeathDate(discontinued.deathDate.slice(0, 7))}. Peak market cap measures its size, not what holders lost.`,
    });
  }

  items.push({
    question: "Is peak market cap what holders lost?",
    answer: `No. Peak market cap is each coin's approximate size at its peak. Some records ended with redemption or conversion routes for holders; others ended far below peg. Pharos does not publish a loss figure, and records peak market cap for ${stats.peak.knownCount} of ${stats.total} records.`,
  });

  const { trailing12, prior12, curatedTrend } = keyFacts;
  const windowSentence = `Pharos recorded ${trailing12.total} deaths in the ${trailing12.months} months to ${stats.asOf.monthLabel}, against ${prior12.total} in the ${prior12.months} months before.`;
  let trendAnswer: string;
  if (curatedTrend.direction === "rising") {
    trendAnswer = `The record suggests so. ${windowSentence} Curated records alone rose from ${curatedTrend.prior} to ${curatedTrend.trailing}.`;
  } else {
    const curatedClause = curatedTrend.direction === "flat"
      ? `Curated records were flat at ${curatedTrend.trailing} against ${curatedTrend.prior}`
      : `Curated records fell from ${curatedTrend.prior} to ${curatedTrend.trailing}`;
    const trackedClause = trailing12.tracked > prior12.tracked
      ? `; the rest of the change comes from Pharos's own tracked archive (${trailing12.tracked} against ${prior12.tracked}).`
      : ".";
    trendAnswer = `Not demonstrably. ${windowSentence} ${curatedClause}${trackedClause}`;
  }
  items.push({ question: "Are stablecoin deaths becoming more common?", answer: trendAnswer });

  const eraSentence = era.through.total > 0 && era.since.total > 0
    ? ` Among recorded deaths, algorithmic failures were ${era.through.count} of ${era.through.total} records through ${era.cutoffYear} and ${era.since.count} of ${era.since.total} since.`
    : "";
  items.push({
    question: "Are algorithmic stablecoins more likely to fail?",
    answer: `The cemetery records deaths, not launches, so it cannot measure a failure rate.${eraSentence}`,
  });

  items.push({
    question: "How does a stablecoin enter the cemetery?",
    answer: `A stablecoin is included when it had a public market and public sources show it failed or was discontinued: an announcement, filing, governance record or press report, or, for a coin that faded without one, market data showing its collapse. There is no size floor; peak market cap is recorded when known. Records arrive two ways: ${stats.trackedCount} coins Pharos tracked live and froze after they ended, and ${stats.curatedCount} curated records documented from public sources.`,
  });

  items.push({
    question: "Can I cite this data?",
    answer: `Yes. The JSON and CSV exports of all ${stats.total} records are published under the MIT license. Cite the dataset URL with the record count and the date you used; each record also has a permanent link on this page.`,
  });

  return items;
}
