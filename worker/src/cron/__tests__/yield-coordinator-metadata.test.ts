import { describe, expect, it } from "vitest";
import { COMPARISON_ANCHOR_STALE_THRESHOLD_MS } from "../../lib/yield-ranking-helpers";
import { buildHardcodedUsdBenchmark } from "../yield-sync/benchmarks";
import {
  buildComparisonAnchorFreshnessMeta,
  buildYieldDegradationReasons,
  buildYieldSyncMetadata,
} from "../yield-sync/coordinator-metadata";
import type { EvaluatedYieldSource } from "../yield-sync/evaluation-types";
import type { YieldEnvelopeRejection } from "../yield-sync/types";

const START_SEC = 1_800_000_000;
const STALE_THRESHOLD_SEC = COMPARISON_ANCHOR_STALE_THRESHOLD_MS / 1000;

function makeEvaluatedSource(overrides: Partial<EvaluatedYieldSource>): EvaluatedYieldSource {
  return {
    id: "usdc-circle",
    symbol: "USDC",
    sourceKey: "source",
    dataSource: "onchain",
    comparisonAnchorObservedAt: null,
    ...overrides,
  } as EvaluatedYieldSource;
}

function makeEnvelopeRejection(index: number): YieldEnvelopeRejection {
  return {
    stablecoinId: `coin-${index}`,
    symbol: `C${index}`,
    sourceKey: `onchain:coin-${index}`,
    computedApy: 350 + index,
    exchangeRate: 1.2,
    previousExchangeRate: 1,
    anchorObservedAt: START_SEC - 7 * 86400,
    actualDays: 7,
  };
}

describe("buildComparisonAnchorFreshnessMeta", () => {
  it("summarizes anchored and stale comparison anchors using the shared stale threshold", () => {
    const meta = buildComparisonAnchorFreshnessMeta({
      startSec: START_SEC,
      evaluatedSources: [
        makeEvaluatedSource({
          id: "fresh",
          symbol: "FRESH",
          sourceKey: "onchain:fresh",
          comparisonAnchorObservedAt: START_SEC - STALE_THRESHOLD_SEC,
        }),
        makeEvaluatedSource({
          id: "stale",
          symbol: "STALE",
          sourceKey: "onchain:stale",
          comparisonAnchorObservedAt: START_SEC - STALE_THRESHOLD_SEC - 1,
        }),
        makeEvaluatedSource({
          id: "oldest",
          symbol: "OLD",
          sourceKey: "price-derived",
          dataSource: "price-derived",
          comparisonAnchorObservedAt: START_SEC - STALE_THRESHOLD_SEC - 100,
        }),
        makeEvaluatedSource({ id: "unanchored", comparisonAnchorObservedAt: null }),
      ],
    });

    expect(meta).toMatchObject({
      anchoredRowCount: 3,
      staleAnchorCount: 1,
      oldestAnchorAgeSeconds: STALE_THRESHOLD_SEC + 100,
      oldestAnchorStablecoinId: "oldest",
      oldestAnchorSourceKey: "price-derived",
      staleAnchorExamplesTruncated: false,
    });
    expect(meta.staleAnchorExamples.map((row) => row.stablecoinId)).toEqual(["stale"]);
  });
});

