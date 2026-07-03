#!/usr/bin/env tsx

import {
  DDRR_VERDICT_REVIEW_VALUES,
  DdrrResponseSchema,
  type DdrrResponse,
  type DdrrRow,
  type DdrrV2CoverageRow,
  type DdrrV2NoCallReviewRow,
  type DdrrV2PredictionReviewRow,
  type DdrrVerdictReview,
} from "../../shared/types/depeg-resolver-review";
import type { DdrFactor, DdrFactorCode, DdrFactorSeverity } from "../../shared/types/depeg-resolver";
import { mean, median } from "../../shared/lib/stats";
import {
  PROD_ORIGIN,
  fetchJson,
  isRecord,
  joinUrl,
  markdownValue,
  readRequiredJsonFile,
  resolveGeneratedAt,
  runAsMain,
  toPositiveInt,
  writeOutputFile,
} from "../lib/coverage-audit-cli";

export const DEFAULT_DDRR_CALIBRATION_REPORT_PATH = "agents/ddrr-calibration-report.md";
export const PROD_DDRR_SITE_DATA_URL = `${PROD_ORIGIN}/_site-data/depeg-resolver-review`;
export const TRUSTED_DDRR_API_KEY_ORIGINS = new Set(["https://api.pharos.watch"]);

const TERMINALITY_SCORED_VERDICTS = new Set<DdrrVerdictReview>([
  "correct_recoverable",
  "correct_terminal",
  "false_terminal",
  "false_recoverable",
  "risk_noted_terminal",
]);
const DURATION_RETUNE_MIN_ROWS = 50;
const DURATION_RETUNE_MIN_COINS = 20;
const FACTOR_REVIEW_FALSE_TERMINAL_THRESHOLD = 2;
const FACTOR_REVIEW_FALSE_RECOVERABLE_THRESHOLD = 2;
const SAMPLE_LIMIT = 8;

type ReportFormat = "markdown" | "json";
type SourceMode = "prod" | "api" | "url" | "input";
type RecommendationSeverity = "hold" | "monitor" | "review" | "candidate";

export interface DdrrCalibrationCliOptions {
  inputPath: string | null;
  apiBase: string | null;
  url: string | null;
  prod: boolean;
  format: ReportFormat;
  reportPath: string | null;
  stdout: boolean;
  generatedAt: string | null;
  sampleLimit: number;
}

export interface DdrrCalibrationSource {
  mode: SourceMode;
  detail: string;
}

export interface DdrrCalibrationRecommendation {
  topic: string;
  severity: RecommendationSeverity;
  finding: string;
  nextAction: string;
}

function isLocalApiOrigin(url: URL): boolean {
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1")
  );
}

export function isTrustedDdrrApiKeyDestination(apiBase: string): boolean {
  try {
    const url = new URL(apiBase);
    return TRUSTED_DDRR_API_KEY_ORIGINS.has(url.origin) || isLocalApiOrigin(url);
  } catch {
    return false;
  }
}

function ddrrApiKeyForDestination(apiBase: string): string | undefined {
  if (!isTrustedDdrrApiKeyDestination(apiBase)) return undefined;
  return process.env.PHAROS_API_KEY ?? process.env.SMOKE_API_KEY;
}

type VerdictCounts = Record<DdrrVerdictReview, number>;

interface ActualCounts {
  recovered: number;
  terminal: number;
  stillOpen: number;
  dataIssue: number;
}

export interface DdrrFactorAttributionRow {
  factorCode: DdrFactorCode;
  factorKind: DdrFactor["kind"];
  severity: DdrFactorSeverity;
  labelClass: string;
  rowCount: number;
  scoredCount: number;
  coinCount: number;
  verdictCounts: VerdictCounts;
  actualCounts: ActualCounts;
  falseTerminalRate: number | null;
  falseRecoverableRate: number | null;
  sampleIncidentKeys: string[];
  recommendation: RecommendationSeverity;
}

export interface DdrrDurationCalibrationSegment {
  segment: string;
  rowCount: number;
  coinCount: number;
  insideBandCount: number;
  fasterThanBandCount: number;
  slowerThanBandCount: number;
  medianEarlyCount: number;
  medianLateCount: number;
  medianExactCount: number;
  meanSignedErrorSec: number | null;
  medianSignedErrorSec: number | null;
  meanAbsoluteErrorSec: number | null;
  medianAbsoluteErrorSec: number | null;
  coinDedupMeanSignedErrorSec: number | null;
  coinDedupMedianSignedErrorSec: number | null;
  recommendation: RecommendationSeverity;
  bias: "too_fast" | "too_slow" | "balanced" | "insufficient_data";
}

export interface DdrrNoCallCalibration {
  noCallCount: number;
  actualCounts: ActualCounts;
  missingReasonCounts: Record<string, number>;
  missingReasonOutcomes: Array<{ missingReason: string; rowCount: number; actualCounts: ActualCounts }>;
  insufficientSignalPredictionCount: number;
  maturedNoCallCount: number;
  recommendation: DdrrCalibrationRecommendation;
}

