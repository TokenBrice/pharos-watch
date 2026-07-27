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
  FEEDBACK_RATE_LIMIT_MAX_SUBMISSIONS,
  FEEDBACK_RATE_LIMIT_WINDOW_SEC,
} from "../../../shared/lib/ops-limits";
import {
  DEWS_SIGNAL_WEIGHTS,
  DEWS_THREAT_BANDS,
} from "../../../shared/lib/dews-config";
import { HEALTH_METHODOLOGY_VERSION } from "../../../shared/lib/chain-health";
import {
  DURABILITY_COMPONENT_WEIGHTS,
  LIQUIDITY_SCORE_WEIGHTS,
  type LiquidityScoreComponentKey,
} from "../../../shared/lib/liquidity-score-weights";
import {
  DEPEG_CONFIRMATION_SUPPLY_THRESHOLD,
  DEPEG_EXTREME_MOVE_BPS,
  DEPEG_PENDING_EXPIRY_SEC,
  DEPEG_PENDING_MIN_AGE_SEC,
  DEPEG_PRIMARY_PRICE_MAX_AGE_SEC,
  DEPEG_SECONDARY_THRESHOLD_RATIO,
  DEX_FRESHNESS_SEC,
  DEX_PRICE_CHECK_DEPEG_MIN_TVL_USD,
  DEPEG_THRESHOLD_BPS,
  DEPEG_THRESHOLD_BPS_NON_USD,
} from "../../../shared/lib/depeg-config";
import { STATUS_BLACKLIST_THRESHOLDS } from "../../../shared/lib/status-thresholds";
import {
  API_FRESHNESS_MAX_AGE_SEC,
  CACHE_FRESHNESS_LANES,
} from "../../../shared/lib/api-freshness";
import { THREAT_BAND_HEX } from "../../../shared/lib/classification";
import {
  BLACKLIST_TRACKER_METHODOLOGY_VERSION,
  DEPEG_DEWS_METHODOLOGY_VERSION,
  PSI_METHODOLOGY_VERSION,
  SAFETY_SCORE_METHODOLOGY_VERSION,
  YIELD_METHODOLOGY_VERSION,
} from "../../../shared/lib/methodology-versions/constants";
import { V9_CANDIDATE_POLICY_V1 } from "../../../shared/lib/safety-score-v9/policy";
import { REDEMPTION_BACKSTOP_CONFIGS } from "../../../shared/lib/redemption-backstops";
import {
  DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
  METHODOLOGY_DOC_VERSION_CHECKS,
  METHODOLOGY_PROVENANCE_FILES,
} from "./methodology-manifest";

