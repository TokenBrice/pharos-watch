import {
  Failure,
  findLineValue,
  formatNumber,
  getAllNumbersFromText,
  getFirstNumberFromText,
  expectEqual,
  expectNumber,
  read,
  requireTableRow,
} from "./shared";
import {
  CIRCUIT_OPEN_THRESHOLD,
  CIRCUIT_PROBE_INTERVAL_SEC,
} from "../../../worker/src/lib/circuit-config";
import {
  DEWS_SIGNAL_WEIGHTS,
  DEWS_THREAT_BANDS,
} from "../../../worker/src/lib/dews-config";
import {
  DURABILITY_COMPONENT_WEIGHTS,
  LIQUIDITY_COMPONENT_WEIGHTS,
} from "../../../worker/src/cron/dex-liquidity/score-weights";
import {
  DEPEG_CONFIRMATION_SUPPLY_THRESHOLD,
  DEPEG_EXTREME_MOVE_BPS,
  DEPEG_PENDING_EXPIRY_SEC,
  DEPEG_PENDING_MIN_AGE_SEC,
  DEPEG_PRIMARY_PRICE_MAX_AGE_SEC,
  DEPEG_SECONDARY_THRESHOLD_RATIO,
  DEX_FRESHNESS_SEC,
  DEX_PRICE_CHECK_DEPEG_MIN_TVL_USD,
} from "../../../worker/src/lib/constants";
import {
  DEPEG_THRESHOLD_BPS,
  DEPEG_THRESHOLD_BPS_NON_USD,
} from "../../../worker/src/lib/depeg-config";
import {
  FEEDBACK_RATE_LIMIT_MAX_SUBMISSIONS,
  FEEDBACK_RATE_LIMIT_WINDOW_SEC,
} from "../../../worker/src/api/feedback/types";
import {
  PUBLIC_API_RATE_LIMIT_MAX_REQUESTS,
  PUBLIC_API_RATE_LIMIT_WINDOW_SEC,
} from "../../../worker/src/lib/public-api-limits";
import { THREAT_BAND_HEX } from "../../../shared/lib/classification";
import { CRON_SCHEDULES } from "../../../shared/lib/cron-jobs";
import {
  DIMENSION_WEIGHTS,
  GRADE_THRESHOLDS,
  NO_LIQUIDITY_PENALTY,
  PEG_MULTIPLIER_EXPONENT,
} from "../../../shared/lib/report-cards";
import {
  DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
  METHODOLOGY_DOC_VERSION_CHECKS,
  SAFETY_SCORE_VERSION_LABEL,
} from "./methodology-manifest";