export interface DdrrCoverageCalibration {
  coverageRowCount: number;
  byPredictionState: Record<string, number>;
  byCoverageCause: Record<string, number>;
  byOperationalCoverageCause: Record<string, number>;
  operationalMissCount: number;
  recommendation: DdrrCalibrationRecommendation;
}

export interface DdrrCalibrationReport {
  generatedAt: string;
  source: DdrrCalibrationSource;
  snapshot: {
    computedAt: number;
    degraded: boolean;
    degradedReason: string | null;
    reviewerVersion: string;
    methodologyVersions: string[];
    publicRowsTruncated: boolean;
    assessedEventCount: number;
    reviewedEventCount: number;
    durationScoredCount: number;
    verdictScoredCount: number;
  };
  sample: {
    rowCount: number;
    predictionReviewCount: number;
    noCallReviewCount: number;
    coverageCount: number;
    invalidatedPredictionCount: number;
    predictionCoinCount: number;
  };
  recommendations: DdrrCalibrationRecommendation[];
  factorAttribution: DdrrFactorAttributionRow[];
  durationCalibration: {
    gates: {
      minRowsForRetune: number;
      minCoinsForRetune: number;
    };
    overall: DdrrDurationCalibrationSegment;
    byStratum: DdrrDurationCalibrationSegment[];
    byDirection: DdrrDurationCalibrationSegment[];
  };
  noCallCalibration: DdrrNoCallCalibration;
  coverageCalibration: DdrrCoverageCalibration;
  k5ExitCollapse: {
    factorRows: DdrrFactorAttributionRow[];
    recommendation: DdrrCalibrationRecommendation;
  };
  reserveDependencyNuance: {
    factorRows: DdrrFactorAttributionRow[];
    recommendation: DdrrCalibrationRecommendation;
  };
  mintIncidentTiming: {
    factorRows: DdrrFactorAttributionRow[];
    recentMintIncidentRowCount: number;
    recommendation: DdrrCalibrationRecommendation;
  };
  warnings: string[];
}

interface DurationScoredRow extends DdrrV2PredictionReviewRow {
  signedDurationErrorSec: number;
  absoluteDurationErrorSec: number;
}

function emptyVerdictCounts(): VerdictCounts {
  return Object.fromEntries(DDRR_VERDICT_REVIEW_VALUES.map((value) => [value, 0])) as VerdictCounts;
}

function emptyActualCounts(): ActualCounts {
  return {
    recovered: 0,
    terminal: 0,
    stillOpen: 0,
    dataIssue: 0,
  };
}

