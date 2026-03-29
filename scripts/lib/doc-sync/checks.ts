import {
  extractBandRows,
  extractConstNumber,
  extractGradeThresholds,
  extractNamedMultipliers,
  extractNumericObject,
  extractStringObject,
  Failure,
  findLineValue,
  formatNumber,
  getAllNumbersFromText,
  getFirstNumberFromText,
  normalizeNumber,
  expectEqual,
  expectNumber,
  read,
  requireTableRow,
} from "./shared";
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
  const source = read("shared/lib/report-cards.ts");
  const expectedVersion = SAFETY_SCORE_VERSION_LABEL;
  const dimensionWeights = extractNumericObject(source, "DIMENSION_WEIGHTS");
  const gradeThresholds = extractGradeThresholds(source);
  const pegMultiplier = extractConstNumber(source, "PEG_MULTIPLIER_EXPONENT");
  const noLiquidityPenalty = extractConstNumber(source, "NO_LIQUIDITY_PENALTY");

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

  const dimensionRowLabels: Record<string, string> = {
    liquidity: "**Liquidity / Exit**",
    resilience: "**Resilience**",
    decentralization: "**Decentralization**",
    dependencyRisk: "**Dependency Risk**",
  };

  for (const [key, rowLabel] of Object.entries(dimensionRowLabels)) {
    const row = requireTableRow(doc, file, rowLabel);
    expectNumber(
      failures,
      file,
      `dimension weight ${key}`,
      getFirstNumberFromText(row[0]),
      dimensionWeights[key] * 100,
    );
  }

  expectEqual(
    failures,
    file,
    "peg multiplier exponent",
    findLineValue(doc, /\(pegScore \/ 100\) \^ ([0-9.]+)/),
    pegMultiplier.toFixed(2),
  );
  expectEqual(
    failures,
    file,
    "no-liquidity penalty",
    findLineValue(doc, /final × ([0-9.]+)/),
    String(noLiquidityPenalty),
  );

  for (const [grade, min] of Object.entries(gradeThresholds)) {
    const row = requireTableRow(doc, file, grade);
    expectNumber(failures, file, `grade threshold ${grade}`, getFirstNumberFromText(row[0]), min);
  }
}

function checkDepegDoc(failures: Failure[]): void {
  const file = "docs/depeg-detection.md";
  const doc = read(file);
  const source = read("worker/src/lib/constants.ts");

  const checks = [
    { row: "`DEPEG_THRESHOLD_BPS`", label: "depeg USD threshold", expected: extractConstNumber(source, "DEPEG_THRESHOLD_BPS") },
    {
      row: "`DEPEG_THRESHOLD_BPS_NON_USD`",
      label: "depeg non-USD threshold",
      expected: extractConstNumber(source, "DEPEG_THRESHOLD_BPS_NON_USD"),
    },
    {
      row: "`DEPEG_CONFIRMATION_SUPPLY_THRESHOLD`",
      label: "depeg confirmation supply threshold",
      expected: extractConstNumber(source, "DEPEG_CONFIRMATION_SUPPLY_THRESHOLD"),
    },
    { row: "`DEPEG_PENDING_MIN_AGE_SEC`", label: "depeg pending min age", expected: extractConstNumber(source, "DEPEG_PENDING_MIN_AGE_SEC") },
    { row: "`DEPEG_PENDING_EXPIRY_SEC`", label: "depeg pending expiry", expected: extractConstNumber(source, "DEPEG_PENDING_EXPIRY_SEC") },
    {
      row: "`DEPEG_SECONDARY_THRESHOLD_RATIO`",
      label: "depeg secondary threshold ratio",
      expected: extractConstNumber(source, "DEPEG_SECONDARY_THRESHOLD_RATIO"),
    },
    {
      row: "`DEPEG_PRIMARY_PRICE_MAX_AGE_SEC`",
      label: "depeg primary price max age",
      expected: extractConstNumber(source, "DEPEG_PRIMARY_PRICE_MAX_AGE_SEC"),
    },
    { row: "`DEPEG_EXTREME_MOVE_BPS`", label: "depeg extreme move threshold", expected: extractConstNumber(source, "DEPEG_EXTREME_MOVE_BPS") },
    { row: "`DEX_FRESHNESS_SEC`", label: "depeg DEX freshness", expected: extractConstNumber(source, "DEX_FRESHNESS_SEC") },
    {
      row: "`DEX_PRICE_CHECK_DEPEG_MIN_TVL_USD`",
      label: "depeg DEX TVL threshold",
      expected: extractConstNumber(source, "DEX_PRICE_CHECK_DEPEG_MIN_TVL_USD"),
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
  const dewsSource = read("worker/src/lib/dews.ts");
  const classificationSource = read("shared/lib/classification.ts");
  const expectedVersion = DEPEG_DEWS_METHODOLOGY_VERSION_LABEL;
  const weights = extractNumericObject(dewsSource, "WEIGHTS");
  const bandRows = extractBandRows(dewsSource);
  const bandHex = extractStringObject(classificationSource, "THREAT_BAND_HEX");

  expectEqual(
    failures,
    file,
    "methodology version",
    findLineValue(doc, /Current methodology version:\*\*\s*`([^`]+)`/),
    expectedVersion,
  );

  const signalRowLabels: Record<string, string> = {
    supply: "Supply Velocity",
    pool: "Pool Balance Drift",
    liq: "Liquidity Erosion",
    price: "Price Confidence",
    diverg: "Cross-Source Divergence",
    black: "Blacklist Activity",
    flow: "Mint/Burn Flow",
    yield: "Yield Anomaly",
  };

  for (const [key, rowLabel] of Object.entries(signalRowLabels)) {
    const row = requireTableRow(doc, file, rowLabel);
    expectEqual(failures, file, `DEWS signal weight ${key}`, row[1], weights[key].toFixed(2));
  }

  for (const bandRow of bandRows) {
    const row = requireTableRow(doc, file, bandRow.range);
    expectEqual(failures, file, `DEWS threat band ${bandRow.range}`, row[0].replace(/\*/g, ""), bandRow.band);
    expectEqual(failures, file, `DEWS threat band hex ${bandRow.band}`, row[1].replace(/`/g, ""), bandHex[bandRow.band]);
  }
}