describe("buildYieldDegradationReasons", () => {
  const baseParams = {
    safetySnapshotDegraded: false,
    safetySnapshotReason: null,
    defaultBenchmarkMeta: {
      ...buildHardcodedUsdBenchmark("test"),
      ageSeconds: 0,
      isFallback: false,
      fallbackMode: null,
    },
    selectedSources: [] as EvaluatedYieldSource[],
    dlPoolsMeta: {
      mode: "dex-cache" as const,
      updatedAt: START_SEC,
      ageSeconds: 0,
      poolCount: 0,
      fallbackMode: null,
    },
    supplementalMeta: {
      mode: "cache" as const,
      updatedAt: START_SEC,
      ageSeconds: 0,
      sourceCount: 12,
      fallbackMode: null,
      degradedFamilies: [] as string[],
    },
    stablecoinSupplyMapState: "ok" as const,
    allDeterministicFailed: false,
    maskedAllDeterministicFailure: false,
    onChainSkippedDueToCooldown: false,
    onChainAlternativeCoverageMissingIds: [] as string[],
    previousTvlRowsTruncated: false,
  };

  it("retains default benchmark fallback health when no source row is selected", () => {
    expect(buildYieldDegradationReasons({
      ...baseParams,
      defaultBenchmarkMeta: buildHardcodedUsdBenchmark("fred-api-error-retained"),
    })).toContain("risk-free-rate:fred-api-error-retained");
  });

  it("reports total supplemental-lane loss that the aggregate coverage floor cannot see", () => {
    expect(
      buildYieldDegradationReasons({
        ...baseParams,
        defaultBenchmarkMeta: buildHardcodedUsdBenchmark("test"),
        supplementalMeta: {
          mode: "unavailable",
          updatedAt: null,
          ageSeconds: null,
          sourceCount: 0,
          fallbackMode: "stale-cache",
          degradedFamilies: [],
        },
      }),
    ).toContain("yield-supplemental:stale-cache");
  });

  it.each(["missing", "malformed"] as const)("reports the %s bulk stablecoin supply map", (state) => {
    expect(buildYieldDegradationReasons({
      ...baseParams,
      defaultBenchmarkMeta: buildHardcodedUsdBenchmark("test"),
      stablecoinSupplyMapState: state,
    })).toContain(`yield-supply-map:${state}`);
  });

  it("reports retained degraded families by name and keeps optional-source failures out of the reasons", () => {
    const reasons = buildYieldDegradationReasons({
      ...baseParams,
      defaultBenchmarkMeta: buildHardcodedUsdBenchmark("test"),
      supplementalMeta: {
        mode: "cache",
        updatedAt: START_SEC,
        ageSeconds: 0,
        sourceCount: 40,
        fallbackMode: "partial-family-cache",
        degradedFamilies: ["morpho"],
      },
    });

    expect(reasons).toEqual(expect.arrayContaining([
      "yield-supplemental:partial-family-cache",
      "yield-supplemental:family-degraded:morpho",
    ]));
    // B15/W1d: a failed optional family is not a degraded run on its own (the
    // sync-yield-data rates-history contract); it travels in the run metadata
    // asserted in the `buildYieldSyncMetadata` block below.
    expect(reasons.filter((reason) => reason.startsWith("yield-source:family-failed:"))).toEqual([]);
  });

  it("excludes the advisory Pendle outage from freshness-blocking degradation", () => {
    const reasons = buildYieldDegradationReasons({
      ...baseParams,
      defaultBenchmarkMeta: baseParams.defaultBenchmarkMeta,
      supplementalMeta: {
        mode: "cache",
        updatedAt: START_SEC,
        ageSeconds: 0,
        sourceCount: 40,
        fallbackMode: null,
        degradedFamilies: ["pendle"],
        degradedFamilyReasons: { pendle: "pendle-rate-limited-backoff" },
      },
    });

    expect(reasons).toEqual([]);
  });

  it.each([
    { unavailableRequiredFamilies: ["pendle"], degraded: false },
    { unavailableRequiredFamilies: ["pendle", "aaveV3"], degraded: true },
    { unavailableRequiredFamilies: undefined, degraded: true },
  ])("does not hide non-Pendle or unattributed partial cache loss: $unavailableRequiredFamilies", ({ unavailableRequiredFamilies, degraded }) => {
    const reasons = buildYieldDegradationReasons({
      ...baseParams,
      supplementalMeta: {
        ...baseParams.supplementalMeta,
        fallbackMode: "partial-family-cache",
        degradedFamilies: ["pendle"],
        unavailableRequiredFamilies,
      },
    });
    expect(reasons.includes("yield-supplemental:partial-family-cache")).toBe(degraded);
  });

  it("keeps optional vaults.fyi diagnostics out of publication quality", () => {
    expect(buildYieldDegradationReasons({
      ...baseParams,
      supplementalMeta: {
        ...baseParams.supplementalMeta,
        degradedFamilies: ["vaultsFyi"],
        degradedFamilyReasons: { vaultsFyi: "probe-unavailable" },
      },
    })).toEqual(buildYieldDegradationReasons(baseParams));
  });

  it("reports an invalid benchmark registry as input quality", () => {
    expect(buildYieldDegradationReasons({
      ...baseParams,
      riskFreeRateRegistryCacheState: "invalid",
    })).toContain("yield-benchmarks:registry-invalid");
  });

  it("names the stale selected source in the degradation reason", () => {
    const reasons = buildYieldDegradationReasons({
      ...baseParams,
      defaultBenchmarkMeta: buildHardcodedUsdBenchmark("test"),
      selectedSources: [
        makeEvaluatedSource({
          sourceKey: "defillama:expired-pool",
          sourceFreshness: "stale",
          benchmarkKey: "USD",
          benchmarkFreshness: "healthy",
        }),
      ],
    });

    expect(reasons).toContain("yield-source:expired-selected:defillama:expired-pool");
  });

  it("excludes rejected diagnostic winners from served source and benchmark health", () => {
    const reasons = buildYieldDegradationReasons({
      ...baseParams,
      defaultBenchmarkMeta: buildHardcodedUsdBenchmark("test"),
      selectedSources: [makeEvaluatedSource({
        sourceKey: "price-derived",
        rejected: true,
        sourceFreshness: "stale",
        benchmarkKey: "EUR",
        benchmarkFreshness: "stale",
      })],
    });
    expect(reasons.some((reason) => reason.startsWith("yield-source:expired-selected:"))).toBe(false);
    expect(reasons.some((reason) => reason.startsWith("risk-free-rate:EUR:"))).toBe(false);
  });

  it("stays quiet for a healthy supplemental cache with no optional-source failures", () => {
    expect(
      buildYieldDegradationReasons({
        ...baseParams,
        defaultBenchmarkMeta: buildHardcodedUsdBenchmark("test"),
      }).filter((reason) => reason.startsWith("yield-supplemental:") || reason.startsWith("yield-source:family-failed:")),
    ).toEqual([]);
  });
});