function pct(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function incrementLoose(record: Record<string, number>, key: string | null | undefined): void {
  const normalized = key && key.trim() ? key : "__none__";
  record[normalized] = (record[normalized] ?? 0) + 1;
}

function actualBucket(row: Pick<DdrrV2PredictionReviewRow | DdrrV2NoCallReviewRow, "actual">): keyof ActualCounts {
  if (row.actual.kind === "recovered") return "recovered";
  if (row.actual.kind === "terminal") return "terminal";
  if (row.actual.kind === "still_open") return "stillOpen";
  return "dataIssue";
}

function incrementActual(
  counts: ActualCounts,
  row: Pick<DdrrV2PredictionReviewRow | DdrrV2NoCallReviewRow, "actual">,
): void {
  counts[actualBucket(row)] += 1;
}

function predictionRows(rows: readonly DdrrRow[]): DdrrV2PredictionReviewRow[] {
  return rows.filter((row): row is DdrrV2PredictionReviewRow => row.kind === "prediction_review");
}

function noCallRows(rows: readonly DdrrRow[]): DdrrV2NoCallReviewRow[] {
  return rows.filter((row): row is DdrrV2NoCallReviewRow => row.kind === "no_call_review");
}

function coverageRows(rows: readonly DdrrRow[]): DdrrV2CoverageRow[] {
  return rows.filter((row): row is DdrrV2CoverageRow => row.kind === "coverage");
}

function isDurationScored(row: DdrrV2PredictionReviewRow): row is DurationScoredRow {
  return row.signedDurationErrorSec != null && row.absoluteDurationErrorSec != null;
}

function labelClassForFactor(factor: DdrFactor): string {
  const label = factor.label.toLowerCase();
  if (factor.code === "K1_supply_weaponization") {
    if (label.includes("recent") || label.includes("compromised") || label.includes("unbacked"))
      return "recent_mint_incident";
    if (label.includes("expanding supply")) return "supply_expansion";
    return "other_k1";
  }
  if (factor.code === "K2_backing_impairment") {
    if (label.includes("frozen/dead") || label.includes("dependency")) return "observed_dependency_impairment";
    if (label.includes("very-high") || label.includes("reserves concentrated"))
      return "very_high_reserve_concentration";
    if (label.includes("exotic") || label.includes("high-risk collateral")) return "static_high_risk_collateral";
    return "other_k2";
  }
  return factor.label;
}

function factorKey(factor: DdrFactor): string {
  return `${factor.code}\u0000${factor.severity}\u0000${labelClassForFactor(factor)}`;
}

function recommendationForFactor(
  row: Pick<DdrrFactorAttributionRow, "verdictCounts" | "scoredCount">,
): RecommendationSeverity {
  if (row.scoredCount === 0) return "monitor";
  if (row.verdictCounts.false_terminal >= FACTOR_REVIEW_FALSE_TERMINAL_THRESHOLD) return "review";
  if (row.verdictCounts.false_recoverable >= FACTOR_REVIEW_FALSE_RECOVERABLE_THRESHOLD) return "review";
  if (row.verdictCounts.false_terminal > 0 || row.verdictCounts.false_recoverable > 0) return "monitor";
  return "hold";
}

export function buildFactorAttribution(rows: readonly DdrrV2PredictionReviewRow[]): DdrrFactorAttributionRow[] {
  const groups = new Map<
    string,
    {
      factor: DdrFactor;
      labelClass: string;
      rowCount: number;
      scoredCount: number;
      coins: Set<string>;
      verdictCounts: VerdictCounts;
      actualCounts: ActualCounts;
      sampleIncidentKeys: string[];
    }
  >();

  for (const row of rows) {
    for (const factor of row.frozen.factors) {
      const key = factorKey(factor);
      let group = groups.get(key);
      if (!group) {
        group = {
          factor,
          labelClass: labelClassForFactor(factor),
          rowCount: 0,
          scoredCount: 0,
          coins: new Set(),
          verdictCounts: emptyVerdictCounts(),
          actualCounts: emptyActualCounts(),
          sampleIncidentKeys: [],
        };
        groups.set(key, group);
      }
      group.rowCount += 1;
      group.coins.add(row.stablecoinId);
      group.verdictCounts[row.verdictReview] += 1;
      if (TERMINALITY_SCORED_VERDICTS.has(row.verdictReview)) group.scoredCount += 1;
      incrementActual(group.actualCounts, row);
      if (group.sampleIncidentKeys.length < SAMPLE_LIMIT) group.sampleIncidentKeys.push(row.incidentKey);
    }
  }

  return [...groups.values()]
    .map((group) => ({
      factorCode: group.factor.code,
      factorKind: group.factor.kind,
      severity: group.factor.severity,
      labelClass: group.labelClass,
      rowCount: group.rowCount,
      scoredCount: group.scoredCount,
      coinCount: group.coins.size,
      verdictCounts: group.verdictCounts,
      actualCounts: group.actualCounts,
      falseTerminalRate: pct(group.verdictCounts.false_terminal, group.scoredCount),
      falseRecoverableRate: pct(group.verdictCounts.false_recoverable, group.scoredCount),
      sampleIncidentKeys: group.sampleIncidentKeys,
      recommendation: recommendationForFactor(group),
    }))
    .sort((left, right) => {
      const byCode = left.factorCode.localeCompare(right.factorCode);
      if (byCode !== 0) return byCode;
      const bySeverity = left.severity.localeCompare(right.severity);
      if (bySeverity !== 0) return bySeverity;
      return right.rowCount - left.rowCount || left.labelClass.localeCompare(right.labelClass);
    });
}

function buildDurationSegment(segment: string, rows: readonly DurationScoredRow[]): DdrrDurationCalibrationSegment {
  const signed = rows.map((row) => row.signedDurationErrorSec);
  const absolute = rows.map((row) => row.absoluteDurationErrorSec);
  const coins = new Set(rows.map((row) => row.stablecoinId));
  const signedByCoin = new Map<string, number[]>();
  for (const row of rows) {
    const existing = signedByCoin.get(row.stablecoinId);
    if (existing) existing.push(row.signedDurationErrorSec);
    else signedByCoin.set(row.stablecoinId, [row.signedDurationErrorSec]);
  }
  const coinSignedMeans = [...signedByCoin.values()].flatMap((values) => {
    const value = mean(values);
    return value == null ? [] : [value];
  });
  const medianSigned = median(signed);
  let bias: DdrrDurationCalibrationSegment["bias"] = "insufficient_data";
  if (rows.length > 0 && medianSigned != null) {
    if (Math.abs(medianSigned) < 3600) bias = "balanced";
    else bias = medianSigned > 0 ? "too_fast" : "too_slow";
  }
  const recommendation: RecommendationSeverity =
    rows.length >= DURATION_RETUNE_MIN_ROWS && coins.size >= DURATION_RETUNE_MIN_COINS
      ? bias === "balanced"
        ? "hold"
        : "candidate"
      : "hold";

  return {
    segment,
    rowCount: rows.length,
    coinCount: coins.size,
    insideBandCount: rows.filter((row) => row.durationReview === "inside_band").length,
    fasterThanBandCount: rows.filter((row) => row.durationReview === "faster_than_band").length,
    slowerThanBandCount: rows.filter((row) => row.durationReview === "slower_than_band").length,
    medianEarlyCount: rows.filter((row) => row.medianReview === "median_early_by").length,
    medianLateCount: rows.filter((row) => row.medianReview === "median_late_by").length,
    medianExactCount: rows.filter((row) => row.medianReview === "median_exact").length,
    meanSignedErrorSec: mean(signed),
    medianSignedErrorSec: medianSigned,
    meanAbsoluteErrorSec: mean(absolute),
    medianAbsoluteErrorSec: median(absolute),
    coinDedupMeanSignedErrorSec: mean(coinSignedMeans),
    coinDedupMedianSignedErrorSec: median(coinSignedMeans),
    recommendation,
    bias,
  };
}

function groupDurationRows(
  rows: readonly DurationScoredRow[],
  keyFor: (row: DurationScoredRow) => string,
): DdrrDurationCalibrationSegment[] {
  const groups = new Map<string, DurationScoredRow[]>();
  for (const row of rows) {
    const key = keyFor(row);
    const existing = groups.get(key);
    if (existing) existing.push(row);
    else groups.set(key, [row]);
  }
  return [...groups.entries()]
    .map(([segment, segmentRows]) => buildDurationSegment(segment, segmentRows))
    .sort((left, right) => right.rowCount - left.rowCount || left.segment.localeCompare(right.segment));
}

function buildNoCallCalibration(
  rows: readonly DdrrV2NoCallReviewRow[],
  predictionRowsInput: readonly DdrrV2PredictionReviewRow[],
): DdrrNoCallCalibration {
  const actualCounts = emptyActualCounts();
  const missingReasonCounts: Record<string, number> = {};
  const byMissingReason = new Map<string, { rowCount: number; actualCounts: ActualCounts }>();

  for (const row of rows) {
    incrementActual(actualCounts, row);
    const reasons = row.missingReasons.length > 0 ? row.missingReasons : ["__none__"];
    for (const reason of reasons) {
      incrementLoose(missingReasonCounts, reason);
      let bucket = byMissingReason.get(reason);
      if (!bucket) {
        bucket = { rowCount: 0, actualCounts: emptyActualCounts() };
        byMissingReason.set(reason, bucket);
      }
      bucket.rowCount += 1;
      incrementActual(bucket.actualCounts, row);
    }
  }

  const maturedNoCallCount = actualCounts.recovered + actualCounts.terminal;
  const insufficientSignalPredictionCount = predictionRowsInput.filter(
    (row) => row.verdictReview === "unscored_insufficient_signal",
  ).length;
  const recommendation: DdrrCalibrationRecommendation =
    maturedNoCallCount > 0 || insufficientSignalPredictionCount > 0
      ? {
          topic: "No-call and insufficient-signal inputs",
          severity: "review",
          finding: `${maturedNoCallCount} no-call rows have matured outcomes and ${insufficientSignalPredictionCount} prediction rows were unscored insufficient-signal.`,
          nextAction:
            "Group by missing reason before changing verdict thresholds; input coverage is the likely fix when mature no-calls cluster.",
        }
      : {
          topic: "No-call and insufficient-signal inputs",
          severity: "hold",
          finding: "No matured no-calls or insufficient-signal prediction reviews are present in this snapshot.",
          nextAction: "Keep monitoring no-calls as coverage debt outside the accuracy denominator.",
        };

  return {
    noCallCount: rows.length,
    actualCounts,
    missingReasonCounts,
    missingReasonOutcomes: [...byMissingReason.entries()]
      .map(([missingReason, bucket]) => ({ missingReason, ...bucket }))
      .sort((left, right) => right.rowCount - left.rowCount || left.missingReason.localeCompare(right.missingReason)),
    insufficientSignalPredictionCount,
    maturedNoCallCount,
    recommendation,
  };
}

function buildCoverageCalibration(rows: readonly DdrrV2CoverageRow[]): DdrrCoverageCalibration {
  const byPredictionState: Record<string, number> = {};
  const byCoverageCause: Record<string, number> = {};
  const byOperationalCoverageCause: Record<string, number> = {};

  for (const row of rows) {
    incrementLoose(byPredictionState, row.predictionState);
    incrementLoose(byCoverageCause, row.coverageCause);
    incrementLoose(byOperationalCoverageCause, row.operationalCoverageCause);
  }

  const operationalMissCount = rows.filter((row) => row.operationalCoverageCause != null).length;
  const missedTerminal = rows.filter((row) => row.predictionState === "missed_lock_terminal").length;
  const recommendation: DdrrCalibrationRecommendation =
    operationalMissCount > 0 || missedTerminal > 0
      ? {
          topic: "Coverage and missed-lock accountability",
          severity: "review",
          finding: `${operationalMissCount} rows carry operational coverage causes; ${missedTerminal} missed-lock rows later became terminal.`,
          nextAction:
            "Treat this as publication/lock/input coverage debt, not terminality accuracy. Inspect operational causes before retuning DDR.",
        }
      : {
          topic: "Coverage and missed-lock accountability",
          severity: "hold",
          finding: "No operational missed-lock rows in this snapshot.",
          nextAction: "Keep coverage rows separate from prediction accuracy and monitor state transitions.",
        };

  return {
    coverageRowCount: rows.length,
    byPredictionState,
    byCoverageCause,
    byOperationalCoverageCause,
    operationalMissCount,
    recommendation,
  };
}

function factorRecommendation(
  topic: string,
  factorRows: readonly DdrrFactorAttributionRow[],
  emptyFinding: string,
  emptyNextAction: string,
): DdrrCalibrationRecommendation {
  const falseTerminal = factorRows.reduce((sum, row) => sum + row.verdictCounts.false_terminal, 0);
  const falseRecoverable = factorRows.reduce((sum, row) => sum + row.verdictCounts.false_recoverable, 0);
  const riskNotedTerminal = factorRows.reduce((sum, row) => sum + row.verdictCounts.risk_noted_terminal, 0);
  const scored = factorRows.reduce((sum, row) => sum + row.scoredCount, 0);
  if (factorRows.length === 0 || scored === 0) {
    return {
      topic,
      severity: "monitor",
      finding: emptyFinding,
      nextAction: emptyNextAction,
    };
  }
  if (
    falseTerminal >= FACTOR_REVIEW_FALSE_TERMINAL_THRESHOLD ||
    falseRecoverable >= FACTOR_REVIEW_FALSE_RECOVERABLE_THRESHOLD
  ) {
    return {
      topic,
      severity: "review",
      finding: `Scored rows show ${falseTerminal} false-terminal and ${falseRecoverable} false-recoverable outcomes.`,
      nextAction:
        "Inspect row-level labels before changing thresholds; require repeated-coin-adjusted support for a rubric bump.",
    };
  }
  if (falseTerminal > 0 || falseRecoverable > 0 || riskNotedTerminal > 0) {
    return {
      topic,
      severity: "monitor",
      finding: `Mixed but below-gate evidence: ${falseTerminal} false-terminal, ${falseRecoverable} false-recoverable, ${riskNotedTerminal} risk-noted terminal.`,
      nextAction: "Keep monitoring until misses repeat across coins or methodology versions.",
    };
  }
  return {
    topic,
    severity: "hold",
    finding: "No scored miss cluster in this factor family.",
    nextAction: "No DDR logic change indicated by this snapshot.",
  };
}

export function buildDdrrCalibrationReport(
  response: DdrrResponse,
  options: { generatedAt: string; source: DdrrCalibrationSource; sampleLimit?: number },
): DdrrCalibrationReport {
  const rows = response.rows;
  const predictions = predictionRows(rows);
  const noCalls = noCallRows(rows);
  const coverage = coverageRows(rows);
  const invalidatedPredictionCount = rows.filter((row) => row.kind === "invalidated_prediction").length;
  const warnings: string[] = [];
  if (response._meta.degraded) warnings.push(`Snapshot is degraded: ${response._meta.degradedReason ?? "unknown"}.`);
  if (response._meta.publicRowsTruncated)
    warnings.push("Public rows are truncated; calibration output may miss row-level samples.");

  const factorAttribution = buildFactorAttribution(predictions);
  const durationRows = predictions.filter(isDurationScored);
  const durationCalibration = {
    gates: {
      minRowsForRetune: DURATION_RETUNE_MIN_ROWS,
      minCoinsForRetune: DURATION_RETUNE_MIN_COINS,
    },
    overall: buildDurationSegment("all", durationRows),
    byStratum: groupDurationRows(durationRows, (row) => row.frozen.stratum ?? "unstratified").slice(
      0,
      options.sampleLimit ?? SAMPLE_LIMIT,
    ),
    byDirection: groupDurationRows(durationRows, (row) => row.direction),
  };

  const noCallCalibration = buildNoCallCalibration(noCalls, predictions);
  const coverageCalibration = buildCoverageCalibration(coverage);
  const k5Rows = factorAttribution.filter((row) => row.factorCode === "K5_exit_collapse");
  const k2Rows = factorAttribution.filter((row) => row.factorCode === "K2_backing_impairment");
  const k1Rows = factorAttribution.filter((row) => row.factorCode === "K1_supply_weaponization");
  const recentMintIncidentRowCount = k1Rows
    .filter((row) => row.labelClass === "recent_mint_incident")
    .reduce((sum, row) => sum + row.rowCount, 0);

  const k5Recommendation = factorRecommendation(
    "K5 exit-collapse calibration",
    k5Rows,
    "No K5 scored sample is present in this snapshot.",
    "Wait for K5 rows before changing liquidity/redemption/bank-run thresholds.",
  );
  const k2Recommendation = factorRecommendation(
    "Reserve dependency nuance",
    k2Rows,
    "No K2 scored sample is present in this snapshot.",
    "Keep dependency impairment and static reserve concentration separated in future reviews.",
  );
  const mintRecommendation =
    recentMintIncidentRowCount === 0
      ? {
          topic: "Mint-incident timing robustness",
          severity: "monitor" as const,
          finding: "No post-v3.03 recent-mint-incident K1 rows are present yet.",
          nextAction:
            "Do not adjust the 60-day mint-incident window until DDRR observes rows emitted by resolution-rubric-v2.",
        }
      : factorRecommendation(
          "Mint-incident timing robustness",
          k1Rows.filter((row) => row.labelClass === "recent_mint_incident"),
          "No recent-mint-incident K1 scored rows are present.",
          "Keep monitoring before expanding or shrinking the 60-day window.",
        );

  const durationRecommendation: DdrrCalibrationRecommendation =
    durationCalibration.overall.recommendation === "candidate"
      ? {
          topic: "Stage 2 duration calibration",
          severity: "candidate",
          finding: `Duration sample passed gates with ${durationCalibration.overall.rowCount} rows and ${durationCalibration.overall.coinCount} coins; median bias is ${durationCalibration.overall.bias}.`,
          nextAction:
            "Evaluate a stratum-specific quantile shift on a held-out sample before changing duration-landmark-v1.",
        }
      : {
          topic: "Stage 2 duration calibration",
          severity: "hold",
          finding: `Duration sample has ${durationCalibration.overall.rowCount} rows and ${durationCalibration.overall.coinCount} coins; gate is ${DURATION_RETUNE_MIN_ROWS}/${DURATION_RETUNE_MIN_COINS}.`,
          nextAction: "Keep duration-landmark-v1 unchanged; use this report to monitor repeated-coin-adjusted bias.",
        };

  return {
    generatedAt: options.generatedAt,
    source: options.source,
    snapshot: {
      computedAt: response._meta.computedAt,
      degraded: response._meta.degraded,
      degradedReason: response._meta.degradedReason,
      reviewerVersion: response._meta.reviewerVersion,
      methodologyVersions: response._meta.methodologyVersions,
      publicRowsTruncated: response._meta.publicRowsTruncated,
      assessedEventCount: response._meta.assessedEventCount,
      reviewedEventCount: response._meta.reviewedEventCount,
      durationScoredCount: response._meta.durationScoredCount,
      verdictScoredCount: response._meta.verdictScoredCount,
    },
    sample: {
      rowCount: rows.length,
      predictionReviewCount: predictions.length,
      noCallReviewCount: noCalls.length,
      coverageCount: coverage.length,
      invalidatedPredictionCount,
      predictionCoinCount: new Set(predictions.map((row) => row.stablecoinId)).size,
    },
    recommendations: [
      durationRecommendation,
      noCallCalibration.recommendation,
      coverageCalibration.recommendation,
      k5Recommendation,
      k2Recommendation,
      mintRecommendation,
    ],
    factorAttribution,
    durationCalibration,
    noCallCalibration,
    coverageCalibration,
    k5ExitCollapse: {
      factorRows: k5Rows,
      recommendation: k5Recommendation,
    },
    reserveDependencyNuance: {
      factorRows: k2Rows,
      recommendation: k2Recommendation,
    },
    mintIncidentTiming: {
      factorRows: k1Rows,
      recentMintIncidentRowCount,
      recommendation: mintRecommendation,
    },
    warnings,
  };
}

function formatPercent(value: number | null): string {
  return value == null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function formatHours(value: number | null): string {
  if (value == null) return "n/a";
  const hours = value / 3600;
  if (Math.abs(hours) >= 24) return `${(hours / 24).toFixed(1)}d`;
  return `${hours.toFixed(1)}h`;
}

function verdictMissSummary(row: DdrrFactorAttributionRow): string {
  return [
    `FT ${row.verdictCounts.false_terminal}`,
    `FR ${row.verdictCounts.false_recoverable}`,
    `RT ${row.verdictCounts.risk_noted_terminal}`,
  ].join(" / ");
}

function renderRecommendationList(recommendations: readonly DdrrCalibrationRecommendation[]): string[] {
  return recommendations.map((row) => `- **${row.topic}** (${row.severity}): ${row.finding} ${row.nextAction}`);
}

function renderFactorTable(rows: readonly DdrrFactorAttributionRow[], limit: number): string[] {
  if (rows.length === 0) return ["_No matching factor rows._"];
  const lines = [
    "| Factor | Severity | Class | Rows | Coins | Scored | Misses | False terminal rate | Recommendation | Samples |",
    "|---|---:|---|---:|---:|---:|---|---:|---|---|",
  ];
  for (const row of rows.slice(0, limit)) {
    lines.push(
      [
        markdownValue(row.factorCode),
        row.severity,
        markdownValue(row.labelClass),
        row.rowCount,
        row.coinCount,
        row.scoredCount,
        markdownValue(verdictMissSummary(row)),
        formatPercent(row.falseTerminalRate),
        row.recommendation,
        markdownValue(row.sampleIncidentKeys.slice(0, 4).join(", ")),
      ]
        .join(" | ")
        .replace(/^/, "| ")
        .replace(/$/, " |"),
    );
  }
  return lines;
}

function renderDurationTable(rows: readonly DdrrDurationCalibrationSegment[]): string[] {
  if (rows.length === 0) return ["_No scored duration rows._"];
  const lines = [
    "| Segment | Rows | Coins | Inside IQR | Faster | Slower | Median signed | Coin-dedup median signed | Median abs | Bias | Recommendation |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---|",
  ];
  for (const row of rows) {
    lines.push(
      [
        markdownValue(row.segment),
        row.rowCount,
        row.coinCount,
        row.insideBandCount,
        row.fasterThanBandCount,
        row.slowerThanBandCount,
        formatHours(row.medianSignedErrorSec),
        formatHours(row.coinDedupMedianSignedErrorSec),
        formatHours(row.medianAbsoluteErrorSec),
        row.bias,
        row.recommendation,
      ]
        .join(" | ")
        .replace(/^/, "| ")
        .replace(/$/, " |"),
    );
  }
  return lines;
}

function renderCountRecord(record: Record<string, number>): string {
  const entries = Object.entries(record).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  return entries.length === 0
    ? "_None._"
    : entries.map(([key, count]) => `- ${markdownValue(key)}: ${count}`).join("\n");
}

export function renderDdrrCalibrationReportMarkdown(report: DdrrCalibrationReport): string {
  return [
    "# DDRR Calibration Report",
    "",
    `Generated: ${report.generatedAt}`,
    `Source: ${report.source.mode} (${report.source.detail})`,
    `Snapshot computedAt: ${report.snapshot.computedAt}`,
    `Reviewer: ${report.snapshot.reviewerVersion}`,
    `Methodology versions: ${report.snapshot.methodologyVersions.join(", ") || "n/a"}`,
    "",
    "## Sample Health",
    "",
    `- Rows: ${report.sample.rowCount}`,
    `- Prediction reviews: ${report.sample.predictionReviewCount} (${report.sample.predictionCoinCount} coins)`,
    `- No-call reviews: ${report.sample.noCallReviewCount}`,
    `- Coverage rows: ${report.sample.coverageCount}`,
    `- Invalidated predictions: ${report.sample.invalidatedPredictionCount}`,
    `- Verdict scored: ${report.snapshot.verdictScoredCount}`,
    `- Duration scored: ${report.snapshot.durationScoredCount}`,
    `- Public rows truncated: ${report.snapshot.publicRowsTruncated ? "yes" : "no"}`,
    "",
    "## Recommendations",
    "",
    ...renderRecommendationList(report.recommendations),
    "",
    "## Factor Attribution",
    "",
    ...renderFactorTable(report.factorAttribution, 20),
    "",
    "## Stage 2 Duration Calibration",
    "",
    `Retune gate: ${report.durationCalibration.gates.minRowsForRetune} scored rows and ${report.durationCalibration.gates.minCoinsForRetune} unique coins.`,
    "",
    ...renderDurationTable([
      report.durationCalibration.overall,
      ...report.durationCalibration.byDirection,
      ...report.durationCalibration.byStratum,
    ]),
    "",
    "## No-Call and Insufficient-Signal Audit",
    "",
    `- No-calls: ${report.noCallCalibration.noCallCount}`,
    `- Matured no-calls: ${report.noCallCalibration.maturedNoCallCount}`,
    `- Insufficient-signal prediction rows: ${report.noCallCalibration.insufficientSignalPredictionCount}`,
    "",
    "Missing reasons:",
    renderCountRecord(report.noCallCalibration.missingReasonCounts),
    "",
    "## Coverage Audit",
    "",
    `- Coverage rows: ${report.coverageCalibration.coverageRowCount}`,
    `- Operational miss rows: ${report.coverageCalibration.operationalMissCount}`,
    "",
    "Prediction states:",
    renderCountRecord(report.coverageCalibration.byPredictionState),
    "",
    "Coverage causes:",
    renderCountRecord(report.coverageCalibration.byCoverageCause),
    "",
    "## K5 Exit-Collapse Calibration",
    "",
    ...renderFactorTable(report.k5ExitCollapse.factorRows, 10),
    "",
    "## Reserve Dependency Nuance",
    "",
    ...renderFactorTable(report.reserveDependencyNuance.factorRows, 10),
    "",
    "## Mint-Incident Timing Robustness",
    "",
    `Recent mint-incident K1 rows: ${report.mintIncidentTiming.recentMintIncidentRowCount}`,
    "",
    ...renderFactorTable(report.mintIncidentTiming.factorRows, 10),
    "",
    "## Warnings",
    "",
    ...(report.warnings.length > 0 ? report.warnings.map((warning) => `- ${warning}`) : ["_None._"]),
    "",
    "## Guardrails",
    "",
    "- DDRR calibration is evidence for methodology review; it does not replay current DDR over old rows.",
    "- Coverage/no-call debt is separated from prediction accuracy.",
    "- Duration retunes require repeated-coin-adjusted support before changing `duration-landmark-v1`.",
    "",
  ].join("\n");
}

export function parseArgs(argv: readonly string[] = process.argv.slice(2)): DdrrCalibrationCliOptions {
  const options: DdrrCalibrationCliOptions = {
    inputPath: null,
    apiBase: null,
    url: null,
    prod: false,
    format: "markdown",
    reportPath: DEFAULT_DDRR_CALIBRATION_REPORT_PATH,
    stdout: false,
    generatedAt: null,
    sampleLimit: SAMPLE_LIMIT,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--input") {
      const value = argv[index + 1];
      if (!value) throw new Error("--input requires a path");
      options.inputPath = value;
      index += 1;
    } else if (arg === "--api-base") {
      const value = argv[index + 1];
      if (!value) throw new Error("--api-base requires a URL");
      options.apiBase = value;
      index += 1;
    } else if (arg === "--url") {
      const value = argv[index + 1];
      if (!value) throw new Error("--url requires a URL");
      options.url = value;
      index += 1;
    } else if (arg === "--prod") {
      options.prod = true;
    } else if (arg === "--json") {
      options.format = "json";
    } else if (arg === "--markdown") {
      options.format = "markdown";
    } else if (arg === "--report") {
      const value = argv[index + 1];
      if (!value) throw new Error("--report requires a path");
      options.reportPath = value;
      index += 1;
    } else if (arg === "--stdout") {
      options.stdout = true;
    } else if (arg === "--generated-at") {
      const value = argv[index + 1];
      if (!value) throw new Error("--generated-at requires an ISO timestamp or 'now'");
      options.generatedAt = value;
      index += 1;
    } else if (arg === "--limit") {
      options.sampleLimit = toPositiveInt(argv[index + 1] ?? "", "--limit");
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        [
          "Usage: tsx scripts/maintenance/generate-ddrr-calibration-report.ts [options]",
          "",
          "Options:",
          "  --prod                 Fetch production site-data (default when no --input/--url is supplied)",
          "  --api-base <url>       Fetch <url>/api/depeg-resolver-review",
          "  --url <url>            Fetch a custom DDRR response URL",
          "  --input <path>         Read a saved DDRR response JSON file",
          "  --json                 Emit JSON instead of Markdown",
          "  --markdown             Emit Markdown (default)",
          `  --report <path>        Output path (default: ${DEFAULT_DDRR_CALIBRATION_REPORT_PATH})`,
          "  --stdout               Write to stdout instead of a report file",
          "  --generated-at <iso>   Override report timestamp",
          "  --limit <n>            Row limit for long report tables",
        ].join("\n") + "\n",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  const sourceCount = [options.inputPath != null, options.apiBase != null, options.url != null, options.prod].filter(
    Boolean,
  ).length;
  if (sourceCount > 1) throw new Error("Choose only one of --input, --api-base, --url, or --prod.");
  return options;
}

function unwrapResponsePayload(payload: unknown): unknown {
  if (isRecord(payload)) {
    const nested = payload.payload;
    if (isRecord(nested) && "_meta" in nested && "rows" in nested) {
      return nested;
    }
  }
  return payload;
}

async function loadResponse(
  options: DdrrCalibrationCliOptions,
  fetchImpl: typeof fetch,
): Promise<{ response: DdrrResponse; source: DdrrCalibrationSource }> {
  if (options.inputPath) {
    const payload = readRequiredJsonFile(options.inputPath, "DDRR response");
    return {
      response: DdrrResponseSchema.parse(unwrapResponsePayload(payload)),
      source: { mode: "input", detail: options.inputPath },
    };
  }

  if (options.apiBase) {
    const url = joinUrl(options.apiBase, "/api/depeg-resolver-review");
    const payload = await fetchJson(url, fetchImpl, ddrrApiKeyForDestination(options.apiBase));
    return {
      response: DdrrResponseSchema.parse(unwrapResponsePayload(payload)),
      source: { mode: "api", detail: url },
    };
  }

  const url = options.url ?? PROD_DDRR_SITE_DATA_URL;
  const headers: Record<string, string> | undefined = url.startsWith(PROD_ORIGIN)
    ? { Origin: PROD_ORIGIN, Referer: joinUrl(PROD_ORIGIN, "/depeg/") }
    : undefined;
  const payload = await fetchJson(url, fetchImpl, undefined, headers);
  return {
    response: DdrrResponseSchema.parse(unwrapResponsePayload(payload)),
    source: { mode: options.url ? "url" : "prod", detail: url },
  };
}

export async function runCli(
  argv: readonly string[] = process.argv.slice(2),
  cwd: string = process.cwd(),
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const options = parseArgs(argv);
  const generatedAt = resolveGeneratedAt({ generatedAt: options.generatedAt });
  const { response, source } = await loadResponse(options, fetchImpl);
  const report = buildDdrrCalibrationReport(response, {
    generatedAt,
    source,
    sampleLimit: options.sampleLimit,
  });
  const output =
    options.format === "json" ? `${JSON.stringify(report, null, 2)}\n` : renderDdrrCalibrationReportMarkdown(report);

  if (options.stdout || !options.reportPath) {
    process.stdout.write(output);
    return 0;
  }
  const target = writeOutputFile(options.reportPath, output, cwd);
  process.stdout.write(`Wrote DDRR calibration report to ${target}\n`);
  return 0;
}

runAsMain(import.meta.url, () => runCli());