function checkMethodologyVersions(failures: Failure[]): void {
  for (const check of METHODOLOGY_DOC_VERSION_CHECKS) {
    const doc = read(check.file);
    const found = findLineValue(doc, /Current methodology version:\*\*\s*`([^`]+)`/);
    expectEqual(failures, check.file, "methodology version", found, check.expectedVersionLabel);
  }
}

function checkReportCardsDoc(failures: Failure[]): void {
  const file = "docs/report-cards.md";
  const doc = read(file);
  const expectedVersion = SAFETY_SCORE_VERSION_LABEL;

  expectEqual(
    failures,
    file,
    "overall grade version heading",
    findLineValue(doc, /## Overall Grade \((v[\d.]+)\)/),
    expectedVersion,
  );
  expectEqual(
    failures,
    file,
    "current-version note",
    findLineValue(doc, /Current-version note: (v[\d.]+)/),
    expectedVersion,
  );

  const dimensionRowLabels = {
    liquidity: "**Liquidity / Exit**",
    resilience: "**Resilience**",
    decentralization: "**Decentralization**",
    dependencyRisk: "**Dependency Risk**",
  } satisfies Record<"liquidity" | "resilience" | "decentralization" | "dependencyRisk", string>;

  for (const [key, rowLabel] of Object.entries(dimensionRowLabels) as Array<[keyof typeof dimensionRowLabels, string]>) {
    const row = requireTableRow(doc, file, rowLabel);
    expectNumber(
      failures,
      file,
      `dimension weight ${key}`,
      getFirstNumberFromText(row[0]),
      DIMENSION_WEIGHTS[key] * 100,
    );
  }

  expectEqual(
    failures,
    file,
    "peg multiplier exponent",
    findLineValue(doc, /\(pegScore \/ 100\) \^ ([0-9.]+)/),
    PEG_MULTIPLIER_EXPONENT.toFixed(2),
  );
  expectEqual(
    failures,
    file,
    "no-liquidity penalty",
    findLineValue(doc, /final × ([0-9.]+)/),
    String(NO_LIQUIDITY_PENALTY),
  );

  for (const { grade, min } of GRADE_THRESHOLDS) {
    const row = requireTableRow(doc, file, grade);
    expectNumber(failures, file, `grade threshold ${grade}`, getFirstNumberFromText(row[0]), min);
  }
}

function checkDepegDoc(failures: Failure[]): void {
  const file = "docs/depeg-detection.md";
  const doc = read(file);

  const checks = [
    { row: "`DEPEG_THRESHOLD_BPS`", label: "depeg USD threshold", expected: DEPEG_THRESHOLD_BPS },
    {
      row: "`DEPEG_THRESHOLD_BPS_NON_USD`",
      label: "depeg non-USD threshold",
      expected: DEPEG_THRESHOLD_BPS_NON_USD,
    },
    {
      row: "`DEPEG_CONFIRMATION_SUPPLY_THRESHOLD`",
      label: "depeg confirmation supply threshold",
      expected: DEPEG_CONFIRMATION_SUPPLY_THRESHOLD,
    },
    { row: "`DEPEG_PENDING_MIN_AGE_SEC`", label: "depeg pending min age", expected: DEPEG_PENDING_MIN_AGE_SEC },
    { row: "`DEPEG_PENDING_EXPIRY_SEC`", label: "depeg pending expiry", expected: DEPEG_PENDING_EXPIRY_SEC },
    {
      row: "`DEPEG_SECONDARY_THRESHOLD_RATIO`",
      label: "depeg secondary threshold ratio",
      expected: DEPEG_SECONDARY_THRESHOLD_RATIO,
    },
    {
      row: "`DEPEG_PRIMARY_PRICE_MAX_AGE_SEC`",
      label: "depeg primary price max age",
      expected: DEPEG_PRIMARY_PRICE_MAX_AGE_SEC,
    },
    { row: "`DEPEG_EXTREME_MOVE_BPS`", label: "depeg extreme move threshold", expected: DEPEG_EXTREME_MOVE_BPS },
    { row: "`DEX_FRESHNESS_SEC`", label: "depeg DEX freshness", expected: DEX_FRESHNESS_SEC },
    {
      row: "`DEX_PRICE_CHECK_DEPEG_MIN_TVL_USD`",
      label: "depeg DEX TVL threshold",
      expected: DEX_PRICE_CHECK_DEPEG_MIN_TVL_USD,
    },
  ];

  for (const check of checks) {
    const row = requireTableRow(doc, file, check.row);
    expectNumber(failures, file, check.label, getFirstNumberFromText(row[0]), check.expected);
  }
}

function checkDewsDoc(failures: Failure[]): void {
  const file = "docs/dews.md";
  const doc = read(file);
  const expectedVersion = DEPEG_DEWS_METHODOLOGY_VERSION_LABEL;

  expectEqual(
    failures,
    file,
    "methodology version",
    findLineValue(doc, /Current methodology version:\*\*\s*`([^`]+)`/),
    expectedVersion,
  );

  const signalRowLabels = {
    supply: "Supply Velocity",
    pool: "Pool Balance Drift",
    liq: "Liquidity Erosion",
    price: "Price Confidence",
    diverg: "Cross-Source Divergence",
    black: "Blacklist Activity",
    flow: "Mint/Burn Flow",
    yield: "Yield Anomaly",
  } satisfies Record<keyof typeof DEWS_SIGNAL_WEIGHTS, string>;

  for (const [key, rowLabel] of Object.entries(signalRowLabels) as Array<[keyof typeof signalRowLabels, string]>) {
    const row = requireTableRow(doc, file, rowLabel);
    expectEqual(failures, file, `DEWS signal weight ${key}`, row[1], DEWS_SIGNAL_WEIGHTS[key].toFixed(2));
  }

  let lower = 0;
  for (const bandRow of DEWS_THREAT_BANDS) {
    const range = bandRow.upper === 100 ? `${lower}-100` : `${lower}-${bandRow.upper}`;
    const row = requireTableRow(doc, file, range);
    expectEqual(failures, file, `DEWS threat band ${range}`, row[0].replace(/\*/g, ""), bandRow.band);
    expectEqual(failures, file, `DEWS threat band hex ${bandRow.band}`, row[1].replace(/`/g, ""), THREAT_BAND_HEX[bandRow.band]);
    lower = bandRow.upper + 1;
  }
}

function checkLiquidityDoc(failures: Failure[]): void {
  const file = "docs/dex-liquidity.md";
  const doc = read(file);

  const componentRows = [
    { row: "**TVL Depth**", label: "liquidity component TVL Depth", expected: LIQUIDITY_COMPONENT_WEIGHTS.tvlDepth * 100 },
    { row: "**Volume Activity**", label: "liquidity component Volume Activity", expected: LIQUIDITY_COMPONENT_WEIGHTS.volumeActivity * 100 },
    { row: "**Pool Quality**", label: "liquidity component Pool Quality", expected: LIQUIDITY_COMPONENT_WEIGHTS.poolQuality * 100 },
    { row: "**Durability**", label: "liquidity component Durability", expected: LIQUIDITY_COMPONENT_WEIGHTS.durability * 100 },
    { row: "**Pair Diversity**", label: "liquidity component Pair Diversity", expected: LIQUIDITY_COMPONENT_WEIGHTS.pairDiversity * 100 },
  ];

  for (const component of componentRows) {
    const row = requireTableRow(doc, file, component.row);
    expectNumber(failures, file, component.label, getFirstNumberFromText(row[0]), component.expected);
  }

  const durabilityRow = requireTableRow(doc, file, "**Durability**");
  const computedText = durabilityRow[2];
  const durabilityChecks = [
    {
      label: "durability TVL stability weight",
      expected: DURABILITY_COMPONENT_WEIGHTS.tvlStability * 100,
      found: findLineValue(computedText, /([0-9.]+)% TVL stability/),
    },
    {
      label: "durability volume consistency weight",
      expected: DURABILITY_COMPONENT_WEIGHTS.volumeConsistency * 100,
      found: findLineValue(computedText, /([0-9.]+)% volume consistency/),
    },
    {
      label: "durability maturity weight",
      expected: DURABILITY_COMPONENT_WEIGHTS.maturity * 100,
      found: findLineValue(computedText, /([0-9.]+)% maturity/),
    },
    {
      label: "durability organic fraction weight",
      expected: DURABILITY_COMPONENT_WEIGHTS.organicFraction * 100,
      found: findLineValue(computedText, /([0-9.]+)% organic fraction/),
    },
  ];

  for (const check of durabilityChecks) {
    expectEqual(failures, file, check.label, check.found, formatNumber(check.expected));
  }
}

function checkWorkerLimitsDoc(failures: Failure[]): void {
  const file = "docs/worker-and-api-limits.md";
  const doc = read(file);
  const cronScheduleCount = Object.keys(CRON_SCHEDULES).length;

  const publicApiRow = requireTableRow(doc, file, "Public API limiter");
  const feedbackRow = requireTableRow(doc, file, "Feedback limiter");
  const cronRow = requireTableRow(doc, file, "Cron expressions / trigger slots");
  const circuitRow = requireTableRow(doc, file, "Generic circuit breaker");

  const publicApiNumbers = getAllNumbersFromText(publicApiRow[0]);
  const feedbackNumbers = getAllNumbersFromText(feedbackRow[0]);
  const circuitNumbers = getAllNumbersFromText(circuitRow[0]);

  expectNumber(failures, file, "public API rate-limit requests", publicApiNumbers[0] ?? null, PUBLIC_API_RATE_LIMIT_MAX_REQUESTS);
  expectNumber(failures, file, "public API rate-limit window seconds", publicApiNumbers[1] ?? null, PUBLIC_API_RATE_LIMIT_WINDOW_SEC);
  expectNumber(failures, file, "feedback rate-limit submissions", feedbackNumbers[0] ?? null, FEEDBACK_RATE_LIMIT_MAX_SUBMISSIONS);
  expectNumber(failures, file, "feedback rate-limit window minutes", feedbackNumbers[1] ?? null, FEEDBACK_RATE_LIMIT_WINDOW_SEC / 60);
  expectNumber(failures, file, "cron trigger count", getFirstNumberFromText(cronRow[0]), cronScheduleCount);
  expectNumber(failures, file, "circuit open threshold", circuitNumbers[0] ?? null, CIRCUIT_OPEN_THRESHOLD);
  expectNumber(failures, file, "circuit probe interval minutes", circuitNumbers[1] ?? null, CIRCUIT_PROBE_INTERVAL_SEC / 60);
}

export function runDocSyncChecks(): Failure[] {
  const failures: Failure[] = [];

  checkMethodologyVersions(failures);
  checkReportCardsDoc(failures);
  checkDepegDoc(failures);
  checkDewsDoc(failures);
  checkLiquidityDoc(failures);
  checkWorkerLimitsDoc(failures);

  return failures;
}
