import { describe, expect, it, vi } from "vitest";
import { getCronQualityReasons } from "@shared/lib/cron-quality-reasons";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";

import { logCronRun, type CronResult } from "../../lib/cron-logger";
import {
  buildDexLiquidityCronMetadata,
  dexLiquidityDegradedReason,
} from "../dex-liquidity/orchestrator-metadata";
import { initLiquidityFallbackCounters } from "../dex-liquidity/pool-helpers";
import type { DexLiquidityPostScoreAnalysis } from "../dex-liquidity/orchestrator-analysis";
import type { DexPricePersistenceDiagnostics } from "../dex-liquidity/scoring";
import { compactCronMetadataForPersistence, MAX_PERSISTED_CRON_METADATA_BYTES } from "../../lib/cron-metadata-persistence";

function metadataParams(): Parameters<typeof buildDexLiquidityCronMetadata>[0] {
  return {
    sourceState: {
      primaryRawPoolCount: 4_000,
      failedSources: [],
      fallbackSignals: [],
      directApiSourceSummary: { circuitEvents: [], sourceWarnings: [], pagination: [] },
    },
    poolState: {
      stagedMergedCount: 0,
      stagedSkippedCount: 0,
      stagedSkippedByExactIdentityCount: 0,
      stagedSkippedByUniqueDerivedIdentityCount: 0,
      stagedSkippedByOptionalWildcardIdentityCount: 0,
      stagedSkippedByAuthoritativeProtocolCount: 0,
      stagedSkipDimensions: [],
      poolRejections: [],
      directApiIntegration: { acceptedByProtocolChain: {}, excludedByReason: {} },
      deadPoolUnindexedChainSkips: {},
    },
    scoreState: {
      scoreResults: { size: 300 },
      analysis: { sourceCoverage: {} as DexLiquidityPostScoreAnalysis["sourceCoverage"] },
      diagnostics: {
        fallbackCounters: initLiquidityFallbackCounters(),
        deadPoolExclusions: {
          reason: "dead-pool-zero-trade-untracked-counter",
          thresholdTvlUsd: 1_000_000,
          poolCount: 0,
          tvlUsd: 0,
          topStablecoins: [],
        },
      },
    },
    persistenceState: {
      challengerPublication: { publishedStablecoins: 0, skippedStablecoins: 0 },
      dexPriceDiagnostics: {} as DexPricePersistenceDiagnostics,
      persistence: {
        placeholderCount: 0,
        inactiveMetricRowsSkipped: 0,
        orphanRowsDeleted: 0,
        orphanCleanupFailed: false,
      },
      historicalSnapshot: {
        snapshotRowsWritten: 0,
        skipped: false,
        writeFailed: false,
        historyRowsPruned: 0,
        retentionPruneFailed: false,
      },
    },
  };
}

