import { describe, expect, it } from "vitest";

import { buildDexLiquidityCronMetadata } from "../dex-liquidity/orchestrator-metadata";
import { initLiquidityFallbackCounters } from "../dex-liquidity/pool-helpers";
import type { DexLiquidityPostScoreAnalysis } from "../dex-liquidity/orchestrator-analysis";
import type { DexPricePersistenceDiagnostics } from "../dex-liquidity/scoring";

function metadataParams(): Parameters<typeof buildDexLiquidityCronMetadata>[0] {
  return {
    rowsRead: 4_000,
    rowsWritten: 300,
    stagedPoolsMerged: 0,
    stagedPoolsSkipped: 0,
    stagedPoolsSkippedByExactIdentity: 0,
    stagedPoolsSkippedByUniqueDerivedIdentity: 0,
    stagedPoolsSkippedByOptionalWildcardIdentity: 0,
    stagedPoolsSkippedByAuthoritativeProtocol: 0,
    stagedPoolSkipDimensions: [],
    poolRejections: [],
    directApiSourceSummary: {
      acceptedByProtocolChain: {},
      excludedByReason: {},
      circuitEvents: [],
      sourceWarnings: [],
      pagination: [],
    },
    sourceCoverage: {} as DexLiquidityPostScoreAnalysis["sourceCoverage"],
    challengerPublication: { publishedStablecoins: 0, skippedStablecoins: 0, missingTables: false },
    dexPriceDiagnostics: {} as DexPricePersistenceDiagnostics,
    failedSources: [],
    fallbackSignals: [],
    fallbackCounters: initLiquidityFallbackCounters(),
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
  };
}

describe("dex liquidity cron metadata", () => {
  it("aggregates rejection groups and applies aggregate TVL materiality", () => {
    const params = metadataParams();
    params.poolRejections = [
      { reason: "invalid-pool-identity", poolIds: ["a", "b"], count: 2, tvlUsd: 600_000 },
      { reason: "invalid-pool-volume", poolIds: ["c"], count: 1, tvlUsd: 400_000 },
    ];
    const metadata = buildDexLiquidityCronMetadata(params);
    expect(metadata).toMatchObject({
      rowsDropped: 3, validationFailures: 3,
      poolRejectionMateriality: { rejectedPoolCount: 3, rejectedPoolTvlUsd: 1_000_000, material: true },
    });
  });

  it("deduplicates failures and fallback signals without dropping distinct identities", () => {
    const params = metadataParams();
    params.failedSources = ["curve", "raydium", "curve"];
    params.fallbackSignals = ["gecko", "orderbook", "gecko"];
    expect(buildDexLiquidityCronMetadata(params)).toMatchObject({
      failedSources: ["curve", "raydium"], fallbackMode: ["gecko", "orderbook"],
    });
  });

  it("bounds inactive diagnostics while retaining the full skipped count", () => {
    const params = metadataParams();
    params.persistence.inactiveMetricIdsSkipped = Array.from({ length: 30 }, (_, i) => `inactive-${i}`);
    params.persistence.inactiveMetricRowsSkipped = 30;
    expect(buildDexLiquidityCronMetadata(params).persistence).toMatchObject({
      inactiveMetricRowsSkipped: 30,
      inactiveMetricIdsSkipped: Array.from({ length: 25 }, (_, i) => `inactive-${i}`),
    });
  });
});
