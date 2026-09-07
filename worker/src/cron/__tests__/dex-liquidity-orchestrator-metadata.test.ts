import { describe, expect, it } from "vitest";

import { buildDexLiquidityCronMetadata } from "../dex-liquidity/orchestrator-metadata";
import { initLiquidityFallbackCounters } from "../dex-liquidity/pool-helpers";
import type { DexLiquidityPostScoreAnalysis } from "../dex-liquidity/orchestrator-analysis";
import type { DexPricePersistenceDiagnostics } from "../dex-liquidity/scoring";

function metadataParams() {
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
  it("keeps score diagnostics while omitting the removed shadow evidence ledger", () => {
    const metadata = buildDexLiquidityCronMetadata(metadataParams());

    expect(metadata.fallbackCounters).toBeDefined();
    expect(metadata.shadowAdmissionReport).toBeUndefined();
    expect(Object.keys(metadata).some((key) => key.startsWith("mxLedger"))).toBe(false);
  });
});