describe("dex liquidity cron metadata", () => {
  it("publishes drift and source findings through the canonical quality envelope", () => {
    const params = metadataParams();
    Object.assign(params.scoreState.analysis.sourceCoverage, {
      qualityDriftSeverity: "high",
      qualityDriftFlags: ["major-tvl-cliff:cdxusd-cod3x"],
    });
    params.sourceState.failedSources = ["uni-v4:ethereum", "uni-v4:arbitrum", "uni-v4:ethereum"];
    params.sourceState.degradedSources = ["orca:solana", "orca:solana"];
    params.sourceState.directApiSourceSummary.sourceWarnings = ["orca: some pools were unavailable"];

    const metadata = buildDexLiquidityCronMetadata(params);
    const reasons = [
      "major-tvl-cliff:cdxusd-cod3x", "source-failed:uni-v4:ethereum", "source-failed:uni-v4:arbitrum",
      "source-partial:orca:solana", "direct-api-source-warnings",
    ];
    expect(getCronQualityReasons(metadata)).toEqual(reasons);
    expect(metadata.rowsWritten).toBe(300);
    expect(metadata.persistence).toMatchObject({ skipped: false, historicalSnapshotWriteFailed: false });

    const compacted = compactCronMetadataForPersistence(JSON.stringify({
      ...metadata, oversizedDiagnostic: "x".repeat(MAX_PERSISTED_CRON_METADATA_BYTES),
    }));
    expect(compacted.compacted).toBe(true);
    expect(getCronQualityReasons(JSON.parse(compacted.metadata!))).toEqual(reasons);
  });

  it("omits findings for a clean publication or an ordinary fallback", () => {
    const params = metadataParams();
    Object.assign(params.scoreState.analysis.sourceCoverage, { qualityDriftSeverity: "none", qualityDriftFlags: [] });
    params.sourceState.fallbackSignals = ["gecko"];
    expect(buildDexLiquidityCronMetadata(params)).not.toHaveProperty("quality");
  });

  it("reports partial-source warnings even without confirmed drift or a failed source", () => {
    const params = metadataParams();
    params.sourceState.directApiSourceSummary.sourceWarnings = ["orca: partial inventory"];
    expect(getCronQualityReasons(buildDexLiquidityCronMetadata(params))).toEqual(["direct-api-source-warnings"]);
  });

  it("publishes plain-NG admissions as non-withholding internal diagnostics", () => {
    const params = metadataParams();
    params.scoreState.diagnostics.curveStableswapPlainAdmissions = [{
      stablecoinId: "eurs-stasis",
      chain: "ethereum",
      poolId: "ethereum:0x48edff046ebf41c6ee1895e06f3dc1629db563d4",
      sourcePriceSpreadRatio: 1.066,
    }];
    params.scoreState.diagnostics.curveStableswapPlainAdmissionsOmitted = 0;

    const metadata = buildDexLiquidityCronMetadata(params);
    expect(metadata.curveStableswapPlainAdmissions).toEqual(params.scoreState.diagnostics.curveStableswapPlainAdmissions);
    expect(metadata.curveStableswapPlainAdmissionsOmitted).toBe(0);
    expect(metadata).not.toHaveProperty("quality");
  });

  it("aggregates rejection groups and applies aggregate TVL materiality", () => {
    const params = metadataParams();
    params.poolState.poolRejections = [
      { reason: "invalid-pool-identity", poolIds: ["a", "b"], count: 2, tvlUsd: 600_000 },
      { reason: "invalid-pool-volume", poolIds: ["c"], count: 1, tvlUsd: 400_000 },
    ];
    const metadata = buildDexLiquidityCronMetadata(params);
    expect(metadata).toMatchObject({
      rowsDropped: 3,
      poolRejectionMateriality: { rejectedPoolCount: 3, rejectedPoolTvlUsd: 1_000_000, material: true },
    });
  });

  function analysisState(overrides: Partial<DexLiquidityPostScoreAnalysis> = {}): DexLiquidityPostScoreAnalysis {
    return {
      previousCoverageBaselineAvailable: true,
      requiredBaselineUnavailable: false,
      nearCoverageGuard: false,
      nearValueGuard: false,
      nearMajorCoverageGuard: false,
      sourceCoverage: metadataParams().scoreState.analysis.sourceCoverage,
      ...overrides,
    } as DexLiquidityPostScoreAnalysis;
  }

  function degradedReasonFor(
    params: Parameters<typeof buildDexLiquidityCronMetadata>[0],
    analysis: DexLiquidityPostScoreAnalysis,
  ): string | null {
    return dexLiquidityDegradedReason({
      criticalSourceFailures: [],
      poolRejections: params.poolState.poolRejections,
      analysis,
      persistence: params.persistenceState.persistence,
      dexPriceDiagnostics: params.persistenceState.dexPriceDiagnostics,
      historicalSnapshot: params.persistenceState.historicalSnapshot,
    });
  }

  it("names the bounded cause of every degraded run (R4)", async () => {
    const cases: Array<{
      expected: string;
      analysis?: DexLiquidityPostScoreAnalysis;
      mutate?: (params: Parameters<typeof buildDexLiquidityCronMetadata>[0]) => void;
    }> = [
      {
        expected: "material-pool-rejections",
        mutate: (params) => {
          params.poolState.poolRejections = [
            { reason: "invalid-pool-identity", poolIds: ["0xfeed"], count: 1, tvlUsd: 12_500 },
          ];
        },
      },
      { expected: "near-value-guard", analysis: analysisState({ nearValueGuard: true }) },
      {
        expected: "orphan-cleanup-failed",
        mutate: (params) => Object.assign(params.persistenceState.persistence, { orphanRowsDeleted: 6, orphanCleanupFailed: true }),
      },
      {
        expected: "historical-snapshot-write-failed",
        mutate: (params) => Object.assign(params.persistenceState.historicalSnapshot, { snapshotRowsWritten: 0, writeFailed: true }),
      },
    ];

    for (const testCase of cases) {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const params = metadataParams();
        testCase.mutate?.(params);
        const analysis = testCase.analysis ?? analysisState();
        const degradedReason = degradedReasonFor(params, analysis);
        expect(degradedReason).toBe(testCase.expected);

        // Mirrors `buildDexLiquidityCronResult`: the status predicate and the
        // published reason come from the same state.
        const result: CronResult = {
          status: "degraded",
          itemCount: params.scoreState.scoreResults.size,
          metadata: JSON.stringify(buildDexLiquidityCronMetadata({ ...params, degradedReason })),
        };
        const fixture = createLatestSchemaSqlite();
        try {
          await logCronRun(fixture.db, "sync-dex-liquidity", async () => result);
          const row = fixture.sqlite
            .prepare("SELECT status, degraded_reason FROM cron_runs WHERE job = ?")
            .get("sync-dex-liquidity") as { status: string; degraded_reason: string | null } | undefined;
          expect(row).toEqual({ status: "degraded", degraded_reason: testCase.expected });
        } finally {
          fixture.sqlite.close();
        }
      } finally {
        vi.restoreAllMocks();
      }
    }
  });

  it("keeps an okay run reasonless", () => {
    const params = metadataParams();
    const degradedReason = degradedReasonFor(params, analysisState());
    expect(degradedReason).toBeNull();
    expect(buildDexLiquidityCronMetadata({ ...params, degradedReason })).not.toHaveProperty("reason");
  });
});