function checkLiquidityDoc(failures: Failure[]): void {
  const file = "docs/dex-liquidity.md";
  const doc = read(file);
  const source = read("worker/src/cron/dex-liquidity/pool-helpers.ts");
  const liquidityWeights = extractNamedMultipliers(source, [
    "tvlDepth",
    "volumeActivity",
    "poolQuality",
    "durability",
    "pairDiversity",
  ]);
  const durabilityWeights = extractNamedMultipliers(source, [
    "organicScore",
    "tvlStabilityScore",
    "volumeConsistencyScore",
    "maturityScore",
  ]);

  const componentRows = [
    { row: "**TVL Depth**", label: "liquidity component TVL Depth", expected: liquidityWeights.tvlDepth * 100 },
    { row: "**Volume Activity**", label: "liquidity component Volume Activity", expected: liquidityWeights.volumeActivity * 100 },
    { row: "**Pool Quality**", label: "liquidity component Pool Quality", expected: liquidityWeights.poolQuality * 100 },
    { row: "**Durability**", label: "liquidity component Durability", expected: liquidityWeights.durability * 100 },
    { row: "**Pair Diversity**", label: "liquidity component Pair Diversity", expected: liquidityWeights.pairDiversity * 100 },
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
      expected: durabilityWeights.tvlStabilityScore * 100,
      found: findLineValue(computedText, /([0-9.]+)% TVL stability/),
    },
    {
      label: "durability volume consistency weight",
      expected: durabilityWeights.volumeConsistencyScore * 100,
      found: findLineValue(computedText, /([0-9.]+)% volume consistency/),
    },
    {
      label: "durability maturity weight",
      expected: durabilityWeights.maturityScore * 100,
      found: findLineValue(computedText, /([0-9.]+)% maturity/),
    },
    {
      label: "durability organic fraction weight",
      expected: durabilityWeights.organicScore * 100,
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
  const httpSource = read("worker/src/handlers/http/gates.ts");
  const feedbackSource = read("worker/src/api/feedback/types.ts");
  const circuitSource = read("worker/src/lib/circuit-breaker.ts");
  const cronSource = read("shared/lib/cron-jobs.ts");

  const publicApiLimiter = normalizeNumber(
    findLineValue(
      httpSource,
      /resolveClientIp\(request\),\s*publicApiRateLimit\.salt,\s*([0-9][0-9_]*)/,
    ) ?? "",
  );
  const feedbackLimit = extractConstNumber(feedbackSource, "FEEDBACK_RATE_LIMIT_MAX_SUBMISSIONS");
  const feedbackWindowSec = extractConstNumber(feedbackSource, "FEEDBACK_RATE_LIMIT_WINDOW_SEC");
  const circuitOpenThreshold = extractConstNumber(circuitSource, "CIRCUIT_OPEN_THRESHOLD");
  const circuitProbeIntervalSec = extractConstNumber(circuitSource, "CIRCUIT_PROBE_INTERVAL_SEC");
  const cronScheduleCount = Object.keys(extractStringObject(cronSource, "CRON_SCHEDULES")).length;

  const publicApiRow = requireTableRow(doc, file, "Public API limiter");
  const feedbackRow = requireTableRow(doc, file, "Feedback limiter");
  const cronRow = requireTableRow(doc, file, "Cron expressions / trigger slots");
  const circuitRow = requireTableRow(doc, file, "Generic circuit breaker");

  const publicApiNumbers = getAllNumbersFromText(publicApiRow[0]);
  const feedbackNumbers = getAllNumbersFromText(feedbackRow[0]);
  const circuitNumbers = getAllNumbersFromText(circuitRow[0]);

  expectNumber(failures, file, "public API rate-limit requests", publicApiNumbers[0] ?? null, publicApiLimiter);
  expectNumber(failures, file, "public API rate-limit window seconds", publicApiNumbers[1] ?? null, 60);
  expectNumber(failures, file, "feedback rate-limit submissions", feedbackNumbers[0] ?? null, feedbackLimit);
  expectNumber(failures, file, "feedback rate-limit window minutes", feedbackNumbers[1] ?? null, feedbackWindowSec / 60);
  expectNumber(failures, file, "cron trigger count", getFirstNumberFromText(cronRow[0]), cronScheduleCount);
  expectNumber(failures, file, "circuit open threshold", circuitNumbers[0] ?? null, circuitOpenThreshold);
  expectNumber(failures, file, "circuit probe interval minutes", circuitNumbers[1] ?? null, circuitProbeIntervalSec / 60);
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