function checkMethodologyVersions(failures: Failure[]): void {
  for (const check of METHODOLOGY_DOC_VERSION_CHECKS) {
    const doc = read(check.file);
    const found = findLineValue(doc, /Current methodology version:\*\*\s*`([^`]+)`/);
    expectEqual(failures, check.file, "methodology version", found, check.expectedVersionLabel);
  }
}

function checkMethodologyCommitProvenance(failures: Failure[]): void {
  for (const file of METHODOLOGY_PROVENANCE_FILES) {
    const doc = read(file);
    const found = doc.match(/\*\*Commit(?:s)?:\*\* `unreleased`|commits:\s*\["unreleased"\]/)?.[0] ?? null;
    if (found !== null) {
      failures.push({
        file,
        label: "methodology commit provenance",
        expected: "real commit hashes or omitted provenance",
        found,
      });
    }
  }
}

function checkReportCardsDoc(failures: Failure[]): void {
  const file = "docs/report-cards.md";
  const doc = read(file);
  const policy = V9_CANDIDATE_POLICY_V1.policy;

  expectEqual(
    failures,
    file,
    "active safety model",
    findLineValue(doc, /Active model: `([^`]+)`/),
    "v9",
  );

  const pillarRowLabels = {
    backing: "Backing",
    exit: "Exit",
    control: "Economic Control",
  } satisfies Record<keyof typeof policy.semantic.formula.pillarWeights, string>;

  for (const [key, rowLabel] of Object.entries(pillarRowLabels) as Array<[keyof typeof pillarRowLabels, string]>) {
    const row = requireTableRow(doc, file, rowLabel);
    expectNumber(
      failures,
      file,
      `pillar weight ${key}`,
      getFirstNumberFromText(row[0]),
      policy.semantic.formula.pillarWeights[key] * 100,
    );
  }

  for (const requiredText of [
    "`GET /api/report-cards/v9`",
    "`report-cards:v9`",
    "`report-cards:v9:publication-health`",
    "at least 90% of active assets remain unaffected",
  ]) {
    if (!doc.includes(requiredText)) {
      failures.push({
        file,
        label: "canonical V9 publication contract",
        expected: requiredText,
        found: null,
      });
    }
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
  const liquidityComponentWeightByKey = Object.fromEntries(
    LIQUIDITY_SCORE_WEIGHTS.map(({ key, weight }) => [key, weight]),
  ) as Record<LiquidityScoreComponentKey, number>;

  const componentRows = [
    { row: "**TVL Depth**", label: "liquidity component TVL Depth", expected: liquidityComponentWeightByKey.tvlDepth * 100 },
    { row: "**Volume Activity**", label: "liquidity component Volume Activity", expected: liquidityComponentWeightByKey.volumeActivity * 100 },
    { row: "**Pool Quality**", label: "liquidity component Pool Quality", expected: liquidityComponentWeightByKey.poolQuality * 100 },
    { row: "**Durability**", label: "liquidity component Durability", expected: liquidityComponentWeightByKey.durability * 100 },
    { row: "**Diversity**", label: "liquidity component Diversity", expected: liquidityComponentWeightByKey.pairDiversity * 100 },
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
  const feedbackRow = requireTableRow(doc, file, "Feedback limiter");
  const circuitRow = requireTableRow(doc, file, "Generic circuit breaker");

  const feedbackNumbers = getAllNumbersFromText(feedbackRow[0]);
  const circuitNumbers = getAllNumbersFromText(circuitRow[0]);

  expectNumber(failures, file, "feedback rate-limit submissions", feedbackNumbers[0] ?? null, FEEDBACK_RATE_LIMIT_MAX_SUBMISSIONS);
  expectNumber(failures, file, "feedback rate-limit window minutes", feedbackNumbers[1] ?? null, FEEDBACK_RATE_LIMIT_WINDOW_SEC / 60);
  expectNumber(failures, file, "circuit open threshold", circuitNumbers[0] ?? null, CIRCUIT_OPEN_THRESHOLD);
  expectNumber(failures, file, "circuit probe interval minutes", circuitNumbers[1] ?? null, CIRCUIT_PROBE_INTERVAL_SEC / 60);
}

function checkChainsApiDoc(failures: Failure[], doc: string): void {
  const file = "docs/api-reference.md";

  expectEqual(
    failures,
    file,
    "chain health methodology version",
    findLineValue(doc, /"healthMethodologyVersion":\s*"([^"]+)"/),
    HEALTH_METHODOLOGY_VERSION,
  );

  const chainsMetaRow = requireTableRow(doc, file, "`GET /api/chains`");
  expectNumber(
    failures,
    file,
    "/api/chains freshness max age",
    getFirstNumberFromText(chainsMetaRow[0]),
    API_FRESHNESS_MAX_AGE_SEC.chains,
  );
  expectEqual(
    failures,
    file,
    "/api/chains freshness metadata source",
    chainsMetaRow[1],
    "`worker/src/api/chains.ts`",
  );
}

function checkApiMethodologyExamples(failures: Failure[], doc: string): void {
  const file = "docs/api-reference.md";
  const checks = [
    {
      route: "GET /api/blacklist",
      markers: [
        `"currentVersion": "${BLACKLIST_TRACKER_METHODOLOGY_VERSION}"`,
        `"currentVersionLabel": "v${BLACKLIST_TRACKER_METHODOLOGY_VERSION}"`,
      ],
    },
    {
      route: "GET /api/depeg-events",
      markers: [`"currentVersion": "${DEPEG_DEWS_METHODOLOGY_VERSION}"`],
    },
    {
      route: "GET /api/peg-summary",
      markers: [`"currentVersion": "${DEPEG_DEWS_METHODOLOGY_VERSION}"`],
    },
    {
      route: "GET /api/stability-index",
      markers: [`"currentVersion": "${PSI_METHODOLOGY_VERSION}"`, `"methodologyVersion": "${PSI_METHODOLOGY_VERSION}"`],
    },
    {
      route: "GET /api/report-cards/v9",
      markers: [
        `"version": "${SAFETY_SCORE_METHODOLOGY_VERSION}"`,
        `"methodologyVersion": "${SAFETY_SCORE_METHODOLOGY_VERSION}"`,
      ],
    },
    {
      route: "GET /api/yield-rankings",
      markers: [
        `"currentVersion": "${YIELD_METHODOLOGY_VERSION}"`,
        `"methodologyVersion": "${SAFETY_SCORE_METHODOLOGY_VERSION}"`,
      ],
    },
    {
      route: "GET /api/yield-adapter-manifest",
      markers: [`"methodologyVersion": "v${YIELD_METHODOLOGY_VERSION}"`],
    },
    {
      route: "GET /api/yield-history",
      markers: [
        `"currentVersion": "${YIELD_METHODOLOGY_VERSION}"`,
        `"methodologyVersion": "${YIELD_METHODOLOGY_VERSION}"`,
      ],
    },
    {
      route: "GET /api/stress-signals",
      markers: [
        `"currentVersion": "${DEPEG_DEWS_METHODOLOGY_VERSION}"`,
        `"methodologyVersion": "${DEPEG_DEWS_METHODOLOGY_VERSION}"`,
      ],
    },
  ] as const;

  for (const check of checks) {
    const heading = `### \`${check.route}\``;
    const start = doc.indexOf(heading);
    const end = start < 0 ? -1 : doc.indexOf("\n---", start);
    const section = start < 0 ? "" : doc.slice(start, end < 0 ? undefined : end);
    for (const marker of check.markers) {
      if (!section.includes(marker)) {
        failures.push({
          file,
          label: `${check.route} current methodology example`,
          expected: marker,
          found: start < 0 ? "route section missing" : "marker missing",
        });
      }
    }
  }
}

function getCacheExampleNumber(doc: string, cacheKey: string, field: string): number | null {
  const cacheIndex = doc.indexOf(`"${cacheKey}"`);
  if (cacheIndex < 0) return null;
  const cacheSnippet = doc.slice(cacheIndex, cacheIndex + 1000);
  const fieldIndex = cacheSnippet.indexOf(`"${field}"`);
  if (fieldIndex < 0) return null;
  const match = cacheSnippet.slice(fieldIndex).match(/:\s*(\d+)/);
  return match?.[1] ? Number(match[1]) : null;
}

function checkApiFreshnessDoc(failures: Failure[], doc: string): void {
  const file = "docs/api-reference.md";
  const metaRows = [
    { row: "`GET /api/stablecoins`", expected: API_FRESHNESS_MAX_AGE_SEC.stablecoins },
    { row: "`GET /api/bluechip-ratings`", expected: API_FRESHNESS_MAX_AGE_SEC.bluechip },
    { row: "`GET /api/usds-status`", expected: API_FRESHNESS_MAX_AGE_SEC.usdsStatus },
    { row: "`GET /api/yield-rankings`", expected: API_FRESHNESS_MAX_AGE_SEC.yieldRankings },
  ];

  for (const check of metaRows) {
    const row = requireTableRow(doc, file, check.row);
    expectNumber(failures, file, `${check.row} _meta max age`, getFirstNumberFromText(row[0]), check.expected);
  }

  const stressSignalsLine = findLineValue(doc, /GET \/api\/stress-signals[\s\S]*?Freshness threshold: ([0-9_]+) s/);
  expectNumber(
    failures,
    file,
    "/api/stress-signals freshness threshold",
    stressSignalsLine == null ? null : Number(stressSignalsLine.replace(/_/g, "")),
    API_FRESHNESS_MAX_AGE_SEC.stressSignals,
  );

  for (const lane of Object.values(CACHE_FRESHNESS_LANES)) {
    expectNumber(
      failures,
      file,
      `${lane.cacheKey} health maxAge`,
      getCacheExampleNumber(doc, lane.cacheKey, "maxAge"),
      lane.availabilityMaxAgeSec,
    );
    expectNumber(
      failures,
      file,
      `${lane.cacheKey} health endpointMaxAge`,
      getCacheExampleNumber(doc, lane.cacheKey, "endpointMaxAge"),
      lane.endpointMaxAgeSec,
    );
    expectNumber(
      failures,
      file,
      `${lane.cacheKey} health producerIntervalSec`,
      getCacheExampleNumber(doc, lane.cacheKey, "producerIntervalSec"),
      lane.producerIntervalSec,
    );
  }
}

function checkStatusDashboardDoc(failures: Failure[]): void {
  const file = "docs/status-dashboard.md";
  const doc = read(file);
  const dataQualityStart = doc.indexOf("### Data quality status");
  const dataQualitySection = dataQualityStart >= 0 ? doc.slice(dataQualityStart) : "";
  const degradedStart = dataQualitySection.indexOf("- `degraded` if any of:");
  const degradedSection = degradedStart >= 0
    ? dataQualitySection.slice(degradedStart, degradedStart + 1200)
    : "";
  const degradedRecentLine = findLineValue(degradedSection, /`blacklistRecentMissingAmounts >= ([0-9_]+)` \(last 24h\)/);
  expectNumber(
    failures,
    file,
    "blacklist recent degraded threshold",
    degradedRecentLine == null ? null : Number(degradedRecentLine.replace(/_/g, "")),
    STATUS_BLACKLIST_THRESHOLDS.missingRecentDegraded,
  );
}

function checkChainsPageDoc(failures: Failure[]): void {
  const file = "docs/chains-page.md";
  const doc = read(file);

  if (!doc.includes("`src/app/chains/[chain]/client.tsx` uses `useChainProfileData(chainId)`")) {
    failures.push({
      file,
      label: "profile route coordination hook",
      expected: "useChainProfileData(chainId)",
      found: "missing",
    });
  }

  if (doc.includes("uses `useChains()` plus `useChainStablecoins(chainId)`")) {
    failures.push({
      file,
      label: "legacy profile hook contract",
      expected: "removed",
      found: "uses `useChains()` plus `useChainStablecoins(chainId)`",
    });
  }
}

function checkRedemptionBackstopsDoc(failures: Failure[]): void {
  const file = "docs/redemption-backstops.md";
  const doc = read(file);

  const familyCounts: Record<string, number> = {};
  for (const config of Object.values(REDEMPTION_BACKSTOP_CONFIGS)) {
    familyCounts[config.routeFamily] = (familyCounts[config.routeFamily] ?? 0) + 1;
  }
  const totalExpected = Object.keys(REDEMPTION_BACKSTOP_CONFIGS).length;

  const totalFound = getFirstNumberFromText(
    findLineValue(doc, /- \*\*Configured coins:\*\* (\d+)/) ?? "",
  );
  expectNumber(failures, file, "configured coins total", totalFound, totalExpected);

  const familyLine = findLineValue(doc, /- \*\*Route families:\*\* ([^\n]+)/) ?? "";
  const familyOrder = [
    "offchain-issuer",
    "stablecoin-redeem",
    "collateral-redeem",
    "queue-redeem",
    "psm-swap",
    "basket-redeem",
  ] as const;
  const familyCountsFromDoc = new Map(
    Array.from(familyLine.matchAll(/(\d+)\s+`([a-z-]+)`/g), (match) => [match[2], Number(match[1])]),
  );
  for (const family of familyOrder) {
    const found = familyCountsFromDoc.get(family) ?? null;
    expectNumber(failures, file, `${family} family count`, found, familyCounts[family] ?? 0);
  }

  const seenInDoc = new Set(
    Array.from(familyLine.matchAll(/`([a-z-]+)`/g), (m) => m[1]),
  );
  for (const family of Object.keys(familyCounts)) {
    if (!seenInDoc.has(family)) {
      failures.push({
        file,
        label: `${family} family listed in doc`,
        expected: "present",
        found: "missing",
      });
    }
  }
}

export function runDocSyncChecks(): Failure[] {
  const failures: Failure[] = [];
  const apiReferenceDoc = read("docs/api-reference.md");

  checkMethodologyVersions(failures);
  checkMethodologyCommitProvenance(failures);
  checkReportCardsDoc(failures);
  checkDepegDoc(failures);
  checkDewsDoc(failures);
  checkLiquidityDoc(failures);
  checkWorkerLimitsDoc(failures);
  checkApiFreshnessDoc(failures, apiReferenceDoc);
  checkStatusDashboardDoc(failures);
  checkChainsApiDoc(failures, apiReferenceDoc);
  checkApiMethodologyExamples(failures, apiReferenceDoc);
  checkChainsPageDoc(failures);
  checkRedemptionBackstopsDoc(failures);

  return failures;
}