describe("buildYieldSyncMetadata", () => {
  it.each(["pendle", "aaveV3"] as const)("preserves %s quality diagnostics separately from publication health and bounded telemetry", (family) => {
    const comparisonAnchorFreshness = buildComparisonAnchorFreshnessMeta({
      startSec: START_SEC,
      evaluatedSources: [
        makeEvaluatedSource({
          id: "stale",
          symbol: "STALE",
          sourceKey: "onchain:stale",
          comparisonAnchorObservedAt: START_SEC - STALE_THRESHOLD_SEC - 1,
        }),
      ],
    });
    const envelopeRejections = Array.from({ length: 26 }, (_, index) => makeEnvelopeRejection(index));

    const metadata = JSON.parse(
      buildYieldSyncMetadata({
        rowsRead: 1,
        rowsWritten: 1,
        rowsRejected: 0,
        divergenceFlags: 0,
        sourceSwitches: 0,
        defaultSafetyCoinCount: 0,
        safetySnapshot: {
          kind: "ok",
          coverageRatio: 1,
          coveredCount: 1,
          trackedCount: 1,
          reason: null,
          source: "safety-score-v9-publication",
          safetyScoreIdentity: null,
          publicationGenerationId: "report-cards:v8.299:1800000000",
          methodologyVersion: "v8.299",
          publishedAt: START_SEC,
        },
        resolvedYieldBearingCount: 1,
        expectedYieldBearingCount: 1,
        publishedYieldBearingCount: 1,
        previousPublishedYieldBearingCount: 1,
        publishedOpportunityCount: 0,
        previousPublishedOpportunityCount: 0,
        publishedRankingCount: 1,
        previousPublishedRankingCount: 1,
        dlPoolsMeta: {
          mode: "dex-cache",
          updatedAt: START_SEC,
          ageSeconds: 0,
          poolCount: 1,
          fallbackMode: null,
        },
        dlApyEnvelopeRejectedCount: 3,
        supplementalMeta: {
          mode: "cache",
          updatedAt: START_SEC,
          ageSeconds: 0,
          sourceCount: 12,
          fallbackMode: null,
          degradedFamilies: [family],
          degradedFamilyReasons: { [family]: "upstream-unavailable" },
        },
        stablecoinSupplyMapState: "ok",
        optionalSourceFailures: [
          { label: "Midas mMEV NAV oracle source", outcome: "timeout" },
          { label: "Yearn yBOLD source", outcome: "failed" },
        ],
        onChain: {
          ratesResolved: 0,
          ratesConfigured: 1,
          envelopeRejections,
          attempted: 1,
          allDeterministicFailed: false,
          explorerAttempted: 0,
          explorerResolved: 0,
          failureMaskedByAlternativeCoverage: false,
          alternativeCoverageMissingIds: [],
          failures: null,
          skippedDueToCooldown: false,
          cooldownTriggered: false,
          cooldownUntil: null,
          cooldownRemainingSec: 0,
          consecutiveAllFailRuns: 0,
          consecutiveMaskedAllFailRuns: 0,
        },
        qualityReasons: family === "pendle" ? [] : [`yield-supplemental:family-degraded:${family}:upstream-unavailable`],
        validationFailures: 0,
        riskFreeRate: 4,
        cacheWriteSkipped: false,
        comparisonAnchorFreshness,
        previousTvlRowsTruncated: true,
        publicationStats: {
          cacheValueChars: 812_345,
          yieldDataRowsChars: 120_000,
          historyRowsChars: 90_000,
          decisionRowsChars: 60_000,
          decisionAlternativeRowsChars: 10_000,
          largestPayloadChars: 812_345,
          oversize: false,
          pysInputsPersistedCount: 154,
          pysInputsNullCount: 3,
        },
      }),
    ) as {
      quality: { degraded: boolean; reasons: string[]; advisoryReasons: string[] };
      publicationStats: { pysInputsPersistedCount: number; pysInputsNullCount: number; largestPayloadChars: number };
      sourceCoverage: {
        publishedRankingCountDelta: number;
        dlApyEnvelopeRejectedCount: number;
        onChainEnvelopeRejectionCount: number;
        onChainEnvelopeRejections: YieldEnvelopeRejection[];
        onChainEnvelopeRejectionsTruncated: boolean;
        comparisonAnchorFreshness: typeof comparisonAnchorFreshness;
        previousTvlRowsTruncated: boolean;
        optionalSourceFailures: Array<{ label: string; outcome: string }>;
        optionalSourceFailureCount: number;
        stablecoinSupplyMapState: string;
        safetySnapshot: {
          source: string;
          publicationGenerationId: string;
          methodologyVersion: string;
          publishedAt: number;
        };
      };
    };

    const reason = `yield-supplemental:family-degraded:${family}:upstream-unavailable`;
    expect(metadata.quality).toEqual({
      degraded: family !== "pendle",
      reasons: family === "pendle" ? [] : [reason],
      advisoryReasons: family === "pendle" ? [reason] : [],
    });
    expect(metadata.sourceCoverage.onChainEnvelopeRejectionCount).toBe(26);
    expect(metadata.sourceCoverage.dlApyEnvelopeRejectedCount).toBe(3);
    expect(metadata.sourceCoverage.publishedRankingCountDelta).toBe(0);
    expect(metadata.sourceCoverage.onChainEnvelopeRejections).toHaveLength(25);
    expect(metadata.sourceCoverage.onChainEnvelopeRejections[0]).toEqual(envelopeRejections[0]);
    expect(metadata.sourceCoverage.onChainEnvelopeRejectionsTruncated).toBe(true);
    expect(metadata.sourceCoverage.comparisonAnchorFreshness).toEqual(comparisonAnchorFreshness);
    expect(metadata.sourceCoverage.previousTvlRowsTruncated).toBe(true);
    expect(metadata.sourceCoverage.optionalSourceFailures).toEqual([
      { label: "Midas mMEV NAV oracle source", outcome: "timeout" },
      { label: "Yearn yBOLD source", outcome: "failed" },
    ]);
    expect(metadata.sourceCoverage.optionalSourceFailureCount).toBe(2);
    expect(metadata.sourceCoverage.stablecoinSupplyMapState).toBe("ok");
    expect(metadata.publicationStats).toEqual({
      cacheValueChars: 812_345,
      yieldDataRowsChars: 120_000,
      historyRowsChars: 90_000,
      decisionRowsChars: 60_000,
      decisionAlternativeRowsChars: 10_000,
      largestPayloadChars: 812_345,
      oversize: false,
      pysInputsPersistedCount: 154,
      pysInputsNullCount: 3,
    });
    expect(metadata.sourceCoverage.safetySnapshot).toMatchObject({
      source: "safety-score-v9-publication",
      publicationGenerationId: "report-cards:v8.299:1800000000",
      methodologyVersion: "v8.299",
      publishedAt: START_SEC,
    });
  });
});
